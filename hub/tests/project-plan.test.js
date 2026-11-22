const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readPlan, parseProgressLine, spawnCli, cliModelEffortArgs } = require('../project-plan');
const { validate, inferTaskKind } = require('../project-validation');
const { parseCodexJsonl, parseClaudeJson, parseAgyJson } = require('../task-subchat');
const projectsStore = require('../projects');
const accounts = require('../project-accounts');
const fs = require('fs');
const os = require('os');
const path = require('path');

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
