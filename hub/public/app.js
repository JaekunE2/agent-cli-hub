// Agent CLI Hub — frontend
const qs = new URLSearchParams(location.search);
let TOKEN = qs.get('t') || '';
try { if (TOKEN) localStorage.setItem('ccd-token', TOKEN); else TOKEN = localStorage.getItem('ccd-token') || ''; } catch {}
// opened on this PC (127.0.0.1/localhost): the server put the token into the page — any browser profile works
if (window.__CCD_LOCAL_TOKEN && TOKEN !== window.__CCD_LOCAL_TOKEN) { TOKEN = window.__CCD_LOCAL_TOKEN; try { localStorage.setItem('ccd-token', TOKEN); } catch {} }
if (qs.get('t')) { qs.delete('t'); history.replaceState(null, '', '/' + (qs.toString() ? '?' + qs : '')); }

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ago = (ms) => {
  if (!ms) return '';
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return '방금';
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  return `${Math.floor(s / 86400)}일 전`;
};
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const termsOf = (q) => String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
// Escape text and wrap every occurrence of any term in <mark>.
function hl(text, terms) {
  if (!terms || !terms.length) return esc(text);
  const re = new RegExp(terms.map(reEsc).join('|'), 'gi');
  let out = '', last = 0, m;
  while ((m = re.exec(text))) { out += esc(text.slice(last, m.index)) + '<mark>' + esc(m[0]) + '</mark>'; last = m.index + m[0].length; if (!m[0]) re.lastIndex++; }
  return out + esc(text.slice(last));
}
const base = (p) => (p || '').split(/[\\/]/).filter(Boolean).pop() || p || '';

