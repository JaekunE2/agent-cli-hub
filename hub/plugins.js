// Plugin host: optional features live in their own folders instead of patches to the hub's core files.
//
//   hub/plugins/<id>/          shipped with the repo (generic, off until configured)
//   hub/local/plugins/<id>/    machine-local plugins (gitignored; App Store apps install theirs here); a local
//                              plugin with the same id wins
//
// A plugin folder holds plugin.json and any of:
//   plugin.json  { "id", "name", "description",
//                  "apiVersion": 1,                  the plugin API it is written for (see below; App Store plugins must set it)
//                  "requires": { "ccd": ">=1.0.0" }, hub versions it works with
//                  "server": "server.js",            hub-side module (routes, overview fields, services, hooks)
//                  "cli": "cli.js",                  ccd commands and CLI hooks
//                  "commands": ["alias"],            v1: extra ccd command names besides `ccd <id>` (never a core command)
//                  "legacyApi": ["/api/old"],        v1: old route prefixes still answered for one minor version (deprecated)
//                  "scripts": ["ui.js"], "styles": ["ui.css"],   browser files, served at /plugins/<id>/<file>
//                  "assets": ["bridge.js"],          other files served at /plugins/<id>/<file>
//                  "valueFlags": ["date"],           ccd flags that take a value (--date 2026-01-01)
//                  "help": ["line", ...],            lines added to `ccd help`
//                  "provides": { "researchHarness": "${HARNESS_DIR}" },   hub-wide values, ${KEY} from settings.json
//                  "routes": [...] }                 documentation only (the store shows it)
//
//   server.js: module.exports = (api) => ({
//     enabled?: boolean,                                   false = loaded but inactive (not configured)
//     handlePage?(p, url, req, res, send) → bool,          non-/api paths (pages, proxies); before the token check
//     handleApi?(p, url, req, res, body, send) → bool,     /api/* after the token check
//     overview?() → object,                                merged into /api/overview (keep keys unique)
//     start?(), stop?(),                                   background work; check api.instance for side instances
//     hooks?: { name(...args) }                            named extension points the core calls (HOOKS below)
//   })
//   api = { id, dir, hub, config, settings, instance, baseDir, dataDir, secretsDir, log, apiVersion, routeBase }
//   settings = <plugin dir>/settings.json: values the user gave when the plugin came with an App Store app
//
//   cli.js: module.exports = (ctx) => ({ commands?: { name: async () => {} }, hooks?: { name(...args) } })
//   ctx = everything ccd.js shares (api, die, flags, pos, rest, DIR, BASE, token, usageDir, readTarget, …) + settings
//
// Plugin API v1 (apiVersion 1) — what a plugin that declares it gets, and the only things it may use:
//   routes   /api/plugins/<id>/… (after the token check) and /plugins/<id>/… (pages, before it); nothing else reaches
//            it, so it cannot shadow a core, upstream or other plugin route. legacyApi prefixes are forwarded,
//            rewritten to the namespace, with a deprecation warning, unless a core or another plugin owns them.
//   ccd      `ccd <id> …` plus declared aliases; a name the core or another plugin uses is refused.
//   hooks    HOOKS only; overview keys may not collide with another plugin's.
//   faults   a plugin that throws while loading is disabled and reported (/api/plugins); one whose route throws
//            3 times is disabled until the next start. The hub keeps running either way.
// Plugins without apiVersion (shipped / machine-local) keep the earlier, unrestricted behaviour.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOTS = [path.join(__dirname, 'plugins'), path.join(__dirname, 'local', 'plugins')];
const API_VERSIONS = [1];                       // plugin API versions this hub supports
const HOOKS = ['remoteUrls', 'calendarSources', 'gpuRunCheck', 'gpuRunRemote', 'gptFallback'];
const MAX_FAULTS = 3;
const HUB_VERSION = (() => { try { return require('./package.json').version; } catch { return '0.0.0'; } })();

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }

/** every plugin folder with a plugin.json; local ones override shipped ones with the same id */
function discover(roots = ROOTS) {
  const byId = new Map();
  for (const root of roots) {
    let ents = [];
    try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      const dir = path.join(root, e.name);
      const man = readJson(path.join(dir, 'plugin.json'));
      if (!man) continue;
      const id = String(man.id || e.name);
      if (!/^[a-z0-9][a-z0-9_-]{0,47}$/.test(id)) continue;
      byId.set(id, { ...man, id, dir, local: root !== ROOTS[0] });
    }
  }
  return [...byId.values()];
}

function config(baseDir) { return readJson(path.join(baseDir, 'config.json')) || {}; }
function settings(dir) { return readJson(path.join(dir, 'settings.json')) || {}; }
const versioned = (man) => man.apiVersion !== undefined;

/** why this hub cannot load a versioned plugin ('' = it can) */
function incompatible(man, hubVersion = HUB_VERSION) {
  if (!versioned(man)) return '';
  if (!API_VERSIONS.includes(Number(man.apiVersion))) return `plugin API v${man.apiVersion} is not supported by this hub (supports v${API_VERSIONS.join(', v')})`;
  const range = man.requires?.ccd;
  if (range) {
    const { satisfies } = require('./app-store-local');
    if (!satisfies(hubVersion, range)) return `needs CCD ${range}, this hub is ${hubVersion}`;
  }
  return '';
}

