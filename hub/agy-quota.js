const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const round1 = (n) => Math.round(n * 10) / 10;
const clampPct = (n) => Math.max(0, Math.min(100, n));

function fmtResetHint(iso) {
  if (!iso) return null;
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms)) return null;
  if (ms <= 0) return 'Quota available';
  const mins = Math.round(ms / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function cleanGroupName(raw) {
  return String(raw || '')
    .trim()
    .replace(/\s+models$/i, '')
    .toUpperCase();
}

function extractModels(desc) {
  const m = /Models within this group:\s*(.+)/i.exec(String(desc || ''));
  return m ? m[1].trim() : '';
}

function parseAgyUsageJson(raw, prevAccount = null) {
  const txt = String(raw || '').trim();
  if (!txt) return null;
  const start = txt.indexOf('{');
  const end = txt.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let obj;
  try { obj = JSON.parse(txt.slice(start, end + 1)); } catch { return null; }
  const srcGroups = obj?.command?.data?.groups;
  if (!Array.isArray(srcGroups) || !srcGroups.length) return null;
  const groups = [];
  for (const g of srcGroups) {
    const item = {
      name: cleanGroupName(g.name),
      models: extractModels(g.description),
      fiveH: null,
      weekly: null,
      fiveHReset: null,
      weeklyReset: null,
      fiveHResetAt: null,
      weeklyResetAt: null,
    };
    for (const b of (Array.isArray(g.buckets) ? g.buckets : [])) {
      const remFrac = Number(b.remaining_fraction);
      if (!Number.isFinite(remFrac)) continue;
      const rem = round1(clampPct(remFrac * 100));
      const used = round1(clampPct(100 - rem));
      const win = String(b.window || '').toLowerCase();
      const is5h = win === '5h' || /five hour/i.test(b.name || '');
      const isWk = win === 'weekly' || /weekly/i.test(b.name || '');
      const iso = typeof b.reset_time === 'string' && Number.isFinite(Date.parse(b.reset_time)) ? b.reset_time : null;
      const hint = used <= 0 ? 'Quota available' : (fmtResetHint(iso) || 'Quota available');
      if (is5h) {
        item.fiveH = used;
        item.fiveHRem = rem;
        item.fiveHResetAt = iso;
        item.fiveHReset = hint;
      } else if (isWk) {
        item.weekly = used;
        item.weeklyRem = rem;
        item.weeklyResetAt = iso;
        item.weeklyReset = hint;
      }
    }
    if (item.fiveH !== null || item.weekly !== null) groups.push(item);
  }
  if (!groups.length) return null;
  const acc = obj?.command?.data?.account || obj?.account || prevAccount || null;
  return { account: acc, groups, fetchedAt: new Date().toISOString(), source: 'cli-json' };
}

function parseAgyUsageTsv(raw, prevAccount = null) {
  const lines = String(raw || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const byName = new Map();
  const groups = [];
  for (const line of lines) {
    const cols = line.split('\t');
    if (cols.length < 3) continue;
    const pctM = /(\d+(?:\.\d+)?)%/.exec(cols[2]);
    if (!pctM) continue;
    const rem = round1(clampPct(Number(pctM[1])));
    const used = round1(clampPct(100 - rem));
    const name = cleanGroupName(cols[0]);
    let cur = byName.get(name);
    if (!cur) {
      cur = { name, models: '', fiveH: null, weekly: null, fiveHReset: null, weeklyReset: null, fiveHResetAt: null, weeklyResetAt: null };
      byName.set(name, cur);
      groups.push(cur);
    }
    const iso = cols[3] && Number.isFinite(Date.parse(cols[3])) ? cols[3].trim() : null;
    const hint = used <= 0 ? 'Quota available' : (fmtResetHint(iso) || 'Quota available');
    if (/five hour/i.test(cols[1])) {
      cur.fiveH = used; cur.fiveHRem = rem; cur.fiveHResetAt = iso; cur.fiveHReset = hint;
    } else if (/weekly/i.test(cols[1])) {
      cur.weekly = used; cur.weeklyRem = rem; cur.weeklyResetAt = iso; cur.weeklyReset = hint;
    }
  }
  const valid = groups.filter((g) => g.fiveH !== null || g.weekly !== null);
  if (!valid.length) return null;
  return { account: prevAccount || null, groups: valid, fetchedAt: new Date().toISOString(), source: 'cli-tsv' };
}

function parseAgyQuotaTui(raw, prevAccount = null) {
  if (!/Models & Quota/i.test(String(raw || ''))) return null;
  const lines = String(raw).split(/\r?\n/).map((l) => l.trim());
  const accMatch = String(raw).match(/Account:\s*([^\s\r\n]+)/i);
  const byName = new Map();
  const groups = [];
  let cur = null;
  let metric = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l) continue;
    if (/^(?:\(\d+[–-]\d+\s+of\s+\d+\s+lines\)|↑\/↓ Scroll|└ Models & Quota|Account:|Within each group)/i.test(l)) continue;
    if (/^[A-Z0-9][A-Z0-9 ._-]+$/.test(l) && !/^(MODELS|QUOTA)$/.test(l) && (lines[i + 1]?.startsWith('Models within') || lines.slice(i + 1, i + 5).some((x) => /(?:Weekly|Five Hour) Limit/i.test(x)))) {
      const name = cleanGroupName(l);
      cur = byName.get(name);
      if (!cur) {
        cur = { name, models: '', fiveH: null, weekly: null, fiveHReset: null, weeklyReset: null, fiveHResetAt: null, weeklyResetAt: null };
        byName.set(name, cur);
        groups.push(cur);
      }
      metric = null;
      continue;
    }
    if (!cur) continue;
    if (/^Models within this group:\s*(.+)/i.test(l)) { cur.models = RegExp.$1.trim(); continue; }
    if (/Weekly Limit/i.test(l)) { metric = 'weekly'; continue; }
    if (/Five Hour Limit/i.test(l)) { metric = 'fiveH'; continue; }
    if (metric) {
      const pct = l.match(/(\d+(?:\.\d+)?)%/);
      if (pct) {
        const rem = round1(clampPct(Number(pct[1])));
        cur[metric] = round1(clampPct(100 - rem));
        cur[`${metric}Rem`] = rem;
      }
      const ref = l.match(/Refreshes in\s+(.+)/i);
      if (ref) cur[`${metric}Reset`] = ref[1].trim();
      if (/Quota available/i.test(l) && !cur[`${metric}Reset`]) cur[`${metric}Reset`] = 'Quota available';
    }
  }
  const valid = groups.filter((g) => g.fiveH !== null || g.weekly !== null);
  if (!valid.length) return null;
  return { account: accMatch ? accMatch[1] : prevAccount || null, groups: valid, fetchedAt: new Date().toISOString(), source: 'tui' };
}