async function api(path, opts = {}) {
  const r = await fetch(path, {
    ...opts,
    headers: { 'x-token': TOKEN, 'content-type': 'application/json', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (r.status === 401) throw new Error('토큰이 없거나 틀립니다. 서버 콘솔/url.txt의 주소로 여세요.');
  return r.json();
}

const state = {
  sel: { kind: 'home' }, tab: 'screen', showHidden: false, favs: new Set(), showDesktop: (() => { try { return !!localStorage.getItem('ccd-show-desktop'); } catch { return false; } })(),
  live: [], consoles: [], terms: [], recent: [], err: null,
  usage: null, research: [], gpu: null,
  filter: '', search: { q: '', role: 'all', cwd: '', auto: false, screens: true },
};
let viewTimer = null, viewGen = 0, xterm = null, xws = null, minis = [], homeKey = '';

// ---------- data ----------
async function refreshOverview() {
  try {
    const o = await api('/api/overview');
    Object.assign(state, { live: o.live || [], consoles: o.consoles || [], terms: o.terms || [], err: o.consoleError || null });
    if (Array.isArray(o.favs)) state.favs = new Set(o.favs);
    state.disk = o.disk || null;
    state.consolesOff = !!o.consolesOff;
  } catch (e) { state.err = e.message; }
  renderSide();
  if (state.sel.kind === 'home' && homeKeyOf() !== homeKey) select({ kind: 'home' });
}
async function refreshRecent() {
  try { state.recent = (await api('/api/recent?n=30')).sessions || []; } catch {}
  renderSide();
}

const consoleOf = (pid) => state.consoles.find((c) => c.pids.includes(pid));
const sessionOfConsole = (c) => state.live.find((s) => c.pids.includes(s.pid));
// claude sets its terminal title to the session name ("✳ task"); strip the status glyph
const stripGlyph = (s) => String(s || '').replace(/^[^\p{L}\p{N}]+\s*/u, '');
function termLabel(t) {
  if (t.operator) return '🛰 관제 세션';
  // the Windows console title of the terminal's own console is the freshest (Claude renames it as the
  // work changes); the title captured from the output stream can lag behind, e.g. after an account switch
  const con = t.pid && state.consoles.find((c) => c.managed && (c.pids || []).includes(t.pid));
  const ct = stripGlyph(con?.title || '');
  let lt = ct && !/^[A-Za-z]:\\/.test(ct) && !/^(claude code|claude|windows powershell|powershell|cmd)$/i.test(ct) ? ct : stripGlyph(t.liveTitle);
  if (/^[A-Za-z]:\\/.test(lt)) lt = base(lt).replace(/\.exe$/i, ''); // shells title themselves with their exe path
  const generic = !lt || /^(claude code|claude)$/i.test(lt);
  return (!generic && lt) || t.sessionName || lt || t.title;
}
function consoleLabel(c) {
  const mt = c.managed && state.terms.find((t) => t.pid && c.pids.includes(t.pid));
  if (mt) return termLabel(mt);
  const s = sessionOfConsole(c);
  const title = (c.title || '').replace(/^[^\p{L}\p{N}]+\s*/u, '');
  return title || (s ? s.name : c.procs[0]?.name) || `pid ${c.id}`;
}
// sessions the Claude desktop app runs headless (stream-json over pipes): no screen to show
const isDesktopSession = (s) => s?.entrypoint === 'claude-desktop';
const desktopConsole = (c) => c.pids.some((p) => isDesktopSession(state.live.find((s) => s.pid === p)));
const visibleConsoles = () => state.consoles.filter((c) => (state.showHidden || c.visible) && !c.managed && !desktopConsole(c));

// ---------- sidebar ----------
function itemHTML({ key, dot, title, sub, badge, depth = 0, fold = '' }) {
  const f = termsOf(state.filter);
  if (f.length && key !== 'home' && key !== 'search') {
    const hay = `${title} ${sub}`.toLowerCase();
    if (!f.every((t) => hay.includes(t))) return '';
  }
  const sel = key === selKey() ? ' sel' : '';
  const fk = favKeyOf(key), on = !!fk && (state.favs || new Set()).has(fk);
  const star = fk ? `<span class="fav${on ? ' on' : ''}" data-fav="${esc(fk)}" title="${on ? '즐겨찾기에서 빼기' : '즐겨찾기 (맨 위에 표시)'}">${on ? '★' : '☆'}</span>` : '';
  return `<div class="item${sel}${depth ? ' sub' : ''}" data-key="${esc(key)}"${depth ? ` style="margin-left:${depth * 16}px"` : ''}>${fold}<span class="dot ${dot || ''}"></span>
    <div class="body"><div class="t">${hl(title, f)} ${badge || ''}</div><div class="s">${hl(sub || '', f)}</div></div>${star}</div>`;
}
// sidebar key → favorite key: a Claude session by its session id (same star whether it is live, in a
// dashboard terminal or only in history), other terminals by terminal id
function favKeyOf(key) {
  const i = key.indexOf(':');
  if (i < 0) return null;
  const kind = key.slice(0, i), id = key.slice(i + 1);
  if (kind === 'session' || kind === 'recent') return `sid:${id}`;
  if (kind === 'term') { const t = state.terms.find((x) => x.id === id); return t?.sessionId ? `sid:${t.sessionId}` : `term:${id}`; }
  return null;
}
function selKey() {
  const s = state.sel;
  return ['home', 'search', 'usage', 'gpu', 'calendar'].includes(s.kind) ? s.kind : `${s.kind}:${s.id}`;
}
// which agent CLI a session / terminal belongs to (Claude Code is the default and gets no badge in lists)
function agentBadge(agent) {
  if (agent === 'codex') return '<span class="badge cx">Codex</span>';
  if (agent === 'cursor') return '<span class="badge">Cursor</span>';
  return '';
}
function renderSide() {
  const liveIds = new Set(state.live.map((s) => s.sessionId));
  const cons = visibleConsoles();
  let h = `<div class="sec">${itemHTML({ key: 'home', title: '전체 화면 모아보기', sub: `창 ${cons.length}개 · 대시보드 터미널 ${state.terms.length}개 · Claude 세션 ${state.live.length}개` })}</div>`;
  h += calendarSideHTML();
  h += gpuSideHTML();
  h += researchSideHTML();
  h += usageSideHTML();
  if (state.filter.trim()) h += `<div class="sec">${itemHTML({ key: 'search', title: `“${state.filter.trim()}” 대화 전체 검색`, sub: 'Enter · 모든 세션 기록 + 열린 창 화면' })}</div>`;
  if (state.disk) h = `<div class="err" style="font-weight:600">⚠ ${esc(state.disk.drive)} 남은 공간 ${state.disk.freeGB} GB — 0이 되면 세션이 멈춥니다. 정리가 필요합니다.</div>` + h;
  if (state.err) h += `<div class="err">${esc(state.err)}</div>`;

  const liveItem = (s) => itemHTML({
    key: `session:${s.sessionId}`, dot: s.status === 'busy' ? 'busy' : 'idle',
    title: (isDesktopSession(s) ? s.name : consoleOf(s.pid) && consoleLabel(consoleOf(s.pid))) || s.name || s.sessionId.slice(0, 8),
    sub: `${s.status === 'busy' ? '작업 중' : '대기'} · ${base(s.cwd)} · ${ago(s.updatedAt)}`,
    badge: (s.limit ? '<span class="badge lim">한도</span>' : '') + (isDesktopSession(s) ? '<span class="badge">데스크톱 앱</span>' : consoleOf(s.pid) || state.consolesOff ? '' : '<span class="badge">창 없음</span>'),
  });
  const termItem = (t) => itemHTML({
    key: `term:${t.id}`, dot: t.exited !== null ? 'dead' : t.status === 'busy' ? 'busy' : 'idle', title: termLabel(t),
    sub: `${t.exited !== null ? '종료됨 (' + t.exited + ')' : t.status === 'busy' ? '작업 중' : t.status === 'idle' ? '대기' : '실행 중'} · ${base(t.cwd)}`,
    badge: t.agent && t.agent !== 'claude' ? agentBadge(t.agent) : '',
  });
  const recentItem = (r) => itemHTML({
    key: `recent:${r.sessionId}`, dot: 'dead', title: r.title || r.firstPrompt || r.sessionId.slice(0, 8),
    sub: `${base(r.cwd)} · ${ago(r.mtime)}`, badge: agentBadge(r.agent),
  });

  // ⭐ favorites first (stored on the server: same list on the PC and the phone)
  const favs = state.favs || new Set();
  const isFav = (key) => { const f = favKeyOf(key); return !!f && favs.has(f); };
  const favItems = [];
  for (const f of favs) {
    if (f.startsWith('sid:')) {
      const sid = f.slice(4);
      const s = state.live.find((x) => x.sessionId === sid);
      const t = !s && state.terms.find((x) => x.sessionId === sid && x.exited === null);
      const r = !s && !t && state.recent.find((x) => x.sessionId === sid);
      favItems.push(s ? liveItem(s) : t ? termItem(t) : r ? recentItem(r) : itemHTML({ key: `recent:${sid}`, dot: 'dead', title: sid.slice(0, 8), sub: '세션 기록' }));
    } else if (f.startsWith('term:')) {
      const t = state.terms.find((x) => x.id === f.slice(5));
      if (t) favItems.push(termItem(t));
    }
  }
  if (favItems.length) h += `<div class="sec"><h2>⭐ 즐겨찾기</h2>${favItems.join('')}</div>`;

  // Claude desktop-app chats are hidden unless asked for (they crowd the list)
  const deskN = state.live.filter(isDesktopSession).length;
  const liveShown = state.live.filter((s) => (state.showDesktop || !isDesktopSession(s)) && !isFav(`session:${s.sessionId}`));
  h += `<div class="sec"><h2>실행 중 Claude 세션<span class="sp"></span>
    ${deskN ? `<label title="Claude 데스크톱 앱이 띄운 대화"><input type="checkbox" id="chkDesktop" ${state.showDesktop ? 'checked' : ''}> 데스크톱 앱 ${deskN}</label>` : ''}</h2>`;
  h += liveShown.length ? liveShown.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).map(liveItem).join('') : '<div class="empty">없음</div>';
  h += '</div>';

  if (!state.consolesOff) h += `<div class="sec"><h2>열린 콘솔 창<span class="sp"></span>
    <label><input type="checkbox" id="chkHidden" ${state.showHidden ? 'checked' : ''}> 숨은 창</label></h2>`;
  if (!state.consolesOff) h += cons.length ? cons.map((c) => {
    const s = sessionOfConsole(c);
    return itemHTML({
      key: `console:${c.id}`, dot: s ? (s.status === 'busy' ? 'busy' : 'idle') : '',
      title: consoleLabel(c), sub: c.procs.map((p) => p.name.replace(/\.exe$/, '')).join(' › '),
      badge: s ? '<span class="badge c">claude</span>' : (c.visible ? '' : '<span class="badge">숨김</span>'),
    });
  }).join('') : '<div class="empty">없음</div>';
  if (!state.consolesOff) h += '</div>';

  h += `<div class="sec"><h2>대시보드 터미널</h2>`;
  const termsShown = state.terms.filter((t) => !isFav(`term:${t.id}`));
  h += termsShown.length ? termsShown.map(termItem).join('') : state.terms.length ? '<div class="empty">모두 즐겨찾기에 있음</div>' : '<div class="empty">＋ 새로 열기로 여기서 직접 claude/터미널을 띄울 수 있습니다</div>';
  h += '</div>';

  h += `<div class="sec"><h2>최근 세션 기록</h2>`;
  h += state.recent.filter((r) => !liveIds.has(r.sessionId) && !isFav(`recent:${r.sessionId}`)).slice(0, 25).map(recentItem).join('') || '<div class="empty">없음</div>';
  h += '</div>';

  const side = $('#side'), top = side.scrollTop;
  side.innerHTML = h;
  side.scrollTop = top;
}
$('#side').addEventListener('click', (e) => {
  if (e.target.id === 'chkHidden') { state.showHidden = e.target.checked; renderSide(); if (state.sel.kind === 'home') select({ kind: 'home' }); return; }
  if (e.target.id === 'chkDesktop') { state.showDesktop = e.target.checked; try { localStorage.setItem('ccd-show-desktop', state.showDesktop ? '1' : ''); } catch {} renderSide(); return; }
  const star = e.target.closest('[data-fav]');
  if (star) {
    e.stopPropagation();
    const key = star.dataset.fav, on = !(state.favs || new Set()).has(key);
    api('/api/favorites', { method: 'POST', body: { key, on } }).then((r) => { if (r.favs) { state.favs = new Set(r.favs); renderSide(); } }).catch((er) => toast(er.message));
    return;
  }
  if (e.target.closest('[data-rsyn]')) { e.stopPropagation(); return openLineageDialog('synthesis'); }
  const rf = e.target.closest('[data-rfold]');
  if (rf) { e.stopPropagation(); return toggleRFold(rf.dataset.rfold); }
  const it = e.target.closest('.item');
  if (!it) return;
  const k = it.dataset.key;
  if (k === 'home') return select({ kind: 'home' });
  if (k === 'search') return runSearch(state.filter);
  if (k === 'usage') return select({ kind: 'usage' });
  if (k === 'gpu') return select({ kind: 'gpu' });
  if (k === 'calendar') return select({ kind: 'calendar' });
  const i = k.indexOf(':');
  select({ kind: k.slice(0, i), id: k.slice(i + 1) });
});

// ---------- views ----------
function stopView() {
  viewGen++;
  clearTimeout(viewTimer);
  if (xws) { xws.close(); xws = null; }
  if (xterm) { xterm.dispose(); xterm = null; }
  for (const m of minis) { m.ws.close(); m.term.dispose(); }
  if (miniObserver) { miniObserver.disconnect(); miniObserver = null; }
  minis = [];
  window.onresize = null; window.onfocus = null; document.onvisibilitychange = null;
  $('#view').onclick = null; $('#bar').onclick = null;
  document.body.classList.remove('drawer');
}
function select(sel, tab) {
  // A live session selected from the sidebar opens its console window, if it has one.
  if (sel.kind === 'session') {
    const s = state.live.find((x) => x.sessionId === sel.id);
    const c = s && !isDesktopSession(s) && consoleOf(s.pid); // desktop-app sessions: transcript only
    const t = s && state.terms.find((x) => x.pid && consoleOf(x.pid) === c && c);
    if (c && !c.managed) { sel = { kind: 'console', id: String(c.id), session: s.sessionId }; }
    else if (t) { sel = { kind: 'term', id: t.id }; }
    else { sel = { kind: 'recent', id: sel.id, live: true }; }
  }
  stopView();
  state.sel = sel;
  state.tab = tab || (sel.kind === 'recent' ? 'chat' : 'screen');
  renderSide();
  ({ home: viewHome, console: viewConsole, recent: viewTranscript, term: viewTerm, search: viewSearch, usage: viewUsage, research: viewResearch, gpu: viewGpu, calendar: viewCalendar })[sel.kind]?.();
}

function setBar(html) { $('#bar').innerHTML = html; }

// Home: grid of every console's screen (polled round-robin) plus dashboard
// terminals (live read-only xterm mirrors over the same WebSocket).
const homeKeyOf = () => visibleConsoles().map((c) => c.id).join(',') + '|' + state.terms.map((t) => t.id + (t.exited === null ? '' : 'x')).join(',');
function viewHome() {
  const gen = viewGen;
  const cons = visibleConsoles();
  const terms = state.terms;
  homeKey = homeKeyOf();
  setBar(`<h2>전체 화면 모아보기</h2><span class="badge desk">콘솔 창 2초마다 · 대시보드 터미널 실시간 · 카드를 누르면 크게 보고 입력</span>`);
  const termCards = terms.map((t) => {
    const s = t.pid && state.live.find((x) => consoleOf(x.pid)?.pids.includes(t.pid));
    const dot = t.exited !== null ? 'dead' : s ? (s.status === 'busy' ? 'busy' : 'idle') : 'idle';
    return `<div class="card" data-term="${t.id}"><div class="hd"><span class="dot ${dot}"></span>
      <span class="t">${esc(termLabel(t))} · ${esc(base(t.cwd))}</span><span class="badge c">대시보드</span>
      ${t.exited !== null ? '<span class="badge">종료됨</span>' : ''}</div>
      <div class="mini" id="mini-${t.id}"><div class="mini-in"></div></div></div>`;
  }).join('');
  const conCards = cons.map((c) => {
    const s = sessionOfConsole(c);
    return `<div class="card" data-id="${c.id}"><div class="hd"><span class="dot ${s ? (s.status === 'busy' ? 'busy' : 'idle') : ''}"></span>
      <span class="t">${esc(consoleLabel(c))}</span>${s?.limit ? '<span class="badge lim">한도 도달</span>' : ''}${s ? '<span class="badge c">claude</span>' : ''}<span class="badge">${c.id}</span></div>
      <pre class="screen" id="scr-${c.id}">불러오는 중…</pre></div>`;
  }).join('');
  $('#view').innerHTML = `<div id="ustrip">${usageStripHTML()}</div>` + (cons.length || terms.length ? `<div class="grid">${termCards}${conCards}</div>`
    : '<div class="empty" style="padding:20px">표시할 콘솔 창이 없습니다.</div>');
  $('#ustrip').onclick = (e) => { e.stopPropagation(); select({ kind: 'usage' }); };
  $('#view').onclick = (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    if (card.dataset.term) select({ kind: 'term', id: card.dataset.term });
    else select({ kind: 'console', id: card.dataset.id });
  };
  // Each mini terminal replays up to 400 KB and then streams live output — 20 of them at once made the
  // page stutter. Only cards on screen get a terminal; one off screen for 10 s (or a hidden page) is dropped.
  const offSince = new Map();
  miniObserver?.disconnect();
  miniObserver = new IntersectionObserver((entries) => {
    for (const en of entries) {
      const id = en.target.id.slice(5);
      if (en.isIntersecting) { offSince.delete(id); if (!document.hidden && !minis.some((m) => m.id === id)) { const t = terms.find((x) => String(x.id) === id); if (t) mountMini(t); } }
      else offSince.set(id, Date.now());
    }
  }, { rootMargin: '300px 0px' });
  for (const t of terms) { const h = $(`#mini-${t.id}`); if (h) miniObserver.observe(h); }
  const sweep = () => {
    if (gen !== viewGen) return;
    for (const m of [...minis]) if (document.hidden || (offSince.has(m.id) && Date.now() - offSince.get(m.id) > 10_000)) unmountMini(m);
    setTimeout(sweep, 3000);
  };
  setTimeout(sweep, 3000);
  window.onresize = () => minis.forEach(fitMini);
  const tick = async () => {
    for (const c of cons) {
      if (gen !== viewGen) return;
      const r = await api(`/api/console/read?pid=${c.id}`).catch((e) => ({ error: e.message }));
      const el = $(`#scr-${c.id}`);
      if (el && gen === viewGen) paintScreen(el, r, 40);
    }
    if (gen === viewGen) viewTimer = setTimeout(tick, 2000);
  };
  tick();
}

// Read-only mirror: the xterm keeps the pty's exact cols/rows and is scaled down
// with CSS to fit the card, so full-screen TUIs like claude lay out correctly.
function mountMini(t) {
  const host = $(`#mini-${t.id}`);
  if (!host) return;
  const term = new Terminal({ cols: t.cols || 120, rows: t.rows || 32, fontSize: 12, disableStdin: true, cursorBlink: false,
    scrollback: 0, fontFamily: '"Cascadia Mono", Consolas, "D2Coding", monospace', theme: { background: '#0e0e11' } });
  term.open($('.mini-in', host));
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/term?id=${t.id}&t=${TOKEN}`);
  const m = { id: String(t.id), term, ws, host };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'data') term.write(msg.data);
    if (msg.type === 'resize') { term.resize(msg.cols, msg.rows); requestAnimationFrame(() => fitMini(m)); }
    if (msg.type === 'exit') term.write(`\r\n\x1b[90m[프로세스 종료: ${msg.code}]\x1b[0m`);
  };
  minis.push(m);
  requestAnimationFrame(() => fitMini(m));
}
function unmountMini(m) {
  try { m.ws.close(); } catch {}
  try { m.term.dispose(); } catch {}
  const inner = $('.mini-in', m.host); if (inner) inner.innerHTML = '';
  minis.splice(minis.indexOf(m), 1);
}
let miniObserver = null;
// back to a visible home page: re-mount the cards that are on screen
document.addEventListener('visibilitychange', () => {
  if (document.hidden || state.sel.kind !== 'home' || !miniObserver) return;
  for (const h of document.querySelectorAll('.mini')) { miniObserver.unobserve(h); miniObserver.observe(h); }
});
function fitMini(m) {
  const inner = $('.mini-in', m.host);
  const el = $('.xterm-screen', inner) || inner;
  const w = el.offsetWidth || 1, h = el.offsetHeight || 1;
  const s = Math.min(1, m.host.clientWidth / w);
  inner.style.transform = `scale(${s})`;
  m.host.style.height = Math.ceil(h * s) + 12 + 'px';
}

function paintScreen(el, r, maxLines) {
  if (!r.ok) { el.textContent = '읽기 실패: ' + (r.error || ''); return; }
  if (selectionIn(el)) return; // repainting would drop the user's selection
  let lines = r.lines;
  while (lines.length && !lines[lines.length - 1]) lines = lines.slice(0, -1);
  if (maxLines) lines = lines.slice(-maxLines);
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  const txt = lines.join('\n');
  const terms = el.id === 'scr' ? termsOf(state.sel.hl) : [];
  if (el.dataset.txt !== txt) {
    el.dataset.txt = txt;
    if (terms.length) el.innerHTML = hl(txt, terms); else el.textContent = txt;
    const marks = terms.length && !el.dataset.painted ? el.querySelectorAll('mark') : [];
    if (marks.length) el.scrollTop = marks[marks.length - 1].offsetTop - el.clientHeight / 2;
    else if (atBottom || !el.dataset.painted) el.scrollTop = el.scrollHeight;
  }
  el.dataset.painted = '1';
}

function viewConsole() {
  const gen = viewGen;
  const c = state.consoles.find((x) => String(x.id) === state.sel.id);
  const s = c && sessionOfConsole(c);
  const sid = s?.sessionId || state.sel.session;
  setBar(`<h2>${esc(c ? consoleLabel(c) : 'pid ' + state.sel.id)}</h2>
    <div class="tabs"><button data-tab="screen" class="${state.tab === 'screen' ? 'on' : ''}">화면</button>
    ${sid ? `<button data-tab="chat" class="${state.tab === 'chat' ? 'on' : ''}">대화 기록</button><button data-tab="files" class="${state.tab === 'files' ? 'on' : ''}">산출물</button>` : ''}</div>
    <button id="btnFocus" class="desk" title="실제 창을 앞으로 가져오기 (conhost 창만)">창 앞으로</button>${sid ? switchBtnHTML(sid) : ''}`);
  $('#bar').onclick = (e) => {
    const b = e.target.closest('[data-tab]');
    if (b) select(state.sel, b.dataset.tab);
    if (e.target.id === 'btnFocus') api('/api/console/focus', { method: 'POST', body: { pid: Number(state.sel.id) } });
  };
  if (state.tab === 'chat' && sid) return renderChat(sid, gen);
  if (state.tab === 'files' && sid) return renderArtifacts(sid, gen);

  $('#view').innerHTML = `<div class="full">
    <pre class="screen" id="scr">불러오는 중…</pre>
    <div class="inputbar">
      <input id="inp" placeholder="보낼 내용 입력 후 Enter (빈 칸에서 Enter = Enter 키만 전송)" autocomplete="off">
      <button class="primary" id="btnSend">보내기</button>
      <button data-copy="1" title="선택한 부분(없으면 화면 전체) 복사">📋</button>
      <button data-key="enter">⏎</button><button data-key="up">↑</button><button data-key="down">↓</button>
      <button data-key="tab">Tab</button><button data-key="esc">Esc</button><button data-key="ctrl+c">Ctrl+C</button>
      <label class="filebtn" title="파일 첨부 → 경로 입력">📎<input type="file" class="fpick" multiple hidden></label>
    </div>
    <div class="note">입력은 실제 창에 키 입력으로 주입됩니다 · 파일을 끌어놓거나 붙여넣으면 경로가 입력칸에 들어갑니다${s ? ' · Claude 세션: 메시지 입력 후 보내기 = 프롬프트 제출' : ''}.</div></div>`;
  const inp = $('#inp');
  const sendText = async () => {
    const text = inp.value;
    inp.value = '';
    const r = await api('/api/console/send', { method: 'POST', body: text ? { pid: Number(state.sel.id), text, submit: true } : { pid: Number(state.sel.id), keys: ['enter'] } });
    if (!r.ok) alertBar(r.error);
    setTimeout(tick, 150);
  };
  inp.onkeydown = (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); sendText(); } };
  $('#btnSend').onclick = sendText;
  $('#view').onclick = async (e) => {
    if (e.target.closest('[data-copy]')) { const scr = $('#scr'); return copyText(selectionIn(scr) || scr.textContent); }
    const k = e.target.closest('[data-key]')?.dataset.key;
    if (!k) return;
    await api('/api/console/send', { method: 'POST', body: { pid: Number(state.sel.id), keys: [k] } });
    setTimeout(tick, 150);
  };
  const tick = async () => {
    const r = await api(`/api/console/read?pid=${state.sel.id}`).catch((e) => ({ error: e.message }));
    if (gen !== viewGen) return;
    paintScreen($('#scr'), r);
    clearTimeout(viewTimer);
    viewTimer = setTimeout(tick, 1000);
  };
  tick();
  const addPath = (txt) => { inp.value += (inp.value && !inp.value.endsWith(' ') ? ' ' : '') + txt; inp.focus(); };
  attachFileInput($('#view .full'), addPath, s?.cwd);
  bindFilePick($('#view .full'), addPath, s?.cwd);
  inp.focus();
}
function alertBar(msg) {
  const n = document.createElement('span');
  n.className = 'badge'; n.style.color = '#d24c3a'; n.textContent = msg;
  $('#bar').appendChild(n); setTimeout(() => n.remove(), 5000);
}

function viewTranscript() {
  const gen = viewGen;
  const sid = state.sel.id;
  const r = state.recent.find((x) => x.sessionId === sid);
  const live = state.live.find((x) => x.sessionId === sid);
  setBar(`<h2>${esc(r?.title || r?.firstPrompt || live?.name || sid)}</h2>
    <span class="badge mono">${esc(sid.slice(0, 8))}</span>${agentBadge(r?.agent)}
    <div class="tabs"><button data-tab="chat" class="${state.tab !== 'files' ? 'on' : ''}">대화 기록</button><button data-tab="files" class="${state.tab === 'files' ? 'on' : ''}">산출물</button></div>
    ${!live ? '<button class="primary" id="btnResume">대시보드에서 이어하기</button>' : isDesktopSession(live) ? '<button class="primary" id="btnResume" data-fork="1" title="데스크톱 앱 대화를 여기까지 복제한 새 세션으로 이어갑니다 (원래 대화는 데스크톱 앱에 그대로)">대시보드에서 이어하기 (복제)</button>' : ''}${switchBtnHTML(sid)}`);
  $('#bar').onclick = async (e) => {
    const tb = e.target.closest('[data-tab]');
    if (tb) return select(state.sel, tb.dataset.tab);
    if (e.target.id !== 'btnResume') return;
    const body = r?.agent === 'codex' ? { kind: 'codex', resume: sid, cwd: r.cwd } : { kind: 'claude', resume: sid, cwd: r?.cwd || live?.cwd, skipPermissions: true, fork: !!e.target.dataset.fork };
    const t = await api('/api/term/new', { method: 'POST', body });
    if (t.error) return toast(t.error, 6000);
    await refreshOverview();
    select({ kind: 'term', id: t.id });
  };
  if (state.tab === 'files') return renderArtifacts(sid, gen);
  renderChat(sid, gen, state.sel.at ?? -1, termsOf(state.sel.q));
}

async function renderChat(sid, gen, at = -1, terms = []) {
  const who = state.recent.find((x) => x.sessionId === sid)?.agent === 'codex' ? 'Codex' : 'Claude';
  $('#view').innerHTML = '<div class="chat" id="chat">불러오는 중…</div>';
  let lastSize = -1;
  const jump = at >= 0;
  const tick = async () => {
    const d = await api(`/api/transcript?id=${encodeURIComponent(sid)}${jump ? '&at=' + at : ''}`).catch((e) => ({ error: e.message }));
    if (gen !== viewGen) return;
    const box = $('#chat');
    if (d.error && !d.messages?.length) box.innerHTML = `<div class="err">${esc(d.error)}</div>`;
    else if (d.size !== lastSize && !selectionIn(box)) { // keep a selection the user is copying
      lastSize = d.size;
      const v = $('#view');
      const atBottom = v.scrollHeight - v.scrollTop - v.clientHeight < 80 || !box.dataset.painted;
      const b = d.base || 0;
      const more = jump && b + d.messages.length < (d.total || 0)
        ? `<div class="row" style="justify-content:center;margin:10px"><button id="btnLatest">최신 대화로 이동</button></div>` : '';
      box.innerHTML = (b > 0 ? `<div class="empty" style="margin-bottom:10px">… 이전 메시지 ${b}개 생략</div>` : '') + (d.messages.map((m, k) => {
        const tool = m.role === 'assistant' && m.text.startsWith('⚙');
        const tgt = jump && b + k === at ? ' target' : '';
        const when = m.ts ? new Date(m.ts).toLocaleString() : '';
        return `<div class="msg ${tool ? 'tool' : m.role}${tgt}">${tool ? '' : `<div class="who">${m.role === 'user' ? '사용자' : who} · ${esc(when)}</div>`}${linkPaths(hl(m.text, terms))}</div>`;
      }).join('') || '<div class="empty">메시지 없음</div>') + more;
      const btn = $('#btnLatest');
      if (btn) btn.onclick = () => select({ ...state.sel, at: -1 }, 'chat');
      const first = !box.dataset.painted;
      box.dataset.painted = '1';
      const t = first && jump && $('.msg.target', box);
      if (t) t.scrollIntoView({ block: 'center' });
      else if (atBottom) v.scrollTop = v.scrollHeight;
    }
    if (!jump) viewTimer = setTimeout(tick, 3000);
  };
  tick();
}

const PTY_KEYS = { enter: '\r', esc: '\x1b', tab: '\t', 'shift+tab': '\x1b[Z', up: '\x1b[A', down: '\x1b[B', 'ctrl+c': '\x03' };
async function copyText(text) {
  if (!text) return toast('복사할 내용이 없습니다');
  try {
    if (window.isSecureContext && navigator.clipboard) await navigator.clipboard.writeText(text);
    else {
      const ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
    }
    toast(`복사됨 (${text.length.toLocaleString()}자)`);
  } catch (e) { toast('복사 실패: ' + e.message); }
}
// selected text inside el (for the plain-text console screens)
const selectionIn = (el) => { const sel = window.getSelection(); return sel && !sel.isCollapsed && el && el.contains(sel.anchorNode) ? sel.toString() : ''; };
const KEY_BUTTONS = `<button data-key="enter">⏎</button><button data-key="esc">Esc</button><button data-key="up">↑</button>
  <button data-key="down">↓</button><button data-key="tab">Tab</button><button data-key="shift+tab">⇧Tab</button><button data-key="ctrl+c">^C</button>
  <label class="filebtn" title="파일 첨부 → 경로 입력">📎<input type="file" class="fpick" multiple hidden></label>
  <button data-copy="1" title="선택한 부분(없으면 화면 전체) 복사">📋</button>`;

function viewTerm() {
  const gen = viewGen;
  const t = state.terms.find((x) => x.id === state.sel.id);
  const sid = t?.sessionId;
  // same layout as a console-window view: title · [화면 | 대화 기록] · actions, input bar at the bottom
  setBar(`<h2>${esc(t ? termLabel(t) : '터미널')}</h2>${t?.account ? `<span class="badge c">${esc(t.account.label.replace(/@.*/, ''))}</span>` : ''}
    ${sid ? `<div class="tabs"><button data-tab="screen" class="${state.tab === 'screen' ? 'on' : ''}">화면</button><button data-tab="chat" class="${state.tab === 'chat' ? 'on' : ''}">대화 기록</button><button data-tab="files" class="${state.tab === 'files' ? 'on' : ''}">산출물</button></div>` : ''}
    <span class="badge desk">${esc(t?.cwd || '')}</span>${sid ? switchBtnHTML(sid) : t?.claude || t?.codex ? switchBtnHTML('', t.id) : ''}
    <button id="btnClose">닫기</button>`);
  $('#bar').onclick = async (e) => {
    const tb = e.target.closest('[data-tab]');
    if (tb) return select(state.sel, tb.dataset.tab);
    if (e.target.id !== 'btnClose') return;
    if (!confirm('이 터미널의 프로세스를 종료하고 닫을까요?')) return;
    await api('/api/term/close', { method: 'POST', body: { id: state.sel.id } });
    await refreshOverview();
    select({ kind: 'home' });
  };
  if (state.tab === 'chat' && sid) return renderChat(sid, gen);
  if (state.tab === 'files' && sid) return renderArtifacts(sid, gen);

  $('#view').innerHTML = `<div class="full"><div id="termwrap"></div>
    <div class="inputbar">
      <input id="tin" placeholder="보낼 내용 입력 후 Enter (빈 칸에서 Enter = Enter 키만 전송)" autocomplete="off" enterkeyhint="send">
      <button class="primary" id="tsend">보내기</button><button id="tArt" title="산출물(세션·자율 연구)의 경로를 입력칸에 넣기">📎</button>${KEY_BUTTONS}
    </div>
    <div class="note">입력칸이나 화면 어디에서든 입력할 수 있습니다(화면을 클릭하면 CLI에 직접 입력) · 파일을 끌어놓거나 붙여넣으면 경로가 입력칸에 들어갑니다${sid ? ' · 보내기 = 프롬프트 제출' : ''}.</div></div>`;
  xterm = new Terminal({ fontFamily: '"Cascadia Mono", Consolas, "D2Coding", monospace', fontSize: IS_MOBILE ? 11 : 13, cursorBlink: true, scrollback: 10000, theme: { background: '#0e0e11' } });
  const fit = new FitAddon.FitAddon();
  xterm.loadAddon(fit);
  xterm.open($('#termwrap'));
  // Claude Code on Windows (ConPTY) redraws in place on a fixed-size screen, so almost nothing reaches
  // the terminal's scrollback — scrolling up stops after one screen. Point to the transcript instead.
  if (sid) {
    let hintAt = 0;
    $('#termwrap').addEventListener('wheel', (e) => {
      if (e.deltaY >= 0 || xterm.buffer.active.viewportY > 0 || Date.now() - hintAt < 8000) return;
      hintAt = Date.now();
      const h = document.createElement('div');
      h.className = 'termhint';
      h.innerHTML = '터미널에는 화면 한 장 분량만 남습니다 (Windows 콘솔 특성). 이전 내용은 <button class="linkbtn">"대화 기록" 탭에서 전체 보기 →</button>';
      h.querySelector('button').onclick = () => select(state.sel, 'chat');
      $('#termwrap').appendChild(h);
      setTimeout(() => h.remove(), 7000);
    }, { passive: true });
  }
  const ws = xws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/term?id=${state.sel.id}&t=${TOKEN}`);
  const send = (data) => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'input', data }));
  const resize = () => { try { fit.fit(); } catch {} if (ws.readyState === 1 && xterm) ws.send(JSON.stringify({ type: 'resize', cols: xterm.cols, rows: xterm.rows })); };
  ws.onopen = resize;
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.type === 'data') xterm?.write(msg.data);
    if (msg.type === 'exit') xterm?.write(`\r\n\x1b[90m[프로세스 종료: ${msg.code}]\x1b[0m\r\n`);
  };
  xterm.onData(send);
  xterm.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 'c' && (e.shiftKey || xterm.hasSelection())) { copyText(xterm.getSelection()); xterm.clearSelection(); return false; }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && k === 'v') return false; // let the browser paste
    return true;
  });
  $('#termwrap').addEventListener('contextmenu', (e) => { if (xterm?.hasSelection()) { e.preventDefault(); copyText(xterm.getSelection()); xterm.clearSelection(); } });
  const tin = $('#tin');
  // file paths (drop / paste / 📎) always go to the input box, like the console view
  const insert = (txt) => { tin.value += (tin.value && !tin.value.endsWith(' ') ? ' ' : '') + txt; tin.focus(); };
  attachFileInput($('#view .full'), insert, t?.cwd);
  const submit = () => {
    const v = tin.value; tin.value = '';
    // claude treats text+CR in one burst as a paste; send Enter separately (longer text → longer pause)
    if (v) { send(v); setTimeout(() => send('\r'), 350 + Math.min(3000, v.length * 2)); } else send('\r');
  };
  $('#tsend').onclick = submit;
  $('#tArt').onclick = () => pickArtifact((abs) => insert(quotePath(abs)));
  tin.onkeydown = (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); submit(); } };
  $('#view .full').addEventListener('click', (e) => {
    if (e.target.closest('[data-copy]')) {
      if (xterm?.hasSelection()) { copyText(xterm.getSelection()); xterm.clearSelection(); return; }
      const b = xterm.buffer.active, lines = [];
      for (let i = 0; i < b.length; i++) lines.push(b.getLine(i)?.translateToString(true) ?? '');
      while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
      return copyText(lines.join('\n'));
    }
    const k = e.target.closest('[data-key]')?.dataset.key;
    if (k) { send(PTY_KEYS[k]); tin.focus(); }
  });
  bindFilePick($('#view .full'), insert, t?.cwd);
  // whichever device is being looked at owns the pty size
  window.onresize = resize;
  window.onfocus = resize;
  document.onvisibilitychange = () => { if (!document.hidden) resize(); };
  setTimeout(resize, 50);
  if (!IS_MOBILE) tin.focus();
}

