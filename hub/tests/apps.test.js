'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { URL } = require('node:url');

const createApps = require('../apps');

function makeHarness() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ach-apps-test-'));
  const appDir = path.join(tmp, 'sample-app');
  const viewDir = path.join(appDir, 'views');
  const dataDir = path.join(appDir, 'data');
  fs.mkdirSync(viewDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(viewDir, 'report.html'), '<h1>Hello App</h1>', 'utf8');
  fs.writeFileSync(
    path.join(dataDir, '2026-11-26.json'),
    JSON.stringify({ items: [{ title: 'Alpha Agent' }, { title: 'Beta Tool' }] }),
    'utf8'
  );

  const sentMessages = [];
  const pinnedArtifacts = [];
  const terms = new Map([
    ['1', { id: '1', cwd: appDir, exited: null, sessionId: 'sess-1', title: 'test-term' }],
  ]);
  const live = [{ sessionId: 'sess-1', status: 'idle', cwd: appDir }];

  const mod = createApps({
    dataFile: path.join(tmp, 'apps.json'),
    runsFile: path.join(tmp, 'app-runs.json'),
    secretsDir: path.join(tmp, 'secrets'),
    terms,
    liveSessions: () => live,
    writeInteractiveTerm: async (t, text) => { sentMessages.push({ termId: t.id, text }); return true; },
    artifactsMod: { add: (sid, filePath) => { pinnedArtifacts.push({ sid, filePath }); } },
  });

  async function call(method, reqPath, bodyObj = null) {
    const url = new URL(`http://127.0.0.1${reqPath}`);
    let status = 0;
    let payload = null;
    const headers = {};
    const res = {
      writeHead(code, h) { status = code; Object.assign(headers, h || {}); },
      end(chunk) {
        if (chunk === undefined) return;
        const s = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        try { payload = JSON.parse(s); } catch { payload = s; }
      },
    };
    const send = (code, obj) => { status = code; payload = obj; return true; };
    const req = { method, url: reqPath, headers: {} };
    const handled = await mod.handle(url.pathname, url, req, async () => bodyObj || {}, send, res);
    return { handled, status, payload, headers };
  }

  return { tmp, appDir, viewDir, dataDir, mod, call, live, sentMessages, pinnedArtifacts };
}

