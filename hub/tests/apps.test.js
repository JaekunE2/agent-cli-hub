'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { URL } = require('node:url');

const createApps = require('../apps');
const createArtifacts = require('../artifacts');

function makeHarness(overrides = {}) {
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
  const artifactsDir = path.join(tmp, 'artifacts');
  fs.mkdirSync(artifactsDir);
  const artifactsMod = createArtifacts({ dir: artifactsDir });
  const pinned = (sid) => JSON.parse(fs.readFileSync(path.join(artifactsDir, 'artifacts-store.json'), 'utf8'))[sid].pinned.map((f) => f.path);
  const terms = new Map([
    ['1', { id: '1', cwd: appDir, exited: null, sessionId: 'sess-1', title: 'test-term', agent: 'agy' }],
  ]);
  const live = [{ sessionId: 'sess-1', status: 'idle', cwd: appDir }];

  const mod = createApps({
    dataFile: path.join(tmp, 'apps.json'),
    runsFile: path.join(tmp, 'app-runs.json'),
    secretsDir: path.join(tmp, 'secrets'),
    terms,
    liveSessions: () => live,
    writeInteractiveTerm: async (t, text) => { sentMessages.push({ termId: t.id, text }); return true; },
    artifactsMod,
    ...overrides,
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

  return { tmp, appDir, viewDir, dataDir, mod, call, live, sentMessages, pinned, terms };
}

test('GitHub source discovers tagged repositories and installs the reviewed release without running it', async (t) => {
  const repo = 'owner/report-tool';
  const download = 'https://github.com/' + repo + '/releases/download/v1/report-tool.zip';
  let zip, digest;
  const h = makeHarness({ storeFetch: async (input) => {
    const url = String(input);
    if (url.includes('raw.githubusercontent.com')) return Response.json({ apps: [{ repo: 'team/tools', name: 'Shared app' }] });
    if (url.endsWith('page=1')) return Response.json([
      { full_name: 'owner/unrelated', topics: ['different-topic'] },
    ], { headers: { link: '<https://api.github.com/next>; rel="next"' } });
    if (url.endsWith('page=2')) return Response.json([
      { full_name: repo, name: 'Report tool', topics: ['agent-cli-hub-app'] },
    ]);
    if (url.endsWith('/releases/latest')) return Response.json({
      tag_name: 'v1', assets: [{ name: 'report-tool.zip', digest, size: zip.length, browser_download_url: download, state: 'uploaded' }],
    });
    assert.equal(url, download);
    return new Response(zip);
  } });
  t.after(() => {
    const target = fs.realpathSync(h.tmp);
    if (path.dirname(target) === fs.realpathSync(os.tmpdir()) && path.basename(target).startsWith('ach-apps-test-')) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });
  fs.writeFileSync(path.join(h.appDir, 'app.json'), JSON.stringify({
    id: 'report-tool', name: 'Report tool', cwd: 'from-author-machine', env: { SAMPLE: 'ignored' },
    secretRefs: ['sample'], schedule: { enabled: true }, actions: [{ cmd: 'example-command' }],
  }));
  const zipPath = path.join(h.tmp, 'app.zip');
  execFileSync(process.env.CCD_PYTHON || 'python', ['-m', 'zipfile', '-c', zipPath, h.appDir], { windowsHide: true });
  zip = fs.readFileSync(zipPath);
  digest = 'sha256:' + createHash('sha256').update(zip).digest('hex');

  assert.equal((await h.call('POST', '/api/apps-store/source', { source: 'https://github.com/Owner' })).status, 200);
  const store = (await h.call('GET', '/api/apps-store')).payload;
  assert.deepEqual(store.entries.map(item => item.repo), ['team/tools', repo]);
  const preview = (await h.call('POST', '/api/apps-store/package', { key: repo })).payload.package;
  assert.equal(preview.actions[0].cmd, 'example-command');
  assert.deepEqual(h.mod.loadStore().apps, []);
  assert.equal((await h.call('POST', '/api/apps-store/package', { key: repo, digest: 'sha256:' + '0'.repeat(64) })).status, 400);
  assert.equal((await h.call('POST', '/api/apps-store/package', { key: repo, digest: preview.digest })).status, 200);
  const [app] = h.mod.loadStore().apps;
  assert.equal(app.storeSource.version, 'v1');
  assert.equal(app.schedule.enabled, false);
  assert.deepEqual(app.secretRefs, []);
  assert.deepEqual(app.env, {});
  assert.equal((await h.call('GET', `/api/apps/${app.id}/runs`)).payload.runs.length, 0);
  assert.equal((await h.call('DELETE', '/api/apps-store/source', { source: 'owner' })).status, 200);
  assert.equal(h.mod.loadStore().apps.length, 1);
});

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
    const linked = await h.call('GET', '/api/apps/pinned-app');
    assert.equal(linked.payload.app.linkedSession.actionTermId, '1');
  } finally {
    h.mod.stop();
    fs.rmSync(h.tmp, { recursive: true, force: true });
  }
});

