// Browser side of the plugin host (see plugins.js) + fault isolation.
// Loaded after app.js; plugin scripts (/plugins/<id>/*.js) load after this file and call
//   HubPlugins.register({ id, nav: [{ key, icon, label, when?() }], views: { kind: fn }, open?(param) })
// nav entries appear in the sidebar's main menu while when() is true; select({ kind }) of a registered kind
// draws that plugin's view; ?open=<param> links are offered to each plugin's open() until one takes it.
// renderSide() / select() are wrapped so one broken panel shows an inline error instead of a blank page.
'use strict';

// ---------- fault isolation ----------
const uiErrSeen = new Map();
function uiErr(where, e) {
  console.error(`[ui] ${where}:`, e);
  const k = `${where}|${e && e.message}`, now = Date.now();
  if (now - (uiErrSeen.get(k) || 0) < 60000) return; // same error: at most one toast a minute
  uiErrSeen.set(k, now);
  try { toast(`⚠ ${where} 표시 중 오류 — 나머지는 계속 씁니다 (${(e && e.message) || e})`, 6000); } catch {}
}
function safeHTML(where, fn) {
  try { return fn() || ''; } catch (e) { uiErr(where, e); return `<div class="err">⚠ ${esc(where)}: 표시 오류 (${esc((e && e.message) || String(e))})</div>`; }
}
const safeMap = (where, list, fn) => (list || []).map((x) => { try { return fn(x); } catch (e) { uiErr(where, e); return ''; } });
window.uiErr = uiErr; window.safeHTML = safeHTML; window.safeMap = safeMap;
window.addEventListener('error', (ev) => { if (ev.error || ev.message) uiErr('화면', ev.error || ev.message); });
window.addEventListener('unhandledrejection', (ev) => uiErr('요청', ev.reason));

// ---------- registry ----------
const HubPlugins = (() => {
  const plugins = [];
  const views = {};
  return {
    register(p) {
      if (!p || !p.id || plugins.some((x) => x.id === p.id)) return;
      plugins.push(p);
      Object.assign(views, p.views || {});
      try { renderSide(); } catch {}
    },
    views,
    nav() {
      const out = [];
      for (const p of plugins) for (const n of (typeof p.nav === 'function' ? p.nav() : p.nav) || []) {
        try { if (!n.when || n.when()) out.push(n); } catch (e) { uiErr(`${p.id} 메뉴`, e); }
      }
      return out;
    },
    open(param) { for (const p of plugins) { try { if (p.open && p.open(param)) return true; } catch (e) { uiErr(p.id, e); } } return false; },
  };
})();
window.HubPlugins = HubPlugins;

// sidebar: plugin nav entries; if the full sidebar throws, a minimal list so sessions can still be opened
(function guardSide() {
  if (typeof renderSide !== 'function') return;
  const inner = renderSide;
  renderSide = function renderSideGuarded() {
    try {
      inner();
      try { addPluginNav(); } catch (e) { uiErr('사이드바 연동 메뉴', e); }
    } catch (e) {
      uiErr('사이드바', e);
      const it = (key, title, sub) => `<div class="srow" data-key="${esc(key)}"><div class="srow-main"><div class="srow-t">${esc(title)}</div><div class="srow-s">${esc(sub || '')}</div></div></div>`;
      let h = `<div class="err">⚠ 사이드바 일부를 그리지 못해 간단 목록으로 보여 줍니다 (${esc(e.message)})</div>${it('home', '홈')}`;
      h += safeMap('세션', state.live || [], (s) => it(`session:${s.sessionId}`, s.name || s.sessionId.slice(0, 8), s.status)).join('');
      h += safeMap('터미널', state.terms || [], (t) => it(`term:${t.id}`, t.title || `t:${t.id}`, t.exited === null ? '실행 중' : '종료됨')).join('');
      const side = $('#side'); if (side) side.innerHTML = h;
    }
  };
})();

// views: registered kinds join the view map; any view that throws shows an inline error
(function guardSelect() {
  if (typeof select !== 'function') return;
  const inner = select;
  select = function selectGuarded(sel, ...rest) {
    try {
      const own = sel && HubPlugins.views[sel.kind];
      // the original select() does the bookkeeping (state.sel, hash, sidebar) also for a kind it does not know
      const r0 = inner(sel, ...rest);
      const r = own ? own(sel) : r0;
      if (r && typeof r.catch === 'function') r.catch((e) => uiErr('화면', e));
      return r;
    } catch (e) {
      uiErr('화면', e);
      const v = $('#view');
      if (v) v.innerHTML = `<div class="err" style="padding:16px">⚠ 이 화면을 여는 중 오류가 났습니다: ${esc(e.message)}<br>왼쪽에서 다른 항목은 그대로 열 수 있습니다.</div>`;
    }
  };
})();

function addPluginNav() {
  const nav = $('#side .snav');
  if (!nav || nav.querySelector('[data-plugin-nav]')) return;
  const cur = state.sel || {};
  const h = HubPlugins.nav().map((n) => {
    const [kind, id] = String(n.key).split(':');
    const sel = cur.kind === kind && (!id || String(cur.id) === id);
    return `<button type="button" class="snav-item${sel ? ' sel' : ''}" data-key="${esc(n.key)}" data-plugin-nav="1"><span class="snav-ico" aria-hidden="true">${n.icon || '🧩'}</span><span class="snav-lbl">${esc(n.label)}</span></button>`;
  }).join('');
  if (h) nav.insertAdjacentHTML('beforeend', h);
}
$('#side')?.addEventListener('click', (e) => {
  const it = e.target.closest('[data-plugin-nav]');
  if (!it) return;
  e.stopImmediatePropagation();
  const [kind, id] = String(it.dataset.key).split(':');
  select(id ? { kind, id } : { kind });
}, true);

// ?open=<param> links (phone app, notifications) that the core does not know
(function openFromQuery() {
  const open = new URLSearchParams(location.search).get('open') || '';
  if (open) setTimeout(() => HubPlugins.open(open), 900);
})();
