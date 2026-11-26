'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createWorkspaceContexts } = require('../workspace-contexts');
const { createWorkspaceSessions } = require('../workspace-sessions');
const { createWorkspaceFolderRoutes } = require('../routes-workspace-folders');

const sessionKey = 'session:codex:example-0001';
const endpoint = (key) => `/api/sessions/${encodeURIComponent(key)}/folders`;
const registry = '/api/trusted-folders';

async function openApi(file, hub) {
  const store = createWorkspaceContexts(file);
  const sessions = createWorkspaceSessions(hub, () => []);
  const send = (res, status, body) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  const errors = [];
  const handle = createWorkspaceFolderRoutes(store, sessions.resolve, (_tag, err) => errors.push(err));
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const authed = () => req.headers['x-token'] === 'fixture' && (!req.headers.origin || req.headers.origin === `http://${req.headers.host}`);
    if (!await handle(url.pathname, url, req, res, send, authed)) send(res, 404, {});
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');

  async function request(method, route, status, body, headers = {}) {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const result = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: server.address().port, method, path: route,
        headers: { 'x-token': 'fixture', ...(payload && { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }), ...headers } }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { text += chunk; });
        res.on('error', reject);
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
      });
      req.on('error', reject);
      req.end(payload);
    });
    assert.equal(result.status, status, JSON.stringify(result.body));
    return result.body;
  }
  return { request, errors, link: () => store.linkTerms(sessions.sessionLinks()),
    close: () => new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve())) };
}

function fixture(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-workspace-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const make = (...segments) => {
    const dir = path.join(tmp, ...segments);
    fs.mkdirSync(dir, { recursive: true });
    return fs.realpathSync.native(dir);
  };
  const root = make('Project');
  const child = make('Project', '자료');
  const sibling = make('Project-other');
  const docs = new Map([['example-0001', { agent: 'codex', cwd: root }]]);
  const terms = new Map();
  const hub = { terms, agentOf: (term) => term.agent, termSessionId: (term) => term.native,
    validSessionId: require('../project-history').sessionId, projects: { hidden: () => new Set() }, index: docs };
  return { file: path.join(tmp, 'workspace-contexts.json'), root, child, sibling, hub };
}

test('HTTP folder CRUD, canonical duplicates, legacy fallback and restart persistence', async (t) => {
  const { file, root, child, sibling, hub } = fixture(t);
  const route = endpoint(sessionKey);
  let api = await openApi(file, hub);
  t.after(() => api.close());
  let request = api.request;
  assert.deepEqual(await request('GET', registry, 200), { items: [], revision: 0 });
  const legacy = await request('GET', route, 200);
  assert.equal(legacy.primaryCwd, root);
  assert.deepEqual(legacy.referenceDirs, []);
  assert.equal(legacy.revision, 0);
  assert.equal(legacy.managed, false);
  assert.equal(legacy.trustSummary.state, 'untrusted');

  const input = { path: root, revision: 0 };
  const { item } = await request('POST', registry, 201, input);
  const alternate = process.platform === 'win32' ? root.toUpperCase().replaceAll('\\', '/') + '/' : `${root}/`;
  assert.equal((await request('POST', registry, 409, { ...input, path: alternate, revision: 1 })).code, 'FOLDER_EXISTS');
  const bound = await request('PUT', route, 200, { primaryCwd: alternate,
    referenceDirs: [child, sibling, child + path.sep, root], revision: 0 });
  assert.equal(bound.managed, true);
  assert.equal(bound.primaryCwd, root);
  assert.deepEqual(bound.referenceDirs, [child, sibling]);
  assert.deepEqual(bound.trustSummary.refs.map((ref) => ref.state), ['untrusted', 'untrusted']);

  const idRoute = `${registry}/${item.id}`;
  await request('PATCH', idRoute, 200, { includeDescendants: true, revision: 1 });
  const recursive = await request('GET', route, 200);
  assert.equal(recursive.trustSummary.primary.trustId, item.id);
  assert.deepEqual(recursive.trustSummary.refs.map((ref) => ref.trustId), [item.id, null]);
  const narrower = await request('POST', registry, 201, { path: child, revision: 2 });
  assert.equal((await request('GET', route, 200)).trustSummary.refs[0].trustId, narrower.item.id);
  await request('DELETE', `${registry}/${narrower.item.id}`, 200, { revision: 3 });
  assert.equal((await request('GET', route, 200)).trustSummary.refs[0].trustId, item.id);

  assert.equal((await request('PUT', route, 409, { primaryCwd: root, referenceDirs: [], revision: 0 })).code, 'REVISION_CONFLICT');
  const removed = await request('PUT', route, 200, { primaryCwd: root, referenceDirs: [child], revision: 1 });
  assert.deepEqual(removed.referenceDirs, [child]);
  assert.equal(removed.trustSummary.state, 'trusted');
  assert.deepEqual(api.errors, []);

  await api.close();
  api = await openApi(file, hub);
  request = api.request;
  assert.deepEqual(await request('GET', route, 200), removed);
  assert.equal((await request('GET', registry, 200)).revision, 4);
  await request('DELETE', idRoute, 200, { revision: 4 });
  assert.equal((await request('GET', route, 200)).trustSummary.state, 'untrusted');
});

