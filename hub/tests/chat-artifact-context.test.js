'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/files-artifacts.js'), 'utf8');

function setup({ role = 'assistant', output = '', preview, items = [], pending = false } = {}) {
  const calls = [];
  const chatHost = {
    querySelector: () => pending,
    querySelectorAll: () => [{ classList: { contains: (name) => name === role }, output }],
  };
  const ctx = vm.createContext({
    document: { addEventListener() {} },
    location: { hostname: '127.0.0.1' },
    matchMedia: () => ({ matches: false }),
    window: { addEventListener() {}, ACH_PREVIEW: { getActiveController: () => ({ activeArtifact: (sid) => sid === 'test' && preview }) } },
    AbortSignal,
    $: (_selector, row) => ({ textContent: row.output }),
    api: async (url) => { calls.push(url); return { items }; },
  });
  vm.runInContext(source, ctx);
  const infer = async (text, sid = 'test') => Array.from(await ctx.inferChatArtifacts(text, { sid, chatHost }));
  const results = (output, request) => Array.from(ctx.chatResultArtifacts(output, request, items), item => item.path);
  return { infer, calls, results };
}

test('an open artifact supplies context to a short follow-up without looking up other files', async () => {
  const { infer, calls } = setup({ preview: { path: 'D:/output/snapshot.zip' } });
  assert.deepEqual(await infer('설명해줘'), ['D:/output/snapshot.zip']);
  assert.deepEqual(await infer('이 결과에서 뭘 알 수 있어?', 'another-session'), []);
  assert.deepEqual(await infer('서버 상태 알려줘'), []);
  assert.deepEqual(calls, []);
});

test('chat shows deliverables and leaves source files mentioned in the reply out of previews', async () => {
  const items = [
    { name: 'index.html', path: 'D:/repo/hub/public/index.html', ext: 'html', kind: 'html' },
    { name: 'en.json', path: 'D:/repo/hub/i18n/en.json', ext: 'json', kind: 'text' },
    { name: 'report.html', path: 'D:/repo/reports/report.html', ext: 'html', kind: 'html' },
    { name: 'stats.csv', path: 'D:/repo/reports/stats.csv', ext: 'csv', kind: 'text' },
    { name: 'stats.json', path: 'D:/repo/reports/stats.json', ext: 'json', kind: 'text' },
  ];
  const { results, infer } = setup({ items, output: 'Changed index.html and en.json.' });
  assert.deepEqual(results('Changed index.html and en.json.', '미리보기를 수정해줘'), []);
  assert.deepEqual(await infer('이 결과를 설명해줘'), []);
  assert.deepEqual(results('산출물 report.html과 stats.csv를 저장했습니다.', ''), items.slice(2, 4).map(item => item.path));
  assert.deepEqual(results('완료했습니다. stats.json', 'stats.json으로 내보내 주세요.'), [items[4].path]);
  assert.deepEqual(results('변경 대상 stats.json 파일을 읽었습니다.', ''), []);
});

test('a result follow-up attaches referenced files from the last response and skips ambiguous names', async () => {
  const items = [
    { name: 'raw.bin', path: 'D:/output/raw.bin' },
    { name: 'stats.json', path: 'D:/output/stats.json' },
    { name: 'stats.json', path: 'D:/backup/stats.json' },
  ];
  const exact = setup({ items, output: '생성 결과는 D:\\output\\raw.bin 입니다.' });
  assert.deepEqual(await exact.infer('이 파일을 분석해줘'), ['D:/output/raw.bin']);
  assert.deepEqual(exact.calls, ['/api/artifacts?session=test']);
  const byName = setup({ items, output: '생성 결과는 raw.bin과 stats.json입니다.' });
  assert.deepEqual(await byName.infer('이거 뭐야?'), ['D:/output/raw.bin']);
  assert.deepEqual(await setup({ items, output: 'raw.bin', pending: true }).infer('이 결과 설명해줘'), []);
  assert.deepEqual(await setup({ items, output: 'raw.bin', role: 'user' }).infer('이 결과 설명해줘'), []);
});
