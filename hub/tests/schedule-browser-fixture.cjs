const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter, once } = require('node:events');
const { createScheduleEngine } = require('../schedules');
const { createScheduleRoutes } = require('../routes-schedules');
const { createScheduleTransport } = require('../schedule-transport');

module.exports = async language => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-browser-schedules-'));
  const file = path.join(dir, 'schedules.json');
  const evidence = new Map();
  const transport = createScheduleTransport(() => engine, assert.fail);
  const engine = createScheduleEngine({
    file, onChange: transport.broadcast, onError: assert.fail,
    resolveTarget: () => ({ cwd: dir, cmd: process.execPath, args: [] }),
    runner: {
      start({ runId }) { evidence.set(runId, { state: 'running' }); },
      recover: id => evidence.get(id),
    },
  });
  const cli = { id: 'codex', accountIds: ['default'], available: true };
  const auth = (req, url) => req.headers['x-token'] === 'fixture' || url.searchParams.get('t') === 'fixture';
  const routes = createScheduleRoutes(() => engine, { cli: [cli] }, assert.fail);
  const send = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const project = { id: 'demo', name: 'Demo', versions: [{ number: '1.5.0' }], tasks: [] };
  const store = { list: () => [project], hidden: () => new Set(), tokenSummary: () => ({}), allSubChats: () => ({}) };
  const sockets = new Set();
  const upgrades = new EventEmitter();
  const app = await require('./browser-fixture')(store, (url, req, res) =>
    routes(url.pathname, url, req, res, send, auth), {
    language,
    handleUpgrade(req, socket, head) {
      const url = new URL(req.url, 'http://localhost');
      const handled = transport.handleUpgrade(req, socket, head, url, auth);
      if (handled) {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
        upgrades.emit('connected');
      }
      return handled;
    },
  });
  return {
    url: app.url, cli, engine,
    reconnected: () => once(upgrades, 'connected', { signal: AbortSignal.timeout(8000) }),
    disconnect() {
      return Promise.all([...sockets].map(socket => {
        const closed = once(socket, 'close');
        socket.destroy();
        return closed;
      }));
    },
    async finish() {
      const [runId] = evidence.keys();
      assert.ok(runId);
      evidence.set(runId, { state: 'finished', result: { outcome: 'succeeded', exitCode: 0, outputSummary: 'Fixture summary' } });
      await engine.tick();
    },
    async close() {
      await this.disconnect();
      await app.close();
      fs.rmSync(file, { force: true });
      fs.rmdirSync(dir);
    },
  };
};
