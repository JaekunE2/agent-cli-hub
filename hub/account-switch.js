'use strict';

const { nativeFolderKey } = require('./workspace-execution');
const { resolveLaunchFolders } = require('./workspace-launch');

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { dispatchTerminalPrompt, waitForTerminalInput } = require('./term-manager');
const { createAgyQuotaService } = require('./agy-quota');
const { findAgySwapExe, createAgySwapService } = require('./agy-swap');
const { writeNativeClaudeSession, writeNativeCodexSession, readAgyConversationTurns } = require('./conversation-branches');

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

/** Create AI usage relay, multi-platform account switching, and CLI option catalog service. */
function createAccountSwitchService(hub) {
  const {
    baseDir, config, index, projects, accountPrefs, CA,
    cliModelEffortArgs, cleanModelEffort, fingerprint,
  } = hub;

  const USAGE_URL = process.env.CCD_USAGE_URL || config.usageUrl || 'http://127.0.0.1:4777';
  const USAGE_DIR = (() => {
    const localDir = path.resolve(baseDir, '..', 'ai-usage');
    return process.env.CCD_USAGE_DIR || (config.usageDir && path.resolve(baseDir, config.usageDir)) || (fs.existsSync(localDir) ? localDir : path.join(os.homedir(), 'ai-usage-dashboard'));
  })();

  const agyExe = () => [config.agy, path.join(os.homedir(), 'AppData', 'Local', 'agy', 'bin', 'agy.exe')].find((f) => f && fs.existsSync(f)) || 'agy.exe';
  const agyQuota = createAgyQuotaService({ file: path.join(baseDir, 'agy-quota.json'), agyExe, envFn: () => hub.cleanEnv() });
  const agySwapExe = () => findAgySwapExe(config.agySwap);
  const agySwap = createAgySwapService({ exeFn: agySwapExe, envFn: () => hub.cleanEnv() });
  const codexExe = () => CA.codexExe(config.codex);

  let usageCache = { at: 0, data: null };
  let usageServerUp = false, usageCheckAt = 0;

  async function checkUsageServer(force = false) {
    if (!force && Date.now() - usageCheckAt < 5000) return usageServerUp;
    usageCheckAt = Date.now();
    try {
      const u = new URL(USAGE_URL);
      usageServerUp = await new Promise((resolve) => {
        const sock = require('net').createConnection({ host: u.hostname || '127.0.0.1', port: Number(u.port) || 4777 });
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
    if (!fs.existsSync(entry)) return { ok: false, error: `AI 사용량 서버 파일(${entry})을 찾을 수 없습니다.` };
    try {
      spawn(process.execPath, ['--no-warnings', '--use-system-ca', entry], {
        cwd: USAGE_DIR, detached: true, windowsHide: true, stdio: 'ignore',
      }).unref();
    } catch (e) {
      return { ok: false, error: `AI 사용량 서버 시작 실패: ${e.message}` };
    }
    for (let i = 0; i < 16; i++) {
      await hub.sleep(250);
      if (await checkUsageServer(true)) {
        usageCache = { at: 0, data: null };
        hub.overviewStale();
        return { ok: true, started: true, url: USAGE_URL };
      }
    }
    return { ok: false, error: `AI 사용량 서버(${USAGE_URL})가 시작되었으나 응답하지 않습니다.` };
  }

  function ensureTrayMonitor() {
    if (process.platform !== 'win32' || process.env.CCD_DESKTOP_LAUNCHER === '1') return false;
    const trayScript = path.resolve(baseDir, '..', 'tray.ps1');
    if (!fs.existsSync(trayScript)) return false;
    try {
      spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', trayScript], {
        cwd: path.dirname(trayScript), detached: true, windowsHide: true, stdio: 'ignore',
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
      restartUsageServer(e);
      return usageCache.data ? { ...usageCache.data, stale: true } : { available: false, error: `AI 사용량 대시보드(${USAGE_URL})에 연결할 수 없음: ${e.message}` };
    }
  }
  // The usage server has no supervisor of its own: if it is not listening (it died, or never came up at
  // logon), relaunch it with its own autostart script (else startUsageServer), at most every 2 minutes.
  // Only for a local URL and only on "connection refused", so a slow-but-alive server is left alone.
  let usageRestartAt = 0;
  function restartUsageServer(err) {
    const code = err?.cause?.code || err?.code;
    if (hub.instance && !hub.instance.usageRestart) return;
    if (code !== 'ECONNREFUSED' || !/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(USAGE_URL)) return;
    if (Date.now() - usageRestartAt < 120_000) return;
    usageRestartAt = Date.now();
    const vbs = path.join(USAGE_DIR, 'autostart', 'run-dashboard.vbs');
    console.log(`[usage] ${USAGE_URL} not listening; relaunching ${fs.existsSync(vbs) ? vbs : 'server.js'}`);
    if (fs.existsSync(vbs)) { try { spawn('wscript.exe', [vbs], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch {} }
    else startUsageServer().catch(() => {});
  }

  function readUsageAccounts() {
    try { return JSON.parse(fs.readFileSync(path.join(USAGE_DIR, 'accounts.json'), 'utf8')).accounts || []; } catch { return []; }
  }

  function tokenAccounts() {
    return readUsageAccounts().filter((a) => (a.type === 'claude-token' && (a.token || a.tokenPath)) || (a.type === 'claude' && a.credentialsPath)).map((a) => ({
      id: a.id, label: a.label, type: a.type, credentialsPath: a.credentialsPath,
      token: () => (a.type === 'claude-token' ? (a.token || fs.readFileSync(a.tokenPath, 'utf8')).trim() : null),
    }));
  }

  function geminiAccounts() {
    return readUsageAccounts().filter((a) => a.type === 'gemini').map((a) => ({
      id: a.id, label: a.label,
      apiKey: () => { try { return (a.apiKey || (a.keyPath && fs.readFileSync(a.keyPath, 'utf8')) || '').trim() || null; } catch { return null; } },
    }));
  }

  function agySwapProjectAccounts() {
    return (agySwap.getFast().accounts || []).map((a) => {
      const base = a.name ? `${a.name} (${a.email})` : a.email;
      return { id: a.id, label: a.active ? `● ${base} (현재 활성)` : base, email: a.email };
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

  function codexLaunch(extra = []) {
    const exe = codexExe();
    const pre = /plugin-appserver/i.test(exe) ? ['--no-daemon'] : [];
    return /\.cmd$/i.test(exe) ? { cmd: 'cmd.exe', args: ['/c', exe, ...pre, ...extra] } : { cmd: exe, args: [...pre, ...extra] };
  }

  const meterPct = (acc, re) => { const m = (acc?.meters || []).find((x) => re.test(x.name)); return m ? m.usedPercent : null; };

  // claude reads ~/.claude/.credentials.json at start and keeps that token in memory. When the PC login
  // changes later (/login, another account), a process started before that is not on today's "default":
  // resuming it re-reads the file, so the PC login is a real switch target for it, not "current".
  const CRED_FILE = path.join(os.homedir(), '.claude', '.credentials.json');
  function onOldLogin(startedAt) {
    try { return !!startedAt && startedAt < fs.statSync(CRED_FILE).mtimeMs - 5000; } catch { return false; }
  }
  async function switchCandidates(currentId, { oldLogin = false } = {}) {
    if (oldLogin && currentId === 'default') currentId = 'default@old';
    const u = await aiUsage(false);
    const usageById = new Map((u.accounts || []).map((a) => [a.id, a]));
    const localUsage = (u.accounts || []).find((a) => a.provider === 'Claude' && a.live && /Claude Code/.test(a.label));
    const list = [{ id: 'default', label: oldLogin ? 'Claude Code (이 PC, 새 로그인)' : 'Claude Code (이 PC)', usage: localUsage },
      ...tokenAccounts().map((a) => ({ id: a.id, label: a.label, usage: usageById.get(a.id) }))];
    const emailOf = (c) => (c.usage?.email || (c.id === 'default' ? null : c.label) || '').toLowerCase() || null;
    const curEmail = list.find((c) => c.id === currentId) && emailOf(list.find((c) => c.id === currentId));
    const out = list.map((c) => {
      const fiveH = meterPct(c.usage, /5시간|5-hour/i);
      const weekly = meterPct(c.usage, /^(?:주간(?: \(전체 모델\)| 한도)?|weekly(?: \(all models\)| limit)?)$/i);
      const known = c.usage?.ok && (fiveH !== null || weekly !== null);
      const score = known ? Math.min(100 - (fiveH ?? 0), 100 - (weekly ?? 0)) : 50;
      const reset = (c.usage?.meters || []).find((m) => /5시간|5-hour/i.test(m.name))?.resetsAt
        || (c.usage?.meters || []).find((m) => /주간 \(전체|주간|weekly/i.test(m.name))?.resetsAt || null;
      const current = !!currentId && (c.id === currentId || (!!curEmail && emailOf(c) === curEmail));
      return { id: c.id, agent: 'claude', provider: 'Claude', label: c.label, fiveH, weekly, score, reset, current, sameAccount: current && c.id !== currentId, usable: c.usage?.ok !== false && score > 0 };
    });
    const best = out.filter((c) => c.usable && !c.current).sort((a, b) => b.score - a.score || (a.weekly ?? 0) - (b.weekly ?? 0))[0];
    if (best) best.best = true;
    return { candidates: out, stale: !!u.stale, usageAvailable: u.available !== false };
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

  function locateSession(sessionId, consoles) {
    const s = hub.liveSessions().find((x) => x.sessionId === sessionId);
    if (!s) return { live: false };
    const c = consoles.find((x) => x.pids.includes(s.pid));
    const t = c && [...hub.terms.values()].find((x) => x.pid && c.pids.includes(x.pid) && x.exited === null);
    return { live: true, s, console: c, term: t, account: t?.account?.id || 'default' };
  }

  async function allSwitchCandidates({ sessionId = '', termId = '' }) {
    const cons = (await hub.helperCall({ op: 'list' })).consoles || [];
    const loc = sessionId ? locateSession(sessionId, cons) : { live: false };
    const tt = termId ? [...hub.terms.values()].find((x) => String(x.id) === String(termId)) : loc.term;
    const d = sessionId ? index.get(sessionId) : (tt && hub.isCodexTerm(tt) ? hub.codexDocOf(tt) : null);
    const sourceAgent = tt ? (hub.isCodexTerm(tt) ? 'codex' : hub.isAgyTerm(tt) ? 'agy' : 'claude') : (d?.agent || 'claude');
    const isLive = tt ? tt.exited === null : !!loc.live;
    const curClaudeId = isLive && sourceAgent === 'claude' ? (tt?.account?.id || loc.account || 'default') : null;
    const curCodexId = isLive && sourceAgent === 'codex' ? (tt?.account?.id || 'auto-codex') : null;
    const curAgyId = isLive && sourceAgent === 'agy' ? (tt?.account?.id || 'agy-cli') : null;
    const curAgyEmail = isLive && sourceAgent === 'agy' ? (tt?.account?.email || null) : null;

    const oldLogin = curClaudeId === 'default' && !tt && !!loc.live && onOldLogin(loc.s?.startedAt);
    const [clRes, cxRes, u] = await Promise.all([switchCandidates(curClaudeId, { oldLogin }), codexCandidates(curCodexId), aiUsage(false)]);
    let swapAccounts = hub.agyEnabled !== false ? (agySwap.getFast().accounts || []) : [];
    if (hub.agyEnabled !== false && agySwap.available() && !swapAccounts.length) {
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

    const groups = {
      claude: clRes.candidates.map((c) => ({ ...c, best: false })),
      codex: cxRes.candidates.map((c) => ({ ...c, best: false })),
      agy: hub.agyEnabled !== false ? agyCands.map((c) => ({ ...c, best: false })) : [],
    };
    const order = sourceAgent === 'codex' ? ['codex', 'claude', 'agy'] : sourceAgent === 'agy' ? ['agy', 'codex', 'claude'] : ['claude', 'codex', 'agy'];
    const all = order.flatMap((k) => groups[k]);
    const bestSame = groups[sourceAgent].filter((c) => c.usable && !c.current).sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
    const bestAny = all.filter((c) => c.usable && !c.current).sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
    if (bestSame) bestSame.best = true;
    else if (bestAny && config.switchCrossAgentAuto === true) bestAny.best = true;

    return {
      candidates: all, sourceAgent, stale: !!(clRes.stale || cxRes.stale), usageAvailable: clRes.usageAvailable,
      live: isLive, fresh: !!tt && !sessionId && !d, busy: loc.s?.status === 'busy',
      where: tt ? `t:${tt.id}` : loc.console ? `c:${loc.console.id}` : null,
    };
  }

  function writeHandoffFile({ sessionId, d, t0, sourceAgent, targetAgent, cwd, followUp = '', cont = false }) {
    const dir = path.join(baseDir, 'uploads');
    fs.mkdirSync(dir, { recursive: true });
    const tag = (sessionId || (t0 && `term-${t0.id}`) || String(Date.now())).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 16);
    const file = path.join(dir, `handoff-${tag}.md`);
    const lines = [
      `# 세션 이어받기 맥락 (${sourceAgent.toUpperCase()} → ${targetAgent.toUpperCase()})`,
      `- 원본 세션 ID: ${sessionId || (t0 ? `t:${t0.id}` : 'unknown')}`,
      `- 작업 폴더: ${cwd || ''}`,
      d?.title || d?.firstPrompt ? `- 세션 제목: ${(d.title || d.firstPrompt).split('\n')[0]}` : '',
      '', '## 최근 대화 기록 (직전 맥락)',
    ].filter((x) => x !== null);
    const msgs = d?.msgs?.length ? d.msgs.filter((m) => !String(m.text || '').startsWith('⚙') || /^⚙ \[(?:설정|터미널)/.test(String(m.text || ''))).slice(-20) : [];
    if (msgs.length) {
      for (const m of msgs) {
        const who = m.role === 'user' ? '사용자 (User)' : `이전 에이전트 (${sourceAgent})`;
        const txt = String(m.text || '').replace(/<external_codex_apps_[^>]*>[\s\S]*?<\/external_codex_apps_[^>]*>/gi, '').trim().slice(0, 1500);
        if (txt) lines.push(`\n### [${who}]\n${txt}`);
      }
    } else if (t0) {
      const scr = hub.readTerm(t0, 60).join('\n').trim();
      if (scr) lines.push('\n```text\n' + scr.slice(-3000) + '\n```');
    } else {
      lines.push('\n_(저장된 이전 대화 메시지가 없어 세션 메타데이터만 전달합니다)_');
    }
    if (followUp && String(followUp).trim()) {
      lines.push('', '## [이관 후 즉시 실행할 요청]', String(followUp).trim());
    } else if (!cont) {
      lines.push('', '## 안내', '위 맥락을 파악해 둔 뒤, 준비 완료를 짧게 알리고 다음 지시를 기다려 주세요.');
    }
    fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
    return file;
  }

  function launchExternalWindow({ cwd, title, cmd, args = [], env = {}, openMode = 'external', admin = false }) {
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
    const safeTitle = String(title || 'Agent CLI').replace(/["^&|<>]/g, '');
    const cmdLine = [q(cmd), ...args.map(q)].join(' ');
    if (admin) {
      const psEsc = (s) => String(s).replace(/'/g, "''");
      const inner = args.length || !/^(?:cmd|powershell|pwsh)(?:\.exe)?$/i.test(path.basename(cmd))
        ? `/k ${cmdLine}`
        : '';
      const argExpr = inner ? `-ArgumentList '${psEsc(inner)}'` : '';
      const fileToRun = /^(?:powershell|pwsh)(?:\.exe)?$/i.test(path.basename(cmd)) && !args.length ? cmd : 'cmd.exe';
      const psCmd = `Start-Process -FilePath '${psEsc(fileToRun)}' ${argExpr} -WorkingDirectory '${psEsc(workCwd)}' -Verb RunAs`;
      spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCmd], {
        cwd: workCwd, env: { ...process.env, ...env }, detached: true, stdio: 'ignore', windowsHide: true,
      }).unref();
      return { ok: true, external: true, openMode: 'external', admin: true };
    }
    spawn('cmd.exe', ['/c', 'start', `"${safeTitle}"`, '/d', workCwd, 'cmd.exe', '/k', cmdLine], {
      cwd: workCwd, env: { ...process.env, ...env }, detached: true, stdio: 'ignore', windowsHide: false,
    }).unref();
    return { ok: true, external: true, openMode: 'external' };
  }

  async function switchAccount({ sessionId, termId, account = 'auto', model = '', effort = '', cont = false, followUp = '', verifyFollowUp = false, skip, interrupt = false, force = false, openMode = 'dashboard' }) {
    let t0 = termId != null && termId !== '' ? [...hub.terms.values()].find((x) => String(x.id) === String(termId)) : null;
    let sid = sessionId || (t0 && hub.termSessionId(t0)) || '';
    if (!t0 && sid) t0 = [...hub.terms.values()].find((x) => x.exited === null && hub.termSessionId(x) === sid) || null;
    const d = sid ? index.get(sid) : (t0 ? hub.termDocOf(t0) : null);
    if (d) { sid = sid || d.id; if (d.file) await index.updateFile(d.file); }

    const cons = (await hub.helperCall({ op: 'list' })).consoles || [];
    const loc = sid ? locateSession(sid, cons) : { live: false };
    const { candidates, sourceAgent } = await allSwitchCandidates({ sessionId: sid, termId: t0?.id });
    const reqME = cleanModelEffort(model, effort);
    const cliDirect = /^__cli__:(claude|codex|agy)$/.exec(String(account || ''));
    const pick = account === 'auto'
      ? (candidates.find((c) => c.best) || candidates.find((c) => c.usable && !c.current))
      : cliDirect
        ? (candidates.find((c) => c.agent === cliDirect[1] && c.current) || candidates.find((c) => c.agent === cliDirect[1]) || { id: 'default', agent: cliDirect[1], label: `${cliDirect[1]} (기본)` })
        : candidates.find((c) => c.id === account);
    if (!pick) return { ok: false, error: account === 'auto' ? '여유 있는 다른 계정이 없습니다 (AI 사용량 확인)' : '선택한 계정을 찾을 수 없습니다' };

    const targetAgent = pick.agent || 'claude';
    const { hasAgyCliConversation } = require('./agy-session');
    const canNativeAgy = !(targetAgent === 'agy' && sid && !hasAgyCliConversation(sid));
    const samePlatform = sourceAgent === targetAgent && canNativeAgy;
    const execution = hub.workspaceExecution;
    const workspaceSource = t0 ? execution?.forTerm(t0) : execution?.native(nativeFolderKey(sourceAgent, sid));
    const workspacePlan = () => execution?.plan({ source: workspaceSource,
      resumeKey: samePlatform ? nativeFolderKey(targetAgent, sid) : '',
      external: openMode === 'external' || openMode === 'ide', skipPermissions: skip });
    let workspaceLaunch = await workspacePlan();
    const allowBypass = !workspaceLaunch && (skip === undefined || skip);
    if (workspaceLaunch && targetAgent === 'codex') resolveLaunchFolders({ cli: targetAgent, ...codexLaunch(), plan: workspaceLaunch });
    if (samePlatform && t0 && workspaceLaunch) await execution.guardTerm(t0);
    const savedME = accountPrefs.getForAccount(pick.id, targetAgent);
    const useME = cleanModelEffort(model === undefined ? savedME.model : reqME.model, effort === undefined ? savedME.effort : reqME.effort);
    if (model !== undefined || effort !== undefined) accountPrefs.save({ account: pick.id, agent: targetAgent, model: useME.model, effort: useME.effort });
    const cwd = workspaceLaunch?.row.primary.path || d?.cwd || t0?.cwd || loc.s?.cwd || os.homedir();

    let handoffFile = null;
    let handoffPrompt = null;
    if (!samePlatform && (d?.msgs?.length || t0 || sid)) {
      handoffFile = writeHandoffFile({ sessionId: sid, d, t0, sourceAgent, targetAgent, cwd, followUp, cont });
      if (followUp && String(followUp).trim()) {
        handoffPrompt = `이전 ${sourceAgent.toUpperCase()} 세션의 작업을 이어받았습니다. "${handoffFile}" 파일에 정리된 직전 대화 맥락과 마지막의 [이관 후 즉시 실행할 요청]을 먼저 읽고 바로 실행해 주세요.`;
      } else if (cont) {
        handoffPrompt = `이전 ${sourceAgent.toUpperCase()} 세션의 작업을 이어받았습니다. "${handoffFile}" 파일에 정리된 직전 대화 맥락을 먼저 읽고, 마지막으로 논의하던 작업을 바로 이어서 진행해 주세요.`;
      } else {
        handoffPrompt = `이전 ${sourceAgent.toUpperCase()} 세션에서 작업을 넘겨받았습니다. "${handoffFile}" 파일에 정리된 직전 대화 맥락을 먼저 읽고, 현재까지의 진행 상황을 간단히 파악한 뒤 다음 지시를 기다려 주세요.`;
      }
    }

    // Native cross-platform session conversion for Claude <-> Codex (and AGY -> Claude/Codex).
    // Target AGY always stays on the markdown handoff path (`handoff-*.md` + `--prompt-interactive`).
    let nativeConverted = null;
    if (!samePlatform && targetAgent !== 'agy' && hub.nativeCrossHandoff !== false) {
      const sourceMsgs = d?.msgs?.length ? d.msgs : (sourceAgent === 'agy' && sid ? readAgyConversationTurns(sid) : []);
      if (sourceMsgs.length) {
        const originTitle = (d?.title || d?.firstPrompt?.split('\n')[0] || '').trim();
        if (targetAgent === 'codex') {
          const acc = CA.accounts(USAGE_DIR).find((a) => a.id === pick.id);
          const codexEnv = CA.envFor(acc);
          const codexHome = hub.codexHome || codexEnv.CODEX_HOME || path.join(os.homedir(), '.codex');
          nativeConverted = writeNativeCodexSession({ codexHome, cwd, msgs: sourceMsgs, title: originTitle });
        } else if (targetAgent === 'claude') {
          let claudeConfigDir = path.join(os.homedir(), '.claude');
          if (pick.id !== 'default') {
            const acc = tokenAccounts().find((a) => a.id === pick.id);
            if (acc?.type === 'claude' && acc.credentialsPath) claudeConfigDir = path.dirname(acc.credentialsPath);
          } else if (hub.claudeDir) {
            claudeConfigDir = hub.claudeDir;
          }
          nativeConverted = writeNativeClaudeSession({ claudeProjectsDir: path.join(claudeConfigDir, 'projects'), cwd, msgs: sourceMsgs, title: originTitle });
        }
        if (nativeConverted?.file) await index.updateFile?.(nativeConverted.file).catch(() => {});
      }
    }
    const effectiveFollowUp = followUp && String(followUp).trim() ? String(followUp).trim() : (cont ? '계속 진행해' : '');
    const nativeInitialPrompt = nativeConverted ? effectiveFollowUp : '';

    const verifyHandoff = verifyFollowUp === true && !!(nativeConverted ? nativeInitialPrompt : handoffPrompt) && openMode === 'dashboard';
    const inheritedProjectTask = t0?.meta?.projectTask || null;
    if (t0 && inheritedProjectTask) {
      if (d?.file) await index.updateFile(d.file).catch(() => {});
      hub.rememberProjectTerm(t0);
      if (sid) projects.remember([{ projectId: inheritedProjectTask.projectId, taskId: inheritedProjectTask.taskId, sessionId: sid, agent: sourceAgent, accountId: t0.account?.id, tokens: index.get(sid)?.tokens }]);
    }

    const matchingTerms = [...hub.terms.values()].filter((x) => (t0 && x.id === t0.id) || (sid && hub.termSessionId(x) === sid));
    const writeControl = async (term, data) => {
      const result = await term.proc.write(data);
      if (result?.guardError) throw result.guardError;
    };
    if (samePlatform && matchingTerms.length && openMode === 'dashboard') {
      for (const tm of matchingTerms) {
        if (tm.exited === null) {
          if (hub.isCodexTerm(tm)) { await writeControl(tm, '\x03'); await hub.sleep(350); await writeControl(tm, '\x03'); }
          else if (hub.isAgyTerm(tm)) { await writeControl(tm, '\x03'); await hub.sleep(250); await writeControl(tm, '/exit'); await hub.sleep(hub.SUBMIT_DELAY); await writeControl(tm, '\r'); }
          else { await writeControl(tm, '\x1b'); await hub.sleep(350); await writeControl(tm, '/exit'); await hub.sleep(hub.SUBMIT_DELAY); await writeControl(tm, '\r'); }
          if (!(await hub.waitFor(() => tm.exited !== null, 4500))) try { tm.proc.kill(); } catch {}
        }
        hub.forgetTerm(tm);
      }
    } else if (samePlatform && loc.live && openMode === 'dashboard') {
      if (loc.s.status === 'busy' && !interrupt) return { ok: false, busy: true, error: '세션이 작업 중입니다. 중단하고 전환할까요?' };
      const gone = () => !hub.pidAlive(loc.s.pid) || (loc.term && loc.term.exited !== null);
      if (loc.term) {
        await writeControl(loc.term, '\x1b'); await hub.sleep(1000); await writeControl(loc.term, '/exit'); await hub.sleep(hub.SUBMIT_DELAY); await writeControl(loc.term, '\r');
        if (!(await hub.waitFor(gone, 8000))) try { loc.term.proc.kill(); } catch {}
        await hub.waitFor(gone, 5000);
        hub.forgetTerm(loc.term);
      } else if (loc.console) {
        if (!force) {
          await hub.helperCall({ op: 'send', pid: loc.console.id, keys: ['esc'] }); await hub.sleep(1000);
          await hub.helperCall({ op: 'send', pid: loc.console.id, text: '/exit' }); await hub.sleep(hub.SUBMIT_DELAY);
          await hub.helperCall({ op: 'send', pid: loc.console.id, keys: ['enter'] });
        }
        if (!(await hub.waitFor(gone, force ? 1000 : 15000))) {
          if (!force) return { ok: false, stuck: true, error: '기존 창의 프로세스가 /exit에 반응하지 않습니다. 강제 종료하고 전환할까요? (대화 기록은 보존됨)' };
          try { process.kill(loc.s.pid); } catch {}
          if (!(await hub.waitFor(gone, 8000))) return { ok: false, error: `기존 프로세스(pid ${loc.s.pid})를 종료하지 못했습니다.` };
        }
      }
    }

    let cmd, args = [], env = {};
    if (targetAgent === 'codex') {
      const acc = CA.accounts(USAGE_DIR).find((a) => a.id === pick.id);
      env = CA.envFor(acc);
      ({ cmd, args } = codexLaunch([
        ...(allowBypass ? ['--dangerously-bypass-approvals-and-sandbox'] : []),
        ...cliModelEffortArgs('codex', useME.model, useME.effort),
        ...(samePlatform && sid ? ['resume', sid, ...(cont ? ['계속 진행해'] : [])]
          : samePlatform && t0 ? ['resume', '--last', ...(cont ? ['계속 진행해'] : [])]
            : nativeConverted ? ['resume', nativeConverted.sessionId, ...(nativeInitialPrompt && !verifyHandoff ? [nativeInitialPrompt] : [])]
              : handoffPrompt && !verifyHandoff ? [handoffPrompt] : []),
      ]));
    } else if (targetAgent === 'agy') {
      cmd = agyExe();
      if (String(pick.id).startsWith('agyswap:')) {
        try {
          await agySwap.switchTo(pick.email || pick.id);
          agyQuota.noteAccount(pick.email || String(pick.id).slice(8));
          agyQuota.refresh({ force: true }).catch(() => {});
        } catch (e) { return { ok: false, error: `Antigravity 계정 전환 실패: ${e.message}` }; }
      } else {
        const gKey = geminiAccounts().find((a) => a.id === pick.id)?.apiKey?.();
        if (gKey) env = { GEMINI_API_KEY: gKey, GOOGLE_API_KEY: gKey };
      }
      if (samePlatform && sid) args.push('--conversation', sid);
      if (allowBypass) args.push('--dangerously-skip-permissions');
      args.push(...cliModelEffortArgs('agy', useME.model, useME.effort));
      const agyPrompt = !samePlatform ? handoffPrompt : (cont && sid ? '계속 진행해' : null);
      if (agyPrompt && !verifyHandoff) args.push('--prompt-interactive', agyPrompt);
    } else {
      cmd = 'claude.exe';
      if (pick.id !== 'default') {
        const acc = tokenAccounts().find((a) => a.id === pick.id);
        if (acc?.type === 'claude' && acc.credentialsPath) env.CLAUDE_CONFIG_DIR = path.dirname(acc.credentialsPath);
        else if (acc) try { env.CLAUDE_CODE_OAUTH_TOKEN = acc.token(); } catch (e) { return { ok: false, error: `토큰을 읽지 못함: ${e.message}` }; }
      }
      if (samePlatform && sid) args.push('--resume', sid);
      else if (nativeConverted) args.push('--resume', nativeConverted.sessionId);
      if (allowBypass) args.push('--dangerously-skip-permissions');
      args.push(...cliModelEffortArgs('claude', useME.model, useME.effort));
    }

    const short = (pick.email || pick.label || targetAgent).replace(/@.*/, '');
    const originShort = (d?.title || d?.firstPrompt?.split('\n')[0].slice(0, 24) || '').trim();
    const baseTitle = !samePlatform
      ? (originShort ? `${targetAgent} ⇐ ${originShort}` : targetAgent)
      : (d?.title || d?.firstPrompt?.split('\n')[0].slice(0, 36) || (t0 ? String(t0.title || targetAgent).replace(/ [⇄·] .*$/, '') : sid ? sid.slice(0, 8) : targetAgent));
    const title = `${baseTitle} ⇄ ${short}`;

    if (openMode === 'external' || openMode === 'ide') {
      launchExternalWindow({ cwd, title, cmd, args, env, openMode });
      return { ok: true, external: true, openMode, ...(handoffFile ? { handoffFile } : {}), account: { id: pick.id, label: pick.label, agent: targetAgent, fiveH: pick.fiveH, weekly: pick.weekly } };
    }

    let project = null;
    if (samePlatform && targetAgent === 'claude' && sid) {
      try { project = require('./harness').lib('project').listProjects().find((p) => p.state.director_session_id === sid) || null; } catch {}
      if (project) Object.assign(env, { RESEARCH_ROLE: 'director', CLAUDE_CODE_STOP_HOOK_BLOCK_CAP: '200' });
    }
    workspaceLaunch = await workspacePlan();
    const t = hub.createTerm({
      cwd, cmd, args, env, title,
      account: { id: pick.id, label: pick.label, kind: targetAgent, ...(pick.email ? { email: pick.email } : {}) },
      model: useME.model, effort: useME.effort, research: project ? project.dir : null,
      projectTask: inheritedProjectTask || undefined,
      projectPrompt: inheritedProjectTask ? (handoffPrompt ? fingerprint(handoffPrompt) : t0?.meta?.projectPrompt) : undefined,
      workspaceLaunch, workspaceCli: targetAgent,
    });
    hub.overviewStale?.();
    if (samePlatform && t0) {
      const favs = hub.loadFavs();
      if (favs.includes(`term:${t0.id}`)) fs.writeFileSync(hub.FAV_FILE, JSON.stringify(favs.map((k) => (k === `term:${t0.id}` ? `term:${t.id}` : k))));
    }
    if (project) {
      t.research = project.dir;
      require('./harness').lib('project').updateState(project.dir, (s) => {
        s.director_account = pick.id === 'default' ? null : pick.id;
        s.status = 'running'; s.wake_at = null; s.wait_reason = ''; s.limited = false; s.limit_notice_at = null;
      });
    }

    if (!samePlatform && sid && hub.conversationBranches?.addBranch) {
      const originTitle = (d?.title || d?.firstPrompt?.split('\n')[0] || '').trim();
      hub.conversationBranches.addBranch({
        parentSessionId: sid,
        childSessionId: nativeConverted?.sessionId || null,
        termId: t.id,
        sourceAgent,
        targetAgent,
        mode: nativeConverted ? 'native-handoff' : 'handoff',
        atIndex: Math.max(0, (d?.msgs?.length || 1) - 1),
        branchTitle: originTitle ? `(이관) ${originTitle.slice(0, 40)}` : `${sourceAgent} → ${targetAgent}`,
        anchorText: handoffFile ? path.basename(handoffFile) : '',
        editedText: followUp ? String(followUp).slice(0, 500) : '',
        native: !!nativeConverted,
      });
    }

    let deliveryError;
    const dispatchPrompt = nativeConverted ? nativeInitialPrompt : handoffPrompt;
    if (verifyHandoff) {
      try {
        const spawned = await t.spawnResult;
        if (!spawned?.ok) throw new Error(spawned?.error || '터미널을 열 수 없습니다.');
        await waitForTerminalInput(hub, t);
        await dispatchTerminalPrompt(hub, t, dispatchPrompt, { cli: targetAgent });
      } catch (error) {
        deliveryError = error.message;
      }
    }
    const promptToSend = !verifyHandoff && targetAgent === 'claude' ? (!samePlatform ? (nativeConverted ? (nativeInitialPrompt || null) : handoffPrompt) : (cont && samePlatform && sid ? '계속 진행해' : null)) : null;
    if (promptToSend) (async () => {
      if (await hub.waitFor(() => t.exited === null && hub.inputReady(t), 45000, 700)) {
        await hub.sleep(600);
        const result = await t.proc.write(promptToSend);
        if (!result?.ok) throw result?.guardError || new Error(result?.error || 'Terminal input failed');
        await hub.sleep(hub.SUBMIT_DELAY);
        const submitted = await t.proc.write('\r');
        if (!submitted?.ok) throw submitted?.guardError || new Error(submitted?.error || 'Terminal input failed');
      }
    })().catch((error) => console.error('[account] follow-up:', error.message));

    return {
      ok: true, term: hub.termInfo(t),
      account: { id: pick.id, label: pick.label, agent: targetAgent, fiveH: pick.fiveH, weekly: pick.weekly },
      crossPlatform: !samePlatform,
      nativeConverted: !!nativeConverted,
      ...(nativeConverted ? { convertedSessionId: nativeConverted.sessionId } : {}),
      ...(verifyHandoff ? { followUpSubmitted: !deliveryError, deliveryError } : {}),
      ...(handoffFile ? { handoffFile } : {}),
      stopped: t0 ? `t:${t0.id}` : loc.live ? (loc.term ? `t:${loc.term.id}` : `c:${loc.console?.id}`) : null,
    };
  }

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

  function readCodexModelsCache() {
    try {
      const fp = path.join(os.homedir(), '.codex', 'models_cache.json');
      const raw = JSON.parse(fs.readFileSync(fp, 'utf8'));
      const list = Array.isArray(raw?.models) ? raw.models : [];
      const visible = list.filter((m) => m && m.slug && m.visibility === 'list');
      const models = visible.map((m) => ({
        id: m.slug,
        label: m.display_name && m.display_name !== m.slug ? `${m.display_name} (${m.slug})` : m.slug,
      }));
      const effortSet = new Set();
      for (const m of visible) {
        for (const lv of (m.supported_reasoning_levels || [])) {
          if (lv?.effort) effortSet.add(lv.effort);
        }
      }
      return { models, efforts: [...effortSet] };
    } catch { return { models: [], efforts: [] }; }
  }

  function readClaudeRecentModels() {
    const found = new Set();
    try {
      const pDir = path.join(os.homedir(), '.claude', 'projects');
      if (!fs.existsSync(pDir)) return [];
      const dirs = fs.readdirSync(pDir, { withFileTypes: true }).filter((d) => d.isDirectory()).slice(0, 16);
      for (const d of dirs) {
        const sub = path.join(pDir, d.name);
        const files = fs.readdirSync(sub, { withFileTypes: true })
          .filter((f) => f.isFile() && f.name.endsWith('.jsonl'))
          .slice(0, 4);
        for (const f of files) {
          const head = fs.readFileSync(path.join(sub, f.name), 'utf8').slice(0, 16000);
          for (const m of head.matchAll(/"model"\s*:\s*"(claude-[a-z0-9.-]+)"/g)) {
            if (!m[1].includes('<')) found.add(m[1]);
          }
        }
      }
    } catch {}
    return [...found];
  }

  let agyModelsCache = { at: 0, models: null, inflight: null };
  function refreshAgyModelsCache() {
    if (agyModelsCache.inflight) return agyModelsCache.inflight;
    const exe = agyExe();
    if (!exe) return Promise.resolve([]);
    agyModelsCache.inflight = new Promise((resolve) => {
      execFile(exe, ['models'], { timeout: 8000, windowsHide: true }, (err, stdout) => {
        agyModelsCache.inflight = null;
        if (err || !stdout) return resolve(agyModelsCache.models || []);
        const parsed = [];
        for (const rawLine of String(stdout).split(/\r?\n/)) {
          const m = /^([a-z0-9][a-z0-9._-]*)\t+(.+?)\s*$/i.exec(rawLine.trim());
          if (m) parsed.push({ id: m[1].trim(), label: m[2].trim() });
        }
        if (parsed.length) agyModelsCache = { at: Date.now(), models: parsed, inflight: null };
        resolve(agyModelsCache.models || []);
      });
    });
    return agyModelsCache.inflight;
  }

  function readAgyConfigDefaults() {
    try {
      const f = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'settings.json');
      if (!fs.existsSync(f)) return { model: '', effort: '' };
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      return {
        model: typeof j?.model === 'string' ? j.model.trim() : '',
        effort: typeof j?.effort === 'string' ? j.effort.trim() : '',
      };
    } catch { return { model: '', effort: '' }; }
  }

  function projectCliOptions() {
    const cx = readCodexConfigDefaults();
    const cxCache = readCodexModelsCache();
    const cxFallback = [
      { id: 'gpt-6.2-sol', label: 'GPT-6.2-Sol (gpt-6.2-sol)' },
      { id: 'gpt-6.2-astra', label: 'GPT-6.2-Astra (gpt-6.2-astra)' },
      { id: 'gpt-6.1-terra', label: 'GPT-6.1 Terra (gpt-6.1-terra)' },
      { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol (gpt-6.1-sol)' },
      { id: 'gpt-6-astra', label: 'GPT-6-Astra (gpt-6-astra)' },
      { id: 'gpt-6-sol', label: 'GPT-6-Sol (gpt-6-sol)' },
      { id: 'gpt-6-luna', label: 'GPT-6-Luna (gpt-6-luna)' },
      { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol (gpt-5.6-sol)' },
    ];
    const cxModels = [
      ...(cx.model ? [{ id: cx.model, label: `${cx.model} (현재 기본)` }] : []),
      ...(cxCache.models.length ? cxCache.models : cxFallback),
    ].filter((m, i, arr) => arr.findIndex((x) => x.id === m.id) === i);
    const cxEffortIds = ['', ...(cx.enabled?.length ? cx.enabled : (cxCache.efforts.length ? cxCache.efforts : ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']))];
    const claudeStatic = [
      { id: 'opus', label: 'Claude Opus (최신 별칭)' },
      { id: 'sonnet', label: 'Claude Sonnet (최신 별칭)' },
      { id: 'haiku', label: 'Claude Haiku (최신 별칭)' },
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (claude-opus-5-5)' },
      { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (claude-sonnet-5-5)' },
      { id: 'claude-fable-5-2', label: 'Claude Fable 5.2 (claude-fable-5-2)' },
      { id: 'claude-opus-4-6', label: 'Claude Opus 4.6 (claude-opus-4-6)' },
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (claude-sonnet-4-6)' },
    ];
    const claudeModels = [
      ...claudeStatic,
      ...readClaudeRecentModels().map((id) => ({ id, label: id })),
    ].filter((m, i, arr) => arr.findIndex((x) => x.id === m.id) === i);
    const agyDefaultModels = [
      { id: 'gemini-4-neon-high', label: 'Gemini 4 Neon (High)' },
      { id: 'gemini-4-neon-xhigh', label: 'Gemini 4 Neon (XHigh)' },
      { id: 'gemini-4-neon-medium', label: 'Gemini 4 Neon (Medium)' },
      { id: 'gemini-4-neon-low', label: 'Gemini 4 Neon (Low)' },
      { id: 'gemini-4-carbon-high', label: 'Gemini 4 Carbon (High)' },
      { id: 'gemini-4-carbon-medium', label: 'Gemini 4 Carbon (Medium)' },
      { id: 'gemini-4-carbon-low', label: 'Gemini 4 Carbon (Low)' },
      { id: 'gemini-4-argon-high', label: 'Gemini 4 Argon (High)' },
      { id: 'gemini-4-argon-medium', label: 'Gemini 4 Argon (Medium)' },
      { id: 'gemini-4-argon-low', label: 'Gemini 4 Argon (Low)' },
      { id: 'gemini-4-hydrogen-high', label: 'Gemini 4 Hydrogen (High)' },
      { id: 'gemini-4-hydrogen-xhigh', label: 'Gemini 4 Hydrogen (XHigh)' },
      { id: 'gemini-4-hydrogen-medium', label: 'Gemini 4 Hydrogen (Medium)' },
      { id: 'gemini-4-hydrogen-low', label: 'Gemini 4 Hydrogen (Low)' },
      { id: 'gemini-pro-orchestrator-neon', label: 'Orchestrator (Neon)' },
      { id: 'gemini-pro-orchestrator', label: 'Orchestrator (Carbon)' },
      { id: 'gemini-pro-orchestrator-argon', label: 'Orchestrator (Argon)' },
      { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
      { id: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)' },
      { id: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)' },
      { id: 'claude-opus-5-5-high', label: 'Claude Opus 5.5 (High)' },
      { id: 'claude-opus-5-5-medium', label: 'Claude Opus 5.5 (Medium)' },
      { id: 'claude-opus-5-5-low', label: 'Claude Opus 5.5 (Low)' },
      { id: 'claude-sonnet-5-5-high', label: 'Claude Sonnet 5.5 (High)' },
      { id: 'claude-sonnet-5-5-medium', label: 'Claude Sonnet 5.5 (Medium)' },
      { id: 'claude-sonnet-5-5-low', label: 'Claude Sonnet 5.5 (Low)' },
      { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)' },
    ];
    if (hub.agyEnabled !== false && (!agyModelsCache.models || Date.now() - agyModelsCache.at > 15 * 60_000)) {
      refreshAgyModelsCache().catch(() => {});
    }
    const agyCfg = readAgyConfigDefaults();
    const agyModels = [
      ...(agyModelsCache.models?.length ? agyModelsCache.models : agyDefaultModels),
      ...agyDefaultModels,
    ].filter((m, i, arr) => arr.findIndex((x) => x.id === m.id) === i);
    const mapEff = (ids) => [...new Set(ids)].map((id) => ({ id, label: EFFORT_LABELS[id] || id }));
    return {
      codex: { models: cxModels, efforts: mapEff(cxEffortIds), defaultModel: cx.model, defaultEffort: cx.effort },
      claude: { models: claudeModels, efforts: mapEff(['', 'low', 'medium', 'high', 'xhigh', 'max']), defaultModel: '', defaultEffort: '' },
      ...(hub.agyEnabled !== false ? {} : { agyDisabled: true }),
      agy: { models: agyModels, efforts: mapEff(['', 'low', 'medium', 'high', 'xhigh', 'max']), defaultModel: agyCfg.model, defaultEffort: agyCfg.effort },
      cursor: { models: [], efforts: [{ id: '', label: EFFORT_LABELS[''] }], defaultModel: '', defaultEffort: '' },
    };
  }

  const CODEX_LIMIT_SCREEN = /you['’]ve hit your usage limit|hit your usage limit|usage limit (reached|exceeded)|reached your usage limit/i;
  async function codexLimitWatch() {
    if (config.codexAutoSwitch === false || (hub.instance && !hub.instance.codexAutoSwitch)) return;
    for (const t of [...hub.terms.values()]) {
      if (t.exited !== null || !hub.isCodexTerm(t) || t.meta?.projectTask || Date.now() - (t.codexSwitchedAt || t.meta?.spawnedAt || 0) < 10 * 60e3) continue;
      let screen = ''; try { screen = hub.readTerm(t, 30).join('\n'); } catch { continue; }
      if (!CODEX_LIMIT_SCREEN.test(screen)) continue;
      t.codexSwitchedAt = Date.now();
      const best = (await codexCandidates(t.account?.id || 'auto-codex').catch(() => ({ candidates: [] }))).candidates.find((c) => c.best);
      const r = best ? await switchAccount({ termId: t.id, account: best.id, cont: true }).catch((e) => ({ ok: false, error: e.message }))
        : { ok: false, error: '여유 있는 다른 Codex 계정이 없습니다' };
      const msg = r.ok ? `🔁 codex t:${t.id} 한도 도달 → <b>${best.label}</b> 계정으로 같은 대화를 이어서 실행${r.term ? ` (t:${r.term.id})` : ''}` : `⚠ codex t:${t.id} 한도 도달, 전환 못 함: ${r.error}`;
      console.log(msg.replace(/<[^>]+>/g, ''));
      try { fs.mkdirSync(path.join(baseDir, 'notify'), { recursive: true }); fs.writeFileSync(path.join(baseDir, 'notify', `codex-switch-${Date.now()}.json`), JSON.stringify({ html: msg })); } catch {}
    }
  }
  setInterval(() => codexLimitWatch().catch((e) => console.error('[codex-switch]', e.message)), 30_000).unref?.();

  return {
    USAGE_URL, USAGE_DIR, agyExe, agyQuota, agySwapExe, agySwap, codexExe, codexLaunch,
    checkUsageServer, startUsageServer, ensureTrayMonitor, aiUsage,
    clearUsageCache: () => { usageCache = { at: 0, data: null }; },
    tokenAccounts, geminiAccounts, ensureAgySwap, projectAccounts,
    switchCandidates, codexCandidates, locateSession, allSwitchCandidates, onOldLogin,
    launchExternalWindow, switchAccount, projectCliOptions,
  };
}

module.exports = { createAccountSwitchService };
