// Calendar view: month grid + agenda over todo.md deadlines (tasks · milestones), the hub's own
// events and the connected Google / Teams calendars. Data: /api/calendar.
'use strict';
const CAL = { month: null, day: null, data: null };
const CAL_KIND = {
  task: { cls: 'ck-task', label: '할 일' }, milestone: { cls: 'ck-ms', label: '마일스톤' },
  event: { cls: 'ck-ev', label: '일정' }, gcal: { cls: 'ck-g', label: '구글' }, mscal: { cls: 'ck-ms365', label: 'Teams' },
};
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const todayStr = () => ymd(new Date());
const calDayLabel = (s) => { const d = new Date(s + 'T00:00:00'); return d.toLocaleDateString((document.documentElement.lang === 'en' ? 'en-US' : 'ko-KR'), { month: 'long', day: 'numeric', weekday: 'short' }); };
const dDay = (s) => { const n = Math.round((new Date(s + 'T00:00:00') - new Date(todayStr() + 'T00:00:00')) / 864e5); return n === 0 ? 'D-day' : n > 0 ? `D-${n}` : `D+${-n}`; };

async function loadCalendar() {
  try { CAL.data = await api('/api/calendar'); } catch (e) { CAL.data = { items: [], error: e.message, google: {} }; }
  if (state.sel.kind !== 'calendar') renderSide();
  if (typeof refreshHomeWidgets === 'function') refreshHomeWidgets();
  return CAL.data;
}

function viewCalendar() {
  const gen = viewGen;
  if (!CAL.month) { const d = new Date(); CAL.month = new Date(d.getFullYear(), d.getMonth(), 1); }
  $('#view').innerHTML = '<div class="empty" style="padding:20px">불러오는 중…</div>';
  $('#view').onclick = calClick;
  loadCalendar().then(() => { if (gen === viewGen) paintCalendar(); });
}

