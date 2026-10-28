'use strict';
if (require('./i18n').takeOver(module)) return; // English mode (language set in hub/config.json)
const I18N = require('./i18n');

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

// Share mode: hides this PC's own accounts and never hands out tokens (LAN-shareable).
const SHARE_MODE = process.env.SHARE_MODE === '1';
// Read-only viewer: blocks every change and token read — used by the portable package.
const READONLY = process.env.READONLY === '1';
const PORT = Number(process.env.PORT) || (SHARE_MODE ? 4778 : 4777);
const HOST = process.env.HOST || (SHARE_MODE ? '0.0.0.0' : '127.0.0.1');
const CONFIG_PATH = path.join(__dirname, 'accounts.json');
const MEMO_PATH = path.join(__dirname, 'memos.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const CACHE_MS = 30_000;
const TIMEOUT_MS = 15_000;
const HOME = os.homedir();

const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const CLAUDE_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';

// ---------- config ----------

function loadConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return { autoDetect: cfg.autoDetect !== false, accounts: Array.isArray(cfg.accounts) ? cfg.accounts : [] };
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('accounts.json 읽기 실패:', e.message);
    return { autoDetect: true, accounts: [] };
  }
}

function saveConfig(cfg) {
  writeFileAtomic(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

function loadMemos() {
  try { return JSON.parse(fs.readFileSync(MEMO_PATH, 'utf8')); } catch { return {}; }
}

// Long-lived tokens can't read a profile, so we remember which email each org UUID belongs to
// whenever a profile-capable account (Claude Code / desktop) is fetched, and reuse it for tokens.
const ORG_MAP_PATH = path.join(__dirname, 'org-emails.json');
let orgMap = null;
function loadOrgMap() {
  if (!orgMap) { try { orgMap = JSON.parse(fs.readFileSync(ORG_MAP_PATH, 'utf8')); } catch { orgMap = {}; } }
  return orgMap;
}
function rememberOrg(uuid, email) {
  if (!uuid || !email) return;
  const m = loadOrgMap();
  if (m[uuid] === email) return;
  m[uuid] = email;
  try { writeFileAtomic(ORG_MAP_PATH, JSON.stringify(m, null, 2)); } catch { /* best effort */ }
}

function saveMemo(id, text) {
  const memos = loadMemos();
  if (text) memos[id] = text; else delete memos[id];
  writeFileAtomic(MEMO_PATH, JSON.stringify(memos, null, 2));
  return memos;
}

function writeFileAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function expandPath(p) {
  if (!p) return p;
  return p.replace(/^~(?=$|[\\/])/, HOME).replace(/%([^%]+)%/g, (_, k) => process.env[k] ?? `%${k}%`);
}

function detectAccounts() {
  const found = [];
  const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
  const claudeCreds = path.join(claudeDir, '.credentials.json');
  if (fs.existsSync(claudeCreds)) {
    found.push({ id: 'auto-claude', type: 'claude', label: 'Claude Code (이 PC)', credentialsPath: claudeCreds, refresh: false });
  }
  const codexAuth = path.join(process.env.CODEX_HOME || path.join(HOME, '.codex'), 'auth.json');
  if (fs.existsSync(codexAuth)) {
    found.push({ id: 'auto-codex', type: 'codex', label: 'ChatGPT / Codex (이 PC)', authPath: codexAuth, refresh: false });
  }
  return found.map((a) => ({ ...a, source: 'auto' }));
}

function cursorDbPath() { // (unused in the shared version)
  const rel = ['Cursor', 'User', 'globalStorage', 'state.vscdb'];
  if (process.platform === 'win32') return process.env.APPDATA && path.join(process.env.APPDATA, ...rel);
  if (process.platform === 'darwin') return path.join(HOME, 'Library', 'Application Support', ...rel);
  return path.join(HOME, '.config', ...rel);
}

function allAccounts() {
  const cfg = loadConfig();
  const manual = cfg.accounts.map((a) => ({ refresh: true, ...a, source: 'manual' }));
  // an auto-detected desktop login duplicates a manually registered desktop account
  const auto = (cfg.autoDetect ? detectAccounts() : []).filter((a) => !(a.type === 'claude-desktop' && manual.some((m) => m.type === 'claude-desktop')));
  return [...auto, ...manual];
}

// ---------- helpers ----------

async function getJson(url, options = {}) {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!res.ok) {
    const msg = body?.error?.message || body?.error_description || body?.message || (typeof body?.error === 'string' ? body.error : '') || text.slice(0, 160);
    const err = new Error(`HTTP ${res.status}${msg ? ` — ${msg}` : ''}`);
    err.status = res.status;
    throw err;
  }
  if (body === null) throw new Error('JSON이 아닌 응답을 받았습니다 (봇 차단 페이지일 수 있음)');
  return body;
}

function decodeJwt(token) {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')); } catch { return null; }
}

// one decimal at most: APIs return e.g. 6.593538461538461 (Cursor) and every client printed it raw
const clampPct = (n) => Math.round(Math.max(0, Math.min(100, Number(n) || 0)) * 10) / 10;
const usd = (cents) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Stripe/Play subscriptions renew on the same day each period; step the start date to the next future date.
function nextMonthlyDate(fromIso) {
  const start = new Date(fromIso);
  if (Number.isNaN(start.getTime())) return null;
  const d = new Date(start);
  const now = Date.now();
  let guard = 0;
  while (d.getTime() <= now && guard++ < 600) d.setMonth(d.getMonth() + 1);
  return d.toISOString();
}

function claudeBilling(org) {
  if (!org) return null;
  const type = { stripe_subscription: 'Stripe', google_play_subscription: 'Play스토어', apple_subscription: 'App Store' }[org.billing_type] || org.billing_type || '';
  const nextAt = org.subscription_created_at ? nextMonthlyDate(org.subscription_created_at) : null;
  if (!nextAt && !type) return null;
  return { label: type ? `${type} 결제일` : '결제일', at: nextAt, note: /google_play|apple/.test(org.billing_type || '') ? '스토어에서 관리' : '' };
}

function windowName(seconds) {
  if (!seconds) return '사용 한도';
  const h = seconds / 3600;
  if (Math.abs(h - 5) < 0.1) return '5시간 한도';
  if (Math.abs(h - 168) < 1) return '주간 한도';
  if (Math.abs(h - 24) < 0.1) return '일간 한도';
  return h >= 24 ? `${Math.round(h / 24)}일 한도` : `${Math.round(h)}시간 한도`;
}

// ---------- Claude ----------

const profileCache = new Map();

async function claudeToken(acc) {
  const file = expandPath(acc.credentialsPath);
  if (!file) throw new Error('credentialsPath가 설정되지 않았습니다');
  let creds = readJson(file);
  let oauth = creds.claudeAiOauth;
  if (!oauth?.accessToken) throw new Error('claudeAiOauth 토큰이 없습니다. 해당 설정 폴더에서 /login 하세요');
  if (oauth.expiresAt && oauth.expiresAt > Date.now() + 60_000) return { token: oauth.accessToken, oauth };

  if (!acc.refresh) {
    throw new Error('토큰이 만료되었습니다. Claude Code를 한 번 실행하면 자동 갱신됩니다');
  }
  const t = await getJson(CLAUDE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: oauth.refreshToken, client_id: CLAUDE_CLIENT_ID }),
  });
  creds = readJson(file);
  oauth = {
    ...creds.claudeAiOauth,
    accessToken: t.access_token,
    refreshToken: t.refresh_token || creds.claudeAiOauth.refreshToken,
    expiresAt: Date.now() + (t.expires_in || 3600) * 1000,
  };
  creds.claudeAiOauth = oauth;
  writeFileAtomic(file, JSON.stringify(creds));
  return { token: oauth.accessToken, oauth };
}

