// ---------- Custom Session Groups Helpers ----------
const SGRP_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#64748b'];
let isSideDragging = false;
let pendingSideRender = false;
let sideDragPayload = null;

function getSessionGroupsData() {
  const sg = state.sessionGroups;
  return {
    groups: Array.isArray(sg?.groups) ? sg.groups : [],
    assignments: sg?.assignments && typeof sg.assignments === 'object' ? sg.assignments : {},
    groupOrders: sg?.groupOrders && typeof sg.groupOrders === 'object' ? sg.groupOrders : {},
  };
}

function sortEntriesForBucket(entries, bucketKey, sgData, recentMap) {
  const order = sgData.groupOrders?.[bucketKey];
  if (!Array.isArray(order) || !order.length) return entries;
  const idxMap = new Map(order.map((k, i) => [k, i]));
  const rankOf = (entry) => {
    let best = Infinity;
    for (const k of sessionKeysForEntry(entry)) {
      const idx = idxMap.get(k);
      if (idx !== undefined && idx < best) best = idx;
    }
    return best;
  };
  return [...entries].sort((a, b) => {
    const ra = rankOf(a);
    const rb = rankOf(b);
    if (ra !== rb) return ra - rb;
    return compareSideEntries(a, b, recentMap);
  });
}

function sessionKeysForEntry(entry) {
  if (!entry) return [];
  if (entry.kind === 'term') {
    const t = entry.item;
    return [t?.sessionId ? `sid:${t.sessionId}` : '', t?.id != null ? `term:${t.id}` : ''].filter(Boolean);
  }
  if (entry.kind === 'recent') {
    return entry.item?.sessionId ? [`sid:${entry.item.sessionId}`] : [];
  }
  if (entry.kind === 'console') {
    const cs = sessionOfConsole(entry.item);
    return cs?.sessionId ? [`sid:${cs.sessionId}`] : [];
  }
  return [];
}

function sessionKeysForSidebarKey(dataKey) {
  const k = String(dataKey || '');
  if (k.startsWith('term:')) {
    const tid = k.slice(5);
    const t = (state.terms || []).find((x) => String(x.id) === tid);
    return [t?.sessionId ? `sid:${t.sessionId}` : '', `term:${tid}`].filter(Boolean);
  }
  if (k.startsWith('recent:')) {
    const sid = k.slice(7);
    const lt = (state.terms || []).find((x) => x.sessionId === sid);
    return [`sid:${sid}`, lt ? `term:${lt.id}` : ''].filter(Boolean);
  }
  return [];
}

function groupOfSessionKeys(keys, sg = getSessionGroupsData()) {
  for (const k of keys) {
    const gid = sg.assignments[k];
    if (gid) {
      const grp = sg.groups.find((g) => g.id === gid);
      if (grp) return grp;
    }
  }
  return null;
}

async function mutateSessionGroups(body) {
  const r = await api('/api/session-groups', { method: 'POST', body, requireOk: true });
  if (r.sessionGroups) state.sessionGroups = r.sessionGroups;
  renderSide();
  return r;
}

function openSessionGroupAssignMenu(anchorBtn, dataKey) {
  const keys = sessionKeysForSidebarKey(dataKey);
  if (!keys.length) return;
  const sg = getSessionGroupsData();
  const curGrp = groupOfSessionKeys(keys, sg);
  const items = [];
  for (const g of sg.groups) {
    const isCur = curGrp?.id === g.id;
    items.push({
      label: isCur ? `✓ ${g.name}` : g.name,
      icon: `<span class="sgrp-dot" style="background:${esc(g.color)}"></span>`,
      onClick: async () => {
        try {
          await mutateSessionGroups({ action: 'assign', keys, groupId: isCur ? '' : g.id });
          toast(isCur ? '세션을 그룹에서 해제했습니다' : `“${g.name}” 그룹으로 이동했습니다`);
        } catch (er) { toast(er.message, 4000, 'danger'); }
      },
    });
  }
  if (curGrp) {
    items.push({
      label: '그룹 해제 (미분류)',
      icon: ICO.close,
      onClick: async () => {
        try {
          await mutateSessionGroups({ action: 'assign', keys, groupId: '' });
          toast('세션을 미분류로 이동했습니다');
        } catch (er) { toast(er.message, 4000, 'danger'); }
      },
    });
  }
  if (items.length) items.push({ divider: true });
  items.push({
    label: '새 그룹 만들고 이동…',
    icon: ICO.plus,
    onClick: async () => {
      const name = prompt('새 세션 그룹 이름을 입력하세요:');
      if (!name || !name.trim()) return;
      try {
        const r = await mutateSessionGroups({ action: 'create', name: name.trim(), keys });
        toast(`“${r.group.name}” 그룹을 만들고 세션을 이동했습니다`);
      } catch (er) { toast(er.message, 4000, 'danger'); }
    },
  });
  items.push({
    label: '세션 그룹 관리…',
    icon: ICO.settings,
    onClick: () => openSessionGroupModal(),
  });
  openMoreMenu(anchorBtn, items);
}

