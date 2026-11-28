// ---------- files → paths (drag & drop / paste), like Windows Terminal ----------
// Browsers hide a dropped file's real path, so first ask the server to find the
// original on disk (name + size + mtime); if that fails (e.g. a clipboard
// screenshot), upload a copy into hub\uploads and use that path.
const IS_MOBILE = matchMedia('(max-width: 760px), (pointer: coarse)').matches;
// opened from another device (Tailscale): hide buttons that act on this PC's desktop (open folder, ...)
const IS_REMOTE = !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(location.hostname);
if (IS_REMOTE) document.body.classList.add('remote');
const IMAGE_EXT_RE = /\.(?:png|apng|jpe?g|gif|webp|avif|bmp|ico|svg)$/i;
function createAttachmentStrip(stripEl, cwd) {
  let items = [];
  let seq = 0;

  const paint = () => {
    if (!stripEl) return;
    if (!items.length) {
      stripEl.hidden = true;
      stripEl.innerHTML = '';
      return;
    }
    stripEl.hidden = false;
    const readyIds = new Set([...stripEl.querySelectorAll('[data-att-ready]')].map(chip => Number(chip.dataset.attReady)));
    stripEl.innerHTML = items.map((it) => {
      const visual = it.thumbUrl
        ? `<img class="att-thumb" src="${esc(it.thumbUrl)}" alt="">`
        : it.isDir
          ? `<span class="att-chip-ext dir">${ICO.folder || ''} FOLDER</span>`
          : `<span class="att-chip-ext">${esc(it.ext)}</span>`;
      const meta = it.loading
        ? '<span class="att-chip-sz">준비 중…</span>'
        : it.failed
          ? (it.isDir && typeof openFolderPickerDialog === 'function'
            ? `<button type="button" class="linkbtn" data-att-pick="${it.id}" style="font-size:11px">폴더 지정</button>`
            : '<span class="att-chip-sz" style="color:var(--danger)">실패</span>')
          : (it.size ? `<span class="att-chip-sz">${esc(fmtSize(it.size))}</span>` : '');
      const rmLbl = it.isDir ? '첨부 폴더 제거' : '첨부 파일 제거';
      const ready = it.path && !it.loading && !it.failed;
      const check = ready ? '<span class="att-chip-ready" role="img" aria-label="첨부 완료" title="첨부 완료">✓</span>' : '';
      return `<span class="att-chip${it.isDir ? ' is-dir' : ''}${ready && !readyIds.has(it.id) ? ' attachment-arrived' : ''}" ${ready ? `data-att-ready="${it.id}"` : ''} title="${esc(it.path || it.name)}">${visual}<span class="att-chip-name">${esc(it.name)}</span>${meta}${check}<button type="button" class="att-chip-rm" data-att-rm="${it.id}" aria-label="${rmLbl}" title="${rmLbl}">×</button></span>`;
    }).join('');
    stripEl.querySelectorAll('[data-att-pick]').forEach((b) => {
      b.onclick = () => {
        const id = Number(b.dataset.attPick);
        const found = items.find((x) => x.id === id);
        if (!found || typeof openFolderPickerDialog !== 'function') return;
        openFolderPickerDialog(cwd || '', (picked) => {
          if (!picked) return;
          found.path = picked;
          found.name = picked.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || found.name;
          found.failed = false;
          found.loading = false;
          paint();
        });
      };
    });
    stripEl.querySelectorAll('[data-att-rm]').forEach((b) => {
      b.onclick = () => {
        const id = Number(b.dataset.attRm);
        const found = items.find((x) => x.id === id);
        if (found?.thumbUrl) try { URL.revokeObjectURL(found.thumbUrl); } catch {}
        items = items.filter((x) => x.id !== id);
        paint();
      };
    });
  };

  const addDirEntry = (dirEntry) => {
    const entry = {
      id: ++seq,
      name: dirEntry.name || 'folder',
      size: 0,
      ext: 'FOLDER',
      isDir: true,
      isImg: false,
      thumbUrl: '',
      path: null,
      loading: true,
      failed: false,
    };
    items.push(entry);
    paint();
    dirToPath(dirEntry, cwd)
      .then((res) => {
        entry.loading = false;
        if (res?.path) {
          entry.path = res.path;
          paint();
          if (res.ambiguous && typeof openFolderPickerDialog === 'function') {
            toast(`동일한 폴더가 여러 곳에 있어 가장 가까운 경로를 첨부했습니다: ${res.path}`, 6000, 'default', {
              label: '직접 선택',
              onClick: () => openFolderPickerDialog(res.path, (picked) => {
                if (!picked) return;
                entry.path = picked;
                entry.name = picked.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || entry.name;
                paint();
              }),
            });
          }
          return;
        }
        entry.failed = true;
        paint();
        const pickerAction = typeof openFolderPickerDialog === 'function'
          ? {
            label: '폴더 선택',
            onClick: () => openFolderPickerDialog(cwd || '', (picked) => {
              if (!picked) return;
              const clean = picked.replace(/[\\/]+$/, '');
              entry.path = picked;
              entry.name = clean.split(/[\\/]/).pop() || clean;
              entry.failed = false;
              entry.loading = false;
              paint();
            }),
          }
          : null;
        toast(`폴더 경로를 자동으로 찾지 못했습니다 (${entry.name})`, 6000, 'default', pickerAction);
      })
      .catch(() => {
        entry.loading = false;
        entry.failed = true;
        paint();
        toast(`폴더 경로를 확인하지 못했습니다 (${entry.name})`, 4000, 'danger');
      });
  };

  const addFiles = (fileList, dtItems = [], preEntries = null) => {
    const arr = [...(fileList || [])];
    const fileItems = [...(dtItems || [])].filter((it) => !it?.kind || it.kind === 'file');
    const fsEntries = Array.isArray(preEntries) ? preEntries : fileItems.map((it) => it.webkitGetAsEntry?.() || null);
    const total = Math.max(arr.length, fsEntries.length);
    if (!total) return;
    for (let i = 0; i < total; i++) {
      const fsEntry = fsEntries[i];
      if (fsEntry?.isDirectory) {
        addDirEntry(fsEntry);
        continue;
      }
      const f = arr[i];
      if (!f) continue;
      const extM = /\.([a-z0-9]+)$/i.exec(f.name || '');
      const ext = extM ? extM[1].toUpperCase() : 'FILE';
      const isImg = /^image\//i.test(f.type || '') || IMAGE_EXT_RE.test(f.name || '');
      let thumbUrl = '';
      if (isImg) { try { thumbUrl = URL.createObjectURL(f); } catch {} }
      const entry = {
        id: ++seq,
        name: f.name || 'image.png',
        size: f.size || 0,
        ext,
        isDir: false,
        isImg,
        thumbUrl,
        path: null,
        loading: true,
        failed: false,
      };
      items.push(entry);
      paint();
      fileToPath(f, cwd)
        .then((p) => {
          entry.loading = false;
          if (p) entry.path = p;
          else entry.failed = true;
          paint();
        })
        .catch(() => {
          entry.loading = false;
          entry.failed = true;
          paint();
        });
    }
  };

  return {
    addFiles,
    addPaths: (paths, entries = null) => {
      const list = Array.isArray(paths) ? paths : [];
      const metaList = Array.isArray(entries) ? entries : null;
      for (let i = 0; i < list.length; i++) {
        const raw = list[i];
        const p = typeof raw === 'string' ? raw : raw?.path;
        if (!p) continue;
        const clean = String(p).replace(/[\\/]+$/, '');
        const name = clean.split(/[\\/]/).pop() || clean;
        const isDir = !!(metaList?.[i]?.isDir ?? (typeof raw === 'object' && raw?.isDir));
        const ext = isDir ? 'FOLDER' : (/\.([a-z0-9]+)$/i.exec(name)?.[1].toUpperCase() || 'FILE');
        items.push({ id: ++seq, name, ext, isDir, path: p });
      }
      paint();
    },
    hasItems: () => items.length > 0,
    isLoading: () => items.some((x) => x.loading),
    snapshot: () => items.filter(x => x.path).map(({ id, path, isDir }) => ({ id, path, isDir })),
    discard: (snapshot) => {
      const ids = new Set(snapshot.map(item => item.id));
      for (const item of items) if (ids.has(item.id) && item.thumbUrl) URL.revokeObjectURL(item.thumbUrl);
      items = items.filter(item => !ids.has(item.id));
      paint();
    },
    takePaths: () => {
      const out = items.filter((x) => x.path).map((x) => quotePath(x.path));
      for (const it of items) { if (it.thumbUrl) try { URL.revokeObjectURL(it.thumbUrl); } catch {} }
      items = [];
      paint();
      return out;
    },
    clear: () => {
      for (const it of items) { if (it.thumbUrl) try { URL.revokeObjectURL(it.thumbUrl); } catch {} }
      items = [];
      paint();
    },
  };
}

function bindFilePick(root, insert, cwd, opts = {}) {
  for (const inp of root.querySelectorAll('.fpick')) {
    inp.onchange = async () => {
      const chosen = [...(inp.files || [])];
      inp.value = '';
      if (!chosen.length) return;
      if (typeof opts.onFiles === 'function' && opts.onFiles(chosen, []) !== false) return;
      const paths = [];
      for (const f of chosen) { const p = await fileToPath(f, cwd).catch(() => null); if (p) paths.push(quotePath(p)); }
      if (paths.length && insert) insert(paths.join(' ') + ' ');
    };
  }
}
const quotePath = (p) => (/[\s&()'`;,]/.test(p) ? `"${p}"` : p);
function toast(msg, ms = 4000, tone = 'default', action = null) {
  return window.showToast ? window.showToast(msg, ms, tone, action) : { remove() {} };
}
async function fileToPath(f, cwd) {
  const clipShot = /^image\.(png|jpe?g|gif|webp|bmp)$/i.test(f.name) && Date.now() - f.lastModified < 60_000;
  // the original-path lookup searches THIS PC — only meaningful when the browser runs here
  if (f.size > 0 && !clipShot && !IS_MOBILE && !IS_REMOTE) {
    const r = await api('/api/locate', { method: 'POST', body: { name: f.name, size: f.size, mtime: f.lastModified, cwd } }).catch(() => ({}));
    if (r.path) return r.path;
  }
  const n = toast(`업로드 중: ${f.name} (${(f.size / 1e6).toFixed(1)}MB)`, 600_000);
  try {
    const r = await fetch(`/api/upload?name=${encodeURIComponent(f.name)}`, { method: 'POST', headers: { 'x-token': TOKEN }, body: f });
    return (await r.json()).path;
  } finally { n.remove(); }
}
async function readDirDropSignature(dirEntry) {
  const entries = [];
  try {
    const reader = dirEntry.createReader();
    for (let round = 0; round < 20 && entries.length < 60; round++) {
      const batch = await new Promise((res) => {
        try { reader.readEntries((list) => res(list || []), () => res([])); } catch { res([]); }
      });
      if (!batch.length) break;
      for (const e of batch) {
        entries.push(e);
        if (entries.length >= 60) break;
      }
    }
  } catch {}
  const children = entries.map((e) => ({ name: e.name, isDir: !!e.isDirectory }));
  const samples = [];
  for (const e of entries) {
    if (e.isDirectory || samples.length >= 3) continue;
    const f = await new Promise((res) => {
      let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; res(null); } }, 800);
      try {
        e.file((file) => { if (!done) { done = true; clearTimeout(timer); res(file); } }, () => { if (!done) { done = true; clearTimeout(timer); res(null); } });
      } catch { if (!done) { done = true; clearTimeout(timer); res(null); } }
    });
    if (f) samples.push({ name: f.name, size: f.size, mtime: f.lastModified });
  }
  return { name: dirEntry.name || '', children, samples };
}

