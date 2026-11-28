'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createResetCreditsService } = require('../codex-reset-credits');

function fixture(outcome = 'reset') {
  const calls = [], clients = [];
  const service = createResetCreditsService({
    usageDir: '.', exe: 'codex.exe',
    accounts: () => [{ id: 'a', email: 'one@example.com', main: true }, { id: 'b', email: 'two@example.com', home: '/account-b' }],
    openClient: (exe, account) => {
      const client = {
        account, closed: false,
        async initialize() { calls.push(['initialize', account.id]); },
        async request(method, params) {
          calls.push([method, params]);
          if (method.endsWith('/consume')) return { outcome };
          return { rateLimitResetCredits: { availableCount: 1, credits: null } };
        },
        close() { client.closed = true; },
      };
      clients.push(client); return client;
    },
  });
  return { service, calls, clients };
}
const request = { account: 'b', confirmed: true, idempotencyKey: '12345678-1234-1234-1234-123456789abc' };

test('reads the selected account; does not consume a credit or start a turn', async () => {
  const f = fixture();
  const r = await f.service.read('b');
  assert.equal(r.account.email, 'two@example.com');
  assert.equal(r.rateLimitResetCredits.availableCount, 1);
  assert.deepEqual(f.calls.map(c => c[0]), ['initialize', 'account/rateLimits/read']);
  assert.ok(f.clients[0].closed);
});
test('auto-codex is resolved only to main; unknown IDs fail closed', async () => {
  const f = fixture();
  assert.equal((await f.service.read('auto-codex')).account.id, 'a');
  await assert.rejects(f.service.read('no-such-account'));
  assert.equal(f.clients.length, 1);
});
test('requires explicit confirmation and a caller-owned retry key', async () => {
  const f = fixture();
  await assert.rejects(f.service.consume({ ...request, confirmed: false }));
  await assert.rejects(f.service.consume({ ...request, idempotencyKey: '' }));
  await assert.rejects(f.service.consume({ ...request, creditId: '' }));
  assert.equal(f.clients.length, 0);
});
for (const outcome of ['reset', 'alreadyRedeemed', 'nothingToReset', 'noCredit']) {
  test(`preserves ${outcome} and rereads limits instead of assuming zero`, async () => {
    const f = fixture(outcome);
    const r = await f.service.consume({ ...request, creditId: 'opaque-credit-id' });
    assert.equal(r.outcome, outcome);
    assert.equal(r.limits.rateLimitResetCredits.availableCount, 1);
    assert.deepEqual(f.calls[1], ['account/rateLimitResetCredit/consume', { idempotencyKey: request.idempotencyKey, creditId: 'opaque-credit-id' }]);
    assert.ok(f.clients[0].closed);
  });
}
test('retries retain the caller key and close each child', async () => {
  const f = fixture();
  const open = f.service.consume.bind(f.service);
  // Repeated logical attempts must forward the unchanged idempotency key.
  await open(request); await open(request);
  const keys = f.calls.filter(c => c[0].endsWith('/consume')).map(c => c[1].idempotencyKey);
  assert.deepEqual(keys, [request.idempotencyKey, request.idempotencyKey]);
  assert.ok(f.clients.every(c => c.closed));
});

test('blocks simultaneous redemptions for one account and unlocks after failure', async () => {
  let rejectRequest;
  let calls = 0;
  const service = createResetCreditsService({ usageDir: '.', exe: 'codex', accounts: () => [{ id: 'b', email: 'x@y' }],
    openClient: () => ({ initialize: async () => {}, close() {}, request: () => { calls++; return new Promise((resolve, reject) => { rejectRequest = reject; }); } }),
  });
  const first = service.consume(request);
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(service.consume({ ...request, idempotencyKey: 'another-request-key' }), /진행 중/);
  rejectRequest(new Error('disconnected'));
  await assert.rejects(first, /disconnected/);
  const next = service.consume(request);
  await new Promise(resolve => setImmediate(resolve));
  rejectRequest(new Error('disconnected'));
  await assert.rejects(next);
  assert.equal(calls, 2);
});
