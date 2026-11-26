'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { nextSlot, latestSlot } = require('../schedule-timing');
const { createScheduleEngine } = require('../schedules');
const { createWorkerRunner } = require('../schedule-worker');
const { prune } = require('../schedule-store');
const { summarize } = require('../schedule-result');

const MINUTE = 60_000;
const NOW = Date.parse('2026-01-01T00:00:00.000Z');
const at = minutes => new Date(NOW + minutes * MINUTE).toISOString();
const cron = (expression, timeZone = 'UTC') => ({ kind: 'cron', expression, timeZone });
const spec = {
  name: 'Scheduled summary', prompt: 'Read and summarize', target: { projectId: 'p', version: '1' },
  trigger: { kind: 'interval', everyMinutes: 5 },
};

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-schedules-'));
  t.after(() => {
    // This fixture creates only a single store file.
    fs.rmSync(path.join(directory, 'schedules.json'), { force: true });
    fs.rmdirSync(directory);
  });
  const file = path.join(directory, 'schedules.json');
  let now = NOW;
  const started = [];
  const evidence = new Map();
  const cancelled = new Set();
  let onTimer;
  const runner = {
    start(input) {
      started.push(input);
      evidence.set(input.runId, { state: 'running', startedAt: new Date(now).toISOString() });
    },
    recover: id => evidence.get(id) ?? { state: 'closed' },
    requestCancel: id => cancelled.add(id),
  };
  const clock = { now: () => now };
  const timers = {
    setInterval(callback, interval) {
      assert.equal(interval, 5000);
      onTimer = callback;
      return 1;
    },
    clearInterval() { onTimer = undefined; },
  };
  const events = [];
  const resolveTarget = () => ({ cwd: directory, cmd: process.execPath, args: [], taskText: 'Task context' });
  const open = overrides => createScheduleEngine({
    file, clock, timers, runner, resolveTarget, onChange: event => events.push(event),
    onError: assert.fail, ...overrides,
  });
  return {
    file, open, started, evidence, cancelled, events, set: minutes => { now = NOW + minutes * MINUTE; },
    timer: () => onTimer,
    finish(id, result = {}) {
      evidence.set(id, { state: 'finished', result: { outcome: 'succeeded', exitCode: 0, ...result } });
    },
  };
}

async function activate(engine, overrides = {}) {
  const { item } = await engine.create({ ...spec, ...overrides });
  return (await engine.resume(item.id, item.revision)).item;
}

test('interval uses UTC elapsed time and slots strictly after the anchor and cursor', () => {
  const interval = { ...spec.trigger, anchorAt: at(0) };
  assert.equal(nextSlot(interval, NOW - MINUTE), NOW + 5 * MINUTE);
  assert.equal(nextSlot(interval, NOW + 5 * MINUTE), NOW + 10 * MINUTE);
  assert.equal(latestSlot(interval, NOW, NOW + 149 * MINUTE), NOW + 145 * MINUTE);
  assert.equal(latestSlot(interval, NOW, NOW + MINUTE), null);
});

test('cron validates fields and zone, supports OR, ranges, steps and Sunday 7', () => {
  const next = (expression, start, zone) => new Date(nextSlot(cron(expression, zone), Date.parse(start))).toISOString();
  assert.equal(next('0 9 13 * 7', '2026-01-11T09:00Z'), '2026-01-13T09:00:00.000Z');
  assert.equal(next('0 9 13 * 7', '2026-01-13T09:00Z'), '2026-01-18T09:00:00.000Z');
  assert.equal(next('5,10-20/5 8 * * 1-5', '2026-01-05T08:10Z'), '2026-01-05T08:15:00.000Z');
  for (const expression of ['@daily', '0 0 0 * * *', '60 1 * * *', '*/0 * * * *', '0 0 31 2 *']) {
    assert.throws(() => nextSlot(cron(expression), NOW), { code: 'INVALID_TRIGGER' });
  }
  for (const zone of ['Wrong/Zone', '+05:00']) assert.throws(() => nextSlot(cron('* * * * *', zone), NOW), { code: 'INVALID_TRIGGER' });
});

test('cron skips DST gaps and uses the first UTC occurrence of a folded time', () => {
  const trigger = cron('30 2 * * *', 'America/New_York');
  assert.equal(new Date(nextSlot(trigger, Date.parse('2026-03-08T00:00Z'))).toISOString(), '2026-03-09T06:30:00.000Z');
  const fold = cron('30 1 * * *', 'America/New_York');
  const first = Date.parse('2026-11-01T05:30Z');
  assert.equal(nextSlot(fold, Date.parse('2026-11-01T00:00Z')), first);
  assert.equal(nextSlot(fold, first), Date.parse('2026-11-02T06:30Z'));
  assert.equal(latestSlot(fold, first + 1, Date.parse('2026-11-01T08:00Z')), null);
});

