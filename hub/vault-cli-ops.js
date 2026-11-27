'use strict';

const fs = require('fs');
const path = require('path');
const { checkMcp } = require('./vault-mcp-check');
const {
  ALL_CLIS,
  BUNDLED_SYSTEM_SKILLS,
  CODEX_INTERNAL_MCPS,
  safeName,
  readJsonSafe,
  writeJsonAtomic,
  backupFile,
  copyDirRecursive,
  isSymlinkOrJunction,
  pointsInside,
  linkOrCopySkillDir,
  parseSkillFrontmatter,
  parseCodexMcpToml,
  serializeCodexMcpBlock,
  stripManagedTomlSections,
  upsertManagedMarkdownBlock,
  normalizeImportedMcp,
} = require('./vault-formats');

const supportsMcp = (cli, cfg) => (!cfg.cliOnly || cfg.source === cli)
  && (Array.isArray(cfg.targets) ? cfg.targets : ALL_CLIS).includes(cli);
const mcpConnectionConfig = (cfg) => JSON.stringify([cfg.command, cfg.args, cfg.env, cfg.url, cfg.headers, cfg.bearer_token]);

function activeMcpsFor(cli, mcps, activate) {
  return Object.fromEntries(Object.entries(mcps)
    .filter(([name, cfg]) => supportsMcp(cli, cfg) && (cfg.enabled !== false || activate?.has(name)))
    .map(([name, cfg]) => [name, cfg.enabled === false ? { ...cfg, enabled: true } : cfg]));
}

function httpHeaders(cfg) {
  const headers = { ...cfg.headers };
  if (cfg.bearer_token && !Object.keys(headers).some((key) => key.toLowerCase() === 'authorization')) {
    headers.Authorization = `Bearer ${cfg.bearer_token}`;
  }
  return headers;
}

function requiredMcpMessage(issues) {
  const reasons = {
    'mcp-missing': 'Vault에 등록되지 않음',
    'mcp-invalid': '실행 명령 또는 URL 누락',
    'mcp-unsupported': 'CLI 또는 스킬의 적용 대상에서 제외됨',
    'mcp-disabled': '비활성 상태이며 자동 활성화가 허용되지 않음',
    'mcp-activation-failed': 'CLI 설정에 연결하지 못함',
    'mcp-unreachable': 'MCP 초기 연결에 실패함',
    'mcp-config-changed': '확인 중 MCP 설정이 변경됨',
  };
  return issues.map(({ id, reason }) => `${id.slice(4)} (${reasons[reason]})`).join(', ');
}

function formatMcpServerForJson(cli, cfg) {
  if (!cfg.url) {
    return { command: cfg.command, args: cfg.args || [], ...(cfg.env ? { env: cfg.env } : {}) };
  }
  const headers = httpHeaders(cfg);
  return { ...(cli === 'agy' ? {} : { type: 'http' }), url: cfg.url, ...(Object.keys(headers).length ? { headers } : {}) };
}

function syncJsonMcpTarget(cli, cliCfg, mcps, activeMcps, report, summary) {
  const cur = readJsonSafe(cliCfg.mcpFile, {}) || {};
  const prevStr = JSON.stringify(cur.mcpServers || {});
  const nextServers = { ...(cur.mcpServers || {}) };
  for (const [name, cfg] of Object.entries(mcps)) {
    if (!activeMcps[name]) {
      if (!cfg.cliOnly || cfg.enabled === false || cfg.source !== cli) delete nextServers[name];
      continue;
    }
    nextServers[name] = formatMcpServerForJson(cli, cfg);
    summary.mcpsWritten++;
  }
  if (JSON.stringify(nextServers) !== prevStr) {
    const bak = backupFile(cliCfg.mcpFile, 'hub-vault');
    if (bak) report.backedUp.push(bak);
    cur.mcpServers = nextServers;
    writeJsonAtomic(cliCfg.mcpFile, cur);
  }
}

