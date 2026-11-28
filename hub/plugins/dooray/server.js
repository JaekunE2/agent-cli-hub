'use strict';
// Dooray plugin: read-only events of a Dooray tenant's calendars in the hub calendar (calendarSources hook).
// It reads through a Chrome that is logged in to Dooray, over the Chrome DevTools port (cookies only, nothing is
// stored). config dooray: { base: "https://<tenant>.dooray.com", cdp: 9222, me: "<your name tag>",
// calendars: { "<calendar name>": "all" | "mine" } } — "all" leaves out entries tagged with someone else's name.
module.exports = function doorayPlugin(api) {
  const config = api.config;
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

  let timer = null;
  const source = {
    id: 'dooray', label: '두레이', cls: 'ck-d',
    events: () => dCache.events,
    status: () => ({ at: dCache.at || null, error: dCache.error, calendars: dCache.calendars, count: dCache.events.length }),
    refresh: () => doorayRefresh(),
    maybeRefresh: () => { if (Date.now() - dCache.at > 10 * 60e3) doorayRefresh(); },
  };
  return {
    enabled: !!DR.base,
    hooks: { calendarSources: () => source },
    // background refresh on the main hub only (a side instance refreshes when its calendar is opened)
    start() { if (api.instance.watchdog) { doorayRefresh(); timer = setInterval(() => doorayRefresh(), 15 * 60e3); timer.unref?.(); } },
    stop() { if (timer) clearInterval(timer); },
  };
};
