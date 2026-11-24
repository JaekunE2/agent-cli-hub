function projectAgentField(label, selected, inherited) {
  const choices = ['claude', 'codex', 'agy', 'cursor'].map(id => [id, providerName(id)]);
  if (inherited !== undefined) choices.unshift(['', inherited ? `Project 기본 · ${providerName(inherited)}` : '자동 배정']);
  return `<label>${label}<select name="agent">${choices.map(([id, name]) => `<option value="${id}" ${selected === id ? 'selected' : ''}>${esc(name)}</option>`).join('')}</select></label>`;
}

function effectiveTaskConfig(p, task) {
  const parent = task?.parentId ? (p.tasks || []).find((x) => x.id === task.parentId) : null;
  const roleId = String(task?.role || task?.kind || (typeof taskKindOf === 'function' ? taskKindOf(task) : 'dev') || 'dev').toLowerCase();
  const rolePreset = state.projectHarness?.roles?.[roleId] || null;
  const projAgent = p?.agent || 'codex';
  const agent = task?.agent || p?.agent || parent?.agent || rolePreset?.agent || projAgent;
  const sameAsParent = parent && (task?.agent || !p?.agent) && agent === (parent.agent || projAgent);
  const sameAsRole = !task?.agent && !p?.agent && !parent?.agent && rolePreset?.agent;
  const sameAsProject = agent === projAgent;
  const account = task?.account ?? (sameAsParent ? parent.account : null) ?? (sameAsRole && rolePreset?.account ? rolePreset.account : null) ?? (sameAsProject ? p.account : '');
  const model = task?.model || (sameAsParent ? parent.model : '') || (sameAsRole ? rolePreset?.model : '') || (sameAsProject ? p.model : '') || '';
  const effort = task?.effort || (sameAsParent ? parent.effort : '') || (sameAsRole ? rolePreset?.effort : '') || (sameAsProject ? p.effort : '') || '';
  return { agent, account: account || '', model, effort, parent, roleId, rolePreset };
}

function projectTaskTerm(p, task) {
  const { agent } = effectiveTaskConfig(p, task);
  const workspace = p.scope?.version?.workspace;
  const sameTask = (state.terms || []).filter((t) => t.exited === null && t.projectTask?.projectId === p.id && t.projectTask.taskId === task.id
    && (!workspace || sameProjectFolder(t.cwd, workspace)));
  const fallback = task.lastRun?.mcpFallback?.from === agent && task.lastRun.agent === p.mcpFallbackAgent
    && sameTask.find((t) => t.id === task.lastRun.termId && t.agent === task.lastRun.agent);
  return fallback
    || sameTask.findLast((t) => t.agent === agent) || (task.stage !== 'planned' ? sameTask.at(-1) : null) || null;
}

function projectLastRunHTML(task) {
  const run = task.lastRun;
  const block = task.launchBlock;
  const sources = { task: '작업별 지정', project: '프로젝트 기본값', parent: '상위 작업 지정', role: '역할 프리셋' };
  return [
    run && `<span class="badge">실제 실행 CLI ${esc(providerName(run.agent))}</span> <span class="badge">선택 근거 ${esc(sources[run.source])}</span>`,
    run?.mcpFallback && `<span class="badge">MCP 대체 CLI · ${esc(providerName(run.mcpFallback.from))} → ${esc(providerName(run.agent))} · ${esc(run.mcpFallback.reason)}</span>`,
    block && `<span role="status">${esc(providerName(block.mcpFallback?.from || block.agent))} · ${esc(sources[block.source])}${block.mcpFallback ? ` → ${esc(providerName(block.agent))}` : ''} · ${esc(block.message)}</span>`,
  ].filter(Boolean).join(' ');
}

