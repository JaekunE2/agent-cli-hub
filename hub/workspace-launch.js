'use strict';

const path = require('node:path');
const { WorkspaceError } = require('./workspace-paths');

const repeat = (dirs) => dirs.flatMap((dir) => ['--add-dir', dir]);
const bypassFlags = new Set(['--dangerously-bypass-approvals-and-sandbox', '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions', '--yolo']);

function unsupported() {
  return new WorkspaceError(409, 'FOLDERS_UNSUPPORTED', 'This launcher cannot apply managed folder settings safely');
}

function resolveLaunchFolders({ cli, cmd, args = [], env = {}, plan }) {
  if (!plan) return { cmd, args, env };
  if (args.some((arg) => bypassFlags.has(arg) || /^(?:--permission-mode=)?bypassPermissions$/.test(arg))) {
    throw new WorkspaceError(409, 'FOLDERS_PERMISSION_BYPASS', 'Managed folders require normal CLI permission checks');
  }
  const { row } = plan;
  const cwd = row.primary.path;
  const referenceDirs = row.refs.map((ref) => ref.path);
  const wrapper = path.win32.basename(cmd).toLowerCase();
  const native = ['codex', 'claude', 'agy'].includes(cli);
  if (native && /^(?:cmd(?:\.exe)?|wsl(?:\.exe)?)$|\.(?:cmd|bat|ps1)$/.test(wrapper)) throw unsupported();
  if (cli === 'cursor' && /^cmd(?:\.exe)?$/.test(wrapper)) {
    const [run, script, flag, id, ...rest] = args;
    if (run !== '/c' || !script || !/^[\p{L}\p{M}\p{N} ._:/\\-]+\.(?:cmd|exe)$/iu.test(script)
        || rest.length || (args.length !== 2 && !(args.length === 4 && flag === '--resume' && /^[\w-]+$/.test(id)))) {
      throw unsupported();
    }
  }
  if (referenceDirs.length && native) {
    if (cli === 'claude') args = [...args, '--add-dir', ...referenceDirs];
    else if (args[0] === '--no-daemon') args = [args[0], ...repeat(referenceDirs), ...args.slice(1)];
    else args = [...repeat(referenceDirs), ...args];
  } else if (!native) {
    env = { ...env, HUB_REFERENCE_DIRS_JSON: JSON.stringify(referenceDirs) };
  }
  const applied = { revision: row.revision, primaryCwd: cwd, referenceDirs, method: native ? 'native' : 'env', observedAt: Date.now() };
  return { cwd, cmd, args, env, applied };
}

module.exports = { resolveLaunchFolders, unsupported };
