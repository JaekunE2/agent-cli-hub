'use strict';
// Plugin API v1 contract (plugins.js). Every App Store plugin must pass it:
//   CCD_APP_DIRS="D:\src\app-a;D:\src\app-b" node --test tests/plugin-api.test.js
// Without CCD_APP_DIRS only the built-in fixtures run. For each app: plugin.json declares a supported apiVersion and
// a satisfied requires.ccd; it loads in a side-instance hub with settings from its app.json; it answers its own
// /api/plugins/<id>/ routes and nothing of the core (Apps / App Store, Google Drive, sessions, ...); its ccd
// commands stay in its namespace; browser files register under its id, CSS is scoped, Korean UI text has English;
// start → stop leaves no timers; all apps together load without collisions next to the shipped plugins.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const plugins = require('../plugins');

const HUB = path.resolve(__dirname, '..');
const CORE_API = ['/api/apps', '/api/apps-store', '/api/apps-store/package', '/api/overview', '/api/sessions', '/api/drive',
  '/api/research', '/api/gpu', '/api/schedules', '/api/plugins'];
const CORE_COMMANDS = (() => {
  const src = fs.readFileSync(path.join(HUB, 'ccd.js'), 'utf8');
  const body = src.slice(src.indexOf('const cmds = {'));
  return [...body.matchAll(/^ {2}async ([a-z][\w]*)\(\)/gm)].map((m) => m[1]);
})();
const coreDict = JSON.parse(fs.readFileSync(path.join(HUB, 'i18n', 'en.json'), 'utf8'));

function tmpdir(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), `ach-plugin-${tag}-`)); }

/** copy an app's plugin into a temp plugin root with settings.json made from app.json (paths → temp folders) */
function stage(appDir, root) {
  const app = JSON.parse(fs.readFileSync(path.join(appDir, 'app.json'), 'utf8'));
  const src = path.join(appDir, app.hubPlugin);
  const man = JSON.parse(fs.readFileSync(path.join(src, 'plugin.json'), 'utf8'));
  const dest = path.join(root, man.id);
  fs.cpSync(src, dest, { recursive: true });
  const work = tmpdir('work');
  const settings = {};
  for (const s of app.settings || []) {
    let v = String(s.default ?? '').replace(/\{\{APP_DIR\}\}/g, appDir).replace(/\{\{HUB_DIR\}\}/g, HUB);
    if (!v && (s.type === 'path' || s.required) && s.type !== 'url') v = fs.mkdtempSync(path.join(work, 'set-'));
    if (!v && s.type === 'url') v = 'https://example.invalid';
    settings[s.key] = v;
  }
  fs.writeFileSync(path.join(dest, 'settings.json'), JSON.stringify(settings));
  return { app, man, dest, work };
}

function hubStub(baseDir) {
  return { config: {}, baseDir, token: 't0ken', port: 7999, instance: { main: false, watchdog: false, recover: false, gpuGrant: false } };
}

function fakeRes() {
  const r = { status: 0, headersSent: false, writeHead(c) { r.status = c; r.headersSent = true; }, end() { r.headersSent = true; }, setHeader() {}, on() { return r; }, once() { return r; }, emit() { return true; }, write() { return true; } };
  return r;
}
async function callApi(host, p, method = 'GET') {
  const url = new URL(`http://127.0.0.1${p}`);
  const res = fakeRes();
  let sent = null;
  const send = (r, code, obj) => { r.status = code; r.headersSent = true; sent = obj; return true; };
  const req = { method, headers: {}, url: p, on() {}, resume() {}, pipe() {} };
  const handled = await host.handleApi(url.pathname, url, req, res, async () => ({}), send);
  return { handled, status: res.status, body: sent };
}

