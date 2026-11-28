'use strict';
const assert = require('node:assert/strict');
const { chromium } = require(process.env.HUB_PLAYWRIGHT || 'playwright');
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const calls = [];
    page.on('pageerror', e => console.error('PAGE:', e.message));
    let response = { ok: false, error: '테스트: 여유 계정 없음' };
    // All mutations are intercepted; real sessions are never switched by this test.
    await page.route('**/api/switch', async route => {
      calls.push(route.request().postDataJSON());
      await new Promise(resolve => setTimeout(resolve, 250));
      await route.fulfill({ json: response });
    });
    await page.route('**/api/switch/candidates?*', route => route.fulfill({ json: {
      sourceAgent: 'claude', candidates: [{ id: 'gpt-test', agent: 'codex', label: 'GPT test', usable: true, current: false, best: false, weekly: 5 }],
    } }));
    await page.goto(process.env.HUB_URL || 'http://127.0.0.1:7777/');
    await page.waitForFunction(() => typeof switchRecommended === 'function' && booted && state.terms?.length);
    const id = await page.evaluate(() => {
      const term = state.terms.find(t => t.claude && t.exited === null && t.sessionId);
      select({ kind: 'term', id: term.id }); return term.id;
    });
    const button = page.locator('[data-account-recommend]');
    await button.waitFor();
    await button.click();
    await page.waitForFunction(() => !document.querySelector('[data-account-recommend]').disabled);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].termId, id);
    assert.equal(calls[0].sameAgentOnly, true);
    assert.equal(calls[0].cont, true);
    assert.equal(calls[0].account, 'auto');
    response = { ok: false, busy: true };
    page.once('dialog', d => d.dismiss());
    await button.click();
    await page.waitForFunction(() => !document.querySelector('[data-account-recommend]').disabled);
    assert.equal(calls.length, 2); // cancellation must not send interrupt=true
    response = { ok: false, error: 'test' };
    await page.evaluate(async () => {
      const b = document.querySelector('[data-account-recommend]');
      await Promise.all([switchRecommended('double-click-test', '', b), switchRecommended('double-click-test', '', b)]);
    });
    assert.equal(calls.length, 3);
    response = { ok: true, term: { id }, account: { label: '테스트 추천 계정' }, followUpSubmitted: true };
    await button.click();
    await page.getByText('테스트 추천 계정 계정으로 전환하고 작업을 이어갑니다.', { exact: true }).waitFor();
    response = { ok: true, term: { id }, account: { label: '테스트 추천 계정' }, followUpSubmitted: false, deliveryError: '입력 전달 테스트 실패' };
    await button.click();
    await page.getByText(/계정은 전환됐지만 작업 재개 입력은 확인하지 못했습니다/).waitFor();
    await page.locator('[data-account-choose]').click();
    await page.locator('#swBody input[name=acc]').waitFor();
    assert.equal(await page.locator('#swGo').isDisabled(), true);
    await page.locator('#swBody input[name=acc]').check();
    assert.equal(await page.locator('#swGo').isEnabled(), true);
    await page.locator('[data-drw-close]').first().click();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await button.isVisible(), true);
    const overflow = await page.locator('.session-actions').evaluate(el => el.getBoundingClientRect().right > innerWidth + 1);
    assert.equal(overflow, false);
    if (process.env.HUB_SCREENSHOT) await page.screenshot({ path: process.env.HUB_SCREENSHOT });
    console.log('PASS visible buttons, same-agent continuation payload, busy cancel, duplicate click, success and delivery failure, manual selection, mobile layout');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
