function scheduleTargetFields() {
  return `<fieldset><legend>실행 대상</legend>
    <div class="seg sm" role="tablist" aria-label="대상 구분" data-sch-target-tabs>
      <button type="button" data-sch-mode="session">일반 세션</button>
      <button type="button" data-sch-mode="project">프로젝트</button>
    </div>
    <div data-sch-pane="session">
      <label>실행 세션
        <select name="sessionPick"></select>
      </label>
      <p class="sch-help" data-sch-session-hint hidden></p>
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
      <div class="sch-grid-2">
        <label>작업 (선택) <select name="taskId"></select></label>
        <label>실행 세션 <select name="projectSessionPick"></select></label>
      </div>
      <p class="sch-help" data-sch-proj-session-hint hidden></p>
    </div>
    <div class="sch-grid-2">
      <label>CLI <select name="cli" required></select></label>
      <label>계정 <select name="accountId" required></select></label>
    </div>
  </fieldset>`;
}

function bindScheduleTarget(fields, projects, capabilities, previous = {}) {
  const { projectId, version, taskId, cwd, sessionPick, projectSessionPick, cli, accountId, referenceDirs } = fields;
  const form = projectId.form;
  const sessionPane = $('[data-sch-pane="session"]', form);
  const projectPane = $('[data-sch-pane="project"]', form);
  const sessionHint = $('[data-sch-session-hint]', form);
  const projSessionHint = $('[data-sch-proj-session-hint]', form);
  const modeBtns = [...form.querySelectorAll('[data-sch-mode]')];
  let mode = previous.projectId ? 'project' : 'session';

  const supportedCliIds = new Set(capabilities.map(c => c.id));
  const fill = (select, choices, current) => {
    select.replaceChildren(...choices.map(([id, name]) => new Option(name, id)));
    if (current !== undefined) select.value = current;
  };
  const selectedProject = () => projects.find(item => item.id === projectId.value);
  const accounts = current => {
    const choices = capabilities.find(item => item.id === cli.value)?.accountIds || [];
    fill(accountId, choices.map(id => [id, id === 'default' ? '기본 계정' : id]), current);
  };

  // Build selectable session entries (open terminals + recent sessions)
  const sessionMap = new Map();
  const buildSessionPicker = (selectEl, { liveItems = [], recentItems = [], emptyLabel, initialValue = '', preservedLabel = '' }) => {
    selectEl.replaceChildren();
    selectEl.append(new Option(emptyLabel, ''));
    const appendGroup = (label, list) => {
      if (!list.length) return;
      const grp = document.createElement('optgroup');
      grp.label = label;
      for (const item of list) {
        sessionMap.set(item.value, item);
        grp.append(new Option(item.optionText, item.value));
      }
      selectEl.append(grp);
    };
    appendGroup('열려 있는 세션', liveItems);
    appendGroup('기존 대화 세션', recentItems);
    if (initialValue && !sessionMap.has(initialValue)) {
      const fallbackText = preservedLabel || initialValue.replace(/^(?:sid|term):/, '');
      const item = {
        value: initialValue,
        sessionId: initialValue.startsWith('sid:') ? initialValue.slice(4) : '',
        termId: initialValue.startsWith('term:') ? initialValue.slice(5) : '',
        label: fallbackText,
        cwd: previous.cwd || '',
        cli: previous.cli || '',
        accountId: previous.accountId || '',
        optionText: fallbackText,
      };
      sessionMap.set(initialValue, item);
      selectEl.append(new Option(`기존 연결 · ${fallbackText}`, initialValue));
    }
    selectEl.value = initialValue || '';
  };

  const agentTag = (ag) => ({ codex: 'Codex', claude: 'Claude', agy: 'AGY' }[ag] || ag || 'CLI');
  const liveTerms = (state.terms || []).filter(t => t.exited === null && !isEphemeralTerm(t) && ['codex', 'claude', 'agy'].includes(t.agent));
  const recentList = (state.recent || []).filter(r => !isProjectSubRecent(r) && ['codex', 'claude', 'agy'].includes(r.agent || 'claude'));

  const makeTermItem = (t) => {
    const sid = t.sessionId || '';
    const value = sid ? `sid:${sid}` : `term:${t.id}`;
    const lbl = termLabel(t);
    const st = termStateOf(t) === 'busy' ? '실행 중' : '대기';
    const dir = t.cwd ? base(t.cwd) : '';
    return {
      value,
      sessionId: sid,
      termId: String(t.id),
      label: lbl,
      cwd: t.cwd || '',
      cli: t.agent || '',
      accountId: t.account?.id || '',
      optionText: `[${st}] ${lbl} · ${agentTag(t.agent)}${dir ? ` · ${dir}` : ''}`,
    };
  };
  const makeRecentItem = (r) => {
    const sid = r.sessionId;
    const lbl = sessionLabel(r);
    const ag = r.agent || 'claude';
    const dir = r.cwd ? base(r.cwd) : '';
    return {
      value: `sid:${sid}`,
      sessionId: sid,
      termId: '',
      label: lbl,
      cwd: r.cwd || '',
      cli: ag,
      accountId: '',
      optionText: `${lbl} · ${agentTag(ag)}${dir ? ` · ${dir}` : ''}`,
    };
  };

  // General sessions dropdown
  const genLive = liveTerms.filter(t => !t.projectTask).map(makeTermItem);
  const genLiveSids = new Set(genLive.map(x => x.sessionId).filter(Boolean));
  const genRecent = recentList.filter(r => !genLiveSids.has(r.sessionId)).slice(0, 30).map(makeRecentItem);
  const prevKey = previous.sessionId ? `sid:${previous.sessionId}` : (previous.termId ? `term:${previous.termId}` : '');
  buildSessionPicker(sessionPick, {
    liveItems: genLive,
    recentItems: genRecent,
    emptyLabel: '새 세션으로 실행 (작업 폴더 지정)',
    initialValue: !previous.projectId ? prevKey : '',
    preservedLabel: !previous.projectId ? (previous.sessionLabel || '') : '',
  });

  const populateProjectSessions = (initialValue = '') => {
    const pj = selectedProject();
    if (!pj) {
      buildSessionPicker(projectSessionPick, { liveItems: [], recentItems: [], emptyLabel: '새 세션으로 실행 (기본)' });
      return;
    }
    const pjLive = liveTerms.filter(t => projectOfTerm(t)?.id === pj.id).map(makeTermItem);
    const pjLiveSids = new Set(pjLive.map(x => x.sessionId).filter(Boolean));
    const pjRecent = [];
    for (const sid of (pj.sessionIds || [])) {
      if (pjLiveSids.has(sid)) continue;
      const r = recentSession(sid);
      if (r) pjRecent.push(makeRecentItem(r));
      else pjRecent.push({
        value: `sid:${sid}`,
        sessionId: sid,
        termId: '',
        label: sid.slice(0, 8),
        cwd: pj.cwd || '',
        cli: '',
        accountId: '',
        optionText: `세션 ${sid.slice(0, 8)}`,
      });
    }
    buildSessionPicker(projectSessionPick, {
      liveItems: pjLive,
      recentItems: pjRecent.slice(0, 30),
      emptyLabel: '새 세션으로 실행 (기본)',
      initialValue,
      preservedLabel: previous.projectId === pj.id ? (previous.sessionLabel || '') : '',
    });
  };

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

  const recentCwds = [...new Set([
    ...(state.terms || []).map(t => t.cwd),
    ...(state.recent || []).map(r => r.cwd),
  ].filter(Boolean))].slice(0, 15);
  const cwdList = $('#schCwdList', form);
  if (cwdList) cwdList.replaceChildren(...recentCwds.map(dir => Object.assign(document.createElement('option'), { value: dir })));
  cwd.value = previous.cwd || recentCwds[0] || '';

  const applyPickedSession = (pickEl, hintEl) => {
    const picked = sessionMap.get(pickEl.value);
    if (!picked) {
      if (hintEl) { hintEl.hidden = true; hintEl.textContent = ''; }
      return;
    }
    if (mode === 'session' && picked.cwd) cwd.value = picked.cwd;
    if (picked.cli && supportedCliIds.has(picked.cli)) {
      cli.value = picked.cli;
      accounts(picked.accountId || undefined);
    }
    if (hintEl) {
      hintEl.hidden = false;
      hintEl.textContent = picked.sessionId
        ? '선택한 기존 세션의 대화 맥락을 이어서 스케줄을 실행합니다.'
        : '선택한 열린 세션의 작업 폴더와 설정으로 스케줄을 실행합니다.';
    }
  };

  const syncMode = () => {
    const isProj = mode === 'project';
    sessionPane.hidden = isProj;
    projectPane.hidden = !isProj;
    sessionPick.disabled = isProj;
    cwd.required = !isProj;
    cwd.disabled = isProj;
    projectId.required = isProj;
    projectId.disabled = !isProj;
    version.required = isProj;
    version.disabled = !isProj;
    taskId.disabled = !isProj;
    projectSessionPick.disabled = !isProj;
    for (const btn of modeBtns) btn.classList.toggle('on', btn.dataset.schMode === mode);
    if (isProj) applyPickedSession(projectSessionPick, projSessionHint);
    else applyPickedSession(sessionPick, sessionHint);
  };
  for (const btn of modeBtns) btn.onclick = () => { mode = btn.dataset.schMode; syncMode(); };
  const pickBtn = $('[data-sch-pick-cwd]', form);
  if (pickBtn) pickBtn.onclick = async () => {
    if (typeof pickNativeFolder === 'function') {
      const picked = await pickNativeFolder({ title: '스케줄 작업 폴더 선택', defaultPath: cwd.value.trim() || undefined });
      if (picked) { cwd.value = picked; return; }
    }
    if (typeof openFolderPickerDialog === 'function') {
      openFolderPickerDialog(cwd.value.trim(), (chosen) => { if (chosen) cwd.value = chosen; });
    }
  };

  fill(projectId, [['', '프로젝트 선택'], ...projects.map(item => [item.id, item.name])],
    previous.projectId ?? (projects.length === 1 ? projects[0].id : ''));
  versions(previous.version, previous.taskId || '');
  populateProjectSessions(previous.projectId ? prevKey : '');
  const cliLabel = item => {
    const baseName = item.label || ({ codex: 'Codex', claude: 'Claude', agy: 'Antigravity' }[item.id] || item.id);
    return item.available === false ? `${baseName} (실행기 비활성)` : baseName;
  };
  fill(cli, capabilities.map(item => [item.id, cliLabel(item)]), previous.cli);
  accounts(previous.accountId);
  referenceDirs.value = (previous.referenceDirs || []).join('\n');
  projectId.onchange = () => { versions(); populateProjectSessions(''); applyPickedSession(projectSessionPick, projSessionHint); };
  version.onchange = () => tasks();
  cli.onchange = () => accounts();
  sessionPick.onchange = () => applyPickedSession(sessionPick, sessionHint);
  projectSessionPick.onchange = () => applyPickedSession(projectSessionPick, projSessionHint);
  syncMode();

  return () => {
    const activePick = mode === 'project' ? sessionMap.get(projectSessionPick.value) : sessionMap.get(sessionPick.value);
    const sessionFields = activePick
      ? {
        ...(activePick.sessionId ? { sessionId: activePick.sessionId } : {}),
        ...(activePick.termId ? { termId: activePick.termId } : {}),
        ...(activePick.label ? { sessionLabel: activePick.label.slice(0, 140) } : {}),
      }
      : {};
    return {
      ...(mode === 'project'
        ? { projectId: projectId.value, version: version.value, taskId: taskId.value || null }
        : { cwd: cwd.value.trim() }),
      ...sessionFields,
      cli: cli.value, accountId: accountId.value,
      referenceDirs: referenceDirs.value.split(/\r?\n/).map(path => path.trim()).filter(Boolean),
      model: previous.model, effort: previous.effort,
    };
  };
}
