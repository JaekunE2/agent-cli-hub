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

let booted = false;
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
  if (booted && (state.sel.kind === 'home' || state.sel.kind === 'terms') && homeKeyOf() !== homeKey) select({ kind: state.sel.kind });
  else refreshHomeWidgets();
}
async function refreshRecent(fresh = false) {
  try { state.recent = (await api(`/api/recent?n=100${fresh ? '&fresh=1' : ''}`)).sessions || []; } catch {}
  renderSide();
  refreshHomeWidgets();
}

const consoleOf = (pid) => state.consoles.find((c) => c.pids.includes(pid));
const sessionOfConsole = (c) => state.live.find((s) => c.pids.includes(s.pid));
// claude sets its terminal title to the session name ("✳ task"); strip the status glyph
const stripGlyph = (s) => String(s || '').replace(/^[^\p{L}\p{N}]+\s*/u, '');
function termLabel(t) {
  if (t.operator) return '관제 세션';
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

const ICO = {
  grid: '<span class="ico"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg></span>',
  terminal: '<span class="ico"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg></span>',
  calendar: '<span class="ico"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg></span>',
  chart: '<span class="ico"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M18 20V10M12 20V4M6 20v-6"/></svg></span>',
  gpu: '<span class="ico"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3"/></svg></span>',
  refresh: '<span class="ico"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.6-6.4L21 8"/><path d="M21 3v5h-5"/></svg></span>',
  star: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><polygon points="12 2 15.1 8.3 22 9.3 17 14.1 18.2 21 12 17.7 5.8 21 7 14.1 2 9.3 8.9 8.3 12 2"/></svg>',
  starFill: '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><polygon points="12 2 15.1 8.3 22 9.3 17 14.1 18.2 21 12 17.7 5.8 21 7 14.1 2 9.3 8.9 8.3 12 2"/></svg>',
  clip: '<span class="ico"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/></svg></span>',
  folder: '<span class="ico"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg></span>',
  split: '<span class="ico"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="12" y1="3" x2="12" y2="21"/></svg></span>',
  copy: '<span class="ico"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></span>',
  close: '<span class="ico"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></span>',
  clock: '<span class="ico"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg></span>',
  settings: '<span class="ico"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.26.6.77 1.02 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/></svg></span>',
};
window.ICO = ICO;

// ---------- sidebar ----------
function itemHTML({ key, dot, icon, title, sub, badge, agoText, depth = 0, fold = '' }) {
  const f = termsOf(state.filter);
  if (f.length && key !== 'home' && key !== 'search') {
    const hay = `${title} ${sub}`.toLowerCase();
    if (!f.every((t) => hay.includes(t))) return '';
  }
  const sel = key === selKey() ? ' sel' : '';
  const fk = favKeyOf(key), on = !!fk && (state.favs || new Set()).has(fk);
  const star = fk ? `<span class="fav${on ? ' on' : ''}" data-fav="${esc(fk)}" title="${on ? '즐겨찾기에서 빼기' : '즐겨찾기 (맨 위에 표시)'}">${on ? ICO.starFill : ICO.star}</span>` : '';
  const lead = icon || `<span class="dot ${dot || ''}"></span>`;
  const end = agoText ? `<span class="item-end"><span class="item-ago">${esc(agoText)}</span>${star}</span>` : star;
  return `<div class="item${sel}${depth ? ' sub' : ''}" data-key="${esc(key)}"${depth ? ` style="margin-left:${depth * 16}px"` : ''}>${fold}${lead}
    <div class="body"><div class="t">${hl(title, f)}</div><div class="s">${badge ? `${badge} ` : ''}${hl(sub || '', f)}</div></div>${end}</div>`;
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
  return ['home', 'terms', 'search', 'usage', 'gpu', 'calendar'].includes(s.kind) ? s.kind : `${s.kind}:${s.id}`;
}
// which agent CLI a session / terminal belongs to (Claude Code is the default and gets no badge in lists)
const AG_SVG = {
  claude: '<img src="/icon-claude.png" alt="Claude">',
  codex: '<img src="/icon-openai.png" alt="ChatGPT">',
  agy: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none"><defs><linearGradient id="agG" x1="2" y1="22" x2="22" y2="2" gradientUnits="userSpaceOnUse"><stop offset="0%" stop-color="#34A853"/><stop offset="35%" stop-color="#FBBC05"/><stop offset="68%" stop-color="#EA4335"/><stop offset="100%" stop-color="#4285F4"/></linearGradient></defs><path d="M4.2 19.5C6.8 11.8 9.2 4.5 12 4.5s5.2 7.3 7.8 15c.3.9-.6 1.6-1.4 1.1-2.5-1.6-4.4-2.4-6.4-2.4s-3.9.8-6.4 2.4c-.8.5-1.7-.2-1.4-1.1Z" fill="url(#agG)"/></svg>',
  bot: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="8" width="18" height="12" rx="3"/><path d="M12 3v5M9 3h6"/><circle cx="9" cy="14" r="1.2" fill="currentColor"/><circle cx="15" cy="14" r="1.2" fill="currentColor"/><path d="M9.5 17.5h5"/></svg>',
  cursor: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M5 3l14 9-6.5 1.5L9.5 20 5 3Z"/></svg>',
  operator: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M16.2 7.8a6 6 0 0 1 0 8.4M7.8 16.2a6 6 0 0 1 0-8.4M19.1 4.9a10 10 0 0 1 0 14.2M4.9 19.1a10 10 0 0 1 0-14.2"/></svg>',
  shell: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',
};
function agentIcon(agent, dot = '') {
  const wrap = (ico) => (dot ? `<span class="ag-wrap">${ico}<span class="dot ${dot}"></span></span>` : ico);
  if (agent === 'operator') return wrap(`<span class="ag-ico operator" title="관제 세션">${AG_SVG.operator}</span>`);
  if (agent === 'shell') return wrap(`<span class="ag-ico shell" title="터미널">${AG_SVG.shell}</span>`);
  if (agent === 'bot') return wrap(`<span class="ag-ico bot" title="AI 계정">${AG_SVG.bot}</span>`);
  if (agent === 'codex') return wrap(`<span class="ag-ico codex" title="ChatGPT / Codex">${AG_SVG.codex}</span>`);
  if (agent === 'cursor') return wrap(`<span class="ag-ico cursor" title="Cursor">${AG_SVG.cursor}</span>`);
  if (agent === 'agy') {
    const acc = state.agyQuota?.account;
    return wrap(`<span class="ag-ico agy" title="Antigravity${acc ? ` (${esc(acc)})` : ''}">${AG_SVG.agy}</span>`);
  }
  return wrap(`<span class="ag-ico claude" title="Claude">${AG_SVG.claude}</span>`);
}
function agentBadge(agent) {
  if (agent === 'codex') return '<span class="badge cx">Codex</span>';
  if (agent === 'cursor') return '<span class="badge">Cursor</span>';
  if (agent === 'agy') {
    const acc = state.agyQuota?.account;
    return `<span class="badge agy">antigravity${acc ? ` [${esc(acc)}]` : ''}</span>`;
  }
  return '';
}
function quickNavHTML(cons) {
  const cur = selKey();
  const calItems = ((typeof CAL !== 'undefined' && CAL?.data?.items) || []).filter((x) => !(x.kind === 'task' && x.done));
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const todayN = calItems.filter((x) => x.date === today).length;
  const u = state.usage;
  const okAccs = (u?.accounts || []).filter((a) => a.ok && a.meters?.length);
  const totalN = okAccs.length + (state.agyQuota?.groups?.length ? 1 : 0);
  const usageSub = !u ? '불러오는 중' : !u.available ? '4777 미연결' : `계정 ${totalN}개`;
  const g = state.gpu;
  const validGpus = (g?.gpus || []).filter((x) => x.index >= 0 && x.enabled !== false);
  const g0 = validGpus[0];
  const ramPct = g?.ram?.totalMB ? Math.round(((g.ram.totalMB - g.ram.freeMB) / g.ram.totalMB) * 100) : 0;
  const gpuSub = !g ? '확인 중' : g.error || !g0 ? 'GPU 없음' : `GPU ${g0.util || 0}% · CPU ${g.cpu?.util ?? 0}% · RAM ${ramPct}%`;
  const termSub = cons.length ? `터미널 ${state.terms.length} · 창 ${cons.length}` : `터미널 ${state.terms.length}개`;
  const tile = (key, title, sub, extra = '') => `<div class="qtile${cur === key ? ' sel' : ''}" data-key="${key}"><div class="qt"><span style="display:inline-flex;align-items:center;gap:5px">${title}</span>${extra}</div><div class="qs">${esc(sub)}</div></div>`;
  return `<div class="qnav">
    ${tile('terms', `${ICO.terminal} 터미널`, termSub)}
    ${tile('calendar', `${ICO.calendar} 캘린더`, `금일 ${todayN}건`)}
    ${tile('usage', `${ICO.chart} AI 사용량`, usageSub, `<button class="qact" data-agy-usage="1" title="Antigravity 한도 조회 (/usage)">AGY ${ICO.refresh}</button>`)}
    ${tile('gpu', `${ICO.gpu} GPU 대기열`, gpuSub)}
  </div>`;
}
const cleanSideTitle = (s) => {
  const t = String(s || '').replace(/<external_codex_apps_[^>]*>[\s\S]*?<\/external_codex_apps_[^>]*>/gi, '').replace(/^<[^>]+>/, '').trim();
  const lines = t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const l of lines) {
    if (/^#{1,3}\s*(Referenced ChatGPT|Files mentioned by the user|Context from|Active file|Open files)/i.test(l)) continue;
    if (/^<\/?[a-z_][\w-]*[^>]*>/i.test(l)) continue;
    return l;
  }
  return lines[0] || t;
};
function renderSide() {
  const liveIds = new Set(state.live.map((s) => s.sessionId));
  const cons = visibleConsoles();
  let h = quickNavHTML(cons);
  if (state.researchEnabled && state.research?.length) h += researchSideHTML();
  if (state.filter.trim()) h += `<div class="sec">${itemHTML({ key: 'search', title: `“${state.filter.trim()}” 대화 전체 검색`, sub: 'Enter · 모든 세션 기록 + 열린 창 화면' })}</div>`;
  if (state.disk) h = `<div class="err" style="font-weight:600">⚠ ${esc(state.disk.drive)} 남은 공간 ${state.disk.freeGB} GB — 0이 되면 세션이 멈춥니다. 정리가 필요합니다.</div>` + h;
  if (state.err) h += `<div class="err">${esc(state.err)}</div>`;

  const liveItem = (s) => itemHTML({
    key: `session:${s.sessionId}`, dot: s.status === 'busy' ? 'busy' : 'idle',
    title: (isDesktopSession(s) ? s.name : consoleOf(s.pid) && consoleLabel(consoleOf(s.pid))) || s.name || s.sessionId.slice(0, 8),
    sub: `${s.status === 'busy' ? '작업 중' : '대기'} · ${base(s.cwd)} · ${ago(s.updatedAt)}`,
    badge: (s.limit ? '<span class="badge lim">한도</span>' : '') + (isDesktopSession(s) ? '<span class="badge">데스크톱 앱</span>' : consoleOf(s.pid) || state.consolesOff ? '' : '<span class="badge">창 없음</span>'),
  });
  const termItem = (t) => {
    const dot = t.exited !== null ? 'dead' : t.status === 'busy' ? 'busy' : 'idle';
    const kind = t.operator ? 'operator' : t.agent || 'shell';
    return itemHTML({
      key: `term:${t.id}`, icon: agentIcon(kind, dot), title: termLabel(t),
      sub: `${t.exited !== null ? '종료됨 (' + t.exited + ')' : t.status === 'busy' ? '작업 중' : t.status === 'idle' ? '대기' : '실행 중'} · ${base(t.cwd)}`,
    });
  };
  const recentItem = (r) => {
    const ag = r.agent || 'claude';
    const dir = base(r.cwd);
    const acc = ag === 'agy' && state.agyQuota?.account ? state.agyQuota.account.replace(/@.*/, '') : '';
    const sub = [dir, acc].filter(Boolean).join(' · ') || (ag === 'agy' ? 'Antigravity' : ag === 'codex' ? 'Codex' : 'Claude');
    return itemHTML({
      key: `recent:${r.sessionId}`, icon: agentIcon(ag),
      title: cleanSideTitle(r.title || r.firstPrompt) || r.sessionId.slice(0, 8),
      sub, agoText: ago(r.mtime),
    });
  };

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
  if (favItems.length) h += `<div class="sec"><h2><span class="ico" style="color:var(--star)">${ICO.starFill}</span> 즐겨찾기</h2>${favItems.join('')}</div>`;

  // Claude desktop-app chats and external consoles are hidden when empty so the sidebar stays compact
  const deskN = state.live.filter(isDesktopSession).length;
  const liveShown = state.live.filter((s) => (state.showDesktop || !isDesktopSession(s)) && !isFav(`session:${s.sessionId}`));
  if (liveShown.length || deskN) {
    h += `<div class="sec"><h2>실행 중 Claude 세션<span class="sp"></span>
      ${deskN ? `<label title="Claude 데스크톱 앱이 띄운 대화"><input type="checkbox" id="chkDesktop" ${state.showDesktop ? 'checked' : ''}> 데스크톱 앱 ${deskN}</label>` : ''}</h2>`;
    h += liveShown.length ? liveShown.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).map(liveItem).join('') : '<div class="empty">없음</div>';
    h += '</div>';
  }

  if (!state.consolesOff && (cons.length || state.showHidden)) {
    h += `<div class="sec"><h2>열린 콘솔 창<span class="sp"></span>
      <label><input type="checkbox" id="chkHidden" ${state.showHidden ? 'checked' : ''}> 숨은 창</label></h2>`;
    h += cons.length ? cons.map((c) => {
      const s = sessionOfConsole(c);
      return itemHTML({
        key: `console:${c.id}`, dot: s ? (s.status === 'busy' ? 'busy' : 'idle') : '',
        title: consoleLabel(c), sub: c.procs.map((p) => p.name.replace(/\.exe$/, '')).join(' › '),
        badge: s ? '<span class="badge c">claude</span>' : (c.visible ? '' : '<span class="badge">숨김</span>'),
      });
    }).join('') : '<div class="empty">없음</div>';
    h += '</div>';
  }

  h += `<div class="sec"><h2>대시보드 터미널<span class="sp"></span><button class="qact" data-hopen-new="1" title="새 터미널 열기" style="text-transform:none;letter-spacing:0;font-weight:600">＋ 새로 열기</button></h2>`;
  const termsShown = state.terms.filter((t) => !isFav(`term:${t.id}`));
  h += termsShown.length ? termsShown.map(termItem).join('') : state.terms.length ? '<div class="empty">모두 즐겨찾기에 있음</div>' : '<div class="empty">＋ 새로 열기로 터미널 실행</div>';
  h += '</div>';

  const rf = state.recentFilter || '';
  const fbtn = (val, label) => `<button data-rfilt="${val}" class="${rf === val ? 'on' : ''}">${label}</button>`;
  h += `<div class="sec"><h2>최근 세션 기록<span class="sp"></span><button class="qact" data-rrefresh="1" title="세션 기록 즉시 새로고침">${ICO.refresh}</button></h2>
    <div class="rfilt">${fbtn('', '전체')}${fbtn('claude', 'Claude')}${fbtn('codex', 'Codex')}${fbtn('agy', 'AGY')}</div>`;
  const recentList = state.recent
    .filter((r) => !liveIds.has(r.sessionId) && !isFav(`recent:${r.sessionId}`) && (!rf || (r.agent || 'claude') === rf))
    .slice(0, 25);
  const bucketOf = (ms) => {
    if (!ms) return '이전';
    const d = new Date(ms), now = new Date();
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (d.getTime() >= startToday) return '오늘';
    if (d.getTime() >= startToday - 864e5) return '어제';
    if (d.getTime() >= startToday - 6 * 864e5) return '이번 주';
    return '이전';
  };
  let lastBucket = '';
  h += recentList.map((r) => {
    const b = bucketOf(r.mtime);
    const hdr = b !== lastBucket ? `<div class="dayhdr">${b}</div>` : '';
    lastBucket = b;
    return hdr + recentItem(r);
  }).join('') || '<div class="empty">없음</div>';
  h += '</div>';

  const side = $('#side'), top = side.scrollTop;
  side.innerHTML = h;
  side.scrollTop = top;
}
$('#side').addEventListener('change', (e) => {
  if (e.target.id === 'selRecentAgent') { state.recentFilter = e.target.value; renderSide(); }
});
$('#side').addEventListener('click', (e) => {
  if (e.target.closest('[data-hopen-new]')) { e.stopPropagation(); openNewTermDrawer(); return; }
  const rrBtn = e.target.closest('[data-rrefresh]');
  if (rrBtn) { e.stopPropagation(); rrBtn.disabled = true; refreshRecent(true).finally(() => { rrBtn.disabled = false; }); return; }
  const rfBtn = e.target.closest('[data-rfilt]');
  if (rfBtn) { e.stopPropagation(); state.recentFilter = rfBtn.dataset.rfilt; renderSide(); return; }
  const agyBtn = e.target.closest('[data-agy-usage]');
  if (agyBtn) { e.stopPropagation(); return openAgyUsage(agyBtn); }
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
  const it = e.target.closest('.item, .qtile');
  if (!it) return;
  const k = it.dataset.key;
  if (k === 'home') return select({ kind: 'home' });
  if (k === 'terms') return select({ kind: 'terms' });
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
  if (booted && sel.kind !== 'search') {
    const payload = { sel, tab: state.tab };
    try { localStorage.setItem('ach-last-sel', JSON.stringify(payload)); } catch {}
    try {
      const h = sel.id ? `#${sel.kind}:${sel.id}:${state.tab}` : `#${sel.kind}`;
      if (location.hash !== h) history.replaceState(null, '', h);
    } catch {}
  }
  renderSide();
  ({ home: viewHome, terms: viewTerms, console: viewConsole, recent: viewTranscript, term: viewTerm, search: viewSearch, usage: viewUsage, research: viewResearch, gpu: viewGpu, calendar: viewCalendar })[sel.kind]?.();
}

function setBar(html) {
  $('#bar').innerHTML = `<button id="btnSideToggle" class="side-toggle" title="사이드바 접기/펼치기" aria-label="사이드바 접기/펼치기"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="2.5" width="13" height="11" rx="2"/><line x1="5.5" y1="2.5" x2="5.5" y2="13.5"/></svg></button>${html}`;
}

// Home: Astryx 3-Band Dashboard Template
// Band 1: 4-Column MetricCards (Active Terminals & Quick Launch, AI Usage Quota, Today Schedule, GPU/System)
// Band 2: Live Terminal & Console Mirrors Grid
// Band 3: 2-Column Split Rail (Recent Sessions with 1-Click Resume + Upcoming Calendar Items)
const homeKeyOf = () => visibleConsoles().map((c) => c.id).join(',') + '|' + state.terms.map((t) => t.id + (t.exited === null ? '' : 'x')).join(',');
function homeKpisHTML() {
  const cons = visibleConsoles();
  const terms = state.terms;
  const runTerms = terms.filter((t) => t.exited === null);
  const busyN = runTerms.filter((t) => t.status === 'busy').length + cons.filter((c) => sessionOfConsole(c)?.status === 'busy').length;
  const termRows = runTerms.slice(0, 2).map((t) => `<div class="urow"><span class="ul">${esc(termLabel(t))}</span><span class="badge">${t.status === 'busy' ? '작업 중' : '대기'}</span></div>`).join('')
    || (cons.length ? cons.slice(0, 2).map((c) => `<div class="urow"><span class="ul">${esc(consoleLabel(c))}</span><span class="badge">콘솔</span></div>`).join('') : '<div>실행 중인 터미널이 없습니다</div>');

  // KPI 2: AI Usage
  const u = state.usage;
  const okAccs = (u?.accounts || []).filter((a) => a.ok && a.meters?.length);
  const agyGroups = state.agyQuota?.groups || [];
  const totalAccN = okAccs.length + (agyGroups.length ? 1 : 0);
  const anySoon = okAccs.some((a) => (a.meters || []).some((m) => /주간|weekly/i.test(m.name || '') && (isResetTodayIso(m.resetsAt) || isResetTodayText(m.detail))))
    || agyGroups.some((g) => isResetTodayText(g.weeklyReset));
  const uRows = [];
  for (const a of okAccs.slice(0, 3)) {
    const ms = keyMeters(a);
    const worst = ms.length ? Math.max(...ms.map((m) => m.usedPercent || 0)) : 0;
    const rem = Math.max(0, Math.round(100 - worst));
    uRows.push(`<div class="urow"><span class="ul">${esc(shortLabel(a))}</span>${bar(worst, true)}<span class="up ${level(worst)}" style="width:36px">${rem}%</span></div>`);
  }
  if (agyGroups.length && uRows.length < 4) {
    const g0 = agyGroups[0];
    const pcts = [g0.fiveH, g0.weekly].filter((v) => v != null);
    if (pcts.length) {
      const worst = Math.max(...pcts);
      const rem = Math.max(0, Math.round(100 - worst));
      uRows.push(`<div class="urow"><span class="ul">Antigravity</span>${bar(worst, true)}<span class="up ${level(worst)}" style="width:36px">${rem}%</span></div>`);
    }
  }

  // KPI 3: Calendar
  const calItems = ((typeof CAL !== 'undefined' && CAL?.data?.items) || []).filter((x) => !(x.kind === 'task' && x.done));
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const todayList = calItems.filter((x) => x.date === today).sort((a, b) => String(a.time || '99:99').localeCompare(String(b.time || '99:99')));
  const nextUp = calItems.filter((x) => x.date > today).sort((a, b) => a.date.localeCompare(b.date) || String(a.time || '').localeCompare(String(b.time || '')))[0];
  const overN = calItems.filter((x) => x.kind === 'task' && !x.done && x.date < today).length;
  const calSub = todayList.length
    ? todayList.slice(0, 2).map((it) => `<div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text)">${it.time ? `<b>${esc(it.time)}</b> ` : ''}${esc(it.title)}</div>`).join('')
    : nextUp
      ? `<div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">다음: <b style="color:var(--text)">${esc(nextUp.title)}</b> (${esc(nextUp.date.slice(5))})</div>`
      : '<div>오늘 예정된 일정이 없습니다</div>';

  // KPI 4: GPU & System
  const g = state.gpu;
  const validGpus = (g?.gpus || []).filter((x) => x.index >= 0 && x.enabled !== false);
  const g0 = validGpus[0];
  const g0Mem = g0 && g0.totalMB ? Math.round((g0.usedMB / g0.totalMB) * 100) : 0;
  const g0Util = g0 ? (g0.util || 0) : 0;
  const cpuUtil = g?.cpu?.util ?? 0;
  const ramUsed = g?.ram?.totalMB ? Math.max(0, g.ram.totalMB - g.ram.freeMB) : 0;
  const ramPct = g?.ram?.totalMB ? Math.round((ramUsed / g.ram.totalMB) * 100) : 0;
  const gpuBadge = g0 ? `${esc(g0.name.replace(/NVIDIA |GeForce /gi, ''))}${Number.isFinite(g0.tempC) ? ` · ${g0.tempC}°C` : ''}${g0.powerW != null ? ` · ${g0.powerW}W` : ''}` : '시스템';
  const gpuRows = g0
    ? `<div class="urow"><span class="ul">GPU 코어 · VRAM (${fmtMB(g0.usedMB)}/${fmtMB(g0.totalMB)})</span>${bar(g0Util, true)}<span class="up ${level(g0Util)}" style="width:28px">${g0Util}%</span>${bar(g0Mem, true)}<span class="up ${level(g0Mem)}" style="width:30px">${g0Mem}%</span></div>
       <div class="urow"><span class="ul">CPU · RAM (${fmtMB(ramUsed)}/${fmtMB(g?.ram?.totalMB || 0)})</span>${bar(cpuUtil, true)}<span class="up ${level(cpuUtil)}" style="width:28px">${cpuUtil}%</span>${bar(ramPct, true)}<span class="up ${level(ramPct)}" style="width:30px">${ramPct}%</span></div>`
    : `<div>${!g ? 'GPU 상태 확인 중…' : '활성 GPU 없음'}</div>`;

  return `
    <div class="h-kpi click" data-hnav="terms">
      <div class="h-kpi-top"><span>${ICO.terminal} 터미널 · 세션 현황</span><span class="badge">${busyN ? `작업 중 ${busyN}` : `전체 ${terms.length + cons.length}개`}</span></div>
      <div class="h-kpi-val">터미널 ${runTerms.length}개${cons.length ? `<span style="font-size:13px;font-weight:500;color:var(--muted)">· 콘솔 ${cons.length}</span>` : ''}</div>
      <div class="h-kpi-sub">${termRows}</div>
    </div>
    <div class="h-kpi click" data-hnav="usage">
      <div class="h-kpi-top"><span>${ICO.chart} AI 한도 브리핑 (남은 %)</span>${anySoon ? `<span class="badge soon">${ICO.clock} 금일 리셋</span>` : `<span class="badge">계정 ${totalAccN}개</span>`}</div>
      <div class="h-kpi-sub">${uRows.join('') || '<div>한도 정보 불러오는 중…</div>'}</div>
    </div>
    <div class="h-kpi click" data-hnav="calendar">
      <div class="h-kpi-top"><span>${ICO.calendar} 오늘의 일정</span>${overN ? `<span class="badge lim">지난 마감 ${overN}</span>` : `<span class="badge">${esc(today.slice(5))}</span>`}</div>
      <div class="h-kpi-val">금일 ${todayList.length}건</div>
      <div class="h-kpi-sub">${calSub}</div>
    </div>
    <div class="h-kpi click" data-hnav="gpu">
      <div class="h-kpi-top"><span>${ICO.gpu} GPU · CPU · 메모리</span><span class="badge">${gpuBadge}</span></div>
      <div class="h-kpi-val">${g0 ? `GPU ${g0Util}% <span style="font-size:13px;font-weight:500;color:var(--muted)">· CPU ${cpuUtil}% · RAM ${ramPct}%</span>` : '리소스 확인 중'}</div>
      <div class="h-kpi-sub">${gpuRows}</div>
    </div>`;
}
function homeRailHTML() {
  const liveIds = new Set(state.live.map((s) => s.sessionId));
  const recents = state.recent.filter((r) => !liveIds.has(r.sessionId)).slice(0, 6);
  const recentRows = recents.map((r) => {
    const ag = r.agent || 'claude';
    const title = cleanSideTitle(r.title || r.firstPrompt) || r.sessionId.slice(0, 8);
    const sub = [base(r.cwd), ago(r.mtime)].filter(Boolean).join(' · ');
    return `<div class="h-row" data-hrecent="${esc(r.sessionId)}">
      ${agentIcon(ag)}
      <div class="h-row-main"><div class="h-row-t">${esc(title)}</div><div class="h-row-s">${esc(sub)}</div></div>
      <button class="h-row-act" data-hresume="${esc(r.sessionId)}" title="대시보드 터미널에서 바로 이어하기">이어하기</button>
    </div>`;
  }).join('') || '<div class="empty" style="padding:16px">최근 대화 기록이 없습니다</div>';

  // Embedded actual month calendar grid
  const calItems = (typeof CAL !== 'undefined' && CAL?.data?.items) || [];
  window.__calItems = calItems;
  const now = new Date();
  const y = now.getFullYear(), mo = now.getMonth();
  const today = `${y}-${String(mo + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const byDate = new Map();
  for (const it of calItems) { if (!byDate.has(it.date)) byDate.set(it.date, []); byDate.get(it.date).push(it); }
  const kindCls = { task: 'ck-task', milestone: 'ck-ms', event: 'ck-ev', gcal: 'ck-g', mscal: 'ck-ms365' };
  const first = new Date(y, mo, 1), start = new Date(first); start.setDate(1 - ((first.getDay() + 6) % 7));
  const head = ['월', '화', '수', '목', '금', '토', '일'].map((x) => `<div class="chead">${x}</div>`).join('');
  let cells = '';
  for (let i = 0; i < 42; i++) {
    const day = new Date(start); day.setDate(start.getDate() + i);
    const ds = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
    const list = byDate.get(ds) || [];
    const chips = list.slice(0, 2).map((it) => `<div class="cchip ${kindCls[it.kind] || 'ck-ev'}${it.kind === 'task' && it.done ? ' done' : ''}" data-hcal="${esc(it.id)}" title="${esc(it.title)}">${it.time ? `<b>${esc(it.time)}</b> ` : ''}${esc(it.title)}</div>`).join('');
    const more = list.length > 2 ? `<div class="cmore" data-hcday="${ds}">+${list.length - 2}개</div>` : '';
    cells += `<div class="cday${day.getMonth() !== mo ? ' out' : ''}${ds === today ? ' today' : ''}${[0, 6].includes(day.getDay()) ? ' wk' : ''}" data-hcday="${ds}"><div class="cnum">${day.getDate()}</div>${chips}${more}</div>`;
  }

  return `
    <div class="h-panel">
      <div class="h-panel-hd"><h4>최근 작업 세션 바로 이어하기</h4><button class="h-row-act" data-hnav="search">전체 검색</button></div>
      <div class="h-rows">${recentRows}</div>
    </div>
    <div class="h-panel">
      <div class="h-panel-hd"><h4>${ICO.calendar} ${y}년 ${mo + 1}월 캘린더</h4><button class="h-row-act" data-hnav="calendar">캘린더 크게 보기</button></div>
      <div class="h-calgrid">${head}${cells}</div>
    </div>`;
}
function refreshHomeWidgets() {
  if (state.sel.kind !== 'home') return;
  const k = $('#homeKpis'); if (k) k.innerHTML = homeKpisHTML();
  const r = $('#homeRail'); if (r) r.innerHTML = homeRailHTML();
}
function termCardHTML(t) {
  const s = t.pid && state.live.find((x) => consoleOf(x.pid)?.pids.includes(t.pid));
  const dot = t.exited !== null ? 'dead' : s ? (s.status === 'busy' ? 'busy' : 'idle') : t.status === 'busy' ? 'busy' : 'idle';
  const kind = t.operator ? 'operator' : t.agent || 'shell';
  return `<div class="card" data-term="${t.id}"><div class="hd">${agentIcon(kind, dot)}
    <span class="t">${esc(termLabel(t))} · ${esc(base(t.cwd))}</span>
    ${t.exited !== null ? '<span class="badge">종료됨</span>' : ''}</div>
    <div class="mini" id="mini-${t.id}"><div class="mini-in"></div></div></div>`;
}
function conCardHTML(c) {
  const s = sessionOfConsole(c);
  return `<div class="card" data-id="${c.id}"><div class="hd"><span class="dot ${s ? (s.status === 'busy' ? 'busy' : 'idle') : ''}"></span>
    <span class="t">${esc(consoleLabel(c))}</span>${s?.limit ? '<span class="badge lim">한도 도달</span>' : ''}${s ? '<span class="badge c">claude</span>' : ''}<span class="badge">${c.id}</span></div>
    <pre class="screen" id="scr-${c.id}">불러오는 중…</pre></div>`;
}
function bindMiniTerminals(gen, terms, cons) {
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
function viewHome() {
  const gen = viewGen;
  const cons = visibleConsoles();
  const terms = state.terms;
  const totalN = terms.length + cons.length;
  const previewTerms = terms.slice(0, 2);
  const previewCons = cons.slice(0, Math.max(0, 2 - previewTerms.length));
  homeKey = homeKeyOf();
  setBar(`<h2>메인 대시보드</h2>`);
  const termCards = previewTerms.map(termCardHTML).join('');
  const conCards = previewCons.map(conCardHTML).join('');
  $('#view').innerHTML = `<div class="home-wrap">
    <div class="h-kpis" id="homeKpis">${homeKpisHTML()}</div>
    <hr class="h-divider">
    <div class="h-rail" id="homeRail">${homeRailHTML()}</div>
    <hr class="h-divider">
    <div class="h-sec">
      <div class="h-sec-hd">
        <h3>실행 중인 터미널 · 콘솔 <span class="badge">${totalN > 2 ? `2 / ${totalN}` : totalN}</span></h3>
        <div class="row" style="gap:6px">
          <button data-hnav="terms">전체 보기 (${totalN}개) →</button>
          <button data-hopen-new="1" class="primary">＋ 새로 열기</button>
        </div>
      </div>
      ${previewTerms.length || previewCons.length ? `<div class="grid" style="padding:0">${termCards}${conCards}</div>`
        : `<div class="h-empty-card"><b>현재 열려 있는 콘솔이나 터미널이 없습니다</b><div class="empty">우측 상단 ＋ 새로 열기로 Claude · Codex · Antigravity 세션을 시작하세요.</div></div>`}
    </div>
  </div>`;
  $('#view').onclick = async (e) => {
    if (e.target.closest('[data-hopen-new]')) return openNewTermDrawer();
    const resBtn = e.target.closest('[data-hresume]');
    if (resBtn) {
      e.stopPropagation();
      const sid = resBtn.dataset.hresume;
      const r = state.recent.find((x) => x.sessionId === sid);
      const body = r?.agent === 'codex'
        ? { kind: 'codex', resume: sid, cwd: r.cwd }
        : r?.agent === 'agy'
          ? { kind: 'agy', resume: sid, cwd: r.cwd }
          : { kind: 'claude', resume: sid, cwd: r?.cwd, skipPermissions: true };
      resBtn.disabled = true;
      const t = await api('/api/term/new', { method: 'POST', body }).catch((er) => ({ error: er.message }));
      resBtn.disabled = false;
      if (t.error) return toast(t.error, 6000);
      await refreshOverview();
      return select({ kind: 'term', id: t.id });
    }
    const hrec = e.target.closest('[data-hrecent]');
    if (hrec) return select({ kind: 'recent', id: hrec.dataset.hrecent }, 'chat');
    const hcal = e.target.closest('[data-hcal]');
    if (hcal) {
      e.stopPropagation();
      const it = ((typeof CAL !== 'undefined' && CAL?.data?.items) || []).find((x) => x.id === hcal.dataset.hcal);
      if (it && typeof calDetail === 'function') return calDetail(it);
      return select({ kind: 'calendar' });
    }
    const hcday = e.target.closest('[data-hcday]');
    if (hcday) {
      const ds = hcday.dataset.hcday;
      const hasItems = ((typeof CAL !== 'undefined' && CAL?.data?.items) || []).some((x) => x.date === ds);
      if (hasItems && typeof calDayList === 'function') return calDayList(ds);
      if (typeof calEventDialog === 'function') return calEventDialog({ date: ds });
      return select({ kind: 'calendar' });
    }
    const nav = e.target.closest('[data-hnav]');
    if (nav) {
      const target = nav.dataset.hnav;
      if (target === 'search') { $('#q')?.focus(); return; }
      return select({ kind: target });
    }
    const card = e.target.closest('.card');
    if (!card) return;
    if (card.dataset.term) select({ kind: 'term', id: card.dataset.term });
    else select({ kind: 'console', id: card.dataset.id });
  };
  bindMiniTerminals(gen, previewTerms, previewCons);
}
function viewTerms() {
  const gen = viewGen;
  const cons = visibleConsoles();
  const terms = state.terms;
  homeKey = homeKeyOf();
  setBar(`<h2>터미널 (${terms.length + cons.length})</h2><button data-hopen-new="1" class="primary">＋ 새로 열기</button>`);
  const termCards = terms.map(termCardHTML).join('');
  const conCards = cons.map(conCardHTML).join('');
  $('#view').innerHTML = cons.length || terms.length
    ? `<div class="grid">${termCards}${conCards}</div>`
    : `<div style="padding:20px"><div class="h-empty-card"><b>표시할 터미널이나 콘솔 창이 없습니다</b><div class="empty">우측 상단 ＋ 새로 열기 버튼으로 Claude · Codex · Antigravity 세션을 시작하세요.</div></div></div>`;
  $('#bar').onclick = (e) => { if (e.target.closest('[data-hopen-new]')) openNewTermDrawer(); };
  $('#view').onclick = (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    if (card.dataset.term) select({ kind: 'term', id: card.dataset.term });
    else select({ kind: 'console', id: card.dataset.id });
  };
  bindMiniTerminals(gen, terms, cons);
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
  if (document.hidden || (state.sel.kind !== 'home' && state.sel.kind !== 'terms') || !miniObserver) return;
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
    ${sid ? `<button data-tab="split" class="${state.tab === 'split' ? 'on' : ''}">${ICO.split} 화면 + 대화</button><button data-tab="chat" class="${state.tab === 'chat' ? 'on' : ''}">대화 기록</button><button data-tab="files" class="${state.tab === 'files' ? 'on' : ''}">산출물</button>` : ''}</div>
    <button id="btnFocus" class="desk" title="실제 창을 앞으로 가져오기 (conhost 창만)">창 앞으로</button>${sid ? switchBtnHTML(sid) : ''}`);
  $('#bar').onclick = (e) => {
    const b = e.target.closest('[data-tab]');
    if (b) select(state.sel, b.dataset.tab);
    if (e.target.id === 'btnFocus') api('/api/console/focus', { method: 'POST', body: { pid: Number(state.sel.id) } });
  };
  if (state.tab === 'chat' && sid) return renderChat(sid, gen);
  if (state.tab === 'files' && sid) return renderArtifacts(sid, gen);

  const isSplit = state.tab === 'split' && sid;
  const screenHTML = `<div class="full">
    <pre class="screen" id="scr">불러오는 중…</pre>
    <div class="term-dock">
      <div class="tdock-bar">
        <div class="tdock-tools">
          <label class="filebtn" title="PC 파일·스크린샷 첨부 → 경로 입력">${ICO.clip}<span>파일 첨부</span><input type="file" class="fpick" multiple hidden></label>
          <button data-copy="1" title="선택한 부분(없으면 화면 전체) 복사">${ICO.copy}<span>화면 복사</span></button>
        </div>
        <div class="tdock-keys">
          <span class="tdock-klbl">TUI 제어</span>
          <button data-key="esc" title="Esc">Esc</button><button data-key="up" title="위로">↑</button><button data-key="down" title="아래로">↓</button>
          <button data-key="tab" title="Tab">Tab</button><button data-key="ctrl+c" title="Ctrl+C">^C</button><button data-key="enter" title="Enter">⏎</button>
        </div>
      </div>
      <div class="tdock-comp">
        <textarea id="inp" rows="1" placeholder="보낼 내용 입력 (Enter 전송 · Shift+Enter 줄바꿈 · 빈 칸에서 ↑↓/Esc는 창으로 전달)"></textarea>
        <button class="primary" id="btnSend">보내기 ⏎</button>
      </div>
    </div>
  </div>`;
  if (isSplit) {
    $('#view').innerHTML = `<div class="term-split"><div class="tsplit-left">${screenHTML}</div>
      <div class="tsplit-right"><div class="tsplit-hd"><span>실시간 대화 기록</span><button class="h-row-act" id="btnSplitFullChat">전체 보기 →</button></div><div class="tsplit-body" id="splitChatHost"></div></div></div>`;
    $('#btnSplitFullChat').onclick = () => select(state.sel, 'chat');
    renderChat(sid, gen, -1, [], $('#splitChatHost'));
  } else {
    $('#view').innerHTML = screenHTML;
  }
  const inp = $('#inp');
  const fitInp = () => { inp.style.height = 'auto'; inp.style.height = Math.min(140, Math.max(36, inp.scrollHeight)) + 'px'; };
  inp.addEventListener('input', fitInp);
  const sendKey = async (k) => {
    await api('/api/console/send', { method: 'POST', body: { pid: Number(state.sel.id), keys: [k] } });
    setTimeout(tick, 150);
  };
  const sendText = async () => {
    const text = inp.value;
    inp.value = ''; fitInp();
    const r = await api('/api/console/send', { method: 'POST', body: text ? { pid: Number(state.sel.id), text, submit: true } : { pid: Number(state.sel.id), keys: ['enter'] } });
    if (!r.ok) alertBar(r.error);
    setTimeout(tick, 150);
  };
  inp.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendText(); return; }
    if (e.key === 'Escape') { e.preventDefault(); sendKey('esc'); return; }
    if (!inp.value && (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Tab')) {
      e.preventDefault();
      sendKey(e.key === 'ArrowUp' ? 'up' : e.key === 'ArrowDown' ? 'down' : 'tab');
    }
  };
  $('#btnSend').onclick = sendText;
  $('#view .full').onclick = async (e) => {
    if (e.target.closest('[data-copy]')) { const scr = $('#scr'); return copyText(selectionIn(scr) || scr.textContent); }
    const k = e.target.closest('[data-key]')?.dataset.key;
    if (k) sendKey(k);
  };
  const tick = async () => {
    const r = await api(`/api/console/read?pid=${state.sel.id}`).catch((e) => ({ error: e.message }));
    if (gen !== viewGen) return;
    paintScreen($('#scr'), r);
    clearTimeout(viewTimer);
    viewTimer = setTimeout(tick, 1000);
  };
  tick();
  const addPath = (txt) => { inp.value += (inp.value && !inp.value.endsWith(' ') ? ' ' : '') + txt; fitInp(); inp.focus(); };
  attachFileInput($('#view .full'), addPath, s?.cwd);
  bindFilePick($('#view .full'), addPath, s?.cwd);
  inp.focus();
}
function alertBar(msg) {
  const n = document.createElement('span');
  n.className = 'badge'; n.style.color = 'var(--danger)'; n.textContent = msg;
  $('#bar').appendChild(n); setTimeout(() => n.remove(), 5000);
}

