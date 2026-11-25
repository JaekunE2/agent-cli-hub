// Delta Slurm workers without the NAS: code and data go straight to a worker's local disk
// (<slurm.stageRoot>/<Drive>/<path>, default <workdir>), through srun on the controller (workers have no ssh of
// their own). Only new/changed files are sent (size + mtime), nothing is deleted on the node.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const TAR = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
const EX = new Set(['.git', '__pycache__', '.venv', 'venv', 'node_modules', '.ipynb_checkpoints', '.pytest_cache', '.mypy_cache', 'wandb', '.cache']);
const q = (x) => `'${String(x).replace(/'/g, `'\\''`)}'`;

function sshArgs(srv) {
  return ['-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=4', ...(srv.port ? ['-p', String(srv.port)] : []), ...(srv.key ? ['-i', srv.key] : []), srv.ssh];
}
const stageRoot = (srv) => String(srv.slurm?.stageRoot || srv.workdir || '/tmp/ccd-stage').replace(/\/+$/, '');
// local path → its staged copy on a node
function stagedPath(srv, local) {
  const f = path.resolve(String(local)).replace(/\\/g, '/');
  const m = /^([A-Za-z]):\/?(.*)$/.exec(f);
  if (!m) throw new Error(`not a local drive path: ${local}`);
  return `${stageRoot(srv)}/${m[1].toUpperCase()}/${m[2]}`.replace(/\/+$/, '');
}
// run a shell command on a worker node (a tiny CPU-only step; waits while the node's CPUs/RAM are all taken)
function nodeSpawn(srv, node, cmd, stdio) {
  const sl = srv.slurm || {};
  const part = (sl.nodePartition && sl.nodePartition[node]) || sl.partition || 'gpu';
  return spawn('ssh', [...sshArgs(srv), `srun -p ${part} -w ${node} -c 1 --mem=1000 -t 240 --quiet -J ccd-stage bash -c ${q(cmd)}`], { stdio });
}
function nodeRun(srv, node, cmd) {
  return new Promise((ok) => {
    const c = nodeSpawn(srv, node, cmd, ['ignore', 'pipe', 'pipe']);
    let o = '', e = ''; c.stdout.on('data', (d) => (o += d)); c.stderr.on('data', (d) => (e += d));
    c.on('exit', (code) => ok({ code, out: o, err: e }));
  });
}
function pipe(a, b) {
  return new Promise((res) => {
    let left = 2; const codes = {};
    const done = (k) => (code) => { codes[k] = code; if (--left === 0) res(codes); };
    a.stdout.pipe(b.stdin); a.on('exit', done('a')); b.on('exit', done('b'));
  });
}
// send a local folder to <node>:<remote>, only what is new or changed
async function stageDir(srv, node, local, { remote, exclude = [], say = console.error, dry = false } = {}) {
  local = path.resolve(local);
  if (!fs.existsSync(local)) throw new Error(`not found: ${local}`);
  const isFile = fs.statSync(local).isFile();
  const base = isFile ? path.dirname(local) : local;
  remote = remote || stagedPath(srv, base);
  const ex = new Set([...EX, ...exclude]);
  const files = [];
  if (isFile) { const st = fs.statSync(local); files.push({ r: path.basename(local), size: st.size, mtime: Math.floor(st.mtimeMs / 1000) }); }
  else {
    const walk = (abs, rel) => {
      let ents; try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (ex.has(e.name) || /\.(part|tmp|lock)$|^~\$/.test(e.name)) continue;
        const a = path.join(abs, e.name), r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(a, r);
        else if (e.isFile()) { try { const st = fs.statSync(a); files.push({ r, size: st.size, mtime: Math.floor(st.mtimeMs / 1000) }); } catch {} }
      }
    };
    walk(local, '');
  }
  const have = new Map();
  const ls = await nodeRun(srv, node, `[ -d ${q(remote)} ] && cd ${q(remote)} && find . -type f -printf '%s %T@ %P\\n'; true`);
  if (ls.code !== 0) throw new Error(`cannot list ${node}:${remote} (${(ls.err || '').trim().split('\n').pop()})`);
  for (const l of ls.out.split('\n')) { const m = /^(\d+) (\d+)(?:\.\d+)? (.+)$/.exec(l); if (m) have.set(m[3], { size: Number(m[1]), mtime: Number(m[2]) }); }
  const todo = files.filter((f) => { const h = have.get(f.r); return !h || h.size !== f.size || f.mtime > h.mtime + 2; });
  const bytes = todo.reduce((a, f) => a + f.size, 0);
  say(`[stage] ${local} → ${node}:${remote}: ${files.length} files, ${todo.length} new/changed (${(bytes / 2 ** 30).toFixed(2)} GiB)`);
  if (!todo.length || dry) return { remote, sent: 0, bytes: 0 };
  const lst = path.join(require('os').tmpdir(), `ccd-stage-${process.pid}-${Date.now()}.lst`);
  fs.writeFileSync(lst, todo.map((f) => f.r).join('\n') + '\n', 'utf8');
  const t0 = Date.now();
  try {
    const tar = spawn(TAR, ['-cf', '-', '-C', base, '-T', lst], { stdio: ['ignore', 'pipe', 'inherit'] });
    const up = nodeSpawn(srv, node, `mkdir -p ${q(remote)} && tar -xf - -C ${q(remote)}`, ['pipe', 'inherit', 'inherit']);
    const c = await pipe(tar, up);
    if (c.a !== 0 || c.b !== 0) throw new Error(`upload to ${node} failed (tar ${c.a}, srun ${c.b})`);
  } finally { try { fs.unlinkSync(lst); } catch {} }
  say(`[stage] done in ${Math.round((Date.now() - t0) / 1000)}s`);
  return { remote, sent: todo.length, bytes };
}
// download <node>:<remote> (a folder or file) into a local folder
async function fetchFrom(srv, node, remote, localDest) {
  fs.mkdirSync(localDest, { recursive: true });
  const down = nodeSpawn(srv, node, `cd ${q(path.posix.dirname(remote))} && tar -cf - ${q(path.posix.basename(remote))}`, ['ignore', 'pipe', 'inherit']);
  const tar = spawn(TAR, ['-xf', '-', '-C', localDest], { stdio: ['pipe', 'inherit', 'inherit'] });
  const c = await pipe(down, tar);
  if (c.a !== 0 || c.b !== 0) throw new Error(`fetch of ${node}:${remote} failed (srun ${c.a}, tar ${c.b})`);
  return path.join(localDest, path.posix.basename(remote));
}
module.exports = { stagedPath, stageRoot, nodeRun, nodeSpawn, stageDir, fetchFrom, q };