test('action run, run lock, cancellation, and logs', async () => {
  const h = makeHarness();
  try {
    fs.writeFileSync(path.join(h.appDir, 'runner.cjs'), `
      require('node:fs').writeFileSync('views/latest.html', '<h1>Latest report</h1>');
      console.log('hello-' + process.env.APP_PARAM_WHO);
    `);
    await h.call('POST', '/api/apps', {
      id: 'runner',
      name: 'Runner',
      type: 'command',
      cwd: h.appDir,
      outputs: { viewDir: 'views' },
      actions: [
        { id: 'fast', label: 'Fast', kind: 'command', cmd: 'node runner.cjs', params: [{ key: 'who', default: 'world' }] },
        { id: 'slow', label: 'Slow', kind: 'command', cmd: 'node -e "setTimeout(() => {}, 10000)"' },
      ],
    });

    const r1 = await h.call('POST', '/api/apps/runner/run', { actionId: 'fast', params: { who: 'hub' } });
    assert.equal(r1.status, 200);
    let logs;
    for (let attempt = 0; attempt < 30; attempt++) {
      logs = await h.call('GET', '/api/apps/runner/runs');
      if (logs.payload.runs[0].status !== 'running') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(logs.payload.runs[0].status, 'ok');
    assert.match(logs.payload.runs[0].stdout, /hello-hub/);
    assert.equal(logs.payload.runs[0].outputView, 'latest.html');
    assert.deepEqual(logs.payload.runs[0].pinnedArtifacts, [path.join(h.viewDir, 'latest.html')]);
    assert.deepEqual(h.pinned('sess-1'), [path.join(h.viewDir, 'latest.html')]);

    // slow run + lock + cancel
    const s1 = await h.call('POST', '/api/apps/runner/run', { actionId: 'slow' });
    assert.equal(s1.status, 200);
    const removeActive = await h.call('DELETE', `/api/apps/runner/runs/${s1.payload.run.runId}`);
    assert.equal(removeActive.status, 409);
    const removeFinished = await h.call('DELETE', `/api/apps/runner/runs/${r1.payload.run.runId}`);
    assert.equal(removeFinished.status, 200);
    assert.equal(fs.existsSync(path.join(h.viewDir, 'latest.html')), true);
    const history = await h.call('GET', '/api/apps/runner/runs');
    assert.deepEqual(history.payload.runs.map((run) => run.runId), [s1.payload.run.runId]);
    const locked = await h.call('POST', '/api/apps/runner/run', { actionId: 'fast' });
    assert.equal(locked.status, 409);

    const can = await h.call('POST', '/api/apps/runner/cancel');
    assert.equal(can.status, 200);
    assert.equal(can.payload.wasRunning, true);
    for (let attempt = 0; attempt < 30; attempt++) {
      const status = await h.call('GET', '/api/apps/runner/runs');
      if (!status.payload.running) break;
      await new Promise((r) => setTimeout(r, 100));
    }
  } finally {
    h.mod.stop();
    fs.rmSync(h.tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 120 });
  }
});