/** a hub-wide value some plugin provides (plugin.json "provides"), e.g. provided('researchHarness') → a folder */
function provided(key) {
  for (const m of discover()) {
    const v = m.provides && m.provides[key];
    if (typeof v !== 'string' || !v || incompatible(m)) continue;
    const st = settings(m.dir);
    const out = v.replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (_, k) => (st[k] === undefined ? '' : String(st[k])));
    if (out.trim()) return path.resolve(m.dir, out.trim());
  }
  return null;
}

// core route prefixes a plugin's legacyApi may never claim
const RESERVED_API = ['/api/apps', '/api/apps-store', '/api/plugins', '/api/overview', '/api/sessions', '/api/terms', '/api/projects',
  '/api/schedules', '/api/research', '/api/gpu', '/api/artifacts', '/api/calendar', '/api/usage', '/api/vault', '/api/upload', '/api/drive'];
const under = (p, prefix) => p === prefix || p.startsWith(prefix + '/');

// ---------- hub side ----------
function createServerHost(hub, opts = {}) {
  const list = [];
  const secretsDir = hub.config.secretsDir || hub.config.calendar?.secretsDir || path.join(hub.baseDir, 'data', 'secrets');
  const warned = new Set();
  const warn = (id, msg) => { const k = `${id}:${msg}`; if (!warned.has(k)) { warned.add(k); console.warn(`[plugin ${id}] ${msg}`); } };
  const legacyOwners = new Map();     // legacy prefix → plugin id
  for (const man of discover(opts.roots)) {
    const entry = { man, mod: null, error: incompatible(man, hub.version), faults: 0, v1: versioned(man) };
    if (entry.v1 && !entry.error) {
      for (const pre of Array.isArray(man.legacyApi) ? man.legacyApi : []) {
        const pfx = String(pre).replace(/\/+$/, '');
        if (!/^\/api\/[\w-]+$/.test(pfx) || RESERVED_API.some((r) => under(pfx, r) || under(r, pfx))) { warn(man.id, `legacyApi ${pre} refused (reserved)`); continue; }
        if (legacyOwners.has(pfx)) { warn(man.id, `legacyApi ${pre} refused (used by ${legacyOwners.get(pfx)})`); continue; }
        legacyOwners.set(pfx, man.id);
      }
    }
    if (man.server && !entry.error) {
      try {
        const factory = require(path.join(man.dir, man.server));
        const dataDir = path.join(hub.baseDir, 'data', 'plugins', man.id);
        entry.mod = factory({
          id: man.id, dir: man.dir, hub, config: hub.config, settings: settings(man.dir), instance: hub.instance || { main: true }, baseDir: hub.baseDir, dataDir, secretsDir,
          apiVersion: entry.v1 ? Number(man.apiVersion) : 0, routeBase: `/api/plugins/${man.id}`,
          log: (...a) => console.log(`[${man.id}]`, ...a),
        }) || {};
        if (entry.v1) {
          for (const k of Object.keys(entry.mod.hooks || {})) if (!HOOKS.includes(k)) { warn(man.id, `unknown hook ${k} ignored`); delete entry.mod.hooks[k]; }
        }
      } catch (e) { entry.error = `load failed: ${e.message}`; entry.mod = null; console.error(`[plugin ${man.id}]`, e.message); }
    } else if (entry.error) console.error(`[plugin ${man.id}] not loaded: ${entry.error}`);
    list.push(entry);
  }
  const active = () => list.filter((x) => x.mod && x.mod.enabled !== false && !x.disabled);
  const safe = (id, fn) => { try { return fn(); } catch (e) { console.error(`[plugin ${id}]`, e.message); return undefined; } };
  // a route that throws: 500 for that request; after MAX_FAULTS the plugin is switched off until the next start
  const guarded = async (e, send, res, fn) => {
    try { return await fn(); } catch (err) {
      e.faults++;
      console.error(`[plugin ${e.man.id}] route error ${e.faults}/${MAX_FAULTS}:`, err.message);
      if (e.faults >= MAX_FAULTS) { e.disabled = true; e.error = `disabled after ${MAX_FAULTS} errors: ${err.message}`; safe(e.man.id, () => e.mod.stop?.()); }
      if (!res.headersSent) send(res, 500, { error: `plugin ${e.man.id}: ${err.message}` });
      return true;
    }
  };

  return {
    list: () => list.map(({ man, mod, error, v1, disabled }) => ({ id: man.id, name: man.name || man.id, local: man.local, apiVersion: v1 ? Number(man.apiVersion) : null,
      enabled: !disabled && !error && (mod ? mod.enabled !== false : !!(man.cli || man.provides)), cliOnly: !man.server, error: error || null })),
    async handlePage(p, url, req, res, send) {
      // browser files of a plugin: only the ones its plugin.json lists
      const m = /^\/plugins\/([a-z0-9_-]+)\/([\w.-]+)$/.exec(p);
      if (m) {
        const e = list.find((x) => x.man.id === m[1]);
        const files = e && !e.error ? [...(e.man.scripts || []), ...(e.man.styles || []), ...(e.man.assets || [])] : [];
        if (files.includes(m[2])) {
          const type = /\.css$/.test(m[2]) ? 'text/css' : /\.js$/.test(m[2]) ? 'text/javascript' : /\.html$/.test(m[2]) ? 'text/html; charset=utf-8' : 'application/octet-stream';
          const file = path.join(e.man.dir, m[2]);
          const text = /\.js$/.test(m[2]) && hub.I18N?.forFile ? safe(e.man.id, () => hub.I18N.forFile(file, path.join(e.man.dir, 'i18n', 'en.json'))) : null;
          // a plugin's service worker may control the whole hub page (plugin.json serviceWorker)
          res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache', ...(e.man.serviceWorker === m[2] ? { 'service-worker-allowed': '/' } : {}) });
          if (typeof text === 'string') res.end(text); else fs.createReadStream(file).pipe(res);
          return true;
        }
        if (!e || !e.v1) { send(res, 404, { error: 'not found' }); return true; }
      }
      for (const e of active()) {
        if (!e.mod.handlePage) continue;
        if (e.v1 && !under(p, `/plugins/${e.man.id}`)) continue;          // v1: its own page prefix only
        if (await guarded(e, send, res, () => e.mod.handlePage(p, url, req, res, send))) return true;
      }
      return false;
    },
    async handleApi(p, url, req, res, body, send) {
      if (p === '/api/plugins') { send(res, 200, { plugins: this.list(), apiVersions: API_VERSIONS, hooks: HOOKS }); return true; }
      for (const e of active()) {
        if (!e.mod.handleApi) continue;
        let q = p;
        if (e.v1) {
          const base = `/api/plugins/${e.man.id}`;
          if (!under(p, base)) {
            const legacy = [...legacyOwners].find(([pfx, id]) => id === e.man.id && under(p, pfx));
            if (!legacy) continue;
            warn(e.man.id, `deprecated route ${legacy[0]} → use ${base}`);
            q = base + p.slice(legacy[0].length);
          }
        }
        if (await guarded(e, send, res, () => e.mod.handleApi(q, url, req, res, body, send))) return true;
      }
      return false;
    },
    overview() {
      const out = {}, owner = {};
      for (const e of active()) {
        if (!e.mod.overview) continue;
        const o = safe(e.man.id, () => e.mod.overview()) || {};
        for (const [k, v] of Object.entries(o)) {
          if (owner[k] && e.v1) { warn(e.man.id, `overview key ${k} already used by ${owner[k]}`); continue; }
          owner[k] = e.man.id; out[k] = v;
        }
      }
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
    if (incompatible(m)) continue;
    for (const f of m.valueFlags || []) flags.add(String(f));
    for (const h of m.help || []) help.push(String(h));
  }
  return { valueFlags: [...flags], help };
}
/** load the cli.js of every plugin: { commands, hooks: name → [fn], refused: [...] }. ctx.coreCommands = core names */
function loadCli(ctx) {
  const commands = {}, hooks = {}, refused = [];
  const core = new Set(ctx.coreCommands || []);
  const owner = {};
  for (const m of discover(ctx.pluginRoots)) {
    if (!m.cli) continue;
    const why = incompatible(m);
    if (why) { refused.push(`${m.id}: ${why}`); continue; }
    let mod;
    try { mod = require(path.join(m.dir, m.cli))({ ...ctx, plugin: { id: m.id, dir: m.dir }, config: config(ctx.DIR), settings: settings(m.dir), hook: (name) => hooks[name]?.[0] }) || {}; }
    catch (e) { console.error(`[plugin ${m.id}] cli: ${e.message}`); continue; }
    const allowed = versioned(m) ? new Set([m.id, ...(Array.isArray(m.commands) ? m.commands : [])]) : null;
    for (const [name, fn] of Object.entries(mod.commands || {})) {
      if (allowed && (!allowed.has(name) || core.has(name) || owner[name])) { refused.push(`${m.id}: command "${name}" ${core.has(name) ? 'is a core command' : owner[name] ? `belongs to ${owner[name]}` : 'is outside its namespace'}`); continue; }
      owner[name] = m.id; commands[name] = fn;
    }
    // v1: the plugin id is always its command namespace (`ccd <id> …`), even when it chose an alias
    if (allowed && !commands[m.id] && !core.has(m.id) && !owner[m.id]) {
      const first = Object.keys(mod.commands || {}).find((n) => owner[n] === m.id);
      if (first) { commands[m.id] = commands[first]; owner[m.id] = m.id; }
    }
    for (const [k, fn] of Object.entries(mod.hooks || {})) {
      if (versioned(m) && !HOOKS.includes(k)) { refused.push(`${m.id}: unknown hook ${k}`); continue; }
      (hooks[k] ||= []).push(fn);
    }
  }
  return { commands, hooks, refused };
}

module.exports = { discover, createServerHost, cliManifest, loadCli, provided, incompatible, API_VERSIONS, HOOKS, RESERVED_API };
