'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  findReadyTasks,
  runProjectAutopilot,
  completeAutopilotTask,
  checkAutopilotCompletions,
  parseReviewVerdict,
  readGitSummary,
  runPreReviewChecks,
  detectTestCommand,
  ensureTaskWorktree,
  mergeAndCleanupWorktree,
} = require('../project-autopilot');
const { validate } = require('../project-validation');

test('findReadyTasks returns only planned tasks whose prerequisites are all done and not running', () => {
  const project = {
    id: 'p1',
    autopilot: true,
    tasks: [
      { id: 't1', title: '1. Plan', stage: 'done', after: [] },
      { id: 't2', title: '2. Dev A', stage: 'planned', after: ['t1'] },
      { id: 't3', title: '3. Dev B', stage: 'planned', after: ['t1'] },
      { id: 't4', title: '4. QA', stage: 'planned', after: ['t2', 't3'] },
      { id: 't5', title: '5. Already Running', stage: 'planned', after: ['t1'] },
    ],
  };
  const liveTerms = [
    { exited: null, meta: { projectTask: { projectId: 'p1', taskId: 't5' } } },
  ];
  const ready = findReadyTasks(project, liveTerms);
  assert.deepEqual(ready.map((t) => t.id), ['t2', 't3']);
});

test('runProjectAutopilot transitions ready tasks to doing and starts them when autopilot is true', async () => {
  let savedProject = {
    id: 'p1',
    name: 'Auto',
    cwd: 'D:\\tmp',
    goal: 'Goal',
    autopilot: true,
    termIds: [],
    tasks: [
      { id: 't1', title: '1. Plan', stage: 'done', after: [], termId: '' },
      { id: 't2', title: '2. Dev', stage: 'planned', after: ['t1'], termId: '' },
      { id: 't3', title: '3. QA', stage: 'planned', after: ['t2'], termId: '' },
    ],
  };
  const launched = [];
  const fakeHub = {
    terms: new Map(),
    projects: {
      list: () => [savedProject],
      save: (next) => { savedProject = next; return savedProject; },
    },
    startProjectTaskById: async (pid, tid, opts) => {
      launched.push({ pid, tid, opts });
      return { id: 'term-1' };
    },
  };

  const res = await runProjectAutopilot(fakeHub, 'p1');
  assert.equal(res.started.length, 1);
  assert.equal(res.started[0].taskId, 't2');
  assert.equal(savedProject.tasks.find((t) => t.id === 't2').stage, 'doing');
  assert.equal(savedProject.tasks.find((t) => t.id === 't3').stage, 'planned');
  assert.equal(launched[0].opts.autoDispatch, true);
});

test('project-validation preserves autopilot boolean flag and task autoExclude', () => {
  const valid = validate({
    name: 'AutoProj',
    cwd: 'D:\\tmp',
    goal: 'Goal',
    autopilot: true,
    termIds: [],
    tasks: [
      { id: 't1', title: 'Included', detail: '', stage: 'planned', after: [], termId: '' },
      { id: 't2', title: 'Excluded', detail: '', stage: 'planned', after: [], termId: '', autoExclude: true },
      { id: 't3', title: 'SubOfExcluded', detail: '', stage: 'planned', after: [], termId: '', parentId: 't2' },
    ],
  });
  assert.equal(valid.autopilot, true);
  assert.equal(valid.tasks[0].autoExclude, false);
  assert.equal(valid.tasks[1].autoExclude, true);

  const ready = findReadyTasks({ id: 'p1', ...valid }, []);
  assert.deepEqual(ready.map((t) => t.id), ['t1']);
});

