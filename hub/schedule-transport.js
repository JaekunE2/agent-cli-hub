'use strict';

const { WebSocket, WebSocketServer } = require('ws');

function createScheduleTransport(getEngine, logError) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  wss.on('error', cause => logError('schedules-ws', cause));

  function send(ws, message) {
    ws.send(message, cause => { if (cause) logError('schedules-ws', cause); });
  }

  return {
    handleUpgrade(req, socket, head, url, authed) {
      if (url.pathname !== '/ws/schedules') return false;
      const engine = getEngine();
      const rejection = !authed(req, url) ? '401 Unauthorized' : !engine ? '503 Service Unavailable' : null;
      if (rejection) {
        socket.end(`HTTP/1.1 ${rejection}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
        return true;
      }
      wss.handleUpgrade(req, socket, head, ws => {
        ws.on('error', cause => logError('schedules-ws', cause));
        send(ws, JSON.stringify({ type: 'schedules.ready', seq: engine.snapshot().seq }));
      });
      return true;
    },
    broadcast({ seq, scheduleIds, runIds }) {
      const message = JSON.stringify({ type: 'schedules.changed', seq, scheduleIds, runIds });
      for (const ws of wss.clients) {
        if (ws.readyState !== WebSocket.OPEN) continue;
        if (ws.bufferedAmount > 256 * 1024) ws.terminate();
        else send(ws, message);
      }
    },
  };
}

module.exports = { createScheduleTransport };
