#!/usr/bin/env node
// Telegram Relay for Claude Code — talk to your Claude Code sessions on this PC from Telegram.
// No hub or server needed: it runs the Claude CLI directly (`claude -p --resume <session>`), one turn
// per message, and reads the sessions from ~/.claude/projects.
//
//   node relay.js setup [--token <BotFather token>] [--proxy http://host:port] [--lang en|ko]   link a bot (once)
//   node relay.js                                                                              run the bot
//
// Telegram side (built for a phone: buttons instead of commands, one message edited in place where possible)
//   📋 Sessions   tabs Recent / Open on PC / Folders / Search; ➕ new conversation in a folder
//   📌 card       the chosen session, pinned at the top of the chat, with its own buttons
//   text          → the session continues with it; a live progress card (steps, time, ⏹) while it works;
//                   the answer is formatted for a phone, long ones page with ◀ ▶ in the same message,
//                   the steps it took are folded into an expandable quote; quick-reply buttons below
//   photo / file  → saved in data/inbox, the session gets the path (caption = the request)
//   output files  → PDFs, figures, videos written in that turn are sent (several pictures as one album)
//   ⚙ Settings    PC-turn notifications, permission mode, model, answer style
// A session that is open in a terminal on the PC is never written to twice: the first message forks
// it into a copy (same history) and the relay continues there.
//
// Config: data/config.json (or env RELAY_CONFIG)
//   { token, allowed: [telegram user ids], lang?: "en"|"ko", proxy?, claude?: path, model?,
//     permissionMode?: "acceptEdits"|"bypassPermissions"|"plan", style?: "phone"|"raw",
//     autoSendFiles?: 6, maxTurnMinutes?: 60 }
'use strict';
const https = require('https'), http = require('http'), tls = require('tls');
const fs = require('fs'), path = require('path'), os = require('os'), readline = require('readline');
const { spawn, execFileSync } = require('child_process');