test('completeAutopilotTask approves on APPROVE verdict and retries on REJECT up to maxRetries', async () => {
  let savedProject = {
    id: 'p1',
    name: 'AutoReview',
    cwd: 'D:\\tmp',
    autopilot: true,
    tasks: [
      { id: 't1', title: 'Impl', detail: 'build it', kind: 'dev', stage: 'doing', after: [], retryCount: 0 },
      { id: 't2', title: 'Next', detail: 'next step', kind: 'test', stage: 'planned', after: ['t1'], retryCount: 0 },
    ],
  };
  const dispatched = [];
  const ptyWrites = [];
  let verdictMode = 'REJECT';
  let hookMenu = true;

  const fakeHub = {
    terms: new Map([['1', { id: '1', exited: null, meta: { projectTask: { projectId: 'p1', taskId: 't1' } } }]]),
    projects: {
      list: () => [savedProject],
      save: (next) => { savedProject = next; return savedProject; },
    },
    readTerm: () => hookMenu ? ['SessionStart hooks', 'space/enter toggle · esc back'] : ['› Ask anything'],
    inputReady: () => !hookMenu,
    codexStatus: () => ptyWrites.at(-1)?.data === '\r' ? 'busy' : 'idle',
    sleep: async () => {},
    waitFor: async (ready) => ready(),
    ptyPost: async (id, _op, body) => {
      ptyWrites.push({ id, data: body.data });
      if (body.data === '\x1b') hookMenu = false;
      return { ok: true };
    },
    startProjectTaskById: async (pid, tid) => { dispatched.push({ pid, tid }); return { id: 'term-2' }; },
    reviewTask: async () => (verdictMode === 'REJECT'
      ? { verdict: 'REJECT', reason: '에러 핸들링 누락' }
      : { verdict: 'APPROVE', reason: '모든 기준 통과' }),
  };

  // 1st completion -> REJECT -> retry 1
  const r1 = await completeAutopilotTask(fakeHub, 'p1', 't1', { maxRetries: 2 });
  assert.equal(r1.approved, false);
  assert.equal(r1.retried, true);
  assert.equal(r1.retryCount, 1);
  assert.equal(savedProject.tasks[0].stage, 'doing');
  assert.equal(savedProject.tasks[0].reviewStatus, 'rejected');
  assert.equal(ptyWrites[0].data, '\x1b');
  assert.equal(ptyWrites[2].data, '\r');
  assert.ok(ptyWrites.some((w) => String(w.data).includes('에러 핸들링 누락')));
  assert.equal(dispatched.length, 0);

  // 2nd completion -> APPROVE -> stage done & t2 auto-started
  verdictMode = 'APPROVE';
  const r2 = await completeAutopilotTask(fakeHub, 'p1', 't1', { maxRetries: 2 });
  assert.equal(r2.approved, true);
  assert.equal(savedProject.tasks[0].stage, 'done');
  assert.equal(savedProject.tasks[0].reviewStatus, 'approved');
  assert.equal(savedProject.tasks[0].retryCount, 0);
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].tid, 't2');

  // Exhausted retries return the task to work and pause automatic review.
  savedProject.tasks[0] = { ...savedProject.tasks[0], stage: 'doing', retryCount: 2 };
  verdictMode = 'REJECT';
  const r3 = await completeAutopilotTask(fakeHub, 'p1', 't1', { maxRetries: 2 });
  assert.equal(r3.approved, false);
  assert.equal(r3.retried, false);
  assert.equal(savedProject.tasks[0].stage, 'doing');
  assert.equal(savedProject.tasks[0].reviewPaused, true);
  const term = fakeHub.terms.get('1');
  term._projectBusySeen = true;
  term._idleStreak = 3;
  fakeHub.agentOf = () => 'codex';
  fakeHub.codexStatus = () => 'idle';
  assert.deepEqual(await checkAutopilotCompletions(fakeHub), []);
  assert.equal(savedProject.tasks[0].stage, 'doing');
  delete fakeHub.agentOf;
  fakeHub.codexStatus = () => ptyWrites.at(-1)?.data === '\r' ? 'busy' : 'idle';

  const r4 = await completeAutopilotTask(fakeHub, 'p1', 't1', { maxRetries: 2, force: true });
  assert.equal(r4.retried, true);
  assert.equal(savedProject.tasks[0].retryCount, 1);
});

