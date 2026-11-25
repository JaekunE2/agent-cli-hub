// Agent CLI Hub — Claude Code / Codex / Cursor agent sessions in one web page; local only (127.0.0.1), token-protected.
// English mode: reload this file with translated messages (i18n.js); Korean is the source language.
if (require('./i18n').takeOver(module)) return;
const I18N = require('./i18n');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const CRASH_LOG = path.join(__dirname, 'server.log');
const logServerError = (tag, err) => {
  const msg = `[${new Date().toISOString()}] [${tag}] ${err?.stack || err?.message || err}\n`;
  try { fs.appendFileSync(CRASH_LOG, msg, 'utf8'); } catch {}
  console.error(msg.trimEnd());
};
process.on('uncaughtException', (err) => logServerError('uncaughtException', err));
process.on('unhandledRejection', (err) => logServerError('unhandledRejection', err));
try { os.setPriority(os.constants.priority.PRIORITY_ABOVE_NORMAL); } catch {}
const crypto = require('crypto');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const { SearchIndex } = require('./searchindex');
const CA = require('./codex-accounts');
const codexTokenLedger = require('./codex-token-ledger');
const codexRecoveryArgs = require('./terminal-recovery');
const { PTY_KEYS } = require('./immediate-send');
const { readSession: readAgySession, agyStatusFromScreen, stripAnsi } = require('./agy-session');
const projects = require('./projects')();
const { efforts, MODEL_RE } = require('./project-validation');
const { fingerprint, projectSession, sessionId: validSessionId } = require('./project-history');
const { createAccountPrefsStore, buildRecoveryLaunchArgs } = require('./account-prefs');
const { createProjectHarnessStore } = require('./project-harness');
const { createProjectRefsStore } = require('./project-refs');
const { checkAutopilotCompletions } = require('./project-autopilot');
const { generatePlan, generateSubtasks, cliModelEffortArgs, inspectWorkspace, resolveCliExecutable, enrichedCliEnv } = require('./project-plan');
const { scanFloorplan } = require('./workspace-floorplan');
const { runTaskSubChatTurn } = require('./task-subchat');
const { deleteCliRecord, uuid: recordUuid } = require('./delete-cli-record');
const { ownedRoots, verifiedRoot, probeRoot, stopTerminal } = require('./project-stop');
const { pickDirectory } = require('./win-folder-picker');
const { forkClaudeJsonlAt, forkCodexJsonlAt, inferCodexHomeFromFile, editClaudeJsonlAt, editCodexJsonlAt, writeBranchContextFile, createBranchStore } = require('./conversation-branches');
const { createUnifiedVault } = require('./unified-vault');
const { createTermManager } = require('./term-manager');
const { createTermEventStore } = require('./term-events');
const { createAccountSwitchService } = require('./account-switch');
const { createProjectRoutes } = require('./routes-projects');
const { createSessionRoutes } = require('./routes-sessions');
const { createHookTransport } = require('./session-hook-transport');
const { createSystemRoutes } = require('./routes-system');
const { createWorkspaceContexts } = require('./workspace-contexts');
const { createWorkspaceExecution } = require('./workspace-execution');
const { WorkspaceError } = require('./workspace-paths');
const { createWorkspaceFolderRoutes, workspaceFailure } = require('./routes-workspace-folders');
const { createScheduleEngine } = require('./schedules');
const { createScheduleRoutes } = require('./routes-schedules');
const { createScheduleTransport } = require('./schedule-transport');
const { error: scheduleError } = require('./schedule-fields');
const INSTANCE = require('./instance');
const { createIntegrations } = require('./integrations');

const cleanModelEffort = (model, effort) => {
  const m = String(model || '').trim();
  const ef = String(effort || '').trim();
  return { model: m && MODEL_RE.test(m) ? m : '', effort: ef && efforts.includes(ef) ? ef : '' };
};

const DEFAULT_PORT = 7777;
const PORT = Number(process.env.CCD_PORT || DEFAULT_PORT);
const HOST = '127.0.0.1';
const SERVER_BUILD_ID = String(Date.now());
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const BRANCH_STORE_FILE = path.join(__dirname, '.branches.json');
const BRANCH_BACKUP_DIR = path.join(__dirname, '.session-backups');
const CONFIG_FILE = path.join(__dirname, 'config.json');
const CONFIG = (() => { try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; } })();
const PY = process.env.CCD_PYTHON || CONFIG.python || 'python';
const TOKEN_FILE = path.join(__dirname, '.token');
if (!fs.existsSync(TOKEN_FILE)) fs.writeFileSync(TOKEN_FILE, crypto.randomBytes(18).toString('hex'));
const TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
const HOOK_TOKEN = crypto.createHmac('sha256', TOKEN).update('subagent-hooks').digest('hex');

const accountPrefs = createAccountPrefsStore({ cleanModelEffort });
const projectHarness = createProjectHarnessStore();
const projectRefs = createProjectRefsStore(path.join(__dirname, 'data', 'project-refs'));
const conversationBranches = createBranchStore(BRANCH_STORE_FILE);
const termEvents = createTermEventStore(path.join(__dirname, 'data', 'term-events.json'));
// Antigravity (agy) support stays in the code but is off unless config "antigravity": true
const AGY_ON = CONFIG.antigravity === true;
const index = new SearchIndex(path.join(CLAUDE_DIR, 'projects'), undefined, AGY_ON ? undefined : []);
const sessionDisplayTitle = (id, doc) => conversationBranches.getTitle(id) || conversationBranches.baseTitle(id, doc?.title) || null;
const unifiedVault = createUnifiedVault({
  repoRoot: path.resolve(__dirname, '..'),
  vaultDir: CONFIG.vaultDir ? path.resolve(__dirname, CONFIG.vaultDir) : '',
  configPath: CONFIG_FILE,
});

