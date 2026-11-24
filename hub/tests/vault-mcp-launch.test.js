'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createUnifiedVault } = require('../unified-vault');
const { createSessionRoutes } = require('../routes-sessions');
const { findReadyTasks } = require('../project-autopilot');
const openProjects = require('../projects');

test('task start verifies required MCPs, activates by consent, and records fallback or blocking', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-mcp-launch-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 10 }));
  const homeDir = path.join(cwd, 'home');
  const accountHome = path.join(cwd, 'codex-account');
  const file = path.join(cwd, 'projects.json');
  const projects = openProjects(file);
  const unifiedVault = createUnifiedVault({ homeDir, repoRoot: cwd });
  const fixture = path.join(cwd, 'mcp.cjs');
  fs.writeFileSync(fixture, `
    require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
      const r = JSON.parse(line);
      if (r.method === 'initialize') console.log(JSON.stringify({ jsonrpc: '2.0', id: r.id,
        result: { protocolVersion: r.params.protocolVersion, capabilities: {}, serverInfo: { name: 'test', version: '1' } } }));
    });
  `);
  const name = 'fixture';
  const saveMcp = (opts) => unifiedVault.saveMcp({ name, command: process.execPath, args: [fixture], targets: ['codex'], ...opts });
  saveMcp({});
  unifiedVault.saveSkill({ name: 'uses-mcp', requiredMcps: [name, name] });
  const tasks = ['codex', 'codex', '', 'agy', 'codex', 'codex', 'codex', 'codex'].map((agent, i) => ({
    id: String(i), title: 'Test', detail: '', stage: 'planned', termId: '', after: [], agent,
  }));
  const initial = projects.save({ name: 'MCP project', goal: '', cwd, agent: 'agy', mcpFallbackAgent: 'codex', tasks, termIds: [] });
  const read = () => openProjects(file).list()[0];
  const launches = [];
  const hub = {
    projects, unifiedVault, terms: new Map(), deletingProjects: new Set(), cleanEnv: () => process.env,
    projectAgents: ['codex', 'agy', 'claude'], ensureProjectDir() {}, fingerprint: (text) => text,
    projectAccounts: { resolve: () => ({ env: { CODEX_HOME: accountHome } }) },
    cliModelEffortArgs: () => [], codexLaunch: () => ({ cmd: 'codex.exe', args: [] }),
    agySwap: { available: () => false }, agentOf: (term) => term.agent, termInfo: ({ id, agent }) => ({ id, agent }),
    createTerm(meta) {
      const id = String(launches.push(meta.agent));
      assert.ok(meta.preparedVault.vault.applied.includes('mcp:fixture'));
      assert.ok(fs.existsSync(path.join(accountHome, 'config.toml')));
      const term = { id, meta, agent: meta.agent, exited: null, spawnResult: Promise.resolve({ ok: true }) };
      this.terms.set(id, term);
      return term;
    },
  };
  createSessionRoutes(hub);
  const start = (i) => hub.startProjectTaskById(initial.id, String(i), { autoDispatch: false });
  assert.equal((await start(0)).agent, 'codex');
  saveMcp({ enabled: false, autoEnable: true });
  assert.equal((await start(1)).agent, 'codex');
  assert.equal(unifiedVault.getState().mcps[0].enabled, true);
  const fallback = await start(2);
  assert.equal(fallback.agent, 'codex');
  assert.equal((await start(2)).id, fallback.id);
  assert.deepEqual(read().tasks[2].lastRun, {
    agent: 'codex', source: 'project', termId: fallback.id,
    mcpFallback: { from: 'agy', reason: 'fixture (CLI 또는 스킬의 적용 대상에서 제외됨)' },
  });
  projects.save({ ...read(), mcpFallbackAgent: 'claude' });
  assert.match((await start(3)).error, /fixture/);
  assert.equal(read().tasks[3].launchBlock.agent, 'claude');
  saveMcp({ enabled: false, autoEnable: false });
  assert.match((await start(4)).error, /자동 활성화가 허용되지 않음/);
  saveMcp({ enabled: false, autoEnable: true, command: path.join(cwd, 'missing.exe') });
  assert.match((await start(5)).error, /초기 연결에 실패/);
  assert.equal(unifiedVault.getState().mcps[0].enabled, false);
  saveMcp({ enabled: false, autoEnable: true });
  fs.unlinkSync(path.join(accountHome, 'config.toml'));
  fs.mkdirSync(path.join(accountHome, 'config.toml'));
  assert.match((await start(6)).error, /CLI 설정에 연결하지 못함/);
  assert.equal(unifiedVault.getState().mcps[0].enabled, false);
  unifiedVault.deleteMcp(name);
  assert.match((await start(7)).error, /Vault에 등록되지 않음/);
  assert.deepEqual(launches, ['codex', 'codex', 'codex']);
  assert.equal(read().agent, 'agy');
  assert.deepEqual(read().tasks.map((task) => task.agent), tasks.map(({ agent }) => agent));
  assert.ok(read().tasks.slice(3).every((task) => task.launchBlock && !task.lastRun && task.stage === 'planned'));
  assert.deepEqual(findReadyTasks(read()), []);
});
