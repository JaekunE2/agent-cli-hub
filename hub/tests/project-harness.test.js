'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  ROLE_IDS,
  ADAPTER_CLIS,
  createProjectHarnessStore,
  resolveTaskRole,
  resolveTaskConfig,
  buildTaskHarnessPrompt,
} = require('../project-harness');
const { validate, inferTaskKind } = require('../project-validation');

test('createProjectHarnessStore initializes universal-agent-harness presets and supports save/reset', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-harness-test-'));
  const file = path.join(dir, 'project-harness.json');
  try {
    const store = createProjectHarnessStore(file);
    const init = store.get();
    for (const r of ROLE_IDS) {
      assert.ok(init.roles[r], `missing role ${r}`);
      assert.ok(init.roles[r].template.length > 20, `empty template for ${r}`);
    }
    for (const c of ADAPTER_CLIS) {
      assert.ok(init.adapters[c], `missing adapter ${c}`);
      assert.ok(init.adapters[c].rules.length > 10, `empty rules for ${c}`);
    }
    assert.equal(init.roles.plan.agent, 'claude');
    assert.equal(init.roles.dev.agent, 'codex');
    assert.equal(init.roles.review.agent, 'agy');

    const saved = store.save({
      roles: { dev: { agent: 'claude', model: 'sonnet', effort: 'medium', template: 'custom dev rule' } },
      adapters: { claude: { rules: 'custom claude adapter' } },
    });
    assert.equal(saved.roles.dev.agent, 'claude');
    assert.equal(saved.roles.dev.model, 'sonnet');
    assert.equal(saved.roles.dev.template, 'custom dev rule');
    assert.equal(saved.adapters.claude.rules, 'custom claude adapter');

    const reset = store.reset();
    assert.equal(reset.roles.dev.agent, 'codex');
    assert.equal(reset.roles.dev.model, 'gpt-6.2-sol');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveTaskConfig prefers task and project CLIs and preserves legacy fallbacks', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-harness-cfg-'));
  const store = createProjectHarnessStore(path.join(dir, 'project-harness.json'));
  try {
    const harness = store.get();
    const project = { id: 'p1', name: 'Demo', cwd: dir, goal: 'Build', agent: 'codex', account: '', model: 'gpt-5.4', effort: 'medium', tasks: [] };

    const reviewTask = { id: 't1', title: '교차 코드 리뷰', detail: '보안 점검', kind: 'review' };
    const cfgReview = resolveTaskConfig(project, reviewTask, harness);
    assert.equal(cfgReview.roleId, 'review');
    assert.equal(cfgReview.agent, 'codex');
    assert.equal(cfgReview.agentSource, 'project');
    assert.equal(cfgReview.model, 'gpt-5.4');
    assert.equal(cfgReview.effort, 'medium');
    const legacy = resolveTaskConfig({ ...project, agent: '' }, reviewTask, harness);
    assert.equal(legacy.agent, 'agy');
    assert.equal(legacy.agentSource, 'role');
    assert.equal(legacy.model, 'gemini-4-argon-high');
    assert.equal(resolveTaskConfig(project, reviewTask, harness, { preferProject: false }).agent, 'agy');

    const overrideTask = { id: 't2', title: '직접 지정 리뷰', detail: '', kind: 'review', agent: 'claude', model: 'opus', effort: 'max' };
    const cfgOverride = resolveTaskConfig(project, overrideTask, harness);
    assert.equal(cfgOverride.agent, 'claude');
    assert.equal(cfgOverride.agentSource, 'task');
    assert.equal(cfgOverride.model, 'opus');
    assert.equal(cfgOverride.effort, 'max');
    const child = { ...reviewTask, parentId: overrideTask.id };
    const withParent = { ...project, tasks: [overrideTask] };
    assert.equal(resolveTaskConfig(withParent, child, harness).agent, 'codex');
    assert.equal(resolveTaskConfig({ ...withParent, agent: undefined }, child, harness).agentSource, 'parent');

    const prompt = buildTaskHarnessPrompt(project, reviewTask, cfgReview.agent, harness);
    assert.match(prompt, /Role 하네스/);
    assert.match(prompt, /Blocker \/ Warning \/ Note/);
    assert.match(prompt, /CLI 어댑터/);
    assert.equal(resolveTaskRole(reviewTask), 'review');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('project-validation supports review kind and infers review titles', () => {
  assert.equal(inferTaskKind('이종 모델 교차 리뷰 및 감사'), 'review');
  const p = validate({
    name: 'Test',
    cwd: 'D:\\tmp',
    goal: 'Goal',
    termIds: [],
    tasks: [{ id: 't1', title: '코드 리뷰', detail: '체크', stage: 'planned', kind: 'review', role: 'review', after: [], termId: '' }],
  });
  assert.equal(p.tasks[0].kind, 'review');
  assert.equal(p.tasks[0].role, 'review');
});
