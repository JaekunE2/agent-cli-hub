// window.HL for a phone app's llm.html page when it runs inside the dashboard (/app-llm/<token>/).
// The app's Java bridge does the HTTP there; here fetch() goes through the dashboard, which proxies
// /app-llm/<token>/<path> to the GX10 llm-agent (config llm.url, e.g. a tunnel to the LLM server).
(function () {
  'use strict';
  var BASE = location.pathname.replace(/\/[^/]*$/, ''); // "/app-llm/<token>"
  var ctl = {};
  function cb(fn, a, b) { try { window.LLM && window.LLM[fn](a, b); } catch (e) { console.error(e); } }
  window.HL = {
    llmReq: function (id, method, path, body) {
      var ac = new AbortController(); ctl[id] = ac;
      var init = { method: method, signal: ac.signal, headers: {} };
      if (body != null) { init.body = body; init.headers['content-type'] = 'application/json'; }
      fetch(BASE + path, init).then(function (r) {
        if (!r.ok) return r.text().then(function (t) { throw new Error('HTTP ' + r.status + ': ' + t.slice(0, 300)); });
        var rd = r.body.getReader(), dec = new TextDecoder(), buf = '';
        function pump() {
          return rd.read().then(function (x) {
            if (x.done) { if (buf) cb('chunk', id, buf); return; }
            buf += dec.decode(x.value, { stream: true });
            var i; while ((i = buf.indexOf('\n')) >= 0) { var l = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1); if (l) cb('chunk', id, l); }
            return pump();
          });
        }
        return pump();
      }).then(function () { delete ctl[id]; cb('done', id, null); }, function (e) {
        delete ctl[id];
        cb('done', id, e.name === 'AbortError' ? null : (e.message || String(e)));
      });
    },
    llmCancel: function (id) { if (ctl[id]) { ctl[id].abort(); delete ctl[id]; } },
    llmModels: function () { // synchronous in the app; a sync XHR keeps the page code unchanged
      try { var x = new XMLHttpRequest(); x.open('GET', BASE + '/api/tags', false); x.send(); return x.status === 200 ? x.responseText : '{"models":[]}'; }
      catch (e) { return '{"models":[]}'; }
    },
  };
  document.addEventListener('visibilitychange', function () { if (!document.hidden) cb('resume'); });
})();
