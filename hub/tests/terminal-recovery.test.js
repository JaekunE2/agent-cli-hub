const { test } = require('node:test');
const assert = require('node:assert/strict');
const recover = require('../terminal-recovery');
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
