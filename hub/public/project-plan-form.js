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

const CLI_DEFAULTS_STORAGE_KEY = 'ach.cliDefaults.v1';

function readCliDefaultsMap() {
  try {
    const o = JSON.parse(localStorage.getItem(CLI_DEFAULTS_STORAGE_KEY) || '{}');
    return o && typeof o === 'object' ? o : {};
  } catch { return {}; }
}

function readSavedCliDefaults(cli) {
  const map = readCliDefaultsMap();
  const d = cli ? map[cli] : null;
  return d && typeof d === 'object'
    ? { account: String(d.account || ''), model: String(d.model || ''), effort: String(d.effort || '') }
    : { account: '', model: '', effort: '' };
}

function saveCliDefaults(cli, patch = {}) {
  if (!['claude', 'codex', 'agy'].includes(cli)) return;
  const map = readCliDefaultsMap();
  const cur = map[cli] && typeof map[cli] === 'object' ? map[cli] : {};
  map[cli] = {
    account: patch.account !== undefined ? String(patch.account || '') : String(cur.account || ''),
    model: patch.model !== undefined ? String(patch.model || '') : String(cur.model || ''),
    effort: patch.effort !== undefined ? String(patch.effort || '') : String(cur.effort || ''),
  };
  try { localStorage.setItem(CLI_DEFAULTS_STORAGE_KEY, JSON.stringify(map)); } catch {}
}

function createCliModelEffortController({
  modelPick,
  modelIn,
  effortSel,
  hintEl = null,
  project = null,
  initialKind = 'claude',
  initialModel = '',
  initialEffort = '',
  useSavedDefaults = !project,
  persistDefaults = !project,
  inheritProjectAgent = null,
  onChange = null,
} = {}) {
  const modelByCli = new Map();
  const effortByCli = new Map();
  let curKind = initialKind || 'claude';
  let cliOpts = (typeof state !== 'undefined' && state?.cliOptions) || FALLBACK_CLI_OPTIONS;
  const initSaved = useSavedDefaults ? readSavedCliDefaults(curKind) : { model: '', effort: '' };
  const startModel = initialModel !== '' ? initialModel : initSaved.model;
  const startEffort = initialEffort !== '' ? initialEffort : initSaved.effort;
  modelByCli.set(curKind, startModel || '');
  effortByCli.set(curKind, startEffort || '');

  const currentModel = () => (modelIn && modelPick?.value === '__custom__' ? modelIn.value.trim() : (modelPick?.value || modelIn?.value || '').trim());
  const currentEffort = () => (effortSel?.value || '');

  const paint = (kind, wantModel, wantEffort) => {
    curKind = kind || 'claude';
    const cfg = cliOpts[curKind] || FALLBACK_CLI_OPTIONS[curKind] || { models: [], efforts: [{ id: '', label: 'CLI 기본값' }] };
    const refAgent = typeof inheritProjectAgent === 'function' ? inheritProjectAgent() : '';
    const sameProj = project && (!refAgent || refAgent === project.agent);

    if (modelPick) {
      const inheritLabel = project
        ? `상위/Project 기본값${project.model && sameProj ? ` (${project.model})` : ''}`
        : (cfg.defaultModel ? `CLI 기본값 (${cfg.defaultModel})` : 'CLI 기본값');
      const mOpts = [['', inheritLabel], ...(cfg.models || []).map((m) => [m.id, m.label]), ['__custom__', '직접 입력…']];
      modelPick.replaceChildren(...mOpts.map(([id, label]) => new Option(label, id)));
      const wm = String(wantModel ?? '');
      const known = (cfg.models || []).some((m) => m.id === wm);
      if (!wm) {
        modelPick.value = '';
        if (modelIn) { modelIn.value = ''; modelIn.style.display = 'none'; }
      } else if (known) {
        modelPick.value = wm;
        if (modelIn) { modelIn.value = wm; modelIn.style.display = 'none'; }
      } else {
        modelPick.value = '__custom__';
        if (modelIn) { modelIn.value = wm; modelIn.style.display = ''; }
      }
    }

    if (effortSel) {
      const effInheritLabel = project
        ? `상위/Project 기본값${project.effort && sameProj ? ` (${project.effort})` : ''}`
        : (cfg.defaultEffort ? `CLI 기본값 (${cfg.defaultEffort})` : 'CLI 기본값');
      const eOpts = (cfg.efforts || [{ id: '', label: 'CLI 기본값' }]).map((e, i) => [e.id, i === 0 ? effInheritLabel : e.label]);
      effortSel.replaceChildren(...eOpts.map(([id, label]) => new Option(label, id)));
      const we = String(wantEffort ?? '');
      effortSel.value = eOpts.some(([id]) => id === we) ? we : '';
      effortSel.disabled = eOpts.length <= 1;
    }

    if (hintEl) {
      hintEl.textContent = curKind === 'codex'
        ? (document.documentElement.lang === 'en'
          ? 'Codex: -m <model> · model_reasoning_effort applies automatically to planning & task terminals.'
          : 'Codex: -m <모델> · model_reasoning_effort 설정이 계획 생성 및 작업 터미널에 자동 적용됩니다.')
        : curKind === 'claude'
          ? 'Claude Code: --model · --effort 옵션이 계획 생성 및 작업 터미널에 자동 적용됩니다.'
          : curKind === 'agy'
            ? 'Antigravity CLI: --model · --effort 옵션이 계획 생성 및 작업 터미널에 자동 적용됩니다.'
            : 'Cursor는 CLI 기본 모델 설정을 사용합니다.';
    }
  };

  const emit = () => {
    const m = currentModel();
    const ef = currentEffort();
    modelByCli.set(curKind, m);
    effortByCli.set(curKind, ef);
    if (persistDefaults) saveCliDefaults(curKind, { model: m, effort: ef });
    onChange?.({ kind: curKind, model: m, effort: ef });
  };

  if (modelPick) {
    modelPick.addEventListener('change', () => {
      if (modelIn) {
        if (modelPick.value === '__custom__') {
          modelIn.style.display = '';
          modelIn.focus();
        } else {
          modelIn.style.display = 'none';
          modelIn.value = modelPick.value;
        }
      }
      emit();
    });
  }
  if (modelIn) modelIn.addEventListener('input', emit);
  if (effortSel) effortSel.addEventListener('change', emit);

  paint(curKind, startModel, startEffort);
  loadCliOptions().then((opts) => {
    if (!opts) return;
    cliOpts = opts;
    if (modelPick && !modelPick.isConnected) return;
    paint(curKind, currentModel(), currentEffort());
  });

  return {
    setCli(nextKind, nextModel = undefined, nextEffort = undefined) {
      const k = nextKind || 'claude';
      modelByCli.set(curKind, currentModel());
      effortByCli.set(curKind, currentEffort());
      const savedNext = useSavedDefaults ? readSavedCliDefaults(k) : { model: '', effort: '' };
      const wm = nextModel !== undefined ? nextModel : (modelByCli.has(k) ? modelByCli.get(k) : savedNext.model);
      const we = nextEffort !== undefined ? nextEffort : (effortByCli.has(k) ? effortByCli.get(k) : savedNext.effort);
      modelByCli.set(k, wm);
      effortByCli.set(k, we);
      paint(k, wm, we);
    },
    repaintProject() {
      paint(curKind, currentModel(), currentEffort());
    },
    getValues() {
      return { kind: curKind, model: currentModel(), effort: currentEffort() };
    },
  };
}

