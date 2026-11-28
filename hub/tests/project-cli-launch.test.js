const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const openProjects = require('../projects');
const { createSessionRoutes } = require('../routes-sessions');

test('manual and automatic launches persist the selected CLI and its source', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-cli-launch-'));
  const file = path.join(cwd, 'projects.json');
  t.after(() => {
    fs.rmSync(file, { force: true });
    fs.rmdirSync(cwd);
  });
  const projects = openProjects(file);
  const tasks = ['', 'claude', '', ''].map((agent, i) => ({
    id: String(i), title: 'Review', detail: '', stage: 'planned',
    kind: 'review', termId: '', after: [], agent,
  }));
  const project = projects.save({ name: 'CLI project', cwd, goal: '', agent: 'codex', termIds: [], tasks });
  const launched = [];
  const hub = {
    projects, terms: new Map(), deletingProjects: new Set(),
    projectAgents: ['codex', 'claude', 'agy'], projectAccounts: { resolve: () => ({}) },
    ensureProjectDir() {}, fingerprint: (s) => s,
    cliModelEffortArgs: () => [], codexLaunch: () => ({ cmd: 'codex.exe', args: [] }),
    agyExe: () => 'agy.exe', agySwap: { available: () => false },
    agentOf: (term) => term.agent, termInfo: (term) => ({ id: term.id, agent: term.agent }),
    createTerm(meta) {
      const id = String(launched.push(meta.cmd));
      const term = { id, meta, agent: path.basename(meta.cmd, '.exe'), exited: null,
        spawnResult: Promise.resolve(id === '4' ? { error: 'simulated spawn error' } : { ok: true }) };
      this.terms.set(id, term);
      return term;
    },
  };
  const { handleSessionRoutes } = createSessionRoutes(hub);
  const manual = async (taskId) => handleSessionRoutes('/api/projects/start', null, { method: 'POST' }, null,
    async () => ({ projectId: project.id, taskId, autoDispatch: false }),
    (_res, status) => assert.equal(status, 200), () => true);
  await manual('0');
  await manual('1');
  assert.equal((await hub.startProjectTaskById(project.id, '2', { autoDispatch: false })).agent, 'codex');
  assert.match((await hub.startProjectTaskById(project.id, '3', { autoDispatch: false })).error, /CLI/);
  assert.deepEqual(launched, ['codex.exe', 'claude.exe', 'codex.exe', 'codex.exe']);

  const [saved] = openProjects(file).list();
  assert.deepEqual(saved.tasks.map((task) => task.lastRun?.source), ['project', 'task', 'project', undefined]);
  assert.deepEqual(saved.tasks.map((task) => task.lastRun?.agent), ['codex', 'claude', 'codex', undefined]);
  assert.equal(saved.tasks[3].stage, 'planned');
  assert.deepEqual(saved.tasks.map((task) => task.agent), ['', 'claude', '', '']);
  assert.equal(saved.agent, 'codex');
  const edited = projects.save({ ...saved, tasks: saved.tasks.map(({ lastRun, ...task }) => task) });
  assert.deepEqual(edited.tasks.map((task) => task.lastRun), saved.tasks.map((task) => task.lastRun));

  const legacyData = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete legacyData.projects[0].agent;
  fs.writeFileSync(file, JSON.stringify(legacyData));
  await manual('3');
  const [legacy] = openProjects(file).list();
  assert.equal(legacy.agent, undefined);
  assert.equal(launched.at(-1), 'agy.exe');
  assert.deepEqual(legacy.tasks[3].lastRun, { agent: 'agy', source: 'role', termId: '5' });
});
