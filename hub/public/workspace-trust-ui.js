function viewTrustedFolders() {
  setBar('');
  const view = $('#view');
  view.innerHTML = `<div class="sys-shell">${systemTopHTML('trusted-folders', localFolderUI() ? '<button type="button" class="ghost btn-sm" data-folder-refresh>새로고침</button>' : '')}
    <div class="sys-body"><section class="page-wrap folder-settings">
    <div class="page-hd"><div class="page-hd-left"><h1>신뢰 폴더</h1><span class="ums">에이전트가 작업·참조할 수 있도록 허용된 로컬 폴더 목록입니다.</span></div></div>
    ${localFolderUI() ? `<p role="alert" data-folder-error></p>
      <div class="rcard">
        <form><fieldset class="folder-fields" style="margin:0" disabled>
          <label>신뢰할 폴더 경로
            <div class="fp-input-row">
              <input name="path" placeholder="예: D:\\Gitsource\\project" required>
              <button type="button" class="btn-sm" data-trust-pick>폴더 선택</button>
            </div>
          </label>
          <div class="row" style="justify-content:space-between;margin-top:8px">
            <label class="row" style="margin:0;cursor:pointer"><input type="checkbox" name="includeDescendants"> 하위 폴더도 신뢰</label>
            <button class="primary">신뢰 폴더 등록</button>
          </div>
        </fieldset></form>
      </div>
      <div class="sheet">
        <div class="sheet-hd"><h3>등록된 신뢰 폴더</h3></div>
        <fieldset class="folder-fields" style="margin:0;padding:8px 14px" data-trust-list></fieldset>
      </div>` : '<div class="h-empty-card"><b>로컬 PC에서만 관리할 수 있습니다</b><span class="ums">이 PC에서 허브를 열어 폴더를 관리하세요.</span></div>'}
    </section></div></div>`;
  const root = $('.folder-settings', view);
  view.onclick = (event) => {
    const tab = event.target.closest('[data-systab]');
    if (tab && tab.dataset.systab !== 'trusted-folders') select({ kind: tab.dataset.systab });
  };
  if (!localFolderUI()) return;
  const form = $('form', root);
  const fields = $('fieldset', form);
  const error = $('[data-folder-error]', root);
  const list = $('[data-trust-list]', root);
  const reload = $('[data-folder-refresh]', view);
  const pickBtn = $('[data-trust-pick]', root);
  if (pickBtn) {
    pickBtn.onclick = async () => {
      if (typeof desktopBridge?.pickFolder === 'function') {
        const picked = await desktopBridge.pickFolder(form.elements.path.value || null);
        if (picked) { form.elements.path.value = picked; return; }
      }
      if (typeof openFolderPickerDialog === 'function') {
        openFolderPickerDialog(form.elements.path.value.trim(), (chosen) => { if (chosen) form.elements.path.value = chosen; });
      }
    };
  }
  let registry, busy = false;
  const paint = () => {
    if (!registry) return;
    list.innerHTML = registry.items.length ? `<ul>${registry.items.map((item) => `<li><span>${esc(item.path)}</span>
      <label><input type="checkbox" data-trust-desc="${esc(item.id)}" ${item.includeDescendants ? 'checked' : ''}> 하위 폴더도 신뢰</label>
      <button type="button" class="ghost btn-sm" data-trust-remove="${esc(item.id)}">신뢰 해제</button></li>`).join('')}</ul>`
      : '<p>등록된 신뢰 폴더 없음</p>';
  };
  async function run(action) {
    if (busy) return;
    busy = fields.disabled = list.disabled = reload.disabled = true;
    error.textContent = '';
    try { await action(); }
    catch (err) { error.textContent = err.message; }
    finally { paint(); busy = list.disabled = reload.disabled = false; fields.disabled = !registry; }
  }
  const load = () => run(async () => { registry = await workspaceRequest(workspaceRegistry); });
  const change = (id, method, body) => run(async () => {
    const route = id ? `${workspaceRegistry}/${encodeURIComponent(id)}` : workspaceRegistry;
    const result = await workspaceRequest(route, { method, body: { ...body, revision: registry.revision } });
    registry = result.item ? { items: [...registry.items, result.item], revision: result.revision } : result;
    if (method === 'POST') form.reset();
    await workspaceChanged();
  });
  form.onsubmit = (event) => {
    event.preventDefault();
    void change('', 'POST', { path: form.elements.path.value, includeDescendants: form.elements.includeDescendants.checked });
  };
  list.onchange = (event) => void change(event.target.dataset.trustDesc, 'PATCH', { includeDescendants: event.target.checked });
  list.onclick = (event) => {
    const id = event.target.closest('[data-trust-remove]')?.dataset.trustRemove;
    if (id) void change(id, 'DELETE');
  };
  reload.onclick = load;
  void load();
}
