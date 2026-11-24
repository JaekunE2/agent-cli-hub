const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const recover = require('../terminal-recovery');
const { createTermManager, sessionStartupBlock, dispatchTerminalPrompt } = require('../term-manager');
const id = 'aaaaaaaa-bbbb-cccc-dddd-000000000001';

test('managed PTY launch replaces TERM=dumb and keeps valid terminal types', async (t) => {
  const sent = [];
  t.mock.method(globalThis, 'fetch', async (url, request) => {
    assert.match(url, /\/spawn$/);
    sent.push(JSON.parse(request.body).env.TERM);
    return { json: async () => ({ ok: true }) };
  });
  const hub = createTermManager({ baseDir: os.tmpdir(), port: 7777, cleanModelEffort: () => ({}) });
  for (const TERM of ['dumb', '', 'xterm']) {
    const term = hub.createTerm({ cmd: 'codex.exe', env: { TERM }, projectTask: { projectId: 'p', taskId: 't' } });
    assert.deepEqual(await term.spawnResult, { ok: true });
  }
  assert.deepEqual(sent, ['xterm-256color', 'xterm-256color', 'xterm']);
});

test('Codex hook settings are not mistaken for a ready prompt', () => {
  const cwd = os.tmpdir();
  const manager = createTermManager({ baseDir: cwd, CA: { MAIN: cwd }, index: { docs: new Map() }, stripAnsi: (text) => text });
  const lines = ['SessionStart hooks', '› [ ]  2  Loading ponytail mode...', 'space/enter toggle · esc back'];
  const term = { vt: { buffer: { active: { get length() { return lines.length; }, getLine: (i) => ({ translateToString: () => lines[i] }) } } } };
  assert.equal(sessionStartupBlock(lines.join('\n')), 'hooks-menu');
  assert.equal(manager.inputReady(term), false);
  assert.equal(sessionStartupBlock('Running SessionStart hooks…'), 'hooks-running');
  lines.push('› Ask anything');
  assert.equal(manager.inputReady(term), true);
});

test('termInfo reports a Codex project draft only while the paste badge is in the composer', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => ({ json: async () => ({ ok: true }) }));
  const manager = createTermManager({ baseDir: os.tmpdir(), port: 7777, cleanModelEffort: () => ({}), stripAnsi: (text) => text });
  const term = manager.createTerm({ cmd: 'codex.exe', projectTask: { projectId: 'p', taskId: 't' } });
  await term.spawnResult;
  const screen = (text) => new Promise((resolve) => term.vt.write(text, resolve));
  await screen('› Ask Codex to do anything');
  assert.equal(manager.termInfo(term).inputDraft, false);
  await screen('\r\n› [Pasted Content 200 chars]');
  assert.equal(manager.termInfo(term).inputDraft, true);
  await screen('\r\n› Ask Codex to do anything');
  assert.equal(manager.termInfo(term).inputDraft, false);
  term.exited = 0;
  assert.equal(manager.termInfo(term).inputDraft, false);
});

test('Codex project dispatch retries Enter without repasting and preserves an existing draft', async () => {
  const text = 'Complete the task.\n' + 'x'.repeat(1000);
  const paste = `\x1b[200~${text}\x1b[201~`;
  const ready = '› Ask Codex to do anything';
  const draft = ['› [Pasted Content 1019 chars]', ...Array(17).fill('  continued prompt'), '  GPT-medium · D:\\repo'].join('\n');
  const term = { id: '1', exited: null };
  let screen = ready;
  const writes = [];
  const hub = {
    readTerm: (_term, n) => screen.split('\n').slice(-n),
    inputReady: () => screen === ready,
    codexStatus: () => screen === 'working' ? 'busy' : 'idle',
    waitFor: async (check) => check(),
    sleep: async () => {},
    ptyPost: async (_id, _path, { data }) => {
      writes.push(data);
      if (data === paste) screen = draft;
      if (writes.length === 3) screen = 'working';
      return { ok: true };
    },
  };
  assert.equal(await dispatchTerminalPrompt(hub, term, text), true);
  assert.deepEqual(writes, [paste, '\r', '\r']);

  screen = draft;
  await assert.rejects(dispatchTerminalPrompt(hub, term, text), /제출되지 않은/);
  assert.equal(writes.length, 3);

  hub.ptyPost = async (_id, _path, { data }) => {
    writes.push(data);
    screen = data === '\r' ? ready : draft;
    return { ok: true };
  };
  await assert.rejects(dispatchTerminalPrompt(hub, term, text, { submitDraft: true }), /실행을 시작했다는 신호가 없습니다/);
  assert.deepEqual(writes.slice(3), ['\r']);

  const ending = 'Verify all output and document the final test results in the project reference folder.';
  screen = '› ' + ending.replace('project reference', 'project\n  reference');
  hub.ptyPost = async (_id, _path, { data }) => { writes.push(data); screen = 'working'; return { ok: true }; };
  assert.equal(await dispatchTerminalPrompt(hub, term, `Earlier lines are scrolled off.\n${ending}`, { submitDraft: true }), true);
  assert.equal(writes.at(-1), '\r');
});

test('Codex recovery restores the conversation without sending a saved prompt', () => {
  assert.deepEqual(recover(['resume', id, '계속 진행해']), ['resume', id]);
  assert.deepEqual(recover(['/c', 'codex.cmd', '--no-daemon', 'resume', '--last', '계속 진행해'], id),
    ['/c', 'codex.cmd', '--no-daemon', 'resume', id]);
  assert.deepEqual(recover(['handoff prompt']), []);
  assert.deepEqual(recover(['resume', '--last', '계속 진행해']), ['resume', '--last']);
  assert.deepEqual(recover(['--dangerously-bypass-approvals-and-sandbox', 'resume', id, '계속 진행해']),
    ['--dangerously-bypass-approvals-and-sandbox', 'resume', id]);
});

test('Codex branches in the same folder keep separate terminal session IDs', () => {
  const start = Date.UTC(2026, 10, 23, 3, 41);
  const sid = (at) => {
    const hex = at.toString(16).padStart(12, '0');
    return `${hex.slice(0, 8)}-${hex.slice(8)}-7000-8000-000000000000`;
  };
  const parentId = sid(start + 5000);
  const childId = sid(start + 15000);
  const cwd = os.tmpdir();
  const docs = new Map([
    [childId, { id: childId, agent: 'codex', cwd, mtime: start + 30_000 }],
    [parentId, { id: parentId, agent: 'codex', cwd, mtime: start + 7000 }],
  ]);
  const manager = createTermManager({ baseDir: cwd, CA: { MAIN: cwd }, index: { docs, get: (id) => docs.get(id) } });
  const parent = { id: '12', cwd, meta: { cmd: 'codex.exe', spawnedAt: start } };
  const child = { id: '13', cwd, meta: { cmd: 'codex.exe', spawnedAt: start + 10_000 } };
  manager.terms.set(parent.id, parent);
  manager.terms.set(child.id, child);

  assert.equal(manager.termDocOf(parent).id, parentId);
  assert.equal(manager.termSessionId(parent), parentId);
  assert.equal(manager.termSessionId(child), childId);

  docs.get(parentId).mtime = start + 40_000;
  assert.equal(manager.termSessionId(child), childId);
  docs.delete(parentId);
  assert.equal(manager.termDocOf(parent), null);
  parent.meta.args = ['resume', parentId];
  assert.equal(manager.termSessionId(parent), parentId);
});
