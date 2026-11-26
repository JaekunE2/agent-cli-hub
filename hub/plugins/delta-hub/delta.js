// Delta Hub (a team's AI Control Hub, config "delta") inside the dashboard: projects and sessions, a session's
// conversation (user requests / AI answers / state), send a request, stop, start a new session.
// Talks to /api/delta/hub/<path> → the hub's /hub-api/<path> with the session saved by the login screen.
'use strict';
const DH = { project: null, session: null, after: 0, events: [], snap: null, timer: null };
const dhApi = (p, body) => api('/api/delta/hub/' + p, body ? { method: 'POST', body } : {});
const DH_STATE = { running: ['실행 중', 'busy'], completed: ['완료', 'idle'], interrupted: ['중단됨', ''], idle: ['대기', 'idle'], failed: ['실패', 'busy'], queued: ['대기열', 'busy'] };

async function deltaWorkspace(st) {
  const gen = viewGen;
  DH.defaultProject = st.defaultProject || '';
  setBar(`<h2>🛰 Delta Hub</h2><span class="empty">${esc(st.user || '')}</span><span class="sp"></span>
    <button id="dhNew">＋ 새 작업</button>${st.uiPort && /^(127\.0\.0\.1|localhost)$/.test(location.hostname) ? `<a class="btnlike primary" href="http://127.0.0.1:${st.uiPort}/?k=${encodeURIComponent(TOKEN)}" target="_blank" rel="noopener" title="대시보드에 저장된 로그인으로 Delta Hub 화면을 바로 열기">로그인된 허브 열기</a>` : ''}<a class="btnlike" href="${esc(st.hub || '#')}/" target="_blank" rel="noopener" title="Delta 사이트 (따로 로그인 필요)">Delta에서 열기</a><button id="dhOut" title="저장된 Delta 세션 지우기">연결 해제</button>`);
  $('#bar').onclick = async (e) => {
    if (e.target.id === 'dhOut') { await api('/api/delta/logout', { method: 'POST', body: {} }); return viewDelta(); }
    if (e.target.id === 'dhNew') return dhNewDialog();
  };
  const v = $('#view');
  v.innerHTML = `<div class="dhwrap"><div class="dhside" id="dhSide">불러오는 중…</div><div class="dhmain" id="dhMain"><div class="empty" style="padding:20px">왼쪽에서 세션을 고르세요.</div></div></div>`;
  v.onclick = dhClick;
  await dhLoad(gen);
  clearInterval(DH.timer);
  DH.timer = setInterval(() => { if (gen !== viewGen) return clearInterval(DH.timer); if (!document.hidden) dhLoad(gen, true); }, 4000);
}

