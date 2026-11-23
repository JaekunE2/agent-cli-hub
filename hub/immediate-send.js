'use strict';

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

/** Check whether the pending prompt (or pasted placeholder) appears in normalized screen text. */
function hasPromptOnScreen(scr, rawMsg) {
  if (!scr) return false;
  const head = rawMsg.slice(0, 20);
  const tail = rawMsg.length > 20 ? rawMsg.slice(-20) : '';
  return !!((head && scr.includes(head)) || (tail && scr.includes(tail)) || /\[pasted text/i.test(scr));
}

const AGY_ALTM_RE = /alt\s*\+\s*m\s*(?:to\s*)?send(?:\s*immediately)?|queued.*alt\s*\+\s*m/i;
const CODEX_QUEUE_RE = /tab to (?:queue|steer)|queued/i;
const CLAUDE_QUEUE_RE = /up to edit|queued/i;

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
  submitDelay = 350,
}) {
  const rawMsg = normScreenText(text);
  const bottomBox = normScreenText(readNormLines(5));
  const bottom12 = normScreenText(readNormLines(12));
  const screen40 = normScreenText(readNormLines(40));

  // AGY shows "alt+m to send immediately" while a prompt is queued; send Alt+M directly without duplicating text.
  if (cli === 'agy' && AGY_ALTM_RE.test(screen40)) {
    write(PTY_KEYS['alt+m']);
    return { handled: true, result: { ok: true, immediate: true, flushedQueued: true, steered: true } };
  }

  // 1) Already sitting unsubmitted in the bottom input box -> submit/steer without re-typing text.
  if (hasPromptOnScreen(bottomBox, rawMsg)) {
    if (cli === 'codex' && isBusy() && CODEX_QUEUE_RE.test(bottom12)) {
      write(PTY_KEYS.tab);
      return { handled: true, result: { ok: true, immediate: true, steered: true } };
    }
    if (cli === 'claude' && isBusy() && CLAUDE_QUEUE_RE.test(bottom12)) {
      write(PTY_KEYS.esc);
      await sleep(450);
      if (hasPromptOnScreen(normScreenText(readNormLines(12)), rawMsg)) write('\r');
      return { handled: true, result: { ok: true, immediate: true, flushedQueued: true } };
    }
    write('\r');
    if (cli === 'agy' && isBusy()) {
      await sleep(320);
      if (AGY_ALTM_RE.test(normScreenText(readNormLines(40)))) {
        write(PTY_KEYS['alt+m']);
        return { handled: true, result: { ok: true, immediate: true, steered: true, submittedExisting: true } };
      }
    }
    return { handled: true, result: { ok: true, immediate: true, submittedExisting: true } };
  }

  // 2) Already accepted/visible in CLI queue or scrollback -> steer per CLI, never duplicate text.
  if (resendIfMissing && hasPromptOnScreen(screen40, rawMsg)) {
    if (cli === 'codex' && isBusy() && CODEX_QUEUE_RE.test(screen40)) {
      write(PTY_KEYS.tab);
      return { handled: true, result: { ok: true, immediate: true, steered: true } };
    }
    if (cli === 'claude' && isBusy() && CLAUDE_QUEUE_RE.test(screen40)) {
      write(PTY_KEYS.esc);
      await sleep(450);
      if (hasPromptOnScreen(normScreenText(readNormLines(12)), rawMsg)) write('\r');
      return { handled: true, result: { ok: true, immediate: true, flushedQueued: true } };
    }
    return { handled: true, result: { ok: true, immediate: true, alreadyRecognized: true } };
  }

  // 3) CLI did not receive the prompt yet -> submit + Alt+M on busy AGY, or Esc-interrupt before normal write.
  if (isBusy()) {
    if (cli === 'agy') {
      if (text) {
        write(text);
        await sleep(submitDelay);
        write('\r');
        await sleep(320);
        const afterScr = normScreenText(readNormLines(40));
        if (AGY_ALTM_RE.test(afterScr)) {
          write(PTY_KEYS['alt+m']);
          return { handled: true, result: { ok: true, immediate: true, steered: true, flushedQueued: true } };
        }
        if (hasPromptOnScreen(afterScr, rawMsg)) {
          return { handled: true, result: { ok: true, immediate: true } };
        }
      }
      write(PTY_KEYS.esc);
      await sleep(500);
      return { handled: false };
    }
    if (cli !== 'codex') {
      write(PTY_KEYS.esc);
      await sleep(500);
      const afterBottom = normScreenText(readNormLines(12));
      const afterScr = normScreenText(readNormLines(40));
      if (hasPromptOnScreen(afterBottom, rawMsg)) {
        write('\r');
        return { handled: true, result: { ok: true, immediate: true, submittedExisting: true } };
      }
      if (resendIfMissing && hasPromptOnScreen(afterScr, rawMsg)) {
        return { handled: true, result: { ok: true, immediate: true, alreadyRecognized: true } };
      }
    }
  }

  return { handled: false };
}

module.exports = { PTY_KEYS, dispatchImmediatePrompt, hasPromptOnScreen, normScreenText, AGY_ALTM_RE, codexHistorySearchActive };
