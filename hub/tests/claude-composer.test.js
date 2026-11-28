'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Terminal } = require('@xterm/headless');
const { withoutClaudeSuggestion } = require('../claude-composer');
const { composerText } = require('../prompt-submission');

async function fixture(body, cursor = 3) {
  const vt = new Terminal({ cols: 80, rows: 8, allowProposedApi: true });
  await new Promise(resolve => vt.write(`answer\r\n──────────\r\n❯\u00a0${body}\r\n──────────\r\nfooter\x1b[3;${cursor}H`, resolve));
  const lines = Array.from({ length: 5 }, (_, i) => vt.buffer.active.getLine(i).translateToString(true));
  return { vt, lines };
}

test('ignores Korean and wrapped dim ghost suggestions at an empty Claude cursor', async () => {
  for (const text of ['ㅇㅋ 원고 나오면 PDF랑 메일 같이 보여줘', 'dt-구조이해 1차도 지금 진행해', '계속 진행해', 'first line\r\n  next line']) {
    const { vt, lines } = await fixture(`\x1b[2m${text}\x1b[22m`);
    // Include all rows for the wrapped case.
    const screen = Array.from({ length: text.includes('\n') ? 6 : 5 }, (_, i) => vt.buffer.active.getLine(i).translateToString(true));
    assert.equal(composerText(withoutClaudeSuggestion(vt, screen, 0).join('\n')).trim(), '');
    vt.dispose();
  }
});

test('preserves genuine drafts, accepted suggestions and mixed styling', async () => {
  for (const [body, cursor] of [['real draft', 3], ['\x1b[2msuggestion\x1b[22m', 8], ['\x1b[2mgray\x1b[22m real', 3]]) {
    const { vt, lines } = await fixture(body, cursor);
    assert.deepEqual(withoutClaudeSuggestion(vt, lines, 0), lines);
    vt.dispose();
  }
});
