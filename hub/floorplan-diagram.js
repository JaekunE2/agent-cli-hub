'use strict';

const { createHash } = require('node:crypto');

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);

function diagramNodes(floorplan) {
  const nodes = new Map(floorplan.nodes.map(node => [node.id, node]));
  const edges = floorplan.edges.filter(edge => edge.from !== edge.to && nodes.has(edge.from) && nodes.has(edge.to));
  const adjacency = new Map();
  for (const { from, to } of edges) {
    if (!adjacency.has(from)) adjacency.set(from, new Set());
    if (!adjacency.has(to)) adjacency.set(to, new Set());
    adjacency.get(from).add(to);
    adjacency.get(to).add(from);
  }
  const focal = floorplan.nodes.find(node => adjacency.has(node.id)) || floorplan.nodes[0];
  const incoming = [], outgoing = [];
  for (const node of floorplan.nodes) {
    if (!adjacency.get(focal.id)?.has(node.id)) continue;
    const inEdge = edges.find(edge => edge.from === node.id && edge.to === focal.id);
    const outEdge = edges.find(edge => edge.from === focal.id && edge.to === node.id);
    if (inEdge && incoming.length < 2) incoming.push({ node, edge: inEdge, reverse: outEdge });
    else if (!inEdge && outgoing.length < 2) outgoing.push({ node, edge: outEdge });
  }
  return { focal, incoming, outgoing };
}

const tokens = `
  --paper:#f5f5f3;--surface:#fff;--ink:#1e2430;--muted:#4b5669;--accent:#b24924;--edge:#2856a3;
  color-scheme:light dark;color:var(--ink);background:var(--paper);font:16px system-ui,sans-serif;
`;
const dark = `
  --paper:#12161f;--surface:#1a1f2b;--ink:#f1f3f7;--muted:#b6bfce;--accent:#f08a59;--edge:#77a4e6;
`;

