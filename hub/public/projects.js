let projectId = '', projectTab = 'board';
const projectStages = [['planned', '계획'], ['doing', '진행'], ['review', '검토'], ['done', '완료']];
const projectViews = [['design', '작업 설계'], ['board', '칸반 보드'], ['flow', '작업 흐름'], ['terms', '터미널 모아보기']];
const newTaskId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join('');

async function saveProject(p, tab) {
  const gen = viewGen;
  const r = await api('/api/projects', { method: 'POST', body: p });
  if (r.error) throw new Error(r.error);
  if (typeof refreshProjects === 'function') await refreshProjects();
  if (gen === viewGen) openProject(r.project.id, tab || (p.id ? projectTab : 'design'));
}

function openProject(id = projectId, tab = projectTab) { select({ kind: 'projects', id }, tab); }

function stageBadgeHTML(stage) {
  const label = projectStages.find((x) => x[0] === stage)?.[1] || stage;
  return `<span class="badge st-${esc(stage)}">${esc(label)}</span>`;
}

function tokFmt(n) {
  return typeof fmtTok === 'function' ? fmtTok(n) : String(n || 0);
}

function openProjectTokensDrawer(p) {
  const tk = p.tokens || { total: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, byAgent: {}, byTask: {}, sessions: 0 };
  const t = tk.total || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  const agEntries = Object.entries(tk.byAgent || {}).filter(([, v]) => (v?.total || 0) > 0).sort((a, b) => (b[1].total || 0) - (a[1].total || 0));
  const taskEntries = (p.tasks || []).map((task) => ({ task, data: tk.byTask?.[task.id] })).filter((x) => (x.data?.total?.total || 0) > 0);
  const agRows = agEntries.map(([ag, v]) => `<div class="drw-kv">
    <span class="row" style="gap:7px">${typeof agentIcon === 'function' ? agentIcon(ag) : ''}${esc(providerName(ag))}</span>
    <b>${tokFmt(v.total)} <span style="font-weight:400;color:var(--muted);font-size:11.5px">(입력 ${tokFmt(v.input)} · 출력 ${tokFmt(v.output)}${v.cacheRead ? ` · 캐시 ${tokFmt(v.cacheRead)}` : ''})</span></b>
  </div>`).join('') || '<div class="empty" style="padding:0">아직 집계된 CLI 토큰 기록이 없습니다.</div>';
  const taskRows = taskEntries.map(({ task, data }) => {
    const chips = Object.entries(data.byAgent || {}).filter(([, v]) => (v?.total || 0) > 0)
      .map(([ag, v]) => `<span class="badge">${esc(providerName(ag))} ${tokFmt(v.total)}</span>`).join('');
    return `<div style="padding:8px 0;border-top:1px solid var(--line)">
      <div class="row" style="justify-content:space-between"><b>${esc(task.title)}</b><b class="mono">${tokFmt(data.total.total)}</b></div>
      <div class="pj-tok-sub">${chips}</div>
    </div>`;
  }).join('') || '<div class="empty" style="padding:0">작업별 토큰 기록이 아직 없습니다.</div>';

  const body = `
    <div class="drw-sec">
      <div class="drw-lbl">누적 토큰 합계 (CLI 변경 포함 전체 합산)</div>
      <div class="drw-kv"><span>총 토큰</span><b class="mono" style="font-size:16px">${tokFmt(t.total)}</b></div>
      <div class="drw-kv"><span>입력 / 출력</span><b>${tokFmt(t.input)} / ${tokFmt(t.output)}</b></div>
      <div class="drw-kv"><span>캐시 읽기 / 쓰기</span><b>${tokFmt(t.cacheRead)} / ${tokFmt(t.cacheWrite)}</b></div>
      <div class="drw-kv"><span>집계 세션 수</span><b>${tk.sessions || 0}개</b></div>
    </div>
    <div class="drw-sec">
      <div class="drw-lbl">CLI별 누적 사용량</div>
      <div>${agRows}</div>
    </div>
    <div class="drw-sec">
      <div class="drw-lbl">작업별 누적 사용량</div>
      <div>${taskRows}</div>
    </div>
    <div class="ums">작업 도중 담당 CLI(Claude · Codex · Antigravity)를 변경해도 이전 CLI에서 사용한 토큰이 모두 유지·합산됩니다.</div>`;
  openDrawer({ title: `${p.name} · 누적 토큰`, bodyHTML: body, footerHTML: '<button data-drw-close>닫기</button>', width: 480 });
}

