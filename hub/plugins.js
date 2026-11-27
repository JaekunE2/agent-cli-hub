// Plugin host: optional features live in their own folders instead of patches to the hub's core files.
//
//   hub/plugins/<id>/          shipped with the repo (generic, off until configured)
//   hub/local/plugins/<id>/    machine-local plugins (gitignored); a local plugin with the same id wins
//
// A plugin folder holds plugin.json and any of:
//   plugin.json  { "id", "name", "description",
//                  "server": "server.js",            hub-side module (routes, overview fields, services, hooks)
//                  "cli": "cli.js",                  ccd commands and CLI hooks
//                  "scripts": ["ui.js"], "styles": ["ui.css"],   browser files, served at /plugins/<id>/<file>
//                  "assets": ["bridge.js"],          other files served at /plugins/<id>/<file>
//                  "valueFlags": ["date"],           ccd flags that take a value (--date 2026-01-01)
//                  "help": ["line", ...] }           lines added to `ccd help`
//
//   server.js: module.exports = (api) => ({
//     enabled?: boolean,                                   false = loaded but inactive (not configured)
//     handlePage?(p, url, req, res, send) → bool,          non-/api paths (pages, proxies); before the token check
//     handleApi?(p, url, req, res, body, send) → bool,     /api/* after the token check
//     overview?() → object,                                merged into /api/overview (keep keys unique)
//     start?(), stop?(),                                   background work; check api.instance for side instances
//     hooks?: { name(...args) }                            named extension points the core calls (docs/PLUGINS.md lists them)
//   })
//   api = { id, dir, hub, config, instance, baseDir, dataDir, secretsDir, log }
//
//   cli.js: module.exports = (ctx) => ({ commands?: { name: async () => {} }, hooks?: { name(...args) } })
//   ctx = everything ccd.js shares (api, die, flags, pos, rest, DIR, BASE, token, usageDir, readTarget, …)
'use strict';
const fs = require('fs');
const path = require('path');

const ROOTS = [path.join(__dirname, 'plugins'), path.join(__dirname, 'local', 'plugins')];

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }

/** every plugin folder with a plugin.json; local ones override shipped ones with the same id */
function discover() {
  const byId = new Map();
  for (const root of ROOTS) {
    let ents = [];
    try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      const dir = path.join(root, e.name);
      const man = readJson(path.join(dir, 'plugin.json'));
      if (!man) continue;
      const id = String(man.id || e.name);
      if (!/^[a-z0-9][a-z0-9_-]{0,47}$/.test(id)) continue;
      byId.set(id, { ...man, id, dir, local: root === ROOTS[1] });
    }
  }
  return [...byId.values()];
}

function config(baseDir) { return readJson(path.join(baseDir, 'config.json')) || {}; }

