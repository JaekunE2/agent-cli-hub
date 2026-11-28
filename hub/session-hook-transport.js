'use strict';

const { createToolHooks } = require('./tool-activity-hooks');
const { ingestToolHook } = require('./tool-hooks');

function createHookTransport(hub) {
  const clients = new Set();
  function broadcast(event) {
    const message = JSON.stringify(event);
    for (const ws of clients) if (ws.readyState === 1) ws.send(message);
  }
  const toolHooks = createToolHooks(hub, ({ termId, sessionId }) => {
    broadcast({ type: 'hook-event', termId, sessionId });
  });

  async function handleNativeHook(req, res, body, send) {
    if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.origin || req.headers['x-hook-token'] !== hub.hookToken) {
      return send(res, 401, { error: 'bad token' });
    }
    try {
      const event = ingestToolHook(hub, await body(req));
      if (event) broadcast(event);
      return send(res, 200, { ok: true });
    } catch (error) {
      console.error('[hub hook]', error);
      return send(res, 500, { ok: false });
    }
  }

  function handleUpgrade(wss, req, sock, head, url, authed) {
    if (url.pathname !== '/ws/hooks' && url.pathname !== '/ws/tool-activity') return false;
    if (!authed(req, url)) {
      sock.destroy();
      return true;
    }
    wss.handleUpgrade(req, sock, head, ws => {
      if (url.pathname === '/ws/hooks') {
        clients.add(ws);
        ws.on('close', () => clients.delete(ws));
        ws.on('error', () => clients.delete(ws));
        return;
      }
      const termId = url.searchParams.get('termId');
      const sessionId = url.searchParams.get('sessionId');
      if (termId) toolHooks.subscribe(`term:${termId}`, ws);
      if (sessionId) toolHooks.subscribe(`sid:${sessionId}`, ws);
      if (!termId && !sessionId) toolHooks.subscribe('all', ws);
    });
    return true;
  }

  return { toolHooks, handleNativeHook, handleUpgrade };
}

module.exports = { createHookTransport };
