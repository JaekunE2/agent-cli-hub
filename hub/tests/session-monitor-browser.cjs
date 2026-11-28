'use strict';

const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const { chromium } = require(process.env.HUB_PLAYWRIGHT || 'playwright');
const fixture = require('./browser-fixture');
const sid = 'fixture-session-123';

async function setup() {
  const terms = [
    { id: '1', title: 'Project default', agent: 'claude', sessionId: sid, exited: null, status: 'busy', projectTask: { taskId: 'task' } },
    { id: '2', title: 'Plain terminal', agent: 'cursor', exited: null },
  ];
  const session = { sessionId: sid, title: 'Native default', firstPrompt: 'Initial prompt', agent: 'claude', mtime: Date.now() };
  const worker = { id: 'worker', name: 'Reviewer', agent: 'claude', status: 'done', startedAt: Date.now() };
  const state = { requests: [], worker, fail: false, output: 'Working', result: '', rejectHooks: false };
  const holds = new Map();
  const signals = new EventEmitter();
  const listPath = '/api/session/subagents';
  const detailPath = '/api/session/subagent-detail';
  const events = [{ type: 'tool', id: 'read-1', tool: 'Read', text: 'fixture' }];
  let socket;
  const handle = async (url, req, res) => {
    const reply = (data, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
      return true;
    };
    if (url.pathname === '/api/overview') {
      if (!req.headers['x-token']) return reply({ error: 'bad token' }, 401);
      return reply({ terms, consoles: [], live: [], services: { hub: { port: Number(url.port || req.headers.host.split(':').pop()) }, ptyHost: { ok: true } } });
    }
    if (url.pathname === '/api/recent') return reply({ sessions: [session] });
    const gate = holds.get(url.pathname);
    if (gate && url.searchParams.get('termId') === '1') {
      signals.emit(url.pathname, url);
      await gate.released;
      reply(gate.data);
      signals.emit(url.pathname + ':released');
      return true;
    }
    const agy = { id: 'agy-worker', name: 'AGY worker', agent: 'agy', status: 'stopped', targetSessionId: sid, startedAt: Date.now() };
    if (url.pathname === listPath) return reply(url.searchParams.get('termId') === '2' ? [agy] : [
      worker, { id: 'term:2', name: 'Cursor worker', agent: 'cursor', status: 'done', targetTermId: '2', startedAt: Date.now() }, agy,
    ]);
    if (url.pathname === detailPath) return reply({
      ok: true, prompt: 'Inspect the fixture',
      events: state.result ? [...events, { type: 'result', id: 'read-1', text: state.result }] : events,
      lastMessage: state.output, status: worker.status,
    });
    if (url.pathname !== '/api/transcript/title') return false;
    let body = '';
    for await (const chunk of req) body += chunk;
    const { id, title } = JSON.parse(body);
    state.requests.push(id);
    if (state.fail) return reply({ error: 'Fixture save failed' }, 502);
    const term = id === 'term:2' ? terms[1] : terms[0];
    const name = title.trim() || null;
    term.customTitle = name;
    if (term.sessionId) session.title = name || 'Native default';
    return reply({ ok: true, title: name, sessionId: term.sessionId || null, displayTitle: session.title });
  };
  const env = await fixture({ list: () => [], hidden: () => new Set() }, handle);
  env.ws.on('connection', (client, req) => {
    if (!req.url.startsWith('/ws/hooks?')) return;
    if (state.rejectHooks) return client.close();
    socket = client;
    signals.emit('socket', client);
  });
  let sequence = 0;
  return Object.assign(state, {
    url: env.url,
    holdList: data => arm(listPath, data),
    holdDetail: data => arm(detailPath, data),
    socket: () => socket,
    nextSocket: () => once(signals, 'socket', { signal: AbortSignal.timeout(5000) }),
    hook() {
      assert.equal(socket?.readyState, 1);
      const fixtureSequence = ++sequence;
      socket.send(JSON.stringify({ type: 'hook-event', sessionId: sid, fixtureSequence }));
      return fixtureSequence;
    },
    close() {
      for (const { release } of holds.values()) release();
      return env.close();
    },
  });
  function arm(path, data) {
    assert.ok(!holds.has(path));
    const arrived = once(signals, path, { signal: AbortSignal.timeout(5000) });
    let release;
    const released = new Promise(resolve => { release = resolve; });
    holds.set(path, { data, release, released });
    return {
      arrived,
      async release() {
        const finished = once(signals, path + ':released', { signal: AbortSignal.timeout(5000) });
        release();
        holds.delete(path);
        await finished;
      },
    };
  }
}

