// ---------- AI usage (relayed from ai-usage-dashboard :4777) ----------
let agyPollTimer = null;
async function refreshUsage(force) {
  const [uRes, aRes] = await Promise.allSettled([
    api('/api/usage' + (force ? '?force=1' : '')),
    state.features?.agy === false ? Promise.resolve(null) : api('/api/agy/quota' + (force ? '?force=1' : '')),
  ]);
  state.usage = uRes.status === 'fulfilled' ? uRes.value : { available: false, error: uRes.reason?.message || '오류' };
  if (state.usage?.accounts) state.usage.accounts = state.usage.accounts.filter((a) => a.id !== 'agy-cli');
  if (aRes.status === 'fulfilled' && aRes.value) {
    if (aRes.value.quota) state.agyQuota = aRes.value.quota;
    state.agySwapAvailable = !!aRes.value.swapAvailable;
    if (Array.isArray(aRes.value.swapAccounts)) state.agySwapAccounts = aRes.value.swapAccounts;
    state.agySwapRefreshing = !!aRes.value.swapRefreshing;
    state.agySwapError = aRes.value.swapError || null;
    state.agyRefreshing = !!aRes.value.refreshing;
    state.agyError = aRes.value.ok === false ? (aRes.value.error || '조회 실패') : (aRes.value.lastError || null);
    if (force && aRes.value.ok === false && aRes.value.error) {
      toast(`Antigravity 조회 실패: ${aRes.value.error}`, 5000, 'danger');
    }
    if (!force && (aRes.value.refreshing || aRes.value.swapRefreshing)) {
      clearTimeout(agyPollTimer);
      agyPollTimer = setTimeout(async () => {
        try {
          const next = await api('/api/agy/quota');
          if (next?.quota) state.agyQuota = next.quota;
          state.agySwapAvailable = !!next?.swapAvailable;
          if (Array.isArray(next?.swapAccounts)) state.agySwapAccounts = next.swapAccounts;
          state.agySwapRefreshing = !!next?.swapRefreshing;
          state.agyRefreshing = !!next?.refreshing;
          state.agyError = next?.lastError || null;
          renderSide();
          refreshHomeWidgets();
          if (state.sel.kind === 'usage') paintUsage();
        } catch {}
      }, 4500);
    }
  }
  paintBrandStatus();
  renderSide();
  refreshHomeWidgets();
  if (state.sel.kind === 'usage') paintUsage();
}
// usage percents: whole numbers (APIs send values like 6.593538461538461)
const pctTxt = (p) => (p == null ? '' : String(Math.round(Number(p))));
const level = (p) => (p >= 90 ? 'hi' : p >= 70 ? 'mid' : 'lo');
function untilText(iso) {
  if (!iso) return '';
  const s = (new Date(iso) - Date.now()) / 1000;
  if (s <= 0) return '리셋됨';
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}일 ${h}시간 후` : h ? `${h}시간 ${m}분 후` : `${m}분 후`;
}
const shortLabel = (a) => (a.label || a.provider || '').replace(/@.*/, '').replace(/\s*\(이 PC\)/, '');
// The meters that matter at a glance: the 5-hour window and the weekly cap (or the headline one).
function keyMeters(a) {
  const ms = a.meters || [];
  const pick = [ms.find((m) => /5시간/.test(m.name)), ms.find((m) => /주간 \(전체/.test(m.name)) || ms.find((m) => /주간/.test(m.name))].filter(Boolean);
  return pick.length ? pick : ms.filter((m) => m.headline).concat(ms).slice(0, 2);
}
const bar = (pct, thin) => `<span class="ubar${thin ? ' thin' : ''}"><i class="${level(pct)}" style="width:${Math.max(2, Math.min(100, pct))}%"></i></span>`;
const remainingBar = (used, remaining) => `<span class="ubar" aria-hidden="true"><i class="${level(used)}" style="width:${Math.min(100, remaining)}%"></i></span>`;

function usageWindowHTML(label, meter) {
  const used = meter?.usedPercent;
  const available = Number.isFinite(used);
  const remaining = available ? Math.min(100, Math.max(0, Math.round(100 - used))) : null;
  const resets = Number.isFinite(Date.parse(meter?.resetsAt)) ? shortResetAt(meter.resetsAt) : meter?.detail;
  return `<div class="usage-window">
    <div class="umt"><span>${esc(label)}</span>${available
      ? `<b class="up ${level(used)}">${remaining}% 남음</b>`
      : '<span class="ums">한도 정보 없음</span>'}</div>
    ${available ? remainingBar(used, remaining) : ''}
    ${resets ? `<div class="ums">${esc(resets)}</div>` : ''}
  </div>`;
}

function usageAccountWindows(a, kind) {
  const meters = a.meters || [];
  const five = meters.find(m => /(?:^|\s)5\s*(?:시간|h\b|-hour\b)/i.test(m.name));
  const weekly = meters.find(m => /^(?:Codex )?(?:주간(?: \(전체 모델\)| 한도)?|weekly(?: \(all models\)| limit)?)$/i.test(m.name));
  const fable = meters.find(m => /fable|페이블/i.test(m.name) && /주간|weekly/i.test(m.name));
  const windows = [['5시간', five], [kind === 'claude' ? '주간 (전체 모델)' : '주간', weekly]];
  if (kind === 'claude') windows.push(['주간 (Fable)', fable]);
  return `<div class="usage-windows">${windows.map(([label, meter]) => usageWindowHTML(label, meter)).join('')}</div>`;
}
async function openAgyUsage(btn) {
  const prev = btn?.innerHTML;
  if (btn) { btn.disabled = true; btn.textContent = btn.classList.contains('qact') ? '…' : 'agy 조회 중…'; }
  state.agyRefreshing = true;
  if (state.sel.kind === 'usage') paintUsage();
  try {
    const r = await api('/api/agy/usage', { method: 'POST', body: {} });
    state.agyRefreshing = false;
    state.agySwapRefreshing = false;
    if (r.quota) state.agyQuota = r.quota;
    if (typeof r.swapAvailable === 'boolean') state.agySwapAvailable = r.swapAvailable;
    if (Array.isArray(r.swapAccounts)) state.agySwapAccounts = r.swapAccounts;
    state.agyError = r.ok === false ? (r.error || '조회 실패') : null;
    renderSide();
    refreshHomeWidgets();
    if (state.sel.kind === 'usage') paintUsage();
    if (r.ok === false) {
      toast(`Antigravity 조회 실패: ${r.error || '오류'}`, 6000, 'danger');
      return r;
    }
    const sec = r.elapsedMs ? ` (${(r.elapsedMs / 1000).toFixed(1)}초)` : '';
    toast(`Antigravity 한도를 갱신했습니다${sec}`);
    return r;
  } catch (e) {
    state.agyRefreshing = false;
    state.agyError = e.message || 'agy 조회 실패';
    toast(e.message || 'agy 실행 실패', 6000, 'danger');
    if (state.sel.kind === 'usage') paintUsage();
    return { ok: false, error: state.agyError };
  } finally {
    if (btn && btn.isConnected) { btn.disabled = false; btn.innerHTML = prev; }
  }
}
// ---------- reusable right-side Drawer (Astryx Drawer surface) ----------
function openDrawer({ title, bodyHTML = '', footerHTML = '', width = 460, focus = false, parent = document.body, onClose } = {}) {
  const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const d = document.createElement('div');
  d.className = 'drw-backdrop';
  d.innerHTML = `<div class="drw-panel" style="--drw-w:${width}px" role="dialog" aria-modal="true" aria-label="${esc(title || '')}">
    <div class="drw-head"><h2>${esc(title || '')}</h2><button class="ghost icon-btn btn-sm" data-drw-close aria-label="닫기" title="닫기 (Esc)">${ICO.close}</button></div>
    <div class="drw-body">${bodyHTML}</div>
    ${footerHTML ? `<div class="drw-foot">${footerHTML}</div>` : ''}
  </div>`;
  const close = () => {
    if (!d.isConnected) return;
    document.removeEventListener('keydown', onKey);
    d.remove();
    onClose?.();
    if (trigger && trigger.isConnected) trigger.focus({ preventScroll: true });
  };
  const onKey = (e) => {
    if (e.defaultPrevented || (e.key !== 'Escape' && e.key !== 'Tab')) return;
    if (Array.from(document.querySelectorAll('.drw-backdrop, dialog[open]')).at(-1) !== d) return;
    if (e.key === 'Escape') {
      if (parent !== document.body) e.preventDefault();
      close();
      return;
    }
    const controls = [...d.querySelectorAll('a[href], button, input, select, textarea, [tabindex]')]
      .filter(el => el.tabIndex >= 0 && !el.matches(':disabled') && el.getClientRects().length
        && getComputedStyle(el).visibility === 'visible');
    const active = document.activeElement;
    const edge = e.shiftKey ? controls.at(-1) : controls[0];
    if (edge && (!controls.includes(active) || active === (e.shiftKey ? controls[0] : controls.at(-1)))) {
      e.preventDefault();
      edge.focus();
    }
  };
  document.addEventListener('keydown', onKey);
  let downOnBackdrop = false;
  d.addEventListener('pointerdown', (e) => { downOnBackdrop = e.target === d; });
  d.addEventListener('click', (e) => {
    if (e.target.closest('[data-drw-close]') || (e.target === d && downOnBackdrop)) close();
    downOnBackdrop = false;
  });
  parent.appendChild(d);
  if (focus) $('[data-drw-close]', d).focus();
  d.close = close;
  return d;
}
window.openDrawer = openDrawer;

const isResetTodayIso = (iso) => {
  if (!iso) return false;
  const d = new Date(iso), now = new Date();
  return d > now && d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
};
const isResetTodayText = (txt) => {
  const m = /(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?/i.exec(String(txt || ''));
  if (!m || (!m[1] && !m[2])) return false;
  const ms = ((Number(m[1]) || 0) * 60 + (Number(m[2]) || 0)) * 60 * 1000;
  if (ms <= 0) return false;
  const d = new Date(Date.now() + ms), now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
};

const shortResetAt = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return `${untilText(iso)} (${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')})`;
};
const cleanNote = (n) => String(n || '').replace(/(\d+)\.\d{4,}/g, (_, intPart) => Number(intPart).toLocaleString('en-US'));

function agyResetDetail(iso, fallbackText) {
  if (iso) {
    const s = (new Date(iso) - Date.now()) / 1000;
    if (s <= 0) return '사용 가능';
    return shortResetAt(iso);
  }
  if (!fallbackText || /^quota available$/i.test(fallbackText)) return '사용 가능';
  return fallbackText;
}
async function switchAgyAccount(email, btn = null) {
  if (!email) return false;
  const openAgy = (state.terms || []).filter((t) => t.exited === null && t.agy && t.account?.email?.toLowerCase() !== email.toLowerCase());
  let restartOpen = false;
  if (openAgy.length) {
    const promptMsg = isEnUI()
      ? `Also restart ${openAgy.length} open Antigravity terminal(s) with ${email}? (Conversations will resume cleanly; Cancel keeps existing terminals on their current session.)`
      : `열려 있는 Antigravity 터미널 ${openAgy.length}개도 ${email} 계정으로 대화를 이어서 전환할까요?\n(확인: 대화 유지한 채 새 계정으로 재개 · 취소: 이후 새 터미널부터 적용)`;
    restartOpen = confirm(promptMsg);
  }
  const prev = btn?.innerHTML;
  if (btn) { btn.disabled = true; btn.textContent = '전환 중…'; }
  try {
    const r = await api('/api/agy/swap', { method: 'POST', body: { account: email, restartOpen } });
    if (r.error) throw new Error(r.error);
    if (Array.isArray(r.accounts)) state.agySwapAccounts = r.accounts;
    const replaced = (r.restartedTerms || []).find((x) => state.sel.kind === 'term' && String(state.sel.id) === String(x.oldId));
    const swCount = r.restartedTerms?.length || 0;
    const doneMsg = isEnUI()
      ? (swCount ? `Switched to ${email} and resumed ${swCount} terminal(s).` : `Switched active Antigravity account to ${email} — new terminals will use it.`)
      : (swCount ? `${email} 계정으로 전환하고 기존 터미널 ${swCount}개를 이어서 재시작했습니다.` : `Antigravity 활성 계정을 ${email}로 전환했습니다. 새 터미널부터 적용됩니다.`);
    toast(doneMsg);
    paintBrandStatus();
    await Promise.all([refreshOverview(), refreshUsage(true)]);
    if (replaced) select({ kind: 'term', id: replaced.newId });
    return true;
  } catch (err) {
    toast(err.message, 6000, 'danger');
    if (btn && btn.isConnected) { btn.disabled = false; if (prev != null) btn.innerHTML = prev; }
    return false;
  }
}
function agyCardHTML(swapAcc) {
  const q = swapAcc
    ? { ...swapAcc, account: swapAcc.email, fetchedAt: state.agyQuota?.fetchedAt || Date.now() }
    : state.agyQuota;
  const titleTxt = swapAcc ? (swapAcc.name || swapAcc.email?.replace(/@.*/, '') || 'Antigravity') : 'Antigravity';
  const cardKey = swapAcc ? swapAcc.id : 'agy';
  const activeCls = swapAcc ? (swapAcc.active ? ' agy-active' : ' agy-standby') : '';
  const switchBtn = swapAcc && !swapAcc.active
    ? `<button type="button" class="btn-sm" data-agy-swap="${esc(swapAcc.email)}" title="이 Antigravity 계정으로 전환">${ICO.swap} 전환</button>`
    : '';
  const activeBadge = swapAcc
    ? (swapAcc.active ? '<span class="badge ok">● 현재 사용 중</span>' : '<span class="badge">대기 계정</span>')
    : '';
  const refreshing = swapAcc ? state.agySwapRefreshing : state.agyRefreshing;
  if (!q?.groups?.length) {
    const hint = refreshing ? '백그라운드에서 조회 중…' : (state.agyError || '클릭해 한도 조회');
    return `<div class="ucard click${activeCls}" data-usage-card="${esc(cardKey)}" title="${esc(swapAcc?.email || '')}">
      <div class="uh">${agentIcon('agy', refreshing ? 'busy' : (swapAcc?.active ? 'idle' : ''))}<b style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(titleTxt)}</b>${activeBadge}${switchBtn}</div>
      <div>
        <div class="ucard-hero"><span class="ucard-big" style="font-size:18px;font-weight:650;color:var(--muted)">조회 대기</span><span class="ums" style="margin:0">${refreshing ? '조회 중' : '클릭해 확인'}</span></div>
      </div>
      <div class="ucard-foot"><span>${esc(hint)}</span><span class="ico">${ICO.chevRight}</span></div>
    </div>`;
  }
  const soon = q.groups.some((g) => isResetTodayIso(g.weeklyResetAt) || isResetTodayText(g.weeklyReset));
  return `<div class="ucard click${activeCls}${soon ? ' reset-soon' : ''}" data-usage-card="${esc(cardKey)}" title="${esc(swapAcc?.email || '')}">
    <div class="uh">${agentIcon('agy', refreshing ? 'busy' : (swapAcc?.active ? 'idle' : ''))}<b style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(titleTxt)}</b>${activeBadge}${switchBtn}${soon ? `<span class="badge soon">${ICO.clock} 금일 리셋</span>` : ''}</div>
    <div class="usage-windows">${q.groups.map(g => `<div class="ugrp"><div class="ugrp-title">${esc(g.name)}</div>
      ${usageWindowHTML('5시간', { usedPercent: g.fiveH, resetsAt: g.fiveHResetAt, detail: g.fiveHReset })}
      ${usageWindowHTML('주간', { usedPercent: g.weekly, resetsAt: g.weeklyResetAt, detail: g.weeklyReset })}
    </div>`).join('')}</div>
    <div class="ucard-foot"><span>${refreshing ? '갱신 중…' : '상세 보기'}</span><span class="ico">${ICO.chevRight}</span></div>
  </div>`;
}
function agyDrawerBodyHTML(q, swapAcc) {
  const src = swapAcc || q;
  if (!src?.groups?.length) {
    return `<div class="empty">${state.agyRefreshing ? 'Antigravity 한도를 조회하는 중입니다…' : esc(state.agyError || '아직 조회된 한도 정보가 없습니다. 아래 “지금 조회”를 눌러 확인하세요.')}</div>`;
  }
  const accLine = swapAcc ? (swapAcc.name ? `${swapAcc.name} <${swapAcc.email}>` : swapAcc.email) : q?.account;
  return `
    ${accLine ? `<div class="drw-kv"><span>계정</span><b>${esc(accLine)}</b></div>` : ''}
    ${swapAcc ? `<div class="drw-kv"><span>상태</span><b>${esc([swapAcc.plan, swapAcc.active ? '현재 활성 계정' : '대기 계정'].filter(Boolean).join(' · '))}</b></div>` : ''}
    ${src.groups.map((g) => `<div class="ugrp"><div class="ugrp-title">${esc(g.name)}</div>
      ${g.models ? `<div class="ums" style="margin-top:-2px">${esc(g.models)}</div>` : ''}
      ${g.fiveH != null ? `<div class="um"><div class="umt"><span>5시간 한도</span><span class="up ${level(g.fiveH)}"><b>${g.fiveHRem}% 남음</b> <span style="font-weight:400;color:var(--muted)">(${pctTxt(g.fiveH)}% 사용)</span></span></div>
        ${remainingBar(g.fiveH, g.fiveHRem)}<div class="ums">${esc(agyResetDetail(g.fiveHResetAt, g.fiveHReset))}</div></div>` : ''}
      ${g.weekly != null ? `<div class="um"><div class="umt"><span>주간 한도</span><span class="up ${level(g.weekly)}"><b>${g.weeklyRem}% 남음</b> <span style="font-weight:400;color:var(--muted)">(${pctTxt(g.weekly)}% 사용)</span></span></div>
        ${remainingBar(g.weekly, g.weeklyRem)}<div class="ums">${esc(agyResetDetail(g.weeklyResetAt, g.weeklyReset))}</div></div>` : ''}</div>`).join('')}
    ${q?.fetchedAt ? `<div class="ums">마지막 조회: ${esc(new Date(q.fetchedAt).toLocaleTimeString(uiLocale()))} (${esc(ago(Date.parse(q.fetchedAt)))})</div>` : ''}`;
}
function openAgyDetailDrawer(cardId = 'agy') {
  const findSwap = () => (cardId && cardId !== 'agy' ? (state.agySwapAccounts || []).find((a) => a.id === cardId) : null);
  let swapAcc = findSwap();
  const canSwap = () => swapAcc && !swapAcc.active;
  const buildFooter = () => `<button data-drw-close>닫기</button>${canSwap() ? `<button id="drwAgySwap">${ICO.swap} 이 계정으로 전환</button>` : ''}<button class="primary" id="drwAgyRef">${ICO.refresh} 지금 조회</button>`;
  const d = openDrawer({
    title: swapAcc ? `Antigravity · ${swapAcc.name || swapAcc.email}` : 'Antigravity 한도 상세',
    bodyHTML: agyDrawerBodyHTML(state.agyQuota, swapAcc),
    footerHTML: buildFooter(),
    width: 460,
  });
  const bindActions = () => {
    const refBtn = $('#drwAgyRef', d);
    const swapBtn = $('#drwAgySwap', d);
    const runRefresh = async () => {
      await openAgyUsage(refBtn);
      swapAcc = findSwap();
      const bodyEl = $('.drw-body', d);
      if (bodyEl && d.isConnected) bodyEl.innerHTML = agyDrawerBodyHTML(state.agyQuota, swapAcc);
    };
    if (refBtn) refBtn.onclick = runRefresh;
    if (swapBtn) {
      swapBtn.onclick = async () => {
        if (!swapAcc) return;
        const ok = await switchAgyAccount(swapAcc.email, swapBtn);
        if (!ok) return;
        swapAcc = findSwap();
        const bodyEl = $('.drw-body', d);
        const footEl = $('.drw-foot', d);
        if (bodyEl && d.isConnected) bodyEl.innerHTML = agyDrawerBodyHTML(state.agyQuota, swapAcc);
        if (footEl && d.isConnected) { footEl.innerHTML = buildFooter(); bindActions(); }
      };
    }
  };
  bindActions();
  if (!state.agyQuota?.groups?.length && !state.agyRefreshing) $('#drwAgyRef', d)?.click();
}
const codexCount = value => Number(value || 0).toLocaleString(uiLocale());
const codexShortCount = value => Number(value || 0).toLocaleString(uiLocale(), {
  notation: 'compact', maximumFractionDigits: 1,
});
const codexAccountKey = a => String(a.email || a.id || '').toLowerCase();
const isCodexTokenAccount = a => a.type === 'codex' || a.provider === 'ChatGPT' ||
  a.meters?.some(m => /^Codex /i.test(m.name));
const codexSum = (groups, key) => groups.reduce((sum, row) => sum + (row[key] || 0), 0);
const codexModelEffort = row => [row.model, row.effort].filter(Boolean).join(' · ') || '모델 정보 없음';
const codexIoSummary = groups => `비캐시 입력 ${codexShortCount(codexSum(groups, 'uncached_input_tokens'))} · 출력 ${codexShortCount(codexSum(groups, 'output_tokens'))}`;

function codexAnswerTokensHTML(groups, turn, open) {
  const heading = codexModelEffort(groups[0]) + (groups.length > 1 ? ` +${groups.length - 1}` : '');
  return `<details class="msg-token-usage" data-token-turn="${esc(turn)}"${open ? ' open' : ''}><summary aria-label="이번 답변의 Codex CLI 토큰">
    <span>${esc(heading)}</span> <b>${esc(codexIoSummary(groups))}</b></summary>
    ${groups.map(row => `<div>
      <span>${esc(row.account || '계정 미확인')}${groups.length > 1 ? ` · ${esc(codexModelEffort(row))}` : ''}</span>
      <span>비캐시 ${codexCount(row.uncached_input_tokens)} · 캐시 ${codexCount(row.cached_input_tokens)}</span>
      <span>출력 ${codexCount(row.output_tokens)} (추론 ${codexCount(row.reasoning_output_tokens)})</span>
    </div>`).join('')}</details>`;
}

async function refreshCodexTokenCards() {
  try { state.codexTokenGroups = (await api('/api/codex/tokens?week', { requireOk: true })).groups || []; }
  catch { state.codexTokenGroups = []; }
  if (state.sel.kind === 'usage') paintUsage();
}

function codexTokenCardHTML(account) {
  const groups = (state.codexTokenGroups || []).filter(row => row.account === codexAccountKey(account));
  return groups.length ? `<div class="ums">이 PC CLI · ${esc(codexIoSummary(groups))}</div>` : '';
}

async function loadCodexTokenDetail(host, account) {
  try {
    const query = new URLSearchParams({ account: codexAccountKey(account), week: '' });
    const { groups = [], observations = [], estimates = [] } = await api(`/api/codex/tokens?${query}`, { requireOk: true });
    if (!host.isConnected) return;
    const obs = observations.sort((a, b) => b.toAt - a.toAt)[0];
    const point = value => Number(value).toLocaleString(uiLocale(), { maximumFractionDigits: 1 });
    const usd = value => Number(value).toLocaleString(uiLocale(), { style: 'currency', currency: 'USD' });
    const estimate = estimates.find(row => row.account === codexAccountKey(account));
    host.innerHTML = groups.length ? `
      ${estimate?.percent != null ? `<div class="drw-kv" title="표준 단가 환산액을 기준액으로 나눈 추정치입니다.">
        <span>이 PC CLI 환산</span><b>추정 ${point(estimate.percent)}%</b></div>
      <div class="ums">${usd(estimate.costUsd)} / ${usd(estimate.basisUsd)} · ${esc(estimate.plan || '')} ${'기본 가정'}</div>` : ''}
      <div class="drw-kv"><span>비캐시 입력</span><b>${codexCount(codexSum(groups, 'uncached_input_tokens'))}</b></div>
      <div class="drw-kv"><span>출력</span><b>${codexCount(codexSum(groups, 'output_tokens'))}</b></div>
      <details class="codex-token-detail"><summary>캐시·모델별 내역</summary>
        <div class="drw-kv"><span>캐시 읽기</span><b>${codexCount(codexSum(groups, 'cached_input_tokens'))}</b></div>
        <div class="drw-kv"><span>전체 처리 토큰 (캐시 포함)</span><b>${codexCount(codexSum(groups, 'total_tokens'))}</b></div>
        ${groups.map(row => `<div class="codex-token-detail">
        <b>${esc(codexModelEffort(row))}</b>
        <div class="ums">비캐시 입력 ${codexCount(row.uncached_input_tokens)} · 캐시 ${codexCount(row.cached_input_tokens)}</div>
        <div class="ums">출력 ${codexCount(row.output_tokens)} · 추론 ${codexCount(row.reasoning_output_tokens)}</div>
      </div>`).join('')}
        ${obs ? `<div class="ums" title="CLI 로그에 남은 첫·마지막 계정 사용률입니다. 같은 시간대의 다른 기기 사용도 포함합니다.">계정 사용률 관측 ${point(obs.from)}% → ${point(obs.to)}% (+${point(obs.changePoints)}%p)</div>` : ''}
      </details>` : '<div class="ums">이번 주에 저장된 이 계정의 CLI 기록이 없습니다.</div>';
  } catch {
    if (host.isConnected) host.textContent = '저장된 CLI 토큰을 불러올 수 없습니다.';
  }
}

async function loadCodexResetCredits(host, account) {
  const accountId = String(account.id || '');
  const storageKey = `codex-reset-pending:${accountId}`;
  let pendingKey = null;
  try { pendingKey = localStorage.getItem(storageKey); } catch {}
  const show = async () => {
    host.textContent = '초기화 티켓 조회 중…';
    try {
      const data = await api(`/api/codex/reset-credits?account=${encodeURIComponent(accountId)}`, { requireOk: true });
      if (!host.isConnected) return;
      const credits = data.rateLimitResetCredits;
      const count = credits?.availableCount;
      const label = data.account.email || data.account.label;
      host.innerHTML = `<div class="ums">${esc(label)}</div>
        <div class="drw-kv"><span>사용 가능한 티켓</span><b>${Number.isInteger(count) ? `${count}장` : '정보 없음'}</b></div>
        ${credits?.credits?.map(c => `<div class="ums">${esc(c.title || '한도 초기화 티켓')}${c.expiresAt ? ` · 만료 ${esc(new Date(c.expiresAt * 1000).toLocaleString(uiLocale()))}` : ''}</div>`).join('') || ''}
        ${pendingKey ? '<div class="ums">결과가 확인되지 않은 이전 요청이 있습니다. 재확인 시 같은 요청 번호를 사용합니다.</div>' : ''}
        <button class="btn-sm" data-reset-use ${count > 0 || pendingKey ? '' : 'disabled'}>${pendingKey ? '이전 사용 요청 재확인' : '초기화 티켓 1장 사용'}</button>
        <button class="ghost btn-sm" data-reset-refresh>티켓 다시 조회</button>
        <div data-reset-result role="status" aria-live="polite"></div>`;
      host.querySelector('[data-reset-refresh]').onclick = show;
      host.querySelector('[data-reset-use]').onclick = async () => {
        if (!pendingKey && !confirm(`${label} 계정의 초기화 티켓 1장을 사용하시겠습니까?\n이 계정의 적용 가능한 Codex 한도가 초기화됩니다.`)) return;
        const button = host.querySelector('[data-reset-use]');
        const refreshButton = host.querySelector('[data-reset-refresh]');
        const result = host.querySelector('[data-reset-result]');
        // Persist BEFORE sending: reloads and ambiguous network failures reuse the same key.
        try {
          pendingKey ||= globalThis.crypto?.randomUUID?.() || `hub-${Date.now()}-${Math.random().toString(36).slice(2)}`;
          localStorage.setItem(storageKey, pendingKey);
        } catch { result.textContent = '요청 번호를 저장할 수 없습니다. 브라우저 저장소를 허용한 뒤 다시 시도하세요.'; return; }
        button.disabled = true; refreshButton.disabled = true;
        result.textContent = '티켓 사용 결과 확인 중…';
        try {
          const response = await api('/api/codex/reset-credits', { method: 'POST', body: { account: accountId, idempotencyKey: pendingKey, confirmed: true }, requireOk: true });
          const messages = { reset: '티켓 1장을 사용해 한도를 초기화했습니다.', alreadyRedeemed: '이 요청은 이미 처리됐습니다. 추가 티켓은 사용하지 않았습니다.', nothingToReset: '초기화할 수 있는 한도 구간이 없습니다.', noCredit: '사용 가능한 초기화 티켓이 없습니다.' };
          if (!messages[response.outcome]) throw new Error('사용 결과를 확인하지 못했습니다. 같은 요청으로 재시도하세요.');
          localStorage.removeItem(storageKey); pendingKey = null;
          await show();
          if (host.isConnected) {
            const output = host.querySelector('[data-reset-result]');
            if (output) output.textContent = messages[response.outcome] + (response.refreshError ? ' 한도 재조회가 필요합니다.' : '');
          }
          void refreshUsage(true);
        } catch (e) {
          if (result.isConnected) result.textContent = `${e.message} 같은 요청 번호로 재시도할 수 있습니다.`;
          if (button.isConnected) { button.disabled = false; button.textContent = '이전 사용 요청 재확인'; }
          if (refreshButton.isConnected) refreshButton.disabled = false;
        }
      };
    } catch (e) {
      if (!host.isConnected) return;
      host.innerHTML = `<div class="ums">${esc(e.message)}</div><button class="btn-sm" data-reset-retry>티켓 조회 재시도</button>`;
      host.querySelector('[data-reset-retry]').onclick = show;
    }
  };
  await show();
}

function openUsageDetailDrawer(a) {
  if (!a) return;
  const codex = isCodexTokenAccount(a);
  const claude = usageKindOf(a) === 'claude';
  const meterRow = (m) => {
    const used = m.usedPercent != null ? Math.round(Number(m.usedPercent)) : null;
    const rem = used != null ? Math.max(0, 100 - used) : null;
    return `<div class="um"><div class="umt"><span>${esc(m.name)}${codex && /주간|weekly/i.test(m.name) ? ' · 계정 전체' : ''}</span>${used != null ? `<span class="up ${level(used)}"><b>${rem}% 남음</b> <span style="font-weight:400;color:var(--muted)">(${used}% 사용)</span></span>` : ''}</div>
    ${used != null ? remainingBar(used, rem) : ''}<div class="ums">${[m.resetsAt ? shortResetAt(m.resetsAt) : '', m.detail ? esc(m.detail) : ''].filter(Boolean).join(' · ')}</div></div>`;
  };
  const footNotes = [
    a.billing?.at ? `${esc(a.billing.label)}: ${esc(new Date(a.billing.at).toLocaleDateString(uiLocale()))}` : '',
    ...(a.notes || []).map((n) => esc(cleanNote(n))),
  ].filter(Boolean);
  const body = `
    <div class="row" style="gap:8px">${agentIcon(usageKindOf(a) === 'other' ? 'bot' : usageKindOf(a), a.live ? 'idle' : '')}<b>${esc(a.label)}</b>${a.plan ? `<span class="badge">${esc(a.plan)}</span>` : ''}</div>
    ${!a.ok ? `<div class="err" style="padding:0">${esc(a.error || '조회 실패')}</div>` : ''}
    ${(a.meters || []).length ? `<div class="ugrp">${a.meters.map(meterRow).join('')}</div>` : '<div class="empty" style="padding:0">표시할 상세 미터가 없습니다.</div>'}
    ${codex ? '<section class="ugrp"><div class="ugrp-title">GPT / Codex 한도 초기화 티켓</div><div data-codex-reset-credits aria-live="polite">불러오는 중…</div></section><section class="ugrp"><div class="ugrp-title">이번 주 · 이 PC의 CLI 토큰</div><div data-codex-token-detail aria-live="polite">불러오는 중…</div></section>' : ''}
    ${claude ? `<section class="ugrp"><div class="ugrp-title">Claude 한도 초기화 티켓</div>
      <div class="ums">Claude 설정 → 사용량의 Limit resets에서 Reset for free를 눌러 사용합니다. 사용 결과는 같은 계정의 Claude Code에도 적용됩니다.</div>
      <div class="ums">대상: ${esc(a.email || a.label)}. 열린 Claude 웹사이트의 로그인 계정이 같은지 확인하세요. 관제의 계정 선택은 웹 로그인을 바꾸지 않습니다.</div>
      <div class="row" style="gap:8px;margin-top:8px"><a class="btn-sm" href="https://claude.ai/settings/usage" target="_blank" rel="noopener noreferrer">Claude 티켓 사용 화면 열기</a>
      <button class="btn-sm" data-claude-reset-refresh>사용 후 한도 새로고침</button></div>
      <div data-claude-reset-status class="ums" role="status"></div></section>` : ''}
    ${footNotes.length ? `<div class="ugrp">${footNotes.map((t) => `<div class="ums">${t}</div>`).join('')}</div>` : ''}`;
  const drawer = openDrawer({ title: `${a.label} · 상세`, bodyHTML: body, footerHTML: '<button data-drw-close>닫기</button>', width: 460 });
  if (codex) void loadCodexTokenDetail(drawer.querySelector('[data-codex-token-detail]'), a);
  if (codex) void loadCodexResetCredits(drawer.querySelector('[data-codex-reset-credits]'), a);
  if (claude) drawer.querySelector('[data-claude-reset-refresh]').onclick = async () => {
    const button = drawer.querySelector('[data-claude-reset-refresh]');
    const status = drawer.querySelector('[data-claude-reset-status]');
    button.disabled = true; status.textContent = '한도 조회 중…';
    try {
      await refreshUsage(true);
      const updated = state.usage?.accounts?.find(item => item.id === a.id);
      if (updated?.ok) {
        status.textContent = (updated.meters || []).map(m => `${m.name}: ${pctTxt(m.usedPercent)}% 사용`).join(' · ') || '조회 완료';
      } else status.textContent = updated?.error || '한도를 확인하지 못했습니다. 잠시 후 다시 조회하세요.';
    } catch (e) { status.textContent = e.message; }
    finally { if (button.isConnected) button.disabled = false; }
  };
}
function usageKindOf(a) {
  const tag = `${a.type || ''} ${a.provider || ''}`;
  if (/claude/i.test(tag)) return 'claude';
  if (/codex|chatgpt|openai/i.test(tag)) return 'codex';
  if (/agy|antigravity/i.test(tag)) return 'agy';
  return 'other';
}
function usageWorstOf(a) {
  const pcts = (a.meters || []).map((m) => m.usedPercent).filter((v) => v != null);
  return a.ok && pcts.length ? Math.max(...pcts) : null;
}
function viewUsage() {
  setBar('');
  $('#view').onclick = async (e) => {
    const sysTab = e.target.closest('[data-systab]');
    if (sysTab) return select({ kind: sysTab.dataset.systab });
    if (e.target.closest('#uAccounts')) return openAccounts();
    const more = e.target.closest('#uMore');
    if (more) {
      e.stopPropagation();
      return openMoreMenu(more, [
        { label: 'Antigravity 한도 조회 (/usage)', icon: ICO.chart, onClick: () => openAgyUsage(null) },
      ]);
    }
    const rb = e.target.closest('#uRefresh');
    if (rb) {
      rb.disabled = true; rb.textContent = '조회 중…';
      await Promise.all([refreshUsage(true), refreshCodexTokenCards()]);
      return;
    }
    const f = e.target.closest('[data-ufilt]');
    if (f) { state.usageFilter = f.dataset.ufilt; return paintUsage(); }
    const agySwapBtn = e.target.closest('[data-agy-swap]');
    if (agySwapBtn) {
      e.stopPropagation();
      return switchAgyAccount(agySwapBtn.dataset.agySwap, agySwapBtn);
    }
    const card = e.target.closest('[data-usage-card]');
    if (card) {
      const id = card.dataset.usageCard;
      if (id === 'agy' || id.startsWith('agyswap:')) return openAgyDetailDrawer(id);
      const acc = (state.usage?.accounts || []).find((a) => String(a.id || a.label) === id);
      if (acc) openUsageDetailDrawer(acc);
    }
  };
  paintUsage();
  void refreshCodexTokenCards();
}
function paintUsage() {
  const u = state.usage;
  const sysActs = `<button class="btn-sm" id="uAccounts">계정 관리</button>
    <button class="primary btn-sm" id="uRefresh" title="제공사에 다시 조회">${ICO.refresh} 지금 조회</button>
    <button class="ghost icon-btn btn-sm" id="uMore" aria-label="AI 사용량 메뉴" aria-haspopup="menu" aria-expanded="false">${ICO.more}</button>`;
  const sysTop = systemTopHTML('usage', sysActs);
  if (!u) { $('#view').innerHTML = `<div class="sys-shell">${sysTop}<div class="sys-body"><div class="page-wrap"><div class="empty">불러오는 중…</div></div></div></div>`; return; }
  if (!u.available) {
    $('#view').innerHTML = `<div class="sys-shell">${sysTop}<div class="sys-body"><div class="page-wrap"><div class="h-empty-card" style="align-items:flex-start;text-align:left;gap:10px">
      <div class="row" style="gap:8px"><span class="dot busy"></span><b style="font-size:15px">AI 사용량 서버(127.0.0.1:4777)가 현재 꺼져 있습니다</b></div>
      <div class="ums" style="margin:0">${esc(u.error || 'AI 사용량 대시보드에 연결할 수 없습니다.')}</div>
      <div class="row" style="gap:8px;margin-top:4px">
        <button class="primary" id="btnUsageStartNow">${ICO.play} 사용량 서버 지금 켜기</button>
        <button id="btnUsageRetry">${ICO.refresh} 다시 확인</button>
      </div>
    </div></div></div></div>`;
    const sb = $('#btnUsageStartNow');
    if (sb) {
      sb.onclick = async () => {
        sb.disabled = true; sb.textContent = '서버 시작 중…';
        try {
          const r = await api('/api/services/usage/start', { method: 'POST', body: {} });
          if (!r.ok) throw new Error(r.error || '시작 실패');
          toast('AI 사용량 서버(:4777)를 시작했습니다');
          await Promise.all([refreshOverview(), refreshUsage(true)]);
        } catch (er) {
          toast(er.message, 5000, 'danger');
          if (sb.isConnected) { sb.disabled = false; sb.innerHTML = `${ICO.play} 사용량 서버 지금 켜기`; }
        }
      };
    }
    const rb = $('#btnUsageRetry');
    if (rb) rb.onclick = () => refreshUsage(true);
    return;
  }

  const allAccs = u.accounts || [];
  const swapAccs = state.agySwapAccounts || [];
  const swapWorstOf = (sa) => {
    const pcts = (sa?.groups || []).flatMap((g) => [g.fiveH, g.weekly]).filter((v) => v != null);
    return pcts.length ? Math.max(...pcts) : null;
  };
  const hasAgy = !!(state.agyQuota?.groups?.length);
  const agyAllUsed = hasAgy ? state.agyQuota.groups.flatMap((g) => [g.fiveH, g.weekly]).filter((v) => v != null) : [];
  const agyWorst = agyAllUsed.length ? Math.max(...agyAllUsed) : null;
  const agyCount = swapAccs.length || 1;

  const counts = { all: allAccs.length + agyCount, tight: 0, claude: 0, codex: 0, agy: agyCount, other: 0 };
  for (const a of allAccs) {
    const k = usageKindOf(a);
    counts[k] = (counts[k] || 0) + 1;
    const w = usageWorstOf(a);
    if (w != null && w >= 90) counts.tight++;
  }
  if (swapAccs.length) {
    for (const sa of swapAccs) { const w = swapWorstOf(sa); if (w != null && w >= 90) counts.tight++; }
  } else if (agyWorst != null && agyWorst >= 90) counts.tight++;

  const uf = state.usageFilter || 'all';
  const us = state.usageSort || 'headroom-desc';
  const filtered = allAccs.filter((a) => {
    if (uf === 'all') return true;
    if (uf === 'tight') { const w = usageWorstOf(a); return w != null && w >= 90; }
    return usageKindOf(a) === uf;
  });
  const sorted = filtered.slice().sort((a, b) => {
    const wa = usageWorstOf(a), wb = usageWorstOf(b);
    if (us === 'headroom-desc') {
      if (wa == null && wb == null) return 0;
      if (wa == null) return 1;
      if (wb == null) return -1;
      return wa - wb;
    }
    if (us === 'headroom-asc') {
      if (wa == null && wb == null) return 0;
      if (wa == null) return 1;
      if (wb == null) return -1;
      return wb - wa;
    }
    return String(a.label || '').localeCompare(String(b.label || ''), 'ko');
  });
  const shownSwapAgy = swapAccs.filter((sa) => uf === 'all' || uf === 'agy' || (uf === 'tight' && (swapWorstOf(sa) ?? -1) >= 90));
  const showFallbackAgy = !swapAccs.length && (uf === 'all' || uf === 'agy' || (uf === 'tight' && agyWorst != null && agyWorst >= 90));

  const seg = (val, label, cnt) => `<button data-ufilt="${val}" class="${uf === val ? 'on' : ''}">${label}${cnt ? ` <span class="seg-cnt">${cnt}</span>` : ''}</button>`;
  const controls = `<div class="row" style="justify-content:space-between;gap:10px">
    <div class="seg" role="tablist" aria-label="AI 사용량 필터">
      ${seg('all', '전체', counts.all)}
      ${counts.tight ? seg('tight', '90%+ 임박', counts.tight) : ''}
      ${counts.claude ? seg('claude', 'Claude', counts.claude) : ''}
      ${counts.codex ? seg('codex', 'Codex', counts.codex) : ''}
      ${counts.agy ? seg('agy', 'AGY', counts.agy) : ''}
      ${counts.other ? seg('other', '기타', counts.other) : ''}
    </div>
    <select id="uSort" class="btn-sm" aria-label="정렬">
      <option value="headroom-desc" ${us === 'headroom-desc' ? 'selected' : ''}>남은 한도 많은순</option>
      <option value="headroom-asc" ${us === 'headroom-asc' ? 'selected' : ''}>남은 한도 적은순</option>
      <option value="name" ${us === 'name' ? 'selected' : ''}>이름순</option>
    </select>
  </div>`;

  const cards = sorted.map((a) => {
    const worst = usageWorstOf(a);
    const rem = worst != null ? Math.max(0, Math.round(100 - worst)) : null;
    const soon = a.ok && (a.meters || []).some((m) => /주간|weekly/i.test(m.name || '') && (isResetTodayIso(m.resetsAt) || isResetTodayText(m.detail)));
    const kind = usageKindOf(a) === 'other' ? 'bot' : usageKindOf(a);
    const showWindows = kind === 'claude' || kind === 'codex';
    const tightMeter = (a.meters || []).slice().sort((x, y) => (y.usedPercent ?? -1) - (x.usedPercent ?? -1))[0];
    const resetHint = !a.ok
      ? (a.error || '조회 실패')
      : showWindows ? '상세 보기'
      : tightMeter?.resetsAt
        ? `${tightMeter.name} · ${untilText(tightMeter.resetsAt)}`
        : tightMeter?.detail || a.plan || '상세 보기';
    return { attention: !a.ok || (worst ?? 0) >= 90, worst, label: String(a.label || ''), html: `<div class="ucard click${soon ? ' reset-soon' : ''}" data-usage-card="${esc(a.id || a.label)}">
      <div class="uh">${agentIcon(kind, a.live ? 'idle' : '')}<b>${esc(shortLabel(a))}</b>${!a.ok ? '<span class="badge lim">조회 실패</span>' : ''}${soon ? `<span class="badge soon">${ICO.clock} 금일 리셋</span>` : ''}</div>
      ${showWindows ? usageAccountWindows(a, kind) : `<div>
        <div class="ucard-hero"><span class="ucard-big ${worst != null ? level(worst) : ''}"${rem == null ? ' style="font-size:18px;font-weight:650;color:var(--muted)"' : ''}>${rem != null ? `${rem}%` : a.ok ? '유효' : '—'}</span><span class="ums" style="margin:0">${rem != null ? '남음' : a.ok ? '인증 상태' : '조회 실패'}</span></div>
        <div style="margin-top:8px">${worst != null ? remainingBar(worst, rem) : ''}</div>
      </div>`}
      ${isCodexTokenAccount(a) ? codexTokenCardHTML(a) : ''}
      <div class="ucard-foot"><span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(resetHint)}</span><span class="ico">${ICO.chevRight}</span></div>
    </div>` };
  });
  for (const sa of shownSwapAgy) {
    const sw = swapWorstOf(sa);
    cards.push({ attention: (sw ?? 0) >= 90, worst: sw, label: String(sa.name || sa.email || 'Antigravity'), html: agyCardHTML(sa) });
  }
  if (showFallbackAgy) {
    cards.push({ attention: (agyWorst ?? 0) >= 90, worst: agyWorst, label: 'Antigravity', html: agyCardHTML() });
  }
  cards.sort((a, b) => {
    const wa = a.worst, wb = b.worst;
    if (us === 'headroom-desc') {
      if (wa == null && wb == null) return 0;
      if (wa == null) return 1;
      if (wb == null) return -1;
      return wa - wb;
    }
    if (us === 'headroom-asc') {
      if (wa == null && wb == null) return 0;
      if (wa == null) return 1;
      if (wb == null) return -1;
      return wb - wa;
    }
    return a.label.localeCompare(b.label, 'ko');
  });
  const needsAttention = cards.filter((x) => x.attention).map((x) => x.html).join('');
  const others = cards.filter((x) => !x.attention).map((x) => x.html).join('');
  $('#view').innerHTML = `<div class="sys-shell">${sysTop}<div class="sys-body"><div class="page-wrap usage-page">${controls}
    ${needsAttention ? `<section class="list-sec usage-attention"><h2>확인이 필요한 계정</h2><div class="ugrid">${needsAttention}</div></section>` : ''}
    ${others ? `<div class="ugrid">${others}</div>` : ''}
    ${cards.length ? '' : '<div class="h-empty-card"><b>조건에 맞는 계정이 없습니다</b></div>'}</div></div></div>`;
  const sortEl = $('#uSort');
  if (sortEl) sortEl.onchange = (e) => { state.usageSort = e.target.value; paintUsage(); };
}

// ---------- AI usage: add/remove accounts (stored by the usage dashboard on this PC) ----------
const ACCOUNT_TYPES = {
  'claude-token': { name: 'Claude 장기 토큰', fields: [['token', '토큰 (sk-ant-oat01-…)', 'password']], help: '터미널에서 <code>claude setup-token</code> → 브라우저 승인 후 출력되는 sk-ant-oat01-… 값' },
  claude: { name: 'Claude Code 로그인 (다른 폴더)', fields: [['credentialsPath', '.credentials.json 경로', 'text']], help: '<code>$env:CLAUDE_CONFIG_DIR="$HOME\\.claude-work"; claude</code> → /login 후 그 폴더의 .credentials.json' },
  cursor: { name: 'Cursor 세션', fields: [['sessionToken', 'WorkosCursorSessionToken 값', 'password']], help: 'cursor.com 로그인 → F12 → Application → Cookies → WorkosCursorSessionToken' },
  codex: { name: 'ChatGPT (Codex CLI)', fields: [['authPath', 'auth.json 경로', 'text']], help: '보통은 위의 <b>＋ Codex 계정 추가</b> 버튼을 쓰세요 (기기 코드 로그인, 자동 등록). 이미 로그인한 폴더가 있으면 그 auth.json 경로' },
  'openai-api': { name: 'OpenAI API 비용', fields: [['adminKey', 'Admin 키 (sk-admin-…)', 'password'], ['monthlyBudget', '월 예산 USD (선택)', 'number']], help: 'platform.openai.com → Admin keys' },
  meshy: { name: 'Meshy API 키', fields: [['apiKey', 'API 키 (msy_…)', 'password'], ['keyPath', '또는 키 파일 경로', 'text'], ['monthlyCredits', '월 제공 크레딧 (선택, 사용률 표시용)', 'number']], help: 'Meshy 3D 생성 API — 잔여 크레딧 표시 (meshy.ai → API 키)' },
  gemini: { name: 'Gemini API 키', fields: [['apiKey', 'API 키', 'password'], ['keyPath', '또는 키 파일 경로', 'text']], help: 'Google은 잔여량 조회를 지원하지 않아 키 유효 여부만 표시' },
};
async function openAccounts() {
  const d = openDrawer({
    title: 'AI 사용량 계정 관리',
    bodyHTML: '<div id="acBody">불러오는 중…</div>',
    footerHTML: '<button data-drw-close>닫기</button>',
    width: 480,
  });
  const paint = async () => {
    const r = await api('/api/usage/accounts').catch((e) => ({ error: e.message }));
    const body = $('#acBody', d);
    if (r.error) { body.innerHTML = `<div class="err">${esc(r.error)}</div>`; return; }
    const opts = Object.entries(ACCOUNT_TYPES).map(([k, v]) => `<option value="${k}">${esc(v.name)}</option>`).join('');
    const swapRows = (state.agySwapAccounts || []).map((a) => `<div class="swrow" style="${a.active ? 'background:color-mix(in srgb, var(--ok) 7%, transparent);border-radius:6px;padding:6px 8px' : ''}">
      <span class="swl" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">${agentIcon('agy', a.active ? 'idle' : '')}<span>${esc(a.name ? `${a.name} (${a.email})` : a.email)}</span>${a.active ? '<span class="badge ok">● 현재 사용 중</span>' : '<span class="badge">대기 계정</span>'}</span>
      ${a.active ? '' : `<button type="button" class="btn-sm" data-ac-agyswap="${esc(a.email)}">${ICO.swap} 전환</button>`}
    </div>`).join('');
    body.innerHTML = `
      <div class="empty" style="padding:0">이 PC에서 자동 감지 ${r.detected?.length || 0}개 (Claude Code·Cursor·Codex 로그인) · 직접 추가 ${r.accounts?.length || 0}개${state.agySwapAccounts?.length ? ` · Antigravity ${state.agySwapAccounts.length}개` : ''}</div>
      ${swapRows ? `<div class="swlist">${swapRows}</div>` : ''}
      <div class="swlist">${(r.accounts || []).map((a) => `<div class="swrow"><span class="swl">${esc(a.label || a.id)} <span class="badge">${esc(ACCOUNT_TYPES[a.type]?.name || a.type)}</span></span>
        <button class="danger ghost btn-sm" data-del="${esc(a.id)}">삭제</button></div>`).join('') || (!swapRows ? '<div class="empty">직접 추가한 계정 없음</div>' : '')}</div>
      <details class="ac-add"><summary>계정 추가</summary>
      <div class="row" style="gap:6px;flex-wrap:wrap">
        <button id="acCodex" title="터미널이 열리고 코드가 나옵니다. 아무 브라우저(폰도 가능)에서 그 주소를 열어 코드를 넣고, 추가할 ChatGPT 계정으로 로그인하면 끝">＋ Codex 계정 추가 (ChatGPT 로그인)</button>
        ${state.agySwapAvailable ? '<button id="acAgy" title="agy-swap 로그인 터미널을 열어 새 Google Antigravity 계정을 추가합니다">＋ Antigravity 계정 추가 (Google 로그인)</button>' : ''}
      </div>
      <div class="empty" style="padding:0">Codex · Antigravity 계정이 여럿이면 터미널의 “다른 계정” 버튼으로 같은 대화를 다른 계정에서 이어갈 수 있습니다.</div>
      <label>종류<br><select id="acType" style="width:100%">${opts}</select></label>
      <label>이름(라벨)<br><input id="acLabel" style="width:100%" placeholder="예: 연구실 계정"></label>
      <div id="acFields"></div>
      <div class="empty" id="acHelp" style="padding:0"></div>
      <div class="empty" style="padding:0">토큰·키는 이 PC의 AI 사용량 대시보드 설정 파일에만 저장되고, 화면에는 가려서 표시됩니다.</div>
      <button type="button" class="primary" id="acAdd">입력한 계정 추가</button></details>`;
    const fields = () => {
      const t = ACCOUNT_TYPES[$('#acType', d).value];
      $('#acFields', d).innerHTML = t.fields.map(([k, lab, typ]) => `<label>${esc(lab)}<br><input data-f="${k}" type="${typ}" style="width:100%" autocomplete="off"></label>`).join('');
      $('#acHelp', d).innerHTML = t.help;
    };
    $('#acType', d).onchange = fields; fields();
    $('#acCodex', d).onclick = async () => {
      const t = await api('/api/codex/add', { method: 'POST', body: {} }).catch((e) => ({ error: e.message }));
      if (t.error) return toast(t.error, 6000, 'danger');
      d.close();
      await refreshOverview();
      select({ kind: 'term', id: t.id });
      toast('터미널에 나온 주소와 코드로 로그인하세요 — 끝나면 자동 등록됩니다', 8000);
    };
    const agyAddBtn = $('#acAgy', d);
    if (agyAddBtn) {
      agyAddBtn.onclick = async () => {
        const t = await api('/api/agy/add', { method: 'POST', body: {} }).catch((e) => ({ error: e.message }));
        if (t.error) return toast(t.error, 6000, 'danger');
        d.close();
        await refreshOverview();
        select({ kind: 'term', id: t.id });
        toast('터미널 안내에 따라 Google 계정을 로그인·추가하세요', 8000);
      };
    }
    body.querySelectorAll('[data-ac-agyswap]').forEach((b) => (b.onclick = async () => {
      if (await switchAgyAccount(b.dataset.acAgyswap, b)) paint();
    }));
    body.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
      if (!confirm('이 계정을 목록에서 삭제할까요?')) return;
      const x = await api('/api/usage/accounts', { method: 'POST', body: { action: 'delete', id: b.dataset.del } });
      if (x.error) return toast(x.error, 6000, 'danger');
      paint(); refreshUsage();
    }));
    $('#acAdd', d).onclick = async () => {
      const account = { type: $('#acType', d).value, label: $('#acLabel', d).value.trim() };
      d.querySelectorAll('[data-f]').forEach((i) => { if (i.value.trim()) account[i.dataset.f] = i.type === 'number' ? Number(i.value) : i.value.trim(); });
      if (!account.label) return toast('이름을 입력하세요');
      const x = await api('/api/usage/accounts', { method: 'POST', body: { account } });
      if (x.error) return toast(x.error, 8000, 'danger');
      toast('추가됨 — 사용량을 조회합니다');
      paint(); refreshUsage(true);
    };
  };
  paint();
}
