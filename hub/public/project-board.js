function openProjectTaskMenu(p, task, anchor, onMove) {
  if (!task) return;
  const ico = window.UI_ICO || {};
  const moveItems = projectStages
    .filter(([st]) => st !== task.stage)
    .map(([st, label]) => ({
      label: `${label}(으)로 이동`,
      onClick: () => {
        if (onMove) return onMove(task.id, st);
        saveProject({ ...p, tasks: p.tasks.map((t) => (t.id === task.id ? { ...t, stage: st } : t)) }).catch((e) => toast(e.message, 5000, 'danger'));
      },
    }));
  openMoreMenu(anchor, [
    ...moveItems,
    { divider: true },
    { label: '서브 개발 채팅 열기', icon: ico.chat || '', onClick: () => openProjectTaskDrawer(p, task, true) },
    !task.parentId ? { label: '하위 서브태스크 추가', icon: ico.plus || '', onClick: () => taskForm(p, null, false, task.id) } : null,
    { label: '담당 CLI·모델 변경', icon: ico.settings || '', onClick: () => taskForm(p, task, true) },
    { label: '작업 수정', icon: ico.edit || '', onClick: () => taskForm(p, task) },
    { divider: true },
    {
      label: '작업 삭제',
      icon: ico.trash || '',
      tone: 'danger',
      onClick: () => {
        const subCnt = typeof taskDescendants === 'function' ? taskDescendants(p.tasks, task.id).size - 1 : 0;
        const msg = subCnt > 0
          ? `이 작업과 하위 서브 작업 ${subCnt}개를 함께 삭제할까요?`
          : '이 작업을 삭제하고 다른 카드에 연결된 선행 작업에서도 제거할까요?';
        if (!confirm(msg)) return;
        const tasks = typeof removeTaskCascade === 'function'
          ? removeTaskCascade(p, task.id)
          : p.tasks.filter((t) => t.id !== task.id).map((t) => ({ ...t, after: t.after.filter((id) => id !== task.id) }));
        saveProject({ ...p, tasks }).catch((e) => toast(e.message, 5000, 'danger'));
      },
    },
  ]);
}

function projectBoard(p) {
  const ico = window.UI_ICO || {};
  const taskIds = new Set(p.tasks.map((t) => t.id));
  // Show ONLY top-level tasks on the Kanban board; subtasks are shown inside the parent task's Detail Drawer when clicked!
  const topTasks = p.tasks.filter((t) => !(t.parentId && taskIds.has(t.parentId)));
  const card = (t) => {
    const subs = p.tasks.filter((x) => x.parentId === t.id);
    const subDone = subs.filter((x) => x.stage === 'done').length;
    const k = typeof taskKindOf === 'function' ? taskKindOf(t) : 'dev';
    const chatCnt = (p.subChats?.[t.id] || []).length;
    const tokBadge = typeof taskTokenBadgeHTML === 'function' ? taskTokenBadgeHTML(p, t, true) : '';
    const menuAria = `${t.title} 메뉴`;
    return `<article class="pj-task" draggable="true" data-task="${esc(t.id)}" data-kind="${esc(k)}">
      <div class="row" style="justify-content:space-between;gap:6px">
        <div class="row" style="gap:5px;min-width:0">${typeof kindBadgeHTML === 'function' ? kindBadgeHTML(t) : ''}${subs.length ? `<span class="badge" title="클릭해 하위 서브태스크 확인">서브 ${subDone}/${subs.length}</span>` : ''}${tokBadge}</div>
        <button class="ghost icon-btn btn-sm" data-task-more="${esc(t.id)}" aria-label="${esc(menuAria)}" aria-haspopup="menu" aria-expanded="false">${ico.more || '⋯'}</button>
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
  const host = $('#projectContent');
  host.innerHTML = projectTab === 'flow'
    ? projectFlow(p)
    : `<div class="pj-board">${projectStages.map(([stage, label]) => {
      const items = topTasks.filter((t) => t.stage === stage);
      return `<section data-drop="${stage}"><h2 class="pj-lane-hd">${label} <span class="badge">${items.length}</span></h2>${items.map(card).join('') || '<div class="pj-lane-empty">비어 있음</div>'}</section>`;
    }).join('')}</div>`;
  if (projectTab === 'flow') bindProjectFlow(p, viewGen);
  let saving = false;
  const move = async (id, stage) => {
    const task = p.tasks.find((t) => t.id === id);
    if (!task || task.stage === stage || saving) return;
    saving = true;
    try { await saveProject({ ...p, tasks: p.tasks.map((t) => (t.id === id ? { ...t, stage } : t)) }); }
    catch (e) { toast(e.message, 5000, 'danger'); }
    finally { saving = false; }
  };
  host.onclick = (e) => {
    const scBtn = e.target.closest('[data-subchat-task]');
    if (scBtn) { e.stopPropagation(); return openProjectTaskDrawer(p, p.tasks.find((x) => x.id === scBtn.dataset.subchatTask), true); }
    const more = e.target.closest('[data-task-more]');
    if (more) { e.stopPropagation(); return openProjectTaskMenu(p, p.tasks.find((x) => x.id === more.dataset.taskMore), more, move); }
    const assign = e.target.closest('[data-assign-task]');
    if (assign) { e.stopPropagation(); return taskForm(p, p.tasks.find((x) => x.id === assign.dataset.assignTask), true); }
    const b = e.target.closest('[data-start-task]');
    if (b) { e.stopPropagation(); return startProjectTask(p, p.tasks.find((x) => x.id === b.dataset.startTask), b); }
    const cardEl = e.target.closest('[data-task]');
    if (cardEl) openProjectTaskDrawer(p, p.tasks.find((x) => x.id === cardEl.dataset.task));
  };
  const dragType = 'application/x-hub-task';
  host.ondragstart = (e) => { const t = e.target.closest('[data-task]'); if (t) e.dataTransfer.setData(dragType, t.dataset.task); };
  host.ondragover = (e) => { if (e.target.closest('[data-drop]') && e.dataTransfer.types.includes(dragType)) e.preventDefault(); };
  host.ondrop = (e) => { const col = e.target.closest('[data-drop]'); if (!col || !e.dataTransfer.types.includes(dragType)) return; e.preventDefault(); move(e.dataTransfer.getData(dragType), col.dataset.drop); };
}
