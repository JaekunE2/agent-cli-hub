'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.env.HUB_PLAYWRIGHT || 'playwright');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-handoff-browser-'));
  const file = path.join(dir, 'projects.json');
  const store = require('../projects')(file);
  const tasks = ['first', 'followup'].map((id, i) => ({
    id, title: id, detail: '', stage: i ? 'planned' : 'done', termId: '', after: i ? ['first'] : [],
  }));
  const { id: projectId } = store.save({ name: 'Handoff demo', cwd: dir, goal: '', autopilot: true, tasks, termIds: [] });
  const taskId = 'followup';
  const fixture = await require('./browser-fixture')(store, (url, _req, res) => {
    if (url.pathname !== '/api/overview') return false;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ terms: [], projectRevisions: { [projectId]: store.list()[0].revision } }));
    return true;
  });
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.goto(fixture.url + '/#projects');
    await page.getByRole('tab', { name: '칸반 보드' }).click();
    const card = page.locator('[data-task=followup]');
    const label = (phase) => '자동 진행 · ' + phase;
    await card.getByText(label('대기'), { exact: true }).waitFor();
    const project = store.list()[0];
    const termId = 'fixture-term';
    store.save({ ...project, tasks: project.tasks.map((task) => task.id === taskId ? { ...task, stage: 'doing' } : task) },
      { taskRun: { taskId, run: { termId, agent: 'codex', source: 'project' }, trackHandoff: true } });
    const at = Date.now();
    const advance = (phase) => assert.equal(store.advanceHandoff({ projectId, taskId }, termId, at, phase), true);
    advance('delivered');
    await card.getByText(label('전달'), { exact: true }).waitFor();
    await card.click();
    const drawer = page.locator('[data-handoff-task=followup]');
    const draft = page.locator('.drw-backdrop #subChatIn');
    await draft.fill('keep this draft');
    advance('confirmed');
    await drawer.getByText(label('실행 확인'), { exact: true }).waitFor();
    advance('received');
    await drawer.getByText(label('결과 수신'), { exact: true }).waitFor();
    assert.equal(await draft.inputValue(), 'keep this draft');
    await page.reload();
    await card.getByText(label('결과 수신'), { exact: true }).waitFor();
    console.log('PASS: handoff badge updates on the board and open drawer and persists after reload');
  } finally {
    await browser?.close();
    await fixture.close();
    fs.unlinkSync(file);
    fs.rmdirSync(dir);
  }
})().catch((err) => { console.error(err); process.exitCode = 1; });
