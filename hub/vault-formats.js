'use strict';

const fs = require('fs');
const path = require('path');

const ALL_CLIS = ['claude', 'codex', 'agy'];
const SECRET_KEY_RE = /(TOKEN|KEY|SECRET|AUTH|PASS|BEARER|CREDENTIAL)/i;
const BUNDLED_SYSTEM_SKILLS = new Set(['.system', 'builtin']);
const CODEX_INTERNAL_MCPS = new Set(['node_repl']);

/** Mask sensitive token/header strings for UI display. */
function maskSecret(val) {
  const s = String(val ?? '');
  if (!s) return '';
  if (s.length <= 6) return '••••••';
  return `${s.slice(0, 3)}••••${s.slice(-2)}`;
}

/** Sanitize a vault skill or rule name into a safe single path segment. */
function safeName(raw) {
  return String(raw || '')
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/\.+/g, (m) => (m === '..' ? '-' : m))
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function readJsonSafe(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

function backupFile(file, tag = 'hub-vault') {
  if (!file || !fs.existsSync(file)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const bak = `${file}.bak-${tag}-${stamp}`;
  fs.copyFileSync(file, bak);
  return bak;
}

function copyDirRecursive(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (ent.name === '.git' || ent.name === 'node_modules') continue;
    const from = path.join(src, ent.name);
    const to = path.join(dst, ent.name);
    let st;
    try { st = fs.statSync(from); } catch { continue; }
    if (st.isDirectory()) copyDirRecursive(from, to);
    else if (st.isFile()) fs.copyFileSync(from, to);
  }
}

function isSymlinkOrJunction(p) {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
}

function pointsInside(linkPath, targetDir) {
  try {
    const a = fs.realpathSync(linkPath);
    const b = fs.realpathSync(targetDir);
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
}

/** Rename a directory, falling back to recursive copy+delete across EXDEV/EPERM volumes. */
function moveDirSafe(src, dst, renameFn = fs.renameSync) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  try {
    renameFn(src, dst);
  } catch (err) {
    if (err && (err.code === 'EXDEV' || err.code === 'EPERM')) {
      fs.cpSync(src, dst, { recursive: true, force: true, dereference: true });
      fs.rmSync(src, { recursive: true, force: true });
    } else {
      throw err;
    }
  }
}

function backupSkillDir(src, backupRoot) {
  fs.mkdirSync(backupRoot, { recursive: true });
  const backup = path.join(fs.mkdtempSync(path.join(backupRoot, 'skill-')), path.basename(src));
  moveDirSafe(src, backup);
  return backup;
}

/** Install a reference to the Vault, preserving any existing slot until a link can be created. */
function linkSkillDir(srcDir, dstDir, backupRoot) {
  const realSrc = fs.realpathSync(srcDir);
  const isLink = isSymlinkOrJunction(dstDir);
  if (pointsInside(dstDir, realSrc)) return 'unchanged';
  fs.mkdirSync(path.dirname(dstDir), { recursive: true });
  const stage = fs.mkdtempSync(path.join(path.dirname(dstDir), '.hub-skill-'));
  const link = path.join(stage, 'link');
  let backup;
  try {
    fs.symlinkSync(realSrc, link, process.platform === 'win32' ? 'junction' : 'dir');
    if (isLink) fs.renameSync(dstDir, path.join(stage, 'previous'));
    else if (fs.existsSync(dstDir)) backup = backupSkillDir(dstDir, backupRoot);
    try {
      fs.renameSync(link, dstDir);
    } catch (err) {
      if (isLink) fs.renameSync(path.join(stage, 'previous'), dstDir);
      else if (backup) moveDirSafe(backup, dstDir);
      throw err;
    }
    if (isLink) fs.unlinkSync(path.join(stage, 'previous'));
    return 'linked';
  } finally {
    if (isSymlinkOrJunction(link)) fs.unlinkSync(link);
    if (!fs.readdirSync(stage).length) fs.rmdirSync(stage);
  }
}

/** Extract name and description fields from SKILL.md YAML frontmatter. */
function parseSkillFrontmatter(mdText) {
  const s = String(mdText || '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(s);
  if (!m) return { name: '', description: '' };
  const body = m[1];
  const nameM = /^name:[ \t]*(.+)$/m.exec(body);
  const multiM = /^description:[ \t]*[>|][+-]?[ \t]*\r?\n((?:(?:[ \t]+.+|[ \t]*)\r?\n?)+)/m.exec(body);
  let description = '';
  if (multiM) {
    description = multiM[1].split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join(' ');
  } else {
    const descSingle = /^description:[ \t]*(?![>|])(\S.*)$/m.exec(body);
    if (descSingle) description = descSingle[1].replace(/^['"]|['"]$/g, '').trim();
  }
  return {
    name: nameM ? nameM[1].replace(/^['"]|['"]$/g, '').trim() : '',
    description: description.slice(0, 260),
  };
}

function splitTopLevelCommas(inner) {
  const items = [];
  let cur = '', quote = null, esc = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (esc) { cur += ch; esc = false; continue; }
    if (ch === '\\' && quote === '"') { cur += ch; esc = true; continue; }
    if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === ',') { items.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) items.push(cur);
  return items;
}

// ---- Minimal Codex config.toml [mcp_servers.*] parser & formatter ----
function parseTomlValue(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+(?:\.\d+)?$/.test(s)) return Number(s);
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    if (s.startsWith("'")) return s.slice(1, -1);
    try { return JSON.parse(s); } catch { return s.slice(1, -1); }
  }
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    return inner ? splitTopLevelCommas(inner).map((item) => parseTomlValue(item)) : [];
  }
  if (s.startsWith('{') && s.endsWith('}')) {
    const inner = s.slice(1, -1).trim();
    const map = {};
    if (!inner) return map;
    for (const pair of splitTopLevelCommas(inner)) {
      const eq = pair.indexOf('=');
      if (eq < 0) continue;
      const pk = unquoteTomlKey(pair.slice(0, eq));
      if (pk) map[pk] = String(parseTomlValue(pair.slice(eq + 1)) ?? '');
    }
    return map;
  }
  return s;
}

function unquoteTomlKey(k) {
  const s = String(k || '').trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function formatTomlKey(k) {
  return /^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k);
}

function formatTomlValue(val) {
  if (typeof val === 'boolean' || typeof val === 'number') return String(val);
  if (Array.isArray(val)) return `[${val.map((x) => JSON.stringify(String(x))).join(', ')}]`;
  return JSON.stringify(String(val ?? ''));
}

/** Parse [mcp_servers.*] sections from Codex config.toml text. */
function parseCodexMcpToml(tomlText) {
  const servers = {};
  let section = null;
  for (const rawLine of String(tomlText || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const secM = /^\[([^\]]+)\]$/.exec(line);
    if (secM) {
      const m = /^mcp_servers\.((?:"[^"]+"|'[^']+'|[^.\s]+))(?:\.(env|headers|http_headers))?$/.exec(secM[1].trim());
      if (m) {
        const name = unquoteTomlKey(m[1]);
        const sub = m[2] === 'http_headers' ? 'headers' : (m[2] || null);
        if (!servers[name]) servers[name] = { enabled: true };
        section = { name, sub };
      } else {
        section = null;
      }
      continue;
    }
    if (!section) continue;
    const kv = /^([A-Za-z0-9_.-]+|"[^"]+"|'[^']+')\s*=\s*(.+)$/.exec(line);
    if (!kv) continue;
    const key = unquoteTomlKey(kv[1]);
    let valPart = kv[2].trim();
    let quote = null, esc = false;
    for (let i = 0; i < valPart.length; i++) {
      const ch = valPart[i];
      if (esc) { esc = false; continue; }
      if (ch === '\\' && quote === '"') { esc = true; continue; }
      if (quote) { if (ch === quote) quote = null; continue; }
      if (ch === '"' || ch === "'") { quote = ch; continue; }
      if (ch === '#') { valPart = valPart.slice(0, i).trim(); break; }
    }
    const val = parseTomlValue(valPart);
    const target = servers[section.name];
    if (section.sub === 'env') {
      target.env = target.env || {};
      target.env[key] = String(val ?? '');
    } else if (section.sub === 'headers') {
      target.headers = target.headers || {};
      target.headers[key] = String(val ?? '');
    } else if (key === 'http_headers' && val && typeof val === 'object' && !Array.isArray(val)) {
      target.headers = { ...(target.headers || {}), ...val };
    } else if (key === 'env' && val && typeof val === 'object' && !Array.isArray(val)) {
      target.env = { ...(target.env || {}), ...val };
    } else {
      target[key] = val;
    }
  }
  return servers;
}

/** Serialize normalized MCP servers into a guarded Codex TOML block. */
function serializeCodexMcpBlock(serversMap) {
  const names = Object.keys(serversMap);
  if (!names.length) return '';
  const blocks = ['# BEGIN HUB-VAULT MCP'];
  for (const name of names) {
    const cfg = serversMap[name];
    const k = formatTomlKey(name);
    blocks.push(`[mcp_servers.${k}]`);
    if (cfg.command) blocks.push(`command = ${formatTomlValue(cfg.command)}`);
    if (Array.isArray(cfg.args)) blocks.push(`args = ${formatTomlValue(cfg.args)}`);
    if (cfg.url) blocks.push(`url = ${formatTomlValue(cfg.url)}`);
    if (cfg.bearer_token) blocks.push(`bearer_token = ${formatTomlValue(cfg.bearer_token)}`);
    if (cfg.enabled === false) blocks.push('enabled = false');
    if (cfg.startup_timeout_sec) blocks.push(`startup_timeout_sec = ${Number(cfg.startup_timeout_sec)}`);
    if (cfg.tool_timeout_sec) blocks.push(`tool_timeout_sec = ${Number(cfg.tool_timeout_sec)}`);
    if (cfg.env && Object.keys(cfg.env).length) {
      blocks.push(`[mcp_servers.${k}.env]`);
      for (const [ek, ev] of Object.entries(cfg.env)) {
        blocks.push(`${formatTomlKey(ek)} = ${formatTomlValue(ev)}`);
      }
    }
    if (cfg.headers && Object.keys(cfg.headers).length) {
      blocks.push(`[mcp_servers.${k}.http_headers]`);
      for (const [hk, hv] of Object.entries(cfg.headers)) {
        blocks.push(`${formatTomlKey(hk)} = ${formatTomlValue(hv)}`);
      }
    }
    blocks.push('');
  }
  blocks.push('# END HUB-VAULT MCP');
  return blocks.join('\n');
}

/** Strip vault-managed [mcp_servers.*] sections from Codex TOML text before rewriting. */
function stripManagedTomlSections(tomlText, managedNamesSet) {
  const text = String(tomlText || '').replace(/\r?\n?# BEGIN HUB-VAULT MCP[\s\S]*?# END HUB-VAULT MCP\r?\n?/g, '\n');
  if (!managedNamesSet || !managedNamesSet.size) return text;
  const out = [];
  let skipping = false;
  for (const line of text.split(/\r?\n/)) {
    const secM = /^\[([^\]]+)\]$/.exec(line.trim());
    if (secM) {
      const m = /^mcp_servers\.((?:"[^"]+"|'[^']+'|[^.\s]+))(?:\.(?:env|headers|http_headers))?$/.exec(secM[1].trim());
      if (m && managedNamesSet.has(unquoteTomlKey(m[1]))) {
        skipping = true;
        continue;
      }
      skipping = false;
    }
    if (!skipping) out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

/** Insert or replace the delimited hub-vault block inside a Markdown harness file. */
function upsertManagedMarkdownBlock(filePath, contentText) {
  const begin = '<!-- hub-vault:begin -->';
  const end = '<!-- hub-vault:end -->';
  const cleanBody = String(contentText || '').trim();
  const block = cleanBody ? `${begin}\n${cleanBody}\n${end}\n` : '';
  const cur = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  const re = /<!-- hub-vault:begin -->[\s\S]*?<!-- hub-vault:end -->\r?\n?/g;
  const next = re.test(cur)
    ? cur.replace(re, block)
    : (block ? cur.trimEnd() + (cur.trim() ? '\n\n' : '') + block : cur);
  if (next !== cur) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (fs.existsSync(filePath)) backupFile(filePath, 'hub-vault');
    fs.writeFileSync(filePath, next, 'utf8');
    return true;
  }
  return false;
}

/** Build native config/skill/harness paths for all supported CLIs under homeDir. */
function getCliPaths(homeDir) {
  return {
    claude: {
      label: 'Claude Code',
      skillDirs: [path.join(homeDir, '.claude', 'skills')],
      mcpFile: path.join(homeDir, '.claude.json'),
      harnessFile: path.join(homeDir, '.claude', 'CLAUDE.md'),
    },
    codex: {
      label: 'Codex CLI',
      skillDirs: [path.join(homeDir, '.codex', 'skills')],
      mcpFile: path.join(homeDir, '.codex', 'config.toml'),
      harnessFile: path.join(homeDir, '.codex', 'AGENTS.md'),
      rulesDir: path.join(homeDir, '.codex', 'rules'),
    },
    agy: {
      label: 'Antigravity',
      skillDirs: [
        path.join(homeDir, '.gemini', 'antigravity-cli', 'skills'),
        path.join(homeDir, '.gemini', 'antigravity', 'skills'),
        path.join(homeDir, '.gemini', 'config', 'skills'),
      ],
      mcpFile: path.join(homeDir, '.gemini', 'config', 'mcp_config.json'),
      extraMcpFiles: [path.join(homeDir, '.gemini', 'antigravity', 'mcp_config.json')],
      harnessFile: path.join(homeDir, '.gemini', 'GEMINI.md'),
      rulesDir: path.join(homeDir, '.gemini', 'config', 'rules'),
    },
  };
}

/** Normalize a CLI MCP entry into the shared Vault MCP schema. */
function normalizeImportedMcp(name, cfg, srcCli, targetsOverride = null, isEnabled = true) {
  const isCodexInternal = CODEX_INTERNAL_MCPS.has(name);
  const url = cfg.url || cfg.httpUrl || cfg.serverUrl || '';
  return {
    ...(cfg.command ? { command: cfg.command } : {}),
    ...(Array.isArray(cfg.args) ? { args: cfg.args } : {}),
    ...(url ? { url } : {}),
    ...(cfg.bearer_token ? { bearer_token: cfg.bearer_token } : {}),
    ...(cfg.env && Object.keys(cfg.env).length ? { env: cfg.env } : {}),
    ...(cfg.headers && Object.keys(cfg.headers).length ? { headers: cfg.headers } : {}),
    ...(cfg.startup_timeout_sec ? { startup_timeout_sec: cfg.startup_timeout_sec } : {}),
    ...(cfg.tool_timeout_sec ? { tool_timeout_sec: cfg.tool_timeout_sec } : {}),
    enabled: isEnabled && cfg.enabled !== false,
    targets: isCodexInternal ? ['codex'] : (targetsOverride ? [...targetsOverride] : [...ALL_CLIS]),
    source: srcCli,
    ...(isCodexInternal ? { cliOnly: true } : {}),
  };
}

module.exports = {
  ALL_CLIS,
  SECRET_KEY_RE,
  BUNDLED_SYSTEM_SKILLS,
  CODEX_INTERNAL_MCPS,
  maskSecret,
  safeName,
  readJsonSafe,
  writeJsonAtomic,
  backupFile,
  copyDirRecursive,
  isSymlinkOrJunction,
  pointsInside,
  moveDirSafe,
  backupSkillDir,
  linkSkillDir,
  parseSkillFrontmatter,
  parseCodexMcpToml,
  serializeCodexMcpBlock,
  stripManagedTomlSections,
  upsertManagedMarkdownBlock,
  getCliPaths,
  normalizeImportedMcp,
};
