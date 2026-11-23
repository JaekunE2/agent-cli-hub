'use strict';
const fs = require('fs');
const path = require('path');

/**
 * Persistent store for terminal-level events (mode/model/effort changes, interactive questions, selections)
 * that may not be emitted to CLI JSONL transcripts.
 */
function createTermEventStore(filePath, { maxEvents = 2000 } = {}) {
  let state = { events: [] };
  let rev = 1;

  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (raw && Array.isArray(raw.events)) state.events = raw.events;
  } catch {}

  const save = () => {
    rev++;
    if (!filePath) return;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const tmp = `${filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
      fs.renameSync(tmp, filePath);
    } catch {}
  };

  function record({ termId = null, sessionId = null, agent = '', kind = 'setting', role = 'assistant', text = '', ts = new Date().toISOString() }) {
    const cleanText = String(text || '').trim().slice(0, 1200);
    if (!cleanText) return null;
    const tid = termId != null ? String(termId) : null;
    const sid = sessionId ? String(sessionId) : null;
    const tsMs = Date.parse(ts) || Date.now();

    // Deduplicate identical consecutive events within 8s for the same term/session
    for (let i = state.events.length - 1; i >= 0 && i >= state.events.length - 12; i--) {
      const prev = state.events[i];
      const sameTarget = (sid && prev.sessionId === sid) || (tid && prev.termId === tid);
      if (!sameTarget) continue;
      const prevMs = Date.parse(prev.ts) || 0;
      if (prev.text === cleanText && Math.abs(tsMs - prevMs) < 8000) return prev;
    }

    const ev = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      termId: tid,
      sessionId: sid,
      agent: String(agent || ''),
      kind,
      role: role === 'user' ? 'user' : 'assistant',
      text: cleanText,
      ts: new Date(tsMs).toISOString(),
    };
    state.events.push(ev);
    if (state.events.length > maxEvents) state.events = state.events.slice(-maxEvents);
    save();
    return ev;
  }

  function bindSession(termId, sessionId) {
    if (termId == null || !sessionId) return 0;
    const tid = String(termId);
    const sid = String(sessionId);
    let changed = 0;
    for (const ev of state.events) {
      if (ev.termId === tid && !ev.sessionId) {
        ev.sessionId = sid;
        changed++;
      }
    }
    if (changed) save();
    return changed;
  }

  function forSession(sessionId) {
    if (!sessionId) return [];
    const sid = String(sessionId);
    return state.events
      .filter((e) => e.sessionId === sid)
      .sort((a, b) => (Date.parse(a.ts) || 0) - (Date.parse(b.ts) || 0));
  }

  function mergeIntoMessages(messages, sessionId) {
    const evs = forSession(sessionId);
    if (!evs.length) return messages;
    const base = Array.isArray(messages) ? messages.slice() : [];
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const seen = new Set(base.map((m) => `${m.role}|${norm(m.text).slice(0, 120)}`));
    const merged = base.map((m, idx) => ({ ...m, _order: idx }));
    for (const ev of evs) {
      const key = `${ev.role}|${norm(ev.text).slice(0, 120)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push({ role: ev.role, text: ev.text, ts: ev.ts, _fromTermEvent: true, _order: 1e9 });
    }
    merged.sort((a, b) => {
      const ta = Date.parse(a.ts || '');
      const tb = Date.parse(b.ts || '');
      if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb;
      return a._order - b._order;
    });
    return merged.map(({ _order, _fromTermEvent, ...rest }) => rest);
  }

  return {
    rev: () => rev,
    record,
    bindSession,
    forSession,
    mergeIntoMessages,
  };
}

/**
 * Extract mode, model, effort, and interactive prompt state from a terminal screen snapshot.
 */