async function dirToPath(dirEntry, cwd) {
  if (!dirEntry?.name || IS_MOBILE || IS_REMOTE) return { path: null, matches: [], ambiguous: false };
  const sig = await readDirDropSignature(dirEntry);
  return api('/api/locate-dir', { method: 'POST', body: { ...sig, cwd } }).catch(() => ({ path: null, matches: [], ambiguous: false }));
}

// clipboard images sometimes come only as items (kind "file"), with dt.files empty
const clipFiles = (dt) => { const f = [...(dt?.files || [])]; return f.length ? f : [...(dt?.items || [])].filter((it) => it.kind === 'file').map((it) => it.getAsFile()).filter(Boolean); };
if (!window.__achDropGuard) {
  window.__achDropGuard = true;
  document.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types?.includes('Files')) e.preventDefault();
  });
  document.addEventListener('drop', (e) => {
    if (e.dataTransfer?.types?.includes('Files') || e.dataTransfer?.files?.length) {
      e.preventDefault();
    }
  });
}
function attachFileInput(el, insert, cwd, opts = {}) {
  el.dataset.fileInput = '1';
  el.addEventListener('hub-file-paths', ({ detail }) => {
    const paths = Array.isArray(detail) ? detail : (detail?.paths || []);
    const entries = Array.isArray(detail) ? null : (detail?.entries || null);
    if (!paths.length) return;
    if (opts.onPaths && opts.onPaths(paths, entries) !== false) return;
    insert?.(paths.map(quotePath).join(' ') + ' ');
  });
  const handle = async (dt) => {
    const files = clipFiles(dt);
    const items = [...(dt.items || [])].filter((it) => !it?.kind || it.kind === 'file');
    // webkitGetAsEntry must be read synchronously inside the drop/paste event turn
    const entries = items.map((it) => it.webkitGetAsEntry?.() || null);
    if (!files.length && !entries.some(Boolean)) return;
    if (typeof opts.onFiles === 'function' && opts.onFiles(files, items, entries) !== false) return;
    const paths = [];
    const total = Math.max(files.length, entries.length);
    for (let i = 0; i < total; i++) {
      if (entries[i]?.isDirectory) {
        const r = await dirToPath(entries[i], cwd).catch(() => null);
        if (r?.path) paths.push(quotePath(r.path));
        else toast(`폴더 경로를 자동으로 찾지 못했습니다 (${entries[i].name})`);
        continue;
      }
      if (!files[i]) continue;
      const p = await fileToPath(files[i], cwd).catch(() => null);
      if (p) paths.push(quotePath(p));
    }
    if (paths.length && insert) insert(paths.join(' ') + ' ');
  };
  el.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types?.includes('Files')) {
      e.preventDefault();
      try { e.dataTransfer.dropEffect = 'copy'; } catch {}
      el.classList.add('dropping');
    }
  });
  el.addEventListener('dragleave', (e) => { if (!el.contains(e.relatedTarget)) el.classList.remove('dropping'); });
  el.addEventListener('drop', (e) => {
    el.classList.remove('dropping');
    if (!e.dataTransfer?.files?.length && !e.dataTransfer?.items?.length) return;
    e.preventDefault();
    handle(e.dataTransfer);
  });
  // capture phase: runs before xterm's own paste handler on its textarea
  el.addEventListener('paste', (e) => {
    const dt = e.clipboardData;
    const files = clipFiles(dt);
    const inTerm = !!e.target?.classList?.contains('xterm-helper-textarea');
    if (inTerm && typeof opts.shouldPassCtrlV === 'function' && opts.shouldPassCtrlV(e, dt, files)) {
      e.preventDefault(); e.stopPropagation();
      if (typeof opts.sendCtrlV === 'function') opts.sendCtrlV();
      return;
    }
    if (!files.length) return;
    e.preventDefault(); e.stopPropagation();
    handle(dt);
  }, true);
}
// every other text box in the dashboard (new-session prompt, research message ...): a pasted
// image or file becomes its path (uploaded into hub/uploads), inserted at the cursor
const filePasteSelector = 'textarea, input:not([type]), input[type=text], input[type=search]';
if (!window.__achNativeDropListener) {
  window.__achNativeDropListener = true;
  window.addEventListener('hub-native-drop', ({ detail: { paths = [], entries = null, x = 0, y = 0 } = {} }) => {
    if (!paths.length) return;
    const scale = window.devicePixelRatio || 1;
    const hitScaled = document.elementFromPoint(x / scale, y / scale);
    const hitRaw = hitScaled?.closest('[data-file-input], ' + filePasteSelector) ? hitScaled : document.elementFromPoint(x, y);
    const target = hitScaled?.closest('[data-file-input]') ? hitScaled : (hitRaw || hitScaled);
    const dropZone = target?.closest('[data-file-input]')
      || [...document.querySelectorAll('.chat-shell[data-file-input]')].find((el) => el.offsetParent !== null)
      || [...document.querySelectorAll('[data-file-input]')].find((el) => el.offsetParent !== null);
    if (dropZone) {
      dropZone.dispatchEvent(new CustomEvent('hub-file-paths', { detail: { paths, entries } }));
      return;
    }
    const box = target?.closest(filePasteSelector) || (document.activeElement?.matches?.(filePasteSelector) ? document.activeElement : null);
    if (box && !box.disabled && !box.readOnly) insertFilePaths(box, paths);
  });
}
const desktopBridge = typeof window.__TAURI_INTERNALS__?.invoke === 'function' ? (() => {
  let picking = false;
  return {
    async pickFolder(initialPath) {
      if (picking) return null;
      picking = true;
      try {
        return await window.__TAURI_INTERNALS__.invoke('pick_folder', { initialPath });
      } finally {
        picking = false;
      }
    },
  };
})() : null;

document.addEventListener('paste', async (e) => {
  const box = e.target.closest?.(filePasteSelector);
  if (!box || box.closest('[data-file-input]') || box.classList.contains('xterm-helper-textarea')) return;
  const files = clipFiles(e.clipboardData);
  if (!files.length) return;
  e.preventDefault();
  const paths = [];
  for (const f of files) { const p = await fileToPath(f, null).catch(() => null); if (p) paths.push(p); }
  if (!paths.length) return toast('붙여넣은 파일을 올리지 못했습니다');
  insertFilePaths(box, paths);
});

function insertFilePaths(box, paths) {
  const txt = paths.map(quotePath).join(' ') + ' ', a = box.selectionStart ?? box.value.length, b = box.selectionEnd ?? a;
  box.value = box.value.slice(0, a) + txt + box.value.slice(b);
  box.selectionStart = box.selectionEnd = a + txt.length;
  box.dispatchEvent(new Event('input', { bubbles: true }));
  box.focus();
}


