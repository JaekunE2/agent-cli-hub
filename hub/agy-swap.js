// Multi-account Antigravity CLI switcher adapter (`aklkbqx/agy-swap`).
// Discovers an optional user-installed `agy-swap` binary, parses `list` / `limits`
// output into per-account quota objects, and switches the active `agy` account.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, spawnSync } = require('child_process');

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const round1 = (n) => Math.round(n * 10) / 10;
const clampPct = (n) => Math.max(0, Math.min(100, Number.isFinite(n) ? n : 0));

function findAgySwapExe(override) {
  const candidates = [
    override,
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'agy-swap', 'agy-swap.exe'),
    path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'agy-swap.exe' : 'agy-swap'),
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch {}
  }
  const pathDirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const binName = process.platform === 'win32' ? 'agy-swap.exe' : 'agy-swap';
  for (const d of pathDirs) {
    const p = path.join(d, binName);
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return null;
}

function parseResetDuration(text) {
  const s = String(text || '');
  let ms = 0;
  const d = /(\d+)\s*d/i.exec(s);
  const h = /(\d+)\s*h/i.exec(s);
  const m = /(\d+)\s*m(?!o)/i.exec(s);
  if (d) ms += Number(d[1]) * 86400e3;
  if (h) ms += Number(h[1]) * 3600e3;
  if (m) ms += Number(m[1]) * 60e3;
  return ms > 0 ? ms : null;
}

function parseAgySwapList(raw, { now = Date.now() } = {}) {
  const lines = String(raw || '').replace(ANSI_RE, '').split(/\r?\n/);
  const accounts = [];
  let cur = null;
  let curGroup = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // Example: ○ [1] [박(] 박경민 (SeoulMini) <pkm08112@gmail.com>
    // Example: ● [2] [KP] KyeongMin Park <arscabar@gmail.com> (Active)
    const accM = /^([○●*])\s+\[(\d+)\]\s+(?:\[[^\]]*\]\s+)?(.+?)\s+<([^>\s]+@[^>\s]+)>\s*(\(Active\))?/i.exec(line);
    if (accM) {
      const email = accM[4].trim();
      cur = {
        slot: Number(accM[2]),
        id: `agyswap:${email}`,
        email,
        name: accM[3].trim(),
        active: Boolean(accM[5]) || accM[1] === '●' || accM[1] === '*',
        plan: null,
        statusText: '',
        groups: [],
      };
      accounts.push(cur);
      curGroup = null;
      continue;
    }
    if (!cur) continue;

    const stM = /^(?:↳\s*)?Status:\s*(?:\[([^\]]+)\]\s*)?(.*)$/i.exec(line);
    if (stM) {
      cur.plan = stM[1] ? stM[1].trim() : null;
      cur.statusText = stM[2].trim();
      curGroup = null;
      continue;
    }

    const qM = /^(Weekly|5-Hour):\s*(?:\[[^\]]*\]\s*)?([\d.]+)%\s*remaining(?:\s*[·•-]?\s*resets in\s+(.+?)(?:\s*\(([^)]+)\))?)?$/i.exec(line);
    if (qM && curGroup) {
      const rem = round1(clampPct(Number(qM[2])));
      const used = round1(clampPct(100 - rem));
      const key = qM[1].toLowerCase().startsWith('5') ? 'fiveH' : 'weekly';
      const resetTxt = qM[3] ? qM[3].trim() : '';
      const durMs = parseResetDuration(resetTxt);
      curGroup[key] = used;
      curGroup[`${key}Rem`] = rem;
      if (resetTxt) curGroup[`${key}Reset`] = resetTxt;
      if (durMs) curGroup[`${key}ResetAt`] = new Date(now + durMs).toISOString();
      continue;
    }

    const grpM = /^↳\s*(.+)$/.exec(line);
    if (grpM) {
      curGroup = { name: grpM[1].trim(), fiveH: null, fiveHRem: null, fiveHReset: null, fiveHResetAt: null, weekly: null, weeklyRem: null, weeklyReset: null, weeklyResetAt: null };
      cur.groups.push(curGroup);
      continue;
    }

    if (!/^[-─═]+$/.test(line) && !/^Quota comes from/i.test(line) && !/^MANAGED ACCOUNTS/i.test(line) && !/^No accounts/i.test(line)) {
      curGroup = { name: line, fiveH: null, fiveHRem: null, fiveHReset: null, fiveHResetAt: null, weekly: null, weeklyRem: null, weeklyReset: null, weeklyResetAt: null };
      cur.groups.push(curGroup);
    }
  }

  for (const a of accounts) {
    a.groups = a.groups.filter((g) => g.fiveH !== null || g.weekly !== null);
  }
  return accounts;
}

