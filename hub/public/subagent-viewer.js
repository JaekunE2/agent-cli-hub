function openSubagentViewerModal(query, item) {
  const dialog = document.createElement('dialog');
  dialog.className = 'pj-dialog ts-subagent-viewer';
  const title = '서브에이전트 뷰어';
  dialog.setAttribute('aria-label', title);
  dialog.innerHTML = `<div class="dlg-head"><h3>${title} · ${esc(item.name || item.tool)}</h3>
    <button type="button" class="ghost icon-btn btn-sm" aria-label="닫기">${ICO.close || '✕'}</button></div>
    <p data-ts-status></p><h4>프롬프트</h4><pre data-ts-prompt></pre>
    <h4>도구 호출 내역</h4><ol data-ts-events></ol><h4>최근 출력</h4><pre data-ts-output></pre>`;
  document.body.append(dialog);
  dialog.querySelector('button').onclick = () => dialog.close();
  const detail = new URLSearchParams(query);
  detail.set('id', item.id);
  let pending = false, previous = '';
  const write = (selector, value) => { dialog.querySelector(selector).textContent = value || '—'; };
  async function refresh() {
    if (pending) return;
    pending = true;
    try {
      const data = await api(`/api/session/subagent-detail?${detail}`, { requireOk: true });
      const key = JSON.stringify(data);
      if (key === previous) return;
      previous = key;
      write('[data-ts-status]', { running: '실행 중', done: '완료', stopped: '중단' }[data.status]);
      write('[data-ts-prompt]', data.prompt);
      write('[data-ts-output]', data.lastMessage);
      const calls = new Map();
      dialog.querySelector('ol').replaceChildren(...data.events.map(event => {
        if (event.type === 'call') calls.set(event.id, event.tool);
        const li = document.createElement('li');
        const pre = document.createElement('pre');
        const value = event.type === 'call' ? event.input : event.output;
        pre.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2) || '';
        const label = event.type === 'call' ? '호출' : '결과';
        li.append(`${label} · ${event.tool || calls.get(event.id) || event.id || ''}`, pre);
        return li;
      }));
    } catch (error) {
      previous = '';
      write('[data-ts-status]', error.message);
    } finally { pending = false; }
  }
  const timer = setInterval(refresh, 1000);
  dialog.onclose = () => { clearInterval(timer); dialog.remove(); };
  dialog.showModal();
  refresh();
}
