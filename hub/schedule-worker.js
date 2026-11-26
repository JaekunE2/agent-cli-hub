'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { read, publish } = require('./schedule-store');
const { summarize, codexOutput } = require('./schedule-result');

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const stamp = () => new Date().toISOString();
const HEARTBEAT = 5_000;
const LIVE_FOR = 30_000;

function claim(file, value, ensureDirectory = true) {
  try {
    publish(file, value, fs.linkSync, ensureDirectory);
    return true;
  } catch (error) {
    if (error.code === 'EEXIST' || (!ensureDirectory && error.code === 'ENOENT')) return false;
    throw error;
  }
}

function createWorkerRunner(root) {
  const children = new Map();
  function dirFor(id) {
    if (!UUID.test(id)) throw new Error('Invalid schedule run ID');
    return path.resolve(root, id);
  }
  return {
    start(spec) {
      const dir = dirFor(spec.runId);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (read(path.join(dir, 'dispatch.json')) || children.has(spec.runId)) return;
      const input = JSON.stringify(spec);
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'NODE_OPTIONS'));
      const child = spawn(process.execPath, [__filename, dir], {
        detached: true, windowsHide: true, stdio: ['pipe', 'ignore', 'inherit'], env,
      });
      children.set(spec.runId, child);
      child.once('error', () => children.delete(spec.runId));
      child.once('exit', () => children.delete(spec.runId));
      child.stdin.on('error', () => {});
      child.stdin.end(input);
      child.unref();
    },
    recover(id) {
      const dir = dirFor(id);
      const file = path.join(dir, 'dispatch.json');
      let dispatch = read(file);
      if (!dispatch && children.has(id)) return { state: 'starting' };
      if (!dispatch) {
        claim(file, { state: 'closed', runId: id, at: stamp() });
        dispatch = read(file);
      }
      if (dispatch.runId !== id) throw new Error('Schedule dispatch identity mismatch');
      if (dispatch.state === 'closed') return { state: 'closed' };
      if (dispatch.state !== 'claimed' || !UUID.test(dispatch.token) || !Number.isInteger(dispatch.pid) ||
          dispatch.pid < 1 || dispatch.worker !== __filename || !Number.isFinite(Date.parse(dispatch.startedAt))) {
        throw new Error('Invalid schedule worker claim');
      }
      const result = read(path.join(dir, 'result.json'));
      if (result) {
        if (result.runId !== id || result.token !== dispatch.token ||
            !['succeeded', 'failed', 'cancelled'].includes(result.outcome) || !Number.isFinite(Date.parse(result.finishedAt))) {
          throw new Error('Invalid schedule worker result');
        }
        return { state: 'finished', result };
      }
      const heartbeat = read(path.join(dir, 'heartbeat.json'));
      const lastSeen = heartbeat?.token === dispatch.token ? heartbeat.at : dispatch.startedAt;
      if (Date.now() - Date.parse(lastSeen) > LIVE_FOR) return { state: 'uncertain' };
      // Checking existence cannot authenticate a reused PID. Only result evidence releases the slot.
      try { process.kill(dispatch.pid, 0); }
      catch (error) {
        if (error.code === 'ESRCH') return { state: 'uncertain' };
        throw error;
      }
      return { state: 'running', startedAt: dispatch.startedAt };
    },
    requestCancel(id) {
      const dir = dirFor(id);
      const file = path.join(dir, 'dispatch.json');
      const dispatch = read(file);
      if (!dispatch && claim(file, { state: 'closed', runId: id, at: stamp() })) return;
      const owner = dispatch || read(file);
      if (owner?.state === 'claimed' && owner.runId === id && UUID.test(owner.token)) {
        const cancelFile = path.join(dir, 'cancel.json');
        if (!read(cancelFile)) publish(cancelFile, { runId: id, token: owner.token });
      }
    },
    cleanup(ids, before) {
      let entries;
      try { entries = fs.readdirSync(root, { withFileTypes: true }); }
      catch (error) { if (error.code === 'ENOENT') return; throw error; }
      for (const entry of entries) {
        const id = entry.name.replace(/^expired-/, '');
        if (!entry.isDirectory() || !UUID.test(id) || ids.has(id)) continue;
        const expired = path.resolve(root, `expired-${id}`);
        if (entry.name === id) {
          const dir = dirFor(id);
          const dispatch = read(path.join(dir, 'dispatch.json'));
          const result = read(path.join(dir, 'result.json'));
          const finished = result?.runId === id && result.token === dispatch?.token && UUID.test(result.token);
          const closed = dispatch?.runId === id && dispatch.state === 'closed';
          if (!(finished || closed) || !(Date.parse(finished ? result.finishedAt : dispatch.at) <= before)) continue;
          // Move the closed fence as a unit so a delayed worker cannot claim while it is removed.
          try { fs.renameSync(dir, expired); }
          catch (error) {
            if (['EBUSY', 'EPERM', 'EACCES'].includes(error.code)) continue;
            throw error;
          }
        }
        const files = fs.readdirSync(expired);
        const owned = /^(?:cancel|heartbeat|result|dispatch)\.json(?:\.[0-9a-f-]{36}\.tmp)?$/i;
        if (!files.every(file => owned.test(file))) continue;
        for (const file of files) fs.rmSync(path.join(expired, file), { force: true });
        fs.rmdirSync(expired);
      }
    },
  };
}

