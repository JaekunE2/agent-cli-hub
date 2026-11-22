const { createHash } = require('crypto');
const path = require('path');
const fingerprint = text => createHash('sha256').update(text.replace(/\r\n/g, '\n').trim()).digest('hex');
const sessionId = value => typeof value === 'string' && /^[\w-]{8,100}$/.test(value) ? value : null;

function projectSession(term, agent, docs, agySessionId) {
  if (!term.meta?.projectTask) return null;
  const args = term.meta.args || [];
  if (agent === 'agy') return sessionId(agySessionId);
  if (agent === 'claude') {
    const i = args.findIndex(a => a === '--session-id' || a === '--resume');
    return i < 0 ? null : sessionId(args[i + 1]);
  }
  if (agent !== 'codex') return null;
  const resume = args.indexOf('resume');
  if (resume >= 0) return sessionId(args[resume + 1]);
  const { projectPrompt, spawnedAt } = term.meta;
  if (!projectPrompt || !spawnedAt || !term.cwd) return null;
  const cwd = path.resolve(term.cwd).toLowerCase();
  const matches = [...docs].filter(d => {
    if (d.agent !== 'codex' || !d.cwd || path.resolve(d.cwd).toLowerCase() !== cwd) return false;
    const first = d.msgs.find(m => m.role === 'user');
    return first && Date.parse(first.ts) >= spawnedAt - 1000 && fingerprint(first.text) === projectPrompt;
  });
  return matches.length === 1 ? sessionId(matches[0].id) : null;
}
module.exports = { fingerprint, projectSession, sessionId };
