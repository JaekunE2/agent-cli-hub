'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { renderFloorplanDiagram } = require('./floorplan-diagram');

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const NODE_ID = /^node-[0-9a-f]{16}$/;
const rootOf = base => path.join(base, 'data', 'floorplan-diagrams');

function diagramFile(base, id, format) {
  if (!UUID.test(id) || !['html', 'svg'].includes(format)) return null;
  return path.join(rootOf(base), id, 'architecture.' + format);
}

async function snapshotSource(root, evidence) {
  const empty = { ...evidence, first: evidence.line, lines: [] };
  try {
    const file = await fs.realpath(path.join(root, evidence.path));
    const rel = path.relative(root, file);
    if (!rel || rel.startsWith('..' + path.sep) || rel === '..' || path.isAbsolute(rel)) return empty;
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > 256 * 1024) return empty;
    const rows = (await fs.readFile(file, 'utf8')).split(/\r?\n/);
    if (evidence.line > rows.length || rows.some(row => row.includes('\0'))) return empty;
    const first = Math.max(1, evidence.line - 5);
    return { ...evidence, first, lines: rows.slice(first - 1, evidence.line + 8).map(row => row.slice(0, 400)) };
  } catch { return empty; }
}

async function saveDiagram(base, sourceDir, floorplan, options) {
  const root = await fs.realpath(sourceDir);
  const id = randomUUID();
  const result = renderFloorplanDiagram(floorplan, options);
  const sources = await Promise.all(result.evidence.map(item => snapshotSource(root, item)));
  const file = diagramFile(base, id, 'html');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await Promise.all([
    fs.writeFile(file, result.html, 'utf8'),
    fs.writeFile(diagramFile(base, id, 'svg'), result.svg, 'utf8'),
    fs.writeFile(path.join(rootOf(base), id, 'source.json'), JSON.stringify(sources), 'utf8'),
  ]);
  return { id, path: file, name: 'architecture.html', kind: 'html', ext: 'html', size: Buffer.byteLength(result.html) };
}

async function diagramSource(base, id, nodeId) {
  if (!UUID.test(id) || !NODE_ID.test(nodeId)) return null;
  try {
    const evidence = JSON.parse(await fs.readFile(path.join(rootOf(base), id, 'source.json'), 'utf8'));
    return evidence.find(item => item.id === nodeId) || null;
  } catch { return null; }
}

module.exports = { diagramFile, saveDiagram, diagramSource };