function viewTranscript() {
  const gen = viewGen;
  const sid = state.sel.id;
  const r = state.recent.find((x) => x.sessionId === sid);
  const live = state.live.find((x) => x.sessionId === sid);
  const hasCwd = !!(r?.cwd || live?.cwd);
  setBar(`<h2>${esc(r?.title || r?.firstPrompt || live?.name || sid)}</h2>
    <span class="badge mono">${esc(sid.slice(0, 8))}</span>${agentBadge(r?.agent)}
    <div class="tabs"><button data-tab="chat" class="${state.tab !== 'files' ? 'on' : ''}">대화 기록</button><button data-tab="files" class="${state.tab === 'files' ? 'on' : ''}">산출물</button></div>
    ${!live ? '<button class="primary" id="btnResume">대시보드에서 이어하기</button>' : isDesktopSession(live) ? '<button class="primary" id="btnResume" data-fork="1" title="데스크톱 앱 대화를 여기까지 복제한 새 세션으로 이어갑니다 (원래 대화는 데스크톱 앱에 그대로)">대시보드에서 이어하기 (복제)</button>' : ''}
    <button id="btnResumeExt" title="이 PC의 새 Windows 콘솔 창(외부 터미널)에서 세션을 이어갑니다">외부 창으로 열기</button>
    ${hasCwd ? '<button id="btnResumeIde" class="desk" title="Antigravity / Cursor IDE에서 이 작업 폴더를 엽니다">IDE에서 열기</button>' : ''}${switchBtnHTML(sid)}`);
  $('#bar').onclick = async (e) => {
    const tb = e.target.closest('[data-tab]');
    if (tb) return select(state.sel, tb.dataset.tab);
    if (e.target.id === 'btnResumeExt' || e.target.id === 'btnResumeIde') {
      const isIde = e.target.id === 'btnResumeIde';
      const kind = r?.agent === 'codex' ? 'codex' : r?.agent === 'agy' ? 'agy' : 'claude';
      const res = await api('/api/term/external', {
        method: 'POST',
        body: { kind, resume: sid, cwd: r?.cwd || live?.cwd, skipPermissions: true, ide: isIde },
      });
      if (res.error) return toast(res.error, 6000);
      toast(isIde ? 'IDE에서 작업 폴더를 열었습니다' : '외부 Windows 콘솔 창에서 세션을 열었습니다');
      setTimeout(refreshOverview, 1200);
      return;
    }
    if (e.target.id !== 'btnResume') return;
    const body = r?.agent === 'codex'
      ? { kind: 'codex', resume: sid, cwd: r.cwd }
      : r?.agent === 'agy'
        ? { kind: 'agy', resume: sid, cwd: r.cwd }
        : { kind: 'claude', resume: sid, cwd: r?.cwd || live?.cwd, skipPermissions: true, fork: !!e.target.dataset.fork };
    const t = await api('/api/term/new', { method: 'POST', body });
    if (t.error) return toast(t.error, 6000);
    await refreshOverview();
    select({ kind: 'term', id: t.id });
  };
  if (state.tab === 'files') return renderArtifacts(sid, gen);
  renderChat(sid, gen, state.sel.at ?? -1, termsOf(state.sel.q));
}

