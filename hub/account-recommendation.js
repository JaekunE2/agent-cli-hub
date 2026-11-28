'use strict';

// Never guess quota when recommending an account, or silently cross agent types.
function recommendedAccount(candidates, sourceAgent, { allowCrossAgent = false, stale = false } = {}) {
  if (stale) return null;
  const available = candidates.filter(c => c.usable && !c.current &&
    [c.fiveH, c.weekly].some(v => typeof v === 'number' && Number.isFinite(v)) &&
    ![c.fiveH, c.weekly].some(v => typeof v === 'number' && v >= 100));
  const sorted = list => list.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0] || null;
  return sorted(available.filter(c => (c.agent || 'claude') === sourceAgent)) ||
    (allowCrossAgent ? sorted(available) : null);
}
module.exports = { recommendedAccount };
