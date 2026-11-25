let projectId = '', projectTab = 'board';
const projectStages = [['planned', '대기'], ['doing', '진행'], ['review', '검토'], ['merge', '병합'], ['done', '완료']];
const projectTaskKinds = [['plan', '설계·기획'], ['dev', '개발·구현'], ['test', '테스트·검증'], ['review', '교차 리뷰·감사'], ['ops', '배포·문서']];
const projectViews = [
  ['design', '작업 설계', '목표와 작업을 정의하고 편집합니다.'],
  ['board', '칸반 보드', '작업을 상태별로 보고 옮깁니다.'],
  ['flow', '작업 흐름', '선행 작업과 의존성을 확인합니다.'],
  ['floorplan', '코드 구조', '코드 구성과 주요 연결을 확인합니다.'],
  ['git', 'Git 현황', '브랜치 노선도와 변경분(Diff)을 읽기 전용으로 확인합니다.'],
  ['refs', '산출물', '사용자와 AI 태스크가 공용으로 읽고 쓰는 산출물·레퍼런스 저장소입니다.'],
  ['terms', '터미널 모아보기', '이 프로젝트에서 열린 터미널을 확인합니다.'],
  ['versions', '버전 이력', '작업 파일을 버전으로 저장하고 이전 버전에서 이어 작업합니다.'],
];
const newTaskId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join('');

function taskKindOf(t) {
  if (t?.kind && projectTaskKinds.some(([k]) => k === t.kind)) return t.kind;
  const title = String(t?.title || '').trim();
  const detail = String(t?.detail || '').trim();
  if (/리뷰|교차\s*검토|코드\s*감사|아키텍처\s*감사|cross[\s-]*review|code[\s-]*audit|review|audit/i.test(title)) return 'review';
  if (/테스트|검증|점검|QA|벤치마크|단위\s*테스트|통합\s*테스트|E2E|회귀|test|verif|validat|assert|qa|benchmark/i.test(title)) return 'test';
  if (/배포|문서|가이드|매뉴얼|릴리스|패키징|CI\/CD|도커|운영|README|deploy|release|doc|readme|docker|publish|ops/i.test(title)) return 'ops';
  if (/설계|기획|정의|범위|요구\s*사항|아키텍처|스키마\s*정의|구조|분석|조사|초안|명세|plan|design|spec|architect|requir|scope|analy|research/i.test(title)) return 'plan';
  if (/개발|구현|작성|추가|연동|적용|생성|빌드|컴포넌트|API|UI|화면|기능|모듈|수정|개선|implement|build|create|add|develop|feature|integrate|code/i.test(title)) return 'dev';
  if (/테스트\s*실행|검증\s*절차|통과\s*여부\s*확인|unit\s*test|integration\s*test/i.test(detail)) return 'test';
  return 'dev';
}

function kindBadgeHTML(t) {
  const k = taskKindOf(t);
  const label = projectTaskKinds.find(([id]) => id === k)?.[1] || '개발·구현';
  const kindTip = `작업 종류: ${label}`;
  return `<span class="badge kind-${esc(k)}" title="${esc(kindTip)}">${esc(label)}</span>`;
}

function projectDraft({ scope, ...draft }) {
  if (!scope) return draft;
  const edited = new Map(draft.tasks.map((task) => [task.id, { ...task, version: scope.number }]));
  const removed = new Set(scope.allTasks.filter((task) => (task.version || '') === scope.number && !edited.has(task.id)).map((task) => task.id));
  draft.tasks = scope.allTasks.filter((task) => !removed.has(task.id)).map((task) => {
    const next = edited.get(task.id) || task;
    edited.delete(task.id);
    if (!removed.size) return next;
    return { ...next, parentId: removed.has(next.parentId) ? '' : next.parentId, after: next.after.filter((id) => !removed.has(id)) };
  }).concat([...edited.values()]);
  return draft;
}

async function saveProject(p, tab, version) {
  const gen = viewGen;
  const r = await api('/api/projects', { method: 'POST', body: projectDraft(p) });
  if (r.error) throw new Error(r.error);
  if (Array.isArray(r.autoStarted) && r.autoStarted.length) {
    toast(`자동 진행: 후속 작업 ${r.autoStarted.length}개 터미널을 시작했습니다.`);
    if (typeof refreshOverview === 'function') refreshOverview();
  }
  if (typeof refreshProjects === 'function') await refreshProjects();
  if (gen === viewGen) openProject(r.project.id, tab || (p.id ? projectTab : 'design'), version);
}

function projectVersionPreference(id, version) {
  if (!id) return '';
  const key = `ach.project-version:${id}`;
  try {
    if (version !== undefined) localStorage.setItem(key, version);
    return localStorage.getItem(key) || '';
  } catch { return ''; }
}

function openProject(id = projectId, tab = projectTab, version) {
  version = version ?? (state.sel.kind === 'projects' && state.sel.id === id ? state.sel.version || '' : projectVersionPreference(id));
  return select({ kind: 'projects', id, ...(version ? { version } : {}) }, tab);
}

function scopedProject(p, number) {
  const version = p.versions?.find((entry) => entry.number === number);
  return { ...p, tasks: p.tasks.filter((task) => (task.version || '') === (version?.number || '')),
    scope: { number: version?.number || '', version, allTasks: p.tasks } };
}

function projectTokenTotals(p) {
  if (!p.scope || !p.versions?.length) return p.tokens || {};
  return p.tokens?.byVersion?.[p.scope.number] || {};
}

function stageBadgeHTML(stage) {
  const label = projectStages.find((x) => x[0] === stage)?.[1] || stage;
  return `<span class="badge st-${esc(stage)}">${esc(label)}</span>`;
}

function tokFmt(n) {
  return typeof fmtTok === 'function' ? fmtTok(n) : String(n || 0);
}

// Compute hierarchical rollup token data for any task (own tokens + all descendant subtasks' tokens rolled up to top!)
function taskTokenRollupOf(p, taskId) {
  const pre = p?.tokens?.rollupByTask?.[taskId];
  if (pre) return pre;
  const byTask = p?.tokens?.byTask || {};
  const tasks = p?.tasks || [];
  const desc = typeof taskDescendants === 'function' ? taskDescendants(tasks, taskId) : new Set([taskId]);
  const empty = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
  const add = (dst, src) => {
    if (!src) return dst;
    dst.input += Number(src.input) || 0;
    dst.output += Number(src.output) || 0;
    dst.cacheRead += Number(src.cacheRead) || 0;
    dst.cacheWrite += Number(src.cacheWrite) || 0;
    dst.total += Number(src.total) || 0;
    return dst;
  };
  const total = empty(), ownTotal = empty(), subTotal = empty();
  const byAgent = {};
  let sessions = 0, subSessions = 0;
  for (const id of desc) {
    const entry = byTask[id];
    if (!entry) continue;
    add(total, entry.total);
    if (id === taskId) add(ownTotal, entry.total);
    else { add(subTotal, entry.total); subSessions += entry.sessions || 0; }
    sessions += entry.sessions || 0;
    for (const [ag, v] of Object.entries(entry.byAgent || {})) add(byAgent[ag] ||= empty(), v);
  }
  return { total, ownTotal, subTotal, byAgent, sessions, subSessions, subtaskCount: Math.max(0, desc.size - 1) };
}
window.taskTokenRollupOf = taskTokenRollupOf;