// ---------- per-session outputs (artifacts) ----------
const ART_ICON = {
  video: '<span class="ico"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="2" y="4" width="15" height="16" rx="2"/><polygon points="17 9 22 6 22 18 17 15"/></svg></span>',
  audio: '<span class="ico"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg></span>',
  pdf: '<span class="ico"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M9 15h6M9 11h3"/></svg></span>',
  image: '<span class="ico"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg></span>',
  html: '<span class="ico"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg></span>',
  markdown: '<span class="ico"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg></span>',
  text: '<span class="ico"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="13" y1="17" x2="8" y2="17"/></svg></span>',
  file: '<span class="ico"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg></span>',
};
const artUrl = (sid, p, termId = '') => `/api/artifact-file?session=${encodeURIComponent(sid || '')}${termId ? `&term=${encodeURIComponent(termId)}` : ''}&path=${encodeURIComponent(p)}&t=${encodeURIComponent(TOKEN)}`;
window.artUrl = artUrl;
const rRawUrl = (slug, rel) => `/api/research/raw?slug=${encodeURIComponent(slug)}&path=${encodeURIComponent(rel)}&t=${encodeURIComponent(TOKEN)}`;
const fmtSize = (n) => (n > 1e9 ? `${(n / 1e9).toFixed(1)}GB` : n > 1e6 ? `${(n / 1e6).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`);
// wrap Windows / git-bash paths with a viewable extension (already HTML-escaped text) as compact clickable file chips
function linkPaths(html) {
  const extPattern = 'mp4|webm|mov|mkv|pdf|png|apng|jpe?g|gif|webp|avif|bmp|ico|svg|html?|md|txt|log|csv|json|ya?ml|tex|py|js|ts|tsx|jsx|css|ply|glb|obj|docx|xlsx|pptx';
  const mkChip = (raw) => {
    const clean = String(raw || '').replace(/&quot;/g, '');
    const file = clean.split(/[\\/]/).pop() || clean;
    const extM = /\.([a-z0-9]+)$/i.exec(file);
    const ext = extM ? extM[1].toUpperCase() : 'FILE';
    const isImg = IMAGE_EXT_RE.test(file);
    return `<a class="artlink art-chip" data-apath="${clean}" title="${clean}">${isImg ? (ICO.image || ICO.file) : ICO.file}<span class="art-chip-name">${file}</span><span class="art-chip-ext">${ext}</span></a>`;
  };
  return String(html || '')
    .replace(new RegExp(`&quot;((?:[A-Za-z]:[\\\\/]|\\/[a-z]\\/)[^&"\`<>|*?]+?\\.(?:${extPattern}))&quot;`, 'gi'), (_, p) => mkChip(p))
    .replace(new RegExp(`(^|[\\s(>])((?:[A-Za-z]:[\\\\/]|\\/[a-z]\\/)[^\\s"'\`<>|*?()\\[\\]{}]+?\\.(?:${extPattern}))(?=[\\s.,;:)<]|$|&)`, 'gi'), (_, pre, p) => `${pre}${mkChip(p)}`);
}
document.addEventListener('click', async (e) => {
  const a = e.target.closest('.artlink');
  if (!a) return;
  e.preventDefault();
  const sid = currentSessionId();
  const gen = viewGen;
  if (!sid) return toast('세션을 알 수 없습니다');
  const want = a.dataset.apath.replace(/&amp;/g, '&').replace(/^\/([a-z])\//i, (x, d) => `${d.toUpperCase()}:\\`).replace(/\//g, '\\').toLowerCase();
  const { items = [] } = await api(`/api/artifacts?session=${encodeURIComponent(sid)}`);
  if (gen !== viewGen) return;
  const it = items.find((x) => x.path.toLowerCase() === want || x.path.toLowerCase().endsWith(want));
  if (it) {
    if (window.ACH_PREVIEW?.hasActive() && ['html', 'markdown', 'image', 'pdf', 'text', 'video', 'audio'].includes(it.kind)) {
      return window.ACH_PREVIEW.openArtifact(sid, it);
    }
    return openArtifact(sid, it);
  }
  toast('산출물로 인식되지 않은 파일입니다 (파일이 없거나 숨김 처리됨)');
}, true);
function currentSessionId() {
  const s = state.sel;
  if (s.kind === 'recent') return s.id;
  if (s.kind === 'term') return state.terms.find((x) => x.id === s.id)?.sessionId || null;
  if (s.kind === 'console') {
    const c = state.consoles.find((x) => String(x.id) === s.id);
    return (c && sessionOfConsole(c)?.sessionId) || s.session || null;
  }
  return null;
}

function artifactChatTarget() {
  const { kind, id } = state.sel;
  return id != null && ['term', 'recent', 'console'].includes(kind) ? { kind, id } : null;
}

function askArtifactQuestion(items, target = artifactChatTarget()) {
  const paths = items.map(item => item?.abs || item?.path).filter(Boolean);
  if (target && paths.length && stageReviewInChat('', paths, target)) return true;
  toast('산출물을 연결할 세션을 열어 주세요.');
  return false;
}

function canReviewArtifactArea(item) {
  return item?.kind === 'image' || item?.kind === 'html';
}

async function inferChatArtifacts(text, { chatHost, sid, termId } = {}) {
  const preview = window.ACH_PREVIEW?.getActiveController()?.activeArtifact?.(sid);
  const refersToResult = /(?:이|그|저|방금|직전|위의?)\s*(?:만든\s*)?(?:결과|산출물|파일|데이터|보고서|리포트|출력(?:물)?|표|그래프)(?:은|는|이|가|을|를|도|만|의|에서|에|으로|로|와|과|랑)?(?![\p{L}\p{N}_])|(?:이|그)거\s*(?:뭐야|뭔지|설명|요약|확인|분석|비교)|\b(?:this|that|the latest|the previous)\s+(?:result|output|artifact|file|data|report|chart)s?\b/iu;
  const aboutPreview = /^(?:설명해\s*줘|요약해\s*줘|분석해\s*줘|비교해\s*줘|확인해\s*줘|(?:이게\s*)?뭐야|(?:explain|summarize|analyse|analyze|compare)(?: it)?)[.!?\s]*$/i;
  if (!refersToResult.test(text) && !(preview && aboutPreview.test(text))) return [];
  if (preview?.path) return [preview.path];
  if ((!sid && !termId) || chatHost?.querySelector('.msg.user.msg-pending')) return [];
  const last = [...(chatHost?.querySelectorAll('.msg.user[data-mi], .msg.assistant[data-mi]') || [])].at(-1);
  if (!last?.classList.contains('assistant')) return [];
  const bubble = $('.msg-bubble', last);
  if (bubble?._chatArtifactPaths) return bubble._chatArtifactPaths;
  const output = bubble?.textContent?.trim();
  if (!output) return [];

  const items = await loadChatArtifactItems(sid, termId);
  return matchChatArtifacts(output, items).filter(item => !isChatImplementationPath(item.path)).map(item => item.path);
}

async function loadChatArtifactItems(sid, termId) {
  const { items = [] } = await api(`/api/artifacts?session=${encodeURIComponent(sid || '')}${termId ? `&term=${encodeURIComponent(termId)}` : ''}`, {
    signal: AbortSignal.timeout(1800),
  });
  return items;
}

function matchChatArtifacts(output, items) {
  const normalize = value => String(value || '').replace(/\\/g, '/').toLowerCase();
  const text = normalize(output);
  const mentions = (value, basename) => {
    const name = normalize(value);
    if (!name) return false;
    const index = text.indexOf(name);
    if (index < 0 || (basename && /[\p{L}\p{N}_.\/\-]/u.test(text[index - 1] || ''))) return false;
    return !/^(?:[a-z0-9_/\-]|\.[a-z0-9])/i.test(text.slice(index + name.length));
  };
  const names = new Map();
  for (const { name } of items) {
    if (!name) continue;
    const key = normalize(name);
    names.set(key, (names.get(key) || 0) + 1);
  }
  return items.filter(item => item.path && (mentions(item.path, false)
    || (names.get(normalize(item.name)) === 1 && mentions(item.name, true))));
}

function isChatImplementationPath(file) {
  const path = String(file || '').replace(/\\/g, '/');
  return /(?:^|\/)(?:src|public|i18n|locales|tests?|fixtures|node_modules|\.github)\//i.test(path)
    || /(?:^|\/)(?:package(?:-lock)?\.json|tsconfig(?:\.[^/]+)?\.json|composer\.json|(?:pnpm-lock|yarn)\.(?:yaml|lock))$/i.test(path);
}

function chatResultArtifacts(output, request, items) {
  return matchChatArtifacts(output, items).filter(item => {
    if (item.source === 'pinned') return true;
    if (isChatImplementationPath(item.path)) return false;
    if (['image', 'video', 'audio', 'pdf'].includes(item.kind)
      || /^(csv|tsv|xlsx?|docx?|pptx?|hwp|zip|7z)$/i.test(item.ext)) return true;
    if (!/^(html?|json|txt|md)$/i.test(item.ext)) return false;
    if (matchChatArtifacts(request, [item]).length
      && /(?:만들|작성|생성|내보내|저장|렌더링|다운로드|\b(?:create|generate|export|save|render|download)\b)/i.test(request)) return true;
    return String(output).split('\n').some(line =>
      /(?:산출물|결과\s*파일|내보낸|다운로드|미리보기\s*파일|\b(?:deliverable|artifact|output file|exported|download)\b)/i.test(line)
      && matchChatArtifacts(line, [item]).length);
  });
}

async function showChatArtifactPreviews(rows, sid, termId, scroller) {
  if (!rows.length || (!sid && !termId)) return;
  const items = await loadChatArtifactItems(sid, termId).catch(() => []);
  const stick = scroller?.isConnected && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
  let added = false;
  for (const { bubble, output, observation, outcome, latest, request } of rows) {
    if (!bubble?.isConnected) continue;
    const matches = chatResultArtifacts(output, request, items);
    if (observation && !matches.some(item => item.path === observation.item.path)) matches.unshift(observation.item);
    bubble._chatArtifactPaths = [...new Set(matches.map(item => item.path))];
    if (!matches.length) continue;
    const visible = matches.filter(item => item.path !== observation?.item.path || !observation.thumbnail);
    if (!visible.length) continue;
    const group = document.createElement('div');
    group.className = 'chat-result-previews';
    const dataFiles = visible.filter(item => /^(csv|tsv|json)$/i.test(item.ext));
    for (const item of visible.slice(0, 2)) {
      const url = artUrl(sid, item.path, termId);
      const autoOpen = latest && ['image', 'text', 'markdown', 'html'].includes(item.kind);
      const count = autoOpen && dataFiles.length === 1 && item === dataFiles[0] ? requestedArtifactRows(request) : null;
      group.append(createChatArtifactCard(sid, item, url, { autoOpen, count }));
    }
    if (visible.length > 2) {
      const count = document.createElement('span');
      count.className = 'muted';
      count.textContent = `+${visible.length - 2}`;
      group.append(count);
    }
    (outcome || bubble).after(group);
    added = true;
  }
  if (added && stick) scroller.scrollTop = scroller.scrollHeight;
}

function createChatArtifactCard(sid, item, url, { autoOpen = false, count = null } = {}) {
  const card = document.createElement('details');
  card.className = 'chat-result-card';
  const image = item.kind === 'image';
  const target = artifactChatTarget();
  card.innerHTML = `<summary class="chat-result-preview" title="${esc(item.path)}">
    ${image ? `<img loading="lazy" src="${esc(url)}" alt="">` : (ART_ICON[item.kind] || ART_ICON.file)}
    <span><b>${esc(item.title || item.name)}</b><small>${esc(item.ext || 'FILE')} · ${fmtSize(item.size)}</small></span>
  </summary><div class="chat-result-body">
    <div class="chat-result-content"></div>
    <div class="chat-result-actions">
      ${target ? '<button type="button" class="ghost btn-sm" data-result-ask>이 결과에 질문</button>' : ''}
      <button type="button" class="ghost icon-btn btn-sm chat-result-expand" aria-label="확대해서 열기" title="확대해서 열기">
        <span aria-hidden="true"></span>
      </button>
    </div>
  </div>`;
  const thumbnail = card.querySelector('summary img');
  thumbnail?.addEventListener('error', () => {
    thumbnail.insertAdjacentHTML('afterend', ART_ICON.image);
    thumbnail.remove();
  }, { once: true });
  card.querySelector('[data-result-ask]')?.addEventListener('click', () => askArtifactQuestion([item], target));
  card.querySelector('.chat-result-expand').onclick = () => {
    const inline = window.ACH_PREVIEW;
    if (sid && inline?.hasActive() && ['html', 'markdown', 'image', 'pdf', 'text', 'video', 'audio'].includes(item.kind)) {
      inline.openArtifact(sid, item);
    } else openArtifact(sid, item, url, target);
  };
  const content = card.querySelector('.chat-result-content');
  let loaded = false;
  card.addEventListener('toggle', async () => {
    if (!card.open || loaded) return;
    loaded = true;
    if (image) {
      const preview = document.createElement('img');
      preview.alt = item.title || item.name;
      preview.addEventListener('error', () => {
        loaded = false;
        content.textContent = '파일 미리보기를 불러오지 못했습니다.';
      }, { once: true });
      preview.src = url;
      content.replaceChildren(preview);
    } else if (item.kind === 'html') {
      const frame = document.createElement('iframe');
      frame.className = 'chat-result-html';
      frame.title = 'HTML 정적 미리보기';
      frame.setAttribute('sandbox', '');
      frame.src = url;
      content.replaceChildren(frame);
    } else if (item.kind === 'text' || item.kind === 'markdown') {
      content.textContent = '불러오는 중…';
      try {
        if (/^(csv|tsv|json)$/i.test(item.ext)) {
          const onFix = target ? text => stageReviewInChat(text, [], target) : null;
          if (await renderChatArtifactData(content, item, url, count, onFix)) return;
        }
        const snippet = await readChatArtifactSnippet(url);
        const pre = document.createElement('pre');
        pre.className = 'mdpre';
        pre.textContent = snippet || '빈 파일';
        content.replaceChildren(pre);
      } catch {
        loaded = false;
        content.textContent = '파일 미리보기를 불러오지 못했습니다.';
      }
    } else {
      content.textContent = '확대 버튼으로 파일을 열 수 있습니다.';
    }
  });
  if (autoOpen) card.open = true;
  return card;
}

async function readChatArtifactSnippet(url) {
  const response = await fetch(url, { headers: { Range: 'bytes=0-2047' }, signal: AbortSignal.timeout(5000) });
  if (response.status === 416 && response.headers.get('content-range') === 'bytes */0') return '';
  const size = Number(response.headers.get('content-length') || Infinity);
  if (!response.ok || (response.status !== 206 && size > 2048)) {
    await response.body?.cancel();
    throw new Error('Artifact preview unavailable');
  }
  const lines = (await response.text()).trimEnd().split(/\r?\n/);
  const snippet = lines.slice(0, 5).map(line => line.length > 160 ? `${line.slice(0, 160)}…` : line).join('\n');
  return snippet + (lines.length > 5 || size >= 2048 ? '\n…' : '');
}

function currentReviewTerminal() {
  const sid = currentSessionId();
  return state.terms.find(t => t.exited === null && (state.sel.kind === 'term'
    ? String(t.id) === String(state.sel.id) : sid && t.sessionId === sid));
}

// research outputs are listed relative to the project folder
const rAbs = (dir, rel) => `${String(dir || '').replace(/[\\/]+$/, '')}\\${String(rel).replace(/\//g, '\\')}`;

// A PC file (session output, research output) → a running dashboard terminal: the path goes into its
// input (with a message: sent). Sessions open the path themselves — nothing is copied.
function sendPathDialog(abs, { message = '', attachment = '', onSent, ...drawerOptions } = {}) {
  const targets = state.terms.filter((t) => t.exited === null).map((t) => ({ id: t.id, label: termLabel(t) }));
  const active = currentReviewTerminal();
  const cur = active ? String(active.id) : null;
  const body = `
    <div class="mono" style="word-break:break-all">${esc(abs)}</div>
    <label>보낼 세션<br>${targets.length ? `<select id="spT" style="width:100%">${targets.map((t) => `<option value="${esc(t.id)}" ${String(t.id) === cur ? 'selected' : ''}>t:${esc(t.id)} ${esc(t.label)}</option>`).join('')}</select>` : '<div class="empty">열려 있는 대시보드 터미널이 없습니다</div>'}</label>
    <label>함께 보낼 말 (비우면 경로만 입력칸에 넣고 전송하지 않음)<br><textarea id="spM" rows="3" style="width:100%" placeholder="예: 이 결과 보고 다음 실험 계획 세워줘"></textarea></label>`;
  const d = openDrawer({ title: '세션에 보내기', bodyHTML: body, footerHTML: `<button data-drw-close>취소</button><button class="primary" id="spOk" ${targets.length ? '' : 'disabled'}>보내기</button>`, width: 440, ...drawerOptions });
  $('#spM', d).value = message;
  let uncertain = false;
  $('#spOk', d).onclick = async () => {
    if (uncertain && !confirm('CLI가 이미 받았을 수 있습니다. 대화를 확인한 뒤 다시 전송할까요?')) return;
    const button = $('#spOk', d);
    button.disabled = true;
    const msg = $('#spM', d).value.trim();
    const text = [msg, quotePath(abs), attachment ? quotePath(attachment) : ''].filter(Boolean).join('\n') + (msg ? '' : ' ');
    try {
      const r = await api('/api/term/send', { method: 'POST', body: { id: $('#spT', d).value, text, submit: !!msg } });
      if (!r.ok) throw Object.assign(new Error(r.error || '터미널 입력을 확인하지 못했습니다.'), { delivery: r.delivery });
      d.close();
      await onSent?.();
      toast(msg ? '세션에 보냈습니다' : '경로를 세션 입력칸에 넣었습니다');
    } catch (error) {
      uncertain = error.delivery !== 'not-sent';
      toast(uncertain ? `전달 여부 확인 필요 · ${error.message}` : error.message, 6000, 'danger');
      button.disabled = false;
    }
  };
}

// picker for the terminal input bar: outputs of this session, another dashboard session, or a research project
function pickArtifact(onPath) {
  const seenSids = new Set();
  const termSources = state.terms.map((t) => {
    const sid = resolveTermSessionId(t) || `term:${t.id}`;
    seenSids.add(sid);
    return { v: 's:' + sid, label: `터미널 t:${t.id} · ${termLabel(t)}`, cur: state.sel.kind === 'term' && String(state.sel.id) === String(t.id) };
  });
  const recentSources = state.recent.filter((r) => r.sessionId && !seenSids.has(r.sessionId)).slice(0, 15).map((r) => ({
    v: 's:' + r.sessionId,
    label: `최근 · ${(r.title || r.firstPrompt || r.sessionId).slice(0, 42)}`,
    cur: false,
  }));
  const sources = [
    ...termSources,
    ...(state.research || []).map((p) => ({ v: 'r:' + p.slug, label: `연구 · ${p.name}` })),
    ...recentSources,
  ];
  const body = `
    <div class="row"><select id="paS" style="flex:1;min-width:0">${sources.map((x) => `<option value="${esc(x.v)}" ${x.cur ? 'selected' : ''}>${esc(x.label)}</option>`).join('')}</select>
      <label class="row" style="gap:4px"><input type="checkbox" id="paAll"> 모든 파일</label></div>
    <div id="paB" style="flex:1;overflow:auto">불러오는 중…</div>`;
  const d = openDrawer({ title: '산출물 넣기', bodyHTML: body, footerHTML: '<button data-drw-close>닫기</button>', width: 520 });
  let list = [], seq = 0;
  const paint = async () => {
    const my = ++seq; // a slower earlier load must not overwrite the source picked since
    const v = $('#paS', d).value || '';
    if (!v) { $('#paB', d).innerHTML = '<div class="empty">세션이나 연구가 없습니다</div>'; return; }
    $('#paB', d).innerHTML = '<div class="empty">불러오는 중…</div>';
    let next;
    try {
      if (v.startsWith('s:')) {
        const r = await api(`/api/artifacts?session=${encodeURIComponent(v.slice(2))}`);
        next = (r.items || []).filter((x) => $('#paAll', d).checked || x.main).map((x) => ({ abs: x.path, name: x.title || x.name, kind: x.kind, size: x.size, mtime: x.mtime }));
      } else {
        const r = await api(`/api/research/detail?slug=${encodeURIComponent(v.slice(2))}`);
        const INTERNAL = /^(CLAUDE|JOURNAL|INBOX|DECISIONS|FAILED|QUESTIONS|MEMORY|README|BRIEF|STATE)\.md$/i;
        const main = (f) => ['video', 'audio', 'pdf', 'image', 'html'].includes(f.kind) || /^(docx|xlsx|pptx|ply|glb|obj)$/.test(f.ext) || (f.kind === 'markdown' && !INTERNAL.test(f.name)) || /(^|\/)main\.tex$/i.test(f.path);
        next = (r.outputs || []).filter((f) => $('#paAll', d).checked || main(f)).map((f) => ({ abs: rAbs(r.dir, f.path), name: f.path, kind: f.kind, size: f.size, mtime: f.mtime }));
      }
    } catch (er) { if (my === seq) $('#paB', d).innerHTML = `<div class="err">${esc(er.message)}</div>`; return; }
    if (my !== seq) return;
    list = next.sort((a, b) => b.mtime - a.mtime);
    $('#paB', d).innerHTML = list.map((x, i) => `<div class="ofile" data-pa="${i}" style="cursor:pointer"><span>${ART_ICON[x.kind] || ART_ICON.file} ${esc(x.name)}</span><span class="empty">${fmtSize(x.size)} · ${relTime(x.mtime)}</span></div>`).join('')
      || '<div class="empty">산출물이 없습니다 ("모든 파일"을 켜면 코드·데이터도 보입니다)</div>';
  };
  $('#paS', d).onchange = paint;
  $('#paAll', d).onchange = paint;
  $('#paB', d).onclick = (e) => { const it = e.target.closest('[data-pa]'); if (!it) return; d.close(); onPath(list[Number(it.dataset.pa)].abs); };
  paint();
}

let artShowAll = false;
// time order with day headers (오늘 / 어제 / 9월 25일 (목)); newest or oldest first, remembered per viewer
let artOrder = 'new';
try { artOrder = localStorage.getItem('ccd.artOrder') || 'new'; } catch {}
const artOrderSel = () => `<select id="artOrder" title="정렬"><option value="new" ${artOrder === 'new' ? 'selected' : ''}>최신순</option><option value="old" ${artOrder === 'old' ? 'selected' : ''}>오래된순</option></select>`;
function bindArtOrder(repaint) {
  const el = $('#artOrder');
  if (el) el.onchange = (e) => { artOrder = e.target.value; try { localStorage.setItem('ccd.artOrder', artOrder); } catch {} repaint(); };
}
function artTimeline(pairs, card) { // pairs: [[item, index]]
  const dayOf = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const today = dayOf(Date.now()), yest = dayOf(today - 12 * 3600e3);
  const label = (t) => (t === today ? '오늘' : t === yest ? '어제'
    : new Date(t).toLocaleDateString((document.documentElement.lang === 'en' ? 'en-US' : 'ko-KR'), { ...(new Date(t).getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}), month: 'long', day: 'numeric', weekday: 'short' }));
  const sorted = [...pairs].sort((a, b) => (artOrder === 'old' ? a[0].mtime - b[0].mtime : b[0].mtime - a[0].mtime));
  const groups = [];
  for (const p of sorted) {
    const t = dayOf(p[0].mtime);
    if (!groups.length || groups[groups.length - 1][0] !== t) groups.push([t, []]);
    groups[groups.length - 1][1].push(p);
  }
  return groups.map(([t, xs]) => `<div class="aday">${label(t)} <span class="empty">${xs.length}개</span></div><div class="agrid">${xs.map(card).join('')}</div>`).join('');
}
async function renderArtifacts(sid, gen, termId = '', host = $('#view')) {
  if (!host) return;
  host.innerHTML = '<div class="empty" style="padding:20px">산출물 찾는 중…</div>';
  let query = '';
  let showCards = false;
  let autoExpanded = false;
  let selecting = false;
  const selected = new Set();
  const target = artifactChatTarget();
  const paint = async () => {
    const r = await api(`/api/artifacts?session=${encodeURIComponent(sid || '')}${termId ? `&term=${encodeURIComponent(termId)}` : ''}`).catch((e) => ({ error: e.message }));
    if (gen !== viewGen || !host.isConnected) return;
    if (r.error) { host.innerHTML = `<div class="err">${esc(r.error)}</div>`; return; }
    const all = r.items || [];
    const available = new Set(all.map(item => item.path));
    for (const file of selected) if (!available.has(file)) selected.delete(file);
    const mainCount = all.filter((x) => x.main).length;
    if (!autoExpanded && !artShowAll && mainCount === 0 && all.length > 0) {
      autoExpanded = true;
      artShowAll = true;
    }
    const items = artShowAll ? all : all.filter((x) => x.main);
    const card = ([it, i]) => {
      const location = String(it.path || '').split(/[\\/]/).slice(0, -1).filter(Boolean).slice(-2).join('/');
      return `<div class="acard" data-ai="${i}">
        ${target ? `<input class="artifact-select" type="checkbox" data-art-choose aria-label="질문에 첨부할 파일 선택" title="${esc(it.title || it.name)}"${selecting ? '' : ' hidden'}${selected.has(it.path) ? ' checked' : ''}>` : ''}
        <button class="artifact-open" type="button">
        <span class="athumb">${it.kind === 'image' ? `<img loading="lazy" src="${artUrl(sid, it.path, termId)}" alt="">` : `<span>${ART_ICON[it.kind] || ART_ICON.file}</span>`}</span>
        <span class="ameta"><b title="${esc(it.path)}">${esc(it.title || it.name)}</b>
          <span class="artifact-location" title="${esc(it.path)}">${esc(location)}</span>
          <span class="ums">${esc(it.ext.toUpperCase())} · ${fmtSize(it.size)} · ${relTime(it.mtime)}${it.source === 'pinned' ? ' · 지정됨' : ''}</span></span></button>
        <button type="button" class="adrive" data-adrive="${i}" aria-label="Google Drive에 업로드" title="Google Drive에 업로드">${ICO.upload}</button><button type="button" class="ahide" data-ahide="${i}" aria-label="목록에서 숨기기" title="목록에서 숨기기">${ICO.close}</button><button type="button" class="asend" data-asend="${i}" aria-label="세션에 보내기" title="이 파일을 세션에 보내기 (경로 멘션)">${ICO.arrowUpRight}</button></div>`;
    };
    host.innerHTML = `<div class="subtoolbar">
        <div class="seg" role="tablist" aria-label="산출물 범위">
          <button data-art-scope="main" class="${!artShowAll ? 'on' : ''}">주요 산출물 <span class="seg-cnt">${all.filter((x) => x.main).length}</span></button>
          <button data-art-scope="all" class="${artShowAll ? 'on' : ''}">전체 파일 <span class="seg-cnt">${all.length}</span></button>
        </div>
        <span class="sp"></span>
        <input id="artSearch" class="btn-sm" type="search" aria-label="파일명 · 폴더 · 형식 검색" placeholder="파일명 · 폴더 · 형식" value="${esc(query)}">
        <button class="btn-sm" type="button" id="artLayout" aria-pressed="${showCards}">카드 보기</button>
        ${target && all.length ? `<button type="button" class="btn-sm" data-art-select aria-pressed="${selecting}">결과 선택</button>
          <button type="button" class="btn-sm" data-art-all${selecting ? '' : ' hidden'}>표시된 결과 모두 선택</button>
          <button type="button" class="primary btn-sm" data-art-ask${selecting ? '' : ' hidden'}>선택한 결과에 질문 <span data-art-count></span></button>` : ''}
        ${artOrderSel()}
        <button id="artAdd" class="btn-sm">${ICO.plus} 산출물 지정</button>
      </div>
      <div class="rwrap session-artifacts${showCards ? '' : ' artifact-list'}">
      ${items.length ? artTimeline(items.map((it, i) => [it, i]), card) : `<div class="h-empty-card" style="margin-top:8px"><b>아직 등록된 산출물이 없습니다</b><span class="ums" style="margin:0;max-width:460px">대화에 나온 파일 경로가 자동으로 모이며, 직접 파일을 지정하거나 코드 구조 탭에서 보고서(FLOORPLAN.md)를 저장할 수 있습니다.</span><button type="button" class="primary btn-sm" id="artEmptyAdd" style="margin-top:6px">${ICO.plus} 산출물 지정</button></div>`}</div>`;
    bindArtOrder(paint);
    const selectResults = $('[data-art-select]', host);
    const askSelected = $('[data-art-ask]', host);
    const selectAll = $('[data-art-all]', host);
    const syncSelection = () => {
      if (!askSelected) return;
      selectResults.setAttribute('aria-pressed', String(selecting));
      askSelected.hidden = !selecting;
      selectAll.hidden = !selecting;
      askSelected.disabled = !selected.size;
      $('[data-art-count]', askSelected).textContent = `(${selected.size})`;
      host.querySelectorAll('[data-art-choose]').forEach((box) => {
        box.hidden = !selecting;
        box.checked = selected.has(items[Number(box.closest('[data-ai]').dataset.ai)].path);
      });
    };
    if (selectResults) {
      selectResults.onclick = () => {
        selecting = !selecting;
        if (!selecting) selected.clear();
        syncSelection();
      };
      askSelected.onclick = () => {
        if (askArtifactQuestion(all.filter(item => selected.has(item.path)), target)) {
          selecting = false;
          selected.clear();
          syncSelection();
        }
      };
      selectAll.onclick = () => {
        host.querySelectorAll('[data-ai]:not([hidden])').forEach(row => selected.add(items[Number(row.dataset.ai)].path));
        syncSelection();
      };
      host.querySelectorAll('[data-art-choose]').forEach((box) => {
        box.onchange = () => {
          const file = items[Number(box.closest('[data-ai]').dataset.ai)].path;
          if (box.checked) selected.add(file);
          else selected.delete(file);
          syncSelection();
        };
      });
      syncSelection();
    }
    const filterRows = () => {
      const keywords = termsOf(query);
      const rows = [...host.querySelectorAll('[data-ai]')];
      for (const row of rows) {
        const { title, name, path, ext } = items[Number(row.dataset.ai)];
        const label = [title, name, path, ext].join(' ').toLowerCase();
        row.hidden = !keywords.every((term) => label.includes(term));
      }
      for (const heading of host.querySelectorAll('.session-artifacts .aday')) {
        heading.hidden = !heading.nextElementSibling.querySelector('[data-ai]:not([hidden])');
      }
      $('#artNoMatch', host).hidden = !rows.length || rows.some((row) => !row.hidden);
    };
    $('.session-artifacts', host).insertAdjacentHTML('beforeend', '<p id="artNoMatch" class="empty" hidden>일치하는 파일이 없습니다</p>');
    $('#artSearch', host).oninput = (e) => { query = e.target.value; filterRows(); };
    $('#artLayout', host).onclick = (e) => {
      showCards = !showCards;
      e.currentTarget.setAttribute('aria-pressed', String(showCards));
      $('.session-artifacts', host).classList.toggle('artifact-list', !showCards);
    };
    filterRows();
    host.querySelectorAll('[data-art-scope]').forEach((b) => (b.onclick = () => { artShowAll = b.dataset.artScope === 'all'; paint(); }));
    $('#artAdd', host).onclick = () => addArtifactDialog(sid, paint);
    const emptyAdd = $('#artEmptyAdd', host);
    if (emptyAdd) emptyAdd.onclick = () => addArtifactDialog(sid, paint);
    host.querySelectorAll('[data-ai]').forEach((el) => (el.onclick = (e) => {
      if (e.target.closest('[data-ahide], [data-adrive], [data-art-choose]')) return;
      const sb = e.target.closest('[data-asend]');
      if (sb) return sendPathDialog(items[Number(sb.dataset.asend)].path);
      const item = items[Number(el.dataset.ai)];
      openArtifact(sid, item, artUrl(sid, item.path, termId), target);
    }));
    host.querySelectorAll('[data-adrive]').forEach((b) => (b.onclick = async (e) => {
      e.stopPropagation();
      const it = items[Number(b.dataset.adrive)];
      if (it) await uploadArtifactToDrive(it, { btn: b, sid, termId });
    }));
    host.querySelectorAll('[data-ahide]').forEach((b) => (b.onclick = async (e) => {
      e.stopPropagation();
      b.disabled = true;
      try {
        const r = await api('/api/artifacts/hide', { method: 'POST', body: { session: sid, term: termId, path: items[Number(b.dataset.ahide)].path } });
        if (r.error) throw new Error(r.error);
        await paint();
      } catch (e) { toast(e.message, 5000, 'danger'); }
      finally { b.disabled = false; }
    }));
  };
  paint();
}
async function uploadArtifactToDrive(item, { btn, sid, termId, drawerOptions = {} } = {}) {
  const t = (state.terms || []).find((x) => String(x.id) === String(termId))
    || (state.recent || []).find((x) => x.sessionId === sid);
  const folderName = (t?.cwd ? base(t.cwd) : '') || t?.title || 'Session';
  const tryUpload = async () => {
    if (btn) btn.disabled = true;
    try {
      const r = await fetch('/api/drive/upload', {
        method: 'POST',
        headers: { 'x-token': TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify({ path: item.path, folderName, title: item.name || item.title }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.ok) {
        toast(`Drive 업로드 완료: ${j.name || item.name}${j.updated ? ' (업데이트됨)' : ''}`);
        return true;
      }
      if (j.code === 'NOT_CONNECTED' || j.code === 'NOT_CONFIGURED') {
        const authRes = j.code === 'NOT_CONNECTED' ? await api('/api/drive/auth').catch((err) => ({ error: err.message })) : null;
        const authUrl = authRes?.url || '';
        const isLocal = ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname);
        const d = openDrawer({
          title: 'Google Drive 연결',
          bodyHTML: j.code === 'NOT_CONFIGURED'
            ? `<p>Google OAuth 클라이언트 파일이 필요합니다.</p><p class="ums"><code>hub/data/secrets/google-oauth-client.json</code> 파일을 설정한 뒤 다시 시도하세요 (Google 캘린더와 동일).</p>`
            : `<p>선택한 산출물을 Google Drive의 <b>Agent CLI Hub</b> 폴더에 올리려면 먼저 Google 계정을 연결하세요.</p>
               ${isLocal ? '' : '<p class="ums">구글 로그인 후 돌아오는 주소가 이 PC(127.0.0.1)라서, 이 PC 브라우저에서 연결하거나 로그인 후 실패한 주소창 URL을 아래에 붙여넣으세요.</p>'}
               ${authRes?.error ? `<p class="err">${esc(authRes.error)}</p>` : ''}
               <div class="row" style="gap:8px;margin-top:10px;flex-wrap:wrap">
                 ${authUrl ? `<a class="btnlike primary" id="gdAuthBtn" href="${esc(authUrl)}" target="_blank" rel="noopener noreferrer">Google Drive 연결</a>` : '<button type="button" class="primary" id="gdAuthBtn">Google Drive 연결</button>'}
                 ${authUrl ? '<button type="button" id="gdCopyUrlBtn">로그인 URL 복사</button>' : ''}
                 <button type="button" id="gdRetryBtn">연결 완료 후 다시 업로드</button>
               </div>
               ${isLocal ? '' : `<div style="margin-top:12px;display:flex;gap:6px;flex-wrap:wrap">
                 <input id="gdCallbackUrl" style="flex:1;min-width:180px" placeholder="원격 로그인 후 127.0.0.1 콜백 URL 붙여넣기">
                 <button type="button" id="gdExchangeBtn">URL로 연결 완료</button>
               </div>`}`,
          footerHTML: '<button data-drw-close>닫기</button>',
          width: 440,
          ...drawerOptions,
        });
        const authBtn = $('#gdAuthBtn', d);
        if (authBtn && authBtn.tagName === 'BUTTON') authBtn.onclick = async () => {
          authBtn.disabled = true;
          try {
            const ar = await api('/api/drive/auth');
            if (ar.error) throw new Error(ar.error);
            if (ar.url) window.open(ar.url, '_blank', 'noopener,noreferrer');
          } catch (err) { toast(err.message, 5000, 'danger'); }
          finally { authBtn.disabled = false; }
        };
        else if (authBtn) authBtn.onclick = () => {
          toast('브라우저에서 Google 로그인을 완료한 뒤 돌아오세요.', 4000);
        };
        const copyBtn = $('#gdCopyUrlBtn', d);
        if (copyBtn && authUrl) copyBtn.onclick = async () => {
          try {
            await navigator.clipboard.writeText(authUrl);
            toast('로그인 주소를 클립보드에 복사했습니다.');
          } catch {
            toast('주소 복사에 실패했습니다.', 4000, 'danger');
          }
        };
        const exBtn = $('#gdExchangeBtn', d);
        const cbInput = $('#gdCallbackUrl', d);
        if (exBtn) exBtn.onclick = async () => {
          const cb = cbInput?.value?.trim();
          if (!cb) return toast('복사한 콜백 URL을 붙여넣어 주세요.', 3500, 'danger');
          exBtn.disabled = true;
          try {
            const er = await api('/api/drive/exchange', { method: 'POST', body: { callbackUrl: cb } });
            if (er.error) throw new Error(er.error);
            d.close();
            await tryUpload();
          } catch (err) { toast(err.message, 5000, 'danger'); }
          finally { exBtn.disabled = false; }
        };
        if (cbInput && exBtn) cbInput.onkeydown = (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); exBtn.click(); } };
        const retryBtn = $('#gdRetryBtn', d);
        if (retryBtn) retryBtn.onclick = async () => {
          d.close();
          await tryUpload();
        };
        return false;
      }
      throw new Error(j.error || `HTTP ${r.status}`);
    } catch (err) {
      toast(err.message, 5000, 'danger');
      return false;
    } finally {
      if (btn) btn.disabled = false;
    }
  };
  return tryUpload();
}

