'use strict';

const DRAFT = 'CLI 입력창에 제출되지 않은 다른 내용이 있습니다. 터미널에서 내용을 확인하세요.';
const UNCONFIRMED = '작업 지시를 제출했지만 CLI가 실행을 시작했다는 신호가 없습니다.';
const PASTE = /^\[pasted (?:content|text) (\d+) chars?\]/i;
const unwrap = (text) => text.trim().replace(/ *\n[ \t]*/g, ' ');

function composerText(screen, cursorLine) {
  const lines = screen.trimEnd().split('\n');
  const start = lines.findLastIndex((line) => /^\s*[›❯>](?:\s|$)/.test(line));
  if (start < 0 || cursorLine < start) return null;
  const draft = lines.slice(start).join('\n').replace(/^[ \t]*[›❯>][ \t]*/, '').split(
    /\n\s*(?:[─━]{3,}|[^\n]+ · (?:[A-Z]:[\\/]|~|\/)|\? for shortcuts|esc to interrupt|tab to (?:queue|steer))/i, 1
  )[0];
  if (cursorLine >= start + draft.split('\n').length) return null;
  return draft.trimEnd();
}

const hasCodexPasteDraft = (screen, cursorLine) => PASTE.test(composerText(screen, cursorLine)?.trimStart() || '');

const isPlaceholder = (text) => /^(?:Ask Codex to do anything|Ask anything|Type (?:your|a) message)(?:[.…]+)?$/i.test(text || '');

async function submitPrompt({ text, read, write, guard, waitFor, sleep, delay = 350,
  started, paste = text, explicitDraft = false, queueKey, pasteMarker, flushQueue }) {
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) throw new Error('CLI 메시지에 제어 문자를 보낼 수 없습니다.');
  const expected = unwrap(text);
  const matched = (draft) => draft != null && unwrap(draft) === expected;
  const compact = (value) => value.replace(/[\s?]/g, '');
  const expectedCompact = compact(text);
  const tail = expectedCompact.slice(-64);
  const visibleTail = (draft) => {
    const visible = compact(draft || '');
    return pasteMarker === 'codex' && expectedCompact.length > visible.length && visible.length >= 64 && visible.endsWith(tail);
  };
  const freshPaste = (draft) => {
    const shown = draft?.trimStart() || '';
    if (pasteMarker === 'claude') {
      const lines = Number(/^\[pasted text #\d+ \+(\d+) lines?\]$/i.exec(shown)?.[1]);
      return lines === text.split('\n').length - 1;
    }
    if (pasteMarker !== 'codex') return false;
    const count = Number(PASTE.exec(shown)?.[1]);
    return count === text.length || count === Array.from(text).length;
  };
  const current = async () => {
    const view = await read();
    await guard(view);
    return { ...view, draft: composerText(view.screen, view.cursorLine) };
  };
  let view = await current();
  let draft = view.draft;
  const alreadyPresent = matched(draft) || (explicitDraft && draft && (freshPaste(draft)
    || expected.endsWith(unwrap(draft))));
  if (!alreadyPresent) {
    if (explicitDraft || draft && !isPlaceholder(draft)) throw new Error(DRAFT);
    if (draft == null) throw new Error('CLI 입력창을 확인하지 못했습니다.');
    await write(paste);
    const hasPaste = async () => {
      view = await current();
      return matched(view.draft) || (view.draft !== draft && (freshPaste(view.draft) || visibleTail(view.draft)));
    };
    if (!await waitFor(hasPaste, 5000, 150)) throw new Error('CLI 입력창에서 전송한 내용을 확인하지 못했습니다.');
    draft = view.draft;
    await sleep(delay);
  }
  view = await current();
  if (view.draft !== draft) throw new Error(DRAFT);
  let baseline = view;
  const since = Date.now();
  const key = queueKey?.(view) || '\r';
  const accepted = async () => {
    view = await current();
    return view.draft !== draft && (key !== '\r' || await flushQueue?.(view, baseline, write) || await started(view, baseline, since));
  };
  await write(key);
  if (await waitFor(accepted, 2500, 150)) return;
  if (await accepted()) return;
  if (key === '\r' && !view.busy && view.draft === draft) {
    baseline = view;
    await write('\r');
  }
  if (!await waitFor(accepted, 8000, 150)) throw new Error(view.draft === draft ? DRAFT : UNCONFIRMED);
}

module.exports = { composerText, hasCodexPasteDraft, isPlaceholder, submitPrompt };
