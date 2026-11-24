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

function isLocalHostSession() {
  const h = location.hostname;
  return (h === '127.0.0.1' || h === 'localhost' || h === '[::1]') && !/Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
}

// Host PC Folder Browser Modal (works on Remote, Mobile, and Local PC; also triggers native Windows Folder Dialog on Local PC)
function openFolderPickerDialog(initialPath, onPick) {
  if (desktopBridge) {
    return desktopBridge.pickFolder(initialPath).then((path) => {
      if (path) return onPick(path);
    }).catch((error) => {
      console.error('Native folder picker failed', error);
      toast(String(error), 4000, 'danger');
    });
  }
  const ico = window.UI_ICO || {};
  const isLocal = isLocalHostSession();
  const d = document.createElement('dialog');
  d.className = 'pj-dialog';
  d.style.width = 'min(620px, 94vw)';
  d.setAttribute('aria-label', '작업 폴더 선택');
  d.innerHTML = `<div style="display:flex;flex-direction:column;gap:11px">
    <div class="dlg-head">
      <div>
        <h3 style="margin:0">작업 폴더 선택</h3>
        <small class="ums" id="fpHostSub" style="margin:0">호스트 컴퓨터의 경로를 탐색합니다</small>
      </div>
      <div class="row" style="gap:6px">
        ${isLocal ? `<button type="button" class="btn-sm" id="fpWinBtn" title="이 PC의 Windows 파일 탐색기 폴더 선택 창 열기">${ico.monitor || ''} Windows 탐색기</button>` : ''}
        <button type="button" class="ghost icon-btn btn-sm" data-fp-close aria-label="닫기">${ico.close || '✕'}</button>
      </div>
    </div>
    <div>
      <div class="drw-lbl" style="margin-bottom:4px">빠른 선택 (기존 프로젝트 · 최근 작업 폴더)</div>
      <div class="fp-quick-list" id="fpQuick"><span class="ums">불러오는 중…</span></div>
    </div>
    <div class="row" style="gap:6px;flex-wrap:wrap" id="fpNavBar">
      <div class="row" style="gap:4px" id="fpDrives"></div>
      <button type="button" class="btn-sm" id="fpUpBtn">${ico.arrowUp || ''} 상위 폴더</button>
      <button type="button" class="btn-sm" id="fpMkdirBtn">${ico.plus || ''} 새 폴더</button>
    </div>
    <div class="fp-input-row">
      <input id="fpPathIn" class="mono" style="font-size:12.5px" placeholder="호스트 컴퓨터 절대 경로 입력 (Enter로 이동)">
      <button type="button" class="btn-sm" id="fpGoBtn">이동</button>
    </div>
    <div class="fp-dir-list" id="fpDirList"><div class="empty" style="padding:18px;text-align:center">폴더 목록을 불러오는 중…</div></div>
    <div class="fp-status" id="fpInfoBar">현재 폴더 정보를 확인하는 중…</div>
    <div class="dlg-foot">
      <button type="button" data-fp-close>취소</button>
      <button type="button" class="primary" id="fpSelectBtn">이 폴더 선택</button>
    </div>
  </div>`;
  document.body.append(d);
  d.onclose = () => d.remove();
  d.querySelectorAll('[data-fp-close]').forEach((b) => (b.onclick = () => d.close()));

  let curPath = initialPath || '';
  const pathIn = $('#fpPathIn', d);
  const dirList = $('#fpDirList', d);
  const quickEl = $('#fpQuick', d);
  const drivesEl = $('#fpDrives', d);
  const upBtn = $('#fpUpBtn', d);
  const infoBar = $('#fpInfoBar', d);
  const hostSub = $('#fpHostSub', d);

  const loadDir = async (targetPath = '') => {
    try {
      const r = await api('/api/fs/dirs' + (targetPath ? `?path=${encodeURIComponent(targetPath)}` : ''));
      if (r.error) return toast(r.error, 4000, 'danger');
      curPath = r.current || targetPath;
      pathIn.value = curPath;
      if (r.host && hostSub) hostSub.textContent = `호스트 컴퓨터 (${r.host}) 경로 탐색기`;
      upBtn.disabled = !r.parent;
      upBtn.dataset.parent = r.parent || '';

      drivesEl.innerHTML = (r.drives || []).map((drv) =>
        `<button type="button" class="btn-sm${curPath.toUpperCase().startsWith(drv.toUpperCase()) ? ' primary' : ''}" data-fp-go="${esc(drv)}">${esc(drv)}</button>`
      ).join('');

      quickEl.innerHTML = (r.quick || []).map((q) =>
        `<button type="button" class="fp-quick-chip${q.path.toLowerCase() === curPath.toLowerCase() ? ' on' : ''}" data-fp-go="${esc(q.path)}" title="${esc(q.path)}">${ico.folder || '📁'} ${esc(q.label)}</button>`
      ).join('') || '<span class="ums">최근 폴더 없음</span>';

      const subRows = (r.dirs || []).map((sub) => {
        const badges = (sub.markers || []).map((m) => `<span class="badge">${esc(m)}</span>`).join('');
        return `<div class="fp-dir-row" data-fp-go="${esc(sub.path)}">
          <div class="fp-dir-name">${ico.folder || '📁'} <span>${esc(sub.name)}</span> ${badges}</div>
          <button type="button" class="btn-sm" data-fp-pick="${esc(sub.path)}">선택</button>
        </div>`;
      }).join('');
      const filesHint = (r.files || []).length
        ? `<div style="padding:7px 10px;font-size:11.5px;color:var(--muted);border-top:1px dashed var(--line);background:var(--panel)">📄 현재 폴더 파일 (${r.files.length}개): ${esc(r.files.slice(0, 12).join(', '))}${r.files.length > 12 ? ' …' : ''}</div>`
        : '';
      dirList.innerHTML = (subRows || '<div class="empty" style="padding:18px;text-align:center">하위 폴더가 없습니다.</div>') + filesHint;

      const inf = r.info || {};
      if (inf.isExistingProject) {
        const mTxt = (inf.markers || []).length ? ` · ${inf.markers.join(' · ')}` : '';
        infoBar.className = 'fp-status existing';
        infoBar.innerHTML = `<b>✓ 기존 프로젝트 폴더</b> <span>(항목 ${inf.fileCount}개${esc(mTxt)}) — 기존 파일·구조를 바탕으로 추가 개발/작업을 진행합니다.</span>`;
      } else {
        infoBar.className = 'fp-status';
        infoBar.innerHTML = `<span>새 폴더 또는 빈 폴더입니다 — 처음부터 새 프로젝트를 시작합니다.</span>`;
      }
    } catch (e) {
      toast(e.message, 4000, 'danger');
    }
  };

  d.addEventListener('click', async (e) => {
    const pickBtn = e.target.closest('[data-fp-pick]');
    if (pickBtn) {
      e.stopPropagation();
      const chosen = pickBtn.dataset.fpPick;
      d.close();
      onPick(chosen);
      return;
    }
    const goEl = e.target.closest('[data-fp-go]');
    if (goEl) {
      loadDir(goEl.dataset.fpGo);
    }
  });
  upBtn.onclick = () => { if (upBtn.dataset.parent) loadDir(upBtn.dataset.parent); };
  $('#fpGoBtn', d).onclick = () => { if (pathIn.value.trim()) loadDir(pathIn.value.trim()); };
  pathIn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); if (pathIn.value.trim()) loadDir(pathIn.value.trim()); }
  });
  $('#fpMkdirBtn', d).onclick = async () => {
    const name = prompt('현재 폴더 안에 만들 새 폴더 이름을 입력하세요:');
    if (!name || !name.trim()) return;
    const r = await api('/api/fs/mkdir', { method: 'POST', body: { parent: curPath, name: name.trim() } });
    if (r.error) return toast(r.error, 4000, 'danger');
    loadDir(r.path);
  };
  $('#fpSelectBtn', d).onclick = () => {
    const chosen = pathIn.value.trim() || curPath;
    if (!chosen) return;
    d.close();
    onPick(chosen);
  };
  const winBtn = $('#fpWinBtn', d);
  if (winBtn) {
    winBtn.onclick = async () => {
      if (winBtn.disabled) return;
      winBtn.disabled = true;
      const prevHTML = winBtn.innerHTML;
      winBtn.textContent = '탐색기 열림…';
      try {
        const r = await api('/api/fs/pick-dir', { method: 'POST', body: { path: pathIn.value.trim() || curPath } });
        if (r.ok && r.path) {
          d.close();
          onPick(r.path);
        } else if (r?.error) {
          toast(r.error, 4000, 'danger');
        }
      } catch (e) {
        toast(e.message, 4000, 'danger');
      } finally {
        if (winBtn.isConnected) { winBtn.disabled = false; winBtn.innerHTML = prevHTML; }
      }
    };
  }

  d.showModal();
  loadDir(initialPath);
}
window.openFolderPickerDialog = openFolderPickerDialog;

