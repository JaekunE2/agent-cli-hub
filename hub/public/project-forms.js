function projectDialog(title, html, save, leftFooter = '', primary = '저장') {
  const ico = window.UI_ICO || {};
  const d = document.createElement('dialog');
  d.className = 'pj-dialog';
  d.setAttribute('aria-label', title);
  d.innerHTML = `<form>
    <div class="dlg-head"><h3>${esc(title)}</h3><button type="button" class="ghost icon-btn btn-sm" data-cancel aria-label="닫기">${ico.close || '✕'}</button></div>
    ${html}
    <p role="alert" class="pj-error"></p>
    <div class="dlg-foot">${leftFooter}<span class="sp"></span><button type="button" data-cancel>취소</button><button class="primary">${esc(primary)}</button></div>
  </form>`;
  document.body.append(d);
  d.querySelectorAll('[data-cancel]').forEach((b) => (b.onclick = () => d.close()));
  d.onclose = () => d.remove();
  let saving = false;
  d.querySelector('form').onsubmit = async e => {
    e.preventDefault();
    if (saving) return;
    saving = true;
    const buttons = [...d.querySelectorAll('button')];
    buttons.forEach(b => b.disabled = true);
    d.oncancel = e => e.preventDefault();
    try { if (await save(new FormData(e.target), e.submitter) !== false) d.close(); }
    catch (err) { d.querySelector('[role=alert]').textContent = err.message; }
    finally { saving = false; buttons.forEach(b => b.disabled = false); d.oncancel = null; }
  };
  d.showModal();
  return d;
}

function projectSlugFolder(baseDir, name) {
  const base = String(baseDir || '').replace(/[\\/]+$/, '');
  if (!base) return '';
  const sep = base.includes('\\') ? '\\' : '/';
  const slug = String(name || '')
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.\-]+|[.\-]+$/g, '')
    .slice(0, 60);
  return slug ? `${base}${sep}${slug}` : base;
}

function projectForm(p) {
  const field = (label, name, max, value) => `<label>${label}<input name="${name}" maxlength="${max}" value="${esc(value || '')}" required></label>`;
  const defaultBase = !p ? (state.defaultProjectCwd || '') : '';
  const initCwd = p?.cwd || defaultBase;
  let generated, planKey;
  const genRow = p
    ? `<div class="row" style="justify-content:space-between"><small class="ums" style="margin:0">작업 흐름을 생성하면 기존 카드는 유지되고 새 카드가 추가됩니다.</small><button type="submit" value="generate" class="btn-sm">작업 흐름 생성</button></div>`
    : '';
  const cwdHint = !p && defaultBase
    ? '<small class="ums" style="margin:-6px 0 4px">기본값은 Agent CLI Hub 내부 projects 폴더이며, 프로젝트 이름에 맞춰 자동 생성됩니다.</small>'
    : '';
  const dialog = projectDialog(p ? '작업 설계 수정' : '새 Project 작업 설계',
    field('Project 이름', 'name', 120, p?.name) + field('작업 폴더', 'cwd', 1000, initCwd) + cwdHint +
    `<label>목표·완료 기준<textarea name="goal" maxlength="6000" rows="3" ${p ? '' : 'required'}>${esc(p?.goal || '')}</textarea></label>` +
    projectAgentField('Project 기본 CLI', p?.agent || 'codex') + projectAccountField + projectModelEffortFields +
    genRow +
    '<div data-plan-preview role="status"></div>',
    async (f, button) => {
      const draft = {
        name: f.get('name').trim(),
        cwd: f.get('cwd').trim(),
        goal: f.get('goal'),
        agent: f.get('agent'),
        account: f.get('account'),
        model: String(f.get('model') || '').trim(),
        effort: String(f.get('effort') || ''),
      };
      const key = JSON.stringify(draft);
      if (!p) {
        const tasks = key === planKey ? generated : await previewProjectPlan(dialog, draft, false);
        generated = tasks;
        planKey = key;
        return saveProject({ ...draft, tasks, termIds: [] }, 'design');
      }
      if (button?.value === 'generate' || (generated && key !== planKey)) {
        generated = await previewProjectPlan(dialog, draft, true);
        planKey = key;
        return false;
      }
      const tasks = [...p.tasks, ...(generated || [])];
      return saveProject({ ...p, ...draft, tasks }, generated ? 'flow' : undefined);
    }, '', p ? '저장' : 'Project 생성');
  if (!p && defaultBase) {
    const nameIn = dialog.querySelector('input[name="name"]');
    const cwdIn = dialog.querySelector('input[name="cwd"]');
    let cwdEdited = false;
    if (cwdIn) cwdIn.addEventListener('input', () => { cwdEdited = true; });
    if (nameIn && cwdIn) {
      nameIn.addEventListener('input', () => {
        if (!cwdEdited) cwdIn.value = projectSlugFolder(defaultBase, nameIn.value);
      });
    }
  }
  bindProjectAccounts(dialog, p?.account || '', null, p?.model || '', p?.effort || '');
}