function addArtifactDialog(sid, done) {
  const body = `
    <label>파일 경로<br><input id="apPath" style="width:100%" placeholder="예: C:\\work\\project\\out\\result.mp4 — 파일을 여기로 끌어놓아도 됩니다"></label>
    <label>이름 (선택)<br><input id="apTitle" style="width:100%" placeholder="예: 최종 비교 영상"></label>`;
  const d = openDrawer({ title: '산출물 지정', bodyHTML: body, footerHTML: '<button data-drw-close>취소</button><button class="primary" id="apOk">추가</button>', width: 440 });
  const pathInput = $('#apPath', d);
  attachFileInput($('.drw-body', d), (txt) => { pathInput.value = txt.trim().replace(/^"|"$/g, ''); }, null, {
    onPaths: ([path]) => { pathInput.value = path; },
  });
  $('#apOk', d).onclick = async (e) => {
    const button = e.currentTarget;
    button.disabled = true;
    try {
      const r = await api('/api/artifacts/add', { method: 'POST', body: { session: sid, term: state.sel.kind === 'term' ? state.sel.id : '', path: $('#apPath', d).value.trim(), title: $('#apTitle', d).value.trim() || undefined } });
      if (r.error) throw new Error(r.error);
      d.close(); toast('산출물로 지정했습니다'); done?.();
    } catch (er) { toast(er.message, 6000, 'danger'); }
    finally { button.disabled = false; }
  };
}
async function openArtifact(sid, it, url = artUrl(sid, it.path), target = sid ? artifactChatTarget() : null) {
  const reviewable = canReviewArtifactArea(it);
  const d = document.createElement('dialog');
  d.className = 'dlg artifact-preview';
  d.setAttribute('aria-labelledby', 'avTitle');
  d.innerHTML = `<span class="sr-only" tabindex="0" data-av-edge="start"></span>
    <div class="box wide aview"><div class="row avhead artifact-preview-head"><b id="avTitle" title="${esc(it.path)}">${ART_ICON[it.kind] || ''} ${esc(it.title || it.name)}</b>
      <a class="btnlike btn-sm" href="${url}" target="_blank" rel="noopener">${ICO.external} 새 탭</a><a class="btnlike btn-sm" href="${url}&dl=1" download="${esc(it.name)}">다운로드</a><button type="button" class="btn-sm" id="avDrive" title="Google Drive에 업로드">${ICO.upload} Drive</button><button class="primary btn-sm" id="avSend" title="이 파일 경로를 세션에 보내기">${ICO.arrowUpRight} 세션에</button>
      ${target ? '<button type="button" class="btn-sm" data-av-ask>이 결과에 질문</button>' : ''}
      ${reviewable ? '<button type="button" class="btn-sm" data-av-review>영역 코멘트</button><button type="button" class="btn-sm" data-av-refresh>새로고침</button>' : ''}
      ${it.kind === 'html' && navigator.mediaDevices?.getDisplayMedia ? '<button type="button" class="btn-sm" data-av-capture>실제 화면 코멘트</button>' : ''}<button class="ghost icon-btn btn-sm" id="avClose" autofocus aria-label="닫기">${ICO.close}</button></div>
    <div class="ums mono" style="word-break:break-all">${esc(it.path)} · ${fmtSize(it.size)}</div>
    <div data-av-review-slot></div>
    <div id="avBody" class="avbody" tabindex="0" role="region" aria-label="미리보기 내용">불러오는 중…</div></div>
    <span class="sr-only" tabindex="0" data-av-edge="end"></span>`;
  const box = $('.aview', d);
  const send = $('#avSend', d);
  const body = $('#avBody', d);
  const end = $('[data-av-edge=end]', d);
  d.addEventListener('focusin', e => {
    const edge = e.target.dataset.avEdge;
    if (!edge) return;
    const controls = [...(box.inert ? $('.drw-panel', d) : box).querySelectorAll(
      'a[href], button, input, select, textarea, iframe, audio[controls], video[controls], [tabindex="0"]'
    )].filter(el => !el.matches(':disabled, [tabindex="-1"]') && el.getClientRects().length);
    (edge === 'start' ? controls.at(-1) : controls[0])?.focus();
  });
  document.body.appendChild(d);
  d.onclose = () => d.remove();
  d.onclick = (e) => {
    if (e.target === d || e.target.closest('#avClose')) d.close();
    if (e.target.closest('[data-av-ask]')) {
      d.close();
      askArtifactQuestion([it], target);
    }
    if (e.target.closest('#avDrive')) {
      const drvBtn = e.target.closest('#avDrive');
      uploadArtifactToDrive(it, {
        btn: drvBtn,
        sid,
        drawerOptions: { parent: d, focus: true, onClose: () => { box.inert = false; drvBtn.focus(); } },
      });
      if ($('.drw-backdrop', d)) {
        box.inert = true;
        d.append(end);
      }
    }
    if (e.target.closest('#avSend')) {
      sendPathDialog(it.abs || it.path, { parent: d, focus: true, onClose: () => { box.inert = false; send.focus(); } });
      box.inert = true;
      d.append(end);
    }
  };
  d.showModal();
  if (it.kind === 'video') body.innerHTML = `<video controls autoplay playsinline src="${url}" style="max-width:100%;max-height:72vh;background:#000"></video>`;
  else if (it.kind === 'audio') body.innerHTML = `<audio controls autoplay src="${url}" style="width:100%"></audio>`;
  else if (it.kind === 'image') body.innerHTML = `<img src="${url}" style="max-width:100%;max-height:74vh;object-fit:contain">`;
  else if (it.kind === 'pdf' || it.kind === 'html') {
    const frameUrl = it.kind === 'html' && window.isTauriHost?.() ? `${url}${url.includes('?') ? '&' : '?'}hub_ext=1` : url;
    const frame = `<iframe src="${frameUrl}" style="width:100%;height:74vh;border:0;background:#fff"${it.kind === 'html' ? ' sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms"' : ''}></iframe>`;
    body.innerHTML = it.kind === 'html' ? `<div class="artifact-html-surface">${frame}</div>` : frame;
  }
  // PowerPoint / Word: the server renders a PDF (LibreOffice, cached) — first open takes a few seconds
  else if (/^(pptx?|ppsx?|odp|docx?|odt|rtf)$/i.test(it.ext || '')) {
    body.innerHTML = '<div class="empty">슬라이드를 PDF로 변환하는 중… (처음 한 번만 몇 초 걸립니다)</div>';
    const pv = `${url}&preview=pdf`;
    const r = await fetch(pv, { method: 'HEAD' }).catch(() => null);
    if (!r || !r.ok) { body.innerHTML = `<div class="empty">미리보기를 만들지 못했습니다 — 다운로드해서 여세요.</div>`; return; }
    body.innerHTML = `<iframe src="${pv}" style="width:100%;height:74vh;border:0;background:#fff"></iframe>`;
  }
  else if (it.kind === 'markdown' || it.kind === 'text') {
    if (it.size > 3e6) { body.innerHTML = '<div class="empty">파일이 커서 미리보기를 생략합니다 — 새 탭이나 다운로드로 여세요.</div>'; return; }
    let txt;
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      txt = await response.text();
    } catch (error) {
      const message = document.createElement('div');
      message.setAttribute('role', 'alert');
      message.textContent = `미리보기를 불러오지 못했습니다. (${error.message})`;
      body.replaceChildren(message);
      return;
    }
    if (it.kind === 'markdown') {
      body.innerHTML = md(txt);
      window.ACH_PREVIEW?.hydrateMermaid(body);
    }
    else { let t = txt; if (it.ext === 'json') { try { t = JSON.stringify(JSON.parse(txt), null, 2); } catch {} } body.innerHTML = `<pre class="mdpre">${esc(t)}</pre>`; }
  } else body.innerHTML = `<div class="empty">이 형식(${esc(it.ext)})은 브라우저에서 미리 볼 수 없습니다. 다운로드해서 여세요.</div>`;
  if (reviewable) bindArtifactReview(d, body, url, it);
}

