'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const i18n = require('../i18n');

const HUB_DIR = path.resolve(__dirname, '..');
const ROOT_DIR = path.resolve(HUB_DIR, '..');
const dict = JSON.parse(fs.readFileSync(path.join(HUB_DIR, 'i18n', 'en.json'), 'utf8'));

function walkFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'tests', 'i18n', 'local'].includes(e.name)) continue; // local/ = machine-specific, not in the repo
    const p = path.join(dir, e.name);
    if (p === path.join(HUB_DIR, 'data')) continue; // runtime data, e.g. App Store packages installed on this PC
    if (e.isDirectory()) walkFiles(p, out);
    else if (/\.(js|html)$/.test(e.name) && e.name !== 'i18n.js') out.push(p);
  }
  return out;
}

const ALLOWED_REMAINING_HANGUL = new Set([
  'At the end of the "대기 중" list in todo.md,',
  'A date read from a "일정" line in todo.md (edit it in todo.md).',
]);

test('session folder controls and trust settings are fully translated', () => {
  const publicDir = path.join(HUB_DIR, 'public');
  for (const name of fs.readdirSync(publicDir).filter((name) => /^workspace-.*\.js$/.test(name))) {
    const source = fs.readFileSync(path.join(publicDir, name), 'utf8');
    assert.deepEqual([...i18n.extract(source, 'js')].filter((key) => !Object.hasOwn(dict, key)), [], name);
    assert.deepEqual([...i18n.extract(i18n.translateJs(source), 'js')], [], name);
  }
  assert.equal(dict['신뢰 폴더'], 'Trusted folders');
});

test('en.json covers all extractable Korean UI/server strings without leaving broken tag pieces', () => {
  const files = [...walkFiles(HUB_DIR), ...walkFiles(path.join(ROOT_DIR, 'ai-usage'))];
  const missing = [];
  const brokenTags = [];
  const leftoverHangul = [];

  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const kind = f.endsWith('.html') ? 'html' : 'js';
    const pieces = i18n.extract(src, kind);
    for (const p of pieces) {
      if (typeof dict[p] !== 'string') missing.push(`${path.relative(ROOT_DIR, f)}: ${p}`);
      if (/^(?:title|aria-|placeholder|data-|class)=|\\?"\s+(?:title|aria-|placeholder|data-)/.test(p)) {
        brokenTags.push(`${path.relative(ROOT_DIR, f)}: ${p}`);
      }
    }
    const out = kind === 'html' ? i18n.translateHtml(src) : i18n.translateJs(src);
    for (const rem of i18n.extract(out, kind)) {
      if (!ALLOWED_REMAINING_HANGUL.has(rem)) {
        leftoverHangul.push(`${path.relative(ROOT_DIR, f)}: ${rem}`);
      }
    }
    const stripped = out.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
    for (const line of stripped.split(/\r?\n/)) {
      if (/(?:document\.documentElement\.lang|language\(\)|isEnUI\(\))\s*===\s*'en'|\bisEnUI\(\)/.test(line) || /^\s*:\s*'[^']*<(?:모델|폴더)>/.test(line)) continue;
      for (const m of line.match(/<[^<>\n]*[가-힣][^<>\n]*>/g) || []) {
        leftoverHangul.push(`${path.relative(ROOT_DIR, f)} (angle-bracket): ${m}`);
      }
    }
  }

  assert.deepEqual(brokenTags, [], 'HTML attributes with Hangul must not be split across ${...} chunks');
  assert.deepEqual(missing, [], 'Missing keys in hub/i18n/en.json');
  assert.deepEqual(leftoverHangul, [], 'Untranslated Hangul pieces remaining after translation');
});

test('i18n unit & UI translations produce clean English spacing and key labels', () => {
  assert.equal(i18n.translateText('홈'), 'Home');
  assert.equal(i18n.translateText('코드 구조'), 'Floorplan');
  assert.equal(i18n.translateText('진행'), 'In Progress');
  assert.equal(i18n.translateText('검토'), 'Review');
  assert.equal(i18n.translateText('줄'), ' lines');
  assert.equal(i18n.translateText('점'), ' pts');
  assert.equal(i18n.translateText('개 파일'), ' files');
  assert.equal(i18n.translateText('자)'), ' chars)');
  assert.equal(i18n.translateText('분 전'), 'm ago');

  const html = i18n.translateHtml('<html lang="ko"><title>Agent CLI Hub</title><button title="허브 및 사용량 서버 상태 확인">허브 ON</button></html>');
  assert.match(html, /^<html lang="en">/);
  assert.ok(html.includes('title="Check Hub & AI Usage server status"'));
  assert.ok(html.includes('>Hub ON<'));
});