function taskTokenBadgeHTML(p, task, compact = false) {
  const roll = taskTokenRollupOf(p, task.id);
  const tot = roll.total?.total || 0;
  if (compact && tot === 0) return '';
  const own = roll.ownTotal?.total || 0;
  const sub = roll.subTotal?.total || 0;
  const hasSubs = (roll.subtaskCount || 0) > 0;
  const tipParts = [
    `누적 토큰: ${tot.toLocaleString()} (입력 ${(roll.total?.input || 0).toLocaleString()} · 출력 ${(roll.total?.output || 0).toLocaleString()})`,
    hasSubs ? `최상위 태스크 합산 — 본 작업 ${own.toLocaleString()} + 하위 서브태스크(${roll.subtaskCount}개) ${sub.toLocaleString()}` : '',
    roll.sessions ? `집계 세션 ${roll.sessions}개` : '아직 실행된 CLI 토큰 기록 없음',
  ].filter(Boolean);
  const label = compact
    ? `${tokFmt(tot)} tok`
    : `토큰 ${tokFmt(tot)}${hasSubs && sub > 0 ? ` (서브 +${tokFmt(sub)})` : ''}`;
  return `<span class="badge tok-badge${tot > 0 ? ' active' : ''}" title="${esc(tipParts.join(' · '))}">${esc(label)}</span>`;
}
window.taskTokenBadgeHTML = taskTokenBadgeHTML;

function openProjectTokensDrawer(p) {
  const tk = projectTokenTotals(p);
  const t = tk.total || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  const agEntries = Object.entries(tk.byAgent || {}).filter(([, v]) => (v?.total || 0) > 0).sort((a, b) => (b[1].total || 0) - (a[1].total || 0));
  const allIds = new Set((p.tasks || []).map((x) => x.id));
  const topTasks = (p.tasks || []).filter((x) => !(x.parentId && allIds.has(x.parentId)));
  const agRows = agEntries.map(([ag, v]) => `<div class="drw-kv">
    <span class="row" style="gap:7px">${typeof agentIcon === 'function' ? agentIcon(ag) : ''}${esc(providerName(ag))}</span>
    <b>${tokFmt(v.total)} <span style="font-weight:400;color:var(--muted);font-size:11.5px">(입력 ${tokFmt(v.input)} · 출력 ${tokFmt(v.output)}${v.cacheRead ? ` · 캐시 ${tokFmt(v.cacheRead)}` : ''})</span></b>
  </div>`).join('') || '<div class="empty" style="padding:0">아직 집계된 CLI 토큰 기록이 없습니다.</div>';

  const taskRows = topTasks.map((task) => {
    const roll = taskTokenRollupOf(p, task.id);
    const subs = (p.tasks || []).filter((x) => x.parentId === task.id);
    const chips = Object.entries(roll.byAgent || {}).filter(([, v]) => (v?.total || 0) > 0)
      .map(([ag, v]) => `<span class="badge">${esc(providerName(ag))} ${tokFmt(v.total)}</span>`).join('');
    const subBreakdown = subs.length
      ? `<div style="margin-top:4px;padding-left:10px;border-left:2px solid var(--line);display:flex;flex-direction:column;gap:3px;font-size:12px;color:var(--muted)">
          <div>본 작업: <b class="mono">${tokFmt(roll.ownTotal.total)}</b> · 하위 서브 합산(${subs.length}개): <b class="mono">${tokFmt(roll.subTotal.total)}</b></div>
          ${subs.map((st) => {
            const stRoll = taskTokenRollupOf(p, st.id);
            return `<div class="row" style="justify-content:space-between"><span>↳ ${esc(st.title)}</span><span class="mono">${tokFmt(stRoll.total.total)}</span></div>`;
          }).join('')}
        </div>`
      : '';
    return `<div style="padding:9px 0;border-top:1px solid var(--line)">
      <div class="row" style="justify-content:space-between"><span class="row" style="gap:6px">${kindBadgeHTML(task)}<b>${esc(task.title)}</b>${subs.length ? `<span class="badge">서브 ${subs.length}</span>` : ''}</span><b class="mono">${tokFmt(roll.total.total)}</b></div>
      ${chips ? `<div class="pj-tok-sub">${chips}</div>` : ''}
      ${subBreakdown}
    </div>`;
  }).join('') || '<div class="empty" style="padding:0">등록된 작업이 없습니다.</div>';

  const body = `
    <div class="drw-sec">
      <div class="drw-lbl">누적 토큰 합계 (CLI 변경·서브 개발·하위 태스크 전체 합산)</div>
      <div class="drw-kv"><span>총 토큰</span><b class="mono" style="font-size:15px">${tokFmt(t.total)}</b></div>
      <div class="drw-kv"><span>입력 / 출력</span><b class="mono">${tokFmt(t.input)} / ${tokFmt(t.output)}</b></div>
      <div class="drw-kv"><span>캐시 읽기 / 쓰기</span><b class="mono">${tokFmt(t.cacheRead)} / ${tokFmt(t.cacheWrite)}</b></div>
      <div class="drw-kv"><span>집계 세션 수</span><b>${tk.sessions || 0}개</b></div>
    </div>
    <div class="drw-sec">
      <div class="drw-lbl">CLI별 누적 사용량</div>
      <div>${agRows}</div>
    </div>
    <div class="drw-sec">
      <div class="drw-lbl">최상위 태스크별 누적 사용량 (하위 서브태스크 롤업 합산)</div>
      <div>${taskRows}</div>
    </div>
    <div class="ums">하위 서브태스크 및 서브 개발 채팅에서 사용한 토큰은 모두 상위(최상위) 태스크로 자동 롤업되어 합산됩니다.</div>`;
  const scope = p.versions?.length && p.scope ? ` · ${p.scope.number ? `v${p.scope.number}` : '기본 작업'}` : '';
  openDrawer({ title: `${p.name}${scope} · 누적 토큰`, bodyHTML: body, footerHTML: '<button data-drw-close>닫기</button>', width: 500 });
}