async function claudeUsageProfile(id, token) {
  const headers = { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'ai-usage-dashboard' };
  const cached = profileCache.get(id);
  const profilePromise = cached && cached.at > Date.now() - 3600_000
    ? Promise.resolve(cached.data)
    : getJson('https://api.anthropic.com/api/oauth/profile', { headers })
        .then((data) => { profileCache.set(id, { at: Date.now(), data }); return data; })
        .catch(() => null);
  return Promise.all([getJson('https://api.anthropic.com/api/oauth/usage', { headers }), profilePromise]);
}

function buildClaudeResult(usage, profile, fallback = {}) {
  const meters = [];
  if (Array.isArray(usage.limits) && usage.limits.length) {
    for (const l of usage.limits) {
      let name = { session: '5시간 세션', weekly_all: '주간 (전체 모델)' }[l.kind];
      if (!name) {
        const scope = l.scope?.model?.display_name || l.scope?.surface || '';
        name = l.group === 'weekly' ? `주간 (${scope || l.kind})` : scope || l.kind;
      }
      meters.push({ name, usedPercent: clampPct(l.percent), resetsAt: l.resets_at });
    }
  } else {
    const legacy = { five_hour: '5시간 세션', seven_day: '주간 (전체 모델)', seven_day_opus: '주간 (Opus)', seven_day_sonnet: '주간 (Sonnet)' };
    for (const [k, name] of Object.entries(legacy)) {
      if (usage[k]) meters.push({ name, usedPercent: clampPct(usage[k].utilization), resetsAt: usage[k].resets_at });
    }
  }
  const extra = usage.extra_usage;
  if (extra?.is_enabled && extra.monthly_limit) {
    meters.push({
      name: '추가 사용량 (월)',
      usedPercent: clampPct(extra.utilization ?? (extra.used_credits / extra.monthly_limit) * 100),
      detail: `${extra.used_credits ?? 0} / ${extra.monthly_limit} ${extra.currency || ''}`.trim(),
    });
  }

  const org = profile?.organization;
  const tier = org?.rate_limit_tier || fallback.rateLimitTier || '';
  const plan = profile?.account?.has_claude_max
    ? `Max${/20x/.test(tier) ? ' 20x' : /5x/.test(tier) ? ' 5x' : ''}`
    : profile?.account?.has_claude_pro ? 'Pro' : (fallback.subscriptionType || '').toUpperCase();

  if (org?.uuid && profile?.account?.email) rememberOrg(org.uuid, profile.account.email);
  return { plan, email: profile?.account?.email, meters, billing: claudeBilling(org) };
}