// ---------- console helper (python, JSON lines) ----------
let helper, helperBuf = '', rid = 0, helperFails = 0, helperMissing = null;
const pending = new Map();
function startHelper() {
  helper = spawn(PY, [path.join(__dirname, 'consolehelper.py')], { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });
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

let chain = Promise.resolve(), listCache = null, listAt = 0, listInflight = null;
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
function helperCall(req) {
  if (CONFIG.consoles === false) return Promise.resolve(req.op === 'list' ? { ok: true, consoles: [] } : { ok: false, error: 'console windows are turned off (config consoles: false)' });
  if (req.op === 'list' && !req.fresh && !helperMissing) {
    if (listCache && Date.now() - listAt < 2000) return Promise.resolve(listCache);
    if (!listInflight) listInflight = helperCallRaw({ op: 'list' }).then((r) => { if (r && r.ok !== false) { listCache = r; listAt = Date.now(); } listInflight = null; return r; });
    if (listCache && Date.now() - listAt < 60000) return Promise.resolve(listCache);
    return listInflight.then((r) => (r && r.ok !== false) || !listCache ? r : listCache);
  }
  return helperCallRaw(req.op === 'list' ? { op: 'list' } : req);
}

let lastIndexAt = 0;
const refreshIndex = () => index.refresh().then((r) => { lastIndexAt = Date.now(); return r; });
refreshIndex().then(() => console.log('search index ready:', index.docs.size, 'sessions'));
setInterval(() => refreshIndex(), 10000).unref?.();
const watchAutopilot = () => checkAutopilotCompletions(hub).catch((e) => console.error('[autopilot-watch]', e));

let consoleTitleCache = new Map();
const hub = {
  baseDir: __dirname, port: PORT, token: TOKEN, hookToken: HOOK_TOKEN, config: CONFIG, instance: INSTANCE, agyEnabled: AGY_ON, buildId: SERVER_BUILD_ID, claudeDir: CLAUDE_DIR, I18N,
  index, projects, accountPrefs, projectHarness, projectRefs, unifiedVault, conversationBranches, termEvents, sessionDisplayTitle, branchBackupDir: BRANCH_BACKUP_DIR,
  CA, codexRecoveryArgs, cliModelEffortArgs, buildRecoveryLaunchArgs, cleanModelEffort,
  fingerprint, projectSession, validSessionId, generatePlan, generateSubtasks, inspectWorkspace, scanFloorplan,
  runTaskSubChatTurn, deleteCliRecord, recordUuid, ownedRoots, verifiedRoot, probeRoot, stopTerminal, pickDirectory,
  forkClaudeJsonlAt, forkCodexJsonlAt, inferCodexHomeFromFile, editClaudeJsonlAt, editCodexJsonlAt, writeBranchContextFile,
  PTY_KEYS, agyStatusFromScreen, readAgySession, stripAnsi,
  helperCall, refreshIndex, getLastIndexAt: () => lastIndexAt, getHelperMissing: () => helperMissing,
  setConsoleTitleCache: (m) => { consoleTitleCache = m; },
};

hub.projectRecord = (t) => {
  const agent = hub.agentOf(t);
  if (agent === 'codex' && t.matchedProjectSession) return t.matchedProjectSession;
  const sid = projectSession(t, agent, index.docs.values(), agent === 'agy' ? hub.agySessionOf(t) : null);
  if (agent === 'codex') return t.matchedProjectSession ||= sid;
  return sid;
};
hub.rememberProjectTerm = (t) => {
  if (!t.meta.projectTask) return;
  const sid = hub.projectRecord(t);
  projects.remember([{ projectId: t.meta.projectTask.projectId, taskId: t.meta.projectTask.taskId, sessionId: sid, agent: hub.agentOf(t), accountId: t.account?.id, tokens: sid ? index.get(sid)?.tokens : null }]);
};

Object.assign(hub, createTermManager(hub));
hub.integrations = createIntegrations(hub);
Object.assign(hub, createAccountSwitchService(hub));

function describePid(pid) {
  if (!pid) return {};
  const s = hub.liveSessions().find((x) => x.pid === pid);
  if (!s) return { pid };
  const t = [...hub.terms.values()].find((x) => x.pid && x.exited === null && x.liveTitle && x.pid === pid);
  const d = index.get(s.sessionId);
  const first = d?.firstPrompt ? d.firstPrompt.split('\n')[0].slice(0, 60) : null;
  return { pid, session: s.sessionId, title: (t && t.liveTitle.replace(/^[^\p{L}\p{N}]+\s*/u, '')) || d?.title || first || s.name, cwd: s.cwd };
}

async function procTable() {
  const r = await helperCall({ op: 'procs' });
  return (r.ok && r.procs) ? new Map(r.procs.map(([pid, name, ppid]) => [pid, { name, ppid }])) : null;
}

const artifactsMod = require('./artifacts')({ dir: __dirname, index, terms: hub.terms });
const notifier = require('./notify')(CONFIG);
const watchdogOn = INSTANCE.watchdog;

function makeGpuQ() {
  const config = (() => { try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return CONFIG; } })();
  return require('./gpu')({
    dir: __dirname, file: PORT === 7777 ? 'gpu-queue.json' : `gpu-queue-${PORT}.json`, config, pidAlive: hub.pidAlive, describePid, readOnly: !INSTANCE.gpuGrant,
    procTable: async () => {
      const t = await procTable();
      if (t) {
        const cons = (await helperCall({ op: 'list' })).consoles || [];
        consoleTitleCache = new Map(cons.filter((c) => c.visible && !/^[A-Za-z]:[\\/]/.test(c.title)).flatMap((c) => c.pids.map((p) => [p, c.title])));
      }
      return t;
    },
    consoleTitleOf: (pids) => { for (const p of pids) if (consoleTitleCache.has(p)) return consoleTitleCache.get(p).replace(/^[^\p{L}\p{N}]+\s*/u, ''); return null; },
  });
}
function makeResearch() {
  try {
    return require('./research')({
      terms: hub.terms, createTerm: hub.createTerm, liveSessions: () => hub.liveSessions(), helperCall, index, aiUsage: hub.aiUsage,
      readTerm: hub.readTerm, sleep: hub.sleep, SUBMIT_DELAY: hub.SUBMIT_DELAY, termInfo: hub.termInfo, tokenAccounts: hub.tokenAccounts,
      notify: notifier.send, switchCandidates: hub.switchCandidates, publicUrl: () => { try { return remoteInfo().urls[0]; } catch { return null; } },
    });
  } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') console.error('[research]', e.message); return null; }
}
function makeCalendar() {
  const config = (() => { try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return CONFIG; } })();
  return require('./calendar')({ config, port: PORT, readOnly: !INSTANCE.calendarWrite });
}
function makeDrive() {
  const config = (() => { try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return CONFIG; } })();
  return require('./gdrive').createDriveSync({ baseDir: __dirname, port: PORT, config });
}
function makeApps() {
  return require('./apps')({
    terms: hub.terms,
    createTerm: hub.createTerm,
    liveSessions: () => hub.liveSessions(),
    writeInteractiveTerm: (...args) => hub.writeInteractiveTerm(...args),
    artifactsMod,
    termInfo: hub.termInfo,
  });
}