// ---------- files → paths (drag & drop / paste), like Windows Terminal ----------
// Browsers hide a dropped file's real path, so first ask the server to find the
// original on disk (name + size + mtime); if that fails (e.g. a clipboard
// screenshot), upload a copy into hub\uploads and use that path.
const IS_MOBILE = matchMedia('(max-width: 760px), (pointer: coarse)').matches;
// opened from another device (Tailscale): hide buttons that act on this PC's desktop (open folder, ...)
const IS_REMOTE = !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(location.hostname);
if (IS_REMOTE) document.body.classList.add('remote');
function bindFilePick(root, insert, cwd) {
  for (const inp of root.querySelectorAll('.fpick')) {
    inp.onchange = async () => {
      const paths = [];
      for (const f of inp.files) { const p = await fileToPath(f, cwd).catch(() => null); if (p) paths.push(quotePath(p)); }
      inp.value = '';
      if (paths.length) insert(paths.join(' ') + ' ');
    };
  }
}
const quotePath = (p) => (/[\s&()'`;,]/.test(p) ? `"${p}"` : p);
function toast(msg, ms = 4000) {
  const n = document.createElement('span');
  n.className = 'badge'; n.textContent = msg;
  $('#bar').appendChild(n);
  setTimeout(() => n.remove(), ms);
  return n;
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
function attachFileInput(el, insert, cwd) {
  el.dataset.fileInput = '1';
  const handle = async (dt) => {
    const files = clipFiles(dt);
    const items = [...(dt.items || [])];
    if (items.some((it) => it.webkitGetAsEntry?.()?.isDirectory)) toast('폴더는 경로를 알 수 없어 제외합니다 (파일만 가능)');
    const paths = [];
    for (let i = 0; i < files.length; i++) {
      if (items[i]?.webkitGetAsEntry?.()?.isDirectory) continue;
      const p = await fileToPath(files[i], cwd).catch(() => null);
      if (p) paths.push(quotePath(p));
    }
    if (paths.length) insert(paths.join(' ') + ' ');
  };
  el.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); el.classList.add('dropping'); } });
  el.addEventListener('dragleave', () => el.classList.remove('dropping'));
  el.addEventListener('drop', (e) => {
    el.classList.remove('dropping');
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    handle(e.dataTransfer);
  });
  // capture phase: runs before xterm's own paste handler on its textarea
  el.addEventListener('paste', (e) => {
    if (!clipFiles(e.clipboardData).length) return;
    e.preventDefault(); e.stopPropagation();
    handle(e.clipboardData);
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

// ---------- AI usage (relayed from ai-usage-dashboard :4777) ----------
async function refreshUsage(force) {
  try { state.usage = await api('/api/usage' + (force ? '?force=1' : '')); } catch (e) { state.usage = { available: false, error: e.message }; }
  renderSide();
  const st = $('#ustrip'); if (st) st.innerHTML = usageStripHTML();
  if (state.sel.kind === 'usage') paintUsage();
}
// usage percents: whole numbers (APIs send values like 6.593538461538461)
const pctTxt = (p) => (p == null ? '' : String(Math.round(Number(p))));
const level = (p) => (p >= 90 ? 'hi' : p >= 70 ? 'mid' : 'lo');
function untilText(iso) {
  if (!iso) return '';
  const s = (new Date(iso) - Date.now()) / 1000;
  if (s <= 0) return '리셋됨';
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}일 ${h}시간 후` : h ? `${h}시간 ${m}분 후` : `${m}분 후`;
}
const shortLabel = (a) => (a.label || a.provider || '').replace(/@.*/, '').replace(/\s*\(이 PC\)/, '');
// The meters that matter at a glance: the 5-hour window and the weekly cap (or the headline one).
function keyMeters(a) {
  const ms = a.meters || [];
  const pick = [ms.find((m) => /5시간/.test(m.name)), ms.find((m) => /주간 \(전체/.test(m.name)) || ms.find((m) => /주간/.test(m.name))].filter(Boolean);
  return pick.length ? pick : ms.filter((m) => m.headline).concat(ms).slice(0, 2);
}
const bar = (pct, thin) => `<span class="ubar${thin ? ' thin' : ''}"><i class="${level(pct)}" style="width:${Math.max(2, Math.min(100, pct))}%"></i></span>`;
function usageSideHTML() {
  const u = state.usage;
  if (!u) return '';
  if (!u.available) return `<div class="sec"><h2>AI 사용량</h2><div class="empty">연결 안 됨 (4777)</div></div>`;
  const rows = u.accounts.filter((a) => a.ok && a.meters?.length).map((a) => {
    const ms = keyMeters(a);
    return `<div class="urow" title="${esc(a.label)}"><span class="ul">${esc(shortLabel(a))}</span>${ms.map((m) => `${bar(m.usedPercent, true)}<span class="up ${level(m.usedPercent)}">${pctTxt(m.usedPercent)}</span>`).join('')}</div>`;
  }).join('');
  const sel = state.sel.kind === 'usage' ? ' sel' : '';
  return `<div class="sec"><h2>AI 사용량<span class="sp"></span><span style="text-transform:none;letter-spacing:0">5h · 주간 %</span></h2>
    <div class="item usebox${sel}" data-key="usage"><div class="body">${rows || '<div class="empty">표시할 계정 없음</div>'}</div></div></div>`;
}
function usageStripHTML() {
  const u = state.usage;
  if (!u?.available) return '';
  const chips = u.accounts.filter((a) => a.ok && a.meters?.length).map((a) => {
    const ms = keyMeters(a);
    const worst = Math.max(...ms.map((m) => m.usedPercent));
    return `<span class="uchip ${level(worst)}"><b>${esc(shortLabel(a))}</b> ${ms.map((m) => `${/5시간/.test(m.name) ? '5h' : /주간/.test(m.name) ? '주' : ''} ${pctTxt(m.usedPercent)}%`).join(' · ')}</span>`;
  });
  return chips.length ? `<div class="ustrip">${chips.join('')}</div>` : '';
}
function viewUsage() {
  setBar(`<h2>AI 사용량</h2><span class="badge desk">ai-usage-dashboard(4777) 연동 · 2분마다 갱신</span>
    <button id="uAccounts">계정 관리</button>
    <button id="uRefresh" title="제공사에 다시 조회 (OAuth 토큰 계정은 1토큰 요청을 보냄)">지금 조회</button>`);
  $('#bar').onclick = async (e) => {
    if (e.target.id === 'uAccounts') return openAccounts();
    if (e.target.id !== 'uRefresh') return;
    e.target.disabled = true; e.target.textContent = '조회 중…';
    await refreshUsage(true);
  };
  paintUsage();
}
function paintUsage() {
  const u = state.usage;
  if (!u) { $('#view').innerHTML = '<div class="empty" style="padding:20px">불러오는 중…</div>'; return; }
  if (!u.available) { $('#view').innerHTML = `<div class="err">${esc(u.error)}<br><br>AI 사용량 대시보드(기본 127.0.0.1:4777)가 꺼져 있습니다. 설치 폴더의 start.bat 또는 ai-usage-dashboard를 실행하세요.</div>`; return; }
  const cards = u.accounts.map((a) => `<div class="ucard">
    <div class="uh"><b>${esc(a.label)}</b>${a.plan ? `<span class="badge">${esc(a.plan)}</span>` : ''}${a.live ? '<span class="badge c">이 PC</span>' : ''}<span class="badge">${esc(a.provider)}</span></div>
    ${!a.ok ? `<div class="empty">${esc(a.error || '조회 실패')}</div>` : ''}
    ${(a.meters || []).map((m) => `<div class="um"><div class="umt"><span>${esc(m.name)}</span><span class="up ${level(m.usedPercent)}">${pctTxt(m.usedPercent)}%</span></div>
      ${bar(m.usedPercent)}<div class="ums">${m.resetsAt ? `리셋 ${untilText(m.resetsAt)} · ${esc(new Date(m.resetsAt).toLocaleString())}` : ''}${m.detail ? ` · ${esc(m.detail)}` : ''}</div></div>`).join('')}
    ${a.billing?.at ? `<div class="ums">${esc(a.billing.label)}: ${esc(new Date(a.billing.at).toLocaleDateString())}</div>` : ''}
    ${a.notes?.length ? `<div class="ums">${a.notes.map(esc).join('<br>')}</div>` : ''}
  </div>`).join('');
  $('#view').innerHTML = `<div class="ugrid">${cards}</div>
    <div class="empty" style="padding:0 16px 20px">갱신: ${esc(new Date(u.generatedAt).toLocaleTimeString())}${u.stale ? ' (4777 연결 끊김 — 마지막 값)' : ''} · 계정 추가·삭제는 위의 <b>계정 관리</b> 버튼</div>`;
}

// ---------- AI usage: add/remove accounts (stored by the usage dashboard on this PC) ----------
const ACCOUNT_TYPES = {
  'claude-token': { name: 'Claude 장기 토큰', fields: [['token', '토큰 (sk-ant-oat01-…)', 'password']], help: '터미널에서 <code>claude setup-token</code> → 브라우저 승인 후 출력되는 sk-ant-oat01-… 값' },
  claude: { name: 'Claude Code 로그인 (다른 폴더)', fields: [['credentialsPath', '.credentials.json 경로', 'text']], help: '<code>$env:CLAUDE_CONFIG_DIR="$HOME\\.claude-work"; claude</code> → /login 후 그 폴더의 .credentials.json' },
  cursor: { name: 'Cursor 세션', fields: [['sessionToken', 'WorkosCursorSessionToken 값', 'password']], help: 'cursor.com 로그인 → F12 → Application → Cookies → WorkosCursorSessionToken' },
  codex: { name: 'ChatGPT (Codex CLI)', fields: [['authPath', 'auth.json 경로', 'text']], help: '보통은 위의 <b>＋ Codex 계정 추가</b> 버튼을 쓰세요 (기기 코드 로그인, 자동 등록). 이미 로그인한 폴더가 있으면 그 auth.json 경로' },
  'openai-api': { name: 'OpenAI API 비용', fields: [['adminKey', 'Admin 키 (sk-admin-…)', 'password'], ['monthlyBudget', '월 예산 USD (선택)', 'number']], help: 'platform.openai.com → Admin keys' },
  meshy: { name: 'Meshy API 키', fields: [['apiKey', 'API 키 (msy_…)', 'password'], ['keyPath', '또는 키 파일 경로', 'text'], ['monthlyCredits', '월 제공 크레딧 (선택, 사용률 표시용)', 'number']], help: 'Meshy 3D 생성 API — 잔여 크레딧 표시 (meshy.ai → API 키)' },
  gemini: { name: 'Gemini API 키', fields: [['apiKey', 'API 키', 'password'], ['keyPath', '또는 키 파일 경로', 'text']], help: 'Google은 잔여량 조회를 지원하지 않아 키 유효 여부만 표시' },
};
async function openAccounts() {
  const d = document.createElement('div');
  d.className = 'dlg';
  d.innerHTML = '<div class="box"><h3>AI 사용량 계정 관리</h3><div id="acBody">불러오는 중…</div></div>';
  document.body.appendChild(d);
  d.onclick = (e) => { if (e.target === d) d.remove(); };
  const paint = async () => {
    const r = await api('/api/usage/accounts').catch((e) => ({ error: e.message }));
    const body = $('#acBody', d);
    if (r.error) { body.innerHTML = `<div class="err">${esc(r.error)}</div>`; return; }
    const opts = Object.entries(ACCOUNT_TYPES).map(([k, v]) => `<option value="${k}">${esc(v.name)}</option>`).join('');
    body.innerHTML = `
      <div class="empty" style="padding:0">이 PC에서 자동 감지 ${r.detected?.length || 0}개 (Claude Code·Cursor·Codex 로그인) · 직접 추가 ${r.accounts?.length || 0}개</div>
      <div class="swlist">${(r.accounts || []).map((a) => `<div class="swrow"><span class="swl">${esc(a.label || a.id)} <span class="badge">${esc(ACCOUNT_TYPES[a.type]?.name || a.type)}</span></span>
        <button data-del="${esc(a.id)}">삭제</button></div>`).join('') || '<div class="empty">직접 추가한 계정 없음</div>'}</div>
      <h3 style="margin-top:6px">계정 추가</h3>
      <div class="row"><button class="primary" id="acCodex" title="터미널이 열리고 코드가 나옵니다. 아무 브라우저(폰도 가능)에서 그 주소를 열어 코드를 넣고, 추가할 ChatGPT 계정으로 로그인하면 끝">＋ Codex 계정 추가 (ChatGPT 로그인)</button></div>
      <div class="empty" style="padding:0">Codex 계정이 여럿이면 codex 터미널의 “다른 계정” 버튼으로 같은 대화를 다른 계정에서 이어갈 수 있습니다 (직접 누를 때만 바뀝니다).</div>
      <label>종류<br><select id="acType" style="width:100%">${opts}</select></label>
      <label>이름(라벨)<br><input id="acLabel" style="width:100%" placeholder="예: 연구실 계정"></label>
      <div id="acFields"></div>
      <div class="empty" id="acHelp" style="padding:0"></div>
      <div class="empty" style="padding:0">토큰·키는 이 PC의 AI 사용량 대시보드 설정 파일에만 저장되고, 화면에는 가려서 표시됩니다.</div>
      <div class="row" style="justify-content:flex-end"><button id="acClose">닫기</button><button class="primary" id="acAdd">추가</button></div>`;
    const fields = () => {
      const t = ACCOUNT_TYPES[$('#acType', d).value];
      $('#acFields', d).innerHTML = t.fields.map(([k, lab, typ]) => `<label>${esc(lab)}<br><input data-f="${k}" type="${typ}" style="width:100%" autocomplete="off"></label>`).join('');
      $('#acHelp', d).innerHTML = t.help;
    };
    $('#acType', d).onchange = fields; fields();
    $('#acClose', d).onclick = () => d.remove();
    $('#acCodex', d).onclick = async () => {
      const t = await api('/api/codex/add', { method: 'POST', body: {} }).catch((e) => ({ error: e.message }));
      if (t.error) return toast(t.error, 6000);
      d.remove();
      await refreshOverview();
      select({ kind: 'term', id: t.id });
      toast('터미널에 나온 주소와 코드로 로그인하세요 — 끝나면 자동 등록됩니다', 8000);
    };
    body.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
      if (!confirm('이 계정을 목록에서 삭제할까요?')) return;
      const x = await api('/api/usage/accounts', { method: 'POST', body: { action: 'delete', id: b.dataset.del } });
      if (x.error) return toast(x.error, 6000);
      paint(); refreshUsage();
    }));
    $('#acAdd', d).onclick = async () => {
      const account = { type: $('#acType', d).value, label: $('#acLabel', d).value.trim() };
      d.querySelectorAll('[data-f]').forEach((i) => { if (i.value.trim()) account[i.dataset.f] = i.type === 'number' ? Number(i.value) : i.value.trim(); });
      if (!account.label) return toast('이름을 입력하세요');
      const x = await api('/api/usage/accounts', { method: 'POST', body: { account } });
      if (x.error) return toast(x.error, 8000);
      toast('추가됨 — 사용량을 조회합니다');
      paint(); refreshUsage(true);
    };
  };
  paint();
}

// ---------- per-session outputs (artifacts) ----------
const ART_ICON = { video: '🎬', audio: '🎵', pdf: '📕', image: '🖼', html: '🌐', markdown: '📝', text: '📄', file: '📦' };
const artUrl = (sid, p) => `/api/artifact-file?session=${encodeURIComponent(sid)}&path=${encodeURIComponent(p)}&t=${encodeURIComponent(TOKEN)}`;
const rRawUrl = (slug, rel) => `/api/research/raw?slug=${encodeURIComponent(slug)}&path=${encodeURIComponent(rel)}&t=${encodeURIComponent(TOKEN)}`;
const fmtSize = (n) => (n > 1e9 ? `${(n / 1e9).toFixed(1)}GB` : n > 1e6 ? `${(n / 1e6).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`);
// wrap Windows / git-bash paths with a viewable extension (already HTML-escaped text) in clickable links
function linkPaths(html) {
  return html.replace(/((?:[A-Za-z]:[\\/]|\/[a-z]\/)[^\s"'`<>|*?()\[\]{}]+?\.(?:mp4|webm|mov|mkv|pdf|png|jpe?g|gif|webp|svg|html?|md|txt|log|csv|json|ya?ml|tex|py|ply|glb|obj|docx|xlsx|pptx))(?=[\s.,;:)\]]|$|&)/gi,
    (m) => `<a class="artlink" data-apath="${m}">${m}</a>`);
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
  if (it) return openArtifact(sid, it);
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
function sendPathDialog(abs) {
  const targets = state.terms.filter((t) => t.exited === null).map((t) => ({ id: t.id, label: termLabel(t) }));
  const cur = state.sel.kind === 'term' ? String(state.sel.id) : null;
  const d = document.createElement('div');
  d.className = 'dlg';
  d.innerHTML = `<div class="box"><h3>세션에 보내기</h3>
    <div class="mono" style="word-break:break-all">${esc(abs)}</div>
    <label>보낼 세션<br><select id="spT" style="width:100%">${targets.map((t) => `<option value="${esc(t.id)}" ${String(t.id) === cur ? 'selected' : ''}>t:${esc(t.id)} ${esc(t.label)}</option>`).join('')}</select></label>
    <label>함께 보낼 말 (비우면 경로만 입력칸에 넣고 전송하지 않음)<br><textarea id="spM" rows="3" style="width:100%" placeholder="예: 이 결과 보고 다음 실험 계획 세워줘"></textarea></label>
    <div class="row" style="justify-content:flex-end"><button id="spC">취소</button><button class="primary" id="spOk">보내기</button></div></div>`;
  document.body.appendChild(d);
  if (!targets.length) { $('#spOk', d).disabled = true; $('#spT', d).outerHTML = '<div class="empty">열려 있는 대시보드 터미널이 없습니다</div>'; }
  $('#spC', d).onclick = () => d.remove();
  $('#spOk', d).onclick = async () => {
    $('#spOk', d).disabled = true;
    const msg = $('#spM', d).value.trim();
    const text = (msg ? msg + ' ' : '') + quotePath(abs) + (msg ? '' : ' ');
    const r = await api('/api/term/send', { method: 'POST', body: { id: $('#spT', d).value, text, submit: !!msg } });
    d.remove();
    toast(r.error ? r.error : msg ? '세션에 보냈습니다' : '경로를 세션 입력칸에 넣었습니다');
  };
}

