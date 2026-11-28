// ---------- Chat Workspace, Transcript & Message Composer ----------
function dockTopSegHTML({ openSet, isContentTab = false, hasTerm = true, hasChat = true, showFiles = true, curTab = 'dock', termTitle = '터미널 패널 열기/닫기' }) {
  const on = (id) => !isContentTab && openSet.has(id);
  return `<div class="seg bar-dock-seg" role="group" aria-label="분할 패널 토글">
    ${hasTerm ? `<button type="button" data-dock-toggle="term" aria-pressed="${on('term')}" class="${on('term') ? 'on' : ''}" title="${esc(termTitle)}">${ICO.terminal} 터미널</button>` : ''}
    ${hasChat ? `<button type="button" data-dock-toggle="chat" aria-pressed="${on('chat')}" class="${on('chat') ? 'on' : ''}" title="채팅 창 패널 열기/닫기">${ICO.chat} 채팅 창</button>` : ''}
    <button type="button" data-dock-toggle="windows" aria-pressed="${on('windows')}" class="${on('windows') ? 'on' : ''}" title="연결된 창 · 브라우저 미리보기 패널 열기/닫기">${ICO.monitor} 창 <span class="seg-cnt" data-dock-win-cnt></span></button>
  </div>
  <div class="seg bar-tab-seg" role="tablist" aria-label="전용 화면 탭">
    ${showFiles ? `<button type="button" role="tab" aria-selected="${curTab === 'files'}" data-tab="files" class="${curTab === 'files' ? 'on' : ''}" title="이 세션의 산출물 보기 및 지정">산출물</button>` : ''}
    <button type="button" role="tab" aria-selected="${curTab === 'floorplan'}" data-tab="floorplan" class="${curTab === 'floorplan' ? 'on' : ''}" title="코드 구조(Floorplan) 및 보안·품질 점검">${ICO.layers} 코드 구조</button>
  </div>
  ${hasTerm && hasChat ? `<button type="button" class="ghost btn-sm bar-face-btn" data-face-toggle title="TUI(터미널) ↔ GUI(채팅 창) 즉시 전환 (Alt+J)">${ICO.swap || ''} TUI / GUI</button>` : ''}`;
}

