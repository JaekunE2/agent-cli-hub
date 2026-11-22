'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createUnifiedVault,
  parseCodexMcpToml,
  serializeCodexMcpBlock,
  stripManagedTomlSections,
  upsertManagedMarkdownBlock,
  parseSkillFrontmatter,
} = require('../unified-vault');

function makeTempEnv() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-vault-test-'));
  const homeDir = path.join(base, 'home');
  const repoRoot = path.join(base, 'repo');
  const vaultDir = path.join(repoRoot, 'vault');
  const configPath = path.join(base, 'config.json');
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(repoRoot, { recursive: true });
  fs.writeFileSync(configPath, '{}', 'utf8');
  return { base, homeDir, repoRoot, vaultDir, configPath };
}

test('TOML MCP parser and serializer round-trip stdio and http servers', () => {
  const sample = `
model = "gpt-5"

[mcp_servers.context7]
command = "npx"
args = ["-y", "@upstash/context7-mcp"]
env = { CONTEXT7_API_KEY = "sec-123" }

[mcp_servers."써로웍스"]
url = "https://mcp.example.com/mcp"
bearer_token = "tok-xyz"
http_headers = { "X-Custom" = "yes" }
`;
  const parsed = parseCodexMcpToml(sample);
  assert.equal(parsed.context7.command, 'npx');
  assert.deepEqual(parsed.context7.args, ['-y', '@upstash/context7-mcp']);
  assert.equal(parsed.context7.env.CONTEXT7_API_KEY, 'sec-123');
  assert.equal(parsed['써로웍스'].url, 'https://mcp.example.com/mcp');
  assert.equal(parsed['써로웍스'].bearer_token, 'tok-xyz');
  assert.equal(parsed['써로웍스'].headers['X-Custom'], 'yes');

  const block = serializeCodexMcpBlock({
    context7: parsed.context7,
    '써로웍스': parsed['써로웍스'],
  });
  const stripped = stripManagedTomlSections(
    `model = "gpt-5"\n\n# BEGIN HUB-VAULT MCP\n[mcp_servers.old]\ncommand = "echo"\n# END HUB-VAULT MCP\n`,
    ['context7']
  );
  assert.ok(stripped.includes('model = "gpt-5"'));
  assert.ok(!stripped.includes('[mcp_servers.old]'));
  const reparsed = parseCodexMcpToml(block);
  assert.equal(reparsed.context7.command, 'npx');
  assert.equal(reparsed['써로웍스'].url, 'https://mcp.example.com/mcp');
});

