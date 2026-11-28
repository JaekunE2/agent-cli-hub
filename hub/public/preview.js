// Canvas / IDE-style Auto-Split Preview Pane & Local Mermaid Flowchart Renderer
'use strict';
(function () {
  let mermaidPromise = null;
  let lastAppearance = '';
  let renderSeq = 0;
  let activeCtl = null;

  const SPLIT_PCT_KEY = 'ach.chatPvPct.v1';
  const DISMISS_PREFIX = 'ach.pvDismiss:';

  const isDarkTheme = () => {
    const dt = document.documentElement.dataset.theme;
    if (dt === 'dark') return true;
    if (dt === 'light') return false;
    return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
  };

  function ensureMermaid() {
    if (window.mermaid) return Promise.resolve(window.mermaid);
    if (mermaidPromise) return mermaidPromise;
    mermaidPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '/mermaid.js';
      s.async = true;
      s.onload = () => (window.mermaid ? resolve(window.mermaid) : reject(new Error('Mermaid unavailable')));
      s.onerror = () => reject(new Error('Failed to load mermaid.js'));
      document.head.appendChild(s);
    });
    return mermaidPromise;
  }

  /** Render any unrendered `.mermaid-host[data-mermaid-src]` inside `rootEl` into sanitized SVG. */
  async function hydrateMermaid(rootEl) {
    if (!rootEl || !rootEl.isConnected) return;
    const hosts = [...rootEl.querySelectorAll('.mermaid-host[data-mermaid-src]')];
    if (!hosts.length) return;
    const dark = isDarkTheme();
    const theme = dark ? 'dark' : 'light';
    const appearance = theme + ':' + (document.documentElement.dataset.font || 'jetbrains');
    try {
      const mmd = await ensureMermaid();
      if (lastAppearance !== appearance) {
        const fontFamily = getComputedStyle(document.documentElement).getPropertyValue('--ui-font').trim();
        mmd.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: 'base',
          themeVariables: dark
            ? {
              background: '#12161f',
              primaryColor: '#181d28',
              primaryTextColor: '#f1f3f7',
              primaryBorderColor: '#6d778a',
              lineColor: '#b6bfce',
              secondaryColor: '#1a1f2b',
              tertiaryColor: '#161922',
              clusterBkg: '#161b25',
              clusterBorder: '#475163',
              edgeLabelBackground: '#12161f',
              fontFamily,
              fontSize: '13px',
            }
            : {
              background: '#f5f5f3',
              primaryColor: '#ffffff',
              primaryTextColor: '#1e2430',
              primaryBorderColor: '#9aa3b2',
              lineColor: '#4b5669',
              secondaryColor: '#ececea',
              tertiaryColor: '#f6f7f9',
              clusterBkg: '#ececea',
              clusterBorder: '#c3c8d2',
              edgeLabelBackground: '#f5f5f3',
              fontFamily,
              fontSize: '13px',
            },
          flowchart: { useMaxWidth: true, htmlLabels: true, curve: 'stepAfter' },
        });
        lastAppearance = appearance;
      }
      for (const h of hosts) {
        if (!h.isConnected) continue;
        if (h.dataset.mmdAppearance === appearance && h.dataset.mmdDone === '1') continue;
        const src = h.dataset.mermaidSrc || '';
        if (!src.trim()) continue;
        try {
          const { svg, bindFunctions } = await mmd.render(`ach_mmd_${++renderSeq}`, src);
          if (!h.isConnected) continue;
          h.innerHTML = svg;
          bindFunctions?.(h);
          h.dataset.mmdAppearance = appearance;
          h.dataset.mmdDone = '1';
          h.classList.add('ready');
        } catch {
          h.dataset.mmdDone = 'err';
        }
      }
    } catch {}
  }

  function normCodeKind(lang) {
    const l = String(lang || '').trim().toLowerCase();
    if (l === 'htm' || l === 'html') return 'html';
    if (l === 'svg') return 'svg';
    if (l === 'md' || l === 'markdown') return 'markdown';
    if (l === 'mermaid' || l === 'mmd') return 'mermaid';
    if (l === 'json') return 'json';
    return 'text';
  }

  function supportsPreviewMode(kind) {
    return ['html', 'svg', 'markdown', 'mermaid'].includes(kind);
  }

  function itemBadgeLabel(item) {
    const k = item?.kind || 'text';
    if (k === 'html') return 'HTML';
    if (k === 'svg') return 'SVG';
    if (k === 'markdown') return 'MD';
    if (k === 'mermaid') return 'FLOW';
    if (item?.ext) return String(item.ext).toUpperCase();
    return 'CODE';
  }

  async function renderItemBody(bodyEl, item, mode = 'preview', sid = '', preserveScroll = false) {
    if (!bodyEl || !item) return;
    const prevScroll = preserveScroll ? bodyEl.scrollTop : 0;
    const restoreScroll = () => {
      if (preserveScroll && prevScroll > 0) requestAnimationFrame(() => { if (bodyEl.isConnected) bodyEl.scrollTop = prevScroll; });
    };

    if (item.source === 'code') {
      const text = String(item.code || '');
      if (mode === 'source' || !supportsPreviewMode(item.kind)) {
        let shown = text;
        if (item.kind === 'json') { try { shown = JSON.stringify(JSON.parse(text), null, 2); } catch {} }
        bodyEl.innerHTML = `<pre class="mdpre pv-code">${esc(shown)}</pre>`;
        restoreScroll();
        return;
      }
      if (item.kind === 'html') {
        const f = document.createElement('iframe');
        f.className = 'pv-frame';
        f.setAttribute('sandbox', 'allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms');
        f.srcdoc = text;
        bodyEl.replaceChildren(f);
        return;
      }
      if (item.kind === 'svg') {
        bodyEl.innerHTML = `<div class="pv-center"><img class="pv-svg-img" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}" alt="SVG 미리보기"></div>`;
        return;
      }
      if (item.kind === 'markdown') {
        bodyEl.innerHTML = `<div class="pv-doc">${typeof window.md === 'function' ? window.md(text) : `<pre class="mdpre">${esc(text)}</pre>`}</div>`;
        hydrateMermaid(bodyEl);
        restoreScroll();
        return;
      }
      if (item.kind === 'mermaid') {
        bodyEl.innerHTML = `<div class="pv-mermaid"><div class="mermaid-host" data-mermaid-src="${esc(text)}"><pre class="mdpre">${esc(text)}</pre></div></div>`;
        hydrateMermaid(bodyEl);
        restoreScroll();
        return;
      }
    }

    const it = item.artifact;
    const artSid = item.sid || sid;
    if (!it || !artSid) return;
    const authTok = typeof TOKEN !== 'undefined' ? TOKEN : (window.TOKEN || '');
    const url = typeof window.artUrl === 'function'
      ? window.artUrl(artSid, it.path)
      : `/api/artifact-file?session=${encodeURIComponent(artSid)}&path=${encodeURIComponent(it.path)}&t=${encodeURIComponent(authTok)}`;

    if (it.kind === 'video') {
      bodyEl.innerHTML = `<div class="pv-center"><video controls playsinline src="${url}" style="max-width:100%;max-height:100%;background:#000"></video></div>`;
    } else if (it.kind === 'audio') {
      bodyEl.innerHTML = `<div class="pv-center" style="padding:20px"><audio controls src="${url}" style="width:100%;max-width:480px"></audio></div>`;
    } else if (it.kind === 'image') {
      bodyEl.innerHTML = `<div class="pv-center"><img src="${url}" style="max-width:100%;max-height:100%;object-fit:contain"></div>`;
    } else if (it.kind === 'html' && mode !== 'source') {
      const frameUrl = window.isTauriHost?.() ? `${url}${url.includes('?') ? '&' : '?'}hub_ext=1` : url;
      bodyEl.innerHTML = `<div class="artifact-html-surface"><iframe class="pv-frame" src="${frameUrl}" sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms"></iframe></div>`;
    } else if (it.kind === 'pdf') {
      bodyEl.innerHTML = `<iframe class="pv-frame" src="${url}"></iframe>`;
    } else if (/^(pptx?|ppsx?|odp|docx?|odt|rtf)$/i.test(it.ext || '')) {
      if (!bodyEl.children.length) bodyEl.innerHTML = '<div class="empty" style="padding:18px">문서를 PDF로 변환하는 중…</div>';
      const pv = `${url}&preview=pdf`;
      const r = await fetch(pv, { method: 'HEAD' }).catch(() => null);
      if (!bodyEl.isConnected) return;
      if (!r || !r.ok) { bodyEl.innerHTML = '<div class="empty" style="padding:18px">미리보기를 만들지 못했습니다 — 새 탭이나 다운로드로 여세요.</div>'; return; }
      bodyEl.innerHTML = `<iframe class="pv-frame" src="${pv}"></iframe>`;
    } else if (it.kind === 'markdown' || it.kind === 'text' || (it.kind === 'html' && mode === 'source')) {
      if (it.size > 3e6) { bodyEl.innerHTML = '<div class="empty" style="padding:18px">파일이 커서 미리보기를 생략합니다 — 새 탭으로 여세요.</div>'; return; }
      const hadContent = !!bodyEl.querySelector('.pv-doc, .pv-code');
      if (!hadContent) bodyEl.innerHTML = '<div class="empty" style="padding:18px">불러오는 중…</div>';
      const txt = await (await fetch(url)).text();
      if (!bodyEl.isConnected) return;
      if (hadContent && item._cachedText === txt && bodyEl.dataset.pvMode === mode) return;
      item._cachedText = txt;
      bodyEl.dataset.pvMode = mode;
      if (it.kind === 'markdown' && mode !== 'source') {
        bodyEl.innerHTML = `<div class="pv-doc">${typeof window.md === 'function' ? window.md(txt) : `<pre class="mdpre">${esc(txt)}</pre>`}</div>`;
        hydrateMermaid(bodyEl);
      } else {
        let t = txt;
        if (it.ext === 'json') { try { t = JSON.stringify(JSON.parse(txt), null, 2); } catch {} }
        bodyEl.innerHTML = `<pre class="mdpre pv-code">${esc(t)}</pre>`;
      }
      restoreScroll();
    } else {
      bodyEl.innerHTML = `<div class="empty" style="padding:18px">이 형식(${esc(it.ext || it.kind)})은 인라인 미리보기를 지원하지 않습니다.</div>`;
    }
  }

  function openCodeModal({ title = '코드 미리보기', lang = 'html', code = '' }) {
    const kind = normCodeKind(lang);
    let mode = supportsPreviewMode(kind) ? 'preview' : 'source';
    const d = document.createElement('div');
    d.className = 'dlg';
    d.innerHTML = `<div class="box wide aview" role="dialog" aria-labelledby="pvmTitle">
      <div class="artifact-preview-head"><h2 id="pvmTitle" title="${esc(title)}">${esc(title)}</h2>
        <button type="button" class="ghost icon-btn btn-sm" id="pvmClose" aria-label="닫기">${UI_ICO.close}</button>
      </div>
      <div class="row a-view-actions">
        ${supportsPreviewMode(kind) ? `<div class="seg"><button type="button" data-pvm="preview" class="on">미리보기</button><button type="button" data-pvm="source">소스</button></div>` : ''}
        <button type="button" class="btn-sm" id="pvmCopy">${UI_ICO.copy} 복사</button>
      </div>
      <div id="pvmBody" class="avbody" style="min-height:62vh;display:flex;flex-direction:column"></div>
    </div>`;
    const previousFocus = document.activeElement;
    document.body.appendChild(d);
    $('#pvmClose', d).focus({ preventScroll: true });
    const close = () => { d.remove(); previousFocus?.focus({ preventScroll: true }); };
    d.onkeydown = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    const bodyEl = $('#pvmBody', d);
    const item = { id: 'modal', source: 'code', kind, title, code };
    const paint = () => {
      d.querySelectorAll('[data-pvm]').forEach((b) => b.classList.toggle('on', b.dataset.pvm === mode));
      renderItemBody(bodyEl, item, mode);
    };
    d.onclick = (e) => {
      if (e.target === d || e.target.closest('#pvmClose')) return close();
      const mb = e.target.closest('[data-pvm]');
      if (mb) { mode = mb.dataset.pvm; paint(); return; }
      if (e.target.closest('#pvmCopy')) window.copyText?.(code);
    };
    paint();
  }

  function isDismissed(sid) {
    if (!sid) return false;
    try { return sessionStorage.getItem(`${DISMISS_PREFIX}${sid}`) === '1'; } catch { return false; }
  }
  function setDismissed(sid, val) {
    if (!sid) return;
    try {
      if (val) sessionStorage.setItem(`${DISMISS_PREFIX}${sid}`, '1');
      else sessionStorage.removeItem(`${DISMISS_PREFIX}${sid}`);
    } catch {}
  }

  /**
   * Mount an auto-splitting Canvas preview pane directly inside a conversation `.chat-split` container.
   * Automatically shows side-by-side when previewable HTML/MD/SVG/Mermaid blocks or artifacts exist.
   */
  function mountPreviewPane({ rootEl, splitEl = null, resizerEl = null, getSessionId, getContext }) {
    if (!rootEl) return null;
    let chatItems = [];
    let artItems = [];
    let manualItems = [];
    let selectedId = '';
    let paneKind = 'preview';
    let sideProjectId = '';
    let viewMode = 'preview';
    let lastLoadedSid = '';
    let isPaneVisible = false;
    let lastPickSig = '';
    let lastRenderedSig = '';

    const applySplitRatio = () => {
      if (!splitEl || !rootEl) return;
      try {
        const pct = Number(localStorage.getItem(SPLIT_PCT_KEY));
        if (pct >= 28 && pct <= 68) rootEl.style.flex = `0 0 ${pct}%`;
      } catch {}
    };

    if (resizerEl && splitEl) {
      applySplitRatio();
      resizerEl.addEventListener('pointerdown', (e) => {
        if (window.innerWidth <= 900) return;
        e.preventDefault();
        resizerEl.setPointerCapture?.(e.pointerId);
        resizerEl.classList.add('dragging');
        const rect = splitEl.getBoundingClientRect();
        const move = (ev) => {
          if (rect.width <= 120) return;
          const pct = Math.max(28, Math.min(68, ((rect.right - ev.clientX) / rect.width) * 100));
          rootEl.style.flex = `0 0 ${pct.toFixed(1)}%`;
          try { localStorage.setItem(SPLIT_PCT_KEY, pct.toFixed(1)); } catch {}
        };
        const up = () => {
          resizerEl.classList.remove('dragging');
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          window.dispatchEvent(new Event('resize'));
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      });
    }

    rootEl.innerHTML = `<div class="pv-shell">
      <div class="pv-bar">
        <div class="seg" data-pv-panels role="tablist" aria-label="사이드 패널 선택">
          <button type="button" data-pv-panel="preview" class="on">미리보기</button>
          <button type="button" data-pv-panel="refs">산출물</button>
          <button type="button" data-pv-panel="floorplan">코드 구조</button>
        </div>
        <select class="btn-sm" data-pv-pick aria-label="미리보기 대상 선택"></select>
        <div class="seg" data-pv-modes role="tablist" aria-label="보기 전환">
          <button type="button" data-pv-mode="preview" class="on">미리보기</button>
          <button type="button" data-pv-mode="source">소스</button>
        </div>
        <div class="row pv-actions">
          <button type="button" class="btn-sm" data-pv-ask hidden>이 결과에 질문</button>
          <button type="button" class="btn-sm" data-pv-area hidden>영역 코멘트</button>
          <button type="button" class="ghost icon-btn btn-sm" data-pv-copy title="내용 복사" aria-label="복사">${UI_ICO.copy}</button>
          <button type="button" class="ghost icon-btn btn-sm" data-pv-ext title="새 탭에서 열기" aria-label="새 탭">${UI_ICO.external}</button>
          <button type="button" class="ghost icon-btn btn-sm" data-pv-refresh title="목록 새로고침" aria-label="새로고침">${UI_ICO.refresh}</button>
          <button type="button" class="ghost icon-btn btn-sm" data-pv-close title="사이드 패널 닫기" aria-label="닫기">${UI_ICO.close}</button>
        </div>
      </div>
      <div class="pv-review" data-pv-review hidden></div>
      <div class="pv-body" data-pv-body></div>
    </div>`;

    const panelsEl = $('[data-pv-panels]', rootEl);
    const pickEl = $('[data-pv-pick]', rootEl);
    const modesEl = $('[data-pv-modes]', rootEl);
    const askEl = $('[data-pv-ask]', rootEl);
    const areaEl = $('[data-pv-area]', rootEl);
    const askTarget = artifactChatTarget();
    const bodyEl = $('[data-pv-body]', rootEl);
    const reviewSlot = $('[data-pv-review]', rootEl);
    let areaReview = null;

    const stopPaneAreaReview = () => {
      if (areaReview) {
        areaReview.dispose?.();
        areaReview = null;
      }
      reviewSlot.replaceChildren();
      reviewSlot.hidden = true;
      areaEl.disabled = false;
    };

    const syncBarSideButtons = () => {
      document.querySelectorAll('[data-pv-side]').forEach((btn) => {
        const on = btn.dataset.pvSide === 'toggle' ? isPaneVisible : (isPaneVisible && paneKind === btn.dataset.pvSide);
        btn.classList.toggle('on', on);
        btn.setAttribute('aria-pressed', String(on));
      });
    };

    const setVisible = (show) => {
      const next = !!show;
      if (isPaneVisible === next) { syncBarSideButtons(); return; }
      isPaneVisible = next;
      if (!next) stopPaneAreaReview();
      rootEl.hidden = !next;
      if (resizerEl) resizerEl.hidden = !next;
      splitEl?.classList.toggle('has-pv', next);
      if (next) applySplitRatio();
      syncBarSideButtons();
    };

    const allItems = () => [...manualItems, ...chatItems, ...artItems];
    const findItem = (id) => allItems().find((x) => x.id === id) || allItems()[0] || null;
    const itemRenderSig = (item, mode) => {
      if (!item) return 'empty';
      if (item.source === 'code') return `code|${item.id}|${mode}|${String(item.code || '').length}|${String(item.code || '')}`;
      return `art|${item.id}|${mode}|${item.artifact?.mtime || 0}|${item.artifact?.size || 0}`;
    };

    let lastSideKey = '';
    const resolveSideContext = () => {
      const ctx = getContext?.() || {};
      const st = typeof state !== 'undefined' ? state : window.state;
      const projects = st?.projects || [];
      const linkedProject = ctx.project || null;
      const curKey = `${ctx.sid || getSessionId?.() || ''}|${ctx.termId || ''}`;
      if (curKey !== lastSideKey) {
        lastSideKey = curKey;
        sideProjectId = '';
      }
      const pickedProject = sideProjectId ? projects.find((x) => x.id === sideProjectId) || null : null;
      return {
        sid: ctx.sid || getSessionId?.() || '',
        termId: ctx.termId || '',
        cwd: ctx.cwd || linkedProject?.cwd || '',
        linkedProject,
        project: pickedProject,
        projects,
      };
    };

    const renderSpecialPanel = async () => {
      const ctx = resolveSideContext();
      if (paneKind === 'floorplan') {
        lastRenderedSig = `floorplan|${ctx.linkedProject?.id || ''}|${ctx.cwd}`;
        if (!ctx.cwd && !ctx.linkedProject) {
          bodyEl.innerHTML = '<div class="empty" style="padding:24px">이 세션의 작업 폴더(cwd)를 확인할 수 없습니다.</div>';
          return;
        }
        if (typeof window.renderFloorplanInto === 'function') {
          await window.renderFloorplanInto({
            host: bodyEl,
            p: ctx.linkedProject,
            cwd: ctx.cwd,
            gen: typeof viewGen === 'number' ? viewGen : 0,
            termCtx: { sessionId: ctx.sid, termId: ctx.termId },
          });
        } else {
          bodyEl.innerHTML = '<div class="empty" style="padding:24px">코드 구조 모듈을 불러오는 중입니다.</div>';
        }
        return;
      }
      if (paneKind === 'refs') {
        lastRenderedSig = `refs|${ctx.project?.id || ''}|${ctx.sid}|${ctx.termId}`;
        const scopeOpts = [
          (ctx.sid || ctx.termId) ? `<option value=""${!ctx.project ? ' selected' : ''}>현재 세션 산출물</option>` : '',
          ...ctx.projects.map((p) => `<option value="${esc(p.id)}"${p.id === ctx.project?.id ? ' selected' : ''}>프로젝트 · ${esc(p.name)}</option>`),
        ].filter(Boolean);
        const bar = scopeOpts.length > 1
          ? `<div class="row" style="gap:8px;padding:10px 12px;border-bottom:1px solid var(--line);align-items:center">
              <span class="ums" style="margin:0">대상</span>
              <select class="btn-sm" data-pv-proj style="max-width:260px">${scopeOpts.join('')}</select>
            </div>`
          : '';
        bodyEl.innerHTML = `${bar}<div data-pv-refs-host style="padding:10px 12px"></div>`;
        const sel = $('[data-pv-proj]', bodyEl);
        if (sel) {
          sel.onchange = () => {
            sideProjectId = sel.value;
            renderSpecialPanel();
          };
        }
        const host = $('[data-pv-refs-host]', bodyEl);
        const curGen = typeof viewGen === 'number' ? viewGen : 0;
        if (ctx.project && typeof window.projectRefsView === 'function') {
          await window.projectRefsView(ctx.project, curGen, host);
        } else if ((ctx.sid || ctx.termId) && typeof window.renderArtifacts === 'function') {
          await window.renderArtifacts(ctx.sid, curGen, ctx.termId, host);
        } else if (ctx.linkedProject && typeof window.projectRefsView === 'function') {
          await window.projectRefsView(ctx.linkedProject, curGen, host);
        } else {
          host.innerHTML = '<div class="empty" style="padding:24px">표시할 산출물이 없습니다.</div>';
        }
      }
    };

    const syncControlsAndPaint = (forcePaint = false) => {
      if (!rootEl.isConnected) return;
      panelsEl?.querySelectorAll('[data-pv-panel]').forEach((b) => b.classList.toggle('on', b.dataset.pvPanel === paneKind));
      syncBarSideButtons();
      const inPreview = paneKind === 'preview';
      pickEl.hidden = !inPreview;
      if (!inPreview) {
        stopPaneAreaReview();
        askEl.hidden = true;
        areaEl.hidden = true;
        modesEl.hidden = true;
        const sig = `${paneKind}|${sideProjectId}|${getSessionId?.() || ''}`;
        if (forcePaint || lastRenderedSig !== sig) renderSpecialPanel();
        return;
      }
      const list = allItems();
      const cur = findItem(selectedId);
      askEl.hidden = !(askTarget && cur?.source === 'artifact');
      if (cur && cur.id !== selectedId) selectedId = cur.id;

      const pickSig = list.map((it) => `${it.id}:${it.title}`).join('\n');
      if (pickSig !== lastPickSig) {
        lastPickSig = pickSig;
        pickEl.innerHTML = list.length
          ? list.map((it) => `<option value="${esc(it.id)}">[${esc(itemBadgeLabel(it))}] ${esc(it.title)}</option>`).join('')
          : '<option value="">미리볼 항목 없음</option>';
      }
      if (cur && pickEl.value !== cur.id) pickEl.value = cur.id;
      pickEl.disabled = !list.length;

      const canSource = cur && (
        (cur.source === 'code' && supportsPreviewMode(cur.kind))
        || (cur.source === 'artifact' && ['html', 'markdown'].includes(cur.kind))
      );
      modesEl.hidden = !canSource;
      if (!canSource) viewMode = 'preview';
      areaEl.hidden = !(askTarget && viewMode === 'preview' && canReviewArtifactArea(cur?.artifact));
      modesEl.querySelectorAll('[data-pv-mode]').forEach((b) => b.classList.toggle('on', b.dataset.pvMode === viewMode));

      if (!cur) {
        stopPaneAreaReview();
        if (lastRenderedSig !== 'empty' || forcePaint) {
          lastRenderedSig = 'empty';
          bodyEl.innerHTML = `<div class="empty" style="padding:24px;text-align:center;line-height:1.6">대화 중 생성된 HTML · Markdown · Mermaid 플로우차트의 미리보기 버튼이나 파일 링크를 누르면 이 창에서 바로 확인할 수 있습니다.</div>`;
        }
        return;
      }
      const nextSig = itemRenderSig(cur, viewMode);
      if (!forcePaint && nextSig === lastRenderedSig) return;
      stopPaneAreaReview();
      const sameItem = lastRenderedSig.startsWith(`${cur.source === 'code' ? 'code' : 'art'}|${cur.id}|`);
      lastRenderedSig = nextSig;
      renderItemBody(bodyEl, cur, viewMode, getSessionId?.() || '', sameItem);
    };

    const loadArtifacts = async (force = false) => {
      const sid = getSessionId?.();
      if (!sid) { artItems = []; return; }
      if (!force && sid === lastLoadedSid && artItems.length) return;
      lastLoadedSid = sid;
      try {
        const r = await window.api(`/api/artifacts?session=${encodeURIComponent(sid)}`);
        const raw = r?.items || [];
        artItems = raw
          .filter((it) => it.main || ['html', 'markdown', 'image', 'pdf'].includes(it.kind))
          .slice(0, 30)
          .map((it) => ({
            id: `art:${it.path}`,
            source: 'artifact',
            kind: it.kind,
            ext: it.ext,
            title: it.title || it.name,
            sid,
            artifact: it,
          }));
      } catch {
        artItems = [];
      }
    };

    const scanChatBlocks = (chatRoot) => {
      if (!chatRoot) return;
      const found = [];
      let idx = 0;
      for (const blk of chatRoot.querySelectorAll('.codeblk')) {
        const pre = blk.querySelector('.mermaid-src') || blk.querySelector('.mdpre');
        const host = blk.querySelector('.mermaid-host');
        const code = host ? (host.dataset.mermaidSrc || '') : (pre?.textContent || '');
        if (!code.trim()) continue;
        const langRaw = (blk.querySelector('.codeblk-hd > span')?.textContent || 'code').split('·')[0].trim();
        const kind = host ? 'mermaid' : normCodeKind(langRaw);
        if (!supportsPreviewMode(kind)) continue;
        idx++;
        const firstLine = code.trim().split('\n')[0].replace(/^[#<!-\s]+/, '').slice(0, 36);
        found.push({
          id: `chat:${idx}:${kind}`,
          source: 'code',
          kind,
          ext: langRaw || kind,
          title: `${langRaw.toUpperCase()} #${idx}${firstLine ? ` · ${firstLine}` : ''}`,
          code,
        });
      }
      chatItems = found.reverse();
      if (!selectedId && chatItems.length) selectedId = chatItems[0].id;
      // Keep the side panel closed unless the user explicitly opens it (no intrusive auto-split).
      if (isPaneVisible) syncControlsAndPaint();
    };

    const openCode = ({ title = '코드 미리보기', lang = 'html', code = '', mode = 'preview' }) => {
      const kind = normCodeKind(lang);
      setDismissed(getSessionId?.() || '', false);
      const existing = allItems().find((x) => x.source === 'code' && x.code === code && x.kind === kind);
      if (existing) {
        selectedId = existing.id;
      } else {
        const firstLine = String(code || '').trim().split('\n')[0].replace(/^[#<!-\s]+/, '').slice(0, 36);
        const item = {
          id: `manual:${Date.now()}:${manualItems.length}`,
          source: 'code',
          kind,
          ext: lang || kind,
          title: title && title !== '코드 미리보기' ? title : `${String(lang || kind).toUpperCase()}${firstLine ? ` · ${firstLine}` : ''}`,
          code,
        };
        manualItems = [item, ...manualItems.filter((x) => x.code !== code).slice(0, 9)];
        selectedId = item.id;
      }
      viewMode = supportsPreviewMode(kind) ? mode : 'source';
      setVisible(true);
      syncControlsAndPaint();
    };

    const openArtifact = (sid, it) => {
      if (!it) return;
      setDismissed(sid || getSessionId?.() || '', false);
      const id = `art:${it.path}`;
      const existing = artItems.find((x) => x.id === id);
      if (!existing) {
        artItems = [{
          id,
          source: 'artifact',
          kind: it.kind,
          ext: it.ext,
          title: it.title || it.name,
          sid,
          artifact: it,
        }, ...artItems];
      }
      selectedId = id;
      viewMode = 'preview';
      setVisible(true);
      syncControlsAndPaint();
    };

    const openPanel = (kind = 'preview') => {
      paneKind = ['preview', 'refs', 'floorplan'].includes(kind) ? kind : 'preview';
      setVisible(true);
      syncControlsAndPaint(true);
    };
    const togglePanel = (kind = 'preview') => {
      if (kind === 'toggle') {
        if (isPaneVisible) {
          setDismissed(getSessionId?.() || '', true);
          setVisible(false);
          return false;
        }
        openPanel(paneKind || 'preview');
        return true;
      }
      if (isPaneVisible && paneKind === kind) {
        setDismissed(getSessionId?.() || '', true);
        setVisible(false);
        return false;
      }
      openPanel(kind);
      return true;
    };

    panelsEl.onclick = (e) => {
      const b = e.target.closest('[data-pv-panel]');
      if (!b) return;
      paneKind = b.dataset.pvPanel;
      syncControlsAndPaint(true);
    };
    pickEl.onchange = () => { selectedId = pickEl.value; syncControlsAndPaint(); };
    modesEl.onclick = (e) => {
      const b = e.target.closest('[data-pv-mode]');
      if (!b) return;
      viewMode = b.dataset.pvMode;
      syncControlsAndPaint();
    };
    askEl.onclick = () => {
      const cur = findItem(selectedId);
      if (cur?.source !== 'artifact') return;
      if (window.matchMedia('(max-width: 900px)').matches) setVisible(false);
      askArtifactQuestion([cur.artifact], askTarget);
    };
    areaEl.onclick = () => {
      const item = findItem(selectedId)?.artifact;
      const initial = $('img, iframe', bodyEl);
      if (!initial || areaReview || !canReviewArtifactArea(item)) return;
      const review = {};
      const isActive = () => areaReview === review && rootEl.isConnected;
      areaReview = review;
      areaEl.disabled = true;
      try {
        review.dispose = startArtifactRegionReview({
          initial, slot: reviewSlot, item, isActive,
          async onSubmit(message, sent, regions, comment) {
            const text = `${quotePath(item.abs || item.path)}\n${message}`;
            await sendWithRegionCheck(initial, item, regions, askTarget, text, () => sendAreaReviewInChat(text, askTarget), comment);
            sent();
          },
          onStop() { stopPaneAreaReview(); areaEl.focus(); },
        });
        reviewSlot.hidden = false;
      } catch (error) {
        if (!isActive()) return;
        stopPaneAreaReview();
        reviewSlot.hidden = false;
        reviewSlot.textContent = error.message;
      }
    };
    $('[data-pv-copy]', rootEl).onclick = () => {
      const cur = findItem(selectedId);
      if (!cur) return;
      if (cur.source === 'code') return window.copyText?.(cur.code);
      if (cur._cachedText) return window.copyText?.(cur._cachedText);
      if (cur.artifact?.path) return window.copyText?.(cur.artifact.path);
    };
    $('[data-pv-ext]', rootEl).onclick = () => {
      const cur = findItem(selectedId);
      if (!cur) return;
      if (cur.source === 'artifact' && cur.artifact) {
        const u = window.artUrl(cur.sid || getSessionId?.(), cur.artifact.path);
        return window.openExternalUrl ? window.openExternalUrl(u) : window.open(u, '_blank', 'noopener');
      }
      if (cur.source === 'code') {
        const mime = cur.kind === 'html' ? 'text/html;charset=utf-8' : cur.kind === 'svg' ? 'image/svg+xml;charset=utf-8' : 'text/plain;charset=utf-8';
        const blobUrl = URL.createObjectURL(new Blob([cur.code || ''], { type: mime }));
        window.open(blobUrl, '_blank', 'noopener');
        setTimeout(() => URL.revokeObjectURL(blobUrl), 30000);
      }
    };
    $('[data-pv-refresh]', rootEl).onclick = async () => {
      if (paneKind === 'preview') await loadArtifacts(true);
      syncControlsAndPaint(true);
    };
    $('[data-pv-close]', rootEl).onclick = () => {
      setDismissed(getSessionId?.() || '', true);
      setVisible(false);
    };

    const refresh = async (force = false) => {
      await loadArtifacts(force);
      if (isPaneVisible && paneKind === 'preview') syncControlsAndPaint();
    };

    return {
      openCode,
      openArtifact,
      openPanel,
      togglePanel,
      scanChatBlocks,
      refresh,
      isOpen: () => isPaneVisible,
      currentPanel: () => paneKind,
      activeArtifact: (sid) => {
        if (!sid || !isPaneVisible || paneKind !== 'preview' || !rootEl.isConnected) return null;
        const item = findItem(selectedId);
        return item?.source === 'artifact' && item.sid === sid ? item.artifact : null;
      },
    };
  }

  window.ACH_PREVIEW = {
    hydrateMermaid,
    normCodeKind,
    openCodeModal,
    mountPreviewPane,
    setActiveController: (ctl) => { activeCtl = ctl || null; },
    getActiveController: () => activeCtl,
    hasActive: () => !!activeCtl,
    openCode: (opts) => (activeCtl ? activeCtl.openCode(opts) : openCodeModal(opts)),
    openArtifact: (sid, it) => activeCtl?.openArtifact(sid, it),
    openPanel: (kind) => activeCtl?.openPanel(kind),
    togglePanel: (kind) => activeCtl?.togglePanel(kind),
    scanChatBlocks: (chatEl) => activeCtl?.scanChatBlocks(chatEl),
  };
})();
