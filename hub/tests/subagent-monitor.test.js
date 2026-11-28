'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { Readable } = require('node:stream');
const { WebSocket, WebSocketServer } = require('ws');
const { listSubagents, readSubagentDetail } = require('../subagent-monitor');
const { ingestToolHook } = require('../tool-hooks');
const { createToolHooks } = require('../tool-activity-hooks');
const { transcriptFile } = require('../subagent-files');
const { createHookTransport } = require('../session-hook-transport');
const { createSessionRoutes } = require('../routes-sessions');
const { sessionId: validSessionId } = require('../project-history');

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
  const { hub, file, root, list, append } = setup(t, 'agy');
  append(file, { type: 'PLANNER_RESPONSE', step_index: 2, tool_calls: [{ name: 'invoke_subagent', args: { Prompt: 'Review', Role: 'Reviewer', TypeName: 'self' } }] });
  assert.equal(list()[0].status, 'running');
  assert.equal(list()[0].description, 'Reviewer');
  append(file, { type: 'GENERIC', content: 'Created the following subagent:\n{"conversationId":"child-session"}' });
  assert.equal(list()[0].targetSessionId, undefined);
  const child = path.join(root, 'child.jsonl');
  append(child, { type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Reviewed' });
  hub.index.set('child-session', { agent: 'agy', file: child });
  assert.equal(list()[0].targetSessionId, 'child-session');
  assert.equal(list()[0].status, 'done');
});

test('Codex SubAgentActivity links the original call to its child and captures the final message', t => {
  const { hub, file, root, list, append, sessionId } = setup(t, 'codex');
  const activity = (id, kind) => ({ type: 'event_msg', payload: { type: 'item_completed',
    item: { type: 'SubAgentActivity', id, kind, agent_thread_id: 'child-session', agent_path: '/root/review' } } });
  const child = path.join(root, 'child.jsonl');
  append(child, { type: 'session_meta' });
  hub.index.set('child-session', { agent: 'codex', file: child });
  append(file, { type: 'response_item', payload: { type: 'function_call', name: 'spawn_agent', call_id: 'use1', arguments: '{"task_name":"review"}' } },
    activity('use1', 'started'),
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'use1', output: '{"task_name":"/root/review"}' } });
  assert.equal(list()[0].targetSessionId, 'child-session');
  assert.equal(list()[0].status, 'running');
  append(file, activity('different-end-id', 'completed'), { type: 'response_item', payload: { type: 'agent_message', author: '/root/review',
    content: [{ text: 'Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/review\nPayload:\nReviewed' }] } });
  assert.equal(list()[0].status, 'done');
  assert.equal(readSubagentDetail(hub, { id: 'use1', sessionId }).lastMessage, 'Reviewed');
});

