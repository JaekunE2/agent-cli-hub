"""README picture: three phone screens drawn from the bot's real messages in a scripted run (test/shoot.js
writes <root>/_relay/calls.json + shoot.json). Only the demo sessions are shown in the picker. Telegram's look is imitated in HTML; the texts and buttons are the relay's.
    python test/render.py <work dir> <en|ko> <out.png>"""
import base64, html, json, os, re, sys
from playwright.sync_api import sync_playwright

work, lang, out = sys.argv[1], sys.argv[2], sys.argv[3]
calls = json.load(open(os.path.join(work, '_relay', 'calls.json'), encoding='utf-8'))
shoot = json.load(open(os.path.join(work, '_relay', 'shoot.json'), encoding='utf-8'))
MINE = set(shoot['mine'])
L = {'en': dict(pick='Choose a session', working='Working', prompt='What word did I ask', files='Output files', settings='Settings',
                kb=[['📋 Sessions', '📂 Files'], ['⏹ Stop', '⚙ Settings']], cap=['Pick a session', 'Answer + files', 'Files · settings'],
                me_files='📂 Files', me_set='⚙ Settings'),
     'ko': dict(pick='세션 선택', working='작업 중', prompt='What word did I ask', files='산출물 ·', settings='설정',
                kb=[['📋 세션', '📂 산출물'], ['⏹ 멈춤', '⚙ 설정']], cap=['세션 고르기', '답 + 파일', '산출물 · 설정'],
                me_files='📂 산출물', me_set='⚙ 설정')}[lang]

def tg_html(t):
    """Telegram HTML subset → page HTML (expandable quotes shown folded)."""
    t = re.sub(r'<blockquote expandable>(.*?)</blockquote>', lambda m: '<div class="quote fold">' + m.group(1).split('\n')[0] + ' <span class="more">▾</span></div>', t, flags=re.S)
    t = t.replace('<pre>', '<pre class="pre">')
    return t.replace('\n', '<br>')

def kb(markup):
    rows = (markup or {}).get('inline_keyboard') or []
    # sessions on the PC that ran the demo are not part of it
    rows = [r for r in rows if not any(b.get('callback_data', '').startswith('sel:') and b['callback_data'][4:] not in MINE for b in r)]
    rows = [[b for b in r if not (b.get('callback_data') == 'nop:' and '/' in b['text'])] for r in rows]
    return ''.join('<div class="row">' + ''.join(f'<span class="btn">{html.escape(b["text"])}</span>' for b in r if b['text'].strip()) + '</div>' for r in rows if r)

def bot(text, markup=None):
    return f'<div class="msg bot"><div class="bubble">{tg_html(text)}</div>{kb(markup)}</div>'

def me(text):
    return f'<div class="msg me"><div class="bubble">{html.escape(text)}</div></div>'

def img(p):
    return 'data:image/png;base64,' + base64.b64encode(open(p, 'rb').read()).decode()

sent = [c for c in calls if c['method'] == 'sendMessage']
first = lambda pred: next((c for c in calls if pred(c)), None)
picker = first(lambda c: c['method'] == 'sendMessage' and L['pick'] in c['body'].get('text', '') and 'inline_keyboard' in json.dumps(c['body'].get('reply_markup', {})))
card = first(lambda c: c['method'] == 'sendMessage' and c['body'].get('text', '').startswith('📌'))
answer = first(lambda c: c['method'] == 'sendMessage' and c['body'].get('text', '').startswith('💬'))
album = first(lambda c: c['method'] == 'sendMediaGroup')
pdf = first(lambda c: c['method'] == 'sendDocument')
prog_msgs = [c for c in calls if c['method'] in ('sendMessage', 'editMessageText') and L['working'] in c['body'].get('text', '') and c['body'].get('text', '').startswith('⏳')]
prog = max(prog_msgs, key=lambda c: c['body']['text'].count('\n')) if prog_msgs else None
filesm = first(lambda c: c['method'] == 'sendMessage' and c['body'].get('text', '').startswith('📂') and c['body'].get('reply_markup'))
settings = first(lambda c: c['method'] == 'sendMessage' and c['body'].get('text', '').startswith('⚙'))
prompt = shoot['prompt']

def find(name):
    for d, _, fs in os.walk(work):
        if name in fs and '_relay' not in d: return os.path.join(d, name)
