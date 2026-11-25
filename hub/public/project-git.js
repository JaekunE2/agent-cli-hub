// ---------- Read-only Project Git Metro Map & Diff Inspector ----------
async function projectGitView(p, gen) {
  const host = $('#projectContent');
  if (!host) return;
  host.innerHTML = '<div class="empty">Git 상태를 불러오는 중…</div>';
  try {
    const r = await api(`/api/projects/git?id=${encodeURIComponent(p.id)}`);
    if (gen !== viewGen || !host.isConnected) return;
    if (!r.ok) {
      host.innerHTML = `<div class="pj-empty"><p>${esc(r.error || 'Git 정보를 불러올 수 없습니다.')}</p></div>`;
      return;
    }

    const fileGroup = (title, items, opts) => {
      if (!items?.length) return '';
      return `<div class="pg-group">
        <div class="pg-group-hd"><span>${esc(title)}</span><span class="badge">${items.length}</span></div>
        <div class="pg-files">${items.map((f) => `<button type="button" class="pg-file-btn" data-pg-file="${esc(f.path)}" data-pg-staged="${opts.staged ? '1' : '0'}" data-pg-untracked="${opts.untracked ? '1' : '0'}">
          <span class="pg-st st-${esc(f.status === '?' ? 'u' : f.status.toLowerCase())}">${esc(f.status)}</span>
          <code class="pg-fpath">${esc(f.path)}</code>
        </button>`).join('')}</div>
      </div>`;
    };

    const wtHtml = (r.worktrees || []).map((wt) => `<span class="badge${wt.branch === r.branch ? ' c' : ''}" title="${esc(wt.path)}">
      ${esc(wt.branch || wt.head || 'detached')} · ${esc(base(wt.path))}
    </span>`).join('');

    const commitsHtml = (r.commits || []).map((c) => `<div class="pg-commit">
      <code class="pg-hash">${esc(c.short)}</code>
      <span class="pg-subj">${esc(c.subject)}</span>
      ${(c.refs || []).map((ref) => `<span class="badge">${esc(ref)}</span>`).join('')}
      <span class="ums">${esc(c.author)}</span>
    </div>`).join('');

    const hasChanges = (r.staged?.length || 0) + (r.unstaged?.length || 0) + (r.untracked?.length || 0) > 0;

    host.innerHTML = `<div class="pg-wrap">
      <div class="pg-top">
        <div class="row" style="gap:8px;flex-wrap:wrap">
          <span class="badge c">${ICO.branch || ''} ${esc(r.branch || 'HEAD')}</span>
          ${r.upstream ? `<span class="ums">← ${esc(r.upstream)} (↑${r.ahead || 0} ↓${r.behind || 0})</span>` : ''}
          ${wtHtml}
        </div>
        <button type="button" class="btn-sm" id="pgRefresh">새로고침</button>
      </div>
      <div class="pg-grid">
        <section class="pg-card">
          <h4>브랜치 노선도 (Metro Map)</h4>
          <div id="pgGraph" class="pg-graph"><div class="ums">렌더링 중…</div></div>
          <div class="pg-commits">${commitsHtml || '<div class="ums">커밋 이력이 없습니다.</div>'}</div>
        </section>
        <section class="pg-card">
          <h4>작업 트리 변경분 (읽기 전용)</h4>
          <div class="pg-changes">
            ${hasChanges
              ? fileGroup('Staged', r.staged, { staged: true })
                + fileGroup('Unstaged', r.unstaged, { staged: false })
                + fileGroup('Untracked', r.untracked, { untracked: true })
              : '<div class="ums">워킹 트리가 깨끗합니다 (변경 사항 없음).</div>'}
          </div>
          <div class="pg-diff-box" id="pgDiffBox" hidden>
            <div class="pg-diff-hd"><code id="pgDiffFile"></code><button type="button" class="ghost btn-sm" id="pgDiffClose">${ICO.close}</button></div>
            <pre class="pg-diff-pre" id="pgDiffPre"></pre>
          </div>
        </section>
      </div>
    </div>`;

    $('#pgRefresh', host)?.addEventListener('click', () => projectGitView(p, gen));

    const graphEl = $('#pgGraph', host);
    if (r.mermaid && typeof ensureMermaid === 'function') {
      ensureMermaid().then((mm) => {
        if (!graphEl.isConnected || gen !== viewGen) return;
        mm.render(`pg-mm-${Date.now()}`, r.mermaid).then((res) => {
          if (graphEl.isConnected) graphEl.innerHTML = res.svg;
        }).catch(() => { graphEl.innerHTML = '<div class="ums">그래프 미리보기를 표시할 수 없습니다.</div>'; });
      }).catch(() => { if (graphEl.isConnected) graphEl.innerHTML = ''; });
    } else if (graphEl) {
      graphEl.innerHTML = '';
    }

    const diffBox = $('#pgDiffBox', host);
    const diffFile = $('#pgDiffFile', host);
    const diffPre = $('#pgDiffPre', host);
    $('#pgDiffClose', host)?.addEventListener('click', () => { diffBox.hidden = true; });

    host.querySelectorAll('[data-pg-file]').forEach((btn) => {
      btn.onclick = async () => {
        host.querySelectorAll('.pg-file-btn.on').forEach((b) => b.classList.remove('on'));
        btn.classList.add('on');
        const file = btn.dataset.pgFile;
        const staged = btn.dataset.pgStaged === '1';
        const untracked = btn.dataset.pgUntracked === '1';
        diffBox.hidden = false;
        diffFile.textContent = `${file}${staged ? ' (staged)' : untracked ? ' (untracked)' : ''}`;
        diffPre.textContent = 'Diff 불러오는 중…';
        try {
          const qs = new URLSearchParams({
            id: p.id,
            file,
            ...(staged ? { staged: '1' } : {}),
            ...(untracked ? { untracked: '1' } : {}),
          });
          const dr = await api(`/api/projects/git?${qs}`);
          if (!diffPre.isConnected) return;
          const lines = String(dr.diff || '(변경 내용 없음)').split('\n');
          diffPre.innerHTML = lines.map((line) => {
            const cls = line.startsWith('+') && !line.startsWith('+++')
              ? 'pg-dl-add'
              : line.startsWith('-') && !line.startsWith('---')
                ? 'pg-dl-del'
                : line.startsWith('@@')
                  ? 'pg-dl-hunk'
                  : '';
            return `<div class="${cls}">${esc(line)}</div>`;
          }).join('');
        } catch (err) {
          diffPre.textContent = err.message;
        }
      };
    });
  } catch (e) {
    if (host.isConnected) host.innerHTML = `<div class="err">${esc(e.message)}</div>`;
  }
}
