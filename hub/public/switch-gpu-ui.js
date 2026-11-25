// ---------- account switch drawer (accessible via session/terminal ⋯ menu) ----------
document.addEventListener('click', (e) => {
  const mt = e.target.closest('[data-mermaid-toggle]');
  if (mt) {
    e.stopPropagation();
    const card = mt.closest('.mermaid-card');
    const host = card?.querySelector('.mermaid-host');
    const srcEl = card?.querySelector('.mermaid-src');
    if (host && srcEl) {
      const showSrc = srcEl.hidden;
      srcEl.hidden = !showSrc;
      host.hidden = showSrc;
      mt.textContent = showSrc ? '다이어그램 보기' : '코드 보기';
    }
    return;
  }
  const pc = e.target.closest('[data-preview-code]');
  if (pc) {
    e.stopPropagation();
    const blk = pc.closest('.codeblk');
    const host = blk?.querySelector('.mermaid-host');
    const pre = blk?.querySelector('.mermaid-src') || blk?.querySelector('.mdpre');
    const code = host ? (host.dataset.mermaidSrc || '') : (pre?.textContent || '');
    const lang = pc.dataset.previewCode || 'html';
    if (code) window.ACH_PREVIEW?.openCode({ lang, code });
    return;
  }
  const cb = e.target.closest('[data-copy-code]');
  if (cb) {
    e.stopPropagation();
    const blk = cb.closest('.codeblk');
    const pre = blk?.querySelector('.mermaid-src') || blk?.querySelector('.mdpre');
    if (pre) copyText(pre.textContent);
  }
}, true);
async function runSwitchRequest(payload) {
  let res = await api('/api/switch', { method: 'POST', body: payload });
  if (res.busy && confirm('세션이 작업 중입니다. 중단(Esc)하고 전환할까요?')) {
    res = await api('/api/switch', { method: 'POST', body: { ...payload, interrupt: true } });
  }
  if (res.stuck && confirm(res.error)) {
    res = await api('/api/switch', { method: 'POST', body: { ...payload, interrupt: true, force: true } });
  }
  return res;
}