test('persists schedule, cursor, sequence, and in-flight identity across reopen', async t => {
  const f = fixture(t);
  const engine = f.open();
  const item = await activate(engine);
  f.set(5);
  await Promise.all([engine.tick(), engine.tick()]);
  const saved = engine.snapshot();
  assert.equal(saved.schedules[0].nextRunAt, at(10));
  assert.equal(saved.runs[0].status, 'running');
  assert.equal(saved.runs[0].slotAt, at(5));
  assert.equal(saved.runs[0].scheduleId, item.id);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file, 'utf8')), saved);

  const restarted = f.open();
  await restarted.tick();
  assert.equal(restarted.snapshot().seq, saved.seq);
  assert.equal(f.started.length, 1);
  f.set(6);
  f.finish(saved.runs[0].id);
  await restarted.tick();
  assert.equal(restarted.snapshot().runs[0].durationMs, MINUTE);
  assert.equal(f.events.at(-1).seq, saved.seq + 1);
  f.set(4);
  await restarted.tick();
  assert.equal(restarted.snapshot().schedules[0].nextRunAt, at(10));
});

test('reopen applies skip and run_once to missed intervals and prefers a newer on-time slot', async t => {
  const f = fixture(t);
  const engine = f.open();
  const skip = await activate(engine, { misfire: 'skip' });
  const once = await activate(engine, { misfire: 'run_once' });
  f.set(16);
  const restarted = f.open();
  await restarted.tick();
  const { runs, schedules } = restarted.snapshot();
  const skipped = runs.find(run => run.reason === 'MISFIRE_SKIPPED');
  assert.equal(skipped.scheduleId, skip.id);
  assert.equal(skipped.missedFromAt, at(5));
  assert.equal(skipped.missedThroughAt, at(10));
  assert.deepEqual(runs.filter(run => run.scheduleId === once.id).map(run => run.slotAt), [at(15)]);
  assert.equal(runs.filter(run => run.slotAt === at(15)).length, 2);
  assert.ok(schedules.every(item => item.nextRunAt === at(20)));
  await restarted.tick();
  assert.equal(restarted.snapshot().runs.length, 3);
});

test('timer injection polls every five seconds and stop leaves the store intact', async t => {
  const f = fixture(t);
  const engine = f.open();
  await activate(engine);
  engine.start();
  await engine.tick();
  f.set(5);
  f.timer()();
  await engine.tick();
  assert.equal(f.started.length, 1);
  engine.stop();
  assert.equal(f.timer(), undefined);
  assert.equal(engine.snapshot().runs[0].slotAt, at(5));
});

test('run_once restores the newest missed slot when no on-time slot exists', async t => {
  const f = fixture(t);
  await activate(f.open(), { misfire: 'run_once' });
  f.set(17);
  const restarted = f.open();
  await restarted.tick();
  assert.deepEqual(restarted.snapshot().runs.map(run => run.slotAt), [at(15)]);
  assert.equal(f.started.length, 1);
});

test('reopened cron consumes only the latest missed slot and keeps the next slot after clock rollback', async t => {
  const f = fixture(t);
  const item = await activate(f.open(), { trigger: cron('*/5 * * * *'), misfire: 'run_once' });
  assert.equal(item.nextRunAt, at(5));
  f.set(17);
  const restarted = f.open();
  await restarted.tick();
  const [run] = restarted.snapshot().runs;
  assert.equal(run.scheduleId, item.id);
  assert.equal(run.trigger, 'timer');
  assert.equal(run.slotAt, at(15));
  assert.equal(restarted.snapshot().schedules[0].nextRunAt, at(20));

  f.finish(run.id);
  await restarted.tick();
  f.set(14);
  await restarted.tick();
  f.set(15);
  await restarted.tick();
  assert.equal(restarted.snapshot().runs.length, 1);
  assert.equal(f.started.length, 1);

  f.set(20);
  await restarted.tick();
  assert.deepEqual(restarted.snapshot().runs.map(row => row.slotAt), [at(20), at(15)]);
  assert.deepEqual(f.started.map(started => started.runId), [run.id, restarted.snapshot().runs[0].id]);
});