async function fetchClaude(acc) {
  const { token, oauth } = await claudeToken(acc);
  const [usage, profile] = await claudeUsageProfile(acc.id, token);
  return buildClaudeResult(usage, profile, oauth);
}

// ---------- Claude long-lived token (claude setup-token) ----------

function readSecret(acc, inlineKey, pathKey) {
  if (acc[inlineKey]) return String(acc[inlineKey]).trim();
  const file = expandPath(acc[pathKey]);
  if (!file) throw new Error(`${inlineKey} 또는 ${pathKey}가 필요합니다`);
  const value = fs.readFileSync(file, 'utf8').trim();
  if (!value) throw new Error(`${file} 파일이 비어 있습니다`);
  return value;
}

// These tokens only carry the user:inference scope, so the usage endpoint rejects them.
// A 1-token Haiku request returns the same utilization figures as response headers.
async function fetchClaudeToken(acc) {
  const token = readSecret(acc, 'token', 'tokenPath');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      Authorization: `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 1,
      system: "You are Claude Code, Anthropic's official CLI for Claude.",
      messages: [{ role: 'user', content: 'hi' }],
    }),
  });
  const h = (k) => res.headers.get(`anthropic-ratelimit-unified-${k}`);
  if (h('5h-utilization') == null && h('7d-utilization') == null) {
    const body = await res.json().catch(() => null);
    throw new Error(`HTTP ${res.status}${body?.error?.message ? ` — ${body.error.message}` : ''}`);
  }
  const orgId = res.headers.get('anthropic-organization-id');
  await res.body?.cancel().catch(() => {});

  const meters = [];
  for (const [key, name] of [['5h', '5시간 세션'], ['7d', '주간 (전체 모델)']]) {
    const util = h(`${key}-utilization`);
    if (util == null) continue;
    const reset = Number(h(`${key}-reset`));
    meters.push({ name, usedPercent: clampPct(Number(util) * 100), resetsAt: reset ? new Date(reset * 1000).toISOString() : null });
  }
  const notes = [];
  if (h('status') && h('status') !== 'allowed') notes.push(`현재 상태: ${h('status')} (한도 도달)`);
  if (h('overage-status') === 'allowed') notes.push('추가 사용량(overage) 사용 가능');
  notes.push('조회할 때마다 1토큰짜리 요청을 보내므로 5분마다만 갱신합니다');
  // The token only carries user:inference scope, so it can't read a profile. Resolve the account name
  // from an explicit owner label, else from the learned org→email map, else fall back to the org UUID.
  const known = orgId && loadOrgMap()[orgId];
  const who = acc.owner || known || (orgId ? `조직 ${orgId.slice(0, 8)}…` : undefined);
  if (!acc.owner && !known && orgId) notes.push('계정 이름을 표시하려면 이 카드에 owner를 지정하세요');
  return { plan: 'OAuth 토큰', email: who, meters, notes };
}

// ---------- Gemini ----------

async function fetchGemini(acc) {
  const key = readSecret(acc, 'apiKey', 'keyPath');
  const r = await getJson('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000', { headers: { 'x-goog-api-key': key } });
  const models = (r.models || []).filter((m) => m.supportedGenerationMethods?.includes('generateContent'));
  return {
    plan: 'API 키',
    meters: [{ name: '키 상태', usedPercent: null, detail: `유효함 · 사용 가능한 모델 ${models.length}개` }],
    notes: ['Google은 API 키로 남은 할당량 조회를 지원하지 않습니다. aistudio.google.com의 Usage 페이지에서 확인하세요'],
  };
}

// ---------- Meshy (3D generation API) ----------
// The API only reports the remaining credit balance. With "monthlyCredits" (the plan's monthly grant)
// the meter also shows how much of this month's credits is used.
async function fetchMeshy(acc) {
  const key = readSecret(acc, 'apiKey', 'keyPath');
  const r = await getJson('https://api.meshy.ai/openapi/v1/balance', { headers: { Authorization: `Bearer ${key}` } });
  const bal = Number(r.balance);
  if (!Number.isFinite(bal)) throw new Error('Meshy 응답에 balance가 없습니다');
  const monthly = Number(acc.monthlyCredits) || 0;
  return {
    plan: monthly ? `월 ${monthly.toLocaleString()} 크레딧` : 'API 키',
    meters: [{ name: '크레딧', usedPercent: monthly ? clampPct((1 - bal / monthly) * 100) : null, detail: `잔여 ${bal.toLocaleString()} 크레딧${monthly ? ` / 월 ${monthly.toLocaleString()}` : ''}` }],
    notes: monthly ? [] : ['월 제공 크레딧(monthlyCredits)을 넣으면 사용률(%)도 표시됩니다'],
  };
}

// ---------- Cursor ----------

function cursorSession(acc) {
  if (acc.localDb) throw new Error('Cursor: 세션 토큰을 입력해 등록하세요');
  if (false) {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(acc.localDb, { readOnly: true });
    try {
      const get = (k) => db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(k)?.value;
      const token = get('cursorAuth/accessToken');
      if (!token) throw new Error('Cursor 앱에 로그인되어 있지 않습니다');
      const sub = decodeJwt(token)?.sub || '';
      return { userId: sub.split('|').pop(), token, email: get('cursorAuth/cachedEmail') };
    } finally {
      db.close();
    }
  }
  const raw = decodeURIComponent(String(acc.sessionToken || '').trim());
  const idx = raw.indexOf('::');
  if (idx < 0) throw new Error('sessionToken 형식이 올바르지 않습니다 (user_xxx::eyJ... 또는 %3A%3A 형태)');
  return { userId: raw.slice(0, idx), token: raw.slice(idx + 2) };
}

async function fetchCursor(acc) {
  const s = cursorSession(acc);
  const exp = decodeJwt(s.token)?.exp;
  if (exp && exp * 1000 < Date.now()) {
    throw new Error(acc.localDb ? '토큰이 만료되었습니다. Cursor 앱을 실행하면 갱신됩니다' : '세션 토큰이 만료되었습니다. cursor.com에서 다시 복사하세요');
  }
  const headers = {
    Cookie: `WorkosCursorSessionToken=${encodeURIComponent(`${s.userId}::${s.token}`)}`,
    Origin: 'https://cursor.com',
    Referer: 'https://cursor.com/dashboard',
  };
  const [summary, stripe, me] = await Promise.all([
    getJson('https://cursor.com/api/usage-summary', { headers }),
    getJson('https://cursor.com/api/auth/stripe', { headers }).catch(() => null),
    s.email ? Promise.resolve(null) : getJson('https://cursor.com/api/auth/me', { headers }).catch(() => null),
  ]);

  const meters = [];
  const resetsAt = summary.billingCycleEnd;
  const ind = summary.individualUsage;
  const planU = ind?.plan;
  if (planU?.enabled) {
    const b = planU.breakdown || {};
    const bonus = b.bonus ? ` · 보너스 ${usd(b.bonus)}` : '';
    meters.push({ name: '전체 포함 사용량', usedPercent: clampPct(planU.totalPercentUsed), resetsAt, detail: `포함 ${usd(b.included ?? planU.limit)}${bonus}`, headline: true });
    if (planU.autoPercentUsed != null) meters.push({ name: 'Auto 모델', usedPercent: clampPct(planU.autoPercentUsed), resetsAt });
    if (planU.apiPercentUsed != null) meters.push({ name: '지정 모델 (API 요금)', usedPercent: clampPct(planU.apiPercentUsed), resetsAt, detail: `${usd(planU.used)} / ${usd(planU.limit)}` });
  }
  const od = ind?.onDemand;
  if (od?.enabled) {
    meters.push(od.limit
      ? { name: '온디맨드', usedPercent: clampPct((od.used / od.limit) * 100), resetsAt, detail: `${usd(od.used)} / ${usd(od.limit)}` }
      : { name: '온디맨드', usedPercent: null, detail: `${usd(od.used)} 사용 (한도 없음)` });
  }
  const team = summary.teamUsage?.onDemand;
  if (team?.enabled && team.limit) {
    meters.push({ name: '팀 온디맨드', usedPercent: clampPct((team.used / team.limit) * 100), resetsAt, detail: `${usd(team.used)} / ${usd(team.limit)}` });
  }

  if (!meters.length) {
    const legacy = await getJson(`https://cursor.com/api/usage?user=${encodeURIComponent(s.userId)}`, { headers });
    for (const [model, u] of Object.entries(legacy)) {
      if (!u || typeof u !== 'object' || !u.maxRequestUsage) continue;
      meters.push({ name: `${model} 요청`, usedPercent: clampPct((u.numRequests / u.maxRequestUsage) * 100), resetsAt, detail: `${u.numRequests} / ${u.maxRequestUsage}회` });
    }
  }

  const planName = stripe?.membershipType || summary.membershipType || '';
  const notes = [];
  if (summary.isUnlimited) notes.push('무제한 요금제');
  if (stripe?.subscriptionStatus && stripe.subscriptionStatus !== 'active') notes.push(`구독 상태: ${stripe.subscriptionStatus}`);
  if (stripe?.pendingCancellationDate) notes.push('구독 해지 예정');
  const billing = resetsAt ? { label: `${stripe?.isYearlyPlan ? '연간' : '월간'} 결제일`, at: resetsAt } : null;
  return { plan: planName ? planName[0].toUpperCase() + planName.slice(1) : '', email: s.email || me?.email, meters, notes, billing };
}