test('a terminal that never ran the task is not submitted for automatic review', async () => {
  let project = { id: 'startup', name: 'Startup', autopilot: true, tasks: [{ id: 'task', stage: 'doing', kind: 'dev' }] };
  const term = { id: 'term', exited: null, _projectDispatchPending: true, _idleStreak: 2,
    meta: { projectTask: { projectId: project.id, taskId: 'task' }, spawnedAt: Date.now() - 60_000 } };
  let reviewed = false;
  const hub = { terms: new Map([[term.id, term]]), agentOf: () => 'claude', claudeStatus: () => 'idle',
    projects: { list: () => [project], save: (next) => { project = next; } },
    reviewTask: async () => { reviewed = true; } };
  await checkAutopilotCompletions(hub);
  assert.equal(project.tasks[0].stage, 'doing');
  term._projectDispatchPending = false;
  term._projectDispatchedAt = Date.now() - 100_000;
  await checkAutopilotCompletions(hub);
  assert.equal(project.tasks[0].reviewStatus, 'error');
  assert.equal(reviewed, false);
});

test('a hook settings menu is not treated as completed work after a busy indication', async () => {
  let project = { id: 'hook-menu', autopilot: true, tasks: [{ id: 'task', stage: 'doing' }] };
  const term = { id: 'term', exited: null, _projectBusySeen: true, _idleStreak: 2,
    _projectDispatchedAt: Date.now() - 100_000, meta: { projectTask: { projectId: project.id, taskId: 'task' } } };
  const writes = [];
  const hub = { terms: new Map([[term.id, term]]), agentOf: () => 'codex', codexStatus: () => 'idle',
    readTerm: () => ['SessionStart hooks', '› [ ] Loading ponytail mode...', 'space/enter toggle · esc back'],
    ptyPost: async (_id, _op, body) => { writes.push(body.data); return { ok: true }; },
    projects: { list: () => [project], save: (next) => { project = next; } } };
  assert.deepEqual(await checkAutopilotCompletions(hub), []);
  assert.equal(project.tasks[0].stage, 'doing');
  assert.deepEqual(await checkAutopilotCompletions(hub), []);
  assert.equal(project.tasks[0].reviewStatus, 'error');
  assert.deepEqual(writes, ['\x1b']);
  assert.match(project.tasks[0].reviewNote, /SessionStart.*Esc/);
});

test('failed delivery of a correction returns the task to work and pauses review', async () => {
  let project = { id: 'retry-error', name: 'Retry', cwd: 'D:\\tmp', autopilot: true,
    tasks: [{ id: 'task', stage: 'doing', kind: 'dev', retryCount: 1 }] };
  const result = await completeAutopilotTask({
    projects: { list: () => [project], save: (next) => { project = next; } },
    reviewTask: async () => ({ verdict: 'REJECT', reason: 'Missing result' }),
    startProjectTaskById: async () => ({ error: 'Terminal unavailable' }),
  }, project.id, 'task');
  assert.equal(result.retried, false);
  assert.equal(project.tasks[0].stage, 'doing');
  assert.equal(project.tasks[0].reviewPaused, true);
  assert.equal(project.tasks[0].reviewStatus, 'error');
  assert.equal(project.tasks[0].retryCount, 1);
  assert.match(project.tasks[0].reviewNote, /Terminal unavailable.*Missing result/s);
});

test('a review that finishes after the task moved back to work cannot overwrite it', async () => {
  let project = { id: 'review-moved', name: 'Moved', autopilot: true, tasks: [{ id: 'task', stage: 'doing' }] };
  const hub = {
    projects: { list: () => [project], save: (next) => { project = next; } },
    reviewTask: async () => {
      project.tasks[0] = { ...project.tasks[0], stage: 'doing', reviewStatus: '', reviewPaused: true };
      return { verdict: 'APPROVE' };
    },
  };
  assert.equal((await completeAutopilotTask(hub, project.id, 'task')).skipped, true);
  assert.equal(project.tasks[0].stage, 'doing');
  assert.equal(project.tasks[0].reviewPaused, true);
});

