'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

// Delta Hub plugin: a Deltascale "AI Control Hub" used from this hub. Log in once (user + password + TOTP posted to
// the portal from here; only the session cookie is kept, in <secretsDir>/delta-session.json), then the Delta Hub
// view, `ccd delta` and the `ccd gpt` fallback use it. The main hub also relays the whole Delta Hub, logged in, on
// a loopback port (delta.uiPort, default 7790; first visit needs ?k=<hub token>).
//   config delta: {portal, hub, uiPort?, defaultProject?, sessionFile?}
module.exports = function deltaHubPlugin(api) {
  const { hub, config: CONFIG, secretsDir: SECRETS } = api;
  const { token: TOKEN, port: PORT, baseDir } = hub;
  const withTimeout = (p, ms, fallback) => Promise.race([p, new Promise((r) => setTimeout(() => r(fallback), ms))]);
  const trim = (u) => String(u || '').replace(/\/+$/, '');
  // start a configured helper (app / drive server) that is down; side hub instances never start anything
  const startScript = (file) => (api.instance && !api.instance.startServices) ? api.log(`side instance: not starting ${file}`)
    : spawn(/\.vbs$/i.test(file) ? 'wscript.exe' : file, /\.vbs$/i.test(file) ? [file] : [], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  const sameOrigin = (req) => !req.headers.origin || req.headers.origin === `http://${req.headers.host}` || req.headers.origin === `https://${req.headers.host}`;
  const stripToken = (search) => search.replace(/([?&])t=[^&]*&?/, '$1').replace(/[?&]$/, '');
  const DC = CONFIG.delta || {};
  const DELTA = DC.portal && DC.hub ? { portal: trim(DC.portal), hub: trim(DC.hub), file: DC.sessionFile || path.join(SECRETS, 'delta-session.json'), uiPort: Number(DC.uiPort) || 7790 } : null;
  const deltaSession = () => { if (!DELTA) return null; try { return JSON.parse(fs.readFileSync(DELTA.file, 'utf8')); } catch { return null; } };
  let deltaUiUp = false;
  async function deltaStatus() {
    if (!DELTA) return { configured: false, loggedIn: false };
    const s = deltaSession();
    const base = { configured: true, hub: DELTA.hub, uiPort: deltaUiUp ? DELTA.uiPort : null, defaultProject: DC.defaultProject || '' };
    if (!s) return { ...base, loggedIn: false };
    const r = await fetch(`${DELTA.hub}/`, { redirect: 'manual', headers: { cookie: s.cookie } }).catch(() => null);
    return { ...base, loggedIn: !!r && r.status < 300, status: r ? r.status : null, user: s.user, at: s.at };
  }

  async function deltaApi(p, url, req, res, body, send) {
    if (!DELTA) return send(res, 404, { error: 'Delta Hub가 설정되지 않았습니다 (config.json "delta": {"portal", "hub"})' });
    if (p === '/api/delta/login' && req.method === 'POST') {
      const b = await body(req);
      const r = await fetch(`${DELTA.portal}/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: DELTA.portal },
        body: new URLSearchParams({ user: String(b.user || ''), password: String(b.password || ''), code: String(b.code || '').replace(/\s/g, ''), next: '/' }) }).catch((e) => ({ error: e }));
      if (r.error) return send(res, 502, { error: `Delta 포털에 연결할 수 없습니다: ${r.error.cause?.code || r.error.message}` });
      const cookies = (r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get('set-cookie')].filter(Boolean)).map((c) => c.split(';')[0]);
      if (r.status >= 400 || !cookies.length) return send(res, 401, { error: `로그인 실패 (${r.status}) — 아이디·비밀번호·인증 코드를 확인하세요` });
      fs.mkdirSync(path.dirname(DELTA.file), { recursive: true });
      fs.writeFileSync(DELTA.file, JSON.stringify({ user: String(b.user), cookie: cookies.join('; '), at: new Date().toISOString() }, null, 2), { mode: 0o600 });
      return send(res, 200, { ok: true, ...(await deltaStatus()) });
    }
    if (p === '/api/delta/status') return send(res, 200, await deltaStatus());
    // Delta Hub API through the saved session: every GET (read), and only these POSTs — create a session,
    // send / queue / steer a request, stop, resume. Nothing that changes settings, accounts or other people's work.
    if (p.startsWith('/api/delta/hub/')) {
      const sub = p.slice('/api/delta/hub/'.length);
      const POSTS = ['sessions', 'run', 'stop', 'resume', 'queueadd', 'steer', 'interruptsend'];
      if (!/^[a-z][a-z0-9/]*$/.test(sub)) return send(res, 400, { error: 'bad path' });
      if (req.method !== 'GET' && !(req.method === 'POST' && POSTS.includes(sub))) return send(res, 403, { error: `허용되지 않은 Delta 작업: ${req.method} ${sub}` });
      const sess = deltaSession();
      // 419 (not 401): the hub page treats 401 as its own bad token
      if (!sess) return send(res, 419, { error: 'Delta Hub에 로그인되어 있지 않습니다 (🛰 Delta Hub 화면에서 로그인)', relogin: true });
      const init = { method: req.method, redirect: 'manual', headers: { cookie: sess.cookie, accept: 'application/json' } };
      if (req.method === 'POST') {
        init.body = JSON.stringify(await body(req));
        // the hub only accepts writes that come from its own page (no matching Origin = refused)
        Object.assign(init.headers, { 'content-type': 'application/json', 'x-hub-request': 'local-ui', 'idempotency-key': crypto.randomUUID(), origin: DELTA.hub, referer: DELTA.hub + '/' });
      }
      const r = await fetch(`${DELTA.hub}/hub-api/${sub}${stripToken(url.search)}`, init).catch((e) => ({ error: e }));
      if (r.error) return send(res, 502, { error: `Delta Hub 연결 실패: ${r.error.cause?.code || r.error.message}` });
      if (r.status >= 300 && r.status < 400) return send(res, 419, { error: 'Delta Hub 세션이 만료됐습니다 — 다시 로그인하세요', relogin: true });
      const text = await r.text();
      res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/json', 'cache-control': 'no-store' });
      return res.end(text);
    }
    // the phone app opens the Hub logged in: it takes the saved session cookie (token-guarded like every /api)
    if (p === '/api/delta/handoff') { const ds = deltaSession(); return ds ? send(res, 200, { url: DELTA.hub + '/', cookie: ds.cookie }) : send(res, 404, { error: 'Delta Hub에 먼저 로그인하세요' }); }
    if (p === '/api/delta/logout' && req.method === 'POST') { try { fs.unlinkSync(DELTA.file); } catch {} return send(res, 200, { ok: true }); }
    return send(res, 404, { error: 'unknown delta api' });
  }

  // http://127.0.0.1:<uiPort>/ relays the whole Hub 1:1 with the saved session cookie, so the browser opens it logged
  // in (no password/OTP). Loopback only, gated by this hub's token (first visit ?k=<token> sets a local cookie).
  function startDeltaUi() {
    if (!DELTA || (api.instance && !api.instance.deltaUi)) return;
    const https = require('https');
    const srv = http.createServer((req, res) => {
      const k = new URL(req.url, 'http://x').searchParams.get('k');
      const okCookie = (req.headers.cookie || '').split(/;\s*/).includes(`ccd_dk=${TOKEN}`);
      if (k === TOKEN) {
        const u = new URL(req.url, 'http://x'); u.searchParams.delete('k');
        res.writeHead(302, { 'set-cookie': `ccd_dk=${TOKEN}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`, location: u.pathname + u.search });
        return res.end();
      }
      const publicAsset = /^\/(manifest\.webmanifest|favicon\.ico|_next\/static\/)/.test(req.url);
      if (!okCookie && !publicAsset) { res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' }); return res.end('<p>허브의 🛰 Delta Hub에서 "로그인된 허브 열기"로 들어오세요.</p>'); }
      const s = deltaSession();
      if (!s) { res.writeHead(302, { location: `http://127.0.0.1:${PORT}/?open=delta` }); return res.end(); }
      const target = new URL(DELTA.hub);
      const headers = { ...req.headers, host: target.host };
      delete headers['accept-encoding']; delete headers.connection;
      if (headers.origin) headers.origin = target.origin;
      if (headers.referer) headers.referer = target.origin + new URL(headers.referer).pathname;
      headers.cookie = [s.cookie, ...(req.headers.cookie || '').split(/;\s*/).filter((c) => c && !c.startsWith('ccd_dk=') && !c.startsWith('hl_s='))].join('; ');
      const up = https.request({ hostname: target.hostname, port: target.port || 443, path: req.url, method: req.method, headers }, (r) => {
        const h = { ...r.headers }; delete h.connection;
        if (h.location) h.location = h.location.replace(target.origin, '');
        // cookies the Hub sets: a renewed session goes to the saved file; the rest stay on this origin
        const sc = [].concat(h['set-cookie'] || []);
        const fresh = sc.map((c) => /^hl_s=([^;]+)/.exec(c)).find(Boolean);
        if (fresh && fresh[1]) { try { fs.writeFileSync(DELTA.file, JSON.stringify({ ...s, cookie: `hl_s=${fresh[1]}`, at: new Date().toISOString() }, null, 2), { mode: 0o600 }); } catch {} }
        const keep = sc.filter((c) => !/^hl_s=/.test(c)).map((c) => c.replace(/;\s*Secure/ig, '').replace(/;\s*Domain=[^;]+/ig, ''));
        if (keep.length) h['set-cookie'] = keep; else delete h['set-cookie'];
        if (/\/login/.test(h.location || '') && r.statusCode >= 300 && r.statusCode < 400) h.location = `http://127.0.0.1:${PORT}/?open=delta`;
        res.writeHead(r.statusCode, h); r.pipe(res);
      });
      up.on('error', (e) => { if (!res.headersSent) { res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }); res.end('Delta Hub에 연결할 수 없습니다: ' + e.message); } });
      req.pipe(up);
    });
    srv.on('upgrade', (req, sock, head) => {
      const s = deltaSession();
      if (!s || !(req.headers.cookie || '').split(/;\s*/).includes(`ccd_dk=${TOKEN}`)) return sock.destroy();
      const target = new URL(DELTA.hub);
      const t = require('tls').connect({ host: target.hostname, port: Number(target.port) || 443, servername: target.hostname }, () => {
        const hs = Object.entries({ ...req.headers, host: target.host, origin: target.origin, cookie: s.cookie }).map(([k2, v]) => `${k2}: ${v}`).join('\r\n');
        t.write(`${req.method} ${req.url} HTTP/1.1\r\n${hs}\r\n\r\n`); if (head?.length) t.write(head);
        t.pipe(sock); sock.pipe(t);
      });
      t.on('error', () => sock.destroy()); sock.on('error', () => t.destroy());
    });
    srv.on('error', (e) => console.error('[delta-ui]', e.message));
    srv.listen(DELTA.uiPort, '127.0.0.1', () => { deltaUiUp = true; console.log(`Delta Hub (logged in): http://127.0.0.1:${DELTA.uiPort}/?k=…`); });
  }

  return {
    enabled: !!DELTA,
    async handleApi(p, url, req, res, body, send) {
      if (!p.startsWith('/api/delta/')) return false;
      await deltaApi(p, url, req, res, body, send);
      return true;
    },
    overview: () => ({ delta: true }),
    start: () => startDeltaUi(),
  };
};