function projectForm(p) {
  const field = (label, name, max, value) => `<label>${label}<input name="${name}" maxlength="${max}" value="${esc(value || '')}" required></label>`;
  const defaultBase = !p ? (state.defaultProjectCwd || '') : '';
  const initCwd = p?.cwd || defaultBase;
  const knownCwds = [...new Set([
    ...(state.projects || []).map((x) => x.cwd),
    ...(state.live || []).map((x) => x.cwd),
    ...(state.recent || []).map((x) => x.cwd),
  ].filter(Boolean))].slice(0, 20);
  let generated, planKey;
  const genRow = p
    ? `<div class="row" style="justify-content:space-between"><small class="ums" style="margin:0">작업 흐름을 생성하면 기존 카드는 유지되고 새 카드가 추가됩니다.</small><button type="submit" value="generate" class="btn-sm">작업 흐름 생성</button></div>`
    : '';
  const isLocal = isLocalHostSession();
  const folderFieldHTML = `<div class="pj-folder-field">
    <span class="fp-mode-bar">
      <label for="projectCwd">작업 폴더</label>
      <span class="seg" role="tablist" aria-label="폴더 방식" style="padding:1px">
        <button type="button" data-cwd-mode="existing" class="${p ? 'on' : ''}" style="min-height:22px;height:22px;font-size:11.5px;padding:0 8px">기존 프로젝트 폴더</button>
        <button type="button" data-cwd-mode="internal" class="${!p ? 'on' : ''}" style="min-height:22px;height:22px;font-size:11.5px;padding:0 8px">새 내부 폴더 (projects/)</button>
      </span>
    </span>
    <div class="fp-input-row">
      <input id="projectCwd" name="cwd" list="pjCwdList" maxlength="1000" value="${esc(initCwd)}" placeholder="작업할 프로젝트 폴더 경로" required>
      <datalist id="pjCwdList">${knownCwds.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
      <button type="button" class="btn-sm" id="btnPickProjDir" title="호스트 컴퓨터 경로 탐색기에서 폴더 선택">${(window.UI_ICO || {}).folder || ''} 폴더 선택</button>
      ${isLocal ? `<button type="button" class="btn-sm" id="btnWinProjDir" title="Windows 파일 탐색기 창으로 폴더 선택">${(window.UI_ICO || {}).monitor || ''} 탐색기</button>` : ''}
    </div>
  </div>
  <div class="fp-status" data-cwd-status style="margin-top:-4px">폴더 상태를 확인하는 중…</div>`;

  const dialog = projectDialog(p ? '작업 설계 수정' : '새 Project 작업 설계',
    field('Project 이름', 'name', 120, p?.name) + folderFieldHTML +
    `<label>목표·완료 기준<textarea name="goal" maxlength="6000" rows="3" placeholder="새 프로젝트 목표 또는 기존 프로젝트에 추가·수정할 기능과 완료 기준을 적어주세요" ${p ? '' : 'required'}>${esc(p?.goal || '')}</textarea></label>` +
    projectAgentField('Project 기본 CLI', p?.agent || 'codex') + projectAccountField + projectModelEffortFields +
    `<label>필수 MCP 대체 CLI<select name="mcpFallbackAgent">
      <option value="">대체 CLI 없음</option>
      ${['claude', 'codex', 'agy'].map((id) => `<option value="${id}" ${p?.mcpFallbackAgent === id ? 'selected' : ''}>${esc(providerName(id))}</option>`).join('')}
    </select></label>` +
    genRow +
    '<div data-plan-preview role="status"></div>',
    async (f, button) => {
      const draft = {
        name: f.get('name').trim(),
        cwd: f.get('cwd').trim(),
        goal: f.get('goal'),
        agent: f.get('agent'),
        mcpFallbackAgent: f.get('mcpFallbackAgent') || '',
        account: f.get('account'),
        model: String(f.get('model') || '').trim(),
        effort: String(f.get('effort') || ''),
      };
      const key = JSON.stringify(draft);
      if (!p) {
        const tasks = key === planKey ? generated : await previewProjectPlan(dialog, draft, false);
        generated = tasks;
        planKey = key;
        return saveProject({ ...draft, tasks, termIds: [] }, 'flow');
      }
      if (button?.value === 'generate' || (generated && key !== planKey)) {
        generated = await previewProjectPlan(dialog, draft, true);
        planKey = key;
        return false;
      }
      const tasks = [...p.tasks, ...(generated || [])];
      return saveProject({ ...p, ...draft, tasks }, generated ? 'flow' : undefined);
    }, '', p ? '저장' : 'Project 생성');

  const nameIn = dialog.querySelector('input[name="name"]');
  const cwdIn = dialog.querySelector('input[name="cwd"]');
  const statusEl = dialog.querySelector('[data-cwd-status]');
  const modeBtns = [...dialog.querySelectorAll('[data-cwd-mode]')];
  let folderMode = p ? 'existing' : 'internal';
  let cwdEdited = !!p;
  let inspectTimer = null;

  const setFolderMode = (mode) => {
    folderMode = mode;
    modeBtns.forEach((b) => b.classList.toggle('on', b.dataset.cwdMode === mode));
    if (mode === 'internal' && defaultBase) {
      cwdEdited = false;
      cwdIn.value = projectSlugFolder(defaultBase, nameIn?.value || '');
      scheduleInspect();
    } else if (mode === 'existing') {
      cwdEdited = true;
    }
  };

  const scheduleInspect = () => {
    clearTimeout(inspectTimer);
    inspectTimer = setTimeout(async () => {
      if (!dialog.isConnected || !statusEl) return;
      const val = cwdIn.value.trim();
      if (!val) {
        statusEl.className = 'fp-status';
        statusEl.textContent = '작업할 폴더 경로를 입력하거나 📂 폴더 선택을 눌러 지정하세요.';
        return;
      }
      try {
        const r = await api(`/api/fs/dirs?path=${encodeURIComponent(val)}`);
        if (!dialog.isConnected) return;
        const inf = r.targetInfo || r.info || {};
        if (inf.isExistingProject) {
          const mTxt = (inf.markers || []).length ? ` · ${inf.markers.join(' · ')}` : '';
          statusEl.className = 'fp-status existing';
          statusEl.innerHTML = `<b>✓ 기존 프로젝트 폴더 감지됨</b> <span>(항목 ${inf.fileCount}개${esc(mTxt)}) — 기존 코드·구조를 분석해 기능 추가/수정 작업을 설계합니다.</span>`;
        } else if (inf.isInternal) {
          statusEl.className = 'fp-status';
          statusEl.innerHTML = `<span>✦ Agent CLI Hub 내부 projects 폴더 — 저장 시 자동 생성됩니다.</span>`;
        } else if (inf.exists) {
          statusEl.className = 'fp-status';
          statusEl.innerHTML = `<span>빈 폴더입니다 — 이 폴더에서 새 프로젝트를 시작합니다.</span>`;
        } else {
          statusEl.className = 'fp-status';
          statusEl.innerHTML = `<span>아직 존재하지 않는 경로입니다. 📂 폴더 선택으로 기존 폴더를 고르거나 내부 projects 경로를 사용하세요.</span>`;
        }
      } catch {}
    }, 220);
  };

  modeBtns.forEach((b) => {
    b.onclick = () => {
      setFolderMode(b.dataset.cwdMode);
      if (b.dataset.cwdMode === 'existing') {
        openFolderPickerDialog(cwdIn.value.trim(), (chosen) => {
          cwdEdited = true;
          setFolderMode('existing');
          cwdIn.value = chosen;
          if (nameIn && !nameIn.value.trim()) nameIn.value = base(chosen) || '';
          scheduleInspect();
        });
      }
    };
  });

  if (cwdIn) {
    cwdIn.addEventListener('input', () => {
      cwdEdited = true;
      const isInternal = defaultBase && cwdIn.value.toLowerCase().startsWith(defaultBase.toLowerCase());
      modeBtns.forEach((b) => b.classList.toggle('on', b.dataset.cwdMode === (isInternal ? 'internal' : 'existing')));
      scheduleInspect();
    });
  }
  if (nameIn && cwdIn && !p && defaultBase) {
    nameIn.addEventListener('input', () => {
      if (!cwdEdited && folderMode === 'internal') {
        cwdIn.value = projectSlugFolder(defaultBase, nameIn.value);
        scheduleInspect();
      }
    });
  }
  const pickBtn = $('#btnPickProjDir', dialog);
  if (pickBtn) {
    pickBtn.onclick = () => {
      openFolderPickerDialog(cwdIn.value.trim(), (chosen) => {
        cwdEdited = true;
        setFolderMode('existing');
        cwdIn.value = chosen;
        if (nameIn && !nameIn.value.trim()) nameIn.value = base(chosen) || '';
        scheduleInspect();
      });
    };
  }
  const winBtn = $('#btnWinProjDir', dialog);
  if (winBtn) {
    winBtn.onclick = async () => {
      if (winBtn.disabled) return;
      winBtn.disabled = true;
      const prevHTML = winBtn.innerHTML;
      winBtn.textContent = '열림…';
      try {
        const initialPath = cwdIn.value.trim();
        const r = desktopBridge
          ? { ok: true, path: await desktopBridge.pickFolder(initialPath) }
          : await api('/api/fs/pick-dir', { method: 'POST', body: { path: initialPath } });
        if (r.ok && r.path) {
          cwdEdited = true;
          setFolderMode('existing');
          cwdIn.value = r.path;
          if (nameIn && !nameIn.value.trim()) nameIn.value = base(r.path) || '';
          scheduleInspect();
        } else if (r?.error) {
          toast(r.error, 4000, 'danger');
        }
      } catch (e) {
        if (desktopBridge) console.error('Native folder picker failed', e);
        toast(e.message || String(e), 4000, 'danger');
      } finally {
        if (winBtn.isConnected) { winBtn.disabled = false; winBtn.innerHTML = prevHTML; }
      }
    };
  }

  scheduleInspect();
  bindProjectAccounts(dialog, p?.account || '', null, p?.model || '', p?.effort || '');
}

