// Calendar view: month grid + agenda over todo.md deadlines (tasks · milestones), the hub's own
// events and the connected Google account's calendar. Data: /api/calendar (see calendar.js on the server).
'use strict';
const CAL = { month: null, data: null };
const CAL_KIND = {
  task: { cls: 'ck-task', label: '할 일' }, milestone: { cls: 'ck-ms', label: '마일스톤' },
  event: { cls: 'ck-ev', label: '일정' }, gcal: { cls: 'ck-g', label: '구글' },
};
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const todayStr = () => ymd(new Date());
const calDayLabel = (s) => { const d = new Date(s + 'T00:00:00'); return d.toLocaleDateString((document.documentElement.lang === 'en' ? 'en-US' : 'ko-KR'), { month: 'long', day: 'numeric', weekday: 'short' }); };
const dDay = (s) => { const n = Math.round((new Date(s + 'T00:00:00') - new Date(todayStr() + 'T00:00:00')) / 864e5); return n === 0 ? 'D-day' : n > 0 ? `D-${n}` : `D+${-n}`; };

async function loadCalendar() {
  try { CAL.data = await api('/api/calendar'); } catch (e) { CAL.data = { items: [], error: e.message, google: {} }; }
  if (state.sel.kind !== 'calendar') renderSide();
  return CAL.data;
}
function calendarSideHTML() {
  const items = CAL.data?.items || [], t = todayStr();
  const open = items.filter((x) => !(x.kind === 'task' && x.done));
  const today = open.filter((x) => x.date === t).length;
  const over = items.filter((x) => x.kind === 'task' && !x.done && x.date < t).length;
  const week = open.filter((x) => x.date > t && x.date <= ymd(new Date(Date.now() + 7 * 864e5))).length;
  return `<div class="sec">${itemHTML({ key: 'calendar', title: '📅 캘린더', sub: CAL.data ? `오늘 ${today} · 이번 주 ${week}${over ? ` · 지난 마감 ${over}` : ''}` : 'todo.md 마감 · 일정 · 구글 캘린더',
    badge: over ? `<span class="badge lim">${over}</span>` : '' })}</div>`;
}

function viewCalendar() {
  const gen = viewGen;
  if (!CAL.month) { const d = new Date(); CAL.month = new Date(d.getFullYear(), d.getMonth(), 1); }
  $('#view').innerHTML = '<div class="empty" style="padding:20px">불러오는 중…</div>';
  $('#view').onclick = calClick;
  loadCalendar().then(() => { if (gen === viewGen) paintCalendar(); });
}

