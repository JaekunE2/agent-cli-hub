// ---------- files → paths (drag & drop / paste), like Windows Terminal ----------
// Browsers hide a dropped file's real path, so first ask the server to find the
// original on disk (name + size + mtime); if that fails (e.g. a clipboard
// screenshot), upload a copy into hub\uploads and use that path.
const IS_MOBILE = matchMedia('(max-width: 760px), (pointer: coarse)').matches;
// opened from another device (Tailscale): hide buttons that act on this PC's desktop (open folder, ...)
const IS_REMOTE = !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(location.hostname);
if (IS_REMOTE) document.body.classList.add('remote');
const IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|bmp|svg)$/i;
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
    stripEl.innerHTML = items.map((it) => {
      const visual = it.thumbUrl
        ? `<img class="att-thumb" src="${esc(it.thumbUrl)}" alt="">`
        : `<span class="att-chip-ext">${esc(it.ext)}</span>`;
      const meta = it.loading
        ? '<span class="att-chip-sz">준비 중…</span>'
        : it.failed
          ? '<span class="att-chip-sz" style="color:var(--danger)">실패</span>'
          : (it.size ? `<span class="att-chip-sz">${esc(fmtSize(it.size))}</span>` : '');
      return `<span class="att-chip" title="${esc(it.path || it.name)}">${visual}<span class="att-chip-name">${esc(it.name)}</span>${meta}<button type="button" class="att-chip-rm" data-att-rm="${it.id}" aria-label="첨부 파일 제거" title="첨부 파일 제거">×</button></span>`;
    }).join('');
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

  const addFiles = (fileList, dtItems = []) => {
    const arr = [...(fileList || [])];
    if (!arr.length) return;
    const itemEntries = [...(dtItems || [])];
    if (itemEntries.some((it) => it.webkitGetAsEntry?.()?.isDirectory)) toast('폴더는 경로를 알 수 없어 제외합니다 (파일만 가능)');
    for (let i = 0; i < arr.length; i++) {
      if (itemEntries[i]?.webkitGetAsEntry?.()?.isDirectory) continue;
      const f = arr[i];
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
    hasItems: () => items.length > 0,
    isLoading: () => items.some((x) => x.loading),
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
  const handle = async (dt) => {
    const files = clipFiles(dt);
    const items = [...(dt.items || [])];
    if (!files.length) return;
    if (typeof opts.onFiles === 'function' && opts.onFiles(files, items) !== false) return;
    if (items.some((it) => it.webkitGetAsEntry?.()?.isDirectory)) toast('폴더는 경로를 알 수 없어 제외합니다 (파일만 가능)');
    const paths = [];
    for (let i = 0; i < files.length; i++) {
      if (items[i]?.webkitGetAsEntry?.()?.isDirectory) continue;
      const p = await fileToPath(files[i], cwd).catch(() => null);
      if (p) paths.push(quotePath(p));
    }
    if (paths.length && insert) insert(paths.join(' ') + ' ');
  };
  el.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); el.classList.add('dropping'); } });
  el.addEventListener('dragleave', (e) => { if (!el.contains(e.relatedTarget)) el.classList.remove('dropping'); });
  el.addEventListener('drop', (e) => {
    el.classList.remove('dropping');
    if (!e.dataTransfer?.files?.length) return;
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
document.addEventListener('paste', async (e) => {
  const box = e.target.closest?.('textarea, input:not([type]), input[type=text], input[type=search]');
  if (!box || box.closest('[data-file-input]') || box.classList.contains('xterm-helper-textarea')) return;
  const files = clipFiles(e.clipboardData);
  if (!files.length) return;
  e.preventDefault();
  const paths = [];
  for (const f of files) { const p = await fileToPath(f, null).catch(() => null); if (p) paths.push(quotePath(p)); }
  if (!paths.length) return toast('붙여넣은 파일을 올리지 못했습니다');
  const txt = paths.join(' ') + ' ', a = box.selectionStart ?? box.value.length, b = box.selectionEnd ?? a;
  box.value = box.value.slice(0, a) + txt + box.value.slice(b);
  box.selectionStart = box.selectionEnd = a + txt.length;
  box.dispatchEvent(new Event('input', { bubbles: true }));
  box.focus();
});


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
const artUrl = (sid, p) => `/api/artifact-file?session=${encodeURIComponent(sid)}&path=${encodeURIComponent(p)}&t=${encodeURIComponent(TOKEN)}`;
window.artUrl = artUrl;
const rRawUrl = (slug, rel) => `/api/research/raw?slug=${encodeURIComponent(slug)}&path=${encodeURIComponent(rel)}&t=${encodeURIComponent(TOKEN)}`;
const fmtSize = (n) => (n > 1e9 ? `${(n / 1e9).toFixed(1)}GB` : n > 1e6 ? `${(n / 1e6).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`);
// wrap Windows / git-bash paths with a viewable extension (already HTML-escaped text) as compact clickable file chips
function linkPaths(html) {
  const extPattern = 'mp4|webm|mov|mkv|pdf|png|jpe?g|gif|webp|svg|html?|md|txt|log|csv|json|ya?ml|tex|py|js|ts|tsx|jsx|css|ply|glb|obj|docx|xlsx|pptx';
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
  if (!sid) return toast('세션을 알 수 없습니다');
  const want = a.dataset.apath.replace(/&amp;/g, '&').replace(/^\/([a-z])\//i, (x, d) => `${d.toUpperCase()}:\\`).replace(/\//g, '\\').toLowerCase();
  const { items = [] } = await api(`/api/artifacts?session=${encodeURIComponent(sid)}`);
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

// research outputs are listed relative to the project folder
const rAbs = (dir, rel) => `${String(dir || '').replace(/[\\/]+$/, '')}\\${String(rel).replace(/\//g, '\\')}`;

// A PC file (session output, research output) → a running dashboard terminal: the path goes into its
// input (with a message: sent). Sessions open the path themselves — nothing is copied.
function sendPathDialog(abs, drawerOptions = {}) {
  const targets = state.terms.filter((t) => t.exited === null).map((t) => ({ id: t.id, label: termLabel(t) }));
  const cur = state.sel.kind === 'term' ? String(state.sel.id) : null;
  const body = `
    <div class="mono" style="word-break:break-all">${esc(abs)}</div>
    <label>보낼 세션<br>${targets.length ? `<select id="spT" style="width:100%">${targets.map((t) => `<option value="${esc(t.id)}" ${String(t.id) === cur ? 'selected' : ''}>t:${esc(t.id)} ${esc(t.label)}</option>`).join('')}</select>` : '<div class="empty">열려 있는 대시보드 터미널이 없습니다</div>'}</label>
    <label>함께 보낼 말 (비우면 경로만 입력칸에 넣고 전송하지 않음)<br><textarea id="spM" rows="3" style="width:100%" placeholder="예: 이 결과 보고 다음 실험 계획 세워줘"></textarea></label>`;
  const d = openDrawer({ title: '세션에 보내기', bodyHTML: body, footerHTML: `<button data-drw-close>취소</button><button class="primary" id="spOk" ${targets.length ? '' : 'disabled'}>보내기</button>`, width: 440, ...drawerOptions });
  $('#spOk', d).onclick = async () => {
    $('#spOk', d).disabled = true;
    const msg = $('#spM', d).value.trim();
    const text = (msg ? msg + ' ' : '') + quotePath(abs) + (msg ? '' : ' ');
    const r = await api('/api/term/send', { method: 'POST', body: { id: $('#spT', d).value, text, submit: !!msg } });
    d.close();
    toast(r.error ? r.error : msg ? '세션에 보냈습니다' : '경로를 세션 입력칸에 넣었습니다');
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
async function renderArtifacts(sid, gen) {
  $('#view').innerHTML = '<div class="empty" style="padding:20px">산출물 찾는 중…</div>';
  let query = '';
  let showCards = false;
  const paint = async () => {
    const r = await api(`/api/artifacts?session=${encodeURIComponent(sid)}`).catch((e) => ({ error: e.message }));
    if (gen !== viewGen) return;
    if (r.error) { $('#view').innerHTML = `<div class="err">${esc(r.error)}</div>`; return; }
    const all = r.items || [];
    const items = artShowAll ? all : all.filter((x) => x.main);
    const card = ([it, i]) => {
      const location = String(it.path || '').split(/[\\/]/).slice(0, -1).filter(Boolean).slice(-2).join('/');
      return `<div class="acard" data-ai="${i}">
        <button class="artifact-open" type="button">
        <span class="athumb">${it.kind === 'image' ? `<img loading="lazy" src="${artUrl(sid, it.path)}" alt="">` : `<span>${ART_ICON[it.kind] || ART_ICON.file}</span>`}</span>
        <span class="ameta"><b title="${esc(it.path)}">${esc(it.title || it.name)}</b>
          <span class="artifact-location" title="${esc(it.path)}">${esc(location)}</span>
          <span class="ums">${esc(it.ext.toUpperCase())} · ${fmtSize(it.size)} · ${relTime(it.mtime)}${it.source === 'pinned' ? ' · 지정됨' : ''}</span></span></button>
        <button class="ahide" data-ahide="${i}" aria-label="목록에서 숨기기" title="목록에서 숨기기">${ICO.close}</button><button class="asend" data-asend="${i}" aria-label="세션에 보내기" title="이 파일을 세션에 보내기 (경로 멘션)">${ICO.arrowUpRight}</button></div>`;
    };
    $('#view').innerHTML = `<div class="subtoolbar">
        <div class="seg" role="tablist" aria-label="산출물 범위">
          <button data-art-scope="main" class="${!artShowAll ? 'on' : ''}">주요 산출물 <span class="seg-cnt">${all.filter((x) => x.main).length}</span></button>
          <button data-art-scope="all" class="${artShowAll ? 'on' : ''}">전체 파일 <span class="seg-cnt">${all.length}</span></button>
        </div>
        <span class="sp"></span>
        <input id="artSearch" class="btn-sm" type="search" aria-label="파일명 · 폴더 · 형식 검색" placeholder="파일명 · 폴더 · 형식" value="${esc(query)}">
        <button class="btn-sm" type="button" id="artLayout" aria-pressed="${showCards}">카드 보기</button>
        ${artOrderSel()}
        <button id="artAdd" class="btn-sm">${ICO.plus} 산출물 지정</button>
      </div>
      <div class="rwrap session-artifacts${showCards ? '' : ' artifact-list'}">
      ${items.length ? artTimeline(items.map((it, i) => [it, i]), card) : `<div class="h-empty-card" style="margin-top:8px"><b>아직 등록된 산출물이 없습니다</b><span class="ums" style="margin:0;max-width:460px">대화에 나온 파일 경로가 자동으로 모이며, 직접 파일을 지정하거나 코드 구조 탭에서 보고서(FLOORPLAN.md)를 저장할 수 있습니다.</span><button type="button" class="primary btn-sm" id="artEmptyAdd" style="margin-top:6px">${ICO.plus} 산출물 지정</button></div>`}</div>`;
    bindArtOrder(paint);
    const filterRows = () => {
      const keywords = termsOf(query);
      const rows = [...$('#view').querySelectorAll('[data-ai]')];
      for (const row of rows) {
        const { title, name, path, ext } = items[Number(row.dataset.ai)];
        const label = [title, name, path, ext].join(' ').toLowerCase();
        row.hidden = !keywords.every((term) => label.includes(term));
      }
      for (const heading of $('#view').querySelectorAll('.session-artifacts .aday')) {
        heading.hidden = !heading.nextElementSibling.querySelector('[data-ai]:not([hidden])');
      }
      $('#artNoMatch').hidden = !rows.length || rows.some((row) => !row.hidden);
    };
    $('.session-artifacts').insertAdjacentHTML('beforeend', '<p id="artNoMatch" class="empty" hidden>일치하는 파일이 없습니다</p>');
    $('#artSearch').oninput = (e) => { query = e.target.value; filterRows(); };
    $('#artLayout').onclick = (e) => {
      showCards = !showCards;
      e.currentTarget.setAttribute('aria-pressed', String(showCards));
      $('.session-artifacts').classList.toggle('artifact-list', !showCards);
    };
    filterRows();
    $('#view').querySelectorAll('[data-art-scope]').forEach((b) => (b.onclick = () => { artShowAll = b.dataset.artScope === 'all'; paint(); }));
    $('#artAdd').onclick = () => addArtifactDialog(sid, paint);
    const emptyAdd = $('#artEmptyAdd');
    if (emptyAdd) emptyAdd.onclick = () => addArtifactDialog(sid, paint);
    $('#view').querySelectorAll('[data-ai]').forEach((el) => (el.onclick = (e) => {
      if (e.target.closest('[data-ahide]')) return;
      const sb = e.target.closest('[data-asend]');
      if (sb) return sendPathDialog(items[Number(sb.dataset.asend)].path);
      openArtifact(sid, items[Number(el.dataset.ai)]);
    }));
    $('#view').querySelectorAll('[data-ahide]').forEach((b) => (b.onclick = async (e) => {
      e.stopPropagation();
      await api('/api/artifacts/hide', { method: 'POST', body: { session: sid, path: items[Number(b.dataset.ahide)].path } });
      paint();
    }));
  };
  paint();
}
function addArtifactDialog(sid, done) {
  const body = `
    <label>파일 경로<br><input id="apPath" style="width:100%" placeholder="예: C:\\work\\project\\out\\result.mp4 — 파일을 여기로 끌어놓아도 됩니다"></label>
    <label>이름 (선택)<br><input id="apTitle" style="width:100%" placeholder="예: 최종 비교 영상"></label>`;
  const d = openDrawer({ title: '산출물 지정', bodyHTML: body, footerHTML: '<button data-drw-close>취소</button><button class="primary" id="apOk">추가</button>', width: 440 });
  attachFileInput($('.drw-body', d), (txt) => { $('#apPath', d).value = txt.trim().replace(/^"|"$/g, ''); }, null);
  $('#apOk', d).onclick = async () => {
    const r = await api('/api/artifacts/add', { method: 'POST', body: { session: sid, path: $('#apPath', d).value.trim(), title: $('#apTitle', d).value.trim() || undefined } });
    if (r.error) return toast(r.error, 6000);
    d.close(); toast('산출물로 지정했습니다'); done && done();
  };
}
async function openArtifact(sid, it, url = artUrl(sid, it.path)) {
  const d = document.createElement('dialog');
  d.className = 'dlg artifact-preview';
  d.setAttribute('aria-labelledby', 'avTitle');
  d.innerHTML = `<span class="sr-only" tabindex="0" data-av-edge="start"></span>
    <div class="box wide aview"><div class="row avhead"><b id="avTitle" title="${esc(it.path)}">${ART_ICON[it.kind] || ''} ${esc(it.title || it.name)}</b>
      <a class="btnlike btn-sm" href="${url}" target="_blank" rel="noopener">${ICO.external} 새 탭</a><a class="btnlike btn-sm" href="${url}&dl=1" download="${esc(it.name)}">다운로드</a><button class="primary btn-sm" id="avSend" title="이 파일 경로를 세션에 보내기">${ICO.arrowUpRight} 세션에</button><button class="ghost icon-btn btn-sm" id="avClose" autofocus aria-label="닫기">${ICO.close}</button></div>
    <div class="ums mono" style="word-break:break-all">${esc(it.path)} · ${fmtSize(it.size)}</div>
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
  else if (it.kind === 'pdf' || it.kind === 'html') body.innerHTML = `<iframe src="${url}" style="width:100%;height:74vh;border:0;background:#fff"${it.kind === 'html' ? ' sandbox="allow-scripts allow-popups"' : ''}></iframe>`;
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
    const txt = await (await fetch(url)).text();
    if (it.kind === 'markdown') {
      body.innerHTML = md(txt);
      window.ACH_PREVIEW?.hydrateMermaid(body);
    }
    else { let t = txt; if (it.ext === 'json') { try { t = JSON.stringify(JSON.parse(txt), null, 2); } catch {} } body.innerHTML = `<pre class="mdpre">${esc(t)}</pre>`; }
  } else body.innerHTML = `<div class="empty">이 형식(${esc(it.ext)})은 브라우저에서 미리 볼 수 없습니다. 다운로드해서 여세요.</div>`;
}
