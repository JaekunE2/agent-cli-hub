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
      (_, status, body) => { response = { status, ...(Array.isArray(body) ? { list: body } : body) }; }, () => authed);
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
  for (const id of ['term:missing', 'term:', '../bad']) assert.equal((await rename({ id, title: 'bad' })).status, 400);
  assert.equal((await rename({ id: 'term:99', title: 'bad' })).status, 404);
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

test('subagent routes distinguish malformed, missing, and mismatched identifiers', async t => {
  const { request, hub, term, sessionId } = setup(t);
  term.meta.sessionId = sessionId;
  hub.index.set('other-session', {});
  hub.terms.set('2', { id: '2', exited: null, meta: { parentTermId: '1' }, startedAt: Date.now() });
  const list = '/api/session/subagents';
  const detail = '/api/session/subagent-detail';
  assert.equal((await request(list, 'GET', null, false)).status, 401);
  for (const route of [list, detail]) {
    const id = route === detail ? 'id=term:2&' : '';
    for (const query of ['', 'cwd=fixture', 'termId=bad', 'sessionId=bad', 'sessionId=term:', 'termId=1&sessionId=term:2']) {
      assert.equal((await request(`${route}?${id}${query}`, 'GET')).status, 400, query);
    }
    for (const query of ['sessionId=missing-parent', 'termId=1&sessionId=other-session']) {
      assert.equal((await request(`${route}?${id}${query}`, 'GET')).status, 404, query);
    }
  }
  for (const id of ['', '../bad', 'term:bad']) {
    assert.equal((await request(`${detail}?termId=1&id=${encodeURIComponent(id)}`, 'GET')).status, 400, id);
  }
  assert.equal((await request(`${list}?termId=1&sessionId=${sessionId}`, 'GET')).list[0].targetTermId, '2');
  assert.equal((await request(`${detail}?sessionId=term:1&id=term:2`, 'GET')).ok, true);
  assert.equal((await request(`${detail}?termId=1&id=unknown-call`, 'GET')).status, 404);
});

test('subagent detail returns only the child log associated with its parent and call', async t => {
  const { request, hub, sessionId, store } = setup(t);
  const root = path.join(path.dirname(store), 'transcripts');
  hub.index.root = root;
  for (const [sid, message] of [[sessionId, 'expected output'], ['other-session', 'other session output']]) {
    const file = path.join(root, `${sid}.jsonl`);
    const directory = path.join(root, sid, 'subagents');
    fs.mkdirSync(directory, { recursive: true });
    const call = { type: 'tool_use', name: 'Agent', id: 'use1', input: { prompt: 'Review the fixture' } };
    fs.writeFileSync(file, JSON.stringify({ type: 'assistant', message: { content: [call] } }) + '\n');
    fs.writeFileSync(path.join(directory, 'agent-child.jsonl'), [
      { type: 'user', message: { content: call.input.prompt } },
      { type: 'assistant', message: { content: message } },
    ].map(row => JSON.stringify(row) + '\n').join(''));
    hub.index.set(sid, { file, agent: 'claude' });
  }
  const outside = path.join(path.dirname(store), 'outside.jsonl');
  fs.writeFileSync(outside, JSON.stringify({ type: 'assistant', message: { content: 'outside output' } }) + '\n');
  const detail = sid => `/api/session/subagent-detail?sessionId=${sid}&id=use1`;
  const withLog = (sid, file) => request(`${detail(sid)}&logPath=${encodeURIComponent(file)}`, 'GET');
  const childLog = sid => path.join(root, sid, 'subagents', 'agent-child.jsonl');
  assert.equal((await request(detail('other-session'), 'GET')).lastMessage, 'other session output');
  assert.equal((await withLog(sessionId, fs.realpathSync(childLog(sessionId)))).lastMessage, 'expected output');
  for (const file of [childLog('other-session'), outside]) {
    const response = await withLog(sessionId, fs.realpathSync(file));
    assert.equal(response.status, 400);
    assert.equal(response.ok, false);
    for (const field of ['prompt', 'events', 'lastMessage']) assert.equal(Object.hasOwn(response, field), false);
  }
});
