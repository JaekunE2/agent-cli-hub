'use strict';

const assert = require('node:assert/strict');
const { chromium, devices } = require(process.env.HUB_PLAYWRIGHT || 'playwright');
const fixture = require('./workspace-folder-browser-fixture.cjs');
const header = '#bar [data-workspace-folder]';
const detail = '[data-folder-detail]';
const side = (id) => `#side [data-key="term:${id}"]`;
const shown = (page, selector, value) => page.locator(selector).filter({ hasText: value }).first().waitFor();
const waitTitle = (page, selector, value) => page.waitForFunction(([s, v]) => document.querySelector(s)?.title.includes(v), [selector, value]);

async function web(page, app) {
  await page.goto(`${app.url}/?t=fixture&open=t:1&tab=chat`);
  await waitTitle(page, header, app.main);
  await shown(page, '.ts-right [data-workspace-folder]:visible', 'Main');
  await waitTitle(page, `${side(1)} [data-workspace-folder]`, app.main);
  await page.locator(header).click();
  await shown(page, detail, app.main);
  await page.locator('[data-folder-main]').fill(app.other);
  await page.locator('[data-folder-ref]').fill(app.ref);
  await page.locator('[data-folder-add]').click();
  await page.locator('[data-folder-ref]').fill(app.native);
  await page.locator('[data-folder-ref]').press('Enter');
  await page.getByRole('button', { name: '폴더 설정 저장' }).click();
  await shown(page, detail, '참조 폴더 2');
  await waitTitle(page, header, '참조 폴더 2');
  await waitTitle(page, header, app.other);
  await page.locator('[data-folder-main]').fill(app.main);
  await page.locator('[data-folder-remove="1"]').click();
  await page.getByRole('button', { name: '폴더 설정 저장' }).click();
  await shown(page, detail, '참조 폴더 1');
  await waitTitle(page, `${side(1)} [data-workspace-folder]`, '미신뢰');
  await page.locator('[data-approve-folder]').first().click();
  await page.locator('[data-approve-folder]').last().click();
  await waitTitle(page, header, '신뢰됨');
  await waitTitle(page, '.ts-right [data-workspace-folder]', '신뢰됨');
  await page.locator('[data-drw-close]').click();
  await page.locator(`${side(2)} [data-workspace-folder]`).click();
  await shown(page, detail, app.other);
  assert.ok((await page.locator(header).getAttribute('title')).includes(app.main));
  await page.locator('[data-drw-close]').click();
  await page.locator(`${side(2)} .srow-open`).click();
  await waitTitle(page, header, app.other);
  assert.ok(!(await page.locator(header).getAttribute('title')).includes(app.main));

  await page.locator('[data-key="system"]').click();
  await page.locator('[data-systab="trusted-folders"]').click();
  await shown(page, '[data-trust-list]', app.ref);
  const row = page.locator('[data-trust-list] li').filter({ hasText: app.ref });
  const patched = page.waitForResponse((response) => response.request().method() === 'PATCH' && response.url().includes('/api/trusted-folders/'));
  await row.locator('[data-trust-desc]').check();
  assert.ok((await patched).ok());
  await row.locator('[data-trust-remove]').click();
  await waitTitle(page, `${side(1)} [data-workspace-folder]`, '미신뢰');
  await page.locator('.folder-settings input[name="path"]').fill(app.ref);
  await page.getByRole('button', { name: '신뢰 폴더 등록' }).click();
  await waitTitle(page, `${side(1)} [data-workspace-folder]`, '신뢰됨');
}

async function native(page, app) {
  await page.addInitScript(({ main, paths }) => {
    window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
      if (command !== 'pick_folder') return;
      if (args.initialPath !== main) throw new Error('Incorrect native picker initial path');
      return paths.shift();
    } };
  }, { main: app.main, paths: [app.native, app.secondNative] });
  await page.goto(`${app.url}/?t=fixture&open=t:1&tab=dock`);
  await page.locator(header).click();
  for (const path of [app.native, app.secondNative]) {
    await page.getByRole('button', { name: 'Browse Folder', exact: true }).last().click();
    await shown(page, '[data-folder-draft]', path);
  }
  await page.getByRole('button', { name: 'Save folders', exact: true }).click();
  await shown(page, detail, 'Reference folders 2');
  await shown(page, detail, 'Trust this folder');
  await page.locator('[data-drw-close]').click();

  let release, requested;
  const gate = new Promise((resolve) => { release = resolve; });
  const waiting = new Promise((resolve) => { requested = resolve; });
  await page.route('**/api/sessions/term%3A1/folders', async (route) => {
    requested();
    await gate;
    await route.abort();
  });
  await page.locator(header).click();
  await waiting;
  try {
    // Keep the drawer request in flight while navigating through the app router.
    await page.evaluate(() => select({ kind: 'term', id: '2' }));
    await waitTitle(page, header, app.other);
    await page.locator('[data-folder-detail]').waitFor({ state: 'detached' });
    await page.locator(header).click();
    await shown(page, detail, app.other);
  } finally { release(); }
  assert.ok(!(await page.locator(detail).innerText()).includes(app.main));
}

async function remote(page, app) {
  await page.goto(`${app.url.replace('127.0.0.1', 'ach-fixture.test')}/?t=fixture&open=t:1&tab=dock`);
  await shown(page, header, 'Folder unknown');
  assert.ok(!(await page.locator(header).getAttribute('title')).includes(app.main));
  await page.locator(header).click();
  await shown(page, detail, 'Reference folders 2');
  assert.equal(await page.locator('[data-folder-main]').count(), 0);
  assert.ok(!(await page.locator(detail).innerText()).includes(app.native));
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome',
    args: ['--no-proxy-server', '--host-resolver-rules=MAP ach-fixture.test 127.0.0.1'] });
  try {
    for (const [language, scenarios] of [['ko', [web]], ['en', [native, remote]]]) {
      const app = await fixture(language);
      try {
        for (const scenario of scenarios) {
          const page = await browser.newPage(scenario === remote ? devices['Pixel 7'] : {});
          page.setDefaultTimeout(10000);
          const errors = [];
          page.on('pageerror', (error) => errors.push(error.message));
          try { await scenario(page, app); assert.deepEqual(errors, []); }
          finally { await page.close(); }
        }
        assert.deepEqual(app.errors, []);
      } finally { await app.close(); }
    }
    console.log('PASS Chrome: Korean web editing and trust management, English repeated Tauri selection and stale session response, mobile remote summary');
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