test('upsertManagedMarkdownBlock preserves surrounding manual rules', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-vault-md-'));
  try {
    const mdFile = path.join(dir, 'CLAUDE.md');
    fs.writeFileSync(mdFile, '# User Personal Rules\nAlways keep git clean.\n', 'utf8');
    upsertManagedMarkdownBlock(mdFile, '## Shared Rule A\nUse Korean.');
    const first = fs.readFileSync(mdFile, 'utf8');
    assert.ok(first.startsWith('# User Personal Rules'));
    assert.ok(first.includes('<!-- hub-vault:begin -->'));
    assert.ok(first.includes('## Shared Rule A'));
    upsertManagedMarkdownBlock(mdFile, '## Shared Rule B\nUse tests.');
    const second = fs.readFileSync(mdFile, 'utf8');
    assert.equal(second.match(/<!-- hub-vault:begin -->/g).length, 1);
    assert.ok(!second.includes('Shared Rule A'));
    assert.ok(second.includes('Shared Rule B'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parseSkillFrontmatter extracts name and description cleanly', () => {
  const meta = parseSkillFrontmatter(`---\nname: "demo-skill"\ndescription: 'Helps test frontmatter'\n---\n\n# Body`);
  assert.equal(meta.name, 'demo-skill');
  assert.equal(meta.description, 'Helps test frontmatter');
});

test('createUnifiedVault gathers from all CLIs and syncs idempotently across targets', () => {
  const env = makeTempEnv();
  try {
    // 1. Seed Claude skill, MCP, harness
    const clSkill = path.join(env.homeDir, '.claude', 'skills', 'claude-helper');
    fs.mkdirSync(clSkill, { recursive: true });
    fs.writeFileSync(path.join(clSkill, 'SKILL.md'), '---\nname: claude-helper\ndescription: Claude helper skill\n---\nBody', 'utf8');
    fs.writeFileSync(path.join(env.homeDir, '.claude.json'), JSON.stringify({
      mcpServers: {
        github: { command: 'npx', args: ['-y', '@mcp/github'], env: { GITHUB_TOKEN: 'ghp_secret123456' } },
      },
    }), 'utf8');
    fs.writeFileSync(path.join(env.homeDir, '.claude', 'CLAUDE.md'), '# My Claude Prompt\nKeep concise.\n', 'utf8');

    // 2. Seed Codex skill, TOML (including protected node_repl), AGENTS.md
    const cxSkill = path.join(env.homeDir, '.codex', 'skills', 'codex-helper');
    fs.mkdirSync(cxSkill, { recursive: true });
    fs.writeFileSync(path.join(cxSkill, 'SKILL.md'), '---\nname: codex-helper\ndescription: Codex helper\n---\nBody', 'utf8');
    fs.writeFileSync(path.join(env.homeDir, '.codex', 'config.toml'), `
model = "gpt-5.4"

[mcp_servers.node_repl]
command = "node"

[mcp_servers.seq]
command = "npx"
args = ["-y", "seq-mcp"]
`, 'utf8');
    fs.writeFileSync(path.join(env.homeDir, '.codex', 'AGENTS.md'), '# Existing Codex Instructions\n', 'utf8');

    // 3. Seed Antigravity skill, MCP, GEMINI.md
    const agSkill = path.join(env.homeDir, '.gemini', 'antigravity-cli', 'skills', 'agy-helper');
    fs.mkdirSync(agSkill, { recursive: true });
    fs.writeFileSync(path.join(agSkill, 'SKILL.md'), '---\nname: agy-helper\ndescription: AGY helper\n---\nBody', 'utf8');
    fs.mkdirSync(path.join(env.homeDir, '.gemini', 'config'), { recursive: true });
    fs.writeFileSync(path.join(env.homeDir, '.gemini', 'config', 'mcp_config.json'), JSON.stringify({
      mcpServers: {
        remote_doc: { httpUrl: 'https://docs.example.com/mcp', headers: { Authorization: 'Bearer supersecret99' } },
      },
    }), 'utf8');
    fs.writeFileSync(path.join(env.homeDir, '.gemini', 'GEMINI.md'), '# Existing AGY GEMINI.md\n', 'utf8');

    const vault = createUnifiedVault({
      homeDir: env.homeDir,
      repoRoot: env.repoRoot,
      vaultDir: env.vaultDir,
      configPath: env.configPath,
    });

    // Gather all CLIs
    const gathered = vault.gatherFromClis();
    assert.equal(gathered.addedSkills, 3);
    assert.ok(gathered.addedMcps >= 3);

    // Secrets must be masked in HTTP state
    const gh = gathered.state.mcps.find((m) => m.name === 'github');
    assert.ok(gh);
    assert.notEqual(gh.env.GITHUB_TOKEN, 'ghp_secret123456');
    assert.ok(gh.env.GITHUB_TOKEN.includes('••••'));

    // Add a unified skill, rule, shared harness
    vault.saveSkill({
      name: 'shared-team-skill',
      content: '---\nname: shared-team-skill\ndescription: Shared across CLIs\n---\n\n# Team Skill\n',
    });
    assert.ok(vault.readSkillContent('shared-team-skill').includes('# Team Skill'));
    vault.saveHarness({ shared: 'Always verify tests before finishing.' });
    vault.saveRule({ name: 'korean-style', content: '# Reply in Korean\nBe concise.' });

    // Sync to all 3 CLIs
    const sync1 = vault.syncToClis({ clis: ['claude', 'codex', 'agy'] });
    assert.ok(sync1.report.clis.claude.skillsLinked >= 4);
    assert.ok(sync1.report.clis.codex.skillsLinked >= 4);
    assert.ok(sync1.report.clis.agy.skillsLinked >= 4);

    // Verify skill accessibility in all 3 CLIs
    assert.ok(fs.existsSync(path.join(env.homeDir, '.claude', 'skills', 'shared-team-skill', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(env.homeDir, '.codex', 'skills', 'shared-team-skill', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(env.homeDir, '.gemini', 'antigravity-cli', 'skills', 'shared-team-skill', 'SKILL.md')));

    // Verify Claude & AGY MCP JSON contain shared servers + raw unmasked secrets kept on disk
    const clJson = JSON.parse(fs.readFileSync(path.join(env.homeDir, '.claude.json'), 'utf8'));
    assert.equal(clJson.mcpServers.github.env.GITHUB_TOKEN, 'ghp_secret123456');
    assert.equal(clJson.mcpServers.seq.command, 'npx');
    assert.ok(fs.existsSync(path.join(env.homeDir, '.claude.json.bak-hub-vault') ) || fs.readdirSync(env.homeDir).some((f) => f.startsWith('.claude.json.bak-hub-vault-')));

    const agJson = JSON.parse(fs.readFileSync(path.join(env.homeDir, '.gemini', 'config', 'mcp_config.json'), 'utf8'));
    assert.equal(agJson.mcpServers.github.command, 'npx');
    assert.equal(agJson.mcpServers.remote_doc.url, 'https://docs.example.com/mcp');

    // Verify Codex TOML retains node_repl and wraps managed MCPs cleanly
    const toml = fs.readFileSync(path.join(env.homeDir, '.codex', 'config.toml'), 'utf8');
    assert.ok(toml.includes('[mcp_servers.node_repl]'));
    assert.ok(toml.includes('# BEGIN HUB-VAULT MCP'));
    assert.ok(toml.includes('# END HUB-VAULT MCP'));
    assert.ok(toml.includes('[mcp_servers.github]'));

    // Verify Harnesses keep existing user content and inject shared harness + rule
    const clMd = fs.readFileSync(path.join(env.homeDir, '.claude', 'CLAUDE.md'), 'utf8');
    assert.ok(clMd.includes('# My Claude Prompt'));
    assert.ok(clMd.includes('Always verify tests before finishing.'));
    assert.ok(clMd.includes('Reply in Korean'));

    const cxMd = fs.readFileSync(path.join(env.homeDir, '.codex', 'AGENTS.md'), 'utf8');
    assert.ok(cxMd.includes('# Existing Codex Instructions'));
    assert.ok(cxMd.includes('Always verify tests before finishing.'));

    const agMd = fs.readFileSync(path.join(env.homeDir, '.gemini', 'GEMINI.md'), 'utf8');
    assert.ok(agMd.includes('# Existing AGY GEMINI.md'));
    assert.ok(agMd.includes('Always verify tests before finishing.'));
    assert.ok(fs.existsSync(path.join(env.homeDir, '.gemini', 'config', 'rules', 'hub-vault-harness.md')));

    // Idempotent second sync does not duplicate marker blocks
    vault.syncToClis({ clis: ['claude', 'codex', 'agy'] });
    const clMd2 = fs.readFileSync(path.join(env.homeDir, '.claude', 'CLAUDE.md'), 'utf8');
    assert.equal(clMd2.match(/<!-- hub-vault:begin -->/g).length, 1);

    // Changing vault dir persists in config.json
    const altVault = path.join(env.base, 'custom-vault');
    const moved = vault.setVaultDir(altVault);
    assert.equal(moved.vaultDir, path.resolve(altVault));
    const savedCfg = JSON.parse(fs.readFileSync(env.configPath, 'utf8'));
    assert.equal(savedCfg.vaultDir, path.resolve(altVault));

    // Per-CLI inspectCli + selective importFromCli (including moveSkills Junction conversion)
    const lateSkill = path.join(env.homeDir, '.claude', 'skills', 'late-added-skill');
    fs.mkdirSync(lateSkill, { recursive: true });
    fs.writeFileSync(path.join(lateSkill, 'SKILL.md'), '---\nname: late-added-skill\ndescription: Added later in Claude\n---\n\n# Late\n', 'utf8');
    const inspBefore = vault.inspectCli('claude');
    const foundLate = inspBefore.skills.find((s) => s.name === 'late-added-skill');
    assert.ok(foundLate);
    assert.equal(foundLate.inVault, false);
    assert.equal(foundLate.isLinkedToVault, false);

    const imp = vault.importFromCli({ cli: 'claude', skills: ['late-added-skill'], mcps: ['github'], moveSkills: true, importHarness: true });
    assert.equal(imp.importedSkills, 1);
    assert.equal(imp.importedMcps, 1);
    assert.ok(imp.cliData.skills.find((s) => s.name === 'late-added-skill')?.isLinkedToVault);
    assert.ok(fs.existsSync(path.join(altVault, 'skills', 'late-added-skill', 'SKILL.md')));
    assert.ok(fs.lstatSync(lateSkill).isSymbolicLink());
    assert.ok(fs.readFileSync(path.join(altVault, 'harness', 'shared.md'), 'utf8').includes('# My Claude Prompt'));

    // prepareLaunch generates runtime dirs/MCP/harness args for Claude and honors autoLoad flag
    const prepClaude = vault.prepareLaunch('claude', { resume: false });
    assert.equal(prepClaude.synced, true);
    assert.ok(prepClaude.extraArgs.includes('--add-dir'));
    assert.ok(prepClaude.extraArgs.includes('--mcp-config'));
    assert.ok(prepClaude.extraArgs.includes('--append-system-prompt-file'));
    assert.equal(prepClaude.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD, '1');
    assert.ok(fs.existsSync(path.join(altVault, '.runtime', 'claude', '.claude', 'skills', 'late-added-skill', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(altVault, '.runtime', 'claude', 'mcp-config.json')));

    // On resume, do not duplicate --append-system-prompt-file
    const prepResume = vault.prepareLaunch('claude', { resume: true });
    assert.ok(!prepResume.extraArgs.includes('--append-system-prompt-file'));

    // Verify specific CLI-only import applies exclusively to the selected CLI
    const cxOnlySkill = path.join(env.homeDir, '.codex', 'skills', 'codex-only-skill');
    fs.mkdirSync(cxOnlySkill, { recursive: true });
    fs.writeFileSync(path.join(cxOnlySkill, 'SKILL.md'), '---\nname: codex-only-skill\ndescription: Codex only\n---\n', 'utf8');
    const impOnly = vault.importFromCli({ cli: 'codex', skills: ['codex-only-skill'], targets: ['codex'], moveSkills: true });
    const recOnly = impOnly.state.skills.find((s) => s.name === 'codex-only-skill');
    assert.deepEqual(recOnly.targets, ['codex']);

    // Verify un-imported local skills stay strictly isolated from other CLIs, and disabling / untargeting removes applied resources cleanly
    const unimportedLocal = path.join(env.homeDir, '.claude', 'skills', 'unimported-only');
    fs.mkdirSync(unimportedLocal, { recursive: true });
    fs.writeFileSync(path.join(unimportedLocal, 'SKILL.md'), '---\nname: unimported-only\ndescription: Local only\n---\n', 'utf8');
    vault.saveHarness({ shared: '' });
    vault.saveRule({ name: 'korean-style', enabled: false });
    vault.saveSkill({ name: 'late-added-skill', enabled: false });
    vault.saveMcp({ name: 'github', command: 'npx', args: ['-y', '@mcp/github'], enabled: true, targets: ['agy'] });
    const prepDisabled = vault.prepareLaunch('claude', { resume: false });
    assert.equal(fs.existsSync(path.join(altVault, '.runtime', 'claude', '.claude', 'skills', 'unimported-only')), false);
    assert.equal(fs.existsSync(path.join(altVault, '.runtime', 'claude', '.claude', 'skills', 'late-added-skill')), false);
    assert.ok(!prepDisabled.extraArgs.includes('--mcp-config'));
    assert.ok(!prepDisabled.extraArgs.includes('--append-system-prompt-file'));
    const clAfterOff = JSON.parse(fs.readFileSync(path.join(env.homeDir, '.claude.json'), 'utf8'));
    assert.equal(clAfterOff.mcpServers.github, undefined);
    const agAfterTarget = JSON.parse(fs.readFileSync(path.join(env.homeDir, '.gemini', 'config', 'mcp_config.json'), 'utf8'));
    assert.equal(agAfterTarget.mcpServers.github.command, 'npx');

    // Toggling autoLoad off returns empty launch args
    vault.setAutoLoad(false);
    const prepOff = vault.prepareLaunch('claude');
    assert.equal(prepOff.synced, false);
    assert.deepEqual(prepOff.extraArgs, []);
  } finally {
    fs.rmSync(env.base, { recursive: true, force: true });
  }
});