function projectFileRunLinksHTML(p, taskId) {
  const runs = (p.fileRuns || []).filter((run) => run.taskId === taskId && run.startedAt).reverse();
  if (!runs.length) return '';
  return `<div class="drw-sec"><div class="drw-lbl">파일 스냅샷</div>${runs.map((run) => `<div class="row">
    <button type="button" class="btn-sm" data-drw-file-run="${esc(run.id)}" data-phase="start">시작 스냅샷</button>
    ${run.finishedAt ? `<button type="button" class="btn-sm" data-drw-file-run="${esc(run.id)}" data-phase="finish">완료 스냅샷</button>` : ''}
    <span class="ums">${new Date(run.startedAt).toLocaleString()}</span>
    ${run.error ? `<span class="ums">${esc(run.error)}</span>` : ''}
  </div>`).join('')}</div>`;
}

// Unified Right Detail Drawer for any Project Task (includes embedded Chat-Based Sub-Development Workspace!)
function openProjectTaskDrawer(p, task, focusSubChat = false) {
  if (!task) return;
  const ico = window.UI_ICO || {};
  const deps = task.after.map((id) => p.tasks.find((x) => x.id === id)).filter(Boolean);
  const parent = task.parentId ? p.tasks.find((x) => x.id === task.parentId) : null;
  const subs = p.tasks.filter((x) => x.parentId === task.id);
  const term = projectTaskTerm(p, task);
  const cfg = effectiveTaskConfig(p, task);
  const ag = term?.agent || cfg.agent;
  const taskRoll = taskTokenRollupOf(p, task.id);
  const taskTokChips = Object.entries(taskRoll.byAgent || {}).filter(([, v]) => (v?.total || 0) > 0)
    .map(([a, v]) => `<span class="badge">${esc(providerName(a))} ${tokFmt(v.total)}</span>`).join('');
  const stageSeg = projectStages.map(([st, lbl]) =>
    `<button type="button" data-drw-stage="${st}" class="${task.stage === st ? 'on' : ''}">${lbl}</button>`
  ).join('');
  const subRowsHTML = subs.map((st) => {
    const sTerm = projectTaskTerm(p, st);
    const sCfg = effectiveTaskConfig(p, st);
    const sRoll = taskTokenRollupOf(p, st.id);
    return `<div class="pj-drw-sub-item">
      <div class="pj-drw-sub-main" data-drw-open-sub="${esc(st.id)}">
        <div class="pj-drw-sub-title">${kindBadgeHTML(st)} ${esc(st.title)}</div>
        <div class="pj-drw-sub-meta">${stageBadgeHTML(st.stage)}<span>${esc([providerName(sCfg.agent), sCfg.model, sCfg.effort].filter(Boolean).join(' · '))}</span>${projectLastRunHTML(st)}<span class="badge tok-badge${sRoll.total.total > 0 ? ' active' : ''}">토큰 ${tokFmt(sRoll.total.total)}</span></div>
      </div>
      <button type="button" class="btn-sm${sTerm ? ' primary' : ''}" data-drw-start-sub="${esc(st.id)}">${sTerm ? '열기 ↗' : '시작'}</button>
    </div>`;
  }).join('');
  const cliLine = [providerName(ag), term?.account?.label || (cfg.account || ''), cfg.model || '', cfg.effort ? `추론 ${cfg.effort}` : ''].filter(Boolean).join(' · ');
  const body = `
    ${task.lastRun || task.launchBlock ? `<div class="drw-sec"><div class="row">${projectLastRunHTML(task)}</div></div>` : ''}
    <div data-drw-file-runs>${projectFileRunLinksHTML(p, task.id)}</div>
    ${parent ? `<div class="drw-sec"><div class="drw-lbl">상위 작업</div><button type="button" class="ghost btn-sm" data-drw-open-sub="${esc(parent.id)}">↳ ${esc(parent.title)}</button></div>` : ''}
    <div class="drw-sec">
      <div class="row" style="justify-content:space-between">
        <div class="row" style="gap:6px"><span class="drw-lbl" style="margin:0">작업 종류 · 진행 단계</span>${kindBadgeHTML(task)}
          <span aria-live="polite" data-handoff-task="${esc(task.id)}" data-handoff-revision="${esc(p.revision)}">${projectHandoffBadgeHTML(task)}</span>
        </div>
      </div>
      <div class="seg" role="tablist" aria-label="작업 단계 선택">${stageSeg}</div>
    </div>
    ${(task.reviewStatus || task.reviewPaused || task.reviewNote || task.retryCount || task.lastOutput || ['doing', 'review'].includes(task.stage) || task.worktreePath) ? `<div class="drw-sec">
      <div class="row" style="gap:6px;flex-wrap:wrap;justify-content:space-between">
        <div class="row" style="gap:6px;flex-wrap:wrap">
          <span class="drw-lbl" style="margin:0">진행 · 검토 상태 및 사유</span>
          ${typeof projectLiveStatusBadgeHTML === 'function' ? projectLiveStatusBadgeHTML(p, task) : ''}
          ${projectReviewBadgeHTML(task, false)}
        </div>
        ${projectStageActionHTML(task, p)}
      </div>
      ${typeof projectReviewNoteHTML === 'function' ? projectReviewNoteHTML(task, false) : ''}
      ${task.lastOutput ? `<details class="pj-last-out"><summary>에이전트 최종 출력 요약 보기</summary><pre>${esc(task.lastOutput)}</pre></details>` : ''}
    </div>` : ''}
    <div class="drw-sec">
      <div class="drw-lbl">작업 지시 · 완료 기준</div>
      ${task.detail ? `<div class="pj-task-instructions">${projectTaskTextHTML(task.detail)}</div>` : '<div class="ums">아직 작성된 작업 지시가 없습니다. 아래 수정 버튼으로 추가할 수 있습니다.</div>'}
    </div>
    <div class="drw-sec">
      <div class="drw-lbl">Vault 적용 기록</div>
      <div data-vault-runs class="ums">적용 기록을 불러오는 중…</div>
    </div>
    <div class="drw-sec">
      <div class="row" style="justify-content:space-between">
        <div class="drw-lbl" style="margin:0;display:inline-flex;align-items:center;gap:5px">${ico.chat || ''} 서브 개발 채팅 (이 태스크 안에서 바로 대화형 개발)</div>
        <select id="scAgentPick" class="btn-sm" aria-label="서브 개발 CLI 선택">
          ${['codex', 'claude', 'agy'].map((id) => `<option value="${id}" ${(cfg.agent === id || (cfg.agent === 'cursor' && id === 'codex')) ? 'selected' : ''}>${esc(providerName(id))}</option>`).join('')}
        </select>
      </div>
      <div class="pj-subchat" id="subChatHost">
        <div class="pj-subchat-hd" id="subChatHead"></div>
        <div class="pj-subchat-msgs" id="subChatMsgs"><div class="empty">서브 개발 대화를 불러오는 중…</div></div>
        <form class="pj-subchat-bar" id="subChatForm">
          <textarea id="subChatIn" rows="1" placeholder="이 태스크에서 서브 개발 지시·코드 수정·질문 입력 (Enter 전송 · Shift+Enter 줄바꿈)…"></textarea>
          <button type="submit" class="primary" id="subChatSend">전송 ↵</button>
        </form>
      </div>
    </div>
    <div class="drw-sec">
      <div class="drw-lbl">담당 CLI · 모델 · 추론 성능</div>
      <div class="row" style="justify-content:space-between">
        <span class="row" style="gap:8px">${typeof agentIcon === 'function' ? agentIcon(ag) : ''}<b>${esc(cliLine)}</b></span>
        <button type="button" class="btn-sm" data-drw-assign>CLI · 모델 변경</button>
      </div>
    </div>
    ${!parent ? `<div class="drw-sec">
      <div class="row" style="justify-content:space-between">
        <div class="drw-lbl" style="margin:0">하위 서브태스크 (${subs.length})</div>
        <div class="row" style="gap:6px">
          <button type="button" class="btn-sm" data-drw-ai-sub title="선택한 CLI로 이 작업을 2~6개 서브 개발 단계로 자동 분해">${ico.spark || ''} AI 서브 분해</button>
          <button type="button" class="btn-sm" data-drw-add-sub>${ico.plus || ''} 서브 추가</button>
        </div>
      </div>
      <div data-sub-progress></div>
      <div style="display:flex;flex-direction:column;gap:6px">${subRowsHTML || '<div class="empty" style="padding:4px 0">필요하면 큰 작업을 하위 서브태스크로 쪼개서 관리할 수도 있습니다.</div>'}</div>
    </div>` : ''}
    <div class="drw-sec">
      <div class="drw-lbl">태스크 누적 토큰 (본 작업 + 하위 서브태스크·서브 개발 최상위 합산)</div>
      <div class="drw-kv"><span>최상위 합산 총 토큰</span><b class="mono">${tokFmt(taskRoll.total.total)} 토큰 <span style="font-weight:400;color:var(--muted);font-size:11.5px">(입력 ${tokFmt(taskRoll.total.input)} · 출력 ${tokFmt(taskRoll.total.output)} · 세션 ${taskRoll.sessions || 0}개)</span></b></div>
      ${subs.length ? `<div class="drw-kv"><span>본 작업 / 하위 서브태스크(${subs.length}개)</span><b class="mono">${tokFmt(taskRoll.ownTotal.total)} / ${tokFmt(taskRoll.subTotal.total)}</b></div>` : ''}
      ${taskTokChips ? `<div class="pj-tok-sub">${taskTokChips}</div>` : ''}
    </div>
    ${deps.length ? `<div class="drw-sec">
      <div class="drw-lbl">선행 작업 (${deps.length})</div>
      <div class="row" style="gap:6px">${deps.map((dep) => `<span class="badge st-${esc(dep.stage)}">${esc(dep.title)}</span>`).join('')}</div>
    </div>` : ''}`;
  const foot = `
    <button type="button" class="danger ghost" data-drw-del>${ico.trash || ''} 삭제</button>
    <span class="sp"></span>
    <button type="button" data-drw-edit>${ico.edit || ''} 수정</button>
    <button type="button" class="primary" data-drw-start>${term ? '메인 터미널 열기 ↗' : '메인 터미널 시작'}</button>`;
  const d = openDrawer({ title: task.title, bodyHTML: body, footerHTML: foot, width: 600 });

  d.addEventListener('click', async (e) => {
    const snapshot = e.target.closest('[data-drw-file-run]');
    if (snapshot) {
      d.close();
      await openProject(p.id, 'versions', '');
      const row = document.querySelector(`[data-file-run="${snapshot.dataset.drwFileRun}"] [data-file-run-phase="${snapshot.dataset.phase}"]`);
      row?.scrollIntoView({ block: 'center' });
      row?.querySelector('[data-file-run-view]')?.focus({ preventScroll: true });
      return;
    }
    const action = e.target.closest('[data-start-task]');
    if (action) {
      if (task.stage === 'review' || task.stage === 'merge') return requestProjectReview(p, task, action, d);
      d.close();
      return startProjectTask(p, task, action, { retry: true });
    }
    const stBtn = e.target.closest('[data-drw-stage]');
    if (stBtn) {
      const nextStage = stBtn.dataset.drwStage;
      if (nextStage === task.stage) return;
      d.close();
      saveProject({ ...p, tasks: p.tasks.map((t) => (t.id === task.id ? { ...t, stage: nextStage } : t)) }).catch((er) => toast(er.message, 5000, 'danger'));
      return;
    }
    const openSub = e.target.closest('[data-drw-open-sub]');
    if (openSub) {
      const target = p.tasks.find((x) => x.id === openSub.dataset.drwOpenSub);
      if (target) { d.close(); openProjectTaskDrawer(p, target); }
      return;
    }
    const startSub = e.target.closest('[data-drw-start-sub]');
    if (startSub) {
      const target = p.tasks.find((x) => x.id === startSub.dataset.drwStartSub);
      if (target) { d.close(); runProjectCardAction(p, target, startSub); }
      return;
    }
    if (e.target.closest('[data-drw-add-sub]')) { d.close(); return taskForm(p, null, false, task.id); }
    const aiSubBtn = e.target.closest('[data-drw-ai-sub]');
    if (aiSubBtn) {
      const progHost = d.querySelector('[data-sub-progress]');
      aiSubBtn.disabled = true;
      try {
        const cliName = providerName(cfg.agent);
        const { r } = await runPlanWithProgress(
          progHost,
          cliName,
          () => api('/api/projects/subtasks', {
            method: 'POST',
            body: { projectId: p.id, taskId: task.id, agent: cfg.agent, account: cfg.account, model: cfg.model, effort: cfg.effort },
          }),
          '서브 개발 단계 분해 중…',
        );
        if (!Array.isArray(r.tasks) || !r.tasks.length) throw new Error(r.error || '서브 작업을 생성하지 못했습니다.');
        const saved = await api('/api/projects', { method: 'POST', body: projectDraft({ ...p, tasks: [...p.tasks, ...r.tasks] }) });
        if (saved.error) throw new Error(saved.error);
        if (typeof refreshProjects === 'function') await refreshProjects();
        toast(`서브 개발 작업 ${r.tasks.length}개를 추가했습니다`);
        d.close();
        openProject(saved.project.id, projectTab);
        const freshTask = saved.project.tasks.find((x) => x.id === task.id);
        if (freshTask) openProjectTaskDrawer(scopedProject(saved.project, freshTask.version), freshTask);
      } catch (er) {
        if (progHost) progHost.textContent = '';
        toast(er.message, 6000, 'danger');
      } finally {
        if (aiSubBtn.isConnected) aiSubBtn.disabled = false;
      }
      return;
    }
    if (e.target.closest('[data-drw-assign]')) { d.close(); return taskForm(p, task, true); }
    if (e.target.closest('[data-drw-edit]')) { d.close(); return taskForm(p, task); }
    if (e.target.closest('[data-drw-del]')) {
      const subCnt = typeof taskDescendants === 'function' ? taskDescendants(p.tasks, task.id).size - 1 : 0;
      const msg = subCnt > 0
        ? `이 작업과 하위 서브 작업 ${subCnt}개를 함께 삭제할까요?`
        : '이 작업을 삭제하고 다른 카드에 연결된 선행 작업에서도 제거할까요?';
      if (!confirm(msg)) return;
      d.close();
      const tasks = typeof removeTaskCascade === 'function'
        ? removeTaskCascade(p, task.id)
        : p.tasks.filter((t) => t.id !== task.id).map((t) => ({ ...t, after: t.after.filter((id) => id !== task.id) }));
      saveProject({ ...p, tasks }).catch((er) => toast(er.message, 5000, 'danger'));
      return;
    }
    const startBtn = e.target.closest('[data-drw-start]');
    if (startBtn) {
      d.close();
      startProjectTask(p, task, startBtn, { openTerminal: true });
    }
  });
  mountTaskSubChat(d, p, task, cfg, focusSubChat);
}

