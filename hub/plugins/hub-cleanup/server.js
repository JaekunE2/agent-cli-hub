'use strict';
// Hub cleanup plugin: periodic scan for duplicates / old versions / caches / old files, a 2-stage per-drive trash
// (<drive>:\.hub-trash\stage1 → stage2 → purge) and approvals before anything irreversible.
//
//   config hubCleanup: { rules, protect, hard_protect, min_age_days, stage1_days, stage2_days, artifact_stores,
//                        cluster_bytes, python: "python", schedule: { weekday: 0-6, at: "03:00" } }
//   (rule format: see cleanup.py). Pinned outputs of this hub (artifacts-store.json) are always protected.
//
// A run = scan → "safe" items to stage1 → "confirm" items wait for an approval → stage1 older than stage1_days →
// stage2 → stage2 past stage2_days waits for a purge approval. Approvals are files in approvals/ (the telegram
// plugin turns them into buttons) and can also be given in the hub view. Main hub only; side instances only read.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

module.exports = function hubCleanupPlugin(api) {
  const C = api.config.hubCleanup || null;
  if (!C || !Array.isArray(C.rules)) return { enabled: false };
  const DATA = api.dataDir;
  const REPORTS = path.join(DATA, 'reports');
  const CFG = path.join(DATA, 'cleanup-config.json');
  const STATE = path.join(DATA, 'state.json');
  const APPROVALS = path.join(api.baseDir, 'approvals');
  const main = !api.instance || api.instance.main;
  fs.mkdirSync(DATA, { recursive: true });
  const workerCfg = { ...C, artifact_stores: C.artifact_stores || [path.join(api.baseDir, 'artifacts-store.json')] };
  delete workerCfg.schedule; delete workerCfg.python;
  try { fs.writeFileSync(CFG, JSON.stringify(workerCfg, null, 1)); } catch {}
  const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
  const state = readJson(STATE, { last: null, pending: [], history: [] });
  const save = () => { try { fs.writeFileSync(STATE, JSON.stringify(state, null, 1)); } catch {} };
  const note = (msg) => { state.history.unshift({ at: Date.now(), msg }); state.history = state.history.slice(0, 50); save(); api.log(msg); };
  const gb = (b) => `${(b / 1e9).toFixed(2)} GB`;

  function worker(...args) {
    return new Promise((ok) => {
      const c = spawn(C.python || 'python', ['-X', 'utf8', path.join(api.dir, 'cleanup.py'), ...args, '--config', CFG], { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
      let out = '', err = '';
      c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
      c.on('error', (e) => ok({ error: e.message }));
      c.on('exit', (code) => { try { ok(code === 0 ? JSON.parse(out.trim().split('\n').pop()) : { error: (err || out).trim().split('\n').pop() || `exit ${code}` }); } catch { ok({ error: 'bad worker output' }); } });
    });
  }
  function ask(kind, title, detail, payload) {
    const id = `${kind}-${crypto.randomBytes(4).toString('hex')}`;
    fs.mkdirSync(APPROVALS, { recursive: true });
    fs.writeFileSync(path.join(APPROVALS, `${id}.json`), JSON.stringify({ type: kind, title, detail, requester: 'hub-cleanup', status: 'pending', ttlMs: 3 * 864e5, createdAt: new Date().toISOString() }, null, 1));
    state.pending.push({ id, kind, title, payload, at: Date.now() });
    save();
  }
  let busy = null, statusCache = { at: 0, v: null };
  function runAll() {
    if (busy) return busy;
    busy = (async () => {
      const s = await worker('scan', '--reports', REPORTS);
      if (s.error) return note(`scan failed: ${s.error}`);
      state.last = { at: Date.now(), ...s }; save();
      if (s.safe.count) { const m = await worker('move', '--report', s.report, '--level', 'safe'); note(m.error ? `move failed: ${m.error}` : `moved ${m.moved} safe items (${gb(m.bytes)}) to stage1`); }
      if (s.confirm.count && !state.pending.some((x) => x.kind === 'cleanup-confirm')) {
        ask('cleanup-confirm', `Hub cleanup: move ${s.confirm.count} items (${gb(s.confirm.bytes)}) to the trash?`, `report: ${path.basename(s.report, '.json')}`, { report: s.report });
      }
      const a = await worker('age');
      if (a.error) return note(`age failed: ${a.error}`);
      for (const d of a.purgeDue || []) {
        if (state.pending.some((x) => x.kind === 'cleanup-purge' && x.payload.root === d.root)) continue;
        ask('cleanup-purge', `Hub cleanup: delete ${d.root} trash ${d.days.join(', ')} (${gb(d.bytes)}) for good?`, 'cannot be undone', d);
      }
    })().catch((e) => note(e.message)).finally(() => { busy = null; });
    return busy;
  }
  // approvals answered in Telegram (or here) → do it
  async function checkApprovals() {
    for (const p of [...state.pending]) {
      const a = readJson(path.join(APPROVALS, `${p.id}.json`), null);
      const st = a?.status || 'expired';
      if (st === 'pending') continue;
      state.pending = state.pending.filter((x) => x.id !== p.id); save();
      if (st !== 'approved') { note(`${p.kind}: ${st}`); continue; }
      if (p.kind === 'cleanup-confirm') { const m = await worker('move', '--report', p.payload.report, '--level', 'confirm'); note(m.error ? `move failed: ${m.error}` : `moved ${m.moved} confirmed items (${gb(m.bytes)}) to stage1`); }
      if (p.kind === 'cleanup-purge') { const r = await worker('purge', '--root', p.payload.root, '--days', p.payload.days.join(',')); note(r.error ? `purge failed: ${r.error}` : `purged ${r.root} ${r.purged.join(', ')}`); }
    }
  }
  let timer = null;
  function tick() {
    checkApprovals().catch(() => {});
    const sc = C.schedule; if (!sc) return;
    const now = new Date(), [hh, mm] = String(sc.at || '03:00').split(':').map(Number);
    const wd = sc.weekday ?? 0, today = now.toLocaleDateString('sv-SE');
    if (now.getDay() !== wd || now.getHours() * 60 + now.getMinutes() < hh * 60 + mm || state.lastScheduled === today) return;
    state.lastScheduled = today; save();
    runAll();
  }
  return {
    enabled: true,
    overview: () => ({ hubCleanup: { pending: state.pending.length } }),
    start() { if (main && api.instance?.watchdog !== false) { timer = setInterval(tick, 60e3); timer.unref?.(); } },
    stop() { if (timer) clearInterval(timer); },
    async handleApi(p, url, req, res, body, send) {
      if (!p.startsWith('/api/cleanup')) return false;
      if (p === '/api/cleanup') {
        const report = state.last ? readJson(state.last.report, []) : [];
        // trash sizes walk every file in the trash: reuse them for two minutes (a fresh scan refreshes on the next view)
        if (!statusCache.v || Date.now() - statusCache.at > 120e3 || url.searchParams.has('fresh')) statusCache = { at: Date.now(), v: await worker('status') };
        const st = statusCache.v;
        send(res, 200, { last: state.last, top: report.sort((a, b) => b.size - a.size).slice(0, 100), pending: state.pending.map(({ id, kind, title, at }) => ({ id, kind, title, at })),
          history: state.history.slice(0, 20), trash: st.trash || [], error: st.error || null, schedule: C.schedule || null, main });
        return true;
      }
      if (!main) { send(res, 403, { error: 'side hub instance: cleanup actions only on the main hub' }); return true; }
      if (p === '/api/cleanup/run' && req.method === 'POST') { runAll(); send(res, 200, { ok: true }); return true; }
      if (p === '/api/cleanup/approve' && req.method === 'POST') {
        const b = await body(req);
        const pend = state.pending.find((x) => x.id === b.id);
        if (!pend) { send(res, 404, { error: 'no such request' }); return true; }
        const f = path.join(APPROVALS, `${pend.id}.json`), a = readJson(f, {});
        fs.writeFileSync(f, JSON.stringify({ ...a, status: b.approve ? 'approved' : 'denied', decidedAt: new Date().toISOString(), decidedBy: 'hub' }, null, 1));
        await checkApprovals();
        send(res, 200, { ok: true });
        return true;
      }
      if (p === '/api/cleanup/restore' && req.method === 'POST') {
        const b = await body(req);
        if (!String(b.text || '').trim()) { send(res, 400, { error: 'text required' }); return true; }
        const r = await worker('restore', '--text', String(b.text));
        if (!r.error) note(`restored ${r.restored.length} item(s) matching "${b.text}"`);
        send(res, r.error ? 500 : 200, r);
        return true;
      }
      send(res, 404, { error: 'unknown cleanup api' });
      return true;
    },
  };
};
