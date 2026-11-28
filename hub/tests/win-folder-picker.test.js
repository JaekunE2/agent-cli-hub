'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  resolveInitialDir,
  buildPickDirPowerShellScript,
  parsePickDirOutput,
  pickDirectory,
} = require('../win-folder-picker');

test('resolveInitialDir walks up non-existent leaf paths and falls back cleanly', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ach-pick-'));
  try {
    const existing = path.join(tmpRoot, 'existing');
    fs.mkdirSync(existing, { recursive: true });
    assert.equal(resolveInitialDir(existing, tmpRoot), existing);
    assert.equal(resolveInitialDir(path.join(existing, 'missing', 'nested'), tmpRoot), existing);
    assert.equal(resolveInitialDir('relative/path', existing), existing);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('parsePickDirOutput extracts PICKED path and CANCELLED marker', () => {
  assert.deepEqual(
    parsePickDirOutput('Module warning line\nPICKED:D:\\Gitsource\\개인\\agent-cli-hub\r\n'),
    { ok: true, cancelled: false, path: 'D:\\Gitsource\\개인\\agent-cli-hub' }
  );
  assert.deepEqual(
    parsePickDirOutput('CANCELLED\r\n'),
    { ok: false, cancelled: true, path: null }
  );
  assert.deepEqual(
    parsePickDirOutput(''),
    { ok: false, cancelled: false, path: null }
  );
});

test('buildPickDirPowerShellScript uses IFileOpenDialog with env-passed paths and TopMost owner', () => {
  const ps = buildPickDirPowerShellScript();
  assert.match(ps, /IFileOpenDialog/);
  assert.match(ps, /CreateTopMostOwner/);
  assert.match(ps, /\$env:ACH_PICK_INIT/);
  assert.match(ps, /\$env:ACH_PICK_TITLE/);
});

test('pickDirectory launches modern IFileOpenDialog cleanly on Windows', { skip: process.platform !== 'win32' }, async () => {
  const root = path.resolve(__dirname, '..', '..');
  const res = await pickDirectory({
    initialPath: path.join(root, 'projects', 'non-existent-sub'),
    fallbackDir: root,
    timeoutMs: 15_000,
    testAutoCloseMs: 500,
  });
  assert.equal(res.error, undefined);
  assert.equal(res.ok, false);
  assert.equal(res.cancelled, true);
});
