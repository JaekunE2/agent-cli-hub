// README pictures: a short scripted chat with demo sessions, against the mock Telegram API and the real
// Claude CLI. Writes <root>/_relay/calls.json + shoot.json; test/render.py turns them into phone screens.
//   node test/shoot.js <empty demo root> <en|ko> [model]
'use strict';
const { spawn, execFileSync } = require('child_process');
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(process.argv[2]), LANG = process.argv[3] || 'en', MODEL = process.argv[4] || 'haiku', API = 'http://127.0.0.1:18081';
const CHAT = 42, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = async (p, body, raw) => (await (await fetch(API + p, { method: body ? 'POST' : 'GET', body: raw ? body : body && JSON.stringify(body) })).json()).result;
let msgId = 1;
const msg = (extra) => call('/_push', { message: { message_id: msgId++, date: Math.floor(Date.now() / 1000), chat: { id: CHAT, type: 'private' }, from: { id: CHAT, first_name: 'Demo', language_code: LANG }, ...extra } });
const tap = (data) => call('/_push', { callback_query: { id: String(Math.random()), from: { id: CHAT }, data, message: { message_id: 1, chat: { id: CHAT } } } });
async function waitFor(pred, ms = 300000) {
  const t0 = Date.now();
  for (;;) { const hit = (await call('/_log')).filter(pred); if (hit.length) return hit; if (Date.now() - t0 > ms) throw new Error('timeout'); await sleep(1000); }
}
const ko = LANG === 'ko';
const SESSIONS = [
  ['image-classifier', ko ? '꽃 분류기 학습 결과 정리해줘. results 폴더를 보고 한 줄로 답해' : 'Summarize the flower classifier training run in results/, one line'],
  ['paper-draft', ko ? '로봇 파지 워크숍 논문 목차를 4개 절로 잡아줘. 한 줄씩' : 'Outline a 4-section workshop paper on robot grasping, one line each'],
  ['sensor-logs', ko ? 'data/raw.csv의 열 이름만 알려줘' : 'List the column names in data/raw.csv'],
];
(async () => {
  // demo projects with a little data
  const ic = path.join(ROOT, 'image-classifier');
  fs.mkdirSync(path.join(ic, 'results'), { recursive: true }); fs.mkdirSync(path.join(ROOT, 'paper-draft'), { recursive: true }); fs.mkdirSync(path.join(ROOT, 'sensor-logs', 'data'), { recursive: true });
  const rows = ['epoch,train_loss,val_acc']; for (let e = 1; e <= 30; e++) rows.push(`${e},${(1.9 * 0.9 ** e + 0.05).toFixed(3)},${Math.min(0.914, 0.41 + 0.5 * (1 - 0.88 ** e)).toFixed(3)}`);
  fs.writeFileSync(path.join(ic, 'results', 'train_log.csv'), rows.join('\n') + '\n');
  fs.writeFileSync(path.join(ic, 'results', 'per_class.csv'), 'class,precision,recall\ndaisy,0.93,0.92\ndandelion,0.95,0.95\nrose,0.86,0.86\nsunflower,0.94,0.94\ntulip,0.87,0.87\n');
  fs.writeFileSync(path.join(ROOT, 'sensor-logs', 'data', 'raw.csv'), 'time,temp_c,humidity,vibration_g\n0,21.3,40,0.01\n');
  const mine = [];
  for (const [dir, prompt] of SESSIONS) {
    const r = JSON.parse(execFileSync('claude', ['-p', '--output-format', 'json', '--model', MODEL, '--permission-mode', 'bypassPermissions'], { cwd: path.join(ROOT, dir), input: prompt, encoding: 'utf8' }));
    mine.push(r.session_id);
  }
  const data = path.join(ROOT, '_relay'); fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'state.json'), JSON.stringify({ offset: 0, chats: {}, mine }));
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ token: 'TEST', allowed: ['42'], apiBase: API, lang: LANG, model: MODEL, permissionMode: 'bypassPermissions' }));
  const mock = spawn(process.execPath, [path.join(__dirname, 'mock-telegram.js')], { stdio: 'ignore' });
  await sleep(800);
  const relay = spawn(process.execPath, [path.join(__dirname, '..', 'relay.js')], { env: { ...process.env, RELAY_CONFIG: path.join(data, 'config.json') }, stdio: 'ignore' });
  const prompt = ko
    ? 'results/train_log.csv로 손실·정확도 곡선을 figures/curves.png에, results/per_class.csv로 클래스별 정밀도·재현율 막대그래프를 figures/per_class.png에 그려 줘(matplotlib). 두 그림을 넣은 1쪽 PDF 보고서 results/report.pdf도 만들고 결과를 요약해 줘.'
    : 'Plot loss and accuracy from results/train_log.csv into figures/curves.png and a per-class precision/recall bar chart from results/per_class.csv into figures/per_class.png (matplotlib). Also make a one-page PDF report results/report.pdf with both figures, then summarize the results.';
  try {
    let t0 = Date.now();
    await msg({ text: '/start' });
    await waitFor((c) => c.at >= t0 && c.method === 'sendMessage' && (c.body.reply_markup?.inline_keyboard || []).flat().some((b) => /^sel:/.test(b.callback_data)), 20000);
    t0 = Date.now(); await tap(`sel:${mine[0]}`);
    await waitFor((c) => c.at >= t0 && c.method === 'pinChatMessage', 20000);
    t0 = Date.now(); await msg({ text: prompt });
    await waitFor((c) => c.at >= t0 && c.method === 'sendMessage' && /^💬/.test(c.body.text));
    await sleep(8000);
    t0 = Date.now(); await msg({ text: ko ? '📂 산출물' : '📂 Files' });
    await waitFor((c) => c.at >= t0 && c.method === 'sendMessage' && /^📂/.test(c.body.text), 20000);
    t0 = Date.now(); await msg({ text: ko ? '⚙ 설정' : '⚙ Settings' });
    await waitFor((c) => c.at >= t0 && c.method === 'sendMessage' && /^⚙/.test(c.body.text), 20000);
    fs.writeFileSync(path.join(data, 'calls.json'), JSON.stringify(await call('/_log'), null, 1));
    fs.writeFileSync(path.join(data, 'shoot.json'), JSON.stringify({ prompt, mine }));
    console.log('ok', ROOT);
  } finally { relay.kill(); mock.kill(); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