function paintCalendar() {
  const d = CAL.data || { items: [] }, g = d.google || {};
  const m = CAL.month, y = m.getFullYear(), mo = m.getMonth();
  const gBtn = !g.configured ? '<button data-cal="gsetup" title="구글 캘린더와 연결하는 방법">구글 캘린더 연결</button>'
    : !g.connected ? '<button class="primary" data-cal="gauth">구글 계정 연결</button>'
      : `<button data-cal="gsync" title="${esc(g.account || '')} · 마지막 동기화 ${g.lastSync ? new Date(g.lastSync).toLocaleString((document.documentElement.lang === 'en' ? 'en-US' : 'ko-KR')) : '없음'}">⟳ 구글 동기화</button>`;
  setBar(`<h2>📅 캘린더</h2><button data-cal="prev" title="이전 달">‹</button><b style="min-width:92px;text-align:center">${document.documentElement.lang === 'en' ? new Date(y, mo).toLocaleString('en-US', { month: 'long', year: 'numeric' }) : `${y}년 ${mo + 1}월`}</b><button data-cal="next" title="다음 달">›</button><button data-cal="today">오늘</button>
    <span class="sp"></span><button data-cal="addev">＋ 일정</button><button data-cal="addtask" title="todo.md에 마감 있는 할 일 추가">＋ 할 일</button>${gBtn}`);
  $('#bar').onclick = calClick;

  const items = d.items || [], byDate = new Map();
  for (const it of items) { if (!byDate.has(it.date)) byDate.set(it.date, []); byDate.get(it.date).push(it); }
  const order = { event: 0, gcal: 1, task: 2, milestone: 3 };
  for (const list of byDate.values()) list.sort((a, b) => (order[a.kind] - order[b.kind]) || String(a.time || '').localeCompare(String(b.time || '')) || a.title.localeCompare(b.title));
  window.__calItems = items;
  const chip = (it) => `<div class="cchip ${CAL_KIND[it.kind].cls}${it.kind === 'task' && it.done ? ' done' : ''}" data-cit="${esc(it.id)}" title="${esc(it.title)}">${it.time ? `<b>${esc(it.time)}</b> ` : ''}${it.kind === 'task' ? (it.done ? '☑ ' : '☐ ') : it.kind === 'milestone' ? '📌 ' : ''}${esc(it.title)}</div>`;

  // month grid (Mon-first), 6 weeks
  const first = new Date(y, mo, 1), start = new Date(first); start.setDate(1 - ((first.getDay() + 6) % 7));
  const t = todayStr();
  let cells = '';
  for (let i = 0; i < 42; i++) {
    const day = new Date(start); day.setDate(start.getDate() + i);
    const ds = ymd(day), list = byDate.get(ds) || [];
    const more = list.length > 4 ? `<div class="cmore" data-cday="${ds}">+${list.length - 4}개</div>` : '';
    cells += `<div class="cday${day.getMonth() !== mo ? ' out' : ''}${ds === t ? ' today' : ''}${[0, 6].includes(day.getDay()) ? ' wk' : ''}" data-cday="${ds}">
      <div class="cnum">${day.getDate()}</div>${list.slice(0, 4).map(chip).join('')}${more}</div>`;
  }
  const head = ['월', '화', '수', '목', '금', '토', '일'].map((x) => `<div class="chead">${x}</div>`).join('');

  // agenda: today, overdue tasks, next 14 days
  const open = items.filter((x) => !(x.kind === 'task' && x.done));
  const over = items.filter((x) => x.kind === 'task' && !x.done && x.date < t).sort((a, b) => a.date.localeCompare(b.date));
  const soon = open.filter((x) => x.date >= t && x.date <= ymd(new Date(Date.now() + 14 * 864e5))).sort((a, b) => a.date.localeCompare(b.date) || String(a.time || '').localeCompare(String(b.time || '')));
  const row = (it) => `<div class="crow" data-cit="${esc(it.id)}"><span class="cdot ${CAL_KIND[it.kind].cls}"></span><span class="ct">${it.time ? `<b>${esc(it.time)}</b> ` : ''}${esc(it.title)}${it.who ? ` <span class="empty">@${esc(it.who)}</span>` : ''}</span></div>`;
  const groups = [];
  for (const it of soon) { if (!groups.length || groups[groups.length - 1][0] !== it.date) groups.push([it.date, []]); groups[groups.length - 1][1].push(it); }
  const agenda = `${over.length ? `<div class="cag warn"><b>⚠ 지난 마감 · 미완료 ${over.length}</b>${over.map((it) => row(it).replace('</span></div>', ` <span class="empty">${esc(dDay(it.date))}</span></span></div>`)).join('')}</div>` : ''}
    ${groups.map(([ds, xs]) => `<div class="cag"><b>${ds === t ? '오늘 · ' : ''}${esc(calDayLabel(ds))} <span class="empty">${dDay(ds)}</span></b>${xs.map(row).join('')}</div>`).join('') || '<div class="empty">앞으로 2주 동안 일정이 없습니다</div>'}`;

  const gNote = g.connected ? `구글: ${esc(g.account || '연결됨')} · “Agent CLI Hub” 캘린더로 보내고, 기본 캘린더 일정을 함께 표시${g.error ? ` · <span style="color:var(--danger,#c0362c)">${esc(g.error)}</span>` : ''}` : g.configured ? '구글 계정 연결 버튼을 누르면 이 PC 브라우저에서 로그인합니다' : '';
  $('#view').innerHTML = `<div class="calwrap"><div class="calmain"><div class="cgrid">${head}${cells}</div>
      <div class="empty" style="padding:6px 2px">할 일·마일스톤 = <span class="mono">data\\todo.md</span> (에이전트 세션도 같은 파일을 편집) · 일정 = <span class="mono">data\\calendar.json</span>${d.todoError ? ` · <span style="color:#c0362c">${esc(d.todoError)}</span>` : ''}${gNote ? ' · ' + gNote : ''}
      · <span class="ck-legend"><span class="cdot ck-ev"></span>일정 <span class="cdot ck-task"></span>할 일 <span class="cdot ck-ms"></span>마일스톤 <span class="cdot ck-g"></span>구글</span></div></div>
    <div class="calside">${agenda}</div></div>`;
}