function positionReviewMark(mark, { x, y, w, h }) {
  Object.assign(mark.style, { left: x * 100 + '%', top: y * 100 + '%', width: w * 100 + '%', height: h * 100 + '%' });
}

function reviewRegion(media, status, { host, onSelectingChange = () => {}, onCommit, onTap } = {}) {
  const stage = host || document.createElement('div');
  stage.classList.add('review-stage');
  if (!host) {
    media.replaceWith(stage);
    stage.append(media);
  }
  const overlay = document.createElement('div');
  const mark = document.createElement('div');
  overlay.className = 'review-overlay';
  mark.className = 'review-mark';
  overlay.hidden = true;
  mark.hidden = true;
  stage.append(mark, overlay);
  let start, area;
  const setSelecting = selecting => {
    overlay.hidden = !selecting;
    onSelectingChange(selecting);
  };
  const point = (e) => {
    const bounds = stage.getBoundingClientRect();
    const clamp = (n) => Math.max(0, Math.min(1, n));
    return { x: clamp((e.clientX - bounds.left) / bounds.width), y: clamp((e.clientY - bounds.top) / bounds.height) };
  };
  const paint = (end) => {
    area = { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), w: Math.abs(end.x - start.x), h: Math.abs(end.y - start.y) };
    mark.hidden = false;
    positionReviewMark(mark, area);
  };
  const clear = () => { area = null; start = null; mark.hidden = true; };
  const commit = () => {
    if (onCommit) {
      onCommit(area);
      clear();
    } else setSelecting(false);
    status.textContent = '영역 선택됨';
  };
  overlay.onpointerdown = (e) => {
    if (e.button !== 0 || !e.isPrimary) return;
    overlay.setPointerCapture(e.pointerId);
    start = { ...point(e), clientX: e.clientX, clientY: e.clientY };
  };
  overlay.onpointermove = (e) => { if (start && overlay.hasPointerCapture(e.pointerId)) paint(point(e)); };
  overlay.onpointerup = (e) => {
    if (!start || !overlay.hasPointerCapture(e.pointerId)) return;
    const tapped = Math.hypot(e.clientX - start.clientX, e.clientY - start.clientY) <= 5;
    paint(point(e));
    start = null;
    if ((onTap && tapped) || area.w < .004 || area.h < .004) {
      clear();
      status.textContent = '드래그해서 영역을 선택하세요.';
      if (tapped) onTap?.(e.clientX, e.clientY);
    } else commit();
  };
  overlay.onpointercancel = clear;
  return {
    begin() { clear(); setSelecting(true); status.textContent = '드래그해서 영역을 선택하세요.'; stage.scrollIntoView({ block: 'nearest' }); },
    pause() { clear(); setSelecting(false); status.textContent = '원하는 위치로 스크롤한 뒤 영역 선택을 누르세요.'; },
    full() { start = { x: 0, y: 0 }; paint({ x: 1, y: 1 }); start = null; commit(); },
    dispose() {
      if (host) {
        mark.remove();
        overlay.remove();
        host.classList.remove('review-stage');
      } else stage.replaceWith(media);
    },
    clear,
    get selecting() { return !overlay.hidden; },
    get area() { return area; },
  };
}

