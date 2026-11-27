'use strict';

const { fields, WEEK } = require('./codex-token-events');

function recordWindows(state, usage) {
  for (const a of usage?.accounts || []) {
    if (!a.ok) continue;
    const account = (a.email || a.id || '').toLowerCase();
    for (const m of a.meters || []) {
      if (!/^Codex .*?(?:주간|weekly)/i.test(m.name)) continue;
      const reset = Math.floor(Date.parse(m.resetsAt) / 1000);
      if (!account || !Number.isSafeInteger(reset)) continue;
      const owners = state.windows[reset] ||= [];
      const plan = a.plan?.toLowerCase() || null;
      if (!owners.some(w => w.account === account && w.plan === plan)) owners.push({ account, plan });
    }
  }
}

function accountFor(state, row) {
  const exact = (state.windows[row.reset] || []).filter(w => !row.plan || !w.plan || w.plan === row.plan);
  // Secondary windows can round the same reset one second apart.
  const matches = exact.length || !row.reset || !row.plan ? exact
    : [state.windows[row.reset - 1], state.windows[row.reset + 1]].flatMap(list => list || [])
      .filter(w => w.plan === row.plan);
  const owners = new Set(matches.map(w => w.account));
  return owners.size === 1 ? owners.values().next().value : null;
}

function reportTokens(state, { account, week = false, now = Date.now() } = {}) {
  const needle = account?.toLowerCase();
  const groups = new Map();
  const observations = new Map();
  for (const row of Object.values(state.events)) {
    if (week && (!row.reset || now >= row.reset * 1000 || now < (row.reset - WEEK) * 1000)) continue;
    const owner = accountFor(state, row);
    if (needle && owner !== needle && owner?.split('@')[0] !== needle) continue;
    if (week && owner && Number.isFinite(row.weeklyUsed)) {
      const key = JSON.stringify([owner, row.reset]);
      const obs = observations.get(key) || { account: owner, reset: row.reset, first: row, last: row };
      if (row.ts < obs.first.ts) obs.first = row;
      if (row.ts > obs.last.ts) obs.last = row;
      observations.set(key, obs);
    }
    const key = JSON.stringify([owner, row.model, row.effort]);
    let group = groups.get(key);
    if (!group) {
      group = { account: owner, model: row.model, effort: row.effort,
        input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0,
        output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0, events: 0 };
      groups.set(key, group);
    }
    fields.forEach((field, i) => { group[field] += row.tokens[i]; });
    group.total_tokens += row.tokens[0] + row.tokens[3];
    group.events++;
  }
  for (const group of groups.values()) {
    group.uncached_input_tokens = group.input_tokens - group.cached_input_tokens;
  }
  return { collectedAt: state.collectedAt, groups: [...groups.values()]
    .sort((a, b) => String(a.account || '~').localeCompare(b.account || '~') || b.total_tokens - a.total_tokens),
    observations: [...observations.values()]
      .filter(o => o.first.ts < o.last.ts && o.last.weeklyUsed >= o.first.weeklyUsed)
      .map(({ account, reset, first, last }) => ({
        account, reset, from: first.weeklyUsed, to: last.weeklyUsed, fromAt: first.ts, toAt: last.ts,
        changePoints: last.weeklyUsed - first.weeklyUsed,
      })) };
}

module.exports = { accountFor, recordWindows, reportTokens };
