'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { textOf, isNoise, codexLine } = require('./searchindex');

function isClaudeVisibleMsg(e) {
  if (!e || (e.type !== 'user' && e.type !== 'assistant')) return false;
  if (e.isMeta || e.isSidechain) return false;
  const text = textOf(e.message?.content);
  return !!(text && !isNoise(text));
}

function claudeMessageLineIndices(lines) {
  const indices = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (isClaudeVisibleMsg(e)) indices.push(i);
  }
  return indices;
}

function codexMessageLineIndices(lines) {
  const indices = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const r = codexLine(e);
    if (r?.msg) indices.push(i);
  }
  return indices;
}

function ensureBackup(sourceFile, sessionId, backupDir) {
  if (!backupDir) return null;
  fs.mkdirSync(backupDir, { recursive: true });
  const safeId = String(sessionId || 'session').replace(/[^a-zA-Z0-9_-]/g, '');
  const out = path.join(backupDir, `${safeId}-${Date.now()}.jsonl`);
  fs.copyFileSync(sourceFile, out);
  return out;
}

/**
 * Fork a Claude JSONL session up to `cutIndex` (inclusive by default, or exclusive when inclusive=false).
 */
function forkClaudeJsonlAt({ sourceFile, newSessionId = crypto.randomUUID(), cutIndex, inclusive = true, title = '' }) {
  if (!sourceFile || !fs.existsSync(sourceFile)) throw new Error('원본 Claude 대화 파일을 찾을 수 없습니다.');
  const raw = fs.readFileSync(sourceFile, 'utf8');
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const msgIndices = claudeMessageLineIndices(lines);
  if (!msgIndices.length) throw new Error('분기할 대화 메시지가 없습니다.');

  const maxIdx = msgIndices.length - 1;
  const clamped = Math.max(0, Math.min(maxIdx, Number(cutIndex) || 0));
  const targetMsgIdx = inclusive ? clamped : clamped - 1;
  const stopLine = targetMsgIdx >= 0 ? msgIndices[targetMsgIdx] : Math.max(-1, msgIndices[0] - 1);

  const outLines = [];
  for (let i = 0; i <= stopLine; i++) {
    try {
      const obj = JSON.parse(lines[i]);
      if (obj && typeof obj === 'object' && ('sessionId' in obj || obj.type === 'user' || obj.type === 'assistant' || obj.type === 'attachment' || obj.type === 'system' || obj.type === 'queue-operation')) {
        obj.sessionId = newSessionId;
      }
      outLines.push(JSON.stringify(obj));
    } catch {
      outLines.push(lines[i]);
    }
  }
  if (title) {
    outLines.push(JSON.stringify({ type: 'custom-title', customTitle: String(title).slice(0, 120), sessionId: newSessionId }));
  }

  const outFile = path.join(path.dirname(sourceFile), `${newSessionId}.jsonl`);
  fs.writeFileSync(outFile, outLines.join('\n') + '\n', 'utf8');
  return { file: outFile, newSessionId, messageCount: Math.max(0, targetMsgIdx + 1) };
}

/**
 * Edit or rewind a Claude JSONL session file at message index `atIndex`.
 */
function editClaudeJsonlAt({ sourceFile, sessionId, atIndex, newText, mode = 'save', backupDir }) {
  if (!sourceFile || !fs.existsSync(sourceFile)) throw new Error('원본 Claude 대화 파일을 찾을 수 없습니다.');
  const raw = fs.readFileSync(sourceFile, 'utf8');
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const msgIndices = claudeMessageLineIndices(lines);
  const idx = Number(atIndex);
  if (!Number.isInteger(idx) || idx < 0 || idx >= msgIndices.length) {
    throw new Error('수정할 메시지를 원본 기록에서 찾을 수 없습니다.');
  }

  ensureBackup(sourceFile, sessionId, backupDir);
  const targetLine = msgIndices[idx];

  if (mode === 'rewind') {
    const kept = lines.slice(0, targetLine);
    fs.writeFileSync(sourceFile, kept.length ? kept.join('\n') + '\n' : '', 'utf8');
    return { ok: true, mode: 'rewind', keptLines: kept.length };
  }

  const obj = JSON.parse(lines[targetLine]);
  if (typeof obj.message?.content === 'string') {
    obj.message.content = String(newText);
  } else if (Array.isArray(obj.message?.content)) {
    const nonText = obj.message.content.filter((c) => c && c.type !== 'text');
    obj.message.content = [{ type: 'text', text: String(newText) }, ...nonText];
  } else {
    obj.message = { ...(obj.message || {}), content: String(newText) };
  }
  lines[targetLine] = JSON.stringify(obj);
  fs.writeFileSync(sourceFile, lines.join('\n') + '\n', 'utf8');
  return { ok: true, mode: 'save' };
}

/**
 * Edit a message in a Codex rollout JSONL file at message index `atIndex`.
 */
