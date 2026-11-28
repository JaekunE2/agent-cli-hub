// Shared agent core for the local LLM (Ollama): tools, the model's own rules, tools the model writes
// itself, and the tool-calling loop. Used by the PC CLI (llm-agent.js, `ccd llm agent`) and by the
// GX10 server behind the phone app's "로컬 LLM" page (tools/gx10-llm-agent/server.js).
//
// createAgent({ base, roots:[{path, write}], toolDir, rulesFile, python, trustNewTools, residentModels, log,
//               venvRoot, settingsFile })
//   venvRoot: folder of Python venvs (GX10 ~/venvs). Tools may run in any of them; pip_install may only
//   install into venvs named llm-* (never the system python or ~/.local).
//   settingsFile: JSON the model can tune itself with agent_settings (tool time limits), within hard caps.
//   .run({ model, messages, tools, think, signal, onEvent, maxSteps })   messages are mutated in place
//
// Messages use the OpenAI chat format (sent to Ollama's /v1/chat/completions, which also takes images
// for qwen3.8 where the native /api/chat refuses them). Extra fields we keep for the UI (reasoning, t,
// stats, images, partial, error, hidden) are stripped by toWire() before sending.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const CTX_TOKENS = 32768;      // server context (OLLAMA_CONTEXT_LENGTH)
const PROMPT_BUDGET = 24000;   // leave room for the answer
const estTokens = (s) => Math.ceil(String(s || '').length / 2.2);

