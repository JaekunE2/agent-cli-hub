function projectFlow(p) {
  const ico = window.UI_ICO || {};
  const canConnect = p.tasks.some((t) => t.after.length);
  const missing = canConnect ? '' : '<div class="pj-empty" style="margin-bottom:12px"><p>카드 사이에 선행 작업이 아직 없습니다.</p><button id="flowGenerate">작업 흐름 생성</button></div>';
  if (!p.tasks.length) return missing;
  const levels = new Map(), columns = [];
  const byId = new Map(p.tasks.map((t) => [t.id, t]));
  function depth(id) {
    if (!levels.has(id)) levels.set(id, Math.max(0, ...byId.get(id).after.map((parent) => 1 + depth(parent))));
    return levels.get(id);
  }
  for (const t of p.tasks) (columns[depth(t.id)] ||= []).push(t);
  // Scannable flow node: Title + parent/sub badge + 2-line summary + CLI chip + Start button (stage shown by left accent stripe; click → Detail Drawer)
  const flowNode = (t) => {
    const parent = t.parentId ? p.tasks.find((x) => x.id === t.parentId) : null;
    const subs = p.tasks.filter((x) => x.parentId === t.id);
    const subDone = subs.filter((x) => x.stage === 'done').length;
    return `<article class="pj-task flow-node" data-task="${esc(t.id)}" data-stage="${esc(t.stage)}">
      ${parent ? `<span class="pj-parent-pill" title="상위 작업">↳ ${esc(parent.title)}</span>` : ''}
      <div class="pj-task-head">
        <button data-edit="${esc(t.id)}" class="pj-title">${esc(t.title)}</button>
        <button class="ghost icon-btn btn-sm" data-task-more="${esc(t.id)}" aria-label="${esc(t.title)} 메뉴" aria-haspopup="menu" aria-expanded="false">${ico.more || '⋯'}</button>
      </div>
      ${t.detail ? `<p class="pj-card-desc">${esc(t.detail)}</p>` : ''}
      ${subs.length ? `<div><span class="badge">서브 ${subDone}/${subs.length}</span></div>` : ''}
      <div class="pj-task-foot">${projectCliBadgeHTML(p, t)}${projectStartBtnHTML(p, t)}</div>
    </article>`;
  };
  return `${missing}<div class="pj-flow"><div class="pj-flow-canvas"><svg class="pj-edges" aria-hidden="true"></svg>${columns.map((tasks) => `<div class="pj-flow-column">${tasks.map(flowNode).join('')}</div>`).join('')}</div></div>`;
}

function bindProjectFlow(p, gen) {
  const generate = $('#flowGenerate');
  if (generate) generate.onclick = () => projectForm(p);
  const draw = () => {
    if (gen !== viewGen) return;
    const canvas = $('.pj-flow-canvas'), svg = canvas?.querySelector('svg');
    if (!svg) return;
    const origin = canvas.getBoundingClientRect();
    const nodes = new Map([...canvas.querySelectorAll('[data-task]')].map((el) => [el.dataset.task, el.getBoundingClientRect()]));
    svg.setAttribute('width', canvas.scrollWidth); svg.setAttribute('height', canvas.scrollHeight);
    const paths = [];
    for (const t of p.tasks) for (const id of t.after) {
      const a = nodes.get(id), b = nodes.get(t.id);
      if (!a || !b) continue;
      const x = a.right - origin.left, y = (a.top + a.bottom) / 2 - origin.top;
      const ex = b.left - origin.left, ey = (b.top + b.bottom) / 2 - origin.top, mid = (x + ex) / 2;
      paths.push(`<path d="M ${x} ${y} C ${mid} ${y}, ${mid} ${ey}, ${ex} ${ey}" marker-end="url(#pjArrow)"/>`);
    }
    svg.innerHTML = '<defs><marker id="pjArrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z"/></marker></defs>' + paths.join('');
  };
  requestAnimationFrame(draw);
  window.onresize = draw;
}