function projectFollowupForm(p, versionMode = false, existingVersion = '') {
  const agent = p.agent === 'cursor' ? 'codex' : p.agent || 'codex';
  let generated, planKey;
  const dialog = projectDialog('후속 작업 설계', `
    <p class="ums">${esc(p.name)} · ${esc(p.versions?.find((item) => item.number === existingVersion)?.workspace || p.cwd)}</p>
    ${existingVersion ? `<p><strong>v${esc(existingVersion)}</strong></p>` : `<label>작업 구분<select name="mode"><option value="followup">일반 후속 작업</option><option value="version"${versionMode ? ' selected' : ''}>버전업</option></select></label>
    <label data-version-field${versionMode ? '' : ' hidden'}>버전 번호<input name="version" maxlength="29" placeholder="1.2.0"${versionMode ? ' required' : ' disabled'}></label>`}
    <label>개선·버전업 목표<textarea name="goal" required maxlength="6000" rows="4" placeholder="추가할 기능과 완료 기준을 적어주세요"></textarea></label>
    ${projectAgentField('설계에 사용할 CLI', agent)}${projectAccountField}${projectModelEffortFields}
    <p class="ums">기존 목표와 작업 기록을 보존합니다. 자동 진행이 켜져 있으면 추가 후 실행 가능한 작업이 시작됩니다.</p>
    <div data-plan-preview role="status"></div>`, async (f) => {
    const number = existingVersion || (f.get('mode') === 'version' ? String(f.get('version') || '').trim().replace(/^v/i, '') : '');
    if (f.get('mode') === 'version' && !/^(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})$/.test(number)) {
      throw new Error('버전 번호를 1.2.0 형식으로 입력하세요.');
    }
    if (number && !existingVersion && p.versions?.some((version) => version.number === number)) throw new Error('이미 등록된 버전 번호입니다.');
    const selectedAgent = f.get('agent');
    const draft = { projectId: p.id, name: p.name, cwd: p.cwd, goal: f.get('goal').trim(), agent: selectedAgent,
      account: f.get('account') === 'inherit' ? p.account || '' : f.get('account'),
      model: String(f.get('model') || ''), effort: String(f.get('effort') || ''), ...(existingVersion ? { projectVersion: existingVersion } : {}) };
    const key = JSON.stringify([draft, number]);
    if (!generated || planKey !== key) {
      generated = await previewProjectPlan(dialog, draft, true);
      planKey = key;
      const btn = $('.dlg-foot .primary', dialog);
      btn.textContent = number ? '버전 작업 등록' : '후속 작업 추가';
      const pv = dialog.querySelector('[data-plan-preview]');
      if (pv) pv.insertAdjacentHTML('afterbegin', '<p class="ums" style="margin:0 0 8px;color:var(--accent);font-weight:600">초안 생성 완료 — 아래 버튼을 한 번 더 눌러 저장하세요.</p>');
      btn.focus();
      return false;
    }
    const r = await api('/api/projects');
    if (r.error) throw new Error(r.error);
    const latest = r.projects?.find((x) => x.id === p.id);
    if (!latest || latest.cwd !== draft.cwd) throw new Error('프로젝트 또는 작업 폴더가 변경되었습니다. 후속 작업 설계를 다시 열어주세요.');
    if (number && !existingVersion && latest.versions?.some((version) => version.number === number)) throw new Error('이미 등록된 버전 번호입니다.');
    const versions = latest.versions || [];
    const tasks = number ? generated.map((task) => ({ ...task, version: number })) : generated;
    await saveProject({ ...latest, versions: number && !existingVersion ? [...versions, { number, goal: draft.goal }] : versions, tasks: [...latest.tasks, ...tasks] }, 'flow', number);
  }, '', '작업 흐름 생성');
  dialog.querySelector('[name=mode]')?.addEventListener('change', (e) => {
    const version = e.target.value === 'version';
    const field = dialog.querySelector('[data-version-field]');
    field.hidden = !version;
    const input = field.querySelector('input');
    input.required = version;
    input.disabled = !version;
    $('.dlg-foot .primary', dialog).textContent = '작업 흐름 생성';
  });
  dialog.addEventListener('close', () => {
    if (dialog.querySelector('.pj-plan-prog:not(.done)')) {
      api('/api/projects/plan/cancel', { method: 'POST', body: { projectId: p.id, name: p.name } }).catch(() => {});
    }
  });
  bindProjectAccounts(dialog, agent === p.agent ? p.account || '' : '', p,
    agent === p.agent ? p.model || '' : '', agent === p.agent ? p.effort || '' : '');
}

