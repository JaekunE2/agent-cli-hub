#!/usr/bin/env node
// ccd — command-line client for Agent CLI Hub (for agents and humans).
// Usage: node <install folder>\hub\ccd.js <command> [...]   (run with no args for help)
if (require('./i18n').takeOver(module)) return; // English mode: messages in English
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DIR = __dirname;
const PORT = Number(process.env.CCD_PORT || 7777);
// CCD_BASE/CCD_TOKEN: drive a hub that runs elsewhere (e.g. another PC on your Tailscale network)
const BASE = process.env.CCD_BASE || `http://127.0.0.1:${PORT}`;
const tokenFile = path.join(DIR, '.token');
// read lazily: on a fresh install the server creates .token only after `ccd up` starts it
const token = () => process.env.CCD_TOKEN || (fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : '');
const SELF_PID = Number(process.env.CLAUDE_PID || 0);

const HELP = `ccd — Agent CLI Hub CLI  (server ${BASE})

  up                               start the hub server if it is not running
  ls [--all]                       live Claude sessions, console windows, hub terminals (Claude / Codex / Cursor / shells)
  read <target> [-n 60]            current screen text of a window / terminal
  send <target> <text...>          type text and press Enter (Enter is sent separately)
       [--no-enter]                  type only
  keys <target> <key...>           enter esc tab up down left right backspace ctrl+c (+ shift+tab for t:)
  wait <target> [--timeout 900]    wait until that Claude or Codex session finishes its turn, then print the screen
  new <claude|codex|cursor|powershell|cmd> [--cwd DIR] [--resume SESSION_ID] [--no-skip-permissions] [--title T] [--model M]
                                   open a hub terminal (codex --resume = codex resume <id>)
  close t:<id>                     kill a hub terminal
  search <query...> [--agent claude|codex] [--role user|assistant] [--cwd DIR] [--auto] [--no-screens] [-n 20]
                                   full-text search over every Claude Code and Codex conversation + open screens
  log <session-id|prefix> [--at N] [-n 30]   transcript messages (Claude or Codex, from the search index)
  accounts [session]               your other Claude accounts with 5h/weekly usage (* = most headroom)
  switch <session|target> [--account auto|ID] [--no-continue] [--no-skip-permissions] [--interrupt] [--force]
                                   stop that session and resume it on another of your accounts (Claude, or Codex for a codex terminal)
  codex [ls | add | rm <email|id>] your ChatGPT logins for the Codex CLI (add = device-code login in this console)
  gpt "prompt" [--file a,b] [--image x.png] [--model M] [--cd DIR] [--account EMAIL]
                                   ask GPT through the Codex CLI (read-only) — second opinions / cross-review; stdin is appended
  notice "text" [--to all|t:1,t:2] [--board-only]   post a hub notice: saved on the board and typed into running Claude/Codex hub terminals
  notices [-n 20]                  the notice board (newest last)
  operator [status|start]          the operator session that looks after this hub (GPU, network, disks, accounts, notices)
  research ls | new <name> --direction "..." [--venue V] | show <slug> | msg <slug> <text> | pause <slug> | resume <slug>
                                   autonomous research projects (director sessions driven by research-harness)
  gpu [ls]                         GPUs (memory/util/procs) + lease queue
  gpu plan --mem 12G --est 90m     when a job of that size would start / finish on each GPU
  gpu run [--mem 20G | --exclusive] [--gpu 0] [--label L] [--est 90m] [--ram 40G] -- <command>
                                   wait in the queue, run with CUDA_VISIBLE_DEVICES set, auto-release on exit
                                   (--est lets smaller jobs be backfilled; --ram also reserves system RAM)
  gpu request [--mem 20G | --exclusive] [--gpu 0] [--label L] [--wait]  /  gpu wait <id>  /  gpu release <id>
  gpu est <ticket> <90m|HH:MM>     set/adjust the estimate of a waiting or running job
  gpu on|off <local:N>             allow / stop granting a GPU (running jobs are not touched)
  reload [--modules gpu,research,calendar]  apply updated modules without a restart (terminals stay open)
  artifact add <path> [--title T]  pin a result file (video/PDF/image/...) as an output of this session ("산출물" tab)
  artifact ls [--all]              outputs of this session (auto-detected from the conversation + pinned)
  usage [--force]                  AI account usage (Claude 5h/weekly %, Codex, Cursor, ...) from the usage dashboard
  url                              print the browser URL

<target>: t:<id> hub terminal · c:<pid> console window (any pid in it) ·
          a session-id prefix, a session name (claude-xx), or part of a window title.
Add --json to ls/read/search/log for machine-readable output.`;

