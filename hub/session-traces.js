'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const INSTRUCTION_NAMES = [
  'AGENTS.md',
  'CLAUDE.md',
  '.claude/CLAUDE.md',
  'GEMINI.md',
  '.gemini/GEMINI.md',
  'MEMORY.md',
  '.cursorrules',
];

function findInstructionFiles(cwd) {
  const found = [];
  const seen = new Set();
  const addIfExists = (filePath, scope) => {
    const resolved = path.resolve(filePath);
    if (seen.has(resolved) || !fs.existsSync(resolved)) return;
    try {
      const st = fs.statSync(resolved);
      if (!st.isFile()) return;
      seen.add(resolved);
      found.push({ path: resolved, name: path.basename(resolved), scope, size: st.size, mtime: st.mtimeMs });
    } catch {}
  };

  if (cwd && fs.existsSync(cwd)) {
    let cur = path.resolve(cwd);
    for (let depth = 0; depth < 3; depth++) {
      for (const rel of INSTRUCTION_NAMES) addIfExists(path.join(cur, rel), depth === 0 ? 'workspace' : 'parent');
      const parent = path.dirname(cur);
      if (parent === cur) break;
      if (fs.existsSync(path.join(cur, '.git'))) break;
      cur = parent;
    }
  }
  addIfExists(path.join(os.homedir(), '.claude', 'CLAUDE.md'), 'global');
  addIfExists(path.join(os.homedir(), '.codex', 'AGENTS.md'), 'global');
  return found;
}

function findTranscriptFile(claudeDir, sessionId) {
  if (!claudeDir || !sessionId) return null;
  const root = path.join(claudeDir, 'projects');
  if (!fs.existsSync(root)) return null;
  for (const d of fs.readdirSync(root)) {
    const p = path.join(root, d, `${sessionId}.jsonl`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function collectSessionTraces(hub, { sessionId = '', termId = '', cwd = '' } = {}) {
  const term = termId ? hub.terms?.get(String(termId)) : null;
  const effectiveCwd = cwd || term?.cwd || '';
  const effectiveSid = sessionId || (term ? hub.termSessionId?.(term) : '') || '';

  const instructions = findInstructionFiles(effectiveCwd);
  const hookData = hub.toolHooks?.getEvents({ termId, sessionId: effectiveSid }) || { events: [], source: 'none' };

  const fileMap = new Map();
  const subagents = [];
  const subagentSeen = new Set();

  const touchFile = (filePath, tool, ts) => {
    if (!filePath || /[<>|*]/.test(filePath)) return;
    if (!/[\\/.]/.test(filePath)) return;
    const isEdit = /edit|write|patch|create|delete|mv|cp/i.test(tool || '');
    const cur = fileMap.get(filePath) || { path: filePath, reads: 0, edits: 0, lastAt: 0 };
    if (isEdit) cur.edits += 1;
    else cur.reads += 1;
    cur.lastAt = Math.max(cur.lastAt, Number(ts) || 0);
    fileMap.set(filePath, cur);
  };

  for (const ev of hookData.events || []) {
    if (ev.target && /read|edit|write|view|grep|glob|notebook|patch|cat|sed/i.test(ev.tool || '')) {
      touchFile(ev.target, ev.tool, ev.ts);
    }
    if (ev.subagentId || /^(Agent|Task|invoke_subagent)$/i.test(ev.tool || '')) {
      const key = ev.subagentId || `${ev.tool}:${ev.target}:${ev.ts}`;
      if (!subagentSeen.has(key)) {
        subagentSeen.add(key);
        subagents.push({
          id: ev.subagentId || key,
          tool: ev.tool,
          description: ev.target || ev.tool,
          ts: ev.ts,
          status: ev.status || 'done',
        });
      }
    }
  }

  const images = [];
  const tf = findTranscriptFile(hub.claudeDir, effectiveSid);
  if (tf) {
    try {
      const st = fs.statSync(tf);
      const start = Math.max(0, st.size - 512 * 1024);
      const fd = fs.openSync(tf, 'r');
      const buf = Buffer.alloc(st.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      fs.closeSync(fd);
      let txt = buf.toString('utf8');
      if (start > 0) txt = txt.slice(txt.indexOf('\n') + 1);
      for (const line of txt.split(/\r?\n/)) {
        if (!line.trim()) continue;
        let row; try { row = JSON.parse(line); } catch { continue; }
        const content = row.message?.content;
        if (!Array.isArray(content)) continue;
        const ts = row.timestamp ? Date.parse(row.timestamp) || 0 : 0;
        for (const blk of content) {
          if (blk?.type === 'image') {
            images.push({ mediaType: blk.source?.media_type || 'image', ts });
          } else if (blk?.type === 'text' && typeof blk.text === 'string') {
            const matches = blk.text.match(/[A-Za-z]:[\\/][^\s"'`<>]+\.(?:png|jpg|jpeg|webp|gif)/gi) || [];
            for (const m of matches.slice(0, 6)) images.push({ path: m, ts });
          }
        }
      }
    } catch {}
  }

  const visitedFiles = [...fileMap.values()].sort((a, b) => b.lastAt - a.lastAt).slice(0, 80);

  // Match artifacts & project plans
  let artifacts = [];
  try {
    const allArt = hub.artifacts?.list?.(effectiveSid) || [];
    artifacts = allArt.slice(0, 30);
  } catch {}

  const plans = [];
  try {
    const allProjects = hub.projects?.list?.() || [];
    for (const p of allProjects) {
      const linked = (effectiveSid && p.sessionIds?.includes(effectiveSid))
        || (termId && p.termIds?.includes(String(termId)))
        || (effectiveCwd && p.cwd && path.resolve(p.cwd).toLowerCase() === path.resolve(effectiveCwd).toLowerCase());
      if (linked) {
        plans.push({
          id: p.id,
          name: p.name,
          goal: String(p.goal || '').slice(0, 220),
          done: (p.tasks || []).filter((t) => t.stage === 'done').length,
          total: (p.tasks || []).length,
        });
      }
    }
  } catch {}

  return {
    ok: true,
    sessionId: effectiveSid,
    termId: termId ? String(termId) : '',
    cwd: effectiveCwd,
    source: hookData.source,
    hookCount: hookData.rawCount || 0,
    instructions,
    visitedFiles,
    subagents: subagents.slice(-30),
    images: images.slice(-20),
    artifacts,
    plans,
  };
}

module.exports = { collectSessionTraces };