// ---------- ChatGPT / Codex ----------

async function codexToken(acc) {
  if (acc.accessToken) {
    const claims = decodeJwt(acc.accessToken);
    if (claims?.exp && claims.exp * 1000 < Date.now()) throw new Error('accessToken이 만료되었습니다. 새로 복사하세요');
    return { token: acc.accessToken, accountId: acc.accountId || claims?.['https://api.openai.com/auth']?.chatgpt_account_id, claims };
  }
  const file = expandPath(acc.authPath);
  if (!file) throw new Error('authPath 또는 accessToken이 필요합니다');
  let auth = readJson(file);
  let tokens = auth.tokens;
  if (!tokens?.access_token) throw new Error('ChatGPT 로그인 토큰이 없습니다 (codex login 필요)');
  let claims = decodeJwt(tokens.access_token);
  if (!claims?.exp || claims.exp * 1000 > Date.now() + 60_000) {
    return { token: tokens.access_token, accountId: tokens.account_id, claims: decodeJwt(tokens.id_token) || claims };
  }
  if (!acc.refresh) throw new Error('토큰이 만료되었습니다. Codex CLI를 한 번 실행하면 갱신됩니다');
  const t = await getJson(CODEX_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CODEX_CLIENT_ID, grant_type: 'refresh_token', refresh_token: tokens.refresh_token, scope: 'openid profile email' }),
  });
  auth = readJson(file);
  auth.tokens = {
    ...auth.tokens,
    access_token: t.access_token,
    id_token: t.id_token || auth.tokens.id_token,
    refresh_token: t.refresh_token || auth.tokens.refresh_token,
  };
  auth.last_refresh = new Date().toISOString();
  writeFileAtomic(file, JSON.stringify(auth, null, 2));
  tokens = auth.tokens;
  claims = decodeJwt(tokens.id_token) || decodeJwt(tokens.access_token);
  return { token: tokens.access_token, accountId: tokens.account_id, claims };
}

