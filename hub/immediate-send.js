'use strict';

const { composerText, isPlaceholder } = require('./prompt-submission');

const PTY_KEYS = {
  enter: '\r',
  esc: '\x1b',
  tab: '\t',
  backspace: '\x7f',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  'ctrl+c': '\x03',
  'shift+tab': '\x1b[Z',
  'alt+m': '\x1bm',
};

const normScreenText = (s) => String(s || '').replace(/\s+/g, ' ').trim();

function codexHistorySearchActive(lines) {
  return /^reverse-i-search:/i.test(lines.findLast((line) => line.trim())?.trimStart() || '');
}

const AGY_ALTM_RE = /alt\s*\+\s*m\s*(?:to\s*)?send(?:\s*immediately)?|queued.*alt\s*\+\s*m/i;
const CODEX_QUEUE_RE = /tab to (?:queue|steer)/i;
const CLAUDE_QUEUE_RE = /up to edit|^\s*queued:/im;

async function flushNewAgyQueue(view, baseline, write) {
  const hasQueue = ({ screen }) => AGY_ALTM_RE.test(screen.split('\n').slice(-12).join('\n'));
  if (hasQueue(baseline) || !hasQueue(view)) return false;
  await write(PTY_KEYS['alt+m']);
  return true;
}

/**
 * CLI-aware immediate / duplicate-free prompt dispatch for running PTY terminals.
 * Returns `{ handled, result }` where `handled: false` means caller should proceed to write `text`/`keys`/`submit`.
 */
async function dispatchImmediatePrompt({
  cli,
  isBusy,
  readNormLines,
  write,
  sleep,
  text = '',
  resendIfMissing = false,
}) {
  const rawMsg = normScreenText(text);
  const bottom = await readNormLines(12);
  const screen = await readNormLines(40);
  const busy = await isBusy();
  const matches = (view) => !!rawMsg && normScreenText(composerText(view)) === rawMsg;
  const draft = composerText(bottom);
  if (draft && !isPlaceholder(draft) && !matches(bottom)) return { handled: false };
  const seen = !!rawMsg && normScreenText(screen).includes(rawMsg);
  const handled = (result) => ({ handled: true, result: { ok: true, immediate: true, ...result } });

  if (cli === 'agy' && AGY_ALTM_RE.test(bottom)) {
    await write(PTY_KEYS['alt+m']);
    return handled({ flushedQueued: true, steered: true });
  }
  if (busy && cli === 'codex' && (matches(bottom) || resendIfMissing && seen) && CODEX_QUEUE_RE.test(bottom)) {
    await write(PTY_KEYS.tab);
    return handled({ steered: true });
  }
  if (busy && cli === 'claude' && (matches(bottom) || resendIfMissing && seen) && CLAUDE_QUEUE_RE.test(bottom)) {
    await write(PTY_KEYS.esc);
    await sleep(450);
    if (!matches(await readNormLines(12))) return { handled: false };
    await write(PTY_KEYS.enter);
    return handled({ flushedQueued: true });
  }
  if (busy && resendIfMissing && seen && !composerText(bottom)) return handled({ alreadyRecognized: true });

  if (busy && cli === 'claude' && rawMsg) {
    await write(PTY_KEYS.esc);
    await sleep(450);
  }

  return { handled: false };
}

module.exports = { PTY_KEYS, dispatchImmediatePrompt, flushNewAgyQueue, normScreenText, AGY_ALTM_RE, codexHistorySearchActive };
