'use strict';

const spawnTools = /^(?:Agent|Task|spawn_agent|invoke_subagent|swarm)$/i;
const followTools = /^(?:wait_agent|wait|send_input|close_agent)$/;
const toolName = name => String(name || '').split(/__|\./).pop();
function decode(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}
function outputText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(item => outputText(item?.text ?? item?.content ?? item)).filter(Boolean).join('\n');
  return value == null ? '' : JSON.stringify(value);
}

function* transcriptEvents(row) {
  const ts = Date.parse(row.timestamp || row.created_at) || 0;
  const blocks = row.message?.content;
  if (Array.isArray(blocks)) for (const b of blocks.filter(Boolean)) {
    if (b.type === 'tool_use') yield { type: 'call', id: b.id, tool: b.name, input: b.input, ts };
    if (b.type === 'tool_result') yield { type: 'result', id: b.tool_use_id, output: row.toolUseResult || b.content, failed: b.is_error, ts };
    if (b.type === 'text') yield { type: row.message.role || row.type, text: b.text, ts };
  }
  if (typeof blocks === 'string') yield { type: row.message.role || row.type, text: blocks, ts };
  const p = row.payload;
  if (row.type === 'response_item' && p) {
    if (['function_call', 'custom_tool_call'].includes(p.type)) yield { type: 'call', id: p.call_id, tool: p.name, input: decode(p.arguments ?? p.input), ts };
    if (['function_call_output', 'custom_tool_call_output'].includes(p.type)) yield { type: 'result', id: p.call_id, output: decode(p.output), ts };
    if (p.type === 'message') yield { type: p.role, text: outputText(p.content), ts };
    if (p.type === 'agent_message') {
      const message = /^Message Type: FINAL_ANSWER\r?\n[\s\S]*?\r?\nPayload:\r?\n([\s\S]*)$/.exec(outputText(p.content));
      if (message) yield { type: 'child-status', agentPath: p.author, status: 'done', text: message[1], ts };
    }
  }
  const item = row.type === 'event_msg' && p?.type === 'item_completed' && p.item;
  if (item?.type === 'SubAgentActivity') {
    if (item.kind === 'started') yield { type: 'child-link', id: item.id, childId: item.agent_thread_id, agentPath: item.agent_path, ts };
    else if (['completed', 'failed', 'interrupted', 'closed'].includes(item.kind)) {
      yield { type: 'child-status', childId: item.agent_thread_id, status: item.kind === 'completed' ? 'done' : 'stopped', ts };
    }
  }
  if (row.type === 'event_msg') {
    if (p?.type === 'turn_aborted') yield { type: 'turn-aborted', ts };
    if (['task_complete', 'turn_complete'].includes(p?.type)) yield { type: 'terminal-status', status: 'done', ts };
  }
  const calls = Array.isArray(row.tool_calls) ? row.tool_calls : ['TOOL_CALL', 'FUNCTION_CALL'].includes(row.type) ? [row] : [];
  for (const [i, call] of calls.entries()) {
    if (!call) continue;
    const tool = call.name || call.tool_name || call.function?.name;
    const id = call.id || call.call_id || call.tool_call_id || `agy:${row.step_index}:${i}`;
    yield { type: 'call', id, tool, input: decode(call.args ?? call.arguments ?? call.input ?? call.function?.arguments), ts };
    if (call.result != null) yield { type: 'result', id, tool, output: decode(call.result), ts };
  }
  if (['TOOL_RESULT', 'FUNCTION_RESULT', 'GENERIC', 'INVOKE_SUBAGENT'].includes(row.type)) {
    const output = decode(row.result ?? row.output ?? row.content);
    yield { type: 'result', id: row.call_id || row.tool_call_id, tool: row.tool_name || row.name, output, ts };
  }
  if (row.type === 'SYSTEM_MESSAGE') {
    const text = outputText(row.content);
    const doneM = /Subagent\s+([\w-]{8,100})\s+has gone idle(?:\.\s*This was the subagent's most recent response:\s*([\s\S]*?))?(?:\r?\n<\/SYSTEM_MESSAGE>|$)/i.exec(text);
    if (doneM) {
      yield { type: 'child-status', childId: doneM[1], status: 'done', text: (doneM[2] || '').trim(), ts };
    } else {
      const stopM = /Subagent\s+([\w-]{8,100})\s+(?:failed|exited|stopped|terminated|killed)(?:[:.\s]+([\s\S]*?))?(?:\r?\n<\/SYSTEM_MESSAGE>|$)/i.exec(text);
      if (stopM) yield { type: 'child-status', childId: stopM[1], status: 'stopped', text: (stopM[2] || '').trim(), ts };
    }
  }
  if (row.type === 'PLANNER_RESPONSE' || row.type === 'USER_INPUT') {
    yield { type: row.type === 'USER_INPUT' ? 'user' : 'assistant', text: outputText(row.content), ts };
    if (row.type === 'PLANNER_RESPONSE' && row.status === 'DONE' && row.content && !calls.length) {
      yield { type: 'child-turn-complete', status: 'done', ts };
    }
  }
}

module.exports = { transcriptEvents, spawnTools, followTools, toolName, decode, outputText };