function createAgySwapService({ exeFn = () => findAgySwapExe(), envFn = () => process.env, ttlMs = 90_000, staleMs = 180_000, timeoutMs = 20_000, runner } = {}) {
  let cache = null; // { accounts, fetchedAt }
  let inflight = null;
  let lastError = null;

  function exePath() {
    return typeof exeFn === 'function' ? exeFn() : exeFn;
  }

  function available() {
    return Boolean(exePath());
  }

  function ageMs() {
    const t = cache?.fetchedAt ? Date.parse(cache.fetchedAt) : NaN;
    return Number.isFinite(t) ? Math.max(0, Date.now() - t) : Infinity;
  }

  let lastSyncedTokMtime = 0;
  function syncActiveTokenIfNewer() {
    if (runner) return;
    const exe = exePath();
    if (!exe) return;
    try {
      const tokFile = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
      const vaultFile = path.join(os.homedir(), '.gemini', 'agy-swap', 'vault.json');
      if (!fs.existsSync(tokFile)) return;
      const tokMtime = fs.statSync(tokFile).mtimeMs;
      const vaultMtime = fs.existsSync(vaultFile) ? fs.statSync(vaultFile).mtimeMs : 0;
      if (tokMtime <= vaultMtime || tokMtime <= lastSyncedTokMtime) return;
      lastSyncedTokMtime = tokMtime;
      const raw = fs.readFileSync(tokFile, 'utf8');
      if (raw.trim().startsWith('{')) {
        spawnSync(exe, ['--token', '-'], { input: raw, encoding: 'utf8', windowsHide: true, timeout: 5000 });
      }
    } catch {}
  }

  function runCmd(args) {
    syncActiveTokenIfNewer();
    if (runner) return runner(args);
    const exe = exePath();
    if (!exe) return Promise.reject(new Error('agy-swap 실행 파일을 찾을 수 없습니다'));
    const env = typeof envFn === 'function' ? envFn() : process.env;
    return new Promise((resolve, reject) => {
      execFile(exe, args, { env, windowsHide: true, timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          const msg = err.killed ? 'agy-swap 실행 시간 초과' : String(stderr || stdout || err.message || 'agy-swap 실행 실패').trim().slice(0, 240);
          return reject(new Error(msg));
        }
        resolve(String(stdout || ''));
      });
    });
  }

  async function refresh({ force = false } = {}) {
    if (!available()) {
      return { ok: false, available: false, accounts: [], fetchedAt: null, error: 'agy-swap 미설치' };
    }
    if (!force && cache && ageMs() < ttlMs) {
      return { ok: true, available: true, accounts: cache.accounts, fetchedAt: cache.fetchedAt, cached: true, refreshed: false, elapsedMs: 0 };
    }
    if (inflight) return inflight;
    const t0 = Date.now();
    inflight = (async () => {
      try {
        let out;
        try { out = await runCmd(force ? ['limits'] : ['list']); }
        catch { out = await runCmd(['list']); }
        const accounts = parseAgySwapList(out);
        const fetchedAt = new Date().toISOString();
        cache = { accounts, fetchedAt };
        lastError = null;
        return { ok: true, available: true, accounts, fetchedAt, cached: false, refreshed: true, elapsedMs: Date.now() - t0 };
      } catch (e) {
        lastError = String(e.message || e);
        return { ok: false, available: true, error: lastError, accounts: cache?.accounts || [], fetchedAt: cache?.fetchedAt || null, cached: !!cache, refreshed: false, elapsedMs: Date.now() - t0 };
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  function getFast() {
    const av = available();
    if (!av) return { available: false, accounts: [], fetchedAt: null, refreshing: false, lastError: null };
    const stale = !cache || ageMs() >= staleMs;
    if (stale && !inflight) refresh({ force: !cache }).catch(() => {});
    return {
      available: true,
      accounts: cache?.accounts || [],
      fetchedAt: cache?.fetchedAt || null,
      refreshing: !!inflight,
      stale,
      lastError,
    };
  }

  async function switchTo(account) {
    if (!available()) throw new Error('agy-swap 실행 파일을 찾을 수 없습니다');
    const clean = String(account || '').replace(/^agyswap:/i, '').trim();
    if (!clean) throw new Error('전환할 Antigravity 계정을 지정하세요');
    await runCmd(['--switch-to', clean]);
    if (cache?.accounts?.length) {
      cache = {
        ...cache,
        accounts: cache.accounts.map((a) => ({
          ...a,
          active: a.email.toLowerCase() === clean.toLowerCase() || String(a.slot) === clean,
        })),
      };
    }
    const targetAcc = cache?.accounts?.find((a) => a.active) || { email: clean, id: `agyswap:${clean}` };
    return { ok: true, account: targetAcc, accounts: cache?.accounts || [] };
  }

  return { available, getFast, refresh, switchTo };
}

module.exports = { findAgySwapExe, parseResetDuration, parseAgySwapList, createAgySwapService };
