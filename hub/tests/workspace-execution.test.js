'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createSessionRoutes } = require('../routes-sessions');
const { createWorkspaceContexts } = require('../workspace-contexts');
const { createWorkspaceExecution } = require('../workspace-execution');
const { resolveLaunchFolders } = require('../workspace-launch');
const { folderInspector } = require('../workspace-paths');

test('term start, resume and input honor saved folders and current trust', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-launch-folders-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ref = path.join(root, '한글 reference & files');
  const secondRef = path.join(root, 'other reference');
  fs.mkdirSync(ref);
  fs.mkdirSync(secondRef);
  const inspector = await folderInspector();
  const store = createWorkspaceContexts(path.join(root, 'store.json'));
  const folders = { primaryCwd: root, referenceDirs: [ref + path.sep, secondRef, ref] };
  const canonicalRefs = [ref, secondRef].map(dir => inspector.inspect(dir).path);
  const writes = [];
  const sessionId = 'abcd-1234';
  const hub = {
    terms: new Map(), claudeDir: root, config: {}, projects: { hidden: () => new Set() },
    index: new Map([[sessionId, { agent: 'codex', cwd: root }]]),
    agentOf: () => 'codex', termSessionId: () => sessionId, validSessionId: () => true,
    cliModelEffortArgs: () => [], codexLaunch: (args) => ({ cmd: 'codex.exe', args }),
    termInfo: ({ id }) => ({ id }), createTerm(options) {
      const launch = resolveLaunchFolders({ ...options, cli: options.workspaceCli, plan: options.workspaceLaunch });
      const id = String(this.terms.size + 1);
      this.workspaceExecution.rememberLaunch(id, Number(id), options.workspaceLaunch);
      const term = { id, cwd: launch.cwd, launch, exited: null, spawnResult: { ok: true },
        meta: { spawnedAt: Number(id), workspaceFolders: { row: options.workspaceLaunch.row, applied: launch.applied } } };
      this.terms.set(id, term);
      return term;
    },
  };
  const routes = createSessionRoutes(hub);
  hub.workspaceExecution = createWorkspaceExecution(store, routes.folderSession, async () => inspector);
  const req = { method: 'POST', headers: { host: 'localhost:7777' }, socket: { remoteAddress: '::1', localPort: 7777 } };
  const call = async (route, body, request = req) => {
    let response;
    await routes.handleSessionRoutes(route, null, request, null, async () => body,
      (_, status, value) => { response = { status, ...value }; }, () => true);
    return response;
  };
  const start = (body, request) => call('/api/term/new', { kind: 'codex', ...body }, request);
  assert.equal((await start({ folders }, { method: 'POST' })).code, 'LOCAL_REQUIRED');
  assert.equal(hub.terms.size, 0);
  assert.equal((await start({ folders, cwd: ref })).code, 'WORKSPACE_MISMATCH');
  const started = await start({ folders, skipPermissions: true });
  assert.equal(started.status, 200);
  assert.deepEqual(started.folders.applied.referenceDirs, canonicalRefs);
  const first = hub.terms.get(started.id);
  first.exited = 0;
  store.linkTerms(routes.folderSessionLinks());
  assert.equal((await call('/api/term/external', { resume: sessionId })).code, 'FOLDERS_UNSUPPORTED');
  const resumed = await start({ resume: sessionId });
  assert.equal(resumed.status, 200);
  const term = hub.terms.get(resumed.id);
  assert.deepEqual(term.launch.args, [...canonicalRefs.flatMap(dir => ['--add-dir', dir]), 'resume', sessionId]);
  term.pid = 32;
  term.proc = { write: async (data) => { writes.push(data); return { ok: true }; } };
  hub.readTerm = () => [];
  hub.isCodexTerm = () => true;
  hub.touchUserInput = () => {};
  hub.consoleInputAt = new Map();
  hub.helperCall = async ({ op }) => {
    assert.equal(op, 'list');
    return { consoles: [{ id: 64, pids: [64, term.pid] }] };
  };
  assert.equal((await call('/api/term/send', { id: term.id, text: 'allowed' })).status, 200);
  store.putFolders(routes.folderSession(`term:${term.id}`), { ...folders, referenceDirs: [], revision: 1 }, inspector);
  assert.equal((await call('/api/term/send', { id: term.id, text: 'pending' })).code, 'FOLDERS_PENDING_RESTART');
  assert.deepEqual(writes, ['allowed']);
});