async function fetchCodex(acc) {
  const { token, accountId, claims } = await codexToken(acc);
  const headers = { Authorization: `Bearer ${token}`, 'User-Agent': 'codex_cli_rs/0.40.0', Accept: 'application/json' };
  if (accountId) headers['ChatGPT-Account-Id'] = accountId;
  const u = await getJson('https://chatgpt.com/backend-api/wham/usage', { headers });

  const meters = [];
  const rl = u.rate_limit || {};
  for (const w of [rl.primary_window, rl.secondary_window]) {
    if (!w) continue;
    const resetsAt = w.reset_at ? new Date(w.reset_at * 1000).toISOString()
      : w.reset_after_seconds != null ? new Date(Date.now() + w.reset_after_seconds * 1000).toISOString() : null;
    meters.push({ name: `Codex ${windowName(w.limit_window_seconds)}`, usedPercent: clampPct(w.used_percent), resetsAt });
  }
  const notes = [];
  if (rl.limit_reached) notes.push('한도에 도달했습니다');
  if (u.credits?.unlimited) notes.push('크레딧 무제한');
  else if (u.credits?.has_credits) notes.push(`남은 크레딧: ${u.credits.balance}`);

  const auth = claims?.['https://api.openai.com/auth'] || {};
  const plan = u.plan_type || auth.chatgpt_plan_type || '';
  return { plan: plan ? plan[0].toUpperCase() + plan.slice(1) : '', email: claims?.email || u.email, meters, notes };
}

