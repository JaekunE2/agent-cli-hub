const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const recover = require('../terminal-recovery');
const { createTermManager } = require('../term-manager');
const id = 'aaaaaaaa-bbbb-cccc-dddd-000000000001';

test('Codex recovery restores the conversation without sending a saved prompt', () => {
  assert.deepEqual(recover(['resume', id, '계속 진행해']), ['resume', id]);
  assert.deepEqual(recover(['/c', 'codex.cmd', '--no-daemon', 'resume', '--last', '계속 진행해'], id),
    ['/c', 'codex.cmd', '--no-daemon', 'resume', id]);
  assert.deepEqual(recover(['handoff prompt']), []);
  assert.deepEqual(recover(['resume', '--last', '계속 진행해']), ['resume', '--last']);
  assert.deepEqual(recover(['--dangerously-bypass-approvals-and-sandbox', 'resume', id, '계속 진행해']),
    ['--dangerously-bypass-approvals-and-sandbox', 'resume', id]);
});

test('Codex branches in the same folder keep separate terminal session IDs', () => {
  const start = Date.UTC(2026, 10, 23, 3, 41);
  const sid = (at) => {
    const hex = at.toString(16).padStart(12, '0');
    return `${hex.slice(0, 8)}-${hex.slice(8)}-7000-8000-000000000000`;
  };
  const parentId = sid(start + 5000);
  const childId = sid(start + 15000);
  const cwd = os.tmpdir();
  const docs = new Map([
    [childId, { id: childId, agent: 'codex', cwd, mtime: start + 30_000 }],
    [parentId, { id: parentId, agent: 'codex', cwd, mtime: start + 7000 }],
  ]);
  const manager = createTermManager({ baseDir: cwd, CA: { MAIN: cwd }, index: { docs, get: (id) => docs.get(id) } });
  const parent = { id: '12', cwd, meta: { cmd: 'codex.exe', spawnedAt: start } };
  const child = { id: '13', cwd, meta: { cmd: 'codex.exe', spawnedAt: start + 10_000 } };
  manager.terms.set(parent.id, parent);
  manager.terms.set(child.id, child);

  assert.equal(manager.termDocOf(parent).id, parentId);
  assert.equal(manager.termSessionId(parent), parentId);
  assert.equal(manager.termSessionId(child), childId);

  docs.get(parentId).mtime = start + 40_000;
  assert.equal(manager.termSessionId(child), childId);
  docs.delete(parentId);
  assert.equal(manager.termDocOf(parent), null);
  parent.meta.args = ['resume', parentId];
  assert.equal(manager.termSessionId(parent), parentId);
});
