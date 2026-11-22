const path = require('path');

function ownedRoots(term, hostTerm, hostPid, processes) {
  const a = term.meta, b = hostTerm?.meta;
  if (!a?.projectTask || !b?.projectTask || a.operator || b.operator || a.research || b.research
    || a.projectTask.projectId !== b.projectTask.projectId || a.projectTask.taskId !== b.projectTask.taskId
    || a.cmd !== b.cmd || a.spawnedAt !== b.spawnedAt || !hostTerm.startedAt) return [];
  const exe = path.basename(a.cmd).toLowerCase();
  if (!/^(?:agy|claude|codex|cmd)\.exe$/.test(exe)) return [];
  const args = a.args || [];
  const key = ['--log-file', '--session-id', '--resume', '--conversation'].find(flag => args.includes(flag));
  const runId = args.find(arg => arg.startsWith('shell_environment_policy.set.HUB_PROJECT_RUN_ID='))?.match(/[a-f0-9-]{36}/i)?.[0];
  const marker = runId || (key ? args[args.indexOf(key) + 1] : exe === 'cmd.exe' ? args[1] : null);
  if (exe === 'cmd.exe' && (args[0] !== '/c' || !/(?:codex|cursor-agent)\.cmd$/i.test(args[1] || ''))) return [];
  const candidates = [...processes].filter(([, p]) => {
    if (!p || p.ppid !== hostPid || !p.exe || !p.cl || !p.start || path.basename(p.exe).toLowerCase() !== exe) return false;
    if (path.isAbsolute(a.cmd) && path.normalize(a.cmd).toLowerCase() !== path.normalize(p.exe).toLowerCase()) return false;
    return Math.abs(p.start - hostTerm.startedAt) <= 1500 && (!marker || p.cl.toLowerCase().includes(marker.toLowerCase()));
  });
  return candidates.map(([pid, proc]) => ({ pid, ...proc }));
}

function verifiedRoot(term, hostTerm, hostPid, processes) {
  const candidates = ownedRoots(term, hostTerm, hostPid, processes);
  if (hostTerm?.pid > 0) return candidates.find(p => p.pid === hostTerm.pid) || null;
  return candidates.length === 1 ? candidates[0] : null;
}

async function probeRoot(candidates, cols, { readWidth, resize, wait }) {
  if (candidates.length < 2 || candidates.length > 20) return null;
  const read = () => Promise.all(candidates.map(p => readWidth(p.pid)));
  const before = await read();
  if (before.some(w => !Number.isInteger(w) || w <= 0)) return null;
  let probe = cols + 2;
  while (before.includes(probe)) probe++;
  let identified = -1;
  try {
    await resize(probe);
    await wait(async () => {
      const widths = await read();
      const changes = widths.map((w, i) => w === probe && w !== before[i] ? i : -1).filter(i => i >= 0);
      identified = changes.length === 1 && widths.every((w, i) => i === changes[0] || w === before[i]) ? changes[0] : -1;
      return identified >= 0;
    });
  } finally {
    await resize(cols);
  }
  if (identified < 0 || before[identified] !== cols) return null;
  const restored = await wait(async () => (await readWidth(candidates[identified].pid)) === cols);
  return restored ? candidates[identified] : null;
}

async function stopTerminal(term, { write, wait, alive, terminate }) {
  if (!alive()) return;
  await write('\x03');
  if (await wait(700)) return;
  if (!alive()) return;
  await write('\x04');
  if (await wait(1200)) return;
  if (!alive()) return;
  await terminate();
  if (!(await wait(3500))) throw new Error('터미널 ' + term.id + '의 종료를 확인하지 못했습니다.');
}
module.exports = { ownedRoots, verifiedRoot, probeRoot, stopTerminal };