// picker for the terminal input bar: outputs of this session, another dashboard session, or a research project
function pickArtifact(onPath) {
  const sources = [
    ...state.terms.filter((t) => t.sessionId).map((t) => ({ v: 's:' + t.sessionId, label: `세션 t:${t.id} ${termLabel(t)}`, cur: state.sel.kind === 'term' && String(state.sel.id) === String(t.id) })),
    ...(state.research || []).map((p) => ({ v: 'r:' + p.slug, label: `연구 ${p.name}` })),
  ];
  const d = document.createElement('div');
  d.className = 'dlg';
  d.innerHTML = `<div class="box wide"><h3>📎 산출물 넣기</h3>
    <div class="row"><select id="paS" style="flex:1;min-width:0">${sources.map((x) => `<option value="${esc(x.v)}" ${x.cur ? 'selected' : ''}>${esc(x.label)}</option>`).join('')}</select>
      <label class="row" style="gap:4px"><input type="checkbox" id="paAll"> 모든 파일</label></div>
    <div id="paB" style="max-height:58vh;overflow:auto">불러오는 중…</div>
    <div class="row" style="justify-content:flex-end"><button id="paC">닫기</button></div></div>`;
  document.body.appendChild(d);
  $('#paC', d).onclick = () => d.remove();
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
    $('#paB', d).innerHTML = list.map((x, i) => `<div class="ofile" data-pa="${i}" style="cursor:pointer"><span>${ART_ICON[x.kind] || '📦'} ${esc(x.name)}</span><span class="empty">${fmtSize(x.size)} · ${relTime(x.mtime)}</span></div>`).join('')
      || '<div class="empty">산출물이 없습니다 ("모든 파일"을 켜면 코드·데이터도 보입니다)</div>';
  };
  $('#paS', d).onchange = paint;
  $('#paAll', d).onchange = paint;
  $('#paB', d).onclick = (e) => { const it = e.target.closest('[data-pa]'); if (!it) return; d.remove(); onPath(list[Number(it.dataset.pa)].abs); };
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
  const paint = async () => {
    const r = await api(`/api/artifacts?session=${encodeURIComponent(sid)}`).catch((e) => ({ error: e.message }));
    if (gen !== viewGen) return;
    if (r.error) { $('#view').innerHTML = `<div class="err">${esc(r.error)}</div>`; return; }
    const all = r.items || [];
    const items = artShowAll ? all : all.filter((x) => x.main);
    const card = ([it, i]) => `<div class="acard" data-ai="${i}">
        <div class="athumb">${it.kind === 'image' ? `<img loading="lazy" src="${artUrl(sid, it.path)}" alt="">` : `<span>${ART_ICON[it.kind] || '📦'}</span>`}</div>
        <div class="ameta"><b title="${esc(it.path)}">${esc(it.title || it.name)}</b>
          <span class="ums">${esc(it.ext.toUpperCase())} · ${fmtSize(it.size)} · ${relTime(it.mtime)}${it.source === 'pinned' ? ' · 📌' : ''}</span></div>
        <button class="ahide" data-ahide="${i}" title="목록에서 숨기기">✕</button><button class="asend" data-asend="${i}" title="이 파일을 세션에 보내기 (경로 멘션)">↗</button></div>`;
    $('#view').innerHTML = `<div class="rwrap">
      <div class="row"><b style="flex:1">산출물 ${items.length}개${artShowAll ? '' : ` <span class="empty">(전체 ${all.length}개 중 영상·PDF·그림·문서)</span>`}</b>
        ${artOrderSel()}
        <label class="row" style="gap:4px"><input type="checkbox" id="artAll" ${artShowAll ? 'checked' : ''}> 로그·코드·데이터도 보기</label>
        <button id="artAdd">＋ 산출물 지정</button></div>
      ${items.length ? artTimeline(items.map((it, i) => [it, i]), card) : '<div class="empty">아직 인식된 산출물이 없습니다. 대화에 나온 파일 경로가 자동으로 모이고, ＋ 로 직접 지정할 수도 있습니다.</div>'}</div>`;
    bindArtOrder(paint);
    $('#artAll').onchange = (e) => { artShowAll = e.target.checked; paint(); };
    $('#artAdd').onclick = () => addArtifactDialog(sid, paint);
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
  const d = document.createElement('div');
  d.className = 'dlg';
  d.innerHTML = `<div class="box"><h3>산출물 지정</h3>
    <label>파일 경로<br><input id="apPath" style="width:100%" placeholder="예: C:\\work\\project\\out\\result.mp4 — 파일을 여기로 끌어놓아도 됩니다"></label>
    <label>이름 (선택)<br><input id="apTitle" style="width:100%" placeholder="예: 최종 비교 영상"></label>
    <div class="row" style="justify-content:flex-end"><button id="apCancel">취소</button><button class="primary" id="apOk">추가</button></div></div>`;
  document.body.appendChild(d);
  attachFileInput($('.box', d), (txt) => { $('#apPath', d).value = txt.trim().replace(/^"|"$/g, ''); }, null);
  $('#apCancel', d).onclick = () => d.remove();
  $('#apOk', d).onclick = async () => {
    const r = await api('/api/artifacts/add', { method: 'POST', body: { session: sid, path: $('#apPath', d).value.trim(), title: $('#apTitle', d).value.trim() || undefined } });
    if (r.error) return toast(r.error, 6000);
    d.remove(); toast('산출물로 지정했습니다'); done && done();
  };
}
async function openArtifact(sid, it, url = artUrl(sid, it.path)) {
  const d = document.createElement('div');
  d.className = 'dlg';
  d.innerHTML = `<div class="box wide aview"><div class="row"><b style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(it.path)}">${ART_ICON[it.kind] || ''} ${esc(it.title || it.name)}</b>
      <a class="btnlike" href="${url}" target="_blank" rel="noopener">새 탭</a><a class="btnlike" href="${url}&dl=1" download="${esc(it.name)}">다운로드</a><button id="avSend" title="이 파일 경로를 세션에 보내기">↗ 세션에</button><button id="avClose">닫기</button></div>
    <div class="ums mono" style="word-break:break-all">${esc(it.path)} · ${fmtSize(it.size)}</div>
    <div id="avBody" class="avbody">불러오는 중…</div></div>`;
  document.body.appendChild(d);
  const close = () => d.remove();
  d.onclick = (e) => { if (e.target === d || e.target.id === 'avClose') close(); if (e.target.id === 'avSend') sendPathDialog(it.abs || it.path); };
  const body = $('#avBody', d);
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
    if (it.kind === 'markdown') body.innerHTML = md(txt);
    else { let t = txt; if (it.ext === 'json') { try { t = JSON.stringify(JSON.parse(txt), null, 2); } catch {} } body.innerHTML = `<pre class="mdpre">${esc(t)}</pre>`; }
  } else body.innerHTML = `<div class="empty">이 형식(${esc(it.ext)})은 브라우저에서 미리 볼 수 없습니다. 다운로드해서 여세요.</div>`;
}

