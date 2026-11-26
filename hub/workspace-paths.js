'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const windows = process.platform === 'win32';

class WorkspaceError extends Error {
  constructor(status, code, message) {
    super(message);
    Object.assign(this, { status, code });
  }
}

const invalidPath = () => new WorkspaceError(400, 'INVALID_FOLDER', 'Expected an existing absolute local directory');
const key = (name) => windows ? name.toLowerCase() : name;
const sameFolder = (a, b) => !!a && !!b && a.key === b.key && a.identity === b.identity;

function localPath(value) {
  if (typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value)) throw invalidPath();
  if (windows) {
    if (!/^[a-z]:[\\/]/i.test(value) || /[:<>"|?*]/.test(value.slice(2))) throw invalidPath();
    const parts = value.slice(3).split(/[\\/]/).filter(Boolean);
    if (parts.some((part) => (part !== '.' && part !== '..' && /[. ]$/.test(part))
      || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))) throw invalidPath();
  } else if (!path.isAbsolute(value)) throw invalidPath();
  return path.resolve(value);
}

async function folderInspector() {
  const fixed = new Set();
  if (windows) {
    const command = "[IO.DriveInfo]::GetDrives() | Where-Object DriveType -eq Fixed | ForEach-Object Name";
    const { stdout } = await execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command],
      { windowsHide: true, timeout: 5000 });
    for (const root of stdout.split(/\s+/)) if (root) fixed.add(key(root));
  }

  function inspect(value) {
    const source = localPath(value);
    if (windows && !fixed.has(key(path.parse(source).root))) throw invalidPath();
    try {
      const target = localPath(fs.realpathSync.native(source));
      const root = path.parse(target).root;
      if (windows && !fixed.has(key(root))) throw invalidPath();
      const stat = fs.statSync(target, { bigint: true });
      if (!stat.isDirectory() || !stat.ino || (windows && stat.dev !== fs.statSync(root, { bigint: true }).dev)) throw invalidPath();
      return { source, path: target, key: key(target), identity: `${stat.dev}:${stat.ino}` };
    } catch (err) {
      if (err instanceof WorkspaceError) throw err;
      if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP'].includes(err.code)) throw invalidPath();
      throw err;
    }
  }

  function current(binding) {
    try {
      const actual = inspect(binding.source);
      return sameFolder(actual, binding) ? actual : null;
    } catch (err) {
      if (err instanceof WorkspaceError) return null;
      throw err;
    }
  }

  return { inspect, current };
}

module.exports = { folderInspector, sameFolder, WorkspaceError };
