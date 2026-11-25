// ---------- Project Reference Data Repository Tab ----------
function formatRefBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v}B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)}KB`;
  return `${(v / (1024 * 1024)).toFixed(1)}MB`;
}

async function projectRefsView(project, gen) {
  const host = $('#projectContent');
  if (!host || !project?.id) return;
  const ico = window.UI_ICO || {};
  host.innerHTML = '<div class="empty">산출물을 불러오는 중…</div>';

  const authTok = () => (typeof TOKEN !== 'undefined' ? TOKEN : (window.TOKEN || ''));
  const scope = { projectId: project.id, version: project.scope?.number || '' };
  const query = new URLSearchParams(scope);
  const fileUrl = (name) => `/api/projects/refs/file?${query}&name=${encodeURIComponent(name)}&t=${encodeURIComponent(authTok())}&_t=${Date.now()}`;

  const uploadFileObj = async (file) => {
    const b64 = await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result || ''));
      fr.onerror = () => reject(new Error('파일을 읽지 못했습니다'));
      fr.readAsDataURL(file);
    });
    const r = await api('/api/projects/refs', {
      method: 'POST',
      body: { ...scope, name: file.name, contentBase64: b64 },
    });
    if (r?.error) throw new Error(r.error);
    return r;
  };

  const paint = (data) => {
    if (gen !== viewGen || !host.isConnected) return;
    const dir = data?.dir || '';
    const files = Array.isArray(data?.files) ? data.files : [];
    const cardsHTML = files.length
      ? `<div class="pj-refs-grid">${files.map((f) => {
          const thumb = f.isImage
            ? `<img class="pj-ref-thumb" src="${fileUrl(f.name)}" alt="${esc(f.name)}">`
            : `<span class="pj-ref-ext">${esc((f.ext || '.file').replace(/^\./, ''))}</span>`;
          return `<div class="pj-ref-card">
            ${thumb}
            <div class="pj-ref-info">
              <div class="pj-ref-name" title="${esc(f.path)}">${esc(f.name)}</div>
              <div class="pj-ref-meta">${formatRefBytes(f.size)} · ${new Date(f.mtime).toLocaleString(uiLocale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
            </div>
            <div class="pj-ref-acts">
              <button type="button" class="ghost icon-btn btn-sm" data-ref-copy="${esc(f.path)}" title="절대 경로 복사">${ico.copy || ''}</button>
              ${f.isImage || f.ext === '.pdf'
                ? `<a class="ghost icon-btn btn-sm" href="${fileUrl(f.name)}" target="_blank" rel="noopener" title="새 창에서 보기">${ico.external || ''}</a>`
                : `<button type="button" class="ghost icon-btn btn-sm" data-ref-view="${esc(f.name)}" data-ref-ext="${esc(f.ext)}" title="미리보기">${ico.eye || ico.external || ''}</button>`}
              <button type="button" class="ghost icon-btn btn-sm" data-ref-del="${esc(f.name)}" title="삭제" style="color:var(--danger)">${ico.trash || ''}</button>
            </div>
          </div>`;
        }).join('')}</div>`
      : '<div class="pj-empty"><p>아직 저장된 참조 파일이 없습니다. 파일·이미지를 업로드하거나 메모를 추가하면 모든 태스크가 자동으로 참조합니다.</p></div>';

    host.innerHTML = `<div class="pj-refs">
      <div class="pj-refs-bar">
        <code class="pj-refs-path" title="${esc(dir)}">${esc(dir)}</code>
        <div class="row" style="gap:6px">
          <button type="button" class="btn-sm" id="refCopyDir">${ico.copy || ''} 경로 복사</button>
          ${!IS_REMOTE ? `<button type="button" class="btn-sm" id="refOpenDir">${ico.folder || ''} 폴더 열기</button>` : ''}
        </div>
      </div>
      <div class="pj-refs-drop" id="refDrop">
        <input type="file" id="refFileInput" multiple style="display:none">
        <button type="button" class="primary btn-sm" id="refPickBtn">${ico.plus || ''} 파일 · 이미지 업로드</button>
        <span class="ums" style="margin:0">또는 여기에 파일을 끌어다 놓으세요 (최대 25MB)</span>
      </div>
      <details class="pj-refs-note">
        <summary>+ 텍스트 · 마크다운 레퍼런스 직접 작성</summary>
        <div class="pj-refs-note-form">
          <input id="refNoteName" maxlength="100" placeholder="파일명 (예: api-spec.md, rules.txt)">
          <textarea id="refNoteText" rows="4" placeholder="참조할 명세, 데이터, 프롬프트 컨텍스트를 입력하세요"></textarea>
          <div class="row" style="justify-content:flex-end">
            <button type="button" class="primary btn-sm" id="refNoteSave">저장소에 추가</button>
          </div>
        </div>
      </details>
      ${cardsHTML}
    </div>`;

    $('#refCopyDir', host).onclick = () => copyText(dir);
    $('#refOpenDir', host)?.addEventListener('click', () => {
      api('/api/fs/open-dir', { method: 'POST', body: { path: dir } }).catch((e) => toast(e.message, 4000, 'danger'));
    });
    const fin = $('#refFileInput', host);
    $('#refPickBtn', host).onclick = () => fin.click();
    fin.onchange = async () => {
      if (!fin.files?.length) return;
      try {
        let last = null;
        for (const f of fin.files) last = await uploadFileObj(f);
        if (last) paint(last);
        toast(`참조 파일 ${fin.files.length}개를 저장했습니다`);
      } catch (e) { toast(e.message, 5000, 'danger'); }
    };
    const dz = $('#refDrop', host);
    dz.ondragover = (e) => { e.preventDefault(); dz.classList.add('over'); };
    dz.ondragleave = () => dz.classList.remove('over');
    dz.ondrop = async (e) => {
      e.preventDefault();
      dz.classList.remove('over');
      const files = [...(e.dataTransfer?.files || [])];
      if (!files.length) return;
      try {
        let last = null;
        for (const f of files) last = await uploadFileObj(f);
        if (last) paint(last);
        toast(`참조 파일 ${files.length}개를 저장했습니다`);
      } catch (er) { toast(er.message, 5000, 'danger'); }
    };
    $('#refNoteSave', host).onclick = async () => {
      const name = ($('#refNoteName', host).value || '').trim() || `note-${Date.now().toString(36)}.md`;
      const text = $('#refNoteText', host).value || '';
      if (!text.trim()) return toast('내용을 입력하세요');
      try {
        const r = await api('/api/projects/refs', { method: 'POST', body: { ...scope, name, text } });
        if (r?.error) throw new Error(r.error);
        paint(r);
        toast('참조 텍스트를 저장했습니다');
      } catch (er) { toast(er.message, 5000, 'danger'); }
    };
    host.querySelectorAll('[data-ref-copy]').forEach((btn) => {
      btn.onclick = () => copyText(btn.dataset.refCopy);
    });
    host.querySelectorAll('[data-ref-view]').forEach((btn) => {
      btn.onclick = async () => {
        const nm = btn.dataset.refView;
        const ext = (btn.dataset.refExt || '').replace(/^\./, '').toLowerCase() || 'text';
        try {
          const r = await fetch(fileUrl(nm), { headers: { 'x-token': authTok() } });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const code = await r.text();
          if (window.ACH_PREVIEW?.openCodeModal) {
            window.ACH_PREVIEW.openCodeModal({ title: nm, lang: ext, code });
          } else {
            window.open(fileUrl(nm), '_blank', 'noopener');
          }
        } catch (er) { toast(er.message, 4000, 'danger'); }
      };
    });
    host.querySelectorAll('[data-ref-del]').forEach((btn) => {
      btn.onclick = async () => {
        const nm = btn.dataset.refDel;
        if (!confirm(`참조 파일 "${nm}"을(를) 삭제할까요?`)) return;
        const r = await api('/api/projects/refs', { method: 'DELETE', body: { ...scope, name: nm } });
        if (r?.error) return toast(r.error, 4000, 'danger');
        paint({ dir, files: r.files });
      };
    });
  };

  try {
    const r = await api(`/api/projects/refs?${query}`);
    if (r?.error) throw new Error(r.error);
    paint(r);
  } catch (e) {
    if (gen === viewGen) host.innerHTML = `<div class="err">${esc(e.message)}</div>`;
  }
}
