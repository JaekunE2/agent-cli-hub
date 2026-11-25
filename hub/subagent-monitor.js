'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { existing, transcriptFile, readEvents, safeId, safeTermId, parentSession } = require('./subagent-files');
const { applyEvent, finish } = require('./subagent-state');
const { outputText } = require('./subagent-events');

const monitors = new WeakMap();
const getTerm = (hub, id) => safeTermId(id) && hub.terms.get(String(id));
function scopeFor(hub, { termId, sessionId, agent } = {}) {
  if (sessionId?.startsWith('term:')) {
    const id = sessionId.slice(5);
    if (termId && termId !== id) return null;
    termId = id;
    sessionId = '';
  }
  let term = getTerm(hub, termId);
  if (termId && !term) return null;
  if (!term && sessionId) term = [...hub.terms.values()].find(t => parentSession(hub, t) === sessionId);
  const linked = parentSession(hub, term);
  if (term && sessionId && linked !== sessionId) return null;
  const sid = linked || sessionId;
  if (!term && (!safeId(sid) || !transcriptFile(hub, sid))) return null;
  let scopes = monitors.get(hub);
  if (!scopes) monitors.set(hub, scopes = new Map());
  const key = term ? `term:${term.id}` : sid;
  let state = scopes.get(key);
  if (!state || (state.sessionId && sid && state.sessionId !== sid)) {
    if (scopes.size >= 256 && !scopes.has(key)) scopes.delete(scopes.keys().next().value);
    state = (term && sid && scopes.get(sid)) || { calls: new Map(), pending: new Map(), cursor: {}, children: new Map(), hooks: new Set(), workers: new Map() };
    scopes.set(key, state);
    if (term && sid) scopes.delete(sid);
  }
  const file = transcriptFile(hub, sid, term);
  if (file !== state.file) state.cursor = {};
  Object.assign(state, { sessionId: sid, file, term, agent: (term && hub.agentOf?.(term)) || hub.index?.get(sid)?.agent || agent || 'claude' });
  return state;
}

function claudeLogs(state) {
  if (!state.file || state.agent !== 'claude') return;
  const dir = path.join(path.dirname(state.file), path.basename(state.file, '.jsonl'), 'subagents');
  const unmatched = [...state.calls.values()].filter(call => !call.childId && call.prompt);
  const candidates = new Map();
  if (unmatched.length && fs.existsSync(dir)) for (const name of fs.readdirSync(dir)) {
    const id = /^agent-([\w-]+)\.jsonl$/.exec(name)?.[1];
    if (!id || [...state.calls.values()].some(call => call.childId === id)) continue;
    const file = existing(path.join(dir, name));
    if (!file) continue;
    let first;
    readEvents(file, {}, e => { if (e.type === 'user') first ??= e; }, 256_000, true);
    const matches = unmatched.filter(call => call.prompt === first?.text && (!first.ts || first.ts >= call.startedAt - 2000));
    if (matches.length === 1) {
      const call = matches[0];
      candidates.set(call, candidates.has(call) ? null : id);
    }
  }
  for (const [call, id] of candidates) if (id) call.childId = id;
  for (const call of state.calls.values()) {
    if (safeId(call.childId)) call.logPath = existing(path.join(dir, `agent-${call.childId}.jsonl`));
  }
}

function sync(hub, state) {
  const { term, agent, calls } = state;
  for (const hook of hub.toolHooks?.getSubagentEvents?.({ termId: term?.id, sessionId: state.sessionId }) || []) {
    if (state.sessionId && hook.sessionId && state.sessionId !== hook.sessionId) continue;
    if (!hook.sessionId && term?.startedAt && hook.ts < term.startedAt) continue;
    const id = `${hook.callId}:${hook.status}:${hook.ts}`;
    if (state.hooks.has(id)) continue;
    state.hooks.add(id);
    if (state.hooks.size > 600) state.hooks.delete(state.hooks.values().next().value);
    applyEvent(state, {
      type: hook.status === 'start' ? 'call' : 'result', id: hook.callId, tool: hook.tool,
      input: hook.input, output: hook.output, subagentId: hook.subagentId, ts: hook.ts, failed: hook.status === 'error',
    }, agent);
  }
  readEvents(state.file, state.cursor, e => {
    applyEvent(state, e, agent);
    if ((e.type === 'terminal-status' || e.type === 'turn-aborted') && e.ts) {
      state.parentEnd = e.ts;
      for (const call of calls.values()) stopOrphan(call, e.ts);
    }
    const taskId = /<task-id>([\w-]+)<\/task-id>/.exec(e.text || '')?.[1];
    const status = /<status>(completed|failed|stopped|killed)<\/status>/.exec(e.text || '')?.[1];
    if (agent === 'claude' && e.type === 'user' && taskId && status) {
      for (const call of calls.values()) if (call.childId === taskId) {
        finish(call, status === 'completed' ? 'done' : 'stopped', e.ts, /<summary>([\s\S]*?)<\/summary>/.exec(e.text)?.[1]);
      }
    }
  });
  claudeLogs(state);
  const now = Date.now();
  const status = term && (term.exited != null ? 'exited' : term.status || hub[`${agent}Status`]?.(term));
  if (status === 'idle' && state.parentStatus === 'busy') state.idleAt = now;
  state.parentStatus = status;
  const stoppedAt = Math.max(state.idleAt || 0, state.parentEnd || 0, term?._subagentsInterruptedAt || 0,
    status === 'exited' ? term.exitedAt || now : 0);
  for (const call of calls.values()) {
    if (call.childSessionId) {
      const target = [...hub.terms.values()].find(t => t !== term && parentSession(hub, t) === call.childSessionId);
      call.targetTermId = target ? String(target.id) : undefined;
      call.logPath = transcriptFile(hub, call.childSessionId, term);
      call.targetSessionId = (hub.index?.get(call.childSessionId) || call.logPath) && !hub.projects?.hidden?.().has(call.childSessionId)
        ? call.childSessionId : undefined;
      let child = state.children.get(call.childSessionId);
      if (!child) state.children.set(call.childSessionId, child = { cursor: {} });
      readEvents(call.logPath, child.cursor, e => {
        if (e.type === 'assistant' && e.text) child.lastMessage = e.text;
        // Codex forks can copy an aborted parent turn into a still-running child log.
        if (e.type === 'terminal-status' || (agent === 'agy' && e.type === 'child-turn-complete')) child.end = e;
      });
      if (child.end && child.end.ts >= (call.resumedAt || call.startedAt) && (call.status === 'running' || call.stoppedAt)) {
        finish(call, child.end.status, child.end.ts, child.lastMessage);
      }
    }
    if (stoppedAt) stopOrphan(call, stoppedAt);
  }
  if (calls.size > 200) for (const [id, call] of calls) {
    if (call.status !== 'running') calls.delete(id);
    if (calls.size <= 200) break;
  }
}

