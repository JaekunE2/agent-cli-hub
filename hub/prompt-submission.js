'use strict';

const DRAFT = 'CLI 입력창에 제출되지 않은 다른 내용이 있습니다. 터미널에서 내용을 확인하세요.';
const UNCONFIRMED = '작업 지시를 제출했지만 CLI가 실행을 시작했다는 신호가 없습니다.';
const PASTE = /^\[+pasted (?:content|text) (\d+) chars?\]+$/i;
const PASTE_MARKER = /^\[+pasted (?:content|text) \d+ chars?\]+/i;
const unwrap = (text) => text.trim().replace(/ *\n[ \t]*/g, ' ');

const FOOTER_LINE_RE = /^\s*(?:[─━╰└]{3,}|[^\n]+ · (?:[A-Z]:[\\/]|~|\/)[^\n]*|← for agents\s*·\s*\? for shortcuts|\? for shortcuts|esc to (?:interrupt|cancel)|alt\s*\+\s*m\s*(?:to\s*)?send|tab to (?:queue|steer)|⚠\s+\d+\s+warnings?\s*·\s*f2 to view)(?:[ \t]+(?:⚠\s+\d+\s+warnings?\s*·\s*f2 to view|\? for shortcuts|[^\n]+ · (?:[A-Z]:[\\/]|~|\/)[^\n]*))*\s*$/i;

function composerText(screen, cursorLine) {
  const lines = screen.trimEnd().split('\n');
  const start = lines.findLastIndex((line) => /^\s*[›❯>](?:\s|$)/.test(line));
  if (start < 0) return null;
  const draft = lines.slice(start).join('\n').replace(/^[ \t]*[›❯>][ \t]*/, '').split(
    /\n\s*(?:[─━╰└]{3,}|[^\n]+ · (?:[A-Z]:[\\/]|~|\/)|← for agents\s*·\s*\? for shortcuts|\? for shortcuts|esc to (?:interrupt|cancel)|alt\s*\+\s*m\s*(?:to\s*)?send|tab to (?:queue|steer))/i, 1
  )[0].replace(/[ \t]{2,}(?:⚠\s+\d+\s+warnings?\s*·\s*f2 to view|\? for shortcuts)[ \t]*$/gim, '');
  const draftLines = draft.split('\n').length;
  if (Number.isFinite(cursorLine)) {
    const trailing = lines.slice(start + draftLines).filter((l) => l.trim().length > 0);
    const onlyFooterBelow = trailing.every((l) => FOOTER_LINE_RE.test(l));
    // Reject stale › prompts in scrollback when non-footer UI (menus/dialogs) sits below or cursor is outside a non-bottom prompt.
    if (!onlyFooterBelow && (cursorLine < start || cursorLine >= start + draftLines)) return null;
    // Even at the bottom composer, reject if cursor moved far above the prompt into an overlay/menu.
    if (cursorLine < start - 1 && !isPlaceholder(draft)) return null;
  }
  return draft.trimEnd();
}

const hasCodexPasteDraft = (screen, cursorLine) => PASTE_MARKER.test(composerText(screen, cursorLine)?.trimStart() || '');

const isPlaceholder = (text) => /^(?:Ask Codex to do anything|Ask anything|Type (?:your|a) message|Message Claude|Try\s+"[^"\n]+")(?:[.…]+)?$/i.test((text || '').trim());

