'use strict';

const fields = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens',
  'output_tokens', 'reasoning_output_tokens'];
const counters = (usage) => fields.map(key => Number(usage?.[key]) || 0);
const WEEK = 7 * 24 * 60 * 60;
const relevant = /"(session_meta|turn_context|model_reroute|token_count|task_started|task_complete|turn_aborted)"/;

function tokenEvent(line, cursor) {
  if (!relevant.test(line)) return null;
  let record;
  try { record = JSON.parse(line); } catch { return null; }
  const p = record?.payload || {};
  if (record?.type === 'session_meta') {
    cursor.source = p.source;
    cursor.session = p.session_id || p.id || cursor.session;
    cursor.session = p.forked_from_id || cursor.session;
    cursor.reset = null;
    cursor.plan = null;
    return null;
  }
  if (record?.type === 'turn_context' || (record?.type === 'event_msg' && p.type === 'task_started')) {
    if (p.turn_id && p.turn_id !== cursor.turn) {
      cursor.reset = null;
      cursor.plan = null;
      cursor.turn = p.turn_id;
    }
    if (record.type === 'turn_context') {
      cursor.model = p.model;
      cursor.effort = p.effort || p.reasoning_effort;
    }
    return null;
  }
  if (record?.type !== 'event_msg') return null;
  if (['task_complete', 'turn_aborted'].includes(p.type) && p.turn_id) {
    return { ended: p.turn_id, completed: p.type === 'task_complete' };
  }
  if (p.type === 'model_reroute') cursor.model = p.to_model || cursor.model;
  if (p.type !== 'token_count') return null;
  const ts = Date.parse(record.timestamp);
  const limits = p.rate_limits;
  let weeklyUsed;
  if (limits && (!limits.limit_id || limits.limit_id === 'codex')) {
    const week = [limits.primary, limits.secondary].find(w => w?.window_minutes === 10080);
    if (week?.resets_at) {
      cursor.reset = Number(week.resets_at);
      cursor.plan = limits.plan_type?.toLowerCase() || null;
      if (Number.isFinite(week.used_percent) && week.used_percent >= 0 && week.used_percent <= 100) {
        weeklyUsed = week.used_percent;
      }
    }
  }
  const usage = p.info?.total_token_usage;
  if (!usage) return null;
  const current = counters(usage);
  let delta = cursor.previous && current.map((n, i) => n - cursor.previous[i]);
  if (!delta || delta.some(n => n < 0)) delta = counters(p.info.last_token_usage || usage);
  cursor.previous = current;
  if (!['cli', 'exec'].includes(cursor.source) || !Number.isFinite(ts) || !delta.some(n => n > 0)) return null;
  if (delta.some(n => !Number.isSafeInteger(n) || n < 0) || delta[1] > delta[0] || delta[4] > delta[3]) return null;
  const reset = cursor.reset && ts >= (cursor.reset - WEEK) * 1000 && ts < cursor.reset * 1000
    ? cursor.reset : null;
  // Forked rollouts copy old events, preserving their timestamp and turn ID.
  const key = JSON.stringify([ts, cursor.turn || cursor.session, ...current]);
  const row = { ts, reset, plan: cursor.plan, source: cursor.source, model: cursor.model || null,
    effort: cursor.effort || null, tokens: delta, ...(reset && weeklyUsed != null ? { weeklyUsed } : {}) };
  return { key, row, turn: cursor.turn };
}

module.exports = { tokenEvent, fields, WEEK };