function resolveTermSessionId(t) {
  if (!t) return null;
  if (t.sessionId) return t.sessionId;
  const norm = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase();
  const tCwd = norm(t.cwd);
  if (!tCwd) return null;
  const ag = t.agent || (t.codex ? 'codex' : t.agy ? 'agy' : t.claude ? 'claude' : null);
  const hit = state.recent.find((r) => (!ag || (r.agent || 'claude') === ag) && norm(r.cwd) === tCwd);
  return hit?.sessionId || null;
}

let chatPollTimer = null;
async function renderChat(sid, gen, at = -1, terms = [], hostEl = null) {
  clearTimeout(chatPollTimer);
  const container = hostEl || $('#view');
  if (!container) return;
  let curSid = sid;
  if (!curSid && state.sel.kind === 'term') {
    const t = state.terms.find((x) => x.id === state.sel.id);
    curSid = resolveTermSessionId(t);
  }
  const tCur = state.sel.kind === 'term' ? state.terms.find((x) => x.id === state.sel.id) : null;
  const ag = state.recent.find((x) => x.sessionId === curSid)?.agent || tCur?.agent || (tCur?.codex ? 'codex' : tCur?.agy ? 'agy' : 'claude');
  const who = ag === 'codex' ? 'Codex' : ag === 'agy' ? 'Antigravity' : 'Claude';
  container.innerHTML = '<div class="chat">불러오는 중…</div>';
  let lastSize = -1;
  const jump = at >= 0;
  const tick = async () => {
    if (gen !== viewGen) return;
    if (!curSid && state.sel.kind === 'term') {
      const t = state.terms.find((x) => x.id === state.sel.id);
      curSid = resolveTermSessionId(t);
    }
    const box = $('.chat', container);
    if (!box) return;
    if (!curSid) {
      box.innerHTML = `<div class="h-empty-card" style="margin:24px auto;max-width:480px">
        <b>아직 기록된 대화 내역이 없습니다</b>
        <span class="ums">터미널 화면에서 첫 프롬프트를 전송하면 대화 기록이 자동으로 여기에 실시간 표시됩니다.</span>
        ${!hostEl ? `<div class="row" style="gap:8px;margin-top:6px"><button class="primary" data-goto-tab="screen">터미널 화면으로</button><button data-goto-tab="split">${ICO.split} 화면 + 대화 분할 보기</button></div>` : ''}
      </div>`;
      box.querySelectorAll('[data-goto-tab]').forEach((b) => (b.onclick = () => select(state.sel, b.dataset.gotoTab)));
      chatPollTimer = setTimeout(tick, 3000);
      return;
    }
    const d = await api(`/api/transcript?id=${encodeURIComponent(curSid)}${jump ? '&at=' + at : ''}`).catch((e) => ({ error: e.message }));
    if (gen !== viewGen) return;
    if (d.error && !d.messages?.length) {
      box.innerHTML = `<div class="h-empty-card" style="margin:24px auto;max-width:480px">
        <b>대화 기록을 준비 중입니다 (${esc(curSid.slice(0, 8))})</b>
        <span class="ums">에이전트가 첫 응답을 기록하면 자동으로 대화 내역이 나타납니다.</span>
      </div>`;
    } else if (d.size !== lastSize && !selectionIn(box)) { // keep a selection the user is copying
      lastSize = d.size;
      const v = container;
      const atBottom = v.scrollHeight - v.scrollTop - v.clientHeight < 80 || !box.dataset.painted;
      const b = d.base || 0;
      const more = jump && b + d.messages.length < (d.total || 0)
        ? `<div class="row" style="justify-content:center;margin:10px"><button class="btn-latest">최신 대화로 이동</button></div>` : '';
      const parts = [];
      let toolBuf = [];
      const flushTools = () => {
        if (!toolBuf.length) return;
        const firstLine = (toolBuf[0].text || '').split('\n')[0].slice(0, 70);
        parts.push(`<details class="toolgrp"><summary>⚙ 도구 실행 ${toolBuf.length}건 · ${esc(firstLine)}</summary><div class="toolgrp-body">${toolBuf.map((x) => `<div>${linkPaths(hl(x.text, terms))}</div>`).join('')}</div></details>`);
        toolBuf = [];
      };
      d.messages.forEach((m, k) => {
        const tool = m.role === 'assistant' && m.text.startsWith('⚙');
        const tgt = jump && b + k === at;
        if (tool && !tgt) { toolBuf.push(m); return; }
        flushTools();
        const rawTxt = String(m.text || '').replace(/<external_codex_apps_[^>]*>[\s\S]*?<\/external_codex_apps_[^>]*>/gi, '').trim();
        if (!rawTxt) return;
        const when = m.ts ? new Date(m.ts).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
        const bodyHtml = m.role === 'assistant' && !tool && !terms.length
          ? `<div class="md">${md(rawTxt)}</div>`
          : linkPaths(hl(rawTxt, terms));
        parts.push(`<div class="msg ${tool ? 'tool' : m.role}${tgt ? ' target' : ''}" data-mi="${k}">
          ${tool ? '' : `<div class="who">${m.role === 'assistant' ? agentIcon(ag || 'claude') : ''}<span class="w-role">${m.role === 'user' ? '사용자' : who}</span><span class="w-ts">${esc(when)}</span><button class="msg-copy" data-copy-mi="${k}" title="이 메시지 복사">복사</button></div>`}
          ${bodyHtml}
        </div>`);
      });
      flushTools();
      box.innerHTML = (b > 0 ? `<div class="empty" style="margin-bottom:6px">… 이전 메시지 ${b}개 생략</div>` : '') + (parts.join('') || '<div class="empty">메시지 없음</div>') + more;
      box.onclick = (e) => {
        const cb = e.target.closest('[data-copy-mi]');
        if (cb) { const m = d.messages[Number(cb.dataset.copyMi)]; if (m) copyText(m.text); }
      };
      const btn = $('.btn-latest', box);
      if (btn) btn.onclick = () => select({ ...state.sel, at: -1 }, hostEl ? state.tab : 'chat');
      const first = !box.dataset.painted;
      box.dataset.painted = '1';
      const t = first && jump && $('.msg.target', box);
      if (t) t.scrollIntoView({ block: 'center' });
      else if (atBottom) v.scrollTop = v.scrollHeight;
    }
    if (!jump) chatPollTimer = setTimeout(tick, 3000);
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
let dockCollapsed = false;
try { dockCollapsed = localStorage.getItem('ccd.dockCollapsed') === '1'; } catch {}
const termPromptHist = [];

function viewTerm() {
  const gen = viewGen;
  clearTimeout(chatPollTimer);
  const t = state.terms.find((x) => x.id === state.sel.id);
  const sid = resolveTermSessionId(t);
  const artSid = sid || (t ? `term:${t.id}` : '');
  const ag = t?.agent || (t?.codex ? 'codex' : t?.agy ? 'agy' : t?.claude ? 'claude' : null);

  setBar(`<h2>${ag ? agentIcon(ag) + ' ' : ''}${esc(t ? termLabel(t) : '터미널')}</h2>${t?.account ? `<span class="badge c">${esc(t.account.label.replace(/@.*/, ''))}</span>` : ''}
    <div class="tabs">
      <button data-tab="screen" class="${state.tab === 'screen' ? 'on' : ''}" title="터미널 콘솔 화면 전체 보기">화면</button>
      <button data-tab="split" class="${state.tab === 'split' ? 'on' : ''}" title="좌측: 터미널 화면 · 우측: 실시간 대화 기록 분할 보기">${ICO.split} 화면 + 대화</button>
      <button data-tab="chat" class="${state.tab === 'chat' ? 'on' : ''}" title="전체 마크다운 대화 기록 보기">대화 기록</button>
      <button data-tab="files" class="${state.tab === 'files' ? 'on' : ''}" title="이 세션의 산출물 보기 및 지정">산출물</button>
    </div>
    ${t?.cwd ? `<span class="badge desk" id="btnCopyCwd" title="클릭하여 작업 폴더 경로 복사 (${esc(t.cwd)})" style="cursor:pointer">${ICO.folder} ${esc(base(t.cwd) || t.cwd)}</span>` : ''}
    ${t?.agy ? `<button id="btnAgyUsage" title="Antigravity CLI에 /usage 전송">${ICO.chart} /usage</button>` : ''}
    ${sid ? switchBtnHTML(sid, t?.id || '') : t?.claude || t?.codex || t?.agy ? switchBtnHTML('', t.id) : ''}
    <button id="btnClose">닫기</button>`);
  $('#bar').onclick = async (e) => {
    if (e.target.closest('#btnAgyUsage')) return openAgyUsage($('#btnAgyUsage'), true);
    if (e.target.closest('#btnCopyCwd') && t?.cwd) return copyText(t.cwd);
    const tb = e.target.closest('[data-tab]');
    if (tb) return select(state.sel, tb.dataset.tab);
    if (e.target.id !== 'btnClose') return;
    if (!confirm('이 터미널의 프로세스를 종료하고 닫을까요?')) return;
    await api('/api/term/close', { method: 'POST', body: { id: state.sel.id } });
    await refreshOverview();
    select({ kind: 'home' });
  };
  if (state.tab === 'chat') return renderChat(sid, gen);
  if (state.tab === 'files') return renderArtifacts(artSid, gen);

  const isSplit = state.tab === 'split';
  const termFullHTML = `<div class="full"><div id="termwrap"></div>
    <div class="term-dock">
      <div class="tdock-bar">
        <button class="tdock-mode" id="tDockToggle" title="하단 프롬프트 작성창을 접거나 펼칩니다 (접은 상태에서도 위쪽 검은 터미널 화면을 클릭해 직접 타이핑할 수 있습니다)">${dockCollapsed ? '▴ 프롬프트 입력창 펼치기' : '▾ 입력창 접기 (터미널 직접 입력)'}</button>
        <div class="tdock-tools">
          <label class="filebtn" title="이 PC의 파일·스크린샷 첨부 → 경로 자동 입력 (터미널로 드래그 앤 드롭 또는 Ctrl+V도 가능)">${ICO.clip}<span>파일 첨부</span><input type="file" class="fpick" multiple hidden></label>
          <button id="tArt" title="세션이나 자율 연구 프로젝트의 산출물 경로를 선택해 넣기">${ICO.folder}<span>산출물 넣기</span></button>
          <button data-copy="1" title="터미널에서 마우스로 드래그한 텍스트(없으면 화면 전체) 복사">${ICO.copy}<span>화면 복사</span></button>
        </div>
        <div class="tdock-keys">
          <span class="tdock-klbl">TUI 제어</span>
          <button data-key="esc" title="Esc (취소 / 이전 메뉴)">Esc</button>
          <button data-key="up" title="↑ (이전 명령 / 위쪽 항목)">↑</button>
          <button data-key="down" title="↓ (다음 명령 / 아래쪽 항목)">↓</button>
          <button data-key="tab" title="Tab (자동완성)">Tab</button>
          <button data-key="shift+tab" title="Shift+Tab (모드 전환: Plan / Auto-accept 등)">⇧Tab</button>
          <button data-key="ctrl+c" title="Ctrl+C (실행 중단)">^C</button>
          <button data-key="enter" title="Enter (확인 / 실행)">⏎</button>
        </div>
      </div>
      <div class="tdock-comp" id="tDockComp" ${dockCollapsed ? 'hidden' : ''}>
        <textarea id="tin" rows="1" placeholder="프롬프트 입력 (Enter 전송 · Shift+Enter 줄바꿈 · 파일 드래그/Ctrl+V 첨부 · 빈 칸에서 ↑↓/Esc/Tab은 터미널 제어)" enterkeyhint="send"></textarea>
        <button class="primary" id="tsend" title="터미널에 프롬프트 전송 (Enter)">보내기 ⏎</button>
      </div>
    </div>
    <div class="note"></div></div>`;

  if (isSplit) {
    $('#view').innerHTML = `<div class="term-split">
      <div class="tsplit-left">${termFullHTML}</div>
      <div class="tsplit-right">
        <div class="tsplit-hd">
          <span>💬 실시간 대화 기록${sid ? ` <span class="badge mono">${esc(sid.slice(0, 8))}</span>` : ''}</span>
          <div class="row" style="gap:4px">
            <button class="h-row-act" id="btnSplitFiles" title="산출물 탭으로 이동">${ICO.folder} 산출물</button>
            <button class="h-row-act" id="btnSplitChat" title="대화 기록 전체 화면으로 보기">전체 보기 →</button>
          </div>
        </div>
        <div class="tsplit-body" id="splitChatHost"></div>
      </div>
    </div>`;
    $('#btnSplitFiles').onclick = () => select(state.sel, 'files');
    $('#btnSplitChat').onclick = () => select(state.sel, 'chat');
    renderChat(sid, gen, -1, [], $('#splitChatHost'));
  } else {
    $('#view').innerHTML = termFullHTML;
  }

  xterm = new Terminal({ fontFamily: '"Cascadia Mono", Consolas, "D2Coding", monospace', fontSize: IS_MOBILE ? 11 : 13, cursorBlink: true, scrollback: 10000, theme: { background: '#0e0e11' } });
  const fit = new FitAddon.FitAddon();
  xterm.loadAddon(fit);
  xterm.open($('#termwrap'));
  // Claude Code / Codex on Windows (ConPTY) redraws in place on a fixed-size screen, so almost nothing reaches
  // the terminal's scrollback — scrolling up stops after one screen. Point to split view or transcript instead.
  if (!isSplit) {
    let hintAt = 0;
    $('#termwrap').addEventListener('wheel', (e) => {
      if (e.deltaY >= 0 || xterm.buffer.active.viewportY > 0 || Date.now() - hintAt < 8000) return;
      hintAt = Date.now();
      const h = document.createElement('div');
      h.className = 'termhint';
      h.innerHTML = '터미널에는 화면 한 장 분량만 남습니다 (Windows 콘솔 특성). 이전 대화는 <button class="linkbtn" data-htab="split">"화면 + 대화" 분할 보기</button> 또는 <button class="linkbtn" data-htab="chat">"대화 기록" 탭 →</button>';
      h.querySelectorAll('[data-htab]').forEach((b) => (b.onclick = () => select(state.sel, b.dataset.htab)));
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
  const comp = $('#tDockComp');
  const fitTin = () => {
    if (!tin) return;
    tin.style.height = 'auto';
    tin.style.height = Math.min(140, Math.max(36, tin.scrollHeight)) + 'px';
  };
  tin.addEventListener('input', fitTin);
  $('#tDockToggle').onclick = () => {
    dockCollapsed = !dockCollapsed;
    try { localStorage.setItem('ccd.dockCollapsed', dockCollapsed ? '1' : '0'); } catch {}
    comp.hidden = dockCollapsed;
    $('#tDockToggle').textContent = dockCollapsed ? '▴ 프롬프트 입력창 펼치기' : '▾ 입력창 접기 (터미널 직접 입력)';
    setTimeout(() => { resize(); if (dockCollapsed && !IS_MOBILE) xterm?.focus(); else if (!dockCollapsed) tin.focus(); }, 30);
  };
  // file paths (drop / paste / 📎 / 산출물): if composer is open, insert into composer; if collapsed, send straight to terminal!
  const insert = (txt) => {
    if (dockCollapsed) {
      send((txt.endsWith(' ') ? txt : txt + ' '));
      if (!IS_MOBILE) xterm?.focus();
      toast('터미널에 파일 경로를 입력했습니다');
      return;
    }
    tin.value += (tin.value && !tin.value.endsWith(' ') ? ' ' : '') + txt;
    fitTin();
    tin.focus();
  };
  attachFileInput($('#view .full'), insert, t?.cwd);
  let histIdx = -1;
  const submit = () => {
    const v = tin.value;
    tin.value = '';
    fitTin();
    histIdx = -1;
    if (v.trim()) {
      if (termPromptHist[0] !== v) termPromptHist.unshift(v);
      if (termPromptHist.length > 50) termPromptHist.pop();
    }
    // claude/codex treats text+CR in one burst as a paste; send Enter separately (longer text → longer pause)
    if (v) { send(v); setTimeout(() => send('\r'), 350 + Math.min(3000, v.length * 2)); } else send('\r');
  };
  $('#tsend').onclick = submit;
  $('#tArt').onclick = () => pickArtifact((abs) => insert(quotePath(abs)));
  tin.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); return; }
    if (e.key === 'Escape') { e.preventDefault(); send(PTY_KEYS.esc); if (!IS_MOBILE) xterm?.focus(); return; }
    if (!tin.value) {
      if (e.key === 'ArrowUp' && !e.altKey) { e.preventDefault(); send(PTY_KEYS.up); return; }
      if (e.key === 'ArrowDown' && !e.altKey) { e.preventDefault(); send(PTY_KEYS.down); return; }
      if (e.key === 'Tab') { e.preventDefault(); send(e.shiftKey ? PTY_KEYS['shift+tab'] : PTY_KEYS.tab); return; }
    }
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && termPromptHist.length) {
      e.preventDefault();
      histIdx = e.key === 'ArrowUp' ? Math.min(termPromptHist.length - 1, histIdx + 1) : Math.max(-1, histIdx - 1);
      tin.value = histIdx >= 0 ? termPromptHist[histIdx] : '';
      fitTin();
    }
  };
  $('#view .full').addEventListener('click', (e) => {
    if (e.target.closest('[data-copy]')) {
      if (xterm?.hasSelection()) { copyText(xterm.getSelection()); xterm.clearSelection(); return; }
      const b = xterm.buffer.active, lines = [];
      for (let i = 0; i < b.length; i++) lines.push(b.getLine(i)?.translateToString(true) ?? '');
      while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
      return copyText(lines.join('\n'));
    }
    const k = e.target.closest('[data-key]')?.dataset.key;
    if (k) { send(PTY_KEYS[k]); if (!IS_MOBILE) xterm?.focus(); }
  });
  bindFilePick($('#view .full'), insert, t?.cwd);
  // whichever device is being looked at owns the pty size
  window.onresize = resize;
  window.onfocus = resize;
  document.onvisibilitychange = () => { if (!document.hidden) resize(); };
  setTimeout(() => { resize(); if (!IS_MOBILE) xterm?.focus(); }, 60);
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
  const [uRes, aRes] = await Promise.allSettled([
    api('/api/usage' + (force ? '?force=1' : '')),
    api('/api/agy/quota'),
  ]);
  state.usage = uRes.status === 'fulfilled' ? uRes.value : { available: false, error: uRes.reason?.message || '오류' };
  if (state.usage?.accounts) state.usage.accounts = state.usage.accounts.filter((a) => a.id !== 'agy-cli');
  if (aRes.status === 'fulfilled' && aRes.value?.quota) state.agyQuota = aRes.value.quota;
  renderSide();
  refreshHomeWidgets();
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
async function openAgyUsage(btn, stayInTerm = false) {
  const prev = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = btn.classList.contains('qact') ? '…' : 'agy 조회 중…'; }
  try {
    const r = await api('/api/agy/usage', { method: 'POST', body: {} });
    if (r.error) return toast(r.error, 6000);
    if (r.quota) state.agyQuota = r.quota;
    await refreshOverview();
    if (r.quota && !stayInTerm) {
      renderSide();
      if (state.sel.kind === 'usage') paintUsage();
      else select({ kind: 'usage' });
    } else {
      select({ kind: 'term', id: r.term.id });
    }
  } catch (e) {
    toast(e.message || 'agy 실행 실패', 6000);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = prev; }
  }
}
function agySideRowsHTML() {
  const q = state.agyQuota;
  if (!q?.groups?.length) return '';
  return q.groups.map((g) => {
    const ms = [g.fiveH, g.weekly].filter((v) => v != null);
    return `<div class="urow" title="Antigravity · ${esc(g.name)} (${esc(q.account || '')})"><span class="ul">AGY ${esc(g.name.split(' ')[0])}</span>${ms.map((p) => `${bar(p, true)}<span class="up ${level(p)}">${pctTxt(p)}</span>`).join('')}</div>`;
  }).join('');
}
// ---------- reusable right-side Drawer (Astryx Drawer surface) ----------
function openDrawer({ title, bodyHTML = '', footerHTML = '', width = 460 } = {}) {
  const d = document.createElement('div');
  d.className = 'drw-backdrop';
  d.innerHTML = `<div class="drw-panel" style="--drw-w:${width}px" role="dialog" aria-label="${esc(title || '')}">
    <div class="drw-head"><h3>${esc(title || '')}</h3><button data-drw-close title="닫기 (Esc)">${ICO.close}</button></div>
    <div class="drw-body">${bodyHTML}</div>
    ${footerHTML ? `<div class="drw-foot">${footerHTML}</div>` : ''}
  </div>`;
  const close = () => { document.removeEventListener('keydown', onKey); d.remove(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  d.addEventListener('click', (e) => { if (e.target === d || e.target.closest('[data-drw-close]')) close(); });
  document.body.appendChild(d);
  d.close = close;
  return d;
}
window.openDrawer = openDrawer;

const isResetTodayIso = (iso) => {
  if (!iso) return false;
  const d = new Date(iso), now = new Date();
  return d > now && d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
};
const isResetTodayText = (txt) => {
  const m = /(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?/i.exec(String(txt || ''));
  if (!m || (!m[1] && !m[2])) return false;
  const ms = ((Number(m[1]) || 0) * 60 + (Number(m[2]) || 0)) * 60 * 1000;
  if (ms <= 0) return false;
  const d = new Date(Date.now() + ms), now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
};

const shortResetAt = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return `${untilText(iso)} (${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')})`;
};
const cleanNote = (n) => String(n || '').replace(/(\d+)\.\d{4,}/g, (_, intPart) => Number(intPart).toLocaleString('en-US'));

function agyCardHTML() {
  const q = state.agyQuota;
  if (!q?.groups?.length) return '';
  const allUsed = q.groups.flatMap((g) => [g.fiveH, g.weekly]).filter((v) => v != null);
  const worst = allUsed.length ? Math.max(...allUsed) : null;
  const soon = q.groups.some((g) => isResetTodayText(g.weeklyReset));
  const head = worst != null ? `<div style="text-align:right;flex:none"><div class="uhead-num ${level(worst)}">${Math.max(0, Math.round(100 - worst))}%</div><div class="uhead-lbl">남은 한도</div></div>` : '';
  return `<div class="ucard${soon ? ' reset-soon' : ''}">
    <div class="uh">${agentIcon('agy', 'idle')}<b>Antigravity IDE / CLI</b>${soon ? `<span class="badge soon">${ICO.clock} 금일 리셋</span>` : ''}${q.account ? `<span class="badge agy">${esc(q.account)}</span>` : ''}${head}</div>
    ${q.groups.map((g) => `<div class="ugrp"><div class="ugrp-title">${esc(g.name)}</div>
      ${g.fiveH != null ? `<div class="um"><div class="umt"><span>5시간 한도</span><span class="up ${level(g.fiveH)}">${pctTxt(g.fiveH)}% <span style="font-weight:400;color:var(--muted)">(${g.fiveHRem}% 남음)</span></span></div>
        ${bar(g.fiveH)}<div class="ums">${esc(g.fiveHReset || '')}</div></div>` : ''}
      ${g.weekly != null ? `<div class="um"><div class="umt"><span>주간 한도</span><span class="up ${level(g.weekly)}">${pctTxt(g.weekly)}% <span style="font-weight:400;color:var(--muted)">(${g.weeklyRem}% 남음)</span></span></div>
        ${bar(g.weekly)}<div class="ums">${esc(g.weeklyReset || '')}</div></div>` : ''}</div>`).join('')}
    <div class="ums">조회: ${esc(new Date(q.fetchedAt).toLocaleTimeString())}</div>
  </div>`;
}
function usageStripHTML() {
  const u = state.usage;
  const chips = !u?.available ? [] : u.accounts.filter((a) => a.ok && a.meters?.length).map((a) => {
    const ms = keyMeters(a);
    const worst = Math.max(...ms.map((m) => m.usedPercent));
    return `<span class="uchip ${level(worst)}"><b>${esc(shortLabel(a))}</b> ${ms.map((m) => `${/5시간/.test(m.name) ? '5h' : /주간/.test(m.name) ? '주' : ''} ${pctTxt(m.usedPercent)}%`).join(' · ')}</span>`;
  });
  if (state.agyQuota?.groups?.length) {
    const g0 = state.agyQuota.groups[0];
    const pcts = [g0.fiveH, g0.weekly].filter((v) => v != null);
    if (pcts.length) {
      const worst = Math.max(...pcts);
      chips.push(`<span class="uchip ${level(worst)}"><b>Antigravity</b> ${[g0.fiveH != null ? `5h ${pctTxt(g0.fiveH)}%` : '', g0.weekly != null ? `주 ${pctTxt(g0.weekly)}%` : ''].filter(Boolean).join(' · ')}</span>`);
    }
  }
  return chips.length ? `<div class="ustrip">${chips.join('')}</div>` : '';
}
function viewUsage() {
  setBar(`<h2>AI 사용량</h2>
    <button id="uAgy" title="agy 터미널을 열고 /usage를 실행해 Antigravity 한도를 확인합니다">${ICO.chart} Antigravity 한도</button>
    <button id="uAccounts">계정 관리</button>
    <button class="primary" id="uRefresh" title="제공사에 다시 조회">${ICO.refresh} 지금 조회</button>`);
  $('#bar').onclick = async (e) => {
    if (e.target.closest('#uAgy')) return openAgyUsage($('#uAgy'));
    if (e.target.id === 'uAccounts') return openAccounts();
    const rb = e.target.closest('#uRefresh');
    if (!rb) return;
    rb.disabled = true; rb.textContent = '조회 중…';
    await refreshUsage(true);
  };
  paintUsage();
}
function paintUsage() {
  const u = state.usage;
  if (!u) { $('#view').innerHTML = '<div class="empty" style="padding:20px">불러오는 중…</div>'; return; }
  if (!u.available) { $('#view').innerHTML = `<div class="err">${esc(u.error)}<br><br>AI 사용량 대시보드(기본 127.0.0.1:4777)가 꺼져 있습니다. 설치 폴더의 start.bat 또는 ai-usage-dashboard를 실행하세요.</div>`; return; }
  const cards = u.accounts.map((a) => {
    const pcts = (a.meters || []).map((m) => m.usedPercent).filter((v) => v != null);
    const worst = a.ok && pcts.length ? Math.max(...pcts) : null;
    const soon = a.ok && (a.meters || []).some((m) => /주간|weekly/i.test(m.name || '') && (isResetTodayIso(m.resetsAt) || isResetTodayText(m.detail)));
    const head = worst != null ? `<div style="text-align:right;flex:none"><div class="uhead-num ${level(worst)}">${Math.max(0, Math.round(100 - worst))}%</div><div class="uhead-lbl">남은 한도</div></div>` : '';
    const tag = `${a.type || ''} ${a.provider || ''}`;
    const kind = /claude/i.test(tag) ? 'claude' : /codex|chatgpt|openai/i.test(tag) ? 'codex' : /agy|antigravity/i.test(tag) ? 'agy' : 'bot';
    const meterRow = (m) => `<div class="um"><div class="umt"><span>${esc(m.name)}</span><span class="up ${level(m.usedPercent)}">${pctTxt(m.usedPercent)}%</span></div>
      ${bar(m.usedPercent)}<div class="ums">${[m.resetsAt ? shortResetAt(m.resetsAt) : '', m.detail ? esc(m.detail) : ''].filter(Boolean).join(' · ')}</div></div>`;
    const mainM = (a.meters || []).filter((m) => /5시간|주간|weekly|five/i.test(m.name || ''));
    const extraM = (a.meters || []).filter((m) => !/5시간|주간|weekly|five/i.test(m.name || ''));
    const footNotes = [
      a.billing?.at ? `${esc(a.billing.label)}: ${esc(new Date(a.billing.at).toLocaleDateString())}` : '',
      ...(a.notes || []).map((n) => esc(cleanNote(n))),
    ].filter(Boolean);
    return `<div class="ucard${soon ? ' reset-soon' : ''}">
    <div class="uh">${agentIcon(kind, a.live ? 'idle' : '')}<b>${esc(a.label)}</b>${soon ? `<span class="badge soon">${ICO.clock} 금일 리셋</span>` : ''}${a.plan ? `<span class="badge">${esc(a.plan)}</span>` : ''}${head}</div>
    ${!a.ok ? `<div class="empty">${esc(a.error || '조회 실패')}</div>` : ''}
    ${mainM.length ? `<div class="ugrp">${mainM.map(meterRow).join('')}</div>` : ''}
    ${extraM.length || footNotes.length ? `<div class="ugrp">${extraM.map(meterRow).join('')}${footNotes.map((t) => `<div class="ums">${t}</div>`).join('')}</div>` : ''}
  </div>`;
  }).join('');
  $('#view').innerHTML = `<div class="ugrid">${cards}${agyCardHTML()}</div>`;
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
  const d = openDrawer({ title: 'AI 사용량 계정 관리', bodyHTML: '<div id="acBody">불러오는 중…</div>', width: 480 });
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
    $('#acClose', d).onclick = () => d.close();
    $('#acCodex', d).onclick = async () => {
      const t = await api('/api/codex/add', { method: 'POST', body: {} }).catch((e) => ({ error: e.message }));
      if (t.error) return toast(t.error, 6000);
      d.close();
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
  const body = `
    <div class="mono" style="word-break:break-all">${esc(abs)}</div>
    <label>보낼 세션<br>${targets.length ? `<select id="spT" style="width:100%">${targets.map((t) => `<option value="${esc(t.id)}" ${String(t.id) === cur ? 'selected' : ''}>t:${esc(t.id)} ${esc(t.label)}</option>`).join('')}</select>` : '<div class="empty">열려 있는 대시보드 터미널이 없습니다</div>'}</label>
    <label>함께 보낼 말 (비우면 경로만 입력칸에 넣고 전송하지 않음)<br><textarea id="spM" rows="3" style="width:100%" placeholder="예: 이 결과 보고 다음 실험 계획 세워줘"></textarea></label>`;
  const d = openDrawer({ title: '세션에 보내기', bodyHTML: body, footerHTML: `<button data-drw-close>취소</button><button class="primary" id="spOk" ${targets.length ? '' : 'disabled'}>보내기</button>`, width: 440 });
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
  const paint = async () => {
    const r = await api(`/api/artifacts?session=${encodeURIComponent(sid)}`).catch((e) => ({ error: e.message }));
    if (gen !== viewGen) return;
    if (r.error) { $('#view').innerHTML = `<div class="err">${esc(r.error)}</div>`; return; }
    const all = r.items || [];
    const items = artShowAll ? all : all.filter((x) => x.main);
    const card = ([it, i]) => `<div class="acard" data-ai="${i}">
        <div class="athumb">${it.kind === 'image' ? `<img loading="lazy" src="${artUrl(sid, it.path)}" alt="">` : `<span>${ART_ICON[it.kind] || ART_ICON.file}</span>`}</div>
        <div class="ameta"><b title="${esc(it.path)}">${esc(it.title || it.name)}</b>
          <span class="ums">${esc(it.ext.toUpperCase())} · ${fmtSize(it.size)} · ${relTime(it.mtime)}${it.source === 'pinned' ? ' · 지정됨' : ''}</span></div>
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
  const cb = e.target.closest('[data-copy-code]');
  if (cb) {
    e.stopPropagation();
    const pre = cb.closest('.codeblk')?.querySelector('.mdpre');
    if (pre) copyText(pre.textContent);
    return;
  }
  const b = e.target.closest('[data-switch]');
  if (b) { e.stopPropagation(); openSwitch(b.dataset.switch, b.dataset.switchTerm); }
}, true);
async function openSwitch(sid, termId = '') {
  const d = openDrawer({ title: '다른 계정 · 에이전트로 이어하기', bodyHTML: '<div id="swBody">AI 사용량 및 계정 확인 중…</div>', width: 520 });
  const r = await api(`/api/switch/candidates?id=${encodeURIComponent(sid)}${termId ? `&term=${encodeURIComponent(termId)}` : ''}`).catch((e) => ({ error: e.message }));
  const body = $('#swBody', d);
  if (r.error || !r.candidates) { body.innerHTML = `<div class="err">${esc(r.error || '후보를 불러오지 못함')}</div>`; return; }
  const s = state.live.find((x) => x.sessionId === sid);
  const srcAgent = r.sourceAgent || 'claude';
  const agentName = (a) => (a === 'codex' ? 'Codex' : a === 'agy' ? 'Antigravity / Gemini' : 'Claude Code');
  const pct = (v) => (v === null || v === undefined ? '<span class="up">?</span>' : `${bar(v, true)}<span class="up ${level(v)}">${Math.round(v)}</span>`);
  body.innerHTML = `
    ${s?.limit ? `<div class="err" style="padding:0 0 6px">${esc(s.limit.text)}</div>` : ''}
    <div class="empty" style="padding:0 0 6px">Claude Code · Codex (ChatGPT) · Antigravity (Gemini) 계정 간 자유롭게 이어갈 수 있습니다. 같은 플랫폼은 세션을 그대로 재개하고, 다른 플랫폼은 직전 대화 맥락(handoff)을 자동으로 넘겨 이어갑니다.</div>
    <div class="swlist">${r.candidates.map((c) => {
      const cross = c.agent && c.agent !== srcAgent;
      return `<label class="swrow${c.usable && !c.current ? '' : ' dis'}" data-agent="${esc(c.agent || 'claude')}">
        <input type="radio" name="acc" value="${esc(c.id)}" data-agent="${esc(c.agent || 'claude')}" ${c.best ? 'checked' : ''} ${c.usable && !c.current ? '' : 'disabled'}>
        <span class="swl" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
          ${agentIcon(c.agent || 'claude')}
          <span>${esc(c.label)}</span>
          ${agentBadge(c.agent || 'claude')}
          ${cross ? '<span class="badge" title="직전 대화 맥락을 요약하여 이 플랫폼으로 전달합니다">교차 인계</span>' : ''}
          ${c.current ? `<span class="badge">${c.sameAccount ? '현재와 같은 계정' : '현재 실행 중'}</span>` : ''}
          ${c.best ? '<span class="badge c">가장 여유</span>' : ''}
        </span>
        <span class="swm">5h ${pct(c.fiveH)}</span><span class="swm">주 ${pct(c.weekly)}</span></label>`;
    }).join('')}</div>
    <div class="row" style="gap:14px;padding:6px 0 2px;flex-wrap:wrap">
      <span class="ums" style="font-weight:600;color:var(--fg)">열기 위치:</span>
      <label class="row" style="gap:5px"><input type="radio" name="swMode" value="dashboard" checked> 대시보드 터미널</label>
      <label class="row" style="gap:5px"><input type="radio" name="swMode" value="external"> 외부 Windows 콘솔 창</label>
    </div>
    <label class="row"><input type="checkbox" id="swCont" checked> 재개 후 “계속 진행해” (또는 맥락 인계 프롬프트) 자동 전송</label>
    <label class="row" id="swSkipRow"><input type="checkbox" id="swSkip" checked> --dangerously-skip-permissions 로 실행 (Claude 전용)</label>
    <div id="swHint" class="empty" style="padding:4px 0 0"></div>
    <div class="row" style="justify-content:flex-end;margin-top:10px"><button id="swCancel">취소</button><button class="primary" id="swGo" ${r.candidates.some((c) => c.best || (c.usable && !c.current)) ? '' : 'disabled'}>이어하기</button></div>`;
  const updateHint = () => {
    const sel = $('input[name=acc]:checked', d);
    const targetAgent = sel?.dataset.agent || srcAgent;
    const mode = $('input[name=swMode]:checked', d)?.value || 'dashboard';
    const whereTxt = mode === 'external' ? '새 Windows 외부 콘솔 창' : '대시보드 터미널';
    const skipRow = $('#swSkipRow', d);
    if (skipRow) skipRow.style.display = targetAgent === 'claude' ? 'flex' : 'none';
    const hint = $('#swHint', d);
    if (!hint) return;
    if (targetAgent !== srcAgent) {
      hint.innerHTML = `<b>${esc(agentName(srcAgent))} → ${esc(agentName(targetAgent))} 교차 이동:</b> 최근 대화 맥락을 요약 파일(<code>handoff.md</code>)로 저장한 뒤 ${whereTxt}에서 ${esc(agentName(targetAgent))} 세션을 시작하여 자동으로 전달합니다.`;
    } else if (r.fresh) {
      hint.textContent = `아직 대화가 없는 터미널이라, 같은 폴더(${whereTxt})에서 고른 계정으로 새로 시작합니다.`;
    } else if (r.live) {
      hint.textContent = `실행 중인 세션(${r.where || '창 없음'})을 종료한 뒤 ${whereTxt}에서 같은 대화를 이어갑니다.`;
    } else {
      hint.textContent = `선택한 계정으로 ${whereTxt}에서 대화를 이어 실행합니다.${r.stale ? ' · 사용량 값이 오래됐을 수 있음' : ''}`;
    }
  };
  d.querySelectorAll('input[name=acc], input[name=swMode]').forEach((el) => (el.onchange = updateHint));
  updateHint();
  $('#swCancel', d).onclick = () => d.close();
  $('#swGo', d).onclick = async () => {
    const acc = $('input[name=acc]:checked', d)?.value;
    if (!acc) return;
    const openMode = $('input[name=swMode]:checked', d)?.value || 'dashboard';
    const go = $('#swGo', d); go.disabled = true; go.textContent = '전환 중…';
    const payload = { sessionId: sid || undefined, termId: termId || undefined, account: acc, cont: $('#swCont', d).checked, skip: $('#swSkip', d)?.checked ?? true, openMode };
    let res = await api('/api/switch', { method: 'POST', body: payload });
    if (res.busy && confirm('세션이 작업 중입니다. 중단(Esc)하고 전환할까요?')) res = await api('/api/switch', { method: 'POST', body: { ...payload, interrupt: true } });
    if (res.stuck && confirm(res.error)) res = await api('/api/switch', { method: 'POST', body: { ...payload, interrupt: true, force: true } });
    if (!res.ok) { go.disabled = false; go.textContent = '이어하기'; if (!res.busy) body.insertAdjacentHTML('afterbegin', `<div class="err" style="padding:0 0 8px">${esc(res.error)}</div>`); return; }
    d.close();
    await refreshOverview();
    const shortLabel = (res.account?.label || acc).replace(/@.*/, '');
    if (res.external) {
      toast(`${shortLabel} 계정으로 외부 콘솔 창에서 이어서 실행했습니다`);
    } else if (res.term) {
      select({ kind: 'term', id: res.term.id });
      toast(`${shortLabel}${res.crossPlatform ? ' (교차 인계)' : ''} 계정으로 이어서 실행`);
    }
  };
}

// ---------- GPU / resource queue ----------
const fmtMB = (m) => (m >= 1024 ? `${(m / 1024).toFixed(1)}G` : `${Math.round(m)}M`);
async function refreshGpu() {
  try { state.gpu = await api('/api/gpu'); } catch { return; }
  renderSide();
  refreshHomeWidgets();
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
  setBar(`<h2>GPU · 리소스 대기열</h2>`);
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
  const servers = (q.servers || []).map((v) => `<div class="swrow"><span class="swl"><b>${ICO.gpu} ${esc(v.name)}</b> <span class="badge">${esc(v.id)}</span>
      <br><span class="ums"><span class="dot ${v.reachable == null ? 'dead' : v.reachable ? 'idle' : 'busy'}" style="display:inline-block;width:7px;height:7px;margin:0 4px 0 0;vertical-align:middle"></span>${v.reachable == null ? '확인 중' : v.reachable ? '연결됨' : '연결 안 됨'}${v.checkedAt ? ' · 확인 ' + relTime(v.checkedAt) : ''} · 실행: <code>ccd gpu run --gpu ${esc(v.id)} --mem 20G -- 명령</code> (서버에서 ssh로 실행)</span></span>${sw(v.id, v.enabled)}</div>`).join('');
  const ram = q.ram?.totalMB ? q.ram : null;
  const ramUsed = ram ? Math.max(0, ram.totalMB - ram.freeMB) : 0;
  const ramPct = ram ? Math.round((ramUsed / ram.totalMB) * 100) : 0;
  const cpuUtil = q.cpu?.util ?? 0;
  const cpuCard = q.cpu ? `<div class="ucard compact">
    <div class="uh">${ICO.gpu}<b>CPU · 프로세서</b>${q.cpu.cores ? `<span class="badge">${q.cpu.cores}코어</span>` : ''}<span class="up ${level(cpuUtil)}" style="width:auto;font-size:13px;font-weight:700">${cpuUtil}%</span></div>
    ${bar(cpuUtil)}
    <div class="ums">${esc(q.cpu.model || '로컬 프로세서')} · 유휴 ${Math.max(0, 100 - cpuUtil)}%</div>
  </div>` : '';
  const ramCard = ram ? `<div class="ucard compact">
    <div class="uh">${ICO.gpu}<b>시스템 메모리 (RAM)</b><span class="badge">${fmtMB(ramUsed)} / ${fmtMB(ram.totalMB)}</span><span class="up ${level(ramPct)}" style="width:auto;font-size:13px;font-weight:700">${ramPct}%</span></div>
    ${bar(ramPct)}
    <div class="ums">여유 ${fmtMB(ram.freeMB)}${ram.reservedMB ? ` · 대기열 예약 ${fmtMB(ram.reservedMB)}` : ''} · 안전 마진 ${fmtMB(ram.marginMB || 4096)}</div>
  </div>` : '';
  const sysRow = (cpuCard || ramCard) ? `<div class="ugrid-sys">${cpuCard}${ramCard}</div>` : '';
  const cards = q.gpus.filter((g) => g.index >= 0).map((g) => {
    const ext = Math.max(0, g.usedMB - g.leasedMB), freeMB = Math.max(0, g.totalMB - g.usedMB);
    const memPct = g.totalMB ? Math.round((g.usedMB / g.totalMB) * 100) : 0;
    const seg = (mb, cls) => g.totalMB ? `<i class="${cls}" style="width:${(mb / g.totalMB) * 100}%"></i>` : '';
    const procList = (g.activeProcs?.length ? g.activeProcs : g.procs) || [];
    const clkInfo = [g.pstate ? `${g.pstate}${/^P[358]$/i.test(g.pstate) ? ' (절전 유휴)' : ''}` : '', g.clockMHz ? `${g.clockMHz}${g.maxClockMHz ? '/' + g.maxClockMHz : ''} MHz` : ''].filter(Boolean).join(' · ');
    return `<div class="ucard">
      <div class="uh">${ICO.gpu}<b>${esc(g.server ? g.server + ' · ' : '')}GPU ${g.index} · ${esc(g.name)}</b>${g.exclusive ? '<span class="badge lim">전용 사용 중</span>' : ''}${g.host === 'local' ? sw(g.key, g.enabled !== false) : g.enabled === false ? '<span class="badge">서버 OFF</span>' : ''}</div>
      ${g.error ? `<div class="err" style="padding:0">${esc(g.error)}</div>` : `
      <div class="ugrp">
        <div class="um">
          <div class="umt"><span>GPU 코어 사용률</span><span class="up ${level(g.util)}">${g.util}%</span></div>
          ${bar(g.util)}
          ${clkInfo ? `<div class="ums">클럭 상태: ${esc(clkInfo)}</div>` : ''}
        </div>
        <div class="um">
          <div class="umt"><span>전용 GPU 메모리 (VRAM) · ${fmtMB(g.usedMB)} / ${fmtMB(g.totalMB)} (여유 ${fmtMB(freeMB)})</span><span class="up ${level(memPct)}">${memPct}%</span></div>
          ${g.leasedMB > 0
            ? `<span class="ubar gstack">${seg(Math.min(g.leasedMB, g.usedMB), 'lease')}${seg(ext, 'ext')}</span>
               <div class="ums"><span class="lg lease"></span>대기열 예약 ${fmtMB(g.leasedMB)} · <span class="lg ext"></span>그 외 사용 ${fmtMB(ext)}${g.pendingMB ? ` · 할당 대기 예약 ${fmtMB(g.pendingMB)}` : ''}</div>`
            : `${bar(memPct)}${g.reservedMB ? `<div class="ums">앱 할당 ${fmtMB(g.appUsedMB || (g.usedMB - g.reservedMB))} · 시스템/드라이버 예약 ${fmtMB(g.reservedMB)}</div>` : ''}`}
        </div>
      </div>
      <div class="ugrp">
        ${Number.isFinite(g.tempC) ? `<div class="umt"><span>온도 GPU ${g.tempC}°C${g.powerW != null ? ` · 소비 전력 ${g.powerW}W${g.powerLimitW ? ' / ' + g.powerLimitW + 'W' : ''}` : ''}${Number.isFinite(g.cpuC) ? ` · CPU ${g.cpuC}°C` : ''}</span><span class="up ${g.hot ? 'hi' : g.tempC >= 75 ? 'mid' : 'lo'}">${g.hot ? '과열 — 새 작업 보류' : '정상'}</span></div>` : ''}
        ${g.hot ? `<div class="err" style="padding:0">${esc(g.hotReason || '')} → 식을 때까지 새 작업을 배정하지 않음 (실행 중인 작업은 그대로)</div>` : ''}
        ${procList.length ? `<div class="ums">활성 GPU 연산 프로세스: ${procList.slice(0, 6).map((p) => `${esc(p.name)}${p.sm ? ` (코어 ${p.sm}%)` : ''}`).join(' · ')}</div>` : '<div class="ums">활성 GPU 연산 프로세스 없음</div>'}
        ${(() => { const ln = q.lanes?.[g.key]; if (!ln) return ''; const hm = (x) => new Date(x).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          return `<div class="umt"><span>이 GPU 대기열 ${ln.waiting.length}개${ln.headStart ? ` · 다음 시작 ~${hm(ln.headStart)}` : ''}</span><span class="ums">${ln.running ? (ln.freeBy ? `비는 시각 ~${hm(ln.freeBy)}` : '비는 시각 모름') : '대기 작업 없음'}</span></div>`; })()}
      </div>`}
    </div>`;
  }).join('');
  const row = (t, actions) => `<div class="swrow"><span class="swl" title="${esc(t.command || '')}"><b>${esc(t.label || t.id)}</b> <span class="badge">${esc(t.status === 'waiting' && t.lanes?.length ? t.lanes.join(' · ') : t.gpu)}</span> <span class="badge">${t.exclusive ? '전용' : t.memMB == null ? '메모리 측정 불가' : fmtMB(t.memMB)}</span>${t.adopted ? ' <span class="badge c">자동 등록</span>' : ''}<br>
    <span class="ums">${who(t)} · ${t.status === 'waiting'
      ? `대기 ${mins(t.waitedMs)} · 해당 GPU 줄 ${t.position}번째${t.expectedStart ? ` · 예상 시작 ${new Date(t.expectedStart).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}`
      : `사용 ${mins(Date.now() - t.grantedAt)}${t.expectedEnd ? ` · 예상 종료 ${new Date(t.expectedEnd).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${t.estSource === 'learned' ? ' (과거 기록)' : ''}` : ' · 예상 종료 모름'}`}${t.backfilled ? ' · 끼워넣기' : ''}</span></span>${actions}</div>`;
  const hist = (q.history || []).map((t) => `<div class="ums">${esc(new Date(t.endedAt).toLocaleTimeString())} · ${esc(t.label || t.id)} · ${t.status === 'released' ? '해제' : '취소'} (${esc(t.endReason || '')})</div>`).join('');
  $('#view').innerHTML = `${sysRow}<div class="ugrid">${cards || `<div class="err">${esc(q.error || 'GPU를 찾지 못함 (nvidia-smi)')}</div>`}</div>
    ${servers ? `<div class="rwrap" style="padding-bottom:0"><div class="rcard"><b>원격 서버</b>${servers}</div></div>` : ''}
    <div class="rwrap" style="padding-top:0">
      <div class="ums">끼워넣기: 맨 앞 작업이 들어갈 수 있는 예상 시각 전에 끝나거나, 그때도 자리를 남기는 작업만 먼저 실행합니다(예상 시간이 없는 작업은 순서대로 대기). 예상 시간은 ${ICO.clock} 버튼 또는 <code>--est 90m</code>.</div>
      <div class="rcard"><b>사용 중 (${q.active.length})</b><div class="ums">대기열 밖에서 시작된 GPU 작업도 자동으로 찾아 현재 사용자로 등록합니다. 작업이 끝나면 대기열이 순서대로 진행됩니다.</div>${q.active.map((t) => row(t, `<button data-gact="est" data-id="${t.id}" title="예상 종료 시각/시간 입력">${ICO.clock}</button><button data-gact="release" data-id="${t.id}" title="${t.adopted ? '대기열 등록만 해제 (프로세스는 계속 실행됨)' : '예약 해제'}">${t.adopted ? '등록 해제' : '해제'}</button>`)).join('') || '<div class="empty">없음</div>'}</div>
      <div class="rcard"><b>대기 (${q.waiting.length})</b>${q.waiting.map((t, i) => row(t, `<button data-gact="est" data-id="${t.id}" title="예상 실행 시간 입력">${ICO.clock}</button>${i ? `<button data-gact="top" data-id="${t.id}">맨 앞으로</button>` : ''}<button data-gact="release" data-id="${t.id}">취소</button>`)).join('') || '<div class="empty">없음</div>'}</div>
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
      const lang = l.slice(3).trim();
      const buf = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      out.push(`<div class="codeblk"><div class="codeblk-hd"><span>${esc(lang || 'code')}</span><button type="button" data-copy-code="1">${ICO.copy} 복사</button></div><pre class="mdpre">${esc(buf.join('\n'))}</pre></div>`); i++; continue;
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
  const pick = kind === 'synthesis' ? `<div><b>분석할 연구</b> (2개 이상)<div class="rsyn">${done.map((p) => `<label class="row" style="gap:6px"><input type="checkbox" value="${esc(p.slug)}" ${preset.includes(p.slug) || p.result === 'negative' || p.result === 'mixed' ? 'checked' : ''}> ${esc(p.name)} ${resultBadge(p)}</label>`).join('') || '<div class="empty">끝난 연구가 없습니다</div>'}</div></div>` : '';
  const body = `
    ${kind === 'derived' ? `<div class="empty" style="padding:0">기반: <b>${esc(base?.name || preset[0])}</b> ${base ? resultBadge(base) : ''} — 이 연구는 그대로 두고, 결과·실패 기록·코드를 이어받습니다.</div>` : '<div class="empty" style="padding:0">끝난 연구들의 결과(특히 음성 결과)를 비교·분석해 공통 원인과 교훈을 정리하는 논문입니다. 수치는 각 연구의 결과 파일에서만 가져옵니다.</div>'}
    ${pick}
    <label>프로젝트 이름<br><input id="lName" style="width:100%" value="${esc(kind === 'derived' ? (base?.name || '') + ' 후속' : '')}" placeholder="${kind === 'synthesis' ? '예: DT 재구성 접근들의 음성 결과 분석' : ''}"></label>
    <label>방향${kind === 'derived' ? ' (FINAL.md의 "다음 선택지"를 참고해 적거나, 비우면 디렉터가 제안 중에서 고릅니다)' : ''}<br><textarea id="lDir" rows="6" style="width:100%" placeholder="${kind === 'synthesis' ? '예) 세 연구가 공통으로 실패한 이유가 측정 기준 때문인지 방법 때문인지 밝히고, 언제 이 접근이 통하는지 정리' : '예) 음성 결과의 원인으로 보인 조명 변화만 통제한 조건에서 다시 검증'}"></textarea></label>
    <label>목표 학회·저널 (선택)<br><input id="lVenue" style="width:100%" placeholder="비우면 디렉터가 조사해 정합니다"></label>`;
  const d = openDrawer({ title: kind === 'synthesis' ? '종합 논문 만들기' : '파생 연구 만들기', bodyHTML: body, footerHTML: '<button data-drw-close>취소</button><button class="primary" id="lOk">만들고 시작</button>', width: 480 });
  $('#lOk', d).onclick = async () => {
    const parents = kind === 'synthesis' ? [...d.querySelectorAll('.rsyn input:checked')].map((x) => x.value) : preset;
    const dir = $('#lDir', d).value.trim() || (kind === 'derived' ? '기반 연구 FINAL.md의 "다음 선택지" 중 가장 유망한 방향을 골라 진행 (선택 이유를 DECISIONS.md에 기록)' : '');
    const payload = { name: $('#lName', d).value.trim(), direction: dir, venue: $('#lVenue', d).value.trim(), kind, parents };
    if (!payload.name || !payload.direction) return toast('이름과 방향을 입력하세요');
    if (kind === 'synthesis' && parents.length < 2) return toast('분석할 연구를 2개 이상 고르세요');
    $('#lOk', d).disabled = true;
    const r = await api('/api/research/new', { method: 'POST', body: payload });
    if (r.error) { $('#lOk', d).disabled = false; return toast(r.error, 6000); }
    d.close();
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
        <div class="empty" style="padding:0">디렉터 ${d.director ? `<span class="dot ${d.director.busy ? 'busy' : 'idle'}" style="display:inline-block;width:7px;height:7px;margin:0 4px 0 0;vertical-align:middle"></span>` + (d.director.busy ? '작업 중' : '대기') + ` · ${d.director.term ? 't:' + d.director.term : 'c:' + d.director.console}` : '<span class="dot dead" style="display:inline-block;width:7px;height:7px;margin:0 4px 0 0;vertical-align:middle"></span>실행 중 아님 (워치독이 자동 재개)'} · 시작 ${esc(d.created_at ? new Date(d.created_at).toLocaleDateString() : '-')} · 갱신 ${d.updated_at ? relTime(Date.parse(d.updated_at)) : '-'}</div>
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
        <div class="athumb">${f.kind === 'image' ? `<img loading="lazy" src="${rRawUrl(slug, f.path)}" alt="">` : `<span>${ART_ICON[f.kind] || ART_ICON.file}</span>`}</div>
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
      body = head + (Object.entries(groups).map(([g, fs]) => `<div class="rcard"><b>${esc(g)}</b>${fs.map(([f, i]) => `<div class="ofile" data-rout="${i}"><span>${ART_ICON[f.kind] || ART_ICON.file} ${esc(f.path.slice(g === '(루트)' ? 0 : g.length + 1))}</span><span class="empty">${fmtSize(f.size)} · ${relTime(f.mtime)}</span></div>`).join('')}</div>`).join('') || '<div class="empty" style="padding:16px">아직 산출물이 없습니다.</div>');
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
          <span class="r">${x.role === 'user' ? '사용자' : r.agent === 'codex' ? 'Codex' : r.agent === 'agy' ? 'Antigravity' : 'Claude'}</span><span class="x">${hl(x.snippet, terms)}</span></div>`).join('')}
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

// ---------- new terminal drawer ----------
function openNewTermDrawer() {
  const cwds = [...new Set([...state.live.map((s) => s.cwd), ...state.recent.map((r) => r.cwd)].filter(Boolean))].slice(0, 15);
  const body = `
    <div class="row"><label><input type="radio" name="k" value="claude" checked> claude</label>
      <label title="ChatGPT 계정(Codex 앱 로그인)으로 GPT 대화형 세션"><input type="radio" name="k" value="codex"> GPT (Codex)</label>
      <label title="Cursor 터미널 에이전트 (cursor-agent, 처음 한 번 cursor-agent login 필요)"><input type="radio" name="k" value="cursor"> Cursor</label>
      <label title="Antigravity CLI (agy)"><input type="radio" name="k" value="agy"> agy (Antigravity)</label>
      <label><input type="radio" name="k" value="powershell"> PowerShell</label>
      <label><input type="radio" name="k" value="cmd"> cmd</label>
      ${state.researchEnabled ? '<label><input type="radio" name="k" value="research"> 연구 디렉터 (자율)</label>' : ''}</div>
    <div id="nTerm" style="display:flex;flex-direction:column;gap:10px">
      <label>작업 폴더<br><input id="nCwd" list="cwdl" style="width:100%" value="${esc(cwds[0] || '')}" placeholder="비우면 홈 폴더">
        <datalist id="cwdl">${cwds.map((c) => `<option value="${esc(c)}">`).join('')}</datalist></label>
      <label class="row"><input type="checkbox" id="nSkip" checked> --dangerously-skip-permissions (claude만)</label>
    </div>
    <div id="nRes" hidden style="display:flex;flex-direction:column;gap:10px">
      <label>프로젝트 이름<br><input id="rName" style="width:100%" placeholder="예: 조명 변화에 강한 DT 3DGS"></label>
      <label>연구 방향<br><textarea id="rDir" rows="7" style="width:100%" placeholder="예) 공장 디지털트윈에서 조명이 바뀌어도 3DGS 재구성이 흔들리지 않게 하고 싶다. 가진 것: CAD 모델, Replica 데이터, RTX 4090 1장. 원하는 기여: …  기간: 11월 중순 투고"></textarea></label>
      <label>목표 학회·저널 (선택)<br><input id="rVenue" style="width:100%" placeholder="비우면 디렉터가 조사해 정합니다 — 예: CVPR 2027"></label>
      <label>어디까지 진행할까요?<br><select id="rGoal" style="width:100%">${Object.entries(GOAL_KO).map(([k, v]) => `<option value="${k}" ${k === 'P9_review' ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
      <div class="rban ok" style="margin:0"><b>중간에 묻지 않고 목표까지 알아서 진행합니다.</b> 환경 설치·데이터 받기·테스트도 스스로 합니다. 진행할 수 없는 문제가 생겼을 때만 멈추고 알려드립니다.</div>
    </div>`;
  const d = openDrawer({ title: '새로 열기', bodyHTML: body, footerHTML: '<button data-drw-close>취소</button><button id="nExt" title="이 PC의 새 Windows 콘솔 창(외부 터미널)에서 엽니다">외부 창으로 열기</button><button class="primary" id="nOk">대시보드에서 열기</button>', width: 480 });
  const kindOf = () => $('input[name=k]:checked', d).value;
  d.querySelectorAll('input[name=k]').forEach((r) => (r.onchange = () => {
    const isRes = kindOf() === 'research';
    $('#nTerm', d).style.display = isRes ? 'none' : 'flex';
    $('#nRes', d).style.display = isRes ? 'flex' : 'none';
    const extBtn = $('#nExt', d);
    if (extBtn) extBtn.style.display = isRes ? 'none' : '';
  }));
  $('#nRes', d).style.display = 'none';
  $('#nExt', d).onclick = async () => {
    const kind = kindOf();
    if (kind === 'research') return;
    $('#nExt', d).disabled = true;
    const r = await api('/api/term/external', { method: 'POST', body: { kind, cwd: $('#nCwd', d).value, skipPermissions: $('#nSkip', d).checked } });
    $('#nExt', d).disabled = false;
    if (r.error) return toast(r.error, 6000);
    d.close();
    toast('외부 Windows 콘솔 창에서 열었습니다');
    setTimeout(refreshOverview, 1200);
  };
  $('#nOk', d).onclick = async () => {
    const kind = kindOf();
    if (kind === 'research') {
      const payload = { name: $('#rName', d).value.trim(), direction: $('#rDir', d).value.trim(), venue: $('#rVenue', d).value.trim(), goal: $('#rGoal', d).value };
      if (!payload.name || !payload.direction) return toast('프로젝트 이름과 연구 방향을 입력하세요');
      $('#nOk', d).disabled = true;
      const r = await api('/api/research/new', { method: 'POST', body: payload });
      if (r.error) { $('#nOk', d).disabled = false; return toast(r.error, 6000); }
      d.close();
      await Promise.all([refreshOverview(), refreshResearch()]);
      return select({ kind: 'research', id: r.slug });
    }
    const t = await api('/api/term/new', { method: 'POST', body: { kind, cwd: $('#nCwd', d).value, skipPermissions: $('#nSkip', d).checked } });
    d.close();
    await refreshOverview();
    select({ kind: 'term', id: t.id });
  };
}

// ---------- desktop sidebar collapse ----------
function setSideCollapsed(on) {
  document.body.classList.toggle('side-collapsed', !!on);
  try { localStorage.setItem('ach-side-collapsed', on ? '1' : ''); } catch {}
  setTimeout(() => window.dispatchEvent(new Event('resize')), 200);
}
try { if (localStorage.getItem('ach-side-collapsed') === '1') document.body.classList.add('side-collapsed'); } catch {}
document.addEventListener('click', (e) => {
  if (e.target.closest('#btnSideToggle')) setSideCollapsed(!document.body.classList.contains('side-collapsed'));
});

// ---------- mobile drawer + "open on phone" ----------
$('#btnMenu').onclick = () => document.body.classList.toggle('drawer');
$('#backdrop').onclick = () => document.body.classList.remove('drawer');
$('#btnHome2').onclick = () => select({ kind: 'home' });
$('#brandHome').onclick = () => select({ kind: 'home' });
$('.mtop b').onclick = () => select({ kind: 'home' });
$('.mtop b').style.cursor = 'pointer';
// language: English / 한국어 (saved on the server; it restarts itself, terminals stay open)
$('#btnLang').onclick = async () => {
  const next = (window.__ACH_LANG || (await api('/api/lang').catch(() => ({}))).lang) === 'en' ? 'ko' : 'en';
  if (!confirm(next === 'en' ? 'Switch to English? The hub restarts (terminals stay open).' : '한국어로 바꿀까요? 허브가 다시 시작됩니다 (터미널은 그대로).')) return;
  await api('/api/lang', { method: 'POST', body: { lang: next } }).catch(() => {});
  toast(next === 'en' ? 'Restarting in English…' : '한국어로 다시 시작하는 중…', 8000);
  setTimeout(() => location.reload(), 4000);
};
$('#btnPhone').onclick = async () => {
  const d = openDrawer({ title: '다른 기기에서 열기 (휴대폰 · 다른 PC)', bodyHTML: '<div id="phoneBody">확인 중…</div>', footerHTML: '<button data-drw-close>닫기</button>', width: 460 });
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
  await Promise.all([refreshOverview(), refreshRecent(), refreshUsage(), refreshResearch(), typeof loadCalendar === 'function' ? loadCalendar() : Promise.resolve()]);
  setInterval(whenShown(() => typeof loadCalendar === 'function' && loadCalendar()), 300000);
  booted = true;
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
  else {
    let restored = null;
    try {
      const hm = /^#([a-z]+)(?::([^:]+)(?::([a-z]+))?)?$/.exec(location.hash || '');
      const fromHash = hm ? { sel: hm[2] ? { kind: hm[1], id: hm[2] } : { kind: hm[1] }, tab: hm[3] || undefined } : null;
      const saved = fromHash || JSON.parse(localStorage.getItem('ach-last-sel') || 'null');
      const s = saved?.sel;
      if (s && ['home', 'terms', 'usage', 'calendar', 'gpu', 'recent', 'research'].includes(s.kind)) restored = saved;
      else if (s?.kind === 'term' && state.terms.some((t) => String(t.id) === String(s.id))) restored = saved;
      else if (s?.kind === 'console' && state.consoles.some((c) => String(c.id) === String(s.id))) restored = saved;
    } catch {}
    if (restored) select(restored.sel, restored.tab);
    else select({ kind: 'home' });
  }
  setInterval(whenShown(refreshOverview), 4000);
  setInterval(whenShown(refreshRecent), 10000);
})();