// Unified Right Detail Drawer for any Project Task (clicked from List, Kanban, or Flow)
function openProjectTaskDrawer(p, task) {
  if (!task) return;
  const ico = window.UI_ICO || {};
  const deps = task.after.map((id) => p.tasks.find((x) => x.id === id)).filter(Boolean);
  const parent = task.parentId ? p.tasks.find((x) => x.id === task.parentId) : null;
  const subs = p.tasks.filter((x) => x.parentId === task.id);
  const term = projectTaskTerm(p, task);
  const cfg = effectiveTaskConfig(p, task);
  const ag = term?.agent || cfg.agent;
  const taskTok = p.tokens?.byTask?.[task.id];
  const taskTokChips = taskTok ? Object.entries(taskTok.byAgent || {}).filter(([, v]) => (v?.total || 0) > 0)
    .map(([a, v]) => `<span class="badge">${esc(providerName(a))} ${tokFmt(v.total)}</span>`).join('') : '';
  const stageSeg = projectStages.map(([st, lbl]) =>
    `<button type="button" data-drw-stage="${st}" class="${task.stage === st ? 'on' : ''}">${lbl}</button>`
  ).join('');
  const subRowsHTML = subs.map((st) => {
    const sTerm = projectTaskTerm(p, st);
    const sCfg = effectiveTaskConfig(p, st);
    return `<div class="pj-drw-sub-item">
      <div class="pj-drw-sub-main" data-drw-open-sub="${esc(st.id)}">
        <div class="pj-drw-sub-title">${esc(st.title)}</div>
        <div class="pj-drw-sub-meta">${stageBadgeHTML(st.stage)}<span>${esc([providerName(sCfg.agent), sCfg.model, sCfg.effort].filter(Boolean).join(' · '))}</span></div>
      </div>
      <button type="button" class="btn-sm${sTerm ? ' primary' : ''}" data-drw-start-sub="${esc(st.id)}">${sTerm ? '열기 ↗' : '시작'}</button>
    </div>`;
  }).join('');
  const cliLine = [providerName(ag), term?.account?.label || (cfg.account || ''), cfg.model || '', cfg.effort ? `추론 ${cfg.effort}` : ''].filter(Boolean).join(' · ');
  const body = `
    ${parent ? `<div class="drw-sec"><div class="drw-lbl">상위 작업</div><button type="button" class="ghost btn-sm" data-drw-open-sub="${esc(parent.id)}">↳ ${esc(parent.title)}</button></div>` : ''}
    <div class="drw-sec">
      <div class="drw-lbl">진행 단계</div>
      <div class="seg" role="tablist" aria-label="작업 단계 선택">${stageSeg}</div>
    </div>
    <div class="drw-sec">
      <div class="drw-lbl">작업 지시 · 완료 기준</div>
      <div style="white-space:pre-wrap;line-height:1.6;font-size:13.5px;color:${task.detail ? 'var(--text)' : 'var(--muted)'}">${esc(task.detail || '아직 작성된 작업 지시가 없습니다. 아래 수정 버튼으로 추가할 수 있습니다.')}</div>
    </div>
    <div class="drw-sec">
      <div class="drw-lbl">담당 CLI · 모델 · 추론 성능</div>
      <div class="row" style="justify-content:space-between">
        <span class="row" style="gap:8px">${typeof agentIcon === 'function' ? agentIcon(ag) : ''}<b>${esc(cliLine)}</b></span>
        <button type="button" class="btn-sm" data-drw-assign>CLI · 모델 변경</button>
      </div>
    </div>
    ${!parent ? `<div class="drw-sec">
      <div class="row" style="justify-content:space-between">
        <div class="drw-lbl" style="margin:0">서브 개발 작업 (${subs.length})</div>
        <div class="row" style="gap:6px">
          <button type="button" class="btn-sm" data-drw-ai-sub title="선택한 CLI로 이 작업을 2~6개 서브 개발 단계로 자동 분해">✨ AI 서브 분해</button>
          <button type="button" class="btn-sm" data-drw-add-sub>＋ 서브 추가</button>
        </div>
      </div>
      <div data-sub-progress></div>
      <div style="display:flex;flex-direction:column;gap:6px">${subRowsHTML || '<div class="empty" style="padding:4px 0">아직 서브 개발 작업이 없습니다. 직접 추가하거나 AI 서브 분해를 실행하세요.</div>'}</div>
    </div>` : ''}
    ${taskTok?.total?.total ? `<div class="drw-sec">
      <div class="drw-lbl">누적 토큰 (이전 CLI 포함)</div>
      <div class="row" style="justify-content:space-between"><b>${tokFmt(taskTok.total.total)} 토큰</b><span class="ums" style="margin:0">세션 ${taskTok.sessions || 1}개</span></div>
      ${taskTokChips ? `<div class="pj-tok-sub">${taskTokChips}</div>` : ''}
    </div>` : ''}
    ${deps.length ? `<div class="drw-sec">
      <div class="drw-lbl">선행 작업 (${deps.length})</div>
      <div class="row" style="gap:6px">${deps.map((dep) => `<span class="badge st-${esc(dep.stage)}">${esc(dep.title)}</span>`).join('')}</div>
    </div>` : ''}`;
  const foot = `
    <button type="button" class="danger ghost" data-drw-del>${ico.trash || ''} 삭제</button>
    <span class="sp"></span>
    <button type="button" data-drw-edit>${ico.edit || ''} 수정</button>
    <button type="button" class="primary" data-drw-start>${term ? '터미널 열기 ↗' : '작업 시작'}</button>`;
  const d = openDrawer({ title: task.title, bodyHTML: body, footerHTML: foot, width: 500 });
  d.addEventListener('click', async (e) => {
    const stBtn = e.target.closest('[data-drw-stage]');
    if (stBtn) {
      const nextStage = stBtn.dataset.drwStage;
      if (nextStage === task.stage) return;
      d.close();
      saveProject({ ...p, tasks: p.tasks.map((t) => (t.id === task.id ? { ...t, stage: nextStage } : t)) }).catch((er) => toast(er.message, 5000, 'danger'));
      return;
    }
    const openSub = e.target.closest('[data-drw-open-sub]');
    if (openSub) {
      const target = p.tasks.find((x) => x.id === openSub.dataset.drwOpenSub);
      if (target) { d.close(); openProjectTaskDrawer(p, target); }
      return;
    }
    const startSub = e.target.closest('[data-drw-start-sub]');
    if (startSub) {
      const target = p.tasks.find((x) => x.id === startSub.dataset.drwStartSub);
      if (target) { d.close(); startProjectTask(p, target, startSub); }
      return;
    }
    if (e.target.closest('[data-drw-add-sub]')) { d.close(); return taskForm(p, null, false, task.id); }
    const aiSubBtn = e.target.closest('[data-drw-ai-sub]');
    if (aiSubBtn) {
      const progHost = d.querySelector('[data-sub-progress]');
      aiSubBtn.disabled = true;
      try {
        const cliName = providerName(cfg.agent);
        const { r } = await runPlanWithProgress(
          progHost,
          cliName,
          () => api('/api/projects/subtasks', {
            method: 'POST',
            body: { projectId: p.id, taskId: task.id, agent: cfg.agent, account: cfg.account, model: cfg.model, effort: cfg.effort },
          }),
          '서브 개발 단계 분해 중…',
        );
        if (!Array.isArray(r.tasks) || !r.tasks.length) throw new Error(r.error || '서브 작업을 생성하지 못했습니다.');
        const saved = await api('/api/projects', { method: 'POST', body: { ...p, tasks: [...p.tasks, ...r.tasks] } });
        if (saved.error) throw new Error(saved.error);
        if (typeof refreshProjects === 'function') await refreshProjects();
        toast(`서브 개발 작업 ${r.tasks.length}개를 추가했습니다`);
        d.close();
        openProject(saved.project.id, projectTab);
        const freshTask = saved.project.tasks.find((x) => x.id === task.id);
        if (freshTask) openProjectTaskDrawer(saved.project, freshTask);
      } catch (er) {
        if (progHost) progHost.textContent = '';
        toast(er.message, 6000, 'danger');
      } finally {
        if (aiSubBtn.isConnected) aiSubBtn.disabled = false;
      }
      return;
    }
    if (e.target.closest('[data-drw-assign]')) { d.close(); return taskForm(p, task, true); }
    if (e.target.closest('[data-drw-edit]')) { d.close(); return taskForm(p, task); }
    if (e.target.closest('[data-drw-del]')) {
      const subCnt = typeof taskDescendants === 'function' ? taskDescendants(p.tasks, task.id).size - 1 : 0;
      const msg = subCnt > 0
        ? `이 작업과 하위 서브 작업 ${subCnt}개를 함께 삭제할까요?`
        : '이 작업을 삭제하고 다른 카드에 연결된 선행 작업에서도 제거할까요?';
      if (!confirm(msg)) return;
      d.close();
      const tasks = typeof removeTaskCascade === 'function'
        ? removeTaskCascade(p, task.id)
        : p.tasks.filter((t) => t.id !== task.id).map((t) => ({ ...t, after: t.after.filter((id) => id !== task.id) }));
      saveProject({ ...p, tasks }).catch((er) => toast(er.message, 5000, 'danger'));
      return;
    }
    const startBtn = e.target.closest('[data-drw-start]');
    if (startBtn) {
      d.close();
      startProjectTask(p, task, startBtn);
    }
  });
}

