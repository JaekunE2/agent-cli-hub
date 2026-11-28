'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

function prepareProjectPrompt(baseDir, text, cmd, chat = false) {
  if (!baseDir || process.platform !== 'win32' || Buffer.byteLength(text, 'utf8') <= 1000) return text;
  const file = path.join(baseDir, 'data', 'project-prompts', createHash('sha256').update(text).digest('hex') + '.md');
  const wsl = /^wsl(?:\.exe)?$/i.test(path.basename(cmd || ''));
  const cliPath = wsl ? file.replace(/^([A-Za-z]):[\\/]/, (_, drive) => `/mnt/${drive.toLowerCase()}/`).replace(/\\/g, '/') : file;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(file, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST' || fs.readFileSync(file, 'utf8') !== text) throw error;
  }
  return chat
    ? `Read the entire UTF-8 file at "${cliPath}". Its contents are my chat message. Respond to that message. Do not edit the file.`
    : `Read the entire UTF-8 project task file at "${cliPath}" and execute its instructions. Use it as the task specification, including its completion criteria. Do not edit the task file.`;
}

module.exports = { prepareProjectPrompt };
