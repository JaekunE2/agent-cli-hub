'use strict';

const { randomUUID } = require('node:crypto');
const { iso } = require('./schedule-fields');
const { summarize } = require('./schedule-result');

function newRun(item, trigger, slotAt, now) {
  return {
    id: randomUUID(), scheduleId: item.id, scheduleRevision: item.revision, trigger,
    slotAt: iso(slotAt), createdAt: iso(now), startedAt: null, finishedAt: null, durationMs: null,
    status: 'queued', reason: null, exitCode: null, sessionId: null, outputSummary: '', errorSummary: '',
    targetSnapshot: null,
  };
}

function finish(run, status, reason, now, result = {}, sensitive = []) {
  const startedAt = result.startedAt || run.startedAt;
  const finishedAt = result.finishedAt || iso(now);
  Object.assign(run, {
    status, reason, startedAt, finishedAt, durationMs: startedAt ? Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)) : null,
    exitCode: result.exitCode ?? null, sessionId: result.sessionId ?? null,
    outputSummary: summarize(result.outputSummary, sensitive), errorSummary: summarize(result.errorSummary, sensitive),
  });
  delete run.cancelRequestedAt;
}

const ownsSlot = run => ['starting', 'running'].includes(run.status) ||
  (run.status === 'interrupted' && run.reason === 'WORKER_UNCERTAIN');

function cancelQueued(data, id, reason, now) {
  for (const run of data.runs) {
    if (run.scheduleId === id && run.status === 'queued') finish(run, 'cancelled', reason, now);
  }
}

function admit(data, item, trigger, slot, now) {
  const run = newRun(item, trigger, slot, now);
  const queued = data.runs.find(row => row.scheduleId === item.id && row.status === 'queued');
  const running = data.runs.find(row => row.scheduleId === item.id && ownsSlot(row));
  if (running?.reason === 'WORKER_UNCERTAIN' && item.overlap === 'replace') {
    if (queued) finish(queued, 'cancelled', 'REPLACED', now);
    run.reason = 'WORKER_UNCERTAIN';
  } else if (item.overlap === 'replace') {
    if (queued) finish(queued, 'cancelled', 'REPLACED', now);
    if (running) running.cancelRequestedAt = iso(now);
  } else if (item.overlap === 'skip' && (queued || running)) {
    finish(run, 'skipped', 'OVERLAP', now);
  } else if (queued) {
    finish(run, 'skipped', 'QUEUE_FULL', now);
  }
  data.runs.unshift(run);
  return run;
}

module.exports = { newRun, finish, ownsSlot, cancelQueued, admit };
