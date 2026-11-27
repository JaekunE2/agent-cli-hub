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

function newUuidV7(nowMs = Date.now()) {
  const bytes = crypto.randomBytes(16);
  const ms = BigInt(Math.max(0, Math.floor(nowMs)));
  bytes[0] = Number((ms >> 40n) & 0xffn);
  bytes[1] = Number((ms >> 32n) & 0xffn);
  bytes[2] = Number((ms >> 24n) & 0xffn);
  bytes[3] = Number((ms >> 16n) & 0xffn);
  bytes[4] = Number((ms >> 8n) & 0xffn);
  bytes[5] = Number(ms & 0xffn);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function inferCodexHomeFromFile(file) {
  if (!file || typeof file !== 'string') return null;
  const resolved = path.resolve(file);
  const m = /^(.*?)[\\/](?:sessions|archived_sessions)[\\/]/i.exec(resolved);
  return m && m[1] ? m[1] : null;
}

/**
 * Fork a Codex rollout JSONL session up to `cutIndex` (inclusive by default, or exclusive when inclusive=false).
 */
function forkCodexJsonlAt({
  sourceFile,
  codexHome = '',
  newSessionId = newUuidV7(),
  cutIndex,
  inclusive = true,
  cwd = '',
  title = '',
}) {
  if (!sourceFile || !fs.existsSync(sourceFile)) throw new Error('원본 Codex 대화 파일을 찾을 수 없습니다.');
  const raw = fs.readFileSync(sourceFile, 'utf8');
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const msgIndices = codexMessageLineIndices(lines);
  if (!msgIndices.length) throw new Error('분기할 대화 메시지가 없습니다.');

  const maxIdx = msgIndices.length - 1;
  const clamped = Math.max(0, Math.min(maxIdx, Number(cutIndex) || 0));
  const targetMsgIdx = inclusive ? clamped : clamped - 1;
  const stopLine = targetMsgIdx >= 0 ? msgIndices[targetMsgIdx] : Math.max(0, msgIndices[0] - 1);

  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  let metaCwd = cwd || process.cwd();
  let sourceId = '';
  let firstUserMsg = '';
  const outLines = [];

  for (let i = 0; i <= stopLine; i++) {
    try {
      const obj = JSON.parse(lines[i]);
      if (obj?.type === 'session_meta' && obj.payload && typeof obj.payload === 'object') {
        sourceId = obj.payload.id || obj.payload.session_id || sourceId;
        if (obj.payload.cwd && !cwd) metaCwd = obj.payload.cwd;
        obj.timestamp = nowIso;
        obj.payload.id = newSessionId;
        obj.payload.session_id = newSessionId;
        obj.payload.timestamp = nowIso;
        if (sourceId && sourceId !== newSessionId) obj.payload.forked_from_id = sourceId;
        obj.payload.history_mode = 'legacy';
        delete obj.payload.history_base;
      } else if (!firstUserMsg) {
        const parsed = codexLine(obj);
        if (parsed?.msg?.role === 'user' && parsed.msg.text) firstUserMsg = parsed.msg.text;
      }
      outLines.push(JSON.stringify(obj));
    } catch {
      outLines.push(lines[i]);
    }
  }

  const targetHome = codexHome || inferCodexHomeFromFile(sourceFile) || path.dirname(sourceFile);
  const now = new Date(nowMs);
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const stamp = nowIso.replace(/[:.]/g, '-').slice(0, 19);
  const sessDir = codexHome || inferCodexHomeFromFile(sourceFile)
    ? path.join(targetHome, 'sessions', yyyy, mm, dd)
    : path.dirname(sourceFile);
  fs.mkdirSync(sessDir, { recursive: true });
  const outFile = path.join(sessDir, `rollout-${stamp}-${newSessionId}.jsonl`);
  fs.writeFileSync(outFile, outLines.join('\n') + '\n', 'utf8');

  const effectiveTitle = String(title || firstUserMsg.split('\n')[0] || '').slice(0, 120);
  if (codexHome || inferCodexHomeFromFile(sourceFile)) {
    registerCodexThreadSqlite({ codexHome: targetHome, sessionId: newSessionId, outFile, cwd: metaCwd, title: effectiveTitle, firstUserMsg, nowMs });
    try {
      const idxFile = path.join(targetHome, 'session_index.jsonl');
      if (effectiveTitle) fs.appendFileSync(idxFile, JSON.stringify({ id: newSessionId, thread_name: effectiveTitle, updated_at: nowIso }) + '\n', 'utf8');
    } catch {}
  }
  return { file: outFile, newSessionId, messageCount: Math.max(0, targetMsgIdx + 1) };
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

function normalizeHandoffMessages(msgs = [], maxTurns = 30) {
  const cleaned = [];
  for (const m of msgs || []) {
    if (!m) continue;
    const raw = String(m.text || '')
      .replace(/<external_codex_apps_[^>]*>[\s\S]*?<\/external_codex_apps_[^>]*>/gi, '')
      .trim();
    if (!raw || (raw.startsWith('⚙') && !/^⚙ \[(?:설정|터미널)/.test(raw))) continue;
    cleaned.push({
      role: m.role === 'user' ? 'user' : 'assistant',
      text: raw.slice(0, 6000),
      ts: m.ts || new Date().toISOString(),
    });
  }
  return cleaned.slice(-maxTurns);
}

function encodeClaudeProjectDir(cwd) {
  return String(cwd || 'default').replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Extract plain user/assistant turns from an Antigravity SQLite conversation DB (step_type 14/15).
 */
function readAgyConversationTurns(sessionId, roots = null) {
  if (!sessionId) return [];
  const os = require('os');
  const searchRoots = roots || ['antigravity-cli', 'antigravity'].map((n) => path.join(os.homedir(), '.gemini', n, 'conversations'));
  let dbPath = null;
  for (const dir of searchRoots) {
    const p = path.join(dir, `${sessionId}.db`);
    if (fs.existsSync(p)) { dbPath = p; break; }
  }
  if (!dbPath) return [];
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const rows = db.prepare('SELECT idx, step_type, step_payload FROM steps WHERE step_type IN (14, 15) ORDER BY idx ASC').all();
      const readStrings = (buf, depth = 0) => {
        const out = [];
        let i = 0;
        while (i < buf.length) {
          let tag = 0, s = 0;
          while (i < buf.length) { const b = buf[i++]; tag |= (b & 0x7f) << s; if (!(b & 0x80)) break; s += 7; }
          const wt = tag & 7;
          if (wt === 0) { while (i < buf.length && (buf[i++] & 0x80)); }
          else if (wt === 2) {
            let len = 0, sh = 0;
            while (i < buf.length) { const b = buf[i++]; len |= (b & 0x7f) << sh; if (!(b & 0x80)) break; sh += 7; }
            const sub = buf.subarray(i, i + len);
            i += len;
            if (depth < 2 && sub.length > 4) {
              const nested = readStrings(sub, depth + 1);
              if (nested.length) { out.push(...nested); continue; }
            }
            const str = sub.toString('utf8').trim();
            if (str.length >= 2 && !/^[0-9a-f-]{32,36}$/i.test(str) && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(str)) out.push(str);
          } else if (wt === 1) i += 8;
          else if (wt === 5) i += 4;
          else break;
        }
        return out;
      };
      const msgs = [];
      for (const r of rows) {
        if (!r.step_payload) continue;
        const strs = readStrings(Buffer.from(r.step_payload));
        const longest = strs.sort((a, b) => b.length - a.length)[0];
        if (longest) msgs.push({ role: r.step_type === 14 ? 'user' : 'assistant', text: longest });
      }
      return msgs;
    } finally { db.close(); }
  } catch { return []; }
}

/**
 * Write a native Claude Code JSONL session file from normalized messages so `claude --resume <id>` works directly.
 */
function writeNativeClaudeSession({ sessionId = crypto.randomUUID(), claudeProjectsDir, cwd = process.cwd(), msgs = [], title = '' }) {
  const clean = normalizeHandoffMessages(msgs);
  if (!clean.length || !claudeProjectsDir) return null;
  const projDir = path.join(claudeProjectsDir, encodeClaudeProjectDir(cwd));
  fs.mkdirSync(projDir, { recursive: true });
  const outFile = path.join(projDir, `${sessionId}.jsonl`);
  const nowMs = Date.now();
  const lines = [];
  let parentUuid = null;
  clean.forEach((m, idx) => {
    const uuid = crypto.randomUUID();
    const ts = new Date(nowMs - (clean.length - 1 - idx) * 1000).toISOString();
    lines.push(JSON.stringify({
      parentUuid,
      isSidechain: false,
      userType: 'external',
      cwd,
      sessionId,
      version: '2.1.0',
      type: m.role === 'user' ? 'user' : 'assistant',
      uuid,
      timestamp: ts,
      message: m.role === 'user'
        ? { role: 'user', content: m.text }
        : { role: 'assistant', content: [{ type: 'text', text: m.text }] },
    }));
    parentUuid = uuid;
  });
  if (title) {
    lines.push(JSON.stringify({ type: 'custom-title', customTitle: String(title).slice(0, 120), sessionId }));
  }
  fs.writeFileSync(outFile, lines.join('\n') + '\n', 'utf8');
  return { sessionId, file: outFile, messageCount: clean.length };
}

function registerCodexThreadSqlite({ codexHome, sessionId, outFile, cwd, title, firstUserMsg, nowMs }) {
  const os = require('os');
  const mainCodex = path.join(os.homedir(), '.codex');
  const candidates = [codexHome].filter(Boolean);
  try {
    const sessPath = path.join(codexHome, 'sessions');
    if (path.resolve(codexHome) !== path.resolve(mainCodex) && fs.lstatSync(sessPath).isSymbolicLink()) {
      candidates.push(mainCodex);
    }
  } catch {}
  let dbPath = null;
  for (const dir of candidates) {
    try {
      const files = fs.readdirSync(dir).filter((f) => /^state_\d+\.sqlite$/i.test(f)).sort();
      if (files.length) { dbPath = path.join(dir, files[files.length - 1]); break; }
    } catch {}
  }
  if (!dbPath) return false;
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath);
    try {
      const cols = new Set(db.prepare('PRAGMA table_info(threads)').all().map((r) => r.name));
      if (!cols.has('id') || !cols.has('rollout_path')) return false;
      const nowSec = Math.floor(nowMs / 1000);
      const row = {
        id: sessionId,
        rollout_path: outFile,
        created_at: nowSec,
        updated_at: nowSec,
        source: 'cli',
        model_provider: 'openai',
        cwd,
        title: String(title || firstUserMsg || 'Migrated session').slice(0, 120),
        sandbox_policy: '{"type":"danger-full-access"}',
        approval_mode: 'never',
        tokens_used: 0,
        has_user_event: 1,
        archived: 0,
        cli_version: '0.169.0',
        first_user_message: String(firstUserMsg || '').slice(0, 500),
        memory_mode: 'enabled',
        created_at_ms: nowMs,
        updated_at_ms: nowMs,
        thread_source: 'user',
        preview: String(firstUserMsg || title || '').slice(0, 200),
        recency_at: nowSec,
        recency_at_ms: nowMs,
        history_mode: 'legacy',
        originator: 'codex-tui',
      };
      const keys = Object.keys(row).filter((k) => cols.has(k));
      const placeholders = keys.map(() => '?').join(', ');
      db.prepare(`INSERT OR REPLACE INTO threads (${keys.join(', ')}) VALUES (${placeholders})`).run(...keys.map((k) => row[k]));
      return true;
    } finally { db.close(); }
  } catch { return false; }
}