async function uploadReviewCrop(image, area) {
  await image.decode();
  const sx = Math.floor(area.x * image.naturalWidth), sy = Math.floor(area.y * image.naturalHeight);
  const w = Math.max(1, Math.round(area.w * image.naturalWidth)), h = Math.max(1, Math.round(area.h * image.naturalHeight));
  const scale = Math.min(1, 1600 / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  canvas.getContext('2d').drawImage(image, sx, sy, w, h, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('선택 영역 이미지를 만들 수 없습니다.');
  const r = await fetch('/api/upload?name=review-area.png', { method: 'POST', headers: { 'x-token': TOKEN }, body: blob });
  const data = await r.json();
  if (!r.ok || !data.path) throw new Error(data.error || '선택 영역 이미지를 첨부하지 못했습니다.');
  return data.path;
}

function reviewControls(slot, onSubmit, onCancel, { perRegion = false } = {}) {
  slot.innerHTML = `<form class="review-controls">
    <div class="row"><button type="button" class="btn-sm" data-review-drag>영역 선택</button>
      <button type="button" class="ghost btn-sm" data-review-full>전체 영역</button>
      <span class="ums" role="status"></span></div>
    <textarea rows="2" required maxlength="3000" aria-label="수정 코멘트" placeholder="이 영역에서 바꿀 내용을 입력하세요"></textarea>
    <button class="primary btn-sm"></button><button type="button" class="ghost btn-sm" data-review-cancel>취소</button>
  </form>`;
  const form = $('form', slot), status = $('[role=status]', form), comment = $('textarea', form);
  const drag = $('[data-review-drag]', form);
  const button = $('button.primary', form);
  button.textContent = perRegion ? '이 영역 코멘트 보내기' : '수정 요청';
  let sending = false;
  const sync = () => { button.disabled = sending || comment.disabled || !comment.value.trim(); };
  comment.addEventListener('input', sync);
  sync();
  $('[data-review-cancel]', form).onclick = onCancel;
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (button.disabled) return;
    sending = true;
    comment.readOnly = true;
    sync();
    try { await onSubmit(comment.value.trim(), status); }
    catch (error) { status.textContent = error.message; }
    finally { sending = false; comment.readOnly = false; sync(); }
  };
  return {
    status,
    comment,
    sync,
    get sending() { return sending; },
    setSelecting(selecting) { drag.textContent = selecting ? '위치 이동' : '영역 선택'; },
    connect(picker, allowMove = false) {
      drag.onclick = () => allowMove && picker.selecting ? picker.pause() : picker.begin();
      $('[data-review-full]', form).onclick = () => picker.full();
    },
  };
}

function bindReviewElementPick(media, slot, picker, status, signal, addRegion, isSelected) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ghost btn-sm';
  button.textContent = '요소 지정';
  button.setAttribute('aria-pressed', 'false');
  $('[data-review-full]', slot).after(button);

  const outline = document.createElement('div');
  outline.className = 'review-element-outline';
  outline.setAttribute('aria-hidden', 'true');
  outline.hidden = true;
  media.after(outline);
  let armed = false, target = null;
  const clearTarget = () => {
    if (target) media.contentWindow?.postMessage({ type: 'hub-review-element-clear', request: target.request }, '*');
    target = null;
    outline.hidden = true;
  };
  const disarm = () => {
    armed = false;
    button.setAttribute('aria-pressed', 'false');
  };
  button.onclick = () => {
    const next = !armed;
    picker.begin();
    if (next) {
      armed = true;
      button.setAttribute('aria-pressed', 'true');
      status.textContent = '수정할 요소를 누르세요.';
    } else disarm();
  };
  window.addEventListener('message', event => {
    const { type, request, selector, bounds } = event.data || {};
    if (event.source !== media.contentWindow || type !== 'hub-review-element' || !target
      || !Number.isSafeInteger(request) || target.request !== request) return;
    if (!target.resolved) {
      target.resolved = true;
      if (typeof selector === 'string' && /^#[A-Za-z][A-Za-z0-9_-]{0,47}$/.test(selector)) {
        target.region.element = `HTML 요소: ${selector}`;
      }
    }
    outline.hidden = true;
    if (!Array.isArray(bounds) || bounds.length !== 4 || !bounds.every(Number.isFinite)) {
      target.bounds = null;
      return;
    }
    target.bounds = bounds;
    paint();
  }, { signal });
  function paint() {
    outline.hidden = true;
    if (!target?.bounds || !isSelected(target.region)) return;
    const { bounds } = target;
    const [x, y, w, h] = bounds;
    const left = Math.max(x, 0), top = Math.max(y, 0);
    const width = Math.min(x + w, media.clientWidth) - left;
    const height = Math.min(y + h, media.clientHeight) - top;
    if (width <= 0 || height <= 0) return;
    Object.assign(outline.style, { left: left + 'px', top: top + 'px', width: width + 'px', height: height + 'px' });
    outline.hidden = false;
  }
  media.addEventListener('load', clearTarget, { signal });
  signal.addEventListener('abort', () => { clearTarget(); outline.remove(); }, { once: true });

  return {
    disarm,
    paint,
    remove(region) { if (target?.region === region) clearTarget(); },
    pick(clientX, clientY) {
      if (!armed) return false;
      disarm();
      const rect = media.getBoundingClientRect();
      const x = clientX - rect.left, y = clientY - rect.top;
      if (x < 0 || y < 0 || x >= rect.width || y >= rect.height) return true;
      const request = crypto.getRandomValues(new Uint32Array(1))[0];
      const point = { x: x / rect.width, y: y / rect.height, w: 0, h: 0 };
      const region = addRegion(point, true);
      if (!region) return true;
      clearTarget();
      target = { region, request };
      media.contentWindow?.postMessage({ type: 'hub-review-element-request', request, x, y }, '*');
      status.textContent = '영역 선택됨';
      return true;
    },
  };
}

