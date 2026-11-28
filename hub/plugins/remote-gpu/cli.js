'use strict';
// ccd commands of this plugin. ctx = the helpers ccd.js shares (see plugins.js).
const fs = require('fs');
const path = require('path');
module.exports = function cli(ctx) {
  const { api, die, flags, pos, DIR, BASE, PORT, token, usageDir, readTarget, overview, resolve, sessionIdOf, ago, termLabel, SELF_PID } = ctx;
  let { rest } = ctx;
  const { spawn } = require('child_process');
  // ---- gpu run on a configured server (gpu.servers in config.json): ssh / Slurm, --sync/--fetch/--stage/--env ----
  // ---------- remote GPU job ----------
  // Optional --sync upload (tar over ssh), then the job starts detached on the server
  // (nohup + setsid, log/exit code in ~/.ccd-jobs/<ticket>) so a dropped connection or a dead
  // wrapper does not kill it; the wrapper follows the log (reconnecting) and --fetch downloads
  // result folders at the end. If the wrapper dies, the lease follows the remote pid (gpu.js probe).
  async function runRemote(g, host, spawn) {
    const rinfo = await api(`/api/gpu/remote?host=${encodeURIComponent(host)}&key=${encodeURIComponent(g.gpu)}`);
    const SL = rinfo.slurm || null; // Slurm cluster: the job goes through sbatch instead of nohup
    // slurm.local: no shared NAS — code/data are staged onto the worker's own disk and the job runs
    // through srun from the controller (log + exit code stay on the controller's local disk)
    const LOC = !!(SL && SL.local);
    const DS = LOC ? require('./delta-stage') : null;
    const srvObj = { ssh: rinfo.ssh, key: rinfo.key, port: rinfo.port, slurm: SL };
    const SLN = SL && !LOC; // the sbatch + NFS job folder flavour
    if (rinfo.error) die(rinfo.error);
    const q = (x) => `'${String(x).replace(/'/g, `'\\''`)}'`;
    const qd = (d) => (d === '~' ? '"$HOME"' : d.startsWith('~/') ? `"$HOME"/${q(d.slice(2))}` : q(d));
    const sshArgs = ['-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=4', ...(rinfo.port ? ['-p', String(rinfo.port)] : []), ...(rinfo.key ? ['-i', rinfo.key] : []), rinfo.ssh];
    const sshOut = (cmd) => new Promise((res) => {
      const c = spawn('ssh', [...sshArgs, cmd], { stdio: ['ignore', 'pipe', 'inherit'] });
      let o = ''; c.stdout.on('data', (d) => (o += d)); c.on('exit', (code) => res({ code, out: o.trim() }));
    });
    // Windows' own bsdtar understands G:\ paths (Git's GNU tar would read "G:" as a remote host)
    const TAR = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    const pipeTo = (a, b) => new Promise((res) => {
      let left = 2, codes = {};
      const done = (k) => (code) => { codes[k] = code; if (--left === 0) res(codes); };
      a.stdout.pipe(b.stdin);
      a.on('exit', done('a')); b.on('exit', done('b'));
    });
    const release = (code, reason) => api('/api/gpu/release', { id: g.id, exitCode: code, reason }).catch(() => {});
    const fail = async (msg) => { await release(1, msg); die(`[gpu] ${msg}`); };
    // heartbeat from the start: staging/uploads can take many minutes and a silent wrapper loses its lease
    const hb = setInterval(() => api('/api/gpu/heartbeat', { id: g.id }).catch(() => {}), 30000);

    // ---- local → server path translation, so the same command works here and there ----
    const home = await sshOut('printf %s "$HOME"');
    if (home.code !== 0 || !home.out.startsWith('/')) await fail(`cannot reach ${host} over ssh`);
    const rHome = home.out;
    const syncDir = flags.sync ? path.resolve(String(flags.sync)) : null;
    const fetchDirs = flags.fetch ? String(flags.fetch).split(',').map((s) => s.trim()).filter(Boolean) : [];
    const fwd = (s) => String(s).replace(/\\/g, '/').replace(/\/+$/, '');
    const under = (p, root) => p.toLowerCase() === root.toLowerCase() || p.toLowerCase().startsWith(root.toLowerCase() + '/');
    // Git Bash (MSYS) rewrites Unix-looking args for native programs (/home/x → C:/Program Files/Git/home/x)
    // and expands ~ to this PC's home; both were meant for the server
    const gitRoot = fwd(process.env.EXEPATH ? path.resolve(process.env.EXEPATH, '..') : 'C:\\Program Files\\Git');
    const localHome = fwd(require('os').homedir());
    const tilde = (p) => (p === '~' ? rHome : p.startsWith('~/') ? rHome + p.slice(1) : p);
    let rawDir = flags['remote-dir'] ? fwd(flags['remote-dir']) : null;
    if (rawDir && under(rawDir, gitRoot)) rawDir = rawDir.slice(gitRoot.length);
    if (rawDir && under(rawDir, localHome)) rawDir = rHome + rawDir.slice(localHome.length);
    const workdir = LOC ? (rawDir || (syncDir ? DS.stagedPath(srvObj, syncDir) : DS.stageRoot(srvObj)))
      : tilde(rawDir || (syncDir ? `${tilde(rinfo.workdir || '~')}/ccd-sync/${path.basename(syncDir).replace(/[^\w.-]/g, '_')}` : tilde(rinfo.workdir || '~')));
    const syncRoot = syncDir ? fwd(syncDir) : null;
    const unmapped = [];
    // config pathMap: local folders already copied to the server (big datasets), longest prefix first
    const pathMap = Object.entries(rinfo.pathMap || {}).map(([l, r]) => [fwd(l), r.replace(/\/+$/, '')]).sort((a, b) => b[0].length - a[0].length);
    const mapPath = (p) => {
      const f = fwd(p);
      if (under(f, gitRoot)) return f.slice(gitRoot.length) || '/';
      if (syncRoot && under(f, syncRoot)) return workdir + f.slice(syncRoot.length); // file inside the synced folder
      const pm = pathMap.find(([l]) => under(f, l));
      if (pm) return pm[1] + f.slice(pm[0].length);
      if (under(f, localHome)) return rHome + f.slice(localHome.length);
      unmapped.push(p);
      return p;
    };
    const WINPATH = /(^|[\s=,"'])([A-Za-z]:[\\/][^\s"',;]*)/g;
    const mapArg = (a) => {
      if (/^[A-Za-z]:[\\/]/.test(a)) return mapPath(a); // whole argument is a path (may contain spaces)
      if (/^~(\/|$)/.test(a)) return tilde(a);
      if (/^[\w.-]+(\\[\w.-]+)+$/.test(a)) return a.replace(/\\/g, '/'); // relative Windows path data\x.csv
      return a.replace(WINPATH, (m, pre, p) => pre + mapPath(p)); // --data=G:\x, "a,G:\y"
    };
    // Environment on the server. config envs maps local conda env names to server venvs
    // ({"cadgs": "/home/u/venvs/gs"}): chosen by --env NAME, by a local path inside ...\envs\NAME\,
    // or "cadgs" for nerfstudio's ns-* tools. The venv's bin goes first on PATH for the job.
    const envs = rinfo.envs || {};
    const envOfPath = /[\\/]envs[\\/]([\w.-]+)[\\/]/i.exec(rest[0] || '');
    const envName = flags.env || (envOfPath && envs[envOfPath[1]] ? envOfPath[1] : null) || (/^ns-[\w-]+(\.exe)?$/i.test(path.basename(rest[0] || '')) && envs.cadgs ? 'cadgs' : null);
    if (envName && !envs[envName]) await fail(`--env ${envName}: no such environment on ${host} (configured: ${Object.keys(envs).join(', ') || 'none'})`);
    const venv = envName ? envs[envName] : null;
    const pyBin = venv ? `${venv}/bin/python` : rinfo.python;
    // `python ...` / a local python.exe → the server's interpreter
    if (pyBin && /(^|[\\/])python(3(\.\d+)?)?(\.exe)?$/i.test(rest[0] || '')) {
      console.error(`[gpu] ${rest[0]} → ${pyBin} (server's python${envName ? `, env ${envName}` : ''})`);
      rest[0] = pyBin;
    } else if (venv && /[\\/]/.test(rest[0] || '') && /[\\/]envs[\\/]/i.test(rest[0])) {
      // D:\Anaconda\envs\cadgs\Scripts\ns-train.exe → <venv>/bin/ns-train
      const tool = path.basename(fwd(rest[0])).replace(/\.exe$/i, '');
      console.error(`[gpu] ${rest[0]} → ${venv}/bin/${tool} (env ${envName})`);
      rest[0] = `${venv}/bin/${tool}`;
    } else if (venv) rest[0] = String(rest[0]).replace(/\.exe$/i, '');
    const envPrefix = venv ? `VIRTUAL_ENV=${venv} PATH=${venv}/bin:$PATH ` : '';
    if (venv) console.error(`[gpu] environment on ${host}: ${venv}`);
    const before = rest.join(' ');
    rest = rest.length === 1 ? [rest[0].replace(WINPATH, (m, pre, p) => pre + mapPath(p))] : rest.map(mapArg);
    if (rest.join(' ') !== before) console.error(`[gpu] paths translated for ${host}: ${rest.join(' ')}`);
    if (LOC) {
      if (!SL.node) await fail(`Slurm node for ${g.gpu} unknown (re-probe pending) — try again`);
      // --stage a,b (and --sync): send these local folders to the node first (only new/changed files)
      const stageDirs = [...(syncDir ? [syncDir] : []), ...String(flags.stage || '').split(',').map((x) => x.trim()).filter(Boolean)];
      for (const d of stageDirs) {
        try { await DS.stageDir(srvObj, SL.node, d, { exclude: syncDir && path.resolve(d) === syncDir ? fetchDirs : [] }); }
        catch (e) { await fail(`staging ${d} to ${SL.node} failed: ${e.message}`); }
      }
      if (!flags['no-path-check']) {
        const root = DS.stageRoot(srvObj);
        const staged = [...new Set(rest.join(' ').split(/[\s"',;=]+/).filter((a) => a.startsWith(root + '/')))];
        if (staged.length) {
          const chk = await DS.nodeRun(srvObj, SL.node, staged.map((m) => `[ -e ${q(m)} ] || echo ${q(m)}`).join('; ') + '; true');
          const missing = chk.out.split('\n').filter(Boolean);
          if (missing.length) await fail(`not on ${SL.node}'s disk yet: ${missing.join(', ')}\n  → add --stage <local project/data folder>[,<more>] to this command (sent once, then only changes), or pre-stage: node ${path.join(DIR, 'ccd.js')} delta stage <folder> --node ${SL.node}`);
        }
      }
    }
    if (SLN && !flags['no-path-check']) {
      // paths inside the NAS mirror (config nasMirror) must have been pushed first
      let mroot = ''; try { mroot = String(JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8')).nasMirror || '').replace(/\/+$/, ''); } catch {}
      const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const mirrored = mroot ? [...new Set(rest.join(' ').match(new RegExp(`${reEsc(mroot)}/[A-Z]/[^\\s"',;]*`, 'g')) || [])] : [];
      if (mirrored.length) {
        const chk = await sshOut(mirrored.map((m) => `[ -e ${q(m)} ] || echo ${q(m)}`).join('; '));
        const missing = chk.out.split('\n').filter(Boolean);
        if (missing.length) await fail(`not on the dNAS mirror yet: ${missing.join(', ')}\n  → back them up first: node ${path.join(DIR, 'ccd.js')} nas push <project/data folder>  (then re-run)`);
      }
    }
    if (unmapped.length && !flags['no-path-check']) {
      await fail(`these paths exist only on this PC, not on ${host}: ${[...new Set(unmapped)].join(', ')}\n`
        + `  → put them inside the --sync folder (translated automatically), use a path on ${host}, or pass --no-path-check`);
    }

    if (syncDir && !LOC) {
      if (!fs.existsSync(syncDir)) await fail(`--sync folder not found: ${syncDir}`);
      const ex = ['.git', '__pycache__', '.venv', 'venv', 'node_modules', 'wandb', 'checkpoints', ...fetchDirs,
        ...(flags['sync-exclude'] ? String(flags['sync-exclude']).split(',').map((s) => s.trim()).filter(Boolean) : [])];
      console.error(`[gpu] sync ${syncDir} → ${host}:${workdir}  (excluded: ${ex.join(', ')})`);
      const t0 = Date.now();
      // --sync-clean: drop files deleted locally (tar only adds/overwrites). Only for the default
      // ccd-sync/<name> folder, and fetched result folders are kept.
      if (flags['sync-clean']) {
        if (flags['remote-dir']) await fail('--sync-clean works only with the default ccd-sync folder (not with --remote-dir)');
        const keep = fetchDirs.map((d) => `! -name ${q(d)}`).join(' ');
        const c = await sshOut(`[ -d ${qd(workdir)} ] && find ${qd(workdir)} -mindepth 1 -maxdepth 1 ${keep} -exec rm -rf {} + ; true`);
        if (c.code !== 0) await fail('sync-clean failed');
      }
      const tar = spawn(TAR, ['-czf', '-', ...ex.flatMap((e) => ['--exclude', e]), '-C', syncDir, '.'], { stdio: ['ignore', 'pipe', 'inherit'] });
      const up = spawn('ssh', [...sshArgs, `mkdir -p ${qd(workdir)} && tar -xzf - --warning=no-unknown-keyword -C ${qd(workdir)}`], { stdio: ['pipe', 'inherit', 'inherit'] });
      const c = await pipeTo(tar, up);
      if (c.a !== 0 || c.b !== 0) await fail(`sync failed (tar ${c.a}, ssh ${c.b})`);
      console.error(`[gpu] sync done in ${Math.round((Date.now() - t0) / 1000)}s`);
    }

    // one argument = a shell command string; several = argv, each quoted so spaces survive
    const cmdline = rest.length === 1 ? rest[0] : rest.map((a) => (/^~?[\w@%+=:,./-]*$/.test(a) ? a : q(a))).join(' '); // leading ~ stays unquoted → expands remotely
    // Slurm: home folders are per node, so the job folder lives in the shared workdir
    const jdir = SLN ? `${tilde(rinfo.workdir || '~')}/.ccd-jobs/${g.id}` : `.ccd-jobs/${g.id}`;
    let pid;
    if (LOC) {
      const exports = [`export CCD_GPU_TICKET=${g.id} PYTHONUNBUFFERED=1`, ...Object.entries(SL.env || {}).map(([k, v]) => `export ${k}=${q(v)}`), ...(venv ? [`export VIRTUAL_ENV=${venv} PATH=${venv}/bin:$PATH`, `[ -z "$CUDA_HOME" ] && [ -x ${venv}/cuda/bin/nvcc ] && export CUDA_HOME=${venv}/cuda`, `[ -z "$CUDA_HOME" ] && [ -x ${venv}/bin/nvcc ] && export CUDA_HOME=${venv}`] : [])];
      const script = [`mkdir -p ${qd(workdir)} && cd ${qd(workdir)} || exit 1`, ...exports, `bash -c ${q(cmdline)}`].join('\n') + '\n';
      const memMB = g.ramMB || Number(SL.memMB) || 24000;
      const part = (SL.nodePartition && SL.nodePartition[SL.node]) || SL.partition || 'gpu';
      const srun = `srun -p ${part} -w ${SL.node} --gres=gpu:1 -c ${Number(SL.cpus) || 8} --mem=${memMB}M -J ${q('ccd-' + (g.label || g.id).replace(/[^\w.-]/g, '_').slice(0, 40))} bash -c "$(cat "$2/job.sh")"`;
      const start = await sshOut(`mkdir -p ${jdir} && printf %s ${q(script)} > ${jdir}/job.sh || exit 1; `
        + `nohup setsid bash -c ${q(`${srun} < /dev/null; echo $? > "$2/exit"`)} _ x "$HOME/${jdir}" > "$HOME/${jdir}/log" 2>&1 < /dev/null & echo $!`);
      pid = Number(start.out.split('\n').pop());
      if (start.code !== 0 || !pid) await fail(`could not start the job on ${host} (${start.out || 'ssh ' + start.code})`);
      console.error(`[gpu] srun on ${SL.node} (node-local disk, ${workdir}), log ${host}:~/${jdir}/log — keeps running if this connection drops; waits there while Slurm finds room`);
      await api('/api/gpu/heartbeat', { id: g.id, remoteJob: { pid, dir: jdir } }).catch(() => {});
    } else if (SL) {
      if (!SL.node) await fail(`Slurm node for ${g.gpu} unknown (re-probe pending) — try again`);
      const exports = [`export CCD_GPU_TICKET=${g.id} PYTHONUNBUFFERED=1`, ...Object.entries(SL.env || {}).map(([k, v]) => `export ${k}=${q(v)}`), ...(venv ? [`export VIRTUAL_ENV=${venv} PATH=${venv}/bin:$PATH`, `[ -z "$CUDA_HOME" ] && [ -x ${venv}/bin/nvcc ] && export CUDA_HOME=${venv}`] : [])];
      const script = ['#!/bin/bash', `cd ${qd(workdir)} || { echo 1 > ${q(jdir)}/exit; exit 1; }`, ...exports,
        // not a login shell: the cluster's /etc/profile.d points caches at folders we cannot write
        `bash -c ${q(cmdline)}`, `echo $? > ${q(jdir)}/exit`].join('\n') + '\n';
      const memMB = g.ramMB || Number(SL.memMB) || 24000;
      const sb = await sshOut(`mkdir -p ${q(jdir)} && printf %s ${q(script)} > ${q(jdir)}/job.sh && chmod +x ${q(jdir)}/job.sh && `
        + `sbatch --parsable -p ${SL.partition || 'gpu'} -w ${SL.node} --gres=gpu:1 -c ${Number(SL.cpus) || 8} --mem=${memMB}M -J ${q('ccd-' + (g.label || g.id).replace(/[^\w.-]/g, '_').slice(0, 40))} -o ${q(jdir)}/log ${q(jdir)}/job.sh`);
      pid = Number(String(sb.out).split(/[\n;]/).filter(Boolean).pop());
      if (sb.code !== 0 || !pid) await fail(`sbatch failed on ${host} (${sb.out || 'ssh ' + sb.code})`);
      console.error(`[gpu] Slurm job ${pid} on ${SL.node} (${host}) in ${workdir}, log ${jdir}/log — runs on even if this connection drops; cancel: Ctrl+C here or ssh … scancel ${pid}`);
      await api('/api/gpu/heartbeat', { id: g.id, remoteJob: { pid, dir: jdir, slurm: true } }).catch(() => {});
    } else {
    // `&` must apply to the job alone: a backgrounded `a && b && job &` list would keep the ssh
    // session open until the job ends and $! would be the subshell's pid
    const start = await sshOut(`mkdir -p ${jdir} && cd ${qd(workdir)} || exit 1; ${envPrefix}CUDA_VISIBLE_DEVICES=${g.gpuIndex} CCD_GPU_TICKET=${g.id} PYTHONUNBUFFERED=1 `
      + `nohup setsid bash -c 'bash -lc "$1"; echo $? > "$2/exit"' _ ${q(cmdline)} "$HOME/${jdir}" > "$HOME/${jdir}/log" 2>&1 < /dev/null & echo $!`);
    pid = Number(start.out.split('\n').pop());
    if (start.code !== 0 || !pid) await fail(`could not start the job on ${host} (${start.out || 'ssh ' + start.code})`);
    console.error(`[gpu] running on ${host} in ${workdir} (pid ${pid}, log ~/${jdir}/log) — keeps running if this connection drops`);
    await api('/api/gpu/heartbeat', { id: g.id, remoteJob: { pid, dir: jdir } }).catch(() => {});
    }
    // is the job still there: a Slurm job id in squeue, else a pid
    const aliveSh = SLN ? `squeue -h -j ${pid} 2>/dev/null | grep -q .` : `kill -0 ${pid} 2>/dev/null`;

    // Ctrl+C here stops the remote job (its whole process group), like a local run
    let stopping = false;
    process.on('SIGINT', () => { if (stopping) process.exit(130); stopping = true; console.error('[gpu] stopping remote job…'); sshOut(SLN ? `scancel ${pid}` : `kill -TERM -- -${pid} 2>/dev/null || kill -TERM ${pid}`); });

    let shown = 0;
    const follow = () => new Promise((res) => {
      const c = spawn('ssh', [...sshArgs, `J=${jdir}; tail -c +${shown + 1} -F "$J/log" 2>/dev/null & T=$!; `
        + `while [ ! -f "$J/exit" ] && ${aliveSh}; do sleep ${SLN ? 5 : 2}; done; for i in $(seq ${SLN ? 45 : 5}); do ls "$J" >/dev/null 2>&1; [ -f "$J/exit" ] && break; sleep 2; done; kill $T 2>/dev/null; `
        + `if [ -f "$J/exit" ]; then exit $(cat "$J/exit"); else exit 254; fi`], { stdio: ['ignore', 'pipe', 'inherit'] });
      c.stdout.on('data', (d) => { shown += d.length; process.stdout.write(d); });
      c.on('exit', (code) => res(code));
    });
    let code;
    for (;;) {
      code = await follow();
      if (code !== 255) break;
      // 255 = ssh itself failed (or the job really exited 255): ask the server
      const s = await sshOut(`ls ${jdir} >/dev/null 2>&1; if [ -f ${jdir}/exit ]; then cat ${jdir}/exit; elif ${aliveSh}; then echo run; else echo gone; fi`);
      if (s.code === 0 && /^-?\d+$/.test(s.out)) { code = Number(s.out); break; }
      if (s.code === 0 && s.out === 'gone') { code = 254; break; }
      console.error('[gpu] connection to the server lost — retrying in 15s (the job keeps running there)');
      await new Promise((r) => setTimeout(r, 15000));
    }
    // the log may live on NFS (Slurm), where tail -F can miss the last lines before it is stopped
    const tailLog = await sshOut(`ls ${jdir} >/dev/null 2>&1; tail -c +${shown + 1} ${jdir}/log 2>/dev/null`);
    if (tailLog.out) process.stdout.write(tailLog.out + '\n');
    if (code === 254) console.error('[gpu] the remote job disappeared without an exit code (killed?)');

    for (const d of fetchDirs) {
      const dest = syncDir || process.cwd();
      if (LOC) {
        console.error(`[gpu] fetch ${SL.node}:${workdir}/${d} → ${path.join(dest, d)}`);
        try { await DS.fetchFrom(srvObj, SL.node, `${workdir}/${d}`, dest); } catch (e) { console.error(`[gpu] ${e.message}`); }
        continue;
      }
      console.error(`[gpu] fetch ${host}:${workdir}/${d} → ${path.join(dest, d)}`);
      const down = spawn('ssh', [...sshArgs, `cd ${qd(workdir)} && tar -czf - ${q(d)}`], { stdio: ['ignore', 'pipe', 'inherit'] });
      const tar = spawn(TAR, ['-xzf', '-', '-C', dest], { stdio: ['pipe', 'inherit', 'inherit'] });
      const c = await pipeTo(down, tar);
      if (c.a !== 0 || c.b !== 0) console.error(`[gpu] fetch of ${d} failed (ssh ${c.a}, tar ${c.b})`);
    }
    clearInterval(hb);
    await release(code, `작업 종료 (exit ${code})`);
    process.exit(code);
  }

  return {
    commands: {
  // ---------- dNAS mirror: back up experiment code + data, so the Delta Slurm 5080s can run them ----------
  // ccd nas push <dir...>   local folder → <config nasMirror>/<Drive>/<path> (only new/changed files;
  //                         never deletes on the NAS). The Slurm queue server maps local drive letters to this mirror,
  //                         so `ccd gpu run --gpu delta -- python X:\...\train.py --data Y:\...` works once pushed.
  // ccd nas where <path>    → its path on the NAS/Delta     ccd nas ls [<local dir>]  → what is mirrored there
  async nas() {
    const sub = pos[1] || 'help';
    const cfgAll = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8'));
    const srv = (cfgAll.gpu?.servers || []).find((x) => x.id === 'delta');
    if (!srv) die('no "delta" server in config.json gpu.servers');
    const ROOT = (cfgAll.nasMirror || (srv.workdir ? `${srv.workdir}/mirror` : '') || die('set "nasMirror" (or the delta server\'s workdir) in config.json')).replace(/\/+$/, '');
    const sshArgs = ['-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=30', ...(srv.key ? ['-i', srv.key] : []), srv.ssh];
    const { spawn } = require('child_process');
    const fwd = (x) => path.resolve(String(x)).replace(/\\/g, '/');
    const remoteOf = (local) => { const f = fwd(local); const m = /^([A-Za-z]):\/?(.*)$/.exec(f); if (!m) die(`not a local drive path: ${local}`); return `${ROOT}/${m[1].toUpperCase()}/${m[2]}`.replace(/\/+$/, ''); };
    if (sub === 'where') return console.log(remoteOf(pos[2] || die('usage: ccd nas where <local path>')));
    const sshRun = (cmd, input) => new Promise((ok) => {
      const c = spawn('ssh', [...sshArgs, cmd], { stdio: [input ? 'pipe' : 'ignore', 'pipe', 'inherit'] });
      let o = ''; c.stdout.on('data', (d) => (o += d)); c.on('exit', (code) => ok({ code, out: o }));
      if (input) c.stdin.end(input);
    });
    const q = (x) => `'${String(x).replace(/'/g, `'\\''`)}'`;
    if (sub === 'ls') {
      const r = await sshRun(`cd ${q(pos[2] ? remoteOf(pos[2]) : ROOT)} 2>/dev/null && du -sh --apparent-size * 2>/dev/null | sort -h | tail -40`);
      return console.log(r.out.trim() || '(nothing mirrored there yet)');
    }
    if (sub !== 'push') die('usage: ccd nas push <dir...> [--dry] [--exclude a,b] [--quiet]  |  ccd nas where <path>  |  ccd nas ls [dir]');
    const dirs = pos.slice(2);
    if (!dirs.length) die('usage: ccd nas push <dir...>');
    // one push at a time on this PC (several sessions pushing at once saturated the NAS and the uplink)
    const LOCK = path.join(DIR, 'nas-push.lock');
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    if (!flags.dry) {
      for (let waited = 0; ; waited++) {
        let holder = null; try { holder = JSON.parse(fs.readFileSync(LOCK, 'utf8')); } catch {}
        if (!holder || !alive(holder.pid)) {
          try { fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, dirs, at: new Date().toISOString() }), { flag: holder ? 'w' : 'wx' }); break; } catch { continue; }
        }
        if (waited % 10 === 0) console.error(`[nas] another push is running (pid ${holder.pid}: ${(holder.dirs || []).join(', ')}) — waiting for it to finish`);
        await new Promise((r) => setTimeout(r, 30000));
      }
      process.on('exit', () => { try { const h = JSON.parse(fs.readFileSync(LOCK, 'utf8')); if (h.pid === process.pid) fs.unlinkSync(LOCK); } catch {} });
    }
    const EX = new Set(['.git', '__pycache__', '.venv', 'venv', 'node_modules', '.ipynb_checkpoints', '.pytest_cache', '.mypy_cache', 'wandb', '.cache',
      ...String(flags.exclude || '').split(',').map((x) => x.trim()).filter(Boolean)]);
    const TAR = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    const say = (...a) => { if (!flags.quiet) console.error(...a); };
    let total = 0, sent = 0;
    for (const d of dirs) {
      const local = path.resolve(d);
      if (!fs.existsSync(local) || !fs.statSync(local).isDirectory()) { console.error(`[nas] skip (not a folder): ${d}`); continue; }
      const remote = remoteOf(local);
      // local files (relative), skipping caches/VCS and temp/partial files
      const files = [];
      const walk = (abs, rel) => {
        let ents; try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
        for (const e of ents) {
          if (EX.has(e.name) || /\.(part|tmp|lock)$|^~\$/.test(e.name)) continue;
          const a = path.join(abs, e.name), r = rel ? `${rel}/${e.name}` : e.name;
          if (e.isDirectory()) walk(a, r);
          else if (e.isFile()) { try { const st = fs.statSync(a); files.push({ r, size: st.size, mtime: Math.floor(st.mtimeMs / 1000) }); } catch {} }
        }
      };
      walk(local, '');
      // what the mirror already has (size + mtime)
      const have = new Map();
      const ls = await sshRun(`[ -d ${q(remote)} ] && cd ${q(remote)} && find . -type f -printf '%s %T@ %P\\n'`);
      for (const l of ls.out.split('\n')) { const m = /^(\d+) (\d+)(?:\.\d+)? (.+)$/.exec(l); if (m) have.set(m[3], { size: Number(m[1]), mtime: Number(m[2]) }); }
      const todo = files.filter((f) => { const h = have.get(f.r); return !h || h.size !== f.size || f.mtime > h.mtime + 2; });
      const bytes = todo.reduce((a, f) => a + f.size, 0);
      total += files.length; sent += todo.length;
      say(`[nas] ${local} → ${remote}: ${files.length} files, ${todo.length} new/changed (${(bytes / 2 ** 30).toFixed(2)} GiB)`);
      if (!todo.length || flags.dry) continue;
      const lst = path.join(require('os').tmpdir(), `ccd-nas-${process.pid}.lst`);
      fs.writeFileSync(lst, todo.map((f) => f.r).join('\n') + '\n', 'utf8');
      const t0 = Date.now();
      const tar = spawn(TAR, ['-cf', '-', '-C', local, '-T', lst], { stdio: ['ignore', 'pipe', 'inherit'] });
      const up = spawn('ssh', [...sshArgs, `mkdir -p ${q(remote)} && tar -xf - -C ${q(remote)}`], { stdio: ['pipe', 'inherit', 'inherit'] });
      tar.stdout.pipe(up.stdin);
      const codes = await Promise.all([new Promise((r) => tar.on('exit', r)), new Promise((r) => up.on('exit', r))]);
      try { fs.unlinkSync(lst); } catch {}
      if (codes.some((c) => c !== 0)) { console.error(`[nas] upload of ${local} failed (tar ${codes[0]}, ssh ${codes[1]})`); process.exitCode = 1; continue; }
      say(`[nas] done in ${Math.round((Date.now() - t0) / 1000)}s (${(bytes / 2 ** 20 / Math.max(1, (Date.now() - t0) / 1000)).toFixed(1)} MB/s)`);
    }
    if (flags.quiet) console.log(`nas push: ${sent}/${total} files sent`);
  },
    },
    hooks: {
      // before `gpu run` asks the queue: keep Windows-only commands on this PC, --gpu auto needs --sync, and the
      // optional local-LLM-serving guard (config gpu.blockLocalLlm; CCD_ALLOW_LOCAL_LLM=1 overrides)
      async gpuRunCheck() {
      // Windows-only commands (.bat/.cmd, cmd, powershell, wsl, other .exe) cannot run on a Linux server:
      // --gpu auto then stays on this PC's GPUs
      const winOnly = /\.(bat|cmd|ps1)$/i.test(rest[0] || '') || /^(cmd|powershell|pwsh|wsl)(\.exe)?$/i.test(path.basename(rest[0] || ''))
        || (/\.exe$/i.test(rest[0] || '') && !/(^|[\\/])python(3)?\.exe$/i.test(rest[0]) && !/[\\/]envs[\\/][\w.-]+[\\/]Scripts[\\/]/i.test(rest[0]));
      if (flags.gpu === 'auto' && winOnly) {
        console.error(`[gpu] ${path.basename(rest[0])} is Windows-only → placing on this PC's GPU (for a Linux server run python/ns-* directly)`);
        flags.gpu = 'any';
      }
      if (/^gx10|^[a-z]\w*$/i.test(flags.gpu || '') && flags.gpu !== 'any' && flags.gpu !== 'auto' && winOnly) die(`${rest[0]} is Windows-only and cannot run on server ${flags.gpu}; run python / ns-* directly instead of a .bat`);
      if (flags.gpu === 'auto' && !flags.sync) die('--gpu auto may place the job on a server: add --sync <project folder> (and --fetch <results folder>)');
      // Optional guard: on a PC whose GPU also drives the desktop, LLM serving makes everything sluggish; with
      // gpu.blockLocalLlm such jobs must go to the LLM server (`ccd llm`) or to a remote server with --gpu <server>.
      const llmServe = /llama[-_.]?(server|cpp)|--backend[\s=]+(llamacpp|vllm|hf|transformers)\b|\bvllm\b|ollama\s+(serve|run)|text-generation-launcher|sglang/i.test(rest.join(' '));
      const remoteTarget = flags.gpu && !/^(any|auto|local(:\d+)?|\d+)$/i.test(flags.gpu);
      if (llmServe && !remoteTarget && ctx.config?.gpu?.blockLocalLlm === true && process.env.CCD_ALLOW_LOCAL_LLM !== '1')
        die('[gpu] local LLM serving (llama.cpp / vLLM / Ollama / HF generation) is not allowed on this PC (config gpu.blockLocalLlm).\n'
          + '  Use the configured LLM server (`ccd llm`, config llm.url) or run it on a GPU server: --gpu <server-id> (--sync ... --fetch ...).\n'
          + '  Only if the user explicitly asks for a local run: set CCD_ALLOW_LOCAL_LLM=1.');
      },
      // the grant is on a server, not this PC
      gpuRunRemote: (g, host) => runRemote(g, host, spawn),
    },
  };
};
