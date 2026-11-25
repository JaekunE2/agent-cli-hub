'use strict';

const spawnTools = /^(?:Agent|Task|spawn_agent|invoke_subagent)$/i;
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
  }
  if (row.type === 'event_msg' && ['task_complete', 'turn_complete', 'turn_aborted'].includes(p?.type)) {
    yield { type: 'terminal-status', status: p.type === 'turn_aborted' ? 'stopped' : 'done', ts };
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
  if (row.type === 'PLANNER_RESPONSE' || row.type === 'USER_INPUT') {
    yield { type: row.type === 'USER_INPUT' ? 'user' : 'assistant', text: outputText(row.content), ts };
  }
}

module.exports = { transcriptEvents, spawnTools, followTools, toolName, decode, outputText };
