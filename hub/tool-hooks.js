'use strict';

const { spawnTools, toolName } = require('./subagent-events');
const { recordHook } = require('./subagent-monitor');
const eventNames = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'];

function claudeHookArgs(args) {
  if (args.some(arg => /^--settings(?:=|$)/.test(arg))) return args;
  const quote = value => '"' + value.replace(/\\/g, '/').replace(/["$`]/g, '\\$&') + '"';
  const command = `${quote(process.execPath)} ${quote(__filename)}`;
  const matcher = '^(Agent|Task)$';
  const hooks = Object.fromEntries(eventNames.map(event => [event, [{ matcher, hooks: [{ type: 'command', command, timeout: 3 }] }]]));
  return [...args, '--settings', JSON.stringify({ hooks })];
}

function ingestToolHook(hub, { termId, data } = {}) {
  const event = data?.hook_event_name;
  const tool = toolName(data?.tool_name);
  const id = data?.tool_use_id || data?.call_id;
  if (!eventNames.includes(event) || !spawnTools.test(tool) || typeof id !== 'string' || id.length > 200) return;
  return recordHook(hub, { termId, sessionId: data.session_id, event: {
    type: event === 'PreToolUse' ? 'call' : 'result',
    id, tool, input: data.tool_input, output: data.tool_response ?? data.tool_output ?? data.error,
    failed: event === 'PostToolUseFailure', ts: Date.now(),
  } });
}

async function reportHook() {
  const { ACH_HOOK_PORT: port, ACH_HOOK_TOKEN: token, ACH_HOOK_TERM: termId } = process.env;
  if (!port || !token || !termId) return;
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size <= 524_288) chunks.push(chunk);
  }
  if (size > 524_288) return;
  const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const response = await fetch(`http://127.0.0.1:${port}/api/session/subagent-hook`, {
    method: 'POST', headers: { 'x-hook-token': token, 'content-type': 'application/json' },
    body: JSON.stringify({ termId, data }), signal: AbortSignal.timeout(1500),
  });
  if (!response.ok) console.error('[hub hook]', response.status);
}

if (require.main === module) reportHook().catch(error => console.error('[hub hook]', error.message));
module.exports = { claudeHookArgs, ingestToolHook };
