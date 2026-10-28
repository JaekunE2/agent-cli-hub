// Agent CLI Hub — Claude Code / Codex / Cursor agent sessions in one web page; local only (127.0.0.1), token-protected.
// English mode: reload this file with translated messages (i18n.js); Korean is the source language.
if (require('./i18n').takeOver(module)) return;
const I18N = require('./i18n');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
// stay responsive while training/cleanup jobs load the PC (above-normal is not inherited by children)
try { require('os').setPriority(require('os').constants.priority.PRIORITY_ABOVE_NORMAL); } catch {}
const crypto = require('crypto');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const pty = require('@lydell/node-pty');
const { SearchIndex } = require('./searchindex');
const { Terminal: HeadlessTerminal } = require('@xterm/headless');

const PORT = Number(process.env.CCD_PORT || 7777);
const HOST = '127.0.0.1';
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
// Per-install settings (config.json next to server.js; all optional):
//   lang: "en" | "ko", remote: "off" | (default tailscale), python: path, usageUrl, usageDir, locateRoots: [dirs],
//   consoles: false (don't list this PC's other console windows), codex / cursorAgent: CLI paths, calendar: {...}
const CONFIG = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')); } catch { return {}; } })();
const PY = process.env.CCD_PYTHON || CONFIG.python || 'python';

// Persisted token so a bookmarked URL keeps working across restarts.
const TOKEN_FILE = path.join(__dirname, '.token');
if (!fs.existsSync(TOKEN_FILE)) fs.writeFileSync(TOKEN_FILE, crypto.randomBytes(18).toString('hex'));
const TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim();

// ---------- console helper (python, JSON lines) ----------
let helper, helperBuf = '', rid = 0, helperFails = 0, helperMissing = null;
const pending = new Map();
function startHelper() {
  helper = spawn(PY, [path.join(__dirname, 'consolehelper.py')], {
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
  });
  helper.stdout.setEncoding('utf8');
  helper.stdout.on('data', (d) => {
    helperBuf += d;
    let i;
    while ((i = helperBuf.indexOf('\n')) >= 0) {
      const line = helperBuf.slice(0, i); helperBuf = helperBuf.slice(i + 1);
      try { const r = JSON.parse(line); pending.get(r.rid)?.(r); pending.delete(r.rid); } catch {}
    }
  });
  helper.stderr.on('data', (d) => console.error('[helper]', String(d).trim()));
  const started = Date.now();
  helper.on('error', (e) => { if (e.code === 'ENOENT') helperMissing = `Python(${PY})을 찾을 수 없어 기존 콘솔 창 보기/입력이 꺼져 있습니다. config.json의 "python"에 경로를 지정하세요.`; });
  helper.on('exit', () => {
    for (const cb of pending.values()) cb({ ok: false, error: helperMissing || 'helper exited' });
    pending.clear();
    helperFails = Date.now() - started < 5000 ? helperFails + 1 : 0;
    if (helperMissing || helperFails > 5) { helperMissing = helperMissing || 'console helper keeps crashing; console-window features disabled'; console.error('[helper]', helperMissing); return; }
    setTimeout(startHelper, 1000);
  });
}
startHelper();
// Serialize requests: the helper attaches to one console at a time.
let chain = Promise.resolve();
// The console helper answers one request at a time and "list" takes 0.2–1 s with ~80 consoles.
// Every open page polls it (overview every 4 s, research every 10 s, the watchdog …), so requests
// queued up for 10–20 s and the whole dashboard stalled. "list" is now shared: one query in flight,
// its answer reused for 2 s. Pass { op: 'list', fresh: true } to force a new one.
let listCache = null, listAt = 0, listInflight = null;
function helperCall(req) {
  if (CONFIG.consoles === false) return Promise.resolve(req.op === 'list' ? { ok: true, consoles: [] } : { ok: false, error: 'console windows are turned off (config consoles: false)' });
  if (req.op === 'list' && !req.fresh && !helperMissing) {
    if (listCache && Date.now() - listAt < 2000) return Promise.resolve(listCache);
    if (!listInflight) listInflight = helperCallRaw({ op: 'list' }).then((r) => { if (r && r.ok !== false) { listCache = r; listAt = Date.now(); } listInflight = null; return r; });
    // a slow or failed scan must not empty the window list (every session showed "창 없음"):
    // answer with the last good list while a new one is being made, for up to a minute
    if (listCache && Date.now() - listAt < 60000) return Promise.resolve(listCache);
    return listInflight.then((r) => (r && r.ok !== false) || !listCache ? r : listCache);
  }
  return helperCallRaw(req.op === 'list' ? { op: 'list' } : req);
}
function helperCallRaw(req) {
  if (helperMissing) return Promise.resolve({ ok: false, error: helperMissing, consoles: [] });
  const run = () => new Promise((resolve) => {
    const id = ++rid;
    const t = setTimeout(() => { pending.delete(id); resolve({ ok: false, error: 'timeout' }); }, 8000);
    pending.set(id, (r) => { clearTimeout(t); resolve(r); });
    helper.stdin.write(JSON.stringify({ ...req, rid: id }) + '\n');
  });
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}

// ---------- Claude session registry + transcripts ----------
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

function liveSessions() {
  const dir = path.join(CLAUDE_DIR, 'sessions');
  const out = [];
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!/^\d+\.json$/.test(f)) continue;
    try {
      const s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (!pidAlive(s.pid)) continue;
      out.push({ pid: s.pid, sessionId: s.sessionId, cwd: s.cwd, name: s.name, status: s.status,
        kind: s.kind, entrypoint: s.entrypoint || null, startedAt: s.startedAt, updatedAt: s.statusUpdatedAt || s.updatedAt, version: s.version });
    } catch {}
  }
  return out;
}

// sessionId -> transcript path cache
const transcriptIndex = new Map();
function findTranscript(sessionId) {
  const hit = transcriptIndex.get(sessionId);
  if (hit && fs.existsSync(hit)) return hit;
  const root = path.join(CLAUDE_DIR, 'projects');
  for (const d of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    const p = path.join(root, d, sessionId + '.jsonl');
    if (fs.existsSync(p)) { transcriptIndex.set(sessionId, p); return p; }
  }
  return null;
}

function readTail(file, bytes) {
  const st = fs.statSync(file);
  const start = Math.max(0, st.size - bytes);
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(st.size - start);
  fs.readSync(fd, buf, 0, buf.length, start);
  fs.closeSync(fd);
  let s = buf.toString('utf8');
  if (start > 0) s = s.slice(s.indexOf('\n') + 1);
  return s;
}

function firstLines(file, bytes) {
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(bytes);
  const n = fs.readSync(fd, buf, 0, bytes, 0);
  fs.closeSync(fd);
  return buf.subarray(0, n).toString('utf8').split('\n').slice(0, -1);
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((c) => {
    if (c.type === 'text') return c.text;
    if (c.type === 'tool_use') {
      const inp = c.input || {};
      const hint = inp.command || inp.file_path || inp.pattern || inp.description || inp.url || '';
      return `⚙ ${c.name}${hint ? ': ' + String(hint).slice(0, 160) : ''}`;
    }
    if (c.type === 'tool_result') return null;
    return null;
  }).filter(Boolean).join('\n');
}

function transcript(sessionId, maxMsgs = 80) {
  const file = findTranscript(sessionId);
  if (!file) return { messages: [], error: 'transcript not found' };
  const msgs = [];
  let title = null;
  for (const line of readTail(file, 1_500_000).split('\n')) {
    if (!line) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.type === 'custom-title' || e.type === 'summary') title = e.customTitle || e.summary || title;
    if (e.type !== 'user' && e.type !== 'assistant') continue;
    if (e.isMeta || e.isSidechain) continue;
    const text = textOf(e.message?.content);
    if (!text || /^<(command|local-command|system-reminder)/.test(text.trim())) continue;
    msgs.push({ role: e.type, text: text.slice(0, 4000), ts: e.timestamp });
  }
  return { file, title, messages: msgs.slice(-maxMsgs), size: fs.statSync(file).size };
}