function paintCalendar() {
  const d = CAL.data || { items: [] }, g = d.google || {}, ms = d.ms || {};
  const previousAgenda = $('.cal-upcoming');
  const m = CAL.month, y = m.getFullYear(), mo = m.getMonth();
  const anyConn = g.connected || ms.connected;
  const connN = (ms.connected ? 1 : 0) + (g.connected ? 1 : 0);
  const ico = window.UI_ICO || window.ICO || {};
  const monthText = document.documentElement.lang === 'en'
    ? new Date(y, mo).toLocaleString('en-US', { month: 'long', year: 'numeric' })
    : `${y}년 ${mo + 1}월`;
  setBar('');
  const calMoreTitle = connN ? `외부 캘린더 동기화 및 연동 (${connN}개 연결됨)` : '외부 캘린더 동기화 및 연동';
  const calActs = `
    <div class="btn-grp" role="group" aria-label="월 이동">
      <button data-cal="prev" aria-label="이전 달" title="이전 달">${ico.chevLeft || '‹'}</button>
      <b class="cal-month">${esc(monthText)}</b>
      <button data-cal="next" aria-label="다음 달" title="다음 달">${ico.chevRight || '›'}</button>
    </div>
    <button class="ghost btn-sm" data-cal="today">오늘</button>
    <button class="btn-sm" data-cal="addtask" title="todo.md에 마감 있는 할 일 추가">${ico.plus || ''} 할 일</button>
    <button class="primary btn-sm" data-cal="addev">${ico.plus || ''} 일정</button>
    <button class="ghost icon-btn btn-sm" data-cal="more" aria-label="캘린더 연동 메뉴" aria-haspopup="menu" aria-expanded="false" title="${esc(calMoreTitle)}">${ico.more || '⋯'}</button>`;
  const t = todayStr();
  const selected = CAL.day || t;
  const upcomingOpen = previousAgenda?.dataset.day === selected ? previousAgenda.open : null;
  const items = d.items || [], byDate = new Map();
  const overN = items.filter((x) => x.kind === 'task' && !x.done && x.date < t).length;
  const sysTop = `<div class="sys-top">
    <div class="row" style="gap:8px;align-items:center">${ico.calendar || ''}<h2 style="margin:0;font-size:15px;font-weight:700">캘린더</h2>${overN ? `<span class="badge lim">지연 ${overN}</span>` : ''}</div>
    <div class="sys-acts">${calActs}</div>
  </div>`;

  for (const it of items) { if (!byDate.has(it.date)) byDate.set(it.date, []); byDate.get(it.date).push(it); }
  const selectedItems = byDate.get(selected) || [];
  const order = { event: 0, mscal: 1, gcal: 1, task: 2, milestone: 3 };
  for (const list of byDate.values()) list.sort((a, b) => (order[a.kind] - order[b.kind]) || String(a.time || '').localeCompare(String(b.time || '')) || a.title.localeCompare(b.title));
  window.__calItems = items;
  const chip = (it) => `<div class="cchip ${CAL_KIND[it.kind].cls}${it.kind === 'task' && it.done ? ' done' : ''}" data-cit="${esc(it.id)}" title="${esc(it.title)}">${it.time ? `<b>${esc(it.time)}</b> ` : ''}${it.kind === 'task' ? (it.done ? '☑ ' : '☐ ') : it.kind === 'milestone' ? '◆ ' : ''}${esc(it.title)}</div>`;

  // month grid (Mon-first), 6 weeks
  const first = new Date(y, mo, 1), start = new Date(first); start.setDate(1 - ((first.getDay() + 6) % 7));
  let cells = '';
  for (let i = 0; i < 42; i++) {
    const day = new Date(start); day.setDate(start.getDate() + i);
    const ds = ymd(day), list = byDate.get(ds) || [];
    const more = list.length > 4 ? `<div class="cmore" data-cday="${ds}">+${list.length - 4}개</div>` : '';
    cells += `<div class="cday${day.getMonth() !== mo ? ' out' : ''}${ds === t ? ' today' : ''}${ds === selected ? ' selected' : ''}${[0, 6].includes(day.getDay()) ? ' wk' : ''}" data-cday="${ds}">
      <button type="button" class="cnum" data-cal-day="${ds}" aria-label="${esc(calDayLabel(ds))}" aria-pressed="${ds === selected}">${day.getDate()}</button>${list.slice(0, 4).map(chip).join('')}${more}</div>`;
  }
  const head = ['월', '화', '수', '목', '금', '토', '일'].map((x) => `<div class="chead">${x}</div>`).join('');

  // agenda: today, overdue tasks, next 14 days
  const open = items.filter((x) => !(x.kind === 'task' && x.done));
  const over = items.filter((x) => x.kind === 'task' && !x.done && x.date < t).sort((a, b) => a.date.localeCompare(b.date));
  const soon = open.filter((x) => x.date >= t && x.date <= ymd(new Date(Date.now() + 14 * 864e5))).sort((a, b) => a.date.localeCompare(b.date) || String(a.time || '').localeCompare(String(b.time || '')));
  const row = (it, showSource = false) => `<div class="crow" data-cit="${esc(it.id)}"><span class="cdot ${CAL_KIND[it.kind].cls}"></span><span class="ct">${it.time ? `<b>${esc(it.time)}</b> ` : ''}${esc(it.title)}${showSource ? ` <span class="badge">${CAL_KIND[it.kind].label}</span>` : ''}${it.who ? ` <span class="empty">@${esc(it.who)}</span>` : ''}</span></div>`;
  const groups = [];
  for (const it of soon) { if (!groups.length || groups[groups.length - 1][0] !== it.date) groups.push([it.date, []]); groups[groups.length - 1][1].push(it); }
  const overBlock = over.length ? `<div class="cag warn"><b>지난 마감 · 미완료 ${over.length}</b>${over.map((it) => row(it).replace('</span></div>', ` <span class="empty">${esc(dDay(it.date))}</span></span></div>`)).join('')}</div>` : '';
  const agenda = `${groups.map(([ds, xs]) => `<div class="cag"><b>${ds === t ? '오늘 · ' : ''}${esc(calDayLabel(ds))} <span class="empty">${dDay(ds)}</span></b>${xs.map((it) => row(it)).join('')}</div>`).join('') || '<div class="empty">앞으로 2주 동안 일정이 없습니다</div>'}`;

  const gNote = g.connected ? `구글: ${esc(g.account || '연결됨')}${g.error ? ` · <span style="color:var(--danger)">${esc(g.error)}</span>` : ''}` : '';
  const msNote = ms.connected ? `Teams: ${esc(ms.label || '연결됨')} (${ms.count || 0}건)${ms.error ? ` · <span style="color:var(--danger)">${esc(ms.error)}</span>` : ''}` : '';
  const extSummary = [msNote, gNote, d.todoError ? `<span style="color:var(--danger)">${esc(d.todoError)}</span>` : ''].filter(Boolean).join(' · ');
  $('#view').innerHTML = `<div class="sys-shell">${sysTop}<div class="sys-body"><div class="calwrap"><div class="calmain"><div class="cgrid">${head}${cells}</div>
      <div class="empty" style="padding:6px 2px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:6px">
        <span class="ck-legend"><span class="cdot ck-ev"></span>일정 <span class="cdot ck-task"></span>할 일 <span class="cdot ck-ms"></span>마일스톤 <span class="cdot ck-ms365"></span>Teams <span class="cdot ck-g"></span>구글</span>
        <span>${extSummary}</span>
      </div></div>
    <div class="calside">${overBlock}<section class="cag cal-selected" aria-live="polite"><h2>${esc(calDayLabel(selected))}</h2>${selectedItems.map((it) => row(it, true)).join('') || '<div class="empty">등록된 일정이 없습니다</div>'}</section>
      <details class="cal-upcoming" data-day="${esc(selected)}"${(upcomingOpen ?? !selectedItems.length) ? ' open' : ''}><summary>다가오는 일정</summary>${agenda}</details></div></div></div></div>`;
}