function setSessionBar(identity, views, actions, subagents, folders) {
  const switchTerm = subagents?.termId && (state.terms || []).find(t => String(t.id) === String(subagents.termId));
  const canSwitch = subagents?.sessionId || switchTerm?.claude || switchTerm?.codex || switchTerm?.agy;
  const switchButtons = canSwitch ? `<button type="button" class="btn-sm" data-account-recommend title="같은 에이전트의 여유 계정으로 전환하고 계속 진행">${ICO.swap || ''} 추천 계정으로 계속</button><button type="button" class="ghost btn-sm" data-account-choose>계정 선택</button>` : '';
  setBar(`<div class="session-head">${identity}<div class="session-actions">${folderBadge(folders)}${switchButtons}${actions}</div></div>
    <div class="session-views">${views}</div>`);
  if (canSwitch) {
    $('[data-account-recommend]', $('#bar')).onclick = e => { e.stopPropagation(); void switchRecommended(subagents.sessionId || '', subagents.termId || '', e.currentTarget); };
    $('[data-account-choose]', $('#bar')).onclick = e => { e.stopPropagation(); void openSwitch(subagents.sessionId || '', subagents.termId || ''); };
  }
  if (subagents) mountSubagents($('#bar .session-views'), subagents);
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
      <div class="tool-stream-host" hidden></div>
      <div class="chat-scroll"></div>
      <div class="chat-comp-host"></div>
    </div>
    <div class="chat-pv-resizer" hidden role="separator" aria-orientation="vertical" aria-label="미리보기 크기 조절"></div>
    <aside class="chat-pv-pane" hidden aria-label="미리보기"></aside>
    <nav class="pv-rail" aria-label="우측 툴박스">
      <button type="button" class="pv-rail-btn" data-pv-side="preview" aria-pressed="false" title="미리보기 패널 열기/닫기">${ICO.eye}</button>
      <button type="button" class="pv-rail-btn" data-pv-side="refs" aria-pressed="false" title="산출물 패널 열기/닫기">${ICO.clip}</button>
      <button type="button" class="pv-rail-btn" data-pv-side="floorplan" aria-pressed="false" title="코드 구조 패널 열기/닫기">${ICO.layers}</button>
    </nav>
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
      getContext: () => {
        const curSid = sid || composerOpts.sid || currentSessionId() || '';
        const live = (state.terms || []).find((x) => x.sessionId === curSid) || composerOpts.term || null;
        const curCwd = composerOpts.cwd || live?.cwd || '';
        const project = (live && typeof projectOfTerm === 'function' && projectOfTerm(live))
          || (state.projects || []).find((p) => p.cwd && curCwd && p.cwd.toLowerCase() === curCwd.toLowerCase())
          || null;
        return { sid: curSid, termId: live?.id || '', cwd: curCwd || project?.cwd || '', project };
      },
    });
    window.ACH_PREVIEW.setActiveController(pvCtl);
    pvCtl?.refresh(false);
    $('.pv-rail', splitEl)?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-pv-side]');
      if (btn) pvCtl?.togglePanel?.(btn.dataset.pvSide);
    });
  }
  renderChat(sid, gen, at, terms, scrollEl);
  mountChatComposer({ barHost: compEl, chatHost: scrollEl, sid, ...composerOpts });
  const tsHost = $('.tool-stream-host', body);
  if (tsHost && window.ACH_TOOL_STREAM) {
    const curTermId = composerOpts.termId || (state.sel.kind === 'term' ? state.sel.id : '');
    window.ACH_TOOL_STREAM.mountToolStreamBar(tsHost, {
      termId: curTermId,
      sessionId: sid || '',
      cwd: composerOpts.cwd || '',
      gen,
    });
  }
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
  const cwdPath = r?.cwd || live?.cwd || '';
  const hasCwd = !!cwdPath;
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
    <h2 title="더블클릭하여 명칭 변경" style="cursor:pointer"><span data-session-title title="${title}">${title}</span></h2>
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
    <button id="btnRecMore" class="ghost icon-btn btn-sm" aria-label="세션 메뉴" aria-haspopup="menu" aria-expanded="false">${ICO.more}</button>`,
    { sessionId: sid, cwd: r?.cwd }, folderTarget(r || live || { sessionId: sid }));

  let dock = null;
  const doRenameSess = () => renameSessionItem({ sessionId: sid, currentTitle: sessionLabel(recentSession(sid) || r, sid, live?.name) });
  $('#bar h2')?.addEventListener('dblclick', doRenameSess);
  $('#bar').onclick = async (e) => {
    if (openSessionOrigin(e.target)) return;
    if (e.target.closest('[data-face-toggle]')) { toggleTuiGuiFace?.(); return; }
    if (e.target.closest('#btnBackRecent')) {
      if (state.sel.fromSearch) return select({ kind: 'search', restoreScroll: true });
      state.termsTab = 'recent'; return select({ kind: 'terms' });
    }
    if (e.target.closest('#btnRenameSess')) return doRenameSess();
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
    const pvSide = e.target.closest('[data-pv-side]');
    if (pvSide) {
      const kind = pvSide.dataset.pvSide;
      if (isContentTab || !dock) {
        await select(state.sel, 'dock', true);
        setTimeout(() => window.ACH_PREVIEW?.openPanel?.(kind), 60);
        return;
      }
      window.ACH_PREVIEW?.togglePanel?.(kind);
      return;
    }
    const tb = e.target.closest('[data-tab]');
    if (tb) return select(state.sel, tb.dataset.tab, true);
    const more = e.target.closest('#btnRecMore');
    if (more) {
      e.stopPropagation();
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
      chat: { title: '채팅 창', icon: ICO.chat },
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
    cwd: cwdPath,
    gen,
    isOpen: () => !!dock?.isOpen('windows'),
    onCount: (n) => { const c = $('#bar [data-dock-win-cnt]'); if (c) c.textContent = n > 0 ? String(n) : ''; },
  });
}

const chatLaunchPrefs = new Map();

const chatSendRecovery = new Map();
let pendingReviewDraft;

function stageReviewInChat(text, attachment, target = null) {
  const sel = state.sel;
  if (!['term', 'recent', 'console'].includes(sel.kind)) return false;
  if (target && (sel.kind !== target.kind || String(sel.id) !== String(target.id))) return false;
  const activeComposer = $('.chat-comp-host', $('#view'));
  if (activeComposer?.getClientRects().length && activeComposer._stageChatDraft) {
    activeComposer._stageChatDraft(text, attachment);
    return true;
  }
  pendingReviewDraft = { kind: sel.kind, id: String(sel.id), text, attachment };
  window.ACH_DOCK?.saveDockOpen(sel.kind === 'recent' ? 'recent' : 'term', ['chat']);
  select({ ...sel }, 'chat');
  return true;
}

async function sendAreaReviewInChat(text, target) {
  const { kind, id } = state.sel;
  const composer = $('.chat-comp-host', $('#view'));
  if (!target || target.kind !== kind || String(target.id) !== String(id) || !composer?._sendAreaReview) {
    throw Object.assign(new Error('산출물을 연결할 세션을 열어 주세요.'), { delivery: 'not-sent' });
  }
  await composer._sendAreaReview(text);
}

function mountChatComposer({ barHost, chatHost = null, sid = null, termId = null, consolePid = null, agent = 'claude', cwd = '', liveDesktop = false, compact = false }) {
  if (!barHost) return;
  let activeTermId = termId ? String(termId) : null;
  let activeConsolePid = consolePid ? Number(consolePid) : null;
  const baseAgent = (agent === 'codex' || agent === 'agy') ? agent : 'claude';
  const prefKey = sid || (activeTermId ? `term:${activeTermId}` : '');
  const recoveryKey = activeTermId ? `term:${activeTermId}` : prefKey || `console:${activeConsolePid}`;

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
      <button type="button" class="ghost btn-sm" data-chat-selection title="선택한 텍스트 첨부" aria-label="선택한 텍스트 첨부">${ICO.clip}<span>선택한 텍스트 첨부</span></button>
      ${navigator.mediaDevices?.getDisplayMedia ? `<button type="button" class="ghost btn-sm" data-chat-screen title="화면 영역" aria-label="화면 영역">${ICO.monitor}<span>화면 영역</span></button>` : ''}
      <button type="button" class="ghost btn-sm chat-me-toggle" data-chat-settings aria-expanded="false" title="실행 설정" aria-label="실행 설정">${ICO.settings}<span>실행 설정</span></button>
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
    <div class="chat-quote-bar" data-chat-send-error hidden>
      <span role="status" data-chat-send-note></span>
      <button type="button" class="btn-sm" data-chat-retry>다시 전송</button>
      <button type="button" class="ghost btn-sm" data-chat-dismiss>닫기</button>
    </div>
    <div class="chat-quote-bar" data-chat-quote hidden>
      <span class="chat-quote-lbl" data-chat-quote-txt></span>
      <button type="button" class="ghost icon-btn btn-sm" data-chat-quote-clear aria-label="참조 해제" title="참조 해제">${ICO.close}</button>
    </div>
    <div class="chat-reply-in">
      <label class="ghost icon-btn btn-sm filebtn" title="파일 · 폴더 · 이미지 첨부 (드래그&드롭 / 붙여넣기)">${ICO.clip}<input type="file" class="fpick" multiple hidden></label>
      <textarea rows="1" aria-label="대화 프롬프트" placeholder="대화 프롬프트 · Enter 전송"></textarea>
      <button type="button" class="primary">대화 전송</button>
    </div>
  </div>`;

  const connEl = $('[data-chat-conn]', barHost);
  const accSel = $('[data-chat-acc]', barHost);
  const applyBtn = $('[data-chat-apply]', barHost);
  const repIn = $('textarea', barHost);
  const repBtn = $('.chat-reply-in button.primary', barHost);
  const sendError = $('[data-chat-send-error]', barHost);
  const sendNote = $('[data-chat-send-note]', barHost);
  const settingsBtn = $('[data-chat-settings]', barHost);
  const settingsBar = $('[data-chat-me]', barHost);
  settingsBtn.onclick = () => {
    settingsBar.hidden = !settingsBar.hidden;
    settingsBtn.setAttribute('aria-expanded', String(!settingsBar.hidden));
  };

  let baselineAccId = ltInit?.account?.id || `__cli__:${initAgent}`;
  let meCtl = null;
  let userEditedSettings = false;
  const termSigOf = (t) => (t ? `${t.id}|${t.agent || baseAgent}|${t.account?.id || ''}|${t.model || ''}|${t.effort || ''}` : '');
  let lastSyncedTermSig = termSigOf(ltInit);

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
      if (!dirty) userEditedSettings = false;
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
      onChange: () => { userEditedSettings = true; syncApplyBtn(); },
    });
  }

  accSel.onchange = () => {
    userEditedSettings = true;
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
      const postModel = lt ? (lt.model || '') : (savedPref ? initModel : postDef.model);
      const postEffort = lt ? (lt.effort || '') : (savedPref ? initEffort : postDef.effort);
      if (lt && meCtl?.syncFromTerm) meCtl.syncFromTerm(curSelectedAg, postModel, postEffort);
      else meCtl?.setCli(curSelectedAg, postModel, postEffort);
      if (lt) lastSyncedTermSig = termSigOf(lt);
      syncApplyBtn();
    } catch {}
  };
  loadCandidates();

  const syncConn = () => {
    if (!barHost.isConnected) return;
    const lt = findLiveTerm();
    if (lt) {
      activeTermId = String(lt.id);
      const curSig = termSigOf(lt);
      if (curSig !== lastSyncedTermSig) {
        lastSyncedTermSig = curSig;
        if (!userEditedSettings) {
          const ltAgent = lt.agent || baseAgent;
          if (accSel) {
            const wantOpt = [...accSel.options].find((o) => (lt.account?.id ? o.value === lt.account.id : o.dataset.agent === ltAgent));
            if (wantOpt) accSel.value = wantOpt.value;
          }
          if (meCtl?.syncFromTerm) meCtl.syncFromTerm(ltAgent, lt.model || '', lt.effort || '');
          else meCtl?.setCli(ltAgent, lt.model || '', lt.effort || '');
          if (!lt.projectTask && typeof saveAccountPref === 'function') {
            saveAccountPref({ account: accSel?.value || lt.account?.id || '', cli: ltAgent, model: lt.model || '', effort: lt.effort || '' });
          }
        }
      }
      const meta = typeof termStatusMeta === 'function' ? termStatusMeta(lt) : null;
      const st = meta ? meta.state : termStateOf(lt);
      const dotCls = meta ? meta.dot : (st === 'busy' ? 'busy' : 'idle');
      const stTxt = meta ? meta.shortLabel : (st === 'busy' ? '실행 중' : '대기');
      const meBadge = [lt.model, lt.effort].filter(Boolean).join('/');
      connEl.innerHTML = `<span class="dot ${dotCls}" style="width:7px;height:7px"></span><span>터미널 t:${esc(lt.id)} 연결됨 · ${esc(stTxt)}${meBadge ? ` · ${esc(meBadge)}` : ''}</span>`;
    } else if (activeConsolePid) {
      connEl.innerHTML = `<span class="dot idle" style="width:7px;height:7px"></span><span>콘솔 pid:${esc(activeConsolePid)} 연결됨</span>`;
    } else if (sid && typeof recentSession === 'function' && recentSession(sid)?.ideOnly) {
      connEl.innerHTML = `<span class="badge">IDE</span> <span class="ums" style="margin:0">Antigravity IDE 전용 기록 · 입력 시 새 CLI 세션으로 맥락을 자동 인계합니다</span>`;
    } else {
      connEl.innerHTML = `<span class="ums" style="margin:0">연결된 터미널 없음 · 입력 시 세션을 이어 열어 전송합니다</span>`;
    }
    connEl.title = connEl.textContent.trim();
    syncApplyBtn();
  };
  syncConn();
  const connTimer = setInterval(() => {
    if (!barHost.isConnected) return clearInterval(connTimer);
    syncConn();
  }, 1500);

  const fitRep = () => { repIn.style.height = 'auto'; repIn.style.height = Math.min(140, Math.max(38, repIn.scrollHeight)) + 'px'; };
  repIn.addEventListener('input', fitRep);

  const notifySent = (targetTermId, text, submittedText = text) => {
    if (!chatHost) return;
    chatHost._liveChatHint = {
      termId: targetTermId ? String(targetTermId) : '',
      consolePid: activeConsolePid || null,
      pendingText: text,
      submittedText,
      sentAt: Date.now(),
      until: Date.now() + 30000,
    };
    chatHost._triggerPoll?.();
  };
  const sendToTerm = async (id, text, waitForReady = false, resendIfMissing = false, nativeCommand = null) => {
    const result = await api('/api/term/send', { method: 'POST', body: { id, text, submit: true, waitForReady, resendIfMissing, clearDraft: true, nativeSlash: !!nativeCommand } });
    if (!result.ok) throw Object.assign(new Error(result.error || '터미널 입력을 확인하지 못했습니다.'), { delivery: result.delivery });
    if (!nativeCommand) notifySent(id, text, result.submittedText);
    if (nativeCommand?.tui && barHost.isConnected) {
      const term = findLiveTerm();
      if (term) {
        window.ACH_DOCK?.saveDockOpen('term', ['term', 'chat']);
        openResumedTerm(term, { kind: term.agent, resume: resolveTermSessionId(term) }, 'split');
      }
    }
  };

  const launchWithConfig = async ({ openTerm = false, pendingText = '' } = {}) => {
    const cfg = getConfig();
    if (typeof saveCliDefaults === 'function') {
      saveCliDefaults(cfg.agent, { account: cfg.account, model: cfg.model, effort: cfg.effort });
    }
    const lt = findLiveTerm();
    const isIdeOnly = !!(sid && typeof recentSession === 'function' && recentSession(sid)?.ideOnly);
    const needsSwitch = !!lt || cfg.agent !== baseAgent || isIdeOnly || (!!cfg.account && !cfg.account.startsWith('__cli__:'));
    if (needsSwitch) {
      const isCrossPlatform = cfg.agent !== (lt?.agent || baseAgent) || isIdeOnly;
      const payload = {
        sessionId: sid || undefined,
        termId: lt?.id || undefined,
        account: cfg.account || `__cli__:${cfg.agent}`,
        model: cfg.model,
        effort: cfg.effort,
        cont: false,
        ...(isCrossPlatform && pendingText ? { followUp: pendingText, verifyFollowUp: true } : {}),
        skip: true,
        openMode: 'dashboard',
      };
      const res = await runSwitchRequest(payload);
      if (!res?.ok) throw new Error(res?.error || '설정 변경 적용에 실패했습니다');
      if (res.term) {
        activeTermId = String(res.term.id);
        baselineAccId = cfg.account;
        userEditedSettings = false;
        lastSyncedTermSig = termSigOf(res.term);
        if (prefKey) chatLaunchPrefs.set(prefKey, cfg);
      }
      await refreshOverview();
      if (res.term && !state.terms.some((x) => String(x.id) === String(res.term.id))) {
        state.terms = [res.term, ...state.terms];
      }
      if (pendingText && !res.term?.id) throw new Error('터미널을 열 수 없습니다.');
      if (pendingText && res.term?.id) {
        if (res.deliveryError) throw new Error(res.deliveryError);
        if (!res.followUpSubmitted) await sendToTerm(res.term.id, pendingText, true);
        else notifySent(res.term.id, pendingText);
      }
      if (res.term) {
        if (barHost.isConnected && openTerm) {
          window.ACH_DOCK?.saveDockOpen('term', ['term', 'chat']);
          openResumedTerm(res.term, { kind: cfg.agent, resume: res.crossPlatform ? undefined : sid }, openTerm ? 'split' : undefined);
        } else {
          syncConn();
          loadCandidates();
        }
      }
      const meDesc = [providerName(cfg.agent), cfg.model || '', cfg.effort || ''].filter(Boolean).join(' · ');
      const handoffNote = res.handoffFile ? ` (맥락 파일 전달)` : '';
      toast(`${meDesc} 설정으로 세션을 연결했습니다${handoffNote}`);
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
    if (t.error || !t.id) throw new Error(t.error || '터미널을 열 수 없습니다.');
    activeTermId = String(t.id);
    if (!state.terms.some((term) => String(term.id) === activeTermId)) state.terms = [t, ...state.terms];
    if (prefKey) chatLaunchPrefs.set(prefKey, cfg);
    await refreshOverview();
    if (pendingText) {
      await sendToTerm(t.id, pendingText, true);
    }
    if (openTerm && barHost.isConnected) {
      window.ACH_DOCK?.saveDockOpen('term', ['term', 'chat']);
      openResumedTerm(t, body, 'split');
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
  const addReview = (text, attachment) => {
    const paths = Array.isArray(attachment) ? attachment : attachment ? [attachment] : [];
    const attached = new Set(chatAttCtl.snapshot().map(item => item.path));
    chatAttCtl.addPaths([...new Set(paths)].filter(p => !attached.has(p)));
    if (text) repIn.value = [repIn.value, text].filter(Boolean).join('\n\n');
    fitRep();
    repIn.focus();
  };
  barHost._stageChatDraft = addReview;
  $('[data-chat-screen]', barHost)?.addEventListener('click', async () => {
    try {
      await openScreenReview((text, attachment) => {
        if (barHost.isConnected) addReview(text, attachment);
      });
    } catch (error) { if (error.name !== 'NotAllowedError') toast(error.message, 6000, 'danger'); }
  });
  const selectionButton = $('[data-chat-selection]', barHost);
  let selectedText = '';
  const getSelectedText = () => {
    const range = window.getSelection();
    return range?.anchorNode && $('#view')?.contains(range.anchorNode) ? range.toString().trim().slice(0, 4000) : '';
  };
  selectionButton.onpointerdown = () => { selectedText = getSelectedText(); };
  selectionButton.onclick = () => {
    const selection = selectedText || getSelectedText();
    selectedText = '';
    if (!selection) return toast('보낼 로그나 텍스트를 먼저 선택하세요.');
    addReview(selection.split('\n').map(line => '> ' + line).join('\n'), '');
  };
  const quoteBar = $('[data-chat-quote]', barHost);
  const quoteTxtEl = $('[data-chat-quote-txt]', barHost);
  let quotedMsg = null;
  const setQuotedMsg = (info) => {
    quotedMsg = info && info.text ? info : null;
    if (!quoteBar || !quoteTxtEl) return;
    if (!quotedMsg) {
      quoteBar.hidden = true;
      quoteTxtEl.textContent = '';
      return;
    }
    const preview = String(quotedMsg.text).replace(/\s+/g, ' ').trim().slice(0, 90);
    quoteTxtEl.textContent = `참조 · #${quotedMsg.index} (${quotedMsg.author}): ${preview}`;
    quoteBar.hidden = false;
    repIn?.focus();
  };
  barHost._setQuote = setQuotedMsg;
  $('[data-chat-quote-clear]', barHost)?.addEventListener('click', () => setQuotedMsg(null));
  const dropZone = barHost.closest('.chat-shell') || barHost;
  attachFileInput(dropZone, null, cwd, { onFiles: chatAttCtl.addFiles, onPaths: chatAttCtl.addPaths });
  bindFilePick(barHost, null, cwd, { onFiles: (fl, it) => chatAttCtl.addFiles(fl, it) });

  let sendingReply = false;
  const showSendError = () => {
    const record = chatSendRecovery.get(recoveryKey);
    sendError.hidden = !record?.error;
    sendNote.textContent = record?.error ? (record.uncertain ? `전달 여부 확인 필요 · ${record.error}` : record.error) : '';
    $('[data-chat-retry]', barHost).disabled = Boolean(record?.sending);
  };
  const recovered = chatSendRecovery.get(recoveryKey);
  function restoreSendDraft(record) {
    if (record.areaReview || repIn.value || chatAttCtl.hasItems()) return;
    repIn.value = record.typed;
    chatAttCtl.addPaths(record.attachments);
    setQuotedMsg(record.quote);
    fitRep();
    showSendError();
  }
  if (recovered && !recovered.sending) restoreSendDraft(recovered);
  if (pendingReviewDraft?.kind === state.sel.kind && pendingReviewDraft.id === String(state.sel.id)) {
    const draft = pendingReviewDraft;
    pendingReviewDraft = null;
    addReview(draft.text, draft.attachment);
  }
  barHost._restoreFailedSend = (key, record) => {
    if (key === recoveryKey) { restoreSendDraft(record); showSendError(); }
  };
  $('[data-chat-dismiss]', barHost).onclick = () => {
    if (chatSendRecovery.get(recoveryKey)?.sending) return;
    chatSendRecovery.delete(recoveryKey);
    showSendError();
    renderSide();
  };
  $('[data-chat-retry]', barHost).onclick = () => sendReply(true);
  let resolvingArtifact = false;
  const sendReply = async (retry = false, areaReview = '') => {
    const previous = chatSendRecovery.get(recoveryKey);
    if (sendingReply || resolvingArtifact || repBtn.disabled || previous?.sending) {
      if (areaReview) throw Object.assign(new Error('메시지를 전송하는 중입니다.'), { delivery: 'not-sent' });
      return;
    }
    if (areaReview && previous?.error) {
      throw Object.assign(new Error('이전 전송 오류를 먼저 확인해 주세요.'), { delivery: 'not-sent' });
    }
    if (retry && previous?.areaReview) areaReview = previous.typed;
    if (!areaReview && previous?.areaReview) return toast('이전 전송 오류를 먼저 확인해 주세요.');
    if (previous?.uncertain && !confirm('CLI가 이미 받았을 수 있습니다. 대화를 확인한 뒤 다시 전송할까요?')) return;
    if (!areaReview && slash?.dispatch()) return;
    if (!areaReview) slash?.close();
    const typed = areaReview || repIn.value.trim();
    const mentionMatch = !areaReview && !retry ? /^@(claude|codex|agy)\s+([\s\S]+)$/i.exec(typed) : null;
    if (mentionMatch) {
      const targetAg = mentionMatch[1].toLowerCase();
      const question = mentionMatch[2].trim();
      const selectedText = quotedMsg?.text ? String(quotedMsg.text) : '';
      if (quotedMsg) setQuotedMsg(null);
      repIn.value = ''; fitRep();
      const agLabel = providerName(targetAg);
      const card = document.createElement('div');
      card.className = 'rcard';
      card.style.cssText = 'margin:8px 14px;padding:10px 12px;border-left:3px solid var(--accent);background:var(--panel2);';
      card.innerHTML = `<div class="row" style="justify-content:space-between;align-items:center;margin-bottom:6px">
        <span class="badge c">${esc(agLabel)} 위임</span>
        <button type="button" class="ghost icon-btn btn-sm" data-del-close aria-label="닫기">${ICO.close}</button>
      </div>
      <div class="ums" style="margin:0 0 6px">${esc(question.slice(0, 140))}${question.length > 140 ? '…' : ''}</div>
      <div class="del-body" style="font-size:13px;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere">${esc(agLabel)}에게 의견을 요청하는 중…</div>`;
      card.querySelector('[data-del-close]').onclick = () => card.remove();
      if (chatHost) {
        chatHost.appendChild(card);
        chatHost.scrollTop = chatHost.scrollHeight;
      }
      try {
        const curTerm = findLiveTerm();
        const r = await api('/api/transcript/sidechat', {
          method: 'POST',
          body: { sessionId: resolveTermSessionId(curTerm) || sid || '', selectedText, question, agent: targetAg, cwd },
        });
        if (!r?.ok) throw new Error(r?.error || '위임 응답을 받지 못했습니다.');
        const bodyEl = card.querySelector('.del-body');
        if (bodyEl) {
          if (typeof renderMarkdown === 'function') {
            bodyEl.style.whiteSpace = 'normal';
            bodyEl.innerHTML = renderMarkdown(r.reply || '');
          } else {
            bodyEl.textContent = r.reply || '';
          }
        }
        const acts = document.createElement('div');
        acts.className = 'row';
        acts.style.cssText = 'gap:6px;margin-top:8px;justify-content:flex-end';
        acts.innerHTML = `<button type="button" class="btn-sm" data-del-quote>입력창에 인용</button>`;
        acts.querySelector('[data-del-quote]').onclick = () => {
          const snippet = `[${agLabel} 의견]\n${String(r.reply || '').trim()}`;
          repIn.value = repIn.value ? `${repIn.value}\n\n${snippet}` : snippet;
          fitRep();
          repIn.focus();
        };
        card.appendChild(acts);
        if (chatHost) chatHost.scrollTop = chatHost.scrollHeight;
      } catch (err) {
        const bodyEl = card.querySelector('.del-body');
        if (bodyEl) bodyEl.innerHTML = `<span style="color:var(--danger)">${esc(err.message || '위임 실패')}</span>`;
      }
      return;
    }
    const nativeCommand = areaReview ? null : slash?.native(typed);
    if (!areaReview && !nativeCommand && chatAttCtl.isLoading()) return toast('첨부 파일을 준비하는 중입니다…');
    if (!areaReview && typed && !nativeCommand && !previous?.error && !chatAttCtl.hasItems() && !quotedMsg) {
      const term = findLiveTerm();
      resolvingArtifact = true;
      try {
        const paths = await inferChatArtifacts(typed, { chatHost, sid: resolveTermSessionId(term) || sid, termId: term?.id || activeTermId });
        if (!barHost.isConnected || repIn.value.trim() !== typed) return;
        if (!chatAttCtl.hasItems() && !quotedMsg) chatAttCtl.addPaths(paths);
      } catch {
        if (!barHost.isConnected || repIn.value.trim() !== typed) return;
      } finally { resolvingArtifact = false; }
      if (chatAttCtl.isLoading()) return toast('첨부 파일을 준비하는 중입니다…');
    }
    const attachments = areaReview || nativeCommand ? [] : chatAttCtl.snapshot();
    const bodyText = [...attachments.map(item => quotePath(item.path)), typed].filter(Boolean).join(' ');
    if (!bodyText) return;
    const quote = areaReview || nativeCommand ? null : quotedMsg;
    let quotePrefix = '';
    if (quote) {
      const snippet = String(quotedMsg.text).trim().slice(0, 800);
      const lines = snippet.split('\n').slice(0, 12).map((l) => `> ${l}`);
      if (quotedMsg.text.length > 800 || quotedMsg.text.split('\n').length > 12) lines.push('> …');
      quotePrefix = `> [참조 #${quotedMsg.index} · ${quotedMsg.author}]\n${lines.join('\n')}\n\n`;
    }
    const text = `${quotePrefix}${bodyText}`;
    sendingReply = true;
    const record = { typed, attachments, quote, areaReview: Boolean(areaReview), sending: true };
    chatSendRecovery.set(recoveryKey, record);
    repIn.readOnly = true;
    repBtn.disabled = true;
    const prevBtnTxt = repBtn.textContent;
    repBtn.textContent = '전송 중…';
    try {
      const launchAndSend = async () => {
        if (!nativeCommand) return launchWithConfig({ pendingText: text });
        const term = await launchWithConfig();
        if (!term?.id) throw new Error('터미널을 열 수 없습니다.');
        await sendToTerm(term.id, text, true, false, nativeCommand);
        return term;
      };
      const existing = findLiveTerm();
      if (existing) {
        const cfg = getConfig();
        const ltAgent = existing.agent || baseAgent;
        const ltAcc = existing.account?.id || baselineAccId || `__cli__:${ltAgent}`;
        const changed = userEditedSettings && (
          cfg.agent !== ltAgent
          || cfg.model !== (existing.model || '')
          || cfg.effort !== (existing.effort || '')
          || (cfg.account !== ltAcc && !(cfg.account === `__cli__:${ltAgent}` && !existing.account?.id))
        );
        if (changed) {
          await launchAndSend();
          return;
        }
        try {
          await sendToTerm(existing.id, text, false, retry, nativeCommand);
          syncConn();
          return;
        } catch (sendErr) {
          if (!/no such running terminal/i.test(String(sendErr?.message || ''))) throw sendErr;
          // Cached terminal exited between polls — refresh and transparently resume & deliver.
          if (String(activeTermId) === String(existing.id)) activeTermId = null;
          existing.exited = 0;
          await refreshOverview();
          const fresh = findLiveTerm();
          if (fresh && String(fresh.id) !== String(existing.id)) {
            await sendToTerm(fresh.id, text, false, retry, nativeCommand);
            syncConn();
            return;
          }
          const reopened = await launchAndSend();
          if (reopened) toast(`터미널 t:${reopened.id}을(를) 다시 연결해 메시지를 전송했습니다`);
          return;
        }
      }
      if (activeConsolePid) {
        const r = await api('/api/console/send', { method: 'POST', body: { pid: activeConsolePid, text, submit: true, resendIfMissing: retry, nativeSlash: !!nativeCommand } });
        if (!r.ok) throw Object.assign(new Error(r.error || '터미널 입력을 확인하지 못했습니다.'), { delivery: r.delivery });
        syncConn();
        if (!nativeCommand) notifySent(null, text);
        if (nativeCommand?.tui) toast('명령 결과는 연결된 CLI 창에서 확인하세요.');
        return;
      }
      const t = await launchAndSend();
      if (t) toast(`터미널 t:${t.id}을(를) 연결해 메시지를 전송했습니다`);
    } catch (er) {
      if (areaReview) throw er;
      record.error = er.message;
      record.uncertain = er.delivery !== 'not-sent';
    } finally {
      sendingReply = false;
      record.sending = false;
      if (record.error && !barHost.isConnected) $('.chat-comp-host', $('#view'))?._restoreFailedSend?.(recoveryKey, record);
      if (!record.error) {
        chatSendRecovery.delete(recoveryKey);
        if (!areaReview) {
          repHist?.sent(typed);
          if (repIn.value.trim() === typed) repIn.value = '';
          chatAttCtl.discard(attachments);
          if (quote && quotedMsg === quote) setQuotedMsg(null);
          fitRep();
        }
      }
      showSendError();
      renderSide();
      if (repBtn.isConnected) {
        repIn.readOnly = false;
        repBtn.disabled = false;
        repBtn.textContent = prevBtnTxt || '대화 전송';
      }
    }
  };
  barHost._sendAreaReview = text => sendReply(false, text);
  const slash = typeof bindSlashPicker === 'function' ? bindSlashPicker(repIn, () => {
    const term = findLiveTerm();
    const cfg = getConfig();
    return {
      term, sid: resolveTermSessionId(term) || sid,
      cwd: term?.cwd || cwd,
      agent: userEditedSettings ? cfg.agent : term?.agent || cfg.agent,
      accountId: userEditedSettings ? cfg.account : term?.account?.id || cfg.account,
      openChatAction: (action, args) => openSlashChatAction(action, args, barHost, chatHost),
    };
  }, sendReply, { showButton: false }) : null;
  const histKey = sid || resolveTermSessionId(state.terms.find((x) => String(x.id) === String(termId)))
    || (termId ? `term:${termId}` : consolePid ? `con:${consolePid}` : '');
  const repHist = window.bindPromptHistory?.(repIn, histKey, { onChange: fitRep });
  repBtn.onclick = () => sendReply();
  if (typeof window.bindEnterSubmit === 'function') window.bindEnterSubmit(repIn, () => sendReply());
  else repIn.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendReply(); } };
}

function openResumedTerm(t, request, tab) {
  const isAgy = request.kind === 'agy';
  const saved = getSavedTermTab(null);
  select({ kind: 'term', id: t.id, ...(request.resume ? { historySession: request.resume } : {}), ...(isAgy ? { agyResume: request.resume } : {}) }, tab || saved || (isAgy ? 'split' : undefined));
}

function resolveTermSessionId(t) {
  if (!t) return null;
  if (t.sessionId) return t.sessionId;
  if (t.projectTask) return null;
  if (state.sel.kind === 'term' && String(state.sel.id) === String(t.id) && state.sel.historySession) return state.sel.historySession;
  if (t.agy || t.agent === 'agy') return state.sel.kind === 'term' && String(state.sel.id) === String(t.id) ? state.sel.agyResume || null : null;
  return null;
}