/** static checks of one plugin folder; returns a list of problems */
function staticProblems(dir) {
  const out = [];
  const man = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8'));
  if (man.apiVersion === undefined) out.push('plugin.json: apiVersion missing');
  const why = plugins.incompatible(man);
  if (why) out.push(`incompatible: ${why}`);
  for (const f of [man.server, man.cli, ...(man.scripts || []), ...(man.styles || []), ...(man.assets || [])].filter(Boolean)) {
    if (!fs.existsSync(path.join(dir, f))) out.push(`missing file ${f}`);
  }
  let dict = {};
  try { dict = JSON.parse(fs.readFileSync(path.join(dir, 'i18n', 'en.json'), 'utf8')); } catch {}
  const i18n = require('../i18n');
  for (const f of man.scripts || []) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    const reg = /HubPlugins\.register\(\{\s*id:\s*'([^']+)'/.exec(src);
    if (reg && reg[1] !== man.id) out.push(`${f}: registers as ${reg[1]}, not ${man.id}`);
    for (const m of src.matchAll(/['"`]\/api\/plugins\/([a-z0-9_-]+)/g)) if (m[1] !== man.id) out.push(`${f}: calls another plugin's API (${m[1]})`);
    for (const p of i18n.extract(src, 'js')) if (!(p in coreDict) && !(p in dict)) out.push(`${f}: no English for "${p}"`);
  }
  for (const f of man.styles || []) {
    const css = fs.readFileSync(path.join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/@media[^{]*\{/g, '');
    for (const m of css.matchAll(/([^{}]+)\{/g)) {
      for (const sel of m[1].split(',').map((x) => x.trim()).filter(Boolean)) {
        if (!sel.startsWith(`.${man.id}`) && !sel.startsWith(`#${man.id}`) && !sel.startsWith(`[data-plugin="${man.id}"]`)) out.push(`${f}: selector "${sel}" not scoped to ${man.id}`);
      }
    }
  }
  for (const f of [man.server, man.cli, ...(man.scripts || [])].filter(Boolean)) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    if (/require\(\s*['"]\.\.\/\.\.\/(?!\.\.)/.test(src) && !/plugins\.js/.test(f)) {
      // reaching into the hub's own modules is not part of the API (data comes through api / ctx)
      for (const m of src.matchAll(/require\(\s*['"](\.\.\/\.\.\/[^'"]+)['"]/g)) out.push(`${f}: requires hub module ${m[1]}`);
    }
    if (/(?:module|require\([^)]*\))\.prototype\s*\.\w+\s*=|Object\.defineProperty\(\s*require\(/.test(src)) out.push(`${f}: patches a module`);
  }
  return out;
}

async function contract(appDir) {
  const root = tmpdir('root');
  const base = tmpdir('hub');
  const { man, work } = stage(appDir, root);
  try {
    assert.deepEqual(staticProblems(path.join(root, man.id)), [], `${man.id}: static contract`);
    const before = process.getActiveResourcesInfo().filter((x) => x === 'Timeout').length;
    const host = plugins.createServerHost(hubStub(base), { roots: [root] });
    const me = host.list().find((p) => p.id === man.id);
    assert.ok(me, `${man.id}: discovered`);
    assert.equal(me.error, null, `${man.id}: loads (${me.error})`);
    assert.equal(me.apiVersion, 1);
    // it never answers a core / upstream route
    for (const p of CORE_API) {
      const r = await callApi(host, p);
      if (p === '/api/plugins') { assert.equal(r.handled, true); continue; }
      assert.equal(r.handled, false, `${man.id} answered core route ${p}`);
    }
    // it answers its own namespace (documented routes), without throwing
    if (man.server && me.enabled) {
      const own = (man.routes || []).map((r) => /^(\/api\/plugins\/[\w/-]+)/.exec(r)?.[1]).filter(Boolean).map((r) => r.replace(/\/\*$/, '/status'));
      for (const p of own.length ? own : [`/api/plugins/${man.id}`]) {
        const r = await callApi(host, p);
        assert.equal(r.handled, true, `${man.id}: does not answer its route ${p}`);
        assert.notEqual(r.status, 500, `${man.id}: ${p} threw (${JSON.stringify(r.body)})`);
      }
      const ov = host.overview();
      assert.equal(typeof ov, 'object');
    }
    // lifecycle: start → stop leaves no timers behind (side instance: start must not begin background work)
    host.start(); host.stop();
    await new Promise((r) => setTimeout(r, 50));
    const after = process.getActiveResourcesInfo().filter((x) => x === 'Timeout').length;
    assert.ok(after <= before, `${man.id}: ${after - before} timer(s) left after stop`);
    // ccd: commands only in its namespace, never a core command
    if (man.cli) {
      const cli = plugins.loadCli({ pluginRoots: [root], coreCommands: CORE_COMMANDS, DIR: base, api: async () => ({}), die: (m) => { throw new Error(m); }, flags: {}, pos: [], rest: [] });
      assert.deepEqual(cli.refused, [], `${man.id}: cli refused ${cli.refused.join('; ')}`);
      const allowed = new Set([man.id, ...(man.commands || [])]);
      for (const name of Object.keys(cli.commands)) assert.ok(allowed.has(name) && !CORE_COMMANDS.includes(name), `${man.id}: command ${name}`);
      assert.ok(cli.commands[man.id], `${man.id}: ccd ${man.id} is available`);
    }
    return man.id;
  } finally {
    for (const d of [root, base, work]) fs.rmSync(d, { recursive: true, force: true });
  }
}

// ---------- fixtures (always run) ----------
function fixtureApp(files, manifest, appSettings = []) {
  const dir = tmpdir('app');
  fs.mkdirSync(path.join(dir, 'plugin'));
  fs.writeFileSync(path.join(dir, 'app.json'), JSON.stringify({ id: 'fx', name: 'fx', requires: { ccd: '>=1.0.0' }, hubPlugin: 'plugin', settings: appSettings }));
  fs.writeFileSync(path.join(dir, 'plugin', 'plugin.json'), JSON.stringify(manifest));
  for (const [f, s] of Object.entries(files)) fs.writeFileSync(path.join(dir, 'plugin', f), s);
  return dir;
}

test('a well-behaved v1 plugin passes the contract', async () => {
  const dir = fixtureApp({
    'server.js': "module.exports = (api) => ({ handleApi(p, url, req, res, body, send) { if (!p.startsWith(api.routeBase)) return false; send(res, 200, { ok: true, settings: api.settings }); return true; }, overview: () => ({ fxDemo: 1 }) });",
    'cli.js': "module.exports = () => ({ commands: { fx: async () => {} } });",
  }, { id: 'fx-demo', apiVersion: 1, requires: { ccd: '>=1.0.0' }, server: 'server.js', cli: 'cli.js', commands: ['fx'], routes: ['/api/plugins/fx-demo'] });
  try { assert.equal(await contract(dir), 'fx-demo'); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the loader keeps v1 plugins in their namespace and refuses incompatible ones', async () => {
  const root = tmpdir('root'), base = tmpdir('hub');
  const mk = (id, man, server) => { fs.mkdirSync(path.join(root, id)); fs.writeFileSync(path.join(root, id, 'plugin.json'), JSON.stringify({ id, ...man })); if (server) fs.writeFileSync(path.join(root, id, 'server.js'), server); };
  const greedy = "module.exports = () => ({ handleApi(p, url, req, res, body, send) { send(res, 200, { mine: p }); return true; } });";
  mk('greedy', { apiVersion: 1, server: 'server.js', legacyApi: ['/api/apps', '/api/greedy-old'] }, greedy);
  mk('future', { apiVersion: 7, server: 'server.js' }, greedy);
  mk('old-hub', { apiVersion: 1, requires: { ccd: '>=99.0.0' }, server: 'server.js' }, greedy);
  mk('crashy', { apiVersion: 1, server: 'server.js' }, "throw new Error('boom at load');");
  mk('flaky', { apiVersion: 1, server: 'server.js' }, "module.exports = () => ({ handleApi(p) { if (p.startsWith('/api/plugins/flaky')) throw new Error('route boom'); return false; } });");
  try {
    const host = plugins.createServerHost(hubStub(base), { roots: [root] });
    const by = Object.fromEntries(host.list().map((p) => [p.id, p]));
    assert.match(by.future.error, /API v7/);
    assert.match(by['old-hub'].error, /needs CCD/);
    assert.match(by.crashy.error, /load failed/);
    assert.equal(by.greedy.error, null);
    // a greedy v1 plugin sees only its namespace and its own, unreserved legacy prefix
    assert.equal((await callApi(host, '/api/apps')).handled, false);
    assert.equal((await callApi(host, '/api/sessions')).handled, false);
    assert.equal((await callApi(host, '/api/plugins/greedy/x')).handled, true);
    const legacy = await callApi(host, '/api/greedy-old/y');
    assert.equal(legacy.handled, true);
    assert.equal(legacy.body.mine, '/api/plugins/greedy/y');   // rewritten into the namespace
    // a route that keeps throwing: 500s, then the plugin is switched off; the hub keeps answering
    for (let i = 0; i < 3; i++) assert.equal((await callApi(host, '/api/plugins/flaky/a')).status, 500);
    assert.match(host.list().find((p) => p.id === 'flaky').error, /disabled after 3/);
    assert.equal((await callApi(host, '/api/plugins/flaky/a')).handled, false);
    assert.equal((await callApi(host, '/api/plugins')).handled, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(base, { recursive: true, force: true }); }
});

test('v1 cli commands cannot take core or foreign names', () => {
  const root = tmpdir('root');
  const mk = (id, man, cli) => { fs.mkdirSync(path.join(root, id)); fs.writeFileSync(path.join(root, id, 'plugin.json'), JSON.stringify({ id, apiVersion: 1, cli: 'cli.js', ...man })); fs.writeFileSync(path.join(root, id, 'cli.js'), cli); };
  mk('aa', { commands: ['shared'] }, "module.exports = () => ({ commands: { aa: async () => 'aa', shared: async () => 'aa', ls: async () => 'x', stray: async () => 'x' }, hooks: { notAHook() {}, gptFallback() {} } });");
  mk('bb', { commands: ['shared'] }, "module.exports = () => ({ commands: { shared: async () => 'bb' } });");
  try {
    const cli = plugins.loadCli({ pluginRoots: [root], coreCommands: ['ls', 'gpu'], DIR: root });
    assert.deepEqual(Object.keys(cli.commands).sort(), ['aa', 'shared']);   // bb's only command was refused: nothing of bb
    assert.ok(cli.refused.some((r) => /aa: command "ls" is a core command/.test(r)));
    assert.ok(cli.refused.some((r) => /aa: command "stray" is outside/.test(r)));
    assert.ok(cli.refused.some((r) => /bb: command "shared" belongs to aa/.test(r)));
    assert.ok(cli.refused.some((r) => /unknown hook notAHook/.test(r)));
    assert.equal(cli.hooks.gptFallback.length, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ---------- the App Store apps (CCD_APP_DIRS) ----------
const appDirs = String(process.env.CCD_APP_DIRS || '').split(';').map((x) => x.trim()).filter(Boolean)
  .filter((d) => fs.existsSync(path.join(d, 'app.json')));
for (const dir of appDirs) {
  const app = JSON.parse(fs.readFileSync(path.join(dir, 'app.json'), 'utf8'));
  test(`app ${app.id}: manifest declares the platform`, () => {
    assert.ok(app.requires?.ccd, 'app.json requires.ccd');
    const { satisfies } = require('../app-store-local');
    assert.ok(satisfies(require('../package.json').version, app.requires.ccd), `this hub satisfies ${app.requires.ccd}`);
  });
  if (app.hubPlugin) test(`app ${app.id}: plugin contract`, async () => { await contract(dir); });
}

test('all App Store plugins load together next to the shipped plugins; upstream Apps / App Store routes stay with the core', async () => {
  const root = tmpdir('root'), base = tmpdir('hub');
  try {
    const ids = [];
    for (const dir of appDirs) {
      const app = JSON.parse(fs.readFileSync(path.join(dir, 'app.json'), 'utf8'));
      if (!app.hubPlugin) continue;
      const { man, dest } = stage(dir, root);
      ids.push(man.id);
      void dest;
    }
    const host = plugins.createServerHost(hubStub(base), { roots: [path.join(HUB, 'plugins'), root] });
    for (const id of ids) assert.equal(host.list().find((p) => p.id === id)?.error, null, `${id} loads with the others`);
    for (const p of CORE_API.filter((x) => x !== '/api/plugins')) assert.equal((await callApi(host, p)).handled, false, `a plugin took ${p}`);
    // upstream's Apps / App Store module answers its routes with every plugin present
    const createApps = require('../apps');
    const apps = createApps({ dataFile: path.join(base, 'apps.json'), runsFile: path.join(base, 'runs.json'), secretsDir: path.join(base, 's'),
      pluginsDir: path.join(base, 'pl'), storeFetch: async () => { throw new Error('offline'); }, listPlugins: () => host.list().map((p) => p.id) });
    const out = {};
    const send = (code, obj) => { out.code = code; out.body = obj; return true; };
    const go = async (p) => { const url = new URL(`http://x${p}`); await apps.handle(url.pathname, url, { method: 'GET', headers: {} }, async () => ({}), send, fakeRes()); return { ...out }; };
    assert.equal((await go('/api/apps')).code, 200);
    const store = await go('/api/apps-store');
    assert.equal(store.code, 200);
    assert.ok(Array.isArray(store.body.entries));
    apps.stop();
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(base, { recursive: true, force: true }); }
});
