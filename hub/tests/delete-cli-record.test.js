const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os');
const { deleteCliRecord } = require('../delete-cli-record');
const id = 'aaaaaaaa-bbbb-cccc-dddd-000000000001', other = 'aaaaaaaa-bbbb-cccc-dddd-000000000002';

async function temp(fn) {
  const parent = fs.realpathSync(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(parent, 'hub-record-delete-'));
  try { await fn(dir); }
  finally {
    assert.equal(path.dirname(fs.realpathSync(dir)), parent);
    fs.rmSync(dir, { recursive: true });
  }
}

test('AGY project deletion removes the selected transcript, database and index entries', async () => temp(async dir => {
  const { DatabaseSync } = require('node:sqlite');
  const root = path.join(dir, 'brain');
  const logs = path.join(root, id, '.system_generated', 'logs');
  fs.mkdirSync(logs, { recursive: true });
  fs.mkdirSync(path.join(dir, 'conversations'));
  const transcript = path.join(logs, 'transcript.jsonl');
  const result = path.join(root, id, 'result.md');
  const record = path.join(dir, 'conversations', id + '.db');
  const unrelated = path.join(dir, 'conversations', other + '.db');
  for (const f of [transcript, result, record, unrelated]) fs.writeFileSync(f, 'fixture');
  const index = path.join(dir, 'conversation_summaries.db');
  const db = new DatabaseSync(index);
  db.exec('CREATE TABLE conversation_summaries (conversation_id TEXT); CREATE VIRTUAL TABLE conversations_fts USING fts5(conversation_id, text);');
  for (const value of [id, other]) {
    db.prepare('INSERT INTO conversation_summaries VALUES (?)').run(value);
    db.prepare("INSERT INTO conversations_fts VALUES (?, 'test')").run(value);
  }
  db.close();
  await deleteCliRecord({ agent: 'agy', id }, { agyRoots: [root] });
  assert.equal(fs.existsSync(transcript), false);
  assert.equal(fs.existsSync(record), false);
  assert.equal(fs.existsSync(result), true);
  assert.equal(fs.existsSync(unrelated), true);
  const check = new DatabaseSync(index, { readOnly: true });
  try {
    for (const table of ['conversation_summaries', 'conversations_fts']) {
      assert.deepEqual(check.prepare(`SELECT conversation_id FROM ${table}`).all().map(r => r.conversation_id), [other]);
    }
  } finally { check.close(); }
}));

test('Claude deletion is scoped to the conversation file, and Codex uses its UUID delete command', async () => temp(async dir => {
  const root = path.join(dir, 'projects');
  fs.mkdirSync(root);
  const outside = path.join(dir, id + '.jsonl'), inside = path.join(root, id + '.jsonl');
  fs.writeFileSync(outside, 'outside');
  fs.writeFileSync(inside, 'inside');
  await assert.rejects(deleteCliRecord({ agent: 'claude', id, file: outside }, { claudeRoot: root }));
  await deleteCliRecord({ agent: 'claude', id, file: inside }, { claudeRoot: root });
  assert.equal(fs.existsSync(inside), false);
  assert.equal(fs.existsSync(outside), true);
  let command;
  await deleteCliRecord({ agent: 'codex', id }, { codexExe: 'codex.exe', run: async (...args) => { command = args; } });
  assert.deepEqual(command.slice(0, 2), ['codex.exe', ['delete', '--force', id]]);
}));
