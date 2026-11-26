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

function parseInteractivePrompt(lines) {
  if (!Array.isArray(lines) || !lines.length) return null;
  const cleaned = lines
    .map((l) => String(l ?? '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\s+$/, ''))
    .slice(-32);
  while (cleaned.length && !cleaned[cleaned.length - 1].trim()) cleaned.pop();
  if (cleaned.length < 3) return null;

  const tailText = cleaned.slice(-4).join('\n');
  const hasNavFooter = /(?:navigate.*(?:select|enter)|enter\s+(?:to\s+)?(?:confirm|select)|arrow keys to select|esc\s+(?:to\s+)?(?:skip|cancel|deny|reject))/i.test(tailText);
  if (!hasNavFooter) return null;

  // Strip footer hint lines from bottom
  let end = cleaned.length;
  while (end > 0 && /(?:navigate|enter\s+(?:to\s+)?(?:confirm|select)|esc\s+(?:to\s+)?(?:skip|cancel|deny|reject)|arrow keys|^[\s─━═·]+$)/i.test(cleaned[end - 1].trim())) {
    end--;
  }
  const body = cleaned.slice(0, end);
  // Walk backward from the bottom to isolate ONLY the active choice menu (ignoring earlier numbered lists in scrollback)
  const choicesReversed = [];
  let firstChoiceIdx = -1;
  let pendingWrap = [];
  for (let i = body.length - 1; i >= 0; i--) {
    const raw = body[i];
    const mNum = /^\s*([›❯>])?\s*(\d+)[.)]\s+(.+)$/.exec(raw);
    if (mNum) {
      const label = [mNum[3].trim(), ...pendingWrap].join(' ').trim();
      pendingWrap = [];
      choicesReversed.push({
        num: Number(mNum[2]),
        label,
        selected: !!mNum[1],
        isWriteIn: /write-in|type (?:your|something|custom)/i.test(label),
      });
      firstChoiceIdx = i;
      if (Number(mNum[2]) === 1) break;
      continue;
    }
    if (choicesReversed.length === 0 && !raw.trim()) continue;
    if (/^\s{3,}\S/.test(raw) && !/^\s*[›❯>]/.test(raw)) {
      pendingWrap.unshift(raw.trim());
      continue;
    }
    if (choicesReversed.length > 0) break;
  }
  const choices = choicesReversed.reverse();
  if (choices.length < 2 || !choices.some((c) => c.selected)) return null;
  const selectedIndex = choices.findIndex((c) => c.selected);
  const qStart = (() => {
    for (let i = firstChoiceIdx - 1; i >= Math.max(0, firstChoiceIdx - 8); i--) {
      if (/^\s*(?:Question\s+\d+\/\d+:|Do you want to|Allow Codex to|Trust (?:this|the))/i.test(body[i])) return i;
    }
    return Math.max(0, firstChoiceIdx - 4);
  })();
  const qLines = body.slice(qStart, firstChoiceIdx).map((l) => l.trim()).filter(Boolean);
  const question = qLines.join('\n') || '선택이 필요합니다';
  const key = `${question}|${selectedIndex}|${choices.map((c) => `${c.num}:${c.label}`).join('|')}`;
  return { question, choices, selectedIndex, key };
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

  // Ephemeral Side Chat (per-session state, pinnable to right, resizable, wheel-safe)
  const scKey = String(curSid || `${state.sel.kind}:${state.sel.id}` || 'default');
  const SC_STORE_KEY = 'ach.sidechat.sessions.v1';
  const SC_PIN_KEY = 'ach.sidechat.pinned.v1';
  const SC_WIDTH_KEY = 'ach.sidechat.width.v1';
  const loadScStore = () => {
    try { return JSON.parse(sessionStorage.getItem(SC_STORE_KEY) || '{}') || {}; } catch { return {}; }
  };
  const saveScStore = (st) => {
    try {
      const all = loadScStore();
      all[scKey] = { open: !!st.open, selectedText: st.selectedText || '', history: Array.isArray(st.history) ? st.history.slice(-30) : [] };
      sessionStorage.setItem(SC_STORE_KEY, JSON.stringify(all));
    } catch {}
  };
  const savedSc = loadScStore()[scKey];
  let sideChatState = savedSc
    ? { open: !!savedSc.open, selectedText: savedSc.selectedText || '', history: Array.isArray(savedSc.history) ? savedSc.history : [], busy: false }
    : { open: false, selectedText: '', history: [], busy: false };
  let sideChatPinned = true;
  try { sideChatPinned = localStorage.getItem(SC_PIN_KEY) !== '0'; } catch {}
  let sideChatWidth = 380;
  try { sideChatWidth = Math.max(280, Math.min(720, Number(localStorage.getItem(SC_WIDTH_KEY)) || 380)); } catch {}

  const sideFab = document.createElement('button');
  sideFab.type = 'button';
  sideFab.className = 'sidechat-fab';
  sideFab.hidden = true;
  sideFab.innerHTML = `${ICO.chat} <span>사이드 질문</span>`;
  box.appendChild(sideFab);

  const sidePop = document.createElement('section');
  sidePop.className = 'sidechat-pop';
  sidePop.hidden = true;
  sidePop.setAttribute('aria-label', '사이드 채팅');
  box.appendChild(sidePop);

  const syncSideChatLayout = () => {
    const pinnedOpen = sideChatState.open && sideChatPinned;
    sidePop.classList.toggle('is-pinned', pinnedOpen);
    box.classList.toggle('has-pinned-sc', pinnedOpen);
    box.style.setProperty('--sc-w', `${sideChatWidth}px`);
    sidePop.style.setProperty('--sc-w', `${sideChatWidth}px`);
    if (pinnedOpen) {
      const top = Math.max(12, Math.round(container.getBoundingClientRect().top || 56));
      sidePop.style.setProperty('--sc-top', `${top}px`);
    }
  };

  const renderSideChat = () => {
    saveScStore(sideChatState);
    if (!sideChatState.open) {
      sidePop.hidden = true;
      sidePop.innerHTML = '';
      syncSideChatLayout();
      return;
    }
    sidePop.hidden = false;
    syncSideChatLayout();
    const quote = sideChatState.selectedText.length > 220
      ? `${sideChatState.selectedText.slice(0, 220)}…`
      : sideChatState.selectedText;
    const msgsHtml = sideChatState.history.length
      ? sideChatState.history.map((m) => `<div class="sidechat-msg ${m.role === 'user' ? 'u' : 'a'}">${m.role === 'user' ? esc(m.text) : md(m.text)}</div>`).join('')
      : '<div class="ums" style="margin:6px 0">선택한 부분을 기준으로 단발성 질문을 입력하세요. (세션별 유지 · 대화 기록에는 미저장)</div>';
    sidePop.innerHTML = `
      <div class="sidechat-resize" title="드래그하여 너비 조절"></div>
      <div class="sidechat-hd">
        <span class="sidechat-ttl">${ICO.chat} 사이드 채팅 <span class="badge">세션별</span></span>
        <div class="row" style="gap:4px">
          <button type="button" class="btn-sm${sideChatPinned ? ' primary' : ' ghost'}" data-sc-pin title="우측 고정 전환">${sideChatPinned ? '📌 고정됨' : '우측 고정'}</button>
          <button type="button" class="ghost icon-btn btn-sm" data-sc-close aria-label="사이드 채팅 닫기">${ICO.close}</button>
        </div>
      </div>
      <blockquote class="sidechat-quote">${esc(quote)}</blockquote>
      <div class="sidechat-msgs">${msgsHtml}${sideChatState.busy ? '<div class="ums" style="margin:4px 0">응답 생성 중…</div>' : ''}</div>
      <div class="sidechat-bar">
        <input type="text" data-sc-in placeholder="선택한 내용에 대해 질문…" ${sideChatState.busy ? 'disabled' : ''}>
        <button type="button" class="primary btn-sm" data-sc-send ${sideChatState.busy ? 'disabled' : ''}>질문</button>
      </div>`;
    const bodyEl = $('.sidechat-msgs', sidePop);
    const quoteEl = $('.sidechat-quote', sidePop);
    if (bodyEl) bodyEl.scrollTop = bodyEl.scrollHeight;
    for (const scEl of [bodyEl, quoteEl]) {
      scEl?.addEventListener('wheel', (ev) => {
        if (scEl.scrollHeight > scEl.clientHeight) ev.stopPropagation();
      }, { passive: true });
    }
    const resizeEl = $('.sidechat-resize', sidePop);
    if (resizeEl) {
      resizeEl.onpointerdown = (ev) => {
        ev.preventDefault();
        const startX = ev.clientX;
        const startW = sideChatWidth;
        resizeEl.classList.add('is-dragging');
        const onMove = (mv) => {
          sideChatWidth = Math.max(280, Math.min(720, startW + (startX - mv.clientX)));
          syncSideChatLayout();
        };
        const onUp = () => {
          resizeEl.classList.remove('is-dragging');
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          try { localStorage.setItem(SC_WIDTH_KEY, String(sideChatWidth)); } catch {}
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
      };
    }
    $('[data-sc-pin]', sidePop).onclick = () => {
      sideChatPinned = !sideChatPinned;
      try { localStorage.setItem(SC_PIN_KEY, sideChatPinned ? '1' : '0'); } catch {}
      renderSideChat();
    };
    $('[data-sc-close]', sidePop).onclick = () => {
      sideChatState = { open: false, selectedText: '', history: sideChatState.history, busy: false };
      renderSideChat();
    };
    const scIn = $('[data-sc-in]', sidePop);
    const sendSide = async () => {
      const q = (scIn?.value || '').trim();
      if (!q || sideChatState.busy) return;
      const prevHist = sideChatState.history.slice();
      sideChatState.history.push({ role: 'user', text: q });
      sideChatState.busy = true;
      renderSideChat();
      try {
        const res = await api('/api/transcript/sidechat', {
          method: 'POST',
          body: {
            sessionId: curSid || '',
            selectedText: sideChatState.selectedText,
            question: q,
            history: prevHist,
            agent: ag || 'claude',
          },
        });
        if (!res?.ok) throw new Error(res?.error || '응답 생성 실패');
        sideChatState.history.push({ role: 'assistant', text: res.reply || '' });
      } catch (err) {
        sideChatState.history.push({ role: 'assistant', text: `⚠ ${err.message}` });
      } finally {
        sideChatState.busy = false;
        if (sideChatState.open) {
          renderSideChat();
          $('[data-sc-in]', sidePop)?.focus();
        }
      }
    };
    $('[data-sc-send]', sidePop).onclick = sendSide;
    scIn?.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.isComposing) { ev.preventDefault(); sendSide(); }
    });
    scIn?.focus();
  };

  let pendingSelText = '';
  msgsHost.addEventListener('mouseup', () => {
    setTimeout(() => {
      if (!msgsHost.isConnected) return;
      const sel = window.getSelection();
      const txt = sel ? sel.toString().trim() : '';
      if (!txt || txt.length < 2 || !sel.rangeCount || !msgsHost.contains(sel.getRangeAt(0).commonAncestorContainer)) {
        sideFab.hidden = true;
        pendingSelText = '';
        return;
      }
      pendingSelText = txt.slice(0, 3000);
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      const boxRect = box.getBoundingClientRect();
      const top = Math.max(8, rect.bottom - boxRect.top + 6);
      const left = Math.max(8, Math.min(boxRect.width - 120, rect.left - boxRect.left));
      sideFab.style.top = `${top}px`;
      sideFab.style.left = `${left}px`;
      sideFab.hidden = false;
    }, 10);
  });
  sideFab.onclick = () => {
    if (!pendingSelText) return;
    sideChatState = { open: true, selectedText: pendingSelText, history: sideChatState.history || [], busy: false };
    sideFab.hidden = true;
    try { window.getSelection()?.removeAllRanges(); } catch {}
    renderSideChat();
  };
  if (sideChatState.open) renderSideChat();

  let lastSig = '';
  let lastLiveMode = '';
  let lastMessages = [];
  let msgLimit = 120;
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
      termRead = await api(`/api/term/read?id=${encodeURIComponent(lt.id)}&lines=30`).catch(() => null);
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

    let conLines = null;
    let conPreview = '';
    if (!lt && conPid) {
      const cr = await api(`/api/console/read?pid=${encodeURIComponent(conPid)}`).catch(() => null);
      if (gen !== viewGen || !container.isConnected) return false;
      if (cr?.ok && Array.isArray(cr.lines)) {
        conLines = cr.lines;
        if (rawBusy || wasWorking || hint) conPreview = formatLiveTermPreview(cr.lines, 14);
      }
    }

    const interactive = parseInteractivePrompt(termRead?.ok ? termRead.lines : conLines);
    const activeWorking = rawBusy || wasWorking || !!hint || !!interactive;
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
    const expectedUser = hint?.submittedText && hint.submittedText !== hint.pendingText
      ? norm(hint.submittedText) : norm(hint?.pendingText || '').slice(0, 60);
    const showPendingUser = !!(hint?.pendingText && (!lastUser || !norm(lastUser.text).includes(expectedUser)));
    const canImmediate = !!(showPendingUser && (lt || conPid));
    const hasScreen = !!(showLiveScreen && preview);
    const hasToggle = !!preview;
    const modeKey = `${showPendingUser ? hint.pendingText : ''}|${canImmediate ? 'imm1' : 'imm0'}|${hasScreen ? 'pre' : 'dots'}|${hasToggle ? '1' : '0'}|${interactive?.key || ''}`;
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
    if (liveHost.contains(document.activeElement) && document.activeElement?.matches?.('input, textarea')) return true;
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

    const promptHtml = interactive ? `<div class="chat-prompt-card" data-prompt-card>
      <div class="chat-prompt-q">${esc(interactive.question)}</div>
      <div class="chat-prompt-opts">${interactive.choices.map((c, idx) => `<button type="button" class="chat-prompt-opt${c.selected ? ' on' : ''}" data-prompt-idx="${idx}">
        <span class="chat-prompt-num">${c.num}</span>
        <span class="chat-prompt-lbl">${esc(c.label)}</span>
      </button>`).join('')}</div>
      <div class="chat-prompt-write" data-prompt-write hidden>
        <input type="text" data-prompt-write-in placeholder="직접 입력할 내용을 작성하세요…">
        <button type="button" class="primary btn-sm" data-prompt-write-send>전송</button>
      </div>
      <div class="chat-prompt-foot">
        <button type="button" class="ghost btn-sm" data-prompt-esc>Esc 건너뛰기</button>
      </div>
    </div>` : '';

    liveHost.innerHTML = `${userHtml}<div class="msg assistant msg-live" aria-live="polite">
      <div class="msg-av">${agentIcon(ag || 'claude')}</div>
      <div class="msg-col">
        <div class="msg-hd">
          <span class="w-role">${esc(who)}</span>
          <span class="chat-working-pill">${interactive ? '선택 대기 중' : '작업 중 <span class="typing-dots" aria-hidden="true"><i></i><i></i><i></i></span>'}</span>
          <span style="flex:1"></span>
          ${toggleBtn}
        </div>
        <div class="msg-bubble">${promptHtml || bodyHtml}</div>
      </div>
    </div>`;

    if (interactive) {
      const sendKeys = async (keys, writeText = '') => {
        const target = resolveLiveTarget();
        if (!target.lt && !target.conPid) return toast('연결된 터미널을 찾을 수 없습니다', 4000, 'danger');
        liveHost.querySelectorAll('button, input').forEach((el) => { el.disabled = true; });
        try {
          const endpoint = target.lt ? '/api/term/send' : '/api/console/send';
          const baseBody = target.lt ? { id: target.lt.id } : { pid: target.conPid };
          const r = await api(endpoint, { method: 'POST', body: { ...baseBody, keys } });
          if (r && r.ok === false) throw new Error(r.error || '선택 전달에 실패했습니다.');
          if (writeText) {
            await new Promise((res) => setTimeout(res, 180));
            const r2 = await api(endpoint, { method: 'POST', body: { ...baseBody, text: writeText, submit: true } });
            if (r2 && r2.ok === false) throw new Error(r2.error || '직접 입력 전달에 실패했습니다.');
          }
          lastLiveMode = '';
          container._triggerPoll?.();
        } catch (err) {
          toast(err.message, 4000, 'danger');
          liveHost.querySelectorAll('button, input').forEach((el) => { el.disabled = false; });
        }
      };
      liveHost.querySelectorAll('[data-prompt-idx]').forEach((btn) => {
        btn.onclick = () => {
          const idx = Number(btn.dataset.promptIdx);
          const choice = interactive.choices[idx];
          if (!choice) return;
          const delta = idx - interactive.selectedIndex;
          const arrows = Array.from({ length: Math.abs(delta) }, () => (delta > 0 ? 'down' : 'up'));
          if (choice.isWriteIn) {
            const box = $('[data-prompt-write]', liveHost);
            const inp = $('[data-prompt-write-in]', liveHost);
            const sendBtn = $('[data-prompt-write-send]', liveHost);
            if (box && inp && sendBtn) {
              box.hidden = false;
              inp.focus();
              const submitWrite = () => {
                const val = inp.value.trim();
                if (!val) return;
                sendKeys([...arrows, 'enter'], val);
              };
              sendBtn.onclick = submitWrite;
              inp.onkeydown = (ev) => { if (ev.key === 'Enter' && !ev.isComposing) { ev.preventDefault(); submitWrite(); } };
              return;
            }
          }
          sendKeys([...arrows, 'enter']);
        };
      });
      $('[data-prompt-esc]', liveHost)?.addEventListener('click', () => sendKeys(['esc']));
    }

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
            ? await api('/api/term/send', { method: 'POST', body: { id: target.lt.id, text: curHint.pendingText, submit: true, immediate: true, resendIfMissing: true, clearDraft: true } })
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
  const linkUrls = (html) => String(html || '').replace(/(^|[\s(>])(https?:\/\/[^\s<>"']+)/g, (m, pre, rawUrl) => {
    let url = rawUrl;
    let trail = '';
    while (/[.,;:!?)\]]$/.test(url)) { trail = url.slice(-1) + trail; url = url.slice(0, -1); }
    if (!url) return m;
    return `${pre}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>${trail}`;
  });
  const tick = async (force = false) => {
    if (gen !== viewGen) return;
    if (state.sel.kind === 'term') {
      const t = state.terms.find((x) => String(x.id) === String(state.sel.id));
      const updated = t?.sessionId || resolveTermSessionId(t);
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
    const d = await api(`/api/transcript?id=${encodeURIComponent(curSid)}${jump ? '&at=' + at : `&limit=${msgLimit}`}`).catch((e) => ({ error: e.message }));
    if (gen !== viewGen) return;
    if (d.hidden) { msgsHost.textContent = d.error; return; }
    const parentSig = d.lineage?.parent ? `${d.lineage.parent.parentSessionId}:${d.lineage.parent.atIndex}` : '';
    const childSig = (d.lineage?.children || []).map((c) => `${c.id || ''}:${c.childSessionId || ''}:${c.atIndex}`).join(',');
    const sig = `${d.size || 0}:${d.total || 0}:${d.base || 0}:${d.rev || 0}:${d.title || ''}:${parentSig}:${childSig}`;
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
      const openToolIds = new Set([...msgsHost.querySelectorAll('details.toolgrp[open]')].map((el) => el.dataset.tgKey).filter(Boolean));
      const parts = [];
      let toolBuf = [];
      const branchChipsHTML = (gi) => {
        const list = branchesByIdx.get(gi);
        if (!list?.length) return '';
        return `<div class="msg-branches"><span class="msg-branch-lbl">${ICO.branch} 분기됨</span>${list.map((ch) => branchChipBtn(ch, false)).join('')}</div>`;
      };
      const flushTools = () => {
        if (!toolBuf.length) return;
        const tgKey = `${toolBuf[0].gi}:${toolBuf.length}`;
        const isOpen = openToolIds.has(tgKey) || openToolIds.has(String(toolBuf[0].gi));
        const toolBranches = toolBuf.map((x) => branchChipsHTML(x.gi)).filter(Boolean).join('');
        parts.push(`<details class="toolgrp" data-tg-key="${esc(tgKey)}"${isOpen ? ' open' : ''}><summary>도구 실행 ${toolBuf.length}건</summary><div class="toolgrp-body">${toolBuf.map((x) => `<div>${linkPaths(hl(x.m.text, terms))}</div>`).join('')}</div></details>${toolBranches}`);
        toolBuf = [];
      };
      let lastDay = '';
      d.messages.forEach((m, k) => {
        const isMetaNote = m.role === 'assistant' && /^⚙ \[(?:설정|터미널)/.test(m.text);
        const tool = m.role === 'assistant' && m.text.startsWith('⚙') && !isMetaNote;
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
        const quoteBtn = `<button class="ghost icon-btn btn-sm" data-quote-mi="${k}" aria-label="이 메시지 참조" title="이 메시지 참조"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"/></svg></button>`;
        const forkBtn = `<button class="ghost icon-btn btn-sm" data-fork-mi="${k}" aria-label="이 지점에서 분기 만들기" title="이 지점에서 분기 만들기">${ICO.branch}</button>`;
        const editBtn = m.role === 'user' ? `<button class="ghost icon-btn btn-sm" data-edit-mi="${k}" aria-label="이 메시지 수정" title="이 메시지 수정 · 재실행">${ICO.edit}</button>` : '';
        const editedBadge = m.edited ? `<span class="badge">수정됨</span>` : '';
        const branchOriginNote = gi === 0 && d.lineage?.parent
          ? `<div class="msg-branch-origin">${ICO.branch} <span>분기 시작 · 원본 #${d.lineage.parent.atIndex + 1}${d.lineage.parent.editedText ? ` · 요청: ${esc(String(d.lineage.parent.editedText).replace(/\s+/g, ' ').trim().slice(0, 80))}` : ''}</span></div>`
          : '';
        if (tool || isMetaNote) {
          parts.push(`<div class="msg tool${tgt ? ' target' : ''}" data-mi="${k}">${linkPaths(hl(rawTxt, terms))}</div>${branchChipsHTML(gi)}`);
        } else if (m.role === 'user') {
          const bodyHtml = linkUrls(linkPaths(hl(rawTxt, terms)));
          parts.push(`<div class="msg user${tgt ? ' target' : ''}" data-mi="${k}">${branchOriginNote}<div class="msg-bubble"><div class="msg-body">${bodyHtml}</div></div><div class="msg-meta">${editedBadge}<span class="msg-acts">${quoteBtn}${editBtn}${forkBtn}${copyBtn}</span>${when ? `<span>${esc(when)}</span>` : ''}</div>${branchChipsHTML(gi)}</div>`);
        } else {
          const bodyHtml = !terms.length ? md(rawTxt) : `<div class="msg-body" style="white-space:pre-wrap">${linkUrls(linkPaths(hl(rawTxt, terms)))}</div>`;
          parts.push(`<div class="msg assistant${tgt ? ' target' : ''}" data-mi="${k}"><div class="msg-av">${agentIcon(ag || 'claude')}</div><div class="msg-col"><div class="msg-hd"><span class="w-role">${esc(who)}</span>${when ? `<span class="w-ts">${esc(when)}</span>` : ''}${editedBadge}<span style="flex:1"></span><span class="msg-acts">${quoteBtn}${forkBtn}${copyBtn}</span></div><div class="msg-bubble">${bodyHtml}</div>${branchChipsHTML(gi)}</div></div>`);
        }
      });
      flushTools();
      const prevHeight = v.scrollHeight;
      const prevTop = v.scrollTop;
      const olderBanner = b > 0
        ? `<div class="row" style="justify-content:center;gap:8px;margin-bottom:8px"><span class="ums" style="margin:0">… 이전 메시지 ${b}개 생략</span>${!jump ? `<button type="button" class="btn-sm" data-load-older="1">이전 메시지 더 보기</button>` : ''}</div>`
        : '';
      msgsHost.innerHTML = lineageBanner + olderBanner + (parts.join('') || '<div class="empty">메시지 없음</div>') + more;
      const loadOlderBtn = $('[data-load-older]', msgsHost);
      if (loadOlderBtn) {
        loadOlderBtn.onclick = async () => {
          loadOlderBtn.disabled = true;
          msgLimit = Math.min(2000, msgLimit + 160);
          lastSig = '';
          const beforeH = v.scrollHeight;
          const beforeT = v.scrollTop;
          await tick(true);
          if (v.isConnected && v.scrollHeight > beforeH) v.scrollTop = beforeT + (v.scrollHeight - beforeH);
        };
      }
      window.ACH_PREVIEW?.hydrateMermaid(msgsHost);
      window.ACH_PREVIEW?.scanChatBlocks(msgsHost);
      msgsHost.onclick = (e) => {
        const qb = e.target.closest('[data-quote-mi]');
        if (qb) {
          const k = Number(qb.dataset.quoteMi);
          const m = d.messages[k];
          if (m) {
            const shell = msgsHost.closest('.chat-shell') || document;
            const compHost = shell.querySelector('.chat-comp-host') || document.querySelector('.chat-comp-host');
            compHost?._setQuote?.({
              index: b + k + 1,
              author: m.role === 'user' ? '사용자' : (who || 'Assistant'),
              text: String(m.text || ''),
            });
          }
          return;
        }
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
    const linkTokens = [];
    const withMdLinks = masked
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/~~([^~]+)~~/g, '<s>$1</s>')
      .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, lbl, href) => {
        linkTokens.push(`<a href="${href}" target="_blank" rel="noopener noreferrer">${lbl}</a>`);
        return `\u0000L${linkTokens.length - 1}\u0000`;
      })
      .replace(/\[([^\]]+)\]\(file:\/\/\/?([^)#\s]+)(?:#[^)\s]*)?\)/gi, (_, lbl, rawPath) => {
        const cleanPath = rawPath.replace(/\//g, '\\');
        linkTokens.push(`<a class="filechip artlink" data-apath="${cleanPath}" title="${cleanPath}">${lbl}</a>`);
        return `\u0000L${linkTokens.length - 1}\u0000`;
      })
      .replace(/\[([^\]]+)\]\(conversation:\/\/[^)\s]+\)/gi, (_, lbl) => {
        linkTokens.push(`<span class="filechip">${lbl}</span>`);
        return `\u0000L${linkTokens.length - 1}\u0000`;
      })
      .replace(/(^|[\s(>])(https?:\/\/[^\s<>"'\u0000]+)/g, (m, pre, rawUrl) => {
        let url = rawUrl;
        let trail = '';
        while (/[.,;:!?)\]]$/.test(url)) { trail = url.slice(-1) + trail; url = url.slice(0, -1); }
        if (!url) return m;
        return `${pre}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>${trail}`;
      });
    return withMdLinks
      .replace(/\u0000L(\d+)\u0000/g, (_, idx) => linkTokens[Number(idx)] || '')
      .replace(/\u0000C(\d+)\u0000/g, (_, idx) => spans[Number(idx)] || '');
  };
  const out = [];
  let i = 0, list = null, para = [];
  const flushPara = () => { if (para.length) { out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; } };
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