function openSessionGroupModal(focusGroupId = '') {
  const dlg = document.createElement('dialog');
  dlg.className = 'pj-dialog';
  dlg.style.width = 'min(540px, 94vw)';
  dlg.setAttribute('aria-label', '세션 그룹 관리');
  let pickedColor = SGRP_COLORS[getSessionGroupsData().groups.length % SGRP_COLORS.length];
  let expandedGroupId = focusGroupId || '';

  const collectGeneralSessions = () => {
    const out = [];
    const seenSid = new Set();
    for (const t of sortTermsByState(state.terms || [])) {
      if (t.operator || isProjectSubSession(t)) continue;
      if (t.sessionId) seenSid.add(t.sessionId);
      out.push({
        keys: [t.sessionId ? `sid:${t.sessionId}` : '', `term:${t.id}`].filter(Boolean),
        label: termLabel(t),
        sub: [t.agent || 'shell', base(t.cwd)].filter(Boolean).join(' · '),
      });
    }
    for (const r of (state.recent || []).slice(0, 30)) {
      if (seenSid.has(r.sessionId) || isProjectSubRecent(r)) continue;
      out.push({
        keys: [`sid:${r.sessionId}`],
        label: sessionLabel(r),
        sub: [r.agent || 'claude', base(r.cwd), ago(r.mtime)].filter(Boolean).join(' · '),
      });
    }
    return out;
  };

  const paint = () => {
    const sg = getSessionGroupsData();
    const generalSessions = collectGeneralSessions();
    const countFor = (gid) => generalSessions.filter((s) => groupOfSessionKeys(s.keys, sg)?.id === gid).length;
    const swatches = SGRP_COLORS.map((c) => `<button type="button" class="sgrp-swatch${pickedColor === c ? ' on' : ''}" data-sgrp-color="${c}" style="background:${c}" aria-label="${c}"></button>`).join('');
    const listHtml = sg.groups.length
      ? sg.groups.map((g) => {
        const isExp = expandedGroupId === g.id;
        const cnt = countFor(g.id);
        const membersHtml = isExp
          ? `<div class="sgrp-assign-list">${generalSessions.length
            ? generalSessions.map((s, idx) => {
              const cur = groupOfSessionKeys(s.keys, sg);
              const checked = cur?.id === g.id;
              return `<label class="sgrp-assign-row">
                <input type="checkbox" data-assign-idx="${idx}" data-assign-gid="${esc(g.id)}" ${checked ? 'checked' : ''}>
                <span class="sgrp-assign-main"><b>${esc(s.label)}</b><small>${esc(s.sub)}${cur && cur.id !== g.id ? ` · 현재: ${esc(cur.name)}` : ''}</small></span>
              </label>`;
            }).join('')
            : '<div class="ums">배치할 일반 세션이 없습니다.</div>'}</div>`
          : '';
        return `<div class="sgrp-mgr-card"${g.hidden ? ' style="opacity:.72"' : ''}>
          <div class="sgrp-mgr-row">
            <span class="sgrp-dot" style="background:${esc(g.color)}"></span>
            <b class="sgrp-mgr-name">${esc(g.name)}</b>
            <span class="badge">${cnt}개</span>
            ${g.hidden ? '<span class="badge warn">숨김</span>' : ''}
            <div class="row" style="gap:4px;margin-left:auto">
              <button type="button" class="btn-sm${g.hidden ? ' primary' : ''}" data-mgr-hide="${esc(g.id)}">${g.hidden ? '보이기' : '숨기기'}</button>
              <button type="button" class="btn-sm${isExp ? ' primary' : ''}" data-mgr-members="${esc(g.id)}">세션 배치</button>
              <button type="button" class="btn-sm" data-mgr-rename="${esc(g.id)}">이름 변경</button>
              <button type="button" class="btn-sm danger" data-mgr-del="${esc(g.id)}">삭제</button>
            </div>
          </div>
          ${membersHtml}
        </div>`;
      }).join('')
      : '<div class="empty" style="padding:18px;text-align:center">아직 만든 세션 그룹이 없습니다. 위에서 그룹을 추가해 일반 세션을 묶어 관리해 보세요.</div>';

    dlg.innerHTML = `<div style="display:flex;flex-direction:column;gap:12px">
      <div class="dlg-head">
        <h3 style="margin:0">일반 세션 그룹 관리</h3>
        <button type="button" class="ghost icon-btn btn-sm" data-sgrp-close aria-label="닫기">${ICO.close}</button>
      </div>
      <form id="sgrpCreateForm" style="display:flex;flex-direction:column;gap:8px;padding:12px;border:1px solid var(--line);border-radius:var(--radius-md);background:var(--bg)">
        <div style="display:flex;gap:6px">
          <input id="sgrpNewName" class="btn-sm" style="flex:1" maxlength="60" placeholder="새 그룹 이름 (예: 운영·모니터링, 실험, 리서치)">
          <button type="submit" class="primary btn-sm">${ICO.plus} 그룹 추가</button>
        </div>
        <div style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted)">
          <span>색상</span>
          <div class="sgrp-swatches">${swatches}</div>
        </div>
      </form>
      <div class="sgrp-mgr-list">${listHtml}</div>
    </div>`;

    $('[data-sgrp-close]', dlg).onclick = () => dlg.close();
    dlg.querySelectorAll('[data-sgrp-color]').forEach((b) => {
      b.onclick = () => { pickedColor = b.dataset.sgrpColor; paint(); };
    });
    $('#sgrpCreateForm', dlg).onsubmit = async (ev) => {
      ev.preventDefault();
      const name = $('#sgrpNewName', dlg).value.trim();
      if (!name) return toast('그룹 이름을 입력하세요');
      try {
        const r = await mutateSessionGroups({ action: 'create', name, color: pickedColor });
        expandedGroupId = r.group.id;
        pickedColor = SGRP_COLORS[getSessionGroupsData().groups.length % SGRP_COLORS.length];
        toast(`“${r.group.name}” 그룹을 추가했습니다`);
        paint();
      } catch (er) { toast(er.message, 4000, 'danger'); }
    };
    dlg.querySelectorAll('[data-mgr-hide]').forEach((b) => {
      b.onclick = async () => {
        const id = b.dataset.mgrHide;
        const g = getSessionGroupsData().groups.find((x) => x.id === id);
        if (!g) return;
        const nextHidden = !g.hidden;
        try {
          await mutateSessionGroups({ action: 'toggle-hidden', id, hidden: nextHidden });
          toast(nextHidden ? `“${g.name}” 그룹을 숨겼습니다` : `“${g.name}” 그룹을 다시 표시합니다`);
          paint();
        } catch (er) { toast(er.message, 4000, 'danger'); }
      };
    });
    dlg.querySelectorAll('[data-mgr-members]').forEach((b) => {
      b.onclick = () => {
        const id = b.dataset.mgrMembers;
        expandedGroupId = expandedGroupId === id ? '' : id;
        paint();
      };
    });
    dlg.querySelectorAll('[data-mgr-rename]').forEach((b) => {
      b.onclick = async () => {
        const id = b.dataset.mgrRename;
        const g = getSessionGroupsData().groups.find((x) => x.id === id);
        if (!g) return;
        const next = prompt('새 그룹 이름:', g.name);
        if (!next || !next.trim() || next.trim() === g.name) return;
        try {
          await mutateSessionGroups({ action: 'rename', id, name: next.trim() });
          toast('그룹 이름을 변경했습니다');
          paint();
        } catch (er) { toast(er.message, 4000, 'danger'); }
      };
    });
    dlg.querySelectorAll('[data-mgr-del]').forEach((b) => {
      b.onclick = async () => {
        const id = b.dataset.mgrDel;
        const g = getSessionGroupsData().groups.find((x) => x.id === id);
        if (!g || !confirm(`“${g.name}” 그룹을 삭제할까요? (포함된 세션은 미분류로 이동되며 삭제되지 않습니다)`)) return;
        try {
          await mutateSessionGroups({ action: 'delete', id });
          if (expandedGroupId === id) expandedGroupId = '';
          toast('그룹을 삭제했습니다');
          paint();
        } catch (er) { toast(er.message, 4000, 'danger'); }
      };
    });
    dlg.querySelectorAll('[data-assign-idx]').forEach((chk) => {
      chk.onchange = async () => {
        const item = generalSessions[Number(chk.dataset.assignIdx)];
        const gid = chk.dataset.assignGid;
        if (!item) return;
        try {
          await mutateSessionGroups({ action: 'assign', keys: item.keys, groupId: chk.checked ? gid : '' });
          paint();
        } catch (er) {
          toast(er.message, 4000, 'danger');
          paint();
        }
      };
    });
  };

  document.body.append(dlg);
  dlg.onclose = () => dlg.remove();
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  paint();
  dlg.showModal();
  $('#sgrpNewName', dlg)?.focus();
}

// ---------- Sidebar Navigation Tree ----------
const SIDE_ORDER_ICO = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 4v16M3 16l4 4 4-4"/><path d="M14 6h7M14 12h5M14 18h3"/></svg>';
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

function sideLiveStateTag(st, dormant = false) {
  if (st === 'busy') return '<span class="srow-tag srow-status busy">실행 중</span>';
  if (st === 'exited') return '<span class="srow-tag">종료됨</span>';
  if (dormant) return '<span class="srow-tag srow-status dormant" title="1시간 이상 입력·출력 활동 없음">유휴</span>';
  return '<span class="srow-tag srow-status waiting">대기</span>';
}

