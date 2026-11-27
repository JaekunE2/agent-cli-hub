// Incremental full-text index over Claude Code transcripts (~/.claude/projects/**/*.jsonl) and
// Codex CLI rollouts (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl).
// Keeps only user/assistant text + tool-call hints; re-reads only appended bytes.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const addAgyWorkspaces = require('./agy-workspaces');

const CACHE_FILE = path.join(__dirname, '.search-cache.json.gz');
const CACHE_VER = 10;

const emptyTokens = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
function normalizeTokens(t) {
  if (!t || typeof t !== 'object') return emptyTokens();
  const input = Math.max(0, Number(t.input) || 0);
  const output = Math.max(0, Number(t.output) || 0);
  const cacheRead = Math.max(0, Number(t.cacheRead) || 0);
  const cacheWrite = Math.max(0, Number(t.cacheWrite) || 0);
  const total = Math.max(input + output + cacheRead + cacheWrite, Number(t.total) || 0);
  return { input, output, cacheRead, cacheWrite, total };
}
function recomputeTokensFromMap(byKey) {
  const sum = emptyTokens();
  for (const u of Object.values(byKey || {})) {
    sum.input += u.input || 0;
    sum.output += u.output || 0;
    sum.cacheRead += u.cacheRead || 0;
    sum.cacheWrite += u.cacheWrite || 0;
  }
  sum.total = sum.input + sum.output + sum.cacheRead + sum.cacheWrite;
  return sum;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((c) => {
    if (c.type === 'text') return c.text;
    if (c.type === 'tool_use') {
      const inp = c.input || {};
      if (c.name === 'AskUserQuestion' && Array.isArray(inp.questions) && inp.questions.length) {
        return inp.questions.map((q) => {
          const opts = Array.isArray(q.options) ? q.options.map((o) => o.label).filter(Boolean) : [];
          return `❓ ${q.question || q.header || '질문'}${opts.length ? ` [${opts.join(' / ')}]` : ''}`;
        }).join('\n');
      }
      const hint = inp.command || inp.file_path || inp.pattern || inp.description || inp.url || inp.query || '';
      return `⚙ ${c.name}${hint ? ': ' + String(hint).slice(0, 300) : ''}`;
    }
    return null;
  }).filter(Boolean).join('\n');
}
const isNoise = (t) => /^<(command|local-command|system-reminder)/.test(t.trim());

function claudeCommandNote(rawText) {
  const s = String(rawText || '').trim();
  const cmdM = /<command-name>\s*(\/[^\s<]+)\s*<\/command-name>/i.exec(s);
  if (cmdM) {
    const cmd = cmdM[1].trim();
    if (/^\/(model|effort|plan|permissions|fast|mode|status|approvals|reasoning|sandbox)$/i.test(cmd)) {
      const argsM = /<command-args>\s*([\s\S]*?)\s*<\/command-args>/i.exec(s);
      const args = argsM ? argsM[1].trim() : '';
      return `⚙ [터미널 명령] ${cmd}${args ? ` ${args}` : ''}`;
    }
    return null;
  }
  const outM = /<local-command-stdout>\s*([\s\S]*?)\s*<\/local-command-stdout>/i.exec(s);
  if (outM) {
    const out = outM[1].replace(/\s+/g, ' ').trim();
    if (out && out.length <= 400 && !/^Dismissed$/i.test(out)) {
      return `⚙ [터미널 상태] ${out}`;
    }
  }
  return null;
}

function claudeToolResultNote(e) {
  if (!e || e.type !== 'user') return null;
  const ansObj = e.toolUseResult?.answers;
  if (ansObj && typeof ansObj === 'object' && !Array.isArray(ansObj)) {
    const entries = Object.entries(ansObj).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
    if (entries.length) return `✓ 선택/응답: ${entries.join(' | ').slice(0, 1200)}`;
  }
  const content = e.message?.content;
  if (Array.isArray(content)) {
    for (const c of content) {
      if (c?.type === 'tool_result' && typeof c.content === 'string') {
        const txt = c.content.trim();
        if (/^User has answered your questions:/i.test(txt)) {
          return `✓ 선택/응답: ${txt.replace(/^User has answered your questions:\s*/i, '').slice(0, 1200)}`;
        }
      }
    }
  }
  return null;
}