function bindProjectAccounts(dialog, selected, project, initModel = '', initEffort = '') {
  const agent = dialog.querySelector('[name=agent]');
  const account = dialog.querySelector('[name=account]');
  const status = dialog.querySelector('[data-account-status]');
  const meCtl = createCliModelEffortController({
    modelPick: dialog.querySelector('[name=modelPick]'),
    modelIn: dialog.querySelector('[name=model]'),
    effortSel: dialog.querySelector('[name=effort]'),
    hintEl: dialog.querySelector('[data-cli-opt-hint]'),
    project,
    initialKind: agent.value || project?.agent || 'codex',
    initialModel: initModel || '',
    initialEffort: initEffort || '',
    useSavedDefaults: !project && !initModel && !initEffort,
    persistDefaults: !project,
    inheritProjectAgent: () => agent.value,
  });

  let version = 0;
  const selectedByCli = new Map();
  let activeCli;
  if (!project && account) {
    account.addEventListener('change', () => {
      saveCliDefaults(agent.value || 'codex', { account: account.value });
    });
  }

  const refresh = async () => {
    const load = ++version;
    const kind = agent.value || project?.agent || 'codex';
    if (!activeCli) {
      selectedByCli.set(kind, selected || (!project ? readSavedCliDefaults(kind).account : ''));
    } else {
      selectedByCli.set(activeCli, account.value);
    }
    activeCli = kind;
    const preferred = selectedByCli.has(kind)
      ? selectedByCli.get(kind)
      : (!project ? readSavedCliDefaults(kind).account : '');
    const inherited = project && kind === (project.agent || 'codex');
    const options = inherited ? [['inherit', 'Project 기본 계정'], ['', '이 PC의 CLI 로그인']] : [['', '이 PC의 CLI 로그인']];
    const paint = (value = preferred) => {
      account.replaceChildren(...options.map(([id, label]) => new Option(label, id)));
      if (options.some(([id]) => id === value)) account.value = value;
    };
    if (preferred && preferred !== 'inherit') options.push([preferred, '저장된 계정']);
    paint();
    meCtl.setCli(kind);
    status.textContent = '등록 계정 불러오는 중…';
    try {
      const r = await api('/api/projects/accounts?agent=' + encodeURIComponent(kind));
      if (load !== version || !dialog.isConnected) return;
      meCtl.repaintProject();
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
