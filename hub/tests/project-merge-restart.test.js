'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');
const { promisify } = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');
const { ensureTaskWorktree } = require('../project-autopilot');

test('a server restart reattaches the in-progress conflict retry and publishes exactly once', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-merge-restart-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cwd = path.join(dir, 'repo');
  fs.mkdirSync(cwd);
  const git = (where, ...args) => execFileSync('git', args, { cwd: where, encoding: 'utf8' }).trim();
  git(cwd, 'init', '-q');
  git(cwd, 'config', 'user.email', 'test@example.com');
  git(cwd, 'config', 'user.name', 'Test');
  const write = (where, text) => fs.writeFileSync(path.join(where, 'shared.txt'), `${text}\n`);
  write(cwd, 'base');
  git(cwd, 'add', 'shared.txt');
  git(cwd, 'commit', '-qm', 'base');
  const worktreePath = await ensureTaskWorktree(cwd, 'conflict');
  write(worktreePath, 'task');
  git(worktreePath, 'commit', '-qam', 'task');
  write(cwd, 'target');
  git(cwd, 'commit', '-qam', 'target');
  const before = git(cwd, 'rev-parse', 'HEAD');
  const projects = require('../projects')(path.join(dir, 'projects.json'));
  projects.save({ name: 'Restart', goal: '', cwd, autopilot: true, termIds: [], tasks: [{ id: 'conflict', title: 'Conflict', detail: '',
    stage: 'review', reviewStatus: 'merge-pending', termId: '', after: [], worktreePath, mergeCommit: git(worktreePath, 'rev-parse', 'HEAD') }] });
  const start = (phase) => promisify(execFile)(process.execPath, [path.join(__dirname, 'project-merge-restart-fixture.js'), dir, phase], { timeout: 20000 });
  const submissions = path.join(dir, 'submissions');
  try {
    await assert.rejects(start('interrupt'), { code: 73 });
    const [{ mergeRun, reviewStatus }] = projects.list()[0].tasks;
    assert.equal(reviewStatus, 'merge-integrating');
    assert.equal(mergeRun.attempt, 1);
    assert.equal(mergeRun.failures, 1);
    assert.match(mergeRun.diagnostics[0].reason, /leftover conflict marker/);
    assert.equal(git(cwd, 'rev-parse', 'HEAD'), before);
    await Promise.all([assert.rejects(start('before-card-save'), { code: 73 }), (async () => {
      await delay(500);
      fs.writeFileSync(path.join(dir, 'release'), '');
    })()]);
    assert.equal(projects.list()[0].tasks[0].stage, 'merge');
    const published = git(cwd, 'rev-parse', 'HEAD');
    assert.notEqual(published, before);
    await start('resume');
    assert.equal(git(cwd, 'rev-parse', 'HEAD'), published);
    const [done] = projects.list()[0].tasks;
    assert.equal(done.reviewStatus, 'approved');
    assert.equal(done.mergeRun.id, mergeRun.id);
    assert.equal(done.mergeRun.failures, 1);
    assert.equal(fs.readFileSync(submissions, 'utf8'), '1\n1\n');
    assert.equal(git(cwd, 'rev-list', '--count', '--first-parent', `${before}..HEAD`), '1');
    assert.equal(git(cwd, 'show', 'HEAD:shared.txt'), 'both');
    assert.doesNotMatch(git(cwd, 'worktree', 'list'), /integrate-/);
  } finally {
    fs.writeFileSync(path.join(dir, 'release'), '');
  }
});

