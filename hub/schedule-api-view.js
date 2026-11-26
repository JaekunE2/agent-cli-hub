'use strict';

const { error, UUID } = require('./schedule-fields');

function runView(run, local) {
  if (!run) return null;
  const { id, scheduleId, scheduleRevision, trigger, slotAt, createdAt, startedAt, finishedAt,
    durationMs, status, reason, exitCode, sessionId, missedFromAt, missedThroughAt, targetSnapshot } = run;
  let target = null;
  if (targetSnapshot) {
    const { projectId, version, taskId, cli, accountId, primaryCwd, referenceDirs } = targetSnapshot;
    target = { projectId, version, taskId, cli, accountId, ...(local && { primaryCwd, referenceDirs }) };
  }
  return { id, scheduleId, scheduleRevision, trigger, slotAt, createdAt, startedAt, finishedAt,
    durationMs, status, reason, exitCode, sessionId, missedFromAt, missedThroughAt, targetSnapshot: target,
    ...(local && { outputSummary: run.outputSummary, errorSummary: run.errorSummary }) };
}

function scheduleView(item, local) {
  const { id, name, revision, state, trigger, target, prompt, overlap, misfire, timeoutSec,
    nextRunAt, createdAt, updatedAt } = item;
  const { projectId, version, taskId, cli, accountId, model, effort, referenceDirs } = target;
  return { id, name, revision, state, trigger, overlap, misfire, timeoutSec, nextRunAt, createdAt, updatedAt,
    target: { projectId, version, taskId, cli, accountId, model, effort, ...(local && { referenceDirs }) },
    ...(local && { prompt }) };
}

const newestFirst = (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
const cursorFor = row => Buffer.from(JSON.stringify([row.createdAt, row.id])).toString('base64url');

function historyPage(query, rows, local) {
  const limit = query.get('limit') ?? '50';
  const cursor = query.get('before');
  if (!/^(?:[1-9][0-9]?|100)$/.test(limit)) throw error('INVALID_LIMIT', 'Limit must be 1 to 100');
  let before;
  if (cursor !== null) {
    try {
      if (cursor.length > 128 || !/^[\w-]+$/.test(cursor)) throw new Error();
      const [createdAt, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      before = { createdAt, id };
      if (new Date(createdAt).toISOString() !== createdAt || !UUID.test(id) || cursorFor(before) !== cursor) throw new Error();
    } catch {
      throw error('INVALID_CURSOR', 'Invalid run history cursor');
    }
  }
  const page = rows.filter(row => !before || newestFirst(row, before) > 0).sort(newestFirst).slice(0, Number(limit) + 1);
  const hasMore = page.length > Number(limit);
  if (hasMore) page.pop();
  return { items: page.map(run => runView(run, local)), nextCursor: hasMore ? cursorFor(page.at(-1)) : null };
}

module.exports = { runView, scheduleView, newestFirst, historyPage };
