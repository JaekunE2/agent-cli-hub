// ---------- autonomous research projects ----------
const PHASE_KO = { P1_ideation: '아이디어', P2_venue: '타겟 조사', P3_literature: '문헌·SOTA', P4_plan: '계획', P5_experiment: '실험', P6_analysis: '분석', P7_iterate: '재실험·재계획', P8_writing: '논문 작성', P9_review: '리뷰·수정', P10_submission: '투고 준비' };
const PHASE_DESC = {
  P1_ideation: '아이디어 후보를 여러 개 만들어 비교하고, 가장 좋은 주 아이디어와 예비 아이디어를 고릅니다.',
  P2_venue: '목표 학회·저널의 분량, 양식, 심사 기준, 마감을 조사해 투고할 곳을 정합니다.',
  P3_literature: '관련 연구와 최신 기술을 조사하고, 인용이 실제로 존재하는지 코드로 확인합니다.',
  P4_plan: '가설, 실험 설계, 베이스라인, 데이터셋, 지표, 일정을 정합니다.',
  P5_experiment: '구현 → 작은 테스트 → 본 실험 순서로 진행합니다. GPU는 대기열로 씁니다.',
  P6_analysis: '결과 파일에서 표와 그림을 생성하고, 가설이 맞았는지 판정합니다.',
  P7_iterate: '약점을 보완하기 위해 재실험하거나 계획을 다시 세웁니다(최대 3회).',
  P8_writing: '목표 학회 양식에 맞춰 LaTeX 논문을 씁니다.',
  P9_review: '리뷰어 관점으로 검토하고, 수치와 인용을 검증한 뒤 수정합니다.',
  P10_submission: '투고 패키지(형식·익명화·보충자료·커버레터·체크리스트)를 준비합니다. 실제 제출은 사용자가 합니다.',
};
const GOAL_KO = { P1_ideation: '아이디어 확정까지', P2_venue: '타겟 학회 결정까지', P3_literature: '문헌 조사까지', P4_plan: '실험 계획까지', P5_experiment: '실험 완료까지', P6_analysis: '결과 분석까지', P7_iterate: '재실험까지', P8_writing: '논문 초안까지', P9_review: '리뷰까지 마친 최종 논문', P10_submission: '투고 준비까지' };
// result verdict recorded by the director at done
const R_RESULT = { positive: ['양성', 'ok'], negative: ['음성', 'bad'], mixed: ['혼합', 'warn'] };
const resultBadge = (p) => (p.result && R_RESULT[p.result] ? `<span class="badge ${R_RESULT[p.result][1] === 'bad' ? 'lim' : 'c'}" title="${esc(p.result_summary || '')}">${R_RESULT[p.result][0]}</span>` : '');
const R_STATUS = { running: ['자율 진행 중', 'ok', '●'], waiting: ['대기 중', 'warn', '⏳'], paused: ['일시정지', 'muted', '⏸'], blocked: ['확인 필요', 'bad', '⚠'], done: ['목표 달성', 'ok', '✔'] };
const R_TABS = [['overview', '개요'], ['report', '보고서'], ['plan', '계획'], ['activity', '활동 기록'], ['outputs', '산출물'], ['settings', '브리프·설정']];


