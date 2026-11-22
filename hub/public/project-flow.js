// Interactive DAG Workflow Canvas for Project Tasks:
// - Sugiyama-style non-overlapping auto-layout (barycenter ordering + collision-free grid)
// - Transitive reduction (hides redundant shortcut edges that cut across middle cards; toggleable)
// - Obstacle-aware smooth curve routing around intermediate cards
// - Free drag-and-drop positioning of any card (persisted per project in localStorage) + canvas pan & zoom
// - Hover highlighting of incoming/outgoing dependency chains

function flowPosKey(pid) { return `ach-flow-pos:${pid}`; }
function loadFlowPositions(pid) {
  try { return JSON.parse(localStorage.getItem(flowPosKey(pid)) || '{}') || {}; } catch { return {}; }
}
function saveFlowPositions(pid, map) {
  try { localStorage.setItem(flowPosKey(pid), JSON.stringify(map)); } catch {}
}
function isFlowSimplified() {
  try { return localStorage.getItem('ach-flow-simplify') !== '0'; } catch { return true; }
}
function setFlowSimplified(on) {
  try { localStorage.setItem('ach-flow-simplify', on ? '1' : '0'); } catch {}
}

// Compute effective edges (including parentId fallback when a subtask has no explicit `after`)
// and optionally apply transitive reduction so A->B->C doesn't also draw a messy A->C line through B.
function computeFlowEdges(tasks, simplify = true) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const rawAdj = new Map(tasks.map((t) => [t.id, new Set()])); // parent -> Set(child)
  const parentsOf = new Map(tasks.map((t) => [t.id, new Set()])); // child -> Set(parent)

  for (const t of tasks) {
    const explicit = (t.after || []).filter((id) => byId.has(id) && id !== t.id);
    if (explicit.length) {
      for (const pid of explicit) {
        rawAdj.get(pid).add(t.id);
        parentsOf.get(t.id).add(pid);
      }
    } else if (t.parentId && byId.has(t.parentId) && t.parentId !== t.id) {
      rawAdj.get(t.parentId).add(t.id);
      parentsOf.get(t.id).add(t.parentId);
    }
  }

  // Reachability check: can `from` reach `target` via a path of length >= 2?
  const canReachIndirect = (from, target) => {
    const stack = [...(rawAdj.get(from) || [])].filter((nxt) => nxt !== target);
    const seen = new Set(stack);
    while (stack.length) {
      const cur = stack.pop();
      if (cur === target) return true;
      for (const nxt of (rawAdj.get(cur) || [])) {
        if (!seen.has(nxt)) { seen.add(nxt); stack.push(nxt); }
      }
    }
    return false;
  };

  const edges = [];
  let hiddenCount = 0;
  for (const t of tasks) {
    for (const pid of parentsOf.get(t.id)) {
      const redundant = simplify && canReachIndirect(pid, t.id);
      if (redundant) { hiddenCount++; continue; }
      edges.push({ from: pid, to: t.id, isSub: t.parentId === pid && !(t.after || []).includes(pid) });
    }
  }
  return { edges, hiddenCount, parentsOf, rawAdj };
}

