'use strict';

const fs = require('fs');
const path = require('path');
const { kinds, agents, efforts, MODEL_RE, inferTaskKind } = require('./project-validation');

const ROLE_IDS = ['plan', 'dev', 'test', 'review', 'merge', 'ops'];
const ADAPTER_CLIS = ['codex', 'claude', 'agy'];

/**
 * Default Role Presets pre-populated from universal-agent-harness (roles/*.md & AGENTS.md).
 * Each role defines recommended CLI/model/effort and behavior constraints + completion criteria.
 */
const DEFAULT_ROLE_PRESETS = {
  plan: {
    id: 'plan',
    label: '설계 · 기획 (PM / Architect)',
    agent: 'claude',
    account: '',
    model: 'opus',
    effort: 'high',
    template: [
      '[행동 제약]',
      '- 구현 코드를 직접 수정하지 않고 범위·아키텍처·API/데이터 계약·의존성만 설계합니다.',
      '- 기존 파일·태스크와 중복되는 작업이 없는지 먼저 확인합니다.',
      '- 모호하거나 상충하는 요구사항만 질문하고, 명확하면 실행 가능한 작업 단위로 분해합니다.',
      '[완료 기준]',
      '- 현재 상태 → 기대 동작, 변경 대상 파일/모듈, BE/FE 계약, 검증 명령이 명시되어야 합니다.',
    ].join('\n'),
  },
  dev: {
    id: 'dev',
    label: '개발 · 구현 (BE / FE Engineer)',
    agent: 'codex',
    account: '',
    model: 'gpt-6.2-sol',
    effort: 'high',
    template: [
      '[행동 제약]',
      '- 수정 전 현재 → 기대 동작, 변경 대상 파일, 검증 명령을 짧게 정리합니다.',
      '- 할당된 태스크 범위와 경계 외 파일을 임의로 수정하거나 미승인 라이브러리/DB를 추가하지 않습니다.',
      '- 예상 밖의 오류를 삼키지 말고 원인을 추적 가능하게 처리합니다.',
      '[완료 기준]',
      '- 직접 실행한 테스트/빌드/린트 명령과 실제 통과 결과를 근거로 보고합니다.',
    ].join('\n'),
  },
  test: {
    id: 'test',
    label: '테스트 · 검증 (Integration QA)',
    agent: 'claude',
    account: '',
    model: 'sonnet',
    effort: 'medium',
    template: [
      '[행동 제약]',
      '- 기능 구현 코드를 임의로 재작성하지 않고 통합·회귀·경계 조건 검증에 집중합니다.',
      '- 미실행 항목을 통과로 처리하지 않습니다.',
      '[완료 기준]',
      '- 직접 실행한 테스트 명령, HTTP/UI 상태, 로그 등 관찰된 근거만 기록합니다.',
      '- 실패 시 재현 절차, 기대 결과, 실제 결과, 추정 원인을 분리해 보고합니다.',
    ].join('\n'),
  },
  review: {
    id: 'review',
    label: '교차 리뷰 · 감사 (Cross-Reviewer / Auditor)',
    agent: 'agy',
    account: '',
    model: 'gemini-4-argon-high',
    effort: 'high',
    readOnly: true,
    writableGlobs: '',
    template: [
      '[행동 제약]',
      '- 구현과 독립된 관점에서 숨은 결함(경계값, 동시성, 트랜잭션/에러 삼킴)과 전제 가정을 검증합니다.',
      '- 불필요한 중복·과도한 추상화·변경 범위 밖 사이드 이펙트를 점검합니다.',
      '[완료 기준]',
      '- Blocker / Warning / Note 순으로 우선순위를 나누고 파일 경로·라인 근거를 반드시 붙입니다.',
    ].join('\n'),
  },
  merge: {
    id: 'merge',
    label: '병합 · 최종 검증 (Merge Verifier)',
    agent: '',
    account: '',
    model: '',
    effort: 'medium',
    readOnly: false,
    writableGlobs: '',
    template: [
      '[행동 제약]',
      '- 대상 브랜치 반영 시 기존 작업과 충돌하는 변경을 임의로 덮어쓰지 않고 양쪽 의도를 보존합니다.',
      '- `hub: auto-stash`가 남아 있으면 충돌 여부를 확인해 안전하게 복원·정리합니다.',
      '- `.token`, 비밀번호, API 키 등 민감 정보가 커밋·산출물에 섞이지 않았는지 확인합니다.',
      '[완료 기준]',
      '- `git status`, `git log -n 3 --oneline` 및 핵심 테스트/빌드 통과 결과를 요약해 보고합니다.',
    ].join('\n'),
  },
  ops: {
    id: 'ops',
    label: '배포 · 문서 · 운영 (Ops / Docs)',
    agent: 'agy',
    account: '',
    model: 'gemini-3.8-flash-medium',
    effort: 'medium',
    template: [
      '[행동 제약]',
      '- 사용자 승인 없이 타겟 보호 브랜치(main/dev 등)에 직접 머지하거나 보호 설정을 바꾸지 않습니다.',
      '- 사실 기반(직접 확인한 경로·명령·출력)으로만 문서와 배포 절차를 작성합니다.',
      '[완료 기준]',
      '- 설정·문서 정합성 확인 결과와, 차단 사유가 있을 경우 원인·현재 상태·다음 담당을 명시합니다.',
    ].join('\n'),
  },
};

