#!/usr/bin/env node
// External review of the final paper PDF by ChatGPT (Codex CLI on the user's ChatGPT subscription,
// read-only), in two roles: venue reviewer + senior advisor.
//
//   node <research-harness>\tools\gpt-review.js [project dir] [--pdf research/paper/main.pdf] [--round N] [--pages 16]
//
// Sends: the PDF's full text + page images (figures/tables/layout) + the venue notes (venue/VENUE.md).
// Writes: research/reviews/gpt_review_r<N>.md  (the director then writes gpt_response_r<N>.md, see CLAUDE.md P9)
// Exit 0 = review written, 2 = GPT unavailable (not logged in / limit / error) → record it and continue.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const argv = process.argv.slice(2);
const flag = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const proj = path.resolve(argv.find((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--'))) || '.');
const R = path.join(proj, 'research');
const pdf = path.resolve(proj, flag('pdf', 'research/paper/main.pdf'));
const maxPages = Number(flag('pages', 16));
const DASH = ['hub', 'cc-dashboard', 'dashboard'].map((d) => path.join(__dirname, '..', '..', d)).find((d) => fs.existsSync(path.join(d, 'ccd.js')));
const CCD = DASH ? path.join(DASH, 'ccd.js') : 'ccd.js';
// Python with PyMuPDF: CCD_PYTHON, else the dashboard config's "python", else python on PATH
const PY = process.env.CCD_PYTHON || (() => { try { return JSON.parse(fs.readFileSync(path.join(DASH, 'config.json'), 'utf8')).python; } catch { return null; } })() || 'python';

if (!fs.existsSync(pdf)) { console.error(`PDF not found: ${pdf} — compile the paper first`); process.exit(1); }
const revDir = path.join(R, 'reviews');
fs.mkdirSync(revDir, { recursive: true });
const round = Number(flag('round', 0)) || (fs.readdirSync(revDir).map((f) => /^gpt_review_r(\d+)\.md$/.exec(f)).filter(Boolean).reduce((m, x) => Math.max(m, Number(x[1])), 0) + 1);
const out = path.join(revDir, `gpt_review_r${round}.md`);
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-review-'));

// 1) text + page images (PyMuPDF)
const ext = spawnSync(PY, ['-c', `
import fitz, sys, os
d = fitz.open(sys.argv[1]); w = sys.argv[2]; n = int(sys.argv[3])
open(os.path.join(w, 'paper.txt'), 'w', encoding='utf-8').write('\\n'.join(f'\\n=== page {i+1} ===\\n' + p.get_text() for i, p in enumerate(d)))
for i, p in enumerate(d):
    if i >= n: break
    p.get_pixmap(dpi=110).save(os.path.join(w, f'p{i+1:02d}.png'))
print(len(d))
`, pdf, work, String(maxPages)], { encoding: 'utf8' });
if (ext.status !== 0) { console.error(`PDF extraction failed: ${ext.stderr}`); process.exit(1); }
const nPages = Number(ext.stdout.trim());
const images = fs.readdirSync(work).filter((f) => /^p\d+\.png$/.test(f)).sort().map((f) => path.join(work, f));

// 2) venue notes
let venue = '';
for (const f of ['venue/VENUE.md', 'research/venue/VENUE.md'].map((x) => path.join(proj, x))) {
  if (fs.existsSync(f)) { venue = fs.readFileSync(f, 'utf8').slice(0, 6000); break; }
}
const prompt = `You are reviewing a research paper manuscript (full text below, page images attached${nPages > images.length ? ` for pages 1-${images.length} of ${nPages}` : ''}).
Play two roles and answer in Korean (keep technical terms in English):

## A. Reviewer (as a strict reviewer for the target venue)
- Summary of the paper (3-4 sentences) and its claimed contributions
- Recommendation (strong reject / reject / weak reject / borderline / weak accept / accept) with confidence (1-5)
- Major weaknesses: each with location (section/figure/table/page), why it matters, and what would resolve it
- Minor issues (clarity, notation, figures, formatting against the venue rules)
- Questions to the authors a reviewer would ask
- Check specifically: over-claiming vs. evidence, missing baselines/ablations, statistical rigor (seeds, variance, significance), reproducibility details, related-work gaps, whether the figures/tables support the text

## B. Senior advisor (helping the authors before submission)
- The 3 changes that would most increase acceptance odds, in priority order, with effort (hours/days) and expected impact
- Framing/positioning advice (title, abstract, contribution statements)
- Experiments worth adding if time allows, and which ones are NOT worth it
- Risks a reviewer is likely to attack, and how to pre-empt them in the text

Rules: be concrete and cite locations. Do not invent references or numbers — if you suggest related work, say it must be verified. If something is unclear from the PDF, say so instead of guessing. Mark each item with an ID (R1, R2, ... for reviewer items, A1, A2, ... for advisor items) so the authors can respond per item.
Judge the paper as it is now, not by how much it improved: the recommendation must be what you would submit to the venue's program committee today.

End your answer with exactly one final line, machine-readable, nothing after it:
VERDICT_JSON: {"recommendation": "<strong reject|reject|weak reject|borderline|weak accept|accept|strong accept>", "confidence": <1-5>, "major_issues": <number of major weaknesses>}

${venue ? `--- Target venue notes (from the authors' venue research) ---\n${venue}\n` : '--- Target venue: unknown (review against general top-venue standards) ---\n'}`;
fs.writeFileSync(path.join(work, 'prompt.txt'), prompt);

// 3) ask ChatGPT through ccd gpt (read-only Codex CLI)
console.error(`[gpt-review] ${path.basename(pdf)}: ${nPages} pages, ${images.length} page images → ChatGPT (round ${round})`);
const t0 = Date.now();
const r = spawnSync(process.execPath, [CCD, 'gpt', '--cd', work, '--file', path.join(work, 'paper.txt'), ...(images.length ? ['--image', images.join(',')] : []), prompt],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120 * 60e3 });
const answer = (r.stdout || '').trim();
try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
if (r.status !== 0 || !answer) {
  console.error(`[gpt-review] ChatGPT unavailable (exit ${r.status}): ${(r.stderr || '').trim().slice(-500)}`);
  process.exit(2);
}
const sha = crypto.createHash('sha256').update(fs.readFileSync(pdf)).digest('hex').slice(0, 12);
fs.writeFileSync(out, `# ChatGPT external review — round ${round}

- PDF: \`${path.relative(proj, pdf)}\` (sha256 ${sha}, ${nPages} pages) · ${new Date().toISOString()} · ${Math.round((Date.now() - t0) / 1000)}s
- Reviewer: ChatGPT via Codex CLI (read-only). **Not authoritative** — every item must be checked against the paper, data and literature before acting (see gpt_response_r${round}.md).

${answer}
`);
// machine-readable verdict for the review gate (lib/reviewgate.js): the VERDICT_JSON line, else the "Recommendation" text
const verdict = require('../lib/reviewgate').parseVerdict(answer);
const jsonOut = out.replace(/\.md$/, '.json');
fs.writeFileSync(jsonOut, JSON.stringify({ round, pdf_sha: sha, at: new Date().toISOString(), ...(verdict || { recommendation: null, error: 'verdict not found in the answer' }) }, null, 2));
console.log(out);
console.log(`[gpt-review] recommendation: ${verdict?.recommendation || '(not found — rerun)'} → ${path.relative(proj, jsonOut)}`);
