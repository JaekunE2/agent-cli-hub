// A stand-in for api.telegram.org for automated tests (config "apiBase": "http://127.0.0.1:18081").
//   POST /_push   {update}           queue an update for getUpdates (update_id is filled in)
//   GET  /_log                       every bot call so far: [{method, body, files}]
//   POST /_file?id=<file_id>         body = bytes served for getFile/file download
// HTML messages are checked like Telegram does (allowed tags, balanced) and rejected otherwise.
'use strict';
const http = require('http');
const PORT = Number(process.argv[2] || 18081);
const updates = [], calls = [], files = new Map(), waiters = [];
let uid = 1, mid = 1000;
const ALLOWED = /^(b|strong|i|em|u|ins|s|strike|del|code|pre|a|blockquote|tg-spoiler|span)$/;
function checkHtml(t) {
  const stack = [];
  for (const m of String(t).matchAll(/<(\/?)([a-z-]+)([^>]*)>/gi)) {
    const [, close, tag] = m;
    if (!ALLOWED.test(tag)) return `unsupported tag <${tag}>`;
    if (close) { if (stack.pop() !== tag) return `can't parse entities: unbalanced </${tag}>`; } else stack.push(tag);
  }
  if (stack.length) return `can't parse entities: unclosed <${stack.pop()}>`;
  if (/&(?!(amp|lt|gt|quot);)/.test(t.replace(/<[^>]+>/g, ''))) return "can't parse entities: bare &";
  return null;
}
function multipart(buf, type) {
  const b = '--' + /boundary=(.+)$/.exec(type)[1], out = { fields: {}, files: {} };
  for (const part of buf.toString('latin1').split(b).slice(1, -1)) {
    const [head, ...rest] = part.split('\r\n\r\n');
    const body = rest.join('\r\n\r\n').replace(/\r\n$/, '');
    const name = /name="([^"]+)"/.exec(head)[1], fn = /filename="([^"]*)"/.exec(head);
    if (fn) out.files[name] = { filename: Buffer.from(fn[1], 'latin1').toString('utf8'), size: Buffer.byteLength(body, 'latin1') };
    else out.fields[name] = Buffer.from(body, 'latin1').toString('utf8');
  }
  return out;
}
const reply = (res, result, ok = true, description) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(ok ? { ok, result } : { ok, description })); };
http.createServer((req, res) => {
  const bs = []; req.on('data', (c) => bs.push(c)); req.on('end', () => {
    const buf = Buffer.concat(bs), u = new URL(req.url, 'http://x');
    if (u.pathname === '/_push') { const up = JSON.parse(buf); up.update_id = uid++; updates.push(up); waiters.splice(0).forEach((w) => w()); return reply(res, up); }
    if (u.pathname === '/_log') return reply(res, calls);
    if (u.pathname === '/_file') { files.set(u.searchParams.get('id'), buf); return reply(res, true); }
    let m;
    if ((m = /^\/file\/bot[^/]+\/(.+)$/.exec(u.pathname))) { const f = files.get(decodeURIComponent(m[1])); if (!f) { res.writeHead(404); return res.end(); } res.writeHead(200); return res.end(f); }
    m = /^\/bot[^/]+\/(\w+)$/.exec(u.pathname);
    if (!m) { res.writeHead(404); return res.end(); }
    const method = m[1];
    let body = {}, up = null;
    if (/multipart/.test(req.headers['content-type'] || '')) { up = multipart(buf, req.headers['content-type']); body = up.fields; }
    else if (buf.length) body = JSON.parse(buf);
    if (method !== 'getUpdates') calls.push({ method, body, files: up?.files, at: Date.now() });
    if (method === 'getMe') return reply(res, { id: 1, is_bot: true, username: 'mock_relay_bot' });
    if (method === 'getUpdates') {
      const off = Number(body.offset || 0);
      const take = () => updates.filter((x) => x.update_id >= off);
      if (take().length || !body.timeout) return reply(res, take());
      let done = false;
      const fin = () => { if (done) return; done = true; reply(res, take()); };
      setTimeout(fin, Math.min(body.timeout, 5) * 1000);
      return waiters.push(fin);
    }
    if (method === 'getFile') return reply(res, { file_id: body.file_id, file_path: body.file_id });
    if (/^(sendMessage|editMessageText)$/.test(method) && body.parse_mode === 'HTML') {
      const err = checkHtml(body.text);
      if (err) return reply(res, null, false, `Bad Request: ${err}`);
      if (body.text.length > 4096) return reply(res, null, false, 'Bad Request: message is too long');
    }
    if (method === 'sendMediaGroup') return reply(res, JSON.parse(body.media).map(() => ({ message_id: mid++ })));
    if (/^(send\w+)$/.test(method)) return reply(res, { message_id: mid++, chat: { id: Number(body.chat_id) } });
    return reply(res, true);
  });
}).on('listening', function () { this.keepAliveTimeout = 120000; }).listen(PORT, '127.0.0.1', () => console.log('mock telegram on', PORT));
