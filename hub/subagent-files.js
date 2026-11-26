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
  if (doc?.file && !/\.db$/i.test(doc.file)) {
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
  const agyBrains = new Set();
  for (const agyRoot of agy) {
    agyBrains.add(agyRoot);
    agyBrains.add(path.resolve(agyRoot, '..', 'brain'));
  }
  const os = require('node:os');
  for (const appName of ['antigravity-cli', 'antigravity']) {
    agyBrains.add(path.join(os.homedir(), '.gemini', appName, 'brain'));
  }
  for (const agyRoot of agyBrains) {
    if (!fs.existsSync(agyRoot)) continue;
    const dir = path.resolve(agyRoot, id, '.system_generated', 'logs');
    const file = existing(path.join(dir, 'transcript_full.jsonl'), agyRoot) || existing(path.join(dir, 'transcript.jsonl'), agyRoot);
    if (file) return file;
  }
  const now = Date.now();
  const checkedDirs = new Set();
  for (const ms of [now, now - 86_400_000, now + 86_400_000, term?.startedAt, term?.startedAt && term.startedAt - 86_400_000].filter(Boolean)) {
    if (!root) break;
    const date = new Date(ms);
    for (const parts of [
      [String(date.getUTCFullYear()), String(date.getUTCMonth() + 1).padStart(2, '0'), String(date.getUTCDate()).padStart(2, '0')],
      [String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')],
    ]) {
      const dir = path.join(root, ...parts);
      if (checkedDirs.has(dir)) continue;
      checkedDirs.add(dir);
      const name = (fs.existsSync(dir) ? fs.readdirSync(dir) : []).find(name => name.startsWith('rollout-') && name.endsWith(`-${id}.jsonl`));
      if (name) return existing(path.resolve(dir, name), root);
    }
  }
  if (root && fs.existsSync(root)) {
    let scanned = 0;
    const years = fs.readdirSync(root).filter(n => /^\d{4}$/.test(n)).sort().reverse();
    for (const y of years) {
      const yDir = path.join(root, y);
      let months; try { months = fs.readdirSync(yDir).filter(n => /^\d{2}$/.test(n)).sort().reverse(); } catch { continue; }
      for (const m of months) {
        const mDir = path.join(yDir, m);
        let days; try { days = fs.readdirSync(mDir).filter(n => /^\d{2}$/.test(n)).sort().reverse(); } catch { continue; }
        for (const d of days) {
          const dir = path.join(mDir, d);
          if (checkedDirs.has(dir)) continue;
          checkedDirs.add(dir);
          if (++scanned > 90) break;
          let names; try { names = fs.readdirSync(dir); } catch { continue; }
          const name = names.find(n => n.startsWith('rollout-') && n.endsWith(`-${id}.jsonl`));
          if (name) return existing(path.resolve(dir, name), root);
        }
        if (scanned > 90) break;
      }
      if (scanned > 90) break;
    }
  }
  return null;
}

const FAST_SUBAGENT_RE = /(?:"(?:Agent|Task|spawn_agent|invoke_subagent|swarm|wait_agent|send_input|close_agent|SubAgentActivity|agent_message|turn_aborted|task_complete|turn_complete|tool_result|function_call_output|custom_tool_call_output|TOOL_RESULT|FUNCTION_RESULT|GENERIC|INVOKE_SUBAGENT|SYSTEM_MESSAGE)"|conversationId|task-notification|<task-id>|Subagent\s+[\w-]{8,}|FINAL_ANSWER)/;

function parseLinesChunk(text, consume, prefilter) {
  for (let from = 0; from < text.length; ) {
    const end = text.indexOf('\n', from);
    const line = (end >= 0 ? text.slice(from, end) : text.slice(from)).trim();
    from = end >= 0 ? end + 1 : text.length;
    if (!line || (prefilter && !FAST_SUBAGENT_RE.test(line))) continue;
    let row;
    try { row = JSON.parse(line); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      continue;
    }
    if (row && typeof row === 'object') for (const event of transcriptEvents(row)) consume(event);
  }
}

function readEvents(file, cursor, consume, limit = 2_000_000, fromStart = false, opts = {}) {
  if (!file) return;
  let fd;
  try { fd = fs.openSync(file, 'r'); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  try {
    const st = fs.fstatSync(fd);
    if (cursor.size > st.size || cursor.ino !== st.ino) cursor.offset = 0;
    if (cursor.size === st.size && cursor.mtime === st.mtimeMs && cursor.ino === st.ino) return;
    Object.assign(cursor, { ino: st.ino, size: st.size, mtime: st.mtimeMs });
    if (opts.fastScan && !fromStart && !cursor.offset && st.size > limit) {
      const CHUNK = 1024 * 1024;
      const tailStart = Math.max(0, st.size - limit);
      const buf = Buffer.alloc(CHUNK);
      let pos = 0;
      let carry = Buffer.alloc(0);
      while (pos < st.size) {
        const toRead = Math.min(CHUNK, st.size - pos);
        const n = fs.readSync(fd, buf, 0, toRead, pos);
        if (n <= 0) break;
        const view = buf.subarray(0, n);
        const lastNl = view.lastIndexOf(10);
        const usePrefilter = pos + n < tailStart;
        if (lastNl >= 0) {
          const head = view.subarray(0, lastNl + 1);
          const full = carry.length ? Buffer.concat([carry, head]) : head;
          parseLinesChunk(full.toString('utf8'), consume, usePrefilter);
          carry = Buffer.from(view.subarray(lastNl + 1));
          cursor.offset = pos + lastNl + 1;
        } else {
          carry = carry.length + n <= 4_000_000 ? Buffer.concat([carry, view]) : Buffer.alloc(0);
        }
        pos += n;
      }
      return;
    }
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
