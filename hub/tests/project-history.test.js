const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os');
const { fingerprint, projectSession, projectDeliveryResult } = require('../project-history');
const { SearchIndex } = require('../searchindex');

test('removing a Project hides linked records only, including late session discovery', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-project-delete-'));
  const file = path.join(dir, 'projects.json');
  try {
    const p = { id: 'old-project', revision: 1 };
    fs.writeFileSync(file, JSON.stringify([p]));
    const store = require('../projects')(file);
    store.remember([{ projectId: p.id, sessionId: 'linked-id' }]);
    assert.throws(() => store.remove(p.id, 0));
    assert.equal(store.remove(p.id, 1), 1);
    store.remember([{ projectId: p.id, sessionId: 'late-record' }]);
    assert.deepEqual([...require('../projects')(file).hidden()], ['linked-id', 'late-record']);
    const index = new SearchIndex(dir, null, null);
    index.docs.clear();
    for (const id of ['linked-id', 'unrelated-id']) index.docs.set(id, { id, agent: 'agy', msgs: [{ role: 'user', text: 'test' }] });
    assert.deepEqual(index.recent(10, false, 'agy', store.hidden()).map(d => d.sessionId), ['unrelated-id']);
    assert.deepEqual(index.search('test', { hidden: store.hidden() }).map(d => d.sessionId), ['unrelated-id']);
  } finally {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(dir);
  }
});

test('matches only the uniquely identified Codex task prompt, not other folder history', () => {
  const cwd = process.cwd(), spawnedAt = Date.now();
  const term = { cwd, meta: { projectTask: { projectId: 'p', taskId: 't' }, args: [], spawnedAt, projectPrompt: fingerprint('Run checks') } };
  const doc = (id, text) => ({ id, cwd, agent: 'codex', msgs: [{ role: 'user', text, ts: new Date(spawnedAt).toISOString() }] });
  const exact = doc('unique-record', 'Run checks');
  assert.equal(projectSession(term, 'codex', [exact, doc('other-record', 'Another task')]), 'unique-record');
  assert.equal(projectSession(term, 'codex', [exact, doc('second-record', 'Run checks')]), null);
  assert.equal(projectSession(term, 'agy', [], 'agy-record-id'), 'agy-record-id');
});

test('linked review sessions stay visible without listing unrelated automatic sessions', () => {
  const index = new SearchIndex(os.tmpdir(), null, null);
  index.docs.clear();
  for (const id of ['review-id', 'other-id']) index.docs.set(id, { id, agent: 'agy', auto: true, msgs: [{ role: 'user', text: 'Review' }] });
  const owners = new Map([['review-id', { projectId: 'p', taskId: 't' }]]);
  assert.deepEqual(index.recent(10, false, 'agy', new Set(), owners).map((d) => d.sessionId), ['review-id']);
  assert.deepEqual(index.recent(10, false, 'agy', new Set(['review-id']), owners), []);
});

test('a delivery error can recover only the response to its submitted prompt', () => {
  const at = Date.now();
  const term = { meta: { projectDelivery: { at, digest: fingerprint('Run checks') } } };
  const messages = [{ role: 'user', text: 'Run checks', ts: new Date(at).toISOString() }];
  const hub = { termSessionId: () => 'record', index: { get: () => ({ msgs: messages }) } };
  messages.push({ role: 'assistant', text: '⚙ Running tests', ts: new Date(at + 1).toISOString() });
  assert.equal(projectDeliveryResult(hub, term), null);
  messages.push({ role: 'assistant', text: 'Checks finished.', ts: new Date(at + 2).toISOString() });
  assert.deepEqual(projectDeliveryResult(hub, term), { at });
  messages.push({ role: 'user', text: 'Unrelated follow-up', ts: new Date(at + 3).toISOString() });
  assert.equal(projectDeliveryResult(hub, term), null);
});
