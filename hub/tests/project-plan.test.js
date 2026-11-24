const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readPlan, parseProgressLine, spawnCli, cliModelEffortArgs, inspectWorkspace, buildPlanPrompt, buildSubtaskPrompt } = require('../project-plan');
const { scanFloorplan } = require('../workspace-floorplan');
const { validate, inferTaskKind } = require('../project-validation');
const { parseCodexJsonl, parseClaudeJson, parseAgyJson } = require('../task-subchat');
const projectsStore = require('../projects');
const accounts = require('../project-accounts');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('version history captures starting and final Git commits and keeps ordinary tasks separate', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-version-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cwd = path.join(dir, 'workspace');
  fs.mkdirSync(cwd);
  const git = (...args) => require('child_process').execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('init', '-q');
  const file = path.join(cwd, 'tracked.txt');
  fs.writeFileSync(file, 'initial');
  git('add', 'tracked.txt');
  const commit = (message) => git('-c', 'user.name=Hub Test', '-c', 'user.email=hub@example.test', 'commit', '-qam', message);
  commit('base');
  const base = git('rev-parse', 'HEAD');
  const projects = projectsStore(path.join(dir, 'projects.json'));
  let project = projects.save({ name: 'Demo', cwd, goal: 'Original', termIds: [], tasks: [] });
  const { handleProjectRoutes } = require('../routes-projects').createProjectRoutes({ baseDir: dir, config: {}, projects, scanFloorplan });
  const post = async (draft) => {
    let response;
    await handleProjectRoutes('/api/projects', new URL('http://test/api/projects'), { method: 'POST' }, null, async () => draft,
      (_res, code, payload) => { response = { code, ...payload }; }, () => true);
    return response;
  };
  const task = { title: 'Task', detail: '', termId: '', after: [] };
  project = (await post({ ...project, versions: [{ number: '1.1.0', goal: 'Improve' }], tasks: [
    { ...task, id: 'first', stage: 'done' }, { ...task, id: 'version', stage: 'doing', version: '1.1.0' },
    { ...task, id: 'child', stage: 'done', parentId: 'version' },
  ] })).project;
  assert.equal(project.versions[0].baseCommit, base);
  assert.deepEqual(project.tasks.map((x) => x.version), ['', '1.1.0', '1.1.0']);
  const finish = () => post({ id: project.id, revision: project.revision, finalizeVersion: '1.1.0' });
  assert.equal((await finish()).code, 400);
  project = (await post({ ...project, tasks: project.tasks.map((x) => ({ ...x, stage: 'done' })) })).project;
  fs.writeFileSync(file, 'changed');
  assert.equal((await finish()).code, 400);
  const codeFile = path.join(cwd, 'version.js');
  fs.writeFileSync(codeFile, 'module.exports = 1;');
  git('add', 'version.js');
  commit('complete version');
  project = (await finish()).project;
  assert.equal(project.versions[0].completedCommit, git('rev-parse', 'HEAD'));
  assert.equal((await finish()).project.revision, project.revision);
  fs.unlinkSync(codeFile);
  let structure;
  const url = new URL(`http://test/api/projects/floorplan?id=${project.id}&version=1.1.0`);
  await handleProjectRoutes(url.pathname, url, { method: 'GET' }, null, null,
    (_res, code, payload) => { structure = { code, ...payload }; }, () => true);
  assert.equal(structure.code, 200, structure.error);
  assert.deepEqual(structure.floorplan.nodes.map((node) => node.relPath), ['version.js']);
  assert.equal(fs.existsSync(codeFile), false);
});

test('follow-up plan separates the new goal from existing work', () => {
  const prompt = buildPlanPrompt({ name: 'App', goal: 'Add CSV export', existingPlan: {
    goal: 'Publish a dashboard', tasks: [{ title: 'Build the dashboard', stage: 'done' }],
  } }, { isExistingProject: false });
  assert.match(prompt, /do not duplicate/);
  assert.match(prompt, /Add CSV export/);
  assert.match(prompt, /Build the dashboard/);
});

