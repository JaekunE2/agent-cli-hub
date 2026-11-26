// Optional integrations in the UI (drives, Delta Hub, local web apps) + fault isolation.
// Loaded after app.js: it wraps renderSide() / select() so one broken panel (bad server data, a bug in one
// view) shows an inline error instead of taking the whole hub page down. The nav entries appear only when
// the server says the feature is configured (overview: drive / drives / delta / apps).
'use strict';

// ---------- fault isolation ----------
const uiErrSeen = new Map();
function uiErr(where, e) {
  console.error(`[ui] ${where}:`, e);
  const k = `${where}|${e && e.message}`, now = Date.now();
  if (now - (uiErrSeen.get(k) || 0) < 60000) return; // same error: at most one toast a minute
  uiErrSeen.set(k, now);
  try { toast(`⚠ ${where} 표시 중 오류 — 나머지는 계속 씁니다 (${(e && e.message) || e})`, 6000); } catch {}
}
function safeHTML(where, fn) {
  try { return fn() || ''; } catch (e) { uiErr(where, e); return `<div class="err">⚠ ${esc(where)}: 표시 오류 (${esc((e && e.message) || String(e))})</div>`; }
}
const safeMap = (where, list, fn) => (list || []).map((x) => { try { return fn(x); } catch (e) { uiErr(where, e); return ''; } });
window.uiErr = uiErr; window.safeHTML = safeHTML; window.safeMap = safeMap;
window.addEventListener('error', (ev) => { if (ev.error || ev.message) uiErr('화면', ev.error || ev.message); });
window.addEventListener('unhandledrejection', (ev) => uiErr('요청', ev.reason));

// sidebar: if the full sidebar throws, fall back to a minimal list so sessions can still be opened
(function guardSide() {
  if (typeof renderSide !== 'function') return;
  const inner = renderSide;
  renderSide = function renderSideGuarded() {
    try {
      inner();
      try { addIntegrationNav(); } catch (e) { uiErr('사이드바 연동 메뉴', e); }
    } catch (e) {
      uiErr('사이드바', e);
      const it = (key, title, sub) => `<div class="srow" data-key="${esc(key)}"><div class="srow-main"><div class="srow-t">${esc(title)}</div><div class="srow-s">${esc(sub || '')}</div></div></div>`;
      let h = `<div class="err">⚠ 사이드바 일부를 그리지 못해 간단 목록으로 보여 줍니다 (${esc(e.message)})</div>${it('home', '홈')}`;
      h += safeMap('세션', state.live || [], (s) => it(`session:${s.sessionId}`, s.name || s.sessionId.slice(0, 8), s.status)).join('');
      h += safeMap('터미널', state.terms || [], (t) => it(`term:${t.id}`, t.title || `t:${t.id}`, t.exited === null ? '실행 중' : '종료됨')).join('');
      const side = $('#side'); if (side) side.innerHTML = h;
    }
  };
})();

// views: drive / delta / app join the view map; any view that throws shows an inline error
(function guardSelect() {
  if (typeof select !== 'function') return;
  const inner = select;
  const extra = { drive: () => viewDrive(), delta: () => viewDelta(), app: () => viewApp() };
  select = function selectGuarded(sel, ...rest) {
    try {
      if (sel && extra[sel.kind]) {
        // let the original select() do its bookkeeping (state.sel, hash, sidebar) for an unknown kind, then draw ours
        inner(sel, ...rest);
        const r = extra[sel.kind]();
        if (r && typeof r.catch === 'function') r.catch((e) => uiErr('화면', e));
        return r;
      }
      const r = inner(sel, ...rest);
      if (r && typeof r.catch === 'function') r.catch((e) => uiErr('화면', e));
      return r;
    } catch (e) {
      uiErr('화면', e);
      const v = $('#view');
      if (v) v.innerHTML = `<div class="err" style="padding:16px">⚠ 이 화면을 여는 중 오류가 났습니다: ${esc(e.message)}<br>왼쪽에서 다른 항목은 그대로 열 수 있습니다.</div>`;
    }
  };
})();

// ---------- sidebar entries for the configured integrations ----------
function addIntegrationNav() {
  const nav = $('#side .snav');
  if (!nav || nav.querySelector('[data-integ]')) return;
  const cur = state.sel || {};
  const btn = (key, icon, label, sel) => `<button type="button" class="snav-item${sel ? ' sel' : ''}" data-key="${esc(key)}" data-integ="1"><span class="snav-ico" aria-hidden="true">${icon}</span><span class="snav-lbl">${esc(label)}</span></button>`;
  let h = '';
  if (state.drive || (state.drives || []).length) h += btn('drive', '📁', '드라이브', cur.kind === 'drive');
  if (state.delta) h += btn('delta', '🛰', 'Delta Hub', cur.kind === 'delta');
  for (const a of (Array.isArray(state.appList) ? state.appList : [])) h += btn(`app:${a.id}`, a.icon || '🧩', a.label || a.id, cur.kind === 'app' && cur.id === a.id);
  if (h) nav.insertAdjacentHTML('beforeend', h);
}
$('#side')?.addEventListener('click', (e) => {
  const it = e.target.closest('[data-integ]');
  if (!it) return;
  const k = it.dataset.key;
  if (k === 'drive' || k === 'delta') { e.stopImmediatePropagation(); select({ kind: k }); }
}, true);

