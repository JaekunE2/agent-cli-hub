// Shared Astryx-aligned UI primitives: Icons, Floating Toast, MoreMenu popover, Dialogs, Split ResizeHandle
'use strict';
(function () {
  const svg = (d, s = 14, sw = 1.8) =>
    `<span class="ico" aria-hidden="true"><svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${d}</svg></span>`;

  const UI_ICO = {
    home: svg('<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9.5"/>', 14),
    grid: svg('<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>', 14),
    terminal: svg('<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>', 14, 1.9),
    calendar: svg('<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>', 14),
    chart: svg('<path d="M18 20V10M12 20V4M6 20v-6"/>', 14),
    gpu: svg('<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3"/>', 14),
    refresh: svg('<path d="M21 12a9 9 0 1 1-2.6-6.4L21 8"/><path d="M21 3v5h-5"/>', 13, 2),
    star: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 15.1 8.3 22 9.3 17 14.1 18.2 21 12 17.7 5.8 21 7 14.1 2 9.3 8.9 8.3 12 2"/></svg>',
    starFill: '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 15.1 8.3 22 9.3 17 14.1 18.2 21 12 17.7 5.8 21 7 14.1 2 9.3 8.9 8.3 12 2"/></svg>',
    clip: svg('<path d="m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/>', 14),
    folder: svg('<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>', 14),
    split: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="12" y1="3" x2="12" y2="21"/>', 14),
    eye: svg('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>', 14),
    code: svg('<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>', 14),
    copy: svg('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>', 13),
    close: svg('<path d="M18 6 6 18M6 6l12 12"/>', 14, 2),
    clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', 12, 2),
    settings: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.26.6.77 1.02 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/>', 14),
    more: svg('<circle cx="5" cy="12" r="1.5" fill="currentColor"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="19" cy="12" r="1.5" fill="currentColor"/>', 15, 1.5),
    trash: svg('<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>', 13),
    edit: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>', 13),
    external: svg('<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>', 13),
    keyboard: svg('<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M10 13h.01M14 13h.01M18 13h.01M8 16h8"/>', 14),
    help: svg('<circle cx="12" cy="12" r="9"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>', 14),
    chevDown: svg('<path d="m6 9 6 6 6-6"/>', 13, 2),
    chevUp: svg('<path d="m18 15-6-6-6 6"/>', 13, 2),
    plus: svg('<path d="M12 5v14M5 12h14"/>', 13, 2),
    swap: svg('<path d="m16 3 4 4-4 4"/><path d="M20 7H4"/><path d="m8 21-4-4 4-4"/><path d="M4 17h16"/>', 13),
    play: svg('<polygon points="6 4 20 12 6 20 6 4"/>', 12),
    flask: svg('<path d="M10 2v7.3L5 18a2 2 0 0 0 1.7 3h10.6a2 2 0 0 0 1.7-3l-5-8.7V2"/><path d="M8.5 2h7"/><path d="M7 16h10"/>', 14),
    search: svg('<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>', 14, 1.9),
    globe: svg('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>', 14),
    phone: svg('<rect x="6" y="2.5" width="12" height="19" rx="2.5"/><path d="M11 18h2"/>', 14),
    chevRight: svg('<path d="m9 18 6-6-6-6"/>', 13, 2),
    chevLeft: svg('<path d="m15 18-6-6 6-6"/>', 13, 2),
    arrowLeft: svg('<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>', 13, 2),
    arrowUp: svg('<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>', 13, 2),
    arrowUpRight: svg('<path d="M7 17 17 7"/><path d="M7 7h10v10"/>', 13, 2),
    sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>', 14),
    moon: svg('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/>', 14),
    monitor: svg('<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>', 14),
    bell: svg('<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>', 14),
    layers: svg('<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>', 13),
    check: svg('<polyline points="20 6 9 17 4 12"/>', 13, 2.2),
    chat: svg('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>', 13),
    spark: svg('<path d="m12 3 1.9 5.8L20 10.7l-6.1 1.9L12 18.4l-1.9-5.8L4 10.7l6.1-1.9Z"/>', 13),
    branch: svg('<circle cx="6" cy="6" r="2.6"/><circle cx="18" cy="8" r="2.6"/><circle cx="6" cy="18" r="2.6"/><path d="M6 8.6v6.8"/><path d="M18 10.6a7.4 7.4 0 0 1-7.4 7.4H8.6"/>', 13),
  };
  window.UI_ICO = UI_ICO;

  // ---------- Floating Toast (replaces #bar badge injection) ----------
  function ensureToastHost() {
    let host = document.getElementById('toastHost');
    if (!host) {
      host = document.createElement('div');
      host.id = 'toastHost';
      host.className = 'toast-host';
      host.setAttribute('aria-live', 'polite');
      document.body.appendChild(host);
    }
    return host;
  }

  function showToast(msg, ms = 4000, tone = 'default', action = null) {
    const host = ensureToastHost();
    while (host.children.length >= 4) host.firstElementChild.remove();
    const n = document.createElement('div');
    n.className = `toast-item${tone === 'danger' ? ' danger' : ''}`;
    n.setAttribute('role', tone === 'danger' ? 'alert' : 'status');
    const txt = document.createElement('span');
    txt.textContent = String(msg ?? '');
    n.appendChild(txt);
    const timer = setTimeout(() => n.remove(), ms);
    const origRemove = n.remove.bind(n);
    n.remove = () => { clearTimeout(timer); origRemove(); };
    if (action && action.label && action.onClick) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'toast-act';
      b.textContent = action.label;
      b.onclick = (e) => { e.stopPropagation(); n.remove(); action.onClick(); };
      n.appendChild(b);
    }
    if (action && action.onBodyClick) {
      n.style.cursor = 'pointer';
      n.onclick = () => { n.remove(); action.onBodyClick(); };
    }
    host.appendChild(n);
    return n;
  }
  window.showToast = showToast;

  // ---------- Astryx MoreMenu Popover ----------
  let activeMenu = null;
  function closeMoreMenu() {
    if (!activeMenu) return;
    const { el, anchor, onDocClick, onKey, onScroll } = activeMenu;
    document.removeEventListener('click', onDocClick, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onScroll);
    window.removeEventListener('scroll', onScroll, true);
    if (anchor) anchor.setAttribute('aria-expanded', 'false');
    el.remove();
    activeMenu = null;
  }
  window.closeMoreMenu = closeMoreMenu;

  function openMoreMenu(anchorEl, items) {
    const sameAnchor = activeMenu && activeMenu.anchor === anchorEl;
    closeMoreMenu();
    if (sameAnchor || !anchorEl || !items?.length) return null;

    const clean = [];
    for (const it of items) {
      if (!it) continue;
      if (it.divider) {
        if (clean.length && !clean[clean.length - 1].divider) clean.push(it);
      } else clean.push(it);
    }
    while (clean.length && clean[clean.length - 1].divider) clean.pop();
    if (!clean.length) return null;

    const menu = document.createElement('div');
    menu.className = 'more-menu';
    menu.setAttribute('role', 'menu');
    for (const it of clean) {
      if (it.divider) {
        const div = document.createElement('div');
        div.className = 'mm-div';
        div.setAttribute('role', 'separator');
        menu.appendChild(div);
        continue;
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `mm-item${it.tone === 'danger' ? ' danger' : ''}`;
      btn.setAttribute('role', 'menuitem');
      if (it.disabled) btn.disabled = true;
      btn.innerHTML = `${it.icon || ''}<span>${String(it.label ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))}</span>`;
      btn.onclick = (e) => {
        e.stopPropagation();
        closeMoreMenu();
        it.onClick?.(e);
      };
      menu.appendChild(btn);
    }
    document.body.appendChild(menu);

    const rect = anchorEl.getBoundingClientRect();
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    let left = rect.right - mw;
    let top = rect.bottom + 4;
    if (left < 8) left = Math.max(8, rect.left);
    if (left + mw > window.innerWidth - 8) left = window.innerWidth - mw - 8;
    if (top + mh > window.innerHeight - 8) top = Math.max(8, rect.top - mh - 4);
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
    anchorEl.setAttribute('aria-expanded', 'true');

    const focusables = () => [...menu.querySelectorAll('.mm-item:not(:disabled)')];
    const onDocClick = (e) => {
      if (menu.contains(e.target) || anchorEl.contains(e.target)) return;
      closeMoreMenu();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); closeMoreMenu(); anchorEl.focus(); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const list = focusables();
        if (!list.length) return;
        const i = list.indexOf(document.activeElement);
        const next = e.key === 'ArrowDown' ? (i + 1) % list.length : (i <= 0 ? list.length - 1 : i - 1);
        list[next].focus();
      }
    };
    const onScroll = (e) => { if (!e?.target || !menu.contains(e.target)) closeMoreMenu(); };
    setTimeout(() => {
      document.addEventListener('click', onDocClick, true);
      document.addEventListener('keydown', onKey, true);
      window.addEventListener('resize', onScroll);
      window.addEventListener('scroll', onScroll, true);
    }, 0);

    activeMenu = { el: menu, anchor: anchorEl, onDocClick, onKey, onScroll };
    return menu;
  }
  window.openMoreMenu = openMoreMenu;

  // ---------- Lightweight Estimate Dialog (replaces window.prompt) ----------
  function openEstimateDialog({ title = '예상 시간 설정', onSubmit }) {
    const d = document.createElement('dialog');
    d.className = 'pj-dialog est-dialog';
    d.setAttribute('aria-label', title);
    const escTxt = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    d.innerHTML = `<form>
      <div class="dlg-head"><h3>${escTxt(title)}</h3><button type="button" class="ghost icon-btn btn-sm" data-cancel aria-label="닫기">${UI_ICO.close}</button></div>
      <div class="row" style="gap:6px">
        <button type="button" class="btn-sm" data-preset="30m">30분</button>
        <button type="button" class="btn-sm" data-preset="1h">1시간</button>
        <button type="button" class="btn-sm" data-preset="2h">2시간</button>
        <button type="button" class="btn-sm" data-preset="4h">4시간</button>
      </div>
      <label>직접 입력 (예: 90m, 1h30m 또는 종료 시각 01:30)<input name="val" placeholder="예: 90m 또는 01:30" required></label>
      <div class="dlg-foot"><button type="button" data-cancel>취소</button><button class="primary" type="submit">적용</button></div>
    </form>`;
    document.body.appendChild(d);
    const inp = d.querySelector('input[name=val]');
    d.querySelectorAll('[data-cancel]').forEach((b) => (b.onclick = () => d.close()));
    d.querySelectorAll('[data-preset]').forEach((b) => (b.onclick = () => { inp.value = b.dataset.preset; d.querySelector('form').requestSubmit(); }));
    d.onclose = () => d.remove();
    d.querySelector('form').onsubmit = async (e) => {
      e.preventDefault();
      const v = inp.value.trim();
      if (!v) return;
      d.close();
      await onSubmit?.(v);
    };
    d.showModal();
    inp.focus();
    return d;
  }
  window.openEstimateDialog = openEstimateDialog;

  // ---------- Split Panel ResizeHandle ----------
  function bindSplitResizer(splitEl, leftEl, storageKey = 'ach.splitPct') {
    const handle = splitEl?.querySelector('.split-resizer');
    if (!handle || !leftEl) return;
    try {
      const saved = Number(localStorage.getItem(storageKey));
      if (saved >= 28 && saved <= 78) leftEl.style.flex = `0 0 ${saved}%`;
    } catch {}
    handle.addEventListener('pointerdown', (e) => {
      if (window.innerWidth <= 960) return;
      e.preventDefault();
      handle.setPointerCapture?.(e.pointerId);
      handle.classList.add('dragging');
      const rect = splitEl.getBoundingClientRect();
      const move = (ev) => {
        const pct = Math.max(28, Math.min(78, ((ev.clientX - rect.left) / rect.width) * 100));
        leftEl.style.flex = `0 0 ${pct.toFixed(1)}%`;
        try { localStorage.setItem(storageKey, pct.toFixed(1)); } catch {}
      };
      const up = () => {
        handle.classList.remove('dragging');
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.dispatchEvent(new Event('resize'));
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  }
  window.bindSplitResizer = bindSplitResizer;

  // ---------- Korean/CJK IME-safe single-Enter submit ----------
  function bindEnterSubmit(el, onSubmit) {
    if (!el || typeof onSubmit !== 'function') return;
    let pendingEnter = false;
    let compTimer = null;
    let lastFireAt = 0;
    const fire = () => {
      const now = Date.now();
      if (now - lastFireAt < 80) return;
      lastFireAt = now;
      onSubmit();
    };
    const flush = () => {
      if (!pendingEnter) return;
      pendingEnter = false;
      clearTimeout(compTimer);
      compTimer = null;
      setTimeout(fire, 0);
    };
    el.addEventListener('compositionend', flush);
    el.addEventListener('keydown', (e) => {
      const isEnter = e.key === 'Enter' || e.code === 'Enter' || e.code === 'NumpadEnter';
      if (!isEnter || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) {
        if (e.key !== 'Process') {
          pendingEnter = false;
          clearTimeout(compTimer);
        }
        return;
      }
      e.preventDefault();
      if (e.isComposing || e.keyCode === 229 || e.key === 'Process') {
        pendingEnter = true;
        clearTimeout(compTimer);
        compTimer = setTimeout(flush, 60);
        return;
      }
      pendingEnter = false;
      fire();
    });
  }
  window.bindEnterSubmit = bindEnterSubmit;
})();
