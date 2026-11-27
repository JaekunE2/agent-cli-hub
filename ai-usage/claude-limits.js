'use strict';

const legacyLabels = {
  five_hour: '5시간 세션',
  seven_day: '주간 (전체 모델)',
  seven_day_fable: '주간 (Fable)',
  seven_day_opus: '주간 (Opus)',
  seven_day_sonnet: '주간 (Sonnet)',
};

function claudeLimits(usage) {
  const meters = new Map();
  for (const limit of Array.isArray(usage.limits) ? usage.limits : []) {
    if (!limit?.kind) continue;
    const model = limit.scope?.model;
    const scope = (typeof model === 'string' ? model : model?.display_name || model?.id) || limit.scope?.surface || '';
    const weekly = limit.group === 'weekly' || /^(?:weekly|seven_day)(?:_|$)/i.test(limit.kind);
    let name;
    if (limit.kind === 'session') name = legacyLabels.five_hour;
    else if (limit.kind === 'weekly_all') name = legacyLabels.seven_day;
    else if (weekly && /fable/i.test([limit.kind, scope, model?.id, model?.family].join(' '))) name = legacyLabels.seven_day_fable;
    else name = legacyLabels[limit.kind] || (weekly ? `주간 (${scope || limit.kind})` : scope || limit.kind);
    meters.set(name, { name, usedPercent: limit.percent, resetsAt: limit.resets_at });
  }
  for (const [key, name] of Object.entries(legacyLabels)) {
    const limit = usage[key];
    if (limit && meters.get(name)?.usedPercent == null) {
      meters.set(name, { name, usedPercent: limit.utilization, resetsAt: limit.resets_at });
    }
  }
  const standard = Object.values(legacyLabels);
  return [...standard.map(name => meters.get(name)).filter(Boolean),
    ...[...meters.values()].filter(meter => !standard.includes(meter.name))];
}

module.exports = { claudeLimits };
