const stages = ['planned', 'doing', 'review', 'done'];
const agents = ['claude', 'codex', 'agy', 'cursor'];
const kinds = ['plan', 'dev', 'test', 'ops'];
const efforts = ['', 'minimal', 'low', 'medium', 'high', 'xhigh', 'ultra', 'max'];
const MODEL_RE = /^[\w.\-:/\[\]]{0,120}$/;

function inferTaskKind(title = '', detail = '') {
  const t = String(title || '').trim();
  const d = String(detail || '').trim();
  if (/테스트|검증|점검|QA|벤치마크|단위\s*테스트|통합\s*테스트|E2E|회귀|test|verif|validat|assert|audit|qa|benchmark/i.test(t)) return 'test';
  if (/배포|문서|가이드|매뉴얼|릴리스|패키징|CI\/CD|도커|운영|README|deploy|release|doc|readme|docker|publish|ops/i.test(t)) return 'ops';
  if (/설계|기획|정의|범위|요구\s*사항|아키텍처|스키마\s*정의|구조|분석|조사|초안|명세|plan|design|spec|architect|requir|scope|analy|research/i.test(t)) return 'plan';
  if (/개발|구현|작성|추가|연동|적용|생성|빌드|컴포넌트|API|UI|화면|기능|모듈|수정|개선|implement|build|create|add|develop|feature|integrate|code/i.test(t)) return 'dev';
  if (/테스트\s*실행|검증\s*절차|통과\s*여부\s*확인|unit\s*test|integration\s*test/i.test(d) && !/구현|개발|작성/i.test(t)) return 'test';
  return 'dev';
}

function validate(p) {
  const fail = (message) => { throw new Error(message); };
  const str = (s, max, required = false) => typeof s === 'string' && s.length <= max && (!required || s.trim());
  if (!p || !str(p.name, 120, true) || !str(p.cwd, 1000, true) || !str(p.goal, 6000)) fail('프로젝트 이름·폴더·목표를 확인하세요.');
  if (p.agent !== undefined && !agents.includes(p.agent)) fail('Project 기본 CLI를 확인하세요.');
  if (p.account !== undefined && !str(p.account, 160)) fail('Project 기본 계정을 확인하세요.');
  if (p.model !== undefined && (!str(p.model, 120) || !MODEL_RE.test(p.model.trim()))) fail('Project 기본 모델 이름이 올바르지 않습니다.');
  if (p.effort !== undefined && !efforts.includes(String(p.effort || ''))) fail('Project 추론 성능 설정이 올바르지 않습니다.');
  if (!Array.isArray(p.termIds) || p.termIds.length > 100 || p.termIds.some(id => !str(id, 80, true))) fail('터미널 목록이 올바르지 않습니다.');
  if (!Array.isArray(p.tasks) || p.tasks.length > 200) fail('작업은 최대 200개까지 등록할 수 있습니다.');
  const seen = new Set();
  for (const t of p.tasks) {
    if (!t || !str(t.id, 80, true) || seen.has(t.id) || !str(t.title, 240, true) || !str(t.detail, 6000) || !stages.includes(t.stage)) fail('작업 정보가 올바르지 않습니다.');
    if (t.kind !== undefined && t.kind !== '' && !kinds.includes(t.kind)) fail('작업 종류를 확인하세요.');
    if (!Array.isArray(t.after) || t.after.length > p.tasks.length) fail('선행 작업 목록이 올바르지 않습니다.');
    if (!str(t.termId, 80) || (t.termId && !p.termIds.includes(t.termId))) fail('작업 터미널을 프로젝트에 먼저 연결하세요.');
    if (t.agent !== undefined && t.agent !== '' && !agents.includes(t.agent)) fail('작업 CLI를 확인하세요.');
    if (t.account != null && !str(t.account, 160)) fail('작업 계정을 확인하세요.');
    if (t.model !== undefined && t.model !== null && (!str(t.model, 120) || !MODEL_RE.test(String(t.model).trim()))) fail('작업 모델 이름이 올바르지 않습니다.');
    if (t.effort !== undefined && t.effort !== null && !efforts.includes(String(t.effort || ''))) fail('작업 추론 성능 설정이 올바르지 않습니다.');
    if (t.parentId !== undefined && t.parentId !== null && !str(t.parentId, 80)) fail('상위 작업 ID가 올바르지 않습니다.');
    seen.add(t.id);
  }
  const byId = new Map(p.tasks.map(t => [t.id, t]));
  // Validate parentId hierarchy (no self-parent, must exist, no cycle)
  for (const t of p.tasks) {
    if (!t.parentId) continue;
    if (t.parentId === t.id || !byId.has(t.parentId)) fail('상위 작업을 찾을 수 없습니다.');
    const trail = new Set([t.id]);
    let cur = t.parentId;
    while (cur) {
      if (trail.has(cur)) fail('상위·서브 작업이 순환 연결될 수 없습니다.');
      trail.add(cur);
      cur = byId.get(cur)?.parentId || '';
    }
  }
  const checking = new Set(), checked = new Set();
  function visit(id) {
    if (checked.has(id)) return;
    if (!byId.has(id)) fail('선행 작업을 찾을 수 없습니다.');
    if (checking.has(id)) fail('선행 작업이 서로를 기다리는 순환 연결은 저장할 수 없습니다.');
    checking.add(id);
    byId.get(id).after.forEach(visit);
    checking.delete(id);
    checked.add(id);
  }
  seen.forEach(visit);
  return {
    name: p.name.trim(),
    cwd: p.cwd.trim(),
    goal: p.goal,
    agent: p.agent || 'codex',
    account: p.account || '',
    model: String(p.model || '').trim(),
    effort: String(p.effort || ''),
    termIds: [...new Set(p.termIds)],
    tasks: p.tasks.map(t => ({
      id: t.id,
      title: t.title.trim(),
      detail: t.detail,
      stage: t.stage,
      kind: kinds.includes(t.kind) ? t.kind : inferTaskKind(t.title, t.detail),
      agent: t.agent || '',
      account: t.account ?? null,
      model: String(t.model || '').trim(),
      effort: String(t.effort || ''),
      parentId: t.parentId ? String(t.parentId) : '',
      termId: t.termId,
      after: [...new Set(t.after)],
    })),
  };
}
module.exports = { validate, stages, agents, kinds, efforts, MODEL_RE, inferTaskKind };
