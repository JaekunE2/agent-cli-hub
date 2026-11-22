function projectAgentField(label, selected, inherited) {
  const choices = ['claude', 'codex', 'agy', 'cursor'].map(id => [id, providerName(id)]);
  if (inherited) choices.unshift(['', `Project 기본 · ${providerName(inherited)}`]);
  return `<label>${label}<select name="agent">${choices.map(([id, name]) => `<option value="${id}" ${selected === id ? 'selected' : ''}>${esc(name)}</option>`).join('')}</select></label>`;
}

function effectiveTaskConfig(p, task) {
  const parent = task?.parentId ? (p.tasks || []).find((x) => x.id === task.parentId) : null;
  const agent = task?.agent || parent?.agent || p.agent || 'codex';
  const sameAsParent = parent && (!task?.agent || task.agent === (parent.agent || p.agent || 'codex'));
  const sameAsProject = !task?.agent || task.agent === (p.agent || 'codex');
  const account = task?.account ?? (sameAsParent ? parent.account : null) ?? (sameAsProject ? p.account : '');
  const model = task?.model || (sameAsParent ? parent.model : '') || (sameAsProject ? p.model : '') || '';
  const effort = task?.effort || (sameAsParent ? parent.effort : '') || (sameAsProject ? p.effort : '') || '';
  return { agent, account: account || '', model, effort, parent };
}

function projectTaskTerm(p, task) {
  const { agent, account } = effectiveTaskConfig(p, task);
  return state.terms.find(t => t.exited === null && t.projectTask?.projectId === p.id
    && t.projectTask.taskId === task.id && t.agent === agent && (t.account?.id || '') === (account || ''));
}

function projectCliBadgeHTML(p, task) {
  const term = projectTaskTerm(p, task);
  const cfg = effectiveTaskConfig(p, task);
  const ag = term?.agent || cfg.agent;
  const name = providerName(ag);
  const meTag = [cfg.model, cfg.effort].filter(Boolean).join('/');
  const label = [name, cfg.model || term?.account?.label].filter(Boolean).join(' · ');
  const tip = [name, term?.account?.label, meTag ? `설정: ${meTag}` : '', '클릭하여 CLI·모델·추론 성능 변경'].filter(Boolean).join(' · ');
  const ico = typeof agentIcon === 'function' ? agentIcon(ag) : '';
  return `<button class="pj-cli-btn" data-assign-task="${esc(task.id)}" title="${esc(tip)}">${ico}<span>${esc(label)}${cfg.effort ? ` <em class="pj-eff-tag">${esc(cfg.effort)}</em>` : ''}</span></button>`;
}

function projectStartBtnHTML(p, task) {
  const term = projectTaskTerm(p, task);
  if (!term && task.stage === 'done') return '<span class="badge st-done">✓ 완료됨</span>';
  return `<button class="btn-sm${term ? ' primary' : ''}" data-start-task="${esc(task.id)}">${term ? '터미널 열기 ↗' : '작업 시작'}</button>`;
}

async function startProjectTask(p, task, button) {
  const gen = viewGen;
  if (button) button.disabled = true;
  try {
    const current = projectTaskTerm(p, task);
    const t = current || await api('/api/projects/start', { method: 'POST', body: { projectId: p.id, taskId: task.id } });
    if (t.error || !t.id) throw new Error(t.error || '터미널을 열 수 없습니다.');
    // Auto-advance task stage from 'planned' → 'doing' when starting work
    if (!current && task.stage === 'planned') {
      const nextTasks = p.tasks.map((x) => (x.id === task.id ? { ...x, stage: 'doing' } : x));
      api('/api/projects', { method: 'POST', body: { ...p, tasks: nextTasks } })
        .then(() => { if (typeof refreshProjects === 'function') refreshProjects(); })
        .catch(() => {});
    }
    if (!current) await refreshOverview();
    if (gen !== viewGen) return;
    select({ kind: 'term', id: t.id, project: p.id });
    if (!current && !t.existing) {
      const input = $('#tin');
      if (input) {
        const parent = task.parentId ? (p.tasks || []).find((x) => x.id === task.parentId) : null;
        const promptParts = parent
          ? [`[상위 작업: ${parent.title}]`, parent.detail ? parent.detail.slice(0, 600) : '', `[서브 개발 작업: ${task.title}]`, task.detail]
          : [task.title, task.detail];
        input.value = promptParts.filter(Boolean).join('\n\n');
        input.dispatchEvent(new Event('input'));
      }
    }
  } catch (e) { toast(e.message, 5000, 'danger'); }
  finally { if (button) button.disabled = false; }
}

function projectTerminals(p, gen) {
  const terms = state.terms.filter(t => t.exited === null && t.projectTask?.projectId === p.id);
  const host = $('#projectContent');
  const stageMap = new Map(projectStages);
  host.innerHTML = terms.length
    ? `<div class="grid" style="padding:0">${terms.map((t) => {
      const task = p.tasks.find((x) => x.id === t.projectTask?.taskId);
      const badge = task ? `<span class="badge">${esc(stageMap.get(task.stage) || task.stage)}</span>` : '';
      return termCardHTML(t, badge);
    }).join('')}</div>`
    : `<div class="pj-empty"><p>작업 설계 또는 칸반에서 작업을 시작하면 전용 터미널이 여기에 표시됩니다.</p><div class="row"><button id="projectGoBoard2" class="primary">칸반 보드 열기</button><button id="projectPlan">작업 설계 열기</button></div></div>`;
  if (!terms.length) {
    $('#projectGoBoard2').onclick = () => openProject(p.id, 'board');
    $('#projectPlan').onclick = () => openProject(p.id, 'design');
  }
  for (const card of host.querySelectorAll('[data-term]')) {
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.onclick = () => select({ kind: 'term', id: card.dataset.term, project: p.id });
    card.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); card.click(); } };
  }
  bindMiniTerminals(gen, terms, []);
}
