'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.HUB_PLAYWRIGHT || 'playwright');

(async () => {
  const server = http.createServer((req, res) => res.end('<!doctype html><html><body><div id="host"></div></body></html>'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(() => {
      window.state = { features: { agy: false }, sel: {} };
      window.esc = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
      window.uiLocale = () => 'ko-KR';
      window.calls = [];
      window.availableCount = 2;
      window.failOnce = true;
      window.api = async (url, options) => {
        if (options?.method === 'POST') {
          window.calls.push(options.body);
          if (window.failOnce) { window.failOnce = false; throw new Error('network timeout'); }
          return { ok: true, outcome: 'alreadyRedeemed' };
        }
        return { ok: true, account: { email: 'selected@example.com' }, rateLimitResetCredits: { availableCount: window.availableCount, credits: null } };
      };
    });
    await page.addScriptTag({ path: path.join(__dirname, '../public/usage-ui.js') });
    await page.evaluate(() => { refreshUsage = async () => {}; return loadCodexResetCredits(document.querySelector('#host'), { id: 'test-account' }); });
    assert.match(await page.locator('#host').innerText(), /2장/);
    page.once('dialog', d => d.dismiss());
    await page.locator('[data-reset-use]').click();
    assert.equal(await page.evaluate(() => calls.length), 0);
    page.once('dialog', d => d.accept());
    await page.locator('[data-reset-use]').click();
    await page.getByText(/network timeout/).waitFor();
    const first = await page.evaluate(() => calls[0].idempotencyKey);
    // Reopening a drawer must recover the pending key, including when the credit is already gone.
    await page.evaluate(() => { availableCount = 0; return loadCodexResetCredits(document.querySelector('#host'), { id: 'test-account' }); });
    assert.equal(await page.locator('[data-reset-use]').isEnabled(), true);
    await page.locator('[data-reset-use]').click();
    await page.getByText(/추가 티켓은 사용하지 않았습니다/).waitFor();
    assert.equal(await page.evaluate(() => calls[1].idempotencyKey), first);
    assert.equal(await page.evaluate(() => localStorage.getItem('codex-reset-pending:test-account')), null);
    assert.equal(await page.locator('[data-reset-use]').isEnabled(), false);
    await page.evaluate(() => { availableCount = null; return loadCodexResetCredits(document.querySelector('#host'), { id: 'test-account' }); });
    assert.match(await page.locator('#host').innerText(), /정보 없음/);
    assert.equal(await page.locator('[data-reset-use]').isEnabled(), false);
    console.log('PASS: count, cancel, ambiguous failure, persistent retry key, idempotent success, zero/unknown disabled');
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(e => { console.error(e); process.exitCode = 1; });
