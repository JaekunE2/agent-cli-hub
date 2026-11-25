'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createToolHooks, foldToolEvents } = require('../tool-activity-hooks');
const { collectSessionTraces } = require('../session-traces');
const { inspectGit } = require('../git-inspector');

test('foldToolEvents folds Pre->Post pairs and consecutive identical beats', () => {
  const folded = foldToolEvents([
    { ts: 1, tool: 'Read', target: 'a.js', status: 'start' },
    { ts: 2, tool: 'Read', target: 'a.js', status: 'done' },
    { ts: 3, tool: 'Read', target: 'a.js', status: 'done' },
    { ts: 4, tool: 'Edit', target: 'b.js', status: 'done' },
  ]);
  assert.equal(folded.length, 2);
  assert.equal(folded[0].tool, 'Read');
  assert.equal(folded[0].count, 2);
  assert.equal(folded[0].status, 'done');
  assert.equal(folded[1].tool, 'Edit');
  assert.equal(folded[1].count, 1);
});

test('createToolHooks records, reads, and folds events + collectSessionTraces finds instructions', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ach-hooks-'));
  let hooks = null;
  try {
    fs.writeFileSync(path.join(tmp, 'AGENTS.md'), '# Rules\n', 'utf8');
    hooks = createToolHooks({ baseDir: tmp, claudeDir: path.join(tmp, 'claude') });
    hooks.recordEvent({ termId: '99', sessionId: 's-1', tool: 'Read', target: path.join(tmp, 'AGENTS.md'), status: 'done' });
    hooks.recordEvent({ termId: '99', sessionId: 's-1', tool: 'Read', target: path.join(tmp, 'AGENTS.md'), status: 'done' });
    const res = hooks.getEvents({ termId: '99', sessionId: 's-1' });
    assert.equal(res.ok, true);
    assert.equal(res.rawCount, 2);
    assert.equal(res.events.length, 1);
    assert.equal(res.events[0].count, 2);

    const traces = collectSessionTraces({ toolHooks: hooks, claudeDir: path.join(tmp, 'claude') }, {
      termId: '99',
      sessionId: 's-1',
      cwd: tmp,
    });
    assert.equal(traces.ok, true);
    assert.ok(traces.instructions.some((f) => f.name === 'AGENTS.md'));
    assert.ok(traces.visitedFiles.some((f) => f.path.endsWith('AGENTS.md')));
  } finally {
    hooks?.close?.();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('inspectGit reads repo status, commits, and mermaid graph', async () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const res = await inspectGit(repoRoot);
  assert.equal(res.ok, true);
  assert.ok(res.branch);
  assert.ok(Array.isArray(res.commits) && res.commits.length > 0);
  assert.ok(res.mermaid.startsWith('gitGraph'));
});
