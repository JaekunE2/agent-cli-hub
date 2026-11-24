const assert = require('node:assert/strict');
const folder = 'C:\\테스트 경로';
const file = folder + '\\결과 문서.txt';

const dropFile = (locator, native) => locator.evaluate((input, { native, file }) => {
  if (native) {
    const rect = input.getBoundingClientRect(), scale = devicePixelRatio;
    window.dispatchEvent(new CustomEvent('hub-native-drop', {
      detail: { paths: [file], x: (rect.left + 5) * scale, y: (rect.top + 5) * scale },
    }));
  } else {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File(['test'], 'image.png', { type: 'image/png' }));
    input.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
  }
}, { native, file });

module.exports = async (page, url, native) => {
  page.setDefaultTimeout(10000);
  const errors = [], calls = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('request', (req) => calls.push(new URL(req.url()).pathname));
  await page.route('**/api/upload?*', (route) => route.fulfill({ json: { path: file } }));
  if (native) await page.addInitScript((folder) => {
    window.__TAURI_INTERNALS__ = { invoke: async (cmd, args) => {
      if (cmd !== 'pick_folder' || args.initialPath !== folder) throw Error('unexpected native call');
      return window.cancelFolder ? null : folder;
    } };
  }, folder);
  await page.goto(url);
  await page.evaluate((folder) => {
    window.chosen = '';
    openFolderPickerDialog(folder, (path) => { window.chosen = path; });
  }, folder);
  if (native) {
    await page.waitForFunction((folder) => window.chosen === folder, folder);
    await page.evaluate(async (folder) => {
      window.cancelFolder = true;
      await openFolderPickerDialog(folder, () => { window.chosen = 'unexpected'; });
    }, folder);
    assert.equal(await page.evaluate(() => window.chosen), folder);
    assert.ok(!calls.includes('/api/fs/dirs'));
  } else {
    await page.locator('#fpSelectBtn').click();
    assert.equal(await page.evaluate(() => window.chosen), folder);
    assert.ok(calls.includes('/api/fs/dirs'));
  }

  await page.evaluate(() => addArtifactDialog('fixture', () => {}));
  await dropFile(page.locator('#apPath'), native);
  await page.waitForFunction((file) => document.querySelector('#apPath').value === file, file);
  await page.locator('.drw-backdrop [data-drw-close]').last().click();

  await page.route('**/api/term/send', (route) => route.fulfill({ json: { ok: true } }));
  await page.goto(url + '/?test=chat#term:1:chat');
  const toggle = page.locator('#bar [data-dock-toggle=chat]');
  if (await toggle.getAttribute('aria-pressed') === 'false') await toggle.click();
  const reply = page.locator('.chat-reply-in textarea');
  await reply.fill('Test reply');
  await dropFile(reply, native);
  const strip = page.locator('[data-chat-atts]');
  await strip.getByTitle(file, { exact: true }).waitFor();
  const sent = page.waitForRequest((req) => new URL(req.url()).pathname === '/api/term/send');
  await reply.press('Enter');
  assert.equal((await sent).postDataJSON().text, `"${file}" Test reply`);
  assert.equal(calls.filter((path) => path === '/api/upload').length, native ? 0 : 2);
  assert.ok(!calls.includes('/api/fs/pick-dir'));
  assert.deepEqual(errors, []);
  await page.close();
};