// ---------- args ----------
const argv = process.argv.slice(2);
const flags = {};
const pos = [];
let rest = []; // everything after a bare "--" (the command for `ccd gpu run`)
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--') { rest = argv.slice(i + 1); break; }
  if (a === '-n') flags.n = Number(argv[++i]);
  else if (a.startsWith('--')) {
    const k = a.slice(2);
    if (['to', 'cwd', 'resume', 'title', 'role', 'at', 'timeout', 'account', 'direction', 'venue', 'gpu', 'mem', 'ram', 'label', 'est', 'modules', 'model', 'session', 'sync', 'fetch', 'sync-exclude', 'file', 'system', 'url', 'image', 'env', 'cd', 'to', 'in', 'msg', 'rename', 'max', 'runtime', 'drive', 'stage', 'node', 'server', 'exclude', 'via', 'root', 'steps'].includes(k)) flags[k] = argv[++i];
    else flags[k] = true;
  } else pos.push(a);
}
const die = (msg, code = 1) => { console.error(msg); process.exit(code); };
// the AI usage dashboard's folder (accounts.json: Claude tokens, Codex logins …), same rule as server.js
const usageDir = () => { let c = {}; try { c = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8')); } catch {} return process.env.CCD_USAGE_DIR || (c.usageDir && path.resolve(DIR, c.usageDir)) || path.join(require('os').homedir(), 'ai-usage-dashboard'); };

// ---------- http ----------
// Network hiccups (server restarting, keep-alive socket closed under us) used to throw
// "TypeError: fetch failed" and kill long waits like `gpu run` silently. Retry instead:
// GETs always; POSTs only when the request certainly never reached the server.
const RETRY_MS = () => (['run', 'wait'].includes(pos[1]) && pos[0] === 'gpu') || (pos[0] === 'gpu' && flags.wait) ? 300_000 : 20_000;
const NOT_SENT = /ECONNREFUSED|ECONNRESET|UND_ERR_SOCKET|other side closed|EPIPE|ENOTFOUND/;
async function api(p, body) {
  const until = Date.now() + RETRY_MS();
  let r, delay = 500;
  for (;;) {
    try {
      r = await fetch(BASE + p, {
        method: body ? 'POST' : 'GET',
        headers: { 'x-token': token(), 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      break;
    } catch (e) {
      const why = `${e.message} ${e.cause?.code || ''} ${e.cause?.message || ''}`;
      if ((body && !NOT_SENT.test(why)) || Date.now() > until) throw e;
      await new Promise((res) => setTimeout(res, delay));
      delay = Math.min(delay * 2, 5000);
    }
  }
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) die('dashboard rejected the token (.token mismatch)');
  return j;
}
async function alive() {
  try { const r = await fetch(BASE + '/api/overview', { headers: { 'x-token': token() } }); return r.ok || r.status === 401; } catch { return false; }
}
async function ensureUp(start) {
  if (await alive()) return true;
  if (!start) die(`dashboard is not running on ${BASE}. Start it: node "${path.join(DIR, 'ccd.js')}" up`);
  const log = fs.openSync(path.join(DIR, 'server.log'), 'a');
  // --use-system-ca: trust the Windows certificate store too (networks that re-sign TLS with their own root
  // would otherwise break Google Calendar sync with SELF_SIGNED_CERT_IN_CHAIN)
  spawn(process.execPath, ['--use-system-ca', path.join(DIR, 'server.js')], { cwd: DIR, detached: true, windowsHide: true, stdio: ['ignore', log, log] }).unref();
  for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 500)); if (await alive()) return true; }
  die('server did not come up; see server.log');
}

// ---------- model ----------
async function overview() {
  const o = await api('/api/overview');
  const selfCon = SELF_PID ? o.consoles.find((c) => c.pids.includes(SELF_PID)) : null;
  const selfTerm = selfCon && selfCon.managed ? o.terms.find((t) => t.pid && selfCon.pids.includes(t.pid)) : null;
  // the terminal's own Windows console title is fresher than the title captured from its output stream
  for (const t of o.terms) { const c = t.pid && o.consoles.find((x) => x.managed && x.pids.includes(t.pid)); if (c) t.conTitle = c.title; }
  return { ...o, selfCon, selfTerm };
}
const conOfPid = (o, pid) => o.consoles.find((c) => c.pids.includes(pid));
const sessOfCon = (o, c) => c && o.live.find((s) => c.pids.includes(s.pid));
const termOfCon = (o, c) => c && o.terms.find((t) => t.pid && c.pids.includes(t.pid));
function termLabel(t) {
  const ct = cleanTitle(t.conTitle);
  let lt = ct && !/^[A-Za-z]:\\/.test(ct) &&!/^(claude code|claude|windows powershell|powershell|cmd)$/i.test(ct) ? ct : cleanTitle(t.liveTitle);
  if (/^[A-Za-z]:\\/.test(lt)) lt = path.basename(lt).replace(/\.exe$/i, '');
  const generic = !lt || /^(claude code|claude)$/i.test(lt);
  return (!generic && lt) || t.sessionName || lt || t.title;
}
const cleanTitle = (s) => String(s || '').replace(/^[^\p{L}\p{N}]+\s*/u, '');

// Resolve a target string to {kind:'term', id} or {kind:'console', pid}, plus its live session.
function resolve(o, target) {
  if (!target) die('missing <target>');
  let m;
  if ((m = /^t:?(\d+)$/.exec(target))) {
    const t = o.terms.find((x) => x.id === m[1]);
    if (!t) die(`no dashboard terminal ${target}`);
    const c = t.pid && conOfPid(o, t.pid);
    return { kind: 'term', id: t.id, session: sessOfCon(o, c), label: `t:${t.id} ${termLabel(t)}` };
  }
  if ((m = /^c?:?(\d+)$/.exec(target))) {
    const c = conOfPid(o, Number(m[1]));
    if (!c) die(`no console window contains pid ${m[1]}`);
    return fromConsole(o, c);
  }
  const low = target.toLowerCase();
  const s = o.live.find((x) => x.sessionId.startsWith(low) || (x.name || '').toLowerCase() === low);
  if (s) {
    const c = conOfPid(o, s.pid);
    if (!c) die(`session ${s.sessionId.slice(0, 8)} has no console window (maybe headless / other host)`);
    return fromConsole(o, c);
  }
  const byTitle = o.consoles.filter((c) => c.visible && c.title.toLowerCase().includes(low));
  if (byTitle.length === 1) return fromConsole(o, byTitle[0]);
  if (byTitle.length > 1) die(`"${target}" matches ${byTitle.length} windows: ${byTitle.map((c) => `c:${c.id} ${cleanTitle(c.title)}`).join(' | ')}`);
  die(`no target matches "${target}" (see: ccd ls)`);
}
function fromConsole(o, c) {
  const t = c.managed && termOfCon(o, c);
  if (t) return { kind: 'term', id: t.id, session: sessOfCon(o, c), label: `t:${t.id} ${termLabel(t)}` };
  return { kind: 'console', pid: c.id, session: sessOfCon(o, c), label: `c:${c.id} ${cleanTitle(c.title)}` };
}
function isSelf(o, r) {
  return (r.kind === 'console' && o.selfCon && o.selfCon.id === r.pid) || (r.kind === 'term' && o.selfTerm && o.selfTerm.id === r.id);
}

async function readTarget(r, n) {
  const d = r.kind === 'term'
    ? await api(`/api/term/read?id=${r.id}&lines=${n * 4 + 40}`)
    : await api(`/api/console/read?pid=${r.pid}`);
  if (!d.ok) die(`read failed: ${d.error}`);
  // TUIs pad the screen with blank rows; collapse runs so -n counts real content
  const lines = [];
  for (const l of d.lines) if (l.trim() || (lines.length && lines[lines.length - 1].trim())) lines.push(l.trimEnd());
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.slice(-n);
}

// Accept a session id / prefix, or any <target> that maps to a live Claude session.
async function sessionIdOf(arg) {
  if (!arg) die('missing session (id prefix or <target>)');
  const o = await overview();
  const live = o.live.find((s) => s.sessionId.startsWith(arg));
  if (live) return live.sessionId;
  if (/^[0-9a-f-]{8,}$/i.test(arg)) {
    const rec = (await api('/api/recent?n=300&auto=1')).sessions.find((s) => s.sessionId.startsWith(arg));
    if (rec) return rec.sessionId;
  }
  const r = resolve(o, arg);
  if (!r.session) die(`${r.label} is not a Claude session`);
  return r.session.sessionId;
}

// Screens where typed text would be taken as an answer rather than a prompt.
function pendingPrompt(screen) {
  if (/trust this folder|Do you trust/i.test(screen)) return 'folder-trust prompt';
  if (/Do you want to (proceed|make this edit|create|allow)|❯\s*1\.\s*Yes/i.test(screen)) return 'permission prompt';
  return null;
}

const ago = (ms) => {
  if (!ms) return '';
  const s = (Date.now() - ms) / 1000;
  return s < 60 ? `${Math.floor(s)}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
};

// ---------- commands ----------
const cmds = {
  async up() { await ensureUp(true); console.log(`dashboard up: ${fs.readFileSync(path.join(DIR, 'url.txt'), 'utf8').trim()}`); },
  async restart() {
    const o = await api('/api/overview');
    const running = o.terms.filter((t) => t.exited === null);
    const g0 = await api('/api/restart-guard').catch(() => ({}));
    const survives = !!g0.note; // terminals live in the pty host → a restart does not touch them
    if (running.length && !flags.force && !survives) die(`restart would kill ${running.length} dashboard terminal(s): ${running.map((t) => `t:${t.id} ${t.title}`).join(', ')}\nre-run with --force if that is OK`);
    // never take running GPU jobs down with the terminals (older servers lack this endpoint)
    const guard = await api('/api/restart-guard').catch(() => ({}));
    if (guard.atRisk?.length && !flags['kill-gpu-jobs']) die(`restart would kill GPU job(s) running inside dashboard terminals: ${guard.atRisk.map((x) => `${x.label} (${x.by || x.id})`).join(', ')}
wait for them to finish (or pause the research project first); --kill-gpu-jobs overrides only with the user's explicit OK`);
    await api('/api/shutdown', {});
    for (let i = 0; i < 20 && (await alive()); i++) await new Promise((r) => setTimeout(r, 300));
    await ensureUp(true);
    console.log('dashboard restarted');
  },
  async gpt() {
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8')).gpt || {}; } catch {}
    const CA = require('./codex-accounts');
    const exe = CA.codexExe(cfg.codex);
    let prompt = pos.slice(1).join(' ');
    if (flags.file) for (const f of String(flags.file).split(',')) prompt += `\n\n--- ${f.trim()} ---\n${fs.readFileSync(f.trim(), 'utf8')}`;
    if (!process.stdin.isTTY) { const chunks = []; for await (const c of process.stdin) chunks.push(c); const s = Buffer.concat(chunks).toString('utf8'); if (s.trim()) prompt += `\n\n${s}`; }
    if (!prompt.trim()) die('usage: ccd gpt "prompt" [--file a,b] [--image x.png] [--model M] [--cd DIR] [--account EMAIL]   (stdin is appended; read-only)');
    let acc = { main: true, label: 'this PC' };
    if (flags.account) {
      const w = String(flags.account).toLowerCase();
      acc = CA.accounts(usageDir()).find((a) => [a.id, a.email, a.label].some((x) => String(x || '').toLowerCase() === w));
      if (!acc) die(`no Codex login "${flags.account}" (ccd codex ls)`);
    }
    const out = path.join(require('os').tmpdir(), `ccd-gpt-${process.pid}.txt`);
    const args = ['exec', '--skip-git-repo-check', '--ephemeral', '--color', 'never', '-s', 'read-only', '-C', path.resolve(String(flags.cd || '.')), '-o', out,
      ...(flags.model || cfg.model ? ['-m', String(flags.model || cfg.model)] : []),
      ...(flags.image ? String(flags.image).split(',').flatMap((f) => ['-i', f.trim()]) : []), '-'];
    let errText = '', answer = '';
    const code = await new Promise((res) => {
      const c = spawn(exe, args, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true, env: { ...process.env, ...CA.envFor(acc) } });
      c.stderr.on('data', (d) => { errText += d; if (flags.verbose) process.stderr.write(d); });
      c.on('error', (e) => { console.error(`codex not found (${exe}): ${e.message} — install the Codex CLI (npm i -g @openai/codex) or set config.json "gpt": {"codex": "<path>"}`); res(127); });
      c.stdin.end(prompt);
      c.on('exit', (x) => res(x ?? 1));
    });
    try { answer = fs.readFileSync(out, 'utf8'); fs.unlinkSync(out); } catch {}
    if (answer.trim()) console.log(answer.trim());
    if (CA.LIMIT_RE.test(errText) && !answer.trim()) die(`this ChatGPT login is at its usage limit: ${(errText.split('\n').find((l) => /limit|quota|429|try again/i.test(l)) || '').trim().slice(0, 200)}`);
    if (code !== 0) die(`codex exited ${code}${answer ? '' : ` (${(errText.trim().split('\n').pop() || 'not logged in? run: codex login').slice(0, 200)} — --verbose for details)`}`);
  },
  // Your ChatGPT logins for the Codex CLI (codex-accounts.js). A codex terminal can continue the same
  // conversation on another of them ("다른 계정" button / ccd switch); nothing switches by itself.
  async codex() {
    const CA = require('./codex-accounts');
    const sub = pos[1] || 'ls';
    let gcfg = {}; try { gcfg = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8')).gpt || {}; } catch {}
    const exe = CA.codexExe(gcfg.codex);
    if (sub === 'ls') {
      const list = CA.accounts(usageDir());
      const u = await api('/api/usage').catch(() => null);
      const r = u?.accounts ? CA.rank(list, u) : list;
      console.log('Codex (ChatGPT) accounts — best first (5h% / weekly% used)');
      for (const a of r) console.log(`  ${a.usable ? '✓' : a.limited ? '✗ limit' : '?'}`.padEnd(10) + `${(a.email || a.label).padEnd(34)} 5h ${a.fiveH ?? '-'}  wk ${a.weekly ?? '-'}${a.main ? '  (이 PC 기본 로그인 ~/.codex)' : `  ${a.home}`}${a.error ? `  ! ${a.error}` : ''}`);
      return console.log('\nadd another: ccd codex add   (device code: log in on any browser/phone with the other account)');
    }
    if (sub === 'add') {
      console.log('새 ChatGPT 계정으로 Codex 로그인 — 아래에 나오는 주소를 아무 브라우저(폰 가능)에서 열고 코드를 넣은 뒤, 추가할 계정으로 로그인하세요.\n');
      let r;
      try { r = CA.loginNew(exe); } catch (e) { die(`로그인 실패: ${e.message}`); }
      const list = CA.accounts(usageDir());
      if (list.some((a) => (a.email || '').toLowerCase() === r.email.toLowerCase() && a.authPath.toLowerCase() !== r.authPath.toLowerCase()))
        console.log(`\n${r.email}는 이미 등록된 계정과 같습니다 (같은 한도를 씀). 로그인 정보만 ${r.home}에 저장했습니다.`);
      else if (!list.some((a) => a.authPath.toLowerCase() === r.authPath.toLowerCase())) {
        const x = await api('/api/usage/accounts', { account: { type: 'codex', label: r.email, authPath: r.authPath, refresh: true } });
        if (x.error) die(`로그인은 됐지만 사용량 대시보드 등록 실패: ${x.error}`);
      }
      console.log(`\n✓ ${r.email} 추가됨 (${r.home}). codex 터미널의 '다른 계정' 버튼이나 ccd switch, ccd gpt --account로 쓸 수 있습니다.`);
      return;
    }
    if (sub === 'rm') {
      const w = String(pos[2] || '').toLowerCase();
      const a = CA.accounts(usageDir()).find((x) => [x.id, x.email, x.label].some((v) => String(v || '').toLowerCase() === w));
      if (!a) die('usage: ccd codex rm <email|id>   (ccd codex ls)');
      if (a.main) die('이 PC 기본 로그인(~/.codex)은 여기서 지우지 않습니다');
      const x = await api('/api/usage/accounts', { action: 'delete', id: a.id });
      if (x.error) die(x.error);
      console.log(`removed ${a.email || a.label} from the list (login folder kept: ${a.home})`);
      return;
    }
    die('usage: ccd codex [ls | add | rm <email|id>]');
  },
  async notice() {
    const text = pos.slice(1).join(' ').trim();
    if (!text) die('usage: ccd notice "text" [--to all|t:1,t:2] [--board-only]');
    const r = await api('/api/notice', { text, to: flags.to || 'all', boardOnly: !!flags['board-only'], fromPid: SELF_PID || process.ppid });
    if (r.error) die(r.error);
    console.log(`notice saved${r.sent.length ? ` and sent to ${r.sent.join(', ')}` : ' (board only)'}`);
  },
  async notices() {
    const r = await api(`/api/notices?n=${flags.n || 20}`);
    console.log(r.notices.length ? r.notices.join('\n') : '(no notices)');
  },
  async operator() {
    const sub = pos[1] || 'status';
    if (sub === 'start') { const r = await api('/api/operator', {}); if (r.error) die(r.error); return console.log(`operator: t:${r.term.id}`); }
    const r = await api('/api/operator');
    console.log(r.term ? `operator running: t:${r.term.id} (${r.dir})` : `operator not running${r.enabled ? '' : ' (disabled in config)'} — start: ccd operator start`);
  },
  async usage() {
    const u = await api('/api/usage' + (flags.force ? '?force=1' : ''));
    if (flags.json) return console.log(JSON.stringify(u));
    if (!u.available) die(u.error);
    const until = (iso) => { const s = (new Date(iso) - Date.now()) / 1000; if (!(s > 0)) return ''; const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h >= 24 ? `${Math.floor(h / 24)}d${h % 24}h` : `${h}h${m}m`; };
    const out = [`AI usage (from ai-usage-dashboard) @ ${u.generatedAt}${u.stale ? ' STALE' : ''}`];
    for (const a of u.accounts) {
      out.push(`\n${a.label}${a.plan ? ' [' + a.plan + ']' : ''}${a.live ? ' (this PC)' : ''}${a.ok ? '' : '  ERROR ' + (a.error || '')}`);
      for (const m of a.meters || []) out.push(`  ${String(m.usedPercent == null ? "-" : Math.round(m.usedPercent)).padStart(3)}%  ${m.name}${m.resetsAt ? '  resets in ' + until(m.resetsAt) : ''}${m.detail ? '  ' + m.detail : ''}`);
      for (const n of a.notes || []) out.push(`  - ${n}`);
    }
    console.log(out.join('\n'));
  },
  async accounts() {
    const id = pos[1] ? await sessionIdOf(pos[1]) : '';
    const r = await api(`/api/switch/candidates?id=${encodeURIComponent(id)}`);
    if (flags.json) return console.log(JSON.stringify(r));
    console.log('switchable Claude accounts (5h% / weekly%, headroom = tighter limit)');
    for (const c of r.candidates) console.log(`  ${c.best ? '*' : ' '} ${c.id.padEnd(36)} ${String(c.fiveH ?? '?').padStart(3)}% / ${String(c.weekly ?? '?').padStart(3)}%  headroom ${c.score}  ${c.label}${c.current ? '  (current)' : ''}${c.usable ? '' : '  (unusable)'}`);
    console.log('  * = picked by --account auto');
  },

  async switch() {
    const id = await sessionIdOf(pos[1]);
    const o = await overview();
    const self = o.live.find((s) => s.pid === SELF_PID);
    if (self && self.sessionId === id) die('refusing to switch your own session');
    let r = await api('/api/switch', { sessionId: id, account: flags.account || 'auto', cont: !flags['no-continue'], skip: !flags['no-skip-permissions'], interrupt: !!flags.interrupt, force: !!flags.force });
    if (!r.ok) die(r.busy ? 'session is busy; re-run with --interrupt to Esc it first (ask the user)'
      : r.stuck ? 'the old claude ignored /exit; re-run with --force to kill that claude process (ask the user)' : r.error);
    console.log(`resumed ${id.slice(0, 8)} as t:${r.term.id} on ${r.account.label} (5h ${r.account.fiveH}% / wk ${r.account.weekly}%)${r.stopped ? `; stopped ${r.stopped}` : ''}`);
  },
  async research() {
    const sub = pos[1] || 'ls', slug = pos[2];
    if (sub === 'ls') {
      const r = await api('/api/research');
      if (flags.json) return console.log(JSON.stringify(r));
      if (!r.projects.length) return console.log(`(no research projects under ${r.root})`);
      for (const p of r.projects) console.log(`${p.slug.padEnd(28)} ${String(p.status).padEnd(8)} ${String(p.phase).padEnd(14)} ${p.director ? (p.director.term ? 't:' + p.director.term : 'c:' + p.director.console) : '-'}  next: ${p.next_action || ''}${p.wake_at ? '  wake ' + p.wake_at : ''}${p.blocked_reason ? '  BLOCKED: ' + p.blocked_reason : ''}`);
      return;
    }
    if (sub === 'new') {
      if (!slug || !flags.direction) die('usage: ccd research new <name> --direction "..." [--venue "..."]');
      const r = await api('/api/research/new', { name: slug, direction: flags.direction, venue: flags.venue || '' });
      if (r.error) die(r.error);
      return console.log(`created ${r.dir}; director t:${r.term.id}`);
    }
    if (!slug) die('missing <slug>');
    if (sub === 'show') {
      const d = await api(`/api/research/detail?slug=${encodeURIComponent(slug)}`);
      if (d.error) die(d.error);
      if (flags.json) return console.log(JSON.stringify(d));
      return console.log(`${d.name} [${d.status}] ${d.phase} · next: ${d.next_action}\n\n== REPORT ==\n${d.report}\n\n== QUESTIONS ==\n${d.questions}\n\n== JOURNAL (tail) ==\n${d.journal}`);
    }
    if (sub === 'pause' || sub === 'resume') { const r = await api('/api/research/control', { slug, action: sub }); return console.log(r.ok ? `${sub}d ${slug}` : r.error); }
    if (sub === 'msg') {
      const r = await api('/api/research/msg', { slug, text: pos.slice(3).join(' ') });
      return console.log(r.ok ? (r.delivered ? 'delivered to director' : 'queued in INBOX.md') : r.error);
    }
    die('research subcommands: ls | new | show | msg | pause | resume');
  },
  async gpu() {
    const sub = pos[1] || 'ls';
    const fmtMB = (m) => (m >= 1024 ? `${(m / 1024).toFixed(1)}G` : `${m}M`);
    const who = (t) => t.requester?.title || (t.requester?.pid ? `pid ${t.requester.pid}` : '?');
    if (sub === 'ls') {
      const q = await api('/api/gpu');
      if (flags.json) return console.log(JSON.stringify(q));
      const out = [];
      if (q.error) out.push(`! ${q.error}`);
      if (q.ram) out.push(`system RAM ${fmtMB(q.ram.totalMB - q.ram.freeMB)}/${fmtMB(q.ram.totalMB)} used (free ${fmtMB(q.ram.freeMB)}) · --ram reserved ${fmtMB(q.ram.reservedMB)}, not yet allocated ${fmtMB(q.ram.outstandingMB)}`);
      for (const v of q.servers || []) out.push(`server ${v.id.padEnd(6)} ${v.enabled ? 'ON ' : 'OFF'}  ${v.reachable == null ? 'checking…' : v.reachable ? 'reachable' : 'UNREACHABLE'}  ${v.name}`);
      for (const g of q.gpus) out.push(`${g.enabled === false ? '[OFF] ' : ''}${g.key.padEnd(9)} ${g.name}  mem ${fmtMB(g.usedMB)}/${fmtMB(g.totalMB)} (free ~${fmtMB(Math.max(0, g.totalMB - g.usedMB))})  util ${g.util}%${Number.isFinite(g.tempC) ? `  ${g.tempC}°C${Number.isFinite(g.cpuC) ? ` (CPU ${g.cpuC}°C)` : ''}` : ''}${g.hot ? `  🔥HOT: 새 작업 보류 (${g.hotReason})` : ''}  leased ${fmtMB(g.leasedMB)}${g.exclusive ? ' EXCLUSIVE' : ''}${g.procs?.length ? '  procs: ' + g.procs.map((p) => `${p.name}(${p.pid})`).join(', ') : ''}`);
      out.push(`ACTIVE (${q.active.length})`);
      for (const t of q.active) out.push(`  ${t.id}  ${t.gpu}  ${t.exclusive ? 'exclusive' : t.memMB == null ? 'mem ?' : fmtMB(t.memMB)}${t.ramMB ? ` ram ${fmtMB(t.ramMB)}${q.ramUse?.[t.id] != null ? ` (uses ${fmtMB(q.ramUse[t.id])})` : ''}` : ''}${t.adopted ? ' [auto]' : ''}${t.backfilled ? ' [backfill]' : ''}  ${t.label || ''}  by ${who(t)}  since ${new Date(t.grantedAt).toLocaleString()}${t.expectedEnd ? `  ETA ${new Date(t.expectedEnd).toLocaleTimeString()}${t.estSource === 'learned' ? ' (learned)' : ''}` : '  ETA ?'}`);
      out.push(`WAITING (${q.waiting.length}) — one line per GPU`);
      for (const [k, ln] of Object.entries(q.lanes || {})) if (ln.waiting.length) out.push(`  ${k}: ${ln.waiting.length} waiting${ln.headStart ? `, next start ~${new Date(ln.headStart).toLocaleTimeString()}` : ''}`);
      for (const t of q.waiting) out.push(`  #${t.position} ${t.id}  ${t.gpu}  ${t.exclusive ? 'exclusive' : fmtMB(t.memMB)}${t.ramMB ? ` ram ${fmtMB(t.ramMB)}` : ''}  ${t.label || ''}  by ${who(t)}  waited ${Math.round(t.waitedMs / 60000)}m${t.expectedStart ? `  → expected start ${new Date(t.expectedStart).toLocaleTimeString()}` : ''}`);
      return console.log(out.join('\n'));
    }
    const request = async (heartbeat, holderPid) => {
      const t = await api('/api/gpu/request', { gpu: flags.gpu || 'any', mem: flags.mem, ram: flags.ram, exclusive: !!flags.exclusive, label: flags.label || rest.join(' ').slice(0, 60), estMin: flags.est, holderPid, sessionPid: SELF_PID || null, heartbeat, cwd: process.cwd() });
      if (t.error) die(t.error);
      return t;
    };
    const waitGrant = async (id, quiet) => {
      const limit = flags.timeout ? Number(flags.timeout) * 1000 : Infinity, t0 = Date.now();
      let last = null;
      for (;;) {
        const t = await api(`/api/gpu/ticket?id=${id}`);
        if (t.status === 'granted') return t;
        if (t.status !== 'waiting') die(`ticket ${id} ended: ${t.status} (${t.endReason || ''})`);
        if (!quiet && t.position !== last) {
          console.error(`[gpu] ${id} waiting · position ${t.position} in its GPU's line${t.expectedStart ? ` · expected start ${new Date(t.expectedStart).toLocaleTimeString()}` : ''}`);
          // first time: say if another GPU would start a job like this sooner (moving needs a re-submit)
          if (last === null) {
            const r = await api(`/api/gpu/plan?${new URLSearchParams({ mem: String(t.memMB || 0) + 'M', ...(t.estMin ? { est: String(t.estMin) } : {}) })}`).catch(() => null);
            const mine = (t.lanes || []);
            const alt = (r?.gpus || []).filter((g) => !g.why && !mine.includes(g.key) && g.start && g.start - r.now < 60_000);
            if (alt.length) console.error(`[gpu]   free now elsewhere: ${alt.map((g) => `${g.how} (${g.name.replace(/NVIDIA |GeForce /g, '')}, env: ${g.envs.join('/') || '-'})`).join(' · ')} — only if your job runs there (ccd gpu plan)`);
          }
          last = t.position;
        }
        if (Date.now() - t0 > limit) die(`timeout waiting for ${id} (still queued; cancel with: ccd gpu release ${id})`);
        await new Promise((r) => setTimeout(r, 3000));
      }
    };
    if (sub === 'request') {
      // lease lives as long as the calling Claude session (or this shell's parent) unless released
      const t = await request(false, SELF_PID || process.ppid);
      console.log(`${t.id} ${t.status}${t.position ? ' · position ' + t.position : ''}`);
      if (!flags.wait) return;
      const g = await waitGrant(t.id);
      return console.log(`granted ${g.id} on ${g.gpu} → set CUDA_VISIBLE_DEVICES=${g.gpuIndex}; release with: ccd gpu release ${g.id}`);
    }
    if (sub === 'plan') {
      // pick a GPU BEFORE preparing the run: start/end per GPU for a job of this size
      const qs = new URLSearchParams({ ...(flags.mem ? { mem: flags.mem } : {}), ...(flags.ram ? { ram: flags.ram } : {}), ...(flags.est ? { est: flags.est } : {}), ...(flags.exclusive ? { exclusive: '1' } : {}) });
      const r = await api(`/api/gpu/plan?${qs}`);
      if (flags.json) return console.log(JSON.stringify(r));
      const tm = (x) => (x ? (x - r.now < 60_000 ? 'now' : new Date(x).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })) : '?');
      const out = [`GPU plan for --mem ${flags.mem || '?'}${flags.ram ? ` --ram ${flags.ram}` : ''} --est ${flags.est || '?'} (earliest finish first)`];
      for (const g of r.gpus) {
        out.push(`  ${g.why ? '✗' : '•'} ${g.how.padEnd(16)} ${g.name.replace(/NVIDIA |GeForce /g, '')} @ ${g.server} · speed ${g.speed}`
          + (g.why ? `  — ${g.why}` : `  · ${g.ahead} waiting · start ${tm(g.start)}${g.end ? ` · finish ~${tm(g.end)}` : ''}`));
        out.push(`      env: ${g.envs.join(', ') || '(none configured)'}${g.note ? ` · ${g.note}` : ''}`);
      }
      out.push('then: ccd gpu run [--gpu N] --mem .. --est .. -- <command>');
      return console.log(out.join('\n'));
    }
    if (sub === 'est') {
      const [id, v] = [pos[2], pos[3]];
      if (!id || !v) die('usage: ccd gpu est <ticket> <90m|2h|1h30m|HH:MM(end time)>');
      const r = await api('/api/gpu/est', /^\d{1,2}:\d{2}$/.test(v) ? { id, until: v } : { id, est: v });
      return console.log(r.ok ? `${r.id}: estimate ${r.estMin} min` : r.error);
    }
    if (sub === 'on' || sub === 'off') {
      if (!pos[2]) die('usage: ccd gpu on|off <local:0 | server-id>');
      const r = await api('/api/gpu/toggle', { key: pos[2], enabled: sub === 'on' });
      return console.log(r.ok ? `${r.key} → ${r.enabled ? 'ON' : 'OFF'}` : r.error);
    }
    if (sub === 'wait') { const g = await waitGrant(pos[2]); return console.log(`granted ${g.id} on ${g.gpu} (CUDA_VISIBLE_DEVICES=${g.gpuIndex})`); }
    if (sub === 'release' || sub === 'cancel') {
      const r = await api('/api/gpu/release', { id: pos[2] });
      return console.log(r.ok ? `${pos[2]} → ${r.status}` : r.error);
    }
    if (sub === 'run') {
      if (!rest.length) die('usage: ccd gpu run [--mem 20G | --exclusive] [--gpu 0] [--label L] -- <command ...>');
      const t = await request(true, process.pid);
      const g = t.status === 'granted' ? t : await waitGrant(t.id);
      console.error(`[gpu] ${g.id} granted on ${g.gpu} → CUDA_VISIBLE_DEVICES=${g.gpuIndex}`);
      const { spawn } = require('child_process');
      const host = g.gpu.split(':')[0];
      let child;
      let tailTimer = null;
      if (host === 'local') {
        // Detached (no console): closing the terminal this wrapper lives in — e.g. a dashboard
        // restart — must not kill the GPU job. Output goes to a log file that we tail to stdout;
        // if this wrapper dies the job keeps running and keeps writing there.
        const logDir = path.join(DIR, 'gpu-logs');
        fs.mkdirSync(logDir, { recursive: true });
        const logFile = path.join(logDir, `${g.id}.log`);
        // Launched by WMI, outside this process tree (see lib-localjob.js): a torn-down session shell,
        // closed terminal or dashboard restart can't take the job with it.
        const LJ = require('./lib-localjob');
        const exitFile = logFile + '.exit';
        try { fs.unlinkSync(exitFile); } catch {}
        fs.appendFileSync(logFile, '');
        const cmdFile = path.join(logDir, `${g.id}.cmd`);
        LJ.writeJobCmd({ file: cmdFile, rest, cwd: process.cwd(), env: { ...process.env, CUDA_VISIBLE_DEVICES: String(g.gpuIndex), CCD_GPU_TICKET: g.id, PYTHONUNBUFFERED: '1' }, logFile, exitFile });
        let jobPid;
        try { jobPid = LJ.launchViaWmi(cmdFile, process.cwd()); } catch (e) {
          await api('/api/gpu/release', { id: g.id, exitCode: 1, reason: '작업 시작 실패' }).catch(() => {});
          die(`[gpu] could not start the job: ${e.message}`);
        }
        console.error(`[gpu] job log: ${logFile}  (pid ${jobPid}, independent of this shell — keeps running if this session/terminal closes)`);
        let pos = 0;
        const pump = () => {
          try {
            const size = fs.statSync(logFile).size;
            if (size > pos) { const b = Buffer.alloc(size - pos); const h = fs.openSync(logFile, 'r'); fs.readSync(h, b, 0, b.length, pos); fs.closeSync(h); pos = size; process.stdout.write(b); }
          } catch {}
        };
        tailTimer = setInterval(pump, 1000);
        // a child-like handle for the code below: 'exit' when the job's cmd.exe is gone
        const { EventEmitter } = require('events');
        child = new EventEmitter();
        child.pid = jobPid;
        child.kill = () => { try { require('child_process').execFileSync('taskkill', ['/PID', String(jobPid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {} };
        const watch = setInterval(() => {
          if (LJ.alive(jobPid)) return;
          clearInterval(watch);
          setTimeout(() => {
            pump();
            let code = 1;
            try { const x = fs.readFileSync(exitFile, 'utf8').trim(); code = /^-?\d+$/.test(x) ? Number(x) : 1; } catch {}
            child.emit('exit', code, null);
          }, 500);
        }, 2000);
        api('/api/gpu/heartbeat', { id: g.id, childPid: jobPid, log: logFile, detached: true }).catch(() => {});
      } else {
        die(`[gpu] ${g.gpu} is not a GPU on this PC`);
      }
      const hb = setInterval(() => api('/api/gpu/heartbeat', { id: g.id, childPid: child.pid }).catch(() => {}), 30000);
      const finish = async (code) => {
        clearInterval(hb); if (tailTimer) clearInterval(tailTimer);
        await api('/api/gpu/release', { id: g.id, exitCode: code, reason: `작업 종료 (exit ${code})` }).catch(() => {});
        process.exit(code);
      };
      child.on('exit', (code, sig) => finish(code ?? (sig ? 1 : 0)));
      process.on('SIGINT', () => { try { child.kill(); } catch {} });
      return new Promise(() => {}); // stay alive until the child exits
    }
    die('gpu subcommands: ls | plan | request | wait | release | est | on | off | run');
  },
  async reload() {
    const r = await api('/api/admin/reload', { modules: flags.modules ? String(flags.modules).split(',') : undefined });
    console.log(r.ok ? `reloaded: ${r.reloaded.join(', ') || '(nothing)'} — terminals untouched` : r.error || 'reload not supported by this server (needs one restart first)');
  },
  async artifact() {
    const sub = pos[1] || 'ls';
    // default session = the calling Claude session
    const o = await overview();
    const self = o.live.find((x) => x.pid === SELF_PID);
    const sid = flags.session ? await sessionIdOf(flags.session) : self?.sessionId;
    if (!sid) die('no session: run inside a Claude session or pass --session <id|target>');
    if (sub === 'add') {
      const file = pos.slice(2).join(' ');
      if (!file) die('usage: ccd artifact add <path> [--title T] [--session S]');
      const r = await api('/api/artifacts/add', { session: sid, path: path.resolve(file), title: flags.title });
      return console.log(r.ok ? `pinned as output of ${sid.slice(0, 8)}: ${r.path}` : r.error);
    }
    if (sub === 'ls') {
      const r = await api(`/api/artifacts?session=${encodeURIComponent(sid)}`);
      const items = flags.all ? r.items : r.items.filter((x) => x.main);
      if (flags.json) return console.log(JSON.stringify(items));
      return console.log(items.map((x) => `${x.source === 'pinned' ? '*' : ' '} ${x.kind.padEnd(8)} ${x.path}`).join('\n') || '(none)');
    }
    if (sub === 'hide') {  // unpin + hide (also hides files auto-detected from the conversation)
      const files = pos.slice(2);
      if (!files.length) die('usage: ccd artifact hide <path> [<path> ...] [--session S]');
      for (const f of files) {
        const r = await api('/api/artifacts/hide', { session: sid, path: path.resolve(f) });
        console.log(r.ok ? `hidden: ${path.resolve(f)}` : r.error);
      }
      return;
    }
    die('artifact subcommands: ls [--all] | add <path> [--title T] | hide <path...>');
  },
  async url() { console.log(fs.readFileSync(path.join(DIR, 'url.txt'), 'utf8').trim()); },

  async ls() {
    const o = await overview();
    if (flags.json) return console.log(JSON.stringify(o, null, 1));
    const out = [];
    out.push('LIVE CLAUDE SESSIONS');
    for (const s of o.live.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))) {
      const c = conOfPid(o, s.pid);
      // Claude desktop-app sessions run headless (hidden console titled with the exe path)
      const desk = s.entrypoint === 'claude-desktop';
      const where = desk ? 'desktop' : c ? (c.managed ? `t:${termOfCon(o, c)?.id ?? '?'}` : `c:${c.id}`) : 'no-window';
      const self = SELF_PID === s.pid ? '  <- YOU' : '';
      const lim = s.limit ? `  LIMIT: ${s.limit.text}` : '';
      out.push(`  ${where.padEnd(9)} ${String(s.status || '-').padEnd(5)} ${s.sessionId.slice(0, 8)} ${(desk ? s.name : c ? (c.managed && termOfCon(o, c) ? termLabel(termOfCon(o, c)) : cleanTitle(c.title)) : s.name) || ''}  [${s.cwd}] ${ago(s.updatedAt)}${self}${lim}`);
    }
    out.push('CONSOLE WINDOWS' + (flags.all ? ' (incl. hidden)' : ''));
    const deskPids = new Set(o.live.filter((x) => x.entrypoint === 'claude-desktop').map((x) => x.pid));
    for (const c of o.consoles.filter((c) => (flags.all || c.visible) && !c.managed && !c.pids.some((p) => deskPids.has(p)))) {
      const self = o.selfCon?.id === c.id ? '  <- YOU' : '';
      out.push(`  c:${String(c.id).padEnd(7)} ${cleanTitle(c.title)}  (${c.procs.map((p) => p.name.replace(/\.exe$/, '')).join(' > ')})${sessOfCon(o, c) ? ' [claude]' : ''}${self}`);
    }
    out.push('DASHBOARD TERMINALS');
    for (const t of o.terms) out.push(`  t:${t.id.padEnd(7)} ${termLabel(t)}  [${t.cwd}] ${t.exited === null ? 'running' : 'exited ' + t.exited}${o.selfTerm?.id === t.id ? '  <- YOU' : ''}`);
    if (!o.terms.length) out.push('  (none)');
    console.log(out.join('\n'));
  },

  async read() {
    const o = await overview();
    const r = resolve(o, pos[1]);
    const lines = await readTarget(r, flags.n || 60);
    if (flags.json) return console.log(JSON.stringify({ target: r, lines }));
    console.log(`== ${r.label}${r.session ? ` · claude ${r.session.status || ''}` : ''}\n` + lines.join('\n'));
  },

  async send() {
    const o = await overview();
    const r = resolve(o, pos[1]);
    if (isSelf(o, r)) die('refusing to type into your own session');
    const text = pos.slice(2).join(' ');
    if (!text && flags['no-enter']) die('nothing to send');
    const screen = (await readTarget(r, 25)).join('\n');
    const prompt = pendingPrompt(screen);
    if (prompt && !flags.force) die(`${r.label} is showing a ${prompt} — typing now would answer it.\n` +
      `Read it (ccd read ${pos[1]}) and answer with ccd keys, or re-run with --force.\n\n${screen.split('\n').slice(-12).join('\n')}`);
    const submit = !flags['no-enter'];
    const d = r.kind === 'term'
      ? await api('/api/term/send', text ? { id: r.id, text, submit } : { id: r.id, keys: ['enter'] })
      : await api('/api/console/send', text ? { pid: r.pid, text, submit } : { pid: r.pid, keys: ['enter'] });
    if (!d.ok) die(`send failed: ${d.error}`);
    console.log(`sent to ${r.label}${submit ? ' (+Enter)' : ''}`);
  },

  async keys() {
    const o = await overview();
    const r = resolve(o, pos[1]);
    if (isSelf(o, r)) die('refusing to type into your own session');
    const keys = pos.slice(2);
    if (!keys.length) die('no keys given');
    const d = r.kind === 'term' ? await api('/api/term/send', { id: r.id, keys }) : await api('/api/console/send', { pid: r.pid, keys });
    if (!d.ok) die(`keys failed: ${d.error}`);
    console.log(`keys ${keys.join(' ')} -> ${r.label}`);
  },

  async wait() {
    const timeout = Number(flags.timeout || 900) * 1000;
    const t0 = Date.now();
    let o = await overview();
    let r = resolve(o, pos[1]);
    // a Codex terminal reports busy/idle itself (from its screen); a Claude session through its session file
    const codexTerm = () => (r.kind === 'term' ? o.terms.find((t) => String(t.id) === String(r.id) && t.codex) : null);
    const status = () => (codexTerm() ? codexTerm().status : r.session ? o.live.find((s) => s.sessionId === r.session.sessionId)?.status : null);
    // a Claude session may take a moment to register (fresh terminal) or to turn busy
    let sawBusy = false;
    for (;;) {
      o = await overview();
      try { r = resolve(o, pos[1]); } catch {}
      const st = status();
      if (st === 'busy') sawBusy = true;
      const elapsed = Date.now() - t0;
      const agent = r.session || codexTerm();
      if (agent && st !== 'busy' && (sawBusy || elapsed > 8000)) break;
      if (!agent && elapsed > 20000) die(`${r.label} is not a Claude or Codex session (nothing to wait for)`);
      if (elapsed > timeout) { console.log(`timeout after ${timeout / 1000}s (still ${st})`); break; }
      await new Promise((res) => setTimeout(res, 1500));
    }
    const lines = await readTarget(r, flags.n || 40);
    console.log(`== ${r.label} · ${status() || 'unknown'} after ${Math.round((Date.now() - t0) / 1000)}s\n` + lines.join('\n'));
  },

  async new() {
    const kind = pos[1] || 'claude';
    if (!['claude', 'codex', 'cursor', 'powershell', 'cmd'].includes(kind)) die('kind must be claude, codex (GPT), cursor, powershell or cmd');
    const t = await api('/api/term/new', { kind, cwd: flags.cwd || process.cwd(), resume: flags.resume, skipPermissions: !flags['no-skip-permissions'], title: flags.title, model: flags.model });
    console.log(`t:${t.id}  ${t.title}  [${t.cwd}]`);
    if (kind === 'codex') {
      // codex is ready when its composer is up ("› …" / "send" hint) or it asks for a decision (trust, update, login)
      const r = { kind: 'term', id: t.id, label: `t:${t.id}` };
      for (let i = 0; i < 40; i++) {
        await new Promise((res) => setTimeout(res, 500));
        const screen = (await readTarget(r, 40)).join('\n');
        if (/Do you trust|Allow Codex|Sign in with ChatGPT|Update available|press enter to continue/i.test(screen)) return console.log(`READY-BLOCKED: codex is asking something. Ask the user, then answer with ccd keys t:${t.id} ...\n\n${screen.split('\n').slice(-14).join('\n')}`);
        if (/^\s*›|⏎ send|to send|for shortcuts/m.test(screen) && i > 2) return console.log('READY: input box is up');
      }
      return console.log('not sure it is ready yet — check with ccd read t:' + t.id);
    }
    if (kind !== 'claude') return;
    // wait until claude has drawn its input box (or stopped at a prompt)
    const r = { kind: 'term', id: t.id, label: `t:${t.id}` };
    for (let i = 0; i < 40; i++) {
      await new Promise((res) => setTimeout(res, 500));
      const screen = (await readTarget(r, 40)).join('\n');
      const p = pendingPrompt(screen);
      if (p) return console.log(`READY-BLOCKED: ${p} is showing. Do not send a prompt yet; ask the user, then answer with ccd keys t:${t.id} ...\n\n${screen.split('\n').slice(-14).join('\n')}`);
      if (/^\s*>\s*$|^\s*❯\s|\? for shortcuts|bypass permissions|auto mode|accept edits/m.test(screen) && i > 2) return console.log('READY: input box is up');
    }
    console.log('not sure it is ready yet — check with ccd read t:' + t.id);
  },

  async close() {
    const m = /^t:?(\d+)$/.exec(pos[1] || '');
    if (!m) die('close takes t:<id> (only dashboard terminals can be closed)');
    await api('/api/term/close', { id: m[1] });
    console.log(`closed t:${m[1]}`);
  },

  async search() {
    const q = pos.slice(1).join(' ');
    if (!q) die('search needs a query');
    const qs = new URLSearchParams({ q, role: flags.role || 'all', cwd: flags.cwd || '', agent: flags.agent || '', auto: flags.auto ? '1' : '0', screens: flags['no-screens'] ? '0' : '1' });
    const d = await api('/api/search?' + qs);
    if (flags.json) return console.log(JSON.stringify(d));
    const out = [`${d.sessions.length} sessions, ${d.screens.length} windows (${d.ms}ms)${d.ready ? '' : ' — index still building, partial'}`];
    for (const c of d.screens) {
      out.push(`\n[window c:${c.id}] ${cleanTitle(c.title)}`);
      for (const h of c.hits) out.push(`    ${h.text}`);
    }
    for (const s of d.sessions.slice(0, flags.n || 20)) {
      out.push(`\n[${s.sessionId}]${s.agent === 'codex' ? ' (codex)' : ''} ${(s.title || s.firstPrompt || '').slice(0, 80)}  [${s.cwd}] ${ago(s.mtime)} · ${s.total} hits${s.auto ? ' · sdk' : ''}`);
      for (const h of s.hits) out.push(`  @${h.i} ${h.role === 'user' ? 'U' : 'A'}: ${h.snippet}`);
    }
    console.log(out.join('\n'));
  },

  async log() {
    let id = pos[1];
    if (!id) die('log needs a session id (or prefix)');
    if (id.length < 36) {
      const o = await api('/api/overview');
      const live = o.live.find((s) => s.sessionId.startsWith(id));
      const rec = live ? null : (await api('/api/recent?n=200&auto=1')).sessions.find((s) => s.sessionId.startsWith(id));
      id = live?.sessionId || rec?.sessionId || id;
    }
    const at = flags.at !== undefined ? Number(flags.at) : -1;
    const d = await api(`/api/transcript?id=${encodeURIComponent(id)}${at >= 0 ? '&at=' + at : ''}`);
    if (!d.messages?.length) die(d.error || 'no messages');
    let msgs = d.messages.map((m, k) => ({ ...m, i: (d.base || 0) + k }));
    const n = flags.n || 30;
    if (at >= 0) { const k = msgs.findIndex((m) => m.i === at); msgs = msgs.slice(Math.max(0, k - Math.floor(n / 2)), Math.max(0, k - Math.floor(n / 2)) + n); }
    else msgs = msgs.slice(-n);
    if (flags.json) return console.log(JSON.stringify({ sessionId: id, title: d.title, cwd: d.cwd, total: d.total, messages: msgs }));
    console.log(`== ${id} ${d.title || ''} [${d.cwd || ''}] ${d.total ?? ''} msgs`);
    for (const m of msgs) console.log(`\n@${m.i} ${m.role === 'user' ? 'USER' : d.agent === 'codex' ? 'CODEX' : 'CLAUDE'}${m.ts ? ' ' + m.ts : ''}${m.i === at ? '  <==' : ''}\n${m.text}`);
  },
};

(async () => {
  const c = pos[0];
  if (!c || c === 'help' || flags.help) return console.log(HELP);
  if (!cmds[c]) die(`unknown command ${c}\n\n${HELP}`);
  if (c !== 'url') await ensureUp(c === 'up' || c === 'restart');
  await cmds[c]();
})().catch((e) => die(String(e.stack || e)));
