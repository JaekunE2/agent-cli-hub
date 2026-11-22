const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readPlan, parseProgressLine, spawnCli, cliModelEffortArgs } = require('../project-plan');
const { validate } = require('../project-validation');
const accounts = require('../project-accounts');

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
