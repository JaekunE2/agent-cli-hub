function scheduleTargetFields() {
  return `<fieldset><legend>실행 대상</legend>
    <label>프로젝트 <select name="projectId" required></select></label>
    <label>버전 <select name="version" required></select></label>
    <label>작업 (선택) <select name="taskId"></select></label>
    <label>CLI <select name="cli" required></select></label>
    <label>계정 <select name="accountId" required></select></label>
    <label>참조 폴더 (한 줄에 하나) <textarea name="referenceDirs" rows="2"></textarea></label>
  </fieldset>`;
}

function bindScheduleTarget(fields, projects, capabilities, previous = {}) {
  const { projectId, version, taskId, cli, accountId, referenceDirs } = fields;
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
  fill(projectId, [['', '프로젝트 선택'], ...projects.map(item => [item.id, item.name])],
    previous.projectId ?? (projects.length === 1 ? projects[0].id : ''));
  versions(previous.version, previous.taskId || '');
  fill(cli, capabilities.map(item => [item.id, item.id === 'codex' ? 'Codex' : item.id]), previous.cli);
  accounts(previous.accountId);
  referenceDirs.value = (previous.referenceDirs || []).join('\n');
  projectId.onchange = () => versions();
  version.onchange = () => tasks();
  cli.onchange = () => accounts();

  return () => ({
    projectId: projectId.value, version: version.value, taskId: taskId.value || null,
    cli: cli.value, accountId: accountId.value,
    referenceDirs: referenceDirs.value.split(/\r?\n/).map(path => path.trim()).filter(Boolean),
    model: previous.model, effort: previous.effort,
  });
}
