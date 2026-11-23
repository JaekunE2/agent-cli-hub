const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAccountPrefsStore } = require('../account-prefs');

test('accountPrefs persists distinct model & effort per account across server restarts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ach-prefs-'));
  const file = path.join(dir, 'account-prefs.json');

  try {
    const s1 = createAccountPrefsStore({ file });
    s1.save({ account: 'default', agent: 'claude', model: 'opus', effort: 'max' });
    s1.save({ account: 'cl-work', agent: 'claude', model: 'sonnet', effort: 'low' });
    s1.save({ account: 'cx-main', agent: 'codex', model: 'gpt-5.4', effort: 'xhigh' });
    s1.save({ account: 'agyswap:alpha@gmail.com', agent: 'agy', model: 'gemini-3-pro', effort: 'high' });

    // Simulate full Hub server restart by creating a new store instance reading the same file
    const s2 = createAccountPrefsStore({ file });
    assert.deepEqual(s2.getForAccount('default', 'claude'), { model: 'opus', effort: 'max' });
    assert.deepEqual(s2.getForAccount('cl-work', 'claude'), { model: 'sonnet', effort: 'low' });
    assert.deepEqual(s2.getForAccount('cx-main', 'codex'), { model: 'gpt-5.4', effort: 'xhigh' });
    assert.deepEqual(s2.getForAccount('agyswap:alpha@gmail.com', 'agy'), { model: 'gemini-3-pro', effort: 'high' });
    assert.equal(s2.get().byCli.claude.account, 'cl-work');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
