// Service worker of the hub page (registered by the mobile-web plugin; needs HTTPS, e.g. `tailscale serve`).
// - Share target: files / text shared to the installed hub (Android "Share" menu) are kept in Cache Storage and the
//   page opens at /?open=share, where the user picks what to do with them (upload to the hub, a session, call digest).
// - Notification clicks focus the hub page.
// Nothing else is cached: the hub is live data, so it always goes to the network.
'use strict';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'POST' || u.origin !== self.location.origin || u.pathname !== '/share') return;
  e.respondWith((async () => {
    const fd = await e.request.formData();
    const cache = await caches.open('hub-share');
    for (const k of await cache.keys()) await cache.delete(k); // one share at a time
    const files = fd.getAll('files').filter((f) => f && typeof f === 'object' && f.name);
    const stamp = Date.now();
    const meta = {
      at: stamp, title: String(fd.get('title') || ''), text: String(fd.get('text') || ''), url: String(fd.get('url') || ''),
      files: files.map((f, i) => ({ key: `/__share/${stamp}-${i}`, name: f.name, type: f.type || 'application/octet-stream', size: f.size })),
    };
    for (const [i, f] of files.entries()) await cache.put(meta.files[i].key, new Response(f, { headers: { 'content-type': meta.files[i].type } }));
    await cache.put('/__share/meta', new Response(JSON.stringify(meta), { headers: { 'content-type': 'application/json' } }));
    return Response.redirect('/?open=share', 303);
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = e.notification.data?.url || '/';
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const hit = all.find((c) => new URL(c.url).origin === self.location.origin);
    if (hit) { await hit.focus(); if (target !== '/') hit.navigate(target).catch(() => {}); return; }
    await self.clients.openWindow(target);
  })());
});