function paintTaskVaultRuns(host, runs) {
  const areas = { terminal: '터미널', plan: '작업 설계', subchat: '서브 채팅', review: '자동 검토' };
  const reasons = {
    missing: '자원 파일 없음', empty: '내용 없음', disabled: '자원 비활성화',
    'unsupported-target': 'CLI 적용 대상에서 제외', 'unsupported-cli': '지원되지 않는 CLI 실행 환경',
    'autoload-disabled': 'Vault 자동 적용 꺼짐', 'sync-failed': 'CLI 설정 동기화 실패',
    'mcp-missing': 'MCP가 Vault에 등록되지 않음', 'mcp-invalid': 'MCP 실행 명령 또는 URL 누락',
    'mcp-unsupported': 'CLI 또는 스킬의 적용 대상에서 제외됨',
    'mcp-disabled': 'MCP 자동 활성화가 허용되지 않음', 'mcp-activation-failed': 'MCP 구성 활성화 실패',
    'mcp-unreachable': 'MCP 초기 연결에 실패함', 'mcp-config-changed': '확인 중 MCP 설정이 변경됨',
  };
  host.innerHTML = runs.slice().sort((a, b) => b.at - a.at).map((run) => `
    <details>
      <summary>${esc(areas[run.area] || run.area)} · ${esc(providerName(run.agent))} · ${esc(new Date(run.at).toLocaleString())}</summary>
      <div>${run.applied.length ? `<span>적용 자원</span> · ${run.applied.map(esc).join(', ')}` : '적용된 자원 없음'}</div>
      ${run.omitted.length ? `<ul>${run.omitted.map(({ id, reason }) => `<li>${esc(id)} · ${esc(reasons[reason] || reason)}</li>`).join('')}</ul>` : ''}
      ${run.error ? `<div>${esc(reasons[run.error] || run.error)}</div>` : ''}
    </details>`).join('') || '기록된 실행이 없습니다.';
}