async function calSyncAll() {
  const g = CAL.data?.google || {}, ms = CAL.data?.ms || {};
  const msgs = [];
  if (ms.connected) {
    const r = await api('/api/calendar/ms/sync', { method: 'POST', body: {} }).catch((er) => ({ error: er.message }));
    msgs.push(r.ok ? `Teams ${r.count}건` : `Teams 실패: ${r.error}`);
  }
  if (g.connected) {
    const r = await api('/api/calendar/google/sync', { method: 'POST', body: {} }).catch((er) => ({ error: er.message }));
    msgs.push(r.ok ? `구글 ${r.primary}건` : `구글 실패: ${r.error}`);
  }
  toast(msgs.length ? `동기화 완료 · ${msgs.join(' · ')}` : '연결된 캘린더 없음', 6000);
  await loadCalendar();
  paintCalendar();
}

async function calClick(e) {
  const sysTab = e.target.closest('[data-systab]');
  if (sysTab) return select({ kind: sysTab.dataset.systab });
  const b = e.target.closest('[data-cal]');
  if (b) {
    const a = b.dataset.cal;
    if (a === 'prev' || a === 'next') {
      CAL.month = new Date(CAL.month.getFullYear(), CAL.month.getMonth() + (a === 'next' ? 1 : -1), 1);
      CAL.day = ymd(CAL.month);
      return paintCalendar();
    }
    if (a === 'today') { const d = new Date(); CAL.month = new Date(d.getFullYear(), d.getMonth(), 1); CAL.day = todayStr(); return paintCalendar(); }
    if (a === 'addev') return calEventDialog({ date: CAL.day || todayStr() });
    if (a === 'addtask') return calTaskDialog(CAL.day || todayStr());
    if (a === 'more') {
      e.stopPropagation();
      const g = CAL.data?.google || {}, ms = CAL.data?.ms || {};
      const anyConn = g.connected || ms.connected;
      const ico = window.UI_ICO || {};
      return openMoreMenu(b, [
        anyConn ? { label: '외부 캘린더 지금 동기화', icon: ico.refresh || '', onClick: () => calSyncAll() } : null,
        { label: `외부 캘린더 연동 관리${anyConn ? ` (${(ms.connected ? 1 : 0) + (g.connected ? 1 : 0)})` : ''}`, icon: ico.settings || '', onClick: () => calIntegrationsDrawer() },
      ]);
    }
    if (a === 'integrations') return calIntegrationsDrawer();
    if (a === 'syncall') { b.disabled = true; return calSyncAll(); }
  }
  const c = e.target.closest('[data-cit]');
  if (c) { const it = (window.__calItems || []).find((x) => x.id === c.dataset.cit); if (it) calDetail(it); return; }
  const more = e.target.closest('.cmore');
  if (more) return calDayList(more.dataset.cday);
  const day = e.target.closest('.cday');
  if (day) {
    CAL.day = day.dataset.cday;
    paintCalendar();
    $(`[data-cal-day="${CAL.day}"]`)?.focus({ preventScroll: true });
  }
}

