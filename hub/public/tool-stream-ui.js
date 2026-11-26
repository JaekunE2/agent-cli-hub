let unmountSubagents;
let positionSubagents;

function mountSubagents(bar, params) {
  const host = document.createElement('div');
  host.className = 'ts-subagent-control';
  host.innerHTML = `<button type="button" class="ts-pill ghost btn-sm" data-ts-subagents aria-expanded="false">
    <span class="dot busy" hidden></span><span data-ts-count aria-live="polite">서브에이전트</span></button>
    <div class="ts-subagent-list" hidden></div>`;
  bar.append(host);
  const button = host.querySelector('button');
  const counter = button.querySelector('[data-ts-count]');
  const list = host.querySelector('.ts-subagent-list');
  const query = new URLSearchParams(Object.entries(params).filter(([, value]) => value));
  const request = new AbortController();
  let viewer;
  positionSubagents = () => {
    const toolboxes = document.querySelectorAll('#view [data-ts-bar] .ts-right');
    const toolbox = [...toolboxes].find(element => element.getClientRects().length);
    const target = toolbox || bar;
    if (host.parentElement !== target) target.append(host);
  };
  let items = [], pending = false, failure = '';
  let refreshQueued = false;
  const label = '서브에이전트';
  function paint() {
    const running = items.filter(item => item.status === 'running');
    const history = items.filter(item => item.status !== 'running');
    button.classList.toggle('busy', !!running.length);
    button.querySelector('.dot').hidden = !running.length;
    const count = items.length ? `${label} ${running.length || items.length}` : label;
    if (counter.textContent !== count) counter.textContent = count;
    if (list.hidden) return;
    const group = (title, entries) => entries.length ? `<h3>${title}</h3>${entries.map(item => {
      const opensSession = item.targetTermId || item.targetSessionId;
      const action = opensSession ? '세션 열기' : '뷰어 열기';
      const elapsed = Math.max(0, (item.finishedAt || Date.now()) - item.startedAt);
      const unit = elapsed < 60_000 ? 'second' : elapsed < 3_600_000 ? 'minute' : 'hour';
      const duration = new Intl.NumberFormat(uiLocale(), { style: 'unit', unit }).format(Math.floor(elapsed / { second: 1000, minute: 60_000, hour: 3_600_000 }[unit]));
      return `<button type="button" data-ts-item="${esc(item.id)}" title="${action}">
        <span><strong>${esc(item.name || item.tool)}</strong> · ${esc(providerName(item.agent))}
        <small>${esc(item.description || '')}</small></span>
        <span>${item.startedAt ? esc(duration) : ''} ${opensSession ? '↗' : '›'}</span>
      </button>`;
    }).join('')}` : '';
    const focused = document.activeElement?.dataset.tsItem;
    list.innerHTML = failure ? `<p role="alert">${esc(failure)}</p>`
      : group('실행 중', running) + group('최근 완료/중단', history) || '<p>서브에이전트 기록이 없습니다.</p>';
    if (focused) [...list.querySelectorAll('button')].find(b => b.dataset.tsItem === focused)?.focus();
  }
  async function refresh(afterHook = false) {
    if (request.signal.aborted) return;
    if (pending) {
      refreshQueued ||= afterHook;
      return;
    }
    pending = true;
    try {
      const data = await api(`/api/session/subagents?${query}`, { requireOk: true, signal: request.signal });
      if (request.signal.aborted || refreshQueued) return;
      items = Array.isArray(data) ? data : data.subagents || [];
      failure = '';
    } catch (error) {
      if (!request.signal.aborted && !refreshQueued) failure = error.message;
    } finally {
      pending = false;
      if (!request.signal.aborted) {
        if (refreshQueued) {
          refreshQueued = false;
          void refresh();
        } else {
          positionSubagents();
          paint();
        }
      }
    }
  }
  function close() {
    list.hidden = true;
    button.setAttribute('aria-expanded', 'false');
  }
  button.onclick = () => {
    if (!list.hidden) return close();
    list.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    paint();
    refresh();
  };
  list.onclick = event => {
    const item = items.find(x => x.id === event.target.closest('[data-ts-item]')?.dataset.tsItem);
    if (!item) return;
    close();
    if (item.targetTermId) return select({ kind: 'term', id: item.targetTermId });
    if (item.targetSessionId) return select({ kind: 'recent', id: item.targetSessionId }, 'chat');
    viewer = openSubagentViewerModal(query, item);
  };
  function outside(event) { if (!host.contains(event.target)) close(); }
  document.addEventListener('pointerdown', outside);
  host.onkeydown = event => {
    if (event.key === 'Escape' && !list.hidden) { close(); button.focus(); }
  };
  const socketUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/hooks?t=${encodeURIComponent(TOKEN)}`;
  let ws, reconnectTimer;
  function refreshFromHook() {
    if (request.signal.aborted) return;
    void refresh(true);
    if (viewer?.open) viewer.dispatchEvent(new Event('hook-event'));
  }
  function connect(reconnecting = false) {
    ws = new WebSocket(socketUrl);
    ws.onopen = () => { if (reconnecting) refreshFromHook(); };
    ws.onmessage = ({ data }) => {
      let event;
      try { event = JSON.parse(data); } catch { return; }
      if (event?.type !== 'hook-event') return;
      if ((event.termId && params.termId && String(event.termId) === String(params.termId))
        || (event.sessionId && params.sessionId && event.sessionId === params.sessionId)) refreshFromHook();
    };
    ws.onclose = () => {
      if (!request.signal.aborted) reconnectTimer = setTimeout(() => connect(true), 1000);
    };
  }
  connect();
  const timer = setInterval(refresh, 1000);
  unmountSubagents = () => {
    document.removeEventListener('pointerdown', outside);
    clearInterval(timer);
    clearTimeout(reconnectTimer);
    request.abort();
    viewer?.close();
    host.remove();
    positionSubagents = null;
    if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) ws.close();
    unmountSubagents = null;
  };
  refresh();
}