async function openSwitch(sid, termId = '') {
  const d = openDrawer({
    title: '다른 계정 · 에이전트로 이어하기',
    bodyHTML: '<div id="swBody">AI 사용량 및 계정 확인 중…</div>',
    footerHTML: '<button data-drw-close>취소</button><button class="primary" id="swGo" disabled>이어하기</button>',
    width: 520,
  });
  const r = await api(`/api/switch/candidates?id=${encodeURIComponent(sid)}${termId ? `&term=${encodeURIComponent(termId)}` : ''}`).catch((e) => ({ error: e.message }));
  if (r?.accountPrefs && typeof syncServerAccountPrefs === 'function') syncServerAccountPrefs(r.accountPrefs);
  const body = $('#swBody', d);
  if (r.error || !r.candidates) { body.innerHTML = `<div class="err">${esc(r.error || '후보를 불러오지 못함')}</div>`; return; }
  const s = state.live.find((x) => x.sessionId === sid);
  const srcAgent = r.sourceAgent || 'claude';
  const agentName = (a) => (a === 'codex' ? 'Codex' : a === 'agy' ? 'Antigravity / Gemini' : 'Claude Code');
  const pct = (v) => (v === null || v === undefined ? '<span class="up">?</span>' : `${bar(v, true)}<span class="up ${level(v)}">${Math.max(0, Math.round(100 - v))}%</span>`);
  const rowHTML = (c) => `<label class="swrow${c.usable && !c.current ? '' : ' dis'}" data-agent="${esc(c.agent || 'claude')}">
        <input type="radio" name="acc" value="${esc(c.id)}" data-agent="${esc(c.agent || 'claude')}" ${c.best ? 'checked' : ''} ${c.usable && !c.current ? '' : 'disabled'}>
        <span class="swl" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
          ${agentIcon(c.agent || 'claude')}
          <span>${esc(c.label)}</span>
          ${c.current ? `<span class="badge">${c.sameAccount ? '현재와 같은 계정' : '현재 실행 중'}</span>` : (c.active ? '<span class="badge ok">● AGY 활성</span>' : '')}
          ${c.best ? '<span class="badge c">가장 여유</span>' : ''}
        </span>
        <span class="swm">5h ${pct(c.fiveH)}</span><span class="swm">주 ${pct(c.weekly)}</span></label>`;
  const samePlat = r.candidates.filter((c) => !c.agent || c.agent === srcAgent);
  const crossPlat = r.candidates.filter((c) => c.agent && c.agent !== srcAgent);
  const meFieldsHTML = `<div class="pj-me-grid" style="margin:8px 0 2px">
    <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--muted)">모델
      <select name="modelPick"></select>
      <input name="model" maxlength="120" placeholder="모델 ID 직접 입력" style="display:none;margin-top:4px">
    </label>
    <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--muted)">추론 성능
      <select name="effort"></select>
    </label>
  </div><small data-cli-opt-hint class="ums" style="margin:0 0 4px"></small>`;
  body.innerHTML = `
    ${s?.limit ? `<div class="err" style="padding:0 0 6px">${esc(s.limit.text)}</div>` : ''}
    <div class="empty" style="padding:0 0 4px">숫자는 남은 한도(%) 기준입니다. 같은 플랫폼은 그대로 재개하고, 다른 플랫폼은 직전 맥락(handoff)을 자동 인계합니다.</div>
    <div class="swlist">
      ${samePlat.length ? `<div class="swgrp-hd">같은 플랫폼 · 즉시 재개</div>${samePlat.map(rowHTML).join('')}` : ''}
      ${crossPlat.length ? `<div class="swgrp-hd">다른 플랫폼 · 맥락 교차 인계</div>${crossPlat.map(rowHTML).join('')}` : ''}
    </div>
    ${meFieldsHTML}
    <div class="row" style="gap:14px;padding:6px 0 2px;flex-wrap:wrap">
      <span class="ums" style="font-weight:600;color:var(--text)">열기 위치:</span>
      <label class="row" style="gap:5px"><input type="radio" name="swMode" value="dashboard" checked> 대시보드 터미널</label>
      <label class="row" style="gap:5px"><input type="radio" name="swMode" value="external"> 외부 Windows 콘솔 창</label>
    </div>
    <label class="row"><input type="checkbox" id="swCont"> 전환 후 즉시 “계속 진행해” 자동 실행 (교차 플랫폼은 미체크여도 맥락 파일은 항상 전달)</label>
    <label class="row" id="swSkipRow"><input type="checkbox" id="swSkip" checked> YOLO 모드 자동 승인으로 실행 (Claude · Codex · Antigravity)</label>
    <div id="swHint" class="empty" style="padding:4px 0 0"></div>`;
  const goBtn = $('#swGo', d);
  if (goBtn) goBtn.disabled = !r.candidates.some((c) => c.best || (c.usable && !c.current));
  const initSelAcc = $('input[name=acc]:checked', d);
  const initSelAgent = initSelAcc?.dataset.agent || srcAgent;
  const swMeCtl = typeof createCliModelEffortController === 'function'
    ? createCliModelEffortController({
      modelPick: d.querySelector('[name=modelPick]'),
      modelIn: d.querySelector('[name=model]'),
      effortSel: d.querySelector('[name=effort]'),
      hintEl: d.querySelector('[data-cli-opt-hint]'),
      initialKind: initSelAgent,
      getAccount: () => $('input[name=acc]:checked', d)?.value || '',
    })
    : null;
  const updateHint = () => {
    const sel = $('input[name=acc]:checked', d);
    const targetAgent = sel?.dataset.agent || srcAgent;
    const accSaved = (sel?.value && typeof readSavedAccountPref === 'function') ? readSavedAccountPref(sel.value, targetAgent) : null;
    if (accSaved) swMeCtl?.setCli(targetAgent, accSaved.model, accSaved.effort);
    else swMeCtl?.setCli(targetAgent);
    const mode = $('input[name=swMode]:checked', d)?.value || 'dashboard';
    const whereTxt = mode === 'external' ? '새 Windows 외부 콘솔 창' : '대시보드 터미널';
    const skipRow = $('#swSkipRow', d);
    if (skipRow) skipRow.style.display = (targetAgent === 'claude' || targetAgent === 'agy') ? 'flex' : 'none';
    const hint = $('#swHint', d);
    if (!hint) return;
    if (targetAgent !== srcAgent) {
      hint.innerHTML = isEnUI()
        ? `<b>${esc(agentName(srcAgent))} → ${esc(agentName(targetAgent))} handoff:</b> Saves recent conversation context to <code>handoff.md</code>, then starts a ${esc(agentName(targetAgent))} session in ${whereTxt} with it.`
        : `<b>${esc(agentName(srcAgent))} → ${esc(agentName(targetAgent))} 교차 이동:</b> 최근 대화 맥락을 요약 파일(<code>handoff.md</code>)로 저장한 뒤 ${whereTxt}에서 ${esc(agentName(targetAgent))} 세션을 시작하여 자동으로 전달합니다.`;
    } else if (r.fresh) {
      hint.textContent = isEnUI()
        ? `This terminal has no conversation yet; starting fresh in the same folder (${whereTxt}) with the selected account.`
        : `아직 대화가 없는 터미널이라, 같은 폴더(${whereTxt})에서 고른 계정으로 새로 시작합니다.`;
    } else if (r.live) {
      hint.textContent = isEnUI()
        ? `Closes the running session (${r.where || 'no window'}) and continues the same conversation in ${whereTxt}.`
        : `실행 중인 세션(${r.where || '창 없음'})을 종료한 뒤 ${whereTxt}에서 같은 대화를 이어갑니다.`;
    } else {
      hint.textContent = isEnUI()
        ? `Continues this conversation with the selected account in ${whereTxt}.${r.stale ? ' · Usage data may be stale' : ''}`
        : `선택한 계정으로 ${whereTxt}에서 대화를 이어 실행합니다.${r.stale ? ' · 사용량 값이 오래됐을 수 있음' : ''}`;
    }
  };
  d.querySelectorAll('input[name=acc], input[name=swMode]').forEach((el) => (el.onchange = updateHint));
  updateHint();
  $('#swGo', d).onclick = async () => {
    const acc = $('input[name=acc]:checked', d)?.value;
    if (!acc) return;
    const openMode = $('input[name=swMode]:checked', d)?.value || 'dashboard';
    const meVals = swMeCtl ? swMeCtl.getValues() : { model: '', effort: '' };
    const targetAg = $('input[name=acc]:checked', d)?.dataset.agent || srcAgent;
    if (typeof saveAccountPref === 'function') saveAccountPref({ account: acc, cli: targetAg, model: meVals.model, effort: meVals.effort });
    else if (typeof saveCliDefaults === 'function') saveCliDefaults(targetAg, { account: acc, model: meVals.model, effort: meVals.effort });
    const go = $('#swGo', d); go.disabled = true; go.textContent = '전환 중…';
    const payload = {
      sessionId: sid || undefined,
      termId: termId || undefined,
      account: acc,
      model: meVals.model,
      effort: meVals.effort,
      cont: $('#swCont', d).checked,
      skip: $('#swSkip', d)?.checked ?? true,
      openMode,
    };
    const res = await runSwitchRequest(payload);
    if (!res.ok) { go.disabled = false; go.textContent = '이어하기'; if (!res.busy) body.insertAdjacentHTML('afterbegin', `<div class="err" style="padding:0 0 8px">${esc(res.error)}</div>`); return; }
    d.close();
    await refreshOverview();
    const shortLabel = (res.account?.label || acc).replace(/@.*/, '');
    if (res.external) {
      toast(`${shortLabel} 계정으로 외부 콘솔 창에서 이어서 실행했습니다`);
    } else if (res.term) {
      select({ kind: 'term', id: res.term.id });
      toast(`${shortLabel}${res.crossPlatform ? ' (교차 인계)' : ''} 계정으로 이어서 실행`);
    }
  };
}

