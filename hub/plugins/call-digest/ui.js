// Call digest plugin UI: days → recordings (transcripts) + the day's summary; rerun a day; status and run log.
'use strict';
const CD = { date: null };
async function viewCalls(sel) {
  const gen = viewGen;
  if (sel?.id) CD.date = sel.id;
  setBar('<h2>📞 통화 요약</h2><span class="sp"></span>');
  const v = $('#view');
  v.innerHTML = '<div class="empty" style="padding:20px">불러오는 중…</div>';
  const r = await api('/api/calls/days').catch((e) => ({ error: e.message }));
  if (gen !== viewGen) return;
  if (r.error) { v.innerHTML = `<div class="err" style="padding:16px">${esc(r.error)}</div>`; return; }
  const days = r.days || [];
  if (!CD.date && days[0]) CD.date = days[0].date;
  const badge = (d) => !d.run ? (d.summary ? '<span class="badge ok">요약</span>' : '')
    : d.run.status === 'running' ? '<span class="badge c">실행 중</span>' : d.run.status === 'error' ? '<span class="badge lim">오류</span>' : '<span class="badge ok">완료</span>';
  v.innerHTML = `<div class="calwrap"><div class="calside" style="max-width:260px;overflow:auto">
      <div class="empty" style="padding:4px 2px">입력: ${esc(r.source)} · STT: ${esc(r.stt)} · 자동 실행: ${esc(r.schedule || '없음 (수동)')}</div>
      ${days.map((d) => `<div class="crow${d.date === CD.date ? ' sel' : ''}" data-cday="${esc(d.date)}" style="cursor:pointer"><span class="ct">${esc(d.date)}</span> ${badge(d)}</div>`).join('') || '<div class="empty">녹음이 없습니다</div>'}
    </div><div class="calmain" id="cdDay" style="overflow:auto"></div></div>`;
  v.onclick = (e) => {
    const d = e.target.closest('[data-cday]'); if (d) { CD.date = d.dataset.cday; return viewCalls(); }
    const t = e.target.closest('[data-tr]'); if (t) return showTranscript(t.dataset.tr);
    if (e.target.closest('[data-rerun]')) return rerunDay();
  };
  if (CD.date) paintDay(gen);
}
async function paintDay(gen) {
  const box = $('#cdDay'); if (!box) return;
  const d = await api(`/api/calls/day?date=${encodeURIComponent(CD.date)}`).catch((e) => ({ error: e.message }));
  if (gen !== viewGen) return;
  if (d.error) { box.innerHTML = `<div class="err">${esc(d.error)}</div>`; return; }
  const recs = (d.recordings || []).map((x) => {
    const m = x.meta || {};
    const head = [m.time, m.counterpart, m.durationSec != null ? `${Math.round(m.durationSec / 60)}분` : null].filter(Boolean).join(' · ');
    return `<div class="crow"><span class="ct">${esc(head || x.name)}</span> ${x.transcript ? `<button class="btn-sm" data-tr="${esc(x.transcript)}">녹취록</button>` : '<span class="badge">녹취 전</span>'}</div>`;
  }).join('') || '<div class="empty">이 날의 녹음이 없습니다</div>';
  const run = d.run ? `<div class="empty" style="padding:0">마지막 실행: ${esc(new Date(d.run.at).toLocaleString())} · ${esc(d.run.status)}${d.run.error ? ` · <span style="color:var(--danger)">${esc(d.run.error)}</span>` : ''}</div>` : '';
  box.innerHTML = `<div class="rcard"><div class="row" style="justify-content:space-between"><b>${esc(d.date)}</b><button class="primary btn-sm" data-rerun>이 날 다시 처리</button></div>${run}
      <h4>녹음</h4>${recs}
      <h4>요약</h4><div class="md">${d.summary ? (typeof md === 'function' ? md(d.summary) : `<pre>${esc(d.summary)}</pre>`) : '<div class="empty">아직 요약이 없습니다</div>'}</div>
      ${d.log ? `<details><summary>실행 기록</summary><pre style="white-space:pre-wrap">${esc(d.log)}</pre></details>` : ''}</div>`;
}
async function showTranscript(name) {
  const r = await fetch(`/api/calls/transcript?date=${encodeURIComponent(CD.date)}&name=${encodeURIComponent(name)}&t=${encodeURIComponent(TOKEN)}`);
  const text = r.ok ? await r.text() : '녹취록을 열 수 없습니다';
  openDrawer({ title: name, bodyHTML: `<pre style="white-space:pre-wrap;line-height:1.5">${esc(text)}</pre>`, width: 620 });
}
async function rerunDay() {
  if (!confirm(`${CD.date} 통화를 다시 처리할까요? (녹취·요약)`)) return;
  const r = await api(`/api/calls/run?date=${encodeURIComponent(CD.date)}`, { method: 'POST', body: {} }).catch((e) => ({ error: e.message }));
  toast(r.error || `${CD.date} 처리를 시작했습니다`, 5000);
  setTimeout(() => { if (state.sel.kind === 'calls') viewCalls(); }, 1500);
}
HubPlugins.register({
  id: 'call-digest',
  nav: [{ key: 'calls', icon: '📞', label: '통화 요약', when: () => !!state.callDigest }],
  views: { calls: (sel) => viewCalls(sel) },
  open(param) {
    if (param !== 'calls' && !param.startsWith('calls:')) return false;
    select(param.includes(':') ? { kind: 'calls', id: param.slice(6) } : { kind: 'calls' });
    return true;
  },
});
