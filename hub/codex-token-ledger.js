'use strict';

const fs = require('fs').promises;
const path = require('path');
const CA = require('./codex-accounts');
const { rolloutRoots, readState, saveState, restoreWeeklyObservations } = require('./codex-token-storage');
const { reportTokens } = require('./codex-token-report');
const { estimatesFor } = require('./codex-token-estimate');
const { watchRollouts } = require('./codex-token-watcher');

const FILE = path.join(__dirname, 'data', 'codex-cli-tokens.json');

async function lock(file) {
  const lockPath = file + '.lock';
  try {
    await fs.writeFile(lockPath, String(process.pid), { flag: 'wx', mode: 0o600 });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const pid = Number(await fs.readFile(lockPath, 'utf8').catch(() => ''));
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    try { process.kill(pid, 0); return null; }
    catch (cause) { if (cause.code !== 'ESRCH') return null; }
    // Leave the previous lock in place until its owner is confirmed gone.
    await fs.unlink(lockPath).catch(cause => { if (cause.code !== 'ENOENT') throw cause; });
    return lock(file);
  }
  return () => fs.unlink(lockPath);
}

async function watchCodexTokens({ usageDir, getUsage, onError = console.error, file = FILE, homes }) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const unlock = await lock(file);
  if (!unlock) return null;
  try {
    const state = await readState(file);
    const roots = await rolloutRoots(homes || [CA.MAIN, process.env.CODEX_HOME,
      ...CA.accounts(usageDir).map(a => a.home)].filter(Boolean));
    if (!roots.size) { await unlock(); return null; }
    const restore = restoreWeeklyObservations(state).then(restored => restored && saveState(file, state)).catch(onError);
    const stop = watchRollouts({ roots, state, file, getUsage, onError, ready: restore });
    return async () => { try { await stop(); } finally { await unlock(); } };
  } catch (e) {
    await unlock();
    throw e;
  }
}

async function readTokens(options, file = FILE) {
  const state = await readState(file);
  const report = reportTokens(state, options);
  if (options?.week) report.estimates = estimatesFor(report.groups, state.windows, options.now);
  return report;
}

let turnIndex;
async function readTurnTokens(ids, file = FILE) {
  if (!ids.length) return {};
  const stat = await fs.stat(file).catch(e => { if (e.code !== 'ENOENT') throw e; return null; });
  if (!stat) return {};
  const signature = [file, stat.ino, stat.mtimeMs, stat.size].join(':');
  if (turnIndex?.signature !== signature) {
    const state = await readState(file);
    const turns = new Map();
    for (const [key, row] of Object.entries(state.events)) {
      const [, turn] = JSON.parse(key);
      if (!turns.has(turn)) turns.set(turn, []);
      turns.get(turn).push(row);
    }
    turnIndex = { signature, turns, state };
  }
  const { turns, state } = turnIndex;
  return Object.fromEntries([...new Set(ids)].filter(id => turns.has(id)).map(id => [
    id, reportTokens({ windows: state.windows, events: turns.get(id) }).groups,
  ]));
}

module.exports = { watchCodexTokens, readTokens, readTurnTokens };