// ---------- GPU / resource queue ----------
const fmtMB = (m) => (m >= 1024 ? `${(m / 1024).toFixed(1)}G` : `${Math.round(m)}M`);
async function refreshGpu() {
  try { state.gpu = await api('/api/gpu'); } catch { return; }
  renderSide();
  refreshHomeWidgets();
  if (state.sel.kind === 'gpu') paintGpu();
}
function openGpuHelpDrawer() {
  const body = `
    <div class="empty" style="padding:0">세션·에이전트에서 GPU 대기열을 통해 작업을 안전하게 예약/실행합니다.</div>
    <pre class="mdpre">ccd gpu run --mem 20G --label exp-003 -- python train.py   # 차례가 되면 실행, 끝나면 자동 해제
ccd gpu run --exclusive -- python big_job.py              # GPU 전체를 혼자 사용
ccd gpu request --mem 8G --wait  →  ccd gpu release &lt;id&gt;  # 직접 잡고 놓기
ccd gpu                                                  # 상태·대기열 (GPU별 줄)
ccd gpu plan --mem 12G --est 2h                          # GPU별 시작·종료 예상</pre>
    <div class="empty" style="padding:0"><b>끼워넣기(Backfill):</b> 맨 앞 작업의 예상 시작 시각 전에 끝나거나 자리를 남기는 작업만 먼저 실행합니다. 예상 시간은 행의 시계 버튼 또는 <code>--est 90m</code>으로 설정하세요.</div>`;
  openDrawer({ title: 'GPU 대기열 CLI 사용법', bodyHTML: body, width: 540 });
}
function openGpuJobDrawer(t, isWaiting) {
  if (!t) return;
  const mins = (ms) => { const m = Math.round(ms / 60000); return m >= 60 ? `${Math.floor(m / 60)}시간 ${m % 60}분` : `${m}분`; };
  const who = t.requester?.title || (t.requester?.pid ? `pid ${t.requester.pid}` : '알 수 없음');
  const body = `
    <div>
      <div class="drw-kv"><span>상태</span><b>${isWaiting ? `대기 중 (${t.position}번째 · ${mins(t.waitedMs)})` : `사용 중 (${mins(Date.now() - t.grantedAt)})`}</b></div>
      <div class="drw-kv"><span>GPU</span><b>${esc(isWaiting && t.lanes?.length ? t.lanes.join(' · ') : t.gpu || '—')}</b></div>
      <div class="drw-kv"><span>메모리</span><b>${t.exclusive ? '전용 사용' : t.memMB == null ? '미측정' : fmtMB(t.memMB)}</b></div>
      <div class="drw-kv"><span>요청 세션</span><b>${esc(who)}</b></div>
      ${t.expectedStart ? `<div class="drw-kv"><span>예상 시작</span><b>${esc(new Date(t.expectedStart).toLocaleTimeString(uiLocale(), { hour: '2-digit', minute: '2-digit' }))}</b></div>` : ''}
      ${t.expectedEnd ? `<div class="drw-kv"><span>예상 종료</span><b>${esc(new Date(t.expectedEnd).toLocaleTimeString(uiLocale(), { hour: '2-digit', minute: '2-digit' }))}${t.estSource === 'learned' ? ' (학습됨)' : ''}</b></div>` : ''}
      ${t.adopted ? '<div class="drw-kv"><span>감지 방식</span><b>대기열 밖 프로세스 자동 등록</b></div>' : ''}
      ${t.backfilled ? '<div class="drw-kv"><span>배정</span><b>끼워넣기(Backfill)</b></div>' : ''}
    </div>
    ${t.command ? `<div class="drw-sec"><div class="drw-lbl">실행 명령</div><pre class="mdpre">${esc(t.command)}</pre></div>` : ''}`;
  const foot = `
    <button class="danger ghost" data-dg="release">${t.adopted ? '등록 해제' : isWaiting ? '대기 취소' : '예약 해제'}</button>
    <span class="sp"></span>
    ${isWaiting && t.position > 1 ? '<button data-dg="top">맨 앞으로</button>' : ''}
    <button class="primary" data-dg="est">${ICO.clock} 예상 시간</button>`;
  const d = openDrawer({ title: t.label || t.id, bodyHTML: body, footerHTML: foot, width: 460 });
  d.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-dg]')?.dataset.dg;
    if (!a) return;
    if (a === 'est') {
      d.close();
      return openEstimateDialog({
        title: '예상 시간 설정',
        onSubmit: async (v) => {
          const r = await api('/api/gpu/est', { method: 'POST', body: /^\d{1,2}:\d{2}$/.test(v) ? { id: t.id, until: v } : { id: t.id, est: v } });
          toast(r.ok ? `예상 ${r.estMin}분으로 설정` : r.error, 4000, r.ok ? 'default' : 'danger');
          refreshGpu();
        },
      });
    }
    if (a === 'release' && !confirm('대기열에서 빼시겠어요? 실행 중인 프로세스는 종료되지 않습니다.')) return;
    d.close();
    await api(a === 'top' ? '/api/gpu/priority' : '/api/gpu/release', { method: 'POST', body: { id: t.id, byUser: true } });
    refreshGpu();
  });
}

