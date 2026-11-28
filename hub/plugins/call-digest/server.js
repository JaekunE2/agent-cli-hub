'use strict';
// Call digest plugin: phone call recordings → transcripts → one summary per day, shown in the hub.
//
// config callDigest (everything optional except a source; nothing here is committed — keep it in config.json):
//   source:      { type: "local", dir: "C:\\calls" }                 recordings in <dir>/<YYYY-MM-DD>/*.m4a|mp3|wav|ogg|aac
//              | { type: "drive", drive: "gx10", root: "Recordings" } the same layout on a drive server (drives plugin)
//                Each recording may have a sidecar <file>.json ({counterpart, number, callTime, durationSec, ...}).
//   transcriptsDir: "<dir>"   <dir>/<date>/<recording>.txt   (default: hub/data/plugins/call-digest/transcripts)
//   summariesDir:   "<dir>"   <dir>/<date>.md                (default: hub/data/plugins/call-digest/summaries)
//   logsDir:        "<dir>"   optional: <dir>/<date>.log is shown as the day's run log
//   stt:     { type: "faster-whisper", python: "python", model: "large-v3", device: "auto", language: "ko",
//              gpu: { mem: "6G", est: "20m" } }                         local STT (stt_faster_whisper.py), through the GPU queue
//          | { type: "command", command: ["ssh", "host", "python3 stt.py {date}"] }   any other backend; placeholders
//              {date} {audioDir} {outDir} {hub} {ccd}; it must leave <transcriptsDir>/<date>/<recording>.txt
//   summary: { via: "llm" | "gpt" | "none", prompt: "...", maxChars: 60000 }     summary with `ccd llm` / `ccd gpt`
//   output:  { drive: "gx10", dir: "Recordings/summaries" }                     also upload <date>.md to a drive folder
//   pipeline:{ command: ["python", "-X", "utf8", "C:\\path\\call_digest.py", "run", "--date", "{date}"] }
//              an existing pipeline that does all of the above itself: the hub only runs it and shows its files
//   schedule:{ at: "00:30", days: 1 }   daily run of yesterday (main hub only); without it, runs are manual
//
// Privacy: recordings, transcripts, summaries and sidecar data stay in the configured folders (outside the repo);
// the hub's API serves them only with the hub token and logs no transcript text.
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const AUDIO = /\.(m4a|mp3|wav|ogg|aac|amr|3gp|flac|opus)$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

