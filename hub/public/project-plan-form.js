const projectAccountField = '<label>CLI 계정<select name="account"></select></label><small data-account-status class="ums" role="status"></small>';

const projectModelEffortFields = `<div class="pj-me-grid">
  <label>모델<select name="modelPick"></select><input name="model" maxlength="120" placeholder="모델 ID 직접 입력" style="display:none;margin-top:4px"></label>
  <label>추론 성능<select name="effort"></select></label>
</div><small data-cli-opt-hint class="ums" style="margin:-6px 0 2px"></small>`;

const FALLBACK_CLI_OPTIONS = {
  codex: {
    models: [
      { id: 'gpt-6.1-sol', label: 'gpt-6.1-sol' },
      { id: 'gpt-5.4', label: 'gpt-5.4' },
      { id: 'gpt-5.4-mini', label: 'gpt-5.4-mini' },
      { id: 'o3', label: 'o3' },
      { id: 'o4-mini', label: 'o4-mini' },
    ],
    efforts: [
      { id: '', label: 'CLI 기본값' },
      { id: 'low', label: '낮음 (low)' },
      { id: 'medium', label: '보통 (medium)' },
      { id: 'high', label: '높음 (high)' },
      { id: 'xhigh', label: '매우 높음 (xhigh)' },
      { id: 'max', label: '최대 (max)' },
    ],
  },
  claude: {
    models: [
      { id: 'opus', label: 'Claude Opus (최신)' },
      { id: 'sonnet', label: 'Claude Sonnet (최신)' },
      { id: 'haiku', label: 'Claude Haiku (최신)' },
    ],
    efforts: [
      { id: '', label: 'CLI 기본값' },
      { id: 'low', label: '낮음 (low)' },
      { id: 'medium', label: '보통 (medium)' },
      { id: 'high', label: '높음 (high)' },
      { id: 'xhigh', label: '매우 높음 (xhigh)' },
      { id: 'max', label: '최대 (max)' },
    ],
  },
  agy: {
    models: [
      { id: 'gemini-4-neon-high', label: 'Gemini 4 Neon (High)' },
      { id: 'gemini-4-neon-xhigh', label: 'Gemini 4 Neon (XHigh)' },
      { id: 'gemini-4-neon-medium', label: 'Gemini 4 Neon (Medium)' },
      { id: 'gemini-4-argon-high', label: 'Gemini 4 Argon (High)' },
      { id: 'gemini-4-hydrogen-high', label: 'Gemini 4 Hydrogen (High)' },
      { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
      { id: 'claude-opus-5-5-high', label: 'Claude Opus 5.5 (High)' },
      { id: 'claude-sonnet-5-5-high', label: 'Claude Sonnet 5.5 (High)' },
    ],
    efforts: [
      { id: '', label: 'CLI 기본값' },
      { id: 'low', label: '낮음 (low)' },
      { id: 'medium', label: '보통 (medium)' },
      { id: 'high', label: '높음 (high)' },
      { id: 'xhigh', label: '매우 높음 (xhigh)' },
      { id: 'max', label: '최대 (max)' },
    ],
  },
  cursor: {
    models: [],
    efforts: [{ id: '', label: 'CLI 기본값' }],
  },
};

async function loadCliOptions() {
  if (state.cliOptions) return state.cliOptions;
  try {
    const r = await api('/api/projects/cli-options');
    if (r?.options) { state.cliOptions = r.options; return r.options; }
  } catch {}
  return FALLBACK_CLI_OPTIONS;
}

function bindProjectAccounts(dialog, selected, project, initModel = '', initEffort = '') {
  const agent = dialog.querySelector('[name=agent]');
  const account = dialog.querySelector('[name=account]');
  const status = dialog.querySelector('[data-account-status]');
  const modelPick = dialog.querySelector('[name=modelPick]');
  const modelIn = dialog.querySelector('[name=model]');
  const effortSel = dialog.querySelector('[name=effort]');
  const cliHint = dialog.querySelector('[data-cli-opt-hint]');

  let version = 0;
  const selectedByCli = new Map();
  const modelByCli = new Map();
  const effortByCli = new Map();
  let activeCli;
  let cliOpts = state.cliOptions || FALLBACK_CLI_OPTIONS;

  const paintModelEffort = (kind, wantModel, wantEffort) => {
    if (!modelPick || !modelIn || !effortSel) return;
    const cfg = cliOpts[kind] || FALLBACK_CLI_OPTIONS[kind] || { models: [], efforts: [{ id: '', label: 'CLI 기본값' }] };
    const inheritLabel = project
      ? `상위/Project 기본값${project.model && (!agent.value || agent.value === project.agent) ? ` (${project.model})` : ''}`
      : (cfg.defaultModel ? `CLI 기본값 (${cfg.defaultModel})` : 'CLI 기본값');
    const mOpts = [['', inheritLabel], ...(cfg.models || []).map((m) => [m.id, m.label]), ['__custom__', '직접 입력…']];
    modelPick.replaceChildren(...mOpts.map(([id, label]) => new Option(label, id)));
    const known = (cfg.models || []).some((m) => m.id === wantModel);
    if (!wantModel) {
      modelPick.value = '';
      modelIn.value = '';
      modelIn.style.display = 'none';
    } else if (known) {
      modelPick.value = wantModel;
      modelIn.value = wantModel;
      modelIn.style.display = 'none';
    } else {
      modelPick.value = '__custom__';
      modelIn.value = wantModel;
      modelIn.style.display = '';
    }

    const effInheritLabel = project
      ? `상위/Project 기본값${project.effort && (!agent.value || agent.value === project.agent) ? ` (${project.effort})` : ''}`
      : (cfg.defaultEffort ? `CLI 기본값 (${cfg.defaultEffort})` : 'CLI 기본값');
    const eOpts = (cfg.efforts || [{ id: '', label: 'CLI 기본값' }]).map((e, i) => [e.id, i === 0 ? effInheritLabel : e.label]);
    effortSel.replaceChildren(...eOpts.map(([id, label]) => new Option(label, id)));
    effortSel.value = eOpts.some(([id]) => id === wantEffort) ? wantEffort : '';
    effortSel.disabled = eOpts.length <= 1;

    if (cliHint) {
      cliHint.textContent = kind === 'codex'
        ? 'Codex: -m <모델> · model_reasoning_effort 설정이 계획 생성 및 작업 터미널에 자동 적용됩니다.'
        : kind === 'claude'
          ? 'Claude Code: --model · --effort 옵션이 계획 생성 및 작업 터미널에 자동 적용됩니다.'
          : kind === 'agy'
            ? 'Antigravity CLI: --model · --effort 옵션이 계획 생성 및 작업 터미널에 자동 적용됩니다.'
            : 'Cursor는 CLI 기본 모델 설정을 사용합니다.';
    }
  };

  if (modelPick && modelIn) {
    modelPick.addEventListener('change', () => {
      if (modelPick.value === '__custom__') {
        modelIn.style.display = '';
        modelIn.focus();
      } else {
        modelIn.style.display = 'none';
        modelIn.value = modelPick.value;
      }
    });
  }

  const refresh = async () => {
    const load = ++version;
    const kind = agent.value || project?.agent || 'codex';
    if (!activeCli) {
      selectedByCli.set(kind, selected);
      modelByCli.set(kind, initModel || '');
      effortByCli.set(kind, initEffort || '');
    } else {
      selectedByCli.set(activeCli, account.value);
      if (modelIn) modelByCli.set(activeCli, modelIn.value.trim());
      if (effortSel) effortByCli.set(activeCli, effortSel.value);
    }
    activeCli = kind;
    const preferred = selectedByCli.get(kind);
    const inherited = project && kind === (project.agent || 'codex');
    const options = inherited ? [['inherit', 'Project 기본 계정'], ['', '이 PC의 CLI 로그인']] : [['', '이 PC의 CLI 로그인']];
    const paint = (value = preferred) => {
      account.replaceChildren(...options.map(([id, label]) => new Option(label, id)));
      if (options.some(([id]) => id === value)) account.value = value;
    };
    if (preferred && preferred !== 'inherit') options.push([preferred, '저장된 계정']);
    paint();
    paintModelEffort(kind, modelByCli.get(kind) || '', effortByCli.get(kind) || '');
    status.textContent = '등록 계정 불러오는 중…';
    try {
      const [r, opts] = await Promise.all([
        api('/api/projects/accounts?agent=' + encodeURIComponent(kind)),
        loadCliOptions(),
      ]);
      if (load !== version || !dialog.isConnected) return;
      cliOpts = opts || cliOpts;
      paintModelEffort(kind, modelIn ? modelIn.value.trim() : (modelByCli.get(kind) || ''), effortSel ? effortSel.value : (effortByCli.get(kind) || ''));
      if (!Array.isArray(r.accounts)) throw new Error('계정 목록을 불러올 수 없습니다.');
      for (const { id, label } of r.accounts) {
        const i = options.findIndex(([key]) => key === id);
        if (i >= 0) options[i] = [id, label]; else options.push([id, label]);
      }
      paint(account.value);
      status.textContent = r.accounts.length ? `등록 계정 ${r.accounts.length}개` : '등록된 추가 계정이 없어 이 PC의 CLI 로그인을 사용할 수 있습니다.';
    } catch (e) { if (load === version) status.textContent = e.message; }
  };
  agent.addEventListener('change', refresh);
  refresh();
}

function fmtPlanElapsed(ms) {
  const s = Math.max(0, Math.floor((ms || 0) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

async function runPlanWithProgress(hostEl, cliName, apiCall, initialStage) {
  const startedAt = Date.now();
  let curStage = initialStage || `${cliName} 실행 중…`;
  let curPct = 10;
  let curLogs = [];

  const paintProgress = () => {
    if (!hostEl || !hostEl.isConnected) return;
    const elapsed = Date.now() - startedAt;
    const autoPct = Math.min(88, Math.round(12 + (elapsed / 1000) * 1.6));
    const pct = Math.max(curPct, autoPct);
    const logsHTML = curLogs.length
      ? `<div class="pj-plan-log">${curLogs.map((l) => `<div>${esc(l)}</div>`).join('')}</div>`
      : '';
    hostEl.innerHTML = `<div class="pj-plan-prog">
      <div class="pj-plan-prog-top">
        <span class="pj-plan-stage"><span class="dot busy"></span><b>${esc(cliName)}</b> · ${esc(curStage)}</span>
        <span class="pj-plan-time mono">${fmtPlanElapsed(elapsed)} · ${pct}%</span>
      </div>
      <div class="pj-plan-bar"><i style="width:${pct}%"></i></div>
      ${logsHTML}
    </div>`;
  };

  paintProgress();
  const tickTimer = setInterval(paintProgress, 500);
  const pollTimer = setInterval(async () => {
    try {
      const st = await api('/api/projects/plan/status');
      if (st?.active) {
        if (st.stage) curStage = st.stage;
        if (typeof st.pct === 'number') curPct = Math.max(curPct, st.pct);
        if (Array.isArray(st.logs)) curLogs = st.logs;
        paintProgress();
      }
    } catch {}
  }, 700);

  try {
    const r = await apiCall();
    return { r, elapsedMs: Date.now() - startedAt };
  } finally {
    clearInterval(tickTimer);
    clearInterval(pollTimer);
  }
}

async function previewProjectPlan(dialog, draft, showPreview) {
  const preview = dialog.querySelector('[data-plan-preview]');
  if (!draft.goal.trim()) throw new Error('목표·완료 기준을 먼저 입력하세요.');
  if (draft.agent === 'cursor') throw new Error('Cursor는 작업 실행에 사용할 수 있습니다. 자동 설계에는 AGY, Claude Code 또는 Codex를 선택하세요.');

  const cliName = typeof providerName === 'function' ? providerName(draft.agent) : draft.agent;
  try {
    const { r, elapsedMs } = await runPlanWithProgress(
      preview,
      cliName,
      () => api('/api/projects/plan', { method: 'POST', body: draft }),
      `${cliName} 실행 중…`,
    );
    if (!Array.isArray(r.tasks) || !r.tasks.length) throw new Error(r.error || '작업 흐름을 불러올 수 없습니다.');
    if (!showPreview) {
      preview.innerHTML = `<div class="pj-plan-prog done"><div class="pj-plan-prog-top"><span class="pj-plan-stage"><b>✓ 작업 ${r.tasks.length}개 생성 완료</b> · 저장 중…</span><span class="pj-plan-time mono">${fmtPlanElapsed(elapsedMs)} · 100%</span></div><div class="pj-plan-bar"><i style="width:100%"></i></div></div>`;
      return r.tasks;
    }
    preview.innerHTML = `<strong>작업 흐름 초안 · ${r.tasks.length}개</strong><ol>${r.tasks.map(t => `<li><b>${esc(t.title)}</b><p>${esc(t.detail)}</p>${t.after.length ? `<small>선행 작업 · ${t.after.map(id => esc(r.tasks.find(x => x.id === id)?.title)).join(', ')}</small>` : ''}</li>`).join('')}</ol>`;
    preview.scrollIntoView({ block: 'nearest' });
    return r.tasks;
  } catch (e) {
    preview.textContent = '';
    throw e;
  }
}