let gpuQ = makeGpuQ();
let research = makeResearch();
let calendarMod = makeCalendar();
let driveMod = makeDrive();
let appsMod = makeApps();
const projectRoutes = createProjectRoutes(hub);
const hookTransport = createHookTransport(hub);
hub.toolHooks = hookTransport.toolHooks;
hub.artifacts = artifactsMod;
const workspaceContexts = createWorkspaceContexts(path.join(__dirname, 'data', 'workspace-contexts.json'));
const sessionRoutes = createSessionRoutes(hub, workspaceContexts, logServerError);
hub.workspaceExecution = createWorkspaceExecution(workspaceContexts, sessionRoutes.folderSession);
const workspaceFolderRoutes = createWorkspaceFolderRoutes(workspaceContexts, sessionRoutes.folderSession, logServerError);
let scheduleEngine;
function detectScheduleCli(cliId) {
  const raw = cliId === 'codex'
    ? (hub.codexExe?.() || 'codex.exe')
    : cliId === 'agy'
      ? (hub.agyExe?.() || 'agy.exe')
      : 'claude.exe';
  const resolved = resolveCliExecutable(raw);
  if (resolved && path.isAbsolute(resolved) && fs.existsSync(resolved)) return resolved;
  const dirs = String(enrichedCliEnv().PATH || process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const names = process.platform === 'win32'
    ? (/\.(exe|cmd|bat)$/i.test(resolved) ? [resolved] : [`${resolved}.exe`, `${resolved}.cmd`, `${resolved}.bat`, resolved])
    : [resolved];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      try { if (fs.statSync(candidate).isFile()) return candidate; } catch {}
    }
  }
  return null;
}
function buildScheduleCapabilities() {
  const specs = [
    { id: 'codex', label: 'Codex', referenceMode: 'context' },
    { id: 'claude', label: 'Claude', referenceMode: 'add-dir' },
    { id: 'agy', label: 'Antigravity', referenceMode: 'context' },
  ];
  return {
    cli: specs.map(s => {
      const cmd = detectScheduleCli(s.id);
      return {
        id: s.id, label: s.label, accountIds: ['default'], referenceMode: s.referenceMode,
        available: Boolean(cmd), reason: cmd ? null : 'RUNNER_UNAVAILABLE',
      };
    }),
  };
}
const scheduleCapabilities = buildScheduleCapabilities();
const scheduleRunnerAvailable = scheduleCapabilities.cli.some(c => c.available);
const scheduleRoutes = createScheduleRoutes(() => scheduleEngine, scheduleCapabilities, logServerError);
const scheduleTransport = createScheduleTransport(() => scheduleEngine, logServerError);