// ---------- account switch (C: user-triggered, picks the account with most headroom) ----------
// termId: a dashboard terminal whose claude has no conversation yet (e.g. not logged in) → restarted on the account
function switchBtnHTML(sid, termId = '') {
  const s = sid && state.live.find((x) => x.sessionId === sid);
  return `<button class="${s?.limit ? 'primary' : ''}" data-switch="${esc(sid)}" data-switch-term="${esc(termId)}" title="이 세션을 AI 사용량에 여유가 가장 많은 계정으로 이어서 실행">⇄ ${s?.limit ? '한도 도달 · ' : ''}다른 계정으로</button>`;
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-switch]');
  if (b) { e.stopPropagation(); openSwitch(b.dataset.switch, b.dataset.switchTerm); }
}, true);
async function openSwitch(sid, termId = '') {
  const d = document.createElement('div');
  d.className = 'dlg';
  d.innerHTML = '<div class="box"><h3>다른 계정으로 이어하기</h3><div id="swBody">AI 사용량 확인 중…</div></div>';
  document.body.appendChild(d);
  d.onclick = (e) => { if (e.target === d) d.remove(); };
  const r = await api(`/api/switch/candidates?id=${encodeURIComponent(sid)}${termId ? `&term=${encodeURIComponent(termId)}` : ''}`).catch((e) => ({ error: e.message }));
  const body = $('#swBody', d);
  if (r.error || !r.candidates) { body.innerHTML = `<div class="err">${esc(r.error || '후보를 불러오지 못함')}</div>`; return; }
  const s = state.live.find((x) => x.sessionId === sid);
  const pct = (v) => (v === null || v === undefined ? '<span class="up">?</span>' : `${bar(v, true)}<span class="up ${level(v)}">${v}</span>`);
  body.innerHTML = `
    ${s?.limit ? `<div class="err" style="padding:0 0 6px">${esc(s.limit.text)}</div>` : ''}
    <div class="empty" style="padding:0 0 6px">5시간 · 주간 사용률 (%). 둘 중 더 빡빡한 쪽 기준으로 가장 여유 있는 계정을 미리 골라 둡니다.</div>
    <div class="swlist">${r.candidates.map((c) => `<label class="swrow${c.usable && !c.current ? '' : ' dis'}">
      <input type="radio" name="acc" value="${esc(c.id)}" ${c.best ? 'checked' : ''} ${c.usable && !c.current ? '' : 'disabled'}>
      <span class="swl">${esc(c.label)}${c.current ? ` <span class="badge">${c.sameAccount ? '현재와 같은 계정' : '현재'}</span>` : ''}${c.best ? ' <span class="badge c">가장 여유</span>' : ''}</span>
      <span class="swm">5h ${pct(c.fiveH)}</span><span class="swm">주 ${pct(c.weekly)}</span></label>`).join('')}</div>
    <label class="row"><input type="checkbox" id="swCont" checked> 재개 후 “계속 진행해” 자동 전송</label>
    ${r.codex ? '' : '<label class="row"><input type="checkbox" id="swSkip" checked> --dangerously-skip-permissions 로 실행</label>'}
    <div class="empty" style="padding:0">${r.codex ? 'codex를 종료하고, 고른 ChatGPT 계정으로 같은 대화를 이어서 엽니다 (codex resume). 계정 추가: AI 사용량 → 계정 관리 → Codex 계정 추가' : r.fresh ? '아직 대화가 없는 터미널이라, 같은 폴더에서 고른 계정으로 claude를 새로 시작합니다 (즐겨찾기 유지).' : r.live ? `실행 중인 세션(${esc(r.where || '창 없음')})은 /exit로 종료한 뒤 대시보드 터미널에서 이어집니다.` : '종료된 세션을 대시보드 터미널에서 이어 실행합니다.'}${r.stale ? ' · 사용량 값이 오래됐을 수 있음' : ''}</div>
    <div class="row" style="justify-content:flex-end"><button id="swCancel">취소</button><button class="primary" id="swGo" ${r.candidates.some((c) => c.best) ? '' : 'disabled'}>전환</button></div>`;
  $('#swCancel', d).onclick = () => d.remove();
  $('#swGo', d).onclick = async () => {
    const acc = $('input[name=acc]:checked', d)?.value;
    if (!acc) return;
    const go = $('#swGo', d); go.disabled = true; go.textContent = '전환 중…';
    const payload = { sessionId: sid || undefined, termId: termId || undefined, account: acc, cont: $('#swCont', d).checked, skip: $('#swSkip', d)?.checked ?? true };
    let res = await api('/api/switch', { method: 'POST', body: payload });
    if (res.busy && confirm('세션이 작업 중입니다. 중단(Esc)하고 전환할까요?')) res = await api('/api/switch', { method: 'POST', body: { ...payload, interrupt: true } });
    if (res.stuck && confirm(res.error)) res = await api('/api/switch', { method: 'POST', body: { ...payload, interrupt: true, force: true } });
    if (!res.ok) { go.disabled = false; go.textContent = '전환'; if (!res.busy) body.insertAdjacentHTML('afterbegin', `<div class="err" style="padding:0 0 8px">${esc(res.error)}</div>`); return; }
    d.remove();
    await refreshOverview();
    select({ kind: 'term', id: res.term.id });
    toast(`${res.account.label.replace(/@.*/, '')} 계정으로 이어서 실행`);
  };
}