function recentSessions(limit = 40) {
  const root = path.join(CLAUDE_DIR, 'projects');
  const files = [];
  for (const d of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    const dir = path.join(root, d);
    let ents; try { ents = fs.readdirSync(dir); } catch { continue; }
    for (const f of ents) {
      if (!f.endsWith('.jsonl')) continue;
      const p = path.join(dir, f);
      try { files.push({ p, mtime: fs.statSync(p).mtimeMs, sessionId: f.slice(0, -6) }); } catch {}
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  return files.slice(0, limit).map(({ p, mtime, sessionId }) => {
    transcriptIndex.set(sessionId, p);
    let cwd = null, firstPrompt = null, title = null;
    try {
      for (const line of firstLines(p, 200_000)) {
        let e; try { e = JSON.parse(line); } catch { continue; }
        cwd = cwd || e.cwd;
        if (e.type === 'custom-title') title = e.customTitle;
        if (!firstPrompt && e.type === 'user' && !e.isMeta) {
          const t = textOf(e.message?.content);
          if (t && !/^<(command|local-command|system-reminder)/.test(t.trim())) firstPrompt = t.slice(0, 140);
        }
      }
      if (!title) for (const line of readTail(p, 60_000).split('\n')) {
        if (line.includes('"custom-title"') || line.includes('"summary"')) {
          try { const e = JSON.parse(line); title = e.customTitle || e.summary || title; } catch {}
        }
      }
    } catch {}
    return { sessionId, cwd, title, firstPrompt, mtime };
  });
}

const index = new SearchIndex(path.join(CLAUDE_DIR, 'projects'));
index.refresh().then(() => console.log('search index ready:', index.docs.size, 'sessions'));
setInterval(() => index.refresh(), 60000); // live sessions are refreshed by the overview anyway

// ---------- overview snapshot ----------
// Every open page (PC tabs, phone app) polls /api/overview every few seconds. It used to be rebuilt per
// request; now one build serves every viewer for OV_TTL, concurrent requests share it, and any POST
// (new terminal, favorite, send …) marks it stale so the change shows on the next poll.
const OV_TTL = 2500;
let ovSnap = null, ovAt = 0, ovBuilding = null;
function overviewStale() { ovAt = 0; }
function overviewSnapshot() {
  if (ovSnap && Date.now() - ovAt < OV_TTL) return Promise.resolve(ovSnap);
  if (!ovBuilding) {
    ovBuilding = buildOverview()
      .then((o) => { ovSnap = o; ovAt = Date.now(); return o; })
      .finally(() => { ovBuilding = null; });
  }
  return ovBuilding;
}
// C: free space: sessions die when it hits 0 (transcripts, credentials, state files all live there)
let diskLow = null;
function checkDisk() {
  try {
    const f = fs.statfsSync('C:/'); const free = f.bavail * f.bsize;
    const low = free < (CONFIG.diskWarnGB || 3) * 2 ** 30;
    if (low && !diskLow) console.error(`[disk] C: low: ${(free / 2 ** 30).toFixed(2)} GB free`);
    diskLow = low ? { drive: 'C:', freeGB: Math.round(free / 2 ** 30 * 100) / 100 } : null;
  } catch {}
}
checkDisk(); setInterval(checkDisk, 60_000);
async function buildOverview() {
  const [cons] = await Promise.all([helperCall({ op: 'list' })]);
  const live = liveSessions();
  // attach usage-limit state from the transcript (incremental read, cheap)
  for (const s of live) {
    const d = index.get(s.sessionId);
    if (d) { await index.updateFile(d.file); if (d.limit) s.limit = d.limit; }
  }
  const byPid = new Map(live.map((s) => [s.pid, s]));
  // node-pty on this build reports pid 0; recover it from the process tree
  // (a pty child's parent is this server process).
  // terminal ↔ process pairing can take seconds (PowerShell): run it behind the response
  if (!matchBusy) { matchBusy = true; matchTermPids(cons.consoles || []).catch(() => {}).finally(() => { matchBusy = false; }); }
  consoleTitleCache = new Map((cons.consoles || []).filter((c) => c.visible && !/^[A-Za-z]:[\\/]/.test(c.title)).flatMap((c) => c.pids.map((p) => [p, c.title])));
  const consoles = (cons.consoles || []).map((c) => ({
    ...c, claude: c.pids.map((x) => byPid.get(x)).filter(Boolean).map((s) => s.sessionId),
    managed: [...terms.values()].some((t) => c.pids.includes(t.pid)),
  }));
  // name dashboard terminals after the Claude session running in them
  const termsOut = [...terms.values()].map((t) => {
    const info = termInfo(t);
    const c = t.pid && consoles.find((x) => x.pids.includes(t.pid));
    const s = c && live.find((x) => c.pids.includes(x.pid));
    if (s) {
      const d = index.get(s.sessionId);
      info.sessionId = s.sessionId;
      info.sessionName = d?.title || d?.firstPrompt?.split('\n')[0].slice(0, 80) || null;
    } else if (info.codex) {
      const d = codexDocOf(t);
      if (d) { info.sessionId = d.id; info.sessionName = d.title || d.firstPrompt?.split('\n')[0].slice(0, 80) || null; }
    }
    return info;
  });
  return { live, consoles, terms: termsOut, consoleError: cons.error, favs: loadFavs(), disk: diskLow, consolesOff: CONFIG.consoles === false };
}

function transcriptFromIndex(sessionId, at) {
  const d = index.get(sessionId);
  if (!d) return null;
  const n = d.msgs.length;
  const start = at >= 0 ? Math.max(0, at - 40) : Math.max(0, n - 80);
  const end = at >= 0 ? Math.min(n, at + 40) : n;
  return { title: d.title, cwd: d.cwd, size: d.offset, total: n, base: start,
    messages: d.msgs.slice(start, end).map((m) => ({ ...m, text: m.text.slice(0, 4000) })) };
}

async function searchScreens(q) {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const list = await helperCall({ op: 'list' });
  const out = [];
  for (const c of (list.consoles || []).filter((c) => c.visible)) {
    const r = await helperCall({ op: 'read', pid: c.id, lines: 2000 });
    if (!r.ok) continue;
    const hits = [];
    r.lines.forEach((l, i) => { const low = l.toLowerCase(); if (terms.some((t) => low.includes(t))) hits.push({ line: i, text: l.trim().slice(0, 240) }); });
    const all = r.lines.join('\n').toLowerCase();
    if (hits.length && terms.every((t) => all.includes(t))) out.push({ id: c.id, title: c.title, total: hits.length, hits: hits.slice(-6) });
  }
  return out;
}

// ---------- managed terminals: live in ptyhost.js, mirrored here ----------
// The pty host owns the processes, so restarting this server does not touch any session.
// Each terminal here is a mirror with the same shape as before (proc.write/kill/resize, vt,
// buf, clients) fed by the host's event stream.
const terms = new Map(); // id -> mirror
let termSeq = 0;
// If the server itself was launched from inside a Claude Code session, its env
// carries that session's markers; a child claude would then think it is a
// sub-session (and e.g. stop saving its transcript). Start terminals clean.
const SESSION_ENV = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_CODE_(CHILD_SESSION|SESSION_ID|SESSION_ATTENDED|MESSAGING_SOCKET|MESSAGING_TOKEN|ENTRYPOINT|EXECPATH))$/;
function cleanEnv() {
  const env = { FORCE_COLOR: '1' };
  for (const [k, v] of Object.entries(process.env)) if (!SESSION_ENV.test(k)) env[k] = v;
  return env;
}
const PTY_PORT = Number(process.env.CCD_PTY_PORT || (PORT === 7777 ? 7779 : PORT + 2));
const PTY_URL = `http://127.0.0.1:${PTY_PORT}`;
const TERMS_STATE = path.join(__dirname, PORT === 7777 ? 'terms-state.json' : `terms-state-${PORT}.json`);
let ptyHostPid = 0;
async function ptyCall(p, b) {
  const r = await fetch(PTY_URL + p, { method: b ? 'POST' : 'GET', headers: { 'x-token': TOKEN, 'content-type': 'application/json' },
    body: b ? JSON.stringify(b) : undefined, signal: AbortSignal.timeout(15000) });
  return r.json();
}
// requests for one terminal are kept in order (spawn before the first write, etc.)
const ptyChains = new Map();
function ptyPost(id, p, b) {
  const next = (ptyChains.get(id) || Promise.resolve()).then(() => ptyCall(p, b)).catch((e) => console.error('[pty]', p, e.message));
  ptyChains.set(id, next);
  return next;
}
function makeMirror({ id, meta = {}, cols = 120, rows = 32, exited = null }) {
  const t = { id, title: meta.title, cwd: meta.cwd, cmd: meta.cmd, args: meta.args || [], account: meta.account || null, research: meta.research || null,
    meta, buf: '', clients: new Set(), exited, pid: 0, cols, rows, liveTitle: '' };
  // Headless mirror of the screen so agents/CLI can read rendered text, not raw ANSI.
  t.vt = new HeadlessTerminal({ cols, rows, scrollback: 3000, allowProposedApi: true });
  // claude sets the window title (OSC 0/2) to its session name, e.g. "✳ task name"
  t.vt.onTitleChange((s) => { t.liveTitle = s; });
  t.proc = {
    write: (data) => ptyPost(id, '/write', { id, data }),
    kill: () => ptyPost(id, '/kill', { id }),
    resize: (c, r) => ptyPost(id, '/resize', { id, cols: c, rows: r }),
  };
  terms.set(id, t);
  termSeq = Math.max(termSeq, Number(id) || 0);
  return t;
}
function mirrorData(t, d) {
  t.vt.write(d);
  t.buf = (t.buf + d).slice(-400_000);
  for (const ws of t.clients) ws.send(JSON.stringify({ type: 'data', data: d }));
}
function createTerm({ cwd, cmd, args = [], title, env = {}, account = null, research = null, operator = false }) {
  const id = String(++termSeq);
  if (!cwd || !fs.existsSync(cwd)) cwd = os.homedir();
  // meta is what we need to re-create the terminal after a pty-host restart — never secrets
  const envFlags = Object.fromEntries(Object.entries(env).filter(([k]) => !/TOKEN|KEY|SECRET/i.test(k)));
  const meta = { title: title || [cmd, ...args].join(' '), cwd, cmd, args, account, research, envFlags, spawnedAt: Date.now(), ...(operator ? { operator: true } : {}) };
  const t = makeMirror({ id, meta });
  ptyPost(id, '/spawn', { id, cmd, args, cwd, env: { ...cleanEnv(), ...env }, cols: 120, rows: 32, meta });
  return t;
}
function resizeTerm(t, cols, rows) {
  if (cols === t.cols && rows === t.rows) return false;
  t.proc.resize(cols, rows);
  t.vt.resize(cols, rows);
  t.cols = cols; t.rows = rows;
  return true;
}
function forgetTerm(t) {
  ptyPost(t.id, '/forget', { id: t.id });
  terms.delete(t.id);
  for (const ws of t.clients) ws.close();
}

// connect to (or start) the pty host, load its terminals, then follow its event stream
async function connectPtyHost() {
  let inf = await ptyCall('/info').catch(() => null);
  let fresh = false;
  if (!inf) {
    const log = fs.openSync(path.join(__dirname, 'ptyhost.log'), 'a');
    spawn(process.execPath, [path.join(__dirname, 'ptyhost.js')], { cwd: __dirname, detached: true, windowsHide: true, stdio: ['ignore', log, log],
      env: { ...cleanEnv(), CCD_PTY_PORT: String(PTY_PORT) } }).unref();
    for (let i = 0; i < 40 && !inf; i++) { await sleep(250); inf = await ptyCall('/info').catch(() => null); }
    if (!inf) { console.error('[pty] host did not start; see ptyhost.log'); return setTimeout(connectPtyHost, 5000); }
    fresh = true;
  }
  ptyHostPid = inf.pid;
  for (const x of inf.terms) {
    if (terms.has(x.id)) continue;
    const t = makeMirror(x);
    t.startedAt = x.startedAt || null; // pty host spawn time → matches the root process start
    const { buf = '' } = await ptyCall(`/buf?id=${encodeURIComponent(x.id)}`).catch(() => ({}));
    if (buf) { t.buf = buf.slice(-400_000); t.vt.write(t.buf); }
  }
  const WebSocketClient = require('ws');
  const ev = new WebSocketClient(`ws://127.0.0.1:${PTY_PORT}/events?t=${TOKEN}`);
  ev.on('message', (m) => {
    let e; try { e = JSON.parse(m); } catch { return; }
    const t = terms.get(e.id);
    if (e.type === 'data' && t) mirrorData(t, e.data);
    else if (e.type === 'exit' && t) { t.exited = e.code; for (const ws of t.clients) ws.send(JSON.stringify({ type: 'exit', code: e.code })); }
    else if (e.type === 'resize' && t && (t.cols !== e.cols || t.rows !== e.rows)) { t.cols = e.cols; t.rows = e.rows; t.vt.resize(e.cols, e.rows); }
  });
  ev.on('close', () => { console.error('[pty] event stream closed; reconnecting'); setTimeout(connectPtyHost, 2000); });
  ev.on('error', () => {});
  console.log(`pty host pid ${ptyHostPid} (${fresh ? 'started' : 'reattached'}), ${inf.terms.length} terminal(s)`);
  if (fresh) (async () => {
    // after an unclean shutdown the restored terminals get the crash note instead of the restart note,
    // and sessions cut off outside the dashboard's terminals are resumed too (crash-recovery.js)
    const saved = savedTermSessions();
    let crash = null;
    try { crash = await crashRec.detect(); } catch (e) { console.error('[crash]', e.message); }
    const ids = (await recoverTerms(crash?.note)) || new Set();
    if (crash) try {
      const r = await crashRec.handle(crash, { skip: saved, restored: saved.size, resume: resumeCut });
      for (const id of r.resumed) ids.add(id);
    } catch (e) { console.error('[crash]', e.message); }
    await resumeFavorites(ids);
  })().catch((e) => console.error('[pty] recover', e.message));
}

// ---- which process is a terminal's root? node-pty here reports pid 0, so it is recovered from the
// process tree (a root is a direct child of the pty host). Matching only by exe name picked the FIRST
// unmatched claude.exe — an orphaned older one — and gave a new terminal another session's identity.
// Now: "--resume <id>" must appear in the candidate's command line, and the candidate must have been
// created within a minute of the terminal's spawn. Ambiguous → leave unmatched (pid 0) rather than guess.
const procInfoCache = new Map(); // pid -> { cl, start }
async function procInfo(pids) {
  const need = pids.filter((p) => !procInfoCache.has(p));
  if (need.length) {
    const filter = need.map((p) => `ProcessId=${p}`).join(' OR ');
    const out = await new Promise((res) => require('child_process').execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process -Filter "${filter}" | Select-Object ProcessId,CommandLine,@{n='S';e={$_.CreationDate.ToString('o')}} | ConvertTo-Json -Compress`],
      { timeout: 15000, windowsHide: true }, (e, o) => res(e ? '' : String(o))));
    let arr = []; try { arr = [].concat(JSON.parse(out || '[]')); } catch {}
    for (const x of arr) if (x) procInfoCache.set(x.ProcessId, { cl: x.CommandLine || '', start: x.S ? Date.parse(x.S) : null });
  }
  return new Map(pids.map((p) => [p, procInfoCache.get(p)]));
}
let matchBusy = false;
async function matchTermPids(consoles) {
  // terminals that name their session (--resume) first; the rest in creation order, so older
  // terminals without a recorded spawn time pair with older processes
  const hasResume = (t) => (t.args || []).includes('--resume');
  // a linked process that has exited frees the terminal for re-matching (a stale pid made the next
  // terminal grab this one's process, shifting every later terminal by one)
  for (const t of terms.values()) if (t.pid && t.exited === null && !pidAlive(t.pid)) t.pid = 0;
  const pending = [...terms.values()].filter((t) => !t.pid && t.exited === null)
    .sort((a, b) => hasResume(b) - hasResume(a) || Number(a.id) - Number(b.id));
  if (!pending.length || !ptyHostPid) return;
  const known = new Set([...terms.values()].map((t) => t.pid).filter(Boolean));
  const roots = consoles.flatMap((c) => c.procs.filter((x) => x.ppid === ptyHostPid && !known.has(x.pid)));
  if (!roots.length) return;
  const info = await procInfo(roots.map((r) => r.pid));
  for (const t of pending) {
    const exe = path.basename(t.cmd || '').toLowerCase();
    const ri = (t.args || []).indexOf('--resume');
    const resumeId = ri >= 0 ? t.args[ri + 1] : null;
    const spawned = t.meta?.spawnedAt || t.startedAt || null;
    const cands = roots.filter((r) => !known.has(r.pid) && r.name.toLowerCase() === exe).filter((r) => {
      const inf = info.get(r.pid);
      if (resumeId && !(inf?.cl || '').includes(resumeId)) return false;
      if (spawned && inf?.start && (inf.start < spawned - 5000 || inf.start > spawned + 60000)) return false;
      return true;
    });
    if (!cands.length) continue;
    const st = (r) => info.get(r.pid)?.start || 0;
    // with a spawn time: the closest process; without (older terminals): the oldest remaining one
    const pick = spawned ? cands.sort((a, b) => Math.abs(st(a) - spawned) - Math.abs(st(b) - spawned))[0] : cands.sort((a, b) => st(a) - st(b))[0];
    t.pid = pick.pid; known.add(pick.pid);
  }
}

// ---- recovery: when the pty host itself had to start (reboot, host update), bring the
// sessions that were open back — same session ids — and tell the busy ones what happened.
async function saveTermsState() {
  try {
    const cons = ((await helperCall({ op: 'list' })).consoles) || [];
    const live = liveSessions();
    const list = [];
    // pid 0 = not matched yet: the terminal's root process is the pty host's direct child
    await matchTermPids(cons);
    for (const t of terms.values()) {
      if (t.exited !== null) continue;
      const c = t.pid && cons.find((x) => x.pids.includes(t.pid));
      const s = c && live.find((x) => c.pids.includes(x.pid));
      const resumed = (t.args || []).includes('--resume') ? t.args[t.args.indexOf('--resume') + 1] : null;
      list.push({ id: t.id, meta: t.meta, sessionId: s?.sessionId || t.meta.sessionId || resumed || null, busy: s?.status === 'busy' || s?.status === 'shell' });
    }
    fs.writeFileSync(TERMS_STATE + '.tmp', JSON.stringify({ savedAt: new Date().toISOString(), terms: list }, null, 1));
    fs.renameSync(TERMS_STATE + '.tmp', TERMS_STATE);
  } catch (e) { console.error('[pty] save state', e.message); }
}
function savedTermSessions() {
  try { return new Set((JSON.parse(fs.readFileSync(TERMS_STATE, 'utf8')).terms || []).map((x) => x.sessionId).filter(Boolean)); } catch { return new Set(); }
}
const RESTART_NOTE = '[대시보드 재시작으로 세션이 자동 재개됨] 재시작 직전에 진행 중이던 작업(백그라운드 대기·셸 포함)이 중단됐을 수 있습니다. 상태를 확인하고 필요한 것은 다시 실행해 이어서 진행하세요.';
// wait for a just-resumed claude's input box, then type the note and make sure it was sent
async function sendNoteWhenReady(t, note) {
  const head = note.slice(0, 12).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (let i = 0; i < 90 && t.exited === null; i++) {
    await sleep(700);
    const scr = readTerm(t, 40).join('\n');
    if (/trust this folder|Do you trust/i.test(scr)) return;
    if (/\? for shortcuts|bypass permissions|auto mode|accept edits|^\s*[>❯]\s*$/m.test(scr)) {
      await sleep(800);
      t.proc.write(note);
      await sleep(1200); t.proc.write('\r');
      // a busy just-resumed session sometimes swallows that Enter and the note sits unsent in the input box
      for (let k = 0; k < 6 && t.exited === null; k++) {
        await sleep(2500);
        if (!new RegExp(`^\\s*[>❯]\\s*${head}`, 'm').test(readTerm(t, 12).join('\n'))) break;
        // a bare Enter does not get it out (seen after the 10-15 crash); a keystroke first does
        t.proc.write('\x1b[C '); await sleep(600); t.proc.write('\r');
      }
      return;
    }
  }
}
// a session cut off by a crash outside the dashboard's terminals: resume it in a new one (crash-recovery.js)
async function resumeCut(s, note) {
  let pick = { id: 'default', label: '이 PC 로그인' };
  try {
    const c = (await switchCandidates('none')).candidates;
    const def = c.find((x) => x.id === 'default');
    if (!def?.usable) { const best = c.filter((x) => x.usable).sort((a, b) => b.score - a.score)[0]; if (best) pick = best; }
  } catch {}
  const env = {};
  if (pick.id !== 'default') env.CLAUDE_CODE_OAUTH_TOKEN = tokenAccounts().find((a) => a.id === pick.id).token();
  const t = createTerm({ cwd: s.cwd, cmd: 'claude.exe', args: ['--resume', s.id, '--dangerously-skip-permissions'], env,
    title: `↻ ${s.title || s.id.slice(0, 8)}`, account: pick.id === 'default' ? null : { id: pick.id, label: pick.label } });
  t.meta.sessionId = s.id;
  sendNoteWhenReady(t, note).catch(() => {});
  await sleep(2500); // don't start a dozen claude processes at once
}
const crashRec = require('./crash-recovery')({
  dir: __dirname, claudeDir: CLAUDE_DIR, liveSessions, gpuFile: path.join(__dirname, 'gpu-queue.json'),
  // the Telegram bridge sends notify/*.json to the owner
  notify: (html) => { const d = path.join(__dirname, 'notify'); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, `crash-${Date.now()}.json`), JSON.stringify({ html })); },
});
async function recoverTerms(note = RESTART_NOTE) {
  let saved; try { saved = JSON.parse(fs.readFileSync(TERMS_STATE, 'utf8')); } catch { return; }
  const items = (saved.terms || []).filter((x) => x.meta?.cmd);
  if (!items.length) return;
  const resumed = new Set(items.map((x) => x.sessionId).filter(Boolean));
  console.log(`[pty] recovering ${items.length} terminal(s) from ${saved.savedAt}`);
  for (const x of items) {
    const m = x.meta;
    const isClaude = /claude(\.exe)?$/i.test(m.cmd);
    if (isClaude && !x.sessionId) continue; // a claude that never got a session: nothing to resume
    const env = { ...(m.envFlags || {}) };
    if (m.account?.id && m.account.id !== 'default') {
      const acc = tokenAccounts().find((a) => a.id === m.account.id);
      if (acc) try { env.CLAUDE_CODE_OAUTH_TOKEN = acc.token(); } catch {}
    }
    const args = isClaude
      ? ['--resume', x.sessionId, ...((m.args || []).includes('--dangerously-skip-permissions') ? ['--dangerously-skip-permissions'] : [])]
      : (m.args || []);
    const t = createTerm({ cwd: m.cwd, cmd: m.cmd, args, title: m.title, env, account: m.account, research: m.research });
    if (m.research) t.research = m.research;
    t.meta.sessionId = x.sessionId;
    // explain the interruption (directors get the watchdog's own nudge)
    if (isClaude && x.busy && !m.research) sendNoteWhenReady(t, note).catch(() => {});
  }
  return resumed;
}
// Favourite sessions (⭐, favorites.json "sid:<id>") come back on their own after a reboot: any that the
// saved terminals did not already bring back and that isn't running anywhere is resumed in a new
// dashboard terminal, in its own folder. Account: the PC login if it works, else the one with most
// headroom. config "resumeFavorites": false turns it off.
async function resumeFavorites(already) {
  if (CONFIG.resumeFavorites === false) return;
  for (let i = 0; i < 120 && !index.ready; i++) await sleep(1000); // need each session's folder
  const live = new Set(liveSessions().map((s) => s.sessionId));
  const ids = loadFavs().filter((k) => k.startsWith('sid:')).map((k) => k.slice(4)).filter((id) => !already.has(id) && !live.has(id));
  if (!ids.length) return;
  let pick = { id: 'default', label: '이 PC 로그인' };
  try {
    const c = (await switchCandidates('none')).candidates;
    const def = c.find((x) => x.id === 'default');
    if (!def?.usable) { const best = c.filter((x) => x.usable).sort((a, b) => b.score - a.score)[0]; if (best) pick = best; }
  } catch {}
  console.log(`[pty] resuming ${ids.length} favourite session(s) on ${pick.label}`);
  for (const id of ids) {
    const d = index.get(id);
    if (!d?.cwd || !fs.existsSync(d.cwd)) { console.log(`[pty] favourite ${id.slice(0, 8)}: folder unknown, skipped`); continue; }
    const env = {};
    if (pick.id !== 'default') { try { env.CLAUDE_CODE_OAUTH_TOKEN = tokenAccounts().find((a) => a.id === pick.id).token(); } catch { continue; } }
    const title = `⭐ ${d.title || d.firstPrompt?.split('\n')[0].slice(0, 40) || id.slice(0, 8)}`;
    const t = createTerm({ cwd: d.cwd, cmd: 'claude.exe', args: ['--resume', id, '--dangerously-skip-permissions'], env, title, account: pick.id === 'default' ? null : { id: pick.id, label: pick.label } });
    t.meta.sessionId = id;
    await sleep(2500); // don't start a dozen claude processes at once
  }
}
setInterval(saveTermsState, 15000);

function readTerm(t, n = 60) {
  const b = t.vt.buffer.active, lines = [];
  const text = (i) => b.getLine(i)?.translateToString(true) ?? '';
  // the viewport's blank rows below the output would otherwise fill the window
  let last = b.length - 1;
  while (last > 0 && !text(last).trim()) last--;
  for (let i = Math.max(0, last - n + 1); i <= last; i++) lines.push(text(i));
  return lines;
}
const PTY_KEYS = { enter: '\r', esc: '\x1b', tab: '\t', backspace: '\x7f', up: '\x1b[A', down: '\x1b[B',
  right: '\x1b[C', left: '\x1b[D', 'ctrl+c': '\x03', 'shift+tab': '\x1b[Z' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// TUIs (claude) treat text+CR arriving in one chunk as a paste with a newline,
// so a "submit" Enter is sent separately after a short pause.
const SUBMIT_DELAY = 350;
// Injected key events into a console are consumed one by one; a long message needs time
// to land before Enter, or claude keeps it in the input box (seen with ~600-char texts).
const consoleSubmitDelay = (text) => SUBMIT_DELAY + Math.min(6000, String(text || '').length * 6);

// ---------- files: original-path lookup + upload fallback ----------
const FAV_FILE = path.join(__dirname, 'favorites.json');
const loadFavs = () => { try { return JSON.parse(fs.readFileSync(FAV_FILE, 'utf8')); } catch { return []; } };
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const safeName = (n) => (String(n || 'file').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(-120) || 'file');
function locateFile({ name, size, mtime, cwd }) {
  const home = os.homedir();
  const roots = [cwd, path.join(home, 'Desktop'), path.join(home, 'OneDrive', 'Desktop'), path.join(home, 'Downloads'),
    path.join(home, 'Documents'), path.join(home, 'Pictures'), ...(CONFIG.locateRoots || [])]
    .filter((r, i, a) => r && a.indexOf(r) === i && fs.existsSync(r));
  const deadline = Date.now() + 1500;
  const match = (p) => {
    try { const st = fs.statSync(p); return st.isFile() && st.size === size && (!mtime || Math.abs(st.mtimeMs - mtime) < 2000); } catch { return false; }
  };
  // breadth-first, shallow; the name check is cheap, stat only on name hits
  let level = roots.map((r) => ({ dir: r, depth: 0 }));
  while (level.length && Date.now() < deadline) {
    const next = [];
    for (const { dir, depth } of level) {
      if (Date.now() > deadline) break;
      const hit = path.join(dir, name);
      if (match(hit)) return hit;
      if (depth >= 3) continue;
      let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of ents) if (e.isDirectory() && !/^(node_modules|\.git|\$RECYCLE\.BIN|__pycache__|\.venv|venv|site-packages)$/i.test(e.name)) next.push({ dir: path.join(dir, e.name), depth: depth + 1 });
    }
    level = next;
  }
  return null;
}
function saveUpload(req, name) {
  const d = new Date(), pad = (x) => String(x).padStart(2, '0');
  const dir = path.join(UPLOAD_DIR, `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`);
  fs.mkdirSync(dir, { recursive: true });
  let file = path.join(dir, `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}_${safeName(name)}`);
  for (let i = 2; fs.existsSync(file); i++) file = file.replace(/(\.[^.\\]*)?$/, `_${i}$1`);
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(file);
    req.pipe(out);
    out.on('finish', () => resolve(file));
    out.on('error', reject);
    req.on('error', reject);
  });
}

// ---------- AI usage (from the separate ai-usage-dashboard on 127.0.0.1:4777) ----------
// Relayed read-only and whitelisted: meters/plan/notes only, never tokens or file paths,
// so it is safe to show on the phone. Cached briefly; 4777 has its own provider caching.
const USAGE_URL = process.env.CCD_USAGE_URL || CONFIG.usageUrl || 'http://127.0.0.1:4777';
let usageCache = { at: 0, data: null };
async function aiUsage(force) {
  if (!force && usageCache.data && Date.now() - usageCache.at < 60_000) return usageCache.data;
  try {
    const r = await fetch(`${USAGE_URL}/api/usage${force ? '?force=1' : ''}`, { signal: AbortSignal.timeout(45_000) });
    const j = await r.json();
    const data = {
      available: true, generatedAt: j.generatedAt,
      accounts: (j.accounts || []).map((a) => ({
        id: a.id, provider: a.provider, label: a.label, plan: a.plan, ok: a.ok, live: a.live,
        email: a.email, error: a.error, notes: a.notes || [], fetchedAt: a.fetchedAt,
        billing: a.billing ? { label: a.billing.label, at: a.billing.at } : null,
        meters: (a.meters || []).map((m) => ({ name: m.name, usedPercent: m.usedPercent, resetsAt: m.resetsAt, detail: m.detail, headline: m.headline })),
      })),
    };
    usageCache = { at: Date.now(), data };
    return data;
  } catch (e) {
    return usageCache.data ? { ...usageCache.data, stale: true } : { available: false, error: `AI 사용량 대시보드(${USAGE_URL})에 연결할 수 없음: ${e.message}` };
  }
}

// ---------- account switch: resume a session under the account with most headroom ----------
// Candidates = this PC's Claude Code login ("default", no env override) + claude-token
// accounts registered in ai-usage-dashboard. Tokens stay server-side; the child claude
// gets CLAUDE_CODE_OAUTH_TOKEN. Transcripts live in ~/.claude either way, so --resume works.
const USAGE_DIR = process.env.CCD_USAGE_DIR || (CONFIG.usageDir && path.resolve(__dirname, CONFIG.usageDir)) || path.join(os.homedir(), 'ai-usage-dashboard');
function tokenAccounts() {
  let cfg; try { cfg = JSON.parse(fs.readFileSync(path.join(USAGE_DIR, 'accounts.json'), 'utf8')); } catch { return []; }
  return (cfg.accounts || []).filter((a) => a.type === 'claude-token' && (a.token || a.tokenPath)).map((a) => ({
    id: a.id, label: a.label,
    token: () => (a.token || fs.readFileSync(a.tokenPath, 'utf8')).trim(),
  }));
}
function meterPct(acc, re) { const m = (acc?.meters || []).find((x) => re.test(x.name)); return m ? m.usedPercent : null; }
async function switchCandidates(currentId) {
  const u = await aiUsage(false);
  const usageById = new Map((u.accounts || []).map((a) => [a.id, a]));
  const localUsage = (u.accounts || []).find((a) => a.provider === 'Claude' && a.live && /Claude Code/.test(a.label));
  const list = [{ id: 'default', label: '이 PC 로그인 (Claude Code)', usage: localUsage },
    ...tokenAccounts().map((a) => ({ id: a.id, label: a.label, usage: usageById.get(a.id) }))];
  // A token can belong to the same account as the PC login; same email = same quota.
  const emailOf = (c) => (c.usage?.email || (c.id === 'default' ? null : c.label) || '').toLowerCase() || null;
  const cur = list.find((c) => c.id === currentId);
  const curEmail = cur && emailOf(cur);
  const out = list.map((c) => {
    const fiveH = meterPct(c.usage, /5시간/), weekly = meterPct(c.usage, /주간 \(전체/);
    const known = c.usage?.ok && fiveH !== null;
    // headroom = the tighter of the two limits
    const score = known ? Math.min(100 - fiveH, 100 - (weekly ?? 0)) : -1;
    const reset = (c.usage?.meters || []).find((m) => /5시간/.test(m.name))?.resetsAt || null;
    const current = c.id === currentId || (!!curEmail && emailOf(c) === curEmail);
    return { id: c.id, label: c.label, fiveH, weekly, score, reset, current, sameAccount: current && c.id !== currentId, usable: known && score > 0 };
  });
  const best = out.filter((c) => c.usable && !c.current).sort((a, b) => b.score - a.score || (a.weekly ?? 0) - (b.weekly ?? 0))[0];
  if (best) best.best = true;
  return { candidates: out, stale: !!u.stale, usageAvailable: u.available !== false };
}
// Where a live session currently runs (dashboard terminal or external console) and on which account.
function locateSession(sessionId, consoles) {
  const s = liveSessions().find((x) => x.sessionId === sessionId);
  if (!s) return { live: false };
  const c = consoles.find((x) => x.pids.includes(s.pid));
  const t = c && [...terms.values()].find((x) => x.pid && c.pids.includes(x.pid) && x.exited === null);
  return { live: true, s, console: c, term: t, account: t?.account?.id || 'default' };
}
async function waitFor(fn, ms, step = 500) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(step)) if (await fn()) return true;
  return false;
}
const inputReady = (t) => {
  const s = readTerm(t, 40).join('\n');
  return !/trust this folder|Do you trust/i.test(s) && /\? for shortcuts|bypass permissions|auto mode|accept edits|^\s*[>❯]\s*$/m.test(s);
};
// A dashboard terminal whose claude has no conversation yet (e.g. "Not logged in" at start) has nothing to
// resume: start a fresh claude in the same folder on the chosen account, carrying its favourite star over.
async function switchTermAccount({ termId, account = 'auto', skip = true }) {
  const t0 = [...terms.values()].find((x) => String(x.id) === String(termId));
  if (!t0) return { ok: false, error: '터미널을 찾을 수 없습니다' };
  const { candidates } = await switchCandidates(t0.account?.id || 'default');
  const pick = account === 'auto' ? candidates.find((c) => c.best) : candidates.find((c) => c.id === account);
  if (!pick) return { ok: false, error: account === 'auto' ? '여유 있는 다른 계정이 없습니다 (AI 사용량 확인)' : '알 수 없는 계정' };
  const env = {};
  if (pick.id !== 'default') {
    try { env.CLAUDE_CODE_OAUTH_TOKEN = tokenAccounts().find((a) => a.id === pick.id).token(); } catch (e) { return { ok: false, error: `토큰을 읽지 못함: ${e.message}` }; }
  }
  if (t0.exited === null) {
    t0.proc.write('\x1b'); await sleep(500); t0.proc.write('/exit'); await sleep(SUBMIT_DELAY); t0.proc.write('\r');
    if (!(await waitFor(() => t0.exited !== null, 6000))) try { t0.proc.kill(); } catch {}
  }
  forgetTerm(t0);
  const short = pick.label.replace(/@.*/, '');
  const t = createTerm({ cwd: t0.cwd, cmd: 'claude.exe', args: skip ? ['--dangerously-skip-permissions'] : [], env,
    title: `${String(t0.title || 'claude').replace(/ ⇄ .*$/, '')} ⇄ ${short}`, account: { id: pick.id, label: pick.label } });
  const favs = loadFavs();
  if (favs.includes(`term:${t0.id}`)) fs.writeFileSync(FAV_FILE, JSON.stringify(favs.map((k) => (k === `term:${t0.id}` ? `term:${t.id}` : k))));
  return { ok: true, term: termInfo(t), account: { id: pick.id, label: pick.label, fiveH: pick.fiveH, weekly: pick.weekly }, stopped: `t:${t0.id}` };
}
// ---------- Codex (ChatGPT) accounts: codex-accounts.js keeps one CODEX_HOME per login ----------
// "다른 계정" restarts a codex terminal's conversation (codex resume) on another login of your own.
// It only happens when you press the button (or run `ccd switch`); nothing rotates accounts by itself.
const CA = require('./codex-accounts');
// an npm install of the Codex CLI is a .cmd shim → it runs through cmd.exe /c
const isCodexTerm = (t) => /codex(\.exe)?$/i.test(t?.meta?.cmd || '') || (/cmd(\.exe)?$/i.test(t?.meta?.cmd || '') && /codex(\.cmd)?$/i.test(t?.meta?.args?.[1] || ''));
const codexExe = () => CA.codexExe(CONFIG.codex);
function codexLaunch(extra = []) {
  const exe = codexExe();
  // the binary bundled with the Codex desktop app has no standalone package for its background server → run it in-process
  const pre = /plugin-appserver/i.test(exe) ? ['--no-daemon'] : [];
  return /\.cmd$/i.test(exe) ? { cmd: 'cmd.exe', args: ['/c', exe, ...pre, ...extra] } : { cmd: exe, args: [...pre, ...extra] };
}
async function codexCandidates(currentId) {
  const u = await aiUsage(false);
  const ranked = CA.rank(CA.accounts(USAGE_DIR), u);
  const cur = ranked.find((a) => a.id === currentId) || (!currentId ? ranked.find((a) => a.main) : null);
  const out = ranked.map((a) => {
    const current = !!cur && (a.id === cur.id || (!!cur.email && a.email === cur.email));
    return { id: a.id, label: a.email || a.label, fiveH: a.fiveH, weekly: a.weekly, score: a.score, reset: a.reset, current, sameAccount: current && a.id !== cur.id, usable: a.usable };
  });
  const best = out.find((c) => c.usable && !c.current);
  if (best) best.best = true;
  return { candidates: out, stale: !!u.stale, usageAvailable: u.available !== false, codex: true };
}
// the conversation a codex terminal is in, from the search index: `codex resume <id>` in its args, else the
// newest Codex rollout for its folder written since the terminal started (cheap: no file reads)
function codexDocOf(t) {
  const fromArgs = (t.meta?.args || []).join(' ').match(/resume ([0-9a-f-]{36})/i);
  if (fromArgs && index.get(fromArgs[1])) return index.get(fromArgs[1]);
  const cwd = path.resolve(t.cwd || '').toLowerCase(), since = (t.meta?.spawnedAt || 0) - 60_000;
  let best = null;
  for (const d of index.docs.values()) {
    if (d.agent !== 'codex' || !d.cwd || d.mtime < since || path.resolve(d.cwd).toLowerCase() !== cwd) continue;
    if (!best || d.mtime > best.mtime) best = d;
  }
  return best;
}
// codex draws "esc to interrupt" under its spinner while a turn runs
const CODEX_BUSY = /esc to interrupt|esc to cancel/i;
function codexStatus(t) {
  if (t.exited !== null) return 'exited';
  let screen = ''; try { screen = readTerm(t, 12).join('\n'); } catch { return null; }
  return CODEX_BUSY.test(screen) ? 'busy' : 'idle';
}
// the conversation a codex terminal is in: newest rollout in the shared sessions folder for its cwd, written since it started
function codexSessionOf(t) {
  const hit = codexDocOf(t);
  if (hit) return hit.id;
  const fromArgs = (t.meta?.args || []).join(' ').match(/resume ([0-9a-f-]{36})/i);
  let best = null;
  const walk = (d, depth) => {
    let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const f = path.join(d, e.name);
      if (e.isDirectory() && depth < 3) walk(f, depth + 1);
      else if (/^rollout-.*\.jsonl$/.test(e.name)) {
        let st; try { st = fs.statSync(f); } catch { continue; }
        if (st.mtimeMs < (t.meta?.spawnedAt || 0) - 60_000 || (best && st.mtimeMs <= best.m)) continue;
        try {
          const first = JSON.parse(fs.readFileSync(f, 'utf8').split('\n', 1)[0]);
          const meta = first.payload || first;
          if (meta.cwd && path.resolve(meta.cwd).toLowerCase() === path.resolve(t.cwd).toLowerCase() && meta.id) best = { id: meta.id, m: st.mtimeMs };
        } catch {}
      }
    }
  };
  const now = new Date(), days = [0, 1].map((k) => new Date(now - k * 864e5));
  for (const d of days) walk(path.join(CA.MAIN, 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')), 3);
  return best?.id || fromArgs?.[1] || null;
}
async function switchCodexTerm({ termId, account = 'auto', prompt }) {
  const t0 = [...terms.values()].find((x) => String(x.id) === String(termId));
  if (!t0) return { ok: false, error: '터미널을 찾을 수 없습니다' };
  const { candidates } = await codexCandidates(t0.account?.id);
  const pick = account === 'auto' ? candidates.find((c) => c.best) : candidates.find((c) => c.id === account);
  if (!pick) return { ok: false, error: account === 'auto' ? '한도에 여유 있는 다른 ChatGPT 계정이 없습니다 (ccd codex add로 추가)' : '알 수 없는 계정' };
  const acc = CA.accounts(USAGE_DIR).find((a) => a.id === pick.id);
  const sid = codexSessionOf(t0);
  if (t0.exited === null) { // Ctrl+C twice quits codex
    t0.proc.write('\x03'); await sleep(400); t0.proc.write('\x03');
    if (!(await waitFor(() => t0.exited !== null, 6000))) try { t0.proc.kill(); } catch {}
  }
  forgetTerm(t0);
  const { cmd: ccmd, args } = codexLaunch(['resume', ...(sid ? [sid] : ['--last']), ...(prompt ? [prompt] : [])]);
  const short = pick.label.replace(/@.*/, '');
  const t = createTerm({ cwd: t0.cwd, cmd: ccmd, args, env: CA.envFor(acc), title: `${String(t0.title || 'codex (GPT)').replace(/ [⇄·] .*$/, '')} ⇄ ${short}`, account: { id: pick.id, label: pick.label, kind: 'codex' } });
  const favs = loadFavs();
  if (favs.includes(`term:${t0.id}`)) fs.writeFileSync(FAV_FILE, JSON.stringify(favs.map((k) => (k === `term:${t0.id}` ? `term:${t.id}` : k))));
  return { ok: true, term: termInfo(t), account: { id: pick.id, label: pick.label, fiveH: pick.fiveH, weekly: pick.weekly }, stopped: `t:${t0.id}`, resumed: sid || 'last' };
}
async function switchAccount({ sessionId, termId, account = 'auto', cont = true, skip = true, interrupt = false, force = false }) {
  if (!sessionId && termId != null && isCodexTerm([...terms.values()].find((x) => String(x.id) === String(termId)))) return switchCodexTerm({ termId, account, prompt: cont ? '계속 진행해' : undefined });
  if (!sessionId && termId != null) return switchTermAccount({ termId, account, skip });
  const d = index.get(sessionId);
  if (d) await index.updateFile(d.file);
  const cons = (await helperCall({ op: 'list' })).consoles || [];
  const loc = locateSession(sessionId, cons);
  const { candidates } = await switchCandidates(loc.account);
  const pick = account === 'auto' ? candidates.find((c) => c.best) : candidates.find((c) => c.id === account);
  if (!pick) return { ok: false, error: account === 'auto' ? '여유 있는 다른 계정이 없습니다 (AI 사용량 확인)' : '알 수 없는 계정' };
  const cwd = d?.cwd || loc.s?.cwd || os.homedir();

  // 1) stop the running instance so two processes never write the same session
  // The limited session never has to answer: resume reads the transcript from disk.
  // It only has to be gone. Exactly one Esc first (interrupts a busy turn or closes a
  // limit/choice menu; two would open the rewind menu), then /exit, then a kill fallback.
  if (loc.live) {
    if (loc.s.status === 'busy' && !interrupt) return { ok: false, busy: true, error: '세션이 작업 중입니다. 중단하고 전환할까요?' };
    const gone = () => !pidAlive(loc.s.pid) || (loc.term && loc.term.exited !== null);
    if (loc.term) {
      loc.term.proc.write('\x1b'); await sleep(1000);
      loc.term.proc.write('/exit'); await sleep(SUBMIT_DELAY); loc.term.proc.write('\r');
      if (!(await waitFor(gone, 8000))) try { loc.term.proc.kill(); } catch {} // our own pty: no need to ask
      await waitFor(gone, 5000);
      forgetTerm(loc.term);
    } else if (loc.console) {
      if (!force) {
        await helperCall({ op: 'send', pid: loc.console.id, keys: ['esc'] }); await sleep(1000);
        await helperCall({ op: 'send', pid: loc.console.id, text: '/exit' });
        await sleep(SUBMIT_DELAY);
        await helperCall({ op: 'send', pid: loc.console.id, keys: ['enter'] });
      }
      if (!(await waitFor(gone, force ? 1000 : 15000))) {
        if (!force) return { ok: false, stuck: true, error: '기존 창의 claude가 /exit에 반응하지 않습니다. 그 claude 프로세스만 강제 종료하고 전환할까요? (대화 기록은 보존됨)' };
        // kill only that claude.exe (the window's shell stays), transcript is append-only so nothing is lost
        try { process.kill(loc.s.pid); } catch {}
        if (!(await waitFor(gone, 8000))) return { ok: false, error: `claude(pid ${loc.s.pid})를 종료하지 못했습니다.` };
      }
    }
    if (!gone()) return { ok: false, error: '기존 세션이 아직 실행 중입니다.' };
  }

  // 2) resume under the chosen account
  const env = {};
  if (pick.id !== 'default') {
    const acc = tokenAccounts().find((a) => a.id === pick.id);
    try { env.CLAUDE_CODE_OAUTH_TOKEN = acc.token(); } catch (e) { return { ok: false, error: `토큰을 읽지 못함: ${e.message}` }; }
  }
  const args = ['--resume', sessionId, ...(skip ? ['--dangerously-skip-permissions'] : [])];
  // is this session a research director? then it stays one on the new account
  let project = null;
  try { project = require('../research-harness/lib/project').listProjects().find((p) => p.state.director_session_id === sessionId) || null; } catch {}
  if (project) Object.assign(env, { RESEARCH_ROLE: 'director', CLAUDE_CODE_STOP_HOOK_BLOCK_CAP: '200' });
  const short = pick.label.replace(/@.*/, '');
  const t = createTerm({ cwd, cmd: 'claude.exe', args, env, title: `${d?.title || d?.firstPrompt?.split('\n')[0].slice(0, 40) || sessionId.slice(0, 8)} ⇄ ${short}`,
    account: { id: pick.id, label: pick.label }, research: project ? project.dir : null });
  if (project) {
    t.research = project.dir;
    require('../research-harness/lib/project').updateState(project.dir, (s) => {
      s.director_account = pick.id === 'default' ? null : pick.id;
      s.status = 'running'; s.wake_at = null; s.wait_reason = ''; s.limited = false; s.limit_notice_at = null;
    });
  }

  // 3) optionally nudge it to carry on once the input box is up
  if (cont) (async () => {
    if (await waitFor(() => t.exited === null && inputReady(t), 45000, 700)) {
      await sleep(600);
      t.proc.write('계속 진행해'); await sleep(SUBMIT_DELAY); t.proc.write('\r');
    }
  })();
  return { ok: true, term: termInfo(t), account: { id: pick.id, label: pick.label, fiveH: pick.fiveH, weekly: pick.weekly }, stopped: loc.live ? (loc.term ? `t:${loc.term.id}` : `c:${loc.console?.id}`) : null };
}

const agentOf = (t) => (/claude(\.exe)?$/i.test(t.meta?.cmd || '') ? 'claude' : isCodexTerm(t) ? 'codex' : /cursor-agent/i.test((t.meta?.args || []).join(' ')) ? 'cursor' : null);
const termInfo = (t) => ({ id: t.id, title: t.title, liveTitle: t.liveTitle, account: t.account, agent: agentOf(t), operator: !!t.meta?.operator, claude: /claude(\.exe)?$/i.test(t.meta?.cmd || ''), codex: isCodexTerm(t),
  ...(isCodexTerm(t) ? { status: codexStatus(t) } : {}), cwd: t.cwd, pid: t.pid, exited: t.exited, cols: t.cols, rows: t.rows });

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/manifest+json', '.svg': 'image/svg+xml' };
const STATIC = {
  '/xterm.js': 'node_modules/@xterm/xterm/lib/xterm.js',
  '/xterm.css': 'node_modules/@xterm/xterm/css/xterm.css',
  '/addon-fit.js': 'node_modules/@xterm/addon-fit/lib/addon-fit.js',
};

function send(res, code, obj) {
  if (obj && typeof obj === 'object' && I18N.language() === 'en') {
    for (const k of ['error', 'note', 'warning', 'hint']) if (typeof obj[k] === 'string') obj[k] = I18N.msg(obj[k]);
    if (Array.isArray(obj.steps)) obj.steps = obj.steps.map(I18N.msg);
  }
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function body(req) {
  return new Promise((resolve) => {
    const chunks = []; req.on('data', (d) => chunks.push(d));
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { resolve({}); } });
  });
}
function authed(req, url) {
  // same-origin only: a page on another site must not drive this API
  const origin = req.headers.origin;
  if (origin && origin !== `http://${req.headers.host}`) return false;
  return url.searchParams.get('t') === TOKEN || req.headers['x-token'] === TOKEN;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  if (p === '/' || STATIC[p] || p === '/app.js' || p === '/calendar.js' || p === '/manifest.json' || p === '/icon.svg') {
    const file = p === '/' ? 'public/index.html' : STATIC[p] || 'public' + p;
    // This PC, any browser/profile: the page opened at http://127.0.0.1:<port> or localhost from this machine gets the
    // token without a ?t= link. The Host check stops DNS rebinding (another site's name pointing at 127.0.0.1); other
    // sites can't read this page anyway (no CORS).
    const local = p === '/' && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)
      && new RegExp(`^(127\\.0\\.0\\.1|localhost|\\[::1\\]):${PORT}$`).test(req.headers.host || '');
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    const text = file.startsWith('public/') ? I18N.forFile(path.join(__dirname, file)) : null;
    if (local) return res.end((text ?? fs.readFileSync(path.join(__dirname, file), 'utf8')).replace('<head>', `<head><script>window.__CCD_LOCAL_TOKEN=${JSON.stringify(TOKEN)};window.__ACH_LANG=${JSON.stringify(I18N.language())};</script>`));
    if (text != null) return res.end(text);
    return fs.createReadStream(path.join(__dirname, file)).pipe(res);
  }
  if (!p.startsWith('/api/')) return send(res, 404, { error: 'not found' });
  if (p === '/api/calendar/google/callback') return calendarMod.oauthCallback(url, res).catch((e) => send(res, 500, { error: e.message }));
  if (!authed(req, url)) return send(res, 401, { error: 'bad token' });
  if (req.method === 'POST') overviewStale();

  try {
    if (p === '/api/overview') return send(res, 200, await overviewSnapshot());
    // sidebar favorites, shared by every device that opens the dashboard: "sid:<session id>" or "term:<id>"
    if (p === '/api/favorites' && req.method === 'POST') {
      const b = await body(req);
      const key = String(b.key || '');
      if (!/^(sid:[\w-]{8,64}|term:\d{1,6})$/.test(key)) return send(res, 400, { error: 'bad key' });
      const favs = loadFavs().filter((k) => k !== key);
      if (b.on) favs.unshift(key);
      fs.writeFileSync(FAV_FILE, JSON.stringify(favs.slice(0, 50)));
      return send(res, 200, { favs: loadFavs() });
    }
    if (p === '/api/recent') {
      const n = Number(url.searchParams.get('n') || 40), auto = url.searchParams.get('auto') === '1';
      return send(res, 200, { sessions: index.ready ? index.recent(n, auto) : recentSessions(n) });
    }
    if (p === '/api/transcript') {
      const id = url.searchParams.get('id'), at = Number(url.searchParams.get('at') ?? -1);
      const d = index.get(id);
      if (d) await index.updateFile(d.file);
      return send(res, 200, transcriptFromIndex(id, at) || transcript(id));
    }
    if (p === '/api/search') {
      const q = (url.searchParams.get('q') || '').trim();
      if (!q) return send(res, 200, { sessions: [], screens: [] });
      const t0 = Date.now();
      const opts = { role: url.searchParams.get('role') || 'all', includeAuto: url.searchParams.get('auto') === '1', cwd: url.searchParams.get('cwd') || '', agent: url.searchParams.get('agent') || '' };
      const sessions = index.search(q, opts);
      const screens = url.searchParams.get('screens') === '0' ? [] : await searchScreens(q);
      return send(res, 200, { sessions, screens, ms: Date.now() - t0, ready: index.ready, progress: index.progress });
    }
    if (p === '/api/console/read') return send(res, 200, await helperCall({ op: 'read', pid: Number(url.searchParams.get('pid')), lines: 300 }));
    if (p === '/api/console/send' && req.method === 'POST') {
      const b = await body(req);
      const pid = Number(b.pid);
      let r = await helperCall({ op: 'send', pid, text: b.text || '', keys: b.keys || [] });
      if (r.ok && b.submit) { await sleep(consoleSubmitDelay(b.text)); r = await helperCall({ op: 'send', pid, keys: ['enter'] }); }
      return send(res, 200, r);
    }
    if (p === '/api/term/read') {
      const t = terms.get(url.searchParams.get('id') || '');
      if (!t) return send(res, 404, { ok: false, error: 'no such terminal' });
      return send(res, 200, { ok: true, ...termInfo(t), lines: readTerm(t, Number(url.searchParams.get('lines') || 60)) });
    }
    if (p === '/api/term/send' && req.method === 'POST') {
      const b = await body(req);
      const t = terms.get(String(b.id));
      if (!t || t.exited !== null) return send(res, 404, { ok: false, error: 'no such running terminal' });
      if (b.text) t.proc.write(b.text);
      for (const k of b.keys || []) {
        if (!(k in PTY_KEYS)) return send(res, 400, { ok: false, error: `unknown key ${k}; one of ${Object.keys(PTY_KEYS)}` });
        t.proc.write(PTY_KEYS[k]);
      }
      if (b.submit) { await sleep(SUBMIT_DELAY); t.proc.write('\r'); }
      return send(res, 200, { ok: true });
    }
    // ---- notice board: the operator session (or you) posts; hub terminals running an agent get it typed in ----
    if (p === '/api/notices') return send(res, 200, { notices: readNotices(Number(url.searchParams.get('n')) || 20) });
    if (p === '/api/notice' && req.method === 'POST') {
      const b = await body(req);
      const text = String(b.text || '').trim().slice(0, 2000);
      if (!text) return send(res, 400, { error: '공지 내용이 비어 있습니다' });
      return send(res, 200, await postNotice({ text, to: b.to || 'all', boardOnly: !!b.boardOnly, fromPid: Number(b.fromPid) || 0 }));
    }
    // ---- operator session ----
    if (p === '/api/operator') {
      if (req.method === 'POST') { const t = await ensureOperator(true); return t ? send(res, 200, { ok: true, term: termInfo(t) }) : send(res, 500, { error: '관제 세션을 시작하지 못했습니다 (claude / codex CLI 설치 확인)' }); }
      const t = operatorTerm();
      return send(res, 200, { enabled: (CONFIG.operator || {}).enabled !== false, term: t ? termInfo(t) : null, dir: OPERATOR_DIR });
    }
    if (p === '/api/usage') return send(res, 200, await aiUsage(url.searchParams.has('force')));
    // account management, proxied to the usage dashboard (it masks secrets in its replies)
    if (p === '/api/usage/accounts') {
      try {
        if (req.method === 'GET') return send(res, 200, await (await fetch(`${USAGE_URL}/api/accounts`, { signal: AbortSignal.timeout(10_000) })).json());
        const b = await body(req);
        const del = b.action === 'delete';
        const r = await fetch(del ? `${USAGE_URL}/api/accounts/${encodeURIComponent(b.id)}` : `${USAGE_URL}/api/accounts`, {
          method: del ? 'DELETE' : 'POST', headers: { 'content-type': 'application/json', 'x-dashboard': '1' },
          body: del ? undefined : JSON.stringify(b.account || {}), signal: AbortSignal.timeout(15_000),
        });
        usageCache = { at: 0, data: null }; // show the change on the next refresh
        return send(res, r.status, await r.json());
      } catch (e) { return send(res, 502, { error: `AI 사용량 대시보드(${USAGE_URL})에 연결할 수 없음: ${e.message}` }); }
    }
    if (p === '/api/switch/candidates') {
      const cons = (await helperCall({ op: 'list' })).consoles || [];
      const loc = locateSession(url.searchParams.get('id') || '', cons);
      const tt = url.searchParams.get('term') && [...terms.values()].find((x) => String(x.id) === url.searchParams.get('term'));
      if (tt && isCodexTerm(tt)) return send(res, 200, { ...(await codexCandidates(tt.account?.id)), live: tt.exited === null, where: `t:${tt.id}` });
      if (tt) return send(res, 200, { ...(await switchCandidates(tt.account?.id || 'default')), live: tt.exited === null, fresh: true, where: `t:${tt.id}` });
      return send(res, 200, { ...(await switchCandidates(loc.account)), live: loc.live, busy: loc.s?.status === 'busy', where: loc.term ? `t:${loc.term.id}` : loc.console ? `c:${loc.console.id}` : null });
    }
    if (p === '/api/switch' && req.method === 'POST') return send(res, 200, await switchAccount(await body(req)));
    if (p === '/api/remote') {
      const info = remoteInfo();
      const target = info.urls[0] ? `${info.urls[0]}?t=${TOKEN}` : null;
      const qr = target ? await require('qrcode').toString(target, { type: 'svg', margin: 1, width: 240 }) : null;
      return send(res, 200, { ...info, qr, target });
    }
    // GPU leases whose job runs inside one of our terminals would die on shutdown/restart
    if (p === '/api/restart-guard') {
      if (ptyHostPid) return send(res, 200, { atRisk: [], terms: terms.size, note: 'terminals live in the pty host and survive a server restart' });
      const table = await procTable();
      const termPids = new Set([...terms.values()].filter((t) => t.exited === null && t.pid).map((t) => t.pid));
      const atRisk = [];
      for (const t of gpuQ.snapshot().active) {
        if (t.detachedJob || t.survived) continue; // detached job (ccd gpu run ≥ 2026-09-25): outlives the terminal
        const roots = [t.holderPid, t.childPid, ...(t.holderPids || [])].filter(Boolean);
        const inTerm = roots.some((pid) => {
          for (let cur = pid, i = 0; cur && i < 30; i++) { if (termPids.has(cur)) return true; cur = table?.get(cur)?.ppid; }
          return false;
        });
        if (inTerm) atRisk.push({ id: t.id, label: t.label, by: t.requester?.title || null });
      }
      return send(res, 200, { atRisk, terms: termPids.size, tableOk: !!table });
    }
    if (p === '/api/admin/reload' && req.method === 'POST') {
      const b = await body(req);
      try { return send(res, 200, { ok: true, reloaded: reloadModules(b.modules || ['gpu', 'research']) }); }
      catch (e) { return send(res, 500, { ok: false, error: `reload failed (old modules kept): ${e.message}` }); }
    }
    if (p === '/api/lang') {
      if (req.method !== 'POST') return send(res, 200, { lang: I18N.language() });
      const b = await body(req);
      const lang = b.lang === 'en' ? 'en' : 'ko';
      const f = path.join(__dirname, 'config.json');
      let c = {}; try { c = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
      c.lang = lang; fs.writeFileSync(f, JSON.stringify(c, null, 2) + '\n');
      send(res, 200, { ok: true, lang, restarting: true });
      // a fresh server picks the language up; dashboard terminals are not touched
      spawn(process.execPath, [path.join(__dirname, 'ccd.js'), 'restart'], { cwd: __dirname, detached: true, stdio: 'ignore', windowsHide: true }).unref();
      return;
    }
    if (p === '/api/shutdown' && req.method === 'POST') {
      send(res, 200, { ok: true, terms: terms.size });
      index.save(true);
      return setTimeout(() => process.exit(0), 300);
    }
    if (p === '/api/locate' && req.method === 'POST') {
      const b = await body(req);
      return send(res, 200, { path: locateFile({ name: String(b.name || ''), size: Number(b.size), mtime: Number(b.mtime) || 0, cwd: b.cwd }) });
    }
    if (p === '/api/upload' && req.method === 'POST') {
      return send(res, 200, { path: await saveUpload(req, url.searchParams.get('name')) });
    }
    if (p === '/api/console/focus' && req.method === 'POST') {
      const b = await body(req);
      return send(res, 200, await helperCall({ op: 'focus', pid: Number(b.pid) }));
    }
    if (p === '/api/term/new' && req.method === 'POST') {
      const b = await body(req);
      let cmd, args = [], title, codexStart = null;
      if (b.kind === 'claude') {
        cmd = 'claude.exe';
        if (b.resume) args.push('--resume', b.resume);
        // a session still open elsewhere (e.g. the Claude desktop app) continues as a fork: same history, new session id
        if (b.resume && b.fork) args.push('--fork-session');
        if (b.skipPermissions) args.push('--dangerously-skip-permissions');
        if (b.model && /^[\w.\-\[\]]+$/.test(b.model)) args.push('--model', b.model);
        title = b.resume ? `claude --resume ${b.resume.slice(0, 8)}` : 'claude';
      } else if (b.kind === 'codex') {
        // OpenAI Codex CLI (ChatGPT login or API key): config "codex", $CODEX_EXE, the Codex app's binary, else PATH
        const extra = [];
        if (b.resume && /^[\w-]+$/.test(b.resume)) extra.push('resume', b.resume);
        if (b.model && /^[\w.\-]+$/.test(b.model)) extra.push('-m', b.model);
        ({ cmd, args } = codexLaunch(extra));
        title = b.resume ? `codex resume ${b.resume.slice(0, 8)}` : 'codex';
      } else if (b.kind === 'cursor') {
        // Cursor's terminal agent (cursor-agent, a .cmd launcher): config "cursorAgent", else its default install, else PATH
        const ca = [CONFIG.cursorAgent, path.join(os.homedir(), 'AppData', 'Local', 'cursor-agent', 'cursor-agent.cmd')].find((f) => f && fs.existsSync(f)) || 'cursor-agent.cmd';
        cmd = 'cmd.exe'; args = ['/c', ca];
        if (b.resume && /^[\w-]+$/.test(b.resume)) args.push('--resume', b.resume);
        title = 'Cursor agent';
      } else if (b.kind === 'cmd') { cmd = 'cmd.exe'; title = 'cmd'; }
      else { cmd = 'powershell.exe'; args = ['-NoLogo']; title = 'powershell'; }
      // claude finds a session by its project folder, so a resume must start in the
      // session's own cwd (else "trust this folder?" + "no conversation found").
      let cwd = b.cwd;
      if (b.kind === 'codex' && b.resume) { const d = index.get(b.resume); if (d?.cwd) cwd = d.cwd; }
      if (b.kind === 'claude' && b.resume) {
        const d = index.get(b.resume);
        if (d) { await index.updateFile(d.file); if (d.cwd) cwd = d.cwd; }
        const live = liveSessions().find((s) => s.sessionId === b.resume);
        if (live && !b.fork) return send(res, 409, { error: `이 세션은 이미 실행 중입니다 (pid ${live.pid}). 그 창에서 이어가세요.` });
      }
      const t = createTerm({ cwd, cmd, args, title: b.title || title, ...(codexStart || {}) });
      return send(res, 200, termInfo(t));
    }
    // add a ChatGPT login for Codex: `ccd codex add` (device-code login) in a dashboard terminal
    if (p === '/api/codex/add' && req.method === 'POST') {
      const t = createTerm({ cwd: __dirname, cmd: process.execPath, args: ['--use-system-ca', path.join(__dirname, 'ccd.js'), 'codex', 'add'], title: 'Codex 계정 추가' });
      return send(res, 200, termInfo(t));
    }
    if (p === '/api/term/close' && req.method === 'POST') {
      const b = await body(req);
      const t = terms.get(String(b.id));
      if (t) forgetTerm(t);
      return send(res, 200, { ok: true });
    }
    if (p.startsWith('/api/artifact')) {
      const handled = await artifactsMod.handle(p, url, req, res, () => body(req), (code, obj) => send(res, code, obj));
      if (handled !== false) return;
    }
    if (p.startsWith('/api/gpu')) {
      const handled = await gpuQ.handle(p, url, req, () => body(req), (code, obj) => send(res, code, obj));
      if (handled !== false) return;
    }
    if (p.startsWith('/api/calendar')) {
      const handled = await calendarMod.handle(p, url, req, () => body(req), (code, obj) => send(res, code, obj));
      if (handled !== false) return;
    }
    if (research && p.startsWith('/api/research')) {
      const handled = await research.handle(p, url, req, () => body(req), (code, obj) => send(res, code, obj), res);
      if (handled !== false) return;
    }
    return send(res, 404, { error: 'unknown api' });
  } catch (e) {
    return send(res, 500, { error: String(e.message || e) });
  }
});

// ---------- WebSocket for managed terminals ----------
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, sock, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const t = terms.get(url.searchParams.get('id') || '');
  if (url.pathname !== '/ws/term' || !authed(req, url) || !t) return sock.destroy();
  wss.handleUpgrade(req, sock, head, (ws) => {
    t.clients.add(ws);
    ws.send(JSON.stringify({ type: 'resize', cols: t.cols, rows: t.rows }));
    ws.send(JSON.stringify({ type: 'data', data: t.buf }));
    if (t.exited !== null) ws.send(JSON.stringify({ type: 'exit', code: t.exited }));
    ws.on('message', (m) => {
      let msg; try { msg = JSON.parse(m); } catch { return; }
      if (t.exited !== null) return;
      if (msg.type === 'input') t.proc.write(msg.data);
      if (msg.type === 'resize' && msg.cols > 0 && msg.rows > 0 && resizeTerm(t, msg.cols, msg.rows)) {
        // keep read-only overview mirrors on the same grid as the pty
        for (const c of t.clients) if (c !== ws) c.send(JSON.stringify({ type: 'resize', cols: t.cols, rows: t.rows }));
      }
    });
    ws.on('close', () => t.clients.delete(ws));
  });
});

