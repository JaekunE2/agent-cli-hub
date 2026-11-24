const assert = require('node:assert/strict');
const { chromium } = require(process.env.HUB_PLAYWRIGHT || 'playwright');

(async () => {
  let stage = 0;
  const fixture = await require('./browser-fixture')({ list: () => [], hidden: () => new Set() }, (url, req, res) => {
    if (url.pathname !== '/api/overview') return false;
    res.setHeader('content-type', 'application/json');
    const terminal = { cwd: 'D:\\demo', exited: null, agent: 'codex' };
    res.end(JSON.stringify({ terms: [
      { ...terminal, id: '1', title: 'Completion check', status: stage ? 'idle' : 'busy' },
      ...(stage < 2 ? [{ ...terminal, id: '2', title: 'Confirmation check', startupBlock: stage ? 'confirmation' : null }] : []),
    ] }));
    return true;
  });
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome' });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => {
      window.notices = [];
      window.__TAURI_INTERNALS__ = {
        invoke: async (name, payload) => {
          if (name === 'notify_terminal') window.notices.push(payload);
          return name === 'notify_terminal';
        },
      };
      localStorage.setItem('ach-notify', '1');
    });
    await page.goto(fixture.url);
    await page.waitForFunction(() => booted && state.terms.length === 2);
    await page.evaluate(() => {
      select({ kind: 'term', id: '1' });
      Object.defineProperty(document, 'hidden', { value: true });
    });
    stage = 1;
    await page.waitForFunction(() => window.notices.length === 2);
    assert.deepEqual(await page.evaluate(() => notices.map(n => [n.id, n.viewing]).sort()), [['1', true], ['2', false]]);
    for (const id of ['2', '1']) {
      await page.evaluate(id => { location.hash = '#term:' + id; }, id);
      await page.waitForFunction(id => state.sel.id === id && location.hash.startsWith('#term:' + id + ':'), id);
    }
    stage = 2;
    await page.evaluate(() => refreshOverview());
    await page.evaluate(() => { location.hash = '#term:2'; });
    await page.waitForFunction(() => state.sel.kind === 'home' && location.hash === '#home');
    assert.equal(await page.evaluate(() => notices.length), 2);
    assert.deepEqual(errors, []);
    console.log('PASS hidden completion and confirmation, distinct terminal routes, and closed-terminal fallback');
  } finally {
    await browser?.close();
    await fixture.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
