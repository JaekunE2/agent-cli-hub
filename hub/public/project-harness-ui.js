// Project Role Presets (plan / dev / test / review / ops) & Per-CLI Agent Adapters UI
async function openProjectHarnessDrawer() {
  let stats = {};
  try {
    const res = await api('/api/projects/harness');
    if (res.error || !res.ok || !res.harness) throw new Error(res.error || 'Role · 에이전트 하네스를 불러오지 못했습니다.');
    state.projectHarness = res.harness;
    stats = res.stats || {};
  } catch (e) {
    if (!state.projectHarness?.roles) { toast(e.message, 5000, 'danger'); return; }
  }
  const harness = state.projectHarness || { roles: {}, adapters: {} };
  const roles = JSON.parse(JSON.stringify(harness.roles || {}));
  const adapters = JSON.parse(JSON.stringify(harness.adapters || {}));
  const roleOrder = ['plan', 'dev', 'test', 'review', 'merge', 'ops'];
  const adapterOrder = ['codex', 'claude', 'agy'];
  const effortOpts = [
    ['', 'CLI 기본값'],
    ['low', '낮음 (low)'],
    ['medium', '보통 (medium)'],
    ['high', '높음 (high)'],
    ['xhigh', '매우 높음 (xhigh)'],
    ['max', '최대 (max)'],
  ];
  const cliOpts = [
    ['', 'Project 기본값 따르기'],
    ['codex', 'Codex CLI'],
    ['claude', 'Claude Code'],
    ['agy', 'Antigravity (AGY)'],
    ['cursor', 'Cursor Agent'],
  ];

  let activeTab = 'roles';
  let activeRole = 'plan';

  const bodyHTML = `
    <div class="ums" style="margin:0"><b>universal-agent-harness</b> 표준 기반 Role 프리셋과 에이전트 어댑터입니다. 태스크 시작 및 서브 개발 채팅 첫 턴에 자동 주입됩니다.</div>
    <div class="pj-hr-tabs" role="group" aria-label="Role · 에이전트 하네스 설정">
      <button type="button" class="on" data-hr-tab="roles">Role 프리셋 (6)</button>
      <button type="button" data-hr-tab="adapters">CLI 어댑터 (3)</button>
    </div>
    <div id="hrBody"></div>`;

  const footHTML = `
    <p class="pj-hr-save-error" role="alert" id="hrSaveError"></p>
    <button type="button" class="ghost danger" id="hrResetBtn">기본값 복원</button>
    <span class="sp"></span>
    <button type="button" data-drw-close>취소</button>
    <button type="button" class="primary" id="hrSaveBtn">하네스 저장</button>`;

  const d = openDrawer({ title: 'Role · 에이전트 하네스 설정', bodyHTML, footerHTML: footHTML, width: 640 });
  const bodyEl = d.querySelector('#hrBody');

  const commitVisibleInputs = () => {
    const roleCard = bodyEl.querySelector('[data-hr-role]');
    if (roleCard) {
      const id = roleCard.dataset.hrRole;
      roles[id] = {
        ...(roles[id] || { id }),
        id,
        agent: roleCard.querySelector('[data-hr-field="agent"]').value,
        effort: roleCard.querySelector('[data-hr-field="effort"]').value,
        model: roleCard.querySelector('[data-hr-field="model"]').value.trim(),
        account: roleCard.querySelector('[data-hr-field="account"]').value.trim(),
        readOnly: !!roleCard.querySelector('[data-hr-field="readOnly"]')?.checked,
        writableGlobs: roleCard.querySelector('[data-hr-field="writableGlobs"]')?.value.trim() || '',
        template: roleCard.querySelector('[data-hr-field="template"]').value,
      };
    }
    for (const sec of bodyEl.querySelectorAll('[data-hr-adapter]')) {
      const cli = sec.dataset.hrAdapter;
      adapters[cli] = {
        ...(adapters[cli] || { id: cli }),
        id: cli,
        rules: sec.querySelector('[data-hr-field="rules"]').value,
      };
    }
  };

  const render = () => {
    for (const b of d.querySelectorAll('[data-hr-tab]')) {
      const selected = b.dataset.hrTab === activeTab;
      b.classList.toggle('on', selected);
      b.setAttribute('aria-pressed', String(selected));
    }
    if (activeTab === 'roles') {
      const pillsHTML = roleOrder.map((id) => {
        const r = roles[id] || { id, label: id, agent: '', model: '', effort: '' };
        const cliLbl = r.agent ? (typeof providerName === 'function' ? providerName(r.agent) : r.agent) : 'Project 기본';
        const meta = [cliLbl, r.model, r.effort].filter(Boolean).join(' · ');
        return `<button type="button" class="pj-hr-pill${activeRole === id ? ' on' : ''}" aria-pressed="${activeRole === id}" data-hr-pick-role="${esc(id)}">
          <span class="row" style="gap:7px;min-width:0"><span class="badge kind-${esc(id)}">${esc(id)}</span><b style="font-size:13px">${esc(r.label || id)}</b></span>
          <span class="pj-hr-pill-meta">${esc(meta)}</span>
        </button>`;
      }).join('');

      const r = roles[activeRole] || { id: activeRole, label: activeRole, agent: '', account: '', model: '', effort: '', readOnly: false, writableGlobs: '', template: '' };
      const rs = stats[activeRole];
      const statBadge = rs?.done ? `<span class="badge">완료 ${rs.done} · 1차 통과 ${Math.round((rs.firstPass / rs.done) * 100)}%</span>` : '';
      const editorHTML = `<section class="pj-hr-card" data-hr-role="${esc(activeRole)}">
        <div class="row" style="justify-content:space-between">
          <span class="row" style="gap:8px"><span class="badge kind-${esc(activeRole)}">${esc(activeRole)}</span><b>${esc(r.label || activeRole)}</b></span>
          ${statBadge}
        </div>
        <div class="pj-me-grid">
          <label class="pj-hr-field">기본 추천 CLI<select data-hr-field="agent">${cliOpts.map(([v, l]) => `<option value="${esc(v)}" ${r.agent === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
          <label class="pj-hr-field">추천 추론 성능<select data-hr-field="effort">${effortOpts.map(([v, l]) => `<option value="${esc(v)}" ${r.effort === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
        </div>
        <div class="pj-me-grid">
          <label class="pj-hr-field">추천 모델 ID<input data-hr-field="model" value="${esc(r.model || '')}" placeholder="예: opus, gpt-5.4, gemini-4-argon-high"></label>
          <label class="pj-hr-field">기본 계정 ID (선택)<input data-hr-field="account" value="${esc(r.account || '')}" placeholder="비워두면 현재/Project 계정"></label>
        </div>
        <div class="pj-me-grid" style="align-items:center">
          <label class="row" style="gap:6px;cursor:pointer"><input type="checkbox" data-hr-field="readOnly"${r.readOnly ? ' checked' : ''}><span>읽기 전용 Role (코드 수정 제한)</span></label>
          <label class="pj-hr-field">쓰기 허용 경로 (쉼표 구분, 선택)<input data-hr-field="writableGlobs" value="${esc(r.writableGlobs || '')}" placeholder="예: docs/**, *.md"></label>
        </div>
        <label class="pj-hr-field">행동 제약 · 완료 기준 템플릿<textarea data-hr-field="template" rows="6">${esc(r.template || '')}</textarea></label>
      </section>`;

      bodyEl.innerHTML = `<div style="display:flex;flex-direction:column;gap:12px">
        <div class="pj-hr-pills">${pillsHTML}</div>
        ${editorHTML}
      </div>`;
    } else {
      bodyEl.innerHTML = `<div style="display:flex;flex-direction:column;gap:12px">${adapterOrder.map((cli) => {
        const a = adapters[cli] || { id: cli, label: cli, rules: '' };
        return `<section class="pj-hr-card" data-hr-adapter="${esc(cli)}">
          <div class="row" style="justify-content:space-between">
            <span class="row" style="gap:6px">${typeof agentIcon === 'function' ? agentIcon(cli) : ''}<b>${esc(a.label || cli)}</b></span>
            <span class="badge">${esc(cli)}</span>
          </div>
          <label class="pj-hr-field">CLI 전용 추가 운영 규칙<textarea data-hr-field="rules" rows="4" style="min-height:90px">${esc(a.rules || '')}</textarea></label>
        </section>`;
      }).join('')}</div>`;
    }
  };

  d.addEventListener('click', (e) => {
    const tabBtn = e.target.closest('[data-hr-tab]');
    if (tabBtn) {
      commitVisibleInputs();
      activeTab = tabBtn.dataset.hrTab;
      render();
      return;
    }
    const roleBtn = e.target.closest('[data-hr-pick-role]');
    if (roleBtn) {
      commitVisibleInputs();
      activeRole = roleBtn.dataset.hrPickRole;
      render();
      bodyEl.querySelector(`[data-hr-pick-role="${activeRole}"]`).focus();
    }
  });

  const saveBtn = d.querySelector('#hrSaveBtn');
  const resetBtn = d.querySelector('#hrResetBtn');
  const errorEl = d.querySelector('#hrSaveError');
  const formBody = d.querySelector('.drw-body');
  const persist = async (body, button, message) => {
    if (saveBtn.disabled) return;
    saveBtn.disabled = resetBtn.disabled = formBody.inert = true;
    errorEl.textContent = '';
    try {
      const r = await api('/api/projects/harness', { method: 'POST', body, requireOk: true });
      if (!r?.harness || r.error) throw new Error(r?.error || '하네스 설정 저장 응답이 올바르지 않습니다.');
      state.projectHarness = r.harness;
      d.close();
      toast(message);
      if (typeof viewProjects === 'function' && state.sel?.kind === 'projects') viewProjects();
    } catch (e) {
      errorEl.textContent = e.message;
    } finally {
      saveBtn.disabled = resetBtn.disabled = formBody.inert = false;
      if (errorEl.textContent && document.activeElement === document.body) button.focus();
    }
  };

  resetBtn.onclick = () => {
    if (!confirm('universal-agent-harness 기반 기본 Role 프리셋과 에이전트 어댑터로 초기화할까요?')) return;
    return persist({ action: 'reset' }, resetBtn, 'Role · 에이전트 하네스를 기본값으로 복원했습니다.');
  };

  saveBtn.onclick = () => {
    commitVisibleInputs();
    const cleanRoles = {};
    for (const id of roleOrder) {
      const cur = roles[id] || { id };
      cleanRoles[id] = {
        id,
        label: cur.label || id,
        agent: cur.agent || '',
        effort: cur.effort || '',
        model: String(cur.model || '').trim(),
        account: String(cur.account || '').trim(),
        template: String(cur.template || '').trim(),
      };
    }
    const cleanAdapters = {};
    for (const cli of adapterOrder) {
      const cur = adapters[cli] || { id: cli };
      cleanAdapters[cli] = {
        id: cli,
        label: cur.label || cli,
        rules: String(cur.rules || '').trim(),
      };
    }
    return persist({ roles: cleanRoles, adapters: cleanAdapters }, saveBtn, 'Role · 에이전트 하네스를 저장했습니다.');
  };

  render();
}
window.openProjectHarnessDrawer = openProjectHarnessDrawer;
