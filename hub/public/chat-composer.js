// ---------- Chat Workspace, Transcript & Message Composer ----------
function dockTopSegHTML({ openSet, isContentTab = false, hasTerm = true, hasChat = true, showFiles = true, curTab = 'dock', termTitle = '터미널 패널 열기/닫기' }) {
  const on = (id) => !isContentTab && openSet.has(id);
  return `<div class="seg bar-dock-seg" role="group" aria-label="분할 패널 토글">
    ${hasTerm ? `<button type="button" data-dock-toggle="term" aria-pressed="${on('term')}" class="${on('term') ? 'on' : ''}" title="${esc(termTitle)}">${ICO.terminal} 터미널</button>` : ''}
    ${hasChat ? `<button type="button" data-dock-toggle="chat" aria-pressed="${on('chat')}" class="${on('chat') ? 'on' : ''}" title="대화 기록 패널 열기/닫기">${ICO.chat} 대화 기록</button>` : ''}
    <button type="button" data-dock-toggle="windows" aria-pressed="${on('windows')}" class="${on('windows') ? 'on' : ''}" title="연결된 창 · 브라우저 미리보기 패널 열기/닫기">${ICO.monitor} 창 <span class="seg-cnt" data-dock-win-cnt>0</span></button>
  </div>
  <div class="seg bar-tab-seg" role="tablist" aria-label="전용 화면 탭">
    ${showFiles ? `<button type="button" role="tab" aria-selected="${curTab === 'files'}" data-tab="files" class="${curTab === 'files' ? 'on' : ''}" title="이 세션의 산출물 보기 및 지정">산출물</button>` : ''}
    <button type="button" role="tab" aria-selected="${curTab === 'floorplan'}" data-tab="floorplan" class="${curTab === 'floorplan' ? 'on' : ''}" title="코드 구조(Floorplan) 및 보안·품질 점검">${ICO.layers} 코드 구조</button>
  </div>`;
}

function setSessionBar(identity, views, actions) {
  setBar(`<div class="session-head">${identity}<div class="session-actions">${actions}</div></div>
    <div class="session-views">${views}</div>`);
}

function sessionOriginButton(branch) {
  if (!branch?.parentSessionId) return '';
  return `<button type="button" class="ghost btn-sm" data-session-origin="${esc(branch.parentSessionId)}" data-origin-at="${branch.atIndex ?? -1}" title="${esc(branch.parentTitle || '원본 대화 열기')}">${ICO.branch} 원본 열기</button>`;
}

function openSessionOrigin(target) {
  const button = target.closest('[data-session-origin]');
  if (!button) return false;
  select({ kind: 'recent', id: button.dataset.sessionOrigin, at: Number(button.dataset.originAt) }, 'chat');
  return true;
}

