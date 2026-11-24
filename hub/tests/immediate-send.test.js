const test = require('node:test');
const assert = require('node:assert/strict');
const { PTY_KEYS, dispatchImmediatePrompt } = require('../immediate-send');
const { createSessionRoutes } = require('../routes-sessions');
const { sessionStartupBlock } = require('../term-manager');
const { prepareProjectPrompt } = require('../project-prompt');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const noopSleep = () => Promise.resolve();

test('long Windows project instructions keep the original UTF-8 text behind a short input', { skip: process.platform !== 'win32' }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-project-prompt-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const text = '## 작업 기준\n' + '한글과 줄바꿈을 유지해야 합니다.\n'.repeat(300);
  const input = prepareProjectPrompt(dir, text, 'codex.exe');
  const file = input.match(/"([^"]+)"/)[1];
  assert.equal(fs.readFileSync(file, 'utf8'), text);
  assert.ok(Buffer.byteLength(input) < 1000);
  assert.equal(prepareProjectPrompt(dir, text, 'codex.exe'), input);
  assert.equal(prepareProjectPrompt(dir, 'short prompt', 'codex.exe'), 'short prompt');
});

test('remote console resubmits an unchanged Codex draft without pasting it twice', async () => {
  const text = 'Check the project';
  const writes = [];
  const { handleSessionRoutes } = createSessionRoutes({
    PTY_KEYS, consoleInputAt: new Map(), sleep: noopSleep, consoleSubmitDelay: () => 0,
    waitFor: async (check) => check(),
    helperCall: async ({ op, keys, text: payload }) => {
      if (op === 'read') {
        const screen = writes.length === 3 ? '• Working (esc to interrupt)' : writes.length ? '› [Pasted Content 17 chars]' : '› Ask Codex to do anything';
        return { ok: true, lines: [screen] };
      }
      writes.push(payload || keys[0]);
      return { ok: true };
    },
  });
  await handleSessionRoutes('/api/console/send', null, { method: 'POST' }, null,
    async () => ({ pid: 12, text, submit: true }),
    (_res, status, payload) => { assert.equal(status, 200, payload.error); assert.equal(payload.ok, true); }, () => true);
  assert.deepEqual(writes, [text, 'enter', 'enter']);
});

test('chat submission sends multiline Codex text once and retries only Enter', async () => {
  const input = 'first line\nsecond line';
  const term = { id: '1', exited: null };
  const writes = [];
  const hub = {
    terms: new Map([[term.id, term]]), isCodexTerm: () => true, touchUserInput() {},
    readTerm: () => [writes.length && writes.length < 3 ? '› [Pasted Content 22 chars]' : '› Ask Codex to do anything'],
    codexStatus: () => writes.length === 3 ? 'busy' : 'idle',
    waitFor: async (check) => check(), sleep: noopSleep,
    ptyPost: async (_id, _path, body) => { writes.push(body.data); return { ok: true }; },
  };
  const { handleSessionRoutes } = createSessionRoutes(hub);
  await handleSessionRoutes('/api/term/send', null, { method: 'POST' }, null, async () => ({ id: term.id, text: input, submit: true }),
    (_res, status, payload) => { assert.equal(status, 200); assert.equal(payload.ok, true); }, () => true);
  assert.deepEqual(writes, [`\x1b[200~${input}\x1b[201~`, '\r', '\r']);
});