async function submitPrompt({ text, read, write, guard, waitFor, sleep, delay = 350,
  started, paste = text, explicitDraft = false, clearDraft = false, queueKey, pasteMarker, flushQueue, previousDraft, onDraft, resend = false }) {
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) throw new Error('CLI 메시지에 제어 문자를 보낼 수 없습니다.');
  const expected = unwrap(text);
  const matched = (draft) => draft != null && unwrap(draft) === expected;
  const compact = (value) => value.replace(/[\s\u00b7]/g, '');
  const expectedCompact = compact(text);
  const renderedMatch = (draft) => matched(draft) || (!!draft && !PASTE_MARKER.test(draft.trimStart())
    && compact(draft) === expectedCompact);
  const wrappedRetry = (draft) => resend && (pasteMarker === 'codex' || pasteMarker === 'agy') && draft?.includes('\n')
    && new RegExp('^' + draft.split(/\n/).map((line) => line.trim()).filter(Boolean)
      .map((line) => line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(' *') + '$').test(expected);
  const tail = expectedCompact.slice(-64);
  let pasted = false;
  const visibleTail = (draft) => {
    const visible = compact(draft || '');
    if (!visible || PASTE_MARKER.test(draft?.trimStart() || '')) return false;
    if (expectedCompact.length <= visible.length) return false;
    if (visible.length >= 48 && expectedCompact.endsWith(visible.slice(-48))) return true;
    return pasted && visible.length >= 16 && (
      expectedCompact.endsWith(visible.slice(-Math.min(visible.length, 48)))
      || expectedCompact.includes(visible)
    );
  };
  const freshPaste = (draft) => {
    const shown = draft?.trimStart() || '';
    if (pasteMarker === 'claude') {
      const lines = Number(/^\[pasted text #\d+ \+(\d+) lines?\]$/i.exec(shown)?.[1]);
      return lines === text.split('\n').length - 1;
    }
    if (pasteMarker === 'agy' && /^\[pasted(?:\s+(?:content|text))?(?:\s+#?\d+)?(?:\s+\+?\d+\s*(?:lines?|chars?))?\]$/i.test(shown)) {
      return true;
    }
    if (pasteMarker !== 'codex') return false;
    const matchBadge = (line) => {
      const m = PASTE.exec(line.trim());
      if (!m) return false;
      const count = Number(m[1]);
      if (count === text.length || count === Array.from(text).length) return true;
      const lineDiff = Math.max(32, (text.match(/\n/g) || []).length * 2 + 8);
      return pasted && (Math.abs(count - text.length) <= lineDiff || Math.abs(count - Array.from(text).length) <= lineDiff);
    };
    if (matchBadge(shown)) return true;
    return pasted && clearDraft && shown.split('\n').some(matchBadge);
  };
  const current = async () => {
    const view = await read();
    await guard(view);
    return { ...view, draft: composerText(view.screen, view.cursorLine) };
  };
  let view = await current();
  if (view.draft == null) await waitFor(async () => {
    view = await current();
    return view.draft != null;
  }, 5000, 150);
  let draft = view.draft;
  const alreadyPresent = matched(draft) || wrappedRetry(draft) || (!!draft && draft === previousDraft)
    || (explicitDraft && draft && (freshPaste(draft) || (!PASTE_MARKER.test(draft.trimStart()) && expected.endsWith(unwrap(draft)))));
  if (!alreadyPresent) {
    if (draft && !isPlaceholder(draft)) {
      if (clearDraft && !explicitDraft) {
        await write('\x05\x15');
        let cleared = await waitFor(async () => {
          view = await current();
          return !view.draft || isPlaceholder(view.draft);
        }, 1200, 120);
        if (!cleared) {
          await write('\x01\x0b');
          cleared = await waitFor(async () => {
            view = await current();
            return !view.draft || isPlaceholder(view.draft);
          }, 900, 120);
        }
        if (!cleared && !view.busy) {
          await write('\x03');
          cleared = await waitFor(async () => {
            view = await current();
            return !view.draft || isPlaceholder(view.draft);
          }, 900, 120);
        }
        draft = view.draft;
      }
      if (draft && !isPlaceholder(draft)) throw new Error(DRAFT);
    }
    if (explicitDraft) throw new Error('CLI 입력창에서 전송한 내용을 확인하지 못했습니다.');
    if (draft == null) throw new Error('CLI 입력창을 확인하지 못했습니다.');
    await write(paste);
    pasted = true;
    const hasPaste = async () => {
      view = await current();
      return view.draft !== draft && (renderedMatch(view.draft) || freshPaste(view.draft) || visibleTail(view.draft));
    };
    if (!await waitFor(hasPaste, 10000, 150)) {
      try {
        require('fs').appendFileSync(require('path').join(__dirname, 'server.log'),
          `[${new Date().toISOString()}] [submitPrompt:hasPaste-timeout] cli=${pasteMarker} textLen=${text.length} draft=${JSON.stringify(draft)} lastDraft=${JSON.stringify(view?.draft)} cursorLine=${view?.cursorLine}\n`);
      } catch {}
      throw new Error('CLI 입력창에서 전송한 내용을 확인하지 못했습니다.');
    }
    draft = view.draft;
    onDraft?.(draft);
    await sleep(paste !== text ? Math.max(delay, 450) : delay);
  }
  const sameDraft = (next) => next === draft || (pasted && (renderedMatch(next) || freshPaste(next) || visibleTail(next)));
  view = await current();
  if (!sameDraft(view.draft)) {
    await waitFor(async () => {
      view = await current();
      return sameDraft(view.draft);
    }, 1500, 150);
  }
  if (!sameDraft(view.draft)) {
    if (view.draft && !isPlaceholder(view.draft)) throw new Error(DRAFT);
    try {
      require('fs').appendFileSync(require('path').join(__dirname, 'server.log'),
        `[${new Date().toISOString()}] [submitPrompt:sameDraft-fail] cli=${pasteMarker} textLen=${text.length} pasted=${pasted} draft=${JSON.stringify(draft)} viewDraft=${JSON.stringify(view?.draft)} cursorLine=${view?.cursorLine}\n`);
    } catch {}
    throw new Error('CLI 입력창에서 전송한 내용을 확인하지 못했습니다.');
  }
  onDraft?.(view.draft);
  let baseline = view;
  const since = Date.now();
  const key = queueKey?.(view) || '\r';
  const accepted = async () => {
    view = await current();
    return !sameDraft(view.draft) && (key !== '\r' || await flushQueue?.(view, baseline, write) || await started(view, baseline, since));
  };
  await write(key);
  if (await waitFor(accepted, pasteMarker === 'agy' ? 1800 : 2500, 150)) return;
  if (await accepted()) return;
  if (key === '\r' && sameDraft(view.draft)) {
    baseline = view;
    await write('\r');
    if (clearDraft) {
      if (await waitFor(accepted, 3500, 150)) return;
      if (sameDraft(view.draft)) {
        baseline = view;
        await write('\r');
      }
    }
  }
  if (!await waitFor(accepted, 8000, 150)) {
    if (sameDraft(view.draft)) onDraft?.(view.draft);
    throw new Error(UNCONFIRMED);
  }
}

module.exports = { composerText, hasCodexPasteDraft, isPlaceholder, submitPrompt };
