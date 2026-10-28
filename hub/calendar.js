// Calendar: one view over
//   - todo.md (default data/todo.md, a plain Markdown checklist your agent sessions can edit too):
//     every task with @due(YYYY-MM-DD) and every project's "**일정** key=date · …" milestone line,
//   - the hub's own events (default data/calendar.json: meetings … anything with a time),
//   - Google Calendar when connected (your own OAuth "Desktop app" client in data/secrets/google-oauth-client.json):
//     hub items are pushed one way into a dedicated Google calendar "Agent CLI Hub", and the account's primary
//     calendar is read back so its events show here too (read-only).
// todo.md stays the source of truth for tasks: the hub only flips a checkbox or appends a task line.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

module.exports = function calendar({ config = {}, port = 7777 } = {}) {
  const C = config.calendar || {};
  const DATA = path.join(__dirname, 'data');
  const TODO = C.todo || path.join(DATA, 'todo.md');
  const EVENTS = C.events || path.join(DATA, 'calendar.json');
  const SECRETS = C.secretsDir || path.join(DATA, 'secrets');
  // first start: a todo.md that shows the format
  if (!fs.existsSync(TODO)) {
    try {
      fs.mkdirSync(path.dirname(TODO), { recursive: true });
      fs.writeFileSync(TODO, '# 할 일\n\n## 📋 대기 중\n- [ ] 예시: 보고서 초안 @due(2099-12-31) #work\n\n## ✅ 완료\n');
    } catch {}
  }
  const CLIENT = path.join(SECRETS, 'google-oauth-client.json');
  const TOKEN = path.join(SECRETS, 'gcal-token.json');
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
  const plusHour = (t) => { const [h, m] = t.split(':').map(Number); return `${String(Math.min(23, h + 1)).padStart(2, '0')}:${String(m).padStart(2, '0')}`; };
  function toGoogle(it) {
    const timed = it.kind === 'event' && it.time;
    const summary = it.kind === 'task' ? `☐ ${it.title}` : it.kind === 'milestone' ? `📌 ${it.title}` : it.title;
    const description = [it.note, it.kind === 'task' ? `todo.md 할 일${it.paper ? ` · ${it.paper}` : ''}${it.tags?.length ? ' · #' + it.tags.join(' #') : ''}` : '', it.kind === 'milestone' ? 'todo.md 마일스톤' : '', 'Agent CLI Hub 캘린더에서 동기화 — 수정은 허브에서 하세요'].filter(Boolean).join('\n');
    const body = { summary, description, extendedProperties: { private: { hubId: it.id } },
      start: timed ? { dateTime: `${it.date}T${it.time.padStart(5, '0')}:00`, timeZone: TZ } : { date: it.date },
      end: timed ? { dateTime: `${it.date}T${(it.end || plusHour(it.time)).padStart(5, '0')}:00`, timeZone: TZ } : { date: addDays(it.date, 1) } };
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

  function allItems() {
    const t = parseTodo();
    const ev = loadEvents().map((e) => ({ kind: 'event', ...e }));
    return [...t.items, ...ev, ...gCache.events];
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
    if (p === '/api/calendar') {
      const t = parseTodo();
      return send(200, { items: [...t.items, ...loadEvents().map((e) => ({ kind: 'event', ...e })), ...gCache.events], todoError: t.error || null,
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
    interval.syncAll = setInterval(() => sync(), 10 * 60e3);
  }
  function stop() { clearInterval(interval); if (interval) clearInterval(interval.syncAll); clearTimeout(syncTimer); }
  return { handle, oauthCallback, start, stop, sync, upsertEvent, parseTodo };
};
