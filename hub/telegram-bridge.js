#!/usr/bin/env node
// Telegram → Claude Code sessions on this PC (the dashboard's own bot, separate from the usage bot).
//   node --use-system-ca telegram-bridge.js        (start it hidden at logon, e.g. from a local .vbs)
// Token: <config secretsDir>/ccd-telegram.json {token} (or CCD_TELEGRAM_SECRET). Only ALLOWED_USER_IDS / TELEGRAM_PROXY from the
// usage bot's .env are reused (same owner, same corporate CONNECT proxy).
//
// What it does
//   plain text          → sent to the "home" session (config telegram.home, or set it with /home); when that turn
//                         ends, the session's answer comes back here
//   /to <t:N|id> <text> → same, to any session          /ls  → live sessions (busy/idle, ⚠ limit)
//   /read <t:N|id>      → screen tail                   /gpu → GPU queue        /accounts → usage
//   /switch <t:N|id> [auto|account-id] → resume that session on another account
//   /home <t:N|id>      → change the home session
//   A session that hits a usage limit → alert with buttons [다른 계정으로 전환] (most headroom) / [그대로 둠].
//   Research directors switch themselves (autopilot); they are reported, not offered.
//   Approval requests: a script drops approvals/<id>.json {status:'pending', title, detail, requester}
//   → message with [승인]/[거절] → status becomes approved/denied (+decidedAt). The requester polls the
//   file and does the action itself (e.g. a site login that needs a person), so no secret ever passes through this bot.
//   It may then set `result` (text) in the same file → sent once as the outcome.
'use strict';
const https = require('https'), http = require('http'), tls = require('tls');
const fs = require('fs'), path = require('path'), os = require('os');
// stay responsive while training/cleanup jobs load the PC (above-normal is not inherited by children)
try { require('os').setPriority(require('os').constants.priority.PRIORITY_ABOVE_NORMAL); } catch {}
const { execFile } = require('child_process');