test('runProjectAutopilot enforces maxConcurrent cap and checkAutopilotCompletions debounces idle before completing', async () => {
  let savedProject = {
    id: 'p2',
    name: 'Convoy',
    cwd: 'D:\\tmp',
    autopilot: true,
    tasks: [
      { id: 't1', title: 'A', detail: '', kind: 'dev', stage: 'doing', after: [] },
      { id: 't2', title: 'B', detail: '', kind: 'dev', stage: 'planned', after: [] },
      { id: 't3', title: 'C', detail: '', kind: 'dev', stage: 'planned', after: [] },
    ],
  };
  const startedIds = [];
  const term1 = {
    id: '10',
    exited: null,
    lastOutputAt: Date.now(),
    meta: { projectTask: { projectId: 'p2', taskId: 't1' }, spawnedAt: Date.now() - 20000 },
  };
  let termStatus = 'busy';
  const fakeHub = {
    terms: new Map([['10', term1]]),
    projects: {
      list: () => [savedProject],
      save: (next) => { savedProject = next; return savedProject; },
    },
    agentOf: () => 'claude',
    claudeStatus: () => termStatus,
    readTerm: () => ['Working...'],
    startProjectTaskById: async (_pid, tid) => {
      startedIds.push(tid);
      fakeHub.terms.set(`term-${tid}`, { id: `term-${tid}`, exited: null, meta: { projectTask: { projectId: 'p2', taskId: tid }, spawnedAt: Date.now() } });
      return { id: `term-${tid}` };
    },
    reviewTask: async () => ({ verdict: 'APPROVE', reason: 'ok' }),
  };

  // Max concurrent cap = 2 -> t1 is already doing, so only 1 slot remains (t2 starts, t3 waits)
  const runRes = await runProjectAutopilot(fakeHub, 'p2', { maxConcurrent: 2 });
  assert.deepEqual(runRes.started.map((x) => x.taskId), ['t2']);

  // Term 1 busy -> not complete
  await checkAutopilotCompletions(fakeHub);
  assert.equal(term1._projectBusySeen, true);
  assert.equal(savedProject.tasks[0].stage, 'doing');

  // Term 1 becomes idle with recent output -> debounced (not complete)
  termStatus = 'idle';
  term1.lastOutputAt = Date.now();
  await checkAutopilotCompletions(fakeHub);
  assert.equal(savedProject.tasks[0].stage, 'doing');

  // Quiet idle for 2 consecutive polls -> completes & triggers review
  term1.lastOutputAt = Date.now() - 20000;
  await checkAutopilotCompletions(fakeHub);
  const s2 = await checkAutopilotCompletions(fakeHub);
  assert.equal(s2.length, 1);
  await s2[0].promise;
  assert.equal(savedProject.tasks[0].stage, 'done');
});

