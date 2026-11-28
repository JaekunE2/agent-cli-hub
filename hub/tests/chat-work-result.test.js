'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { SearchIndex } = require('../searchindex');
const { chatWorkDiff } = require('../chat-work-diff');

test('chat reports image checks based on pixel differences without requiring a review', async () => {
  const source = await fs.readFile(path.join(__dirname, '../public/chat-work-card.js'), 'utf8');
  const { regionPixelCheck, requestedRegionColor, regionColorCheck, chatWorkCardHTML, chatRegionOutcomeHTML, chatWorkOutcomeHTML, workFailureRequest, regionFailureRequest } = vm.runInNewContext(
    source + '\n({regionPixelCheck, requestedRegionColor, regionColorCheck, chatWorkCardHTML, chatRegionOutcomeHTML, chatWorkOutcomeHTML, workFailureRequest, regionFailureRequest})',
    { esc: String, quotePath: String });
  const image = (...pixels) => ({ width: pixels.length, height: 1, data: Uint8Array.from(pixels.flatMap(v => [v, 0, 0, 255])) });
  const before = image(0, 0, 0), areas = [{ x: 0, y: 0, w: 1 / 3, h: 1 }, { x: 2 / 3, y: 0, w: 1 / 3, h: 1 }];
  assert.equal(regionPixelCheck(before, image(255, 0, 255), areas), 'inside');
  assert.equal(regionPixelCheck(before, image(0, 255, 0), areas), 'outside');
  assert.equal(regionPixelCheck(before, before, areas), 'unchanged');
  assert.equal(regionPixelCheck(before, image(255), areas), 'size');
  assert.equal(regionPixelCheck(before, null, areas), 'unavailable');
  assert.equal(requestedRegionColor('이부분 빨갛게해주세요'), 'red');
  assert.equal(requestedRegionColor('여기만 흑백으로 변경해주세요'), 'grayscale');
  assert.equal(requestedRegionColor('빨갛게 하지 마세요'), '');
  assert.equal(regionColorCheck(image(255, 0, 255), areas, 'red'), true);
  assert.equal(regionColorCheck(image(255, 0, 0), areas, 'red'), false);
  assert.equal(regionColorCheck(image(255, 0, 0), areas, 'grayscale'), false);
  assert.equal(regionColorCheck(before, areas, 'grayscale'), true);
  const outcome = chatRegionOutcomeHTML({ scope: 'outside', color: 'red', colorCheck: false, thumbnail: 'preview' });
  assert.match(outcome, /수정된 이미지/);
  assert.match(outcome, /선택 영역 밖도 변경됨/);
  assert.match(outcome, /빨간색 조건을 충족하지 않는 픽셀이 있음/);
  assert.match(outcome, /data-work-image-fix/);
  assert.doesNotMatch(chatRegionOutcomeHTML({ scope: 'inside' }), /data-work-image-fix/);
  const regionRequest = regionFailureRequest({ scope: 'outside', regions: areas, item: { path: 'sample.png' }, comment: '빨갛게' });
  assert.match(regionRequest, /sample\.png[\s\S]+빨갛게[\s\S]+33\.3[\s\S]+선택 영역 밖도 변경됨/);
  const html = chatWorkCardHTML({ id: 'test', checks: [{ count: 1 }], files: [] }, false);
  assert.match(html, /테스트 1개 통과/);
  assert.match(html, /변경 내역/);
  assert.doesNotMatch(html, /정상 확인|확인 필요|검증 미확인|data-work-review/);
  assert.equal(chatWorkOutcomeHTML({ checks: [{ failed: false }] }), '');
  assert.match(chatWorkOutcomeHTML({ checks: [{ passedNames: ['saves after tapping Save'] }] }), /테스트에서 확인된 동작[\s\S]+saves after tapping Save/);
  const check = { command: 'npm test', failed: true, failureNames: ['prints the result'], assertions: { 'prints the result': { expected: '3', actual: '2' } } };
  const issue = chatWorkOutcomeHTML({ checks: [check] });
  assert.match(issue, /실패한 검증[\s\S]+prints the result[\s\S]+기대값 3 · 실제값 2[\s\S]+data-work-fix="0"/);
  assert.match(workFailureRequest(check), /npm test[\s\S]+prints the result \(기대값 3, 실제값 2\)/);
  assert.doesNotMatch(workFailureRequest({ ...check, failureNames: [...check.failureNames, 'reloads data'] }, 'prints the result'), /reloads data/);
  assert.doesNotMatch(issue, /<details/);
});

