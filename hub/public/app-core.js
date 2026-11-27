// Agent CLI Hub — frontend
const qs = new URLSearchParams(location.search);
let TOKEN = qs.get('t') || '';
try { if (TOKEN) localStorage.setItem('ccd-token', TOKEN); else TOKEN = localStorage.getItem('ccd-token') || ''; } catch {}
// opened on this PC (127.0.0.1/localhost): the server put the token into the page — any browser profile works
if (window.LOCAL_TOKEN && TOKEN !== window.LOCAL_TOKEN) { TOKEN = window.LOCAL_TOKEN; try { localStorage.setItem('ccd-token', TOKEN); } catch {} }
if (qs.get('t')) { qs.delete('t'); history.replaceState(null, '', '/' + (qs.toString() ? '?' + qs : '') + location.hash); }

const $ = (s, el = document) => el.querySelector(s);
const desktopInvoke = window.__TAURI_INTERNALS__?.invoke?.bind(window.__TAURI_INTERNALS__);
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

async function api(path, { requireOk = false, ...opts } = {}) {
  const r = await fetch(path, {
    ...opts,
    headers: { 'x-token': TOKEN, 'content-type': 'application/json', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (r.status === 401) throw new Error('토큰이 없거나 틀립니다. 서버 콘솔/url.txt의 주소로 여세요.');
  if (requireOk && !r.ok) {
    const result = await r.json().catch(() => null);
    throw new Error(result?.error || `HTTP ${r.status} ${r.statusText}`.trim());
  }
  return r.json();
}

let booted = false;
let bootedAt = 0;
let activeBuildId = null;
let updateNoticeShown = false;
const initialBusyTerms = new Set();
const termBusySince = new Map();
const state = {
  sel: { kind: 'home' }, tab: 'screen', showHidden: false, favs: new Set(), sessionGroups: { version: 1, groups: [], assignments: {}, groupOrders: {} }, showDesktop: (() => { try { return !!localStorage.getItem('ccd-show-desktop'); } catch { return false; } })(),
  live: [], consoles: [], terms: [], recent: [], projects: [], err: null,
  usage: null, research: [], gpu: null, services: null, hubDown: false,
  termFilter: '', termsTab: 'active', termsView: 'list', recentQuery: '', sysTab: 'usage',
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
  const banner = document.getElementById('diskBanner');
  if (banner) {
    const msgs = [];
    if (!hubOk) msgs.push('⚠ 허브 서버(:7777)와 연결이 끊어졌습니다. 자동 재연결을 시도 중입니다.');
    if (state.disk) msgs.push(`⚠ ${esc(state.disk.drive)} 남은 공간 ${state.disk.freeGB} GB — 디스크가 가득 차면 세션이 멈춥니다.`);
    banner.innerHTML = msgs.join(' &nbsp;·&nbsp; ');
  }
}
function paintServerStatusPopover(pop) {
  const { hubOk, usageOk, ptyOk, agyOk } = computeHubHealth();
  const srv = state.services || {};
  const activeTerms = (state.terms || []).filter((t) => t.exited === null).length;
  const busyTerms = (state.terms || []).filter((t) => termStateOf(t) === 'busy').length;
  const swapAccs = state.agySwapAccounts || [];
  const activeSwap = swapAccs.find((a) => a.active);
  const agySelectHTML = swapAccs.length > 1
    ? `<select id="popAgySwap" class="btn-sm" style="flex:none;max-width:136px" aria-label="Antigravity 활성 계정 전환">${swapAccs.map((a) => `<option value="${esc(a.email)}" ${a.active ? 'selected' : ''}>${a.active ? '● ' : ''}${esc(a.name || a.email.replace(/@.*/, ''))}</option>`).join('')}</select>`
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
    <div class="srv-pop-foot">
      <button type="button" class="btn-sm" id="btnPopHome">${ICO.home} 홈으로</button>
      <div class="row">
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
    const minTop = document.documentElement.classList.contains('is-tauri') ? 38 : 8;
    const maxLeft = Math.max(8, window.innerWidth - 348);
    pop.style.top = `${Math.max(minTop, Math.round(r.bottom + 6))}px`;
    pop.style.left = `${Math.min(maxLeft, Math.max(8, Math.round(r.left)))}px`;
  }
  const closePop = () => {
    document.removeEventListener('click', onDoc, true);
    document.removeEventListener('keydown', onKey, true);
    pop.remove();
  };
  const onDoc = (e) => {
    if (pop.contains(e.target) || anchor?.contains(e.target)) return;
    closePop();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closePop(); anchor?.focus?.(); }
  };
  setTimeout(() => {
    document.addEventListener('click', onDoc, true);
    document.addEventListener('keydown', onKey, true);
  }, 0);
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
  if (pj && task && pj.autopilot && (nextState === 'idle' || nextState === 'exited')) {
    refreshOverview?.();
    refreshProjects?.();
    if (state.sel.kind === 'projects' && (state.sel.id === pj.id || projectId === pj.id)) openProject(pj.id);
  }
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

  notifyTerminal(id, msg, viewing);
}

async function notifyTerminal(id, msg, viewing) {
  if (!state.notifyEnabled) return;
  if (desktopInvoke) {
    try {
      if (await desktopInvoke('notify_terminal', { id, body: msg, viewing })) return;
    } catch (error) { console.warn('Windows terminal notification failed', error); }
  }
  if (!viewing && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    try {
      const n = new Notification('Agent CLI Hub', { body: msg, tag: `term-${id}` });
      n.onclick = () => { window.focus(); select({ kind: 'term', id }); n.close(); };
    } catch {}
  }
}

function terminalStartupLabel(t) {
  if (t?.startupBlock === 'folder-trust') return '폴더 신뢰 확인 필요';
  if (t?.startupBlock === 'term-dumb') return '터미널 환경 확인 필요';
  if (t?.startupBlock === 'login') return 'CLI 로그인 필요';
  if (t?.startupBlock === 'permission' || t?.startupBlock === 'confirmation') return '터미널에서 확인 필요';
  if (t?.dispatchPending) return '작업 시작 확인 중';
  if (t?.inputDraft) return '미제출 입력';
  return '';
}

function paintActiveTermStatus() {
  const pill = $('#termLiveBadge');
  if (!pill || state.sel.kind !== 'term') return;
  const t = state.terms.find((x) => String(x.id) === String(state.sel.id));
  if (!t) return;
  const meta = termStatusMeta(t);
  const st = meta.state;
  const startup = terminalStartupLabel(t);
  const justDone = st === 'idle' && state.justDoneTerms.has(String(t.id));
  pill.className = `term-live-pill ${startup || st === 'busy' ? 'busy' : justDone ? 'done' : st === 'exited' ? 'exited' : meta.dormant ? 'dormant' : 'idle'}`;
  pill.title = meta.dormant ? '1시간 이상 입력·출력 활동 없음' : '';
  pill.innerHTML = startup ? esc(startup) : st === 'busy'
    ? '<span class="dot busy" style="width:6px;height:6px"></span>실행 중'
    : justDone
      ? `${ICO.check} 작업 완료`
      : st === 'exited'
        ? `<span class="dot dead" style="width:6px;height:6px"></span>종료됨 (${t.exited})`
        : meta.dormant
          ? '<span class="dot dormant" style="width:6px;height:6px"></span>유휴'
          : '대기';
}

// ---------- data ----------
function shouldSuppressTermDoneNotice(t, busyInfo, now = Date.now()) {
  if (!t || isEphemeralTerm(t) || t.restoring) return true;
  const startedAt = Number(t.startedAt) || 0;
  const lastInputAt = Number(t.lastInputAt) || 0;
  const lastResizeAt = Number(t.lastResizeAt) || 0;
  const hadPostStartInput = !startedAt || lastInputAt > startedAt + 1500;
  // Cold-boot CLI startup banner/spinner finishing without user input is not a completed task.
  if (startedAt && (now - startedAt) < 15_000 && !t.hasInitialPrompt && !hadPostStartInput) return true;
  // Terminal load/resize TUI redraw flicker without new input after resize.
  if (lastResizeAt && (now - lastResizeAt) < 6000 && (!busyInfo || busyInfo.at >= lastResizeAt - 2000) && lastInputAt < lastResizeAt) return true;
  // Initial page-load settle window: ignore resize/attach glitches for terminals that were idle on boot.
  if (bootedAt && (now - bootedAt) < 8000 && !initialBusyTerms.has(String(t.id)) && lastInputAt < bootedAt) return true;
  return false;
}

async function refreshOverview() {
  let projectRevisions;
  let previousTerms = state.terms;
  const wasHubDown = state.hubDown;
  let buildChanged = false;
  try {
    const o = await api('/api/overview');
    projectRevisions = o.projectRevisions;
    if (o.buildId) {
      if (activeBuildId && o.buildId !== activeBuildId) {
        buildChanged = true;
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
    previousTerms = state.terms;
    Object.assign(state, { live: o.live || [], consoles: o.consoles || [], terms: o.terms || [], err: o.consoleError || null, services: o.services || state.services, hubDown: false });
    if (o.accountPrefs && typeof syncServerAccountPrefs === 'function') syncServerAccountPrefs(o.accountPrefs);
    if (Array.isArray(o.favs)) state.favs = new Set(o.favs);
    if (o.sessionGroups && Array.isArray(o.sessionGroups.groups)) state.sessionGroups = o.sessionGroups;
    state.disk = o.disk || null;
    state.consolesOff = !!o.consolesOff;
    // optional features the server turned on (Antigravity is off unless config "antigravity": true)
    state.features = o.features || state.features || { agy: true };
    if (o.pluginState && typeof o.pluginState === 'object') Object.assign(state, o.pluginState); // fields the enabled plugins add (plugins.js)
  } catch (e) {
    state.err = e.message;
    state.hubDown = true;
  }

  // Detect busy → idle / exited transitions for subtle completion indicator & notification
  const now = Date.now();
  if (booted && !bootedAt) bootedAt = now;
  const resyncQuiet = state.hubDown || wasHubDown || buildChanged;
  const aliveIds = new Set();
  const previousById = new Map(previousTerms.map((t) => [String(t.id), t]));
  let projTermChanged = false;
  if (!state.hubDown) {
    for (const t of state.terms) {
      const id = String(t.id);
      aliveIds.add(id);
      const cur = termStateOf(t);
      const prev = prevTermStates.get(id);
      const previous = previousById.get(id);
      const startup = terminalStartupLabel(t);
      if (t.projectTask && (prev !== cur || terminalStartupLabel(previous) !== startup)) projTermChanged = true;
      if (desktopInvoke && booted && !resyncQuiet && previous?.startupBlock !== t.startupBlock &&
          ['folder-trust', 'permission', 'confirmation'].includes(t.startupBlock)) {
        notifyTerminal(id, `${startup}: ${termLabel(t)}`, state.sel.kind === 'term' && String(state.sel.id) === id);
      }
      if (!booted && cur === 'busy') initialBusyTerms.add(id);
      if (resyncQuiet) {
        if (cur === 'busy') termBusySince.set(id, { at: now, polls: 1 });
        else termBusySince.delete(id);
        prevTermStates.set(id, cur);
        continue;
      }
      if (cur === 'busy') {
        state.justDoneTerms.delete(id);
        const info = termBusySince.get(id);
        if (info) info.polls += 1;
        else termBusySince.set(id, { at: now, polls: 1 });
      } else {
        const busyInfo = termBusySince.get(id) || null;
        if (booted && prev === 'busy' && (cur === 'idle' || cur === 'exited') && !startup && !shouldSuppressTermDoneNotice(t, busyInfo, now)) {
          fireTermDoneNotice(t, cur);
        }
        termBusySince.delete(id);
      }
      prevTermStates.set(id, cur);
    }
    for (const id of [...prevTermStates.keys()]) {
      if (!aliveIds.has(id)) {
        prevTermStates.delete(id);
        termBusySince.delete(id);
        initialBusyTerms.delete(id);
        state.unreadTerms.delete(id);
        state.justDoneTerms.delete(id);
      }
    }
  }
  updateDocTitle();
  paintActiveTermStatus();
  renderSide();
  updateFolderBadges();
  if (booted && state.sel.kind === 'projects' && !$('.pj-dialog[open]')) {
    const project = state.projects.find((p) => p.id === state.sel.id);
    const revision = projectRevisions?.[project?.id];
    const drawer = $('.drw-backdrop');
    const badge = drawer?.querySelector('[data-handoff-task]');
    if (badge && revision > Number(badge.dataset.handoffRevision)) {
      try {
        const { projects } = await api('/api/projects');
        const latest = projects.find((p) => p.id === project.id);
        if (badge.isConnected && latest?.revision > Number(badge.dataset.handoffRevision)) {
          badge.innerHTML = projectHandoffBadgeHTML(latest.tasks.find((t) => t.id === badge.dataset.handoffTask));
          badge.dataset.handoffRevision = latest.revision;
          const snapshots = drawer.querySelector('[data-drw-file-runs]');
          if (snapshots) {
            const html = projectFileRunLinksHTML(latest, badge.dataset.handoffTask);
            if (html !== snapshots.dataset.rendered) {
              snapshots.innerHTML = html;
              snapshots.dataset.rendered = html;
            }
          }
        }
      } catch (e) { console.warn('[project-handoff]', e.message); }
    } else if (!drawer && (projTermChanged || revision > project?.revision)) {
      if (typeof openProject === 'function') openProject(state.sel.id, projectTab);
    }
  }
  if (booted && (state.sel.kind === 'home' || state.sel.kind === 'terms') && homeKeyOf() !== homeKey) select({ kind: state.sel.kind });
  else refreshHomeWidgets();
}
async function refreshRecent(fresh = false) {
  try { state.recent = (await api(`/api/recent?n=100${fresh ? '&fresh=1' : ''}`)).sessions || []; } catch {}
  const agent = state.recentFilter;
  if (agent && agent !== 'live') {
    try {
      state.recentByAgent ||= {};
      state.recentByAgent[agent] = (await api(`/api/recent?n=100&agent=${encodeURIComponent(agent)}`)).sessions || [];
    } catch {}
  }
  renderSide();
  updateFolderBadges();
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
  const custom = cleanSideTitle(t.customTitle);
  if (custom) return custom;
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
function renameSessionItem({ sessionId = '', termId = '', currentTitle = '' } = {}) {
  const dialog = projectDialog('세션 명칭 수정', `
    <label>세션 명칭<input name="title" value="${esc(currentTitle)}" maxlength="140" autofocus></label>
    <small>기본 제목으로 복원하려면 비워 두세요.</small>`, async form => {
    const id = sessionId || `term:${termId}`;
    const res = await api('/api/transcript/title', { method: 'POST', requireOk: true, body: { id, title: form.get('title') } });
    const nextCustom = res.customTitle ?? (String(form.get('title') || '').trim());
    for (const item of [...state.recent, ...Object.values(state.recentByAgent || {}).flat(), ...(state.search.sessions || [])]) {
      if (res.sessionId && item.sessionId === res.sessionId) item.title = res.displayTitle;
    }
    for (const t of (state.terms || [])) {
      if ((termId && String(t.id) === String(termId)) || (res.sessionId && t.sessionId === res.sessionId)) {
        t.customTitle = nextCustom;
        if (res.displayTitle) t.sessionName = res.displayTitle;
      }
    }
    const syncTopHeading = () => {
      const active = state.sel;
      const term = active.kind === 'term' && state.terms.find(t => String(t.id) === String(active.id));
      const label = term ? termLabel(term) : active.kind === 'recent' ? sessionLabel(recentSession(active.id), active.id) : '';
      const heading = $('#bar .session-head h2 [data-session-title]') || $('#bar .session-head h2 > span:last-of-type');
      if (heading && label) heading.title = heading.textContent = label;
    };
    syncTopHeading();
    renderSide();
    await Promise.all([refreshOverview(), refreshRecent()]);
    syncTopHeading();
    renderSide();
    updateDocTitle();
    toast('세션 명칭을 수정했습니다');
  });
  dialog.querySelector('input').select();
  return dialog;
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
const visibleConsoles = () => state.consoles.filter((c) => !c.managed && !desktopConsole(c) && (state.showHidden || (c.visible && !!sessionOfConsole(c))));

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
const TERM_DORMANT_MS = 60 * 60 * 1000;
function isTermDormant(t, now = Date.now()) {
  if (!t || termStateOf(t) !== 'idle') return false;
  const ts = Math.max(Number(t.lastOutputAt) || 0, Number(t.lastInputAt) || 0, Number(t.startedAt) || 0);
  return ts > 0 && (now - ts) >= TERM_DORMANT_MS;
}
function termStatusMeta(t, now = Date.now()) {
  if (!t) return { state: 'exited', dormant: false, label: '종료됨', shortLabel: '종료됨', badgeClass: '', dot: 'dead', title: '' };
  const st = termStateOf(t);
  if (st === 'exited') return { state: 'exited', dormant: false, label: `종료됨 (${t.exited ?? '?'})`, shortLabel: '종료됨', badgeClass: '', dot: 'dead', title: '' };
  if (st === 'busy') return { state: 'busy', dormant: false, label: '실행 중', shortLabel: '실행 중', badgeClass: 'warn', dot: 'busy', title: '' };
  if (isTermDormant(t, now)) return { state: 'idle', dormant: true, label: '유휴', shortLabel: '유휴', badgeClass: 'dormant', dot: 'dormant', title: '1시간 이상 입력·출력 활동 없음' };
  return { state: 'idle', dormant: false, label: '대기', shortLabel: '대기', badgeClass: 'ok', dot: 'idle', title: '' };
}
function termStatusLabel(t) {
  return termStatusMeta(t).label;
}
const STATE_RANK = { busy: 0, idle: 1, exited: 2 };
const SIDE_LIVE_RANK = { busy: 0, idle: 0, exited: 2 };
function termActivityTs(t, recentMap = null) {
  if (!t) return 0;
  const own = Number(t.lastInputAt) || Number(t.startedAt) || 0;
  if (own) return own;
  const r = t.sessionId ? (recentMap ? recentMap.get(t.sessionId) : (state.recent || []).find((x) => x.sessionId === t.sessionId)) : null;
  return Number(r?.lastUserAt) || 0;
}
function consoleActivityTs(c) {
  const cs = sessionOfConsole(c);
  return Number(c?.lastInputAt) || Number(cs?.lastUserAt) || Number(cs?.mtime) || Number(c?.mtime) || Number(c?.pid) || 0;
}
function entryActivityTs(entry, recentMap = null) {
  if (!entry) return 0;
  if (entry.kind === 'term') return termActivityTs(entry.item, recentMap);
  if (entry.kind === 'console') return consoleActivityTs(entry.item);
  return Number(entry.item?.lastUserAt) || Number(entry.item?.mtime) || 0;
}
function compareUnifiedEntries(a, b, recentMap = null) {
  const rd = (a.rank ?? 9) - (b.rank ?? 9);
  if (rd !== 0) return rd;
  const td = entryActivityTs(b, recentMap) - entryActivityTs(a, recentMap);
  if (td !== 0) return td;
  return (Number(b.item?.id) || 0) - (Number(a.item?.id) || 0);
}
function sortTermsByState(list) {
  const recentMap = new Map((state.recent || []).map((r) => [r.sessionId, r]));
  return [...list].sort((a, b) => {
    const rd = (SIDE_LIVE_RANK[termStateOf(a)] ?? 9) - (SIDE_LIVE_RANK[termStateOf(b)] ?? 9);
    if (rd !== 0) return rd;
    const td = termActivityTs(b, recentMap) - termActivityTs(a, recentMap);
    return td !== 0 ? td : (Number(b.id) || 0) - (Number(a.id) || 0);
  });
}
function sortConsolesByState(list) {
  return [...list].sort((a, b) => {
    const rd = (SIDE_LIVE_RANK[consoleStateOf(a)] ?? 9) - (SIDE_LIVE_RANK[consoleStateOf(b)] ?? 9);
    if (rd !== 0) return rd;
    return consoleActivityTs(b) - consoleActivityTs(a);
  });
}
// Sidebar order. 'activity' (default): the most recently used session first, so rows move as
// sessions get input. 'stable': rows stay where they are while sessions work; terminals in the
// order they were opened, status changes only update badges. Set per hub with config.json
// "sidebar": { "order": "stable" }, or per browser with the sidebar's order button.
const SIDE_ORDER_KEY = 'ach-side-order';
function sideOrderMode() {
  try { const v = localStorage.getItem(SIDE_ORDER_KEY); if (v === 'stable' || v === 'activity') return v; } catch {}
  return state.features?.sidebar?.order === 'stable' ? 'stable' : 'activity';
}
function setSideOrderMode(mode) {
  try { localStorage.setItem(SIDE_ORDER_KEY, mode); } catch {}
}
// Favorites also listed again under the session list? (config "sidebar": { "favoritesInList": false } hides them there)
function sideFavsInList() {
  return state.features?.sidebar?.favoritesInList !== false;
}
const SIDE_KIND_ORDER = { term: 0, console: 1, recent: 2 };
function stableEntryCompare(a, b) {
  const rd = (a.rank ?? 9) - (b.rank ?? 9);
  if (rd !== 0) return rd;
  const kd = (SIDE_KIND_ORDER[a.kind] ?? 9) - (SIDE_KIND_ORDER[b.kind] ?? 9);
  if (kd !== 0) return kd;
  if (a.kind === 'recent') {
    // running sessions without a hub terminal: by start time; history records: newest first (they only change when resumed)
    const la = (state.live || []).find((s) => s.sessionId === a.item?.sessionId);
    const lb = (state.live || []).find((s) => s.sessionId === b.item?.sessionId);
    if (la && lb) return (Number(la.startedAt) || 0) - (Number(lb.startedAt) || 0) || String(a.item.sessionId).localeCompare(String(b.item.sessionId));
    return (Number(b.item?.mtime) || 0) - (Number(a.item?.mtime) || 0) || String(a.item?.sessionId).localeCompare(String(b.item?.sessionId));
  }
  return (Number(a.item?.id) || 0) - (Number(b.item?.id) || 0);
}
function compareSideEntries(a, b, recentMap = null) {
  return sideOrderMode() === 'stable' ? stableEntryCompare(a, b) : compareUnifiedEntries(a, b, recentMap);
}
function sortTermsForSide(list) {
  if (sideOrderMode() !== 'stable') return sortTermsByState(list);
  return [...list].sort((a, b) => stableEntryCompare(
    { kind: 'term', rank: SIDE_LIVE_RANK[termStateOf(a)] ?? 9, item: a },
    { kind: 'term', rank: SIDE_LIVE_RANK[termStateOf(b)] ?? 9, item: b }));
}
function sortConsolesForSide(list) {
  if (sideOrderMode() !== 'stable') return sortConsolesByState(list);
  return [...list].sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0));
}
function projectOfSession(sessionId) {
  return sessionId ? (state.projects || []).find((p) => p.sessionIds?.includes(sessionId)) || null : null;
}
function projectOfTerm(t) {
  if (!t) return null;
  const pid = t.projectTask?.projectId;
  if (pid) return (state.projects || []).find((p) => p.id === pid) || null;
  return projectOfSession(t.sessionId) || projectOfSession(t.branch?.parentSessionId)
    || (state.projects || []).find((p) => (p.termIds || []).includes(t.id)) || null;
}
function isEphemeralInternalText(txt) {
  const s = String(txt || '').trim();
  if (!s) return false;
  return /^(?:You are an independent automated reviewer|Create a proposed work plan only\.|Read the entire UTF-8 project task file at\b|Answer the user question concisely based on the selected excerpt|Resolve this Git merge in the current integration worktree\.|\[?프로젝트\s*(?:통합|병합)|프로젝트 병합 최종 검증 세션:|\[병합\]|Reply with (?:just|only|exactly)\s+(?:OK|HUB[A-Z0-9_-]+)\b)/i.test(s)
    || /\[사용자가 드래그해 선택한 부분\]|\[사이드 채팅 이전 질문\/답변\]|\[Primary Sources & Assumptions\]|\[Methods & Boundaries\]|\[Project version:\s*v?[\d.]/i.test(s);
}
function isEphemeralTerm(t) {
  if (!t || t.operator) return false;
  return !!(t.projectMerge || /^\[병합\]/.test(t.title || '') || isEphemeralInternalText(t.title)
    || /[\\/]\.hub-worktrees[\\/]/i.test(t.cwd || '') || /[\\/]hub-project-plan-[\w-]+/i.test(t.cwd || ''));
}
function isProjectSubSession(t) {
  if (!t) return false;
  return !!(t.projectTask || isEphemeralTerm(t));
}
function isProjectSubRecent(r) {
  if (!r) return false;
  return !!(r.auto || projectOfSession(r.sessionId)
    || ((r.agent || '') === 'agy' && !r.firstPrompt && !r.title)
    || /[\\/]\.hub-worktrees[\\/]/i.test(r.cwd || '') || /[\\/]hub-(?:project-plan|accept-cli|badge-probe|subagent-probe|app-export)-[\w-]+/i.test(r.cwd || '')
    || isEphemeralInternalText(r.firstPrompt || r.title));
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
  state.sysTab = activeTab;
  const gpuWait = state.gpu?.waiting?.length || 0;
  const tab = (id, icon, label, badge = '') =>
    `<button role="tab" data-systab="${id}" aria-selected="${activeTab === id}" class="${activeTab === id ? 'on' : ''}">${icon} ${label}${badge}</button>`;
  return `<div class="sys-top">
    <div class="tablist" role="tablist" aria-label="설정 메뉴">
      ${tab('appearance', ICO.monitor, '화면 설정')}
      ${tab('usage', ICO.chart, 'AI 사용량')}
      ${tab('gpu', ICO.gpu, 'GPU 대기열', gpuWait ? ` <span class="badge lim" style="margin-left:3px">${gpuWait}</span>` : '')}
      ${tab('vault', ICO.layers, '공통 자원')}
      ${tab('operator', ICO.settings, '관제 세션')}
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
