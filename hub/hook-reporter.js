'use strict';

const fs = require('fs');
const path = require('path');
const { toolName, spawnTools } = require('./subagent-events');

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let out = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { out += c; });
    process.stdin.on('end', () => resolve(out));
    process.stdin.on('error', () => resolve(out));
    setTimeout(() => resolve(out), 250);
  });
}

function pickTarget(input) {
  if (!input || typeof input !== 'object') return '';
  return String(
    input.file_path || input.path || input.target_file || input.notebook_path
    || input.command || input.pattern || input.query || input.url
    || input.description || input.prompt || ''
  ).replace(/\s+/g, ' ').trim().slice(0, 180);
}

function safeKey(raw) {
  return String(raw || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
}

async function main() {
  const hookDir = process.env.ACH_HOOK_DIR || path.join(__dirname, 'data', 'hooks');
  const raw = await readStdin();
  let payload = {};
  if (raw && raw.trim()) {
    try { payload = JSON.parse(raw); } catch {}
  }

  const args = process.argv.slice(2);
  const argVal = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : '';
  };

  const termId = argVal('--term') || process.env.ACH_TERM_ID || '';
  const sessionId = argVal('--session') || payload.session_id || process.env.ACH_SESSION_ID || '';
  const tool = argVal('--tool') || payload.tool_name || payload.tool || payload.name || '';
  const eventName = argVal('--event') || payload.hook_event_name || '';
  const target = argVal('--target') || pickTarget(payload.tool_input || payload.input || payload);
  const subagentId = String(payload.agent_id || payload.subagent_id || '').slice(0, 64);
  const isErr = Boolean(payload.tool_response?.is_error || payload.is_error || payload.error);
  const status = isErr ? 'error' : (/^Pre/i.test(eventName) ? 'start' : 'done');
  const callId = payload.tool_use_id || payload.call_id;

  if (!tool && !eventName) return;

  const entry = {
    ts: Date.now(),
    termId: termId || undefined,
    sessionId: sessionId || undefined,
    tool: String(tool || eventName).slice(0, 80),
    target,
    status,
    ...(callId && spawnTools.test(toolName(tool)) ? {
      callId: String(callId).slice(0, 200),
      input: payload.tool_input || payload.input,
      output: payload.tool_response ?? payload.tool_output ?? payload.error,
    } : {}),
    ...(subagentId ? { subagentId } : {}),
    ...(payload.cwd ? { cwd: String(payload.cwd).slice(0, 260) } : {}),
  };

  fs.mkdirSync(hookDir, { recursive: true });
  const line = JSON.stringify(entry) + '\n';
  if (termId) fs.appendFileSync(path.join(hookDir, `term-${safeKey(termId)}.jsonl`), line, 'utf8');
  if (sessionId) fs.appendFileSync(path.join(hookDir, `sid-${safeKey(sessionId)}.jsonl`), line, 'utf8');
  if (!termId && !sessionId) fs.appendFileSync(path.join(hookDir, 'global.jsonl'), line, 'utf8');
}

main().catch(() => {});
