'use strict';

const SECRET = /\b(?:Bearer\s+[^\s"',;]+|(?:smds_|sk-|gh[pousr]_|github_pat_|xox[baprs]-|AIza)[\w-]+|eyJ[\w-]+\.[\w-]+\.[\w-]+)|\b(?:api[_ -]?key|token|password|secret)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const ABSOLUTE_PATH = /(?:["'](?:[a-z]:[\\/]|\\\\|\/)[^"'\r\n]+["']|(?:\b[a-z]:[\\/]|\\\\)[^\s"'<>]+|(?<![\w:/])\/(?!\/)[^\s"'<>]+)/gi;

function summarize(value, sensitive = []) {
  let text = String(value ?? '');
  for (const literal of new Set(sensitive.filter(value => typeof value === 'string' && value))) {
    text = text.split(literal).join('[redacted]');
  }
  text = text.replace(SECRET, '[redacted]').replace(ABSOLUTE_PATH, '[path]')
    .replace(/[\p{Cc}\s]+/gu, ' ').trim();
  const bytes = Buffer.from(text);
  if (bytes.length <= 4096) return text;
  let end = 4096;
  while ((bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}

function codexOutput() {
  let pending = '';
  let dropping = false;
  const result = { completed: false, failed: false, sessionId: null, outputSummary: '', errorSummary: '' };
  return {
    result,
    feed(chunk) {
      const lines = chunk.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (pending.length + lines[i].length > 131_072) dropping = true;
        if (!dropping) pending += lines[i];
        if (i === lines.length - 1) break;
        if (dropping) {
          result.failed = true;
          result.errorSummary = 'CLI event exceeded size limit';
        } else if (pending.trim()) {
          try {
            const event = JSON.parse(pending);
            if (event.type === 'thread.started' && /^[\w-]{1,128}$/.test(event.thread_id ?? '')) result.sessionId = event.thread_id;
            if (event.type === 'turn.completed') result.completed = true;
            if (event.type === 'turn.failed' || event.type === 'error' || event.item?.status === 'failed') {
              result.failed = true;
              result.errorSummary = event.error?.message || event.message || event.item?.error?.message || 'CLI reported failure';
            }
            if (event.type === 'item.completed' && event.item?.type === 'agent_message') result.outputSummary = event.item.text;
          } catch {
            result.failed = true;
            result.errorSummary = 'Invalid CLI JSON event';
          }
        }
        pending = '';
        dropping = false;
      }
    },
  };
}

module.exports = { summarize, codexOutput };
