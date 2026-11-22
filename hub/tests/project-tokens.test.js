const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const projectsStore = require('../projects');
const { SearchIndex } = require('../searchindex');

test('project token ledger accumulates tokens across switched CLIs without dropping prior CLI usage', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-tok-'));
  try {
    const claudeDir = path.join(dir, 'claude', 'proj1');
    const codexDir = path.join(dir, 'codex', '2026', '11', '22');
    const agyDir = path.join(dir, 'agy', '11111111-2222-3333-4444-555555555555', '.system_generated', 'logs');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.mkdirSync(codexDir, { recursive: true });
    fs.mkdirSync(agyDir, { recursive: true });

    // 1) Claude session with duplicate streaming message.id (must dedupe!)
    const claudeSid = 'aaaaaaaa-1111-2222-3333-444444444444';
    fs.writeFileSync(path.join(claudeDir, `${claudeSid}.jsonl`), [
      JSON.stringify({ type: 'user', cwd: 'D:\\demo', timestamp: '2026-11-22T01:00:00Z', message: { content: 'Start task' } }),
      JSON.stringify({ type: 'assistant', cwd: 'D:\\demo', timestamp: '2026-11-22T01:00:05Z', message: { id: 'msg_1', content: [{ type: 'text', text: 'Working' }], usage: { input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: 200, cache_creation_input_tokens: 100 } } }),
      JSON.stringify({ type: 'assistant', cwd: 'D:\\demo', timestamp: '2026-11-22T01:00:07Z', message: { id: 'msg_1', content: [{ type: 'text', text: 'Done' }], usage: { input_tokens: 1000, output_tokens: 300, cache_read_input_tokens: 200, cache_creation_input_tokens: 100 } } }),
    ].join('\n') + '\n');

    // 2) Codex session switched onto the SAME task
    const codexSid = 'bbbbbbbb-1111-2222-3333-444444444444';
    fs.writeFileSync(path.join(codexDir, `rollout-2026-11-22T02-00-00-${codexSid}.jsonl`), [
      JSON.stringify({ type: 'session_meta', timestamp: '2026-11-22T02:00:00Z', payload: { cwd: 'D:\\demo' } }),
      JSON.stringify({ type: 'event_msg', timestamp: '2026-11-22T02:01:00Z', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 2500, cached_input_tokens: 500, output_tokens: 400, reasoning_output_tokens: 100, total_tokens: 3000 } } } }),
    ].join('\n') + '\n');

    // 3) AGY session switched onto the SAME task
    const agySid = '11111111-2222-3333-4444-555555555555';
    fs.writeFileSync(path.join(agyDir, 'transcript.jsonl'), [
      JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', created_at: '2026-11-22T03:00:00Z', input_tokens: 4000, cache_read_tokens: 1000, output_tokens: 500, content: 'AGY reply' }),
    ].join('\n') + '\n');

    const idx = new SearchIndex(path.join(dir, 'claude'), path.join(dir, 'codex'), [path.join(dir, 'agy')]);
    await idx.refresh();

    assert.equal(idx.get(claudeSid).tokens.total, 1600); // 1000 + 300 + 200 + 100 (deduped msg_1)
    assert.equal(idx.get(codexSid).tokens.total, 3000);
    assert.equal(idx.get(agySid).tokens.total, 5500);

    const store = projectsStore(path.join(dir, 'projects.json'));
    const p = store.save({
      name: 'Multi-CLI Project', cwd: 'D:\\demo', goal: 'Test tokens', agent: 'claude', account: '', termIds: [],
      tasks: [{ id: 'task-1', title: 'Core feature', detail: '', stage: 'doing', agent: 'claude', account: null, termId: '', after: [] }],
    });

    // Simulate working on task-1 with Claude, then switching CLI to Codex, then AGY
    store.remember([
      { projectId: p.id, taskId: 'task-1', sessionId: claudeSid, agent: 'claude', tokens: idx.get(claudeSid).tokens },
      { projectId: p.id, taskId: 'task-1', sessionId: codexSid, agent: 'codex', tokens: idx.get(codexSid).tokens },
      { projectId: p.id, taskId: 'task-1', sessionId: agySid, agent: 'agy', tokens: idx.get(agySid).tokens },
    ]);

    // Even if the Claude transcript is later missing from live index (e.g. switched/archived), ledger preserves it!
    const summary = store.tokenSummary(p.id, (sid) => (sid === claudeSid ? null : idx.get(sid)?.tokens));
    assert.equal(summary.total.total, 1600 + 3000 + 5500);
    assert.equal(summary.byAgent.claude.total, 1600);
    assert.equal(summary.byAgent.codex.total, 3000);
    assert.equal(summary.byAgent.agy.total, 5500);
    assert.equal(summary.byTask['task-1'].total.total, 10100);
    assert.equal(summary.byTask['task-1'].sessions, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
