const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../projects');
const { validate } = require('../project-validation');
const task = (id, after = []) => ({ id, title: id, detail: '', stage: 'planned', termId: '1', after });
const project = () => ({ name: '테스트', cwd: 'D:\\project', goal: '완료 기준', termIds: ['1', '2'], tasks: [task('a'), task('b', ['a'])] });
test('project persists tasks, dependencies and terminal membership; stale writes fail', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-project-test-'));
  try {
    const file = path.join(dir, 'projects.json'), s = store(file);
    const p = s.save(project());
    assert.equal(p.revision, 1);
    assert.deepEqual(store(file).list(), [p]);
    const next = s.save({ ...p, tasks: p.tasks.map(t => ({ ...t, stage: 'doing' })) });
    assert.equal(next.revision, 2);
    assert.throws(() => s.save(p), /다른 화면/);
    assert.equal(s.list()[0].tasks[1].stage, 'doing');
    fs.writeFileSync(file, 'broken');
    assert.throws(() => s.save(project()));
    assert.equal(fs.readFileSync(file, 'utf8'), 'broken');
  } finally { fs.rmSync(dir, { recursive: true }); }
});
test('rejects cycles, duplicate tasks, unlinked terminals and oversized values', () => {
  const p = project();
  assert.throws(() => validate({ ...p, tasks: [task('a', ['b']), task('b', ['a'])] }));
  assert.throws(() => validate({ ...p, tasks: [task('a', ['missing'])] }));
  assert.equal(validate({ ...p, tasks: [task('a', ['b']), task('b')] }).tasks[0].after[0], 'b');
  assert.throws(() => validate({ ...p, tasks: [task('a'), task('a')] }));
  assert.throws(() => validate({ ...p, termIds: [] }));
  assert.throws(() => validate({ ...p, goal: 'x'.repeat(6001) }));
  assert.throws(() => validate({ ...p, tasks: [{ ...task('a'), stage: 'bad' }] }));
  assert.equal(validate(p).tasks[1].after[0], 'a');
});
