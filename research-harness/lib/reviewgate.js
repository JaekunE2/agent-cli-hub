// Review gate for paper projects (goal P9_review / P10_submission): a study may only finish when
//   (1) the latest external review (tools/gpt-review.js) recommends at least `min_recommendation`, and
//   (2) the latest blind benchmark (tools/venue-benchmark.js) against papers accepted at the target venue
//       ranks ours within the top `benchmark_max_rank` in every run,
// both on the current PDF. Used by hooks/stop.js (blocks "done") and by the dashboard (shows progress).
// Limits come from the harness config.json "review" (outside the project, the director cannot relax them).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REC_ORDER = ['strong reject', 'reject', 'weak reject', 'borderline', 'weak accept', 'accept', 'strong accept'];
const DEFAULTS = { min_recommendation: 'weak accept', benchmark_max_rank: 3, benchmark_papers: 5, benchmark_runs: 2, max_review_rounds: 10, stall_rounds: 3 };

function reviewConfig() {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8')).review || {}; } catch {}
  return { ...DEFAULTS, ...c };
}

// "Weak Reject" / "weak-reject" / "Borderline (leaning accept)" → index in REC_ORDER (-1 = unknown)
function recIndex(s) {
  const t = String(s || '').toLowerCase().replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim();
  for (let i = REC_ORDER.length - 1; i >= 0; i--) if (t.startsWith(REC_ORDER[i])) return i;
  for (let i = REC_ORDER.length - 1; i >= 0; i--) if (t.includes(REC_ORDER[i])) return i;
  return -1;
}

// Reviewer answer → { recommendation, confidence? }: the VERDICT_JSON line, else a "Recommendation:" line
function parseVerdict(answer) {
  const vm = /VERDICT_JSON:\s*(\{[^\n]*\})/.exec(answer || '');
  if (vm) { try { const v = JSON.parse(vm[1]); if (recIndex(v.recommendation) >= 0) return { ...v, recommendation: REC_ORDER[recIndex(v.recommendation)] }; } catch {} }
  const label = /^.*?(recommendation|추천|판정|권고)[^:：\n]*[:：]/i;
  for (const l of String(answer || '').split('\n')) {
    if (!label.test(l)) continue;
    const i = recIndex(l.replace(label, '').replace(/[*_`#]/g, ''));
    if (i >= 0) return { recommendation: REC_ORDER[i], parsed_from: 'text' };
  }
  return null;
}

const sha12 = (f) => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, 12); } catch { return null; } };
function latest(dir, re) {
  let best = null;
  try { for (const f of fs.readdirSync(dir)) { const m = re.exec(f); if (m && (!best || Number(m[1]) > best.n)) best = { n: Number(m[1]), file: path.join(dir, f) }; } } catch {}
  if (!best) return null;
  try { return { n: best.n, file: best.file, data: JSON.parse(fs.readFileSync(best.file, 'utf8')) }; } catch { return { n: best.n, file: best.file, data: null }; }
}

const applies = (st) => ['P9_review', 'P10_submission'].includes(st?.config?.goal || 'P9_review');

function evaluate(proj, st) {
  const cfg = reviewConfig();
  const rev = path.join(proj, 'research', 'reviews');
  const pdf = path.join(proj, 'research', 'paper', 'main.pdf');
  const sha = sha12(pdf);
  const r = latest(rev, /^gpt_review_r(\d+)\.json$/);
  const b = latest(rev, /^benchmark_r(\d+)\.json$/);
  const rounds = (() => { try { return fs.readdirSync(rev).filter((f) => /^gpt_review_r\d+\.md$/.test(f)).length; } catch { return 0; } })();
  const out = { applies: applies(st), cfg, pdf: sha ? 'research/paper/main.pdf' : null, rounds, reasons: [] };
  out.recommendation = r?.data?.recommendation || null;
  out.recOk = !!r?.data && recIndex(r.data.recommendation) >= recIndex(cfg.min_recommendation) && r.data.pdf_sha === sha;
  out.responded = !!r && fs.existsSync(path.join(rev, `gpt_response_r${r.n}.md`));
  out.bench = b?.data ? { round: b.n, worst: b.data.worst_rank, mean: b.data.mean_rank, of: b.data.n_papers, runs: (b.data.runs || []).length } : null;
  out.benchOk = !!b?.data && b.data.pdf_sha === sha && (b.data.runs || []).length >= cfg.benchmark_runs && b.data.worst_rank <= cfg.benchmark_max_rank;
  if (!sha) out.reasons.push('컴파일된 research/paper/main.pdf 없음');
  if (!r) out.reasons.push('외부 리뷰(gpt-review.js) 결과 없음');
  else if (!r.data) out.reasons.push(`${path.basename(r.file)} 판정을 읽을 수 없음 — gpt-review.js를 다시 실행`);
  else {
    if (r.data.pdf_sha !== sha) out.reasons.push(`최신 리뷰(r${r.n})가 현재 PDF가 아닌 이전 버전 기준 — 수정한 PDF로 다시 리뷰`);
    if (recIndex(r.data.recommendation) < recIndex(cfg.min_recommendation)) out.reasons.push(`리뷰 판정 "${r.data.recommendation}" < 기준 "${cfg.min_recommendation}"`);
    if (!out.responded) out.reasons.push(`reviews/gpt_response_r${r.n}.md(항목별 대응) 없음`);
  }
  if (!b) out.reasons.push(`채택 논문 ${cfg.benchmark_papers}편과의 블라인드 비교(venue-benchmark.js) 결과 없음`);
  else if (!b.data) out.reasons.push(`${path.basename(b.file)}을 읽을 수 없음 — venue-benchmark.js를 다시 실행`);
  else {
    if (b.data.pdf_sha !== sha) out.reasons.push(`최신 비교(r${b.n})가 이전 PDF 기준 — 현재 PDF로 다시 비교`);
    if ((b.data.runs || []).length < cfg.benchmark_runs) out.reasons.push(`비교 실행 ${(b.data.runs || []).length}회 < ${cfg.benchmark_runs}회`);
    if (b.data.worst_rank > cfg.benchmark_max_rank) out.reasons.push(`비교 순위 ${b.data.worst_rank}위/${b.data.n_papers}편 (최저 기준) > ${cfg.benchmark_max_rank}위`);
  }
  out.passed = out.applies && !!sha && out.recOk && out.responded && out.benchOk;
  out.exhausted = rounds >= cfg.max_review_rounds;
  // per-round history; "stalled" = the last stall_rounds reviews were no better than the best before them
  out.history = [];
  try {
    for (const f of fs.readdirSync(rev)) {
      const m = /^gpt_review_r(\d+)\.json$/.exec(f);
      if (m) { try { out.history.push({ round: Number(m[1]), rec: JSON.parse(fs.readFileSync(path.join(rev, f), 'utf8')).recommendation || null }); } catch {} }
    }
  } catch {}
  out.history.sort((a, b) => a.round - b.round);
  const idx = out.history.map((h) => recIndex(h.rec)), k = cfg.stall_rounds;
  out.stalled = idx.length > k && Math.max(...idx.slice(-k)) <= Math.max(...idx.slice(0, -k));
  return out;
}

module.exports = { REC_ORDER, recIndex, parseVerdict, reviewConfig, evaluate, applies, sha12 };