function mountChatWorkspace(body, { sid, gen, at = -1, terms = [], composerOpts = {} }) {
  if (!body) return null;
  body.innerHTML = `<div class="chat-split">
    <div class="chat-shell">
      <div class="chat-scroll"></div>
      <div class="chat-comp-host"></div>
    </div>
    <div class="chat-pv-resizer" hidden role="separator" aria-orientation="vertical" aria-label="미리보기 크기 조절"></div>
    <aside class="chat-pv-pane" hidden aria-label="미리보기"></aside>
  </div>`;
  const splitEl = $('.chat-split', body);
  const scrollEl = $('.chat-scroll', body);
  const compEl = $('.chat-comp-host', body);
  const pvPane = $('.chat-pv-pane', body);
  const pvResizer = $('.chat-pv-resizer', body);
  if (window.ACH_PREVIEW) {
    const pvCtl = window.ACH_PREVIEW.mountPreviewPane({
      rootEl: pvPane,
      splitEl,
      resizerEl: pvResizer,
      getSessionId: () => sid || composerOpts.sid || currentSessionId() || '',
    });
    window.ACH_PREVIEW.setActiveController(pvCtl);
    pvCtl?.refresh(false);
  }
  renderChat(sid, gen, at, terms, scrollEl);
  mountChatComposer({ barHost: compEl, chatHost: scrollEl, sid, ...composerOpts });
  return { scrollEl, compEl };
}
function syncBarDockButtons(openList) {
  const set = new Set(openList || []);
  $('#bar')?.querySelectorAll('[data-dock-toggle]').forEach((b) => {
    const isOn = set.has(b.dataset.dockToggle);
    b.classList.toggle('on', isOn);
    b.setAttribute('aria-pressed', String(isOn));
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

  const title = esc(sessionLabel(r, sid, live?.name));
  const backLabel = state.sel.fromSearch ? '검색 결과' : '최근 대화';
  setSessionBar(`<button id="btnBackRecent" class="ghost btn-sm session-back" aria-label="${backLabel}">${ICO.chevLeft}<span>${backLabel}</span></button>
    <h2 title="${title}"><span>${title}</span></h2>
    <button id="btnRenameSess" class="ghost icon-btn btn-sm" title="대화 제목 수정" aria-label="대화 제목 수정">${ICO.edit}</button>
    <div class="session-meta">${sessionOriginButton(r?.branch)}${branchTagHTML(r?.branch)}${agentBadge(r?.agent)}</div>`,
    dockTopSegHTML({
      openSet: new Set(initialPanels),
      isContentTab,
      hasTerm: true,
      hasChat: true,
      showFiles: true,
      curTab: state.tab,
      termTitle: hasLivePane ? '연결된 터미널 패널 열기/닫기' : '이 세션을 터미널로 열어 함께 보기',
    }),
    `${!live ? `<button class="primary btn-sm" id="btnResume" aria-label="대시보드에서 이어하기">${ICO.play} 이어하기</button>` : isDesktopSession(live) ? `<button class="primary btn-sm" id="btnResume" data-fork="1" title="데스크톱 앱 대화를 여기까지 복제한 새 세션으로 이어갑니다">${ICO.play} 복제 후 이어하기</button>` : ''}
    <button id="btnRecMore" class="ghost icon-btn btn-sm" aria-label="세션 메뉴" aria-haspopup="menu" aria-expanded="false">${ICO.more}</button>`);

  let dock = null;
  $('#bar').onclick = async (e) => {
    if (openSessionOrigin(e.target)) return;
    if (e.target.closest('#btnBackRecent')) {
      if (state.sel.fromSearch) return select({ kind: 'search', restoreScroll: true });
      state.termsTab = 'recent'; return select({ kind: 'terms' });
    }
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
      const cwdPath = r?.cwd || live?.cwd || '';
      return openMoreMenu(more, [
        { label: '현재 시점에서 분기 만들기', icon: ICO.branch, onClick: () => openBranchDialog({ sid, atIndex: null, agent: r?.agent || 'claude', cwd: cwdPath }) },
        hasCwd && !IS_REMOTE ? {
          label: '탐색기에서 폴더 열기',
          icon: ICO.folder,
          onClick: async () => {
            const res = await api('/api/fs/open-dir', { method: 'POST', body: { path: cwdPath } }).catch((er) => ({ error: er.message }));
            if (res?.error) return toast(res.error, 4000, 'danger');
            toast('탐색기에서 폴더를 열었습니다 (PC)');
          },
        } : null,
        hasCwd && !IS_REMOTE ? { label: 'IDE에서 열기', icon: ICO.external, onClick: () => openExternal(true) } : null,
        { label: '외부 창으로 열기', icon: ICO.external, onClick: () => openExternal(false) },
        { label: `세션 ID 복사 (${sid.slice(0, 8)})`, icon: ICO.copy, onClick: () => copyText(sid) },
        { divider: true },
        { label: '기록 삭제', icon: ICO.trash, tone: 'danger', onClick: () => hideRecentRecord(sid, more) },
      ]);
    }
    if (!e.target.closest('#btnResume')) return;
    return resumeToDockTerm(true);
  };
  if (state.tab === 'files') return renderArtifacts(sid, gen);
  if (state.tab === 'floorplan' && typeof renderStandaloneFloorplan === 'function') {
    return renderStandaloneFloorplan(r?.cwd || live?.cwd || '', gen, { sessionId: sid || '' });
  }

  let winCtl = null;
  let termCtl = null;
  let termMounted = false;
  let chatScrollEl = null;
  const ensureTermMounted = () => {
    if (termMounted || !hasLivePane || !dock) return;
    termMounted = true;
    const body = dock.getBody('term');
    const chatHost = dock.isOpen('chat') ? chatScrollEl : null;
    if (linkedTerm) termCtl = mountManagedTermScreen(body, { t: linkedTerm, gen, chatHost });
    else if (linkedConPid) termCtl = mountConsoleScreen(body, { pid: linkedConPid, gen, s: live, chatHost });
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
    onOpenChange: (openList) => {
      syncBarDockButtons(openList);
      termCtl?.syncChatPane(openList.includes('chat') ? chatScrollEl : null);
    },
  });

  const mounted = mountChatWorkspace(dock.getBody('chat'), {
    sid,
    gen,
    at: state.sel.at ?? -1,
    terms: termsOf(state.sel.q),
    composerOpts: {
      consolePid: linkedConPid || null,
      agent: r?.agent || 'claude',
      cwd: r?.cwd || live?.cwd || '',
      liveDesktop: !!(live && isDesktopSession(live)),
    },
  });
  chatScrollEl = mounted?.scrollEl || null;
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

function mountChatComposer({ barHost, chatHost = null, sid = null, termId = null, consolePid = null, agent = 'claude', cwd = '', liveDesktop = false, compact = false }) {
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
      <button type="button" class="ghost btn-sm chat-me-toggle" data-chat-settings aria-expanded="false">${ICO.settings} 실행 설정</button>
    </div>
    <div class="chat-me-bar" data-chat-me hidden>
      <select data-chat-acc title="사용할 계정 · CLI 선택" aria-label="계정 및 CLI">
        <option value="__cli__:${esc(initAgent)}" data-agent="${esc(initAgent)}">${esc(providerName(initAgent))} (기본)</option>
      </select>
      <select data-chat-model-pick title="선택한 계정 CLI에 맞는 모델" aria-label="모델"></select>
      <input data-chat-model maxlength="120" placeholder="모델 ID 직접 입력" style="display:none" aria-label="모델 ID 직접 입력">
      <select data-chat-effort title="선택한 계정 CLI에 맞는 추론 성능" aria-label="추론 성능"></select>
      <button type="button" class="btn-sm primary" data-chat-apply hidden>변경 적용</button>
    </div>
    <div class="att-strip" data-chat-atts hidden></div>
    <div class="chat-reply-in">
      <label class="ghost icon-btn btn-sm filebtn" title="파일 · 이미지 첨부 (드래그&드롭 / 붙여넣기)" style="flex:none;height:38px;min-height:38px;width:36px;justify-content:center;border-radius:10px;border:1px solid var(--line-strong)">${ICO.clip}<input type="file" class="fpick" multiple hidden></label>
      <textarea rows="1" aria-label="대화 프롬프트" placeholder="대화 프롬프트 · Enter 전송"></textarea>
      <button type="button" class="primary">대화 전송</button>
    </div>
  </div>`;

  const connEl = $('[data-chat-conn]', barHost);
  const accSel = $('[data-chat-acc]', barHost);
  const applyBtn = $('[data-chat-apply]', barHost);
  const repIn = $('textarea', barHost);
  const repBtn = $('.chat-reply-in button.primary', barHost);
  const settingsBtn = $('[data-chat-settings]', barHost);
  const settingsBar = $('[data-chat-me]', barHost);
  settingsBtn.onclick = () => {
    settingsBar.hidden = !settingsBar.hidden;
    settingsBtn.setAttribute('aria-expanded', String(!settingsBar.hidden));
  };

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
      getAccount: () => accSel?.value || '',
      onChange: syncApplyBtn,
    });
  }

  accSel.onchange = () => {
    const nextAg = getSelectedAgent();
    const accVal = accSel.value;
    if (typeof saveCliDefaults === 'function') saveCliDefaults(nextAg, { account: accVal });
    const accSaved = typeof readSavedAccountPref === 'function' ? readSavedAccountPref(accVal, nextAg) : null;
    if (accSaved) meCtl?.setCli(nextAg, accSaved.model, accSaved.effort);
    else meCtl?.setCli(nextAg);
    syncApplyBtn();
  };

  const loadCandidates = async () => {
    try {
      const r = await api(`/api/switch/candidates?id=${encodeURIComponent(sid || '')}${activeTermId ? `&term=${encodeURIComponent(activeTermId)}` : ''}`);
      if (r?.accountPrefs && typeof syncServerAccountPrefs === 'function') syncServerAccountPrefs(r.accountPrefs);
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
      const postDef = (!lt && typeof readSavedAccountPref === 'function')
        ? readSavedAccountPref(accSel.value, curSelectedAg)
        : ((!lt && typeof readSavedCliDefaults === 'function') ? readSavedCliDefaults(curSelectedAg) : { model: '', effort: '' });
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
    } else if (activeConsolePid) {
      connEl.innerHTML = `<span class="dot idle" style="width:7px;height:7px"></span><span>콘솔 pid:${esc(activeConsolePid)} 연결됨</span>`;
    } else {
      connEl.innerHTML = `<span class="ums" style="margin:0">연결된 터미널 없음 · 입력 시 세션을 이어 열어 전송합니다</span>`;
    }
    syncApplyBtn();
  };
  syncConn();
  const connTimer = setInterval(() => {
    if (!barHost.isConnected) return clearInterval(connTimer);
    syncConn();
  }, 1500);

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
      if (res.term && !state.terms.some((x) => String(x.id) === String(res.term.id))) {
        state.terms = [res.term, ...state.terms];
      }
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

  const chatAttCtl = createAttachmentStrip($('[data-chat-atts]', barHost), cwd);
  const dropZone = barHost.closest('.chat-shell') || barHost;
  attachFileInput(dropZone, null, cwd, { onFiles: (fl, it) => chatAttCtl.addFiles(fl, it) });
  bindFilePick(barHost, null, cwd, { onFiles: (fl, it) => chatAttCtl.addFiles(fl, it) });

  const sendReply = async () => {
    if (chatAttCtl.isLoading()) return toast('첨부 파일을 준비하는 중입니다…');
    const attPaths = chatAttCtl.takePaths();
    const typed = repIn.value.trim();
    const text = [...attPaths, typed].filter(Boolean).join(' ');
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
