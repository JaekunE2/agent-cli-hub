const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
module.exports = async function fixture(store, handleRoute) {
  const root = path.resolve(__dirname, '..');
  const assets = {
    '/': path.join(root, 'public/index.html'),
    '/xterm.js': require.resolve('@xterm/xterm'),
    '/addon-fit.js': require.resolve('@xterm/addon-fit'),
    '/xterm.css': require.resolve('@xterm/xterm/css/xterm.css'),
  };
  const terms = [{ id: '1', title: 'AGY test', agent: 'agy', agy: true, pid: 999999, cwd: 'D:\\demo', exited: null, cols: 80, rows: 24 }, { id: '2', title: 'Codex test', agent: 'codex', cwd: 'D:\\demo', exited: null, cols: 80, rows: 24 }];
  terms[0].liveTitle = 'D:/tools/agy.exe';
  terms[0].title = 'agy';
  const sessions = [{ sessionId: 'aaaaaaaa-bbbb-cccc-dddd-000000000001', agent: 'agy', title: '<environment_context>fixture</environment_context>', firstPrompt: 'AGY test history', mtime: Date.now() }];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (handleRoute && await handleRoute(url, req, res)) return;
    const json = obj => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(obj)); };
    if (url.pathname === '/api/recent/hide') {
      let body = ''; for await (const chunk of req) body += chunk;
      store.hide(JSON.parse(body).id);
      return json({ ok: true });
    }
    if (url.pathname === '/api/projects/accounts') return json({ accounts: url.searchParams.get('agent') === 'agy' ? [{ id: 'agy-a', label: 'AGY A' }, { id: 'agy-b', label: 'AGY B' }] : [] });
    if (url.pathname === '/api/projects/plan') {
      let body = ''; for await (const chunk of req) body += chunk;
      const draft = JSON.parse(body);
      if (draft.agent !== 'agy' || draft.account !== 'agy-a') return json({ error: 'Expected the selected CLI and account' });
      return json({ tasks: ['Design', 'Implement', 'Verify'].map((title, i) => ({
        id: 'draft-' + i, title, detail: ['Define scope', 'Implement the scope', 'Check the result'][i], stage: 'planned', termId: '',
        after: i ? ['draft-' + (i - 1)] : [],
      })) });
    }
    if (url.pathname === '/api/term/new' && req.method === 'POST') {
      let body = ''; for await (const chunk of req) body += chunk;
      const { kind, resume } = JSON.parse(body);
      if (kind !== 'agy' || resume !== sessions[0].sessionId) return json({ error: 'Expected the selected AGY conversation' });
      const t = { ...terms[0], id: String(terms.length + 1) };
      terms.push(t);
      return json(t);
    }
    if (url.pathname === '/api/term/send') {
      let body = ''; for await (const chunk of req) body += chunk;
      const { id, text, submit } = JSON.parse(body);
      return json({ ok: terms.some((t) => t.id === String(id)) && Boolean(text && submit) });
    }
    if (url.pathname === '/api/projects/autopilot/complete') {
      let body = ''; for await (const chunk of req) body += chunk;
      const { projectId, taskId, force, async } = JSON.parse(body);
      const task = store.list().find((project) => project.id === projectId)?.tasks.find((item) => item.id === taskId);
      return json({ ok: true, queued: Boolean(force && async && task?.stage === 'review') });
    }
    if (url.pathname === '/api/projects/start' && req.method === 'POST') {
      let body = ''; for await (const chunk of req) body += chunk;
      const { projectId, taskId, resume } = JSON.parse(body);
      const p = store.list().find(x => x.id === projectId);
      const task = p?.tasks.find(t => t.id === taskId);
      if (!task || resume) return json({ error: 'Expected a fresh Project task' });
      const existing = terms.find(t => t.projectTask?.projectId === projectId && t.projectTask.taskId === taskId);
      if (existing) return json({ ...existing, existing: true });
      const agent = task.agent || p.agent;
      const account = task.account ?? (agent === p.agent ? p.account : '');
      const t = { ...terms[1], id: String(terms.length + 1), title: task.title, agent, agy: agent === 'agy',
        cwd: p.versions?.find((item) => item.number === task.version)?.workspace || p.cwd,
        account: account ? { id: account, label: account === 'agy-b' ? 'AGY B' : 'AGY A' } : null, projectTask: { projectId, taskId } };
      terms.push(t);
      store.save({ ...p, tasks: p.tasks.map(x => x.id === taskId && x.stage === 'planned' ? { ...x, stage: 'doing' } : x) },
        { taskRun: { taskId, run: { agent, source: task.agent ? 'task' : 'project', termId: t.id } } });
      if (t.agy) setTimeout(() => { t.sessionId = 'aaaaaaaa-bbbb-cccc-dddd-000000000002'; }, 300);
      return json(t);
    }
    if (url.pathname === '/api/projects/task-chat') {
      const projectId = url.searchParams.get('projectId') || '';
      const taskId = url.searchParams.get('taskId') || '';
      if (req.method === 'GET') return json({ chats: store.listSubChats(projectId, taskId), vaultRuns: store.vaultRuns(projectId, taskId), active: null });
    }
    if (url.pathname === '/api/fs/dirs') {
      const reqP = url.searchParams.get('path') || 'D:\\demo';
      return json({
        host: 'TEST-PC', current: reqP, parent: 'D:\\', drives: ['C:\\', 'D:\\'],
        dirs: [{ name: 'src', path: reqP + '\\src', markers: ['Git', 'Node.js'] }],
        files: ['package.json', 'README.md'],
        quick: [{ path: 'D:\\demo', label: 'demo', kind: 'project' }],
        info: { exists: true, isExistingProject: true, fileCount: 12, markers: ['Git', 'Node.js'] },
        targetInfo: { exists: true, isExistingProject: true, fileCount: 12, markers: ['Git', 'Node.js'], isInternal: false },
      });
    }
    if (url.pathname === '/api/projects') {
      if (req.method === 'GET') return json({ projects: store.list().map((pr) => ({ ...pr, tokens: store.tokenSummary(pr.id), subChats: store.allSubChats(pr.id) })), defaultCwd: 'D:\\demo\\projects' });
      let body = ''; for await (const chunk of req) body += chunk;
      if (req.method === 'DELETE') {
        const { id, revision, stopRunning } = JSON.parse(body);
        if (!stopRunning) return json({ error: 'Missing terminal stop confirmation' });
        return json({ removed: store.remove(id, revision) });
      }
      try { return json({ project: store.save(JSON.parse(body)) }); }
      catch (e) { return json({ error: e.message }); }
    }
    const responses = {
      '/api/overview': { terms, consoles: [], live: [], consolesOff: true },
      '/api/recent': { sessions: sessions.filter(s => !store.hidden().has(s.sessionId)) }, '/api/research': {}, '/api/usage': { available: false },
      '/api/calendar': { items: [] }, '/api/gpu': { gpus: [] },
      '/api/transcript': { messages: [{ role: 'user', text: 'AGY test history' }, { role: 'assistant', text: 'History displayed' }], size: 2, total: 2 },
    };
    if (url.pathname.startsWith('/api/')) return json(responses[url.pathname] || {});
    const file = assets[url.pathname] || path.join(root, 'public', path.basename(url.pathname));
    res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
    fs.createReadStream(file).on('error', () => { res.statusCode = 404; res.end(); }).pipe(res);
  });
  const ws = new WebSocketServer({ server });
  ws.on('connection', c => c.send(JSON.stringify({ type: 'data', data: 'test terminal\r\n' })));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => { ws.close(); server.close(resolve); }) };
};