/** Create gather, sync, inspect, import, and launch-preparation operations for Unified Vault. */
function createVaultCliOps(ctx) {
  const {
    repoRoot, homeDir, cliPaths, ensureVaultDirs,
    readManifest, writeManifest, readMcps, writeMcps,
    readRawCliMcps, maskMcpForView, listSkills, listRules, getState,
  } = ctx;

  const gatherFromClis = () => {
    const l = ensureVaultDirs();
    const p = cliPaths();
    const manifest = readManifest();
    const mcps = readMcps();
    let addedSkills = 0;
    let addedMcps = 0;
    let addedRules = 0;

    const skillSources = [
      ...p.claude.skillDirs.map((d) => ['claude', d]),
      ...p.codex.skillDirs.map((d) => ['codex', d]),
      ...p.agy.skillDirs.map((d) => ['agy', d]),
      ['shared', path.join(homeDir, '.agents', 'skills')],
      ['hub', path.join(repoRoot, 'skills')],
    ];
    const removedSkills = new Set(manifest.removedSkills.map(name => name.toLowerCase()));
    for (const [srcLabel, dir] of skillSources) {
      if (!fs.existsSync(dir)) continue;
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (BUNDLED_SYSTEM_SKILLS.has(ent.name) || ent.name.startsWith('.') || removedSkills.has(ent.name.toLowerCase())) continue;
        if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
        let realFrom;
        try { realFrom = fs.realpathSync(path.join(dir, ent.name)); } catch { continue; }
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

    const mergeMcp = (name, cfg, srcCli) => {
      if (!name || mcps[name]) return;
      mcps[name] = normalizeImportedMcp(name, cfg, srcCli);
      addedMcps++;
    };

    if (fs.existsSync(p.codex.mcpFile)) {
      for (const [name, cfg] of Object.entries(parseCodexMcpToml(fs.readFileSync(p.codex.mcpFile, 'utf8')))) mergeMcp(name, cfg, 'codex');
    }
    for (const [name, cfg] of Object.entries(readJsonSafe(p.claude.mcpFile, {})?.mcpServers || {})) mergeMcp(name, cfg, 'claude');
    for (const mf of [p.agy.mcpFile, ...p.agy.extraMcpFiles]) {
      for (const [name, cfg] of Object.entries(readJsonSafe(mf, {})?.mcpServers || {})) mergeMcp(name, cfg, 'agy');
    }

    for (const [srcCli, rdir] of [['codex', p.codex.rulesDir], ['agy', p.agy.rulesDir]]) {
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

  const syncToClis = ({ clis = ALL_CLIS } = {}, launch = {}) => {
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
      const cliCfg = { ...p[cli], ...launch.paths };
      const summary = { skillsLinked: 0, skillsRemoved: 0, mcpsWritten: 0, harnessUpdated: false };

      for (const sk of skills) {
        const active = launch.skills ? launch.skills.includes(sk.name) : sk.enabled && sk.targets.includes(cli);
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
        if (active) launch.applied?.push(`skill:${sk.name}`);
      }

      const activeMcps = activeMcpsFor(cli, mcps, launch.activate);

      if (cli === 'claude' || cli === 'agy') {
        syncJsonMcpTarget(cli, cliCfg, mcps, activeMcps, report, summary);
      } else if (cli === 'codex') {
        const curText = fs.existsSync(cliCfg.mcpFile) ? fs.readFileSync(cliCfg.mcpFile, 'utf8') : '';
        const managedNames = new Set(
          Object.entries(mcps)
            .filter(([name, cfg]) => Object.hasOwn(activeMcps, name) || !cfg.cliOnly || cfg.enabled === false || !(Array.isArray(cfg.targets) ? cfg.targets : ALL_CLIS).includes('codex'))
            .map(([n]) => n)
        );
        const codexMcps = Object.fromEntries(Object.entries(activeMcps).map(([name, cfg]) =>
          [name, cfg.bearer_token && cfg.url ? { ...cfg, bearer_token: undefined, headers: httpHeaders(cfg) } : cfg]));
        const nextText = [stripManagedTomlSections(curText, managedNames), serializeCodexMcpBlock(codexMcps)].filter(Boolean).join('\n\n') + '\n';
        if (nextText !== curText) {
          const bak = backupFile(cliCfg.mcpFile, 'hub-vault');
          if (bak) report.backedUp.push(bak);
          fs.mkdirSync(path.dirname(cliCfg.mcpFile), { recursive: true });
          fs.writeFileSync(cliCfg.mcpFile, nextText, 'utf8');
        }
        summary.mcpsWritten = Object.keys(activeMcps).length;
      }

      const enabledRules = rules.filter((r) => launch.rules ? launch.rules.includes(r.name) : r.enabled && r.targets.includes(cli));
      const combined = [sharedText, ...enabledRules.map((r) => `\n## [규칙: ${r.name}]\n${r.content.trim()}`)].filter(Boolean).join('\n').trim();
      if (cliCfg.harnessFile) summary.harnessUpdated = upsertManagedMarkdownBlock(cliCfg.harnessFile, combined);
      if (cli === 'agy' && cliCfg.rulesDir) {
        fs.mkdirSync(cliCfg.rulesDir, { recursive: true });
        const agyHarnessRule = path.join(cliCfg.rulesDir, 'hub-vault-harness.md');
        const nextRule = combined + '\n';
        const curRule = fs.existsSync(agyHarnessRule) ? fs.readFileSync(agyHarnessRule, 'utf8') : '';
        if (curRule !== nextRule) fs.writeFileSync(agyHarnessRule, nextRule, 'utf8');
      }
      if (cliCfg.harnessFile) {
        if (sharedText) launch.applied?.push('shared');
        launch.applied?.push(...enabledRules.map((r) => `rule:${r.name}`));
      }
      if (launch.required?.length) {
        const written = readRawCliMcps(cli, { [cli]: { ...cliCfg, extraMcpFiles: [] } });
        for (const name of launch.required) {
          if (!Object.hasOwn(written, name) || written[name].enabled === false) {
            throw new Error('Required MCP missing from the CLI configuration');
          }
        }
      }
      report.clis[cli] = summary;
    }

    manifest.lastSyncAt = Date.now();
    manifest.lastSyncSummary = report.clis;
    writeManifest(manifest);
    return { ok: true, report, ...(launch.applied ? {} : { state: getState() }) };
  };

  const inspectCli = (cliKey) => {
    if (!ALL_CLIS.includes(cliKey)) throw new Error('알 수 없는 CLI입니다.');
    const l = ensureVaultDirs();
    const p = cliPaths();
    const cfg = p[cliKey];
    const vaultMcps = readMcps();
    const manifest = readManifest();

    const skillMap = new Map();
    for (const sdir of cfg.skillDirs) {
      if (!sdir || !fs.existsSync(sdir)) continue;
      for (const ent of fs.readdirSync(sdir, { withFileTypes: true })) {
        if (BUNDLED_SYSTEM_SKILLS.has(ent.name) || ent.name.startsWith('.')) continue;
        if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
        if (skillMap.has(ent.name)) continue;
        const skillPath = path.join(sdir, ent.name);
        let realDir = skillPath;
        try { realDir = fs.realpathSync(skillPath); } catch {}
        const mdPath = path.join(realDir, 'SKILL.md');
        const hasSkillMd = fs.existsSync(mdPath);
        const mdContent = hasSkillMd ? fs.readFileSync(mdPath, 'utf8') : '';
        const meta = parseSkillFrontmatter(mdContent);
        const vaultDst = path.join(l.skillsDir, ent.name);
        const isLinked = isSymlinkOrJunction(skillPath) && pointsInside(skillPath, vaultDst);
        const mInfo = manifest.skills[ent.name];
        skillMap.set(ent.name, {
          name: ent.name,
          displayName: meta.name || ent.name,
          description: meta.description || '',
          hasSkillMd,
          preview: mdContent.slice(0, 2400),
          dir: skillPath,
          parentDir: sdir,
          inVault: fs.existsSync(vaultDst),
          isLinkedToVault: isLinked,
          isForeignShared: !!(isLinked && (!mInfo?.sources || !mInfo.sources.includes(cliKey))),
        });
      }
    }

    const mcps = Object.entries(readRawCliMcps(cliKey, p)).map(([name, mcfg]) => maskMcpForView(name, mcfg, {
      cliOnly: CODEX_INTERNAL_MCPS.has(name),
      inVault: !!vaultMcps[name],
      isForeignShared: !!(vaultMcps[name] && vaultMcps[name].source !== cliKey),
      inVaultTargets: vaultMcps[name]?.targets || [],
    })).sort((a, b) => a.name.localeCompare(b.name));

    const harnessRaw = cfg.harnessFile && fs.existsSync(cfg.harnessFile) ? fs.readFileSync(cfg.harnessFile, 'utf8') : '';
    const hasVaultBlock = /<!-- hub-vault:begin -->[\s\S]*?<!-- hub-vault:end -->/.test(harnessRaw);
    const customHarness = harnessRaw.replace(/<!-- hub-vault:begin -->[\s\S]*?<!-- hub-vault:end -->\r?\n?/g, '').trim();
    const sharedText = fs.readFileSync(l.sharedHarnessFile, 'utf8');

    const rules = [];
    if (cfg.rulesDir && fs.existsSync(cfg.rulesDir)) {
      for (const ent of fs.readdirSync(cfg.rulesDir, { withFileTypes: true })) {
        if (!ent.isFile() || ent.name === 'hub-vault-harness.md' || !/\.(md|rules|txt)$/i.test(ent.name)) continue;
        const fp = path.join(cfg.rulesDir, ent.name);
        const content = fs.readFileSync(fp, 'utf8');
        const vaultName = `${cliKey}-${ent.name}`;
        rules.push({
          name: ent.name,
          vaultName,
          path: fp,
          size: Buffer.byteLength(content, 'utf8'),
          preview: content.slice(0, 1200),
          inVault: fs.existsSync(path.join(l.rulesDir, vaultName)) || !!manifest.rules[vaultName],
        });
      }
    }

    return {
      cli: cliKey,
      label: cfg.label,
      skillDirs: cfg.skillDirs,
      mcpFile: cfg.mcpFile,
      harnessFile: cfg.harnessFile,
      skills: [...skillMap.values()].sort((a, b) => a.name.localeCompare(b.name)),
      mcps,
      harness: {
        exists: !!(cfg.harnessFile && fs.existsSync(cfg.harnessFile)),
        path: cfg.harnessFile,
        hasVaultBlock,
        customContent: customHarness.slice(0, 4000),
        hasCustomContent: !!customHarness,
        customImported: !customHarness || sharedText.includes(customHarness.slice(0, 120)),
      },
      rules: rules.sort((a, b) => a.name.localeCompare(b.name)),
    };
  };

  const importFromCli = ({ cli, skills = [], mcps = [], rules = [], importHarness = false, moveSkills = true, targets = null, enabled = true }) => {
    if (!ALL_CLIS.includes(cli)) throw new Error('알 수 없는 CLI입니다.');
    const l = ensureVaultDirs();
    const p = cliPaths();
    const cfg = p[cli];
    const manifest = readManifest();
    const vaultMcps = readMcps();
    const customTargets = Array.isArray(targets) ? targets.filter((x) => ALL_CLIS.includes(x)) : null;
    const isEnabled = enabled !== false;
    let importedSkills = 0, movedSkills = 0, importedMcps = 0, importedRules = 0, importedHarness = false;

    for (const rawSkillName of (skills || [])) {
      const name = safeName(rawSkillName);
      if (!name) continue;
      const foundDir = cfg.skillDirs.map((sdir) => path.join(sdir, name)).find((cand) => fs.existsSync(cand)) || '';
      if (!foundDir) continue;
      let realFrom;
      try { realFrom = fs.realpathSync(foundDir); } catch { continue; }
      const dstDir = path.join(l.skillsDir, name);
      if (realFrom !== path.resolve(dstDir) && !fs.existsSync(dstDir)) {
        copyDirRecursive(realFrom, dstDir);
        importedSkills++;
      }
      const prev = manifest.skills[name] || { enabled: isEnabled, targets: customTargets ? [...customTargets] : [...ALL_CLIS], sources: [] };
      prev.enabled = isEnabled;
      if (customTargets) prev.targets = [...customTargets];
      else {
        if (!Array.isArray(prev.targets)) prev.targets = [...ALL_CLIS];
        if (!prev.targets.includes(cli)) prev.targets.push(cli);
      }
      if (!Array.isArray(prev.sources)) prev.sources = [];
      if (!prev.sources.includes(cli)) prev.sources.push(cli);
      manifest.skills[name] = prev;
      manifest.removedSkills = manifest.removedSkills.filter(removed => removed.toLowerCase() !== name.toLowerCase());
      if (moveSkills && isEnabled && fs.existsSync(dstDir) && prev.targets.includes(cli)) {
        if (linkOrCopySkillDir(dstDir, foundDir, path.join(l.backupDir, cli)) === 'linked') movedSkills++;
      }
    }

    const rawCliMcps = readRawCliMcps(cli, p);
    for (const rawMcpName of (mcps || [])) {
      const name = String(rawMcpName || '').trim();
      const rawCfg = rawCliMcps[name];
      if (!name || !rawCfg) continue;
      const isCodexInternal = CODEX_INTERNAL_MCPS.has(name);
      if (!vaultMcps[name]) {
        vaultMcps[name] = normalizeImportedMcp(name, rawCfg, cli, customTargets, isEnabled);
        importedMcps++;
      } else {
        if (customTargets && !isCodexInternal) vaultMcps[name].targets = [...customTargets];
        else {
          const curTargets = Array.isArray(vaultMcps[name].targets) ? vaultMcps[name].targets : [...ALL_CLIS];
          if (!curTargets.includes(cli)) curTargets.push(cli);
          vaultMcps[name].targets = curTargets;
        }
        vaultMcps[name].enabled = isEnabled;
      }
    }

    if (cfg.rulesDir && fs.existsSync(cfg.rulesDir)) {
      for (const rawRule of (rules || [])) {
        const cleanRule = safeName(rawRule);
        if (!cleanRule) continue;
        const srcFp = path.join(cfg.rulesDir, cleanRule);
        if (!fs.existsSync(srcFp)) continue;
        const dstName = `${cli}-${cleanRule}`;
        const dstFp = path.join(l.rulesDir, dstName);
        if (!fs.existsSync(dstFp)) {
          fs.copyFileSync(srcFp, dstFp);
          importedRules++;
        }
        manifest.rules[dstName] = {
          ...(manifest.rules[dstName] || {}),
          enabled: isEnabled,
          targets: customTargets ? [...customTargets] : (Array.isArray(manifest.rules[dstName]?.targets) ? manifest.rules[dstName].targets : [...ALL_CLIS]),
          source: cli,
        };
      }
    }

    if (importHarness && cfg.harnessFile && fs.existsSync(cfg.harnessFile)) {
      const customMd = fs.readFileSync(cfg.harnessFile, 'utf8').replace(/<!-- hub-vault:begin -->[\s\S]*?<!-- hub-vault:end -->\r?\n?/g, '').trim();
      if (customMd) {
        const curShared = fs.readFileSync(l.sharedHarnessFile, 'utf8');
        if (!curShared.includes(customMd)) {
          fs.writeFileSync(l.sharedHarnessFile, `${curShared.trimEnd()}\n\n<!-- imported-from: ${cli} -->\n${customMd}\n`, 'utf8');
          importedHarness = true;
        }
      }
    }

    writeMcps(vaultMcps);
    writeManifest(manifest);
    return { ok: true, importedSkills, movedSkills, importedMcps, importedRules, importedHarness, cliData: inspectCli(cli), state: getState() };
  };

  const prepareLaunch = (cliKey, { resume = false, env = {}, native = true, requiredSkills = [], fallbackAgent, cwd, verified } = {}) => {
    const vault = { applied: [], omitted: [] };
    const result = { extraArgs: [], env: {}, synced: false, vault };
    const selection = { applied: vault.applied, skills: [], rules: [] };
    const pending = [];
    try {
      const manifest = readManifest();
      const commonReason = !native || !ALL_CLIS.includes(cliKey) ? 'unsupported-cli'
        : manifest.autoLoad === false ? 'autoload-disabled' : '';
      const select = (kind, resources, available) => {
        const found = new Map(resources.map((r) => [r.name, r]));
        return [...new Set([...found.keys(), ...Object.keys(manifest[`${kind}s`])])].filter((name) => {
          const id = `${kind}:${name}`;
          const resource = found.get(name);
          const reason = commonReason || (!resource ? 'missing' : !resource.enabled ? 'disabled'
            : !resource.targets.includes(cliKey) ? 'unsupported-target' : available(resource));
          if (reason) vault.omitted.push({ id, reason });
          else pending.push(id);
          return !reason;
        });
      };
      const l = ensureVaultDirs();
      const skills = listSkills();
      const rules = listRules();
      const sharedText = fs.readFileSync(l.sharedHarnessFile, 'utf8').trim();
      if (commonReason || !sharedText) vault.omitted.push({ id: 'shared', reason: commonReason || 'empty' });
      else pending.push('shared');
      selection.skills = select('skill', skills, (sk) => sk.hasSkillMd ? '' : 'missing');
      selection.rules = select('rule', rules, (rule) => rule.content.trim() ? '' : 'empty');
      const target = ALL_CLIS.includes(cliKey) ? cliKey : fallbackAgent;
      const required = skills.filter((sk) => sk.requiredMcps.length && (requiredSkills.includes(sk.name)
        || selection.skills.includes(sk.name) || (commonReason === 'unsupported-cli' && manifest.autoLoad && sk.enabled && sk.hasSkillMd && sk.targets.includes(target))));
      result.requiredSkills = required.map((sk) => sk.name);
      selection.required = [...new Set(required.flatMap((sk) => sk.requiredMcps))];
      const mcps = selection.required.length ? readMcps() : {};
      selection.activate = new Set();
      const issues = [];
      for (const name of selection.required) {
        const cfg = Object.hasOwn(mcps, name) && mcps[name];
        const reason = !cfg ? 'mcp-missing' : !cfg.command && !cfg.url ? 'mcp-invalid'
          : !native || !ALL_CLIS.includes(cliKey) || !supportsMcp(cliKey, cfg)
            || required.some((sk) => sk.requiredMcps.includes(name) && !selection.skills.includes(sk.name)) ? 'mcp-unsupported'
          : verified && mcpConnectionConfig(cfg) !== verified.get(name) ? 'mcp-config-changed'
          : cfg.enabled === false && cfg.autoEnable !== true ? 'mcp-disabled' : '';
        if (reason) issues.push({ id: `mcp:${name}`, reason });
        else if (cfg.enabled === false) selection.activate.add(name);
      }
      if (issues.length) {
        vault.omitted.push(...issues);
        result.blocked = issues;
        return result;
      }
      if (commonReason) return result;

      if (cwd && !verified && selection.required.length) {
        const checks = selection.required.map(async (name) => ({
          name, config: mcpConnectionConfig(mcps[name]), ok: await checkMcp(mcps[name], { cwd, env }),
        }));
        return Promise.all(checks).then((checked) => {
          const failed = checked.filter(({ ok }) => !ok).map(({ name }) => ({ id: `mcp:${name}`, reason: 'mcp-unreachable' }));
          if (failed.length) {
            vault.omitted.push(...failed);
            return { ...result, blocked: failed };
          }
          return prepareLaunch(cliKey, { resume, env, native, requiredSkills, fallbackAgent, verified: new Map(checked.map(({ name, config }) => [name, config])) });
        });
      }

      if (cliKey === 'codex' && env.CODEX_HOME) {
        const root = path.resolve(env.CODEX_HOME);
        selection.paths = { skillDirs: [path.join(root, 'skills')], harnessFile: path.join(root, 'AGENTS.md'), mcpFile: path.join(root, 'config.toml') };
      } else if (cliKey === 'claude' && env.CLAUDE_CONFIG_DIR) {
        const root = path.resolve(env.CLAUDE_CONFIG_DIR);
        selection.paths = { skillDirs: [path.join(root, 'skills')], harnessFile: path.join(root, 'CLAUDE.md') };
      }
      syncToClis({ clis: [cliKey] }, selection);
      const prepared = cliKey === 'claude' ? prepareClaude(l, { resume, skills, rules, sharedText, selection }) : { synced: true };
      if (selection.activate.size) {
        for (const name of selection.activate) mcps[name].enabled = true;
        writeMcps(mcps);
      }
      vault.applied.push(...selection.required.map((name) => `mcp:${name}`));
      return { ...result, ...prepared };
    } catch (error) {
      console.error('[vault-launch]', cliKey, error.code || error.name, (error.stack || '').split('\n')[1]?.trim());
      for (const id of pending) {
        if (!vault.applied.includes(id)) vault.omitted.push({ id, reason: 'sync-failed' });
      }
      vault.error = 'sync-failed';
      if (selection.required?.length) {
        result.blocked = selection.required.map((name) => ({ id: `mcp:${name}`, reason: 'mcp-activation-failed' }));
        vault.omitted.push(...result.blocked);
      }
      return result;
    }
  };

  const prepareClaude = (l, { resume, skills, rules, sharedText, selection }) => {
    const runtimeDir = path.join(l.root, '.runtime', 'claude');
    const rtSkillsDir = path.join(runtimeDir, '.claude', 'skills');
    fs.mkdirSync(rtSkillsDir, { recursive: true });

    const activeSkillNames = new Set(selection.skills);
    for (const sk of skills) {
      if (activeSkillNames.has(sk.name)) {
        linkOrCopySkillDir(sk.path, path.join(rtSkillsDir, sk.name), path.join(l.backupDir, 'rt-claude'));
      }
    }
    for (const ent of fs.readdirSync(rtSkillsDir, { withFileTypes: true })) {
      if (!activeSkillNames.has(ent.name)) fs.rmSync(path.join(rtSkillsDir, ent.name), { recursive: true, force: true });
    }

    const activeMcps = Object.fromEntries(Object.entries(activeMcpsFor('claude', readMcps(), selection.activate))
      .map(([name, cfg]) => [name, formatMcpServerForJson('claude', cfg)]));
    const mcpFile = path.join(runtimeDir, 'mcp-config.json');
    const hasMcps = Object.keys(activeMcps).length > 0;
    if (hasMcps) writeJsonAtomic(mcpFile, { mcpServers: activeMcps });
    else if (fs.existsSync(mcpFile)) fs.rmSync(mcpFile, { force: true });

    const enabledRules = rules.filter((r) => selection.rules.includes(r.name));
    const combined = [sharedText, ...enabledRules.map((r) => `\n## [규칙: ${r.name}]\n${r.content.trim()}`)].filter(Boolean).join('\n').trim();
    const harnessFile = path.join(runtimeDir, 'CLAUDE.md');
    const nextHarness = combined ? `${combined}\n` : '';
    if (!fs.existsSync(harnessFile) || fs.readFileSync(harnessFile, 'utf8') !== nextHarness) {
      fs.writeFileSync(harnessFile, nextHarness, 'utf8');
    }

    const extraArgs = [];
    if (activeSkillNames.size > 0 || combined) extraArgs.push('--add-dir', runtimeDir);
    if (hasMcps) extraArgs.push('--mcp-config', mcpFile);
    if (!resume && combined) extraArgs.push('--append-system-prompt-file', harnessFile);
    return { extraArgs, env: (activeSkillNames.size > 0 || combined) ? { CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1' } : {}, synced: true };
  };

  return { gatherFromClis, syncToClis, inspectCli, importFromCli, prepareLaunch };
}

module.exports = { createVaultCliOps, requiredMcpMessage };