function renderSide() {
  const liveBySid = new Map((state.live || []).filter((x) => x.sessionId).map((x) => [x.sessionId, x]));
  if (isSideDragging) { pendingSideRender = true; return; }
  const side = $('#side');
  if (!side) return;
  const prevTop = side.scrollTop;
  const prevHistoryTop = $('.side-history', side)?.scrollTop || 0;
  const focusedNav = side.contains(document.activeElement) && document.activeElement.closest('.snav-item')?.dataset.key;
  const focusedControl = side.contains(document.activeElement) && document.activeElement.closest('.srow-open, .folder-badge');
  const focusedSession = focusedControl?.closest?.('[data-key]')?.dataset.key;
  const folded = sideFolded();
  const curKind = state.sel.kind;
  const isSys = ['appearance', 'usage', 'gpu', 'vault', 'operator'].includes(curKind);

  const calItems = ((typeof CAL !== 'undefined' && CAL?.data?.items) || []).filter((x) => !(x.kind === 'task' && x.done));
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const overN = calItems.filter((x) => x.kind === 'task' && !x.done && x.date < today).length;
  const gpuWait = state.gpu?.waiting?.length || 0;
  const sysAlert = gpuWait > 0;

  const fTerms = termsOf(state.sideFilter);
  const matchSide = (...parts) => !fTerms.length || fTerms.every((q) => parts.join(' ').toLowerCase().includes(q));

  const navigation = `<nav class="snav" aria-label="주요 메뉴">
    <button type="button" class="snav-item${curKind === 'home' ? ' sel' : ''}" data-key="home">${ICO.home}<span class="snav-lbl">홈</span></button>
    <button type="button" class="snav-item${curKind === 'search' ? ' sel' : ''}" data-key="cmdk" aria-haspopup="dialog">${ICO.search}<span class="snav-lbl">빠른 이동 · 검색</span><span class="snav-kbd">Ctrl K</span></button>
    <button type="button" class="snav-item${isSys ? ' sel' : ''}" data-key="system">${ICO.settings}<span class="snav-lbl">설정</span>${sysAlert ? '<span class="snav-dot danger" title="확인할 항목 있음"></span>' : ''}</button>
    <button type="button" class="snav-item${curKind === 'calendar' ? ' sel' : ''}" data-key="calendar">${ICO.calendar}<span class="snav-lbl">캘린더</span>${overN ? '<span class="snav-dot danger" title="기한 지난 할 일 있음"></span>' : ''}</button>
    <button type="button" class="snav-item${curKind === 'schedules' ? ' sel' : ''}" data-key="schedules">${ICO.clock || ICO.calendar}<span class="snav-lbl">스케줄</span></button>
    <button type="button" class="snav-item${curKind === 'apps' ? ' sel' : ''}" data-key="apps">${ICO.grid}<span class="snav-lbl">Apps</span></button>
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
        const meta = termStatusMeta(t);
        const isSel = curKind === 'term' && String(state.sel.id) === String(t.id);
        const unread = state.unreadTerms.has(String(t.id));
        const isBr = !!t.branch?.isBranch;
        const favAliasKeys = [...new Set([...(entry.allKeys || [fk]), t.sessionId ? `sid:${t.sessionId}` : '', `term:${t.id}`].filter(Boolean))];
        favRowsArr.push(`<div class="srow${isSel ? ' sel' : ''}${unread ? ' just-done' : ''}" data-key="term:${esc(t.id)}"${isBr ? ` title="${esc(branchTooltip(t.branch))}"` : ''}>
          ${agentIcon(t.operator ? 'operator' : t.agent || 'shell', meta.dot)}
          <div class="srow-main"><div class="srow-t">${esc(termLabel(t))}</div><div class="srow-s">${sideLiveStateTag(meta.state, meta.dormant)}</div></div>
          <span class="srow-end">${branchTagHTML(t.branch, true)}${unread ? '<span class="srow-tag done">완료</span>' : ''}<span class="fav on" data-fav="${esc(fk)}" data-fav-keys="${esc(favAliasKeys.join(','))}" role="button" tabindex="0" aria-label="즐겨찾기 해제">${ICO.starFill}</span></span>
        </div>`);
      } else if (entry.kind === 'sid') {
        const sid = entry.sid;
        const r = entry.item;
        const lbl = r ? sessionLabel(r) : sid.slice(0, 8);
        if (!matchSide(lbl, r?.cwd || '')) continue;
        const isSel = curKind === 'recent' && state.sel.id === sid;
        const isBr = !!r?.branch?.isBranch;
        const live = liveBySid.get(sid);
        const dot = live ? (live.status === 'busy' ? 'busy' : 'idle') : null;
        favRowsArr.push(`<div class="srow${isSel ? ' sel' : ''}" data-key="recent:${esc(sid)}"${isBr ? ` title="${esc(branchTooltip(r.branch))}"` : ''}>
          ${agentIcon(r?.agent || 'claude', dot)}
          <div class="srow-main"><div class="srow-t">${esc(lbl)}</div><div class="srow-s">${dot ? sideLiveStateTag(dot) : `<span>${esc(r?.mtime ? ago(r.mtime) : '기록')}</span>`}</div></div>
          <span class="srow-end">${branchTagHTML(r?.branch, true)}<span class="fav on" data-fav="${esc(fk)}" role="button" tabindex="0" aria-label="즐겨찾기 해제">${ICO.starFill}</span></span>
        </div>`);
      }
    }
  }
  let favorites = '';
  if (resolvedFavList.length) {
    const favCountLabel = fTerms.length && !favFolded ? `${favRowsArr.length}/${resolvedFavList.length}` : String(resolvedFavList.length);
    favorites = `<div class="ssec">
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
      if (sideOrderMode() === 'stable') return 0;
      const ab = (state.terms || []).some((t) => termStateOf(t) === 'busy' && projectOfTerm(t)?.id === a.id) ? 0 : 1;
      const bb = (state.terms || []).some((t) => termStateOf(t) === 'busy' && projectOfTerm(t)?.id === b.id) ? 0 : 1;
      return ab - bb;
    });
  const pjBusyN = projects.filter((p) => (state.terms || []).some((t) => termStateOf(t) === 'busy' && projectOfTerm(t)?.id === p.id)).length;
  const pjFolded = folded.has('projects') && !fTerms.length;
  const activePid = curKind === 'projects' ? (state.sel.id || (typeof projectId !== 'undefined' ? projectId : '') || projects[0]?.id) : '';
  const pjRows = pjFolded ? '' : (projects.map((p) => {
    const tasks = p.tasks || [];
    const done = tasks.filter((t) => t.stage === 'done').length;
    const total = tasks.length;
    const versions = p.versions || [];
    const workingVer = [...versions].reverse().find((v) => tasks.some((t) => (t.version || '') === v.number && t.stage !== 'done'));
    const ver = workingVer || versions.at(-1) || null;
    const verTasks = ver ? tasks.filter((t) => (t.version || '') === ver.number) : [];
    const verDone = verTasks.filter((t) => t.stage === 'done').length;
    const hasBusy = (state.terms || []).some((t) => termStateOf(t) === 'busy' && projectOfTerm(t)?.id === p.id);
    const isSel = curKind === 'projects' && activePid === p.id;
    const fk = `proj:${p.id}`, isStar = favs.has(fk);
    const metaLabel = ver
      ? (verDone < verTasks.length ? `v${ver.number} · ${verDone}/${verTasks.length}` : `v${ver.number}`)
      : `${done}/${total}`;
    const rowTitle = `${p.name}${ver ? ` · v${ver.number}` : ''} (${done}/${total})`;
    return `<div class="srow${isSel ? ' sel' : ''}" data-key="project:${esc(p.id)}" title="${esc(rowTitle)}">
      <span class="${hasBusy ? 'dot busy' : 'pj-dot'}"></span>
      <div class="srow-main"><div class="srow-t">${esc(p.name)}</div></div>
      <span class="srow-end">
        <span class="fav${isStar ? ' on' : ''}" data-fav="${esc(fk)}" role="button" tabindex="0" aria-label="${isStar ? '즐겨찾기 해제' : '즐겨찾기'}">${isStar ? ICO.starFill : ICO.star}</span>
        ${hasBusy ? `<span class="srow-tag busy">${ver ? `v${esc(ver.number)} · ` : ''}실행 중</span>` : `<span class="srow-meta">${esc(metaLabel)}</span>`}
      </span>
    </div>`;
  }).join('') || `<div class="srow-empty">${fTerms.length ? '필터 일치 항목 없음' : 'Project 없음'}</div>`);
  let h = `${navigation}<div class="ssec">
    <div class="ssec-hd">
      ${foldBtnHTML('projects', pjFolded, 'Project')}
      <span class="ssec-title" data-key="projects">Project <span class="srow-meta">${projects.length || ''}</span>${pjFolded && pjBusyN ? `<span class="srow-tag busy">실행 ${pjBusyN}</span>` : ''}</span>
      <button class="ghost icon-btn ssec-act" data-side-new-project="1" title="새 Project 만들기" aria-label="새 Project 만들기">${ICO.plus}</button>
    </div>
    ${pjRows}
  </div>${favorites}`;

  // Unified Recent Conversations & Active Terminals
  const showProjTerms = !!state.showProjectTerms || !!state.termGroupByProject || !!fTerms.length;
  const allCons = sortConsolesForSide(visibleConsoles()).filter((c) => matchSide(consoleLabel(c), '콘솔'));
  const allTerms = sortTermsForSide(state.terms || [])
    .filter((t) => !isEphemeralTerm(t))
    .filter((t) => matchSide(termLabel(t), t.cwd || '', projectOfTerm(t)?.name || '', t.agent || ''));
  const hiddenProjTerms = showProjTerms ? 0 : allTerms.filter((t) => isProjectSubSession(t)).length;
  const cons = allCons;
  const terms = showProjTerms ? allTerms : allTerms.filter((t) => !isProjectSubSession(t));
  const rf = state.recentFilter || '';
  const fbtn = (val, label, cnt = 0) => `<button data-rfilt="${val}" class="${rf === val ? 'on' : ''}">${label}${cnt ? ` <span class="seg-cnt">${cnt}</span>` : ''}</button>`;

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
  const favShownAbove = !sideFavsInList() && resolvedFavList.length > 0 && !favFolded;
  const favEntryKeys = new Set(favShownAbove ? resolvedFavList.flatMap((e) => [
    ...(e.allKeys || [e.key]),
    e.kind === 'term' ? `term:${e.item.id}` : '',
    e.kind === 'term' && e.item.sessionId ? `sid:${e.item.sessionId}` : '',
  ]).filter(Boolean) : []);
  const notFavAbove = (entry) => !favShownAbove || !sessionKeysForEntry(entry).some((k) => favEntryKeys.has(k));
  const combinedLive = [
    ...shownTerms.map((t) => ({ kind: 'term', rank: SIDE_LIVE_RANK[termStateOf(t)] ?? 9, item: t })),
    ...shownCons.map((c) => ({ kind: 'console', rank: SIDE_LIVE_RANK[consoleStateOf(c)] ?? 9, item: c })),
  ];

  const recSourceKey = (rf && rf !== 'live') ? rf : '';
  const rawRecent = (state.recentByAgent?.[recSourceKey] || state.recent)
    .filter((r) => {
      if (seenSids.has(r.sessionId)) return false;
      if (isEphemeralInternalText(r.firstPrompt || r.title)) return false;
      if (/[\\/]\.hub-worktrees[\\/]|[\\/]hub-project-plan-[\w-]+/i.test(r.cwd || '')) return false;
      if (!matchSide(sessionLabel(r), r.cwd || '', r.agent || '')) return false;
      if (rf === 'live') return liveBySid.has(r.sessionId);
      if (rf && (r.agent || 'claude') !== rf) return false;
      return true;
    });
  const hiddenProjRecent = showProjTerms ? 0 : rawRecent.filter((r) => isProjectSubRecent(r)).length;
  const hiddenProjCount = hiddenProjTerms + hiddenProjRecent;
  const unlinkedRecent = (showProjTerms ? rawRecent : rawRecent.filter((r) => !isProjectSubRecent(r)))
    .slice(0, 18)
    .map((r) => {
      const lp = liveBySid.get(r.sessionId);
      const rank = lp ? 0 : 9;
      return { kind: 'recent', rank, item: r };
    });

  const unifiedEntries = [...combinedLive, ...unlinkedRecent].filter(notFavAbove).sort((a, b) => compareSideEntries(a, b, recentMap));
  const liveCount = activeTermCount + (state.recent || []).filter((r) => !seenSids.has(r.sessionId) && liveBySid.has(r.sessionId) && (showProjTerms || !isProjectSubRecent(r))).length;

  const groupButton = `<button type="button" class="ghost icon-btn side-group-btn" data-side-group title="그룹 지정" aria-label="그룹 지정">${ICO.folder}</button>`;
  const renderUnifiedRow = (entry, bucketKey = '_ungrouped') => {
    const pkey = sessionKeysForEntry(entry)[0] || '';
    const dragAttrs = pkey ? ` data-srow-drag="1" data-srow-bucket="${esc(bucketKey)}" data-srow-pkey="${esc(pkey)}"` : '';
    if (entry.kind === 'term') {
      const t = entry.item;
      const meta = termStatusMeta(t);
      const st = meta.state;
      const dot = meta.dot;
      const kind = t.operator ? 'operator' : t.agent || 'shell';
      const pj = projectOfTerm(t);
      const idStr = String(t.id);
      const isSel = curKind === 'term' && String(state.sel.id) === idStr;
      const unread = state.unreadTerms.has(idStr);
      const fk = favKeyOf(`term:${idStr}`);
      const allFavKeys = [t.sessionId ? `sid:${t.sessionId}` : '', `term:${idStr}`].filter(Boolean);
      const isStar = allFavKeys.some((k) => favs.has(k));
      const subKindTag = t.operator
        ? '<span class="srow-tag">관제</span>'
        : (!t.agent ? '<span class="srow-tag">셸</span>' : '');
      const brTip = branchTooltip(t.branch);
      const tags = [
        sideLiveStateTag(st, meta.dormant),
        unread && st !== 'busy' ? '<span class="srow-tag done">완료</span>' : '',
        branchTagHTML(t.branch, true),
        subKindTag,
      ].filter(Boolean).join('');
      const closeTermBtn = t.operator
        ? ''
        : `<button type="button" class="side-close-term danger ghost icon-btn" data-close-term="${esc(t.id)}" title="${st === 'exited' ? '목록에서 제거' : '세션 종료'}" aria-label="${st === 'exited' ? '목록에서 제거' : '세션 종료'}">${ICO.trash}</button>`;
      return `<div class="srow${isSel ? ' sel' : ''}${unread ? ' just-done' : ''}" data-key="term:${esc(t.id)}"${dragAttrs} title="${esc([termLabel(t), pj?.name, t.cwd, brTip].filter(Boolean).join(' · '))}">
        ${agentIcon(kind, dot)}
        <button type="button" class="ghost srow-main srow-open"><span class="srow-t">${esc(termLabel(t))}</span><span class="srow-s">${tags}</span></button>
        <span class="srow-end">${t.operator ? '' : groupButton}${unread ? '<span class="srow-unread" title="방금 작업 완료"></span>' : ''}${fk ? `<span class="fav${isStar ? ' on' : ''}" data-fav="${esc(fk)}" data-fav-keys="${esc(allFavKeys.join(','))}" role="button" tabindex="0" aria-label="${isStar ? '즐겨찾기 해제' : '즐겨찾기'}">${isStar ? ICO.starFill : ICO.star}</span>` : ''}${closeTermBtn}</span>
      </div>`;
    }
    if (entry.kind === 'console') {
      const c = entry.item;
      const st = consoleStateOf(c);
      const cs = sessionOfConsole(c);
      const isSel = curKind === 'console' && String(state.sel.id) === String(c.id);
      return `<div class="srow${isSel ? ' sel' : ''}" data-key="console:${esc(c.id)}">
        ${agentIcon(cs ? (cs.agent || 'claude') : 'shell', st === 'busy' ? 'busy' : 'idle')}
        <button type="button" class="ghost srow-main srow-open"><span class="srow-t">${esc(consoleLabel(c))}</span><span class="srow-s">${sideLiveStateTag(st)}<span class="srow-tag con">콘솔</span></span></button>
      </div>`;
    }
    const r = entry.item;
    const ag = r.agent || 'claude';
    const fk = `sid:${r.sessionId}`, on = favs.has(fk);
    const isSel = curKind === 'recent' && state.sel.id === r.sessionId;
    const brTip = branchTooltip(r.branch);
    const liveProc = liveBySid.get(r.sessionId);
    const liveDot = liveProc ? (liveProc.status === 'busy' ? 'busy' : 'idle') : null;
    const delRecTitle = '기록 삭제';
    const delRecAria = `기록 삭제: ${sessionLabel(r)}`;
    const subHTML = [
      liveProc ? sideLiveStateTag(liveDot) : '',
      r.ideOnly ? '<span class="badge" title="Antigravity IDE 전용 세션 (입력 시 새 CLI 세션으로 자동 인계)">IDE</span>' : '',
      branchTagHTML(r.branch, true),
      `<span>${esc(ago(r.mtime))}</span>`,
    ].filter(Boolean).join('');
    return `<div class="srow${isSel ? ' sel' : ''}" data-key="recent:${esc(r.sessionId)}"${dragAttrs} title="${esc([sessionLabel(r), r.cwd, brTip].filter(Boolean).join(' · '))}">
      ${agentIcon(ag, liveDot)}
      <button type="button" class="ghost srow-main srow-open"><span class="srow-t">${esc(sessionLabel(r))}</span><span class="srow-s">${subHTML}</span></button>
      <span class="srow-end">
        ${groupButton}
        <span class="fav${on ? ' on' : ''}" data-fav="${esc(fk)}" role="button" tabindex="0" aria-label="${on ? '즐겨찾기 해제' : '즐겨찾기'}">${on ? ICO.starFill : ICO.star}</span>
        <button class="record-delete danger ghost icon-btn" data-hide-record="${esc(r.sessionId)}" title="${delRecTitle}" aria-label="${esc(delRecAria)}">${ICO.trash}</button>
      </span>
    </div>`;
  };

  const sgData = getSessionGroupsData();
  const hasCustomGroups = sgData.groups.length > 0;
  const entryBusy = (entry) => (
    entry.kind === 'term' ? termStateOf(entry.item) === 'busy'
      : entry.kind === 'console' ? consoleStateOf(entry.item) === 'busy'
        : liveBySid.get(entry.item?.sessionId)?.status === 'busy'
  );
  const SGRP_HIDE_ICO = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
  const renderCustomGroupBlock = (g, items) => {
    const orderedItems = sortEntriesForBucket(items, g.id, sgData, recentMap);
    const gFoldKey = `sgrp:${g.id}`;
    const gFolded = folded.has(gFoldKey) && !fTerms.length;
    const gBusy = orderedItems.filter(entryBusy).length;
    return `<div class="sgrp-block" data-sgrp-id="${esc(g.id)}">
      <div class="sgrp-hd" data-sgrp-drag="${esc(g.id)}" title="드래그하여 그룹 순서 변경 · 세션을 끌어다 놓으면 이 그룹으로 이동">
        ${foldBtnHTML(gFoldKey, gFolded, g.name)}
        <span class="sgrp-dot" style="background:${esc(g.color)}"></span>
        <span class="sgrp-name" data-sec-fold="${esc(gFoldKey)}">${esc(g.name)}</span>
        <span class="srow-meta">${orderedItems.length}</span>
        ${gFolded && gBusy ? `<span class="srow-tag busy">실행 ${gBusy}</span>` : ''}
        <span class="sgrp-acts">
          <button type="button" class="ghost icon-btn sgrp-act" data-sgrp-hide="${esc(g.id)}" title="그룹 숨기기" aria-label="그룹 숨기기">${SGRP_HIDE_ICO}</button>
          <button type="button" class="ghost icon-btn sgrp-act" data-sgrp-rename="${esc(g.id)}" title="그룹 이름 변경" aria-label="그룹 이름 변경">${ICO.edit}</button>
          <button type="button" class="ghost icon-btn sgrp-act" data-sgrp-del="${esc(g.id)}" title="그룹 삭제" aria-label="그룹 삭제">${ICO.trash}</button>
        </span>
      </div>
      ${gFolded ? '' : `<div class="sgrp-body">${orderedItems.map((it) => renderUnifiedRow(it, g.id)).join('') || '<div class="srow-empty" style="padding-left:22px">여기로 세션을 드래그하세요</div>'}</div>`}
    </div>`;
  };

  const recFolded = folded.has('recent') && !fTerms.length;
  let recentRows = '';
  if (!recFolded) {
    if (!unifiedEntries.length) {
      recentRows = `<div class="srow-empty">${rf === 'live' ? '활성 대화 · 터미널 없음' : '최근 기록 없음'}</div>`;
    } else if (state.termGroupByProject) {
      const pjGroups = new Map();
      const customBuckets = new Map(sgData.groups.map((g) => [g.id, []]));
      const ungrouped = [];
      for (const entry of unifiedEntries) {
        const pj = entry.kind === 'term' ? projectOfTerm(entry.item)
          : entry.kind === 'console' ? projectOfSession(sessionOfConsole(entry.item)?.sessionId)
            : (state.projects || []).find((p) => p.id === entry.item.projectId)
              || projectOfSession(entry.item.sessionId) || projectOfSession(entry.item.branch?.parentSessionId);
        if (pj) {
          const gKey = `pj:${pj.id}`;
          if (!pjGroups.has(gKey)) pjGroups.set(gKey, { label: pj.name, items: [] });
          pjGroups.get(gKey).items.push(entry);
        } else {
          const cg = groupOfSessionKeys(sessionKeysForEntry(entry), sgData);
          if (cg && customBuckets.has(cg.id)) customBuckets.get(cg.id).push(entry);
          else ungrouped.push(entry);
        }
      }
      const chunks = [];
      for (const g of pjGroups.values()) {
        chunks.push(`<div class="sgrp-lbl"><span class="pj-dot"></span>${esc(g.label)}</div>${g.items.map((it) => renderUnifiedRow(it, '_project')).join('')}`);
      }
      for (const g of sgData.groups) {
        if (g.hidden) continue;
        const items = customBuckets.get(g.id) || [];
        if (fTerms.length && !items.length) continue;
        chunks.push(renderCustomGroupBlock(g, items));
      }
      if (ungrouped.length) {
        const orderedUngrouped = sortEntriesForBucket(ungrouped, '_ungrouped', sgData, recentMap);
        chunks.push(`<div class="sgrp-block" data-sgrp-id="_ungrouped"><div class="sgrp-lbl">${hasCustomGroups ? '미분류' : '일반 대화 · 터미널'}</div>${orderedUngrouped.map((it) => renderUnifiedRow(it, '_ungrouped')).join('')}</div>`);
      }
      recentRows = chunks.join('');
    } else if (hasCustomGroups) {
      const buckets = new Map(sgData.groups.map((g) => [g.id, []]));
      const ungrouped = [];
      for (const entry of unifiedEntries) {
        const cg = groupOfSessionKeys(sessionKeysForEntry(entry), sgData);
        if (cg && buckets.has(cg.id)) buckets.get(cg.id).push(entry);
        else ungrouped.push(entry);
      }
      const chunks = [];
      for (const g of sgData.groups) {
        if (g.hidden) continue;
        const items = buckets.get(g.id) || [];
        if (fTerms.length && !items.length) continue;
        chunks.push(renderCustomGroupBlock(g, items));
      }
      if (ungrouped.length || !fTerms.length) {
        const orderedUngrouped = sortEntriesForBucket(ungrouped, '_ungrouped', sgData, recentMap);
        const ugFolded = folded.has('sgrp:_ungrouped') && !fTerms.length;
        const ugBusy = orderedUngrouped.filter(entryBusy).length;
        chunks.push(`<div class="sgrp-block" data-sgrp-id="_ungrouped">
          <div class="sgrp-hd">
            ${foldBtnHTML('sgrp:_ungrouped', ugFolded, '미분류')}
            <span class="sgrp-name" data-sec-fold="sgrp:_ungrouped">미분류</span>
            <span class="srow-meta">${orderedUngrouped.length}</span>
            ${ugFolded && ugBusy ? `<span class="srow-tag busy">실행 ${ugBusy}</span>` : ''}
          </div>
          ${ugFolded ? '' : `<div class="sgrp-body">${orderedUngrouped.map((it) => renderUnifiedRow(it, '_ungrouped')).join('') || '<div class="srow-empty" style="padding-left:22px">미분류 세션 없음</div>'}</div>`}
        </div>`);
      }
      recentRows = chunks.join('');
    } else {
      const orderedFlat = sortEntriesForBucket(unifiedEntries, '_ungrouped', sgData, recentMap);
      recentRows = orderedFlat.map((it) => renderUnifiedRow(it, '_ungrouped')).join('');
    }
    const hiddenGroupCount = sgData.groups.filter((g) => g.hidden).length;
    if (hiddenGroupCount > 0) {
      recentRows += `<button type="button" class="srow-empty" data-open-sgrp-mgr="1" style="width:100%;text-align:center;border:0;background:transparent;cursor:pointer;padding:6px 8px">숨긴 그룹 ${hiddenGroupCount}개 · 관리에서 보이기</button>`;
    }
    if (!state.termGroupByProject && !fTerms.length && (hiddenProjCount > 0 || state.showProjectTerms)) {
      const lbl = state.showProjectTerms
        ? '프로젝트 작업 세션 숨기기'
        : `프로젝트 작업 세션 ${hiddenProjCount}개 숨김 · 보기`;
      recentRows += `<button type="button" class="srow-empty" data-toggle-proj-terms="1" style="width:100%;text-align:center;border:0;background:transparent;cursor:pointer;padding:6px 8px">${lbl}</button>`;
    }
  }

  const cleanExitedAria = '종료된 터미널 정리';
  const cleanExitedTitle = `종료된 터미널 정리 (${exitedCount})`;
  const groupProjLbl = 'Project별 묶어보기';
  const manageGroupsLbl = '일반 세션 그룹 관리';
  const sideOrderLbl = sideOrderMode() === 'stable' ? '순서 고정 (연 순서) · 눌러서 최근 활동순으로' : '최근 활동순 · 눌러서 순서 고정';
  h += `<div class="ssec">
    <div class="ssec-hd">
      ${foldBtnHTML('recent', recFolded, isEnUI() ? 'Sessions' : '목록')}
      <span class="ssec-title" data-key="terms-recent" title="전체 목록 보기">작업 세션 ${liveCount ? `<span class="srow-meta">${liveCount}</span>` : ''}${recFolded && busyCount ? `<span class="srow-tag busy">실행 ${busyCount}</span>` : ''}</span>
      ${exitedCount ? `<button class="ghost icon-btn ssec-act" data-side-clean-exited="1" title="${cleanExitedTitle}" aria-label="${cleanExitedAria}">${ICO.trash}</button>` : ''}
      <button class="ghost icon-btn ssec-act${hasCustomGroups ? ' on' : ''}" data-sgrp-manage="1" title="${manageGroupsLbl}" aria-label="${manageGroupsLbl}">${ICO.folder}</button>
      <button class="ghost icon-btn ssec-act${state.termGroupByProject ? ' on' : ''}" data-tgroup="1" title="${groupProjLbl}" aria-pressed="${state.termGroupByProject}" aria-label="${groupProjLbl}">${ICO.layers}</button>
      <button class="ghost icon-btn ssec-act${sideOrderMode() === 'stable' ? ' on' : ''}" data-side-order="1" title="${sideOrderLbl}" aria-pressed="${sideOrderMode() === 'stable'}" aria-label="${sideOrderLbl}">${SIDE_ORDER_ICO}</button>
      <button class="ghost icon-btn ssec-act" data-rrefresh="1" title="세션 기록 새로고침" aria-label="세션 기록 새로고침">${ICO.refresh}</button>
      <button class="ghost icon-btn ssec-act" data-hopen-new="1" title="새 대화 · 터미널 열기" aria-label="새 대화 · 터미널 열기">${ICO.plus}</button>
    </div>
    ${recFolded ? '' : `<div class="seg sm" role="tablist" aria-label="대화 · 상태 필터">${fbtn('', '전체')}${fbtn('live', '활성', liveCount)}${fbtn('claude', 'Claude')}${fbtn('codex', 'Codex')}${state.features?.agy === false ? '' : fbtn('agy', 'AGY')}</div><div class="side-history">${recentRows}</div>`}
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
  const historyList = $('.side-history', side);
  if (historyList) historyList.scrollTop = prevHistoryTop;
  side.scrollTop = prevTop;
  if (focusedNav) [...side.querySelectorAll('.snav-item')].find((nav) => nav.dataset.key === focusedNav)?.focus({ preventScroll: true });
  if (focusedSession) [...side.querySelectorAll('.side-history [data-key]')].find((row) => row.dataset.key === focusedSession)
    ?.querySelector(focusedControl.matches('.folder-badge') ? '.folder-badge' : '.srow-open')?.focus({ preventScroll: true });

  const banner = $('#diskBanner');
  if (banner) {
    const msgs = [];
    if (state.hubDown) msgs.push('⚠ 허브 서버(:7777)와 연결이 끊어졌습니다. 자동 재연결을 시도 중입니다.');
    if (state.disk) msgs.push(`⚠ ${esc(state.disk.drive)} 남은 공간 ${state.disk.freeGB} GB — 디스크가 가득 차면 세션이 멈춥니다.`);
    banner.innerHTML = msgs.join(' &nbsp;·&nbsp; ');
  }
  if (booted && state.sel.kind === 'terms' && state.termsTab !== 'active') paintTermsBody();
}
const renderTopNav = renderSide;

$('#side')?.addEventListener('click', async (e) => {
  const grpBtn = e.target.closest('[data-side-group]');
  if (grpBtn) {
    e.stopPropagation();
    const row = grpBtn.closest('[data-key]');
    if (row) openSessionGroupAssignMenu(grpBtn, row.dataset.key);
    return;
  }
  if (e.target.closest('[data-sgrp-manage]')) {
    e.stopPropagation();
    return openSessionGroupModal();
  }
  const sgrpRen = e.target.closest('[data-sgrp-rename]');
  if (sgrpRen) {
    e.stopPropagation();
    const id = sgrpRen.dataset.sgrpRename;
    const g = getSessionGroupsData().groups.find((x) => x.id === id);
    if (!g) return;
    const next = prompt('새 그룹 이름:', g.name);
    if (!next || !next.trim() || next.trim() === g.name) return;
    mutateSessionGroups({ action: 'rename', id, name: next.trim() })
      .then(() => toast('그룹 이름을 변경했습니다'))
      .catch((er) => toast(er.message, 4000, 'danger'));
    return;
  }
  const sgrpHide = e.target.closest('[data-sgrp-hide]');
  if (sgrpHide) {
    e.stopPropagation();
    const id = sgrpHide.dataset.sgrpHide;
    const g = getSessionGroupsData().groups.find((x) => x.id === id);
    if (!g) return;
    mutateSessionGroups({ action: 'toggle-hidden', id, hidden: true })
      .then(() => toast(`“${g.name}” 그룹을 숨겼습니다 (일반 세션 그룹 관리에서 다시 표시)`))
      .catch((er) => toast(er.message, 4000, 'danger'));
    return;
  }
  if (e.target.closest('[data-open-sgrp-mgr]')) {
    e.stopPropagation();
    return openSessionGroupManager();
  }
  const sgrpDel = e.target.closest('[data-sgrp-del]');
  if (sgrpDel) {
    e.stopPropagation();
    const id = sgrpDel.dataset.sgrpDel;
    const g = getSessionGroupsData().groups.find((x) => x.id === id);
    if (!g || !confirm(`“${g.name}” 그룹을 삭제할까요? (포함된 세션은 미분류로 이동됩니다)`)) return;
    mutateSessionGroups({ action: 'delete', id })
      .then(() => toast('그룹을 삭제했습니다'))
      .catch((er) => toast(er.message, 4000, 'danger'));
    return;
  }
  const rename = e.target.closest('[data-side-rename]');
  if (rename) return renameSidebarItem(rename.closest('[data-key]'));
  const fold = e.target.closest('[data-sec-fold]');
  if (fold) { e.stopPropagation(); return toggleSideFold(fold.dataset.secFold); }
  if (e.target.closest('[data-tgroup]')) {
    e.stopPropagation();
    state.termGroupByProject = !state.termGroupByProject;
    try { localStorage.setItem('ach-term-group', state.termGroupByProject ? '1' : '0'); } catch {}
    return renderSide();
  }
  if (e.target.closest('[data-side-order]')) {
    e.stopPropagation();
    setSideOrderMode(sideOrderMode() === 'stable' ? 'activity' : 'stable');
    return renderSide();
  }
  if (e.target.closest('[data-toggle-proj-terms]')) {
    e.stopPropagation();
    state.showProjectTerms = !state.showProjectTerms;
    try { localStorage.setItem('ach-show-proj-terms', state.showProjectTerms ? '1' : '0'); } catch {}
    return renderSide();
  }
  if (e.target.closest('[data-side-clean-exited]')) {
    e.stopPropagation();
    const exitedIds = state.terms.filter((t) => t.exited !== null).map((t) => t.id);
    if (!exitedIds.length) return;
    if (!confirm(`종료된 터미널 ${exitedIds.length}개를 목록에서 모두 정리할까요?`)) return;
    for (const id of exitedIds) await api('/api/term/close', { method: 'POST', body: { id } }).catch(() => {});
    await refreshOverview();
    toast(`종료된 터미널 ${exitedIds.length}개를 정리했습니다`);
    return;
  }
  const closeTerm = e.target.closest('[data-close-term]');
  if (closeTerm) {
    e.stopPropagation();
    const tid = closeTerm.dataset.closeTerm;
    const t = (state.terms || []).find((x) => String(x.id) === String(tid));
    if (!t || t.operator) return;
    const lbl = termLabel(t);
    if (t.exited === null && !confirm(`“${lbl}” 세션을 종료할까요?`)) return;
    closeTerm.disabled = true;
    try {
      await api('/api/term/close', { method: 'POST', body: { id: t.id } });
      if (state.sel.kind === 'term' && String(state.sel.id) === String(t.id)) select({ kind: 'home' });
      await refreshOverview();
      toast(t.exited === null ? `세션을 종료했습니다: ${lbl}` : `목록에서 제거했습니다: ${lbl}`);
    } catch (er) {
      closeTerm.disabled = false;
      toast(er.message, 4000, 'danger');
    }
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
  if (k === 'system') return select({ kind: state.sysTab });
  if (k === 'calendar') return select({ kind: 'calendar' });
  if (k === 'schedules') return select({ kind: 'schedules' });
  if (k === 'apps') return select({ kind: 'apps' });
  if (k === 'terms') { state.termsTab = 'active'; return select({ kind: 'terms' }); }
  if (k === 'terms-recent') { state.termsTab = 'recent'; return select({ kind: 'terms' }); }
  if (k === 'terms-favs') { state.termsTab = 'favs'; return select({ kind: 'terms' }); }
  if (k === 'projects') return select({ kind: 'projects' });
  if (k.startsWith('project:')) return typeof openProject === 'function' ? openProject(k.slice(8)) : select({ kind: 'projects', id: k.slice(8) });
  const i = k.indexOf(':');
  if (i > 0 && !(it.classList.contains('sel') && e.target.closest('.srow-open'))) {
    select({ kind: k.slice(0, i), id: k.slice(i + 1) });
  }
});

function renameSidebarItem(item) {
  const k = item?.dataset.key || '';
  if (k.startsWith('term:')) {
    const tid = k.slice(5);
    const t = (state.terms || []).find((x) => String(x.id) === tid);
    if (!t || t.operator) return;
    renameSessionItem({ termId: tid, currentTitle: termLabel(t) });
  } else if (k.startsWith('recent:')) {
    const sid = k.slice(7);
    const r = recentSession(sid);
    const lt = (state.terms || []).find((x) => x.sessionId === sid);
    const cur = r ? sessionLabel(r) : (lt ? termLabel(lt) : sid.slice(0, 8));
    renameSessionItem({ sessionId: sid, currentTitle: cur });
  }
}
$('#side')?.addEventListener('dblclick', (e) => {
  const button = e.target.closest('button');
  if ((button && !button.matches('.srow-open')) || e.target.closest('[data-fav]')) return;
  renameSidebarItem(e.target.closest('[data-key]'));
});

// ---------- Sidebar Pointer Drag & Drop (Works reliably on buttons & WebView2!) ----------
(() => {
  const side = $('#side');
  if (!side) return;
  let candidate = null;
  let ghostEl = null;
  let lastDropMark = null;
  let lastDropPos = '';
  let lastIntoBlock = null;
  let suppressClickUntil = 0;

  const clearDropVisuals = () => {
    if (lastDropMark) {
      lastDropMark.classList.remove('drop-before', 'drop-after', 'drop-grp-before', 'drop-grp-after');
      lastDropMark = null;
    }
    if (lastIntoBlock) {
      lastIntoBlock.classList.remove('drop-into');
      lastIntoBlock = null;
    }
    lastDropPos = '';
  };

  const cleanupDrag = () => {
    side.querySelectorAll('.is-dragging').forEach((el) => el.classList.remove('is-dragging'));
    clearDropVisuals();
    if (ghostEl) { ghostEl.remove(); ghostEl = null; }
    document.body.classList.remove('is-side-dragging');
    candidate = null;
    sideDragPayload = null;
    isSideDragging = false;
    if (pendingSideRender) {
      pendingSideRender = false;
      renderSide();
    }
  };

  // Swallow the synthetic click emitted right after a completed drag
  side.addEventListener('click', (e) => {
    if (Date.now() < suppressClickUntil) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, true);

  side.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    if (e.target.closest('.sgrp-acts, [data-sec-fold], [data-fav], [data-side-group], [data-hide-record], [data-close-term], input, select, textarea')) return;

    const grpHd = e.target.closest('.sgrp-hd[data-sgrp-drag]');
    if (grpHd) {
      const gid = grpHd.dataset.sgrpDrag;
      if (!gid) return;
      candidate = {
        type: 'group',
        groupId: gid,
        sourceEl: grpHd.closest('.sgrp-block'),
        label: grpHd.querySelector('.sgrp-name')?.textContent?.trim() || '그룹',
        startX: e.clientX,
        startY: e.clientY,
      };
      return;
    }

    const row = e.target.closest('.side-history .srow[data-srow-drag]');
    if (!row) return;
    const dataKey = row.dataset.key || '';
    const keys = sessionKeysForSidebarKey(dataKey);
    const primaryKey = row.dataset.srowPkey || keys[0] || '';
    if (!keys.length || !primaryKey) return;
    candidate = {
      type: 'session',
      dataKey,
      keys,
      primaryKey,
      sourceBucket: row.dataset.srowBucket || '_ungrouped',
      sourceEl: row,
      label: row.querySelector('.srow-t')?.textContent?.trim() || '세션',
      startX: e.clientX,
      startY: e.clientY,
    };
  });

  window.addEventListener('pointermove', (e) => {
    if (!candidate) return;
    if (!sideDragPayload) {
      if (Math.hypot(e.clientX - candidate.startX, e.clientY - candidate.startY) < 6) return;
      sideDragPayload = candidate;
      isSideDragging = true;
      candidate.sourceEl?.classList.add('is-dragging');
      document.body.classList.add('is-side-dragging');
      ghostEl = document.createElement('div');
      ghostEl.className = 'side-drag-ghost';
      ghostEl.textContent = candidate.label;
      document.body.appendChild(ghostEl);
    }

    if (ghostEl) {
      ghostEl.style.transform = `translate3d(${Math.round(e.clientX + 14)}px, ${Math.round(e.clientY + 12)}px, 0)`;
    }

    // Auto-scroll #side near top/bottom edges while dragging
    const sideRect = side.getBoundingClientRect();
    if (e.clientX >= sideRect.left && e.clientX <= sideRect.right) {
      if (e.clientY < sideRect.top + 36) side.scrollTop -= 12;
      else if (e.clientY > sideRect.bottom - 36) side.scrollTop += 12;
    }

    const hit = document.elementFromPoint(e.clientX, e.clientY);
    if (!hit || !side.contains(hit)) {
      clearDropVisuals();
      return;
    }

    if (sideDragPayload.type === 'group') {
      const blk = hit.closest('.sgrp-block[data-sgrp-id]');
      const gid = blk?.dataset.sgrpId || '';
      if (!blk || !gid || gid === '_ungrouped' || gid === sideDragPayload.groupId) {
        clearDropVisuals();
        return;
      }
      const rect = blk.getBoundingClientRect();
      const pos = (e.clientY - rect.top) < rect.height / 2 ? 'before' : 'after';
      if (lastDropMark !== blk || lastDropPos !== pos) {
        clearDropVisuals();
        blk.classList.add(pos === 'before' ? 'drop-grp-before' : 'drop-grp-after');
        lastDropMark = blk;
        lastDropPos = pos;
      }
      return;
    }

    const targetRow = hit.closest('.side-history .srow[data-srow-drag]');
    if (targetRow && targetRow.dataset.key !== sideDragPayload.dataKey && targetRow.dataset.srowBucket !== '_project') {
      const rect = targetRow.getBoundingClientRect();
      const pos = (e.clientY - rect.top) < rect.height / 2 ? 'before' : 'after';
      const parentBlk = targetRow.closest('.sgrp-block[data-sgrp-id]');
      if (lastDropMark !== targetRow || lastDropPos !== pos || lastIntoBlock !== parentBlk) {
        clearDropVisuals();
        targetRow.classList.add(pos === 'before' ? 'drop-before' : 'drop-after');
        if (parentBlk && parentBlk.dataset.sgrpId !== sideDragPayload.sourceBucket) {
          parentBlk.classList.add('drop-into');
          lastIntoBlock = parentBlk;
        }
        lastDropMark = targetRow;
        lastDropPos = pos;
      }
      return;
    }

    const blk = hit.closest('.sgrp-block[data-sgrp-id]');
    if (blk && blk.dataset.sgrpId) {
      if (lastIntoBlock !== blk || lastDropMark) {
        clearDropVisuals();
        blk.classList.add('drop-into');
        lastIntoBlock = blk;
      }
      return;
    }
    clearDropVisuals();
  });

  const handleDrop = async () => {
    if (!candidate) return;
    if (!sideDragPayload) { candidate = null; return; }
    const payload = sideDragPayload;
    const dropMark = lastDropMark;
    const dropPos = lastDropPos;
    const intoBlk = lastIntoBlock;
    suppressClickUntil = Date.now() + 280;
    cleanupDrag();

    if (payload.type === 'group') {
      const targetGid = dropMark?.dataset?.sgrpId;
      if (!targetGid || targetGid === '_ungrouped' || targetGid === payload.groupId) return;
      const ids = getSessionGroupsData().groups.map((g) => g.id).filter((id) => id !== payload.groupId);
      let idx = ids.indexOf(targetGid);
      if (idx < 0) return;
      if (dropPos === 'after') idx += 1;
      ids.splice(idx, 0, payload.groupId);
      try {
        await mutateSessionGroups({ action: 'reorder-groups', order: ids });
      } catch (er) { toast(er.message, 4000, 'danger'); }
      return;
    }

    const collectBucketKeys = (bucket) => {
      const out = [];
      const keySet = new Set(payload.keys);
      side.querySelectorAll(`.side-history .srow[data-srow-bucket="${CSS.escape(bucket)}"]`).forEach((el) => {
        const pk = el.dataset.srowPkey;
        if (pk && !keySet.has(pk) && !out.includes(pk)) out.push(pk);
      });
      return out;
    };

    if (dropMark && dropMark.matches('.srow[data-srow-pkey]')) {
      const targetBucket = dropMark.dataset.srowBucket || '_ungrouped';
      const targetPkey = dropMark.dataset.srowPkey || '';
      if (targetBucket === '_project' || !targetPkey) return;
      const order = collectBucketKeys(targetBucket);
      const idx = order.indexOf(targetPkey);
      if (idx < 0) order.push(payload.primaryKey);
      else order.splice(dropPos === 'after' ? idx + 1 : idx, 0, payload.primaryKey);
      const changedGroup = targetBucket !== payload.sourceBucket;
      const reqBody = {
        action: 'move-session',
        keys: payload.keys,
        order,
        ...(changedGroup
          ? { groupId: targetBucket === '_ungrouped' ? '' : targetBucket }
          : { bucket: targetBucket }),
      };
      try {
        await mutateSessionGroups(reqBody);
        if (changedGroup) {
          const grp = getSessionGroupsData().groups.find((g) => g.id === targetBucket);
          toast(grp ? `“${grp.name}” 그룹으로 이동했습니다` : '미분류로 이동했습니다');
        }
      } catch (er) { toast(er.message, 4000, 'danger'); }
      return;
    }

    if (intoBlk && intoBlk.dataset.sgrpId) {
      const targetBucket = intoBlk.dataset.sgrpId;
      const order = [payload.primaryKey, ...collectBucketKeys(targetBucket)];
      const changedGroup = targetBucket !== payload.sourceBucket;
      try {
        await mutateSessionGroups({
          action: 'move-session',
          keys: payload.keys,
          groupId: targetBucket === '_ungrouped' ? '' : targetBucket,
          order,
        });
        if (changedGroup) {
          const grp = getSessionGroupsData().groups.find((g) => g.id === targetBucket);
          toast(grp ? `“${grp.name}” 그룹으로 이동했습니다` : '미분류로 이동했습니다');
        }
      } catch (er) { toast(er.message, 4000, 'danger'); }
    }
  };

  window.addEventListener('pointerup', handleDrop);
  window.addEventListener('pointercancel', cleanupDrag);
})();
