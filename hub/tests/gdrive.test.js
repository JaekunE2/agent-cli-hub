'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDriveSync } = require('../gdrive');

test('createDriveSync uploads selected artifacts, updates existing fileId, and blocks sensitive files', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ach-gdrive-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const secretsDir = path.join(dir, 'data', 'secrets');
  fs.mkdirSync(secretsDir, { recursive: true });
  fs.writeFileSync(path.join(secretsDir, 'google-oauth-client.json'), JSON.stringify({
    installed: { client_id: 'cid', client_secret: 'csec' },
  }));
  fs.writeFileSync(path.join(secretsDir, 'gdrive-token.json'), JSON.stringify({
    refresh_token: 'rtok',
    access_token: 'atok',
    expires_at: Date.now() + 3600_000,
    account: 'user@example.com',
  }));

  const artifact = path.join(dir, 'report.md');
  fs.writeFileSync(artifact, '# Report\nhello world\n', 'utf8');
  const secretFile = path.join(dir, '.token');
  fs.writeFileSync(secretFile, 'secret-token', 'utf8');

  const calls = [];
  const prevFetch = global.fetch;
  global.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET' });
    if (String(url).includes('drive/v3/files?q=')) {
      return new Response(JSON.stringify({ files: [] }), { status: 200 });
    }
    if (String(url) === 'https://www.googleapis.com/drive/v3/files?fields=id,name') {
      return new Response(JSON.stringify({ id: `folder-${calls.length}`, name: 'Folder' }), { status: 200 });
    }
    if (String(url).includes('upload/drive/v3/files?uploadType=multipart')) {
      return new Response(JSON.stringify({ id: 'drv-file-1', name: 'report.md', webViewLink: 'https://drive.google.com/file/d/drv-file-1' }), { status: 200 });
    }
    if (String(url).includes('upload/drive/v3/files/drv-file-1?uploadType=multipart')) {
      return new Response(JSON.stringify({ id: 'drv-file-1', name: 'report.md', webViewLink: 'https://drive.google.com/file/d/drv-file-1' }), { status: 200 });
    }
    if (String(url).includes('drive/v3/files/folder-')) {
      return new Response(JSON.stringify({ id: 'folder-2', trashed: false }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: { message: 'unexpected url ' + url } }), { status: 404 });
  };
  t.after(() => { global.fetch = prevFetch; });

  const drive = createDriveSync({ baseDir: dir, port: 7777, config: {} });

  await assert.rejects(
    () => drive.uploadArtifact({ filePath: secretFile, folderName: 'proj' }),
    /민감 파일/,
  );

  const first = await drive.uploadArtifact({ filePath: artifact, folderName: 'proj' });
  assert.equal(first.ok, true);
  assert.equal(first.updated, false);
  assert.equal(first.fileId, 'drv-file-1');

  const second = await drive.uploadArtifact({ filePath: artifact, folderName: 'proj' });
  assert.equal(second.ok, true);
  assert.equal(second.updated, true);
  assert.equal(second.fileId, 'drv-file-1');
  assert.ok(calls.some((c) => c.method === 'PATCH' && c.url.includes('/drv-file-1')));
});
