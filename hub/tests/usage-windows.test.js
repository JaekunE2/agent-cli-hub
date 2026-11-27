'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { claudeLimits } = require('../../ai-usage/claude-limits');
const { translateJs } = require('../i18n');

const modernClaude = {
  limits: [
    { kind: 'weekly_model', group: 'weekly', scope: { model: { id: 'claude-fable-5-2' } }, percent: 93 },
    { kind: 'session', percent: 0 },
    { kind: 'weekly_all', percent: 64 },
  ],
};

test('Claude keeps 5-hour, overall weekly and Fable limits separate across response formats', () => {
  const keys = meters => meters.map(m => [m.name, m.usedPercent]);
  const expected = [['5시간 세션', 0], ['주간 (전체 모델)', 64], ['주간 (Fable)', 93]];
  assert.deepEqual(keys(claudeLimits(modernClaude)), expected);
  const fable = { utilization: 93, resets_at: '2027-01-03T00:00:00Z' };
  const legacy = { five_hour: { utilization: 0 }, seven_day: { utilization: 64 }, seven_day_fable: fable };
  assert.deepEqual(keys(claudeLimits(legacy)), expected);
  const mixed = claudeLimits({ limits: modernClaude.limits.slice(1), seven_day_fable: fable });
  assert.deepEqual(keys(mixed), expected);
  assert.equal(mixed[2].resetsAt, fable.resets_at);
});

function renderUsage(accounts, lang = 'ko', agyQuota) {
  const src = fs.readFileSync(path.join(__dirname, '../public/usage-ui.js'), 'utf8');
  const view = {};
  const context = vm.createContext({
    window: {}, state: { usage: { available: true, accounts }, agyQuota },
    $: selector => selector === '#view' ? view : null, ICO: { chevRight: '' }, agentIcon: () => '', systemTopHTML: () => '',
    esc: value => String(value).replaceAll('<', '&lt;'),
  });
  vm.runInContext(lang === 'en' ? translateJs(src) : src, context);
  vm.runInContext('paintUsage()', context);
  return view.innerHTML;
}

test('account cards show each available limit in the main view in both languages', () => {
  const accounts = [
    { id: 'claude', type: 'claude', label: 'Claude', ok: true, meters: claudeLimits(modernClaude) },
    { id: 'codex', type: 'codex', label: 'Codex', ok: true, meters: [
      { name: 'Codex 5-hour limit', usedPercent: 30 }, { name: 'Codex Weekly limit', usedPercent: 75 },
    ] },
  ];
  const agy = { groups: [{ name: 'Gemini', fiveH: 50, weekly: 80 }] };
  assert.match(renderUsage(accounts, 'ko', agy), /5시간<\/span>[^<]*<b[^>]*>100% 남음[\s\S]*주간 \(전체 모델\)<\/span>[^<]*<b[^>]*>36% 남음[\s\S]*주간 \(Fable\)<\/span>[^<]*<b[^>]*>7% 남음/);
  const en = renderUsage(accounts, 'en', agy);
  assert.match(en, /5h<\/span>[^<]*<b[^>]*>70% left[\s\S]*Weekly<\/span>[^<]*<b[^>]*>25% left/i);
  assert.match(en, /Gemini[\s\S]*50% left[\s\S]*20% left/i);
  const partial = renderUsage([{ ...accounts[0], meters: [accounts[0].meters[2]] }]);
  assert.match(partial, /주간 \(전체 모델\)<\/span><span class="ums">한도 정보 없음/);
  assert.match(partial, /주간 \(Fable\)<\/span>[^<]*<b[^>]*>7% 남음/);
});
