let stopSchedulesView = () => {};

function viewSchedules() {
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  setBar(`<h2>스케줄</h2><button type="button" class="primary" data-schedule-create disabled>스케줄 만들기</button>`);
  const view = $('#view');
  view.innerHTML = `<section class="schedules-page"><p role="status" data-schedule-error>스케줄 불러오는 중…</p>
    <p data-schedule-note></p><div data-schedule-list></div></section>`;
  const list = $('[data-schedule-list]', view);
  const notice = $('[data-schedule-note]', view);
  const error = $('[data-schedule-error]', view);
  const create = $('[data-schedule-create]', $('#bar'));
  let items = [], capabilities = [];
  let history, editor, stopped, busy, refreshTask, queued;
  const runKeys = new Map();

  const tick = () => {
    for (const time of list.querySelectorAll('time[datetime]')) {
      const seconds = Math.max(0, Math.ceil((Date.parse(time.dateTime) - Date.now()) / 1000));
      const units = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60];
      time.nextElementSibling.textContent = units.map(value => String(value).padStart(2, '0')).join(':');
    }
  };
  const render = () => {
    const focused = document.activeElement;
    list.innerHTML = scheduleRows(items, capabilities, local, busy, state.projects);
    if (focused?.matches('[data-schedule-action]')) {
      focusAction(focused.dataset.id, focused.dataset.scheduleAction);
    }
    tick();
  };
  const focusAction = (id, action) => {
    const row = `[data-id="${CSS.escape(id)}"]`;
    (list.querySelector(`${row}[data-schedule-action="${action}"]:not(:disabled)`)
      || list.querySelector(`${row}[data-schedule-action="history"]`))?.focus({ preventScroll: true });
  };

  function refresh() {
    if (stopped) return;
    queued = true;
    refreshTask ??= (async () => {
      while (!stopped && queued) {
        queued = false;
        try {
          const result = await scheduleRequest();
          if (stopped) break;
          items = result.items;
          capabilities = result.capabilities.cli;
          create.disabled = !local || !capabilities.length || Boolean(busy);
          notice.textContent = !local ? '원격 접속에서는 스케줄과 이력을 볼 수 있습니다.'
            : capabilities.some(cli => cli.available) ? '' : '스케줄 실행기를 사용할 수 없습니다.';
          render();
          notice.hidden = !notice.textContent;
          error.textContent = '';
          await history?.load();
        } catch (cause) {
          if (!stopped) error.textContent = cause.message;
        }
      }
    })().finally(() => { refreshTask = null; });
    return refreshTask;
  }

  const edit = async item => {
    try {
      const { projects } = await api('/api/projects', { requireOk: true });
      if (stopped) return;
      editor?.close();
      history?.close();
      editor = openScheduleForm({ item, projects, capabilities, onSaved: refresh, onClose: () => { editor = null; } });
    } catch (cause) { if (!stopped) error.textContent = cause.message; }
  };

  create.onclick = () => edit();
  list.onclick = async event => {
    const button = event.target.closest('[data-schedule-action]');
    const item = items.find(row => row.id === button?.dataset.id);
    if (!item) return;
    const { scheduleAction: action } = button.dataset;
    if (action === 'edit') return edit(item);
    if (action === 'history') {
      history?.close();
      history = openScheduleHistory(item, () => {
        history = null;
        if (!stopped) focusAction(item.id, 'history');
      });
      return history.load();
    }
    if (busy) return;
    busy = item.id;
    create.disabled = true;
    render();
    const body = { revision: item.revision };
    if (action === 'run') {
      if (!runKeys.has(item.id)) runKeys.set(item.id, crypto.randomUUID());
      body.requestId = runKeys.get(item.id);
    }
    let failure;
    try {
      await scheduleRequest(schedulePath(item.id) + '/' + action, { method: 'POST', body });
      runKeys.delete(item.id);
      await refresh();
    } catch (cause) {
      if (cause.code && cause.code !== 'SCHEDULE_UNAVAILABLE') runKeys.delete(item.id);
      failure = cause.message;
      if (cause.code === 'SCHEDULE_CONFLICT') await refresh();
    } finally {
      busy = null;
      if (!stopped) {
        render();
        create.disabled = !local || !capabilities.length;
        if (failure) error.textContent = failure;
        if (document.activeElement === document.body || list.contains(document.activeElement)) focusAction(item.id, action);
      }
    }
  };
  const stop = watchSchedules(refresh);
  void refresh();
  const clock = setInterval(tick, 1000);
  stopSchedulesView = () => {
    stopped = true;
    stop();
    clearInterval(clock);
    history?.close();
    editor?.close();
    stopSchedulesView = () => {};
  };
}

function scheduleRows(items, capabilities, local, busy, projects) {
  if (!items.length) return '<p>등록된 스케줄이 없습니다.</p>';
  return `<ul class="schedule-list">${items.map(item => {
    const active = item.state === 'active';
    const runner = capabilities.some(cli => cli.id === item.target.cli && cli.available);
    const button = (action, label, disabled = false) => `<button type="button" data-schedule-action="${action}"
      data-id="${esc(item.id)}" ${disabled ? 'disabled' : ''}>${label}</button>`;
    const target = item.target.projectId
      ? `${projects.find(project => project.id === item.target.projectId)?.name || item.target.projectId} · ${item.target.version}`
      : (item.target.cwd || '일반 세션');
    const cadence = item.trigger.kind === 'interval'
      ? '{minutes}분마다'.replace('{minutes}', item.trigger.everyMinutes)
      : `${item.trigger.expression} · ${item.trigger.timeZone}`;
    return `<li class="schedule-card">
      <div class="schedule-row"><h3>${esc(item.name)}</h3>
        <span class="schedule-badge ${active ? 'ok' : 'warn'}">${active ? '활성' : '일시정지됨'}</span></div>
      <p class="schedule-target">${esc(target)} · ${esc(item.target.cli)} · ${esc(cadence)}</p>
      <dl><div><dt>다음 실행</dt><dd>${item.nextRunAt
        ? `<time datetime="${esc(item.nextRunAt)}">${esc(scheduleDate(item.nextRunAt))}</time> <span class="schedule-countdown"></span>` : '—'}</dd></div>
        <div><dt>최근 실행 결과</dt><dd>${scheduleRunBadge(item.lastRun)}</dd></div></dl>
      <div class="schedule-row schedule-actions">
        ${local && typeof item.prompt === 'string' ? button('edit', '편집', Boolean(busy))
          + button(active ? 'pause' : 'resume', active ? '일시정지' : '재개', Boolean(busy) || (!active && !runner))
          + button('run', '즉시 실행', Boolean(busy) || !runner) : ''}
        ${button('history', '실행 이력')}
      </div></li>`;
  }).join('')}</ul>`;
}
