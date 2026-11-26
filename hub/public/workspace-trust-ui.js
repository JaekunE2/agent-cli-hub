function viewTrustedFolders() {
  setBar('<h2>설정</h2>');
  const view = $('#view');
  view.innerHTML = `<div class="sys-shell">${systemTopHTML('trusted-folders')}
    <div class="sys-body"><section class="page-wrap folder-settings"><h2>신뢰 폴더</h2>
    ${localFolderUI() ? `<p role="alert" data-folder-error></p>
      <form><fieldset class="folder-fields" disabled>
        <label>신뢰할 폴더 경로<input name="path" required></label>
        <label><input type="checkbox" name="includeDescendants"> 하위 폴더도 신뢰</label>
        <button class="primary">신뢰 폴더 등록</button>
      </fieldset></form>
      <button type="button" class="ghost" data-folder-refresh>새로고침</button>
      <fieldset class="folder-fields" data-trust-list></fieldset>` : '<p>이 PC에서 허브를 열어 폴더를 관리하세요.</p>'}
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
  const reload = $('[data-folder-refresh]', root);
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