test('agent actions require a connected agent terminal and report prompt delivery', async () => {
  const h = makeHarness();
  try {
    const t = h.terms.get('1');
    t.agent = null;
    const created = await h.call('POST', '/api/apps', {
      id: 'summary', name: 'Summary', cwd: h.appDir,
      actions: [{ id: 'run', kind: 'agent', prompt: 'Summarize app data' }],
    });
    assert.equal(created.payload.app.linkedSession.actionTermId, null);
    const unavailable = await h.call('POST', '/api/apps/summary/run');
    assert.equal(unavailable.payload.run.status, 'error');
    assert.equal(h.sentMessages.length, 0);

    t.agent = 'agy';
    const sent = await h.call('POST', '/api/apps/summary/run');
    assert.equal(sent.payload.run.status, 'ok');
    assert.deepEqual(h.sentMessages, [{ termId: '1', text: 'Summarize app data\r' }]);
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
    assert.deepEqual(h.pinned('sess-1'), [path.join(h.viewDir, 'report.html')]);

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

test('tracked app export saves zip with progress, excludes secrets, and serves view link bridge', async () => {
  const h = makeHarness();
  try {
    fs.writeFileSync(path.join(h.appDir, '.env'), 'SECRET=123\n', 'utf8');
    fs.mkdirSync(path.join(h.appDir, '.venv'), { recursive: true });
    fs.writeFileSync(path.join(h.appDir, '.venv', 'ignore.txt'), 'skip', 'utf8');
    fs.mkdirSync(path.join(h.appDir, 'reports'), { recursive: true });
    fs.writeFileSync(path.join(h.appDir, 'reports', 'old.md'), '# old report\n', 'utf8');
    fs.mkdirSync(path.join(h.appDir, '산출물'), { recursive: true });
    fs.writeFileSync(path.join(h.appDir, '산출물', 'out.html'), '<p>out</p>', 'utf8');
    fs.writeFileSync(path.join(h.appDir, 'main.py'), 'print("ok")\n', 'utf8');

    const created = await h.call('POST', '/api/apps', {
      id: 'export-app',
      name: 'Export App',
      type: 'report',
      cwd: h.appDir,
      outputs: { viewDir: 'views', viewGlob: '*.html', dataDir: 'data', dataGlob: '*.json' },
      actions: [],
    });
    assert.equal(created.status, 200);

    // View endpoint sets allow-popups-to-escape-sandbox CSP and injects link bridge
    const viewRes = await h.call('GET', '/api/apps/export-app/view/report.html');
    assert.equal(viewRes.status, 200);
    assert.match(viewRes.headers['content-security-policy'] || '', /allow-popups-to-escape-sandbox/);
    assert.match(String(viewRes.payload || ''), /data-hub-link-bridge/);

    // Export info returns default dir and filename
    const info = await h.call('GET', '/api/apps/export-app/export-info');
    assert.equal(info.status, 200);
    assert.equal(info.payload.hasOutputs, true);
    assert.match(info.payload.fileName, /^export-app-share-\d{8}-\d{4}\.zip$/);

    // Tracked async export defaults to excluding outputs/reports/data
    const destDir = path.join(h.tmp, 'out-zips');
    const started = await h.call('POST', '/api/apps/export-app/export', { destDir });
    assert.equal(started.status, 200);
    assert.ok(started.payload.job?.jobId);

    let job = started.payload.job;
    for (let i = 0; i < 80 && job.status === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 150));
      const st = await h.call('GET', `/api/apps/export-app/export-status?jobId=${encodeURIComponent(job.jobId)}`);
      assert.equal(st.status, 200);
      job = st.payload.job;
    }
    assert.equal(job.status, 'ok', job.error || 'export should succeed');
    assert.equal(job.percent, 100);
    assert.equal(job.includeOutputs, false);
    // Only main.py + app.json + SHARE_README.md (views/data/reports/산출물/.env/.venv all excluded)
    assert.equal(job.filesTotal, 3);
    assert.ok(job.bytes > 100);
    assert.equal(job.outputDir, path.resolve(destDir));
    assert.equal(fs.existsSync(job.outputPath), true);
    const sig = fs.readFileSync(job.outputPath).subarray(0, 4);
    assert.deepEqual([...sig], [0x50, 0x4b, 0x03, 0x04]);

    // Download endpoint streams the created ZIP
    const dl = await new Promise((resolve) => {
      const url = new URL(`http://127.0.0.1/api/apps/export-app/export-download?jobId=${encodeURIComponent(job.jobId)}`);
      const chunks = [];
      let status = 0;
      const headers = {};
      const res = {
        writeHead(code, hdrs) { status = code; Object.assign(headers, hdrs || {}); },
        on() { return this; },
        once() { return this; },
        emit() { return true; },
        write(c) { chunks.push(Buffer.from(c)); return true; },
        end(c) { if (c) chunks.push(Buffer.from(c)); resolve({ status, headers, buf: Buffer.concat(chunks) }); },
      };
      h.mod.handle(url.pathname, url, { method: 'GET', url: url.pathname + url.search, headers: {} }, async () => ({}), (code, obj) => resolve({ status: code, obj }), res);
    });
    assert.equal(dl.status, 200);
    assert.equal(dl.headers['content-type'], 'application/zip');
    assert.equal(dl.buf.length, job.bytes);
  } finally {
    h.mod.stop();
    fs.rmSync(h.tmp, { recursive: true, force: true });
  }
});
