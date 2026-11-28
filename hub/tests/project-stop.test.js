const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { verifiedRoot, probeRoot, stopTerminal } = require('../project-stop');

test('only the exact CLI child under the verified Project host qualifies for termination', () => {
  const exe = path.resolve('agy.exe');
  const meta = { projectTask: { projectId: 'project', taskId: 'task' }, cmd: exe,
    args: ['--log-file', 'unique-term.log'], spawnedAt: 5000 };
  const term = { id: '4', meta };
  const hostTerm = { id: '4', meta: { ...meta }, startedAt: 5100 };
  const root = { ppid: 12, exe, cl: exe + ' --log-file unique-term.log', start: 5090 };
  const processes = new Map([[21, root], [22, { ...root, ppid: 99 }], [23, { ...root, cl: exe + ' --log-file another.log' }]]);
  processes.set(25, undefined);
  assert.equal(verifiedRoot(term, hostTerm, 12, processes)?.pid, 21);
  assert.equal(verifiedRoot(term, hostTerm, 12, new Map([[25, undefined]])), null);
  processes.set(24, { ...root });
  assert.equal(verifiedRoot(term, hostTerm, 12, processes), null);
  assert.equal(verifiedRoot(term, { ...hostTerm, pid: 24 }, 12, processes)?.pid, 24);
  processes.delete(24);
  assert.equal(verifiedRoot(term, { ...hostTerm, meta: { ...meta, operator: true } }, 12, processes), null);
});

test('only a unique terminal resize followed by confirmation of restoration identifies a legacy child', async () => {
  const candidates = [{ pid: 1 }, { pid: 2 }, { pid: 3 }];
  const widths = new Map([[1, 80], [2, 82], [3, 80]]);
  const updates = [];
  const io = {
    readWidth: async pid => widths.get(pid),
    resize: async cols => { updates.push(cols); widths.set(3, cols); },
    wait: predicate => predicate(),
  };
  assert.equal((await probeRoot(candidates, 80, io))?.pid, 3);
  assert.deepEqual(updates, [83, 80]);
  assert.equal(widths.get(3), 80);
  updates.length = 0;
  assert.equal(await probeRoot(candidates, 80, {
    ...io, resize: async cols => { await io.resize(cols); widths.set(1, cols); },
  }), null);
  assert.deepEqual(updates, [83, 80]);
});

test('graceful exit avoids termination, and failed exit is not reported as closed', async () => {
  const events = [], term = { id: '4' };
  const steps = {
    alive: () => true,
    write: async key => events.push(key),
    wait: async () => true,
    terminate: async () => events.push('terminate'),
  };
  await stopTerminal(term, steps);
  assert.deepEqual(events, ['\x03']);
  events.length = 0;
  await assert.rejects(stopTerminal(term, { ...steps, wait: async () => false }), /종료를 확인하지 못했습니다/);
  assert.deepEqual(events, ['\x03', '\x04', 'terminate']);
});