// ---------- OpenAI API (organization costs) ----------

async function fetchOpenAIApi(acc) {
  if (!acc.adminKey) throw new Error('adminKey(sk-admin-...)가 필요합니다');
  const now = new Date();
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000;
  const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
  const headers = { Authorization: `Bearer ${acc.adminKey}` };

  let total = 0;
  let currency = 'usd';
  let page;
  for (let i = 0; i < 20; i++) {
    const qs = new URLSearchParams({ start_time: String(monthStart), bucket_width: '1d', limit: '180' });
    if (page) qs.set('page', page);
    const r = await getJson(`https://api.openai.com/v1/organization/costs?${qs}`, { headers });
    for (const bucket of r.data || []) {
      for (const res of bucket.results || []) {
        total += Number(res.amount?.value) || 0;
        currency = res.amount?.currency || currency;
      }
    }
    if (!r.has_more || !r.next_page) break;
    page = r.next_page;
  }
  const spent = `${currency === 'usd' ? '$' : ''}${total.toFixed(2)}${currency === 'usd' ? '' : ` ${currency}`}`;
  const budget = Number(acc.monthlyBudget);
  const meters = [budget > 0
    ? { name: '이번 달 지출 (예산 대비)', usedPercent: clampPct((total / budget) * 100), resetsAt: nextMonth, detail: `${spent} / $${budget.toFixed(2)}` }
    : { name: '이번 달 지출', usedPercent: null, resetsAt: nextMonth, detail: `${spent} (monthlyBudget을 설정하면 잔여율 표시)` }];
  return { plan: 'API', meters, notes: ['비용 데이터는 수 시간 지연될 수 있습니다'], billing: { label: '지출 집계 초기화', at: nextMonth } };
}

// ---------- dispatch ----------

const PROVIDERS = {
  claude: { name: 'Claude', fetch: fetchClaude },
  'claude-token': { name: 'Claude', fetch: fetchClaudeToken, cacheMs: 300_000, minForceMs: 30_000 },
  cursor: { name: 'Cursor', fetch: fetchCursor },
  codex: { name: 'ChatGPT', fetch: fetchCodex },
  'openai-api': { name: 'OpenAI API', fetch: fetchOpenAIApi },
  gemini: { name: 'Gemini', fetch: fetchGemini, cacheMs: 600_000 },
  meshy: { name: 'Meshy', fetch: fetchMeshy, cacheMs: 600_000 },
};

const resultCache = new Map();

// True when the account is backed by a live local app login (a session an app keeps refreshed),
// rather than a static pasted token or API key.
function isLiveLogin(acc) {
  if (acc.type === 'claude-desktop') return true;
  if (acc.source === 'auto') return true;
  if (acc.type === 'claude' && acc.credentialsPath) return true;
  if (acc.type === 'cursor' && acc.localDb) return true;
  if (acc.type === 'codex' && acc.authPath) return true;
  return false;
}

// A copyable secret the user themselves pasted or pointed at — not an app's managed login store.
const SECRET_SPEC = {
  'claude-token': ['token', 'tokenPath'],
  gemini: ['apiKey', 'keyPath'],
  meshy: ['apiKey', 'keyPath'],
  'openai-api': ['adminKey'],
  codex: ['accessToken'],
  cursor: ['sessionToken'],
};

function accountSecret(acc) {
  const [inlineKey, pathKey] = SECRET_SPEC[acc.type] || [];
  if (inlineKey && acc[inlineKey]) return String(acc[inlineKey]).trim();
  if (pathKey && acc[pathKey]) { try { return fs.readFileSync(expandPath(acc[pathKey]), 'utf8').trim(); } catch { return null; } }
  return null;
}