async function verify(page, state, { native = false } = {}) {
  page.setDefaultTimeout(10_000);
  await page.addInitScript(() => {
    window.prompt = () => { throw new Error('Unexpected prompt()'); };
    const interval = window.setInterval.bind(window);
    window.setInterval = (fn, delay, ...args) => interval(
      fn?.name === 'refresh' && delay === 1000 ? () => { if (!window.pauseSubagentPolling) fn(); } : fn,
      delay, ...args,
    );
    window.WebSocket = class extends WebSocket {
      constructor(url, protocols) {
        super(url, protocols);
        if (new URL(url).pathname !== '/ws/hooks') return;
        this.addEventListener('message', ({ data }) => {
          if (data.includes('fixtureSequence')) window.lastFixtureHook = JSON.parse(data).fixtureSequence;
        });
      }
    };
  });
  await page.goto(state.url + '/?t=qa#term:1:chat');
  if (native) assert.equal(await page.evaluate(() => typeof window.__TAURI_INTERNALS__?.invoke), 'function');
  const heading = page.locator('#bar h2');
  const dialog = page.locator('dialog.pj-dialog[open]');
  const input = dialog.locator('input[name=title]');
  const title = async value => heading.getByText(value, { exact: true }).waitFor();
  await title('Project default');
  await heading.dblclick();
  assert.equal(await input.inputValue(), 'Project default');
  await input.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  await page.locator('#btnRenameTerm').click();
  await dialog.getByText('취소', { exact: true }).click();
  assert.deepEqual(state.requests, []);
  await page.locator('[data-key="term:1"] [data-side-rename]').click();
  await input.fill('Shared title');
  await input.press('Enter');
  await title('Shared title');
  await page.locator('[data-key="term:1"]').getByText('Shared title', { exact: true }).waitFor();
  await page.locator('[data-key="terms-recent"]').click();
  const recentRow = page.locator(`#termsBody [data-key="recent:${sid}"]`);
  await recentRow.getByText('Shared title', { exact: true }).waitFor();
  await page.evaluate(() => select({ kind: 'term', id: '1' }, 'chat'));
  await page.reload();
  await title('Shared title');
  await page.evaluate(id => select({ kind: 'recent', id }, 'chat'), sid);
  await title('Shared title');
  await page.locator('#btnRenameSess').click();
  state.fail = true;
  await input.fill('Rejected');
  await input.press('Enter');
  await dialog.getByText('Fixture save failed').waitFor();
  await title('Shared title');
  state.fail = false;
  await input.fill('');
  await input.press('Enter');
  await title('Native default');
  await page.evaluate(() => select({ kind: 'term', id: '1' }, 'chat'));
  await title('Project default');
  const toolbox = page.locator('.tool-stream-bar .ts-right [data-ts-subagents]:visible');
  const badge = count => toolbox.getByText(`서브에이전트 ${count}`, { exact: true }).waitFor();
  const setPolling = paused => page.evaluate(value => { window.pauseSubagentPolling = value; }, paused);
  const receiveHook = () => page.waitForFunction(sequence => window.lastFixtureHook === sequence, state.hook());
  const aborted = pathname => page.waitForEvent('requestfailed', request => {
    const url = new URL(request.url());
    return url.pathname === pathname && url.searchParams.get('termId') === '1';
  });
  const openViewer = async () => {
    await toolbox.click();
    await page.getByRole('button', { name: /Reviewer/ }).click();
    await dialog.getByText('Inspect the fixture').waitFor();
  };
  await badge(3);
  await toolbox.locator('.dot.busy').waitFor({ state: 'hidden' });
  const started = Date.now();
  Object.assign(state.worker, { status: 'running', startedAt: started });
  await toolbox.locator('.dot.busy').waitFor({ timeout: 2000 });
  await badge(1);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2000);
  console.log(`Toolbox running badge (${native ? 'Tauri WebView2' : 'Chromium'}): ${elapsed} ms`);
  await setPolling(true);
  await openViewer();
  await dialog.getByText('Read', { exact: false }).waitFor();
  const oldList = state.holdList([{ ...state.worker, name: 'Outdated worker' }]);
  const oldDetail = state.holdDetail({ ok: true, status: 'running', events: [], lastMessage: 'Outdated output' });
  await receiveHook();
  const [[listUrl], [detailUrl]] = await Promise.all([oldList.arrived, oldDetail.arrived]);
  for (const url of [listUrl, detailUrl]) assert.equal(url.searchParams.get('sessionId'), sid);
  state.worker.status = 'done';
  state.output = 'Complete';
  state.result = 'File read successfully';
  await receiveHook();
  await Promise.all([oldList.release(), oldDetail.release()]);
  await dialog.locator('li').filter({ hasText: '결과 · Read' }).getByText(state.result).waitFor({ timeout: 2000 });
  await dialog.getByText('Complete', { exact: true }).waitFor({ timeout: 2000 });
  await toolbox.locator('.dot.busy').waitFor({ state: 'hidden' });
  assert.equal(await toolbox.evaluate(button => button.classList.contains('busy')), false);
  await badge(3);
  const closedDialog = await dialog.elementHandle();
  const lateDetail = state.holdDetail({ ok: true, status: 'running', events: [], lastMessage: 'Late closed output' });
  await receiveHook();
  await lateDetail.arrived;
  const detailAborted = aborted('/api/session/subagent-detail');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  await detailAborted;
  await lateDetail.release();
  assert.doesNotMatch(await closedDialog.evaluate(node => node.textContent), /Late closed output/);
  console.log('PASS: pending hooks refresh list and detail, and a closed viewer ignores late detail');

  const socket = state.socket();
  state.rejectHooks = true;
  const disconnected = once(socket, 'close', { signal: AbortSignal.timeout(5000) });
  socket.terminate();
  await disconnected;
  await setPolling(false);
  state.worker.status = 'running';
  await toolbox.locator('.dot.busy').waitFor({ timeout: 2000 });
  await badge(1);
  await setPolling(true);
  state.worker.status = 'done';
  const reconnected = state.nextSocket();
  state.rejectHooks = false;
  const [replacement] = await reconnected;
  assert.notEqual(replacement, socket);
  await badge(3);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  replacement.send('malformed JSON');
  state.worker.status = 'running';
  await receiveHook();
  await badge(1);
  state.worker.status = 'done';
  await receiveHook();
  await badge(3);
  assert.deepEqual(errors, []);
  console.log('PASS: polling during disconnection, socket reconnection, and malformed frame handling');

  await toolbox.click();
  await page.getByRole('heading', { name: '최근 완료/중단' }).waitFor();
  await page.getByRole('button', { name: /Reviewer/ }).waitFor();
  await page.getByRole('button', { name: /AGY worker/ }).waitFor();
  const oldToolbox = await toolbox.elementHandle();
  const lateList = state.holdList([{ ...state.worker, name: 'Late prior worker', status: 'running' }]);
  await receiveHook();
  await lateList.arrived;
  const listAborted = aborted('/api/session/subagents');
  await page.getByRole('button', { name: /Cursor worker/ }).click();
  await title('Plain terminal');
  await badge(1);
  await listAborted;
  await lateList.release();
  assert.doesNotMatch(await oldToolbox.evaluate(node => node.textContent), /Late prior worker/);
  assert.equal(await toolbox.evaluate(button => button.classList.contains('busy')), false);
  await page.locator('#btnRenameTerm').click();
  await input.fill('Synthetic title');
  await input.press('Enter');
  await title('Synthetic title');
  assert.equal(state.requests.at(-1), 'term:2');
  await toolbox.click();
  assert.equal(await page.getByRole('button', { name: /Late prior worker|Reviewer/ }).count(), 0);
  await page.getByRole('button', { name: /AGY worker/ }).click();
  await title('Native default');
  console.log('PASS: previous session requests are aborted on navigation');
}

if (require.main === module) (async () => {
  const state = await setup();
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    await verify(await browser.newPage({ viewport: { width: 1280, height: 800 } }), state);
    console.log('PASS: Chromium session title synchronization, dialog actions, and subagent navigation');
  } finally {
    await browser?.close();
    await state.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

module.exports = { setup, verify };