// JOURNAL.md "- <ISO time> text" lines → [{ts, text}]
function journalItems(txt) {
  return String(txt || '').split('\n').map((l) => l.match(/^-\s*(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\s*(.*)$/)).filter(Boolean)
    .map((m) => ({ ts: Date.parse(m[1]), text: m[2] }));
}
const relTime = (ms) => {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return '방금'; if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`; return `${Math.floor(s / 86400)}일 전`;
};
function goalProgress(p) {
  const phases = Object.keys(PHASE_KO);
  const goal = p.config?.goal || 'P9_review';
  const upto = phases.slice(0, phases.indexOf(goal) + 1);
  const passed = upto.filter((ph) => p.gates?.[ph]?.passed).length;
  return { phases, upto, goal, passed, pct: Math.round((passed / upto.length) * 100), cur: phases.indexOf(p.phase) };
}

async function refreshResearch() {
  let r; try { r = await api('/api/research'); } catch { return; }
  state.researchEnabled = Array.isArray(r.projects);
  state.research = r.projects || [];
  renderSide();
  if (state.sel.kind === 'research') paintResearch(true);
}

let rCache = { slug: null, json: '', data: null };
function viewResearch() {
  const slug = state.sel.id;
  state.rtab = state.rtab || {};
  rCache = { slug, json: '', data: null };
  $('#bar').onclick = async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.ract === 'more') {
      e.stopPropagation();
      return openMoreMenu(b, [
        !IS_REMOTE ? { label: '탐색기에서 폴더 열기', icon: ICO.folder, onClick: () => researchAction(slug, 'folder') } : null,
        { label: '파생 연구 만들기', icon: ICO.plus, onClick: () => researchAction(slug, 'derive') },
      ]);
    }
    if (b.dataset.ract) return researchAction(slug, b.dataset.ract);
  };
  $('#view').onclick = async (e) => {
    const t = e.target.closest('[data-rtab]');
    if (t) { state.rtab[slug] = t.dataset.rtab; rCache.json = ''; return paintResearch(); }
    const asub = e.target.closest('[data-ract-sub]');
    if (asub) { state.rActSub = asub.dataset.ractSub; rCache.json = ''; return paintResearch(); }
    const rcopy = e.target.closest('[data-rcopy]');
    if (rcopy) {
      const k = rcopy.dataset.rcopy;
      if (rCache.data) copyText(k === 'report' ? [rCache.data.final, rCache.data.report].filter(Boolean).join('\n\n---\n\n') : rCache.data.plan || '');
      return;
    }
    const a = e.target.closest('[data-ract]');
    if (a) return researchAction(slug, a.dataset.ract);
    const f = e.target.closest('[data-rfile]');
    if (f) return openResearchFile(slug, f.dataset.rfile);
    if (e.target.closest('[data-rsyn]')) return openLineageDialog('synthesis', [slug]);
    const g = e.target.closest('[data-rgo]');
    if (g) return select({ kind: 'research', id: g.dataset.rgo });
  };
  $('#view').innerHTML = '<div class="empty" style="padding:20px">불러오는 중…</div>';
  paintResearch();
}
// new derived / synthesis project
function openLineageDialog(kind, preset = []) {
  const done = state.research.filter((p) => p.status === 'done' || preset.includes(p.slug));
  const base = state.research.find((p) => p.slug === preset[0]);
  const pick = kind === 'synthesis' ? `<div><b>분석할 연구</b> (2개 이상)<div class="rsyn">${done.map((p) => `<label class="row" style="gap:6px"><input type="checkbox" value="${esc(p.slug)}" ${preset.includes(p.slug) || p.result === 'negative' || p.result === 'mixed' ? 'checked' : ''}> ${esc(p.name)} ${resultBadge(p)}</label>`).join('') || '<div class="empty">끝난 연구가 없습니다</div>'}</div></div>` : '';
  const body = `
    ${kind === 'derived' ? `<div class="empty" style="padding:0">기반: <b>${esc(base?.name || preset[0])}</b> ${base ? resultBadge(base) : ''} — 이 연구는 그대로 두고, 결과·실패 기록·코드를 이어받습니다.</div>` : '<div class="empty" style="padding:0">끝난 연구들의 결과(특히 음성 결과)를 비교·분석해 공통 원인과 교훈을 정리하는 논문입니다. 수치는 각 연구의 결과 파일에서만 가져옵니다.</div>'}
    ${pick}
    <label>프로젝트 이름<br><input id="lName" style="width:100%" value="${esc(kind === 'derived' ? (base?.name || '') + ' 후속' : '')}" placeholder="${kind === 'synthesis' ? '예: DT 재구성 접근들의 음성 결과 분석' : ''}"></label>
    <label>방향${kind === 'derived' ? ' (FINAL.md의 "다음 선택지"를 참고해 적거나, 비우면 디렉터가 제안 중에서 고릅니다)' : ''}<br><textarea id="lDir" rows="6" style="width:100%" placeholder="${kind === 'synthesis' ? '예) 세 연구가 공통으로 실패한 이유가 측정 기준 때문인지 방법 때문인지 밝히고, 언제 이 접근이 통하는지 정리' : '예) 음성 결과의 원인으로 보인 조명 변화만 통제한 조건에서 다시 검증'}"></textarea></label>
    <label>목표 학회·저널 (선택)<br><input id="lVenue" style="width:100%" placeholder="비우면 디렉터가 조사해 정합니다"></label>`;
  const d = openDrawer({ title: kind === 'synthesis' ? '종합 논문 만들기' : '파생 연구 만들기', bodyHTML: body, footerHTML: '<button data-drw-close>취소</button><button class="primary" id="lOk">만들고 시작</button>', width: 480 });
  $('#lOk', d).onclick = async () => {
    const parents = kind === 'synthesis' ? [...d.querySelectorAll('.rsyn input:checked')].map((x) => x.value) : preset;
    const dir = $('#lDir', d).value.trim() || (kind === 'derived' ? '기반 연구 FINAL.md의 "다음 선택지" 중 가장 유망한 방향을 골라 진행 (선택 이유를 DECISIONS.md에 기록)' : '');
    const payload = { name: $('#lName', d).value.trim(), direction: dir, venue: $('#lVenue', d).value.trim(), kind, parents };
    if (!payload.name || !payload.direction) return toast('이름과 방향을 입력하세요');
    if (kind === 'synthesis' && parents.length < 2) return toast('분석할 연구를 2개 이상 고르세요');
    $('#lOk', d).disabled = true;
    const r = await api('/api/research/new', { method: 'POST', body: payload });
    if (r.error) { $('#lOk', d).disabled = false; return toast(r.error, 6000); }
    d.close();
    await Promise.all([refreshOverview(), refreshResearch()]);
    select({ kind: 'research', id: r.slug });
  };
}
async function researchAction(slug, act) {
  if (act === 'open') {
    const r = await api('/api/research/open', { method: 'POST', body: { slug } });
    if (r.error) return toast(r.error);
    await refreshOverview();
    return r.term ? select({ kind: 'term', id: String(r.term) }) : select({ kind: 'console', id: String(r.console) });
  }
  if (act === 'pause' || act === 'resume') {
    await api('/api/research/control', { method: 'POST', body: { slug, action: act } });
    toast(act === 'pause' ? '일시정지 — 지금 하던 턴이 끝나면 멈춥니다' : '자율 진행을 재개합니다');
    rCache.json = ''; return refreshResearch();
  }
  if (act === 'submit') {
    if (!confirm('이 연구를 이어서 투고 패키지(형식·익명화·보충자료·커버레터·체크리스트)까지 준비합니다. 실제 제출은 직접 하셔야 합니다. 진행할까요?')) return;
    const r = await api('/api/research/submit', { method: 'POST', body: { slug } });
    if (r.error) return toast(r.error, 6000);
    toast('투고 준비를 시작했습니다'); rCache.json = ''; return refreshResearch();
  }
  if (act === 'derive') return openLineageDialog('derived', [slug]);
  if (act === 'folder') { await api('/api/research/folder', { method: 'POST', body: { slug } }); return toast('탐색기에서 폴더를 열었습니다 (PC)'); }
  if (act === 'send') {
    const i = $('#rMsg'); const text = i?.value.trim(); if (!text) return;
    i.value = '';
    const r = await api('/api/research/msg', { method: 'POST', body: { slug, text } });
    return toast(r.delivered ? '디렉터에게 바로 전달했습니다' : '디렉터가 작업 중이라 메시지함에 넣었습니다 — 다음 턴에 처리합니다', 5000);
  }
}
async function openResearchFile(slug, rel) {
  const d = document.createElement('div');
  d.className = 'dlg';
  d.innerHTML = `<div class="box wide"><div class="row"><h3 style="flex:1;margin:0">${esc(rel)}</h3><button id="fvClose">닫기</button></div><div id="fvBody" class="fvbody">불러오는 중…</div></div>`;
  document.body.appendChild(d);
  d.onclick = (e) => { if (e.target === d || e.target.id === 'fvClose') d.remove(); };
  if (/\.(png|jpe?g|pdf)$/i.test(rel)) { $('#fvBody', d).innerHTML = '<div class="empty">이미지·PDF는 PC에서 "폴더 열기"로 확인하세요.</div>'; return; }
  const r = await api(`/api/research/file?slug=${encodeURIComponent(slug)}&path=${encodeURIComponent(rel)}`);
  const body = $('#fvBody', d);
  if (r.error) { body.innerHTML = `<div class="err">${esc(r.error)}</div>`; return; }
  if (/\.md$/i.test(rel)) body.innerHTML = md(r.text);
  else if (/\.json$/i.test(rel)) { let t = r.text; try { t = JSON.stringify(JSON.parse(r.text), null, 2); } catch {} body.innerHTML = `<pre class="mdpre">${esc(t)}</pre>`; }
  else body.innerHTML = `<pre class="mdpre">${esc(r.text)}</pre>`;
}

let rComposing = false;
async function paintResearch(auto) {
  const gen = viewGen, slug = state.sel.id;
  const d = await api(`/api/research/detail?slug=${encodeURIComponent(slug)}`).catch((e) => ({ error: e.message }));
  if (gen !== viewGen || state.sel.kind !== 'research' || state.sel.id !== slug) return;
  if (d.error) { $('#view').innerHTML = `<div class="err">${esc(d.error)}</div>`; return; }
  const tab = state.rtab?.[slug] || 'overview';
  // only what this page shows: GPU lease ids/labels, not their live memory/heartbeat numbers
  const json = JSON.stringify(d) + tab + JSON.stringify((state.gpu?.active || []).map((t) => [t.id, t.label]));
  if (json === rCache.json) return; // nothing changed → keep scroll / typing
  // don't rebuild the page under the user's hands: while typing in the message box (or composing
  // Korean), or with text selected, try again on the next refresh
  const ae = document.activeElement;
  if (auto && ((ae?.id === 'rMsg' && (ae.value || rComposing)) || String(window.getSelection?.() || '').length)) return;
  rCache.json = json; rCache.data = d;

  const [label, tone] = R_STATUS[d.status] || [d.status, 'muted'];
  const running = !['paused', 'blocked', 'done'].includes(d.status);
  setBar(`<h2>${ICO.flask} ${esc(d.name)}</h2><span class="pill ${tone}">${esc(label)}</span>
    <button class="btn-sm" data-ract="open">디렉터 화면</button>
    ${running ? '<button class="btn-sm" data-ract="pause">일시정지</button>' : `<button data-ract="resume" class="btn-sm${d.status === 'blocked' ? '' : ' primary'}">${d.status === 'done' ? '다시 진행' : '재개'}</button>`}
    <button class="ghost icon-btn btn-sm" data-ract="more" aria-label="연구 메뉴" aria-haspopup="menu" aria-expanded="false">${ICO.more}</button>`);

  const prog = goalProgress(d);
  const msgVal = $('#rMsg')?.value || '';
  const tabs = `<div class="tablist" role="tablist" aria-label="연구 보기" style="padding:0 var(--page-pad);background:var(--panel)">${R_TABS.map(([k, t]) => `<button role="tab" data-rtab="${k}" aria-selected="${k === tab}" class="${k === tab ? 'on' : ''}">${t}</button>`).join('')}</div>`;
  let body = '';

  if (tab === 'overview') {
    const rv = d.review;
    const benchHtml = rv?.bench
      ? (isEnUI() ? `<b>Worst #${rv.bench.worst}</b>/${rv.bench.of} papers (target ≤ #${rv.maxRank})` : `<b>최저 ${rv.bench.worst}위</b>/${rv.bench.of}편 (기준 ${rv.maxRank}위 이내)`)
      : '아직 없음';
    const reviewCard = rv ? `<div class="rban ${rv.passed ? 'ok' : 'warn'}"><div><b>리뷰 루프 ${rv.rounds}/${rv.max}라운드</b> · 최근 판정 <b>${esc(rv.recommendation || '없음')}</b> (기준 ${esc(rv.min)} 이상)
        · 채택 논문 비교 ${benchHtml}</div>
        ${rv.passed ? '<div>종료 기준 충족</div>' : `<div class="empty" style="padding:0">남은 조건: ${esc(rv.reasons.join(' · '))}</div>`}
        ${rv.stalled ? '<div>최근 라운드에서 판정이 나아지지 않아 실험 보강(P7)으로 돌아가도록 안내 중</div>' : ''}</div>` : '';
    const banner = d.status === 'blocked'
      ? `<div class="rban bad"><b>확인이 필요합니다</b><div>${esc(d.blocked_reason || '')}</div>${d.questions?.split('\n').length > 2 ? md(d.questions) : ''}<div class="row"><button class="primary" data-ract="resume">해결했어요 · 재개</button><span class="empty">또는 하단 입력창으로 지시</span></div></div>`
      : d.status === 'done'
        ? `<div class="rban ok"><b>목표(${esc(GOAL_KO[prog.goal])})에 도달했습니다</b> ${resultBadge(d)}${d.result_summary ? ` <span class="empty">${esc(d.result_summary)}</span>` : ''}
            <div class="row" style="margin:6px 0">${prog.goal !== 'P10_submission' ? '<button class="primary" data-ract="submit" title="이 연구를 이어서 투고 패키지까지 준비 (제출은 직접)">투고 준비 진행</button>' : '<span class="empty">투고 패키지: 산출물 탭 → research/submission · 제출은 직접 하세요</span>'}
              <button data-ract="derive">파생 연구 만들기</button>
              <button data-rsyn="1">종합 논문에 포함</button></div>
            ${d.final ? md(d.final) : '<div>산출물 탭에서 결과를 확인하세요.</div>'}</div>`
        : d.status === 'waiting'
          ? `<div class="rban warn"><b>기다리는 중</b> — ${esc(d.wait_reason || '')}${d.wake_at ? (isEnUI() ? ` · Auto-resume at <b>${esc(new Date(d.wake_at).toLocaleString(uiLocale()))}</b>` : ` · <b>${esc(new Date(d.wake_at).toLocaleString(uiLocale()))}</b>에 자동 재개`) : ''}<div class="row"><button data-ract="resume">지금 깨우기</button></div></div>`
          : d.status === 'paused' ? `<div class="rban muted"><b>일시정지됨</b> — 상단 재개를 누르면 이어서 진행합니다.</div>` : '';
    const steps = prog.phases.map((ph, i) => {
      const beyond = i > prog.phases.indexOf(prog.goal);
      const cls = d.gates?.[ph]?.passed ? 'done' : i === prog.cur ? 'cur' : beyond ? 'off' : '';
      return `<div class="rstep ${cls}" title="${esc(PHASE_DESC[ph])}"><span class="n">${d.gates?.[ph]?.passed ? '✓' : i + 1}</span><span class="l">${PHASE_KO[ph]}</span></div>`;
    }).join('');
    const items = journalItems(d.journal).slice(-8).reverse();
    const myGpu = (state.gpu?.active || []).filter((t) => (t.requester?.cwd || '').toLowerCase().startsWith(d.dir.toLowerCase()) || (t.command || '').toLowerCase().includes(d.dir.toLowerCase()));
    body = `${reviewCard}${banner}
      <div class="rcard">
        <div class="rprog"><div><b>진행률</b> <span class="empty">목표: ${esc(GOAL_KO[prog.goal])}</span></div><b>${prog.pct}%</b></div>
        ${bar(prog.pct)}
        <div class="rsteps">${steps}</div>
        <div class="rnow"><span class="empty">지금 단계</span> <b>${PHASE_KO[d.phase] || d.phase}</b> — ${esc(PHASE_DESC[d.phase] || '')}</div>
        <div class="rnow" style="border-top:1px solid var(--line);padding-top:8px"><span class="empty">다음 작업</span> <b>${esc(d.next_action || '-')}</b></div>
        ${d.lineage ? `<div><span class="empty">${d.lineage.kind === 'derived' ? '기반 연구' : '종합 대상'}</span> ${d.lineage.parents.map((x) => `<button class="linkbtn" data-rgo="${esc(x.slug)}">${esc(x.name || x.slug)}</button>`).join(' · ')}</div>` : ''}
        ${d.children?.length ? `<div><span class="empty">이어진 연구</span> ${d.children.map((c) => `<button class="linkbtn" data-rgo="${esc(c)}">${esc((state.research.find((x) => x.slug === c) || {}).name || c)}</button>`).join(' · ')}</div>` : ''}
        <div class="empty" style="padding:0">디렉터 ${d.director ? `<span class="dot ${d.director.busy ? 'busy' : 'idle'}" style="display:inline-block;width:7px;height:7px;margin:0 4px 0 0;vertical-align:middle"></span>` + (d.director.busy ? '작업 중' : '대기') + ` · ${d.director.term ? 't:' + d.director.term : 'c:' + d.director.console}` : '<span class="dot dead" style="display:inline-block;width:7px;height:7px;margin:0 4px 0 0;vertical-align:middle"></span>실행 중 아님 (워치독이 자동 재개)'} · 시작 ${esc(d.created_at ? new Date(d.created_at).toLocaleDateString(uiLocale()) : '-')} · 갱신 ${d.updated_at ? relTime(Date.parse(d.updated_at)) : '-'}</div>
        ${d.workers?.length ? `<div><span class="empty">워커</span> ${d.workers.map((w) => `<span class="badge">${esc(w.id)} ${esc(w.status || '')}</span>`).join(' ')}</div>` : ''}
        ${myGpu.length ? `<div><span class="empty">GPU</span> ${myGpu.map((t) => `<span class="badge c">${esc(t.label || t.id)}</span>`).join(' ')}</div>` : ''}
      </div>
      <section class="list-sec">
        <div class="list-sec-hd"><h4>최근 활동</h4><button data-rtab="activity" class="ghost btn-sm">전체 기록 →</button></div>
        <div class="tl">${items.map((x) => `<div class="tli"><span class="tlt">${relTime(x.ts)}</span><span>${esc(x.text)}</span></div>`).join('') || '<div class="empty">아직 기록 없음</div>'}</div>
      </section>`;
  } else if (tab === 'report') {
    body = `<div class="r-doc"><div class="row" style="justify-content:flex-end;margin-bottom:8px"><button class="ghost btn-sm" data-rcopy="report">${ICO.copy} 마크다운 복사</button></div><div class="rcard">${d.final ? md(d.final) + '<hr>' : ''}${md(d.report)}</div></div>`;
  } else if (tab === 'plan') {
    body = `<div class="r-doc"><div class="row" style="justify-content:flex-end;margin-bottom:8px"><button class="ghost btn-sm" data-rcopy="plan">${ICO.copy} 마크다운 복사</button></div><div class="rcard">${md(d.plan)}</div></div>`;
  } else if (tab === 'activity') {
    const sub = state.rActSub || 'timeline';
    const items = journalItems(d.journal).reverse();
    const sbtn = (k, lbl) => `<button data-ract-sub="${k}" class="${sub === k ? 'on' : ''}">${lbl}</button>`;
    const subContent = sub === 'timeline'
      ? `<div class="tl">${items.map((x) => `<div class="tli"><span class="tlt" title="${esc(new Date(x.ts).toLocaleString(uiLocale()))}">${esc(new Date(x.ts).toLocaleString(uiLocale(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }))}</span><span>${esc(x.text)}</span></div>`).join('') || '<div class="empty">없음</div>'}</div>`
      : sub === 'decisions' ? `<div class="rcard r-doc">${md(d.decisions)}</div>`
        : sub === 'failed' ? `<div class="rcard r-doc">${md(d.failed)}</div>`
          : `<pre class="mdpre">${esc(d.harnessLog || '(로그 없음)')}</pre>`;
    body = `<div class="row" style="margin-bottom:6px"><div class="seg" role="tablist">${sbtn('timeline', '타임라인')}${sbtn('decisions', '결정')}${sbtn('failed', '실패 기록')}${sbtn('log', '하네스 로그')}</div></div>${subContent}`;
  } else if (tab === 'outputs') {
    const outs = d.outputs || [];
    const INTERNAL = /^(CLAUDE|JOURNAL|INBOX|DECISIONS|FAILED|QUESTIONS|MEMORY|README|BRIEF|STATE)\.md$/i;
    const isMain = (f) => ['video', 'audio', 'pdf', 'image', 'html'].includes(f.kind) || /^(docx|xlsx|pptx|ply|glb|obj)$/.test(f.ext)
      || (f.kind === 'markdown' && !INTERNAL.test(f.name)) || /(^|\/)main\.tex$/i.test(f.path);
    const main = outs.map((f, i) => [f, i]).filter(([f]) => isMain(f));
    const card = ([f, i]) => `<div class="acard" data-rout="${i}">
        <div class="athumb">${f.kind === 'image' ? `<img loading="lazy" src="${rRawUrl(slug, f.path)}" alt="">` : `<span>${ART_ICON[f.kind] || ART_ICON.file}</span>`}</div>
        <div class="ameta"><b title="${esc(f.path)}">${esc(f.name)}</b>
          <span class="ums">${esc(f.path.split('/').slice(0, -1).join('/') || '(루트)')} · ${fmtSize(f.size)} · ${relTime(f.mtime)}</span></div><button class="asend" data-rsend="${i}" aria-label="세션에 보내기" title="이 파일을 세션에 보내기 (경로 멘션)">↗</button></div>`;
    const head = `<div class="row" style="padding:2px 2px 8px">
      <div class="seg" role="tablist">
        <button data-rout-mode="main" class="${!state.rOutAll ? 'on' : ''}">주요 산출물 <span class="seg-cnt">${main.length}</span></button>
        <button data-rout-mode="all" class="${state.rOutAll ? 'on' : ''}">폴더별 전체 <span class="seg-cnt">${outs.length}</span></button>
      </div>
      <span class="sp"></span>
      ${state.rOutAll ? '' : artOrderSel()}
    </div>`;
    if (!state.rOutAll) {
      body = head + (main.length ? artTimeline(main, card) : '<div class="empty" style="padding:16px">아직 영상·PDF·그림·문서 산출물이 없습니다. "폴더별 전체"에서 코드·데이터를 볼 수 있습니다.</div>');
    } else {
      const groups = {};
      outs.forEach((f, i) => {
        const segs = f.path.split('/').slice(0, -1);
        const g = segs.length ? segs.slice(0, 2).join('/') : '(루트)';
        (groups[g] = groups[g] || []).push([f, i]);
      });
      body = head + (Object.entries(groups).map(([g, fs]) => `<section class="list-sec"><div class="list-sec-hd"><h4>${esc(g)}</h4><span class="badge">${fs.length}</span></div>${fs.map(([f, i]) => `<div class="ofile" data-rout="${i}"><span>${ART_ICON[f.kind] || ART_ICON.file} ${esc(f.path.slice(g === '(루트)' ? 0 : g.length + 1))}</span><span class="empty">${fmtSize(f.size)} · ${relTime(f.mtime)}</span></div>`).join('')}</section>`).join('') || '<div class="empty" style="padding:16px">아직 산출물이 없습니다.</div>');
    }
  } else if (tab === 'settings') {
    body = `<section class="list-sec r-doc">
        <div class="list-sec-hd"><h4>연구 설정</h4></div>
        <div class="list-row"><div class="list-row-main"><b>목표 지점</b><div class="ums">이 단계의 게이트를 통과하면 디렉터가 스스로 마무리합니다.</div></div>
          <div class="list-row-acts"><select id="rGoal">${Object.entries(GOAL_KO).map(([k, v]) => `<option value="${k}" ${k === prog.goal ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select><button class="primary btn-sm" id="rGoalSave">저장</button></div></div>
        <div class="list-row"><div class="list-row-main"><b>목표 학회·저널</b><div class="ums">${esc(d.config?.venue_hint || '(디렉터가 조사해 결정)')}${d.config?.deadline ? ` · 마감 ${esc(d.config.deadline)}` : ''}</div></div></div>
        <div class="list-row"><div class="list-row-main"><b>폴더 경로</b><div class="ums mono">${esc(d.dir)}</div></div><button class="ghost btn-sm" id="rCopyDir">${ICO.copy} 복사</button></div>
      </section>
      <div class="rcard r-doc"><b>연구 브리프 (처음 주신 방향)</b>${md(d.brief)}</div>
      <details class="rsec r-doc"><summary>보낸 메시지 (INBOX.md)</summary><div class="rsecb">${md(d.inbox)}</div></details>`;
  }
  const hadFocus = document.activeElement?.id === 'rMsg';
  const caret = hadFocus ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
  const scrollers = [...$('#view').querySelectorAll('*'), $('#view')].filter((el) => el.scrollTop > 0).map((el) => [el.className, el.scrollTop]);
  const footer = tab === 'overview'
    ? `<div class="r-footer"><input id="rMsg" style="flex:1;min-width:160px" placeholder="디렉터에게 지시·방향 수정 보내기 (작업 중이면 다음 턴에 반영)"><button class="${d.status === 'blocked' ? '' : 'primary'}" data-ract="send">보내기</button></div>`
    : '';
  $('#view').innerHTML = `<div class="r-shell">${tabs}<div class="r-body"><div class="rwrap">${body}</div></div>${footer}</div>`;
  for (const [cls, top] of scrollers) { const el = cls === $('#view').className ? $('#view') : $('#view').getElementsByClassName(cls)[0]; if (el) el.scrollTop = top; }
  const mi = $('#rMsg');
  if (mi) {
    mi.value = msgVal;
    mi.onkeydown = (e) => { if (e.key === 'Enter' && !e.isComposing) researchAction(slug, 'send'); };
    mi.addEventListener('compositionstart', () => { rComposing = true; });
    mi.addEventListener('compositionend', () => { rComposing = false; });
    if (hadFocus) { mi.focus(); try { mi.setSelectionRange(caret[0], caret[1]); } catch {} }
  }
  if (tab === 'outputs') {
    const outs = d.outputs || [];
    $('#view').querySelectorAll('[data-rout-mode]').forEach((b) => (b.onclick = () => { state.rOutAll = b.dataset.routMode === 'all'; rCache.json = ''; paintResearch(); }));
    bindArtOrder(() => { rCache.json = ''; paintResearch(); });
    $('#view').querySelectorAll('[data-rout]').forEach((el) => (el.onclick = (e) => {
      const f = outs[Number(el.dataset.rout)];
      const abs = rAbs(d.dir, f.path);
      if (e.target.closest('[data-rsend]')) return sendPathDialog(abs);
      openArtifact(null, { ...f, title: f.path, abs }, rRawUrl(slug, f.path));
    }));
  }
  const gs = $('#rGoalSave');
  if (gs) gs.onclick = async () => { await api('/api/research/goal', { method: 'POST', body: { slug, goal: $('#rGoal').value } }); toast('목표 지점을 바꿨습니다'); rCache.json = ''; paintResearch(); };
  const cd = $('#rCopyDir');
  if (cd) cd.onclick = () => copyText(d.dir);
}
