'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

// bindPromptHistory (public/ui.js) runs against a minimal textarea + localStorage stand-in
function load() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'ui.js'), 'utf8');
  const start = src.indexOf('  const HISTORY_MAX');
  const end = src.indexOf('  window.bindPromptHistory = bindPromptHistory;');
  assert.ok(start > 0 && end > start, 'prompt history block not found in ui.js');
  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  const ctx = { localStorage, JSON, Array, String };
  vm.runInNewContext(`${src.slice(start, end)}\nthis.bindPromptHistory = bindPromptHistory;`, ctx);
  return { bind: ctx.bindPromptHistory, store };
}

function textarea(value = '') {
  const handlers = { input: [], keydown: [] };
  const el = {
    value, selectionStart: value.length, selectionEnd: value.length,
    addEventListener: (type, fn) => handlers[type]?.push(fn),
    setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; },
    type(text) { this.value = text; this.selectionStart = this.selectionEnd = text.length; handlers.input.forEach((fn) => fn({})); },
    key(key, extra = {}) {
      const ev = { key, defaultPrevented: false, prevented: false, stopped: false, isComposing: false, keyCode: 0, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, ...extra,
        preventDefault() { this.prevented = true; this.defaultPrevented = true; }, stopImmediatePropagation() { this.stopped = true; } };
      handlers.keydown.forEach((fn) => fn(ev));
      return ev;
    },
  };
  return el;
}

test('up/down walk the sent prompts of the session and return to the draft', () => {
  const { bind } = load();
  const el = textarea();
  const h = bind(el, 'sid-a');
  h.sent('first'); h.sent('second\nline two');
  el.type('draft');
  assert.ok(el.key('ArrowUp').prevented);
  assert.equal(el.value, 'second\nline two');
  el.key('ArrowUp'); // caret is on the last line of a recalled prompt: still browsing
  assert.equal(el.value, 'first');
  assert.ok(el.key('ArrowUp').prevented, 'oldest entry: stays put');
  assert.equal(el.value, 'first');
  el.key('ArrowDown');
  assert.equal(el.value, 'second\nline two');
  el.key('ArrowDown');
  assert.equal(el.value, 'draft');
  assert.equal(el.key('ArrowDown').prevented, false, 'nothing newer than the draft: caret moves normally');
});

test('multi-line editing, IME composition and modifiers keep the arrow keys', () => {
  const { bind } = load();
  const el = textarea();
  bind(el, 'sid-b').sent('old prompt');
  el.type('line one\nline two');
  assert.equal(el.key('ArrowUp').prevented, false, 'caret on the second line');
  el.setSelectionRange(3, 3);
  assert.equal(el.key('ArrowUp', { isComposing: true }).prevented, false);
  assert.equal(el.key('ArrowUp', { keyCode: 229 }).prevented, false);
  assert.equal(el.key('ArrowUp', { shiftKey: true }).prevented, false);
  assert.equal(el.key('ArrowUp', { altKey: true }).prevented, false);
  assert.equal(el.key('ArrowUp', { defaultPrevented: true }).prevented, false, 'an open picker handled it');
  assert.ok(el.key('ArrowUp').prevented, 'first line: recalls');
  assert.equal(el.value, 'old prompt');
});

test('history is per session first, then shared; drafts survive a remount and clear on send', () => {
  const { bind, store } = load();
  const a = textarea();
  const ha = bind(a, 'sid-a');
  ha.sent('for a');
  const b = textarea();
  const hb = bind(b, 'sid-b');
  hb.sent('for b');
  const a2 = textarea();
  bind(a2, 'sid-a');
  a2.key('ArrowUp');
  assert.equal(a2.value, 'for a', 'own session first');
  a2.key('ArrowUp');
  assert.equal(a2.value, 'for b', 'then the shared history');
  a2.type('unsent');
  const a3 = textarea();
  const ha3 = bind(a3, 'sid-a');
  assert.equal(a3.value, 'unsent', 'draft restored');
  ha3.sent('unsent');
  assert.equal(store.has('ccd.draft.sid-a'), false);
  assert.deepEqual(JSON.parse(store.get('ccd.inputHistory.sid-a')), ['for a', 'unsent']);
});
