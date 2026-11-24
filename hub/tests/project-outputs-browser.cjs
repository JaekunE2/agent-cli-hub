const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.env.HUB_PLAYWRIGHT || 'playwright');

async function checkHarness(page, fixture) {
  const { url, project, harnessPath, defaults } = fixture;
  const model = page.locator('[data-hr-field=model]');
  const rules = page.locator('[data-hr-adapter=codex] textarea');
  const drawer = page.getByRole('dialog', { name: 'Role · 에이전트 하네스 설정' });
  const roleTab = page.locator('[data-hr-tab=roles]');
  const adapterTab = page.locator('[data-hr-tab=adapters]');
  const stored = () => JSON.parse(fs.readFileSync(harnessPath, 'utf8'));
  const submit = async (id, status) => {
    const response = page.waitForResponse(r => r.url().endsWith('/api/projects/harness') && r.request().method() === 'POST');
    await page.locator(id).click();
    const res = await response;
    assert.equal(res.status(), status);
    return res.json();
  };
  await page.goto(url + '/#projects:' + project.id + ':board');
  await page.locator('#projectHarness').click();
  assert.equal(await model.inputValue(), 'legacy-model');
  await model.fill('edited-model');
  await adapterTab.click();
  assert.equal(await rules.inputValue(), 'legacy rules');
  await rules.fill('edited rules');
  await roleTab.click();
  const before = stored();
  const success = page.getByText(/Role · 에이전트 하네스를 (저장했습니다|기본값으로 복원했습니다)/);
  page.on('dialog', dialog => dialog.accept());
  fs.mkdirSync(harnessPath + '.tmp');
  try {
    for (const id of ['#hrSaveBtn', '#hrResetBtn']) {
      const { error } = await submit(id, 500);
      await page.getByText(error, { exact: true }).first().waitFor();
      assert.equal(await drawer.isVisible(), true);
      assert.equal(await success.count(), 0);
      assert.equal(await model.inputValue(), 'edited-model');
      assert.deepEqual(stored(), before);
    }
  } finally { fs.rmdirSync(harnessPath + '.tmp'); }
  await submit('#hrSaveBtn', 200);
  await drawer.waitFor({ state: 'detached' });
  assert.equal(stored().roles.plan.model, 'edited-model');
  assert.equal(stored().adapters.codex.rules, 'edited rules');
  await page.reload();
  await page.locator('#projectHarness').click();
  assert.equal(await model.inputValue(), 'edited-model');
  await adapterTab.click();
  assert.equal(await rules.inputValue(), 'edited rules');
  await submit('#hrResetBtn', 200);
  await drawer.waitFor({ state: 'detached' });
  await page.reload();
  await page.locator('#projectHarness').click();
  assert.equal(await model.inputValue(), defaults.roles.plan.model);
  await adapterTab.click();
  assert.equal(await rules.inputValue(), defaults.adapters.codex.rules);
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-outputs-browser-'));
  let fixture, browser;
  try {
    fixture = await require('./project-output-fixture')(dir);
    browser = await chromium.launch({ headless: true });
    for (const [width, height] of [[1440, 1000], [390, 844]]) {
      for (const theme of ['light', 'dark']) {
        const page = await browser.newPage({ viewport: { width, height } });
        page.setDefaultTimeout(8000);
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.addInitScript(mode => localStorage.setItem('ach-theme', mode), theme);
        await page.route('**/*', route => new URL(route.request().url()).origin === fixture.url ? route.continue() : route.abort());
        await checkHarness(page, fixture);
        await require('./project-outputs-checks')(page, fixture);
        assert.deepEqual(errors, []);
        await page.close();
        const harness = require('../project-harness').createProjectHarnessStore(fixture.harnessPath);
        harness.save({ roles: { plan: { model: 'legacy-model' } }, adapters: { codex: { rules: 'legacy rules' } } });
        console.log(`PASS ${width}x${height} ${theme}: harness, floorplan, artifacts`);
      }
    }
  } finally {
    if (browser) await browser.close();
    if (fixture) await fixture.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
