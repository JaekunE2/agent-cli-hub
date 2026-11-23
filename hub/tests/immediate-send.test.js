const test = require('node:test');
const assert = require('node:assert/strict');
const { PTY_KEYS, dispatchImmediatePrompt } = require('../immediate-send');

const noopSleep = () => Promise.resolve();

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

test('AGY unsubmitted prompt submits with Enter and follows up with Alt+M if queued', async () => {
  const writes = [];
  const res = await dispatchImmediatePrompt({
    cli: 'agy',
    isBusy: () => true,
    readNormLines: () => (writes.includes('\r') ? '미전송 프롬프트\nalt+m to send immediatel' : '> 미전송 프롬프트'),
    write: (d) => writes.push(d),
    sleep: noopSleep,
    text: '미전송 프롬프트',
    resendIfMissing: true,
  });
  assert.equal(res.handled, true);
  assert.equal(res.result.submittedExisting, true);
  assert.deepEqual(writes, ['\r', PTY_KEYS['alt+m']]);
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
