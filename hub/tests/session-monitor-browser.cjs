'use strict';

const assert = require('node:assert/strict');
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
  const state = { requests: [], worker, fail: false, output: 'Working' };
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
    if (url.pathname === '/api/session/subagents') return reply({ subagents: [
      worker, { id: 'term:2', name: 'Cursor worker', agent: 'cursor', status: 'done', targetTermId: '2', startedAt: Date.now() },
      { id: 'agy-worker', name: 'AGY worker', agent: 'agy', status: 'done', targetSessionId: sid, startedAt: Date.now() },
    ].filter(Boolean) });
    if (url.pathname === '/api/session/subagent-detail') return reply({
      ok: true, prompt: 'Inspect the fixture', events: [{ type: 'call', tool: 'Read', input: 'fixture' }],
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
  return Object.assign(state, await fixture({ list: () => [], hidden: () => new Set() }, handle));
}

async function verify(page, state, { native = false } = {}) {
  page.setDefaultTimeout(10_000);
  await page.addInitScript(() => { window.prompt = () => { throw new Error('Unexpected prompt()'); }; });
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
  await page.reload();
  await title('Shared title');
  await page.locator('[data-key="terms-recent"]').click();
  await page.locator(`#termsBody [data-key="recent:${sid}"]`).getByText('Shared title', { exact: true }).waitFor();
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
  const toolbox = page.locator('[data-ts-subagents]');
  await toolbox.locator('.dot.busy').waitFor({ state: 'hidden' });
  const started = Date.now();
  Object.assign(state.worker, { status: 'running', startedAt: started });
  await toolbox.locator('.dot.busy').waitFor({ timeout: 2000 });
  assert.ok(Date.now() - started < 2000);
  await toolbox.click();
  await page.getByRole('button', { name: /Reviewer/ }).click();
  await dialog.getByText('Inspect the fixture').waitFor();
  await dialog.getByText('Read', { exact: false }).waitFor();
  state.worker.status = 'done';
  state.output = 'Complete';
  await dialog.getByText('Complete', { exact: true }).waitFor({ timeout: 2000 });
  await page.keyboard.press('Escape');
  await toolbox.click();
  await page.getByRole('button', { name: /Cursor worker/ }).click();
  await title('Plain terminal');
  await page.locator('#btnRenameTerm').click();
  await input.fill('Synthetic title');
  await input.press('Enter');
  await title('Synthetic title');
  assert.equal(state.requests.at(-1), 'term:2');
  await toolbox.click();
  await page.getByRole('button', { name: /AGY worker/ }).click();
  await title('Native default');
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
