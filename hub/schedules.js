'use strict';

const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { nextSlot, latestSlot } = require('./schedule-timing');
const { openStore, prune } = require('./schedule-store');
const { createWorkerRunner } = require('./schedule-worker');
const { UUID, iso, error, fields, normalizeTrigger, itemFor, editableItem } = require('./schedule-fields');
const { newRun, finish, ownsSlot, cancelQueued, admit } = require('./schedule-runs');

const POLL = 5_000;
const GRACE = 60_000;
const DAY = 86_400_000;

function createScheduleEngine({
  file = path.join(__dirname, 'data', 'schedules.json'),
  runner = createWorkerRunner(path.join(path.dirname(file), 'schedule-workers')),
  clock = Date, timers = globalThis, resolveTarget, onChange = () => {}, onError = console.error,
} = {}) {
  if (typeof resolveTarget !== 'function') throw new TypeError('Schedules require a target resolver');
  const store = openStore(file);
  let tail = Promise.resolve();
  let timer;
  let lastCleanup = -Infinity;

  function serialize(work) {
    const task = tail.then(work);
    tail = task.catch(() => {});
    return task;
  }

  function commit(data) {
    const previous = store.snapshot();
    const changed = key => {
      const before = new Map(previous[key].map(row => [row.id, JSON.stringify(row)]));
      const updated = data[key].filter(row => before.get(row.id) !== JSON.stringify(row)).map(row => row.id);
      for (const row of data[key]) before.delete(row.id);
      return [...updated, ...before.keys()];
    };
    const scheduleIds = changed('schedules');
    const runIds = changed('runs');
    if (!scheduleIds.length && !runIds.length &&
        JSON.stringify(data.manualRequests) === JSON.stringify(previous.manualRequests)) return previous.seq;
    const seq = store.commit(data);
    try { onChange({ seq, scheduleIds, runIds }); }
    catch (cause) { onError(cause); }
    return seq;
  }

  function saveSchedule(input, id, revision) {
    return serialize(async () => {
      const data = store.snapshot();
      const now = clock.now();
      const item = id === undefined ? null : editableItem(data, id, revision);
      if (!item && data.schedules.filter(row => row.state !== 'archived').length >= 200) {
        throw error('SCHEDULE_LIMIT', 'Schedule limit reached');
      }
      const values = fields(input, item, now);
      await resolveTarget(structuredClone(values.target));
      const next = {
        id: item?.id ?? randomUUID(), ...values,
        revision: (item?.revision ?? 0) + 1, state: item?.state ?? 'paused',
        nextRunAt: item?.nextRunAt ?? null, lastConsumedAt: item?.lastConsumedAt ?? null,
        createdAt: item?.createdAt ?? iso(now), updatedAt: iso(now),
      };
      if (item) {
        cancelQueued(data, id, 'SCHEDULE_CHANGED', now);
        if (next.state === 'active' && Object.hasOwn(input, 'trigger')) {
          next.nextRunAt = iso(nextSlot(next.trigger, Math.max(now, Date.parse(next.lastConsumedAt) || now)));
        }
        data.schedules[data.schedules.indexOf(item)] = next;
      } else data.schedules.push(next);
      return { item: structuredClone(next), seq: commit(data) };
    });
  }

  function setState(id, revision, state) {
    return serialize(() => {
      const data = store.snapshot();
      const item = editableItem(data, id, revision);
      if (item.state !== state) {
        const now = clock.now();
        item.state = state;
        item.revision++;
        item.updatedAt = iso(now);
        item.nextRunAt = null;
        if (state === 'active') {
          item.trigger = normalizeTrigger(item.trigger, now);
          item.nextRunAt = iso(nextSlot(item.trigger, Math.max(now, Date.parse(item.lastConsumedAt) || now)));
        } else cancelQueued(data, id, state === 'archived' ? 'ARCHIVED' : 'PAUSED', now);
      }
      return { item: structuredClone(item), seq: commit(data) };
    });
  }

  function runNow(id, revision, requestId) {
    return serialize(async () => {
      if (typeof requestId !== 'string' || !UUID.test(requestId)) throw error('INVALID_REQUEST_ID', 'A UUID request ID is required');
      const data = store.snapshot();
      const now = clock.now();
      const key = `${id}:${requestId.toLowerCase()}`;
      const previous = data.manualRequests[key];
      if (previous && Date.parse(previous.expiresAt) > now) {
        return { run: data.runs.find(row => row.id === previous.runId), seq: data.seq, replayed: true };
      }
      const item = editableItem(data, id, revision);
      const run = admit(data, item, 'manual', now, now);
      data.manualRequests[key] = { runId: run.id, expiresAt: iso(now + DAY) };
      const admitted = { run: structuredClone(run), seq: commit(data), replayed: false };
      try { await advance(false); }
      catch (cause) { onError(cause); }
      return admitted;
    });
  }

  function consume(data, now) {
    const due = [];
    for (const item of data.schedules) {
      const cursor = Date.parse(item.nextRunAt);
      if (item.state !== 'active' || cursor > now) continue;
      const missed = latestSlot(item.trigger, cursor, now - GRACE - 1);
      if (missed !== null && item.misfire === 'run_once') {
        due.push({ item, slot: latestSlot(item.trigger, cursor, now) });
      } else {
        if (missed !== null) due.push({ item, slot: missed, missedFrom: cursor });
        let through = now;
        for (;;) {
          const normal = latestSlot(item.trigger, Math.max(cursor, now - GRACE), through);
          if (normal === null) break;
          due.push({ item, slot: normal });
          through = normal - 1;
        }
      }
      const latest = latestSlot(item.trigger, cursor, now);
      if (latest !== null) item.lastConsumedAt = iso(latest);
      item.nextRunAt = iso(nextSlot(item.trigger, now, { allowDistant: true }));
    }
    due.sort((a, b) => a.slot - b.slot || a.item.id.localeCompare(b.item.id));
    for (const { item, slot, missedFrom } of due) {
      if (missedFrom === undefined) {
        admit(data, item, 'timer', slot, now);
      } else {
        const run = newRun(item, 'timer', slot, now);
        finish(run, 'skipped', 'MISFIRE_SKIPPED', now);
        Object.assign(run, { missedFromAt: iso(missedFrom), missedThroughAt: iso(slot) });
        data.runs.unshift(run);
      }
    }
  }

  async function reconcile(data, now) {
    const current = data.runs.find(ownsSlot);
    if (!current) return;
    const evidence = await runner.recover(current.id);
    const item = itemFor(data, current.scheduleId);
    if (evidence.state === 'finished') {
      const result = evidence.result;
      finish(current, result.outcome, result.reason ?? null, now, result,
        [item.prompt, current.targetSnapshot?.primaryCwd, ...(current.targetSnapshot?.referenceDirs || [])]);
      for (const run of data.runs) if (run.status === 'queued' && run.reason === 'WORKER_UNCERTAIN') run.reason = null;
    } else if (evidence.state === 'closed') {
      finish(current, current.cancelRequestedAt ? 'cancelled' : 'interrupted',
        current.cancelRequestedAt ? 'REPLACED' : 'START_INTERRUPTED', now);
    } else if (evidence.state === 'uncertain') {
      if (current.reason !== 'WORKER_UNCERTAIN') finish(current, 'interrupted', 'WORKER_UNCERTAIN', now);
      for (const run of data.runs) if (run.status === 'queued') run.reason = 'WORKER_UNCERTAIN';
    } else if (evidence.state === 'running' && current.status === 'starting') {
      current.status = 'running';
      current.startedAt = evidence.startedAt || iso(now);
    }
  }

  async function dispatch(data, now) {
    const current = data.runs.find(ownsSlot);
    if (current) {
      if (current.cancelRequestedAt) await runner.requestCancel(current.id);
      return;
    }
    const run = data.runs.findLast(row => row.status === 'queued');
    if (!run) return;
    const item = itemFor(data, run.scheduleId);
    let spec;
    try {
      const resolved = await resolveTarget(structuredClone(item.target));
      if (resolved.busy) {
        finish(run, 'skipped', 'PROJECT_BUSY', now);
        commit(data);
        return;
      }
      const stdinText = [resolved.taskText, item.prompt].filter(Boolean).join('\n\n');
      if (Buffer.byteLength(stdinText) > 65_536) throw error('INPUT_TOO_LARGE', 'Schedule input exceeds 64 KiB');
      if (!resolved.cwd || !resolved.cmd || !Array.isArray(resolved.args)) {
        throw error('CAPABILITY_UNSUPPORTED', 'Read-only schedule runner is unavailable');
      }
      spec = {
        runId: run.id, cwd: resolved.cwd, cmd: resolved.cmd, args: resolved.args, env: resolved.env ?? {},
        stdinText, timeoutMs: item.timeoutSec * 1000,
        sensitive: [item.prompt, resolved.taskText, ...item.target.referenceDirs].filter(Boolean),
      };
      const { projectId, taskId, version, cli, accountId, referenceDirs } = item.target;
      run.targetSnapshot = { projectId, taskId, version, cli, accountId,
        primaryCwd: spec.cwd, referenceDirs: resolved.referenceDirs ?? referenceDirs };
    } catch (cause) {
      const known = ['TARGET_MISSING', 'INPUT_TOO_LARGE', 'CAPABILITY_UNSUPPORTED'].includes(cause.code);
      finish(run, 'failed', known ? cause.code : 'TARGET_RESOLUTION_FAILED', now, { errorSummary: cause.message }, [item.prompt]);
      commit(data);
      if (!known) onError(cause);
      return;
    }
    run.status = 'starting';
    run.reason = null;
    commit(data);
    await runner.start(spec);
  }

  async function advance(timersDue) {
    const data = store.snapshot();
    const now = clock.now();
    await reconcile(data, now);
    if (timersDue) consume(data, now);
    prune(data, now);
    commit(data);
    await dispatch(data, now);
    if (timersDue && now - lastCleanup >= 60 * 60_000) {
      await runner.cleanup?.(new Set(data.runs.map(run => run.id)), now - 30 * DAY);
      lastCleanup = now;
    }
  }

  const tick = () => serialize(() => advance(true));
  let scheduledTick;
  function poll() {
    if (scheduledTick) return;
    scheduledTick = tick().catch(onError).finally(() => { scheduledTick = null; });
  }

  return {
    create: input => saveSchedule(input),
    update: (id, revision, input) => saveSchedule(input, id, revision),
    pause: (id, revision) => setState(id, revision, 'paused'),
    resume: (id, revision) => setState(id, revision, 'active'),
    archive: (id, revision) => setState(id, revision, 'archived'),
    runNow, tick,
    snapshot: store.snapshot,
    preview(trigger) {
      const now = clock.now();
      const normalized = normalizeTrigger(trigger, now);
      let cursor = now;
      const nextRunAts = Array.from({ length: 5 }, () => iso(cursor = nextSlot(normalized, cursor)));
      return { now: iso(now), nextRunAts };
    },
    start() {
      if (timer !== undefined) return;
      timer = timers.setInterval(poll, POLL);
      timer?.unref?.();
      poll();
    },
    stop() {
      if (timer !== undefined) timers.clearInterval(timer);
      timer = undefined;
    },
  };
}

module.exports = { createScheduleEngine };
