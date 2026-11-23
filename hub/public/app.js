// Agent CLI Hub — frontend
const qs = new URLSearchParams(location.search);
let TOKEN = qs.get('t') || '';
try { if (TOKEN) localStorage.setItem('ccd-token', TOKEN); else TOKEN = localStorage.getItem('ccd-token') || ''; } catch {}
// opened on this PC (127.0.0.1/localhost): the server put the token into the page — any browser profile works
if (window.__CCD_LOCAL_TOKEN && TOKEN !== window.__CCD_LOCAL_TOKEN) { TOKEN = window.__CCD_LOCAL_TOKEN; try { localStorage.setItem('ccd-token', TOKEN); } catch {} }
if (qs.get('t')) { qs.delete('t'); history.replaceState(null, '', '/' + (qs.toString() ? '?' + qs : '')); }

const $ = (s, el = document) => el.querySelector(s);
const uiLocale = () => (document.documentElement.lang === 'en' ? 'en-US' : 'ko-KR');
const isEnUI = () => document.documentElement.lang === 'en';
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
let activeBuildId = null;
let updateNoticeShown = false;
const state = {
  sel: { kind: 'home' }, tab: 'screen', showHidden: false, favs: new Set(), showDesktop: (() => { try { return !!localStorage.getItem('ccd-show-desktop'); } catch { return false; } })(),
  live: [], consoles: [], terms: [], recent: [], projects: [], err: null,
  usage: null, research: [], gpu: null, services: null, hubDown: false,
  termFilter: '', termsTab: 'active', termsView: 'cards', recentQuery: '', sysTab: 'usage',
  usageFilter: 'all', usageSort: 'headroom-desc', gpuTab: 'queue', rActSub: 'timeline',
  filter: '', sideFilter: '', search: { q: '', role: 'all', cwd: '', auto: false, screens: true },
  unreadTerms: new Set(), justDoneTerms: new Set(),
  termGroupByProject: (() => { try { return localStorage.getItem('ach-term-group') === '1'; } catch { return false; } })(),
  notifyEnabled: (() => { try { return localStorage.getItem('ach-notify') === '1'; } catch { return false; } })(),
};
const prevTermStates = new Map();
let lastFaviconKey = '';
function updateDynamicFavicon(tone) {
  const dotMap = { ok: '#4ade80', warn: '#fbbf24', down: '#f87171' };
  const dot = dotMap[tone] || dotMap.ok;
  const unread = state.unreadTerms.size;
  const key = `${tone}:${unread > 0 ? 1 : 0}`;
  if (key === lastFaviconKey) return;
  lastFaviconKey = key;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">`
    + `<rect width="64" height="64" rx="15" fill="#161922"/>`
    + `<path d="M32 29 L18 18 M32 29 L46 18 M32 29 L32 47" stroke="#f8fafc" stroke-width="4.5" stroke-linecap="round"/>`
    + `<circle cx="18" cy="18" r="5" fill="#f8fafc"/>`
    + `<circle cx="46" cy="18" r="5" fill="#f8fafc"/>`
    + `<circle cx="32" cy="47" r="5" fill="#f8fafc"/>`
    + `<circle cx="32" cy="29" r="7.5" fill="#e07a54" stroke="#161922" stroke-width="2.5"/>`
    + `<circle cx="51" cy="51" r="12" fill="#161922"/>`
    + `<circle cx="51" cy="51" r="8.5" fill="${dot}"/>`
    + (unread > 0 ? `<circle cx="13" cy="13" r="8.5" fill="#3b82f6" stroke="#161922" stroke-width="2.5"/>` : '')
    + `</svg>`;
  const link = document.querySelector('link[rel="icon"]');
  if (link) link.href = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
function computeHubHealth() {
  const hubOk = !state.hubDown;
  const srv = state.services || {};
  const usageOk = hubOk && (srv.usage ? !!srv.usage.ok : (state.usage ? !!state.usage.available : true));
  const ptyOk = hubOk && (srv.ptyHost ? !!srv.ptyHost.ok : true);
  const agyOk = hubOk && !!(state.agyQuota?.groups?.length || srv.agyQuota?.ok);
  const tone = !hubOk ? 'down' : (!usageOk || !ptyOk) ? 'warn' : 'ok';
  return { hubOk, usageOk, ptyOk, agyOk, tone };
}
function paintBrandStatus() {
  const { hubOk, usageOk, ptyOk, tone } = computeHubHealth();
  updateDynamicFavicon(tone);
  for (const [markId, ledId, subId] of [['brandMark', 'brandLed', 'brandSub'], ['mBrandMark', 'mBrandLed', 'mBrandSub']]) {
    const mark = document.getElementById(markId);
    const led = document.getElementById(ledId);
    const sub = document.getElementById(subId);
    if (mark) mark.className = `brand-mark st-${tone}`;
    if (led) led.className = `brand-led${tone === 'ok' ? '' : ' ' + tone}`;
    if (sub) {
      sub.innerHTML = !hubOk
        ? `<span class="srv-pip down"><i></i>허브 연결 끊김</span>`
        : `<span class="srv-pip ${ptyOk ? 'ok' : 'warn'}"><i></i>허브 ON</span><span>·</span><span class="srv-pip ${usageOk ? 'ok' : 'warn'}"><i></i>사용량 ${usageOk ? 'ON' : 'OFF'}</span>`;
    }
  }
  const btn = document.getElementById('brandHome');
  if (btn) {
    btn.title = !hubOk
      ? '허브 서버(7777)와 연결이 끊어졌습니다 (클릭해 상태 확인)'
      : `허브 서버(7777): 실행 중 · AI 사용량 서버(4777): ${usageOk ? '실행 중' : '꺼짐 — 클릭하여 켜기'}`;
  }
  const pop = document.getElementById('srvStatusPop');
  if (pop) paintServerStatusPopover(pop);
}
function paintServerStatusPopover(pop) {
  const { hubOk, usageOk, ptyOk, agyOk } = computeHubHealth();
  const srv = state.services || {};
  const activeTerms = (state.terms || []).filter((t) => t.exited === null).length;
  const busyTerms = (state.terms || []).filter((t) => termStateOf(t) === 'busy').length;
  const swapAccs = state.agySwapAccounts || [];
  const activeSwap = swapAccs.find((a) => a.active);
  const agySelectHTML = swapAccs.length > 1
    ? `<select id="popAgySwap" class="btn-sm" style="max-width:136px" aria-label="Antigravity 활성 계정 전환">${swapAccs.map((a) => `<option value="${esc(a.email)}" ${a.active ? 'selected' : ''}>${a.active ? '● ' : ''}${esc(a.name || a.email.replace(/@.*/, ''))}</option>`).join('')}</select>`
    : `<span class="badge ${agyOk ? 'ok' : ''}">${agyOk ? 'ON' : 'READY'}</span>`;
  pop.innerHTML = `
    <div class="srv-pop-hd">
      <span>서버 및 연동 상태</span>
      <span class="badge ${hubOk && usageOk ? 'ok' : !hubOk ? 'lim' : 'warn'}">${!hubOk ? '연결 끊김' : usageOk ? '정상 가동' : '일부 꺼짐'}</span>
    </div>
    <div class="srv-row">
      <div class="srv-row-l"><span class="dot ${hubOk ? 'idle' : 'dead'}" style="${hubOk ? '' : 'border-color:var(--danger);background:var(--danger)'}"></span><div><b>허브 서버 (:7777)</b><div class="srv-row-sub">${hubOk ? `실행 중 · 터미널 ${activeTerms}개 (작업 중 ${busyTerms})` : '오프라인 — start.bat 또는 ccd up 실행'}</div></div></div>
      <span class="badge ${hubOk ? 'ok' : 'lim'}">${hubOk ? 'ON' : 'OFF'}</span>
    </div>
    <div class="srv-row">
      <div class="srv-row-l"><span class="dot ${ptyOk ? 'idle' : 'busy'}"></span><div><b>터미널 호스트 (PTY)</b><div class="srv-row-sub">${ptyOk ? `정상 연결됨${srv.ptyHost?.pid ? ` (PID ${srv.ptyHost.pid})` : ''}` : '재연결 대기 중'}</div></div></div>
      <span class="badge ${ptyOk ? 'ok' : 'warn'}">${ptyOk ? 'ON' : 'WAIT'}</span>
    </div>
    <div class="srv-row">
      <div class="srv-row-l"><span class="dot ${usageOk ? 'idle' : 'busy'}"></span><div><b>AI 사용량 서버 (:4777)</b><div class="srv-row-sub">${usageOk ? 'Claude · Codex 한도 실시간 연동 중' : '꺼져 있음 — 아래 버튼으로 즉시 시작'}</div></div></div>
      ${usageOk
        ? '<span class="badge ok">ON</span>'
        : '<button type="button" class="primary btn-sm" id="btnStartUsageSrv">지금 켜기</button>'}
    </div>
    <div class="srv-row">
      <div class="srv-row-l"><span class="dot ${agyOk ? 'idle' : 'dead'}"></span><div><b>Antigravity 쿼터</b><div class="srv-row-sub">${esc(activeSwap?.email || state.agyQuota?.account || srv.agyQuota?.account || (state.agyRefreshing ? '조회 중…' : '대기 중'))}</div></div></div>
      ${agySelectHTML}
    </div>
    <div class="row" style="justify-content:space-between;padding-top:6px;border-top:1px solid var(--line);gap:6px">
      <button type="button" class="btn-sm" id="btnPopHome">${ICO.home} 홈으로</button>
      <div class="row" style="gap:4px">
        <button type="button" class="btn-sm" id="btnPopTray" title="Windows 작업 표시줄 트레이에 허브 상태 아이콘 띄우기">트레이 아이콘</button>
        <button type="button" class="btn-sm" id="btnPopUsage">${ICO.chart} 사용량 보기</button>
      </div>
    </div>`;
  const startBtn = pop.querySelector('#btnStartUsageSrv');
  if (startBtn) {
    startBtn.onclick = async (e) => {
      e.stopPropagation();
      startBtn.disabled = true;
      startBtn.textContent = '시작 중…';
      try {
        const r = await api('/api/services/usage/start', { method: 'POST', body: {} });
        if (!r.ok) throw new Error(r.error || '시작 실패');
        toast('AI 사용량 서버(:4777)를 시작했습니다');
        await Promise.all([refreshOverview(), refreshUsage(true)]);
      } catch (er) {
        toast(er.message, 5000, 'danger');
        if (startBtn.isConnected) { startBtn.disabled = false; startBtn.textContent = '지금 켜기'; }
      }
    };
  }
  const popAgySel = pop.querySelector('#popAgySwap');
  if (popAgySel) {
    popAgySel.onclick = (e) => e.stopPropagation();
    popAgySel.onchange = async () => {
      popAgySel.disabled = true;
      await switchAgyAccount(popAgySel.value);
      if (pop.isConnected) paintServerStatusPopover(pop);
    };
  }
  const homeBtn = pop.querySelector('#btnPopHome');
  if (homeBtn) homeBtn.onclick = () => { pop.remove(); select({ kind: 'home' }); };
  const usageBtn = pop.querySelector('#btnPopUsage');
  if (usageBtn) usageBtn.onclick = () => { pop.remove(); select({ kind: 'usage' }); };
  const trayBtn = pop.querySelector('#btnPopTray');
  if (trayBtn) {
    trayBtn.onclick = async () => {
      trayBtn.disabled = true;
      await api('/api/services/tray', { method: 'POST', body: {} }).catch(() => {});
      toast('Windows 작업 표시줄 트레이에 허브 상태 아이콘을 실행했습니다');
      trayBtn.disabled = false;
    };
  }
}
function toggleServerStatusPopover(anchor) {
  const existing = document.getElementById('srvStatusPop');
  if (existing) { existing.remove(); return; }
  const pop = document.createElement('div');
  pop.id = 'srvStatusPop';
  pop.className = 'srv-pop';
  paintServerStatusPopover(pop);
  document.body.appendChild(pop);
  if (anchor) {
    const r = anchor.getBoundingClientRect();
    pop.style.top = `${Math.round(r.bottom + 6)}px`;
    pop.style.left = `${Math.max(8, Math.round(r.left))}px`;
  }
  const onDoc = (e) => {
    if (pop.contains(e.target) || anchor?.contains(e.target)) return;
    document.removeEventListener('click', onDoc, true);
    pop.remove();
  };
  setTimeout(() => document.addEventListener('click', onDoc, true), 0);
}
function updateDocTitle() {
  const n = state.unreadTerms.size;
  const { hubOk } = computeHubHealth();
  document.title = !hubOk
    ? '⚠ [연결 끊김] Agent CLI Hub'
    : n
      ? `(${n}) Agent CLI Hub`
      : 'Agent CLI Hub';
  paintBrandStatus();
}
async function refreshProjects() {
  try {
    const r = await api('/api/projects');
    if (Array.isArray(r.projects)) state.projects = r.projects;
    if (r.defaultCwd) state.defaultProjectCwd = r.defaultCwd;
  } catch {}
  renderSide();
}
window.refreshProjects = refreshProjects;
let viewTimer = null, viewGen = 0, xterm = null, xws = null, minis = [], homeKey = '';

function fmtTok(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return String(v);
}
window.fmtTok = fmtTok;

function fireTermDoneNotice(t, nextState) {
  const id = String(t.id);
  const label = termLabel(t);
  const pj = projectOfTerm(t);
  const task = pj && t.projectTask?.taskId ? (pj.tasks || []).find((x) => x.id === t.projectTask.taskId) : null;
  const viewing = state.sel.kind === 'term' && String(state.sel.id) === id;
  state.justDoneTerms.add(id);

  if (viewing) {
    const wrap = $('#termwrap');
    if (wrap) {
      wrap.classList.remove('term-done-flash');
      void wrap.offsetWidth;
      wrap.classList.add('term-done-flash');
    }
    paintActiveTermStatus();
  } else {
    state.unreadTerms.add(id);
    updateDocTitle();
  }

  const msg = nextState === 'exited' ? `터미널 종료됨: ${label}` : `✓ 작업 완료: ${label}`;
  const action = (pj && task && task.stage === 'doing')
    ? {
      label: '검토로 이동',
      onClick: async () => {
        try {
          const r = await api('/api/projects');
          const curP = (r.projects || []).find((x) => x.id === pj.id);
          if (!curP) return;
          const nextTasks = curP.tasks.map((x) => (x.id === task.id ? { ...x, stage: 'review' } : x));
          await api('/api/projects', { method: 'POST', body: { ...curP, tasks: nextTasks } });
          await refreshProjects();
          if (state.sel.kind === 'projects' && (state.sel.id === curP.id || projectId === curP.id)) openProject(curP.id);
          toast(`“${task.title}”을(를) 검토 단계로 이동했습니다`);
        } catch (e) { toast(e.message, 4000, 'danger'); }
      },
      onBodyClick: !viewing ? () => select({ kind: 'term', id }) : null,
    }
    : (!viewing ? { label: '열기', onClick: () => select({ kind: 'term', id }), onBodyClick: () => select({ kind: 'term', id }) } : null);
  toast(msg, 6500, 'default', action);

  if (!viewing && state.notifyEnabled && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    try {
      const n = new Notification('Agent CLI Hub', { body: msg, tag: `term-${id}` });
      n.onclick = () => { window.focus(); select({ kind: 'term', id }); n.close(); };
    } catch {}
  }
}

function paintActiveTermStatus() {
  const pill = $('#termLiveBadge');
  if (!pill || state.sel.kind !== 'term') return;
  const t = state.terms.find((x) => String(x.id) === String(state.sel.id));
  if (!t) return;
  const st = termStateOf(t);
  const justDone = st === 'idle' && state.justDoneTerms.has(String(t.id));
  pill.className = `term-live-pill ${st === 'busy' ? 'busy' : justDone ? 'done' : st === 'exited' ? 'exited' : 'idle'}`;
  pill.innerHTML = st === 'busy'
    ? '<span class="dot busy" style="width:6px;height:6px"></span>실행 중'
    : justDone
      ? `${ICO.check} 작업 완료`
      : st === 'exited'
        ? `<span class="dot dead" style="width:6px;height:6px"></span>종료됨 (${t.exited})`
        : '대기';
}

// ---------- data ----------
async function refreshOverview() {
  try {
    const o = await api('/api/overview');
    if (o.buildId) {
      if (activeBuildId && o.buildId !== activeBuildId) {
        const ae = document.activeElement;
        const isTyping = !!(ae && (ae.matches('input, textarea') && ae.value) || ae?.classList?.contains('xterm-helper-textarea'));
        const isLiveTerm = (state.sel.kind === 'term' && ['screen', 'split', 'dock'].includes(state.tab)) || state.sel.kind === 'console';
        if (!isLiveTerm && !isTyping) {
          toast('허브가 업데이트되어 새 화면을 불러옵니다…', 1500);
          setTimeout(() => location.reload(), 350);
          return;
        }
        if (!updateNoticeShown) {
          updateNoticeShown = true;
          toast('허브 서버가 업데이트되었습니다. 새 UI를 적용하려면 새로고침하세요.', 60000, 'default', {
            label: '지금 새로고침',
            onClick: () => location.reload(),
          });
        }
      }
      activeBuildId = o.buildId;
    }
    Object.assign(state, { live: o.live || [], consoles: o.consoles || [], terms: o.terms || [], err: o.consoleError || null, services: o.services || state.services, hubDown: false });
    if (Array.isArray(o.favs)) state.favs = new Set(o.favs);
    state.disk = o.disk || null;
    state.consolesOff = !!o.consolesOff;
  } catch (e) {
    state.err = e.message;
    state.hubDown = true;
  }

  // Detect busy → idle / exited transitions for subtle completion indicator & notification
  const aliveIds = new Set();
  for (const t of state.terms) {
    const id = String(t.id);
    aliveIds.add(id);
    const cur = termStateOf(t);
    const prev = prevTermStates.get(id);
    if (cur === 'busy') state.justDoneTerms.delete(id);
    if (booted && prev === 'busy' && (cur === 'idle' || cur === 'exited')) {
      fireTermDoneNotice(t, cur);
    }
    prevTermStates.set(id, cur);
  }
  for (const id of [...prevTermStates.keys()]) if (!aliveIds.has(id)) { prevTermStates.delete(id); state.unreadTerms.delete(id); state.justDoneTerms.delete(id); }
  updateDocTitle();
  paintActiveTermStatus();
  renderSide();
  if (booted && (state.sel.kind === 'home' || state.sel.kind === 'terms') && homeKeyOf() !== homeKey) select({ kind: state.sel.kind });
  else refreshHomeWidgets();
}
async function refreshRecent(fresh = false) {
  try { state.recent = (await api(`/api/recent?n=100${fresh ? '&fresh=1' : ''}`)).sessions || []; } catch {}
  const agent = state.recentFilter;
  if (agent) {
    try {
      state.recentByAgent ||= {};
      state.recentByAgent[agent] = (await api(`/api/recent?n=100&agent=${encodeURIComponent(agent)}`)).sessions || [];
    } catch {}
  }
  renderSide();
  refreshHomeWidgets();
}

const consoleOf = (pid) => state.consoles.find((c) => c.pids.includes(pid));
const sessionOfConsole = (c) => state.live.find((s) => c.pids.includes(s.pid));
// claude sets its terminal title to the session name ("✳ task"); strip the status glyph
const stripGlyph = (s) => String(s || '').replace(/^[^\p{L}\p{N}]+\s*/u, '');
const providerName = agent => ({ claude: 'Claude Code', codex: 'Codex', agy: 'Antigravity CLI', cursor: 'Cursor' })[agent] || '터미널';
function recentSession(id) {
  if (!id) return undefined;
  return state.recent.find(r => r.sessionId === id)
    || Object.values(state.recentByAgent || {}).flat().find(r => r.sessionId === id)
    || state.search.sessions?.find(r => r.sessionId === id);
}
function windowTitle(raw) {
  const title = String(raw || '').trim();
  if (/^(?:[a-z]:[\\/]|\\\\|\/)|\.(?:exe|cmd|bat|ps1)$|^(?:claude(?: code)?|codex|agy|antigravity(?: cli)?|cursor(?: agent)?|(?:windows )?powershell|cmd|windows terminal)$/i.test(title)) return '';
  return cleanSideTitle(stripGlyph(title));
}
function termLabel(t) {
  if (t.operator) return '관제 세션';
  if (t.projectTask) return t.title;
  const session = recentSession(t.sessionId || (t.agy && state.sel.kind === 'term' && state.sel.id === t.id ? state.sel.agyResume : null));
  const con = t.pid && state.consoles.find(c => c.managed && (c.pids || []).includes(t.pid));
  const label = cleanSideTitle(session?.title) || cleanSideTitle(session?.firstPrompt)
    || cleanSideTitle(t.sessionName) || windowTitle(con?.title) || windowTitle(t.liveTitle);
  if (label) return label;
  const title = String(t.title || '');
  if (/^(?:powershell|pwsh)(?:\.exe)?$/i.test(title)) return 'PowerShell';
  if (/^cmd(?:\.exe)?$/i.test(title)) return 'Command Prompt';
  return (/^(?:agy |codex resume |claude resume )[\da-f-]+$/i.test(title) ? '' : windowTitle(title)) || providerName(t.agent);
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

const ICO = window.UI_ICO || {};
window.ICO = ICO;

// Canonical terminal & console state for status filter tabs: 'busy' (실행 중) | 'idle' (대기) | 'exited' (종료됨)
function termStateOf(t) {
  if (!t || t.exited !== null || t.status === 'exited') return 'exited';
  const s = t.pid && state.live.find((x) => consoleOf(x.pid)?.pids.includes(t.pid));
  const st = s ? s.status : t.status;
  return st === 'busy' ? 'busy' : 'idle';
}
function consoleStateOf(c) {
  const s = sessionOfConsole(c);
  return s?.status === 'busy' ? 'busy' : 'idle';
}
function termStatusLabel(t) {
  const st = termStateOf(t);
  return st === 'exited' ? `종료됨 (${t.exited})` : st === 'idle' ? '대기' : '실행 중';
}
const STATE_RANK = { busy: 0, idle: 1, exited: 2 };
function sortTermsByState(list) {
  return [...list].sort((a, b) => (STATE_RANK[termStateOf(a)] ?? 9) - (STATE_RANK[termStateOf(b)] ?? 9));
}
function sortConsolesByState(list) {
  return [...list].sort((a, b) => (STATE_RANK[consoleStateOf(a)] ?? 9) - (STATE_RANK[consoleStateOf(b)] ?? 9));
}
function projectOfTerm(t) {
  if (!t) return null;
  const pid = t.projectTask?.projectId;
  if (pid) return (state.projects || []).find((p) => p.id === pid) || null;
  return (state.projects || []).find((p) => (p.termIds || []).includes(t.id)) || null;
}
function termKindLabel(t) {
  if (t.operator) return '관제';
  if (t.agent === 'claude') return '터미널 · Claude';
  if (t.agent === 'codex') return '터미널 · Codex';
  if (t.agent === 'agy') return '터미널 · AGY';
  if (t.agent === 'cursor') return '터미널 · Cursor';
  return '셸 터미널';
}

// ---------- TopNav & shared session helpers ----------
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
  return ['home', 'terms', 'projects', 'search', 'usage', 'gpu', 'calendar', 'vault'].includes(s.kind) ? s.kind : `${s.kind}:${s.id}`;
}
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
const cleanSideTitle = (s) => {
  const t = String(s || '')
    .replace(/<(external_codex_apps_[\w-]+|environment_context|user_instructions|skills_instructions|permissions|collaboration_mode|model_instructions|INSTRUCTIONS)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .trim();
  const lines = t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const l of lines) {
    if (/^#{1,6}\s*(?:Referenced ChatGPT|Files mentioned by the user|Context from|Active file|Open files|AGENTS\.md)/i.test(l)) return '';
    if (/^<\/?[a-z_][\w-]*[^>]*>/i.test(l)) continue;
    if (/^(?:계속 진행해(?:\s*주세요)?|keep going|continue)[.!?\s]*(?:⇄.*)?$/i.test(l)) continue;
    return l.replace(/^#{1,6}\s+/, '').slice(0, 120);
  }
  return '';
};
const sessionLabel = (r, id = r?.sessionId, liveName = '') =>
  cleanSideTitle(r?.title) || cleanSideTitle(r?.firstPrompt) || cleanSideTitle(liveName)
  || [providerName(r?.agent || 'claude'), id?.slice(0, 8)].filter(Boolean).join(' · ');

function branchTooltip(br) {
  if (!br) return '';
  const parts = [];
  if (br.isBranch) parts.push(`원본: ${br.parentTitle || br.parentSessionId?.slice(0, 8) || '대화'}${br.atIndex != null ? ` (#${br.atIndex + 1})` : ''}`);
  if (br.childCount > 0) parts.push(`이 대화에서 파생된 분기 ${br.childCount}개`);
  return parts.join(' · ');
}

function branchTagHTML(br, compact = false) {
  if (!br) return '';
  const cls = compact ? 'srow-tag' : 'badge';
  const tip = branchTooltip(br);
  const out = [];
  if (br.isBranch) {
    out.push(`<span class="${cls} branch"${tip ? ` title="${esc(tip)}"` : ''}>${ICO.branch} 분기</span>`);
  }
  if (br.childCount > 0) {
    const srcTip = `이 대화에서 파생된 분기 ${br.childCount}개`;
    out.push(`<span class="${cls} branch-src" title="${esc(srcTip)}">${ICO.branch} ${br.childCount}</span>`);
  }
  return out.join('');
}

// ---------- Linear-Style Minimal Workspace Sidebar (Projects + Terminals + Recent; System Grouped) ----------
function systemTopHTML(activeTab, actionsHTML = '') {
  state.sysTab = ['usage', 'gpu', 'vault'].includes(activeTab) ? activeTab : 'usage';
  const gpuWait = state.gpu?.waiting?.length || 0;
  const tab = (id, icon, label, badge = '') =>
    `<button role="tab" data-systab="${id}" aria-selected="${activeTab === id}" class="${activeTab === id ? 'on' : ''}">${icon} ${label}${badge}</button>`;
  return `<div class="sys-top">
    <div class="tablist" role="tablist" aria-label="설정 메뉴">
      ${tab('usage', ICO.chart, 'AI 사용량')}
      ${tab('gpu', ICO.gpu, 'GPU 대기열', gpuWait ? ` <span class="badge lim" style="margin-left:3px">${gpuWait}</span>` : '')}
      ${tab('vault', ICO.layers, '공통 자원')}
    </div>
    ${actionsHTML ? `<div class="sys-acts">${actionsHTML}</div>` : ''}
  </div>`;
}
window.systemTopHTML = systemTopHTML;

function sideFolded() {
  try { return new Set(JSON.parse(localStorage.getItem('ach-sec-fold') || '[]')); } catch { return new Set(); }
}
function toggleSideFold(sec) {
  const s = sideFolded();
  if (s.has(sec)) s.delete(sec); else s.add(sec);
  try { localStorage.setItem('ach-sec-fold', JSON.stringify([...s])); } catch {}
  renderSide();
}
const foldBtnHTML = (sec, isFolded, label) => {
  const foldAria = isEnUI() ? `${isFolded ? 'Expand' : 'Collapse'} ${label}` : `${label} ${isFolded ? '펼치기' : '접기'}`;
  return `<button class="ghost icon-btn ssec-fold" data-sec-fold="${sec}" aria-expanded="${!isFolded}" aria-label="${esc(foldAria)}" title="${esc(foldAria)}">${isFolded ? ICO.chevRight : ICO.chevDown}</button>`;
};

function resolvedFavs() {
  const favs = state.favs || new Set();
  const rawKeys = [...favs];
  // Group keys that resolve to the same live sessionId so duplicate terminals (or exited term + sid)
  // never appear twice in the Favorites section. Prefer a live non-exited terminal.
  const bestTermBySid = new Map();
  const keysBySid = new Map();
  for (const fk of rawKeys) {
    if (fk.startsWith('term:')) {
      const t = (state.terms || []).find((x) => String(x.id) === fk.slice(5));
      if (!t) continue;
      if (t.sessionId) {
        (keysBySid.get(t.sessionId) || keysBySid.set(t.sessionId, []).get(t.sessionId)).push(fk);
        const cur = bestTermBySid.get(t.sessionId);
        if (!cur || (cur.exited !== null && t.exited === null)) bestTermBySid.set(t.sessionId, t);
      }
    } else if (fk.startsWith('sid:')) {
      const sid = fk.slice(4);
      (keysBySid.get(sid) || keysBySid.set(sid, []).get(sid)).push(fk);
      const liveT = (state.terms || []).find((x) => x.sessionId === sid && x.exited === null);
      if (liveT) {
        const cur = bestTermBySid.get(sid);
        if (!cur || (cur.exited !== null && liveT.exited === null)) bestTermBySid.set(sid, liveT);
      }
    }
  }

  const out = [];
  const seen = new Set();
  const seenSid = new Set();
  for (const fk of rawKeys) {
    if (fk.startsWith('proj:')) {
      const p = (state.projects || []).find((x) => x.id === fk.slice(5));
      if (!p) continue;
      const uid = `proj:${p.id}`;
      if (seen.has(uid)) continue;
      seen.add(uid);
      out.push({ key: fk, allKeys: [fk], kind: 'proj', item: p });
    } else if (fk.startsWith('term:')) {
      const t = (state.terms || []).find((x) => String(x.id) === fk.slice(5));
      if (!t) continue;
      if (t.sessionId) {
        if (seenSid.has(t.sessionId)) continue;
        const best = bestTermBySid.get(t.sessionId) || t;
        seenSid.add(t.sessionId);
        seen.add(`term:${best.id}`);
        out.push({ key: `term:${best.id}`, allKeys: keysBySid.get(t.sessionId) || [fk], kind: 'term', item: best });
      } else {
        const uid = `term:${t.id}`;
        if (seen.has(uid)) continue;
        seen.add(uid);
        out.push({ key: fk, allKeys: [fk], kind: 'term', item: t });
      }
    } else if (fk.startsWith('sid:')) {
      const sid = fk.slice(4);
      if (seenSid.has(sid)) continue;
      seenSid.add(sid);
      const best = bestTermBySid.get(sid);
      if (best) {
        const uid = `term:${best.id}`;
        if (seen.has(uid)) continue;
        seen.add(uid);
        out.push({ key: fk, allKeys: keysBySid.get(sid) || [fk], kind: 'term', item: best });
      } else {
        const uid = `sid:${sid}`;
        if (seen.has(uid)) continue;
        seen.add(uid);
        out.push({ key: fk, allKeys: keysBySid.get(sid) || [fk], kind: 'sid', sid, item: recentSession(sid) || null });
      }
    }
  }
  return out;
}

function renderSide() {
  const side = $('#side');
  if (!side) return;
  const prevTop = side.scrollTop;
  const folded = sideFolded();
  const curKind = state.sel.kind;
  const isSys = ['usage', 'gpu', 'vault'].includes(curKind);

  const calItems = ((typeof CAL !== 'undefined' && CAL?.data?.items) || []).filter((x) => !(x.kind === 'task' && x.done));
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const overN = calItems.filter((x) => x.kind === 'task' && !x.done && x.date < today).length;
  const gpuWait = state.gpu?.waiting?.length || 0;
  const sysAlert = gpuWait > 0;

  const fTerms = termsOf(state.sideFilter);
  const matchSide = (...parts) => !fTerms.length || fTerms.every((q) => parts.join(' ').toLowerCase().includes(q));

  let h = `<nav class="snav" aria-label="주요 메뉴">
    <div class="snav-item${curKind === 'home' ? ' sel' : ''}" data-key="home">${ICO.home}<span class="snav-lbl">홈</span></div>
    <div class="snav-item${curKind === 'search' ? ' sel' : ''}" data-key="cmdk">${ICO.search}<span class="snav-lbl">빠른 이동 · 검색</span><span class="snav-kbd">Ctrl+K</span></div>
    <div class="snav-item${isSys ? ' sel' : ''}" data-key="system">${ICO.settings}<span class="snav-lbl">설정</span>${sysAlert ? '<span class="snav-dot danger" title="확인할 항목 있음"></span>' : '<span class="snav-meta">사용량·GPU·자원</span>'}</div>
    <div class="snav-item${curKind === 'calendar' ? ' sel' : ''}" data-key="calendar">${ICO.calendar}<span class="snav-lbl">캘린더</span>${overN ? '<span class="snav-dot danger" title="기한 지난 할 일 있음"></span>' : '<span class="snav-meta">일정·할 일</span>'}</div>
  </nav>`;

  // Section 0: Dedicated Favorites (Projects + Terminals + Recent Sessions — resolved live items only!)
  const favs = state.favs || new Set();
  const favFolded = folded.has('favs');
  const resolvedFavList = resolvedFavs();
  const favRowsArr = [];
  if (resolvedFavList.length && !favFolded) {
    for (const entry of resolvedFavList) {
      const fk = entry.key;
      if (entry.kind === 'proj') {
        const p = entry.item;
        if (!matchSide(p.name, p.cwd || '')) continue;
        const hasBusy = (state.terms || []).some((t) => termStateOf(t) === 'busy' && projectOfTerm(t)?.id === p.id);
        const isSel = curKind === 'projects' && (state.sel.id || (typeof projectId !== 'undefined' ? projectId : '')) === p.id;
        favRowsArr.push(`<div class="srow${isSel ? ' sel' : ''}" data-key="project:${esc(p.id)}">
          <span class="${hasBusy ? 'dot busy' : 'pj-dot'}"></span>
          <div class="srow-main"><div class="srow-t">${esc(p.name)}</div></div>
          <span class="srow-end"><span class="fav on" data-fav="${esc(fk)}" role="button" tabindex="0" aria-label="즐겨찾기 해제">${ICO.starFill}</span></span>
        </div>`);
      } else if (entry.kind === 'term') {
        const t = entry.item;
        if (!matchSide(termLabel(t), t.cwd || '')) continue;
        const st = termStateOf(t);
        const dot = st === 'exited' ? 'dead' : st === 'busy' ? 'busy' : 'idle';
        const isSel = curKind === 'term' && String(state.sel.id) === String(t.id);
        const unread = state.unreadTerms.has(String(t.id));
        const isBr = !!t.branch?.isBranch;
        favRowsArr.push(`<div class="srow${isSel ? ' sel' : ''}${unread ? ' just-done' : ''}${isBr ? ' is-branch' : ''}" data-key="term:${esc(t.id)}"${isBr ? ` title="${esc(branchTooltip(t.branch))}"` : ''}>
          ${agentIcon(t.operator ? 'operator' : t.agent || 'shell', dot)}
          <div class="srow-main"><div class="srow-t">${esc(termLabel(t))}</div></div>
          <span class="srow-end">${branchTagHTML(t.branch, true)}${unread ? '<span class="srow-tag done">완료</span>' : ''}<span class="fav on" data-fav="${esc(fk)}" data-fav-keys="${esc((entry.allKeys || [fk]).join(','))}" role="button" tabindex="0" aria-label="즐겨찾기 해제">${ICO.starFill}</span></span>
        </div>`);
      } else if (entry.kind === 'sid') {
        const sid = entry.sid;
        const r = entry.item;
        const lbl = r ? sessionLabel(r) : sid.slice(0, 8);
        if (!matchSide(lbl, r?.cwd || '')) continue;
        const isSel = curKind === 'recent' && state.sel.id === sid;
        const isBr = !!r?.branch?.isBranch;
        favRowsArr.push(`<div class="srow${isSel ? ' sel' : ''}${isBr ? ' is-branch' : ''}" data-key="recent:${esc(sid)}"${isBr ? ` title="${esc(branchTooltip(r.branch))}"` : ''}>
          ${agentIcon(r?.agent || 'claude')}
          <div class="srow-main"><div class="srow-t">${esc(lbl)}</div></div>
          <span class="srow-end">${branchTagHTML(r?.branch, true)}<span class="fav on" data-fav="${esc(fk)}" role="button" tabindex="0" aria-label="즐겨찾기 해제">${ICO.starFill}</span></span>
        </div>`);
      }
    }
  }
  if (resolvedFavList.length) {
    const favCountLabel = fTerms.length && !favFolded ? `${favRowsArr.length}/${resolvedFavList.length}` : String(resolvedFavList.length);
    h += `<div class="ssec">
      <div class="ssec-hd">
        ${foldBtnHTML('favs', favFolded, '즐겨찾기')}
        <span class="ssec-title" data-key="terms-favs"><span style="color:var(--star);display:inline-flex">${ICO.starFill}</span> 즐겨찾기 <span class="srow-meta">${favCountLabel}</span></span>
      </div>
      ${favFolded ? '' : (favRowsArr.join('') || '<div class="srow-empty">필터 일치 항목 없음</div>')}
    </div>`;
  }

  // Section 1: Projects (collapsible; projects with active busy terminals float to top)
  const projects = [...(state.projects || [])]
    .filter((p) => matchSide(p.name, p.cwd || ''))
    .sort((a, b) => {
      const ab = (state.terms || []).some((t) => termStateOf(t) === 'busy' && projectOfTerm(t)?.id === a.id) ? 0 : 1;
      const bb = (state.terms || []).some((t) => termStateOf(t) === 'busy' && projectOfTerm(t)?.id === b.id) ? 0 : 1;
      return ab - bb;
    });
  const pjBusyN = projects.filter((p) => (state.terms || []).some((t) => termStateOf(t) === 'busy' && projectOfTerm(t)?.id === p.id)).length;
  const pjFolded = folded.has('projects') && !fTerms.length;
  const activePid = curKind === 'projects' ? (state.sel.id || (typeof projectId !== 'undefined' ? projectId : '') || projects[0]?.id) : '';
  const pjRows = pjFolded ? '' : (projects.map((p) => {
    const done = (p.tasks || []).filter((t) => t.stage === 'done').length;
    const total = (p.tasks || []).length;
    const hasBusy = (state.terms || []).some((t) => termStateOf(t) === 'busy' && projectOfTerm(t)?.id === p.id);
    const isSel = curKind === 'projects' && activePid === p.id;
    const fk = `proj:${p.id}`, isStar = favs.has(fk);
    return `<div class="srow${isSel ? ' sel' : ''}" data-key="project:${esc(p.id)}" title="${esc(p.name)}">
      <span class="${hasBusy ? 'dot busy' : 'pj-dot'}"></span>
      <div class="srow-main"><div class="srow-t">${esc(p.name)}</div></div>
      <span class="srow-end">
        <span class="fav${isStar ? ' on' : ''}" data-fav="${esc(fk)}" role="button" tabindex="0" aria-label="${isStar ? '즐겨찾기 해제' : '즐겨찾기'}">${isStar ? ICO.starFill : ICO.star}</span>
        ${hasBusy ? '<span class="srow-tag busy">실행 중</span>' : `<span class="srow-meta">${done}/${total}</span>`}
      </span>
    </div>`;
  }).join('') || '<div class="srow-empty">Project 없음</div>');
  h += `<div class="ssec">
    <div class="ssec-hd">
      ${foldBtnHTML('projects', pjFolded, 'Project')}
      <span class="ssec-title" data-key="projects">Project <span class="srow-meta">${projects.length || ''}</span>${pjFolded && pjBusyN ? `<span class="srow-tag busy">실행 ${pjBusyN}</span>` : ''}</span>
      <button class="ghost icon-btn ssec-act" data-side-new-project="1" title="새 Project 만들기" aria-label="새 Project 만들기">${ICO.plus}</button>
    </div>
    ${pjRows}
  </div>`;

  // Section 2: Terminals & Live Consoles (collapsible; busy always floated to top + Project/kind/done tags + Group toggle + Clean exited)
  const cons = sortConsolesByState(visibleConsoles()).filter((c) => matchSide(consoleLabel(c), '콘솔'));
  const terms = sortTermsByState(state.terms || []).filter((t) => matchSide(termLabel(t), t.cwd || '', projectOfTerm(t)?.name || '', t.agent || ''));
  const tf = state.termFilter || '';
  const tCounts = { all: terms.length + cons.length, busy: 0, idle: 0, exited: 0 };
  for (const t of terms) tCounts[termStateOf(t)]++;
  for (const c of cons) tCounts[consoleStateOf(c)]++;
  const tfbtn = (val, label, cnt) => `<button data-tfilt="${val}" class="${tf === val ? 'on' : ''}">${label}${cnt ? ` <span class="seg-cnt">${cnt}</span>` : ''}</button>`;
  const shownTerms = tf ? terms.filter((t) => termStateOf(t) === tf) : terms;
  const shownCons = tf === 'exited' ? [] : tf ? cons.filter((c) => consoleStateOf(c) === tf) : cons;
  const termFolded = folded.has('terms') && !fTerms.length;

  const combined = [
    ...shownTerms.map((t) => ({ kind: 'term', rank: STATE_RANK[termStateOf(t)] ?? 9, item: t })),
    ...shownCons.map((c) => ({ kind: 'console', rank: STATE_RANK[consoleStateOf(c)] ?? 9, item: c })),
  ].sort((a, b) => a.rank - b.rank);

  const renderEntryRow = (entry, hidePjTag = false) => {
    if (entry.kind === 'term') {
      const t = entry.item;
      const st = termStateOf(t);
      const dot = st === 'exited' ? 'dead' : st === 'busy' ? 'busy' : 'idle';
      const kind = t.operator ? 'operator' : t.agent || 'shell';
      const pj = projectOfTerm(t);
      const idStr = String(t.id);
      const isSel = curKind === 'term' && String(state.sel.id) === idStr;
      const unread = state.unreadTerms.has(idStr);
      const fk = favKeyOf(`term:${idStr}`), isStar = !!fk && favs.has(fk);
      const subKindTag = t.operator
        ? '<span class="srow-tag">관제</span>'
        : (!t.agent ? '<span class="srow-tag">셸</span>' : '');
      const folderLbl = esc(base(t.cwd) || (t.agent === 'agy' ? 'Antigravity' : t.agent || '대기'));
      const isBr = !!t.branch?.isBranch;
      const brTip = branchTooltip(t.branch);
      const tags = [
        branchTagHTML(t.branch, true),
        pj && !hidePjTag ? `<span class="srow-tag proj" title="Project: ${esc(pj.name)}">${esc(pj.name)}</span>` : '',
        subKindTag,
        st === 'busy'
          ? `<span class="srow-tag busy">실행 중</span><span>${folderLbl}</span>`
          : unread
            ? `<span class="srow-tag done">완료</span><span>${folderLbl}</span>`
            : st === 'exited'
              ? '<span class="srow-tag">종료됨</span>'
              : `<span>${folderLbl}</span>`,
      ].filter(Boolean).join('');
      return `<div class="srow${isSel ? ' sel' : ''}${unread ? ' just-done' : ''}${isBr ? ' is-branch' : ''}" data-key="term:${esc(t.id)}" title="${esc(termLabel(t))}${pj ? ` · Project: ${esc(pj.name)}` : ''}${brTip ? ` · ${esc(brTip)}` : ''}">
        ${agentIcon(kind, dot)}
        <div class="srow-main"><div class="srow-t">${esc(termLabel(t))}</div><div class="srow-s">${tags}</div></div>
        <span class="srow-end">${unread ? '<span class="srow-unread" title="방금 작업 완료"></span>' : ''}${fk ? `<span class="fav${isStar ? ' on' : ''}" data-fav="${esc(fk)}" role="button" tabindex="0" aria-label="${isStar ? '즐겨찾기 해제' : '즐겨찾기'}">${isStar ? ICO.starFill : ICO.star}</span>` : ''}</span>
      </div>`;
    }
    const c = entry.item;
    const st = consoleStateOf(c);
    const isSel = curKind === 'console' && String(state.sel.id) === String(c.id);
    return `<div class="srow${isSel ? ' sel' : ''}" data-key="console:${esc(c.id)}">
      ${agentIcon(sessionOfConsole(c) ? 'claude' : 'shell', st === 'busy' ? 'busy' : 'idle')}
      <div class="srow-main"><div class="srow-t">${esc(consoleLabel(c))}</div><div class="srow-s"><span class="srow-tag con">콘솔</span>${st === 'busy' ? '<span class="srow-tag busy">실행 중</span>' : '<span>대기</span>'}</div></div>
    </div>`;
  };

  let termRows = '';
  if (!termFolded) {
    if (!combined.length) {
      termRows = `<div class="srow-empty">${tf ? '해당 상태 없음' : '열린 터미널 없음'}</div>`;
    } else if (state.termGroupByProject) {
      const groups = new Map();
      for (const entry of combined) {
        const pj = entry.kind === 'term' ? projectOfTerm(entry.item) : null;
        const gKey = pj ? `pj:${pj.id}` : '_general';
        const gLabel = pj ? pj.name : '일반 터미널 · 콘솔';
        if (!groups.has(gKey)) groups.set(gKey, { label: gLabel, isPj: !!pj, items: [] });
        groups.get(gKey).items.push(entry);
      }
      termRows = [...groups.values()].map((g) => `<div class="sgrp-lbl">${g.isPj ? '<span class="pj-dot"></span>' : ''}${esc(g.label)}</div>${g.items.map((e) => renderEntryRow(e, g.isPj)).join('')}`).join('');
    } else {
      termRows = combined.map((e) => renderEntryRow(e, false)).join('');
    }
  }

  const cleanExitedAria = '종료된 터미널 정리';
  const cleanExitedTitle = `종료된 터미널 정리 (${tCounts.exited})`;
  const groupProjLbl = 'Project별 터미널 묶어보기';
  h += `<div class="ssec">
    <div class="ssec-hd">
      ${foldBtnHTML('terms', termFolded, '터미널')}
      <span class="ssec-title" data-key="terms">터미널 <span class="srow-meta">${tCounts.all || ''}</span>${termFolded && tCounts.busy ? `<span class="srow-tag busy">실행 ${tCounts.busy}</span>` : ''}</span>
      ${tCounts.exited ? `<button class="ghost icon-btn ssec-act" data-side-clean-exited="1" title="${cleanExitedTitle}" aria-label="${cleanExitedAria}">${ICO.trash}</button>` : ''}
      <button class="ghost icon-btn ssec-act${state.termGroupByProject ? ' on' : ''}" data-tgroup="1" title="${groupProjLbl}" aria-pressed="${state.termGroupByProject}" aria-label="${groupProjLbl}">${ICO.layers}</button>
      <button class="ghost icon-btn ssec-act" data-hopen-new="1" title="새 터미널 열기" aria-label="새 터미널 열기">${ICO.plus}</button>
    </div>
    ${termFolded ? '' : `<div class="seg sm" role="tablist" aria-label="터미널 상태 필터">${tfbtn('', '전체', tCounts.all)}${tfbtn('busy', '실행', tCounts.busy)}${tfbtn('idle', '대기', tCounts.idle)}${tfbtn('exited', '종료', tCounts.exited)}</div>${termRows}`}
  </div>`;

  // Section 3: Recent Sessions (collapsible; Agent filter)
  const rf = state.recentFilter || '';
  const fbtn = (val, label) => `<button data-rfilt="${val}" class="${rf === val ? 'on' : ''}">${label}</button>`;
  const allRecent = (state.recentByAgent?.[rf] || state.recent)
    .filter((r) => (!rf || (r.agent || 'claude') === rf) && matchSide(sessionLabel(r), r.cwd || '', r.agent || ''));
  const recFolded = folded.has('recent') && !fTerms.length;
  const recentRows = recFolded ? '' : (allRecent.slice(0, 18).map((r) => {
    const ag = r.agent || 'claude';
    const fk = `sid:${r.sessionId}`, on = favs.has(fk);
    const isSel = curKind === 'recent' && state.sel.id === r.sessionId;
    const isBr = !!r.branch?.isBranch;
    const brTip = branchTooltip(r.branch);
    const delRecTitle = '기록 삭제';
    const delRecAria = `기록 삭제: ${sessionLabel(r)}`;
    const subHTML = [
      branchTagHTML(r.branch, true),
      `<span>${esc([base(r.cwd), ago(r.mtime)].filter(Boolean).join(' · '))}</span>`,
    ].filter(Boolean).join('');
    return `<div class="srow${isSel ? ' sel' : ''}${isBr ? ' is-branch' : ''}" data-key="recent:${esc(r.sessionId)}" title="${esc(sessionLabel(r))}${brTip ? ` · ${esc(brTip)}` : ''}">
      ${agentIcon(ag)}
      <div class="srow-main"><div class="srow-t">${esc(sessionLabel(r))}</div><div class="srow-s">${subHTML}</div></div>
      <span class="srow-end">
        <span class="fav${on ? ' on' : ''}" data-fav="${esc(fk)}" role="button" tabindex="0" aria-label="${on ? '즐겨찾기 해제' : '즐겨찾기'}">${on ? ICO.starFill : ICO.star}</span>
        <button class="record-delete danger ghost icon-btn" data-hide-record="${esc(r.sessionId)}" title="${delRecTitle}" aria-label="${esc(delRecAria)}">${ICO.trash}</button>
      </span>
    </div>`;
  }).join('') || '<div class="srow-empty">최근 기록 없음</div>');

  h += `<div class="ssec">
    <div class="ssec-hd">
      ${foldBtnHTML('recent', recFolded, '최근 대화')}
      <span class="ssec-title" data-key="terms-recent">최근 대화</span>
      <button class="ghost icon-btn ssec-act" data-rrefresh="1" title="세션 기록 새로고침" aria-label="세션 기록 새로고침">${ICO.refresh}</button>
    </div>
    ${recFolded ? '' : `<div class="seg sm" role="tablist" aria-label="에이전트 필터">${fbtn('', '전체')}${fbtn('claude', 'Claude')}${fbtn('codex', 'Codex')}${fbtn('agy', 'AGY')}</div>${recentRows}`}
  </div>`;

  // Section 4: Autonomous Research (collapsible; only when active)
  if (state.researchEnabled && state.research?.length) {
    const resFolded = folded.has('research');
    const rRows = resFolded ? '' : state.research.map((p) => {
      const isSel = curKind === 'research' && state.sel.id === p.slug;
      const dot = p.status === 'blocked' ? 'busy' : p.status === 'running' ? (p.director?.busy ? 'busy' : 'idle') : p.status === 'done' ? 'idle' : 'dead';
      return `<div class="srow${isSel ? ' sel' : ''}" data-key="research:${esc(p.slug)}">
        <span class="dot ${dot}"></span>
        <div class="srow-main"><div class="srow-t">${esc(p.name)}</div><div class="srow-s">${esc(PHASE_KO[p.phase] || p.phase)}</div></div>
      </div>`;
    }).join('');
    h += `<div class="ssec"><div class="ssec-hd">${foldBtnHTML('research', resFolded, '자율 연구')}<span class="ssec-title">자율 연구 <span class="srow-meta">${state.research.length}</span></span></div>${rRows}</div>`;
  }

  side.innerHTML = h;
  side.scrollTop = prevTop;

  const banner = $('#diskBanner');
  if (banner) {
    banner.innerHTML = state.disk
      ? `⚠ ${esc(state.disk.drive)} 남은 공간 ${state.disk.freeGB} GB — 디스크가 가득 차면 세션이 멈춥니다.`
      : '';
  }
  if (booted && state.sel.kind === 'terms' && state.termsTab !== 'active') paintTermsBody();
}
const renderTopNav = renderSide;

$('#side')?.addEventListener('click', async (e) => {
  const fold = e.target.closest('[data-sec-fold]');
  if (fold) { e.stopPropagation(); return toggleSideFold(fold.dataset.secFold); }
  if (e.target.closest('[data-tgroup]')) {
    e.stopPropagation();
    state.termGroupByProject = !state.termGroupByProject;
    try { localStorage.setItem('ach-term-group', state.termGroupByProject ? '1' : '0'); } catch {}
    return renderSide();
  }
  if (e.target.closest('[data-side-clean-exited]')) {
    e.stopPropagation();
    const exitedIds = state.terms.filter((t) => t.exited !== null).map((t) => t.id);
    if (!exitedIds.length) return;
    for (const id of exitedIds) await api('/api/term/close', { method: 'POST', body: { id } }).catch(() => {});
    await refreshOverview();
    toast(`종료된 터미널 ${exitedIds.length}개를 정리했습니다`);
    return;
  }
  const remove = e.target.closest('[data-hide-record]');
  if (remove) { e.stopPropagation(); return hideRecentRecord(remove.dataset.hideRecord, remove); }
  if (e.target.closest('[data-hopen-new]')) { e.stopPropagation(); return openNewTermDrawer(); }
  if (e.target.closest('[data-side-new-project]')) { e.stopPropagation(); return typeof projectForm === 'function' ? projectForm() : select({ kind: 'projects' }); }
  const tfBtn = e.target.closest('[data-tfilt]');
  if (tfBtn) {
    e.stopPropagation();
    state.termFilter = tfBtn.dataset.tfilt;
    renderSide();
    if (state.sel.kind === 'terms') paintTermsBody();
    return;
  }
  const rrBtn = e.target.closest('[data-rrefresh]');
  if (rrBtn) { e.stopPropagation(); rrBtn.disabled = true; refreshRecent(true).finally(() => { rrBtn.disabled = false; }); return; }
  const rfBtn = e.target.closest('[data-rfilt]');
  if (rfBtn) { e.stopPropagation(); state.recentFilter = rfBtn.dataset.rfilt; renderSide(); refreshRecent(); return; }
  const star = e.target.closest('[data-fav]');
  if (star) {
    e.stopPropagation();
    const key = star.dataset.fav;
    const keys = star.dataset.favKeys ? star.dataset.favKeys.split(',').filter(Boolean) : [key];
    const on = !keys.some((k) => (state.favs || new Set()).has(k));
    api('/api/favorites', { method: 'POST', body: on ? { key, on: true } : { key, keys, on: false } })
      .then((r) => { if (r.favs) { state.favs = new Set(r.favs); renderSide(); } })
      .catch((er) => toast(er.message, 5000, 'danger'));
    return;
  }
  const it = e.target.closest('[data-key]');
  if (!it) return;
  const k = it.dataset.key;
  if (k === 'home') return select({ kind: 'home' });
  if (k === 'cmdk') return openCommandPalette();
  if (k === 'search') return select({ kind: 'search' });
  if (k === 'system') return select({ kind: ['usage', 'gpu', 'vault'].includes(state.sysTab) ? state.sysTab : 'usage' });
  if (k === 'calendar') return select({ kind: 'calendar' });
  if (k === 'terms') { state.termsTab = 'active'; return select({ kind: 'terms' }); }
  if (k === 'terms-recent') { state.termsTab = 'recent'; return select({ kind: 'terms' }); }
  if (k === 'terms-favs') { state.termsTab = 'favs'; return select({ kind: 'terms' }); }
  if (k === 'projects') return select({ kind: 'projects' });
  if (k.startsWith('project:')) return typeof openProject === 'function' ? openProject(k.slice(8)) : select({ kind: 'projects', id: k.slice(8) });
  const i = k.indexOf(':');
  if (i > 0) select({ kind: k.slice(0, i), id: k.slice(i + 1) });
});

// ---------- views ----------
function stopView() {
  if (window.closeMoreMenu) closeMoreMenu();
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
const TERM_TABS = new Set(['screen', 'split', 'chat', 'dock', 'files', 'floorplan']);
const RECENT_TABS = new Set(['chat', 'dock', 'files', 'floorplan']);
function getSavedTermTab(fallback = 'dock') {
  try {
    const v = localStorage.getItem('ach-term-tab');
    if (v && TERM_TABS.has(v)) return v;
  } catch {}
  return fallback;
}
function saveTermTab(tab) {
  if (!TERM_TABS.has(tab)) return;
  try { localStorage.setItem('ach-term-tab', tab); } catch {}
}
function getSavedRecentTab(fallback = 'dock') {
  try {
    const v = localStorage.getItem('ach-recent-tab');
    if (v && RECENT_TABS.has(v)) return v;
  } catch {}
  return fallback;
}
function saveRecentTab(tab) {
  if (!RECENT_TABS.has(tab)) return;
  try { localStorage.setItem('ach-recent-tab', tab); } catch {}
}

function select(sel, tab, persistTab = false) {
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
  if (sel.kind === 'term') { state.unreadTerms.delete(String(sel.id)); updateDocTitle(); }
  if (persistTab && tab) {
    if (sel.kind === 'term' || sel.kind === 'console') {
      saveTermTab(tab);
      if (tab === 'screen') window.ACH_DOCK?.saveDockOpen('term', ['term']);
      else if (tab === 'split') window.ACH_DOCK?.saveDockOpen('term', ['term', 'chat']);
      else if (tab === 'chat') window.ACH_DOCK?.saveDockOpen('term', ['chat']);
    } else if (sel.kind === 'recent') saveRecentTab(tab);
  }
  if (sel.kind === 'term' || sel.kind === 'console') {
    state.tab = (tab && TERM_TABS.has(tab)) ? tab : getSavedTermTab('dock');
  } else if (sel.kind === 'recent') {
    state.tab = (tab && RECENT_TABS.has(tab)) ? tab : getSavedRecentTab('dock');
  } else {
    state.tab = tab || 'dock';
  }
  if (booted && sel.kind !== 'search') {
    const payload = { sel, tab: state.tab };
    try { localStorage.setItem('ach-last-sel', JSON.stringify(payload)); } catch {}
    try {
      const h = sel.id ? `#${sel.kind}:${sel.id}:${state.tab}` : `#${sel.kind}`;
      if (location.hash !== h) history.replaceState(null, '', h);
    } catch {}
  }
  renderSide();
  ({ home: viewHome, terms: viewTerms, projects: window.viewProjects || (() => { setBar('<h2>Project</h2>'); $('#view').textContent = 'Project 기능을 반영하려면 허브 서버를 재시작해야 합니다.'; }), console: viewConsole, recent: viewTranscript, term: viewTerm, search: viewSearch, usage: viewUsage, research: viewResearch, gpu: viewGpu, calendar: viewCalendar, vault: window.viewVault || (() => { setBar('<h2>공통 자원</h2>'); $('#view').textContent = '공통 자원 기능을 반영하려면 허브 서버를 재시작해야 합니다.'; }) })[sel.kind]?.();
}

function setBar(html) {
  $('#bar').innerHTML = html || '';
}

// ---------- Home: Minimal, Airy, Scannable Overview (Zero Sidebar Clutter) ----------
const homeKeyOf = () => visibleConsoles().map((c) => c.id).join(',') + '|' + state.terms.map((t) => t.id + (t.exited === null ? '' : 'x')).join(',');

function homeStatsHTML() {
  const cons = visibleConsoles();
  const runTerms = state.terms.filter((t) => t.exited === null);
  const busyN = runTerms.filter((t) => termStateOf(t) === 'busy').length + cons.filter((c) => consoleStateOf(c) === 'busy').length;
  const idleN = (runTerms.length + cons.length) - busyN;

  const u = state.usage;
  const okAccs = (u?.accounts || []).filter((a) => a.ok && a.meters?.length);
  const swapAccs = state.agySwapAccounts || [];
  const agyGroups = state.agyQuota?.groups || [];
  const rems = [];
  for (const a of okAccs) {
    const ms = keyMeters(a);
    const worst = ms.length ? Math.max(...ms.map((m) => m.usedPercent || 0)) : 0;
    rems.push(Math.max(0, Math.round(100 - worst)));
  }
  if (swapAccs.length) {
    for (const sa of swapAccs) {
      const pcts = (sa.groups || []).flatMap((g) => [g.fiveH, g.weekly]).filter((v) => v != null);
      if (pcts.length) rems.push(Math.max(0, Math.round(100 - Math.max(...pcts))));
    }
  } else if (agyGroups.length) {
    const pcts = agyGroups.flatMap((g) => [g.fiveH, g.weekly]).filter((v) => v != null);
    if (pcts.length) rems.push(Math.max(0, Math.round(100 - Math.max(...pcts))));
  }
  const bestRem = rems.length ? Math.max(...rems) : null;
  const totalAccN = okAccs.length + (swapAccs.length || (agyGroups.length ? 1 : 0));

  const calItems = ((typeof CAL !== 'undefined' && CAL?.data?.items) || []).filter((x) => !(x.kind === 'task' && x.done));
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const todayList = calItems.filter((x) => x.date === today).sort((a, b) => String(a.time || '99:99').localeCompare(String(b.time || '99:99')));
  const overN = calItems.filter((x) => x.kind === 'task' && !x.done && x.date < today).length;
  const nextEv = todayList[0] || calItems.filter((x) => x.date > today).sort((a, b) => a.date.localeCompare(b.date))[0];

  const g = state.gpu;
  const g0 = (g?.gpus || []).find((x) => x.index >= 0 && x.enabled !== false);
  const g0Mem = g0 && g0.totalMB ? Math.round((g0.usedMB / g0.totalMB) * 100) : 0;

  return `
    <div class="h-stat" data-hnav="terms">
      <div class="h-stat-lbl"><span>열린 터미널</span>${busyN ? `<span class="badge warn">실행 중 ${busyN}</span>` : ''}</div>
      <div class="h-stat-val">${runTerms.length + cons.length}개</div>
      <div class="h-stat-sub">${runTerms.length + cons.length ? `실행 중 ${busyN} · 대기 ${idleN}` : '열린 세션 없음'}</div>
    </div>
    <div class="h-stat" data-hnav="usage">
      <div class="h-stat-lbl"><span>AI 남은 한도</span><span class="badge">계정 ${totalAccN}개</span></div>
      <div class="h-stat-val">${bestRem != null ? `${bestRem}%` : '—'}</div>
      <div class="h-stat-sub">${bestRem != null ? '가장 여유 있는 계정 기준' : !u ? '불러오는 중…' : '오프라인'}</div>
    </div>
    <div class="h-stat" data-hnav="calendar">
      <div class="h-stat-lbl"><span>오늘 일정</span>${overN ? `<span class="badge lim">지연 ${overN}</span>` : ''}</div>
      <div class="h-stat-val">${todayList.length}건</div>
      <div class="h-stat-sub">${nextEv ? `${nextEv.time ? nextEv.time + ' ' : ''}${esc(nextEv.title)}` : '예정된 일정 없음'}</div>
    </div>
    <div class="h-stat" data-hnav="gpu">
      <div class="h-stat-lbl"><span>GPU</span>${g?.waiting?.length ? `<span class="badge lim">대기 ${g.waiting.length}</span>` : ''}</div>
      <div class="h-stat-val">${g0 ? `${g0.util || 0}%` : '—'}</div>
      <div class="h-stat-sub">${g0 ? `VRAM ${fmtMB(g0.usedMB)} / ${fmtMB(g0.totalMB)} (${g0Mem}%)` : !g ? '확인 중…' : '활성 GPU 없음'}</div>
    </div>`;
}

function homeListsHTML() {
  const cons = sortConsolesByState(visibleConsoles());
  const terms = sortTermsByState(state.terms.filter((t) => t.exited === null));
  const merged = [
    ...terms.map((t) => ({ kind: 'term', rank: STATE_RANK[termStateOf(t)] ?? 9, item: t })),
    ...cons.map((c) => ({ kind: 'console', rank: STATE_RANK[consoleStateOf(c)] ?? 9, item: c })),
  ].sort((a, b) => a.rank - b.rank).slice(0, 6);
  const termRows = merged.map((entry) => {
    if (entry.kind === 'term') {
      const t = entry.item;
      const st = termStateOf(t);
      const kind = t.operator ? 'operator' : t.agent || 'shell';
      const pj = projectOfTerm(t);
      return `<div class="m-row" data-open-term="${esc(t.id)}">
        ${agentIcon(kind, st === 'busy' ? 'busy' : 'idle')}
        <div class="m-row-main"><div class="m-row-t">${esc(termLabel(t))}</div><div class="m-row-s">${pj ? `Project: ${esc(pj.name)} · ` : ''}${esc(termKindLabel(t))}${base(t.cwd) ? ` · ${esc(base(t.cwd))}` : ''}</div></div>
        <div class="m-row-end">${branchTagHTML(t.branch)}${pj ? `<span class="badge c">${esc(pj.name)}</span>` : ''}<span class="badge ${st === 'busy' ? 'warn' : 'ok'}">${st === 'busy' ? '실행 중' : '대기'}</span></div>
      </div>`;
    }
    const c = entry.item;
    const st = consoleStateOf(c);
    return `<div class="m-row" data-open-con="${esc(c.id)}">
      ${agentIcon(sessionOfConsole(c) ? 'claude' : 'shell', st === 'busy' ? 'busy' : 'idle')}
      <div class="m-row-main"><div class="m-row-t">${esc(consoleLabel(c))}</div><div class="m-row-s">외부 콘솔</div></div>
      <div class="m-row-end"><span class="badge agy">콘솔</span><span class="badge ${st === 'busy' ? 'warn' : 'ok'}">${st === 'busy' ? '실행 중' : '대기'}</span></div>
    </div>`;
  }).join('') || '<div class="empty" style="padding:24px 16px;text-align:center">열린 터미널이 없습니다. 위에서 바로 시작해 보세요.</div>';

  const liveIds = new Set(state.live.map((s) => s.sessionId));
  const recents = state.recent.filter((r) => !liveIds.has(r.sessionId)).slice(0, 6);
  const recentRows = recents.map((r) => {
    const ag = r.agent || 'claude';
    return `<div class="m-row" data-hrecent="${esc(r.sessionId)}">
      ${agentIcon(ag)}
      <div class="m-row-main"><div class="m-row-t">${esc(sessionLabel(r))}</div><div class="m-row-s">${esc([r.branch?.isBranch && r.branch?.parentTitle ? `원본: ${r.branch.parentTitle}` : '', base(r.cwd), ago(r.mtime)].filter(Boolean).join(' · '))}</div></div>
      <div class="m-row-end">${branchTagHTML(r.branch)}<button class="btn-sm" data-hresume="${esc(r.sessionId)}">이어하기</button></div>
    </div>`;
  }).join('') || '<div class="empty" style="padding:24px 16px;text-align:center">최근 대화 기록이 없습니다.</div>';

  return `
    <section class="sheet">
      <div class="sheet-hd"><h2>열린 터미널</h2><button class="ghost btn-sm" data-hnav="terms">전체 보기 →</button></div>
      <div>${termRows}</div>
    </section>
    <section class="sheet">
      <div class="sheet-hd"><h2>최근 대화</h2><button class="ghost btn-sm" data-hnav="terms-recent">전체 보기 →</button></div>
      <div>${recentRows}</div>
    </section>`;
}

function refreshHomeWidgets() {
  if (state.sel.kind !== 'home') return;
  const s = $('#homeStats'); if (s) s.innerHTML = homeStatsHTML();
  const l = $('#homeLists'); if (l) l.innerHTML = homeListsHTML();
}

function termCardHTML(t, extraBadge = '') {
  const st = termStateOf(t);
  const dot = st === 'exited' ? 'dead' : st === 'busy' ? 'busy' : 'idle';
  const kind = t.operator ? 'operator' : t.agent || 'shell';
  const pj = projectOfTerm(t);
  const pjBadge = pj && !extraBadge ? `<span class="badge c" title="Project: ${esc(pj.name)}">${esc(pj.name)}</span>` : '';
  const kindBadge = `<span class="badge">${esc(t.operator ? '관제' : t.agent ? '터미널' : '셸')}</span>`;
  const stBadge = st === 'exited'
    ? '<span class="badge">종료됨</span>'
    : st === 'busy'
      ? '<span class="badge warn">실행 중</span>'
      : '<span class="badge ok">대기</span>';
  const closeBtn = st === 'exited'
    ? `<button class="ghost icon-btn btn-sm" data-term-close="${esc(t.id)}" aria-label="종료된 터미널 닫기" title="종료된 터미널 제거">${ICO.close}</button>`
    : '';
  return `<div class="card${t.branch?.isBranch ? ' is-branch' : ''}" data-term="${t.id}"><div class="hd">${agentIcon(kind, dot)}
    <span class="t">${esc(termLabel(t))}</span>
    ${branchTagHTML(t.branch)}${pjBadge}${extraBadge}${kindBadge}${stBadge}${closeBtn}</div>
    <div class="mini" id="mini-${t.id}"><div class="mini-in"></div></div></div>`;
}
function conCardHTML(c) {
  const s = sessionOfConsole(c);
  const st = consoleStateOf(c);
  return `<div class="card" data-id="${c.id}"><div class="hd"><span class="dot ${st === 'busy' ? 'busy' : 'idle'}"></span>
    <span class="t">${esc(consoleLabel(c))}</span>${s?.limit ? '<span class="badge lim">한도</span>' : ''}<span class="badge agy">외부 콘솔</span><span class="badge ${st === 'busy' ? 'warn' : 'ok'}">${st === 'busy' ? '실행 중' : '대기'}</span></div>
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

async function resumeRecentSession(sid, btn) {
  const r = recentSession(sid);
  const body = r?.agent === 'codex'
    ? { kind: 'codex', resume: sid, cwd: r.cwd }
    : r?.agent === 'agy'
      ? { kind: 'agy', resume: sid, cwd: r.cwd }
      : { kind: 'claude', resume: sid, cwd: r?.cwd, skipPermissions: true };
  if (btn) btn.disabled = true;
  const t = await api('/api/term/new', { method: 'POST', body }).catch((er) => ({ error: er.message }));
  if (btn) btn.disabled = false;
  if (t.error) return toast(t.error, 6000, 'danger');
  await refreshOverview();
  return openResumedTerm(t, body);
}

function viewHome() {
  homeKey = homeKeyOf();
  setBar('');
  $('#view').innerHTML = `<div class="page-wrap">
    <header class="h-hero">
      <div class="h-hero-title">
        <h1>무엇을 시작할까요?</h1>
        <span>에이전트 세션을 한 번의 클릭으로 열거나 이어서 작업하세요</span>
      </div>
      <div class="h-launch">
        <button class="h-launch-btn" data-quick="claude">${agentIcon('claude')} Claude</button>
        <button class="h-launch-btn" data-quick="codex">${agentIcon('codex')} Codex</button>
        <button class="h-launch-btn" data-quick="agy">${agentIcon('agy')} Antigravity</button>
        <button class="primary" data-hopen-new="1">${ICO.plus} 새 터미널</button>
      </div>
    </header>
    <div class="h-stats" id="homeStats">${homeStatsHTML()}</div>
    <div class="h-two" id="homeLists">${homeListsHTML()}</div>
  </div>`;
  $('#view').onclick = async (e) => {
    const q = e.target.closest('[data-quick]');
    if (q) return openNewTermDrawer('', null, q.dataset.quick);
    if (e.target.closest('[data-hopen-new]')) return openNewTermDrawer();
    const resBtn = e.target.closest('[data-hresume]');
    if (resBtn) { e.stopPropagation(); return resumeRecentSession(resBtn.dataset.hresume, resBtn); }
    const openProj = e.target.closest('[data-open-proj]');
    if (openProj) return typeof openProject === 'function' ? openProject(openProj.dataset.openProj) : select({ kind: 'projects', id: openProj.dataset.openProj });
    const openT = e.target.closest('[data-open-term]');
    if (openT) return select({ kind: 'term', id: openT.dataset.openTerm });
    const openC = e.target.closest('[data-open-con]');
    if (openC) return select({ kind: 'console', id: openC.dataset.openCon });
    const hrec = e.target.closest('[data-hrecent]');
    if (hrec) return select({ kind: 'recent', id: hrec.dataset.hrecent }, 'chat');
    const nav = e.target.closest('[data-hnav]');
    if (nav) {
      const target = nav.dataset.hnav;
      if (target === 'terms-recent') { state.termsTab = 'recent'; return select({ kind: 'terms' }); }
      if (target === 'terms') { state.termsTab = 'active'; return select({ kind: 'terms' }); }
      return select({ kind: target });
    }
  };
}

// ---------- Unified Terminals & Sessions Workspace (Active | Recent | Favorites) ----------
function recentRowHTML(r) {
  const ag = r.agent || 'claude';
  const fk = `sid:${r.sessionId}`, on = (state.favs || new Set()).has(fk);
  const acc = ag === 'agy' && state.agyQuota?.account ? state.agyQuota.account.replace(/@.*/, '') : '';
  const parentNote = r.branch?.isBranch && r.branch?.parentTitle ? `원본: ${r.branch.parentTitle}` : '';
  const sub = [parentNote, base(r.cwd), acc, ago(r.mtime)].filter(Boolean).join(' · ') || providerName(ag);
  const delRecTitle = '기록 삭제';
  const delRecAria = `기록 삭제: ${sessionLabel(r)}`;
  return `<div class="m-row" data-key="recent:${esc(r.sessionId)}">
    ${agentIcon(ag)}
    <div class="m-row-main"><div class="m-row-t">${esc(sessionLabel(r))}</div><div class="m-row-s">${esc(sub)}</div></div>
    <div class="m-row-end">
      ${branchTagHTML(r.branch)}
      <span class="fav${on ? ' on' : ''}" data-fav="${esc(fk)}" role="button" tabindex="0" aria-label="${on ? '즐겨찾기 해제' : '즐겨찾기'}">${on ? ICO.starFill : ICO.star}</span>
      <button class="record-delete danger ghost icon-btn btn-sm" data-hide-record="${esc(r.sessionId)}" title="${delRecTitle}" aria-label="${esc(delRecAria)}">${ICO.trash}</button>
      <button class="btn-sm" data-hresume="${esc(r.sessionId)}">이어하기</button>
    </div>
  </div>`;
}

function paintTermsBody() {
  const host = $('#termsBody');
  if (!host) return;
  const gen = viewGen;
  for (const m of [...minis]) unmountMini(m);
  if (miniObserver) { miniObserver.disconnect(); miniObserver = null; }
  clearTimeout(viewTimer);

  const tab = state.termsTab || 'active';
  const cons = sortConsolesByState(visibleConsoles());
  const terms = sortTermsByState(state.terms);

  if (tab === 'active') {
    const tf = state.termFilter || '';
    const counts = { all: terms.length + cons.length, busy: 0, idle: 0, exited: 0 };
    for (const t of terms) counts[termStateOf(t)]++;
    for (const c of cons) counts[consoleStateOf(c)]++;
    const shownTerms = tf ? terms.filter((t) => termStateOf(t) === tf) : terms;
    const shownCons = tf === 'exited' ? [] : tf ? cons.filter((c) => consoleStateOf(c) === tf) : cons;
    const mergedActive = [
      ...shownTerms.map((t) => ({ kind: 'term', rank: STATE_RANK[termStateOf(t)] ?? 9, item: t })),
      ...shownCons.map((c) => ({ kind: 'console', rank: STATE_RANK[consoleStateOf(c)] ?? 9, item: c })),
    ].sort((a, b) => a.rank - b.rank);
    const segBtn = (val, label, cnt) => `<button data-tview-filt="${val}" class="${tf === val ? 'on' : ''}">${label} <span class="seg-cnt">${cnt}</span></button>`;
    const controls = `<div class="row" style="justify-content:space-between;gap:10px">
      <div class="seg" role="tablist" aria-label="터미널 상태 탭">
        ${segBtn('', '전체', counts.all)}
        ${segBtn('busy', '실행 중', counts.busy)}
        ${segBtn('idle', '대기', counts.idle)}
        ${segBtn('exited', '종료됨', counts.exited)}
      </div>
      <div class="row" style="gap:8px">
        ${counts.exited ? `<button class="ghost btn-sm" id="btnCleanExited">${ICO.trash} 종료됨 정리 (${counts.exited})</button>` : ''}
        <div class="seg" role="tablist" aria-label="보기 방식">
          <button data-tview-mode="cards" class="${state.termsView !== 'list' ? 'on' : ''}">미리보기</button>
          <button data-tview-mode="list" class="${state.termsView === 'list' ? 'on' : ''}">목록</button>
        </div>
      </div>
    </div>`;

    let body = '';
    if (!mergedActive.length) {
      body = `<div class="h-empty-card"><b>${tf ? '선택한 상태의 터미널이 없습니다' : '열려 있는 터미널이 없습니다'}</b><div class="empty">${tf ? '다른 상태 탭을 선택하거나 새 터미널을 열어보세요.' : '우측 상단 ＋ 새 터미널 버튼으로 세션을 시작하세요.'}</div></div>`;
    } else if (state.termsView === 'list') {
      const rows = mergedActive.map((entry) => {
        if (entry.kind === 'term') {
          const t = entry.item;
          const st = termStateOf(t);
          const kind = t.operator ? 'operator' : t.agent || 'shell';
          const pj = projectOfTerm(t);
          const fk = favKeyOf(`term:${t.id}`), on = !!fk && (state.favs || new Set()).has(fk);
          return `<div class="m-row" data-open-term="${esc(t.id)}">
            ${agentIcon(kind, st === 'exited' ? 'dead' : st === 'busy' ? 'busy' : 'idle')}
            <div class="m-row-main"><div class="m-row-t">${esc(termLabel(t))}</div><div class="m-row-s">${esc(termKindLabel(t))}${base(t.cwd) ? ` · ${esc(base(t.cwd))}` : ''}</div></div>
            <div class="m-row-end">
              ${branchTagHTML(t.branch)}
              ${fk ? `<span class="fav${on ? ' on' : ''}" data-fav="${esc(fk)}" role="button" tabindex="0">${on ? ICO.starFill : ICO.star}</span>` : ''}
              ${pj ? `<span class="badge c">${esc(pj.name)}</span>` : ''}
              <span class="badge ${st === 'exited' ? '' : st === 'busy' ? 'warn' : 'ok'}">${termStatusLabel(t)}</span>
              ${st === 'exited' ? `<button class="ghost icon-btn btn-sm" data-term-close="${esc(t.id)}" aria-label="닫기">${ICO.close}</button>` : ''}
            </div>
          </div>`;
        }
        const c = entry.item;
        const st = consoleStateOf(c);
        return `<div class="m-row" data-open-con="${esc(c.id)}">
          ${agentIcon(sessionOfConsole(c) ? 'claude' : 'shell', st === 'busy' ? 'busy' : 'idle')}
          <div class="m-row-main"><div class="m-row-t">${esc(consoleLabel(c))}</div><div class="m-row-s">외부 콘솔</div></div>
          <div class="m-row-end"><span class="badge agy">외부 콘솔</span><span class="badge ${st === 'busy' ? 'warn' : 'ok'}">${st === 'busy' ? '실행 중' : '대기'}</span></div>
        </div>`;
      }).join('');
      body = `<div class="sheet">${rows}</div>`;
    } else {
      body = `<div class="grid">${mergedActive.map((e) => (e.kind === 'term' ? termCardHTML(e.item) : conCardHTML(e.item))).join('')}</div>`;
    }
    host.innerHTML = `${controls}${body}`;
    if (state.termsView !== 'list') bindMiniTerminals(gen, shownTerms, shownCons);
    return;
  }

  if (tab === 'recent') {
    const rf = state.recentFilter || '';
    const qTerms = termsOf(state.recentQuery);
    const fbtn = (val, label) => `<button data-rfilt="${val}" class="${rf === val ? 'on' : ''}">${label}</button>`;
    const list = (state.recentByAgent?.[rf] || state.recent)
      .filter((r) => (!rf || (r.agent || 'claude') === rf))
      .filter((r) => !qTerms.length || qTerms.every((q) => `${sessionLabel(r)} ${r.cwd || ''}`.toLowerCase().includes(q)))
      .slice(0, 60);
    const bucketOf = (ms) => {
      if (!ms) return '이전';
      const d = new Date(ms), now = new Date();
      const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
      if (d.getTime() >= startToday) return '오늘';
      if (d.getTime() >= startToday - 864e5) return '어제';
      if (d.getTime() >= startToday - 6 * 864e5) return '이번 주';
      return '이전';
    };
    const grouped = [];
    for (const r of list) {
      const b = bucketOf(r.mtime);
      if (!grouped.length || grouped[grouped.length - 1][0] !== b) grouped.push([b, []]);
      grouped[grouped.length - 1][1].push(r);
    }
    const groupsHTML = grouped.map(([b, xs]) => `<div><div class="dayhdr">${b}</div><div class="sheet">${xs.map(recentRowHTML).join('')}</div></div>`).join('')
      || '<div class="h-empty-card"><b>일치하는 최근 대화 기록이 없습니다</b></div>';
    host.innerHTML = `<div class="row" style="justify-content:space-between;gap:10px">
        <div class="seg" role="tablist" aria-label="에이전트 필터">${fbtn('', '전체')}${fbtn('claude', 'Claude')}${fbtn('codex', 'Codex')}${fbtn('agy', 'AGY')}</div>
        <div class="row" style="gap:6px">
          <input id="recFilter" class="btn-sm" type="search" value="${esc(state.recentQuery || '')}" placeholder="목록 필터…" style="width:190px">
          <button class="ghost icon-btn btn-sm" data-rrefresh="1" aria-label="새로고침" title="세션 기록 새로고침">${ICO.refresh}</button>
        </div>
      </div>
      ${groupsHTML}`;
    const inp = $('#recFilter', host);
    if (inp) {
      inp.oninput = () => { state.recentQuery = inp.value; paintTermsBody(); };
    }
    return;
  }

  // Favorites tab
  const favRows = resolvedFavs().map((entry) => {
    const f = entry.key;
    if (entry.kind === 'proj') {
      const p = entry.item;
      const done = (p.tasks || []).filter((t) => t.stage === 'done').length;
      return `<div class="m-row" data-open-proj="${esc(p.id)}"><span class="pj-dot" style="margin:0 6px"></span><div class="m-row-main"><div class="m-row-t">${esc(p.name)}</div><div class="m-row-s">Project · ${done}/${(p.tasks || []).length} 완료</div></div><div class="m-row-end"><span class="fav on" data-fav="${esc(f)}" role="button" tabindex="0">${ICO.starFill}</span><span class="badge c">Project</span></div></div>`;
    }
    if (entry.kind === 'term') {
      const t = entry.item;
      const st = termStateOf(t);
      return `<div class="m-row" data-open-term="${esc(t.id)}">${agentIcon(t.operator ? 'operator' : t.agent || 'shell', st === 'exited' ? 'dead' : st === 'busy' ? 'busy' : 'idle')}<div class="m-row-main"><div class="m-row-t">${esc(termLabel(t))}</div><div class="m-row-s">${esc(base(t.cwd))}</div></div><div class="m-row-end"><span class="fav on" data-fav="${esc(f)}" data-fav-keys="${esc((entry.allKeys || [f]).join(','))}" role="button" tabindex="0">${ICO.starFill}</span><span class="badge ${st === 'exited' ? '' : st === 'busy' ? 'warn' : 'ok'}">${termStatusLabel(t)}</span></div></div>`;
    }
    if (entry.kind === 'sid') {
      const sid = entry.sid;
      const r = entry.item;
      if (r) return recentRowHTML(r);
      return `<div class="m-row" data-key="recent:${esc(sid)}"><span class="dot dead"></span><div class="m-row-main"><div class="m-row-t">${esc(sid.slice(0, 8))}</div><div class="m-row-s">세션 기록</div></div><div class="m-row-end"><span class="fav on" data-fav="${esc(f)}" role="button" tabindex="0">${ICO.starFill}</span></div></div>`;
    }
    return '';
  }).filter(Boolean).join('');
  host.innerHTML = favRows
    ? `<div class="sheet">${favRows}</div>`
    : '<div class="h-empty-card"><b>즐겨찾기한 항목이 없습니다</b><div class="empty">Project·터미널·최근 대화 항목의 별(★)을 눌러 고정할 수 있습니다.</div></div>';
}

function viewTerms() {
  homeKey = homeKeyOf();
  setBar('');
  const cons = visibleConsoles();
  const activeN = state.terms.length + cons.length;
  const favN = resolvedFavs().length;
  const tab = state.termsTab || 'active';
  const tbtn = (id, label, cnt = 0) => `<button role="tab" data-terms-tab="${id}" aria-selected="${tab === id}" class="${tab === id ? 'on' : ''}">${label}${cnt ? ` <span class="seg-cnt">${cnt}</span>` : ''}</button>`;

  $('#view').innerHTML = `<div class="page-wrap">
    <header class="page-hd">
      <div class="page-hd-left">
        <h1>터미널</h1>
        <div class="seg" role="tablist" aria-label="터미널 영역">
          ${tbtn('active', '실행 중', activeN)}
          ${tbtn('recent', '최근 대화')}
          ${tbtn('favs', '즐겨찾기', favN)}
        </div>
      </div>
      <div class="page-hd-acts">
        <button data-hopen-new="1" class="primary">${ICO.plus} 새 터미널</button>
      </div>
    </header>
    <div id="termsBody" style="display:flex;flex-direction:column;gap:14px"></div>
  </div>`;
  paintTermsBody();

  $('#view').onclick = async (e) => {
    if (e.target.closest('[data-hopen-new]')) return openNewTermDrawer();
    const tabBtn = e.target.closest('[data-terms-tab]');
    if (tabBtn) { state.termsTab = tabBtn.dataset.termsTab; return viewTerms(); }
    const fbtn = e.target.closest('[data-tview-filt]');
    if (fbtn) { state.termFilter = fbtn.dataset.tviewFilt; return paintTermsBody(); }
    const mbtn = e.target.closest('[data-tview-mode]');
    if (mbtn) { state.termsView = mbtn.dataset.tviewMode; return paintTermsBody(); }
    if (e.target.closest('#btnCleanExited')) {
      const exitedIds = state.terms.filter((t) => t.exited !== null).map((t) => t.id);
      if (!exitedIds.length) return;
      for (const id of exitedIds) await api('/api/term/close', { method: 'POST', body: { id } }).catch(() => {});
      await refreshOverview();
      toast(`종료된 터미널 ${exitedIds.length}개를 정리했습니다`);
      return viewTerms();
    }
    const closeBtn = e.target.closest('[data-term-close]');
    if (closeBtn) {
      e.stopPropagation();
      await api('/api/term/close', { method: 'POST', body: { id: closeBtn.dataset.termClose } });
      await refreshOverview();
      return viewTerms();
    }
    const rrBtn = e.target.closest('[data-rrefresh]');
    if (rrBtn) { e.stopPropagation(); rrBtn.disabled = true; refreshRecent(true).finally(() => { rrBtn.disabled = false; paintTermsBody(); }); return; }
    const rfBtn = e.target.closest('[data-rfilt]');
    if (rfBtn) { e.stopPropagation(); state.recentFilter = rfBtn.dataset.rfilt; paintTermsBody(); refreshRecent(); return; }
    const star = e.target.closest('[data-fav]');
    if (star) {
      e.stopPropagation();
      const key = star.dataset.fav;
      const keys = star.dataset.favKeys ? star.dataset.favKeys.split(',').filter(Boolean) : [key];
      const on = !keys.some((k) => (state.favs || new Set()).has(k));
      api('/api/favorites', { method: 'POST', body: on ? { key, on: true } : { key, keys, on: false } }).then((r) => {
        if (r.favs) {
          state.favs = new Set(r.favs);
          renderSide();
          if (state.sel.kind === 'terms') viewTerms();
        }
      }).catch((er) => toast(er.message, 5000, 'danger'));
      return;
    }
    const remove = e.target.closest('[data-hide-record]');
    if (remove) { e.stopPropagation(); return hideRecentRecord(remove.dataset.hideRecord, remove); }
    const resBtn = e.target.closest('[data-hresume]');
    if (resBtn) { e.stopPropagation(); return resumeRecentSession(resBtn.dataset.hresume, resBtn); }
    const openProj = e.target.closest('[data-open-proj]');
    if (openProj) return typeof openProject === 'function' ? openProject(openProj.dataset.openProj) : select({ kind: 'projects', id: openProj.dataset.openProj });
    const openT = e.target.closest('[data-open-term]');
    if (openT) return select({ kind: 'term', id: openT.dataset.openTerm });
    const openC = e.target.closest('[data-open-con]');
    if (openC) return select({ kind: 'console', id: openC.dataset.openCon });
    const recRow = e.target.closest('[data-key^="recent:"]');
    if (recRow) return select({ kind: 'recent', id: recRow.dataset.key.slice(7) }, 'chat');
    const card = e.target.closest('.card');
    if (!card) return;
    if (card.dataset.term) select({ kind: 'term', id: card.dataset.term });
    else select({ kind: 'console', id: card.dataset.id });
  };
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
  if (document.hidden || !['home', 'terms', 'projects'].includes(state.sel.kind) || !miniObserver) return;
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

function dockTopSegHTML({ openSet, isContentTab = false, hasTerm = true, hasChat = true, showFiles = true, curTab = 'dock', termTitle = '터미널 패널 열기/닫기' }) {
  const on = (id) => !isContentTab && openSet.has(id);
  return `<div class="seg" role="tablist">
    ${hasTerm ? `<button type="button" data-dock-toggle="term" aria-pressed="${on('term')}" class="${on('term') ? 'on' : ''}" title="${esc(termTitle)}">${ICO.terminal} 터미널</button>` : ''}
    ${hasChat ? `<button type="button" data-dock-toggle="chat" aria-pressed="${on('chat')}" class="${on('chat') ? 'on' : ''}" title="대화 기록 패널 열기/닫기">${ICO.chat} 대화 기록</button>` : ''}
    <button type="button" data-dock-toggle="windows" aria-pressed="${on('windows')}" class="${on('windows') ? 'on' : ''}" title="연결된 창 · 브라우저 미리보기 패널 열기/닫기">${ICO.monitor} 창 <span class="seg-cnt" data-dock-win-cnt>0</span></button>
    ${showFiles ? `<button type="button" data-tab="files" class="${curTab === 'files' ? 'on' : ''}" title="이 세션의 산출물 보기 및 지정">산출물</button>` : ''}
    <button type="button" data-tab="floorplan" class="${curTab === 'floorplan' ? 'on' : ''}" title="코드 구조(Floorplan) 및 보안·품질 점검">${ICO.layers} 코드 구조</button>
  </div>`;
}

function syncBarDockButtons(openList) {
  const set = new Set(openList || []);
  $('#bar')?.querySelectorAll('[data-dock-toggle]').forEach((b) => {
    const isOn = set.has(b.dataset.dockToggle);
    b.classList.toggle('on', isOn);
    b.setAttribute('aria-pressed', String(isOn));
  });
}

function mountConsoleScreen(hostEl, { pid, gen, s }) {
  if (!hostEl) return;
  const keysOpen = getTuiKeysOpen();
  hostEl.innerHTML = `<div class="full">
    <div class="scr-wrap"><pre class="screen" id="scr">불러오는 중…</pre><button type="button" class="scroll-bottom-btn term-bottom-float" id="btnConFloatBottom" hidden title="터미널 최하단으로 이동" aria-label="터미널 최하단으로 이동">${ICO.chevDown}<span>최하단</span></button></div>
    <div class="term-dock">
      <div class="tdock-bar">
        <div class="tdock-tools">
          <label class="filebtn" title="PC 파일·스크린샷 첨부 → 경로 입력">${ICO.clip}<span>파일 첨부</span><input type="file" class="fpick" multiple hidden></label>
          <button data-copy="1" title="선택한 부분(없으면 화면 전체) 복사">${ICO.copy}<span>화면 복사</span></button>
          <button type="button" id="btnConBottom" title="터미널 최하단으로 이동">${ICO.chevDown}<span>최하단</span></button>
        </div>
        <div class="tdock-keys-wrap">
          <button class="ghost btn-sm" id="btnTuiKeys" aria-expanded="${keysOpen}" title="TUI 방향키·제어키 패드 접기/펼치기">${ICO.keyboard}<span>TUI 키</span></button>
          <div class="tdock-keys" id="tuiKeysBox" ${keysOpen ? '' : 'hidden'}>
            <button data-key="esc" title="Esc">Esc</button><button data-key="up" title="위로">↑</button><button data-key="down" title="아래로">↓</button>
            <button data-key="tab" title="Tab">Tab</button><button data-key="ctrl+c" title="Ctrl+C">^C</button><button data-key="enter" title="Enter">⏎</button>
          </div>
        </div>
      </div>
      <div class="tdock-comp">
        <textarea id="inp" rows="1" placeholder="보낼 내용 입력 (Enter 전송 · Shift+Enter 줄바꿈 · 빈 칸에서 ↑↓/Esc는 창으로 전달)"></textarea>
        <button class="primary" id="btnSend">보내기 ⏎</button>
      </div>
    </div>
  </div>`;
  const fullEl = $('.full', hostEl);
  const tkBtn = $('#btnTuiKeys', fullEl), tkBox = $('#tuiKeysBox', fullEl);
  if (tkBtn && tkBox) tkBtn.onclick = () => {
    const next = tkBox.hidden;
    tkBox.hidden = !next;
    tkBtn.setAttribute('aria-expanded', String(next));
    try { localStorage.setItem('ccd.tuiKeysOpen', next ? '1' : '0'); } catch {}
  };
  const inp = $('#inp', fullEl);
  const fitInp = () => { inp.style.height = 'auto'; inp.style.height = Math.min(140, Math.max(36, inp.scrollHeight)) + 'px'; };
  inp.addEventListener('input', fitInp);
  const scrEl = $('#scr', fullEl);
  const conFloatBtn = $('#btnConFloatBottom', fullEl);
  const syncConBottom = () => {
    if (!conFloatBtn || !scrEl) return;
    conFloatBtn.hidden = !(scrEl.scrollHeight - scrEl.scrollTop - scrEl.clientHeight > 40);
  };
  const scrollConBottom = () => {
    if (!scrEl) return;
    scrEl.scrollTo({ top: scrEl.scrollHeight, behavior: 'smooth' });
    setTimeout(syncConBottom, 180);
  };
  if (scrEl) scrEl.addEventListener('scroll', syncConBottom, { passive: true });
  if ($('#btnConBottom', fullEl)) $('#btnConBottom', fullEl).onclick = scrollConBottom;
  if (conFloatBtn) conFloatBtn.onclick = scrollConBottom;
  const tick = async () => {
    const r = await api(`/api/console/read?pid=${pid}`).catch((e) => ({ error: e.message }));
    if (gen !== viewGen || !hostEl.isConnected) return;
    paintScreen(scrEl, r);
    syncConBottom();
    clearTimeout(viewTimer);
    viewTimer = setTimeout(tick, 1000);
  };
  const sendKey = async (k) => {
    await api('/api/console/send', { method: 'POST', body: { pid, keys: [k] } });
    setTimeout(tick, 150);
  };
  const sendText = async () => {
    const text = inp.value;
    inp.value = ''; fitInp();
    const r = await api('/api/console/send', { method: 'POST', body: text ? { pid, text, submit: true } : { pid, keys: ['enter'] } });
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
  $('#btnSend', fullEl).onclick = sendText;
  fullEl.onclick = async (e) => {
    if (e.target.closest('[data-copy]')) return copyText(selectionIn(scrEl) || scrEl.textContent);
    const k = e.target.closest('[data-key]')?.dataset.key;
    if (k) sendKey(k);
  };
  tick();
  const addPath = (txt) => { inp.value += (inp.value && !inp.value.endsWith(' ') ? ' ' : '') + txt; fitInp(); inp.focus(); };
  attachFileInput(fullEl, addPath, s?.cwd);
  bindFilePick(fullEl, addPath, s?.cwd);
  inp.focus();
}

function viewConsole() {
  const gen = viewGen;
  const pid = Number(state.sel.id);
  const c = state.consoles.find((x) => String(x.id) === state.sel.id);
  const s = c && sessionOfConsole(c);
  const sid = s?.sessionId || state.sel.session;
  const isContentTab = (state.tab === 'files' && !!sid) || state.tab === 'floorplan';
  let initialPanels = window.ACH_DOCK ? window.ACH_DOCK.getDockOpen('term', isContentTab ? null : state.tab) : ['term'];
  if (!sid) initialPanels = initialPanels.filter((p) => p !== 'chat');
  if (!initialPanels.length) initialPanels = ['term'];

  setBar(`<button id="btnBackTerms" class="ghost btn-sm">${ICO.chevLeft} 터미널</button><h2><span>${esc(c ? consoleLabel(c) : 'pid ' + state.sel.id)}</span></h2>
    ${dockTopSegHTML({ openSet: new Set(initialPanels), isContentTab, hasTerm: true, hasChat: !!sid, showFiles: !!sid, curTab: state.tab })}
    <button id="btnConMore" class="ghost icon-btn btn-sm desk" aria-label="콘솔 메뉴" aria-haspopup="menu" aria-expanded="false">${ICO.more}</button>`);

  let dock = null;
  $('#bar').onclick = (e) => {
    if (e.target.closest('#btnBackTerms')) return select({ kind: 'terms' });
    const dt = e.target.closest('[data-dock-toggle]');
    if (dt) {
      const p = dt.dataset.dockToggle;
      if (isContentTab || !dock) {
        const next = new Set(initialPanels);
        next.add(p);
        window.ACH_DOCK?.saveDockOpen('term', [...next]);
        return select(state.sel, 'dock', true);
      }
      dock.togglePanel(p);
      return;
    }
    const b = e.target.closest('[data-tab]');
    if (b) return select(state.sel, b.dataset.tab, true);
    const more = e.target.closest('#btnConMore');
    if (more) {
      e.stopPropagation();
      openMoreMenu(more, [
        { label: '창 앞으로 가져오기', icon: ICO.external, onClick: () => api('/api/console/focus', { method: 'POST', body: { pid } }) },
        sid ? { label: '다른 계정 · 에이전트로 이어하기', icon: ICO.swap, onClick: () => openSwitch(sid) } : null,
      ]);
    }
  };
  if (state.tab === 'files' && sid) return renderArtifacts(sid, gen);
  if (state.tab === 'floorplan' && typeof renderStandaloneFloorplan === 'function') {
    return renderStandaloneFloorplan(s?.cwd || '', gen, {
      sessionId: sid || '',
      onInsertPrompt: async (txt, submit) => {
        if (submit) {
          await api('/api/console/send', { method: 'POST', body: { pid, text: txt, submit: true } });
          toast('콘솔 창에 수정 지시를 전달했습니다');
        } else {
          await copyText(txt);
        }
        select(state.sel, 'dock', true);
      },
    });
  }

  let winCtl = null;
  let chatMounted = false;
  let chatScrollEl = null;
  const ensureChatMounted = () => {
    if (chatMounted || !sid || !dock) return;
    chatMounted = true;
    const body = dock.getBody('chat');
    body.innerHTML = `<div class="chat-shell"><div class="chat-scroll" data-dock-chat-scroll></div><div data-dock-chat-comp></div></div>`;
    chatScrollEl = $('[data-dock-chat-scroll]', body);
    renderChat(sid, gen, -1, [], chatScrollEl);
    mountChatComposer({
      barHost: $('[data-dock-chat-comp]', body),
      chatHost: chatScrollEl,
      sid,
      consolePid: pid,
      agent: s?.agent || 'claude',
      cwd: s?.cwd || '',
      compact: true,
      onJumpTerm: () => dock?.togglePanel('term', true),
    });
  };

  dock = window.ACH_DOCK.createDockWorkspace({
    hostEl: $('#view'),
    mode: 'term',
    openPanels: initialPanels,
    panelsMeta: {
      term: { title: '터미널', icon: ICO.terminal },
      ...(sid ? { chat: { title: '대화 기록', icon: ICO.chat, onShow: ensureChatMounted } } : {}),
      windows: { title: '창', icon: ICO.monitor, onShow: () => winCtl?.renderWindows() },
    },
    onOpenChange: (openList) => syncBarDockButtons(openList),
  });

  mountConsoleScreen(dock.getBody('term'), { pid, gen, s });
  if (sid && dock.isOpen('chat')) ensureChatMounted();
  winCtl = window.ACH_DOCK.mountWindowsPane({
    rootEl: dock.getBody('windows'),
    consolePid: pid,
    gen,
    isOpen: () => !!dock?.isOpen('windows'),
    onCount: (n) => { const c = $('#bar [data-dock-win-cnt]'); if (c) c.textContent = String(n); },
  });
}
function alertBar(msg) {
  toast(msg, 5000, 'danger');
}

async function hideRecentRecord(id, button) {
  if (!confirm('이 대화 기록을 삭제할까요? 허브와 기본 CLI(Claude · Codex · Antigravity) 기록에서도 함께 삭제됩니다.')) return;
  button.disabled = true;
  try {
    const r = await api('/api/recent/hide', { method: 'POST', body: { id } });
    if (r.error || !r.ok) throw new Error(r.error || '기록을 삭제할 수 없습니다.');
    state.favs.delete('sid:' + id);
    await refreshRecent();
    toast('허브 및 기본 CLI 대화 기록을 삭제했습니다');
    if (state.sel.kind === 'recent' && state.sel.id === id) select({ kind: 'home' });
  } catch (e) { toast(e.message); }
  finally { button.disabled = false; }
}

function viewTranscript() {
  const gen = viewGen;
  const sid = state.sel.id;
  const r = recentSession(sid);
  const live = state.live.find((x) => x.sessionId === sid);
  const linkedTerm = state.terms.find((x) => x.exited === null && x.sessionId === sid) || null;
  const linkedConPid = !linkedTerm && live && !isDesktopSession(live) ? consoleOf(live.pid)?.id : null;
  const hasLivePane = !!(linkedTerm || linkedConPid);
  const hasCwd = !!(r?.cwd || live?.cwd);
  const openExternal = async (isIde) => {
    const kind = r?.agent === 'codex' ? 'codex' : r?.agent === 'agy' ? 'agy' : 'claude';
    const res = await api('/api/term/external', {
      method: 'POST',
      body: { kind, resume: sid, cwd: r?.cwd || live?.cwd, skipPermissions: true, ide: isIde },
    });
    if (res.error) return toast(res.error, 6000, 'danger');
    toast(isIde ? 'IDE에서 작업 폴더를 열었습니다' : '외부 Windows 콘솔 창에서 세션을 열었습니다');
    setTimeout(refreshOverview, 1200);
  };
  const resumeToDockTerm = async (openWithChat = true) => {
    const compBar = $('#transcriptCompHost', dock?.getBody('chat') || document);
    if (compBar?._launchResume) return compBar._launchResume(openWithChat);
    const body = r?.agent === 'codex'
      ? { kind: 'codex', resume: sid, cwd: r.cwd }
      : r?.agent === 'agy'
        ? { kind: 'agy', resume: sid, cwd: r.cwd }
        : { kind: 'claude', resume: sid, cwd: r?.cwd || live?.cwd, skipPermissions: true, fork: !!(live && isDesktopSession(live)) };
    const t = await api('/api/term/new', { method: 'POST', body });
    if (t.error) return toast(t.error, 6000, 'danger');
    if (openWithChat) window.ACH_DOCK?.saveDockOpen('term', ['term', 'chat']);
    await refreshOverview();
    openResumedTerm(t, body);
  };

  const isContentTab = state.tab === 'files' || state.tab === 'floorplan';
  let initialPanels = window.ACH_DOCK ? window.ACH_DOCK.getDockOpen('recent') : ['chat'];
  if (!hasLivePane) initialPanels = initialPanels.filter((p) => p !== 'term');
  if (!initialPanels.length) initialPanels = ['chat'];

  setBar(`<button id="btnBackRecent" class="ghost btn-sm">${ICO.chevLeft} 최근 대화</button><h2><span>${esc(sessionLabel(r, sid, live?.name))}</span></h2>
    <button id="btnRenameSess" class="ghost icon-btn btn-sm" title="대화 제목 수정" aria-label="대화 제목 수정">${ICO.edit}</button>
    ${branchTagHTML(r?.branch)}${agentBadge(r?.agent)}
    ${dockTopSegHTML({
      openSet: new Set(initialPanels),
      isContentTab,
      hasTerm: true,
      hasChat: true,
      showFiles: true,
      curTab: state.tab,
      termTitle: hasLivePane ? '연결된 터미널 패널 열기/닫기' : '이 세션을 터미널로 열어 함께 보기',
    })}
    ${!live ? `<button class="primary btn-sm" id="btnResume">${ICO.play} 대시보드에서 이어하기</button>` : isDesktopSession(live) ? `<button class="primary btn-sm" id="btnResume" data-fork="1" title="데스크톱 앱 대화를 여기까지 복제한 새 세션으로 이어갑니다">${ICO.play} 대시보드에서 이어하기 (복제)</button>` : ''}
    <button id="btnRecMore" class="ghost icon-btn btn-sm" aria-label="세션 메뉴" aria-haspopup="menu" aria-expanded="false">${ICO.more}</button>`);

  let dock = null;
  $('#bar').onclick = async (e) => {
    if (e.target.closest('#btnBackRecent')) { state.termsTab = 'recent'; return select({ kind: 'terms' }); }
    if (e.target.closest('#btnRenameSess')) {
      const curTitle = sessionLabel(r, sid, live?.name);
      const next = prompt('새 대화 제목을 입력하세요:', curTitle);
      if (next === null) return;
      const res = await api('/api/transcript/title', { method: 'POST', body: { id: sid, title: next.trim() } });
      if (res.error) return toast(res.error, 4000, 'danger');
      if (r) r.title = res.title || null;
      await refreshOverview();
      toast('대화 제목을 수정했습니다');
      return viewTranscript();
    }
    const dt = e.target.closest('[data-dock-toggle]');
    if (dt) {
      const p = dt.dataset.dockToggle;
      if (p === 'term' && !hasLivePane) {
        return resumeToDockTerm(true);
      }
      if (isContentTab || !dock) {
        const next = new Set(initialPanels);
        next.add(p);
        window.ACH_DOCK?.saveDockOpen('recent', [...next]);
        return select(state.sel, 'dock', true);
      }
      dock.togglePanel(p);
      return;
    }
    const tb = e.target.closest('[data-tab]');
    if (tb) return select(state.sel, tb.dataset.tab, true);
    const more = e.target.closest('#btnRecMore');
    if (more) {
      e.stopPropagation();
      return openMoreMenu(more, [
        { label: '현재 시점에서 분기 만들기', icon: ICO.branch, onClick: () => openBranchDialog({ sid, atIndex: null, agent: r?.agent || 'claude', cwd: r?.cwd || live?.cwd }) },
        { label: '다른 계정 · 에이전트로 이어하기', icon: ICO.swap, onClick: () => openSwitch(sid) },
        { label: '외부 창으로 열기', icon: ICO.external, onClick: () => openExternal(false) },
        hasCwd && !IS_REMOTE ? { label: 'IDE에서 열기', icon: ICO.folder, onClick: () => openExternal(true) } : null,
        { label: `세션 ID 복사 (${sid.slice(0, 8)})`, icon: ICO.copy, onClick: () => copyText(sid) },
        { divider: true },
        { label: '기록 삭제', icon: ICO.trash, tone: 'danger', onClick: () => hideRecentRecord(sid, more) },
      ]);
    }
    if (e.target.id !== 'btnResume') return;
    return resumeToDockTerm(true);
  };
  if (state.tab === 'files') return renderArtifacts(sid, gen);
  if (state.tab === 'floorplan' && typeof renderStandaloneFloorplan === 'function') {
    return renderStandaloneFloorplan(r?.cwd || live?.cwd || '', gen, { sessionId: sid || '' });
  }

  let winCtl = null;
  let termMounted = false;
  let chatScrollEl = null;
  const ensureTermMounted = () => {
    if (termMounted || !hasLivePane || !dock) return;
    termMounted = true;
    const body = dock.getBody('term');
    if (linkedTerm) mountManagedTermScreen(body, { t: linkedTerm, gen, chatHost: chatScrollEl });
    else if (linkedConPid) mountConsoleScreen(body, { pid: linkedConPid, gen, s: live });
  };

  dock = window.ACH_DOCK.createDockWorkspace({
    hostEl: $('#view'),
    mode: 'recent',
    openPanels: initialPanels,
    panelsMeta: {
      ...(hasLivePane ? { term: { title: '터미널', icon: ICO.terminal, onShow: ensureTermMounted } } : {}),
      chat: { title: '대화 기록', icon: ICO.chat },
      windows: { title: '창', icon: ICO.monitor, onShow: () => winCtl?.renderWindows() },
    },
    onOpenChange: (openList) => syncBarDockButtons(openList),
  });

  const chatBody = dock.getBody('chat');
  chatBody.innerHTML = `<div class="chat-shell">
    <div class="chat-scroll" id="chatScrollHost"></div>
    <div id="transcriptCompHost"></div>
  </div>`;
  chatScrollEl = $('#chatScrollHost', chatBody);
  renderChat(sid, gen, state.sel.at ?? -1, termsOf(state.sel.q), chatScrollEl);
  mountChatComposer({
    barHost: $('#transcriptCompHost', chatBody),
    chatHost: chatScrollEl,
    sid,
    consolePid: linkedConPid || null,
    agent: r?.agent || 'claude',
    cwd: r?.cwd || live?.cwd || '',
    liveDesktop: !!(live && isDesktopSession(live)),
    onJumpTerm: (tid, cpid) => {
      if (hasLivePane && dock) dock.togglePanel('term', true);
      else if (tid) select({ kind: 'term', id: tid }, 'split');
      else if (cpid) select({ kind: 'console', id: String(cpid) }, 'split');
    },
  });
  if (hasLivePane && dock.isOpen('term')) ensureTermMounted();
  winCtl = window.ACH_DOCK.mountWindowsPane({
    rootEl: dock.getBody('windows'),
    termId: linkedTerm?.id || null,
    consolePid: linkedConPid || null,
    gen,
    isOpen: () => !!dock?.isOpen('windows'),
    onCount: (n) => { const c = $('#bar [data-dock-win-cnt]'); if (c) c.textContent = String(n); },
  });
}

const chatLaunchPrefs = new Map();

function mountChatComposer({ barHost, chatHost = null, sid = null, termId = null, consolePid = null, agent = 'claude', cwd = '', liveDesktop = false, onJumpTerm = null, compact = false }) {
  if (!barHost) return;
  let activeTermId = termId ? String(termId) : null;
  let activeConsolePid = consolePid ? Number(consolePid) : null;
  const baseAgent = (agent === 'codex' || agent === 'agy') ? agent : 'claude';
  const prefKey = sid || (activeTermId ? `term:${activeTermId}` : '');

  const findLiveTerm = () => {
    if (activeTermId) {
      const byId = state.terms.find((x) => String(x.id) === activeTermId && x.exited === null);
      if (byId) return byId;
    }
    if (sid) return state.terms.find((x) => x.exited === null && x.sessionId === sid) || null;
    return null;
  };

  const ltInit = findLiveTerm();
  const savedPref = prefKey ? chatLaunchPrefs.get(prefKey) : null;
  const initAgent = ltInit?.agent || savedPref?.agent || baseAgent;
  const savedCliDef = (!ltInit && typeof readSavedCliDefaults === 'function')
    ? readSavedCliDefaults(initAgent)
    : { account: '', model: '', effort: '' };
  const initModel = ltInit ? (ltInit.model || '') : (savedPref ? (savedPref.model ?? '') : (savedCliDef.model || ''));
  const initEffort = ltInit ? (ltInit.effort || '') : (savedPref ? (savedPref.effort ?? '') : (savedCliDef.effort || ''));

  barHost.innerHTML = `<div class="chat-reply-bar${compact ? ' compact' : ''}">
    <div class="chat-conn-bar">
      <span class="chat-conn-pill" data-chat-conn></span>
      <span class="row" style="gap:6px"><button type="button" class="ghost btn-sm" data-chat-jump hidden style="min-height:22px;height:22px;font-size:11.5px;padding:0 7px">터미널 보기 ↗</button></span>
    </div>
    <div class="chat-me-bar" data-chat-me>
      <select data-chat-acc title="사용할 계정 · CLI 선택" aria-label="계정 및 CLI">
        <option value="__cli__:${esc(initAgent)}" data-agent="${esc(initAgent)}">${esc(providerName(initAgent))} (기본)</option>
      </select>
      <select data-chat-model-pick title="선택한 계정 CLI에 맞는 모델" aria-label="모델"></select>
      <input data-chat-model maxlength="120" placeholder="모델 ID 직접 입력" style="display:none" aria-label="모델 ID 직접 입력">
      <select data-chat-effort title="선택한 계정 CLI에 맞는 추론 성능" aria-label="추론 성능"></select>
      <button type="button" class="btn-sm primary" data-chat-apply hidden>변경 적용</button>
    </div>
    <div class="chat-reply-in">
      <textarea rows="1" placeholder="대화 기록에서 바로 프롬프트 입력 (Enter 전송 · Shift+Enter 줄바꿈)"></textarea>
      <button type="button" class="primary">보내기 ⏎</button>
    </div>
  </div>`;

  const connEl = $('[data-chat-conn]', barHost);
  const jumpBtn = $('[data-chat-jump]', barHost);
  const accSel = $('[data-chat-acc]', barHost);
  const applyBtn = $('[data-chat-apply]', barHost);
  const repIn = $('textarea', barHost);
  const repBtn = $('.chat-reply-in button.primary', barHost);

  let baselineAccId = ltInit?.account?.id || `__cli__:${initAgent}`;
  let meCtl = null;

  const getSelectedAgent = () => accSel?.selectedOptions?.[0]?.dataset?.agent || initAgent;
  const getConfig = () => {
    const me = meCtl ? meCtl.getValues() : { model: '', effort: '' };
    return {
      account: accSel?.value || `__cli__:${initAgent}`,
      agent: getSelectedAgent(),
      model: me.model || '',
      effort: me.effort || '',
    };
  };

  const syncApplyBtn = () => {
    if (!applyBtn || !barHost.isConnected) return;
    const cfg = getConfig();
    if (prefKey) chatLaunchPrefs.set(prefKey, cfg);
    const lt = findLiveTerm();
    if (lt) {
      const ltAgent = lt.agent || baseAgent;
      const ltAcc = lt.account?.id || baselineAccId || `__cli__:${ltAgent}`;
      const accChanged = cfg.account !== ltAcc && !(cfg.account === `__cli__:${ltAgent}` && !lt.account?.id);
      const dirty = accChanged || cfg.agent !== ltAgent || cfg.model !== (lt.model || '') || cfg.effort !== (lt.effort || '');
      applyBtn.hidden = !dirty;
      applyBtn.textContent = '변경 적용';
      applyBtn.className = 'btn-sm primary';
      applyBtn.title = '선택한 계정 · CLI · 모델 · 추론 성능으로 대화를 이어서 다시 시작합니다';
    } else if (!activeConsolePid) {
      const accDiff = !!cfg.account && !cfg.account.startsWith('__cli__:') && cfg.account !== baselineAccId;
      const nonDefault = cfg.agent !== baseAgent || accDiff || !!cfg.model || !!cfg.effort;
      applyBtn.hidden = !nonDefault;
      applyBtn.textContent = cfg.agent !== baseAgent ? '이 CLI로 이어하기' : '이 설정으로 열기';
      applyBtn.className = 'btn-sm';
      applyBtn.title = '선택한 계정 · CLI · 모델 · 추론 성능으로 터미널을 열어 이어갑니다';
    } else {
      applyBtn.hidden = true;
    }
  };

  if (typeof createCliModelEffortController === 'function') {
    meCtl = createCliModelEffortController({
      modelPick: $('[data-chat-model-pick]', barHost),
      modelIn: $('[data-chat-model]', barHost),
      effortSel: $('[data-chat-effort]', barHost),
      initialKind: initAgent,
      initialModel: initModel,
      initialEffort: initEffort,
      useSavedDefaults: !ltInit,
      persistDefaults: true,
      onChange: syncApplyBtn,
    });
  }

  accSel.onchange = () => {
    const nextAg = getSelectedAgent();
    if (typeof saveCliDefaults === 'function') saveCliDefaults(nextAg, { account: accSel.value });
    meCtl?.setCli(nextAg);
    syncApplyBtn();
  };

  const loadCandidates = async () => {
    try {
      const r = await api(`/api/switch/candidates?id=${encodeURIComponent(sid || '')}${activeTermId ? `&term=${encodeURIComponent(activeTermId)}` : ''}`);
      if (!barHost.isConnected || !Array.isArray(r?.candidates)) return;
      const lt = findLiveTerm();
      const curTermAgent = lt?.agent || baseAgent;
      const curAccFromResp = r.candidates.find((c) => c.current);
      if (curAccFromResp) baselineAccId = curAccFromResp.id;

      const cliOrder = [curTermAgent, ...['claude', 'codex', 'agy'].filter((k) => k !== curTermAgent)];
      const frag = document.createDocumentFragment();
      for (const cliKey of cliOrder) {
        const list = r.candidates.filter((c) => (c.agent || 'claude') === cliKey);
        const og = document.createElement('optgroup');
        og.label = providerName(cliKey);
        if (list.length) {
          for (const c of list) {
            const opt = new Option(`${c.label}${c.current ? ' · 현재' : ''}`, c.id);
            opt.dataset.agent = c.agent || cliKey;
            og.appendChild(opt);
          }
        } else {
          const opt = new Option(`${providerName(cliKey)} (기본 로그인)`, `__cli__:${cliKey}`);
          opt.dataset.agent = cliKey;
          og.appendChild(opt);
        }
        frag.appendChild(og);
      }
      accSel.replaceChildren(frag);

      const savedDefForInit = (!lt && typeof readSavedCliDefaults === 'function') ? readSavedCliDefaults(initAgent) : { account: '' };
      const savedAccOpt = savedDefForInit.account
        ? [...accSel.options].find((o) => o.value === savedDefForInit.account && o.dataset.agent === initAgent)
        : null;
      const wantAcc = (savedPref?.account && [...accSel.options].some((o) => o.value === savedPref.account))
        ? savedPref.account
        : (curAccFromResp?.id && [...accSel.options].some((o) => o.value === curAccFromResp.id))
          ? curAccFromResp.id
          : (savedAccOpt?.value || [...accSel.options].find((o) => o.dataset.agent === initAgent)?.value || accSel.options[0]?.value || '');
      baselineAccId = curAccFromResp?.id || [...accSel.options].find((o) => o.dataset.agent === baseAgent)?.value || baselineAccId;
      if (wantAcc) accSel.value = wantAcc;
      const curSelectedAg = getSelectedAgent();
      const postDef = (!lt && typeof readSavedCliDefaults === 'function') ? readSavedCliDefaults(curSelectedAg) : { model: '', effort: '' };
      const postModel = lt ? initModel : (savedPref ? initModel : postDef.model);
      const postEffort = lt ? initEffort : (savedPref ? initEffort : postDef.effort);
      meCtl?.setCli(curSelectedAg, postModel, postEffort);
      syncApplyBtn();
    } catch {}
  };
  loadCandidates();

  const syncConn = () => {
    if (!barHost.isConnected) return;
    const lt = findLiveTerm();
    if (lt) {
      activeTermId = String(lt.id);
      const st = termStateOf(lt);
      const dotCls = st === 'busy' ? 'busy' : 'idle';
      const stTxt = st === 'busy' ? '실행 중' : '대기';
      const meBadge = [lt.model, lt.effort].filter(Boolean).join('/');
      connEl.innerHTML = `<span class="dot ${dotCls}" style="width:7px;height:7px"></span><span>터미널 t:${esc(lt.id)} 연결됨 · ${esc(stTxt)}${meBadge ? ` · ${esc(meBadge)}` : ''}</span>`;
      if (jumpBtn) jumpBtn.hidden = !onJumpTerm;
    } else if (activeConsolePid) {
      connEl.innerHTML = `<span class="dot idle" style="width:7px;height:7px"></span><span>콘솔 pid:${esc(activeConsolePid)} 연결됨</span>`;
      if (jumpBtn) jumpBtn.hidden = !onJumpTerm;
    } else {
      connEl.innerHTML = `<span class="ums" style="margin:0">연결된 터미널 없음 · 입력 시 세션을 이어 열어 전송합니다</span>`;
      if (jumpBtn) jumpBtn.hidden = true;
    }
    syncApplyBtn();
  };
  syncConn();
  const connTimer = setInterval(() => {
    if (!barHost.isConnected) return clearInterval(connTimer);
    syncConn();
  }, 1500);

  if (jumpBtn && onJumpTerm) {
    jumpBtn.onclick = () => {
      const lt = findLiveTerm();
      onJumpTerm(lt?.id || null, activeConsolePid);
    };
  }

  const fitRep = () => { repIn.style.height = 'auto'; repIn.style.height = Math.min(140, Math.max(38, repIn.scrollHeight)) + 'px'; };
  repIn.addEventListener('input', fitRep);

  const notifySent = (targetTermId, text) => {
    if (!chatHost) return;
    chatHost._liveChatHint = {
      termId: targetTermId ? String(targetTermId) : '',
      consolePid: activeConsolePid || null,
      pendingText: text,
      sentAt: Date.now(),
      until: Date.now() + 30000,
    };
    chatHost._triggerPoll?.();
  };

  const launchWithConfig = async ({ openTerm = false, pendingText = '' } = {}) => {
    const cfg = getConfig();
    if (typeof saveCliDefaults === 'function') {
      saveCliDefaults(cfg.agent, { account: cfg.account, model: cfg.model, effort: cfg.effort });
    }
    const lt = findLiveTerm();
    const needsSwitch = !!lt || cfg.agent !== baseAgent || (!!cfg.account && !cfg.account.startsWith('__cli__:'));
    if (needsSwitch) {
      const payload = {
        sessionId: sid || undefined,
        termId: lt?.id || undefined,
        account: cfg.account || `__cli__:${cfg.agent}`,
        model: cfg.model,
        effort: cfg.effort,
        cont: false,
        skip: true,
        openMode: 'dashboard',
      };
      const res = await runSwitchRequest(payload);
      if (!res?.ok) throw new Error(res?.error || '설정 변경 적용에 실패했습니다');
      if (res.term) {
        activeTermId = String(res.term.id);
        baselineAccId = cfg.account;
        if (prefKey) chatLaunchPrefs.set(prefKey, cfg);
      }
      await refreshOverview();
      if (pendingText && res.term?.id) {
        setTimeout(() => {
          api('/api/term/send', { method: 'POST', body: { id: res.term.id, text: pendingText, submit: true } }).catch(() => {});
        }, 2600);
        notifySent(res.term.id, pendingText);
      }
      if (res.term) {
        if (openTerm || state.sel.kind === 'term') {
          window.ACH_DOCK?.saveDockOpen('term', ['term', 'chat']);
          openResumedTerm(res.term, { kind: cfg.agent, resume: sid });
        } else {
          syncConn();
          loadCandidates();
        }
      }
      const meDesc = [providerName(cfg.agent), cfg.model || '', cfg.effort || ''].filter(Boolean).join(' · ');
      toast(`${meDesc} 설정으로 세션을 연결했습니다`);
      return res.term;
    }

    const body = {
      kind: cfg.agent,
      ...(sid ? { resume: sid } : {}),
      cwd,
      ...(cfg.model ? { model: cfg.model } : {}),
      ...(cfg.effort ? { effort: cfg.effort } : {}),
      ...(cfg.agent === 'claude' ? { skipPermissions: true, fork: !!liveDesktop } : {}),
    };
    const t = await api('/api/term/new', { method: 'POST', body });
    if (t.error) throw new Error(t.error);
    activeTermId = String(t.id);
    if (prefKey) chatLaunchPrefs.set(prefKey, cfg);
    await refreshOverview();
    if (pendingText) {
      notifySent(t.id, pendingText);
      setTimeout(() => {
        api('/api/term/send', { method: 'POST', body: { id: t.id, text: pendingText, submit: true } }).catch(() => {});
      }, 2400);
    }
    if (openTerm) {
      window.ACH_DOCK?.saveDockOpen('term', ['term', 'chat']);
      openResumedTerm(t, body);
    } else {
      syncConn();
    }
    return t;
  };

  barHost._getLaunchConfig = getConfig;
  barHost._launchResume = async (openWithChat = true) => {
    try { await launchWithConfig({ openTerm: openWithChat }); }
    catch (er) { toast(er.message, 6000, 'danger'); }
  };

  applyBtn.onclick = async () => {
    applyBtn.disabled = true;
    const prevTxt = applyBtn.textContent;
    applyBtn.textContent = '적용 중…';
    try {
      await launchWithConfig({ openTerm: state.sel.kind === 'term' });
    } catch (er) {
      toast(er.message, 6000, 'danger');
    } finally {
      if (applyBtn.isConnected) {
        applyBtn.disabled = false;
        applyBtn.textContent = prevTxt;
        syncApplyBtn();
      }
    }
  };

  const sendReply = async () => {
    const text = repIn.value.trim();
    if (!text) return;
    repIn.value = ''; fitRep();
    repBtn.disabled = true;
    try {
      const existing = findLiveTerm();
      if (existing) {
        const cfg = getConfig();
        const ltAgent = existing.agent || baseAgent;
        const ltAcc = existing.account?.id || baselineAccId || `__cli__:${ltAgent}`;
        const changed = cfg.agent !== ltAgent || cfg.model !== (existing.model || '') || cfg.effort !== (existing.effort || '') || (cfg.account !== ltAcc && !(cfg.account === `__cli__:${ltAgent}` && !existing.account?.id));
        if (changed) {
          await launchWithConfig({ openTerm: false, pendingText: text });
          return;
        }
        const r = await api('/api/term/send', { method: 'POST', body: { id: existing.id, text, submit: true } });
        if (r.error) throw new Error(r.error);
        syncConn();
        notifySent(existing.id, text);
        return;
      }
      if (activeConsolePid) {
        const r = await api('/api/console/send', { method: 'POST', body: { pid: activeConsolePid, text, submit: true } });
        if (r.error) throw new Error(r.error);
        syncConn();
        notifySent(null, text);
        return;
      }
      const t = await launchWithConfig({ openTerm: false, pendingText: text });
      if (t) toast(`터미널 t:${t.id}을(를) 연결해 메시지를 전송했습니다`);
    } catch (er) {
      toast(er.message, 6000, 'danger');
    } finally {
      if (repBtn.isConnected) repBtn.disabled = false;
    }
  };
  repBtn.onclick = sendReply;
  repIn.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendReply(); } };
}

function openResumedTerm(t, request) {
  const isAgy = request.kind === 'agy';
  const saved = getSavedTermTab(null);
  select({ kind: 'term', id: t.id, ...(isAgy ? { agyResume: request.resume } : {}) }, saved || (isAgy ? 'split' : undefined));
}

function resolveTermSessionId(t) {
  if (!t) return null;
  if (t.sessionId) return t.sessionId;
  if (t.projectTask) return null;
  if (t.agy || t.agent === 'agy') return state.sel.kind === 'term' && state.sel.id === t.id ? state.sel.agyResume || null : null;
  const norm = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase();
  const tCwd = norm(t.cwd);
  if (!tCwd) return null;
  const ag = t.agent || (t.codex ? 'codex' : t.agy ? 'agy' : t.claude ? 'claude' : null);
  const hit = state.recent.find((r) => (!ag || (r.agent || 'claude') === ag) && norm(r.cwd) === tCwd);
  return hit?.sessionId || null;
}

async function openBranchDialog({ sid, atIndex = null, message = null, agent = 'claude', cwd = '', capabilities = {} }) {
  const sourceAg = ['claude', 'codex', 'agy'].includes(agent) ? agent : 'claude';
  const d = document.createElement('dialog');
  d.className = 'pj-dialog';
  d.style.width = 'min(520px, calc(100vw - 24px))';
  d.setAttribute('aria-label', '대화 분기점 만들기');
  const snippet = message?.text ? String(message.text).replace(/\s+/g, ' ').trim().slice(0, 140) : '대화 마지막 시점까지';
  const pointText = atIndex != null ? `#${atIndex + 1}번째 메시지 (${message?.role === 'user' ? '사용자' : '어시스턴트'})` : '현재 마지막 메시지까지';
  d.innerHTML = `<form style="display:flex;flex-direction:column;gap:12px;min-width:0;max-width:100%">
    <div class="dlg-head"><h3>${ICO.branch} 대화 분기점 만들기</h3><button type="button" class="ghost icon-btn btn-sm" data-br-close aria-label="닫기">${ICO.close}</button></div>
    <div class="chat-lineage" style="flex-direction:column;align-items:flex-start;gap:4px">
      <div style="max-width:100%;overflow-wrap:anywhere"><b>분기 시점</b> · ${esc(pointText)}</div>
      <div class="ums" style="margin:0;width:100%;max-width:100%;overflow-wrap:anywhere;word-break:break-word">${esc(snippet)}${message?.text?.length > 140 ? '…' : ''}</div>
    </div>
    <label>분기할 CLI 에이전트
      <select name="targetAgent" id="brAgent">
        <option value="claude"${sourceAg === 'claude' ? ' selected' : ''}>Claude Code</option>
        <option value="codex"${sourceAg === 'codex' ? ' selected' : ''}>Codex CLI</option>
        <option value="agy"${sourceAg === 'agy' ? ' selected' : ''}>Antigravity (agy)</option>
      </select>
      <small class="ums" id="brModeHint" style="margin:2px 0 0"></small>
    </label>
    <label>사용할 계정
      <select name="account" id="brAccount"><option value="">기본 / 현재 활성 계정</option></select>
    </label>
    ${typeof projectModelEffortFields === 'string' ? projectModelEffortFields : ''}
    <label>분기 후 바로 보낼 첫 메시지 (선택)
      <textarea name="prompt" rows="3" placeholder="비워두면 이 분기점까지의 맥락이 준비된 새 터미널만 엽니다."></textarea>
    </label>
    <p role="alert" class="pj-error"></p>
    <div class="dlg-foot">
      <button type="button" data-br-close>취소</button>
      <button type="submit" class="primary" id="brSubmit">${ICO.branch} 여기서 분기 시작</button>
    </div>
  </form>`;
  document.body.append(d);
  d.onclose = () => d.remove();
  d.querySelectorAll('[data-br-close]').forEach((b) => (b.onclick = () => d.close()));

  const agSel = $('#brAgent', d);
  const accSel = $('#brAccount', d);
  const hintEl = $('#brModeHint', d);
  const brMeCtl = typeof createCliModelEffortController === 'function'
    ? createCliModelEffortController({
      modelPick: d.querySelector('[name=modelPick]'),
      modelIn: d.querySelector('[name=model]'),
      effortSel: d.querySelector('[name=effort]'),
      hintEl: d.querySelector('[data-cli-opt-hint]'),
      initialKind: sourceAg,
    })
    : null;
  const updateModeHint = () => {
    const tAg = agSel.value;
    brMeCtl?.setCli(tAg);
    hintEl.textContent = (sourceAg === 'claude' && tAg === 'claude' && capabilities?.canNativeFork !== false)
      ? 'Claude 원본 JSONL을 이 지점까지만 복제해 네이티브 분기 세션으로 엽니다.'
      : '이 지점까지의 대화 맥락을 브리핑 파일로 정리해 새 세션에 전달합니다.';
  };
  const loadAccounts = async () => {
    updateModeHint();
    try {
      const tAg = agSel.value;
      const r = await api(`/api/projects/accounts?agent=${encodeURIComponent(tAg)}`);
      const list = r.accounts || [];
      accSel.innerHTML = `<option value="">기본 / 현재 활성 계정</option>` + list.map((a) => `<option value="${esc(a.id)}">${esc(a.label)}</option>`).join('');
      const savedDef = typeof readSavedCliDefaults === 'function' ? readSavedCliDefaults(tAg) : { account: '' };
      if (savedDef.account && list.some((a) => a.id === savedDef.account)) accSel.value = savedDef.account;
    } catch {}
  };
  agSel.onchange = loadAccounts;
  loadAccounts();

  $('form', d).onsubmit = async (e) => {
    e.preventDefault();
    const btn = $('#brSubmit', d);
    btn.disabled = true;
    try {
      const fd = new FormData(e.target);
      const meVals = brMeCtl ? brMeCtl.getValues() : { model: '', effort: '' };
      const res = await api('/api/transcript/fork', {
        method: 'POST',
        body: {
          id: sid,
          atIndex,
          targetAgent: fd.get('targetAgent'),
          account: fd.get('account'),
          model: meVals.model,
          effort: meVals.effort,
          prompt: String(fd.get('prompt') || '').trim(),
          cwd,
        },
      });
      if (res.error) throw new Error(res.error);
      d.close();
      await refreshOverview();
      const targetAg = String(fd.get('targetAgent') || sourceAg);
      select({ kind: 'term', id: res.term.id, ...(targetAg === 'agy' && res.childSessionId ? { agyResume: res.childSessionId } : {}) }, getSavedTermTab(null) || 'split');
      toast(res.native ? '이 지점에서 네이티브 분기 대화를 시작했습니다' : '분기점 맥락을 전달한 새 대화를 시작했습니다');
    } catch (err) {
      $('.pj-error', d).textContent = err.message;
      btn.disabled = false;
    }
  };
  d.showModal();
}

function formatLiveTermPreview(lines, maxLines = 14) {
  if (!Array.isArray(lines) || !lines.length) return '';
  const cleaned = lines
    .map((l) => String(l ?? '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\s+$/, ''))
    .filter((l) => {
      const t = l.trim();
      if (!t) return false;
      if (/^[\s─━═│┌┐└┘├┤┬┴┼╭╮╰╯·•\-_=~]+$/.test(t)) return false;
      if (/^(?:\?\s+for shortcuts|shift\+tab\s+to\s+cycle|ctrl\+c\s+to|esc\s+to\s+(?:interrupt|cancel)|type\s+your\s+message|bypass\s+permissions|\d+%\s+context\s+left)/i.test(t)) return false;
      return true;
    });
  while (cleaned.length && /^\s*[>›❯$#]\s*$/.test(cleaned[cleaned.length - 1])) cleaned.pop();
  return cleaned.slice(-maxLines).join('\n');
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
  container.innerHTML = `<div class="chat">
    <h2 class="sr-only">대화 내용</h2>
    <div id="chatMsgsHost">불러오는 중…</div>
    <div id="chatLiveHost"></div>
    <div class="chat-bottom-float" hidden><button type="button" class="scroll-bottom-btn" title="대화 최하단으로 이동" aria-label="대화 최하단으로 이동">${ICO.chevDown}<span>최하단</span></button></div>
  </div>`;
  const box = $('.chat', container);
  const msgsHost = $('#chatMsgsHost', box);
  const liveHost = $('#chatLiveHost', box);
  const floatWrap = $('.chat-bottom-float', box);

  let lastSig = '';
  let lastLiveMode = '';
  let lastMessages = [];
  let wasWorking = false;
  let idleStreak = 0;
  let lastPreviewText = '';
  let lastPreviewAt = 0;
  let showLiveScreen = true;
  try { showLiveScreen = localStorage.getItem('ach.chatLiveScreen') !== '0'; } catch {}
  const jump = at >= 0;

  const resolveLiveTarget = () => {
    const hint = container._liveChatHint;
    let lt = null;
    if (state.sel.kind === 'term') {
      lt = state.terms.find((x) => String(x.id) === String(state.sel.id) && x.exited === null) || null;
    }
    if (!lt && hint?.termId) {
      lt = state.terms.find((x) => String(x.id) === String(hint.termId) && x.exited === null) || null;
    }
    if (!lt && curSid) {
      lt = state.terms.find((x) => x.exited === null && x.sessionId === curSid) || null;
    }
    const liveProc = (lt?.pid && state.live.find((x) => consoleOf(x.pid)?.pids.includes(lt.pid)))
      || (curSid && state.live.find((x) => x.sessionId === curSid))
      || null;
    const conPid = state.sel.kind === 'console'
      ? Number(state.sel.id)
      : (hint?.consolePid || (liveProc && !isDesktopSession(liveProc) ? consoleOf(liveProc.pid)?.id : null) || null);
    return { lt, liveProc, conPid };
  };

  const updateLiveBubble = async (messages) => {
    if (jump || gen !== viewGen || !container.isConnected) return false;
    const { lt, liveProc, conPid } = resolveLiveTarget();
    let termRead = null;
    if (lt) {
      termRead = await api(`/api/term/read?id=${encodeURIComponent(lt.id)}&lines=20`).catch(() => null);
      if (gen !== viewGen || !container.isConnected) return false;
    }
    const procBusy = liveProc?.status === 'busy';
    const hasFreshTermStatus = !!(termRead?.ok && termRead?.status);
    const termBusy = hasFreshTermStatus ? (termRead.status === 'busy') : !!(lt && termStateOf(lt) === 'busy');
    const rawBusy = hasFreshTermStatus ? termBusy : !!(termBusy || procBusy);
    const nonTool = (messages || []).filter((m) => !(m.role === 'assistant' && String(m.text || '').startsWith('⚙')));
    const tail = nonTool[nonTool.length - 1];
    const tailTs = tail?.ts ? new Date(tail.ts).getTime() : 0;

    let hint = container._liveChatHint;
    if (rawBusy) {
      idleStreak = 0;
      wasWorking = true;
    } else if (tail?.role === 'assistant' && (!hint || (tailTs && tailTs >= hint.sentAt - 1000) || (Date.now() - hint.sentAt > 2500))) {
      // Finalized assistant answer landed and terminal is idle -> clear immediately
      idleStreak = 99;
      wasWorking = false;
      if (hint) { container._liveChatHint = null; hint = null; }
    } else if (wasWorking) {
      idleStreak++;
      // Hysteresis: hold across 1 transient idle poll (~1.1s) so brief TUI/tool redraws do not blink
      if (idleStreak >= 2) wasWorking = false;
    }

    if (hint && hint.until <= Date.now() && !rawBusy && !wasWorking) {
      container._liveChatHint = null;
      hint = null;
    }

    let conPreview = '';
    if (!lt && conPid && (rawBusy || wasWorking || hint)) {
      const cr = await api(`/api/console/read?pid=${encodeURIComponent(conPid)}`).catch(() => null);
      if (gen !== viewGen || !container.isConnected) return false;
      if (cr?.ok && Array.isArray(cr.lines)) conPreview = formatLiveTermPreview(cr.lines, 14);
    }

    const activeWorking = rawBusy || wasWorking || !!hint;
    if (!activeWorking) {
      if (liveHost.innerHTML) liveHost.innerHTML = '';
      lastLiveMode = '';
      lastPreviewText = '';
      lastPreviewAt = 0;
      return false;
    }

    const freshPreview = termRead?.ok ? formatLiveTermPreview(termRead.lines, 14) : conPreview;
    if (freshPreview) {
      lastPreviewText = freshPreview;
      lastPreviewAt = Date.now();
    }
    // During momentary ConPTY clear/redraw gaps, keep last preview up to 2.5s so height stays rock steady
    const preview = freshPreview || ((Date.now() - lastPreviewAt < 2500) ? lastPreviewText : '');

    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const lastUser = [...(messages || [])].reverse().find((m) => m.role === 'user');
    const showPendingUser = !!(hint?.pendingText && (!lastUser || !norm(lastUser.text).includes(norm(hint.pendingText).slice(0, 60))));
    const canJump = (lt || conPid) && state.sel.kind === 'recent';
    const hasScreen = !!(showLiveScreen && preview);
    const hasToggle = !!preview;
    const modeKey = `${showPendingUser ? hint.pendingText : ''}|${hasScreen ? 'pre' : 'dots'}|${hasToggle ? '1' : '0'}|${canJump ? (lt?.id || conPid) : ''}`;
    const wasNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 120;

    if (modeKey === lastLiveMode && hasScreen) {
      // Update text in-place so typing animation and scroll position stay silky smooth
      const preEl = $('.chat-live-pre', liveHost);
      if (preEl && preEl.textContent !== preview) {
        preEl.textContent = preview;
        preEl.scrollTop = preEl.scrollHeight;
        if (wasNearBottom) container.scrollTop = container.scrollHeight;
      }
      return true;
    }
    if (modeKey === lastLiveMode) return true;
    lastLiveMode = modeKey;

    const userHtml = showPendingUser
      ? `<div class="msg user msg-pending"><div class="msg-bubble"><div class="msg-body">${esc(hint.pendingText)}</div></div><div class="msg-meta"><span>전송됨 · 응답 대기 중</span></div></div>`
      : '';
    const toggleBtn = hasToggle
      ? `<button type="button" class="ghost btn-sm" data-live-toggle style="min-height:22px;height:22px;font-size:11px;padding:0 7px">${showLiveScreen ? '터미널 출력 숨기기' : '터미널 출력 보기'}</button>`
      : '';
    const jumpBtn = canJump
      ? `<button type="button" class="ghost btn-sm" data-live-jump="${esc(lt ? `t:${lt.id}` : `c:${conPid}`)}" style="min-height:22px;height:22px;font-size:11px;padding:0 7px">터미널로 이동 ↗</button>`
      : '';
    const bodyHtml = hasScreen
      ? `<pre class="chat-live-pre">${esc(preview)}</pre>`
      : `<div class="chat-typing-row"><span class="typing-dots" aria-hidden="true"><i></i><i></i><i></i></span><span>터미널에서 응답을 생성하고 있습니다</span></div>`;

    liveHost.innerHTML = `${userHtml}<div class="msg assistant msg-live" aria-live="polite">
      <div class="msg-av">${agentIcon(ag || 'claude')}</div>
      <div class="msg-col">
        <div class="msg-hd">
          <span class="w-role">${esc(who)}</span>
          <span class="chat-working-pill">작업 중 <span class="typing-dots" aria-hidden="true"><i></i><i></i><i></i></span></span>
          <span style="flex:1"></span>
          ${toggleBtn}${jumpBtn}
        </div>
        <div class="msg-bubble">${bodyHtml}</div>
      </div>
    </div>`;

    const tgl = $('[data-live-toggle]', liveHost);
    if (tgl) {
      tgl.onclick = () => {
        showLiveScreen = !showLiveScreen;
        try { localStorage.setItem('ach.chatLiveScreen', showLiveScreen ? '1' : '0'); } catch {}
        lastLiveMode = '';
        updateLiveBubble(lastMessages);
      };
    }
    const jBtn = $('[data-live-jump]', liveHost);
    if (jBtn) {
      jBtn.onclick = () => {
        const val = jBtn.dataset.liveJump || '';
        if (val.startsWith('t:')) select({ kind: 'term', id: val.slice(2) }, 'split');
        else if (val.startsWith('c:')) select({ kind: 'console', id: val.slice(2) }, 'split');
      };
    }
    if (wasNearBottom) {
      container.scrollTop = container.scrollHeight;
      const pre = $('.chat-live-pre', liveHost);
      if (pre) pre.scrollTop = pre.scrollHeight;
    }
    return true;
  };
  const tick = async (force = false) => {
    if (gen !== viewGen) return;
    if ((!curSid || tCur?.agy) && state.sel.kind === 'term') {
      const t = state.terms.find((x) => x.id === state.sel.id);
      const updated = resolveTermSessionId(t);
      if (curSid !== updated) lastSig = '';
      curSid = updated;
    }
    const box = $('.chat', container);
    if (!box) return;
    if (!curSid) {
      if (tCur?.agy) {
        msgsHost.innerHTML = '<div class="empty">AGY 대화 기록을 기다리는 중입니다. 이 터미널에 기록이 생기면 자동으로 표시됩니다.</div>';
        const working = await updateLiveBubble([]);
        chatPollTimer = setTimeout(tick, working ? 1100 : 3000);
        return;
      }
      msgsHost.innerHTML = `<div class="h-empty-card" style="margin:24px auto;max-width:480px">
        <b>아직 기록된 대화 내역이 없습니다</b>
        <span class="ums">터미널 화면에서 첫 프롬프트를 전송하면 대화 기록이 자동으로 여기에 실시간 표시됩니다.</span>
        ${!hostEl ? `<div class="row" style="gap:8px;margin-top:6px"><button class="primary" data-goto-tab="screen">터미널 화면으로</button><button data-goto-tab="split">${ICO.split} 터미널 + 대화 함께 보기</button></div>` : ''}
      </div>`;
      msgsHost.querySelectorAll('[data-goto-tab]').forEach((b) => (b.onclick = () => select(state.sel, b.dataset.gotoTab, true)));
      const working = await updateLiveBubble([]);
      chatPollTimer = setTimeout(tick, working ? 1100 : 3000);
      return;
    }
    const d = await api(`/api/transcript?id=${encodeURIComponent(curSid)}${jump ? '&at=' + at : ''}`).catch((e) => ({ error: e.message }));
    if (gen !== viewGen) return;
    if (d.hidden) { msgsHost.textContent = d.error; return; }
    const parentSig = d.lineage?.parent ? `${d.lineage.parent.parentSessionId}:${d.lineage.parent.atIndex}` : '';
    const childSig = (d.lineage?.children || []).map((c) => `${c.id || ''}:${c.childSessionId || ''}:${c.atIndex}`).join(',');
    const sig = `${d.size || 0}:${d.rev || 0}:${d.title || ''}:${parentSig}:${childSig}`;
    if (d.error && !d.messages?.length) {
      const earlyParentTxt = d.lineage?.parent
        ? `원본: ${d.lineage.parent.parentTitle || d.lineage.parent.parentSessionId.slice(0, 8)} (#${d.lineage.parent.atIndex + 1}에서 분기)`
        : '';
      const earlyLineage = d.lineage?.parent
        ? `<div class="chat-lineage" style="margin-bottom:10px"><button type="button" class="msg-branch-chip" data-open-parent-sid="${esc(d.lineage.parent.parentSessionId)}" data-open-parent-at="${d.lineage.parent.atIndex}" title="${esc(earlyParentTxt)}">${ICO.branch} <span class="br-chip-txt">${esc(earlyParentTxt)}</span></button></div>`
        : '';
      msgsHost.innerHTML = `${earlyLineage}<div class="h-empty-card" style="margin:24px auto;max-width:480px">
        <b>대화 기록을 준비 중입니다 (${esc(curSid.slice(0, 8))})</b>
        <span class="ums">에이전트가 첫 응답을 기록하면 자동으로 대화 내역이 나타납니다.</span>
      </div>`;
    } else if (sig !== lastSig && (force || (!selectionIn(msgsHost) && !$('.msg-edit-box', msgsHost)))) { // keep active copy selection or inline editor unless forced
      lastSig = sig;
      lastMessages = d.messages || [];
      const v = container;
      const atBottom = v.scrollHeight - v.scrollTop - v.clientHeight < 80 || !box.dataset.painted;
      const b = d.base || 0;
      const childBranches = d.lineage?.children || [];
      const branchesByIdx = new Map();
      for (const ch of childBranches) {
        (branchesByIdx.get(ch.atIndex) || branchesByIdx.set(ch.atIndex, []).get(ch.atIndex)).push(ch);
      }
      const branchChipBtn = (ch, withIndex = false) => {
        const rawLbl = ch.childTitle || (ch.childSessionId ? `분기 ${ch.childSessionId.slice(0, 8)}` : `터미널 t:${ch.termId}`);
        const lbl = withIndex ? `#${Number(ch.atIndex) + 1} · ${rawLbl}` : rawLbl;
        const tip = `${lbl}${ch.targetAgent ? ` (${ch.targetAgent.toUpperCase()})` : ''}`;
        return ch.childSessionId
          ? `<button type="button" class="msg-branch-chip" data-open-branch-sid="${esc(ch.childSessionId)}" title="${esc(tip)}">${ICO.branch} <span class="br-chip-txt">${esc(lbl)}</span> ↗</button>`
          : `<button type="button" class="msg-branch-chip" data-open-branch-term="${esc(ch.termId)}" title="${esc(tip)}">${ICO.branch} <span class="br-chip-txt">${esc(lbl)}</span> ↗</button>`;
      };
      const parentTitle = d.lineage?.parent ? (d.lineage.parent.parentTitle || d.lineage.parent.parentSessionId.slice(0, 8)) : '';
      const parentChipTxt = d.lineage?.parent ? `원본: ${parentTitle} (#${d.lineage.parent.atIndex + 1}에서 분기)` : '';
      const lineageBanner = (d.lineage?.parent || childBranches.length)
        ? `<div class="chat-lineage">
          ${d.lineage?.parent ? `<button type="button" class="msg-branch-chip" data-open-parent-sid="${esc(d.lineage.parent.parentSessionId)}" data-open-parent-at="${d.lineage.parent.atIndex}" title="${esc(parentChipTxt)}">${ICO.branch} <span class="br-chip-txt">${esc(parentChipTxt)}</span></button>` : ''}
          ${childBranches.length ? `<div class="chat-lineage-list"><span class="ums" style="margin:0">${ICO.branch} 이 대화에서 파생된 분기 <b>${childBranches.length}</b>개</span>${childBranches.map((ch) => branchChipBtn(ch, true)).join('')}</div>` : ''}
        </div>` : '';
      const more = jump && b + d.messages.length < (d.total || 0)
        ? `<div class="row" style="justify-content:center;margin:10px"><button class="btn-latest">최신 대화로 이동</button></div>` : '';
      const parts = [];
      let toolBuf = [];
      const branchChipsHTML = (gi) => {
        const list = branchesByIdx.get(gi);
        if (!list?.length) return '';
        return `<div class="msg-branches"><span class="msg-branch-lbl">${ICO.branch} 분기됨</span>${list.map((ch) => branchChipBtn(ch, false)).join('')}</div>`;
      };
      const flushTools = () => {
        if (!toolBuf.length) return;
        const firstLine = (toolBuf[0].m.text || '').split('\n')[0].slice(0, 70);
        const toolBranches = toolBuf.map((x) => branchChipsHTML(x.gi)).filter(Boolean).join('');
        parts.push(`<details class="toolgrp"><summary>⚙ 도구 실행 ${toolBuf.length}건 · ${esc(firstLine)}</summary><div class="toolgrp-body">${toolBuf.map((x) => `<div>${linkPaths(hl(x.m.text, terms))}</div>`).join('')}</div></details>${toolBranches}`);
        toolBuf = [];
      };
      let lastDay = '';
      d.messages.forEach((m, k) => {
        const tool = m.role === 'assistant' && m.text.startsWith('⚙');
        const gi = b + k;
        const tgt = jump && gi === at;
        if (tool && !tgt) { toolBuf.push({ m, gi }); return; }
        flushTools();
        const rawTxt = String(m.text || '').replace(/<external_codex_apps_[^>]*>[\s\S]*?<\/external_codex_apps_[^>]*>/gi, '').trim();
        if (!rawTxt) return;
        const dt = m.ts ? new Date(m.ts) : null;
        if (dt && !Number.isNaN(dt.getTime())) {
          const dayKey = `${dt.getFullYear()}-${dt.getMonth() + 1}-${dt.getDate()}`;
          if (dayKey !== lastDay) {
            lastDay = dayKey;
            const dayLabel = dt.toLocaleDateString(document.documentElement.lang === 'en' ? 'en-US' : 'ko-KR', { month: 'long', day: 'numeric', weekday: 'short' });
            parts.push(`<div class="chat-day">${esc(dayLabel)}</div>`);
          }
        }
        const when = dt && !Number.isNaN(dt.getTime()) ? dt.toLocaleTimeString(uiLocale(), { hour: '2-digit', minute: '2-digit' }) : '';
        const copyBtn = `<button class="ghost icon-btn btn-sm" data-copy-mi="${k}" aria-label="이 메시지 복사" title="이 메시지 복사">${ICO.copy}</button>`;
        const forkBtn = `<button class="ghost icon-btn btn-sm" data-fork-mi="${k}" aria-label="이 지점에서 분기 만들기" title="이 지점에서 분기 만들기">${ICO.branch}</button>`;
        const editBtn = m.role === 'user' ? `<button class="ghost icon-btn btn-sm" data-edit-mi="${k}" aria-label="이 메시지 수정" title="이 메시지 수정 · 재실행">${ICO.edit}</button>` : '';
        const editedBadge = m.edited ? `<span class="badge">수정됨</span>` : '';
        const branchOriginNote = gi === 0 && d.lineage?.parent
          ? `<div class="msg-branch-origin">${ICO.branch} <span>분기 시작 · 원본 #${d.lineage.parent.atIndex + 1}${d.lineage.parent.editedText ? ` · 요청: ${esc(String(d.lineage.parent.editedText).replace(/\s+/g, ' ').trim().slice(0, 80))}` : ''}</span></div>`
          : '';
        if (tool) {
          parts.push(`<div class="msg tool${tgt ? ' target' : ''}" data-mi="${k}">${linkPaths(hl(rawTxt, terms))}</div>${branchChipsHTML(gi)}`);
        } else if (m.role === 'user') {
          const bodyHtml = linkPaths(hl(rawTxt, terms));
          parts.push(`<div class="msg user${tgt ? ' target' : ''}" data-mi="${k}">${branchOriginNote}<div class="msg-bubble"><div class="msg-body">${bodyHtml}</div></div><div class="msg-meta">${editedBadge}<span class="msg-acts">${editBtn}${forkBtn}${copyBtn}</span>${when ? `<span>${esc(when)}</span>` : ''}</div>${branchChipsHTML(gi)}</div>`);
        } else {
          const bodyHtml = !terms.length ? md(rawTxt) : `<div class="msg-body" style="white-space:pre-wrap">${linkPaths(hl(rawTxt, terms))}</div>`;
          parts.push(`<div class="msg assistant${tgt ? ' target' : ''}" data-mi="${k}"><div class="msg-av">${agentIcon(ag || 'claude')}</div><div class="msg-col"><div class="msg-hd"><span class="w-role">${esc(who)}</span>${when ? `<span class="w-ts">${esc(when)}</span>` : ''}${editedBadge}<span style="flex:1"></span><span class="msg-acts">${forkBtn}${copyBtn}</span></div><div class="msg-bubble">${bodyHtml}</div>${branchChipsHTML(gi)}</div></div>`);
        }
      });
      flushTools();
      msgsHost.innerHTML = lineageBanner + (b > 0 ? `<div class="empty" style="margin-bottom:6px">… 이전 메시지 ${b}개 생략</div>` : '') + (parts.join('') || '<div class="empty">메시지 없음</div>') + more;
      msgsHost.onclick = (e) => {
        const cb = e.target.closest('[data-copy-mi]');
        if (cb) { const m = d.messages[Number(cb.dataset.copyMi)]; if (m) copyText(m.text); return; }
        const fb = e.target.closest('[data-fork-mi]');
        if (fb) {
          const k = Number(fb.dataset.forkMi);
          const m = d.messages[k];
          if (m) openBranchDialog({ sid: curSid, atIndex: b + k, message: m, agent: d.agent || ag, cwd: d.cwd, capabilities: d.capabilities || {} });
          return;
        }
        const eb = e.target.closest('[data-edit-mi]');
        if (eb) {
          const k = Number(eb.dataset.editMi);
          const m = d.messages[k];
          const msgEl = msgsHost.querySelector(`.msg[data-mi="${k}"] .msg-bubble`);
          if (!m || !msgEl || $('.msg-edit-box', msgEl)) return;
          const canRewind = !!d.capabilities?.canRewindEdit;
          msgEl.innerHTML = `<div class="msg-edit-box">
            <textarea>${esc(m.text)}</textarea>
            <div class="msg-edit-foot">
              <button type="button" class="ghost btn-sm" data-ed-cancel>취소</button>
              <button type="button" class="btn-sm" data-ed-save title="기록된 텍스트만 수정합니다">내용만 수정</button>
              ${canRewind ? `<button type="button" class="btn-sm" data-ed-rewind title="이 시점 이전으로 대화를 되감고 수정된 내용으로 재실행합니다">되감고 재실행</button>` : ''}
              <button type="button" class="primary btn-sm" data-ed-fork title="이 시점까지 맥락으로 새 분기 대화를 열고 수정된 내용을 전송합니다">${ICO.branch} 분기해서 재실행</button>
            </div>
          </div>`;
          const ta = $('textarea', msgEl);
          ta.focus();
          ta.setSelectionRange(ta.value.length, ta.value.length);
          const runEditAction = async (mode) => {
            const text = ta.value.trim();
            if (!text) return toast('수정할 내용을 입력하세요', 3000, 'danger');
            if (mode === 'rewind-edit' && !confirm('원본 대화에서 이 메시지 이후 기록을 되돌리고 수정된 프롬프트로 다시 실행할까요? (원본 백업 저장됨)')) return;
            msgEl.querySelectorAll('button').forEach((btn) => (btn.disabled = true));
            try {
              const res = await api('/api/transcript/edit', {
                method: 'POST',
                body: { id: curSid, atIndex: b + k, text, mode, targetAgent: d.agent || ag, cwd: d.cwd },
              });
              if (res.error) throw new Error(res.error);
              if (mode === 'save') {
                lastSig = '';
                await refreshOverview();
                await tick(true);
                toast('대화 내용을 수정했습니다');
                return;
              }
              await refreshOverview();
              select({ kind: 'term', id: res.term.id, ...((d.agent || ag) === 'agy' && res.childSessionId ? { agyResume: res.childSessionId } : {}) }, getSavedTermTab(null) || 'split');
              toast(mode === 'rewind-edit' ? '대화를 되감고 수정된 요청을 전송했습니다' : '수정된 요청으로 새 분기 대화를 시작했습니다');
            } catch (err) {
              toast(err.message, 5000, 'danger');
              msgEl.querySelectorAll('button').forEach((btn) => (btn.disabled = false));
            }
          };
          $('[data-ed-cancel]', msgEl).onclick = () => { lastSig = ''; tick(true); };
          $('[data-ed-save]', msgEl).onclick = () => runEditAction('save');
          $('[data-ed-fork]', msgEl).onclick = () => runEditAction('fork-edit');
          const rewBtn = $('[data-ed-rewind]', msgEl);
          if (rewBtn) rewBtn.onclick = () => runEditAction('rewind-edit');
          return;
        }
        const pBtn = e.target.closest('[data-open-parent-sid]');
        if (pBtn) {
          select({ kind: 'recent', id: pBtn.dataset.openParentSid, at: Number(pBtn.dataset.openParentAt ?? -1) }, 'chat');
          return;
        }
        const chSidBtn = e.target.closest('[data-open-branch-sid]');
        if (chSidBtn) {
          select({ kind: 'recent', id: chSidBtn.dataset.openBranchSid, at: -1 }, 'chat');
          return;
        }
        const chTermBtn = e.target.closest('[data-open-branch-term]');
        if (chTermBtn) {
          select({ kind: 'term', id: chTermBtn.dataset.openBranchTerm }, getSavedTermTab(null) || 'split');
          return;
        }
      };
      const btn = $('.btn-latest', msgsHost);
      const jumpLatest = () => select({ ...state.sel, at: -1 }, hostEl ? state.tab : 'chat');
      if (btn) btn.onclick = jumpLatest;
      const first = !box.dataset.painted;
      box.dataset.painted = '1';
      const t = first && jump && $('.msg.target', msgsHost);
      if (t) t.scrollIntoView({ block: 'center' });
      else if (atBottom) {
        v.scrollTop = v.scrollHeight;
        requestAnimationFrame(() => { if (v.isConnected) v.scrollTop = v.scrollHeight; });
      }

      const hasMore = jump && b + d.messages.length < (d.total || 0);
      const syncChatBottom = () => {
        if (!v.isConnected || !floatWrap.isConnected) return;
        const dist = v.scrollHeight - v.scrollTop - v.clientHeight;
        floatWrap.hidden = !(dist > 48 || hasMore);
      };
      if (v._chatScrollFn) v.removeEventListener('scroll', v._chatScrollFn);
      v._chatScrollFn = syncChatBottom;
      v.addEventListener('scroll', syncChatBottom, { passive: true });
      floatWrap.querySelector('button').onclick = () => {
        if (hasMore) return jumpLatest();
        v.scrollTo({ top: v.scrollHeight, behavior: 'smooth' });
        setTimeout(syncChatBottom, 220);
      };
      requestAnimationFrame(syncChatBottom);
    }
    const working = await updateLiveBubble(lastMessages);
    if (!jump) chatPollTimer = setTimeout(tick, working ? 1100 : 3000);
  };
  container._triggerPoll = () => {
    clearTimeout(chatPollTimer);
    tick(true);
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
function getTuiKeysOpen() {
  try {
    const v = localStorage.getItem('ccd.tuiKeysOpen');
    if (v === '1') return true;
    if (v === '0') return false;
  } catch {}
  return IS_MOBILE;
}
const termPromptHist = [];

function mountManagedTermScreen(hostEl, { t, gen, chatHost = null, onHintTab = null }) {
  if (!hostEl) return;
  const termId = t?.id || state.sel.id;
  const keysOpen = getTuiKeysOpen();
  hostEl.innerHTML = `<div class="full"><div id="termwrap"><button type="button" class="scroll-bottom-btn term-bottom-float" id="btnTermFloatBottom" hidden title="터미널 최하단으로 이동" aria-label="터미널 최하단으로 이동">${ICO.chevDown}<span>최하단</span></button></div>
    <div class="term-dock">
      <div class="tdock-bar">
        <button class="ghost btn-sm" id="tDockToggle" aria-expanded="${!dockCollapsed}" title="하단 프롬프트 작성창 접기/펼치기">${dockCollapsed ? `${ICO.chevUp} 입력창` : `${ICO.chevDown} 입력창`}</button>
        <div class="tdock-tools">
          <label class="filebtn" title="이 PC의 파일·스크린샷 첨부 → 경로 자동 입력 (드래그/Ctrl+V 가능)">${ICO.clip}<span>파일 첨부</span><input type="file" class="fpick" multiple hidden></label>
          <button id="tArt" title="세션이나 연구의 산출물 경로 선택">${ICO.folder}<span>산출물</span></button>
          <button data-copy="1" title="선택 텍스트(없으면 화면 전체) 복사">${ICO.copy}<span>복사</span></button>
          <button type="button" id="btnTermBottom" title="터미널 최하단으로 이동">${ICO.chevDown}<span>최하단</span></button>
        </div>
        <div class="tdock-keys-wrap">
          <button class="ghost btn-sm" id="btnTuiKeys" aria-expanded="${keysOpen}" title="TUI 방향키·제어키 패드 접기/펼치기">${ICO.keyboard}<span>TUI 키</span></button>
          <div class="tdock-keys" id="tuiKeysBox" ${keysOpen ? '' : 'hidden'}>
            <button data-key="esc" title="Esc (취소 / 이전 메뉴)">Esc</button>
            <button data-key="up" title="↑ (이전 명령 / 위쪽 항목)">↑</button>
            <button data-key="down" title="↓ (다음 명령 / 아래쪽 항목)">↓</button>
            <button data-key="tab" title="Tab (자동완성)">Tab</button>
            <button data-key="shift+tab" title="Shift+Tab (모드 전환)">⇧Tab</button>
            <button data-key="ctrl+c" title="Ctrl+C (실행 중단)">^C</button>
            <button data-key="enter" title="Enter (확인 / 실행)">⏎</button>
          </div>
        </div>
      </div>
      <div class="tdock-comp" id="tDockComp" ${dockCollapsed ? 'hidden' : ''}>
        <textarea id="tin" rows="1" placeholder="프롬프트 입력 (Enter 전송 · 파일 첨부)" enterkeyhint="send"></textarea>
        <button class="primary" id="tsend" title="터미널에 프롬프트 전송 (Enter)">보내기 ⏎</button>
      </div>
    </div>
    <div class="note"></div></div>`;

  const fullEl = $('.full', hostEl);
  const wrapEl = $('#termwrap', fullEl);
  xterm = new Terminal({ fontFamily: '"Cascadia Mono", Consolas, "D2Coding", monospace', fontSize: IS_MOBILE ? 11 : 13, cursorBlink: true, scrollback: 10000, theme: { background: '#0e0e11' } });
  const fit = new FitAddon.FitAddon();
  xterm.loadAddon(fit);
  xterm.open(wrapEl);
  const termFloatBtn = $('#btnTermFloatBottom', fullEl);
  const syncTermBottom = () => {
    if (!termFloatBtn || !xterm) return;
    const buf = xterm.buffer?.active;
    const up = buf ? (buf.baseY - buf.viewportY) > 1 : false;
    termFloatBtn.hidden = !up;
  };
  const scrollTermBottom = () => {
    if (!xterm) return;
    xterm.scrollToBottom();
    syncTermBottom();
    if (!IS_MOBILE) xterm.focus();
  };
  if ($('#btnTermBottom', fullEl)) $('#btnTermBottom', fullEl).onclick = scrollTermBottom;
  if (termFloatBtn) termFloatBtn.onclick = scrollTermBottom;
  xterm.onScroll(syncTermBottom);
  xterm.onWriteParsed(syncTermBottom);

  let hintAt = 0;
  wrapEl.addEventListener('wheel', (e) => {
    if (e.deltaY >= 0 || xterm.buffer.active.viewportY > 0 || Date.now() - hintAt < 8000) return;
    hintAt = Date.now();
    const h = document.createElement('div');
    h.className = 'termhint';
    h.innerHTML = '터미널에는 화면 한 장 분량만 남습니다 (Windows 콘솔 특성). 이전 대화는 <button class="linkbtn" data-htab="chat">"대화 기록" 패널 함께 열기</button>';
    h.querySelectorAll('[data-htab]').forEach((b) => (b.onclick = () => (onHintTab ? onHintTab(b.dataset.htab) : select(state.sel, b.dataset.htab, true))));
    wrapEl.appendChild(h);
    setTimeout(() => h.remove(), 7000);
  }, { passive: true });

  const ws = xws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/term?id=${termId}&t=${TOKEN}`);
  const send = (data) => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'input', data }));
  const resize = () => {
    if (gen !== viewGen || !wrapEl.isConnected || wrapEl.offsetParent === null) return;
    try { fit.fit(); } catch {}
    if (ws.readyState === 1 && xterm) ws.send(JSON.stringify({ type: 'resize', cols: xterm.cols, rows: xterm.rows }));
  };
  ws.onopen = resize;
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.type === 'data') xterm?.write(msg.data);
    if (msg.type === 'exit') xterm?.write(`\r\n\x1b[90m[프로세스 종료: ${msg.code}]\x1b[0m\r\n`);
  };
  xterm.onData(send);
  let pasteWithShift = false;
  xterm.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 'c' && (e.shiftKey || xterm.hasSelection())) { copyText(xterm.getSelection()); xterm.clearSelection(); return false; }
    if ((e.ctrlKey || e.metaKey) && k === 'v') { pasteWithShift = !!e.shiftKey; return false; }
    return true;
  });
  wrapEl.addEventListener('contextmenu', (e) => { if (xterm?.hasSelection()) { e.preventDefault(); copyText(xterm.getSelection()); xterm.clearSelection(); } });

  const tin = $('#tin', fullEl);
  const comp = $('#tDockComp', fullEl);
  const fitTin = () => {
    if (!tin) return;
    tin.style.height = 'auto';
    tin.style.height = Math.min(140, Math.max(36, tin.scrollHeight)) + 'px';
  };
  tin.addEventListener('input', fitTin);
  $('#tDockToggle', fullEl).onclick = () => {
    dockCollapsed = !dockCollapsed;
    try { localStorage.setItem('ccd.dockCollapsed', dockCollapsed ? '1' : '0'); } catch {}
    comp.hidden = dockCollapsed;
    $('#tDockToggle', fullEl).innerHTML = dockCollapsed ? `${ICO.chevUp} 입력창` : `${ICO.chevDown} 입력창`;
    $('#tDockToggle', fullEl).setAttribute('aria-expanded', String(!dockCollapsed));
    setTimeout(() => { resize(); if (dockCollapsed && !IS_MOBILE) xterm?.focus(); else if (!dockCollapsed) tin.focus(); }, 30);
  };
  const tkBtn = $('#btnTuiKeys', fullEl), tkBox = $('#tuiKeysBox', fullEl);
  if (tkBtn && tkBox) tkBtn.onclick = () => {
    const next = tkBox.hidden;
    tkBox.hidden = !next;
    tkBtn.setAttribute('aria-expanded', String(next));
    try { localStorage.setItem('ccd.tuiKeysOpen', next ? '1' : '0'); } catch {}
    setTimeout(resize, 30);
  };
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
  attachFileInput(fullEl, insert, t?.cwd, {
    shouldPassCtrlV: (e, dt, files) => {
      const shifted = pasteWithShift;
      pasteWithShift = false;
      return !IS_REMOTE && !IS_MOBILE && !shifted && !!t?.agent && (files.length > 0 || !dt?.getData('text/plain'));
    },
    sendCtrlV: () => send('\x16'),
  });
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
    if (v) { send(v); setTimeout(() => send('\r'), 350 + Math.min(3000, v.length * 2)); } else send('\r');
    if (chatHost && v.trim()) {
      chatHost._liveChatHint = { termId: String(termId), pendingText: v.trim(), sentAt: Date.now(), until: Date.now() + 30000 };
      chatHost._triggerPoll?.();
    }
  };
  $('#tsend', fullEl).onclick = submit;
  $('#tArt', fullEl).onclick = () => pickArtifact((abs) => insert(quotePath(abs)));
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
  fullEl.addEventListener('click', (e) => {
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
  bindFilePick(fullEl, insert, t?.cwd);
  window.onresize = resize;
  window.onfocus = resize;
  document.onvisibilitychange = () => { if (!document.hidden) resize(); };
  setTimeout(() => { resize(); if (!IS_MOBILE) xterm?.focus(); }, 60);
  return { resize };
}

function viewTerm() {
  const gen = viewGen;
  clearTimeout(chatPollTimer);
  const t = state.terms.find((x) => x.id === state.sel.id);
  const sid = resolveTermSessionId(t);
  const artSid = sid || (t ? `term:${t.id}` : '');
  const ag = t?.agent || (t?.codex ? 'codex' : t?.agy ? 'agy' : t?.claude ? 'claude' : null);

  const pj = projectOfTerm(t);
  const stNow = termStateOf(t);
  const justDoneNow = stNow === 'idle' && state.justDoneTerms.has(String(t?.id));
  const pillCls = stNow === 'busy' ? 'busy' : justDoneNow ? 'done' : stNow === 'exited' ? 'exited' : 'idle';
  const pillText = stNow === 'busy'
    ? '<span class="dot busy" style="width:6px;height:6px"></span>실행 중'
    : justDoneNow
      ? `${ICO.check} 작업 완료`
      : stNow === 'exited'
        ? `<span class="dot dead" style="width:6px;height:6px"></span>종료됨 (${t.exited})`
        : '대기';
  const isContentTab = state.tab === 'files' || state.tab === 'floorplan';
  let initialPanels = window.ACH_DOCK ? window.ACH_DOCK.getDockOpen('term', isContentTab ? null : state.tab) : ['term', 'chat'];
  if (!initialPanels.length) initialPanels = ['term'];

  setBar(`${state.sel.project || pj ? `<button id="btnBackProject" class="ghost btn-sm" data-proj-id="${esc(state.sel.project || pj.id)}">${ICO.chevLeft} ${esc(pj?.name || 'Project')}</button>` : `<button id="btnBackTerms" class="ghost btn-sm">${ICO.chevLeft} 터미널</button>`}<h2>${ag ? agentIcon(ag) : ''}<span>${esc(t ? termLabel(t) : '터미널')}</span></h2><span id="termLiveBadge" class="term-live-pill ${pillCls}">${pillText}</span>${branchTagHTML(t?.branch)}${t?.account ? `<span class="badge c">${esc(t.account.label.replace(/@.*/, ''))}</span>` : ''}${(t?.model || t?.effort) ? `<span class="badge" title="선택된 모델 · 추론 성능">${esc([t.model, t.effort].filter(Boolean).join(' · '))}</span>` : ''}
    ${dockTopSegHTML({ openSet: new Set(initialPanels), isContentTab, hasTerm: true, hasChat: true, showFiles: true, curTab: state.tab })}
    <button id="btnTermMore" class="ghost icon-btn btn-sm" aria-label="터미널 메뉴" aria-haspopup="menu" aria-expanded="false">${ICO.more}</button>`);

  let dock = null;
  $('#bar').onclick = async (e) => {
    const bp = e.target.closest('#btnBackProject');
    if (bp) return openProject(bp.dataset.projId || state.sel.project);
    if (e.target.closest('#btnBackTerms')) return select({ kind: 'terms' });
    const dt = e.target.closest('[data-dock-toggle]');
    if (dt) {
      const p = dt.dataset.dockToggle;
      if (isContentTab || !dock) {
        const next = new Set(initialPanels);
        next.add(p);
        window.ACH_DOCK?.saveDockOpen('term', [...next]);
        return select(state.sel, 'dock', true);
      }
      dock.togglePanel(p);
      return;
    }
    const tb = e.target.closest('[data-tab]');
    if (tb) return select(state.sel, tb.dataset.tab, true);
    const more = e.target.closest('#btnTermMore');
    if (more) {
      e.stopPropagation();
      return openMoreMenu(more, [
        t?.cwd ? { label: `작업 폴더 복사 (${base(t.cwd) || t.cwd})`, icon: ICO.folder, onClick: () => copyText(t.cwd) } : null,
        (sid || t?.claude || t?.codex || t?.agy) ? { label: '다른 계정 · 에이전트로 이어하기', icon: ICO.swap, onClick: () => openSwitch(sid || '', t?.id || '') } : null,
        t?.agy ? { label: 'Antigravity /usage 실행', icon: ICO.chart, onClick: () => openAgyUsage(null, true) } : null,
        { divider: true },
        {
          label: '터미널 종료',
          icon: ICO.trash,
          tone: 'danger',
          onClick: async () => {
            if (!confirm('이 터미널의 프로세스를 종료하고 닫을까요?')) return;
            await api('/api/term/close', { method: 'POST', body: { id: state.sel.id } });
            await refreshOverview();
            select({ kind: 'home' });
          },
        },
      ]);
    }
  };
  if (state.tab === 'files') return renderArtifacts(artSid, gen);
  if (state.tab === 'floorplan' && typeof renderStandaloneFloorplan === 'function') {
    const termCwd = t?.cwd || pj?.cwd || '';
    return renderStandaloneFloorplan(termCwd, gen, {
      sessionId: artSid || sid || '',
      onInsertPrompt: async (txt, submit) => {
        if (submit) {
          await api('/api/term/send', { method: 'POST', body: { id: t.id, text: txt, submit: true } });
          toast('터미널에 수정 지시를 전달했습니다');
          select(state.sel, 'dock', true);
        } else {
          window.ACH_DOCK?.saveDockOpen('term', ['term', ...initialPanels.filter((p) => p !== 'term')]);
          select(state.sel, 'dock', true);
          setTimeout(() => {
            const inp = $('#tin');
            if (inp) {
              inp.value = (inp.value ? inp.value + ' ' : '') + txt;
              inp.dispatchEvent(new Event('input'));
              inp.focus();
            }
          }, 80);
        }
      },
    });
  }

  let termCtl = null;
  let winCtl = null;
  let chatMounted = false;
  let chatScrollEl = null;

  const ensureChatMounted = () => {
    if (chatMounted || !dock) return;
    chatMounted = true;
    const body = dock.getBody('chat');
    body.innerHTML = `<div class="chat-shell"><div class="chat-scroll" id="termChatHost"></div><div id="termChatComp"></div></div>`;
    chatScrollEl = $('#termChatHost', body);
    renderChat(sid, gen, -1, [], chatScrollEl);
    mountChatComposer({
      barHost: $('#termChatComp', body),
      chatHost: chatScrollEl,
      sid,
      termId: t?.id || state.sel.id,
      agent: ag || 'claude',
      cwd: t?.cwd || pj?.cwd || '',
      compact: true,
      onJumpTerm: () => dock?.togglePanel('term', true),
    });
  };

  dock = window.ACH_DOCK.createDockWorkspace({
    hostEl: $('#view'),
    mode: 'term',
    openPanels: initialPanels,
    panelsMeta: {
      term: { title: '터미널', icon: ICO.terminal, onShow: () => setTimeout(() => termCtl?.resize(), 30) },
      chat: { title: '대화 기록', icon: ICO.chat, onShow: ensureChatMounted },
      windows: { title: '창', icon: ICO.monitor, onShow: () => winCtl?.renderWindows() },
    },
    onOpenChange: (openList) => syncBarDockButtons(openList),
  });

  if (dock.isOpen('chat')) ensureChatMounted();
  termCtl = mountManagedTermScreen(dock.getBody('term'), {
    t,
    gen,
    chatHost: chatScrollEl,
    onHintTab: () => dock?.togglePanel('chat', true),
  });
  winCtl = window.ACH_DOCK.mountWindowsPane({
    rootEl: dock.getBody('windows'),
    termId: t?.id || state.sel.id,
    gen,
    isOpen: () => !!dock?.isOpen('windows'),
    onCount: (n) => { const c = $('#bar [data-dock-win-cnt]'); if (c) c.textContent = String(n); },
  });
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
function attachFileInput(el, insert, cwd, opts = {}) {
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

// ---------- AI usage (relayed from ai-usage-dashboard :4777) ----------
let agyPollTimer = null;
async function refreshUsage(force) {
  const [uRes, aRes] = await Promise.allSettled([
    api('/api/usage' + (force ? '?force=1' : '')),
    api('/api/agy/quota' + (force ? '?force=1' : '')),
  ]);
  state.usage = uRes.status === 'fulfilled' ? uRes.value : { available: false, error: uRes.reason?.message || '오류' };
  if (state.usage?.accounts) state.usage.accounts = state.usage.accounts.filter((a) => a.id !== 'agy-cli');
  if (aRes.status === 'fulfilled' && aRes.value) {
    if (aRes.value.quota) state.agyQuota = aRes.value.quota;
    state.agySwapAvailable = !!aRes.value.swapAvailable;
    if (Array.isArray(aRes.value.swapAccounts)) state.agySwapAccounts = aRes.value.swapAccounts;
    state.agySwapRefreshing = !!aRes.value.swapRefreshing;
    state.agySwapError = aRes.value.swapError || null;
    state.agyRefreshing = !!aRes.value.refreshing;
    state.agyError = aRes.value.ok === false ? (aRes.value.error || '조회 실패') : (aRes.value.lastError || null);
    if (force && aRes.value.ok === false && aRes.value.error) {
      toast(`Antigravity 조회 실패: ${aRes.value.error}`, 5000, 'danger');
    }
    if (!force && (aRes.value.refreshing || aRes.value.swapRefreshing)) {
      clearTimeout(agyPollTimer);
      agyPollTimer = setTimeout(async () => {
        try {
          const next = await api('/api/agy/quota');
          if (next?.quota) state.agyQuota = next.quota;
          state.agySwapAvailable = !!next?.swapAvailable;
          if (Array.isArray(next?.swapAccounts)) state.agySwapAccounts = next.swapAccounts;
          state.agySwapRefreshing = !!next?.swapRefreshing;
          state.agyRefreshing = !!next?.refreshing;
          state.agyError = next?.lastError || null;
          renderSide();
          refreshHomeWidgets();
          if (state.sel.kind === 'usage') paintUsage();
        } catch {}
      }, 4500);
    }
  }
  paintBrandStatus();
  renderSide();
  refreshHomeWidgets();
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
async function openAgyUsage(btn) {
  const prev = btn?.innerHTML;
  if (btn) { btn.disabled = true; btn.textContent = btn.classList.contains('qact') ? '…' : 'agy 조회 중…'; }
  state.agyRefreshing = true;
  if (state.sel.kind === 'usage') paintUsage();
  try {
    const r = await api('/api/agy/usage', { method: 'POST', body: {} });
    state.agyRefreshing = false;
    state.agySwapRefreshing = false;
    if (r.quota) state.agyQuota = r.quota;
    if (typeof r.swapAvailable === 'boolean') state.agySwapAvailable = r.swapAvailable;
    if (Array.isArray(r.swapAccounts)) state.agySwapAccounts = r.swapAccounts;
    state.agyError = r.ok === false ? (r.error || '조회 실패') : null;
    renderSide();
    refreshHomeWidgets();
    if (state.sel.kind === 'usage') paintUsage();
    if (r.ok === false) {
      toast(`Antigravity 조회 실패: ${r.error || '오류'}`, 6000, 'danger');
      return r;
    }
    const sec = r.elapsedMs ? ` (${(r.elapsedMs / 1000).toFixed(1)}초)` : '';
    toast(`Antigravity 한도를 갱신했습니다${sec}`);
    return r;
  } catch (e) {
    state.agyRefreshing = false;
    state.agyError = e.message || 'agy 조회 실패';
    toast(e.message || 'agy 실행 실패', 6000, 'danger');
    if (state.sel.kind === 'usage') paintUsage();
    return { ok: false, error: state.agyError };
  } finally {
    if (btn && btn.isConnected) { btn.disabled = false; btn.innerHTML = prev; }
  }
}
// ---------- reusable right-side Drawer (Astryx Drawer surface) ----------
function openDrawer({ title, bodyHTML = '', footerHTML = '', width = 460 } = {}) {
  const d = document.createElement('div');
  d.className = 'drw-backdrop';
  d.innerHTML = `<div class="drw-panel" style="--drw-w:${width}px" role="dialog" aria-label="${esc(title || '')}">
    <div class="drw-head"><h2>${esc(title || '')}</h2><button class="ghost icon-btn btn-sm" data-drw-close aria-label="닫기" title="닫기 (Esc)">${ICO.close}</button></div>
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

function agyResetLabel(iso, fallbackText) {
  if (iso) {
    const s = (new Date(iso) - Date.now()) / 1000;
    if (s <= 0) return '사용 가능';
    return untilText(iso);
  }
  if (!fallbackText || /^quota available$/i.test(fallbackText)) return '사용 가능';
  return fallbackText;
}
function agyResetDetail(iso, fallbackText) {
  if (iso) {
    const s = (new Date(iso) - Date.now()) / 1000;
    if (s <= 0) return '사용 가능';
    return shortResetAt(iso);
  }
  if (!fallbackText || /^quota available$/i.test(fallbackText)) return '사용 가능';
  return fallbackText;
}
async function switchAgyAccount(email, btn = null) {
  if (!email) return false;
  const openAgy = (state.terms || []).filter((t) => t.exited === null && t.agy && t.account?.email?.toLowerCase() !== email.toLowerCase());
  let restartOpen = false;
  if (openAgy.length) {
    const promptMsg = isEnUI()
      ? `Also restart ${openAgy.length} open Antigravity terminal(s) with ${email}? (Conversations will resume cleanly; Cancel keeps existing terminals on their current session.)`
      : `열려 있는 Antigravity 터미널 ${openAgy.length}개도 ${email} 계정으로 대화를 이어서 전환할까요?\n(확인: 대화 유지한 채 새 계정으로 재개 · 취소: 이후 새 터미널부터 적용)`;
    restartOpen = confirm(promptMsg);
  }
  const prev = btn?.innerHTML;
  if (btn) { btn.disabled = true; btn.textContent = '전환 중…'; }
  try {
    const r = await api('/api/agy/swap', { method: 'POST', body: { account: email, restartOpen } });
    if (r.error) throw new Error(r.error);
    if (Array.isArray(r.accounts)) state.agySwapAccounts = r.accounts;
    const replaced = (r.restartedTerms || []).find((x) => state.sel.kind === 'term' && String(state.sel.id) === String(x.oldId));
    const swCount = r.restartedTerms?.length || 0;
    const doneMsg = isEnUI()
      ? (swCount ? `Switched to ${email} and resumed ${swCount} terminal(s).` : `Switched active Antigravity account to ${email} — new terminals will use it.`)
      : (swCount ? `${email} 계정으로 전환하고 기존 터미널 ${swCount}개를 이어서 재시작했습니다.` : `Antigravity 활성 계정을 ${email}로 전환했습니다. 새 터미널부터 적용됩니다.`);
    toast(doneMsg);
    paintBrandStatus();
    await Promise.all([refreshOverview(), refreshUsage(true)]);
    if (replaced) select({ kind: 'term', id: replaced.newId });
    return true;
  } catch (err) {
    toast(err.message, 6000, 'danger');
    if (btn && btn.isConnected) { btn.disabled = false; if (prev != null) btn.innerHTML = prev; }
    return false;
  }
}
function agyCardHTML(swapAcc) {
  const q = swapAcc
    ? { ...swapAcc, account: swapAcc.email, fetchedAt: state.agyQuota?.fetchedAt || Date.now() }
    : state.agyQuota;
  const titleTxt = swapAcc ? (swapAcc.name || swapAcc.email?.replace(/@.*/, '') || 'Antigravity') : 'Antigravity';
  const cardKey = swapAcc ? swapAcc.id : 'agy';
  const activeCls = swapAcc ? (swapAcc.active ? ' agy-active' : ' agy-standby') : '';
  const switchBtn = swapAcc && !swapAcc.active
    ? `<button type="button" class="btn-sm" data-agy-swap="${esc(swapAcc.email)}" title="이 Antigravity 계정으로 전환">${ICO.swap} 전환</button>`
    : '';
  const activeBadge = swapAcc
    ? (swapAcc.active ? '<span class="badge ok">● 현재 사용 중</span>' : '<span class="badge">대기 계정</span>')
    : '';
  const refreshing = swapAcc ? state.agySwapRefreshing : state.agyRefreshing;
  if (!q?.groups?.length) {
    const hint = refreshing ? '백그라운드에서 조회 중…' : (state.agyError || '클릭해 한도 조회');
    return `<div class="ucard click${activeCls}" data-usage-card="${esc(cardKey)}" title="${esc(swapAcc?.email || '')}">
      <div class="uh">${agentIcon('agy', refreshing ? 'busy' : (swapAcc?.active ? 'idle' : ''))}<b style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(titleTxt)}</b>${activeBadge}${switchBtn}</div>
      <div>
        <div class="ucard-hero"><span class="ucard-big" style="font-size:18px;font-weight:650;color:var(--muted)">조회 대기</span><span class="ums" style="margin:0">${refreshing ? '조회 중' : '클릭해 확인'}</span></div>
      </div>
      <div class="ucard-foot"><span>${esc(hint)}</span><span class="ico">${ICO.chevRight}</span></div>
    </div>`;
  }
  const buckets = [];
  for (const g of q.groups) {
    if (g.fiveH != null) buckets.push({ label: `${g.name} 5시간`, used: g.fiveH, iso: g.fiveHResetAt, text: g.fiveHReset });
    if (g.weekly != null) buckets.push({ label: `${g.name} 주간`, used: g.weekly, iso: g.weeklyResetAt, text: g.weeklyReset });
  }
  buckets.sort((a, b) => b.used - a.used);
  const tight = buckets[0];
  const worst = tight ? tight.used : 0;
  const rem = Math.max(0, Math.round(100 - worst));
  const soon = q.groups.some((g) => isResetTodayIso(g.weeklyResetAt) || isResetTodayText(g.weeklyReset));
  const resetHint = refreshing
    ? '갱신 중…'
    : (tight ? `${tight.label} · ${agyResetLabel(tight.iso, tight.text)}` : (q.account || '상세 보기'));
  return `<div class="ucard click${activeCls}${soon ? ' reset-soon' : ''}" data-usage-card="${esc(cardKey)}" title="${esc(swapAcc?.email || '')}">
    <div class="uh">${agentIcon('agy', refreshing ? 'busy' : (swapAcc?.active ? 'idle' : ''))}<b style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(titleTxt)}</b>${activeBadge}${switchBtn}${soon ? `<span class="badge soon">${ICO.clock} 금일 리셋</span>` : ''}</div>
    <div>
      <div class="ucard-hero"><span class="ucard-big ${level(worst)}">${rem}%</span><span class="ums" style="margin:0">남음 (${Math.round(worst)}% 사용)</span></div>
      <div style="margin-top:8px">${bar(worst)}</div>
    </div>
    <div class="ucard-foot"><span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(resetHint)}</span><span class="ico">${ICO.chevRight}</span></div>
  </div>`;
}
function agyDrawerBodyHTML(q, swapAcc) {
  const src = swapAcc || q;
  if (!src?.groups?.length) {
    return `<div class="empty">${state.agyRefreshing ? 'Antigravity 한도를 조회하는 중입니다…' : esc(state.agyError || '아직 조회된 한도 정보가 없습니다. 아래 “지금 조회”를 눌러 확인하세요.')}</div>`;
  }
  const accLine = swapAcc ? (swapAcc.name ? `${swapAcc.name} <${swapAcc.email}>` : swapAcc.email) : q?.account;
  return `
    ${accLine ? `<div class="drw-kv"><span>계정</span><b>${esc(accLine)}</b></div>` : ''}
    ${swapAcc ? `<div class="drw-kv"><span>상태</span><b>${esc([swapAcc.plan, swapAcc.active ? '현재 활성 계정' : '대기 계정'].filter(Boolean).join(' · '))}</b></div>` : ''}
    ${src.groups.map((g) => `<div class="ugrp"><div class="ugrp-title">${esc(g.name)}</div>
      ${g.models ? `<div class="ums" style="margin-top:-2px">${esc(g.models)}</div>` : ''}
      ${g.fiveH != null ? `<div class="um"><div class="umt"><span>5시간 한도</span><span class="up ${level(g.fiveH)}"><b>${g.fiveHRem}% 남음</b> <span style="font-weight:400;color:var(--muted)">(${pctTxt(g.fiveH)}% 사용)</span></span></div>
        ${bar(g.fiveH)}<div class="ums">${esc(agyResetDetail(g.fiveHResetAt, g.fiveHReset))}</div></div>` : ''}
      ${g.weekly != null ? `<div class="um"><div class="umt"><span>주간 한도</span><span class="up ${level(g.weekly)}"><b>${g.weeklyRem}% 남음</b> <span style="font-weight:400;color:var(--muted)">(${pctTxt(g.weekly)}% 사용)</span></span></div>
        ${bar(g.weekly)}<div class="ums">${esc(agyResetDetail(g.weeklyResetAt, g.weeklyReset))}</div></div>` : ''}</div>`).join('')}
    ${q?.fetchedAt ? `<div class="ums">마지막 조회: ${esc(new Date(q.fetchedAt).toLocaleTimeString(uiLocale()))} (${esc(ago(Date.parse(q.fetchedAt)))})</div>` : ''}`;
}
function openAgyDetailDrawer(cardId = 'agy') {
  const findSwap = () => (cardId && cardId !== 'agy' ? (state.agySwapAccounts || []).find((a) => a.id === cardId) : null);
  let swapAcc = findSwap();
  const canSwap = () => swapAcc && !swapAcc.active;
  const buildFooter = () => `<button data-drw-close>닫기</button>${canSwap() ? `<button id="drwAgySwap">${ICO.swap} 이 계정으로 전환</button>` : ''}<button class="primary" id="drwAgyRef">${ICO.refresh} 지금 조회</button>`;
  const d = openDrawer({
    title: swapAcc ? `Antigravity · ${swapAcc.name || swapAcc.email}` : 'Antigravity 한도 상세',
    bodyHTML: agyDrawerBodyHTML(state.agyQuota, swapAcc),
    footerHTML: buildFooter(),
    width: 460,
  });
  const bindActions = () => {
    const refBtn = $('#drwAgyRef', d);
    const swapBtn = $('#drwAgySwap', d);
    const runRefresh = async () => {
      await openAgyUsage(refBtn);
      swapAcc = findSwap();
      const bodyEl = $('.drw-body', d);
      if (bodyEl && d.isConnected) bodyEl.innerHTML = agyDrawerBodyHTML(state.agyQuota, swapAcc);
    };
    if (refBtn) refBtn.onclick = runRefresh;
    if (swapBtn) {
      swapBtn.onclick = async () => {
        if (!swapAcc) return;
        const ok = await switchAgyAccount(swapAcc.email, swapBtn);
        if (!ok) return;
        swapAcc = findSwap();
        const bodyEl = $('.drw-body', d);
        const footEl = $('.drw-foot', d);
        if (bodyEl && d.isConnected) bodyEl.innerHTML = agyDrawerBodyHTML(state.agyQuota, swapAcc);
        if (footEl && d.isConnected) { footEl.innerHTML = buildFooter(); bindActions(); }
      };
    }
  };
  bindActions();
  if (!state.agyQuota?.groups?.length && !state.agyRefreshing) $('#drwAgyRef', d)?.click();
}
function openUsageDetailDrawer(a) {
  if (!a) return;
  const meterRow = (m) => {
    const used = m.usedPercent != null ? Math.round(Number(m.usedPercent)) : null;
    const rem = used != null ? Math.max(0, 100 - used) : null;
    return `<div class="um"><div class="umt"><span>${esc(m.name)}</span>${used != null ? `<span class="up ${level(used)}"><b>${rem}% 남음</b> <span style="font-weight:400;color:var(--muted)">(${used}% 사용)</span></span>` : ''}</div>
    ${used != null ? bar(used) : ''}<div class="ums">${[m.resetsAt ? shortResetAt(m.resetsAt) : '', m.detail ? esc(m.detail) : ''].filter(Boolean).join(' · ')}</div></div>`;
  };
  const footNotes = [
    a.billing?.at ? `${esc(a.billing.label)}: ${esc(new Date(a.billing.at).toLocaleDateString(uiLocale()))}` : '',
    ...(a.notes || []).map((n) => esc(cleanNote(n))),
  ].filter(Boolean);
  const body = `
    <div class="row" style="gap:8px">${agentIcon(usageKindOf(a) === 'other' ? 'bot' : usageKindOf(a), a.live ? 'idle' : '')}<b>${esc(a.label)}</b>${a.plan ? `<span class="badge">${esc(a.plan)}</span>` : ''}</div>
    ${!a.ok ? `<div class="err" style="padding:0">${esc(a.error || '조회 실패')}</div>` : ''}
    ${(a.meters || []).length ? `<div class="ugrp">${a.meters.map(meterRow).join('')}</div>` : '<div class="empty" style="padding:0">표시할 상세 미터가 없습니다.</div>'}
    ${footNotes.length ? `<div class="ugrp">${footNotes.map((t) => `<div class="ums">${t}</div>`).join('')}</div>` : ''}`;
  openDrawer({ title: `${a.label} · 상세`, bodyHTML: body, footerHTML: '<button data-drw-close>닫기</button>', width: 460 });
}
function usageKindOf(a) {
  const tag = `${a.type || ''} ${a.provider || ''}`;
  if (/claude/i.test(tag)) return 'claude';
  if (/codex|chatgpt|openai/i.test(tag)) return 'codex';
  if (/agy|antigravity/i.test(tag)) return 'agy';
  return 'other';
}
function usageWorstOf(a) {
  const pcts = (a.meters || []).map((m) => m.usedPercent).filter((v) => v != null);
  return a.ok && pcts.length ? Math.max(...pcts) : null;
}
function viewUsage() {
  setBar('');
  $('#view').onclick = async (e) => {
    const sysTab = e.target.closest('[data-systab]');
    if (sysTab) return select({ kind: sysTab.dataset.systab });
    if (e.target.closest('#uAccounts')) return openAccounts();
    const more = e.target.closest('#uMore');
    if (more) {
      e.stopPropagation();
      return openMoreMenu(more, [
        { label: 'Antigravity 한도 조회 (/usage)', icon: ICO.chart, onClick: () => openAgyUsage(null) },
      ]);
    }
    const rb = e.target.closest('#uRefresh');
    if (rb) {
      rb.disabled = true; rb.textContent = '조회 중…';
      await refreshUsage(true);
      return;
    }
    const f = e.target.closest('[data-ufilt]');
    if (f) { state.usageFilter = f.dataset.ufilt; return paintUsage(); }
    const agySwapBtn = e.target.closest('[data-agy-swap]');
    if (agySwapBtn) {
      e.stopPropagation();
      return switchAgyAccount(agySwapBtn.dataset.agySwap, agySwapBtn);
    }
    const card = e.target.closest('[data-usage-card]');
    if (card) {
      const id = card.dataset.usageCard;
      if (id === 'agy' || id.startsWith('agyswap:')) return openAgyDetailDrawer(id);
      const acc = (state.usage?.accounts || []).find((a) => String(a.id || a.label) === id);
      if (acc) openUsageDetailDrawer(acc);
    }
  };
  paintUsage();
}
function paintUsage() {
  const u = state.usage;
  const sysActs = `<button class="btn-sm" id="uAccounts">계정 관리</button>
    <button class="primary btn-sm" id="uRefresh" title="제공사에 다시 조회">${ICO.refresh} 지금 조회</button>
    <button class="ghost icon-btn btn-sm" id="uMore" aria-label="AI 사용량 메뉴" aria-haspopup="menu" aria-expanded="false">${ICO.more}</button>`;
  const sysTop = systemTopHTML('usage', sysActs);
  if (!u) { $('#view').innerHTML = `<div class="sys-shell">${sysTop}<div class="sys-body"><div class="page-wrap"><div class="empty">불러오는 중…</div></div></div></div>`; return; }
  if (!u.available) {
    $('#view').innerHTML = `<div class="sys-shell">${sysTop}<div class="sys-body"><div class="page-wrap"><div class="h-empty-card" style="align-items:flex-start;text-align:left;gap:10px">
      <div class="row" style="gap:8px"><span class="dot busy"></span><b style="font-size:15px">AI 사용량 서버(127.0.0.1:4777)가 현재 꺼져 있습니다</b></div>
      <div class="ums" style="margin:0">${esc(u.error || 'AI 사용량 대시보드에 연결할 수 없습니다.')}</div>
      <div class="row" style="gap:8px;margin-top:4px">
        <button class="primary" id="btnUsageStartNow">${ICO.play} 사용량 서버 지금 켜기</button>
        <button id="btnUsageRetry">${ICO.refresh} 다시 확인</button>
      </div>
    </div></div></div></div>`;
    const sb = $('#btnUsageStartNow');
    if (sb) {
      sb.onclick = async () => {
        sb.disabled = true; sb.textContent = '서버 시작 중…';
        try {
          const r = await api('/api/services/usage/start', { method: 'POST', body: {} });
          if (!r.ok) throw new Error(r.error || '시작 실패');
          toast('AI 사용량 서버(:4777)를 시작했습니다');
          await Promise.all([refreshOverview(), refreshUsage(true)]);
        } catch (er) {
          toast(er.message, 5000, 'danger');
          if (sb.isConnected) { sb.disabled = false; sb.innerHTML = `${ICO.play} 사용량 서버 지금 켜기`; }
        }
      };
    }
    const rb = $('#btnUsageRetry');
    if (rb) rb.onclick = () => refreshUsage(true);
    return;
  }

  const allAccs = u.accounts || [];
  const swapAccs = state.agySwapAccounts || [];
  const swapWorstOf = (sa) => {
    const pcts = (sa?.groups || []).flatMap((g) => [g.fiveH, g.weekly]).filter((v) => v != null);
    return pcts.length ? Math.max(...pcts) : null;
  };
  const hasAgy = !!(state.agyQuota?.groups?.length);
  const agyAllUsed = hasAgy ? state.agyQuota.groups.flatMap((g) => [g.fiveH, g.weekly]).filter((v) => v != null) : [];
  const agyWorst = agyAllUsed.length ? Math.max(...agyAllUsed) : null;
  const agyCount = swapAccs.length || 1;

  const counts = { all: allAccs.length + agyCount, tight: 0, claude: 0, codex: 0, agy: agyCount, other: 0 };
  for (const a of allAccs) {
    const k = usageKindOf(a);
    counts[k] = (counts[k] || 0) + 1;
    const w = usageWorstOf(a);
    if (w != null && w >= 90) counts.tight++;
  }
  if (swapAccs.length) {
    for (const sa of swapAccs) { const w = swapWorstOf(sa); if (w != null && w >= 90) counts.tight++; }
  } else if (agyWorst != null && agyWorst >= 90) counts.tight++;

  const uf = state.usageFilter || 'all';
  const us = state.usageSort || 'headroom-desc';
  const filtered = allAccs.filter((a) => {
    if (uf === 'all') return true;
    if (uf === 'tight') { const w = usageWorstOf(a); return w != null && w >= 90; }
    return usageKindOf(a) === uf;
  });
  const sorted = filtered.slice().sort((a, b) => {
    const wa = usageWorstOf(a), wb = usageWorstOf(b);
    if (us === 'headroom-desc') {
      if (wa == null && wb == null) return 0;
      if (wa == null) return 1;
      if (wb == null) return -1;
      return wa - wb;
    }
    if (us === 'headroom-asc') {
      if (wa == null && wb == null) return 0;
      if (wa == null) return 1;
      if (wb == null) return -1;
      return wb - wa;
    }
    return String(a.label || '').localeCompare(String(b.label || ''), 'ko');
  });
  const shownSwapAgy = swapAccs.filter((sa) => uf === 'all' || uf === 'agy' || (uf === 'tight' && (swapWorstOf(sa) ?? -1) >= 90));
  const showFallbackAgy = !swapAccs.length && (uf === 'all' || uf === 'agy' || (uf === 'tight' && agyWorst != null && agyWorst >= 90));

  const seg = (val, label, cnt) => `<button data-ufilt="${val}" class="${uf === val ? 'on' : ''}">${label}${cnt ? ` <span class="seg-cnt">${cnt}</span>` : ''}</button>`;
  const controls = `<div class="row" style="justify-content:space-between;gap:10px">
    <div class="seg" role="tablist" aria-label="AI 사용량 필터">
      ${seg('all', '전체', counts.all)}
      ${counts.tight ? seg('tight', '90%+ 임박', counts.tight) : ''}
      ${counts.claude ? seg('claude', 'Claude', counts.claude) : ''}
      ${counts.codex ? seg('codex', 'Codex', counts.codex) : ''}
      ${counts.agy ? seg('agy', 'AGY', counts.agy) : ''}
      ${counts.other ? seg('other', '기타', counts.other) : ''}
    </div>
    <select id="uSort" class="btn-sm" aria-label="정렬">
      <option value="headroom-desc" ${us === 'headroom-desc' ? 'selected' : ''}>남은 한도 많은순</option>
      <option value="headroom-asc" ${us === 'headroom-asc' ? 'selected' : ''}>남은 한도 적은순</option>
      <option value="name" ${us === 'name' ? 'selected' : ''}>이름순</option>
    </select>
  </div>`;

  // Minimal 3-element cards: Brand + Name | Big Remaining % + Bar | Next Reset (click → Detail Drawer)
  const cards = sorted.map((a) => {
    const worst = usageWorstOf(a);
    const rem = worst != null ? Math.max(0, Math.round(100 - worst)) : null;
    const soon = a.ok && (a.meters || []).some((m) => /주간|weekly/i.test(m.name || '') && (isResetTodayIso(m.resetsAt) || isResetTodayText(m.detail)));
    const kind = usageKindOf(a) === 'other' ? 'bot' : usageKindOf(a);
    const tightMeter = (a.meters || []).slice().sort((x, y) => (y.usedPercent ?? -1) - (x.usedPercent ?? -1))[0];
    const resetHint = !a.ok
      ? (a.error || '조회 실패')
      : tightMeter?.resetsAt
        ? `${tightMeter.name} · ${untilText(tightMeter.resetsAt)}`
        : tightMeter?.detail || a.plan || '상세 보기';
    return `<div class="ucard click${soon ? ' reset-soon' : ''}" data-usage-card="${esc(a.id || a.label)}">
      <div class="uh">${agentIcon(kind, a.live ? 'idle' : '')}<b>${esc(shortLabel(a))}</b>${soon ? `<span class="badge soon">${ICO.clock} 금일 리셋</span>` : ''}</div>
      <div>
        <div class="ucard-hero"><span class="ucard-big ${worst != null ? level(worst) : ''}"${rem == null ? ' style="font-size:18px;font-weight:650;color:var(--muted)"' : ''}>${rem != null ? `${rem}%` : '유효'}</span><span class="ums" style="margin:0">${rem != null ? `남음 (${Math.round(worst)}% 사용)` : '상세 보기'}</span></div>
        <div style="margin-top:8px">${worst != null ? bar(worst) : ''}</div>
      </div>
      <div class="ucard-foot"><span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(resetHint)}</span><span class="ico">${ICO.chevRight}</span></div>
    </div>`;
  }).join('');
  const agyCards = swapAccs.length ? shownSwapAgy.map((sa) => agyCardHTML(sa)).join('') : (showFallbackAgy ? agyCardHTML() : '');
  const gridContent = `${cards}${agyCards}`;
  $('#view').innerHTML = `<div class="sys-shell">${sysTop}<div class="sys-body"><div class="page-wrap">${controls}${gridContent ? `<div class="ugrid">${gridContent}</div>` : '<div class="h-empty-card"><b>조건에 맞는 계정이 없습니다</b></div>'}</div></div></div>`;
  const sortEl = $('#uSort');
  if (sortEl) sortEl.onchange = (e) => { state.usageSort = e.target.value; paintUsage(); };
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
  const d = openDrawer({
    title: 'AI 사용량 계정 관리',
    bodyHTML: '<div id="acBody">불러오는 중…</div>',
    footerHTML: '<button data-drw-close>닫기</button><button class="primary" id="acAdd">계정 추가</button>',
    width: 480,
  });
  const paint = async () => {
    const r = await api('/api/usage/accounts').catch((e) => ({ error: e.message }));
    const body = $('#acBody', d);
    if (r.error) { body.innerHTML = `<div class="err">${esc(r.error)}</div>`; return; }
    const opts = Object.entries(ACCOUNT_TYPES).map(([k, v]) => `<option value="${k}">${esc(v.name)}</option>`).join('');
    const swapRows = (state.agySwapAccounts || []).map((a) => `<div class="swrow" style="${a.active ? 'background:color-mix(in srgb, var(--ok) 7%, transparent);border-radius:6px;padding:6px 8px' : ''}">
      <span class="swl" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">${agentIcon('agy', a.active ? 'idle' : '')}<span>${esc(a.name ? `${a.name} (${a.email})` : a.email)}</span>${a.active ? '<span class="badge ok">● 현재 사용 중</span>' : '<span class="badge">대기 계정</span>'}</span>
      ${a.active ? '' : `<button type="button" class="btn-sm" data-ac-agyswap="${esc(a.email)}">${ICO.swap} 전환</button>`}
    </div>`).join('');
    body.innerHTML = `
      <div class="empty" style="padding:0">이 PC에서 자동 감지 ${r.detected?.length || 0}개 (Claude Code·Cursor·Codex 로그인) · 직접 추가 ${r.accounts?.length || 0}개${state.agySwapAccounts?.length ? ` · Antigravity ${state.agySwapAccounts.length}개` : ''}</div>
      ${swapRows ? `<div class="swlist">${swapRows}</div>` : ''}
      <div class="swlist">${(r.accounts || []).map((a) => `<div class="swrow"><span class="swl">${esc(a.label || a.id)} <span class="badge">${esc(ACCOUNT_TYPES[a.type]?.name || a.type)}</span></span>
        <button class="danger ghost btn-sm" data-del="${esc(a.id)}">삭제</button></div>`).join('') || (!swapRows ? '<div class="empty">직접 추가한 계정 없음</div>' : '')}</div>
      <h3 style="margin:8px 0 0;font-size:14px">계정 추가</h3>
      <div class="row" style="gap:6px;flex-wrap:wrap">
        <button id="acCodex" title="터미널이 열리고 코드가 나옵니다. 아무 브라우저(폰도 가능)에서 그 주소를 열어 코드를 넣고, 추가할 ChatGPT 계정으로 로그인하면 끝">＋ Codex 계정 추가 (ChatGPT 로그인)</button>
        ${state.agySwapAvailable ? '<button id="acAgy" title="agy-swap 로그인 터미널을 열어 새 Google Antigravity 계정을 추가합니다">＋ Antigravity 계정 추가 (Google 로그인)</button>' : ''}
      </div>
      <div class="empty" style="padding:0">Codex · Antigravity 계정이 여럿이면 터미널의 “다른 계정” 버튼으로 같은 대화를 다른 계정에서 이어갈 수 있습니다.</div>
      <label>종류<br><select id="acType" style="width:100%">${opts}</select></label>
      <label>이름(라벨)<br><input id="acLabel" style="width:100%" placeholder="예: 연구실 계정"></label>
      <div id="acFields"></div>
      <div class="empty" id="acHelp" style="padding:0"></div>
      <div class="empty" style="padding:0">토큰·키는 이 PC의 AI 사용량 대시보드 설정 파일에만 저장되고, 화면에는 가려서 표시됩니다.</div>`;
    const fields = () => {
      const t = ACCOUNT_TYPES[$('#acType', d).value];
      $('#acFields', d).innerHTML = t.fields.map(([k, lab, typ]) => `<label>${esc(lab)}<br><input data-f="${k}" type="${typ}" style="width:100%" autocomplete="off"></label>`).join('');
      $('#acHelp', d).innerHTML = t.help;
    };
    $('#acType', d).onchange = fields; fields();
    $('#acCodex', d).onclick = async () => {
      const t = await api('/api/codex/add', { method: 'POST', body: {} }).catch((e) => ({ error: e.message }));
      if (t.error) return toast(t.error, 6000, 'danger');
      d.close();
      await refreshOverview();
      select({ kind: 'term', id: t.id });
      toast('터미널에 나온 주소와 코드로 로그인하세요 — 끝나면 자동 등록됩니다', 8000);
    };
    const agyAddBtn = $('#acAgy', d);
    if (agyAddBtn) {
      agyAddBtn.onclick = async () => {
        const t = await api('/api/agy/add', { method: 'POST', body: {} }).catch((e) => ({ error: e.message }));
        if (t.error) return toast(t.error, 6000, 'danger');
        d.close();
        await refreshOverview();
        select({ kind: 'term', id: t.id });
        toast('터미널 안내에 따라 Google 계정을 로그인·추가하세요', 8000);
      };
    }
    body.querySelectorAll('[data-ac-agyswap]').forEach((b) => (b.onclick = async () => {
      if (await switchAgyAccount(b.dataset.acAgyswap, b)) paint();
    }));
    body.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
      if (!confirm('이 계정을 목록에서 삭제할까요?')) return;
      const x = await api('/api/usage/accounts', { method: 'POST', body: { action: 'delete', id: b.dataset.del } });
      if (x.error) return toast(x.error, 6000, 'danger');
      paint(); refreshUsage();
    }));
    $('#acAdd', d).onclick = async () => {
      const account = { type: $('#acType', d).value, label: $('#acLabel', d).value.trim() };
      d.querySelectorAll('[data-f]').forEach((i) => { if (i.value.trim()) account[i.dataset.f] = i.type === 'number' ? Number(i.value) : i.value.trim(); });
      if (!account.label) return toast('이름을 입력하세요');
      const x = await api('/api/usage/accounts', { method: 'POST', body: { account } });
      if (x.error) return toast(x.error, 8000, 'danger');
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
        <button class="ahide" data-ahide="${i}" aria-label="목록에서 숨기기" title="목록에서 숨기기">${ICO.close}</button><button class="asend" data-asend="${i}" aria-label="세션에 보내기" title="이 파일을 세션에 보내기 (경로 멘션)">${ICO.arrowUpRight}</button></div>`;
    $('#view').innerHTML = `<div class="subtoolbar">
        <div class="seg" role="tablist" aria-label="산출물 범위">
          <button data-art-scope="main" class="${!artShowAll ? 'on' : ''}">주요 산출물 <span class="seg-cnt">${all.filter((x) => x.main).length}</span></button>
          <button data-art-scope="all" class="${artShowAll ? 'on' : ''}">전체 파일 <span class="seg-cnt">${all.length}</span></button>
        </div>
        <span class="sp"></span>
        ${artOrderSel()}
        <button id="artAdd" class="btn-sm">${ICO.plus} 산출물 지정</button>
      </div>
      <div class="rwrap">
      ${items.length ? artTimeline(items.map((it, i) => [it, i]), card) : `<div class="h-empty-card" style="margin-top:8px"><b>아직 등록된 산출물이 없습니다</b><span class="ums" style="margin:0;max-width:460px">대화에 나온 파일 경로가 자동으로 모이며, 직접 파일을 지정하거나 코드 구조 탭에서 보고서(FLOORPLAN.md)를 저장할 수 있습니다.</span><button type="button" class="primary btn-sm" id="artEmptyAdd" style="margin-top:6px">${ICO.plus} 산출물 지정</button></div>`}</div>`;
    bindArtOrder(paint);
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
  const d = document.createElement('div');
  d.className = 'dlg';
  d.innerHTML = `<div class="box wide aview"><div class="row"><b style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(it.path)}">${ART_ICON[it.kind] || ''} ${esc(it.title || it.name)}</b>
      <a class="btnlike btn-sm" href="${url}" target="_blank" rel="noopener">${ICO.external} 새 탭</a><a class="btnlike btn-sm" href="${url}&dl=1" download="${esc(it.name)}">다운로드</a><button class="primary btn-sm" id="avSend" title="이 파일 경로를 세션에 보내기">${ICO.arrowUpRight} 세션에</button><button class="ghost icon-btn btn-sm" id="avClose" aria-label="닫기">${ICO.close}</button></div>
    <div class="ums mono" style="word-break:break-all">${esc(it.path)} · ${fmtSize(it.size)}</div>
    <div id="avBody" class="avbody">불러오는 중…</div></div>`;
  document.body.appendChild(d);
  const close = () => d.remove();
  d.onclick = (e) => { if (e.target === d || e.target.closest('#avClose')) close(); if (e.target.closest('#avSend')) sendPathDialog(it.abs || it.path); };
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

// ---------- account switch drawer (accessible via session/terminal ⋯ menu) ----------
document.addEventListener('click', (e) => {
  const cb = e.target.closest('[data-copy-code]');
  if (cb) {
    e.stopPropagation();
    const pre = cb.closest('.codeblk')?.querySelector('.mdpre');
    if (pre) copyText(pre.textContent);
  }
}, true);
async function runSwitchRequest(payload) {
  let res = await api('/api/switch', { method: 'POST', body: payload });
  if (res.busy && confirm('세션이 작업 중입니다. 중단(Esc)하고 전환할까요?')) {
    res = await api('/api/switch', { method: 'POST', body: { ...payload, interrupt: true } });
  }
  if (res.stuck && confirm(res.error)) {
    res = await api('/api/switch', { method: 'POST', body: { ...payload, interrupt: true, force: true } });
  }
  return res;
}

async function openSwitch(sid, termId = '') {
  const d = openDrawer({
    title: '다른 계정 · 에이전트로 이어하기',
    bodyHTML: '<div id="swBody">AI 사용량 및 계정 확인 중…</div>',
    footerHTML: '<button data-drw-close>취소</button><button class="primary" id="swGo" disabled>이어하기</button>',
    width: 520,
  });
  const r = await api(`/api/switch/candidates?id=${encodeURIComponent(sid)}${termId ? `&term=${encodeURIComponent(termId)}` : ''}`).catch((e) => ({ error: e.message }));
  const body = $('#swBody', d);
  if (r.error || !r.candidates) { body.innerHTML = `<div class="err">${esc(r.error || '후보를 불러오지 못함')}</div>`; return; }
  const s = state.live.find((x) => x.sessionId === sid);
  const srcAgent = r.sourceAgent || 'claude';
  const agentName = (a) => (a === 'codex' ? 'Codex' : a === 'agy' ? 'Antigravity / Gemini' : 'Claude Code');
  const pct = (v) => (v === null || v === undefined ? '<span class="up">?</span>' : `${bar(v, true)}<span class="up ${level(v)}">${Math.max(0, Math.round(100 - v))}%</span>`);
  const rowHTML = (c) => `<label class="swrow${c.usable && !c.current ? '' : ' dis'}" data-agent="${esc(c.agent || 'claude')}">
        <input type="radio" name="acc" value="${esc(c.id)}" data-agent="${esc(c.agent || 'claude')}" ${c.best ? 'checked' : ''} ${c.usable && !c.current ? '' : 'disabled'}>
        <span class="swl" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
          ${agentIcon(c.agent || 'claude')}
          <span>${esc(c.label)}</span>
          ${c.current ? `<span class="badge">${c.sameAccount ? '현재와 같은 계정' : '현재 실행 중'}</span>` : (c.active ? '<span class="badge ok">● AGY 활성</span>' : '')}
          ${c.best ? '<span class="badge c">가장 여유</span>' : ''}
        </span>
        <span class="swm">5h ${pct(c.fiveH)}</span><span class="swm">주 ${pct(c.weekly)}</span></label>`;
  const samePlat = r.candidates.filter((c) => !c.agent || c.agent === srcAgent);
  const crossPlat = r.candidates.filter((c) => c.agent && c.agent !== srcAgent);
  const meFieldsHTML = `<div class="pj-me-grid" style="margin:8px 0 2px">
    <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--muted)">모델
      <select name="modelPick"></select>
      <input name="model" maxlength="120" placeholder="모델 ID 직접 입력" style="display:none;margin-top:4px">
    </label>
    <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--muted)">추론 성능
      <select name="effort"></select>
    </label>
  </div><small data-cli-opt-hint class="ums" style="margin:0 0 4px"></small>`;
  body.innerHTML = `
    ${s?.limit ? `<div class="err" style="padding:0 0 6px">${esc(s.limit.text)}</div>` : ''}
    <div class="empty" style="padding:0 0 4px">숫자는 남은 한도(%) 기준입니다. 같은 플랫폼은 그대로 재개하고, 다른 플랫폼은 직전 맥락(handoff)을 자동 인계합니다.</div>
    <div class="swlist">
      ${samePlat.length ? `<div class="swgrp-hd">같은 플랫폼 · 즉시 재개</div>${samePlat.map(rowHTML).join('')}` : ''}
      ${crossPlat.length ? `<div class="swgrp-hd">다른 플랫폼 · 맥락 교차 인계</div>${crossPlat.map(rowHTML).join('')}` : ''}
    </div>
    ${meFieldsHTML}
    <div class="row" style="gap:14px;padding:6px 0 2px;flex-wrap:wrap">
      <span class="ums" style="font-weight:600;color:var(--text)">열기 위치:</span>
      <label class="row" style="gap:5px"><input type="radio" name="swMode" value="dashboard" checked> 대시보드 터미널</label>
      <label class="row" style="gap:5px"><input type="radio" name="swMode" value="external"> 외부 Windows 콘솔 창</label>
    </div>
    <label class="row"><input type="checkbox" id="swCont"> 전환 후 즉시 “계속 진행해” 자동 실행 (교차 플랫폼은 미체크여도 맥락 파일은 항상 전달)</label>
    <label class="row" id="swSkipRow"><input type="checkbox" id="swSkip" checked> YOLO 모드 자동 승인으로 실행 (Claude · Codex · Antigravity)</label>
    <div id="swHint" class="empty" style="padding:4px 0 0"></div>`;
  const goBtn = $('#swGo', d);
  if (goBtn) goBtn.disabled = !r.candidates.some((c) => c.best || (c.usable && !c.current));
  const initSelAgent = $('input[name=acc]:checked', d)?.dataset.agent || srcAgent;
  const swMeCtl = typeof createCliModelEffortController === 'function'
    ? createCliModelEffortController({
      modelPick: d.querySelector('[name=modelPick]'),
      modelIn: d.querySelector('[name=model]'),
      effortSel: d.querySelector('[name=effort]'),
      hintEl: d.querySelector('[data-cli-opt-hint]'),
      initialKind: initSelAgent,
    })
    : null;
  const updateHint = () => {
    const sel = $('input[name=acc]:checked', d);
    const targetAgent = sel?.dataset.agent || srcAgent;
    swMeCtl?.setCli(targetAgent);
    const mode = $('input[name=swMode]:checked', d)?.value || 'dashboard';
    const whereTxt = mode === 'external' ? '새 Windows 외부 콘솔 창' : '대시보드 터미널';
    const skipRow = $('#swSkipRow', d);
    if (skipRow) skipRow.style.display = (targetAgent === 'claude' || targetAgent === 'agy') ? 'flex' : 'none';
    const hint = $('#swHint', d);
    if (!hint) return;
    if (targetAgent !== srcAgent) {
      hint.innerHTML = isEnUI()
        ? `<b>${esc(agentName(srcAgent))} → ${esc(agentName(targetAgent))} handoff:</b> Saves recent conversation context to <code>handoff.md</code>, then starts a ${esc(agentName(targetAgent))} session in ${whereTxt} with it.`
        : `<b>${esc(agentName(srcAgent))} → ${esc(agentName(targetAgent))} 교차 이동:</b> 최근 대화 맥락을 요약 파일(<code>handoff.md</code>)로 저장한 뒤 ${whereTxt}에서 ${esc(agentName(targetAgent))} 세션을 시작하여 자동으로 전달합니다.`;
    } else if (r.fresh) {
      hint.textContent = isEnUI()
        ? `This terminal has no conversation yet; starting fresh in the same folder (${whereTxt}) with the selected account.`
        : `아직 대화가 없는 터미널이라, 같은 폴더(${whereTxt})에서 고른 계정으로 새로 시작합니다.`;
    } else if (r.live) {
      hint.textContent = isEnUI()
        ? `Closes the running session (${r.where || 'no window'}) and continues the same conversation in ${whereTxt}.`
        : `실행 중인 세션(${r.where || '창 없음'})을 종료한 뒤 ${whereTxt}에서 같은 대화를 이어갑니다.`;
    } else {
      hint.textContent = isEnUI()
        ? `Continues this conversation with the selected account in ${whereTxt}.${r.stale ? ' · Usage data may be stale' : ''}`
        : `선택한 계정으로 ${whereTxt}에서 대화를 이어 실행합니다.${r.stale ? ' · 사용량 값이 오래됐을 수 있음' : ''}`;
    }
  };
  d.querySelectorAll('input[name=acc], input[name=swMode]').forEach((el) => (el.onchange = updateHint));
  updateHint();
  $('#swGo', d).onclick = async () => {
    const acc = $('input[name=acc]:checked', d)?.value;
    if (!acc) return;
    const openMode = $('input[name=swMode]:checked', d)?.value || 'dashboard';
    const meVals = swMeCtl ? swMeCtl.getValues() : { model: '', effort: '' };
    const targetAg = $('input[name=acc]:checked', d)?.dataset.agent || srcAgent;
    if (typeof saveCliDefaults === 'function') saveCliDefaults(targetAg, { account: acc, model: meVals.model, effort: meVals.effort });
    const go = $('#swGo', d); go.disabled = true; go.textContent = '전환 중…';
    const payload = {
      sessionId: sid || undefined,
      termId: termId || undefined,
      account: acc,
      model: meVals.model,
      effort: meVals.effort,
      cont: $('#swCont', d).checked,
      skip: $('#swSkip', d)?.checked ?? true,
      openMode,
    };
    const res = await runSwitchRequest(payload);
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
function openGpuHelpDrawer() {
  const body = `
    <div class="empty" style="padding:0">세션·에이전트에서 GPU 대기열을 통해 작업을 안전하게 예약/실행합니다.</div>
    <pre class="mdpre">ccd gpu run --mem 20G --label exp-003 -- python train.py   # 차례가 되면 실행, 끝나면 자동 해제
ccd gpu run --exclusive -- python big_job.py              # GPU 전체를 혼자 사용
ccd gpu request --mem 8G --wait  →  ccd gpu release &lt;id&gt;  # 직접 잡고 놓기
ccd gpu                                                  # 상태·대기열 (GPU별 줄)
ccd gpu plan --mem 12G --est 2h                          # GPU별 시작·종료 예상</pre>
    <div class="empty" style="padding:0"><b>끼워넣기(Backfill):</b> 맨 앞 작업의 예상 시작 시각 전에 끝나거나 자리를 남기는 작업만 먼저 실행합니다. 예상 시간은 행의 시계 버튼 또는 <code>--est 90m</code>으로 설정하세요.</div>`;
  openDrawer({ title: 'GPU 대기열 CLI 사용법', bodyHTML: body, width: 540 });
}
function openGpuJobDrawer(t, isWaiting) {
  if (!t) return;
  const mins = (ms) => { const m = Math.round(ms / 60000); return m >= 60 ? `${Math.floor(m / 60)}시간 ${m % 60}분` : `${m}분`; };
  const who = t.requester?.title || (t.requester?.pid ? `pid ${t.requester.pid}` : '알 수 없음');
  const body = `
    <div>
      <div class="drw-kv"><span>상태</span><b>${isWaiting ? `대기 중 (${t.position}번째 · ${mins(t.waitedMs)})` : `사용 중 (${mins(Date.now() - t.grantedAt)})`}</b></div>
      <div class="drw-kv"><span>GPU</span><b>${esc(isWaiting && t.lanes?.length ? t.lanes.join(' · ') : t.gpu || '—')}</b></div>
      <div class="drw-kv"><span>메모리</span><b>${t.exclusive ? '전용 사용' : t.memMB == null ? '미측정' : fmtMB(t.memMB)}</b></div>
      <div class="drw-kv"><span>요청 세션</span><b>${esc(who)}</b></div>
      ${t.expectedStart ? `<div class="drw-kv"><span>예상 시작</span><b>${esc(new Date(t.expectedStart).toLocaleTimeString(uiLocale(), { hour: '2-digit', minute: '2-digit' }))}</b></div>` : ''}
      ${t.expectedEnd ? `<div class="drw-kv"><span>예상 종료</span><b>${esc(new Date(t.expectedEnd).toLocaleTimeString(uiLocale(), { hour: '2-digit', minute: '2-digit' }))}${t.estSource === 'learned' ? ' (학습됨)' : ''}</b></div>` : ''}
      ${t.adopted ? '<div class="drw-kv"><span>감지 방식</span><b>대기열 밖 프로세스 자동 등록</b></div>' : ''}
      ${t.backfilled ? '<div class="drw-kv"><span>배정</span><b>끼워넣기(Backfill)</b></div>' : ''}
    </div>
    ${t.command ? `<div class="drw-sec"><div class="drw-lbl">실행 명령</div><pre class="mdpre">${esc(t.command)}</pre></div>` : ''}`;
  const foot = `
    <button class="danger ghost" data-dg="release">${t.adopted ? '등록 해제' : isWaiting ? '대기 취소' : '예약 해제'}</button>
    <span class="sp"></span>
    ${isWaiting && t.position > 1 ? '<button data-dg="top">맨 앞으로</button>' : ''}
    <button class="primary" data-dg="est">${ICO.clock} 예상 시간</button>`;
  const d = openDrawer({ title: t.label || t.id, bodyHTML: body, footerHTML: foot, width: 460 });
  d.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-dg]')?.dataset.dg;
    if (!a) return;
    if (a === 'est') {
      d.close();
      return openEstimateDialog({
        title: '예상 시간 설정',
        onSubmit: async (v) => {
          const r = await api('/api/gpu/est', { method: 'POST', body: /^\d{1,2}:\d{2}$/.test(v) ? { id: t.id, until: v } : { id: t.id, est: v } });
          toast(r.ok ? `예상 ${r.estMin}분으로 설정` : r.error, 4000, r.ok ? 'default' : 'danger');
          refreshGpu();
        },
      });
    }
    if (a === 'release' && !confirm('대기열에서 빼시겠어요? 실행 중인 프로세스는 종료되지 않습니다.')) return;
    d.close();
    await api(a === 'top' ? '/api/gpu/priority' : '/api/gpu/release', { method: 'POST', body: { id: t.id, byUser: true } });
    refreshGpu();
  });
}

function openGpuDeviceDrawer(g) {
  if (!g) return;
  const ext = Math.max(0, g.usedMB - g.leasedMB), freeMB = Math.max(0, g.totalMB - g.usedMB);
  const memPct = g.totalMB ? Math.round((g.usedMB / g.totalMB) * 100) : 0;
  const seg = (mb, cls) => g.totalMB ? `<i class="${cls}" style="width:${(mb / g.totalMB) * 100}%"></i>` : '';
  const procList = (g.activeProcs?.length ? g.activeProcs : g.procs) || [];
  const clkInfo = [g.pstate ? `${g.pstate}${/^P[358]$/i.test(g.pstate) ? ' (절전 유휴)' : ''}` : '', g.clockMHz ? `${g.clockMHz}${g.maxClockMHz ? '/' + g.maxClockMHz : ''} MHz` : ''].filter(Boolean).join(' · ');
  const body = `
    <div class="um"><div class="umt"><span>GPU 코어 사용률</span><span class="up ${level(g.util)}">${g.util}%</span></div>${bar(g.util)}</div>
    <div class="um"><div class="umt"><span>VRAM · ${fmtMB(g.usedMB)} / ${fmtMB(g.totalMB)} (여유 ${fmtMB(freeMB)})</span><span class="up ${level(memPct)}">${memPct}%</span></div>
      ${g.leasedMB > 0
        ? `<span class="ubar gstack">${seg(Math.min(g.leasedMB, g.usedMB), 'lease')}${seg(ext, 'ext')}</span>
           <div class="ums"><span class="lg lease"></span>대기열 예약 ${fmtMB(g.leasedMB)} · <span class="lg ext"></span>기타 ${fmtMB(ext)}</div>`
        : bar(memPct)}</div>
    <div>
      ${Number.isFinite(g.tempC) ? `<div class="drw-kv"><span>온도</span><b>${g.tempC}°C${g.hot ? ' (과열 — 배정 보류)' : ''}</b></div>` : ''}
      ${g.powerW != null ? `<div class="drw-kv"><span>소비 전력</span><b>${g.powerW}W${g.powerLimitW ? ` / ${g.powerLimitW}W` : ''}</b></div>` : ''}
      ${clkInfo ? `<div class="drw-kv"><span>클럭 상태</span><b>${esc(clkInfo)}</b></div>` : ''}
    </div>
    <div class="drw-sec">
      <div class="drw-lbl">활성 GPU 프로세스 (${procList.length})</div>
      ${procList.length ? procList.map((p) => `<div class="drw-kv"><span>${esc(p.name)}</span><b>${p.sm ? `${p.sm}%` : p.memMB ? fmtMB(p.memMB) : '실행 중'}</b></div>`).join('') : '<div class="empty" style="padding:0">활성 프로세스 없음</div>'}
    </div>`;
  openDrawer({ title: `${g.server ? g.server + ' · ' : ''}GPU ${g.index} · ${g.name}`, bodyHTML: body, footerHTML: '<button data-drw-close>닫기</button>', width: 460 });
}

function viewGpu() {
  setBar('');
  $('#view').onclick = async (e) => {
    const sysTab = e.target.closest('[data-systab]');
    if (sysTab) return select({ kind: sysTab.dataset.systab });
    if (e.target.closest('#btnGpuHelp')) return openGpuHelpDrawer();
    const gr = e.target.closest('#btnGpuRefresh');
    if (gr) {
      gr.disabled = true;
      await refreshGpu();
      if (gr.isConnected) gr.disabled = false;
      toast('GPU 대기열 및 장치 상태를 갱신했습니다');
      return;
    }
    const tabBtn = e.target.closest('[data-gtab]');
    if (tabBtn) { state.gpuTab = tabBtn.dataset.gtab; return paintGpu(); }
    const tg = e.target.closest('[data-gtoggle]');
    if (tg) {
      e.stopPropagation();
      const on = tg.dataset.on !== '1';
      const offMsg = isEnUI()
        ? `Turn ${tg.dataset.gtoggle} OFF? No new jobs will be assigned; running jobs will continue.`
        : `${tg.dataset.gtoggle}을(를) OFF로 바꿀까요? 새 작업을 배정하지 않습니다. 이미 실행 중인 작업은 그대로 계속됩니다.`;
      if (!on && !confirm(offMsg)) return;
      await api('/api/gpu/toggle', { method: 'POST', body: { key: tg.dataset.gtoggle, enabled: on } });
      toast(`${tg.dataset.gtoggle} → ${on ? 'ON (사용 가능)' : 'OFF (배정 중지)'}`);
      return refreshGpu();
    }
    const b = e.target.closest('[data-gact]');
    if (b) {
      e.stopPropagation();
      const { gact, id } = b.dataset;
      if (gact === 'est') {
        return openEstimateDialog({
          title: '예상 시간 설정',
          onSubmit: async (v) => {
            const r = await api('/api/gpu/est', { method: 'POST', body: /^\d{1,2}:\d{2}$/.test(v) ? { id, until: v } : { id, est: v } });
            toast(r.ok ? `예상 ${r.estMin}분으로 설정` : r.error, 4000, r.ok ? 'default' : 'danger');
            refreshGpu();
          },
        });
      }
      if (gact === 'release' && !confirm('대기열에서 빼시겠어요? 실행 중인 프로세스는 종료되지 않습니다. 자동 등록된 작업은 다시 등록되지 않습니다.')) return;
      await api(gact === 'top' ? '/api/gpu/priority' : '/api/gpu/release', { method: 'POST', body: { id, byUser: true } });
      return refreshGpu();
    }
    const jRow = e.target.closest('[data-gjob]');
    if (jRow) {
      const q = state.gpu || {};
      const id = jRow.dataset.gjob;
      const act = (q.active || []).find((x) => String(x.id) === id);
      if (act) return openGpuJobDrawer(act, false);
      const wait = (q.waiting || []).find((x) => String(x.id) === id);
      if (wait) return openGpuJobDrawer(wait, true);
    }
    const dCard = e.target.closest('[data-gdev]');
    if (dCard) {
      const g = (state.gpu?.gpus || []).find((x) => String(x.key || x.index) === dCard.dataset.gdev);
      if (g) openGpuDeviceDrawer(g);
    }
  };
  paintGpu();
}
function paintGpu() {
  const q = state.gpu;
  const sysTop = systemTopHTML('gpu', `<button class="ghost btn-sm" id="btnGpuHelp">${ICO.help} CLI 사용법</button><button class="btn-sm" id="btnGpuRefresh" title="GPU 대기열 및 장치 상태 지금 갱신">${ICO.refresh} 새로고침</button>`);
  if (!q) { $('#view').innerHTML = `<div class="sys-shell">${sysTop}<div class="sys-body"><div class="page-wrap"><div class="empty">불러오는 중…</div></div></div></div>`; return; }
  const tab = state.gpuTab || 'queue';
  const mins = (ms) => { const m = Math.round(ms / 60000); return m >= 60 ? `${Math.floor(m / 60)}시간 ${m % 60}분` : `${m}분`; };
  const sw = (key, on) => `<button class="sw ${on ? 'on' : ''}" data-gtoggle="${esc(key)}" data-on="${on ? 1 : 0}" title="사용 가능 여부"><i></i>${on ? 'ON' : 'OFF'}</button>`;

  const ram = q.ram?.totalMB ? q.ram : null;
  const ramUsed = ram ? Math.max(0, ram.totalMB - ram.freeMB) : 0;
  const ramPct = ram ? Math.round((ramUsed / ram.totalMB) * 100) : 0;
  const cpuUtil = q.cpu?.util ?? 0;
  const active = q.active || [], waiting = q.waiting || [], history = q.history || [];
  const validGpus = (q.gpus || []).filter((g) => g.index >= 0);

  const tabs = `<div class="tablist" role="tablist" aria-label="GPU 대기열 보기">
    <button role="tab" data-gtab="queue" aria-selected="${tab === 'queue'}" class="${tab === 'queue' ? 'on' : ''}">작업 대기열 <span class="badge" style="margin-left:4px">${active.length + waiting.length}</span></button>
    <button role="tab" data-gtab="devices" aria-selected="${tab === 'devices'}" class="${tab === 'devices' ? 'on' : ''}">GPU · 서버 장치 <span class="badge" style="margin-left:4px">${validGpus.length + (q.servers?.length || 0)}</span></button>
    <button role="tab" data-gtab="history" aria-selected="${tab === 'history'}" class="${tab === 'history' ? 'on' : ''}">최근 기록 <span class="badge" style="margin-left:4px">${history.length}</span></button>
  </div>`;

  let content = '';
  if (tab === 'queue') {
    const qRow = (t, isWaiting) => `<div class="m-row" data-gjob="${esc(t.id)}">
      <span class="dot ${isWaiting ? 'busy' : 'idle'}"></span>
      <div class="m-row-main">
        <div class="m-row-t">${esc(t.label || t.id)}</div>
        <div class="m-row-s">${esc(isWaiting && t.lanes?.length ? t.lanes.join(' · ') : t.gpu || 'GPU')} · ${t.exclusive ? '전용' : t.memMB == null ? '메모리 미측정' : fmtMB(t.memMB)} · ${isWaiting ? `대기 ${mins(t.waitedMs)}` : `사용 ${mins(Date.now() - t.grantedAt)}`}</div>
      </div>
      <div class="m-row-end">
        <button class="ghost icon-btn btn-sm" data-gact="est" data-id="${esc(t.id)}" aria-label="예상 시간 설정" title="예상 시간 설정">${ICO.clock}</button>
        <button class="danger ghost btn-sm" data-gact="release" data-id="${esc(t.id)}">${t.adopted ? '등록 해제' : isWaiting ? '취소' : '해제'}</button>
      </div>
    </div>`;
    content = `<h1 class="sr-only">GPU 대기열</h1>
      <section class="sheet">
        <div class="sheet-hd"><h2>사용 중 <span class="badge c">${active.length}</span></h2><span class="ums" style="margin:0">항목 클릭 시 상세 정보</span></div>
        ${active.map((t) => qRow(t, false)).join('') || '<div class="empty" style="padding:20px 16px">현재 GPU를 사용 중인 작업이 없습니다.</div>'}
      </section>
      <section class="sheet">
        <div class="sheet-hd"><h2>대기 중 <span class="badge">${waiting.length}</span></h2></div>
        ${waiting.map((t) => qRow(t, true)).join('') || '<div class="empty" style="padding:20px 16px">대기 중인 작업이 없습니다.</div>'}
      </section>`;
  } else if (tab === 'devices') {
    const cpuCard = q.cpu ? `<div class="ucard compact">
      <div class="uh">${ICO.gpu}<b>CPU</b><span class="up ${level(cpuUtil)}" style="width:auto;font-size:14px;font-weight:700">${cpuUtil}%</span></div>
      ${bar(cpuUtil)}
      <div class="ums">${esc(q.cpu.model || '로컬 프로세서')}</div>
    </div>` : '';
    const ramCard = ram ? `<div class="ucard compact">
      <div class="uh">${ICO.gpu}<b>RAM</b><span class="up ${level(ramPct)}" style="width:auto;font-size:14px;font-weight:700">${ramPct}%</span></div>
      ${bar(ramPct)}
      <div class="ums">${fmtMB(ramUsed)} / ${fmtMB(ram.totalMB)} (여유 ${fmtMB(ram.freeMB)})</div>
    </div>` : '';
    const cards = validGpus.map((g) => {
      const memPct = g.totalMB ? Math.round((g.usedMB / g.totalMB) * 100) : 0;
      return `<div class="ucard click" data-gdev="${esc(g.key || g.index)}">
        <div class="uh">${ICO.gpu}<b>${esc(g.server ? g.server + ' · ' : '')}GPU ${g.index} · ${esc(g.name.replace(/NVIDIA |GeForce /gi, ''))}</b>${g.host === 'local' ? sw(g.key, g.enabled !== false) : ''}</div>
        ${g.error ? `<div class="err" style="padding:0">${esc(g.error)}</div>` : `
        <div style="display:flex;flex-direction:column;gap:8px">
          <div><div class="umt"><span>코어</span><span class="up ${level(g.util)}">${g.util}%</span></div>${bar(g.util)}</div>
          <div><div class="umt"><span>VRAM (${fmtMB(g.usedMB)}/${fmtMB(g.totalMB)})</span><span class="up ${level(memPct)}">${memPct}%</span></div>${bar(memPct)}</div>
        </div>
        <div class="ucard-foot"><span>${Number.isFinite(g.tempC) ? `${g.tempC}°C${g.hot ? ' · 과열' : ''}` : '상세 보기'}</span><span class="ico">${ICO.chevRight}</span></div>`}
      </div>`;
    }).join('');
    const servers = (q.servers || []).map((v) => `<div class="m-row" style="cursor:default">
      <span class="dot ${v.reachable == null ? 'dead' : v.reachable ? 'idle' : 'busy'}"></span>
      <div class="m-row-main"><div class="m-row-t">${esc(v.name)} <span class="badge">${esc(v.id)}</span></div><div class="m-row-s">${v.reachable == null ? '확인 중' : v.reachable ? '연결됨' : '연결 안 됨'}</div></div>
      ${sw(v.id, v.enabled)}
    </div>`).join('');
    content = `<h1 class="sr-only">GPU · 서버 장치</h1>${(cpuCard || ramCard) ? `<div class="ugrid-sys">${cpuCard}${ramCard}</div>` : ''}
      <div class="ugrid">${cards || `<div class="err">${esc(q.error || 'GPU를 찾지 못함 (nvidia-smi)')}</div>`}</div>
      ${servers ? `<section class="sheet"><div class="sheet-hd"><h2>원격 GPU 서버</h2></div>${servers}</section>` : ''}`;
  } else {
    const histRows = history.map((t) => `<div class="m-row" style="cursor:default">
      <span class="dot ${t.status === 'released' ? 'idle' : 'dead'}"></span>
      <div class="m-row-main"><div class="m-row-t">${esc(t.label || t.id)}</div><div class="m-row-s">${t.status === 'released' ? '해제됨' : '취소됨'}${t.endReason ? ` · ${esc(t.endReason)}` : ''}</div></div>
      <span class="ums" style="margin:0">${esc(new Date(t.endedAt).toLocaleTimeString(uiLocale()))}</span>
    </div>`).join('');
    content = `<h1 class="sr-only">GPU 최근 기록</h1><section class="sheet"><div class="sheet-hd"><h2>최근 작업 기록</h2></div>${histRows || '<div class="empty" style="padding:20px 16px">최근 기록이 없습니다.</div>'}</section>`;
  }
  $('#view').innerHTML = `<div class="sys-shell">${sysTop}<div class="sys-body"><div class="page-wrap">${tabs}${content}</div></div></div>`;
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

// Tiny markdown renderer (escapes everything first; supports http/https and file:// artifact chips).
function md(src) {
  const lines = String(src || '').replace(/\r/g, '').split('\n');
  const inline = (t) => esc(t)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\[([^\]]+)\]\(file:\/\/\/?([^)#\s]+)(?:#[^)\s]*)?\)/gi, (_, lbl, rawPath) => {
      const cleanPath = rawPath.replace(/\//g, '\\');
      return `<a class="filechip artlink" data-apath="${cleanPath}" title="${cleanPath}">${lbl}</a>`;
    })
    .replace(/\[([^\]]+)\]\(conversation:\/\/[^)\s]+\)/gi, '<span class="filechip">$1</span>');
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

let rCache = { slug: null, json: '', data: null };
function viewResearch() {
  const slug = state.sel.id;
  state.rtab = state.rtab || {};
  rCache = { slug, json: '', data: null };
  $('#bar').onclick = async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.ract === 'more') {
      e.stopPropagation();
      return openMoreMenu(b, [
        !IS_REMOTE ? { label: '탐색기에서 폴더 열기', icon: ICO.folder, onClick: () => researchAction(slug, 'folder') } : null,
        { label: '파생 연구 만들기', icon: ICO.plus, onClick: () => researchAction(slug, 'derive') },
      ]);
    }
    if (b.dataset.ract) return researchAction(slug, b.dataset.ract);
  };
  $('#view').onclick = async (e) => {
    const t = e.target.closest('[data-rtab]');
    if (t) { state.rtab[slug] = t.dataset.rtab; rCache.json = ''; return paintResearch(); }
    const asub = e.target.closest('[data-ract-sub]');
    if (asub) { state.rActSub = asub.dataset.ractSub; rCache.json = ''; return paintResearch(); }
    const rcopy = e.target.closest('[data-rcopy]');
    if (rcopy) {
      const k = rcopy.dataset.rcopy;
      if (rCache.data) copyText(k === 'report' ? [rCache.data.final, rCache.data.report].filter(Boolean).join('\n\n---\n\n') : rCache.data.plan || '');
      return;
    }
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

  const [label, tone] = R_STATUS[d.status] || [d.status, 'muted'];
  const running = !['paused', 'blocked', 'done'].includes(d.status);
  setBar(`<h2>${ICO.flask} ${esc(d.name)}</h2><span class="pill ${tone}">${esc(label)}</span>
    <button class="btn-sm" data-ract="open">디렉터 화면</button>
    ${running ? '<button class="btn-sm" data-ract="pause">일시정지</button>' : `<button data-ract="resume" class="btn-sm${d.status === 'blocked' ? '' : ' primary'}">${d.status === 'done' ? '다시 진행' : '재개'}</button>`}
    <button class="ghost icon-btn btn-sm" data-ract="more" aria-label="연구 메뉴" aria-haspopup="menu" aria-expanded="false">${ICO.more}</button>`);

  const prog = goalProgress(d);
  const msgVal = $('#rMsg')?.value || '';
  const tabs = `<div class="tablist" role="tablist" aria-label="연구 보기" style="padding:0 var(--page-pad);background:var(--panel)">${R_TABS.map(([k, t]) => `<button role="tab" data-rtab="${k}" aria-selected="${k === tab}" class="${k === tab ? 'on' : ''}">${t}</button>`).join('')}</div>`;
  let body = '';

  if (tab === 'overview') {
    const rv = d.review;
    const benchHtml = rv?.bench
      ? (isEnUI() ? `<b>Worst #${rv.bench.worst}</b>/${rv.bench.of} papers (target ≤ #${rv.maxRank})` : `<b>최저 ${rv.bench.worst}위</b>/${rv.bench.of}편 (기준 ${rv.maxRank}위 이내)`)
      : '아직 없음';
    const reviewCard = rv ? `<div class="rban ${rv.passed ? 'ok' : 'warn'}"><div><b>리뷰 루프 ${rv.rounds}/${rv.max}라운드</b> · 최근 판정 <b>${esc(rv.recommendation || '없음')}</b> (기준 ${esc(rv.min)} 이상)
        · 채택 논문 비교 ${benchHtml}</div>
        ${rv.passed ? '<div>종료 기준 충족</div>' : `<div class="empty" style="padding:0">남은 조건: ${esc(rv.reasons.join(' · '))}</div>`}
        ${rv.stalled ? '<div>최근 라운드에서 판정이 나아지지 않아 실험 보강(P7)으로 돌아가도록 안내 중</div>' : ''}</div>` : '';
    const banner = d.status === 'blocked'
      ? `<div class="rban bad"><b>확인이 필요합니다</b><div>${esc(d.blocked_reason || '')}</div>${d.questions?.split('\n').length > 2 ? md(d.questions) : ''}<div class="row"><button class="primary" data-ract="resume">해결했어요 · 재개</button><span class="empty">또는 하단 입력창으로 지시</span></div></div>`
      : d.status === 'done'
        ? `<div class="rban ok"><b>목표(${esc(GOAL_KO[prog.goal])})에 도달했습니다</b> ${resultBadge(d)}${d.result_summary ? ` <span class="empty">${esc(d.result_summary)}</span>` : ''}
            <div class="row" style="margin:6px 0">${prog.goal !== 'P10_submission' ? '<button class="primary" data-ract="submit" title="이 연구를 이어서 투고 패키지까지 준비 (제출은 직접)">투고 준비 진행</button>' : '<span class="empty">투고 패키지: 산출물 탭 → research/submission · 제출은 직접 하세요</span>'}
              <button data-ract="derive">파생 연구 만들기</button>
              <button data-rsyn="1">종합 논문에 포함</button></div>
            ${d.final ? md(d.final) : '<div>산출물 탭에서 결과를 확인하세요.</div>'}</div>`
        : d.status === 'waiting'
          ? `<div class="rban warn"><b>기다리는 중</b> — ${esc(d.wait_reason || '')}${d.wake_at ? (isEnUI() ? ` · Auto-resume at <b>${esc(new Date(d.wake_at).toLocaleString(uiLocale()))}</b>` : ` · <b>${esc(new Date(d.wake_at).toLocaleString(uiLocale()))}</b>에 자동 재개`) : ''}<div class="row"><button data-ract="resume">지금 깨우기</button></div></div>`
          : d.status === 'paused' ? `<div class="rban muted"><b>일시정지됨</b> — 상단 재개를 누르면 이어서 진행합니다.</div>` : '';
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
        <div class="rnow" style="border-top:1px solid var(--line);padding-top:8px"><span class="empty">다음 작업</span> <b>${esc(d.next_action || '-')}</b></div>
        ${d.lineage ? `<div><span class="empty">${d.lineage.kind === 'derived' ? '기반 연구' : '종합 대상'}</span> ${d.lineage.parents.map((x) => `<button class="linkbtn" data-rgo="${esc(x.slug)}">${esc(x.name || x.slug)}</button>`).join(' · ')}</div>` : ''}
        ${d.children?.length ? `<div><span class="empty">이어진 연구</span> ${d.children.map((c) => `<button class="linkbtn" data-rgo="${esc(c)}">${esc((state.research.find((x) => x.slug === c) || {}).name || c)}</button>`).join(' · ')}</div>` : ''}
        <div class="empty" style="padding:0">디렉터 ${d.director ? `<span class="dot ${d.director.busy ? 'busy' : 'idle'}" style="display:inline-block;width:7px;height:7px;margin:0 4px 0 0;vertical-align:middle"></span>` + (d.director.busy ? '작업 중' : '대기') + ` · ${d.director.term ? 't:' + d.director.term : 'c:' + d.director.console}` : '<span class="dot dead" style="display:inline-block;width:7px;height:7px;margin:0 4px 0 0;vertical-align:middle"></span>실행 중 아님 (워치독이 자동 재개)'} · 시작 ${esc(d.created_at ? new Date(d.created_at).toLocaleDateString(uiLocale()) : '-')} · 갱신 ${d.updated_at ? relTime(Date.parse(d.updated_at)) : '-'}</div>
        ${d.workers?.length ? `<div><span class="empty">워커</span> ${d.workers.map((w) => `<span class="badge">${esc(w.id)} ${esc(w.status || '')}</span>`).join(' ')}</div>` : ''}
        ${myGpu.length ? `<div><span class="empty">GPU</span> ${myGpu.map((t) => `<span class="badge c">${esc(t.label || t.id)}</span>`).join(' ')}</div>` : ''}
      </div>
      <section class="list-sec">
        <div class="list-sec-hd"><h4>최근 활동</h4><button data-rtab="activity" class="ghost btn-sm">전체 기록 →</button></div>
        <div class="tl">${items.map((x) => `<div class="tli"><span class="tlt">${relTime(x.ts)}</span><span>${esc(x.text)}</span></div>`).join('') || '<div class="empty">아직 기록 없음</div>'}</div>
      </section>`;
  } else if (tab === 'report') {
    body = `<div class="r-doc"><div class="row" style="justify-content:flex-end;margin-bottom:8px"><button class="ghost btn-sm" data-rcopy="report">${ICO.copy} 마크다운 복사</button></div><div class="rcard">${d.final ? md(d.final) + '<hr>' : ''}${md(d.report)}</div></div>`;
  } else if (tab === 'plan') {
    body = `<div class="r-doc"><div class="row" style="justify-content:flex-end;margin-bottom:8px"><button class="ghost btn-sm" data-rcopy="plan">${ICO.copy} 마크다운 복사</button></div><div class="rcard">${md(d.plan)}</div></div>`;
  } else if (tab === 'activity') {
    const sub = state.rActSub || 'timeline';
    const items = journalItems(d.journal).reverse();
    const sbtn = (k, lbl) => `<button data-ract-sub="${k}" class="${sub === k ? 'on' : ''}">${lbl}</button>`;
    const subContent = sub === 'timeline'
      ? `<div class="tl">${items.map((x) => `<div class="tli"><span class="tlt" title="${esc(new Date(x.ts).toLocaleString(uiLocale()))}">${esc(new Date(x.ts).toLocaleString(uiLocale(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }))}</span><span>${esc(x.text)}</span></div>`).join('') || '<div class="empty">없음</div>'}</div>`
      : sub === 'decisions' ? `<div class="rcard r-doc">${md(d.decisions)}</div>`
        : sub === 'failed' ? `<div class="rcard r-doc">${md(d.failed)}</div>`
          : `<pre class="mdpre">${esc(d.harnessLog || '(로그 없음)')}</pre>`;
    body = `<div class="row" style="margin-bottom:6px"><div class="seg" role="tablist">${sbtn('timeline', '타임라인')}${sbtn('decisions', '결정')}${sbtn('failed', '실패 기록')}${sbtn('log', '하네스 로그')}</div></div>${subContent}`;
  } else if (tab === 'outputs') {
    const outs = d.outputs || [];
    const INTERNAL = /^(CLAUDE|JOURNAL|INBOX|DECISIONS|FAILED|QUESTIONS|MEMORY|README|BRIEF|STATE)\.md$/i;
    const isMain = (f) => ['video', 'audio', 'pdf', 'image', 'html'].includes(f.kind) || /^(docx|xlsx|pptx|ply|glb|obj)$/.test(f.ext)
      || (f.kind === 'markdown' && !INTERNAL.test(f.name)) || /(^|\/)main\.tex$/i.test(f.path);
    const main = outs.map((f, i) => [f, i]).filter(([f]) => isMain(f));
    const card = ([f, i]) => `<div class="acard" data-rout="${i}">
        <div class="athumb">${f.kind === 'image' ? `<img loading="lazy" src="${rRawUrl(slug, f.path)}" alt="">` : `<span>${ART_ICON[f.kind] || ART_ICON.file}</span>`}</div>
        <div class="ameta"><b title="${esc(f.path)}">${esc(f.name)}</b>
          <span class="ums">${esc(f.path.split('/').slice(0, -1).join('/') || '(루트)')} · ${fmtSize(f.size)} · ${relTime(f.mtime)}</span></div><button class="asend" data-rsend="${i}" aria-label="세션에 보내기" title="이 파일을 세션에 보내기 (경로 멘션)">↗</button></div>`;
    const head = `<div class="row" style="padding:2px 2px 8px">
      <div class="seg" role="tablist">
        <button data-rout-mode="main" class="${!state.rOutAll ? 'on' : ''}">주요 산출물 <span class="seg-cnt">${main.length}</span></button>
        <button data-rout-mode="all" class="${state.rOutAll ? 'on' : ''}">폴더별 전체 <span class="seg-cnt">${outs.length}</span></button>
      </div>
      <span class="sp"></span>
      ${state.rOutAll ? '' : artOrderSel()}
    </div>`;
    if (!state.rOutAll) {
      body = head + (main.length ? artTimeline(main, card) : '<div class="empty" style="padding:16px">아직 영상·PDF·그림·문서 산출물이 없습니다. "폴더별 전체"에서 코드·데이터를 볼 수 있습니다.</div>');
    } else {
      const groups = {};
      outs.forEach((f, i) => {
        const segs = f.path.split('/').slice(0, -1);
        const g = segs.length ? segs.slice(0, 2).join('/') : '(루트)';
        (groups[g] = groups[g] || []).push([f, i]);
      });
      body = head + (Object.entries(groups).map(([g, fs]) => `<section class="list-sec"><div class="list-sec-hd"><h4>${esc(g)}</h4><span class="badge">${fs.length}</span></div>${fs.map(([f, i]) => `<div class="ofile" data-rout="${i}"><span>${ART_ICON[f.kind] || ART_ICON.file} ${esc(f.path.slice(g === '(루트)' ? 0 : g.length + 1))}</span><span class="empty">${fmtSize(f.size)} · ${relTime(f.mtime)}</span></div>`).join('')}</section>`).join('') || '<div class="empty" style="padding:16px">아직 산출물이 없습니다.</div>');
    }
  } else if (tab === 'settings') {
    body = `<section class="list-sec r-doc">
        <div class="list-sec-hd"><h4>연구 설정</h4></div>
        <div class="list-row"><div class="list-row-main"><b>목표 지점</b><div class="ums">이 단계의 게이트를 통과하면 디렉터가 스스로 마무리합니다.</div></div>
          <div class="list-row-acts"><select id="rGoal">${Object.entries(GOAL_KO).map(([k, v]) => `<option value="${k}" ${k === prog.goal ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select><button class="primary btn-sm" id="rGoalSave">저장</button></div></div>
        <div class="list-row"><div class="list-row-main"><b>목표 학회·저널</b><div class="ums">${esc(d.config?.venue_hint || '(디렉터가 조사해 결정)')}${d.config?.deadline ? ` · 마감 ${esc(d.config.deadline)}` : ''}</div></div></div>
        <div class="list-row"><div class="list-row-main"><b>폴더 경로</b><div class="ums mono">${esc(d.dir)}</div></div><button class="ghost btn-sm" id="rCopyDir">${ICO.copy} 복사</button></div>
      </section>
      <div class="rcard r-doc"><b>연구 브리프 (처음 주신 방향)</b>${md(d.brief)}</div>
      <details class="rsec r-doc"><summary>보낸 메시지 (INBOX.md)</summary><div class="rsecb">${md(d.inbox)}</div></details>`;
  }
  const hadFocus = document.activeElement?.id === 'rMsg';
  const caret = hadFocus ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
  const scrollers = [...$('#view').querySelectorAll('*'), $('#view')].filter((el) => el.scrollTop > 0).map((el) => [el.className, el.scrollTop]);
  const footer = tab === 'overview'
    ? `<div class="r-footer"><input id="rMsg" style="flex:1;min-width:160px" placeholder="디렉터에게 지시·방향 수정 보내기 (작업 중이면 다음 턴에 반영)"><button class="${d.status === 'blocked' ? '' : 'primary'}" data-ract="send">보내기</button></div>`
    : '';
  $('#view').innerHTML = `<div class="r-shell">${tabs}<div class="r-body"><div class="rwrap">${body}</div></div>${footer}</div>`;
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
    $('#view').querySelectorAll('[data-rout-mode]').forEach((b) => (b.onclick = () => { state.rOutAll = b.dataset.routMode === 'all'; rCache.json = ''; paintResearch(); }));
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
  const cd = $('#rCopyDir');
  if (cd) cd.onclick = () => copyText(d.dir);
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
  setBar(`<h2 style="flex:none">${ICO.search} 전체 검색</h2><input id="sq" class="btn-sm" type="search" value="${esc(S.q)}" style="flex:1;min-width:180px;max-width:520px" placeholder="검색어 (공백 = AND)"><button class="primary btn-sm" id="sGo">검색</button>`);
  const filterBar = `<div class="subtoolbar">
    <div class="filters">
      <select id="sRole" class="btn-sm" aria-label="화자 필터"><option value="all">전체</option><option value="user">내 입력</option><option value="assistant">에이전트 답변·명령</option></select>
      <input id="sCwd" class="btn-sm" placeholder="폴더 포함 (예: myproject)" value="${esc(S.cwd)}" style="width:170px">
      <label><input type="checkbox" id="sScreens" ${S.screens ? 'checked' : ''}> 열린 창 화면</label>
      <label><input type="checkbox" id="sAuto" ${S.auto ? 'checked' : ''}> 자동 실행(sdk)</label>
    </div>
  </div>`;
  $('#view').innerHTML = `${filterBar}<div id="searchBody" class="results">${S.q ? '검색 중…' : '<div class="empty" style="padding:12px 0">검색어를 입력하세요.</div>'}</div>`;
  $('#sRole').value = S.role;
  const go = () => {
    Object.assign(S, { q: $('#sq').value.trim(), role: $('#sRole').value, cwd: $('#sCwd').value.trim(), screens: $('#sScreens').checked, auto: $('#sAuto').checked });
    select({ kind: 'search' });
  };
  $('#sGo').onclick = go;
  $('#sq').onkeydown = $('#sCwd').onkeydown = (e) => { if (e.key === 'Enter' && !e.isComposing) go(); };
  $('#sRole').onchange = $('#sScreens').onchange = $('#sAuto').onchange = go;
  $('#bar').onclick = null;
  if (!S.q) { setTimeout(() => $('#sq')?.focus(), 0); return; }

  const params = new URLSearchParams({ q: S.q, role: S.role, cwd: S.cwd, auto: S.auto ? '1' : '0', screens: S.screens ? '1' : '0' });
  api('/api/search?' + params).then((d) => {
    if (gen !== viewGen) return;
    S.sessions = d.sessions;
    const terms = termsOf(S.q);
    const nHits = d.sessions.reduce((a, r) => a + r.total, 0);
    let h = `<div class="empty" style="padding:0 0 6px">세션 ${d.sessions.length}개 · 메시지 ${nHits}건 · 창 ${d.screens.length}개 · ${d.ms}ms</div>`;
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
        <div class="rh" data-sid="${r.sessionId}" data-at="-1"><span class="dot ${live ? 'idle' : 'dead'}" style="margin-top:0"></span>
        <span class="t">${hl(sessionLabel(r), terms)}</span>
          ${r.idMatch ? '<span class="badge lim">세션 ID 일치</span>' : ''}${branchTagHTML(r.branch)}${r.auto ? '<span class="badge">sdk</span>' : ''}${agentBadge(r.agent)}
          <span class="ums" style="margin:0">${esc([base(r.cwd), ago(r.mtime)].filter(Boolean).join(' · '))}</span>
          <span class="badge c">${r.idMatch ? `메시지 ${r.total}개` : `${r.total}건`}</span></div>
        ${r.hits.map((x) => `<div class="hit${x.snippet.startsWith('⚙') ? ' mono' : ''}" data-sid="${r.sessionId}" data-at="${x.i}">
          <span class="r">${x.role === 'user' ? '사용자' : r.agent === 'codex' ? 'Codex' : r.agent === 'agy' ? 'Antigravity' : 'Claude'}</span><span class="x">${hl(x.snippet, terms)}</span></div>`).join('')}
        ${!r.idMatch && r.total > r.hits.length ? `<div class="hit" data-sid="${r.sessionId}" data-at="${r.hits[r.hits.length - 1].i}"><span class="r"></span><span class="x" style="color:var(--muted)">… ${r.total - r.hits.length}건 더 (세션 열어서 보기)</span></div>` : ''}
      </div>`;
      }).join('');
    }
    if (!d.sessions.length && !d.screens.length) h += '<div class="empty" style="padding:12px 0">결과 없음</div>';
    const host = $('#searchBody');
    if (host) host.innerHTML = h;
  }).catch((e) => { const host = $('#searchBody'); if (host) host.innerHTML = `<div class="err">${esc(e.message)}</div>`; });

  $('#view').onclick = (e) => {
    const el = e.target.closest('[data-sid],[data-console]');
    if (!el) return;
    if (el.dataset.console) return select({ kind: 'console', id: el.dataset.console, hl: S.q });
    select({ kind: 'recent', id: el.dataset.sid, at: Number(el.dataset.at), q: S.q }, 'chat');
  };
  setTimeout(() => $('#sq')?.focus(), 0);
}

// ---------- Ctrl+K Instant Command Palette ----------
function openCommandPalette() {
  if ($('.cmdk-backdrop')) return;
  const wrap = document.createElement('div');
  wrap.className = 'cmdk-backdrop';
  wrap.innerHTML = `<div class="cmdk-box" role="dialog" aria-label="빠른 이동 및 검색">
    <div class="cmdk-top">${ICO.search}<input id="cmdkIn" type="search" placeholder="터미널 · Project · 최근 대화 · 메뉴로 즉시 이동…" autocomplete="off"><span class="snav-kbd">Esc</span></div>
    <div class="cmdk-list" id="cmdkList"></div>
    <div class="cmdk-foot"><span>↑↓ 이동 · Enter 실행</span><span>전체 대화 검색도 여기서 바로 가능</span></div>
  </div>`;
  document.body.appendChild(wrap);
  const inp = $('#cmdkIn', wrap), listEl = $('#cmdkList', wrap);
  let items = [], idx = 0;
  const close = () => { document.removeEventListener('keydown', onKey, true); wrap.remove(); };

  const buildItems = (raw) => {
    const q = raw.trim();
    const qTerms = termsOf(q);
    const hit = (...xs) => !qTerms.length || qTerms.every((t) => xs.join(' ').toLowerCase().includes(t));
    const out = [];
    const pushGrp = (grp, arr) => {
      if (!arr.length) return;
      out.push({ grp });
      for (const x of arr) out.push(x);
    };

    const termHits = sortTermsByState(state.terms || [])
      .filter((t) => hit(termLabel(t), t.cwd || '', projectOfTerm(t)?.name || '', '터미널'))
      .slice(0, 8)
      .map((t) => {
        const pj = projectOfTerm(t);
        const st = termStateOf(t);
        return {
          icon: agentIcon(t.operator ? 'operator' : t.agent || 'shell', st === 'exited' ? 'dead' : st === 'busy' ? 'busy' : 'idle'),
          title: termLabel(t),
          sub: [pj ? `Project: ${pj.name}` : '', termKindLabel(t), termStatusLabel(t)].filter(Boolean).join(' · '),
          run: () => select({ kind: 'term', id: t.id }),
        };
      });
    pushGrp('열린 터미널', termHits);

    const pjHits = (state.projects || [])
      .filter((p) => hit(p.name, p.cwd || '', 'project', '프로젝트'))
      .slice(0, 8)
      .map((p) => ({
        icon: '<span class="pj-dot" style="margin:0 5px"></span>',
        title: p.name,
        sub: `${(p.tasks || []).filter((x) => x.stage === 'done').length}/${(p.tasks || []).length} 완료 · ${base(p.cwd)}`,
        run: () => (typeof openProject === 'function' ? openProject(p.id) : select({ kind: 'projects', id: p.id })),
      }));
    pushGrp('Project', pjHits);

    const recHits = (state.recent || [])
      .filter((r) => hit(sessionLabel(r), r.cwd || '', r.agent || ''))
      .slice(0, 6)
      .map((r) => ({
        icon: agentIcon(r.agent || 'claude'),
        title: sessionLabel(r),
        sub: [base(r.cwd), ago(r.mtime)].filter(Boolean).join(' · '),
        run: () => select({ kind: 'recent', id: r.sessionId }, 'chat'),
      }));
    pushGrp('최근 대화', recHits);

    const actions = [
      { icon: ICO.plus, title: '새 터미널 열기', sub: 'Claude · Codex · Antigravity · 셸', keys: 'new terminal 새 터미널', run: () => openNewTermDrawer() },
      { icon: ICO.folder, title: '새 Project 만들기', sub: '목표 · 작업 흐름 설계', keys: 'new project 새 프로젝트', run: () => (typeof projectForm === 'function' ? projectForm() : select({ kind: 'projects' })) },
      { icon: ICO.chart, title: 'AI 사용량', sub: '설정', keys: 'usage ai 사용량 한도 설정 settings', run: () => select({ kind: 'usage' }) },
      { icon: ICO.gpu, title: 'GPU 대기열', sub: '설정', keys: 'gpu vram 대기열 설정 settings', run: () => select({ kind: 'gpu' }) },
      { icon: ICO.calendar, title: '캘린더', sub: '일정 · 할 일', keys: 'calendar 캘린더 일정', run: () => select({ kind: 'calendar' }) },
      { icon: ICO.layers, title: '공통 자원', sub: '설정 · 스킬/MCP/하네스', keys: 'vault shared resources skills mcp harness 공통 자원 통합 볼트 스킬 하네스 설정 settings', run: () => select({ kind: 'vault' }) },
      { icon: ICO.sun, title: '테마 전환 (시스템 · 라이트 · 다크)', sub: '화면 밝기 변경', keys: 'theme dark light 테마 다크 라이트', run: () => cycleTheme() },
    ].filter((a) => hit(a.title, a.sub, a.keys));
    pushGrp('빠른 이동 · 작업', actions);

    if (q) {
      out.push({ grp: '전체 본문 검색' });
      out.push({ icon: ICO.search, title: `“${q}” 모든 대화 기록 · 화면에서 검색`, sub: 'Enter로 전체 검색 페이지 열기', run: () => runSearch(q) });
    }
    return out;
  };

  const render = () => {
    const rawList = buildItems(inp.value);
    items = rawList.filter((x) => !x.grp);
    if (idx >= items.length) idx = Math.max(0, items.length - 1);
    let actI = 0;
    listEl.innerHTML = rawList.map((x) => {
      if (x.grp) return `<div class="cmdk-grp">${esc(x.grp)}</div>`;
      const myI = actI++;
      return `<button type="button" class="cmdk-item${myI === idx ? ' on' : ''}" data-ci="${myI}">${x.icon || ''}<span class="cmdk-item-main"><span class="cmdk-item-t">${esc(x.title)}</span>${x.sub ? `<span class="cmdk-item-s">${esc(x.sub)}</span>` : ''}</span></button>`;
    }).join('') || '<div class="empty" style="padding:18px;text-align:center">일치하는 항목이 없습니다</div>';
    listEl.querySelector('.cmdk-item.on')?.scrollIntoView({ block: 'nearest' });
  };

  const runIdx = (i) => { const it = items[i]; if (!it) return; close(); it.run(); };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); if (items.length) { idx = (idx + 1) % items.length; render(); } return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); if (items.length) { idx = (idx - 1 + items.length) % items.length; render(); } return; }
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); runIdx(idx); }
  };
  document.addEventListener('keydown', onKey, true);
  wrap.onclick = (e) => {
    if (e.target === wrap) return close();
    const b = e.target.closest('[data-ci]');
    if (b) runIdx(Number(b.dataset.ci));
  };
  inp.oninput = () => { idx = 0; render(); };
  render();
  inp.focus();
}

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && !xterm) {
    e.preventDefault();
    openCommandPalette();
  }
});

// calendar counts in the TopNav (todo.md changes come from other sessions too)
loadCalendar();
setInterval(whenShown(loadCalendar), 60000);

// polling only while the page is visible (another tab / phone app in the background → no load)
function whenShown(fn) { return () => { if (!document.hidden) fn(); }; }
document.addEventListener('visibilitychange', () => { if (!document.hidden) { refreshOverview(); refreshGpu(); refreshResearch(); } });

// ---------- new terminal drawer ----------
function openNewTermDrawer(projectCwd = '', onCreated = null, initialKind = null) {
  let savedKind = 'claude';
  try { savedKind = localStorage.getItem('ach.lastNewTermKind') || 'claude'; } catch {}
  const resolvedKind = initialKind || savedKind || 'claude';
  const cwds = [...new Set([...state.live.map((s) => s.cwd), ...state.recent.map((r) => r.cwd)].filter(Boolean))].slice(0, 15);
  const chk = (v) => (resolvedKind === v ? 'checked' : '');
  const body = `
    <div class="row"><label><input type="radio" name="k" value="claude" ${chk('claude')}> claude</label>
      <label title="ChatGPT 계정(Codex 앱 로그인)으로 GPT 대화형 세션"><input type="radio" name="k" value="codex" ${chk('codex')}> GPT (Codex)</label>
      <label title="Cursor 터미널 에이전트 (cursor-agent, 처음 한 번 cursor-agent login 필요)"><input type="radio" name="k" value="cursor" ${chk('cursor')}> Cursor</label>
      <label title="Antigravity CLI (agy)"><input type="radio" name="k" value="agy" ${chk('agy')}> agy (Antigravity)</label>
      <label><input type="radio" name="k" value="powershell" ${chk('powershell')}> PowerShell</label>
      <label><input type="radio" name="k" value="cmd" ${chk('cmd')}> cmd</label>
      ${state.researchEnabled ? `<label><input type="radio" name="k" value="research" ${chk('research')}> 연구 디렉터 (자율)</label>` : ''}</div>
    <div id="nTerm" style="display:flex;flex-direction:column;gap:10px">
      <label>작업 폴더<br>
        <div class="fp-input-row">
          <input id="nCwd" list="cwdl" style="width:100%" value="${esc(projectCwd || cwds[0] || '')}" placeholder="비우면 홈 폴더">
          <button type="button" class="btn-sm" id="nPickDir" title="호스트 컴퓨터 경로 탐색기 열기">${ICO.folder || ''} 폴더 선택</button>
        </div>
        <datalist id="cwdl">${cwds.map((c) => `<option value="${esc(c)}">`).join('')}</datalist></label>
      <div id="nMeHost" style="display:flex;flex-direction:column;gap:8px">${typeof projectModelEffortFields === 'string' ? projectModelEffortFields : ''}</div>
      <label class="row"><input type="checkbox" id="nSkip" checked> YOLO 모드 자동 승인 (Claude · Codex · Antigravity)</label>
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
  const supportsME = (k) => k === 'claude' || k === 'codex' || k === 'agy';
  const nMeCtl = typeof createCliModelEffortController === 'function'
    ? createCliModelEffortController({
      modelPick: d.querySelector('[name=modelPick]'),
      modelIn: d.querySelector('[name=model]'),
      effortSel: d.querySelector('[name=effort]'),
      hintEl: d.querySelector('[data-cli-opt-hint]'),
      initialKind: supportsME(resolvedKind) ? resolvedKind : 'claude',
      useSavedDefaults: true,
      persistDefaults: true,
    })
    : null;
  const syncKindUI = () => {
    const k = kindOf();
    const isRes = k === 'research';
    $('#nTerm', d).style.display = isRes ? 'none' : 'flex';
    $('#nRes', d).style.display = isRes ? 'flex' : 'none';
    const meHost = $('#nMeHost', d);
    if (meHost) meHost.style.display = supportsME(k) ? 'flex' : 'none';
    if (supportsME(k)) nMeCtl?.setCli(k);
    const extBtn = $('#nExt', d);
    if (extBtn) extBtn.style.display = isRes ? 'none' : '';
  };
  d.querySelectorAll('input[name=k]').forEach((r) => (r.onchange = syncKindUI));
  syncKindUI();
  const nPickDir = $('#nPickDir', d);
  if (nPickDir) {
    nPickDir.onclick = () => {
      if (typeof openFolderPickerDialog === 'function') {
        openFolderPickerDialog($('#nCwd', d).value.trim(), (chosen) => { $('#nCwd', d).value = chosen; });
      }
    };
  }
  const launchParams = (kind) => {
    try { localStorage.setItem('ach.lastNewTermKind', kind); } catch {}
    const me = supportsME(kind) && nMeCtl ? nMeCtl.getValues() : { model: '', effort: '' };
    return {
      kind,
      cwd: $('#nCwd', d).value,
      skipPermissions: $('#nSkip', d).checked,
      ...(me.model ? { model: me.model } : {}),
      ...(me.effort ? { effort: me.effort } : {}),
    };
  };
  $('#nExt', d).onclick = async () => {
    const kind = kindOf();
    if (kind === 'research') return;
    $('#nExt', d).disabled = true;
    const r = await api('/api/term/external', { method: 'POST', body: launchParams(kind) });
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
    const t = await api('/api/term/new', { method: 'POST', body: launchParams(kind) });
    if (t.error) return toast(t.error, 6000);
    d.close();
    await refreshOverview();
    if (onCreated) return onCreated(t);
    select({ kind: 'term', id: t.id });
  };
}

// ---------- Sidebar & Global controls ----------
function setSideCollapsed(on) {
  document.body.classList.toggle('side-collapsed', !!on);
  try { localStorage.setItem('ach-side-collapsed', on ? '1' : ''); } catch {}
  setTimeout(() => window.dispatchEvent(new Event('resize')), 200);
}
try { if (localStorage.getItem('ach-side-collapsed') === '1') document.body.classList.add('side-collapsed'); } catch {}

async function toggleLang() {
  const next = (window.__ACH_LANG || (await api('/api/lang').catch(() => ({}))).lang) === 'en' ? 'ko' : 'en';
  if (!confirm(next === 'en' ? 'Switch to English? The hub restarts (terminals stay open).' : '한국어로 바꿀까요? 허브가 다시 시작됩니다 (터미널은 그대로).')) return;
  await api('/api/lang', { method: 'POST', body: { lang: next } }).catch(() => {});
  toast(next === 'en' ? 'Restarting in English…' : '한국어로 다시 시작하는 중…', 8000);
  setTimeout(() => location.reload(), 4000);
}
async function openPhoneDrawer() {
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
}
// ---------- Theme Switcher (System / Light / Dark) ----------
function applyTheme(mode) {
  const m = mode === 'light' || mode === 'dark' ? mode : 'system';
  if (m === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = m;
  try { localStorage.setItem('ach-theme', m); } catch {}
  const btn = $('#btnTheme');
  if (btn) {
    btn.innerHTML = m === 'dark' ? ICO.moon : m === 'light' ? ICO.sun : ICO.monitor;
    const lbl = m === 'dark' ? '다크' : m === 'light' ? '라이트' : '시스템';
    btn.title = `테마: ${lbl} (클릭하여 전환)`;
    btn.setAttribute('aria-label', `테마 전환 (현재: ${lbl})`);
  }
}
function cycleTheme() {
  const cur = (() => { try { return localStorage.getItem('ach-theme') || 'system'; } catch { return 'system'; } })();
  const next = cur === 'system' ? 'light' : cur === 'light' ? 'dark' : 'system';
  applyTheme(next);
  toast(`테마를 ${next === 'dark' ? '다크' : next === 'light' ? '라이트' : '시스템 자동'} 모드로 변경했습니다`, 2200);
}
applyTheme((() => { try { return localStorage.getItem('ach-theme') || 'system'; } catch { return 'system'; } })());

$('#brandHome').onclick = (e) => {
  e.stopPropagation();
  toggleServerStatusPopover(e.currentTarget);
};
$('#mBrandHome').onclick = (e) => {
  e.stopPropagation();
  toggleServerStatusPopover(e.currentTarget);
};
$('#btnSideNew').onclick = () => openNewTermDrawer();
$('#mBtnNew').onclick = () => openNewTermDrawer();
$('#btnSideCollapse').onclick = () => setSideCollapsed(true);
$('#btnSideReopen').onclick = () => setSideCollapsed(false);
$('#btnMenu').onclick = () => document.body.classList.toggle('drawer');
$('#backdrop').onclick = () => document.body.classList.remove('drawer');
$('#btnTheme').onclick = () => cycleTheme();
$('#btnLang').onclick = () => toggleLang();
$('#btnPhone').onclick = () => openPhoneDrawer();
const sideFilterIn = $('#sideFilter');
if (sideFilterIn) {
  sideFilterIn.addEventListener('input', () => { state.sideFilter = sideFilterIn.value; renderSide(); });
  sideFilterIn.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { sideFilterIn.value = ''; state.sideFilter = ''; renderSide(); }
    if (e.key === 'Enter' && sideFilterIn.value.trim()) runSearch(sideFilterIn.value);
  });
}
$('#btnSideMore').onclick = (e) => {
  e.stopPropagation();
  openMoreMenu(e.currentTarget, [
    {
      label: state.notifyEnabled ? '✓ 작업 완료 데스크톱 알림 켜짐' : '작업 완료 데스크톱 알림 켜기',
      icon: ICO.bell,
      onClick: async () => {
        if (!state.notifyEnabled && typeof Notification !== 'undefined' && Notification.permission === 'default') {
          await Notification.requestPermission().catch(() => {});
        }
        state.notifyEnabled = !state.notifyEnabled;
        try { localStorage.setItem('ach-notify', state.notifyEnabled ? '1' : '0'); } catch {}
        toast(state.notifyEnabled ? '작업 완료 알림을 켰습니다' : '작업 완료 알림을 껐습니다');
      },
    },
    { divider: true },
    {
      label: state.showHidden ? '✓ 숨은 콘솔 창 표시 중' : '숨은 콘솔 창 표시',
      icon: ICO.terminal,
      onClick: () => { state.showHidden = !state.showHidden; renderSide(); if (state.sel.kind === 'terms') viewTerms(); else if (state.sel.kind === 'home') refreshHomeWidgets(); },
    },
    {
      label: state.showDesktop ? '✓ Claude 데스크톱 세션 표시 중' : 'Claude 데스크톱 세션 표시',
      icon: ICO.settings,
      onClick: () => { state.showDesktop = !state.showDesktop; try { localStorage.setItem('ccd-show-desktop', state.showDesktop ? '1' : ''); } catch {} renderSide(); },
    },
  ]);
};

// ---------- boot ----------
(async () => {
  await Promise.all([refreshOverview(), refreshRecent(), refreshProjects(), refreshUsage(), refreshResearch(), typeof loadCalendar === 'function' ? loadCalendar() : Promise.resolve()]);
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
  else if (open === 'vault') select({ kind: 'vault' });
  else if (open.startsWith('research:')) { state.rtab = { [open.slice(9)]: qs.get('tab') || 'overview' }; select({ kind: 'research', id: open.slice(9) }); }
  else if (qs.get('q')) { runSearch(qs.get('q')); }
  else {
    let restored = null;
    try {
      const hm = /^#([a-z]+)(?::([^:]+)(?::([a-z]+))?)?$/.exec(location.hash || '');
      const fromHash = hm ? { sel: hm[2] ? { kind: hm[1], id: hm[2] } : { kind: hm[1] }, tab: hm[3] || undefined } : null;
      const saved = fromHash || JSON.parse(localStorage.getItem('ach-last-sel') || 'null');
      const s = saved?.sel;
      if (s && ['home', 'terms', 'projects', 'usage', 'calendar', 'gpu', 'vault', 'recent', 'research'].includes(s.kind)) restored = saved;
      else if (s?.kind === 'term' && state.terms.some((t) => String(t.id) === String(s.id))) restored = saved;
      else if (s?.kind === 'console' && state.consoles.some((c) => String(c.id) === String(s.id))) restored = saved;
    } catch {}
    if (restored) select(restored.sel, restored.tab);
    else select({ kind: 'home' });
  }
  setInterval(whenShown(refreshOverview), 4000);
  setInterval(whenShown(refreshRecent), 10000);
})();
