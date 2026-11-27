const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { discoverSlashCommands } = require('../slash-discovery');
const { createUnifiedVault } = require('../unified-vault');
const { translateJs } = require('../i18n');
const { submitPrompt } = require('../prompt-submission');

test('Hub aliases win over dynamic commands in both UI languages', async () => {
  const source = await fs.readFile(path.join(__dirname, '../public/slash-commands.js'), 'utf8');
  for (const lang of ['ko', 'en']) {
    const context = vm.createContext({ document: { documentElement: { lang } } });
    vm.runInContext(lang === 'en' ? translateJs(source) : source, context);
    vm.runInContext(`
      this.catalog = slashCatalog('codex', ['/schedule', '/prompts:app', '$todo', '$review-change'].map(command => ({ command })));
      this.results = ['/schedule report', '/스케줄 report', '/prompts:app', '/fork', '/model', '/mcp', '/btw'].map(input => hubSlashEntry(slashInput(input).key)?.name);
    `, context);
    assert.deepEqual([...context.results], ['schedule', 'schedule', 'app', 'branch', 'model', 'mcp', 'sidechat']);
    const native = context.catalog.filter(entry => !entry.hub).map(entry => entry.command);
    assert.ok(native.includes('$review-change'));
    for (const conflict of ['/schedule', '/prompts:app', '$todo']) assert.ok(!native.includes(conflict));
  }
});

test('discovery reads sessions’ workspace and CLI homes and skips hidden skills', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-slash-fixture-'));
  const root = path.join(home, 'project');
  const cwd = path.join(root, 'package');
  const configHome = path.join(home, 'alt-codex');
  const put = async (file, text = '') => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
  };
  await fs.mkdir(cwd, { recursive: true });
  await put(path.join(root, '.git'), 'gitdir: ../mock');
  await put(path.join(root, '.claude', 'commands', 'project-check.md'));
  await put(path.join(root, '.claude', 'skills', 'private', 'SKILL.md'), '---\nuser-invocable: false\n---\n');
  await put(path.join(root, '.agents', 'skills', 'shared', 'SKILL.md'), '---\nname: shared\n---\n');
  await put(path.join(configHome, 'skills', 'account-check', 'SKILL.md'), '---\nname: account-check\n---\n');
  await put(path.join(configHome, 'prompts', 'obsolete.md'));
  const names = commands => commands.map(command => command.command).sort();
  assert.deepEqual(names(await discoverSlashCommands({ agent: 'claude', cwd, home })), ['/project-check']);
  assert.deepEqual(names(await discoverSlashCommands({ agent: 'codex', cwd, home, configHome })), ['$account-check', '$shared']);
  assert.deepEqual(names(await discoverSlashCommands({ agent: 'agy', cwd, home })), ['/shared']);
  await put(path.join(root, '.claude', 'commands', 'added-later.md'));
  assert.deepEqual(names(await discoverSlashCommands({ agent: 'claude', cwd, home })), ['/added-later', '/project-check']);
});

test('native slash submits once when the CLI opens a selection menu', async () => {
  const writes = [];
  const frames = ['› Ask Codex to do anything', '› /permissions', 'Permissions\n› Read Only\nenter select · esc back'];
  await submitPrompt({
    text: '/permissions', nativeSlash: true,
    read: () => ({ screen: frames[writes.length] }),
    write: key => writes.push(key), guard() {}, sleep() {}, waitFor: check => check(),
  });
  assert.deepEqual(writes, ['/permissions', '\r']);
});

test('Vault removal and target changes exclude remaining local skill copies from the picker', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-slash-vault-'));
  const vault = createUnifiedVault({ repoRoot: home, homeDir: home });
  const name = 'test-skill';
  const content = `---\nname: ${name}\n---\n`;
  const local = path.join(home, '.codex', 'skills', name, 'SKILL.md');
  await fs.mkdir(path.dirname(local), { recursive: true });
  await fs.writeFile(local, content);
  const discover = () => discoverSlashCommands({ agent: 'codex', home, excludedSkills: vault.slashSkillExclusions('codex') });
  assert.equal((await discover())[0].command, '$test-skill');
  vault.saveSkill({ name, content, targets: ['claude'] });
  assert.deepEqual(await discover(), []);
  vault.deleteSkill(name);
  assert.equal(await fs.readFile(local, 'utf8'), content);
  assert.deepEqual(await discover(), []);
  assert.equal(vault.gatherFromClis().state.skills.some(skill => skill.name === name), false);
  vault.importFromCli({ cli: 'codex', skills: [name], moveSkills: false });
  assert.equal((await discover())[0].command, '$test-skill');
});
