// Mechanically verify a BibTeX file: every entry must resolve by DOI (Crossref), arXiv id,
// or title search (Crossref / Semantic Scholar), and the found title must match.
// Usage: node --use-system-ca verify-bib.js <refs.bib> [--json out.json]
// Exit code 1 if any entry is unverified. The LLM's own belief is never evidence here.
const fs = require('fs');

const file = process.argv[2];
if (!file) { console.error('usage: node --use-system-ca verify-bib.js refs.bib [--json out.json]'); process.exit(2); }
const jsonOut = process.argv.includes('--json') ? process.argv[process.argv.indexOf('--json') + 1] : null;
// --abstracts DIR: save each paper's real abstract (source text for the claim-verification step)
const absDir = process.argv.includes('--abstracts') ? process.argv[process.argv.indexOf('--abstracts') + 1] : null;
if (absDir) fs.mkdirSync(absDir, { recursive: true });
const src = fs.readFileSync(file, 'utf8');

function parseBib(s) {
  const out = [];
  const re = /@(\w+)\s*\{\s*([^,\s]+)\s*,([\s\S]*?)\n\}/g;
  let m;
  while ((m = re.exec(s))) {
    const fields = {};
    const fre = /(\w+)\s*=\s*(\{((?:[^{}]|\{[^{}]*\})*)\}|"([^"]*)"|(\d+))/g;
    let f;
    while ((f = fre.exec(m[3]))) fields[f[1].toLowerCase()] = (f[3] ?? f[4] ?? f[5] ?? '').replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
    out.push({ type: m[1].toLowerCase(), key: m[2], ...fields });
  }
  return out;
}
const norm = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function titleSim(a, b) {
  const A = new Set(norm(a).split(' ').filter((w) => w.length > 2)), B = new Set(norm(b).split(' ').filter((w) => w.length > 2));
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const w of A) if (B.has(w)) inter++;
  return inter / Math.max(A.size, B.size);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url, asText = false) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': 'research-harness-verify-bib/1.0 (mailto:noreply@example.com)' }, signal: AbortSignal.timeout(20000) });
      if (r.status === 429) { await sleep(3000 * (i + 1)); continue; }
      if (!r.ok) return null;
      return asText ? await r.text() : await r.json();
    } catch { await sleep(1500); }
  }
  return null;
}

async function verify(e) {
  if (e.doi) {
    const j = await get(`https://api.crossref.org/works/${encodeURIComponent(e.doi.replace(/^https?:\/\/doi.org\//, ''))}`);
    const t = j?.message?.title?.[0];
    if (t) return { ok: titleSim(t, e.title) >= 0.6, via: 'crossref-doi', found: t };
  }
  const arx = e.eprint || (e.journal || e.url || '').match(/(\d{4}\.\d{4,5})/)?.[1];
  if (arx) {
    const x = await get(`http://export.arxiv.org/api/query?id_list=${arx}`, true);
    const t = x?.match(/<entry>[\s\S]*?<title>([\s\S]*?)<\/title>/)?.[1]?.replace(/\s+/g, ' ');
    const summary = x?.match(/<entry>[\s\S]*?<summary>([\s\S]*?)<\/summary>/)?.[1]?.replace(/\s+/g, ' ').trim();
    if (t) return { ok: titleSim(t, e.title) >= 0.6, via: 'arxiv', found: t, abstract: summary };
  }
  if (e.title) {
    const s = await get(`https://api.semanticscholar.org/graph/v1/paper/search?limit=3&fields=title,year,externalIds,abstract&query=${encodeURIComponent(e.title)}`);
    const best = (s?.data || []).map((p) => ({ p, sim: titleSim(p.title, e.title) })).sort((a, b) => b.sim - a.sim)[0];
    if (best && best.sim >= 0.8) return { ok: true, via: 'semanticscholar', found: best.p.title, year: best.p.year, ids: best.p.externalIds, abstract: best.p.abstract };
    const c = await get(`https://api.crossref.org/works?rows=3&query.bibliographic=${encodeURIComponent(e.title)}`);
    const cb = (c?.message?.items || []).map((it) => ({ t: it.title?.[0], doi: it.DOI, sim: titleSim(it.title?.[0], e.title) })).sort((a, b) => b.sim - a.sim)[0];
    if (cb && cb.sim >= 0.8) return { ok: true, via: 'crossref-title', found: cb.t, doi: cb.doi };
    return { ok: false, via: 'search', found: best?.p?.title || cb?.t || null };
  }
  return { ok: false, via: 'none', found: null, note: 'no doi/eprint/title' };
}

// best-effort abstract lookup for entries verified via DOI (Semantic Scholar by DOI, then Crossref)
async function abstractFor(e, r) {
  const doi = (e.doi || r.doi || '').replace(/^https?:\/\/doi.org\//, '');
  if (doi) {
    const s = await get(`https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURIComponent(doi)}?fields=abstract`);
    if (s?.abstract) return s.abstract;
    const c = await get(`https://api.crossref.org/works/${encodeURIComponent(doi)}`);
    const a = c?.message?.abstract; if (a) return a.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  return null;
}

(async () => {
  const entries = parseBib(src);
  const results = [];
  for (const e of entries) {
    const r = await verify(e);
    if (r.ok && !r.abstract) r.abstract = await abstractFor(e, r);
    if (absDir && r.ok) fs.writeFileSync(require('path').join(absDir, `${e.key}.txt`), `${r.found || e.title}
source: ${r.via}

${r.abstract || '(abstract not available — read the paper itself before citing it for a claim)'}
`);
    const { abstract, ...keep } = r;
    results.push({ key: e.key, title: e.title, ...keep, hasAbstract: !!abstract });
    console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${e.key.padEnd(28)} ${r.via.padEnd(16)} ${r.ok ? '' : '→ found: ' + (r.found || '(nothing)')}`);
    await sleep(1100); // be polite to the APIs
  }
  const bad = results.filter((r) => !r.ok);
  console.log(`\n${results.length - bad.length}/${results.length} verified${bad.length ? ` · UNVERIFIED: ${bad.map((b) => b.key).join(', ')}` : ''}`);
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2));
  process.exit(bad.length ? 1 : 0);
})();
