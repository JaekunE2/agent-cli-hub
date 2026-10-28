// Per-session outputs ("artifacts"): files a session produced or mentioned (videos, PDFs,
// images, docs, data), found in its transcript or pinned by hand, served back for viewing.
// Only files listed for a session can be served (no arbitrary file access), and HTML/SVG are
// sandboxed so they cannot reach the dashboard origin (its token lives in localStorage).
const fs = require('fs');
const path = require('path');

const EXT = 'mp4|webm|mov|mkv|avi|m4v|mp3|wav|m4a|pdf|png|jpe?g|gif|webp|bmp|svg|html?|md|txt|log|csv|tsv|json|jsonl|ya?ml|tex|bib|py|ipynb|ply|glb|gltf|obj|stl|exr|docx|xlsx|pptx|hwp|zip|7z';
const KIND = [
  [/\.(mp4|webm|mov|mkv|avi|m4v)$/i, 'video'], [/\.(mp3|wav|m4a)$/i, 'audio'], [/\.pdf$/i, 'pdf'],
  [/\.(png|jpe?g|gif|webp|bmp|svg)$/i, 'image'], [/\.html?$/i, 'html'], [/\.md$/i, 'markdown'],
  [/\.(txt|log|csv|tsv|json|jsonl|ya?ml|tex|bib|py)$/i, 'text'],
];
const MIME = {
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska', avi: 'video/x-msvideo',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
  md: 'text/plain; charset=utf-8', txt: 'text/plain; charset=utf-8', log: 'text/plain; charset=utf-8', csv: 'text/plain; charset=utf-8',
  tsv: 'text/plain; charset=utf-8', json: 'application/json; charset=utf-8', jsonl: 'text/plain; charset=utf-8', yaml: 'text/plain; charset=utf-8',
  yml: 'text/plain; charset=utf-8', tex: 'text/plain; charset=utf-8', bib: 'text/plain; charset=utf-8', py: 'text/plain; charset=utf-8',
};
const kindOf = (p) => (KIND.find(([re]) => re.test(p)) || [null, 'file'])[1];

