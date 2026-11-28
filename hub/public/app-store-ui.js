// App Store view (Apps → 앱 스토어): Browse (featured banner, category rows, search, category chips), app pages
// (screenshots with a lightbox, what's new, what it installs/runs, source and version before install), 내 앱 (open /
// update / stop / settings / uninstall) and 앱 등록 (check a repo, add it here, submit it to a registry).
// Motion: transform / opacity only; View Transitions between a card and its app page when the browser has them;
// prefers-reduced-motion turns it off. Styles: app-store.css. Installs go through the review dialog in apps-ui.js.
'use strict';
(function () {
  const H = () => window.appStoreHelpers;
  const reduce = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  let data = null;          // { entries, sources, submitUrls, unavailable, hubVersion }
  let route = { page: 'home' };
  let query = '', cat = '';

  // ---------- small pieces ----------
  const SVG = {
    search: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
    left: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>',
    right: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>',
    ring: '<svg class="ring" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>',
  };
  // simple inline illustrations for empty / error states (theme colours through currentColor)
  const art = (kind) => {
    const box = '<rect x="22" y="30" width="96" height="64" rx="14" fill="currentColor" opacity=".12"/>';
    const shapes = {
      empty: `${box}<rect x="38" y="46" width="22" height="22" rx="7" fill="currentColor" opacity=".55"/><rect x="66" y="48" width="36" height="6" rx="3" fill="currentColor" opacity=".35"/><rect x="66" y="60" width="26" height="6" rx="3" fill="currentColor" opacity=".25"/><circle cx="112" cy="26" r="9" fill="currentColor" opacity=".4"/>`,
      search: `${box}<circle cx="64" cy="60" r="18" fill="none" stroke="currentColor" stroke-width="6" opacity=".6"/><path d="m78 74 16 16" stroke="currentColor" stroke-width="7" stroke-linecap="round" opacity=".6"/>`,
      error: `${box}<path d="M70 40 98 88H42z" fill="currentColor" opacity=".55"/><rect x="67" y="56" width="6" height="16" rx="3" fill="var(--panel)"/><circle cx="70" cy="79" r="3.5" fill="var(--panel)"/>`,
      installed: `${box}<circle cx="70" cy="62" r="20" fill="currentColor" opacity=".55"/><path d="m61 62 7 7 12-13" fill="none" stroke="var(--panel)" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>`,
    };
    return `<svg viewBox="0 0 140 110" aria-hidden="true">${shapes[kind] || shapes.empty}</svg>`;
  };
  const hue = (s) => { let h = 0; for (const c of String(s || '')) h = (h * 31 + c.codePointAt(0)) % 360; return h; };
  const assetUrl = (u) => (u && u.startsWith('/api/') ? `${u}&t=${encodeURIComponent(TOKEN)}` : u || '');
  const icon = (e, size = 'md', attrs = '') => (e.icon
    ? `<span class="ast-icon ast-icon-${size}" ${attrs}><img src="${esc(assetUrl(e.icon))}" alt="" loading="lazy" decoding="async"></span>`
    : `<span class="ast-icon ast-icon-${size} ast-icon-ph" style="--h:${hue(e.name)}" aria-hidden="true" ${attrs}>${esc(String(e.name || '?').trim().slice(0, 1).toUpperCase())}</span>`);
  const when = (iso) => {
    const t = Date.parse(iso || '');
    if (!t) return '';
    const d = Math.round((Date.now() - t) / 86400000);
    return d <= 0 ? '오늘 업데이트' : d < 31 ? `${d}일 전 업데이트` : `${new Date(t).toISOString().slice(0, 10)} 업데이트`;
  };
  const signals = (e) => [
    e.verified ? '<span class="ast-badge ok" title="레지스트리 검사(app.json·릴리스·SHA-256)를 통과했습니다">검증됨</span>' : '',
    e.installed ? `<span class="ast-badge">설치됨 ${esc(e.installed)}</span>` : '',
    Number.isInteger(e.installs) ? `<span class="ums">설치 ${e.installs.toLocaleString()}회</span>` : '',
    e.updated ? `<span class="ums">${esc(when(e.updated))}</span>` : '',
  ].filter(Boolean).join(' ');
  const card = (e, i = 0) => `<button type="button" class="ast-card" data-open="${esc(e.key)}" style="--i:${i}">
      ${icon(e)}
      <span class="ast-card-text"><strong>${esc(e.name)}</strong>
        <span class="ast-tagline">${esc(e.tagline || e.description)}</span>
        <span class="ast-meta">${esc([e.author, e.category].filter(Boolean).join(' · '))}</span></span>
    </button>`;
  const row = (title, list, id, h) => (list.length ? `<section class="ast-row" aria-labelledby="${id}" ${h !== undefined ? `style="--h:${h}"` : ''}>
      <div class="ast-row-head">${h !== undefined ? '<span class="ast-cat-dot" aria-hidden="true"></span>' : ''}<h3 id="${id}">${esc(title)}</h3><span class="ums">${list.length}</span></div>
      <div class="ast-rail"><button type="button" class="ast-arrow prev" aria-label="이전" tabindex="-1">${SVG.left}</button>
        <div class="ast-scroller ast-stagger" role="list">${list.map((e, i) => `<div role="listitem" style="--i:${Math.min(i, 8)}">${card(e)}</div>`).join('')}</div>
        <button type="button" class="ast-arrow next" aria-label="다음" tabindex="-1">${SVG.right}</button></div></section>` : '');
  const skeleton = () => `<div class="ast-skel ast-skel-hero"></div>${[0, 1].map(() => `<div class="ast-row"><div class="ast-skel ast-skel-line" style="width:160px;height:16px;margin-bottom:14px"></div>
      <div class="ast-grid">${[0, 1, 2, 3].map(() => '<div class="ast-skel-card"><div class="ast-skel icon"></div><div style="flex:1"><div class="ast-skel ast-skel-line" style="width:60%"></div><div class="ast-skel ast-skel-line" style="width:90%"></div><div class="ast-skel ast-skel-line" style="width:40%"></div></div></div>').join('')}</div></div>`).join('')}`;

  /** fade images in when they arrive (their boxes are fixed, so nothing jumps) */
  function settleImages(root) {
    for (const img of root.querySelectorAll('.ast-icon img, .ast-shot img, .ast-slide-art img')) {
      const done = () => img.classList.add('is-loaded');
      if (img.complete && img.naturalWidth) done();
      else { img.addEventListener('load', done, { once: true }); img.addEventListener('error', () => { img.closest('.ast-icon')?.classList.add('ast-icon-ph'); done(); }, { once: true }); }
    }
  }
  /** arrows of a scroll rail: hidden at the ends, page by page */
  function wireRails(root) {
    for (const rail of root.querySelectorAll('.ast-rail')) {
      const sc = rail.querySelector('.ast-scroller, .ast-shots');
      const prev = rail.querySelector('.prev'), next = rail.querySelector('.next');
      if (!sc || !prev) continue;
      let raf = 0;
      const update = () => { raf = 0; prev.disabled = sc.scrollLeft < 4; next.disabled = sc.scrollLeft + sc.clientWidth >= sc.scrollWidth - 4; };
      sc.addEventListener('scroll', () => { if (!raf) raf = requestAnimationFrame(update); }, { passive: true });
      prev.onclick = () => sc.scrollBy({ left: -sc.clientWidth * 0.9, behavior: reduce() ? 'auto' : 'smooth' });
      next.onclick = () => sc.scrollBy({ left: sc.clientWidth * 0.9, behavior: reduce() ? 'auto' : 'smooth' });
      update();
    }
  }

  // ---------- data ----------
  async function load(force) {
    if (data && !force) return data;
    data = await api('/api/apps-store', { requireOk: true });
    for (const e of data.entries) { e.category ||= (e.tags && e.tags[0]) || ''; e.tagline ||= ''; }
    return data;
  }
  const find = (key) => data?.entries.find((e) => e.key === key);

  // ---------- bar: tabs with a sliding ink ----------
  function bar() {
    const tabs = [['home', '둘러보기'], ['mine', '내 앱'], ['register', '앱 등록']];
    if (!document.getElementById('astTabs')) {
      setBar(`<h2 style="flex:none">${ICO.grid} <span class="ast-bar-title">앱 스토어</span></h2>
        <nav class="ast-tabs" id="astTabs" aria-label="앱 스토어"><span class="ast-ink" aria-hidden="true"></span>${tabs.map(([p, l]) => `<button type="button" class="ast-tab" data-ast-tab="${p}">${l}</button>`).join('')}</nav>
        <span class="sp"></span>
        <button type="button" class="btn-sm" id="astSources" title="레지스트리·저장소 소스 관리">소스</button>
        <button type="button" class="btn-sm" id="astBack">Apps</button>`);
      document.querySelectorAll('[data-ast-tab]').forEach((b) => { b.onclick = () => go({ page: b.dataset.astTab }); });
      $('#astSources').onclick = () => H().sources();
      $('#astBack').onclick = () => viewApps();
    }
    const active = route.page === 'app' ? 'home' : route.page;
    let cur = null;
    document.querySelectorAll('[data-ast-tab]').forEach((b) => {
      const on = b.dataset.astTab === active;
      if (on) { b.setAttribute('aria-current', 'page'); cur = b; } else b.removeAttribute('aria-current');
    });
    const ink = document.querySelector('#astTabs .ast-ink');
    if (ink && cur) requestAnimationFrame(() => { ink.style.transform = `translateX(${cur.offsetLeft - 3}px) scaleX(${cur.offsetWidth / 100})`; ink.style.left = '3px'; });
  }

  function go(next, from) {
    route = next;
    window.viewAppStore(null, true, from);
  }

  /** run an update of the page with a View Transition (shared icon/title) when available, else a light fade */
  async function transit(update, from) {
    if (document.startViewTransition && !reduce()) {
      if (from) { from.icon && (from.icon.style.viewTransitionName = 'ast-icon'); from.title && (from.title.style.viewTransitionName = 'ast-title'); }
      const vt = document.startViewTransition(async () => {
        if (from) { from.icon && (from.icon.style.viewTransitionName = ''); from.title && (from.title.style.viewTransitionName = ''); }
        await update();
      });
      try { await vt.updateCallbackDone; } catch {}
      vt.finished.finally(() => document.querySelectorAll('[data-vt]').forEach((el) => { el.style.viewTransitionName = ''; }));
      return;
    }
    await update();
    $('#ast')?.classList.add('ast-enter');
  }

  window.viewAppStore = async function viewAppStore(next, keep, from) {
    if (next) route = next;
    else if (!keep) route = { page: 'home' };
    if (state.sel?.kind !== 'apps') select({ kind: 'apps' });
    bar();
    const v = $('#view');
    let box = $('#ast');
    if (!box) {
      v.onclick = null;
      v.innerHTML = `<div class="ast" id="ast" aria-busy="true">${skeleton()}</div>`;
      box = $('#ast');
      wirePullToRefresh(box);
    }
    // the catalog is reloaded when the store is entered; switching tabs or pages reuses it and paints at once
    try { await load(!data || !keep); }
    catch (e) {
      box.innerHTML = `<div class="ast-empty">${art('error')}<p>스토어를 불러오지 못했습니다.<br><span class="ums">${esc(e.message)}</span></p><button type="button" class="primary" id="astRetry">다시 시도</button></div>`;
      $('#astRetry').onclick = () => window.viewAppStore(route, true);
      return;
    }
    if (!document.contains(box)) return;
    box.removeAttribute('aria-busy');
    // the transition only waits for the synchronous part of a page (its frame); data inside fills in afterwards
    await transit(() => {
      box.classList.remove('ast-enter');
      box.onclick = null;
      if (route.page === 'app') void renderApp(box, route.key);
      else if (route.page === 'mine') void renderMine(box);
      else if (route.page === 'register') renderRegister(box);
      else renderHome(box);
    }, from);
    window.scrollTo?.(0, 0);
    $('#view').scrollTop = 0;
  };

  // ---------- home ----------
  function renderHome(box) {
    // every store app is an add-on for this hub: ones whose requirement it does not meet stay out of the lists
    const all = data.entries.filter((e) => e.compatible !== false);
    const hidden = data.entries.length - all.length;
    const cats = [...new Set(all.map((e) => e.category).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    box.innerHTML = `
      <div class="ast-search">
        <div class="ast-search-box">${SVG.search}<input type="search" id="astQ" value="${esc(query)}" placeholder="앱, 작성자, 태그 검색" aria-label="앱 스토어 검색" autocomplete="off"></div>
        <div class="ast-chips" role="group" aria-label="카테고리">
          <button type="button" class="ast-chip" data-cat="" aria-pressed="${!cat}">전체</button>
          ${cats.map((c) => `<button type="button" class="ast-chip" data-cat="${esc(c)}" aria-pressed="${cat === c}">${esc(c)}</button>`).join('')}
        </div>
      </div>
      ${data.unavailable?.length ? `<p class="ums ast-warn" role="status">확인하지 못한 소스: ${esc(data.unavailable.join(', '))}</p>` : ''}
      ${hidden ? `<p class="ums" role="status">이 허브(CCD ${esc(data.hubVersion || '')})에서 쓸 수 없는 앱 ${hidden}개는 숨겼습니다.</p>` : ''}
      <div id="astBody"></div>`;
    const body = $('#astBody', box);
    const paint = () => {
      const q = query.trim().toLowerCase();
      const hits = all.filter((e) => (!cat || e.category === cat)
        && (!q || [e.name, e.tagline, e.description, e.author, e.repo, ...(e.tags || [])].some((x) => String(x || '').toLowerCase().includes(q))));
      if (!all.length) {
        body.innerHTML = `<div class="ast-empty">${art('empty')}<p>표시할 앱이 없습니다. 레지스트리나 앱 저장소를 소스로 추가하세요.</p><button type="button" class="primary" id="astAddSrc">소스 추가</button></div>`;
        $('#astAddSrc', body).onclick = () => H().sources();
      } else if (q || cat) {
        body.innerHTML = `${cat && !q ? `<div class="ast-cat-banner" data-h style="--h:${hue(cat)}"><div><span class="ast-kicker">카테고리</span><h2>${esc(cat)}</h2><p>앱 ${hits.length}개</p></div></div>` : ''}
          ${hits.length ? `<div class="ast-grid ast-stagger">${hits.map((e, i) => card(e, Math.min(i, 10))).join('')}</div>`
            : `<div class="ast-empty">${art('search')}<p>조건에 맞는 앱이 없습니다.</p></div>`}`;
      } else {
        const featured = all.filter((e) => e.featured || e.screenshots?.length).slice(0, 5);
        const byDate = (a, b) => (Date.parse(b.added || b.updated || 0) || 0) - (Date.parse(a.added || a.updated || 0) || 0);
        const popular = all.filter((e) => Number.isInteger(e.installs)).sort((a, b) => b.installs - a.installs);
        body.innerHTML = `
          ${featured.length ? `<section class="ast-hero" aria-roledescription="carousel" aria-label="추천 앱">
            ${featured.map((e, i) => `<article class="ast-slide${i ? '' : ' is-active'}" data-h style="--h:${hue(e.category || e.name)}" aria-roledescription="slide" aria-label="${i + 1} / ${featured.length}" ${i ? 'aria-hidden="true"' : ''}>
              ${e.screenshots?.[0] ? `<div class="ast-slide-art"><img src="${esc(assetUrl(e.screenshots[0]))}" alt="" ${i ? 'loading="lazy"' : ''} decoding="async"></div>` : ''}
              <div class="ast-slide-text">${icon(e, 'lg')}<div><span class="ast-kicker">추천</span><h3>${esc(e.name)}</h3><p>${esc(e.tagline || e.description)}</p>
                <button type="button" class="primary" data-open="${esc(e.key)}" ${i ? 'tabindex="-1"' : ''}>자세히 보기</button></div></div>
            </article>`).join('')}
            ${featured.length > 1 ? `<div class="ast-dots" role="tablist">${featured.map((e, i) => `<button type="button" class="ast-dot${i ? '' : ' is-active'}" data-slide="${i}" role="tab" aria-label="${esc(e.name)}" aria-selected="${!i}"></button>`).join('')}</div>` : ''}
          </section>` : ''}
          ${row('새로 등록된 앱', [...all].sort(byDate).slice(0, 12), 'astNew')}
          ${row('많이 설치된 앱', popular.slice(0, 12), 'astPop')}
          ${cats.map((c, i) => row(c, all.filter((e) => e.category === c), `astCat${i}`, hue(c))).join('')}`;
        bindHero(body);
      }
      settleImages(body);
      wireRails(body);
    };
    paint();
    const qIn = $('#astQ', box);
    let t = null;
    qIn.oninput = () => { clearTimeout(t); t = setTimeout(() => { query = qIn.value; paint(); }, 120); };
    box.querySelectorAll('[data-cat]').forEach((b) => {
      b.onclick = () => { cat = b.dataset.cat; box.querySelectorAll('[data-cat]').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); paint(); };
    });
    box.onclick = (ev) => {
      const btn = ev.target.closest('[data-open]');
      if (!btn) return;
      const c = btn.closest('.ast-card, .ast-slide');
      go({ page: 'app', key: btn.dataset.open }, c ? { icon: c.querySelector('.ast-icon'), title: c.querySelector('strong, h3') } : null);
    };
    settleImages(box);
  }

  /** featured banner: the active dot's progress animation is the timer (hover / focus pause it); swipe on touch */
  function bindHero(root) {
    const hero = root.querySelector('.ast-hero');
    if (!hero) return null;
    const slides = [...hero.querySelectorAll('.ast-slide')], dots = [...hero.querySelectorAll('.ast-dot')];
    if (slides.length < 2) return null;
    let i = 0;
    const show = (n) => {
      const next = (n + slides.length) % slides.length;
      if (next === i) return;
      const old = slides[i];
      old.classList.remove('is-active'); old.classList.add('is-leaving'); old.setAttribute('aria-hidden', 'true');
      old.querySelectorAll('button').forEach((b) => b.setAttribute('tabindex', '-1'));
      setTimeout(() => old.classList.remove('is-leaving'), 650);
      i = next;
      slides[i].classList.add('is-active'); slides[i].removeAttribute('aria-hidden');
      slides[i].querySelectorAll('button').forEach((b) => b.removeAttribute('tabindex'));
      dots.forEach((d, k) => { d.classList.toggle('is-active', k === i); d.setAttribute('aria-selected', String(k === i)); });
    };
    dots.forEach((d) => { d.onclick = () => show(Number(d.dataset.slide)); });
    let x0 = null;
    hero.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'mouse') x0 = e.clientX; });
    hero.addEventListener('pointerup', (e) => { if (x0 === null) return; const dx = e.clientX - x0; x0 = null; if (Math.abs(dx) > 40) show(i + (dx < 0 ? 1 : -1)); });
  }

  // ---------- app page ----------
  function md(text) {
    // small, safe Markdown: headings, lists (wrapped items continue), code blocks, tables as text, paragraphs
    // (wrapped lines join); everything is escaped first
    const lines = esc(text).split(/\r?\n/);
    let out = '', list = false, code = false, para = [], item = null;
    const flushPara = () => { if (para.length) out += `<p>${inline(para.join(' '))}</p>`; para = []; };
    const flushItem = () => { if (item !== null) out += `<li>${inline(item)}</li>`; item = null; };
    const endList = () => { flushItem(); if (list) out += '</ul>'; list = false; };
    for (const l of lines) {
      if (/^```/.test(l)) { flushPara(); endList(); out += code ? '</pre>' : '<pre class="mdpre">'; code = !code; continue; }
      if (code) { out += l + '\n'; continue; }
      const li = /^\s*(?:[-*]|\d+\.)\s+(.*)/.exec(l);
      if (li) { flushPara(); if (!list) { out += '<ul>'; list = true; } flushItem(); item = li[1]; continue; }
      if (list && /^\s+\S/.test(l)) { item += ' ' + l.trim(); continue; }
      if (!l.trim()) { flushPara(); endList(); continue; }
      endList();
      const h = /^(#{1,4})\s+(.*)/.exec(l);
      if (h) { flushPara(); const n = Math.min(4, h[1].length + 2); out += `<h${n}>${inline(h[2])}</h${n}>`; continue; }
      if (/^\|/.test(l)) { flushPara(); if (!/^\|[\s:|-]+\|$/.test(l)) out += `<p class="ums">${inline(l.replace(/^\||\|$/g, '').split('|').map((c) => c.trim()).filter(Boolean).join(' · '))}</p>`; continue; }
      para.push(l.trim());
    }
    flushPara(); endList();
    return out + (code ? '</pre>' : '');
  }
  const inline = (s) => s.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');

  /** the install button: install → (progress ring while setup runs) → open; error shakes and says why */
  function getButton(host, e, pkg, onChange) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ast-get';
    btn.innerHTML = `<span class="lbl"></span>${SVG.ring}`;
    const sub = document.createElement('div');
    sub.className = 'ast-get-sub';
    const set = (st, label, note = '') => { btn.dataset.state = st; btn.querySelector('.lbl').textContent = label; sub.textContent = note; btn.setAttribute('aria-busy', String(st === 'installing')); };
    const installed = Boolean(pkg.installedId);
    const outdated = installed && pkg.installedDigest && pkg.installedDigest !== pkg.digest;
    if (pkg.unmet?.length && !installed) set('blocked', '설치할 수 없음', pkg.unmet.join(', '));
    else if (installed) set('open', '열기');
    else set('install', '설치');
    host.replaceChildren(btn, sub);
    let upd = null;
    if (outdated && !pkg.unmet?.length) {
      upd = document.createElement('button');
      upd.type = 'button'; upd.className = 'btn-sm'; upd.textContent = '업데이트';
      host.insertBefore(upd, sub);
    }
    const watch = async (id, name) => {
      set('installing', '', '설치하고 환경을 구성하는 중…');
      for (let k = 0; k < 900; k++) {
        await new Promise((r) => setTimeout(r, 1500));
        if (!document.contains(btn)) return;
        const a = (await api(`/api/apps/${encodeURIComponent(id)}`).catch(() => null))?.app;
        if (!a) continue;
        if (a.status === 'running') continue;
        if (a.latestRun?.status === 'error') {
          set('error', '다시 시도', '초기 환경 구성이 실패했습니다');
          toast(`${name}: 초기 환경 구성 실패 — ${(a.latestRun.stderr || '').split('\n').filter(Boolean).pop() || ''}`, 7000, 'danger');
          setTimeout(() => { if (btn.dataset.state === 'error') set('open', '열기', '실행 기록을 확인하세요'); }, 1200);
          onChange?.(); return;
        }
        set('open', '열기', '');
        toast(`${name}을(를) 설치했습니다`, 4000);
        onChange?.(); return;
      }
    };
    btn.onclick = () => {
      const st = btn.dataset.state;
      if (st === 'open') return viewApps(pkg.installedId || btn.dataset.id);
      if (st !== 'install') return;
      H().install(e, (res) => {
        if (!res) return;
        btn.dataset.id = res.id; pkg.installedId = res.id;
        if (res.restartRequired) toast(`${pkg.name}: 허브 플러그인을 설치했습니다. 허브를 다시 시작하면 켜집니다.`, 7000);
        if (res.setupRun) watch(res.id, pkg.name); else { set('open', '열기'); toast(`${pkg.name}을(를) 설치했습니다`, 4000); onChange?.(); }
      });
    };
    if (upd) upd.onclick = () => H().install(e, (res) => { if (!res) return; upd.remove(); if (res.setupRun) watch(res.id, pkg.name); else { toast(`${pkg.name}을(를) 업데이트했습니다`, 4000); onChange?.(); } }, { update: true });
  }

  /** screenshot lightbox: zooms from the thumbnail (FLIP with WAAPI), arrows / Esc / click to close */
  function lightbox(shots, start, thumbs) {
    let i = start;
    const wrap = document.createElement('div');
    wrap.className = 'ast-lightbox';
    wrap.setAttribute('role', 'dialog'); wrap.setAttribute('aria-modal', 'true'); wrap.setAttribute('aria-label', '스크린샷');
    wrap.innerHTML = `<img alt=""><button type="button" class="x" aria-label="닫기">×</button>${shots.length > 1 ? `<button type="button" class="p" aria-label="이전">‹</button><button type="button" class="n" aria-label="다음">›</button>` : ''}`;
    const img = wrap.querySelector('img');
    const prevFocus = document.activeElement;
    const flip = (from, reverse) => {
      if (reduce() || !from || !img.getBoundingClientRect().width) return null;
      const a = from.getBoundingClientRect(), b = img.getBoundingClientRect();
      const tf = `translate(${a.left - b.left + (a.width - b.width) / 2}px, ${a.top - b.top + (a.height - b.height) / 2}px) scale(${a.width / b.width})`;
      return img.animate([{ transform: tf, opacity: .6 }, { transform: 'none', opacity: 1 }], { duration: 360, easing: 'cubic-bezier(.2,.8,.2,1)', direction: reverse ? 'reverse' : 'normal', fill: 'both' });
    };
    const show = (n) => { i = (n + shots.length) % shots.length; img.src = assetUrl(shots[i]); img.alt = `스크린샷 ${i + 1}`; };
    const close = async () => {
      document.removeEventListener('keydown', key, true);
      wrap.classList.add('is-closing');
      const a = flip(thumbs[i], true);
      if (a) await a.finished.catch(() => {}); else await new Promise((r) => setTimeout(r, 140));
      wrap.remove(); prevFocus?.focus?.();
    };
    const key = (ev) => {
      if (ev.key === 'Escape') { ev.preventDefault(); close(); }
      else if (ev.key === 'ArrowRight') show(i + 1);
      else if (ev.key === 'ArrowLeft') show(i - 1);
    };
    wrap.addEventListener('click', (ev) => {
      if (ev.target.closest('.p')) return show(i - 1);
      if (ev.target.closest('.n')) return show(i + 1);
      if (ev.target === wrap || ev.target.closest('.x')) close();
    });
    document.addEventListener('keydown', key, true);
    show(i);
    document.body.appendChild(wrap);
    wrap.querySelector('.x').focus();
    const go = () => flip(thumbs[i], false);
    if (img.complete) go(); else img.addEventListener('load', go, { once: true });
  }

  async function renderApp(box, key) {
    const e = find(key);
    if (!e) { box.innerHTML = `<div class="ast-empty">${art('search')}<p>앱을 찾을 수 없습니다.</p></div>`; return; }
    box.innerHTML = `<div class="ast-detail"><button type="button" class="ast-back" id="astHome">${SVG.left} 둘러보기</button>
      <header class="ast-head" data-h style="--h:${hue(e.category || e.name)}">${icon(e, 'xl', 'data-vt style="view-transition-name: ast-icon"')}<div class="ast-head-text"><h2 data-vt style="view-transition-name: ast-title">${esc(e.name)}</h2>
        <p class="ast-tagline">${esc(e.tagline || e.description)}</p>
        <p class="ums">${esc([e.author, e.category].filter(Boolean).join(' · '))}</p>
        <p>${signals(e)}</p></div>
        <div class="ast-cta" id="astCta"><div class="ast-skel" style="height:40px;border-radius:999px"></div></div></header>
      ${e.screenshots?.length ? `<section class="ast-shots-wrap" aria-label="스크린샷"><div class="ast-rail"><button type="button" class="ast-arrow prev" aria-label="이전" tabindex="-1">${SVG.left}</button>
        <div class="ast-shots">${e.screenshots.map((s, i) => `<button type="button" class="ast-shot" aria-label="스크린샷 크게 보기" data-shot="${i}"><img src="${esc(assetUrl(s))}" alt="" loading="lazy" decoding="async"></button>`).join('')}</div>
        <button type="button" class="ast-arrow next" aria-label="다음" tabindex="-1">${SVG.right}</button></div></section>` : ''}
      <div class="ast-cols"><div id="astMain"><div class="ast-skel ast-skel-line" style="width:70%"></div><div class="ast-skel ast-skel-line"></div><div class="ast-skel ast-skel-line" style="width:85%"></div></div><aside id="astSide"><div class="ast-skel" style="height:180px;border-radius:12px"></div></aside></div></div>`;
    settleImages(box); wireRails(box);
    $('#astHome', box).onclick = () => go({ page: 'home' });
    box.querySelectorAll('[data-shot]').forEach((b) => { b.onclick = () => lightbox(e.screenshots, Number(b.dataset.shot), [...box.querySelectorAll('.ast-shot img')]); });
    let pkg;
    try { pkg = (await api('/api/apps-store/package', { method: 'POST', body: { key }, requireOk: true })).package; }
    catch (err) {
      $('#astCta', box).innerHTML = `<span class="ast-badge warn" role="alert">${esc(err.message)}</span>`;
      $('#astMain', box).innerHTML = `<div class="ast-empty">${art('error')}<p>패키지를 확인하지 못했습니다.</p></div>`;
      $('#astSide', box).innerHTML = '';
      return;
    }
    if (!box.isConnected) return;
    getButton($('#astCta', box), e, pkg, () => load(true).catch(() => {}));
    const inst = pkg.installs || {};
    const li = (items, f) => items.map((x) => `<li>${f(x)}</li>`).join('');
    const main = $('#astMain', box), side = $('#astSide', box);
    main.innerHTML = `
      ${pkg.whatsNew ? `<section class="ast-card-box"><h3>새로운 기능 <span class="ums">${esc(pkg.whatsNew.title)}</span></h3>${md(pkg.whatsNew.body)}</section>` : ''}
      <section class="ast-readme">${pkg.readme ? md(pkg.readme) : `<p>${esc(pkg.description)}</p>`}</section>`;
    side.innerHTML = `
      <section class="ast-card-box"><h3>출처</h3><dl class="ast-dl">
        <dt>저장소</dt><dd><code>${esc(pkg.repo)}</code></dd>
        <dt>버전</dt><dd>${esc(pkg.version)}</dd>
        ${pkg.commit ? `<dt>커밋</dt><dd><code>${esc(pkg.commit.slice(0, 12))}</code>${pkg.dirty ? ' <span class="ast-badge warn">커밋 안 된 변경</span>' : ''}</dd>` : ''}
        <dt>SHA-256</dt><dd><code title="${esc(pkg.digest)}">${esc(pkg.digest.slice(7, 19))}…</code></dd>
        ${pkg.registry ? `<dt>레지스트리</dt><dd>${esc(pkg.registry)}</dd>` : ''}
        ${pkg.requires?.ccd ? `<dt>필요</dt><dd>CCD ${esc(pkg.requires.ccd)}${(pkg.requires.plugins || []).length ? ` + ${pkg.requires.plugins.map(esc).join(', ')}` : ''}</dd>` : ''}
      </dl></section>
      <section class="ast-card-box"><h3>이 앱이 하는 일</h3><ul class="ast-perms">
        <li>앱 폴더에 설치됩니다 (허브 데이터 폴더 안). 명령은 그 폴더에서 실행됩니다.</li>
        ${inst.scripts?.includes('setup.ps1') ? '<li><b>설치를 누르면</b> <code>setup.ps1</code>을 실행합니다 (의존성 설치).</li>' : ''}
        ${inst.scripts?.includes('stop.ps1') ? '<li>업데이트 전에 <code>stop.ps1</code>로 실행 중인 서버를 멈춥니다.</li>' : ''}
        ${inst.scripts?.includes('uninstall.ps1') ? '<li>제거할 때 <code>uninstall.ps1</code>을 실행합니다.</li>' : ''}
        ${li(inst.ports || [], (x) => `포트 사용: ${esc(x.label)} (기본 ${esc(x.value)})`)}
        ${li(inst.folders || [], (x) => `폴더 접근: ${esc(x.label)}${x.value ? ` (기본 <code>${esc(x.value)}</code>)` : ''}`)}
        ${li(inst.hosts || [], (x) => `외부 주소 연결: ${esc(x.label)}`)}
        ${inst.webView ? `<li>허브 안 화면: <code>${esc(inst.webView)}</code></li>` : ''}
        ${inst.plugin ? `<li><b>허브 플러그인</b> <code>${esc(inst.plugin.id)}</code> 추가${inst.plugin.server ? ' · 서버 경로' : ''}${inst.plugin.cli ? ' · ccd 명령' : ''}${inst.plugin.browserScripts.length ? ' · 화면' : ''} (허브 재시작 후 적용)
          ${inst.plugin.routes.length ? `<br><span class="ums">${inst.plugin.routes.map(esc).join(', ')}</span>` : ''}
          ${inst.plugin.provides.length ? `<br><span class="ums">제공: ${inst.plugin.provides.map(esc).join(', ')}</span>` : ''}</li>` : ''}
      </ul>
      ${inst.commands?.length ? `<details><summary>실행 명령 ${inst.commands.length}개</summary><ul class="ast-perms">${li(inst.commands, (c) => `${esc(c.label)}<br><code>${esc(c.cmd)}</code>`)}</ul></details>` : ''}
      </section>
      ${pkg.settings?.length ? `<section class="ast-card-box"><h3>설치할 때 입력하는 설정</h3><ul class="ast-perms">${li(pkg.settings, (s) => `${esc(s.label)}${s.required ? ' <b>*</b>' : ''}${s.description ? `<br><span class="ums">${esc(s.description)}</span>` : ''}`)}</ul></section>` : ''}`;
    if (!reduce()) [main, side].forEach((el) => el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: 'ease-out' }));
  }

  // ---------- my apps (FLIP on changes, slide-out on remove) ----------
  async function renderMine(box) {
    const { apps = [] } = await api('/api/apps').catch(() => ({ apps: [] }));
    const mine = apps.filter((a) => a.storeSource);
    if (!box.isConnected) return;
    const before = new Map([...box.querySelectorAll('[data-row]')].map((el) => [el.dataset.row, el.getBoundingClientRect()]));
    box.innerHTML = mine.length ? `<div class="ast-mine${before.size ? '' : ' ast-stagger'}">${mine.map((a, i) => {
      const e = data.entries.find((x) => x.key === a.storeSource.key) || {};
      const stop = a.actions?.find((x) => x.id === 'stop');
      return `<article class="ast-mine-row" data-row="${esc(a.id)}" style="--i:${Math.min(i, 8)}">
        ${icon({ ...e, name: a.name })}
        <div class="ast-mine-text"><strong>${esc(a.name)}</strong> ${H().statusBadge(a.status)}
          <span class="ums">${esc(a.storeSource.version)} · <code>${esc(a.storeSource.repo)}</code></span>
          ${a.pluginState ? `<span class="ums">플러그인 ${esc(a.pluginState.id || '')}: ${a.pluginState.installed ? '설치됨 (허브 재시작 후 사용)' : '없음'}</span>` : ''}</div>
        <div class="ast-mine-actions">
          <button type="button" class="primary btn-sm" data-m="open" data-id="${esc(a.id)}">열기</button>
          ${e.key ? `<button type="button" class="btn-sm" data-m="page" data-key="${esc(e.key)}">스토어 페이지</button>` : ''}
          ${stop ? `<button type="button" class="btn-sm" data-m="stop" data-id="${esc(a.id)}">중지</button>` : ''}
          ${a.settings?.length ? `<button type="button" class="btn-sm" data-m="settings" data-id="${esc(a.id)}">설정</button>` : ''}
          <button type="button" class="btn-sm danger" data-m="remove" data-id="${esc(a.id)}">제거</button>
        </div></article>`;
    }).join('')}</div>` : `<div class="ast-empty">${art('installed')}<p>스토어에서 설치한 앱이 없습니다.</p><button type="button" class="primary" data-m="browse">둘러보기</button></div>`;
    settleImages(box);
    if (before.size && !reduce()) {
      for (const el of box.querySelectorAll('[data-row]')) {
        const a = before.get(el.dataset.row), b = el.getBoundingClientRect();
        if (a && Math.abs(a.top - b.top) > 1) el.animate([{ transform: `translateY(${a.top - b.top}px)` }, { transform: 'none' }], { duration: 320, easing: 'cubic-bezier(.2,.8,.2,1)' });
        else if (!a) el.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: 'ease-out' });
      }
    }
    box.onclick = async (ev) => {
      const b = ev.target.closest('[data-m]');
      if (!b) return;
      if (b.dataset.m === 'browse') return go({ page: 'home' });
      const a = mine.find((x) => x.id === b.dataset.id);
      if (b.dataset.m === 'open') return viewApps(a.id);
      if (b.dataset.m === 'page') {
        const r = b.closest('[data-row]');
        return go({ page: 'app', key: b.dataset.key }, { icon: r.querySelector('.ast-icon'), title: r.querySelector('strong') });
      }
      if (b.dataset.m === 'settings') return H().showAppSettings(a, () => renderMine(box));
      if (b.dataset.m === 'stop') {
        b.disabled = true;
        try { await api(`/api/apps/${encodeURIComponent(a.id)}/run`, { method: 'POST', body: { actionId: 'stop' }, requireOk: true }); toast(`${a.name} 중지를 요청했습니다`); }
        catch (er) { toast(er.message, 5000, 'danger'); }
        setTimeout(() => renderMine(box), 1500);
        return;
      }
      if (b.dataset.m === 'remove') {
        if (!confirm(`${a.name}을(를) 제거할까요? 앱 폴더가 지워지고, 함께 설치된 허브 플러그인도 제거됩니다.`)) return;
        b.disabled = true;
        const rowEl = b.closest('[data-row]');
        let r;
        try { r = await api(`/api/apps/${encodeURIComponent(a.id)}`, { method: 'DELETE', requireOk: true }); }
        catch (er) {
          if (!confirm(`${er.message}\n\n제거 스크립트를 건너뛰고 강제로 제거할까요?`)) { b.disabled = false; rowEl.animate?.([{ transform: 'translateX(-6px)' }, { transform: 'translateX(6px)' }, { transform: 'none' }], { duration: 300 }); return; }
          r = await api(`/api/apps/${encodeURIComponent(a.id)}?force=1`, { method: 'DELETE' }).catch((x) => { toast(x.message, 5000, 'danger'); return null; });
          if (!r) return;
        }
        toast(r.restartRequired ? '제거했습니다. 허브를 다시 시작하면 플러그인이 꺼집니다.' : '제거했습니다', 5000);
        rowEl.classList.add('is-leaving');
        await new Promise((res) => setTimeout(res, reduce() ? 0 : 300));
        await load(true).catch(() => {});
        renderMine(box);
      }
    };
  }

  // ---------- register ----------
  function renderRegister(box) {
    const submit = data.submitUrls?.[0] || '';
    box.innerHTML = `<div class="ast-console">
      <h2>앱 등록</h2>
      <p class="ums">앱은 작성자의 GitHub 저장소에 있습니다 (최상위 <code>app.json</code>, 릴리스 ZIP). 여기서 저장소를 검사한 뒤 이 허브에 바로 추가하거나, 공용 레지스트리에 등록을 요청하세요.</p>
      <form id="astReg" class="ast-reg-form"><label for="astRepo">저장소 주소</label>
        <div class="row"><input id="astRepo" required placeholder="https://github.com/owner/app 또는 D:\\src\\app" spellcheck="false" autocomplete="off">
        <button class="primary">검사</button></div></form>
      <div id="astRegOut" aria-live="polite"></div></div>`;
    const form = $('#astReg', box), out = $('#astRegOut', box), input = $('#astRepo', box);
    let timer = null;
    const check = async () => {
      const repo = input.value.trim();
      if (!repo) { out.innerHTML = ''; return; }
      out.innerHTML = '<div class="ast-skel ast-skel-line" style="width:40%"></div><div class="ast-skel ast-skel-line" style="width:55%"></div><div class="ast-skel ast-skel-line" style="width:35%"></div>';
      const r = await api('/api/apps-store/inspect', { method: 'POST', body: { repo } }).catch((e) => ({ checks: [{ label: '검사', pass: false, detail: e.message }] }));
      if (input.value.trim() !== repo) return;
      const m = r.manifest;
      const issue = submit && m ? `${submit}${submit.includes('?') ? '&' : '?'}${new URLSearchParams({ title: `Register app: ${m.name}`, repo: /^[\w.-]+\/[\w.-]+$/.test(r.repo) ? `https://github.com/${r.repo}` : repo, 'app-id': m.id, category: m.store?.category || '' })}` : '';
      out.innerHTML = `<ul class="ast-checks">${(r.checks || []).map((c, i) => `<li class="${c.pass ? 'ok' : 'bad'}" style="--i:${i}"><span aria-hidden="true">${c.pass ? '✓' : '✗'}</span> ${esc(c.label)} <span class="ums">${esc(c.detail || '')}</span></li>`).join('')}</ul>
        ${m ? `<p class="ums">미리보기</p><div class="ast-preview">${card({ key: '', name: m.name, tagline: m.store?.tagline || m.description, author: '', category: m.store?.category || '', icon: '' })}</div>` : ''}
        <div class="row" style="gap:8px;flex-wrap:wrap">
          <button type="button" class="primary" id="astAddHere" ${r.valid ? '' : 'disabled'}>이 허브의 스토어에 추가</button>
          ${issue ? `<a class="btnlike" href="${esc(issue)}" target="_blank" rel="noopener" ${r.valid ? '' : 'aria-disabled="true"'}>공용 레지스트리에 제출 (GitHub 이슈)</a>` : '<span class="ums">공용 레지스트리 소스가 없어 제출 링크를 만들 수 없습니다.</span>'}
        </div>`;
      $('#astAddHere', out)?.addEventListener('click', async () => {
        try { await api('/api/apps-store/source', { method: 'POST', body: { source: repo }, requireOk: true }); toast('스토어 소스에 추가했습니다'); await load(true); }
        catch (e) { toast(e.message, 5000, 'danger'); }
      });
    };
    form.onsubmit = (ev) => { ev.preventDefault(); check(); };
    input.oninput = () => { clearTimeout(timer); timer = setTimeout(check, 700); };
  }

  // ---------- pull to refresh (touch, at the top of the view) ----------
  function wirePullToRefresh(box) {
    const view = $('#view');
    const ind = document.createElement('div');
    ind.className = 'ast-ptr'; ind.innerHTML = SVG.refresh; ind.setAttribute('aria-hidden', 'true');
    box.parentElement.insertBefore(ind, box);
    let y0 = null, dy = 0, busy = false;
    box.addEventListener('touchstart', (e) => { if (!busy && view.scrollTop <= 0 && e.touches.length === 1) { y0 = e.touches[0].clientY; dy = 0; } }, { passive: true });
    box.addEventListener('touchmove', (e) => {
      if (y0 === null) return;
      dy = Math.max(0, Math.min(110, e.touches[0].clientY - y0));
      ind.style.opacity = String(Math.min(1, dy / 70));
      ind.style.transform = `translateY(${dy * 0.6 - 40}px) rotate(${dy * 3}deg)`;
    }, { passive: true });
    box.addEventListener('touchend', async () => {
      if (y0 === null) return;
      y0 = null;
      if (dy < 70 || route.page === 'register') { ind.style.opacity = '0'; ind.style.transform = 'translateY(-40px)'; return; }
      busy = true; ind.classList.add('is-refreshing'); ind.style.transform = 'translateY(14px)';
      try { await load(true); await window.viewAppStore(route, true); } catch {}
      ind.classList.remove('is-refreshing'); ind.style.opacity = '0'; ind.style.transform = 'translateY(-40px)'; busy = false;
    });
  }
})();
