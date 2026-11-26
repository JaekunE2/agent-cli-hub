'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { WebSocket } = require('ws');
const { createScheduleEngine } = require('../schedules');
const { createScheduleRoutes } = require('../routes-schedules');
const { localAccess } = require('../schedule-api-input');
const { createScheduleTransport } = require('../schedule-transport');
const { error } = require('../schedule-fields');

const base = '/api/schedules';
const at = minutes => Date.UTC(2026, 0, 1, 0, minutes);
const spec = {
  name: 'Daily summary', prompt: 'Private prompt',
  target: { projectId: 'project', version: '1.5.0', referenceDirs: [path.join(os.tmpdir(), 'reference')] },
  trigger: { kind: 'interval', everyMinutes: 5 },
};
const send = (res, code, body) => { res.writeHead(code); res.end(JSON.stringify(body)); };

async function fixture(t, { available = true, online = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-api-'));
  const file = path.join(root, 'schedules.json');
  const token = randomUUID();
  const authed = (req, url) => (!req.headers.origin || req.headers.origin === `http://${req.headers.host}`)
    && (req.headers['x-token'] === token || url.searchParams.get('t') === token);
  const capabilities = { cli: [{ id: 'codex', accountIds: ['default'], referenceMode: 'context',
    available, reason: available ? null : 'RUNNER_UNAVAILABLE' }] };
  const routes = createScheduleRoutes(() => online && engine, capabilities, assert.fail);
  const transport = createScheduleTransport(() => online && engine, assert.fail);
  const evidence = new Map();
  let now = at(0);
  const engine = createScheduleEngine({
    file, clock: { now: () => now }, onChange: transport.broadcast,
    resolveTarget(target) {
      if (target.projectId !== spec.target.projectId) throw error('TARGET_MISSING', 'Project not found');
      return { cwd: root, cmd: process.execPath, args: [], referenceDirs: target.referenceDirs };
    },
    runner: {
      start({ runId }) { evidence.set(runId, { state: 'running' }); },
      recover: id => evidence.get(id),
    },
    onError: assert.fail,
  });
  const open = new Set();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (!await routes(url.pathname, url, req, res, send, authed)) send(res, 404, {});
  });
  server.on('upgrade', (req, socket, head) => {
    if (!transport.handleUpgrade(req, socket, head, new URL(req.url, `http://${req.headers.host}`), authed)) socket.destroy();
  });
  t.after(async () => {
    for (const ws of open) ws.terminate();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(file, { force: true });
    fs.rmdirSync(root);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;

  function request(route = '', { method = 'GET', body, raw, headers = {} } = {}) {
    const payload = raw ?? (body === undefined ? null : JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, path: base + route, method,
        headers: { 'x-token': token, ...(payload !== null && { 'content-type': 'application/json' }),
          ...(payload !== null && !headers['transfer-encoding'] && { 'content-length': Buffer.byteLength(payload) }),
          ...headers },
      }, res => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) }); }
          catch { reject(new Error(`Invalid JSON response for ${method} ${route}: ${res.statusCode} ${data}`)); }
        });
      });
      req.on('error', reject);
      req.end(payload);
    });
  }

  function connect({ authenticated = true, origin } = {}) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/schedules${authenticated ? `?t=${token}` : ''}`, { origin });
    open.add(ws);
    ws.on('close', () => open.delete(ws));
    const messages = [];
    ws.on('message', raw => messages.push(JSON.parse(raw)));
    return { ws, messages };
  }
  return { request, connect, engine, file, evidence, root, setTime: minutes => { now = at(minutes); } };
}

async function status(response, expected, code) {
  const result = await response;
  assert.equal(result.status, expected, JSON.stringify(result.body));
  if (code) assert.equal(result.body.code, code);
  return result.body;
}

test('authenticated REST lifecycle validates bodies, revisions, targets and methods', { timeout: 5000 }, async t => {
  const { request } = await fixture(t);
  const post = (route, body, extra) => request(route, { method: 'POST', body, ...extra });
  await status(request('', { headers: { 'x-token': 'wrong' } }), 401, 'UNAUTHORIZED');
  await status(request('', { headers: { origin: 'https://other.test' } }), 401, 'UNAUTHORIZED');
  await status(post('', spec, { headers: { host: '127.0.0.1:1' } }), 403, 'LOCAL_REQUIRED');
  await status(post('', spec, { headers: { 'content-type': 'text/plain' } }), 400, 'INVALID_JSON');
  await status(post('', null, { raw: '{"' }), 400, 'INVALID_JSON');
  await status(post('', null, { raw: JSON.stringify('x'.repeat(65536)), headers: { 'transfer-encoding': 'chunked' } }), 413, 'BODY_TOO_LARGE');
  await status(post('', null, { raw: 'x'.repeat(65537), headers: { 'content-length': 65537 } }), 413, 'BODY_TOO_LARGE');
  await status(post('', { ...spec, unknown: true }), 400, 'INVALID_INPUT');
  await status(post('', { ...spec, target: { ...spec.target, env: {} } }), 400, 'INVALID_INPUT');
  await status(post('', { ...spec, target: { ...spec.target, projectId: 'missing' } }), 404, 'TARGET_MISSING');
  await status(post('/preview', { trigger: { ...spec.trigger, extra: 1 } }), 400, 'INVALID_INPUT');
  assert.equal((await status(post('/preview', { trigger: spec.trigger }), 200)).nextRunAts.length, 5);
  const { item, seq } = await status(post('', spec), 201);
  assert.equal(item.state, 'paused');
  assert.equal(item.prompt, spec.prompt);
  assert.equal(item.lastConsumedAt, undefined);
  assert.equal((await status(request(), 200)).items[0].lastRun, null);
  assert.deepEqual(await status(request(`/${item.id}`), 200), { item, seq });
  const route = `/${item.id}`;
  await status(request('/missing'), 404, 'SCHEDULE_MISSING');
  const invalidMethod = await request(route, { method: 'PUT' });
  assert.equal(invalidMethod.status, 405);
  assert.equal(invalidMethod.headers.allow, 'GET, PATCH, DELETE');
  await status(request(route, { method: 'PATCH', body: { revision: '1' } }), 400, 'INVALID_REVISION');
  const updated = (await status(request(route, { method: 'PATCH', body: { revision: 1, name: 'Edited' } }), 200)).item;
  assert.equal(updated.name, 'Edited');
  await status(post(`${route}/resume`, { revision: 1 }), 409, 'SCHEDULE_CONFLICT');
  const resumed = (await status(post(`${route}/resume`, { revision: 2 }), 200)).item;
  assert.ok(resumed.nextRunAt);
  const paused = (await status(post(`${route}/pause`, { revision: resumed.revision }), 200)).item;
  assert.equal(paused.nextRunAt, null);
  assert.equal((await status(post(`${route}/pause`, { revision: paused.revision }), 200)).item.revision, paused.revision);
  const archived = (await status(request(route, { method: 'DELETE', body: { revision: paused.revision } }), 200)).item;
  assert.equal(archived.state, 'archived');
  assert.deepEqual((await status(request(), 200)).items, []);
  assert.deepEqual((await status(request(`${route}/runs`), 200)).items, []);
});

test('immediate runs broadcast committed transitions and are recoverable through filtered history', { timeout: 5000 }, async t => {
  const { request, connect, file, engine, evidence, root } = await fixture(t);
  for (const options of [{ authenticated: false }, { origin: 'https://other.test' }]) {
    const { ws } = connect(options);
    const [cause] = await once(ws, 'error');
    assert.match(cause.message, /Unexpected server response: 401/);
  }
  const subscriber = connect();
  const next = async () => {
    for (let i = 0; i < 100 && !subscriber.messages.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(subscriber.messages.length, 'expected WebSocket frame');
    return subscriber.messages.shift();
  };
  assert.deepEqual(await next(), { type: 'schedules.ready', seq: 0 });
  const { item, seq } = await status(request('', { method: 'POST', body: spec }), 201);
  assert.deepEqual(await next(), { type: 'schedules.changed', seq, scheduleIds: [item.id], runIds: [] });
  const route = `/${item.id}`;
  const run = body => request(`${route}/run`, { method: 'POST', body: { revision: 1, ...body } });
  const history = (query = '', headers) => request(`${route}/runs${query}`, { headers });
  const expectChange = async (id, expectedSeq) => {
    assert.deepEqual(await next(), { type: 'schedules.changed', seq: expectedSeq, scheduleIds: [], runIds: [id] });
    assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).seq >= expectedSeq);
  };
  const key = randomUUID();
  await status(run({ requestId: 'invalid' }), 400, 'INVALID_REQUEST_ID');
  const first = (await status(run({ requestId: key }), 201)).run;
  await expectChange(first.id, 2);
  await expectChange(first.id, 3);
  assert.equal((await status(history(), 200)).items[0].status, 'starting');
  await engine.tick();
  await expectChange(first.id, 4);
  assert.equal((await status(history(), 200)).items[0].status, 'running');
  evidence.set(first.id, { state: 'finished', result: { outcome: 'succeeded', exitCode: 0, outputSummary: 'Read complete' } });
  await engine.tick();
  await expectChange(first.id, 5);
  const replay = await status(run({ requestId: key, revision: 2 }), 200);
  assert.equal(replay.run.id, first.id);
  assert.equal(replay.run.status, 'succeeded');
  assert.equal(replay.run.outputSummary, 'Read complete');
  assert.equal(replay.run.targetSnapshot.primaryCwd, root);
  const second = (await status(run({ requestId: randomUUID() }), 201)).run;
  await expectChange(second.id, 6);
  await expectChange(second.id, 7);
  evidence.set(second.id, { state: 'finished', result: { outcome: 'failed', exitCode: 1, errorSummary: 'Fixture failure' } });
  await engine.tick();
  await expectChange(second.id, 8);
  const reconnect = connect();
  const [frame] = await once(reconnect.ws, 'message');
  assert.deepEqual(JSON.parse(frame), { type: 'schedules.ready', seq: 8 });
  const { items, nextCursor } = await status(history('?limit=1'), 200);
  const older = await status(history(`?limit=1&before=${nextCursor}`), 200);
  assert.equal(older.nextCursor, null);
  assert.deepEqual([items[0].id, older.items[0].id], [first.id, second.id].sort().reverse());
  assert.equal([items[0], older.items[0]].find(item => item.id === second.id).status, 'failed');
  await status(history('?limit=101'), 400, 'INVALID_LIMIT');
  await status(history('?before=invalid'), 400, 'INVALID_CURSOR');
  const remote = { host: 'remote.test' };
  const remoteList = await status(request('', { headers: remote }), 200);
  const remoteDetail = (await status(request(route, { headers: remote }), 200)).item;
  for (const item of [remoteList.items[0], remoteDetail]) {
    assert.ok(!Object.hasOwn(item, 'prompt') && !Object.hasOwn(item.target, 'referenceDirs'));
  }
  const restricted = (await status(history('', remote), 200)).items;
  for (const run of [...restricted, remoteList.items[0].lastRun]) {
    assert.ok(!Object.hasOwn(run, 'outputSummary') && !Object.hasOwn(run, 'errorSummary'));
    assert.ok(!Object.hasOwn(run.targetSnapshot, 'primaryCwd') && !Object.hasOwn(run.targetSnapshot, 'referenceDirs'));
  }
  await status(request(route, { method: 'DELETE', body: { revision: 1 } }), 200);
  await status(run({ requestId: key }), 409, 'SCHEDULE_CONFLICT');
  assert.equal((await status(history(), 200)).items.length, 2);
});

test('REST pause cancels queued work, allows manual runs, and resumes at the next slot', { timeout: 5000 }, async t => {
  const { request, engine, evidence, setTime } = await fixture(t);
  const post = (route, body) => request(route, { method: 'POST', body });
  const { item } = await status(post('', { ...spec, overlap: 'queue', misfire: 'run_once' }), 201);
  const route = `/${item.id}`;
  const change = (action, revision) => post(`${route}/${action}`, { revision });
  const run = (revision, requestId = randomUUID()) => post(`${route}/run`, { revision, requestId });
  const history = async () => (await status(request(`${route}/runs`), 200)).items;
  const active = (await status(change('resume', item.revision), 200)).item;
  const owner = (await status(run(active.revision), 201)).run;
  const key = randomUUID();
  const waiting = (await status(run(active.revision, key), 201)).run;
  const paused = (await status(change('pause', active.revision), 200)).item;
  assert.equal(paused.nextRunAt, null);
  const replay = (await status(run(active.revision, key), 200)).run;
  assert.deepEqual([replay.id, replay.status, replay.reason], [waiting.id, 'cancelled', 'PAUSED']);
  await status(run(active.revision), 409, 'SCHEDULE_CONFLICT');
  assert.equal((await history()).find(row => row.id === owner.id).status, 'running');

  setTime(16);
  evidence.set(owner.id, { state: 'finished', result: { outcome: 'succeeded', exitCode: 0 } });
  await engine.tick();
  assert.equal((await history()).length, 2);
  const manual = (await status(run(paused.revision), 201)).run;
  assert.equal(manual.trigger, 'manual');
  evidence.set(manual.id, { state: 'finished', result: { outcome: 'succeeded', exitCode: 0 } });
  const resumed = (await status(change('resume', paused.revision), 200)).item;
  assert.equal(resumed.nextRunAt, new Date(at(21)).toISOString());
  setTime(20);
  await engine.tick();
  assert.equal((await history()).length, 3);

  setTime(21);
  await engine.tick();
  const slots = (await history()).filter(row => row.trigger === 'timer');
  assert.deepEqual(slots.map(row => row.slotAt), [resumed.nextRunAt]);
  assert.ok(evidence.has(slots[0].id));
});

test('an unavailable engine or runner fails closed', { timeout: 5000 }, async t => {
  const offline = await fixture(t, { online: false });
  await status(offline.request(), 503, 'SCHEDULE_UNAVAILABLE');
  const { request } = await fixture(t, { available: false });
  assert.equal((await status(request(), 200)).capabilities.cli[0].available, false);
  const { item } = await status(request('', { method: 'POST', body: spec }), 201);
  const input = { revision: item.revision, requestId: randomUUID() };
  await status(request(`/${item.id}/resume`, { method: 'POST', body: { revision: item.revision } }), 503, 'SCHEDULE_UNAVAILABLE');
  await status(request(`/${item.id}/run`, { method: 'POST', body: input }), 503, 'SCHEDULE_UNAVAILABLE');
  assert.equal(localAccess({ socket: { remoteAddress: '100.64.0.2', localPort: 7777 },
    headers: { host: 'localhost:7777' } }), false);
});