// ---- Codex rollouts ----
const CODEX_ROOT = path.join(process.env.CODEX_HOME || path.join(require('os').homedir(), '.codex'), 'sessions');
const isCodexFile = (f) => /^rollout-.*\.jsonl$/.test(path.basename(f));
// rollout-2026-10-26T14-29-50-<session uuid>.jsonl → the uuid (what `codex resume <id>` takes)
const codexIdOf = (f) => { const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(f); return m ? m[1] : path.basename(f, '.jsonl'); };
// injected context, not something the user typed
const codexNoise = (t) => /^\s*<(environment_context|user_instructions|skills_instructions|permissions|collaboration_mode|turn_aborted|subagent|external_codex_apps_|in-app-browser|system_instruction|tools)/.test(t)
  || /^\s*(# AGENTS\.md|# Files mentioned by the user:|## Referenced ChatGPT conversation:|\[\{"questionItemId":)/i.test(t);
function cleanPromptTitle(raw) {
  let s = String(raw || '').replace(/<external_codex_apps_[^>]*>[\s\S]*?<\/external_codex_apps_[^>]*>/gi, '').trim();
  const lines = s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let skipBlock = false;
  for (const l of lines) {
    if (/^#{1,3}\s*(Referenced ChatGPT|Files mentioned by the user|Context from|Active file|Open files)/i.test(l)) { skipBlock = true; continue; }
    if (skipBlock) {
      if (/^[-*]\s+/.test(l) || /^`[^`]+`$/.test(l) || /^https?:\/\//i.test(l) || /^[A-Za-z]:\\/.test(l) || /^#{1,3}\s+/.test(l) || /^>/.test(l)) continue;
      skipBlock = false;
    }
    if (/^<\/?[a-z_][\w-]*[^>]*>$/i.test(l)) continue;
    return l.slice(0, 160);
  }
  return '';
}
function codexText(content) {
  if (!Array.isArray(content)) return typeof content === 'string' ? content : '';
  return content.map((c) => (c.type === 'input_text' || c.type === 'output_text' || c.type === 'text' ? c.text : null)).filter(Boolean).join('\n');
}
/** one rollout line → {cwd?, auto?, msg?: {role, text, ts}, limit?} */
function codexLine(e) {
  const pl = e.payload || {};
  if (e.type === 'session_meta') {
    const srcText = typeof pl.source === 'string' ? pl.source : JSON.stringify(pl.source || '');
    const isSub = !!(pl.source && typeof pl.source === 'object' && pl.source.subagent) || /subagent/i.test(srcText);
    return { cwd: pl.cwd || null, auto: isSub || /exec/i.test(`${pl.originator || ''} ${srcText}`) };
  }
  if (e.type === 'turn_context') {
    const mode = (typeof pl.collaboration_mode === 'object' ? pl.collaboration_mode?.mode : pl.collaboration_mode) || pl.approval_policy || '';
    const effort = pl.effort || pl.reasoning_effort || '';
    const model = pl.model || '';
    return {
      ...(pl.cwd ? { cwd: pl.cwd } : {}),
      ...((model || effort || mode) ? { turnCtx: { model: String(model), effort: String(effort), mode: String(mode) } } : {}),
    };
  }
  if (e.type === 'event_msg' && pl.type === 'token_count' && pl.info?.total_token_usage) {
    const u = pl.info.total_token_usage;
    const cached = Number(u.cached_input_tokens) || 0;
    const rawIn = Number(u.input_tokens) || 0;
    const input = Math.max(0, rawIn - cached);
    const output = (Number(u.output_tokens) || 0) + (Number(u.reasoning_output_tokens) || 0);
    const total = Number(u.total_tokens) || (rawIn + output);
    return { tokens: normalizeTokens({ input, output, cacheRead: cached, cacheWrite: 0, total }) };
  }
  if (e.type === 'event_msg' && pl.type === 'error' && /usage limit|rate limit|429/i.test(pl.message || '')) return { limit: { ts: e.timestamp, text: String(pl.message).slice(0, 200) } };
  if (e.type !== 'response_item') return {};
  if (pl.type === 'message' && (pl.role === 'user' || pl.role === 'assistant')) {
    const text = codexText(pl.content);
    if (!text || (pl.role === 'user' && codexNoise(text))) return {};
    return { msg: { role: pl.role, text, ts: e.timestamp } };
  }
  if (pl.type === 'function_call_output') {
    try {
      const out = typeof pl.output === 'string' ? JSON.parse(pl.output) : pl.output;
      if (out?.answers && typeof out.answers === 'object') {
        const parts = Object.entries(out.answers).map(([k, v]) => {
          const val = Array.isArray(v?.answers) ? v.answers.join(', ') : Array.isArray(v) ? v.join(', ') : (v?.answer ?? v);
          return `${k}: ${typeof val === 'object' ? JSON.stringify(val) : val}`;
        });
        if (parts.length) return { msg: { role: 'user', text: `✓ 선택/응답: ${parts.join(' | ').slice(0, 1200)}`, ts: e.timestamp } };
      }
    } catch {}
    return {};
  }
  if (pl.type === 'function_call' || pl.type === 'custom_tool_call' || pl.type === 'local_shell_call') {
    const rawArgs = pl.arguments ?? pl.action ?? pl.input ?? '';
    if (pl.name === 'request_user_input') {
      try {
        const a = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs;
        if (Array.isArray(a?.questions) && a.questions.length) {
          const qTxt = a.questions.map((q) => {
            const opts = Array.isArray(q.options) ? q.options.map((o) => o.label).filter(Boolean) : [];
            return `❓ ${q.question || q.header || '질문'}${opts.length ? ` [${opts.join(' / ')}]` : ''}`;
          }).join('\n');
          return { msg: { role: 'assistant', text: qTxt, ts: e.timestamp } };
        }
      } catch {}
    }
    let hint = '';
    if (typeof rawArgs === 'string') {
      try {
        const a = JSON.parse(rawArgs);
        hint = [].concat(a.command || a.cmd || a.path || a.query || a.file_path || '').join(' ');
      } catch {
        const cmdM = /(?:cmd|command|path|file_path|query)\s*:\s*"([^"]+)"/.exec(rawArgs);
        hint = cmdM ? cmdM[1] : rawArgs.replace(/\s+/g, ' ').trim();
      }
    } else if (rawArgs && typeof rawArgs === 'object') {
      hint = [].concat(rawArgs.command || rawArgs.cmd || rawArgs.path || rawArgs.query || rawArgs.file_path || '').join(' ');
    }
    return { msg: { role: 'assistant', text: `⚙ ${pl.name || pl.type}${hint ? ': ' + String(hint).slice(0, 300) : ''}`, ts: e.timestamp } };
  }
  return {};
}

// ---- Antigravity transcripts ----
const AGY_ROOT = path.join(require('os').homedir(), '.gemini', 'antigravity', 'brain');
const AGY_ROOTS = ['antigravity', 'antigravity-cli', 'antigravity-ide']
  .map(name => path.join(require('os').homedir(), '.gemini', name, 'brain'));
const isAgyFile = (f) => /[\\/]\.system_generated[\\/]logs[\\/]transcript(?:_full)?\.jsonl$/i.test(f);
const agyIdOf = (f) => path.basename(path.resolve(path.dirname(f), '..', '..'));
function agyUserText(raw) {
  let s = String(raw || '');
  const m = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i.exec(s);
  s = m ? m[1].trim() : s.replace(/<ADDITIONAL_METADATA>[\s\S]*$/i, '').replace(/<USER_SETTINGS_CHANGE>[\s\S]*$/i, '').trim();
  const stripped = s.replace(/@\[[^\]]+\]\s*/g, '').trim();
  return stripped || s.replace(/@\[([^\]]+)\]/g, (_, p) => path.basename(p)).trim();
}
function agySettingsNote(raw) {
  const m = /<USER_SETTINGS_CHANGE>\s*([\s\S]*?)\s*<\/USER_SETTINGS_CHANGE>/i.exec(String(raw || ''));
  if (!m) return null;
  const txt = m[1].replace(/\s+/g, ' ').trim();
  const ch = /changed setting\s+`([^`]+)`\s+from\s+(.+?)\s+to\s+([^.]+)/i.exec(txt);
  if (ch) return `⚙ [설정 변경] ${ch[1]}: ${ch[2]} → ${ch[3]}`;
  return txt ? `⚙ [설정 변경] ${txt.slice(0, 240)}` : null;
}
function agyLine(e) {
  if (e.type === 'USER_INPUT') {
    const raw = String(e.content || '');
    const m = /@\[([A-Za-z]:\\[^\]\r\n]+|\/[^\]\r\n]+)\]/.exec(raw);
    const cwd = m ? m[1].trim() : null;
    const text = agyUserText(raw);
    const settingsNote = agySettingsNote(raw);
    return {
      ...(cwd ? { cwd } : {}),
      ...(text ? { msg: { role: 'user', text, ts: e.created_at } } : {}),
      ...(settingsNote ? { settingsNote } : {}),
    };
  }
  if (e.type === 'PLANNER_RESPONSE') {
    const hasTok = e.input_tokens != null || e.output_tokens != null || e.cache_read_tokens != null;
    const tokStep = hasTok ? {
      key: String(e.step_index ?? e.created_at ?? Math.random()),
      input: Math.max(0, Number(e.input_tokens) || 0),
      output: Math.max(0, Number(e.output_tokens) || 0),
      cacheRead: Math.max(0, Number(e.cache_read_tokens) || 0),
      cacheWrite: Math.max(0, Number(e.cache_write_tokens) || 0),
    } : null;
    const msg = typeof e.content === 'string' && e.content.trim() ? { role: 'assistant', text: e.content.trim(), ts: e.created_at } : null;
    return { ...(msg ? { msg } : {}), ...(tokStep ? { tokStep } : {}) };
  }
  return {};
}

class SearchIndex {
  constructor(root, codexRoot = CODEX_ROOT, agyRoot = AGY_ROOTS) {
    this.root = root;
    this.codexRoot = codexRoot;
    this.agyRoot = agyRoot;
    this.docs = new Map(); // sessionId -> {file, offset, mtime, cwd, title, firstPrompt, msgs:[{role,text,ts}]}
    this.ready = false;
    this.building = null;
    this.dirty = false;
    this.load();
  }

  load() {
    try {
      const j = JSON.parse(zlib.gunzipSync(fs.readFileSync(CACHE_FILE)).toString('utf8'));
      if (j.v === CACHE_VER) for (const d of j.docs) this.docs.set(d.id, d);
    } catch {}
  }

  // The cache only speeds up the next start: write it at most every 5 minutes (force: on shutdown).
  // JSON of ~40 MB + gzip blocked the server ~0.8 s every 20 s; gzip now runs on the thread pool.
  save(force = false) {
    if (!this.dirty) return;
    if (!force && Date.now() - (this.savedAt || 0) < 5 * 60e3) return;
    this.dirty = false;
    this.savedAt = Date.now();
    const docs = [...this.docs.values()];
    const raw = Buffer.from(JSON.stringify({ v: CACHE_VER, docs }));
    if (force) { fs.writeFileSync(CACHE_FILE, zlib.gzipSync(raw)); return; }
    zlib.gzip(raw, (err, buf) => { if (!err) fs.writeFile(CACHE_FILE, buf, () => {}); });
  }

  async listFilesAsync() {
    const out = [];
    let dirs; try { dirs = await fs.promises.readdir(this.root); } catch { dirs = []; }
    for (const d of dirs) {
      const dir = path.join(this.root, d);
      let ents; try { ents = await fs.promises.readdir(dir); } catch { continue; }
      for (const f of ents) if (f.endsWith('.jsonl')) out.push(path.join(dir, f));
    }
    const walk = async (dir, depth) => {
      let ents; try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (e.isDirectory() && depth < 3) await walk(path.join(dir, e.name), depth + 1);
        else if (e.isFile() && isCodexFile(e.name)) out.push(path.join(dir, e.name));
      }
    };
    if (this.codexRoot) await walk(this.codexRoot, 0);
    for (const root of Array.isArray(this.agyRoot) ? this.agyRoot : [this.agyRoot].filter(Boolean)) {
      let adirs; try { adirs = await fs.promises.readdir(root, { withFileTypes: true }); } catch { adirs = []; }
      for (const e of adirs) {
        if (!e.isDirectory() || !/^[0-9a-f-]{16,}$/i.test(e.name)) continue;
        const logsDir = path.join(root, e.name, '.system_generated', 'logs');
        const fullTf = path.join(logsDir, 'transcript_full.jsonl');
        const tf = path.join(logsDir, 'transcript.jsonl');
        try { await fs.promises.access(fullTf); out.push(fullTf); continue; } catch {}
        try { await fs.promises.access(tf); out.push(tf); } catch {}
      }
    }
    return out;
  }

  listFiles() {
    const out = [];
    // a fresh Claude Code install has no projects folder yet
    for (const d of fs.existsSync(this.root) ? fs.readdirSync(this.root) : []) {
      const dir = path.join(this.root, d);
      let ents; try { ents = fs.readdirSync(dir); } catch { continue; }
      for (const f of ents) if (f.endsWith('.jsonl')) out.push(path.join(dir, f));
    }
    return out;
  }

  // Parse bytes [doc.offset, size) of one file, appending complete lines only.
  async updateFile(file, { codexAnswers = false } = {}) {
    const codex = isCodexFile(file);
    const agy = !codex && isAgyFile(file);
    const id = codex ? codexIdOf(file) : agy ? agyIdOf(file) : path.basename(file, '.jsonl');
    let st; try { st = await fs.promises.stat(file); } catch { return; }
    let doc = this.docs.get(id);
    if (codex && codexAnswers && doc && !doc.codexAnswers) doc = null;
    const bestMtime = (d, stMs) => {
      for (let i = d.msgs.length - 1; i >= 0; i--) {
        const ts = Date.parse(d.msgs[i]?.ts || '');
        if (Number.isFinite(ts)) return Math.max(stMs, ts);
      }
      return stMs;
    };
    const bestUserAt = (d) => {
      for (let i = d.msgs.length - 1; i >= 0; i--) {
        if (d.msgs[i]?.role !== 'user') continue;
        const ts = Date.parse(d.msgs[i]?.ts || '');
        if (Number.isFinite(ts)) return ts;
      }
      return 0;
    };
    if (doc && doc.file === file && doc.offset === st.size) {
      const m = bestMtime(doc, st.mtimeMs);
      if (m > doc.mtime) { doc.mtime = m; this.dirty = true; }
      if (doc.lastUserAt === undefined) { doc.lastUserAt = bestUserAt(doc); this.dirty = true; }
      return;
    }
    if (!doc || doc.file !== file || st.size < doc.offset) {
      doc = { id, file, offset: 0, mtime: 0, cwd: null, title: null, firstPrompt: null, auto: null, msgs: [], tokens: emptyTokens(), _tokMap: {}, agent: codex ? 'codex' : agy ? 'agy' : 'claude', ...(codex ? { codexAnswers: true } : {}) };
      this.docs.set(id, doc);
    }
    if (!doc.tokens) doc.tokens = emptyTokens();
    if (!doc._tokMap) doc._tokMap = {};
    const end = st.size;
    if (end <= doc.offset) return; // empty file (e.g. truncated when the disk was full): nothing to read
    await new Promise((resolve) => {
      const stream = fs.createReadStream(file, { start: doc.offset, end: end - 1 });
      let rest = Buffer.alloc(0), consumed = doc.offset;
      const pushMsg = (msg) => {
        const text = String(msg.text || '').slice(0, 24000);
        const last = doc.msgs[doc.msgs.length - 1];
        if (last && last.role === 'assistant' && msg.role === 'assistant' && last.text === text) return;
        doc.msgs.push({ ...msg, text });
      };
      const handleCodex = (lineBuf) => {
        // big tool outputs / reasoning blobs are skipped before JSON.parse
        const head = lineBuf.subarray(0, 300).toString('utf8');
        if (!/"type":"(session_meta|turn_context|response_item|event_msg)"/.test(head)) return;
        const isAnswerOut = head.includes('"function_call_output"') && lineBuf.length < 32768 && lineBuf.includes('answers');
        if (!isAnswerOut && head.includes('"type":"response_item"') && /"type":"(reasoning|function_call_output|custom_tool_call_output)"/.test(head)) return;
        let e; try { e = JSON.parse(lineBuf.toString('utf8')); } catch { return; }
        const p = e.payload || {};
        if ((e.type === 'turn_context' || p.type === 'task_started') && p.turn_id && p.turn_id !== doc._codexTurn) {
          doc._codexTurn = p.turn_id;
          doc._codexAnswer = null;
          doc._codexFinal = false;
        }
        if (e.type === 'event_msg' && p.type === 'task_complete' && p.turn_id && p.turn_id === doc._codexTurn && doc._codexAnswer != null) {
          doc.msgs[doc._codexAnswer].codexTurnId = p.turn_id;
          doc._codexAnswer = null;
        }
        const r = codexLine(e);
        if (r.cwd && !doc.cwd) doc.cwd = r.cwd;
        if (r.turnCtx) {
          if (!doc._lastCtx) {
            doc._lastCtx = r.turnCtx;
          } else {
            const diff = [];
            if (r.turnCtx.model && r.turnCtx.model !== doc._lastCtx.model) { diff.push(`모델: ${r.turnCtx.model}`); doc._lastCtx.model = r.turnCtx.model; }
            if (r.turnCtx.effort && r.turnCtx.effort !== doc._lastCtx.effort) { diff.push(`추론: ${r.turnCtx.effort}`); doc._lastCtx.effort = r.turnCtx.effort; }
            if (r.turnCtx.mode && r.turnCtx.mode !== doc._lastCtx.mode) { diff.push(`모드: ${r.turnCtx.mode}`); doc._lastCtx.mode = r.turnCtx.mode; }
            if (diff.length) doc.msgs.push({ role: 'assistant', text: `⚙ [설정 변경] ${diff.join(' · ')}`, ts: e.timestamp });
          }
        }
        if (r.auto !== undefined && doc.auto === null) doc.auto = r.auto;
        if (r.limit) doc.limit = r.limit;
        if (r.tokens && r.tokens.total >= (doc.tokens?.total || 0)) doc.tokens = r.tokens;
        if (!r.msg) return;
        if (r.msg.role === 'assistant' && !r.msg.text.startsWith('⚙')) doc.limit = null;
        if (r.msg.role === 'user' && !doc.firstPrompt) {
          const clean = cleanPromptTitle(r.msg.text);
          if (clean && !codexNoise(clean)) doc.firstPrompt = clean;
        }
        const next = doc.msgs.length;
        pushMsg(r.msg);
        if (doc.msgs.length > next && r.msg.role === 'assistant' && p.type === 'message' &&
            (p.phase === 'final_answer' || (!p.phase && !doc._codexFinal))) {
          doc._codexAnswer = next;
          doc._codexFinal = p.phase === 'final_answer';
        }
      };
      const handleAgy = (lineBuf) => {
        // Detect subagent child conversations: step 0 is a SYSTEM_MESSAGE with sender=<parent-id> and no USER_INPUT
        if (!doc.msgs.length && !doc.firstPrompt && lineBuf.includes('"SYSTEM_MESSAGE"') && lineBuf.includes('sender=')) {
          doc.auto = true;
          return;
        }
        // Fast raw-buffer pre-filter: skips large GENERIC / SYSTEM_MESSAGE lines before UTF-8 decode & JSON.parse
        // while preserving support for spaced or late "type" fields.
        if (!lineBuf.includes('USER_INPUT') && !lineBuf.includes('PLANNER_RESPONSE')) return;
        let e; try { e = JSON.parse(lineBuf.toString('utf8')); } catch { return; }
        const r = agyLine(e);
        if (r.cwd && !doc.cwd) doc.cwd = r.cwd;
        if (r.tokStep) {
          const prev = doc._tokMap[r.tokStep.key] || emptyTokens();
          doc._tokMap[r.tokStep.key] = {
            input: Math.max(prev.input, r.tokStep.input),
            output: Math.max(prev.output, r.tokStep.output),
            cacheRead: Math.max(prev.cacheRead, r.tokStep.cacheRead),
            cacheWrite: Math.max(prev.cacheWrite, r.tokStep.cacheWrite),
          };
          doc.tokens = recomputeTokensFromMap(doc._tokMap);
        }
        if (r.settingsNote) doc.msgs.push({ role: 'assistant', text: r.settingsNote, ts: e.created_at });
        if (!r.msg) return;
        if (r.msg.role === 'user' && !doc.firstPrompt) doc.firstPrompt = cleanPromptTitle(r.msg.text);
        pushMsg(r.msg);
      };
      const handle = codex ? handleCodex : agy ? handleAgy : (lineBuf) => {
        // Cheap pre-filter before JSON.parse; tool results / attachments can be MBs.
        // "type" sits near the start of user lines but near the end of assistant lines.
        const head = lineBuf.subarray(0, 400).toString('utf8') + lineBuf.subarray(Math.max(0, lineBuf.length - 600)).toString('utf8');
        const isMsg = head.includes('"type":"user"') || head.includes('"type":"assistant"');
        const isTitle = head.includes('"custom-title"') || head.includes('"type":"summary"');
        if (doc.auto === null) { const m = head.match(/"entrypoint":"([^"]*)"/); if (m) doc.auto = m[1].startsWith('sdk'); }
        if (!isMsg && !isTitle && doc.cwd) return;
        const s = lineBuf.toString('utf8');
        const hasToolAnswer = isMsg && s.includes('"tool_use_id"') && s.length < 32768 && (s.includes('"toolUseResult"') || s.includes('"answers"') || s.includes('User has answered'));
        if (isMsg && s.includes('"tool_use_id"') && !hasToolAnswer) { if (!doc.cwd) { const m = s.match(/"cwd":"((?:[^"\\]|\\.)*)"/); if (m) doc.cwd = JSON.parse(`"${m[1]}"`); } return; }
        let e; try { e = JSON.parse(s); } catch { return; }
        doc.cwd = doc.cwd || e.cwd || null;
        if (e.type === 'custom-title' && e.customTitle) doc.title = e.customTitle;
        else if (e.type === 'summary' && e.summary && !doc.title) doc.title = e.summary;
        if ((e.type !== 'user' && e.type !== 'assistant') || e.isMeta || e.isSidechain) return;
        if (hasToolAnswer) {
          const ansNote = claudeToolResultNote(e);
          if (ansNote) doc.msgs.push({ role: 'user', text: ansNote, ts: e.timestamp });
          return;
        }
        if (e.type === 'assistant' && e.message?.usage) {
          const u = e.message.usage;
          const mkey = String(e.message.id || e.uuid || e.timestamp || doc.msgs.length);
          const prev = doc._tokMap[mkey] || emptyTokens();
          doc._tokMap[mkey] = {
            input: Math.max(prev.input, Number(u.input_tokens) || 0),
            output: Math.max(prev.output, Number(u.output_tokens) || 0),
            cacheRead: Math.max(prev.cacheRead, Number(u.cache_read_input_tokens) || 0),
            cacheWrite: Math.max(prev.cacheWrite, Number(u.cache_creation_input_tokens) || 0),
          };
          doc.tokens = recomputeTokensFromMap(doc._tokMap);
        }
        const text = textOf(e.message?.content);
        // usage-limit state: set by a 429 error turn, cleared by the next real reply
        if (e.type === 'assistant') {
          if (e.error === 'rate_limit' || e.apiErrorStatus === 429) doc.limit = { ts: e.timestamp, text: (text || '').slice(0, 200) };
          else if (!e.isApiErrorMessage && text) doc.limit = null;
        }
        if (!text) return;
        if (isNoise(text)) {
          const cmdNote = claudeCommandNote(text);
          if (cmdNote) doc.msgs.push({ role: 'assistant', text: cmdNote, ts: e.timestamp });
          return;
        }
        if (e.type === 'user' && !doc.firstPrompt && !e.isCompactSummary && !text.startsWith('This session is being continued') && !text.startsWith('⚙')) doc.firstPrompt = text.slice(0, 160);
        pushMsg({ role: e.type, text, ts: e.timestamp });
      };
      stream.on('data', (chunk) => {
        let buf = rest.length ? Buffer.concat([rest, chunk]) : chunk;
        let i, start = 0;
        while ((i = buf.indexOf(10, start)) >= 0) {
          handle(buf.subarray(start, i));
          consumed += i - start + 1;
          start = i + 1;
        }
        rest = Buffer.from(buf.subarray(start));
      });
      stream.on('end', () => { doc.offset = consumed; resolve(); });
      stream.on('error', resolve);
    });
    doc.mtime = bestMtime(doc, st.mtimeMs);
    doc.lastUserAt = bestUserAt(doc);
    this.dirty = true;
  }

  // Refresh everything (only changed files do work). Concurrent callers share one pass.
  refresh() {
    if (this.building) return this.building;
    this.building = (async () => {
      const files = await this.listFilesAsync();
      const live = new Set(files.map((f) => (isCodexFile(f) ? codexIdOf(f) : isAgyFile(f) ? agyIdOf(f) : path.basename(f, '.jsonl'))));
      for (const id of this.docs.keys()) if (!live.has(id)) { this.docs.delete(id); this.dirty = true; }
      this.progress = { done: 0, total: files.length };
      for (const f of files) { await this.updateFile(f); this.progress.done++; }
      addAgyWorkspaces(Array.isArray(this.agyRoot) ? this.agyRoot : [this.agyRoot].filter(Boolean), this.docs);
      this.ready = true;
      this.save();
    })().finally(() => { this.building = null; });
    return this.building;
  }

  get(id) { return this.docs.get(id); }

  recent(limit = 40, includeAuto = false, agent = '', hidden = new Set(), projectSessions = new Set()) {
    return [...this.docs.values()]
      .filter((d) => !hidden.has(d.id) && d.msgs.length && (includeAuto || !d.auto || projectSessions.has(d.id)) && (!agent || (d.agent || 'claude') === agent))
      .sort((a, b) => (b.lastUserAt || b.mtime) - (a.lastUserAt || a.mtime)).slice(0, limit)
      .map((d) => ({ sessionId: d.id, agent: d.agent || 'claude', cwd: d.cwd, title: d.title, firstPrompt: d.firstPrompt, mtime: d.mtime, lastUserAt: d.lastUserAt || 0, auto: !!d.auto }));
  }

  search(q, { role = 'all', limitSessions = 60, perSession = 6, includeAuto = false, cwd = '', agent = '', hidden = new Set() } = {}) {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    const results = [];
    const cwdLow = cwd.toLowerCase();
    // A query that looks like a session id (or its prefix) finds that session itself.
    const idTerms = terms.filter((t) => /^[0-9a-f][0-9a-f-]{5,35}$/.test(t));
    const idHits = [];
    if (idTerms.length) {
      for (const d of this.docs.values()) {
        if (!hidden.has(d.id) && idTerms.some((t) => d.id.startsWith(t))) {
          idHits.push({ sessionId: d.id, agent: d.agent || 'claude', auto: !!d.auto, title: d.title, firstPrompt: d.firstPrompt, cwd: d.cwd, mtime: d.mtime,
            total: d.msgs.length, idMatch: true, hits: d.msgs.slice(-2).map((m, k) => ({ i: Math.max(0, d.msgs.length - 2) + k, role: m.role, ts: m.ts, snippet: snippet(m.text, m.text.toLowerCase(), []) })) });
        }
      }
    }
    for (const d of this.docs.values()) {
      if (hidden.has(d.id) || (d.auto && !includeAuto)) continue;
      if (agent && (d.agent || 'claude') !== agent) continue;
      if (cwdLow && !(d.cwd || '').toLowerCase().includes(cwdLow)) continue;
      const meta = `${d.title || ''} ${d.cwd || ''}`.toLowerCase();
      const hits = [];
      let total = 0;
      for (let i = 0; i < d.msgs.length; i++) {
        const m = d.msgs[i];
        if (role === 'user' && m.role !== 'user') continue;
        if (role === 'assistant' && m.role !== 'assistant') continue;
        const low = m.text.toLowerCase();
        // every term must appear in the message, or in the session title/folder
        if (!terms.every((t) => low.includes(t) || meta.includes(t))) continue;
        if (!terms.some((t) => low.includes(t))) continue;
        total++;
        if (hits.length < perSession) hits.push({ i, role: m.role, ts: m.ts, snippet: snippet(m.text, low, terms) });
      }
      if (total) results.push({ sessionId: d.id, agent: d.agent || 'claude', auto: !!d.auto, title: d.title, firstPrompt: d.firstPrompt, cwd: d.cwd, mtime: d.mtime, total, hits });
    }
    results.sort((a, b) => b.mtime - a.mtime);
    const idSet = new Set(idHits.map((h) => h.sessionId));
    return [...idHits, ...results.filter((r) => !idSet.has(r.sessionId))].slice(0, limitSessions);
  }
}

function snippet(text, low, terms) {
  let pos = -1;
  for (const t of terms) { const p = low.indexOf(t); if (p >= 0 && (pos < 0 || p < pos)) pos = p; }
  const a = Math.max(0, pos - 90), b = Math.min(text.length, pos + 190);
  return (a > 0 ? '…' : '') + text.slice(a, b).replace(/\s+/g, ' ') + (b < text.length ? '…' : '');
}

module.exports = { SearchIndex, textOf, isNoise, claudeCommandNote, claudeToolResultNote, isCodexFile, codexIdOf, codexLine, CODEX_ROOT, isAgyFile, agyIdOf, agyLine, AGY_ROOT };