function startArtifactRegionReview({ initial: media, slot, item, isActive, onSubmit, onStop }) {
  const isHtml = item.kind === 'html';
  const host = isHtml ? media.parentElement : null;
  host?.style.setProperty('--review-frame-height', `${host.getBoundingClientRect().height}px`);
  const listener = new AbortController();
  const dispose = () => {
    if (listener.signal.aborted) return;
    listener.abort();
    markers.remove();
    picker.dispose();
    host?.style.removeProperty('--review-frame-height');
  };
  const stop = () => {
    dispose();
    onStop();
  };
  const regions = new Map();
  let nextRegion = 1, elementPick;
  const tools = reviewControls(slot, async (comment) => {
    const number = selected;
    const region = regions.get(number);
    if (!isActive() || !region || region.sent) return;
    if (region.uncertain && !confirm('CLI가 이미 받았을 수 있습니다. 대화를 확인한 뒤 다시 전송할까요?')) return;
    const context = [region.context, region.element].filter(Boolean).join('\n');
    const message = `아래 산출물의 선택 영역을 코멘트에 따라 수정하고 같은 파일을 업데이트해 주세요.\n#${number}\n${context}\n코멘트: ${comment}`;
    try {
      await onSubmit(message, async () => {
        if (!isActive()) return;
        region.sent = true;
        tools.status.textContent = '이 영역의 코멘트를 보냈습니다.';
        if (matchMedia('(prefers-reduced-motion: no-preference)').matches) {
          await Promise.all([region.mark, region.button].map(el =>
            el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, easing: 'ease-in', fill: 'forwards' }).finished.catch(() => {})));
        }
        if (!isActive() || !regions.has(number)) return;
        removeRegion(number);
        if (!regions.size) stop();
      }, isHtml ? null : [region.area], comment, regions.size > 1);
    } catch (error) {
      region.uncertain = error.delivery !== 'not-sent';
      if (region.uncertain) throw new Error(`전달 여부 확인 필요 · ${error.message}`);
      throw error;
    }
  }, stop, { perRegion: true });
  const list = document.createElement('div');
  list.className = 'row review-regions';
  list.hidden = true;
  tools.comment.before(list);
  const commentLabel = tools.comment.getAttribute('aria-label');
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'ghost btn-sm';
  remove.textContent = '영역 제거';
  $('[data-review-cancel]', slot).before(remove);
  const markers = document.createElement('div');
  markers.className = 'review-markers';
  let selected = null, scroll = null;
  const selectRegion = number => {
    selected = number;
    const region = regions.get(number);
    for (const [id, region] of regions) {
      region.mark.toggleAttribute('data-selected', id === number);
      region.button.setAttribute('aria-pressed', String(id === number));
    }
    elementPick?.paint();
    remove.hidden = !region;
    tools.comment.disabled = !region;
    tools.comment.value = region?.draft || '';
    tools.comment.setAttribute('aria-label', region ? `#${number} · ${commentLabel}` : commentLabel);
    tools.sync();
    if (region) tools.comment.focus();
  };
  const removeRegion = number => {
    const region = regions.get(number);
    elementPick?.remove(region);
    region.mark.remove();
    region.button.remove();
    regions.delete(number);
    list.hidden = !regions.size;
    selectRegion(regions.keys().next().value ?? null);
    if (!regions.size) $('[data-review-drag]', slot).focus();
  };
  remove.onclick = () => {
    if (tools.sending || !regions.has(selected) || regions.get(selected).sent) return;
    removeRegion(selected);
    tools.status.textContent = '';
  };
  tools.comment.oninput = () => {
    const region = regions.get(selected);
    if (!region || tools.sending) return;
    region.draft = tools.comment.value;
    region.button.toggleAttribute('data-has-comment', !!region.draft.trim());
  };
  selectRegion(null);
  const choose = number => {
    if (!tools.sending && regions.has(number)) {
      tools.status.textContent = '';
      selectRegion(number);
    }
  };
  const selectAt = (x, y) => {
    const hit = [...regions].reverse().find(([, { mark }]) => {
      const rect = mark.getBoundingClientRect();
      return !mark.hidden && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    });
    if (hit) choose(hit[0]);
  };
  const updateMarkers = () => {
    for (const { mark, area, documentRect } of regions.values()) {
      if (!documentRect) positionReviewMark(mark, area);
      else {
        const { width, height } = media.getBoundingClientRect();
        if (!width || !height) continue;
        const visibleArea = {
          x: (documentRect.x - scroll.x) / width,
          y: (documentRect.y - scroll.y) / height,
          w: documentRect.w / width,
          h: documentRect.h / height,
        };
        mark.hidden = visibleArea.x >= 1 || visibleArea.y >= 1
          || visibleArea.x + visibleArea.w < 0 || visibleArea.y + visibleArea.h < 0;
        positionReviewMark(mark, visibleArea);
      }
    }
  };
  const addRegion = (area, point = false) => {
    if (tools.sending) return;
    const coords = [area.x, area.y, area.w, area.h].map(value => (value * 100).toFixed(1)).join(', ');
    let context = `선택 영역 (왼쪽%, 위%, 너비%, 높이%): ${coords}`;
    if (point) context = `HTML 클릭 좌표 (왼쪽%, 위%): ${coords.split(', ').slice(0, 2).join(', ')}`;
    let documentRect;
    if (isHtml) {
      const { width, height } = media.getBoundingClientRect();
      const x = area.x * width, y = area.y * height;
      context += `\nHTML 뷰포트: ${Math.round(width)}×${Math.round(height)}`;
      if (scroll) {
        documentRect = { x: x + scroll.x, y: y + scroll.y, w: area.w * width, h: area.h * height };
        context += `\n문서 좌표 (왼쪽, 위, 너비, 높이): ${[documentRect.x, documentRect.y, documentRect.w, documentRect.h].map(Math.round).join(', ')}`;
      }
    } else if (media.naturalWidth && media.naturalHeight) {
      const left = Math.floor(area.x * media.naturalWidth), top = Math.floor(area.y * media.naturalHeight);
      const width = Math.max(1, Math.round(area.w * media.naturalWidth));
      const height = Math.max(1, Math.round(area.h * media.naturalHeight));
      context += `\n원본 이미지 픽셀 (왼쪽, 위, 너비, 높이): ${left}, ${top}, ${width}, ${height}`;
    }
    const number = nextRegion++;
    const mark = document.createElement('div');
    mark.className = 'review-mark';
    mark.textContent = number;
    mark.toggleAttribute('data-point', point);
    markers.append(mark);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ghost btn-sm';
    button.textContent = `#${number}`;
    button.onclick = mark.onclick = () => choose(number);
    const region = { area, documentRect, context, mark, button, draft: '' };
    regions.set(number, region);
    list.hidden = false;
    list.append(button);
    updateMarkers();
    selectRegion(number);
    return region;
  };
  const picker = reviewRegion(media, tools.status, {
    host,
    onSelectingChange(selecting) {
      if (!selecting) elementPick?.disarm();
      if (isHtml) tools.setSelecting(selecting);
    },
    onCommit(area) { elementPick?.disarm(); addRegion(area); },
    onTap(x, y) { if (!elementPick?.pick(x, y)) selectAt(x, y); },
  });
  media.after(markers);
  tools.connect(picker, isHtml);
  if (isHtml) {
    elementPick = bindReviewElementPick(media, slot, picker, tools.status, listener.signal, addRegion,
      region => regions.get(selected) === region);
    const options = { signal: listener.signal };
    const requestScroll = () => media.contentWindow?.postMessage({ type: 'hub-review-scroll-request' }, '*');
    window.addEventListener('message', event => {
      const { type, x, y } = event.data || {};
      if (event.source !== media.contentWindow || type !== 'hub-review-scroll' || !Number.isFinite(x) || !Number.isFinite(y)) return;
      scroll = { x, y };
      updateMarkers();
    }, options);
    media.addEventListener('load', requestScroll, options);
    requestScroll();
  }
  picker.begin();
  return dispose;
}