function resolveScheduleTarget({ projectId, version, taskId, cwd, sessionId = '', termId = '', cli = 'codex', accountId = 'default', referenceDirs = [] }) {
  let workCwd = '';
  let taskText = '';
  const liveTerm = termId ? hub.terms?.get(String(termId)) : null;
  const effectiveSessionId = String(sessionId || (liveTerm ? hub.termSessionId?.(liveTerm) : '') || '').trim();
  const sessionDoc = effectiveSessionId ? index.get(effectiveSessionId) : null;

  if (!projectId) {
    const candidateCwd = cwd || liveTerm?.cwd || sessionDoc?.cwd || '';
    try {
      if (!candidateCwd || !fs.statSync(candidateCwd).isDirectory()) throw new Error('not dir');
      workCwd = candidateCwd;
    } catch {
      throw scheduleError('TARGET_MISSING', 'Schedule working folder not found');
    }
  } else {
    const project = projects.list().find(item => item.id === projectId);
    if (!project?.versions?.some(item => item.number === version)
        || (taskId && !project.tasks.some(task => task.id === taskId && task.version === version))) {
      throw scheduleError('TARGET_MISSING', 'Schedule project, version or task not found');
    }
    workCwd = project.cwd || '';
    if (!workCwd || !fs.existsSync(workCwd)) {
      throw scheduleError('TARGET_MISSING', 'Schedule project folder not found');
    }
    const task = taskId ? project.tasks.find(t => t.id === taskId && t.version === version) : null;
    if (task) taskText = `[Project: ${project.name} v${version} / Task: ${task.title || task.id}]\n${task.prompt || ''}`.trim();
  }
  const cmd = detectScheduleCli(cli);
  if (!cmd) throw scheduleError('CAPABILITY_UNSUPPORTED', `Schedule CLI (${cli}) is unavailable`);
  const validRefs = (Array.isArray(referenceDirs) ? referenceDirs : []).filter(d => {
    try { return typeof d === 'string' && d.trim() && fs.statSync(d).isDirectory(); } catch { return false; }
  });
  const env = enrichedCliEnv();
  for (const k of Object.keys(env)) {
    if (/^(CLAUDECODE|CLAUDE_PID|CLAUDE_CODE_)/i.test(k)) delete env[k];
  }
  if (cli === 'codex') {
    if (accountId && accountId !== 'default') {
      const acc = CA.listAccounts?.().find(a => a.id === accountId);
      if (acc?.home) env.CODEX_HOME = acc.home;
    } else if (sessionDoc?.file) {
      const inferredHome = inferCodexHomeFromFile(sessionDoc.file);
      if (inferredHome) env.CODEX_HOME = inferredHome;
    }
  } else if (cli === 'claude' && accountId && accountId !== 'default') {
    const acc = (CONFIG.accounts || []).find(a => a.id === accountId);
    if (acc?.dir) env.CLAUDE_CONFIG_DIR = acc.dir;
  }
  let args;
  if (cli === 'claude') {
    args = [
      ...(effectiveSessionId ? ['--resume', effectiveSessionId] : []),
      '--print', '--permission-mode', 'plan', '--output-format', 'json',
      ...validRefs.flatMap(d => ['--add-dir', d]),
    ];
  } else if (cli === 'agy') {
    args = [
      ...(effectiveSessionId ? ['--conversation', effectiveSessionId] : []),
      '--print', '--output-format', 'json',
    ];
    if (validRefs.length) taskText = [taskText, `[참고 폴더]\n${validRefs.join('\n')}`].filter(Boolean).join('\n\n');
  } else {
    args = effectiveSessionId
      ? ['exec', 'resume', '--json', '--skip-git-repo-check', effectiveSessionId, '-']
      : ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '-'];
    if (validRefs.length) taskText = [taskText, `[참고 폴더]\n${validRefs.join('\n')}`].filter(Boolean).join('\n\n');
  }
  return { cli, cwd: workCwd, cmd, args, env, taskText, referenceDirs: validRefs };
}
Object.assign(hub, {
  ...projectRoutes,
  ...sessionRoutes,
  readCodexTokens: codexTokenLedger.readTokens,
  procTable, artifactsMod, gpuQ: () => gpuQ, research: () => research, calendarMod: () => calendarMod, driveMod: () => driveMod, appsMod: () => appsMod,
});
const systemRoutes = createSystemRoutes(hub);

gpuQ.start();
if (research && watchdogOn) research.start();
if (watchdogOn) {
  calendarMod.start();
  hub.ensureTrayMonitor();
  const tokenLedgerError = err => logServerError('codex-token-ledger', err);
  codexTokenLedger.watchCodexTokens({
    usageDir: hub.USAGE_DIR, getUsage: () => hub.aiUsage(true), onError: tokenLedgerError,
  }).catch(tokenLedgerError);
  if (AGY_ON) setTimeout(() => { if (hub.agyQuota.ageMs() >= 180_000) hub.agyQuota.refresh({ force: true }).catch(() => {}); }, 3000).unref();
  if (AGY_ON) setInterval(() => { if (hub.agyQuota.ageMs() >= 4 * 60_000) hub.agyQuota.refresh({ force: true }).catch(() => {}); }, 5 * 60_000).unref();
}

