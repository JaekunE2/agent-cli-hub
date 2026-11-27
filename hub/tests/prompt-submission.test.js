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
  resendFrames, beforeReady = [] } = {}) {
  const writes = [];
  const term = { id: '1', exited: null, meta: { projectTask: {} } };
  let offset = 0;
  const read = () => beforeReady.shift() || frames[Math.min(writes.length - offset, frames.length - 1)];
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

test('managed dispatch waits for the composer to be redrawn before pasting', async () => {
  for (const target of ['term', 'automatic']) {
    assert.deepEqual(await replay(target, [ready, draft, running], { beforeReady: Array(3).fill(['Redrawing…']) }),
      { ok: true, writes: [message, PTY_KEYS.enter] }, target);
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

test('manual terminal Enter reports failed PTY delivery', async () => {
  const term = { exited: null, proc: { write: async (key) => {
    assert.equal(key, PTY_KEYS.enter);
    return { ok: false, error: 'PTY disconnected' };
  } } };
  const { handleSessionRoutes } = createSessionRoutes({ PTY_KEYS, terms: new Map([['1', term]]), isCodexTerm: () => false });
  await handleSessionRoutes('/api/term/send', null, { method: 'POST' }, null,
    async () => ({ id: '1', keys: ['enter'] }),
    (_res, status, result) => {
      assert.equal(status, 409);
      assert.deepEqual(result, { ok: false, error: 'PTY disconnected' });
    }, () => true);
});

test('leaving a project terminal discards only unsubmitted input without any manual activity', async () => {
  const term = { id: '1', exited: null, lastInputAt: 100, meta: { spawnedAt: 100, projectAutoClose: true } };
  let screen = '› unrecognized draft';
  const gone = [];
  const { handleSessionRoutes } = createSessionRoutes({
    terms: new Map([[term.id, term]]), readTerm: () => [screen], isCodexTerm: () => true,
    codexStatus: () => 'idle', forgetTerm: (t) => gone.push(t.id),
  });
  const discard = async (removed) => handleSessionRoutes('/api/term/discard-unused', null, { method: 'POST' }, null,
    async () => ({ id: term.id }), (_res, _code, payload) => assert.equal(payload.removed, removed), () => true);
  await discard(false);
  screen = '› Ask Codex to do anything';
  term.meta.projectSubmitted = true;
  await discard(false);
  term.meta.projectSubmitted = false;
  term.lastInputAt++;
  await discard(false);
  term.lastInputAt--;
  await discard(true);
  assert.deepEqual(gone, ['1']);
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

test('a long Codex draft still submits after its beginning scrolls off after paste', async () => {
  const visible = 'Confirm the tests and report which changes were verified before returning.';
  const text = 'Inspect the full project context and implement the requested update. ' + visible;
  for (const target of ['term', 'automatic', 'console']) {
    const frames = [ready, ['› ' + visible], running];
    assert.deepEqual(await replay(target, frames, { text }), { ok: true, writes: [text, PTY_KEYS.enter] });
  }
});

test('Codex submits a freshly pasted instruction whose file path wraps mid-token', async () => {
  const text = 'Read "D:\\hub\\data\\project-prompts\\abc.md" and execute the task.';
  const wrapped = ['› Read "D:\\hub\\data\\project-', '  prompts\\abc.md" and execute the task.'];
  for (const target of ['term', 'automatic', 'console']) {
    assert.deepEqual(await replay(target, [ready, wrapped, running], { text }), { ok: true, writes: [text, PTY_KEYS.enter] }, target);
    assert.deepEqual(await replay(target, [wrapped, running], { text }), { ok: false, writes: [] }, target);
  }
});

test('explicit chat retry submits a matching wrapped draft without pasting again', async () => {
  const { submitPrompt } = require('../prompt-submission');
  const writes = [];
  await submitPrompt({
    text: 'Read "D:\\project-prompts\\abc.md" first.',
    pasteMarker: 'codex', resend: true,
    read: () => writes.length ? { screen: 'Working', busy: true }
      : { screen: '› Read "D:\\project-\n  prompts\\abc.md" first.', busy: false },
    guard() {}, waitFor: fn => fn(), started: view => view.busy,
    write: data => writes.push(data),
  });
  assert.deepEqual(writes, [PTY_KEYS.enter]);
});

test('a matching paste badge followed by other pasted content never triggers Enter', async () => {
  const mixed = [`› [Pasted Content ${message.length} chars]`, '  [Pasted Content 3875 chars]'];
  for (const target of ['term', 'automatic', 'console']) {
    assert.deepEqual(await replay(target, [ready, mixed]), { ok: false, writes: [message] }, target);
  }
});

test('the Codex navigation and warning footer is not mistaken for an input draft', async () => {
  const footer = '  ← for agents · ? for shortcuts                 ⚠ 3 warnings · f2 to view';
  for (const target of ['term', 'automatic', 'console']) {
    const frames = [[...ready, footer], [...draft, footer], [...running, footer]];
    assert.deepEqual(await replay(target, frames), { ok: true, writes: [message, PTY_KEYS.enter] }, target);
    assert.deepEqual(await replay(target, [[...draft.map((line) => line + ' changed'), footer]]), { ok: false, writes: [] }, target);
  }
});

test('AGY submits a long multiline pasted message even when wrapped or scrolled in the composer', async () => {
  const longText = '첫 번째 줄 긴 설명입니다.\n두 번째 줄에 이어지는 내용으로 ' + '가나다라마바사 '.repeat(12) + '마지막 핵심 문장 확인 부탁합니다.';
  const agyReady = ['────────────────────────', '>', '────────────────────────', '? for shortcuts'];
  const agyWrappedTail = ['────────────────────────', '> ' + '가나다라마바사 '.repeat(5) + '마지막 핵심 문장 확인 부탁합니다.', '────────────────────────'];
  const agyRunning = ['esc to cancel                                  Gemini 4 Hydrogen · medium'];
  assert.deepEqual(await replay('term', [agyReady, agyWrappedTail, agyRunning], { cli: 'agy', text: longText }), { ok: true, writes: [longText, PTY_KEYS.enter] });
});

test('AGY submits a medium Korean pasted message with short visible tail or transient redraw', async () => {
  const { submitPrompt } = require('../prompt-submission');
  const text = '채팅창에서 치면 터미널로 넘어가기만 하고 전송 확인이 안되는 문제 수정';
  const ready = '────────────────────────\n>\n────────────────────────\n? for shortcuts';
  const shortTail = '────────────────────────\n> 넘어가기만 하고 전송 확인이 안되는 문제 수정\n────────────────────────';
  const running = 'esc to cancel                                  Gemini 4 Hydrogen · medium';
  const screens = [ready, shortTail, 'Redrawing...', shortTail, running];
  let idx = 0;
  const writes = [];
  await submitPrompt({
    text, pasteMarker: 'agy',
    read: () => ({ screen: screens[Math.min(idx++, screens.length - 1)], busy: idx >= screens.length }),
    guard() {}, waitFor: async (fn) => {
      for (let i = 0; i < 6; i++) { if (await fn()) return true; }
      return false;
    },
    sleep: async () => {}, started: (view) => view.busy,
    write: (data) => writes.push(data),
  });
  assert.deepEqual(writes, [text, PTY_KEYS.enter]);
});

test('Codex right-aligned warnings badge on the prompt line is not mistaken for a user draft', async () => {
  const readyWithWarn = ['› Ask Codex to do anything                                    ⚠ 5 warnings · f2 to view', '  GPT-6.1-Sol medium · D:\\repo'];
  const draftWithWarn = [`› ${message}                                    ⚠ 5 warnings · f2 to view`, '  GPT-6.1-Sol medium · D:\\repo'];
  for (const target of ['term', 'automatic', 'console']) {
    assert.deepEqual(await replay(target, [readyWithWarn, draftWithWarn, running]), { ok: true, writes: [message, PTY_KEYS.enter] }, target);
  }
});

test('composerText still reads idle/pasted Codex prompt when ConPTY parks cursor on the footer line', () => {
  const { composerText } = require('../prompt-submission');
  const screen = [
    '  Worked for 26s • 11:41 AM',
    '',
    '› Ask Codex to do anything',
    '',
    '  GPT-6.2-Sol medium · D:\\Gitsource\\M2N\\wgkim_m2n_project_v2',
    '  ← for agents · ? for shortcuts                                ⚠ 5 warnings · f2 to view',
  ].join('\n');
  // Cursor parked on blank/footer line below prompt (lines 3..5) still resolves composer
  assert.equal(composerText(screen, 3), 'Ask Codex to do anything');
  assert.equal(composerText(screen, 5), 'Ask Codex to do anything');
  // Stale prompt above a real interactive dialog/menu still returns null
  const withMenu = [
    '› old prompt',
    '────────────',
    'Select a model:',
    '  1. gpt-6.2-sol',
    '  2. gpt-6.1-sol',
  ].join('\n');
  assert.equal(composerText(withMenu, 3), null);
});

test('Codex clearDraft never sends Ctrl+C (\\x03) which would exit an idle Codex process', async () => {
  const { submitPrompt } = require('../prompt-submission');
  const writes = [];
  await assert.rejects(
    () => submitPrompt({
      text: 'new message',
      pasteMarker: 'codex',
      clearDraft: true,
      read: () => ({ screen: '› leftover multiline\n  draft text', busy: false }),
      guard() {},
      waitFor: async (fn) => await fn(),
      sleep: async () => {},
      started: (view) => view.busy,
      write: (data) => writes.push(data),
    }),
    /CLI 입력창에 제출되지 않은 다른 내용이 있습니다/
  );
  assert.equal(writes.includes('\x03'), false);
  assert.deepEqual(writes, ['\x05\x15', '\x01\x0b']);
});
