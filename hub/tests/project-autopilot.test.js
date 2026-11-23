'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { findReadyTasks, runProjectAutopilot } = require('../project-autopilot');
const { validate } = require('../project-validation');

test('findReadyTasks returns only planned tasks whose prerequisites are all done and not running', () => {
  const project = {
    id: 'p1',
    autopilot: true,
    tasks: [
      { id: 't1', title: '1. Plan', stage: 'done', after: [] },
      { id: 't2', title: '2. Dev A', stage: 'planned', after: ['t1'] },
      { id: 't3', title: '3. Dev B', stage: 'planned', after: ['t1'] },
      { id: 't4', title: '4. QA', stage: 'planned', after: ['t2', 't3'] },
      { id: 't5', title: '5. Already Running', stage: 'planned', after: ['t1'] },
    ],
  };
  const liveTerms = [
    { exited: null, meta: { projectTask: { projectId: 'p1', taskId: 't5' } } },
  ];
  const ready = findReadyTasks(project, liveTerms);
  assert.deepEqual(ready.map((t) => t.id), ['t2', 't3']);
});

test('runProjectAutopilot transitions ready tasks to doing and starts them when autopilot is true', async () => {
  let savedProject = {
    id: 'p1',
    name: 'Auto',
    cwd: 'D:\\tmp',
    goal: 'Goal',
    autopilot: true,
    termIds: [],
    tasks: [
      { id: 't1', title: '1. Plan', stage: 'done', after: [], termId: '' },
      { id: 't2', title: '2. Dev', stage: 'planned', after: ['t1'], termId: '' },
      { id: 't3', title: '3. QA', stage: 'planned', after: ['t2'], termId: '' },
    ],
  };
  const launched = [];
  const fakeHub = {
    terms: new Map(),
    projects: {
      list: () => [savedProject],
      save: (next) => { savedProject = next; return savedProject; },
    },
    startProjectTaskById: async (pid, tid, opts) => {
      launched.push({ pid, tid, opts });
      return { id: 'term-1' };
    },
  };

  const res = await runProjectAutopilot(fakeHub, 'p1');
  assert.equal(res.started.length, 1);
  assert.equal(res.started[0].taskId, 't2');
  assert.equal(savedProject.tasks.find((t) => t.id === 't2').stage, 'doing');
  assert.equal(savedProject.tasks.find((t) => t.id === 't3').stage, 'planned');
  assert.equal(launched[0].opts.autoDispatch, true);
});

test('project-validation preserves autopilot boolean flag', () => {
  const valid = validate({
    name: 'AutoProj',
    cwd: 'D:\\tmp',
    goal: 'Goal',
    autopilot: true,
    termIds: [],
    tasks: [],
  });
  assert.equal(valid.autopilot, true);
});