// ---------- GPU / resource queue ----------
const fmtMB = (m) => (m >= 1024 ? `${(m / 1024).toFixed(1)}G` : `${Math.round(m)}M`);
async function refreshGpu() {
  try { state.gpu = await api('/api/gpu'); } catch { return; }
  renderSide();
  if (state.sel.kind === 'gpu') paintGpu();
}
function gpuSideHTML() {
  const q = state.gpu;
  if (!q || (!q.gpus?.length && !q.error)) return '';
  const rows = q.gpus.map((g) => {
    const pct = g.totalMB ? Math.round((g.usedMB / g.totalMB) * 100) : 0;
    if (g.index < 0) return `<div class="urow"><span class="ul">${esc(g.server || g.host)}</span><span class="badge">${g.enabled === false ? 'OFF' : '연결 안 됨'}</span></div>`;
    return `<div class="urow${g.enabled === false ? ' off' : ''}"><span class="ul">${g.enabled === false ? '[OFF] ' : ''}${esc(g.server ? g.host + ' ' : '')}GPU${g.index} ${esc(g.name.replace(/NVIDIA |GeForce /g, ''))}</span>${bar(pct, true)}<span class="up ${level(pct)}">${pct}</span>${bar(g.util, true)}<span class="up ${level(g.util)}">${g.util}</span></div>`;
  }).join('');
  const sel = state.sel.kind === 'gpu' ? ' sel' : '';
  const badge = `${q.active.length ? `<span class="badge c">사용 ${q.active.length}</span>` : ''}${q.waiting.length ? `<span class="badge lim">대기 ${q.waiting.length}</span>` : ''}`;
  return `<div class="sec"><h2>GPU · 대기열<span class="sp"></span>${badge}<span style="text-transform:none;letter-spacing:0">mem · util %</span></h2>
    <div class="item usebox${sel}" data-key="gpu"><div class="body">${rows || `<div class="empty">${esc(q.error || 'GPU 없음')}</div>`}</div></div></div>`;
}
function viewGpu() {
  setBar(`<h2>GPU · 리소스 대기열</h2><span class="badge desk">5초마다 갱신 · 대기열 밖 프로세스는 절대 종료하지 않음</span>`);
  $('#view').onclick = async (e) => {
    const tg = e.target.closest('[data-gtoggle]');
    if (tg) {
      const on = tg.dataset.on !== '1';
      if (!on && !confirm(`${tg.dataset.gtoggle}을(를) OFF로 바꿀까요? 새 작업을 배정하지 않습니다. 이미 실행 중인 작업은 그대로 계속됩니다.`)) return;
      await api('/api/gpu/toggle', { method: 'POST', body: { key: tg.dataset.gtoggle, enabled: on } });
      toast(`${tg.dataset.gtoggle} → ${on ? 'ON (사용 가능)' : 'OFF (배정 중지)'}`);
      return refreshGpu();
    }
    const b = e.target.closest('[data-gact]'); if (!b) return;
    const { gact, id } = b.dataset;
    if (gact === 'est') {
      const v = prompt('예상 시간 (예: 90m, 2h, 1h30m) 또는 끝나는 시각 (예: 01:10)');
      if (!v) return;
      const r = await api('/api/gpu/est', { method: 'POST', body: /^\d{1,2}:\d{2}$/.test(v.trim()) ? { id, until: v.trim() } : { id, est: v.trim() } });
      toast(r.ok ? `예상 ${r.estMin}분으로 설정` : r.error);
      return refreshGpu();
    }
    if (gact === 'release' && !confirm('대기열에서 빼시겠어요? 실행 중인 프로세스는 종료되지 않습니다. 자동 등록된 작업은 다시 등록되지 않습니다.')) return;
    await api(gact === 'top' ? '/api/gpu/priority' : '/api/gpu/release', { method: 'POST', body: { id, byUser: true } });
    refreshGpu();
  };
  paintGpu();
}
function paintGpu() {
  const q = state.gpu;
  if (!q) { $('#view').innerHTML = '<div class="empty" style="padding:20px">불러오는 중…</div>'; return; }
  const who = (t) => esc(t.requester?.title || (t.requester?.pid ? `pid ${t.requester.pid}` : '?'));
  const mins = (ms) => { const m = Math.round(ms / 60000); return m >= 60 ? `${Math.floor(m / 60)}시간 ${m % 60}분` : `${m}분`; };
  const sw = (key, on) => `<button class="sw ${on ? 'on' : ''}" data-gtoggle="${esc(key)}" data-on="${on ? 1 : 0}" title="사용 가능 여부 (OFF = 새 작업 배정 안 함)"><i></i>${on ? 'ON' : 'OFF'}</button>`;
  const servers = (q.servers || []).map((v) => `<div class="swrow"><span class="swl"><b>🖥 ${esc(v.name)}</b> <span class="badge">${esc(v.id)}</span>
      <br><span class="ums">${v.reachable == null ? '⚪ 확인 중' : v.reachable ? '🟢 연결됨' : '🔴 연결 안 됨'}${v.checkedAt ? ' · 확인 ' + relTime(v.checkedAt) : ''} · 실행: <code>ccd gpu run --gpu ${esc(v.id)} --mem 20G -- 명령</code> (서버에서 ssh로 실행)</span></span>${sw(v.id, v.enabled)}</div>`).join('');
  const cards = q.gpus.filter((g) => g.index >= 0).map((g) => {
    const ext = Math.max(0, g.usedMB - g.leasedMB), freeMB = Math.max(0, g.totalMB - g.usedMB);
    const seg = (mb, cls) => g.totalMB ? `<i class="${cls}" style="width:${(mb / g.totalMB) * 100}%"></i>` : '';
    return `<div class="ucard">
      <div class="uh"><b>${esc(g.server ? g.server + ' · ' : '')}GPU ${g.index} · ${esc(g.name)}</b>${g.exclusive ? '<span class="badge lim">전용 사용 중</span>' : ''}${g.host === 'local' ? sw(g.key, g.enabled !== false) : g.enabled === false ? '<span class="badge">서버 OFF</span>' : ''}</div>
      ${g.error ? `<div class="err" style="padding:0">${esc(g.error)}</div>` : `
      <div class="umt"><span>메모리 ${fmtMB(g.usedMB)} / ${fmtMB(g.totalMB)} · 여유 ${fmtMB(freeMB)}</span><span class="up ${level((g.usedMB / g.totalMB) * 100)}">${Math.round((g.usedMB / g.totalMB) * 100)}%</span></div>
      <span class="ubar gstack">${seg(Math.min(g.leasedMB, g.usedMB), 'lease')}${seg(ext, 'ext')}</span>
      <div class="ums"><span class="lg lease"></span>대기열 예약 ${fmtMB(g.leasedMB)} · <span class="lg ext"></span>그 외 사용 ${fmtMB(ext)}${g.pendingMB ? ` · 할당 대기 예약 ${fmtMB(g.pendingMB)}` : ''}</div>
      <div class="umt"><span>사용률</span><span class="up ${level(g.util)}">${g.util}%</span></div>${bar(g.util)}
      ${Number.isFinite(g.tempC) ? `<div class="umt"><span>온도 GPU ${g.tempC}°C${Number.isFinite(g.cpuC) ? ` · CPU ${g.cpuC}°C` : ''}${Number.isFinite(g.tlimitC) ? ` · 감속까지 ${g.tlimitC}°C` : ''}</span><span class="up ${g.hot ? 'hi' : g.tempC >= 75 ? 'mid' : 'lo'}">${g.hot ? '과열 — 새 작업 보류' : '정상'}</span></div>` : ''}
      ${g.hot ? `<div class="err" style="padding:0">🔥 ${esc(g.hotReason || '')} → 식을 때까지 새 작업을 배정하지 않음 (실행 중인 작업은 그대로)</div>` : ''}
      ${g.procs?.length ? `<div class="ums">연산 프로세스: ${g.procs.map((p) => `${esc(p.name)}(${p.pid})`).join(', ')}</div>` : ''}`}
      ${(() => { const ln = q.lanes?.[g.key]; if (!ln) return ''; const hm = (x) => new Date(x).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        return `<div class="umt"><span>이 GPU 대기 ${ln.waiting.length}개${ln.headStart ? ` · 다음 시작 ~${hm(ln.headStart)}` : ''}</span><span class="ums">${ln.running ? (ln.freeBy ? `비는 시각 ~${hm(ln.freeBy)}` : '비는 시각 모름') : '비어 있음'}</span></div>`; })()}
    </div>`;
  }).join('');
  const row = (t, actions) => `<div class="swrow"><span class="swl" title="${esc(t.command || '')}"><b>${esc(t.label || t.id)}</b> <span class="badge">${esc(t.status === 'waiting' && t.lanes?.length ? t.lanes.join(' · ') : t.gpu)}</span> <span class="badge">${t.exclusive ? '전용' : t.memMB == null ? '메모리 측정 불가' : fmtMB(t.memMB)}</span>${t.adopted ? ' <span class="badge c">자동 등록</span>' : ''}<br>
    <span class="ums">${who(t)} · ${t.status === 'waiting'
      ? `대기 ${mins(t.waitedMs)} · 해당 GPU 줄 ${t.position}번째${t.expectedStart ? ` · 예상 시작 ${new Date(t.expectedStart).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}`
      : `사용 ${mins(Date.now() - t.grantedAt)}${t.expectedEnd ? ` · 예상 종료 ${new Date(t.expectedEnd).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${t.estSource === 'learned' ? ' (과거 기록)' : ''}` : ' · 예상 종료 모름'}`}${t.backfilled ? ' · 끼워넣기' : ''}</span></span>${actions}</div>`;
  const hist = (q.history || []).map((t) => `<div class="ums">${esc(new Date(t.endedAt).toLocaleTimeString())} · ${esc(t.label || t.id)} · ${t.status === 'released' ? '해제' : '취소'} (${esc(t.endReason || '')})</div>`).join('');
  $('#view').innerHTML = `<div class="ugrid">${cards || `<div class="err">${esc(q.error || 'GPU를 찾지 못함 (nvidia-smi)')}</div>`}</div>
    ${servers ? `<div class="rwrap" style="padding-bottom:0"><div class="rcard"><b>원격 서버</b>${servers}</div></div>` : ''}
    <div class="rwrap" style="padding-top:0">
      <div class="ums">끼워넣기: 맨 앞 작업이 들어갈 수 있는 예상 시각 전에 끝나거나, 그때도 자리를 남기는 작업만 먼저 실행합니다(예상 시간이 없는 작업은 순서대로 대기). 예상 시간은 ⏱ 버튼 또는 <code>--est 90m</code>.</div>
      <div class="rcard"><b>사용 중 (${q.active.length})</b><div class="ums">대기열 밖에서 시작된 GPU 작업도 자동으로 찾아 현재 사용자로 등록합니다. 작업이 끝나면 대기열이 순서대로 진행됩니다.</div>${q.active.map((t) => row(t, `<button data-gact="est" data-id="${t.id}" title="예상 종료 시각/시간 입력">⏱</button><button data-gact="release" data-id="${t.id}" title="${t.adopted ? '대기열 등록만 해제 (프로세스는 계속 실행됨)' : '예약 해제'}">${t.adopted ? '등록 해제' : '해제'}</button>`)).join('') || '<div class="empty">없음</div>'}</div>
      <div class="rcard"><b>대기 (${q.waiting.length})</b>${q.waiting.map((t, i) => row(t, `<button data-gact="est" data-id="${t.id}" title="예상 실행 시간 입력">⏱</button>${i ? `<button data-gact="top" data-id="${t.id}">맨 앞으로</button>` : ''}<button data-gact="release" data-id="${t.id}">취소</button>`)).join('') || '<div class="empty">없음</div>'}</div>
      <div class="rcard"><b>사용 방법 (세션·에이전트)</b><pre class="rpre" style="padding:0">ccd gpu run --mem 20G --label exp-003 -- python train.py   # 차례가 되면 실행, 끝나면 자동 해제
ccd gpu run --exclusive -- python big_job.py              # GPU 전체를 혼자 사용
ccd gpu request --mem 8G --wait  →  ccd gpu release &lt;id&gt;  # 직접 잡고 놓기
ccd gpu                                                  # 상태·대기열 (GPU별 줄)
ccd gpu plan --mem 12G --est 2h                          # GPU마다 시작·종료 예상 → GPU를 고르고 그 환경에 맞춰 준비</pre></div>
      ${hist ? `<details class="rsec"><summary>최근 기록</summary><div style="padding:0 14px 12px">${hist}</div></details>` : ''}
    </div>`;
}

// ---------- autonomous research projects ----------
const PHASE_KO = { P1_ideation: '아이디어', P2_venue: '타겟 조사', P3_literature: '문헌·SOTA', P4_plan: '계획', P5_experiment: '실험', P6_analysis: '분석', P7_iterate: '재실험·재계획', P8_writing: '논문 작성', P9_review: '리뷰·수정', P10_submission: '투고 준비' };
const PHASE_DESC = {
  P1_ideation: '아이디어 후보를 여러 개 만들어 비교하고, 가장 좋은 주 아이디어와 예비 아이디어를 고릅니다.',
  P2_venue: '목표 학회·저널의 분량, 양식, 심사 기준, 마감을 조사해 투고할 곳을 정합니다.',
  P3_literature: '관련 연구와 최신 기술을 조사하고, 인용이 실제로 존재하는지 코드로 확인합니다.',
  P4_plan: '가설, 실험 설계, 베이스라인, 데이터셋, 지표, 일정을 정합니다.',
  P5_experiment: '구현 → 작은 테스트 → 본 실험 순서로 진행합니다. GPU는 대기열로 씁니다.',
  P6_analysis: '결과 파일에서 표와 그림을 생성하고, 가설이 맞았는지 판정합니다.',
  P7_iterate: '약점을 보완하기 위해 재실험하거나 계획을 다시 세웁니다(최대 3회).',
  P8_writing: '목표 학회 양식에 맞춰 LaTeX 논문을 씁니다.',
  P9_review: '리뷰어 관점으로 검토하고, 수치와 인용을 검증한 뒤 수정합니다.',
  P10_submission: '투고 패키지(형식·익명화·보충자료·커버레터·체크리스트)를 준비합니다. 실제 제출은 사용자가 합니다.',
};
const GOAL_KO = { P1_ideation: '아이디어 확정까지', P2_venue: '타겟 학회 결정까지', P3_literature: '문헌 조사까지', P4_plan: '실험 계획까지', P5_experiment: '실험 완료까지', P6_analysis: '결과 분석까지', P7_iterate: '재실험까지', P8_writing: '논문 초안까지', P9_review: '리뷰까지 마친 최종 논문', P10_submission: '투고 준비까지' };
// result verdict recorded by the director at done
const R_RESULT = { positive: ['양성', 'ok'], negative: ['음성', 'bad'], mixed: ['혼합', 'warn'] };
const resultBadge = (p) => (p.result && R_RESULT[p.result] ? `<span class="badge ${R_RESULT[p.result][1] === 'bad' ? 'lim' : 'c'}" title="${esc(p.result_summary || '')}">${R_RESULT[p.result][0]}</span>` : '');
const R_STATUS = { running: ['자율 진행 중', 'ok', '●'], waiting: ['대기 중', 'warn', '⏳'], paused: ['일시정지', 'muted', '⏸'], blocked: ['확인 필요', 'bad', '⚠'], done: ['목표 달성', 'ok', '✔'] };
const R_TABS = [['overview', '개요'], ['report', '보고서'], ['plan', '계획'], ['activity', '활동 기록'], ['outputs', '산출물'], ['settings', '브리프·설정']];

// Tiny markdown renderer (escapes everything first; links only http/https).
function md(src) {
  const lines = String(src || '').replace(/\r/g, '').split('\n');
  const inline = (t) => esc(t)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const out = [];
  let i = 0, list = null, para = [];
  const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  while (i < lines.length) {
    const l = lines[i];
    if (/^```/.test(l)) {
      flushPara(); closeList();
      const buf = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      out.push(`<pre class="mdpre">${esc(buf.join('\n'))}</pre>`); i++; continue;
    }
    if (/^\s*\|.*\|\s*$/.test(l) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      flushPara(); closeList();
      const row = (x) => x.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = row(l); i += 2;
      const body = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) body.push(row(lines[i++]));
      out.push(`<div class="mdtw"><table class="mdt"><thead><tr>${head.map((h) => `<th>${inline(h)}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    let m;
    if ((m = l.match(/^(#{1,6})\s+(.*)/))) { flushPara(); closeList(); const n = Math.min(6, m[1].length + 1); out.push(`<h${n}>${inline(m[2])}</h${n}>`); i++; continue; }
    if (/^\s*(---+|\*\*\*+)\s*$/.test(l)) { flushPara(); closeList(); out.push('<hr>'); i++; continue; }
    if ((m = l.match(/^\s*>\s?(.*)/))) { flushPara(); closeList(); out.push(`<blockquote>${inline(m[1])}</blockquote>`); i++; continue; }
    if ((m = l.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)/))) {
      flushPara();
      const type = /\d/.test(m[2]) ? 'ol' : 'ul';
      if (list !== type) { closeList(); out.push(`<${type}>`); list = type; }
      const task = m[3].match(/^\[( |x|X)\]\s+(.*)/);
      out.push(`<li${m[1].length >= 2 ? ' class="sub"' : ''}>${task ? `${task[1].trim() ? '☑' : '☐'} ${inline(task[2])}` : inline(m[3])}</li>`);
      i++; continue;
    }
    if (!l.trim()) { flushPara(); closeList(); i++; continue; }
    closeList(); para.push(l.trim()); i++;
  }
  flushPara(); closeList();
  return `<div class="md">${out.join('\n')}</div>`;
}
// JOURNAL.md "- <ISO time> text" lines → [{ts, text}]
function journalItems(txt) {
  return String(txt || '').split('\n').map((l) => l.match(/^-\s*(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\s*(.*)$/)).filter(Boolean)
    .map((m) => ({ ts: Date.parse(m[1]), text: m[2] }));
}
const relTime = (ms) => {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return '방금'; if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`; return `${Math.floor(s / 86400)}일 전`;
};
function goalProgress(p) {
  const phases = Object.keys(PHASE_KO);
  const goal = p.config?.goal || 'P9_review';
  const upto = phases.slice(0, phases.indexOf(goal) + 1);
  const passed = upto.filter((ph) => p.gates?.[ph]?.passed).length;
  return { phases, upto, goal, passed, pct: Math.round((passed / upto.length) * 100), cur: phases.indexOf(p.phase) };
}

async function refreshResearch() {
  let r; try { r = await api('/api/research'); } catch { return; }
  state.researchEnabled = Array.isArray(r.projects);
  state.research = r.projects || [];
  renderSide();
  if (state.sel.kind === 'research') paintResearch(true);
}
function researchSideHTML() {
  if (!state.research.length) return '';
  const done = state.research.filter((p) => p.status === 'done');
  // finished studies with a negative/mixed result that no synthesis project uses yet
  const usedInSyn = new Set(state.research.filter((p) => p.lineage?.kind === 'synthesis').flatMap((p) => p.lineage.parents.map((x) => x.slug)));
  const pending = done.filter((p) => (p.result === 'negative' || p.result === 'mixed') && !usedInSyn.has(p.slug));
  const synBtn = done.length >= 2 ? '<button class="linkbtn" data-rsyn="1" title="끝난 연구들을 묶어 분석하는 논문 프로젝트">📚 종합 논문</button>' : '';
  const hint = pending.length >= 3 ? `<div class="rban warn" style="margin:4px 6px"><b>음성·혼합 결과 ${pending.length}개</b>가 모였습니다 — 묶어서 분석하는 종합 논문을 만들 수 있습니다. <button class="linkbtn" data-rsyn="1">📚 만들기</button></div>` : '';
  const bySlug = new Map(state.research.map((p) => [p.slug, p]));
  const parentOf = (p) => (p.lineage?.kind === 'derived' ? p.lineage.parents?.[0]?.slug : null);
  const kids = new Map();
  for (const p of state.research) { const ps = parentOf(p); if (ps && bySlug.has(ps)) kids.set(ps, [...(kids.get(ps) || []), p]); }
  const roots = state.research.filter((p) => !(parentOf(p) && bySlug.has(parentOf(p))));
  const folded = rFolded();
  const filtering = termsOf(state.filter).length > 0; // while searching, show every match
  const row = (p, depth) => {
    const [label] = R_STATUS[p.status] || [p.status];
    const phases = Object.keys(PHASE_KO), i = phases.indexOf(p.phase);
    const dot = p.status === 'blocked' ? 'busy' : p.status === 'running' ? (p.director?.busy ? 'busy' : 'idle') : p.status === 'done' ? 'idle' : '';
    const ch = kids.get(p.slug) || [];
    const isFolded = ch.length && folded.has(p.slug) && !filtering;
    // a folded study still says how many derived studies it holds, and whether one needs attention
    const hidden = isFolded ? descendants(p.slug) : [];
    const foldNote = isFolded ? ` · 파생 ${hidden.length}개${hidden.some((x) => x.status === 'blocked') ? ' (확인 필요 있음)' : hidden.some((x) => x.status === 'running') ? ' (진행 중 있음)' : ''}` : '';
    const fold = ch.length ? `<span class="rfold" data-rfold="${esc(p.slug)}" title="${isFolded ? '파생 연구 펼치기' : '파생 연구 접기'}">${isFolded ? '▸' : '▾'}</span>` : `<span class="rfold none">${depth ? '└' : ''}</span>`; // keeps the dots aligned
    const html = itemHTML({ key: `research:${p.slug}`, dot, depth, fold,
      title: `${p.lineage?.kind === 'synthesis' ? '📚' : p.lineage?.kind === 'derived' ? '🌱' : '🔬'} ${p.name}`, sub: `${PHASE_KO[p.phase] || p.phase} (${i + 1}/${phases.indexOf(p.goal || 'P9_review') + 1}) · ${label}${p.status === 'waiting' && p.wake_at ? ' · ' + new Date(p.wake_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' 재개' : ''}${foldNote}`,
      badge: p.status === 'blocked' ? '<span class="badge lim">확인 필요</span>' : p.status === 'done' ? (resultBadge(p) || '<span class="badge c">완료</span>') : '' });
    return html + (isFolded ? '' : ch.map((c) => row(c, depth + 1)).join(''));
  };
  function descendants(slug) { return (kids.get(slug) || []).flatMap((c) => [c, ...descendants(c.slug)]); }
  return `<div class="sec"><h2>자율 연구<span class="sp"></span>${synBtn}</h2>${hint}${roots.map((p) => row(p, 0)).join('')}</div>`;
}
// folded research trees (per browser)
function rFolded() { try { return new Set(JSON.parse(localStorage.getItem('ccd-rfold') || '[]')); } catch { return new Set(); } }
function toggleRFold(slug) {
  const f = rFolded();
  if (f.has(slug)) f.delete(slug); else f.add(slug);
  try { localStorage.setItem('ccd-rfold', JSON.stringify([...f])); } catch {}
  renderSide();
}

let rCache = { slug: null, json: '', data: null };
function viewResearch() {
  const slug = state.sel.id;
  state.rtab = state.rtab || {};
  rCache = { slug, json: '', data: null };
  $('#bar').onclick = async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.ract) return researchAction(slug, b.dataset.ract);
  };
  $('#view').onclick = async (e) => {
    const t = e.target.closest('[data-rtab]');
    if (t) { state.rtab[slug] = t.dataset.rtab; rCache.json = ''; return paintResearch(); }
    const a = e.target.closest('[data-ract]');
    if (a) return researchAction(slug, a.dataset.ract);
    const f = e.target.closest('[data-rfile]');
    if (f) return openResearchFile(slug, f.dataset.rfile);
    if (e.target.closest('[data-rsyn]')) return openLineageDialog('synthesis', [slug]);
    const g = e.target.closest('[data-rgo]');
    if (g) return select({ kind: 'research', id: g.dataset.rgo });
  };
  $('#view').innerHTML = '<div class="empty" style="padding:20px">불러오는 중…</div>';
  paintResearch();
}
// new derived / synthesis project
function openLineageDialog(kind, preset = []) {
  const done = state.research.filter((p) => p.status === 'done' || preset.includes(p.slug));
  const base = state.research.find((p) => p.slug === preset[0]);
  const d = document.createElement('div');
  d.className = 'dlg';
  const pick = kind === 'synthesis' ? `<div><b>분석할 연구</b> (2개 이상)<div class="rsyn">${done.map((p) => `<label class="row" style="gap:6px"><input type="checkbox" value="${esc(p.slug)}" ${preset.includes(p.slug) || p.result === 'negative' || p.result === 'mixed' ? 'checked' : ''}> ${esc(p.name)} ${resultBadge(p)}</label>`).join('') || '<div class="empty">끝난 연구가 없습니다</div>'}</div></div>` : '';
  d.innerHTML = `<div class="box"><h3>${kind === 'synthesis' ? '📚 종합 논문 만들기' : '🌱 파생 연구 만들기'}</h3>
    ${kind === 'derived' ? `<div class="empty" style="padding:0">기반: <b>${esc(base?.name || preset[0])}</b> ${base ? resultBadge(base) : ''} — 이 연구는 그대로 두고, 결과·실패 기록·코드를 이어받습니다.</div>` : '<div class="empty" style="padding:0">끝난 연구들의 결과(특히 음성 결과)를 비교·분석해 공통 원인과 교훈을 정리하는 논문입니다. 수치는 각 연구의 결과 파일에서만 가져옵니다.</div>'}
    ${pick}
    <label>프로젝트 이름<br><input id="lName" style="width:100%" value="${esc(kind === 'derived' ? (base?.name || '') + ' 후속' : '')}" placeholder="${kind === 'synthesis' ? '예: DT 재구성 접근들의 음성 결과 분석' : ''}"></label>
    <label>방향${kind === 'derived' ? ' (FINAL.md의 "다음 선택지"를 참고해 적거나, 비우면 디렉터가 제안 중에서 고릅니다)' : ''}<br><textarea id="lDir" rows="6" style="width:100%" placeholder="${kind === 'synthesis' ? '예) 세 연구가 공통으로 실패한 이유가 측정 기준 때문인지 방법 때문인지 밝히고, 언제 이 접근이 통하는지 정리' : '예) 음성 결과의 원인으로 보인 조명 변화만 통제한 조건에서 다시 검증'}"></textarea></label>
    <label>목표 학회·저널 (선택)<br><input id="lVenue" style="width:100%" placeholder="비우면 디렉터가 조사해 정합니다"></label>
    <div class="row" style="justify-content:flex-end"><button id="lCancel">취소</button><button class="primary" id="lOk">만들고 시작</button></div></div>`;
  document.body.appendChild(d);
  $('#lCancel', d).onclick = () => d.remove();
  $('#lOk', d).onclick = async () => {
    const parents = kind === 'synthesis' ? [...d.querySelectorAll('.rsyn input:checked')].map((x) => x.value) : preset;
    const dir = $('#lDir', d).value.trim() || (kind === 'derived' ? '기반 연구 FINAL.md의 "다음 선택지" 중 가장 유망한 방향을 골라 진행 (선택 이유를 DECISIONS.md에 기록)' : '');
    const body = { name: $('#lName', d).value.trim(), direction: dir, venue: $('#lVenue', d).value.trim(), kind, parents };
    if (!body.name || !body.direction) return toast('이름과 방향을 입력하세요');
    if (kind === 'synthesis' && parents.length < 2) return toast('분석할 연구를 2개 이상 고르세요');
    $('#lOk', d).disabled = true;
    const r = await api('/api/research/new', { method: 'POST', body });
    if (r.error) { $('#lOk', d).disabled = false; return toast(r.error, 6000); }
    d.remove();
    await Promise.all([refreshOverview(), refreshResearch()]);
    select({ kind: 'research', id: r.slug });
  };
}
async function researchAction(slug, act) {
  if (act === 'open') {
    const r = await api('/api/research/open', { method: 'POST', body: { slug } });
    if (r.error) return toast(r.error);
    await refreshOverview();
    return r.term ? select({ kind: 'term', id: String(r.term) }) : select({ kind: 'console', id: String(r.console) });
  }
  if (act === 'pause' || act === 'resume') {
    await api('/api/research/control', { method: 'POST', body: { slug, action: act } });
    toast(act === 'pause' ? '일시정지 — 지금 하던 턴이 끝나면 멈춥니다' : '자율 진행을 재개합니다');
    rCache.json = ''; return refreshResearch();
  }
  if (act === 'submit') {
    if (!confirm('이 연구를 이어서 투고 패키지(형식·익명화·보충자료·커버레터·체크리스트)까지 준비합니다. 실제 제출은 직접 하셔야 합니다. 진행할까요?')) return;
    const r = await api('/api/research/submit', { method: 'POST', body: { slug } });
    if (r.error) return toast(r.error, 6000);
    toast('투고 준비를 시작했습니다'); rCache.json = ''; return refreshResearch();
  }
  if (act === 'derive') return openLineageDialog('derived', [slug]);
  if (act === 'folder') { await api('/api/research/folder', { method: 'POST', body: { slug } }); return toast('탐색기에서 폴더를 열었습니다 (PC)'); }
  if (act === 'send') {
    const i = $('#rMsg'); const text = i?.value.trim(); if (!text) return;
    i.value = '';
    const r = await api('/api/research/msg', { method: 'POST', body: { slug, text } });
    return toast(r.delivered ? '디렉터에게 바로 전달했습니다' : '디렉터가 작업 중이라 메시지함에 넣었습니다 — 다음 턴에 처리합니다', 5000);
  }
}
async function openResearchFile(slug, rel) {
  const d = document.createElement('div');
  d.className = 'dlg';
  d.innerHTML = `<div class="box wide"><div class="row"><h3 style="flex:1;margin:0">${esc(rel)}</h3><button id="fvClose">닫기</button></div><div id="fvBody" class="fvbody">불러오는 중…</div></div>`;
  document.body.appendChild(d);
  d.onclick = (e) => { if (e.target === d || e.target.id === 'fvClose') d.remove(); };
  if (/\.(png|jpe?g|pdf)$/i.test(rel)) { $('#fvBody', d).innerHTML = '<div class="empty">이미지·PDF는 PC에서 "폴더 열기"로 확인하세요.</div>'; return; }
  const r = await api(`/api/research/file?slug=${encodeURIComponent(slug)}&path=${encodeURIComponent(rel)}`);
  const body = $('#fvBody', d);
  if (r.error) { body.innerHTML = `<div class="err">${esc(r.error)}</div>`; return; }
  if (/\.md$/i.test(rel)) body.innerHTML = md(r.text);
  else if (/\.json$/i.test(rel)) { let t = r.text; try { t = JSON.stringify(JSON.parse(r.text), null, 2); } catch {} body.innerHTML = `<pre class="mdpre">${esc(t)}</pre>`; }
  else body.innerHTML = `<pre class="mdpre">${esc(r.text)}</pre>`;
}

let rComposing = false;
async function paintResearch(auto) {
  const gen = viewGen, slug = state.sel.id;
  const d = await api(`/api/research/detail?slug=${encodeURIComponent(slug)}`).catch((e) => ({ error: e.message }));
  if (gen !== viewGen || state.sel.kind !== 'research' || state.sel.id !== slug) return;
  if (d.error) { $('#view').innerHTML = `<div class="err">${esc(d.error)}</div>`; return; }
  const tab = state.rtab?.[slug] || 'overview';
  // only what this page shows: GPU lease ids/labels, not their live memory/heartbeat numbers
  const json = JSON.stringify(d) + tab + JSON.stringify((state.gpu?.active || []).map((t) => [t.id, t.label]));
  if (json === rCache.json) return; // nothing changed → keep scroll / typing
  // don't rebuild the page under the user's hands: while typing in the message box (or composing
  // Korean), or with text selected, try again on the next refresh
  const ae = document.activeElement;
  if (auto && ((ae?.id === 'rMsg' && (ae.value || rComposing)) || String(window.getSelection?.() || '').length)) return;
  rCache.json = json; rCache.data = d;

  const [label, tone, icon] = R_STATUS[d.status] || [d.status, 'muted', '•'];
  const running = !['paused', 'blocked', 'done'].includes(d.status);
  setBar(`<h2>🔬 ${esc(d.name)}</h2><span class="pill ${tone}">${icon} ${esc(label)}</span>
    <button data-ract="open">디렉터 화면</button>
    ${running ? '<button data-ract="pause">일시정지</button>' : `<button data-ract="resume" class="primary">${d.status === 'done' ? '다시 진행' : '재개'}</button>`}
    <button data-ract="folder" class="desk">폴더 열기</button>`);

  const prog = goalProgress(d);
  const msgVal = $('#rMsg')?.value || '';
  const tabs = `<div class="rtabs">${R_TABS.map(([k, t]) => `<button data-rtab="${k}" class="${k === tab ? 'on' : ''}">${t}</button>`).join('')}</div>`;
  let body = '';

  if (tab === 'overview') {
    const rv = d.review;
    const reviewCard = rv ? `<div class="rban ${rv.passed ? 'ok' : 'warn'}"><div><b>📝 리뷰 루프 ${rv.rounds}/${rv.max}라운드</b> · 최근 판정 <b>${esc(rv.recommendation || '없음')}</b> (기준 ${esc(rv.min)} 이상)
        · 채택 논문 비교 ${rv.bench ? `<b>최저 ${rv.bench.worst}위</b>/${rv.bench.of}편 (기준 ${rv.maxRank}위 이내)` : '아직 없음'}</div>
        ${rv.passed ? '<div>✔ 종료 기준 충족</div>' : `<div class="empty" style="padding:0">남은 조건: ${esc(rv.reasons.join(' · '))}</div>`}
        ${rv.stalled ? '<div>⚠ 최근 라운드에서 판정이 나아지지 않아 실험 보강(P7)으로 돌아가도록 안내 중</div>' : ''}</div>` : '';
    const banner = d.status === 'blocked'
      ? `<div class="rban bad"><b>⚠ 확인이 필요합니다</b><div>${esc(d.blocked_reason || '')}</div>${d.questions?.split('\n').length > 2 ? md(d.questions) : ''}<div class="row"><button class="primary" data-ract="resume">해결했어요 · 재개</button><span class="empty">또는 아래 메시지로 지시</span></div></div>`
      : d.status === 'done'
        ? `<div class="rban ok"><b>✔ 목표(${esc(GOAL_KO[prog.goal])})에 도달했습니다</b> ${resultBadge(d)}${d.result_summary ? ` <span class="empty">${esc(d.result_summary)}</span>` : ''}
            <div class="row" style="margin:6px 0">${prog.goal !== 'P10_submission' ? '<button class="primary" data-ract="submit" title="이 연구를 이어서 투고 패키지까지 준비 (제출은 직접)">📤 투고 준비 진행</button>' : '<span class="empty">투고 패키지: 산출물 탭 → research/submission · 제출은 직접 하세요</span>'}
              <button data-ract="derive" title="이 연구는 그대로 두고, 결과·실패 기록을 이어받는 새 연구">🌱 파생 연구 만들기</button>
              <button data-rsyn="1" title="이 연구를 포함해 여러 연구를 분석하는 논문">📚 종합 논문에 포함</button></div>
            ${d.final ? md(d.final) : '<div>산출물 탭에서 결과를 확인하세요.</div>'}</div>`
        : d.status === 'waiting'
          ? `<div class="rban warn"><b>⏳ 기다리는 중</b> — ${esc(d.wait_reason || '')}${d.wake_at ? ` · <b>${esc(new Date(d.wake_at).toLocaleString())}</b>에 자동 재개` : ''}<div class="row"><button data-ract="resume">지금 깨우기</button></div></div>`
          : d.status === 'paused' ? `<div class="rban muted"><b>⏸ 일시정지됨</b> — 재개를 누르면 이어서 진행합니다.</div>` : '';
    const steps = prog.phases.map((ph, i) => {
      const beyond = i > prog.phases.indexOf(prog.goal);
      const cls = d.gates?.[ph]?.passed ? 'done' : i === prog.cur ? 'cur' : beyond ? 'off' : '';
      return `<div class="rstep ${cls}" title="${esc(PHASE_DESC[ph])}"><span class="n">${d.gates?.[ph]?.passed ? '✓' : i + 1}</span><span class="l">${PHASE_KO[ph]}</span></div>`;
    }).join('');
    const items = journalItems(d.journal).slice(-8).reverse();
    const myGpu = (state.gpu?.active || []).filter((t) => (t.requester?.cwd || '').toLowerCase().startsWith(d.dir.toLowerCase()) || (t.command || '').toLowerCase().includes(d.dir.toLowerCase()));
    body = `${reviewCard}${banner}
      <div class="rcard">
        <div class="rprog"><div><b>진행률</b> <span class="empty">목표: ${esc(GOAL_KO[prog.goal])}</span></div><b>${prog.pct}%</b></div>
        ${bar(prog.pct)}
        <div class="rsteps">${steps}</div>
        <div class="rnow"><span class="empty">지금 단계</span> <b>${PHASE_KO[d.phase] || d.phase}</b> — ${esc(PHASE_DESC[d.phase] || '')}</div>
      </div>
      <div class="rcard">
        <div class="rnow"><span class="empty">다음 작업</span><br><b>${esc(d.next_action || '-')}</b></div>
        ${d.lineage ? `<div><span class="empty">${d.lineage.kind === 'derived' ? '기반 연구' : '종합 대상'}</span> ${d.lineage.parents.map((x) => `<button class="linkbtn" data-rgo="${esc(x.slug)}">${esc(x.name || x.slug)}</button>`).join(' · ')}</div>` : ''}
        ${d.children?.length ? `<div><span class="empty">이어진 연구</span> ${d.children.map((c) => `<button class="linkbtn" data-rgo="${esc(c)}">${esc((state.research.find((x) => x.slug === c) || {}).name || c)}</button>`).join(' · ')}</div>` : ''}
        <div class="empty" style="padding:0">디렉터 ${d.director ? (d.director.busy ? '🟠 작업 중' : '🟢 대기') + ` · ${d.director.term ? 't:' + d.director.term : 'c:' + d.director.console}` : '⚪ 실행 중 아님 (워치독이 자동 재개)'} · 시작 ${esc(d.created_at ? new Date(d.created_at).toLocaleDateString() : '-')} · 갱신 ${d.updated_at ? relTime(Date.parse(d.updated_at)) : '-'}</div>
        ${d.workers?.length ? `<div><span class="empty">워커</span> ${d.workers.map((w) => `<span class="badge">${esc(w.id)} ${esc(w.status || '')}</span>`).join(' ')}</div>` : ''}
        ${myGpu.length ? `<div><span class="empty">GPU</span> ${myGpu.map((t) => `<span class="badge c">${esc(t.label || t.id)}</span>`).join(' ')}</div>` : ''}
      </div>
      <div class="rcard"><b>최근 활동</b>
        <div class="tl">${items.map((x) => `<div class="tli"><span class="tlt">${relTime(x.ts)}</span><span>${esc(x.text)}</span></div>`).join('') || '<div class="empty">아직 기록 없음</div>'}</div>
        <button data-rtab="activity" class="linkbtn">전체 기록 보기 →</button>
      </div>
      <div class="rcard"><b>디렉터에게 말하기</b>
        <div class="row"><input id="rMsg" style="flex:1;min-width:200px" placeholder="방향 수정, 추가 지시, 참고 자료 등 (작업 중이면 다음 턴에 반영)"><button class="primary" data-ract="send">보내기</button></div>
        <div class="empty" style="padding:0">디렉터는 중간에 묻지 않고 스스로 결정하며 진행합니다. 목표에 도달하거나, 진행할 수 없는 문제가 생겼을 때만 멈춥니다.</div>
      </div>`;
  } else if (tab === 'report') {
    body = `<div class="rcard">${d.final ? md(d.final) + '<hr>' : ''}${md(d.report)}</div>`;
  } else if (tab === 'plan') {
    body = `<div class="rcard">${md(d.plan)}</div>`;
  } else if (tab === 'activity') {
    const items = journalItems(d.journal).reverse();
    body = `<div class="rcard"><b>활동 기록</b><div class="tl">${items.map((x) => `<div class="tli"><span class="tlt" title="${esc(new Date(x.ts).toLocaleString())}">${esc(new Date(x.ts).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }))}</span><span>${esc(x.text)}</span></div>`).join('') || '<div class="empty">없음</div>'}</div></div>
      <details class="rsec"><summary>스스로 내린 결정 (DECISIONS.md)</summary><div class="rsecb">${md(d.decisions)}</div></details>
      <details class="rsec"><summary>실패한 접근 (FAILED.md)</summary><div class="rsecb">${md(d.failed)}</div></details>
      <details class="rsec"><summary>하네스 로그</summary><pre class="rpre">${esc(d.harnessLog)}</pre></details>`;
  } else if (tab === 'outputs') {
    // same card grid + popup viewer as session outputs; "all files" shows the folder-grouped list
    const outs = d.outputs || [];
    const INTERNAL = /^(CLAUDE|JOURNAL|INBOX|DECISIONS|FAILED|QUESTIONS|MEMORY|README|BRIEF|STATE)\.md$/i;
    const isMain = (f) => ['video', 'audio', 'pdf', 'image', 'html'].includes(f.kind) || /^(docx|xlsx|pptx|ply|glb|obj)$/.test(f.ext)
      || (f.kind === 'markdown' && !INTERNAL.test(f.name)) || /(^|\/)main\.tex$/i.test(f.path);
    const main = outs.map((f, i) => [f, i]).filter(([f]) => isMain(f));
    const card = ([f, i]) => `<div class="acard" data-rout="${i}">
        <div class="athumb">${f.kind === 'image' ? `<img loading="lazy" src="${rRawUrl(slug, f.path)}" alt="">` : `<span>${ART_ICON[f.kind] || '📦'}</span>`}</div>
        <div class="ameta"><b title="${esc(f.path)}">${esc(f.name)}</b>
          <span class="ums">${esc(f.path.split('/').slice(0, -1).join('/') || '(루트)')} · ${fmtSize(f.size)} · ${relTime(f.mtime)}</span></div><button class="asend" data-rsend="${i}" title="이 파일을 세션에 보내기 (경로 멘션)">↗</button></div>`;
    const head = `<div class="row" style="padding:2px 2px 8px"><b style="flex:1">산출물 ${state.rOutAll ? outs.length : main.length}개${state.rOutAll ? '' : ` <span class="empty">(전체 ${outs.length}개 중 영상·PDF·그림·문서)</span>`}</b>
      ${state.rOutAll ? '' : artOrderSel()}
      <label class="row" style="gap:4px"><input type="checkbox" id="rOutAll" ${state.rOutAll ? 'checked' : ''}> 모든 파일 (폴더별)</label></div>`;
    if (!state.rOutAll) {
      body = head + (main.length ? artTimeline(main, card) :'<div class="empty" style="padding:16px">아직 영상·PDF·그림·문서 산출물이 없습니다. "모든 파일"에서 코드·데이터를 볼 수 있습니다.</div>');
    } else {
      const groups = {};
      // group by folder (at most two levels): research, research/ideas, experiments/E0_x, code/...
      outs.forEach((f, i) => {
        const segs = f.path.split('/').slice(0, -1);
        const g = segs.length ? segs.slice(0, 2).join('/') : '(루트)';
        (groups[g] = groups[g] || []).push([f, i]);
      });
      body = head + (Object.entries(groups).map(([g, fs]) => `<div class="rcard"><b>${esc(g)}</b>${fs.map(([f, i]) => `<div class="ofile" data-rout="${i}"><span>${ART_ICON[f.kind] || '📦'} ${esc(f.path.slice(g === '(루트)' ? 0 : g.length + 1))}</span><span class="empty">${fmtSize(f.size)} · ${relTime(f.mtime)}</span></div>`).join('')}</div>`).join('') || '<div class="empty" style="padding:16px">아직 산출물이 없습니다.</div>');
    }
  } else if (tab === 'settings') {
    body = `<div class="rcard"><b>목표 지점</b>
        <div class="row"><select id="rGoal">${Object.entries(GOAL_KO).map(([k, v]) => `<option value="${k}" ${k === prog.goal ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select><button id="rGoalSave">변경</button></div>
        <div class="empty" style="padding:0">이 단계의 게이트를 통과하면 디렉터가 스스로 마무리하고 멈춥니다.</div></div>
      <div class="rcard"><b>목표 학회·저널</b> ${esc(d.config?.venue_hint || '(디렉터가 조사해 결정)')}${d.config?.deadline ? `<div class="empty" style="padding:0">마감: ${esc(d.config.deadline)}</div>` : ''}</div>
      <div class="rcard"><b>연구 브리프 (처음 주신 방향)</b>${md(d.brief)}</div>
      <details class="rsec"><summary>보낸 메시지 (INBOX.md)</summary><div class="rsecb">${md(d.inbox)}</div></details>
      <div class="empty" style="padding:4px 2px">폴더: <span class="mono">${esc(d.dir)}</span></div>`;
  }
  // keep scroll position and input focus/caret across the rebuild
  const hadFocus = document.activeElement?.id === 'rMsg';
  const caret = hadFocus ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
  const scrollers = [...$('#view').querySelectorAll('*'), $('#view')].filter((el) => el.scrollTop > 0).map((el) => [el.className, el.scrollTop]);
  $('#view').innerHTML = `<div class="rwrap">${tabs}${body}</div>`;
  for (const [cls, top] of scrollers) { const el = cls === $('#view').className ? $('#view') : $('#view').getElementsByClassName(cls)[0]; if (el) el.scrollTop = top; }
  const mi = $('#rMsg');
  if (mi) {
    mi.value = msgVal;
    mi.onkeydown = (e) => { if (e.key === 'Enter' && !e.isComposing) researchAction(slug, 'send'); };
    mi.addEventListener('compositionstart', () => { rComposing = true; });
    mi.addEventListener('compositionend', () => { rComposing = false; });
    if (hadFocus) { mi.focus(); try { mi.setSelectionRange(caret[0], caret[1]); } catch {} }
  }
  if (tab === 'outputs') {
    const outs = d.outputs || [];
    const ra = $('#rOutAll');
    if (ra) ra.onchange = (e) => { state.rOutAll = e.target.checked; rCache.json = ''; paintResearch(); };
    bindArtOrder(() => { rCache.json = ''; paintResearch(); });
    $('#view').querySelectorAll('[data-rout]').forEach((el) => (el.onclick = (e) => {
      const f = outs[Number(el.dataset.rout)];
      const abs = rAbs(d.dir, f.path);
      if (e.target.closest('[data-rsend]')) return sendPathDialog(abs);
      openArtifact(null, { ...f, title: f.path, abs }, rRawUrl(slug, f.path));
    }));
  }
  const gs = $('#rGoalSave');
  if (gs) gs.onclick = async () => { await api('/api/research/goal', { method: 'POST', body: { slug, goal: $('#rGoal').value } }); toast('목표 지점을 바꿨습니다'); rCache.json = ''; paintResearch(); };
}

// ---------- search ----------
function runSearch(q) {
  q = (q || '').trim();
  if (!q) return;
  state.search.q = q;
  select({ kind: 'search' });
}

function viewSearch() {
  const gen = viewGen;
  const S = state.search;
  setBar(`<input id="sq" type="search" value="${esc(S.q)}" style="flex:1;min-width:220px" placeholder="검색어 (공백 = AND)">
    <div class="filters">
      <select id="sRole"><option value="all">전체</option><option value="user">내 입력</option><option value="assistant">Claude 답변·명령</option></select>
      <input id="sCwd" placeholder="폴더 포함 (예: myproject)" value="${esc(S.cwd)}" style="width:170px">
      <label><input type="checkbox" id="sScreens" ${S.screens ? 'checked' : ''}> 열린 창 화면</label>
      <label><input type="checkbox" id="sAuto" ${S.auto ? 'checked' : ''}> 자동 실행(sdk) 세션</label>
      <button class="primary" id="sGo">검색</button>
    </div>`);
  $('#sRole').value = S.role;
  const go = () => {
    Object.assign(S, { q: $('#sq').value.trim(), role: $('#sRole').value, cwd: $('#sCwd').value.trim(), screens: $('#sScreens').checked, auto: $('#sAuto').checked });
    select({ kind: 'search' });
  };
  $('#sGo').onclick = go;
  $('#sq').onkeydown = $('#sCwd').onkeydown = (e) => { if (e.key === 'Enter' && !e.isComposing) go(); };
  $('#sRole').onchange = $('#sScreens').onchange = $('#sAuto').onchange = go;
  $('#bar').onclick = null;
  if (!S.q) { $('#view').innerHTML = '<div class="empty" style="padding:20px">검색어를 입력하세요.</div>'; return; }

  $('#view').innerHTML = '<div class="results">검색 중…</div>';
  const params = new URLSearchParams({ q: S.q, role: S.role, cwd: S.cwd, auto: S.auto ? '1' : '0', screens: S.screens ? '1' : '0' });
  api('/api/search?' + params).then((d) => {
    if (gen !== viewGen) return;
    const terms = termsOf(S.q);
    const nHits = d.sessions.reduce((a, r) => a + r.total, 0);
    let h = `<div class="empty">세션 ${d.sessions.length}개 · 메시지 ${nHits}건 · 창 ${d.screens.length}개 · ${d.ms}ms</div>`;
    if (!d.ready) h += `<div class="empty">인덱스 구축 중 (${d.progress?.done || 0}/${d.progress?.total || '?'} 파일) — 결과가 일부만 나올 수 있습니다.</div>`;
    if (d.screens.length) {
      h += '<h3>열린 창 화면</h3>' + d.screens.map((c) => `<div class="rgroup">
        <div class="rh" data-console="${c.id}"><span class="t">${esc(c.title || 'pid ' + c.id)}</span><span class="badge">${c.total}줄</span></div>
        ${c.hits.map((x) => `<div class="hit mono" data-console="${c.id}"><span class="r">화면</span><span class="x">${hl(x.text, terms)}</span></div>`).join('')}</div>`).join('');
    }
    if (d.sessions.length) {
      h += '<h3>세션 대화 기록</h3>' + d.sessions.map((r) => {
        const live = state.live.some((s) => s.sessionId === r.sessionId);
        return `<div class="rgroup">
        <div class="rh" data-sid="${r.sessionId}" data-at="-1"><span class="dot ${live ? 'idle' : 'dead'}"></span>
          <span class="t">${hl(r.title || r.firstPrompt || r.sessionId.slice(0, 8), terms)}</span>
          ${r.idMatch ? '<span class="badge lim">세션 ID 일치</span>' : ''}${r.auto ? '<span class="badge">sdk</span>' : ''}${agentBadge(r.agent)}<span class="badge">${esc(base(r.cwd))}</span>
          <span class="badge">${ago(r.mtime)}</span><span class="badge c">${r.idMatch ? `메시지 ${r.total}개` : `${r.total}건`}</span></div>
        ${r.hits.map((x) => `<div class="hit${x.snippet.startsWith('⚙') ? ' mono' : ''}" data-sid="${r.sessionId}" data-at="${x.i}">
          <span class="r">${x.role === 'user' ? '사용자' : r.agent === 'codex' ? 'Codex' : 'Claude'}</span><span class="x">${hl(x.snippet, terms)}</span></div>`).join('')}
        ${!r.idMatch && r.total > r.hits.length ? `<div class="hit" data-sid="${r.sessionId}" data-at="${r.hits[r.hits.length - 1].i}"><span class="r"></span><span class="x" style="color:var(--muted)">… ${r.total - r.hits.length}건 더 (세션 열어서 보기)</span></div>` : ''}
      </div>`;
      }).join('');
    }
    if (!d.sessions.length && !d.screens.length) h += '<div class="empty" style="padding:12px 0">결과 없음</div>';
    $('#view').innerHTML = `<div class="results">${h}</div>`;
  }).catch((e) => { $('#view').innerHTML = `<div class="err">${esc(e.message)}</div>`; });

  $('#view').onclick = (e) => {
    const el = e.target.closest('[data-sid],[data-console]');
    if (!el) return;
    if (el.dataset.console) return select({ kind: 'console', id: el.dataset.console, hl: S.q });
    select({ kind: 'recent', id: el.dataset.sid, at: Number(el.dataset.at), q: S.q }, 'chat');
  };
  setTimeout(() => $('#sq')?.focus(), 0);
}

const qIn = $('#q');
qIn.addEventListener('input', () => { state.filter = qIn.value; renderSide(); });
qIn.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) runSearch(qIn.value);
  if (e.key === 'Escape') { qIn.value = ''; state.filter = ''; renderSide(); }
});
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && !xterm) { e.preventDefault(); qIn.focus(); qIn.select(); }
});

