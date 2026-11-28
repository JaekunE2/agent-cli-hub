const assert = require('node:assert/strict');
const { chromium } = require(process.env.HUB_PLAYWRIGHT || 'playwright');
const { source: axe } = require(process.env.HUB_AXE_CORE || 'axe-core');
const schedules = require('./schedule-browser-fixture.cjs');
const folders = require('./workspace-folder-browser-fixture.cjs');

const focused = locator => locator.evaluate(el => el === document.activeElement);
const button = (page, name) => page.getByRole('button', { name, exact: true });
const cases = [
  ['ko', 'light'], ['ko', 'dark'], ['en', 'light'], ['en', 'dark'],
];

async function open(page, trigger, dialog) {
  await trigger.focus();
  await page.keyboard.press('Enter');
  await dialog.waitFor();
}

async function tab(page, dialog, note) {
  note('focus inside before Tab', await dialog.evaluate(el => el.contains(document.activeElement)));
  await page.keyboard.press('Tab');
  const active = await dialog.evaluate(el => ({ inside: el.contains(document.activeElement),
    target: document.activeElement?.textContent.trim().slice(0, 80) }));
  note('Tab within drawer', active.inside, active.inside ? undefined : active.target);
}

async function close(page, trigger, dialog, note) {
  await page.keyboard.press('Escape');
  const closed = !(await dialog.isVisible());
  note('Escape closes drawer', closed);
  if (!closed) await dialog.locator('[data-drw-close]').click();
  const returned = await focused(trigger);
  note('focus returns to trigger', returned, returned ? undefined :
    await page.evaluate(() => document.activeElement?.outerHTML.split('>')[0]));
}

async function audit(page, dialog, note) {
  await dialog.evaluate(async el => {
    await Promise.allSettled(el.getAnimations({ subtree: true }).map(animation => animation.finished));
  });
  const result = await page.evaluate(selector => axe.run(selector, {
    runOnly: { type: 'rule', values: ['color-contrast', 'button-name', 'label', 'aria-dialog-name'] },
  }), await dialog.evaluate(el => el.matches('[role="dialog"]') ? '[role="dialog"]' : 'dialog[open]'));
  const contrast = result.passes.find(rule => rule.id === 'color-contrast');
  note('contrast samples evaluated', Boolean(contrast?.nodes.length || result.violations.some(rule => rule.id === 'color-contrast')));
  for (const rule of result.violations) {
    note(rule.id, false, rule.nodes.map(node => ({ target: node.target, detail: node.failureSummary })));
  }
  console.log(JSON.stringify({ contrastPass: contrast?.nodes.length ?? 0,
    contrastReview: result.incomplete.find(rule => rule.id === 'color-contrast')?.nodes.map(node => node.target) ?? [] }));
}

async function schedule(page, app, label, note) {
  await page.goto(app.url + '/?t=fixture&open=schedules');
  const create = button(page, label('스케줄 만들기', 'Create schedule'));
  await page.waitForFunction(() => !document.querySelector('[data-schedule-create]')?.disabled);
  const dialog = page.getByRole('dialog');
  await open(page, create, dialog);
  await tab(page, dialog, note);
  await audit(page, dialog, note);
  await close(page, create, dialog, note);

  await create.click();
  const field = name => dialog.locator(`[name="${name}"]`);
  await field('name').fill('Matrix schedule');
  await field('projectId').selectOption('demo');
  await field('version').selectOption('1.5.0');
  await field('cli').selectOption('codex');
  await field('prompt').fill('QA fixture');
  await dialog.locator('[data-schedule-save]').click();
  await page.locator('.schedule-card').getByText(label('일시정지됨', 'Paused'), { exact: true }).waitFor();
  await page.locator('[data-schedule-action=run]').click();
  const history = page.locator('[data-schedule-action=history]');
  await history.focus();
  await page.keyboard.press('Enter');
  await dialog.getByText(label('시작 중', 'Starting'), { exact: true }).waitFor();
  await app.finish();
  const result = dialog.getByText(label('성공', 'Succeeded'), { exact: true });
  await result.waitFor();
  note('updated result is in a live region', await result.evaluate(el =>
    Boolean(el.closest('[role="status"], [aria-live="polite"], [aria-live="assertive"]'))));
  await audit(page, dialog, note);
  await close(page, history, dialog, note);
}

async function workspace(page, app, label, note) {
  await page.goto(app.url + '/?t=fixture&open=t:1&tab=chat');
  const badge = page.locator('#bar [data-workspace-folder]');
  await badge.waitFor();
  const dialog = page.getByRole('dialog');
  await open(page, badge, dialog);
  await dialog.getByRole('heading', { name: label('주 폴더', 'Primary folder'), exact: true }).waitFor();
  await dialog.getByText(app.main, { exact: true }).first().waitFor();
  await dialog.getByText(label('참조 폴더 없음', 'No reference folders'), { exact: true }).waitFor();
  note('localized primary path and empty reference state', true);
  await tab(page, dialog, note);
  const closeButton = dialog.locator('[data-drw-close]');
  const saveButton = dialog.getByRole('button', { name: label('폴더 설정 저장', 'Save folders'), exact: true });
  await closeButton.focus();
  await page.keyboard.press('Shift+Tab');
  note('Shift+Tab wraps to the last control', await focused(saveButton));
  await page.keyboard.press('Tab');
  note('Tab wraps to the close control', await focused(closeButton));
  await audit(page, dialog, note);
  await close(page, badge, dialog, note);
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  let failures = 0;
  try {
    for (const [lang, theme] of cases) {
      for (const [check, fixture] of [[schedule, schedules], [workspace, folders]]) {
        const key = `${check.name} ${lang}/${theme}`;
        const app = await fixture(lang);
        const page = await browser.newPage();
        let issues = 0;
        const note = (item, ok, details) => {
          if (!ok) issues++;
          console.log(JSON.stringify({ key, item, ok, details }));
        };
        try {
          page.setDefaultTimeout(6000);
          await page.addInitScript(value => localStorage.setItem('ach-theme', value), theme);
          await page.route('**/*', route => new URL(route.request().url()).origin === app.url ? route.continue() : route.abort());
          await page.addInitScript(axe);
          await check(page, app, (ko, en) => lang === 'en' ? en : ko, note);
          assert.equal(await page.locator('html').getAttribute('lang'), lang);
          assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
        } catch (error) {
          note('scenario completed', false, error.message);
        } finally {
          await page.close();
          await app.close();
        }
        if (issues) failures++;
        console.log(`${issues ? 'FAIL' : 'PASS'} ${key}: ${issues} failing checks`);
      }
    }
  } finally {
    await browser.close();
  }
  console.log(`Matrix: ${8 - failures} passed, ${failures} failed`);
  process.exitCode = Number(failures > 0);
})().catch(error => { console.error(error); process.exitCode = 1; });
