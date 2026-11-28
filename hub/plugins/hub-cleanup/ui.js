// Hub cleanup plugin UI: last report, trash contents, pending approvals (approve / deny), restore, run now.
'use strict';
async function viewCleanup() {
  const gen = viewGen;
  setBar('<h2>🧹 정리</h2><span class="sp"></span><button class="btn-sm" id="clRun">지금 검사·정리</button>');
  const v = $('#view');
  v.innerHTML = '<div class="empty" style="padding:20px">불러오는 중…</div>';
  const r = await api('/api/cleanup').catch((e) => ({ error: e.message }));
  if (gen !== viewGen) return;
  if (r.error && !r.trash) { v.innerHTML = `<div class="err" style="padding:16px">${esc(r.error)}</div>`; return; }
  const gb = (b) => `${((b || 0) / 1e9).toFixed(2)} GB`;
  const last = r.last ? `${new Date(r.last.at).toLocaleString()} · 자동 ${r.last.safe?.count || 0}개 ${gb(r.last.safe?.bytes)} · 확인 ${r.last.confirm?.count || 0}개 ${gb(r.last.confirm?.bytes)}` : '아직 검사하지 않았습니다';
  v.innerHTML = `<div class="rwrap">
    <div class="rcard"><b>마지막 검사</b><div class="empty" style="padding:0">${esc(last)} · 일정: ${esc(r.schedule ? `요일 ${r.schedule.weekday ?? 0} ${r.schedule.at || '03:00'}` : '없음')}${r.main ? '' : ' · 보조 인스턴스(읽기 전용)'}</div></div>
    <div class="rcard"><b>승인 대기</b>${r.pending.map((p) => `<div class="crow"><span class="ct">${esc(p.title)}</span> <button class="btn-sm primary" data-ap="${esc(p.id)}">승인</button> <button class="btn-sm" data-deny="${esc(p.id)}">거절</button></div>`).join('') || '<div class="empty">없음</div>'}</div>
    <div class="rcard"><b>휴지통</b>${r.trash.map((t) => `<div class="crow"><span class="ct">${esc(t.root)} · ${t.stage === 'stage1' ? '복구 가능' : '삭제 대기'} · ${esc(t.day)}</span> <span class="badge">${gb(t.bytes)}</span></div>`).join('') || '<div class="empty">비어 있음</div>'}
      <div class="row" style="margin-top:6px"><input id="clRestore" placeholder="복구할 원래 경로의 일부" style="flex:1"><button class="btn-sm" id="clRestoreGo">복구</button></div></div>
    <div class="rcard"><b>마지막 보고서 (큰 순)</b>${(r.top || []).map((i) => `<div class="crow"><span class="badge">${i.level === 'safe' ? '자동' : '확인'}</span> <span class="ct mono" style="font-size:12px">${esc(i.path)}</span> <span class="badge">${gb(i.size)}</span></div>`).join('') || '<div class="empty">없음</div>'}</div>
    <div class="rcard"><b>기록</b>${(r.history || []).map((h) => `<div class="empty" style="padding:0">${esc(new Date(h.at).toLocaleString())} · ${esc(h.msg)}</div>`).join('') || '<div class="empty">없음</div>'}</div>
  </div>`;
  const post = (p, b) => api(p, { method: 'POST', body: b }).catch((e) => ({ error: e.message }));
  $('#clRun').onclick = async () => { const x = await post('/api/cleanup/run', {}); toast(x.error || '검사·정리를 시작했습니다', 5000); };
  v.onclick = async (e) => {
    const ap = e.target.closest('[data-ap]'), dn = e.target.closest('[data-deny]');
    if (ap || dn) {
      if (ap && !confirm('승인할까요? (완전삭제는 되돌릴 수 없습니다)')) return;
      const x = await post('/api/cleanup/approve', { id: (ap || dn).dataset[ap ? 'ap' : 'deny'], approve: !!ap });
      toast(x.error || '처리했습니다', 5000); return viewCleanup();
    }
    if (e.target.id === 'clRestoreGo') {
      const x = await post('/api/cleanup/restore', { text: $('#clRestore').value });
      toast(x.error || `복구 ${x.restored?.length || 0}개`, 6000); return viewCleanup();
    }
  };
}
HubPlugins.register({
  id: 'hub-cleanup',
  nav: [{ key: 'cleanup', icon: '🧹', label: '정리', when: () => !!state.hubCleanup }],
  views: { cleanup: () => viewCleanup() },
  open(param) { if (param !== 'cleanup') return false; select({ kind: 'cleanup' }); return true; },
});
