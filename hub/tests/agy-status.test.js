const { test } = require('node:test');
const assert = require('node:assert/strict');
const { agyStatusFromScreen, stripAnsi } = require('../agy-session');

test('agyStatusFromScreen distinguishes idle, busy, and exited AGY terminals accurately', () => {
  const now = 100_000;
  assert.equal(agyStatusFromScreen('Type your message\n> ', { exited: null, lastOutputAt: 0, spawnedAt: 0, now }), 'idle');
  assert.equal(agyStatusFromScreen('Working...\nEsc to cancel', { exited: null, lastOutputAt: 0, spawnedAt: 0, now }), 'busy');
  assert.equal(agyStatusFromScreen('⠋ Thinking...', { exited: null, lastOutputAt: 0, spawnedAt: 0, now }), 'busy');
  // Active recent streaming after startup marks busy, then settles back to idle
  assert.equal(agyStatusFromScreen('Streaming answer', { exited: null, lastOutputAt: now - 500, spawnedAt: now - 10_000, now }), 'busy');
  assert.equal(agyStatusFromScreen('Done answer\n> ', { exited: null, lastOutputAt: now - 3000, spawnedAt: now - 10_000, now }), 'idle');
  // Startup banner within first 3.5s should stay idle unless spinner/cancel prompt is visible
  assert.equal(agyStatusFromScreen('Welcome to Antigravity\n> ', { exited: null, lastOutputAt: now - 500, spawnedAt: now - 1000, now }), 'idle');
  // Exited process always returns exited
  assert.equal(agyStatusFromScreen('Esc to cancel', { exited: 0, lastOutputAt: now, spawnedAt: 0, now }), 'exited');
  // ANSI cursor/OSC noise strips to empty string so it won't falsely mark output as busy
  assert.equal(stripAnsi('\x1b[?25h\x1b[?25l\x1b]0;agy\x07').trim(), '');
});
