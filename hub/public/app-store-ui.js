// App Store view (Apps → 앱 스토어): home with a featured banner and category rows, search and category chips,
// an app page (screenshots, what's new, what it installs, source and version before install), "내 앱"
// (installed store apps: open / update / settings / uninstall) and "앱 등록" (check a repo, add it here,
// submit it to a public registry). Reads /api/apps-store*; installs go through the review dialog in apps-ui.js.
'use strict';
(function () {
  const H = () => window.appStoreHelpers;
  // categories come from the registry data (app.json store.category); they are data keys, not UI text
  let data = null;          // { entries, sources, submitUrls, unavailable }
  let route = { page: 'home' };
  let query = '', cat = '';
  let heroTimer = null;

  const assetUrl = (u) => (u && u.startsWith('/api/') ? `${u}&t=${encodeURIComponent(TOKEN)}` : u || '');
  const initials = (name) => esc(String(name || '?').trim().slice(0, 1).toUpperCase());
  const icon = (e, size = 'md') => (e.icon
    ? `<img class="ast-icon ast-icon-${size}" src="${esc(assetUrl(e.icon))}" alt="" loading="lazy">`
    : `<span class="ast-icon ast-icon-${size} ast-icon-ph" aria-hidden="true">${initials(e.name)}</span>`);
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
  const card = (e) => `<button type="button" class="ast-card" data-open="${esc(e.key)}">
      ${icon(e)}
      <span class="ast-card-text"><strong>${esc(e.name)}</strong>
        <span class="ast-tagline">${esc(e.tagline || e.description)}</span>
        <span class="ums">${esc([e.author, e.category].filter(Boolean).join(' · '))}</span></span>
    </button>`;
  const row = (title, list, id) => (list.length ? `<section class="ast-row" aria-labelledby="${id}">
      <h3 id="${id}">${esc(title)}</h3><div class="ast-scroller" role="list">${list.map((e) => `<div role="listitem">${card(e)}</div>`).join('')}</div></section>` : '');

  async function load(force) {
    if (data && !force) return data;
    data = await api('/api/apps-store', { requireOk: true });
    for (const e of data.entries) { e.category ||= (e.tags && e.tags[0]) || ''; e.tagline ||= ''; }
    return data;
  }
  const find = (key) => data?.entries.find((e) => e.key === key);

  function bar() {
    const tab = (page, label) => `<button type="button" class="btn-sm ${route.page === page ? 'primary' : ''}" data-ast-tab="${page}" ${route.page === page ? 'aria-current="page"' : ''}>${label}</button>`;
    setBar(`<h2 style="flex:none">${ICO.grid} 앱 스토어</h2>
      <nav class="ast-tabs" aria-label="앱 스토어">${tab('home', '둘러보기')}${tab('mine', '내 앱')}${tab('register', '앱 등록')}</nav>
      <span class="sp"></span>
      <button type="button" class="btn-sm" id="astSources" title="레지스트리·저장소 소스 관리">소스</button>
      <button type="button" class="btn-sm" id="astBack">Apps</button>`);
    document.querySelectorAll('[data-ast-tab]').forEach((b) => { b.onclick = () => go({ page: b.dataset.astTab }); });
    $('#astSources').onclick = () => H().sources();
    $('#astBack').onclick = () => viewApps();
  }

  function go(next) {
    route = next;
    window.viewAppStore(null, true);
  }

  window.viewAppStore = async function viewAppStore(next, keep) {
    if (next) route = next;
    else if (!keep) route = { page: 'home' };
    clearInterval(heroTimer);
    if (state.sel?.kind !== 'apps') select({ kind: 'apps' });
    bar();
    const v = $('#view');
    v.onclick = null;
    v.innerHTML = '<div class="ast" id="ast"><p class="ums" style="padding:24px">불러오는 중…</p></div>';
    try { await load(route.page === 'home' || route.page === 'mine'); } catch (e) { $('#ast').innerHTML = `<p class="empty">${esc(e.message)}</p>`; return; }
    const box = $('#ast');
    if (!box) return;
    if (route.page === 'app') return renderApp(box, route.key);
    if (route.page === 'mine') return renderMine(box);
    if (route.page === 'register') return renderRegister(box);
    return renderHome(box);
  };

  // ---------- home ----------
  function renderHome(box) {
    // every store app is an add-on for this hub: ones whose requirement it does not meet stay out of the lists
    const all = data.entries.filter((e) => e.compatible !== false);
    const hidden = data.entries.length - all.length;
    const q = query.trim().toLowerCase();
    const filtered = all.filter((e) => (!cat || e.category === cat)
      && (!q || [e.name, e.tagline, e.description, e.author, e.repo, ...(e.tags || [])].some((x) => String(x || '').toLowerCase().includes(q))));
    const cats = [...new Set(all.map((e) => e.category).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const featured = all.filter((e) => e.featured || e.screenshots?.length).slice(0, 5);
    const byDate = (a, b) => (Date.parse(b.added || b.updated || 0) || 0) - (Date.parse(a.added || a.updated || 0) || 0);
    const popular = all.filter((e) => Number.isInteger(e.installs)).sort((a, b) => b.installs - a.installs);
    box.innerHTML = `
      <div class="ast-search">
        <input type="search" id="astQ" value="${esc(query)}" placeholder="앱, 작성자, 태그 검색" aria-label="앱 스토어 검색">
        <div class="ast-chips" role="group" aria-label="카테고리">
          <button type="button" class="ast-chip" data-cat="" aria-pressed="${!cat}">전체</button>
          ${cats.map((c) => `<button type="button" class="ast-chip" data-cat="${esc(c)}" aria-pressed="${cat === c}">${esc(c)}</button>`).join('')}
        </div>
      </div>
      ${data.unavailable?.length ? `<p class="ums ast-warn" role="status">확인하지 못한 소스: ${esc(data.unavailable.join(', '))}</p>` : ''}
      ${hidden ? `<p class="ums" role="status">이 허브(CCD ${esc(data.hubVersion || '')})에서 쓸 수 없는 앱 ${hidden}개는 숨겼습니다.</p>` : ''}
      <div id="astBody"></div>`;
    const body = $('#astBody', box);
    if (!all.length) {
      body.innerHTML = `<div class="ast-empty"><p>표시할 앱이 없습니다. 레지스트리나 앱 저장소를 소스로 추가하세요.</p>
        <button type="button" class="primary" id="astAddSrc">소스 추가</button></div>`;
      $('#astAddSrc', body).onclick = () => H().sources();
    } else if (q || cat) {
      body.innerHTML = filtered.length ? `<div class="ast-grid">${filtered.map(card).join('')}</div>`
        : '<p class="empty">조건에 맞는 앱이 없습니다.</p>';
    } else {
      body.innerHTML = `
        ${featured.length ? `<section class="ast-hero" aria-roledescription="carousel" aria-label="추천 앱">
          ${featured.map((e, i) => `<article class="ast-slide" ${i ? 'hidden' : ''} aria-roledescription="slide" aria-label="${i + 1} / ${featured.length}">
            ${e.screenshots?.[0] ? `<img class="ast-slide-bg" src="${esc(assetUrl(e.screenshots[0]))}" alt="">` : ''}
            <div class="ast-slide-text">${icon(e, 'lg')}<div><span class="ums">추천</span><h3>${esc(e.name)}</h3><p>${esc(e.tagline || e.description)}</p>
              <button type="button" class="primary" data-open="${esc(e.key)}">자세히 보기</button></div></div>
          </article>`).join('')}
          ${featured.length > 1 ? `<div class="ast-dots">${featured.map((e, i) => `<button type="button" data-slide="${i}" aria-label="${esc(e.name)}" aria-current="${i === 0}"></button>`).join('')}</div>` : ''}
        </section>` : ''}
        ${row('새로 등록된 앱', [...all].sort(byDate).slice(0, 12), 'astNew')}
        ${row('많이 설치된 앱', popular.slice(0, 12), 'astPop')}
        ${cats.map((c, i) => row(c, all.filter((e) => e.category === c), `astCat${i}`)).join('')}`;
      startHero(body);
    }
    const qIn = $('#astQ', box);
    qIn.oninput = () => { query = qIn.value; renderHome(box); const n = $('#astQ'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); };
    box.querySelectorAll('[data-cat]').forEach((b) => { b.onclick = () => { cat = b.dataset.cat; renderHome(box); }; });
    box.onclick = (ev) => { const k = ev.target.closest('[data-open]')?.dataset.open; if (k) go({ page: 'app', key: k }); };
  }

  function startHero(root) {
    const slides = [...root.querySelectorAll('.ast-slide')];
    const dots = [...root.querySelectorAll('[data-slide]')];
    if (slides.length < 2) return;
    let i = 0, paused = false;
    const show = (n) => {
      i = (n + slides.length) % slides.length;
      slides.forEach((s, k) => { s.hidden = k !== i; });
      dots.forEach((d, k) => d.setAttribute('aria-current', String(k === i)));
    };
    dots.forEach((d) => { d.onclick = () => show(Number(d.dataset.slide)); });
    const hero = root.querySelector('.ast-hero');
    hero.addEventListener('mouseenter', () => { paused = true; });
    hero.addEventListener('mouseleave', () => { paused = false; });
    hero.addEventListener('focusin', () => { paused = true; });
    hero.addEventListener('focusout', () => { paused = false; });
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
      heroTimer = setInterval(() => { if (!paused && document.contains(hero)) show(i + 1); else if (!document.contains(hero)) clearInterval(heroTimer); }, 6000);
    }
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

  async function renderApp(box, key) {
    const e = find(key);
    if (!e) { box.innerHTML = '<p class="empty">앱을 찾을 수 없습니다.</p>'; return; }
    box.innerHTML = `<div class="ast-detail"><button type="button" class="ghost btn-sm" id="astHome">← 둘러보기</button>
      <header class="ast-head">${icon(e, 'xl')}<div class="ast-head-text"><h2>${esc(e.name)}</h2>
        <p class="ast-tagline">${esc(e.tagline || e.description)}</p>
        <p class="ums">${esc([e.author, e.category].filter(Boolean).join(' · '))}</p>
        <p>${signals(e)}</p></div>
        <div class="ast-cta" id="astCta"><span class="ums">패키지 확인 중…</span></div></header>
      ${e.screenshots?.length ? `<section aria-label="스크린샷"><div class="ast-shots">${e.screenshots.map((s, i) => `<a href="${esc(assetUrl(s))}" target="_blank" rel="noopener"><img src="${esc(assetUrl(s))}" alt="${esc(e.name)} 스크린샷 ${i + 1}" loading="lazy"></a>`).join('')}</div></section>` : ''}
      <div class="ast-cols"><div id="astMain"><p>${esc(e.description)}</p></div><aside id="astSide"></aside></div></div>`;
    $('#astHome', box).onclick = () => go({ page: 'home' });
    let pkg;
    try { pkg = (await api('/api/apps-store/package', { method: 'POST', body: { key }, requireOk: true })).package; }
    catch (err) { $('#astCta', box).innerHTML = `<span class="ums" role="alert">${esc(err.message)}</span>`; return; }
    if (!box.isConnected) return;
    const installed = Boolean(pkg.installedId);
    const outdated = installed && pkg.installedDigest && pkg.installedDigest !== pkg.digest;
    $('#astCta', box).innerHTML = pkg.unmet?.length && !installed
      ? `<span class="ast-badge warn" role="note">설치할 수 없음</span><span class="ums">${esc(pkg.unmet.join(', '))}</span>`
      : installed
        ? `<button type="button" class="primary" id="astOpen">열기</button>${outdated ? `<button type="button" id="astUpd" ${pkg.unmet?.length ? 'disabled' : ''}>업데이트</button>` : ''}`
        : '<button type="button" class="primary" id="astInstall">설치</button>';
    const done = () => { load(true).then(() => go({ page: 'app', key })); };
    $('#astInstall', box)?.addEventListener('click', () => H().install(e, (res) => { toast(`${pkg.name} 설치를 시작했습니다${res?.setupRun ? ' — 초기 환경 구성 진행 중' : ''}`, 5000); done(); }));
    $('#astUpd', box)?.addEventListener('click', () => H().install(e, () => { toast(`${pkg.name}을(를) 업데이트했습니다`, 5000); done(); }, { update: true }));
    $('#astOpen', box)?.addEventListener('click', () => viewApps(pkg.installedId));
    const inst = pkg.installs || {};
    const li = (items, f) => items.map((x) => `<li>${f(x)}</li>`).join('');
    $('#astMain', box).innerHTML = `
      ${pkg.whatsNew ? `<section class="ast-card-box"><h3>새로운 기능 <span class="ums">${esc(pkg.whatsNew.title)}</span></h3>${md(pkg.whatsNew.body)}</section>` : ''}
      <section class="ast-readme">${pkg.readme ? md(pkg.readme) : `<p>${esc(pkg.description)}</p>`}</section>`;
    $('#astSide', box).innerHTML = `
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
  }

  // ---------- my apps ----------
  async function renderMine(box) {
    const { apps = [] } = await api('/api/apps').catch(() => ({ apps: [] }));
    const mine = apps.filter((a) => a.storeSource);
    if (!box.isConnected) return;
    box.innerHTML = mine.length ? `<div class="ast-mine">${mine.map((a) => {
      const e = data.entries.find((x) => x.key === a.storeSource.key) || {};
      const stop = a.actions?.find((x) => x.id === 'stop');
      return `<article class="ast-mine-row">
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
    }).join('')}</div>` : '<div class="ast-empty"><p>스토어에서 설치한 앱이 없습니다.</p></div>';
    box.onclick = async (ev) => {
      const b = ev.target.closest('[data-m]');
      if (!b) return;
      const a = mine.find((x) => x.id === b.dataset.id);
      if (b.dataset.m === 'open') return viewApps(a.id);
      if (b.dataset.m === 'page') return go({ page: 'app', key: b.dataset.key });
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
        try {
          const r = await api(`/api/apps/${encodeURIComponent(a.id)}`, { method: 'DELETE', requireOk: true });
          toast(r.restartRequired ? '제거했습니다. 허브를 다시 시작하면 플러그인이 꺼집니다.' : '제거했습니다', 5000);
        } catch (er) {
          if (confirm(`${er.message}\n\n제거 스크립트를 건너뛰고 강제로 제거할까요?`)) {
            await api(`/api/apps/${encodeURIComponent(a.id)}?force=1`, { method: 'DELETE' }).catch((x) => toast(x.message, 5000, 'danger'));
          }
        }
        await load(true);
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
      out.innerHTML = '<p class="ums">검사 중…</p>';
      const r = await api('/api/apps-store/inspect', { method: 'POST', body: { repo } }).catch((e) => ({ checks: [{ label: '검사', pass: false, detail: e.message }] }));
      if (input.value.trim() !== repo) return;
      const m = r.manifest;
      const issue = submit && m ? `${submit}${submit.includes('?') ? '&' : '?'}${new URLSearchParams({ title: `Register app: ${m.name}`, repo: /^[\w.-]+\/[\w.-]+$/.test(r.repo) ? `https://github.com/${r.repo}` : repo, 'app-id': m.id, category: m.store?.category || '' })}` : '';
      out.innerHTML = `<ul class="ast-checks">${(r.checks || []).map((c) => `<li class="${c.pass ? 'ok' : 'bad'}"><span aria-hidden="true">${c.pass ? '✓' : '✗'}</span> ${esc(c.label)} <span class="ums">${esc(c.detail || '')}</span></li>`).join('')}</ul>
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
})();
