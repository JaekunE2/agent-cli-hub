// ---------- Routing, Search, Command Palette & Boot ----------
// ---------- views ----------
function stopView() {
  stopSchedulesView();
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
  setSidebarOpen(false);
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
  const leaving = state.sel.kind === 'term' && (sel.kind !== 'term' || String(state.sel.id) !== String(sel.id))
    ? state.terms.find(t => String(t.id) === String(state.sel.id) && t.projectTask) : null;
  if (sel.kind !== state.sel.kind || String(sel.id) !== String(state.sel.id)) closeWorkspacePanel();
  stopView();
  if (leaving) setTimeout(() => {
    if (state.sel.kind === 'term' && String(state.sel.id) === String(leaving.id)) return;
    api('/api/term/discard-unused', { method: 'POST', body: { id: leaving.id } })
      .then(r => { if (r.removed) return refreshOverview(); }).catch(() => {});
  }, 1750);
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
      const version = sel.kind === 'projects' && sel.version ? `:${sel.version}` : '';
      const h = sel.id ? `#${sel.kind}:${sel.id}:${state.tab}${version}` : `#${sel.kind}`;
      if (location.hash !== h) history.replaceState(null, '', h);
    } catch {}
  }
  renderSide();
  window.ACH_PREVIEW?.setActiveController(null);
  if (sel.kind === 'trusted-folders') return viewTrustedFolders();
  if (sel.kind === 'schedules') return viewSchedules();
  return ({ home: viewHome, terms: viewTerms, projects: window.viewProjects || (() => { setBar('<h2>Project</h2>'); $('#view').textContent = 'Project 기능을 반영하려면 허브 서버를 재시작해야 합니다.'; }), console: viewConsole, recent: viewTranscript, term: viewTerm, search: viewSearch, usage: viewUsage, research: viewResearch, gpu: viewGpu, operator: window.viewOperator || (() => { setBar('<h2>관제 세션</h2>'); }), calendar: viewCalendar, apps: window.viewApps || (() => { setBar('<h2>Apps</h2>'); }), vault: window.viewVault || (() => { setBar('<h2>공통 자원</h2>'); $('#view').textContent = '공통 자원 기능을 반영하려면 허브 서버를 재시작해야 합니다.'; }) })[sel.kind]?.();
}

