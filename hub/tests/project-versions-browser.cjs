const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.env.HUB_PLAYWRIGHT || 'playwright');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-versions-browser-'));
  const cwd = path.join(dir, 'project');
  fs.mkdirSync(cwd);
  const file = path.join(cwd, 'notes.txt');
  fs.writeFileSync(file, 'original');
  fs.writeFileSync(path.join(cwd, 'archived.js'), 'module.exports = 1;');
  const projects = require('../projects')(path.join(dir, 'projects.json'));
  const baseTask = { id: 'base-task', title: 'Base task', detail: '', stage: 'planned', after: [], termId: '' };
  const project = projects.save({ name: 'Versions example', cwd, goal: 'Version a local project', termIds: [], tasks: [baseTask] });
  const { handleProjectRoutes } = require('../routes-projects').createProjectRoutes({
    baseDir: dir, config: { versionStorageDir: path.join(dir, 'versions') }, projects,
    scanFloorplan: require('../workspace-floorplan').scanFloorplan,
    projectRefs: require('../project-refs').createProjectRefsStore(path.join(dir, 'refs')),
  });
  const fixture = await require('./browser-fixture')(projects, (url, req, res) => {
    if (!(url.pathname === '/api/projects' && req.method === 'POST') &&
      !/^\/api\/projects\/(refs|floorplan)(\/|$)/.test(url.pathname)) return false;
    return handleProjectRoutes(url.pathname, url, req, res, async () => {
      let data = '';
      for await (const chunk of req) data += chunk;
      return JSON.parse(data);
    }, (response, code, data) => {
      response.writeHead(code, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(data));
    }, () => true);
  });
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.HUB_BROWSER_CHANNEL ? { channel: process.env.HUB_BROWSER_CHANNEL } : {}) });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const button = (name) => page.getByRole('button', { name, exact: true });
    const capture = (name) => process.env.HUB_SCREENSHOT_DIR
      ? page.screenshot({ path: path.join(process.env.HUB_SCREENSHOT_DIR, name + '.png'), fullPage: true }) : null;
    const url = fixture.url + '/#projects:' + project.id + ':versions';
    await page.goto(url.replace('/#', '/?t=fixture#'));
    await button('버전 저장').click();
    assert.equal(await page.getByLabel('버전 번호').inputValue(), '1.0.0');
    assert.equal(await page.locator('[name=version]').evaluate((el) => el === document.activeElement), true);
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    assert.equal(await button('버전 저장').evaluate((el) => el === document.activeElement), true);
    await button('버전 저장').click();
    await page.getByLabel('버전 메모').fill('원본 상태 보관');
    await capture('desktop-save');
    await button('저장').click();
    await button('이 버전에서 이어 작업').waitFor();
    assert.equal(new URL(page.url()).hash, '#projects:' + project.id + ':versions:1.0.0');
    fs.writeFileSync(file, 'later changes');
    fs.renameSync(path.join(cwd, 'archived.js'), path.join(cwd, 'current.js'));
    const scan = (number) => page.request.get(fixture.url + '/api/projects/floorplan?id=' + project.id + '&version=' + number).then((r) => r.json());
    assert.deepEqual((await scan('1.0.0')).floorplan.nodes.map((node) => node.relPath), ['archived.js']);
    await capture('desktop-version');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    const restore = button('이 버전에서 이어 작업');
    await restore.waitFor();
    assert.ok((await restore.boundingBox()).height >= 44);
    await capture('mobile-version');
    await restore.click();
    await button('이 버전에 작업 추가').waitFor();
    const workspace = projects.list()[0].versions[0].workspace;
    assert.equal(fs.readFileSync(path.join(workspace, 'notes.txt'), 'utf8'), 'original');
    assert.equal(fs.readFileSync(file, 'utf8'), 'later changes');
    await button('버전 저장').click();
    assert.equal(await page.getByLabel('버전 번호').inputValue(), '1.0.1');
    await capture('mobile-save');
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    await button('버전 설계 보기').click();
    await page.locator('.pj-goal').getByText('원본 상태 보관').waitFor();
    await page.locator('#projectAdd').click();
    await page.getByLabel('작업 제목').fill('Version task');
    await button('저장').click();
    await page.locator('[data-plan-task]').getByText('Version task').waitFor();
    assert.deepEqual(projects.list()[0].tasks.map((task) => [task.title, task.version]), [['Base task', ''], ['Version task', '1.0.0']]);
    await page.locator('#projectEdit').click();
    const goal = ['Version goal', ...Array.from({ length: 24 }, (_, i) => `Criterion ${i + 1}`)].join('\n');
    await page.getByLabel('목표 · 완료 기준').fill(goal);
    await button('저장').click();
    await page.locator('.pj-goal').getByText('Version goal').waitFor();
    const preview = page.locator('#projectGoalPreview');
    assert.equal(await preview.locator('span').evaluate((el) => el.scrollHeight > el.clientHeight), true);
    await preview.click();
    const goalDialog = page.getByRole('dialog', { name: '목표 · 완료 기준' });
    assert.equal(await goalDialog.locator('.pj-goal-body').textContent(), goal);
    await page.keyboard.press('Escape');
    await goalDialog.waitFor({ state: 'detached' });
    assert.equal(await preview.evaluate((el) => document.activeElement === el), true);
    await preview.click();
    await goalDialog.getByRole('button', { name: '닫기' }).click();
    await goalDialog.waitFor({ state: 'detached' });
    const refsUrl = fixture.url + '/api/projects/refs';
    for (const [version, name] of [['', 'base-note.md'], ['1.0.0', 'version-note.md']]) {
      const response = await page.request.post(refsUrl, { data: { projectId: project.id, version, name, text: name } });
      assert.equal(response.status(), 200);
    }
    for (const tab of ['design', 'board', 'flow', 'floorplan', 'refs', 'terms', 'versions']) {
      const control = page.locator(`[data-pjtab="${tab}"]`);
      await control.click();
      await control.and(page.locator('[aria-selected=true]')).waitFor();
      await page.locator('#projectContent').waitFor();
      assert.equal(await page.locator('#projectVersionPick').inputValue(), '1.0.0', tab);
      assert.equal(await page.locator('#view').evaluate((el) => el.scrollWidth <= el.clientWidth + 1), true, tab);
      if (tab === 'design' || tab === 'board' || tab === 'flow') {
        await page.locator('#projectContent').getByText('Version task', { exact: true }).waitFor();
        assert.equal(await page.locator('#projectContent').getByText('Base task', { exact: true }).count(), 0, tab);
      }
      if (tab === 'refs') {
        await page.locator('#projectContent').getByText('version-note.md', { exact: true }).first().waitFor();
        assert.equal(await page.locator('#projectContent').getByText('base-note.md', { exact: true }).count(), 0);
      }
    }
    await page.locator('[data-pjtab=board]').click();
    await page.reload();
    await page.locator('[data-pjtab=board][aria-selected=true]').waitFor();
    assert.equal(await page.locator('#projectVersionPick').inputValue(), '1.0.0');
    await page.locator('#projectVersionPick').selectOption('');
    await page.locator('#projectContent').getByText('Base task', { exact: true }).waitFor();
    assert.equal(await page.locator('#projectContent').getByText('Version task', { exact: true }).count(), 0);
    await page.locator('#projectVersionPick').selectOption('1.0.0');
    await page.locator('#projectContent').getByText('Version task', { exact: true }).waitFor();
    await capture('mobile-version-board');
    const saved = projects.list()[0];
    projects.save({ ...saved, versions: [...saved.versions, { number: '2.0.0', goal: 'Next version plan' }],
      tasks: [...saved.tasks, { ...baseTask, id: 'next-task', title: 'Next version task', version: '2.0.0' }] });
    const other = projects.save({ name: 'Other project', cwd, goal: 'Separate project', termIds: [], tasks: [],
      versions: [{ number: '3.0.0', goal: 'Other version plan' }] });
    const versionTask = saved.tasks.find((task) => task.version === '1.0.0');
    projects.remember([
      { projectId: project.id, taskId: versionTask.id, sessionId: 'first-run', agent: 'codex', tokens: { total: 123 } },
      { projectId: project.id, taskId: 'next-task', sessionId: 'second-run', agent: 'agy', tokens: { total: 45 } },
    ]);
    await page.reload();
    await page.locator('#projectVersionPick').selectOption('2.0.0');
    await page.locator('#projectContent').getByText('Next version task', { exact: true }).waitFor();
    assert.equal(await page.locator('#projectTokens b').textContent(), '45');
    assert.equal(await page.locator('#projectContent').getByText('Version task', { exact: true }).count(), 0);
    await page.locator('#projectVersionPick').selectOption('1.0.0');
    await page.locator('#projectContent').getByText('Version task', { exact: true }).waitFor();
    assert.equal(await page.locator('#projectTokens b').textContent(), '123');
    await page.locator('#projectTokens').click();
    await page.getByText('Versions example · v1.0.0 · 누적 토큰', { exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await page.locator('#projectPick').selectOption(other.id);
    await page.locator('#projectPick').locator('option:checked').filter({ hasText: 'Other project' }).waitFor({ state: 'attached' });
    await page.locator('#projectVersionPick').selectOption('3.0.0');
    await page.waitForURL(/:board:3\.0\.0$/);
    await page.locator('#projectPick').selectOption(project.id);
    await page.locator('#projectContent').getByText('Version task', { exact: true }).waitFor();
    assert.equal(await page.locator('#projectVersionPick').inputValue(), '1.0.0');
    await page.locator('#projectPick').selectOption(other.id);
    await page.waitForURL(/:board:3\.0\.0$/);
    assert.equal(await page.locator('#projectVersionPick').inputValue(), '3.0.0');
    await page.locator('#projectPick').selectOption(project.id);
    await page.locator('#projectContent').getByText('Version task', { exact: true }).waitFor();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await capture('desktop-version-board');
    await page.request.post(fixture.url + '/api/projects/start', { data: { projectId: project.id, taskId: 'base-task' } });
    await page.request.post(fixture.url + '/api/projects/start', { data: { projectId: project.id, taskId: projects.list()[0].tasks[1].id } });
    await page.reload();
    await page.locator('[data-pjtab=terms]').click();
    await page.locator('#projectContent [data-term="4"]').waitFor();
    assert.deepEqual(await page.locator('#projectContent [data-term]').evaluateAll(cards => cards.map(c => c.dataset.term)), ['4']);
    await page.locator('#projectContent [data-term="4"]').click();
    await page.locator('#btnBackProject').click();
    await page.locator('[data-pjtab=terms][aria-selected=true]').waitFor();
    assert.equal(await page.locator('#projectVersionPick').inputValue(), '1.0.0');
    assert.deepEqual(errors, []);
    console.log('PASS: version save and restore, focus return, mobile controls, and project tab layout');
  } finally {
    await browser?.close();
    await fixture.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