function createAgent(opts) {
  const roots = opts.roots.map((r) => ({ path: path.resolve(r.path), write: r.write !== false }));
  for (const r of roots) if (r.write) fs.mkdirSync(r.path, { recursive: true });
  const home = roots.find((r) => r.write) || roots[0];
  const log = opts.log || (() => {});
  const toolDir = opts.toolDir;
  const rulesFile = opts.rulesFile;
  const resident = new Set(opts.residentModels || []);

  // ---------- path guard ----------
  function resolveIn(p, wantWrite) {
    if (!p) throw new Error('path is required');
    const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(home.path, p);
    const r = roots.filter((x) => abs === x.path || abs.startsWith(x.path + path.sep)).sort((a, b) => b.path.length - a.path.length)[0];
    if (!r) throw new Error(`path outside the workspace: ${abs} (allowed: ${roots.map((x) => x.path + (x.write ? '' : ' [read-only]')).join(', ')})`);
    if (wantWrite && !r.write) throw new Error(`${r.path} is read-only; write inside ${home.path}`);
    return abs;
  }
  function toTrash(abs) {
    const r = roots.filter((x) => x.write && abs.startsWith(x.path + path.sep))[0] || home;
    const t = path.join(r.path, '.trash');
    fs.mkdirSync(t, { recursive: true });
    const dst = path.join(t, `${new Date().toISOString().replace(/[:.]/g, '-')}_${path.basename(abs)}`);
    fs.renameSync(abs, dst);
    return dst;
  }
  const rel = (abs) => { const r = roots.find((x) => abs.startsWith(x.path)); return r ? path.relative(home.path, abs) || '.' : abs; };

  // ---------- web ----------
  const decode = (s) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  const htmlToText = (html) => html.replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr)[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
  async function getText(url, ms = 30000) {
    const r = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'ko,en;q=0.8' }, signal: AbortSignal.timeout(ms), redirect: 'follow' });
    return { status: r.status, type: r.headers.get('content-type') || '', body: await r.text(), url: r.url };
  }
  async function webSearch({ query, max_results = 8 }) {
    const n = Math.min(Number(max_results) || 8, 15);
    const out = [];
    try { // DuckDuckGo HTML endpoint (no key)
      const { body } = await getText(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=kr-kr`);
      const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/g;
      let m;
      while ((m = re.exec(body)) && out.length < n) {
        let u = m[1].replace(/&amp;/g, '&');
        const q = u.match(/[?&]uddg=([^&]+)/);
        if (q) u = decodeURIComponent(q[1]);
        if (u.startsWith('//')) u = 'https:' + u;
        if (/duckduckgo\.com\/y\.js/.test(u)) continue; // ads
        out.push({ title: decode(m[2]), url: u, snippet: decode(m[3] || '') });
      }
    } catch (e) { log(`  (duckduckgo failed: ${e.message})`); }
    if (!out.length) { // fallback: Bing
      const { body } = await getText(`https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=ko`);
      const re = /<li class="b_algo"[\s\S]*?<h2[^>]*><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<p[^>]*>([\s\S]*?)<\/p>)?/g;
      let m;
      while ((m = re.exec(body)) && out.length < n) out.push({ title: decode(m[2]), url: m[1].replace(/&amp;/g, '&'), snippet: decode(m[3] || '') });
    }
    return out.length ? out : 'no results';
  }
  async function fetchUrl({ url, max_chars = 12000, offset = 0 }) {
    const r = await getText(url);
    let text = /html|xml/.test(r.type) ? htmlToText(r.body) : r.body;
    const total = text.length, off = Number(offset) || 0;
    text = text.slice(off, off + Math.min(Number(max_chars) || 12000, 30000));
    return `HTTP ${r.status} ${r.url}\n(${total} chars total${total > off + text.length ? `, showing from ${off}; call again with offset for more` : ''})\n\n${text}`;
  }
  async function download({ url, path: p }) {
    const abs = resolveIn(p, true);
    const r = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(600000), redirect: 'follow' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const len = Number(r.headers.get('content-length') || 0);
    if (len > 2e9) throw new Error(`file too large (${(len / 1e9).toFixed(1)} GB, limit 2 GB)`);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (fs.existsSync(abs)) toTrash(abs);
    const buf = Buffer.from(await r.arrayBuffer());
    fs.writeFileSync(abs, buf);
    return `saved ${rel(abs)} (${buf.length} bytes, ${r.headers.get('content-type') || '?'})`;
  }

  // ---------- files ----------
  function listDir({ path: p = '.', recursive = false }) {
    const abs = resolveIn(p);
    const lines = [];
    const walk = (d, depth) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name === '.trash' || lines.length >= 400) continue;
        const f = path.join(d, e.name);
        if (e.isDirectory()) { lines.push(`${'  '.repeat(depth)}${e.name}/`); if (recursive && depth < 6) walk(f, depth + 1); }
        else { try { const s = fs.statSync(f); lines.push(`${'  '.repeat(depth)}${e.name}  ${s.size}B  ${s.mtime.toISOString().slice(0, 16)}`); } catch {} }
      }
    };
    walk(abs, 0);
    return `${abs}/\n${lines.join('\n') || '(empty)'}`;
  }
  function readFile({ path: p, start_line = 1, max_lines = 400 }) {
    const abs = resolveIn(p);
    const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
    const s = Math.max(1, Number(start_line) || 1);
    const part = lines.slice(s - 1, s - 1 + Math.min(Number(max_lines) || 400, 1000));
    return `${rel(abs)} (${lines.length} lines)\n` + part.map((l, i) => `${s + i}\t${l}`).join('\n');
  }
  function writeFile({ path: p, content, append = false }) {
    const abs = resolveIn(p, true);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (append) { fs.appendFileSync(abs, content); return `appended ${String(content).length} chars to ${rel(abs)}`; }
    let note = '';
    if (fs.existsSync(abs)) { toTrash(abs); note = ' (previous version kept in .trash)'; }
    fs.writeFileSync(abs, content);
    return `wrote ${rel(abs)} (${String(content).length} chars)${note}`;
  }
  function editFile({ path: p, old_text, new_text, replace_all = false }) {
    const abs = resolveIn(p, true);
    const s = fs.readFileSync(abs, 'utf8');
    const n = s.split(old_text).length - 1;
    if (!n) throw new Error('old_text not found (read the file again and copy the text exactly)');
    if (n > 1 && !replace_all) throw new Error(`old_text occurs ${n} times; add more context or set replace_all`);
    fs.writeFileSync(abs, replace_all ? s.split(old_text).join(new_text) : s.replace(old_text, () => new_text));
    return `edited ${rel(abs)} (${replace_all ? n : 1} replacement${replace_all && n > 1 ? 's' : ''})`;
  }
  function makeDir({ path: p }) { const abs = resolveIn(p, true); fs.mkdirSync(abs, { recursive: true }); return `created ${rel(abs)}/`; }
  function move({ src, dst }) {
    const a = resolveIn(src, true), b = resolveIn(dst, true);
    fs.mkdirSync(path.dirname(b), { recursive: true });
    if (fs.existsSync(b)) throw new Error(`destination exists: ${rel(b)}`);
    fs.renameSync(a, b);
    return `moved ${rel(a)} -> ${rel(b)}`;
  }
  function del({ path: p }) {
    const abs = resolveIn(p, true);
    if (roots.some((r) => r.path === abs)) throw new Error('cannot delete the workspace root');
    return `deleted ${rel(abs)} (kept in ${rel(toTrash(abs))})`;
  }

  // ---------- the model's own rules ----------
  const readRules = () => { try { return fs.readFileSync(rulesFile, 'utf8'); } catch { return ''; } };
  const writeRules = (t) => { fs.mkdirSync(path.dirname(rulesFile), { recursive: true }); fs.writeFileSync(rulesFile, String(t).trim() + '\n'); };
  function updateRules({ action = 'add', text = '' }) {
    const lines = readRules().split('\n').filter((l) => l.trim());
    text = String(text).trim();
    if (action === 'add') { if (!text) throw new Error('text is required'); lines.push(text.startsWith('- ') ? text : `- ${text}`); }
    else if (action === 'remove') {
      const i = lines.findIndex((l) => l.includes(text));
      if (!text || i < 0) throw new Error('no rule contains that text');
      lines.splice(i, 1);
    } else if (action === 'replace_all') lines.splice(0, lines.length, ...text.split('\n').filter((l) => l.trim()));
    else throw new Error('action must be add, remove or replace_all');
    writeRules(lines.join('\n'));
    return `rules now:\n${lines.join('\n') || '(none)'}`;
  }

  // ---------- tools the model writes itself ----------
  // <toolDir>/<name>/{tool.json, main.py|main.js}: arguments arrive as JSON on stdin, the result is stdout,
  // cwd is the workspace. Time limit = the tool's timeout_s, else the default in settings (120 s), capped by
  // the max in settings (hard cap 6 h). Running model-written code is the risk, so a new or changed tool
  // (hash of spec + code + venv) is pending until the user approves it, unless trustNewTools.
  const toolHash = (d) => { const j = JSON.parse(fs.readFileSync(path.join(d, 'tool.json'), 'utf8')); return crypto.createHash('sha256').update(JSON.stringify([j.description, j.parameters, j.language, j.venv || null]) + fs.readFileSync(path.join(d, j.file))).digest('hex').slice(0, 16); };

  // ---------- settings the model may tune itself (agent_settings) ----------
  const SETTING_CAPS = { tool_timeout_default_s: [10, 3600], tool_timeout_max_s: [60, 21600], pip_timeout_s: [60, 7200] };
  const SETTING_DEFAULTS = { tool_timeout_default_s: 120, tool_timeout_max_s: 3600, pip_timeout_s: 1800 };
  function settings() {
    let s = {}; try { s = JSON.parse(fs.readFileSync(opts.settingsFile, 'utf8')); } catch {}
    const out = {};
    for (const [k, [lo, hi]] of Object.entries(SETTING_CAPS)) out[k] = Math.min(hi, Math.max(lo, Number(s[k]) || SETTING_DEFAULTS[k]));
    return out;
  }
  function agentSettings({ action = 'get', key, value }) {
    if (action === 'get' || !key) return { settings: settings(), allowed: SETTING_CAPS, note: 'set with action "set", key, value (seconds, clamped to the allowed range)' };
    if (!opts.settingsFile) throw new Error('settings are fixed here');
    if (!SETTING_CAPS[key]) throw new Error(`unknown setting ${key}; allowed: ${Object.keys(SETTING_CAPS).join(', ')}`);
    let s = {}; try { s = JSON.parse(fs.readFileSync(opts.settingsFile, 'utf8')); } catch {}
    const [lo, hi] = SETTING_CAPS[key];
    s[key] = Math.min(hi, Math.max(lo, Math.round(Number(value))));
    fs.mkdirSync(path.dirname(opts.settingsFile), { recursive: true });
    fs.writeFileSync(opts.settingsFile, JSON.stringify(s, null, 2));
    return { ok: true, settings: settings() };
  }

  // ---------- Python venvs: tools can run in any venv under venvRoot; pip only into llm-* ----------
  const venvName = (v) => { if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,40}$/.test(String(v || ''))) throw new Error('venv must be a plain folder name under the venv root'); return String(v); };
  const venvPython = (v) => {
    if (!opts.venvRoot) throw new Error('venvs are not available here');
    const p = path.join(opts.venvRoot, venvName(v), process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    if (!fs.existsSync(p)) throw new Error(`venv ${v} does not exist (create it with pip_install, name llm-<something>)`);
    return p;
  };
  // run a process without blocking the server; kill the whole group on timeout
  function runProc(exe, argv, { input, timeoutMs, cwd, env }) {
    return new Promise((ok, no) => {
      const ch = spawn(exe, argv, { cwd, env, detached: process.platform !== 'win32', windowsHide: true });
      let out = '', err = '', done = false;
      const cap = (s, d) => (s.length > 20e6 ? s : s + d);
      ch.stdout.on('data', (d) => { out = cap(out, d); });
      ch.stderr.on('data', (d) => { err = cap(err, d); });
      const timer = setTimeout(() => {
        if (done) return; done = true;
        try { process.platform === 'win32' ? ch.kill() : process.kill(-ch.pid, 'SIGKILL'); } catch {}
        no(Object.assign(new Error(`timed out (${Math.round(timeoutMs / 1000)} s)`), { stdout: out, stderr: err }));
      }, timeoutMs);
      ch.on('error', (e) => { if (!done) { done = true; clearTimeout(timer); no(e); } });
      ch.on('close', (status) => { if (!done) { done = true; clearTimeout(timer); ok({ status, stdout: out, stderr: err }); } });
      if (input != null) ch.stdin.end(input); else ch.stdin.end();
    });
  }
  async function pipInstall({ venv, packages, index_url, system_site_packages = false }) {
    if (!opts.venvRoot) throw new Error('pip_install is not available here');
    const v = venvName(venv);
    if (!/^llm-[a-z0-9_-]{1,30}$/.test(v)) throw new Error('pip_install only installs into venvs named llm-<name> (e.g. llm-ocr); use that venv in your tool with venv: "llm-…"');
    const pk = (Array.isArray(packages) ? packages : String(packages || '').split(/\s+/)).map(String).filter(Boolean);
    if (!pk.length) throw new Error('packages is required');
    for (const p of pk) if (p.startsWith('-') || !/^[A-Za-z0-9_.\-\[\],<>=!~+@:/ ]+$/.test(p)) throw new Error(`bad package spec: ${p}`);
    if (index_url && !/^https:\/\/[^\s]+$/.test(index_url)) throw new Error('index_url must be https');
    const dir = path.join(opts.venvRoot, v);
    const timeoutMs = settings().pip_timeout_s * 1000;
    const env = { ...process.env, PIP_DISABLE_PIP_VERSION_CHECK: '1' };
    const log = [];
    if (!fs.existsSync(dir)) {
      const r = await runProc(opts.python || 'python3', ['-m', 'venv', ...(system_site_packages ? ['--system-site-packages'] : []), dir], { timeoutMs: 300000, env });
      if (r.status !== 0) throw new Error(`venv create failed: ${(r.stderr || r.stdout).slice(-2000)}`);
      log.push(`created venv ${v}${system_site_packages ? ' (with system site-packages)' : ''}`);
    }
    const r = await runProc(venvPython(v), ['-m', 'pip', 'install', ...(index_url ? ['--index-url', index_url] : []), ...pk], { timeoutMs, env })
      .catch((e) => ({ status: -1, stdout: e.stdout || '', stderr: `${e.message}\n${e.stderr || ''}` }));
    log.push((r.stdout + '\n' + r.stderr).trim().split('\n').filter((l) => !/^\s*(Downloading|Using cached|Collecting|━|Requirement already)/.test(l)).slice(-40).join('\n'));
    if (r.status !== 0) throw new Error(`pip exit ${r.status}\n${log.join('\n').slice(-4000)}`);
    return `installed into ${v}: ${pk.join(' ')}\n${log.join('\n').slice(-3000)}\nUse it from a tool with venv: "${v}".`;
  }
  function customTools() {
    if (!toolDir || !fs.existsSync(toolDir)) return [];
    const out = [];
    for (const n of fs.readdirSync(toolDir)) {
      if (n.startsWith('.')) continue;
      const d = path.join(toolDir, n);
      try { const j = JSON.parse(fs.readFileSync(path.join(d, 'tool.json'), 'utf8')); out.push({ ...j, dir: d, approved: j.approvedHash === toolHash(d) }); } catch {}
    }
    return out;
  }
  const toolTimeoutS = (t) => { const s = settings(); return Math.min(s.tool_timeout_max_s, Math.max(5, Number(t.timeout_s) || s.tool_timeout_default_s)); };
  async function runCustom(t, args) {
    const exe = t.language === 'node' ? process.execPath : t.venv ? venvPython(t.venv) : (opts.python || 'python3');
    const lim = toolTimeoutS(t);
    let r;
    try {
      r = await runProc(exe, [path.join(t.dir, t.file)], { cwd: home.path, input: JSON.stringify(args || {}), timeoutMs: lim * 1000,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', LLM_WORKSPACE: home.path } });
    } catch (e) {
      if (/timed out/.test(e.message)) throw new Error(`tool timed out (${lim} s). Raise it with tool_settings {name, timeout_s} (max ${settings().tool_timeout_max_s} s, see agent_settings).\n${String(e.stdout || '').slice(-1500)}${String(e.stderr || '').slice(-1500)}`);
      throw e;
    }
    if (r.status !== 0) throw new Error(`exit ${r.status}: ${(r.stderr || r.stdout || '').slice(-3000)}`);
    return (r.stdout || '').trim() || '(no output)';
  }
  const findTool = (name) => { const t = customTools().find((x) => x.name === name); if (!t) throw new Error(`no tool ${name} (yours: ${customTools().map((x) => x.name).join(', ') || 'none'})`); return t; };
  const reapprove = (t) => (opts.trustNewTools ? (setApproved(t.dir, 'trust-new-tools'), 'enabled') : 'PENDING the user\'s approval (app: menu → 툴)');
  function readTool({ name }) {
    if (!name) return customTools().map((t) => ({ name: t.name, description: t.description, language: t.language, venv: t.venv || null, timeout_s: toolTimeoutS(t), approved: t.approved }));
    const t = findTool(name);
    return { name: t.name, description: t.description, parameters: t.parameters, language: t.language, venv: t.venv || null, timeout_s: toolTimeoutS(t), approved: t.approved, file: t.file, code: fs.readFileSync(path.join(t.dir, t.file), 'utf8') };
  }
  function editTool({ name, old_text, new_text, replace_all = false }) {
    const t = findTool(name), f = path.join(t.dir, t.file);
    const src = fs.readFileSync(f, 'utf8');
    const n = src.split(old_text).length - 1;
    if (!old_text || n === 0) throw new Error('old_text not found in the tool code (read_tool first)');
    if (n > 1 && !replace_all) throw new Error(`old_text occurs ${n} times; add context or set replace_all`);
    fs.writeFileSync(f, replace_all ? src.split(old_text).join(new_text) : src.replace(old_text, () => new_text));
    return `edited ${name} (${n} place${n > 1 ? 's' : ''}); ${reapprove(t)}`;
  }
  function toolSettings({ name, timeout_s, venv, description, parameters }) {
    const t = findTool(name), f = path.join(t.dir, 'tool.json');
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (timeout_s != null) j.timeout_s = Math.min(settings().tool_timeout_max_s, Math.max(5, Math.round(Number(timeout_s))));
    if (venv !== undefined) { if (venv) venvPython(venv); j.venv = venv || undefined; }
    if (description) j.description = String(description);
    if (parameters) { if (typeof parameters === 'string') parameters = JSON.parse(parameters); j.parameters = parameters; }
    fs.writeFileSync(f, JSON.stringify(j, null, 2));
    return `updated ${name}: timeout ${toolTimeoutS(j)} s, venv ${j.venv || '(system python)'}; ${reapprove(t)}`;
  }
  function setApproved(d, by) { const f = path.join(d, 'tool.json'); const j = JSON.parse(fs.readFileSync(f, 'utf8')); j.approvedHash = toolHash(d); j.approvedAt = new Date().toISOString(); j.approvedBy = by; fs.writeFileSync(f, JSON.stringify(j, null, 2)); return j; }
  function createTool({ name, description, parameters, language = 'python', code, timeout_s, venv }) {
    if (!toolDir) throw new Error('tool creation is not enabled here');
    if (!/^[a-z][a-z0-9_]{1,40}$/.test(name || '')) throw new Error('name must be snake_case letters/digits');
    if (BUILTIN[name]) throw new Error(`${name} is a built-in tool`);
    if (!['python', 'node'].includes(language)) throw new Error('language must be python or node');
    if (!code) throw new Error('code is required');
    if (typeof parameters === 'string') { try { parameters = JSON.parse(parameters); } catch { parameters = {}; } }
    if (!parameters || parameters.type !== 'object') parameters = { type: 'object', properties: parameters?.properties || parameters || {}, required: parameters?.required || [] };
    const d = path.join(toolDir, name);
    fs.mkdirSync(d, { recursive: true });
    const file = language === 'node' ? 'main.js' : 'main.py';
    fs.writeFileSync(path.join(d, file), code);
    // replacing a tool keeps its venv / time limit unless new ones are given
    let prev = {}; try { prev = JSON.parse(fs.readFileSync(path.join(d, 'tool.json'), 'utf8')); } catch {}
    if (venv === undefined) venv = prev.venv;
    if (timeout_s == null) timeout_s = prev.timeout_s;
    if (venv) venvPython(venv);
    const lim = timeout_s != null ? Math.min(settings().tool_timeout_max_s, Math.max(5, Math.round(Number(timeout_s)))) : undefined;
    fs.writeFileSync(path.join(d, 'tool.json'), JSON.stringify({ name, description, parameters, language, file, venv: venv || undefined, timeout_s: lim, created: new Date().toISOString() }, null, 2));
    if (opts.trustNewTools) { setApproved(d, 'trust-new-tools'); return `created and enabled tool ${name}; call it once now to test it`; }
    return `saved tool ${name} — PENDING: it can run only after the user approves it (app: menu → 툴, or \`ccd llm tools approve ${name}\`). Tell the user.`;
  }

  // ---------- this PC's Claude Code hub, through its own CLI ----------
  // opts.hub = { node, ccd, env, cwd }: runs `ccd <args>` (on another machine with CCD_BASE/CCD_TOKEN pointing
  // through a tunnel). Reading is free; typing into sessions or opening new ones needs the user's OK per call.
  const { execFile } = require('child_process');
  function ccd(args, timeoutMs = 60000) {
    return new Promise((ok) => execFile(opts.hub.node || process.execPath, [opts.hub.ccd, ...args], { env: { ...process.env, ...(opts.hub.env || {}) }, timeout: timeoutMs, maxBuffer: 8e6, encoding: 'utf8' },
      (err, stdout, stderr) => ok(((stdout || '') + (stderr ? `\n${stderr}` : '')).trim() || (err ? `ERROR: ${err.message}` : '(no output)'))));
  }
  const tgt = (t) => { t = String(t || '').trim(); if (!/^(t:?\d+|c:?\d+|[0-9a-f]{8}[0-9a-f-]*)$/i.test(t)) throw new Error('target must be t:<id>, c:<id> or a session id prefix (see hub_status)'); return /^\d/.test(t) && t.length < 6 ? `t:${t}` : t; };
  const HUB = {
    hub_status: [() => ccd(['ls']), "List this PC's Claude Code sessions/terminals (t:<id>, busy/idle, title, folder).", { type: 'object', properties: {}, required: [] }],
    hub_read: [({ target, lines = 60 }) => ccd(['read', tgt(target), '-n', String(Math.min(Number(lines) || 60, 300))]), "Read the current screen of a hub session/terminal.", { type: 'object', properties: { target: { type: 'string', description: 't:<id>' }, lines: { type: 'integer' } }, required: ['target'] }],
    hub_search: [({ query, max_results = 10 }) => ccd(['search', String(query), '-n', String(Math.min(Number(max_results) || 10, 30))], 120000), 'Search all past Claude Code conversations on the PC.', { type: 'object', properties: { query: { type: 'string' }, max_results: { type: 'integer' } }, required: ['query'] }],
    hub_gpu: [() => ccd(['gpu']), 'Show the GPU queue (local GPUs and configured GPU servers): running and waiting jobs.', { type: 'object', properties: {}, required: [] }],
    hub_wait: [({ target, timeout_s = 300 }) => ccd(['wait', tgt(target), '--timeout', String(Math.min(Number(timeout_s) || 300, 900))], 960000), 'Wait until a busy Claude session finishes its turn, then return its screen.', { type: 'object', properties: { target: { type: 'string' }, timeout_s: { type: 'integer' } }, required: ['target'] }],
    hub_send: [({ target, text }) => ccd(['send', tgt(target), String(text)]), 'Type a prompt into a hub Claude session and press Enter. NEEDS THE USER\'S APPROVAL each time.', { type: 'object', properties: { target: { type: 'string', description: 't:<id>' }, text: { type: 'string' } }, required: ['target', 'text'] }, true],
    hub_keys: [({ target, keys }) => ccd(['keys', tgt(target), ...(Array.isArray(keys) ? keys : String(keys).split(/\s+/)).map(String)]), 'Press keys in a hub session (e.g. ["enter"], ["esc"], ["down","enter"]) to answer a menu. NEEDS APPROVAL.', { type: 'object', properties: { target: { type: 'string' }, keys: { type: 'array', items: { type: 'string' } } }, required: ['target', 'keys'] }, true],
    hub_new: [({ kind = 'claude', cwd = opts.hub.cwd || require('os').homedir(), title }) => ccd(['new', String(kind), '--cwd', String(cwd), ...(title ? ['--title', String(title)] : [])], 90000), 'Open a new terminal on the PC hub (claude by default) in a folder. NEEDS APPROVAL.', { type: 'object', properties: { kind: { type: 'string', enum: ['claude', 'codex', 'powershell'] }, cwd: { type: 'string', description: 'Windows folder, default: the configured hub folder or the home folder' }, title: { type: 'string' } }, required: [] }, true],
  };

  // ---------- tool table ----------
  const S = (props, req) => ({ type: 'object', properties: props, required: req });
  const str = (d) => ({ type: 'string', description: d });
  const BUILTIN = {
    web_search: [webSearch, 'Search the web. Returns titles, URLs and snippets.', S({ query: str('search query'), max_results: { type: 'integer', description: 'default 8' } }, ['query'])],
    fetch_url: [fetchUrl, 'Fetch a web page or text file and return its readable text.', S({ url: str('http(s) URL'), max_chars: { type: 'integer' }, offset: { type: 'integer', description: 'character offset for long pages' } }, ['url'])],
    download: [download, 'Download a file from a URL into the workspace.', S({ url: str('http(s) URL'), path: str('destination path in the workspace') }, ['url', 'path'])],
    list_dir: [listDir, 'List files in a folder.', S({ path: str('folder, default "."'), recursive: { type: 'boolean' } }, [])],
    read_file: [readFile, 'Read a text file with line numbers.', S({ path: str('file path'), start_line: { type: 'integer' }, max_lines: { type: 'integer' } }, ['path'])],
    write_file: [writeFile, 'Create or overwrite a text file (or append).', S({ path: str('file path'), content: str('full text'), append: { type: 'boolean' } }, ['path', 'content'])],
    edit_file: [editFile, 'Replace exact text in a file (read it first).', S({ path: str('file path'), old_text: str('exact text to replace'), new_text: str('replacement'), replace_all: { type: 'boolean' } }, ['path', 'old_text', 'new_text'])],
    make_dir: [makeDir, 'Create a folder.', S({ path: str('folder path') }, ['path'])],
    move: [move, 'Move or rename a file or folder.', S({ src: str('source'), dst: str('destination') }, ['src', 'dst'])],
    delete: [del, 'Delete a file or folder (moved to .trash, recoverable).', S({ path: str('path') }, ['path'])],
    update_rules: [updateRules, 'Maintain YOUR OWN standing rules (shown to you in every conversation). Use when the user says "from now on / 앞으로 / 항상 / 하지 마" or you learn a lasting preference.',
      S({ action: { type: 'string', enum: ['add', 'remove', 'replace_all'] }, text: str('rule text (add/replace_all) or part of the rule to remove') }, ['action', 'text'])],
    create_tool: [createTool, 'Write a new reusable tool (or replace one you wrote) when no tool can do a job. The script reads its arguments as a JSON object from stdin and prints the result to stdout; cwd is the workspace. Prefer the standard library.',
      S({ name: str('snake_case tool name'), description: str('what the tool does'), parameters: { type: 'object', description: 'JSON schema: {"type":"object","properties":{...},"required":[...]}' },
        language: { type: 'string', enum: ['python', 'node'] }, code: str('full source of the script'),
        timeout_s: { type: 'integer', description: 'time limit in seconds (default from agent_settings, 120)' },
        venv: str('optional Python venv to run in (folder name under the venv root, e.g. "ocr" or one you made with pip_install)') }, ['name', 'description', 'parameters', 'code'])],
    read_tool: [readTool, 'Show one of your tools (code, settings) or, without name, list them all.', S({ name: str('tool name; omit to list') }, [])],
    edit_tool: [editTool, 'Fix or change the code of one of your tools by replacing exact text (read_tool first).', S({ name: str('tool name'), old_text: str('exact text in the code'), new_text: str('replacement'), replace_all: { type: 'boolean' } }, ['name', 'old_text', 'new_text'])],
    tool_settings: [toolSettings, 'Change a tool\'s time limit, venv, description or parameters without rewriting its code. Use when a tool timed out or needs packages from a venv.',
      S({ name: str('tool name'), timeout_s: { type: 'integer', description: 'seconds' }, venv: str('venv name, "" for system python'), description: str('new description'), parameters: { type: 'object', description: 'new JSON schema' } }, ['name'])],
    pip_install: [pipInstall, 'Install Python packages into your own venv (named llm-<name>, created if missing) — never the system python. Then run tools in it with venv: "llm-<name>".',
      S({ venv: str('llm-<name>, e.g. llm-ocr'), packages: { type: 'array', items: { type: 'string' }, description: 'pip specs, e.g. ["easyocr", "numpy<2"]' }, index_url: str('optional https index, e.g. the PyTorch CUDA wheel index'),
        system_site_packages: { type: 'boolean', description: 'new venv can also see system packages (default false)' } }, ['venv', 'packages'])],
    agent_settings: [agentSettings, 'See or change your own settings: tool_timeout_default_s, tool_timeout_max_s, pip_timeout_s (clamped to allowed ranges).',
      S({ action: { type: 'string', enum: ['get', 'set'] }, key: str('setting name'), value: { type: 'integer' } }, [])],
  };
  function toolTable() {
    const t = { ...BUILTIN };
    if (!toolDir) for (const k of ['create_tool', 'read_tool', 'edit_tool', 'tool_settings']) delete t[k];
    if (!opts.venvRoot) delete t.pip_install;
    if (!opts.settingsFile) delete t.agent_settings;
    if (!rulesFile) delete t.update_rules;
    if (opts.hub) Object.assign(t, HUB);
    for (const c of customTools()) if (c.approved) t[c.name] = [(a) => runCustom(c, a), c.description, c.parameters];
    return t;
  }

  // ---------- system prompt ----------
  function systemPrompt(extra, withTools) {
    const rules = readRules().trim();
    const custom = customTools();
    return [
      `Today is ${new Date().toISOString().slice(0, 10)}. Reply in the language the user wrote in (Korean → Korean), even when sources or tool output are English.`,
      withTools ? `You can act with tools. When a task needs searching, reading, downloading or files: CALL THE TOOL IN THIS SAME REPLY. Never answer with only a plan or "I'll search…" — do it, then report what you found or did.
Use web_search, then fetch_url on the best sources before stating facts; cite URLs.
Workspace (write): ${home.path}${roots.filter((r) => !r.write).map((r) => `; read-only: ${r.path}`).join('')}. Relative paths are inside the workspace.
If the user says something should hold from now on, record it with update_rules. If no tool can do a needed job, write one with create_tool${toolDir ? '; fix your tools yourself with read_tool/edit_tool, and if one times out raise its limit with tool_settings (limits: agent_settings)' : ''}${opts.venvRoot ? '. Packages go only into your own venv via pip_install (venv llm-<name>), never pip in the system python or ~/.local; run the tool with that venv' : ''}${opts.trustNewTools ? '. Your tools work right away, no approval needed' : ''}.${opts.hub ? `
"허브"/"관제"/"세션" = the user's Claude Code hub on their PC: hub_status lists sessions as t:<id>; read a screen with hub_read before acting on it. hub_send/hub_keys/hub_new pause for the user's approval in the app — call them directly, don't ask in text first. Never send to a session that is busy unless the user said so.` : ''}${custom.some((c) => !c.approved) ? `\nPending (not yet approved) tools: ${custom.filter((c) => !c.approved).map((c) => c.name).join(', ')}.` : ''}` : '',
      rules ? `Your standing rules (keep following them; edit with update_rules):\n${rules}` : '',
      extra || '',
    ].filter(Boolean).join('\n\n');
  }

  // ---------- wire format + context budget ----------
  function toWire(messages, sys) {
    const out = [];
    for (const m of messages) {
      if (m.error || m.partial || m.role === 'system') continue;
      if (m.role === 'user') {
        out.push(m.images?.length ? { role: 'user', content: [{ type: 'text', text: m.content || '이 이미지를 설명해줘' }, ...m.images.map((u) => ({ type: 'image_url', image_url: { url: u } }))] } : { role: 'user', content: m.content });
      } else if (m.role === 'assistant') {
        const a = { role: 'assistant', content: m.content || '' };
        if (m.tool_calls?.length) a.tool_calls = m.tool_calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.function.name, arguments: typeof c.function.arguments === 'string' ? c.function.arguments : JSON.stringify(c.function.arguments || {}) } }));
        out.push(a);
      } else if (m.role === 'tool') out.push({ role: 'tool', tool_call_id: m.tool_call_id, content: m.content });
    }
    // fit the context: shorten older tool results, then drop the oldest turns (never the last user turn)
    const size = () => out.reduce((n, m) => n + (Array.isArray(m.content) ? 1200 + estTokens(m.content[0].text) : estTokens(m.content) + estTokens(JSON.stringify(m.tool_calls || ''))), estTokens(sys));
    const toolIdx = out.map((m, i) => (m.role === 'tool' ? i : -1)).filter((i) => i >= 0);
    for (const i of toolIdx.slice(0, -2)) { if (size() <= PROMPT_BUDGET) break; if (out[i].content.length > 600) out[i].content = out[i].content.slice(0, 600) + '\n…(older tool output shortened)'; }
    while (size() > PROMPT_BUDGET && out.length > 1) {
      const lastUser = out.map((m) => m.role).lastIndexOf('user');
      if (lastUser <= 0) break;
      out.shift();
      while (out.length && out[0].role !== 'user') out.shift(); // keep tool results with their call
    }
    return [{ role: 'system', content: sys }, ...out];
  }

  // ---------- one streamed model call ----------
  async function callModel({ model, wire, specs, think, signal, onDelta }) {
    const body = { model, messages: wire, stream: true, ...(specs?.length ? { tools: specs } : {}) };
    if (think === false || think === 'off') body.reasoning_effort = 'none';
    else if (typeof think === 'string') body.reasoning_effort = think; // low | medium | high
    if (!resident.has(model)) body.keep_alive = '10m';
    const r = await fetch(`${opts.base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
    if (!r.ok) throw new Error(`LLM error ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const msg = { content: '', reasoning: '', calls: [], finish: null, usage: null };
    let buf = '';
    for await (const chunk of r.body) {
      buf += Buffer.from(chunk).toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const d = line.slice(5).trim();
        if (d === '[DONE]') continue;
        let o; try { o = JSON.parse(d); } catch { continue; }
        if (o.error) throw new Error(`LLM error: ${o.error.message || JSON.stringify(o.error)}`);
        if (o.usage) msg.usage = o.usage;
        const c = o.choices?.[0]; if (!c) continue;
        const dl = c.delta || {};
        const rs = dl.reasoning || dl.reasoning_content;
        if (rs) { msg.reasoning += rs; onDelta('reasoning', rs); }
        if (dl.content) { msg.content += dl.content; onDelta('content', dl.content); }
        for (const tc of dl.tool_calls || []) {
          const k = tc.index ?? msg.calls.length;
          const cur = msg.calls[k] || (msg.calls[k] = { id: tc.id || `call_${Date.now().toString(36)}_${k}`, type: 'function', function: { name: '', arguments: '' } });
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.function.name += tc.function.name;
          if (tc.function?.arguments) cur.function.arguments += typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments);
        }
        if (c.finish_reason) msg.finish = c.finish_reason;
      }
    }
    msg.calls = msg.calls.filter(Boolean);
    // qwen3-coder sometimes prints its native XML tool call as text instead of a parsed call
    if (!msg.calls.length && /<function=[\w-]+>/.test(msg.content)) {
      msg.calls = [...msg.content.matchAll(/<function=([\w-]+)>([\s\S]*?)(?:<\/function>|$)/g)].map(([, name, b], k) => {
        const args = {};
        for (const [, key, v] of b.matchAll(/<parameter=([\w-]+)>\n?([\s\S]*?)\n?<\/parameter>/g)) { try { args[key] = /^[\[{]|^(true|false|-?\d+(\.\d+)?)$/.test(v.trim()) ? JSON.parse(v) : v; } catch { args[key] = v; } }
        return { id: `call_x${k}`, type: 'function', function: { name, arguments: JSON.stringify(args) } };
      });
      msg.content = msg.content.replace(/<tool_call>[\s\S]*$/, '').trim();
    }
    return msg;
  }

  // a model stuck in a loop repeats the same block; stop instead of burning minutes
  function looping(s) {
    if (s.length < 3000) return false;
    const tail = s.slice(-200);
    return s.slice(-8000).split(tail).length - 1 >= 4;
  }
  const announces = (s) => s.length < 700 && /(하겠습니다|해\s?보겠습니다|해\s?볼게요|할게요|찾아보겠|검색해\s?보|확인해\s?보겠|작성해\s?보겠|let me |i('ll| will) (now )?(search|look|check|find|write|create|download|fetch|read))/i.test(s);

  // ---------- the loop ----------
  // events: start(i) · delta(i, kind, text) · message(i, message) · notice(text) · done
  async function run({ model, messages, tools = true, think, signal, onEvent = () => {}, maxSteps = 24, system, confirm }) {
    const nudged = { act: false, cont: 0 };
    let toolsUsed = 0;
    // a standing instruction ("앞으로 …", "항상 …", "from now on") should end up in the rules file;
    // models tend to just obey it once, so say so explicitly next to that message
    const lastUser = [...messages].reverse().find((m) => m.role === 'user' && !m.hidden);
    if (tools && rulesFile && lastUser && /(앞으로|항상|매번|언제나|하지\s?마|from now on|always|never)/i.test(lastUser.content || '')) {
      messages.push({ role: 'user', content: '[시스템] 위 메시지에 앞으로도 지켜야 할 지시가 있으면 먼저 update_rules(action "add")로 기록한 뒤 나머지 요청을 처리해.', hidden: true, t: Date.now() });
    }
    for (let step = 1; step <= maxSteps; step++) {
      if (signal?.aborted) throw new Error('stopped');
      const table = tools ? toolTable() : {};
      const specs = Object.entries(table).map(([name, [, description, parameters]]) => ({ type: 'function', function: { name, description, parameters } }));
      const sys = systemPrompt(system, tools);
      const a = { role: 'assistant', content: '', reasoning: '', partial: true, model, t: Date.now() };
      messages.push(a);
      const i = messages.length - 1;
      onEvent({ type: 'message', i, message: a });
      const ac = new AbortController();
      const stop = () => ac.abort();
      signal?.addEventListener('abort', stop);
      const t0 = Date.now();
      let r;
      try {
        r = await callModel({ model, wire: toWire(messages, sys), specs, think, signal: ac.signal, onDelta: (kind, text) => {
          a[kind] += text;
          onEvent({ type: 'delta', i, kind, text });
          if (kind === 'content' && looping(a.content)) { a.looped = true; ac.abort(); }
        } });
      } catch (e) {
        signal?.removeEventListener('abort', stop);
        if (a.looped) { r = { content: a.content, reasoning: a.reasoning, calls: [], finish: 'loop' }; }
        else { a.partial = false; if (signal?.aborted) { a.stopped = true; onEvent({ type: 'message', i, message: a }); throw new Error('stopped'); } a.error = e.message; onEvent({ type: 'message', i, message: a }); throw e; }
      }
      signal?.removeEventListener('abort', stop);
      delete a.partial;
      // qwen3.8 fills tool-call turns with a placeholder line; drop it (it would also be fed back next turn)
      a.content = r.content.replace(/\[assistant reasoning omitted[^\]]*\]\s*/gi, '').trim(); a.reasoning = r.reasoning;
      if (!a.reasoning) delete a.reasoning;
      if (r.calls.length) a.tool_calls = r.calls;
      a.stats = `${model} · ${((Date.now() - t0) / 1000).toFixed(1)}초${r.usage?.completion_tokens ? ` · ${r.usage.completion_tokens} tok` : ''}`;
      onEvent({ type: 'message', i, message: a });
      if (r.finish === 'loop') { onEvent({ type: 'notice', text: '같은 내용이 반복돼 생성을 멈췄습니다.' }); a.content += '\n\n⚠ (반복 감지로 중단)'; onEvent({ type: 'message', i, message: a }); return; }

      if (!r.calls.length) {
        // talk-only: the model announced an action but called nothing → push it once to act
        if (tools && !toolsUsed && !nudged.act && announces(a.content)) {
          nudged.act = true;
          messages.push({ role: 'user', content: '[시스템] 설명만 하지 말고 지금 바로 필요한 툴을 호출해서 실행해. 실행 결과를 보고 답해.', hidden: true, t: Date.now() });
          onEvent({ type: 'message', i: messages.length - 1, message: messages[messages.length - 1] });
          continue;
        }
        // cut by the output limit → continue the same answer (up to 3 times)
        if (r.finish === 'length' && nudged.cont < 3) {
          nudged.cont++;
          messages.push({ role: 'user', content: '[시스템] 끊긴 곳부터 이어서 계속 작성해.', hidden: true, t: Date.now() });
          onEvent({ type: 'message', i: messages.length - 1, message: messages[messages.length - 1] });
          continue;
        }
        return;
      }
      for (const c of r.calls) {
        const name = c.function.name;
        let args = c.function.arguments;
        if (typeof args === 'string') { try { args = JSON.parse(args || '{}'); } catch { args = {}; } }
        log(`[${step}] ${name} ${JSON.stringify(args).slice(0, 160)}`);
        let out;
        try {
          if (!table[name]) throw new Error(`unknown tool ${name}${customTools().some((x) => x.name === name) ? ' (pending approval)' : ''}`);
          if (table[name][3]) { // acts on the PC hub: ask the user for this exact call
            const ok = confirm ? await confirm({ id: c.id, name, args }) : false;
            if (!ok) { out = confirm ? 'DENIED: the user did not approve this action. Do not retry it; say what you would have done.' : 'DENIED: hub actions need approval, which is not available here.'; throw Object.assign(new Error(out), { quiet: true }); }
          }
          out = await table[name][0](args);
          if (typeof out !== 'string') out = JSON.stringify(out, null, 1);
        } catch (e) { out = e.quiet ? e.message : `ERROR: ${e.message}`; }
        if (out.length > 16000) out = out.slice(0, 16000) + '\n...(truncated)';
        log(`     → ${out.split('\n')[0].slice(0, 140)}`);
        toolsUsed++;
        messages.push({ role: 'tool', tool_call_id: c.id, name, content: out, t: Date.now() });
        onEvent({ type: 'message', i: messages.length - 1, message: messages[messages.length - 1] });
      }
    }
    onEvent({ type: 'notice', text: `툴 호출이 ${maxSteps}단계를 넘어 멈췄습니다. "계속"이라고 보내면 이어서 합니다.` });
  }

  return {
    run, systemPrompt, readRules, writeRules, customTools, home, settings,
    // run one tool outside a conversation (tests, CLI); hub actions are refused here since nobody can approve them
    async callTool(name, args = {}) { const t = toolTable(); if (!t[name]) throw new Error(`unknown tool ${name}`); if (t[name][3]) throw new Error(`${name} needs approval`); return t[name][0](args); },
    approveTool(name) { const t = customTools().find((x) => x.name === name); if (!t) throw new Error(`no tool ${name}`); return setApproved(t.dir, 'user'); },
    removeTool(name) { const t = customTools().find((x) => x.name === name); if (!t) throw new Error(`no tool ${name}`); fs.renameSync(t.dir, path.join(toolDir, `.removed-${Date.now()}-${name}`)); },
    toolSource(name) { const t = customTools().find((x) => x.name === name); if (!t) throw new Error(`no tool ${name}`); return { ...t, dir: undefined, code: fs.readFileSync(path.join(t.dir, t.file), 'utf8') }; },
  };
}

module.exports = { createAgent, CTX_TOKENS };