function setBar(html) {
  unmountSubagents?.();
  window.ACH_TOOL_STREAM?.destroyAll();
  $('#bar').innerHTML = html || '';
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
  setBar(`<h2 style="flex:none">${ICO.search} 전체 검색</h2><input id="sq" class="btn-sm search-query" type="search" value="${esc(S.q)}" placeholder="검색어 (공백 = AND)"><button class="primary btn-sm" id="sGo">검색</button>`);
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
    const snippets = (preview, other, render) => preview.map(render).join('') + (other.length
      ? `<details class="search-more"><summary>추가 일치 항목 <span class="badge">${other.length}</span></summary>${other.map(render).join('')}</details>` : '');
    let h = `<div class="empty" style="padding:0 0 6px">세션 ${d.sessions.length}개 · 메시지 ${nHits}건 · 창 ${d.screens.length}개 · ${d.ms}ms</div>`;
    if (!d.ready) h += `<div class="empty">인덱스 구축 중 (${d.progress?.done || 0}/${d.progress?.total || '?'} 파일) — 결과가 일부만 나올 수 있습니다.</div>`;
    if (d.screens.length) {
      h += '<h3>열린 창 화면</h3>' + d.screens.map((c) => `<div class="rgroup">
        <div class="rh" data-console="${c.id}"><span class="t">${esc(c.title || 'pid ' + c.id)}</span><span class="badge">${c.total}줄</span></div>
        ${snippets(c.hits.slice(0, 2), c.hits.slice(2), (x) => `<div class="hit mono" data-console="${c.id}"><span class="r">화면</span><span class="x">${hl(x.text, terms)}</span></div>`)}</div>`).join('');
    }
    if (d.sessions.length) {
      h += '<h3>세션 대화 기록</h3>' + d.sessions.map((r) => {
        const live = state.live.some((s) => s.sessionId === r.sessionId);
        const isToolHit = (x) => x.role === 'assistant' && /^\s*⚙|^\s*…\s*(?:text\(|await tools\.|tools\.exec_command|[\w.]+patch\()/i.test(x.snippet);
        const preview = r.hits.filter((x) => !isToolHit(x)).slice(0, 2);
        const other = r.hits.filter((x) => !preview.includes(x));
        return `<div class="rgroup">
        <div class="rh" data-sid="${r.sessionId}" data-at="-1"><span class="dot ${live ? 'idle' : 'dead'}" style="margin-top:0"></span>
        <span class="t">${hl(sessionLabel(r), terms)}</span>
          ${r.idMatch ? '<span class="badge lim">세션 ID 일치</span>' : ''}${branchTagHTML(r.branch)}${r.auto ? '<span class="badge">sdk</span>' : ''}${agentBadge(r.agent)}
          <span class="ums" style="margin:0">${esc([base(r.cwd), ago(r.mtime)].filter(Boolean).join(' · '))}</span>
          <span class="badge c">${r.idMatch ? `메시지 ${r.total}개` : `${r.total}건`}</span></div>
        ${snippets(preview, other, (x) => `<div class="hit${isToolHit(x) ? ' mono' : ''}" data-sid="${r.sessionId}" data-at="${x.i}">
          <span class="r">${x.role === 'user' ? '사용자' : r.agent === 'codex' ? 'Codex' : r.agent === 'agy' ? 'Antigravity' : 'Claude'}</span><span class="x">${hl(x.snippet, terms)}</span></div>`)}
        ${!r.idMatch && r.total > r.hits.length ? `<div class="hit" data-sid="${r.sessionId}" data-at="${r.hits.at(-1)?.i ?? -1}"><span class="r"></span><span class="x" style="color:var(--muted)">대화에서 나머지 ${r.total - r.hits.length}건 보기 →</span></div>` : ''}
      </div>`;
      }).join('');
    }
    if (!d.sessions.length && !d.screens.length) h += '<div class="empty" style="padding:12px 0">결과 없음</div>';
    const host = $('#searchBody');
    if (host) {
      host.innerHTML = h;
      if (state.sel.restoreScroll) $('#view').scrollTo({ top: S.scrollTop || 0, behavior: 'instant' });
    }
  }).catch((e) => { const host = $('#searchBody'); if (host) host.innerHTML = `<div class="err">${esc(e.message)}</div>`; });

  $('#view').onclick = (e) => {
    const el = e.target.closest('[data-sid],[data-console]');
    if (!el) return;
    if (el.dataset.console) return select({ kind: 'console', id: el.dataset.console, hl: S.q });
    S.scrollTop = $('#view').scrollTop;
    select({ kind: 'recent', id: el.dataset.sid, at: Number(el.dataset.at), q: S.q, fromSearch: true }, 'chat');
  };
  setTimeout(() => $('#sq')?.focus(), 0);
}

