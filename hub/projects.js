const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { validate } = require('./project-validation');

const emptyTok = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
function addTok(dst, src) {
  if (!src) return dst;
  dst.input += Math.max(0, Number(src.input) || 0);
  dst.output += Math.max(0, Number(src.output) || 0);
  dst.cacheRead += Math.max(0, Number(src.cacheRead) || 0);
  dst.cacheWrite += Math.max(0, Number(src.cacheWrite) || 0);
  dst.total += Math.max(0, Number(src.total) || ((Number(src.input) || 0) + (Number(src.output) || 0) + (Number(src.cacheRead) || 0) + (Number(src.cacheWrite) || 0)));
  return dst;
}
function mergeMonotonicTok(prev, next) {
  const p = prev || emptyTok();
  const n = next || emptyTok();
  const input = Math.max(p.input || 0, Math.max(0, Number(n.input) || 0));
  const output = Math.max(p.output || 0, Math.max(0, Number(n.output) || 0));
  const cacheRead = Math.max(p.cacheRead || 0, Math.max(0, Number(n.cacheRead) || 0));
  const cacheWrite = Math.max(p.cacheWrite || 0, Math.max(0, Number(n.cacheWrite) || 0));
  const total = Math.max(p.total || 0, Number(n.total) || 0, input + output + cacheRead + cacheWrite);
  return { input, output, cacheRead, cacheWrite, total };
}

module.exports = function projects(file = path.join(__dirname, 'data', 'projects.json')) {
  const read = () => {
    let data;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; data = []; }
    return Array.isArray(data) ? { projects: data, links: {}, hidden: [] } : data;
  };
  const write = data => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  };
  const add = (list, id) => {
    if (!id || list.includes(id)) return false;
    list.push(id);
    return true;
  };
  return {
    list: () => read().projects,
    hidden: () => new Set(read().hidden),
    records: id => read().links[id]?.ids || [],
    recordAgent: (id, sid) => read().links[id]?.agents?.[sid],
    recordAccount: (id, sid) => read().links[id]?.accounts?.[sid],
    recordTask: (id, sid) => read().links[id]?.tasks?.[sid],
    hide(id) {
      const data = read();
      if (add(data.hidden, id)) write(data);
    },
    // Persistent multi-CLI session & token ledger: switching a task's CLI NEVER discards prior CLI tokens.
    remember(pairs) {
      if (!pairs.length) return;
      const data = read();
      let changed = false;
      for (const { projectId, sessionId, taskId, agent, accountId, tokens } of pairs) {
        if (!sessionId) continue;
        if (!Object.hasOwn(data.links, projectId) && !data.projects.some(p => p.id === projectId)) continue;
        const link = data.links[projectId] ||= { ids: [] };
        changed = add(link.ids, sessionId) || changed;
        if (agent && link.agents?.[sessionId] !== agent) {
          (link.agents ||= {})[sessionId] = agent;
          changed = true;
        }
        if (accountId && link.accounts?.[sessionId] !== accountId) {
          (link.accounts ||= {})[sessionId] = accountId;
          changed = true;
        }
        if (taskId && link.tasks?.[sessionId] !== taskId) {
          (link.tasks ||= {})[sessionId] = taskId;
          changed = true;
        }
        if (tokens && typeof tokens === 'object') {
          const ledger = (link.tokenLedger ||= {});
          const prev = ledger[sessionId];
          const merged = mergeMonotonicTok(prev, tokens);
          const nextEntry = {
            taskId: taskId || prev?.taskId || link.tasks?.[sessionId] || null,
            agent: agent || prev?.agent || link.agents?.[sessionId] || 'unknown',
            accountId: accountId || prev?.accountId || link.accounts?.[sessionId] || null,
            ...merged,
            updatedAt: Date.now(),
          };
          if (!prev
            || prev.input !== nextEntry.input || prev.output !== nextEntry.output
            || prev.cacheRead !== nextEntry.cacheRead || prev.cacheWrite !== nextEntry.cacheWrite
            || prev.total !== nextEntry.total || prev.taskId !== nextEntry.taskId || prev.agent !== nextEntry.agent) {
            ledger[sessionId] = nextEntry;
            changed = true;
          }
        }
        if (link.deleted) changed = add(data.hidden, sessionId) || changed;
      }
      if (changed) write(data);
    },
    // Aggregate cumulative tokens across ALL CLIs (Claude / Codex / AGY / Cursor) ever used for a Project & each Task.
    tokenSummary(projectId, liveResolver = null) {
      const data = read();
      const link = data.links[projectId];
      const total = emptyTok();
      const byAgent = {};
      const byTask = {};
      if (!link) return { total, byAgent, byTask, sessions: 0 };
      const allSids = new Set([...(link.ids || []), ...Object.keys(link.tokenLedger || {})]);
      let counted = 0;
      for (const sid of allSids) {
        const stored = link.tokenLedger?.[sid];
        const live = typeof liveResolver === 'function' ? liveResolver(sid) : null;
        const tok = mergeMonotonicTok(stored, live);
        if (!tok.total) continue;
        counted++;
        const ag = stored?.agent || link.agents?.[sid] || 'unknown';
        const tid = stored?.taskId || link.tasks?.[sid] || null;
        addTok(total, tok);
        addTok(byAgent[ag] ||= emptyTok(), tok);
        if (tid) {
          const tEntry = (byTask[tid] ||= { total: emptyTok(), byAgent: {}, sessions: 0 });
          addTok(tEntry.total, tok);
          addTok(tEntry.byAgent[ag] ||= emptyTok(), tok);
          tEntry.sessions++;
        }
      }
      return { total, byAgent, byTask, sessions: counted };
    },
    remove(id, revision) {
      const data = read();
      const project = data.projects.find(p => p.id === id);
      if (!project) throw new Error('Project를 찾을 수 없습니다.');
      if (project.revision !== revision) throw new Error('다른 화면에서 변경했습니다. 새로고침 후 다시 삭제하세요.');
      const link = data.links[id] ||= { ids: [] };
      link.deleted = true;
      for (const sid of link.ids) add(data.hidden, sid);
      data.projects = data.projects.filter(p => p.id !== id);
      write(data);
      return link.ids.length;
    },
    save(input) {
      const clean = validate(input), data = read(), all = data.projects;
      const old = input.id && all.find(p => p.id === input.id);
      if (input.id && !old) throw new Error('프로젝트를 찾을 수 없습니다.');
      if (old && input.revision !== old.revision) throw new Error('다른 화면에서 변경했습니다. 새로고침 후 다시 저장하세요.');
      const project = { ...clean, id: old?.id || randomUUID(), revision: (old?.revision || 0) + 1, updatedAt: Date.now() };
      if (old) all[all.indexOf(old)] = project; else all.push(project);
      write(data);
      return project;
    },
  };
};
