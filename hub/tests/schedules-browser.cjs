const assert = require('node:assert/strict');
const { chromium } = require(process.env.HUB_PLAYWRIGHT || 'playwright');
const fixture = require('./schedule-browser-fixture.cjs');

async function check(page, app, lang, theme) {
  const label = (ko, en) => lang === 'en' ? en : ko;
  const action = name => page.locator(`[data-schedule-action="${name}"]`);
  const status = text => page.locator('.schedule-card .schedule-badge').getByText(text, { exact: true });
  const field = name => page.locator(`.schedule-form [name="${name}"]`);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(theme => localStorage.setItem('ach-theme', theme), theme);
  await page.route('**/*', route => new URL(route.request().url()).origin === app.url ? route.continue() : route.abort());
  await page.goto(app.url + '/?t=fixture');
  await page.locator('#side [data-key="schedules"]').click();
  await page.getByRole('button', { name: label('스케줄 만들기', 'Create schedule') }).click();
  const dialog = page.getByRole('dialog');
  assert.equal(await page.locator('html').getAttribute('lang'), lang);
  assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
  assert.equal(await dialog.getAttribute('aria-label'), label('스케줄 만들기', 'Create schedule'));
  await field('name').fill('Daily check');
  await field('projectId').selectOption('demo');
  await field('version').selectOption('1.5.0');
  await field('cli').selectOption('codex');
  await field('preset').selectOption('15');
  assert.equal(await field('everyMinutes').inputValue(), '15');
  await field('preview').click();
  await page.locator('[data-schedule-preview] li').nth(4).waitFor();
  await field('prompt').fill('Summarize recent activity');
  await field('overlap').selectOption('queue');
  await field('misfire').selectOption('run_once');
  await page.locator('[data-schedule-save]').click();
  await status(label('일시정지됨', 'Paused')).waitFor();
  await action('edit').click();
  await field('kind').selectOption('cron');
  await field('preset').selectOption('0 9 * * 1-5');
  await field('expression').fill('30 9 * * 1-5');
  await field('timeZone').fill('Asia/Seoul');
  await field('preview').click();
  await page.locator('[data-schedule-preview] li').nth(4).waitFor();
  await page.locator('[data-schedule-save]').click();
  await page.getByText('30 9 * * 1-5 · Asia/Seoul', { exact: false }).waitFor();
  await action('resume').click();
  await status(label('활성', 'Active')).waitFor();
  await page.locator('.schedule-countdown').filter({ hasText: /\d+:\d{2}:\d{2}/ }).waitFor();
  await action('pause').click();
  await status(label('일시정지됨', 'Paused')).waitFor();
  await action('run').click();
  await action('history').click();
  await dialog.getByText(label('즉시 실행', 'Run now'), { exact: true }).waitFor();
  await dialog.getByText(label('시작 중', 'Starting'), { exact: true }).waitFor();
  await app.finish();
  await dialog.getByText('Fixture summary').waitFor();
  await status(label('성공', 'Succeeded')).waitFor();
  const reconnect = app.reconnected();
  await app.disconnect();
  const { id, revision } = app.engine.snapshot().schedules[0];
  await app.engine.update(id, revision, { name: 'Updated while offline' });
  await page.locator('.schedule-card h3').getByText('Updated while offline', { exact: true }).waitFor();
  await reconnect;
  await dialog.locator('[data-drw-close]').click();
  app.cli.available = false;
  await app.disconnect();
  await page.getByText(label('스케줄 실행기를 사용할 수 없습니다.', 'The schedule runner is unavailable.')).waitFor();
  assert.ok(await action('resume').isDisabled());
  assert.ok(await action('run').isDisabled());
  assert.deepEqual(errors, []);
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const lang of ['ko', 'en']) {
      for (const theme of ['light', 'dark']) {
        const app = await fixture(lang);
        const page = await browser.newPage();
        page.setDefaultTimeout(8000);
        try {
          await check(page, app, lang, theme);
          console.log(`PASS ${lang}/${theme}: create, preview, edit, resume, pause, run, history, reconnect and unavailable runner`);
        } finally {
          await page.close();
          await app.close();
        }
      }
    }
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
