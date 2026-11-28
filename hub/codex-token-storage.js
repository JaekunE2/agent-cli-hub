'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { tokenEvent, WEEK } = require('./codex-token-events');

async function readAppend(file, saved, onEvent) {
  const stat = await fsp.stat(file);
  const cursor = saved?.birth === stat.birthtimeMs && saved.offset <= stat.size
    ? saved : { birth: stat.birthtimeMs, offset: 0, session: path.basename(file) };
  if (cursor.offset === stat.size) return cursor;
  let pending = Buffer.alloc(0);
  const stream = fs.createReadStream(file, { start: cursor.offset, end: stat.size - 1 });
  for await (const bytes of stream) {
    const data = pending.length ? Buffer.concat([pending, bytes]) : bytes;
    let start = 0;
    for (let end = data.indexOf(10); end >= 0; end = data.indexOf(10, start)) {
      const result = tokenEvent(data.toString('utf8', start, end), cursor);
      cursor.offset += end - start + 1;
      if (result) onEvent(result, cursor);
      start = end + 1;
    }
    pending = data.subarray(start);
  }
  return cursor;
}

async function readState(file) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); }
  catch (e) {
    if (e.code !== 'ENOENT') throw e;
    return { files: {}, events: {}, windows: {}, collectedAt: null };
  }
}

async function rolloutRoots(homes) {
  const roots = new Set();
  for (const home of homes) {
    for (const name of ['sessions', 'archived_sessions']) {
      try { roots.add(await fsp.realpath(path.join(home, name))); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
  }
  return roots;
}

async function saveState(file, state) {
  const tmp = file + '.' + process.pid + '.tmp';
  try {
    await fsp.writeFile(tmp, JSON.stringify(state), { mode: 0o600 });
    await fsp.rename(tmp, file);
  } finally {
    await fsp.unlink(tmp).catch(e => { if (e.code !== 'ENOENT') throw e; });
  }
}

async function restoreWeeklyObservations(state, now = Date.now()) {
  if (state.weeklyObservationsReady) return false;
  if (!Object.keys(state.events).length) { state.weeklyObservationsReady = true; return false; }
  for (const file of Object.keys(state.files)) {
    try {
      if ((await fsp.stat(file)).mtimeMs < now - WEEK * 1000) continue;
      await readAppend(file, null, ({ key, row }) => {
        if (row && Number.isFinite(row.weeklyUsed) && state.events[key]?.reset === row.reset) {
          state.events[key].weeklyUsed = row.weeklyUsed;
        }
      });
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  state.weeklyObservationsReady = true;
  return true;
}

module.exports = { readAppend, rolloutRoots, readState, saveState, restoreWeeklyObservations };