// calendar counts in the sidebar (todo.md changes come from other sessions too)
loadCalendar();
setInterval(whenShown(loadCalendar), 60000);

// polling only while the page is visible (another tab / phone app in the background → no load)
function whenShown(fn) { return () => { if (!document.hidden) fn(); }; }
document.addEventListener('visibilitychange', () => { if (!document.hidden) { refreshOverview(); refreshGpu(); refreshResearch(); } });

// ---------- new terminal dialog ----------
$('#btnNew').onclick = () => {
  const cwds = [...new Set([...state.live.map((s) => s.cwd), ...state.recent.map((r) => r.cwd)].filter(Boolean))].slice(0, 15);
  const d = document.createElement('div');
  d.className = 'dlg';
  d.innerHTML = `<div class="box"><h3>새로 열기</h3>
    <div class="row"><label><input type="radio" name="k" value="claude" checked> claude</label>
      <label title="ChatGPT 계정(Codex 앱 로그인)으로 GPT 대화형 세션"><input type="radio" name="k" value="codex"> GPT (Codex)</label>
      <label title="Cursor 터미널 에이전트 (cursor-agent, 처음 한 번 cursor-agent login 필요)"><input type="radio" name="k" value="cursor"> Cursor</label>
      <label><input type="radio" name="k" value="powershell"> PowerShell</label>
      <label><input type="radio" name="k" value="cmd"> cmd</label>
      ${state.researchEnabled ? '<label><input type="radio" name="k" value="research"> 🔬 연구 디렉터 (자율)</label>' : ''}</div>
    <div id="nTerm">
      <label>작업 폴더<br><input id="nCwd" list="cwdl" style="width:100%" value="${esc(cwds[0] || '')}" placeholder="비우면 홈 폴더">
        <datalist id="cwdl">${cwds.map((c) => `<option value="${esc(c)}">`).join('')}</datalist></label>
      <label class="row"><input type="checkbox" id="nSkip" checked> --dangerously-skip-permissions (claude만)</label>
    </div>
    <div id="nRes" hidden>
      <label>프로젝트 이름<br><input id="rName" style="width:100%" placeholder="예: 조명 변화에 강한 DT 3DGS"></label>
      <label>연구 방향<br><textarea id="rDir" rows="7" style="width:100%" placeholder="예) 공장 디지털트윈에서 조명이 바뀌어도 3DGS 재구성이 흔들리지 않게 하고 싶다. 가진 것: CAD 모델, Replica 데이터, RTX 4090 1장. 원하는 기여: …  기간: 11월 중순 투고"></textarea></label>
      <label>목표 학회·저널 (선택)<br><input id="rVenue" style="width:100%" placeholder="비우면 디렉터가 조사해 정합니다 — 예: CVPR 2027"></label>
      <label>어디까지 진행할까요?<br><select id="rGoal" style="width:100%">${Object.entries(GOAL_KO).map(([k, v]) => `<option value="${k}" ${k === 'P9_review' ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
      <div class="rban ok" style="margin:0"><b>중간에 묻지 않고 목표까지 알아서 진행합니다.</b> 환경 설치·데이터 받기·테스트도 스스로 합니다. 진행할 수 없는 문제가 생겼을 때만 멈추고 알려드립니다.</div>
    </div>
    <div class="row" style="justify-content:flex-end"><button id="nCancel">취소</button><button class="primary" id="nOk">열기</button></div></div>`;
  document.body.appendChild(d);
  const kindOf = () => $('input[name=k]:checked', d).value;
  d.querySelectorAll('input[name=k]').forEach((r) => (r.onchange = () => { $('#nTerm', d).hidden = kindOf() === 'research'; $('#nRes', d).hidden = kindOf() !== 'research'; }));
  $('#nCancel', d).onclick = () => d.remove();
  $('#nOk', d).onclick = async () => {
    const kind = kindOf();
    if (kind === 'research') {
      const body = { name: $('#rName', d).value.trim(), direction: $('#rDir', d).value.trim(), venue: $('#rVenue', d).value.trim(), goal: $('#rGoal', d).value };
      if (!body.name || !body.direction) return toast('프로젝트 이름과 연구 방향을 입력하세요');
      $('#nOk', d).disabled = true;
      const r = await api('/api/research/new', { method: 'POST', body });
      if (r.error) { $('#nOk', d).disabled = false; return toast(r.error, 6000); }
      d.remove();
      await Promise.all([refreshOverview(), refreshResearch()]);
      return select({ kind: 'research', id: r.slug });
    }
    const t = await api('/api/term/new', { method: 'POST', body: { kind, cwd: $('#nCwd', d).value, skipPermissions: $('#nSkip', d).checked } });
    d.remove();
    await refreshOverview();
    select({ kind: 'term', id: t.id });
  };
};

// ---------- mobile drawer + "open on phone" ----------
$('#btnMenu').onclick = () => document.body.classList.toggle('drawer');
$('#backdrop').onclick = () => document.body.classList.remove('drawer');
$('#btnHome2').onclick = () => select({ kind: 'home' });
// language: English / 한국어 (saved on the server; it restarts itself, terminals stay open)
$('#btnLang').onclick = async () => {
  const next = (window.__ACH_LANG || (await api('/api/lang').catch(() => ({}))).lang) === 'en' ? 'ko' : 'en';
  if (!confirm(next === 'en' ? 'Switch to English? The hub restarts (terminals stay open).' : '한국어로 바꿀까요? 허브가 다시 시작됩니다 (터미널은 그대로).')) return;
  await api('/api/lang', { method: 'POST', body: { lang: next } }).catch(() => {});
  toast(next === 'en' ? 'Restarting in English…' : '한국어로 다시 시작하는 중…', 8000);
  setTimeout(() => location.reload(), 4000);
};
$('#btnPhone').onclick = async () => {
  const d = document.createElement('div');
  d.className = 'dlg';
  d.innerHTML = '<div class="box"><h3>다른 기기에서 열기 (휴대폰 · 다른 PC)</h3><div id="phoneBody">확인 중…</div><div class="row" style="justify-content:flex-end"><button id="pClose">닫기</button></div></div>';
  document.body.appendChild(d);
  $('#pClose', d).onclick = () => d.remove();
  d.onclick = (e) => { if (e.target === d) d.remove(); };
  const r = await api('/api/remote').catch((e) => ({ error: e.message }));
  const body = $('#phoneBody', d);
  if (r.qr) {
    body.innerHTML = `<div class="qr">${r.qr}</div>
      <p>휴대폰에서도 Tailscale에 <b>같은 계정</b>으로 로그인한 뒤 QR을 찍으세요. 첫 접속 후에는 토큰 없이 주소만 열어도 됩니다.</p>
      <p><b>다른 PC·노트북</b>: 그 PC에도 Tailscale을 같은 계정으로 켠 뒤, 아래 링크를 복사해 브라우저에서 여세요 (한 번 열면 그 브라우저는 토큰을 기억합니다).</p>
      ${r.urls.map((u) => `<div class="row" style="gap:6px"><span class="mono" style="flex:1;word-break:break-all">${esc(u)}</span><button data-copyurl="${esc(u + '?t=' + TOKEN)}">토큰 포함 링크 복사</button></div>`).join('')}
      <p class="empty">QR과 복사한 링크에는 접속 토큰이 들어 있습니다. 다른 사람에게 보내지 마세요.</p>`;
    body.querySelectorAll('[data-copyurl]').forEach((b) => { b.onclick = () => { copyText(b.dataset.copyurl); toast('링크를 복사했습니다'); }; });
  } else {
    body.innerHTML = `<p>${r.tailscaleInstalled ? 'Tailscale은 설치됐지만 아직 연결되지 않았습니다. 트레이 아이콘에서 로그인/Connect 하세요.' : 'Tailscale이 아직 설치되지 않았습니다.'}</p>
      <ol><li>PC: <b>tailscale.com/download</b>에서 Windows용 설치 → 로그인</li>
      <li>휴대폰: 앱스토어에서 Tailscale 설치 → 같은 계정으로 로그인</li>
      <li>이 창을 다시 열면 QR이 나옵니다 (서버가 15초마다 Tailscale 주소를 자동 감지)</li></ol>`;
  }
};

// ---------- boot ----------
(async () => {
  await Promise.all([refreshOverview(), refreshRecent(), refreshUsage(), refreshResearch()]);
  setInterval(whenShown(refreshResearch), 10000);
  refreshGpu(); setInterval(whenShown(refreshGpu), 5000);
  setInterval(whenShown(refreshUsage), 120000);
  const open = qs.get('open') || '';
  if (/^t:\d+$/.test(open)) select({ kind: 'term', id: open.slice(2) }, qs.get('tab') || undefined);
  else if (/^c:\d+$/.test(open)) select({ kind: 'console', id: open.slice(2) }, qs.get('tab') || undefined);
  else if (open.startsWith('session:')) select({ kind: 'recent', id: open.slice(8) }, qs.get('tab') || undefined);
  else if (open === 'usage') select({ kind: 'usage' });
  else if (open === 'calendar') select({ kind: 'calendar' });
  else if (open.startsWith('switch:')) { const sid = open.slice(7); select({ kind: 'recent', id: sid }); setTimeout(() => openSwitch(sid), 900); } // from the phone alert
  else if (open === 'gpu') select({ kind: 'gpu' });
  else if (open.startsWith('research:')) { state.rtab = { [open.slice(9)]: qs.get('tab') || 'overview' }; select({ kind: 'research', id: open.slice(9) }); }
  else if (qs.get('q')) { qIn.value = state.filter = qs.get('q'); runSearch(qs.get('q')); }
  else select({ kind: 'home' });
  setInterval(whenShown(refreshOverview), 4000);
  setInterval(whenShown(refreshRecent), 30000);
})();
