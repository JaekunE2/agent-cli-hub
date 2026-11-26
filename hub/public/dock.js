// Flexible multi-pane docking workspace for Terminal · Chat Transcript · Open Windows
'use strict';
(function () {
  const ORDER_KEY = 'ach.dockOrder.v1';
  const SIZES_KEY = 'ach.dockSizes.v1';
  const OPEN_TERM_KEY = 'ach.dockOpen.term.v1';
  const OPEN_RECENT_KEY = 'ach.dockOpen.recent.v1';
  const ALL_PANES = ['term', 'chat', 'windows'];

  function loadJson(key, fallback) {
    try {
      const v = JSON.parse(localStorage.getItem(key) || 'null');
      return v ?? fallback;
    } catch {
      return fallback;
    }
  }
  function saveJson(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
  }

  function getDockOrder() {
    const raw = loadJson(ORDER_KEY, null);
    if (Array.isArray(raw)) {
      const valid = raw.filter((x) => ALL_PANES.includes(x));
      for (const p of ALL_PANES) if (!valid.includes(p)) valid.push(p);
      return valid;
    }
    return [...ALL_PANES];
  }
  function saveDockOrder(order) {
    saveJson(ORDER_KEY, order.filter((x) => ALL_PANES.includes(x)));
  }

  function getDockSizes() {
    const raw = loadJson(SIZES_KEY, null);
    return {
      term: Number(raw?.term) > 0.2 ? Number(raw.term) : 1,
      chat: Number(raw?.chat) > 0.2 ? Number(raw.chat) : 1.0,
      windows: Number(raw?.windows) > 0.2 ? Number(raw.windows) : 0.9,
    };
  }
  function saveDockSizes(sizes) {
    saveJson(SIZES_KEY, sizes);
  }

  function getDockOpen(mode, explicitTab = null) {
    if (explicitTab === 'screen') return ['term'];
    if (explicitTab === 'split') return ['term', 'chat'];
    if (explicitTab === 'chat' && mode === 'term') return ['chat'];
    const key = mode === 'recent' ? OPEN_RECENT_KEY : OPEN_TERM_KEY;
    const saved = loadJson(key, null);
    if (Array.isArray(saved) && saved.length) {
      const valid = saved.filter((x) => ALL_PANES.includes(x));
      if (valid.length) return valid;
    }
    if (mode === 'recent') return ['chat'];
    try {
      const old = localStorage.getItem('ach-term-tab');
      if (old === 'screen') return ['term'];
      if (old === 'chat') return ['chat'];
    } catch {}
    return ['term', 'chat'];
  }

  function saveDockOpen(mode, openList) {
    const key = mode === 'recent' ? OPEN_RECENT_KEY : OPEN_TERM_KEY;
    const valid = [...new Set(openList.filter((x) => ALL_PANES.includes(x)))];
    if (valid.length) saveJson(key, valid);
  }

  function mountWindowsPane({ rootEl, termId = null, consolePid = null, cwd = '', gen, isOpen = () => true, onCount = null }) {
    if (!rootEl) return;
    let winList = [];
    let selectedHwnd = 'all';
    let winAuto = true;
    let winShowAll = false;
    let snapNonce = Date.now();
    let winPollTimer = null;
    let snapTimer = null;

    rootEl.innerHTML = `<div class="win-bar">
        <div class="win-tabs" data-w-tabs></div>
        <div class="row" style="gap:6px;flex:none">
          <button type="button" class="btn-sm primary" data-w-new title="새 창 · 터미널 · PowerShell · cmd · Ubuntu 열기">${UI_ICO.plus}<span>새 창 열기</span></button>
          <label class="win-auto-lbl" title="현재 세션이 제어하는 창 외에 PC의 모든 열린 창 표시"><input type="checkbox" data-w-all> 전체 창</label>
          <label class="win-auto-lbl"><input type="checkbox" data-w-auto checked> 자동 갱신</label>
          <button type="button" class="btn-sm" data-w-refresh title="창 목록 · 스냅샷 새로고침">${UI_ICO.refresh}<span>새로고침</span></button>
        </div>
      </div>
      <div class="win-body" data-w-body><div class="empty">열린 창을 확인하는 중…</div></div>`;

    const openLightbox = (w) => {
      const dlg = document.createElement('dialog');
      dlg.className = 'pj-dialog';
      dlg.style.width = 'min(1040px, 95vw)';
      dlg.setAttribute('aria-label', w.title || '창 미리보기');
      const authTok = () => (typeof TOKEN !== 'undefined' ? TOKEN : (window.TOKEN || ''));
      const shotUrl = () => `/api/window/shot?hwnd=${encodeURIComponent(w.hwnd)}&w=1280&t=${encodeURIComponent(authTok())}&ts=${Date.now()}`;
      dlg.innerHTML = `<div style="display:flex;flex-direction:column;gap:10px">
        <div class="dlg-head">
          <div style="min-width:0"><h3 style="margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(w.title)}</h3><small class="ums" style="margin:0">${esc(w.exe)} · ${w.rect.width}×${w.rect.height}</small></div>
          <div class="row" style="gap:6px">
            <button type="button" class="btn-sm" id="lbFocus">${UI_ICO.external} 창 앞으로</button>
            <button type="button" class="btn-sm" id="lbRefresh">${UI_ICO.refresh} 새로고침</button>
            <button type="button" class="ghost icon-btn btn-sm" data-lb-close aria-label="닫기">${UI_ICO.close}</button>
          </div>
        </div>
        <div class="win-shot" style="max-height:74vh;aspect-ratio:auto"><img id="lbImg" src="${shotUrl()}" alt="${esc(w.title)}"></div>
      </div>`;
      document.body.append(dlg);
      dlg.onclose = () => dlg.remove();
      $('[data-lb-close]', dlg).onclick = () => dlg.close();
      $('#lbRefresh', dlg).onclick = () => { $('#lbImg', dlg).src = shotUrl(); };
      $('#lbFocus', dlg).onclick = () => api('/api/window/focus', { method: 'POST', body: { hwnd: w.hwnd } });
      dlg.showModal();
    };

    const renderWindows = () => {
      onCount?.(winList.length);
      if (!isOpen()) return;
      const tabsEl = $('[data-w-tabs]', rootEl);
      const bodyEl = $('[data-w-body]', rootEl);
      if (!tabsEl || !bodyEl) return;

      if (selectedHwnd !== 'all' && !winList.some((w) => String(w.hwnd) === String(selectedHwnd))) {
        selectedHwnd = winList.length === 1 ? String(winList[0].hwnd) : 'all';
      }
      if (winList.length > 1) {
        tabsEl.innerHTML = `<button type="button" class="btn-sm${selectedHwnd === 'all' ? ' on' : ''}" data-win-sel="all">전체 (${winList.length})</button>`
          + winList.map((w, idx) => `<button type="button" class="btn-sm${String(w.hwnd) === String(selectedHwnd) ? ' on' : ''}" data-win-sel="${esc(w.hwnd)}" title="${esc(w.title)}">${idx + 1}. ${esc(w.title)}</button>`).join('');
      } else {
        tabsEl.innerHTML = winList.length
          ? `<span class="badge">${esc(winList[0].exe)}</span><span style="font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(winList[0].title)}</span>`
          : `<span class="ums" style="margin:0">감지된 창 없음</span>`;
      }

      if (!winList.length) {
        bodyEl.innerHTML = `<div class="h-empty-card" style="margin:12px auto">
          <b>${winShowAll ? '감지된 열린 창이 없습니다' : '이 세션에서 제어 중인 창이 없습니다'}</b>
          <span class="ums">${winShowAll
            ? '실행 중인 데스크톱 창이나 브라우저가 열리면 여기에 미리보기가 표시됩니다.'
            : '에이전트가 브라우저(Playwright·AGY), GUI 앱 또는 새 창을 실행하면 자동으로 표시됩니다. PC의 다른 창을 보려면 우측 상단 "전체 창"을 켜세요.'}</span>
        </div>`;
        return;
      }

      const targets = selectedHwnd === 'all' ? winList : winList.filter((w) => String(w.hwnd) === String(selectedHwnd));
      const singleMode = targets.length === 1;
      const widthParam = singleMode ? 1080 : 620;
      const cardsHTML = targets.map((w) => {
        const originBadge = w.linked ? '<span class="badge c">세션 제어</span>'
          : w.controlled ? '<span class="badge c">자동 제어</span>'
            : w.hubChild ? '<span class="badge">Hub 실행</span>'
              : w.browser ? '<span class="badge">브라우저</span>'
                : w.cliApp ? '<span class="badge">앱 · CLI</span>'
                  : '<span class="badge">실행 창</span>';
        const sz = w.minimized ? '최소화됨' : `${w.rect.width}×${w.rect.height}`;
        const authTok = typeof TOKEN !== 'undefined' ? TOKEN : (window.TOKEN || '');
        const shotHtml = w.minimized
          ? `<div class="win-shot-empty"><span>창이 최소화되어 있어 화면을 캡처할 수 없습니다.</span><button type="button" class="btn-sm" data-win-focus="${esc(w.hwnd)}">${UI_ICO.external} 창 복원 · 앞으로</button></div>`
          : `<img src="/api/window/shot?hwnd=${encodeURIComponent(w.hwnd)}&w=${widthParam}&t=${encodeURIComponent(authTok)}&ts=${snapNonce}" alt="${esc(w.title)}" loading="lazy">`;
        return `<article class="win-card${singleMode ? ' win-single' : ''}">
          <div class="win-card-hd">${originBadge}<span class="win-card-title" title="${esc(w.title)}">${esc(w.title)}</span><span class="badge">${esc(w.exe)}</span></div>
          <div class="win-shot" data-win-zoom="${esc(w.hwnd)}">${shotHtml}</div>
          <div class="win-card-ft">
            <span>${esc(sz)}</span>
            <div class="row" style="gap:4px">
              ${singleMode && winList.length > 1 ? `<button type="button" class="ghost btn-sm" data-win-sel="all">전체 보기</button>` : ''}
              <button type="button" class="btn-sm" data-win-zoom="${esc(w.hwnd)}">크게 보기</button>
              <button type="button" class="btn-sm" data-win-focus="${esc(w.hwnd)}" title="이 창을 화면 맨 앞으로 가져오기">${UI_ICO.external} 앞으로</button>
            </div>
          </div>
        </article>`;
      }).join('');
      bodyEl.innerHTML = singleMode ? cardsHTML : `<div class="win-grid">${cardsHTML}</div>`;
    };

    const currentViewGen = () => (typeof viewGen === 'number' ? viewGen : window.viewGen);
    const refreshWindows = async (refreshSnaps = true) => {
      if (gen !== currentViewGen() || !rootEl.isConnected) return;
      const qs = `${termId ? `id=${encodeURIComponent(termId)}` : `pid=${encodeURIComponent(consolePid || 0)}`}&all=${winShowAll ? '1' : '0'}`;
      const r = await api(`/api/term/windows?${qs}`).catch(() => ({ windows: [] }));
      if (gen !== currentViewGen() || !rootEl.isConnected) return;
      winList = r.windows || [];
      if (refreshSnaps) snapNonce = Date.now();
      renderWindows();
    };

    rootEl.addEventListener('click', async (e) => {
      const selBtn = e.target.closest('[data-win-sel]');
      if (selBtn) {
        selectedHwnd = selBtn.dataset.winSel;
        snapNonce = Date.now();
        renderWindows();
        return;
      }
      const focusBtn = e.target.closest('[data-win-focus]');
      if (focusBtn) {
        await api('/api/window/focus', { method: 'POST', body: { hwnd: Number(focusBtn.dataset.winFocus) } });
        setTimeout(() => refreshWindows(true), 350);
        return;
      }
      const zoomEl = e.target.closest('[data-win-zoom]');
      if (zoomEl) {
        const w = winList.find((x) => String(x.hwnd) === String(zoomEl.dataset.winZoom));
        if (w && !w.minimized) openLightbox(w);
      }
    });

    $('[data-w-new]', rootEl).onclick = () => { if (typeof openNewTermDrawer === 'function') openNewTermDrawer(cwd || ''); };
    $('[data-w-refresh]', rootEl).onclick = () => refreshWindows(true);
    $('[data-w-auto]', rootEl).onchange = (e) => { winAuto = !!e.target.checked; };
    $('[data-w-all]', rootEl).onchange = (e) => { winShowAll = !!e.target.checked; refreshWindows(true); };

    refreshWindows(false);
    winPollTimer = setInterval(() => {
      if (gen !== currentViewGen() || !rootEl.isConnected) { clearInterval(winPollTimer); clearInterval(snapTimer); return; }
      refreshWindows(false);
    }, 4500);
    snapTimer = setInterval(() => {
      if (gen !== currentViewGen() || !rootEl.isConnected) { clearInterval(winPollTimer); clearInterval(snapTimer); return; }
      if (isOpen() && winAuto && winList.some((w) => !w.minimized)) {
        snapNonce = Date.now();
        rootEl.querySelectorAll('[data-w-body] img[src*="/api/window/shot"]').forEach((img) => {
          img.src = img.src.replace(/ts=\d+/, `ts=${snapNonce}`);
        });
      }
    }, 2200);

    return { refreshWindows, renderWindows };
  }

  // Create a composable, drag-reorderable, multi-resizer docking workspace
  function createDockWorkspace({ hostEl, mode, openPanels, panelsMeta, onOpenChange }) {
    let order = getDockOrder();
    let sizes = getDockSizes();
    const openSet = new Set(openPanels.filter((p) => panelsMeta[p]));
    if (!openSet.size) {
      const firstAvail = order.find((p) => panelsMeta[p]);
      if (firstAvail) openSet.add(firstAvail);
    }

    const wsEl = document.createElement('div');
    wsEl.className = 'dock-ws';
    hostEl.innerHTML = '';
    hostEl.appendChild(wsEl);

    const paneEls = new Map();
    const bodyEls = new Map();
    const gripSvg = '<span class="dock-grip" aria-hidden="true"><svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor"><circle cx="2.5" cy="2.5" r="1.15"/><circle cx="7.5" cy="2.5" r="1.15"/><circle cx="2.5" cy="7" r="1.15"/><circle cx="7.5" cy="7" r="1.15"/><circle cx="2.5" cy="11.5" r="1.15"/><circle cx="7.5" cy="11.5" r="1.15"/></svg></span>';

    for (const id of order) {
      const meta = panelsMeta[id];
      if (!meta) continue;
      const pane = document.createElement('section');
      pane.className = 'dock-pane';
      pane.dataset.dockPane = id;
      pane.hidden = !openSet.has(id);
      pane.style.flex = `${sizes[id] || 1} 1 0`;
      pane.innerHTML = `
        <header class="dock-hd" draggable="true" title="드래그하여 패널 위치 이동">
          ${gripSvg}
          <span class="dock-hd-ico">${meta.icon || ''}</span>
          <span class="dock-hd-title">${esc(meta.title)}</span>
          <span class="dock-hd-extra"></span>
          <div class="dock-hd-acts">
            <button type="button" class="ghost icon-btn btn-sm dock-mv" data-dock-mv="-1" title="패널 왼쪽으로 이동" aria-label="패널 왼쪽으로 이동">${UI_ICO.chevLeft}</button>
            <button type="button" class="ghost icon-btn btn-sm dock-mv" data-dock-mv="1" title="패널 오른쪽으로 이동" aria-label="패널 오른쪽으로 이동">${UI_ICO.chevRight}</button>
            <button type="button" class="ghost icon-btn btn-sm" data-dock-close="${esc(id)}" title="이 패널 닫기" aria-label="이 패널 닫기">${UI_ICO.close}</button>
          </div>
        </header>
        <div class="dock-body"></div>`;
      paneEls.set(id, pane);
      bodyEls.set(id, $('.dock-body', pane));
    }

    let draggingId = null;

    const rebuildLayout = () => {
      // Snapshot scrollable descendants BEFORE any DOM move/resize so panels never jump back to top
      const scrollSnapshots = [];
      for (const pane of paneEls.values()) {
        for (const sc of pane.querySelectorAll('.chat-scroll, .win-body, .screen, .chat-live-pre')) {
          if (sc.scrollHeight > sc.clientHeight) {
            scrollSnapshots.push({
              el: sc,
              top: sc.scrollTop,
              wasBottom: sc.scrollHeight - sc.scrollTop - sc.clientHeight < 48,
            });
          }
        }
      }
      // Remove existing resizers without detaching pane DOM nodes unnecessarily
      wsEl.querySelectorAll('.dock-resizer').forEach((r) => r.remove());
      const visibleIds = order.filter((id) => paneEls.has(id) && openSet.has(id));
      const curDomOrder = [...wsEl.querySelectorAll(':scope > .dock-pane')].map((n) => n.dataset.dockPane);
      const targetOrder = order.filter((id) => paneEls.has(id));
      const orderChanged = curDomOrder.length !== targetOrder.length || curDomOrder.some((id, idx) => id !== targetOrder[idx]);
      for (const id of order) {
        const el = paneEls.get(id);
        if (!el) continue;
        el.hidden = !openSet.has(id);
        el.classList.toggle('single', visibleIds.length === 1 && openSet.has(id));
        if (orderChanged) wsEl.appendChild(el);
      }
      // Insert draggable split resizers between every two visible panes
      for (let i = 0; i < visibleIds.length - 1; i++) {
        const leftId = visibleIds[i];
        const rightId = visibleIds[i + 1];
        const leftEl = paneEls.get(leftId);
        const rightEl = paneEls.get(rightId);
        const res = document.createElement('div');
        res.className = 'dock-resizer';
        res.setAttribute('role', 'separator');
        res.setAttribute('aria-orientation', 'vertical');
        res.setAttribute('aria-label', '패널 크기 조절');
        wsEl.insertBefore(res, rightEl);

        res.addEventListener('pointerdown', (e) => {
          if (window.innerWidth <= 1040) return;
          e.preventDefault();
          res.setPointerCapture?.(e.pointerId);
          res.classList.add('dragging');
          const startX = e.clientX;
          const lw = leftEl.getBoundingClientRect().width;
          const rw = rightEl.getBoundingClientRect().width;
          const sumW = lw + rw;
          const lf0 = Number(sizes[leftId]) || 1;
          const rf0 = Number(sizes[rightId]) || 1;
          const sumF = lf0 + rf0;
          const move = (ev) => {
            if (sumW <= 120) return;
            const dx = ev.clientX - startX;
            const minWidth = (id) => Math.min(id === 'chat' ? 400 : 260, sumW * (id === 'chat' ? 0.44 : 0.30));
            const nextLw = Math.max(minWidth(leftId), Math.min(sumW - minWidth(rightId), lw + dx));
            const ratio = nextLw / sumW;
            sizes[leftId] = Math.max(0.25, sumF * ratio);
            sizes[rightId] = Math.max(0.25, sumF * (1 - ratio));
            leftEl.style.flex = `${sizes[leftId].toFixed(3)} 1 0`;
            rightEl.style.flex = `${sizes[rightId].toFixed(3)} 1 0`;
            saveDockSizes(sizes);
          };
          const up = () => {
            res.classList.remove('dragging');
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            window.dispatchEvent(new Event('resize'));
          };
          window.addEventListener('pointermove', move);
          window.addEventListener('pointerup', up);
        });
      }
      const restoreScroll = () => {
        for (const s of scrollSnapshots) {
          if (!s.el.isConnected) continue;
          s.el.scrollTop = s.wasBottom ? s.el.scrollHeight : s.top;
        }
      };
      restoreScroll();
      saveDockOpen(mode, [...openSet]);
      onOpenChange?.([...openSet], [...order]);
      requestAnimationFrame(() => {
        restoreScroll();
        window.dispatchEvent(new Event('resize'));
      });
    };

    const moveOrder = (id, targetId, after) => {
      if (!id || !targetId || id === targetId) return;
      const next = order.filter((x) => x !== id);
      const ti = next.indexOf(targetId);
      if (ti < 0) return;
      next.splice(after ? ti + 1 : ti, 0, id);
      order = next;
      saveDockOrder(order);
      rebuildLayout();
    };

    const shiftPane = (id, dir) => {
      const vis = order.filter((x) => paneEls.has(x) && openSet.has(x));
      const vi = vis.indexOf(id);
      const targetId = vis[vi + dir];
      if (!targetId) return;
      moveOrder(id, targetId, dir > 0);
    };

    for (const [id, pane] of paneEls.entries()) {
      const hd = $('.dock-hd', pane);
      hd.addEventListener('dragstart', (e) => {
        if (e.target.closest('button, input, label')) { e.preventDefault(); return; }
        draggingId = id;
        pane.classList.add('dragging');
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', id);
        }
      });
      hd.addEventListener('dragend', () => {
        draggingId = null;
        paneEls.forEach((p) => p.classList.remove('dragging', 'drop-left', 'drop-right'));
      });
      pane.addEventListener('dragover', (e) => {
        if (!draggingId || draggingId === id) return;
        e.preventDefault();
        const rect = pane.getBoundingClientRect();
        const after = (e.clientX - rect.left) > rect.width / 2;
        pane.classList.toggle('drop-left', !after);
        pane.classList.toggle('drop-right', after);
      });
      pane.addEventListener('dragleave', (e) => {
        if (!pane.contains(e.relatedTarget)) {
          pane.classList.remove('drop-left', 'drop-right');
        }
      });
      pane.addEventListener('drop', (e) => {
        if (!draggingId || draggingId === id) return;
        e.preventDefault();
        const rect = pane.getBoundingClientRect();
        const after = (e.clientX - rect.left) > rect.width / 2;
        paneEls.forEach((p) => p.classList.remove('dragging', 'drop-left', 'drop-right'));
        moveOrder(draggingId, id, after);
        draggingId = null;
      });
      pane.addEventListener('click', (e) => {
        const mv = e.target.closest('[data-dock-mv]');
        if (mv) { shiftPane(id, Number(mv.dataset.dockMv)); return; }
        const cls = e.target.closest('[data-dock-close]');
        if (cls) { togglePanel(cls.dataset.dockClose, false); }
      });
    }

    const togglePanel = (id, forceState = null) => {
      if (!paneEls.has(id)) return false;
      const next = forceState === null ? !openSet.has(id) : !!forceState;
      if (!next && openSet.size <= 1) {
        if (typeof toast === 'function') toast('최소 하나의 패널은 열려 있어야 합니다', 2200);
        return false;
      }
      if (next) openSet.add(id);
      else openSet.delete(id);
      rebuildLayout();
      if (next) panelsMeta[id]?.onShow?.();
      return true;
    };

    rebuildLayout();

    return {
      wsEl,
      getBody: (id) => bodyEls.get(id) || null,
      getExtra: (id) => paneEls.get(id) ? $('.dock-hd-extra', paneEls.get(id)) : null,
      isOpen: (id) => openSet.has(id),
      getOpen: () => [...openSet],
      getOrder: () => [...order],
      togglePanel,
      moveOrder,
    };
  }

  window.ACH_DOCK = {
    getDockOrder,
    getDockOpen,
    saveDockOpen,
    createDockWorkspace,
    mountWindowsPane,
  };
})();