// Compute non-overlapping (x, y) coordinates using longest-path layering + barycenter ordering
function computeAutoFlowLayout(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const { parentsOf, rawAdj } = computeFlowEdges(tasks, false);
  const levels = new Map();
  const visiting = new Set();

  function depth(id) {
    if (levels.has(id)) return levels.get(id);
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const ps = [...(parentsOf.get(id) || [])].filter((p) => byId.has(p));
    const d = ps.length ? Math.max(0, ...ps.map((p) => 1 + depth(p))) : 0;
    visiting.delete(id);
    levels.set(id, d);
    return d;
  }

  const columns = [];
  for (const t of tasks) {
    const c = depth(t.id);
    (columns[c] ||= []).push(t);
  }

  // Barycenter ordering pass (forward + backward) to minimize edge crossings
  const rankInCol = new Map();
  columns.forEach((col) => col.forEach((t, idx) => rankInCol.set(t.id, idx)));

  for (let pass = 0; pass < 3; pass++) {
    for (let c = 1; c < columns.length; c++) {
      const col = columns[c];
      col.sort((a, b) => {
        const pa = [...(parentsOf.get(a.id) || [])];
        const pb = [...(parentsOf.get(b.id) || [])];
        const ba = pa.length ? pa.reduce((s, id) => s + (rankInCol.get(id) ?? 0), 0) / pa.length : (rankInCol.get(a.id) ?? 0);
        const bb = pb.length ? pb.reduce((s, id) => s + (rankInCol.get(id) ?? 0), 0) / pb.length : (rankInCol.get(b.id) ?? 0);
        return ba - bb;
      });
      col.forEach((t, idx) => rankInCol.set(t.id, idx));
    }
    for (let c = columns.length - 2; c >= 0; c--) {
      const col = columns[c];
      col.sort((a, b) => {
        const ca = [...(rawAdj.get(a.id) || [])];
        const cb = [...(rawAdj.get(b.id) || [])];
        const ba = ca.length ? ca.reduce((s, id) => s + (rankInCol.get(id) ?? 0), 0) / ca.length : (rankInCol.get(a.id) ?? 0);
        const bb = cb.length ? cb.reduce((s, id) => s + (rankInCol.get(id) ?? 0), 0) / cb.length : (rankInCol.get(b.id) ?? 0);
        return ba - bb;
      });
      col.forEach((t, idx) => rankInCol.set(t.id, idx));
    }
  }

  const CARD_W = 252;
  const CARD_H = 152;
  const COL_GAP = 86;
  const ROW_GAP = 26;
  const PAD_X = 28;
  const PAD_Y = 28;

  const maxRows = Math.max(1, ...columns.map((c) => (c ? c.length : 0)));
  const totalH = maxRows * CARD_H + (maxRows - 1) * ROW_GAP;
  const coords = {};

  columns.forEach((col, cIdx) => {
    if (!col || !col.length) return;
    const colH = col.length * CARD_H + (col.length - 1) * ROW_GAP;
    // Vertically center shorter columns relative to tallest column, with a slight stagger to avoid collinear horizontal lines
    const startY = PAD_Y + Math.max(0, Math.round((totalH - colH) / 2));
    const x = PAD_X + cIdx * (CARD_W + COL_GAP);
    col.forEach((t, rIdx) => {
      coords[t.id] = { x, y: startY + rIdx * (CARD_H + ROW_GAP), col: cIdx, row: rIdx };
    });
  });

  return { coords, columns };
}

function flowTopTasks(p) {
  const allIds = new Set((p.tasks || []).map((t) => t.id));
  return (p.tasks || []).filter((t) => !(t.parentId && allIds.has(t.parentId)));
}

function projectFlow(p) {
  const ico = window.UI_ICO || {};
  const topTasks = flowTopTasks(p);
  const canConnect = topTasks.some((t) => t.after.length);
  const missing = canConnect ? '' : '<div class="pj-empty" style="margin-bottom:12px"><p>카드 사이에 선행 작업이 아직 없습니다.</p><button id="flowGenerate">작업 흐름 생성</button></div>';
  if (!topTasks.length) return missing;

  const simplify = isFlowSimplified();
  const { hiddenCount } = computeFlowEdges(topTasks, simplify);
  const savedPos = loadFlowPositions(p.id);
  const hasCustomPos = Object.keys(savedPos).some((id) => topTasks.some((t) => t.id === id));

  const flowNode = (t) => {
    const subs = p.tasks.filter((x) => x.parentId === t.id);
    const subDone = subs.filter((x) => x.stage === 'done').length;
    const k = typeof taskKindOf === 'function' ? taskKindOf(t) : 'dev';
    const chatCnt = (p.subChats?.[t.id] || []).length;
    return `<article class="pj-task flow-node" data-task="${esc(t.id)}" data-stage="${esc(t.stage)}" data-kind="${esc(k)}">
      <span class="pj-port in" aria-hidden="true"></span>
      <span class="pj-port out" aria-hidden="true"></span>
      <div class="row" style="justify-content:space-between;gap:6px">
        <div class="row" style="gap:5px;min-width:0">${typeof kindBadgeHTML === 'function' ? kindBadgeHTML(t) : ''}${subs.length ? `<span class="badge" title="클릭해 우측 상세 패널에서 하위 서브태스크 확인">서브 ${subDone}/${subs.length}</span>` : ''}</div>
        <button class="ghost icon-btn btn-sm" data-task-more="${esc(t.id)}" aria-label="${esc(t.title)} 메뉴" aria-haspopup="menu" aria-expanded="false">${ico.more || '⋯'}</button>
      </div>
      <div class="pj-task-head">
        <button data-edit="${esc(t.id)}" class="pj-title">${esc(t.title)}</button>
      </div>
      ${t.detail ? `<p class="pj-card-desc">${esc(t.detail)}</p>` : ''}
      <div class="pj-task-foot">
        <div class="row" style="gap:5px;min-width:0">${projectCliBadgeHTML(p, t)}<button class="ghost btn-sm" data-subchat-task="${esc(t.id)}" title="서브 개발 채팅 열기" aria-label="서브 개발 채팅">${ico.chat || ''}${chatCnt ? ` ${chatCnt}` : ''}</button></div>
        ${projectStartBtnHTML(p, t)}
      </div>
    </article>`;
  };

  const controls = `<div class="pj-flow-bar">
    <div class="row" style="gap:8px;flex-wrap:wrap">
      <button type="button" class="btn-sm" id="flowAutoLayout" title="겹침 없이 계층·교차 최소화 기준으로 자동 재배치">${ico.refresh || ''} 자동 정렬${hasCustomPos ? ' (초기화)' : ''}</button>
      <button type="button" class="btn-sm${simplify ? ' on' : ''}" id="flowToggleSimplify" title="중간 단계를 거쳐 이미 연결된 중복 화살표를 숨겨 그래프 겹침을 줄입니다">
        간선 단순화 ${simplify ? `켜짐${hiddenCount ? ` (-${hiddenCount})` : ''}` : '꺼짐'}
      </button>
      <span class="ums" style="margin:0">카드를 드래그해 자유 이동 · 카드 클릭 시 서브 개발·하위 태스크 확인</span>
    </div>
    <div class="row" style="gap:4px">
      <button type="button" class="ghost btn-sm" id="flowZoomFit" title="전체 노드가 한눈에 보이도록 화면 맞춤">화면 맞춤</button>
      <button type="button" class="ghost btn-sm" id="flowZoomOut" title="축소">－</button>
      <button type="button" class="ghost btn-sm mono" id="flowZoomReset" title="100% 기본 배율">100%</button>
      <button type="button" class="ghost btn-sm" id="flowZoomIn" title="확대">＋</button>
    </div>
  </div>`;

  return `${missing}${controls}<div class="pj-flow" id="pjFlowViewport"><div class="pj-flow-canvas" id="pjFlowCanvas"><svg class="pj-edges" aria-hidden="true"></svg>${topTasks.map(flowNode).join('')}</div></div>`;
}

