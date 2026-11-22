const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SearchIndex } = require('../searchindex');
test('discovers all AGY roots without Claude installed and parses spaced or late type fields', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-agy-test-'));
  try {
    const roots = ['antigravity', 'antigravity-cli', 'antigravity-ide'].map(n => path.join(dir, n, 'brain'));
    roots.forEach((root, i) => {
      const f = path.join(root, `aaaaaaaa-bbbb-cccc-dddd-00000000000${i}`, '.system_generated', 'logs', 'transcript.jsonl');
      fs.mkdirSync(path.dirname(f), { recursive: true });
      const user = { prefix: 'x'.repeat(400), type: 'USER_INPUT', content: '<USER_REQUEST>test request</USER_REQUEST>', created_at: '2026-11-22T00:00:00Z' };
      fs.writeFileSync(f, JSON.stringify(user, null, 0).replace('"type":', '"type" : ') + '\n' + JSON.stringify({ type: 'PLANNER_RESPONSE', content: 'test response' }) + '\n');
    });
    const index = new SearchIndex(path.join(dir, 'missing-claude'), null, roots);
    index.docs.clear();
    const files = await index.listFilesAsync();
    assert.equal(files.length, 3);
    for (const f of files) await index.updateFile(f);
    assert.equal(index.recent(100, false, 'agy').length, 3);
    for (const doc of index.docs.values()) {
      assert.equal(doc.agent, 'agy');
      assert.deepEqual(doc.msgs.map(m => m.text), ['test request', 'test response']);
      await index.updateFile(doc.file);
      assert.equal(doc.msgs.length, 2);
    }
    assert.equal(index.recent(100, false, 'codex').length, 0);
  } finally { fs.rmSync(dir, { recursive: true }); }
});