test('apps CRUD, validation, and folder import', async () => {
  const h = makeHarness();
  try {
    // invalid cwd rejected
    const bad = await h.call('POST', '/api/apps', { id: 'bad-app', name: 'Bad', type: 'report', cwd: path.join(h.tmp, 'missing') });
    assert.equal(bad.status, 400);

    // valid create
    const ok = await h.call('POST', '/api/apps', {
      id: 'demo-app',
      name: 'Demo App',
      usage: '  Run the app\nOpen the report  ',
      purpose: 'Summarize AI news',
      type: 'report',
      cwd: h.appDir,
      outputs: { viewDir: 'views', viewGlob: '*.html', dataDir: 'data', dataGlob: '*.json' },
      actions: [{ id: 'echo', label: 'Echo', kind: 'command', cmd: 'node -e "console.log(process.env.APP_PARAM_TAG)"', params: [{ key: 'tag', default: 'hi' }] }],
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.payload.app.id, 'demo-app');
    assert.equal(ok.payload.app.counts.views, 1);
    assert.equal(ok.payload.app.counts.data, 1);
    assert.equal(ok.payload.app.usage, 'Run the app\nOpen the report');

    // duplicate rejected
    const dup = await h.call('POST', '/api/apps', { id: 'demo-app', name: 'Dup', type: 'report', cwd: h.appDir });
    assert.equal(dup.status, 409);

    // update
    const upd = await h.call('PUT', '/api/apps/demo-app', { name: 'Demo Updated', type: 'report', cwd: h.appDir, usage: '' });
    assert.equal(upd.status, 200);
    assert.equal(upd.payload.app.name, 'Demo Updated');
    assert.equal(upd.payload.app.usage, '');
    assert.equal(upd.payload.app.purpose, 'Summarize AI news');

    // import from app.json
    const impDir = path.join(h.tmp, 'import-app');
    fs.mkdirSync(impDir, { recursive: true });
    fs.writeFileSync(path.join(impDir, 'app.json'), JSON.stringify({ id: 'imp-app', name: 'Imported', type: 'command', actions: [] }), 'utf8');
    const imp = await h.call('POST', '/api/apps/import', { dir: impDir });
    assert.equal(imp.status, 200);
    assert.equal(imp.payload.app.id, 'imp-app');
    assert.equal(imp.payload.app.usage, '');
    assert.equal(imp.payload.app.purpose, '');
  } finally {
    h.mod.stop();
    fs.rmSync(h.tmp, { recursive: true, force: true });
  }
});

test('a pinned live session takes priority over a different terminal in the app folder', async () => {
  const h = makeHarness();
  try {
    const app = await h.call('POST', '/api/apps', {
      id: 'pinned-app',
      name: 'Pinned App',
      type: 'report',
      cwd: h.appDir,
      session: { pinnedSessionId: 'pinned-live' },
    });
    assert.equal(app.payload.app.linkedSession.term.id, '1');
    h.live.push({ sessionId: 'pinned-live', cwd: h.appDir, status: 'idle' });
    const opened = await h.call('POST', '/api/apps/pinned-app/session/open');
    assert.deepEqual(opened.payload, { ok: true, sessionId: 'pinned-live', existing: true });
  } finally {
    h.mod.stop();
    fs.rmSync(h.tmp, { recursive: true, force: true });
  }
});

test('action run, run lock, cancellation, and logs', async () => {
  const h = makeHarness();
  try {
    await h.call('POST', '/api/apps', {
      id: 'runner',
      name: 'Runner',
      type: 'command',
      cwd: h.appDir,
      actions: [
        { id: 'fast', label: 'Fast', kind: 'command', cmd: 'node -e "console.log(\'hello-\' + process.env.APP_PARAM_WHO)"', params: [{ key: 'who', default: 'world' }] },
        { id: 'slow', label: 'Slow', kind: 'command', cmd: 'node -e "setTimeout(() => {}, 10000)"' },
      ],
    });

    const r1 = await h.call('POST', '/api/apps/runner/run', { actionId: 'fast', params: { who: 'hub' } });
    assert.equal(r1.status, 200);
    await new Promise((r) => setTimeout(r, 400));
    const logs = await h.call('GET', '/api/apps/runner/runs');
    assert.equal(logs.payload.runs[0].status, 'ok');
    assert.match(logs.payload.runs[0].stdout, /hello-hub/);

    // slow run + lock + cancel
    const s1 = await h.call('POST', '/api/apps/runner/run', { actionId: 'slow' });
    assert.equal(s1.status, 200);
    const locked = await h.call('POST', '/api/apps/runner/run', { actionId: 'fast' });
    assert.equal(locked.status, 409);

    const can = await h.call('POST', '/api/apps/runner/cancel');
    assert.equal(can.status, 200);
    assert.equal(can.payload.wasRunning, true);
  } finally {
    h.mod.stop();
    fs.rmSync(h.tmp, { recursive: true, force: true });
  }
});

test('data query, path traversal guard, data delete, app delete, and send-to-chat', async () => {
  const h = makeHarness();
  try {
    await h.call('POST', '/api/apps', {
      id: 'data-app',
      name: 'Data App',
      type: 'report',
      cwd: h.appDir,
      outputs: { viewDir: 'views', viewGlob: '*.html', dataDir: 'data', dataGlob: '*.json' },
      actions: [],
    });

    // query with keyword filter
    const q = await h.call('GET', '/api/apps/data-app/data?file=latest&q=alpha');
    assert.equal(q.status, 200);
    assert.equal(q.payload.data.items.length, 1);
    assert.equal(q.payload.data.items[0].title, 'Alpha Agent');

    // path traversal blocked
    const travData = await h.call('GET', '/api/apps/data-app/data?file=../../secret.json');
    assert.equal(travData.status, 403);
    const travView = await h.call('GET', '/api/apps/data-app/view?file=../../secret.html');
    assert.equal(travView.status, 403);

    // send to chat + auto pin artifact
    const chat = await h.call('POST', '/api/apps/data-app/send-to-chat', { file: 'report.html', prompt: '요약해줘' });
    assert.equal(chat.status, 200);
    assert.equal(chat.payload.delivered, true);
    assert.equal(h.sentMessages.length, 1);
    assert.equal(h.pinnedArtifacts.length, 1);

    // delete single data file
    const delFile = await h.call('DELETE', '/api/apps/data-app/data?file=2026-11-26.json');
    assert.equal(delFile.status, 200);
    assert.deepEqual(delFile.payload.deleted, ['2026-11-26.json']);

    // delete app with purgeOutputs=true removes remaining view file but keeps cwd
    const delApp = await h.call('DELETE', '/api/apps/data-app?purgeOutputs=true');
    assert.equal(delApp.status, 200);
    assert.deepEqual(delApp.payload.removedFiles, ['report.html']);
    assert.equal(fs.existsSync(h.appDir), true);
  } finally {
    h.mod.stop();
    fs.rmSync(h.tmp, { recursive: true, force: true });
  }
});
