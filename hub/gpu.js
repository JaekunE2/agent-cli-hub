// GPU / compute-resource queue (cooperative leases).
// Sessions ask for a GPU (memory or exclusive), wait FIFO, get a lease when it fits,
// and release it when done. Leases die with their holder process. The queue NEVER
// kills anything: processes outside the queue just count as used memory.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const os = require('os');

module.exports = function gpuQueue({ dir, file = 'gpu-queue.json', config = {}, pidAlive, describePid, procTable, consoleTitleOf }) {
  const FILE = path.join(dir, file);
  const cfg = {
    pollMs: 5000,
    marginMB: 1024,          // keep this much free on top of a request
    idleMB: 3500,            // desktop/driver baseline; "exclusive" needs used <= this
    warmupMs: 180_000,       // a new lease's memory may not show in nvidia-smi yet
    heartbeatTimeoutMs: 180_000,
    servers: [],             // [{ id, name, ssh: "user@host" }] → probed over ssh (reserve/release only)
    ramMarginMB: 4096,       // keep this much system RAM free on top of a --ram request
    ramWarmupMs: 1_200_000,  // a job may take long to fill its cache; until measured, hold its full --ram
    // heat guard: a GPU this hot gets no NEW jobs (running ones are never touched); it takes new
    // work again once it has cooled by heatHysteresisC. tlimit = degrees left before the GPU slows itself.
    hotC: 85, hotTlimitC: 8, hotCpuC: 92, heatHysteresisC: 7,
    ...(config.gpu || {}),
  };
  const COMPUTE = new RegExp(cfg.computeProcs || 'python|julia|matlab|colmap|^kit\\.exe|isaac|blender|ffmpeg|ollama|llama|vllm|comfy|torch|train|unity|unreal|ue[45]editor', 'i');
  let st = { seq: 0, tickets: [] };
  try { st = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
  let gpus = [];        // [{ key, host, index, name, totalMB, usedMB, util, procs:[{pid,name}] }]
  let probeError = null;
  const save = () => { try { fs.writeFileSync(FILE + '.tmp', JSON.stringify(st, null, 1)); fs.renameSync(FILE + '.tmp', FILE); } catch {} };

  const run = (cmd, args, timeout = 8000) => new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true }, (err, out) => resolve(err ? { err: err.message } : { out: String(out) }));
  });
  const QUERY = ['--query-gpu=index,uuid,name,memory.total,memory.used,utilization.gpu', '--format=csv,noheader,nounits'];
  const THERMAL = ['--query-gpu=index,temperature.gpu,temperature.gpu.tlimit,clocks_event_reasons.hw_thermal_slowdown,clocks_event_reasons.sw_thermal_slowdown', '--format=csv,noheader,nounits'];
  const APPS = ['--query-compute-apps=pid,process_name,gpu_uuid', '--format=csv,noheader,nounits'];
  function parse(host, gOut, aOut) {
    const byUuid = new Map();
    const list = gOut.trim().split(/\r?\n/).filter(Boolean).map((l) => {
      const [index, uuid, name, total, used, util] = l.split(',').map((x) => x.trim());
      const g = { key: `${host}:${index}`, host, index: Number(index), name, totalMB: Number(total), usedMB: Number(used), util: Number(util) || 0, procs: [] };
      // Grace-class unified-memory boards (e.g. DGX Spark) share system memory: nvidia-smi says [N/A]
      if (!Number.isFinite(g.totalMB)) { g.unified = true; g.totalMB = 0; g.usedMB = 0; }
      byUuid.set(uuid, g);
      return g;
    });
    for (const l of (aOut || '').trim().split(/\r?\n/).filter(Boolean)) {
      const [pid, pname, uuid] = l.split(',').map((x) => x.trim());
      const g = byUuid.get(uuid);
      // Windows lists every desktop app that touches the GPU; show only likely compute jobs
      if (g && COMPUTE.test(path.basename(pname))) g.procs.push({ pid: Number(pid), name: path.basename(pname) });
    }
    return list;
  }
  // temperatures → g.tempC / g.tlimitC / g.cpuC / g.throttling, and the hysteresis state g.hot
  const heat = new Map(); // gpu key -> { hot, since, reason }
  function applyThermal(list, tOut, cpuC) {
    const byIdx = new Map();
    for (const l of String(tOut || '').trim().split(/\r?\n/).filter(Boolean)) {
      const [i, t, tl, hw, sw] = l.split(',').map((x) => x.trim());
      byIdx.set(Number(i), { tempC: Number(t), tlimitC: Number(tl), throttling: /^active/i.test(hw) || /^active/i.test(sw) });
    }
    const now = Date.now();
    for (const g of list) {
      const th = byIdx.get(g.index);
      if (th) { if (Number.isFinite(th.tempC)) g.tempC = th.tempC; if (Number.isFinite(th.tlimitC)) g.tlimitC = th.tlimitC; g.throttling = th.throttling; }
      if (Number.isFinite(cpuC)) g.cpuC = cpuC;
      const h = cfg.heatHysteresisC;
      const why = [];
      if (g.tempC >= cfg.hotC) why.push(`GPU ${g.tempC}°C ≥ ${cfg.hotC}`);
      if (g.tlimitC <= cfg.hotTlimitC) why.push(`감속 한계까지 ${g.tlimitC}°C`);
      if (g.cpuC >= cfg.hotCpuC) why.push(`CPU ${g.cpuC}°C ≥ ${cfg.hotCpuC}`);
      if (g.throttling) why.push('열 때문에 감속 중');
      const cool = !(g.tempC > cfg.hotC - h) && !(g.tlimitC < cfg.hotTlimitC + h) && !(g.cpuC > cfg.hotCpuC - h) && !g.throttling;
      const prev = heat.get(g.key) || { hot: false };
      let cur = prev;
      if (!prev.hot && why.length) cur = { hot: true, since: now, reason: why.join(', ') };
      else if (prev.hot && cool) cur = { hot: false };
      else if (prev.hot) cur = { ...prev, reason: why.join(', ') || prev.reason };
      if (cur.hot !== prev.hot) {
        st.heatLog = [...(st.heatLog || []), { at: now, gpu: g.key, hot: cur.hot, reason: cur.reason || `식음 (GPU ${g.tempC}°C${Number.isFinite(g.cpuC) ? `, CPU ${g.cpuC}°C` : ''})` }].slice(-50);
        save();
      }
      heat.set(g.key, cur);
      if (cur.hot) { g.hot = true; g.hotReason = cur.reason; g.hotSince = cur.since; }
    }
    return list;
  }
  const sshArgs = (s) => ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=6', '-o', 'StrictHostKeyChecking=accept-new',
    ...(s.port ? ['-p', String(s.port)] : []), ...(s.key ? ['-i', s.key] : []), s.ssh];
  const remote = new Map(); // server id -> { at, list }
  // Slurm cluster: one entry per GPU node of the partition. A Slurm GPU is handed
  // out whole (--gres=gpu:1), so a node counts as busy while any job holds its GPU — ours or
  // a teammate's — and as unusable while Slurm has it down/drained.
  async function probeSlurm(s) {
    const sl = s.slurm;
    const jobs = st.tickets.filter((t) => t.status === 'granted' && t.remoteJob && String(t.gpu || '').split(':')[0] === s.id);
    const jobCheck = jobs.map((t) => `ls ${t.remoteJob.dir} >/dev/null 2>&1; if [ -f ${t.remoteJob.dir}/exit ]; then echo "__JOB__ ${t.id} exit $(cat ${t.remoteJob.dir}/exit)"; elif ${t.remoteJob.slurmId ? `squeue -h -j ${t.remoteJob.slurmId} 2>/dev/null | grep -q .` : `kill -0 ${t.remoteJob.pid} 2>/dev/null`}; then echo "__JOB__ ${t.id} run"; else echo "__JOB__ ${t.id} gone"; fi`).join('; ');
    const part = sl.partition || 'gpu';
    const r = await run('ssh', [...sshArgs(s), `sinfo -N -h -p ${part} -o '%N|%G|%T'; echo __Q__; squeue -h -t R,CF -p ${part} -o '%i|%u|%N|%b|%j'${jobCheck ? `; ${jobCheck}` : ''}`], 15000);
    const [nOut, qOut = ''] = String(r.out || '').split('__Q__');
    for (const m of qOut.matchAll(/__JOB__ (\S+) (run|exit|gone)(?: (-?\d+))?/g)) {
      const t = jobs.find((x) => x.id === m[1]);
      if (t) { t.remoteJob.state = m[2]; if (m[3] !== undefined) t.remoteJob.exitCode = Number(m[3]); }
    }
    const holders = new Map(); // node -> [{ user, name }]
    for (const l of qOut.split(/\r?\n/)) {
      const [id, user, node, gres, name] = l.split('|');
      if (!name || !/gpu/i.test(gres || '')) continue;
      for (const n of String(node).split(',')) holders.set(n, [...(holders.get(n) || []), { pid: Number(id) || 0, name: `${user}:${name}` }]);
    }
    const nodes = nOut.trim().split(/\r?\n/).filter(Boolean).map((l) => l.split('|')).filter(([n]) => !sl.nodes || sl.nodes.includes(n));
    const list = r.out && nodes.length
      ? nodes.map(([node, gres, state], i) => {
          const type = (/gpu:([\w-]+):/.exec(gres || '') || [])[1] || 'gpu';
          const totalMB = Number(sl.gpuMB?.[type]) || 16000;
          const procs = holders.get(node) || [];
          const down = /down|drain|fail|maint|unk|reserved/i.test(state);
          return { key: `${s.id}:${i}`, host: s.id, index: i, node, name: `${type.toUpperCase()} @ ${node}`, totalMB, usedMB: procs.length ? totalMB : 0,
            util: procs.length ? 100 : 0, procs, server: s.name || s.id, slurmState: state, ...(down ? { error: `Slurm ${state}` } : {}) };
        })
      : [{ key: `${s.id}:?`, host: s.id, server: s.name || s.id, index: -1, name: '연결 안 됨', totalMB: 0, usedMB: 0, util: 0, procs: [],
          error: (r.err || '').split('\n').map((l) => l.trim()).filter(Boolean).pop() || 'no GPU nodes' }];
    remote.set(s.id, { at: Date.now(), list });
  }
  async function probeServer(s) {
    if (s.slurm) return probeSlurm(s);
    // detached remote jobs of this server: exit code file, else is the pid alive
    const jobs = st.tickets.filter((t) => t.status === 'granted' && t.remoteJob && String(t.gpu || '').split(':')[0] === s.id);
    const jobCheck = jobs.map((t) => `if [ -f ${t.remoteJob.dir}/exit ]; then echo "__JOB__ ${t.id} exit $(cat ${t.remoteJob.dir}/exit)"; elif kill -0 ${t.remoteJob.pid} 2>/dev/null; then echo "__JOB__ ${t.id} run"; else echo "__JOB__ ${t.id} gone"; fi`).join('; ');
    const r = await run('ssh', [...sshArgs(s), `nvidia-smi ${QUERY.join(' ')}; echo __MEM__; grep -E '^(MemTotal|MemAvailable):' /proc/meminfo; echo __THERM__; nvidia-smi ${THERMAL.join(' ')}; echo __CPU__ $(cat /sys/class/thermal/thermal_zone*/temp 2>/dev/null | sort -n | tail -1)${jobCheck ? `; ${jobCheck}` : ''}`], 15000);
    const [gOut, memOut = ''] = String(r.out || '').split('__MEM__');
    for (const m of memOut.matchAll(/__JOB__ (\S+) (run|exit|gone)(?: (-?\d+))?/g)) {
      const t = jobs.find((x) => x.id === m[1]);
      if (t) { t.remoteJob.state = m[2]; if (m[3] !== undefined) t.remoteJob.exitCode = Number(m[3]); }
    }
    // unified memory: the GPU's budget is system memory (MemTotal, used = MemTotal − MemAvailable)
    const kb = (k) => Number((new RegExp(`${k}:\\s+(\\d+)`).exec(memOut) || [])[1]);
    const unify = (x) => (x.unified && kb('MemTotal') ? { ...x, totalMB: Math.round(kb('MemTotal') / 1024), usedMB: Math.round((kb('MemTotal') - kb('MemAvailable')) / 1024) } : x);
    const [, thermOut = ''] = memOut.split('__THERM__');
    const cpuM = /__CPU__ (\d+)/.exec(memOut);
    const list = r.out && gOut.trim()
      ? applyThermal(parse(s.id, gOut).map((x) => ({ ...unify(x), server: s.name || s.id })), thermOut.split('__CPU__')[0], cpuM ? Math.round(Number(cpuM[1]) / 1000) : NaN)
      : [{ key: `${s.id}:?`, host: s.id, server: s.name || s.id, index: -1, name: '연결 안 됨', totalMB: 0, usedMB: 0, util: 0, procs: [],
          error: (r.err || '').split('\n').map((l) => l.trim()).filter(Boolean).pop() || 'unreachable' }];
    remote.set(s.id, { at: Date.now(), list });
  }
  async function probe() {
    const out = [];
    const [g, a, th] = await Promise.all([run('nvidia-smi', QUERY), run('nvidia-smi', APPS), run('nvidia-smi', THERMAL)]);
    if (g.out) out.push(...applyThermal(parse('local', g.out, a.out), th.out, NaN)); else probeError = `nvidia-smi: ${g.err}`;
    for (const s of cfg.servers) {
      const last = remote.get(s.id);
      // remote servers are polled less often (ssh round trips); an OFF server only for reachability
      const every = isEnabled(s.id) ? (cfg.remotePollMs || 30_000) : 120_000;
      if (!last || Date.now() - last.at > every) await probeServer(s);
      out.push(...remote.get(s.id).list);
    }
    if (g.out) probeError = null;
    gpus = out;
  }

  // resource switch: st.resources[key].enabled — key is a GPU ("local:0") or a server id
  function isEnabled(key) {
    const r = st.resources?.[key];
    if (r && typeof r.enabled === 'boolean') return r.enabled;
    const srv = cfg.servers.find((x) => x.id === key);
    return srv ? srv.enabled !== false : true;
  }
  const gpuEnabled = (g) => isEnabled(g.host === 'local' ? g.key : g.host) && (g.host === 'local' || isEnabled(g.key));
  // System RAM is a second axis: data-caching jobs (e.g. cache-images=cpu) are limited by host
  // RAM, not VRAM. Each granted --ram lease holds back what it has not allocated yet:
  // (only leases on this PC's GPUs: a remote job's --ram is that server's memory, not ours)
  // outstanding = ramMB − measured working set of its process tree (full ramMB until measured).
  const onLocalRam = (t) => t.status === 'granted' && t.ramMB && String(t.gpu || '').startsWith('local:');
  let ramUse = new Map(); // ticket id -> measured working set (MB) of its job's process tree
  let ramMeasuredAt = 0;
  const sysRam = () => ({ totalMB: Math.round(os.totalmem() / 2 ** 20), freeMB: Math.round(os.freemem() / 2 ** 20) });
  async function measureRam() {
    const leases = st.tickets.filter(onLocalRam);
    if (!leases.length || !procTable) { ramUse = new Map(); return; }
    if (Date.now() - ramMeasuredAt < 15_000) return;
    ramMeasuredAt = Date.now();
    const table = await procTable().catch(() => null);
    if (!table) return;
    const kids = new Map();
    for (const [pid, v] of table) { if (!kids.has(v.ppid)) kids.set(v.ppid, []); kids.get(v.ppid).push(pid); }
    const tree = (root) => { const out = [], q = [root]; while (q.length) { const x = q.pop(); if (!table.has(x) || out.includes(x)) continue; out.push(x); q.push(...(kids.get(x) || [])); } return out; };
    const byLease = new Map(leases.map((t) => [t.id, tree(t.childPid || (t.holderPids || [])[0] || t.holderPid)]));
    const all = [...new Set([...byLease.values()].flat())];
    if (!all.length) return;
    const r = await run('powershell', ['-NoProfile', '-Command', `Get-Process -Id ${all.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id) $($_.WorkingSet64)" }`], 15000);
    const ws = new Map(String(r.out || '').trim().split(/\r?\n/).filter(Boolean).map((l) => { const [a, b] = l.trim().split(/\s+/); return [Number(a), Number(b) / 2 ** 20]; }));
    ramUse = new Map([...byLease].map(([id, pids]) => [id, Math.round(pids.reduce((sum, pid) => sum + (ws.get(pid) || 0), 0))]));
  }
  function ramOutstanding(now) {
    return st.tickets.filter(onLocalRam).reduce((sum, t) => {
      const used = ramUse.get(t.id);
      if (used === undefined) return sum + (now - t.grantedAt < cfg.ramWarmupMs ? t.ramMB : 0);
      return sum + Math.max(0, t.ramMB - used);
    }, 0);
  }
  function ramFits(t, now) {
    if (!t.ramMB) return true;
    const { freeMB } = sysRam();
    return freeMB - ramOutstanding(now) - cfg.ramMarginMB >= t.ramMB;
  }
  const active = () => st.tickets.filter((t) => t.status === 'granted');
  const waiting = () => st.tickets.filter((t) => t.status === 'waiting').sort((a, b) => (b.priority || 0) - (a.priority || 0) || a.createdAt - b.createdAt);
  // Memory we must still hold back for leases whose job may not have allocated yet.
  function pendingReserve(g, now) {
    return active().filter((t) => t.gpu === g.key && !t.exclusive && now - t.grantedAt < cfg.warmupMs).reduce((s, t) => s + (t.memMB || 0), 0);
  }
  // "auto": this PC's GPUs or any server marked auto:true (e.g. a big-memory but slower box)
  const serverCfg = (host) => cfg.servers.find((x) => x.id === host);
  const targets = (t, g) => t.gpu === 'auto' ? g.host === 'local' || !!serverCfg(g.host)?.auto
    : !t.gpu || t.gpu === 'any' ? g.host === 'local' : t.gpu.endsWith(':*') ? g.host === t.gpu.slice(0, -2) : t.gpu === g.key;
  // Speed-aware choice for "auto" on a slower server (config speed, e.g. 0.35 = 35% of the local GPU):
  // take it now only if finishing there beats waiting for a local GPU. Unknown estimate or
  // unknown local start → take the free server now (work-conserving).
  function autoPrefersLocal(t, g, now) {
    if (t.gpu !== 'auto' || g.host === 'local') return false;
    const speed = Number(serverCfg(g.host)?.speed) || 1;
    const e = estMs(t);
    if (!e || speed >= 1) return false;
    const localGs = gpus.filter((x) => x.host === 'local' && x.index >= 0 && !x.error && gpuEnabled(x) && (t.memMB || 0) <= x.totalMB - cfg.marginMB);
    const starts = localGs.map((x) => shadowFor(t, x, now).at).filter(Number.isFinite);
    if (!starts.length) return false;
    return now + e / speed > Math.min(...starts) + e;
  }
  function fits(t, g, now) {
    if (g.index < 0 || g.error || !gpuEnabled(g)) return false;
    if (g.hot) return false; // heat guard: no new work until it cools (running jobs are left alone)
    if (g.host === 'local' && !ramFits(t, now)) return false; // --ram is about this PC's memory
    if (!targets(t, g)) return false;
    const leases = active().filter((x) => x.gpu === g.key);
    if (leases.some((x) => x.exclusive)) return false;
    if (serverCfg(g.host)?.slurm) return leases.length === 0 && !g.procs.length; // whole GPU per Slurm job
    if (t.exclusive) return leases.length === 0 && g.usedMB <= cfg.idleMB;
    // Honour declared peaks: a job past its warm-up may still grow to what it reserved, so the
    // GPU counts as occupied by whichever is larger — measured use or the sum of reservations.
    const reserved = leases.reduce((sum, x) => sum + (x.memMB || 0), 0);
    const occupied = Math.max(g.usedMB + pendingReserve(g, now), reserved);
    const free = g.totalMB - occupied - cfg.marginMB;
    return free >= (t.memMB || 0);
  }

  function reap(now) {
    let changed = false;
    for (const t of st.tickets) {
      if (t.status !== 'granted' && t.status !== 'waiting') continue;
      if (t.holderPids) t.holderPids = t.holderPids.filter((p) => pidAlive(p));
      // remote job started detached (nohup) on a server: if the local wrapper is gone the lease
      // follows the remote process, whose state the server probe reports (run / exit / gone)
      if (t.status === 'granted' && t.remoteJob) {
        if (t.holderPid && pidAlive(t.holderPid)) continue;
        if (!t.survived) { t.survived = true; t.heartbeat = false; changed = true; }
        const js = t.remoteJob.state;
        if (js === 'exit' || js === 'gone') {
          t.status = 'released'; t.endedAt = now; t.exitCode = t.remoteJob.exitCode ?? null;
          t.endReason = js === 'exit' ? `원격 작업 종료 (exit ${t.remoteJob.exitCode})` : '원격 작업이 사라짐';
          recordDuration(t); changed = true;
        }
        continue;
      }
      // the `ccd gpu run` wrapper died (e.g. its terminal closed on a dashboard restart) but the
      // detached job is still running → keep the lease, now tied to the job itself
      if (t.status === 'granted' && !t.holderPids && t.holderPid && !pidAlive(t.holderPid) && t.childPid && pidAlive(t.childPid)) {
        t.holderPids = [t.childPid]; t.heartbeat = false; t.survived = true; changed = true;
        continue;
      }
      const dead = t.holderPids ? t.holderPids.length === 0 : t.holderPid && !pidAlive(t.holderPid);
      // heartbeat timeout only for running jobs; a waiting request is covered by its holder pid
      const silent = t.status === 'granted' && t.heartbeat && now - (t.heartbeatAt || t.grantedAt || t.createdAt) > cfg.heartbeatTimeoutMs;
      if (dead || silent) {
        t.status = t.status === 'granted' ? 'released' : 'cancelled';
        t.endedAt = now; t.endReason = dead ? (t.adopted ? '작업 종료 (자동 감지)' : '요청한 프로세스 종료') : '하트비트 끊김';
        if (t.status === 'released') recordDuration(t);
        changed = true;
      }
    }
    // keep history short
    const done = st.tickets.filter((t) => !['granted', 'waiting'].includes(t.status));
    if (done.length > 60) { const drop = new Set(done.sort((a, b) => a.endedAt - b.endedAt).slice(0, done.length - 60)); st.tickets = st.tickets.filter((t) => !drop.has(t)); changed = true; }
    return changed;
  }
  // ---- run-time estimates: explicit --est, else learned from past runs of the same job family ----
  const family = (label) => String(label || '').toLowerCase().replace(/([_\-.]?(s|seed|run|it|ep)?\d+(e-?\d+)?)+$/i, '').replace(/[_\-.]+$/, '') || String(label || '');
  function learnedMs(label) {
    const xs = (st.durations || {})[family(label)] || [];
    if (xs.length < 1) return null;
    const sorted = [...xs].sort((a, b) => a - b);
    return sorted[Math.floor((sorted.length - 1) * 0.75)]; // 75th percentile: rather late than early
  }
  function recordDuration(t) {
    if (!t.grantedAt || !t.endedAt || t.adopted || (typeof t.exitCode === 'number' && t.exitCode !== 0)) return;
    const f = family(t.label), ms = t.endedAt - t.grantedAt;
    if (ms < 30_000) return; // crashes on start say nothing about run time
    st.durations = st.durations || {};
    st.durations[f] = [...(st.durations[f] || []), ms].slice(-10);
  }
  const estMs = (t) => (t.estMin ? t.estMin * 60_000 : learnedMs(t.label));
  // expected end of a running lease; an overrunning job is assumed to need a bit more (never "already done")
  function expectedEnd(t, now) {
    const e = estMs(t);
    if (!e) return Infinity;
    return Math.max(t.grantedAt + e, now + 5 * 60_000);
  }

  // EASY backfill. The head of the line (the first request that does not fit) gets a
  // reservation at the "shadow" time — when enough running leases on its GPU will have
  // ended. A later request may start now only if it fits now AND either finishes before
  // the shadow time, or still leaves the head its memory at the shadow time ("extra").
  // Without estimates nothing is backfilled, so the head is never delayed by guesswork.
  function shadowFor(head, g, now) {
    const H = head.exclusive ? g.totalMB - cfg.idleMB : (head.memMB || 0);
    const leases = active().filter((x) => x.gpu === g.key);
    const ends = leases.map((x) => ({ at: expectedEnd(x, now), mb: x.exclusive ? g.totalMB : (x.memMB || 0) })).sort((a, b) => a.at - b.at);
    const reserved = leases.reduce((sum, x) => sum + (x.exclusive ? g.totalMB : (x.memMB || 0)), 0);
    // memory used beyond all reservations belongs to jobs outside the queue (no end time known)
    // (reservations still in warm-up have not allocated yet, so they don't explain measured use)
    const floor = Math.max(0, g.usedMB - (reserved - pendingReserve(g, now)));
    let held = Math.max(reserved + floor, g.usedMB + pendingReserve(g, now));
    const cap = g.totalMB - cfg.marginMB;
    if (cap - held >= H) return { at: now, extra: cap - held - H };
    // that outside usage is gone once every auto-registered job has ended (if they all have estimates)
    const adopted = leases.filter((x) => x.adopted);
    const floorEnd = adopted.length && adopted.every((x) => expectedEnd(x, now) < Infinity) ? Math.max(...adopted.map((x) => expectedEnd(x, now))) : Infinity;
    let rest = reserved;
    for (const e of ends) {
      if (e.at === Infinity) break;
      rest -= e.mb;
      held = rest + (e.at >= floorEnd ? 0 : floor);
      if (cap - held >= H) return { at: e.at, extra: cap - held - H };
    }
    return { at: Infinity, extra: -Infinity }; // unknown → backfill only onto other GPUs
  }
  // One line per GPU. A waiting request stands in the line of every GPU it may run on
  // (several for --gpu auto); the first waiting request of each line is that line's head and
  // gets its own reservation (EASY per GPU), so a long wait on one GPU never holds up another
  // and a request pinned to a GPU is protected in that GPU's line.
  let lanes = new Map(); // gpu key -> { head, shadow, waiting: [ids] } (last schedule pass)
  const eligibleGpus = (t) => gpus.filter((x) => x.index >= 0 && !x.error && targets(t, x) && gpuEnabled(x));
  function schedule(now) {
    let changed = false;
    const L = new Map();
    const lane = (g) => { if (!L.has(g.key)) L.set(g.key, { gpu: g, head: null, shadow: null, waiting: [] }); return L.get(g.key); };
    for (const t of waiting()) {
      const cands = eligibleGpus(t);
      let done = false;
      for (const g of cands) {
        if (!fits(t, g, now) || autoPrefersLocal(t, g, now)) continue;
        const ln = L.get(g.key);
        if (!ln || !ln.head) { grant(t, g, now, false); done = true; break; } // nobody ahead in this line
        if (cfg.backfill === false) continue;
        const { head, shadow } = ln;
        const e = estMs(t);
        const endsInTime = e && now + e <= shadow.at;
        const leavesRoom = (t.memMB || 0) <= shadow.extra && !t.exclusive;
        // --ram is this PC's memory, so it only couples local GPUs. The head's RAM shortfall may be
        // held OUTSIDE the queue (no running queue job holds --ram): waiting for queue jobs can't free
        // it, so after ramStarveMs the jobs that fit now may run meanwhile.
        let ramOk = true, ramStarved = false;
        if (g.host === 'local' && head.ramMB) {
          const queueRam = active().filter(onLocalRam).reduce((s, x) => s + (x.ramMB || 0), 0);
          const externalRamBlock = shadow.at <= now && !ramFits({ ramMB: head.ramMB - queueRam }, now);
          if (externalRamBlock) head.ramStarvedSince = head.ramStarvedSince || now; else delete head.ramStarvedSince;
          ramStarved = externalRamBlock && now - head.ramStarvedSince >= (cfg.ramStarveMs ?? 15 * 60_000);
          ramOk = !t.ramMB || endsInTime || ramStarved || ramFits({ ramMB: head.ramMB + t.ramMB }, now);
        }
        if ((endsInTime || leavesRoom || ramStarved) && ramOk) {
          grant(t, g, now, true);
          if (!endsInTime) shadow.extra -= (t.memMB || 0);
          done = true; break;
        }
      }
      if (done) { changed = true; continue; }
      // still waiting: join every eligible line; head of each line that has none yet
      let best = Infinity;
      t.lanes = cands.map((g) => g.key);
      for (const g of cands) {
        const ln = lane(g);
        ln.waiting.push(t.id);
        if (!ln.head) { ln.head = t; ln.shadow = shadowFor(t, g, now); }
        if (ln.head === t && Number.isFinite(ln.shadow.at)) best = Math.min(best, ln.shadow.at);
      }
      if (Number.isFinite(best)) t.expectedStart = best; else delete t.expectedStart;
    }
    lanes = L;
    return changed;
  }
  // per-GPU lines for the API: who waits where, and when each line's head is expected to start
  function laneSummary() {
    const out = {};
    for (const g of gpus.filter((x) => x.index >= 0)) {
      const ln = lanes.get(g.key);
      const running = active().filter((x) => x.gpu === g.key);
      const ends = running.map((x) => expectedEnd(x, Date.now())).filter(Number.isFinite);
      out[g.key] = { waiting: ln ? ln.waiting : [], head: ln?.head?.id || null,
        headStart: ln && Number.isFinite(ln.shadow?.at) ? ln.shadow.at : null,
        running: running.length, freeBy: running.length ? (ends.length === running.length ? Math.max(...ends) : null) : Date.now() };
    }
    return out;
  }
  function grant(t, g, now, backfilled) {
    if (t.gpu !== g.key) t.asked = t.gpu; // what it asked for (auto, delta:* ...)
    t.status = 'granted'; t.gpu = g.key; t.gpuIndex = g.index; t.grantedAt = now;
    if (backfilled) t.backfilled = true;
    delete t.expectedStart; delete t.lanes;
  }
  // ---- adopt GPU jobs started outside the queue as "current users" ----
  // Each compute process on a local GPU that no lease covers is grouped by its launcher
  // (first non-compute ancestor), traced up to the Claude session / window that started it,
  // and registered as a granted lease. The lease ends when every process of the group has
  // exited, and the waiting line moves on. Nothing is ever killed.
  const cmdCache = new Map(); // pid -> command line
  const childOfLease = new Set(); // pids already known to run under a queued lease
  async function commandLines(pids) {
    const need = pids.filter((p) => !cmdCache.has(p));
    if (need.length) {
      const filter = need.map((p) => `ProcessId=${p}`).join(' OR ');
      const r = await run('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "${filter}" | Select-Object ProcessId,CommandLine,@{n='Start';e={$_.CreationDate.ToString('o')}} | ConvertTo-Json -Compress`], 15000);
      let arr = []; try { arr = [].concat(JSON.parse(r.out || '[]')); } catch {}
      for (const p of need) cmdCache.set(p, { cl: '', start: null });
      for (const x of arr) if (x) cmdCache.set(x.ProcessId, { cl: x.CommandLine || '', start: x.Start ? Date.parse(x.Start) : null });
    }
    return new Map(pids.map((p) => [p, cmdCache.get(p) || { cl: '', start: null }]));
  }
  function shortCmd(cl, name) {
    const toks = String(cl || '').match(/"[^"]*"|\S+/g) || [];
    const clean = toks.map((t) => t.replace(/^"|"$/g, ''));
    // drop the interpreter; keep script / entry point + a few args
    const i = clean.findIndex((t, k) => k > 0 && !/python(w)?\.exe$/i.test(t) && !/^-/.test(t));
    const main = i >= 0 ? path.basename(clean[i]) : name;
    return [main, ...clean.slice(i + 1, i + 5)].join(' ').slice(0, 90);
  }
  async function adopt(now) {
    if (!procTable || cfg.adopt === false) return false;
    const local = gpus.filter((g) => g.host === 'local' && g.procs?.length);
    if (!local.length) return false;
    const leases = st.tickets.filter((t) => t.status === 'granted');
    const covered = new Set();
    for (const t of leases) for (const p of [t.holderPid, t.childPid, ...(t.holderPids || [])]) if (p) covered.add(p);
    const ignored = new Set(st.ignoredPids || []);
    // only walk the process tree when an unknown compute process shows up
    const fresh = local.flatMap((g) => g.procs).filter((pr) => !covered.has(pr.pid) && !ignored.has(pr.pid) && !childOfLease.has(pr.pid));
    if (!fresh.length) return false;
    const table = await procTable().catch(() => null);
    if (!table) return false;
    const ancestors = (pid) => { const out = []; let cur = table.get(pid)?.ppid; for (let i = 0; i < 25 && cur && table.has(cur); i++) { out.push(cur); cur = table.get(cur).ppid; } return out; };
    const groups = new Map();
    for (const g of local) for (const pr of g.procs) {
      if (covered.has(pr.pid) || ignored.has(pr.pid) || !table.has(pr.pid)) continue;
      const anc = ancestors(pr.pid);
      if (anc.some((a) => covered.has(a))) { childOfLease.add(pr.pid); continue; } // child of a queued job (ccd gpu run)
      const launcher = anc.find((a) => !COMPUTE.test(table.get(a).name)) || pr.pid;
      const key = `${g.key}#${launcher}`;
      if (!groups.has(key)) groups.set(key, { gpu: g, launcher, pids: [], anc });
      groups.get(key).pids.push(pr.pid);
    }
    if (!groups.size) return false;
    const cls = await commandLines([...groups.values()].flatMap((x) => x.pids));
    let changed = false;
    for (const [key, grp] of groups) {
      const existing = st.tickets.find((t) => t.adopted && t.status === 'granted' && t.groupKey === key);
      if (existing) { existing.holderPids = [...new Set([...existing.holderPids, ...grp.pids])]; changed = true; continue; }
      const root = grp.pids.find((p) => !grp.pids.includes(table.get(p)?.ppid)) || grp.pids[0];
      const ownerPid = grp.anc.find((a) => describePid && describePid(a).session);
      const winTitle = consoleTitleOf && consoleTitleOf(grp.anc.concat(root));
      const requester = { ...(ownerPid ? describePid(ownerPid) : {}), title: winTitle || (ownerPid && describePid(ownerPid).title) || `외부 실행 (${table.get(grp.launcher)?.name || '?'})` };
      const started = Math.min(...grp.pids.map((p) => cls.get(p)?.start || now));
      st.tickets.push({
        id: `a${++st.seq}-${crypto.randomBytes(2).toString('hex')}`, status: 'granted', adopted: true, groupKey: key,
        createdAt: started, grantedAt: started, adoptedAt: now, gpu: grp.gpu.key, gpuIndex: grp.gpu.index, memMB: null, exclusive: false,
        label: shortCmd(cls.get(root).cl, table.get(root)?.name), command: (cls.get(root).cl || '').slice(0, 400),
        holderPids: grp.pids, requester,
      });
      changed = true;
    }
    return changed;
  }

  async function tick() {
    await probe().catch((e) => { probeError = e.message; });
    await measureRam().catch(() => {});
    const now = Date.now();
    const adopted = await adopt(now).catch(() => false);
    if (reap(now) | schedule(now) | adopted) save();
  }
  // Heartbeats live in memory only; after a reload/restart give every lease a fresh grace
  // period instead of judging it by the last value written to disk.
  for (const t of st.tickets) if (t.status === 'granted' || t.status === 'waiting') t.heartbeatAt = Date.now();
  if (!st.durationsSeeded) { for (const t of st.tickets) if (t.status === 'released') recordDuration(t); st.durationsSeeded = true; }
  let timer = null;
  function start() { if (!timer) { tick(); timer = setInterval(tick, cfg.pollMs); } }
  function stop() { if (timer) { clearInterval(timer); timer = null; } save(); }

  // place in its shortest line (1 = next on some GPU)
  function lanePosition(t) {
    const ps = (t.lanes || []).map((k) => (lanes.get(k)?.waiting || []).indexOf(t.id) + 1).filter((x) => x > 0);
    return ps.length ? Math.min(...ps) : waiting().indexOf(t) + 1;
  }
  // "Where would a job like this start?" — for every enabled GPU: can it hold the job at all, how
  // many wait in its line, and a rough start time. Used to pick a GPU before preparing the run.
  function plan(q) {
    const now = Date.now();
    const hyp = { memMB: q.exclusive ? 0 : parseMem(q.mem) || 0, ramMB: parseMem(q.ram) || null, exclusive: !!q.exclusive, estMin: parseEst(q.est), gpu: 'plan' };
    const e = estMs(hyp) || 0;
    return gpus.filter((g) => g.index >= 0 && gpuEnabled(g)).map((g) => {
      const srv = serverCfg(g.host);
      const cap = g.totalMB - (srv?.slurm ? 0 : cfg.idleMB);
      const ln = lanes.get(g.key);
      const ahead = ln ? ln.waiting.length : 0;
      let start = null, why = '';
      if (g.error) why = g.error;
      else if (!hyp.exclusive && hyp.memMB > cap) why = `메모리 부족 (최대 ~${Math.round(cap / 1024)}G)`;
      else if (g.hot) why = '과열로 새 작업 보류 중';
      else if (!ahead && fits({ ...hyp, gpu: g.key }, g, now)) start = now;
      else if (!ahead) { const sh = shadowFor(hyp, g, now); start = Number.isFinite(sh.at) ? sh.at : null; if (start == null) why = '실행 중 작업의 예상 종료 시간 모름'; }
      else {
        // behind the line: head's start + the estimates of everyone ahead (unknown → no estimate)
        const aheadT = ln.waiting.map((id) => st.tickets.find((x) => x.id === id)).filter(Boolean);
        const sum = aheadT.reduce((s2, x) => s2 + (estMs(x) || NaN), 0);
        start = ln && Number.isFinite(ln.shadow?.at) && Number.isFinite(sum) ? ln.shadow.at + sum : null; // one after another (no overlap assumed)
        if (start == null) why = '앞 작업의 예상 시간이 없어 시작 시각 계산 불가';
      }
      return { key: g.key, server: srv ? (srv.name || srv.id) : '이 PC', name: g.name, totalMB: g.totalMB, speed: Number(srv?.speed) || 1,
        ahead, start, end: start != null && e ? start + e / (Number(srv?.speed) || 1) : null, why,
        envs: srv ? Object.keys(srv.envs || {}) : ['로컬 conda 그대로'], note: srv?.note || '', how: srv ? `--gpu ${srv.id}` : '--gpu ' + g.index };
    }).sort((a, b) => (a.why ? 1 : 0) - (b.why ? 1 : 0) || (a.end ?? a.start ?? Infinity) - (b.end ?? b.start ?? Infinity));
  }
  function publicTicket(t) {
    const now2 = Date.now();
    const exp = t.status === 'granted' ? expectedEnd(t, now2) : null;
    return { ...t, expectedEnd: exp && Number.isFinite(exp) ? exp : null, estSource: t.estMin ? 'given' : (estMs(t) ? 'learned' : null), requester: t.requester, waitedMs: (t.grantedAt || Date.now()) - t.createdAt, position: t.status === 'waiting' ? lanePosition(t) : null };
  }
  // "90" / "90m" / "2h" / "1h30m" → minutes
  function parseEst(v) {
    if (v === undefined || v === null || v === '') return null;
    const s2 = String(v).trim().toLowerCase();
    if (/^\d+(\.\d+)?$/.test(s2)) return Math.round(Number(s2));
    const m = s2.match(/^(?:(\d+(?:\.\d+)?)h)?\s*(?:(\d+)m)?$/);
    return m && (m[1] || m[2]) ? Math.round((Number(m[1] || 0) * 60) + Number(m[2] || 0)) : null;
  }
  const parseMem = (v) => {
    if (v === undefined || v === null || v === '') return 0;
    const m = String(v).trim().match(/^([\d.]+)\s*([gm]?)i?b?$/i);
    if (!m) return NaN;
    return Math.round(Number(m[1]) * (m[2].toLowerCase() === 'm' ? 1 : 1024));
  };

  async function handle(p, url, req, body, send) {
    if (p === '/api/gpu') {
      const now = Date.now();
      return send(200, {
        servers: cfg.servers.map((x) => ({ id: x.id, name: x.name || x.id, enabled: isEnabled(x.id), reachable: remote.has(x.id) ? !remote.get(x.id).list[0].error : null, checkedAt: remote.get(x.id)?.at || null })),
        gpus: gpus.map((g) => ({ ...g, enabled: gpuEnabled(g), leasedMB: active().filter((t) => t.gpu === g.key).reduce((s, t) => s + (t.memMB || 0), 0), exclusive: active().some((t) => t.gpu === g.key && t.exclusive), pendingMB: pendingReserve(g, now) })),
        active: active().map(publicTicket), waiting: waiting().map(publicTicket),
        lanes: laneSummary(),
        heatLog: (st.heatLog || []).slice(-10),
        heatLimits: { hotC: cfg.hotC, hotTlimitC: cfg.hotTlimitC, hotCpuC: cfg.hotCpuC, hysteresisC: cfg.heatHysteresisC },
        history: st.tickets.filter((t) => !['granted', 'waiting'].includes(t.status)).sort((a, b) => b.endedAt - a.endedAt).slice(0, 12),
        ram: { ...sysRam(), reservedMB: active().filter(onLocalRam).reduce((x, t) => x + (t.ramMB || 0), 0), outstandingMB: ramOutstanding(now), marginMB: cfg.ramMarginMB },
        ramUse: Object.fromEntries(ramUse),
        error: probeError, config: { marginMB: cfg.marginMB, idleMB: cfg.idleMB },
      });
    }
    if (p === '/api/gpu/plan') return send(200, { now: Date.now(), gpus: plan(Object.fromEntries(url.searchParams)) });
    if (p === '/api/gpu/est' && req.method === 'POST') {
      const b = await body();
      const t = st.tickets.find((x) => x.id === b.id && (x.status === 'granted' || x.status === 'waiting'));
      if (!t) return send(404, { error: 'no such waiting/running ticket' });
      let min = null;
      const clock = String(b.until || '').match(/^(\d{1,2}):(\d{2})$/);
      if (clock) {
        const end = new Date(); end.setHours(Number(clock[1]), Number(clock[2]), 0, 0);
        if (end.getTime() < Date.now() - 60_000) end.setDate(end.getDate() + 1);
        min = Math.max(1, Math.round((end.getTime() - (t.grantedAt || Date.now())) / 60_000));
      } else min = parseEst(b.est);
      if (!min) return send(400, { error: 'est: 90m / 2h / 1h30m, or until: HH:MM' });
      t.estMin = min;
      schedule(Date.now()); save();
      return send(200, { ok: true, id: t.id, estMin: min });
    }
    if (p === '/api/gpu/toggle' && req.method === 'POST') {
      const b = await body();
      if (!b.key) return send(400, { error: 'key required' });
      st.resources = st.resources || {};
      st.resources[b.key] = { enabled: !!b.enabled, at: Date.now() };
      if (b.enabled && cfg.servers.some((x) => x.id === b.key)) remote.delete(b.key); // re-probe now
      schedule(Date.now()); save();
      return send(200, { ok: true, key: b.key, enabled: !!b.enabled });
    }
    if (p === '/api/gpu/remote') {
      const s = cfg.servers.find((x) => x.id === url.searchParams.get('host'));
      const node = s?.slurm ? gpus.find((g) => g.key === url.searchParams.get('key'))?.node || null : null;
      return s ? send(200, { id: s.id, ssh: s.ssh, port: s.port || null, key: s.key || null, workdir: s.workdir || null, python: s.python || null, envs: s.envs || {}, pathMap: s.pathMap || {},
        ...(s.slurm ? { slurm: { ...s.slurm, node } } : {}) }) : send(404, { error: 'no such server' });
    }
    if (p === '/api/gpu/ticket') {
      const t = st.tickets.find((x) => x.id === url.searchParams.get('id'));
      if (t && t.status === 'waiting') t.heartbeatAt = Date.now(); // a polling waiter is alive
      return t ? send(200, publicTicket(t)) : send(404, { error: 'no such ticket' });
    }
    if (p === '/api/gpu/request' && req.method === 'POST') {
      const b = await body();
      const memMB = b.exclusive ? 0 : parseMem(b.mem);
      if (Number.isNaN(memMB)) return send(400, { error: 'mem 형식: 20G, 8000M' });
      const ramMB = parseMem(b.ram);
      if (Number.isNaN(ramMB)) return send(400, { error: 'ram 형식: 40G, 8000M' });
      if (ramMB && ramMB > sysRam().totalMB - cfg.ramMarginMB) return send(400, { error: `--ram ${ramMB}MB는 시스템 RAM(${sysRam().totalMB}MB)보다 큽니다` });
      // "0" → local:0 · "spp" → any GPU on server spp · "spp:1" → that GPU · "auto" → local or auto servers · default: any local GPU
      const gpuKey = !b.gpu || b.gpu === 'any' ? 'any' : b.gpu === 'auto' ? 'auto' : /^\d+$/.test(String(b.gpu)) ? `local:${b.gpu}` : String(b.gpu).includes(':') ? String(b.gpu) : `${b.gpu}:*`;
      // the request must fit at least one GPU it may run on (else it would wait forever)
      const total = Math.max(0, ...gpus.filter((g) => g.index >= 0 && targets({ gpu: gpuKey }, g)).map((g) => g.totalMB || 0));
      const slurmOnly = gpus.filter((g) => g.index >= 0 && targets({ gpu: gpuKey }, g)).every((g) => serverCfg(g.host)?.slurm);
      if (!b.exclusive && total && memMB > total - (slurmOnly ? 0 : cfg.idleMB)) {
        const big = cfg.servers.filter((s) => s.auto).map((s) => s.id);
        return send(400, { error: `요청 ${memMB}MB는 대상 GPU(최대 ${total}MB)에서 기본 사용량을 뺀 것보다 큽니다${big.length && gpuKey === 'any' ? ` — 대용량 서버를 쓰려면 --gpu ${big[0]} 또는 --gpu auto --sync <폴더>` : ''}` });
      }
      const holderPid = Number(b.holderPid) || null;
      const t = {
        id: `g${++st.seq}-${crypto.randomBytes(2).toString('hex')}`, status: 'waiting', createdAt: Date.now(),
        gpu: gpuKey,
        memMB, ramMB: ramMB || null, exclusive: !!b.exclusive, label: String(b.label || '').slice(0, 80), estMin: parseEst(b.estMin ?? b.est),
        holderPid, heartbeat: !!b.heartbeat, heartbeatAt: Date.now(),
        requester: (() => {
          const pid = Number(b.sessionPid) || holderPid;
          const d = describePid ? describePid(pid) : {};
          return { ...d, title: (consoleTitleOf && consoleTitleOf([pid])) || d.title, cwd: b.cwd || null };
        })(),
      };
      st.tickets.push(t);
      schedule(Date.now()); save();
      return send(200, publicTicket(t));
    }
    if (p === '/api/gpu/heartbeat' && req.method === 'POST') {
      const b = await body();
      const t = st.tickets.find((x) => x.id === b.id);
      if (!t) return send(404, { error: 'no such ticket' });
      t.heartbeatAt = Date.now();
      if (b.childPid) t.childPid = b.childPid;
      if (b.log) t.log = b.log;
      if (b.detached !== undefined) t.detachedJob = !!b.detached;
      if (b.remoteJob && /^\d+$/.test(String(b.remoteJob.pid)) && /^[\w./-]+$/.test(String(b.remoteJob.dir))) {
        t.remoteJob = { pid: Number(b.remoteJob.pid), dir: String(b.remoteJob.dir), state: 'run', ...(b.remoteJob.slurm ? { slurmId: Number(b.remoteJob.pid) } : {}) };
      }
      return send(200, { status: t.status });
    }
    if (p === '/api/gpu/release' && req.method === 'POST') {
      const b = await body();
      const t = st.tickets.find((x) => x.id === b.id);
      if (!t) return send(404, { error: 'no such ticket' });
      if (t.status === 'granted' || t.status === 'waiting') {
        t.status = t.status === 'granted' ? 'released' : 'cancelled';
        t.endedAt = Date.now(); t.endReason = b.reason || (b.byUser ? '대시보드에서 해제' : t.status === 'cancelled' ? '취소됨' : '작업 종료');
        if (typeof b.exitCode === 'number') t.exitCode = b.exitCode;
        if (t.status === 'released' && !b.byUser) recordDuration(t);
        // releasing an auto-registered job only un-registers it (it keeps running); don't re-adopt it
        if (t.adopted) st.ignoredPids = [...(st.ignoredPids || []), ...(t.holderPids || [])].slice(-200);
        schedule(Date.now()); save();
      }
      return send(200, { ok: true, status: t.status });
    }
    if (p === '/api/gpu/priority' && req.method === 'POST') {
      const b = await body();
      const t = st.tickets.find((x) => x.id === b.id && x.status === 'waiting');
      if (!t) return send(404, { error: 'no such waiting ticket' });
      t.priority = Math.max(0, ...st.tickets.map((x) => x.priority || 0)) + 1; // to the front
      schedule(Date.now()); save();
      return send(200, { ok: true });
    }
    return false;
  }

  return { start, stop, handle, snapshot: () => ({ gpus, active: active(), waiting: waiting() }) };
};
