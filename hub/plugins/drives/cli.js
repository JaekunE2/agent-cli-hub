'use strict';
// ccd commands of this plugin. ctx = the helpers ccd.js shares (see plugins.js).
const fs = require('fs');
const path = require('path');
module.exports = function cli(ctx) {
  const { api, die, flags, pos, DIR, BASE, PORT, token, usageDir, readTarget, overview, resolve, sessionIdOf, ago, termLabel, SELF_PID } = ctx;
  let { rest } = ctx;
  const { spawn } = require('child_process');
  return {
    commands: {
  async drive() {
    const sub = pos[1] || 'ls';
    const http = require('http');
    const q = (o) => new URLSearchParams(o).toString();
    // --drive nas → the team NAS (Z:) drive instead of the GX10 drive (config "drives")
    const call = (op, qs, body) => api(`/api/netdrive/${op}?${q({ ...(qs || {}), ...(flags.drive && flags.drive !== 'gx10' ? { d: flags.drive } : {}) })}`, body);
    const fail = (r) => { if (r?.error) die(`drive: ${r.error}`); return r; };
    // drive mentions from the dashboard look like drive:"folder/file.pdf" — accept them as paths everywhere
    for (let i = 2; i < pos.length; i++) pos[i] = String(pos[i]).replace(/^drive:/, '');
    for (const k of ['to', 'in']) if (typeof flags[k] === 'string') flags[k] = flags[k].replace(/^drive:/, '');
    const human = (n) => (n == null ? '' : n > 1e9 ? `${(n / 1e9).toFixed(1)}G` : n > 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.ceil(n / 1024)}K`);
    if (sub === 'ls' || sub === 'find') {
      const r = fail(sub === 'find' ? await call('search', { q: pos[2] || die('usage: ccd drive find <name> [--in dir]'), path: flags.in || '' }) : await call('list', { path: pos[2] || '' }));
      if (flags.json) return console.log(JSON.stringify(r.entries));
      return console.log(r.entries.map((e) => `${e.dir ? 'd' : '-'} ${human(e.size).padStart(6)}  ${new Date(e.mtime).toISOString().slice(0, 16).replace('T', ' ')}  ${e.path || e.name}${e.dir ? '/' : ''}`).join('\n') || '(empty)');
    }
    if (sub === 'info') { const r = fail(await call('info')); return console.log(`GX10 drive ${r.root}: free ${human(r.free)} of ${human(r.total)}`); }
    // workflow jobs on the drive (state lives in the drive server's <job>/.job.json)
    if (sub === 'jobs') { const r = fail(await call('jobs')); return console.log(r.jobs.map((j) => `${j.job.state}/${j.job.phase || ''}  ${j.path}  ${j.job.msg || ''}`).join('\n') || '(no jobs)'); }
    if (sub === 'job-status') {
      const [jp, st] = [pos[2], pos[3]];
      if (!jp || !st) die('usage: ccd drive job-status <drive folder> <\uC9C4\uD589\uC804|\uC9C4\uD589\uC911|\uC9C4\uD589\uC644\uB8CC|\uC624\uB958> [--msg text] [--rename new-folder-name]');
      const phase = st === '\uC9C4\uD589\uC644\uB8CC' || st === '\uC624\uB958' ? 'done' : st === '\uC9C4\uD589\uC804' ? '' : 'running'; // 진행완료 / 오류 / 진행전 (drive states, never translated)
      const r = fail(await call('job/status', {}, { path: jp, state: st, phase, ...(flags.msg ? { msg: String(flags.msg) } : {}), ...(flags.rename ? { rename: String(flags.rename) } : {}) }));
      return console.log(`${r.job.state} ${r.path}${r.job.msg ? '  — ' + r.job.msg : ''}`);
    }
    if (sub === 'mkdir') return console.log(fail(await call('mkdir', {}, { path: pos[2] || die('usage: ccd drive mkdir <path>') })).path);
    if (sub === 'mv') return console.log(fail(await call('move', {}, { from: pos[2], to: pos[3] || die('usage: ccd drive mv <from> <to|dir>') })).path);
    if (sub === 'rm') return console.log('→ trash:', fail(await call('delete', {}, { path: pos[2] || die('usage: ccd drive rm <path>') })).trashed);
    if (sub === 'stat') {
      // ccd drive stat <remote>  → size, time, and the same file's path on the GX10 (for --gpu gx10 jobs)
      const rel = (pos[2] || die('usage: ccd drive stat <remote>')).replace(/^\/+|\/+$/g, '');
      const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
      const e = fail(await call('list', { path: dir })).entries.find((x) => x.name === rel.slice(rel.lastIndexOf('/') + 1));
      if (!e) die(`drive: not found: ${rel}`);
      const root = fail(await call('info')).root;
      return console.log(`${e.dir ? 'folder' : 'file'}  ${human(e.size)}  ${new Date(e.mtime).toISOString().slice(0, 16).replace('T', ' ')}
drive:${rel}
GX10 path: ${root}/${rel}`);
    }
    if (sub === 'cat') {
      // ccd drive cat <remote> [--max 1M] [--force]   read a text file straight from the drive (nothing saved).
      // Binary files (PDF, images, archives …) are refused: use get, then open the local copy.
      const rel = pos[2] || die('usage: ccd drive cat <remote> [--max 1M] [--force]');
      const unit = { K: 1024, M: 1024 ** 2, G: 1024 ** 3 };
      const m = String(flags.max || '1M').toUpperCase().match(/^(\d+(?:\.\d+)?)([KMG]?)B?$/);
      const max = m ? Number(m[1]) * (unit[m[2]] || 1) : 1024 ** 2;
      const bin = /\.(pdf|png|jpe?g|gif|webp|bmp|tiff?|zip|7z|rar|gz|tgz|tar|xz|mp4|mov|avi|mkv|mp3|wav|m4a|exe|dll|so|bin|ply|splat|pt|pth|ckpt|safetensors|npy|npz|h5|hwp|hwpx|docx?|xlsx?|pptx?)$/i;
      if (bin.test(rel) && !flags.force) die(`drive: ${rel} is not a text file — download it: ccd drive get "drive:${rel}"  (prints the local path)`);
      await new Promise((ok) => {
        const rq = http.get(`${BASE}/api/netdrive/file?${q({ path: rel })}`, { headers: { 'x-token': token() } }, (r) => {
          if (r.statusCode !== 200) { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => die(`drive: ${r.statusCode} ${b}`)); return; }
          const total = Number(r.headers['content-length']) || 0;
          const chunks = []; let got = 0, first = true;
          r.on('data', (c) => {
            if (first) { first = false; if (!flags.force && c.subarray(0, 8000).includes(0)) { rq.destroy(); die(`drive: ${rel} looks binary — download it: ccd drive get "drive:${rel}"`); } }
            chunks.push(c); got += c.length;
            if (got >= max) { rq.destroy(); finish(true); }
          });
          r.on('end', () => finish(false));
          let done = false;
          function finish(cut) {
            if (done) return; done = true;
            process.stdout.write(Buffer.concat(chunks).subarray(0, max).toString('utf8'));
            if (cut) process.stderr.write(`
[ccd] stopped at ${human(max)} of ${human(total) || '?'} — --max to read more, or get for the whole file
`);
            ok();
          }
        });
        rq.on('error', (e) => { if (!rq.destroyed) die(e.message); });
      });
      return;
    }
    if (sub === 'get') {
      // ccd drive get <remote> [local file or dir]   (no local → into the dashboard drive-cache, path printed)
      const rel = pos[2] || die('usage: ccd drive get <remote> [local]');
      if (!pos[3]) return console.log(fail(await api('/api/drive-fetch', { path: rel })).local);
      let local = path.resolve(pos[3]);
      if (fs.existsSync(local) && fs.statSync(local).isDirectory()) local = path.join(local, path.basename(rel));
      await new Promise((ok) => http.get(`${BASE}/api/netdrive/file?${q({ path: rel })}`, { headers: { 'x-token': token() } }, (r) => {
        if (r.statusCode !== 200) { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => die(`drive: ${r.statusCode} ${b}`)); return; }
        const out = fs.createWriteStream(local); r.pipe(out); out.on('finish', ok);
      }).on('error', (e) => die(e.message)));
      return console.log(local);
    }
    if (sub === 'put') {
      // ccd drive put <local file...> [--to dir] [--overwrite]
      const files = pos.slice(2);
      if (!files.length) die('usage: ccd drive put <local file...> [--to <drive dir>] [--overwrite]');
      for (const f of files) {
        const abs = path.resolve(f);
        if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) die(`not a file: ${f}`);
        const rel = (flags.to ? String(flags.to).replace(/\/+$/, '') + '/' : '') + path.basename(abs);
        const r = await new Promise((ok) => {
          const rq = http.request(`${BASE}/api/netdrive/file?${q({ path: rel, ...(flags.overwrite ? { overwrite: 1 } : {}) })}`, { method: 'PUT', headers: { 'x-token': token(), 'content-length': fs.statSync(abs).size } }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { try { ok(JSON.parse(b)); } catch { ok({ error: `${res.statusCode} ${b}` }); } }); });
          rq.on('error', (e) => ok({ error: e.message }));
          fs.createReadStream(abs).pipe(rq);
        });
        if (r.error) die(`drive: ${f}: ${r.error}${r.error === 'exists' ? ' (use --overwrite)' : ''}`);
        console.log(`${r.path}  (${human(r.size)})`);
      }
      return;
    }
    die('drive subcommands: ls [dir] | find <name> [--in dir] | cat <remote> [--max 1M] | stat <remote> | get <remote> [local] | put <files...> [--to dir] [--overwrite] | mkdir <dir> | mv <from> <to> | rm <path> | info');
  },
    },
  };
};