const DIR = __dirname;
// Only the main hub's bridge polls the bot: a second getUpdates poller (e.g. a hub copy on another port)
// would steal the live bridge's updates. CCD_TELEGRAM=1 forces it on (instance.js).
const INSTANCE = require('./instance');
if (!INSTANCE.telegram) { console.error(`[telegram] side hub instance (port ${INSTANCE.port}): bridge disabled; set CCD_TELEGRAM=1 to run it anyway`); process.exit(0); }
const HUB = `http://127.0.0.1:${INSTANCE.port}`;
const HUBCFG = (() => { try { return JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8')); } catch { return {}; } })();
const SECRET = process.env.CCD_TELEGRAM_SECRET || HUBCFG.telegram?.secretFile || path.join(HUBCFG.secretsDir || HUBCFG.calendar?.secretsDir || path.join(DIR, 'data', 'secrets'), 'ccd-telegram.json');
const STATE = path.join(DIR, 'telegram-bridge-state.json');
const LOG = path.join(DIR, 'telegram-bridge.log');
const USAGE_ENV = path.join(os.homedir(), 'ai-usage-dashboard', 'telegram', '.env');
const NODE = process.execPath, CCD = path.join(DIR, 'ccd.js');
const log = (...a) => { const l = `${new Date().toISOString()} ${a.join(' ')}`; console.log(l); try { fs.appendFileSync(LOG, l + '\n'); } catch {} };

const TOKEN = JSON.parse(fs.readFileSync(SECRET, 'utf8')).token;
const env = {};
try { for (const line of fs.readFileSync(USAGE_ENV, 'utf8').split(/\r?\n/)) { const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line); if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, ''); } } catch {}
const ALLOWED = new Set(String(env.ALLOWED_USER_IDS || '').split(',').map((s) => s.trim()).filter(Boolean));
const PROXY = env.TELEGRAM_PROXY || '';
if (!ALLOWED.size) { log('no ALLOWED_USER_IDS — refusing to start'); process.exit(1); }
// one instance only (two pollers would steal each other's updates)
const PIDF = path.join(DIR, 'telegram-bridge.pid');
try { const old = Number(fs.readFileSync(PIDF, 'utf8')); if (old && old !== process.pid) { process.kill(old, 0); log('already running as', old); process.exit(0); } } catch {}
fs.writeFileSync(PIDF, String(process.pid));

let st = { home: HUBCFG.telegram?.home || null, offset: 0, alerted: {}, owner: null };
try { st = { ...st, ...JSON.parse(fs.readFileSync(STATE, 'utf8')) }; } catch {}
const save = () => { try { fs.writeFileSync(STATE, JSON.stringify(st, null, 1)); } catch {} };

// ---------- Telegram over the corporate CONNECT proxy (as the usage bot does) ----------
class Tunnel extends https.Agent {
  constructor(u) { super({ keepAlive: true }); this.p = new URL(u); }
  createConnection(o, cb) {
    const r = http.request({ host: this.p.hostname, port: Number(this.p.port) || 80, method: 'CONNECT', path: `${o.host}:${o.port}`, headers: { Host: `${o.host}:${o.port}` } });
    r.once('connect', (res, sock) => { if (res.statusCode !== 200) return cb(new Error('proxy CONNECT ' + res.statusCode)); const s = tls.connect({ socket: sock, servername: o.host }, () => cb(null, s)); s.once('error', cb); });
    r.once('error', cb); r.end();
  }
}
const agent = PROXY ? new Tunnel(PROXY) : undefined;
function tg(method, payload, timeout = 35000) {
  return new Promise((ok, no) => {
    const body = JSON.stringify(payload || {});
    const req = https.request({ hostname: 'api.telegram.org', port: 443, path: `/bot${TOKEN}/${method}`, method: 'POST', agent, timeout,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
      let d = ''; res.on('data', (c) => (d += c));
      res.on('end', () => { try { const j = JSON.parse(d); j.ok ? ok(j.result) : no(new Error(`${method}: ${j.description}`)); } catch { no(new Error(`${method}: bad reply`)); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout'))); req.on('error', no); req.end(body);
  });
}
// ---------- messages for a phone screen ----------
// Everything goes out as Telegram HTML. Session answers are Markdown → converted (headings → bold,
// tables → one line per row, lists → •, code → <code>/<pre>). Long text: first page + [더 보기].
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
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(l)) { out.push(''); continue; }
    out.push(inline(l));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/@@B(\d+)@@/g, (_, n) => blocks[n]).trim();
}
// split at paragraph boundaries (never inside a <pre>) into pages of ~3000 chars
function pages(html, size = 3000) {
  const parts = html.split(/\n\n/), out = [];
  let cur = '';
  for (const p of parts) {
    if (cur && (cur + '\n\n' + p).length > size) { out.push(cur); cur = p; } else cur = cur ? cur + '\n\n' + p : p;
    while (cur.length > size + 800 && !cur.includes('<pre>')) { out.push(cur.slice(0, size)); cur = cur.slice(size); }
  }
  if (cur) out.push(cur);
  return out.length ? out : ['(빈 응답)'];
}
const more = new Map(); // id -> remaining pages (in memory)
async function sendHtml(chat, html, extra = {}) {
  try { return await tg('sendMessage', { chat_id: chat, text: html, parse_mode: 'HTML', disable_web_page_preview: true, ...extra }); }
  catch (e) { // broken markup → plain text
    return tg('sendMessage', { chat_id: chat, text: html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').slice(0, 4000), disable_web_page_preview: true, ...extra });
  }
}
async function send(chat, html, extra = {}) {
  const ps = pages(String(html || '(빈 응답)'));
  if (ps.length === 1) return sendHtml(chat, ps[0], extra);
  const id = Math.random().toString(36).slice(2, 8);
  more.set(id, ps.slice(1)); setTimeout(() => more.delete(id), 6 * 3600e3);
  return sendHtml(chat, ps[0], { reply_markup: { inline_keyboard: [[{ text: `더 보기 (${ps.length - 1}쪽 남음)`, callback_data: `more:${id}` }]] } });
}
const plain = (t) => esc(t);
const short = (t, n = 26) => { t = String(t || '').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const KEYBOARD = { keyboard: [[{ text: '/ls' }, { text: '/gpu' }], [{ text: '/accounts' }, { text: '/help' }]], resize_keyboard: true, is_persistent: true };

// ---------- dashboard ----------
const ccd = (args, timeout = 60000) => new Promise((ok) => execFile(NODE, [CCD, ...args], { timeout, windowsHide: true, maxBuffer: 8 << 20 },
  (e, out, err) => ok(((out || '') + (e && !out ? (err || e.message) : '')).trim())));
const TOKEN_DASH = fs.readFileSync(path.join(DIR, '.token'), 'utf8').trim();
const dash = (p) => new Promise((ok, no) => http.get(`${HUB}${p}`, { headers: { 'x-token': TOKEN_DASH } }, (r) => {
  let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => { try { ok(JSON.parse(d)); } catch (e) { no(e); } });
}).on('error', no));

// ---------- photos / files → GX10 drive 텔레그램 전달 사진/ (top level, since 2026-11-03) ----------
// A photo or an image/PDF document sent to the bot is saved on the drive. The caption picks the folder:
// none → 텔레그램 전달 사진/ itself; text → its existing subfolder whose name contains it
// (only if exactly one does), else a new subfolder named after it. Albums share the first caption.
const INBOX_ROOT = '\uD154\uB808\uADF8\uB7A8 \uC804\uB2EC \uC0AC\uC9C4'; // 텔레그램 전달 사진 (a drive folder name, never translated)
const albums = new Map(); // media_group_id → {items:[m], timer}
function tgDownload(filePath) {
  return new Promise((ok, no) => https.get({ hostname: 'api.telegram.org', port: 443, path: `/file/bot${TOKEN}/${filePath}`, agent, timeout: 120000 }, (r) => {
    if (r.statusCode !== 200) { r.resume(); return no(new Error('download ' + r.statusCode)); }
    const bs = []; r.on('data', (c) => bs.push(c)); r.on('end', () => ok(Buffer.concat(bs)));
  }).on('timeout', function () { this.destroy(new Error('download timeout')); }).on('error', no));
}
const driveReq = (method, p, body) => new Promise((ok, no) => {
  const rq = http.request(`${HUB}/api/drive/${p}`, { method, headers: { 'x-token': TOKEN_DASH, 'content-length': body ? body.length : 0, ...(Buffer.isBuffer(body) ? {} : { 'content-type': 'application/json' }) }, timeout: 120000 }, (r) => {
    let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => { try { ok(JSON.parse(d)); } catch { ok({ error: `${r.statusCode} ${d.slice(0, 200)}` }); } });
  });
  rq.on('timeout', () => rq.destroy(new Error('drive timeout'))); rq.on('error', no); rq.end(body);
});
const mediaOf = (m) => {
  if (m.photo?.length) return { file_id: m.photo[m.photo.length - 1].file_id, ext: '.jpg' };
  const d = m.document;
  if (d && (/^image\//.test(d.mime_type || '') || d.mime_type === 'application/pdf' || /\.(jpe?g|png|heic|webp|pdf)$/i.test(d.file_name || '')))
    return { file_id: d.file_id, name: d.file_name };
  return null;
};
async function inboxFolder(caption) {
  const c = String(caption || '').split('\n')[0].trim().replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!c) return INBOX_ROOT;
  const ls = await driveReq('GET', `list?path=${encodeURIComponent(INBOX_ROOT)}`).catch(() => ({ entries: [] }));
  const hit = (ls.entries || []).filter((e) => e.dir && e.name.toLowerCase().includes(c.toLowerCase()));
  return `${INBOX_ROOT}/${hit.length === 1 ? hit[0].name : c}`;
}
async function saveMedia(chat, items) {
  const folder = await inboxFolder(items.map((m) => m.caption).find(Boolean));
  const ts = (d) => new Date(d * 1000 + 9 * 3600e3).toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '_');
  const saved = [];
  for (const m of items) {
    const md = mediaOf(m);
    try {
      const f = await tg('getFile', { file_id: md.file_id });
      const buf = await tgDownload(f.file_path);
      const name = (md.name || `\uD154\uB808\uADF8\uB7A8_${ts(m.date)}`).replace(/[\\/:*?"<>|]+/g, '_').replace(/(\.[^.]+)?$/, (x) => `_${m.message_id}${x || md.ext || path.extname(f.file_path)}`);
      const r = await driveReq('PUT', `file?path=${encodeURIComponent(`${folder}/${name}`)}`, buf);
      if (r.error) throw new Error(r.error);
      saved.push(name); log('drive inbox', `${folder}/${name}`, buf.length);
    } catch (e) { log('drive inbox fail', e.message); await send(chat, `❌ 저장 실패\n<code>${esc(e.message)}</code>`); }
  }
  if (saved.length) await send(chat, `📁 드라이브에 저장 (${saved.length}개)\n<code>${esc(folder)}/</code>\n${saved.map((n) => '• ' + esc(n)).join('\n')}`, { reply_to_message_id: items[0].message_id });
}
// Any other file (pcap/zip/video/…): it used to be dropped without a word. Bots can only download up to
// 20 MB, so smaller files go to the same drive folder as photos and larger ones get an explanation.
const TG_MAX = 20 * 1024 * 1024;
const otherFile = (m) => m.document || m.video || m.audio || m.voice || m.video_note || m.animation;
async function saveOtherFile(m) {
  const chat = m.chat.id, f0 = otherFile(m);
  const ts = new Date(m.date * 1000 + 9 * 3600e3).toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '_');
  const name = (f0.file_name || `\uD154\uB808\uADF8\uB7A8_${ts}${m.video ? '.mp4' : ''}`).replace(/[\\/:*?"<>|]+/g, '_');
  if ((f0.file_size || 0) > TG_MAX) {
    log('file too big', name, f0.file_size);
    return send(chat, `⚠️ <b>받지 못했습니다</b> — ${esc(name)} (${(f0.file_size / 1048576).toFixed(0)} MB)\n텔레그램 봇은 20 MB까지만 내려받을 수 있습니다.\n큰 촬영 데이터는 폰 앱의 드라이브 업로드나 노트북에서 직접 올려 주세요.`, { reply_to_message_id: m.message_id });
  }
  const folder = await inboxFolder(m.caption);
  const stored = name.replace(/(\.[^.]+)?$/, (x) => `_${m.message_id}${x}`);
  try {
    const f = await tg('getFile', { file_id: f0.file_id });
    const buf = await tgDownload(f.file_path);
    const r = await driveReq('PUT', `file?path=${encodeURIComponent(`${folder}/${stored}`)}`, buf);
    if (r.error) throw new Error(r.error);
    log('drive file', `${folder}/${stored}`, buf.length);
    await send(chat, `📁 드라이브에 저장\n<code>${esc(folder)}/</code>\n• ${esc(stored)} (${(buf.length / 1048576).toFixed(1)} MB)`, { reply_to_message_id: m.message_id });
  } catch (e) { log('drive file fail', e.message); await send(chat, `❌ 저장 실패 — ${esc(name)}\n<code>${esc(e.message)}</code>`); }
}
function onMedia(m) {
  const chat = m.chat.id;
  if (!m.media_group_id) return saveMedia(chat, [m]);
  let g = albums.get(m.media_group_id);
  if (!g) { g = { items: [] }; albums.set(m.media_group_id, g); }
  g.items.push(m); clearTimeout(g.timer);
  g.timer = setTimeout(() => { albums.delete(m.media_group_id); saveMedia(chat, g.items.sort((a, b) => a.message_id - b.message_id)).catch((e) => log('album', e.message)); }, 2500);
}
// live sessions: [{t, status, sid, title}] from `ccd ls`
async function sessions() {
  const out = await ccd(['ls']);
  const res = [];
  for (const l of out.split('\n')) {
    const m = /^\s+(t:\d+|c:\d+|desktop|\S+)\s+(busy|idle|shell|waiting)\s+([0-9a-f]{8})\s+(.*?)\s{2}\[/.exec(l);
    if (m) res.push({ t: m[1], status: m[2], sid: m[3], title: m[4].trim() });
    if (/^CONSOLE WINDOWS/.test(l)) break;
  }
  return res;
}
async function targetOf(arg) {
  const all = await sessions();
  const a = String(arg || '').replace(/^t(\d)/, 't:$1');
  return all.find((s) => s.t === a || s.sid.startsWith(a)) || null;
}
// the session's answers after `since` (its transcript), i.e. what it said back to our message
function transcriptOf(sid) {
  const root = path.join(os.homedir(), '.claude', 'projects');
  for (const d of fs.readdirSync(root)) {
    try { for (const f of fs.readdirSync(path.join(root, d))) if (f.startsWith(sid) && f.endsWith('.jsonl')) return path.join(root, d, f); } catch {}
  }
  return null;
}
function answerSince(sid, since) {
  const f = transcriptOf(sid); if (!f) return null;
  const texts = [];
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!line.includes('"assistant"')) continue;
    try {
      const e = JSON.parse(line);
      if (e.type !== 'assistant' || new Date(e.timestamp).getTime() < since) continue;
      for (const c of e.message?.content || []) if (c.type === 'text' && c.text.trim()) texts.push(c.text.trim());
    } catch {}
  }
  return texts.join('\n\n');
}

async function deliver(chat, arg, text) {
  const s = await targetOf(arg);
  if (!s) return send(chat, `❓ 세션을 찾지 못했습니다: <code>${esc(arg)}</code>\n/ls 로 확인하세요`);
  if (s.status === 'busy') await send(chat, `⏳ <b>${esc(s.t)}</b> ${esc(short(s.title))}\n지금 작업 중이라 끝난 뒤 이어서 처리합니다.`);
  const since = Date.now() - 2000;
  const r = await ccd(['send', s.t, `[텔레그램] ${text}`]);
  if (!/^sent/.test(r)) return send(chat, `❌ 보내지 못했습니다\n<code>${esc(r.slice(0, 300))}</code>`);
  await tg('sendChatAction', { chat_id: chat, action: 'typing' }).catch(() => {});
  await ccd(['wait', s.t, '--timeout', '3600'], 3700e3);
  const ans = answerSince(s.sid, since);
  return send(chat, `💬 <b>${esc(s.t)}</b> · ${esc(short(s.title, 30))}\n\n${ans ? mdToTg(ans) : `(답을 찾지 못했습니다 — /read ${esc(s.t)} 로 화면 확인)`}`);
}

async function onMessage(m) {
  const chat = m.chat.id, from = String(m.from?.id || '');
  if (!ALLOWED.has(from)) return log('ignored user', from);
  if (!st.owner) { st.owner = chat; save(); }
  if (mediaOf(m)) return onMedia(m);
  if (otherFile(m)) return saveOtherFile(m).catch((e) => log('file', e.message));
  const text = (m.text || '').trim();
  if (!text) return;
  if (await answerInput(m, text).catch((e) => { log('input', e.message); return false; })) return;
  const [cmd, ...rest] = text.split(/\s+/);
  const arg = rest[0], tail = rest.slice(1).join(' ');
  try {
    if (cmd === '/start' || cmd === '/help') return send(chat, [
      '<b>🛰 관제 봇</b>',
      '',
      `💬 그냥 메시지 → 기본 세션 <code>${esc(st.home)}</code>에 전달, 끝나면 답이 옵니다`,
      '',
      '<b>세션</b>',
      '/ls — 목록',
      '/read t:N — 화면 보기',
      '/to t:N 내용 — 다른 세션에 보내기',
      '/home t:N — 기본 세션 바꾸기',
      '',
      '<b>계정·GPU</b>',
      '/accounts — 계정별 사용량',
      '/switch t:N — 여유 계정으로 전환',
      '/gpu — GPU 대기열',
      '',
      '<b>사진·PDF</b>',
      '보내면 드라이브 텔레그램 전달 사진/에 저장 (캡션 = 그 안의 폴더 이름 일부, 없으면 바로 그 폴더)',
      '그 밖의 파일도 20 MB까지는 같은 곳에 저장, 더 크면 안내만',
      '',
      '⚠️ 한도에 걸린 세션은 전환 버튼과 함께 알려 드립니다.'].join('\n'), { reply_markup: KEYBOARD });
    if (cmd === '/ls') {
      const ov = await dash('/api/overview').catch(() => ({ live: [] }));
      const lim = new Set((ov.live || []).filter((s) => s.limit).map((s) => s.sessionId.slice(0, 8)));
      const ss = await sessions();
      const line = (s) => `<code>${esc(s.t.padEnd(5))}</code> ${esc(short(s.title, 24))}`;
      const busy = ss.filter((s) => s.status === 'busy' || s.status === 'shell'), limited = ss.filter((s) => lim.has(s.sid));
      const idle = ss.filter((s) => !busy.includes(s) && !limited.includes(s));
      const out = [];
      if (limited.length) out.push(`<b>⚠️ 한도 (${limited.length})</b>`, ...limited.map(line), '');
      out.push(`<b>🟢 작업 중 (${busy.length})</b>`, ...(busy.length ? busy.map(line) : ['없음']), '');
      out.push(`<b>⚪ 대기 (${idle.length})</b>`, ...idle.slice(0, 12).map(line), ...(idle.length > 12 ? [`… 외 ${idle.length - 12}개`] : []));
      return send(chat, out.join('\n'));
    }
    if (cmd === '/read') {
      const s = await targetOf(arg); if (!s) return send(chat, '❓ 세션 없음');
      // screen tail without the TUI chrome (rules, status bar, empty prompt), lines cut for a phone
      const lines = (await ccd(['read', s.t, '-n', '60'])).split('\n')
        .filter((l) => l.trim() && !/^[─━═\s]+$|bypass permissions|shift\+tab|esc to interrupt|^\s*❯\s*$|^\s*==\s/.test(l))
        .map((l) => (l.length > 64 ? l.slice(0, 63) + '…' : l)).slice(-28);
      return send(chat, `<b>📺 ${esc(s.t)}</b> · ${esc(short(s.title, 30))} · ${s.status === 'busy' ? '작업 중' : '대기'}\n<pre>${esc(lines.join('\n'))}</pre>`);
    }
    if (cmd === '/to') return deliver(chat, arg, tail);
    if (cmd === '/home') { const s = await targetOf(arg); if (!s) return send(chat, '❓ 세션 없음'); st.home = s.sid; save(); return send(chat, `🏠 기본 세션: <b>${esc(s.t)}</b> ${esc(short(s.title, 30))}`); }
    if (cmd === '/accounts') {
      const rows = [];
      for (const l of (await ccd(['accounts'])).split('\n')) {
        const m = /^\s*(\*)?\s*(\S+)\s+(\S+)%\s*\/\s*(\S+)%\s+headroom\s+(-?\d+)\s+(.*?)\s*(\(unusable\))?$/.exec(l);
        if (!m) continue;
        const name = m[2] === 'default' ? '이 PC 로그인' : m[6].replace(/@gmail\.com/, '');
        rows.push(`${m[1] ? '⭐' : m[7] ? '⛔' : '▫️'} <b>${esc(short(name, 22))}</b>\n    5시간 ${esc(m[3])}% · 주간 ${esc(m[4])}%`);
      }
      return send(chat, `<b>👤 계정 사용량</b> (⭐ 전환 시 선택)\n\n${rows.join('\n') || '정보 없음'}`);
    }
    if (cmd === '/gpu') {
      const q = await dash('/api/gpu');
      const bar = (p) => '▓'.repeat(Math.round(p / 20)) + '░'.repeat(5 - Math.round(p / 20));
      const name = (g) => (g.server ? g.server.replace(/\s*\(.*\)/, '') : '') + ' ' + g.name.replace(/NVIDIA |GeForce /g, '').replace(/ Server Edition|-SXM4-40GB/g, '');
      const gs = (q.gpus || []).filter((g) => g.index >= 0 && g.enabled !== false).map((g) => {
        const ln = q.lanes?.[g.key] || {};
        const pct = g.totalMB ? Math.round(g.usedMB / g.totalMB * 100) : 0;
        return `<b>${esc(short(name(g).trim(), 24))}</b>\n    ${bar(pct)} ${(g.usedMB / 1024).toFixed(0)}/${(g.totalMB / 1024).toFixed(0)}G · ${g.util}%${ln.waiting?.length ? ` · 대기 ${ln.waiting.length}` : ''}`;
      });
      const hm = (x) => (x ? new Date(x).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false }) : '?');
      const act = (q.active || []).map((t) => `▶ ${esc(short(t.label, 22))} <i>${esc(t.gpu.split(':')[0])}</i> ~${hm(t.expectedEnd)}`);
      const wait = (q.waiting || []).map((t) => `⏳ ${esc(short(t.label, 22))} <i>#${t.position}</i>`);
      return send(chat, [`<b>🎛 GPU</b>`, '', ...gs, '', `<b>실행 중 (${act.length})</b>`, ...(act.length ? act : ['없음']), ...(wait.length ? ['', `<b>대기 (${wait.length})</b>`, ...wait] : [])].join('\n'));
    }
    if (cmd === '/switch') {
      const s = await targetOf(arg); if (!s) return send(chat, '세션 없음');
      await send(chat, `🔄 <b>${esc(s.t)}</b> ${esc(short(s.title, 30))}\n다른 계정으로 전환 중…`);
      return send(chat, switchMsg(await ccd(['switch', s.sid, '--account', tail || 'auto'], 300e3)));
    }
    if (cmd.startsWith('/')) return send(chat, '❓ 모르는 명령입니다 — /help');
    if (!st.home) return send(chat, '🏠 기본 세션이 없습니다 — /home &lt;t:N|세션id&gt; 로 정하세요');
    return deliver(chat, st.home, text);
  } catch (e) { log('handler', e.message); return send(chat, `❌ 오류\n<code>${esc(e.message)}</code>`); }
}

// "resumed 7363cc68 as t:161 on someone@example.com (5h 0% / wk 20%); stopped t:158" → short Korean
function switchMsg(r) {
  const m = /resumed (\w+) as (t:\d+) on (\S+) \(5h (\S+) \/ wk (\S+)\)/.exec(r || '');
  return m ? `✅ 전환 완료\n<b>${esc(m[2])}</b> 에서 이어서 진행\n계정 ${esc(m[3].replace(/@gmail\.com/, ''))} (5시간 ${esc(m[4])} · 주간 ${esc(m[5])})`
    : `⚠️ 전환 결과\n<code>${esc(String(r || '').slice(0, 500))}</code>`;
}
async function onCallback(q) {
  if (!ALLOWED.has(String(q.from?.id || ''))) return;
  const chat = q.message.chat.id, [kind, sid] = String(q.data || '').split(':');
  await tg('answerCallbackQuery', { callback_query_id: q.id }).catch(() => {});
  if (kind === 'more') {
    const rest = more.get(sid);
    if (!rest?.length) return send(chat, '(더 볼 내용이 없거나 만료됐습니다)');
    const next = rest.shift();
    return sendHtml(chat, next, rest.length ? { reply_markup: { inline_keyboard: [[{ text: `더 보기 (${rest.length}쪽 남음)`, callback_data: `more:${sid}` }]] } } : {});
  }
  if (kind === 'sw') { await send(chat, `🔄 <code>${esc(sid)}</code> 전환 중…`); return send(chat, switchMsg(await ccd(['switch', sid, '--account', 'auto'], 300e3))); }
  if (kind === 'apv' || kind === 'apn') return decideApproval(q, sid, kind === 'apv');
  if (kind === 'keep') return send(chat, `👌 <code>${esc(sid)}</code> 그대로 둡니다\n한도가 풀리면 이어서 진행합니다.`);
}

// usage-limit alerts (once per session per limit event)
async function watchLimits() {
  if (!st.owner) return;
  const ov = await dash('/api/overview').catch(() => null);
  if (!ov) return;
  const directors = new Set();
  try { for (const p of require('./harness').lib('project').listProjects()) if (p.state.director_session_id) directors.add(p.state.director_session_id); } catch {}
  for (const s of ov.live || []) {
    if (!s.limit) { if (st.alerted[s.sessionId]) { delete st.alerted[s.sessionId]; save(); } continue; }
    const key = String(s.limit.ts || 'x');
    if (st.alerted[s.sessionId] === key) continue;
    st.alerted[s.sessionId] = key; save();
    const sid = s.sessionId.slice(0, 8), title = (s.title || s.name || '').slice(0, 50);
    if (directors.has(s.sessionId)) { await send(st.owner, `⚠️ <b>한도 도달</b> · 자율연구 디렉터\n${esc(short(title, 34))}\nautopilot이 자동으로 계정을 바꿉니다.`); continue; }
    const acc = (await ccd(['accounts'])).split('\n').find((l) => l.trim().startsWith('*')) || '';
    const am = /(\S+)%\s*\/\s*(\S+)%\s+headroom\s+-?\d+\s+(\S+)/.exec(acc);
    await send(st.owner, `⚠️ <b>사용 한도에 걸렸습니다</b>\n${esc(short(title, 34))} <code>${esc(sid)}</code>\n\n<i>${esc(short(s.limit.text || '', 120))}</i>${am ? `\n\n추천 계정: <b>${esc(am[3].replace(/@gmail\.com/, ''))}</b>\n5시간 ${esc(am[1])}% · 주간 ${esc(am[2])}%` : ''}`,
      { reply_markup: { inline_keyboard: [[{ text: '🔄 다른 계정으로 전환', callback_data: `sw:${sid}` }, { text: '그대로 둠', callback_data: `keep:${sid}` }]] } });
  }
}

// approval requests (file-based, see header)
const APPROVALS = path.join(DIR, 'approvals');
const APPROVAL_TTL = 15 * 60e3;
const readAp = (id) => { try { return JSON.parse(fs.readFileSync(path.join(APPROVALS, id + '.json'), 'utf8')); } catch { return null; } };
const writeAp = (id, a) => { const f = path.join(APPROVALS, id + '.json'); fs.writeFileSync(f + '.tmp', JSON.stringify(a, null, 1)); fs.renameSync(f + '.tmp', f); };
// one-way reports from the dashboard (e.g. crash-recovery.js): notify/*.json {html} → sent to the owner once, then deleted
const NOTIFY = path.join(DIR, 'notify');
async function watchNotify() {
  if (!st.owner || !fs.existsSync(NOTIFY)) return;
  for (const f of fs.readdirSync(NOTIFY).filter((x) => x.endsWith('.json'))) {
    const p = path.join(NOTIFY, f);
    let n; try { n = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { continue; }
    await send(st.owner, n.html || esc(n.text || ''));
    fs.rmSync(p, { force: true });
  }
}
async function watchApprovals() {
  if (!st.owner || !fs.existsSync(APPROVALS)) return;
  for (const f of fs.readdirSync(APPROVALS).filter((x) => /^[\w-]+\.json$/.test(x))) {
    const id = f.slice(0, -5), a = readAp(id);
    if (!a) continue;
    const ttl = a.ttlMs || APPROVAL_TTL, age = Date.now() - new Date(a.createdAt || 0).getTime();
    if (a.status === 'pending' && age > ttl) { a.status = 'expired'; writeAp(id, a); continue; }
    if (a.status === 'pending' && !a.sentAt && a.input) {
      // input request (e.g. login OTP): the user answers by replying to this message (or, if it is the only
      // open input request, by sending a message that matches `pattern`). The reply is deleted from the chat.
      a.sentAt = new Date().toISOString(); writeAp(id, a);
      const r = await send(st.owner, [`⌨️ <b>입력 요청</b> · ${esc(a.title || a.type || id)}`, a.detail ? esc(a.detail) : '',
        a.requester ? `요청: <code>${esc(short(a.requester, 40))}</code>` : '',
        `<i>이 메시지에 답장으로 입력하세요. 입력한 메시지는 바로 지워집니다. ${Math.round(ttl / 60e3)}분 안에 응답이 없으면 취소됩니다.</i>`].filter(Boolean).join('\n'),
        { reply_markup: { force_reply: true, input_field_placeholder: a.placeholder || '입력값' } }).catch((e) => log('input send', e.message));
      if (r?.message_id) { const b = readAp(id) || a; b.messageId = r.message_id; writeAp(id, b); }
      continue;
    }
    if (a.status === 'pending' && !a.sentAt) {
      a.sentAt = new Date().toISOString(); writeAp(id, a);
      const r = await send(st.owner, [`🔐 <b>승인 요청</b> · ${esc(a.title || a.type || id)}`, a.detail ? esc(a.detail) : '',
        a.requester ? `요청: <code>${esc(short(a.requester, 40))}</code>` : '', `<i>${Math.round(ttl / 60e3)}분 안에 응답이 없으면 취소됩니다.</i>`].filter(Boolean).join('\n'),
        { reply_markup: { inline_keyboard: [[{ text: '✅ 승인', callback_data: `apv:${id}` }, { text: '거절', callback_data: `apn:${id}` }]] } }).catch((e) => log('approval send', e.message));
      if (r?.message_id) { const b = readAp(id) || a; b.messageId = r.message_id; writeAp(id, b); }
    }
    // the requester reports back by writing `result` (plain text) once it has acted on the decision
    if (a.result && !a.resultSentAt) {
      a.resultSentAt = new Date().toISOString(); writeAp(id, a);
      await send(st.owner, `📋 <b>${esc(a.title || id)}</b>\n${esc(a.result)}`).catch((e) => log('approval result', e.message));
    }
    if (a.status !== 'pending' && age > 7 * 24 * 3600e3) fs.rmSync(path.join(APPROVALS, f), { force: true });
  }
}
// a message answering an open input request → store it in the request file, delete it from the chat
async function answerInput(m, text) {
  if (!fs.existsSync(APPROVALS)) return false;
  const open = fs.readdirSync(APPROVALS).filter((x) => /^[\w-]+\.json$/.test(x)).map((f) => [f.slice(0, -5), readAp(f.slice(0, -5))])
    .filter(([, a]) => a && a.input && a.status === 'pending' && a.sentAt);
  if (!open.length) return false;
  const replyTo = m.reply_to_message?.message_id;
  let hit = open.find(([, a]) => replyTo && a.messageId === replyTo);
  if (!hit && open.length === 1 && open[0][1].pattern && new RegExp(open[0][1].pattern).test(text)) hit = open[0];
  if (!hit) return false;
  const [id, a] = hit;
  if (a.pattern && !new RegExp(a.pattern).test(text)) {
    await tg('deleteMessage', { chat_id: m.chat.id, message_id: m.message_id }).catch(() => {});
    await send(m.chat.id, `⚠️ 형식이 맞지 않습니다 · ${esc(a.title || id)} — 다시 답장해 주세요`);
    return true;
  }
  a.value = text; a.status = 'answered'; a.decidedAt = new Date().toISOString(); a.decidedBy = String(m.from.id);
  writeAp(id, a);
  await tg('deleteMessage', { chat_id: m.chat.id, message_id: m.message_id }).catch(() => {});
  if (a.messageId) await tg('editMessageReplyMarkup', { chat_id: m.chat.id, message_id: a.messageId, reply_markup: { inline_keyboard: [] } }).catch(() => {});
  await send(m.chat.id, `✅ 입력값을 전달했습니다 · ${esc(a.title || id)}`);
  return true;
}
async function decideApproval(q, id, ok) {
  const chat = q.message.chat.id, a = readAp(id);
  if (!a) return send(chat, '(요청을 찾을 수 없습니다)');
  await tg('editMessageReplyMarkup', { chat_id: chat, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
  if (a.status !== 'pending') return send(chat, `이미 처리된 요청입니다 (${esc(a.status)})`);
  a.status = ok ? 'approved' : 'denied'; a.decidedAt = new Date().toISOString(); a.decidedBy = String(q.from.id);
  writeAp(id, a);
  return send(chat, ok ? `✅ 승인했습니다 · ${esc(a.title || id)}` : `🚫 거절했습니다 · ${esc(a.title || id)}`);
}

(async () => {
  for (let i = 0; ; i++) {
    try { const me = await tg('getMe'); log(`bridge up: @${me.username}${PROXY ? ' via proxy' : ''}, allowed ${[...ALLOWED].join(',')}`); break; }
    catch (e) { log('getMe failed', e.message); await new Promise((r) => setTimeout(r, Math.min(60000, 5000 * (i + 1)))); }
  }
  setInterval(() => watchLimits().catch((e) => log('limits', e.message)), 60000);
  setInterval(() => watchApprovals().catch((e) => log('approvals', e.message)), 3000);
  setInterval(() => watchNotify().catch((e) => log('notify', e.message)), 5000);
  for (;;) {
    try {
      const ups = await tg('getUpdates', { offset: st.offset, timeout: 50, allowed_updates: ['message', 'callback_query'] }, 70000);
      for (const u of ups) {
        st.offset = u.update_id + 1; save();
        if (u.message) onMessage(u.message).catch((e) => log('msg', e.message));
        if (u.callback_query) onCallback(u.callback_query).catch((e) => log('cb', e.message));
      }
    } catch (e) { log('poll', e.message); await new Promise((r) => setTimeout(r, 5000)); }
  }
})();
process.on('uncaughtException', (e) => log('uncaught', e.message));
process.on('unhandledRejection', (e) => log('unhandled', e && e.message));