function mountTaskSubChat(d, p, task, cfg, focusSubChat) {
  const ico = window.UI_ICO || {};
  const headEl = $('#subChatHead', d);
  const msgsEl = $('#subChatMsgs', d);
  const formEl = $('#subChatForm', d);
  const inEl = $('#subChatIn', d);
  const sendBtn = $('#subChatSend', d);
  const agPick = $('#scAgentPick', d);
  const vaultHost = d.querySelector('[data-vault-runs]');
  if (!headEl || !msgsEl || !formEl || !inEl) return;

  let chats = Array.isArray(p.subChats?.[task.id]) ? [...p.subChats[task.id]] : [];
  let activeChatId = chats[chats.length - 1]?.id || '';
  let activeTurn = null;
  let pollTimer = null;
  let vaultRunCount = -1;

  const curChat = () => chats.find((c) => c.id === activeChatId) || null;
  const renderMsgHTML = (txt) => (typeof md === 'function' ? md(String(txt || '')) : esc(String(txt || '')));

  const paint = () => {
    if (!d.isConnected) return;
    const cur = curChat();
    if (cur && agPick && !activeTurn) agPick.value = cur.agent || cfg.agent || 'codex';
    const tabsHTML = chats.map((c, idx) =>
      `<button type="button" class="pj-subchat-tab${c.id === activeChatId ? ' on' : ''}" data-sc-tab="${esc(c.id)}" title="${esc(c.title)}">#${idx + 1} ${esc(c.title)}</button>`
    ).join('');
    headEl.innerHTML = `<div class="pj-subchat-tabs">
        ${tabsHTML}
        <button type="button" class="ghost btn-sm" data-sc-new="1" title="이 태스크 안에 새 서브 개발 채팅 시작">${ico.plus || ''} 새 채팅</button>
      </div>
      <div class="row" style="gap:4px">
        ${cur?.sessionId ? `<button type="button" class="ghost btn-sm" data-sc-open-term="${esc(cur.sessionId)}" data-sc-open-ag="${esc(cur.agent)}" title="이 대화를 대화형 터미널에서 이어서 열기">${ico.external || ''} 터미널로</button>` : ''}
        ${cur ? `<button type="button" class="ghost icon-btn btn-sm" data-sc-del="${esc(cur.id)}" title="이 서브 채팅 삭제" aria-label="서브 채팅 삭제">${ico.close || '✕'}</button>` : ''}
      </div>`;

    const msgs = cur?.messages || [];
    const rows = msgs.map((m) => {
      if (m.role === 'user') {
        return `<div class="pj-sc-msg user">${esc(m.text)}</div>`;
      }
      const agName = providerName(cur?.agent || agPick?.value || cfg.agent);
      return `<div class="pj-sc-msg assistant">
        <div class="pj-sc-meta">${typeof agentIcon === 'function' ? agentIcon(cur?.agent || cfg.agent) : ''}<b>${esc(agName)}</b></div>
        <div>${renderMsgHTML(m.text)}</div>
      </div>`;
    });

    if (activeTurn) {
      const sec = Math.max(0, Math.floor((activeTurn.elapsedMs || 0) / 1000));
      const logs = (activeTurn.logs || []).map((l) => `<div>${esc(l)}</div>`).join('');
      rows.push(`<div class="pj-sc-msg assistant">
        <div class="pj-sc-meta"><span class="dot busy"></span><b>${esc(providerName(activeTurn.agent || cfg.agent))}</b> · ${esc(activeTurn.stage || '작업 중…')} (${sec}초)</div>
        ${logs ? `<div class="pj-plan-log" style="margin-top:4px">${logs}</div>` : ''}
      </div>`);
    }

    msgsEl.innerHTML = rows.length
      ? rows.join('')
      : `<div class="empty" style="margin:auto;text-align:center;padding:24px 12px"><b>이 태스크 전용 서브 개발 채팅창입니다.</b><br>코드 작성·수정·디버깅·부분 기능 실험을 아래 입력창에 바로 지시해 보세요.</div>`;
    msgsEl.scrollTop = msgsEl.scrollHeight;
  };

  const syncFromServer = async () => {
    if (!d.isConnected) { clearInterval(pollTimer); return; }
    try {
      const r = await api(`/api/projects/task-chat?projectId=${encodeURIComponent(p.id)}&taskId=${encodeURIComponent(task.id)}`);
      if (Array.isArray(r.vaultRuns) && vaultRunCount !== r.vaultRuns.length) {
        vaultRunCount = r.vaultRuns.length;
        paintTaskVaultRuns(vaultHost, r.vaultRuns);
      }
      if (Array.isArray(r.chats)) {
        chats = r.chats;
        if (p.subChats) p.subChats[task.id] = chats;
        if (!activeChatId && chats.length) activeChatId = chats[chats.length - 1].id;
      }
      activeTurn = r.active || null;
      paint();
    } catch {
      if (vaultRunCount < 0) vaultHost.textContent = 'Vault 적용 기록을 불러오지 못했습니다.';
    }
  };

  headEl.onclick = async (e) => {
    const tabBtn = e.target.closest('[data-sc-tab]');
    if (tabBtn) { activeChatId = tabBtn.dataset.scTab; paint(); return; }
    if (e.target.closest('[data-sc-new]')) {
      activeChatId = '';
      paint();
      inEl.focus();
      return;
    }
    const delBtn = e.target.closest('[data-sc-del]');
    if (delBtn) {
      const cid = delBtn.dataset.scDel;
      const r = await api('/api/projects/task-chat', { method: 'DELETE', body: { projectId: p.id, taskId: task.id, chatId: cid } });
      if (Array.isArray(r.chats)) {
        chats = r.chats;
        if (p.subChats) p.subChats[task.id] = chats;
        activeChatId = chats[chats.length - 1]?.id || '';
        paint();
      }
      return;
    }
    const termBtn = e.target.closest('[data-sc-open-term]');
    if (termBtn) {
      const sid = termBtn.dataset.scOpenTerm;
      const ag = termBtn.dataset.scOpenAg || cfg.agent || 'codex';
      termBtn.disabled = true;
      const t = await api('/api/term/new', { method: 'POST', body: { kind: ag, resume: sid, cwd: p.scope?.version?.workspace || p.cwd, skipPermissions: true } });
      termBtn.disabled = false;
      if (t.error) return toast(t.error, 5000, 'danger');
      d.close();
      await refreshOverview();
      select({ kind: 'term', id: t.id, project: p.id, projectVersion: task.version || '', projectTab });
    }
  };

  const submitMsg = async () => {
    const prompt = inEl.value.trim();
    if (!prompt || sendBtn.disabled) return;
    const chosenAgent = agPick ? agPick.value : (cfg.agent || 'codex');
    const tokenValue = $('#projectTokens b');
    inEl.value = '';
    inEl.style.height = '';
    sendBtn.disabled = true;
    inEl.disabled = true;

    // Optimistic user bubble + active indicator
    let cur = curChat();
    if (!cur) {
      cur = { id: 'pending', title: prompt.slice(0, 40), agent: chosenAgent, messages: [{ role: 'user', text: prompt }] };
      chats.push(cur);
      activeChatId = 'pending';
    } else {
      cur.messages = [...(cur.messages || []), { role: 'user', text: prompt }];
    }
    activeTurn = { agent: chosenAgent, stage: 'CLI 실행 준비 중…', elapsedMs: 0, logs: [] };
    paint();

    clearInterval(pollTimer);
    pollTimer = setInterval(syncFromServer, 900);

    try {
      const r = await api('/api/projects/task-chat', {
        method: 'POST',
        body: {
          projectId: p.id,
          taskId: task.id,
          chatId: activeChatId === 'pending' ? '' : activeChatId,
          prompt,
          agent: chosenAgent,
          account: chosenAgent === cfg.agent ? cfg.account : '',
          model: chosenAgent === cfg.agent ? cfg.model : '',
          effort: chosenAgent === cfg.agent ? cfg.effort : '',
        },
      });
      activeTurn = null;
      if (Array.isArray(r.chats)) {
        chats = r.chats;
        if (p.subChats) p.subChats[task.id] = chats;
      }
      if (r.chat?.id) activeChatId = r.chat.id;
      if (r.tokens) {
        p.tokens = r.tokens;
        if (tokenValue?.isConnected) tokenValue.textContent = tokFmt(projectTokenTotals(p).total?.total || 0);
      }
      paint();
      await syncFromServer();
      if (typeof refreshProjects === 'function') refreshProjects();
    } catch (er) {
      activeTurn = null;
      await syncFromServer();
      toast(er.message, 5000, 'danger');
    } finally {
      clearInterval(pollTimer);
      if (d.isConnected) {
        sendBtn.disabled = false;
        inEl.disabled = false;
        inEl.focus();
      }
    }
  };

  formEl.onsubmit = (e) => { e.preventDefault(); submitMsg(); };
  inEl.addEventListener('input', () => {
    inEl.style.height = 'auto';
    inEl.style.height = `${Math.min(110, inEl.scrollHeight)}px`;
  });
  inEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submitMsg();
    }
  });

  paint();
  syncFromServer();
  if (focusSubChat) setTimeout(() => inEl.focus(), 60);
}