test('chat from history waits for the resumed CLI before writing and leaves login untouched', async () => {
  const text = 'from history';
  const term = { id: '1', exited: null };
  const writes = [];
  let lines = ['Starting Codex'];
  const hub = {
    terms: new Map([[term.id, term]]), isCodexTerm: () => true, touchUserInput() {},
    readTerm: () => lines, inputReady: () => lines[0].startsWith('›'), sleep: noopSleep,
    codexStatus: () => writes.length === 2 ? 'busy' : 'idle',
    waitFor: async (check, timeout) => {
      if (timeout === 45000 && !(await check())) {
        assert.deepEqual(writes, []);
        lines = ['› Ask Codex to do anything'];
      }
      return check();
    },
    ptyPost: async (_id, _path, { data }) => {
      writes.push(data);
      lines = data === '\r' ? ['Esc to interrupt'] : ['› ' + text];
      return { ok: true };
    },
  };
  const { handleSessionRoutes } = createSessionRoutes(hub);
  const send = async (expected) => handleSessionRoutes('/api/term/send', null, { method: 'POST' }, null,
    async () => ({ id: term.id, text, submit: true, waitForReady: true }),
    (_res, status, payload) => assert.equal(status, expected, payload.error), () => true);
  await send(200);
  assert.deepEqual(writes, [`\x1b[200~${text}\x1b[201~`, '\r']);
  lines = ['Sign in with ChatGPT'];
  await send(409);
  assert.equal(writes.length, 2);
});