function createAgyQuotaService({ file, agyExe, envFn, ttlMs = 120_000, staleMs = 180_000, timeoutMs = 18_000, runner } = {}) {
  let cache = (() => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  })();
  let inflight = null;
  let lastError = null;

  function save(q) {
    if (!q) return null;
    if (!q.account && cache?.account) q.account = cache.account;
    cache = q;
    lastError = null;
    if (file) {
      try {
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(q, null, 2));
        fs.renameSync(tmp, file);
      } catch {
        try { fs.writeFileSync(file, JSON.stringify(q, null, 2)); } catch {}
      }
    }
    return cache;
  }

  function ageMs() {
    const t = cache?.fetchedAt ? Date.parse(cache.fetchedAt) : NaN;
    return Number.isFinite(t) ? Math.max(0, Date.now() - t) : Infinity;
  }

  function runCli() {
    if (runner) return runner();
    const exe = typeof agyExe === 'function' ? agyExe() : agyExe;
    const env = typeof envFn === 'function' ? envFn() : process.env;
    return new Promise((resolve, reject) => {
      execFile(
        exe,
        ['--print', '/usage', '--output-format', 'json'],
        { env, windowsHide: true, timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 },
        (err, stdout, stderr) => {
          const out = String(stdout || '');
          const parsed = parseAgyUsageJson(out, cache?.account) || parseAgyUsageTsv(out, cache?.account);
          if (parsed) return resolve(parsed);
          const msg = err
            ? (err.killed ? 'Antigravity 한도 조회 시간 초과' : (String(stderr || err.message || 'agy 실행 실패').trim().slice(0, 200)))
            : 'Antigravity 한도 응답을 해석하지 못했습니다';
          reject(new Error(msg));
        },
      );
    });
  }

  async function refresh({ force = false } = {}) {
    if (!force && cache && ageMs() < ttlMs) {
      return { ok: true, quota: cache, cached: true, refreshed: false, elapsedMs: 0 };
    }
    if (inflight) return inflight;
    const t0 = Date.now();
    inflight = (async () => {
      try {
        const parsed = await runCli();
        save(parsed);
        return { ok: true, quota: cache, cached: false, refreshed: true, elapsedMs: Date.now() - t0 };
      } catch (e) {
        lastError = String(e.message || e);
        return { ok: false, error: lastError, quota: cache, cached: !!cache, refreshed: false, elapsedMs: Date.now() - t0 };
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  function getFast() {
    const stale = !cache || ageMs() >= staleMs;
    if (stale && !inflight) {
      refresh({ force: true }).catch(() => {});
    }
    return {
      ok: true,
      quota: cache,
      stale,
      refreshing: !!inflight,
      lastError,
    };
  }

  function noteAccount(acc) {
    if (!acc || !cache || cache.account === acc) return;
    save({ ...cache, account: acc });
  }

  return {
    get: () => cache,
    save,
    noteAccount,
    getFast,
    refresh,
    isRefreshing: () => !!inflight,
    ageMs,
  };
}

module.exports = {
  parseAgyUsageJson,
  parseAgyUsageTsv,
  parseAgyQuotaTui,
  createAgyQuotaService,
};
