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
function projectDeliveryResult(hub, term) {
  const at = term.meta?.projectDelivery?.at || term.meta?.spawnedAt;
  const digest = term.meta?.projectDelivery?.digest || term.meta?.projectPrompt;
  const sid = hub.termSessionId?.(term);
  const messages = sid && hub.index?.get?.(sid)?.msgs;
  if (!at || !digest || !messages?.length) return null;
  const lastUser = messages.findLastIndex(m => m.role === 'user');
  const user = messages[lastUser];
  if (!user?.text || !(Date.parse(user.ts) >= at) || fingerprint(user.text) !== digest) return null;
  const reply = messages.slice(lastUser + 1).findLast(m => m.role === 'assistant'
    && String(m.text || '').trim() && !/^[⚙❓]/u.test(m.text) && Date.parse(m.ts) >= Date.parse(user.ts));
  return reply ? { at } : null;
}

const deliveryError = note => /^(?:전송 중 터미널 입력 상태가 바뀌었습니다\.|CLI 입력창을 확인하지 못했습니다\.|CLI 입력창에서 전송한 내용을 확인하지 못했습니다\.|작업 지시를 제출했지만 CLI가 실행을 시작했다는 신호가 없습니다\.)/.test(note || '');

module.exports = { fingerprint, projectSession, sessionId, projectDeliveryResult, deliveryError };