test('Codex spawn returns a session, wait finishes it, send_input starts it again', t => {
  const { hub, file, root, list, append } = setup(t, 'codex');
  const response = payload => ({ type: 'response_item', payload });
  const fn = (name, call_id, args) => response({ type: 'function_call', name, call_id, arguments: JSON.stringify(args) });
  const out = (call_id, output) => response({ type: 'function_call_output', call_id, output: JSON.stringify(output) });
  append(file, fn('spawn_agent', 'c1', { message: 'Inspect' }), out('c1', { agent_id: 'child-session', nickname: 'Reader' }));
  hub.index.set('child-session', { agent: 'codex' });
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

for (const ending of ['completed', 'interrupt', 'parent abort']) test(`Codex ignores a copied child abort before ${ending}`, t => {
  const { hub, term, file, root, list, append } = setup(t, 'codex');
  const at = seconds => `2026-01-01T00:00:${String(seconds).padStart(2, '0')}Z`;
  const turn = (type, turn_id, seconds) => ({ type: 'event_msg', timestamp: at(seconds), payload: { type, turn_id } });
  const tool = (name, call_id, seconds) => ({ type: 'response_item', timestamp: at(seconds),
    payload: { type: 'function_call', name, call_id, arguments: '{}' } });
  const child = path.join(root, 'child.jsonl');
  hub.index.set('child-session', { agent: 'codex', file: child });
  append(file, turn('task_started', 'parent-turn', 0), tool('spawn_agent', 'spawn', 1), {
    type: 'event_msg', timestamp: at(3), payload: { type: 'item_completed',
      item: { type: 'SubAgentActivity', id: 'spawn', kind: 'started', agent_thread_id: 'child-session' } },
  });
  append(child, turn('task_started', 'parent-turn', 2), tool('spawn_agent', 'spawn', 2), turn('turn_aborted', 'parent-turn', 2));
  assert.equal(list()[0].status, 'running');
  append(child, turn('task_started', 'child-turn', 4), tool('Read', 'read', 5));
  assert.equal(list()[0].status, 'running');
  if (ending === 'interrupt') term._subagentsInterruptedAt = Date.parse(at(6));
  if (ending === 'parent abort') append(file, turn('turn_aborted', 'parent-turn', 6));
  if (ending !== 'completed') assert.equal(list()[0].status, 'stopped');
  append(child, turn('task_complete', 'child-turn', 7));
  assert.equal(list()[0].status, ending === 'completed' ? 'done' : 'stopped');
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

test('hook WebSocket notifications expose current GET state and preserve ordinary tool messages', { timeout: 5000 }, async t => {
  const { hub, root, sessionId } = setup(t, 'claude');
  Object.assign(hub, { baseDir: root, validSessionId, config: {}, hookToken: 'fixture-native', projects: { hidden: () => new Set() } });
  const transport = createHookTransport(hub);
  hub.toolHooks = transport.toolHooks;
  t.after(() => hub.toolHooks.close());
  const { handleSessionRoutes } = createSessionRoutes(hub);
  const urlFor = req => new URL(req.url, 'http://127.0.0.1');
  const authed = req => req.headers['x-token'] === 'fixture-client';
  const send = (res, code, data) => { res.writeHead(code); res.end(JSON.stringify(data)); };
  const body = async req => JSON.parse(await new Response(Readable.toWeb(req)).text());
  const server = http.createServer(async (req, res) => {
    const url = urlFor(req);
    try {
      if (url.pathname === '/api/session/subagent-hook') await transport.handleNativeHook(req, res, body, send);
      else if (!await handleSessionRoutes(url.pathname, url, req, res, body, send, authed)) send(res, 404, {});
    } catch (error) { send(res, 500, { error: error.message }); }
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (!transport.handleUpgrade(wss, req, socket, head, urlFor(req), authed)) socket.destroy();
  });
  server.listen(0, '127.0.0.1');
  const clients = [];
  t.after(async () => {
    for (const ws of clients) ws.terminate();
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    await new Promise(resolve => server.close(resolve));
  });
  await once(server, 'listening', { signal: t.signal });
  const host = `127.0.0.1:${server.address().port}`;
  const headers = { 'x-token': 'fixture-client' };
  async function request(route, input, extraHeaders) {
    const response = await fetch(`http://${host}${route}`, {
      headers: { ...headers, ...extraHeaders }, signal: t.signal,
      ...(input && { method: 'POST', body: JSON.stringify(input) }),
    });
    const data = await response.json();
    assert.equal(response.status, 200, JSON.stringify(data));
    return data;
  }
  const socket = route => {
    const ws = new WebSocket(`ws://${host}${route}`, { headers });
    clients.push(ws);
    return ws;
  };
  const hooks = socket('/ws/hooks');
  const activity = socket('/ws/tool-activity?termId=1');
  await Promise.all(clients.map(ws => once(ws, 'open', { signal: t.signal })));
  const message = async ws => JSON.parse((await once(ws, 'message', { signal: t.signal }))[0]);
  const refresh = async status => {
    assert.deepEqual(await message(hooks), { type: 'hook-event', termId: '1', sessionId });
    const list = await request('/api/session/subagents?termId=1');
    assert.deepEqual(list.map(({ id, status }) => [id, status]), [['use1', status]]);
    assert.equal((await request('/api/session/subagent-detail?termId=1&id=use1')).status, status);
  };
  for (const [hook_event_name, status] of [['PreToolUse', 'running'], ['PostToolUse', 'done']]) {
    await Promise.all([refresh(status), request('/api/session/subagent-hook', { termId: '1', data: {
      hook_event_name, session_id: sessionId, tool_name: 'Agent', tool_use_id: 'use1',
      tool_input: { prompt: 'Review' }, ...(status === 'done' && { tool_response: 'Reviewed' }),
    } }, { 'x-hook-token': hub.hookToken })]);
  }
  const ordinary = { termId: '1', tool: 'Read', target: 'fixture.txt', status: 'done', ts: 123 };
  const [event, posted] = await Promise.all([message(activity), request('/api/hooks/event', ordinary)]);
  assert.deepEqual(event, { type: 'hook-event', event: ordinary });
  assert.deepEqual(posted, { ok: true, event: ordinary });
});

test('persisted hook copies and a partial transcript merge by call ID, preserving a stop after late output', t => {
  const { hub, term, root, file, sessionId, list, append } = setup(t, 'claude');
  hub.toolHooks = createToolHooks({ baseDir: root });
  t.after(() => hub.toolHooks.close());
  const input = { prompt: 'Review' };
  const start = { termId: '1', sessionId, tool: 'Agent', callId: 'use1', input, status: 'start' };
  hub.toolHooks.recordEvent(start);
  const second = JSON.stringify(call('Agent', 'use2', input));
  fs.appendFileSync(file, second.slice(0, 20));
  assert.deepEqual(list().map(row => row.id), ['use1']);
  fs.appendFileSync(file, second.slice(20) + '\n');
  append(file, call('Agent', 'use1', input));
  assert.equal(list().length, 2);
  term._subagentsInterruptedAt = Date.now();
  assert.ok(list().every(row => row.status === 'stopped'));
  hub.toolHooks.recordEvent({ ...start, status: 'done', ts: term._subagentsInterruptedAt + 1, output: 'Late output' });
  assert.ok(list().every(row => row.status === 'stopped'));
  assert.equal(readSubagentDetail(hub, { id: 'use1', sessionId }).lastMessage, 'Late output');
});

test('links only the same-version project child and keeps its stopped state on the next turn', t => {
  const { hub, term, list } = setup(t, 'cursor');
  const task = id => ({ projectId: 'project', taskId: id });
  term.meta.projectTask = task('parent');
  hub.projects = { list: () => [{ id: 'project', tasks: [
    { id: 'parent', version: 1 }, { id: 'child', parentId: 'parent', version: 1 }, { id: 'other', parentId: 'parent', version: 2 },
  ] }] };
  for (const [id, name] of [['2', 'child'], ['3', 'other']]) hub.terms.set(id, { id, meta: { projectTask: task(name) }, exited: null, startedAt: Date.now() });
  assert.deepEqual(list().map(row => row.targetTermId), ['2']);
  term.status = 'idle';
  assert.equal(list()[0].status, 'stopped');
  term.status = 'busy';
  assert.equal(list()[0].status, 'stopped');
});

test('configured log root may be a junction, while a nested junction cannot supply a transcript', t => {
  const { hub, root, append } = setup(t, 'codex');
  const realRoot = path.join(root, 'sessions');
  const alias = path.join(root, 'account-sessions');
  fs.mkdirSync(realRoot);
  fs.symlinkSync(realRoot, alias, 'junction');
  hub.index.codexRoot = alias;
  const log = path.join(alias, 'allowed.jsonl');
  append(log, { type: 'session_meta' });
  hub.index.set('allowed', { file: log });
  assert.equal(transcriptFile(hub, 'allowed'), path.join(realRoot, 'allowed.jsonl'));
  fs.mkdirSync(path.join(root, 'outside'));
  fs.symlinkSync(path.join(root, 'outside'), path.join(realRoot, 'nested'), 'junction');
  const outside = path.join(alias, 'nested', 'outside.jsonl');
  append(outside, { type: 'session_meta' });
  hub.index.set('outside', { file: outside });
  assert.equal(transcriptFile(hub, 'outside'), null);
});

test('AGY parallel invoke_subagent decodes quoted Role, survives parent idle, and finishes on SYSTEM_MESSAGE', t => {
  const { term, file, list, append } = setup(t, 'agy');
  append(file, {
    type: 'PLANNER_RESPONSE',
    step_index: 1,
    created_at: '2026-01-01T00:00:01Z',
    tool_calls: [
      { name: 'invoke_subagent', args: { Prompt: '"Task A"', Role: '"Worker A"', TypeName: '"research"' } },
      { name: 'invoke_subagent', args: { Prompt: '"Task B"', Role: '"Worker B"', TypeName: '"self"' } },
    ],
  });
  append(file,
    { type: 'GENERIC', created_at: '2026-01-01T00:00:02Z', content: 'Created the following subagent:\n{"conversationId":"child-a-12345678"}' },
    { type: 'GENERIC', created_at: '2026-01-01T00:00:03Z', content: 'Created the following subagent:\n{"conversationId":"child-b-12345678"}' },
  );
  // Parent waits idle for async reactive wakeup
  term.status = 'idle';
  const running = list();
  assert.equal(running.length, 2);
  assert.deepEqual(running.map(x => [x.description, x.status]).sort(), [['Worker A', 'running'], ['Worker B', 'running']]);
  append(file, {
    type: 'SYSTEM_MESSAGE',
    created_at: '2026-01-01T00:00:10Z',
    content: '<SYSTEM_MESSAGE>\n[Message] content=Subagent child-a-12345678 has gone idle. This was the subagent\'s most recent response: DONE_A\n</SYSTEM_MESSAGE>',
  });
  const afterOne = list();
  const a = afterOne.find(x => x.description === 'Worker A');
  const b = afterOne.find(x => x.description === 'Worker B');
  assert.equal(a.status, 'done');
  assert.equal(b.status, 'running');
});

test('large transcripts (>2MB) still discover earlier subagents via streaming fastScan', t => {
  const { file, list, append } = setup(t, 'codex');
  append(file,
    { type: 'response_item', timestamp: '2026-01-01T00:00:01Z', payload: { type: 'function_call', name: 'spawn_agent', call_id: 'early1', arguments: '{"task_name":"audit"}' } },
    { type: 'event_msg', timestamp: '2026-01-01T00:00:02Z', payload: { type: 'item_completed', item: { type: 'SubAgentActivity', id: 'early1', kind: 'started', agent_thread_id: 'child-early-12345', agent_path: '/root/audit' } } },
  );
  // Append > 2.2 MB of filler lines so the early spawn falls before the 2MB tail window
  const filler = JSON.stringify({ type: 'response_item', timestamp: '2026-01-01T00:00:03Z', payload: { type: 'message', role: 'assistant', content: [{ text: 'x'.repeat(20_000) }] } }) + '\n';
  fs.appendFileSync(file, filler.repeat(120));
  const items = list();
  assert.equal(items.length, 1);
  assert.equal(items[0].name, 'audit');
  assert.equal(items[0].status, 'running');
});
