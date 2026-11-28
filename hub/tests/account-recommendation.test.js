'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { recommendedAccount } = require('../account-recommendation');
const account = (id, agent, weekly, extra = {}) => ({ id, agent, weekly, fiveH: null, score: 100 - (weekly ?? 50), usable: true, current: false, ...extra });
test('prefers same agent headroom and excludes current accounts', () => {
  const rows = [account('current', 'claude', 0, { current: true }), account('a', 'claude', 60), account('b', 'claude', 10), account('gpt', 'codex', 0)];
  assert.equal(recommendedAccount(rows, 'claude').id, 'b');
});
test('does not cross agent types unless explicitly enabled', () => {
  const rows = [account('full', 'claude', 100), account('gpt', 'codex', 0)];
  assert.equal(recommendedAccount(rows, 'claude'), null);
  assert.equal(recommendedAccount(rows, 'claude', { allowCrossAgent: true }).id, 'gpt');
});
test('does not recommend failed, unknown, stale or exhausted windows', () => {
  assert.equal(recommendedAccount([account('unknown', 'claude', null), account('failed', 'claude', 2, { usable: false }), account('5h-full', 'claude', 5, { fiveH: 100 })], 'claude'), null);
  assert.equal(recommendedAccount([account('fine', 'claude', 2)], 'claude', { stale: true }), null);
});