test('image checks keep the earlier request on send failure and skip pixel attribution when edits overlap', async () => {
  const source = await fs.readFile(path.join(__dirname, '../public/chat-work-card.js'), 'utf8');
  const baseline = { width: 2, height: 1 };
  const { sendWithRegionCheck, pendingRegionChecks } = vm.runInNewContext(
    source + '\n({sendWithRegionCheck, pendingRegionChecks})', {
      URL, location: new URL('http://localhost/'),
      document: { createElement: () => ({ getContext: () => ({ drawImage() {}, getImageData: () => baseline }) }) },
    });
  const item = { kind: 'image', path: 'fixture.png' };
  const image = { tagName: 'IMG', naturalWidth: 2, naturalHeight: 1, src: '/api/artifact-file' };
  const target = { kind: 'term', id: '1' };
  const left = { x: 0, y: 0, w: 0.5, h: 1 }, right = { ...left, x: 0.5 };
  await sendWithRegionCheck(image, item, [left], target, 'First', async () => {}, 'Red');
  const first = pendingRegionChecks.get('term:1');
  assert.equal(first.before, baseline);
  await assert.rejects(sendWithRegionCheck(image, item, [right], target, 'Second', async () => {
    throw new Error('Not sent');
  }, 'Grayscale'), /Not sent/);
  assert.equal(pendingRegionChecks.get('term:1'), first);
  await sendWithRegionCheck(image, item, [right], target, 'Second', async () => {}, 'Grayscale');
  const second = pendingRegionChecks.get('term:1');
  assert.equal(second.before, undefined);
  assert.equal(second.comment, 'Grayscale');
  assert.deepEqual(second.regions, [right]);
});

test('artifact data checks and fix requests carry the actual and requested counts', async () => {
  const source = await fs.readFile(path.join(__dirname, '../public/chat-work-data.js'), 'utf8');
  const { requestedArtifactRows, readChatDelimited, chatDataFixRequest } = vm.runInThisContext(
    '(() => {const quotePath = String;' + source + '\nreturn {requestedArtifactRows, readChatDelimited, chatDataFixRequest};})()');
  assert.equal(requestedArtifactRows('CSV로 작성하세요.\n데이터 행 2개로 작성해 주세요.'), 2);
  assert.equal(requestedArtifactRows('Record count: 0'), 0);
  assert.equal(requestedArtifactRows('데이터 행 최소 2개'), null);
  assert.equal(requestedArtifactRows('데이터 행: 3개\nData rows: 4'), null);
  assert.deepEqual(readChatDelimited('\uFEFFid,label\r\n1,"a,b"\r\n2,"two\nlines"\r\n', ','),
    [['id', 'label'], ['1', 'a,b'], ['2', 'two\nlines']]);
  assert.deepEqual(readChatDelimited('field\n""\n', ','), [['field'], ['']]);
  assert.equal(readChatDelimited('a,b\n0,"unfinished', ','), null);
  assert.match(chatDataFixRequest({ path: 'report.csv' }, 2, 3, true), /report\.csv\n요청 3행 · 실제 2행/);
});

async function fixture(t, name) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-work-result-'));
  const file = path.join(dir, name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  t.after(async () => {
    await fs.unlink(file);
    for (let parent = path.dirname(file); parent !== dir; parent = path.dirname(parent)) await fs.rmdir(parent);
    await fs.rmdir(dir);
  });
  return { file, index: new SearchIndex(dir, dir, []) };
}

const rows = (...items) => items.map(item => JSON.stringify(item)).join('\n') + '\n';
const event = (type, extra = {}) => ({ type: 'event_msg', payload: { type, ...extra } });
const response = (type, extra) => ({ type: 'response_item', payload: { type, ...extra } });
const answer = text => response('message', { role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text }] });

test('Codex reports only completed results and reads exact patches lazily', async t => {
  const { file, index } = await fixture(t, 'rollout-work-fixture.jsonl');
  const patch = '@@ -4 +4 @@\n-old\n+new';
  await fs.writeFile(file, rows(
    event('task_started', { turn_id: 'first' }),
    event('patch_apply_end', { turn_id: 'first', call_id: 'p', success: true, changes: { 'app.js': { type: 'update', unified_diff: patch } } }),
    event('patch_apply_end', { success: false, changes: { 'wrong.js': { type: 'add' } } }),
    response('function_call', { call_id: 'test', name: 'exec_command', arguments: JSON.stringify({ cmd: 'node --test check.js' }) }),
    response('function_call_output', { call_id: 'test', output: 'Process exited with code 0\nok 1 - saves after tapping Save\nok 2 - clears the editor # SKIP\n# pass 12\nprivate log' }),
    answer('Done'),
  ));
  await Promise.all([index.updateFile(file), index.updateFile(file)]);
  assert.equal(index.get('rollout-work-fixture').msgs.at(-1).workResult, undefined);
  await fs.appendFile(file, rows(event('task_complete', { turn_id: 'first' }), event('task_started', { turn_id: 'second' }), answer('Another response'), event('task_complete', { turn_id: 'second' })));
  await index.updateFile(file);
  const doc = index.get('rollout-work-fixture');
  const result = doc.msgs.find(message => message.text === 'Done').workResult;
  assert.deepEqual(result.files.map(entry => entry.path), ['app.js']);
  assert.deepEqual(result.checks, [{ command: 'node --test', failed: false, count: 12, passedNames: ['saves after tapping Save'] }]);
  assert.doesNotMatch(JSON.stringify(result), /private log|\+new/);
  assert.deepEqual(await chatWorkDiff(doc, result.files[0]), { patch, partial: false });
  assert.equal(doc.msgs.at(-1).workResult, undefined);
});

