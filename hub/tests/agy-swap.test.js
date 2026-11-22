'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseResetDuration, parseAgySwapList, createAgySwapService } = require('../agy-swap');
const projectAccounts = require('../project-accounts');

const SAMPLE_OUTPUT = `
MANAGED ACCOUNTS
─────────────────────────────────────────────────────────────────
Quota comes from Google; grouped models share weekly and optional 5-hour limits.
 ○ [1] [AA] Alpha User <alpha@example.com>
       ↳ Status: [Google AI Pro] Ready · Claude/GPT 100.00% available
       ↳ Gemini Models
          Weekly: [██████▉░░░░░]  56.77% remaining · resets in 6d 10h 39m (Sun 29 Nov 09:00 +0900)
          5-Hour: [██████▋░░░░░]  55.67% remaining · resets in 1h 40m (Mon 23 Nov 00:00 +0900)
       ↳ Claude and GPT models
          Weekly: [████████████] 100.00% remaining · resets in 6d 23h 55m (Sun 29 Nov 22:16 +0900)
          5-Hour: [████████████] 100.00% remaining · resets in 4h 55m (Mon 23 Nov 03:16 +0900)
 ● [2] [BB] Beta User <beta@example.com> (Active)
       ↳ Status: [Google AI Pro] Ready · Gemini 100.00% available
       ↳ Gemini Models
          Weekly: [████████████] 100.00% remaining · resets in 6d 23h 57m (Sun 29 Nov 22:19 +0900)
          5-Hour: [████████████] 100.00% remaining · resets in 4h 57m (Mon 23 Nov 03:19 +0900)
─────────────────────────────────────────────────────────────────
`;

test('parseResetDuration and parseAgySwapList extract accounts, active flag, plans, and quotas', () => {
  assert.equal(parseResetDuration('1h 40m'), 100 * 60 * 1000);
  assert.equal(parseResetDuration('6d 10h 39m'), (6 * 86400 + 10 * 3600 + 39 * 60) * 1000);

  const now = Date.UTC(2026, 10, 22, 13, 20, 0);
  const accs = parseAgySwapList(SAMPLE_OUTPUT, { now });
  assert.equal(accs.length, 2);

  assert.equal(accs[0].id, 'agyswap:alpha@example.com');
  assert.equal(accs[0].email, 'alpha@example.com');
  assert.equal(accs[0].name, 'Alpha User');
  assert.equal(accs[0].active, false);
  assert.equal(accs[0].plan, 'Google AI Pro');
  assert.equal(accs[0].groups.length, 2);
  assert.equal(accs[0].groups[0].fiveHRem, 55.7);
  assert.equal(accs[0].groups[0].fiveH, 44.3);
  assert.equal(accs[0].groups[0].weeklyRem, 56.8);
  assert.equal(accs[0].groups[0].fiveHReset, '1h 40m');

  assert.equal(accs[1].id, 'agyswap:beta@example.com');
  assert.equal(accs[1].active, true);
  assert.equal(accs[1].groups[0].fiveHRem, 100);
  assert.equal(accs[1].groups[0].fiveH, 0);
});

test('createAgySwapService caches quota refreshes and updates active flag on switchTo', async () => {
  const calls = [];
  const svc = createAgySwapService({
    exeFn: () => 'C:\\mock\\agy-swap.exe',
    runner: async (args) => {
      calls.push(args);
      if (args[0] === 'limits' || args[0] === 'list') return SAMPLE_OUTPUT;
      if (args[0] === '--switch-to') return 'Switched';
      return '';
    },
  });

  const res = await svc.refresh({ force: true });
  assert.equal(res.ok, true);
  assert.equal(res.accounts.length, 2);
  assert.deepEqual(calls, [['limits']]);

  const sw = await svc.switchTo('agyswap:alpha@example.com');
  assert.equal(sw.ok, true);
  assert.equal(sw.account.email, 'alpha@example.com');
  assert.deepEqual(calls[1], ['--switch-to', 'alpha@example.com']);
  assert.equal(svc.getFast().accounts.find((a) => a.email === 'alpha@example.com').active, true);
  assert.equal(svc.getFast().accounts.find((a) => a.email === 'beta@example.com').active, false);
});

test('projectAccounts resolves agyswap: account IDs with switchAgySwap target', () => {
  const pa = projectAccounts({
    claude: () => [],
    codex: () => [],
    agy: () => [{ id: 'agyswap:alpha@example.com', label: 'Alpha User (alpha@example.com)', email: 'alpha@example.com' }],
    codexEnv: () => ({}),
  });
  const list = pa.list('agy');
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'agyswap:alpha@example.com');

  const resolved = pa.resolve('agy', 'agyswap:alpha@example.com');
  assert.deepEqual(resolved.env, {});
  assert.equal(resolved.switchAgySwap, 'alpha@example.com');
  assert.equal(resolved.account.email, 'alpha@example.com');
});