test('local versions keep a reusable snapshot and route tasks to the restored files', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-local-version-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cwd = path.join(dir, 'workspace');
  fs.mkdirSync(path.join(cwd, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'notes.txt'), 'first draft');
  const projects = projectsStore(path.join(dir, 'projects.json'));
  let project = projects.save({ name: 'Local', cwd, goal: 'Original', termIds: [], tasks: [] });
  const { handleProjectRoutes } = require('../routes-projects').createProjectRoutes({
    baseDir: dir, config: { versionStorageDir: path.join(dir, 'versions') }, projects,
  });
  const post = async (action) => {
    let response;
    const draft = { id: project.id, revision: project.revision, ...action };
    await handleProjectRoutes('/api/projects', new URL('http://test/api/projects'), { method: 'POST' }, null, async () => draft,
      (_res, code, payload) => { response = { code, ...payload }; }, () => true);
    assert.equal(response.code, 200, response.error);
    project = response.project;
  };
  const { versionWorkspace } = require('../version-files');
  await post({ snapshotVersion: '1.0.0' });
  assert.equal(versionWorkspace(project, '1.0.0'), '');
  fs.writeFileSync(path.join(cwd, 'notes.txt'), 'original changed');
  await post({ restoreVersion: '1.0.0' });
  const workspace = versionWorkspace(project, '1.0.0');
  assert.equal(fs.readFileSync(path.join(workspace, 'notes.txt'), 'utf8'), 'first draft');
  assert.equal(fs.existsSync(path.join(workspace, 'node_modules')), false);
  fs.writeFileSync(path.join(workspace, 'notes.txt'), 'version changed');
  await post({ restoreVersion: '1.0.0' });
  assert.equal(versionWorkspace(project, '1.0.0'), workspace);

  const launches = [];
  const sessionHub = {
    config: {}, projects, index: { get: () => ({ cwd }) }, deletingProjects: new Set(),
    terms: new Map(), projectAgents: ['codex'], cliModelEffortArgs: () => [], fingerprint: () => '',
    projectAccounts: { resolve: () => ({}) }, codexLaunch: () => ({ cmd: 'codex', args: [] }),
    ensureProjectDir: () => {}, termInfo: (term) => term,
    createTerm: (options) => { launches.push(options.cwd); return { id: '1', spawnResult: Promise.resolve({}) }; },
  };
  project = projects.save({ ...project, tasks: [{ id: 'task', title: 'Work', detail: '', termId: '', after: [], stage: 'planned', version: '1.0.0' }] });
  await post({ snapshotVersion: '1.0.1', sourceVersion: '1.0.0' });
  const { runProjectAutopilot } = require('../project-autopilot');
  require('../routes-sessions').createSessionRoutes(sessionHub);
  assert.ok((await sessionHub.startProjectTaskById(project.id, 'task', { resume: 'from-original', autoDispatch: false })).error);
  project = projects.save({ ...project, autopilot: true, maxConcurrent: 3, tasks: [
    ...project.tasks, { ...project.tasks[0], id: 'second' }, { ...project.tasks[0], id: 'unopened', version: '1.0.1' },
  ] });
  assert.equal((await runProjectAutopilot(sessionHub, project.id, { autoDispatch: false })).started.length, 1);
  assert.deepEqual(launches, [workspace]);
  assert.equal((await runProjectAutopilot(sessionHub, project.id, { autoDispatch: false })).started.length, 0);
  project = projects.list()[0];
  await post({ restoreVersion: '1.0.1' });
  assert.equal(fs.readFileSync(path.join(versionWorkspace(project, '1.0.1'), 'notes.txt'), 'utf8'), 'version changed');
  assert.equal(fs.readFileSync(path.join(cwd, 'notes.txt'), 'utf8'), 'original changed');
});

test('spawnCli reports its configured deadline when a CLI runs too long', async () => {
  await assert.rejects(spawnCli(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 80 }),
    /CLI 실행 제한 시간\(1초\)/);
});