/**
 * Write a native Codex CLI rollout JSONL session file so `codex resume <id>` works directly.
 */
function writeNativeCodexSession({ sessionId = crypto.randomUUID(), codexHome, cwd = process.cwd(), msgs = [], title = '' }) {
  const clean = normalizeHandoffMessages(msgs);
  if (!clean.length || !codexHome) return null;
  const nowMs = Date.now();
  const now = new Date(nowMs);
  const nowIso = now.toISOString();
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const stamp = nowIso.replace(/[:.]/g, '-').slice(0, 19);
  const sessDir = path.join(codexHome, 'sessions', yyyy, mm, dd);
  fs.mkdirSync(sessDir, { recursive: true });
  const outFile = path.join(sessDir, `rollout-${stamp}-${sessionId}.jsonl`);
  const firstUserMsg = clean.find((m) => m.role === 'user')?.text || clean[0]?.text || '';
  const effectiveTitle = String(title || firstUserMsg.split('\n')[0] || '').slice(0, 120);
  const lines = [
    JSON.stringify({
      timestamp: nowIso,
      type: 'session_meta',
      payload: {
        id: sessionId,
        session_id: sessionId,
        timestamp: nowIso,
        cwd,
        runtime_workspace_roots: [cwd],
        originator: 'codex-tui',
        cli_version: '0.169.0',
        source: 'cli',
        thread_source: 'user',
        model_provider: 'openai',
        history_mode: 'legacy',
      },
    }),
  ];
  clean.forEach((m, idx) => {
    const isUser = m.role === 'user';
    const ts = new Date(nowMs - (clean.length - 1 - idx) * 1000).toISOString();
    lines.push(JSON.stringify({
      timestamp: ts,
      type: 'response_item',
      payload: {
        type: 'message',
        role: isUser ? 'user' : 'assistant',
        content: [{ type: isUser ? 'input_text' : 'output_text', text: m.text }],
      },
    }));
  });
  fs.writeFileSync(outFile, lines.join('\n') + '\n', 'utf8');
  registerCodexThreadSqlite({ codexHome, sessionId, outFile, cwd, title: effectiveTitle, firstUserMsg, nowMs });
  try {
    const idxFile = path.join(codexHome, 'session_index.jsonl');
    if (effectiveTitle) fs.appendFileSync(idxFile, JSON.stringify({ id: sessionId, thread_name: effectiveTitle, updated_at: nowIso }) + '\n', 'utf8');
  } catch {}
  return { sessionId, file: outFile, messageCount: clean.length };
}

module.exports = {
  claudeMessageLineIndices,
  codexMessageLineIndices,
  newUuidV7,
  inferCodexHomeFromFile,
  forkClaudeJsonlAt,
  forkCodexJsonlAt,
  editClaudeJsonlAt,
  editCodexJsonlAt,
  writeBranchContextFile,
  createBranchStore,
  readAgyConversationTurns,
  writeNativeClaudeSession,
  writeNativeCodexSession,
};
