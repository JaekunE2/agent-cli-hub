// Calendar: one view over
//   - todo.md (default data/todo.md, a plain Markdown checklist your agent sessions can edit too):
//     every task with @due(YYYY-MM-DD) and every project's "**일정** key=date · …" milestone line,
//   - the hub's own events (default data/calendar.json: meetings … anything with a time),
//   - Google Calendar when connected (your own OAuth "Desktop app" client in data/secrets/google-oauth-client.json):
//     hub items are pushed one way into a dedicated Google calendar "Agent CLI Hub", and the account's primary
//     calendar is read back so its events show here too (read-only),
//   - Dooray (optional, read-only, only when config "dooray": {"base": "https://<tenant>.dooray.com"} is set): the
//     calendars of a Dooray tenant, through a logged-in Chrome on CDP (config dooray.cdp, default 9222).
//     Entries tagged with someone else's name ("[이름] …") are left out; dooray.me is your own tag.
// todo.md stays the source of truth for tasks: the hub only flips a checkbox or appends a task line.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// readOnly: a side hub instance (instance.js calendarWrite off) shows the calendar but never writes todo.md /
// calendar.json or pushes to Google.
module.exports = function calendar({ config = {}, port = 7777, readOnly = false } = {}) {
  const C = config.calendar || {};
  const DATA = path.join(__dirname, 'data');
  const TODO = C.todo || path.join(DATA, 'todo.md');
  const EVENTS = C.events || path.join(DATA, 'calendar.json');
  const SECRETS = C.secretsDir || config.secretsDir || path.join(DATA, 'secrets');
  // first start: a todo.md that shows the format
  if (!fs.existsSync(TODO)) {
    try {
      fs.mkdirSync(path.dirname(TODO), { recursive: true });
      fs.writeFileSync(TODO, '# 할 일\n\n## 📋 대기 중\n- [ ] 예시: 보고서 초안 @due(2099-12-31) #work\n\n## ✅ 완료\n');
    } catch {}
  }
  const CLIENT = path.join(SECRETS, 'google-oauth-client.json');
  const TOKEN = path.join(SECRETS, 'gcal-token.json');
  const MS_FILE = path.join(SECRETS, 'ms-calendar.json');
  const ACCOUNT = C.googleAccount || '';
  const TZ = C.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const REDIRECT = `http://127.0.0.1:${port}/api/calendar/google/callback`;
  const sha = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
  const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
  const writeJson = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); const t = `${f}.${process.pid}.tmp`; fs.writeFileSync(t, JSON.stringify(o, null, 2)); fs.renameSync(t, f); };

  // ---------- todo.md ----------
  const plain = (s) => s.replace(/\*\*/g, '').replace(/`/g, '').trim();
  const short = (p) => { const x = p.split(/[(→—]/)[0].replace(':', '').trim(); return x.length > 24 ? x.slice(0, 23) + '…' : x; };
  function parseTodo() {
    let text; try { text = fs.readFileSync(TODO, 'utf8'); } catch { return { items: [], error: `todo.md를 읽을 수 없습니다 (${TODO})` }; }
    const items = [];
    let section = '', paper = '';
    text.split(/\r?\n/).forEach((line, n) => {
      let m;
      if ((m = /^## (.*)/.exec(line))) { section = plain(m[1]); paper = ''; return; }
      if ((m = /^### (?:\d+\.\s*)?(.*)/.exec(line))) { paper = plain(m[1].split(' — ')[0]); return; }
      // short paper name for labels: "AAMAS 2027 (EVAT)" → AAMAS 2027, "PhysWorldAI: State Freshness (1저자)" → PhysWorldAI State Freshness
      if ((m = /^\*\*일정\*\*\s+(.*)/.exec(line))) {
        for (const part of m[1].split('·')) {
          const kv = /([^=\s][^=]*?)\s*=\s*(\d{4}-\d{2}-\d{2})/.exec(part.trim());
          if (kv) items.push({ kind: 'milestone', id: 'ms:' + sha(paper + '|' + kv[1]), title: `${short(paper)} · ${kv[1].trim()}`, date: kv[2], section, paper });
        }
        return;
      }
      if ((m = /^\s*- \[( |x|X)\] (.*)$/.exec(line))) {
        const due = /@due\((\d{4}-\d{2}-\d{2})\)/.exec(m[2]);
        if (!due) return;
        const bold = /\*\*(.+?)\*\*/.exec(m[2]);
        const title = plain(bold ? bold[1] : m[2].split(' — ')[0].replace(/[#@]\S+/g, ''));
        const rest = m[2].includes(' — ') ? plain(m[2].slice(m[2].indexOf(' — ') + 3)) : '';
        items.push({ kind: 'task', id: 'todo:' + sha(m[2]), title: paper ? `${short(paper)} · ${title}` : title, date: due[1], done: m[1] !== ' ', tags: [...m[2].matchAll(/#([^\s#@]+)/g)].map((x) => x[1]),
          who: (/@who\(([^)]*)\)/.exec(m[2]) || [])[1] || null, note: rest.replace(/@\w+\([^)]*\)/g, '').trim(), section, paper, line: n + 1 });
      }
    });
    // a milestone with a task of the same paper on the same day shows once, as the (checkable) task
    const taskDays = new Set(items.filter((x) => x.kind === 'task').map((x) => x.paper + '|' + x.date));
    return { items: items.filter((x) => x.kind !== 'milestone' || !taskDays.has(x.paper + '|' + x.date)) };
  }
  // flip a task's checkbox (found by the id of its text, so line moves don't matter)
  function setTaskDone(id, done) {
    const text = fs.readFileSync(TODO, 'utf8');
    const lines = text.split('\n');
    const i = lines.findIndex((l) => { const m = /^\s*- \[( |x|X)\] (.*?)\r?$/.exec(l); return m && 'todo:' + sha(m[2]) === id; });
    if (i < 0) throw new Error('todo.md에서 그 항목을 찾지 못했습니다 (다른 곳에서 바뀌었을 수 있음)');
    lines[i] = lines[i].replace(/- \[( |x|X)\]/, done ? '- [x]' : '- [ ]');
    fs.writeFileSync(TODO, lines.join('\n'));
  }
  // new task → end of the "📋 대기 중" section (the todo.md rule: new items go to the waiting list)
  function addTask({ title, date, tags = [] }) {
    if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error('제목과 날짜(YYYY-MM-DD)가 필요합니다');
    const lines = fs.readFileSync(TODO, 'utf8').split('\n');
    let s = lines.findIndex((l) => /^## 📋/.test(l));
    if (s < 0) s = lines.length - 1;
    let e = s + 1;
    while (e < lines.length && !/^## /.test(lines[e])) e++;
    while (e > s + 1 && !lines[e - 1].trim()) e--;
    lines.splice(e, 0, `- [ ] **${String(title).replace(/\*\*/g, '')}**${tags.map((t) => ' #' + t).join('')} @due(${date})`);
    fs.writeFileSync(TODO, lines.join('\n'));
  }

  // ---------- hub events ----------
  const loadEvents = () => readJson(EVENTS, { events: [] }).events || [];
  const saveEvents = (events) => writeJson(EVENTS, { _comment: '대시보드 캘린더의 일정 (할 일·마감은 todo.md). 대시보드에서 편집하세요.', events });
  function upsertEvent(ev) {
    if (!ev.title || !/^\d{4}-\d{2}-\d{2}$/.test(ev.date || '')) throw new Error('제목과 날짜(YYYY-MM-DD)가 필요합니다');
    if (ev.time && !/^\d{1,2}:\d{2}$/.test(ev.time)) throw new Error('시간은 HH:MM');
    if (ev.end && !/^\d{1,2}:\d{2}$/.test(ev.end)) throw new Error('시간은 HH:MM');
    if (ev.time && ev.end && toMinutes(ev.end) <= toMinutes(ev.time)) {
      throw new Error('끝 시간은 시작 시간보다 늦어야 합니다');
    }
    const events = loadEvents();
    const i = ev.id ? events.findIndex((x) => x.id === ev.id) : -1;
    const clean = { id: ev.id || 'ev-' + crypto.randomBytes(5).toString('hex'), title: String(ev.title), date: ev.date, time: ev.time || null, end: ev.end || null, note: ev.note || '', updated: new Date().toISOString() };
    if (i >= 0) events[i] = { ...events[i], ...clean }; else events.push(clean);
    saveEvents(events);
    return clean;
  }

  // ---------- Google ----------
  let gState = readJson(TOKEN, null);
  let gCache = { events: [], at: 0, error: null };
  let oauthNonce = null;
  const client = () => { const j = readJson(CLIENT, null); const c = j && (j.installed || j.web); return c && c.client_id ? c : null; };
  async function accessToken() {
    if (!gState?.refresh_token) throw new Error('구글 계정이 연결되지 않았습니다');
    if (gState.access_token && gState.expires_at > Date.now() + 60e3) return gState.access_token;
    const c = client(); if (!c) throw new Error('google-oauth-client.json이 없습니다');
    const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: c.client_id, client_secret: c.client_secret || '', refresh_token: gState.refresh_token, grant_type: 'refresh_token' }) });
    const j = await r.json();
    if (!r.ok) throw new Error(`토큰 갱신 실패: ${j.error_description || j.error || r.status}`);
    gState = { ...gState, access_token: j.access_token, expires_at: Date.now() + j.expires_in * 1000 };
    writeJson(TOKEN, gState);
    return gState.access_token;
  }
  async function gapi(method, p, body) {
    const r = await fetch('https://www.googleapis.com/calendar/v3' + p, { method, headers: { authorization: `Bearer ${await accessToken()}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 204) return {};
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Google ${method} ${p.split('?')[0]}: ${j.error?.message || r.status}`);
    return j;
  }
  const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const toMinutes = (t) => {
    const [h, m] = String(t || '').split(':').map(Number);
    return (Number.isFinite(h) && Number.isFinite(m)) ? (h * 60 + m) : -1;
  };
  const fmtHm = (t) => {
    const [h, m] = String(t || '').split(':').map((x) => x.padStart(2, '0'));
    return `${h}:${m}`;
  };
  const plusMinutes = (date, time, deltaMin) => {
    const total = toMinutes(time) + deltaMin;
    const endDate = total >= 1440 ? addDays(date, 1) : date;
    const rem = ((total % 1440) + 1440) % 1440;
    return { date: endDate, hm: `${String(Math.floor(rem / 60)).padStart(2, '0')}:${String(rem % 60).padStart(2, '0')}` };
  };
  function toGoogle(it) {
    const timed = it.kind === 'event' && it.time;
    const summary = it.kind === 'task' ? `☐ ${it.title}` : it.kind === 'milestone' ? `📌 ${it.title}` : it.title;
    const description = [it.note, it.kind === 'task' ? `todo.md 할 일${it.paper ? ` · ${it.paper}` : ''}${it.tags?.length ? ' · #' + it.tags.join(' #') : ''}` : '', it.kind === 'milestone' ? 'todo.md 마일스톤' : '', 'Agent CLI Hub 캘린더에서 동기화 — 수정은 허브에서 하세요'].filter(Boolean).join('\n');
    let start, end;
    if (timed) {
      const sHm = fmtHm(it.time);
      const validEnd = it.end && toMinutes(it.end) > toMinutes(it.time);
      const eSpec = validEnd ? { date: it.date, hm: fmtHm(it.end) } : plusMinutes(it.date, it.time, 60);
      start = { dateTime: `${it.date}T${sHm}:00`, timeZone: TZ };
      end = { dateTime: `${eSpec.date}T${eSpec.hm}:00`, timeZone: TZ };
    } else {
      start = { date: it.date };
      end = { date: addDays(it.date, 1) };
    }
    const body = { summary, description, extendedProperties: { private: { hubId: it.id } }, start, end };
    body.extendedProperties.private.hubHash = sha(JSON.stringify([body.summary, body.description, body.start, body.end]));
    return body;
  }
  let syncing = null;
  async function sync() {
    if (syncing) return syncing;
    syncing = (async () => {
      if (!gState?.refresh_token) return { ok: false, error: '연결 안 됨' };
      // our own calendar inside the account, so pushed items never mix with the user's events
      if (!gState.calendarId) {
        const cal = await gapi('POST', '/calendars', { summary: 'Agent CLI Hub', description: 'Agent CLI Hub의 할 일 마감·마일스톤·일정 (자동 동기화)', timeZone: TZ });
        gState = { ...gState, calendarId: cal.id }; writeJson(TOKEN, gState);
      }
      const cid = encodeURIComponent(gState.calendarId);
      const today = new Date().toISOString().slice(0, 10);
      const want = allItems().filter((x) => x.kind !== 'gcal' && !(x.kind === 'task' && x.done) && x.date >= addDays(today, -30));
      const have = new Map();
      let pageToken = '';
      do {
        const j = await gapi('GET', `/calendars/${cid}/events?maxResults=2500&showDeleted=false${pageToken ? '&pageToken=' + pageToken : ''}`);
        for (const e of j.items || []) { const id = e.extendedProperties?.private?.hubId; if (id) have.set(id, e); }
        pageToken = j.nextPageToken || '';
      } while (pageToken);
      let added = 0, changed = 0, removed = 0;
      for (const it of want) {
        const body = toGoogle(it), cur = have.get(it.id);
        if (!cur) { await gapi('POST', `/calendars/${cid}/events`, body); added++; }
        else if (cur.extendedProperties?.private?.hubHash !== body.extendedProperties.private.hubHash) { await gapi('PUT', `/calendars/${cid}/events/${cur.id}`, body); changed++; }
        have.delete(it.id);
      }
      for (const e of have.values()) { await gapi('DELETE', `/calendars/${cid}/events/${e.id}`); removed++; }
      // read the account's primary calendar for display
      const tMin = new Date(Date.now() - 45 * 864e5).toISOString(), tMax = new Date(Date.now() + 200 * 864e5).toISOString();
      const pj = await gapi('GET', `/calendars/primary/events?singleEvents=true&orderBy=startTime&maxResults=500&timeMin=${encodeURIComponent(tMin)}&timeMax=${encodeURIComponent(tMax)}`);
      gCache = { at: Date.now(), error: null, events: (pj.items || []).filter((e) => e.status !== 'cancelled').map((e) => {
        const s = e.start?.dateTime || e.start?.date || '';
        return { kind: 'gcal', id: 'g:' + e.id, title: e.summary || '(제목 없음)', date: s.slice(0, 10), time: e.start?.dateTime ? new Date(e.start.dateTime).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: TZ }) : null, note: e.location || '', link: e.htmlLink };
      }) };
      gState = { ...gState, lastSync: new Date().toISOString(), lastResult: { added, changed, removed } }; writeJson(TOKEN, gState);
      return { ok: true, added, changed, removed, primary: gCache.events.length };
    })().catch((e) => { gCache.error = e.message; return { ok: false, error: e.message }; }).finally(() => { syncing = null; });
    return syncing;
  }
  let syncTimer = null, interval = null;
  const syncSoon = () => { if (!gState?.refresh_token) return; clearTimeout(syncTimer); syncTimer = setTimeout(() => sync(), 4000); };

  // ---------- Dooray ----------
  const DR = { base: '', cdp: 9222, me: '', calendars: {}, ...(config.dooray || {}) };
  DR.base = String(DR.base || '').replace(/\/+$/, '');
  let dCache = { events: [], at: 0, error: null, calendars: [] };
  let dBusy = null;
  async function doorayCookie() {
    const WebSocket = require('ws');
    let ver;
    try { ver = await (await fetch(`http://127.0.0.1:${DR.cdp}/json/version`, { signal: AbortSignal.timeout(3000) })).json(); }
    catch { throw new Error(`두레이에 로그인된 Chrome(CDP ${DR.cdp})이 꺼져 있습니다`); }
    const ws = new WebSocket(ver.webSocketDebuggerUrl);
    try {
      await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); setTimeout(() => j(new Error('CDP timeout')), 5000); });
      const res = await new Promise((r, j) => { ws.on('message', (m) => { const x = JSON.parse(m); if (x.id === 1) r(x.result); }); ws.send(JSON.stringify({ id: 1, method: 'Storage.getCookies', params: {} })); setTimeout(() => j(new Error('CDP timeout')), 5000); });
      const host = new URL(DR.base).hostname;
      return (res.cookies || []).filter((c) => host.endsWith(c.domain.replace(/^\./, ''))).map((c) => `${c.name}=${c.value}`).join('; ');
    } finally { ws.close(); }
  }
  async function dget(cookie, p) {
    const r = await fetch(DR.base + p, { headers: { cookie, accept: 'application/json, text/plain, */*', 'dooray-api-version': '1.2', 'dooray-caller': 'WEB', referer: DR.base + '/calendar' }, redirect: 'manual', signal: AbortSignal.timeout(15000) });
    if (r.status >= 300 && r.status < 400) throw new Error('두레이 로그인이 만료됐습니다 — Chrome(9222)에서 두레이에 다시 로그인하세요');
    const j = await r.json().catch(() => null);
    if (!j?.header?.isSuccessful) throw new Error(`두레이 응답 오류 (${r.status} ${j?.header?.resultCode ?? ''})`);
    return j.result;
  }
  function doorayRefresh() {
    if (!DR.base) return Promise.resolve(); // not configured
    if (dBusy) return dBusy;
    dBusy = (async () => {
      const cookie = await doorayCookie();
      const cals = (await dget(cookie, '/v2/wapi/calendars?listed=true&size=10000')).contents || [];
      // which calendars, and how: "all" = every entry except other people's personal ones, "mine" = only mine
      const pick = cals.map((c) => ({ c, mode: DR.calendars[c.name] || (c.type === 'private' && c.default ? 'all' : null) })).filter((x) => x.mode);
      if (!pick.length) { dCache = { events: [], at: Date.now(), error: null, calendars: [] }; return; }
      const fmt = (d) => d.toISOString().slice(0, 10) + 'T00:00:00+09:00';
      // Dooray allows ~6 weeks per request (USER_INVALID_EXCEED_MAXIMUM_PERIOD): ask in 35-day windows
      const list = [];
      for (let from = -35; from < 140; from += 35) {
        const q = new URLSearchParams({ calendars: pick.map((x) => x.c.id).join(','), timeMin: fmt(new Date(Date.now() + from * 864e5)), timeMax: fmt(new Date(Date.now() + (from + 35) * 864e5)), postType: 'toMe', privateTaskShown: 'false' });
        list.push(...((await dget(cookie, `/v2/wapi/calendars/*/schedules?${q}`)).contents || []));
      }
      const modeOf = new Map(pick.map((x) => [x.c.id, x.mode])), nameOf = new Map(pick.map((x) => [x.c.id, x.c.name]));
      const seen = new Set(), out = [];
      for (const e of list) {
        const subj = String(e.subject || '');
        const tag = /^\s*\[([가-힣]{2,4})\]/.exec(subj);
        const mine = (DR.me && subj.includes(`[${DR.me}]`)) || e.users?.me?.postUserType === 'to' || e.users?.me?.postUserType === 'from';
        const othersPersonal = tag && tag[1] !== DR.me && tag[1] !== '\uD68C\uC758\uC2E4'; // 회의실 (a data tag, never translated)
        if (modeOf.get(e.calendarId) === 'mine' ? !mine : othersPersonal) continue;
        const date = String(e.startedAt || '').slice(0, 10);
        const key = date + '|' + subj.replace(/\(.*?\)/g, '').replace(/\s+/g, '');
        if (!date || seen.has(key)) continue;
        seen.add(key);
        const t = (s) => (e.wholeDayFlag || !s || s.length < 16 ? null : s.slice(11, 16));
        out.push({ kind: 'dooray', id: 'd:' + e.id, title: subj, date, time: t(e.startedAt), end: t(e.endedAt), note: [nameOf.get(e.calendarId), e.location].filter(Boolean).join(' · '), link: DR.base + '/calendar' });
      }
      dCache = { events: out, at: Date.now(), error: null, calendars: pick.map((x) => `${x.c.name}${x.mode === 'mine' ? '(내 것만)' : ''}`) };
    })().catch((e) => { dCache = { ...dCache, error: e.message, at: Date.now() }; }).finally(() => { dBusy = null; });
    return dBusy;
  }

  // ---------- Microsoft Teams / Outlook (published ICS link, read-only) ----------
  // Not part of allItems(): these are shown in the hub only, never pushed to the Google calendar.
  let msState = readJson(MS_FILE, C.msIcsUrl ? { url: C.msIcsUrl, label: C.msAccount || 'Teams' } : null);
  let msCache = { events: [], at: 0, error: null };
  let msSyncing = null;
  const unescapeIcs = (s) => String(s || '').replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1').trim();
  function parseIcsDate(val, isUtc) {
    const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(String(val || '').trim());
    if (!m) return null;
    if (!m[4]) return { date: `${m[1]}-${m[2]}-${m[3]}`, time: null };
    if (m[7] === 'Z' || isUtc) {
      const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
      const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
      const get = (t) => parts.find((x) => x.type === t)?.value || '00';
      return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` };
    }
    return { date: `${m[1]}-${m[2]}-${m[3]}`, time: `${m[4]}:${m[5]}` };
  }
  function parseIcs(text) {
    const unfolded = String(text || '').replace(/\r?\n[ \t]/g, '');
    const blocks = unfolded.split(/BEGIN:VEVENT\r?\n/i).slice(1);
    const out = [];
    for (const blk of blocks) {
      const body = blk.split(/END:VEVENT/i)[0] || '';
      const props = {};
      for (const line of body.split(/\r?\n/)) {
        const idx = line.indexOf(':');
        if (idx < 0) continue;
        const keyPart = line.slice(0, idx), val = line.slice(idx + 1);
        const [name, ...params] = keyPart.split(';');
        props[name.toUpperCase()] = { val, params };
      }
      if ((props.STATUS?.val || '').toUpperCase() === 'CANCELLED') continue;
      const st = parseIcsDate(props.DTSTART?.val);
      if (!st) continue;
      const en = parseIcsDate(props.DTEND?.val);
      const uid = unescapeIcs(props.UID?.val || sha(st.date + (props.SUMMARY?.val || '')));
      out.push({
        kind: 'mscal',
        id: 'ms:' + sha(uid + '|' + st.date + '|' + (st.time || '')),
        title: unescapeIcs(props.SUMMARY?.val) || '(제목 없음)',
        date: st.date,
        time: st.time,
        end: en && en.date === st.date ? en.time : null,
        note: unescapeIcs(props.LOCATION?.val || ''),
      });
    }
    return out;
  }
  async function syncMs() {
    if (!msState?.url) return { ok: false, error: 'Teams(ICS) 캘린더가 연결되지 않았습니다' };
    if (msSyncing) return msSyncing;
    msSyncing = (async () => {
      const r = await fetch(msState.url, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error(`ICS 조회 실패 (HTTP ${r.status})`);
      const text = await r.text();
      if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error('올바른 ICS 캘린더 응답이 아닙니다');
      const events = parseIcs(text);
      msCache = { events, at: Date.now(), error: null };
      msState = { ...msState, lastSync: new Date().toISOString() };
      writeJson(MS_FILE, msState);
      return { ok: true, count: events.length };
    })().catch((e) => { msCache.error = e.message; return { ok: false, error: e.message }; }).finally(() => { msSyncing = null; });
    return msSyncing;
  }

  function allItems() {
    const t = parseTodo();
    const ev = loadEvents().map((e) => ({ kind: 'event', ...e }));
    return [...t.items, ...ev, ...gCache.events, ...dCache.events, ...msCache.events];
  }

  async function oauthCallback(url, res) {
    const html = (code, msg) => { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' }); res.end(`<!doctype html><meta charset="utf-8"><body style="font:16px system-ui;padding:40px;background:#17171a;color:#ecebe6">${msg}<p><a style="color:#e0825f" href="/">대시보드로 돌아가기</a></p></body>`); };
    if (!oauthNonce || url.searchParams.get('state') !== oauthNonce) return html(400, '잘못된 요청입니다 (연결을 대시보드에서 다시 시작하세요).');
    oauthNonce = null;
    if (url.searchParams.get('error')) return html(400, `구글 연결이 취소되었습니다: ${url.searchParams.get('error')}`);
    const c = client();
    const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: url.searchParams.get('code') || '', client_id: c.client_id, client_secret: c.client_secret || '', redirect_uri: REDIRECT, grant_type: 'authorization_code' }) });
    const j = await r.json();
    if (!r.ok || !j.refresh_token) return html(400, `토큰을 받지 못했습니다: ${j.error_description || j.error || r.status}`);
    gState = { refresh_token: j.refresh_token, access_token: j.access_token, expires_at: Date.now() + j.expires_in * 1000, connectedAt: new Date().toISOString() };
    writeJson(TOKEN, gState);
    try { const p = await gapi('GET', '/calendars/primary'); gState.account = p.id; writeJson(TOKEN, gState); } catch {}
    const s = await sync();
    return html(200, `✔ 구글 캘린더 연결됨 (${gState.account || ''})<br>${s.ok ? `“Agent CLI Hub” 캘린더에 ${s.added}개 추가` : `동기화 오류: ${s.error}`}`);
  }

  async function handle(p, url, req, getBody, send) {
    if (readOnly && req.method === 'POST' && p.startsWith('/api/calendar')) return send(503, { error: '이 허브 인스턴스(테스트/보조)는 캘린더를 바꾸지 않습니다 — 7777 허브에서 하세요' });
    if (p === '/api/calendar') {
      const t = parseTodo();
      if (Date.now() - dCache.at > 10 * 60e3) doorayRefresh(); // background; this answer uses the cache
      if (url.searchParams.get('refresh') === 'dooray') await doorayRefresh();
      return send(200, { items: [...t.items, ...loadEvents().map((e) => ({ kind: 'event', ...e })), ...gCache.events, ...dCache.events, ...msCache.events], todoError: t.error || null,
        dooray: DR.base ? { at: dCache.at || null, error: dCache.error, calendars: dCache.calendars, count: dCache.events.length } : null,
        ms: { connected: !!msState?.url, label: msState?.label || 'Teams', lastSync: msState?.lastSync || null, count: msCache.events.length, error: msCache.error },
        google: { configured: !!client(), connected: !!gState?.refresh_token, account: gState?.account || null, calendarId: gState?.calendarId || null, lastSync: gState?.lastSync || null, lastResult: gState?.lastResult || null, error: gCache.error, hint: ACCOUNT } });
    }
    if (p === '/api/calendar/event' && req.method === 'POST') { const ev = upsertEvent((await getBody()).event || {}); syncSoon(); return send(200, { ok: true, event: ev }); }
    if (p === '/api/calendar/event/delete' && req.method === 'POST') { const { id } = await getBody(); saveEvents(loadEvents().filter((x) => x.id !== id)); syncSoon(); return send(200, { ok: true }); }
    if (p === '/api/calendar/task' && req.method === 'POST') { const b = await getBody(); setTaskDone(b.id, !!b.done); syncSoon(); return send(200, { ok: true }); }
    if (p === '/api/calendar/task/add' && req.method === 'POST') { addTask(await getBody()); syncSoon(); return send(200, { ok: true }); }
    if (p === '/api/calendar/google/auth') {
      const c = client();
      if (!c) return send(400, { error: `OAuth 클라이언트 파일이 없습니다: ${CLIENT}` });
      oauthNonce = crypto.randomBytes(16).toString('hex');
      const q = new URLSearchParams({ client_id: c.client_id, redirect_uri: REDIRECT, response_type: 'code', scope: 'https://www.googleapis.com/auth/calendar', access_type: 'offline', prompt: 'consent', state: oauthNonce, ...(ACCOUNT ? { login_hint: ACCOUNT } : {}) });
      return send(200, { url: 'https://accounts.google.com/o/oauth2/v2/auth?' + q });
    }
    if (p === '/api/calendar/google/sync' && req.method === 'POST') return send(200, await sync());
    if (p === '/api/calendar/google/disconnect' && req.method === 'POST') { gState = null; gCache = { events: [], at: 0, error: null }; try { fs.unlinkSync(TOKEN); } catch {} return send(200, { ok: true }); }
    if (p === '/api/calendar/ms/connect' && req.method === 'POST') {
      const b = await getBody();
      const u = String(b.url || '').trim();
      if (!/^https?:\/\/.+/i.test(u)) return send(400, { error: '올바른 ICS URL(https://...)을 입력하세요' });
      msState = { url: u, label: String(b.label || 'Teams').trim() || 'Teams' };
      writeJson(MS_FILE, msState);
      return send(200, await syncMs());
    }
    if (p === '/api/calendar/ms/sync' && req.method === 'POST') return send(200, await syncMs());
    if (p === '/api/calendar/ms/disconnect' && req.method === 'POST') { msState = null; msCache = { events: [], at: 0, error: null }; try { fs.unlinkSync(MS_FILE); } catch {} return send(200, { ok: true }); }
    return false;
  }

  // todo.md is edited by other sessions too: push its changes as they happen
  let lastTodo = 0;
  function start() {
    interval = setInterval(() => {
      let m = 0; try { m = fs.statSync(TODO).mtimeMs; } catch {}
      if (m !== lastTodo) { const first = !lastTodo; lastTodo = m; if (!first) syncSoon(); }
    }, 15000);
    setTimeout(() => sync(), 5000);
    doorayRefresh();
    interval.dooray = setInterval(() => doorayRefresh(), 15 * 60e3);
    interval.syncAll = setInterval(() => sync(), 10 * 60e3);
    setTimeout(() => syncMs(), 3000);
    interval.ms = setInterval(() => syncMs(), 10 * 60e3);
  }
  function stop() { clearInterval(interval); if (interval) { clearInterval(interval.syncAll); clearInterval(interval.dooray); clearInterval(interval.ms); } clearTimeout(syncTimer); }
  return { handle, oauthCallback, start, stop, sync, upsertEvent, parseTodo, toGoogle };
};
