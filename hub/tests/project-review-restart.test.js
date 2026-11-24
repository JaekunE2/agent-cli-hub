'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');
const { completeAutopilotTask } = require('../project-autopilot');

for (const phase of ['before-dispatch', 'after-dispatch', 'before-card-save']) {
  test(`recovers review ${phase} with one submission and one session`, async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-review-restart-'));
    const fixture = path.join(__dirname, 'project-review-restart-fixture.js');
    const start = (step) => promisify(execFile)(process.execPath, [fixture, baseDir, step], { timeout: 12000 });
    const projects = require('../projects')(path.join(baseDir, 'projects.json'));
    const submissions = path.join(baseDir, 'submissions');
    const release = path.join(baseDir, 'release');
    try {
      if (phase === 'before-card-save') fs.writeFileSync(release, '');
      await assert.rejects(start(phase), { code: 73 });
      assert.equal(fs.existsSync(submissions), phase !== 'before-dispatch');
      const [pending] = projects.list();
      assert.equal(pending.tasks[0].reviewStatus, 'reviewing');
      await Promise.all([start('resume'), (async () => {
        try {
          if (phase === 'after-dispatch') {
            await delay(550);
            assert.equal(fs.readFileSync(submissions, 'utf8'), '1\n');
          }
        } finally { fs.writeFileSync(release, ''); }
      })()]);
      const [finished] = projects.list();
      assert.equal(finished.tasks[0].stage, 'done');
      assert.equal(finished.tasks[0].reviewNote, 'fixture result');
      assert.equal(fs.readFileSync(submissions, 'utf8'), '1\n');
      assert.equal(projects.records(finished.id).length, 1);
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });
}

test('a recovered approval cannot complete a card whose working folder changed', async (t) => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-review-moved-'));
  t.after(() => fs.rmSync(baseDir, { recursive: true, force: true }));
  const fixture = path.join(__dirname, 'project-review-restart-fixture.js');
  const start = (phase) => promisify(execFile)(process.execPath, [fixture, baseDir, phase], { timeout: 12000 });
  fs.writeFileSync(path.join(baseDir, 'release'), '');
  await assert.rejects(start('before-card-save'), { code: 73 });
  const projects = require('../projects')(path.join(baseDir, 'projects.json'));
  const [project] = projects.list();
  const cwd = fs.mkdirSync(path.join(baseDir, 'moved'), { recursive: true });
  projects.save({ ...project, cwd });
  await start('resume-uncertain');
  const [task] = projects.list()[0].tasks;
  assert.equal(task.reviewPaused, true);
  assert.match(task.reviewNote, /검토 중 작업 폴더가 변경/);
  assert.equal(fs.readFileSync(path.join(baseDir, 'submissions'), 'utf8'), '1\n');
});

test('a claim without a live worker or result pauses the review without a second submission', async (t) => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-review-uncertain-'));
  t.after(() => fs.rmSync(baseDir, { recursive: true, force: true }));
  const start = (phase) => promisify(execFile)(process.execPath, [path.join(__dirname, 'project-review-restart-fixture.js'), baseDir, phase]);
  const stopped = start('before-dispatch');
  await assert.rejects(stopped, { code: 73 });
  const projects = require('../projects')(path.join(baseDir, 'projects.json'));
  const run = projects.list()[0].tasks[0].reviewRun;
  const dir = path.join(baseDir, 'data', 'review-runs', run.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'claim.json'), JSON.stringify({ pid: stopped.child.pid }));
  await start('resume-uncertain');
  const task = projects.list()[0].tasks[0];
  assert.equal(task.reviewPaused, true);
  assert.match(task.reviewNote, /제출 여부를 확인할 수 없습니다/);
  assert.equal(fs.existsSync(path.join(baseDir, 'submissions')), false);
});

test('independent worktrees overlap and a junction to the same worktree waits', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-review-folders-'));
  const a = fs.mkdirSync(path.join(cwd, '.hub-worktrees', 'a'), { recursive: true });
  const b = fs.mkdirSync(path.join(cwd, '.hub-worktrees', 'b'), { recursive: true });
  const alias = path.join(cwd, 'alias');
  fs.symlinkSync(a, alias, 'junction');
  let project = { id: 'folders', cwd, autopilot: true, tasks: [a, alias, b].map((worktreePath, index) =>
    ({ id: String(index), title: String(index), stage: 'doing', worktreePath })) };
  const started = [];
  const gate = Promise.withResolvers();
  const bothStarted = Promise.withResolvers();
  const hub = {
    projects: { list: () => [project], save: (next) => { project = next; } },
    reviewTask: async (_project, task) => {
      started.push(task.id);
      if (started.length === 2) bothStarted.resolve();
      await gate.promise;
      return { verdict: 'REJECT' };
    },
  };
  const reviews = project.tasks.map(({ id }) => completeAutopilotTask(hub, project.id, id, { maxRetries: 0 }));
  try {
    await Promise.race([bothStarted.promise, delay(1500, null, { ref: false })]);
    assert.deepEqual(started, ['0', '2']);
  } finally {
    gate.resolve();
    await Promise.all(reviews);
    fs.rmSync(cwd, { recursive: true, force: true });
  }
  assert.deepEqual(started, ['0', '2', '1']);
});
