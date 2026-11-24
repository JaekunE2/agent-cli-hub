const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const openStore = require('../projects');
const { createProjectRoutes } = require('../routes-projects');
const { createSessionRoutes } = require('../routes-sessions');
const { fileRunPath, isGit } = require('../project-file-runs');
const { copyVersion } = require('../version-files');
const { completeAutopilotTask, checkAutopilotCompletions } = require('../project-autopilot');

test('non-Git execution archives both file states and resumes completion from the persisted run', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-file-run-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cwd = path.join(dir, 'workspace');
  const root = path.join(dir, 'versions');
  const store = path.join(dir, 'projects.json');
  fs.mkdirSync(cwd);
  const notes = path.join(cwd, 'notes.txt');
  fs.writeFileSync(notes, 'before');
  const hash = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const before = hash(notes);
  const hub = {
    baseDir: dir, config: { versionStorageDir: root }, projects: openStore(store),
    terms: new Map(), agentOf: () => 'codex', projectAgents: ['codex'], cliModelEffortArgs: () => [], fingerprint: () => '',
    projectAccounts: { resolve: () => ({}) }, codexLaunch: () => ({ cmd: 'codex', args: [] }),
    ensureProjectDir: () => {}, termInfo: (term) => ({ id: term.id }),
    reviewTask: () => ({ verdict: 'APPROVE', reason: 'checked' }),
    createTerm(options) {
      assert.equal(hash(path.join(fileRunPath(root, id, options.projectTask.fileRunId, 'start'), 'notes.txt')), before);
      execFileSync(process.execPath, ['-e', "require('node:fs').writeFileSync('notes.txt', 'after')"], { cwd });
      const term = { id: '1', exited: null, meta: { projectTask: options.projectTask }, spawnResult: Promise.resolve({}) };
      hub.terms.set(term.id, term);
      return term;
    },
  };
  const task = { id: 'task', title: 'Work', detail: '', termId: '', after: [], stage: 'planned' };
  const { id } = hub.projects.save({ name: 'Local', cwd, goal: '', agent: 'codex', termIds: [], tasks: [task] });
  const latest = () => hub.projects.list()[0];
  let routes = createProjectRoutes(hub);
  Object.assign(hub, routes);
  createSessionRoutes(hub);
  assert.equal(latest().fileRuns, undefined);
  assert.equal((await hub.startProjectTaskById(id, task.id, { autoDispatch: false })).id, '1');
  assert.equal((await hub.startProjectTaskById(id, task.id, { autoDispatch: false })).existing, true);
  const runId = latest().tasks[0].lastRun.fileRunId;
  const end = fileRunPath(root, id, runId, 'finish');
  const after = hash(notes);
  const started = latest();
  hub.projects.save({ ...started, tasks: [{ ...started.tasks[0], stage: 'done', reviewStatus: 'approved' }] });
  assert.equal(latest().tasks[0].stage, 'review');
  assert.equal(latest().fileRuns[0].finishedAt, undefined);
  await copyVersion(cwd, end);
  fs.writeFileSync(notes, 'changed after the completed snapshot');
  hub.projects = openStore(store);
  routes = createProjectRoutes(hub);
  hub.terms.clear();
  await checkAutopilotCompletions(hub);
  assert.equal(hash(path.join(end, 'notes.txt')), after);
  assert.equal(latest().tasks[0].stage, 'done');
  assert.equal(latest().fileRuns[0].reviewStatus, 'approved');
  const revision = latest().revision;
  await Promise.all([completeAutopilotTask(hub, id, task.id), completeAutopilotTask(hub, id, task.id)]);
  assert.equal(latest().revision, revision);
  assert.equal(latest().fileRuns.length, 1);
  let result;
  await routes.handleProjectRoutes('/api/projects', new URL('http://test/api/projects'), { method: 'POST' }, null,
    async () => ({ id, revision, snapshotVersion: '1.0.0', sourceFileRun: { id: runId, phase: 'finish' } }),
    (_res, code, payload) => { result = { code, ...payload }; }, () => true);
  assert.equal(result.code, 200, result.error);
  assert.equal(hash(path.join(result.project.versions[0].workspace, 'notes.txt')), after);
  assert.equal(fs.readFileSync(notes, 'utf8'), 'changed after the completed snapshot');

  const second = { ...task, id: 'second', stage: 'doing' };
  const restored = latest();
  hub.projects.save({ ...restored, autopilot: true, tasks: [...restored.tasks, second] });
  const prepared = await hub.fileRuns.prepare(id, second.id, cwd, false);
  const recovered = { id: '2', meta: { projectTask: { projectId: id, taskId: second.id, fileRunId: prepared.id, agentSource: 'project' } } };
  hub.fileRuns.recoverStart(recovered);
  assert.equal(latest().tasks[1].lastRun.fileRunId, prepared.id);
  const adoptedRevision = latest().revision;
  hub.fileRuns.recoverStart(recovered);
  assert.equal(latest().revision, adoptedRevision);
  fs.writeFileSync(notes, 'approved by reviewer');
  assert.equal((await completeAutopilotTask(hub, id, second.id)).approved, true);
  assert.equal(latest().tasks[1].stage, 'done');
  assert.equal(hash(path.join(fileRunPath(root, id, prepared.id, 'finish'), 'notes.txt')), hash(notes));

  const removed = { ...task, id: 'removed' };
  const betweenRuns = latest();
  hub.projects.save({ ...betweenRuns, tasks: [...betweenRuns.tasks, removed] });
  const save = hub.projects.save;
  hub.projects.save = (project, options) => {
    const saved = save(project, options);
    if (options?.fileRun?.taskId === removed.id) {
      save({ ...saved, tasks: saved.tasks.filter((item) => item.id !== removed.id) });
    }
    return saved;
  };
  createSessionRoutes(hub);
  const { error } = await hub.startProjectTaskById(id, removed.id, { autoDispatch: false });
  assert.match(error, /작업 상태가 변경되었습니다/);
  assert.equal(hub.terms.size, 0);
  hub.projects.save = save;

  execFileSync('git', ['init', '-q'], { cwd });
  const ignored = path.join(cwd, 'projects', 'non-git');
  fs.writeFileSync(path.join(cwd, '.gitignore'), 'projects/\n');
  fs.mkdirSync(ignored, { recursive: true });
  assert.equal(await isGit(ignored), false);
  assert.equal(await isGit(cwd), true);
  assert.equal(await hub.fileRuns.prepare(id, task.id, cwd, false), undefined);
});