test('inspectWorkspace detects existing project markers and builds workspace summary', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-ws-inspect-'));
  try {
    assert.equal(inspectWorkspace(dir).isExistingProject, false);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'existing-app', scripts: { dev: 'node index.js' }, dependencies: { ws: '^8.0.0' } }));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'index.js'), 'console.log(1);');
    const info = inspectWorkspace(dir);
    assert.equal(info.isExistingProject, true);
    assert.ok(info.markers.includes('Node.js'));
    assert.ok(info.summaryText.includes('existing-app'));
    assert.ok(info.summaryText.includes('src/index.js'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('scanFloorplan extracts layers, API endpoints, frontend-backend connections, and health issues', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-floorplan-'));
  try {
    fs.mkdirSync(path.join(dir, 'public'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'server'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'server', 'routes.js'), [
      '// Main API routes',
      'const db = require("./store");',
      'const OPENAI_API_KEY = "sk-proj-1234567890abcdef1234567890abcdef";',
      'app.get("/api/items", (req, res) => res.json(db.list()));',
    ].join('\n'));
    fs.writeFileSync(path.join(dir, 'server', 'store.js'), 'exports.list = () => [];\n');
    fs.writeFileSync(path.join(dir, 'public', 'app.js'), 'fetch("/api/items").then(r => r.json());\n');

    const fp = scanFloorplan(dir);
    assert.equal(fp.exists, true);
    assert.equal(fp.stats.files, 3);
    assert.equal(fp.stats.endpoints, 1);
    assert.equal(fp.stats.matchedCalls, 1);
    assert.ok(fp.edges.some((e) => e.from === 'public/app.js' && e.to === 'server/routes.js' && e.kind === 'api'));
    assert.ok(fp.edges.some((e) => e.from === 'server/routes.js' && e.to === 'server/store.js' && e.kind === 'import'));
    assert.ok(fp.health.criticalCount >= 1); // detected sk-proj-... secret
    assert.ok(fp.health.issues.some((x) => x.severity === 'warn')); // unauth endpoint warning
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('inferTaskKind classifies planning, development, test/verification, and ops/docs tasks accurately', () => {
  assert.equal(inferTaskKind('요구사항 분석 및 아키텍처 설계', ''), 'plan');
  assert.equal(inferTaskKind('로그인 API 및 화면 구현', ''), 'dev');
  assert.equal(inferTaskKind('통합 테스트 및 완료 기준 검증', ''), 'test');
  assert.equal(inferTaskKind('운영 배포 및 README 문서 정리', ''), 'ops');
});

test('task-subchat parsers extract sessionId, replies, tool hints, and tokens across Codex, Claude, and AGY', () => {
  const codexOut = [
    JSON.stringify({ type: 'thread.started', thread_id: '01a11111-2222-3333-4444-555555555555' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'npm test' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '서브 개발 수정 완료했습니다.' } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1500, cached_input_tokens: 500, output_tokens: 300 } }),
  ].join('\n');
  const cx = parseCodexJsonl(codexOut);
  assert.equal(cx.sessionId, '01a11111-2222-3333-4444-555555555555');
  assert.ok(cx.reply.includes('⚙ npm test'));
  assert.ok(cx.reply.includes('서브 개발 수정 완료했습니다.'));
  assert.equal(cx.tokens.total, 1800);

  const cl = parseClaudeJson(JSON.stringify({ session_id: 'cl-sid-1', result: 'Claude 응답', usage: { input_tokens: 200, output_tokens: 100 } }));
  assert.equal(cl.sessionId, 'cl-sid-1');
  assert.equal(cl.reply, 'Claude 응답');
  assert.equal(cl.tokens.total, 300);

  const ag = parseAgyJson(JSON.stringify({ conversation_id: 'ag-sid-1', response: 'AGY 응답', usage: { input_tokens: 400, output_tokens: 150, total_tokens: 550 } }));
  assert.equal(ag.sessionId, 'ag-sid-1');
  assert.equal(ag.reply, 'AGY 응답');
  assert.equal(ag.tokens.total, 550);

  // Sub-chat persistence per (projectId, taskId)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-subchat-store-'));
  try {
    const s = projectsStore(path.join(dir, 'projects.json'));
    const p = s.save({ name: 'P', cwd: 'D:\\p', goal: 'G', termIds: [], tasks: [{ id: 't1', title: '구현', detail: '', stage: 'planned', termId: '', after: [] }] });
    s.saveSubChat(p.id, 't1', { id: 'c1', title: '첫 채팅', agent: 'codex', sessionId: cx.sessionId, messages: [{ role: 'user', text: '안녕' }, { role: 'assistant', text: '반갑습니다' }] });
    assert.equal(s.listSubChats(p.id, 't1').length, 1);
    assert.equal(s.listSubChats(p.id, 't1')[0].messages.length, 2);
    assert.equal(s.deleteSubChat(p.id, 't1', 'c1'), true);
    assert.equal(s.listSubChats(p.id, 't1').length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cliModelEffortArgs builds exact model and reasoning effort flags per CLI', () => {
  assert.deepEqual(cliModelEffortArgs('codex', 'gpt-6.1-sol', 'high'), ['-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort="high"']);
  assert.deepEqual(cliModelEffortArgs('claude', 'opus', 'max'), ['--model', 'opus', '--effort', 'max']);
  assert.deepEqual(cliModelEffortArgs('agy', 'gemini-4-neon-xhigh', 'xhigh'), ['--model', 'gemini-4-neon-xhigh', '--effort', 'xhigh']);
  assert.deepEqual(cliModelEffortArgs('agy', 'gemini-4-argon-high', 'medium'), ['--model', 'gemini-4-argon-medium', '--effort', 'medium']);
  assert.deepEqual(cliModelEffortArgs('agy', 'gemini-4-argon-high', 'xhigh'), ['--model', 'gemini-4-argon-high', '--effort', 'high']);
  assert.deepEqual(cliModelEffortArgs('cursor', 'foo', 'high'), []);
});

test('project validation persists model, effort, and parentId sub-tasks while rejecting invalid parent links', () => {
  const saved = validate({
    name: 'Demo', cwd: 'D:\\demo', goal: 'Goal', agent: 'codex', model: 'gpt-6.1-sol', effort: 'high', termIds: [],
    tasks: [
      { id: 't1', title: 'Parent', detail: 'Top', stage: 'planned', termId: '', after: [] },
      { id: 't2', title: 'Child', detail: 'Sub', stage: 'planned', parentId: 't1', model: 'opus', effort: 'max', agent: 'claude', termId: '', after: [] },
    ],
  });
  assert.equal(saved.model, 'gpt-6.1-sol');
  assert.equal(saved.effort, 'high');
  assert.equal(saved.tasks[1].parentId, 't1');
  assert.equal(saved.tasks[1].model, 'opus');
  assert.equal(saved.tasks[1].effort, 'max');
  assert.throws(() => validate({
    name: 'Demo', cwd: 'D:\\demo', goal: '', termIds: [],
    tasks: [{ id: 't1', title: 'Self', detail: '', stage: 'planned', parentId: 't1', termId: '', after: [] }],
  }));
  assert.throws(() => validate({
    name: 'Demo', cwd: 'D:\\demo', goal: '', termIds: [],
    tasks: [
      { id: 't1', title: 'A', detail: '', stage: 'planned', parentId: 't2', termId: '', after: [] },
      { id: 't2', title: 'B', detail: '', stage: 'planned', parentId: 't1', termId: '', after: [] },
    ],
  }));
});

test('generated work becomes cards with instructions and valid links', () => {
  const project = { name: 'Demo', cwd: 'D:\\demo', goal: 'Goal', agent: 'agy' };
  const raw = after => JSON.stringify({ structured_output: { tasks: [
    { title: 'Design', detail: 'Draw the design', after: [] },
    { title: 'Verify', detail: 'Check the design', after },
  ] } });
  const cards = readPlan(raw([1]), project);
  for (const agent of ['codex', 'claude', 'agy']) {
    const draft = { ...project, agent };
    assert.deepEqual(readPlan(raw([1]), draft).map((card) => card.agent), ['', '']);
    assert.deepEqual(readPlan(raw([1]), draft, { parentId: 'parent' }).map((card) => card.agent), ['', '']);
  }
  assert.equal(cards[1].detail, 'Check the design');
  assert.deepEqual(cards[1].after, [cards[0].id]);
  for (const after of [[2], [0], ['1']]) assert.throws(() => readPlan(raw(after), project));
});

test('spawnCli closes stdin immediately so CLIs reading stdin do not hang and streams progress', async () => {
  const seen = [];
  // Child script reads stdin until EOF, prints model/heading progress to stderr, and exits 0.
  // If stdin were left open as a pipe (like execFile), this would hang until timeout.
  const script = [
    'process.stdin.resume();',
    'process.stdin.on("end", () => {',
    '  console.error("model: gpt-test");',
    '  console.error("**Planning tasks**");',
    '  console.log("{\\"tasks\\":[]}");',
    '});',
  ].join(' ');
  const r = await spawnCli(process.execPath, ['-e', script], {
    cwd: process.cwd(),
    env: process.env,
    timeoutMs: 5000,
    onProgress: (ev) => seen.push(ev),
  });
  assert.equal(r.stdout.trim(), '{"tasks":[]}');
  assert.ok(seen.some((e) => e.stage.includes('gpt-test')));
  assert.ok(seen.some((e) => e.stage.includes('Planning tasks')));
  assert.equal(parseProgressLine('Reading additional input from stdin...'), null);
});

test('listed accounts expose only labels and resolve within their CLI', () => {
  const entries = accounts({
    claude: () => [], codex: () => [], codexEnv: () => ({}),
    agy: () => [{ id: 'a', label: 'AGY A', apiKey: () => 'fake-key' }],
  });
  assert.deepEqual(entries.list('agy'), [{ id: 'a', label: 'AGY A' }]);
  assert.deepEqual(entries.resolve('agy', 'a').env, { GEMINI_API_KEY: 'fake-key', GOOGLE_API_KEY: 'fake-key' });
  assert.throws(() => entries.resolve('codex', 'a'));
  assert.deepEqual(entries.resolve('agy', '').env, {});
});

test('buildPlanPrompt and buildSubtaskPrompt embed deepening rules automatically during initial design', () => {
  const p = buildPlanPrompt({ name: 'Demo', goal: '인증 개선' }, { isExistingProject: true, summaryText: 'server/auth.js' });
  assert.ok(p.includes('DO NOT DO MORE. DO IT DEEPER'));
  assert.ok(p.includes('[Primary Sources & Assumptions]'));
  assert.ok(p.includes('[Methods & Boundaries]'));
  assert.ok(p.includes('[Independent Validation]'));
  assert.ok(p.includes('server/auth.js'));

  const sp = buildSubtaskPrompt({ name: 'Demo', goal: '인증 개선' }, { title: '토큰 검증', detail: 'JWT 검증' }, { isExistingProject: false });
  assert.ok(sp.includes('DO NOT DO MORE. DO IT DEEPER'));
  assert.ok(sp.includes('토큰 검증'));
});