// Scannable Task List: Top-level tasks + Nested Sub-Development tasks (click any row → Right Detail Drawer)
function projectDesign(p) {
  const ico = window.UI_ICO || {};
  const host = $('#projectContent');
  const byParent = new Map();
  const topTasks = [];
  const taskIds = new Set(p.tasks.map((t) => t.id));
  for (const t of p.tasks) {
    if (t.parentId && taskIds.has(t.parentId)) {
      (byParent.get(t.parentId) || byParent.set(t.parentId, []).get(t.parentId)).push(t);
    } else {
      topTasks.push(t);
    }
  }

  const rowHTML = (t, numMark, isSub = false) => {
    const subs = isSub ? [] : (byParent.get(t.id) || []);
    const subDone = subs.filter((s) => s.stage === 'done').length;
    const deps = t.after.map((id) => p.tasks.find((x) => x.id === id)?.title).filter(Boolean);
    const summary = [t.detail ? t.detail.replace(/\s+/g, ' ').trim() : '', deps.length ? `← ${deps.join(', ')}` : ''].filter(Boolean).join(' · ');
    const ownTok = p.tokens?.byTask?.[t.id]?.total?.total || 0;
    const subTok = subs.reduce((acc, s) => acc + (p.tokens?.byTask?.[s.id]?.total?.total || 0), 0);
    const taskTok = ownTok + subTok;
    const subBlock = subs.length
      ? `<div class="pj-sublist">${subs.map((st, si) => rowHTML(st, st.stage === 'done' ? '✓' : `${numMark}.${si + 1}`, true)).join('')}</div>`
      : '';
    return `<div class="pj-row${t.stage === 'done' ? ' is-done' : ''}${isSub ? ' is-sub' : ''}" data-task-row="${esc(t.id)}">
      <span class="pj-step-num ${esc(t.stage)}" title="${esc(projectStages.find((s) => s[0] === t.stage)?.[1] || t.stage)}">${numMark}</span>
      <div class="pj-row-main">
        <div class="pj-row-head">
          <button data-plan-task="${esc(t.id)}" class="pj-title">${esc(t.title)}</button>
          ${stageBadgeHTML(t.stage)}
          ${subs.length ? `<span class="badge" title="서브 개발 작업 진행률">서브 ${subDone}/${subs.length}</span>` : ''}
          ${taskTok ? `<span class="badge mono" title="이 작업의 누적 토큰 (서브 작업·이전 CLI 포함)">${tokFmt(taskTok)}</span>` : ''}
        </div>
        ${summary ? `<div class="pj-row-desc">${esc(summary)}</div>` : ''}
      </div>
      <div class="pj-row-acts">
        ${!isSub ? `<button class="ghost btn-sm" data-add-sub="${esc(t.id)}" title="이 작업 아래에 서브 개발 작업 추가">＋ 서브</button>` : ''}
        ${projectCliBadgeHTML(p, t)}
        ${projectStartBtnHTML(p, t)}
        <button class="ghost icon-btn btn-sm" data-task-more="${esc(t.id)}" aria-label="${esc(t.title)} 메뉴" aria-haspopup="menu" aria-expanded="false">${ico.more || '⋯'}</button>
      </div>
    </div>${subBlock}`;
  };

  const defCfg = [providerName(p.agent || 'codex'), p.model || '', p.effort ? `추론 ${p.effort}` : ''].filter(Boolean).join(' · ');
  host.innerHTML = `<div class="pj-design-wrap">
    <section class="pj-objective">
      <div class="pj-objective-body">
        <span class="pj-objective-lbl">목표 · 완료 기준 <span class="badge" style="margin-left:6px;text-transform:none;letter-spacing:0">${esc(defCfg)}</span></span>
        <p class="pj-goal">${esc(p.goal || '작업 설계에서 목표와 완료 기준을 입력하세요.')}</p>
      </div>
      <button id="projectEdit" class="ghost btn-sm">${ico.edit || ''} 수정</button>
    </section>
    <section class="pj-list">
      ${topTasks.length ? topTasks.map((t, idx) => rowHTML(t, t.stage === 'done' ? '✓' : String(idx + 1), false)).join('') : '<div class="empty" style="padding:28px 16px;text-align:center">상단 ＋ 작업 버튼으로 첫 작업을 추가하세요.</div>'}
    </section>
  </div>`;
  $('#projectEdit').onclick = () => projectForm(p);
  host.onclick = (e) => {
    const addSub = e.target.closest('[data-add-sub]');
    if (addSub) { e.stopPropagation(); return taskForm(p, null, false, addSub.dataset.addSub); }
    const more = e.target.closest('[data-task-more]');
    if (more) { e.stopPropagation(); return openProjectTaskMenu(p, p.tasks.find((x) => x.id === more.dataset.taskMore), more); }
    const assign = e.target.closest('[data-assign-task]');
    if (assign) { e.stopPropagation(); return taskForm(p, p.tasks.find((x) => x.id === assign.dataset.assignTask), true); }
    const start = e.target.closest('[data-start-task]');
    if (start) { e.stopPropagation(); return startProjectTask(p, p.tasks.find((x) => x.id === start.dataset.startTask), start); }
    const row = e.target.closest('[data-task-row], [data-plan-task]');
    if (row) {
      const id = row.dataset.planTask || row.dataset.taskRow;
      openProjectTaskDrawer(p, p.tasks.find((x) => x.id === id));
    }
  };
}
