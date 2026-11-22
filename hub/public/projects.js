let projectId = '', projectTab = 'board';
const projectStages = [['planned', '대기'], ['doing', '진행'], ['review', '검토'], ['done', '완료']];
const projectTaskKinds = [['plan', '설계·기획'], ['dev', '개발·구현'], ['test', '테스트·검증'], ['ops', '배포·문서']];
const projectViews = [['design', '작업 설계'], ['board', '칸반 보드'], ['flow', '작업 흐름'], ['terms', '터미널 모아보기']];
const newTaskId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join('');

function taskKindOf(t) {
  if (t?.kind && projectTaskKinds.some(([k]) => k === t.kind)) return t.kind;
  const title = String(t?.title || '').trim();
  const detail = String(t?.detail || '').trim();
  if (/테스트|검증|점검|QA|벤치마크|단위\s*테스트|통합\s*테스트|E2E|회귀|test|verif|validat|assert|audit|qa|benchmark/i.test(title)) return 'test';
  if (/배포|문서|가이드|매뉴얼|릴리스|패키징|CI\/CD|도커|운영|README|deploy|release|doc|readme|docker|publish|ops/i.test(title)) return 'ops';
  if (/설계|기획|정의|범위|요구\s*사항|아키텍처|스키마\s*정의|구조|분석|조사|초안|명세|plan|design|spec|architect|requir|scope|analy|research/i.test(title)) return 'plan';
  if (/개발|구현|작성|추가|연동|적용|생성|빌드|컴포넌트|API|UI|화면|기능|모듈|수정|개선|implement|build|create|add|develop|feature|integrate|code/i.test(title)) return 'dev';
  if (/테스트\s*실행|검증\s*절차|통과\s*여부\s*확인|unit\s*test|integration\s*test/i.test(detail)) return 'test';
  return 'dev';
}

function kindBadgeHTML(t) {
  const k = taskKindOf(t);
  const label = projectTaskKinds.find(([id]) => id === k)?.[1] || '개발·구현';
  return `<span class="badge kind-${esc(k)}" title="작업 종류: ${esc(label)}">${esc(label)}</span>`;
}

async function saveProject(p, tab) {
  const gen = viewGen;
  const r = await api('/api/projects', { method: 'POST', body: p });
  if (r.error) throw new Error(r.error);
  if (typeof refreshProjects === 'function') await refreshProjects();
  if (gen === viewGen) openProject(r.project.id, tab || (p.id ? projectTab : 'design'));
}

function openProject(id = projectId, tab = projectTab) { select({ kind: 'projects', id }, tab); }

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
  const tk = p.tokens || { total: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, byAgent: {}, byTask: {}, rollupByTask: {}, sessions: 0 };
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
  openDrawer({ title: `${p.name} · 누적 토큰`, bodyHTML: body, footerHTML: '<button data-drw-close>닫기</button>', width: 500 });
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
        <div class="pj-drw-sub-meta">${stageBadgeHTML(st.stage)}<span>${esc([providerName(sCfg.agent), sCfg.model, sCfg.effort].filter(Boolean).join(' · '))}</span><span class="badge tok-badge${sRoll.total.total > 0 ? ' active' : ''}">토큰 ${tokFmt(sRoll.total.total)}</span></div>
      </div>
      <button type="button" class="btn-sm${sTerm ? ' primary' : ''}" data-drw-start-sub="${esc(st.id)}">${sTerm ? '열기 ↗' : '시작'}</button>
    </div>`;
  }).join('');
  const cliLine = [providerName(ag), term?.account?.label || (cfg.account || ''), cfg.model || '', cfg.effort ? `추론 ${cfg.effort}` : ''].filter(Boolean).join(' · ');
  const body = `
    ${parent ? `<div class="drw-sec"><div class="drw-lbl">상위 작업</div><button type="button" class="ghost btn-sm" data-drw-open-sub="${esc(parent.id)}">↳ ${esc(parent.title)}</button></div>` : ''}
    <div class="drw-sec">
      <div class="row" style="justify-content:space-between">
        <div class="row" style="gap:6px"><span class="drw-lbl" style="margin:0">작업 종류 · 진행 단계</span>${kindBadgeHTML(task)}</div>
      </div>
      <div class="seg" role="tablist" aria-label="작업 단계 선택">${stageSeg}</div>
    </div>
    <div class="drw-sec">
      <div class="drw-lbl">작업 지시 · 완료 기준</div>
      <div style="white-space:pre-wrap;line-height:1.6;font-size:13.5px;color:${task.detail ? 'var(--text)' : 'var(--muted)'}">${esc(task.detail || '아직 작성된 작업 지시가 없습니다. 아래 수정 버튼으로 추가할 수 있습니다.')}</div>
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
  mountTaskSubChat(d, p, task, cfg, focusSubChat);

  d.addEventListener('click', async (e) => {
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
      if (target) { d.close(); startProjectTask(p, target, startSub); }
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
        const saved = await api('/api/projects', { method: 'POST', body: { ...p, tasks: [...p.tasks, ...r.tasks] } });
        if (saved.error) throw new Error(saved.error);
        if (typeof refreshProjects === 'function') await refreshProjects();
        toast(`서브 개발 작업 ${r.tasks.length}개를 추가했습니다`);
        d.close();
        openProject(saved.project.id, projectTab);
        const freshTask = saved.project.tasks.find((x) => x.id === task.id);
        if (freshTask) openProjectTaskDrawer(saved.project, freshTask);
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
      startProjectTask(p, task, startBtn);
    }
  });
}

