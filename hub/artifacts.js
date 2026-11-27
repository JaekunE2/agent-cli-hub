// Per-session outputs ("artifacts"): files a session produced or mentioned (videos, PDFs,
// images, docs, data), found in its transcript or pinned by hand, served back for viewing.
// Only files listed for a session can be served (no arbitrary file access), and HTML/SVG are
// sandboxed so they cannot reach the dashboard origin (its token lives in localStorage).
const fs = require('fs');
const path = require('path');

const os = require('os');

const IMAGE_EXT = 'png|apng|jpe?g|gif|webp|avif|bmp|ico|svg';
const EXT = `mp4|webm|mov|mkv|avi|m4v|mp3|wav|m4a|pdf|${IMAGE_EXT}|html?|md|txt|log|csv|tsv|json|jsonl|ya?ml|tex|bib|py|ipynb|js|mjs|cjs|ts|tsx|jsx|css|scss|sql|sh|ps1|bat|cmd|c|cpp|h|hpp|rs|go|java|toml|ini|xml|vue|svelte|ply|glb|gltf|obj|stl|exr|docx|xlsx|pptx|hwp|zip|7z`;
const KIND = [
  [/\.(mp4|webm|mov|mkv|avi|m4v)$/i, 'video'], [/\.(mp3|wav|m4a)$/i, 'audio'], [/\.pdf$/i, 'pdf'],
  [new RegExp(`\\.(${IMAGE_EXT})$`, 'i'), 'image'], [/\.html?$/i, 'html'], [/\.md$/i, 'markdown'],
  [/\.(txt|log|csv|tsv|json|jsonl|ya?ml|tex|bib|py)$/i, 'text'],
];
const MIME = {
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska', avi: 'video/x-msvideo',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', apng: 'image/apng', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml',
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
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
  headers.etag = `"${st.size}-${st.mtimeMs}-${st.ctimeMs}"`;
  // active content gets an opaque origin: it cannot read the dashboard's storage or call its API
  if (/^(html?|svg)$/.test(ext)) headers['content-security-policy'] = 'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms';
  if (req.method === 'HEAD') {
    res.writeHead(200, { ...headers, 'content-length': st.size });
    return res.end();
  }
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
  const isDl = /[?&]dl=1(&|$)/.test(req.url || '');
  if (/^html?$/.test(ext) && !isDl && st.size <= 10 * 1024 * 1024) {
    try {
      const bridge = '<script data-hub-link-bridge>(function(){if(window.parent===window)return;var tauri=/[?&]hub_ext=1(&|$)/.test(location.search);function reportScroll(){parent.postMessage({type:"hub-review-scroll",x:scrollX,y:scrollY},"*");}addEventListener("message",function(e){if(e.source===parent&&e.data&&e.data.type==="hub-review-scroll-request")reportScroll();});addEventListener("scroll",reportScroll,{passive:true});function send(u){try{window.parent.postMessage({type:"hub-open-external",url:u},"*");}catch(_){}}document.addEventListener("click",function(e){var a=e.target&&e.target.closest?e.target.closest("a[href]"):null;if(!a||a.hasAttribute("download"))return;var raw=(a.getAttribute("href")||"").trim();if(!raw||raw.charAt(0)==="#"||/^javascript:/i.test(raw))return;var u=a.href;if(!/^https?:\\/\\//i.test(u))return;if(tauri){e.preventDefault();send(u);return;}if(!a.target||a.target==="_self"){a.target="_blank";a.rel="noopener noreferrer";}},true);if(tauri){var oo=window.open;window.open=function(u){if(typeof u==="string"&&/^https?:\\/\\//i.test(u)){send(u);return null;}return oo?oo.apply(window,arguments):null;};}})();</script>';
      const html = fs.readFileSync(file, 'utf8');
      const injected = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${bridge}</body>`) : `${html}\n${bridge}`;
      const buf = Buffer.from(injected, 'utf8');
      res.writeHead(200, { ...headers, 'content-length': buf.length });
      return res.end(buf);
    } catch {}
  }
  res.writeHead(200, { ...headers, 'content-length': st.size });
  fs.createReadStream(file).pipe(res);
}

module.exports = function artifacts({ dir, index, terms = null }) {
  const STORE = path.join(dir, 'artifacts-store.json');
  let store = {};
  try { store = JSON.parse(fs.readFileSync(STORE, 'utf8')); } catch {}
  const save = () => { try { fs.writeFileSync(STORE + '.tmp', JSON.stringify(store, null, 1)); fs.renameSync(STORE + '.tmp', STORE); } catch {} };
  const entry = (sid) => (store[sid] = store[sid] || { pinned: [], hidden: [] });

  // absolute Windows paths, file:/// URIs, git-bash /g/... paths, relative paths, and bare filenames in cwd
  const reFileUri = new RegExp(`file:\\/\\/\\/([A-Za-z]:[\\\\/][^"'<>|\\r\\n\\)]+?\\.(?:${EXT}))`, 'gi');
  const reAbs = new RegExp(`(?:[A-Za-z]:[\\\\/])[^\\s"'\`<>|*?()\\[\\]{}]+?\\.(?:${EXT})\\b`, 'gi');
  const reTick = new RegExp(`\`([A-Za-z]:[\\\\/][^\`\\n]+?\\.(?:${EXT}))\``, 'gi');
  const reBash = new RegExp(`(?:^|[\\s'"\`(])(/[a-z]/[^\\s"'\`<>|*?()]+?\\.(?:${EXT}))\\b`, 'gi');
  const reRel = new RegExp(`(?:^|[\\s'"\`(])([^\\s"'\`<>|*?()\\[\\]{}]+?[\\\\/][^\\s"'\`<>|*?()\\[\\]{}]+?\\.(?:${EXT}))\\b`, 'gi');
  const reBare = new RegExp(`(?:^|[\\s'"\`(\\[])([\\w.\\uAC00-\\uD7A3-]+\\.(?:${EXT}))(?=[\\s'"\`),.:;\\]]|$)`, 'gi');
  const extRe = new RegExp(`\\.(?:${EXT})$`, 'i');

  function candidates(text, cwd) {
    const out = new Set();
    const s = String(text || '');
    for (const m of s.matchAll(reFileUri)) {
      try { out.add(decodeURIComponent(m[1])); } catch { out.add(m[1]); }
    }
    for (const m of s.matchAll(reTick)) out.add(m[1]);
    for (const m of s.matchAll(reAbs)) out.add(m[0]);
    for (const m of s.matchAll(reBash)) out.add(m[1].replace(/^\/([a-z])\//i, (x, d) => `${d.toUpperCase()}:\\`));
    if (cwd) {
      for (const m of s.matchAll(reRel)) if (!/^[A-Za-z]:/.test(m[1])) out.add(path.join(cwd, m[1]));
      for (const m of s.matchAll(reBare)) out.add(path.join(cwd, m[1]));
    }
    return [...out].map((p) => path.normalize(p.replace(/[.,;:]+$/, '')));
  }

  function scanAgyBrainFiles(sid) {
    if (!sid || !/^[0-9a-f-]{16,}$/i.test(sid)) return [];
    const found = [];
    for (const name of ['antigravity-cli', 'antigravity', 'antigravity-ide']) {
      const root = path.join(os.homedir(), '.gemini', name, 'brain', sid);
      if (!fs.existsSync(root)) continue;
      let ents; try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
      for (const e of ents) {
        if (e.name.startsWith('.') || e.name === 'scratch') continue;
        const full = path.join(root, e.name);
        if (e.isFile() && extRe.test(e.name) && !/\.metadata\.json$/i.test(e.name)) found.push(full);
      }
    }
    return found;
  }

  const SKIP_DIRS = new Set(['node_modules', '.git', '.hub-worktrees', '__pycache__', '.venv', 'venv', 'dist', '.next', '.cache', 'preview-cache', 'agy-logs']);
  function scanWorkspaceModifiedFiles(cwd, sinceMs) {
    if (!cwd || !sinceMs || sinceMs < Date.now() - 7 * 86400e3) return [];
    try { if (!fs.statSync(cwd).isDirectory()) return []; } catch { return []; }
    const out = [];
    const threshold = sinceMs - 5000;
    const queue = [{ dir: cwd, depth: 0 }];
    let visited = 0;
    while (queue.length && out.length < 80 && visited < 400) {
      const { dir: cur, depth } = queue.shift();
      let ents; try { ents = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
      for (const e of ents) {
        visited++;
        if (visited > 400 || out.length >= 80) break;
        if (e.name.startsWith('.')) continue;
        const full = path.join(cur, e.name);
        if (e.isDirectory()) {
          if (depth < 3 && !SKIP_DIRS.has(e.name)) queue.push({ dir: full, depth: depth + 1 });
        } else if (e.isFile() && extRe.test(e.name)) {
          try {
            const st = fs.statSync(full);
            if (st.mtimeMs >= threshold) out.push(full);
          } catch {}
        }
      }
    }
    return out;
  }

  const cache = new Map(); // cacheKey -> { at, size, items }
  async function list(sid, opts = {}) {
    const termId = opts.termId ? String(opts.termId) : '';
    const liveTerm = termId && terms ? terms.get(termId) : null;
    if (!sid && !liveTerm) return [];
    const d = sid ? index.get(sid) : null;
    if (d) await index.updateFile(d.file);
    const effCwd = opts.cwd || d?.cwd || liveTerm?.cwd || '';
    const firstMsgTs = d?.msgs?.[0]?.ts ? Date.parse(d.msgs[0].ts) : 0;
    const sinceMs = Number(opts.since) || Number(liveTerm?.meta?.spawnedAt) || (Number.isFinite(firstMsgTs) ? firstMsgTs : 0);
    const storeKey = sid || `term:${termId}`;
    const e = entry(storeKey);
    const c = cache.get(storeKey);
    const dOffset = d ? d.offset : 0;
    if (c && c.size === dOffset && Date.now() - c.at < 8_000 && c.pinnedN === e.pinned.length && c.hiddenN === e.hidden.length) return c.items;

    const seen = new Map();
    if (d?.msgs) {
      d.msgs.forEach((m, i) => {
        for (const p of candidates(m.text, effCwd)) {
          const k = p.toLowerCase();
          if (!seen.has(k)) seen.set(k, { path: p, source: 'auto', msg: i, role: m.role });
        }
      });
    }
    for (const bp of scanAgyBrainFiles(sid)) {
      const k = bp.toLowerCase();
      if (!seen.has(k)) seen.set(k, { path: bp, source: 'auto', msg: null, role: 'assistant' });
    }
    for (const wp of scanWorkspaceModifiedFiles(effCwd, sinceMs)) {
      const k = wp.toLowerCase();
      if (!seen.has(k)) seen.set(k, { path: wp, source: 'workspace', msg: null, role: 'assistant' });
    }
    for (const x of e.pinned) seen.set(x.path.toLowerCase(), { path: x.path, source: 'pinned', title: x.title, msg: null, addedAt: x.addedAt });
    const hidden = new Set(e.hidden.map((h) => h.toLowerCase()));
    const items = [];
    for (const [k, it] of seen) {
      if (hidden.has(k)) continue;
      if (/[\\/]\.(?:claude|codex)[\\/]/i.test(it.path)) continue;
      let st; try { st = fs.statSync(it.path); } catch { continue; }
      if (!st.isFile()) continue;
      const kind = kindOf(it.path), ext = path.extname(it.path).slice(1).toLowerCase();
      // "main" = human-facing results (media/docs/html/office/3d); code/logs/data live under "all files"
      const main = it.source === 'pinned' || ['video', 'audio', 'pdf', 'image', 'html'].includes(kind) || /^(docx|xlsx|pptx|hwp|ply|glb|gltf|obj|stl)$/.test(ext)
        || (kind === 'markdown' && !/^(CLAUDE|JOURNAL|INBOX|DECISIONS|FAILED|QUESTIONS|MEMORY|README|AGENTS|ENVIRONMENT)\.md$/i.test(path.basename(it.path)));
      items.push({ ...it, name: path.basename(it.path), ext, kind, main, size: st.size, mtime: st.mtimeMs });
    }
    items.sort((a, b) => (b.source === 'pinned') - (a.source === 'pinned') || b.mtime - a.mtime);
    cache.set(storeKey, { at: Date.now(), size: dOffset, items: items.slice(0, 300), pinnedN: e.pinned.length, hiddenN: e.hidden.length });
    return items.slice(0, 300);
  }

  async function handle(p, url, req, res, body, send) {
    if (p === '/api/artifacts') {
      const sid = url.searchParams.get('session') || '';
      const termId = url.searchParams.get('term') || '';
      return send(200, { session: sid, items: await list(sid, { termId }) });
    }
    if (p === '/api/artifacts/add' && req.method === 'POST') {
      const b = await body();
      const key = b.session || (b.term ? `term:${b.term}` : '');
      if (!key || !b.path) return send(400, { error: 'session and path required' });
      const file = path.normalize(String(b.path).replace(/^"|"$/g, '').replace(/^\/([a-z])\//i, (x, d) => `${d.toUpperCase()}:\\`));
      try { if (!fs.statSync(file).isFile()) throw new Error('not a file'); } catch { return send(400, { error: `파일을 찾을 수 없음: ${file}` }); }
      const e = entry(key);
      e.pinned = e.pinned.filter((x) => x.path.toLowerCase() !== file.toLowerCase());
      e.pinned.unshift({ path: file, title: b.title || null, addedAt: Date.now() });
      e.hidden = e.hidden.filter((h) => h.toLowerCase() !== file.toLowerCase());
      save();
      cache.delete(key);
      return send(200, { ok: true, path: file });
    }
    if (p === '/api/artifacts/hide' && req.method === 'POST') {
      const b = await body();
      const key = b.session || (b.term ? `term:${b.term}` : '');
      if (!key || !b.path) return send(400, { error: 'session and path required' });
      const e = entry(key);
      e.pinned = e.pinned.filter((x) => x.path.toLowerCase() !== String(b.path).toLowerCase());
      if (!e.hidden.some((h) => h.toLowerCase() === String(b.path).toLowerCase())) e.hidden.push(b.path);
      save();
      cache.delete(key);
      return send(200, { ok: true });
    }
    if (p === '/api/artifact-file') {
      const sid = url.searchParams.get('session') || '', termId = url.searchParams.get('term') || '', want = String(url.searchParams.get('path') || '').toLowerCase();
      const it = (await list(sid, { termId })).find((x) => x.path.toLowerCase() === want);
      if (!it) return send(403, { error: '이 세션의 산출물로 등록된 파일만 열 수 있습니다' });
      return serve(req, res, it.path);
    }
    return false;
  }
  function pinFile(sid, rawPath, title = null) {
    if (!sid || !rawPath) return false;
    const file = path.normalize(String(rawPath).replace(/^"|"$/g, '').replace(/^\/([a-z])\//i, (x, d) => `${d.toUpperCase()}:\\`));
    try { if (!fs.statSync(file).isFile()) return false; } catch { return false; }
    const e = entry(sid);
    e.pinned = e.pinned.filter((x) => x.path.toLowerCase() !== file.toLowerCase());
    e.pinned.unshift({ path: file, title, addedAt: Date.now() });
    e.hidden = e.hidden.filter((h) => h.toLowerCase() !== file.toLowerCase());
    save();
    cache.delete(sid);
    return file;
  }

  return { list, handle, pinFile };
};
module.exports.serve = serve;
module.exports.kindOf = kindOf;
