'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { estimatesFor } = require('../codex-token-estimate');

test('weekly estimates use the plan reference automatically and omit unknown model rates', () => {
  const account = 'pro@example.test';
  const other = 'plus@example.test';
  const unknown = 'unknown@example.test';
  const groups = [
    { account, model: 'gpt-6.2-sol', uncached_input_tokens: 1_383_875,
      cached_input_tokens: 97_616_128, output_tokens: 234_806 },
    { account: other, model: 'gpt-6.2-sol', uncached_input_tokens: 1_000_000,
      cached_input_tokens: 0, output_tokens: 100_000 },
    { account: unknown, model: 'unpublished', uncached_input_tokens: 1 },
  ];
  const windows = { 2000: [{ account, plan: 'pro' }, { account: other, plan: 'plus' }] };
  const [pro, plus, unsupported] = estimatesFor(groups, windows, 1000);
  assert.equal(pro.plan, 'Pro');
  assert.equal(pro.basisUsd, 200);
  assert.equal(pro.costUsd.toFixed(2), '14.88');
  assert.equal(pro.percent.toFixed(1), '7.4');
  assert.equal(plus.basisUsd, 30);
  assert.equal(plus.plan, 'Plus');
  assert.equal(plus.percent, 10);
  assert.equal(unsupported.percent, null);
});