// ---------- autonomous research projects (research-harness) ----------
// ---------- GPU / resource queue ----------
function describePid(pid) {
  if (!pid) return {};
  const s = liveSessions().find((x) => x.pid === pid);
  if (!s) return { pid };
  const t = [...terms.values()].find((x) => x.pid && x.exited === null && x.liveTitle && x.pid === pid);
  const d = index.get(s.sessionId);
  const first = d?.firstPrompt ? d.firstPrompt.split('\n')[0].slice(0, 60) : null;
  return { pid, session: s.sessionId, title: (t && t.liveTitle.replace(/^[^\p{L}\p{N}]+\s*/u, '')) || d?.title || first || s.name, cwd: s.cwd };
}
async function procTable() {
  const r = await helperCall({ op: 'procs' });
  if (!r.ok || !r.procs) return null;
  return new Map(r.procs.map(([pid, name, ppid]) => [pid, { name, ppid }]));
}
let consoleTitleCache = new Map();
// The GPU queue and the research watchdog are built by factories so they can be
// hot-reloaded (POST /api/admin/reload) without restarting the server — a restart
// closes every dashboard terminal. Their state lives in files, so nothing is lost.
function makeGpuQ() {
  // re-read config.json so `ccd reload` picks up added/changed GPU servers
  const config = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')); } catch { return CONFIG; } })();
  return require('./gpu')({ dir: __dirname, file: PORT === 7777 ? 'gpu-queue.json' : `gpu-queue-${PORT}.json`, config, pidAlive, describePid,
    procTable: async () => {
      const t = await procTable();
      // refresh window titles for the owner lookup of jobs without a Claude session
      if (t) { const cons = (await helperCall({ op: 'list' })).consoles || []; consoleTitleCache = new Map(cons.filter((c) => c.visible && !/^[A-Za-z]:[\\/]/.test(c.title)).flatMap((c) => c.pids.map((p) => [p, c.title]))); }
      return t;
    },
    consoleTitleOf: (pids) => { for (const p of pids) if (consoleTitleCache.has(p)) return consoleTitleCache.get(p).replace(/^[^\p{L}\p{N}]+\s*/u, ''); return null; } });
}
const artifactsMod = require('./artifacts')({ dir: __dirname, index });
let gpuQ = makeGpuQ();
gpuQ.start();

