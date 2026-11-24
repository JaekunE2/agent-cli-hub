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

  const CARD_W = 244;
  const CARD_H = 128;
  const LAYER_GAP = dir === 'tb' ? 76 : 104;
  const ITEM_GAP = dir === 'tb' ? 24 : 24;
  const PAD_X = 32;
  const PAD_Y = 36;

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
        coords[t.id] = { x: startX + rIdx * (CARD_W + ITEM_GAP), y, col: cIdx, row: rIdx };
      });
    });
  } else {
    const totalH = maxRows * CARD_H + (maxRows - 1) * ITEM_GAP;
    columns.forEach((col, cIdx) => {
      if (!col || !col.length) return;
      const colH = col.length * CARD_H + (col.length - 1) * ITEM_GAP;
      const startY = PAD_Y + Math.max(0, Math.round((totalH - colH) / 2));
      const x = PAD_X + cIdx * (CARD_W + LAYER_GAP);
      col.forEach((t, rIdx) => {
        coords[t.id] = { x, y: startY + rIdx * (CARD_H + ITEM_GAP), col: cIdx, row: rIdx };
      });
    });
  }

  return { coords, columns };
}

// Re-pack auto-positioned nodes using actual DOM card sizes and parent/child center attraction
// so straight chains align on a single axis (0 bends) and no vertical space is wasted.
function refineAutoFlowCoords(tasks, columns, cardEls, dir = 'lr') {
  const { parentsOf, rawAdj } = computeFlowEdges(tasks, false);
  const LAYER_GAP = dir === 'tb' ? 76 : 104;
  const ITEM_GAP = 24;
  const PAD_X = 32;
  const PAD_Y = 36;
  const sizeOf = (id) => {
    const el = cardEls.get(id);
    return {
      w: el?.offsetWidth || 244,
      h: el?.offsetHeight || 128,
    };
  };

  const out = {};
  if (dir === 'tb') {
    let curY = PAD_Y;
    const rowTops = [];
    columns.forEach((col, cIdx) => {
      if (!col?.length) return;
      rowTops[cIdx] = curY;
      const maxH = Math.max(...col.map((t) => sizeOf(t.id).h));
      let curX = PAD_X;
      col.forEach((t) => {
        const { w } = sizeOf(t.id);
        out[t.id] = { x: curX, y: curY };
        curX += w + ITEM_GAP;
      });
      curY += maxH + LAYER_GAP;
    });
    const packRow = (col, targetXOf) => {
      const sorted = [...col].sort((a, b) => targetXOf(a) - targetXOf(b));
      let cursor = PAD_X;
      const items = sorted.map((t) => {
        const w = sizeOf(t.id).w;
        const desired = Math.max(cursor, Math.round(targetXOf(t) - w / 2));
        cursor = desired + w + ITEM_GAP;
        return { id: t.id, x: desired, w };
      });
      const minX = Math.min(...items.map((it) => it.x));
      if (minX < PAD_X) {
        const shift = PAD_X - minX;
        items.forEach((it) => (it.x += shift));
      }
      items.forEach((it) => { out[it.id].x = it.x; });
    };
    for (let pass = 0; pass < 3; pass++) {
      for (let c = 1; c < columns.length; c++) {
        if (!columns[c]?.length) continue;
        packRow(columns[c], (t) => {
          const ps = [...(parentsOf.get(t.id) || [])].filter((id) => out[id]);
          if (!ps.length) return out[t.id].x + sizeOf(t.id).w / 2;
          return ps.reduce((s, id) => s + out[id].x + sizeOf(id).w / 2, 0) / ps.length;
        });
      }
      for (let c = columns.length - 2; c >= 0; c--) {
        if (!columns[c]?.length) continue;
        packRow(columns[c], (t) => {
          const cs = [...(rawAdj.get(t.id) || [])].filter((id) => out[id]);
          if (!cs.length) return out[t.id].x + sizeOf(t.id).w / 2;
          return cs.reduce((s, id) => s + out[id].x + sizeOf(id).w / 2, 0) / cs.length;
        });
      }
    }
    const minAllX = Math.min(...Object.values(out).map((p) => p.x));
    if (minAllX > PAD_X) {
      const shift = minAllX - PAD_X;
      Object.values(out).forEach((p) => { p.x -= shift; });
    }
    return out;
  }

  // Left-to-Right (LR) mode: compact columns by actual width, align Y toward parent/child centers
  let curX = PAD_X;
  columns.forEach((col) => {
    if (!col?.length) return;
    const maxW = Math.max(...col.map((t) => sizeOf(t.id).w));
    let curY = PAD_Y;
    col.forEach((t) => {
      const { h } = sizeOf(t.id);
      out[t.id] = { x: curX, y: curY };
      curY += h + ITEM_GAP;
    });
    curX += maxW + LAYER_GAP;
  });

  const packCol = (col, targetYOf) => {
    const sorted = [...col].sort((a, b) => targetYOf(a) - targetYOf(b));
    let cursor = PAD_Y;
    const items = sorted.map((t) => {
      const h = sizeOf(t.id).h;
      const desired = Math.max(cursor, Math.round(targetYOf(t) - h / 2));
      cursor = desired + h + ITEM_GAP;
      return { id: t.id, y: desired, h };
    });
    items.forEach((it) => { out[it.id].y = it.y; });
  };

  for (let pass = 0; pass < 3; pass++) {
    for (let c = 1; c < columns.length; c++) {
      if (!columns[c]?.length) continue;
      packCol(columns[c], (t) => {
        const ps = [...(parentsOf.get(t.id) || [])].filter((id) => out[id]);
        if (!ps.length) return out[t.id].y + sizeOf(t.id).h / 2;
        return ps.reduce((s, id) => s + out[id].y + sizeOf(id).h / 2, 0) / ps.length;
      });
    }
    for (let c = columns.length - 2; c >= 0; c--) {
      if (!columns[c]?.length) continue;
      packCol(columns[c], (t) => {
        const cs = [...(rawAdj.get(t.id) || [])].filter((id) => out[id]);
        if (!cs.length) return out[t.id].y + sizeOf(t.id).h / 2;
        return cs.reduce((s, id) => s + out[id].y + sizeOf(id).h / 2, 0) / cs.length;
      });
    }
  }
  const minAllY = Math.min(...Object.values(out).map((p) => p.y));
  if (minAllY > PAD_Y) {
    const shift = minAllY - PAD_Y;
    Object.values(out).forEach((p) => { p.y -= shift; });
  }
  return out;
}

