'use strict';

const fs = require('fs');
const path = require('path');
const { readAppend, saveState } = require('./codex-token-storage');
const { accountFor, recordWindows } = require('./codex-token-report');

function watchRollouts({ roots, state, file, getUsage, onError, ready = Promise.resolve() }) {
  const observing = new Map();
  const queued = new Set();
  const lookedUp = new Map();
  let timer, running = ready, dirty = false;

  async function drain(files) {
    const unknown = new Set();
    for (const rollout of files) {
      const item = observing.get(rollout) || { pending: new Map(), cursor: state.files[rollout] };
      observing.set(rollout, item);
      try {
        item.cursor = await readAppend(rollout, item.cursor && { ...item.cursor }, (event, cursor) => {
          if (event.key && event.turn) {
            const rows = item.pending.get(event.turn) || [];
            rows.push(event);
            item.pending.set(event.turn, rows);
            return;
          }
          const rows = item.pending.get(event.ended);
          item.pending.delete(event.ended);
          if (!event.completed || !rows?.length) return;
          for (const { key, row } of rows) {
            const previous = state.events[key];
            if (previous && (previous.reset || !row.reset)) continue;
            state.events[key] = row;
            if (row.reset * 1000 > Date.now() && !accountFor(state, row)) unknown.add(row.reset);
          }
          state.files[rollout] = { ...cursor };
          dirty = true;
        });
      } catch (e) {
        if (e.code === 'ENOENT') observing.delete(rollout);
        else onError(e);
      }
    }
    if (dirty) {
      state.collectedAt = new Date().toISOString();
      await saveState(file, state);
      dirty = false;
    }
    const missing = [...unknown].filter(reset => Date.now() - (lookedUp.get(reset) || 0) > 60_000);
    if (!getUsage || !missing.length) return;
    for (const reset of missing) lookedUp.set(reset, Date.now());
    recordWindows(state, await getUsage());
    await saveState(file, state);
  }

  const watchers = [];
  try {
    for (const root of roots) {
      watchers.push(fs.watch(root, { recursive: true }, (_, name) => {
        if (!name || !/^rollout-.*\.jsonl$/i.test(path.basename(name))) return;
        queued.add(path.join(root, name));
        if (timer) return;
        timer = setTimeout(() => {
          timer = null;
          const files = [...queued];
          queued.clear();
          running = running.then(() => drain(files)).catch(onError);
        }, 80);
      }).on('error', onError));
    }
  } catch (e) {
    for (const watcher of watchers) watcher.close();
    throw e;
  }
  return async () => {
    for (const watcher of watchers) watcher.close();
    clearTimeout(timer);
    await running;
  };
}

module.exports = { watchRollouts };
