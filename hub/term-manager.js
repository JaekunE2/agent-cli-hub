'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { Terminal: HeadlessTerminal } = require('@xterm/headless');
const { createTermScreenMonitor } = require('./term-events');
const { codexHistorySearchActive, flushNewAgyQueue } = require('./immediate-send');
const { hasCodexPasteDraft, submitPrompt } = require('./prompt-submission');
const { agyStatusFromScreen: explicitAgyStatus } = require('./agy-session');
const { requiredMcpMessage } = require('./vault-cli-ops');

const SESSION_ENV = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_CODE_(CHILD_SESSION|SESSION_ID|SESSION_ATTENDED|MESSAGING_SOCKET|MESSAGING_TOKEN|ENTRYPOINT|EXECPATH))$/;
const CODEX_BUSY = /esc to interrupt|esc to cancel/i;
const SUBMIT_DELAY = 350;
const RESTART_NOTE = '[대시보드 재시작으로 세션이 자동 재개됨] 재시작 직전에 진행 중이던 작업(백그라운드 대기·셸 포함)이 중단됐을 수 있습니다. 상태를 확인하고 필요한 것은 다시 실행해 이어서 진행하세요.';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const consoleSubmitDelay = (text) => SUBMIT_DELAY + Math.min(6000, String(text || '').length * 6);
const safeUploadName = (n) => (String(n || 'file').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(-120) || 'file');

