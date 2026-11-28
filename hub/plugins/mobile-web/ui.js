// Mobile web plugin UI: registers the service worker (HTTPS only), handles things shared to the installed hub
// (?open=share), and lets the phone pick what to do with them.
'use strict';
(function registerSw() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return; // plain http (e.g. a Tailscale IP): no SW, no share target
  navigator.serviceWorker.register('/plugins/mobile-web/sw.js', { scope: '/' }).catch((e) => console.warn('[sw]', e.message));
  // Android Chrome refuses `new Notification()` in a page ("use ServiceWorkerRegistration.showNotification"):
  // the hub's completion notifications go through the service worker there
  const N = window.Notification;
  if (typeof N !== 'function') return;
  function HubNotification(title, opts = {}) {
    try { return new N(title, opts); } catch {
      navigator.serviceWorker.ready.then((r) => r.showNotification(title, { ...opts, data: { url: location.pathname + location.search + location.hash } })).catch(() => {});
      return { close() {}, addEventListener() {}, set onclick(_) {} };
    }
  }
  Object.defineProperty(HubNotification, 'permission', { get: () => N.permission });
  HubNotification.requestPermission = (...a) => N.requestPermission(...a);
  window.Notification = HubNotification;
})();

async function sharedItems() {
  if (!('caches' in window)) return null;
  const cache = await caches.open('hub-share');
  const metaRes = await cache.match('/__share/meta');
  if (!metaRes) return null;
  const meta = await metaRes.json();
  return { cache, meta };
}
async function clearShared(cache) { for (const k of await cache.keys()) await cache.delete(k); }

async function openShareDrawer() {
  const got = await sharedItems().catch(() => null);
  if (!got) return toast('공유된 항목이 없습니다', 4000);
  const { cache, meta } = got;
  const audio = meta.files.filter((f) => /^audio\//.test(f.type) || /\.(m4a|mp3|wav|ogg|aac|amr|3gp|flac|opus)$/i.test(f.name));
  const body = `${meta.files.length ? `<div class="empty" style="padding:0">파일 ${meta.files.length}개: ${meta.files.map((f) => esc(f.name)).join(', ')}</div>` : ''}
    ${meta.text || meta.url ? `<pre style="white-space:pre-wrap">${esc([meta.title, meta.text, meta.url].filter(Boolean).join('\n'))}</pre>` : ''}
    <div class="row" style="flex-wrap:wrap;gap:6px;margin-top:8px">
      ${meta.files.length ? '<button class="primary" data-sh="upload">허브 PC에 올리기</button>' : ''}
      ${audio.length && state.callDigest ? '<button data-sh="calls">통화 녹음으로 올리기</button>' : ''}
      <button data-sh="drop">버리기</button>
    </div><div id="shOut" class="empty" style="padding:6px 0"></div>`;
  const d = openDrawer({ title: '공유받은 항목', bodyHTML: body, width: 480 });
  d.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-sh]')?.dataset.sh; if (!a) return;
    const out = $('#shOut', d);
    try {
      if (a === 'drop') { await clearShared(cache); d.close(); return; }
      const done = [];
      for (const f of a === 'calls' ? audio : meta.files) {
        const blob = await (await cache.match(f.key)).blob();
        const date = new Date(blob.lastModified || Date.now()).toLocaleDateString('sv-SE'); // local YYYY-MM-DD
        const target = a === 'calls' ? `/api/calls/upload?date=${encodeURIComponent(date)}&name=${encodeURIComponent(f.name)}` : `/api/upload?name=${encodeURIComponent(f.name)}`;
        const r = await fetch(target, { method: 'POST', headers: { 'x-token': TOKEN }, body: blob }).then((x) => x.json());
        if (r.error) throw new Error(r.error);
        done.push(r.path || r.saved || f.name);
      }
      out.innerHTML = `올렸습니다:<br>${done.map((x) => `<span class="mono">${esc(x)}</span>`).join('<br>')}`;
      await clearShared(cache);
    } catch (er) { out.textContent = er.message; }
  });
}

HubPlugins.register({
  id: 'mobile-web',
  nav: [],
  views: {},
  open(param) {
    if (param !== 'share') return false;
    setTimeout(openShareDrawer, 300);
    return true;
  },
});
