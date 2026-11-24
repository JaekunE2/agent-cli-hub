function taskDescendants(tasks, rootId) {
  const out = new Set([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const t of tasks) {
      if (t.parentId && out.has(t.parentId) && !out.has(t.id)) { out.add(t.id); changed = true; }
    }
  }
  return out;
}

function removeTaskCascade(p, taskId) {
  const drop = taskDescendants(p.tasks, taskId);
  return p.tasks.filter((t) => !drop.has(t.id)).map((t) => ({
    ...t,
    after: t.after.filter((id) => !drop.has(id)),
  }));
}

function taskForm(p, task, focusAgent = false, defaultParentId = '') {
  const blockedParents = task ? taskDescendants(p.tasks, task.id) : new Set();
  const parentChoices = p.tasks.filter((t) => !t.parentId && !blockedParents.has(t.id));
  const curParentId = task ? (task.parentId || '') : (defaultParentId || '');
  const curKind = task ? (typeof taskKindOf === 'function' ? taskKindOf(task) : (task.kind || 'dev')) : 'dev';
  const kindsList = typeof projectTaskKinds !== 'undefined'
    ? projectTaskKinds
    : [['plan', '설계·기획'], ['dev', '개발·구현'], ['test', '테스트·검증'], ['ops', '배포·문서']];
  const kindField = `<label>작업 종류<select name="kind">${kindsList.map(([id, label]) => `<option value="${esc(id)}" ${curKind === id ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select></label>`;
  const parentField = `<label>상위 작업 (하위 서브태스크)<select name="parentId"><option value="">최상위 작업</option>${parentChoices.map((t) => `<option value="${esc(t.id)}" ${curParentId === t.id ? 'selected' : ''}>${esc(t.title)}</option>`).join('')}</select></label>`;
  const titleLabel = curParentId ? (task ? '하위 서브태스크 수정' : '새 하위 서브태스크') : (task ? '작업 수정' : '새 작업');

  const dialog = projectDialog(titleLabel,
    `<label>작업 제목<input name="title" maxlength="240" value="${esc(task?.title || '')}" required></label>
    <div class="pj-me-grid">${kindField}${parentField}</div>
    <label>작업 지시·완료 기준<textarea name="detail" rows="4" maxlength="6000">${esc(task?.detail || '')}</textarea></label>
    ${projectAgentField('작업 CLI', task?.agent || '', p.agent || '')}${projectAccountField}${projectModelEffortFields}
    <fieldset class="pj-choices"><legend>선행 작업</legend>${p.tasks.filter(t => t.id !== task?.id).map(t => `<label><input type="checkbox" name="after" value="${esc(t.id)}" ${task?.after.includes(t.id) ? 'checked' : ''}><span>${t.parentId ? '↳ ' : ''}${esc(t.title)}</span></label>`).join('') || '<p>선택할 다른 작업이 없습니다.</p>'}</fieldset>`,
    (f, button) => {
      if (button?.value === 'delete') {
        const subCnt = taskDescendants(p.tasks, task.id).size - 1;
        const msg = subCnt > 0
          ? `이 작업과 하위 서브 작업 ${subCnt}개를 함께 삭제할까요?`
          : '이 작업을 삭제하고 다른 카드에 연결된 선행 작업에서도 제거할까요?';
        if (!confirm(msg)) return false;
        return saveProject({ ...p, tasks: removeTaskCascade(p, task.id) });
      }
      const selected = f.get('account');
      const next = {
        id: task?.id || newTaskId(),
        stage: task?.stage || 'planned',
        kind: String(f.get('kind') || 'dev'),
        title: f.get('title'),
        detail: f.get('detail'),
        agent: f.get('agent'),
        account: selected === 'inherit' ? null : selected,
        model: String(f.get('model') || '').trim(),
        effort: String(f.get('effort') || ''),
        parentId: String(f.get('parentId') || ''),
        termId: '',
        after: f.getAll('after'),
      };
      return saveProject({ ...p, tasks: task ? p.tasks.map(t => t.id === task.id ? next : t) : [...p.tasks, next] });
    }, task ? '<button class="danger ghost" value="delete" formnovalidate>작업 삭제</button>' : '');
  bindProjectAccounts(dialog, task?.account ?? undefined, p, task?.model || '', task?.effort || '');
  if (focusAgent) dialog.querySelector('[name=agent]').focus();
}
