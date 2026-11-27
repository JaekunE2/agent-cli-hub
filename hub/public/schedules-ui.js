let stopSchedulesView = () => {};

function viewSchedules() {
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  setBar(`<h2>스케줄</h2><button type="button" class="primary" data-schedule-create disabled>스케줄 만들기</button>`);
  const view = $('#view');
  view.innerHTML = `<section class="schedules-page"><p role="status" data-schedule-error>스케줄 불러오는 중…</p>
    <p class="schedule-notice" data-schedule-note></p><div data-schedule-list></div></section>`;
  const list = $('[data-schedule-list]', view);
  const notice = $('[data-schedule-note]', view);
  const error = $('[data-schedule-error]', view);
  const create = $('[data-schedule-create]', $('#bar'));
  let items = [], capabilities = [];
  let history, editor, stopped, busy, refreshTask, queued;
  let filterState = 'all', filterQuery = '';
  const runKeys = new Map();

  const tick = () => {
    for (const time of list.querySelectorAll('time[datetime]')) {
      const seconds = Math.max(0, Math.ceil((Date.parse(time.dateTime) - Date.now()) / 1000));
      const days = Math.floor(seconds / 86400);
      const units = [Math.floor((seconds % 86400) / 3600), Math.floor(seconds / 60) % 60, seconds % 60];
      const hms = units.map(value => String(value).padStart(2, '0')).join(':');
      time.nextElementSibling.textContent = days > 0 ? `${days}일 ${hms} 남음` : `${hms} 남음`;
    }
  };
  const render = () => {
    const focused = document.activeElement;
    const prevSearch = focused?.matches('[data-sch-search]') ? focused.selectionStart : null;
    const filtered = items.filter((it) => {
      if (filterState === 'active' && it.state !== 'active') return false;
      if (filterState === 'paused' && it.state === 'active') return false;
      if (filterQuery) {
        const hay = `${it.name} ${it.target?.cwd || ''} ${it.target?.sessionLabel || ''} ${it.target?.cli || ''}`.toLowerCase();
        if (!hay.includes(filterQuery.toLowerCase())) return false;
      }
      return true;
    });
    const toolbar = items.length ? `<div class="schedule-toolbar">
      <div class="seg" role="tablist" aria-label="스케줄 상태 필터">
        <button type="button" data-sch-filt="all" class="${filterState === 'all' ? 'on' : ''}">전체 <span class="seg-cnt">${items.length}</span></button>
        <button type="button" data-sch-filt="active" class="${filterState === 'active' ? 'on' : ''}">활성 <span class="seg-cnt">${items.filter(x => x.state === 'active').length}</span></button>
        <button type="button" data-sch-filt="paused" class="${filterState === 'paused' ? 'on' : ''}">일시정지 <span class="seg-cnt">${items.filter(x => x.state !== 'active').length}</span></button>
      </div>
      <input type="search" class="btn-sm" data-sch-search placeholder="스케줄 이름 · 경로 검색…" value="${esc(filterQuery)}" aria-label="스케줄 검색">
    </div>` : '';
    list.innerHTML = toolbar + scheduleRows(filtered, capabilities, local, busy, state.projects, items.length > 0);
    const searchEl = $('[data-sch-search]', list);
    if (searchEl) {
      searchEl.oninput = (ev) => { filterQuery = ev.target.value; render(); };
      if (prevSearch !== null) { searchEl.focus({ preventScroll: true }); searchEl.setSelectionRange(prevSearch, prevSearch); }
    }
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
    const filtBtn = event.target.closest('[data-sch-filt]');
    if (filtBtn) { filterState = filtBtn.dataset.schFilt; render(); return; }
    if (event.target.closest('[data-schedule-create-inline]')) return edit();
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
    if (action === 'delete') {
      if (!confirm(`"${item.name}" 스케줄을 삭제(보관)할까요?`)) return;
      if (busy) return;
      busy = item.id;
      create.disabled = true;
      render();
      try {
        await scheduleRequest(schedulePath(item.id), { method: 'DELETE', body: { revision: item.revision } });
        toast('스케줄을 삭제했습니다.');
        await refresh();
      } catch (cause) {
        if (!stopped) error.textContent = cause.message;
      } finally {
        busy = null;
        if (!stopped) { render(); create.disabled = !local || !capabilities.length; }
      }
      return;
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

function formatScheduleCadence(trigger) {
  if (trigger.kind === 'interval') {
    const m = Number(trigger.everyMinutes || 0);
    if (m === 1440) return '매일 (24시간마다)';
    if (m >= 60 && m % 60 === 0) return `${m / 60}시간마다`;
    return `${m}분마다`;
  }
  const expr = String(trigger.expression || '').trim();
  const parts = expr.split(/\s+/);
  let human = expr;
  if (parts.length === 5 && /^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1]) && parts[2] === '*' && parts[3] === '*') {
    const hhmm = `${parts[1].padStart(2, '0')}:${parts[0].padStart(2, '0')}`;
    if (parts[4] === '*') human = `매일 ${hhmm} (${expr})`;
    else if (parts[4] === '1-5') human = `평일 ${hhmm} (${expr})`;
    else if (parts[4] === '0,6' || parts[4] === '6,0') human = `주말 ${hhmm} (${expr})`;
  }
  return `${human} · ${trigger.timeZone}`;
}

function scheduleRows(items, capabilities, local, busy, projects, hasAny = false) {
  if (!items.length) {
    if (hasAny) return '<div class="h-empty-card"><b>조건에 맞는 스케줄이 없습니다</b><span class="ums">필터나 검색어를 변경해 보세요.</span></div>';
    return `<div class="h-empty-card">
      <b>등록된 스케줄이 없습니다</b>
      <span class="ums">정기 점검, 리포트 생성, 빌드 확인 같은 반복 작업을 스케줄로 자동화해 보세요.</span>
      ${local && capabilities.length ? '<button type="button" class="primary btn-sm" data-schedule-create-inline>첫 스케줄 만들기</button>' : ''}
    </div>`;
  }
  return `<ul class="schedule-list">${items.map(item => {
    const active = item.state === 'active';
    const runner = capabilities.some(cli => cli.id === item.target.cli && cli.available);
    const noRunnerTip = !runner ? '현재 스케줄 실행기가 비활성 상태여서 실행할 수 없습니다.' : '';
    const button = (action, label, disabled = false, extraCls = '', title = '') => `<button type="button" class="${extraCls}" data-schedule-action="${action}"
      data-id="${esc(item.id)}" ${disabled ? 'disabled' : ''}${title ? ` title="${esc(title)}"` : ''}>${label}</button>`;
    const sessName = item.target.sessionLabel || (item.target.sessionId ? `세션 ${item.target.sessionId.slice(0, 8)}` : (item.target.termId ? `터미널 t:${item.target.termId}` : ''));
    const target = item.target.projectId
      ? `${projects.find(project => project.id === item.target.projectId)?.name || item.target.projectId} · ${item.target.version}${sessName ? ` · ${sessName}` : ''}`
      : (sessName ? `${sessName}${item.target.cwd ? ` (${base(item.target.cwd)})` : ''}` : (item.target.cwd || '일반 세션'));
    const cadence = formatScheduleCadence(item.trigger);
    return `<li class="schedule-card">
      <div class="schedule-row"><h3>${esc(item.name)}</h3>
        <span class="schedule-badge ${active ? 'ok' : 'warn'}">${active ? '활성' : '일시정지됨'}</span></div>
      <p class="schedule-target">${esc(target)} · <span class="badge">${esc(item.target.cli)}</span> · ${esc(cadence)}</p>
      <dl><div><dt>다음 실행</dt><dd>${item.nextRunAt
        ? `<time datetime="${esc(item.nextRunAt)}">${esc(scheduleDate(item.nextRunAt))}</time> <span class="schedule-countdown"></span>` : '—'}</dd></div>
        <div><dt>최근 실행 결과</dt><dd>${scheduleRunBadge(item.lastRun)}</dd></div></dl>
      <div class="schedule-row schedule-actions">
        ${local && typeof item.prompt === 'string' ? button('edit', '편집', Boolean(busy))
          + button(active ? 'pause' : 'resume', active ? '일시정지' : '재개', Boolean(busy) || (!active && !runner), '', !active ? noRunnerTip : '')
          + button('run', '즉시 실행', Boolean(busy) || !runner, '', noRunnerTip) : ''}
        ${button('history', '실행 이력')}
        ${local && typeof item.prompt === 'string' ? button('delete', '삭제', Boolean(busy), 'danger ghost sch-del-btn') : ''}
      </div></li>`;
  }).join('')}</ul>`;
}