function openGpuDeviceDrawer(g) {
  if (!g) return;
  const ext = Math.max(0, g.usedMB - g.leasedMB), freeMB = Math.max(0, g.totalMB - g.usedMB);
  const memPct = g.totalMB ? Math.round((g.usedMB / g.totalMB) * 100) : 0;
  const seg = (mb, cls) => g.totalMB ? `<i class="${cls}" style="width:${(mb / g.totalMB) * 100}%"></i>` : '';
  const procList = (g.activeProcs?.length ? g.activeProcs : g.procs) || [];
  const clkInfo = [g.pstate ? `${g.pstate}${/^P[358]$/i.test(g.pstate) ? ' (절전 유휴)' : ''}` : '', g.clockMHz ? `${g.clockMHz}${g.maxClockMHz ? '/' + g.maxClockMHz : ''} MHz` : ''].filter(Boolean).join(' · ');
  const body = `
    <div class="um"><div class="umt"><span>GPU 코어 사용률</span><span class="up ${level(g.util)}">${g.util}%</span></div>${bar(g.util)}</div>
    <div class="um"><div class="umt"><span>VRAM · ${fmtMB(g.usedMB)} / ${fmtMB(g.totalMB)} (여유 ${fmtMB(freeMB)})</span><span class="up ${level(memPct)}">${memPct}%</span></div>
      ${g.leasedMB > 0
        ? `<span class="ubar gstack">${seg(Math.min(g.leasedMB, g.usedMB), 'lease')}${seg(ext, 'ext')}</span>
           <div class="ums"><span class="lg lease"></span>대기열 예약 ${fmtMB(g.leasedMB)} · <span class="lg ext"></span>기타 ${fmtMB(ext)}</div>`
        : bar(memPct)}</div>
    <div>
      ${Number.isFinite(g.tempC) ? `<div class="drw-kv"><span>온도</span><b>${g.tempC}°C${g.hot ? ' (과열 — 배정 보류)' : ''}</b></div>` : ''}
      ${g.powerW != null ? `<div class="drw-kv"><span>소비 전력</span><b>${g.powerW}W${g.powerLimitW ? ` / ${g.powerLimitW}W` : ''}</b></div>` : ''}
      ${clkInfo ? `<div class="drw-kv"><span>클럭 상태</span><b>${esc(clkInfo)}</b></div>` : ''}
    </div>
    <div class="drw-sec">
      <div class="drw-lbl">활성 GPU 프로세스 (${procList.length})</div>
      ${procList.length ? procList.map((p) => `<div class="drw-kv"><span>${esc(p.name)}</span><b>${p.sm ? `${p.sm}%` : p.memMB ? fmtMB(p.memMB) : '실행 중'}</b></div>`).join('') : '<div class="empty" style="padding:0">활성 프로세스 없음</div>'}
    </div>`;
  openDrawer({ title: `${g.server ? g.server + ' · ' : ''}GPU ${g.index} · ${g.name}`, bodyHTML: body, footerHTML: '<button data-drw-close>닫기</button>', width: 460 });
}