function renderFloorplanDiagram(floorplan, { title, commit, dirty, locale, scannedAt }) {
  const en = locale === 'en';
  const label = en ? {
    architecture: 'Architecture overview', connected: 'Selected connections found by the static scan',
    isolated: 'No local connection was found in the scan', fit: 'Fit', zoom: 'Zoom in',
    evidence: 'Source evidence', open: 'Open source', files: 'Scanned files',
    baseline: 'Base commit · working tree changes included', revision: 'Source commit', date: 'Scanned at',
  } : {
    architecture: '아키텍처 개요', connected: '정적 스캔에서 찾은 주요 연결',
    isolated: '정적 스캔에서 로컬 연결을 찾지 못했습니다.', fit: '화면에 맞춤', zoom: '확대',
    evidence: '코드 근거', open: '원본 코드 열기', files: '스캔한 파일',
    baseline: '기준 커밋 · 작업 폴더 변경 포함', revision: '소스 커밋', date: '스캔 시각',
  };
  const { focal, incoming, outgoing } = diagramNodes(floorplan);
  const selected = [];
  const connectors = [];
  const renderRow = (members, y, above) => members.forEach(({ node, edge, reverse }, i) => {
    const x = members.length === 1 ? 340 : 168 + i * 344;
    const port = members.length === 1 ? 340 : 296 + i * 88;
    const start = above ? y + 63 : y;
    const end = above ? 137 : 200;
    const bend = (start + end) / 2;
    const sign = Math.sign(port - x);
    const vertical = Math.sign(end - start);
    const path = x === port ? `M${x},${start} V${end}`
      : `M${x},${start} V${bend - vertical * 6} Q${x},${bend} ${x + sign * 6},${bend} H${port - sign * 6} Q${port},${bend} ${port},${bend + vertical * 6} V${end}`;
    const endMarker = above ? 'marker-end' : 'marker-start';
    const otherMarker = above ? 'marker-start' : 'marker-end';
    connectors.push(`<path class="edge" d="${path}" ${endMarker}="url(#arrow)" ${reverse ? `${otherMarker}="url(#arrow)"` : ''}><title>${escape([edge.label, reverse?.label].filter(Boolean).join(' / ') || edge.kind)}</title></path>`);
    selected.push({ node, x, y });
  });
  renderRow(incoming, 20, true);
  selected.push({ node: focal, x: 340, y: 137, emphasis: true });
  renderRow(outgoing, 254, false);
  const top = incoming.length ? 0 : 117;
  const bottom = outgoing.length ? 337 : 220;
  const evidence = selected.map(({ node }) => {
    const id = 'node-' + createHash('sha256').update(node.relPath).digest('hex').slice(0, 16);
    const api = (node.endpoints || []).slice(0, 3).map(row => ({ text: `${row.method} ${row.path}`, line: row.line }));
    const calls = (node.calls || []).slice(0, 3).map(row => ({ text: row.path, line: row.line }));
    return { id, path: node.relPath, line: Number(api[0]?.line || calls[0]?.line) || 1, details: [...api, ...calls] };
  });
  const truncate = (value, max) => {
    let used = 0, text = '';
    for (const char of String(value)) {
      used += char.codePointAt(0) >= 0x1100 ? 2 : 1;
      if (used > max) return text + '…';
      text += char;
    }
    return text;
  };
  const shape = selected.map(({ node, x, y, emphasis }, i) => {
    const { id, path } = evidence[i];
    return `<a href="#proof-${id}" aria-label="${escape(path)}"><rect id="${id}" class="node${emphasis ? ' focal' : ''}" x="${x - 151}" y="${y}" width="302" height="63" rx="7"/><text class="name" x="${x - 136}" y="${y + 25}">${escape(truncate(node.name, 19))}</text><text class="path" x="${x - 136}" y="${y + 47}">${escape(truncate(path, 27))}</text><title>${escape(path)}</title></a>`;
  }).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 ${top} 680 ${bottom - top}" role="group" aria-labelledby="diagram-title">
<title id="diagram-title">${escape(title)} · ${label.architecture}</title>
<style>
svg{${tokens}}@media(prefers-color-scheme:dark){svg{${dark}}}
.node{fill:var(--surface);stroke:var(--muted);stroke-width:1.5}.focal,a:hover .node,a:focus .node{stroke:var(--accent);stroke-width:3}
text{pointer-events:none;fill:var(--ink)}.name{font-size:23px;font-weight:650}.path{font-size:15px;fill:var(--muted)}
.edge{fill:none;stroke:var(--edge);stroke-width:2}
</style>
<defs><marker id="arrow" viewBox="0 0 8 8" markerWidth="5" markerHeight="5" refX="7" refY="4" orient="auto-start-reverse"><path fill="var(--edge)" d="M0 0L8 4L0 8z"/></marker></defs>
<rect x="0" y="${top}" width="680" height="${bottom - top}" fill="var(--paper)"/>
${connectors.join('')}${shape}</svg>`;
  const scanned = new Date(scannedAt).toISOString();
  const summary = (incoming.length || outgoing.length) ? label.connected : label.isolated;
  const html = `<!doctype html><html lang="${en ? 'en' : 'ko'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)} · ${label.architecture}</title>
<style>
:root{${tokens}}@media(prefers-color-scheme:dark){:root{${dark}}}
*{box-sizing:border-box}body{margin:0 auto;max-width:960px;padding:clamp(12px,3vw,32px)}h1{overflow-wrap:anywhere;margin:0}header p{color:var(--muted);margin:6px 0;overflow-wrap:anywhere}
nav{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0 8px}button{font:inherit;color:var(--ink);background:var(--surface);border:1px solid var(--muted);border-radius:5px;min-height:32px;cursor:pointer}button[aria-pressed=true]{border-color:var(--accent);font-weight:650}
.viewport{overflow:auto;border:1px solid var(--muted);border-radius:8px}.viewport>svg{width:100%;height:auto;display:block}.viewport.zoom>svg{width:max(820px,140%)}
section{overflow-wrap:anywhere;border-top:1px solid var(--muted);padding:12px 0}section:target{outline:2px solid var(--accent);outline-offset:3px}section h3{font-size:1rem;margin:0 0 4px}ul{padding-inline-start:22px}:focus-visible{outline:2px solid var(--accent)}
</style></head><body><header><h1>${escape(title)} · ${label.architecture}</h1><p>${summary}</p>
<p>${label.files} ${floorplan.stats.files} · ${label.date} <time datetime="${scanned}">${scanned}</time>${commit ? ` · ${dirty ? label.baseline : label.revision} <code>${escape(commit)}</code>` : ''}</p></header>
<nav><button type="button" data-fit disabled aria-pressed="true">${label.fit}</button><button type="button" data-zoom disabled aria-pressed="false">${label.zoom}</button></nav><div class="viewport" tabindex="0">${svg}</div>
<h2>${label.evidence}</h2>
${evidence.map(item => `<section id="proof-${item.id}"><h3><code>${escape(item.path)}:${item.line}</code></h3><button type="button" data-source="${item.id}" hidden>${label.open}</button>
${item.details.length ? `<ul>${item.details.map(row => `<li><code>${escape(row.text)} · L${escape(row.line)}</code></li>`).join('')}</ul>` : ''}</section>`).join('')}
<script>
const fit=document.querySelector('[data-fit]'),zoom=document.querySelector('[data-zoom]'),view=document.querySelector('.viewport');
for (const button of [fit,zoom]) {
 button.addEventListener('click',()=>{
  const active=button===zoom;view.classList.toggle('zoom',active);if(!active)view.scrollLeft=0;
  fit.setAttribute('aria-pressed',!active);zoom.setAttribute('aria-pressed',active);
 });
 button.disabled=false;
}
if(parent!==window) for(const button of document.querySelectorAll('[data-source]')){
 button.hidden=false;
 button.addEventListener('click',()=>parent.postMessage({type:'hub-diagram-source',node:button.dataset.source},'*'));
}
</script></body></html>`;
  return { html, svg, evidence };
}

module.exports = { renderFloorplanDiagram };
