// ---------- Sidebar Navigation Tree ----------
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

  // Section 2: Unified Recent Conversations & Active Terminals (live sessions float to top with 실행 중 / 완료 / 대기 tags; deduplicated by sessionId)
  const cons = sortConsolesByState(visibleConsoles()).filter((c) => matchSide(consoleLabel(c), '콘솔'));
  const terms = sortTermsByState(state.terms || []).filter((t) => matchSide(termLabel(t), t.cwd || '', projectOfTerm(t)?.name || '', t.agent || ''));
  const rf = state.recentFilter || '';
  const fbtn = (val, label, cnt = 0) => `<button data-rfilt="${val}" class="${rf === val ? 'on' : ''}">${label}${cnt ? ` <span class="seg-cnt">${cnt}</span>` : ''}</button>`;

  const liveBySid = new Map((state.live || []).filter((x) => x.sessionId).map((x) => [x.sessionId, x]));
  const busyCount = terms.filter((t) => termStateOf(t) === 'busy').length + cons.filter((c) => consoleStateOf(c) === 'busy').length;
  const exitedCount = terms.filter((t) => termStateOf(t) === 'exited').length;
  const activeTermCount = terms.filter((t) => termStateOf(t) !== 'exited').length + cons.length;

  const seenSids = new Set();
  for (const t of state.terms || []) {
    if (t.sessionId) seenSids.add(t.sessionId);
  }
  for (const c of visibleConsoles()) {
    const cs = sessionOfConsole(c);
    if (cs?.sessionId) seenSids.add(cs.sessionId);
  }

  const shownTerms = terms.filter((t) => {
    if (rf === 'live') return termStateOf(t) !== 'exited';
    if (rf === 'claude' || rf === 'codex' || rf === 'agy') return (t.agent || '') === rf;
    return true;
  });
  const shownCons = cons.filter((c) => {
    if (!rf || rf === 'live') return true;
    const cs = sessionOfConsole(c);
    return (cs?.agent || '') === rf;
  });
  const recentMap = new Map((state.recent || []).map((r) => [r.sessionId, r]));
  const combinedLive = [
    ...shownTerms.map((t) => ({ kind: 'term', rank: SIDE_LIVE_RANK[termStateOf(t)] ?? 9, item: t })),
    ...shownCons.map((c) => ({ kind: 'console', rank: SIDE_LIVE_RANK[consoleStateOf(c)] ?? 9, item: c })),
  ];

  const recSourceKey = (rf && rf !== 'live') ? rf : '';
  const unlinkedRecent = (state.recentByAgent?.[recSourceKey] || state.recent)
    .filter((r) => {
      if (seenSids.has(r.sessionId)) return false;
      if (!matchSide(sessionLabel(r), r.cwd || '', r.agent || '')) return false;
      if (rf === 'live') return liveBySid.has(r.sessionId);
      if (rf && (r.agent || 'claude') !== rf) return false;
      return true;
    })
    .slice(0, 18)
    .map((r) => {
      const lp = liveBySid.get(r.sessionId);
      const rank = lp ? 0 : 9;
      return { kind: 'recent', rank, item: r };
    });

  const unifiedEntries = [...combinedLive, ...unlinkedRecent].sort((a, b) => compareUnifiedEntries(a, b, recentMap));
  const liveCount = activeTermCount + (state.recent || []).filter((r) => !seenSids.has(r.sessionId) && liveBySid.has(r.sessionId)).length;

  const sideLiveStateTag = (st, unread = false) => (
    st === 'busy'
      ? '<span class="srow-tag busy">실행 중</span>'
      : unread
        ? '<span class="srow-tag done">완료</span>'
        : st === 'exited'
          ? '<span class="srow-tag">종료됨</span>'
          : '<span class="srow-tag idle">대기</span>'
  );

  const renderUnifiedRow = (entry, hidePjTag = false) => {
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
        sideLiveStateTag(st, unread),
        st !== 'exited' ? `<span>${folderLbl}</span>` : '',
      ].filter(Boolean).join('');
      return `<div class="srow${isSel ? ' sel' : ''}${unread ? ' just-done' : ''}${isBr ? ' is-branch' : ''}" data-key="term:${esc(t.id)}" title="${esc(termLabel(t))}${pj ? ` · Project: ${esc(pj.name)}` : ''}${brTip ? ` · ${esc(brTip)}` : ''}">
        ${agentIcon(kind, dot)}
        <div class="srow-main"><div class="srow-t">${esc(termLabel(t))}</div><div class="srow-s">${tags}</div></div>
        <span class="srow-end">${unread ? '<span class="srow-unread" title="방금 작업 완료"></span>' : ''}${fk ? `<span class="fav${isStar ? ' on' : ''}" data-fav="${esc(fk)}" role="button" tabindex="0" aria-label="${isStar ? '즐겨찾기 해제' : '즐겨찾기'}">${isStar ? ICO.starFill : ICO.star}</span>` : ''}</span>
      </div>`;
    }
    if (entry.kind === 'console') {
      const c = entry.item;
      const st = consoleStateOf(c);
      const cs = sessionOfConsole(c);
      const isSel = curKind === 'console' && String(state.sel.id) === String(c.id);
      return `<div class="srow${isSel ? ' sel' : ''}" data-key="console:${esc(c.id)}">
        ${agentIcon(cs ? (cs.agent || 'claude') : 'shell', st === 'busy' ? 'busy' : 'idle')}
        <div class="srow-main"><div class="srow-t">${esc(consoleLabel(c))}</div><div class="srow-s"><span class="srow-tag con">콘솔</span>${sideLiveStateTag(st)}</div></div>
      </div>`;
    }
    const r = entry.item;
    const ag = r.agent || 'claude';
    const fk = `sid:${r.sessionId}`, on = favs.has(fk);
    const isSel = curKind === 'recent' && state.sel.id === r.sessionId;
    const isBr = !!r.branch?.isBranch;
    const brTip = branchTooltip(r.branch);
    const liveProc = liveBySid.get(r.sessionId);
    const liveDot = liveProc ? (liveProc.status === 'busy' ? 'busy' : 'idle') : null;
    const delRecTitle = '기록 삭제';
    const delRecAria = `기록 삭제: ${sessionLabel(r)}`;
    const subHTML = [
      branchTagHTML(r.branch, true),
      liveProc ? sideLiveStateTag(liveProc.status === 'busy' ? 'busy' : 'idle') : '',
      `<span>${esc([base(r.cwd), ago(r.mtime)].filter(Boolean).join(' · '))}</span>`,
    ].filter(Boolean).join('');
    return `<div class="srow${isSel ? ' sel' : ''}${isBr ? ' is-branch' : ''}" data-key="recent:${esc(r.sessionId)}" title="${esc(sessionLabel(r))}${brTip ? ` · ${esc(brTip)}` : ''}">
      ${agentIcon(ag, liveDot)}
      <div class="srow-main"><div class="srow-t">${esc(sessionLabel(r))}</div><div class="srow-s">${subHTML}</div></div>
      <span class="srow-end">
        <span class="fav${on ? ' on' : ''}" data-fav="${esc(fk)}" role="button" tabindex="0" aria-label="${on ? '즐겨찾기 해제' : '즐겨찾기'}">${on ? ICO.starFill : ICO.star}</span>
        <button class="record-delete danger ghost icon-btn" data-hide-record="${esc(r.sessionId)}" title="${delRecTitle}" aria-label="${esc(delRecAria)}">${ICO.trash}</button>
      </span>
    </div>`;
  };

  const recFolded = folded.has('recent') && !fTerms.length;
  let recentRows = '';
  if (!recFolded) {
    if (!unifiedEntries.length) {
      recentRows = `<div class="srow-empty">${rf === 'live' ? '활성 대화 · 터미널 없음' : '최근 기록 없음'}</div>`;
    } else if (state.termGroupByProject) {
      const groups = new Map();
      for (const entry of unifiedEntries) {
        const pj = entry.kind === 'term' ? projectOfTerm(entry.item) : null;
        const gKey = pj ? `pj:${pj.id}` : '_general';
        const gLabel = pj ? pj.name : '일반 대화 · 터미널';
        if (!groups.has(gKey)) groups.set(gKey, { label: gLabel, isPj: !!pj, items: [] });
        groups.get(gKey).items.push(entry);
      }
      recentRows = [...groups.values()].map((g) => `<div class="sgrp-lbl">${g.isPj ? '<span class="pj-dot"></span>' : ''}${esc(g.label)}</div>${g.items.map((e) => renderUnifiedRow(e, g.isPj)).join('')}`).join('');
    } else {
      recentRows = unifiedEntries.map((e) => renderUnifiedRow(e, false)).join('');
    }
  }

  const cleanExitedAria = '종료된 터미널 정리';
  const cleanExitedTitle = `종료된 터미널 정리 (${exitedCount})`;
  const groupProjLbl = 'Project별 묶어보기';
  h += `<div class="ssec">
    <div class="ssec-hd">
      ${foldBtnHTML('recent', recFolded, isEnUI() ? 'Sessions' : '목록')}
      <span class="ssec-title" data-key="terms-recent" title="전체 목록 보기">대화 기록 ${liveCount ? `<span class="srow-meta">${liveCount}</span>` : ''}${recFolded && busyCount ? `<span class="srow-tag busy">실행 ${busyCount}</span>` : ''}</span>
      ${exitedCount ? `<button class="ghost icon-btn ssec-act" data-side-clean-exited="1" title="${cleanExitedTitle}" aria-label="${cleanExitedAria}">${ICO.trash}</button>` : ''}
      <button class="ghost icon-btn ssec-act${state.termGroupByProject ? ' on' : ''}" data-tgroup="1" title="${groupProjLbl}" aria-pressed="${state.termGroupByProject}" aria-label="${groupProjLbl}">${ICO.layers}</button>
      <button class="ghost icon-btn ssec-act" data-rrefresh="1" title="세션 기록 새로고침" aria-label="세션 기록 새로고침">${ICO.refresh}</button>
      <button class="ghost icon-btn ssec-act" data-hopen-new="1" title="새 대화 · 터미널 열기" aria-label="새 대화 · 터미널 열기">${ICO.plus}</button>
    </div>
    ${recFolded ? '' : `<div class="seg sm" role="tablist" aria-label="대화 · 상태 필터">${fbtn('', '전체')}${fbtn('live', '활성', liveCount)}${fbtn('claude', 'Claude')}${fbtn('codex', 'Codex')}${fbtn('agy', 'AGY')}</div>${recentRows}`}
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
  if (rfBtn) {
    e.stopPropagation();
    state.recentFilter = rfBtn.dataset.rfilt;
    renderSide();
    if (state.recentFilter !== 'live') refreshRecent();
    return;
  }
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