function hasSecret(acc) {
  return (SECRET_SPEC[acc.type] || []).some((f) => acc[f]);
}

async function usageFor(acc, force) {
  const hit = resultCache.get(acc.id);
  const p = PROVIDERS[acc.type];
  const ttl = force ? p?.minForceMs ?? 0 : p?.cacheMs ?? CACHE_MS;
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  const provider = PROVIDERS[acc.type];
  const base = { id: acc.id, type: acc.type, provider: provider?.name || acc.type, label: acc.label || provider?.name, source: acc.source, live: isLiveLogin(acc), hasSecret: hasSecret(acc) };
  let value;
  try {
    if (!provider) throw new Error(`알 수 없는 type: ${acc.type}`);
    value = { ...base, ok: true, notes: [], ...(await provider.fetch(acc)) };
  } catch (e) {
    const cause = e.cause?.code || e.cause?.message;
    let error = e.name === 'TimeoutError' ? '응답 시간 초과' : e.message;
    if (cause) error += ` (${cause})`;
    if (/CERT|certificate/i.test(error)) error += ' — start.bat(--use-system-ca)으로 실행했는지 확인하세요';
    value = { ...base, ok: false, error };
  }
  value.fetchedAt = new Date().toISOString();
  resultCache.set(acc.id, { at: Date.now(), value });
  return value;
}

// ---------- HTTP ----------

const SECRET_FIELDS = ['sessionToken', 'accessToken', 'adminKey', 'token', 'apiKey'];

// Catch pasted-the-wrong-thing mistakes (e.g. the authorize URL instead of the token) at input time.
function validateNewAccount(acc) {
  if (/^https?:\/\//i.test(acc.token || acc.apiKey || acc.adminKey || '')) {
    return '토큰이 아니라 URL을 붙여넣으신 것 같습니다. 브라우저 승인 후 마지막에 출력되는 sk-ant-oat01-… 값을 넣어주세요.';
  }
  if (acc.type === 'claude-token' && acc.token && !acc.token.startsWith('sk-ant-oat01-')) {
    return `Claude 장기 토큰은 "sk-ant-oat01-"로 시작해야 합니다 (입력값 앞부분: ${acc.token.slice(0, 12)}…).`;
  }
  if (acc.type === 'openai-api' && acc.adminKey && !/^sk-admin-/.test(acc.adminKey)) {
    return 'OpenAI 비용 조회는 Admin 키(sk-admin-…)가 필요합니다. 일반 API 키로는 조회되지 않습니다.';
  }
  return null;
}

function publicAccount(acc) {
  const out = { ...acc };
  for (const f of SECRET_FIELDS) if (out[f]) out[f] = '••••';
  delete out.localDb;
  return out;
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  if (body && typeof body === 'object' && !Buffer.isBuffer(body) && typeof body.error === 'string') body.error = I18N.msg(body.error);
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 64_000) { reject(new Error('요청이 너무 큽니다')); req.destroy(); } });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { reject(new Error('잘못된 JSON')); } });
    req.on('error', reject);
  });
}

const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

