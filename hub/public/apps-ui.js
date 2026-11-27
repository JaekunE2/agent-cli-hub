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

  function statusBadge(st, run = null) {
    if (st === 'running') {
      return run?.actionId === '__setup__'
        ? '<span class="pill warn">환경 구성 중</span>'
        : '<span class="pill warn">실행 중</span>';
    }
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
      if (e.key === 'Escape' && [...document.querySelectorAll('.modal-bg.dlg')].at(-1) === wrap) {
        e.preventDefault();
        close();
        e.stopImmediatePropagation();
      }
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

  function showAppFormModal(existing = null, { cwd = '', importOnly = false, fromSlash = false } = {}) {
    const isEdit = Boolean(existing);
    const firstAct = existing?.actions?.[0] || { id: 'run', label: '실행', kind: 'command', cmd: '', prompt: '' };
    const html = `
      ${!isEdit ? `<div style="padding:10px 12px;border:1px dashed var(--line-strong);border-radius:10px;margin-bottom:14px;">
        <div style="font-weight:600;font-size:.88rem;margin-bottom:6px;">폴더에서 app.json 가져오기 (Import)</div>
        <div style="display:flex;gap:6px;">
          <input id="impDir" class="btn-sm" style="flex:1;" value="${esc(cwd)}" placeholder="예: D:\\Gitsource\\...\\동향파악">
          <button type="button" class="btn-sm" id="btnPickImpDir">폴더 선택</button>
          <button type="button" class="btn-sm" id="btnImportDir">가져오기</button>
        </div>
      </div>` : ''}
      <form id="appForm" ${importOnly ? 'hidden' : ''} style="display:${importOnly ? 'none' : 'grid'};gap:10px;font-size:.9rem;">
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
              <input name="cwd" value="${esc(existing?.cwd || cwd)}" placeholder="D:\\path\\to\\app" class="btn-sm" style="flex:1;">
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

    openModal(isEdit ? `앱 설정: ${existing.name}` : importOnly ? '앱 가져오기' : '새 앱 추가', html, (wrap, close) => {
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
          if (!fromSlash || state.sel.kind === 'apps') viewApps(r.app.id);
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
          if (!fromSlash || state.sel.kind === 'apps') viewApps(r.app.id);
        } catch (er) { toast(er.message, 5000, 'danger'); }
      });
    });
  }

  function fmtExportBytes(bytes) {
    const n = Number(bytes || 0);
    if (!Number.isFinite(n) || n <= 0) return '0 B';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  }

  function showExportModal(app) {
    const isRemote = typeof IS_REMOTE !== 'undefined' && IS_REMOTE;
    const html = `
      <div style="display:grid;gap:12px;font-size:.9rem;">
        <p style="margin:0;color:var(--muted);line-height:1.5;">
          <strong>${esc(app.name)}</strong> 앱을 다른 사람에게 전달하거나 다른 PC의 Agent CLI Hub로 가져올 수 있는 ZIP 패키지로 만듭니다.
        </p>
        <div id="expSetup">
          ${isRemote
            ? `<div style="padding:10px 12px;border:1px solid var(--line-strong);border-radius:10px;background:var(--surface-2);font-size:.84rem;color:var(--muted);">
                원격 접속 중입니다. 패키징이 끝나면 브라우저 다운로드로 저장됩니다.
              </div>`
            : `<div style="display:grid;gap:6px;">
                <label style="font-weight:600;font-size:.85rem;">저장 폴더</label>
                <div style="display:flex;gap:6px;">
                  <input id="expDestDir" class="btn-sm" style="flex:1;font-family:var(--mono);font-size:.82rem;" placeholder="기본 다운로드 폴더 불러오는 중…">
                  <button type="button" class="btn-sm" id="btnPickExpDir">폴더 변경</button>
                </div>
                <div id="expPathPreview" style="font-size:.78rem;color:var(--muted);font-family:var(--mono);word-break:break-all;"></div>
              </div>`}
          <label style="display:flex;align-items:center;gap:8px;margin-top:10px;font-size:.86rem;cursor:pointer;">
            <input type="checkbox" id="chkExpOutputs">
            <span>생성된 산출물·reports·데이터도 함께 포함 (${app.counts?.views || 0}뷰, ${app.counts?.data || 0}데이터)</span>
          </label>
          <div style="margin-top:8px;padding:9px 11px;border-radius:8px;background:var(--surface-2);color:var(--muted);font-size:.78rem;line-height:1.5;">
            기본적으로 <code>산출물</code>, <code>reports</code>, 데이터 폴더와 <code>.venv</code>, <code>node_modules</code>, <code>.git</code>, <code>.env</code>, 키 파일은 자동 제외되며, 앱 소스·<code>app.json</code>·<code>SHARE_README.md</code>만 깔끔하게 포함됩니다.
          </div>
        </div>

        <div id="expProgressBox" hidden style="padding:14px;border:1px solid var(--line-strong);border-radius:12px;background:var(--surface-2);display:grid;gap:10px;">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
            <strong id="expStageText" style="font-size:.9rem;">내보내기 준비 중…</strong>
            <span id="expPctText" style="font-weight:700;font-variant-numeric:tabular-nums;color:var(--accent);">0%</span>
          </div>
          <div style="height:8px;border-radius:999px;background:var(--line);overflow:hidden;">
            <div id="expBarFill" style="height:100%;width:0%;background:var(--accent);border-radius:999px;transition:width .22s ease;"></div>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;font-size:.79rem;color:var(--muted);">
            <span id="expFilesText">파일 확인 중…</span>
            <span id="expElapsedText">0.0초</span>
          </div>
        </div>

        <div id="expDoneBox" hidden style="padding:14px;border:1px solid color-mix(in srgb, var(--ok) 45%, transparent);border-radius:12px;background:color-mix(in srgb, var(--ok) 10%, var(--surface-2));display:grid;gap:8px;">
          <div style="display:flex;align-items:center;gap:8px;font-weight:700;color:var(--ok);">
            <span>전달용 패키지 저장 완료</span>
          </div>
          <div style="font-size:.82rem;color:var(--muted);" id="expDoneMeta"></div>
          <div style="padding:8px 10px;border-radius:8px;background:var(--bg);border:1px solid var(--line);font-family:var(--mono);font-size:.8rem;word-break:break-all;" id="expDonePath"></div>
          <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:4px;">
            ${!isRemote ? `<button type="button" class="primary btn-sm" id="btnExpOpenDir">${ICO.folder} 탐색기에서 열기</button>` : ''}
            <button type="button" class="btn-sm" id="btnExpCopyPath">${ICO.copy} 경로 복사</button>
            <a class="btnlike btn-sm" id="btnExpBrowserDl" href="#" download>${ICO.upload} 파일 다운로드</a>
          </div>
        </div>

        <div id="expErrBox" hidden style="padding:12px 14px;border:1px solid color-mix(in srgb, var(--danger) 45%, transparent);border-radius:10px;background:color-mix(in srgb, var(--danger) 11%, var(--bg));color:var(--danger);font-size:.85rem;line-height:1.5;"></div>

        <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:4px;">
          <button type="button" class="btn-sm" data-close id="btnExpClose">닫기</button>
          <button type="button" class="primary btn-sm" id="btnExpStart">${ICO.upload} 내보내기 시작</button>
        </div>
      </div>`;

    openModal(`전달용 패키지 내보내기 — ${app.name}`, html, (wrap) => {
      const destIn = wrap.querySelector('#expDestDir');
      const pathPreview = wrap.querySelector('#expPathPreview');
      const chkOutputs = wrap.querySelector('#chkExpOutputs');
      const progressBox = wrap.querySelector('#expProgressBox');
      const stageText = wrap.querySelector('#expStageText');
      const pctText = wrap.querySelector('#expPctText');
      const barFill = wrap.querySelector('#expBarFill');
      const filesText = wrap.querySelector('#expFilesText');
      const elapsedText = wrap.querySelector('#expElapsedText');
      const doneBox = wrap.querySelector('#expDoneBox');
      const doneMeta = wrap.querySelector('#expDoneMeta');
      const donePath = wrap.querySelector('#expDonePath');
      const errBox = wrap.querySelector('#expErrBox');
      const btnStart = wrap.querySelector('#btnExpStart');
      const btnPick = wrap.querySelector('#btnPickExpDir');
      const btnOpenDir = wrap.querySelector('#btnExpOpenDir');
      const btnCopyPath = wrap.querySelector('#btnExpCopyPath');
      const btnBrowserDl = wrap.querySelector('#btnExpBrowserDl');

      let suggestedFileName = `${app.id}-share.zip`;
      let activeJob = null;
      let pollId = null;

      const stopJobPoll = () => {
        if (pollId) { clearInterval(pollId); pollId = null; }
      };

      const updatePreview = () => {
        if (!destIn || !pathPreview) return;
        const dir = destIn.value.trim();
        if (!dir) { pathPreview.textContent = ''; return; }
        const sep = dir.endsWith('\\') || dir.endsWith('/') ? '' : '\\';
        pathPreview.textContent = `예상 저장 위치: ${dir}${sep}${suggestedFileName}`;
      };

      if (destIn) {
        destIn.addEventListener('input', updatePreview);
        api(`/api/apps/${encodeURIComponent(app.id)}/export-info`)
          .then((info) => {
            if (!wrap.isConnected) return;
            if (info?.fileName) suggestedFileName = info.fileName;
            if (info?.defaultDir && !destIn.value.trim()) destIn.value = info.defaultDir;
            updatePreview();
          })
          .catch(() => {});
      }

      btnPick?.addEventListener('click', () => {
        if (typeof openFolderPickerDialog === 'function') {
          openFolderPickerDialog(destIn?.value.trim() || '', (chosen) => {
            if (chosen && destIn) { destIn.value = chosen; updatePreview(); }
          });
        }
      });

      const renderJob = (job) => {
        activeJob = job;
        const pct = Math.max(0, Math.min(100, Number(job.percent || 0)));
        const sec = ((Number(job.finishedAt || Date.now()) - Number(job.startedAt || Date.now())) / 1000).toFixed(1);
        stageText.textContent = job.stageLabel || '작업 중…';
        pctText.textContent = `${pct}%`;
        barFill.style.width = `${pct}%`;
        filesText.textContent = job.filesTotal > 0 ? `${job.filesDone || 0} / ${job.filesTotal} 파일 처리` : '파일 목록 확인 중…';
        elapsedText.textContent = `${sec}초`;

        if (job.status === 'ok') {
          stopJobPoll();
          barFill.style.background = 'var(--ok)';
          pctText.style.color = 'var(--ok)';
          doneBox.hidden = false;
          errBox.hidden = true;
          btnStart.disabled = false;
          btnStart.innerHTML = `${ICO.upload} 다시 내보내기`;
          if (destIn) destIn.disabled = false;
          if (btnPick) btnPick.disabled = false;
          if (chkOutputs) chkOutputs.disabled = false;

          const skipNote = job.skippedLarge > 0 ? ` · 50MB 초과 ${job.skippedLarge}개 제외` : '';
          doneMeta.textContent = `파일 크기 ${fmtExportBytes(job.bytes)} · 총 ${job.filesTotal}개 파일 포함 (${sec}초 소요${skipNote})`;
          donePath.textContent = isRemote ? `파일명: ${job.fileName}` : job.outputPath;
          const dlUrl = `/api/apps/${encodeURIComponent(app.id)}/export-download?jobId=${encodeURIComponent(job.jobId)}&t=${encodeURIComponent(TOKEN)}`;
          btnBrowserDl.href = dlUrl;
          btnBrowserDl.setAttribute('download', job.fileName || `${app.id}-share.zip`);
          if (isRemote) {
            toast('패키지 생성이 완료되어 다운로드를 시작합니다');
            btnBrowserDl.click();
          } else {
            toast(`전달용 패키지를 저장했습니다: ${job.fileName}`);
          }
        } else if (job.status === 'error') {
          stopJobPoll();
          barFill.style.background = 'var(--danger)';
          pctText.style.color = 'var(--danger)';
          doneBox.hidden = true;
          errBox.hidden = false;
          errBox.textContent = `내보내기 실패: ${job.error || '알 수 없는 오류'}`;
          btnStart.disabled = false;
          btnStart.innerHTML = `${ICO.upload} 다시 시도`;
          if (destIn) destIn.disabled = false;
          if (btnPick) btnPick.disabled = false;
          if (chkOutputs) chkOutputs.disabled = false;
        }
      };

      btnOpenDir?.addEventListener('click', () => {
        if (!activeJob?.outputPath) return;
        api('/api/fs/open-dir', { method: 'POST', body: { path: activeJob.outputPath } })
          .catch((e) => toast(e.message, 4000, 'danger'));
      });

      btnCopyPath?.addEventListener('click', () => {
        if (!activeJob?.outputPath) return;
        if (typeof copyText === 'function') copyText(activeJob.outputPath);
        else navigator.clipboard?.writeText(activeJob.outputPath).then(() => toast('경로를 복사했습니다')).catch(() => {});
      });

      btnStart.addEventListener('click', async () => {
        stopJobPoll();
        doneBox.hidden = true;
        errBox.hidden = true;
        progressBox.hidden = false;
        barFill.style.background = 'var(--accent)';
        pctText.style.color = 'var(--accent)';
        barFill.style.width = '5%';
        pctText.textContent = '5%';
        stageText.textContent = '내보내기 요청 중…';
        filesText.textContent = '파일 목록 확인 중…';
        elapsedText.textContent = '0.0초';

        btnStart.disabled = true;
        btnStart.textContent = '내보내는 중…';
        if (destIn) destIn.disabled = true;
        if (btnPick) btnPick.disabled = true;
        if (chkOutputs) chkOutputs.disabled = true;

        try {
          const r = await api(`/api/apps/${encodeURIComponent(app.id)}/export`, {
            method: 'POST',
            body: {
              destDir: isRemote ? '' : (destIn?.value.trim() || ''),
              includeOutputs: chkOutputs ? chkOutputs.checked : false,
              browserOnly: isRemote,
            },
            requireOk: true,
          });
          if (!wrap.isConnected) return;
          renderJob(r.job);
          if (r.job?.status === 'running') {
            pollId = setInterval(async () => {
              if (!wrap.isConnected) return stopJobPoll();
              try {
                const st = await api(`/api/apps/${encodeURIComponent(app.id)}/export-status?jobId=${encodeURIComponent(r.job.jobId)}`);
                if (!wrap.isConnected) return stopJobPoll();
                if (st?.job) renderJob(st.job);
              } catch (pe) {
                stopJobPoll();
                errBox.hidden = false;
                errBox.textContent = `진행 상태 조회 실패: ${pe.message}`;
                btnStart.disabled = false;
                btnStart.innerHTML = `${ICO.upload} 다시 시도`;
                if (destIn) destIn.disabled = false;
                if (btnPick) btnPick.disabled = false;
                if (chkOutputs) chkOutputs.disabled = false;
              }
            }, 250);
          }
        } catch (e) {
          stopJobPoll();
          errBox.hidden = false;
          errBox.textContent = e.message || '내보내기를 시작하지 못했습니다';
          btnStart.disabled = false;
          btnStart.innerHTML = `${ICO.upload} 다시 시도`;
          if (destIn) destIn.disabled = false;
          if (btnPick) btnPick.disabled = false;
          if (chkOutputs) chkOutputs.disabled = false;
        }
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
            <button type="button" class="btn-sm" id="btnExportApp" title="다른 사람에게 전달할 수 있는 ZIP 패키지로 내보내기">${ICO.upload} 전달용 내보내기</button>
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
    body.querySelector('#btnExportApp').onclick = () => showExportModal(app);
    body.querySelector('#btnEditApp').onclick = () => (app.storeSource && app.settings?.length
      ? showAppSettings(app, () => viewApps(app.id)) : showAppFormModal(app));
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
    if (app.type === 'url' && (app.viewUrl || app.entryUrl)) {
      // store web apps can go through the hub when a plugin serves them there (state.webApps): /app-<id>/<token>/, same URL and token as the hub
      const src = app.storeSource && state.webApps ? `/app-${encodeURIComponent(app.id)}/${encodeURIComponent(TOKEN)}/` : (app.viewUrl || app.entryUrl);
      box.innerHTML = `<iframe src="${esc(src)}" style="width:100%;height:72vh;border:1px solid var(--line-strong);border-radius:12px;background:#fff;"></iframe>`;
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
    const frameUrl = window.isTauriHost?.() ? `${viewUrl}&hub_ext=1` : viewUrl;
    box.innerHTML = `
      <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:10px;">
        <select id="selViewFile" class="btn-sm">${views.map((v) => `<option value="${esc(v.name)}" ${v.name === curFile ? 'selected' : ''}>${esc(v.name)}</option>`).join('')}</select>
        <a class="btnlike btn-sm" id="btnOpenViewExt" href="${viewUrl}" target="_blank" rel="noopener">${ICO.external} 새 창에서 열기</a>
        <button type="button" class="btn-sm" id="btnAskView">${ICO.clip} 이 결과로 채팅 질문</button>
      </div>
      <iframe src="${frameUrl}" sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms" style="width:100%;height:74vh;border:1px solid var(--line-strong);border-radius:12px;background:#fff;"></iframe>`;
    box.querySelector('#selViewFile').onchange = (e) => { selectedViewFile = e.target.value; renderViewTab(app, box); };
    box.querySelector('#btnOpenViewExt').onclick = (e) => {
      if (window.isTauriHost?.() && window.openExternalUrl) {
        e.preventDefault();
        void window.openExternalUrl(viewUrl);
      }
    };
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
        ${run.stderr ? `<pre style="max-height:140px;overflow:auto;font-size:.78rem;${run.status === 'error' ? 'background:color-mix(in srgb, var(--danger) 11%, var(--bg));color:var(--danger);border:1px solid color-mix(in srgb, var(--danger) 30%, transparent);' : 'background:var(--bg);color:var(--muted);'}padding:8px;border-radius:8px;margin:6px 0 0;">${esc(run.stderr)}</pre>` : ''}
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

  window.openAppSlash = async (args, cwd, isCurrent) => {
    const [sub, id, actionId] = args.split(/\s+/);
    if (!sub || /^(?:등록|add)$/i.test(sub)) return showAppFormModal(null, { cwd, fromSlash: true });
    if (/^(?:가져오기|import)$/i.test(sub)) {
      return showAppFormModal(null, { cwd: args.slice(sub.length).trim() || cwd, importOnly: true, fromSlash: true });
    }
    if (!/^(?:실행|run)$/i.test(sub)) throw new Error('/app add, /app import, /app run ID 중 하나를 사용하세요.');
    if (!id) return select({ kind: 'apps' });
    const apps = await fetchApps();
    if (!isCurrent()) return;
    const app = apps.find(item => item.id === id);
    if (!app) throw new Error('등록된 앱을 찾을 수 없습니다.');
    const action = actionId ? app.actions?.find(item => item.id === actionId) : app.actions?.[0];
    if (!action) throw new Error('실행할 앱 작업을 찾을 수 없습니다.');
    if (action.params?.length) return select({ kind: 'apps', id });
    const { run } = await api(`/api/apps/${encodeURIComponent(id)}/run`, {
      method: 'POST', body: { actionId: action.id, params: {} }, requireOk: true,
    });
    if (run.status === 'error') throw new Error(run.stderr || '앱을 실행할 수 없습니다.');
    toast(`${app.name} 실행을 시작했습니다`);
  };

  // install-time settings of a store app (app.json "settings"): one input per setting
  function settingsFields(list, values = {}) {
    if (!Array.isArray(list) || !list.length) return '';
    return `<fieldset class="ast-settings"><legend>설치 설정</legend>${list.map((s) => {
      const v = values[s.key] ?? s.default ?? '';
      const id = `set_${s.key}`;
      const input = s.type === 'bool'
        ? `<select id="${id}" data-setting="${esc(s.key)}"><option value="0" ${v === '1' ? '' : 'selected'}>아니요</option><option value="1" ${v === '1' ? 'selected' : ''}>예</option></select>`
        : `<input id="${id}" data-setting="${esc(s.key)}" type="${s.type === 'secret' ? 'password' : s.type === 'number' ? 'number' : 'text'}" value="${esc(v)}" ${s.required ? 'required' : ''} autocomplete="off" spellcheck="false">`;
      return `<label for="${id}"><span>${esc(s.label)}${s.required ? ' <b aria-hidden="true">*</b>' : ''}</span>${input}
        ${s.description ? `<small>${esc(s.description)}</small>` : ''}</label>`;
    }).join('')}<p class="ums">값은 이 허브의 앱 설정에만 저장되고 패키지나 저장소로 나가지 않습니다.</p></fieldset>`;
  }
  function readSettingsFields(root) {
    const out = {};
    root.querySelectorAll('[data-setting]').forEach((el) => { out[el.dataset.setting] = el.value; });
    return out;
  }
  function showAppSettings(app, onSaved) {
    openModal(`설정: ${app.name}`, `<form>${settingsFields(app.settings, app.env || {})}
      <div class="row" style="justify-content:flex-end;gap:8px"><button type="button" data-close>취소</button><button class="primary">저장</button></div>
      <p role="alert"></p></form>`, (wrap, close) => {
      const form = $('form', wrap);
      form.onsubmit = async (e) => {
        e.preventDefault();
        try {
          const r = await api(`/api/apps/${encodeURIComponent(app.id)}`, { method: 'PUT', body: { settingValues: readSettingsFields(form) }, requireOk: true });
          close();
          toast(r.restartRequired ? '저장했습니다. 플러그인 설정은 허브를 다시 시작하면 적용됩니다.' : '설정을 저장했습니다', 5000);
          onSaved?.(r.app);
        } catch (er) { $('p[role="alert"]', form).textContent = er.message; }
      };
    });
  }
  window.appStoreHelpers = { settingsFields, readSettingsFields, showAppSettings, openModal, statusBadge: (s) => statusBadge(s),
    install: (...a) => showStorePackage(...a), sources: () => showAppStore() };

  function showStorePackage(entry, onInstalled, { update = false } = {}) {
    openModal('설치 내용 확인', '<p>릴리스 ZIP 확인 중…</p>', async (dialog, close) => {
      const body = $('.m-body', dialog);
      const endpoint = '/api/apps-store/package';
      try {
        const { package: pkg } = await api(endpoint, { method: 'POST', body: { key: entry.key }, requireOk: true });
        if (!dialog.isConnected) return;
        body.innerHTML = `<p><b>${esc(pkg.name)}</b> · ${esc(pkg.version)}${pkg.author ? ` · ${esc(pkg.author)}` : ''}
          ${pkg.verified ? '<span class="badge">레지스트리 검증됨</span>' : ''}<br>
          <span class="ums">출처</span> <code>${esc(pkg.repo)}</code>
          ${pkg.commit ? `<br><span class="ums">커밋</span> <code>${esc(pkg.commit.slice(0, 12))}</code>${pkg.dirty ? ' <span class="badge">커밋되지 않은 변경 포함</span>' : ''}` : ''}
          <br><span class="ums">SHA-256</span> <code style="font-size:.75em">${esc(pkg.digest.slice(7, 23))}…</code></p>
          <p>${esc(pkg.description)}</p>
          ${pkg.url ? `<p>${esc(pkg.url)}</p>` : ''}
          ${pkg.actions.map(a => `<details><summary>${esc(a.label)}</summary><pre class="mdpre">${esc([a.cmd, a.prompt].filter(Boolean).join('\n'))}</pre></details>`).join('')}
          ${pkg.hubPlugin ? `<p class="ums">허브 플러그인 <code>${esc(pkg.hubPlugin)}</code>을 함께 설치합니다 (허브를 다시 시작하면 켜집니다).</p>` : ''}
          ${settingsFields(pkg.settings, pkg.currentSettings || {})}
          <p class="ums">${pkg.hasSetup ? '설치를 누르면 초기 환경 구성(<code>setup.ps1</code>)이 앱 폴더 안에서 실행됩니다.' : '설치 후 사용자가 실행을 선택하면 앱 명령이 이 PC의 앱 폴더에서 실행됩니다.'}</p>
          <p role="alert"></p><button type="button" class="primary" data-store-install>${update ? '업데이트' : '설치'}</button>`;
        const install = $('[data-store-install]', body);
        install.onclick = async () => {
          install.disabled = true;
          install.textContent = pkg.hasSetup ? '설치 및 환경 구성 시작 중…' : '설치 중…';
          try {
            const res = await api(endpoint, { method: 'POST', body: { key: entry.key, digest: pkg.digest, settings: readSettingsFields(body), update }, requireOk: true });
            close();
            if (typeof onInstalled === 'function' && onInstalled.length) return onInstalled(res.package);
            if (res.package?.restartRequired) toast(`${pkg.name}: 허브 플러그인을 설치했습니다. 허브를 다시 시작하면 켜집니다.`, 7000);
            if (res.package?.setupRun) {
              toast(`${pkg.name} 설치 완료 — 초기 환경 구성을 진행 중입니다…`, 5000);
              document.querySelectorAll('.modal-bg').forEach((m) => m.remove());
              viewApps(res.package.id);
              return;
            }
            onInstalled();
          } catch (error) {
            $('p[role="alert"]', body).textContent = error.message;
            install.disabled = false;
            install.textContent = update ? '업데이트' : '설치';
          }
        };
      } catch (error) { body.textContent = error.message; }
    });
  }

  function showAppStore() {
    openModal('앱 스토어', `<div class="row" style="flex-wrap:wrap">
      <input type="search" data-store-search aria-label="스토어 검색" placeholder="앱 또는 저장소 검색">
      <button type="button" data-store-add>스토어 소스 추가</button>
      <a class="btnlike btn-sm" href="https://github.com/JaekunE2/agent-cli-hub/blob/dev_side/hub/app-catalog.json" target="_blank" rel="noopener">공용 카탈로그</a>
      </div><p class="ums" data-store-status role="status"></p>
      <details><summary>등록한 소스</summary><div data-store-sources></div></details>
      <div data-store-list role="region" aria-label="스토어 앱"></div>`, (dialog) => {
      const search = $('[data-store-search]', dialog);
      const list = $('[data-store-list]', dialog);
      const sources = $('[data-store-sources]', dialog);
      const status = $('[data-store-status]', dialog);
      let entries = [];
      let submitUrls = [];
      const paint = () => {
        const filter = search.value.trim().toLowerCase();
        const matches = entries.filter(item => [item.name, item.repo, item.description].some(value => value.toLowerCase().includes(filter)));
        list.innerHTML = matches.map(item => `<article class="rcard">
          <div class="row" style="justify-content:space-between;flex-wrap:wrap">
            <strong>${esc(item.name)}</strong>
            ${item.installed ? `<span class="badge">설치됨 · ${esc(item.installed)}</span>` : `<button type="button" data-store-key="${esc(item.key)}">설치 확인</button>`}
          </div><div class="ums">${esc(item.repo)}</div>${item.description ? `<p>${esc(item.description)}</p>` : ''}
        </article>`).join('') || '<p class="empty">표시할 스토어 앱이 없습니다.</p>';
      };
      const refresh = async () => {
        try {
          const result = await api('/api/apps-store', { requireOk: true });
          entries = result.entries || [];
          status.textContent = (result.unavailable || []).length
            ? '스토어 소스 확인 실패: ' + result.unavailable.join(', ') : '';
          submitUrls = result.submitUrls || [];
          sources.innerHTML = (result.sources || []).map(item => {
            const source = esc(item.owner || item.repo || item.path);
            return `<div class="row"><span>${source}</span><button type="button" class="ghost btn-sm" data-store-remove="${source}">제거</button></div>`;
          }).join('');
          paint();
        } catch (error) { list.textContent = error.message; }
      };
      search.oninput = paint;
      list.onclick = (event) => {
        const key = event.target.closest('[data-store-key]')?.dataset.storeKey;
        const entry = entries.find(item => item.key === key);
        if (entry) showStorePackage(entry, () => { refresh(); if (state.sel.kind === 'apps') viewApps(); });
      };
      sources.onclick = async (event) => {
        const button = event.target.closest('[data-store-remove]');
        if (!button) return;
        button.disabled = true;
        try {
          await api('/api/apps-store/source', { method: 'DELETE', body: { source: button.dataset.storeRemove }, requireOk: true });
          await refresh();
        } catch (error) { status.textContent = error.message; button.disabled = false; }
      };
      $('[data-store-add]', dialog).onclick = () => openModal('스토어 소스 추가',`<form class="row" style="flex-wrap:wrap">
        <label>사용자·조직, 저장소 주소 또는 로컬 폴더 <input name="source" placeholder="https://github.com/owner, D:\apps, file:///D:/apps" required></label>
        <p class="ums"><code>agent-cli-hub-app</code> 토픽이 붙은 공개 저장소를 찾습니다. 로컬 폴더는 <code>catalog.json</code>(또는 <code>app.json</code>)을 읽습니다.</p>
        <button class="primary">추가</button><p role="alert"></p></form>`, (wrap, close) => {
        const form = $('form', wrap);
        form.onsubmit = async (event) => {
          event.preventDefault();
          const submit = $('button', form);
          submit.disabled = true;
          try {
            const value = form.elements.source.value.trim();
            await api('/api/apps-store/source', { method: 'POST', body: { source: value }, requireOk: true });
            close();
            refresh();
            // a single app repo: offer to submit it to the public registry (a prefilled GitHub issue)
            const repo = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/?$/i.exec(value)?.[1];
            if (repo && submitUrls.length) {
              const link = `${submitUrls[0]}${submitUrls[0].includes('?') ? '&' : '?'}repo=${encodeURIComponent('https://github.com/' + repo)}`;
              openModal('공용 레지스트리에 등록', `<p>${esc(repo)}을(를) 이 허브의 스토어 소스에 추가했습니다.</p>
                <p>다른 사람의 허브에도 보이게 하려면 공용 레지스트리에 등록 요청을 보내세요. GitHub 이슈 양식이 열리고, 검증 후 카탈로그에 추가됩니다.</p>
                <a class="btnlike primary" href="${esc(link)}" target="_blank" rel="noopener">공용 레지스트리에 제출</a>`);
            }
          } catch (error) {
            $('p[role="alert"]', form).textContent = error.message;
            submit.disabled = false;
          }
        };
      });
      refresh();
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
      <button type="button" class="btn-sm" id="btnAppStore">앱 스토어</button>
      <button type="button" class="primary btn-sm" id="btnNewApp">${ICO.plus} 앱 추가</button>`);
    $('#view').innerHTML = '<div id="appsBody" style="padding:12px 16px 40px;">불러오는 중…</div>';
    const body = $('#appsBody');
    $('#btnNewApp').onclick = () => showAppFormModal();
    $('#btnAppStore').onclick = () => (window.viewAppStore ? window.viewAppStore() : showAppStore());
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