async function viewProjects() {
  const gen = viewGen;
  projectTab = projectViews.some(([id]) => id === state.tab) ? state.tab : projectTab;
  setBar('');
  $('#view').innerHTML = '<div class="pj"><div class="empty">프로젝트를 불러오는 중…</div></div>';
  try {
    const r = await api('/api/projects');
    if (gen !== viewGen) return;
    if (r.error) throw new Error(r.error);
    const projectList = r.projects;
    state.projects = projectList;
    if (r.defaultCwd) state.defaultProjectCwd = r.defaultCwd;
    if (r.harness) state.projectHarness = r.harness;
    const fullProject = projectList.find(x => x.id === (state.sel.id || projectId)) || projectList[0];
    if (fullProject) { projectId = fullProject.id; state.sel.id = fullProject.id; }
    if (typeof renderSide === 'function') renderSide();
    if (!fullProject) {
      const ico = window.UI_ICO || {};
      $('#view').innerHTML = `<div class="pj">
        <div class="pj-top"><div class="pj-top-left"><h3>Project</h3></div><div class="pj-top-right"><button id="projectNew" class="primary">${ico.plus || ''} 새 Project</button></div></div>
        <div class="pj-empty"><h3>첫 Project를 시작하세요</h3><p>목표와 작업을 설계하고, 작업별 CLI를 정해 전용 터미널에서 실행하세요.</p><button id="firstProject" class="primary">작업 설계 시작</button></div>
      </div>`;
      $('#projectNew').onclick = $('#firstProject').onclick = () => projectForm();
      return;
    }
    const p = scopedProject(fullProject, state.sel.version);
    const current = p.scope.version;
    const unopened = current?.snapshotId && !current.workspace;
    if (state.sel.version && !current) {
      projectVersionPreference(p.id, '');
      return openProject(p.id, projectTab, '');
    }
    if (current) projectVersionPreference(p.id, current.number);
    const displayCwd = current?.workspace || (!current ? p.cwd : '');
    const total = p.tasks.length;
    const cnt = { planned: 0, doing: 0, review: 0, done: 0 };
    for (const t of p.tasks) cnt[t.stage] = (cnt[t.stage] || 0) + 1;
    const pct = total ? Math.round((cnt.done / total) * 100) : 0;
    const segW = (n) => (total ? ((n / total) * 100).toFixed(1) : 0);
    const ico = window.UI_ICO || {};
    const totalTok = projectTokenTotals(p).total?.total || 0;
    $('#view').innerHTML = `<div class="pj">
      <h1 class="sr-only">${esc(p.name)}</h1>
      <header class="pj-top">
        <div class="pj-top-left">
          <select id="projectPick" class="pj-pick" aria-label="Project 선택">${projectList.map(x => `<option value="${esc(x.id)}" ${x.id === p.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
          ${p.versions?.length ? `<select id="projectVersionPick" class="pj-version-pick" aria-label="작업 버전">
            ${[...p.versions].reverse().map((v) => `<option value="${esc(v.number)}"${v === current ? ' selected' : ''}>v${esc(v.number)}</option>`).join('')}
            <option value=""${!current ? ' selected' : ''}>기본 작업</option>
          </select>` : ''}
          ${displayCwd ? `<span class="pj-cwd" title="${esc(displayCwd)}">${ico.folder || ''}${esc(current ? '버전 작업 폴더' : base(displayCwd) || displayCwd)}</span>` : ''}
        </div>
        <div class="pj-top-right">
          <button id="projectTokens" class="pj-tok-pill" title="누적 토큰 상세">${current ? '버전 토큰' : '토큰'} <b>${tokFmt(totalTok)}</b></button>
          ${(() => {
            const progLabel = '작업 진행률';
            const progTip = `완료 ${cnt.done} · 검토 ${cnt.review} · 진행 ${cnt.doing} · 대기 ${cnt.planned}`;
            return `<div class="pj-prog" role="progressbar" aria-label="${progLabel}" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" title="${esc(progTip)}">`;
          })()}
            <div class="pj-stackbar">
              ${cnt.done ? `<i class="done" style="width:${segW(cnt.done)}%"></i>` : ''}
              ${cnt.review ? `<i class="review" style="width:${segW(cnt.review)}%"></i>` : ''}
              ${cnt.doing ? `<i class="doing" style="width:${segW(cnt.doing)}%"></i>` : ''}
            </div>
            <span class="pj-prog-lbl"><b>${pct}%</b> (${cnt.done}/${total})</span>
          </div>
          ${!current ? `<button id="projectAutopilot" class="btn-sm${p.autopilot ? ' primary' : ''}" title="켜면 선행 작업 완료 시 다음 대기 작업의 터미널이 자동으로 시작됩니다">${p.autopilot ? '자동 진행 ON' : '자동 진행 OFF'}</button>` : ''}
          <button id="projectHarness" class="btn-sm" title="Role 프리셋 · 에이전트별 하네스 설정">Role 하네스</button>
          ${projectTab === 'versions' ? '' : unopened
            ? '<button id="projectOpenWorkspace" class="primary">이 버전에서 이어 작업</button>'
            : `<button id="projectFollowup" class="btn-sm">개선·버전업</button>
              <button id="projectAdd" class="primary">${ico.plus || ''} 작업</button>`}
          <button id="projectMore" class="ghost icon-btn" aria-label="Project 메뉴" aria-haspopup="menu" aria-expanded="false" title="새 Project · 설계 수정 · 삭제">${ico.more || '⋯'}</button>
        </div>
      </header>
      <div class="pj-toolbar">
        <div class="tablist" role="tablist" aria-label="Project 보기">${projectViews.map(([id, label, description]) => `<button type="button" role="tab" id="project-tab-${id}" data-pjtab="${id}" title="${description}" aria-controls="projectContent" aria-selected="${projectTab === id}" tabindex="${projectTab === id ? 0 : -1}" class="${projectTab === id ? 'on' : ''}">${label}</button>`).join('')}</div>
      </div>
      ${(() => {
        const busyN = p.tasks.filter((t) => {
          const tm = typeof projectTaskTerm === 'function' ? projectTaskTerm(p, t) : null;
          return tm && typeof termStateOf === 'function' && termStateOf(tm) === 'busy';
        }).length;
        const revN = p.tasks.filter((t) => t.reviewStatus === 'reviewing' || t.stage === 'review').length;
        const mergeN = p.tasks.filter((t) => t.stage === 'merge').length;
        const reviewNote = p.tasks.find((t) => (t.stage === 'merge' || t.stage === 'review') && t.reviewNote)?.reviewNote;
        const retryN = p.tasks.reduce((a, t) => a + (Number(t.retryCount) || 0), 0);
        const readyN = current ? 0 : p.tasks.filter((t) => t.stage === 'planned' && !t.autoExclude && (t.after || []).every((id) => fullProject.tasks.find((x) => x.id === id)?.stage === 'done')).length;
        const active = !!(p.autopilot || busyN || revN || mergeN);
        if (!active && !readyN) return '';
        return `<div class="pj-convoy${p.autopilot ? ' on' : ''}">
          <div class="row" style="gap:8px;flex-wrap:wrap">
            <span class="pj-convoy-pill">${p.autopilot ? '<span class="dot busy" style="width:6px;height:6px"></span> 오케스트레이션 가동 중' : '수동 모드'}</span>
            <span class="ums" style="margin:0">실행 중 <b>${busyN}</b> · 검토 <b>${revN}</b> · 병합 <b>${mergeN}</b> · 수정 재시도 <b>${retryN}</b> · 대기 준비 <b>${readyN}</b> · 완료 <b>${cnt.done}/${total}</b></span>
            ${reviewNote ? `<span class="ums" style="margin:0;overflow-wrap:anywhere">${esc(reviewNote)}</span>` : ''}
          </div>
          ${readyN > 0 ? `<button type="button" class="btn-sm primary" id="projectKickoff">${p.autopilot ? `준비된 작업 ${readyN}개 즉시 실행` : `전체 자동 실행 시작 (${readyN}개)`}</button>` : ''}
        </div>`;
      })()}
      <p class="pj-view-description">${projectViews.find(([id]) => id === projectTab)[2]}</p>
      <div id="projectContent" role="tabpanel" aria-labelledby="project-tab-${projectTab}" tabindex="0"></div>
    </div>`;
    $('#projectPick').onchange = e => openProject(e.target.value);
    $('#projectVersionPick')?.addEventListener('change', async (e) => {
      const nextView = viewGen + 1;
      projectVersionPreference(p.id, e.target.value);
      await openProject(p.id, projectTab === 'versions' ? 'design' : projectTab, e.target.value);
      if (viewGen === nextView && document.activeElement === document.body) $('#projectVersionPick')?.focus();
    });
    $('#projectTokens').onclick = () => openProjectTokensDrawer(p);
    const tablist = $('.pj-toolbar [role=tablist]');
    const tabs = [...tablist.querySelectorAll('[data-pjtab]')];
    const setTabStop = target => {
      tabs.forEach(tab => { tab.tabIndex = tab === target ? 0 : -1; });
    };
    tablist.onkeydown = e => {
      const index = tabs.indexOf(e.target);
      if (index < 0 || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const next = {
        ArrowRight: (index + 1) % tabs.length,
        ArrowLeft: (index + tabs.length - 1) % tabs.length,
        Home: 0,
        End: tabs.length - 1,
      }[e.key];
      if (!Number.isInteger(next)) return;
      e.preventDefault();
      setTabStop(tabs[next]);
      tabs[next].focus();
    };
    tablist.onfocusout = e => {
      if (!tablist.contains(e.relatedTarget)) setTabStop(tabs.find(tab => tab.dataset.pjtab === projectTab));
    };
    tabs.forEach(tab => {
      tab.onclick = async () => {
        const nextView = viewGen + 1;
        await openProject(p.id, tab.dataset.pjtab);
        if (viewGen === nextView && document.activeElement === document.body) {
          document.getElementById(tab.id)?.focus();
        }
      };
    });
    $('#projectAutopilot')?.addEventListener('click', () => saveProject({ ...p, autopilot: !p.autopilot }).catch((er) => toast(er.message, 5000, 'danger')));
    $('#projectKickoff')?.addEventListener('click', () => saveProject({ ...p, autopilot: true }).catch((er) => toast(er.message, 5000, 'danger')));
    $('#projectHarness').onclick = () => openProjectHarnessDrawer();
    $('#projectFollowup')?.addEventListener('click', () => projectFollowupForm(fullProject, false, current?.number));
    $('#projectOpenWorkspace')?.addEventListener('click', (e) => restoreProjectVersion(p, current, e.currentTarget, projectTab));
    $('#projectAdd')?.addEventListener('click', () => taskForm(p));
    $('#projectMore').onclick = (e) => {
      e.stopPropagation();
      openMoreMenu(e.currentTarget, [
        { label: '새 Project 만들기', icon: ico.plus || '', onClick: () => projectForm() },
        { label: '목표 · 설계 수정', icon: ico.edit || '', onClick: () => editProjectScope(p) },
        { label: '작업 흐름 생성', icon: ico.swap || '', onClick: () => current ? projectFollowupForm(fullProject, false, current.number) : projectForm(p) },
        { divider: true },
        { label: 'Project 삭제', icon: ico.trash || '', tone: 'danger', onClick: () => removeProject(p, $('#projectMore')) },
      ]);
    };
    if (projectTab === 'design') projectDesign(p);
    else if (projectTab === 'versions') projectVersions(fullProject);
    else if (projectTab === 'floorplan' && typeof projectFloorplan === 'function') projectFloorplan(p, gen);
    else if (projectTab === 'git' && typeof projectGitView === 'function') projectGitView(p, gen);
    else if (projectTab === 'refs' && typeof projectRefsView === 'function') projectRefsView(p, gen);
    else if (projectTab === 'terms') projectTerminals(p, gen);
    else projectBoard(p);
  } catch (e) {
    if (gen !== viewGen) return;
    $('#view').innerHTML = `<div class="pj"><div class="pj-empty"><p role="alert">${esc(e.message)}</p><button id="projectRetry">다시 불러오기</button></div></div>`;
    $('#projectRetry').onclick = () => openProject();
  }
}

async function removeProject(p, button) {
  const delMsg = document.documentElement.lang === 'en'
    ? `Terminate dedicated CLI terminals for “${p.name}” and permanently delete linked CLI conversations? Running CLI jobs will stop; workspace files will be kept.`
    : `“${p.name}”의 전용 CLI 터미널을 종료하고 Project와 연결된 원본 대화를 영구 삭제할까요? 진행 중인 CLI 작업은 중단됩니다. 작업 파일은 유지됩니다.`;
  if (!confirm(delMsg)) return;
  if (button) button.disabled = true;
  try {
    const r = await api('/api/projects', { method: 'DELETE', body: { id: p.id, revision: p.revision, stopRunning: true } });
    if (r.error || !Number.isInteger(r.removed)) throw new Error(r.error || 'Project를 삭제할 수 없습니다.');
    await Promise.all([refreshRecent(), refreshOverview(), typeof refreshProjects === 'function' ? refreshProjects() : Promise.resolve()]);
    if (state.sel.kind === 'projects' && projectId === p.id) openProject('', 'design');
    toast(`Project를 삭제했습니다. 원본 CLI 대화 ${r.removed}개를 삭제했습니다.`);
  } catch (e) { toast(e.message, 5000, 'danger'); }
  finally { if (button) button.disabled = false; }
}