function reloadModules(which) {
  const done = [];
  const fresh = (rel) => { delete require.cache[require.resolve(rel)]; };
  if (which.includes('gpu')) { fresh('./gpu'); const next = makeGpuQ(); gpuQ.stop(); gpuQ = next; gpuQ.start(); done.push('gpu'); }
  if (which.includes('calendar')) { fresh('./calendar'); const next = makeCalendar(); calendarMod.stop(); calendarMod = next; if (watchdogOn) calendarMod.start(); done.push('calendar'); }
  if (which.includes('apps')) { fresh('./apps'); const next = makeApps(); appsMod.stop(); appsMod = next; done.push('apps'); }
  if (which.includes('research')) {
    fresh('./research'); try { fresh(require('./harness').libPath('project')); } catch {}
    const next = makeResearch();
    if (next) { research?.stop?.(); research = next; if (watchdogOn) research.start(); done.push('research'); }
  }
  return done;
}
hub.reloadModules = reloadModules;

// ---------- notice board ----------
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
  if (boardOnly || CONFIG.operator?.noticeDeliver !== true || !INSTANCE.notices) return { ok: true, sent: [] };
  const want = String(to).split(',').map((x) => x.trim()).filter(Boolean);
  const now = Date.now();
  const DORMANT_MS = 60 * 60 * 1000;
  const isActive = (t, agent) => {
    const st = agent === 'codex' ? hub.codexStatus?.(t) : agent === 'agy' ? hub.agyStatus?.(t) : hub.claudeStatus?.(t);
    if (st === 'busy') return true;
    const lastActive = Math.max(Number(t.lastOutputAt) || 0, Number(t.lastInputAt) || 0, Number(t.meta?.spawnedAt) || 0);
    return !lastActive || (now - lastActive) < DORMANT_MS;
  };
  const targets = [...hub.terms.values()].filter((t) => {
    if (t.exited !== null || t.meta?.operator || t.meta?.projectTask) return false;
    if (fromPid && t.pid === fromPid) return false;
    const agent = hub.agentOf(t);
    if (!['claude', 'codex', 'agy'].includes(agent)) return false;
    if (!isActive(t, agent)) return false;
    return want.includes('all') || want.includes(`t:${t.id}`) || want.includes(t.id);
  });
  const msg = `[허브 공지 ${stamp.slice(11)}] ${text.replace(/\n+/g, ' ')} — 하던 작업은 그대로 이어가세요. (전체 공지: ccd notices)`;
  for (const t of targets) { t.proc.write(msg); await hub.sleep(hub.SUBMIT_DELAY); t.proc.write('\r'); }
  hub.overviewStale();
  return { ok: true, sent: targets.map((t) => `t:${t.id}`) };
}

// ---------- operator session ----------
const OPERATOR_DIR = path.join(__dirname, '..', 'operator');
const operatorTerm = () => [...hub.terms.values()].find((t) => t.meta?.operator && t.exited === null);
let operatorStarting = null;
function saveOperatorConfig(patch = {}) {
  const prev = CONFIG.operator && typeof CONFIG.operator === 'object' ? CONFIG.operator : {};
  const next = { ...prev };
  if (patch.agent !== undefined) {
    next.agent = ['claude', 'codex', 'agy'].includes(patch.agent) ? patch.agent : 'claude';
    delete next.command;
  }
  if (patch.model !== undefined || patch.effort !== undefined) {
    const me = cleanModelEffort(patch.model ?? next.model, patch.effort ?? next.effort);
    if (me.model) next.model = me.model; else delete next.model;
    if (me.effort) next.effort = me.effort; else delete next.effort;
  }
  if (patch.enabled !== undefined) next.enabled = !!patch.enabled;
  if (patch.skipPermissions !== undefined) next.skipPermissions = !!patch.skipPermissions;
  if (patch.noticeDeliver !== undefined) next.noticeDeliver = !!patch.noticeDeliver;
  if (patch.checkEveryMin !== undefined) {
    const mins = Number(patch.checkEveryMin);
    if (Number.isFinite(mins) && mins >= 0) next.checkEveryMin = Math.min(1440, Math.round(mins));
  }
  CONFIG.operator = next;
  const tmp = CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(CONFIG, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CONFIG_FILE);
  return next;
}
function ensureOperator(force = false) {
  const oc = CONFIG.operator || {};
  if (operatorTerm()) return Promise.resolve(operatorTerm());
  if ((oc.enabled === false && !force) || (!INSTANCE.operator && !force) || operatorStarting) return Promise.resolve(null);
  operatorStarting = (async () => {
    const agent = ['claude', 'codex', 'agy'].includes(oc.agent) ? oc.agent : 'claude';
    const me = cleanModelEffort(oc.model, oc.effort);
    const dirKey = path.resolve(OPERATOR_DIR).toLowerCase();
    const prior = [...index.docs.values()].some((d) => (d.agent || 'claude') === agent && d.cwd && path.resolve(d.cwd).toLowerCase() === dirKey)
      || (agent === 'claude' && fs.existsSync(path.join(CLAUDE_DIR, 'projects', path.resolve(OPERATOR_DIR).replace(/[^A-Za-z0-9]/g, '-'))));
    const kickoff = '운영 매뉴얼을 읽고 "시작 점검"을 해 주세요.';
    let cmd, args;
    if (Array.isArray(oc.command) && oc.command.length) { cmd = oc.command[0]; args = oc.command.slice(1); }
    else if (agent === 'codex') ({ cmd, args } = hub.codexLaunch([...(hub.cliModelEffortArgs?.('codex', me.model, me.effort) || []), ...(prior ? ['resume', '--last'] : [kickoff])]));
    else if (agent === 'agy') {
      cmd = hub.agyExe();
      args = [...(prior ? ['--continue'] : []), ...(oc.skipPermissions === false ? [] : ['--dangerously-skip-permissions']), ...(hub.cliModelEffortArgs?.('agy', me.model, me.effort) || []), ...(prior ? [] : ['--prompt-interactive', kickoff])];
    } else {
      cmd = 'claude.exe';
      args = [...(prior ? ['--continue'] : []), ...(oc.skipPermissions === false ? [] : ['--dangerously-skip-permissions']), ...(hub.cliModelEffortArgs?.('claude', me.model, me.effort) || []), ...(prior ? [] : [kickoff])];
    }
    const t = hub.createTerm({ cwd: OPERATOR_DIR, cmd, args, title: '🛰 관제 세션', operator: true, agent, model: me.model, effort: me.effort });
    const favs = hub.loadFavs();
    if (!favs.includes(`term:${t.id}`)) fs.writeFileSync(hub.FAV_FILE, JSON.stringify([`term:${t.id}`, ...favs.filter((k) => !/^term:/.test(k) || hub.terms.has(k.slice(5)))]));
    console.log(`[operator] ${agent} started as t:${t.id}${prior ? ' (continuing its last conversation)' : ''}`);
    return t;
  })().catch((e) => { console.error('[operator]', e.message); return null; }).finally(() => { operatorStarting = null; });
  return operatorStarting;
}
Object.assign(hub, { readNotices, postNotice, OPERATOR_DIR, operatorTerm, ensureOperator, saveOperatorConfig });

