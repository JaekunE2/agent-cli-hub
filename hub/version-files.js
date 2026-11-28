'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { VERSION_RE } = require('./project-validation');

const excluded = new Set(['.git', '.hub-worktrees', 'node_modules', '.venv', '__pycache__', '.cache', '.next']);
const within = (root, item) => {
  const relative = path.relative(root, item);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
};

function versionFolder(root, id, number) {
  if (!/^[\w-]{1,80}$/.test(id) || !VERSION_RE.test(number)) throw new Error('프로젝트 버전을 찾을 수 없습니다.');
  return path.join(root, id, number);
}

async function scan(root) {
  const files = new Map();
  const walk = async (relative) => {
    for (const name of await fs.readdir(path.join(root, relative))) {
      if (excluded.has(name.toLowerCase())) continue;
      const key = path.join(relative, name);
      const entry = await fs.lstat(path.join(root, key));
      if (entry.isDirectory()) { files.set(key, 'dir'); await walk(key); }
      else if (entry.isFile()) files.set(key, `${entry.ino}:${entry.size}:${entry.mtimeMs}:${entry.ctimeMs}`);
    }
  };
  await walk('');
  return files;
}

async function copyVersion(source, destination) {
  const from = await fs.realpath(source);
  const parent = path.dirname(destination);
  if (within(from, path.resolve(destination))) throw new Error('버전 저장 위치가 원본 폴더 안에 있습니다.');
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.realpath(parent);
  const target = path.join(root, path.basename(destination));
  if (within(from, target)) throw new Error('버전 저장 위치가 원본 폴더 안에 있습니다.');
  const before = await scan(from);
  const temporary = await fs.mkdtemp(path.join(root, '.copy-'));
  try {
    for (const [relative, value] of before) {
      const input = path.join(from, relative);
      const output = path.join(temporary, relative);
      if (value === 'dir') await fs.mkdir(output);
      else {
        const opened = await fs.realpath(input);
        if (path.relative(input, opened) !== '') throw new Error('저장 중 원본 파일이 변경되었습니다. 다시 시도하세요.');
        await fs.copyFile(opened, output);
      }
    }
    const after = await scan(from);
    if (after.size !== before.size || [...before].some(([key, stamp]) => after.get(key) !== stamp)) {
      throw new Error('저장 중 원본 파일이 변경되었습니다. 다시 시도하세요.');
    }
    await fs.rename(temporary, target);
  } finally {
    if (path.dirname(temporary) === root) await fs.rm(temporary, { recursive: true, force: true });
  }
}

function versionWorkspace(project, number) {
  const version = project.versions?.find((item) => item.number === number);
  return version?.snapshotId ? version.workspace || '' : project.cwd;
}

module.exports = { versionFolder, copyVersion, versionWorkspace, scanVersion: scan };
