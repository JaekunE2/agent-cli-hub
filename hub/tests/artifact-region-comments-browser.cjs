'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.HUB_PLAYWRIGHT || 'playwright');

const root = path.join(__dirname, '..', 'public');
const base = 'http://127.0.0.1:38779';
const fixturePage = '<!doctype html><html lang="ko"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/components.css"><body></body></html>';
const fixtureHtml = `<h1 id="headline" style="margin:0">Heading</h1><script>
addEventListener('message', ({data}) => {
  if (data.type === 'hub-review-scroll-request') {
    parent.postMessage({type: 'hub-review-scroll', x: 0, y: 100}, '*');
  }
  if (data.type === 'hub-review-element-request') {
    parent.postMessage({type: 'hub-review-element', request: data.request, selector: '#headline', bounds: [0, 0, 200, 40]}, '*');
  }
});
</script>`;

async function dragArea(page, overlay, fraction) {
  await overlay.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const {x, y, width, height} = await overlay.boundingBox();
  await page.mouse.move(x + width * fraction, y + height * fraction);
  await page.mouse.down();
  await page.mouse.move(x + width * (fraction + 0.2), y + height * (fraction + 0.16), {steps: 5});
  await page.mouse.up();
}

(async () => {
  const browser = await chromium.launch({channel: 'chrome', headless: true});
  try {
    const page = await browser.newPage({viewport: {width: 1100, height: 900}});
    page.setDefaultTimeout(6000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== base) return route.abort();
      if (url.pathname === '/') return route.fulfill({contentType: 'text/html', body: fixturePage});
      if (url.pathname === '/fixture.html') return route.fulfill({contentType: 'text/html', body: fixtureHtml});
      if (url.pathname === '/fixture.svg') return route.fulfill({contentType: 'image/svg+xml', body:
        '<svg xmlns="http://www.w3.org/2000/svg" width="360" height="240"><rect width="360" height="240" fill="white"/></svg>'});
      if (['/styles.css', '/components.css'].includes(url.pathname)) return route.fulfill({path: path.join(root, url.pathname)});
      return route.fulfill({status: 404});
    });
    await page.goto(base);
    await page.evaluate(() => {
      window.$ = (selector, root = document) => root.querySelector(selector);
      window.state = {sel: {kind: 'term', id: '31'}, terms: [{id: '31', agent: 'claude', exited: null}]};
      window.ICO = {};
      window.esc = value => String(value);
      window.fmtSize = () => '1 KB';
      window.currentSessionId = () => '';
      window.toast = () => {};
      window.sendWithRegionCheck = (_img, _item, regions, _target, _text, send, comment) => {
        window.lastCheck = {regions, comment};
        return send();
      };
      window.requests = [];
      window.rejectNext = false;
      window.api = async (endpoint, options) => {
        window.requests.push({endpoint, ...options.body});
        if (!window.rejectNext) return {ok: true};
        window.rejectNext = false;
        return {ok: false, delivery: 'not-sent', error: 'fixture send failed'};
      };
    });
    await page.addScriptTag({content: fs.readFileSync(path.join(root, 'files-artifacts.js'), 'utf8')});

    for (const [kind, ext] of [['image', 'svg'], ['html', 'html']]) {
      await page.evaluate(([kind, ext]) => openArtifact('', {kind, ext, path: 'fixture.' + ext, name: 'fixture.' + ext},
        '/fixture.' + ext), [kind, ext]);
      const dialog = page.locator('dialog:modal');
      if (kind === 'image') await dialog.locator('img').evaluate(img => img.decode());
      else await dialog.frameLocator('iframe').locator('#headline').waitFor();
      await dialog.locator('[data-av-review]').click();
      const editor = dialog.locator('.review-controls textarea');
      const send = dialog.locator('.review-controls button.primary');
      const overlay = dialog.locator('.review-overlay');
      const regions = dialog.locator('.review-regions button');
      assert.equal(await send.isDisabled(), true);

      await dragArea(page, overlay, .12);
      await regions.first().waitFor();
      const first = 'Region one: change the border';
      const second = 'Region two: change the background';
      await editor.fill(first);
      if (kind === 'html') {
        await dialog.getByRole('button', {name: '요소 지정', exact: true}).click();
        await overlay.click({position: {x: 16, y: 15}});
        await dialog.locator('.review-element-outline').waitFor();
      } else await dragArea(page, overlay, .52);
      await editor.fill(second);
      await dialog.locator('[data-review-full]').click();
      await editor.fill('Discard this draft');
      await dialog.getByRole('button', {name: '영역 제거', exact: true}).click();
      assert.equal(await regions.count(), 2);
      await regions.first().click();
      assert.equal(await editor.inputValue(), first);
      await page.evaluate(() => { window.rejectNext = true; });
      await send.click();
      await dialog.getByRole('status').getByText('fixture send failed').waitFor();
      assert.equal(await editor.inputValue(), first);
      assert.equal(await regions.count(), 2);

      await send.click();
      await regions.filter({hasText: '#1'}).waitFor({state: 'detached'});
      assert.equal(await editor.inputValue(), second);
      const firstRequest = await page.evaluate(() => window.requests.at(-1));
      assert.equal(firstRequest.endpoint, '/api/term/send');
      assert.match(firstRequest.text, /#1\n[\s\S]*Region one/);
      assert.doesNotMatch(firstRequest.text, /#2\n|Region two|#headline/);
      if (kind === 'image') {
        const check = await page.evaluate(() => window.lastCheck);
        assert.equal(check.regions.length, 1);
        assert.equal(check.comment, first);
      } else assert.match(firstRequest.text, /HTML 뷰포트[\s\S]*문서 좌표/);

      await send.click();
      await editor.waitFor({state: 'detached'});
      const secondRequest = await page.evaluate(() => window.requests.at(-1));
      assert.match(secondRequest.text, /#2\n[\s\S]*Region two/);
      assert.doesNotMatch(secondRequest.text, /#1\n|Region one/);
      if (kind === 'html') assert.match(secondRequest.text, /HTML 요소: #headline/);
      await dialog.locator('#avClose').click();
    }
    assert.equal(await page.evaluate(() => window.requests.length), 6);
    assert.deepEqual(errors, []);
    console.log('PASS: separate image and HTML comments, independent requests, and draft recovery on rejection.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
