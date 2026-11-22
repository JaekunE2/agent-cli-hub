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
const codexRecoveryArgs = require('./terminal-recovery');
const { readSession: readAgySession, agyStatusFromScreen, stripAnsi } = require('./agy-session');
const { createAgyQuotaService, parseAgyQuotaTui } = require('./agy-quota');
const { findAgySwapExe, createAgySwapService } = require('./agy-swap');
const projects = require('./projects')();
const { agents: projectAgents } = require('./project-validation');
const { fingerprint, projectSession, sessionId: validSessionId } = require('./project-history');
const { generatePlan, generateSubtasks, cliModelEffortArgs, inspectWorkspace } = require('./project-plan');
const { scanFloorplan } = require('./workspace-floorplan');
const { runTaskSubChatTurn } = require('./task-subchat');
const { deleteCliRecord, uuid: recordUuid } = require('./delete-cli-record');
const { ownedRoots, verifiedRoot, probeRoot, stopTerminal } = require('./project-stop');
const { pickDirectory } = require('./win-folder-picker');
const {
  forkClaudeJsonlAt,
  editClaudeJsonlAt,
  editCodexJsonlAt,
  writeBranchContextFile,
  createBranchStore,
} = require('./conversation-branches');
let projectPlanning = false;
let projectPlanState = { active: false, agent: '', name: '', startedAt: 0, stage: '', pct: 0, logs: [] };
const taskChatActive = new Map(); // `${projectId}:${taskId}` -> { chatId, agent, stage, startedAt, logs }
const pendingPlanRecords = new Map();
const deletingProjects = new Set();
const { Terminal: HeadlessTerminal } = require('@xterm/headless');

const PORT = Number(process.env.CCD_PORT || 7777);
const HOST = '127.0.0.1';
const SERVER_BUILD_ID = String(Date.now());
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const BRANCH_STORE_FILE = path.join(__dirname, '.branches.json');
const BRANCH_BACKUP_DIR = path.join(__dirname, '.session-backups');
const conversationBranches = createBranchStore(BRANCH_STORE_FILE);
const sessionDisplayTitle = (id, doc) => conversationBranches.getTitle(id) || doc?.title || null;
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
  const sliced = msgs.slice(-maxMsgs);
  const base = Math.max(0, msgs.length - sliced.length);
  const edits = conversationBranches.getMsgEdits(sessionId);
  const patched = sliced.map((m, i) => {
    const ov = edits[String(base + i)];
    return ov ? { ...m, text: String(ov.text || '').slice(0, 4000), edited: true } : m;
  });
  return {
    file,
    title: conversationBranches.getTitle(sessionId) || title,
    messages: patched,
    total: msgs.length,
    base,
    size: fs.statSync(file).size,
    rev: conversationBranches.rev(),
    lineage: conversationBranches.lineageFor(sessionId, (id) => sessionDisplayTitle(id, index.get(id))),
    capabilities: { canNativeFork: true, canRewindEdit: true, canEditSource: true },
  };
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
let lastIndexAt = 0;
const refreshIndex = () => index.refresh().then((r) => { lastIndexAt = Date.now(); return r; });
refreshIndex().then(() => console.log('search index ready:', index.docs.size, 'sessions'));
setInterval(() => refreshIndex(), 10000);

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
  const needAgyPid = [...terms.values()].filter((t) => isAgyTerm(t) && !t.pid && t.exited === null && (!t._pidTryAt || Date.now() - t._pidTryAt > 10_000));
  if (needAgyPid.length && !matchBusy) {
    const now = Date.now();
    for (const t of needAgyPid) t._pidTryAt = now;
    matchBusy = true;
    await matchTermPids(cons.consoles || []).catch(() => {}).finally(() => { matchBusy = false; });
  }
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
  // name dashboard terminals after the session running in them (Claude, Codex, or Antigravity)
  conversationBranches.resolveLinks(terms, termSessionId);
  const termsOut = [...terms.values()].map((t) => {
    const info = termInfo(t);
    const c = t.pid && consoles.find((x) => x.pids.includes(t.pid));
    const s = info.claude && c && live.find((x) => c.pids.includes(x.pid));
    if (t.meta.projectTask) {
      info.sessionId = projectRecord(t);
    } else if (s) {
      const d = index.get(s.sessionId);
      info.sessionId = s.sessionId;
      info.sessionName = sessionDisplayTitle(s.sessionId, d) || d?.firstPrompt?.split('\n')[0].slice(0, 80) || null;
    } else {
      const d = info.agy ? index.get(info.sessionId) : termDocOf(t);
      if (d) {
        info.sessionId = d.id;
        info.sessionName = sessionDisplayTitle(d.id, d) || d.firstPrompt?.split('\n')[0].slice(0, 80) || null;
      } else if (info.codex) {
        const cid = codexSessionOf(t);
        if (cid) info.sessionId = cid;
      }
    }
    const br = conversationBranches.branchMetaFor({
      sessionId: info.sessionId || null,
      termId: t.id,
      lookupTitleFn: (id) => sessionDisplayTitle(id, index.get(id)),
    });
    if (br) info.branch = br;
    return info;
  });
  projects.remember(termsOut.filter(t => t.projectTask && t.sessionId).map(t => ({
    projectId: t.projectTask.projectId, taskId: t.projectTask.taskId, sessionId: t.sessionId,
    agent: t.agent, accountId: t.account?.id, tokens: index.get(t.sessionId)?.tokens,
  })));
  const usageUp = await checkUsageServer();
  const services = {
    hub: { ok: true, port: PORT, pid: process.pid },
    ptyHost: { ok: !!ptyHostPid && pidAlive(ptyHostPid), pid: ptyHostPid || null },
    usage: { ok: usageUp, url: USAGE_URL, hasLocalServer: fs.existsSync(path.join(USAGE_DIR, 'server.js')) },
    agyQuota: { ok: !!agyQuota.get(), refreshing: agyQuota.getFast().refreshing, account: agyQuota.get()?.account || null },
    helper: { ok: !helperMissing, error: helperMissing || null },
  };
  return { live, consoles, terms: termsOut, consoleError: cons.error, favs: liveFavs(), disk: diskLow, consolesOff: CONFIG.consoles === false, services, buildId: SERVER_BUILD_ID };
}

function projectRecord(t) {
  const agent = agentOf(t);
  if (agent === 'codex' && t.matchedProjectSession) return t.matchedProjectSession;
  const sid = projectSession(t, agent, index.docs.values(), agent === 'agy' ? agySessionOf(t) : null);
  if (agent === 'codex') return t.matchedProjectSession ||= sid;
  return sid;
}
function rememberProjectTerm(t) {
  if (t.meta.projectTask) {
    const sid = projectRecord(t);
    projects.remember([{
      projectId: t.meta.projectTask.projectId, taskId: t.meta.projectTask.taskId, sessionId: sid,
      agent: agentOf(t), accountId: t.account?.id, tokens: sid ? index.get(sid)?.tokens : null,
    }]);
  }
}

async function eraseProject(p, stopRunning) {
  const members = [...terms.values()].filter(t => t.meta.projectTask?.projectId === p.id);
  const running = members.filter(t => t.exited === null);
  if (running.length && stopRunning !== true) throw new Error('터미널 종료를 포함해 Project 삭제를 다시 확인하세요.');
  await refreshIndex();
  members.forEach(rememberProjectTerm);
  const targets = await projectStopTargets(running);
  assertNoOtherSession(p.id, new Set(targets.map(({ root }) => root.pid)));
  await Promise.all(targets.map(closeProjectTerminal));
  if (targets.length) await refreshIndex();
  members.forEach(rememberProjectTerm);
  assertNoOtherSession(p.id, new Set());
  const ids = projects.records(p.id);
  let removed = 0;
  for (const id of ids) {
    const doc = index.get(id);
    const agent = doc?.agent || projects.recordAgent(p.id, id);
    if (doc || agent === 'agy') {
      const accountEnv = agent === 'codex' ? projectAccounts.resolve(agent, projects.recordAccount(p.id, id)).env : {};
      if (await deleteCliRecord({ id, agent, file: doc?.file }, {
        claudeRoot: index.root, agyRoots: index.agyRoot, codexExe: codexExe(), env: { ...cleanEnv(), ...accountEnv },
      })) removed++;
      index.docs.delete(id);
      index.dirty = true;
    }
    projects.hide(id);
  }
  projects.remove(p.id, p.revision);
  for (const t of members) if (t.exited !== null) forgetTerm(t);
  overviewStale();
  return removed;
}

function assertNoOtherSession(projectId, ownPids) {
  const active = new Set(liveSessions().filter(s => !ownPids.has(s.pid)).map(s => s.sessionId));
  for (const t of terms.values()) {
    if (t.exited !== null || t.meta.projectTask?.projectId === projectId) continue;
    if (t.meta.projectTask) active.add(projectRecord(t));
    else if (isAgyTerm(t)) active.add(agySessionOf(t));
    else if (isCodexTerm(t)) {
      const args = t.meta.args || [];
      const resume = args.indexOf('resume');
      if (resume >= 0 && recordUuid(args[resume + 1])) active.add(args[resume + 1]);
    }
  }
  if (projects.records(projectId).some(id => active.has(id))) throw new Error('연결된 대화가 다른 터미널에서 실행 중입니다. 다른 터미널은 그대로 유지했습니다.');
}

async function projectStopTargets(termsToClose) {
  if (!termsToClose.length) return [];
  const [host, table] = await Promise.all([ptyCall('/info'), procTable()]);
  if (!table || host.pid !== ptyHostPid || !Array.isArray(host.terms)) throw new Error('Project 터미널 소유자를 확인할 수 없습니다.');
  const children = [...table].filter(([, p]) => p.ppid === host.pid).map(([pid]) => pid);
  const processes = await procInfo(children, true);
  const seen = new Set();
  const targets = [];
  for (const term of termsToClose) {
    const hostTerm = host.terms.find(t => t.id === term.id);
    if (hostTerm && hostTerm.exited !== null) { term.exited = hostTerm.exited; continue; }
    const exe = path.basename(term.meta.cmd || '').toLowerCase();
    if (!hostTerm?.pid && children.some(pid => !processes.get(pid)
      && table.get(pid)?.name?.toLowerCase() === exe && pidAlive(pid))) {
      throw new Error(`터미널 ${term.id}의 실행 정보가 일시적으로 확인되지 않습니다. 잠시 후 다시 삭제해 주세요.`);
    }
    let root = verifiedRoot(term, hostTerm, host.pid, processes);
    if (!root && hostTerm && !hostTerm.pid) {
      root = await probeRoot(ownedRoots(term, hostTerm, host.pid, processes), hostTerm.cols, {
        readWidth: async pid => (await helperCall({ op: 'read', pid, lines: 1 })).width,
        resize: async cols => {
          if (terms.get(term.id) !== term || ptyHostPid !== host.pid) throw new Error('종료 대상 터미널이 변경되었습니다.');
          const result = await ptyPost(term.id, '/resize', { id: term.id, cols, rows: hostTerm.rows });
          if (!result?.ok) throw new Error('종료 대상 터미널의 크기를 확인할 수 없습니다.');
        },
        wait: predicate => waitFor(predicate, 1800, 180),
      });
    }
    if (!root || seen.has(root.pid)) throw new Error(`터미널 ${term.id}의 실행 프로세스를 확인할 수 없어 자동 종료하지 않았습니다.`);
    seen.add(root.pid);
    targets.push({ term, root });
  }
  assertNoProjectGpu(seen, table);
  return targets;
}

function assertNoProjectGpu(pids, table) {
  for (const job of gpuQ.snapshot().active) {
    const roots = [job.holderPid, job.childPid, job.requester?.pid, ...(job.holderPids || [])].filter(Boolean);
    if (roots.some(pid => {
      for (let i = 0; pid && i < 30; i++, pid = table.get(pid)?.ppid) if (pids.has(pid)) return true;
      return false;
    })) throw new Error('Project 터미널의 GPU 작업이 실행 중입니다. 작업이 끝나면 삭제할 수 있습니다.');
  }
}

async function closeProjectTerminal({ term, root }) {
  const alive = () => {
    if (terms.get(term.id) !== term || ptyHostPid !== root.ppid) throw new Error('종료 대상 터미널이 변경되었습니다.');
    return term.exited === null;
  };
  await stopTerminal(term, {
    alive,
    write: data => ptyPost(term.id, '/write', { id: term.id, data }),
    wait: ms => waitFor(() => !alive(), ms, 100),
    terminate: async () => {
      const [fresh, table] = await Promise.all([procInfo([root.pid], true), procTable()]);
      const current = fresh.get(root.pid);
      if (!alive()) return;
      if (!table || !current || current.start !== root.start || current.exe !== root.exe
        || current.cl !== root.cl || current.ppid !== root.ppid || current.ppid !== ptyHostPid
        || /(?:cmd|electron|ChatGPT)\.exe$/i.test(current.exe)) {
        throw new Error(`터미널 ${term.id}가 정상 종료되지 않았습니다. 프로세스를 안전하게 확인할 수 없어 강제 종료하지 않았습니다.`);
      }
      assertNoProjectGpu(new Set([root.pid]), table);
      process.kill(root.pid);
    },
  });
}