// ---------- HTTP & WebSocket ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const STATIC = {
  '/styles.css': 'public/styles.css', '/components.css': 'public/components.css',
  '/fonts/jetbrains-mono.woff2': 'public/fonts/jetbrains-mono.woff2',
  '/fonts/jetbrains-mono-italic.woff2': 'public/fonts/jetbrains-mono-italic.woff2',
  '/schedules.css': 'public/schedules.css', '/schedules-ui.js': 'public/schedules-ui.js',
  '/schedule-form.js': 'public/schedule-form.js', '/schedule-history.js': 'public/schedule-history.js',
  '/schedule-trigger.js': 'public/schedule-trigger.js', '/schedule-target.js': 'public/schedule-target.js',
  '/schedule-sync.js': 'public/schedule-sync.js',
  '/ui.js': 'public/ui.js', '/app-core.js': 'public/app-core.js', '/sidebar-ui.js': 'public/sidebar-ui.js',
  '/workspace-badges.js': 'public/workspace-badges.js', '/workspace-folder-edit.js': 'public/workspace-folder-edit.js',
  '/workspace-folder-detail.js': 'public/workspace-folder-detail.js', '/workspace-panel.js': 'public/workspace-panel.js',
  '/workspace-trust-ui.js': 'public/workspace-trust-ui.js',
  '/home-terms-ui.js': 'public/home-terms-ui.js', '/terminals-ui.js': 'public/terminals-ui.js',
  '/tool-activity-ui.js': 'public/tool-activity-ui.js',
  '/tool-stream-ui.js': 'public/tool-stream-ui.js',
  '/subagent-viewer.js': 'public/subagent-viewer.js',
  '/files-artifacts.js': 'public/files-artifacts.js', '/chat-composer.js': 'public/chat-composer.js',
  '/slash-commands.js': 'public/slash-commands.js', '/slash-actions.js': 'public/slash-actions.js',
  '/slash-picker.js': 'public/slash-picker.js', '/slash-picker.css': 'public/slash-picker.css',
  '/chat-ui.js': 'public/chat-ui.js', '/usage-ui.js': 'public/usage-ui.js',
  '/switch-gpu-ui.js': 'public/switch-gpu-ui.js', '/research-ui.js': 'public/research-ui.js',
  '/dock.js': 'public/dock.js', '/preview.js': 'public/preview.js', '/vault.js': 'public/vault.js', '/apps-ui.js': 'public/apps-ui.js',
  '/projects.js': 'public/projects.js', '/project-forms.js': 'public/project-forms.js', '/project-plan-form.js': 'public/project-plan-form.js',
  '/project-board.js': 'public/project-board.js', '/project-task-form.js': 'public/project-task-form.js', '/project-flow.js': 'public/project-flow.js',
  '/project-harness-ui.js': 'public/project-harness-ui.js', '/project-refs-ui.js': 'public/project-refs-ui.js', '/project-floorplan.js': 'public/project-floorplan.js', '/project-git.js': 'public/project-git.js', '/project-terminals.js': 'public/project-terminals.js', '/projects.css': 'public/projects.css',
  '/xterm.js': 'node_modules/@xterm/xterm/lib/xterm.js', '/xterm.css': 'node_modules/@xterm/xterm/css/xterm.css',
  '/addon-fit.js': 'node_modules/@xterm/addon-fit/lib/addon-fit.js', '/mermaid.js': 'node_modules/mermaid/dist/mermaid.min.js',
  '/drive.js': 'public/drive.js', '/delta.js': 'public/delta.js', '/integrations-ui.js': 'public/integrations-ui.js',
  '/icon-claude.png': 'public/icon-claude.png', '/icon-openai.png': 'public/icon-openai.png',
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
  const origin = req.headers.origin;
  if (origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) return false;
  return url.searchParams.get('t') === TOKEN || req.headers['x-token'] === TOKEN;
}