function parseTerminalScreenState(screenText, agent = '') {
  const s = String(screenText || '');
  const lines = s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const tail = lines.slice(-18).join('\n');

  let mode = '';
  if (/plan mode/i.test(tail)) mode = 'plan';
  else if (/accept edits/i.test(tail)) mode = 'accept-edits';
  else if (/bypass permissions/i.test(tail)) mode = 'bypass';
  else if (/auto mode/i.test(tail)) mode = 'auto';
  else if (agent === 'codex') {
    if (/\bread-only\b/i.test(tail)) mode = 'read-only';
    else if (/\bfull access\b/i.test(tail)) mode = 'full-access';
    else if (/\bworkspace-write\b/i.test(tail)) mode = 'workspace-write';
  }

  let model = '';
  let effort = '';
  const claudeSet = /Set model to\s+([^\r\n(]+)/i.exec(tail);
  const codexSet = /Model changed to\s+([^\r\n(]+)/i.exec(tail);
  const statusModel = /(?:^|\s|\|)(claude-[\w.-]+|opus(?:\s+[\d.]+)?|sonnet(?:\s+[\d.]+)?|haiku(?:\s+[\d.]+)?|gpt-[\w.-]+|o[1-9][\w.-]*|gemini-[\w.-]+)(?:\s+(low|medium|high|xhigh|max))?/i.exec(tail);
  if (claudeSet) model = claudeSet[1].trim();
  else if (codexSet) model = codexSet[1].trim();
  else if (statusModel) {
    model = statusModel[1].trim();
    if (statusModel[2]) effort = statusModel[2].toLowerCase();
  }
  const effMatch = /(?:reasoning\s*effort|effort)\s*(?:set\s*to|:|=)\s*(low|medium|high|xhigh|max)\b/i.exec(tail);
  if (effMatch) effort = effMatch[1].toLowerCase();

  // Detect interactive question / selection prompt
  let prompt = null;
  const hasMenuHint = /Enter to select|Esc to cancel|Use arrow keys|Type something\.|Do you want to proceed\?/i.test(tail);
  const optionLines = lines.slice(-16).filter((l) => /^[>❯›●]?\s*\d+[.)]\s+\S/.test(l));
  if (hasMenuHint || optionLines.length >= 2) {
    const selected = optionLines.find((l) => /^[>❯›●]/.test(l)) || optionLines[0] || '';
    const firstOptIdx = optionLines.length ? lines.lastIndexOf(optionLines[0]) : -1;
    const questionLine = firstOptIdx > 0
      ? lines.slice(Math.max(0, firstOptIdx - 4), firstOptIdx).reverse().find((l) => /\?|:$|Select|Choose|선택|질문|진행/i.test(l) && !/^[─━═╭╰│]/.test(l)) || ''
      : (lines.slice(-10).find((l) => /Do you want to proceed\?|\?$/.test(l)) || '');
    if (optionLines.length || questionLine) {
      prompt = {
        question: questionLine.replace(/^[│┃\s]+/, '').trim().slice(0, 240),
        options: optionLines.map((l) => l.replace(/^[>❯›●]\s*/, '').trim()).slice(0, 6),
        selected: selected.replace(/^[>❯›●]\s*/, '').trim().slice(0, 160),
      };
    }
  }

  return { mode, model, effort, prompt };
}

/**
 * Monitors live terminal screens and user inputs to record mode/model/effort changes
 * and interactive question/selection answers into the term event store.
 */
function createTermScreenMonitor({ store, stripAnsi, readTerm, agentOf, getSessionId, onMetaChange }) {
  const timers = new Map();

  function inspect(t) {
    if (!t || t.exited !== null) return;
    const agent = agentOf(t);
    if (!agent) return;
    const raw = readTerm(t, 28).join('\n');
    const clean = stripAnsi ? stripAnsi(raw) : raw;
    const st = parseTerminalScreenState(clean, agent);

    if (st.prompt) {
      t._pendingPrompt = { ...st.prompt, seenAt: Date.now() };
    } else if (t._pendingPrompt && Date.now() - t._pendingPrompt.seenAt > 15000) {
      t._pendingPrompt = null;
    }

    const spawnedAt = t.meta?.spawnedAt || 0;
    const settled = Date.now() - spawnedAt > 2500;
    if (!t._lastScreenState) {
      t._lastScreenState = {
        mode: st.mode || '',
        model: st.model || t.meta?.model || '',
        effort: st.effort || t.meta?.effort || '',
      };
      return;
    }

    if (!settled) {
      if (st.mode) t._lastScreenState.mode = st.mode;
      if (st.model) t._lastScreenState.model = st.model;
      if (st.effort) t._lastScreenState.effort = st.effort;
      return;
    }

    const changes = [];
    if (st.mode && st.mode !== t._lastScreenState.mode) {
      t._lastScreenState.mode = st.mode;
      changes.push(`모드: ${st.mode}`);
    }
    if (st.model && st.model !== t._lastScreenState.model) {
      t._lastScreenState.model = st.model;
      changes.push(`모델: ${st.model}`);
    }
    if (st.effort && st.effort !== t._lastScreenState.effort) {
      t._lastScreenState.effort = st.effort;
      changes.push(`추론: ${st.effort}`);
    }

    if (changes.length) {
      const sid = getSessionId ? getSessionId(t) : (t.meta?.sessionId || null);
      if (onMetaChange) onMetaChange(t, { mode: t._lastScreenState.mode, model: t._lastScreenState.model, effort: t._lastScreenState.effort });
      store.record({
        termId: t.id,
        sessionId: sid,
        agent,
        kind: 'setting',
        role: 'assistant',
        text: `⚙ [터미널 변경] ${changes.join(' · ')}`,
      });
    }
  }

  function scheduleInspect(t, delay = 350) {
    if (!t) return;
    if (timers.has(t.id)) clearTimeout(timers.get(t.id));
    timers.set(t.id, setTimeout(() => {
      timers.delete(t.id);
      inspect(t);
    }, delay));
  }

  function onOutput(t) {
    scheduleInspect(t, 400);
  }

  function onInput(t, data) {
    if (!t || data == null) return;
    const s = String(data);
    const agent = agentOf(t);
    if (!agent) return;

    // Inspect immediately before submit if there's a pending interactive prompt
    if (t._pendingPrompt && (/[\r\n]/.test(s) || /^[1-9]$/.test(s.trim()))) {
      inspect(t);
      const p = t._pendingPrompt;
      if (p) {
        let chosen = p.selected;
        const num = /^[1-9]$/.exec(s.trim());
        if (num && p.options?.length) {
          const hit = p.options.find((o) => o.startsWith(`${num[0]}.`) || o.startsWith(`${num[0]})`));
          if (hit) chosen = hit;
        }
        const sid = getSessionId ? getSessionId(t) : (t.meta?.sessionId || null);
        if (p.question) {
          store.record({ termId: t.id, sessionId: sid, agent, kind: 'question', role: 'assistant', text: `❓ ${p.question}${p.options?.length ? ` [${p.options.join(' / ')}]` : ''}` });
        }
        if (chosen) {
          store.record({ termId: t.id, sessionId: sid, agent, kind: 'selection', role: 'user', text: `✓ [터미널 선택] ${chosen}` });
        }
        t._pendingPrompt = null;
      }
    }

    // Mode toggle (Shift+Tab: \x1b[Z) or slash command submit triggers quick follow-up checks
    if (s.includes('\x1b[Z') || /[\r\n]/.test(s)) {
      setTimeout(() => inspect(t), 250);
      setTimeout(() => inspect(t), 900);
    }
  }

  return { onOutput, onInput, inspect };
}

module.exports = { createTermEventStore, createTermScreenMonitor, parseTerminalScreenState };
