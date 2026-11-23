// Shared Skills / MCP / Harness · Rules Vault across Claude Code, Codex CLI, and Antigravity
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  ALL_CLIS,
  SECRET_KEY_RE,
  BUNDLED_SYSTEM_SKILLS,
  maskSecret,
  safeName,
  readJsonSafe,
  writeJsonAtomic,
  isSymlinkOrJunction,
  pointsInside,
  moveDirSafe,
  parseSkillFrontmatter,
  parseCodexMcpToml,
  serializeCodexMcpBlock,
  stripManagedTomlSections,
  upsertManagedMarkdownBlock,
  getCliPaths,
} = require('./vault-formats');
const { createVaultCliOps } = require('./vault-cli-ops');

/** Create a Unified Vault manager for skills, MCP servers, shared harness, and CLI rules. */
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

  const cliPaths = () => getCliPaths(homeDir);

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
      writeJsonAtomic(l.manifestFile, { skills: {}, rules: {}, autoLoad: true, lastGatherAt: 0, lastSyncAt: 0, lastSyncSummary: null });
    }
    return l;
  };

  const readManifest = () => {
    const l = ensureVaultDirs();
    const m = readJsonSafe(l.manifestFile, {});
    return {
      skills: m?.skills && typeof m.skills === 'object' ? m.skills : {},
      rules: m?.rules && typeof m.rules === 'object' ? m.rules : {},
      autoLoad: m?.autoLoad !== false,
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

  const countLocalSkillsInDirs = (dirs, vaultSkillsDir) => {
    const seen = new Set();
    for (const dir of (Array.isArray(dirs) ? dirs : [dirs])) {
      if (!dir || !fs.existsSync(dir)) continue;
      try {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          if (BUNDLED_SYSTEM_SKILLS.has(e.name) || e.name.startsWith('.')) continue;
          if (!e.isDirectory() && !e.isSymbolicLink()) continue;
          const full = path.join(dir, e.name);
          if (vaultSkillsDir && isSymlinkOrJunction(full) && pointsInside(full, path.join(vaultSkillsDir, e.name))) continue;
          seen.add(e.name);
        }
      } catch {}
    }
    return seen.size;
  };

  const readRawCliMcps = (cliKey, p) => {
    const cfg = p[cliKey];
    if (!cfg) return {};
    if (cliKey === 'codex') {
      return fs.existsSync(cfg.mcpFile) ? parseCodexMcpToml(fs.readFileSync(cfg.mcpFile, 'utf8')) : {};
    }
    if (cliKey === 'claude') {
      return readJsonSafe(cfg.mcpFile, {})?.mcpServers || {};
    }
    const merged = {};
    for (const mf of [cfg.mcpFile, ...(cfg.extraMcpFiles || [])]) {
      const s = readJsonSafe(mf, {})?.mcpServers || {};
      for (const [k, v] of Object.entries(s)) {
        if (!merged[k]) merged[k] = v;
      }
    }
    return merged;
  };

  const maskMcpForView = (name, cfg, extra = {}) => {
    const env = {};
    for (const [k, v] of Object.entries(cfg.env || {})) env[k] = SECRET_KEY_RE.test(k) ? maskSecret(v) : String(v);
    const headers = {};
    for (const [k, v] of Object.entries(cfg.headers || {})) headers[k] = SECRET_KEY_RE.test(k) ? maskSecret(v) : String(v);
    const url = cfg.url || cfg.httpUrl || cfg.serverUrl || '';
    return {
      name,
      transport: url ? 'http' : 'stdio',
      command: cfg.command || '',
      args: Array.isArray(cfg.args) ? cfg.args : [],
      url,
      hasBearerToken: !!cfg.bearer_token,
      env,
      headers,
      ...extra,
    };
  };

  const getCliStatus = () => {
    const l = layout();
    const p = cliPaths();
    const vaultMcps = readMcps();
    const countLocalMcps = (rawMap) => Object.keys(rawMap).filter((n) => !vaultMcps[n]).length;
    const claudeMcp = readRawCliMcps('claude', p);
    const codexMcp = readRawCliMcps('codex', p);
    const agyMcp = readRawCliMcps('agy', p);
    return {
      claude: { label: p.claude.label, skillsCount: countLocalSkillsInDirs(p.claude.skillDirs, l.skillsDir), mcpCount: countLocalMcps(claudeMcp), hasHarness: fs.existsSync(p.claude.harnessFile), skillDir: p.claude.skillDirs[0], mcpFile: p.claude.mcpFile, harnessFile: p.claude.harnessFile },
      codex: { label: p.codex.label, skillsCount: countLocalSkillsInDirs(p.codex.skillDirs, l.skillsDir), mcpCount: countLocalMcps(codexMcp), hasHarness: fs.existsSync(p.codex.harnessFile), skillDir: p.codex.skillDirs[0], mcpFile: p.codex.mcpFile, harnessFile: p.codex.harnessFile },
      agy: { label: p.agy.label, skillsCount: countLocalSkillsInDirs(p.agy.skillDirs, l.skillsDir), mcpCount: countLocalMcps(agyMcp), hasHarness: fs.existsSync(p.agy.harnessFile) || fs.existsSync(path.join(p.agy.rulesDir, 'hub-vault-harness.md')), skillDir: p.agy.skillDirs[0], mcpFile: p.agy.mcpFile, harnessFile: p.agy.harnessFile },
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
      const meta = parseSkillFrontmatter(hasMd ? fs.readFileSync(mdPath, 'utf8') : '');
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
      const content = fs.readFileSync(path.join(l.rulesDir, ent.name), 'utf8');
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
    return Object.entries(readMcps()).map(([name, cfg]) => maskMcpForView(name, cfg, {
      enabled: cfg.enabled !== false,
      targets: Array.isArray(cfg.targets) ? cfg.targets.filter((x) => ALL_CLIS.includes(x)) : [...ALL_CLIS],
      source: cfg.source || 'vault',
      cliOnly: !!cfg.cliOnly,
    })).sort((a, b) => a.name.localeCompare(b.name));
  };

  const getState = () => {
    const l = ensureVaultDirs();
    const manifest = readManifest();
    return {
      vaultDir: l.root,
      autoLoad: manifest.autoLoad !== false,
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

  const saveSkill = ({ name, content, enabled = true, targets = ALL_CLIS }) => {
    const clean = safeName(name);
    if (!clean) throw new Error('스킬 이름을 입력하세요.');
    const dir = path.join(ensureVaultDirs().skillsDir, clean);
    fs.mkdirSync(dir, { recursive: true });
    if (content !== undefined) fs.writeFileSync(path.join(dir, 'SKILL.md'), String(content), 'utf8');
    else if (!fs.existsSync(path.join(dir, 'SKILL.md'))) {
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
    const skDir = path.join(ensureVaultDirs().skillsDir, clean);
    const p = cliPaths();
    for (const cli of ALL_CLIS) {
      for (const sdir of p[cli].skillDirs) {
        const dst = path.join(sdir, clean);
        if (isSymlinkOrJunction(dst) && pointsInside(dst, skDir)) fs.rmSync(dst, { recursive: true, force: true });
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
        out[key] = (val.includes('••••') && prevMap && key in prevMap) ? prevMap[key] : val;
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
    fs.writeFileSync(ensureVaultDirs().sharedHarnessFile, String(shared ?? ''), 'utf8');
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
    const fp = path.join(ensureVaultDirs().rulesDir, clean);
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
    const mdPath = path.join(ensureVaultDirs().skillsDir, clean, 'SKILL.md');
    return fs.existsSync(mdPath) ? fs.readFileSync(mdPath, 'utf8') : '';
  };

  const setAutoLoad = (enabled) => {
    const manifest = readManifest();
    manifest.autoLoad = enabled !== false;
    writeManifest(manifest);
    return getState();
  };

  const ops = createVaultCliOps({
    repoRoot, homeDir, cliPaths, ensureVaultDirs,
    readManifest, writeManifest, readMcps, writeMcps,
    readRawCliMcps, maskMcpForView, listSkills, listRules, getState,
  });

  return {
    getState,
    inspectCli: ops.inspectCli,
    importFromCli: ops.importFromCli,
    gatherFromClis: ops.gatherFromClis,
    syncToClis: ops.syncToClis,
    prepareLaunch: ops.prepareLaunch,
    setAutoLoad,
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
  moveDirSafe,
  parseCodexMcpToml,
  serializeCodexMcpBlock,
  stripManagedTomlSections,
  upsertManagedMarkdownBlock,
  parseSkillFrontmatter,
};
