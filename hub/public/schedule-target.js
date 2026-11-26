function scheduleTargetFields() {
  return `<fieldset><legend>실행 대상</legend>
    <div class="seg sm" role="tablist" aria-label="대상 구분" data-sch-target-tabs>
      <button type="button" data-sch-mode="session">일반 세션 (폴더)</button>
      <button type="button" data-sch-mode="project">프로젝트</button>
    </div>
    <div data-sch-pane="session">
      <label>작업 폴더
        <div class="sch-cwd-row">
          <input name="cwd" list="schCwdList" placeholder="예: D:\\Gitsource\\project">
          <button type="button" class="btn-sm" data-sch-pick-cwd>폴더 선택</button>
        </div>
      </label>
      <datalist id="schCwdList"></datalist>
    </div>
    <div data-sch-pane="project">
      <div class="sch-grid-2">
        <label>프로젝트 <select name="projectId"></select></label>
        <label>버전 <select name="version"></select></label>
      </div>
      <label>작업 (선택) <select name="taskId"></select></label>
    </div>
    <div class="sch-grid-2">
      <label>CLI <select name="cli" required></select></label>
      <label>계정 <select name="accountId" required></select></label>
    </div>
  </fieldset>`;
}

function bindScheduleTarget(fields, projects, capabilities, previous = {}) {
  const { projectId, version, taskId, cwd, cli, accountId, referenceDirs } = fields;
  const form = projectId.form;
  const sessionPane = $('[data-sch-pane="session"]', form);
  const projectPane = $('[data-sch-pane="project"]', form);
  const modeBtns = [...form.querySelectorAll('[data-sch-mode]')];
  let mode = previous.projectId ? 'project' : 'session';

  const fill = (select, choices, current) => {
    select.replaceChildren(...choices.map(([id, name]) => new Option(name, id)));
    if (current !== undefined) select.value = current;
  };
  const selectedProject = () => projects.find(item => item.id === projectId.value);
  const tasks = (current) => {
    const choices = (selectedProject()?.tasks || []).filter(task => task.version === version.value);
    fill(taskId, [['', '작업 없음'], ...choices.map(task => [task.id, task.title])], current);
  };
  const versions = (current, task) => {
    const choices = selectedProject()?.versions || [];
    fill(version, [['', '버전 선택'], ...choices.map(item => [item.number, item.number])],
      current ?? (choices.length === 1 ? choices[0].number : ''));
    tasks(task);
  };
  const accounts = current => {
    const choices = capabilities.find(item => item.id === cli.value)?.accountIds || [];
    fill(accountId, choices.map(id => [id, id === 'default' ? '기본 계정' : id]), current);
  };

  const recentCwds = [...new Set([
    ...(state.terms || []).map(t => t.cwd),
    ...(state.recent || []).map(r => r.cwd),
  ].filter(Boolean))].slice(0, 15);
  const cwdList = $('#schCwdList', form);
  if (cwdList) cwdList.replaceChildren(...recentCwds.map(dir => Object.assign(document.createElement('option'), { value: dir })));
  cwd.value = previous.cwd || recentCwds[0] || '';

  const syncMode = () => {
    const isProj = mode === 'project';
    sessionPane.hidden = isProj;
    projectPane.hidden = !isProj;
    cwd.required = !isProj;
    cwd.disabled = isProj;
    projectId.required = isProj;
    projectId.disabled = !isProj;
    version.required = isProj;
    version.disabled = !isProj;
    taskId.disabled = !isProj;
    for (const btn of modeBtns) btn.classList.toggle('on', btn.dataset.schMode === mode);
  };
  for (const btn of modeBtns) btn.onclick = () => { mode = btn.dataset.schMode; syncMode(); };
  const pickBtn = $('[data-sch-pick-cwd]', form);
  if (pickBtn) pickBtn.onclick = async () => {
    if (typeof pickNativeFolder !== 'function') return;
    const picked = await pickNativeFolder({ title: '스케줄 작업 폴더 선택', defaultPath: cwd.value.trim() || undefined });
    if (picked) cwd.value = picked;
  };

  fill(projectId, [['', '프로젝트 선택'], ...projects.map(item => [item.id, item.name])],
    previous.projectId ?? (projects.length === 1 ? projects[0].id : ''));
  versions(previous.version, previous.taskId || '');
  const cliLabel = item => item.label || ({ codex: 'Codex', claude: 'Claude', agy: 'Antigravity' }[item.id] || item.id);
  fill(cli, capabilities.map(item => [item.id, cliLabel(item)]), previous.cli);
  accounts(previous.accountId);
  referenceDirs.value = (previous.referenceDirs || []).join('\n');
  projectId.onchange = () => versions();
  version.onchange = () => tasks();
  cli.onchange = () => accounts();
  syncMode();

  return () => ({
    ...(mode === 'project'
      ? { projectId: projectId.value, version: version.value, taskId: taskId.value || null }
      : { cwd: cwd.value.trim() }),
    cli: cli.value, accountId: accountId.value,
    referenceDirs: referenceDirs.value.split(/\r?\n/).map(path => path.trim()).filter(Boolean),
    model: previous.model, effort: previous.effort,
  });
}
