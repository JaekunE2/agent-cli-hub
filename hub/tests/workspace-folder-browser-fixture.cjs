'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createWorkspaceContexts } = require('../workspace-contexts');
const { createWorkspaceFolderRoutes, createFolderListSummaries } = require('../routes-workspace-folders');
const fixture = require('./browser-fixture');

module.exports = async (language) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-folder-ui-'));
  try {
    const [main, other, ref, native, secondNative] = await Promise.all(['Main', 'Second', '웹 참조', 'Native Reference', 'Native Second']
      .map(async (name) => { const dir = path.join(tmp, name); await fs.mkdir(dir); return dir; }));
    const terms = [{ id: '1', title: 'Alpha', cwd: main, agent: 'codex', exited: null },
      { id: '2', title: 'Beta', cwd: other, agent: 'codex', exited: null }];
    const session = { sessionId: 'demo-123456', title: 'Transcript', agent: 'codex', cwd: other, mtime: Date.now() };
    const keys = ['term:1', 'term:2', 'session:codex:demo-123456'];
    const byKey = new Map([...terms, session].map((item, i) => [keys[i], { sessionKey: keys[i],
      ...(i < 2 ? { termKey: keys[i], generation: 1 } : { nativeKey: keys[i] }), cwd: item.cwd, editable: i < 2 }]));
    const store = createWorkspaceContexts(path.join(tmp, 'contexts.json'));
    const send = (res, status, data) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data));
    const errors = [];
    const log = (tag, error) => errors.push(`${tag}: ${error.message}`);
    const handle = createWorkspaceFolderRoutes(store, (key) => byKey.get(key), log);
    const summarize = createFolderListSummaries(store, (ids) => ids.map((key) => byKey.get(key)), log);
    const app = await fixture({ list: () => [], hidden: () => new Set() }, async (url, req, res) => {
      const pathname = url.pathname;
      if (pathname === '/api/overview') {
        send(res, 200, { terms: await summarize(terms, req, (item) => `term:${item.id}`), consoles: [], live: [] });
        return true;
      }
      if (pathname === '/api/recent') {
        send(res, 200, { sessions: await summarize([session], req, () => keys[2]) });
        return true;
      }
      return handle(pathname, url, req, res, send, () => req.headers['x-token'] === 'fixture');
    }, { language });
    return { ...app, main, other, ref, native, secondNative, errors, close: async () => {
      await app.close();
      await fs.rm(tmp, { recursive: true, force: true });
    } };
  } catch (error) {
    await fs.rm(tmp, { recursive: true, force: true });
    throw error;
  }
};
