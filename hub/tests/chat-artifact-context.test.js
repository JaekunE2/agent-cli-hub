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
  return { infer, calls };
}

test('an open artifact supplies context to a short follow-up without looking up other files', async () => {
  const { infer, calls } = setup({ preview: { path: 'D:/output/snapshot.zip' } });
  assert.deepEqual(await infer('설명해줘'), ['D:/output/snapshot.zip']);
  assert.deepEqual(await infer('이 결과에서 뭘 알 수 있어?', 'another-session'), []);
  assert.deepEqual(await infer('서버 상태 알려줘'), []);
  assert.deepEqual(calls, []);
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