for (const [overlap, expected] of Object.entries({
  skip: { timer: ['skipped', 'OVERLAP'], waiting: ['skipped', 'OVERLAP'] },
  queue: { timer: ['skipped', 'QUEUE_FULL'], waiting: ['queued', null] },
  replace: { timer: ['queued', null], waiting: ['cancelled', 'REPLACED'] },
})) {
  test(`${overlap} applies to an interval slot arriving during a manual run`, async t => {
    const f = fixture(t);
    const engine = f.open();
    const item = await activate(engine, { overlap });
    const runNow = () => engine.runNow(item.id, item.revision, randomUUID());
    const owner = (await runNow()).run;
    const waiting = (await runNow()).run;
    f.set(5);
    await engine.tick();
    const { runs } = engine.snapshot();
    const timer = runs.find(run => run.trigger === 'timer');
    const pending = runs.find(run => run.id === waiting.id);
    assert.equal(timer.slotAt, at(5));
    assert.deepEqual([timer.status, timer.reason], expected.timer);
    assert.deepEqual([pending.status, pending.reason], expected.waiting);
    assert.deepEqual([...f.cancelled], overlap === 'replace' ? [owner.id] : []);
    assert.deepEqual(f.started.map(run => run.runId), [owner.id]);

    const result = overlap === 'replace' ? { outcome: 'cancelled', reason: 'REPLACED' } : {};
    f.finish(owner.id, result);
    await engine.tick();
    const next = [timer, pending].find(run => run.status === 'queued');
    assert.deepEqual(f.started.map(run => run.runId), next ? [owner.id, next.id] : [owner.id]);
  });
}

test('failed atomic publish leaves the prior snapshot and sequence intact', async t => {
  const f = fixture(t);
  const engine = f.open();
  fs.mkdirSync(f.file);
  try {
    await assert.rejects(engine.create(spec));
    assert.equal(engine.snapshot().seq, 0);
    assert.deepEqual(engine.snapshot().schedules, []);
    assert.deepEqual(fs.readdirSync(path.dirname(f.file)), ['schedules.json']);
    assert.equal(f.events.length, 0);
  } finally {
    fs.rmdirSync(f.file);
  }
  assert.equal((await engine.create(spec)).seq, 1);
});

test('skip blocks overlap across timer and concurrent manual requests; replay survives reload', async t => {
  const f = fixture(t);
  const engine = f.open();
  const item = await activate(engine);
  f.set(5);
  await engine.tick();
  const key = randomUUID();
  const [manual, duplicate] = await Promise.all([
    engine.runNow(item.id, item.revision, key), engine.runNow(item.id, item.revision, key),
  ]);
  assert.equal(manual.run.reason, 'OVERLAP');
  assert.equal(duplicate.run.id, manual.run.id);
  assert.equal(duplicate.replayed, true);
  assert.equal(f.started.length, 1);
  const restarted = f.open();
  const replay = await restarted.runNow(item.id, 0, key);
  assert.equal(replay.run.id, manual.run.id);
  await assert.rejects(restarted.runNow(item.id, 0, randomUUID()), { code: 'SCHEDULE_CONFLICT' });
  await assert.rejects(restarted.pause(item.id), { code: 'SCHEDULE_CONFLICT' });
});

test('editing a schedule cancels queued work and retains the running target snapshot', async t => {
  const f = fixture(t);
  const engine = f.open();
  const original = await activate(engine, { overlap: 'queue' });
  const first = await engine.runNow(original.id, original.revision, randomUUID());
  const waiting = await engine.runNow(original.id, original.revision, randomUUID());
  f.set(2);
  const { item } = await engine.update(original.id, original.revision, {
    trigger: { kind: 'interval', everyMinutes: 10 },
    target: { projectId: 'p', version: '2' },
  });
  const runs = engine.snapshot().runs;
  assert.equal(item.nextRunAt, at(12));
  assert.equal(runs.find(run => run.id === waiting.run.id).reason, 'SCHEDULE_CHANGED');
  assert.equal(runs.find(run => run.id === first.run.id).targetSnapshot.version, '1');
});

test('queue keeps one waiting run and pause cancels it without stopping the owner', async t => {
  const f = fixture(t);
  const engine = f.open();
  const item = await activate(engine, { overlap: 'queue' });
  const first = await engine.runNow(item.id, item.revision, randomUUID());
  const waiting = await engine.runNow(item.id, item.revision, randomUUID());
  const overflow = await engine.runNow(item.id, item.revision, randomUUID());
  assert.equal(waiting.run.status, 'queued');
  assert.equal(overflow.run.reason, 'QUEUE_FULL');
  f.set(4);
  const paused = await engine.pause(item.id, item.revision);
  assert.equal(engine.snapshot().runs.find(run => run.id === waiting.run.id).reason, 'PAUSED');
  assert.equal(f.cancelled.size, 0);
  f.set(20);
  f.finish(first.run.id);
  await engine.tick();
  const manual = await engine.runNow(item.id, paused.item.revision, randomUUID());
  assert.equal(f.started.at(-1).runId, manual.run.id);
  const resumed = await engine.resume(item.id, paused.item.revision);
  assert.equal(resumed.item.nextRunAt, at(25));
});

