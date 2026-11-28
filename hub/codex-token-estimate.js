'use strict';

// USD per million [uncached input, cached input, output] at standard rates.
const rates = new Map([
  ['gpt-6.2-sol', [2, .1, 10]],
  ['gpt-6.1-sol', [2, .1, 10]],
  ['gpt-6.1-terra', [1, .05, 5]],
  ['gpt-6.2-astra', [8, .4, 40]],
  ['gpt-6-astra', [10, 1, 50]],
]);
const defaultBasis = new Map([['pro', { plan: 'Pro', basisUsd: 200 }], ['plus', { plan: 'Plus', basisUsd: 30 }]]);

function estimatesFor(groups, windows, now = Date.now()) {
  const plans = new Map();
  for (const [reset, owners] of Object.entries(windows).sort((a, b) => a[0] - b[0])) {
    if (Number(reset) * 1000 <= now) continue;
    for (const { account, plan } of owners) if (account && plan) plans.set(account, plan);
  }
  const totals = new Map();
  for (const row of groups) {
    if (!row.account) continue;
    const rate = rates.get(row.model);
    const cost = rate ? (rate[0] * row.uncached_input_tokens + rate[1] * row.cached_input_tokens
      + rate[2] * row.output_tokens) / 1e6 : null;
    const previous = totals.get(row.account);
    totals.set(row.account, previous === null || cost === null ? null : (previous || 0) + cost);
  }
  return [...totals].map(([account, costUsd]) => {
    const { plan = null, basisUsd = null } = defaultBasis.get(plans.get(account)) || {};
    return { account, plan, costUsd, basisUsd,
      percent: costUsd != null && basisUsd > 0 ? 100 * costUsd / basisUsd : null };
  });
}

module.exports = { estimatesFor };