async function viewProjects() {
  const gen = viewGen;
  projectTab = projectViews.some(([id]) => id === state.tab) ? state.tab : projectTab;
  setBar('');
  $('#view').innerHTML = '<div class="pj"><div class="empty">프로젝트를 불러오는 중…</div></div>';
  try {
    const r = await api('/api/projects');
    if (gen !== viewGen) return;
    if (r.error) throw new Error(r.error);
    const projectList = r.projects;
    state.projects = projectList;
    if (r.defaultCwd) state.defaultProjectCwd = r.defaultCwd;
    const p = projectList.find(x => x.id === (state.sel.id || projectId)) || projectList[0];
    if (p) { projectId = p.id; state.sel.id = p.id; }
    if (typeof renderSide === 'function') renderSide();
    if (!p) {
      $('#view').innerHTML = `<div class="pj">
        <div class="pj-top"><div class="pj-top-left"><h3>Project</h3></div><div class="pj-top-right"><button id="projectNew" class="primary">＋ 새 Project</button></div></div>
        <div class="pj-empty"><h3>첫 Project를 시작하세요</h3><p>목표와 작업을 설계하고, 작업별 CLI를 정해 전용 터미널에서 실행하세요.</p><button id="firstProject" class="primary">작업 설계 시작</button></div>
      </div>`;
      $('#projectNew').onclick = $('#firstProject').onclick = () => projectForm();
      return;
    }
    const total = p.tasks.length;
    const cnt = { planned: 0, doing: 0, review: 0, done: 0 };
    for (const t of p.tasks) cnt[t.stage] = (cnt[t.stage] || 0) + 1;
    const pct = total ? Math.round((cnt.done / total) * 100) : 0;
    const segW = (n) => (total ? ((n / total) * 100).toFixed(1) : 0);
    const ico = window.UI_ICO || {};
    const totalTok = p.tokens?.total?.total || 0;
    $('#view').innerHTML = `<div class="pj">
      <header class="pj-top">
        <div class="pj-top-left">
          <select id="projectPick" class="pj-pick" aria-label="Project 선택">${projectList.map(x => `<option value="${esc(x.id)}" ${x.id === p.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
          <span class="pj-cwd" title="${esc(p.cwd)}">${ico.folder || ''}${esc(base(p.cwd) || p.cwd)}</span>
        </div>
        <div class="pj-top-right">
          <button id="projectTokens" class="pj-tok-pill" title="Project 누적 토큰 상세 (CLI 변경 포함 전체 합산)">토큰 <b>${tokFmt(totalTok)}</b></button>
          <div class="pj-prog" role="progressbar" aria-label="작업 진행률" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" title="완료 ${cnt.done} · 검토 ${cnt.review} · 진행 ${cnt.doing} · 계획 ${cnt.planned}">
            <div class="pj-stackbar">
              ${cnt.done ? `<i class="done" style="width:${segW(cnt.done)}%"></i>` : ''}
              ${cnt.review ? `<i class="review" style="width:${segW(cnt.review)}%"></i>` : ''}
              ${cnt.doing ? `<i class="doing" style="width:${segW(cnt.doing)}%"></i>` : ''}
            </div>
            <span class="pj-prog-lbl"><b>${pct}%</b> (${cnt.done}/${total})</span>
          </div>
          <button id="projectAdd" class="primary">＋ 작업</button>
          <button id="projectMore" class="ghost icon-btn" aria-label="Project 메뉴" aria-haspopup="menu" aria-expanded="false" title="새 Project · 설계 수정 · 삭제">${ico.more || '⋯'}</button>
        </div>
      </header>
      <div class="pj-toolbar">
        <div class="tablist" role="tablist" aria-label="Project 보기">${projectViews.map(([id, label]) => `<button role="tab" data-pjtab="${id}" aria-selected="${projectTab === id}" class="${projectTab === id ? 'on' : ''}">${label}</button>`).join('')}</div>
      </div>
      <div id="projectContent"></div>
    </div>`;
    $('#projectPick').onchange = e => openProject(e.target.value);
    $('#projectTokens').onclick = () => openProjectTokensDrawer(p);
    document.querySelectorAll('[data-pjtab]').forEach(b => (b.onclick = () => openProject(p.id, b.dataset.pjtab)));
    $('#projectAdd').onclick = () => taskForm(p);
    $('#projectMore').onclick = (e) => {
      e.stopPropagation();
      openMoreMenu(e.currentTarget, [
        { label: '새 Project 만들기', icon: ico.plus || '', onClick: () => projectForm() },
        { label: '목표 · 설계 수정', icon: ico.edit || '', onClick: () => projectForm(p) },
        { label: '작업 흐름 생성', icon: ico.swap || '', onClick: () => projectForm(p) },
        { divider: true },
        { label: 'Project 삭제', icon: ico.trash || '', tone: 'danger', onClick: () => removeProject(p, $('#projectMore')) },
      ]);
    };
    if (projectTab === 'design') projectDesign(p);
    else if (projectTab === 'terms') projectTerminals(p, gen);
    else projectBoard(p);
  } catch (e) {
    if (gen !== viewGen) return;
    $('#view').innerHTML = `<div class="pj"><div class="pj-empty"><p role="alert">${esc(e.message)}</p><button id="projectRetry">다시 불러오기</button></div></div>`;
    $('#projectRetry').onclick = () => openProject();
  }
}

async function removeProject(p, button) {
  if (!confirm(`“${p.name}”의 전용 CLI 터미널을 종료하고 Project와 연결된 원본 대화를 영구 삭제할까요? 진행 중인 CLI 작업은 중단됩니다. 작업 파일은 유지됩니다.`)) return;
  if (button) button.disabled = true;
  try {
    const r = await api('/api/projects', { method: 'DELETE', body: { id: p.id, revision: p.revision, stopRunning: true } });
    if (r.error || !Number.isInteger(r.removed)) throw new Error(r.error || 'Project를 삭제할 수 없습니다.');
    await Promise.all([refreshRecent(), refreshOverview(), typeof refreshProjects === 'function' ? refreshProjects() : Promise.resolve()]);
    if (state.sel.kind === 'projects' && projectId === p.id) openProject('', 'design');
    toast(`Project를 삭제했습니다. 원본 CLI 대화 ${r.removed}개를 삭제했습니다.`);
  } catch (e) { toast(e.message, 5000, 'danger'); }
  finally { if (button) button.disabled = false; }
}