function projectSnapshotForm(p, selected, sourceFileRun) {
  const versions = p.versions || [];
  const last = (selected || versions.at(-1))?.number.split('.').map(Number);
  let number = '1.0.0';
  if (last) {
    do { last[2]++; number = last.join('.'); }
    while (versions.some((item) => item.number === number));
    if (last[2] > 999999999) number = '';
  }
  return projectDialog(sourceFileRun ? '스냅샷에서 이어 작업' : '버전 저장', `
    <p class="ums">${sourceFileRun ? '스냅샷을 새 버전으로 저장하고 작업 폴더를 엽니다.' : '현재 작업 파일을 이 버전의 보관본으로 저장합니다.'}</p>
    <label>버전 번호<input name="version" value="${esc(number)}" placeholder="1.2.0" maxlength="29" required autofocus></label>
    <label>버전 메모<textarea name="goal" maxlength="6000" rows="3"></textarea></label>`, async (form, button) => {
    const version = form.get('version').trim().replace(/^v/i, '');
    if (!/^(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})$/.test(version)) throw new Error('버전 번호를 1.2.0 형식으로 입력하세요.');
    button.textContent = '저장 중…';
    try {
      await saveProject({ id: p.id, revision: p.revision, snapshotVersion: version,
        sourceVersion: selected?.number, sourceFileRun, versionGoal: form.get('goal') }, 'versions', version);
      toast(sourceFileRun ? '이 버전의 작업 폴더를 열었습니다.' : '버전 파일을 저장했습니다.');
    } finally { button.textContent = '저장'; }
  });
}