const notifier = require('./notify')(CONFIG);
function makeResearch() {
  try { return require('./research')({ terms, createTerm, liveSessions, helperCall, index, aiUsage, readTerm, sleep, SUBMIT_DELAY, termInfo, tokenAccounts,
    notify: notifier.send, switchCandidates, publicUrl: () => { try { return remoteInfo().urls[0]; } catch { return null; } } }); }
  catch (e) { if (e.code !== 'MODULE_NOT_FOUND') console.error('[research]', e.message); return null; }
}
const watchdogOn = PORT === 7777 || process.env.CCD_WATCHDOG === '1'; // only the main instance runs the watchdog (override for tests)
let research = makeResearch();
if (research && watchdogOn) research.start();
// calendar: todo.md deadlines + hub events + Google Calendar sync (hot-reloadable like gpu/research)
function makeCalendar() {
  const config = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')); } catch { return CONFIG; } })();
  return require('./calendar')({ config, port: PORT });
}
let calendarMod = makeCalendar();
if (watchdogOn) calendarMod.start();

function reloadModules(which) {
  const done = [];
  const fresh = (rel) => { const k = require.resolve(rel); delete require.cache[k]; };
  if (which.includes('gpu')) {
    fresh('./gpu');
    const next = makeGpuQ(); // throws on a syntax error → the old instance keeps running
    gpuQ.stop(); gpuQ = next; gpuQ.start(); done.push('gpu');
  }
  if (which.includes('calendar')) {
    fresh('./calendar');
    const next = makeCalendar();
    calendarMod.stop(); calendarMod = next; if (watchdogOn) calendarMod.start(); done.push('calendar');
  }
  if (which.includes('research')) {
    fresh('./research'); try { fresh('../research-harness/lib/project'); } catch {}
    const next = makeResearch();
    if (next) { research?.stop?.(); research = next; if (watchdogOn) research.start(); done.push('research'); }
  }
  return done;
}

