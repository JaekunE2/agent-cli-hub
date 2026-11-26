// Apps UI: App lifecycle (add, import, edit, delete), action runner (command/agent/pipeline),
// output viewer, data manager, run logs, and chat/session integration.
'use strict';
(function () {
  let appsCache = [];
  let selectedAppId = '';
  let activeTab = 'view';
  let selectedViewFile = '';
  let selectedDataFile = '';
  let reportRunId = '';
  let pollTimer = null;
  let renderId = 0;

  function stopPoll() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function currentApp() {
    return appsCache.find((a) => a.id === selectedAppId) || null;
  }

  async function fetchApps() {
    const r = await api('/api/apps');
    appsCache = r.apps || [];
    return appsCache;
  }

  function statusBadge(st) {
    if (st === 'running') return '<span class="pill warn">실행 중</span>';
    if (st === 'error') return '<span class="pill bad">오류</span>';
    if (st === 'ok') return '<span class="pill ok">완료</span>';
    if (st === 'cancelled') return '<span class="pill muted">중단됨</span>';
    return '<span class="pill muted">대기</span>';
  }

  function openModal(title, bodyHtml, onMount) {
    const prevFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const wrap = document.createElement('div');
    wrap.className = 'modal-bg dlg';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.setAttribute('aria-label', title);
    wrap.style.cssText = 'position:fixed;inset:0;background:rgba(9,11,16,.48);backdrop-filter:blur(2px);display:flex;align-items:center;justify-content:center;z-index:60;padding:44px 16px 16px;';
    wrap.innerHTML = `<div class="box" style="width:min(640px,100%);max-height:calc(100dvh - 64px);overflow:auto;padding:20px 22px;background:var(--popover);color:var(--text);border:1px solid var(--line-strong);border-radius:var(--radius-xl);box-shadow:var(--shadow-high);">
      <div class="dlg-head" style="margin-bottom:6px;">
        <h3>${esc(title)}</h3>
        <button type="button" class="ghost icon-btn btn-sm" data-close aria-label="닫기">${ICO.close}</button>
      </div>
      <div class="m-body">${bodyHtml}</div>
    </div>`;
    let downOnBackdrop = false;
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
    };
    const close = () => {
      document.removeEventListener('keydown', onKey, true);
      wrap.remove();
      if (prevFocus && prevFocus.isConnected) prevFocus.focus({ preventScroll: true });
    };
    wrap.addEventListener('pointerdown', (e) => { downOnBackdrop = e.target === wrap; });
    wrap.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]') || (e.target === wrap && downOnBackdrop)) close();
      downOnBackdrop = false;
    });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(wrap);
    onMount?.(wrap, close);
    const firstInput = wrap.querySelector('input:not([type=hidden]), select, textarea, button:not([data-close])');
    firstInput?.focus({ preventScroll: true });
  }

  function showAppFormModal(existing = null) {
    const isEdit = Boolean(existing);
    const firstAct = existing?.actions?.[0] || { id: 'run', label: '실행', kind: 'command', cmd: '', prompt: '' };
    const html = `
      ${!isEdit ? `<div style="padding:10px 12px;border:1px dashed var(--line-strong);border-radius:10px;margin-bottom:14px;">
        <div style="font-weight:600;font-size:.88rem;margin-bottom:6px;">폴더에서 app.json 가져오기 (Import)</div>
        <div style="display:flex;gap:6px;">
          <input id="impDir" class="btn-sm" style="flex:1;" placeholder="예: D:\\Gitsource\\...\\동향파악">
          <button type="button" class="btn-sm" id="btnPickImpDir">폴더 선택</button>
          <button type="button" class="btn-sm" id="btnImportDir">가져오기</button>
        </div>
      </div>` : ''}
      <form id="appForm" style="display:grid;gap:10px;font-size:.9rem;">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
          <label>앱 ID <input name="id" required ${isEdit ? 'readonly' : ''} value="${esc(existing?.id || '')}" placeholder="my-app" class="btn-sm" style="width:100%;margin-top:4px;"></label>
          <label>이름 <input name="name" required value="${esc(existing?.name || '')}" placeholder="앱 이름" class="btn-sm" style="width:100%;margin-top:4px;"></label>
        </div>
        <label>설명 <input name="description" value="${esc(existing?.description || '')}" placeholder="앱 설명" class="btn-sm" style="width:100%;margin-top:4px;"></label>
        <label>사용법 <textarea name="usage" rows="3" class="btn-sm" style="width:100%;margin-top:4px;">${esc(existing?.usage || '')}</textarea></label>
        <label>개발 의도 <textarea name="purpose" rows="2" class="btn-sm" style="width:100%;margin-top:4px;">${esc(existing?.purpose || '')}</textarea></label>
        <div style="display:grid;grid-template-columns:140px 1fr;gap:10px;">
          <label>유형
            <select name="type" class="btn-sm" style="width:100%;margin-top:4px;">
              <option value="report" ${existing?.type === 'report' ? 'selected' : ''}>리포트(HTML/MD)</option>
              <option value="url" ${existing?.type === 'url' ? 'selected' : ''}>웹 URL</option>
              <option value="command" ${existing?.type === 'command' ? 'selected' : ''}>커맨드/도구</option>
            </select>
          </label>
          <label>작업 폴더 (cwd)
            <div style="display:flex;gap:6px;margin-top:4px;">
              <input name="cwd" value="${esc(existing?.cwd || '')}" placeholder="D:\\path\\to\\app" class="btn-sm" style="flex:1;">
              <button type="button" class="btn-sm" id="btnPickAppCwd">폴더 선택</button>
            </div>
          </label>
        </div>
        <label data-app-f="url">웹 URL <input name="entryUrl" value="${esc(existing?.entryUrl || '')}" placeholder="http://127.0.0.1:8080" class="btn-sm" style="width:100%;margin-top:4px;"></label>
        <div data-app-f="dirs" style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
          <label>뷰 폴더 (viewDir) <input name="viewDir" value="${esc(existing?.outputs?.viewDir || '산출물')}" class="btn-sm" style="width:100%;margin-top:4px;"></label>
          <label>데이터 폴더 (dataDir) <input name="dataDir" value="${esc(existing?.outputs?.dataDir || 'data')}" class="btn-sm" style="width:100%;margin-top:4px;"></label>
        </div>
        <div style="display:grid;grid-template-columns:130px 1fr;gap:10px;">
          <label>기본 액션 유형
            <select name="actionKind" class="btn-sm" style="width:100%;margin-top:4px;">
              <option value="command" ${firstAct.kind === 'command' ? 'selected' : ''}>command (코드)</option>
              <option value="agent" ${firstAct.kind === 'agent' ? 'selected' : ''}>agent (프롬프트)</option>
              <option value="pipeline" ${firstAct.kind === 'pipeline' ? 'selected' : ''}>pipeline (코드+LLM)</option>
            </select>
          </label>
          <label data-app-f="cmd">실행 명령어 (cmd) <input name="actionCmd" value="${esc(firstAct.cmd || '')}" placeholder=".venv\\Scripts\\python.exe run.py" class="btn-sm" style="width:100%;margin-top:4px;"></label>
        </div>
        <label data-app-f="prompt">에이전트 프롬프트 <textarea name="actionPrompt" rows="2" class="btn-sm" style="width:100%;margin-top:4px;">${esc(firstAct.prompt || '')}</textarea></label>
        <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:6px;">
          <button type="button" class="btn-sm" data-close>취소</button>
          <button type="submit" class="primary btn-sm">${isEdit ? '저장' : '등록'}</button>
        </div>
      </form>`;

    openModal(isEdit ? `앱 설정: ${existing.name}` : '새 앱 추가', html, (wrap, close) => {
      const form = wrap.querySelector('#appForm');
      const syncAppFields = () => {
        const tp = form.querySelector('[name=type]').value;
        const ak = form.querySelector('[name=actionKind]').value;
        const urlEl = form.querySelector('[data-app-f="url"]');
        const dirsEl = form.querySelector('[data-app-f="dirs"]');
        const promptEl = form.querySelector('[data-app-f="prompt"]');
        if (urlEl) urlEl.hidden = tp !== 'url';
        if (dirsEl) dirsEl.hidden = tp === 'url';
        if (promptEl) promptEl.hidden = ak === 'command';
      };
      form.querySelector('[name=type]')?.addEventListener('change', syncAppFields);
      form.querySelector('[name=actionKind]')?.addEventListener('change', syncAppFields);
      syncAppFields();
      wrap.querySelector('#btnPickImpDir')?.addEventListener('click', () => {
        if (typeof openFolderPickerDialog === 'function') {
          openFolderPickerDialog(wrap.querySelector('#impDir').value.trim(), (chosen) => { if (chosen) wrap.querySelector('#impDir').value = chosen; });
        }
      });
      wrap.querySelector('#btnPickAppCwd')?.addEventListener('click', () => {
        const cwdIn = form.querySelector('[name=cwd]');
        if (typeof openFolderPickerDialog === 'function') {
          openFolderPickerDialog(cwdIn.value.trim(), (chosen) => { if (chosen) cwdIn.value = chosen; });
        }
      });
      wrap.querySelector('#btnImportDir')?.addEventListener('click', async () => {
        const dir = wrap.querySelector('#impDir').value.trim();
        if (!dir) return toast('폴더 경로를 입력하세요');
        try {
          const r = await api('/api/apps/import', { method: 'POST', body: { dir }, requireOk: true });
          close();
          toast(`${r.app.name} 앱을 가져왔습니다`);
          viewApps(r.app.id);
        } catch (e) { toast(e.message, 5000, 'danger'); }
      });

      wrap.querySelector('#appForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const cmd = String(fd.get('actionCmd') || '').trim();
        const prompt = String(fd.get('actionPrompt') || '').trim();
        const kind = String(fd.get('actionKind') || 'command');
        const actions = (cmd || prompt)
          ? [{ ...firstAct, kind, cmd, prompt }, ...(existing?.actions || []).slice(1)]
          : (existing?.actions || []);
        const payload = {
          id: fd.get('id'),
          name: fd.get('name'),
          description: fd.get('description'),
          usage: fd.get('usage'),
          purpose: fd.get('purpose'),
          type: fd.get('type'),
          cwd: fd.get('cwd'),
          entryUrl: fd.get('entryUrl'),
          outputs: {
            viewDir: fd.get('viewDir'),
            viewGlob: existing?.outputs?.viewGlob || '*.html',
            dataDir: fd.get('dataDir'),
            dataGlob: existing?.outputs?.dataGlob || '*.json',
          },
          actions,
        };
        try {
          const url = isEdit ? `/api/apps/${encodeURIComponent(existing.id)}` : '/api/apps';
          const r = await api(url, { method: isEdit ? 'PUT' : 'POST', body: payload });
          close();
          toast(isEdit ? '앱 설정을 저장했습니다' : '새 앱을 등록했습니다');
          viewApps(r.app.id);
        } catch (er) { toast(er.message, 5000, 'danger'); }
      });
    });
  }

  function showDeleteModal(app) {
    const html = `
      <p style="margin:0 0 12px;"><strong>${esc(app.name)}</strong> (${esc(app.id)}) 앱을 허브에서 제거합니다.</p>
      <p style="margin:0 0 12px;color:var(--muted);font-size:.86rem;">작업 폴더(<code>${esc(app.cwd)}</code>)와 소스코드는 삭제되지 않습니다.</p>
      <label style="display:flex;align-items:center;gap:8px;margin-bottom:16px;font-size:.9rem;">
        <input type="checkbox" id="chkPurgeOutputs"> 생성된 산출물/데이터 파일(${app.counts?.views || 0}뷰, ${app.counts?.data || 0}데이터)도 함께 삭제
      </label>
      <div style="display:flex;justify-content:flex-end;gap:8px;">
        <button type="button" class="btn-sm" data-close>취소</button>
        <button type="button" class="btn-sm danger" id="btnConfirmDel">제거</button>
      </div>`;
    openModal('앱 제거 확인', html, (wrap, close) => {
      wrap.querySelector('#btnConfirmDel').addEventListener('click', async () => {
        const purge = wrap.querySelector('#chkPurgeOutputs').checked;
        try {
          await api(`/api/apps/${encodeURIComponent(app.id)}?purgeOutputs=${purge ? 'true' : 'false'}`, { method: 'DELETE' });
          close();
          toast('앱을 제거했습니다');
          viewApps();
        } catch (e) { toast(e.message, 5000, 'danger'); }
      });
    });
  }

  async function sendToChat(app, fileName, promptText) {
    try {
      const r = await api(`/api/apps/${encodeURIComponent(app.id)}/send-to-chat`, {
        method: 'POST',
        body: { file: fileName || '', prompt: promptText || '' },
      });
      if (r.delivered) {
        toast(`연결된 세션(t:${r.termId})으로 결과물을 전달했습니다`);
      } else {
        await navigator.clipboard?.writeText(r.message || '').catch(() => {});
        toast('실행 중인 연결 세션이 없어 프롬프트를 클립보드에 복사했습니다');
      }
    } catch (e) { toast(e.message, 5000, 'danger'); }
  }

  async function renderAppBody(app) {
    const body = $('#appsBody');
    if (!body) return;
    if (!app) {
      body.innerHTML = `<div class="empty" style="padding:32px;text-align:center;">
        <p>등록된 앱이 없습니다.</p>
        <button type="button" class="primary btn-sm" id="btnEmptyAdd">${ICO.plus} 첫 번째 앱 추가</button>
      </div>`;
      body.querySelector('#btnEmptyAdd')?.addEventListener('click', () => showAppFormModal());
      return;
    }

    const needsAgent = app.actions?.some((action) => action.kind === 'agent') && !app.linkedSession?.actionTermId;
    const actionsHtml = (app.actions || []).map((act) => {
      const paramsHtml = (act.params || []).map((pm) =>
        `<label style="display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--muted)"><span>${esc(pm.label || pm.key)}</span><input class="btn-sm app-param" data-action="${esc(act.id)}" data-key="${esc(pm.key)}" placeholder="${esc(pm.label || pm.key)}" value="${esc(pm.default || '')}" style="width:130px;"></label>`
      ).join('');
      const blocked = needsAgent && act.kind === 'agent';
      return `${paramsHtml}<button type="button" class="primary btn-sm app-run-btn" data-action="${esc(act.id)}" ${app.status === 'running' || blocked ? 'disabled' : ''} ${blocked ? 'aria-describedby="appAgentHelp"' : ''}>${ICO.play} ${esc(act.label)}</button>`;
    }).join(' ');

    body.innerHTML = `
      <div class="card" style="padding:14px 16px;margin-bottom:12px;">
        <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between;">
          <div>
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
              <strong style="font-size:1.05rem;">${esc(app.name)}</strong>
              ${statusBadge(app.status === 'running' ? app.status : app.latestRun?.status || app.status)}
              <span class="pill">${esc(app.type)}</span>
            </div>
            <div style="color:var(--muted);font-size:.85rem;margin-top:4px;">${esc(app.description || app.cwd)}</div>
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;">
            ${actionsHtml}
            ${app.status === 'running' ? `<button type="button" class="btn-sm danger" id="btnCancelRun">중단</button>` : ''}
            <a class="btnlike btn-sm" id="btnExportApp" href="/api/apps/${encodeURIComponent(app.id)}/export?t=${encodeURIComponent(TOKEN)}" download="${esc(app.id)}-share.zip" title="다른 사람에게 전달할 수 있는 ZIP 패키지로 내보내기">${ICO.upload} 전달용 내보내기</a>
            <button type="button" class="btn-sm" id="btnEditApp" title="앱 설정">${ICO.edit}</button>
            <button type="button" class="btn-sm danger" id="btnDelApp" title="앱 제거">${ICO.trash}</button>
          </div>
        </div>
        ${needsAgent ? `<p id="appAgentHelp" style="margin:10px 0 0;color:var(--muted);">
          연결된 에이전트 실행기가 준비되면 이 작업을 시작할 수 있습니다.
        </p>` : ''}
        ${app.usage || app.purpose ? `<div class="app-guide">
          ${app.usage ? `<section><h3>사용법</h3><p>${esc(app.usage)}</p></section>` : ''}
          ${app.purpose ? `<section><h3>개발 의도</h3><p>${esc(app.purpose)}</p></section>` : ''}
        </div>` : ''}
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:12px;">
        <button type="button" class="btn-sm ${activeTab === 'view' ? 'primary' : ''}" data-apptab="view">${ICO.eye} 화면 (${app.counts?.views || 0})</button>
        <button type="button" class="btn-sm ${activeTab === 'data' ? 'primary' : ''}" data-apptab="data">${ICO.code} 데이터 (${app.counts?.data || 0})</button>
        <button type="button" class="btn-sm ${activeTab === 'runs' ? 'primary' : ''}" data-apptab="runs">${ICO.clock} 실행 로그</button>
      </div>
      <div id="appTabContent">불러오는 중…</div>`;

    body.querySelectorAll('[data-apptab]').forEach((b) => {
      b.onclick = () => { activeTab = b.dataset.apptab; renderAppBody(app); };
    });
    body.querySelector('#btnEditApp').onclick = () => showAppFormModal(app);
    body.querySelector('#btnDelApp').onclick = () => showDeleteModal(app);
    body.querySelector('#btnCancelRun')?.addEventListener('click', async () => {
      await api(`/api/apps/${encodeURIComponent(app.id)}/cancel`, { method: 'POST' });
      toast('실행 중단을 요청했습니다');
      await fetchApps();
      renderAppBody(currentApp());
    });
    body.querySelectorAll('.app-run-btn').forEach((btn) => {
      btn.onclick = async () => {
        const aid = btn.dataset.action;
        btn.disabled = true;
        const label = btn.innerHTML;
        btn.textContent = '제출 중…';
        const params = {};
        body.querySelectorAll(`.app-param[data-action="${aid}"]`).forEach((inp) => {
          params[inp.dataset.key] = inp.value;
        });
        try {
          const { run } = await api(`/api/apps/${encodeURIComponent(app.id)}/run`, { method: 'POST', body: { actionId: aid, params }, requireOk: true });
          if (run.status === 'error') toast(run.stderr || '실행할 수 없습니다', 5000, 'danger');
          else toast(run.kind === 'agent' ? '세션에 요약 요청을 전달했습니다' : '실행을 시작했습니다');
          if (!btn.isConnected) return;
          reportRunId = app.type === 'report' && run.kind !== 'agent' ? run.runId : '';
          activeTab = 'runs';
          viewApps(app.id);
        } catch (e) {
          btn.disabled = false;
          btn.innerHTML = label;
          toast(e.message, 5000, 'danger');
        }
      };
    });

    const tabBox = body.querySelector('#appTabContent');
    if (activeTab === 'view') await renderViewTab(app, tabBox);
    else if (activeTab === 'data') await renderDataTab(app, tabBox);
    else await renderRunsTab(app, tabBox);
  }

  async function renderViewTab(app, box) {
    if (app.type === 'url' && app.entryUrl) {
      box.innerHTML = `<iframe src="${esc(app.entryUrl)}" style="width:100%;height:72vh;border:1px solid var(--line-strong);border-radius:12px;background:#fff;"></iframe>`;
      return;
    }
    const { views = [] } = await api(`/api/apps/${encodeURIComponent(app.id)}/files`).catch(() => ({ views: [] }));
    if (!views.length) {
      box.innerHTML = '<div class="empty" style="padding:24px;">생성된 화면(HTML) 파일이 없습니다. 상단 실행 버튼으로 앱을 실행해 보세요.</div>';
      return;
    }
    const curFile = views.some((v) => v.name === selectedViewFile) ? selectedViewFile : views[0].name;
    selectedViewFile = curFile;
    const viewUrl = `/api/apps/${encodeURIComponent(app.id)}/view/${encodeURIComponent(curFile)}?t=${encodeURIComponent(TOKEN)}`;
    box.innerHTML = `
      <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:10px;">
        <select id="selViewFile" class="btn-sm">${views.map((v) => `<option value="${esc(v.name)}" ${v.name === curFile ? 'selected' : ''}>${esc(v.name)}</option>`).join('')}</select>
        <a class="btn-sm" href="${viewUrl}" target="_blank" rel="noopener">${ICO.external} 새 창에서 열기</a>
        <button type="button" class="btn-sm" id="btnAskView">${ICO.clip} 이 결과로 채팅 질문</button>
      </div>
      <iframe src="${viewUrl}" sandbox="allow-scripts allow-popups" style="width:100%;height:74vh;border:1px solid var(--line-strong);border-radius:12px;background:#fff;"></iframe>`;
    box.querySelector('#selViewFile').onchange = (e) => { selectedViewFile = e.target.value; renderViewTab(app, box); };
    box.querySelector('#btnAskView').onclick = () => sendToChat(app, curFile, `${curFile} 내용을 바탕으로 핵심만 요약해 주세요.`);
  }

  async function renderDataTab(app, box) {
    const { data = [] } = await api(`/api/apps/${encodeURIComponent(app.id)}/files`).catch(() => ({ data: [] }));
    if (!data.length) {
      box.innerHTML = '<div class="empty" style="padding:24px;">저장된 데이터(JSON) 파일이 없습니다.</div>';
      return;
    }
    const curFile = data.some((d) => d.name === selectedDataFile) ? selectedDataFile : data[0].name;
    selectedDataFile = curFile;
    const detail = await api(`/api/apps/${encodeURIComponent(app.id)}/data?file=${encodeURIComponent(curFile)}`).catch((e) => ({ error: e.message }));
    const rows = data.map((d) => `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px;border-bottom:1px solid var(--line-strong);">
        <button type="button" class="ghost btn-sm data-pick" data-file="${esc(d.name)}" style="font-weight:${d.name === curFile ? '700' : '400'};">${esc(d.name)} <span style="color:var(--muted);">(${(d.size / 1024).toFixed(1)} KB)</span></button>
        <div style="display:flex;gap:6px;">
          <button type="button" class="btn-sm data-chat" data-file="${esc(d.name)}">${ICO.clip} 채팅 전달</button>
          <button type="button" class="btn-sm danger data-del" data-file="${esc(d.name)}">${ICO.trash}</button>
        </div>
      </div>`).join('');
    box.innerHTML = `
      <div class="card" style="padding:12px 14px;margin-bottom:12px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
          <strong>데이터 파일 목록</strong>
          <button type="button" class="btn-sm" id="btnPurge30">30일 이전 정리</button>
        </div>
        ${rows}
      </div>
      <div class="card" style="padding:12px 14px;">
        <div style="font-weight:600;margin-bottom:8px;">미리보기: ${esc(curFile)}</div>
        <pre style="max-height:46vh;overflow:auto;font-size:.8rem;margin:0;white-space:pre-wrap;">${esc(detail.error ? detail.error : JSON.stringify(detail.data, null, 2).slice(0, 12000))}</pre>
      </div>`;
    box.querySelectorAll('.data-pick').forEach((b) => { b.onclick = () => { selectedDataFile = b.dataset.file; renderDataTab(app, box); }; });
    box.querySelectorAll('.data-chat').forEach((b) => { b.onclick = () => sendToChat(app, b.dataset.file, `${b.dataset.file} 데이터를 분석해 주세요.`); });
    box.querySelectorAll('.data-del').forEach((b) => {
      b.onclick = async () => {
        if (!confirm(`${b.dataset.file} 파일을 삭제할까요?`)) return;
        await api(`/api/apps/${encodeURIComponent(app.id)}/data?file=${encodeURIComponent(b.dataset.file)}`, { method: 'DELETE' });
        toast('파일을 삭제했습니다');
        await fetchApps();
        renderAppBody(currentApp());
      };
    });
    box.querySelector('#btnPurge30').onclick = async () => {
      if (!confirm('30일 이전의 데이터 파일을 모두 삭제할까요?')) return;
      const r = await api(`/api/apps/${encodeURIComponent(app.id)}/data?olderThanDays=30`, { method: 'DELETE' });
      toast(`30일 이전 파일 ${r.deleted?.length || 0}건을 정리했습니다`);
      await fetchApps();
      renderAppBody(currentApp());
    };
  }

  async function renderRunsTab(app, box) {
    const r = await api(`/api/apps/${encodeURIComponent(app.id)}/runs`).catch(() => ({ runs: [], running: false }));
    const runs = r.runs || [];
    if (!runs.length) {
      box.innerHTML = '<div class="empty" style="padding:24px;">아직 실행 이력이 없습니다.</div>';
      return;
    }
    box.innerHTML = runs.map((run) => `
      <div class="card" style="padding:12px 14px;margin-bottom:10px;">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px;">
          <div><strong>${esc(run.actionLabel || run.actionId)}</strong> ${statusBadge(run.status)}</div>
          <span style="color:var(--muted);font-size:.82rem;">${esc((run.startedAt || '').slice(0, 19).replace('T', ' '))}</span>
          ${run.status === 'running' ? '' : `<button type="button" class="btn-sm" data-remove-run="${esc(run.runId)}">기록 삭제</button>`}
        </div>
        ${run.stdout ? `<pre style="max-height:180px;overflow:auto;font-size:.78rem;background:var(--bg);padding:8px;border-radius:8px;margin:6px 0 0;">${esc(run.stdout)}</pre>` : ''}
        ${run.stderr ? `<pre style="max-height:140px;overflow:auto;font-size:.78rem;background:color-mix(in srgb, var(--danger) 11%, var(--bg));color:var(--danger);border:1px solid color-mix(in srgb, var(--danger) 30%, transparent);padding:8px;border-radius:8px;margin:6px 0 0;">${esc(run.stderr)}</pre>` : ''}
      </div>`).join('');
    box.querySelectorAll('[data-remove-run]').forEach((button) => {
      button.onclick = async () => {
        if (!confirm('이 실행 기록을 삭제할까요?')) return;
        button.disabled = true;
        try {
          await api(`/api/apps/${encodeURIComponent(app.id)}/runs/${encodeURIComponent(button.dataset.removeRun)}`, { method: 'DELETE', requireOk: true });
          if (box.isConnected) viewApps(app.id);
        } catch (e) {
          toast(e.message, 5000, 'danger');
          button.disabled = false;
        }
      };
    });
  }

  window.openAppOutputPicker = async function openAppOutputPicker(onPickPaths) {
    const apps = await fetchApps().catch(() => []);
    const rows = [];
    for (const a of apps) {
      if (a.latestView) rows.push({ app: a.name, kind: '화면', name: a.latestView.name, path: a.latestView.path });
      if (a.latestData) rows.push({ app: a.name, kind: '데이터', name: a.latestData.name, path: a.latestData.path });
    }
    const html = rows.length
      ? rows.map((r, i) => `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--line-strong);">
          <div><strong>[${esc(r.app)}]</strong> <span class="pill">${esc(r.kind)}</span> ${esc(r.name)}</div>
          <button type="button" class="primary btn-sm pick-out" data-idx="${i}">첨부</button>
        </div>`).join('')
      : '<p style="color:var(--muted);">첨부할 앱 결과물이 없습니다.</p>';
    openModal('앱 결과물 채팅에 첨부', html, (wrap, close) => {
      wrap.querySelectorAll('.pick-out').forEach((btn) => {
        btn.onclick = () => {
          const item = rows[Number(btn.dataset.idx)];
          if (item && onPickPaths) onPickPaths([item.path]);
          close();
        };
      });
    });
  };

  function showCompletedReport(app) {
    const run = app?.latestRun;
    if (!reportRunId || run?.runId !== reportRunId || run.status === 'running') return;
    reportRunId = '';
    if (run.status === 'ok' && run.outputView && activeTab === 'runs') {
      selectedViewFile = run.outputView;
      activeTab = 'view';
      toast('작업이 완료되어 리포트를 열었습니다');
    }
  }

  function renderAppCards(apps, body) {
    if (!apps.length) return renderAppBody(null);
    body.innerHTML = `<div class="apps-grid">${apps.map((app, index) => `
      <article class="card app-tile">
        <button type="button" class="ghost app-tile-main" data-app-open="${index}">
          <strong>${esc(app.name)}</strong>
          ${app.description ? `<span class="app-tile-description">${esc(app.description)}</span>` : ''}
          <span class="app-tile-session">앱 열기</span>
        </button>
        <div class="app-tile-footer">
          ${statusBadge(app.status)}
        </div>
      </article>`).join('')}</div>`;
    body.querySelectorAll('[data-app-open]').forEach((button) => {
      button.onclick = () => viewApps(apps[Number(button.dataset.appOpen)].id);
    });
  }

  window.viewApps = async function viewApps(appId = '') {
    stopPoll();
    const gen = viewGen;
    const requestId = ++renderId;
    const isCurrent = () => gen === viewGen && requestId === renderId;
    const changingApp = selectedAppId !== appId;
    if (changingApp) {
      reportRunId = '';
      selectedViewFile = '';
      selectedDataFile = '';
      activeTab = 'view';
    }
    selectedAppId = appId;
    setBar(`<h2 style="flex:none">${ICO.grid} Apps</h2>
      ${appId ? '<button type="button" class="btn-sm" id="btnAppList">앱 목록</button>' : ''}
      <button type="button" class="primary btn-sm" id="btnNewApp">${ICO.plus} 앱 추가</button>`);
    $('#view').innerHTML = '<div id="appsBody" style="padding:12px 16px 40px;">불러오는 중…</div>';
    const body = $('#appsBody');
    $('#btnNewApp').onclick = () => showAppFormModal();
    $('#btnAppList')?.addEventListener('click', () => viewApps());

    try { await fetchApps(); }
    catch (error) {
      if (isCurrent()) body.textContent = `앱 목록을 불러오지 못했습니다. ${error.message}`;
      return;
    }
    if (!isCurrent()) return;

    const app = currentApp();
    if (!app) return renderAppCards(appsCache, body);
    if (changingApp && app.status === 'running') {
      activeTab = 'runs';
      reportRunId = app.type === 'report' ? app.activeRunId : '';
    }
    showCompletedReport(app);
    await renderAppBody(app);
    if (isCurrent() && app.status === 'running') {
      pollTimer = setInterval(async () => {
        if (state.sel?.kind !== 'apps') return stopPoll();
        try { await fetchApps(); } catch { return; }
        if (!isCurrent()) return;
        const cur = currentApp();
        const stillRunning = cur?.status === 'running';
        if (!stillRunning) stopPoll();
        showCompletedReport(cur);
        if (stillRunning && activeTab === 'runs') {
          const tabBox = $('#appTabBox');
          if (tabBox) { await renderRunsTab(cur, tabBox); return; }
        }
        if (!stillRunning) renderAppBody(cur);
      }, 2500);
    }
  };
})();
