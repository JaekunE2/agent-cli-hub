const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sessionFromLog, agyStatusFromScreen } = require('../agy-session');
const first = 'aaaaaaaa-bbbb-cccc-dddd-000000000001';
const second = 'aaaaaaaa-bbbb-cccc-dddd-000000000002';

test('AGY sessions follow the CLI process and ignore unrelated log events', () => {
  const text = [
    `I1122 12:34:56.123   968 tui.go:123] Created conversation ${first}`,
    `I1122 12:35:00.123  1766 tui.go:234] Full redraw completed (steps=2) for conversation ${second}`,
    `I1122 12:35:01.123   968 tui.go:345] found conversation ${second}`,
  ].join('\n');
  assert.equal(sessionFromLog(text, 968), first);
  assert.equal(sessionFromLog(text, 1766), second);
  assert.equal(sessionFromLog(text, 999), null);
  assert.equal(sessionFromLog(text), second);
});

test('agyStatusFromScreen ignores resize redraw output spikes but keeps explicit busy indicators', () => {
  const now = 100_000;
  const spawnedAt = now - 60_000;
  // Without recent resize, recent output marks busy
  assert.equal(agyStatusFromScreen('> prompt', { lastOutputAt: now - 500, spawnedAt, now }), 'busy');
  // Right after a terminal resize, redraw output does NOT falsely mark busy
  assert.equal(agyStatusFromScreen('> prompt', { lastOutputAt: now - 500, lastResizeAt: now - 600, spawnedAt, now }), 'idle');
  // Explicit busy text (spinner / esc to cancel) still marks busy even right after resize
  assert.equal(agyStatusFromScreen('⠋ thinking... (esc to cancel)', { lastOutputAt: now - 500, lastResizeAt: now - 600, spawnedAt, now }), 'busy');
});
