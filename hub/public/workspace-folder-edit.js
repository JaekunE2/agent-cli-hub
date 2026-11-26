function workspaceFolderEditor(host, folders, run, save) {
  const paths = [...folders.referenceDirs];
  const browse = desktopBridge ? '<button type="button" data-folder-pick>폴더 선택</button>' : '';
  host.innerHTML = `<form class="folder-editor"><fieldset class="folder-fields">
    <label>주 폴더<input data-folder-main value="${esc(folders.primaryCwd)}"></label>
    ${browse}
    <label>참조 폴더 경로<input data-folder-ref></label>
    ${browse}<button type="button" data-folder-add>참조 추가</button>
    <ul data-folder-draft></ul>
    <button class="primary">폴더 설정 저장</button>
  </fieldset></form>`;
  const form = $('form', host);
  const fields = $('fieldset', form);
  const primary = $('[data-folder-main]', form);
  const reference = $('[data-folder-ref]', form);
  const list = $('[data-folder-draft]', form);
  const addButton = $('[data-folder-add]', form);
  function paint() {
    list.innerHTML = paths.map((path, index) => `<li><span>${esc(path)}</span>
      <button type="button" class="ghost btn-sm" data-folder-remove="${index}" aria-label="${esc('참조 제거' + ' · ' + path)}">참조 제거</button></li>`).join('');
    addButton.disabled = paths.length >= 16;
    reference.disabled = addButton.disabled;
    const referencePicker = form.querySelectorAll('[data-folder-pick]')[1];
    if (referencePicker) referencePicker.disabled = addButton.disabled;
  }
  function add(path) {
    if (!path.trim() || paths.length >= 16) return;
    if (!paths.includes(path)) paths.push(path);
    reference.value = '';
    paint();
  }
  reference.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    add(reference.value);
  });
  form.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (button?.matches('[data-folder-add]')) add(reference.value);
    if (button?.matches('[data-folder-remove]')) {
      paths.splice(Number(button.dataset.folderRemove), 1);
      paint();
      reference.focus();
    }
    if (button?.matches('[data-folder-pick]')) void run(fields, async () => {
      const isPrimary = button === $('[data-folder-pick]', form);
      const selected = await desktopBridge.pickFolder(primary.value || null);
      if (!selected || !form.isConnected) return;
      if (isPrimary) primary.value = selected;
      else add(selected);
    });
  });
  form.onsubmit = (event) => {
    event.preventDefault();
    add(reference.value);
    void run(fields, () => save({ primaryCwd: primary.value.trim() ? primary.value : null,
      referenceDirs: paths, revision: folders.revision }));
  };
  paint();
}
