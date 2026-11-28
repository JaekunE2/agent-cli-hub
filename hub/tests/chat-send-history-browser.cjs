'use strict';
// Read the running hub's session inventory but serve this checkout's UI assets.
// Every POST is intercepted; this test never submits a real terminal prompt.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.HUB_PLAYWRIGHT || 'playwright');
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    const errors = [], sent = [];
    let fail = false;
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      if (req.method() === 'POST') {
        if (url.pathname === '/api/term/send') {
          sent.push(req.postDataJSON());
          return route.fulfill({ json: fail ? { ok: false, error: 'fixture rejected', delivery: 'not-sent' } : { ok: true } });
        }
        return route.fulfill({ status: 409, json: { ok: false, error: 'unexpected fixture mutation' } });
      }
      const file = path.join(__dirname, '../public', path.basename(url.pathname));
      if (/\.(js|css)$/.test(url.pathname) && fs.existsSync(file)) return route.fulfill({ path: file });
      return route.continue();
    });
    await page.goto(process.env.HUB_URL || 'http://127.0.0.1:7777/');
    await page.waitForFunction(() => booted && state.terms?.length);
    await page.evaluate(() => {
      const term = state.terms.find(t => t.claude && t.exited === null && t.sessionId);
      select({ kind: 'term', id: term.id }, 'chat');
    });
    const input = page.locator('.chat-comp-host textarea');
    const send = page.locator('.chat-comp-host .chat-reply-in button.primary');
    await input.fill('fixture successful prompt');
    await send.click();
    await page.waitForFunction(() => document.querySelector('.chat-comp-host textarea')?.value === '');
    await input.press('ArrowUp');
    assert.equal(await input.inputValue(), 'fixture successful prompt');
    fail = true;
    await input.fill('fixture failed draft');
    await send.click();
    await page.locator('[data-chat-send-note]').getByText(/fixture rejected/).waitFor();
    assert.equal(await input.inputValue(), 'fixture failed draft');
    assert.equal(sent.length, 2);
    assert.deepEqual(errors, []);
    console.log('PASS merged composer: successful send enters history, rejected send preserves draft, no page errors');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
