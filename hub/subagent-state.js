'use strict';

const { spawnTools, followTools, toolName, decode, outputText } = require('./subagent-events');
const { safeId } = require('./subagent-files');

function applyEvent(state, event, agent) {
  const { calls, pending } = state;
  const { id, input, ts } = event;
  const tool = toolName(event.tool);
  if (event.type === 'call' && id && spawnTools.test(tool)) {
    const call = calls.get(id) || { id, agent, tool, status: 'running', startedAt: ts, finishedAt: null };
    call.prompt = input?.prompt || input?.message || input?.task || call.prompt || '';
    call.description = input?.description || input?.toolSummary || call.description || '';
    call.name = input?.subagent_type || input?.agent_type || call.name || tool;
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
    const matches = [...calls.values()].filter(c => c.status === 'running' && !c.targetSessionId && c.startedAt <= ts);
    if (matches.length === 1) call = matches[0];
  }
  if (call && (!call.resultAt || call.resultAt <= ts)) {
    call.resultAt = ts;
    call.lastMessage = outputText(output?.content ?? output?.summary ?? output).slice(0, 6000);
    const child = output?.agentId || output?.agent_id || /\bagentId:\s*([\w-]+)/.exec(text)?.[1];
    if (agent === 'claude' && safeId(child)) call.childId = child;
    const target = agent === 'codex' ? child : conversation;
    if (agent !== 'claude' && safeId(target)) call.targetSessionId = target;
    if (output?.nickname) call.name = output.nickname;
    const background = /^async_launched$/i.test(output?.status || '') || /async agent launched|running in the background/i.test(text);
    const failed = event.failed || /^(?:failed|error|cancelled|stopped)$/.test(output?.status || '');
    const done = /^(?:completed|done|success)$/.test(output?.status || '');
    if (failed || done || (!background && (agent === 'claude' || !call.targetSessionId))) finish(call, failed ? 'stopped' : 'done', ts);
    return;
  }
  const follow = pending.get(id);
  if (!follow) return;
  pending.delete(id);
  for (const child of calls.values()) {
    const target = child.targetSessionId;
    if (!target || event.failed || output?.error) continue;
    const recipient = follow.input?.id || follow.input?.agent_id;
    if (follow.tool === 'send_input' && recipient === target) {
      Object.assign(child, { status: 'running', resumedAt: ts, finishedAt: null, lastMessage: '' });
    } else if (follow.tool === 'close_agent' && recipient === target) {
      finish(child, 'stopped', ts);
    } else if (output?.status && Object.hasOwn(output.status, target)) {
      const result = output.status[target];
      if (result === 'running' || result === 'pendingInit' || result == null) continue;
      finish(child, result?.errored || ['shutdown', 'notFound'].includes(result) ? 'stopped' : 'done', ts, result?.completed || outputText(result));
    }
  }
}

function finish(call, status, ts, message) {
  call.status = status;
  call.finishedAt = ts || Date.now();
  if (message) call.lastMessage = String(message).slice(0, 6000);
}

module.exports = { applyEvent, finish };
