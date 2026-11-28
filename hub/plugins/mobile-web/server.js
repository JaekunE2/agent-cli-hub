'use strict';
// Mobile web plugin: the hub as an installable web app on a phone (no native app needed).
// - /share  POST without the service worker (plain http, or SW not installed yet): explains what is needed
// - remote URLs: config remoteUrls (e.g. the https://<machine>.<tailnet>.ts.net/ address of `tailscale serve`)
//   and homelink.url (a self-hosted relay) come first in the remote / QR panel
// - overview: whether the page should register the service worker (always; the browser refuses it off HTTPS)
module.exports = function mobileWebPlugin(api) {
  const urls = [...(Array.isArray(api.config.remoteUrls) ? api.config.remoteUrls : []), ...(api.config.homelink?.url ? [api.config.homelink.url] : [])];
  return {
    enabled: api.config.mobileWeb !== false,
    overview: () => ({ mobileWeb: { sw: '/plugins/mobile-web/sw.js', urls } }),
    hooks: { remoteUrls: () => (urls.length ? urls : undefined) },
    handlePage(p, url, req, res) {
      if (p !== '/share') return false;
      if (req.method === 'GET') { res.writeHead(302, { location: '/?open=share' }); res.end(); return true; }
      req.resume();
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><meta name="viewport" content="width=device-width"><body style="font:16px system-ui;padding:20px">'
        + '<p>Sharing to the hub needs the installed web app over HTTPS (for example <code>tailscale serve</code>).</p>'
        + '<p>Open the hub once over HTTPS, add it to the home screen, then share again.</p><p><a href="/">Open the hub</a></p>');
      return true;
    },
  };
};