// ---------- Delta Hub ----------
async function viewDelta() {
  const gen = viewGen;
  setBar('<h2>🛰 Delta Hub</h2><span class="sp"></span>');
  $('#bar').onclick = null;
  const v = $('#view');
  v.onclick = null;
  v.innerHTML = '<div class="empty" style="padding:20px">확인 중…</div>';
  const st = await api('/api/delta/status').catch((e) => ({ error: e.message }));
  if (gen !== viewGen) return;
  if (st.configured === false) { v.innerHTML = '<div class="empty" style="padding:20px">Delta Hub가 설정되지 않았습니다 (config.json "delta": {"portal", "hub"}).</div>'; return; }
  if (st.loggedIn) return deltaWorkspace(st);
  v.innerHTML = `<div class="rwrap"><div class="rcard" style="max-width:460px"><b>Delta Hub 로그인 (처음 한 번)</b>
    <div class="empty" style="padding:0">Deltascale 포털에 이 허브가 대신 로그인합니다. <b>비밀번호는 저장하지 않고</b>, 로그인 세션만 이 PC의 비밀 폴더(config secretsDir)에 남깁니다.</div>
    ${st.user ? '<div class="err">저장된 세션이 만료되었습니다 — 다시 로그인하세요.</div>' : ''}
    <label>사용자 이름<br><input id="dlU" value="${esc(st.user || '')}" autocomplete="off" style="width:100%"></label>
    <label>비밀번호<br><input id="dlP" type="password" autocomplete="off" style="width:100%"></label>
    <label>인증 앱 코드 (6자리)<br><input id="dlC" inputmode="numeric" autocomplete="one-time-code" style="width:100%"></label>
    <div class="row" style="justify-content:flex-end"><button class="primary" id="dlGo">로그인</button></div></div></div>`;
  $('#dlGo').onclick = async () => {
    $('#dlGo').disabled = true;
    const r = await api('/api/delta/login', { method: 'POST', body: { user: $('#dlU').value.trim(), password: $('#dlP').value, code: $('#dlC').value } }).catch((e) => ({ error: e.message }));
    $('#dlP').value = '';
    if (r.error || !r.loggedIn) { $('#dlGo').disabled = false; return toast(r.error || '로그인은 됐지만 허브 접속을 확인하지 못했습니다', 8000); }
    toast('Delta Hub에 연결했습니다'); viewDelta();
  };
}

// ---------- local web apps (config "apps"), embedded through the hub: /app-<id>/<token>/ ----------
function viewApp() {
  const list = Array.isArray(state.appList) ? state.appList : [];
  const a = list.find((x) => x.id === state.sel.id) || { id: state.sel.id, label: state.sel.id };
  const src = `/app-${encodeURIComponent(a.id)}/${encodeURIComponent(TOKEN)}/`;
  setBar(`<h2>${esc(a.icon || '🧩')} ${esc(a.label)}</h2><span class="sp"></span><a class="btnlike" href="${src}" target="_blank" rel="noopener" title="새 탭에서 크게">새 탭</a>`);
  const v = $('#view'); v.onclick = null;
  v.innerHTML = `<iframe src="${src}" title="${esc(a.label)}" style="width:100%;height:100%;border:0;display:block;background:transparent"></iframe>`;
}

// app list (labels/icons) once at start, only when the server has apps configured
setTimeout(function loadApps() {
  if (!state.webApps) return void setTimeout(loadApps, 3000);
  api('/api/webapps').then((r) => { state.appList = r.apps || []; renderSide(); }).catch((e) => uiErr('앱 목록', e));
}, 1500);

// ?open=drive | drive:<id> | delta | app:<id> (links from the phone app / notifications)
(function openFromQuery() {
  const open = new URLSearchParams(location.search).get('open') || '';
  const go = () => {
    if (open === 'drive') select({ kind: 'drive' });
    else if (open.startsWith('drive:')) select({ kind: 'drive', id: open.slice(6) });
    else if (open === 'delta') select({ kind: 'delta' });
    else if (open.startsWith('app:')) select({ kind: 'app', id: open.slice(4) });
  };
  if (/^(drive|delta|app:)/.test(open)) setTimeout(go, 800);
})();
