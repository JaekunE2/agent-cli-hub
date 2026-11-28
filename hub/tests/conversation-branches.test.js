'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  claudeMessageLineIndices,
  forkClaudeJsonlAt,
  forkCodexJsonlAt,
  editClaudeJsonlAt,
  editCodexJsonlAt,
  writeBranchContextFile,
  createBranchStore,
} = require('../conversation-branches');

function writeTempClaudeJsonl(dir, sid, turns) {
  const file = path.join(dir, `${sid}.jsonl`);
  const lines = [
    JSON.stringify({ type: 'queue-operation', sessionId: sid }),
    ...turns.map((t, i) => JSON.stringify({
      type: t.role,
      uuid: `u-${i}`,
      parentUuid: i === 0 ? null : `u-${i - 1}`,
      sessionId: sid,
      cwd: dir,
      timestamp: `2026-11-22T10:0${i}:00.000Z`,
      message: { role: t.role, content: t.content },
    })),
  ];
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  return file;
}

test('forkClaudeJsonlAt cuts at inclusive or exclusive message index and rewrites sessionId', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ach-fork-'));
  try {
    const srcId = '11111111-1111-4111-8111-111111111111';
    const file = writeTempClaudeJsonl(dir, srcId, [
      { role: 'user', content: 'First question' },
      { role: 'assistant', content: [{ type: 'text', text: 'First answer' }] },
      { role: 'user', content: 'Second question' },
      { role: 'assistant', content: [{ type: 'text', text: 'Second answer' }] },
    ]);

    // Inclusive fork at index 1 (First answer)
    const forked = forkClaudeJsonlAt({ sourceFile: file, cutIndex: 1, inclusive: true, title: 'Branch 1' });
    assert.equal(forked.messageCount, 2);
    const outLines = fs.readFileSync(forked.file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(outLines.filter((x) => x.type === 'user' || x.type === 'assistant').length, 2);
    assert.ok(outLines.every((x) => x.sessionId === forked.newSessionId));
    assert.equal(outLines[outLines.length - 1].type, 'custom-title');
    assert.equal(outLines[outLines.length - 1].customTitle, 'Branch 1');

    // Exclusive fork before index 2 (Second question) keeps turns 0 and 1
    const preEdit = forkClaudeJsonlAt({ sourceFile: file, cutIndex: 2, inclusive: false });
    assert.equal(preEdit.messageCount, 2);
    const preLines = fs.readFileSync(preEdit.file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(preLines.filter((x) => x.type === 'user' || x.type === 'assistant').length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('editClaudeJsonlAt supports in-place save with backup and rewind truncation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ach-edit-'));
  const backupDir = path.join(dir, 'backups');
  try {
    const sid = '22222222-2222-4222-8222-222222222222';
    const file = writeTempClaudeJsonl(dir, sid, [
      { role: 'user', content: [{ type: 'text', text: 'Original prompt' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Reply 1' }] },
      { role: 'user', content: 'Follow up' },
    ]);

    editClaudeJsonlAt({ sourceFile: file, sessionId: sid, atIndex: 0, newText: 'Edited prompt', mode: 'save', backupDir });
    assert.equal(fs.readdirSync(backupDir).length, 1);
    const afterSave = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(afterSave[1].message.content[0].text, 'Edited prompt');

    editClaudeJsonlAt({ sourceFile: file, sessionId: sid, atIndex: 2, newText: 'New follow up', mode: 'rewind', backupDir });
    const afterRewind = fs.readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(claudeMessageLineIndices(afterRewind).length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('editCodexJsonlAt updates message payload cleanly with backup', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ach-cx-edit-'));
  const backupDir = path.join(dir, 'backups');
  try {
    const sid = '33333333-3333-4333-8333-333333333333';
    const file = path.join(dir, `rollout-2026-11-22T10-00-00-${sid}.jsonl`);
    const rows = [
      { type: 'session_meta', payload: { id: sid, cwd: dir } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Old codex ask' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Codex answer' }] } },
    ];
    fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

    editCodexJsonlAt({ sourceFile: file, sessionId: sid, atIndex: 0, newText: 'Updated codex ask', backupDir });
    assert.equal(fs.readdirSync(backupDir).length, 1);
    const updated = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(updated[1].payload.content[0].text, 'Updated codex ask');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('forkCodexJsonlAt slices rollout natively, rewrites session_meta, and registers sqlite/index', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ach-cx-fork-'));
  try {
    const codexHome = path.join(dir, '.codex');
    const sessDir = path.join(codexHome, 'sessions', '2026', '11', '27');
    fs.mkdirSync(sessDir, { recursive: true });
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(codexHome, 'state_5.sqlite'));
    db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT, title TEXT, history_mode TEXT)');
    db.close();

    const srcId = '44444444-4444-7444-8444-444444444444';
    const srcFile = path.join(sessDir, `rollout-2026-11-27T10-00-00-${srcId}.jsonl`);
    const rows = [
      { timestamp: '2026-11-27T01:00:00Z', type: 'session_meta', payload: { id: srcId, session_id: srcId, cwd: dir, history_mode: 'paginated', history_base: { thread_id: 'old' } } },
      { timestamp: '2026-11-27T01:00:01Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'First codex prompt' }] } },
      { timestamp: '2026-11-27T01:00:02Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'First codex reply' }] } },
      { timestamp: '2026-11-27T01:00:03Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Second codex prompt' }] } },
    ];
    fs.writeFileSync(srcFile, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

    const forked = forkCodexJsonlAt({ sourceFile: srcFile, codexHome, cutIndex: 1, inclusive: true, cwd: dir, title: '(분기) Codex Test' });
    assert.equal(forked.messageCount, 2);
    assert.ok(fs.existsSync(forked.file));
    const out = fs.readFileSync(forked.file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(out.length, 3);
    assert.equal(out[0].payload.id, forked.newSessionId);
    assert.equal(out[0].payload.session_id, forked.newSessionId);
    assert.equal(out[0].payload.forked_from_id, srcId);
    assert.equal(out[0].payload.history_mode, 'legacy');
    assert.equal('history_base' in out[0].payload, false);

    const check = new DatabaseSync(path.join(codexHome, 'state_5.sqlite'), { readOnly: true });
    try {
      const row = check.prepare('SELECT id, rollout_path, title, history_mode FROM threads WHERE id = ?').get(forked.newSessionId);
      assert.equal(row.id, forked.newSessionId);
      assert.equal(row.rollout_path, forked.file);
      assert.equal(row.title, '(분기) Codex Test');
      assert.equal(row.history_mode, 'legacy');
    } finally { check.close(); }

    const idx = fs.readFileSync(path.join(codexHome, 'session_index.jsonl'), 'utf8');
    assert.ok(idx.includes(forked.newSessionId));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeBranchContextFile writes bounded handoff markdown and createBranchStore resolves lineage', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ach-br-'));
  try {
    const uploads = path.join(dir, 'uploads');
    const { file, instruction } = writeBranchContextFile({
      uploadsDir: uploads,
      sourceSessionId: 'parent-sid-1234',
      sourceTitle: 'Fix login flow',
      sourceAgent: 'agy',
      targetAgent: 'codex',
      cwd: dir,
      messages: [
        { role: 'user', text: 'Inspect auth bug' },
        { role: 'assistant', text: '⚙ read_file: auth.js' },
        { role: 'assistant', text: 'Found token expiry issue' },
      ],
      atIndex: 2,
      inclusive: true,
      followUp: 'Patch refresh handler',
    });
    assert.ok(fs.existsSync(file));
    const md = fs.readFileSync(file, 'utf8');
    assert.match(md, /Inspect auth bug/);
    assert.match(md, /Found token expiry issue/);
    assert.match(md, /Patch refresh handler/);
    assert.doesNotMatch(md, /⚙ read_file/);
    assert.ok(instruction.includes(file));

    const store = createBranchStore(path.join(dir, 'branches.json'));
    store.setTitle('parent-sid-1234', 'Renamed Parent');
    assert.equal(store.getTitle('parent-sid-1234'), 'Renamed Parent');
    store.setMsgEdit('parent-sid-1234', 0, 'Edited via overlay');
    assert.equal(store.getMsgEdits('parent-sid-1234')['0'].text, 'Edited via overlay');

    store.addBranch({
      parentSessionId: 'parent-sid-1234',
      childSessionId: null,
      termId: '9',
      atIndex: 2,
      branchTitle: '(분기) Branch Child',
      editedText: 'Try alternative approach',
    });
    const fakeTerms = new Map([['9', { id: '9' }]]);
    store.resolveLinks(fakeTerms, () => 'child-sid-5678');
    assert.equal(store.getTitle('child-sid-5678'), '(분기) Branch Child');

    const parentLin = store.lineageFor('parent-sid-1234', (id) => (id === 'child-sid-5678' ? 'Branch Child' : null));
    assert.equal(parentLin.children.length, 1);
    assert.equal(parentLin.children[0].childSessionId, 'child-sid-5678');
    assert.equal(parentLin.children[0].childTitle, 'Branch Child');

    const childLin = store.lineageFor('child-sid-5678', (id) => store.getTitle(id));
    assert.equal(childLin.parent.parentSessionId, 'parent-sid-1234');
    assert.equal(childLin.parent.parentTitle, 'Renamed Parent');

    const parentMeta = store.branchMetaFor({ sessionId: 'parent-sid-1234', lookupTitleFn: (id) => store.getTitle(id) });
    assert.equal(parentMeta.isBranch, false);
    assert.equal(parentMeta.childCount, 1);

    const childMeta = store.branchMetaFor({ sessionId: 'child-sid-5678', lookupTitleFn: (id) => store.getTitle(id) });
    assert.equal(childMeta.isBranch, true);
    assert.equal(childMeta.parentSessionId, 'parent-sid-1234');
    assert.equal(childMeta.parentTitle, 'Renamed Parent');
    assert.equal(childMeta.atIndex, 2);

    // Unlinked live terminal should still resolve branch metadata by termId before sessionId exists
    store.addBranch({
      parentSessionId: 'parent-sid-1234',
      childSessionId: null,
      termId: '12',
      atIndex: 1,
      branchTitle: '(분기) Pending AGY',
    });
    const pendingTermMeta = store.branchMetaFor({ termId: '12', lookupTitleFn: (id) => store.getTitle(id) });
    assert.equal(pendingTermMeta.isBranch, true);
    assert.equal(pendingTermMeta.parentSessionId, 'parent-sid-1234');
    assert.equal(pendingTermMeta.branchTitle, '(분기) Pending AGY');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