test('integrateBatch blocks target-branch collisions without moving local changes into a stash', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-merge-stash-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cwd = path.join(dir, 'repo');
  fs.mkdirSync(cwd);
  const gitSync = (where, ...args) => execFileSync('git', args, { cwd: where, encoding: 'utf8' }).trim();
  const gitAsync = async (where, args) => {
    try {
      const { stdout, stderr } = await promisify(execFile)('git', args, { cwd: where, encoding: 'utf8' });
      return { ok: true, stdout, stderr };
    } catch (e) {
      return { ok: false, stdout: e.stdout || '', stderr: e.stderr || e.message || '' };
    }
  };
  gitSync(cwd, 'init', '-q');
  gitSync(cwd, 'config', 'user.email', 'test@example.com');
  gitSync(cwd, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(cwd, 'app.js'), 'base\n');
  gitSync(cwd, 'add', 'app.js');
  gitSync(cwd, 'commit', '-qm', 'base');
  const base = gitSync(cwd, 'rev-parse', 'HEAD');

  const wt = await ensureTaskWorktree(cwd, 'feat-a');
  fs.writeFileSync(path.join(wt, 'app.js'), 'base\nfeature-a\n');
  fs.writeFileSync(path.join(wt, 'newfile.txt'), 'from task\n');
  gitSync(wt, 'add', 'app.js', 'newfile.txt');
  gitSync(wt, 'commit', '-qm', 'feat-a');
  const commit = gitSync(wt, 'rev-parse', 'HEAD');

  // Dirty tracked file + untracked file colliding with task commit + unrelated untracked file.
  fs.writeFileSync(path.join(cwd, 'app.js'), 'base\nlocal-wip\n');
  fs.writeFileSync(path.join(cwd, 'newfile.txt'), 'from task\n');
  fs.writeFileSync(path.join(cwd, 'notes.txt'), 'keep me\n');

  const { integrateBatch } = require('../project-integration');
  const run = () => integrateBatch({
    cwd, entries: [{ id: 'feat-a', title: 'Feat A', commit, reason: 'ok' }], git: gitAsync,
    resolve: async () => {}, check: async () => {}, progress: () => {}, current: () => true,
    runId: 'run-stash', target: null, saveTarget: () => {}, conflict: null, saveConflict: () => {},
  });
  const blocked = await run();
  assert.match(blocked.error, /대상 브랜치 반영 실패:[\s\S]*app\.js/);
  assert.equal(gitSync(cwd, 'rev-parse', 'HEAD'), base);
  assert.equal(fs.readFileSync(path.join(cwd, 'app.js'), 'utf8'), 'base\nlocal-wip\n');
  assert.equal(fs.readFileSync(path.join(cwd, 'newfile.txt'), 'utf8'), 'from task\n');
  assert.equal(gitSync(cwd, 'stash', 'list'), '');

  gitSync(cwd, 'restore', 'app.js');
  const untracked = await run();
  assert.match(untracked.error, /대상 브랜치 반영 실패:[\s\S]*newfile\.txt/);
  assert.equal(gitSync(cwd, 'rev-parse', 'HEAD'), base);
  assert.equal(fs.readFileSync(path.join(cwd, 'newfile.txt'), 'utf8'), 'from task\n');
  fs.renameSync(path.join(cwd, 'newfile.txt'), path.join(cwd, 'saved.txt'));
  const result = await run();
  assert.equal(result.ok, true);
  assert.equal(gitSync(cwd, 'rev-parse', 'HEAD'), result.tip);
  assert.equal(fs.readFileSync(path.join(cwd, 'newfile.txt'), 'utf8').trim(), 'from task');
  assert.equal(fs.readFileSync(path.join(cwd, 'notes.txt'), 'utf8').trim(), 'keep me');
  assert.equal(fs.readFileSync(path.join(cwd, 'saved.txt'), 'utf8'), 'from task\n');
  assert.equal(gitSync(cwd, 'stash', 'list'), '');
});

