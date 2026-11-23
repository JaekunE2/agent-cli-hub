// ---------- Conversation Renderer, Branching & Markdown Preview ----------
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
      getAccount: () => accSel?.value || '',
    })
    : null;
  const updateModeHint = () => {
    const tAg = agSel.value;
    const accSaved = typeof readSavedAccountPref === 'function' ? readSavedAccountPref(accSel.value, tAg) : null;
    if (accSaved && accSel.value) brMeCtl?.setCli(tAg, accSaved.model, accSaved.effort);
    else brMeCtl?.setCli(tAg);
    hintEl.textContent = (sourceAg === 'claude' && tAg === 'claude' && capabilities?.canNativeFork !== false)
      ? 'Claude 원본 JSONL을 이 지점까지만 복제해 네이티브 분기 세션으로 엽니다.'
      : '이 지점까지의 대화 맥락을 브리핑 파일로 정리해 새 세션에 전달합니다.';
  };
  const loadAccounts = async () => {
    try {
      const tAg = agSel.value;
      const r = await api(`/api/projects/accounts?agent=${encodeURIComponent(tAg)}`);
      const list = r.accounts || [];
      accSel.innerHTML = `<option value="">기본 / 현재 활성 계정</option>` + list.map((a) => `<option value="${esc(a.id)}">${esc(a.label)}</option>`).join('');
      const savedDef = typeof readSavedCliDefaults === 'function' ? readSavedCliDefaults(tAg) : { account: '' };
      if (savedDef.account && list.some((a) => a.id === savedDef.account)) accSel.value = savedDef.account;
    } catch {}
    updateModeHint();
  };
  agSel.onchange = loadAccounts;
  accSel.onchange = updateModeHint;
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
    const canImmediate = !!(showPendingUser && (lt || conPid));
    const hasScreen = !!(showLiveScreen && preview);
    const hasToggle = !!preview;
    const modeKey = `${showPendingUser ? hint.pendingText : ''}|${canImmediate ? 'imm1' : 'imm0'}|${hasScreen ? 'pre' : 'dots'}|${hasToggle ? '1' : '0'}`;
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
      ? `<div class="msg user msg-pending"><div class="msg-bubble"><div class="msg-body">${linkPaths(esc(hint.pendingText))}</div></div><div class="msg-meta"><span>전송됨 · 응답 대기 중</span>${canImmediate ? '<button type="button" class="msg-send-now-btn" data-pending-send-now title="응답 대기 중이거나 보류된 메시지를 중단(Esc) 후 즉시 전송합니다">즉시 보내기</button>' : ''}</div></div>`
      : '';
    const toggleBtn = hasToggle
      ? `<button type="button" class="ghost btn-sm" data-live-toggle style="min-height:22px;height:22px;font-size:11px;padding:0 7px">${showLiveScreen ? '터미널 출력 숨기기' : '터미널 출력 보기'}</button>`
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
          ${toggleBtn}
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
    const immBtn = $('[data-pending-send-now]', liveHost);
    if (immBtn) {
      immBtn.onclick = async () => {
        const curHint = container._liveChatHint;
        if (!curHint?.pendingText) return;
        const target = resolveLiveTarget();
        if (!target.lt && !target.conPid) return toast('연결된 실행 중 터미널을 찾을 수 없습니다', 4000, 'danger');
        immBtn.disabled = true;
        immBtn.textContent = '전송 중…';
        try {
          const r = target.lt
            ? await api('/api/term/send', { method: 'POST', body: { id: target.lt.id, text: curHint.pendingText, submit: true, immediate: true, resendIfMissing: true } })
            : await api('/api/console/send', { method: 'POST', body: { pid: target.conPid, text: curHint.pendingText, submit: true, immediate: true, resendIfMissing: true } });
          if (r?.error) throw new Error(r.error);
          curHint.until = Date.now() + 30000;
          lastLiveMode = '';
          if (immBtn.isConnected) { immBtn.disabled = false; immBtn.textContent = '즉시 보내기'; }
          toast(r?.alreadyRecognized ? 'CLI가 이미 해당 메시지를 처리 중입니다' : '보류 중인 메시지를 즉시 전송했습니다');
          container._triggerPoll?.();
        } catch (er) {
          toast(er.message, 5000, 'danger');
          if (immBtn.isConnected) { immBtn.disabled = false; immBtn.textContent = '즉시 보내기'; }
        }
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
      if (updated && curSid !== updated) { lastSig = ''; curSid = updated; }
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
      if (lastMessages.length) {
        const working = await updateLiveBubble(lastMessages);
        if (!jump) chatPollTimer = setTimeout(tick, working ? 1100 : 3000);
        return;
      }
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
        const toolBranches = toolBuf.map((x) => branchChipsHTML(x.gi)).filter(Boolean).join('');
        parts.push(`<details class="toolgrp"><summary>도구 실행 ${toolBuf.length}건</summary><div class="toolgrp-body">${toolBuf.map((x) => `<div>${linkPaths(hl(x.m.text, terms))}</div>`).join('')}</div></details>${toolBranches}`);
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
      window.ACH_PREVIEW?.hydrateMermaid(msgsHost);
      window.ACH_PREVIEW?.scanChatBlocks(msgsHost);
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


// Tiny markdown renderer (escapes everything first; preserves inline code spans; supports Mermaid, tables, lists, and file:// artifact chips).
function md(src) {
  const lines = String(src || '').replace(/\r/g, '').split('\n');
  const inline = (t) => {
    const spans = [];
    const masked = esc(t).replace(/`([^`]+)`/g, (_, code) => {
      spans.push(`<code>${code}</code>`);
      return `\u0000C${spans.length - 1}\u0000`;
    });
    return masked
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/~~([^~]+)~~/g, '<s>$1</s>')
      .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/\[([^\]]+)\]\(file:\/\/\/?([^)#\s]+)(?:#[^)\s]*)?\)/gi, (_, lbl, rawPath) => {
        const cleanPath = rawPath.replace(/\//g, '\\');
        return `<a class="filechip artlink" data-apath="${cleanPath}" title="${cleanPath}">${lbl}</a>`;
      })
      .replace(/\[([^\]]+)\]\(conversation:\/\/[^)\s]+\)/gi, '<span class="filechip">$1</span>')
      .replace(/\u0000C(\d+)\u0000/g, (_, idx) => spans[Number(idx)] || '');
  };
  const out = [];
  let i = 0, list = null, para = [];
  const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  while (i < lines.length) {
    const l = lines[i];
    const fenceM = l.match(/^\s*```(.*)$/);
    if (fenceM) {
      flushPara(); closeList();
      const langRaw = (fenceM[1] || '').trim();
      const langL = langRaw.split(/[\s{]/)[0].toLowerCase();
      const buf = []; i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) buf.push(lines[i++]);
      const rawCode = buf.join('\n');
      if (langL === 'mermaid' || langL === 'mmd') {
        out.push(`<div class="codeblk mermaid-card"><div class="codeblk-hd"><span>mermaid · flowchart</span><span class="row" style="gap:4px"><button type="button" data-mermaid-toggle="1">코드 보기</button><button type="button" data-preview-code="mermaid">미리보기</button><button type="button" data-copy-code="1">${ICO.copy} 복사</button></span></div><div class="mermaid-host" data-mermaid-src="${esc(rawCode)}"><pre class="mdpre">${esc(rawCode)}</pre></div><pre class="mdpre mermaid-src" hidden>${esc(rawCode)}</pre></div>`);
      } else {
        const canPv = ['html', 'htm', 'svg', 'markdown', 'md'].includes(langL);
        const pvBtn = canPv ? `<button type="button" data-preview-code="${esc(langL)}">▶ 미리보기</button>` : '';
        out.push(`<div class="codeblk"><div class="codeblk-hd"><span>${esc(langL || langRaw || 'code')}</span><span class="row" style="gap:4px">${pvBtn}<button type="button" data-copy-code="1">${ICO.copy} 복사</button></span></div><pre class="mdpre">${esc(rawCode)}</pre></div>`);
      }
      if (i < lines.length && /^\s*```\s*$/.test(lines[i])) i++;
      continue;
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