// ---- Office preview: PowerPoint/Word → PDF (LibreOffice headless, own profile so a user's open
// LibreOffice/PowerPoint is never touched), cached by path+size+mtime in preview-cache/ (G:) ----
const OFFICE = /^(pptx?|ppsx?|odp|docx?|odt|rtf)$/i;
const PREVIEW_DIR = path.join(__dirname, 'preview-cache');
const SOFFICE = ['C:\\Program Files\\LibreOffice\\program\\soffice.exe', 'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe'].find((p) => fs.existsSync(p)) || null;
let convertChain = Promise.resolve(); // one conversion at a time
function officeToPdf(file) {
  const st = fs.statSync(file);
  const key = require('crypto').createHash('sha1').update(`${file}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 20);
  const out = path.join(PREVIEW_DIR, `${key}.pdf`);
  if (fs.existsSync(out)) return Promise.resolve(out);
  if (!SOFFICE) return Promise.reject(new Error('LibreOffice가 설치돼 있지 않아 미리보기를 만들 수 없습니다'));
  const job = convertChain.then(() => new Promise((resolve, reject) => {
    if (fs.existsSync(out)) return resolve(out);
    const work = path.join(PREVIEW_DIR, `job-${key}`);
    fs.mkdirSync(work, { recursive: true });
    const src = path.join(work, `in${path.extname(file)}`); // ASCII name: soffice and odd paths don't mix
    fs.copyFileSync(file, src);
    const profile = 'file:///' + path.join(PREVIEW_DIR, 'lo-profile').replace(/\\/g, '/');
    require('child_process').execFile(SOFFICE, [`-env:UserInstallation=${profile}`, '--headless', '--norestore', '--convert-to', 'pdf', '--outdir', work, src],
      { timeout: 180000, windowsHide: true }, (err) => {
        const pdf = path.join(work, 'in.pdf');
        try {
          if (err || !fs.existsSync(pdf)) throw err || new Error('변환 결과가 없습니다');
          fs.renameSync(pdf, out);
          resolve(out);
        } catch (e) { reject(e); } finally { fs.rmSync(work, { recursive: true, force: true }); }
      });
  }));
  convertChain = job.catch(() => {});
  return job;
}

function serve(req, res, file) {
  // ?preview=pdf on an Office file → its PDF rendering (shown in the outputs viewer)
  if (/[?&]preview=pdf(&|$)/.test(req.url || '') && OFFICE.test(path.extname(file).slice(1))) {
    fs.mkdirSync(PREVIEW_DIR, { recursive: true });
    return officeToPdf(file).then((pdf) => {
      res.writeHead(200, { 'content-type': 'application/pdf', 'cache-control': 'no-store', 'content-length': fs.statSync(pdf).size,
        'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(path.basename(file, path.extname(file)) + '.pdf')}` });
      fs.createReadStream(pdf).pipe(res);
    }).catch((e) => { res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }); res.end(`미리보기 변환 실패: ${e.message}`); });
  }
  let st; try { st = fs.statSync(file); } catch { res.writeHead(404); return res.end('not found'); }
  const ext = path.extname(file).slice(1).toLowerCase();
  const headers = { 'content-type': MIME[ext] || 'application/octet-stream', 'accept-ranges': 'bytes', 'cache-control': 'no-store',
    // ?dl=1 → attachment: browsers and app WebViews save it instead of showing it
    'content-disposition': `${MIME[ext] && !/[?&]dl=1(&|$)/.test(req.url || '') ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(path.basename(file))}` };
  // active content gets an opaque origin: it cannot read the dashboard's storage or call its API
  if (/^(html?|svg)$/.test(ext)) headers['content-security-policy'] = 'sandbox allow-scripts allow-popups';
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : st.size - Number(m[2]);
    let end = m[1] && m[2] ? Number(m[2]) : st.size - 1;
    if (start < 0) start = 0;
    if (start >= st.size || end < start) { res.writeHead(416, { 'content-range': `bytes */${st.size}` }); return res.end(); }
    end = Math.min(end, st.size - 1);
    res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${st.size}`, 'content-length': end - start + 1 });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'content-length': st.size });
  fs.createReadStream(file).pipe(res);
}

module.exports = function artifacts({ dir, index }) {
  const STORE = path.join(dir, 'artifacts-store.json');
  let store = {};
  try { store = JSON.parse(fs.readFileSync(STORE, 'utf8')); } catch {}
  const save = () => { try { fs.writeFileSync(STORE + '.tmp', JSON.stringify(store, null, 1)); fs.renameSync(STORE + '.tmp', STORE); } catch {} };
  const entry = (sid) => (store[sid] = store[sid] || { pinned: [], hidden: [] });

  // absolute Windows paths (also inside backticks, which may contain spaces), git-bash /g/... paths,
  // and relative paths resolved against the session's working folder
  const reAbs = new RegExp(`(?:[A-Za-z]:[\\\\/])[^\\s"'\`<>|*?()\\[\\]{}]+?\\.(?:${EXT})\\b`, 'gi');
  const reTick = new RegExp(`\`([A-Za-z]:[\\\\/][^\`\\n]+?\\.(?:${EXT}))\``, 'gi');
  const reBash = new RegExp(`(?:^|[\\s'"\`(])(/[a-z]/[^\\s"'\`<>|*?()]+?\\.(?:${EXT}))\\b`, 'gi');
  const reRel = new RegExp(`(?:^|[\\s'"\`(])((?:[\\w.\\-]+[\\\\/])+[\\w.\\-]+\\.(?:${EXT}))\\b`, 'gi');
  function candidates(text, cwd) {
    const out = new Set();
    for (const m of text.matchAll(reTick)) out.add(m[1]);
    for (const m of text.matchAll(reAbs)) out.add(m[0]);
    for (const m of text.matchAll(reBash)) out.add(m[1].replace(/^\/([a-z])\//i, (x, d) => `${d.toUpperCase()}:\\`));
    if (cwd) for (const m of text.matchAll(reRel)) if (!/^[A-Za-z]:/.test(m[1])) out.add(path.join(cwd, m[1]));
    return [...out].map((p) => path.normalize(p.replace(/[.,;:]+$/, '')));
  }

  const cache = new Map(); // sid -> { at, size, items }
  async function list(sid) {
    const d = index.get(sid);
    if (!d) return [];
    await index.updateFile(d.file);
    const c = cache.get(sid);
    const e = entry(sid);
    if (c && c.size === d.offset && Date.now() - c.at < 30_000 && c.pinnedN === e.pinned.length && c.hiddenN === e.hidden.length) return c.items;
    const seen = new Map();
    d.msgs.forEach((m, i) => {
      for (const p of candidates(m.text, d.cwd)) {
        const k = p.toLowerCase();
        if (!seen.has(k)) seen.set(k, { path: p, source: 'auto', msg: i, role: m.role });
      }
    });
    for (const x of e.pinned) seen.set(x.path.toLowerCase(), { path: x.path, source: 'pinned', title: x.title, msg: null, addedAt: x.addedAt });
    const hidden = new Set(e.hidden.map((h) => h.toLowerCase()));
    const items = [];
    for (const [k, it] of seen) {
      if (hidden.has(k)) continue;
      if (/[\\/]\.claude[\\/]/i.test(it.path)) continue; // Claude's own files (transcripts, settings)
      let st; try { st = fs.statSync(it.path); } catch { continue; }
      if (!st.isFile()) continue;
      const kind = kindOf(it.path), ext = path.extname(it.path).slice(1).toLowerCase();
      // "main" = results a person looks at; logs/code/data only under "show all"
      const main = it.source === 'pinned' || ['video', 'audio', 'pdf', 'image', 'html'].includes(kind) || /^(docx|xlsx|pptx|hwp|ply|glb|gltf|obj|stl)$/.test(ext)
        || (kind === 'markdown' && !/^(CLAUDE|JOURNAL|INBOX|DECISIONS|FAILED|QUESTIONS|MEMORY|README)\.md$/i.test(path.basename(it.path)));
      items.push({ ...it, name: path.basename(it.path), ext, kind, main, size: st.size, mtime: st.mtimeMs });
    }
    items.sort((a, b) => (b.source === 'pinned') - (a.source === 'pinned') || b.mtime - a.mtime);
    cache.set(sid, { at: Date.now(), size: d.offset, items: items.slice(0, 300), pinnedN: e.pinned.length, hiddenN: e.hidden.length });
    return items.slice(0, 300);
  }

  async function handle(p, url, req, res, body, send) {
    if (p === '/api/artifacts') {
      const sid = url.searchParams.get('session') || '';
      return send(200, { session: sid, items: await list(sid) });
    }
    if (p === '/api/artifacts/add' && req.method === 'POST') {
      const b = await body();
      if (!b.session || !b.path) return send(400, { error: 'session and path required' });
      const file = path.normalize(String(b.path).replace(/^"|"$/g, '').replace(/^\/([a-z])\//i, (x, d) => `${d.toUpperCase()}:\\`));
      try { if (!fs.statSync(file).isFile()) throw new Error('not a file'); } catch { return send(400, { error: `파일을 찾을 수 없음: ${file}` }); }
      const e = entry(b.session);
      e.pinned = e.pinned.filter((x) => x.path.toLowerCase() !== file.toLowerCase());
      e.pinned.unshift({ path: file, title: b.title || null, addedAt: Date.now() });
      e.hidden = e.hidden.filter((h) => h.toLowerCase() !== file.toLowerCase());
      save();
      return send(200, { ok: true, path: file });
    }
    if (p === '/api/artifacts/hide' && req.method === 'POST') {
      const b = await body();
      if (!b.session || !b.path) return send(400, { error: 'session and path required' });
      const e = entry(b.session);
      e.pinned = e.pinned.filter((x) => x.path.toLowerCase() !== String(b.path).toLowerCase());
      if (!e.hidden.some((h) => h.toLowerCase() === String(b.path).toLowerCase())) e.hidden.push(b.path);
      save();
      return send(200, { ok: true });
    }
    if (p === '/api/artifact-file') {
      const sid = url.searchParams.get('session') || '', want = String(url.searchParams.get('path') || '').toLowerCase();
      const it = (await list(sid)).find((x) => x.path.toLowerCase() === want);
      if (!it) return send(403, { error: '이 세션의 산출물로 등록된 파일만 열 수 있습니다' });
      return serve(req, res, it.path);
    }
    return false;
  }
  return { list, handle };
};
module.exports.serve = serve;
module.exports.kindOf = kindOf;