// ---------- notice board ----------
// data/notices.md keeps every notice (newest last); `ccd notices` and the operator manual read it.
// A notice is also typed into each running Claude / Codex hub terminal (a busy agent queues it).
const NOTICE_FILE = path.join(__dirname, 'data', 'notices.md');
function readNotices(n = 20) {
  let t = ''; try { t = fs.readFileSync(NOTICE_FILE, 'utf8'); } catch { return []; }
  return t.split(/\n(?=- \[)/).filter((x) => x.startsWith('- [')).slice(-n).map((x) => x.trim());
}
async function postNotice({ text, to = 'all', boardOnly = false, fromPid = 0 }) {
  const at = new Date();
  const stamp = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')} ${at.toTimeString().slice(0, 5)}`;
  fs.mkdirSync(path.dirname(NOTICE_FILE), { recursive: true });
  if (!fs.existsSync(NOTICE_FILE)) fs.writeFileSync(NOTICE_FILE, '# 허브 공지\n\n');
  fs.appendFileSync(NOTICE_FILE, `- [${stamp}] ${text.replace(/\n+/g, ' ')}\n`);
  if (boardOnly) return { ok: true, sent: [] };
  const want = String(to).split(',').map((x) => x.trim()).filter(Boolean);
  const targets = [...terms.values()].filter((t) => t.exited === null && !t.meta?.operator && (!fromPid || t.pid !== fromPid) && ['claude', 'codex'].includes(agentOf(t))
    && (want.includes('all') || want.includes(`t:${t.id}`) || want.includes(t.id)));
  const msg = `[허브 공지 ${stamp.slice(11)}] ${text.replace(/\n+/g, ' ')} — 하던 작업은 그대로 이어가세요. (전체 공지: ccd notices)`;
  for (const t of targets) { t.proc.write(msg); await sleep(SUBMIT_DELAY); t.proc.write('\r'); }
  overviewStale();
  return { ok: true, sent: targets.map((t) => `t:${t.id}`) };
}

// ---------- operator session ----------
// One agent session that looks after this hub: it learns the PC (GPUs, network, disks, accounts, tools),
// keeps operator/ENVIRONMENT.md current, answers your questions and posts notices to the other sessions.
// Started with the hub (config "operator": {"enabled": false} turns it off; "agent": "codex" uses Codex),
// continued from its last conversation after a restart, pinned to the top of the sidebar.
const OPERATOR_DIR = path.join(__dirname, '..', 'operator');
const operatorTerm = () => [...terms.values()].find((t) => t.meta?.operator && t.exited === null);
let operatorStarting = null;
function ensureOperator(force = false) {
  const oc = CONFIG.operator || {};
  if (operatorTerm()) return Promise.resolve(operatorTerm());
  if ((oc.enabled === false && !force) || operatorStarting) return Promise.resolve(operatorStarting ? null : null);
  operatorStarting = (async () => {
    const agent = oc.agent === 'codex' ? 'codex' : 'claude';
    const dirKey = path.resolve(OPERATOR_DIR).toLowerCase();
    // a conversation already held in the operator folder → continue it instead of starting over
    const prior = [...index.docs.values()].some((d) => (d.agent || 'claude') === agent && d.cwd && path.resolve(d.cwd).toLowerCase() === dirKey)
      || (agent === 'claude' && fs.existsSync(path.join(CLAUDE_DIR, 'projects', path.resolve(OPERATOR_DIR).replace(/[^A-Za-z0-9]/g, '-'))));
    const kickoff = '운영 매뉴얼을 읽고 "시작 점검"을 해 주세요.';
    let cmd, args;
    if (Array.isArray(oc.command) && oc.command.length) { cmd = oc.command[0]; args = oc.command.slice(1); } // any other agent CLI
    else if (agent === 'codex') ({ cmd, args } = codexLaunch(prior ? ['resume', '--last'] : [kickoff]));
    else { cmd = 'claude.exe'; args = [...(prior ? ['--continue'] : []), ...(oc.skipPermissions === false ? [] : ['--dangerously-skip-permissions']), ...(prior ? [] : [kickoff])]; }
    const t = createTerm({ cwd: OPERATOR_DIR, cmd, args, title: '🛰 관제 세션', operator: true });
    const favs = loadFavs();
    if (!favs.includes(`term:${t.id}`)) fs.writeFileSync(FAV_FILE, JSON.stringify([`term:${t.id}`, ...favs.filter((k) => !/^term:/.test(k) || terms.has(k.slice(5)))]));
    console.log(`[operator] ${agent} started as t:${t.id}${prior ? ' (continuing its last conversation)' : ''}`);
    return t;
  })().catch((e) => { console.error('[operator]', e.message); return null; }).finally(() => { setTimeout(() => { operatorStarting = null; }, 5000); });
  return operatorStarting;
}
// periodic check: when the operator is idle, ask it to look around (config operator.checkEveryMin, 0 = off)
setInterval(() => {
  const every = Number((CONFIG.operator || {}).checkEveryMin ?? 180);
  const t = operatorTerm();
  if (!every || !t || Date.now() - (t.lastCheckAt || t.meta?.spawnedAt || 0) < every * 60e3) return;
  let scr = ''; try { scr = readTerm(t, 15).join('\n'); } catch { return; }
  if (/esc to interrupt|esc to cancel/i.test(scr)) return; // busy: try again next round
  t.lastCheckAt = Date.now();
  t.proc.write('[정기 점검] 운영 매뉴얼의 "정기 점검"을 해 주세요. 바뀐 것이 없으면 한 줄로만 답하세요.');
  setTimeout(() => t.proc.write('\r'), SUBMIT_DELAY);
}, 60e3).unref();

connectPtyHost().then(() => setTimeout(() => ensureOperator().catch(() => {}), 4000));

// Clients poll every few seconds; with Node's default 5 s keep-alive the server sometimes closes a
// socket just as a request goes out on it ("fetch failed"). Keep idle sockets well past the poll.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;

server.listen(PORT, HOST, () => {
  const u = `http://${HOST}:${PORT}/?t=${TOKEN}`;
  fs.writeFileSync(path.join(__dirname, 'url.txt'), u + '\n');
  console.log('Agent CLI Hub:', u);
});

// ---------- remote access (Tailscale only) ----------
// Besides loopback, listen only on the Tailscale interface (100.64.0.0/10), never
// on the institute LAN. config.json {"remote": "off"} disables it.
const remote = new Map(); // ip -> http.Server
function tailscaleIPs() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const [x, y] = a.address.split('.').map(Number);
      if (x === 100 && y >= 64 && y <= 127) out.push({ ip: a.address, iface: name });
    }
  }
  return out;
}
function syncRemoteListeners() {
  if (CONFIG.remote === 'off') return;
  const want = new Set(tailscaleIPs().map((x) => x.ip));
  for (const [ip, s] of remote) if (!want.has(ip)) { s.close(); remote.delete(ip); }
  for (const ip of want) {
    if (remote.has(ip)) continue;
    const s = http.createServer((req, res) => server.emit('request', req, res));
    s.on('upgrade', (req, sock, head) => server.emit('upgrade', req, sock, head));
    s.on('error', (e) => { console.error('[remote]', ip, e.message); remote.delete(ip); });
    s.listen(PORT, ip, () => console.log(`remote (tailscale): http://${ip}:${PORT}/`));
    remote.set(ip, s);
  }
}
syncRemoteListeners();
setInterval(syncRemoteListeners, 15000);
function remoteInfo() {
  let dns = null;
  try {
    const exe = ['C:\\Program Files\\Tailscale\\tailscale.exe', 'tailscale'].find((p) => p === 'tailscale' || fs.existsSync(p));
    const st = JSON.parse(require('child_process').execFileSync(exe, ['status', '--json'], { timeout: 3000, windowsHide: true }).toString());
    dns = st.Self?.DNSName?.replace(/\.$/, '') || null;
  } catch {}
  const ips = [...remote.keys()];
  const urls = [...(dns ? [`http://${dns}:${PORT}/`] : []), ...ips.map((ip) => `http://${ip}:${PORT}/`)];
  return { enabled: CONFIG.remote !== 'off', listening: ips, urls, tailscaleInstalled: fs.existsSync('C:\\Program Files\\Tailscale\\tailscale.exe') };
}
