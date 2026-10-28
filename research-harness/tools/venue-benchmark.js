#!/usr/bin/env node
// Blind benchmark of our paper against papers ACCEPTED at the target venue, judged by ChatGPT
// (ccd gpt, read-only) as a program-committee member. Final gate of P9 (lib/reviewgate.js).
//
//   node <research-harness>\tools\venue-benchmark.js [project dir] [--runs 2] [--pdf research/paper/main.pdf]
//
// Needs: research/venue/accepted/*.pdf (>= 5 papers accepted at the target venue, recent, same area)
//        and research/venue/ACCEPTED.md (for each PDF: title, venue+year, how acceptance was verified).
// Blind: every paper is cut to its body (title block, author lines, venue banners, emails, arXiv stamps and
// the reference list removed), labelled A..F in a different random order per run, and the reviewer is not
// told which one is ours. Our rank per run is recorded; the gate uses the WORST rank over the runs.
// Writes: research/reviews/benchmark_r<N>.md (+ .json). Exit 0 = done, 1 = missing inputs, 2 = GPT unavailable.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { reviewConfig, sha12 } = require('../lib/reviewgate');

const argv = process.argv.slice(2);
const flag = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const proj = path.resolve(argv.find((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--'))) || '.');
const cfg = reviewConfig();
const R = path.join(proj, 'research');
const pdf = path.resolve(proj, flag('pdf', 'research/paper/main.pdf'));
const runs = Math.max(1, Number(flag('runs', cfg.benchmark_runs)));
const accDir = path.join(R, 'venue', 'accepted');
const DASH = ['hub', 'cc-dashboard', 'dashboard'].map((d) => path.join(__dirname, '..', '..', d)).find((d) => fs.existsSync(path.join(d, 'ccd.js')));
const CCD = DASH ? path.join(DASH, 'ccd.js') : 'ccd.js';
const PY = process.env.CCD_PYTHON || (() => { try { return JSON.parse(fs.readFileSync(path.join(DASH, 'config.json'), 'utf8')).python; } catch { return null; } })() || 'python';

const die = (code, msg) => { console.error(`[venue-benchmark] ${msg}`); process.exit(code); };
if (!fs.existsSync(pdf)) die(1, `PDF not found: ${pdf} — compile the paper first`);
const accepted = fs.existsSync(accDir) ? fs.readdirSync(accDir).filter((f) => /\.pdf$/i.test(f)).sort() : [];
if (accepted.length < cfg.benchmark_papers) die(1, `need ${cfg.benchmark_papers} accepted-paper PDFs in research/venue/accepted/ (found ${accepted.length}) — see CLAUDE.md P9`);
if (!fs.existsSync(path.join(R, 'venue', 'ACCEPTED.md'))) die(1, 'research/venue/ACCEPTED.md missing (title, venue+year, how acceptance was verified, for each PDF)');
const papers = [{ id: 'OURS', file: pdf }, ...accepted.slice(0, cfg.benchmark_papers).map((f) => ({ id: f, file: path.join(accDir, f) }))];

// 1) body text of each paper (PyMuPDF), anonymized
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'venue-bench-'));
const MAX_CHARS = 40000;
for (const p of papers) {
  const r = spawnSync(PY, ['-c', 'import fitz,sys; d=fitz.open(sys.argv[1]); sys.stdout.buffer.write("\\n".join(pg.get_text() for pg in d).encode("utf-8"))', p.file], { maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) die(1, `text extraction failed for ${path.basename(p.file)}: ${String(r.stderr).slice(-300)}`);
  let t = r.stdout.toString('utf8');
  // drop the title/author block: start at the abstract when there is one
  const ab = t.search(/\n\s*(abstract|a b s t r a c t)\b/i);
  if (ab >= 0 && ab < 6000) t = t.slice(ab);
  // drop the reference list (last References/Bibliography heading in the second half)
  const refs = [...t.matchAll(/\n\s*(references|bibliography|참고\s*문헌)\s*\n/gi)].map((m) => m.index).filter((i) => i > t.length * 0.5).pop();
  if (refs) t = t.slice(0, refs);
  t = t.split('\n').filter((l) => !/(published as|accepted (at|to|for)|proceedings of|in submission|under review|preprint|copyright|©|arxiv:\s*\d|https?:\/\/|@[\w-]+\.\w+|equal contribution|corresponding author|anonymous author)/i.test(l)).join('\n');
  t = t.replace(/\n{3,}/g, '\n\n').trim();
  p.text = t.length > MAX_CHARS ? t.slice(0, MAX_CHARS) + '\n[... truncated ...]' : t;
  p.chars = t.length;
}

// --dry: show what the reviewer would get (no ChatGPT call)
if (argv.includes('--dry')) {
  for (const p of papers) console.log(`${p.id === 'OURS' ? 'OURS' : p.id}: ${p.chars} chars → starts: ${JSON.stringify(p.text.slice(0, 90))}`);
  try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
  process.exit(0);
}

let venue = '';
for (const f of ['venue/VENUE.md', 'research/venue/VENUE.md'].map((x) => path.join(proj, x))) if (fs.existsSync(f)) { venue = fs.readFileSync(f, 'utf8').slice(0, 4000); break; }

// 2) runs with different label orders
const LABELS = 'ABCDEFGHIJ'.split('');
const shuffle = (a, seed) => { const x = [...a]; let s = seed; for (let i = x.length - 1; i > 0; i--) { s = (s * 1103515245 + 12345) % 2147483648; const j = s % (i + 1); [x[i], x[j]] = [x[j], x[i]]; } return x; };
const results = [];
for (let k = 0; k < runs; k++) {
  const order = shuffle(papers, crypto.randomInt(1, 2 ** 30));
  const lab = order.map((p, i) => ({ label: LABELS[i], p }));
  const body = lab.map(({ label, p }) => `\n\n==================== PAPER ${label} ====================\n${p.text}`).join('');
  const file = path.join(work, `papers_${k + 1}.txt`);
  fs.writeFileSync(file, body);
  const prompt = `You are a senior program-committee member for the venue below. You receive ${lab.length} anonymized manuscripts (PAPER ${LABELS[0]}..${LABELS[lab.length - 1]}, body text only; author names, venue banners and reference lists were removed for every paper alike).
Rank ALL of them by how strongly you would argue for acceptance at this venue: novelty, technical soundness and evidence, significance, experimental rigor (baselines, ablations, statistics), clarity. Judge each on its own content; do not guess which ones are published, and do not favour a topic just because it is popular.
Answer in Korean (technical terms in English): for each paper 2-3 lines (main strength, main weakness), then the ranking with a one-line reason per position.
End with exactly one final line, machine-readable, nothing after it:
RANKING_JSON: {"ranking": ["<label best>", ..., "<label worst>"], "scores": {"<label>": <overall 1-10>, ...}}

${venue ? `--- Venue notes ---\n${venue}\n` : '--- Venue: unknown (judge against general top-venue standards) ---\n'}`;
  console.error(`[venue-benchmark] run ${k + 1}/${runs}: ${lab.length} papers → ChatGPT`);
  const r = spawnSync(process.execPath, [CCD, 'gpt', '--cd', work, '--file', file, prompt], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120 * 60e3 });
  const answer = (r.stdout || '').trim();
  if (r.status !== 0 || !answer) { try { fs.rmSync(work, { recursive: true, force: true }); } catch {} die(2, `ChatGPT unavailable (exit ${r.status}): ${(r.stderr || '').trim().slice(-400)}`); }
  let rk = null;
  const m = /RANKING_JSON:\s*(\{[\s\S]*?\})\s*$/.exec(answer) || /RANKING_JSON:\s*(\{[^\n]*\})/.exec(answer);
  if (m) { try { rk = JSON.parse(m[1]); } catch {} }
  const ranking = (rk?.ranking || []).map((x) => String(x).trim().replace(/^paper\s*/i, '').toUpperCase());
  const ours = lab.find((x) => x.p.id === 'OURS').label;
  const pos = ranking.indexOf(ours);
  results.push({ run: k + 1, order: lab.map((x) => ({ label: x.label, paper: x.p.id })), ranking, scores: rk?.scores || null, ours_label: ours, ours_rank: pos >= 0 ? pos + 1 : null, answer });
}
try { fs.rmSync(work, { recursive: true, force: true }); } catch {}

// 3) write results (unparsable ranking = counts as last place, so a broken answer never passes the gate)
const revDir = path.join(R, 'reviews');
fs.mkdirSync(revDir, { recursive: true });
const round = Number(flag('round', 0)) || (fs.readdirSync(revDir).map((f) => /^benchmark_r(\d+)\.json$/.exec(f)).filter(Boolean).reduce((mx, x) => Math.max(mx, Number(x[1])), 0) + 1);
const ranks = results.map((x) => x.ours_rank || papers.length);
const sha = sha12(pdf);
const summary = { round, pdf_sha: sha, at: new Date().toISOString(), n_papers: papers.length, accepted: papers.slice(1).map((p) => p.id),
  worst_rank: Math.max(...ranks), mean_rank: ranks.reduce((a, b) => a + b, 0) / ranks.length,
  pass_rank: cfg.benchmark_max_rank, passed: Math.max(...ranks) <= cfg.benchmark_max_rank,
  runs: results.map(({ answer, ...x }) => x) };
fs.writeFileSync(path.join(revDir, `benchmark_r${round}.json`), JSON.stringify(summary, null, 2));
const nameOf = (id) => (id === 'OURS' ? '**우리 논문**' : id);
fs.writeFileSync(path.join(revDir, `benchmark_r${round}.md`), `# 채택 논문 블라인드 비교 — round ${round}

- 우리 PDF: \`${path.relative(proj, pdf)}\` (sha256 ${sha}) · 비교 대상: research/venue/accepted/ ${papers.length - 1}편 · ${summary.at}
- 결과: 실행별 우리 순위 ${ranks.map((x) => `${x}위`).join(', ')} / ${papers.length}편 → 최저 ${summary.worst_rank}위 (기준 ${cfg.benchmark_max_rank}위 이내) → **${summary.passed ? '통과' : '미달'}**
- 심사: ChatGPT via Codex CLI (read-only). 참고용 평가이며, 지적된 약점은 논문·데이터로 확인한 뒤 반영한다.

${results.map((x) => `## Run ${x.run}\n라벨: ${x.order.map((o) => `${o.label}=${nameOf(o.paper)}`).join(', ')}\n순위: ${x.ranking.map((l, i) => `${i + 1}. ${l}${l === x.ours_label ? ' (우리)' : ''}`).join(' · ') || '(파싱 실패 → 꼴찌로 처리)'}\n\n${x.answer}`).join('\n\n')}
`);
console.log(path.join(revDir, `benchmark_r${round}.md`));
console.log(`[venue-benchmark] ours: ${ranks.map((x) => x + '위').join(', ')} of ${papers.length} → worst ${summary.worst_rank} → ${summary.passed ? 'PASS' : 'below the bar'}`);
