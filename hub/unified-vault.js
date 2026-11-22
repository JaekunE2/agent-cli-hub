'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ALL_CLIS = ['claude', 'codex', 'agy'];
const SECRET_KEY_RE = /(TOKEN|KEY|SECRET|AUTH|PASS|BEARER|CREDENTIAL)/i;
const BUNDLED_SYSTEM_SKILLS = new Set(['.system', 'builtin']);
const CODEX_INTERNAL_MCPS = new Set(['node_repl']);

function maskSecret(val) {
  const s = String(val ?? '');
  if (!s) return '';
  if (s.length <= 6) return '••••••';
  return `${s.slice(0, 3)}••••${s.slice(-2)}`;
}

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

function linkOrCopySkillDir(srcDir, dstDir, backupRoot) {
  const realSrc = fs.existsSync(srcDir) ? fs.realpathSync(srcDir) : srcDir;
  if (fs.existsSync(dstDir)) {
    if (isSymlinkOrJunction(dstDir) && pointsInside(dstDir, realSrc)) {
      return 'unchanged';
    }
    if (isSymlinkOrJunction(dstDir)) {
      fs.rmSync(dstDir, { recursive: true, force: true });
    } else {
      if (backupRoot) {
        fs.mkdirSync(backupRoot, { recursive: true });
        const bak = path.join(backupRoot, `${path.basename(dstDir)}-${Date.now()}`);
        fs.renameSync(dstDir, bak);
      } else {
        fs.rmSync(dstDir, { recursive: true, force: true });
      }
    }
  }
  fs.mkdirSync(path.dirname(dstDir), { recursive: true });
  try {
    fs.symlinkSync(realSrc, dstDir, process.platform === 'win32' ? 'junction' : 'dir');
    return 'linked';
  } catch {
    copyDirRecursive(realSrc, dstDir);
    return 'copied';
  }
}

