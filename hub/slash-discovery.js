'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { parseSkillFrontmatter } = require('./vault-formats');

async function entries(dir) {
  try { return await fs.readdir(dir, { withFileTypes: true }); }
  catch { return []; }
}

async function metadata(file) {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > 256 * 1024) return null;
    const text = await fs.readFile(file, 'utf8');
    const header = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(text)?.[0] || '';
    if (/^user-invocable:[ \t]*['"]?false\b/im.test(header)) return null;
    return parseSkillFrontmatter(text);
  } catch { return null; }
}

async function discoverSlashCommands({ agent, cwd, configHome, home = os.homedir(), excludedSkills = new Set() }) {
  const folders = [];
  if (cwd && path.isAbsolute(cwd)) {
    for (let dir = cwd; ; dir = path.dirname(dir)) {
      folders.push(dir);
      if (dir === path.dirname(dir) || (await entries(dir)).some(entry => entry.name === '.git')) break;
    }
  }
  const root = configHome || path.join(home, agent === 'agy' ? '.gemini' : `.${agent}`);
  const skills = {
    claude: [path.join(root, 'skills'), ...folders.toReversed().map(dir => path.join(dir, '.claude', 'skills'))],
    codex: [...folders.map(dir => path.join(dir, '.agents', 'skills')), path.join(home, '.agents', 'skills'), path.join(root, 'skills')],
    agy: [path.join(root, 'antigravity-cli', 'skills'), path.join(root, 'skills'), ...folders.map(dir => path.join(dir, '.agents', 'skills'))],
  }[agent] || [];
  const commands = agent === 'claude'
    ? [path.join(root, 'commands'), ...folders.toReversed().map(dir => path.join(dir, '.claude', 'commands'))]
    : [];
  const seen = new Map();
  const add = (name, prefix, meta) => {
    if (!/^[\p{L}\p{N}_.-]{1,100}$/u.test(name)) return;
    const command = prefix + name;
    const key = command.toLowerCase();
    if (!seen.has(key)) seen.set(key, { command, description: meta.description, takesArgs: true });
  };
  for (const dir of skills) {
    await Promise.all((await entries(dir)).filter(e => !e.name.startsWith('.') && (e.isDirectory() || e.isSymbolicLink())).map(async e => {
      if (excludedSkills.has(e.name.toLowerCase())) return;
      const meta = await metadata(path.join(dir, e.name, 'SKILL.md'));
      const name = agent === 'claude' ? e.name : meta?.name || e.name;
      if (meta && !excludedSkills.has(name.toLowerCase())) add(name, agent === 'codex' ? '$' : '/', meta);
    }));
  }
  for (const dir of commands) {
    await Promise.all((await entries(dir)).filter(e => !e.name.startsWith('.') && /\.md$/i.test(e.name)).map(async e => {
      const meta = await metadata(path.join(dir, e.name));
      if (meta) add(e.name.slice(0, -3), '/', meta);
    }));
  }
  return [...seen.values()].sort((a, b) => a.command.localeCompare(b.command));
}

module.exports = { discoverSlashCommands };