const DIR = __dirname;
const CFG_FILE = process.env.RELAY_CONFIG || path.join(DIR, 'data', 'config.json');
const DATA = path.dirname(CFG_FILE);
const STATE = path.join(DATA, 'state.json'), LOG = path.join(DATA, 'relay.log'), PIDF = path.join(DATA, 'relay.pid');
const INBOX = path.join(DATA, 'inbox');
const HOME = process.env.RELAY_CLAUDE_HOME || path.join(os.homedir(), '.claude');
const PROJECTS = path.join(HOME, 'projects'), LIVE = path.join(HOME, 'sessions');
const log = (...a) => { const l = `${new Date().toISOString()} ${a.join(' ')}`; console.log(l); try { fs.appendFileSync(LOG, l + '\n'); } catch {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let CFG = {};
try { CFG = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')); } catch {}
const saveCfg = () => { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(CFG_FILE, JSON.stringify(CFG, null, 1)); };

// ---------- language ----------
const sysLang = () => { try { return Intl.DateTimeFormat().resolvedOptions().locale; } catch { return ''; } };
const LANG = () => ((CFG.lang || process.env.RELAY_LANG || sysLang()).toLowerCase().startsWith('ko') ? 'ko' : 'en');
const M = {
  en: {
    pick: '📋 Sessions', files: '📂 Files', stop: '⏹ Stop', settings: '⚙ Settings', recent: '📜 Recent', change: '🔄 Change',
    tabRecent: '🕘 Recent', tabOpen: '🟢 Open', tabFolders: '📁 Folders', tabSearch: '🔎 Search', refresh: '🔄', newChat: '➕ New conversation', newHere: '➕ New here',
    pickTitle: 'Choose a session', none: 'No session chosen yet', noSessions: 'Nothing here.', legend: '🟢 open on the PC · 📱 from Telegram · ⚪ saved',
    foldersTitle: 'Folders', searchAsk: 'Type words from the title, first message or folder', searchTitle: (q) => `Search: ${q}`,
    card: 'Messages and photos go to this session', lastAnswer: 'Last answer', liveNote: 'Open in a terminal on the PC — your first message continues it as a copy (fork) so the two never collide.',
    newCard: 'New conversation', newHint: 'Send the first message.',
    pickFirst: 'First choose the session that should get your messages', gone: 'That conversation no longer exists. Pick another one.',
    working: 'Working', queued: (n) => `Queued (${n}) — sent when the current turn ends`, forked: 'continuing as a copy (the session is open on the PC)',
    steps: (n) => `Steps (${n})`, noAnswer: '(no text answer)', failed: 'Failed', stopped: 'Stopped', nothingRunning: 'Nothing is running.',
    newFolder: 'New conversation — choose a folder',
    moreFiles: (n) => `${n} more output file(s)`, tooBig: (n) => `${n}: Telegram bots can send at most 50 MB`, noFile: 'File not found',
    tooBigIn: 'Telegram bots cannot receive files over 20 MB', got: (w) => `📥 ${w} → session`,
    sentFiles: (what, cap) => `I sent ${what}.${cap ? ` Request: ${cap}` : ' Please take a look.'}`, photo: 'photo', file: 'file', video: 'video', audio: 'audio', voice: 'voice message',
    noOutputs: 'No output files yet', outputsOf: (n) => `Output files · latest ${n} · tap to receive`, recentTitle: 'Recent messages',
    unknown: 'Unknown command — use the buttons below', expired: '(expired — open it again)', empty: '(empty)',
    quick: [['▶ Continue', 'Continue.'], ['✂ Shorter', 'Summarize your last answer even shorter.'], ['📄 As PDF', 'Put your last answer into a PDF and give me its full path.']],
    filesBtn: (n) => `📂 Files (${n})`,
    setTitle: 'Settings', setFollow: 'PC turns', setFollowHelp: 'also send answers to turns you run on the PC in the chosen session',
    setPerm: 'Permissions', setPermHelp: 'what Claude may do without asking (nobody can approve a prompt from Telegram)',
    perms: { acceptEdits: 'Edit files', bypassPermissions: 'Everything', plan: 'Read only' },
    setModel: 'Model', models: { '': 'Default', sonnet: 'Sonnet', opus: 'Opus', haiku: 'Haiku' },
    setStyle: 'Answers', styles: { phone: 'Short, for a phone', raw: 'As written' }, on: 'on', off: 'off',
    help: ['<b>🤖 Claude Code relay</b>', '', '<b>{pick}</b> choose a conversation (or start a new one)', '💬 <b>Message</b> it continues with it; the answer comes back',
      '📷 <b>Photo / file</b> passed on with its path; the caption is the request', '<b>{files}</b> receive what the session produced',
      '<b>{stop}</b> stop the running turn', '<b>{settings}</b> notifications, permissions, model', '', 'Files written during a turn arrive with the answer.'],
    note: '(Sent from Telegram on a phone. Answer for a small screen: conclusion first, short paragraphs and bullet lists, no wide tables or long code. If you produce files worth sending (PDF, images, video, documents), just mention their full paths: the relay delivers them to Telegram by itself, so do not try to send anything yourself.)',
    setupIntro: ['Create a Telegram bot (1 minute)', '  1. Open @BotFather in Telegram (https://t.me/BotFather)', '  2. Send /newbot, then choose a name and a username ending in "bot"',
      '  3. Paste the token BotFather gives you (looks like 123456789:AA…)', ''],
    token: 'Bot token: ', badToken: 'Could not verify the token:', netHint: 'Telegram could not be reached. Behind a proxy? Run setup again with --proxy http://host:port', running: (p) => `The relay is running (pid ${p}). Stop it first, then run setup again.`,
    pairing: (u, code) => ['', `Bot: @${u}`, 'Now link your Telegram account to this PC. In Telegram (phone or desktop):', `  https://t.me/${u}?start=${code}   (open it and press START)`,
      `  or send the code ${code} to @${u}`, 'Waiting up to 10 minutes…'],
    sendCode: 'Please send the link code shown on the PC', timeout: 'Timed out. Run setup again.', linked: '✅ Linked to this PC.',
    perm: ['', 'What may Claude do without asking when you write from Telegram? (nobody can approve prompts there; changeable later in ⚙ Settings)',
      '  1) edit files, nothing else without asking  [acceptEdits]  (default)', '  2) everything, like --dangerously-skip-permissions  [bypassPermissions]',
      '  3) read-only  [plan]'], permAsk: 'Choose 1-3 [1]: ',
    done: (who, f) => [`Linked: ${who}`, `Config: ${f}`, 'Start the bot: start.bat (or: node relay.js)'],
    notLinked: (f) => `Not linked to Telegram yet. First run: node "${f}" setup`,
    cmds: { sessions: 'Choose a session', files: 'Receive output files', stop: 'Stop the running turn', settings: 'Settings', help: 'Help' },
  },
  ko: {
    pick: '📋 세션', files: '📂 산출물', stop: '⏹ 멈춤', settings: '⚙ 설정', recent: '📜 최근 대화', change: '🔄 바꾸기',
    tabRecent: '🕘 최근', tabOpen: '🟢 열림', tabFolders: '📁 폴더', tabSearch: '🔎 검색', refresh: '🔄', newChat: '➕ 새 대화', newHere: '➕ 여기서 새 대화',
    pickTitle: '세션 선택', none: '아직 고른 세션이 없습니다', noSessions: '해당하는 세션이 없습니다.', legend: '🟢 PC에서 열림 · 📱 텔레그램에서 시작 · ⚪ 저장됨',
    foldersTitle: '폴더', searchAsk: '제목·첫 메시지·폴더 이름에 들어간 말을 입력하세요', searchTitle: (q) => `검색: ${q}`,
    card: '메시지와 사진이 이 세션으로 갑니다', lastAnswer: '마지막 답', liveNote: 'PC 터미널에서 열려 있는 세션입니다. 첫 메시지부터 사본(포크)으로 이어 가서 서로 덮어쓰지 않습니다.',
    newCard: '새 대화', newHint: '첫 메시지를 보내세요.',
    pickFirst: '먼저 메시지를 받을 세션을 고르세요', gone: '그 대화를 찾을 수 없습니다. 다른 세션을 고르세요.',
    working: '작업 중', queued: (n) => `대기 ${n}개: 지금 작업이 끝나면 보냅니다`, forked: 'PC에서 열려 있어 사본으로 이어서 진행',
    steps: (n) => `작업 과정 (${n})`, noAnswer: '(글로 된 답이 없습니다)', failed: '실패', stopped: '멈췄습니다', nothingRunning: '진행 중인 작업이 없습니다.',
    newFolder: '새 대화: 폴더를 고르세요',
    moreFiles: (n) => `산출물 ${n}개 더`, tooBig: (n) => `${n}: 텔레그램 봇은 50MB까지만 보낼 수 있습니다`, noFile: '파일이 없습니다',
    tooBigIn: '텔레그램 봇은 20MB가 넘는 파일을 받을 수 없습니다', got: (w) => `📥 ${w} → 세션에 전달`,
    sentFiles: (what, cap) => `${what}를 보냈습니다.${cap ? ` 요청: ${cap}` : ' 내용을 확인해 주세요.'}`, photo: '사진', file: '파일', video: '영상', audio: '오디오', voice: '음성',
    noOutputs: '아직 산출물이 없습니다', outputsOf: (n) => `산출물 · 최근 ${n}개 · 누르면 받습니다`, recentTitle: '최근 대화',
    unknown: '모르는 명령입니다. 아래 버튼을 쓰세요', expired: '(만료됐습니다. 다시 여세요)', empty: '(빈 응답)',
    quick: [['▶ 계속', '계속 진행해'], ['✂ 더 짧게', '방금 답을 더 짧게 요약해줘'], ['📄 PDF로', '방금 내용을 PDF로 정리하고 전체 경로를 알려줘']],
    filesBtn: (n) => `📂 산출물 (${n})`,
    setTitle: '설정', setFollow: 'PC 작업 알림', setFollowHelp: '고른 세션에서 PC로 시킨 작업의 답도 보내기',
    setPerm: '권한', setPermHelp: 'Claude가 묻지 않고 해도 되는 범위 (텔레그램에서는 승인 창을 누를 수 없습니다)',
    perms: { acceptEdits: '파일 수정까지', bypassPermissions: '전부 허용', plan: '읽기만' },
    setModel: '모델', models: { '': '기본', sonnet: 'Sonnet', opus: 'Opus', haiku: 'Haiku' },
    setStyle: '답 형식', styles: { phone: '휴대폰용 요약', raw: '원문 그대로' }, on: '켜짐', off: '꺼짐',
    help: ['<b>🤖 Claude Code 릴레이</b>', '', '<b>{pick}</b> 대화할 세션 고르기 (새 대화도 가능)', '💬 <b>메시지</b> 고른 세션에 전달되고, 끝나면 답이 옵니다',
      '📷 <b>사진·파일</b> 경로와 함께 세션에 전달 (캡션 = 요청)', '<b>{files}</b> 세션이 만든 파일 받기',
      '<b>{stop}</b> 진행 중인 작업 멈추기', '<b>{settings}</b> 알림·권한·모델', '', '그 턴에 만든 파일은 답과 함께 자동으로 옵니다.'],
    note: '(휴대폰 텔레그램에서 보낸 메시지입니다. 작은 화면에서 읽기 좋게 답하세요: 결론 먼저, 짧은 문단과 목록, 넓은 표와 긴 코드는 피하기. 보낼 만한 결과 파일(PDF·그림·영상·문서)이 있으면 전체 경로만 적어 주세요. 릴레이가 알아서 텔레그램으로 보내므로 직접 보내려고 하거나 보낼 수 없다고 말할 필요가 없습니다.)',
    setupIntro: ['텔레그램 봇 만들기 (1분)', '  1. 텔레그램에서 @BotFather 를 엽니다 (https://t.me/BotFather)', '  2. /newbot 을 보내고, 봇 이름과 아이디(bot 으로 끝나야 함)를 정합니다',
      '  3. BotFather가 알려 주는 토큰(123456789:AA… 형태)을 붙여 넣습니다', ''],
    token: '봇 토큰: ', badToken: '토큰을 확인하지 못했습니다:', netHint: '텔레그램에 연결하지 못했습니다. 프록시를 쓰는 망이면 --proxy http://주소:포트 를 붙여 다시 실행하세요', running: (p) => `릴레이가 실행 중입니다 (pid ${p}). 먼저 멈춘 뒤 다시 실행하세요.`,
    pairing: (u, code) => ['', `봇 확인: @${u}`, '이제 내 텔레그램 계정을 이 PC와 연결합니다. 휴대폰이나 PC 텔레그램에서:', `  https://t.me/${u}?start=${code}   (열고 [시작]을 누르세요)`,
      `  또는 @${u} 에게 연결 코드 ${code} 를 보내세요`, '10분 동안 기다립니다…'],
    sendCode: 'PC 화면에 나온 연결 코드를 보내 주세요', timeout: '시간이 지났습니다. 다시 실행하세요.', linked: '✅ 이 PC와 연결됐습니다.',
    perm: ['', '텔레그램에서 시킨 일에 Claude가 묻지 않고 해도 되는 범위 (텔레그램에서는 승인 창을 누를 수 없습니다. 나중에 ⚙ 설정에서 바꿀 수 있습니다)',
      '  1) 파일 수정까지, 그 밖의 것은 하지 않음  [acceptEdits]  (기본)', '  2) 전부 허용, --dangerously-skip-permissions 와 같음  [bypassPermissions]',
      '  3) 읽기만  [plan]'], permAsk: '1-3 중 선택 [1]: ',
    done: (who, f) => [`연결 완료: ${who}`, `설정 파일: ${f}`, '봇 실행: start.bat (또는 node relay.js)'],
    notLinked: (f) => `아직 텔레그램과 연결되지 않았습니다. 먼저: node "${f}" setup`,
    cmds: { sessions: '세션 고르기', files: '산출물 받기', stop: '진행 중인 작업 멈추기', settings: '설정', help: '도움말' },
  },
};
const T = () => M[LANG()];

// ---------- Telegram Bot API (optionally through an HTTP CONNECT proxy) ----------
class Tunnel extends https.Agent {
  constructor(u) { super({ keepAlive: true }); this.p = new URL(u); }
  createConnection(o, cb) {
    const r = http.request({ host: this.p.hostname, port: Number(this.p.port) || 80, method: 'CONNECT', path: `${o.host}:${o.port}`, headers: { Host: `${o.host}:${o.port}` } });
    r.once('connect', (res, sock) => { if (res.statusCode !== 200) return cb(new Error('proxy CONNECT ' + res.statusCode)); const s = tls.connect({ socket: sock, servername: o.host }, () => cb(null, s)); s.once('error', cb); });
    r.once('error', cb); r.end();
  }
}
let agent;
// a kept-alive socket the server already closed fails with ECONNRESET before anything was sent: retry once
async function request(urlPath, body, headers, timeout) {
  try { return await request1(urlPath, body, headers, timeout); }
  catch (e) { if (!/ECONNRESET|EPIPE|socket hang up/.test(e.message)) throw e; await sleep(300); return request1(urlPath, body, headers, timeout); }
}
function request1(urlPath, body, headers, timeout) {
  const u = new URL(CFG.apiBase || 'https://api.telegram.org'), mod = u.protocol === 'http:' ? http : https;
  if (agent === undefined) { const px = CFG.proxy || process.env.TELEGRAM_PROXY || process.env.HTTPS_PROXY || ''; agent = px && mod === https ? new Tunnel(px) : null; }
  return new Promise((ok, no) => {
    const req = mod.request({ hostname: u.hostname, port: u.port || (mod === https ? 443 : 80), path: urlPath, method: body ? 'POST' : 'GET', agent: agent || undefined, timeout,
      headers: body ? { 'content-length': body.length, ...headers } : headers }, (res) => {
      const bs = []; res.on('data', (c) => bs.push(c)); res.on('end', () => ok({ status: res.statusCode, buf: Buffer.concat(bs) }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout'))); req.on('error', no); req.end(body);
  });
}
const parse = (method, r) => {
  let j; try { j = JSON.parse(r.buf.toString('utf8')); } catch { throw new Error(`${method}: bad reply ${r.status}`); }
  if (!j.ok) throw new Error(`${method}: ${j.description}`);
  return j.result;
};
const tg = async (method, payload, timeout = 35000) => parse(method, await request(`/bot${CFG.token}/${method}`, Buffer.from(JSON.stringify(payload || {})), { 'content-type': 'application/json' }, timeout));
// multipart upload: fields + files {field: path}
async function tgUpload(method, fields, files) {
  const b = '----relay' + Math.random().toString(16).slice(2), parts = [];
  for (const [k, v] of Object.entries(fields)) if (v != null) parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${typeof v === 'string' ? v : JSON.stringify(v)}\r\n`));
  for (const [k, file] of Object.entries(files)) {
    parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"; filename="${path.basename(file).replace(/["\r\n]/g, '_')}"\r\nContent-Type: application/octet-stream\r\n\r\n`), fs.readFileSync(file), Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${b}--\r\n`));
  return parse(method, await request(`/bot${CFG.token}/${method}`, Buffer.concat(parts), { 'content-type': `multipart/form-data; boundary=${b}` }, 300000));
}
async function tgDownload(fileId) {
  const f = await tg('getFile', { file_id: fileId });
  const r = await request(`/file/bot${CFG.token}/${f.file_path}`, null, {}, 180000);
  if (r.status !== 200) throw new Error('download ' + r.status);
  return { buf: r.buf, filePath: f.file_path };
}

// ---------- messages for a phone screen ----------
// Answers are Markdown → Telegram HTML (headings → bold, tables → one card per row, lists → •,
// code → <code>/<pre>). Long text is split into pages shown in ONE message with ◀ n/N ▶.
const esc = (t) => String(t ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const inline = (t) => esc(t)
  .replace(/`([^`]+)`/g, '<code>$1</code>')
  .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
  .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>');
function mdToTg(md) {
  const blocks = [];
  const src = String(md || '').replace(/```[\w-]*\n?([\s\S]*?)```/g, (_, c) => { blocks.push(`<pre>${esc(c.trimEnd())}</pre>`); return `@@B${blocks.length - 1}@@`; });
  const lines = src.split('\n'), out = [];
  const isRow = (l) => /^\s*\|.*\|\s*$/.test(l);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m;
    if (isRow(l)) {
      const rows = [];
      while (i < lines.length && isRow(lines[i])) rows.push(lines[i++]);
      i--;
      const cells = rows.filter((r) => !/^\s*\|[\s:|-]+\|\s*$/.test(r)).map((r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
      const head = cells.shift() || [];
      for (const r of cells) {
        const rest = r.slice(1).map((c, j) => (r.length > 2 && head[j + 1] ? `${inline(head[j + 1])} ${inline(c)}` : inline(c))).filter((x) => x.trim());
        out.push(`▫️ <b>${inline(r[0])}</b>${rest.length ? '\n    ' + rest.join(' · ') : ''}`);
      }
      continue;
    }
    if ((m = /^#{1,6}\s+(.*)/.exec(l))) { out.push('', `<b>${inline(m[1])}</b>`); continue; }
    if ((m = /^(\s*)[-*]\s+(.*)/.exec(l))) { out.push(`${m[1].length >= 2 ? '    ◦ ' : '• '}${inline(m[2])}`); continue; }
    if ((m = /^(\s*)(\d+)\.\s+(.*)/.exec(l))) { out.push(`${m[1].length >= 2 ? '    ' : ''}${m[2]}. ${inline(m[3])}`); continue; }
    if (/^\s*>\s?(.*)/.test(l)) { out.push(`┃ ${inline(l.replace(/^\s*>\s?/, ''))}`); continue; }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(l)) { out.push(''); continue; }
    out.push(inline(l));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/@@B(\d+)@@/g, (_, n) => blocks[n]).trim();
}
function pages(html, size = 2500) {
  const parts = html.split(/\n\n/), out = [];
  let cur = '';
  for (const p of parts) {
    if (cur && (cur + '\n\n' + p).length > size) { out.push(cur); cur = p; } else cur = cur ? cur + '\n\n' + p : p;
    while (cur.length > size + 800 && !cur.includes('<pre>')) { out.push(cur.slice(0, size)); cur = cur.slice(size); }
  }
  if (cur) out.push(cur);
  return out.length ? out : [T().empty];
}
const plainOf = (html) => html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').slice(0, 4000);
async function sendHtml(chat, html, extra = {}) {
  try { return await tg('sendMessage', { chat_id: chat, text: html, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra }); }
  catch (e) { log('html fallback', e.message); return tg('sendMessage', { chat_id: chat, text: plainOf(html), ...extra }); } // broken markup → plain text
}
async function editHtml(chat, id, html, markup) {
  try { return await tg('editMessageText', { chat_id: chat, message_id: id, text: html, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: markup }); }
  catch (e) { if (/not modified/.test(e.message)) return null; return tg('editMessageText', { chat_id: chat, message_id: id, text: plainOf(html), reply_markup: markup }).catch(() => null); }
}
// paged message: {head, pages, tail, rows}; the ◀ ▶ buttons edit it in place
const docs = new Map();
const docKey = () => Math.random().toString(36).slice(2, 8);
function docView(id, n) {
  const d = docs.get(id), N = d.pages.length;
  const text = `${d.head ? d.head + '\n\n' : ''}${d.pages[n]}${n === N - 1 && d.tail ? '\n\n' + d.tail : ''}`;
  const rows = [];
  if (N > 1) rows.push([{ text: n > 0 ? '◀' : ' ', callback_data: n > 0 ? `doc:${id}:${n - 1}` : 'nop:' }, { text: `${n + 1} / ${N}`, callback_data: 'nop:' }, { text: n < N - 1 ? '▶' : ' ', callback_data: n < N - 1 ? `doc:${id}:${n + 1}` : 'nop:' }]);
  return { text, markup: { inline_keyboard: [...rows, ...(d.rows || [])] } };
}
async function sendDoc(chat, { head = '', body = '', tail = '', rows = [] }) {
  const id = docKey();
  docs.set(id, { head, pages: pages(body || T().empty), tail, rows }); setTimeout(() => docs.delete(id), 24 * 3600e3);
  const v = docView(id, 0);
  return sendHtml(chat, v.text, { reply_markup: v.markup });
}
const send = (chat, html, extra = {}) => (html.length > 3800 ? sendDoc(chat, { body: html, rows: extra.reply_markup?.inline_keyboard || [] }) : sendHtml(chat, html, extra));
const short = (t, n = 26) => { t = String(t || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const size = (b) => (b >= 1 << 20 ? `${(b / (1 << 20)).toFixed(1)}MB` : `${Math.max(1, Math.round(b / 1024))}KB`);
const clock = (ms) => { const s = Math.round(ms / 1000); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const ago = (ms) => { const m = Math.round((Date.now() - ms) / 60e3); return m < 1 ? 'now' : m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`; };

// ---------- Claude Code sessions on this PC (read from ~/.claude) ----------
const dirs = (p) => { try { return fs.readdirSync(p); } catch { return []; } };
// open interactive sessions: sessionId → {pid, status}
function liveSessions() {
  const out = new Map();
  for (const f of dirs(LIVE).filter((x) => /^\d+\.json$/.test(x))) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(LIVE, f), 'utf8'));
      if (s.kind && s.kind !== 'interactive') continue;
      process.kill(s.pid, 0);
      out.set(s.sessionId, { pid: s.pid, status: s.status || 'idle' });
    } catch {}
  }
  return out;
}
function readPart(file, start, len) {
  const fd = fs.openSync(file, 'r');
  try { const b = Buffer.alloc(len); const n = fs.readSync(fd, b, 0, len, start); return b.slice(0, n).toString('utf8'); } finally { fs.closeSync(fd); }
}
const userText = (e) => {
  const c = e.message?.content;
  const t = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x) => x.type === 'text').map((x) => x.text).join(' ') : '';
  return /^<(command|local-command|system-reminder)|^\[Request interrupted|^Caveat:/.test(t.trim()) ? '' : t.replace(/^\[Telegram\]\s*/, '');
};
// per-file facts (folder, first prompt, title, how it was started), cached on disk; a grown file only
// has its tail re-read for a newer title
const META_FILE = path.join(DATA, 'meta-cache.json');
let metaCache = new Map(), metaDirty = false;
try { metaCache = new Map(Object.entries(JSON.parse(fs.readFileSync(META_FILE, 'utf8')))); } catch {}
setInterval(() => { if (!metaDirty) return; metaDirty = false; try { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(META_FILE, JSON.stringify(Object.fromEntries(metaCache))); } catch {} }, 30000).unref();
const lastStr = (text, key) => { const re = new RegExp(String.raw`"${key}":"((?:[^"\\]|\\.)*)"`, 'g'); let m, v = ''; while ((m = re.exec(text))) v = m[1]; try { return v && JSON.parse(`"${v}"`); } catch { return v; } };
function metaOf(file, st) {
  const c = metaCache.get(file);
  if (c && c.size === st.size) return c;
  const meta = c ? { ...c } : { cwd: null, first: '', title: '', entry: '' };
  if (!c) for (const line of readPart(file, 0, 32768).split('\n')) {
    try {
      const e = JSON.parse(line);
      if (!meta.cwd && e.cwd) meta.cwd = e.cwd;
      if (!meta.entry && e.entrypoint) meta.entry = e.entrypoint;
      if (!meta.first && e.type === 'user') meta.first = short(userText(e), 120);
    } catch {}
    if (meta.cwd && meta.first && meta.entry) break;
  }
  const tail = readPart(file, Math.max(0, st.size - 65536), 65536);
  meta.title = lastStr(tail, 'customTitle') || lastStr(tail, 'aiTitle') || meta.title;
  if (!meta.cwd) meta.cwd = lastStr(tail, 'cwd') || null;
  meta.size = st.size;
  metaCache.set(file, meta); metaDirty = true;
  return meta;
}
// Which conversations exist: Claude Code logs every prompt a person types to ~/.claude/history.jsonl
// ({display, project, sessionId, timestamp}), so recent sessions come from its tail instead of a scan of
// thousands of transcript files (most of them automated `claude -p` runs). Sessions this relay started
// (st.mine) are added. Only the candidates' transcripts are touched.
const HISTORY = path.join(HOME, 'history.jsonl');
let histCache = { size: -1, bySid: new Map() };
function history() {
  let size = 0; try { size = fs.statSync(HISTORY).size; } catch { return histCache.bySid; }
  if (size === histCache.size) return histCache.bySid;
  const bySid = new Map();
  for (const line of readPart(HISTORY, Math.max(0, size - (6 << 20)), Math.min(size, 6 << 20)).split('\n')) {
    try {
      const h = JSON.parse(line);
      if (!h.sessionId) continue;
      const e = bySid.get(h.sessionId) || { cwd: h.project, last: 0, prompts: [] };
      e.last = Math.max(e.last, h.timestamp || 0); e.cwd = h.project || e.cwd;
      if (h.display) e.prompts.push(String(h.display).slice(0, 300));
      bySid.set(h.sessionId, e);
    } catch {}
  }
  histCache = { size, bySid };
  return bySid;
}
let fileIndex = { at: 0, map: new Map() }; // sid → transcript path (directory listings only, no stat)
function fileOf(sid) {
  if (!fileIndex.map.has(sid) && Date.now() - fileIndex.at > 5000) {
    const map = new Map();
    for (const d of dirs(PROJECTS)) for (const f of dirs(path.join(PROJECTS, d))) if (f.endsWith('.jsonl')) map.set(f.slice(0, -6), path.join(PROJECTS, d, f));
    fileIndex = { at: Date.now(), map };
  }
  return fileIndex.map.get(sid) || null;
}
// {sid, file, cwd, title, prompts, mtime, live, mine}, newest first; keep(s) filters
function sessions(n = 40, keep = () => true) {
  const live = liveSessions(), mine = new Set(st.mine || []), h = history();
  const cand = new Map([...h].map(([sid, e]) => [sid, e.last]));
  for (const sid of [...mine].slice(0, 60)) if (!cand.has(sid)) { const f = fileOf(sid); try { cand.set(sid, fs.statSync(f).mtimeMs); } catch {} }
  for (const sid of live.keys()) if (!cand.has(sid)) cand.set(sid, Date.now());
  const out = [];
  for (const [sid] of [...cand].sort((a, b) => b[1] - a[1])) {
    if (out.length >= n) break;
    const s = sessionAt(sid, live, mine, h);
    if (s && keep(s)) out.push(s);
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}
function sessionAt(sid, live = liveSessions(), mine = new Set(st.mine || []), h = history()) {
  const file = fileOf(sid);
  if (!file) return null;
  let fst; try { fst = fs.statSync(file); } catch { return null; }
  const meta = metaOf(file, fst), he = h.get(sid);
  const cwd = meta.cwd || he?.cwd;
  if (!cwd) return null;
  return { sid, file, cwd, title: meta.title || meta.first || he?.prompts[0] || sid.slice(0, 8), first: meta.first, prompts: he?.prompts || [],
    mtime: fst.mtimeMs, live: live.get(sid) || null, mine: mine.has(sid) };
}
const findSession = (sid) => sessionAt(sid);
// transcript entries from byte offset `from` (complete lines only)
function entriesFrom(file, from) {
  let st; try { st = fs.statSync(file); } catch { return { end: from, items: [] }; }
  if (st.size <= from) return { end: st.size, items: [] };
  const fd = fs.openSync(file, 'r'), raw = Buffer.alloc(st.size - from);
  try { fs.readSync(fd, raw, 0, raw.length, from); } finally { fs.closeSync(fd); }
  const cut = raw.lastIndexOf(10);
  const items = [];
  for (const line of raw.slice(0, cut + 1).toString('utf8').split('\n')) { if (!line.trim()) continue; try { items.push(JSON.parse(line)); } catch {} }
  return { end: from + cut + 1, items };
}
const textOf = (msg) => (Array.isArray(msg?.content) ? msg.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim() : '');
function recentMessages(file, n = 6) {
  const st = fs.statSync(file), out = [];
  for (const line of readPart(file, Math.max(0, st.size - 524288), 524288).split('\n')) {
    try {
      const e = JSON.parse(line);
      if (e.isSidechain) continue;
      if (e.type === 'user') { const t = userText(e).trim(); if (t) out.push({ role: 'user', text: t }); }
      if (e.type === 'assistant') { const t = textOf(e.message); if (t) out.push({ role: 'assistant', text: t }); }
    } catch {}
  }
  return out.slice(-n);
}

// ---------- output files ----------
const SEND_EXT = /\.(pdf|png|jpe?g|gif|webp|svg|bmp|mp4|mov|webm|m4v|mp3|wav|m4a|docx?|xlsx?|pptx?|hwpx?|csv|zip|html?|glb|ply|stl)$/i;
const TEXT_EXT = /\.(md|txt|json|log|tex|py|ya?ml)$/i;
const PIC = /\.(jpe?g|png|webp)$/i;
// files written by tools (Write / Edit / NotebookEdit), plus existing paths named in the answer
function outputsIn(items, answer, cwd) {
  const found = new Set();
  for (const e of items) for (const c of (e.type === 'assistant' && Array.isArray(e.message?.content) ? e.message.content : [])) {
    const p = c.type === 'tool_use' && (c.input?.file_path || c.input?.notebook_path);
    if (p && SEND_EXT.test(p)) found.add(path.resolve(cwd || '.', p));
  }
  const re = /(?:[A-Za-z]:[\\/]|\/)[^\s"'`<>|*?()[\]{}]+?\.[A-Za-z0-9]{2,5}\b|`([^`\n]+\.[A-Za-z0-9]{2,5})`/g;
  let m;
  while ((m = re.exec(answer || ''))) {
    const p = (m[1] || m[0]).replace(/^\/([a-z])\//i, (x, d) => `${d.toUpperCase()}:\\`);
    const abs = path.resolve(cwd || '.', p);
    if (SEND_EXT.test(p) || (TEXT_EXT.test(p) && cwd && abs.toLowerCase().startsWith(path.resolve(cwd).toLowerCase() + path.sep))) found.add(abs);
  }
  return [...found].filter((p) => { try { return fs.statSync(p).isFile() && !p.startsWith(INBOX); } catch { return false; } });
}
async function sendFile(chat, file) {
  let st; try { st = fs.statSync(file); } catch { return send(chat, `❓ ${T().noFile}\n<code>${esc(file)}</code>`); }
  if (st.size > 50 << 20) return send(chat, `📦 ${esc(T().tooBig(path.basename(file)))} (${size(st.size)})\n<code>${esc(file)}</code>`);
  const ext = path.extname(file).slice(1).toLowerCase(), cap = path.basename(file);
  await tg('sendChatAction', { chat_id: chat, action: PIC.test(file) ? 'upload_photo' : 'upload_document' }).catch(() => {});
  try {
    if (PIC.test(file) && st.size < 10 << 20) return await tgUpload('sendPhoto', { chat_id: String(chat), caption: cap }, { photo: file });
    if (/^(mp4|m4v)$/.test(ext)) return await tgUpload('sendVideo', { chat_id: String(chat), caption: cap, supports_streaming: 'true' }, { video: file });
    return await tgUpload('sendDocument', { chat_id: String(chat), caption: cap }, { document: file });
  } catch (e) {
    log('send file', file, e.message);
    if (!/sendDocument/.test(e.message)) return tgUpload('sendDocument', { chat_id: String(chat), caption: cap }, { document: file }).catch((e2) => send(chat, `❌ ${esc(e2.message)}`));
    return send(chat, `❌ ${esc(e.message)}`);
  }
}
// pictures go out as one album (2–10), everything else one by one
async function sendFiles(chat, files) {
  const pics = files.filter((p) => PIC.test(p) && fs.statSync(p).size < 10 << 20);
  if (pics.length >= 2) {
    for (let i = 0; i < pics.length; i += 10) {
      const group = pics.slice(i, i + 10);
      await tg('sendChatAction', { chat_id: chat, action: 'upload_photo' }).catch(() => {});
      await tgUpload('sendMediaGroup', { chat_id: String(chat), media: group.map((p, j) => ({ type: 'photo', media: `attach://f${j}`, caption: path.basename(p) })) },
        Object.fromEntries(group.map((p, j) => [`f${j}`, p]))).catch(async (e) => { log('album', e.message); for (const p of group) await sendFile(chat, p); });
    }
  }
  for (const p of files.filter((x) => !pics.includes(x) || pics.length < 2)) await sendFile(chat, p);
}
const sentFiles = new Map(); // chat → Set(path) already sent
async function sendOutputs(chat, files) {
  const sent = sentFiles.get(chat) || new Set(); sentFiles.set(chat, sent);
  const todo = files.filter((p) => !sent.has(p.toLowerCase()));
  const max = CFG.autoSendFiles ?? 6, now = todo.slice(0, max);
  for (const p of now) sent.add(p.toLowerCase());
  await sendFiles(chat, now);
  return todo.length - now.length;
}

// ---------- state ----------
// chats: { [chatId]: { sid, cwd, follow, isNew, pinId, searching } }
let st = { offset: 0, chats: {} };
try { st = { ...st, ...JSON.parse(fs.readFileSync(STATE, 'utf8')) }; } catch {}
const save = () => { try { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(st, null, 1)); } catch {} };
const chatOf = (chat) => (st.chats[chat] = st.chats[chat] || { sid: null, cwd: null, follow: true });
const allowed = (id) => (CFG.allowed || []).map(String).includes(String(id));
const keyboard = () => { const t = T(); return { keyboard: [[{ text: t.pick }, { text: t.files }], [{ text: t.stop }, { text: t.settings }]], resize_keyboard: true, is_persistent: true, input_field_placeholder: '💬' }; };
const folder = (cwd) => short(path.basename(cwd || '') || cwd, 22);
const titleOf = (s) => short(s.title || folder(s.cwd), 40);

// ---------- 📌 the session card (pinned at the top of the chat) ----------
function cardOf(chat) {
  const c = chatOf(chat), t = T(), s = c.sid && findSession(c.sid);
  const rows = [[{ text: t.recent, callback_data: 'rec:' }, { text: t.files, callback_data: 'fil:' }, { text: t.change, callback_data: 'tab:r:0' }]];
  if (s) return { text: [`📌 <b>${esc(titleOf(s))}</b>`, `📁 <code>${esc(s.cwd)}</code>`, `${s.live ? '🟢' : '⚪'} ${esc(t.card)}`].join('\n'), markup: { inline_keyboard: rows } };
  if (c.isNew) return { text: [`📌 <b>${esc(t.newCard)}</b>`, `📁 <code>${esc(c.cwd)}</code>`, esc(t.newHint)].join('\n'), markup: { inline_keyboard: [[{ text: t.change, callback_data: 'tab:r:0' }]] } };
  return null;
}
async function postCard(chat) {
  const c = chatOf(chat), card = cardOf(chat);
  if (!card) return;
  if (c.pinId) await tg('unpinChatMessage', { chat_id: chat, message_id: c.pinId }).catch(() => {});
  const m = await sendHtml(chat, card.text, { reply_markup: card.markup });
  c.pinId = m.message_id; save();
  await tg('pinChatMessage', { chat_id: chat, message_id: m.message_id, disable_notification: true }).catch(() => {});
}
const refreshCard = (chat) => { const c = chatOf(chat), card = cardOf(chat); if (c.pinId && card) editHtml(chat, c.pinId, card.text, card.markup); };

// ---------- 📋 picking a session: tabs Recent / Open / Folders / Search ----------
const PAGE = 7;
const lists = new Map(); // chat → {folders: [cwd], search: query, newDirs: [cwd]}
const memo = (chat) => (lists.get(chat) || (lists.set(chat, {}), lists.get(chat)));
function tabsRow(active) {
  const t = T(), tab = (k, label) => ({ text: active === k ? `· ${label} ·` : label, callback_data: k === 's' ? 'srch:' : `tab:${k}:0` });
  return [tab('r', t.tabRecent), tab('o', t.tabOpen), tab('f', t.tabFolders), tab('s', t.tabSearch)];
}
async function pickMenu(chat, view = 'r', page = 0, editId = null) {
  const c = chatOf(chat), t = T(), mem = memo(chat);
  let ss, title = `📋 <b>${t.pickTitle}</b>`, extra = [];
  if (view === 'f') { // folder list
    const seen = new Map();
    for (const [, e] of [...history()].sort((x, y) => y[1].last - x[1].last)) { if (!e.cwd) continue; const k = e.cwd.toLowerCase(); if (!seen.has(k)) seen.set(k, { cwd: e.cwd, n: 0, mtime: e.last }); seen.get(k).n++; }
    mem.folders = [...seen.values()].slice(0, 40);
    const N = Math.max(1, Math.ceil(mem.folders.length / PAGE)); page = Math.min(Math.max(0, page), N - 1);
    const rows = mem.folders.slice(page * PAGE, page * PAGE + PAGE).map((f, i) => [{ text: `📁 ${folder(f.cwd)} · ${f.n} · ${ago(f.mtime)}`, callback_data: `fd:${page * PAGE + i}:0` }]);
    return show(chat, editId, `📁 <b>${t.foldersTitle}</b>`, [tabsRow('f'), ...rows, navRow(`tab:f`, page, N)]);
  }
  if (view === 'o') ss = sessions(40, (s) => !!s.live);
  else if (view === 's') { const q = (mem.search || '').toLowerCase(); ss = sessions(40, (s) => `${s.title} ${s.first} ${s.cwd} ${s.prompts.join(' ')}`.toLowerCase().includes(q)); title = `🔎 <b>${esc(t.searchTitle(mem.search))}</b>`; }
  else if (view.startsWith('d')) { const f = mem.folders?.[Number(view.slice(1))]; if (!f) return send(chat, t.expired); ss = sessions(40, (s) => s.cwd.toLowerCase() === f.cwd.toLowerCase()); title = `📁 <b>${esc(folder(f.cwd))}</b>`; extra = [[{ text: t.newHere, callback_data: `nd:${view.slice(1)}` }]]; }
  else ss = sessions(PAGE * 5);
  const N = Math.max(1, Math.ceil(ss.length / PAGE)); page = Math.min(Math.max(0, page), N - 1);
  const rows = ss.slice(page * PAGE, page * PAGE + PAGE).map((s) => [{
    text: `${c.sid === s.sid ? '✅' : s.live ? '🟢' : s.mine ? '📱' : '⚪'} ${short(s.title, 24)} · ${ago(s.mtime)}${view.startsWith('d') ? '' : ` · ${folder(s.cwd)}`}`, callback_data: `sel:${s.sid}` }]);
  const head = [title, ss.length ? `<i>${t.legend}</i>` : t.noSessions].join('\n');
  return show(chat, editId, head, [tabsRow(view.startsWith('d') ? 'f' : view), ...rows, navRow(view.startsWith('d') ? `fd:${view.slice(1)}` : `tab:${view}`, page, N),
    ...extra, ...(view === 'r' ? [[{ text: t.newChat, callback_data: 'new:' }]] : [])]);
}
const navRow = (prefix, page, N) => [
  ...(page > 0 ? [{ text: '◀', callback_data: `${prefix}:${page - 1}` }] : []),
  ...(N > 1 ? [{ text: `${page + 1} / ${N}`, callback_data: 'nop:' }] : []),
  { text: T().refresh, callback_data: `${prefix}:${page}` },
  ...(page < N - 1 ? [{ text: '▶', callback_data: `${prefix}:${page + 1}` }] : [])];
function show(chat, editId, text, rows) {
  const markup = { inline_keyboard: rows };
  return editId ? editHtml(chat, editId, text, markup) : sendHtml(chat, text, { reply_markup: markup });
}
async function select(chat, sid, msgId) {
  const t = T(), s = findSession(sid);
  if (!s) return send(chat, t.gone);
  const c = chatOf(chat); c.sid = s.sid; c.cwd = s.cwd; c.isNew = false; save();
  watchers.delete(chat);
  if (msgId) await tg('deleteMessage', { chat_id: chat, message_id: msgId }).catch(() => {});
  await postCard(chat);
  const last = recentMessages(s.file, 8).filter((m) => m.role === 'assistant').pop();
  const lines = [];
  if (s.live) lines.push(`🟢 <i>${esc(t.liveNote)}</i>`);
  if (last) lines.push(`<b>${t.lastAnswer}</b>\n<blockquote expandable>${mdToTg(short(last.text, 1500))}</blockquote>`);
  if (lines.length) await sendHtml(chat, lines.join('\n\n'), { reply_markup: keyboard() });
}
async function newMenu(chat, editId) {
  const t = T(), mem = memo(chat), seen = new Set(), list = [];
  for (const s of sessions(120)) { const k = s.cwd.toLowerCase(); if (!seen.has(k) && fs.existsSync(s.cwd)) { seen.add(k); list.push(s.cwd); } if (list.length >= 8) break; }
  mem.newDirs = list;
  return show(chat, editId, `➕ <b>${t.newFolder}</b>`, [...list.map((p, i) => [{ text: `📁 ${short(p, 40)}`, callback_data: `dir:${i}` }]), [{ text: '◀', callback_data: 'tab:r:0' }]]);
}
async function startNew(chat, cwd, msgId) {
  const c = chatOf(chat); c.sid = null; c.cwd = cwd; c.isNew = true; save(); watchers.delete(chat);
  if (msgId) await tg('deleteMessage', { chat_id: chat, message_id: msgId }).catch(() => {});
  return postCard(chat);
}
async function recent(chat) {
  const c = chatOf(chat), s = c.sid && findSession(c.sid);
  if (!s) return pickMenu(chat);
  const ms = recentMessages(s.file, 6);
  return sendDoc(chat, { head: `📜 <b>${T().recentTitle}</b> · ${esc(titleOf(s))}`,
    body: ms.map((m) => (m.role === 'user' ? `🧑 <b>${esc(short(m.text, 300))}</b>` : `🤖 ${mdToTg(short(m.text, 900))}`)).join('\n\n') });
}
async function filesMenu(chat) {
  const c = chatOf(chat), s = c.sid && findSession(c.sid), t = T();
  if (!s) return pickMenu(chat);
  const { items } = entriesFrom(s.file, Math.max(0, fs.statSync(s.file).size - (8 << 20)));
  const files = outputsIn(items, items.map((e) => textOf(e.message)).join('\n'), s.cwd)
    .map((p) => ({ p, st: fs.statSync(p) })).sort((a, b) => b.st.mtimeMs - a.st.mtimeMs).slice(0, 10);
  if (!files.length) return send(chat, `📂 <b>${esc(titleOf(s))}</b>\n${t.noOutputs}`);
  memo(chat).files = files.map((f) => f.p);
  const icon = (p) => (/\.pdf$/i.test(p) ? '📄' : /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(p) ? '🖼' : /\.(mp4|mov|webm|m4v)$/i.test(p) ? '🎬' : /\.(mp3|wav|m4a)$/i.test(p) ? '🎵' : /\.(docx?|hwpx?)$/i.test(p) ? '📝' : /\.(xlsx?|csv)$/i.test(p) ? '📊' : /\.pptx?$/i.test(p) ? '📽' : '📦');
  return sendHtml(chat, `📂 <b>${esc(titleOf(s))}</b>\n<i>${t.outputsOf(files.length)}</i>`,
    { reply_markup: { inline_keyboard: files.map((f, i) => [{ text: `${icon(f.p)} ${short(path.basename(f.p), 30)} · ${size(f.st.size)} · ${ago(f.st.mtimeMs)}`, callback_data: `art:${i}` }]) } });
}
// ⚙ settings: one message, every option a button, edited in place
function settingsView() {
  const t = T(), mark = (on, label) => (on ? `● ${label}` : label);
  const pm = CFG.permissionMode || 'acceptEdits', md = CFG.model || '', sy = CFG.style || 'phone';
  const text = [`⚙ <b>${t.setTitle}</b>`, '', `<b>${t.setPerm}</b>\n<i>${esc(t.setPermHelp)}</i>`, '', `<b>${t.setModel}</b> · <b>${t.setStyle}</b>`].join('\n');
  return { text, rows: [
    Object.entries(t.perms).map(([k, v]) => ({ text: mark(pm === k, v), callback_data: `set:pm:${k}` })),
    Object.entries(t.models).map(([k, v]) => ({ text: mark(md === k, v), callback_data: `set:md:${k}` })),
    Object.entries(t.styles).map(([k, v]) => ({ text: mark(sy === k, v), callback_data: `set:sy:${k}` })),
  ] };
}
const settingsRows = (chat) => { const t = T(), c = chatOf(chat), v = settingsView(); return [[{ text: `${c.follow ? '🔔' : '🔕'} ${t.setFollow}: ${c.follow ? t.on : t.off}`, callback_data: 'set:fo:' }], ...v.rows]; };
const settingsText = () => `${settingsView().text}\n\n<i>🔔 ${esc(T().setFollowHelp)}</i>`;

// ---------- running a turn: claude -p --resume <sid> ----------
let claudeBin = null;
function findClaude() {
  if (claudeBin) return claudeBin;
  if (CFG.claude) return (claudeBin = CFG.claude);
  const cands = [];
  try { cands.push(...execFileSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/).filter(Boolean)); } catch {}
  cands.push(path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude'));
  claudeBin = cands.find((p) => /\.exe$/i.test(p) && fs.existsSync(p)) || cands.find((p) => fs.existsSync(p)) || 'claude';
  return claudeBin;
}
function startClaude(args, cwd) {
  const bin = findClaude();
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin)) { // npm shim: through cmd.exe, arguments quoted by hand
    const q = (a) => (/^[\w:.\\/=-]+$/.test(a) ? a : `"${String(a).replace(/"/g, '""')}"`);
    return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${[q(bin), ...args.map(q)].join(' ')}"`], { cwd, windowsHide: true, windowsVerbatimArguments: true });
  }
  return spawn(bin, args, { cwd, windowsHide: true });
}
function killTree(p) {
  if (!p || p.exitCode != null) return;
  if (process.platform === 'win32') { try { execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {} }
  else try { p.kill('SIGTERM'); } catch {}
}
const runs = new Map(); // chat → {proc, queue: [text], progressId, stopped}
const NOTE_FILE = () => { const f = path.join(DATA, `note.${LANG()}.txt`); try { if (fs.readFileSync(f, 'utf8') === T().note) return f; } catch {} fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(f, T().note); return f; };
const TOOL_ICON = { Bash: '💻', PowerShell: '💻', Read: '📖', Write: '✏️', Edit: '✏️', NotebookEdit: '✏️', Grep: '🔎', Glob: '🔎', WebSearch: '🌐', WebFetch: '🌐', Task: '🤖', Agent: '🤖', TodoWrite: '🗒' };
const toolLine = (c) => {
  const i = c.input || {};
  let what = i.description || i.file_path || i.command || i.pattern || i.url || i.query || i.prompt || '';
  if (i.file_path) what = path.basename(i.file_path);
  return `${TOOL_ICON[c.name] || '⚙'} ${c.name}${what ? ' · ' + short(String(what).split('\n')[0], 44) : ''}`;
};
async function relay(chat, text) {
  const c = chatOf(chat);
  if (!c.sid && !c.isNew) { await send(chat, T().pickFirst); return pickMenu(chat); }
  const r = runs.get(chat);
  if (r) { r.queue.push(text); r.render?.(true); return null; }
  return runTurn(chat, text);
}
async function runTurn(chat, text) {
  const c = chatOf(chat), t = T();
  const s = c.sid ? findSession(c.sid) : null;
  if (c.sid && !s) { c.sid = null; save(); return send(chat, t.gone); }
  const cwd = s?.cwd || c.cwd;
  if (!cwd || !fs.existsSync(cwd)) return send(chat, `❌ ${esc(cwd || '?')}`);
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', CFG.permissionMode || 'acceptEdits'];
  if (CFG.style !== 'raw') args.push('--append-system-prompt-file', NOTE_FILE());
  if (CFG.model) args.push('--model', CFG.model);
  let forked = false;
  if (s) { args.push('--resume', s.sid); if (s.live) { args.push('--fork-session'); forked = true; } }
  const run = { proc: null, queue: [], progressId: null, stopped: false, started: Date.now() };
  runs.set(chat, run);
  const steps = [];
  // the progress card: elapsed time, the last few steps, queued messages, ⏹
  let lastEdit = 0;
  const cardText = () => [`⏳ <b>${t.working}</b> · ${clock(Date.now() - run.started)}${forked ? `\n<i>${esc(t.forked)}</i>` : ''}`,
    ...steps.slice(-5).map((x, i, a) => `${i === a.length - 1 ? '▸' : '✓'} ${esc(x)}`), run.queue.length ? `\n📨 ${esc(t.queued(run.queue.length))}` : ''].filter(Boolean).join('\n');
  const stopBtn = { inline_keyboard: [[{ text: t.stop, callback_data: 'stop:' }]] };
  run.render = (force) => {
    if (!run.progressId || (!force && Date.now() - lastEdit < 2500)) return;
    lastEdit = Date.now();
    editHtml(chat, run.progressId, cardText(), stopBtn);
  };
  const prog = await sendHtml(chat, cardText(), { reply_markup: stopBtn }).catch(() => null);
  run.progressId = prog?.message_id;
  const proc = startClaude(args, cwd);
  run.proc = proc;
  proc.stdin.end(`[Telegram] ${text}`);
  let buf = '', sid = s?.sid || null, result = null, lastText = '';
  const items = [];
  const tick = setInterval(() => { tg('sendChatAction', { chat_id: chat, action: 'typing' }).catch(() => {}); run.render(); }, 5000);
  const limit = setTimeout(() => { run.stopped = true; killTree(proc); }, (CFG.maxTurnMinutes || 60) * 60e3);
  proc.stdout.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (e.session_id) sid = e.session_id;
      if (e.type === 'assistant' && !e.parent_tool_use_id) {
        items.push(e);
        for (const x of e.message?.content || []) { if (x.type === 'tool_use') steps.push(toolLine(x)); if (x.type === 'text' && x.text.trim()) lastText = x.text; }
        run.render();
      }
      if (e.type === 'result') result = e;
    }
  });
  let err = '';
  proc.stderr.on('data', (d) => { err = (err + d.toString('utf8')).slice(-2000); });
  await new Promise((ok) => { proc.on('close', ok); proc.on('error', (e) => { err += e.message; ok(); }); });
  clearInterval(tick); clearTimeout(limit);
  if (run.progressId) await tg('deleteMessage', { chat_id: chat, message_id: run.progressId }).catch(() => {});
  if (sid) { st.mine = [...new Set([sid, ...(st.mine || [])])].slice(0, 500); }
  if (sid && sid !== c.sid) { c.sid = sid; c.isNew = false; c.cwd = cwd; refreshCard(chat); }
  save();
  const w = watchers.get(chat); if (w && sid) { w.sid = sid; w.offset = fileSize(sid); w.pending = []; }
  log('turn end', sid, w ? w.offset : '-', run.stopped ? 'stopped' : result?.subtype || 'no result');
  const answer = result?.result || lastText;
  const elapsed = clock(Date.now() - run.started);
  const files = outputsIn(items, answer, cwd);
  const stepsQuote = steps.length ? `<blockquote expandable>${esc(t.steps(steps.length))}\n${steps.map(esc).join('\n')}</blockquote>` : '';
  let head, body;
  if (run.stopped) { head = `⏹ <b>${t.stopped}</b> · ${elapsed}`; body = answer ? mdToTg(shortenPaths(answer, cwd)) : ''; }
  else if (result && !result.is_error) { head = `💬 <b>${esc(titleOf(findSession(sid) || { cwd }))}</b> · ${elapsed}`; body = answer ? mdToTg(shortenPaths(answer, cwd)) : t.noAnswer; }
  else { head = `❌ <b>${t.failed}</b> · ${elapsed}`; body = `${mdToTg(answer || '')}\n<code>${esc(short(err || result?.subtype || '', 600))}</code>`; }
  runs.delete(chat);
  const rest = await deliver(chat, { head, body, tail: stepsQuote, files, quick: !run.stopped });
  if (run.queue.length) return runTurn(chat, run.queue.join('\n\n'));
  return rest;
}
// answer (paged, steps folded, quick replies) then its files
async function deliver(chat, { head, body, tail, files, quick }) {
  const t = T(), sent = sentFiles.get(chat) || new Set();
  const fresh = files.filter((p) => !sent.has(p.toLowerCase()));
  const rows = [];
  if (quick) rows.push(t.quick.map(([label], i) => ({ text: label, callback_data: `qr:${i}` })));
  if (fresh.length > (CFG.autoSendFiles ?? 6)) rows.push([{ text: t.filesBtn(fresh.length), callback_data: 'fil:' }]);
  await sendDoc(chat, { head, body: body || ' ', tail, rows });
  await sendOutputs(chat, fresh);
}
// paths inside the session folder are shown relative: a phone has no room for C:\Users\…\project\…
function shortenPaths(text, cwd) {
  if (!text || !cwd) return text || '';
  const base = path.resolve(cwd).replace(/[\\/]+$/, '');
  const fwd = base.replace(/\\/g, '/');
  const prefixes = [base + '\\', base + '/', fwd + '/', fwd.replace(/^([A-Za-z]):/, (x, d) => `/${d.toLowerCase()}`) + '/'];
  let out = text;
  for (const pre of prefixes) {
    const low = pre.toLowerCase();
    let i;
    while ((i = out.toLowerCase().indexOf(low)) >= 0) out = out.slice(0, i) + out.slice(i + pre.length);
  }
  return out;
}
const fileSize = (sid) => { const s = findSession(sid); try { return fs.statSync(s.file).size; } catch { return 0; } };

// ---------- 🔔 turns run on the PC in the selected session ----------
// The transcript is followed by byte offset; a turn counts as finished when an assistant entry with
// stop_reason end_turn arrives and the file stays quiet for a few seconds.
const watchers = new Map(); // chat → {sid, offset, pending: [entries], quietSince}
async function follow() {
  for (const [chat, c] of Object.entries(st.chats)) {
    if (!c.follow || !c.sid || runs.has(chat)) continue;
    const s = findSession(c.sid);
    if (!s) continue;
    let w = watchers.get(chat);
    if (!w || w.sid !== c.sid) { w = { sid: c.sid, offset: fs.statSync(s.file).size, pending: [] }; watchers.set(chat, w); continue; }
    const { end, items } = entriesFrom(s.file, w.offset);
    w.offset = end;
    if (items.length) { w.pending.push(...items.filter((e) => e.type === 'assistant' && !e.isSidechain)); w.quietSince = Date.now(); }
    const done = w.pending.length && w.pending.some((e) => e.message?.stop_reason === 'end_turn') && Date.now() - w.quietSince > 4000;
    if (!done) continue;
    const texts = w.pending.map((e) => textOf(e.message)).filter(Boolean), answer = texts[texts.length - 1];
    const steps = w.pending.flatMap((e) => (e.message?.content || []).filter((x) => x.type === 'tool_use').map(toolLine));
    const files = outputsIn(w.pending, answer, s.cwd);
    log('pc turn', c.sid, w.offset, w.pending.length);
    w.pending = [];
    if (!answer && !files.length) continue;
    await deliver(chat, { head: `🔔 <b>${esc(titleOf(s))}</b> · PC`, body: answer ? mdToTg(shortenPaths(answer, s.cwd)) : '', files, quick: true,
      tail: steps.length ? `<blockquote expandable>${esc(T().steps(steps.length))}\n${steps.map(esc).join('\n')}</blockquote>` : '' });
  }
}

// ---------- incoming ----------
const mediaOf = (m) => {
  const t = T();
  if (m.photo?.length) return { id: m.photo[m.photo.length - 1].file_id, kind: t.photo, ext: '.jpg', size: m.photo[m.photo.length - 1].file_size };
  for (const [k, kind, ext] of [['document', t.file, ''], ['video', t.video, '.mp4'], ['audio', t.audio, '.mp3'], ['voice', t.voice, '.ogg'], ['video_note', t.video, '.mp4'], ['animation', t.video, '.mp4']])
    if (m[k]) return { id: m[k].file_id, kind, name: m[k].file_name || null, ext, size: m[k].file_size };
  return null;
};
const albums = new Map();
function onMedia(m) {
  if (!m.media_group_id) return receive(String(m.chat.id), [m]);
  let g = albums.get(m.media_group_id);
  if (!g) { g = { items: [] }; albums.set(m.media_group_id, g); }
  g.items.push(m); clearTimeout(g.timer);
  g.timer = setTimeout(() => { albums.delete(m.media_group_id); receive(String(m.chat.id), g.items.sort((a, b) => a.message_id - b.message_id)).catch((e) => log('album', e.message)); }, 2500);
}
async function receive(chat, items) {
  const c = chatOf(chat), t = T();
  if (!c.sid && !c.isNew) { await send(chat, t.pickFirst); return pickMenu(chat); }
  const d = new Date(), pad = (x) => String(x).padStart(2, '0');
  const dir = path.join(INBOX, `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`);
  fs.mkdirSync(dir, { recursive: true });
  const paths = [], kinds = new Set();
  for (const m of items) {
    const md = mediaOf(m);
    if (md.size > 20 << 20) { await send(chat, `📦 ${esc(md.name || md.kind)}: ${t.tooBigIn}`); continue; }
    try {
      const { buf, filePath } = await tgDownload(md.id);
      const name = String(md.name || `telegram_${m.message_id}${md.ext || path.extname(filePath)}`).replace(/[\\/:*?"<>|\r\n]+/g, '_');
      let file = path.join(dir, `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}_${name}`);
      for (let i = 2; fs.existsSync(file); i++) file = file.replace(/(\.[^.\\/]*)?$/, `_${i}$1`);
      fs.writeFileSync(file, buf);
      paths.push(file); kinds.add(md.kind); log('received', file, buf.length);
    } catch (e) { log('receive', e.message); await send(chat, `❌ ${esc(e.message)}`); }
  }
  if (!paths.length) return;
  const caption = items.map((m) => m.caption).find(Boolean) || '';
  const what = `${[...kinds].join('·')} ${paths.length}`;
  await tg('setMessageReaction', { chat_id: chat, message_id: items[0].message_id, reaction: [{ type: 'emoji', emoji: '👀' }] }).catch(() => sendHtml(chat, esc(t.got(what))));
  return relay(chat, `${t.sentFiles(what, caption)}\n${paths.join('\n')}`);
}
async function onMessage(m) {
  const chat = String(m.chat.id), t = T(); // chat ids are strings everywhere (state keys)
  if (!allowed(m.from?.id)) return log('ignored user', m.from?.id);
  const c = chatOf(chat), mem = memo(chat);
  if (mediaOf(m)) return onMedia(m);
  const text = (m.text || '').trim();
  if (!text) return;
  if (mem.searching && !text.startsWith('/') && ![t.pick, t.files, t.stop, t.settings].includes(text)) { mem.searching = false; mem.search = text; return pickMenu(chat, 's'); }
  mem.searching = false;
  if (/^\/(start|help)\b/.test(text)) {
    await sendHtml(chat, t.help.join('\n').replace('{pick}', t.pick).replace('{files}', t.files).replace('{stop}', t.stop).replace('{settings}', t.settings), { reply_markup: keyboard() });
    return c.sid || c.isNew ? postCard(chat) : pickMenu(chat);
  }
  if (text === t.pick || text === '/sessions') return pickMenu(chat);
  if (text === t.files || text === '/files') return filesMenu(chat);
  if (text === t.settings || text === '/settings') return sendHtml(chat, settingsText(), { reply_markup: { inline_keyboard: settingsRows(chat) } });
  if (text === t.stop || text === '/stop') return stop(chat);
  if (/^\/\w+$/.test(text)) return send(chat, `❓ ${t.unknown}`, { reply_markup: keyboard() });
  tg('setMessageReaction', { chat_id: chat, message_id: m.message_id, reaction: [{ type: 'emoji', emoji: '👀' }] }).catch(() => {});
  return relay(chat, text);
}
function stop(chat) {
  const r = runs.get(chat);
  if (!r) return send(chat, T().nothingRunning);
  r.stopped = true; r.queue = []; killTree(r.proc);
  return null;
}
async function onCallback(q) {
  if (!allowed(q.from?.id)) return;
  const chat = String(q.message.chat.id), mid = q.message.message_id, [kind, a = '', b = ''] = String(q.data || '').split(':'), t = T(), mem = memo(chat);
  const toast = (text) => tg('answerCallbackQuery', { callback_query_id: q.id, text }).catch(() => {});
  if (kind !== 'set' && kind !== 'qr') await toast();
  if (kind === 'nop') return null;
  if (kind === 'doc') { const v = docs.has(a) && docView(a, Number(b)); return v ? editHtml(chat, mid, v.text, v.markup) : null; }
  if (kind === 'tab') return pickMenu(chat, a, Number(b), mid);
  if (kind === 'fd') return pickMenu(chat, `d${a}`, Number(b), mid);
  if (kind === 'nd') { const f = mem.folders?.[Number(a)]; return f ? startNew(chat, f.cwd, mid) : send(chat, t.expired); }
  if (kind === 'srch') { mem.searching = true; return tg('sendMessage', { chat_id: chat, text: `🔎 ${t.searchAsk}`, reply_markup: { force_reply: true, input_field_placeholder: '🔎' } }); }
  if (kind === 'sel') return select(chat, a, mid);
  if (kind === 'new') return newMenu(chat, mid);
  if (kind === 'dir') { const p = (mem.newDirs || [])[Number(a)]; return p ? startNew(chat, p, mid) : send(chat, t.expired); }
  if (kind === 'rec') return recent(chat);
  if (kind === 'fil') return filesMenu(chat);
  if (kind === 'art') { const p = (mem.files || [])[Number(a)]; return p ? sendFile(chat, p) : send(chat, t.expired); }
  if (kind === 'stop') return stop(chat);
  if (kind === 'qr') { const qr = t.quick[Number(a)]; await toast(qr?.[0]); return qr ? (await sendHtml(chat, `🧑 ${esc(qr[1])}`), relay(chat, qr[1])) : null; }
  if (kind === 'set') {
    const c = chatOf(chat);
    if (a === 'fo') { c.follow = !c.follow; save(); watchers.delete(chat); }
    if (a === 'pm' && t.perms[b]) CFG.permissionMode = b;
    if (a === 'md' && b in t.models) CFG.model = b || undefined;
    if (a === 'sy' && t.styles[b]) CFG.style = b;
    if (a !== 'fo') saveCfg();
    await toast('✓');
    return editHtml(chat, mid, settingsText(), { inline_keyboard: settingsRows(chat) });
  }
}

// ---------- setup: link a bot made with @BotFather to this PC ----------
async function setup() {
  const argv = process.argv.slice(3), flag = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const ask = (q) => new Promise((ok) => { const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); rl.question(q, (x) => { rl.close(); ok(x.trim()); }); });
  if (flag('--lang')) CFG.lang = flag('--lang');
  const t = T();
  try { const old = Number(fs.readFileSync(PIDF, 'utf8')); if (old) { process.kill(old, 0); console.log(t.running(old)); process.exit(1); } } catch {}
  let token = flag('--token') || (argv.includes('--new') ? null : CFG.token);
  if (!token) { console.log(t.setupIntro.join('\n')); token = await ask(t.token); }
  if (flag('--proxy')) CFG.proxy = flag('--proxy');
  CFG.token = token; agent = undefined;
  let me;
  try { me = await tg('getMe'); } catch (e) {
    console.log(t.badToken, e.message);
    if (!/Unauthorized|Not Found/.test(e.message)) console.log(t.netHint);
    process.exit(1);
  }
  await tg('deleteWebhook', {}).catch(() => {});
  const code = String(Math.floor(100000 + Math.random() * 900000));
  console.log(t.pairing(me.username, code).join('\n'));
  let offset = 0, paired = null;
  const until = Date.now() + 600e3;
  while (!paired && Date.now() < until) {
    const ups = await tg('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] }, 40000).catch(() => []);
    for (const u of ups) {
      offset = u.update_id + 1;
      const x = (u.message?.text || '').trim();
      if (x === code || x === `/start ${code}`) paired = u.message;
      else if (u.message) await tg('sendMessage', { chat_id: u.message.chat.id, text: t.sendCode }).catch(() => {});
    }
  }
  if (!paired) { console.log(t.timeout); process.exit(1); }
  await tg('getUpdates', { offset, timeout: 0 }).catch(() => {}); // consume, so the bot does not replay them
  CFG.allowed = [...new Set([...(CFG.allowed || []).map(String), String(paired.from.id)])];
  if (!CFG.lang && paired.from.language_code) CFG.lang = paired.from.language_code.startsWith('ko') ? 'ko' : 'en';
  const t2 = T();
  if (!CFG.permissionMode) {
    const pm = flag('--permission-mode') || (console.log(t2.perm.join('\n')), { 1: 'acceptEdits', 2: 'bypassPermissions', 3: 'plan' }[(await ask(t2.permAsk)) || '1']);
    CFG.permissionMode = pm || 'acceptEdits';
  }
  saveCfg();
  await setCommands();
  await tg('sendMessage', { chat_id: paired.chat.id, text: t2.linked, reply_markup: keyboard() }).catch(() => {});
  st.offset = offset; save();
  console.log(t2.done([paired.from.first_name, paired.from.username && '@' + paired.from.username].filter(Boolean).join(' ') + ` (id ${paired.from.id})`, CFG_FILE).join('\n'));
  process.exit(0);
}
const setCommands = () => Promise.all([
  tg('setMyCommands', { commands: Object.entries(T().cmds).map(([command, description]) => ({ command, description })) }),
  tg('setChatMenuButton', { menu_button: { type: 'commands' } }),
  tg('setMyDescription', { description: LANG() === 'ko' ? '내 PC의 Claude Code 세션과 대화하는 개인 봇입니다. 연결된 계정만 사용할 수 있습니다.' : 'A private bot for talking to the Claude Code sessions on my PC. Only the linked account can use it.' }),
]).catch((e) => log('commands', e.message));

// ---------- run ----------
async function main() {
  if (!CFG.token || !(CFG.allowed || []).length) { console.log(T().notLinked(__filename)); process.exit(2); }
  fs.mkdirSync(DATA, { recursive: true });
  try { const old = Number(fs.readFileSync(PIDF, 'utf8')); if (old && old !== process.pid) { process.kill(old, 0); log('already running as', old); process.exit(0); } } catch {}
  fs.writeFileSync(PIDF, String(process.pid));
  const bye = () => { for (const r of runs.values()) killTree(r.proc); try { if (Number(fs.readFileSync(PIDF, 'utf8')) === process.pid) fs.rmSync(PIDF); } catch {} process.exit(0); };
  process.on('SIGINT', bye); process.on('SIGTERM', bye);
  for (let i = 0; ; i++) {
    try { const me = await tg('getMe'); log(`relay up: @${me.username}${agent ? ' via proxy' : ''}, claude ${findClaude()}, ${CFG.permissionMode || 'acceptEdits'}`); break; }
    catch (e) { log('getMe failed', e.message); await sleep(Math.min(60000, 5000 * (i + 1))); }
  }
  setCommands();
  let busy = false;
  setInterval(async () => { if (busy) return; busy = true; try { await follow(); } catch (e) { log('follow', e.message); } busy = false; }, 3000);
  for (;;) {
    try {
      const ups = await tg('getUpdates', { offset: st.offset, timeout: 50, allowed_updates: ['message', 'callback_query'] }, 70000);
      for (const u of ups) {
        st.offset = u.update_id + 1; save();
        if (u.message) onMessage(u.message).catch((e) => { log('msg', e.stack || e.message); send(String(u.message.chat.id), `❌ ${esc(e.message)}`).catch(() => {}); });
        if (u.callback_query) onCallback(u.callback_query).catch((e) => log('cb', e.stack || e.message));
      }
    } catch (e) { log('poll', e.message); await sleep(5000); }
  }
}
process.on('uncaughtException', (e) => log('uncaught', e.stack || e.message));
process.on('unhandledRejection', (e) => log('unhandled', e && (e.stack || e.message)));
if (require.main === module) { if (process.argv[2] === 'setup') setup(); else main(); }
module.exports = { mdToTg, sessions, outputsIn, shortenPaths };
