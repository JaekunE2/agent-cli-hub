function scheduleRunBadge(run) {
  if (!run) return '—';
  const labels = {
    queued: '대기 중', starting: '시작 중', running: '실행 중', succeeded: '성공',
    failed: '실패', skipped: '건너뜀', cancelled: '취소됨', interrupted: '중단됨',
  };
  const status = run.reason === 'WORKER_UNCERTAIN' ? '실행 확인 필요' : labels[run.status] || run.status;
  const tone = { succeeded: 'ok', failed: 'danger', interrupted: 'danger', running: 'ok' }[run.status] || 'warn';
  return `<span class="schedule-badge ${tone}">${esc(status)}</span>`;
}

function openScheduleHistory(item, onClose) {
  let generation = 0;
  let pages = 1;
  const drawer = openDrawer({
    title: '실행 이력',
    focus: true,
    onClose,
    bodyHTML: `<h3>${esc(item.name)}</h3><p role="status" data-run-error></p>
      <ol class="schedule-runs" aria-label="실행 이력"></ol><p data-run-empty hidden>아직 실행 이력이 없습니다.</p>
      <button type="button" data-run-more hidden>이전 실행 더 보기</button>`,
  });
  const error = $('[data-run-error]', drawer);
  const more = $('[data-run-more]', drawer);
  async function load() {
    const current = ++generation;
    const rows = [];
    let cursor;
    let seq;
    more.disabled = true;
    try {
      for (let i = 0; i < pages; i++) {
        const query = new URLSearchParams({ limit: 50 });
        if (cursor) query.set('before', cursor);
        const page = await scheduleRequest(schedulePath(item.id) + '/runs?' + query);
        if (!drawer.isConnected || generation !== current) return;
        seq ??= page.seq;
        rows.push(...page.items);
        cursor = page.nextCursor;
        if (!cursor) break;
      }
      error.textContent = '';
      $('[data-run-empty]', drawer).hidden = rows.length > 0;
      const list = $('.schedule-runs', drawer);
      list.innerHTML = [...new Map(rows.map(row => [row.id, row])).values()].map(scheduleRunRow).join('');
      more.hidden = !cursor;
      return seq;
    } catch (cause) {
      if (generation === current) error.textContent = cause.message;
    } finally {
      if (generation === current) more.disabled = false;
    }
  }
  more.onclick = () => { pages++; void load(); };
  return { close: drawer.close, load };
}

function scheduleRunRow(run) {
  const summary = [run.outputSummary, run.errorSummary].filter(Boolean)
    .map(text => `<pre>${esc(text)}</pre>`).join('');
  const sessionLink = run.sessionId && recentSession(run.sessionId)
    ? `<a href="#recent:${encodeURIComponent(run.sessionId)}:chat" data-schedule-session="${esc(run.sessionId)}">대화 열기</a>` : '';
  return `<li><div class="schedule-row">
    <strong>${run.trigger === 'manual' ? '즉시 실행' : '예약 실행'}</strong>
    ${scheduleRunBadge(run)} <time>${esc(scheduleDate(run.startedAt || run.createdAt))}</time>
    </div>${run.reason ? `<p><code>${esc(run.reason)}</code></p>` : ''}${summary}${sessionLink}</li>`;
}

document.addEventListener('click', event => {
  const link = event.target.closest('[data-schedule-session]');
  if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  select({ kind: 'recent', id: link.dataset.scheduleSession }, 'chat');
});
