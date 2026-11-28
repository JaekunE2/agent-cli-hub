const workspaceRegistry = '/api/trusted-folders';
let workspacePanel;

async function workspaceRequest(path, options) {
  const result = await api(path, options);
  if (!result.error) return result;
  const labels = {
    INVALID_FOLDER: '서버의 기존 로컬 폴더 경로를 입력하세요.',
    REVISION_CONFLICT: '다른 곳에서 설정을 변경했습니다. 새로고침 후 다시 시도하세요.',
    FOLDER_EXISTS: '이미 등록된 신뢰 폴더입니다.',
    FOLDER_CHANGED: '폴더가 변경됐습니다. 해제 후 다시 등록하세요.',
    LOCAL_REQUIRED: '이 PC에서 허브를 열어 폴더를 관리하세요.',
    SESSION_READ_ONLY: '읽기 전용 세션입니다.',
    SESSION_NOT_FOUND: '이 세션을 찾을 수 없습니다.',
    SESSION_AMBIGUOUS: '연결된 세션이 여러 개라 편집할 수 없습니다.',
  };
  throw new Error(labels[result.code] || result.error);
}

function workspaceChanged() {
  return Promise.all([refreshOverview(), refreshRecent()]);
}

function closeWorkspacePanel() { workspacePanel?.close(); }

document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-workspace-folder]');
  if (!button) return;
  event.stopPropagation();
  void openWorkspacePanel(button);
}, true);

async function openWorkspacePanel(button) {
  closeWorkspacePanel();
  const { workspaceFolder: key, folderPrimary, folderReadOnly } = button.dataset;
  const request = new AbortController();
  const drawer = workspacePanel = openDrawer({ title: '세션 폴더', width: 500, focus: true,
    bodyHTML: `<p role="alert" data-folder-error></p><div data-folder-detail></div><div data-folder-editor></div>`,
    onClose() { request.abort(); workspacePanel = null; } });
  const detail = $('[data-folder-detail]', drawer);
  const error = $('[data-folder-error]', drawer);
  let busy = false;
  async function run(control, action) {
    if (busy) return;
    busy = control.disabled = true;
    error.textContent = '';
    try { await action(); }
    catch (err) { if (!request.signal.aborted) error.textContent = err.message; }
    finally { busy = control.disabled = false; }
  }
  const endpoint = folderEndpoint(key);
  const load = () => workspaceRequest(endpoint, { signal: request.signal });
  function show(folders) {
    if (request.signal.aborted) return;
    const editable = folderReadOnly !== 'true' && folders.editable;
    paintWorkspaceDetail(detail, folders, editable);
    if (!editable) return;
    workspaceFolderEditor($('[data-folder-editor]', drawer), folders, run, async (body) => {
      show(await workspaceRequest(endpoint, { method: 'PUT', body }));
      await workspaceChanged();
    });
  }
  detail.onclick = (event) => {
    const trust = event.target.closest('[data-approve-folder]');
    if (!trust) return;
    void run(trust.closest('fieldset'), async () => {
      const { revision } = await workspaceRequest(workspaceRegistry, { signal: request.signal });
      if (request.signal.aborted) return;
      await workspaceRequest(workspaceRegistry, { method: 'POST',
        body: { path: trust.dataset.approveFolder, revision, includeDescendants: false } });
      const refreshed = workspaceChanged();
      if (!request.signal.aborted) paintWorkspaceDetail(detail, await load(), true);
      await refreshed;
    });
  };
  detail.textContent = '폴더 정보를 불러오는 중…';
  await run(detail, async () => {
    if (key) show(await load());
    else show({ primaryCwd: folderPrimary, referenceDirs: [], trustSummary: { state: 'unknown', refs: [] } });
  });
  if (error.textContent) detail.textContent = '';
}
