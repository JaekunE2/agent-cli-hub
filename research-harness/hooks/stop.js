// Stop hook: keeps the research *director* session working turn after turn.
// Workers and unrelated sessions in the folder are never held back.
// Output {"decision":"block","reason":...} = "don't stop; do this next".
const fs = require('fs');
const path = require('path');
const H = require('./common');

const input = H.readInput();
const proj = H.findProject(input.cwd);
if (!proj) process.exit(0);
const st = H.loadState(proj);
if (!st || !H.isDirector(input, st)) process.exit(0);

const now = Date.now();
if (!st.director_session_id && input.session_id) st.director_session_id = input.session_id;
const ap = (st.autopilot = st.autopilot || {});
// limits come from the harness config (outside the project), never from state.json
let hc = {};
try { hc = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8')).autopilot || {}; } catch {}
const cfg = { maxPerHour: hc.max_turns_per_hour ?? 40, noProgressLimit: hc.no_progress_limit ?? 3, throttleWaitMin: hc.throttle_wait_min ?? 20 };
// saving mode (set by the dashboard watchdog near the usage limit): far fewer turns per hour
if (st.pacing) cfg.maxPerHour = hc.pacing_turns_per_hour ?? 10;

const allow = (why) => { H.hookLog(proj, `stop: allow (${why})`); H.saveState(proj, st); process.exit(0); };

// Only turns that were themselves autopilot continuations count toward "no progress";
// a turn started by the user or by a watchdog nudge resets it.
const fp = H.progressFingerprint(proj, st);
if (input.stop_hook_active) ap.noProgress = fp === ap.lastFp ? (ap.noProgress || 0) + 1 : 0;
else ap.noProgress = 0;
ap.lastFp = fp;
ap.turns = (ap.turns || []).filter((t) => now - t < 3600e3);

if (fs.existsSync(path.join(proj, 'research', 'PAUSE'))) allow('PAUSE file');
// Paper projects finish only through the review gate (lib/reviewgate.js): a rejecting review means
// fix → review → fix …, and the paper must rank in the top N against papers accepted at the venue.
const G = require('../lib/reviewgate');
let gate = null;
if (st.status === 'done' && G.applies(st) && !(st.config?.goal === 'P10_submission' && st.review_gate?.passed_at)) {
  gate = G.evaluate(proj, st);
  st.review_gate = { checked_at: new Date(now).toISOString(), passed: gate.passed, rounds: gate.rounds, recommendation: gate.recommendation, bench: gate.bench, reasons: gate.reasons, ...(gate.passed ? { passed_at: new Date(now).toISOString() } : {}) };
  if (!gate.passed) {
    if (gate.exhausted) {
      st.status = 'blocked';
      st.blocked_reason = `리뷰-수정 ${gate.rounds}라운드 후에도 종료 기준 미달 (${gate.reasons.join('; ')}) — 계속할지(라운드 한도 상향)·범위를 줄일지 사용자 판단 필요`;
      allow('review rounds exhausted');
    }
    st.status = 'running';
    st.phase = 'P9_review';
    st.next_action = `리뷰 루프 (종료 기준 미달): ${gate.reasons[0]}`;
    H.hookLog(proj, `stop: done refused by review gate (${gate.reasons.join(' | ')})`);
  }
}
if (['paused', 'done', 'blocked'].includes(st.status)) allow(`status=${st.status}`);
if (st.status === 'waiting') {
  if (st.wake_at && Date.parse(st.wake_at) > now) allow(`waiting until ${st.wake_at}`);
  st.status = 'running'; st.wake_at = null; st.wait_reason = '';
}
if (ap.noProgress >= cfg.noProgressLimit) {
  st.status = 'blocked';
  st.blocked_reason = `자율 진행 ${ap.noProgress}턴 연속 state.json/JOURNAL.md 갱신 없음 — 같은 자리를 맴도는 것으로 보고 멈춤`;
  allow('no progress');
}
if (ap.turns.length >= cfg.maxPerHour) {
  st.status = 'waiting';
  st.wake_at = new Date(now + cfg.throttleWaitMin * 60e3).toISOString();
  st.wait_reason = `autopilot throttle (${cfg.maxPerHour} turns/h)`;
  allow('throttle');
}

ap.turns.push(now);
ap.lastContinueAt = new Date(now).toISOString();
H.saveState(proj, st);

const unread = H.unreadInbox(proj);
const reason = [
  '[AUTOPILOT] 사용자 입력 없이 다음 작업을 계속하세요 (CLAUDE.md 운영 매뉴얼).',
  unread ? `- research/INBOX.md에 읽지 않은 사용자 메시지 ${unread}건 → 먼저 처리하고 (unread)→(read)로 표시.` : '',
  `- 현재 phase=${st.phase || '?'} · next_action=${st.next_action || '(state.json에 기록 필요)'}`,
  '- 한 단계 수행 → JOURNAL.md 추가 + state.json(phase/next_action/updated_at) 갱신.',
  '- 사용자에게 묻지 말고 스스로 결정(DECISIONS.md)해 진행. 설치·테스트도 직접. 목표(state.config.goal) 게이트 통과 시 done, 진행 불가한 중대한 문제만 blocked.',
  '- 기다리는 것 외에 할 일이 없으면 status="waiting"+wake_at 설정 후 턴 종료.',
  st.phase === 'P9_review' ? (() => {
    const g = gate || G.evaluate(proj, st), c = g.cfg, tool = (t) => `\`"${process.execPath}" "${path.join(__dirname, '..', 'tools', t)}" .\``;
    return [
      `- P9 리뷰 루프 (CLAUDE.md P9): 수정 → PDF 컴파일 → 외부 리뷰 ${tool('gpt-review.js')} → reviews/gpt_response_rN.md에 R*/A* 항목별 판정 → 수정 … 판정이 "${c.min_recommendation}" 이상이 될 때까지 반복.`,
      `- 그다음 타겟 학회 채택 논문 ${c.benchmark_papers}편(research/venue/accepted/*.pdf + venue/ACCEPTED.md)과 블라인드 비교 ${tool('venue-benchmark.js')} → 모든 실행에서 ${c.benchmark_max_rank}위 이내여야 done 가능. 미달이면 지적된 약점을 반영해 다시 리뷰부터.`,
      `- 현재: 리뷰 ${g.rounds}/${c.max_review_rounds}라운드 · 판정 ${g.recommendation || '없음'} · 비교 ${g.bench ? `최저 ${g.bench.worst}위/${g.bench.of}편` : '없음'}${g.reasons.length ? ` · 남은 조건: ${g.reasons.join('; ')}` : ' · 종료 기준 충족 → done 가능'}`,
      g.stalled ? `- ⚠ 최근 ${c.stall_rounds}라운드 동안 판정이 나아지지 않음 → 문장 수정만으로는 부족. P7로 돌아가 리뷰가 지적한 실험(베이스라인·ablation·통계)을 보강하거나 기여 범위를 좁혀 다시 쓰기 (DECISIONS.md에 기록).` : '',
      '- ChatGPT 사용 불가(exit 2)면 status="waiting"+wake_at 60분 뒤로 두고 재시도. 리뷰 없이 done 처리 금지.',
    ].filter(Boolean).join('\n');
  })() : '',
  st.pacing ? '- ⚠ 절약 모드(사용량 85%+): 서브에이전트·워커 금지, 한 턴에 여러 일을 묶어 처리, GPU 실험 위주로 진행하고 결과 대기는 status=waiting(최소 20분)으로.' : '',
].filter(Boolean).join('\n');
H.hookLog(proj, `stop: block (phase=${st.phase}, turns/h=${ap.turns.length})`);
process.stdout.write(JSON.stringify({ decision: 'block', reason }));
