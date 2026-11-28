'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { toolName, spawnTools } = require('./subagent-events');

const MAX_EVENTS = 250;

function safeKey(raw) {
  return String(raw || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
}

/** Fold consecutive identical tool beats into { ...item, count } without dropping order. */
function foldToolEvents(events) {
  const out = [];
  for (const ev of events || []) {
    if (!ev || !ev.tool) continue;
    const prev = out[out.length - 1];
    const sameKey = prev
      && prev.tool === ev.tool
      && (prev.target || '') === (ev.target || '')
      && (prev.subagentId || '') === (ev.subagentId || '');
    if (sameKey) {
      // Collapse PreToolUse -> PostToolUse pair into a single completed beat
      if (prev.status === 'start' && ev.status !== 'start') {
        prev.status = ev.status;
        prev.ts = ev.ts;
        continue;
      }
      prev.count = (prev.count || 1) + 1;
      prev.ts = ev.ts;
      prev.status = ev.status || prev.status;
      continue;
    }
    out.push({ ...ev, count: ev.count || 1 });
  }
  return out;
}

function readJsonlTail(file, maxBytes = 128 * 1024) {
  if (!file || !fs.existsSync(file)) return [];
  try {
    const st = fs.statSync(file);
    const start = Math.max(0, st.size - maxBytes);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(st.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    let txt = buf.toString('utf8');
    if (start > 0) {
      const nl = txt.indexOf('\n');
      txt = nl >= 0 ? txt.slice(nl + 1) : '';
    }
    const items = [];
    for (const line of txt.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { items.push(JSON.parse(line)); } catch {}
    }
    return items.slice(-MAX_EVENTS);
  } catch {
    return [];
  }
}

function pickToolTarget(input) {
  if (!input || typeof input !== 'object') return '';
  return String(
    input.file_path || input.path || input.target_file || input.notebook_path
    || input.command || input.pattern || input.query || input.url
    || input.description || input.prompt || ''
  ).replace(/\s+/g, ' ').trim().slice(0, 180);
}

function findTranscriptPath(claudeDir, sessionId) {
  if (!claudeDir || !sessionId) return null;
  const root = path.join(claudeDir, 'projects');
  if (!fs.existsSync(root)) return null;
  for (const d of fs.readdirSync(root)) {
    const p = path.join(root, d, `${sessionId}.jsonl`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function hydrateToolsFromTranscript(claudeDir, sessionId) {
  const file = findTranscriptPath(claudeDir, sessionId);
  if (!file) return [];
  const rows = readJsonlTail(file, 256 * 1024);
  const events = [];
  for (const r of rows) {
    const ts = r.timestamp ? Date.parse(r.timestamp) || Date.now() : Date.now();
    const content = r.message?.content;
    if (!Array.isArray(content)) continue;
    for (const blk of content) {
      if (blk?.type === 'tool_use' && blk.name) {
        events.push({
          ts,
          sessionId,
          tool: String(blk.name).slice(0, 80),
          target: pickToolTarget(blk.input),
          status: 'done',
          fromTranscript: true,
        });
      }
    }
  }
  return events.slice(-MAX_EVENTS);
}

/** Create side-channel Tool Hook collector, folder watcher, and WS broadcaster. */
function createToolHooks(hub, onSubagent = () => {}) {
  const hookDir = path.join(hub.baseDir, 'data', 'hooks');
  fs.mkdirSync(hookDir, { recursive: true });

  const clientsByKey = new Map(); // key -> Set<WebSocket>
  const fileOffsets = new Map(); // filename -> size

  function subscribe(key, ws) {
    if (!clientsByKey.has(key)) clientsByKey.set(key, new Set());
    clientsByKey.get(key).add(ws);
    ws.on('close', () => {
      const set = clientsByKey.get(key);
      if (set) {
        set.delete(ws);
        if (!set.size) clientsByKey.delete(key);
      }
    });
  }

  function broadcastForKey(key, payload) {
    if (spawnTools.test(toolName(payload.event.tool))) onSubagent(payload.event);
    const msg = JSON.stringify(payload);
    for (const k of [key, 'all']) {
      const set = clientsByKey.get(k);
      if (!set) continue;
      for (const ws of set) {
        if (ws.readyState === 1) ws.send(msg);
      }
    }
  }

  function recordEvent(ev) {
    if (!ev || !ev.tool) return null;
    const entry = {
      ts: Number(ev.ts) || Date.now(),
      termId: ev.termId ? String(ev.termId) : undefined,
      sessionId: ev.sessionId ? String(ev.sessionId) : undefined,
      tool: String(ev.tool).slice(0, 80),
      target: String(ev.target || '').slice(0, 180),
      status: ['start', 'done', 'error'].includes(ev.status) ? ev.status : 'done',
      ...(ev.callId ? { callId: String(ev.callId).slice(0, 200), input: ev.input, output: ev.output } : {}),
      ...(ev.subagentId ? { subagentId: String(ev.subagentId).slice(0, 64) } : {}),
    };
    const line = JSON.stringify(entry) + '\n';
    if (entry.termId) {
      const f = path.join(hookDir, `term-${safeKey(entry.termId)}.jsonl`);
      fs.appendFileSync(f, line, 'utf8');
      fileOffsets.set(path.basename(f), fs.statSync(f).size);
      broadcastForKey(`term:${entry.termId}`, { type: 'hook-event', event: entry });
    }
    if (entry.sessionId) {
      const f = path.join(hookDir, `sid-${safeKey(entry.sessionId)}.jsonl`);
      fs.appendFileSync(f, line, 'utf8');
      fileOffsets.set(path.basename(f), fs.statSync(f).size);
      broadcastForKey(`sid:${entry.sessionId}`, { type: 'hook-event', event: entry });
    }
    return entry;
  }

  function scanFileDelta(filename) {
    if (!filename || !filename.endsWith('.jsonl')) return;
    const full = path.join(hookDir, filename);
    if (!fs.existsSync(full)) return;
    let st;
    try { st = fs.statSync(full); } catch { return; }
    const prev = fileOffsets.get(filename) || 0;
    if (st.size <= prev) {
      if (st.size < prev) fileOffsets.set(filename, st.size);
      return;
    }
    const fd = fs.openSync(full, 'r');
    const buf = Buffer.alloc(st.size - prev);
    fs.readSync(fd, buf, 0, buf.length, prev);
    fs.closeSync(fd);
    fileOffsets.set(filename, st.size);

    const key = filename.startsWith('term-')
      ? `term:${filename.slice(5, -6)}`
      : filename.startsWith('sid-')
        ? `sid:${filename.slice(4, -6)}`
        : 'global';
    for (const line of buf.toString('utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line);
        broadcastForKey(key, { type: 'hook-event', event: ev });
      } catch {}
    }
  }

  // Initialize offsets for existing files so we only broadcast new events
  try {
    for (const f of fs.readdirSync(hookDir)) {
      if (f.endsWith('.jsonl')) fileOffsets.set(f, fs.statSync(path.join(hookDir, f)).size);
    }
  } catch {}

  let watcher = null;
  try {
    watcher = fs.watch(hookDir, (_, filename) => {
      if (filename) scanFileDelta(String(filename));
    });
    watcher.unref?.();
  } catch {}

  function getEvents({ termId = '', sessionId = '' } = {}) {
    let raw = [];
    if (termId) {
      raw = raw.concat(readJsonlTail(path.join(hookDir, `term-${safeKey(termId)}.jsonl`)));
    }
    if (sessionId) {
      const sidEvents = readJsonlTail(path.join(hookDir, `sid-${safeKey(sessionId)}.jsonl`));
      if (!raw.length) raw = sidEvents;
      else if (sidEvents.length) {
        const seen = new Set(raw.map((e) => `${e.ts}:${e.tool}:${e.target}`));
        for (const e of sidEvents) {
          if (!seen.has(`${e.ts}:${e.tool}:${e.target}`)) raw.push(e);
        }
        raw.sort((a, b) => (a.ts || 0) - (b.ts || 0));
      }
    }
    let source = 'hook';
    if (!raw.length && sessionId) {
      raw = hydrateToolsFromTranscript(hub.claudeDir, sessionId);
      source = raw.length ? 'transcript' : 'none';
    } else if (!raw.length) {
      source = 'none';
    }
    const trimmed = raw.slice(-MAX_EVENTS);
    return {
      ok: true,
      source,
      rawCount: trimmed.length,
      events: foldToolEvents(trimmed),
    };
  }

  function getSubagentEvents({ termId, sessionId }) {
    const files = [termId && `term-${safeKey(termId)}`, sessionId && `sid-${safeKey(sessionId)}`];
    return files.filter(Boolean).flatMap(file => readJsonlTail(path.join(hookDir, file + '.jsonl')))
      .filter(e => e.callId && spawnTools.test(toolName(e.tool))).sort((a, b) => a.ts - b.ts);
  }

  function getHookSnippet() {
    const scriptPath = path.join(hub.baseDir, 'hook-reporter.js');
    const cmd = `node "${scriptPath.replace(/\\/g, '/')}"`;
    return {
      scriptPath,
      command: cmd,
      claudeSettings: {
        hooks: {
          PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: cmd }] }],
          PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: cmd }] }],
        },
      },
    };
  }

  function installClaudeHook() {
    const claudeSettingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(claudeSettingsPath), { recursive: true });
    let current = {};
    if (fs.existsSync(claudeSettingsPath)) {
      const raw = fs.readFileSync(claudeSettingsPath, 'utf8');
      fs.writeFileSync(claudeSettingsPath + '.bak', raw, 'utf8');
      try { current = JSON.parse(raw || '{}'); } catch { current = {}; }
    }
    const { command } = getHookSnippet();
    current.hooks ||= {};
    for (const evt of ['PreToolUse', 'PostToolUse']) {
      const list = Array.isArray(current.hooks[evt]) ? current.hooks[evt] : [];
      const already = list.some((entry) =>
        Array.isArray(entry?.hooks) && entry.hooks.some((h) => String(h?.command || '').includes('hook-reporter.js'))
      );
      if (!already) {
        list.push({ matcher: '*', hooks: [{ type: 'command', command }] });
      }
      current.hooks[evt] = list;
    }
    fs.writeFileSync(claudeSettingsPath, JSON.stringify(current, null, 2) + '\n', 'utf8');
    return { ok: true, path: claudeSettingsPath, command };
  }

  return {
    hookDir,
    subscribe,
    recordEvent,
    getEvents,
    getSubagentEvents,
    getHookSnippet,
    installClaudeHook,
    foldToolEvents,
    close: () => { try { watcher?.close(); } catch {} },
  };
}

module.exports = { createToolHooks, foldToolEvents };