async function calClick(e) {
  const b = e.target.closest('[data-cal]');
  if (b) {
    const a = b.dataset.cal;
    if (a === 'prev' || a === 'next') { CAL.month = new Date(CAL.month.getFullYear(), CAL.month.getMonth() + (a === 'next' ? 1 : -1), 1); return paintCalendar(); }
    if (a === 'today') { const d = new Date(); CAL.month = new Date(d.getFullYear(), d.getMonth(), 1); return paintCalendar(); }
    if (a === 'addev') return calEventDialog({ date: todayStr() });
    if (a === 'addtask') return calTaskDialog(todayStr());
    if (a === 'gsetup') return calGoogleSetup();
    if (a === 'gauth') {
      const r = await api('/api/calendar/google/auth').catch((er) => ({ error: er.message }));
      if (r.error) return toast(r.error, 8000);
      if (!/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) toast('구글 로그인 후 돌아오는 주소가 이 PC(127.0.0.1)라서, 연결은 이 PC 브라우저에서 해야 합니다', 9000);
      return void window.open(r.url, '_blank');
    }
    if (a === 'gsync') { b.disabled = true; const r = await api('/api/calendar/google/sync', { method: 'POST', body: {} }).catch((er) => ({ error: er.message })); toast(r.ok ? `동기화 완료 · 추가 ${r.added} · 변경 ${r.changed} · 삭제 ${r.removed} · 구글 일정 ${r.primary}` : `동기화 실패: ${r.error}`, 7000); await loadCalendar(); return paintCalendar(); }
  }
  const c = e.target.closest('[data-cit]');
  if (c) { const it = (window.__calItems || []).find((x) => x.id === c.dataset.cit); if (it) calDetail(it); return; }
  const more = e.target.closest('.cmore');
  if (more) return calDayList(more.dataset.cday);
  const day = e.target.closest('.cday');
  if (day && e.target.closest('.cnum, .cday') === day) return calEventDialog({ date: day.dataset.cday });
}

function calDayList(ds) {
  const list = (window.__calItems || []).filter((x) => x.date === ds);
  const d = document.createElement('div'); d.className = 'dlg';
  d.innerHTML = `<div class="box"><h3>${esc(calDayLabel(ds))}</h3>${list.map((it) => `<div class="crow" data-cit="${esc(it.id)}"><span class="cdot ${CAL_KIND[it.kind].cls}"></span><span class="ct">${it.time ? `<b>${esc(it.time)}</b> ` : ''}${esc(it.title)}</span></div>`).join('')}<div class="row" style="justify-content:flex-end"><button data-x>닫기</button></div></div>`;
  document.body.appendChild(d);
  d.onclick = (e) => { if (e.target === d || e.target.closest('[data-x]')) return d.remove(); const c = e.target.closest('[data-cit]'); if (c) { d.remove(); calDetail(list.find((x) => x.id === c.dataset.cit)); } };
}