test('project restart waits for explicit CLI confirmation and resumes the same task', async () => {
  const prompts = {
    codex: ['Do you trust the files in this folder?'],
    claude: ['❯ 1. Yes, I trust this folder', '  2. No, exit'],
    agy: ['Sign in with Google'],
  };
  for (const [agent, prompt] of Object.entries(prompts)) {
    const projectTask = { projectId: 'p', taskId: 't' };
    const term = { id: '12', exited: null, meta: { projectTask }, spawnResult: Promise.resolve({ ok: true }) };
    const terms = new Map([[term.id, term]]);
    let project = { id: 'p', cwd: process.cwd(), agent, tasks: [{ id: 't', agent, account: '', stage: 'doing', reviewPaused: true, title: 'Complete task' }] };
    let lines = prompt, busy = false;
    const writes = [];
    let allow;
    const confirmation = new Promise((resolve) => { allow = resolve; });
    const hub = {
      terms, deletingProjects: new Set(), projectAgents: Object.keys(prompts), ensureProjectDir() {},
      projects: { list: () => [project], save: (value) => { project = value; } },
      projectAccounts: { resolve: () => ({}) }, agySwap: { available: () => false }, agyExe: () => 'agy',
      agentOf: () => agent, cliModelEffortArgs: () => [], codexLaunch: () => ({ cmd: 'codex.exe', args: [] }), fingerprint: (x) => x,
      termInfo: () => ({ id: term.id, startupBlock: sessionStartupBlock(lines.join('\n')) }),
      readTerm: () => lines, stripAnsi: (x) => x, agyStatus: () => busy ? 'busy' : 'idle', inputReady: () => !sessionStartupBlock(lines.join('\n')),
      rememberProjectTerm() {}, forgetTerm: (value) => terms.delete(value.id),
      codexStatus: () => busy ? 'busy' : 'idle', claudeStatus: () => busy ? 'busy' : 'idle',
      sleep: noopSleep,
      waitFor: async (check, timeout) => { if (timeout === 300000) await confirmation; return check(); },
      ptyPost: async (_id, endpoint, { data }) => {
        if (endpoint === '/meta') return { ok: true };
        writes.push(data);
        if (data === '\r') { busy = true; lines = ['Thinking...', 'Esc to cancel']; }
        else lines = ['› ' + data.replace(/^\x1b\[200~|\x1b\[201~$/g, '')];
        return { ok: true };
      },
    };
    const { handleSessionRoutes } = createSessionRoutes(hub);
    const response = (_res, status, payload) => { assert.equal(status, 200); assert.equal(payload.restarted, true); };
    await handleSessionRoutes('/api/projects/start', null, { method: 'POST' }, null, async () => ({ ...projectTask, retry: true }), response, () => true);
    assert.deepEqual(writes, [], `${agent} must wait without sending an approval key`);
    assert.equal(project.tasks[0].reviewPaused, false);
    lines = ['› Type a message'];
    allow();
    assert.equal(await term._projectDispatchResult, undefined);
    assert.equal(writes.length, 2, agent);
    assert.match(writes[0], /Complete task/);
    assert.equal(writes[1], '\r');
    await handleSessionRoutes('/api/term/close', null, { method: 'POST' }, null, async () => ({ id: term.id }),
      (_res, status, payload) => { assert.equal(status, 200); assert.equal(payload.ok, true); }, () => true);
    assert.equal(project.tasks[0].reviewPaused, true);
    assert.equal(terms.size, 0);
    assert.equal(writes.length, 2);
  }
});

test('restarting a task already running clears the stale error without sending input', async () => {
  const projectTask = { projectId: 'p', taskId: 't' };
  const term = { id: '12', exited: null, meta: { projectTask } };
  let project = { id: 'p', cwd: process.cwd(), agent: 'codex', tasks: [
    { id: 't', stage: 'doing', title: 'Work', reviewPaused: true, reviewStatus: 'error', reviewNote: 'Old error', retryCount: 2 },
  ] };
  const { handleSessionRoutes } = createSessionRoutes({
    terms: new Map([[term.id, term]]), deletingProjects: new Set(),
    projects: { list: () => [project], save: (value) => { project = value; } },
    agentOf: () => 'codex', termInfo: () => ({ id: term.id, status: 'busy' }),
  });
  await handleSessionRoutes('/api/projects/start', null, { method: 'POST' }, null, async () => ({ ...projectTask, retry: true }),
    (_res, status, payload) => { assert.equal(status, 200); assert.equal(payload.alreadyRunning, true); }, () => true);
  assert.deepEqual(project.tasks[0], { id: 't', stage: 'doing', title: 'Work', reviewPaused: false, reviewStatus: '', reviewNote: '', retryCount: 0 });
  assert.equal(term._projectBusySeen, true);
});

test('project restart opens a clean terminal and preserves an unrelated draft', async () => {
  const projectTask = { projectId: 'p', taskId: 't' };
  const existing = { id: '1', exited: null, meta: { projectTask } };
  const fresh = { id: '2', exited: null, spawnResult: Promise.resolve({ ok: true }) };
  const terms = new Map([[existing.id, existing]]);
  const project = { id: 'p', cwd: process.cwd(), agent: 'codex', tasks: [{ id: 't', title: 'Work', stage: 'doing' }] };
  const { handleSessionRoutes } = createSessionRoutes({
    terms, deletingProjects: new Set(), projectAgents: ['codex'],
    projects: { list: () => [project], save() {} },
    agentOf: () => 'codex', termInfo: (t) => ({ id: t.id, status: 'idle' }),
    readTerm: () => ['› An unrelated draft'], ensureProjectDir() {},
    projectAccounts: { resolve: () => ({}) }, agySwap: { available: () => false },
    cliModelEffortArgs: () => [], codexLaunch: () => ({ cmd: 'codex.exe', args: [] }), fingerprint: (x) => x,
    createTerm: () => { terms.set(fresh.id, fresh); return fresh; },
  });
  await handleSessionRoutes('/api/projects/start', null, { method: 'POST' }, null,
    async () => ({ ...projectTask, retry: true, autoDispatch: false }),
    (_res, status, payload) => { assert.equal(status, 200, payload.error); assert.equal(payload.id, fresh.id); }, () => true);
  assert.equal(terms.get(existing.id), existing);
});

test('sending from the Hub exits Codex history search before typing, once', async () => {
  const prompt = '데스크톱 기준으로 다시 확인해 주세요';
  const normal = ['reverse-i-search: previous search in scrollback', '› Ask Codex to do anything'];
  for (const active of [true, false]) {
    for (const target of ['term', 'console']) {
      let lines = active ? ['› Ask Codex to do anything', '  reverse-i-search: no match', ''] : normal;
      let busy = false;
      const writes = [];
      const write = (data) => {
        writes.push(data);
        if (data === '\x1b') lines = normal;
        else if (data === '\r') { busy = true; lines = ['Esc to interrupt', '› Ask Codex to do anything']; }
        else lines = ['› ' + prompt];
        return { ok: true };
      };
      const { handleSessionRoutes } = createSessionRoutes({
        terms: new Map([['12', { id: '12', exited: null, proc: { write } }]]),
        isCodexTerm: () => true, readTerm: () => lines, touchUserInput: () => {},
        codexStatus: () => busy ? 'busy' : 'idle', waitFor: async (check) => check(),
        consoleInputAt: new Map(), sleep: noopSleep, consoleSubmitDelay: () => 0, PTY_KEYS,
        ptyPost: async (_id, _path, { data }) => write(data),
        helperCall: async ({ op, keys, text }) => op === 'read' ? { ok: true, lines }
          : write(text || PTY_KEYS[keys[0]]),
      });
      const body = async () => ({ id: '12', pid: 12, text: prompt, submit: true });
      const send = (_res, status, payload) => { assert.equal(status, 200, payload.error); assert.equal(payload.ok, true); };
      await handleSessionRoutes(`/api/${target}/send`, null, { method: 'POST' }, null, body, send, () => true);
      const paste = target === 'term' ? `\x1b[200~${prompt}\x1b[201~` : prompt;
      assert.deepEqual(writes, active ? ['\x1b', paste, '\r'] : [paste, '\r']);
    }
  }
});

test('AGY sends Alt+M (\\x1bm) when alt+m to send immediately is visible without duplicating text', async () => {
  const writes = [];
  const res = await dispatchImmediatePrompt({
    cli: 'agy',
    isBusy: () => true,
    readNormLines: () => 'Queued: 후속 질문 보류 중\nalt+m to send immediately',
    write: (d) => writes.push(d),
    sleep: noopSleep,
    text: '후속 질문 보류 중',
    resendIfMissing: true,
  });
  assert.equal(res.handled, true);
  assert.equal(res.result.flushedQueued, true);
  assert.deepEqual(writes, [PTY_KEYS['alt+m']]);
  assert.equal(writes.includes('후속 질문 보류 중'), false);
});

test('Codex steers queued prompt using Tab without duplicating text', async () => {
  const writes = [];
  const res = await dispatchImmediatePrompt({
    cli: 'codex',
    isBusy: () => true,
    readNormLines: () => 'queued: 확인 부탁\nTab to steer',
    write: (d) => writes.push(d),
    sleep: noopSleep,
    text: '확인 부탁',
    resendIfMissing: true,
  });
  assert.equal(res.handled, true);
  assert.equal(res.result.steered, true);
  assert.deepEqual(writes, [PTY_KEYS.tab]);
});

test('Claude flushes queued prompt with Esc then Enter when up-to-edit indicator is present', async () => {
  const writes = [];
  const res = await dispatchImmediatePrompt({
    cli: 'claude',
    isBusy: () => true,
    readNormLines: () => (writes.includes(PTY_KEYS.esc) ? '> 후속 작업 요청' : '후속 작업 요청\nPress up to edit'),
    write: (d) => writes.push(d),
    sleep: noopSleep,
    text: '후속 작업 요청',
    resendIfMissing: true,
  });
  assert.equal(res.handled, true);
  assert.equal(res.result.flushedQueued, true);
  assert.deepEqual(writes, [PTY_KEYS.esc, '\r']);
});

test('AGY already-running prompt returns alreadyRecognized without typing again', async () => {
  const writes = [];
  const res = await dispatchImmediatePrompt({
    cli: 'agy',
    isBusy: () => true,
    readNormLines: (n) => (n <= 12 ? 'Thinking...\nRunning tool read_file' : '> 이미 실행 시작한 질문\nThinking...\nRunning tool read_file'),
    write: (d) => writes.push(d),
    sleep: noopSleep,
    text: '이미 실행 시작한 질문',
    resendIfMissing: true,
  });
  assert.equal(res.handled, true);
  assert.equal(res.result.alreadyRecognized, true);
  assert.deepEqual(writes, []);
});
