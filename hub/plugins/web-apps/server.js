'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

// Web apps plugin: local web apps embedded in the hub at /app-<id>/<token>/ (they use root paths, so HTML gets a
// small shim that prefixes fetch / EventSource / XHR / image URLs). config webApps (older configs: "apps" when it
// is a list of {id, url}): [{id, label, icon, url, page?, bridge?, start?, hint?}]. `page` = a local HTML file
// served as the app's start page with `bridge` (a script in this plugin, e.g. llm-web-bridge.js) injected.
// It also adds config homelink.url (an HTTPS relay that serves the hub) first to the remote-access URLs.
module.exports = function webAppsPlugin(api) {
  const { hub, config: CONFIG, secretsDir: SECRETS } = api;
  const { token: TOKEN, port: PORT, baseDir } = hub;
  const withTimeout = (p, ms, fallback) => Promise.race([p, new Promise((r) => setTimeout(() => r(fallback), ms))]);
  const trim = (u) => String(u || '').replace(/\/+$/, '');
  // start a configured helper (app / drive server) that is down; side hub instances never start anything
  const startScript = (file) => (api.instance && !api.instance.startServices) ? api.log(`side instance: not starting ${file}`)
    : spawn(/\.vbs$/i.test(file) ? 'wscript.exe' : file, /\.vbs$/i.test(file) ? [file] : [], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  const sameOrigin = (req) => !req.headers.origin || req.headers.origin === `http://${req.headers.host}` || req.headers.origin === `https://${req.headers.host}`;
  const stripToken = (search) => search.replace(/([?&])t=[^&]*&?/, '$1').replace(/[?&]$/, '');
  const CFG_APPS = Array.isArray(CONFIG.webApps) ? CONFIG.webApps : Array.isArray(CONFIG.apps) ? CONFIG.apps.filter((a) => a && a.id && (a.url || a.page)) : [];
  // a bridge named like a file of this plugin is read from here (older configs said public/llm-web-bridge.js)
  const bridgeFile = (b) => { const own = path.join(api.dir, path.basename(String(b))); return fs.existsSync(own) ? own : path.resolve(baseDir, String(b)); };
  const WEBAPPS = CFG_APPS;
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

  function handlePage(p, url, req, res, send) {
    const am = /^\/app-([a-z0-9]+)\/([A-Za-z0-9]+)(\/.*)?$/.exec(p);
    if (am) {
      const ap = WEBAPPS.find((x) => x.id === am[1]);
      if (!ap) { send(res, 404, { error: 'unknown app' }); return true; }
      if (am[2] !== TOKEN || !sameOrigin(req)) { send(res, 401, { error: 'bad token' }); return true; }
      if (!am[3]) { res.writeHead(302, { location: `${p}/${url.search}` }); res.end(); return true; }
      // apps whose page is a local file (e.g. a phone app's llm.html) + a bridge script; the rest goes to ap.url
      if (ap.page && am[3] === '/') {
        try {
          const html = fs.readFileSync(ap.page, 'utf8'), shim = ap.bridge ? fs.readFileSync(bridgeFile(ap.bridge), 'utf8') : '';
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
  async function handleApi(p, url, req, res, body, send) {
    if (p === '/api/webapps') { send(res, 200, { apps: WEBAPPS.map(({ id, label, icon, sub }) => ({ id, label, icon, sub })) }); return true; }
    return false;
  }
  return {
    enabled: WEBAPPS.length > 0 || !!CONFIG.homelink?.url,
    handlePage, handleApi,
    overview: () => ({ webApps: WEBAPPS.length > 0, ...(CONFIG.homelink?.url ? { relay: { url: CONFIG.homelink.url } } : {}) }),
    hooks: { remoteUrls: () => (CONFIG.homelink?.url ? [CONFIG.homelink.url] : undefined) },
  };
};