/**
 * Per-CLI short operational adapters applied only when running that specific CLI.
 */
const DEFAULT_AGENT_ADAPTERS = {
  codex: {
    id: 'codex',
    label: 'Codex CLI',
    rules: [
      '- 파일 수정 후 변경된 파일 목록과 핵심 diff 요약을 남깁니다.',
      '- 테스트/빌드 검증 명령을 직접 실행하고 종료 코드·핵심 출력을 그대로 보고합니다.',
    ].join('\n'),
  },
  claude: {
    id: 'claude',
    label: 'Claude Code',
    rules: [
      '- 수정 전 관련 파일과 호출부 영향 범위를 먼저 조회해 확인합니다.',
      '- 보고 시 실제로 읽은 파일 경로·심볼명과 실행한 도구/테스트 출력만 근거로 인용합니다.',
    ].join('\n'),
  },
  agy: {
    id: 'agy',
    label: 'Antigravity (AGY)',
    rules: [
      '- 작업 전 짧은 실행 계획을 세우고, 수정 후 브라우저/명령 검증 결과를 아티팩트 또는 경로와 함께 보고합니다.',
      '- 한국어로 간결하게 핵심 결과와 후속 조치를 정리합니다.',
    ].join('\n'),
  },
};

function cloneDefaults() {
  return {
    roles: JSON.parse(JSON.stringify(DEFAULT_ROLE_PRESETS)),
    adapters: JSON.parse(JSON.stringify(DEFAULT_AGENT_ADAPTERS)),
  };
}

function normalizeRoleEntry(id, raw, fallback) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const base = fallback || DEFAULT_ROLE_PRESETS.dev;
  const ag = agents.includes(r.agent) ? r.agent : (r.agent === '' ? '' : base.agent);
  const m = String(r.model ?? base.model ?? '').trim();
  const ef = String(r.effort ?? base.effort ?? '').trim();
  return {
    id,
    label: String(r.label || base.label || id).trim().slice(0, 80),
    agent: ag,
    account: String(r.account ?? base.account ?? '').trim().slice(0, 160),
    model: m && MODEL_RE.test(m) ? m : '',
    effort: efforts.includes(ef) ? ef : '',
    readOnly: r.readOnly !== undefined ? !!r.readOnly : !!base.readOnly,
    writableGlobs: String(r.writableGlobs ?? base.writableGlobs ?? '').trim().slice(0, 500),
    template: String(r.template ?? base.template ?? '').trim().slice(0, 3000),
  };
}

function normalizeAdapterEntry(cli, raw, fallback) {
  const a = raw && typeof raw === 'object' ? raw : {};
  const base = fallback || DEFAULT_AGENT_ADAPTERS[cli] || { id: cli, label: cli, rules: '' };
  return {
    id: cli,
    label: String(a.label || base.label || cli).trim().slice(0, 80),
    rules: String(a.rules ?? base.rules ?? '').trim().slice(0, 2000),
  };
}

function createProjectHarnessStore(file = path.join(__dirname, 'data', 'project-harness.json')) {
  const readRaw = () => {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  };

  const normalize = (raw = {}) => {
    const def = cloneDefaults();
    const roles = {};
    for (const id of ROLE_IDS) {
      roles[id] = normalizeRoleEntry(id, raw.roles?.[id], def.roles[id]);
    }
    const adapters = {};
    for (const cli of ADAPTER_CLIS) {
      adapters[cli] = normalizeAdapterEntry(cli, raw.adapters?.[cli], def.adapters[cli]);
    }
    return { roles, adapters, updatedAt: Number(raw.updatedAt || 0) };
  };

  const write = (state) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  };

  const get = () => {
    if (!fs.existsSync(file)) {
      const init = normalize({ updatedAt: Date.now() });
      try { write(init); } catch {}
      return init;
    }
    return normalize(readRaw());
  };

  const save = (patch = {}) => {
    const cur = get();
    const next = normalize({
      roles: { ...cur.roles, ...(patch.roles || {}) },
      adapters: { ...cur.adapters, ...(patch.adapters || {}) },
      updatedAt: Date.now(),
    });
    write(next);
    return next;
  };

  const reset = () => {
    const init = normalize({ ...cloneDefaults(), updatedAt: Date.now() });
    write(init);
    return init;
  };

  return { get, save, reset };
}

function resolveTaskRole(task) {
  const explicit = String(task?.role || '').trim().toLowerCase();
  if (ROLE_IDS.includes(explicit)) return explicit;
  const k = String(task?.kind || '').trim().toLowerCase();
  if (ROLE_IDS.includes(k)) return k;
  const inferred = inferTaskKind(task?.title || '', task?.detail || '');
  return ROLE_IDS.includes(inferred) ? inferred : 'dev';
}