function viewGpu() {
  setBar('');
  $('#view').onclick = async (e) => {
    const sysTab = e.target.closest('[data-systab]');
    if (sysTab) return select({ kind: sysTab.dataset.systab });
    if (e.target.closest('#btnGpuHelp')) return openGpuHelpDrawer();
    const gr = e.target.closest('#btnGpuRefresh');
    if (gr) {
      gr.disabled = true;
      await refreshGpu();
      if (gr.isConnected) gr.disabled = false;
      toast('GPU 대기열 및 장치 상태를 갱신했습니다');
      return;
    }
    const tabBtn = e.target.closest('[data-gtab]');
    if (tabBtn) { state.gpuTab = tabBtn.dataset.gtab; return paintGpu(); }
    const tg = e.target.closest('[data-gtoggle]');
    if (tg) {
      e.stopPropagation();
      const on = tg.dataset.on !== '1';
      const offMsg = isEnUI()
        ? `Turn ${tg.dataset.gtoggle} OFF? No new jobs will be assigned; running jobs will continue.`
        : `${tg.dataset.gtoggle}을(를) OFF로 바꿀까요? 새 작업을 배정하지 않습니다. 이미 실행 중인 작업은 그대로 계속됩니다.`;
      if (!on && !confirm(offMsg)) return;
      await api('/api/gpu/toggle', { method: 'POST', body: { key: tg.dataset.gtoggle, enabled: on } });
      toast(`${tg.dataset.gtoggle} → ${on ? 'ON (사용 가능)' : 'OFF (배정 중지)'}`);
      return refreshGpu();
    }
    const b = e.target.closest('[data-gact]');
    if (b) {
      e.stopPropagation();
      const { gact, id } = b.dataset;
      if (gact === 'est') {
        return openEstimateDialog({
          title: '예상 시간 설정',
          onSubmit: async (v) => {
            const r = await api('/api/gpu/est', { method: 'POST', body: /^\d{1,2}:\d{2}$/.test(v) ? { id, until: v } : { id, est: v } });
            toast(r.ok ? `예상 ${r.estMin}분으로 설정` : r.error, 4000, r.ok ? 'default' : 'danger');
            refreshGpu();
          },
        });
      }
      if (gact === 'release' && !confirm('대기열에서 빼시겠어요? 실행 중인 프로세스는 종료되지 않습니다. 자동 등록된 작업은 다시 등록되지 않습니다.')) return;
      await api(gact === 'top' ? '/api/gpu/priority' : '/api/gpu/release', { method: 'POST', body: { id, byUser: true } });
      return refreshGpu();
    }
    const jRow = e.target.closest('[data-gjob]');
    if (jRow) {
      const q = state.gpu || {};
      const id = jRow.dataset.gjob;
      const act = (q.active || []).find((x) => String(x.id) === id);
      if (act) return openGpuJobDrawer(act, false);
      const wait = (q.waiting || []).find((x) => String(x.id) === id);
      if (wait) return openGpuJobDrawer(wait, true);
    }
    const dCard = e.target.closest('[data-gdev]');
    if (dCard) {
      const g = (state.gpu?.gpus || []).find((x) => String(x.key || x.index) === dCard.dataset.gdev);
      if (g) openGpuDeviceDrawer(g);
    }
  };
  paintGpu();
}
function paintGpu() {
  const q = state.gpu;
  const sysTop = systemTopHTML('gpu', `<button class="ghost btn-sm" id="btnGpuHelp">${ICO.help} CLI 사용법</button><button class="btn-sm" id="btnGpuRefresh" title="GPU 대기열 및 장치 상태 지금 갱신">${ICO.refresh} 새로고침</button>`);
  if (!q) { $('#view').innerHTML = `<div class="sys-shell">${sysTop}<div class="sys-body"><div class="page-wrap"><div class="empty">불러오는 중…</div></div></div></div>`; return; }
  const tab = state.gpuTab || 'queue';
  const mins = (ms) => { const m = Math.round(ms / 60000); return m >= 60 ? `${Math.floor(m / 60)}시간 ${m % 60}분` : `${m}분`; };
  const sw = (key, on) => `<button class="sw ${on ? 'on' : ''}" data-gtoggle="${esc(key)}" data-on="${on ? 1 : 0}" title="사용 가능 여부"><i></i>${on ? 'ON' : 'OFF'}</button>`;

  const ram = q.ram?.totalMB ? q.ram : null;
  const ramUsed = ram ? Math.max(0, ram.totalMB - ram.freeMB) : 0;
  const ramPct = ram ? Math.round((ramUsed / ram.totalMB) * 100) : 0;
  const cpuUtil = q.cpu?.util ?? 0;
  const active = q.active || [], waiting = q.waiting || [], history = q.history || [];
  const validGpus = (q.gpus || []).filter((g) => g.index >= 0);

  const tabs = `<div class="tablist gpu-tabs" role="tablist" aria-label="GPU 대기열 보기">
    <button role="tab" data-gtab="queue" aria-selected="${tab === 'queue'}" class="${tab === 'queue' ? 'on' : ''}">작업 대기열 <span class="badge" style="margin-left:4px">${active.length + waiting.length}</span></button>
    <button role="tab" data-gtab="devices" aria-selected="${tab === 'devices'}" class="${tab === 'devices' ? 'on' : ''}">GPU · 서버 장치 <span class="badge" style="margin-left:4px">${validGpus.length + (q.servers?.length || 0)}</span></button>
    <button role="tab" data-gtab="history" aria-selected="${tab === 'history'}" class="${tab === 'history' ? 'on' : ''}">최근 기록 <span class="badge" style="margin-left:4px">${history.length}</span></button>
  </div>`;

  let content = '';
  if (tab === 'queue') {
    const qRow = (t, isWaiting) => `<div class="m-row" data-gjob="${esc(t.id)}">
      <span class="dot ${isWaiting ? 'busy' : 'idle'}"></span>
      <div class="m-row-main">
        <div class="m-row-t">${esc(t.label || t.id)}</div>
        <div class="m-row-s">${esc(isWaiting && t.lanes?.length ? t.lanes.join(' · ') : t.gpu || 'GPU')} · ${t.exclusive ? '전용' : t.memMB == null ? '메모리 미측정' : fmtMB(t.memMB)} · ${isWaiting ? `대기 ${mins(t.waitedMs)}` : `사용 ${mins(Date.now() - t.grantedAt)}`}</div>
      </div>
      <div class="m-row-end">
        <button class="ghost icon-btn btn-sm" data-gact="est" data-id="${esc(t.id)}" aria-label="예상 시간 설정" title="예상 시간 설정">${ICO.clock}</button>
        <button class="danger ghost btn-sm" data-gact="release" data-id="${esc(t.id)}">${t.adopted ? '등록 해제' : isWaiting ? '취소' : '해제'}</button>
      </div>
    </div>`;
    content = !active.length && !waiting.length ? `<div class="h-empty-card">
      <h2>GPU 작업이 없습니다</h2>
      <span>${validGpus.length ? `감지된 GPU ${validGpus.length}개 · 사용 가능 ${validGpus.filter((g) => g.enabled !== false).length}개` : '감지된 GPU가 없습니다'}</span>
      <button type="button" class="btn-sm" data-gtab="devices">GPU · 서버 장치 보기</button>
    </div>` : `<h1 class="sr-only">GPU 대기열</h1>
      <section class="sheet">
        <div class="sheet-hd"><h2>사용 중 <span class="badge c">${active.length}</span></h2><span class="ums" style="margin:0">항목 클릭 시 상세 정보</span></div>
        ${active.map((t) => qRow(t, false)).join('') || '<div class="empty" style="padding:20px 16px">현재 GPU를 사용 중인 작업이 없습니다.</div>'}
      </section>
      <section class="sheet">
        <div class="sheet-hd"><h2>대기 중 <span class="badge">${waiting.length}</span></h2></div>
        ${waiting.map((t) => qRow(t, true)).join('') || '<div class="empty" style="padding:20px 16px">대기 중인 작업이 없습니다.</div>'}
      </section>`;
  } else if (tab === 'devices') {
    const cpuCard = q.cpu ? `<div class="ucard compact">
      <div class="uh">${ICO.gpu}<b>CPU</b><span class="up ${level(cpuUtil)}" style="width:auto;font-size:14px;font-weight:700">${cpuUtil}%</span></div>
      ${bar(cpuUtil)}
      <div class="ums">${esc(q.cpu.model || '로컬 프로세서')}</div>
    </div>` : '';
    const ramCard = ram ? `<div class="ucard compact">
      <div class="uh">${ICO.gpu}<b>RAM</b><span class="up ${level(ramPct)}" style="width:auto;font-size:14px;font-weight:700">${ramPct}%</span></div>
      ${bar(ramPct)}
      <div class="ums">${fmtMB(ramUsed)} / ${fmtMB(ram.totalMB)} (여유 ${fmtMB(ram.freeMB)})</div>
    </div>` : '';
    const cards = validGpus.map((g) => {
      const memPct = g.totalMB ? Math.round((g.usedMB / g.totalMB) * 100) : 0;
      return `<div class="ucard click" data-gdev="${esc(g.key || g.index)}">
        <div class="uh">${ICO.gpu}<b>${esc(g.server ? g.server + ' · ' : '')}GPU ${g.index} · ${esc(g.name.replace(/NVIDIA |GeForce /gi, ''))}</b>${g.host === 'local' ? sw(g.key, g.enabled !== false) : ''}</div>
        ${g.error ? `<div class="err" style="padding:0">${esc(g.error)}</div>` : `
        <div style="display:flex;flex-direction:column;gap:8px">
          <div><div class="umt"><span>코어</span><span class="up ${level(g.util)}">${g.util}%</span></div>${bar(g.util)}</div>
          <div><div class="umt"><span>VRAM (${fmtMB(g.usedMB)}/${fmtMB(g.totalMB)})</span><span class="up ${level(memPct)}">${memPct}%</span></div>${bar(memPct)}</div>
        </div>
        <div class="ucard-foot"><span>${Number.isFinite(g.tempC) ? `${g.tempC}°C${g.hot ? ' · 과열' : ''}` : '상세 보기'}</span><span class="ico">${ICO.chevRight}</span></div>`}
      </div>`;
    }).join('');
    const servers = (q.servers || []).map((v) => `<div class="m-row" style="cursor:default">
      <span class="dot ${v.reachable == null ? 'dead' : v.reachable ? 'idle' : 'busy'}"></span>
      <div class="m-row-main"><div class="m-row-t">${esc(v.name)} <span class="badge">${esc(v.id)}</span></div><div class="m-row-s">${v.reachable == null ? '확인 중' : v.reachable ? '연결됨' : '연결 안 됨'}</div></div>
      ${sw(v.id, v.enabled)}
    </div>`).join('');
    content = `<h1 class="sr-only">GPU · 서버 장치</h1>${(cpuCard || ramCard) ? `<div class="ugrid-sys">${cpuCard}${ramCard}</div>` : ''}
      <div class="ugrid">${cards || `<div class="err">${esc(q.error || 'GPU를 찾지 못함 (nvidia-smi)')}</div>`}</div>
      ${servers ? `<section class="sheet"><div class="sheet-hd"><h2>원격 GPU 서버</h2></div>${servers}</section>` : ''}`;
  } else {
    const histRows = history.map((t) => `<div class="m-row" style="cursor:default">
      <span class="dot ${t.status === 'released' ? 'idle' : 'dead'}"></span>
      <div class="m-row-main"><div class="m-row-t">${esc(t.label || t.id)}</div><div class="m-row-s">${t.status === 'released' ? '해제됨' : '취소됨'}${t.endReason ? ` · ${esc(t.endReason)}` : ''}</div></div>
      <span class="ums" style="margin:0">${esc(new Date(t.endedAt).toLocaleTimeString(uiLocale()))}</span>
    </div>`).join('');
    content = `<h1 class="sr-only">GPU 최근 기록</h1><section class="sheet"><div class="sheet-hd"><h2>최근 작업 기록</h2></div>${histRows || '<div class="empty" style="padding:20px 16px">최근 기록이 없습니다.</div>'}</section>`;
  }
  $('#view').innerHTML = `<div class="sys-shell">${sysTop}<div class="sys-body"><div class="page-wrap">${tabs}${content}</div></div></div>`;
}