function bindProjectFlow(p, gen) {
  const generate = $('#flowGenerate');
  if (generate) generate.onclick = () => projectForm(p);
  const viewport = $('#pjFlowViewport');
  const canvas = $('#pjFlowCanvas');
  const svg = canvas?.querySelector('svg');
  if (!viewport || !canvas || !svg) return;

  const topTasks = flowTopTasks(p);
  const { coords: autoCoords } = computeAutoFlowLayout(topTasks);
  let savedPos = loadFlowPositions(p.id);
  const pos = {};
  for (const t of topTasks) {
    const sv = savedPos[t.id];
    const au = autoCoords[t.id] || { x: 28, y: 28 };
    pos[t.id] = (sv && Number.isFinite(sv.x) && Number.isFinite(sv.y))
      ? { x: Math.max(8, sv.x), y: Math.max(8, sv.y) }
      : { x: au.x, y: au.y };
  }

  const cardEls = new Map([...canvas.querySelectorAll('[data-task]')].map((el) => [el.dataset.task, el]));
  let zoom = 1;
  let hoverTaskId = null;

  const applyPositions = () => {
    for (const [id, el] of cardEls.entries()) {
      const pt = pos[id] || { x: 28, y: 28 };
      el.style.left = `${pt.x}px`;
      el.style.top = `${pt.y}px`;
    }
  };

  // Route edges cleanly; if a multi-column edge passes right through an intermediate card's box,
  // curve above or below that card so lines never slice across card titles!
  const drawEdges = () => {
    if (gen !== viewGen || !canvas.isConnected) return;
    const simplify = isFlowSimplified();
    const { edges } = computeFlowEdges(topTasks, simplify);

    const boxes = new Map();
    let maxRight = 720, maxBottom = 420;
    for (const [id, el] of cardEls.entries()) {
      const pt = pos[id] || { x: 28, y: 28 };
      const w = el.offsetWidth || 252;
      const h = el.offsetHeight || 144;
      boxes.set(id, { left: pt.x, top: pt.y, right: pt.x + w, bottom: pt.y + h, cx: pt.x + w / 2, cy: pt.y + h / 2, w, h });
      if (pt.x + w + 48 > maxRight) maxRight = pt.x + w + 48;
      if (pt.y + h + 48 > maxBottom) maxBottom = pt.y + h + 48;
    }
    canvas.style.width = `${maxRight}px`;
    canvas.style.height = `${maxBottom}px`;
    svg.setAttribute('width', maxRight);
    svg.setAttribute('height', maxBottom);

    const relatedNodes = new Set();
    if (hoverTaskId) {
      relatedNodes.add(hoverTaskId);
      for (const e of edges) {
        if (e.from === hoverTaskId) relatedNodes.add(e.to);
        if (e.to === hoverTaskId) relatedNodes.add(e.from);
      }
    }
    for (const [id, el] of cardEls.entries()) {
      el.classList.toggle('is-dim', !!(hoverTaskId && !relatedNodes.has(id)));
      el.classList.toggle('is-focus', !!(hoverTaskId && relatedNodes.has(id)));
    }

    const paths = edges.map((e) => {
      const a = boxes.get(e.from), b = boxes.get(e.to);
      if (!a || !b) return '';
      const isHi = hoverTaskId && (e.from === hoverTaskId || e.to === hoverTaskId);
      const isDim = hoverTaskId && !isHi;
      const cls = `pj-edge-path${isHi ? ' hi' : ''}${isDim ? ' dim' : ''}${e.isSub ? ' sub' : ''}`;
      const marker = isHi ? 'url(#pjArrowHi)' : 'url(#pjArrow)';

      // Standard forward edge (left -> right)
      if (b.left >= a.right - 20) {
        const x1 = a.right, y1 = a.cy;
        const x2 = b.left, y2 = b.cy;
        const dx = Math.max(40, (x2 - x1) * 0.48);

        // Check if any third card sits directly in the line segment corridor between (x1,y1) and (x2,y2)
        let detourY = null;
        if (x2 - x1 > 280) {
          for (const [oid, ob] of boxes.entries()) {
            if (oid === e.from || oid === e.to) continue;
            if (ob.right <= x1 + 12 || ob.left >= x2 - 12) continue;
            const tRatio = (ob.cx - x1) / Math.max(1, x2 - x1);
            const lineY = y1 + (y2 - y1) * tRatio;
            if (lineY >= ob.top - 18 && lineY <= ob.bottom + 18) {
              // Detour above or below whichever is closer
              const above = ob.top - 28;
              const below = ob.bottom + 28;
              detourY = Math.abs(lineY - above) <= Math.abs(lineY - below) ? above : below;
              break;
            }
          }
        }
        if (detourY !== null) {
          const midX = (x1 + x2) / 2;
          return `<path class="${cls}" d="M ${x1} ${y1} Q ${midX} ${detourY}, ${x2} ${y2}" marker-end="${marker}"/>`;
        }
        return `<path class="${cls}" d="M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}" marker-end="${marker}"/>`;
      }

      // Backward / vertical loop edge (when user drags a dependent card to the left of its prerequisite)
      const x1 = a.right, y1 = a.cy;
      const x2 = b.left, y2 = b.cy;
      const loopY = y2 >= y1 ? Math.max(a.bottom, b.bottom) + 36 : Math.min(a.top, b.top) - 36;
      return `<path class="${cls}" d="M ${x1} ${y1} C ${x1 + 54} ${loopY}, ${x2 - 54} ${loopY}, ${x2} ${y2}" marker-end="${marker}"/>`;
    }).filter(Boolean);

    svg.innerHTML = `<defs>
      <marker id="pjArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z"/></marker>
      <marker id="pjArrowHi" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path class="hi" d="M 0 0 L 10 5 L 0 10 z"/></marker>
    </defs>${paths.join('')}`;
  };

  applyPositions();
  requestAnimationFrame(drawEdges);
  window.onresize = drawEdges;

  // Hover highlight + Free Card Dragging (with 5px movement threshold so normal clicks still open Task Drawer!)
  let dragState = null;
  for (const [id, el] of cardEls.entries()) {
    el.draggable = false; // use smooth pointer dragging instead of HTML5 ghost image
    el.addEventListener('pointerenter', () => { if (!dragState) { hoverTaskId = id; drawEdges(); } });
    el.addEventListener('pointerleave', () => { if (!dragState && hoverTaskId === id) { hoverTaskId = null; drawEdges(); } });
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.target.closest('button, a, input, select, textarea')) return;
      dragState = {
        id,
        el,
        startX: e.clientX,
        startY: e.clientY,
        origX: pos[id]?.x || 0,
        origY: pos[id]?.y || 0,
        moved: false,
      };
      el.setPointerCapture?.(e.pointerId);
    });
  }

  canvas.addEventListener('pointermove', (e) => {
    if (!dragState) return;
    const dx = (e.clientX - dragState.startX) / zoom;
    const dy = (e.clientY - dragState.startY) / zoom;
    if (!dragState.moved && Math.hypot(dx, dy) < 5) return;
    dragState.moved = true;
    dragState.el.classList.add('is-dragging');
    pos[dragState.id] = {
      x: Math.max(8, Math.round((dragState.origX + dx) / 4) * 4),
      y: Math.max(8, Math.round((dragState.origY + dy) / 4) * 4),
    };
    dragState.el.style.left = `${pos[dragState.id].x}px`;
    dragState.el.style.top = `${pos[dragState.id].y}px`;
    drawEdges();
  });

  const endDrag = (e) => {
    if (!dragState) return;
    const wasMoved = dragState.moved;
    dragState.el.classList.remove('is-dragging');
    try { dragState.el.releasePointerCapture?.(e.pointerId); } catch {}
    dragState = null;
    if (wasMoved) {
      saveFlowPositions(p.id, pos);
      // Suppress the synthetic click right after dragging so dragging doesn't pop open the drawer
      canvas.dataset.justDragged = '1';
      setTimeout(() => { delete canvas.dataset.justDragged; }, 80);
      const autoBtn = $('#flowAutoLayout');
      if (autoBtn && !autoBtn.textContent.includes('초기화')) autoBtn.textContent = '✨ 자동 정렬 (초기화)';
    }
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  //Intercept click immediately after drag
  canvas.addEventListener('click', (e) => {
    if (canvas.dataset.justDragged === '1') {
      e.stopPropagation();
      e.preventDefault();
    }
  }, true);

  // Canvas background drag-to-pan
  let panState = null;
  viewport.addEventListener('pointerdown', (e) => {
    if (e.target !== viewport && e.target !== canvas && e.target !== svg) return;
    panState = { startX: e.clientX, startY: e.clientY, scrollL: viewport.scrollLeft, scrollT: viewport.scrollTop };
    viewport.classList.add('is-panning');
  });
  window.addEventListener('pointermove', (e) => {
    if (!panState) return;
    viewport.scrollLeft = panState.scrollL - (e.clientX - panState.startX);
    viewport.scrollTop = panState.scrollT - (e.clientY - panState.startY);
  });
  window.addEventListener('pointerup', () => {
    if (panState) { panState = null; viewport.classList.remove('is-panning'); }
  });

  // Toolbar controls: Auto-layout reset, Simplify toggle, Zoom
  const applyZoom = (nextZoom) => {
    zoom = Math.max(0.55, Math.min(1.5, Math.round(nextZoom * 20) / 20));
    canvas.style.transform = zoom === 1 ? '' : `scale(${zoom})`;
    canvas.style.transformOrigin = '0 0';
    const zBtn = $('#flowZoomReset');
    if (zBtn) zBtn.textContent = `${Math.round(zoom * 100)}%`;
  };
  const autoBtn = $('#flowAutoLayout');
  if (autoBtn) {
    autoBtn.onclick = () => {
      saveFlowPositions(p.id, {});
      for (const t of topTasks) {
        const au = autoCoords[t.id] || { x: 28, y: 28 };
        pos[t.id] = { x: au.x, y: au.y };
      }
      applyPositions();
      drawEdges();
      autoBtn.textContent = '✨ 자동 정렬';
      toast('겹침 방지 자동 정렬을 적용했습니다');
    };
  }
  const simpBtn = $('#flowToggleSimplify');
  if (simpBtn) {
    simpBtn.onclick = () => {
      const next = !isFlowSimplified();
      setFlowSimplified(next);
      const { hiddenCount } = computeFlowEdges(topTasks, next);
      simpBtn.classList.toggle('on', next);
      simpBtn.textContent = `간선 단순화 ${next ? `켜짐${hiddenCount ? ` (-${hiddenCount})` : ''}` : '꺼짐'}`;
      drawEdges();
    };
  }
  const zOut = $('#flowZoomOut'), zIn = $('#flowZoomIn'), zReset = $('#flowZoomReset'), zFit = $('#flowZoomFit');
  const fitToViewport = () => {
    const vw = viewport.clientWidth || 1100;
    const cw = parseFloat(canvas.style.width) || 720;
    if (cw > vw - 16) applyZoom(Math.max(0.65, Math.min(1, (vw - 24) / cw)));
    else applyZoom(1);
  };
  if (zOut) zOut.onclick = () => applyZoom(zoom - 0.1);
  if (zIn) zIn.onclick = () => applyZoom(zoom + 0.1);
  if (zReset) zReset.onclick = () => applyZoom(1);
  if (zFit) zFit.onclick = fitToViewport;
  requestAnimationFrame(() => { drawEdges(); fitToViewport(); });
}