function transcriptFromIndex(sessionId, at) {
  const d = index.get(sessionId);
  if (!d) return null;
  conversationBranches.resolveLinks(terms, termSessionId);
  const n = d.msgs.length;
  const start = at >= 0 ? Math.max(0, at - 40) : Math.max(0, n - 80);
  const end = at >= 0 ? Math.min(n, at + 40) : n;
  const edits = conversationBranches.getMsgEdits(sessionId);
  const ag = d.agent || 'claude';
  return {
    title: sessionDisplayTitle(sessionId, d),
    agent: ag,
    cwd: d.cwd,
    size: d.offset,
    rev: conversationBranches.rev(),
    total: n,
    base: start,
    messages: d.msgs.slice(start, end).map((m, idx) => {
      const ov = edits[String(start + idx)];
      return ov
        ? { ...m, text: String(ov.text || '').slice(0, 4000), edited: true }
        : { ...m, text: m.text.slice(0, 4000) };
    }),
    lineage: conversationBranches.lineageFor(sessionId, (id) => sessionDisplayTitle(id, index.get(id))),
    capabilities: {
      canNativeFork: ag === 'claude',
      canRewindEdit: ag === 'claude',
      canEditSource: ag === 'claude' || ag === 'codex',
    },
  };
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
  if (stripAnsi(d).trim()) t.lastOutputAt = Date.now();
  for (const ws of t.clients) ws.send(JSON.stringify({ type: 'data', data: d }));
}
function createTerm({ cwd, cmd, args = [], title, env = {}, account = null, research = null, operator = false, projectTask, projectPrompt }) {
  const id = String(++termSeq);
  if (!cwd || !fs.existsSync(cwd)) cwd = os.homedir();
  // meta is what we need to re-create the terminal after a pty-host restart — never secrets
  const envFlags = Object.fromEntries(Object.entries(env).filter(([k]) => !/TOKEN|KEY|SECRET/i.test(k)));
  if (/\bagy(?:\.exe)?$/i.test(cmd)) {
    const dir = path.join(__dirname, 'data', 'agy-logs');
    fs.mkdirSync(dir, { recursive: true });
    const previous = args.indexOf('--log-file');
    if (previous !== -1) args = args.filter((_, i) => i !== previous && i !== previous + 1);
    args = [...args, '--log-file', path.join(dir, crypto.randomUUID() + '.log')];
  }
  const meta = { title: title || [cmd, ...args].join(' '), cwd, cmd, args, account, research, envFlags, spawnedAt: Date.now(), ...(operator ? { operator: true } : {}) };
  if (projectTask) Object.assign(meta, { projectTask, projectPrompt });
  const t = makeMirror({ id, meta });
  t.spawnResult = ptyPost(id, '/spawn', { id, cmd, args, cwd, env: { ...cleanEnv(), ...env }, cols: 120, rows: 32, meta });
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
async function procInfo(pids, fresh = false) {
  const need = pids.filter(p => Number.isInteger(p) && p > 0 && (fresh || !procInfoCache.has(p)));
  if (fresh) need.forEach(p => procInfoCache.delete(p));
  if (need.length) {
    const filter = need.map((p) => `ProcessId=${p}`).join(' OR ');
    const out = await new Promise((res) => require('child_process').execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Get-CimInstance Win32_Process -Filter "${filter}" | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine,@{n='S';e={$_.CreationDate.ToString('o')}} | ConvertTo-Json -Compress`],
      { timeout: 15000, windowsHide: true }, (e, o) => res(e ? '' : String(o))));
    let arr = []; try { arr = [].concat(JSON.parse(out || '[]')); } catch {}
    for (const x of arr) if (x) procInfoCache.set(x.ProcessId, { cl: x.CommandLine || '', start: x.S ? Date.parse(x.S) : null, exe: x.ExecutablePath, ppid: x.ParentProcessId });
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
    const seenSids = new Set();
    for (const t of [...terms.values()].sort((a, b) => Number(b.id) - Number(a.id))) {
      if (t.exited !== null) continue;
      const c = t.pid && cons.find((x) => x.pids.includes(t.pid));
      const s = c && live.find((x) => c.pids.includes(x.pid));
      const resumed = (t.args || []).includes('--resume') ? t.args[t.args.indexOf('--resume') + 1] : null;
      const sessionId = t.meta.projectTask ? projectRecord(t) : isAgyTerm(t) ? agySessionOf(t) : s?.sessionId || termSessionId(t) || resumed;
      if (sessionId) {
        if (seenSids.has(sessionId)) continue;
        seenSids.add(sessionId);
      }
      list.unshift({ id: t.id, meta: t.meta, sessionId: sessionId || null, busy: s?.status === 'busy' || s?.status === 'shell' });
    }
    for (const t of terms.values()) if (t.meta.projectTask) rememberProjectTerm(t);
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
  const projectIds = new Set(projects.list().map(p => p.id));
  const rawItems = (saved.terms || []).filter(x => x.meta?.cmd && (!x.meta.projectTask || projectIds.has(x.meta.projectTask.projectId)));
  const seenRecoverSids = new Set();
  const items = [];
  for (let i = rawItems.length - 1; i >= 0; i--) {
    const x = rawItems[i];
    const sid = x.sessionId || termSessionId({ meta: x.meta, args: x.meta?.args });
    if (sid) {
      if (seenRecoverSids.has(sid)) continue;
      seenRecoverSids.add(sid);
      x.sessionId = sid;
    }
    items.unshift(x);
  }
  if (!items.length) return;
  const resumed = new Set(items.map((x) => x.sessionId).filter(Boolean));
  console.log(`[pty] recovering ${items.length} terminal(s) from ${saved.savedAt}`);
  for (const x of items) {
    const m = x.meta;
    const isClaude = /claude(\.exe)?$/i.test(m.cmd);
    if (isClaude && !x.sessionId) continue; // a claude that never got a session: nothing to resume
    const env = { ...(m.envFlags || {}) };
    if (m.projectTask && m.account?.id) {
      try { Object.assign(env, projectAccounts.resolve(m.account.kind, m.account.id).env); }
      catch (e) { console.error('[project] restore account:', e.message); continue; }
    } else if (m.account?.id && m.account.id !== 'default') {
      const acc = tokenAccounts().find((a) => a.id === m.account.id);
      if (acc) try { env.CLAUDE_CODE_OAUTH_TOKEN = acc.token(); } catch {}
    }
    let args = isClaude
      ? ['--resume', x.sessionId, ...((m.args || []).includes('--dangerously-skip-permissions') ? ['--dangerously-skip-permissions'] : [])]
      : isCodexTerm({ meta: m }) ? codexRecoveryArgs(m.args || [], x.sessionId) : (m.args || []);
    if (isAgyTerm({ meta: m }) && x.sessionId && !args.includes('--conversation') && !args.includes('--continue')) {
      args = [...args, '--conversation', x.sessionId];
    }
    const t = createTerm({ cwd: m.cwd, cmd: m.cmd, args, title: m.title, env, account: m.account, research: m.research,
      projectTask: m.projectTask, projectPrompt: m.projectPrompt });
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
  const hidden = projects.hidden();
  const ids = loadFavs().filter((k) => k.startsWith('sid:')).map((k) => k.slice(4)).filter((id) => !hidden.has(id) && !already.has(id) && !live.has(id));
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
function termSessionId(t) {
  if (!t) return null;
  if (t.meta?.projectTask) return projectRecord(t) || null;
  if (isAgyTerm(t)) return agySessionOf(t) || null;
  if (isCodexTerm(t)) return codexSessionOf(t) || null;
  const args = t.args || t.meta?.args || [];
  const ri = args.indexOf('--resume');
  if (ri >= 0 && args[ri + 1]) return args[ri + 1];
  const ci = args.indexOf('--conversation');
  if (ci >= 0 && args[ci + 1]) return args[ci + 1];
  const r2 = args.indexOf('resume');
  if (r2 >= 0 && args[r2 + 1] && !args[r2 + 1].startsWith('-')) return args[r2 + 1];
  return t.meta?.sessionId || null;
}

// Close & forget redundant terminals that point to the exact same sessionId, keeping the active/newest one.
function dedupeTermsBySession() {
  const bySid = new Map();
  for (const t of terms.values()) {
    if (t.exited !== null) continue;
    const sid = termSessionId(t);
    if (!sid) continue;
    (bySid.get(sid) || bySid.set(sid, []).get(sid)).push(t);
  }
  const removed = [];
  for (const [sid, list] of bySid.entries()) {
    if (list.length <= 1) continue;
    // Sort so busy terminal comes first, then newest terminal id
    list.sort((a, b) => {
      const aBusy = (isAgyTerm(a) ? agyStatus(a) : isCodexTerm(a) ? codexStatus(a) : '') === 'busy' ? 1 : 0;
      const bBusy = (isAgyTerm(b) ? agyStatus(b) : isCodexTerm(b) ? codexStatus(b) : '') === 'busy' ? 1 : 0;
      if (aBusy !== bBusy) return bBusy - aBusy;
      return Number(b.id) - Number(a.id);
    });
    const keep = list[0];
    for (const dup of list.slice(1)) {
      removed.push({ id: dup.id, sessionId: sid, kept: keep.id });
      forgetTerm(dup);
    }
  }
  return removed;
}
function liveFavs() {
  const hidden = projects.hidden();
  const termMap = new Map([...terms.values()].map((t) => [String(t.id), t]));
  const projIds = new Set(projects.list().map((p) => p.id));
  const raw = loadFavs().filter((k) => {
    if (typeof k !== 'string') return false;
    if (k.startsWith('sid:')) return !hidden.has(k.slice(4));
    if (k.startsWith('term:')) return termMap.has(k.slice(5));
    if (k.startsWith('proj:')) return projIds.has(k.slice(5));
    return false;
  });
  // Deduplicate entries that resolve to the same sessionId (e.g. duplicate recovered AGY terminals,
  // or an exited terminal + its sid: favorite), preferring a live non-exited terminal.
  const bestTermForSid = new Map();
  for (const k of raw) {
    if (!k.startsWith('term:')) continue;
    const t = termMap.get(k.slice(5));
    const sid = termSessionId(t);
    if (!sid) continue;
    const cur = bestTermForSid.get(sid);
    if (!cur || (cur.exited !== null && t.exited === null)) bestTermForSid.set(sid, t);
  }
  const seenSid = new Set();
  const out = [];
  for (const k of raw) {
    if (k.startsWith('term:')) {
      const t = termMap.get(k.slice(5));
      const sid = termSessionId(t);
      if (sid) {
        const best = bestTermForSid.get(sid);
        if (best && String(best.id) !== String(t.id)) continue;
        if (seenSid.has(sid)) continue;
        seenSid.add(sid);
      }
      out.push(k);
    } else if (k.startsWith('sid:')) {
      const sid = k.slice(4);
      if (bestTermForSid.has(sid) || seenSid.has(sid)) continue;
      seenSid.add(sid);
      out.push(k);
    } else {
      out.push(k);
    }
  }
  return out;
}
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
const USAGE_DIR = (() => {
  const localDir = path.resolve(__dirname, '..', 'ai-usage');
  return process.env.CCD_USAGE_DIR || (CONFIG.usageDir && path.resolve(__dirname, CONFIG.usageDir)) || (fs.existsSync(localDir) ? localDir : path.join(os.homedir(), 'ai-usage-dashboard'));
})();
let usageCache = { at: 0, data: null };
let usageServerUp = false, usageCheckAt = 0;
async function checkUsageServer(force = false) {
  if (!force && Date.now() - usageCheckAt < 5000) return usageServerUp;
  usageCheckAt = Date.now();
  try {
    const u = new URL(USAGE_URL);
    const port = Number(u.port) || 4777;
    const host = u.hostname || '127.0.0.1';
    usageServerUp = await new Promise((resolve) => {
      const sock = require('net').createConnection({ host, port });
      const done = (ok) => { try { sock.destroy(); } catch {} resolve(ok); };
      sock.setTimeout(350, () => done(false));
      sock.once('connect', () => done(true));
      sock.once('error', () => done(false));
    });
  } catch { usageServerUp = false; }
  return usageServerUp;
}
async function startUsageServer() {
  if (await checkUsageServer(true)) return { ok: true, alreadyRunning: true, url: USAGE_URL };
  const entry = path.join(USAGE_DIR, 'server.js');
  if (!fs.existsSync(entry)) {
    return { ok: false, error: `AI 사용량 서버 파일(${entry})을 찾을 수 없습니다.` };
  }
  try {
    spawn(process.execPath, ['--no-warnings', '--use-system-ca', entry], {
      cwd: USAGE_DIR,
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    }).unref();
  } catch (e) {
    return { ok: false, error: `AI 사용량 서버 시작 실패: ${e.message}` };
  }
  for (let i = 0; i < 16; i++) {
    await sleep(250);
    if (await checkUsageServer(true)) {
      usageCache = { at: 0, data: null };
      overviewStale();
      return { ok: true, started: true, url: USAGE_URL };
    }
  }
  return { ok: false, error: `AI 사용량 서버(${USAGE_URL})가 시작되었으나 응답하지 않습니다.` };
}
function ensureTrayMonitor() {
  if (process.platform !== 'win32') return false;
  const trayScript = path.resolve(__dirname, '..', 'tray.ps1');
  if (!fs.existsSync(trayScript)) return false;
  try {
    spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', trayScript], {
      cwd: path.dirname(trayScript),
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    }).unref();
    return true;
  } catch { return false; }
}
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
function readUsageAccounts() {
  try { return JSON.parse(fs.readFileSync(path.join(USAGE_DIR, 'accounts.json'), 'utf8')).accounts || []; } catch { return []; }
}
function tokenAccounts() {
  return readUsageAccounts().filter((a) => (a.type === 'claude-token' && (a.token || a.tokenPath)) || (a.type === 'claude' && a.credentialsPath)).map((a) => ({
    id: a.id, label: a.label, type: a.type, credentialsPath: a.credentialsPath,
    token: () => a.type === 'claude-token' ? (a.token || fs.readFileSync(a.tokenPath, 'utf8')).trim() : null,
  }));
}
function geminiAccounts() {
  return readUsageAccounts().filter((a) => a.type === 'gemini').map((a) => ({
    id: a.id, label: a.label,
    apiKey: () => { try { return (a.apiKey || (a.keyPath && fs.readFileSync(a.keyPath, 'utf8')) || '').trim() || null; } catch { return null; } },
  }));
}
function meterPct(acc, re) { const m = (acc?.meters || []).find((x) => re.test(x.name)); return m ? m.usedPercent : null; }
async function switchCandidates(currentId) {
  const u = await aiUsage(false);
  const usageById = new Map((u.accounts || []).map((a) => [a.id, a]));
  const localUsage = (u.accounts || []).find((a) => a.provider === 'Claude' && a.live && /Claude Code/.test(a.label));
  const list = [{ id: 'default', label: 'Claude Code (이 PC)', usage: localUsage },
    ...tokenAccounts().map((a) => ({ id: a.id, label: a.label, usage: usageById.get(a.id) }))];
  // A token can belong to the same account as the PC login; same email = same quota.
  const emailOf = (c) => (c.usage?.email || (c.id === 'default' ? null : c.label) || '').toLowerCase() || null;
  const cur = list.find((c) => c.id === currentId);
  const curEmail = cur && emailOf(cur);
  const out = list.map((c) => {
    const fiveH = meterPct(c.usage, /5시간/), weekly = meterPct(c.usage, /주간 \(전체|주간/);
    const known = c.usage?.ok && (fiveH !== null || weekly !== null);
    // headroom = the tighter of the two limits
    const score = known ? Math.min(100 - (fiveH ?? 0), 100 - (weekly ?? 0)) : 50;
    const reset = (c.usage?.meters || []).find((m) => /5시간/.test(m.name))?.resetsAt || null;
    const current = !!currentId && (c.id === currentId || (!!curEmail && emailOf(c) === curEmail));
    return { id: c.id, agent: 'claude', provider: 'Claude', label: c.label, fiveH, weekly, score, reset, current, sameAccount: current && c.id !== currentId, usable: c.usage?.ok !== false && score > 0 };
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
const agySwapExe = () => findAgySwapExe(CONFIG.agySwap);
const agySwap = createAgySwapService({ exeFn: agySwapExe, envFn: cleanEnv });
function agySwapProjectAccounts() {
  const f = agySwap.getFast();
  return (f.accounts || []).map((a) => {
    const base = a.name ? `${a.name} (${a.email})` : a.email;
    return {
      id: a.id,
      label: a.active ? `● ${base} (현재 활성)` : base,
      email: a.email,
    };
  });
}
async function ensureAgySwap(auth) {
  if (auth?.switchAgySwap && agySwap.available()) {
    await agySwap.switchTo(auth.switchAgySwap);
    agyQuota.noteAccount(auth.switchAgySwap);
  }
}
const projectAccounts = require('./project-accounts')({
  claude: tokenAccounts, codex: () => CA.accounts(USAGE_DIR), agy: () => [...agySwapProjectAccounts(), ...geminiAccounts()], codexEnv: CA.envFor,
});
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
  const cur = currentId ? (ranked.find((a) => a.id === currentId) || (currentId === 'auto-codex' ? ranked.find((a) => a.main) : null)) : null;
  const out = ranked.map((a) => {
    const current = !!cur && (a.id === cur.id || (!!cur.email && a.email === cur.email));
    return { id: a.id, agent: 'codex', provider: 'ChatGPT (Codex)', label: a.label || a.email, email: a.email, fiveH: a.fiveH, weekly: a.weekly, score: a.score, reset: a.reset, current, sameAccount: current && a.id !== cur.id, usable: a.usable };
  });
  const best = out.find((c) => c.usable && !c.current);
  if (best) best.best = true;
  return { candidates: out, stale: !!u.stale, usageAvailable: u.available !== false, codex: true };
}
async function allSwitchCandidates({ sessionId = '', termId = '' }) {
  const cons = (await helperCall({ op: 'list' })).consoles || [];
  const loc = sessionId ? locateSession(sessionId, cons) : { live: false };
  const tt = termId ? [...terms.values()].find((x) => String(x.id) === String(termId)) : loc.term;
  const d = sessionId ? index.get(sessionId) : (tt && isCodexTerm(tt) ? codexDocOf(tt) : null);
  const sourceAgent = tt
    ? (isCodexTerm(tt) ? 'codex' : isAgyTerm(tt) ? 'agy' : 'claude')
    : (d?.agent || 'claude');
  const isLive = tt ? tt.exited === null : !!loc.live;
  // Only mark an account as 'current' (already running on it) when the session/terminal is actively running right now
  const curClaudeId = isLive && sourceAgent === 'claude' ? (tt?.account?.id || loc.account || 'default') : null;
  const curCodexId = isLive && sourceAgent === 'codex' ? (tt?.account?.id || 'auto-codex') : null;
  const curAgyId = isLive && sourceAgent === 'agy' ? (tt?.account?.id || 'agy-cli') : null;
  const curAgyEmail = isLive && sourceAgent === 'agy' ? (tt?.account?.email || null) : null;

  const [clRes, cxRes, u] = await Promise.all([
    switchCandidates(curClaudeId),
    codexCandidates(curCodexId),
    aiUsage(false),
  ]);
  let swapAccounts = agySwap.getFast().accounts || [];
  if (agySwap.available() && !swapAccounts.length) {
    try { swapAccounts = (await agySwap.refresh({ force: false })).accounts || []; } catch {}
  }
  const agyQ = agyQuota.get();
  const agyG0 = agyQ?.groups?.[0];
  const agyFiveH = agyG0?.fiveH ?? null;
  const agyWeekly = agyG0?.weekly ?? null;
  const agyStale = !agyQ?.fetchedAt || (Date.now() - Date.parse(agyQ.fetchedAt)) > 6 * 3600e3;
  const agyScore = (!agyStale && (agyFiveH != null || agyWeekly != null)) ? Math.min(100 - (agyFiveH ?? 0), 100 - (agyWeekly ?? 0)) : 80;
  const swapCands = swapAccounts.map((a) => {
    const g0 = a.groups?.[0];
    const fiveH = g0?.fiveH ?? null;
    const weekly = g0?.weekly ?? null;
    const known = fiveH != null || weekly != null;
    const score = known ? Math.min(100 - (fiveH ?? 0), 100 - (weekly ?? 0)) : 80;
    const current = isLive && sourceAgent === 'agy' && (curAgyEmail ? curAgyEmail.toLowerCase() === a.email.toLowerCase() : (curAgyId === a.id || (curAgyId === 'agy-cli' && a.active)));
    return {
      id: a.id, agent: 'agy', provider: 'Antigravity (agy-swap)',
      label: a.name ? `${a.name} (${a.email})` : a.email, email: a.email,
      fiveH, weekly, score, reset: g0?.fiveHResetAt || null, active: !!a.active,
      current, sameAccount: false, usable: !known || score > 0,
    };
  });
  const agyCands = [
    ...(swapCands.length ? swapCands : [{
      id: 'agy-cli', agent: 'agy', provider: 'Antigravity (Gemini)',
      label: agyQ?.account ? `Antigravity (${agyQ.account})` : 'Antigravity IDE / CLI',
      fiveH: agyFiveH, weekly: agyWeekly, score: agyScore,
      current: curAgyId === 'agy-cli', sameAccount: false, usable: agyStale || agyScore > 0,
    }]),
    ...geminiAccounts().map((g) => {
      const gu = (u.accounts || []).find((a) => a.id === g.id);
      return {
        id: g.id, agent: 'agy', provider: 'Gemini (Antigravity)',
        label: `${g.label} (Gemini)`,
        fiveH: agyFiveH, weekly: agyWeekly, score: agyScore,
        current: curAgyId === g.id, sameAccount: false, usable: gu?.ok !== false,
      };
    }),
  ];

  // Put same-platform accounts first, then the other platforms so cross-platform handoff is 1 click away
  const groups = {
    claude: clRes.candidates.map((c) => ({ ...c, best: false })),
    codex: cxRes.candidates.map((c) => ({ ...c, best: false })),
    agy: agyCands.map((c) => ({ ...c, best: false })),
  };
  const order = sourceAgent === 'codex' ? ['codex', 'claude', 'agy']
    : sourceAgent === 'agy' ? ['agy', 'codex', 'claude']
      : ['claude', 'codex', 'agy'];
  const all = order.flatMap((k) => groups[k]);
  const bestSame = groups[sourceAgent].filter((c) => c.usable && !c.current).sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
  const bestAny = all.filter((c) => c.usable && !c.current).sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
  if (bestSame) bestSame.best = true;
  else if (bestAny) bestAny.best = true;

  return {
    candidates: all,
    sourceAgent,
    stale: !!(clRes.stale || cxRes.stale),
    usageAvailable: clRes.usageAvailable,
    live: isLive,
    fresh: !!tt && !sessionId && !d,
    busy: loc.s?.status === 'busy',
    where: tt ? `t:${tt.id}` : loc.console ? `c:${loc.console.id}` : null,
  };
}
// the conversation a terminal is in, from the search index: explicit resume/conversation id in args/meta,
// else the newest session of that agent for its folder written since the terminal started
function termDocOf(t) {
  if (isAgyTerm(t)) {
    const sid = agySessionOf(t);
    if (sid) return index.get(sid);
  }
  if (t.meta?.sessionId && index.get(t.meta.sessionId)) return index.get(t.meta.sessionId);
  const argStr = (t.meta?.args || []).join(' ');
  const fromArgs = argStr.match(/(?:--resume|resume|--conversation)\s+([0-9a-f-]{8,64})/i);
  if (fromArgs && index.get(fromArgs[1])) return index.get(fromArgs[1]);
  const ag = agentOf(t);
  if (!ag) return null;
  const cwd = path.resolve(t.cwd || '').toLowerCase(), since = (t.meta?.spawnedAt || 0) - 60_000;
  let best = null;
  for (const d of index.docs.values()) {
    if ((d.agent || 'claude') !== ag || !d.cwd || d.mtime < since || path.resolve(d.cwd).toLowerCase() !== cwd) continue;
    if (!best || d.mtime > best.mtime) best = d;
  }
  return best;
}
function agySessionOf(t) {
  const args = t.meta.args || [];
  const log = args.indexOf('--log-file');
  const resume = args.indexOf('--conversation');
  const logged = log >= 0 ? readAgySession(args[log + 1]) : t.pid
    ? readAgySession(path.join(os.homedir(), '.gemini', 'antigravity-cli', 'cli.log'), t.pid) : null;
  return logged || (resume >= 0 ? args[resume + 1] : null);
}
function codexDocOf(t) { return termDocOf(t); }
// codex draws "esc to interrupt" under its spinner while a turn runs
const CODEX_BUSY = /esc to interrupt|esc to cancel/i;
function codexStatus(t) {
  if (t.exited !== null) return 'exited';
  let screen = ''; try { screen = readTerm(t, 12).join('\n'); } catch { return null; }
  return CODEX_BUSY.test(screen) ? 'busy' : 'idle';
}
function agyStatus(t) {
  if (t.exited !== null) return 'exited';
  let screen = ''; try { screen = readTerm(t, 16).join('\n'); } catch { return 'idle'; }
  return agyStatusFromScreen(screen, { exited: t.exited, lastOutputAt: t.lastOutputAt, spawnedAt: t.meta?.spawnedAt });
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
  const { cmd: ccmd, args } = codexLaunch(['--dangerously-bypass-approvals-and-sandbox', 'resume', ...(sid ? [sid] : ['--last']), ...(prompt ? [prompt] : [])]);
  const short = pick.label.replace(/@.*/, '');
  const t = createTerm({ cwd: t0.cwd, cmd: ccmd, args, env: CA.envFor(acc), title: `${String(t0.title || 'codex (GPT)').replace(/ [⇄·] .*$/, '')} ⇄ ${short}`, account: { id: pick.id, label: pick.label, kind: 'codex' } });
  const favs = loadFavs();
  if (favs.includes(`term:${t0.id}`)) fs.writeFileSync(FAV_FILE, JSON.stringify(favs.map((k) => (k === `term:${t0.id}` ? `term:${t.id}` : k))));
  return { ok: true, term: termInfo(t), account: { id: pick.id, label: pick.label, fiveH: pick.fiveH, weekly: pick.weekly }, stopped: `t:${t0.id}`, resumed: sid || 'last' };
}
function writeHandoffFile({ sessionId, d, t0, sourceAgent, targetAgent, cwd }) {
  const dir = path.join(__dirname, 'uploads');
  fs.mkdirSync(dir, { recursive: true });
  const tag = (sessionId || (t0 && `term-${t0.id}`) || String(Date.now())).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 16);
  const file = path.join(dir, `handoff-${tag}.md`);
  const lines = [
    `# 세션 이어받기 맥락 (${sourceAgent.toUpperCase()} → ${targetAgent.toUpperCase()})`,
    `- 원본 세션 ID: ${sessionId || (t0 ? `t:${t0.id}` : 'unknown')}`,
    `- 작업 폴더: ${cwd || ''}`,
    d?.title || d?.firstPrompt ? `- 세션 제목: ${(d.title || d.firstPrompt).split('\n')[0]}` : '',
    '',
    '## 최근 대화 기록 (직전 맥락)',
  ].filter((x) => x !== null);
  if (d?.msgs?.length) {
    const recent = d.msgs.filter((m) => !String(m.text || '').startsWith('⚙')).slice(-10);
    for (const m of recent) {
      const who = m.role === 'user' ? '사용자 (User)' : `이전 에이전트 (${sourceAgent})`;
      const txt = String(m.text || '').replace(/<external_codex_apps_[^>]*>[\s\S]*?<\/external_codex_apps_[^>]*>/gi, '').trim().slice(0, 1500);
      if (txt) lines.push(`\n### [${who}]\n${txt}`);
    }
  } else if (t0) {
    const scr = readTerm(t0, 60).join('\n').trim();
    if (scr) lines.push('\n```text\n' + scr.slice(-3000) + '\n```');
  }
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  return file;
}

function launchExternalWindow({ cwd, title, cmd, args = [], env = {}, openMode = 'external' }) {
  const workCwd = (cwd && fs.existsSync(cwd)) ? cwd : os.homedir();
  if (openMode === 'ide') {
    const ideExe = [
      path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'antigravity', 'Antigravity.exe'),
      path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'cursor', 'Cursor.exe'),
    ].find((f) => fs.existsSync(f)) || agyExe();
    spawn(ideExe, [workCwd], { cwd: workCwd, env: { ...process.env, ...env }, detached: true, stdio: 'ignore', windowsHide: false }).unref();
    return { ok: true, external: true, openMode: 'ide' };
  }
  const q = (s) => (/\s|[&()^|<>"]/.test(String(s)) ? `"${String(s).replace(/"/g, '\\"')}"` : String(s));
  const fullCmd = [q(cmd), ...args.map(q)].join(' ');
  const safeTitle = String(title || 'Agent CLI').replace(/["^&|<>]/g, '');
  spawn('cmd.exe', ['/c', 'start', `"${safeTitle}"`, '/d', workCwd, 'cmd.exe', '/k', fullCmd], {
    cwd: workCwd,
    env: { ...process.env, ...env },
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  }).unref();
  return { ok: true, external: true, openMode: 'external' };
}

async function switchAccount({ sessionId, termId, account = 'auto', cont = false, skip = true, interrupt = false, force = false, openMode = 'dashboard' }) {
  let t0 = termId != null && termId !== '' ? [...terms.values()].find((x) => String(x.id) === String(termId)) : null;
  let sid = sessionId || (t0 && termSessionId(t0)) || '';
  if (!t0 && sid) {
    t0 = [...terms.values()].find((x) => x.exited === null && termSessionId(x) === sid) || null;
  }
  const d = sid ? index.get(sid) : (t0 ? termDocOf(t0) : null);
  if (d) { sid = sid || d.id; if (d.file) await index.updateFile(d.file); }

  const cons = (await helperCall({ op: 'list' })).consoles || [];
  const loc = sid ? locateSession(sid, cons) : { live: false };
  const allInfo = await allSwitchCandidates({ sessionId: sid, termId: t0?.id });
  const { candidates, sourceAgent } = allInfo;
  const pick = account === 'auto' ? (candidates.find((c) => c.best) || candidates.find((c) => c.usable && !c.current)) : candidates.find((c) => c.id === account);
  if (!pick) return { ok: false, error: account === 'auto' ? '여유 있는 다른 계정이 없습니다 (AI 사용량 확인)' : '선택한 계정을 찾을 수 없습니다' };

  const targetAgent = pick.agent || 'claude';
  const samePlatform = sourceAgent === targetAgent;
  const cwd = d?.cwd || t0?.cwd || loc.s?.cwd || os.homedir();

  // Capture cross-platform handoff BEFORE stopping t0 so screen fallback stays pristine
  let handoffPrompt = null;
  if (!samePlatform && (d?.msgs?.length || t0)) {
    const hf = writeHandoffFile({ sessionId: sid, d, t0, sourceAgent, targetAgent, cwd });
    handoffPrompt = cont
      ? `이전 ${sourceAgent.toUpperCase()} 세션의 작업을 이어받았습니다. "${hf}" 파일에 정리된 직전 대화 맥락을 먼저 읽고, 마지막으로 논의하던 작업을 바로 이어서 진행해 주세요.`
      : `이전 ${sourceAgent.toUpperCase()} 세션에서 작업을 넘겨받았습니다. "${hf}" 파일에 정리된 직전 대화 맥락을 먼저 읽고, 현재까지의 진행 상황을 간단히 파악한 뒤 다음 지시를 기다려 주세요.`;
  }

  // Preserve prior CLI tokens in the Project ledger before stopping t0!
  const inheritedProjectTask = t0?.meta?.projectTask || null;
  if (t0 && inheritedProjectTask) {
    if (d?.file) await index.updateFile(d.file).catch(() => {});
    rememberProjectTerm(t0);
    if (sid) {
      projects.remember([{
        projectId: inheritedProjectTask.projectId, taskId: inheritedProjectTask.taskId,
        sessionId: sid, agent: sourceAgent, accountId: t0.account?.id, tokens: index.get(sid)?.tokens,
      }]);
    }
  }

  // 1) Stop running instance(s) if live (including any duplicate dashboard terminals for the same sessionId)
  const matchingTerms = [...terms.values()].filter((x) => (t0 && x.id === t0.id) || (sid && termSessionId(x) === sid));
  if (matchingTerms.length && openMode === 'dashboard') {
    for (const tm of matchingTerms) {
      if (tm.exited === null) {
        if (isCodexTerm(tm)) { tm.proc.write('\x03'); await sleep(350); tm.proc.write('\x03'); }
        else if (isAgyTerm(tm)) { tm.proc.write('\x03'); await sleep(250); tm.proc.write('/exit'); await sleep(SUBMIT_DELAY); tm.proc.write('\r'); }
        else { tm.proc.write('\x1b'); await sleep(350); tm.proc.write('/exit'); await sleep(SUBMIT_DELAY); tm.proc.write('\r'); }
        if (!(await waitFor(() => tm.exited !== null, 4500))) try { tm.proc.kill(); } catch {}
      }
      forgetTerm(tm);
    }
  } else if (loc.live && openMode === 'dashboard') {
    if (loc.s.status === 'busy' && !interrupt) return { ok: false, busy: true, error: '세션이 작업 중입니다. 중단하고 전환할까요?' };
    const gone = () => !pidAlive(loc.s.pid) || (loc.term && loc.term.exited !== null);
    if (loc.term) {
      loc.term.proc.write('\x1b'); await sleep(1000);
      loc.term.proc.write('/exit'); await sleep(SUBMIT_DELAY); loc.term.proc.write('\r');
      if (!(await waitFor(gone, 8000))) try { loc.term.proc.kill(); } catch {}
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
        if (!force) return { ok: false, stuck: true, error: '기존 창의 프로세스가 /exit에 반응하지 않습니다. 강제 종료하고 전환할까요? (대화 기록은 보존됨)' };
        try { process.kill(loc.s.pid); } catch {}
        if (!(await waitFor(gone, 8000))) return { ok: false, error: `기존 프로세스(pid ${loc.s.pid})를 종료하지 못했습니다.` };
      }
    }
  }

  // 2) Build env, command, and arguments for the target platform & account
  let cmd, args = [], env = {};

  if (targetAgent === 'codex') {
    const acc = CA.accounts(USAGE_DIR).find((a) => a.id === pick.id);
    env = CA.envFor(acc);
    const extra = [
      ...(skip ? ['--dangerously-bypass-approvals-and-sandbox'] : []),
      ...(samePlatform && sid
        ? ['resume', sid, ...(cont ? ['계속 진행해'] : [])]
        : samePlatform && t0
          ? ['resume', '--last', ...(cont ? ['계속 진행해'] : [])]
          : handoffPrompt ? [handoffPrompt] : []),
    ];
    ({ cmd, args } = codexLaunch(extra));
  } else if (targetAgent === 'agy') {
    cmd = agyExe();
    if (String(pick.id).startsWith('agyswap:')) {
      try {
        await agySwap.switchTo(pick.email || pick.id);
        agyQuota.noteAccount(pick.email || String(pick.id).slice(8));
        agyQuota.refresh({ force: true }).catch(() => {});
      } catch (e) {
        return { ok: false, error: `Antigravity 계정 전환 실패: ${e.message}` };
      }
    } else {
      const gAcc = geminiAccounts().find((a) => a.id === pick.id);
      const gKey = gAcc?.apiKey?.();
      if (gKey) env = { GEMINI_API_KEY: gKey, GOOGLE_API_KEY: gKey };
    }
    if (samePlatform && sid) args.push('--conversation', sid);
    if (skip) args.push('--dangerously-skip-permissions');
    const agyPrompt = !samePlatform ? handoffPrompt : (cont && sid ? '계속 진행해' : null);
    if (agyPrompt) args.push('--prompt-interactive', agyPrompt);
  } else {
    cmd = 'claude.exe';
    if (pick.id !== 'default') {
      const acc = tokenAccounts().find((a) => a.id === pick.id);
      if (acc?.type === 'claude' && acc.credentialsPath) {
        env.CLAUDE_CONFIG_DIR = path.dirname(acc.credentialsPath);
      } else if (acc) {
        try { env.CLAUDE_CODE_OAUTH_TOKEN = acc.token(); } catch (e) { return { ok: false, error: `토큰을 읽지 못함: ${e.message}` }; }
      }
    }
    if (samePlatform && sid) args.push('--resume', sid);
    if (skip) args.push('--dangerously-skip-permissions');
  }

  const short = (pick.email || pick.label || targetAgent).replace(/@.*/, '');
  const baseTitle = d?.title || d?.firstPrompt?.split('\n')[0].slice(0, 36) || (t0 ? String(t0.title || targetAgent).replace(/ [⇄·] .*$/, '') : sid ? sid.slice(0, 8) : targetAgent);
  const title = `${baseTitle} ⇄ ${short}`;

  if (openMode === 'external' || openMode === 'ide') {
    launchExternalWindow({ cwd, title, cmd, args, env, openMode });
    return { ok: true, external: true, openMode, account: { id: pick.id, label: pick.label, agent: targetAgent, fiveH: pick.fiveH, weekly: pick.weekly } };
  }

  let project = null;
  if (samePlatform && targetAgent === 'claude' && sid) {
    try { project = require('../research-harness/lib/project').listProjects().find((p) => p.state.director_session_id === sid) || null; } catch {}
    if (project) Object.assign(env, { RESEARCH_ROLE: 'director', CLAUDE_CODE_STOP_HOOK_BLOCK_CAP: '200' });
  }
  const t = createTerm({
    cwd, cmd, args, env, title,
    account: { id: pick.id, label: pick.label, kind: targetAgent, ...(pick.email ? { email: pick.email } : {}) },
    research: project ? project.dir : null,
    projectTask: inheritedProjectTask || undefined,
    projectPrompt: inheritedProjectTask ? (handoffPrompt ? fingerprint(handoffPrompt) : t0?.meta?.projectPrompt) : undefined,
  });
  if (t0) {
    const favs = loadFavs();
    if (favs.includes(`term:${t0.id}`)) fs.writeFileSync(FAV_FILE, JSON.stringify(favs.map((k) => (k === `term:${t0.id}` ? `term:${t.id}` : k))));
  }
  if (project) {
    t.research = project.dir;
    require('../research-harness/lib/project').updateState(project.dir, (s) => {
      s.director_account = pick.id === 'default' ? null : pick.id;
      s.status = 'running'; s.wake_at = null; s.wait_reason = ''; s.limited = false; s.limit_notice_at = null;
    });
  }

  // 3) Nudge Claude session once its input prompt is ready (Codex & AGY receive initial prompts via CLI args)
  const promptToSend = targetAgent === 'claude'
    ? (!samePlatform && handoffPrompt ? handoffPrompt : (cont && samePlatform && sid ? '계속 진행해' : null))
    : null;
  if (promptToSend) (async () => {
    const readyCheck = () => t.exited === null && inputReady(t);
    if (await waitFor(readyCheck, 45000, 700)) {
      await sleep(600);
      t.proc.write(promptToSend); await sleep(SUBMIT_DELAY); t.proc.write('\r');
    }
  })();

  return {
    ok: true,
    term: termInfo(t),
    account: { id: pick.id, label: pick.label, agent: targetAgent, fiveH: pick.fiveH, weekly: pick.weekly },
    crossPlatform: !samePlatform,
    stopped: t0 ? `t:${t0.id}` : loc.live ? (loc.term ? `t:${loc.term.id}` : `c:${loc.console?.id}`) : null,
  };
}

const EFFORT_LABELS = {
  '': 'CLI 기본값',
  minimal: '최소 (minimal)',
  low: '낮음 (low)',
  medium: '보통 (medium)',
  high: '높음 (high)',
  xhigh: '매우 높음 (xhigh)',
  ultra: '울트라 (ultra)',
  max: '최대 (max)',
};
let agyModelsCache = { at: 0, list: null };
function readCodexConfigDefaults() {
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), '.codex', 'config.toml'), 'utf8');
    const model = /^\s*model\s*=\s*"([^"]+)"/m.exec(raw)?.[1] || '';
    const effort = /^\s*model_reasoning_effort\s*=\s*"([^"]+)"/m.exec(raw)?.[1] || '';
    const enM = /enabled-reasoning-efforts\s*=\s*\[([^\]]+)\]/m.exec(raw);
    const enabled = enM ? enM[1].match(/"([^"]+)"/g)?.map((s) => s.slice(1, -1)) : null;
    return { model, effort, enabled };
  } catch { return { model: '', effort: '', enabled: null }; }
}
function projectCliOptions() {
  const cx = readCodexConfigDefaults();
  const cxModels = [
    ...(cx.model ? [{ id: cx.model, label: `${cx.model} (현재 기본)` }] : []),
    { id: 'gpt-6.1-sol', label: 'gpt-6.1-sol' },
    { id: 'gpt-5.4', label: 'gpt-5.4' },
    { id: 'gpt-5.4-mini', label: 'gpt-5.4-mini' },
    { id: 'o3', label: 'o3' },
    { id: 'o4-mini', label: 'o4-mini' },
  ].filter((m, i, arr) => arr.findIndex((x) => x.id === m.id) === i);
  const cxEffortIds = ['', ...(cx.enabled?.length ? cx.enabled : ['low', 'medium', 'high', 'xhigh', 'max'])];

  const claudeModels = [
    { id: 'opus', label: 'Claude Opus (최신)' },
    { id: 'sonnet', label: 'Claude Sonnet (최신)' },
    { id: 'haiku', label: 'Claude Haiku (최신)' },
    { id: 'claude-opus-4-6', label: 'claude-opus-4-6' },
    { id: 'claude-sonnet-4-6', label: 'claude-sonnet-4-6' },
  ];
  const claudeEffortIds = ['', 'low', 'medium', 'high', 'xhigh', 'max'];

  const agyDefaultModels = [
    { id: 'gemini-4-neon-high', label: 'Gemini 4 Neon (High)' },
    { id: 'gemini-4-neon-xhigh', label: 'Gemini 4 Neon (XHigh)' },
    { id: 'gemini-4-neon-medium', label: 'Gemini 4 Neon (Medium)' },
    { id: 'gemini-4-argon-high', label: 'Gemini 4 Argon (High)' },
    { id: 'gemini-4-hydrogen-high', label: 'Gemini 4 Hydrogen (High)' },
    { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
    { id: 'claude-opus-5-5-high', label: 'Claude Opus 5.5 (High)' },
    { id: 'claude-sonnet-5-5-high', label: 'Claude Sonnet 5.5 (High)' },
    { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)' },
  ];
  const agyEffortIds = ['', 'low', 'medium', 'high', 'xhigh', 'max'];
  const mapEff = (ids) => [...new Set(ids)].map((id) => ({ id, label: EFFORT_LABELS[id] || id }));

  return {
    codex: { models: cxModels, efforts: mapEff(cxEffortIds), defaultModel: cx.model, defaultEffort: cx.effort },
    claude: { models: claudeModels, efforts: mapEff(claudeEffortIds), defaultModel: '', defaultEffort: '' },
    agy: { models: agyModelsCache.list || agyDefaultModels, efforts: mapEff(agyEffortIds), defaultModel: '', defaultEffort: '' },
    cursor: { models: [], efforts: [{ id: '', label: EFFORT_LABELS[''] }], defaultModel: '', defaultEffort: '' },
  };
}

const PROJECTS_DIR = path.resolve(CONFIG.projectsDir || path.join(__dirname, '..', 'projects'));
function isInsideProjectsDir(dir) {
  if (!dir || !path.isAbsolute(dir)) return false;
  const resolved = path.resolve(dir).toLowerCase();
  const baseDir = PROJECTS_DIR.toLowerCase();
  return resolved === baseDir || resolved.startsWith(baseDir + path.sep);
}
function ensureProjectDir(dir) {
  if (isInsideProjectsDir(dir)) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  }
}

