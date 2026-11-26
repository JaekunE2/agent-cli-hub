const folderStateLabel = (value) => ({ trusted: '신뢰됨', untrusted: '미신뢰', unknown: '신뢰 확인 불가' })[value] || '신뢰 확인 불가';
const folderEndpoint = (key) => `/api/sessions/${encodeURIComponent(key)}/folders`;
const localFolderUI = () => ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);

function folderTarget(item, term = false, readOnly = false) {
  if (!item) return;
  const context = item.folderContext;
  return { key: context?.sessionKey || (term ? `term:${item.id}`
    : item.sessionId ? `session:${item.agent || 'claude'}:${item.sessionId}` : ''), readOnly,
  primaryCwd: Object.hasOwn(context || {}, 'primaryCwd') ? context.primaryCwd : localFolderUI() ? item.cwd : null,
  count: context?.referenceCount, trust: context?.trustState };
}

function folderBadgeContent({ primaryCwd, count, trust }) {
  const label = folderStateLabel(trust);
  return `<span class="folder-short">${esc(primaryCwd ? base(primaryCwd) : '폴더 확인 불가')}</span>
    <span>${count ?? '–'}</span><span class="badge ${trust === 'trusted' ? 'ok' : trust === 'untrusted' ? 'warn' : ''}">${label}</span>`;
}

const folderBadgeTitle = (target) => ['세션 폴더', target.primaryCwd, '참조 폴더 ' + (target.count ?? '–'),
  folderStateLabel(target.trust)].filter(Boolean).join(' · ');

function folderBadge(target) {
  if (!target) return '';
  const tip = folderBadgeTitle(target);
  return `<button type="button" class="ghost btn-sm folder-badge" data-workspace-folder="${esc(target.key)}"
    data-folder-read-only="${target.readOnly}" data-folder-primary="${esc(target.primaryCwd)}"
    aria-haspopup="dialog" aria-label="${esc(tip)}" title="${esc(tip)}">${folderBadgeContent(target)}</button>`;
}

function updateFolderBadges() {
  const targets = new Map([...Object.values(state.recentByAgent || {}).flat().map((item) => folderTarget(item)),
    ...state.recent.map((item) => folderTarget(item)), ...state.live.map((item) => folderTarget(item)),
    ...state.terms.map((item) => folderTarget(item, true))]
    .filter((target) => target?.key).map((target) => [target.key, target]));
  for (const button of document.querySelectorAll('[data-workspace-folder]')) {
    const target = targets.get(button.dataset.workspaceFolder);
    if (!target) continue;
    const tip = folderBadgeTitle(target);
    if (button.title === tip) continue;
    button.title = tip;
    button.dataset.folderPrimary = target.primaryCwd || '';
    button.setAttribute('aria-label', tip);
    button.innerHTML = folderBadgeContent(target);
  }
}

function positionFolderToolbox() {
  const badge = $('#bar [data-workspace-folder]');
  if (!badge) return;
  for (const toolbox of document.querySelectorAll('#view [data-ts-bar] .ts-right')) {
    if (!$('[data-workspace-folder]', toolbox)) toolbox.prepend(badge.cloneNode(true));
  }
}
