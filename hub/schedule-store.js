'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const DAY = 86_400_000;
const active = run => ['queued', 'starting', 'running'].includes(run.status);
const unique = rows => new Set(rows).size === rows.length;
const dated = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

function read(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function publish(file, value, install = fs.renameSync, ensureDirectory = true) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  if (ensureDirectory) fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(tmp, JSON.stringify(value), { flag: 'wx', mode: 0o600, flush: true });
    install(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function prune(data, now) {
  for (const [key, request] of Object.entries(data.manualRequests)) {
    if (Date.parse(request.expiresAt) <= now) delete data.manualRequests[key];
  }
  const pinned = new Set(Object.values(data.manualRequests).map(request => request.runId));
  const counts = new Map();
  const terminal = data.runs.filter(run => !active(run) && run.reason !== 'WORKER_UNCERTAIN');
  terminal.sort((a, b) => Date.parse(b.finishedAt) - Date.parse(a.finishedAt));
  const expired = new Set();
  for (const run of terminal) {
    const count = counts.get(run.scheduleId) || 0;
    counts.set(run.scheduleId, count + 1);
    if (!pinned.has(run.id) && (count >= 200 || Date.parse(run.finishedAt) <= now - 30 * DAY)) expired.add(run.id);
  }
  data.runs = data.runs.filter(run => !expired.has(run.id));
  const used = new Set(data.runs.map(run => run.scheduleId));
  data.schedules = data.schedules.filter(item => item.state !== 'archived' || used.has(item.id));
}

function openStore(file) {
  const loaded = read(file);
  let data = loaded === undefined ? { schemaVersion: 1, seq: 0, schedules: [], runs: [], manualRequests: {} } : loaded;
  if (data?.schemaVersion !== 1 || !Number.isSafeInteger(data.seq) || data.seq < 0 ||
      !Array.isArray(data.schedules) || !Array.isArray(data.runs) ||
      !data.manualRequests || typeof data.manualRequests !== 'object' || Array.isArray(data.manualRequests) ||
      !validRows(data)) {
    throw Object.assign(new Error('Invalid schedule store'), { code: 'INVALID_SCHEDULE_STORE' });
  }
  return {
    snapshot: () => structuredClone(data),
    commit(next) {
      next.seq = data.seq + 1;
      publish(file, next);
      data = structuredClone(next);
      return data.seq;
    },
  };
}

function validRows({ schedules, runs, manualRequests }) {
  if (schedules.some(item => !item?.id || !Number.isSafeInteger(item.revision) || item.revision < 1 ||
      !['paused', 'active', 'archived'].includes(item.state) || !item.target ||
      !item.trigger || (item.state === 'active' && !dated(item.nextRunAt)))) return false;
  const scheduleIds = schedules.map(item => item.id);
  const ids = new Set(scheduleIds);
  if (runs.some(run => !run?.id || !ids.has(run.scheduleId) || !['manual', 'timer'].includes(run.trigger) || !dated(run.slotAt) ||
      (!active(run) && (!['succeeded', 'failed', 'skipped', 'cancelled', 'interrupted'].includes(run.status) || !dated(run.finishedAt))))) {
    return false;
  }
  const runIds = runs.map(run => run.id);
  const knownRuns = new Set(runIds);
  return unique(scheduleIds) && unique(runIds) &&
    unique(runs.filter(run => run.trigger === 'timer').map(run => `${run.scheduleId}:${run.slotAt}`)) &&
    runs.filter(run => ['starting', 'running'].includes(run.status) ||
      (run.status === 'interrupted' && run.reason === 'WORKER_UNCERTAIN')).length <= 1 &&
    Object.values(manualRequests).every(request => knownRuns.has(request?.runId) && dated(request.expiresAt));
}

module.exports = { active, openStore, prune, publish, read };
