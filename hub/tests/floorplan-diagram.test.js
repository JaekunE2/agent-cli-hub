'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { renderFloorplanDiagram } = require('../floorplan-diagram');
const { saveDiagram, diagramFile, diagramSource } = require('../floorplan-diagram-store');

const node = (id, file) => ({ id, name: file, relPath: file, endpoints: [], calls: [] });
const options = { title: 'Sample <script>', commit: '0'.repeat(40), locale: 'en', scannedAt: 0 };
const graph = {
  nodes: [node('a', 'server.js'), node('b', 'client.js'), node('c', 'other.js')],
  edges: [{ from: 'b', to: 'a', kind: 'api', label: 'GET /sample' }], stats: { files: 3 },
};

test('share diagram shows only detected links and escapes workspace labels', () => {
  const result = renderFloorplanDiagram(graph, options);
  assert.equal((result.svg.match(/class="edge"/g) || []).length, 1);
  assert.match(result.svg, /GET \/sample/);
  assert.match(result.html, /Sample &lt;script&gt;/);
  assert.match(result.html, /Source commit/);
  assert.doesNotMatch(result.html, /other\.js|fonts\.googleapis/);
  assert.ok(result.evidence.every(entry => /^node-[a-f0-9]{16}$/.test(entry.id)));
  const repeat = renderFloorplanDiagram(graph, { ...options, scannedAt: 10 });
  assert.deepEqual(repeat.evidence.map(e => e.id), result.evidence.map(e => e.id));
  assert.doesNotMatch(renderFloorplanDiagram({ ...graph, edges: [] }, options).svg, /class="edge"/);
});

test('source excerpt is served separately and the snapshot cannot follow a path out of the workspace', async t => {
  const temp = await fs.realpath(os.tmpdir());
  const dir = await fs.mkdtemp(path.join(temp, 'hub-floorplan-share-'));
  t.after(async () => {
    assert.equal(path.dirname(await fs.realpath(dir)), temp);
    await fs.rm(dir, { recursive: true, force: true });
  });
  const project = path.join(dir, 'workspace');
  await fs.mkdir(project);
  await fs.writeFile(path.join(project, 'server.js'), 'private source line');
  await fs.writeFile(path.join(dir, 'outside.js'), 'outside source');
  const fixture = { ...graph, nodes: [node('a', 'server.js'), node('b', '../outside.js')] };
  const { evidence } = renderFloorplanDiagram(fixture, options);
  const file = await saveDiagram(dir, project, fixture, options);
  const html = await fs.readFile(file.path, 'utf8');
  assert.doesNotMatch(html, /private source line|outside source/);
  assert.equal((await diagramSource(dir, file.id, evidence.find(row => row.path === 'server.js').id)).lines[0], 'private source line');
  assert.deepEqual((await diagramSource(dir, file.id, evidence.find(row => row.path === '../outside.js').id)).lines, []);
  assert.equal(diagramFile(dir, '../outside', 'html'), null);
  assert.equal(diagramFile(dir, file.id, 'source'), null);
  assert.equal(await diagramSource(dir, file.id, 'unlisted'), null);
});