async function viewOperator() {
  setBar('');
  const render = (data, cliOpts) => {
    const sysTop = systemTopHTML('operator');
    const t = data.term;
    const optsMap = cliOpts?.options || {};
    const agents = [['claude', 'Claude Code'], ['codex', 'Codex CLI'], ['agy', 'Antigravity (AGY)']];
    const fillModels = (agent, selectedModel, selectedEffort) => {
      const o = optsMap[agent] || {};
      const models = o.models || [];
      const efforts = o.efforts || [];
      const modelHtml = [`<option value="">CLI 기본 모델</option>`,
        ...models.map((m) => `<option value="${esc(m.id)}"${m.id === selectedModel ? ' selected' : ''}>${esc(m.label || m.id)}</option>`)].join('');
      const effortHtml = [`<option value="">기본 추론</option>`,
        ...efforts.map((ef) => `<option value="${esc(ef.id)}"${ef.id === selectedEffort ? ' selected' : ''}>${esc(ef.label || ef.id)}</option>`)].join('');
      return { modelHtml, effortHtml };
    };
    const { modelHtml, effortHtml } = fillModels(data.agent, data.model, data.effort);
    const statusBadge = t
      ? `<span class="badge ok">실행 중 · t:${esc(t.id)} (${esc(t.agent || data.agent)})</span>`
      : '<span class="badge">실행 중 아님</span>';
    $('#view').innerHTML = `<div class="sys-shell">${sysTop}<div class="sys-body"><div class="page-wrap">
      <section class="sheet">
        <div class="sheet-hd">
          <div>
            <h2>🛰 관제 세션 설정</h2>
            <div class="ums" style="margin:4px 0 0">PC 환경·GPU·계정 한도·디스크를 점검하고 다른 세션에 공지를 전달하는 관제 세션의 CLI와 주기를 설정합니다.</div>
          </div>
          ${statusBadge}
        </div>
        <div style="display:flex;flex-direction:column;gap:14px;padding:14px 16px">
          <div class="row" style="gap:10px;flex-wrap:wrap;align-items:center">
            <span class="ums" style="margin:0">작업 폴더: <code class="mono">${esc(data.dir || '')}</code></span>
            ${t ? `<button type="button" class="btn-sm" id="opOpenTerm">관제 터미널 열기 ↗</button><button type="button" class="btn-sm danger ghost" id="opStop">중지</button>` : ''}
          </div>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px">
            <label style="display:flex;flex-direction:column;gap:5px">
              <span class="ums" style="margin:0">관제 CLI</span>
              <select id="opAgent">${agents.map(([id, lbl]) => `<option value="${id}"${data.agent === id ? ' selected' : ''}>${esc(lbl)}</option>`).join('')}</select>
            </label>
            <label style="display:flex;flex-direction:column;gap:5px">
              <span class="ums" style="margin:0">모델</span>
              <select id="opModel">${modelHtml}</select>
            </label>
            <label style="display:flex;flex-direction:column;gap:5px">
              <span class="ums" style="margin:0">추론 성능</span>
              <select id="opEffort">${effortHtml}</select>
            </label>
            <label style="display:flex;flex-direction:column;gap:5px">
              <span class="ums" style="margin:0">정기 점검 주기 (분, 0=끔)</span>
              <input type="number" id="opInterval" min="0" max="1440" value="${esc(String(data.checkEveryMin ?? 180))}">
            </label>
          </div>
          <div class="row" style="gap:16px;flex-wrap:wrap">
            <label class="row" style="gap:6px;cursor:pointer"><input type="checkbox" id="opEnabled"${data.enabled ? ' checked' : ''}><span>허브 시작 시 관제 세션 자동 실행</span></label>
            <label class="row" style="gap:6px;cursor:pointer"><input type="checkbox" id="opSkipPerms"${data.skipPermissions ? ' checked' : ''}><span>권한 확인 건너뛰기(yolo)</span></label>
            <label class="row" style="gap:6px;cursor:pointer"><input type="checkbox" id="opNoticeDeliver"${data.noticeDeliver ? ' checked' : ''}><span>공지를 실행·대기 중인 터미널(Claude·Codex·AGY)에 자동 입력</span></label>
          </div>
          ${data.hasCustomCommand ? '<div class="ums" style="margin:0;color:var(--warn)">현재 config.json의 사용자 지정 command가 적용 중입니다. 저장하면 선택한 CLI 설정으로 전환됩니다.</div>' : ''}
          <div class="row" style="gap:8px;justify-content:flex-end">
            <button type="button" id="opSaveOnly">설정만 저장</button>
            <button type="button" class="primary" id="opSaveRestart">${t ? '저장 후 관제 세션 재시작' : '저장 후 관제 세션 시작'}</button>
          </div>
        </div>
      </section>
    </div></div></div>`;

    const view = $('#view');
    view.onclick = async (e) => {
      const sysTab = e.target.closest('[data-systab]');
      if (sysTab) return select({ kind: sysTab.dataset.systab });
      if (e.target.closest('#opOpenTerm') && t) return select({ kind: 'term', id: t.id });
      if (e.target.closest('#opStop')) {
        await api('/api/operator', { method: 'POST', body: { action: 'stop' } });
        toast('관제 세션을 중지했습니다.');
        await refreshOverview();
        return viewOperator();
      }
      const saveBtn = e.target.closest('#opSaveOnly');
      const restartBtn = e.target.closest('#opSaveRestart');
      if (saveBtn || restartBtn) {
        const btn = saveBtn || restartBtn;
        btn.disabled = true;
        try {
          const body = {
            action: restartBtn ? 'restart' : 'save',
            agent: $('#opAgent')?.value || 'claude',
            model: $('#opModel')?.value || '',
            effort: $('#opEffort')?.value || '',
            checkEveryMin: Number($('#opInterval')?.value ?? 180),
            enabled: !!$('#opEnabled')?.checked,
            skipPermissions: !!$('#opSkipPerms')?.checked,
            noticeDeliver: !!$('#opNoticeDeliver')?.checked,
          };
          const r = await api('/api/operator', { method: 'POST', body });
          if (r.error) throw new Error(r.error);
          toast(restartBtn ? `관제 세션을 ${body.agent}로 시작했습니다.` : '관제 세션 설정을 저장했습니다.');
          await refreshOverview();
          return viewOperator();
        } catch (err) {
          toast(err.message || '관제 세션 설정에 실패했습니다.', 5000, 'danger');
          if (btn.isConnected) btn.disabled = false;
        }
      }
    };
    const agSel = $('#opAgent');
    if (agSel) {
      agSel.onchange = () => {
        const { modelHtml: mh, effortHtml: eh } = fillModels(agSel.value, '', '');
        if ($('#opModel')) $('#opModel').innerHTML = mh;
        if ($('#opEffort')) $('#opEffort').innerHTML = eh;
      };
    }
  };
  const [data, cliOpts] = await Promise.all([
    api('/api/operator'),
    api('/api/projects/cli-options').catch(() => ({})),
  ]);
  render(data, cliOpts);
}
window.viewOperator = viewOperator;