function parseSkillFrontmatter(mdText) {
  const s = String(mdText || '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(s);
  if (!m) return { name: '', description: '' };
  const body = m[1];
  const nameM = /^name:\s*(.+)$/m.exec(body);
  const descSingle = /^description:\s*(?![>|])(.+)$/m.exec(body);
  let description = descSingle ? descSingle[1].replace(/^['"]|['"]$/g, '').trim() : '';
  if (!description) {
    const multiM = /^description:\s*[>|]-?\r?\n((?:[ \t]+.+\r?\n?)+)/m.exec(body);
    if (multiM) description = multiM[1].split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join(' ');
  }
  return {
    name: nameM ? nameM[1].replace(/^['"]|['"]$/g, '').trim() : '',
    description: description.slice(0, 260),
  };
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
    if (!inner) return [];
    const items = [];
    let cur = '', quote = null, esc = false;
    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i];
      if (esc) { cur += ch; esc = false; continue; }
      if (ch === '\\' && quote === '"') { cur += ch; esc = true; continue; }
      if (quote) {
        cur += ch;
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
      if (ch === ',') { items.push(parseTomlValue(cur)); cur = ''; continue; }
      cur += ch;
    }
    if (cur.trim()) items.push(parseTomlValue(cur));
    return items;
  }
  if (s.startsWith('{') && s.endsWith('}')) {
    const inner = s.slice(1, -1).trim();
    const map = {};
    if (!inner) return map;
    const pairs = [];
    let cur = '', quote = null, esc = false;
    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i];
      if (esc) { cur += ch; esc = false; continue; }
      if (ch === '\\' && quote === '"') { cur += ch; esc = true; continue; }
      if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
      if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
      if (ch === ',') { pairs.push(cur); cur = ''; continue; }
      cur += ch;
    }
    if (cur.trim()) pairs.push(cur);
    for (const pair of pairs) {
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

function parseCodexMcpToml(tomlText) {
  const servers = {};
  let section = null; // { name, sub: null | 'env' | 'headers' }
  for (const rawLine of String(tomlText || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const secM = /^\[([^\]]+)\]$/.exec(line);
    if (secM) {
      const head = secM[1].trim();
      const m = /^mcp_servers\.((?:"[^"]+"|'[^']+'|[^.\s]+))(?:\.(env|headers|http_headers))?$/.exec(head);
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
    // strip trailing comment outside quotes
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

function stripManagedTomlSections(tomlText, managedNamesSet) {
  let text = String(tomlText || '').replace(/\r?\n?# BEGIN HUB-VAULT MCP[\s\S]*?# END HUB-VAULT MCP\r?\n?/g, '\n');
  if (!managedNamesSet || !managedNamesSet.size) return text;
  const lines = text.split(/\r?\n/);
  const out = [];
  let skipping = false;
  for (const line of lines) {
    const trimmed = line.trim();
    const secM = /^\[([^\]]+)\]$/.exec(trimmed);
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

function upsertManagedMarkdownBlock(filePath, contentText) {
  const begin = '<!-- hub-vault:begin -->';
  const end = '<!-- hub-vault:end -->';
  const cleanBody = String(contentText || '').trim();
  const block = cleanBody ? `${begin}\n${cleanBody}\n${end}\n` : '';
  const cur = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  const re = /<!-- hub-vault:begin -->[\s\S]*?<!-- hub-vault:end -->\r?\n?/g;
  let next;
  if (re.test(cur)) {
    next = cur.replace(re, block);
  } else if (block) {
    next = cur.trimEnd() + (cur.trim() ? '\n\n' : '') + block;
  } else {
    next = cur;
  }
  if (next !== cur) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (fs.existsSync(filePath)) backupFile(filePath, 'hub-vault');
    fs.writeFileSync(filePath, next, 'utf8');
    return true;
  }
  return false;
}

function createUnifiedVault({ repoRoot, homeDir = os.homedir(), vaultDir = '', configPath = '' }) {
  let currentVaultDir = path.resolve(vaultDir || path.join(repoRoot, 'vault'));

  const layout = () => ({
    root: currentVaultDir,
    skillsDir: path.join(currentVaultDir, 'skills'),
    mcpFile: path.join(currentVaultDir, 'mcp', 'servers.json'),
    harnessDir: path.join(currentVaultDir, 'harness'),
    sharedHarnessFile: path.join(currentVaultDir, 'harness', 'shared.md'),
    rulesDir: path.join(currentVaultDir, 'harness', 'rules'),
    manifestFile: path.join(currentVaultDir, 'manifest.json'),
    backupDir: path.join(currentVaultDir, '.sync-backups'),
  });

  const cliPaths = () => ({
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
  });

  const ensureVaultDirs = () => {
    const l = layout();
    fs.mkdirSync(l.skillsDir, { recursive: true });
    fs.mkdirSync(path.dirname(l.mcpFile), { recursive: true });
    fs.mkdirSync(l.rulesDir, { recursive: true });
    if (!fs.existsSync(l.sharedHarnessFile)) {
      fs.writeFileSync(
        l.sharedHarnessFile,
        '# 공통 에이전트 하네스 (Agent CLI Hub Vault)\n이 지침은 Claude Code · Codex · Antigravity에 공통 적용됩니다.\n',
        'utf8'
      );
    }
    if (!fs.existsSync(l.mcpFile)) writeJsonAtomic(l.mcpFile, {});
    if (!fs.existsSync(l.manifestFile)) {
      writeJsonAtomic(l.manifestFile, { skills: {}, rules: {}, lastGatherAt: 0, lastSyncAt: 0, lastSyncSummary: null });
    }
    return l;
  };

  const readManifest = () => {
    const l = ensureVaultDirs();
    const m = readJsonSafe(l.manifestFile, {});
    return {
      skills: m?.skills && typeof m.skills === 'object' ? m.skills : {},
      rules: m?.rules && typeof m.rules === 'object' ? m.rules : {},
      lastGatherAt: Number(m?.lastGatherAt || 0),
      lastSyncAt: Number(m?.lastSyncAt || 0),
      lastSyncSummary: m?.lastSyncSummary || null,
    };
  };

  const writeManifest = (m) => writeJsonAtomic(layout().manifestFile, m);

  const readMcps = () => {
    const l = ensureVaultDirs();
    const raw = readJsonSafe(l.mcpFile, {});
    return raw && typeof raw === 'object' ? raw : {};
  };

  const writeMcps = (obj) => writeJsonAtomic(layout().mcpFile, obj);

  const countSkillsInDir = (dir) => {
    if (!fs.existsSync(dir)) return 0;
    try {
      return fs.readdirSync(dir, { withFileTypes: true })
        .filter((e) => !BUNDLED_SYSTEM_SKILLS.has(e.name) && (e.isDirectory() || e.isSymbolicLink()))
        .length;
    } catch { return 0; }
  };

  const getCliStatus = () => {
    const p = cliPaths();
    const claudeMcp = readJsonSafe(p.claude.mcpFile, {})?.mcpServers || {};
    const codexMcp = fs.existsSync(p.codex.mcpFile) ? parseCodexMcpToml(fs.readFileSync(p.codex.mcpFile, 'utf8')) : {};
    const agyMcp = readJsonSafe(p.agy.mcpFile, {})?.mcpServers || {};
    return {
      claude: {
        label: p.claude.label,
        skillsCount: countSkillsInDir(p.claude.skillDirs[0]),
        mcpCount: Object.keys(claudeMcp).length,
        hasHarness: fs.existsSync(p.claude.harnessFile),
        skillDir: p.claude.skillDirs[0],
        mcpFile: p.claude.mcpFile,
        harnessFile: p.claude.harnessFile,
      },
      codex: {
        label: p.codex.label,
        skillsCount: countSkillsInDir(p.codex.skillDirs[0]),
        mcpCount: Object.keys(codexMcp).length,
        hasHarness: fs.existsSync(p.codex.harnessFile),
        skillDir: p.codex.skillDirs[0],
        mcpFile: p.codex.mcpFile,
        harnessFile: p.codex.harnessFile,
      },
      agy: {
        label: p.agy.label,
        skillsCount: countSkillsInDir(p.agy.skillDirs[0]),
        mcpCount: Object.keys(agyMcp).length,
        hasHarness: fs.existsSync(p.agy.harnessFile) || fs.existsSync(path.join(p.agy.rulesDir, 'hub-vault-harness.md')),
        skillDir: p.agy.skillDirs[0],
        mcpFile: p.agy.mcpFile,
        harnessFile: p.agy.harnessFile,
      },
    };
  };

  const listSkills = () => {
    const l = ensureVaultDirs();
    const manifest = readManifest();
    const out = [];
    for (const ent of fs.readdirSync(l.skillsDir, { withFileTypes: true })) {
      if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
      const skillPath = path.join(l.skillsDir, ent.name);
      const mdPath = path.join(skillPath, 'SKILL.md');
      const hasMd = fs.existsSync(mdPath);
      const mdContent = hasMd ? fs.readFileSync(mdPath, 'utf8') : '';
      const meta = parseSkillFrontmatter(mdContent);
      const m = manifest.skills[ent.name] || {};
      out.push({
        name: ent.name,
        displayName: meta.name || ent.name,
        description: meta.description || '',
        hasSkillMd: hasMd,
        enabled: m.enabled !== false,
        targets: Array.isArray(m.targets) ? m.targets.filter((x) => ALL_CLIS.includes(x)) : [...ALL_CLIS],
        sources: Array.isArray(m.sources) ? m.sources : [],
        path: skillPath,
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  };

  const listRules = () => {
    const l = ensureVaultDirs();
    const manifest = readManifest();
    const out = [];
    for (const ent of fs.readdirSync(l.rulesDir, { withFileTypes: true })) {
      if (!ent.isFile() || !/\.(md|rules|txt)$/i.test(ent.name)) continue;
      const filePath = path.join(l.rulesDir, ent.name);
      const content = fs.readFileSync(filePath, 'utf8');
      const m = manifest.rules[ent.name] || {};
      out.push({
        name: ent.name,
        content,
        size: Buffer.byteLength(content, 'utf8'),
        enabled: m.enabled !== false,
        targets: Array.isArray(m.targets) ? m.targets.filter((x) => ALL_CLIS.includes(x)) : [...ALL_CLIS],
        source: m.source || 'vault',
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  };

  const maskedMcps = () => {
    const raw = readMcps();
    return Object.entries(raw).map(([name, cfg]) => {
      const env = {};
      for (const [k, v] of Object.entries(cfg.env || {})) {
        env[k] = SECRET_KEY_RE.test(k) ? maskSecret(v) : String(v);
      }
      const headers = {};
      for (const [k, v] of Object.entries(cfg.headers || {})) {
        headers[k] = SECRET_KEY_RE.test(k) ? maskSecret(v) : String(v);
      }
      return {
        name,
        transport: cfg.url ? 'http' : 'stdio',
        command: cfg.command || '',
        args: Array.isArray(cfg.args) ? cfg.args : [],
        url: cfg.url || '',
        hasBearerToken: !!cfg.bearer_token,
        env,
        headers,
        enabled: cfg.enabled !== false,
        targets: Array.isArray(cfg.targets) ? cfg.targets.filter((x) => ALL_CLIS.includes(x)) : [...ALL_CLIS],
        source: cfg.source || 'vault',
        cliOnly: !!cfg.cliOnly,
      };
    }).sort((a, b) => a.name.localeCompare(b.name));
  };

  const getState = () => {
    const l = ensureVaultDirs();
    const manifest = readManifest();
    return {
      vaultDir: l.root,
      clis: getCliStatus(),
      skills: listSkills(),
      mcps: maskedMcps(),
      sharedHarness: fs.readFileSync(l.sharedHarnessFile, 'utf8'),
      rules: listRules(),
      lastGatherAt: manifest.lastGatherAt,
      lastSyncAt: manifest.lastSyncAt,
      lastSyncSummary: manifest.lastSyncSummary,
    };
  };

  const gatherFromClis = () => {
    const l = ensureVaultDirs();
    const p = cliPaths();
    const manifest = readManifest();
    const mcps = readMcps();
    let addedSkills = 0;
    let addedMcps = 0;
    let addedRules = 0;

    // 1) Gather skills from Claude, Codex, AGY, ~/.agents, and repo/skills
    const skillSources = [
      ...p.claude.skillDirs.map((d) => ['claude', d]),
      ...p.codex.skillDirs.map((d) => ['codex', d]),
      ...p.agy.skillDirs.map((d) => ['agy', d]),
      ['shared', path.join(homeDir, '.agents', 'skills')],
      ['hub', path.join(repoRoot, 'skills')],
    ];
    for (const [srcLabel, dir] of skillSources) {
      if (!fs.existsSync(dir)) continue;
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (BUNDLED_SYSTEM_SKILLS.has(ent.name) || ent.name.startsWith('.')) continue;
        if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
        const fromDir = path.join(dir, ent.name);
        let realFrom;
        try { realFrom = fs.realpathSync(fromDir); } catch { continue; }
        if (!fs.existsSync(path.join(realFrom, 'SKILL.md'))) continue;
        const dstDir = path.join(l.skillsDir, ent.name);
        if (!fs.existsSync(dstDir)) {
          copyDirRecursive(realFrom, dstDir);
          addedSkills++;
        }
        const prev = manifest.skills[ent.name] || { enabled: true, targets: [...ALL_CLIS], sources: [] };
        if (!prev.sources.includes(srcLabel)) prev.sources.push(srcLabel);
        manifest.skills[ent.name] = prev;
      }
    }

    // 2) Gather MCP servers from Codex, Claude, AGY
    const mergeMcp = (name, cfg, srcCli) => {
      if (!name) return;
      const isCodexInternal = CODEX_INTERNAL_MCPS.has(name);
      const url = cfg.url || cfg.httpUrl || cfg.serverUrl || '';
      if (!mcps[name]) {
        mcps[name] = {
          ...(cfg.command ? { command: cfg.command } : {}),
          ...(Array.isArray(cfg.args) ? { args: cfg.args } : {}),
          ...(url ? { url } : {}),
          ...(cfg.bearer_token ? { bearer_token: cfg.bearer_token } : {}),
          ...(cfg.env && Object.keys(cfg.env).length ? { env: cfg.env } : {}),
          ...(cfg.headers && Object.keys(cfg.headers).length ? { headers: cfg.headers } : {}),
          ...(cfg.startup_timeout_sec ? { startup_timeout_sec: cfg.startup_timeout_sec } : {}),
          ...(cfg.tool_timeout_sec ? { tool_timeout_sec: cfg.tool_timeout_sec } : {}),
          enabled: cfg.enabled !== false,
          targets: isCodexInternal ? ['codex'] : [...ALL_CLIS],
          source: srcCli,
          ...(isCodexInternal ? { cliOnly: true } : {}),
        };
        addedMcps++;
      }
    };

    if (fs.existsSync(p.codex.mcpFile)) {
      const parsed = parseCodexMcpToml(fs.readFileSync(p.codex.mcpFile, 'utf8'));
      for (const [name, cfg] of Object.entries(parsed)) mergeMcp(name, cfg, 'codex');
    }
    const claudeServers = readJsonSafe(p.claude.mcpFile, {})?.mcpServers || {};
    for (const [name, cfg] of Object.entries(claudeServers)) mergeMcp(name, cfg, 'claude');
    for (const mf of [p.agy.mcpFile, ...p.agy.extraMcpFiles]) {
      const s = readJsonSafe(mf, {})?.mcpServers || {};
      for (const [name, cfg] of Object.entries(s)) mergeMcp(name, cfg, 'agy');
    }

    // 3) Gather rules / harnesses
    const ruleSources = [
      ['codex', p.codex.rulesDir],
      ['agy', p.agy.rulesDir],
    ];
    for (const [srcCli, rdir] of ruleSources) {
      if (!rdir || !fs.existsSync(rdir)) continue;
      for (const ent of fs.readdirSync(rdir, { withFileTypes: true })) {
        if (!ent.isFile() || ent.name === 'hub-vault-harness.md' || !/\.(md|rules|txt)$/i.test(ent.name)) continue;
        const dstName = `${srcCli}-${ent.name}`;
        const dstFile = path.join(l.rulesDir, dstName);
        if (!fs.existsSync(dstFile)) {
          fs.copyFileSync(path.join(rdir, ent.name), dstFile);
          addedRules++;
        }
        if (!manifest.rules[dstName]) {
          manifest.rules[dstName] = { enabled: false, targets: [srcCli], source: srcCli };
        }
      }
    }

    manifest.lastGatherAt = Date.now();
    writeMcps(mcps);
    writeManifest(manifest);
    return { ok: true, addedSkills, addedMcps, addedRules, state: getState() };
  };

  const syncToClis = ({ clis = ALL_CLIS } = {}) => {
    const l = ensureVaultDirs();
    const p = cliPaths();
    const manifest = readManifest();
    const mcps = readMcps();
    const targets = ALL_CLIS.filter((c) => clis.includes(c));
    const report = { clis: {}, backedUp: [] };

    const skills = listSkills();
    const rules = listRules();
    const sharedText = fs.readFileSync(l.sharedHarnessFile, 'utf8').trim();

    for (const cli of targets) {
      const cliCfg = p[cli];
      const summary = { skillsLinked: 0, skillsRemoved: 0, mcpsWritten: 0, harnessUpdated: false };

      // 1) Sync skills (junctions for enabled targets; remove vault-owned junctions when disabled)
      for (const sk of skills) {
        const active = sk.enabled && sk.targets.includes(cli);
        for (const sdir of cliCfg.skillDirs) {
          fs.mkdirSync(sdir, { recursive: true });
          const dst = path.join(sdir, sk.name);
          if (active) {
            const st = linkOrCopySkillDir(sk.path, dst, path.join(l.backupDir, cli));
            if (st === 'linked' || st === 'copied') summary.skillsLinked++;
          } else if (isSymlinkOrJunction(dst) && pointsInside(dst, sk.path)) {
            fs.rmSync(dst, { recursive: true, force: true });
            summary.skillsRemoved++;
          }
        }
      }

      // 2) Sync MCP servers
      const activeMcps = {};
      for (const [name, cfg] of Object.entries(mcps)) {
        if (cfg.enabled !== false && (Array.isArray(cfg.targets) ? cfg.targets : ALL_CLIS).includes(cli)) {
          activeMcps[name] = cfg;
        }
      }
      if (cli === 'claude') {
        const cur = readJsonSafe(cliCfg.mcpFile, {}) || {};
        const bak = backupFile(cliCfg.mcpFile, 'hub-vault');
        if (bak) report.backedUp.push(bak);
        const nextServers = { ...(cur.mcpServers || {}) };
        for (const [name, cfg] of Object.entries(mcps)) {
          if (!activeMcps[name]) {
            if (cfg.source === 'vault' || cfg.managed) delete nextServers[name];
            continue;
          }
          nextServers[name] = cfg.url
            ? { type: 'http', url: cfg.url, ...(cfg.headers ? { headers: cfg.headers } : {}) }
            : { command: cfg.command, args: cfg.args || [], ...(cfg.env ? { env: cfg.env } : {}) };
          summary.mcpsWritten++;
        }
        cur.mcpServers = nextServers;
        writeJsonAtomic(cliCfg.mcpFile, cur);
      } else if (cli === 'agy') {
        const cur = readJsonSafe(cliCfg.mcpFile, {}) || {};
        const bak = backupFile(cliCfg.mcpFile, 'hub-vault');
        if (bak) report.backedUp.push(bak);
        const nextServers = { ...(cur.mcpServers || {}) };
        for (const [name, cfg] of Object.entries(mcps)) {
          if (!activeMcps[name]) {
            if (cfg.source === 'vault' || cfg.managed) delete nextServers[name];
            continue;
          }
          const headers = { ...(cfg.headers || {}) };
          if (cfg.bearer_token && !headers.Authorization) headers.Authorization = `Bearer ${cfg.bearer_token}`;
          nextServers[name] = cfg.url
            ? { url: cfg.url, ...(Object.keys(headers).length ? { headers } : {}) }
            : { command: cfg.command, args: cfg.args || [], ...(cfg.env ? { env: cfg.env } : {}) };
          summary.mcpsWritten++;
        }
        cur.mcpServers = nextServers;
        writeJsonAtomic(cliCfg.mcpFile, cur);
      } else if (cli === 'codex') {
        const curText = fs.existsSync(cliCfg.mcpFile) ? fs.readFileSync(cliCfg.mcpFile, 'utf8') : '';
        const bak = backupFile(cliCfg.mcpFile, 'hub-vault');
        if (bak) report.backedUp.push(bak);
        const managedNames = new Set(Object.keys(activeMcps));
        const stripped = stripManagedTomlSections(curText, managedNames);
        const block = serializeCodexMcpBlock(activeMcps);
        const nextText = [stripped, block].filter(Boolean).join('\n\n') + '\n';
        fs.mkdirSync(path.dirname(cliCfg.mcpFile), { recursive: true });
        fs.writeFileSync(cliCfg.mcpFile, nextText, 'utf8');
        summary.mcpsWritten = Object.keys(activeMcps).length;
      }

      // 3) Sync Harness & Enabled Rules into CLI global instructions
      const enabledRules = rules.filter((r) => r.enabled && r.targets.includes(cli));
      const combinedParts = [sharedText];
      for (const r of enabledRules) {
        combinedParts.push(`\n## [규칙: ${r.name}]\n${r.content.trim()}`);
      }
      const combined = combinedParts.filter(Boolean).join('\n').trim();
      if (cliCfg.harnessFile) {
        summary.harnessUpdated = upsertManagedMarkdownBlock(cliCfg.harnessFile, combined);
      }
      if (cli === 'agy' && cliCfg.rulesDir) {
        fs.mkdirSync(cliCfg.rulesDir, { recursive: true });
        fs.writeFileSync(path.join(cliCfg.rulesDir, 'hub-vault-harness.md'), combined + '\n', 'utf8');
      }
      report.clis[cli] = summary;
    }

    manifest.lastSyncAt = Date.now();
    manifest.lastSyncSummary = report.clis;
    writeManifest(manifest);
    return { ok: true, report, state: getState() };
  };

  const saveSkill = ({ name, content, enabled = true, targets = ALL_CLIS }) => {
    const clean = safeName(name);
    if (!clean) throw new Error('스킬 이름을 입력하세요.');
    const l = ensureVaultDirs();
    const dir = path.join(l.skillsDir, clean);
    fs.mkdirSync(dir, { recursive: true });
    if (content !== undefined) {
      fs.writeFileSync(path.join(dir, 'SKILL.md'), String(content), 'utf8');
    } else if (!fs.existsSync(path.join(dir, 'SKILL.md'))) {
      fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${clean}\ndescription: Shared skill in Agent CLI Hub Vault\n---\n\n# ${clean}\n`, 'utf8');
    }
    const manifest = readManifest();
    manifest.skills[clean] = {
      ...(manifest.skills[clean] || {}),
      enabled: enabled !== false,
      targets: Array.isArray(targets) ? targets.filter((x) => ALL_CLIS.includes(x)) : [...ALL_CLIS],
    };
    writeManifest(manifest);
    return getState();
  };

  const deleteSkill = (name) => {
    const clean = safeName(name);
    if (!clean) throw new Error('삭제할 스킬 이름이 필요합니다.');
    const l = ensureVaultDirs();
    const skDir = path.join(l.skillsDir, clean);
    const p = cliPaths();
    for (const cli of ALL_CLIS) {
      for (const sdir of p[cli].skillDirs) {
        const dst = path.join(sdir, clean);
        if (isSymlinkOrJunction(dst) && pointsInside(dst, skDir)) {
          fs.rmSync(dst, { recursive: true, force: true });
        }
      }
    }
    if (fs.existsSync(skDir)) fs.rmSync(skDir, { recursive: true, force: true });
    const manifest = readManifest();
    delete manifest.skills[clean];
    writeManifest(manifest);
    return getState();
  };

  const saveMcp = ({ name, command = '', args = [], url = '', env = null, headers = null, bearer_token = '', enabled = true, targets = ALL_CLIS }) => {
    const clean = String(name || '').trim().slice(0, 80);
    if (!clean) throw new Error('MCP 서버 이름을 입력하세요.');
    if (!String(command || '').trim() && !String(url || '').trim()) {
      throw new Error('실행 명령(command) 또는 URL 중 하나를 입력하세요.');
    }
    const mcps = readMcps();
    const prev = mcps[clean] || {};
    const mergePairs = (prevMap, nextMap) => {
      if (!nextMap || typeof nextMap !== 'object') return prevMap || undefined;
      const out = {};
      for (const [k, v] of Object.entries(nextMap)) {
        const key = String(k || '').trim();
        if (!key) continue;
        const val = String(v ?? '');
        if (val.includes('••••') && prevMap && key in prevMap) out[key] = prevMap[key];
        else out[key] = val;
      }
      return Object.keys(out).length ? out : undefined;
    };
    const nextEnv = mergePairs(prev.env, env);
    const nextHeaders = mergePairs(prev.headers, headers);
    mcps[clean] = {
      ...(String(url || '').trim()
        ? { url: String(url).trim(), ...(nextHeaders ? { headers: nextHeaders } : {}), ...(bearer_token ? { bearer_token: String(bearer_token) } : (prev.bearer_token ? { bearer_token: prev.bearer_token } : {})) }
        : { command: String(command).trim(), args: Array.isArray(args) ? args.map(String) : String(args || '').split(/\s+/).filter(Boolean), ...(nextEnv ? { env: nextEnv } : {}) }),
      enabled: enabled !== false,
      targets: Array.isArray(targets) ? targets.filter((x) => ALL_CLIS.includes(x)) : [...ALL_CLIS],
      source: prev.source || 'vault',
      managed: true,
    };
    writeMcps(mcps);
    return getState();
  };

  const deleteMcp = (name) => {
    const mcps = readMcps();
    delete mcps[String(name || '').trim()];
    writeMcps(mcps);
    return getState();
  };

  const saveHarness = ({ shared }) => {
    const l = ensureVaultDirs();
    fs.writeFileSync(l.sharedHarnessFile, String(shared ?? ''), 'utf8');
    return getState();
  };

  const saveRule = ({ name, content, enabled = true, targets = ALL_CLIS }) => {
    let clean = safeName(name);
    if (!clean) throw new Error('규칙 파일 이름을 입력하세요.');
    if (!/\.(md|rules|txt)$/i.test(clean)) clean += '.md';
    const l = ensureVaultDirs();
    if (content !== undefined) fs.writeFileSync(path.join(l.rulesDir, clean), String(content), 'utf8');
    const manifest = readManifest();
    manifest.rules[clean] = {
      ...(manifest.rules[clean] || {}),
      enabled: enabled !== false,
      targets: Array.isArray(targets) ? targets.filter((x) => ALL_CLIS.includes(x)) : [...ALL_CLIS],
    };
    writeManifest(manifest);
    return getState();
  };

  const deleteRule = (name) => {
    const clean = safeName(name);
    const l = ensureVaultDirs();
    const fp = path.join(l.rulesDir, clean);
    if (fs.existsSync(fp)) fs.rmSync(fp, { force: true });
    const manifest = readManifest();
    delete manifest.rules[clean];
    writeManifest(manifest);
    return getState();
  };

  const setVaultDir = (newDir) => {
    const raw = String(newDir || '').trim();
    if (!raw || !path.isAbsolute(raw)) throw new Error('볼트 경로는 절대 경로여야 합니다.');
    currentVaultDir = path.resolve(raw);
    ensureVaultDirs();
    if (configPath) {
      const cfg = readJsonSafe(configPath, {}) || {};
      cfg.vaultDir = currentVaultDir;
      writeJsonAtomic(configPath, cfg);
    }
    return getState();
  };

  const readSkillContent = (name) => {
    const clean = safeName(name);
    if (!clean) throw new Error('스킬 이름이 필요합니다.');
    const l = ensureVaultDirs();
    const mdPath = path.join(l.skillsDir, clean, 'SKILL.md');
    if (!fs.existsSync(mdPath)) return '';
    return fs.readFileSync(mdPath, 'utf8');
  };

  return {
    getState,
    gatherFromClis,
    syncToClis,
    readSkillContent,
    saveSkill,
    deleteSkill,
    saveMcp,
    deleteMcp,
    saveHarness,
    saveRule,
    deleteRule,
    setVaultDir,
  };
}

module.exports = {
  createUnifiedVault,
  parseCodexMcpToml,
  serializeCodexMcpBlock,
  stripManagedTomlSections,
  upsertManagedMarkdownBlock,
  parseSkillFrontmatter,
};