function editCodexJsonlAt({ sourceFile, sessionId, atIndex, newText, backupDir }) {
  if (!sourceFile || !fs.existsSync(sourceFile)) throw new Error('원본 Codex 대화 파일을 찾을 수 없습니다.');
  const raw = fs.readFileSync(sourceFile, 'utf8');
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const msgIndices = codexMessageLineIndices(lines);
  const idx = Number(atIndex);
  if (!Number.isInteger(idx) || idx < 0 || idx >= msgIndices.length) {
    throw new Error('수정할 메시지를 원본 기록에서 찾을 수 없습니다.');
  }

  const targetLine = msgIndices[idx];
  const obj = JSON.parse(lines[targetLine]);
  const pl = obj?.payload;
  if (!pl || pl.type !== 'message') {
    throw new Error('도구 호출 로그는 직접 수정할 수 없습니다.');
  }
  ensureBackup(sourceFile, sessionId, backupDir);

  if (typeof pl.content === 'string') {
    pl.content = String(newText);
  } else if (Array.isArray(pl.content)) {
    const nonText = pl.content.filter((c) => c && c.type !== 'input_text' && c.type !== 'output_text' && c.type !== 'text');
    const txtType = pl.role === 'user' ? 'input_text' : 'output_text';
    pl.content = [{ type: txtType, text: String(newText) }, ...nonText];
  } else {
    pl.content = [{ type: pl.role === 'user' ? 'input_text' : 'output_text', text: String(newText) }];
  }
  lines[targetLine] = JSON.stringify(obj);
  fs.writeFileSync(sourceFile, lines.join('\n') + '\n', 'utf8');
  return { ok: true, mode: 'save' };
}

/**
 * Write a structured Markdown branch-context file for Codex / AGY / cross-CLI branching.
 */
function writeBranchContextFile({
  uploadsDir,
  sourceSessionId,
  sourceTitle = '',
  sourceAgent = 'claude',
  targetAgent = 'claude',
  cwd = '',
  messages = [],
  atIndex = 0,
  inclusive = true,
  editedText = '',
  followUp = '',
}) {
  fs.mkdirSync(uploadsDir, { recursive: true });
  const tag = `${String(sourceSessionId || 'branch').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 12)}-${Date.now().toString(36)}`;
  const file = path.join(uploadsDir, `branch-${tag}.md`);

  const count = inclusive ? Math.min(messages.length, Number(atIndex) + 1) : Math.max(0, Math.min(messages.length, Number(atIndex)));
  const slice = messages.slice(0, count).filter((m) => m && !String(m.text || '').startsWith('⚙'));
  const recent = slice.slice(-24);

  const lines = [
    `# 대화 분기점 맥락 (${String(sourceAgent).toUpperCase()} → ${String(targetAgent).toUpperCase()})`,
    `- 원본 세션 ID: ${sourceSessionId || 'unknown'}`,
    sourceTitle ? `- 원본 제목: ${String(sourceTitle).split('\n')[0].slice(0, 120)}` : null,
    cwd ? `- 작업 폴더: ${cwd}` : null,
    `- 분기 기준: 총 ${messages.length}개 메시지 중 ${count}번째까지 유지`,
    '',
    '## 분기점까지의 대화 내용',
  ].filter((x) => x !== null);

  if (slice.length > recent.length) {
    lines.push(`\n_(앞선 일반 대화 ${slice.length - recent.length}건 생략 — 핵심 최근 맥락 ${recent.length}건 포함)_`);
  }
  if (!recent.length) {
    lines.push('\n_(이전 대화 메시지 없음 — 새 요청부터 시작합니다)_');
  } else {
    recent.forEach((m, idx) => {
      const who = m.role === 'user' ? '사용자 (User)' : `이전 에이전트 (${sourceAgent})`;
      const txt = String(m.text || '').replace(/<external_codex_apps_[^>]*>[\s\S]*?<\/external_codex_apps_[^>]*>/gi, '').trim().slice(0, 1800);
      if (txt) lines.push(`\n### [${idx + 1}. ${who}]\n${txt}`);
    });
  }

  if (editedText) {
    lines.push('', '## [수정된 분기점 요청 — 이 내용을 바로 실행하세요]', String(editedText).trim());
  } else if (followUp) {
    lines.push('', '## [분기 후 후속 요청 — 이 내용을 바로 실행하세요]', String(followUp).trim());
  } else {
    lines.push('', '## 안내', '위 분기점까지의 맥락을 이어서 준비하고, 한 줄로 준비 완료를 알린 뒤 다음 지시를 기다려 주세요.');
  }

  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  const instruction = (editedText || followUp)
    ? `"${file}" 파일을 먼저 읽고 그 안의 분기 맥락과 마지막 요청을 바로 실행해 주세요.`
    : `"${file}" 파일을 먼저 읽고 이 분기점까지의 맥락을 파악해 둔 뒤, 준비 완료를 짧게 알리고 다음 지시를 기다려 주세요.`;
  return { file, instruction };
}