test('readGitSummary includes staged diffs and untracked file previews, and detectTestCommand supports multi-ecosystem', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-git-sum-'));
  try {
    execFileSync('git', ['init'], { cwd: tmp, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmp, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmp, stdio: 'ignore' });
    fs.writeFileSync(path.join(tmp, 'a.txt'), 'v1\n');
    execFileSync('git', ['add', 'a.txt'], { cwd: tmp, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: tmp, stdio: 'ignore' });

    fs.writeFileSync(path.join(tmp, 'a.txt'), 'v2-staged\n');
    execFileSync('git', ['add', 'a.txt'], { cwd: tmp, stdio: 'ignore' });
    fs.writeFileSync(path.join(tmp, 'brand-new.js'), 'export const hello = 42;\n');

    const summary = await readGitSummary(tmp);
    assert.ok(summary.includes('[staged diff]'));
    assert.ok(summary.includes('v2-staged'));
    assert.ok(summary.includes('[untracked: brand-new.js]'));
    assert.ok(summary.includes('hello = 42'));

    fs.writeFileSync(path.join(tmp, 'Cargo.toml'), '[package]\nname = "demo"\n');
    assert.equal(detectTestCommand(tmp).label, 'cargo test');
    fs.rmSync(path.join(tmp, 'Cargo.toml'));
    fs.writeFileSync(path.join(tmp, 'go.mod'), 'module demo\n');
    assert.equal(detectTestCommand(tmp).label, 'go test ./...');
    fs.rmSync(path.join(tmp, 'go.mod'));
    fs.writeFileSync(path.join(tmp, 'pytest.ini'), '[pytest]\n');
    assert.equal(detectTestCommand(tmp).label, 'pytest -q');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('completeAutopilotTask resumes priorSessionId on exited retry and auto-backoff re-reviews on transient error', async () => {
  let savedProject = {
    id: 'p-res',
    name: 'ResumeErr',
    cwd: 'D:\\tmp\\res',
    autopilot: true,
    tasks: [
      { id: 't1', title: 'Build', detail: 'd', kind: 'dev', stage: 'doing', after: [], retryCount: 0 },
    ],
  };
  const startedCalls = [];
  let revCalls = 0;
  const fakeHub = {
    reviewRetryDelayMs: 25,
    terms: new Map([['99', { id: '99', exited: 0, meta: { sessionId: 'sess-abc-123', projectTask: { projectId: 'p-res', taskId: 't1' } } }]]),
    projects: {
      list: () => [savedProject],
      save: (next) => { savedProject = next; return savedProject; },
    },
    startProjectTaskById: async (pid, tid, opts) => { startedCalls.push({ pid, tid, opts }); return { id: 'term-new' }; },
    reviewTask: async () => {
      revCalls += 1;
      if (revCalls === 1) throw new Error('HTTP 429 rate limit');
      return { verdict: 'REJECT', reason: '테스트 보강 필요' };
    },
  };

  const r1 = await completeAutopilotTask(fakeHub, 'p-res', 't1', { maxRetries: 2 });
  assert.equal(r1.reReviewScheduled, true);
  assert.equal(savedProject.tasks[0].stage, 'review');
  assert.equal(savedProject.tasks[0].reviewStatus, 'reviewing');

  // Wait for scheduled backoff re-review to execute and trigger REJECT -> retry with resume
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(revCalls, 2);
  assert.equal(savedProject.tasks[0].stage, 'doing');
  assert.equal(savedProject.tasks[0].retryCount, 1);
  assert.equal(startedCalls.length, 1);
  assert.equal(startedCalls[0].opts.resume, 'sess-abc-123');
  assert.ok(String(startedCalls[0].opts.rawPrompt).includes('테스트 보강 필요'));
});

test('ensureTaskWorktree and mergeAndCleanupWorktree isolate parallel task changes and merge cleanly', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-wt-'));
  try {
    execFileSync('git', ['init'], { cwd: tmp, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmp, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmp, stdio: 'ignore' });
    fs.writeFileSync(path.join(tmp, 'base.txt'), 'base\n');
    execFileSync('git', ['add', 'base.txt'], { cwd: tmp, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: tmp, stdio: 'ignore' });

    const wt = await ensureTaskWorktree(tmp, 'task-12345678');
    assert.ok(wt && fs.existsSync(wt));
    fs.writeFileSync(path.join(wt, 'feature.txt'), 'from-worktree\n');
    assert.equal(fs.existsSync(path.join(tmp, 'feature.txt')), false);

    const merged = await mergeAndCleanupWorktree(tmp, 'task-12345678', wt);
    assert.equal(merged.ok, true);
    assert.equal(fs.existsSync(path.join(tmp, 'feature.txt')), true);
    assert.equal(fs.existsSync(wt), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('runProjectAutopilot rolls back failed start and checkAutopilotCompletions recovers orphaned reviewing/doing tasks', async () => {
  let savedProject = {
    id: 'p-rec',
    name: 'Recover',
    cwd: 'D:\\tmp\\rec',
    autopilot: true,
    tasks: [
      { id: 't-fail', title: 'FailStart', detail: '', kind: 'dev', stage: 'planned', after: [] },
      { id: 't-rev', title: 'OrphanRev', detail: '', kind: 'dev', stage: 'review', reviewStatus: 'reviewing', after: [] },
      { id: 't-do', title: 'OrphanDoing', detail: '', kind: 'dev', stage: 'doing', after: [] },
    ],
  };
  let allowStart = false;
  const started = [];
  const fakeHub = {
    terms: new Map(),
    projects: {
      list: () => [savedProject],
      save: (next) => { savedProject = next; return savedProject; },
    },
    startProjectTaskById: async (_pid, tid) => {
      if (!allowStart) return { error: 'spawn failed' };
      started.push(tid);
      return { id: `term-${tid}` };
    },
    reviewTask: async () => ({ verdict: 'APPROVE', reason: 'recovered' }),
  };

  // Failed start rolls back t-fail to planned instead of leaving it stuck in doing
  const failRun = await runProjectAutopilot(fakeHub, 'p-rec', { maxConcurrent: 1 });
  assert.equal(failRun.started.length, 0);
  assert.equal(savedProject.tasks.find((t) => t.id === 't-fail').stage, 'planned');

  // Tick 1..3: t-rev (orphaned reviewing) is recovered immediately; t-do increments orphan ticks
  allowStart = true;
  const s1 = await checkAutopilotCompletions(fakeHub);
  await Promise.all(s1.map((x) => x.promise));
  assert.equal(savedProject.tasks.find((t) => t.id === 't-rev').stage, 'done');

  await checkAutopilotCompletions(fakeHub);
  await checkAutopilotCompletions(fakeHub);
  // Tick 4: t-do (orphaned doing with no terminal across 4 ticks) is recovered & re-dispatched
  const s4 = await checkAutopilotCompletions(fakeHub);
  await Promise.all(s4.map((x) => x.promise));
  assert.ok(started.includes('t-do'));
  assert.equal(savedProject.tasks.find((t) => t.id === 't-do').stage, 'doing');
});

test('parseReviewVerdict never falsely approves empty CLI envelope or leaks raw json_schema', () => {
  const emptyAgyEnvelope = JSON.stringify({
    conversation_id: '4da75492-eb8b-4bb4-845f-db26076577a9',
    status: 'SUCCESS',
    response: '',
    json_schema: { type: 'object', properties: { verdict: { enum: ['APPROVE', 'REJECT'] } } },
    denied_actions: [{ action: 'read_file', display_name: 'ReadFile' }],
  });
  assert.throws(() => parseReviewVerdict(emptyAgyEnvelope), /빈 응답/);

  const validEnvelope = JSON.stringify({
    conversation_id: 'abc',
    status: 'SUCCESS',
    response: JSON.stringify({ verdict: 'APPROVE', reason: '테스트와 요구사항을 모두 충족합니다.' }),
    json_schema: { type: 'object', properties: { verdict: { enum: ['APPROVE', 'REJECT'] } } },
  });
  const parsed = parseReviewVerdict(validEnvelope);
  assert.equal(parsed.verdict, 'APPROVE');
  assert.equal(parsed.reason, '테스트와 요구사항을 모두 충족합니다.');
});

test('runPreReviewChecks executes npm.cmd test on Windows without spawn EINVAL', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-precheck-'));
  try {
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'tmp-check', scripts: { test: 'node -e "console.log(123)"' } }));
    const res = await runPreReviewChecks(tmp);
    assert.equal(res.ran, true);
    assert.equal(res.command, 'npm test');
    assert.equal(res.ok, true);
    assert.ok(res.output.includes('123'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