// ---------- hub side ----------
function createServerHost(hub) {
  const list = [];
  const secretsDir = hub.config.secretsDir || hub.config.calendar?.secretsDir || path.join(hub.baseDir, 'data', 'secrets');
  for (const man of discover()) {
    const entry = { man, mod: null, error: null };
    if (man.server) {
      try {
        const factory = require(path.join(man.dir, man.server));
        const dataDir = path.join(hub.baseDir, 'data', 'plugins', man.id);
        entry.mod = factory({
          id: man.id, dir: man.dir, hub, config: hub.config, instance: hub.instance || { main: true }, baseDir: hub.baseDir, dataDir, secretsDir,
          log: (...a) => console.log(`[${man.id}]`, ...a),
        }) || {};
      } catch (e) { entry.error = e.message; console.error(`[plugin ${man.id}]`, e.message); }
    }
    list.push(entry);
  }
  const active = () => list.filter((x) => x.mod && x.mod.enabled !== false);
  const safe = (id, fn) => { try { return fn(); } catch (e) { console.error(`[plugin ${id}]`, e.message); return undefined; } };

  return {
    list: () => list.map(({ man, mod, error }) => ({ id: man.id, name: man.name || man.id, local: man.local, enabled: mod ? mod.enabled !== false : !!man.cli && !error, cliOnly: !man.server, error })),
    async handlePage(p, url, req, res, send) {
      // browser files of a plugin: only the ones its plugin.json lists
      const m = /^\/plugins\/([a-z0-9_-]+)\/([\w.-]+)$/.exec(p);
      if (m) {
        const e = list.find((x) => x.man.id === m[1]);
        const files = e ? [...(e.man.scripts || []), ...(e.man.styles || []), ...(e.man.assets || [])] : [];
        if (!e || !files.includes(m[2])) { send(res, 404, { error: 'not found' }); return true; }
        const type = /\.css$/.test(m[2]) ? 'text/css' : /\.js$/.test(m[2]) ? 'text/javascript' : /\.html$/.test(m[2]) ? 'text/html; charset=utf-8' : 'application/octet-stream';
        const file = path.join(e.man.dir, m[2]);
        const text = /\.js$/.test(m[2]) && hub.I18N?.forFile ? safe(e.man.id, () => hub.I18N.forFile(file)) : null;
        // a plugin's service worker may control the whole hub page (plugin.json serviceWorker)
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache', ...(e.man.serviceWorker === m[2] ? { 'service-worker-allowed': '/' } : {}) });
        if (typeof text === 'string') res.end(text); else fs.createReadStream(file).pipe(res);
        return true;
      }
      for (const e of active()) if (e.mod.handlePage && await e.mod.handlePage(p, url, req, res, send)) return true;
      return false;
    },
    async handleApi(p, url, req, res, body, send) {
      if (p === '/api/plugins') { send(res, 200, { plugins: this.list() }); return true; }
      for (const e of active()) if (e.mod.handleApi && await e.mod.handleApi(p, url, req, res, body, send)) return true;
      return false;
    },
    overview() {
      const out = {};
      for (const e of active()) if (e.mod.overview) Object.assign(out, safe(e.man.id, () => e.mod.overview()) || {});
      return out;
    },
    start() { for (const e of active()) if (e.mod.start) safe(e.man.id, () => e.mod.start()); },
    stop() { for (const e of active()) if (e.mod.stop) safe(e.man.id, () => e.mod.stop()); },
    /** every active plugin's answer to a named hook (undefined answers dropped) */
    collect(name, ...args) {
      const out = [];
      for (const e of active()) { const h = e.mod.hooks?.[name]; if (typeof h === 'function') { const r = safe(e.man.id, () => h(...args)); if (r !== undefined) out.push(r); } }
      return out;
    },
    /** <script>/<link> tags for the page: enabled plugins only */
    pageTags() {
      return active().flatMap((e) => [
        ...(e.man.styles || []).map((f) => `<link rel="stylesheet" href="/plugins/${e.man.id}/${f}">`),
        ...(e.man.scripts || []).map((f) => `<script src="/plugins/${e.man.id}/${f}"></script>`),
      ]).join('\n');
    },
  };
}

// ---------- ccd side ----------
/** value-taking flags and help lines declared by plugins (read before ccd parses its arguments) */
function cliManifest() {
  const flags = new Set(), help = [];
  for (const m of discover()) {
    for (const f of m.valueFlags || []) flags.add(String(f));
    for (const h of m.help || []) help.push(String(h));
  }
  return { valueFlags: [...flags], help };
}
/** load the cli.js of every plugin: { commands, hooks: name → [fn] } */
function loadCli(ctx) {
  const commands = {}, hooks = {};
  for (const m of discover()) {
    if (!m.cli) continue;
    let mod;
    try { mod = require(path.join(m.dir, m.cli))({ ...ctx, plugin: { id: m.id, dir: m.dir }, config: config(ctx.DIR), hook: (name) => hooks[name]?.[0] }) || {}; }
    catch (e) { console.error(`[plugin ${m.id}] cli: ${e.message}`); continue; }
    Object.assign(commands, mod.commands || {});
    for (const [k, fn] of Object.entries(mod.hooks || {})) (hooks[k] ||= []).push(fn);
  }
  return { commands, hooks };
}

module.exports = { discover, createServerHost, cliManifest, loadCli };
