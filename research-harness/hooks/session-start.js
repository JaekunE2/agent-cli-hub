// SessionStart hook (startup / resume / compact): re-orient the session.
// Plain stdout is added to Claude's context.
const path = require('path');
const H = require('./common');

const input = H.readInput();
const proj = H.findProject(input.cwd);
if (!proj) process.exit(0);
const st = H.loadState(proj);
if (!st) process.exit(0);

if (process.env.RESEARCH_ROLE === 'director') {
  if (st.director_session_id !== input.session_id && input.session_id) {
    st.director_session_id = input.session_id;
    H.saveState(proj, st);
  }
}
if (!H.isDirector(input, st)) {
  process.stdout.write(`[RESEARCH HARNESS] 이 폴더는 자율 연구 프로젝트입니다. 당신은 디렉터가 아닙니다. 첫 메시지가 research/workers/<id>/TASK.md를 가리키면 워커 규칙(CLAUDE.md 끝)을 따르세요.\n`);
  process.exit(0);
}

const r = path.join(proj, 'research');
const unread = H.unreadInbox(proj);
const out = [
  `[RESEARCH HARNESS · 디렉터] (${input.source || 'start'}) 프로젝트: ${st.project}`,
  `status=${st.status} · phase=${st.phase} · iteration=${st.iteration ?? 0}${st.wake_at ? ` · wake_at=${st.wake_at}` : ''}`,
  `next_action: ${st.next_action || '(없음 — PLAN.md에서 결정)'}`,
  st.workers?.length ? `workers: ${st.workers.map((w) => `${w.id}(${w.term || '?'}:${w.status || '?'})`).join(', ')}` : '',
  unread ? `INBOX 읽지 않은 메시지 ${unread}건` : '',
  '--- JOURNAL.md 최근 ---',
  H.tail(path.join(r, 'JOURNAL.md'), 25),
  '---',
  'CLAUDE.md 운영 매뉴얼에 따라, 이미 끝난 일은 반복하지 말고 이어서 진행하세요.',
].filter(Boolean).join('\n');
process.stdout.write(out + '\n');