test('HTTP writes require local authenticated requests and reject invalid folders and fields', async (t) => {
  const { file, root, child, hub } = fixture(t);
  const api = await openApi(file, hub);
  t.after(api.close);
  const { request } = api;
  const route = endpoint(sessionKey);
  await request('GET', registry, 401, undefined, { 'x-token': 'wrong' });
  await request('GET', registry, 401, undefined, { origin: 'http://unrelated.test' });
  const remote = { host: 'remote.test' };
  await request('GET', registry, 403, undefined, remote);
  await request('PUT', route, 403, {}, remote);
  assert.deepEqual(await request('GET', route, 200, undefined, remote), {
    sessionKey, revision: 0, managed: false, referenceCount: 0, trustState: 'untrusted', hasPendingChanges: false,
  });
  await request('GET', endpoint('session:codex:unknown-id'), 404);
  await request('POST', route, 405, {});
  await request('POST', registry, 400, { path: root, revision: 0, includeDescendants: null });
  await request('POST', registry, 400, { path: root, revision: 0, extra: true });
  await request('PUT', route, 400, { primaryCwd: root, referenceDirs: Array(17).fill(child), revision: 0 });
  await request('POST', registry, 413, { path: 'x'.repeat(65536), revision: 0 });
  const invalid = ['relative', path.join(root, 'missing'), path.parse(root).root];
  if (process.platform === 'win32') invalid.push('C:relative', '\\\\server\\share\\dir', `${root}:stream`, '\\\\?\\C:\\Windows');
  for (const dir of invalid) {
    const response = await request('POST', registry, 400, { path: dir, revision: 0, includeDescendants: true });
    assert.equal(response.code, 'INVALID_FOLDER');
  }
  assert.deepEqual(await request('GET', registry, 200), { items: [], revision: 0 });
  hub.index.set('ide-only-example', { agent: 'agy', observedDirs: [root, child] });
  const ide = endpoint('session:agy:ide-only-example');
  const observed = await request('GET', ide, 200);
  assert.equal(observed.primaryCwd, null);
  assert.deepEqual(observed.observedDirs, [root, child]);
  await request('PUT', ide, 403, { primaryCwd: root, referenceDirs: [], revision: 0 });
  assert.deepEqual(api.errors, []);
});

test('HTTP trust follows the real directory, fails closed after retarget, and transfers a verified term binding', async (t) => {
  const { file, root, child, sibling, hub } = fixture(t);
  const api = await openApi(file, hub);
  t.after(api.close);
  const { request } = api;
  const term = { agent: 'codex', cwd: root, meta: { spawnedAt: 1 } };
  hub.terms.set('27', term);
  const link = path.join(root, 'link');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  fs.symlinkSync(child, link, linkType);
  await request('POST', registry, 201, { path: root, revision: 0, includeDescendants: true });
  const termRoute = endpoint('term:27');
  const configured = await request('PUT', termRoute, 200, { primaryCwd: root, referenceDirs: [link], revision: 0 });
  assert.deepEqual(configured.referenceDirs, [child]);
  assert.equal(configured.trustSummary.state, 'trusted');

  term.native = 'example-0001';
  hub.terms.set('28', { ...term, meta: { spawnedAt: 2 } });
  assert.equal((await request('GET', endpoint(sessionKey), 200)).revision, 0);
  await request('PUT', endpoint(sessionKey), 409, { primaryCwd: root, referenceDirs: [], revision: 0 });
  hub.terms.delete('28');
  api.link();
  hub.terms.delete('27');
  assert.deepEqual((await request('GET', endpoint(sessionKey), 200)).referenceDirs, [child]);

  fs.unlinkSync(link);
  fs.symlinkSync(sibling, link, linkType);
  const retargeted = await request('GET', endpoint(sessionKey), 200);
  assert.equal(retargeted.trustSummary.refs[0].state, 'unknown');
  const rebound = await request('PUT', endpoint(sessionKey), 200, { primaryCwd: root, referenceDirs: [link], revision: 1 });
  assert.equal(rebound.trustSummary.refs[0].state, 'untrusted');
  assert.deepEqual(rebound.referenceDirs, [sibling]);
  assert.deepEqual(api.errors, []);
});