pics = ''.join(f'<img src="{img(find(m["filename"]))}">' for m in (album or {}).get('files', {}).values() if find(m['filename'])) if album else ''
doc = f'<div class="msg bot"><div class="bubble doc"><span class="ficon">PDF</span><div><b>{html.escape(pdf["files"]["document"]["filename"])}</b><br><small>{pdf["files"]["document"]["size"] // 1024} KB</small></div></div></div>' if pdf else ''
screens = [
    me(L['kb'][0][0]) + bot(picker['body']['text'], picker['body'].get('reply_markup')),
    (bot(card['body']['text'], card['body'].get('reply_markup')) if card else '') + me(prompt) + bot(answer['body']['text'], answer['body'].get('reply_markup'))
    + (f'<div class="msg bot"><div class="album">{pics}</div></div>' if album else '') + doc,
    (bot(prog['body']['text'], prog['body'].get('reply_markup')) if prog else '') + me(L['me_files']) + bot(filesm['body']['text'], filesm['body'].get('reply_markup'))
    + me(L['me_set']) + bot(settings['body']['text'], settings['body'].get('reply_markup')),
]
keyboard = ''.join('<div class="krow">' + ''.join(f'<span class="key">{k}</span>' for k in r) + '</div>' for r in L['kb'])
phone = lambda body, cap: f'''<figure><div class="phone"><div class="top"><span class="av">🤖</span><div><b>Claude relay</b><br><small>bot</small></div></div>
<div class="chat"><div class="inner">{body}</div></div><div class="kb">{keyboard}</div></div><figcaption>{cap}</figcaption></figure>'''
page = f'''<!doctype html><html><head><meta charset="utf-8"><style>
body{{margin:0;padding:28px;background:#eef1f5;font-family:-apple-system,"Segoe UI","Malgun Gothic",Roboto,sans-serif;display:flex;gap:26px}}
figure{{margin:0;text-align:center}} figcaption{{margin-top:10px;font-size:15px;color:#4a5562;font-weight:600}}
.phone{{width:360px;height:740px;border-radius:34px;background:#000;padding:10px;box-sizing:border-box;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 10px 30px #0003}}
.top{{background:#517da2;color:#fff;border-radius:24px 24px 0 0;padding:12px 14px;display:flex;gap:10px;align-items:center;font-size:14px}} .top small{{opacity:.8}}
.av{{width:34px;height:34px;border-radius:50%;background:#fff;display:flex;align-items:center;justify-content:center;font-size:19px}}
.chat{{flex:1;background:#cfdcc4 linear-gradient(160deg,#d8e5c9,#b9cfa9);overflow:hidden;display:flex;flex-direction:column;justify-content:flex-end}}
.inner{{padding:8px 8px 4px}}
.msg{{text-align:left;margin:5px 0;max-width:88%;font-size:12.6px;line-height:1.38}} .msg.me{{margin-left:auto}}
.bubble{{background:#fff;border-radius:12px;padding:7px 9px;box-shadow:0 1px 1px #0002;word-break:break-word}} .me .bubble{{background:#e1fec6}}
.row{{display:flex;gap:3px;margin-top:3px}} .btn{{flex:1;background:#5b8a6ccc;color:#fff;border-radius:7px;padding:6px 4px;font-size:11.5px;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}}
code{{font-family:Consolas,monospace;font-size:11.5px;color:#a03050;word-break:break-all}} .pre{{background:#f3f3f3;padding:5px;border-radius:5px;font-size:11px;white-space:pre-wrap;margin:3px 0}}
.quote{{border-left:3px solid #4f8fd1;background:#eaf2fb;padding:3px 7px;border-radius:4px;margin-top:5px;color:#355}} .more{{float:right;color:#4f8fd1}}
.album{{display:grid;grid-template-columns:1fr 1fr;gap:2px;border-radius:12px;overflow:hidden;width:250px}} .album img{{width:100%;height:110px;object-fit:cover}}
.doc{{display:flex;gap:9px;align-items:center}} .ficon{{background:#e05a47;color:#fff;border-radius:50%;width:38px;height:38px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700}}
.kb{{background:#f0f0f0;padding:5px;border-radius:0 0 24px 24px}} .krow{{display:flex;gap:5px;margin:4px 0}} .key{{flex:1;background:#fff;border-radius:8px;padding:9px 0;text-align:center;font-size:13px;box-shadow:0 1px 1px #0002}}
</style></head><body>{''.join(phone(s, c) for s, c in zip(screens, L['cap']))}</body></html>'''
tmp = os.path.join(work, '_relay', f'tour-{lang}.html')
open(tmp, 'w', encoding='utf-8').write(page)
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(viewport={'width': 1220, 'height': 860}, device_scale_factor=2)
    pg.goto('file:///' + tmp.replace('\\', '/')); pg.wait_for_timeout(300)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    pg.locator('body').screenshot(path=out); b.close()
print('wrote', out)
