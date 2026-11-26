// ---------- Home: Minimal, Airy, Scannable Overview (Zero Sidebar Clutter) ----------
const homeKeyOf = () => visibleConsoles().map((c) => c.id).join(',') + '|' + state.terms.map((t) => t.id + (t.exited === null ? '' : 'x')).join(',');

function homeStatsHTML() {
  const cons = visibleConsoles();
  const allRunTerms = state.terms.filter((t) => t.exited === null);
  const runTerms = allRunTerms.filter((t) => !isProjectSubSession(t));
  const subRunN = allRunTerms.length - runTerms.length;
  const busyN = runTerms.filter((t) => termStateOf(t) === 'busy').length + cons.filter((c) => consoleStateOf(c) === 'busy').length;
  const dormantN = runTerms.filter((t) => isTermDormant(t)).length;
  const idleN = (runTerms.length + cons.length) - busyN - dormantN;

  const u = state.usage;
  const okAccs = (u?.accounts || []).filter((a) => a.ok && a.meters?.length);
  const swapAccs = state.agySwapAccounts || [];
  const agyGroups = state.agyQuota?.groups || [];
  const rems = [];
  for (const a of okAccs) {
    const ms = keyMeters(a);
    const used = ms.map((m) => m.usedPercent).filter((v) => v != null && Number.isFinite(Number(v)));
    if (used.length) rems.push(Math.max(0, Math.round(100 - Math.max(...used))));
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
  const minRemaining = rems.length ? Math.min(...rems) : null;
  const tightAccounts = rems.filter((pct) => pct <= 10).length;

  const calItems = ((typeof CAL !== 'undefined' && CAL?.data?.items) || []).filter((x) => !(x.kind === 'task' && x.done));
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const todayList = calItems.filter((x) => x.date === today).sort((a, b) => String(a.time || '99:99').localeCompare(String(b.time || '99:99')));
  const overN = calItems.filter((x) => x.kind === 'task' && !x.done && x.date < today).length;
  const nextEv = todayList[0] || calItems.filter((x) => x.date > today).sort((a, b) => a.date.localeCompare(b.date))[0];

  const g = state.gpu;
  const g0 = (g?.gpus || []).find((x) => x.index >= 0 && x.enabled !== false);
  const g0Mem = g0 && g0.totalMB ? Math.round((g0.usedMB / g0.totalMB) * 100) : 0;

  const remColor = minRemaining == null ? '' : minRemaining <= 10 ? ' style="color:var(--danger)"' : minRemaining <= 30 ? ' style="color:var(--warn)"' : '';
  const gpuColor = g0 && (g0.util || 0) >= 90 ? ' style="color:var(--danger)"' : '';
  return `
    <button type="button" class="h-stat" data-hnav="terms">
      <div class="h-stat-lbl"><span>열린 터미널</span>${busyN ? `<span class="badge warn">실행 중 ${busyN}</span>` : ''}</div>
      <div class="h-stat-val">${runTerms.length + cons.length}개</div>
      <div class="h-stat-sub">${runTerms.length + cons.length ? `실행 중 ${busyN} · 대기 ${idleN}${dormantN ? ` · 유휴 ${dormantN}` : ''}${subRunN ? ` · 프로젝트 서브 ${subRunN}` : ''}` : (subRunN ? `프로젝트 서브 ${subRunN}개 실행 중` : '열린 세션 없음')}</div>
    </button>
    <button type="button" class="h-stat" data-hnav="usage">
      <div class="h-stat-lbl"><span>AI 남은 한도</span>${tightAccounts ? `<span class="badge lim">임박 ${tightAccounts}개</span>` : ''}</div>
      <div class="h-stat-val"${remColor}>${minRemaining != null ? `${minRemaining}%` : '—'}</div>
      <div class="h-stat-sub">${minRemaining != null ? `조회된 ${rems.length}개 계정 중 최저` : !u ? '불러오는 중…' : '한도 정보 없음'}</div>
    </button>
    <button type="button" class="h-stat" data-hnav="calendar">
      <div class="h-stat-lbl"><span>오늘 일정</span>${overN ? `<span class="badge lim">지연 ${overN}</span>` : ''}</div>
      <div class="h-stat-val">${todayList.length}건</div>
      <div class="h-stat-sub">${nextEv ? `${nextEv.time ? nextEv.time + ' ' : ''}${esc(nextEv.title)}` : '예정된 일정 없음'}</div>
    </button>
    <button type="button" class="h-stat" data-hnav="gpu">
      <div class="h-stat-lbl"><span>GPU</span>${g?.waiting?.length ? `<span class="badge lim">대기 ${g.waiting.length}</span>` : ''}</div>
      <div class="h-stat-val"${gpuColor}>${g0 ? `${g0.util || 0}%` : '—'}</div>
      <div class="h-stat-sub">${g0 ? `VRAM ${fmtMB(g0.usedMB)} / ${fmtMB(g0.totalMB)} (${g0Mem}%)` : !g ? '확인 중…' : '활성 GPU 없음'}</div>
    </button>`;
}

function homeListsHTML() {
  const cons = sortConsolesByState(visibleConsoles());
  const terms = sortTermsByState(state.terms.filter((t) => t.exited === null && !isProjectSubSession(t)));
  const recentMap = new Map((state.recent || []).map((r) => [r.sessionId, r]));
  const merged = [
    ...terms.map((t) => ({ kind: 'term', rank: STATE_RANK[termStateOf(t)] ?? 9, item: t })),
    ...cons.map((c) => ({ kind: 'console', rank: STATE_RANK[consoleStateOf(c)] ?? 9, item: c })),
  ].sort((a, b) => compareUnifiedEntries(a, b, recentMap)).slice(0, 4);
  const termRows = merged.map((entry) => {
    if (entry.kind === 'term') {
      const t = entry.item;
      const meta = termStatusMeta(t);
      const kind = t.operator ? 'operator' : t.agent || 'shell';
      const pj = projectOfTerm(t);
      const cwdBase = base(t.cwd);
      const showCwd = cwdBase && cwdBase !== pj?.name ? ` · ${esc(cwdBase)}` : '';
      return `<div class="m-row" data-open-term="${esc(t.id)}">
        ${agentIcon(kind, meta.dot)}
        <div class="m-row-main"><div class="m-row-t">${esc(termLabel(t))}</div><div class="m-row-s">${esc(termKindLabel(t))}${showCwd}</div></div>
        <div class="m-row-end">${folderBadge(folderTarget(t, true))}${branchTagHTML(t.branch)}${pj ? `<span class="badge tag">${esc(pj.name)}</span>` : ''}<span class="badge ${meta.badgeClass}" title="${esc(meta.title)}">${esc(meta.shortLabel)}</span></div>
      </div>`;
    }
    const c = entry.item;
    const st = consoleStateOf(c);
    return `<div class="m-row" data-open-con="${esc(c.id)}">
      ${agentIcon(sessionOfConsole(c) ? 'claude' : 'shell', st === 'busy' ? 'busy' : 'idle')}
      <div class="m-row-main"><div class="m-row-t">${esc(consoleLabel(c))}</div><div class="m-row-s">외부 콘솔</div></div>
      <div class="m-row-end">${folderBadge(folderTarget(sessionOfConsole(c) || c, false, true))}<span class="badge agy">콘솔</span><span class="badge ${st === 'busy' ? 'warn' : 'ok'}">${st === 'busy' ? '실행 중' : '대기'}</span></div>
    </div>`;
  }).join('') || '<div class="empty" style="padding:24px 16px;text-align:center">열린 터미널이 없습니다. 위에서 바로 시작해 보세요.</div>';

  const liveIds = new Set(state.live.map((s) => s.sessionId));
  for (const t of terms) liveIds.add(t.sessionId);
  const recents = state.recent.filter((r) => !liveIds.has(r.sessionId) && !isProjectSubRecent(r)).slice(0, 4);
  const recentRows = recents.map((r) => {
    const ag = r.agent || 'claude';
    return `<div class="m-row" data-hrecent="${esc(r.sessionId)}">
      ${agentIcon(ag)}
      <div class="m-row-main"><div class="m-row-t">${esc(sessionLabel(r))}</div><div class="m-row-s">${esc([r.branch?.isBranch && r.branch?.parentTitle ? `원본: ${r.branch.parentTitle}` : '', base(r.cwd), ago(r.mtime)].filter(Boolean).join(' · '))}</div></div>
      <div class="m-row-end">${folderBadge(folderTarget(r))}${branchTagHTML(r.branch)}<button class="btn-sm" data-hresume="${esc(r.sessionId)}">이어하기</button></div>
    </div>`;
  }).join('') || '<div class="empty" style="padding:24px 16px;text-align:center">최근 대화 기록이 없습니다.</div>';

  const appsList = (state.homeApps || []).slice(0, 4);
  const appRows = appsList.map((a) => {
    const st = a.status === 'running' ? 'running' : (a.latestRun?.status || a.status || 'idle');
    const bCls = st === 'running' ? 'warn' : st === 'error' ? 'lim' : st === 'ok' ? 'ok' : '';
    const bTxt = st === 'running' ? '실행 중' : st === 'error' ? '오류' : st === 'ok' ? '완료' : '대기';
    return `<div class="m-row" data-open-app="${esc(a.id)}">
      <div class="m-row-main"><div class="m-row-t">${esc(a.name)}</div><div class="m-row-s">${esc(a.description || a.type || '')}</div></div>
      <div class="m-row-end"><span class="badge">${esc(a.type || 'app')}</span><span class="badge ${bCls}">${bTxt}</span></div>
    </div>`;
  }).join('') || `<div class="empty" style="padding:20px 16px;text-align:center">${state.homeApps ? '등록된 앱이 없습니다.' : '불러오는 중…'}</div>`;

  const schedList = (state.homeSchedules || []).slice(0, 4);
  const schedRows = schedList.map((s) => {
    const active = s.state === 'active';
    const trig = s.trigger?.kind === 'interval' ? `${s.trigger.everyMinutes}분마다` : (s.trigger?.expression || '');
    const tgt = s.target?.projectId
      ? ((state.projects || []).find((p) => p.id === s.target.projectId)?.name || s.target.projectId)
      : base(s.target?.cwd || '');
    return `<div class="m-row" data-hnav="schedules">
      <div class="m-row-main"><div class="m-row-t">${esc(s.name)}</div><div class="m-row-s">${esc([tgt, s.target?.cli, trig].filter(Boolean).join(' · '))}</div></div>
      <div class="m-row-end"><span class="badge ${active ? 'ok' : ''}">${active ? '활성' : '일시정지됨'}</span></div>
    </div>`;
  }).join('') || `<div class="empty" style="padding:20px 16px;text-align:center">${state.homeSchedules ? '등록된 스케줄이 없습니다.' : '불러오는 중…'}</div>`;

  return `
    <section class="sheet">
      <div class="sheet-hd"><h2>열린 터미널</h2><button class="ghost btn-sm" data-hnav="terms">전체 보기 →</button></div>
      <div>${termRows}</div>
    </section>
    <section class="sheet">
      <div class="sheet-hd"><h2>최근 대화</h2><button class="ghost btn-sm" data-hnav="terms-recent">전체 보기 →</button></div>
      <div>${recentRows}</div>
    </section>
    <section class="sheet">
      <div class="sheet-hd"><h2>스케줄</h2><button class="ghost btn-sm" data-hnav="schedules">전체 보기 →</button></div>
      <div>${schedRows}</div>
    </section>
    <section class="sheet">
      <div class="sheet-hd"><h2>앱스</h2><button class="ghost btn-sm" data-hnav="apps">전체 보기 →</button></div>
      <div>${appRows}</div>
    </section>`;
}

let homeExtrasAt = 0;
function loadHomeExtras(force = false) {
  const now = Date.now();
  if (!force && now - homeExtrasAt < 10_000) return;
  homeExtrasAt = now;
  Promise.all([
    api('/api/apps').then((r) => { state.homeApps = r?.apps || []; }).catch(() => { state.homeApps ||= []; }),
    api('/api/schedules').then((r) => { state.homeSchedules = r?.items || []; }).catch(() => { state.homeSchedules ||= []; }),
  ]).then(() => {
    if (state.sel.kind === 'home') {
      const l = $('#homeLists');
      if (l) l.innerHTML = homeListsHTML();
    }
  });
}

function refreshHomeWidgets() {
  if (state.sel.kind !== 'home') return;
  const s = $('#homeStats'); if (s) s.innerHTML = homeStatsHTML();
  const l = $('#homeLists'); if (l) l.innerHTML = homeListsHTML();
  loadHomeExtras(false);
}

function termCardHTML(t, extraBadge = '') {
  const meta = termStatusMeta(t);
  const st = meta.state;
  const dot = meta.dot;
  const kind = t.operator ? 'operator' : t.agent || 'shell';
  const pj = projectOfTerm(t);
  const pjBadge = pj && !extraBadge ? `<span class="badge c" title="Project: ${esc(pj.name)}">${esc(pj.name)}</span>` : '';
  const kindBadge = `<span class="badge">${esc(t.operator ? '관제' : t.agent ? '터미널' : '셸')}</span>`;
  const stBadge = `<span class="badge ${meta.badgeClass}" title="${esc(meta.title)}">${esc(meta.shortLabel)}</span>`;
  const closeBtn = st === 'exited'
    ? `<button class="ghost icon-btn btn-sm" data-term-close="${esc(t.id)}" aria-label="종료된 터미널 닫기" title="종료된 터미널 제거">${ICO.close}</button>`
    : '';
  return `<div class="card" data-term="${t.id}"><div class="hd">${agentIcon(kind, dot)}
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
      <div class="h-hero-txt">
        <h1>홈</h1>
        <p class="h-hero-sub">실시간 에이전트 세션 · AI 한도 · GPU 워크스페이스 요약</p>
      </div>
      <button class="primary" data-hopen-new="1">${ICO.plus} 새 터미널</button>
    </header>
    <div class="h-stats" id="homeStats">${homeStatsHTML()}</div>
    <div class="h-two" id="homeLists">${homeListsHTML()}</div>
  </div>`;
  loadHomeExtras(true);
  $('#view').onclick = async (e) => {
    if (e.target.closest('[data-hopen-new]')) return openNewTermDrawer();
    const resBtn = e.target.closest('[data-hresume]');
    if (resBtn) { e.stopPropagation(); return resumeRecentSession(resBtn.dataset.hresume, resBtn); }
    const openApp = e.target.closest('[data-open-app]');
    if (openApp) {
      const appId = openApp.dataset.openApp;
      return select({ kind: 'apps', id: appId });
    }
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
    const recentMap = new Map((state.recent || []).map((r) => [r.sessionId, r]));
    const mergedActive = [
      ...shownTerms.map((t) => ({ kind: 'term', rank: STATE_RANK[termStateOf(t)] ?? 9, item: t })),
      ...shownCons.map((c) => ({ kind: 'console', rank: STATE_RANK[consoleStateOf(c)] ?? 9, item: c })),
    ].sort((a, b) => compareUnifiedEntries(a, b, recentMap));
    const segBtn = (val, label, cnt) => `<button data-tview-filt="${val}" class="${tf === val ? 'on' : ''}">${label} <span class="seg-cnt">${cnt}</span></button>`;
    const controls = `<div class="row terms-controls" style="justify-content:space-between;gap:10px">
      <div class="seg" role="tablist" aria-label="터미널 상태 탭">
        ${segBtn('', '전체', counts.all)}
        ${segBtn('busy', '실행 중', counts.busy)}
        ${segBtn('idle', '대기', counts.idle)}
        ${segBtn('exited', '종료됨', counts.exited)}
      </div>
      <div class="row" style="gap:8px">
        ${counts.exited ? `<button class="ghost btn-sm" id="btnCleanExited">${ICO.trash} 종료됨 정리 (${counts.exited})</button>` : ''}
        <div class="seg" role="tablist" aria-label="보기 방식">
          <button data-tview-mode="list" class="${state.termsView === 'list' ? 'on' : ''}">목록</button>
          <button data-tview-mode="cards" class="${state.termsView !== 'list' ? 'on' : ''}">미리보기</button>
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
          const meta = termStatusMeta(t);
          const st = meta.state;
          const kind = t.operator ? 'operator' : t.agent || 'shell';
          const pj = projectOfTerm(t);
          const fk = favKeyOf(`term:${t.id}`), on = !!fk && (state.favs || new Set()).has(fk);
          return `<div class="m-row" data-open-term="${esc(t.id)}">
            ${agentIcon(kind, meta.dot)}
            <div class="m-row-main"><div class="m-row-t">${esc(termLabel(t))}</div><div class="m-row-s">${esc(termKindLabel(t))}${base(t.cwd) ? ` · ${esc(base(t.cwd))}` : ''}</div></div>
            <div class="m-row-end">
              ${branchTagHTML(t.branch)}
              ${fk ? `<span class="fav${on ? ' on' : ''}" data-fav="${esc(fk)}" role="button" tabindex="0">${on ? ICO.starFill : ICO.star}</span>` : ''}
              ${pj ? `<span class="badge c">${esc(pj.name)}</span>` : ''}
              <span class="badge ${meta.badgeClass}" title="${esc(meta.title)}">${esc(meta.label)}</span>
              ${st === 'exited' ? `<button class="ghost icon-btn btn-sm" data-term-close="${esc(t.id)}" aria-label="닫기">${ICO.close}</button>` : ''}
            </div>
          </div>`;
        }
        const c = entry.item;
        const st = consoleStateOf(c);
        return `<div class="m-row" data-open-con="${esc(c.id)}">
          ${agentIcon(sessionOfConsole(c) ? 'claude' : 'shell', st === 'busy' ? 'busy' : 'idle')}
          <div class="m-row-main"><div class="m-row-t">${esc(consoleLabel(c))}</div><div class="m-row-s">외부 콘솔</div></div>
          <div class="m-row-end">${folderBadge(folderTarget(sessionOfConsole(c) || c, false, true))}<span class="badge agy">외부 콘솔</span><span class="badge ${st === 'busy' ? 'warn' : 'ok'}">${st === 'busy' ? '실행 중' : '대기'}</span></div>
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
    const previousFilter = $('#recFilter', host);
    if (previousFilter?.dataset.composing) return;
    const restoreFocus = previousFilter && document.activeElement === previousFilter;
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
      if (restoreFocus) {
        inp.focus({ preventScroll: true });
        inp.setSelectionRange(previousFilter.selectionStart, previousFilter.selectionEnd);
      }
      inp.oncompositionstart = () => { inp.dataset.composing = '1'; };
      inp.oncompositionend = inp.oninput = (e) => {
        if (e.type === 'compositionend') delete inp.dataset.composing;
        if (e.isComposing || inp.dataset.composing || state.recentQuery === inp.value) return;
        state.recentQuery = inp.value;
        paintTermsBody();
      };
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
      const meta = termStatusMeta(t);
      return `<div class="m-row" data-open-term="${esc(t.id)}">${agentIcon(t.operator ? 'operator' : t.agent || 'shell', meta.dot)}<div class="m-row-main"><div class="m-row-t">${esc(termLabel(t))}</div><div class="m-row-s">${esc(base(t.cwd))}</div></div><div class="m-row-end"><span class="fav on" data-fav="${esc(f)}" data-fav-keys="${esc((entry.allKeys || [f]).join(','))}" role="button" tabindex="0">${ICO.starFill}</span><span class="badge ${meta.badgeClass}" title="${esc(meta.title)}">${esc(meta.label)}</span></div></div>`;
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
          ${tbtn('active', '터미널', activeN)}
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
