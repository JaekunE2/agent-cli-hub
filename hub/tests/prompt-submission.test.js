const test = require('node:test');
const assert = require('node:assert/strict');
const { createSessionRoutes } = require('../routes-sessions');
const { dispatchTerminalPrompt } = require('../term-manager');
const { PTY_KEYS } = require('../immediate-send');

const message = 'Build and test this change.';
const ready = ['› Ask Codex to do anything'];
const draft = [`› ${message}`];
const running = ['Esc to interrupt', ...ready];
const hook = ['SessionStart hooks', 'space/enter toggle · esc back'];
const unknown = ['Do you want to use this API key?', '  Yes', '❯ No (recommended)', 'Enter to confirm · Esc to cancel'];

async function replay(target, frames, { resend = false, cli = 'codex', text = message, immediate = false,
  resendFrames } = {}) {
  const writes = [];
  const term = { id: '1', exited: null, meta: { projectTask: {} } };
  let offset = 0;
  const read = () => frames[Math.min(writes.length - offset, frames.length - 1)];
  const write = (data) => {
    writes.push(data.replace(/^\x1b\[200~|\x1b\[201~$/g, ''));
    return { ok: true };
  };
  term.proc = { write };
  const status = () => read().includes(running[0]) ? 'busy' : 'idle';
  const hub = {
    PTY_KEYS, terms: new Map([[term.id, term]]), agentOf: () => cli, isCodexTerm: () => cli === 'codex',
    readTerm: read, touchUserInput() {}, codexStatus: status, claudeStatus: status, agyStatus: status,
    waitFor: async (check) => check(), sleep: async () => {}, consoleSubmitDelay: () => 0, consoleInputAt: new Map(),
    ptyPost: async (_id, _op, { data }) => write(data),
    helperCall: async ({ op, keys, text }) => op === 'read' ? { ok: true, lines: read(), title: cli }
      : write(keys.length ? PTY_KEYS[keys[0]] : text),
  };
  let ok;
  if (target === 'automatic') {
    try { ok = await dispatchTerminalPrompt(hub, term, text); }
    catch { ok = false; }
  } else {
    const { handleSessionRoutes } = createSessionRoutes(hub);
    const send = (sendNow) => handleSessionRoutes(`/api/${target}/send`, null, { method: 'POST' }, null,
      async () => ({ id: term.id, pid: 1, text, submit: true, immediate: sendNow, resendIfMissing: resend }),
      (_res, _status, payload) => { ok = payload.ok; }, () => true);
    await send(immediate && !resendFrames);
    if (resend) {
      if (resendFrames) { frames = resendFrames; offset = writes.length; }
      await send(immediate);
    }
  }
  return { ok, writes };
}

test('AGY Send Now submits an existing draft and flushes the new queue without pasting', async () => {
  const frames = [[running[0], ...draft], [running[0], 'alt+m to send immediately', ...ready]];
  for (const target of ['term', 'console']) {
    assert.deepEqual(await replay(target, frames, { cli: 'agy', immediate: true }), { ok: true, writes: [PTY_KEYS.enter, PTY_KEYS['alt+m']] });
  }
});

test('Claude Send Now does not send Enter if a confirmation replaces the queue after Esc', async () => {
  const frames = [[running[0], 'Queued: ' + message, 'Press up to edit'], unknown];
  for (const target of ['term', 'console']) {
    assert.deepEqual(await replay(target, frames, { cli: 'claude', immediate: true, resend: true }), { ok: false, writes: [PTY_KEYS.esc] });
  }
});

test('Codex Send Now leaves an unrelated draft in the composer', async () => {
  const frames = [[running[0], `› ${message} Also deploy it.`, 'Tab to steer']];
  for (const target of ['term', 'console']) {
    assert.deepEqual(await replay(target, frames, { immediate: true, resend: true }), { ok: false, writes: [] });
  }
});

test('a new Send Now falls through to verified submission after provider-specific steering', async () => {
  const codex = [[...running, 'Tab to steer'], [running[0], ...draft, 'Tab to steer'], running];
  const claudeReady = ['❯'];
  const claudeRunning = [running[0], ...claudeReady];
  const claude = [claudeRunning, claudeReady, draft, claudeRunning];
  for (const target of ['term', 'console']) {
    assert.deepEqual(await replay(target, codex, { immediate: true }), { ok: true, writes: [message, PTY_KEYS.tab] });
    assert.deepEqual(await replay(target, claude, { cli: 'claude', immediate: true }), { ok: true, writes: [PTY_KEYS.esc, message, PTY_KEYS.enter] });
  }
});

for (const [name, frames, writes, ok] of [
  ['same draft remains after Enter', [ready, draft, draft, running], [message, '\r', '\r'], true],
  ['same draft is already present', [draft, running], ['\r'], true],
  ['different draft', [['› Build and test this change. Also deploy it.']], [], false],
  ['submitted on the first Enter', [ready, draft, running], [message, '\r'], true],
  ['unclassified confirmation after paste', [ready, unknown], [message], false],
  ['unclassified confirmation after Enter', [ready, draft, unknown], [message, '\r'], false],
  ['old busy status', [running, [running[0], ...draft], running], [message, '\r'], false],
]) {
  test(`all delivery paths agree when ${name}`, async () => {
    for (const target of ['term', 'automatic', 'console']) {
      assert.deepEqual(await replay(target, frames), { ok, writes }, target);
    }
  });
}

test('only the project hook settings menu is dismissed automatically in a managed session', async () => {
  for (const target of ['term', 'automatic']) {
    assert.deepEqual(await replay(target, [hook, ready, draft, running]), { ok: true, writes: ['\x1b', message, '\r'] });
  }
});

for (const [cli, frames, keys] of [
  ['agy', [[running[0], 'Queued: ' + message, 'alt+m to send immediately']], [PTY_KEYS['alt+m']]],
  ['claude', [[running[0], 'Queued: ' + message, 'Press up to edit'], draft, running], [PTY_KEYS.esc, PTY_KEYS.enter]],
  ['codex', [[running[0], 'Queued: ' + message, 'Tab to steer']], [PTY_KEYS.tab]],
]) {
  test(`${cli} Send Now steers the queue through managed and external routes`, async () => {
    for (const target of ['term', 'console']) {
      const result = await replay(target, [ready, draft, running], { cli, resend: true, immediate: true, resendFrames: frames });
      assert.deepEqual(result, { ok: true, writes: [message, '\r', ...keys] }, target);
    }
  });
}

test('a web resend does not paste a message already confirmed', async () => {
  for (const target of ['term', 'console']) {
    assert.deepEqual(await replay(target, [ready, draft, running], { resend: true }), { ok: true, writes: [message, '\r'] });
  }
});

test('Claude multiline paste is confirmed from the current paste badge', async () => {
  const text = 'First line.\nSecond line.\nThird line.\nFourth line.\n' + 'x'.repeat(900);
  const badge = ['❯ [Pasted text #1 +4 lines]', '─────────────', 'paste again to expand'];
  for (const target of ['term', 'automatic']) {
    const result = await replay(target, [['❯  '], badge, badge, running], { cli: 'claude', text });
    assert.deepEqual(result, { ok: true, writes: [text, '\r', '\r'] });
  }
  const legacy = await replay('console', [ready], { text });
  assert.deepEqual(legacy, { ok: false, writes: [] });
});
