'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { listSubagents, readSubagentDetail } = require('../subagent-monitor');
const { ingestToolHook } = require('../tool-hooks');

function setup(t, agent) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-test-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sessionId = 'parent-session';
  const file = path.join(root, `${sessionId}.jsonl`);
  const term = { id: '1', agent, sessionId, status: 'busy', exited: null, meta: {} };
  const hub = { terms: new Map([['1', term]]), index: new Map([[sessionId, { file, agent }]]),
    termSessionId: term => term.sessionId, agentOf: term => term.agent };
  const append = (p, ...rows) => fs.appendFileSync(p, rows.map(row => JSON.stringify({ timestamp: '2026-01-01T00:00:00Z', ...row }) + '\n').join(''));
  const list = () => listSubagents(hub, { termId: '1' });
  return { hub, term, sessionId, file, root, append, list };
}

const call = (name, id, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name, id, input }] } });
const result = (id, content, toolUseResult) => ({ type: 'user', toolUseResult, message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } });

test('Claude Agent and Task display running/done, prompt, inner tools and live output', t => {
  const { hub, sessionId, file, root, list, append } = setup(t, 'claude');
  const directory = path.join(root, sessionId, 'subagents');
  fs.mkdirSync(directory, { recursive: true });
  const child = path.join(directory, 'agent-child.jsonl');
  append(file, call('Agent', 'use1', { prompt: 'Inspect the fixture', description: 'Inspect' }), call('Task', 'use2', { prompt: 'Review' }));
  append(child, { type: 'user', message: { content: 'Inspect the fixture' } }, call('Read', 'read1', { file_path: 'fixture' }));
  assert.deepEqual(list().map(item => item.status), ['running', 'running']);
  const detail = () => readSubagentDetail(hub, { id: 'use1', sessionId });
  assert.equal(detail().prompt, 'Inspect the fixture');
  assert.equal(detail().events[0].tool, 'Read');
  append(child, { type: 'assistant', message: { content: [{ type: 'text', text: 'Progress' }] } });
  assert.equal(detail().lastMessage, 'Progress');
  append(file, result('use1', 'Final result', { agentId: 'child', status: 'completed', content: 'Final result' }));
  assert.equal(list()[0].status, 'done');
  assert.match(detail().lastMessage, /Final result/);
  assert.equal(readSubagentDetail(hub, { id: 'use1', sessionId, logPath: file }).ok, false);
});

test('Claude background launch stays running until its task notification', t => {
  const { file, list, append } = setup(t, 'claude');
  append(file, call('Agent', 'use1'), result('use1', '', { agentId: 'child', status: 'async_launched' }));
  assert.equal(list()[0].status, 'running');
  append(file, { type: 'user', message: { content: '<task-notification><task-id>child</task-id><status>completed</status><summary>Finished</summary></task-notification>' } });
  assert.equal(list()[0].status, 'done');
});

test('agy planner call and tool response expose the returned conversationId', t => {
  const { file, list, append } = setup(t, 'agy');
  append(file, { type: 'PLANNER_RESPONSE', step_index: 2, tool_calls: [{ name: 'invoke_subagent', args: { prompt: 'Review' } }] });
  assert.equal(list()[0].status, 'running');
  append(file, { type: 'GENERIC', content: '{"conversationId":"child-session"}' });
  assert.equal(list()[0].targetSessionId, 'child-session');
});

test('Codex spawn returns a session, wait finishes it, send_input starts it again', t => {
  const { hub, file, root, list, append } = setup(t, 'codex');
  const response = payload => ({ type: 'response_item', payload });
  const fn = (name, call_id, args) => response({ type: 'function_call', name, call_id, arguments: JSON.stringify(args) });
  const out = (call_id, output) => response({ type: 'function_call_output', call_id, output: JSON.stringify(output) });
  append(file, fn('spawn_agent', 'c1', { message: 'Inspect' }), out('c1', { agent_id: 'child-session', nickname: 'Reader' }));
  assert.equal(list()[0].targetSessionId, 'child-session');
  assert.equal(list()[0].status, 'running');
  append(file, fn('wait_agent', 'c2', { ids: ['child-session'] }), out('c2', { status: { 'child-session': { completed: 'Inspected' } }, timed_out: false }));
  assert.equal(list()[0].status, 'done');
  append(file, fn('send_input', 'c3', { id: 'child-session' }), out('c3', { submission_id: 'turn' }));
  assert.equal(list()[0].status, 'running');
  const child = path.join(root, 'child-session.jsonl');
  hub.index.set('child-session', { file: child, agent: 'codex' });
  append(child, { type: 'event_msg', payload: { type: 'task_complete' } });
  assert.equal(list()[0].status, 'done');
});

for (const stoppedBy of ['idle', 'exited', 'interrupt']) test(`orphaned call stays stopped after ${stoppedBy}`, t => {
  const { file, term, list, append } = setup(t, 'claude');
  append(file, call('Agent', 'use1'));
  assert.equal(list()[0].status, 'running');
  if (stoppedBy === 'exited') term.exited = 0;
  else if (stoppedBy === 'interrupt') term._subagentsInterruptedAt = Date.now();
  else term.status = 'idle';
  assert.equal(list()[0].status, 'stopped');
  term.status = 'busy';
  term.exited = null;
  assert.equal(list()[0].status, 'stopped');
});

test('native hook is immediate, deduplicates against tail, and links Hub child terminals', t => {
  const { hub, sessionId, file, append, list } = setup(t, 'claude');
  const hook = hook_event_name => ingestToolHook(hub, { termId: '1',
    data: { hook_event_name, session_id: sessionId, tool_name: 'Agent', tool_use_id: 'use1', tool_input: { prompt: 'Review' } } });
  assert.deepEqual(hook('PreToolUse'), { type: 'hook-event', termId: '1', sessionId });
  assert.equal(list()[0].status, 'running');
  append(file, call('Agent', 'use1', { prompt: 'Review' }));
  assert.equal(list().length, 1);
  hook('PostToolUse');
  assert.equal(list()[0].status, 'done');
  hub.terms.set('2', { id: '2', agent: 'cursor', meta: { projectTask: { parentTermId: '1' } }, exited: null, startedAt: Date.now() });
  assert.equal(list()[0].targetTermId, '2');
  assert.equal(list()[0].status, 'running');
});
