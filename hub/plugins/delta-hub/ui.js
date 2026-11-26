// Delta Hub plugin UI: sidebar entry, login view; once logged in delta.js draws the workspace.
'use strict';
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
HubPlugins.register({
  id: 'delta-hub',
  nav: [{ key: 'delta', icon: '🛰', label: 'Delta Hub', when: () => !!state.delta }],
  views: { delta: () => viewDelta() },
  open(param) {
    if (param !== 'delta') return false;
    const s = new URLSearchParams(location.search).get('dsession');
    if (s) DH.session = s;
    select({ kind: 'delta' });
    return true;
  },
});
