// Interactive DAG Workflow Canvas for Project Tasks:
// - Sugiyama-style non-overlapping auto-layout (barycenter ordering + collision-free grid)
// - Transitive reduction (hides redundant shortcut edges that cut across middle cards; toggleable)
// - Obstacle-aware smooth curve routing around intermediate cards
// - Free drag-and-drop positioning of any card (persisted per project in localStorage) + canvas pan & zoom
// - Hover highlighting of incoming/outgoing dependency chains

function flowDir() {
  try { return localStorage.getItem('ach-flow-dir') === 'tb' ? 'tb' : 'lr'; } catch { return 'lr'; }
}
function setFlowDir(dir) {
  try { localStorage.setItem('ach-flow-dir', dir === 'tb' ? 'tb' : 'lr'); } catch {}
}
function flowPosKey(pid, dir = flowDir()) { return `ach-flow-pos:${pid}:${dir}`; }
function loadFlowPositions(pid, dir = flowDir()) {
  try {
    const raw = localStorage.getItem(flowPosKey(pid, dir));
    if (raw) return JSON.parse(raw) || {};
    if (dir === 'lr') return JSON.parse(localStorage.getItem(`ach-flow-pos:${pid}`) || '{}') || {};
    return {};
  } catch { return {}; }
}
function saveFlowPositions(pid, map, dir = flowDir()) {
  try { localStorage.setItem(flowPosKey(pid, dir), JSON.stringify(map)); } catch {}
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
function computeAutoFlowLayout(tasks, dir = 'lr') {
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
  const LAYER_GAP = dir === 'tb' ? 68 : 86;
  const ITEM_GAP = dir === 'tb' ? 28 : 26;
  const PAD_X = 28;
  const PAD_Y = 28;

  const maxRows = Math.max(1, ...columns.map((c) => (c ? c.length : 0)));
  const coords = {};

  if (dir === 'tb') {
    const totalW = maxRows * CARD_W + (maxRows - 1) * ITEM_GAP;
    columns.forEach((col, cIdx) => {
      if (!col || !col.length) return;
      const rowW = col.length * CARD_W + (col.length - 1) * ITEM_GAP;
      const startX = PAD_X + Math.max(0, Math.round((totalW - rowW) / 2));
      const y = PAD_Y + cIdx * (CARD_H + LAYER_GAP);
      col.forEach((t, rIdx) => {
        coords[t.id] = { x: startX + rIdx * (CARD_W + ITEM_GAP), y, col: rIdx, row: cIdx };
      });
    });
  } else {
    const totalH = maxRows * CARD_H + (maxRows - 1) * ITEM_GAP;
    columns.forEach((col, cIdx) => {
      if (!col || !col.length) return;
      const colH = col.length * CARD_H + (col.length - 1) * ITEM_GAP;
      // Vertically center shorter columns relative to tallest column, with a slight stagger to avoid collinear horizontal lines
      const startY = PAD_Y + Math.max(0, Math.round((totalH - colH) / 2));
      const x = PAD_X + cIdx * (CARD_W + LAYER_GAP);
      col.forEach((t, rIdx) => {
        coords[t.id] = { x, y: startY + rIdx * (CARD_H + ITEM_GAP), col: cIdx, row: rIdx };
      });
    });
  }

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

  const dir = flowDir();
  const simplify = isFlowSimplified();
  const { hiddenCount } = computeFlowEdges(topTasks, simplify);
  const savedPos = loadFlowPositions(p.id, dir);
  const hasCustomPos = Object.keys(savedPos).some((id) => topTasks.some((t) => t.id === id));

  const flowNode = (t) => {
    const subs = p.tasks.filter((x) => x.parentId === t.id);
    const subDone = subs.filter((x) => x.stage === 'done').length;
    const k = typeof taskKindOf === 'function' ? taskKindOf(t) : 'dev';
    const menuAria = `${t.title} 메뉴`;
    return `<article class="pj-task flow-node" data-task="${esc(t.id)}" data-stage="${esc(t.stage)}" data-kind="${esc(k)}">
      <span class="pj-port in" aria-hidden="true"></span>
      <span class="pj-port out" aria-hidden="true"></span>
      <div class="row" style="justify-content:space-between;gap:6px">
        <div class="row" style="gap:5px;min-width:0;flex-wrap:wrap">${kindBadgeHTML(t)}${stageBadgeHTML(t.stage)}${typeof projectLiveStatusBadgeHTML === 'function' ? projectLiveStatusBadgeHTML(p, t) : ''}${typeof projectReviewBadgeHTML === 'function' ? projectReviewBadgeHTML(t) : ''}${subs.length ? `<span class="badge">하위 ${subDone}/${subs.length}</span>` : ''}</div>
        <button class="ghost icon-btn btn-sm" data-task-more="${esc(t.id)}" aria-label="${esc(menuAria)}" aria-haspopup="menu" aria-expanded="false">${ico.more || '⋯'}</button>
      </div>
      <div class="pj-task-head">
        <button data-edit="${esc(t.id)}" class="pj-title">${esc(t.title)}</button>
      </div>
      ${typeof projectReviewNoteHTML === 'function' ? projectReviewNoteHTML(t, true) : ''}
    </article>`;
  };

  const controls = `<div class="pj-flow-bar">
    <div class="row" style="gap:8px;flex-wrap:wrap">
      <button type="button" class="btn-sm" id="flowDirToggle" title="흐름 방향을 좌우(LR) 또는 상하(TB)로 전환합니다">${dir === 'tb' ? '흐름: 상하 ↕' : '흐름: 좌우 ↔'}</button>
      <button type="button" class="btn-sm" id="flowAutoLayout" title="겹침 없이 계층·교차 최소화 기준으로 자동 재배치">${ico.refresh || ''} 자동 정렬${hasCustomPos ? ' (초기화)' : ''}</button>
      <button type="button" class="btn-sm${simplify ? ' on' : ''}" id="flowToggleSimplify" title="중간 단계를 거쳐 이미 연결된 중복 화살표를 숨겨 그래프 겹침을 줄입니다">
        간선 단순화 ${simplify ? `켜짐${hiddenCount ? ` (-${hiddenCount})` : ''}` : '꺼짐'}
      </button>
      <button type="button" class="btn-sm danger" id="flowDeleteSelected" hidden title="선택한 카드를 일괄 삭제합니다 (Delete 키)">선택 삭제</button>
    </div>
    <div class="row" style="gap:4px">
      <button type="button" class="ghost btn-sm" id="flowZoomFit" title="전체 노드가 한눈에 보이도록 화면 맞춤">화면 맞춤</button>
      <button type="button" class="ghost btn-sm" id="flowZoomOut" title="축소">－</button>
      <button type="button" class="ghost btn-sm mono" id="flowZoomReset" title="100% 기본 배율">100%</button>
      <button type="button" class="ghost btn-sm" id="flowZoomIn" title="확대">＋</button>
    </div>
  </div>`;

  return `${missing}${controls}<div class="pj-flow dir-${dir}" id="pjFlowViewport"><div class="pj-flow-canvas" id="pjFlowCanvas"><svg class="pj-edges" aria-hidden="true"></svg>${topTasks.map(flowNode).join('')}</div></div>`;
}

function bindProjectFlow(p, gen) {
  const ico = window.UI_ICO || {};
  const generate = $('#flowGenerate');
  if (generate) generate.onclick = () => projectForm(p);
  const viewport = $('#pjFlowViewport');
  const canvas = $('#pjFlowCanvas');
  const svg = canvas?.querySelector('svg');
  if (!viewport || !canvas || !svg) return;

  const topTasks = flowTopTasks(p);
  let curDir = flowDir();
  let autoCoords = computeAutoFlowLayout(topTasks, curDir).coords;
  const pos = {};
  const loadPositionsForDir = (dir) => {
    autoCoords = computeAutoFlowLayout(topTasks, dir).coords;
    const svMap = loadFlowPositions(p.id, dir);
    for (const t of topTasks) {
      const sv = svMap[t.id];
      const au = autoCoords[t.id] || { x: 28, y: 28 };
      pos[t.id] = (sv && Number.isFinite(sv.x) && Number.isFinite(sv.y))
        ? { x: Math.max(8, sv.x), y: Math.max(8, sv.y) }
        : { x: au.x, y: au.y };
    }
    const hasCustom = Object.keys(svMap).some((id) => topTasks.some((t) => t.id === id));
    const autoBtn = $('#flowAutoLayout');
    if (autoBtn) autoBtn.innerHTML = `${ico.refresh || ''} 자동 정렬${hasCustom ? ' (초기화)' : ''}`;
  };
  loadPositionsForDir(curDir);

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

      if (curDir === 'tb') {
        if (b.top >= a.bottom - 20) {
          const x1 = a.cx, y1 = a.bottom;
          const x2 = b.cx, y2 = b.top;
          const dy = Math.max(36, (y2 - y1) * 0.48);

          let detourX = null;
          if (y2 - y1 > 210) {
            for (const [oid, ob] of boxes.entries()) {
              if (oid === e.from || oid === e.to) continue;
              if (ob.bottom <= y1 + 12 || ob.top >= y2 - 12) continue;
              const tRatio = (ob.cy - y1) / Math.max(1, y2 - y1);
              const lineX = x1 + (x2 - x1) * tRatio;
              if (lineX >= ob.left - 18 && lineX <= ob.right + 18) {
                const left = ob.left - 28;
                const right = ob.right + 28;
                detourX = Math.abs(lineX - left) <= Math.abs(lineX - right) ? left : right;
                break;
              }
            }
          }
          if (detourX !== null) {
            const midY = (y1 + y2) / 2;
            return `<path class="${cls}" d="M ${x1} ${y1} Q ${detourX} ${midY}, ${x2} ${y2}" marker-end="${marker}"/>`;
          }
          return `<path class="${cls}" d="M ${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}" marker-end="${marker}"/>`;
        }
        const x1 = a.cx, y1 = a.bottom;
        const x2 = b.cx, y2 = b.top;
        const loopX = x2 >= x1 ? Math.max(a.right, b.right) + 36 : Math.min(a.left, b.left) - 36;
        return `<path class="${cls}" d="M ${x1} ${y1} C ${loopX} ${y1 + 48}, ${loopX} ${y2 - 48}, ${x2} ${y2}" marker-end="${marker}"/>`;
      }

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

  // Hover highlight + Multi-select + Group/Single Card Dragging
  let dragState = null;
  let marqueeState = null;
  let marqueeEl = null;
  let panState = null;
  let suppressDragClick = false;
  const selectedIds = new Set();
  const canvasPoint = (e) => {
    const rect = canvas.getBoundingClientRect();
    return { x: (e.clientX - rect.left) / zoom, y: (e.clientY - rect.top) / zoom };
  };

  const delSelBtn = $('#flowDeleteSelected');
  const syncSelectionClasses = () => {
    for (const [id, el] of cardEls.entries()) {
      el.classList.toggle('is-selected', selectedIds.has(id));
    }
    if (delSelBtn) {
      delSelBtn.hidden = selectedIds.size === 0;
      delSelBtn.textContent = selectedIds.size > 0 ? `선택 삭제 (${selectedIds.size})` : '선택 삭제';
    }
  };

  const deleteSelectedTasks = async () => {
    const ids = [...selectedIds].filter((id) => p.tasks.some((t) => t.id === id));
    if (!ids.length) return;
    const msg = ids.length === 1
      ? '선택한 작업(하위 서브태스크 포함)을 삭제할까요?'
      : `선택한 작업 ${ids.length}개(하위 서브태스크 포함)를 모두 삭제할까요?`;
    if (!confirm(msg)) return;
    let nextTasks = [...p.tasks];
    for (const id of ids) {
      if (!nextTasks.some((t) => t.id === id)) continue;
      nextTasks = typeof removeTaskCascade === 'function'
        ? removeTaskCascade({ ...p, tasks: nextTasks }, id)
        : nextTasks.filter((t) => t.id !== id).map((t) => ({ ...t, after: t.after.filter((aid) => aid !== id) }));
    }
    selectedIds.clear();
    syncSelectionClasses();
    try {
      await saveProject({ ...p, tasks: nextTasks });
      toast(`작업 ${ids.length}개를 삭제했습니다.`);
    } catch (e) {
      toast(e.message, 5000, 'danger');
    }
  };
  if (delSelBtn) delSelBtn.onclick = deleteSelectedTasks;

  const onFlowKeyDown = (e) => {
    if (!viewport.isConnected || gen !== viewGen) {
      document.removeEventListener('keydown', onFlowKeyDown);
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIds.size > 0) {
      if (e.target && /^(INPUT|TEXTAREA|SELECT)$/i.test(e.target.tagName)) return;
      e.preventDefault();
      deleteSelectedTasks();
    }
  };
  document.addEventListener('keydown', onFlowKeyDown);

  for (const [id, el] of cardEls.entries()) {
    el.draggable = false; // use smooth pointer dragging instead of HTML5 ghost image
    el.addEventListener('pointerenter', () => { if (!dragState && !marqueeState) { hoverTaskId = id; drawEdges(); } });
    el.addEventListener('pointerleave', () => { if (!dragState && !marqueeState && hoverTaskId === id) { hoverTaskId = null; drawEdges(); } });
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || dragState || marqueeState || panState) return;
      if (e.target.closest('button:not(.pj-title), a, input, select, textarea')) return;
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        if (selectedIds.has(id)) selectedIds.delete(id);
        else selectedIds.add(id);
        syncSelectionClasses();
      } else if (!selectedIds.has(id)) {
        selectedIds.clear();
        syncSelectionClasses();
      }
      const groupIds = selectedIds.has(id) && selectedIds.size > 1 ? [...selectedIds] : [id];
      const origMap = new Map(groupIds.map((gid) => [gid, { x: pos[gid]?.x || 0, y: pos[gid]?.y || 0 }]));
      const origins = [...origMap.values()];
      dragState = {
        pointerId: e.pointerId,
        groupIds,
        origMap,
        start: canvasPoint(e),
        minDx: 8 - Math.min(...origins.map((p) => p.x)),
        minDy: 8 - Math.min(...origins.map((p) => p.y)),
        moved: false,
      };
      e.target.setPointerCapture?.(e.pointerId);
    });
  }

  canvas.addEventListener('pointermove', (e) => {
    if (dragState?.pointerId !== e.pointerId) return;
    const point = canvasPoint(e);
    const dx = point.x - dragState.start.x;
    const dy = point.y - dragState.start.y;
    if (!dragState.moved && Math.hypot(dx, dy) < 5) return;
    dragState.moved = true;
    const moveX = Math.max(dragState.minDx, Math.round(dx / 4) * 4);
    const moveY = Math.max(dragState.minDy, Math.round(dy / 4) * 4);
    for (const gid of dragState.groupIds) {
      const gel = cardEls.get(gid);
      const orig = dragState.origMap.get(gid);
      if (!gel || !orig) continue;
      gel.classList.add('is-dragging');
      pos[gid] = { x: orig.x + moveX, y: orig.y + moveY };
      gel.style.left = `${pos[gid].x}px`;
      gel.style.top = `${pos[gid].y}px`;
    }
    drawEdges();
  });

  const endDrag = (e) => {
    if (dragState?.pointerId !== e.pointerId) return;
    const { moved, groupIds, origMap } = dragState;
    const canceled = e.type === 'pointercancel';
    for (const gid of groupIds) {
      cardEls.get(gid)?.classList.remove('is-dragging');
      if (canceled) pos[gid] = origMap.get(gid);
    }
    dragState = null;
    if (canceled) { applyPositions(); drawEdges(); return; }
    if (moved) {
      saveFlowPositions(p.id, pos, curDir);
      suppressDragClick = true;
      const autoBtn = $('#flowAutoLayout');
      if (autoBtn && !autoBtn.textContent.includes('초기화')) autoBtn.innerHTML = `${ico.refresh || ''} 자동 정렬 (초기화)`;
    }
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  // Intercept click immediately after drag
  canvas.addEventListener('pointerdown', () => { suppressDragClick = false; }, true);
  canvas.addEventListener('click', (e) => {
    const selectClick = (e.shiftKey || e.ctrlKey || e.metaKey) && e.target.closest('.flow-node')
      && !e.target.closest('button:not(.pj-title), a, input, select, textarea');
    if (e.detail > 0 && (suppressDragClick || selectClick)) {
      suppressDragClick = false;
      e.stopPropagation();
      e.preventDefault();
    }
  }, true);

  // Middle mouse button (wheel click) drag-to-pan anywhere; Left-click drag on empty space for marquee box selection
  viewport.addEventListener('mousedown', (e) => {
    if (e.button === 1) e.preventDefault(); // prevent browser autoscroll icon
  });
  viewport.addEventListener('pointerdown', (e) => {
    if (dragState || marqueeState || panState) return;
    if (e.button === 1) {
      e.preventDefault();
      panState = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, scrollL: viewport.scrollLeft, scrollT: viewport.scrollTop };
      viewport.setPointerCapture?.(e.pointerId);
      viewport.classList.add('is-panning');
      return;
    }
    if (e.button === 0 && (e.target === viewport || e.target === canvas || e.target === svg)) {
      const { x: wx, y: wy } = canvasPoint(e);
      if (!e.shiftKey && !e.ctrlKey && !e.metaKey) {
        selectedIds.clear();
        syncSelectionClasses();
      }
      marqueeState = { pointerId: e.pointerId, startX: wx, startY: wy, baseSelected: new Set(selectedIds) };
      viewport.setPointerCapture?.(e.pointerId);
      marqueeEl = document.createElement('div');
      marqueeEl.className = 'pj-flow-marquee';
      marqueeEl.style.left = `${wx}px`;
      marqueeEl.style.top = `${wy}px`;
      marqueeEl.style.width = '0px';
      marqueeEl.style.height = '0px';
      canvas.appendChild(marqueeEl);
    }
  });
  viewport.addEventListener('pointermove', (e) => {
    if (panState?.pointerId === e.pointerId) {
      viewport.scrollLeft = panState.scrollL - (e.clientX - panState.startX);
      viewport.scrollTop = panState.scrollT - (e.clientY - panState.startY);
      return;
    }
    if (marqueeState?.pointerId === e.pointerId && marqueeEl) {
      const { x: wx, y: wy } = canvasPoint(e);
      const x1 = Math.min(marqueeState.startX, wx);
      const y1 = Math.min(marqueeState.startY, wy);
      const x2 = Math.max(marqueeState.startX, wx);
      const y2 = Math.max(marqueeState.startY, wy);
      marqueeEl.style.left = `${x1}px`;
      marqueeEl.style.top = `${y1}px`;
      marqueeEl.style.width = `${x2 - x1}px`;
      marqueeEl.style.height = `${y2 - y1}px`;

      selectedIds.clear();
      for (const sid of marqueeState.baseSelected) selectedIds.add(sid);
      for (const [id, el] of cardEls.entries()) {
        const pt = pos[id] || { x: 28, y: 28 };
        const w = el.offsetWidth || 252;
        const h = el.offsetHeight || 144;
        if (pt.x <= x2 && pt.x + w >= x1 && pt.y <= y2 && pt.y + h >= y1) {
          selectedIds.add(id);
        }
      }
      syncSelectionClasses();
    }
  });
  const endViewportDrag = (e) => {
    if (panState?.pointerId === e.pointerId) { panState = null; viewport.classList.remove('is-panning'); }
    if (marqueeState?.pointerId === e.pointerId) {
      marqueeState = null;
      if (marqueeEl) { marqueeEl.remove(); marqueeEl = null; }
    }
  };
  viewport.addEventListener('pointerup', endViewportDrag);
  viewport.addEventListener('pointercancel', endViewportDrag);

  // Toolbar controls: Direction toggle, Auto-layout reset, Simplify toggle, Zoom & Wheel Zoom
  const applyZoom = (nextZoom, clientX = null, clientY = null) => {
    const prevZoom = zoom;
    zoom = Math.max(0.35, Math.min(2.0, Math.round(nextZoom * 20) / 20));
    if (clientX !== null && clientY !== null && prevZoom !== zoom) {
      const rect = viewport.getBoundingClientRect();
      const vx = clientX - rect.left;
      const vy = clientY - rect.top;
      const wx = (viewport.scrollLeft + vx) / prevZoom;
      const wy = (viewport.scrollTop + vy) / prevZoom;
      canvas.style.transform = zoom === 1 ? '' : `scale(${zoom})`;
      canvas.style.transformOrigin = '0 0';
      viewport.scrollLeft = Math.max(0, wx * zoom - vx);
      viewport.scrollTop = Math.max(0, wy * zoom - vy);
    } else {
      canvas.style.transform = zoom === 1 ? '' : `scale(${zoom})`;
      canvas.style.transformOrigin = '0 0';
    }
    const zBtn = $('#flowZoomReset');
    if (zBtn) zBtn.textContent = `${Math.round(zoom * 100)}%`;
  };
  viewport.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (dragState || marqueeState || panState) return;
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    applyZoom(zoom * factor, e.clientX, e.clientY);
  }, { passive: false });

  const dirBtn = $('#flowDirToggle');
  if (dirBtn) {
    dirBtn.onclick = () => {
      curDir = curDir === 'tb' ? 'lr' : 'tb';
      setFlowDir(curDir);
      viewport.classList.toggle('dir-tb', curDir === 'tb');
      viewport.classList.toggle('dir-lr', curDir !== 'tb');
      dirBtn.textContent = curDir === 'tb' ? '흐름: 상하 ↕' : '흐름: 좌우 ↔';
      loadPositionsForDir(curDir);
      applyPositions();
      drawEdges();
      fitToViewport();
    };
  }
  const autoBtn = $('#flowAutoLayout');
  if (autoBtn) {
    autoBtn.onclick = () => {
      saveFlowPositions(p.id, {}, curDir);
      for (const t of topTasks) {
        const au = autoCoords[t.id] || { x: 28, y: 28 };
        pos[t.id] = { x: au.x, y: au.y };
      }
      applyPositions();
      drawEdges();
      autoBtn.innerHTML = `${ico.refresh || ''} 자동 정렬`;
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
    const vh = viewport.clientHeight || 620;
    const cw = parseFloat(canvas.style.width) || 720;
    const ch = parseFloat(canvas.style.height) || 420;
    const scaleX = (vw - 24) / cw;
    const scaleY = (vh - 24) / ch;
    const fitScale = Math.min(scaleX, scaleY);
    if (fitScale < 1) applyZoom(Math.max(0.4, Math.min(1, fitScale)));
    else applyZoom(1);
  };
  if (zOut) zOut.onclick = () => applyZoom(zoom - 0.1);
  if (zIn) zIn.onclick = () => applyZoom(zoom + 0.1);
  if (zReset) zReset.onclick = () => applyZoom(1);
  if (zFit) zFit.onclick = fitToViewport;
  requestAnimationFrame(() => {
    drawEdges();
    if (innerWidth >= 1041) applyZoom(0.9);
    else fitToViewport();
  });
}