async function dhLoad(gen, quiet) {
  let snap;
  try { snap = await dhApi('snapshot?scope=selected&archived=1' + (DH.session ? `&session_id=${encodeURIComponent(DH.session)}&after=${DH.after}` : '')); }
  catch (e) { if (!quiet) $('#dhSide').innerHTML = `<div class="err">${esc(e.message)}</div>`; if (/만료|로그인/.test(e.message)) viewDelta(); return; }
  if (gen !== viewGen) return;
  if (snap && snap.error) { if (snap.relogin) return viewDelta(); if (!quiet) $('#dhSide').innerHTML = `<div class="err">${esc(snap.error)}</div>`; return; }
  DH.snap = snap;
  // side: projects → sessions
  const sessions = (snap.sessions || []).slice().sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  const byProj = new Map();
  for (const s of sessions) { if (!byProj.has(s.project_id)) byProj.set(s.project_id, []); byProj.get(s.project_id).push(s); }
  $('#dhSide').innerHTML = (snap.projects || []).map((p) => {
    const list = byProj.get(p.id) || [];
    return `<div class="dhproj"><b title="${esc(p.path || '')}">📁 ${esc(p.name)}</b> <span class="empty">${list.length}</span>
      ${list.map((s) => { const [lab, dot] = DH_STATE[s.state] || [s.state, '']; return `<div class="item${s.id === DH.session ? ' sel' : ''}" data-dhs="${esc(s.id)}"><span class="dot ${dot}"></span><div class="body"><div class="t">${esc(s.title || '(제목 없음)')}</div><div class="s">${esc(lab)} · ${esc(relTime(Date.parse(s.updated_at)))}${s.archived ? ' · 보관' : ''}</div></div></div>`; }).join('') || '<div class="empty" style="padding:2px 8px">세션 없음</div>'}</div>`;
  }).join('') + `<div class="empty" style="padding:8px 4px">계정: ${(snap.accounts || []).filter((a) => a.active).map((a) => esc(a.label)).join(' · ') || '-'}</div>`;
  // main: the selected session's conversation (incremental)
  if (!DH.session) return;
  if (snap.event_scope && snap.event_scope.session_id === DH.session) {
    const fresh = (snap.events || []).filter((e) => e.seq > DH.after);
    if (fresh.length) { DH.events.push(...fresh); DH.after = snap.event_scope.cursor || Math.max(...fresh.map((e) => e.seq)); }
  }
  dhPaintSession();
}