const server = http.createServer(async (req, res) => {
  // Share mode is read-only with no secrets, so it may be reached over the LAN by IP.
  // Private mode keeps the DNS-rebinding host allowlist that protects token endpoints.
  if (!SHARE_MODE && !ALLOWED_HOSTS.has(req.headers.host)) return send(res, 403, { error: 'forbidden host' });
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  try {
    if (url.pathname.startsWith('/api/')) {
      // Read-only viewer: no changes, no token reads.
      if (READONLY && (req.method !== 'GET' || url.pathname === '/api/token')) {
        return send(res, 403, { error: '읽기 전용 뷰어입니다' });
      }
      // Share mode allows managing accounts, but never hands out tokens.
      if (SHARE_MODE && url.pathname === '/api/token') {
        return send(res, 403, { error: '공유 대시보드에서는 토큰을 제공하지 않습니다' });
      }
      // A custom header forces a CORS preflight, which this server never approves.
      if (req.method !== 'GET' && req.headers['x-dashboard'] !== '1') return send(res, 403, { error: 'missing header' });

      if (req.method === 'GET' && url.pathname === '/api/meta') {
        return send(res, 200, { shareMode: SHARE_MODE, readOnly: READONLY });
      }
      if (req.method === 'GET' && url.pathname === '/api/usage') {
        const force = url.searchParams.has('force');
        let accounts = allAccounts();
        if (SHARE_MODE) accounts = accounts.filter((a) => !isLiveLogin(a)); // hide this PC's own logins
        const results = await Promise.all(accounts.map((a) => usageFor(a, force)));
        const memos = loadMemos();
        for (const r of results) {
          r.memo = memos[r.id] || '';
          r.hasSecret = false; // the shared version never hands tokens to the page // never expose copy affordance
        }
        return send(res, 200, { accounts: results, generatedAt: new Date().toISOString(), shareMode: SHARE_MODE, readOnly: READONLY });
      }
      if (req.method === 'GET' && url.pathname === '/api/accounts') {
        const cfg = loadConfig();
        return send(res, 200, { autoDetect: cfg.autoDetect, detected: detectAccounts().map(publicAccount), accounts: cfg.accounts.map(publicAccount) });
      }
      if (req.method === 'POST' && url.pathname === '/api/accounts') {
        const body = await readBody(req);
        if (!PROVIDERS[body.type]) return send(res, 400, { error: 'type이 올바르지 않습니다' });
        const allowed = ['type', 'label', 'credentialsPath', 'sessionToken', 'authPath', 'accessToken', 'accountId', 'adminKey', 'monthlyBudget', 'token', 'tokenPath', 'apiKey', 'keyPath', 'accountUuid', 'configPath', 'owner', 'monthlyCredits', 'refresh'];
        const acc = { id: crypto.randomUUID() };
        for (const k of allowed) if (body[k] !== undefined && body[k] !== '') acc[k] = typeof body[k] === 'string' ? body[k].trim() : body[k];
        const invalid = validateNewAccount(acc);
        if (invalid) return send(res, 400, { error: invalid });
        const cfg = loadConfig();
        cfg.accounts.push(acc);
        saveConfig(cfg);
        return send(res, 201, publicAccount(acc));
      }
      const del = url.pathname.match(/^\/api\/accounts\/([\w-]+)$/);
      if (req.method === 'DELETE' && del) {
        const cfg = loadConfig();
        const before = cfg.accounts.length;
        cfg.accounts = cfg.accounts.filter((a) => a.id !== del[1]);
        if (cfg.accounts.length === before) return send(res, 404, { error: '계정을 찾을 수 없습니다' });
        saveConfig(cfg);
        resultCache.delete(del[1]);
        return send(res, 200, { ok: true });
      }
      if (url.pathname === '/api/token') return send(res, 403, { error: '토큰 복사는 지원하지 않습니다' });
      if (req.method === 'POST' && url.pathname === '/api/token') {
        const body = await readBody(req);
        const acc = allAccounts().find((a) => a.id === body.id);
        if (!acc) return send(res, 404, { error: '계정을 찾을 수 없습니다' });
        const token = accountSecret(acc);
        if (!token) return send(res, 404, { error: '이 계정에는 복사할 토큰이 없습니다' });
        return send(res, 200, { token });
      }
      if (req.method === 'PUT' && url.pathname === '/api/memo') {
        const body = await readBody(req);
        if (!body.id || typeof body.id !== 'string') return send(res, 400, { error: 'id가 필요합니다' });
        const text = String(body.memo ?? '').slice(0, 2000);
        saveMemo(body.id, text);
        return send(res, 200, { ok: true, memo: text });
      }
      if (req.method === 'PUT' && url.pathname === '/api/settings') {
        const body = await readBody(req);
        const cfg = loadConfig();
        if (typeof body.autoDetect === 'boolean') cfg.autoDetect = body.autoDetect;
        saveConfig(cfg);
        return send(res, 200, { autoDetect: cfg.autoDetect });
      }
      return send(res, 404, { error: 'not found' });
    }

    if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = path.resolve(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file)) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
    return send(res, 200, I18N.forFile(file) ?? fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
  } catch (e) {
    return send(res, 500, { error: e.message });
  }
});

server.listen(PORT, HOST, () => {
  if (SHARE_MODE) {
    const nets = os.networkInterfaces();
    const lan = Object.values(nets).flat().find((n) => n && n.family === 'IPv4' && !n.internal);
    console.log(`AI 사용량 대시보드 [공유 모드 · 읽기 전용]: http://${lan ? lan.address : 'localhost'}:${PORT} (같은 네트워크에서 접속)`);
  } else {
    console.log(`AI 사용량 대시보드: http://localhost:${PORT}`);
  }
});
