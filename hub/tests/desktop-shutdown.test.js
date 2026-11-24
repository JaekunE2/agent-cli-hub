const test = require('node:test');
const assert = require('node:assert/strict');
const { createSystemRoutes } = require('../routes-system');

test('desktop shutdown is local, PID-bound, and leaves a busy PTY running', async () => {
  const calls = [];
  const { handleSystemRoutes } = createSystemRoutes({
    getPtyHostPid: () => 777,
    ptyPort: 7779,
    ptyCall: async (route, body) => {
      calls.push([route, body]);
      return route === '/info' ? { pid: 777 } : { ok: false, error: 'PTY is busy.' };
    },
  });
  const request = async (route, { method = 'POST', pid = process.pid, ptyPid = 777, headers, remoteAddress = '127.0.0.1' } = {}) => {
    let reply;
    await handleSystemRoutes(route, null, {
      method, headers: { ...(method === 'POST' && { 'x-ccd-desktop-pid': String(pid) }), ...headers },
      socket: { localAddress: '127.0.0.1', remoteAddress },
    }, {}, async () => ({ ptyPid, stopPty: true }), (_, status, data) => { reply = { status, data }; }, () => true);
    return reply;
  };
  assert.equal((await request('/api/desktop/identity', { method: 'GET', remoteAddress: '100.64.1.1' })).status, 403);
  assert.deepEqual((await request('/api/desktop/identity', { method: 'GET' })).data,
    { pid: process.pid, ptyPid: 777, ptyPort: 7779 });
  assert.equal((await request('/api/desktop/shutdown', { pid: process.pid + 1 })).status, 409);
  assert.equal((await request('/api/desktop/shutdown', { headers: { origin: 'http://127.0.0.1:7777' } })).status, 409);
  assert.deepEqual(calls, []);
  assert.match((await request('/api/desktop/shutdown', { ptyPid: 778 })).data.error, /PTY host changed/);
  assert.deepEqual(calls, [['/info', undefined]]);
  assert.deepEqual((await request('/api/desktop/shutdown')).data, { ok: false, error: 'PTY is busy.' });
  assert.deepEqual(calls.slice(1), [['/info', undefined], ['/shutdown-if-idle', { expectedPid: 777 }]]);
});