function projectFileRunHistoryHTML(p) {
  const runs = (p.fileRuns || []).filter((run) => run.startedAt).reverse();
  if (!runs.length) return '';
  return `<h3>작업 실행 스냅샷</h3>${runs.map((run) => {
    const task = p.tasks.find((item) => item.id === run.taskId);
    const current = task?.lastRun?.fileRunId === run.id ? task : null;
    const state = run.finishedAt ? { stage: 'done', reviewStatus: run.reviewStatus, reviewNote: run.reviewNote } : current;
    const rows = [['start', '시작', '시작 파일 보기', run.startedAt], ['finish', '완료', '완료 파일 보기', run.finishedAt]];
    return `<section class="pj-version" data-file-run="${esc(run.id)}" tabindex="-1">
      <div class="row">${task ? `<button type="button" class="ghost btn-sm" data-file-run-task="${esc(task.id)}">${esc(run.title)}</button>` : `<b>${esc(run.title)}</b>`}
        ${state ? stageBadgeHTML(state.stage) + ' ' + projectReviewBadgeHTML(state, false) : ''}</div>
      ${run.error ? `<p class="ums">${esc(run.error)}</p>` : ''}
      ${rows.filter(([, , , at]) => at).map(([phase, label, action, at]) => `<div class="row" data-file-run-phase="${phase}">
        <span>${label} · <time datetime="${new Date(at).toISOString()}">${new Date(at).toLocaleString()}</time></span>
        <button type="button" class="btn-sm" data-file-run-view>${action}</button>
        <button type="button" class="btn-sm" data-file-run-restore>이 스냅샷에서 이어 작업</button>
      </div>`).join('')}
    </section>`;
  }).join('')}`;
}