test('two-phase merge moves tasks to merge stage, opens one merge session, then transitions to done', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-merge-session-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cwd = path.join(dir, 'repo');
  fs.mkdirSync(cwd);
  const gitSync = (where, ...args) => execFileSync('git', args, { cwd: where, encoding: 'utf8' }).trim();
  gitSync(cwd, 'init', '-q');
  gitSync(cwd, 'config', 'user.email', 'test@example.com');
  gitSync(cwd, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(cwd, 'base.txt'), 'init\n');
  gitSync(cwd, 'add', 'base.txt');
  gitSync(cwd, 'commit', '-qm', 'init');

  const wt = await ensureTaskWorktree(cwd, 'task-m1');
  fs.writeFileSync(path.join(wt, 'feat.txt'), 'merged feature\n');
  gitSync(wt, 'add', 'feat.txt');
  gitSync(wt, 'commit', '-qm', 'feat');
  const mergeCommit = gitSync(wt, 'rev-parse', 'HEAD');

  const projects = require('../projects')(path.join(dir, 'projects.json'));
  const saved = projects.save({
    name: 'MergeSession', goal: '', cwd, autopilot: true, agent: 'codex', termIds: [],
    tasks: [{
      id: 'task-m1', title: 'Feature M1', detail: '', stage: 'merge',
      reviewStatus: 'merge-pending', termId: '', after: [], worktreePath: wt, mergeCommit,
    }],
  });

  const { completeAutopilotTask, checkAutopilotCompletions } = require('../project-autopilot');
  const terms = new Map();
  let sessionCalls = 0;
  const hub = {
    projects, terms, baseDir: dir,
    validateIntegration: async () => {},
    agentOf: () => 'codex',
    codexStatus: (term) => (term._done ? 'idle' : 'busy'),
    readTerm: () => ['›'],
    stripAnsi: (s) => s,
    startProjectMergeSession: async (project, queue, result) => {
      sessionCalls++;
      const term = {
        id: 'mterm-1', exited: null, lastOutputAt: Date.now() - 15000, _done: false,
        _projectBusySeen: true, _projectDispatchedAt: Date.now() - 20000,
        meta: { projectMerge: { projectId: project.id, taskIds: queue.map((q) => q.id), tip: result.tip } },
      };
      terms.set(term.id, term);
      return { id: term.id };
    },
  };

  const first = await completeAutopilotTask(hub, saved.id, 'task-m1', { retryMerge: true, autoMerge: true });
  assert.equal(first.mergeSession, true);
  assert.equal(sessionCalls, 1);
  let [task] = projects.list()[0].tasks;
  assert.equal(task.stage, 'merge');
  assert.equal(task.reviewStatus, 'merge-session');
  assert.equal(task.mergeTermId, 'mterm-1');

  // Simulate merge session finishing its turn
  const mterm = terms.get('mterm-1');
  mterm._done = true;
  mterm.lastOutputAt = Date.now() - 15000;
  for (let i = 0; i < 3; i++) await checkAutopilotCompletions(hub);

  [task] = projects.list()[0].tasks;
  assert.equal(task.stage, 'done');
  assert.equal(task.reviewStatus, 'approved');
});

test('checkAutopilotCompletions recovers projectDelivery.at after server restart without _projectDispatchedAt', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-delivery-recover-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const projects = require('../projects')(path.join(dir, 'projects.json'));
  const deliveredAt = Date.now() - 20000;
  const saved = projects.save({
    name: 'Recover', goal: '', cwd: dir, autopilot: true, agent: 'codex', termIds: ['t1'],
    tasks: [{ id: 't-rec', title: 'Recover', detail: '', kind: 'review', stage: 'doing', termId: 't1', after: [] }],
  });
  const term = {
    id: 't1', exited: null, lastOutputAt: Date.now() - 10000,
    meta: { projectTask: { projectId: saved.id, taskId: 't-rec' }, projectDelivery: { at: deliveredAt, digest: 'abc' }, sessionId: 's1' },
  };
  const { checkAutopilotCompletions } = require('../project-autopilot');
  const hub = {
    projects, terms: new Map([['t1', term]]),
    agentOf: () => 'codex', codexStatus: () => 'idle', readTerm: () => ['›'], stripAnsi: (s) => s,
    index: { get: (sid) => sid === 's1' ? { msgs: [{ role: 'assistant', text: 'Done', ts: deliveredAt + 5000 }] } : null },
  };
  for (let i = 0; i < 3; i++) await checkAutopilotCompletions(hub);
  assert.equal(projects.list()[0].tasks[0].stage, 'done');
});