function stopOrphan(call, cutoff) {
  if ((call.resumedAt || call.startedAt) > cutoff || call.stoppedAt) return;
  if (call.status !== 'running' && call.finishedAt <= cutoff) return;
  finish(call, 'stopped', cutoff);
  call.stoppedAt = cutoff;
}

function listCalls(hub, params) {
  const state = scopeFor(hub, params);
  if (!state) return [];
  sync(hub, state);
  const items = [...state.calls.values()];
  const parent = state.term;
  const task = parent?.meta?.projectTask;
  const project = task && hub.projects?.list?.().find(item => item.id === task.projectId);
  const parentTask = project?.tasks.find(item => item.id === task.taskId);
  if (parent) for (const child of hub.terms.values()) {
    if (child === parent) continue;
    const childLink = child.meta?.parentTermId ?? child.meta?.projectTask?.parentTermId;
    if (childLink != null) {
      if (String(childLink) !== String(parent.id)) continue;
    } else {
      const childTask = child.meta?.projectTask;
      const childMeta = childTask?.projectId === project?.id && project?.tasks.find(item => item.id === childTask?.taskId);
      if (!parentTask || !childMeta || childMeta.parentId !== parentTask.id || childMeta.version !== parentTask.version) continue;
      const matches = [...hub.terms.values()].filter(t => t.meta?.projectTask?.projectId === project.id && t.meta.projectTask.taskId === parentTask.id);
      if (matches.length !== 1) continue;
    }
    if (items.some(item => item.targetTermId === String(child.id))) continue;
    const startedAt = child.startedAt || child.meta?.spawnedAt || 0;
    const cutoff = Math.max(state.idleAt || 0, parent._subagentsInterruptedAt || 0, parent.exited != null ? parent.exitedAt || Date.now() : 0);
    if (cutoff && startedAt <= cutoff && !state.workers.has(child.id)) state.workers.set(child.id, cutoff);
    const stopped = state.workers.get(child.id);
    items.push({
      id: `term:${child.id}`, agent: hub.agentOf?.(child) || 'cursor', tool: 'Hub',
      name: child.meta?.customTitle || child.title, description: '', targetTermId: String(child.id),
      status: child.exited === 0 && (!stopped || child.exitedAt && child.exitedAt <= stopped) ? 'done' : stopped || child.exited != null ? 'stopped' : 'running',
      startedAt, finishedAt: stopped || child.exitedAt || null,
    });
  }
  return items.sort((a, b) => b.startedAt - a.startedAt);
}

function listSubagents(hub, params) {
  return listCalls(hub, params).map(({ id, agent, tool, name, description, status, startedAt, finishedAt, targetSessionId, targetTermId, logPath }) =>
    ({ id, agent, tool, name, description, status, startedAt, finishedAt, targetSessionId, targetTermId, logPath }));
}

function readSubagentDetail(hub, { id, logPath, ...params }) {
  const call = listCalls(hub, params).find(c => c.id === id);
  if (!call || (logPath && logPath !== call.logPath)) return {
    ok: false, ...(call && logPath ? { invalidPath: true } : {}), error: '서브에이전트를 찾을 수 없습니다.',
  };
  const events = [];
  let latest = '';
  readEvents(call.logPath, {}, e => {
    if (e.type === 'assistant' && e.text) latest = e.text;
    if (e.type === 'call' || e.type === 'result') {
      events.push({ id: e.id, ts: e.ts, type: e.type === 'call' ? 'tool' : 'result',
        tool: e.tool, text: outputText(e.input ?? e.output).slice(0, 4000) });
    }
    if (events.length > 100) events.shift();
  }, 500_000);
  const lastMessage = (call.status !== 'running' && call.lastMessage) || latest || call.lastMessage || '';
  return { ok: true, prompt: String(call.prompt || '').slice(0, 12_000), events, lastMessage: lastMessage.slice(0, 12_000), status: call.status };
}

function recordHook(hub, data) {
  const term = getTerm(hub, data.termId);
  if (!term) return;
  if (safeId(data.sessionId)) {
    const linked = parentSession(hub, term);
    if (linked && linked !== data.sessionId) return;
    if (!linked) term._subagentSessionId = data.sessionId;
  }
  const state = scopeFor(hub, { termId: data.termId });
  if (!state) return;
  applyEvent(state, data.event, state.agent);
  return { type: 'hook-event', termId: String(term.id), sessionId: state.sessionId };
}

module.exports = { listSubagents, readSubagentDetail, recordHook };
