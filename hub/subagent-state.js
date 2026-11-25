'use strict';

const { spawnTools, followTools, toolName, decode, outputText } = require('./subagent-events');
const { safeId } = require('./subagent-files');

function applyEvent(state, event, agent) {
  const { calls, pending } = state;
  const { id, input, ts } = event;
  const tool = toolName(event.tool);
  if (event.type === 'child-link' && safeId(event.childId)) {
    const call = calls.get(id);
    if (call) Object.assign(call, { childSessionId: event.childId, agentPath: event.agentPath });
    return;
  }
  if (event.type === 'child-status') {
    const child = [...calls.values()].find(call => event.childId ? call.childSessionId === event.childId : event.agentPath && call.agentPath === event.agentPath);
    if (child && ts >= (child.resumedAt || child.startedAt)) finish(child, event.status, ts, event.text);
    return;
  }
  if (event.type === 'call' && id && spawnTools.test(tool)) {
    const call = calls.get(id) || { id, agent, tool, status: 'running', startedAt: ts, finishedAt: null };
    const prompt = input?.prompt || input?.message || input?.task || input?.Prompt;
    if (typeof prompt === 'string' && !/^gAAAAA[\w=-]{50,}$/.test(prompt)) {
      call.prompt = agent === 'agy' && prompt.startsWith('"') ? decode(prompt) : prompt;
    }
    call.description = input?.description || input?.toolSummary || input?.Role || call.description || '';
    call.name = input?.subagent_type || input?.agent_type || input?.task_name || decode(input?.TypeName) || call.name || tool;
    calls.set(id, call);
    return;
  }
  if (event.type === 'call' && id && followTools.test(tool) && agent === 'codex') {
    pending.set(id, { tool, input });
    return;
  }
  if (event.type !== 'result') return;
  const output = decode(event.output);
  const text = outputText(output);
  const conversation = output?.conversationId || output?.conversation_id || /["']?conversationId["']?\s*[:=]\s*["']?([\w-]{8,100})/i.exec(text)?.[1];
  let call = calls.get(id);
  if (!call && id && spawnTools.test(tool) && input) {
    applyEvent(state, { type: 'call', tool, id, ts, input }, agent);
    call = calls.get(id);
  }
  if (!call && !id && agent === 'agy' && (conversation || tool === 'invoke_subagent')) {
    const matches = [...calls.values()].filter(c => c.status === 'running' && !c.childSessionId && c.startedAt <= ts);
    if (matches.length === 1) call = matches[0];
  }
  if (call && (!call.resultAt || call.resultAt <= ts)) {
    call.resultAt = ts;
    if (!conversation && (output?.content || output?.summary || !output?.task_name)) {
      call.lastMessage = outputText(output?.content ?? output?.summary ?? output).slice(0, 6000);
    }
    const child = output?.agentId || output?.agent_id || event.subagentId || /\bagentId:\s*([\w-]+)/.exec(text)?.[1];
    if (agent === 'claude' && safeId(child)) call.childId = child;
    const target = agent === 'codex' ? child : conversation;
    if (agent !== 'claude' && safeId(target)) call.childSessionId = target;
    if (output?.nickname) call.name = output.nickname;
    const background = /^async_launched$/i.test(output?.status || '') || /async agent launched|running in the background/i.test(text);
    const failed = event.failed || /^(?:failed|error|cancelled|stopped)$/.test(output?.status || '');
    const done = /^(?:completed|done|success)$/.test(output?.status || '');
    if (failed || done || (!background && agent === 'claude')) finish(call, failed ? 'stopped' : 'done', ts);
    return;
  }
  const follow = pending.get(id);
  if (!follow) return;
  pending.delete(id);
  for (const child of calls.values()) {
    const target = child.childSessionId;
    if (!target || event.failed || output?.error) continue;
    const recipient = follow.input?.id || follow.input?.agent_id || follow.input?.target;
    const addressed = recipient === target || recipient && recipient === child.agentPath;
    if (follow.tool === 'send_input' && addressed) {
      if (!ts || ts > (child.stoppedAt || 0)) Object.assign(child, { status: 'running', resumedAt: ts, finishedAt: null, lastMessage: '', stoppedAt: null });
    } else if (follow.tool === 'close_agent' && addressed) {
      finish(child, 'stopped', ts);
    } else if (output?.status && Object.hasOwn(output.status, target)) {
      const result = output.status[target];
      if (result && typeof result === 'object' && Object.hasOwn(result, 'completed')) finish(child, 'done', ts, result.completed);
      else if (result === 'completed') finish(child, 'done', ts);
      else if (result?.errored || ['shutdown', 'notFound'].includes(result)) finish(child, 'stopped', ts, outputText(result));
    }
  }
}

function finish(call, status, ts, message) {
  if (message) call.lastMessage = String(message).slice(0, 6000);
  if (call.stoppedAt && (!ts || ts > call.stoppedAt)) return;
  call.status = status;
  call.finishedAt = ts || Date.now();
}

module.exports = { applyEvent, finish };