function sameProjectFolder(a, b) {
  const normalize = (dir) => String(dir || '').replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
  return normalize(a) === normalize(b);
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

function projectHandoffBadgeHTML(task) {
  const phase = task?.handoff?.history?.at(-1)?.phase;
  const label = { waiting: '대기', delivered: '전달', confirmed: '실행 확인', received: '결과 수신' }[phase];
  return label ? `<span class="badge">자동 진행 · ${label}</span>` : '';
}

function projectReviewBadgeHTML(task, showHandoff = true) {
  const st = task?.reviewStatus || '';
  const wtBadge = task?.worktreePath ? `<span class="badge" title="${esc(task.worktreePath)}">🌿 격리</span>` : '';
  const versionBadge = (task?.version ? `<span class="badge">v${esc(task.version)}</span>` : '')
    + (showHandoff ? projectHandoffBadgeHTML(task) : '');
  if (!st && !task?.retryCount && !task?.reviewPaused) return versionBadge + wtBadge;
  const tip = task?.reviewNote ? ` title="${esc(task.reviewNote)}"` : '';
  let rev = '';
  if (st === 'reviewing') rev = `<span class="badge warn"${tip}>🔍 자동 검토 중</span>`;
  else if (st === 'merge-pending') rev = `<span class="badge warn"${tip}>병합 대기</span>`;
  else if (st === 'merge-integrating') rev = `<span class="badge warn"${tip}>1차 통합 중</span>`;
  else if (st === 'merge-session') rev = `<span class="badge st-merge"${tip}>병합 세션 실행 중</span>`;
  else if (st === 'merge-blocked') rev = `<span class="badge lim"${tip}>병합 차단</span>`;
  else if (st === 'approved') rev = `<span class="badge ok"${tip}>✓ 검토 승인</span>`;
  else if (st === 'rejected' && task.stage === 'doing' && !task.reviewPaused && task.retryCount > 0) {
    rev = `<span class="badge warn"${tip}>↻ 반려 재시도 ${task.retryCount}회</span>`;
  } else if (st === 'rejected') rev = `<span class="badge lim"${tip}>⚠ 검토 반려</span>`;
  else if (st === 'error') rev = `<span class="badge lim"${tip}>⚠ 검토 오류</span>`;
  return `${versionBadge}${rev}${task.reviewPaused && !st.startsWith('merge-') ? '<span class="badge warn">수정 대기</span>' : ''}${wtBadge}`;
}

function projectTaskTextHTML(text) {
  return md(String(text || '')
    .replace(/(?:^|\n)\[(Primary Sources & Assumptions|Methods & Boundaries|Independent Validation)\][ \t]*/g, '\n\n### $1\n')
    .replace(/[ \t]+\((\d{1,2})\)[ \t]+/g, '\n$1. ')
    .replace(/(?<=[.!?。])[ \t]+(?=[^\s])/g, '\n\n'));
}

function projectReviewNoteHTML(task, compact = false) {
  if (!task) return '';
  const st = task.reviewStatus || '';
  let note = String(task.reviewNote || '').trim();
  if (note.startsWith('{') && (note.includes('"conversation_id"') || note.includes('"json_schema"'))) {
    note = '이전 검토에서 원시 CLI 메타데이터만 기록되었습니다. 재검토를 실행하면 사람이 읽을 수 있는 사유로 갱신됩니다.';
  }
  let tone = 'info';
  let label = '';
  let text = note;
  if (st === 'reviewing') {
    tone = 'warn';
    label = '검토 진행';
    if (!text) text = '교차 리뷰 에이전트가 변경 사항과 테스트를 검토 중입니다.';
  } else if (st === 'rejected' && task.stage === 'doing' && !task.reviewPaused) {
    tone = 'warn';
    label = `반려 재작업 (${task.retryCount || 1}회차)`;
  } else if (st === 'rejected') {
    tone = 'danger';
    label = '마지막 검토 반려 사유';
  } else if (st === 'merge-pending') {
    tone = 'warn';
    label = '검토 통과 · 병합 대기';
  } else if (st === 'merge-integrating') {
    tone = 'warn';
    label = '1차 자동 병합 진행 중';
  } else if (st === 'merge-session') {
    tone = 'info';
    label = '병합 세션 최종 확인 중';
  } else if (st === 'merge-blocked') {
    tone = 'danger';
    label = '검토 통과 · 병합 차단';
  } else if (st === 'error') {
    tone = 'danger';
    label = '검토 실행 오류';
  } else if (st === 'approved') {
    tone = 'ok';
    label = '검토 완료 사유';
  } else if (task.stage === 'review') {
    tone = 'info';
    label = '검토 대기';
    if (!text) text = '완료 조건·테스트 통과 여부를 검토하는 단계입니다.';
  }
  if (!label || !text) return '';
  return compact
    ? `<div class="pj-review-note is-${tone} is-compact"><b>${esc(label)}</b> ${esc(text)}</div>`
    : `<section class="pj-review-note is-${tone}"><b>${esc(label)}</b>${projectTaskTextHTML(text)}</section>`;
}

function projectLiveStatusBadgeHTML(p, task) {
  const term = projectTaskTerm(p, task);
  if (!term) return '';
  const startup = terminalStartupLabel(term);
  if (startup) return `<span class="badge warn">${esc(startup)}</span>`;
  const st = typeof termStateOf === 'function' ? termStateOf(term) : 'idle';
  if (task.reviewPaused && st !== 'busy') return '';
  if (st === 'idle' && task.stage === 'doing') return '<span class="badge">입력 대기</span>';
  return st === 'busy'
    ? `<span class="badge warn" data-pj-live-task="${esc(task.id)}" title="에이전트가 작업 중입니다"><span class="dot busy" style="width:6px;height:6px"></span> 작업 중</span>`
    : `<span class="badge ok" data-pj-live-task="${esc(task.id)}" title="에이전트 응답이 완료되어 대기 중입니다">응답 완료</span>`;
}

function projectStartBtnHTML(p, task) {
  if (p.scope?.version?.snapshotId && !p.scope.version.workspace) return '';
  const term = projectTaskTerm(p, task);
  const action = projectStageActionHTML(task, p);
  if (action) return projectLiveStatusBadgeHTML(p, task) + action;
  if (!term && task.stage === 'done') return '';
  if (term) {
    return `${projectLiveStatusBadgeHTML(p, task)}<button class="btn-sm primary" data-start-task="${esc(task.id)}" data-open-task-terminal>터미널 열기 ↗</button>`;
  }
  return `<button class="btn-sm" data-start-task="${esc(task.id)}">작업 시작</button>`;
}

function projectStageActionHTML(task, p) {
  if (p?.scope?.version?.snapshotId && !p.scope.version.workspace) return '';
  const id = esc(task.id);
  if (task.stage === 'doing') return `<button type="button" class="btn-sm primary" data-start-task="${id}">작업 다시 진행</button>`;
  if ((task.stage === 'merge' || task.stage === 'review') && task.reviewStatus === 'merge-integrating') return `<button type="button" class="btn-sm" disabled>1차 통합 중</button>`;
  if ((task.stage === 'merge' || task.stage === 'review') && task.reviewStatus === 'merge-session') return `<button type="button" class="btn-sm" disabled>병합 세션 중</button>`;
  if (task.stage === 'merge' || (task.stage === 'review' && task.reviewStatus?.startsWith('merge-'))) return `<button type="button" class="btn-sm" data-start-task="${id}">통합 재시도</button>`;
  if (task.stage === 'review') return `<button type="button" class="btn-sm primary" data-start-task="${id}"${task.reviewStatus === 'reviewing' ? ' disabled' : ''}>${task.reviewStatus === 'reviewing' ? '검토 중…' : '재검토'}</button>`;
  return '';
}

async function requestProjectReview(p, task, button, drawer) {
  if (button?.disabled) return;
  const label = button?.textContent;
  if (button) button.disabled = true;
  const retryMerge = task.reviewStatus?.startsWith('merge-');
  if (button) button.textContent = retryMerge ? '병합 요청 중…' : '검토 요청 중…';
  try {
    const result = await api('/api/projects/autopilot/complete', { method: 'POST', body: { projectId: p.id, taskId: task.id, force: true, async: true, retryMerge } });
    if (!result.queued) throw new Error(result.error || '검토 요청을 시작하지 못했습니다.');
    drawer?.close();
    toast(retryMerge ? '통합을 요청했습니다.' : '자동 재검토를 시작했습니다');
    await refreshProjects();
    if (state.sel.kind === 'projects' && state.sel.id === p.id) openProject(p.id, projectTab);
  } catch (error) {
    toast(error.message, 5000, 'danger');
    if (button) {
      button.textContent = label;
      button.disabled = false;
    }
  }
}

function runProjectCardAction(p, task, button) {
  if (p.scope?.version?.snapshotId && !p.scope.version.workspace) return toast('이 버전에서 이어 작업을 먼저 시작하세요.', 5000, 'danger');
  if (task.stage === 'review' || task.stage === 'merge') return requestProjectReview(p, task, button);
  return startProjectTask(p, task, button, { retry: task.stage === 'doing', openTerminal: !!button?.hasAttribute('data-open-task-terminal') });
}

const PJ_COLLAPSE_KEY = 'ach.pjCollapse.v1';
function loadPjCollapse() {
  try { return JSON.parse(localStorage.getItem(PJ_COLLAPSE_KEY) || '{}') || {}; } catch { return {}; }
}
function savePjCollapse(map) {
  try { localStorage.setItem(PJ_COLLAPSE_KEY, JSON.stringify(map)); } catch {}
}
function isTaskCollapsed(projectId, taskId) {
  return !!loadPjCollapse()[`${projectId}:t:${taskId}`];
}
function toggleTaskCollapsed(projectId, taskId) {
  const map = loadPjCollapse();
  const k = `${projectId}:t:${taskId}`;
  if (map[k]) delete map[k]; else map[k] = 1;
  savePjCollapse(map);
  return !!map[k];
}
function isLaneCollapsed(projectId, stage) {
  return !!loadPjCollapse()[`${projectId}:l:${stage}`];
}
function toggleLaneCollapsed(projectId, stage) {
  const map = loadPjCollapse();
  const k = `${projectId}:l:${stage}`;
  if (map[k]) delete map[k]; else map[k] = 1;
  savePjCollapse(map);
  return !!map[k];
}
function collapseBtnHTML(collapsed, taskId) {
  return `<button type="button" class="ghost icon-btn btn-sm pj-col-btn" data-toggle-collapse="${esc(taskId)}" title="${collapsed ? '펼치기' : '접기'}" aria-expanded="${!collapsed}">${collapsed ? '▸' : '▾'}</button>`;
}

async function startProjectTask(p, task, button, { retry = false, openTerminal = false } = {}) {
  if (p.scope?.version?.snapshotId && !p.scope.version.workspace) return toast('이 버전에서 이어 작업을 먼저 시작하세요.', 5000, 'danger');
  const gen = viewGen;
  if (button?.disabled) return;
  if (button) button.disabled = true;
  try {
    const current = retry ? null : projectTaskTerm(p, task);
    const t = current || await api('/api/projects/start', { method: 'POST', body: { projectId: p.id, taskId: task.id, ...(retry ? { retry: true } : {}) } });
    if (t.error || !t.id) throw new Error(t.error || '터미널을 열 수 없습니다.');
    if (t.alreadyRunning) toast('작업이 이미 실행 중입니다.');
    if (gen !== viewGen) return;
    if (!state.terms.some((term) => term.id === t.id)) state.terms = [t, ...state.terms];
    if (!openTerminal) {
      if (t.resultReceived) toast('완료된 응답을 확인했습니다. 검토 상태를 갱신합니다.');
      else if (!t.alreadyRunning) toast(retry ? '작업 재실행을 요청했습니다.' : '작업 시작을 요청했습니다.');
      await refreshOverview();
      await refreshProjects();
      return;
    }
    const tab = getSavedTermTab();
    const terminalTab = tab === 'split' || tab === 'screen' ? tab : 'screen';
    select({ kind: 'term', id: t.id, project: p.id, projectVersion: task.version || '', projectTab }, terminalTab);
    await refreshOverview();
  } catch (e) {
    toast(e.message, 5000, 'danger');
    if (typeof refreshProjects === 'function' && gen === viewGen) {
      await refreshProjects();
      if (gen === viewGen && state.sel.kind === 'projects') openProject(p.id, projectTab);
    }
  }
  finally { if (button) button.disabled = false; }
}

function projectTerminals(p, gen) {
  const taskFor = (term) => {
    if (term.projectTask) return term.projectTask.projectId === p.id
      ? p.tasks.find((task) => task.id === term.projectTask.taskId) : null;
    const session = resolveTermSessionId(term);
    return session && p.tasks.find((task) => (p.subChats?.[task.id] || []).some((chat) => chat.sessionId === session));
  };
  const workspace = p.scope?.version?.workspace;
  const terms = state.terms.filter(t => t.exited === null && taskFor(t) && (!workspace || sameProjectFolder(t.cwd, workspace)));
  const host = $('#projectContent');
  const stageMap = new Map(projectStages);
  const nextTask = p.tasks.find((t) => t.stage === 'planned' && !t.parentId && (t.after || []).every((id) => (p.scope?.allTasks || p.tasks).some((prev) => prev.id === id && prev.stage === 'done')));
  host.innerHTML = terms.length
    ? `<div class="grid" style="padding:0">${terms.map((t) => {
      const task = taskFor(t);
      const badge = task ? `<span class="badge">${esc(stageMap.get(task.stage) || task.stage)}</span>` : '';
      return termCardHTML(t, badge);
    }).join('')}</div>`
    : `<div class="pj-empty"><p>실행 중인 프로젝트 터미널이 없습니다.</p>${nextTask ? `<p>시작 가능한 작업 · <b>${esc(nextTask.title)}</b></p>` : ''}<div class="row">${nextTask ? '<button id="projectNextTask" class="primary">작업 상세 열기</button>' : ''}<button id="projectGoBoard2">칸반 보드 열기</button><button id="projectPlan">작업 설계 열기</button></div></div>`;
  if (!terms.length) {
    if (nextTask) $('#projectNextTask').onclick = () => openProjectTaskDrawer(p, nextTask);
    $('#projectGoBoard2').onclick = () => openProject(p.id, 'board');
    $('#projectPlan').onclick = () => openProject(p.id, 'design');
  }
  for (const card of host.querySelectorAll('[data-term]')) {
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.onclick = () => select({ kind: 'term', id: card.dataset.term, project: p.id, projectVersion: p.scope?.number || '', projectTab: 'terms' });
    card.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); card.click(); } };
  }
  bindMiniTerminals(gen, terms, []);
}
