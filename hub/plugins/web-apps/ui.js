// Web apps plugin UI: one sidebar entry per configured app, the app in an iframe (/app-<id>/<token>/).
'use strict';
let webAppList = [];
function viewApp(sel) {
  const id = (sel || state.sel).id;
  const a = webAppList.find((x) => x.id === id) || { id, label: id };
  const src = `/app-${encodeURIComponent(a.id)}/${encodeURIComponent(TOKEN)}/`;
  setBar(`<h2>${esc(a.icon || '🧩')} ${esc(a.label)}</h2><span class="sp"></span><a class="btnlike" href="${src}" target="_blank" rel="noopener" title="새 탭에서 크게">새 탭</a>`);
  const v = $('#view'); v.onclick = null;
  v.innerHTML = `<iframe src="${src}" title="${esc(a.label)}" style="width:100%;height:100%;border:0;display:block;background:transparent"></iframe>`;
}
HubPlugins.register({
  id: 'web-apps',
  nav: () => (state.webApps ? webAppList.map((a) => ({ key: `app:${a.id}`, icon: a.icon || '🧩', label: a.label || a.id })) : []),
  views: { app: (sel) => viewApp(sel) },
  open(param) {
    if (!param.startsWith('app:')) return false;
    select({ kind: 'app', id: param.slice(4) });
    return true;
  },
});
// the list (labels / icons) once the overview says apps are configured
setTimeout(function loadApps() {
  if (!state.webApps) return void setTimeout(loadApps, 3000);
  api('/api/webapps').then((r) => { webAppList = r.apps || []; renderSide(); }).catch((e) => uiErr('앱 목록', e));
}, 1500);
