// Optional integrations, all off unless config.json turns them on (nothing machine- or team-specific here):
//   driveUrl                → the "GX10 drive" file server (a drive-server.js reachable through a tunnel), files
//                             fetched for sessions land in drive-cache/
//   drives: {id: {label, url, local?, letter?, unc?, start?}}   more drive servers (e.g. a team NAS share whose
//                             files are also on this PC under `local`, so sessions get that path directly)
//   apps: [{id, label, icon, url, page?, bridge?, start?, hint?}]   local web apps embedded at /app-<id>/<token>/
//   delta: {portal, hub, uiPort?, defaultProject?, sessionFile?}    a Deltascale "AI Control Hub": login once here,
//                             then the hub page, `ccd delta` and the `ccd gpt` fallback use the saved session cookie;
//                             a loopback relay on uiPort opens the hub logged in (main instance only)
//   homelink: {url}         an HTTPS relay that serves this hub remotely (shown first in the remote/QR panel)
//   secretsDir              where session cookies etc. are kept (default: calendar.secretsDir, else data/secrets)
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

function createIntegrations(hub) {
  const { config: CONFIG, token: TOKEN, port: PORT, baseDir } = hub;
  const SECRETS = CONFIG.secretsDir || CONFIG.calendar?.secretsDir || path.join(baseDir, 'data', 'secrets');
  const withTimeout = (p, ms, fallback) => Promise.race([p, new Promise((r) => setTimeout(() => r(fallback), ms))]);
  const trim = (u) => String(u || '').replace(/\/+$/, '');
  const startScript = (file) => (hub.instance && !hub.instance.startServices) ? console.log(`[instance] side instance: not starting ${file}`) : spawn(/\.vbs$/i.test(file) ? 'wscript.exe' : file, /\.vbs$/i.test(file) ? [file] : [], { detached: true, stdio: 'ignore', windowsHide: true }).unref();

  // ---------- drives ----------
  const DRIVE_CACHE = path.join(baseDir, 'drive-cache');
  const DRIVES = {
    ...(CONFIG.driveUrl ? { gx10: { id: 'gx10', label: CONFIG.driveLabel || 'GX10 드라이브', url: trim(CONFIG.driveUrl), local: null } } : {}),
    ...Object.fromEntries(Object.entries(CONFIG.drives || {}).map(([id, d]) => [id, { id, ...d, url: trim(d.url) }])),
  };
  const driveOf = (id) => DRIVES[id || 'gx10'] || null;
  const driveLocalPath = (d, rel) => d.local.replace(/[\\/]+$/, '') + '\\' + String(rel).replace(/\//g, '\\');
  // Is a mapped share's drive letter alive? Never a sync fs call here: when the NAS stalls, existsSync('Z:\\')
  // blocked the whole server for 15–20 s. One check in flight per letter, result cached 60 s; null = no answer yet.
  const letterCache = new Map();
  function letterUp(letter, fresh) {
    const c = letterCache.get(letter);
    if (c && (c.pending || (!fresh && Date.now() - c.at < 60000))) return c.pending ? withTimeout(c.pending, 1500, c.val ?? null) : Promise.resolve(c.val);
    const e = c || { val: null, at: 0 }; letterCache.set(letter, e);
    e.pending = fs.promises.access(letter + '\\').then(() => true, () => false).then((v) => { e.val = v; e.at = Date.now(); e.pending = null; return v; });
    return withTimeout(e.pending, 1500, e.val ?? null);
  }
  function proxyDrive(req, res, send, pathAndQuery, id = 'gx10') {
    const dv = driveOf(id);
    if (!dv) return send(res, 404, { error: `drive "${id}" is not configured (config.json driveUrl / drives)` });
    const up = http.request(dv.url + pathAndQuery, { method: req.method, headers: { 'content-type': req.headers['content-type'] || 'application/octet-stream', ...(req.headers['content-length'] ? { 'content-length': req.headers['content-length'] } : {}), ...(req.headers.range ? { range: req.headers.range } : {}), 'x-drive': '1' } }, (r) => {
      const h = { ...r.headers }; delete h.connection;
      res.writeHead(r.statusCode, h); r.pipe(res);
    });
    up.on('error', (e) => {
      // a local share's drive server is down → start it again (at most every 30 s); the page can retry shortly
      if (e.code === 'ECONNREFUSED' && dv.start && Date.now() - (dv.restartedAt || 0) > 30000) {
        dv.restartedAt = Date.now();
        try { startScript(dv.start); } catch {}
        console.log(`[drive] ${dv.id} server down → restarting`);
      }
      if (!res.headersSent) { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: `${dv.label} 드라이브 서버에 연결할 수 없습니다 (${e.message}) — 터널/드라이브 서버가 켜져 있는지 확인하세요` })); }
    });
    if (req.method === 'GET' || req.method === 'HEAD') up.end(); else req.pipe(up);
  }

  // ---------- local web apps ----------
  function proxyApp(req, res, send, ap, base, pathAndQuery) {
    const target = new URL(ap.url);
    const headers = { ...req.headers, host: target.host }; delete headers.origin; delete headers.referer; delete headers['accept-encoding'];
    const up = http.request({ hostname: target.hostname, port: target.port, path: pathAndQuery, method: req.method, headers }, (r) => {
      const h = { ...r.headers }; delete h.connection;
      if (h.location && h.location.startsWith('/')) h.location = base + h.location;
      if (!/text\/html/i.test(h['content-type'] || '')) { res.writeHead(r.statusCode, h); return r.pipe(res); }
      let html = ''; r.setEncoding('utf8'); r.on('data', (d) => (html += d));
      r.on('end', () => {
        // the apps use root paths (/api, /static): prefix fetch / EventSource / XHR / image URLs with this base
        const shim = `<script>(function(){var B=${JSON.stringify(base)};function fx(u){return typeof u==='string'&&u.charAt(0)==='/'&&u.charAt(1)!=='/'&&u.indexOf(B+'/')!==0?B+u:u}`
          + 'var f=window.fetch;window.fetch=function(u,o){return f.call(this,fx(u),o)};'
          + 'var E=window.EventSource;if(E){window.EventSource=function(u,o){return new E(fx(u),o)};window.EventSource.prototype=E.prototype}'
          + 'var X=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){arguments[1]=fx(u);return X.apply(this,arguments)};'
          + "var d=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'src');Object.defineProperty(HTMLImageElement.prototype,'src',{set:function(v){d.set.call(this,fx(v))},get:function(){return d.get.call(this)}});"
          + '})();</script>';
        html = html.replace(/(\s(?:src|href|action)=["'])\/(?!\/)/g, `$1${base}/`).replace(/<head[^>]*>/i, (m) => m + shim);
        delete h['content-length'];
        res.writeHead(r.statusCode, h); res.end(html);
      });
    });
    up.on('error', (e) => {
      if (e.code === 'ECONNREFUSED' && ap.start && Date.now() - (ap.startedAt || 0) > 30000) {
        ap.startedAt = Date.now();
        try { startScript(ap.start); } catch {}
        console.log(`[app] ${ap.id} down → starting`);
      }
      if (!res.headersSent) send(res, 502, { error: `${ap.label} 서버(${ap.url})에 연결할 수 없습니다: ${e.message}${ap.hint ? ' — ' + ap.hint : ''}` });
    });
    if (req.method === 'GET' || req.method === 'HEAD') up.end(); else req.pipe(up);
  }

  // ---------- Delta Hub (Deltascale portal login: user + password + TOTP, posted once from here) ----------
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
  const stripToken = (search) => search.replace(/([?&])t=[^&]*&?/, '$1').replace(/[?&]$/, '');

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
    if (!DELTA || (hub.instance && !hub.instance.deltaUi)) return;
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

  // ---------- routes ----------
  const sameOrigin = (req) => !req.headers.origin || req.headers.origin === `http://${req.headers.host}` || req.headers.origin === `https://${req.headers.host}`;
  /** non-/api paths: /drive[-id]/<token>/… (drive web UI) and /app-<id>/<token>/… (local apps). true = handled */
  function handlePage(p, url, req, res, send) {
    const dm = /^\/drive(?:-([a-z0-9]+))?\/([A-Za-z0-9]+)(\/.*)?$/.exec(p);
    if (dm) {
      if (dm[2] !== TOKEN || !sameOrigin(req)) { send(res, 401, { error: 'bad token' }); return true; }
      if (!dm[3]) { res.writeHead(302, { location: `${p}/${url.search}` }); res.end(); return true; }
      proxyDrive(req, res, send, dm[3] + url.search, dm[1] || 'gx10');
      return true;
    }
    const am = /^\/app-([a-z0-9]+)\/([A-Za-z0-9]+)(\/.*)?$/.exec(p);
    if (am) {
      const ap = (CONFIG.apps || []).find((x) => x.id === am[1]);
      if (!ap) { send(res, 404, { error: 'unknown app' }); return true; }
      if (am[2] !== TOKEN || !sameOrigin(req)) { send(res, 401, { error: 'bad token' }); return true; }
      if (!am[3]) { res.writeHead(302, { location: `${p}/${url.search}` }); res.end(); return true; }
      // apps whose page is a local file (e.g. a phone app's llm.html) + a bridge script; the rest goes to ap.url
      if (ap.page && am[3] === '/') {
        try {
          const html = fs.readFileSync(ap.page, 'utf8'), shim = ap.bridge ? fs.readFileSync(path.join(baseDir, ap.bridge), 'utf8') : '';
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
          res.end(html.replace(/<head[^>]*>/i, (m) => `${m}<script>${shim}</script>`));
        } catch (e) { send(res, 500, { error: `${ap.label} 페이지를 읽지 못했습니다: ${e.message}` }); }
        return true;
      }
      proxyApp(req, res, send, ap, `/app-${am[1]}/${am[2]}`, am[3] + url.search);
      return true;
    }
    return false;
  }
  /** authenticated /api routes of these integrations. true = handled */
  async function handleApi(p, url, req, res, body, send) {
    if (p === '/api/apps') { send(res, 200, { apps: (CONFIG.apps || []).map(({ id, label, icon, sub }) => ({ id, label, icon, sub })) }); return true; }
    if (p.startsWith('/api/drive/')) { proxyDrive(req, res, send, '/api/' + p.slice('/api/drive/'.length) + stripToken(url.search), url.searchParams.get('d') || 'gx10'); return true; }
    if (p.startsWith('/api/delta/')) { await deltaApi(p, url, req, res, body, send); return true; }
    if (p === '/api/drives') {
      const out = await Promise.all(Object.values(DRIVES).map(async (d) => {
        const info = await withTimeout(new Promise((resolve) => { const rq = http.get(d.url + '/api/info', { timeout: 2500 }, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => { try { resolve(r.statusCode === 200 ? JSON.parse(b) : null); } catch { resolve(null); } }); }); rq.on('timeout', () => rq.destroy()); rq.on('error', () => resolve(null)); }), 4000, null);
        const letter = d.letter ? await letterUp(d.letter) : null;
        return { id: d.id, label: d.label, local: d.local || null, server: !!info, free: info?.free ?? null, total: info?.total ?? null, letter };
      }));
      send(res, 200, { drives: out });
      return true;
    }
    // (re)connect a share drive: map its letter (Windows saved credentials) and start its drive server if it is down
    if (p === '/api/drive-reconnect' && req.method === 'POST') {
      const b = await body(req);
      const d = driveOf(b.id);
      if (!d || d.id === 'gx10') { send(res, 400, { error: '이 드라이브는 다시 연결할 수 없습니다 (터널로 연결됨)' }); return true; }
      const steps = [];
      if (d.letter && d.unc && (await letterUp(d.letter, true)) === false) {
        const r = await new Promise((resolve) => execFile('net', ['use', d.letter, d.unc, '/persistent:yes'], { encoding: 'utf8', windowsHide: true, timeout: 30000 }, (e, so, se) => resolve({ status: e ? 1 : 0, stdout: so, stderr: se })));
        steps.push(r.status === 0 ? `${d.letter} 연결됨` : `${d.letter} 연결 실패: ${(r.stderr || r.stdout || '').trim().split('\n').pop()}`);
        letterCache.delete(d.letter);
      }
      const up = await new Promise((resolve) => { const rq = http.get(d.url + '/api/info', { timeout: 2500 }, (r) => { r.resume(); resolve(r.statusCode === 200); }); rq.on('timeout', () => rq.destroy()); rq.on('error', () => resolve(false)); });
      if (!up && d.start) { try { startScript(d.start); } catch {} steps.push('드라이브 서버 시작'); }
      send(res, 200, { ok: true, steps });
      return true;
    }
    // drive file → this PC (drive-cache/<same path>) so a session can read it: { path, d } → { local }
    if (p === '/api/drive-fetch' && req.method === 'POST') {
      const b = await body(req);
      const rel = String(b.path || '').replace(/\\/g, '/').replace(/^\/+/, '');
      if (!rel || rel.split('/').some((x) => x === '..')) { send(res, 400, { error: 'bad path' }); return true; }
      const dv = driveOf(b.d);
      if (!dv) { send(res, 404, { error: 'drive not configured' }); return true; }
      if (dv.local) { send(res, 200, { local: driveLocalPath(dv, rel) }); return true; }
      const local = path.join(DRIVE_CACHE, ...rel.split('/'));
      fs.mkdirSync(path.dirname(local), { recursive: true });
      const ok = await new Promise((resolve) => {
        http.get(`${dv.url}/api/file?path=${encodeURIComponent(rel)}`, (r) => {
          if (r.statusCode !== 200) { r.resume(); return resolve(`drive ${r.statusCode}`); }
          const tmp = local + '.part';
          const out = fs.createWriteStream(tmp);
          r.pipe(out);
          out.on('finish', () => { try { fs.renameSync(tmp, local); resolve(true); } catch (e) { resolve(e.message); } });
          out.on('error', (e) => resolve(e.message));
        }).on('error', (e) => resolve(e.message));
      });
      if (ok === true) send(res, 200, { local }); else send(res, 502, { error: String(ok) });
      return true;
    }
    return false;
  }

  return {
    handlePage, handleApi, startDeltaUi, deltaStatus,
    // overview fields for the UI: is the GX10 drive configured, and the other drives
    overviewFields: () => ({ drive: !!DRIVES.gx10, drives: Object.values(DRIVES).filter((d) => d.id !== 'gx10').map((d) => ({ id: d.id, label: d.label, sub: d.sub || '', local: d.local || null })), delta: !!DELTA, apps: (CONFIG.apps || []).length > 0 }),
    // remote URLs: a configured HTTPS relay first
    remoteUrls: () => (CONFIG.homelink?.url ? [CONFIG.homelink.url] : []),
    homelink: CONFIG.homelink || null,
  };
}

module.exports = { createIntegrations };