function createBranchStore(filePath) {
  let state = { branches: [], titles: {}, msgEdits: {} };
  let rev = 1;
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (raw && typeof raw === 'object') {
      state = {
        branches: Array.isArray(raw.branches) ? raw.branches : [],
        titles: raw.titles && typeof raw.titles === 'object' ? raw.titles : {},
        msgEdits: raw.msgEdits && typeof raw.msgEdits === 'object' ? raw.msgEdits : {},
      };
    }
  } catch {}
  state.titles = Object.assign(Object.create(null), state.titles);

  const save = () => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, filePath);
    rev++;
  };

  return {
    rev() { return rev; },
    getTitle(id) {
      const entry = state.titles[id];
      return (typeof entry === 'string' ? entry : entry?.title) || null;
    },
    baseTitle(id, title) {
      return state.titles[id]?.clearedTitle === title ? null : title;
    },
    hasTitleSetting(id) {
      return Object.hasOwn(state.titles, id);
    },
    setTitle(id, title) {
      const clean = String(title || '').trim().slice(0, 140);
      const previous = state.titles[id];
      state.titles[id] = { title: clean, clearedTitle: typeof previous === 'string' ? previous : previous?.clearedTitle };
      try { save(); }
      catch (error) {
        if (previous === undefined) delete state.titles[id];
        else state.titles[id] = previous;
        throw error;
      }
      return clean || null;
    },
    getMsgEdits(id) {
      return state.msgEdits[id] || {};
    },
    setMsgEdit(id, atIndex, text) {
      if (!state.msgEdits[id]) state.msgEdits[id] = {};
      state.msgEdits[id][String(atIndex)] = { text: String(text), editedAt: Date.now() };
      save();
    },
    clearMsgEditsFrom(id, fromIndex) {
      const map = state.msgEdits[id];
      if (!map) return;
      let changed = false;
      for (const k of Object.keys(map)) {
        if (Number(k) >= Number(fromIndex)) { delete map[k]; changed = true; }
      }
      if (!Object.keys(map).length) delete state.msgEdits[id];
      if (changed) save();
    },
    addBranch(entry) {
      const rec = { id: crypto.randomUUID(), createdAt: Date.now(), ...entry };
      state.branches.push(rec);
      if (state.branches.length > 500) state.branches = state.branches.slice(-500);
      save();
      return rec;
    },
    resolveLinks(termsMap, termSessionIdFn) {
      let dirty = false;
      for (const b of state.branches) {
        if (!b.childSessionId && b.termId && termsMap) {
          const t = termsMap.get(String(b.termId));
          if (t) {
            const sid = termSessionIdFn(t);
            if (sid && sid !== b.parentSessionId) {
              b.childSessionId = sid;
              if (b.branchTitle && !state.titles[sid]) {
                state.titles[sid] = String(b.branchTitle).trim().slice(0, 140);
              }
              dirty = true;
            }
          }
        }
      }
      if (dirty) save();
    },
    lineageFor(sessionId, lookupTitleFn = () => null) {
      const parentRec = sessionId ? (state.branches.find((b) => b.childSessionId === sessionId) || null) : null;
      const children = sessionId
        ? state.branches
          .filter((b) => b.parentSessionId === sessionId)
          .map((b) => {
            const fallbackLabel = b.branchTitle || (b.editedText ? `(분기) ${String(b.editedText).split('\n')[0].slice(0, 36)}` : null);
            return {
              ...b,
              childTitle: (b.childSessionId ? lookupTitleFn(b.childSessionId) : null) || fallbackLabel,
            };
          })
        : [];
      const parent = parentRec ? { ...parentRec, parentTitle: lookupTitleFn(parentRec.parentSessionId) } : null;
      return { parent, children };
    },
    branchMetaFor({ sessionId = null, termId = null, lookupTitleFn = () => null } = {}) {
      const parentRec = (sessionId && state.branches.find((b) => b.childSessionId === sessionId))
        || (termId != null ? state.branches.find((b) => !b.childSessionId && String(b.termId) === String(termId)) : null)
        || null;
      const childCount = sessionId ? state.branches.filter((b) => b.parentSessionId === sessionId).length : 0;
      if (!parentRec && !childCount) return null;
      const fallbackTitle = parentRec
        ? (parentRec.branchTitle || (parentRec.editedText ? `(분기) ${String(parentRec.editedText).split('\n')[0].slice(0, 36)}` : null))
        : null;
      return {
        isBranch: !!parentRec,
        parentSessionId: parentRec?.parentSessionId || null,
        parentTitle: parentRec ? lookupTitleFn(parentRec.parentSessionId) : null,
        branchTitle: fallbackTitle,
        atIndex: parentRec?.atIndex ?? null,
        mode: parentRec?.mode || null,
        editedText: parentRec?.editedText || '',
        childCount,
      };
    },
  };
}

module.exports = {
  claudeMessageLineIndices,
  codexMessageLineIndices,
  forkClaudeJsonlAt,
  editClaudeJsonlAt,
  editCodexJsonlAt,
  writeBranchContextFile,
  createBranchStore,
};