function calDayList(ds) {
  const list = (window.__calItems || []).filter((x) => x.date === ds);
  const body = list.length
    ? list.map((it) => `<div class="crow" data-cit="${esc(it.id)}"><span class="cdot ${CAL_KIND[it.kind].cls}"></span><span class="ct">${it.time ? `<b>${esc(it.time)}</b> ` : ''}${esc(it.title)}</span></div>`).join('')
    : '<div class="empty">등록된 일정이 없습니다</div>';
  const d = openDrawer({ title: calDayLabel(ds), bodyHTML: body, width: 420 });
  d.addEventListener('click', (e) => {
    const c = e.target.closest('[data-cit]');
    if (c) { d.close(); calDetail(list.find((x) => x.id === c.dataset.cit)); }
  });
}

function calDetail(it) {
  const meta = [CAL_KIND[it.kind].label, `${calDayLabel(it.date)}${it.time ? ' ' + it.time + (it.end ? '–' + it.end : '') : ''} (${dDay(it.date)})`, it.paper && it.kind !== 'milestone' ? it.paper : '', it.section && it.kind === 'task' ? it.section : '', it.who ? '@' + it.who : '', it.tags?.length ? '#' + it.tags.join(' #') : ''].filter(Boolean);
  const foot = it.kind === 'task'
    ? `<button class="primary" data-a="done">${it.done ? '완료 취소' : '완료 처리'}</button>`
    : it.kind === 'event'
      ? '<button class="danger ghost" data-a="del">삭제</button><span class="sp"></span><button class="primary" data-a="edit">수정</button>'
      : it.kind === 'gcal' && it.link ? `<a class="btnlike" href="${esc(it.link)}" target="_blank" rel="noopener">구글에서 열기</a>` : '';
  const body = `<div class="empty" style="padding:0">${meta.map(esc).join(' · ')}</div>${it.note ? `<div style="white-space:pre-wrap;margin-top:6px;line-height:1.55">${esc(it.note)}</div>` : ''}
    ${it.kind === 'milestone' ? '<div class="empty" style="padding:0">todo.md의 “일정” 줄에서 읽은 날짜입니다 (수정은 todo.md에서).</div>' : ''}`;
  const d = openDrawer({ title: it.title, bodyHTML: body, footerHTML: foot, width: 440 });
  d.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a; if (!a) return;
    try {
      if (a === 'done') await api('/api/calendar/task', { method: 'POST', body: { id: it.id, done: !it.done } });
      if (a === 'del') { if (!confirm(`“${it.title}” 일정을 삭제할까요?`)) return; await api('/api/calendar/event/delete', { method: 'POST', body: { id: it.id } }); }
      if (a === 'edit') { d.close(); return calEventDialog(it); }
      d.close(); await loadCalendar(); paintCalendar();
    } catch (er) { toast(er.message, 6000, 'danger'); }
  });
}