test('replace waits for confirmed termination and never cancels another schedule', async t => {
  const f = fixture(t);
  const engine = f.open();
  const first = await activate(engine, { overlap: 'replace' });
  const second = await activate(engine, { overlap: 'replace' });
  const begin = item => engine.runNow(item.id, item.revision, randomUUID());
  const running = await begin(first);
  const other = await begin(second);
  const replacement = await begin(first);
  assert.deepEqual([...f.cancelled], [running.run.id]);
  assert.equal(f.started.length, 1);
  f.evidence.set(running.run.id, { state: 'uncertain' });
  await engine.tick();
  assert.equal(engine.snapshot().runs.find(run => run.id === replacement.run.id).reason, 'WORKER_UNCERTAIN');
  assert.equal(f.started.length, 1);
  f.finish(running.run.id, { outcome: 'cancelled', reason: 'REPLACED' });
  await f.open().tick();
  assert.equal(f.started.at(-1).runId, other.run.id);
});

test('corrupt stores fail closed and history retention protects active rows and request keys', t => {
  const f = fixture(t);
  fs.writeFileSync(f.file, '{');
  assert.throws(f.open, SyntaxError);
  fs.writeFileSync(f.file, '{"schemaVersion":1,"schedules":[]}');
  assert.throws(f.open, { code: 'INVALID_SCHEDULE_STORE' });
  const runs = Array.from({ length: 205 }, (_, i) => ({
    id: String(i), scheduleId: 'schedule', status: 'succeeded', finishedAt: at(-i),
  }));
  runs.push({ id: 'old', scheduleId: 'another', status: 'failed', finishedAt: at(-31 * 1440) });
  runs.push({ id: 'active', scheduleId: 'another', status: 'running' });
  const data = { runs, schedules: [], manualRequests: {
    valid: { runId: '204', expiresAt: at(1) }, expired: { runId: 'old', expiresAt: at(0) },
  } };
  prune(data, NOW);
  assert.equal(data.runs.length, 202);
  assert.deepEqual(data.runs.slice(-2).map(run => run.id), ['204', 'active']);
  assert.equal(data.manualRequests.expired, undefined);
});

test('summaries mask sensitive values and truncate on UTF-8 boundaries', () => {
  const output = summarize(`password=private Bearer abc \"C:\\My Folder\\work\" /tmp/results secret-value\n ${'한'.repeat(1500)}`, ['secret-value']);
  for (const text of ['private', 'abc', 'Folder', '/tmp', 'secret-value', '\ufffd']) assert.ok(!output.includes(text));
  assert.ok(Buffer.byteLength(output) >= 4094 && Buffer.byteLength(output) <= 4096);
});

test('dedicated worker publishes one authenticated result across runner recreation and fences closed runs', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-schedule-worker-'));
  const runId = randomUUID();
  const closedId = randomUUID();
  const incompleteId = randomUUID();
  t.after(() => {
    for (const id of [runId, closedId, incompleteId]) {
      const dir = path.join(root, id);
      for (const file of ['dispatch.json', 'result.json', 'heartbeat.json']) fs.rmSync(path.join(dir, file), { force: true });
      if (fs.existsSync(dir)) fs.rmdirSync(dir);
    }
    fs.rmdirSync(root);
  });
  const runner = createWorkerRunner(root);
  const input = {
    cwd: root, cmd: process.execPath, env: {}, stdinText: 'prompt', timeoutMs: 10_000,
    args: ['-e', `for (const event of [
      {type: 'thread.started', thread_id: 'session-1'},
      {type: 'item.completed', item: {type: 'agent_message', text: 'Bearer secret completed'}},
      {type: 'turn.completed'},
    ]) console.log(JSON.stringify(event));`],
  };
  assert.deepEqual(runner.recover(closedId), { state: 'closed' });
  runner.start({ ...input, runId: closedId });
  assert.equal(runner.recover(closedId).state, 'closed');
  runner.start({ ...input, runId });
  runner.start({ ...input, runId });
  runner.start({ ...input, runId: incompleteId, args: ['-e', 'process.exitCode = 0;'] });
  async function waitFor(id) {
    for (let i = 0; i < 100; i++) {
      const evidence = runner.recover(id);
      if (evidence.state === 'finished') return evidence.result;
      await delay(25);
    }
    assert.fail('Worker did not publish its result');
  }
  const result = await waitFor(runId);
  assert.equal(result?.outcome, 'succeeded');
  assert.equal(result.exitCode, 0);
  assert.equal(result.sessionId, 'session-1');
  assert.equal(result.outputSummary, '[redacted] completed');
  assert.deepEqual(createWorkerRunner(root).recover(runId).result, result);
  const incomplete = await waitFor(incompleteId);
  assert.equal(incomplete.exitCode, 0);
  assert.equal(incomplete.outcome, 'failed');
  assert.equal(incomplete.reason, 'CLI_FAILED');
  runner.cleanup(new Set([runId]), Date.now() + 1000);
  assert.deepEqual(fs.readdirSync(root), [runId]);
});