module.exports = function callDigestPlugin(api) {
  const C = api.config.callDigest || null;
  if (!C || !C.source) return { enabled: false };
  const data = api.dataDir;
  const TR = path.resolve(C.transcriptsDir || path.join(data, 'transcripts'));
  const SUM = path.resolve(C.summariesDir || path.join(data, 'summaries'));
  const LOGS = C.logsDir ? path.resolve(C.logsDir) : path.join(data, 'logs');
  const STATE = path.join(data, 'state.json');
  const CCD = path.join(api.baseDir, 'ccd.js');
  const node = process.execPath;
  fs.mkdirSync(data, { recursive: true });
  const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
  const state = readJson(STATE, { runs: {} });
  const save = () => { try { fs.writeFileSync(STATE, JSON.stringify(state, null, 1)); } catch {} };
  const log = (date, msg) => { try { fs.mkdirSync(LOGS, { recursive: true }); fs.appendFileSync(path.join(LOGS, `${date}.log`), `${new Date().toISOString()} ${msg}\n`); } catch {} };

  // ---------- source: local folder or drive server ----------
  const driveUrl = (id) => {
    const cfg = api.config;
    const u = id === 'gx10' || !id ? cfg.driveUrl : cfg.drives?.[id]?.url;
    return u ? String(u).replace(/\/+$/, '') : null;
  };
  const getJson = (url) => new Promise((ok) => {
    http.get(url, { timeout: 15000 }, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => { try { ok(r.statusCode === 200 ? JSON.parse(b) : null); } catch { ok(null); } }); })
      .on('timeout', function () { this.destroy(); }).on('error', () => ok(null));
  });
  const src = C.source;
  const srcRoot = String(src.root || src.dir || '').replace(/[\\/]+$/, '');
  async function listDays() {
    if (src.type === 'drive') {
      const base = driveUrl(src.drive); if (!base) return [];
      const r = await getJson(`${base}/api/list?path=${encodeURIComponent(srcRoot)}`);
      return (r?.entries || []).filter((e) => e.dir && DATE.test(e.name)).map((e) => e.name);
    }
    try { return fs.readdirSync(srcRoot, { withFileTypes: true }).filter((e) => e.isDirectory() && DATE.test(e.name)).map((e) => e.name); } catch { return []; }
  }
  async function listRecordings(date) {
    let entries = [];
    if (src.type === 'drive') {
      const base = driveUrl(src.drive); if (!base) return [];
      entries = (await getJson(`${base}/api/list?path=${encodeURIComponent(`${srcRoot}/${date}`)}`))?.entries || [];
      entries = entries.map((e) => ({ name: e.name, size: e.size, mtime: e.mtime, dir: e.dir }));
    } else {
      try { entries = fs.readdirSync(path.join(srcRoot, date), { withFileTypes: true }).map((e) => { const st = fs.statSync(path.join(srcRoot, date, e.name)); return { name: e.name, size: st.size, mtime: st.mtimeMs, dir: e.isDirectory() }; }); } catch {}
    }
    const names = new Set(entries.map((e) => e.name));
    const out = [];
    for (const e of entries) {
      if (e.dir || !AUDIO.test(e.name)) continue;
      let meta = null;
      if (names.has(`${e.name}.json`)) {
        meta = src.type === 'drive' ? await getJson(`${driveUrl(src.drive)}/api/file?path=${encodeURIComponent(`${srcRoot}/${date}/${e.name}.json`)}`)
          : readJson(path.join(srcRoot, date, `${e.name}.json`), null);
      }
      const base = e.name.replace(AUDIO, '');
      const tr = [path.join(TR, date, `${e.name}.txt`), path.join(TR, date, `${base}.txt`)].find((f) => fs.existsSync(f)) || null;
      out.push({ name: e.name, size: e.size, mtime: e.mtime, transcript: tr ? path.basename(tr) : null,
        meta: meta ? { counterpart: meta.counterpart || meta.name || null, number: meta.number || null, time: meta.callTime || meta.time || null, durationSec: meta.durationSec ?? null, direction: meta.direction || null } : null });
    }
    return out.sort((a, b) => String(a.meta?.time || a.name).localeCompare(String(b.meta?.time || b.name)));
  }

  // ---------- steps ----------
  const running = new Map(); // date → promise
  const fill = (s, date) => String(s).replace(/\{date\}/g, date).replace(/\{hub\}/g, api.baseDir).replace(/\{ccd\}/g, CCD)
    .replace(/\{audioDir\}/g, src.type === 'local' ? path.join(srcRoot, date) : `${srcRoot}/${date}`).replace(/\{outDir\}/g, path.join(TR, date));
  function exec(date, argv, opts = {}) {
    return new Promise((ok) => {
      log(date, `run: ${path.basename(argv[0])} … (${argv.length - 1} args)`);
      const c = spawn(argv[0], argv.slice(1), { cwd: opts.cwd || api.baseDir, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8', ...(opts.env || {}) } });
      let out = '', err = '';
      c.stdout.on('data', (d) => { out = (out + d).slice(-200000); });
      c.stderr.on('data', (d) => { err = (err + d).slice(-20000); });
      c.on('error', (e) => ok({ code: 127, out: '', err: e.message }));
      c.on('exit', (code) => ok({ code: code ?? 1, out, err }));
    });
  }
  // local copies of a drive day's audio (only for local STT)
  async function fetchAudio(date, recs) {
    if (src.type !== 'drive') return path.join(srcRoot, date);
    const dir = path.join(data, 'audio', date);
    fs.mkdirSync(dir, { recursive: true });
    for (const r of recs) {
      const f = path.join(dir, r.name);
      if (fs.existsSync(f) && fs.statSync(f).size === r.size) continue;
      await new Promise((ok) => http.get(`${driveUrl(src.drive)}/api/file?path=${encodeURIComponent(`${srcRoot}/${date}/${r.name}`)}`, (res) => {
        if (res.statusCode !== 200) { res.resume(); return ok(); }
        const w = fs.createWriteStream(f + '.part'); res.pipe(w); w.on('finish', () => { fs.renameSync(f + '.part', f); ok(); }); w.on('error', () => ok());
      }).on('error', () => ok()));
    }
    return dir;
  }
  async function stt(date, recs) {
    const todo = recs.filter((r) => !r.transcript);
    if (!todo.length) return { ok: true, note: 'all transcribed' };
    const s = C.stt || { type: 'faster-whisper' };
    fs.mkdirSync(path.join(TR, date), { recursive: true });
    if (s.type === 'command') {
      const r = await exec(date, (s.command || []).map((x) => fill(x, date)));
      return { ok: r.code === 0, note: `stt command exit ${r.code}` };
    }
    // faster-whisper on this PC (through the GPU queue when gpu is set)
    const audioDir = await fetchAudio(date, todo);
    const py = [s.python || 'python', path.join(api.dir, 'stt_faster_whisper.py'), audioDir, path.join(TR, date), '--model', s.model || 'large-v3', '--device', s.device || 'auto', '--language', s.language || 'ko'];
    const argv = s.gpu ? [node, CCD, 'gpu', 'run', '--mem', s.gpu.mem || '6G', '--est', s.gpu.est || '20m', '--label', 'call-stt', '--', ...py] : py;
    const r = await exec(date, argv);
    return { ok: r.code === 0, note: `faster-whisper exit ${r.code}` };
  }
  async function summarize(date, recs) {
    const sm = C.summary || { via: 'llm' };
    if (sm.via === 'none') return { ok: true, note: 'no summary step' };
    const parts = [];
    for (const r of recs) {
      const f = [path.join(TR, date, `${r.name}.txt`), path.join(TR, date, `${r.name.replace(AUDIO, '')}.txt`)].find((x) => fs.existsSync(x));
      if (!f) continue;
      const head = [r.meta?.time, r.meta?.counterpart, r.meta?.durationSec ? `${Math.round(r.meta.durationSec / 60)} min` : null].filter(Boolean).join(' · ');
      parts.push(`### ${r.name}${head ? ` (${head})` : ''}\n${fs.readFileSync(f, 'utf8')}`);
    }
    if (!parts.length) return { ok: false, note: 'no transcripts to summarise' };
    const prompt = (sm.prompt || 'Below are transcripts of phone calls from one day. Write a concise Markdown digest in the language of the calls: '
      + '1) one line per call, 2) schedule items (date, time, place, people), 3) decisions, 4) to-dos with owner and due date. '
      + 'Quote briefly where it matters; mark anything uncertain with (?). Do not invent facts.') + `\n\nDate: ${date}\n\n` + parts.join('\n\n').slice(0, Number(sm.maxChars) || 60000);
    const tmp = path.join(data, `prompt-${date}.txt`);
    fs.writeFileSync(tmp, prompt);
    const argv = sm.via === 'gpt' ? [node, CCD, 'gpt', `Summarise the material in ${tmp} as instructed at its start.`, '--file', tmp] : [node, CCD, 'llm', '--file', tmp, 'Follow the instructions at the start of the file.'];
    const r = await exec(date, argv);
    try { fs.unlinkSync(tmp); } catch {}
    if (r.code !== 0 || !r.out.trim()) return { ok: false, note: `summary failed (exit ${r.code})` };
    fs.mkdirSync(SUM, { recursive: true });
    fs.writeFileSync(path.join(SUM, `${date}.md`), `# ${date}\n\n${r.out.trim()}\n`);
    return { ok: true, note: 'summary written' };
  }
  async function upload(date) {
    const o = C.output;
    const f = path.join(SUM, `${date}.md`);
    if (!o?.drive || !o.dir || !fs.existsSync(f)) return { ok: true, note: 'no upload' };
    const base = driveUrl(o.drive); if (!base) return { ok: false, note: 'output drive not configured' };
    const buf = fs.readFileSync(f);
    const ok = await new Promise((res) => {
      const rq = http.request(`${base}/api/file?path=${encodeURIComponent(`${String(o.dir).replace(/\/+$/, '')}/${date}.md`)}&overwrite=1`, { method: 'PUT', headers: { 'content-length': buf.length } }, (r) => { r.resume(); res(r.statusCode < 300); });
      rq.on('error', () => res(false)); rq.end(buf);
    });
    return { ok, note: ok ? 'uploaded' : 'upload failed' };
  }
  function run(date) {
    if (!DATE.test(date || '')) return Promise.resolve({ ok: false, error: 'date must be YYYY-MM-DD' });
    if (running.has(date)) return running.get(date);
    const st = state.runs[date] = { at: Date.now(), status: 'running', steps: [] };
    save();
    const p = (async () => {
      if (C.pipeline?.command) {
        const r = await exec(date, C.pipeline.command.map((x) => fill(x, date)), { cwd: C.pipeline.cwd });
        st.steps.push({ step: 'pipeline', ok: r.code === 0, note: `exit ${r.code}` });
        st.error = r.code === 0 ? null : (r.err || r.out).split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 300);
      } else {
        const recs = await listRecordings(date);
        if (!recs.length) st.steps.push({ step: 'source', ok: true, note: 'no recordings' });
        else for (const [name, fn] of [['stt', () => stt(date, recs)], ['summary', async () => summarize(date, await listRecordings(date))], ['upload', () => upload(date)]]) {
          const r = await fn().catch((e) => ({ ok: false, note: e.message }));
          st.steps.push({ step: name, ...r });
          if (!r.ok) { st.error = `${name}: ${r.note}`; break; }
        }
      }
      st.status = st.error ? 'error' : 'done'; st.endedAt = Date.now(); save();
      log(date, `status ${st.status}${st.error ? `: ${st.error}` : ''}`);
      return { ok: !st.error, ...st };
    })().finally(() => running.delete(date));
    running.set(date, p);
    return p;
  }

  // ---------- daily schedule (main hub only) ----------
  let timer = null;
  function tick() {
    const at = C.schedule?.at; if (!at) return;
    const now = new Date(), [hh, mm] = String(at).split(':').map(Number);
    const day = new Date(now.getTime() - 864e5 * (Number(C.schedule.days) || 1)).toISOString().slice(0, 10);
    if (now.getHours() * 60 + now.getMinutes() < hh * 60 + mm || state.lastScheduled === day) return;
    state.lastScheduled = day; save();
    run(day).catch(() => {});
  }

  // ---------- routes ----------
  const sendFile = (res, file, type) => { res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }); fs.createReadStream(file).pipe(res); };
  return {
    enabled: true,
    overview: () => ({ callDigest: true }),
    start() { if (api.instance.watchdog && C.schedule?.at) { timer = setInterval(tick, 60e3); timer.unref?.(); tick(); } },
    stop() { if (timer) clearInterval(timer); },
    async handleApi(p, url, req, res, body, send) {
      if (!p.startsWith('/api/calls')) return false;
      if (p === '/api/calls/days') {
        const days = new Set([...(await listDays())]);
        for (const f of (() => { try { return fs.readdirSync(SUM); } catch { return []; } })()) if (/^\d{4}-\d{2}-\d{2}\.md$/.test(f)) days.add(f.slice(0, 10));
        const list = [...days].sort().reverse().slice(0, Number(url.searchParams.get('n')) || 60)
          .map((d) => ({ date: d, summary: fs.existsSync(path.join(SUM, `${d}.md`)), run: state.runs[d] ? { status: running.has(d) ? 'running' : state.runs[d].status, at: state.runs[d].at, error: state.runs[d].error || null } : null }));
        send(res, 200, { days: list, schedule: C.schedule?.at || null, source: src.type, stt: C.pipeline?.command ? 'pipeline' : (C.stt?.type || 'faster-whisper') });
        return true;
      }
      const date = url.searchParams.get('date') || '';
      if (!DATE.test(date)) { send(res, 400, { error: 'date must be YYYY-MM-DD' }); return true; }
      if (p === '/api/calls/day') {
        const recs = await listRecordings(date);
        const sumFile = path.join(SUM, `${date}.md`);
        const logFile = path.join(LOGS, `${date}.log`);
        send(res, 200, { date, recordings: recs, summary: fs.existsSync(sumFile) ? fs.readFileSync(sumFile, 'utf8') : null,
          run: state.runs[date] ? { ...state.runs[date], status: running.has(date) ? 'running' : state.runs[date].status } : null,
          log: fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').slice(-40).join('\n') : null });
        return true;
      }
      if (p === '/api/calls/transcript') {
        const name = path.basename(String(url.searchParams.get('name') || ''));
        const f = [path.join(TR, date, name), path.join(TR, date, `${name}.txt`)].find((x) => /\.txt$/.test(x) && fs.existsSync(x));
        if (!f) { send(res, 404, { error: 'no transcript' }); return true; }
        sendFile(res, f, 'text/plain; charset=utf-8');
        return true;
      }
      // a recording uploaded from a phone (browser file picker or the hub's share target) → the source folder
      if (p === '/api/calls/upload' && req.method === 'POST') {
        if (api.instance && !api.instance.main) { req.resume(); send(res, 403, { error: 'side hub instance: upload on the main hub' }); return true; }
        const name = path.basename(String(url.searchParams.get('name') || '')).replace(/[<>:"|?*\x00-\x1f]/g, '_');
        if (!AUDIO.test(name) && !/\.json$/i.test(name)) { send(res, 400, { error: 'audio files only (m4a, mp3, wav, ...)' }); return true; }
        if (src.type === 'drive') {
          const base = driveUrl(src.drive); if (!base) { send(res, 400, { error: 'source drive not configured' }); return true; }
          const up = http.request(`${base}/api/file?path=${encodeURIComponent(`${srcRoot}/${date}/${name}`)}`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'x-drive': '1', ...(req.headers['content-length'] ? { 'content-length': req.headers['content-length'] } : {}) } }, (r) => {
            r.resume(); send(res, r.statusCode < 300 ? 200 : 502, r.statusCode < 300 ? { ok: true, saved: `${date}/${name}` } : { error: `drive ${r.statusCode}` });
          });
          up.on('error', (e) => send(res, 502, { error: e.message }));
          req.pipe(up);
          return true;
        }
        const dir = path.join(srcRoot, date);
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, name);
        const out = fs.createWriteStream(file + '.part');
        req.pipe(out);
        out.on('finish', () => { fs.renameSync(file + '.part', file); send(res, 200, { ok: true, saved: `${date}/${name}` }); });
        out.on('error', (e) => send(res, 500, { error: e.message }));
        return true;
      }
      if (p === '/api/calls/run' && req.method === 'POST') {
        if (api.instance && !api.instance.main) { send(res, 403, { error: 'side hub instance: run the digest from the main hub' }); return true; }
        run(date).catch(() => {});
        send(res, 200, { ok: true, started: date });
        return true;
      }
      send(res, 404, { error: 'unknown calls api' });
      return true;
    },
  };
};