function calIntegrationsDrawer() {
  const g = CAL.data?.google || {}, ms = CAL.data?.ms || {};
  const ico = window.UI_ICO || {};
  const calLoc = document.documentElement.lang === 'en' ? 'en-US' : 'ko-KR';
  const body = `
    <div class="rcard">
      <div class="uh"><b>Microsoft Teams / Outlook (ICS)</b><span class="badge">${ms.connected ? `연결됨 · ${ms.count || 0}건` : '미연결'}</span></div>
      <div class="empty" style="padding:0">${ms.connected ? `${esc(ms.label || 'Teams')} · 마지막 동기화 ${ms.lastSync ? new Date(ms.lastSync).toLocaleString(calLoc) : '없음'}` : 'Outlook 웹의 공유 캘린더 ICS 링크를 연결해 Teams 일정을 함께 표시합니다 (읽기 전용).'}</div>
      <div class="row" style="margin-top:4px">
        ${ms.connected ? `<button data-ci="mssync">${ico.refresh || ''} 지금 동기화</button><button data-ci="mssetup">설정 변경 / 해제</button>` : '<button class="primary" data-ci="mssetup">Teams ICS 연결</button>'}
      </div>
    </div>
    <div class="rcard">
      <div class="uh"><b>Google 캘린더</b><span class="badge">${g.connected ? '연결됨' : g.configured ? '인증 대기' : '미설정'}</span></div>
      <div class="empty" style="padding:0">${g.connected ? `${esc(g.account || '')} · 마지막 동기화 ${g.lastSync ? new Date(g.lastSync).toLocaleString(calLoc) : '없음'}` : 'OAuth 클라이언트 설정 후 허브 일정과 Google 캘린더를 동기화합니다.'}</div>
      <div class="row" style="margin-top:4px">
        ${!g.configured ? '<button data-ci="gsetup">연결 안내</button>' : !g.connected ? '<button class="primary" data-ci="gauth">구글 계정 연결</button>' : `<button data-ci="gsync">${ico.refresh || ''} 지금 동기화</button>`}
      </div>
    </div>`;
  const d = openDrawer({ title: '외부 캘린더 연동 관리', bodyHTML: body, width: 460 });
  d.addEventListener('click', async (e) => {
    const ci = e.target.closest('[data-ci]')?.dataset.ci; if (!ci) return;
    if (ci === 'mssetup') { d.close(); return calMsSetup(); }
    if (ci === 'gsetup') { d.close(); return calGoogleSetup(); }
    if (ci === 'mssync') {
      const r = await api('/api/calendar/ms/sync', { method: 'POST', body: {} }).catch((er) => ({ error: er.message }));
      toast(r.ok ? `Teams 동기화 완료 (${r.count}건)` : `실패: ${r.error}`, 6000);
      d.close(); await loadCalendar(); return paintCalendar();
    }
    if (ci === 'gsync') {
      const r = await api('/api/calendar/google/sync', { method: 'POST', body: {} }).catch((er) => ({ error: er.message }));
      toast(r.ok ? `구글 동기화 완료 (${r.primary}건)` : `실패: ${r.error}`, 6000);
      d.close(); await loadCalendar(); return paintCalendar();
    }
    if (ci === 'gauth') {
      const r = await api('/api/calendar/google/auth').catch((er) => ({ error: er.message }));
      if (r.error) return toast(r.error, 8000, 'danger');
      d.close(); return void window.open(r.url, '_blank');
    }
  });
}