function flowTopTasks(p) {
  const allIds = new Set((p.tasks || []).map((t) => t.id));
  return (p.tasks || []).filter((t) => !(t.parentId && allIds.has(t.parentId)));
}

function projectFlowKey(p) {
  return p.scope?.number ? `${p.id}:${p.scope.number}` : p.id;
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
  const savedPos = loadFlowPositions(projectFlowKey(p), dir);
  const hasCustomPos = Object.keys(savedPos).some((id) => topTasks.some((t) => t.id === id));

  const flowNode = (t) => {
    const subs = p.tasks.filter((x) => x.parentId === t.id);
    const subDone = subs.filter((x) => x.stage === 'done').length;
    const k = typeof taskKindOf === 'function' ? taskKindOf(t) : 'dev';
    const menuAria = `${t.title} 메뉴`;
    const collapsed = typeof isTaskCollapsed === 'function' && isTaskCollapsed(p.id, t.id);
    const liveBadge = t.stage === 'done'
      ? ''
      : (typeof projectLiveStatusBadgeHTML === 'function' ? projectLiveStatusBadgeHTML(p, t) : '');
    return `<article class="pj-task flow-node${collapsed ? ' is-collapsed' : ''}" data-task="${esc(t.id)}" data-stage="${esc(t.stage)}" data-kind="${esc(k)}">
      <span class="pj-port in" aria-hidden="true"></span>
      <span class="pj-port out" aria-hidden="true"></span>
      <div class="row" style="justify-content:space-between;gap:6px">
        <div class="row" style="gap:4px;min-width:0;flex-wrap:wrap">${typeof collapseBtnHTML === 'function' ? collapseBtnHTML(collapsed, t.id) : ''}${kindBadgeHTML(t)}${stageBadgeHTML(t.stage)}${liveBadge}${typeof projectReviewBadgeHTML === 'function' ? projectReviewBadgeHTML(t) : ''}${subs.length ? `<span class="badge">하위 ${subDone}/${subs.length}</span>` : ''}</div>
        <button class="ghost icon-btn btn-sm" data-task-more="${esc(t.id)}" aria-label="${esc(menuAria)}" aria-haspopup="menu" aria-expanded="false">${ico.more || '⋯'}</button>
      </div>
      <div class="pj-task-head">
        <button data-edit="${esc(t.id)}" class="pj-title">${esc(t.title)}</button>
      </div>
      ${typeof projectReviewNoteHTML === 'function' ? projectReviewNoteHTML(t, true) : ''}
      ${t.lastRun || t.launchBlock ? `<div class="row">${projectLastRunHTML(t)}</div>` : ''}
      ${projectStageActionHTML(t, p)}
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
    <div class="row" style="gap:10px;flex-wrap:wrap">
      <div class="pj-flow-legend" aria-hidden="true">
        <span><i></i>선행 의존</span>
        <span><i class="focal"></i>활성·포커스</span>
        <span><i class="sub"></i>하위 분기</span>
      </div>
      <div class="row" style="gap:4px">
        <button type="button" class="ghost btn-sm" id="flowZoomFit" title="전체 노드가 한눈에 보이도록 화면 맞춤">화면 맞춤</button>
        <button type="button" class="ghost btn-sm" id="flowZoomOut" title="축소">－</button>
        <button type="button" class="ghost btn-sm mono" id="flowZoomReset" title="100% 기본 배율">100%</button>
        <button type="button" class="ghost btn-sm" id="flowZoomIn" title="확대">＋</button>
      </div>
    </div>
  </div>`;

  return `${missing}${controls}<div class="pj-flow dir-${dir}" id="pjFlowViewport"><div class="pj-flow-canvas" id="pjFlowCanvas"><svg class="pj-edges" aria-hidden="true"></svg>${topTasks.map(flowNode).join('')}</div></div>`;
}

function bindProjectFlow(p, gen) {
  const ico = window.UI_ICO || {};
  const generate = $('#flowGenerate');
  if (generate) generate.onclick = () => p.scope?.version ? projectFollowupForm(p, false, p.scope.number) : projectForm(p);
  const viewport = $('#pjFlowViewport');
  const canvas = $('#pjFlowCanvas');
  const svg = canvas?.querySelector('svg');
  if (!viewport || !canvas || !svg) return;

  const topTasks = flowTopTasks(p);
  let curDir = flowDir();
  let autoLayout = computeAutoFlowLayout(topTasks, curDir);
  let autoCoords = autoLayout.coords;
  const pos = {};
  const cardEls = new Map([...canvas.querySelectorAll('[data-task]')].map((el) => [el.dataset.task, el]));

  const applyPositions = () => {
    for (const [id, el] of cardEls.entries()) {
      const pt = pos[id] || { x: 32, y: 36 };
      el.style.left = `${pt.x}px`;
      el.style.top = `${pt.y}px`;
    }
  };

  const loadPositionsForDir = (dir) => {
    autoLayout = computeAutoFlowLayout(topTasks, dir);
    autoCoords = refineAutoFlowCoords(topTasks, autoLayout.columns, cardEls, dir);
    const svMap = loadFlowPositions(projectFlowKey(p), dir);
    for (const t of topTasks) {
      const sv = svMap[t.id];
      const au = autoCoords[t.id] || { x: 32, y: 36 };
      pos[t.id] = (sv && Number.isFinite(sv.x) && Number.isFinite(sv.y))
        ? { x: Math.max(8, sv.x), y: Math.max(8, sv.y) }
        : { x: au.x, y: au.y };
    }
    const hasCustom = Object.keys(svMap).some((id) => topTasks.some((t) => t.id === id));
    const autoBtn = $('#flowAutoLayout');
    if (autoBtn) autoBtn.innerHTML = `${ico.refresh || ''} 자동 정렬${hasCustom ? ' (초기화)' : ''}`;
  };
  loadPositionsForDir(curDir);

  let zoom = 1;
  let hoverTaskId = null;

  const settlePositions = () => {
    const placed = [];
    const vertical = curDir === 'tb';
    const axis = vertical ? 'x' : 'y';
    const end = vertical ? 'right' : 'bottom';
    const gap = 18;
    const ordered = [...cardEls].sort(([a], [b]) => pos[a][axis] - pos[b][axis]);
    for (const [id, el] of ordered) {
      const pt = pos[id], width = el.offsetWidth, height = el.offsetHeight;
      let hit;
      do {
        hit = placed.find(box => pt.x < box.right + gap && pt.x + width + gap > box.x
          && pt.y < box.bottom + gap && pt.y + height + gap > box.y);
        if (hit) pt[axis] = hit[end] + gap;
      } while (hit);
      placed.push({ ...pt, right: pt.x + width, bottom: pt.y + height });
    }
    applyPositions();
  };

  // Build orthogonal rounded-elbow SVG path (`r = 8`) with semicircular bridge hops at vertical crossings
  const orthoRoundedPath = (pts, rMax = 8, priorVerticals = []) => {
    const clean = [];
    for (const p of pts) {
      const prev = clean[clean.length - 1];
      if (!prev || Math.hypot(p.x - prev.x, p.y - prev.y) > 0.5) clean.push({ x: Math.round(p.x * 2) / 2, y: Math.round(p.y * 2) / 2 });
    }
    if (clean.length < 2) return '';
    // Collapse collinear middle points
    const simp = [clean[0]];
    for (let i = 1; i < clean.length - 1; i++) {
      const a = simp[simp.length - 1], b = clean[i], c = clean[i + 1];
      const sameX = Math.abs(a.x - b.x) < 0.5 && Math.abs(b.x - c.x) < 0.5;
      const sameY = Math.abs(a.y - b.y) < 0.5 && Math.abs(b.y - c.y) < 0.5;
      if (!sameX && !sameY) simp.push(b);
    }
    simp.push(clean[clean.length - 1]);

    const segHops = (x1, x2, y) => {
      if (Math.abs(x2 - x1) < 24 || !priorVerticals.length) return `L ${x2} ${y}`;
      const dir = x2 > x1 ? 1 : -1;
      const minX = Math.min(x1, x2) + 12;
      const maxX = Math.max(x1, x2) - 12;
      const hits = priorVerticals
        .filter((v) => v.x >= minX && v.x <= maxX && y > v.y1 + 10 && y < v.y2 - 10)
        .map((v) => v.x)
        .sort((a, b) => (dir > 0 ? a - b : b - a));
      if (!hits.length) return `L ${x2} ${y}`;
      const uniq = [];
      for (const hx of hits) {
        if (!uniq.length || Math.abs(hx - uniq[uniq.length - 1]) >= 14) uniq.push(hx);
      }
      let cmd = '';
      for (const hx of uniq) {
        const bx = hx - dir * 6;
        const sweep = dir > 0 ? 1 : 0;
        cmd += ` L ${bx} ${y} a 6,6 0 0,${sweep} ${dir * 12},0`;
      }
      cmd += ` L ${x2} ${y}`;
      return cmd;
    };

    let d = `M ${simp[0].x} ${simp[0].y}`;
    let cur = simp[0];
    for (let i = 1; i < simp.length; i++) {
      const p = simp[i];
      if (i < simp.length - 1) {
        const nxt = simp[i + 1];
        const dx1 = p.x - cur.x, dy1 = p.y - cur.y;
        const dx2 = nxt.x - p.x, dy2 = nxt.y - p.y;
        const len1 = Math.hypot(dx1, dy1), len2 = Math.hypot(dx2, dy2);
        const r = Math.min(rMax, len1 * 0.45, len2 * 0.45);
        if (r >= 2) {
          const pre = { x: Math.round((p.x - (dx1 / len1) * r) * 2) / 2, y: Math.round((p.y - (dy1 / len1) * r) * 2) / 2 };
          const post = { x: Math.round((p.x + (dx2 / len2) * r) * 2) / 2, y: Math.round((p.y + (dy2 / len2) * r) * 2) / 2 };
          d += Math.abs(pre.y - cur.y) < 0.5 ? ` ${segHops(cur.x, pre.x, pre.y)}` : ` L ${pre.x} ${pre.y}`;
          d += ` Q ${p.x} ${p.y}, ${post.x} ${post.y}`;
          cur = post;
          continue;
        }
      }
      d += Math.abs(p.y - cur.y) < 0.5 ? ` ${segHops(cur.x, p.x, p.y)}` : ` L ${p.x} ${p.y}`;
      cur = p;
    }
    // Record vertical segments for subsequent bridge hops
    for (let i = 0; i < simp.length - 1; i++) {
      const a = simp[i], b = simp[i + 1];
      if (Math.abs(a.x - b.x) < 0.5 && Math.abs(b.y - a.y) > 16) {
        priorVerticals.push({ x: a.x, y1: Math.min(a.y, b.y), y2: Math.max(a.y, b.y) });
      }
    }
    return d;
  };

  // Diagram-Design Orthogonal Edge Router with Fanned Ports (>=12px separation) & Obstacle Detours
  const drawEdges = () => {
    if (gen !== viewGen || !canvas.isConnected) return;
    const simplify = isFlowSimplified();
    const { edges } = computeFlowEdges(topTasks, simplify);

    const boxes = new Map();
    let maxRight = 720, maxBottom = 420;
    for (const [id, el] of cardEls.entries()) {
      const pt = pos[id] || { x: 28, y: 28 };
      const w = el.offsetWidth || 256;
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

    // Fan outgoing & incoming attach ports (>=12px apart, sorted by peer coordinate)
    const outGroups = new Map(), inGroups = new Map();
    edges.forEach((e, idx) => {
      if (!boxes.has(e.from) || !boxes.has(e.to)) return;
      (outGroups.get(e.from) || outGroups.set(e.from, []).get(e.from)).push(idx);
      (inGroups.get(e.to) || inGroups.set(e.to, []).get(e.to)).push(idx);
    });
    const outPort = new Map(), inPort = new Map();
    const fanOffset = (i, n, span) => {
      if (n <= 1) return 0;
      const step = Math.min(18, Math.max(12, Math.floor((span - 32) / Math.max(1, n - 1))));
      return Math.round((i - (n - 1) / 2) * step);
    };
    for (const [nid, idxs] of outGroups.entries()) {
      const box = boxes.get(nid);
      idxs.sort((i, j) => (curDir === 'tb' ? boxes.get(edges[i].to).cx - boxes.get(edges[j].to).cx : boxes.get(edges[i].to).cy - boxes.get(edges[j].to).cy));
      idxs.forEach((ei, rank) => outPort.set(ei, fanOffset(rank, idxs.length, curDir === 'tb' ? box.w : box.h)));
    }
    for (const [nid, idxs] of inGroups.entries()) {
      const box = boxes.get(nid);
      idxs.sort((i, j) => (curDir === 'tb' ? boxes.get(edges[i].from).cx - boxes.get(edges[j].from).cx : boxes.get(edges[i].from).cy - boxes.get(edges[j].from).cy));
      idxs.forEach((ei, rank) => inPort.set(ei, fanOffset(rank, idxs.length, curDir === 'tb' ? box.w : box.h)));
    }

    // Pre-assign symmetric corridor lane offsets for edges sharing the same gutter,
    // and compute collision-free horizontal/vertical detours for multi-layer skip edges.
    const gutterGroups = new Map();
    edges.forEach((e, ei) => {
      const a = boxes.get(e.from), b = boxes.get(e.to);
      if (!a || !b) return;
      const key = curDir === 'tb'
        ? `tb:${Math.round(a.bottom / 24)}:${Math.round(b.top / 24)}`
        : `lr:${Math.round(a.right / 24)}:${Math.round(b.left / 24)}`;
      (gutterGroups.get(key) || gutterGroups.set(key, []).get(key)).push(ei);
    });
    const laneOffset = new Map();
    for (const idxs of gutterGroups.values()) {
      idxs.sort((i, j) => {
        const ai = boxes.get(edges[i].from), bi = boxes.get(edges[i].to);
        const aj = boxes.get(edges[j].from), bj = boxes.get(edges[j].to);
        const di = curDir === 'tb' ? (bi.cx - ai.cx) : (bi.cy - ai.cy);
        const dj = curDir === 'tb' ? (bj.cx - aj.cx) : (bj.cy - aj.cy);
        return di - dj;
      });
      const n = idxs.length;
      idxs.forEach((ei, rank) => {
        laneOffset.set(ei, n <= 1 ? 0 : Math.round((rank - (n - 1) / 2) * 10));
      });
    }

    const priorVerticals = [];
    let skipLaneIdx = 0;
    let minBoxTop = Infinity, maxBoxBottom = 0, minBoxLeft = Infinity, maxBoxRight = 0;
    for (const ob of boxes.values()) {
      if (ob.top < minBoxTop) minBoxTop = ob.top;
      if (ob.bottom > maxBoxBottom) maxBoxBottom = ob.bottom;
      if (ob.left < minBoxLeft) minBoxLeft = ob.left;
      if (ob.right > maxBoxRight) maxBoxRight = ob.right;
    }

    const paths = edges.map((e, ei) => {
      const a = boxes.get(e.from), b = boxes.get(e.to);
      if (!a || !b) return '';
      const isHi = hoverTaskId && (e.from === hoverTaskId || e.to === hoverTaskId);
      const isDim = hoverTaskId && !isHi;
      const cls = `pj-edge-path${isHi ? ' hi' : ''}${isDim ? ' dim' : ''}${e.isSub ? ' sub' : ''}`;
      const marker = isHi ? 'url(#pjArrowHi)' : 'url(#pjArrow)';
      const oOff = outPort.get(ei) || 0;
      const iOff = inPort.get(ei) || 0;
      const lOff = laneOffset.get(ei) || 0;

      let pts;
      if (curDir === 'tb') {
        const x1 = a.cx + oOff, y1 = a.bottom;
        const x2 = b.cx + iOff, y2 = b.top;
        if (y2 >= y1 + 16) {
          const midY = Math.round((y1 + y2) / 2) + lOff;
          let detourX = null;
          const midObstacles = [];
          for (const [oid, ob] of boxes.entries()) {
            if (oid === e.from || oid === e.to) continue;
            if (ob.bottom <= y1 + 10 || ob.top >= y2 - 10) continue;
            if (Math.min(x1, x2) <= ob.right + 16 && Math.max(x1, x2) >= ob.left - 16) {
              midObstacles.push(ob);
            }
          }
          if (midObstacles.length) {
            const leftClear = Math.max(12, Math.min(...midObstacles.map((o) => o.left)) - 22 - (skipLaneIdx % 3) * 10);
            const rightClear = Math.max(...midObstacles.map((o) => o.right)) + 22 + (skipLaneIdx % 3) * 10;
            const avgX = (x1 + x2) / 2;
            detourX = Math.abs(avgX - leftClear) <= Math.abs(avgX - rightClear) ? leftClear : rightClear;
            skipLaneIdx++;
          }
          pts = detourX !== null
            ? [{ x: x1, y: y1 }, { x: x1, y: y1 + 20 }, { x: detourX, y: y1 + 20 }, { x: detourX, y: y2 - 20 }, { x: x2, y: y2 - 20 }, { x: x2, y: y2 }]
            : (Math.abs(x1 - x2) < 2 ? [{ x: x1, y: y1 }, { x: x2, y: y2 }] : [{ x: x1, y: y1 }, { x: x1, y: midY }, { x: x2, y: midY }, { x: x2, y: y2 }]);
        } else {
          const sideX = x2 >= x1 ? maxBoxRight + 28 + (skipLaneIdx % 3) * 10 : Math.max(12, minBoxLeft - 28 - (skipLaneIdx % 3) * 10);
          skipLaneIdx++;
          pts = [{ x: x1, y: y1 }, { x: x1, y: y1 + 20 }, { x: sideX, y: y1 + 20 }, { x: sideX, y: y2 - 20 }, { x: x2, y: y2 - 20 }, { x: x2, y: y2 }];
        }
      } else {
        const x1 = a.right, y1 = a.cy + oOff;
        const x2 = b.left, y2 = b.cy + iOff;
        if (x2 >= x1 + 16) {
          const midX = Math.round((x1 + x2) / 2) + lOff;
          let detourY = null;
          const midObstacles = [];
          for (const [oid, ob] of boxes.entries()) {
            if (oid === e.from || oid === e.to) continue;
            if (ob.right <= x1 + 10 || ob.left >= x2 - 10) continue;
            if (Math.min(y1, y2) <= ob.bottom + 16 && Math.max(y1, y2) >= ob.top - 16) {
              midObstacles.push(ob);
            }
          }
          if (midObstacles.length) {
            const topClear = Math.max(12, Math.min(...midObstacles.map((o) => o.top)) - 22 - (skipLaneIdx % 3) * 10);
            const botClear = Math.max(...midObstacles.map((o) => o.bottom)) + 22 + (skipLaneIdx % 3) * 10;
            const avgY = (y1 + y2) / 2;
            detourY = Math.abs(avgY - topClear) <= Math.abs(avgY - botClear) ? topClear : botClear;
            skipLaneIdx++;
          }
          pts = detourY !== null
            ? [{ x: x1, y: y1 }, { x: x1 + 26, y: y1 }, { x: x1 + 26, y: detourY }, { x: x2 - 26, y: detourY }, { x: x2 - 26, y: y2 }, { x: x2, y: y2 }]
            : (Math.abs(y1 - y2) < 2 ? [{ x: x1, y: y1 }, { x: x2, y: y2 }] : [{ x: x1, y: y1 }, { x: midX, y: y1 }, { x: midX, y: y2 }, { x: x2, y: y2 }]);
        } else {
          const loopY = y2 >= y1 ? maxBoxBottom + 28 + (skipLaneIdx % 3) * 10 : Math.max(12, minBoxTop - 28 - (skipLaneIdx % 3) * 10);
          skipLaneIdx++;
          pts = [{ x: x1, y: y1 }, { x: x1 + 26, y: y1 }, { x: x1 + 26, y: loopY }, { x: x2 - 26, y: loopY }, { x: x2 - 26, y: y2 }, { x: x2, y: y2 }];
        }
      }
      const d = orthoRoundedPath(pts, 8, priorVerticals);
      return d ? `<path class="${cls}" d="${d}" marker-end="${marker}"/>` : '';
    }).filter(Boolean);

    svg.innerHTML = `<defs>
      <marker id="pjArrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M 0 1.2 L 9 5 L 0 8.8 z"/></marker>
      <marker id="pjArrowHi" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path class="hi" d="M 0 1.2 L 9 5 L 0 8.8 z"/></marker>
    </defs>${paths.join('')}`;
  };

  settlePositions();
  requestAnimationFrame(drawEdges);
  window.onresize = () => { settlePositions(); drawEdges(); };

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
      settlePositions();
      drawEdges();
      saveFlowPositions(projectFlowKey(p), pos, curDir);
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
      settlePositions();
      drawEdges();
      fitToViewport();
    };
  }
  const autoBtn = $('#flowAutoLayout');
  if (autoBtn) {
    autoBtn.onclick = () => {
      saveFlowPositions(projectFlowKey(p), {}, curDir);
      for (const t of topTasks) {
        const au = autoCoords[t.id] || { x: 28, y: 28 };
        pos[t.id] = { x: au.x, y: au.y };
      }
      settlePositions();
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
    fitToViewport();
  });
}