test('Claude exposes failed test names without the raw test output', async t => {
  const { file, index } = await fixture(t, 'claude-work-fixture.jsonl');
  const msg = (type, blocks, extra = {}) => ({ type, message: { content: blocks }, ...extra });
  const tool = (id, name, input) => ({ type: 'tool_use', id, name, input });
  const result = (id, failed, value) => msg('user', [{ type: 'tool_result', tool_use_id: id, is_error: failed }], { toolUseResult: value });
  await fs.writeFile(file, rows(
    msg('user', [{ type: 'text', text: 'Change one file' }]),
    msg('assistant', [tool('edit', 'Edit', { file_path: 'src/app.js' }), tool('fail', 'Write', { file_path: 'no.js' }), tool('test', 'Bash', { command: 'npm test' })]),
    result('edit', false, { filePath: 'src/app.js', structuredPatch: [{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1, lines: ['-old', '+new'] }] }),
    result('fail', true, {}),
    result('test', true, { stdout: 'not ok 1 - shows the results\n  ---\n  expected: true\n  actual: false\n  ...\nprivate output' }),
    { type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done' }] } },
  ));
  await index.updateFile(file);
  const doc = index.get('claude-work-fixture');
  const record = doc.msgs.at(-1).workResult;
  assert.deepEqual(record.files.map(item => item.path), ['src/app.js']);
  assert.deepEqual(record.checks, [{ command: 'npm test', count: null, failed: true, failureNames: ['shows the results'],
    assertions: { 'shows the results': { expected: 'true', actual: 'false' } } }]);
  assert.doesNotMatch(JSON.stringify(record), /private output/);
  assert.match((await chatWorkDiff(doc, record.files[0])).patch, /\+new/);
});

test('Antigravity binds edit confirmations and background tests to the completed answer', async t => {
  const { file, index } = await fixture(t, 'agy-work-fixture/.system_generated/logs/transcript.jsonl');
  const agy = (step_index, type, fields = {}) => ({ step_index, type, status: 'DONE', source: 'MODEL', ...fields });
  const plan = (step, name, args) => agy(step, 'PLANNER_RESPONSE', { tool_calls: [{ name, args }] });
  const job = '00000000-0000-4000-8000-000000000000/task-12';
  await fs.writeFile(file, rows(
    agy(0, 'USER_INPUT', { content: 'Change and test' }),
    plan(1, 'edit_file', { Path: 'styles.css', Target: 'a { color: red; }', Replacement: 'a { color: blue; }' }),
    agy(2, 'GENERIC', { content: 'Made 1 replacement in styles.css starting at line 5 (+1/-1 lines).' }),
    plan(3, 'run_command', { CommandLine: '"node --test"' }),
    agy(4, 'GENERIC', { status: 'RUNNING', content: `Running as background task with Task ID: ${job}` }),
    agy(5, 'SYSTEM_MESSAGE', { source: 'SYSTEM', content: `Task id "${job}" finished.\nCommand exited with code 0.\n# pass 2` }),
    plan(6, 'finish', { reason: 'Done.' }),
    agy(7, 'GENERIC', { content: 'Done.' }),
  ));
  await index.updateFile(file);
  const doc = index.get('agy-work-fixture');
  const record = doc.msgs.at(-1).workResult;
  assert.equal(doc.msgs.at(-1).text, 'Done.');
  assert.deepEqual(record.files.map(item => item.path), ['styles.css']);
  assert.deepEqual(record.checks, [{ command: 'node --test', count: 2, failed: false }]);
  assert.equal((await chatWorkDiff(doc, record.files[0])).patch, '@@ -5,1 +5,1 @@\n-a { color: red; }\n+a { color: blue; }');
});