function sessionStartupBlock(screen) {
  const lines = screen.trimEnd().split('\n');
  if (/^\s*SessionStart hooks\s*$/im.test(screen) && /space\s*\/\s*enter\s+toggle[^\n]*esc\s+back/i.test(lines.at(-1))) return 'hooks-menu';
  const bottom = lines.slice(-8).join('\n');
  if (/TERM is set to ["']dumb["']/i.test(bottom) && /Continue anyway\?\s*\[y\/N\]/i.test(lines.at(-1))) return 'term-dumb';
  if (/^\s*(?:[│┃?❯›>─ -]+\s*)?(?:Do you (?:want to )?trust\b|Trust (?:this|the) (?:folder|workspace|directory)\b)/im.test(bottom)
    || (/Yes, I trust this (?:folder|workspace|directory)/i.test(bottom) && /No, exit/i.test(bottom))) return 'folder-trust';
  if (/(?:Sign in with (?:ChatGPT|Google)|Login with Google|Select an authentication method)/i.test(bottom)) return 'login';
  if (/^\s*(?:[│┃?❯›>─ -]+\s*)?(?:Do you want to (?:proceed|make this edit|create|allow|run)|Allow Codex to)\b/im.test(bottom)) return 'permission';
  if (/^\s*(?:[│┃?❯›>─ -]+\s*)?Press Enter to continue[.!…]*\s*$/im.test(lines.at(-1))) return 'confirmation';
  if (/enter select · esc back/i.test(lines.at(-1)) && /\bKeep current model\b/i.test(bottom)) return 'confirmation';
  if (/(?:enter to (?:confirm|select)|esc to (?:deny|reject)|arrow keys to select|\benter\b[^\n]*\besc to cancel\b|\besc to cancel\b[^\n]*\benter\b)/i.test(lines.at(-1)) && /^\s*[›❯>]\s+\S/m.test(bottom)) return 'confirmation';
  if (/\brunning\b[^\n]*\bSessionStart\b|\bSessionStart hooks?\b[^\n]*\b(?:running|pending)\b/i.test(bottom)) return 'hooks-running';
  return '';
}

const HOOK_MENU_MESSAGE = 'SessionStart 훅 설정 메뉴가 열려 있습니다. 터미널에서 Esc로 메뉴를 닫은 뒤 작업을 다시 실행하세요.';
const FOLDER_TRUST_MESSAGE = '터미널에 작업 폴더 신뢰 확인이 필요합니다. 경로를 확인한 뒤 터미널에서 선택하세요.';
const DUMB_TERMINAL_MESSAGE = '이 터미널은 TERM=dumb으로 시작했습니다. 작업 다시 진행을 눌러 새 터미널에서 시작하세요.';
function terminalConfirmationMessage(block) {
  if (block === 'folder-trust') return FOLDER_TRUST_MESSAGE;
  if (block === 'login') return 'CLI 로그인이 필요합니다. 터미널에서 로그인한 뒤 작업을 이어가세요.';
  if (block === 'permission' || block === 'confirmation') return 'CLI가 확인을 요청하고 있습니다. 터미널에서 요청 내용을 확인하세요.';
  return '';
}

async function dismissProjectHookMenu(hub, term, screen) {
  if (term.exited !== null || term._projectHookEscapeSent || !hub.ptyPost || sessionStartupBlock(screen) !== 'hooks-menu') return false;
  term._projectHookEscapeSent = true;
  await writeProjectTerm(hub, term, '\x1b');
  return true;
}

async function writeProjectTerm(hub, term, data) {
  if (term.exited !== null || hub.terms && !hub.terms.has(term.id)) throw new Error('터미널 입력을 확인하지 못했습니다.');
  const result = await hub.ptyPost(term.id, '/write', { id: term.id, data });
  if (!result?.ok || term.exited !== null) throw new Error(result?.error || '터미널 입력을 확인하지 못했습니다.');
}

function submissionBlockMessage(screen) {
  const block = sessionStartupBlock(screen);
  if (block === 'hooks-menu') return HOOK_MENU_MESSAGE;
  if (block === 'term-dumb') return DUMB_TERMINAL_MESSAGE;
  if (block === 'hooks-running') return 'CLI 시작 훅이 실행 중입니다.';
  return terminalConfirmationMessage(block);
}

async function waitForTerminalInput(hub, term) {
  const screen = () => {
    const raw = hub.readTerm(term, Math.max(40, term.rows || 0)).join('\n');
    return hub.stripAnsi?.(raw) || raw;
  };
  const stopped = () => term.exited !== null || !hub.terms.has(term.id);
  const ready = await (hub.waitFor || waitFor)(async () => {
    if (stopped()) return true;
    const current = screen();
    const block = sessionStartupBlock(current);
    if (block === 'hooks-menu' && term.meta?.projectTask) {
      await dismissProjectHookMenu(hub, term, current);
      return false;
    }
    return !!terminalConfirmationMessage(block) || block === 'term-dumb' || hub.inputReady(term);
  }, 45000, 250);
  if (stopped()) throw new Error('터미널 입력을 확인하지 못했습니다.');
  const message = submissionBlockMessage(screen());
  if (message) throw new Error(message);
  if (!ready) throw new Error('CLI가 작업 입력을 받을 준비가 되지 않았습니다.');
}

async function dispatchTerminalPrompt(hub, term, text, { submitDraft = false, cli, immediate = false, resend = false } = {}) {
  if (term._promptSubmission) throw new Error('터미널 입력을 전송 중입니다.');
  term._promptSubmission = true;
  try {
    cli ||= hub.agentOf?.(term) || (hub.isCodexTerm?.(term) === false ? 'claude' : 'codex');
    const inputAt = term.lastInputAt;
    const inputSeq = term._interactiveInputSeq;
    const read = () => {
      const raw = hub.readTerm(term, Math.max(40, term.rows || 0)).join('\n');
      const screen = hub.stripAnsi?.(raw) || raw;
      const busy = (cli === 'codex' ? hub.codexStatus?.(term) : cli === 'agy'
        ? explicitAgyStatus(screen.split('\n').slice(-16).join('\n')) : hub.claudeStatus?.(term)) === 'busy';
      const cursorLine = cli === 'codex' ? hub.termCursorLine?.(term, Math.max(40, term.rows || 0)) : undefined;
      return { screen, busy, cursorLine };
    };
    const sessionTurn = () => {
      const sid = hub.index && (hub.termSessionId?.(term) || term.meta?.sessionId);
      return sid && hub.index.get?.(sid)?.msgs?.findLast((m) => m.role === 'user');
    };
    const priorTurn = sessionTurn();
    const initial = read();
    if (term.meta?.projectTask && sessionStartupBlock(initial.screen) === 'hooks-menu') {
      await dismissProjectHookMenu(hub, term, initial.screen);
      if (!await (hub.waitFor || waitFor)(() => sessionStartupBlock(read().screen) !== 'hooks-menu', 5000, 150)) {
        throw new Error(HOOK_MENU_MESSAGE);
      }
    }
    const guard = ({ screen }) => {
      const message = submissionBlockMessage(screen);
      if (message) throw new Error(message);
      if (term.exited !== null || term.lastInputAt !== inputAt || term._interactiveInputSeq !== inputSeq
        || codexHistorySearchActive(screen.split('\n'))) throw new Error('전송 중 터미널 입력 상태가 바뀌었습니다.');
    };
    text = text.replace(/\r\n?/g, '\n');
    if (resend && term._lastSubmittedPrompt === text) return true;
    term._lastSubmittedPrompt = undefined;
    const pending = term._pendingPromptDraft;
    const previousDraft = pending?.text === text && pending.inputSeq === inputSeq ? pending.draft : undefined;
    term._pendingPromptDraft = undefined;
    await submitPrompt({
      text, read, guard, explicitDraft: submitDraft, resend, waitFor: hub.waitFor || waitFor, sleep: hub.sleep || sleep,
      previousDraft, onDraft: (draft) => { term._pendingPromptDraft = { text, inputSeq, draft }; },
      paste: cli === 'codex' || /[\n\t]/.test(text) ? `\x1b[200~${text}\x1b[201~` : text,
      pasteMarker: cli,
      write: (data) => {
        guard(read());
        if (term.meta?.projectAutoClose && !term.meta.projectSubmitted && (data === '\r' || data === '\t')) {
          term.meta.projectSubmitted = true;
          hub.ptyPost(term.id, '/meta', { id: term.id, meta: { projectSubmitted: true } });
        }
        hub.termMonitor?.onInput(term, data);
        return writeProjectTerm(hub, term, data);
      },
      queueKey: ({ busy, screen }) => immediate && cli === 'codex' && busy && /tab to (?:queue|steer)/i.test(screen) ? '\t' : '',
      flushQueue: immediate && cli === 'agy' ? flushNewAgyQueue : undefined,
      started: (view, baseline, since) => {
        if (!baseline.busy && view.busy && view.screen !== baseline.screen) return true;
        if (baseline.busy && (cli === 'agy' || cli === 'claude') && view.screen !== baseline.screen
          && /(?:alt\s*\+\s*m\s*(?:to\s*)?send|^\s*queued:|press up to edit)/im.test(view.screen)
          && !/(?:alt\s*\+\s*m\s*(?:to\s*)?send|^\s*queued:|press up to edit)/im.test(baseline.screen)) return true;
        const turn = sessionTurn();
        return turn && turn !== priorTurn && Number(new Date(turn.ts)) >= since
          && turn.text?.trim() === text.trim();
      },
    });
    term._pendingPromptDraft = undefined;
    term._lastSubmittedPrompt = text;
    return true;
  } finally {
    term._promptSubmission = false;
  }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function cleanEnv() {
  const env = { FORCE_COLOR: '1' };
  for (const [k, v] of Object.entries(process.env)) if (!SESSION_ENV.test(k)) env[k] = v;
  return env;
}

async function waitFor(fn, ms, step = 500) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(step)) if (await fn()) return true;
  return false;
}

/** Create managed terminal, PTY host IPC, PID recovery, and state persistence manager. */
function createTermManager(hub) {
  const {
    baseDir, port, token, config, claudeDir, index, projects, accountPrefs, unifiedVault,
    codexRecoveryArgs, cliModelEffortArgs, buildRecoveryLaunchArgs, cleanModelEffort,
    CA, agyStatusFromScreen, readAgySession, stripAnsi,
  } = hub;

  const terms = new Map();
  let termSeq = 0;
  let ptyHostPid = 0;
  let matchBusy = false;

  const PTY_PORT = Number(process.env.CCD_PTY_PORT || (port === 7777 ? 7779 : port + 2));
  const PTY_URL = `http://127.0.0.1:${PTY_PORT}`;
  const TERMS_STATE = path.join(baseDir, port === 7777 ? 'terms-state.json' : `terms-state-${port}.json`);
  const FAV_FILE = path.join(baseDir, 'favorites.json');
  const UPLOAD_DIR = path.join(baseDir, 'uploads');

  const ptyChains = new Map();
  const consoleInputAt = new Map();
  const procInfoCache = new Map();

  async function ptyCall(p, b) {
    const r = await fetch(PTY_URL + p, {
      method: b ? 'POST' : 'GET',
      headers: { 'x-token': token, 'content-type': 'application/json' },
      body: b ? JSON.stringify(b) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    return r.json();
  }

  function ptyPost(id, p, b) {
    const next = (ptyChains.get(id) || Promise.resolve()).then(() => ptyCall(p, b)).catch((e) => console.error('[pty]', p, e.message));
    ptyChains.set(id, next);
    return next;
  }

  function touchUserInput(t) {
    if (!t) return;
    const now = Date.now();
    t.lastInputAt = now;
    t.meta = { ...(t.meta || {}), lastInputAt: now };
    ptyPost(t.id, '/meta', { id: t.id, meta: { lastInputAt: now } });
  }

  const isCodexTerm = (t) => /codex(\.exe)?$/i.test(t?.meta?.cmd || '') || (/cmd(\.exe)?$/i.test(t?.meta?.cmd || '') && /codex(\.cmd)?$/i.test(t?.meta?.args?.[1] || ''));
  const isAgyTerm = (t) => /agy(\.exe)?$/i.test(t?.meta?.cmd || '');
  const agentOf = (t) => (/claude(\.exe)?$/i.test(t.meta?.cmd || '') ? 'claude' : isCodexTerm(t) ? 'codex' : isAgyTerm(t) ? 'agy' : /cursor-agent/i.test((t.meta?.args || []).join(' ')) ? 'cursor' : null);
  const termMonitor = hub.termEvents ? createTermScreenMonitor({
    store: hub.termEvents,
    stripAnsi,
    readTerm,
    agentOf,
    getSessionId: (t) => termSessionId(t) || t.meta?.sessionId || null,
    onMetaChange: (t, next) => {
      if (!t.meta) t.meta = {};
      let changed = false;
      if (next.model !== undefined && next.model !== (t.meta.model || '')) { t.meta.model = next.model; changed = true; }
      if (next.effort !== undefined && next.effort !== (t.meta.effort || '')) { t.meta.effort = next.effort; changed = true; }
      if (next.mode && next.mode !== (t.meta.mode || '')) { t.meta.mode = next.mode; changed = true; }
      if (changed) {
        ptyPost(t.id, '/meta', { id: t.id, meta: { model: t.meta.model || '', effort: t.meta.effort || '', mode: t.meta.mode || '' } });
        const ag = agentOf(t);
        if (!t.meta.projectTask && ['claude', 'codex', 'agy'].includes(ag)) {
          accountPrefs?.save?.({ account: t.account?.id || '', agent: ag, model: t.meta.model || '', effort: t.meta.effort || '' });
        }
        hub.overviewStale?.();
      }
    },
  }) : null;

  function readTerm(t, n = 60, cursorOnly = false) {
    const b = t.vt.buffer.active, lines = [];
    const text = (i) => b.getLine(i)?.translateToString(true) ?? '';
    let last = b.length - 1;
    while (last > 0 && !text(last).trim()) last--;
    const start = Math.max(0, last - n + 1);
    if (cursorOnly) return b.baseY + b.cursorY - start;
    for (let i = start; i <= last; i++) lines.push(text(i));
    return lines;
  }

  const inputReady = (t) => {
    const s = stripAnsi(readTerm(t, 40).join('\n'));
    return !sessionStartupBlock(s) && /\? for shortcuts|bypass permissions|auto mode|accept edits|type your message|type a message|ask anything|^\s*[>›❯]/im.test(s);
  };

  function agySessionOf(t) {
    const args = t.meta.args || [];
    const log = args.indexOf('--log-file');
    const resume = args.indexOf('--conversation');
    const logged = log >= 0 ? readAgySession(args[log + 1]) : t.pid
      ? readAgySession(path.join(os.homedir(), '.gemini', 'antigravity-cli', 'cli.log'), t.pid) : null;
    return logged || (resume >= 0 ? args[resume + 1] : null);
  }

  function termDocOf(t) {
    if (isCodexTerm(t)) return codexDocOf(t);
    if (isAgyTerm(t)) {
      const sid = agySessionOf(t);
      if (sid) return index.get(sid);
    }
    if (t.meta?.sessionId && index.get(t.meta.sessionId)) return index.get(t.meta.sessionId);
    const argStr = (t.meta?.args || []).join(' ');
    const fromArgs = argStr.match(/(?:--resume|resume|--conversation)\s+([0-9a-f-]{8,64})/i);
    if (fromArgs && index.get(fromArgs[1])) return index.get(fromArgs[1]);
    return recentDocOf(t);
  }

  function recentDocOf(t) {
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

  function codexResumeArg(t) {
    const args = t.meta?.args || [];
    const pos = args.indexOf('resume');
    return pos >= 0 ? args[pos + 1] : null;
  }

  function codexResumeId(t) {
    const arg = codexResumeArg(t);
    return t.meta?.sessionId || (/^[0-9a-f-]{36}$/i.test(arg) ? arg : null);
  }

  function matchCodexLaunch(t, records) {
    const start = t.meta?.spawnedAt;
    const dir = t.cwd || t.meta?.cwd;
    if (!start || !dir) return null;
    const cwd = path.resolve(dir).toLowerCase();
    // Recent writes to a rollout must never move it to another terminal in the same folder.
    let end = start + 60_000;
    for (const other of terms.values()) {
      const next = other.meta?.spawnedAt;
      if (next > start && next < end && isCodexTerm(other) && !codexResumeId(other) && codexResumeArg(other) !== '--last'
          && other.cwd && path.resolve(other.cwd).toLowerCase() === cwd) end = next;
    }
    let best = null, earliest = Infinity;
    for (const d of records) {
      if (d.agent !== 'codex' || d.auto || !d.cwd || path.resolve(d.cwd).toLowerCase() !== cwd) continue;
      const uuid = d.id.match(/^([\da-f]{8})-([\da-f]{4})-7/i);
      const stamp = path.basename(d.file || '').match(/^rollout-(\d{4}-\d\d-\d\dT\d\d)-(\d\d)-(\d\d)-/);
      const created = uuid ? parseInt(uuid[1] + uuid[2], 16) : stamp ? Date.parse(`${stamp[1]}:${stamp[2]}:${stamp[3]}`) : NaN;
      const from = uuid ? start : Math.floor(start / 1000) * 1000;
      const until = uuid ? end : Math.floor(end / 1000) * 1000;
      if (created >= from && created < until && created < earliest) { best = d; earliest = created; }
    }
    return best;
  }

  function codexDocOf(t) {
    const id = codexResumeId(t);
    if (id) return index.get(id);
    return codexResumeArg(t) === '--last' ? recentDocOf(t) : matchCodexLaunch(t, index.docs.values());
  }

  function codexStatus(t) {
    if (t.exited !== null) return 'exited';
    try { return CODEX_BUSY.test(readTerm(t, 12).join('\n')) ? 'busy' : 'idle'; } catch { return null; }
  }

  function claudeStatus(t) {
    if (t.exited !== null) return 'exited';
    try { return CODEX_BUSY.test(readTerm(t, 12).join('\n')) ? 'busy' : 'idle'; } catch { return null; }
  }

  function agyStatus(t) {
    if (t.exited !== null) return 'exited';
    let screen = ''; try { screen = readTerm(t, 16).join('\n'); } catch { return 'idle'; }
    return agyStatusFromScreen(screen, { exited: t.exited, lastOutputAt: t.lastOutputAt, spawnedAt: t.meta?.spawnedAt });
  }

  function codexSessionOf(t) {
    const id = codexResumeId(t);
    if (id) return id;
    const hit = codexDocOf(t);
    if (hit) return hit.id;
    if (codexResumeArg(t) === '--last' || !t.meta?.spawnedAt || !(t.cwd || t.meta?.cwd)) return null;
    const root = t.meta?.envFlags?.CODEX_HOME || process.env.CODEX_HOME || CA.MAIN;
    function* walk(d) {
      let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (!e.isFile() || !/^rollout-.*\.jsonl$/.test(e.name)) continue;
        const file = path.join(d, e.name);
        try {
          if (fs.statSync(file).mtimeMs < t.meta.spawnedAt) continue;
          const meta = JSON.parse(fs.readFileSync(file, 'utf8').split('\n', 1)[0]).payload;
          if (meta?.id) yield { id: meta.id, cwd: meta.cwd, file, agent: 'codex', auto: /exec/i.test(`${meta.originator || ''} ${meta.source || ''}`) };
        } catch {}
      }
    }
    const dayDir = (ms) => {
      const d = new Date(ms);
      return path.join(root, 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
    };
    for (const dir of new Set([dayDir(t.meta.spawnedAt), dayDir(t.meta.spawnedAt + 60_000)])) {
      const match = matchCodexLaunch(t, walk(dir));
      if (match) return match.id;
    }
    return null;
  }

  function termSessionId(t) {
    if (!t) return null;
    if (t.meta?.projectTask) return hub.projectRecord(t) || null;
    if (isAgyTerm(t)) return agySessionOf(t) || null;
    if (isCodexTerm(t)) return codexSessionOf(t) || null;
    const args = t.args || t.meta?.args || [];
    for (const flag of ['--resume', '--conversation']) {
      const i = args.indexOf(flag);
      if (i >= 0 && args[i + 1]) return args[i + 1];
    }
    const r2 = args.indexOf('resume');
    if (r2 >= 0 && args[r2 + 1] && !args[r2 + 1].startsWith('-')) return args[r2 + 1];
    return t.meta?.sessionId || null;
  }

  function hasTermInputDraft(t) {
    const lines = Math.max(40, t.rows || 0);
    return hasCodexPasteDraft(stripAnsi(readTerm(t, lines).join('\n')), readTerm(t, lines, true));
  }

  const termInfo = (t) => ({
    id: t.id, title: t.title, customTitle: t.meta?.customTitle || '', liveTitle: t.liveTitle, account: t.account, agent: agentOf(t), operator: !!t.meta?.operator,
    claude: /claude(\.exe)?$/i.test(t.meta?.cmd || ''), codex: isCodexTerm(t), agy: isAgyTerm(t),
    model: t.meta?.model || '', effort: t.meta?.effort || '', mode: t.meta?.mode || '',
    ...(isCodexTerm(t) ? { status: codexStatus(t) } : isAgyTerm(t) ? { status: agyStatus(t) } : /claude(\.exe)?$/i.test(t.meta?.cmd || '') ? { status: claudeStatus(t) } : {}),
    ...(isAgyTerm(t) ? { sessionId: agySessionOf(t) } : {}),
    ...(t.exited === null ? { startupBlock: sessionStartupBlock(stripAnsi(readTerm(t, 40).join('\n'))) } : {}),
    ...(t.meta?.projectTask ? {
      dispatchPending: !!t._projectDispatchPending,
      inputDraft: t.exited === null && isCodexTerm(t) && hasTermInputDraft(t),
    } : {}),
    lastOutputAt: t.lastOutputAt || 0,
    lastInputAt: t.lastInputAt || t.meta?.lastInputAt || t.startedAt || t.meta?.spawnedAt || 0,
    startedAt: t.startedAt || 0,
    projectTask: t.meta?.projectTask, cwd: t.cwd, pid: t.pid, exited: t.exited, cols: t.cols, rows: t.rows,
  });

  function makeMirror({ id, meta = {}, cols = 120, rows = 32, exited = null }) {
    const t = {
      id, title: meta.title, cwd: meta.cwd, cmd: meta.cmd, args: meta.args || [], account: meta.account || null, research: meta.research || null,
      meta, buf: '', clients: new Set(), exited, pid: 0, cols, rows, liveTitle: '',
      lastInputAt: Number(meta.lastInputAt) || Number(meta.spawnedAt) || 0,
    };
    t.vt = new HeadlessTerminal({ cols, rows, scrollback: 3000, allowProposedApi: true });
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
    t.outputEnd = (t.outputEnd ?? t.buf.length) + d.length;
    t.buf = (t.buf + d).slice(-400_000);
    if (stripAnsi(d).trim()) t.lastOutputAt = Date.now();
    termMonitor?.onOutput(t);
    for (const ws of t.clients) ws.send(JSON.stringify({ type: 'data', data: d }));
  }

  function launchSpecWithShared(cmd, args, env, agent, preparedVault) {
    const wrapper = path.basename(String(cmd || '')).toLowerCase();
    const base = wrapper === 'cmd.exe' && args[0] === '/c' ? path.basename(String(args[1] || '')).toLowerCase() : wrapper;
    const kind = agent || (/^(claude|codex|agy|cursor-agent)(?:\.(?:exe|cmd))?$/.exec(base)?.[1]?.replace('cursor-agent', 'cursor'))
      || (wrapper === 'wsl.exe' && args.includes('codex') ? 'codex' : '');
    const prep = preparedVault || (kind && unifiedVault?.prepareLaunch(kind, {
      env: { ...cleanEnv(), ...env },
      native: wrapper !== 'wsl.exe',
      resume: kind === 'claude' && (args.includes('--resume') || args.includes('--continue')),
    }));
    return { kind, args: [...args, ...(prep?.extraArgs || [])], env: { ...env, ...prep?.env }, vault: prep?.vault, blocked: prep?.blocked };
  }

  function createTerm({ cwd, cmd, args = [], title, env = {}, account = null, model = '', effort = '', lastInputAt = 0, research = null, operator = false, projectTask, projectPrompt, agent, preparedVault }) {
    const id = String(++termSeq);
    if (!cwd || !fs.existsSync(cwd)) cwd = os.homedir();
    const me = cleanModelEffort(model, effort);
    const shared = launchSpecWithShared(cmd, args, env, agent, preparedVault);
    if (shared.blocked) throw new Error(`필수 MCP 준비 실패 · ${requiredMcpMessage(shared.blocked)}`);
    args = shared.args;
    env = shared.env;
    if (projectTask) projects?.recordVaultRun?.(projectTask.projectId, [projectTask.taskId], 'terminal', shared.kind, shared.vault);
    const envFlags = Object.fromEntries(Object.entries(env).filter(([k]) => !/TOKEN|KEY|SECRET/i.test(k)));
    if (/\bagy(?:\.exe)?$/i.test(cmd)) {
      const dir = path.join(baseDir, 'data', 'agy-logs');
      fs.mkdirSync(dir, { recursive: true });
      const previous = args.indexOf('--log-file');
      if (previous !== -1) args = args.filter((_, i) => i !== previous && i !== previous + 1);
      args = [...args, '--log-file', path.join(dir, crypto.randomUUID() + '.log')];
    }
    const now = Date.now();
    const meta = {
      title: title || [cmd, ...args].join(' '), cwd, cmd, args, account, research, envFlags, spawnedAt: now, lastInputAt: Number(lastInputAt) || now,
      ...(me.model ? { model: me.model } : {}),
      ...(me.effort ? { effort: me.effort } : {}),
      ...(operator ? { operator: true } : {}),
    };
    if (projectTask) Object.assign(meta, { projectTask, projectPrompt,
      projectAutoClose: !args.some(a => /^(?:resume|--resume|--conversation|--continue)$/.test(a)) });
    const t = makeMirror({ id, meta });
    const terminalEnv = { ...cleanEnv(), ...env };
    if (!terminalEnv.TERM || /^dumb$/i.test(terminalEnv.TERM)) terminalEnv.TERM = 'xterm-256color';
    t.spawnResult = ptyPost(id, '/spawn', { id, cmd, args, cwd, env: terminalEnv, cols: 120, rows: 32, meta });
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

  async function procInfo(pids, fresh = false) {
    const need = pids.filter((p) => Number.isInteger(p) && p > 0 && (fresh || !procInfoCache.has(p)));
    if (fresh) need.forEach((p) => procInfoCache.delete(p));
    if (need.length) {
      const filter = need.map((p) => `ProcessId=${p}`).join(' OR ');
      const out = await new Promise((res) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Get-CimInstance Win32_Process -Filter "${filter}" | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine,@{n='S';e={$_.CreationDate.ToString('o')}} | ConvertTo-Json -Compress`],
        { timeout: 15000, windowsHide: true }, (e, o) => res(e ? '' : String(o))));
      let arr = []; try { arr = [].concat(JSON.parse(out || '[]')); } catch {}
      for (const x of arr) if (x) procInfoCache.set(x.ProcessId, { cl: x.CommandLine || '', start: x.S ? Date.parse(x.S) : null, exe: x.ExecutablePath, ppid: x.ParentProcessId });
    }
    return new Map(pids.map((p) => [p, procInfoCache.get(p)]));
  }

  async function matchTermPids(consoles) {
    const hasResume = (t) => (t.args || []).includes('--resume');
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
      const pick = spawned ? cands.sort((a, b) => Math.abs(st(a) - spawned) - Math.abs(st(b) - spawned))[0] : cands.sort((a, b) => st(a) - st(b))[0];
      t.pid = pick.pid; known.add(pick.pid);
    }
  }

  async function saveTermsState() {
    try {
      const cons = ((await hub.helperCall({ op: 'list' })).consoles) || [];
      const live = hub.liveSessions();
      const list = [];
      await matchTermPids(cons);
      const seenSids = new Set();
      for (const t of [...terms.values()].sort((a, b) => Number(b.id) - Number(a.id))) {
        if (t.exited !== null) continue;
        const c = t.pid && cons.find((x) => x.pids.includes(t.pid));
        const s = c && live.find((x) => c.pids.includes(x.pid));
        const resumed = (t.args || []).includes('--resume') ? t.args[t.args.indexOf('--resume') + 1] : null;
        const sessionId = t.meta.projectTask ? hub.projectRecord(t) : isAgyTerm(t) ? agySessionOf(t) : s?.sessionId || termSessionId(t) || resumed;
        if (sessionId) {
          if (seenSids.has(sessionId)) continue;
          seenSids.add(sessionId);
        }
        list.unshift({ id: t.id, meta: t.meta, sessionId: sessionId || null, busy: s?.status === 'busy' || s?.status === 'shell' });
      }
      for (const t of terms.values()) if (t.meta.projectTask) hub.rememberProjectTerm(t);
      fs.writeFileSync(TERMS_STATE + '.tmp', JSON.stringify({ savedAt: new Date().toISOString(), terms: list }, null, 1));
      fs.renameSync(TERMS_STATE + '.tmp', TERMS_STATE);
    } catch (e) { console.error('[pty] save state', e.message); }
  }

  function savedTermSessions() {
    try { return new Set((JSON.parse(fs.readFileSync(TERMS_STATE, 'utf8')).terms || []).map((x) => x.sessionId).filter(Boolean)); } catch { return new Set(); }
  }

  async function sendNoteWhenReady(t, note) {
    const head = note.slice(0, 12).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (let i = 0; i < 90 && t.exited === null; i++) {
      await sleep(700);
      const scr = readTerm(t, 40).join('\n');
      if (terminalConfirmationMessage(sessionStartupBlock(scr))) return;
      if (/\? for shortcuts|bypass permissions|auto mode|accept edits|^\s*[>❯]\s*$/m.test(scr)) {
        await sleep(800);
        t.proc.write(note);
        await sleep(1200); t.proc.write('\r');
        for (let k = 0; k < 6 && t.exited === null; k++) {
          await sleep(2500);
          if (!new RegExp(`^\\s*[>❯]\\s*${head}`, 'm').test(readTerm(t, 12).join('\n'))) break;
          t.proc.write('\x1b[C '); await sleep(600); t.proc.write('\r');
        }
        return;
      }
    }
  }

  async function resumeCut(s, note) {
    let pick = { id: 'default', label: '이 PC 로그인' };
    try {
      const c = (await hub.switchCandidates('none')).candidates;
      const def = c.find((x) => x.id === 'default');
      if (!def?.usable) { const best = c.filter((x) => x.usable).sort((a, b) => b.score - a.score)[0]; if (best) pick = best; }
    } catch {}
    const env = {};
    if (pick.id !== 'default') env.CLAUDE_CODE_OAUTH_TOKEN = hub.tokenAccounts().find((a) => a.id === pick.id).token();
    const t = createTerm({
      cwd: s.cwd, cmd: 'claude.exe', args: ['--resume', s.id, '--dangerously-skip-permissions'], env,
      title: `↻ ${s.title || s.id.slice(0, 8)}`, account: pick.id === 'default' ? null : { id: pick.id, label: pick.label },
    });
    t.meta.sessionId = s.id;
    sendNoteWhenReady(t, note).catch(() => {});
    await sleep(2500);
  }

  const crashRec = require('./crash-recovery')({
    dir: baseDir, claudeDir, liveSessions: () => hub.liveSessions(), gpuFile: path.join(baseDir, 'gpu-queue.json'),
    notify: (html) => { const d = path.join(baseDir, 'notify'); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, `crash-${Date.now()}.json`), JSON.stringify({ html })); },
  });

  async function recoverTerms(note = RESTART_NOTE) {
    let saved; try { saved = JSON.parse(fs.readFileSync(TERMS_STATE, 'utf8')); } catch { return; }
    const projectIds = new Set(projects.list().map((p) => p.id));
    const rawItems = (saved.terms || []).filter((x) => x.meta?.cmd && (!x.meta.projectTask || projectIds.has(x.meta.projectTask.projectId)));
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
      if (isClaude && !x.sessionId) continue;
      const env = { ...(m.envFlags || {}) };
      if (m.projectTask && m.account?.id) {
        try { Object.assign(env, hub.projectAccounts.resolve(m.account.kind, m.account.id).env); }
        catch (e) { console.error('[project] restore account:', e.message); continue; }
      } else if (m.account?.id && m.account.id !== 'default') {
        const acc = hub.tokenAccounts().find((a) => a.id === m.account.id);
        if (acc) try { env.CLAUDE_CODE_OAUTH_TOKEN = acc.token(); } catch {}
      }
      const cliKind = isClaude ? 'claude' : isCodexTerm({ meta: m }) ? 'codex' : isAgyTerm({ meta: m }) ? 'agy' : '';
      const savedME = cliKind ? accountPrefs.getForAccount(m.account?.id || '', cliKind) : { model: '', effort: '' };
      const recModel = m.model || savedME.model || '';
      const recEffort = m.effort || savedME.effort || '';
      const args = cliKind
        ? buildRecoveryLaunchArgs({ cli: cliKind, rawArgs: m.args || [], sessionId: x.sessionId, model: recModel, effort: recEffort, codexRecoveryArgs, cliModelEffortArgs })
        : (m.args || []);
      const savedTitle = (x.sessionId && hub.conversationBranches?.getTitle(x.sessionId)) || m.customTitle || '';
      const t = createTerm({
        cwd: m.cwd, cmd: m.cmd, args, title: savedTitle || m.title, env, account: m.account,
        model: recModel, effort: recEffort, lastInputAt: m.lastInputAt || m.spawnedAt || 0,
        research: m.research, projectTask: m.projectTask, projectPrompt: m.projectPrompt,
      });
      if (savedTitle) t.meta.customTitle = savedTitle;
      if (m.research) t.research = m.research;
      t.meta.sessionId = x.sessionId;
      if (isClaude && x.busy && !m.research) sendNoteWhenReady(t, note).catch(() => {});
    }
    return resumed;
  }

  const loadFavs = () => { try { return JSON.parse(fs.readFileSync(FAV_FILE, 'utf8')); } catch { return []; } };

  async function resumeFavorites(already) {
    if (config.resumeFavorites === false) return;
    for (let i = 0; i < 120 && !index.ready; i++) await sleep(1000);
    const live = new Set(hub.liveSessions().map((s) => s.sessionId));
    const hidden = projects.hidden();
    const ids = loadFavs().filter((k) => k.startsWith('sid:')).map((k) => k.slice(4)).filter((id) => !hidden.has(id) && !already.has(id) && !live.has(id));
    if (!ids.length) return;
    let pick = { id: 'default', label: '이 PC 로그인' };
    try {
      const c = (await hub.switchCandidates('none')).candidates;
      const def = c.find((x) => x.id === 'default');
      if (!def?.usable) { const best = c.filter((x) => x.usable).sort((a, b) => b.score - a.score)[0]; if (best) pick = best; }
    } catch {}
    console.log(`[pty] resuming ${ids.length} favourite session(s) on ${pick.label}`);
    for (const id of ids) {
      const d = index.get(id);
      if (!d?.cwd || !fs.existsSync(d.cwd)) { console.log(`[pty] favourite ${id.slice(0, 8)}: folder unknown, skipped`); continue; }
      const env = {};
      if (pick.id !== 'default') { try { env.CLAUDE_CODE_OAUTH_TOKEN = hub.tokenAccounts().find((a) => a.id === pick.id).token(); } catch { continue; } }
      const title = `⭐ ${d.title || d.firstPrompt?.split('\n')[0].slice(0, 40) || id.slice(0, 8)}`;
      const t = createTerm({ cwd: d.cwd, cmd: 'claude.exe', args: ['--resume', id, '--dangerously-skip-permissions'], env, title, account: pick.id === 'default' ? null : { id: pick.id, label: pick.label } });
      t.meta.sessionId = id;
      await sleep(2500);
    }
  }

  async function connectPtyHost() {
    let inf = await ptyCall('/info').catch(() => null);
    let fresh = false;
    if (!inf) {
      const log = fs.openSync(path.join(baseDir, 'ptyhost.log'), 'a');
      spawn(process.execPath, [path.join(baseDir, 'ptyhost.js')], {
        cwd: baseDir, detached: true, windowsHide: true, stdio: ['ignore', log, log],
        env: { ...cleanEnv(), CCD_PTY_PORT: String(PTY_PORT) },
      }).unref();
      for (let i = 0; i < 40 && !inf; i++) { await sleep(250); inf = await ptyCall('/info').catch(() => null); }
      if (!inf) { console.error('[pty] host did not start; see ptyhost.log'); return setTimeout(connectPtyHost, 5000); }
      fresh = true;
    }
    const restore = (x, buf) => {
      if (terms.has(x.id)) return;
      const t = makeMirror(x);
      t.pid = x.pid;
      t.startedAt = x.startedAt || null;
      if (!t.lastInputAt) t.lastInputAt = t.startedAt || Date.now();
      if (buf) {
        t.buf = buf.slice(-400_000);
        t.vt.write(t.buf, () => { try { termMonitor?.inspect(t); } catch {} });
      }
    };
    if (!inf.snapshot) {
      for (const x of inf.terms) {
        if (terms.has(x.id)) continue;
        const { buf } = await ptyCall(`/buf?id=${encodeURIComponent(x.id)}`).catch(() => ({}));
        restore(x, buf);
      }
    }
    const WebSocketClient = require('ws');
    const eventUrl = new URL(`ws://127.0.0.1:${PTY_PORT}/events`);
    eventUrl.searchParams.set('t', token);
    if (inf.snapshot) eventUrl.searchParams.set('snapshot', '1');
    const ev = new WebSocketClient(eventUrl, { handshakeTimeout: 5000 });
    let attached;
    const ready = new Promise((resolve) => { attached = resolve; });
    const markReady = () => { ptyHostPid = inf.pid; attached(true); };
    ev.on('open', () => { if (!inf.snapshot) markReady(); });
    ev.on('message', (m) => {
      let e; try { e = JSON.parse(m); } catch { return; }
      if (e.type === 'snapshot') return restore(e.term, e.buf);
      if (e.type === 'snapshot-ready') return markReady();
      const t = terms.get(e.id);
      if (e.type === 'spawned' && !terms.has(e.term.id)) restore(e.term);
      if (e.type === 'data' && t) mirrorData(t, e.data);
      else if (e.type === 'exit' && t) { t.exited = e.code; for (const ws of t.clients) ws.send(JSON.stringify({ type: 'exit', code: e.code })); }
      else if (e.type === 'resize' && t && (t.cols !== e.cols || t.rows !== e.rows)) { t.cols = e.cols; t.rows = e.rows; t.vt.resize(e.cols, e.rows); }
    });
    ev.on('close', () => {
      ptyHostPid = 0;
      attached(false);
      console.error('[pty] event stream closed; reconnecting');
      setTimeout(connectPtyHost, 2000);
    });
    ev.on('error', () => {});
    if (!await ready) return;
    console.log(`pty host pid ${ptyHostPid} (${fresh ? 'started' : 'reattached'}), ${inf.terms.length} terminal(s)`);
    if (fresh) (async () => {
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
      list.sort((a, b) => {
        const aBusy = (isAgyTerm(a) ? agyStatus(a) : isCodexTerm(a) ? codexStatus(a) : '') === 'busy' ? 1 : 0;
        const bBusy = (isAgyTerm(b) ? agyStatus(b) : isCodexTerm(b) ? codexStatus(b) : '') === 'busy' ? 1 : 0;
        return aBusy !== bBusy ? bBusy - aBusy : Number(b.id) - Number(a.id);
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

  function locateFile({ name, size, mtime, cwd }) {
    const home = os.homedir();
    const roots = [cwd, path.join(home, 'Desktop'), path.join(home, 'OneDrive', 'Desktop'), path.join(home, 'Downloads'),
      path.join(home, 'Documents'), path.join(home, 'Pictures'), ...(config.locateRoots || [])]
      .filter((r, i, a) => r && a.indexOf(r) === i && fs.existsSync(r));
    const deadline = Date.now() + 1500;
    const match = (p) => {
      try { const st = fs.statSync(p); return st.isFile() && st.size === size && (!mtime || Math.abs(st.mtimeMs - mtime) < 2000); } catch { return false; }
    };
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
    let file = path.join(dir, `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}_${safeUploadName(name)}`);
    for (let i = 2; fs.existsSync(file); i++) file = file.replace(/(\.[^.\\]*)?$/, `_${i}$1`);
    return new Promise((resolve, reject) => {
      const out = fs.createWriteStream(file);
      req.pipe(out);
      out.on('finish', () => resolve(file));
      out.on('error', reject);
      req.on('error', reject);
    });
  }

  return {
    terms,
    getPtyHostPid: () => ptyHostPid,
    ptyPort: PTY_PORT,
    isMatchBusy: () => matchBusy,
    setMatchBusy: (v) => { matchBusy = !!v; },
    consoleInputAt,
    touchUserInput,
    ptyCall,
    ptyPost,
    isCodexTerm,
    isAgyTerm,
    agentOf,
    readTerm,
    termCursorLine: (t, n) => readTerm(t, n, true),
    sleep,
    SUBMIT_DELAY,
    consoleSubmitDelay,
    waitFor,
    inputReady,
    pidAlive,
    cleanEnv,
    agySessionOf,
    termDocOf,
    codexDocOf,
    codexStatus,
    claudeStatus,
    agyStatus,
    codexSessionOf,
    termSessionId,
    termInfo,
    createTerm,
    resizeTerm,
    forgetTerm,
    connectPtyHost,
    procInfo,
    matchTermPids,
    saveTermsState,
    FAV_FILE,
    loadFavs,
    liveFavs,
    dedupeTermsBySession,
    locateFile,
    saveUpload,
    termMonitor,
  };
}

module.exports = { createTermManager, waitForTerminalInput, sessionStartupBlock, dismissProjectHookMenu, writeProjectTerm, dispatchTerminalPrompt, submissionBlockMessage, terminalConfirmationMessage, HOOK_MENU_MESSAGE, DUMB_TERMINAL_MESSAGE };