function calEventDialog(ev) {
  const body = `<form id="calEvForm" style="display:flex;flex-direction:column;gap:10px">
    <label>제목<br><input id="ceT" style="width:100%" value="${esc(ev.title || '')}" placeholder="예: 서버 설치" required></label>
    <div class="row" style="gap:8px;flex-wrap:wrap"><label>날짜<br><input id="ceD" type="date" value="${esc(ev.date || todayStr())}" required></label>
      <label>시작 (선택)<br><input id="ceS" type="time" value="${esc(ev.time || '')}"></label><label>끝 (선택)<br><input id="ceE" type="time" value="${esc(ev.end || '')}"></label></div>
    <label>메모<br><textarea id="ceN" rows="3" style="width:100%">${esc(ev.note || '')}</textarea></label>
    <div class="empty" style="padding:0">마감이 있는 할 일은 “＋ 할 일”로 넣으면 todo.md에 들어가 다른 세션·위젯과 같이 관리됩니다.</div></form>`;
  const d = openDrawer({ title: ev.id ? '일정 수정' : '새 일정', bodyHTML: body, footerHTML: '<button data-drw-close>취소</button><button class="primary" data-ok>저장</button>', width: 440 });
  d.classList.add('drw-compact');
  const form = $('#calEvForm', d), okBtn = $('[data-ok]', d);
  $('#ceT', d).focus();
  const submit = async () => {
    if (okBtn.disabled) return;
    const title = $('#ceT', d).value.trim(), date = $('#ceD', d).value, time = $('#ceS', d).value || null, end = $('#ceE', d).value || null;
    if (!title) { toast('일정 제목을 입력하세요', 3000, 'danger'); return $('#ceT', d).focus(); }
    if (time && end && end < time) return toast('종료 시각은 시작 시각보다 늦어야 합니다', 4000, 'danger');
    okBtn.disabled = true;
    try {
      const payload = { event: { id: ev.id, title, date, time, end, note: $('#ceN', d).value.trim() } };
      const r = await api('/api/calendar/event', { method: 'POST', body: payload }).catch((er) => ({ error: er.message }));
      if (r.error) return toast(r.error, 6000, 'danger');
      d.close(); toast('저장했습니다'); await loadCalendar(); paintCalendar();
    } finally { if (d.isConnected) okBtn.disabled = false; }
  };
  form.onsubmit = (e) => { e.preventDefault(); submit(); };
  okBtn.onclick = submit;
}