function bindArtifactReview(dialog, body, url, item) {
  const slot = $('[data-av-review-slot]', dialog);
  const trigger = $('[data-av-review]', dialog);
  const refreshButton = $('[data-av-refresh]', dialog);
  const capture = $('[data-av-capture]', dialog);
  const initial = $('img,iframe', body);
  const originalUrl = initial.src;
  let active = false, revision = '', watching = false, refreshTimer, disposeReview, uncertain = false;
  const file = quotePath(item.abs || item.path);
  const sendReview = async (message, attachment, onSent, regions, comment, hasOtherRegions = false) => {
    const term = currentReviewTerminal();
    if (term?.agent) {
      if (uncertain && !confirm('CLI가 이미 받았을 수 있습니다. 대화를 확인한 뒤 다시 전송할까요?')) return;
      const text = [message, file, attachment ? quotePath(attachment) : ''].filter(Boolean).join('\n');
      try {
        await sendWithRegionCheck(initial, item, regions, { kind: 'term', id: term.id }, text, async () => {
          const result = await api('/api/term/send', { method: 'POST', body: { id: term.id, text, submit: true } });
          if (!result.ok) throw Object.assign(new Error(result.error || '터미널 입력을 확인하지 못했습니다.'), { delivery: result.delivery });
        }, comment);
      } catch (error) {
        if (comment !== undefined) throw error;
        uncertain = error.delivery !== 'not-sent';
        throw new Error(uncertain ? `전달 여부 확인 필요 · ${error.message}` : error.message);
      }
      uncertain = false;
      await onSent();
      toast('세션에 보냈습니다');
      return;
    }
    if (!hasOtherRegions && typeof stageReviewInChat === 'function' && stageReviewInChat(`${message}\n${file}`, attachment)) {
      dialog.close();
      return;
    }
    const box = $('.aview', dialog);
    sendPathDialog(item.abs || item.path, {
      parent: dialog, focus: true, attachment, message, onSent,
      onClose: () => { box.inert = false; ($('textarea', slot) || capture || trigger).focus(); },
    });
    box.inert = true;
    dialog.append($('[data-av-edge=end]', dialog));
  };
  if (capture) capture.onclick = async () => {
    try {
      await openScreenReview(async (comment, attachment) => {
        if (!dialog.open) return;
        await sendReview(`첨부한 화면 영역의 코멘트를 반영해 이 HTML 산출물 파일을 업데이트해 주세요.\n코멘트: ${comment}`, attachment, checkRevision);
      });
    } catch (error) { if (error.name !== 'NotAllowedError') toast(error.message, 6000, 'danger'); }
  };
  const refresh = () => {
    const updated = new URL(originalUrl);
    updated.searchParams.set('v', String(Date.now()));
    initial.src = updated.href;
  };
  refreshButton.onclick = refresh;
  dialog.addEventListener('close', () => {
    clearInterval(refreshTimer);
    disposeReview?.();
  }, { once: true });
  async function checkRevision() {
    if (watching || !dialog.open || active || document.hidden) return;
    watching = true;
    try {
      const r = await fetch(url, { method: 'HEAD', cache: 'no-store' });
      const etag = r.ok ? r.headers.get('etag') : null;
      if (etag && revision && etag !== revision) refresh();
      if (etag) revision = etag;
    } catch {} finally { watching = false; }
  }
  void checkRevision();
  refreshTimer = setInterval(checkRevision, 5000);

  trigger.onclick = () => {
    if (active) return;
    active = true;
    trigger.disabled = true;
    refreshButton.disabled = true;
    if (capture) capture.disabled = true;
    const stopReview = () => {
      active = false;
      disposeReview = null;
      slot.replaceChildren();
      trigger.disabled = false;
      refreshButton.disabled = false;
      if (capture) capture.disabled = false;
      trigger.focus();
      void checkRevision();
    };
    try {
      disposeReview = startArtifactRegionReview({
        initial, slot, item, isActive: () => dialog.open && active,
        onSubmit: (message, sent, regions, comment, hasOtherRegions) =>
          sendReview(message, '', sent, regions, comment, hasOtherRegions),
        onStop: stopReview,
      });
    } catch (error) {
      stopReview();
      slot.textContent = error.message;
    }
  };
}

async function openScreenReview(onReady) {
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false, preferCurrentTab: true });
  const video = document.createElement('video');
  video.muted = true;
  video.srcObject = stream;
  let blob;
  try {
    await video.play();
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  } finally {
    stream.getTracks().forEach(track => track.stop());
    video.srcObject = null;
  }
  if (!blob) throw new Error('화면을 캡처하지 못했습니다.');
  const url = URL.createObjectURL(blob);
  const dialog = document.createElement('dialog');
  dialog.className = 'dlg artifact-preview';
  dialog.setAttribute('aria-label', '화면 영역 코멘트');
  dialog.innerHTML = '<div class="box wide aview"><div data-screen-controls></div><div class="avbody"><img alt="선택한 공유 화면" class="review-screenshot"></div></div>';
  const image = $('img', dialog);
  image.src = url;
  document.body.append(dialog);
  dialog.onclose = () => { URL.revokeObjectURL(url); dialog.remove(); };
  dialog.showModal();
  let picker;
  const controls = reviewControls($('[data-screen-controls]', dialog), async (comment) => {
    if (!picker.area || !comment) throw new Error('영역과 코멘트를 입력하세요.');
    const attachment = await uploadReviewCrop(image, picker.area);
    if (!dialog.open) return;
    await onReady(comment, attachment);
    dialog.close();
  }, () => dialog.close());
  picker = reviewRegion(image, controls.status);
  controls.connect(picker);
  $('[data-review-drag]', dialog).focus();
}
