'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { existing, transcriptFile, readEvents, safeId, safeTermId, parentSession } = require('./subagent-files');
const { applyEvent, finish } = require('./subagent-state');

const monitors = new WeakMap();
const getTerm = (hub, id) => safeTermId(id) && hub.terms.get(String(id));
function scopeFor(hub, { termId, sessionId, agent } = {}) {
  let term = getTerm(hub, termId);
  if (termId && !term) return null;
  if (!term && sessionId) term = [...hub.terms.values()].find(t => parentSession(hub, t) === sessionId);
  const linked = parentSession(hub, term);
  if (linked && sessionId && linked !== sessionId) return null;
  const sid = linked || sessionId;
  if (!term && !safeId(sid)) return null;
  let scopes = monitors.get(hub);
  if (!scopes) monitors.set(hub, scopes = new Map());
  const key = term ? `term:${term.id}` : sid;
  let state = scopes.get(key);
  if (!state || (state.sessionId && sid && state.sessionId !== sid)) {
    if (scopes.size >= 256 && !scopes.has(key)) scopes.delete(scopes.keys().next().value);
    scopes.set(key, state = { calls: new Map(), pending: new Map(), cursor: {}, children: new Map() });
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
  if (unmatched.length && fs.existsSync(dir)) for (const name of fs.readdirSync(dir)) {
    const id = /^agent-([\w-]+)\.jsonl$/.exec(name)?.[1];
    if (!id || [...state.calls.values()].some(call => call.childId === id)) continue;
    const file = existing(path.join(dir, name));
    if (!file) continue;
    let prompt;
    readEvents(file, {}, e => { if (e.type === 'user') prompt ??= e.text; }, 256_000, true);
    const matches = unmatched.filter(call => !call.childId && call.prompt === prompt);
    if (matches.length === 1) matches[0].childId = id;
  }
  for (const call of state.calls.values()) {
    if (safeId(call.childId)) call.logPath = existing(path.join(dir, `agent-${call.childId}.jsonl`));
  }
}

function sync(hub, state) {
  const { term, agent, calls } = state;
  readEvents(state.file, state.cursor, e => {
    applyEvent(state, e, agent);
    if (e.type === 'terminal-status') state.parentEnd = e.ts;
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
  state.parentStatus = status;
  for (const call of calls.values()) {
    if (call.targetSessionId && (!call.targetTermId || !hub.terms.has(call.targetTermId))) {
      const target = [...hub.terms.values()].find(t => t !== term && parentSession(hub, t) === call.targetSessionId);
      call.targetTermId = target ? String(target.id) : undefined;
    }
    const activeAt = call.resumedAt || call.startedAt;
    if (call.status === 'running' && call.targetSessionId) {
      let child = state.children.get(call.targetSessionId);
      if (!child) state.children.set(call.targetSessionId, child = { cursor: {} });
      readEvents(transcriptFile(hub, call.targetSessionId, term), child.cursor, e => {
        if (e.type === 'assistant' && e.text) child.lastMessage = e.text;
        if (e.type === 'terminal-status') child.end = e;
      });
      if (child.end && child.end.ts >= activeAt) finish(call, child.end.status, child.end.ts, child.lastMessage);
    }
    if (call.status === 'running' && (status === 'exited' || (status === 'idle' && now - activeAt >= 650)
      || (state.parentEnd && activeAt <= state.parentEnd)
      || (term?._subagentsInterruptedAt && activeAt <= term._subagentsInterruptedAt))) finish(call, 'stopped', now);
  }
  if (calls.size > 200) for (const [id, call] of calls) {
    if (call.status !== 'running') calls.delete(id);
    if (calls.size <= 200) break;
  }
}

function listCalls(hub, params) {
  const state = scopeFor(hub, params);
  if (!state) return [];
  sync(hub, state);
  const items = [...state.calls.values()];
  const parent = state.term;
  if (parent) for (const child of hub.terms.values()) {
    if (child === parent || String(child.meta?.parentTermId ?? child.meta?.projectTask?.parentTermId ?? '') !== String(parent.id)) continue;
    if (items.some(item => item.targetTermId === String(child.id))) continue;
    const startedAt = child.startedAt || child.meta?.spawnedAt || 0;
    const stopped = parent.exited != null || startedAt <= (parent._subagentsInterruptedAt || 0)
      || (state.parentStatus === 'idle' && Date.now() - startedAt >= 650);
    items.push({
      id: `term:${child.id}`, agent: hub.agentOf?.(child) || 'cursor', tool: 'Hub',
      name: child.meta?.customTitle || child.title, description: '', targetTermId: String(child.id),
      status: child.exited === 0 ? 'done' : stopped || child.exited != null ? 'stopped' : 'running',
      startedAt, finishedAt: child.exitedAt || null,
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
  if (!call || (logPath && logPath !== call.logPath)) return { ok: false, error: '서브에이전트를 찾을 수 없습니다.' };
  const events = [];
  let latest = '';
  readEvents(call.logPath, {}, e => {
    if (e.type === 'assistant' && e.text) latest = e.text;
    if (e.type === 'call' || e.type === 'result') events.push(e);
  }, 500_000);
  const lastMessage = (call.status === 'done' && call.lastMessage) || latest || call.lastMessage || '';
  return { ok: true, prompt: call.prompt || '', events: events.slice(-100), lastMessage, status: call.status };
}

function recordHook(hub, data) {
  const term = getTerm(hub, data.termId);
  if (!term) return;
  if (safeId(data.sessionId)) term._subagentSessionId = data.sessionId;
  const state = scopeFor(hub, { termId: data.termId });
  if (!state) return;
  applyEvent(state, data.event, state.agent);
  return { type: 'hook-event', termId: String(term.id), sessionId: state.sessionId };
}

module.exports = { listSubagents, readSubagentDetail, recordHook };