hub.writeInteractiveTerm = async (t, data) => {
  if (!t || t.exited !== null || typeof data !== 'string' || !data || data.length > 400_000) return false;
  // xterm replies to CLI status queries during redraws and when the view is attached.
  if (!/^(?:\x1b\[(?:[IO]|0n|\??\d+;\d+R|[?>][\d;]+c|\??\d+;\d+\$y|8;\d+;\d+t))+$/.test(data)) {
    t._interactiveInputSeq = (t._interactiveInputSeq || 0) + 1;
    hub.termMonitor?.onInput(t, data);
    if (t.meta?.projectAutoClose && t.lastInputAt === t.meta.spawnedAt) hub.touchUserInput(t);
  }
  const result = await t.proc.write(data);
  if (result?.guardError) throw result.guardError;
  if (result?.ok && data.includes('\x03')) t._subagentsInterruptedAt = Date.now();
  if (result?.ok && /[\r\n]/.test(data)) hub.touchUserInput(t);
  return !!result?.ok;
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  if (p === '/' || STATIC[p] || p === '/app.js' || p === '/calendar.js' || p === '/manifest.json' || p === '/icon.svg') {
    const file = p === '/' ? 'public/index.html' : STATIC[p] || 'public' + p;
    const local = p === '/' && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) && new RegExp(`^(127\\.0\\.0\\.1|localhost|\\[::1\\]):${PORT}$`).test(req.headers.host || '');
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store, no-cache, must-revalidate, max-age=0', pragma: 'no-cache' });
    const bustIndex = (html) => (p === '/'
      ? html.replace(/((?:src|href)="\/[^"?]+\.(?:css|js))"/g, `$1?v=${SERVER_BUILD_ID}"`)
      : html);
    const text = file.startsWith('public/') && !file.endsWith('.woff2') ? I18N.forFile(path.join(__dirname, file)) : null;
    if (text !== null) {
      const out = bustIndex(local ? text.replace('<head>', `<head><script>window.LOCAL_TOKEN=${JSON.stringify(TOKEN)}</script>`) : text);
      return res.end(out);
    }
    if (p === '/') {
      const raw = fs.readFileSync(path.join(__dirname, file), 'utf8');
      const out = bustIndex(local ? raw.replace('<head>', `<head><script>window.LOCAL_TOKEN=${JSON.stringify(TOKEN)}</script>`) : raw);
      return res.end(out);
    }
    return fs.createReadStream(path.join(__dirname, file)).pipe(res);
  }
  if (hub.integrations.handlePage(p, url, req, res, send)) return;
  if (!p.startsWith('/api/')) return send(res, 404, { error: 'not found' });
  if (p === '/api/session/subagent-hook' && req.method === 'POST') {
    return hookTransport.handleNativeHook(req, res, body, send);
  }
  if (p === '/api/calendar/google/callback') return calendarMod.oauthCallback(url, res).catch((e) => send(res, 500, { error: e.message }));
  if (p === '/api/drive/google/callback') return driveMod.oauthCallback(url, res).catch((e) => send(res, 500, { error: e.message }));
  if (await workspaceFolderRoutes(p, url, req, res, send, authed)) return;
  if (await scheduleRoutes(p, url, req, res, send, authed)) return;
  if (!authed(req, url)) return send(res, 401, { error: 'bad token' });
  if (req.method === 'POST') hub.overviewStale();

  try {
    if (await hub.integrations.handleApi(p, url, req, res, body, send)) return;
    if (await projectRoutes.handleProjectRoutes(p, url, req, res, body, send, authed)) return;
    if (await sessionRoutes.handleSessionRoutes(p, url, req, res, body, send, authed)) return;
    if (await systemRoutes.handleSystemRoutes(p, url, req, res, body, send, authed)) return;
    return send(res, 404, { error: 'unknown api' });
  } catch (e) {
    if (e instanceof WorkspaceError) return send(res, e.status, workspaceFailure(e, req));
    return send(res, 500, { error: String(e.message || e) });
  }
});

const wss = new WebSocketServer({ noServer: true });
wss.on('error', (err) => logServerError('wss', err));
server.on('upgrade', (req, sock, head) => {
  sock.on('error', () => {});
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (hookTransport.handleUpgrade(wss, req, sock, head, url, authed)) return;
  if (scheduleTransport.handleUpgrade(req, sock, head, url, authed)) return;
  const t = hub.terms.get(url.searchParams.get('id') || '');
  if (url.pathname !== '/ws/term' || !authed(req, url) || !t) return sock.destroy();
  wss.handleUpgrade(req, sock, head, (ws) => {
    ws.on('error', () => t.clients.delete(ws));
    t.clients.add(ws);
    ws.send(JSON.stringify({ type: 'resize', cols: t.cols, rows: t.rows }));
    ws.send(JSON.stringify({ type: 'data', data: t.buf }));
    if (t.exited !== null) ws.send(JSON.stringify({ type: 'exit', code: t.exited }));
    ws.on('message', (m) => {
      let msg; try { msg = JSON.parse(m); } catch { return; }
      if (!msg) return;
      if (msg.type === 'input' && typeof msg.data === 'string' && msg.data) {
        const inputError = (err) => {
          if (err && !(err instanceof WorkspaceError)) logServerError('workspace-terminal-input', err);
          if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'input-error', ...(err instanceof WorkspaceError
            ? workspaceFailure(err, req) : { error: '터미널에 키 입력을 전달하지 못했습니다.' }) }));
        };
        hub.writeInteractiveTerm(t, msg.data).then(ok => { if (!ok) inputError(); }, inputError);
      }
      if (t.exited !== null) return;
      if (msg.type === 'resize' && msg.cols > 0 && msg.rows > 0 && hub.resizeTerm(t, msg.cols, msg.rows)) {
        for (const c of t.clients) if (c !== ws) c.send(JSON.stringify({ type: 'resize', cols: t.cols, rows: t.rows }));
      }
    });
    ws.on('close', () => t.clients.delete(ws));
  });
});

// ---------- remote access (Tailscale only) ----------
const remote = new Map();
function tailscaleIPs() {
  const out = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.internal) continue;
      const [x, y] = a.address.split('.').map(Number);
      if (a.family === 'IPv4' && x === 100 && y >= 64 && y <= 127
        || a.family === 'IPv6' && /^fd7a:115c:a1e0:/i.test(a.address)) out.push(a.address);
    }
  }
  return out.sort((a, b) => a.includes(':') - b.includes(':'));
}
const remoteUrl = (ip) => `http://${ip.includes(':') ? `[${ip}]` : ip}:${PORT}/`;
function syncRemoteListeners() {
  if (CONFIG.remote === 'off') return;
  const want = new Set(tailscaleIPs());
  for (const [ip, s] of remote) if (!want.has(ip)) { s.close(); remote.delete(ip); }
  for (const ip of want) {
    if (remote.has(ip)) continue;
    const s = http.createServer((req, res) => server.emit('request', req, res));
    s.on('upgrade', (req, sock, head) => server.emit('upgrade', req, sock, head));
    s.on('error', (e) => { console.error('[remote]', ip, e.message); remote.delete(ip); });
    s.listen(PORT, ip, () => console.log(`remote (tailscale): ${remoteUrl(ip)}`));
    remote.set(ip, s);
  }
}
function remoteInfo() {
  let dns = null;
  try {
    const exe = ['C:\\Program Files\\Tailscale\\tailscale.exe', 'tailscale'].find((p) => p === 'tailscale' || fs.existsSync(p));
    const st = JSON.parse(require('child_process').execFileSync(exe, ['status', '--json'], { timeout: 3000, windowsHide: true }).toString());
    dns = st.Self?.DNSName?.replace(/\.$/, '') || null;
  } catch {}
  const ips = [...remote.keys()];
  const ipv4 = ips.filter((ip) => !ip.includes(':')).map(remoteUrl);
  const ipv6 = ips.filter((ip) => ip.includes(':')).map(remoteUrl);
  const urls = [...hub.integrations.remoteUrls(), ...ipv4, ...(dns ? [remoteUrl(dns)] : []), ...ipv6];
  return { enabled: CONFIG.remote !== 'off', listening: ips, urls, homelink: hub.integrations.homelink, tailscaleInstalled: fs.existsSync('C:\\Program Files\\Tailscale\\tailscale.exe') };
}
hub.remoteInfo = remoteInfo;

setInterval(() => {
  hub.saveTermsState();
  try { workspaceContexts.linkTerms(sessionRoutes.folderSessionLinks()); }
  catch (err) { logServerError('workspace-folder-link', err); }
}, 15000).unref?.();
setInterval(() => {
  const every = INSTANCE.operator ? Number((CONFIG.operator || {}).checkEveryMin ?? 180) : 0;
  const t = operatorTerm();
  if (!every || !t || Date.now() - (t.lastCheckAt || t.meta?.spawnedAt || 0) < every * 60e3) return;
  let scr = ''; try { scr = hub.readTerm(t, 15).join('\n'); } catch { return; }
  if (/esc to interrupt|esc to cancel/i.test(scr)) return;
  t.lastCheckAt = Date.now();
  t.proc.write('[정기 점검] 운영 매뉴얼의 "정기 점검"을 해 주세요. 바뀐 것이 없으면 한 줄로만 답하세요.');
  setTimeout(() => t.proc.write('\r'), hub.SUBMIT_DELAY);
}, 60e3).unref();

hub.connectPtyHost().then(() => setTimeout(() => ensureOperator().catch(() => {}), 4000));
server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;
server.listen(PORT, HOST, () => {
  if (PORT === DEFAULT_PORT) {
    try {
      scheduleEngine = createScheduleEngine({
        resolveTarget: resolveScheduleTarget, onChange: scheduleTransport.broadcast,
        onError: cause => logServerError('schedules-engine', cause),
      });
      if (scheduleRunnerAvailable) scheduleEngine.start();
    } catch (cause) {
      logServerError('schedules-engine', cause);
    }
  }
  const u = `http://${HOST}:${PORT}/?t=${TOKEN}`;
  fs.writeFileSync(path.join(__dirname, 'url.txt'), u + '\n');
  console.log('Agent CLI Hub:', u);
  hub.integrations.startDeltaUi();
  if (INSTANCE.autopilot) {
    watchAutopilot();
    setInterval(watchAutopilot, 3500).unref?.();
  } else console.log('[instance] side instance on port', PORT, '— watchdog/operator/autopilot/recovery/GPU grants off (see instance.js)');
});
syncRemoteListeners();
setInterval(syncRemoteListeners, 15000).unref?.();
