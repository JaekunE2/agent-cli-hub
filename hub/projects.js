const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { validate } = require('./project-validation');
const handoffPhases = ['waiting', 'delivered', 'confirmed', 'received'];

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
    list: () => read().projects.map((project) => ({
      ...project,
      tasks: (project.tasks || []).map((task) => task.stage === 'review' && task.reviewPaused === undefined && ['rejected', 'error'].includes(task.reviewStatus)
        ? { ...task, stage: 'doing', reviewPaused: true } : task),
    })),
    hidden: () => new Set(read().hidden),
    records: id => read().links[id]?.ids || [],
    sessionOwners() {
      const data = read();
      const owners = new Map();
      for (const project of data.projects) {
        const link = data.links[project.id];
        for (const sid of link?.ids || []) {
          if (!owners.has(sid)) owners.set(sid, { projectId: project.id, taskId: link.tasks?.[sid] });
        }
      }
      return owners;
    },
    recordAgent: (id, sid) => read().links[id]?.agents?.[sid],
    recordAccount: (id, sid) => read().links[id]?.accounts?.[sid],
    recordTask: (id, sid) => read().links[id]?.tasks?.[sid],
    allSubChats: (projectId) => read().links[projectId]?.subChats || {},
    vaultRuns(projectId, taskId) {
      const byTask = read().links[projectId]?.vaultRuns;
      return byTask && Object.hasOwn(byTask, taskId) ? byTask[taskId] : [];
    },
    recordVaultRun(projectId, taskIds, area, agent, vault, at = Date.now()) {
      if (!vault) return;
      const data = read();
      const project = data.projects.find((p) => p.id === projectId);
      const ids = taskIds.filter((id) => project?.tasks.some((t) => t.id === id));
      if (!ids.length) return;
      const link = data.links[projectId] ||= { ids: [] };
      const byTask = link.vaultRuns = Object.assign(Object.create(null), link.vaultRuns);
      const run = { area, agent, at, applied: vault.applied, omitted: vault.omitted.map(({ id, reason }) => ({ id, reason })) };
      if (vault.error) run.error = vault.error;
      for (const id of ids) (byTask[id] ||= []).push(run);
      write(data);
    },
    listSubChats: (projectId, taskId) => read().links[projectId]?.subChats?.[taskId] || [],
    saveSubChat(projectId, taskId, chat) {
      if (!projectId || !taskId || !chat?.id) return null;
      const data = read();
      const link = data.links[projectId] ||= { ids: [] };
      const byTask = (link.subChats ||= {});
      const list = (byTask[taskId] ||= []);
      const idx = list.findIndex((c) => c.id === chat.id);
      const next = {
        id: String(chat.id),
        title: String(chat.title || '서브 개발 채팅').slice(0, 120),
        agent: String(chat.agent || 'codex'),
        account: String(chat.account || ''),
        model: String(chat.model || ''),
        effort: String(chat.effort || ''),
        sessionId: chat.sessionId ? String(chat.sessionId) : '',
        createdAt: chat.createdAt || Date.now(),
        updatedAt: Date.now(),
        messages: Array.isArray(chat.messages) ? chat.messages.slice(-120).map((m) => ({
          role: m.role === 'user' ? 'user' : 'assistant',
          text: String(m.text || '').slice(0, 12000),
          ts: m.ts || new Date().toISOString(),
        })) : [],
      };
      if (idx >= 0) list[idx] = next;
      else list.push(next);
      write(data);
      return next;
    },
    deleteSubChat(projectId, taskId, chatId) {
      const data = read();
      const list = data.links[projectId]?.subChats?.[taskId];
      if (!Array.isArray(list)) return false;
      const next = list.filter((c) => c.id !== chatId);
      if (next.length === list.length) return false;
      data.links[projectId].subChats[taskId] = next;
      write(data);
      return true;
    },
    hide(id) {
      const data = read();
      if (add(data.hidden, id)) write(data);
    },
    // Persistent multi-CLI session & token ledger: switching a task's CLI NEVER discards prior CLI tokens.
    remember(pairs) {
      if (!pairs.length) return;
      const data = read();
      let changed = false;
      for (const { projectId, sessionId, taskId, version, agent, accountId, tokens } of pairs) {
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
        const taskVersion = taskId ? data.projects.find((p) => p.id === projectId)?.tasks.find((task) => task.id === taskId)?.version : undefined;
        const sessionVersion = taskVersion ?? version;
        if (sessionVersion !== undefined && link.versions?.[sessionId] !== sessionVersion) {
          (link.versions ||= {})[sessionId] = sessionVersion;
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
    // Also computes `rollupByTask`, which rolls every descendant subtask's tokens up to its ancestor/top-level tasks!
    tokenSummary(projectId, liveResolver = null) {
      const data = read();
      const link = data.links[projectId];
      const project = data.projects.find((p) => p.id === projectId);
      const total = emptyTok();
      const byAgent = {};
      const byTask = {};
      const byVersion = {};
      const rollupByTask = {};
      if (!link) return { total, byAgent, byTask, byVersion, rollupByTask, sessions: 0 };
      const tasks = project?.tasks || [];
      const versionsByTask = new Map(tasks.map((task) => [task.id, task.version || '']));
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
        const version = versionsByTask.get(tid) ?? link.versions?.[sid];
        if (version !== undefined) {
          const entry = (byVersion[version] ||= { total: emptyTok(), byAgent: {}, sessions: 0 });
          addTok(entry.total, tok);
          addTok(entry.byAgent[ag] ||= emptyTok(), tok);
          entry.sessions++;
        }
        if (tid) {
          const tEntry = (byTask[tid] ||= { total: emptyTok(), byAgent: {}, sessions: 0 });
          addTok(tEntry.total, tok);
          addTok(tEntry.byAgent[ag] ||= emptyTok(), tok);
          tEntry.sessions++;
        }
      }

      // Build hierarchical rollup so any parent/top-level task includes its own tokens + all descendant subtasks' tokens
      const childrenByParent = new Map();
      const taskIdSet = new Set(tasks.map((t) => t.id));
      for (const t of tasks) {
        if (t.parentId && t.parentId !== t.id && versionsByTask.get(t.parentId) === versionsByTask.get(t.id)) {
          (childrenByParent.get(t.parentId) || childrenByParent.set(t.parentId, []).get(t.parentId)).push(t.id);
        }
      }
      const allTaskIds = new Set([...taskIdSet, ...Object.keys(byTask)]);
      for (const rootId of allTaskIds) {
        const own = byTask[rootId];
        const rTotal = emptyTok();
        const oTotal = emptyTok();
        const sTotal = emptyTok();
        const rByAgent = {};
        let rSessions = 0;
        let subSessions = 0;
        if (own) {
          addTok(rTotal, own.total);
          addTok(oTotal, own.total);
          rSessions += own.sessions || 0;
          for (const [ag, v] of Object.entries(own.byAgent || {})) addTok(rByAgent[ag] ||= emptyTok(), v);
        }
        // Traverse all descendant subtasks (BFS with cycle guard)
        const queue = [...(childrenByParent.get(rootId) || [])];
        const visited = new Set([rootId]);
        while (queue.length) {
          const cid = queue.shift();
          if (visited.has(cid)) continue;
          visited.add(cid);
          const cData = byTask[cid];
          if (cData) {
            addTok(rTotal, cData.total);
            addTok(sTotal, cData.total);
            rSessions += cData.sessions || 0;
            subSessions += cData.sessions || 0;
            for (const [ag, v] of Object.entries(cData.byAgent || {})) addTok(rByAgent[ag] ||= emptyTok(), v);
          }
          for (const nxt of (childrenByParent.get(cid) || [])) {
            if (!visited.has(nxt)) queue.push(nxt);
          }
        }
        rollupByTask[rootId] = {
          total: rTotal,
          ownTotal: oTotal,
          subTotal: sTotal,
          byAgent: rByAgent,
          sessions: rSessions,
          subSessions,
          subtaskCount: visited.size - 1,
        };
      }

      return { total, byAgent, byTask, byVersion, rollupByTask, sessions: counted };
    },
    remove(id, revision) {
      const data = read();
      const project = data.projects.find(p => p.id === id);
      if (!project) throw new Error('Project를 찾을 수 없습니다.');
      if (project.revision !== revision) throw new Error('다른 화면에서 변경했습니다. 새로고침 후 다시 삭제하세요.');
      const link = data.links[id] ||= { ids: [] };
      link.deleted = true;
      delete link.vaultRuns;
      for (const sid of link.ids) add(data.hidden, sid);
      data.projects = data.projects.filter(p => p.id !== id);
      write(data);
      return link.ids.length;
    },
    advanceHandoff({ projectId, taskId }, termId, dispatchAt, phase) {
      const data = read();
      const project = data.projects.find((p) => p.id === projectId);
      const task = project?.tasks.find((t) => t.id === taskId);
      const handoff = task?.handoff;
      const next = handoffPhases.indexOf(phase);
      if (!project?.autopilot || !handoff || task.stage !== 'doing' || task.autoExclude || task.reviewPaused
        || task.lastRun?.termId !== termId || next < 1 || handoff.history.length !== next) return false;
      if (next === 1) {
        const done = new Set(project.tasks.filter((t) => t.stage === 'done').map((t) => t.id));
        if (handoff.termId || dispatchAt < handoff.history[0].at || !task.after.every((id) => done.has(id))) return false;
      } else if (handoff.termId !== termId || handoff.history[1].at !== dispatchAt) return false;
      handoff.termId = termId;
      handoff.history.push({ phase, at: next === 1 ? dispatchAt : Date.now() });
      project.revision++;
      project.updatedAt = Date.now();
      write(data);
      return true;
    },
    save(input, { taskRun } = {}) {
      const clean = validate(input), data = read(), all = data.projects;
      const old = input.id && all.find(p => p.id === input.id);
      if (input.id && !old) throw new Error('프로젝트를 찾을 수 없습니다.');
      if (old && input.revision !== old.revision) throw new Error('다른 화면에서 변경했습니다. 새로고침 후 다시 저장하세요.');
      const project = { ...clean, id: old?.id || randomUUID(), revision: (old?.revision || 0) + 1, updatedAt: Date.now() };
      const vaultRuns = data.links[project.id]?.vaultRuns;
      if (vaultRuns) {
        const taskIds = new Set(project.tasks.map((task) => task.id));
        for (const id of Object.keys(vaultRuns)) if (!taskIds.has(id)) delete vaultRuns[id];
      }
      if (old && !old.agent && !input.agent) delete project.agent;
      const priorTasks = new Map(old?.tasks?.map((task) => [task.id, task]));
      for (const task of project.tasks) {
        const prior = priorTasks.get(task.id);
        const newRun = task.id === taskRun?.taskId;
        const lastRun = newRun ? taskRun.run : prior?.lastRun;
        if (lastRun) task.lastRun = lastRun;
        if (task.stage === 'planned' || (task.stage === 'doing' && prior?.stage === 'planned' && !newRun)) {
          if (project.autopilot && !task.autoExclude && task.after.length) {
            task.handoff = prior?.stage === 'planned' && prior.handoff
              ? prior.handoff : { history: [{ phase: 'waiting', at: Date.now() }] };
          }
        } else if (prior?.handoff && (!newRun || taskRun.trackHandoff || prior.handoff.termId)) {
          task.handoff = prior.handoff;
        }
      }
      if (old) all[all.indexOf(old)] = project; else all.push(project);
      write(data);
      return project;
    },
  };
};
