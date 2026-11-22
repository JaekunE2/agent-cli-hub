// Interactive Codebase Floorplan & Health Check View (inspired by haydenschmitty/floorplan)
// - Scans the project workspace deterministically: UI / API / Core Modules / Data / Tests
// - Renders an interactive layered architecture map with Zoom/Pan + Blast Radius highlighting
// - Provides an instant "Ask / 영향 범위 검색" bar + Health Check panel with 1-click Task creation
// - Falls back seamlessly to Blueprint mode (dashed planned cards) when the folder has no source files yet

(function () {
  const LAYER_COLS = [
    { id: 'ui', title: '화면 · UI', cls: 'l-ui' },
    { id: 'api', title: '서버 · API 라우트', cls: 'l-api' },
    { id: 'service', title: '코어 모듈 · 로직', cls: 'l-svc' },
    { id: 'data', title: '데이터 · 저장소', cls: 'l-data' },
    { id: 'test', title: '테스트 · 설정', cls: 'l-test' },
  ];

  const colIndexOf = (layer) => {
    if (layer === 'ui') return 0;
    if (layer === 'api') return 1;
    if (layer === 'service') return 2;
    if (layer === 'data') return 3;
    return 4;
  };

  function buildBlueprintFallback(p) {
    const ico = window.UI_ICO || {};
    const topTasks = (p.tasks || []).filter((t) => !t.parentId);
    const cols = {
      plan: topTasks.filter((t) => (typeof taskKindOf === 'function' ? taskKindOf(t) : 'dev') === 'plan'),
      dev: topTasks.filter((t) => (typeof taskKindOf === 'function' ? taskKindOf(t) : 'dev') === 'dev'),
      test: topTasks.filter((t) => ['test', 'ops'].includes(typeof taskKindOf === 'function' ? taskKindOf(t) : 'dev')),
    };
    const renderCol = (lbl, items) => `<div class="fm-bp-col">
      <div class="fm-bp-col-hd">${esc(lbl)} <span class="badge">${items.length}</span></div>
      ${items.map((t) => `<div class="fm-bp-card${t.stage === 'planned' ? ' is-blueprint' : ''}" data-bp-task="${esc(t.id)}">
        <div class="row" style="justify-content:space-between;gap:6px">${typeof kindBadgeHTML === 'function' ? kindBadgeHTML(t) : ''}${typeof stageBadgeHTML === 'function' ? stageBadgeHTML(t.stage) : ''}</div>
        <b>${esc(t.title)}</b>
        ${t.detail ? `<p>${esc(t.detail)}</p>` : ''}
      </div>`).join('') || '<div class="empty" style="padding:14px 8px">항목 없음</div>'}
    </div>`;

    return `<div class="fm-wrap">
      <div class="fm-top-note">
        <div>
          <b>${ico.layers || ''} 설계 청사진 (Blueprint) 모드</b>
          <span class="ums" style="margin:0 0 0 8px">작업 폴더(${esc(p.cwd)})에 아직 소스 파일이 없어 프로젝트의 설계 태스크 청사진을 표시합니다. 점선 카드는 아직 시작 전(대기) 설계 항목입니다.</span>
        </div>
        <div class="row" style="gap:6px">
          <button type="button" class="primary btn-sm" id="fmPickDir" title="기존 코드가 있는 PC 폴더를 골라 Floorplan을 바로 테스트합니다">${ico.folder || ''} 다른 폴더 스캔 테스트</button>
          <button type="button" class="btn-sm" id="fmRescan">${ico.refresh || ''} 폴더 다시 스캔</button>
        </div>
      </div>
      <div class="fm-bp-grid">
        ${renderCol('기획 · 아키텍처', cols.plan)}
        ${renderCol('기능 · 모듈 구현', cols.dev)}
        ${renderCol('검증 · 배포', cols.test)}
      </div>
    </div>`;
  }

  async function projectFloorplan(p, gen, previewCwd = '') {
    const ico = window.UI_ICO || {};
    const host = $('#projectContent');
    if (!host) return;
    host.innerHTML = '<div class="empty" style="padding:24px 8px">코드 구조와 보안·품질 상태를 분석하는 중…</div>';

    let fp;
    try {
      const url = previewCwd
        ? `/api/projects/floorplan?cwd=${encodeURIComponent(previewCwd)}`
        : `/api/projects/floorplan?id=${encodeURIComponent(p.id)}`;
      const r = await api(url);
      if (gen !== viewGen) return;
      if (r.error || !r.floorplan) throw new Error(r.error || '코드 구조를 불러올 수 없습니다.');
      fp = r.floorplan;
    } catch (e) {
      if (gen !== viewGen) return;
      host.innerHTML = `<div class="pj-empty"><p role="alert">${esc(e.message)}</p><button type="button" id="fmRetry">다시 스캔</button></div>`;
      $('#fmRetry', host).onclick = () => projectFloorplan(p, gen, previewCwd);
      return;
    }

    if (!fp.exists || !fp.nodes?.length) {
      host.innerHTML = buildBlueprintFallback(previewCwd ? { ...p, cwd: previewCwd } : p);
      $('#fmRescan', host)?.addEventListener('click', () => projectFloorplan(p, gen, previewCwd));
      $('#fmPickDir', host)?.addEventListener('click', () => {
        if (typeof openFolderPickerDialog === 'function') {
          openFolderPickerDialog(previewCwd || p.cwd, (chosen) => projectFloorplan(p, gen, chosen));
        }
      });
      host.querySelectorAll('[data-bp-task]').forEach((el) => {
        el.onclick = () => {
          const t = (p.tasks || []).find((x) => x.id === el.dataset.bpTask);
          if (t && typeof openProjectTaskDrawer === 'function') openProjectTaskDrawer(p, t);
        };
      });
      return;
    }

    const nodes = fp.nodes;
    const edges = fp.edges || [];
    const issues = fp.health?.issues || [];
    const score = fp.health?.score ?? 100;
    const scoreCls = score >= 85 ? 'ok' : score >= 65 ? 'warn' : 'lim';

    // Build adjacency maps for instant Blast Radius calculation
    const outMap = new Map(nodes.map((n) => [n.id, new Set()]));
    const inMap = new Map(nodes.map((n) => [n.id, new Set()]));
    for (const e of edges) {
      outMap.get(e.from)?.add(e.to);
      inMap.get(e.to)?.add(e.from);
    }
    const blastOf = (startIds) => {
      const hi = new Set(startIds);
      const qOut = [...startIds];
      const qIn = [...startIds];
      while (qOut.length) {
        const cur = qOut.shift();
        for (const nxt of outMap.get(cur) || []) {
          if (!hi.has(nxt)) { hi.add(nxt); qOut.push(nxt); }
        }
      }
      while (qIn.length) {
        const cur = qIn.shift();
        for (const prev of inMap.get(cur) || []) {
          if (!hi.has(prev)) { hi.add(prev); qIn.push(prev); }
        }
      }
      return hi;
    };

    // Place nodes into layered grid columns
    const colBuckets = [[], [], [], [], []];
    for (const n of nodes) {
      const ci = colIndexOf(n.layer);
      colBuckets[ci].push(n);
    }
    for (const b of colBuckets) {
      b.sort((a, b2) => (b2.endpoints.length + b2.importedBy.length) - (a.endpoints.length + a.importedBy.length) || b2.lines - a.lines);
    }
    // Cap per-column visual nodes to keep map crisp and readable; show summary pill if clipped
    const MAX_PER_COL = 12;
    const visibleNodes = [];
    const visibleIds = new Set();
    const coords = new Map();
    const COL_W = 246, CARD_H = 104, COL_GAP = 72, ROW_GAP = 16, PAD_X = 24, PAD_Y = 48;
    let activeColIdx = 0;

    for (let ci = 0; ci < colBuckets.length; ci++) {
      const bucket = colBuckets[ci].slice(0, MAX_PER_COL);
      if (!bucket.length) continue;
      const x = PAD_X + activeColIdx * (COL_W + COL_GAP);
      bucket.forEach((n, ri) => {
        visibleNodes.push({ ...n, visualCol: activeColIdx, hiddenMore: colBuckets[ci].length > MAX_PER_COL && ri === bucket.length - 1 ? colBuckets[ci].length - MAX_PER_COL : 0 });
        visibleIds.add(n.id);
        coords.set(n.id, { x, y: PAD_Y + ri * (CARD_H + ROW_GAP), colX: x, title: LAYER_COLS[ci].title, count: colBuckets[ci].length });
      });
      activeColIdx++;
    }

    const colHeaders = [];
    const seenCol = new Set();
    for (const vn of visibleNodes) {
      const pt = coords.get(vn.id);
      if (!seenCol.has(vn.visualCol)) {
        seenCol.add(vn.visualCol);
        colHeaders.push(`<div class="fm-col-hdr" style="left:${pt.x}px;top:14px">${esc(pt.title)} <span class="badge">${pt.count}</span></div>`);
      }
    }

    const cardsHTML = visibleNodes.map((n) => {
      const pt = coords.get(n.id);
      const epTag = n.endpoints.length ? `<span class="badge c">API ${n.endpoints.length}</span>` : '';
      const callTag = n.calls.length ? `<span class="badge">호출 ${n.calls.length}</span>` : '';
      const issTag = n.hasIssue ? `<span class="badge warn" title="보안/구조 점검 항목 있음">점검</span>` : '';
      return `<article class="fm-node layer-${esc(n.layer)}" data-fm-node="${esc(n.id)}" style="left:${pt.x}px;top:${pt.y}px">
        <div class="fm-node-hd">
          <b title="${esc(n.relPath)}">${esc(n.name)}</b>
          <span class="ums mono" style="margin:0;font-size:10.5px">${n.lines}L</span>
        </div>
        <div class="fm-node-path mono" title="${esc(n.relPath)}">${esc(n.relPath)}</div>
        <div class="fm-node-desc">${esc(n.summary)}</div>
        <div class="fm-node-tags">${epTag}${callTag}${issTag}</div>
      </article>`;
    }).join('');

    const issueHTML = issues.map((it, idx) => {
      const sevBadge = it.severity === 'critical'
        ? '<span class="badge lim">위험</span>'
        : it.severity === 'warn'
          ? '<span class="badge warn">주의</span>'
          : '<span class="badge">정보</span>';
      return `<div class="m-row" style="cursor:default">
        <div class="m-row-main">
          <div class="m-row-t" style="display:flex;align-items:center;gap:7px;flex-wrap:wrap">${sevBadge}<span>${esc(it.title)}</span><span class="mono ums" style="margin:0">${esc(it.file)}:${it.line}</span></div>
          <div class="m-row-s" style="white-space:normal">${esc(it.detail)}</div>
        </div>
        <div class="m-row-end">
          <button type="button" class="btn-sm" data-fm-focus="${esc(it.file)}" title="구조 맵에서 해당 파일 위치·영향 범위 보기">위치 보기</button>
          <button type="button" class="primary btn-sm" data-fm-fix="${idx}" title="이 점검 항목을 Project 작업 카드로 바로 추가">${ico.plus || ''} 수정 작업 추가</button>
        </div>
      </div>`;
    }).join('') || '<div class="empty" style="padding:18px 16px">감지된 보안·구조 이슈가 없습니다. 깔끔한 코드베이스입니다!</div>';

    host.innerHTML = `<div class="fm-wrap">
      <div class="pj-flow-bar">
        <div class="row" style="gap:8px;flex-wrap:wrap;flex:1;min-width:0">
          <div class="fm-ask-box">
            ${ico.search || ''}
            <input id="fmAskIn" type="search" placeholder="질문·라우트·파일명으로 영향 범위(Blast Radius) 추적… (예: api/projects, auth, token)" autocomplete="off">
          </div>
          <button type="button" class="btn-sm" id="fmAskClear" hidden>선택 해제</button>
          <span class="badge ${scoreCls}" id="fmHealthBadge" title="코드 건강도 점수 (시크릿·인증·파일 크기 기반)">건강도 ${score}점 · 이슈 ${issues.length}건</span>
        </div>
        <div class="row" style="gap:4px">
          <span class="ums" style="margin:0 6px 0 0">${fp.stats.files}파일 · ${fp.stats.lines.toLocaleString()}줄 · API ${fp.stats.endpoints}개</span>
          <button type="button" class="ghost btn-sm" id="fmZoomFit" title="전체 구조가 보이도록 화면 맞춤">화면 맞춤</button>
          <button type="button" class="ghost btn-sm" id="fmZoomOut" title="축소">－</button>
          <button type="button" class="ghost btn-sm mono" id="fmZoomReset" title="100% 배율">100%</button>
          <button type="button" class="ghost btn-sm" id="fmZoomIn" title="확대">＋</button>
          <button type="button" class="btn-sm" id="fmPickDir" title="다른 폴더를 선택해 코드 구조 스캔 테스트">${ico.folder || ''} 폴더 변경</button>
          <button type="button" class="btn-sm" id="fmRescan" title="작업 폴더를 다시 스캔">${ico.refresh || ''} 재스캔</button>
        </div>
      </div>
      ${previewCwd ? `<div class="fm-top-note" style="padding:7px 12px"><span>미리보기 스캔 경로: <b class="mono">${esc(previewCwd)}</b></span><button type="button" class="btn-sm" id="fmBackProjDir">현재 Project 폴더로 돌아가기</button></div>` : ''}

      <div class="fm-ask-res" id="fmAskRes" hidden></div>

      <div class="pj-flow fm-viewport" id="fmViewport">
        <div class="pj-flow-canvas" id="fmCanvas">
          <svg class="pj-edges" aria-hidden="true"></svg>
          ${colHeaders.join('')}
          ${cardsHTML}
        </div>
      </div>

      <section class="sheet" id="fmHealthSheet">
        <div class="sheet-hd">
          <h3>${ico.flask || ''} 코드 보안 · 구조 점검 (Health Check) <span class="badge ${scoreCls}">${score}점</span></h3>
          <span class="ums" style="margin:0">${fp.externalServices?.length ? `감지된 연동: ${esc(fp.externalServices.join(' · '))}` : '무의존성 정적 분석 결과'}</span>
        </div>
        <div>${issueHTML}</div>
      </section>
    </div>`;

    const viewport = $('#fmViewport', host);
    const canvas = $('#fmCanvas', host);
    const svg = canvas.querySelector('svg');
    const askIn = $('#fmAskIn', host);
    const askRes = $('#fmAskRes', host);
    const clearBtn = $('#fmAskClear', host);
    const nodeEls = new Map([...canvas.querySelectorAll('[data-fm-node]')].map((el) => [el.dataset.fmNode, el]));

    let zoom = 1;
    let focusSet = null; // Set<nodeId> | null

    const maxX = Math.max(760, activeColIdx * (COL_W + COL_GAP) + 40);
    const maxColItems = Math.max(1, ...colBuckets.map((b) => Math.min(MAX_PER_COL, b.length)));
    const maxY = Math.max(420, PAD_Y + maxColItems * (CARD_H + ROW_GAP) + 32);
    canvas.style.width = `${maxX}px`;
    canvas.style.height = `${maxY}px`;
    svg.setAttribute('width', maxX);
    svg.setAttribute('height', maxY);

    const drawEdges = () => {
      if (gen !== viewGen || !canvas.isConnected) return;
      for (const [id, el] of nodeEls.entries()) {
        el.classList.toggle('is-dim', !!(focusSet && !focusSet.has(id)));
        el.classList.toggle('is-focus', !!(focusSet && focusSet.has(id)));
      }
      const visEdges = edges.filter((e) => visibleIds.has(e.from) && visibleIds.has(e.to));
      const paths = visEdges.map((e) => {
        const a = coords.get(e.from), b = coords.get(e.to);
        if (!a || !b) return '';
        const isHi = focusSet && focusSet.has(e.from) && focusSet.has(e.to);
        const isDim = focusSet && !isHi;
        const x1 = a.x + COL_W, y1 = a.y + CARD_H / 2;
        const x2 = b.x, y2 = b.y + CARD_H / 2;
        const dx = Math.max(36, Math.abs(x2 - x1) * 0.45);
        const cls = `pj-edge-path${e.kind === 'api' ? ' fm-edge-api' : ''}${isHi ? ' hi' : ''}${isDim ? ' dim' : ''}`;
        const marker = isHi ? 'url(#fmArrHi)' : 'url(#fmArr)';
        if (x2 >= x1 - 10) {
          return `<path class="${cls}" d="M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}" marker-end="${marker}"/>`;
        }
        return `<path class="${cls}" d="M ${a.x} ${y1} C ${a.x - 42} ${y1}, ${b.x + COL_W + 42} ${y2}, ${b.x + COL_W} ${y2}" marker-end="${marker}"/>`;
      }).filter(Boolean);

      svg.innerHTML = `<defs>
        <marker id="fmArr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z"/></marker>
        <marker id="fmArrHi" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path class="hi" d="M 0 0 L 10 5 L 0 10 z"/></marker>
      </defs>${paths.join('')}`;
    };

    const showNodeSummary = (nodeIds, headingText) => {
      if (!nodeIds.length) {
        focusSet = null;
        clearBtn.hidden = true;
        askRes.hidden = true;
        drawEdges();
        return;
      }
      const blast = blastOf(nodeIds);
      focusSet = blast;
      clearBtn.hidden = false;
      drawEdges();

      const primary = nodes.find((n) => n.id === nodeIds[0]);
      if (nodeIds.length === 1 && primary) {
        const eps = primary.endpoints.slice(0, 6).map((e) => `<span class="badge c mono">${esc(e.method)} ${esc(e.path)}</span>`).join(' ');
        const callers = [...(inMap.get(primary.id) || [])].slice(0, 6).map((id) => `<button type="button" class="btn-sm" data-fm-focus="${esc(id)}">${esc(id)}</button>`).join(' ');
        const deps = [...(outMap.get(primary.id) || [])].slice(0, 6).map((id) => `<button type="button" class="btn-sm" data-fm-focus="${esc(id)}">${esc(id)}</button>`).join(' ');
        askRes.hidden = false;
        askRes.innerHTML = `<div class="row" style="justify-content:space-between;gap:8px">
          <div><b class="mono">${esc(primary.relPath)}</b> <span class="badge">${primary.lines}줄</span> <span class="ums" style="margin:0 0 0 6px">${esc(primary.summary)}</span></div>
          <button type="button" class="primary btn-sm" id="fmCreateTaskFromNode">${ico.plus || ''} 이 파일 수정 태스크 생성</button>
        </div>
        ${eps ? `<div class="row" style="gap:5px;flex-wrap:wrap"><span class="ums" style="margin:0">엔드포인트:</span>${eps}</div>` : ''}
        ${(callers || deps) ? `<div class="row" style="gap:5px;flex-wrap:wrap">${callers ? `<span class="ums" style="margin:0">호출하는 곳:</span>${callers}` : ''}${deps ? `<span class="ums" style="margin:0 0 0 8px">의존 대상:</span>${deps}` : ''}</div>` : ''}`;
        $('#fmCreateTaskFromNode', askRes).onclick = async () => {
          const newTask = {
            id: newTaskId(),
            stage: 'planned',
            kind: primary.layer === 'test' ? 'test' : 'dev',
            title: `${primary.name} 기능 개선 및 점검`,
            detail: `대상 파일: ${primary.relPath} (${primary.summary})\n관련 영향 범위: ${[...blast].slice(0, 8).join(', ')}`,
            agent: '',
            account: null,
            model: '',
            effort: '',
            parentId: '',
            termId: '',
            after: [],
          };
          await saveProject({ ...p, tasks: [...p.tasks, newTask] }, 'design');
          toast(`“${newTask.title}” 작업을 추가했습니다`);
        };
      } else {
        askRes.hidden = false;
        askRes.innerHTML = `<div class="row" style="justify-content:space-between;gap:8px">
          <span><b>${esc(headingText)}</b> — 일치 모듈 ${nodeIds.length}개 · 연결된 영향 범위(Blast Radius) 총 ${blast.size}개 파일 하이라이트됨</span>
        </div>
        <div class="row" style="gap:5px;flex-wrap:wrap">${nodeIds.slice(0, 8).map((id) => `<button type="button" class="btn-sm" data-fm-focus="${esc(id)}">${esc(id)}</button>`).join('')}</div>`;
      }
    };

    const runQuery = (q) => {
      const terms = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
      if (!terms.length) return showNodeSummary([], '');
      const hits = nodes.filter((n) => {
        const hay = [
          n.relPath, n.summary, n.layer,
          ...n.endpoints.map((e) => `${e.method} ${e.path}`),
          ...n.calls.map((c) => c.path),
        ].join(' ').toLowerCase();
        return terms.every((t) => hay.includes(t));
      }).map((n) => n.id);
      showNodeSummary(hits, `“${q.trim()}” 검색 결과`);
    };

    const applyZoom = (nextZoom) => {
      zoom = Math.max(0.5, Math.min(1.4, Math.round(nextZoom * 20) / 20));
      canvas.style.transform = zoom === 1 ? '' : `scale(${zoom})`;
      canvas.style.transformOrigin = '0 0';
      $('#fmZoomReset', host).textContent = `${Math.round(zoom * 100)}%`;
    };
    const fitToViewport = () => {
      const vw = viewport.clientWidth || 1050;
      if (maxX > vw - 16) applyZoom(Math.max(0.55, Math.min(1, (vw - 20) / maxX)));
      else applyZoom(1);
    };

    drawEdges();
    fitToViewport();

    // Pan viewport
    let pan = null;
    viewport.addEventListener('pointerdown', (e) => {
      if (e.target.closest('[data-fm-node]')) return;
      pan = { x: e.clientX, y: e.clientY, sl: viewport.scrollLeft, st: viewport.scrollTop };
      viewport.classList.add('is-panning');
    });
    window.addEventListener('pointermove', (e) => {
      if (!pan) return;
      viewport.scrollLeft = pan.sl - (e.clientX - pan.x);
      viewport.scrollTop = pan.st - (e.clientY - pan.y);
    });
    window.addEventListener('pointerup', () => {
      if (pan) { pan = null; viewport.classList.remove('is-panning'); }
    });

    askIn.addEventListener('input', () => runQuery(askIn.value));
    clearBtn.onclick = () => { askIn.value = ''; showNodeSummary([], ''); };
    $('#fmRescan', host).onclick = () => projectFloorplan(p, gen, previewCwd);
    $('#fmPickDir', host).onclick = () => {
      if (typeof openFolderPickerDialog === 'function') {
        openFolderPickerDialog(previewCwd || p.cwd, (chosen) => projectFloorplan(p, gen, chosen));
      }
    };
    $('#fmBackProjDir', host)?.addEventListener('click', () => projectFloorplan(p, gen, ''));
    $('#fmHealthBadge', host).onclick = () => $('#fmHealthSheet', host)?.scrollIntoView({ behavior: 'smooth' });
    $('#fmZoomOut', host).onclick = () => applyZoom(zoom - 0.1);
    $('#fmZoomIn', host).onclick = () => applyZoom(zoom + 0.1);
    $('#fmZoomReset', host).onclick = () => applyZoom(1);
    $('#fmZoomFit', host).onclick = fitToViewport;

    host.addEventListener('click', async (e) => {
      const cardEl = e.target.closest('[data-fm-node]');
      if (cardEl) {
        showNodeSummary([cardEl.dataset.fmNode], '');
        return;
      }
      const focusBtn = e.target.closest('[data-fm-focus]');
      if (focusBtn) {
        const fid = focusBtn.dataset.fmFocus;
        showNodeSummary([fid], '');
        nodeEls.get(fid)?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
        return;
      }
      const fixBtn = e.target.closest('[data-fm-fix]');
      if (fixBtn) {
        const it = issues[Number(fixBtn.dataset.fmFix)];
        if (!it) return;
        fixBtn.disabled = true;
        try {
          const newTask = {
            id: newTaskId(),
            stage: 'planned',
            kind: it.severity === 'critical' || /보안|인증/.test(it.title) ? 'dev' : 'test',
            title: `[점검 수정] ${it.title}`,
            detail: `${it.detail}\n\n[수정 지시]\n${it.fixPrompt}`,
            agent: '',
            account: null,
            model: '',
            effort: '',
            parentId: '',
            termId: '',
            after: [],
          };
          await saveProject({ ...p, tasks: [...p.tasks, newTask] }, 'design');
          toast(`수정 작업 카드를 추가했습니다: ${newTask.title}`);
        } finally {
          if (fixBtn.isConnected) fixBtn.disabled = false;
        }
      }
    });
  }

  window.projectFloorplan = projectFloorplan;
})();