function resolveTaskConfig(project, task, harnessState, { preferProject = true } = {}) {
  const parent = task?.parentId ? (project?.tasks || []).find((x) => x.id === task.parentId) : null;
  const roleId = resolveTaskRole(task);
  const rolePreset = harnessState?.roles?.[roleId] || DEFAULT_ROLE_PRESETS[roleId] || DEFAULT_ROLE_PRESETS.dev;
  const projAgent = project?.agent || 'codex';
  const projectDefault = preferProject ? project?.agent : '';
  const agent = task?.agent || projectDefault || parent?.agent || rolePreset?.agent || projAgent;
  const agentSource = task?.agent ? 'task' : projectDefault ? 'project' : parent?.agent ? 'parent' : rolePreset?.agent ? 'role' : 'project';

  const sameAsParent = !!(parent && agentSource !== 'project' && agent === (parent.agent || projAgent));
  const sameAsRole = agentSource === 'role';
  const sameAsProject = agent === projAgent;

  const account = task?.account
    ?? (sameAsParent ? parent.account : null)
    ?? (sameAsRole && rolePreset.account ? rolePreset.account : null)
    ?? (sameAsProject ? project?.account : '')
    ?? '';
  const model = task?.model
    || (sameAsParent ? parent.model : '')
    || (sameAsRole ? rolePreset.model : '')
    || (sameAsProject ? project?.model : '')
    || '';
  const effort = task?.effort
    || (sameAsParent ? parent.effort : '')
    || (sameAsRole ? rolePreset.effort : '')
    || (sameAsProject ? project?.effort : '')
    || '';

  return { agent, agentSource, account: account || '', model, effort, roleId, rolePreset, parent };
}

function buildTaskHarnessPrompt(project, task, effectiveAgent, harnessState) {
  const roleId = resolveTaskRole(task);
  const role = harnessState?.roles?.[roleId] || DEFAULT_ROLE_PRESETS[roleId] || DEFAULT_ROLE_PRESETS.dev;
  const adapter = harnessState?.adapters?.[effectiveAgent] || DEFAULT_AGENT_ADAPTERS[effectiveAgent] || null;
  const parts = [];
  if (role?.template) {
    parts.push(`[Role 하네스 · ${role.label || roleId}]\n${role.template}`);
  }
  if (adapter?.rules) {
    parts.push(`[CLI 어댑터 · ${adapter.label || effectiveAgent}]\n${adapter.rules}`);
  }
  return parts.join('\n\n');
}

function globToRegex(glob) {
  const esc = String(glob || '').trim().replace(/\\/g, '/').replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${esc.replace(/\*\*/g, '::DBL::').replace(/\*/g, '[^/]*').replace(/::DBL::/g, '.*')}$`, 'i');
}

function checkRoleWriteScope(rolePreset, changedFiles = []) {
  if (!rolePreset || !Array.isArray(changedFiles) || !changedFiles.length) return { ok: true, violations: [] };
  const files = changedFiles.map((f) => String(f || '').trim().replace(/\\/g, '/')).filter(Boolean);
  if (!files.length) return { ok: true, violations: [] };
  if (rolePreset.readOnly) return { ok: false, reason: '읽기 전용 Role에서 파일이 수정되었습니다.', violations: files };
  const globs = String(rolePreset.writableGlobs || '').split(/[,\n]+/).map((s) => s.trim()).filter(Boolean);
  if (!globs.length) return { ok: true, violations: [] };
  const matchers = globs.map(globToRegex);
  const violations = files.filter((file) => !matchers.some((rx) => rx.test(file)));
  return violations.length
    ? { ok: false, reason: `허용된 쓰기 범위(${globs.join(', ')}) 외 파일이 수정되었습니다.`, violations }
    : { ok: true, violations: [] };
}

function computeHarnessStats(projectsList = []) {
  const byRole = {};
  for (const project of projectsList) {
    for (const task of project?.tasks || []) {
      if (task.stage !== 'done') continue;
      const roleId = resolveTaskRole(task);
      const agent = task.lastRun?.agent || task.agent || project.agent || 'codex';
      const model = task.model || project.model || 'default';
      const row = (byRole[roleId] ||= { roleId, done: 0, firstPass: 0, retries: 0, models: {} });
      row.done++;
      const retried = Number(task.retryCount || 0) > 0 || /수정 재시도/.test(task.reviewNote || '');
      if (!retried) row.firstPass++;
      row.retries += Number(task.retryCount || 0);
      const mk = `${agent}/${model}`;
      const mRow = (row.models[mk] ||= { agent, model, done: 0, firstPass: 0 });
      mRow.done++;
      if (!retried) mRow.firstPass++;
    }
  }
  return byRole;
}

module.exports = {
  ROLE_IDS,
  ADAPTER_CLIS,
  DEFAULT_ROLE_PRESETS,
  DEFAULT_AGENT_ADAPTERS,
  createProjectHarnessStore,
  resolveTaskRole,
  resolveTaskConfig,
  buildTaskHarnessPrompt,
  checkRoleWriteScope,
  computeHarnessStats,
};