const agyExe = () => [CONFIG.agy, path.join(os.homedir(), 'AppData', 'Local', 'agy', 'bin', 'agy.exe')].find((f) => f && fs.existsSync(f)) || 'agy.exe';
const AGY_QUOTA_FILE = path.join(__dirname, 'agy-quota.json');
const agyQuota = createAgyQuotaService({ file: AGY_QUOTA_FILE, agyExe, envFn: cleanEnv });

const isAgyTerm = (t) => /agy(\.exe)?$/i.test(t?.meta?.cmd || '');
const agentOf = (t) => (/claude(\.exe)?$/i.test(t.meta?.cmd || '') ? 'claude' : isCodexTerm(t) ? 'codex' : isAgyTerm(t) ? 'agy' : /cursor-agent/i.test((t.meta?.args || []).join(' ')) ? 'cursor' : null);
const termInfo = (t) => ({ id: t.id, title: t.title, liveTitle: t.liveTitle, account: t.account, agent: agentOf(t), operator: !!t.meta?.operator, claude: /claude(\.exe)?$/i.test(t.meta?.cmd || ''), codex: isCodexTerm(t), agy: isAgyTerm(t),
  ...(isCodexTerm(t) ? { status: codexStatus(t) } : isAgyTerm(t) ? { status: agyStatus(t) } : {}), ...(isAgyTerm(t) ? { sessionId: agySessionOf(t) } : {}),
  projectTask: t.meta?.projectTask, cwd: t.cwd, pid: t.pid, exited: t.exited, cols: t.cols, rows: t.rows });

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const STATIC = {
  '/ui.js': 'public/ui.js',
  '/projects.js': 'public/projects.js',
  '/project-forms.js': 'public/project-forms.js',
  '/project-plan-form.js': 'public/project-plan-form.js',
  '/project-board.js': 'public/project-board.js',
  '/project-task-form.js': 'public/project-task-form.js',
  '/project-flow.js': 'public/project-flow.js',
  '/project-floorplan.js': 'public/project-floorplan.js',
  '/project-terminals.js': 'public/project-terminals.js',
  '/projects.css': 'public/projects.css',
  '/xterm.js': 'node_modules/@xterm/xterm/lib/xterm.js',
  '/xterm.css': 'node_modules/@xterm/xterm/css/xterm.css',
  '/addon-fit.js': 'node_modules/@xterm/addon-fit/lib/addon-fit.js',
  '/icon-claude.png': 'public/icon-claude.png',
  '/icon-openai.png': 'public/icon-openai.png',
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
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store, no-cache, must-revalidate, max-age=0',
      pragma: 'no-cache',
    });
    const text = file.startsWith('public/') ? I18N.forFile(path.join(__dirname, file)) : null;
    if (p === '/') {
      let html = text ?? fs.readFileSync(path.join(__dirname, file), 'utf8');
      html = html.replace(/((?:src|href)="\/(?:ui|calendar|app|projects|project-[a-z-]+)\.js|(?:href)="\/(?:projects\.css|icon\.svg|manifest\.json))"/g, `$1?v=${SERVER_BUILD_ID}"`);
      if (local) return res.end(html.replace('<head>', `<head><script>window.__CCD_LOCAL_TOKEN=${JSON.stringify(TOKEN)};window.__ACH_LANG=${JSON.stringify(I18N.language())};</script>`));
      return res.end(html);
    }
    if (text != null) return res.end(text);
    return fs.createReadStream(path.join(__dirname, file)).pipe(res);
  }
  if (!p.startsWith('/api/')) return send(res, 404, { error: 'not found' });
  if (p === '/api/calendar/google/callback') return calendarMod.oauthCallback(url, res).catch((e) => send(res, 500, { error: e.message }));
  if (!authed(req, url)) return send(res, 401, { error: 'bad token' });
  if (req.method === 'POST') overviewStale();

  try {
    if (p === '/api/projects/accounts' && req.method === 'GET') {
      const ag = url.searchParams.get('agent');
      if (ag === 'agy' && agySwap.available() && !(agySwap.getFast().accounts || []).length) {
        await agySwap.refresh({ force: false }).catch(() => {});
      }
      return send(res, 200, { accounts: projectAccounts.list(ag) });
    }
    if (p === '/api/fs/dirs' && req.method === 'GET') {
      const reqPath = (url.searchParams.get('path') || '').trim();
      const workspaceParent = path.resolve(__dirname, '..', '..');
      let cur = reqPath && path.isAbsolute(reqPath) ? path.resolve(reqPath) : workspaceParent;
      if (!fs.statSync(cur, { throwIfNoEntry: false })?.isDirectory()) {
        const up = reqPath ? path.dirname(path.resolve(reqPath)) : '';
        cur = (up && fs.statSync(up, { throwIfNoEntry: false })?.isDirectory()) ? up : (fs.existsSync(workspaceParent) ? workspaceParent : os.homedir());
      }
      const parsed = path.parse(cur);
      const parent = cur !== parsed.root ? path.dirname(cur) : null;
      const drives = [];
      for (const ch of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
        const drv = `${ch}:\\`;
        try { if (fs.existsSync(drv)) drives.push(drv); } catch {}
      }
      const skipNames = new Set(['$recycle.bin', 'system volume information', 'node_modules', '.git', '__pycache__', '.venv']);
      const dirs = [];
      const files = [];
      try {
        for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
          if (skipNames.has(e.name.toLowerCase())) continue;
          if (e.isDirectory()) {
            if (e.name.startsWith('.')) continue;
            const full = path.join(cur, e.name);
            const subMarkers = [];
            try {
              if (fs.existsSync(path.join(full, '.git'))) subMarkers.push('Git');
              if (fs.existsSync(path.join(full, 'package.json'))) subMarkers.push('Node.js');
              if (fs.existsSync(path.join(full, 'pyproject.toml')) || fs.existsSync(path.join(full, 'requirements.txt'))) subMarkers.push('Python');
            } catch {}
            dirs.push({ name: e.name, path: full, markers: subMarkers });
          } else if (e.isFile() && files.length < 40) {
            files.push(e.name);
          }
        }
        dirs.sort((a, b) => (b.markers.length - a.markers.length) || a.name.localeCompare(b.name, 'ko'));
      } catch {}

      const quickSet = new Map();
      const addQuick = (pStr, label, kind) => {
        if (!pStr || !path.isAbsolute(pStr)) return;
        const norm = path.resolve(pStr);
        const key = norm.toLowerCase();
        if (quickSet.has(key)) return;
        const st = fs.statSync(norm, { throwIfNoEntry: false });
        if (!st?.isDirectory() && norm !== PROJECTS_DIR) return;
        quickSet.set(key, { path: norm, label: label || path.basename(norm) || norm, kind });
      };
      addQuick(workspaceParent, `${path.basename(workspaceParent)} (상위 폴더)`, 'workspace');
      addQuick(PROJECTS_DIR, 'Agent CLI Hub / projects (내부 폴더)', 'internal');
      for (const pr of projects.list()) addQuick(pr.cwd, `${pr.name} (${path.basename(pr.cwd)})`, 'project');
      const rec = index.ready ? index.recent(50, false, '', projects.hidden()) : [];
      for (const r of rec) {
        if (r.cwd) addQuick(r.cwd, path.basename(r.cwd) || r.cwd, 'recent');
        if (quickSet.size >= 14) break;
      }
      addQuick(os.homedir(), '홈 폴더', 'home');

      const info = inspectWorkspace(cur);
      const targetInfo = reqPath && path.isAbsolute(reqPath) ? inspectWorkspace(path.resolve(reqPath)) : info;
      return send(res, 200, {
        host: os.hostname(),
        current: cur,
        parent,
        drives,
        dirs: dirs.slice(0, 150),
        files,
        quick: [...quickSet.values()],
        info: { exists: info.exists, isExistingProject: info.isExistingProject, fileCount: info.fileCount, markers: info.markers },
        targetInfo: { exists: targetInfo.exists, isExistingProject: targetInfo.isExistingProject, fileCount: targetInfo.fileCount, markers: targetInfo.markers, isInternal: isInsideProjectsDir(reqPath || cur) },
      });
    }
    if (p === '/api/fs/mkdir' && req.method === 'POST') {
      const b = await body(req);
      const parent = String(b.parent || '').trim();
      const name = String(b.name || '').trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, '');
      if (!parent || !path.isAbsolute(parent) || !name) return send(res, 400, { error: '상위 폴더와 새 폴더 이름을 확인하세요.' });
      const target = path.join(path.resolve(parent), name);
      try {
        fs.mkdirSync(target, { recursive: true });
        return send(res, 200, { ok: true, path: target });
      } catch (e) {
        return send(res, 400, { error: `폴더를 생성하지 못했습니다: ${e.message}` });
      }
    }
    if (p === '/api/fs/pick-dir' && req.method === 'POST') {
      const b = await body(req);
      const result = await pickDirectory({
        initialPath: b.path,
        fallbackDir: path.resolve(__dirname, '..', '..'),
        title: '작업할 프로젝트 폴더를 선택하세요',
      });
      return send(res, 200, {
        ok: result.ok,
        path: result.path || null,
        cancelled: !!result.cancelled,
        ...(result.error ? { error: result.error } : {}),
      });
    }
    if (p === '/api/projects/cli-options' && req.method === 'GET') {
      return send(res, 200, { options: projectCliOptions() });
    }
    if (p === '/api/projects/floorplan' && req.method === 'GET') {
      const pid = url.searchParams.get('id') || '';
      const rawCwd = url.searchParams.get('cwd') || '';
      const proj = pid ? projects.list().find((x) => x.id === pid) : null;
      const targetDir = rawCwd || proj?.cwd || '';
      if (!targetDir) return send(res, 400, { error: '분석할 작업 폴더를 찾을 수 없습니다.' });
      return send(res, 200, { ok: true, floorplan: scanFloorplan(targetDir) });
    }
    if (p === '/api/projects/floorplan/report' && req.method === 'POST') {
      const b = await body(req);
      const proj = b.projectId ? projects.list().find((x) => x.id === b.projectId) : null;
      const targetDir = path.resolve(String(b.cwd || proj?.cwd || ''));
      if (!targetDir || !fs.statSync(targetDir, { throwIfNoEntry: false })?.isDirectory()) {
        return send(res, 400, { error: '보고서를 저장할 작업 폴더를 찾을 수 없습니다.' });
      }
      const rawName = path.basename(String(b.filename || 'FLOORPLAN.md')).replace(/[^a-zA-Z0-9._가-힣-]+/g, '-');
      const fileName = /\.md$/i.test(rawName) ? rawName : `${rawName || 'FLOORPLAN'}.md`;
      const outPath = path.join(targetDir, fileName);
      const content = String(b.content || '').trim();
      if (!content) return send(res, 400, { error: '저장할 보고서 내용이 비어 있습니다.' });
      fs.writeFileSync(outPath, content + '\n', 'utf8');
      let pinned = false;
      if (b.sessionId) pinned = !!artifactsMod.pinFile(String(b.sessionId), outPath, `코드 아키텍처 보고서 (${fileName})`);
      return send(res, 200, { ok: true, path: outPath, fileName, pinned });
    }
    if (p === '/api/projects/subtasks' && req.method === 'POST') {
      const b = await body(req);
      if (projectPlanning) return send(res, 409, { error: '작업 흐름을 생성 중입니다. 잠시 기다려 주세요.' });
      const project = projects.list().find((x) => x.id === b.projectId);
      const task = project?.tasks.find((x) => x.id === b.taskId);
      if (!project || !task) return send(res, 404, { error: 'Project 작업을 찾을 수 없습니다.' });
      const effAgent = b.agent || task.agent || project.agent || 'codex';
      if (!['agy', 'claude', 'codex'].includes(effAgent)) return send(res, 400, { error: '서브 작업 자동 분해는 AGY, Claude Code 또는 Codex에서 지원됩니다.' });
      const effAccount = b.account ?? task.account ?? (effAgent === (project.agent || 'codex') ? project.account : '');
      const effModel = b.model ?? (task.model || (effAgent === (project.agent || 'codex') ? project.model : ''));
      const effEffort = b.effort ?? (task.effort || (effAgent === (project.agent || 'codex') ? project.effort : ''));
      let auth;
      try { auth = projectAccounts.resolve(effAgent, effAccount); }
      catch (e) { return send(res, 400, { error: e.message }); }
      projectPlanning = true;
      projectPlanState = { active: true, agent: effAgent, name: task.title, startedAt: Date.now(), stage: '서브 작업 분해 준비 중…', pct: 8, logs: [] };
      const onProgress = (ev) => {
        if (!ev) return;
        if (ev.stage) projectPlanState.stage = ev.stage;
        if (typeof ev.pct === 'number') projectPlanState.pct = Math.max(projectPlanState.pct, Math.min(98, ev.pct));
        if (ev.log) projectPlanState.logs = [...projectPlanState.logs, ev.log].slice(-6);
      };
      let dir;
      try {
        await ensureAgySwap(auth);
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-project-sub-'));
        const exe = effAgent === 'agy' ? agyExe() : effAgent === 'claude' ? 'claude.exe' : codexExe();
        const { tasks, sessionId } = await generateSubtasks(exe, project, task, dir, { ...cleanEnv(), ...auth.env }, {
          agent: effAgent, model: effModel, effort: effEffort, onProgress,
        });
        if (recordUuid(sessionId)) projects.remember([{ projectId: project.id, taskId: task.id, sessionId, agent: effAgent }]);
        projectPlanState.stage = `서브 작업 ${tasks.length}개 생성 완료`;
        projectPlanState.pct = 100;
        return send(res, 200, { tasks });
      } catch (e) {
        console.error('[project-subtasks]', effAgent, e.message);
        return send(res, 502, { error: e.message || '서브 작업을 생성하지 못했습니다.' });
      } finally {
        projectPlanning = false;
        projectPlanState.active = false;
        if (dir) try { fs.rmdirSync(dir); } catch {}
      }
    }
    if (p === '/api/projects/plan/status' && req.method === 'GET') {
      const st = projectPlanState;
      return send(res, 200, {
        active: !!st.active,
        agent: st.agent || '',
        name: st.name || '',
        stage: st.stage || '',
        pct: st.pct || 0,
        elapsedMs: st.startedAt ? Date.now() - st.startedAt : 0,
        logs: st.logs || [],
      });
    }
    if (p === '/api/projects/plan' && req.method === 'POST') {
      const b = await body(req);
      if (projectPlanning) return send(res, 409, { error: '작업 흐름을 생성 중입니다. 잠시 기다려 주세요.' });
      if (!['agy', 'claude', 'codex'].includes(b.agent) || typeof b.goal !== 'string' || !b.goal.trim() || b.goal.length > 6000
        || typeof b.name !== 'string' || !b.name.trim() || b.name.length > 120 || typeof b.cwd !== 'string' || !b.cwd.trim() || b.cwd.length > 1000) {
        return send(res, 400, { error: 'Project 이름, 작업 폴더, 목표 및 설계에 사용할 CLI를 확인하세요.' });
      }
      let auth;
      try { auth = projectAccounts.resolve(b.agent, b.account); }
      catch (e) { return send(res, 400, { error: e.message }); }
      projectPlanning = true;
      projectPlanState = { active: true, agent: b.agent, name: b.name.trim(), startedAt: Date.now(), stage: 'CLI 준비 중…', pct: 8, logs: [] };
      const onProgress = (ev) => {
        if (!ev) return;
        if (ev.stage) projectPlanState.stage = ev.stage;
        if (typeof ev.pct === 'number') projectPlanState.pct = Math.max(projectPlanState.pct, Math.min(98, ev.pct));
        if (ev.log) projectPlanState.logs = [...projectPlanState.logs, ev.log].slice(-6);
      };
      let dir;
      try {
        await ensureAgySwap(auth);
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-project-plan-'));
        const exe = b.agent === 'agy' ? agyExe() : b.agent === 'claude' ? 'claude.exe' : codexExe();
        const { tasks, sessionId } = await generatePlan(exe, b, dir, { ...cleanEnv(), ...auth.env }, { onProgress });
        projectPlanState.stage = `작업 ${tasks.length}개 생성 완료`;
        projectPlanState.pct = 100;
        const now = Date.now();
        for (const [key, record] of pendingPlanRecords) if (record.expires <= now) pendingPlanRecords.delete(key);
        if (recordUuid(sessionId)) pendingPlanRecords.set(tasks[0].id, { sessionId, agent: b.agent, expires: now + 60 * 60_000 });
        return send(res, 200, { tasks });
      } catch (e) {
        console.error('[project-plan]', b.agent, e.message);
        return send(res, 502, { error: e.message || '작업 흐름을 생성하지 못했습니다. 선택한 CLI의 로그인 상태를 확인하고 다시 시도하세요.' });
      } finally {
        projectPlanning = false;
        projectPlanState.active = false;
        if (dir) try { fs.rmdirSync(dir); } catch {}
      }
    }
    if (p === '/api/projects/task-chat' && req.method === 'GET') {
      const projectId = url.searchParams.get('projectId') || '';
      const taskId = url.searchParams.get('taskId') || '';
      const act = taskChatActive.get(`${projectId}:${taskId}`) || null;
      return send(res, 200, {
        chats: projects.listSubChats(projectId, taskId),
        active: act ? { ...act, elapsedMs: Date.now() - act.startedAt } : null,
      });
    }
    if (p === '/api/projects/task-chat' && req.method === 'DELETE') {
      const b = await body(req);
      const removed = projects.deleteSubChat(b.projectId, b.taskId, b.chatId);
      return send(res, 200, { ok: removed, chats: projects.listSubChats(b.projectId, b.taskId) });
    }
    if (p === '/api/projects/task-chat' && req.method === 'POST') {
      const b = await body(req);
      const project = projects.list().find((x) => x.id === b.projectId);
      const task = project?.tasks.find((x) => x.id === b.taskId);
      if (!project || !task) return send(res, 404, { error: 'Project 작업을 찾을 수 없습니다.' });
      const prompt = String(b.prompt || '').trim();
      if (!prompt) return send(res, 400, { error: '메시지를 입력하세요.' });
      const actKey = `${project.id}:${task.id}`;
      if (taskChatActive.has(actKey)) return send(res, 409, { error: '이 태스크의 서브 개발 응답을 생성 중입니다. 잠시 기다려 주세요.' });

      const existingChats = projects.listSubChats(project.id, task.id);
      let chat = b.chatId ? existingChats.find((c) => c.id === b.chatId) : null;
      const effAgent = b.agent || chat?.agent || task.agent || project.agent || 'codex';
      if (!['claude', 'codex', 'agy'].includes(effAgent)) return send(res, 400, { error: '서브 개발 채팅은 Claude Code, Codex, Antigravity를 지원합니다.' });
      const effAccount = b.account ?? chat?.account ?? task.account ?? (effAgent === (project.agent || 'codex') ? project.account : '');
      const effModel = b.model ?? chat?.model ?? (task.model || (effAgent === (project.agent || 'codex') ? project.model : ''));
      const effEffort = b.effort ?? chat?.effort ?? (task.effort || (effAgent === (project.agent || 'codex') ? project.effort : ''));
      let auth;
      try { auth = projectAccounts.resolve(effAgent, effAccount); }
      catch (e) { return send(res, 400, { error: e.message }); }

      ensureProjectDir(project.cwd);
      const workCwd = (project.cwd && fs.existsSync(project.cwd)) ? project.cwd : os.homedir();
      const nowIso = new Date().toISOString();
      if (!chat) {
        chat = {
          id: crypto.randomUUID(),
          title: prompt.split(/\r?\n/)[0].slice(0, 48) || `서브 채팅 #${existingChats.length + 1}`,
          agent: effAgent,
          account: effAccount || '',
          model: effModel || '',
          effort: effEffort || '',
          sessionId: '',
          createdAt: Date.now(),
          messages: [],
        };
      } else {
        chat = { ...chat, agent: effAgent, account: effAccount || '', model: effModel || '', effort: effEffort || '' };
      }
      chat.messages = [...(chat.messages || []), { role: 'user', text: prompt, ts: nowIso }];
      projects.saveSubChat(project.id, task.id, chat);

      const actState = { chatId: chat.id, agent: effAgent, stage: 'CLI 실행 중…', startedAt: Date.now(), logs: [] };
      taskChatActive.set(actKey, actState);
      const exe = effAgent === 'agy' ? agyExe() : effAgent === 'claude' ? 'claude.exe' : codexExe();
      try {
        await ensureAgySwap(auth);
        const resTurn = await runTaskSubChatTurn({
          exe, agent: effAgent, cwd: workCwd, env: { ...cleanEnv(), ...auth.env },
          model: effModel, effort: effEffort, sessionId: chat.sessionId,
          prompt, project, task,
          onProgress: (ev) => {
            if (ev?.stage) actState.stage = ev.stage;
            if (ev?.log) actState.logs = [...actState.logs, ev.log].slice(-5);
            if (ev?.sessionId && !chat.sessionId) chat.sessionId = ev.sessionId;
          },
        });
        if (resTurn.sessionId) chat.sessionId = resTurn.sessionId;
        chat.messages = [...chat.messages, { role: 'assistant', text: resTurn.reply, ts: new Date().toISOString() }];
        const savedChat = projects.saveSubChat(project.id, task.id, chat);
        if (chat.sessionId) {
          const doc = index.get(chat.sessionId);
          if (doc?.file) await index.updateFile(doc.file).catch(() => {});
          projects.remember([{
            projectId: project.id, taskId: task.id, sessionId: chat.sessionId,
            agent: effAgent, accountId: effAccount || 'default',
            tokens: resTurn.tokens || index.get(chat.sessionId)?.tokens,
          }]);
        }
        return send(res, 200, {
          ok: true,
          chat: savedChat,
          chats: projects.listSubChats(project.id, task.id),
          tokens: projects.tokenSummary(project.id, (sid) => index.get(sid)?.tokens),
        });
      } catch (e) {
        chat.messages = [...chat.messages, { role: 'assistant', text: `⚠ ${e.message}`, ts: new Date().toISOString() }];
        const savedChat = projects.saveSubChat(project.id, task.id, chat);
        return send(res, 502, { ok: false, error: e.message, chat: savedChat, chats: projects.listSubChats(project.id, task.id) });
      } finally {
        taskChatActive.delete(actKey);
      }
    }
    if (p === '/api/projects') {
      if (req.method === 'GET') {
        for (const t of terms.values()) if (t.meta?.projectTask) rememberProjectTerm(t);
        const list = projects.list().map((pr) => ({
          ...pr,
          tokens: projects.tokenSummary(pr.id, (sid) => index.get(sid)?.tokens),
          subChats: projects.allSubChats(pr.id),
        }));
        return send(res, 200, { projects: list, defaultCwd: PROJECTS_DIR });
      }
      if (req.method === 'DELETE') {
        const b = await body(req);
        const project = projects.list().find(p => p.id === b.id);
        if (!project || project.revision !== b.revision) return send(res, 409, { error: 'Project가 변경되었습니다. 새로고침 후 다시 삭제하세요.' });
        if (deletingProjects.has(project.id)) return send(res, 409, { error: 'Project 기록을 삭제 중입니다.' });
        deletingProjects.add(project.id);
        try {
          return send(res, 200, { removed: await eraseProject(project, b.stopRunning) });
        } catch (e) { return send(res, 409, { error: e.message }); }
        finally { deletingProjects.delete(project.id); }
      }
      if (req.method === 'POST') {
        try {
          const draft = await body(req);
          if (deletingProjects.has(draft.id)) return send(res, 409, { error: 'Project 기록을 삭제 중입니다.' });
          const project = projects.save(draft);
          ensureProjectDir(project.cwd);
          for (const task of project.tasks) {
            const record = pendingPlanRecords.get(task.id);
            if (!record || record.expires <= Date.now()) continue;
            projects.remember([{ projectId: project.id, sessionId: record.sessionId, agent: record.agent }]);
            pendingPlanRecords.delete(task.id);
          }
          return send(res, 200, { project });
        }
        catch (e) { return send(res, 400, { error: e.message }); }
      }
      return send(res, 405, { error: 'method not allowed' });
    }
    if (p === '/api/overview') return send(res, 200, await overviewSnapshot());
    if (p === '/api/services/usage/start' && req.method === 'POST') {
      const r = await startUsageServer();
      return send(res, r.ok ? 200 : 502, r);
    }
    if (p === '/api/services/tray' && req.method === 'POST') {
      const ok = ensureTrayMonitor();
      return send(res, 200, { ok });
    }
    // sidebar favorites, shared by every device that opens the dashboard: "sid:<session id>" or "term:<id>"
    if (p === '/api/favorites' && req.method === 'POST') {
      const b = await body(req);
      const validKey = (k) => /^(sid:[\w-]{8,64}|term:\d{1,6}|proj:[\w-]{8,64})$/.test(String(k || ''));
      const keys = Array.isArray(b.keys) && b.keys.length ? b.keys.map(String) : [String(b.key || '')];
      if (!keys.every(validKey)) return send(res, 400, { error: 'bad key' });
      const drop = new Set(keys);
      const favs = loadFavs().filter((k) => !drop.has(k));
      if (b.on) favs.unshift(keys[0]);
      fs.writeFileSync(FAV_FILE, JSON.stringify(favs.slice(0, 50)));
      return send(res, 200, { favs: liveFavs() });
    }
    if (p === '/api/recent') {
      const n = Number(url.searchParams.get('n') || 40), auto = url.searchParams.get('auto') === '1';
      if (url.searchParams.get('fresh') === '1' || Date.now() - lastIndexAt > 5000) await refreshIndex();
      conversationBranches.resolveLinks(terms, termSessionId);
      const agent = url.searchParams.get('agent') || '';
      const hidden = projects.hidden();
      const raw = index.ready ? index.recent(n, auto, agent, hidden) : recentSessions(n).filter(s => !hidden.has(s.sessionId) && (!agent || (s.agent || 'claude') === agent));
      const sessions = raw.map((s) => {
        const branch = conversationBranches.branchMetaFor({
          sessionId: s.sessionId,
          lookupTitleFn: (id) => sessionDisplayTitle(id, index.get(id)),
        });
        const customTitle = conversationBranches.getTitle(s.sessionId);
        const fallbackBranchTitle = branch?.isBranch
          ? (branch.branchTitle || (branch.parentTitle ? `(분기) ${String(branch.parentTitle).slice(0, 36)}` : null))
          : null;
        return {
          ...s,
          title: customTitle || fallbackBranchTitle || s.title,
          ...(branch ? { branch } : {}),
        };
      });
      return send(res, 200, { sessions });
    }
    if (p === '/api/recent/hide' && req.method === 'POST') {
      const { id } = await body(req);
      if (!validSessionId(id)) return send(res, 400, { error: '대화 ID가 올바르지 않습니다.' });
      projects.hide(id);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/transcript') {
      const id = url.searchParams.get('id'), at = Number(url.searchParams.get('at') ?? -1);
      if (projects.hidden().has(id)) return send(res, 404, { error: '허브에서 제거한 대화 기록입니다.', hidden: true });
      conversationBranches.resolveLinks(terms, termSessionId);
      let d = index.get(id);
      if (!d && id && Date.now() - lastIndexAt > 1500) {
        await refreshIndex();
        d = index.get(id);
      }
      if (d) await index.updateFile(d.file);
      const out = transcriptFromIndex(id, at) || transcript(id);
      if (out && !out.lineage && id) {
        out.lineage = conversationBranches.lineageFor(id, (sid) => sessionDisplayTitle(sid, index.get(sid)));
      }
      return send(res, 200, out);
    }
    if (p === '/api/transcript/title' && req.method === 'POST') {
      const b = await body(req);
      const id = String(b.id || '').trim();
      const title = String(b.title || '').trim().slice(0, 140);
      if (!validSessionId(id)) return send(res, 400, { error: '대화 ID가 올바르지 않습니다.' });
      const saved = conversationBranches.setTitle(id, title);
      const d = index.get(id);
      if (d) {
        d.title = saved || d.title;
        if ((d.agent || 'claude') === 'claude' && d.file && fs.existsSync(d.file) && saved) {
          try { fs.appendFileSync(d.file, JSON.stringify({ type: 'custom-title', customTitle: saved, sessionId: id }) + '\n', 'utf8'); } catch {}
        }
      }
      overviewStale();
      return send(res, 200, { ok: true, title: saved });
    }
    if ((p === '/api/transcript/fork' || p === '/api/transcript/edit') && req.method === 'POST') {
      const b = await body(req);
      const id = String(b.id || '').trim();
      if (!validSessionId(id)) return send(res, 400, { error: '대화 ID가 올바르지 않습니다.' });
      const d = index.get(id);
      if (d?.file) await index.updateFile(d.file);
      const fallback = !d ? transcript(id, 500) : null;
      const sourceFile = d?.file || fallback?.file || null;
      const sourceAgent = d?.agent || (sourceFile ? 'claude' : '');
      const messages = d?.msgs || fallback?.messages || [];
      if (!messages.length) return send(res, 404, { error: '대화 기록을 찾을 수 없습니다.' });

      const atIndex = Math.max(0, Math.min(messages.length - 1, Number(b.atIndex ?? (messages.length - 1))));
      const cwd = b.cwd || d?.cwd || os.homedir();
      const sourceTitle = sessionDisplayTitle(id, d) || fallback?.title || d?.firstPrompt?.split('\n')[0]?.slice(0, 60) || id.slice(0, 8);
      const isEdit = p === '/api/transcript/edit';
      const mode = isEdit ? String(b.mode || 'fork-edit') : 'fork';
      const newText = String(b.text || b.prompt || '').trim();

      if (isEdit && !newText) return send(res, 400, { error: '수정할 내용을 입력하세요.' });

      // 1) In-place text save (no new terminal launched)
      if (mode === 'save') {
        if (sourceAgent === 'claude' && sourceFile) {
          try {
            editClaudeJsonlAt({ sourceFile, sessionId: id, atIndex, newText, mode: 'save', backupDir: BRANCH_BACKUP_DIR });
            index.docs.delete(id);
            await index.updateFile(sourceFile);
          } catch (e) { return send(res, 400, { error: e.message }); }
        } else if (sourceAgent === 'codex' && sourceFile) {
          try {
            editCodexJsonlAt({ sourceFile, sessionId: id, atIndex, newText, backupDir: BRANCH_BACKUP_DIR });
            index.docs.delete(id);
            await index.updateFile(sourceFile);
          } catch (e) { return send(res, 400, { error: e.message }); }
        } else {
          conversationBranches.setMsgEdit(id, atIndex, newText);
        }
        overviewStale();
        return send(res, 200, { ok: true, mode: 'save' });
      }

      const targetAgent = ['claude', 'codex', 'agy'].includes(b.targetAgent) ? b.targetAgent : (sourceAgent || 'claude');
      let launchAccount;
      try {
        launchAccount = projectAccounts.resolve(targetAgent, String(b.account || ''));
      } catch (e) { return send(res, 400, { error: e.message }); }
      if (launchAccount?.switchAgySwap) {
        try { await ensureAgySwap(launchAccount); }
        catch (e) { return send(res, 502, { error: `Antigravity 계정 전환 실패: ${e.message}` }); }
      } else if (targetAgent === 'agy' && !launchAccount?.account && agySwap.available()) {
        const activeSwap = (agySwap.getFast().accounts || []).find((a) => a.active);
        if (activeSwap) {
          launchAccount = {
            ...launchAccount,
            account: { id: activeSwap.id, label: activeSwap.name ? `${activeSwap.name} (${activeSwap.email})` : activeSwap.email, kind: 'agy', email: activeSwap.email },
          };
        }
      }

      const launchAndDeliver = async ({ agent, resumeId, title, promptToSend }) => {
        let cmd, args = [];
        if (agent === 'codex') {
          const extra = ['--dangerously-bypass-approvals-and-sandbox', ...(resumeId ? ['resume', resumeId] : []), ...(!resumeId && promptToSend ? [promptToSend] : [])];
          ({ cmd, args } = codexLaunch(extra));
        } else if (agent === 'agy') {
          cmd = agyExe();
          if (resumeId) args.push('--conversation', resumeId);
          args.push('--dangerously-skip-permissions');
          if (!resumeId && promptToSend) args.push('--prompt-interactive', promptToSend);
        } else {
          cmd = 'claude.exe';
          if (resumeId) args.push('--resume', resumeId);
          args.push('--dangerously-skip-permissions');
        }
        const term = createTerm({ cwd, cmd, args, env: launchAccount?.env || {}, title, account: launchAccount?.account || null });
        if (promptToSend && (agent === 'claude' || resumeId)) {
          (async () => {
            if (await waitFor(() => term.exited === null && inputReady(term), 45000, 700)) {
              await sleep(600);
              const payload = /\r|\n/.test(promptToSend) ? `\x1b[200~${promptToSend.replace(/\r\n/g, '\n')}\x1b[201~` : promptToSend;
              term.proc.write(payload);
              await sleep(SUBMIT_DELAY);
              term.proc.write('\r');
            }
          })().catch(() => {});
        }
        return term;
      };

      // 2) Rewind & edit original session (Claude JSONL only)
      if (mode === 'rewind-edit') {
        if (sourceAgent !== 'claude' || !sourceFile) {
          return send(res, 400, { error: '원본 되감기 재실행은 Claude 로컬 대화 기록에서만 지원됩니다. (대신 분기해서 재실행을 사용하세요)' });
        }
        const live = liveSessions().find((s) => s.sessionId === id);
        if (live) {
          const openTerm = [...terms.values()].find((x) => x.exited === null && x.pid && consoleOf(live.pid)?.pids?.includes(x.pid));
          if (!openTerm) return send(res, 409, { error: `이 세션이 외부 창(pid ${live.pid})에서 실행 중입니다. 먼저 닫거나 분기 재실행을 사용하세요.` });
          openTerm.proc.write('\x1b'); await sleep(400); openTerm.proc.write('/exit'); await sleep(SUBMIT_DELAY); openTerm.proc.write('\r');
          if (!(await waitFor(() => openTerm.exited !== null, 5000))) try { openTerm.proc.kill(); } catch {}
          forgetTerm(openTerm);
        }
        try {
          editClaudeJsonlAt({ sourceFile, sessionId: id, atIndex, newText, mode: 'rewind', backupDir: BRANCH_BACKUP_DIR });
          conversationBranches.clearMsgEditsFrom(id, atIndex);
          index.docs.delete(id);
          await index.updateFile(sourceFile);
        } catch (e) { return send(res, 400, { error: e.message }); }

        const term = await launchAndDeliver({ agent: 'claude', resumeId: id, title: `${sourceTitle.slice(0, 28)} (되감기)`, promptToSend: newText });
        overviewStale();
        return send(res, 200, { ok: true, mode: 'rewind-edit', term: termInfo(term), childSessionId: id });
      }

      // 3) Fork (at message atIndex inclusive) OR Fork+Edit (before atIndex with edited prompt)
      const inclusive = !isEdit;
      const anchorText = String(messages[atIndex]?.text || '').replace(/\s+/g, ' ').trim().slice(0, 100);
      const branchTitle = isEdit && newText
        ? `(분기) ${newText.replace(/\s+/g, ' ').trim().slice(0, 36)}`
        : `(분기) ${sourceTitle.slice(0, 32)}`;

      if (sourceAgent === 'claude' && targetAgent === 'claude' && sourceFile) {
        let forked;
        try {
          forked = forkClaudeJsonlAt({ sourceFile, cutIndex: atIndex, inclusive, title: branchTitle });
          conversationBranches.setTitle(forked.newSessionId, branchTitle);
          await index.updateFile(forked.file);
        } catch (e) { return send(res, 400, { error: e.message }); }

        const term = await launchAndDeliver({ agent: 'claude', resumeId: forked.newSessionId, title: branchTitle, promptToSend: newText });
        const branch = conversationBranches.addBranch({
          parentSessionId: id,
          childSessionId: forked.newSessionId,
          termId: term.id,
          sourceAgent,
          targetAgent,
          mode,
          atIndex,
          branchTitle,
          anchorText,
          editedText: isEdit ? newText.slice(0, 500) : '',
          native: true,
        });
        overviewStale();
        return send(res, 200, { ok: true, mode, native: true, term: termInfo(term), branch, childSessionId: forked.newSessionId });
      }

      // Context-seeded branch for Codex / AGY / cross-CLI
      const { instruction } = writeBranchContextFile({
        uploadsDir: path.join(__dirname, 'uploads'),
        sourceSessionId: id,
        sourceTitle,
        sourceAgent: sourceAgent || 'claude',
        targetAgent,
        cwd,
        messages,
        atIndex,
        inclusive,
        editedText: isEdit ? newText : '',
        followUp: !isEdit ? newText : '',
      });
      const term = await launchAndDeliver({ agent: targetAgent, resumeId: null, title: branchTitle, promptToSend: instruction });
      const branch = conversationBranches.addBranch({
        parentSessionId: id,
        childSessionId: null,
        termId: term.id,
        sourceAgent: sourceAgent || 'claude',
        targetAgent,
        mode,
        atIndex,
        branchTitle,
        anchorText,
        editedText: isEdit ? newText.slice(0, 500) : '',
        native: false,
      });
      overviewStale();
      return send(res, 200, { ok: true, mode, native: false, term: termInfo(term), branch, childSessionId: null });
    }
    if (p === '/api/search') {
      const q = (url.searchParams.get('q') || '').trim();
      if (!q) return send(res, 200, { sessions: [], screens: [] });
      const t0 = Date.now();
      const opts = { role: url.searchParams.get('role') || 'all', includeAuto: url.searchParams.get('auto') === '1', cwd: url.searchParams.get('cwd') || '', agent: url.searchParams.get('agent') || '', hidden: projects.hidden() };
      const sessions = index.search(q, opts).map((s) => {
        const branch = conversationBranches.branchMetaFor({
          sessionId: s.sessionId,
          lookupTitleFn: (id) => sessionDisplayTitle(id, index.get(id)),
        });
        return {
          ...s,
          title: conversationBranches.getTitle(s.sessionId) || branch?.branchTitle || s.title,
          ...(branch ? { branch } : {}),
        };
      });
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
    if (p === '/api/term/windows') {
      const id = url.searchParams.get('id') || '';
      const pidParam = Number(url.searchParams.get('pid') || 0);
      const t = id ? terms.get(id) : null;
      const pids = [];
      if (t?.pid) pids.push(t.pid);
      if (pidParam > 0) pids.push(pidParam);
      const r = await helperCall({ op: 'list_windows', pids });
      return send(res, 200, { ok: r.ok !== false, windows: r.windows || [], error: r.error || null });
    }
    if (p === '/api/window/shot') {
      const hwnd = Number(url.searchParams.get('hwnd') || 0);
      const maxWidth = Number(url.searchParams.get('w') || 900);
      if (!hwnd) return send(res, 400, { ok: false, error: 'hwnd가 필요합니다.' });
      const r = await helperCall({ op: 'capture_window', hwnd, max_width: maxWidth });
      if (!r.ok || !r.png) return send(res, r.minimized ? 409 : 404, { ok: false, minimized: !!r.minimized, error: r.error || '창을 캡처하지 못했습니다.' });
      const buf = Buffer.from(r.png, 'base64');
      res.writeHead(200, {
        'content-type': 'image/png',
        'cache-control': 'no-store, no-cache, must-revalidate, max-age=0',
        'content-length': buf.length,
      });
      return res.end(buf);
    }
    if (p === '/api/window/focus' && req.method === 'POST') {
      const b = await body(req);
      const hwnd = Number(b.hwnd || 0);
      if (!hwnd) return send(res, 400, { ok: false, error: 'hwnd가 필요합니다.' });
      return send(res, 200, await helperCall({ op: 'focus_window', hwnd }));
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
      return send(res, 200, await allSwitchCandidates({
        sessionId: url.searchParams.get('id') || '',
        termId: url.searchParams.get('term') || '',
      }));
    }
    if (p === '/api/switch' && req.method === 'POST') return send(res, 200, await switchAccount(await body(req)));
    if (p === '/api/term/external' && req.method === 'POST') {
      const b = await body(req);
      const d = b.resume ? index.get(b.resume) : null;
      const cwd = b.cwd || d?.cwd || os.homedir();
      const kind = b.kind || d?.agent || 'claude';
      const yolo = b.skipPermissions !== false;
      let cmd, args = [];
      if (kind === 'codex') {
        ({ cmd, args } = codexLaunch([...(yolo ? ['--dangerously-bypass-approvals-and-sandbox'] : []), ...(b.resume ? ['resume', b.resume] : [])]));
      } else if (kind === 'agy') {
        cmd = agyExe();
        if (b.resume) args.push('--conversation', b.resume);
        if (yolo) args.push('--dangerously-skip-permissions');
      } else {
        cmd = 'claude.exe';
        if (b.resume) args.push('--resume', b.resume);
        if (yolo) args.push('--dangerously-skip-permissions');
      }
      return send(res, 200, launchExternalWindow({
        cwd,
        title: `${kind} ${b.resume ? b.resume.slice(0, 8) : ''}`.trim(),
        cmd,
        args,
        openMode: b.openMode || 'external',
      }));
    }
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
    if ((p === '/api/term/new' || p === '/api/projects/start') && req.method === 'POST') {
      let b = await body(req);
      let projectTask;
      let projectPrompt;
      let launchAccount;
      if (p === '/api/projects/start') {
        if (deletingProjects.has(b.projectId)) return send(res, 409, { error: 'Project 기록을 삭제 중입니다.' });
        const project = projects.list().find(x => x.id === b.projectId);
        const task = project?.tasks.find(x => x.id === b.taskId);
        if (!task) return send(res, 404, { error: 'Project 작업을 찾을 수 없습니다.' });
        if (task.stage === 'done') return send(res, 409, { error: '완료된 작업입니다. 상태를 바꾼 뒤 시작하세요.' });
        projectTask = { projectId: project.id, taskId: task.id };
        const parentTask = task.parentId ? project.tasks.find((x) => x.id === task.parentId) : null;
        const kind = task.agent || parentTask?.agent || project.agent || 'codex';
        const accountId = task.account ?? (parentTask && (!task.agent || task.agent === (parentTask.agent || project.agent)) ? parentTask.account : null) ?? (kind === (project.agent || 'codex') ? project.account : '');
        const model = task.model || (parentTask && (!task.agent || task.agent === (parentTask.agent || project.agent)) ? parentTask.model : '') || (kind === (project.agent || 'codex') ? project.model : '') || '';
        const effort = task.effort || (parentTask && (!task.agent || task.agent === (parentTask.agent || project.agent)) ? parentTask.effort : '') || (kind === (project.agent || 'codex') ? project.effort : '') || '';
        const existing = [...terms.values()].find(t => t.exited === null && t.meta.projectTask?.projectId === project.id
          && t.meta.projectTask.taskId === task.id && agentOf(t) === kind && (t.account?.id || '') === (accountId || ''));
        if (existing) {
          const result = await existing.spawnResult;
          if (result?.error) return send(res, 502, { error: 'CLI를 시작하지 못했습니다. 설치 경로를 확인하세요.' });
          return send(res, 200, { ...termInfo(existing), existing: true });
        }
        if (!projectAgents.includes(kind)) return send(res, 400, { error: '작업 설계에서 CLI를 다시 선택하세요.' });
        ensureProjectDir(project.cwd);
        if (!path.isAbsolute(project.cwd) || !fs.statSync(project.cwd, { throwIfNoEntry: false })?.isDirectory()) {
          return send(res, 400, { error: '작업 설계에서 존재하는 작업 폴더의 전체 경로를 입력하세요.' });
        }
        b = { kind, cwd: project.cwd, title: parentTask ? `${parentTask.title} › ${task.title}` : task.title, skipPermissions: true, model, effort };
        const promptParts = parentTask
          ? [`[상위 작업: ${parentTask.title}]`, parentTask.detail ? parentTask.detail.slice(0, 600) : '', `[서브 개발 작업: ${task.title}]`, task.detail]
          : [task.title, task.detail];
        projectPrompt = fingerprint(promptParts.filter(Boolean).join('\n\n'));
        try { launchAccount = projectAccounts.resolve(kind, accountId); }
        catch (e) { return send(res, 400, { error: e.message }); }
      }
      // If a dashboard terminal is already open for this exact sessionId (and not forking), reuse it instead of spawning a duplicate!
      if (b.resume && !b.fork && !projectTask) {
        const existingTerm = [...terms.values()].find((x) => x.exited === null && termSessionId(x) === b.resume);
        if (existingTerm) {
          return send(res, 200, { ...termInfo(existingTerm), existing: true });
        }
      }
      const yolo = b.skipPermissions !== false;
      let cmd, args = [], title, codexStart = null;
      if (b.kind === 'claude') {
        cmd = 'claude.exe';
        if (projectTask) args.push('--session-id', crypto.randomUUID());
        if (b.resume) args.push('--resume', b.resume);
        // a session still open elsewhere (e.g. the Claude desktop app) continues as a fork: same history, new session id
        if (b.resume && b.fork) args.push('--fork-session');
        if (yolo) args.push('--dangerously-skip-permissions');
        args.push(...cliModelEffortArgs('claude', b.model, b.effort));
        title = b.resume ? `claude --resume ${b.resume.slice(0, 8)}` : 'claude';
      } else if (b.kind === 'codex') {
        // OpenAI Codex CLI (ChatGPT login or API key): config "codex", $CODEX_EXE, the Codex app's binary, else PATH
        const extra = [];
        if (projectTask) extra.push('-c', `shell_environment_policy.set.HUB_PROJECT_RUN_ID="${crypto.randomUUID()}"`);
        if (yolo) extra.push('--dangerously-bypass-approvals-and-sandbox');
        extra.push(...cliModelEffortArgs('codex', b.model, b.effort));
        if (b.resume && /^[\w-]+$/.test(b.resume)) extra.push('resume', b.resume);
        ({ cmd, args } = codexLaunch(extra));
        title = b.resume ? `codex resume ${b.resume.slice(0, 8)}` : 'codex';
      } else if (b.kind === 'cursor') {
        // Cursor's terminal agent (cursor-agent, a .cmd launcher): config "cursorAgent", else its default install, else PATH
        const ca = [CONFIG.cursorAgent, path.join(os.homedir(), 'AppData', 'Local', 'cursor-agent', 'cursor-agent.cmd')].find((f) => f && fs.existsSync(f)) || 'cursor-agent.cmd';
        cmd = 'cmd.exe'; args = ['/c', ca];
        if (b.resume && /^[\w-]+$/.test(b.resume)) args.push('--resume', b.resume);
        title = 'Cursor agent';
      } else if (b.kind === 'agy') {
        cmd = agyExe();
        if (b.resume && /^[\w-]+$/.test(b.resume)) args.push('--conversation', b.resume);
        else if (b.continue) args.push('--continue');
        if (yolo) args.push('--dangerously-skip-permissions');
        args.push(...cliModelEffortArgs('agy', b.model, b.effort));
        title = b.resume ? `agy ${b.resume.slice(0, 8)}` : 'agy';
      } else if (b.kind === 'cmd') { cmd = 'cmd.exe'; title = 'cmd'; }
      else { cmd = 'powershell.exe'; args = ['-NoLogo']; title = 'powershell'; }
      // claude finds a session by its project folder, so a resume must start in the
      // session's own cwd (else "trust this folder?" + "no conversation found").
      let cwd = b.cwd;
      if (b.kind === 'agy' && b.resume) {
        const d = index.get(b.resume);
        if (d?.agent === 'agy' && d.cwd) cwd = d.cwd;
      }
      if (b.kind === 'codex' && b.resume) { const d = index.get(b.resume); if (d?.cwd) cwd = d.cwd; }
      if (b.kind === 'claude' && b.resume) {
        const d = index.get(b.resume);
        if (d) { await index.updateFile(d.file); if (d.cwd) cwd = d.cwd; }
        const live = liveSessions().find((s) => s.sessionId === b.resume);
        if (live && !b.fork) return send(res, 409, { error: `이 세션은 이미 실행 중입니다 (pid ${live.pid}). 그 창에서 이어가세요.` });
      }
      if (launchAccount?.switchAgySwap) {
        try { await ensureAgySwap(launchAccount); }
        catch (e) { return send(res, 502, { error: `Antigravity 계정 전환 실패: ${e.message}` }); }
      } else if (b.kind === 'agy' && !launchAccount?.account && agySwap.available()) {
        const activeSwap = (agySwap.getFast().accounts || []).find((a) => a.active);
        if (activeSwap) {
          launchAccount = {
            ...launchAccount,
            account: {
              id: activeSwap.id,
              label: activeSwap.name ? `${activeSwap.name} (${activeSwap.email})` : activeSwap.email,
              kind: 'agy',
              email: activeSwap.email,
            },
          };
        }
      }
      const t = createTerm({ cwd, cmd, args, title: b.title || title, ...(codexStart || {}), ...launchAccount, projectTask, projectPrompt });
      if (projectTask) {
        const result = await t.spawnResult;
        if (result?.error) {
          terms.delete(t.id);
          return send(res, 502, { error: 'CLI를 시작하지 못했습니다. 설치 경로를 확인하세요.' });
        }
        if (!result) return send(res, 503, { error: '터미널 호스트의 응답이 없습니다. 상태를 확인하세요.' });
        overviewStale();
      }
      return send(res, 200, termInfo(t));
    }
    // add a ChatGPT login for Codex: `ccd codex add` (device-code login) in a dashboard terminal
    if (p === '/api/codex/add' && req.method === 'POST') {
      const t = createTerm({ cwd: __dirname, cmd: process.execPath, args: ['--use-system-ca', path.join(__dirname, 'ccd.js'), 'codex', 'add'], title: 'Codex 계정 추가' });
      return send(res, 200, termInfo(t));
    }
    if (p === '/api/agy/add' && req.method === 'POST') {
      const swapExe = agySwapExe();
      if (!swapExe) return send(res, 400, { error: 'agy-swap이 설치되어 있지 않습니다.' });
      const t = createTerm({ cwd: __dirname, cmd: swapExe, args: ['add'], title: 'Antigravity 계정 추가' });
      return send(res, 200, termInfo(t));
    }
    if (p === '/api/agy/swap' && req.method === 'POST') {
      const b = await body(req);
      if (!agySwap.available()) return send(res, 400, { error: 'agy-swap이 설치되어 있지 않습니다.' });
      try {
        const resSwap = await agySwap.switchTo(b.account);
        const targetEmail = resSwap.account?.email || String(b.account || '').replace(/^agyswap:/i, '').trim();
        if (targetEmail) agyQuota.noteAccount(targetEmail);
        agyQuota.refresh({ force: true }).catch(() => {});
        const restartedTerms = [];
        if (b.restartOpen && targetEmail) {
          const openAgy = [...terms.values()].filter((tm) => tm.exited === null && isAgyTerm(tm) && tm.account?.email?.toLowerCase() !== targetEmail.toLowerCase());
          for (const tm of openAgy) {
            const oldId = tm.id;
            const sw = await switchAccount({ termId: oldId, account: `agyswap:${targetEmail}`, skip: true, interrupt: true });
            if (sw?.ok && sw.term) restartedTerms.push({ oldId, newId: sw.term.id, label: sw.term.title });
          }
        }
        overviewStale();
        return send(res, 200, { ...resSwap, restartedTerms });
      } catch (e) {
        return send(res, 400, { error: `Antigravity 계정 전환 실패: ${e.message}` });
      }
    }
    // Antigravity quota: fast non-disruptive headless `agy --print /usage --output-format json` with single-flight cache.
    // GET /api/agy/quota returns cache immediately (0ms) and refreshes in background if stale; ?force=1 awaits a fresh read.
    if (p === '/api/agy/quota') {
      for (const t of terms.values()) {
        if (!isAgyTerm(t)) continue;
        const raw = readTerm(t, 80).join('\n');
        const accM = raw.match(/Account:\s*([^\s\r\n]+)/i);
        if (accM) agyQuota.noteAccount(accM[1]);
        if (!agyQuota.get()) {
          const parsed = parseAgyQuotaTui(raw);
          if (parsed) agyQuota.save(parsed);
        }
      }
      const withSwap = (base, swapRes) => ({
        ...base,
        swapAvailable: agySwap.available(),
        swapAccounts: swapRes.accounts || [],
        swapRefreshing: !!swapRes.refreshing,
        swapError: swapRes.error || swapRes.lastError || null,
      });
      if (url.searchParams.has('force')) {
        const [qRes, sRes] = await Promise.all([
          agyQuota.refresh({ force: true }),
          agySwap.available() ? agySwap.refresh({ force: true }) : Promise.resolve({ accounts: [] }),
        ]);
        return send(res, 200, withSwap(qRes, sRes));
      }
      return send(res, 200, withSwap(agyQuota.getFast(), agySwap.getFast()));
    }
    if (p === '/api/agy/usage' && req.method === 'POST') {
      const [qRes, sRes] = await Promise.all([
        agyQuota.refresh({ force: true }),
        agySwap.available() ? agySwap.refresh({ force: true }) : Promise.resolve({ accounts: [] }),
      ]);
      return send(res, 200, {
        ...qRes,
        swapAvailable: agySwap.available(),
        swapAccounts: sRes.accounts || [],
        swapRefreshing: !!sRes.refreshing,
        swapError: sRes.error || sRes.lastError || null,
      });
    }
    if (p === '/api/term/dedupe' && req.method === 'POST') {
      const removed = dedupeTermsBySession();
      await saveTermsState();
      overviewStale();
      return send(res, 200, { ok: true, removed });
    }
    if (p === '/api/term/close' && req.method === 'POST') {
      const b = await body(req);
      const t = terms.get(String(b.id));
      if (t) {
        rememberProjectTerm(t);
        forgetTerm(t);
      }
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
if (watchdogOn) {
  calendarMod.start();
  ensureTrayMonitor();
  setTimeout(() => { if (agyQuota.ageMs() >= 180_000) agyQuota.refresh({ force: true }).catch(() => {}); }, 3000).unref();
  setInterval(() => { if (agyQuota.ageMs() >= 4 * 60_000) agyQuota.refresh({ force: true }).catch(() => {}); }, 5 * 60_000).unref();
}

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
