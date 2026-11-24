'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

test('four project launch paths apply and persist the same Vault resources', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-launch-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const launches = [];
  const recordLaunch = ({ args, env }) => {
    const value = (key) => args[args.indexOf(key) + 1];
    assert.ok(args.includes('--add-dir'));
    assert.ok(args.includes('--append-system-prompt-file'));
    assert.equal(env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD, '1');
    assert.ok(fs.existsSync(path.join(value('--add-dir'), '.claude', 'skills', 'demo', 'SKILL.md')));
    assert.match(fs.readFileSync(value('--append-system-prompt-file'), 'utf8'), /unique-rule-body/);
    launches.push(args);
  };
  t.mock.method(globalThis, 'fetch', async (_url, req) => {
    recordLaunch(JSON.parse(req.body));
    return { json: async () => ({ ok: true }) };
  });
  t.mock.method(require('node:child_process'), 'spawn', (exe, args, { env }) => {
    assert.equal(exe, 'claude.exe');
    recordLaunch({ args, env });
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    const structured_output = args.includes('--no-session-persistence')
      ? { tasks: [{ title: 'Demo', detail: 'Verify Vault', after: [] }, { title: 'Next', detail: 'Verify history', after: [1] }] }
      : { verdict: 'APPROVE', reason: 'fixture' };
    queueMicrotask(() => {
      child.stdout.end(JSON.stringify({ structured_output, result: 'fixture' }));
      child.emit('close', 0);
    });
    return child;
  });
  t.mock.method(require('../project-review-run'), 'runReview', async (_dir, prepare) => {
    const spec = await prepare();
    assert.equal(spec.cmd, 'claude.exe');
    recordLaunch({ args: spec.args, env: spec.options.env });
    return { verdict: { verdict: 'APPROVE', reason: 'fixture' } };
  });

  const { createUnifiedVault } = require('../unified-vault');
  const { createProjectRoutes } = require('../routes-projects');
  const { createTermManager } = require('../term-manager');
  const { completeAutopilotTask } = require('../project-autopilot');
  const store = require('../projects');
  const file = path.join(dir, 'projects.json');
  const projects = store(file);
  const unifiedVault = createUnifiedVault({ homeDir: path.join(dir, 'home'), repoRoot: dir });
  unifiedVault.saveSkill({ name: 'demo', content: 'unique-skill-body' });
  unifiedVault.saveSkill({ name: 'missing', content: 'removed' });
  fs.unlinkSync(path.join(dir, 'vault', 'skills', 'missing', 'SKILL.md'));
  unifiedVault.saveRule({ name: 'native', content: 'unique-rule-body' });
  unifiedVault.saveRule({ name: 'codex', content: 'other', targets: ['codex'] });
  unifiedVault.saveMcp({ name: 'fixture', command: 'echo', env: { TEST_TOKEN: 'fixture-secret-value' } });
  const hub = {
    baseDir: dir, config: {}, projects, unifiedVault, cleanEnv: () => ({}), ensureAgySwap: async () => {},
    projectAccounts: { resolve: () => ({}) }, cleanModelEffort: () => ({}),
    projectHarness: { get: () => ({ roles: { review: { agent: 'claude' } } }) },
    index: { get: () => null }, recordUuid: () => false,
    ...require('../project-plan'),
    runTaskSubChatTurn: require('../task-subchat').runTaskSubChatTurn,
  };
  const { handleProjectRoutes } = createProjectRoutes(hub);
  const call = async (method, uri, body) => {
    const url = new URL(uri, 'http://test');
    let result;
    await handleProjectRoutes(url.pathname, url, { method }, null, async () => body, (_res, code, payload) => {
      assert.equal(code, 200, payload.error);
      result = payload;
    }, () => true);
    return result;
  };

  const cwd = path.join(dir, 'workspace');
  fs.mkdirSync(cwd);
  const draft = { name: 'Vault test', goal: 'Verify resources', cwd, agent: 'claude' };
  const { tasks } = await call('POST', '/api/projects/plan', draft);
  const { project } = await call('POST', '/api/projects', { ...draft, tasks, termIds: [] });
  const taskId = tasks[0].id;
  const projectId = project.id;
  const manager = createTermManager(hub);
  const term = manager.createTerm({ cwd, cmd: 'claude.exe', projectTask: { projectId, taskId } });
  assert.deepEqual(await term.spawnResult, { ok: true });
  await call('POST', '/api/projects/task-chat', { projectId, taskId, agent: 'claude', prompt: 'Hello' });
  assert.equal((await completeAutopilotTask(hub, projectId, taskId, { force: true })).approved, true);
  assert.equal(launches.length, 4);

  const { vaultRuns } = await call('GET', `/api/projects/task-chat?projectId=${projectId}&taskId=${taskId}`);
  assert.deepEqual(vaultRuns, store(file).vaultRuns(projectId, taskId));
  assert.deepEqual(vaultRuns.map((run) => run.area), ['plan', 'terminal', 'subchat', 'review']);
  assert.deepEqual(store(file).vaultRuns(projectId, tasks[1].id), [vaultRuns[0]]);
  for (const run of vaultRuns) {
    assert.deepEqual(run.applied.slice().sort(), ['rule:native.md', 'shared', 'skill:demo']);
    assert.deepEqual(run.omitted, [
      { id: 'skill:missing', reason: 'missing' }, { id: 'rule:codex.md', reason: 'unsupported-target' },
    ]);
  }
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /unique-(rule|skill)-body|fixture-secret-value/);
});
