'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { resolveLaunchFolders } = require('../workspace-launch');
const { createTermManager } = require('../term-manager');
const { WorkspaceError } = require('../workspace-paths');

const primary = 'C:\\Work';
const refs = ['D:\\한글 with space\\', 'D:\\a&b!(x)%name^q'];
const plan = { row: { primary: { path: primary }, refs: refs.map((path) => ({ path })), revision: 1 } };
const repeated = refs.flatMap((dir) => ['--add-dir', dir]);
const cases = [
  ['codex', 'codex.exe', ['--no-daemon', 'resume', 'thread'], ['--no-daemon', ...repeated, 'resume', 'thread']],
  ['claude', 'claude.exe', ['--resume', 'thread'], ['--resume', 'thread', '--add-dir', ...refs]],
  ['agy', 'agy.exe', ['--conversation', 'thread'], [...repeated, '--conversation', 'thread']],
  ['cursor', 'cmd.exe', ['/c', 'C:\\Program Files\\Cursor\\cursor-agent.cmd', '--resume', 'thread']],
  ['powershell', 'powershell.exe', ['-NoLogo']],
  ['cmd', 'cmd.exe', []],
];

for (const [cli, cmd, args, nativeArgs] of cases) {
  test(`${cli} preserves legacy args and passes verified managed paths without shell interpolation`, () => {
    const env = { EXAMPLE: 'existing' };
    assert.deepEqual(resolveLaunchFolders({ cli, cmd, args, env }), { cmd, args, env });
    const options = { cli, cmd, args, env, plan };
    const single = resolveLaunchFolders({ ...options, plan: { row: { ...plan.row, refs: [] } } });
    assert.equal(single.cwd, primary);
    assert.equal(single.args, args);
    assert.deepEqual(single.env, nativeArgs ? env : { ...env, HUB_REFERENCE_DIRS_JSON: '[]' });
    assert.deepEqual(single.applied.referenceDirs, []);
    const launch = resolveLaunchFolders(options);
    assert.deepEqual(launch.args, nativeArgs || args);
    assert.deepEqual(launch.env, nativeArgs ? env : { ...env, HUB_REFERENCE_DIRS_JSON: JSON.stringify(refs) });
    assert.equal(launch.applied.method, nativeArgs ? 'native' : 'env');
    assert.deepEqual(launch.applied.referenceDirs, refs);
    assert.deepEqual(env, { EXAMPLE: 'existing' });
  });
}

test('managed CLI launch rejects permission bypass and unsafe shell wrappers', () => {
  assert.throws(() => resolveLaunchFolders({ cli: 'codex', cmd: 'codex.exe', args: ['--dangerously-bypass-approvals-and-sandbox'], plan }),
    { code: 'FOLDERS_PERMISSION_BYPASS' });
  assert.throws(() => resolveLaunchFolders({ cli: 'codex', cmd: 'cmd.exe', args: ['/c', 'codex.cmd'], plan }),
    { code: 'FOLDERS_UNSUPPORTED' });
  assert.throws(() => resolveLaunchFolders({ cli: 'cursor', cmd: 'cmd.exe', args: ['/c', 'D:\\%VAR%\\cursor-agent.cmd'], plan }),
    { code: 'FOLDERS_UNSUPPORTED' });
});

test('PTY spawn receives the manifest and terminal writes stop after revocation', async (t) => {
  const requests = [];
  let trusted = true;
  t.mock.method(globalThis, 'fetch', async (url, request) => {
    requests.push({ url, body: JSON.parse(request.body) });
    return { json: async () => ({ ok: true }) };
  });
  const workspaceExecution = {
    rememberLaunch: (_, __, stored) => assert.equal(stored, plan),
    guardTerm: async () => {
      if (!trusted) throw new WorkspaceError(403, 'FOLDER_UNTRUSTED', 'Approval required');
    },
  };
  const hub = createTermManager({ baseDir: require('node:os').tmpdir(), port: 7777,
    cleanModelEffort: () => ({}), workspaceExecution });
  const term = hub.createTerm({ cmd: 'cmd.exe', workspaceCli: 'cmd', workspaceLaunch: plan });
  assert.deepEqual(await term.spawnResult, { ok: true });
  assert.match(requests[0].url, /\/spawn$/);
  assert.equal(requests[0].body.cwd, primary);
  assert.deepEqual(JSON.parse(requests[0].body.env.HUB_REFERENCE_DIRS_JSON), refs);
  assert.equal((await term.proc.write('approved')).ok, true);
  trusted = false;
  assert.equal((await term.proc.write('blocked')).guardError.code, 'FOLDER_UNTRUSTED');
  assert.deepEqual(requests.slice(1).map(({ body }) => body.data), ['approved']);
});
