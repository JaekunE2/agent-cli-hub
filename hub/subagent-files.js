'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { transcriptEvents } = require('./subagent-events');
const safeId = id => typeof id === 'string' && /^[\w-]{1,100}$/.test(id);
const safeTermId = id => /^\d+$/.test(String(id || ''));

function parentSession(hub, term) {
  if (!term) return null;
  if (term._subagentSessionId) return term._subagentSessionId;
  const agent = hub.agentOf?.(term);
  const claude = term.meta?.envFlags?.CLAUDE_CONFIG_DIR || hub.claudeDir;
  if (claude && term.pid && agent === 'claude') {
    const file = path.join(claude, 'sessions', `${term.pid}.json`);
    try {
      const { sessionId } = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (safeId(sessionId)) return sessionId;
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
  }
  const args = term.meta?.args || [];
  const pos = args.indexOf('--session-id');
  return hub.termSessionId?.(term) || (pos !== -1 && args[pos + 1])
    || (agent === 'codex' && hub.codexSessionOf?.(term)) || (agent === 'agy' && hub.agySessionOf?.(term)) || null;
}

function existing(file, root) {
  try {
    if (root) {
      const relative = path.relative(root, file);
      if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return null;
      file = path.join(fs.realpathSync(root), relative);
    }
    const real = fs.realpathSync(file);
    const normalize = value => process.platform === 'win32' ? value.toLowerCase() : value;
    return normalize(real) === normalize(file) && fs.statSync(real).isFile() ? file : null;
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    return null;
  }
}

function transcriptFile(hub, id, term) {
  if (!safeId(id)) return null;
  const claudeRoot = term?.meta?.envFlags?.CLAUDE_CONFIG_DIR || hub.claudeDir;
  const claude = claudeRoot && path.resolve(claudeRoot, 'projects');
  const home = term?.meta?.envFlags?.CODEX_HOME;
  const root = home ? path.resolve(home, 'sessions') : hub.index?.codexRoot;
  const agy = [].concat(hub.index?.agyRoot || []);
  const doc = hub.index?.get(id);
  if (doc?.file) {
    const file = path.resolve(doc.file);
    const roots = [claude, hub.index?.root, root, hub.index?.codexRoot, ...agy].filter(Boolean);
    for (const dir of roots.length ? roots : [null]) {
      const found = existing(file, dir);
      if (found) return found;
    }
  }
  for (const dir of claude && fs.existsSync(claude) ? fs.readdirSync(claude) : []) {
    const file = existing(path.join(claude, dir, id + '.jsonl'), claude);
    if (file) return file;
  }
  for (const agyRoot of agy) {
    const dir = path.resolve(agyRoot, id, '.system_generated', 'logs');
    const file = existing(path.join(dir, 'transcript_full.jsonl'), agyRoot) || existing(path.join(dir, 'transcript.jsonl'), agyRoot);
    if (file) return file;
  }
  const now = Date.now();
  for (const ms of [now, now - 86_400_000, term?.startedAt, term?.startedAt && term.startedAt - 86_400_000].filter(Boolean)) {
    if (!root) break;
    const date = new Date(ms);
    const dir = path.join(root, String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'));
    const name = (fs.existsSync(dir) ? fs.readdirSync(dir) : []).find(name => name.startsWith('rollout-') && name.endsWith(`-${id}.jsonl`));
    if (name) return existing(path.resolve(dir, name), root);
  }
  return null;
}

function readEvents(file, cursor, consume, limit = 2_000_000, fromStart = false) {
  if (!file) return;
  let fd;
  try { fd = fs.openSync(file, 'r'); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  try {
    const st = fs.fstatSync(fd);
    if (cursor.size > st.size || cursor.ino !== st.ino) cursor.offset = 0;
    if (cursor.size === st.size && cursor.mtime === st.mtimeMs && cursor.ino === st.ino) return;
    Object.assign(cursor, { ino: st.ino, size: st.size, mtime: st.mtimeMs });
    const start = fromStart ? 0 : Math.max(cursor.offset || 0, st.size - limit);
    const bytes = Buffer.alloc(fromStart ? Math.min(limit, st.size) : st.size - start);
    const count = fs.readSync(fd, bytes, 0, bytes.length, start);
    let from = start && start !== cursor.offset ? bytes.indexOf(10) + 1 || count : 0;
    for (let end; from < count && (end = bytes.indexOf(10, from)) >= 0 && end < count; from = end + 1) {
      const line = bytes.toString('utf8', from, end).trim();
      if (!line) continue;
      let row;
      try { row = JSON.parse(line); }
      catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        continue;
      }
      if (row && typeof row === 'object') for (const event of transcriptEvents(row)) consume(event);
    }
    cursor.offset = start + from;
  } finally { fs.closeSync(fd); }
}

module.exports = { existing, transcriptFile, readEvents, safeId, safeTermId, parentSession };
