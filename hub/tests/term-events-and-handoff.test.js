'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { SearchIndex, claudeCommandNote, claudeToolResultNote, codexLine, agyLine } = require('../searchindex');
const { createTermEventStore, parseTerminalScreenState, createTermScreenMonitor } = require('../term-events');
const { createAccountSwitchService } = require('../account-switch');
const { createBranchStore } = require('../conversation-branches');

test('searchindex extracts Claude AskUserQuestion, answers, and /model or /plan commands', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ach-claude-events-'));
  try {
    const projDir = path.join(dir, 'proj');
    fs.mkdirSync(projDir, { recursive: true });
    const file = path.join(projDir, '11111111-2222-3333-4444-555555555555.jsonl');
    const lines = [
      JSON.stringify({ type: 'user', cwd: dir, timestamp: '2026-11-23T01:00:00Z', message: { content: '기능 구현해줘' } }),
      JSON.stringify({ type: 'user', cwd: dir, timestamp: '2026-11-23T01:00:05Z', message: { content: '<command-name>/model</command-name>\n<command-args>opus</command-args>' } }),
      JSON.stringify({ type: 'user', cwd: dir, timestamp: '2026-11-23T01:00:06Z', message: { content: '<local-command-stdout>Set model to claude-opus-4-6</local-command-stdout>' } }),
      JSON.stringify({
        type: 'assistant', cwd: dir, timestamp: '2026-11-23T01:00:10Z',
        message: {
          content: [{
            type: 'tool_use', id: 'tu1', name: 'AskUserQuestion',
            input: { questions: [{ question: '어떤 방식을 사용할까요?', options: [{ label: '방식 A' }, { label: '방식 B' }] }] },
          }],
        },
      }),
      JSON.stringify({
        type: 'user', cwd: dir, timestamp: '2026-11-23T01:00:20Z',
        toolUseResult: { answers: { '어떤 방식을 사용할까요?': '방식 A' } },
        message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'User has answered your questions: ...' }] },
      }),
    ];
    fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');

    const idx = new SearchIndex(dir, null, []);
    idx.docs.clear();
    await idx.updateFile(file);
    const doc = idx.get('11111111-2222-3333-4444-555555555555');
    assert.ok(doc);
    assert.equal(doc.firstPrompt, '기능 구현해줘');
    assert.ok(doc.msgs.some((m) => m.text.includes('[터미널 명령] /model opus')));
    assert.ok(doc.msgs.some((m) => m.text.includes('[터미널 상태] Set model to claude-opus-4-6')));
    assert.ok(doc.msgs.some((m) => m.text.includes('❓ 어떤 방식을 사용할까요? [방식 A / 방식 B]')));
    assert.ok(doc.msgs.some((m) => m.role === 'user' && m.text.includes('✓ 선택/응답: 어떤 방식을 사용할까요?: 방식 A')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('searchindex tracks Codex turn_context changes, request_user_input, and AGY USER_SETTINGS_CHANGE', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ach-codex-agy-events-'));
  try {
    const codexFile = path.join(dir, 'rollout-2026-11-23T10-00-00-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl');
    const codexLines = [
      JSON.stringify({ type: 'session_meta', timestamp: '2026-11-23T02:00:00Z', payload: { cwd: dir } }),
      JSON.stringify({ type: 'turn_context', timestamp: '2026-11-23T02:00:01Z', payload: { cwd: dir, model: 'gpt-5.4', effort: 'medium', collaboration_mode: 'default' } }),
      JSON.stringify({ type: 'response_item', timestamp: '2026-11-23T02:00:02Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '분석해줘' }] } }),
      JSON.stringify({ type: 'turn_context', timestamp: '2026-11-23T02:00:05Z', payload: { cwd: dir, model: 'gpt-5.4', effort: 'high', collaboration_mode: 'plan' } }),
      JSON.stringify({ type: 'response_item', timestamp: '2026-11-23T02:00:06Z', payload: { type: 'function_call', name: 'request_user_input', arguments: JSON.stringify({ questions: [{ question: '진행할까요?', options: [{ label: '예' }, { label: '아니오' }] }] }) } }),
      JSON.stringify({ type: 'response_item', timestamp: '2026-11-23T02:00:12Z', payload: { type: 'function_call_output', call_id: 'c1', output: JSON.stringify({ answers: { '진행할까요?': { answers: ['예'] } } }) } }),
    ];
    fs.writeFileSync(codexFile, codexLines.join('\n') + '\n', 'utf8');

    const idx = new SearchIndex(path.join(dir, 'no-claude'), dir, []);
    idx.docs.clear();
    await idx.updateFile(codexFile);
    const cdoc = idx.get('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    assert.ok(cdoc);
    assert.ok(cdoc.msgs.some((m) => m.text.includes('[설정 변경] 추론: high · 모드: plan')));
    assert.ok(cdoc.msgs.some((m) => m.text.includes('❓ 진행할까요? [예 / 아니오]')));
    assert.ok(cdoc.msgs.some((m) => m.role === 'user' && m.text.includes('✓ 선택/응답: 진행할까요?: 예')));

    const agyRes = agyLine({
      type: 'USER_INPUT',
      created_at: '2026-11-23T03:00:00Z',
      content: '<USER_REQUEST>\n계속해줘\n</USER_REQUEST>\n<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Gemini 4 Hydrogen (Medium).\n</USER_SETTINGS_CHANGE>',
    });
    assert.equal(agyRes.msg.text, '계속해줘');
    assert.ok(agyRes.settingsNote.includes('[설정 변경] Model Selection: None → Gemini 4 Hydrogen (Medium)'));

    const { isAgyFile, agyIdOf } = require('../searchindex');
    assert.equal(isAgyFile('C:\\Users\\x\\.gemini\\antigravity-cli\\brain\\11111111-1111-1111-1111-111111111111\\.system_generated\\logs\\transcript_full.jsonl'), true);
    assert.equal(agyIdOf('C:\\Users\\x\\.gemini\\antigravity-cli\\brain\\11111111-1111-1111-1111-111111111111\\.system_generated\\logs\\transcript_full.jsonl'), '11111111-1111-1111-1111-111111111111');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('term-events store & screen monitor capture terminal mode changes and interactive selections', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ach-term-ev-'));
  try {
    const store = createTermEventStore(path.join(dir, 'term-events.json'));
    let screen = '⏸ plan mode on (shift+tab to cycle)\n❯ ';
    const term = {
      id: '7',
      exited: null,
      meta: { spawnedAt: Date.now() - 10000, sessionId: 'sid-123' },
    };
    const metaUpdates = [];
    const mon = createTermScreenMonitor({
      store,
      stripAnsi: (x) => x,
      readTerm: () => screen.split('\n'),
      agentOf: () => 'claude',
      getSessionId: (t) => t.meta.sessionId,
      onMetaChange: (_t, m) => metaUpdates.push(m),
    });

    // Initial baseline
    mon.inspect(term);
    assert.equal(store.forSession('sid-123').length, 0);

    // Mode change + interactive prompt
    screen = [
      '⏵⏵ accept edits on (shift+tab to cycle)',
      '어떤 테스트를 실행할까요?',
      '❯ 1. 전체 테스트',
      '  2. 단위 테스트만',
      'Enter to select · Esc to cancel',
    ].join('\n');
    mon.inspect(term);
    assert.equal(metaUpdates.at(-1).mode, 'accept-edits');

    // User presses Enter to choose option 1
    mon.onInput(term, '\r');
    const evs = store.forSession('sid-123');
    assert.ok(evs.some((e) => e.text.includes('[터미널 변경] 모드: accept-edits')));
    assert.ok(evs.some((e) => e.text.includes('❓ 어떤 테스트를 실행할까요?')));
    assert.ok(evs.some((e) => e.role === 'user' && e.text.includes('✓ [터미널 선택] 1. 전체 테스트')));

    const parsed = parseTerminalScreenState('gpt-5.4 xhigh · full access', 'codex');
    assert.equal(parsed.model, 'gpt-5.4');
    assert.equal(parsed.effort, 'xhigh');
    assert.equal(parsed.mode, 'full-access');

    // Plain numbered lists in assistant/user text (even with AGY 'esc to cancel' footer) must NOT be misclassified as selection prompts
    const plainList = parseTerminalScreenState([
      '혹시 말씀하신 문제가:',
      '1. 첫 번째 경우인지',
      '2. 두 번째 경우인지',
      '> 2',
      'esc to cancel   Gemini 4 Hydrogen · medium',
    ].join('\n'), 'agy');
    assert.equal(plainList.prompt, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AGY, Claude, and Codex terminal model changes sync to meta without false confirmation blocks', () => {
  const { sessionStartupBlock } = require('../term-manager');
  const { cliModelEffortArgs } = require('../project-plan');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ach-agy-sync-'));
  try {
    // 1. AGY busy status footer must NOT trigger confirmation block even with > prompt text
    const agyScreen = [
      '──────────────────────────────────────────────────────────────',
      '> 방금 보낸 메시지 확인해줘',
      '──────────────────────────────────────────────────────────────',
      'esc to cancel                                  Gemini 4 Carbon · medium',
    ].join('\n');
    assert.equal(sessionStartupBlock(agyScreen), '');

    // Real confirmation prompt with Enter + Esc to cancel MUST still return confirmation
    const realConfirm = [
      'Do you want to use this API key?',
      '  Yes',
      '❯ No (recommended)',
      'Enter to confirm · Esc to cancel',
    ].join('\n');
    assert.equal(sessionStartupBlock(realConfirm), 'confirmation');

    // 2. Parse AGY, Codex, and Claude model/effort formats
    const agyParsed = parseTerminalScreenState(agyScreen, 'agy');
    assert.equal(agyParsed.model, 'gemini-4-carbon-medium');
    assert.equal(agyParsed.effort, 'medium');

    const agyOrch = parseTerminalScreenState('? for shortcuts                     Orchestrator (Carbon)', 'agy');
    assert.equal(agyOrch.model, 'gemini-pro-orchestrator');
    assert.equal(agyOrch.effort, '');

    const codexFooter = parseTerminalScreenState('› Ask Codex to do anything\n  GPT-6.2-Sol medium · D:\\Gitsource\\demo', 'codex');
    assert.equal(codexFooter.model, 'gpt-6.2-sol');
    assert.equal(codexFooter.effort, 'medium');

    const claudeSet = parseTerminalScreenState('Set model to sonnet (claude-sonnet-4-6) · high effort', 'claude');
    assert.equal(claudeSet.model, 'claude-sonnet-4-6');
    assert.equal(claudeSet.effort, 'high');

    const claudeDef = parseTerminalScreenState('Set model to Default (recommended)', 'claude');
    assert.equal(claudeDef.model, '');
    assert.equal(claudeDef.modelReset, true);

    // 3. Monitor updates meta immediately on first reattach inspection when terminal screen differs from launch meta
    const store = createTermEventStore(path.join(dir, 'ev.json'));
    let curScreen = agyScreen;
    const term = {
      id: '57',
      exited: null,
      meta: { spawnedAt: Date.now() - 20_000, sessionId: 'sid-agy', model: 'gemini-4-hydrogen-medium', effort: 'medium' },
    };
    const updates = [];
    const mon = createTermScreenMonitor({
      store,
      stripAnsi: (x) => x,
      readTerm: () => curScreen.split('\n'),
      agentOf: () => 'agy',
      getSessionId: (t) => t.meta.sessionId,
      onMetaChange: (_t, m) => updates.push(m),
    });
    mon.inspect(term);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].model, 'gemini-4-carbon-medium');
    assert.equal(updates[0].effort, 'medium');

    // 4. Updated AGY CLI model flags
    assert.deepEqual(cliModelEffortArgs('agy', 'gemini-4-carbon-medium', 'high'), ['--model', 'gemini-4-carbon-high', '--effort', 'high']);
    assert.deepEqual(cliModelEffortArgs('agy', 'gemini-pro-orchestrator', ''), ['--model', 'gemini-pro-orchestrator']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cross-platform switchAlways writes handoff.md and records branch lineage even when cont is false', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ach-handoff-'));
  try {
    const branchStore = createBranchStore(path.join(dir, '.branches.json'));
    const createdTerms = [];
    const mockDoc = {
      id: '11111111-1111-1111-1111-111111111111',
      agent: 'claude',
      cwd: dir,
      title: 'Auth refactor',
      firstPrompt: '리팩토링 해줘',
      msgs: [
        { role: 'user', text: '리팩토링 해줘', ts: '2026-11-23T01:00:00Z' },
        { role: 'assistant', text: '네, 진행했습니다.', ts: '2026-11-23T01:00:05Z' },
      ],
    };
    const fakeHub = {
      baseDir: dir,
      config: {},
      claudeDir: path.join(dir, 'claude'),
      nativeCrossHandoff: false,
      USAGE_DIR: path.join(dir, 'usage'),
      terms: new Map(),
      index: { get: (id) => (id === mockDoc.id ? mockDoc : null), updateFile: async () => {} },
      accountPrefs: { getForAccount: () => ({ model: '', effort: '' }), save: () => {} },
      conversationBranches: branchStore,
      helperCall: async () => ({ consoles: [] }),
      liveSessions: () => [],
      codexAccounts: { accounts: () => [], envFor: () => ({}) },
      CA: { accounts: () => [], envFor: () => ({}), usage: async () => ({}), rank: () => [], codexExe: () => 'codex' },
      agyQuota: { getFast: () => ({}), noteAccount: () => {}, refresh: async () => {} },
      agySwap: { available: () => false, getFast: () => ({ accounts: [] }) },
      claudeUsage: async () => ({ available: false }),
      tokenAccounts: () => [],
      geminiAccounts: () => [],
      codexLaunch: (args) => ({ cmd: 'codex', args }),
      agyExe: () => 'agy.exe',
      cliModelEffortArgs: () => [],
      cleanModelEffort: (m, e) => ({ model: m || '', effort: e || '' }),
      termSessionId: () => null,
      termDocOf: () => null,
      isCodexTerm: () => false,
      isAgyTerm: () => false,
      readTerm: () => [],
      loadFavs: () => [],
      FAV_FILE: path.join(dir, 'favs.json'),
      sleep: async () => {},
      waitFor: async () => true,
      inputReady: () => true,
      SUBMIT_DELAY: 10,
      createTerm: (opts) => {
        const t = { id: '99', meta: { ...opts }, exited: null, proc: { write: () => {} } };
        createdTerms.push(t);
        return t;
      },
      termInfo: (t) => ({ id: t.id, title: t.meta.title, agent: 'codex' }),
      overviewStale: () => {},
    };

    const svc = createAccountSwitchService(fakeHub);
    const res = await svc.switchAccount({
      sessionId: mockDoc.id,
      account: '__cli__:codex',
      cont: false,
      followUp: '테스트도 추가해줘',
      openMode: 'dashboard',
    });

    assert.equal(res.ok, true);
    assert.equal(res.crossPlatform, true);
    assert.ok(res.handoffFile && fs.existsSync(res.handoffFile));
    const md = fs.readFileSync(res.handoffFile, 'utf8');
    assert.ok(md.includes('CLAUDE → CODEX'));
    assert.ok(md.includes('리팩토링 해줘'));
    assert.ok(md.includes('테스트도 추가해줘'));

    // Codex launch args received the handoff prompt referencing the md file
    assert.ok(createdTerms[0].meta.args.some((a) => String(a).includes(res.handoffFile)));

    // Lineage recorded so "원본 열기" works from the new terminal/session
    const meta = branchStore.branchMetaFor({ termId: '99' });
    assert.ok(meta?.isBranch);
    assert.equal(meta.parentSessionId, mockDoc.id);
    assert.equal(meta.mode, 'handoff');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cross-platform switchAlways converts Claude <-> Codex natively and keeps AGY on handoff', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ach-native-xfer-'));
  try {
    const branchStore = createBranchStore(path.join(dir, '.branches.json'));
    const createdTerms = [];
    const claudeDoc = {
      id: '11111111-1111-1111-1111-111111111111',
      agent: 'claude',
      cwd: dir,
      title: 'Native transfer test',
      firstPrompt: '첫 질문입니다',
      msgs: [
        { role: 'user', text: '첫 질문입니다', ts: '2026-11-26T01:00:00Z' },
        { role: 'assistant', text: '첫 답변입니다', ts: '2026-11-26T01:00:05Z' },
      ],
    };
    const codexDoc = {
      id: '22222222-2222-2222-2222-222222222222',
      agent: 'codex',
      cwd: dir,
      title: 'Codex source',
      firstPrompt: '코드 수정해줘',
      msgs: [
        { role: 'user', text: '코드 수정해줘', ts: '2026-11-26T02:00:00Z' },
        { role: 'assistant', text: '수정 완료했습니다', ts: '2026-11-26T02:00:05Z' },
      ],
    };
    let seq = 100;
    const fakeHub = {
      baseDir: dir,
      config: {},
      claudeDir: path.join(dir, 'claude'),
      codexHome: path.join(dir, 'codex'),
      USAGE_DIR: path.join(dir, 'usage'),
      terms: new Map(),
      index: { get: (id) => (id === claudeDoc.id ? claudeDoc : id === codexDoc.id ? codexDoc : null), updateFile: async () => {} },
      accountPrefs: { getForAccount: () => ({ model: '', effort: '' }), save: () => {} },
      conversationBranches: branchStore,
      helperCall: async () => ({ consoles: [] }),
      liveSessions: () => [],
      codexAccounts: { accounts: () => [], envFor: () => ({}) },
      CA: { accounts: () => [], envFor: () => ({}), usage: async () => ({}), rank: () => [], codexExe: () => 'codex' },
      agyQuota: { getFast: () => ({}), noteAccount: () => {}, refresh: async () => {} },
      agySwap: { available: () => false, getFast: () => ({ accounts: [] }) },
      claudeUsage: async () => ({ available: false }),
      tokenAccounts: () => [],
      geminiAccounts: () => [],
      codexLaunch: (args) => ({ cmd: 'codex', args }),
      agyExe: () => 'agy.exe',
      cliModelEffortArgs: () => [],
      cleanModelEffort: (m, e) => ({ model: m || '', effort: e || '' }),
      termSessionId: () => null,
      termDocOf: () => null,
      isCodexTerm: () => false,
      isAgyTerm: () => false,
      readTerm: () => [],
      loadFavs: () => [],
      FAV_FILE: path.join(dir, 'favs.json'),
      sleep: async () => {},
      waitFor: async () => true,
      inputReady: () => true,
      SUBMIT_DELAY: 10,
      createTerm: (opts) => {
        const t = { id: String(seq++), meta: { ...opts }, exited: null, proc: { write: () => ({ ok: true }) } };
        createdTerms.push(t);
        return t;
      },
      termInfo: (t) => ({ id: t.id, title: t.meta.title, agent: t.meta.workspaceCli || 'codex' }),
      overviewStale: () => {},
    };

    const svc = createAccountSwitchService(fakeHub);

    // 1) Claude -> Codex uses native rollout JSONL + `codex resume <id>`
    const toCodex = await svc.switchAccount({ sessionId: claudeDoc.id, account: '__cli__:codex', cont: true, openMode: 'dashboard' });
    assert.equal(toCodex.ok, true);
    assert.equal(toCodex.nativeConverted, true);
    assert.ok(toCodex.convertedSessionId);
    assert.deepEqual(createdTerms[0].meta.args.slice(-3), ['resume', toCodex.convertedSessionId, '계속 진행해']);
    const codexSessDir = path.join(dir, 'codex', 'sessions');
    assert.ok(fs.existsSync(codexSessDir));

    // Verify SQLite registration + fresh timestamps when state_5.sqlite exists
    const { writeNativeCodexSession } = require('../conversation-branches');
    const { DatabaseSync } = require('node:sqlite');
    const sqlCodex = path.join(dir, 'codex-sql');
    fs.mkdirSync(sqlCodex, { recursive: true });
    const sqlDb = new DatabaseSync(path.join(sqlCodex, 'state_5.sqlite'));
    sqlDb.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, source TEXT NOT NULL, model_provider TEXT NOT NULL, cwd TEXT NOT NULL, title TEXT NOT NULL, sandbox_policy TEXT NOT NULL, approval_mode TEXT NOT NULL, has_user_event INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0)');
    sqlDb.close();
    const sqlRes = writeNativeCodexSession({
      codexHome: sqlCodex,
      cwd: dir,
      msgs: [{ role: 'user', text: 'old msg', ts: '2020-01-01T00:00:00.000Z' }, { role: 'assistant', text: 'old reply', ts: '2020-01-01T00:00:05.000Z' }],
      title: 'Test SQL',
    });
    assert.ok(sqlRes?.sessionId);
    const checkDb = new DatabaseSync(path.join(sqlCodex, 'state_5.sqlite'), { readOnly: true });
    const sqlRow = checkDb.prepare('SELECT id, source, model_provider, cwd FROM threads WHERE id = ?').get(sqlRes.sessionId);
    checkDb.close();
    assert.equal(sqlRow?.source, 'cli');
    assert.equal(sqlRow?.model_provider, 'openai');
    const lastTs = JSON.parse(fs.readFileSync(sqlRes.file, 'utf8').trim().split(/\r?\n/).at(-1)).timestamp;
    assert.ok(Date.parse(lastTs) > Date.now() - 60_000);
    const metaRec = JSON.parse(fs.readFileSync(sqlRes.file, 'utf8').trim().split(/\r?\n/)[0]);
    assert.equal(metaRec.payload.history_mode, 'legacy');

    // 2) Codex -> Claude uses native Claude JSONL + `claude --resume <id>`
    const toClaude = await svc.switchAccount({ sessionId: codexDoc.id, account: '__cli__:claude', cont: false, openMode: 'dashboard' });
    assert.equal(toClaude.ok, true);
    assert.equal(toClaude.nativeConverted, true);
    assert.ok(toClaude.convertedSessionId);
    assert.deepEqual(createdTerms[1].meta.args.slice(0, 2), ['--resume', toClaude.convertedSessionId]);

    // 3) Claude -> AGY stays on markdown handoff (`handoff-*.md` + `--prompt-interactive`)
    const toAgy = await svc.switchAccount({ sessionId: claudeDoc.id, account: '__cli__:agy', cont: false, openMode: 'dashboard' });
    assert.equal(toAgy.ok, true);
    assert.equal(toAgy.nativeConverted, false);
    assert.ok(toAgy.handoffFile && fs.existsSync(toAgy.handoffFile));
    assert.ok(createdTerms[2].meta.args.includes('--prompt-interactive'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
