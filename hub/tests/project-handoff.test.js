'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const openProjects = require('../projects');
const { createSessionRoutes } = require('../routes-sessions');
const { completeAutopilotTask, checkAutopilotCompletions } = require('../project-autopilot');

test('both prerequisites trigger one confirmed handoff and only its result advances the card', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-handoff-'));
  const file = path.join(cwd, 'projects.json');
  t.after(() => { fs.unlinkSync(file); fs.rmdirSync(cwd); });
  const projects = openProjects(file);
  const tasks = ['one', 'two', 'next'].map((id) => ({
    id, title: id, detail: '', termId: '', kind: 'review',
    stage: id === 'next' ? 'planned' : 'doing', after: id === 'next' ? ['one', 'two'] : [],
    lastOutput: id === 'next' ? '' : `Output of ${id}`,
  }));
  const { id: projectId } = projects.save({ name: 'Handoff', cwd, goal: '', autopilot: true, termIds: [], tasks });
  const saved = () => openProjects(file).list()[0].tasks[2];
  const phases = () => saved().handoff.history.map((event) => event.phase);
  const writes = [];
  const messages = [];
  let spawns = 0;
  let screen = ['› Ask Codex to do anything'];
  const hub = {
    projects, terms: new Map(), deletingProjects: new Set(), stripAnsi: (s) => s,
    projectAgents: ['codex'], projectAccounts: { resolve: () => ({}) },
    ensureProjectDir() {}, fingerprint: (s) => s, cliModelEffortArgs: () => [],
    codexLaunch: () => ({ cmd: 'codex.exe', args: [] }),
    agentOf: () => 'codex', termInfo: ({ id }) => ({ id }), index: { get: () => ({ msgs: messages }) },
    readTerm: () => screen, inputReady: () => true, codexStatus: () => screen[0] === 'Running' ? 'busy' : 'idle',
    sleep: async () => {}, waitFor: async (fn) => fn(),
    createTerm(meta) {
      const term = { id: String(++spawns), meta: { ...meta, sessionId: 'session' }, exited: null,
        spawnResult: Promise.resolve({ ok: true }) };
      this.terms.set(term.id, term);
      return term;
    },
    ptyPost: async (id, op, { data, meta }) => {
      if (op === '/meta') {
        assert.deepEqual(phases(), ['waiting']);
        assert.deepEqual(meta.projectDelivery, hub.terms.get(id).meta.projectDelivery);
        return { ok: true };
      }
      assert.equal(op, '/write');
      assert.deepEqual(phases(), ['waiting', 'delivered']);
      writes.push(data);
      screen = data === '\r' ? ['Running'] : `› ${data.slice(6, -6)}`.split('\n');
      return { ok: true };
    },
  };
  createSessionRoutes(hub);
  assert.deepEqual(phases(), ['waiting']);
  assert.deepEqual((await completeAutopilotTask(hub, projectId, 'one')).started, []);
  await checkAutopilotCompletions(hub);
  assert.deepEqual(phases(), ['waiting']);
  assert.deepEqual((await completeAutopilotTask(hub, projectId, 'two')).started.map((x) => x.taskId), ['next']);
  const term = hub.terms.get('1');
  assert.equal(await term._projectDispatchResult, undefined);
  assert.match(writes[0], /Output of one[\s\S]*Output of two/);
  assert.deepEqual(writes.slice(1), ['\r']);
  assert.deepEqual(phases(), ['waiting', 'delivered', 'confirmed']);

  const at = term._projectDispatchedAt;
  const pt = term.meta.projectTask;
  assert.equal(projects.advanceHandoff(pt, 'old-term', at, 'received'), false);
  assert.equal(projects.advanceHandoff(pt, term.id, at - 1, 'received'), false);
  assert.equal(projects.advanceHandoff(pt, term.id, at, 'delivered'), false);
  messages.push({ role: 'assistant', text: 'Old result', ts: new Date(at - 1).toISOString() });
  screen = ['› Ask Codex to do anything'];
  term._idleStreak = 2;
  await checkAutopilotCompletions(hub);
  assert.equal(saved().handoff.history.at(-1).phase, 'confirmed');
  messages.push({ role: 'assistant', text: 'Current result', ts: new Date(at + 1).toISOString() });
  hub.terms.set('old-term', { ...term, id: 'old-term', exited: 0 });
  term._projectDispatchPending = true;
  assert.deepEqual(await checkAutopilotCompletions(hub), []);
  assert.equal(saved().handoff.history.at(-1).phase, 'confirmed');
  term._projectDispatchPending = false;
  const [finished] = await checkAutopilotCompletions(hub);
  await finished.promise;
  assert.deepEqual(phases(), ['waiting', 'delivered', 'confirmed', 'received']);
  assert.equal(saved().lastOutput, 'Current result');
  assert.equal(saved().stage, 'done');
  const revision = projects.list()[0].revision;
  term._projectDispatchedAt = at;
  assert.deepEqual(await checkAutopilotCompletions(hub), []);
  assert.equal(projects.list()[0].revision, revision);
  assert.equal(spawns, 1);
});