async function worker(dir) {
  const spec = JSON.parse(await require('node:stream/consumers').text(process.stdin));
  if (!UUID.test(spec.runId) || path.basename(dir) !== spec.runId) throw new Error('Invalid worker input');
  const token = randomUUID();
  const startedAt = stamp();
  if (!claim(path.join(dir, 'dispatch.json'), {
    runId: spec.runId, token, state: 'claimed', pid: process.pid, startedAt, worker: __filename,
  }, false)) return;

  const output = codexOutput();
  const child = spawn(spec.cmd, spec.args, { cwd: spec.cwd, env: spec.env, windowsHide: true });
  let reason = null;
  let stderr = '';
  let launchError = null;
  function stop(why) {
    if (reason || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
    reason = why;
    child.kill('SIGTERM');
  }
  const timeout = setTimeout(() => stop('TIMEOUT'), spec.timeoutMs);
  const heartbeat = setInterval(() => {
    try { publish(path.join(dir, 'heartbeat.json'), { token, at: stamp() }); }
    catch (cause) { report(cause); }
  }, HEARTBEAT);
  const cancel = setInterval(() => {
    try {
      const request = read(path.join(dir, 'cancel.json'));
      if (request?.runId === spec.runId && request.token === token) stop('REPLACED');
    } catch (cause) { report(cause); }
  }, 250);
  child.stdout.setEncoding('utf8').on('data', chunk => output.feed(chunk));
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
  child.on('error', error => { launchError = error; });
  child.stdin.on('error', error => { if (error.code !== 'EPIPE') launchError = error; });
  child.stdin.end(spec.stdinText);
  const exitCode = await new Promise(resolve => child.once('close', resolve));
  clearTimeout(timeout);
  clearInterval(heartbeat);
  clearInterval(cancel);
  output.feed('\n');
  const { completed, failed, sessionId, outputSummary, errorSummary } = output.result;
  if (!reason && (exitCode !== 0 || launchError || failed || !completed)) reason = 'CLI_FAILED';
  const sensitive = [
    spec.stdinText, spec.cwd, ...(spec.sensitive || []),
    ...Object.entries(spec.env || {}).filter(([name]) => /token|key|secret|password|credential/i.test(name)).map(([, value]) => value),
  ];
  publish(path.join(dir, 'result.json'), {
    runId: spec.runId, token, startedAt, finishedAt: stamp(), exitCode, sessionId, reason,
    outcome: reason === 'REPLACED' ? 'cancelled' : reason ? 'failed' : 'succeeded',
    outputSummary: summarize(outputSummary, sensitive),
    errorSummary: summarize(errorSummary || launchError?.message || stderr, sensitive),
  });
}

function report(cause) {
  const code = /^[A-Z][A-Z0-9_]+$/.test(cause.code || '') ? cause.code : 'WORKER_ERROR';
  console.error('[schedule-worker]', path.basename(process.argv[2] || ''), code);
}

if (require.main === module) worker(process.argv[2]).catch(cause => {
  report(cause);
  process.exitCode = 1;
});

module.exports = { createWorkerRunner };
