const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async function checkOutputs(page, { url, cwd, project, emptyProject }) {
  const sid = 'aaaaaaaa-bbbb-cccc-dddd-000000000001';
  const reportRoute = url + '/api/projects/floorplan/report';
  const artifactRoute = url + '/api/artifacts';
  const list = artifactRoute + '?' + new URLSearchParams({ session: sid });
  const reportPath = path.join(cwd, 'FLOORPLAN.md');
  const fileUrl = (file, session = sid) => url + '/api/artifact-file?' + new URLSearchParams({ session, path: file });
  let navigation = 0;
  const visit = hash => page.goto(url + '/?fixture=' + ++navigation + hash);
  const floorplan = p => '#projects:' + p.id + ':floorplan';
  const openEmpty = () => page.getByText('아직 등록된 산출물이 없습니다', { exact: true }).waitFor();
  const filesPage = '#recent:' + sid + ':files';
  await visit(filesPage);
  await openEmpty();

  await visit(floorplan(project));
  const row = page.getByRole('button', { name: /helper\.js/ }).and(page.locator('.m-row'));
  for (const key of ['Enter', 'Space']) {
    await row.focus();
    assert.equal(await row.evaluate(el => el === document.activeElement), true);
    await page.keyboard.press(key);
    await page.getByRole('dialog', { name: /helper\.js/ }).waitFor();
    await page.keyboard.press('Escape');
  }
  await page.reload();
  await row.waitFor();
  await page.locator('#fmPreviewMd').click();
  const saveButton = page.locator('#drwSaveMd');
  fs.mkdirSync(reportPath);
  try {
    const failed = page.waitForResponse(r => r.url() === reportRoute);
    await saveButton.click();
    const failure = await failed;
    assert.equal(failure.status(), 500);
    await page.getByText((await failure.json()).error, { exact: true }).first().waitFor();
    assert.equal(await saveButton.isEnabled(), true);
    assert.deepEqual((await (await page.request.get(list)).json()).items, []);
  } finally { fs.rmdirSync(reportPath); }
  const saved = page.waitForResponse(r => r.url() === reportRoute);
  await saveButton.click();
  const response = await saved;
  assert.equal(response.status(), 200);
  assert.deepEqual(await response.json(), { ok: true, path: reportPath, fileName: 'FLOORPLAN.md', pinned: false });
  const content = fs.readFileSync(reportPath, 'utf8');
  assert.match(content, /helper\.js/);
  assert.equal((await page.request.post(reportRoute, { data: { cwd, content: '' } })).status(), 400);
  assert.equal(fs.readFileSync(reportPath, 'utf8'), content);
  const pinned = await page.request.post(reportRoute, { data: { cwd, content, sessionId: sid } });
  assert.equal(pinned.status(), 200);
  assert.equal((await pinned.json()).pinned, true);
  const listed = await page.request.get(list);
  assert.equal(listed.status(), 200);
  assert.equal((await listed.json()).items[0].source, 'pinned');
  assert.equal((await page.request.get(fileUrl(path.join(cwd, 'helper.js')))).status(), 403);
  assert.equal((await page.request.get(fileUrl(reportPath, 'other-session'))).status(), 403);
  const bytes = await page.request.get(fileUrl(reportPath));
  assert.equal(bytes.status(), 200);
  assert.equal(await bytes.text(), content);
  assert.equal((await page.request.head(fileUrl(reportPath))).status(), 200);

  await visit(filesPage);
  await page.reload();
  const file = page.getByRole('button', { name: '코드 아키텍처 보고서 (FLOORPLAN.md)' });
  await file.focus();
  await page.keyboard.press('Enter');
  const preview = page.getByRole('dialog', { name: '코드 아키텍처 보고서 (FLOORPLAN.md)' });
  await preview.locator('#avBody .md').waitFor();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'avClose');
  for (const key of ['Shift+Tab', 'Tab', 'Tab', 'Shift+Tab']) {
    await page.keyboard.press(key);
    assert.equal(await preview.evaluate(el => el.contains(document.activeElement)), true);
  }
  await page.keyboard.press('Escape');
  await preview.waitFor({ state: 'detached' });
  assert.equal(await file.evaluate(el => el === document.activeElement), true);
  fs.unlinkSync(reportPath);
  await file.press('Enter');
  await preview.getByRole('alert').filter({ hasText: /HTTP (403|404)/ }).waitFor();
  await preview.locator('#avClose').click();
  const hidden = await page.request.post(artifactRoute + '/hide', { data: { session: sid, path: reportPath } });
  assert.equal(hidden.status(), 200);
  await page.reload();
  await openEmpty();
  assert.equal((await page.request.get(fileUrl(reportPath))).status(), 403);
  await visit(floorplan(emptyProject));
  await page.locator('#fmPickDir').waitFor();
  assert.equal(await page.locator('#fmSaveArtifact').count(), 0);
};