function calDetail(it) {
  const d = document.createElement('div'); d.className = 'dlg';
  const meta = [CAL_KIND[it.kind].label, `${calDayLabel(it.date)}${it.time ? ' ' + it.time + (it.end ? '–' + it.end : '') : ''} (${dDay(it.date)})`, it.paper && it.kind !== 'milestone' ? it.paper : '', it.section && it.kind === 'task' ? it.section : '', it.who ? '@' + it.who : '', it.tags?.length ? '#' + it.tags.join(' #') : ''].filter(Boolean);
  const acts = it.kind === 'task' ? `<button class="primary" data-a="done">${it.done ? '완료 취소' : '✓ 완료'}</button>`
    : it.kind === 'event' ? '<button data-a="del">삭제</button><button class="primary" data-a="edit">수정</button>'
      : it.kind === 'gcal' && it.link ? `<a class="btnlike" href="${esc(it.link)}" target="_blank" rel="noopener">구글에서 열기</a>` : '';
  d.innerHTML = `<div class="box"><h3>${esc(it.title)}</h3><div class="empty" style="padding:0">${meta.map(esc).join(' · ')}</div>${it.note ? `<div style="white-space:pre-wrap;margin-top:6px">${esc(it.note)}</div>` : ''}
    ${it.kind === 'milestone' ? '<div class="empty" style="padding:0">todo.md의 “일정” 줄에서 읽은 날짜입니다 (수정은 todo.md에서).</div>' : ''}
    <div class="row" style="justify-content:flex-end"><button data-a="x">닫기</button>${acts}</div></div>`;
  document.body.appendChild(d);
  d.onclick = async (e) => {
    if (e.target === d) return d.remove();
    const a = e.target.closest('[data-a]')?.dataset.a; if (!a) return;
    if (a === 'x') return d.remove();
    try {
      if (a === 'done') await api('/api/calendar/task', { method: 'POST', body: { id: it.id, done: !it.done } });
      if (a === 'del') { if (!confirm(`“${it.title}” 일정을 삭제할까요?`)) return; await api('/api/calendar/event/delete', { method: 'POST', body: { id: it.id } }); }
      if (a === 'edit') { d.remove(); return calEventDialog(it); }
      d.remove(); await loadCalendar(); paintCalendar();
    } catch (er) { toast(er.message, 6000); }
  };
}

function calEventDialog(ev) {
  const d = document.createElement('div'); d.className = 'dlg';
  d.innerHTML = `<div class="box"><h3>${ev.id ? '일정 수정' : '새 일정'}</h3>
    <label>제목<br><input id="ceT" style="width:100%" value="${esc(ev.title || '')}" placeholder="예: 서버 설치"></label>
    <div class="row" style="gap:8px;flex-wrap:wrap"><label>날짜<br><input id="ceD" type="date" value="${esc(ev.date || todayStr())}"></label>
      <label>시작 (선택)<br><input id="ceS" type="time" value="${esc(ev.time || '')}"></label><label>끝 (선택)<br><input id="ceE" type="time" value="${esc(ev.end || '')}"></label></div>
    <label>메모<br><textarea id="ceN" rows="2" style="width:100%">${esc(ev.note || '')}</textarea></label>
    <div class="empty" style="padding:0">마감이 있는 할 일은 “＋ 할 일”로 넣으면 todo.md에 들어가 다른 세션·위젯과 같이 관리됩니다.</div>
    <div class="row" style="justify-content:flex-end"><button data-x>취소</button><button class="primary" data-ok>저장</button></div></div>`;
  document.body.appendChild(d);
  $('#ceT', d).focus();
  d.onclick = async (e) => {
    if (e.target === d || e.target.closest('[data-x]')) return d.remove();
    if (!e.target.closest('[data-ok]')) return;
    const body = { event: { id: ev.id, title: $('#ceT', d).value.trim(), date: $('#ceD', d).value, time: $('#ceS', d).value || null, end: $('#ceE', d).value || null, note: $('#ceN', d).value.trim() } };
    const r = await api('/api/calendar/event', { method: 'POST', body }).catch((er) => ({ error: er.message }));
    if (r.error) return toast(r.error, 6000);
    d.remove(); toast('저장했습니다'); await loadCalendar(); paintCalendar();
  };
}