// ---------- Instant Command Palette ----------
function openCommandPalette() {
  if ($('.cmdk-backdrop')) return;
  const trigger = document.activeElement;
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
  const close = () => {
    document.removeEventListener('keydown', onKey, true);
    wrap.remove();
    trigger?.focus();
  };

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

    const matchingTerms = sortTermsByState(state.terms || [])
      .filter((t) => hit(termLabel(t), t.cwd || '', projectOfTerm(t)?.name || '', '터미널'))
      .slice(0, 8);
    const visibleSessionIds = new Set(matchingTerms.map((t) => t.sessionId).filter(Boolean));
    const termHits = matchingTerms.map((t) => {
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
      .filter((r) => !visibleSessionIds.has(r.sessionId) && hit(sessionLabel(r), r.cwd || '', r.agent || ''))
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
      { icon: ICO.settings, title: '관제 세션', sub: '설정 · CLI/주기', keys: 'operator 관제 세션 cli claude codex agy 설정 settings', run: () => select({ kind: 'operator' }) },
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

document.addEventListener('keydown', e => {
  if (e.defaultPrevented || e.isComposing || e.repeat || e.altKey || e.shiftKey ||
      !(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'k' ||
      $('dialog[open], .drw-backdrop, .dlg')) return;
  e.preventDefault();
  openCommandPalette();
});

function toggleTuiGuiFace() {
  const kind = state.sel?.kind;
  if (kind === 'term') {
    const open = window.ACH_DOCK ? window.ACH_DOCK.getDockOpen('term', state.tab) : ['term', 'chat'];
    const isTuiOnly = open.includes('term') && !open.includes('chat');
    const next = isTuiOnly ? ['chat'] : ['term'];
    window.ACH_DOCK?.saveDockOpen('term', next);
    select(state.sel, 'dock', true);
    toast(isTuiOnly ? 'GUI 대화 모드로 전환 (Alt+J)' : 'TUI 터미널 모드로 전환 (Alt+J)', 1800);
    return true;
  }
  if (kind === 'recent' || kind === 'session') {
    const live = (state.terms || []).find((t) => t.exited === null && t.sessionId === state.sel.id);
    if (live) {
      window.ACH_DOCK?.saveDockOpen('term', ['term']);
      select({ kind: 'term', id: live.id }, 'dock', true);
      toast('연결된 TUI 터미널로 전환 (Alt+J)', 1800);
      return true;
    }
  }
  return false;
}

document.addEventListener('keydown', e => {
  if (e.defaultPrevented || e.isComposing || e.repeat || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey ||
      e.key.toLowerCase() !== 'j' || $('dialog[open], .drw-backdrop, .dlg')) return;
  if (toggleTuiGuiFace()) e.preventDefault();
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
  const agTile = (val, icoKind, name, sub, tip = '') => `<label class="nt-tile"${tip ? ` title="${esc(tip)}"` : ''}>
    <input type="radio" name="k" value="${val}" ${chk(val)}>
    ${agentIcon(icoKind)}
    <span class="nt-tile-txt"><span class="nt-tile-name">${esc(name)}</span><span class="nt-tile-sub">${esc(sub)}</span></span>
  </label>`;
  const shTile = (val, name) => `<label class="nt-tile">
    <input type="radio" name="k" value="${val}" ${chk(val)}>
    ${agentIcon('shell')}
    <span class="nt-tile-txt"><span class="nt-tile-name">${esc(name)}</span></span>
  </label>`;
  const body = `
    <div class="nt-sec">
      <div class="drw-lbl">AI 에이전트</div>
      <div class="nt-grid">
        ${agTile('claude', 'claude', 'Claude Code', 'Anthropic CLI 에이전트')}
        ${agTile('codex', 'codex', 'GPT (Codex)', 'OpenAI 코딩 에이전트', 'ChatGPT 계정(Codex 앱 로그인)으로 GPT 대화형 세션')}
        ${agTile('agy', 'agy', 'Antigravity', 'Google 에이전트 CLI (agy)')}
        ${agTile('cursor', 'cursor', 'Cursor', 'cursor-agent 터미널', 'Cursor 터미널 에이전트 (처음 한 번 cursor-agent login 필요)')}
      </div>
    </div>
    <div class="nt-sec">
      <div class="drw-lbl">시스템 터미널 셸${state.researchEnabled ? ' · 자율 연구' : ''}</div>
      <div class="nt-grid shells">
        ${shTile('powershell', 'PowerShell')}
        ${shTile('pwsh', 'PowerShell 7')}
        ${shTile('cmd', 'cmd')}
        ${shTile('ubuntu', 'Ubuntu (WSL)')}
        ${shTile('gitbash', 'Git Bash')}
        ${state.researchEnabled ? agTile('research', 'operator', '연구 디렉터', '무인 자율 연구') : ''}
      </div>
    </div>
    <div id="nTerm" style="display:flex;flex-direction:column;gap:10px;padding-top:4px;border-top:1px solid var(--line)">
      <label style="display:flex;flex-direction:column;gap:5px;font-size:12.5px;font-weight:600;color:var(--muted)">작업 폴더
        <div class="fp-input-row">
          <input id="nCwd" list="cwdl" style="width:100%;font-weight:400;color:var(--text)" value="${esc(projectCwd || cwds[0] || '')}" placeholder="비우면 홈 폴더">
          <button type="button" class="btn-sm" id="nPickDir" title="호스트 컴퓨터 경로 탐색기 열기">${ICO.folder || ''} 폴더 선택</button>
        </div>
        <datalist id="cwdl">${cwds.map((c) => `<option value="${esc(c)}">`).join('')}</datalist></label>
      <details class="new-term-options">
        <summary>모델 및 추론 옵션</summary>
        <div id="nMeHost" style="display:flex;flex-direction:column;gap:8px">${typeof projectModelEffortFields === 'string' ? projectModelEffortFields : ''}</div>
      </details>
      <label class="row" style="font-size:12.5px;cursor:pointer"><input type="checkbox" id="nSkip" checked> YOLO 모드 자동 승인 (Claude · Codex · Antigravity)</label>
      <label class="row" style="font-size:12.5px;cursor:pointer"><input type="checkbox" id="nAdmin"> 관리자 권한으로 실행 (Windows UAC · 외부 콘솔 창)</label>
    </div>
    <div id="nRes" hidden style="display:flex;flex-direction:column;gap:10px;padding-top:4px;border-top:1px solid var(--line)">
      <label style="display:flex;flex-direction:column;gap:5px;font-size:12.5px;font-weight:600;color:var(--muted)">프로젝트 이름<input id="rName" style="width:100%;font-weight:400;color:var(--text)" placeholder="예: 조명 변화에 강한 DT 3DGS"></label>
      <label style="display:flex;flex-direction:column;gap:5px;font-size:12.5px;font-weight:600;color:var(--muted)">연구 방향<textarea id="rDir" rows="6" style="width:100%;font-weight:400;color:var(--text)" placeholder="예) 공장 디지털트윈에서 조명이 바뀌어도 3DGS 재구성이 흔들리지 않게 하고 싶다. 가진 것: CAD 모델, Replica 데이터, RTX 4090 1장. 원하는 기여: …  기간: 11월 중순 투고"></textarea></label>
      <label style="display:flex;flex-direction:column;gap:5px;font-size:12.5px;font-weight:600;color:var(--muted)">목표 학회·저널 (선택)<input id="rVenue" style="width:100%;font-weight:400;color:var(--text)" placeholder="비우면 디렉터가 조사해 정합니다 — 예: CVPR 2027"></label>
      <label style="display:flex;flex-direction:column;gap:5px;font-size:12.5px;font-weight:600;color:var(--muted)">어디까지 진행할까요?<select id="rGoal" style="width:100%;font-weight:400;color:var(--text)">${Object.entries(GOAL_KO).map(([k, v]) => `<option value="${k}" ${k === 'P9_review' ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
      <div class="rban ok" style="margin:0"><b>중간에 묻지 않고 목표까지 알아서 진행합니다.</b> 환경 설치·데이터 받기·테스트도 스스로 합니다. 진행할 수 없는 문제가 생겼을 때만 멈추고 알려드립니다.</div>
    </div>`;
  const d = openDrawer({ title: '새 세션 · 터미널 열기', bodyHTML: body, footerHTML: '<button data-drw-close>취소</button><button id="nExt" title="이 PC의 새 Windows 콘솔 창(외부 터미널)에서 엽니다">외부 창으로 열기</button><button class="primary" id="nOk">대시보드에서 열기</button>', width: 520 });
  d.classList.add('drw-compact');
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
    $('#nTerm', d).hidden = isRes;
    $('#nTerm', d).style.display = isRes ? 'none' : 'flex';
    $('#nRes', d).hidden = !isRes;
    $('#nRes', d).style.display = isRes ? 'flex' : 'none';
    $('.new-term-options', d).hidden = !supportsME(k);
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
      admin: !!$('#nAdmin', d)?.checked,
      ...(me.model ? { model: me.model } : {}),
      ...(me.effort ? { effort: me.effort } : {}),
    };
  };
  $('#nExt', d).onclick = async () => {
    const kind = kindOf();
    if (kind === 'research') return;
    $('#nExt', d).disabled = true;
    const p = launchParams(kind);
    const r = await api('/api/term/external', { method: 'POST', body: p });
    $('#nExt', d).disabled = false;
    if (r.error) return toast(r.error, 6000);
    d.close();
    toast(p.admin ? '관리자 권한 외부 Windows 콘솔 창에서 열었습니다' : '외부 Windows 콘솔 창에서 열었습니다');
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
    const p = launchParams(kind);
    const t = await api('/api/term/new', { method: 'POST', body: p });
    if (t.error) return toast(t.error, 6000);
    d.close();
    if (t.external) {
      toast(t.admin ? '관리자 권한 외부 Windows 콘솔 창에서 열었습니다' : '외부 Windows 콘솔 창에서 열었습니다');
      setTimeout(refreshOverview, 1200);
      return;
    }
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
      <p class="empty" style="text-align:center;margin-top:6px">QR 주소: <span class="mono">${esc(r.urls[0] || '')}</span></p>
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
function currentViewCwd() {
  const s = state.sel || {};
  if (s.kind === 'term') return state.terms.find((x) => String(x.id) === String(s.id))?.cwd || '';
  if (s.kind === 'recent' || s.kind === 'session') return recentSession(s.id)?.cwd || '';
  if (s.kind === 'projects') return (state.projects || []).find((x) => x.id === s.id)?.cwd || '';
  return '';
}
$('#btnSideNew').onclick = () => openNewTermDrawer(currentViewCwd());
$('#mBtnNew').onclick = () => openNewTermDrawer(currentViewCwd());
$('#btnSideCollapse').onclick = () => setSideCollapsed(true);
$('#btnSideReopen').onclick = () => setSideCollapsed(false);
function setSidebarOpen(open) {
  const button = $('#btnMenu');
  if (!open && document.body.classList.contains('drawer') && $('.side').contains(document.activeElement)) button.focus();
  document.body.classList.toggle('drawer', open);
  button.setAttribute('aria-expanded', String(open));
  if (open) $('#brandHome').focus();
}
$('#btnMenu').onclick = () => setSidebarOpen(!document.body.classList.contains('drawer'));
$('#backdrop').onclick = () => setSidebarOpen(false);
$('.side').addEventListener('keydown', e => {
  if (e.key === 'Escape' && !e.defaultPrevented && document.body.classList.contains('drawer')) setSidebarOpen(false);
});
matchMedia('(max-width: 760px)').addEventListener('change', () => setSidebarOpen(false));
$('#btnTheme').onclick = () => cycleTheme();
$('#btnLang').onclick = () => toggleLang();
$('#btnPhone').onclick = () => openPhoneDrawer();
const sideFilterIn = $('#sideFilter');
if (sideFilterIn) {
  sideFilterIn.addEventListener('input', () => { state.sideFilter = sideFilterIn.value; renderSide(); });
  sideFilterIn.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { sideFilterIn.value = ''; state.sideFilter = ''; renderSide(); }
  });
}
const sideResize = $('#sideResize');
if (sideResize) {
  const setSideWidth = (width) => {
    const px = Math.max(248, Math.min(380, Math.round(width)));
    document.documentElement.style.setProperty('--side-w', `${px}px`);
    sideResize.setAttribute('aria-valuenow', String(px));
    return px;
  };
  const saveSideWidth = () => {
    try { localStorage.setItem('ach-side-width', sideResize.getAttribute('aria-valuenow')); } catch {}
    window.dispatchEvent(new Event('resize'));
  };
  const currentWidth = () => sideResize.parentElement.getBoundingClientRect().width;
  try {
    const saved = Number(localStorage.getItem('ach-side-width'));
    if (saved >= 248 && saved <= 380) setSideWidth(saved);
  } catch {}
  sideResize.addEventListener('focus', () => sideResize.setAttribute('aria-valuenow', String(Math.round(currentWidth()))));
  sideResize.onpointerdown = (e) => {
    if (e.button !== 0) return;
    sideResize.setPointerCapture(e.pointerId);
    sideResize.classList.add('dragging');
  };
  sideResize.onpointermove = (e) => { if (sideResize.hasPointerCapture(e.pointerId)) setSideWidth(e.clientX); };
  sideResize.onlostpointercapture = () => { sideResize.classList.remove('dragging'); saveSideWidth(); };
  sideResize.onkeydown = (e) => {
    const width = currentWidth();
    const next = { ArrowLeft: width - 20, ArrowRight: width + 20, Home: 248, End: 380 }[e.key];
    if (next == null) return;
    e.preventDefault();
    setSideWidth(next);
    saveSideWidth();
  };
}
$('#btnSideMore').onclick = (e) => {
  e.stopPropagation();
  openMoreMenu(e.currentTarget, [
    {
      label: desktopInvoke
        ? (state.notifyEnabled ? '✓ 작업 완료·확인 필요 알림 켜짐' : '작업 완료·확인 필요 알림 켜기')
        : (state.notifyEnabled ? '✓ 작업 완료 데스크톱 알림 켜짐' : '작업 완료 데스크톱 알림 켜기'),
      icon: ICO.bell,
      onClick: async () => {
        if (!desktopInvoke && !state.notifyEnabled && typeof Notification !== 'undefined' && Notification.permission === 'default') {
          await Notification.requestPermission().catch(() => {});
        }
        state.notifyEnabled = !state.notifyEnabled;
        try { localStorage.setItem('ach-notify', state.notifyEnabled ? '1' : '0'); } catch {}
        toast(desktopInvoke
          ? (state.notifyEnabled ? '작업 완료·확인 필요 알림을 켰습니다' : '작업 완료·확인 필요 알림을 껐습니다')
          : (state.notifyEnabled ? '작업 완료 알림을 켰습니다' : '작업 완료 알림을 껐습니다'));
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
function selectionFromHash() {
  const hm = /^#([a-z-]+)(?::([^:]+)(?::([a-z]+)(?::(\d+\.\d+\.\d+))?)?)?$/.exec(location.hash || '');
  const version = hm?.[1] === 'projects' && hm[4];
  return hm ? { sel: { kind: hm[1], ...(hm[2] ? { id: hm[2] } : {}), ...(version ? { version } : {}) }, tab: hm[3] || undefined } : null;
}

function terminalExists(id) {
  return state.terms.some((t) => String(t.id) === String(id));
}

if (desktopInvoke) window.addEventListener('hashchange', () => {
  if (!booted || !/^#term:[1-9][0-9]{0,15}$/.test(location.hash)) return;
  const { sel } = selectionFromHash();
  select(terminalExists(sel.id) ? sel : { kind: 'home' });
});

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
  else if (open === 'schedules') select({ kind: 'schedules' });
  else if (open === 'apps') select({ kind: 'apps' });
  else if (open.startsWith('switch:')) { const sid = open.slice(7); select({ kind: 'recent', id: sid }); setTimeout(() => openSwitch(sid), 900); } // from the phone alert
  else if (open === 'gpu') select({ kind: 'gpu' });
  else if (open === 'vault') select({ kind: 'vault' });
  else if (open === 'operator') select({ kind: 'operator' });
  else if (open.startsWith('research:')) { state.rtab = { [open.slice(9)]: qs.get('tab') || 'overview' }; select({ kind: 'research', id: open.slice(9) }); }
  else if (qs.get('q')) { runSearch(qs.get('q')); }
  else {
    let restored = null;
    try {
      const fromHash = selectionFromHash();
      const previous = JSON.parse(localStorage.getItem('ach-last-sel') || 'null');
      if (fromHash?.sel.kind === 'term' && previous?.sel?.kind === 'term' && previous.sel.id === fromHash.sel.id) {
        fromHash.sel = { ...previous.sel, ...fromHash.sel };
      }
      const saved = fromHash || previous;
      const s = saved?.sel;
      if (s && ['home', 'terms', 'projects', 'usage', 'calendar', 'schedules', 'apps', 'gpu', 'vault', 'operator', 'trusted-folders', 'recent', 'research'].includes(s.kind)) restored = saved;
      else if (s?.kind === 'term' && terminalExists(s.id)) restored = saved;
      else if (s?.kind === 'console' && state.consoles.some((c) => String(c.id) === String(s.id))) restored = saved;
    } catch {}
    if (restored) select(restored.sel, restored.tab);
    else select({ kind: 'home' });
  }
  setInterval(() => {
    if (!document.hidden || (desktopInvoke && state.notifyEnabled)) refreshOverview();
  }, 4000);
  setInterval(whenShown(refreshRecent), 10000);
})();