async function viewFileRunSnapshot(p, { id, phase }) {
  try {
    const params = new URLSearchParams({ id: p.id, run: id, phase });
    const { files, error } = await api('/api/projects/file-snapshots?' + params);
    if (error) throw new Error(error);
    openDrawer({ title: phase === 'start' ? '시작 스냅샷 파일' : '완료 스냅샷 파일',
      bodyHTML: files.length ? `<ul>${files.map((name) => `<li><code>${esc(name)}</code></li>`).join('')}</ul>` : '<p>저장된 파일이 없습니다.</p>',
      footerHTML: '<button data-drw-close>닫기</button>', width: 540 });
  } catch (error) { toast(error.message, 6000, 'danger'); }
}

function editProjectScope(p) {
  const version = p.scope?.version;
  if (!version) return projectForm(p);
  return projectDialog('버전 목표 수정',
    `<label>목표 · 완료 기준<textarea name="goal" required maxlength="6000" rows="5">${esc(version.goal)}</textarea></label>`,
    (form) => saveProject({ id: p.id, revision: p.revision, editVersionGoal: version.number, versionGoal: form.get('goal').trim() }));
}

async function restoreProjectVersion(p, version, button, tab = 'versions') {
  button.disabled = true;
  button.textContent = '작업 폴더 준비 중…';
  try {
    await saveProject({ id: p.id, revision: p.revision, restoreVersion: version.number }, tab, version.number);
    toast('이 버전의 작업 폴더를 열었습니다.');
  } catch (error) { toast(error.message, 6000, 'danger'); }
  finally { button.disabled = false; button.textContent = '이 버전에서 이어 작업'; }
}

function projectVersions(p) {
  const view = $('#projectContent');
  const versions = p.versions || [];
  const selected = versions.find((version) => version.number === state.sel.version);
  const needsWorkspace = selected?.snapshotId && !selected.workspace;
  const canSave = !needsWorkspace;
  const list = selected ? [selected] : [...versions].reverse();
  view.innerHTML = `<div class="row pj-version-actions">
      ${selected ? `<button type="button" class="btn-sm" id="projectVersionBack">← 버전 목록</button>` : ''}
      ${selected ? '<button type="button" class="btn-sm" id="projectVersionDesign">버전 설계 보기</button>' : ''}
      ${!selected ? '<button type="button" id="projectNewVersion">버전업 설계</button>' : ''}
      ${canSave ? `<button type="button" class="${selected ? 'btn-sm' : 'primary'}" id="projectSaveSnapshot">버전 저장</button>` : ''}
      ${selected && canSave ? `
      <button type="button" class="btn-sm" id="projectVersionPlan">버전 작업 설계</button>
      <button type="button" class="primary" id="projectVersionTask">이 버전에 작업 추가</button>` : ''}
      ${needsWorkspace ? '<button type="button" class="primary" id="projectRestoreVersion">이 버전에서 이어 작업</button>' : ''}
    </div>
    ${list.length ? list.map((version) => {
      const tasks = p.tasks.filter((task) => task.version === version.number);
      const done = tasks.filter((task) => task.stage === 'done').length;
      const stateLabel = version.snapshotId ? (version.workspace ? '작업 폴더 열림' : '파일 저장됨')
        : version.completedCommit ? (done < tasks.length ? '확정 후 작업 중' : '확정') : tasks.length && done === tasks.length && version.baseCommit ? '확정 가능' : '작업 중';
      return `<section class="pj-version">
        <div class="row" style="justify-content:space-between;flex-wrap:wrap">
          <h3>${selected ? `v${esc(version.number)}` : `<button type="button" class="ghost" data-open-version="${esc(version.number)}">v${esc(version.number)}</button>`} <span class="badge">${stateLabel}</span></h3>
          ${tasks.length ? `<span class="ums">완료 ${done}/${tasks.length}</span>` : ''}
        </div>
        <p class="pj-version-goal">${esc(version.goal)}</p>
        ${version.baseCommit ? `<div class="ums">시작 커밋 <code title="${esc(version.baseCommit)}">${esc(version.baseCommit.slice(0, 12))}</code></div>` : ''}
        ${version.completedCommit ? `<div class="ums">확정 커밋 <code title="${esc(version.completedCommit)}">${esc(version.completedCommit.slice(0, 12))}</code></div>` : ''}
        ${selected && tasks.length ? `<ul class="pj-version-task-list">${tasks.map((task) => `<li><div class="pj-version-task">
          <button type="button" class="ghost btn-sm" data-version-task="${esc(task.id)}">${esc(task.title)}</button>
          <div class="row">${stageBadgeHTML(task.stage)} ${needsWorkspace ? '' : projectStartBtnHTML(p, task)}</div>
        </div></li>`).join('')}</ul>` : ''}
        ${selected && !version.snapshotId && version.baseCommit && !version.completedCommit && tasks.length && done === tasks.length ? `<button type="button" class="btn-sm" data-finalize-version="${esc(version.number)}">현재 Git 커밋으로 확정</button>` : ''}
      </section>`;
    }).join('') : !p.fileRuns?.some((run) => run.startedAt) ? '<div class="pj-empty">등록된 버전이 없습니다.</div>' : ''}
    ${selected ? '' : projectFileRunHistoryHTML(p)}`;
  view.onclick = async (event) => {
    const fileRunTask = p.tasks.find((task) => task.id === event.target.closest('[data-file-run-task]')?.dataset.fileRunTask);
    if (fileRunTask) return openProjectTaskDrawer(scopedProject(p, fileRunTask.version), fileRunTask);
    const phase = event.target.closest('[data-file-run-phase]')?.dataset.fileRunPhase;
    if (phase) {
      const source = { id: event.target.closest('[data-file-run]').dataset.fileRun, phase };
      if (event.target.closest('[data-file-run-restore]')) return projectSnapshotForm(p, null, source);
      if (event.target.closest('[data-file-run-view]')) return viewFileRunSnapshot(p, source);
    }
    const version = event.target.closest('[data-open-version]')?.dataset.openVersion;
    if (version) return openProject(p.id, 'design', version);
    if (event.target.closest('#projectVersionBack')) return openProject(p.id, 'versions', '');
    if (event.target.closest('#projectVersionDesign')) return openProject(p.id, 'design', selected.number);
    if (event.target.closest('#projectNewVersion')) return projectFollowupForm(p, true);
    if (event.target.closest('#projectSaveSnapshot')) return projectSnapshotForm(p, selected);
    const restore = event.target.closest('#projectRestoreVersion');
    if (restore && selected) return restoreProjectVersion(p, selected, restore);
    if (event.target.closest('#projectVersionPlan') && selected) return projectFollowupForm(p, false, selected.number);
    if (event.target.closest('#projectVersionTask') && selected) return taskForm(p, null, false, '', selected.number);
    const action = event.target.closest('[data-start-task]');
    if (action) return runProjectCardAction(scopedProject(p, selected.number), p.tasks.find((task) => task.id === action.dataset.startTask), action);
    const id = event.target.closest('[data-version-task]')?.dataset.versionTask;
    if (id) return openProjectTaskDrawer(scopedProject(p, selected.number), p.tasks.find((task) => task.id === id));
    const button = event.target.closest('[data-finalize-version]');
    if (!button) return;
    button.disabled = true;
    try { await saveProject({ id: p.id, revision: p.revision, finalizeVersion: button.dataset.finalizeVersion }, 'versions'); }
    catch (error) { toast(error.message, 6000, 'danger'); }
    finally { button.disabled = false; }
  };
}