function calTaskDialog(date) {
  const body = `<form id="calTaskForm" style="display:flex;flex-direction:column;gap:10px">
    <label>할 일<br><input id="ctT" style="width:100%" placeholder="예: 서버 설치 전 랙 공간 확인" required></label>
    <div class="row" style="gap:8px"><label>마감<br><input id="ctD" type="date" value="${esc(date)}" required></label><label style="flex:1">태그 (선택, 띄어쓰기로 구분)<br><input id="ctG" style="width:100%" placeholder="행정 서버"></label></div>
    <div class="empty" style="padding:0">할 일 목록(todo.md)에 마감일과 함께 추가됩니다.</div></form>`;
  const d = openDrawer({ title: '＋ 할 일 (todo.md)', bodyHTML: body, footerHTML: '<button data-drw-close>취소</button><button class="primary" data-ok>추가</button>', width: 440 });
  d.classList.add('drw-compact');
  const form = $('#calTaskForm', d), okBtn = $('[data-ok]', d);
  $('#ctT', d).focus();
  const submit = async () => {
    if (okBtn.disabled) return;
    const title = $('#ctT', d).value.trim();
    if (!title) { toast('할 일 내용을 입력하세요', 3000, 'danger'); return $('#ctT', d).focus(); }
    okBtn.disabled = true;
    try {
      const r = await api('/api/calendar/task/add', { method: 'POST', body: { title, date: $('#ctD', d).value, tags: $('#ctG', d).value.split(/\s+/).map((x) => x.replace(/^#/, '')).filter(Boolean) } }).catch((er) => ({ error: er.message }));
      if (r.error) return toast(r.error, 6000, 'danger');
      d.close(); toast('todo.md에 추가했습니다'); await loadCalendar(); paintCalendar();
    } finally { if (d.isConnected) okBtn.disabled = false; }
  };
  form.onsubmit = (e) => { e.preventDefault(); submit(); };
  okBtn.onclick = submit;
}

function calGoogleSetup() {
  const body = `<div>구글은 앱마다 “OAuth 클라이언트”가 있어야 캘린더에 쓸 수 있습니다. 계정 주인만 만들 수 있어서 한 번만 해 주세요 (5분).</div>
    <ol style="line-height:1.7;padding-left:20px;margin:4px 0">
      <li><a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noopener">Google Cloud 콘솔</a>에 <b>${esc(CAL.data?.google?.hint || '연결할 계정')}</b>으로 로그인 → 새 프로젝트 (이름 자유, 예: claude-hub)</li>
      <li><a href="https://console.cloud.google.com/apis/library/calendar-json.googleapis.com" target="_blank" rel="noopener">Google Calendar API</a> → <b>사용</b></li>
      <li><a href="https://console.cloud.google.com/auth/overview" target="_blank" rel="noopener">OAuth 동의 화면</a> → 시작하기 → 앱 이름 아무거나 · 대상 <b>외부</b> → 만든 뒤 <b>대상 → 테스트 사용자</b>에 그 계정 추가</li>
      <li><a href="https://console.cloud.google.com/auth/clients" target="_blank" rel="noopener">클라이언트</a> → 클라이언트 만들기 → 유형 <b>데스크톱 앱</b> → 만들기 → <b>JSON 다운로드</b></li>
      <li>받은 파일을 <span class="mono">&lt;설치 폴더&gt;\\hub\\data\\secrets\\google-oauth-client.json</span> 이름으로 저장 → 이 화면을 새로고침 → <b>구글 계정 연결</b></li>
    </ol>
    <div class="empty" style="padding:0">연결하면 허브의 할 일 마감·마일스톤·일정이 구글에 새로 생기는 “Agent CLI Hub” 캘린더로 들어가고(기존 캘린더는 건드리지 않음), 구글 기본 캘린더의 일정도 여기 함께 보입니다.</div>`;
  openDrawer({ title: '구글 캘린더 연결 (처음 한 번)', bodyHTML: body, width: 520 });
}

function calMsSetup() {
  const ms = CAL.data?.ms || {};
  const body = `<form id="calMsForm" style="display:flex;flex-direction:column;gap:10px">
    <div class="empty" style="padding:0">Outlook 웹 → 설정 → 캘린더 → 공유 캘린더 → 캘린더 게시에서 복사한 <b>ICS 링크</b>를 넣으면 Teams 일정이 읽기 전용으로 함께 표시됩니다.</div>
    <label>표시 이름<br><input id="msLbl" style="width:100%" value="${esc(ms.label || 'Teams')}"></label>
    <label>ICS URL<br><input id="msUrl" style="width:100%" value="${esc(ms.url || '')}" placeholder="https://outlook.office365.com/owa/calendar/.../calendar.ics"></label>
    ${ms.connected && !ms.url ? '<div class="ums">보안상 기존 ICS URL은 표시되지 않습니다. URL 변경 시 새 링크를 입력하세요.</div>' : ''}</form>`;
  const foot = `${ms.connected ? '<button class="danger ghost" data-del>연결 해제</button><span class="sp"></span>' : ''}<button data-drw-close>취소</button><button class="primary" data-ok>연결 및 동기화</button>`;
  const d = openDrawer({ title: 'Microsoft Teams / Outlook 캘린더 연결 (ICS)', bodyHTML: body, footerHTML: foot, width: 460 });
  const okBtn = $('[data-ok]', d);
  const submit = async () => {
    if (okBtn.disabled) return;
    const url = $('#msUrl', d).value.trim(), label = $('#msLbl', d).value.trim() || 'Teams';
    if (!url) return toast('ICS URL을 입력하세요', 4000, 'danger');
    okBtn.disabled = true;
    try {
      const r = await api('/api/calendar/ms/connect', { method: 'POST', body: { url, label } }).catch((er) => ({ error: er.message }));
      if (!r.ok) return toast(r.error || '연결 실패', 7000, 'danger');
      d.close(); toast(`Teams 캘린더 연결됨 (${r.count}건)`); await loadCalendar(); paintCalendar();
    } finally { if (d.isConnected) okBtn.disabled = false; }
  };
  $('#calMsForm', d).onsubmit = (e) => { e.preventDefault(); submit(); };
  d.addEventListener('click', async (e) => {
    if (e.target.closest('[data-del]')) {
      if (!confirm('Teams 캘린더 연결을 해제할까요?')) return;
      await api('/api/calendar/ms/disconnect', { method: 'POST', body: {} });
      d.close(); toast('Teams 캘린더 연결 해제됨'); await loadCalendar(); return paintCalendar();
    }
    if (e.target.closest('[data-ok]')) submit();
  });
}