function dhPaintSession() {
  const s = (DH.snap?.sessions || []).find((x) => x.id === DH.session);
  if (!s) return;
  const main = $('#dhMain');
  const keepBottom = !main.querySelector('.dhlog') || main.querySelector('.dhlog').scrollHeight - main.querySelector('.dhlog').scrollTop - main.querySelector('.dhlog').clientHeight < 60;
  const draft = $('#dhIn')?.value || '';
  const [lab] = DH_STATE[s.state] || [s.state];
  const rows = [];
  for (const e of DH.events) {
    if (e.kind === 'user') rows.push(`<div class="dhu">${esc(e.text)}</div>`);
    else if (e.kind === 'delta' || e.kind === 'assistant') {
      const last = rows[rows.length - 1];
      if (last && last.startsWith('<div class="dha" data-raw')) { const raw = decodeURIComponent(last.match(/data-raw="([^"]*)"/)[1]) + e.text; rows[rows.length - 1] = `<div class="dha" data-raw="${encodeURIComponent(raw)}">${md(raw)}</div>`; }
      else rows.push(`<div class="dha" data-raw="${encodeURIComponent(e.text)}">${md(e.text)}</div>`);
    } else if (e.kind === 'request_state') { try { const j = JSON.parse(e.text); if (j.state && j.state !== 'running') rows.push(`<div class="dhs">— ${esc(DH_STATE[j.state]?.[0] || j.state)}${j.failure_kind ? ' · ' + esc(j.failure_kind) : ''} —</div>`); } catch {} }
    else if ((e.kind === 'system' || e.kind === 'error') && !/\{"/.test(e.text)) rows.push(`<div class="dhs">${esc(String(e.text).slice(0, 300))}</div>`); // skip telemetry dumps
  }
  const running = s.state === 'running' || s.state === 'queued';
  main.innerHTML = `<div class="dhhead"><b>${esc(s.title || '(제목 없음)')}</b> <span class="pill">${esc(lab)}</span> <span class="empty">${esc(s.profile_id || '')}</span></div>
    <div class="dhlog">${rows.join('') || '<div class="empty">대화가 없습니다</div>'}</div>
    <div class="dhcomp"><textarea id="dhIn" rows="3" placeholder="${running ? '실행 중 — 보내면 대기열에 넣습니다' : '이 세션에 보낼 요청'}">${esc(draft)}</textarea>
      <div class="row" style="justify-content:flex-end">${running ? '<button id="dhStop">■ 중단</button>' : ''}<button class="primary" id="dhSend">${running ? '대기열에 추가' : '보내기'}</button></div></div>`;
  const log = main.querySelector('.dhlog');
  if (keepBottom) log.scrollTop = log.scrollHeight;
}

async function dhClick(e) {
  const it = e.target.closest('[data-dhs]');
  if (it) { DH.session = it.dataset.dhs; DH.after = 0; DH.events = []; $('#dhMain').innerHTML = '<div class="empty" style="padding:20px">불러오는 중…</div>'; return dhLoad(viewGen); }
  const s = (DH.snap?.sessions || []).find((x) => x.id === DH.session);
  if (!s) return;
  try {
    if (e.target.id === 'dhSend') {
      const prompt = $('#dhIn').value.trim(); if (!prompt) return;
      e.target.disabled = true;
      const running = s.state === 'running' || s.state === 'queued';
      const r = await dhApi(running ? 'queueadd' : 'run', { session_id: s.id, profile_id: s.profile_id, prompt, request_origin: { source: 'composer' }, attachment_ids: [] });
      if (r && r.error) { if (r.relogin) setTimeout(viewDelta, 1500); throw new Error(r.error); }
      $('#dhIn').value = ''; toast(running ? '대기열에 넣었습니다' : '보냈습니다'); dhLoad(viewGen);
    }
    if (e.target.id === 'dhStop') { if (!confirm('이 세션의 실행을 중단할까요?')) return; await dhApi('stop', { session_id: s.id, operation_id: s.operation_id }); toast('중단을 요청했습니다'); dhLoad(viewGen); }
  } catch (er) { toast(er.message, 8000); e.target.disabled = false; }
}

function dhNewDialog() {
  const snap = DH.snap || {};
  const profiles = (snap.profiles || []).filter((p) => !/^demo-/.test(p.id));
  const d = document.createElement('div'); d.className = 'dlg';
  d.innerHTML = `<div class="box"><h3>＋ Delta Hub 새 작업</h3>
    <label>프로젝트<br><select id="dnP" style="width:100%">${(snap.projects || []).map((p) => `<option value="${esc(p.id)}" ${p.id === DH.defaultProject || p.name === DH.defaultProject ? 'selected' : ''}>${esc(p.name)} (${esc(p.path)})</option>`).join('')}</select></label>
    <label>런타임<br><select id="dnR" style="width:100%">${profiles.map((p) => `<option value="${esc(p.id)}" ${p.id === 'claude-local' ? 'selected' : ''}>${esc(p.alias)} · ${esc(p.provider)}</option>`).join('')}</select></label>
    <label>첫 요청 (선택)<br><textarea id="dnT" rows="3" style="width:100%" placeholder="비우면 빈 세션만 만듭니다"></textarea></label>
    <div class="empty" style="padding:0">Delta Hub 서버의 계정·자원으로 실행됩니다. 권한·모델은 Delta 화면에서 바꿀 수 있습니다.</div>
    <div class="row" style="justify-content:flex-end"><button data-x>취소</button><button class="primary" data-ok>만들기</button></div></div>`;
  document.body.appendChild(d);
  d.onclick = async (e) => {
    if (e.target === d || e.target.closest('[data-x]')) return d.remove();
    if (!e.target.closest('[data-ok]')) return;
    e.target.disabled = true;
    try {
      const profile_id = $('#dnR', d).value, project_id = $('#dnP', d).value, first = $('#dnT', d).value.trim();
      const r = await dhApi('sessions', { profile_id, project_id });
      if (r.error) throw new Error(r.error);
      const sid = r.session_id || r.id || r.session?.id;
      if (first && sid) await dhApi('run', { session_id: sid, profile_id, prompt: first, request_origin: { source: 'composer' }, attachment_ids: [] });
      d.remove(); toast('새 작업을 만들었습니다');
      if (sid) { DH.session = sid; DH.after = 0; DH.events = []; }
      dhLoad(viewGen);
    } catch (er) { toast(er.message, 8000); e.target.disabled = false; }
  };
}