function mountTaskSubChat(d, p, task, cfg, focusSubChat) {
  const headEl = $('#subChatHead', d);
  const msgsEl = $('#subChatMsgs', d);
  const formEl = $('#subChatForm', d);
  const inEl = $('#subChatIn', d);
  const sendBtn = $('#subChatSend', d);
  const agPick = $('#scAgentPick', d);
  if (!headEl || !msgsEl || !formEl || !inEl) return;

  let chats = Array.isArray(p.subChats?.[task.id]) ? [...p.subChats[task.id]] : [];
  let activeChatId = chats[chats.length - 1]?.id || '';
  let activeTurn = null;
  let pollTimer = null;

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
      : `<div class="empty" style="margin:auto;text-align:center;padding:24px 12px"><b>이 태스크 전용 서브 개발 채팅창입니다.</b><br>코드 작성·수정·디버깅·부분 기능 실험을 아래 입력창에 바로 지시해 보세요.<br><small>작업 폴더(${esc(base(p.cwd) || p.cwd)})에서 YOLO 자동 승인 모드로 즉시 실행됩니다.</small></div>`;
    msgsEl.scrollTop = msgsEl.scrollHeight;
  };

  const syncFromServer = async () => {
    if (!d.isConnected) { clearInterval(pollTimer); return; }
    try {
      const r = await api(`/api/projects/task-chat?projectId=${encodeURIComponent(p.id)}&taskId=${encodeURIComponent(task.id)}`);
      if (Array.isArray(r.chats)) {
        chats = r.chats;
        if (p.subChats) p.subChats[task.id] = chats;
        if (!activeChatId && chats.length) activeChatId = chats[chats.length - 1].id;
      }
      activeTurn = r.active || null;
      paint();
    } catch {}
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
      const t = await api('/api/term/new', { method: 'POST', body: { kind: ag, resume: sid, cwd: p.cwd, skipPermissions: true } });
      termBtn.disabled = false;
      if (t.error) return toast(t.error, 5000, 'danger');
      d.close();
      await refreshOverview();
      select({ kind: 'term', id: t.id, project: p.id });
    }
  };

  const submitMsg = async () => {
    const prompt = inEl.value.trim();
    if (!prompt || sendBtn.disabled) return;
    const chosenAgent = agPick ? agPick.value : (cfg.agent || 'codex');
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
        const topTokBtn = $('#projectTokens');
        if (topTokBtn) topTokBtn.innerHTML = `토큰 <b>${tokFmt(r.tokens.total?.total || 0)}</b>`;
      }
      paint();
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
    const p = projectList.find(x => x.id === (state.sel.id || projectId)) || projectList[0];
    if (p) { projectId = p.id; state.sel.id = p.id; }
    if (typeof renderSide === 'function') renderSide();
    if (!p) {
      const ico = window.UI_ICO || {};
      $('#view').innerHTML = `<div class="pj">
        <div class="pj-top"><div class="pj-top-left"><h3>Project</h3></div><div class="pj-top-right"><button id="projectNew" class="primary">${ico.plus || ''} 새 Project</button></div></div>
        <div class="pj-empty"><h3>첫 Project를 시작하세요</h3><p>목표와 작업을 설계하고, 작업별 CLI를 정해 전용 터미널에서 실행하세요.</p><button id="firstProject" class="primary">작업 설계 시작</button></div>
      </div>`;
      $('#projectNew').onclick = $('#firstProject').onclick = () => projectForm();
      return;
    }
    const total = p.tasks.length;
    const cnt = { planned: 0, doing: 0, review: 0, done: 0 };
    for (const t of p.tasks) cnt[t.stage] = (cnt[t.stage] || 0) + 1;
    const pct = total ? Math.round((cnt.done / total) * 100) : 0;
    const segW = (n) => (total ? ((n / total) * 100).toFixed(1) : 0);
    const ico = window.UI_ICO || {};
    const totalTok = p.tokens?.total?.total || 0;
    $('#view').innerHTML = `<div class="pj">
      <header class="pj-top">
        <div class="pj-top-left">
          <select id="projectPick" class="pj-pick" aria-label="Project 선택">${projectList.map(x => `<option value="${esc(x.id)}" ${x.id === p.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
          <span class="pj-cwd" title="${esc(p.cwd)}">${ico.folder || ''}${esc(base(p.cwd) || p.cwd)}</span>
        </div>
        <div class="pj-top-right">
          <button id="projectTokens" class="pj-tok-pill" title="Project 누적 토큰 상세 (CLI 변경·서브 개발 포함 전체 합산)">토큰 <b>${tokFmt(totalTok)}</b></button>
          <div class="pj-prog" role="progressbar" aria-label="작업 진행률" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" title="완료 ${cnt.done} · 검토 ${cnt.review} · 진행 ${cnt.doing} · 대기 ${cnt.planned}">
            <div class="pj-stackbar">
              ${cnt.done ? `<i class="done" style="width:${segW(cnt.done)}%"></i>` : ''}
              ${cnt.review ? `<i class="review" style="width:${segW(cnt.review)}%"></i>` : ''}
              ${cnt.doing ? `<i class="doing" style="width:${segW(cnt.doing)}%"></i>` : ''}
            </div>
            <span class="pj-prog-lbl"><b>${pct}%</b> (${cnt.done}/${total})</span>
          </div>
          <button id="projectAdd" class="primary">${ico.plus || ''} 작업</button>
          <button id="projectMore" class="ghost icon-btn" aria-label="Project 메뉴" aria-haspopup="menu" aria-expanded="false" title="새 Project · 설계 수정 · 삭제">${ico.more || '⋯'}</button>
        </div>
      </header>
      <div class="pj-toolbar">
        <div class="tablist" role="tablist" aria-label="Project 보기">${projectViews.map(([id, label]) => `<button role="tab" data-pjtab="${id}" aria-selected="${projectTab === id}" class="${projectTab === id ? 'on' : ''}">${label}</button>`).join('')}</div>
      </div>
      <div id="projectContent"></div>
    </div>`;
    $('#projectPick').onchange = e => openProject(e.target.value);
    $('#projectTokens').onclick = () => openProjectTokensDrawer(p);
    document.querySelectorAll('[data-pjtab]').forEach(b => (b.onclick = () => openProject(p.id, b.dataset.pjtab)));
    $('#projectAdd').onclick = () => taskForm(p);
    $('#projectMore').onclick = (e) => {
      e.stopPropagation();
      openMoreMenu(e.currentTarget, [
        { label: '새 Project 만들기', icon: ico.plus || '', onClick: () => projectForm() },
        { label: '목표 · 설계 수정', icon: ico.edit || '', onClick: () => projectForm(p) },
        { label: '작업 흐름 생성', icon: ico.swap || '', onClick: () => projectForm(p) },
        { divider: true },
        { label: 'Project 삭제', icon: ico.trash || '', tone: 'danger', onClick: () => removeProject(p, $('#projectMore')) },
      ]);
    };
    if (projectTab === 'design') projectDesign(p);
    else if (projectTab === 'terms') projectTerminals(p, gen);
    else projectBoard(p);
  } catch (e) {
    if (gen !== viewGen) return;
    $('#view').innerHTML = `<div class="pj"><div class="pj-empty"><p role="alert">${esc(e.message)}</p><button id="projectRetry">다시 불러오기</button></div></div>`;
    $('#projectRetry').onclick = () => openProject();
  }
}

async function removeProject(p, button) {
  if (!confirm(`“${p.name}”의 전용 CLI 터미널을 종료하고 Project와 연결된 원본 대화를 영구 삭제할까요? 진행 중인 CLI 작업은 중단됩니다. 작업 파일은 유지됩니다.`)) return;
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
