// End-to-end test against the mock Telegram API and the real Claude CLI.
//   node test/e2e.js <work dir> [model]
// Creates a conversation in <work dir>, then drives the relay like a phone would: pick it with buttons,
// send text, get files back, send a photo, page through tabs/settings, follow a PC turn.
'use strict';
const { spawn, execFileSync } = require('child_process');
const fs = require('fs'), path = require('path');
const WORK = path.resolve(process.argv[2]), MODEL = process.argv[3] || 'haiku', LANG = process.argv[4] || 'ko', API = 'http://127.0.0.1:18081';
// UI words the checks look for, per language
const L = LANG === 'ko' ? { pick: /세션 선택/, folders: /폴더/, search: /검색/, working: /작업 중/, files: '📂 산출물', filesRe: /산출물/, settings: '⚙ 설정', settingsRe: /설정/, stopped: /멈췄습니다/, answerLang: 'Korean' }
  : { pick: /Choose a session/, folders: /Folders/, search: /Search/, working: /Working/, files: '📂 Files', filesRe: /Output files/, settings: '⚙ Settings', settingsRe: /Settings/, stopped: /Stopped/, answerLang: 'English' };
const REL = path.join(__dirname, '..', 'relay.js'), CHAT = 42;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = async (p, body, raw) => (await (await fetch(API + p, { method: body ? 'POST' : 'GET', body: raw ? body : body && JSON.stringify(body) })).json()).result;
const push = (u) => call('/_push', u);
let msgId = 1;
const msg = (extra) => push({ message: { message_id: msgId++, date: Math.floor(Date.now() / 1000), chat: { id: CHAT, type: 'private' }, from: { id: CHAT, first_name: 'T', language_code: LANG }, ...extra } });
const tap = (data, message_id = 1) => push({ callback_query: { id: String(Math.random()), from: { id: CHAT }, data, message: { message_id, chat: { id: CHAT } } } });
const results = [];
const check = (name, ok, info = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
async function waitFor(pred, ms = 240000) {
  const t0 = Date.now();
  for (;;) { const log = await call('/_log'); const hit = log.filter(pred); if (hit.length) return hit; if (Date.now() - t0 > ms) return []; await sleep(1000); }
}
const since = (t0) => (c) => c.at >= t0;
const buttons = (c) => (c.body.reply_markup?.inline_keyboard || []).flat();

(async () => {
  fs.mkdirSync(WORK, { recursive: true });
  // a conversation to pick
  const first = JSON.parse(execFileSync('claude', ['-p', '--output-format', 'json', '--model', MODEL], { cwd: WORK, input: 'Remember the word "kiwi". Reply with OK only.', encoding: 'utf8' }));
  const SID = first.session_id;
  console.log('session', SID);
  const data = path.join(WORK, '_relay'); fs.mkdirSync(data, { recursive: true });
  // sessions started by `claude -p` are not in ~/.claude/history.jsonl; mark this one as the relay's own
  fs.writeFileSync(path.join(data, 'state.json'), JSON.stringify({ offset: 0, chats: {}, mine: [SID] }));
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ token: 'TEST', allowed: ['42'], apiBase: API, lang: LANG, model: MODEL, permissionMode: 'bypassPermissions' }));
  const mock = spawn(process.execPath, [path.join(__dirname, 'mock-telegram.js')], { stdio: 'inherit' });
  await sleep(800);
  const relay = spawn(process.execPath, [REL], { env: { ...process.env, RELAY_CONFIG: path.join(data, 'config.json') }, stdio: ['ignore', 'pipe', 'pipe'] });
  relay.stdout.on('data', (d) => process.stdout.write('[relay] ' + d)); relay.stderr.on('data', (d) => process.stdout.write('[relay!] ' + d));
  try {
    let t0 = Date.now();
    await msg({ text: '/start' });
    const menu = (await waitFor((c) => c.at >= t0 && c.method === 'sendMessage' && L.pick.test(c.body.text), 20000))[0];
    check('start → help + session picker', !!menu);
    check('picker lists the new session', !!menu && buttons(menu).some((b) => b.callback_data === `sel:${SID}`));
    check('picker has tabs', !!menu && ['tab:o:0', 'tab:f:0', 'srch:'].every((d) => buttons(menu).some((b) => b.callback_data === d)));

    t0 = Date.now(); await tap('tab:o:0');
    check('tab Open edits in place', (await waitFor((c) => c.at >= t0 && c.method === 'editMessageText', 15000)).length > 0);
    t0 = Date.now(); await tap('tab:f:0');
    const fold = (await waitFor((c) => c.at >= t0 && c.method === 'editMessageText' && L.folders.test(c.body.text), 15000))[0];
    check('tab Folders', !!fold);
    t0 = Date.now(); await tap('srch:'); await sleep(500); await msg({ text: path.basename(WORK) });
    const found = (await waitFor((c) => c.at >= t0 && c.method === 'sendMessage' && L.search.test(c.body.text), 15000))[0];
    check('search by folder name finds the session', !!found && buttons(found).some((b) => b.callback_data === `sel:${SID}`),
      (await call('/_log')).filter((c) => c.at >= t0).map((c) => `${c.method}:${String(c.body.text || '').slice(0, 60)}[${buttons(c).length}]`).join(' / '));

    t0 = Date.now(); await tap(`sel:${SID}`);
    const pin = await waitFor((c) => c.at >= t0 && c.method === 'pinChatMessage', 20000);
    check('select → pinned session card', pin.length > 0);

    t0 = Date.now();
    await msg({ text: `What word did I ask you to remember? Then, with Python and Pillow, write two files in the current folder: red.png (a 200x120 red rectangle) and blue.png (blue), and also report.pdf (one page with the text "relay test", made with Pillow). Answer in ${L.answerLang} with a short list and give the full paths.` });
    const prog = await waitFor((c) => c.at >= t0 && c.method === 'sendMessage' && L.working.test(c.body.text), 30000);
    check('progress card with ⏹ button', prog.length > 0 && buttons(prog[0]).some((b) => b.callback_data === 'stop:'));
    const ans = (await waitFor((c) => c.at >= t0 && c.method === 'sendMessage' && /^💬/.test(c.body.text), 300000))[0];
    check('answer arrives (HTML accepted)', !!ans, ans && ans.body.text.slice(0, 200).replace(/\n/g, ' '));
    check('answer remembers the session (kiwi)', !!ans && /kiwi|키위/i.test(ans.body.text));
    check('answer has quick replies', !!ans && buttons(ans).some((b) => b.callback_data === 'qr:0'));
    check('steps folded in expandable quote', !!ans && /<blockquote expandable>/.test(ans.body.text));
    const media = await waitFor((c) => c.at >= t0 && /^send(Photo|Document|MediaGroup)$/.test(c.method), 30000);
    await sleep(3000);
    const all = (await call('/_log')).filter((c) => c.at >= t0 && /^send(Photo|Document|MediaGroup)$/.test(c.method));
    check('two pictures as one album', all.some((c) => c.method === 'sendMediaGroup' && Object.keys(c.files || {}).length === 2), all.map((c) => c.method).join(','));
    check('PDF sent as document', all.some((c) => c.method === 'sendDocument' && /report\.pdf/.test(c.files?.document?.filename || '')));
    check('progress card removed', (await call('/_log')).some((c) => c.at >= t0 && c.method === 'deleteMessage'));
    void media;

    // a photo from the phone → saved, path given to the session
    t0 = Date.now();
    await call('/_file?id=ph1', fs.readFileSync(path.join(WORK, 'red.png')), true);
    await msg({ photo: [{ file_id: 'ph1', file_size: 1000 }], caption: 'What colour is this picture? one word' });
    const ans2 = (await waitFor((c) => c.at >= t0 && c.method === 'sendMessage' && /^💬/.test(c.body.text), 240000))[0];
    const inbox = fs.readdirSync(path.join(data, 'inbox')).flatMap((d) => fs.readdirSync(path.join(data, 'inbox', d)));
    check('photo saved in inbox', inbox.some((f) => /telegram_.*\.jpg$/.test(f)), inbox.join(','));
    check('session saw the photo (red)', !!ans2 && /red|빨|적색|레드/i.test(ans2.body.text), ans2 && ans2.body.text.slice(0, 160).replace(/\n/g, ' '));

    // files menu + receive
    t0 = Date.now(); await msg({ text: L.files });
    const fm = (await waitFor((c) => c.at >= t0 && c.method === 'sendMessage' && L.filesRe.test(c.body.text) && buttons(c).length, 15000))[0];
    check('files menu lists outputs', !!fm && buttons(fm).length >= 3, fm && buttons(fm).map((b) => b.text).join(' | '));
    t0 = Date.now(); await tap('art:0');
    check('tap a file → sent', (await waitFor((c) => c.at >= t0 && /^send(Photo|Document)$/.test(c.method), 20000)).length > 0);

    // settings
    t0 = Date.now(); await msg({ text: L.settings });
    const sm = (await waitFor((c) => c.at >= t0 && c.method === 'sendMessage' && L.settingsRe.test(c.body.text), 15000))[0];
    check('settings card', !!sm && buttons(sm).some((b) => b.callback_data === 'set:pm:plan'));
    t0 = Date.now(); await tap('set:sy:raw');
    await waitFor((c) => c.at >= t0 && c.method === 'editMessageText', 10000);
    const cfg = JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8'));
    check('setting saved', cfg.style === 'raw');
    await tap('set:sy:phone');

    // long answer pages in place
    t0 = Date.now();
    await msg({ text: `Write a numbered list of 120 facts about the sea, each a full sentence of about 15 words, in ${L.answerLang}, no headings (this is a paging test, ignore the short-answer note).` });
    const longAns = (await waitFor((c) => c.at >= t0 && c.method === 'sendMessage' && /^💬/.test(c.body.text), 300000))[0];
    const pager = longAns && buttons(longAns).find((b) => /^doc:/.test(b.callback_data));
    check('long answer is paged (◀ n/N ▶)', !!pager, longAns && buttons(longAns).map((b) => b.text).join(' '));
    if (pager) { t0 = Date.now(); await tap(pager.callback_data); check('▶ edits the same message', (await waitFor((c) => c.at >= t0 && c.method === 'editMessageText', 10000)).length > 0); }

    // a turn run on the PC in the same conversation → 🔔
    const cur = JSON.parse(fs.readFileSync(path.join(data, 'state.json'), 'utf8')).chats[CHAT].sid;
    t0 = Date.now();
    execFileSync('claude', ['-p', '--resume', cur, '--model', MODEL], { cwd: WORK, input: 'Say "PC turn done" and nothing else.', encoding: 'utf8' });
    const bell = (await waitFor((c) => c.at >= t0 && c.method === 'sendMessage' && /^🔔/.test(c.body.text), 30000))[0];
    check('PC turn forwarded (🔔)', !!bell, bell && bell.body.text.slice(0, 120).replace(/\n/g, ' '));

    // stop
    t0 = Date.now();
    await msg({ text: 'Count slowly from 1 to 200 using a Bash command with sleep 1 between numbers, then report.' });
    await waitFor((c) => c.at >= t0 && c.method === 'sendMessage' && L.working.test(c.body.text), 30000);
    await sleep(8000); await tap('stop:');
    check('⏹ stops the turn', (await waitFor((c) => c.at >= t0 && c.method === 'sendMessage' && L.stopped.test(c.body.text), 60000)).length > 0);

    const logTxt = fs.existsSync(path.join(data, 'relay.log')) ? fs.readFileSync(path.join(data, 'relay.log'), 'utf8') : '';
    check('no HTML fallbacks / errors in log', !/html fallback|uncaught|unhandled|msg Error|cb Error/.test(logTxt), (logTxt.match(/.*(fallback|uncaught|unhandled|msg |cb ).*/g) || []).slice(0, 3).join(' / '));
  } finally {
    fs.writeFileSync(path.join(data, 'calls.json'), JSON.stringify(await call('/_log'), null, 1)); // for the README pictures
    relay.kill(); mock.kill();
    const bad = results.filter((r) => !r.ok);
    console.log(`\n${results.length - bad.length}/${results.length} passed`);
    process.exit(bad.length ? 1 : 0);
  }
})();
