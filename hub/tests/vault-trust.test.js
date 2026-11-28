'use strict';
// A vault folder Claude Code has not trusted must not be passed with --add-dir: the CLI would stop
// at a "trust this directory?" prompt (default "No, exit") — every restored session hung there on 2026-11-28.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isClaudeTrustedDir } = require('../vault-cli-ops');
const { createUnifiedVault } = require('../unified-vault');

function setup(t, projects) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-vault-trust-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const homeDir = path.join(base, 'home');
  fs.mkdirSync(homeDir, { recursive: true });
  if (projects) fs.writeFileSync(path.join(homeDir, '.claude.json'), JSON.stringify({ projects: projects(base) }));
  return { base, homeDir };
}

test('isClaudeTrustedDir: the folder itself or a parent must have accepted trust', (t) => {
  const { base, homeDir } = setup(t, (b) => ({
    [path.join(b, 'trusted').replace(/\\/g, '/')]: { hasTrustDialogAccepted: true },
    [path.join(b, 'declined')]: { hasTrustDialogAccepted: false },
  }));
  assert.equal(isClaudeTrustedDir(path.join(base, 'trusted', 'a', 'b'), homeDir), true);
  assert.equal(isClaudeTrustedDir(path.join(base, 'trusted'), homeDir), true);
  assert.equal(isClaudeTrustedDir(path.join(base, 'declined', 'x'), homeDir), false);
  assert.equal(isClaudeTrustedDir(path.join(base, 'other'), homeDir), false);
});

test('isClaudeTrustedDir: no ~/.claude.json means nothing is trusted', (t) => {
  const { base, homeDir } = setup(t, null);
  assert.equal(isClaudeTrustedDir(path.join(base, 'x'), homeDir), false);
});

test('Claude launch skips --add-dir for an untrusted vault and keeps it once trusted', (t) => {
  const { base, homeDir } = setup(t, () => ({}));
  const vault = createUnifiedVault({ homeDir, repoRoot: base });
  vault.saveSkill({ name: 'demo', content: 'body' });
  const untrusted = vault.prepareLaunch('claude', {});
  assert.ok(!untrusted.extraArgs.includes('--add-dir'), 'untrusted vault folder must not be added');
  assert.equal((untrusted.env || {}).CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD, undefined);

  fs.writeFileSync(path.join(homeDir, '.claude.json'), JSON.stringify({ projects: { [base]: { hasTrustDialogAccepted: true } } }));
  const trusted = vault.prepareLaunch('claude', {});
  assert.ok(trusted.extraArgs.includes('--add-dir'));
  assert.equal(trusted.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD, '1');
});