function cleanTaskPreview(raw) {
  return String(raw || '')
    .replace(/\[(?:Primary Sources\s*&\s*Assumptions|Methods\s*&\s*Boundaries|Independent Validation|Verification|Assumptions|Context)\]\s*/gi, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}
window.cleanTaskPreview = cleanTaskPreview;

// Scannable Task List: Task Kind Color Badge + Stage Badge + 1-Click Embedded Sub-Dev Chat (`💬 서브 개발`)
function showProjectGoal(goal) {
  const d = document.createElement('dialog');
  d.className = 'pj-dialog pj-goal-dialog';
  d.setAttribute('aria-labelledby', 'projectGoalTitle');
  d.innerHTML = `<div class="dlg-head">
    <h3 id="projectGoalTitle">목표 · 완료 기준</h3>
    <button type="button" class="ghost icon-btn btn-sm" aria-label="닫기" autofocus>${window.UI_ICO?.close || '✕'}</button>
  </div><div class="pj-goal-body">${esc(goal)}</div>`;
  document.body.append(d);
  d.querySelector('button').onclick = () => d.close();
  d.addEventListener('close', () => d.remove(), { once: true });
  d.showModal();
}

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

  const rowHTML = (t, numMark) => {
    const subs = byParent.get(t.id) || [];
    const subDone = subs.filter((s) => s.stage === 'done').length;
    const deps = t.after.map((id) => p.tasks.find((x) => x.id === id)?.title).filter(Boolean);
    const summary = [t.detail ? cleanTaskPreview(t.detail) : '', deps.length ? `← ${deps.join(', ')}` : ''].filter(Boolean).join(' · ');
    const k = typeof taskKindOf === 'function' ? taskKindOf(t) : 'dev';
    const chatCnt = (p.subChats?.[t.id] || []).length;
    const tokBadge = typeof taskTokenBadgeHTML === 'function' ? taskTokenBadgeHTML(p, t, true) : '';
    const subTip = `클릭해 우측 상세 패널에서 하위 서브태스크 ${subs.length}개 확인`;
    const menuAria = `${t.title} 메뉴`;
    const showSummary = t.stage !== 'done' && summary;
    const collapsed = typeof isTaskCollapsed === 'function' && isTaskCollapsed(p.id, t.id);
    return `<div class="pj-row${t.stage === 'done' ? ' is-done' : ''}${t.autoExclude ? ' is-auto-off' : ''}${collapsed ? ' is-collapsed' : ''}" data-task-row="${esc(t.id)}">
      <span class="pj-step-num ${esc(t.stage)} kind-${esc(k)}" title="${esc(projectStages.find((s) => s[0] === t.stage)?.[1] || t.stage)}">${numMark}</span>
      <div class="pj-row-main">
        <div class="pj-row-head">
          ${typeof collapseBtnHTML === 'function' ? collapseBtnHTML(collapsed, t.id) : ''}
          ${typeof kindBadgeHTML === 'function' ? kindBadgeHTML(t) : ''}
          <button data-plan-task="${esc(t.id)}" class="pj-title">${esc(t.title)}</button>
        </div>
        <div class="pj-row-badges">
          ${t.stage !== 'planned' ? stageBadgeHTML(t.stage) : ''}
          ${typeof projectReviewBadgeHTML === 'function' ? projectReviewBadgeHTML(t) : ''}
          ${subs.length ? `<span class="badge" title="${esc(subTip)}">서브 ${subDone}/${subs.length}</span>` : ''}
          ${tokBadge}
        </div>
        ${showSummary ? `<div class="pj-row-desc">${esc(summary)}</div>` : ''}
        ${typeof projectReviewNoteHTML === 'function' ? projectReviewNoteHTML(t, true) : ''}
        ${t.lastRun || t.launchBlock ? `<div class="row">${projectLastRunHTML(t)}</div>` : ''}
      </div>
      <div class="pj-row-acts">
        <button type="button" class="pj-auto-sw${t.autoExclude ? ' off' : ' on'}" data-toggle-auto="${esc(t.id)}" aria-pressed="${!t.autoExclude}" title="${t.autoExclude ? '자동 진행에서 제외됨 (클릭해 포함)' : '자동 진행에 포함됨 (클릭해 제외)'}">${t.autoExclude ? '자동 OFF' : '자동 ON'}</button>
        <button class="ghost btn-sm" data-subchat-task="${esc(t.id)}" title="이 태스크 안에서 채팅 기반으로 서브 개발 진행">${ico.chat || ''} 서브 개발${chatCnt ? ` <b>${chatCnt}</b>` : ''}</button>
        ${projectCliBadgeHTML(p, t)}
        <span class="pj-act-status">${projectStartBtnHTML(p, t)}</span>
        <button class="ghost icon-btn btn-sm" data-task-more="${esc(t.id)}" aria-label="${esc(menuAria)}" aria-haspopup="menu" aria-expanded="false">${ico.more || '⋯'}</button>
      </div>
    </div>`;
  };

  const defCfg = [providerName(p.agent || 'codex'), p.model || '', p.effort ? `추론 ${p.effort}` : ''].filter(Boolean).join(' · ');
  const goal = (p.scope?.version?.goal ?? p.goal) || '작업 설계에서 목표와 완료 기준을 입력하세요.';
  const goalPreviewTxt = cleanTaskPreview(goal) || goal;
  host.innerHTML = `<div class="pj-design-wrap">
    <section class="pj-objective">
      <div class="pj-objective-body">
        <span class="pj-objective-lbl">목표 · 완료 기준 <span class="badge tag" style="margin-left:6px;text-transform:none;letter-spacing:0">${esc(defCfg)}</span></span>
        <button id="projectGoalPreview" type="button" class="pj-goal" aria-haspopup="dialog"><span>${esc(goalPreviewTxt)}</span><small>전문 보기 →</small></button>
      </div>
      <button id="projectEdit" class="ghost btn-sm">${ico.edit || ''} 수정</button>
    </section>
    <section class="pj-list">
      ${topTasks.length ? topTasks.map((t, idx) => rowHTML(t, t.stage === 'done' ? '✓' : String(idx + 1), false)).join('') : '<div class="empty" style="padding:28px 16px;text-align:center">상단 ＋ 작업 버튼으로 첫 작업을 추가하세요.</div>'}
    </section>
  </div>`;
  $('#projectEdit').onclick = () => editProjectScope(p);
  $('#projectGoalPreview').onclick = () => showProjectGoal(goal);
  host.onclick = (e) => {
    const colBtn = e.target.closest('[data-toggle-collapse]');
    if (colBtn) {
      e.stopPropagation();
      const tid = colBtn.dataset.toggleCollapse;
      const next = toggleTaskCollapsed(p.id, tid);
      const rowEl = colBtn.closest('[data-task-row]');
      if (rowEl) rowEl.classList.toggle('is-collapsed', next);
      colBtn.textContent = next ? '▸' : '▾';
      colBtn.title = next ? '펼치기' : '접기';
      colBtn.setAttribute('aria-expanded', String(!next));
      return;
    }
    const autoSw = e.target.closest('[data-toggle-auto]');
    if (autoSw) {
      e.stopPropagation();
      const tid = autoSw.dataset.toggleAuto;
      saveProject({ ...p, tasks: p.tasks.map((t) => (t.id === tid ? { ...t, autoExclude: !t.autoExclude } : t)) }).catch((er) => toast(er.message, 5000, 'danger'));
      return;
    }
    const scBtn = e.target.closest('[data-subchat-task]');
    if (scBtn) {
      e.stopPropagation();
      return openProjectTaskDrawer(p, p.tasks.find((x) => x.id === scBtn.dataset.subchatTask), true);
    }
    const addSub = e.target.closest('[data-add-sub]');
    if (addSub) { e.stopPropagation(); return taskForm(p, null, false, addSub.dataset.addSub); }
    const more = e.target.closest('[data-task-more]');
    if (more) { e.stopPropagation(); return openProjectTaskMenu(p, p.tasks.find((x) => x.id === more.dataset.taskMore), more); }
    const assign = e.target.closest('[data-assign-task]');
    if (assign) { e.stopPropagation(); return taskForm(p, p.tasks.find((x) => x.id === assign.dataset.assignTask), true); }
    const start = e.target.closest('[data-start-task]');
    if (start) { e.stopPropagation(); return runProjectCardAction(p, p.tasks.find((x) => x.id === start.dataset.startTask), start); }
    const row = e.target.closest('[data-task-row], [data-plan-task]');
    if (row) {
      const id = row.dataset.planTask || row.dataset.taskRow;
      openProjectTaskDrawer(p, p.tasks.find((x) => x.id === id));
    }
  };
}
