'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

// Drives plugin: file servers (drive-server.js style: /api/list, /api/file, /api/info …) shown in the hub,
// usable by sessions and by `ccd drive`.
//   config driveUrl (+ driveLabel)   the main drive (id "gx10" for compatibility), e.g. reached through a tunnel
//   config drives: {id: {label, url, local?, letter?, unc?, start?, sub?}}   more drives; `local` = the same files on
//                                    this PC (sessions get that path, nothing is copied)
// Routes: /drive[-id]/<token>/… (the drive's own web page), /api/netdrive/<op> (proxy), /api/drives,
// /api/drive-reconnect, /api/drive-fetch (file → drive-cache/ for a session).
module.exports = function drivesPlugin(api) {
  const { hub, config: CONFIG, secretsDir: SECRETS } = api;
  const { token: TOKEN, port: PORT, baseDir } = hub;
  const withTimeout = (p, ms, fallback) => Promise.race([p, new Promise((r) => setTimeout(() => r(fallback), ms))]);
  const trim = (u) => String(u || '').replace(/\/+$/, '');
  // start a configured helper (app / drive server) that is down; side hub instances never start anything
  const startScript = (file) => (api.instance && !api.instance.startServices) ? api.log(`side instance: not starting ${file}`)
    : spawn(/\.vbs$/i.test(file) ? 'wscript.exe' : file, /\.vbs$/i.test(file) ? [file] : [], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  const sameOrigin = (req) => !req.headers.origin || req.headers.origin === `http://${req.headers.host}` || req.headers.origin === `https://${req.headers.host}`;
  const stripToken = (search) => search.replace(/([?&])t=[^&]*&?/, '$1').replace(/[?&]$/, '');
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

  function handlePage(p, url, req, res, send) {
    const dm = /^\/drive(?:-([a-z0-9]+))?\/([A-Za-z0-9]+)(\/.*)?$/.exec(p);
    if (dm) {
      if (dm[2] !== TOKEN || !sameOrigin(req)) { send(res, 401, { error: 'bad token' }); return true; }
      if (!dm[3]) { res.writeHead(302, { location: `${p}/${url.search}` }); res.end(); return true; }
      proxyDrive(req, res, send, dm[3] + url.search, dm[1] || 'gx10');
      return true;
    }
    return false;
  }
  async function handleApi(p, url, req, res, body, send) {
    if (p.startsWith('/api/netdrive/')) { proxyDrive(req, res, send, '/api/' + p.slice('/api/netdrive/'.length) + stripToken(url.search), url.searchParams.get('d') || 'gx10'); return true; }
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
    enabled: Object.keys(DRIVES).length > 0,
    handlePage, handleApi,
    overview: () => ({ drive: !!DRIVES.gx10, drives: Object.values(DRIVES).filter((d) => d.id !== 'gx10').map((d) => ({ id: d.id, label: d.label, sub: d.sub || '', local: d.local || null })) }),
  };
};
