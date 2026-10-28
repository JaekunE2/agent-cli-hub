// pty host: owns the dashboard terminals so they survive dashboard-server restarts.
// The server (server.js) is only a client: it spawns/writes/resizes/kills terminals here
// and mirrors their output over one event WebSocket. Local only, same token as the server.
//   node ptyhost.js            (the server starts it detached when it isn't running)
const http = require('http');
const fs = require('fs');
// stay responsive while training/cleanup jobs load the PC (above-normal is not inherited by children)
try { require('os').setPriority(require('os').constants.priority.PRIORITY_ABOVE_NORMAL); } catch {}
const path = require('path');
const { WebSocketServer } = require('ws');
const pty = require('@lydell/node-pty');

const PORT = Number(process.env.CCD_PTY_PORT || 7779);
const TOKEN = fs.readFileSync(path.join(__dirname, '.token'), 'utf8').trim();
const BUF_MAX = 1_000_000;
const terms = new Map(); // id -> { id, proc, buf, exited, cols, rows, meta }
const subscribers = new Set();
const emit = (ev) => { const s = JSON.stringify(ev); for (const ws of subscribers) try { ws.send(s); } catch {} };
const info = (t) => ({ id: t.id, exited: t.exited, cols: t.cols, rows: t.rows, meta: t.meta, startedAt: t.startedAt });

function spawnTerm({ id, cmd, args = [], cwd, env, cols = 120, rows = 32, meta = {} }) {
  if (terms.has(id)) throw new Error(`terminal ${id} exists`);
  const proc = pty.spawn(cmd, args, { name: 'xterm-256color', cols, rows, cwd, env: env || process.env });
  const t = { id, proc, buf: '', exited: null, cols, rows, meta, startedAt: Date.now() };
  proc.onData((d) => { t.buf = (t.buf + d).slice(-BUF_MAX); emit({ type: 'data', id, data: d }); });
  proc.onExit(({ exitCode }) => { t.exited = exitCode; emit({ type: 'exit', id, code: exitCode }); });
  terms.set(id, t);
  emit({ type: 'spawned', term: info(t) });
  return t;
}

function body(req) {
  return new Promise((resolve) => {
    const chunks = []; req.on('data', (d) => chunks.push(d));
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { resolve({}); } });
  });
}
const send = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
const authed = (req, url) => (req.headers['x-token'] || url.searchParams.get('t')) === TOKEN && !req.headers.origin;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (!authed(req, url)) return send(res, 401, { error: 'bad token' });
  const p = url.pathname;
  try {
    if (p === '/info') return send(res, 200, { pid: process.pid, startedAt, terms: [...terms.values()].map(info) });
    if (p === '/buf') { const t = terms.get(url.searchParams.get('id')); return t ? send(res, 200, { buf: t.buf }) : send(res, 404, { error: 'no such terminal' }); }
    if (req.method !== 'POST') return send(res, 404, { error: 'unknown' });
    const b = await body(req);
    const t = b.id != null ? terms.get(String(b.id)) : null;
    if (p === '/spawn') return send(res, 200, info(spawnTerm({ ...b, id: String(b.id) })));
    if (p === '/write') { if (t && t.exited === null) t.proc.write(b.data); return send(res, 200, { ok: !!t }); }
    if (p === '/resize') {
      if (t && t.exited === null && b.cols > 0 && b.rows > 0) { t.proc.resize(b.cols, b.rows); t.cols = b.cols; t.rows = b.rows; emit({ type: 'resize', id: t.id, cols: t.cols, rows: t.rows }); }
      return send(res, 200, { ok: !!t });
    }
    if (p === '/kill') { if (t && t.exited === null) try { t.proc.kill(); } catch {} return send(res, 200, { ok: !!t }); }
    if (p === '/forget') { if (t) { if (t.exited === null) try { t.proc.kill(); } catch {} terms.delete(t.id); emit({ type: 'forgot', id: t.id }); } return send(res, 200, { ok: true }); }
    if (p === '/meta') { if (t) t.meta = { ...t.meta, ...(b.meta || {}) }; return send(res, 200, { ok: !!t }); }
    if (p === '/shutdown') {
      send(res, 200, { ok: true, terms: terms.size });
      for (const x of terms.values()) if (x.exited === null) try { x.proc.kill(); } catch {}
      return setTimeout(() => process.exit(0), 300);
    }
    return send(res, 404, { error: 'unknown' });
  } catch (e) { return send(res, 500, { error: e.message }); }
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, sock, head) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/events' || !authed(req, url)) return sock.destroy();
  wss.handleUpgrade(req, sock, head, (ws) => { subscribers.add(ws); ws.on('close', () => subscribers.delete(ws)); });
});

const startedAt = Date.now();
server.on('error', (e) => { console.error('[ptyhost]', e.message); process.exit(e.code === 'EADDRINUSE' ? 0 : 1); }); // one instance only
server.listen(PORT, '127.0.0.1', () => console.log(`[ptyhost] pid ${process.pid} on 127.0.0.1:${PORT}`));
