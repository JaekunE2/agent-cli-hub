// ---------- Embedded Xterm Mirrors, Consoles & Managed Terminals ----------
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
      <div class="tdock-comp" style="flex-direction:column;align-items:stretch;gap:6px">
        <div class="att-strip" id="cAttStrip" hidden style="margin:0;max-width:none"></div>
        <div class="row" style="gap:6px;align-items:flex-end;width:100%">
          <textarea id="inp" rows="1" placeholder="보낼 내용 입력 (Enter 전송 · Shift+Enter 줄바꿈 · 빈 칸에서 ↑↓/Esc는 창으로 전달)"></textarea>
          <button class="primary" id="btnSend">보내기 ⏎</button>
        </div>
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
  const cAttCtl = createAttachmentStrip($('#cAttStrip', fullEl), s?.cwd);
  const sendText = async () => {
    if (cAttCtl.isLoading()) return toast('첨부 파일을 준비하는 중입니다…');
    const paths = cAttCtl.takePaths();
    const raw = inp.value;
    const text = [...paths, raw].filter(Boolean).join(' ');
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
  attachFileInput(fullEl, addPath, s?.cwd, { onFiles: (fl, it) => cAttCtl.addFiles(fl, it) });
  bindFilePick(fullEl, addPath, s?.cwd, { onFiles: (fl, it) => cAttCtl.addFiles(fl, it) });
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
    <button id="btnConMore" class="ghost icon-btn btn-sm desk" aria-label="콘솔 메뉴" aria-haspopup="menu" aria-expanded="false">${ICO.more}</button>${barSystemBtnHTML()}`);

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
    const mounted = mountChatWorkspace(dock.getBody('chat'), {
      sid,
      gen,
      composerOpts: { consolePid: pid, agent: s?.agent || 'claude', cwd: s?.cwd || '', compact: true },
    });
    chatScrollEl = mounted?.scrollEl || null;
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
      <div class="tdock-comp" id="tDockComp" ${dockCollapsed ? 'hidden' : ''} style="flex-direction:column;align-items:stretch;gap:6px">
        <div class="att-strip" id="tAttStrip" hidden style="margin:0;max-width:none"></div>
        <div class="row" style="gap:6px;align-items:flex-end;width:100%">
          <textarea id="tin" rows="1" placeholder="프롬프트 입력 (Enter 전송 · 파일 첨부)" enterkeyhint="send"></textarea>
          <button class="primary" id="tsend" title="터미널에 프롬프트 전송 (Enter)">보내기 ⏎</button>
        </div>
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
  const tAttCtl = createAttachmentStrip($('#tAttStrip', fullEl), t?.cwd);
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
  const onTermFiles = (files, items) => {
    if (dockCollapsed) return false;
    tAttCtl.addFiles(files, items);
    return true;
  };
  attachFileInput(fullEl, insert, t?.cwd, {
    onFiles: onTermFiles,
    shouldPassCtrlV: (e, dt, files) => {
      const shifted = pasteWithShift;
      pasteWithShift = false;
      return !IS_REMOTE && !IS_MOBILE && !shifted && !!t?.agent && (files.length > 0 || !dt?.getData('text/plain'));
    },
    sendCtrlV: () => send('\x16'),
  });
  let histIdx = -1;
  const submit = () => {
    if (!dockCollapsed && tAttCtl.isLoading()) return toast('첨부 파일을 준비하는 중입니다…');
    const attPaths = !dockCollapsed ? tAttCtl.takePaths() : [];
    const typed = tin.value;
    const v = [...attPaths, typed].filter(Boolean).join(' ');
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
  bindFilePick(fullEl, insert, t?.cwd, { onFiles: onTermFiles });
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
    <button id="btnTermMore" class="ghost icon-btn btn-sm" aria-label="터미널 메뉴" aria-haspopup="menu" aria-expanded="false">${ICO.more}</button>${barSystemBtnHTML()}`);

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
    const mounted = mountChatWorkspace(dock.getBody('chat'), {
      sid,
      gen,
      composerOpts: { termId: t?.id || state.sel.id, agent: ag || 'claude', cwd: t?.cwd || pj?.cwd || '', compact: true },
    });
    chatScrollEl = mounted?.scrollEl || null;
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
