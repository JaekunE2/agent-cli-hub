'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createSessionRoutes } = require('../routes-sessions');
const { createBranchStore } = require('../conversation-branches');
const { sessionId: validSessionId } = require('../project-history');

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-rename-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = path.join(dir, 'branches.json');
  const sessionId = 'session-123';
  const term = { id: '1', title: 'Project default', meta: { projectTask: { taskId: 'test' } } };
  const doc = { title: 'Session default' };
  const conversationBranches = createBranchStore(store);
  const diskMeta = {};
  const hub = { terms: new Map([['1', term]]), termSessionId: term => term.meta.sessionId, index: new Map([[sessionId, doc]]),
    projects: { list: () => [], hidden: () => new Set() },
    config: {}, conversationBranches, validSessionId, ptyPost: async (_, __, { meta }) => { Object.assign(diskMeta, meta); return { ok: true }; } };
  hub.sessionDisplayTitle = (id, doc) => conversationBranches.getTitle(id) || conversationBranches.baseTitle(id, doc?.title);
  const { handleSessionRoutes } = createSessionRoutes(hub);
  async function request(route, method, input, authed = true) {
    let response;
    const url = new URL(route, 'http://localhost');
    await handleSessionRoutes(url.pathname, url, { method }, {}, async () => input,
      (_, status, body) => { response = { status, ...body }; }, () => authed);
    return response;
  }
  const rename = input => request('/api/transcript/title', 'POST', input);
  return { request, rename, term, doc, hub, diskMeta, sessionId, store };
}

test('title route saves and clears project term metadata using a synthetic ID', async t => {
  const { rename, term, diskMeta } = setup(t);
  assert.equal((await rename({ id: 'term:1', title: '  Renamed  ' })).title, 'Renamed');
  assert.equal(term.meta.customTitle, 'Renamed');
  assert.equal(diskMeta.customTitle, 'Renamed');
  assert.equal(term.title, 'Project default');
  assert.equal((await rename({ id: 'term:1', title: '' })).title, null);
  assert.equal(term.meta.customTitle, '');
  assert.equal(diskMeta.customTitle, '');
  assert.equal(term.title, 'Project default');
  for (const id of ['term:missing', 'term:99', 'term:', '../bad']) assert.equal((await rename({ id, title: 'bad' })).status, 400);
  assert.equal((await rename({ id: 'term:1', termId: '2', title: 'bad' })).status, 400);
});

test('linked project and recent session share a durable override and restore the native title', async t => {
  const { rename, term, doc, sessionId, store } = setup(t);
  term.meta.sessionId = sessionId;
  const saved = await rename({ id: 'term:1', title: 'First name' });
  assert.equal(saved.sessionId, sessionId);
  assert.equal(createBranchStore(store).getTitle(sessionId), 'First name');
  assert.equal((await rename({ id: sessionId, title: 'Second name' })).title, 'Second name');
  assert.equal(term.meta.customTitle, 'Second name');
  assert.equal((await rename({ id: sessionId, title: '' })).displayTitle, 'Session default');
  assert.equal(doc.title, 'Session default');
  assert.equal(createBranchStore(store).getTitle(sessionId), null);
  assert.equal(term.meta.customTitle, '');
});

test('metadata failure preserves the current name', async t => {
  const { rename, hub, term } = setup(t);
  term.meta.customTitle = 'Existing';
  hub.ptyPost = async () => ({ ok: false });
  assert.equal((await rename({ id: 'term:1', title: 'Attempt' })).status, 502);
  assert.equal(term.meta.customTitle, 'Existing');
});

test('legacy terminal metadata restores the project task default', async t => {
  const { rename, term, hub, diskMeta } = setup(t);
  term.title = term.meta.customTitle = 'Legacy name';
  term.meta.projectTask.projectId = 'project';
  hub.projects.list = () => [{ id: 'project', tasks: [{ id: 'test', title: 'Project default' }] }];
  await rename({ id: 'term:1', title: '' });
  assert.equal(term.title, 'Project default');
  assert.equal(diskMeta.defaultTitle, 'Project default');
});

test('subagent routes check authorization and reject unassociated detail paths', async t => {
  const { request, hub } = setup(t);
  hub.terms.set('2', { id: '2', exited: null, meta: { parentTermId: '1' }, startedAt: Date.now() });
  const list = '/api/session/subagents?termId=1';
  assert.equal((await request(list, 'GET', null, false)).status, 401);
  assert.equal((await request(list, 'GET')).subagents[0].targetTermId, '2');
  const detail = '/api/session/subagent-detail?termId=1&id=term%3A2';
  assert.equal((await request(detail, 'GET')).ok, true);
  assert.equal((await request(detail + '&logPath=unrelated.jsonl', 'GET')).status, 404);
});