function calTaskDialog(date) {
  const d = document.createElement('div'); d.className = 'dlg';
  d.innerHTML = `<div class="box"><h3>＋ 할 일 (todo.md)</h3>
    <label>할 일<br><input id="ctT" style="width:100%" placeholder="예: 서버 설치 전 랙 공간 확인"></label>
    <div class="row" style="gap:8px"><label>마감<br><input id="ctD" type="date" value="${esc(date)}"></label><label style="flex:1">태그 (선택, 띄어쓰기로 구분)<br><input id="ctG" style="width:100%" placeholder="행정 서버"></label></div>
    <div class="empty" style="padding:0">todo.md의 “📋 대기 중” 목록 끝에 <span class="mono">- [ ] **할 일** #태그 @due(날짜)</span>로 추가됩니다.</div>
    <div class="row" style="justify-content:flex-end"><button data-x>취소</button><button class="primary" data-ok>추가</button></div></div>`;
  document.body.appendChild(d);
  $('#ctT', d).focus();
  d.onclick = async (e) => {
    if (e.target === d || e.target.closest('[data-x]')) return d.remove();
    if (!e.target.closest('[data-ok]')) return;
    const r = await api('/api/calendar/task/add', { method: 'POST', body: { title: $('#ctT', d).value.trim(), date: $('#ctD', d).value, tags: $('#ctG', d).value.split(/\s+/).map((x) => x.replace(/^#/, '')).filter(Boolean) } }).catch((er) => ({ error: er.message }));
    if (r.error) return toast(r.error, 6000);
    d.remove(); toast('todo.md에 추가했습니다'); await loadCalendar(); paintCalendar();
  };
}

function calGoogleSetup() {
  const d = document.createElement('div'); d.className = 'dlg';
  d.innerHTML = `<div class="box wide"><h3>구글 캘린더 연결 (처음 한 번)</h3>
    <div>구글은 앱마다 “OAuth 클라이언트”가 있어야 캘린더에 쓸 수 있습니다. 계정 주인만 만들 수 있어서 한 번만 해 주세요 (5분).</div>
    <ol style="line-height:1.7">
      <li><a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noopener">Google Cloud 콘솔</a>에 <b>${esc(CAL.data?.google?.hint || '연결할 계정')}</b>으로 로그인 → 새 프로젝트 (이름 자유, 예: claude-hub)</li>
      <li><a href="https://console.cloud.google.com/apis/library/calendar-json.googleapis.com" target="_blank" rel="noopener">Google Calendar API</a> → <b>사용</b></li>
      <li><a href="https://console.cloud.google.com/auth/overview" target="_blank" rel="noopener">OAuth 동의 화면</a> → 시작하기 → 앱 이름 아무거나 · 대상 <b>외부</b> → 만든 뒤 <b>대상 → 테스트 사용자</b>에 그 계정 추가</li>
      <li><a href="https://console.cloud.google.com/auth/clients" target="_blank" rel="noopener">클라이언트</a> → 클라이언트 만들기 → 유형 <b>데스크톱 앱</b> → 만들기 → <b>JSON 다운로드</b></li>
      <li>받은 파일을 <span class="mono">&lt;설치 폴더&gt;\\hub\\data\\secrets\\google-oauth-client.json</span> 이름으로 저장 → 이 화면을 새로고침 → <b>구글 계정 연결</b></li>
    </ol>
    <div class="empty" style="padding:0">연결하면 허브의 할 일 마감·마일스톤·일정이 구글에 새로 생기는 “Agent CLI Hub” 캘린더로 들어가고(기존 캘린더는 건드리지 않음), 구글 기본 캘린더의 일정도 여기 함께 보입니다. 같은 파일로 Claude의 google-calendar 연결도 살릴 수 있습니다.</div>
    <div class="row" style="justify-content:flex-end"><button data-x>닫기</button></div></div>`;
  document.body.appendChild(d);
  d.onclick = (e) => { if (e.target === d || e.target.closest('[data-x]')) d.remove(); };
}
