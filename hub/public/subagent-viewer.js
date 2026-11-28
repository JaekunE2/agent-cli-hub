function openSubagentViewerModal(query, item) {
  const dialog = document.createElement('dialog');
  dialog.className = 'pj-dialog ts-subagent-viewer';
  const title = '서브에이전트 뷰어';
  dialog.setAttribute('aria-label', title);
  dialog.innerHTML = `<div class="dlg-head"><h3>${title} · ${esc(item.name || item.tool)}</h3>
    <button type="button" class="ghost icon-btn btn-sm" aria-label="닫기">${ICO.close || '✕'}</button></div>
    <p data-ts-status>불러오는 중…</p><h4>프롬프트</h4><pre data-ts-prompt>불러오는 중…</pre>
    <h4>도구 호출 내역</h4><ol data-ts-events></ol><p class="ums" data-ts-events-empty hidden>기록된 도구 호출이 없습니다.</p><h4>최근 출력</h4><pre data-ts-output>—</pre>`;
  document.body.append(dialog);
  dialog.querySelector('button').onclick = () => dialog.close();
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
  const detail = new URLSearchParams(query);
  detail.set('id', item.id);
  const request = new AbortController();
  let pending = false, refreshQueued = false, previous = '', renderedEventCount = 0;
  const calls = new Map();
  const write = (selector, value) => { dialog.querySelector(selector).textContent = value || '—'; };
  async function refresh(afterHook = false) {
    if (!dialog.open || request.signal.aborted) return;
    if (pending) {
      refreshQueued ||= afterHook;
      return;
    }
    pending = true;
    try {
      const data = await api(`/api/session/subagent-detail?${detail}`, { requireOk: true, signal: request.signal });
      if (!dialog.open || request.signal.aborted || refreshQueued) return;
      const key = JSON.stringify(data);
      if (key === previous) return;
      previous = key;
      write('[data-ts-status]', { running: '실행 중', done: '완료', stopped: '중단' }[data.status] || data.status);
      write('[data-ts-prompt]', data.prompt);
      write('[data-ts-output]', data.lastMessage);
      const events = Array.isArray(data.events) ? data.events : [];
      const ol = dialog.querySelector('ol');
      const emptyEl = dialog.querySelector('[data-ts-events-empty]');
      if (emptyEl) emptyEl.hidden = events.length > 0;
      if (events.length < renderedEventCount) { ol.replaceChildren(); calls.clear(); renderedEventCount = 0; }
      for (let i = renderedEventCount; i < events.length; i++) {
        const event = events[i];
        const isTool = event.type === 'tool';
        if (isTool) calls.set(event.id, event.tool);
        const li = document.createElement('li');
        const label = `${isTool ? '호출' : '결과'} · ${event.tool || calls.get(event.id) || event.id || ''}`;
        const text = event.text || '';
        if (text.length > 240) {
          const det = document.createElement('details');
          const sum = document.createElement('summary');
          sum.textContent = `${label} (${text.length}자)`;
          const pre = document.createElement('pre');
          pre.textContent = text;
          det.append(sum, pre);
          li.append(det);
        } else {
          const pre = document.createElement('pre');
          pre.textContent = text;
          li.append(label, pre);
        }
        ol.append(li);
      }
      renderedEventCount = events.length;
    } catch (error) {
      if (dialog.open && !request.signal.aborted && !refreshQueued) {
        previous = '';
        write('[data-ts-status]', error.message);
      }
    } finally {
      pending = false;
      if (refreshQueued) {
        refreshQueued = false;
        void refresh();
      }
    }
  }
  const timer = setInterval(refresh, 1000);
  dialog.addEventListener('hook-event', () => refresh(true));
  dialog.onclose = () => { clearInterval(timer); request.abort(); dialog.remove(); };
  dialog.showModal();
  refresh();
  return dialog;
}
