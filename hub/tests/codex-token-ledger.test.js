'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { watchCodexTokens, readTokens, readTurnTokens } = require('../codex-token-ledger');
const { SearchIndex } = require('../searchindex');
const { reportTokens } = require('../codex-token-report');
const { setTimeout: wait } = require('node:timers/promises');

test('CLI ledger saves completed answers without double-counting branches', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ccd-codex-token-test-'));
  let stop;
  try {
    const dir = path.join(home, 'sessions');
    const file = path.join(home, 'ledger.json');
    await fs.mkdir(dir);
    const resetA = Math.floor(Date.now() / 1000) + 600;
    const resetB = resetA - 60;
    const start = (resetA - 600) * 1000;
    const snapshot = (email, reset) => ({ email, ok: true, plan: 'Pro',
      meters: [{ name: 'Codex 주간 한도', resetsAt: new Date(reset * 1000).toISOString() }] });
    const usage = { accounts: [snapshot('a@example.com', resetA), snapshot('b@example.com', resetB)] };
    let lookups = 0;
    const errors = [];
    stop = await watchCodexTokens({ getUsage: () => { lookups++; return usage; },
      file, homes: [home, home], onError: e => errors.push(e) });
    assert.ok(stop);
    assert.equal(await watchCodexTokens({ file, homes: [home] }), null);
    async function until(check) {
      for (let i = 0; i < 100; i++) {
        const result = await check();
        if (result) return result;
        await wait(25);
      }
      assert.fail(`Expected ledger update (watch errors: ${errors})`);
    }
    const context = (turn_id, effort) => ({ type: 'turn_context', payload: { turn_id, model: 'gpt-sol', effort } });
    const meta = (id, source, forked_from_id) => ({ type: 'session_meta', payload: { id, source, forked_from_id } });
    const use = (time, reset, input, cached, output, reasoning) => ({
      timestamp: new Date(start + time).toISOString(), type: 'event_msg',
      payload: { type: 'token_count',
        rate_limits: reset && { limit_id: 'codex', plan_type: 'pro', primary: { window_minutes: 10080, resets_at: reset } },
        info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output,
          reasoning_output_tokens: reasoning } } },
    });
    const original = path.join(dir, 'rollout-original.jsonl');
    const turnA = context('turn-a', 'medium');
    const rowA = use(1, resetA, 100, 80, 10, 4);
    const lines = (...items) => items.map(item => JSON.stringify(item) + '\n').join('');
    const end = (turn_id, type = 'task_complete') => ({ type: 'event_msg', payload: { type, turn_id } });
    const reply = (phase, text) => ({ type: 'response_item',
      payload: { type: 'message', role: 'assistant', phase, content: [{ type: 'output_text', text }] } });
    await fs.writeFile(original, lines(meta('original', 'cli'), turnA, reply('commentary', 'Working'),
      rowA, rowA, reply('final_answer', 'Done')));
    await wait(180);
    assert.deepEqual((await readTokens({}, file)).groups, []);
    assert.equal(lookups, 0);
    await fs.appendFile(original, lines(end('turn-a')));
    const first = await until(async () => (await readTokens({ account: 'a' }, file)).groups[0]);
    assert.deepEqual([first.total_tokens, first.events], [110, 1]);
    await fs.writeFile(path.join(dir, 'rollout-fork.jsonl'), lines(meta('fork', 'cli', 'original'), turnA, rowA, end('turn-a')));
    await fs.writeFile(path.join(dir, 'rollout-desktop.jsonl'), lines(meta('desktop', 'vscode'),
      context('desktop-turn', 'high'), use(2, resetA, 10000, 8000, 100, 40), end('desktop-turn')));
    const next = lines(context('turn-b', 'high'), use(3, resetB + 1, 140, 100, 15, 6), end('turn-b'));
    await fs.appendFile(original, next.slice(0, -3));
    await wait(180);
    assert.equal((await readTokens({ account: 'b' }, file)).groups.length, 0);
    await fs.appendFile(original, next.slice(-3));
    await until(async () => (await readTokens({ account: 'b' }, file)).groups[0]);
    await fs.appendFile(original, lines(context('interrupted', 'high'),
      use(4, resetB, 160, 115, 20, 8), end('interrupted', 'turn_aborted')));
    await wait(180);
    const rows = (await readTokens({ week: true, now: start + 100 }, file)).groups;
    assert.deepEqual(rows.map(g => [g.account, g.effort, g.total_tokens, g.cached_input_tokens,
      g.uncached_input_tokens, g.reasoning_output_tokens]),
    [['a@example.com', 'medium', 110, 80, 20, 4], ['b@example.com', 'high', 45, 20, 20, 2]]);
    assert.equal((await readTokens({ week: true, now: resetA * 1000 }, file)).groups.length, 0);
    assert.equal(lookups, 1);
    assert.deepEqual(errors, []);
    const index = new SearchIndex(home, dir, []);
    await index.updateFile(original, { codexAnswers: true });
    const messages = index.get('rollout-original').msgs;
    assert.deepEqual(messages.filter(m => !m.text.startsWith('⚙')).map(m => [m.text, m.codexTurnId]),
      [['Working', undefined], ['Done', 'turn-a']]);
    const turnRows = await readTurnTokens(['turn-a', 'turn-b', 'interrupted'], file);
    assert.deepEqual(Object.entries(turnRows).map(([id, groups]) => [id, groups[0].total_tokens]),
      [['turn-a', 110], ['turn-b', 45]]);
  } finally {
    await stop?.();
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('weekly quota movement uses two readings from the same account and reset window', () => {
  const reset = 1796277017;
  const account = 'a@example.com';
  const sample = (at, weeklyUsed, window = reset) => ({
    ts: (reset - at) * 1000, reset: window, weeklyUsed, tokens: [1000, 800, 0, 10, 2],
  });
  const state = { windows: { [reset]: [{ account }], [reset + 10]: [{ account }] },
    events: { first: sample(300, 7), last: sample(200, 31), otherWindow: sample(100, 35, reset + 10) } };
  const { observations } = reportTokens(state, { account, week: true, now: (reset - 1) * 1000 });
  assert.deepEqual(observations.map(o => [o.from, o.to, o.changePoints]), [[7, 31, 24]]);
});
