// Several ChatGPT logins for the Codex CLI, picked automatically by remaining quota.
//
// The Codex CLI keeps its login in $CODEX_HOME/auth.json (default ~/.codex). Each extra account gets its
// own home, ~/.codex-accounts/<email>/, holding that account's auth.json. Everything else is shared with
// the main ~/.codex so the account is invisible to the user: sessions/ (and a few other folders) are
// junctions to the main home — `codex resume` finds a conversation whichever account started it — and
// config.toml is copied from the main home before each launch.
//
// Accounts are registered in the AI usage dashboard (type "codex", authPath), which reads each one's
// 5-hour / weekly usage, shown next to each login when you pick one. The main ~/.codex login is one of
// them too (no CODEX_HOME override). Used by server.js (codex terminals, "다른 계정" switch) and
// ccd.js (`ccd gpt --account`, `ccd codex add|ls|rm`). Only your own logins: switching happens on request.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const MAIN = path.join(os.homedir(), '.codex');
const ROOT = path.join(os.homedir(), '.codex-accounts');
const SHARED_DIRS = ['sessions', 'plugins', 'skills', 'prompts', 'memories', 'computer-use', 'code-review-plugin', 'packages'];
const SHARED_FILES = ['config.toml', 'AGENTS.md'];

const norm = (p) => path.resolve(String(p || '')).toLowerCase();
const isMain = (authPath) => norm(path.dirname(authPath)) === norm(MAIN);

function decodeJwt(t) { try { return JSON.parse(Buffer.from(String(t).split('.')[1], 'base64url').toString('utf8')); } catch { return null; } }
function emailOf(authPath) {
  try { const a = JSON.parse(fs.readFileSync(authPath, 'utf8')); return (decodeJwt(a.tokens?.id_token) || {}).email || null; } catch { return null; }
}

/** Codex accounts registered in the usage dashboard → [{id, label, authPath, home, main, email}] */
function accounts(usageDir) {
  let cfg; try { cfg = JSON.parse(fs.readFileSync(path.join(usageDir, 'accounts.json'), 'utf8')); } catch { cfg = { accounts: [] }; }
  const out = [];
  for (const a of cfg.accounts || []) {
    if (a.type !== 'codex' || !a.authPath) continue;
    const main = isMain(a.authPath);
    out.push({ id: a.id, label: a.label, authPath: a.authPath, home: main ? null : path.dirname(a.authPath), main, email: emailOf(a.authPath) });
  }
  if (!out.some((a) => a.main) && fs.existsSync(path.join(MAIN, 'auth.json'))) {
    out.unshift({ id: 'auto-codex', label: 'ChatGPT / Codex (이 PC)', authPath: path.join(MAIN, 'auth.json'), home: null, main: true, email: emailOf(path.join(MAIN, 'auth.json')) });
  }
  return out;
}

/** Make an account home look like the main one except for auth.json. Safe to call before every launch. */
function prepareHome(home) {
  fs.mkdirSync(home, { recursive: true });
  for (const d of SHARED_DIRS) {
    const src = path.join(MAIN, d), dst = path.join(home, d);
    if (!fs.existsSync(src)) continue;
    let st = null; try { st = fs.lstatSync(dst); } catch {}
    if (st) continue; // already a junction (or a real folder we leave alone)
    try { fs.symlinkSync(src, dst, 'junction'); } catch {}
  }
  for (const f of SHARED_FILES) {
    const src = path.join(MAIN, f);
    if (fs.existsSync(src)) try { fs.copyFileSync(src, path.join(home, f)); } catch {}
  }
}

/** env for a child codex process on this account ({} for the main login) */
function envFor(acc) {
  if (!acc || acc.main || !acc.home) return {};
  prepareHome(acc.home);
  return { CODEX_HOME: acc.home };
}

const meterPct = (u, re) => { const m = (u?.meters || []).find((x) => re.test(x.name)); return m ? m.usedPercent : null; };
/**
 * Rank accounts by headroom (the tighter of 5-hour and weekly).
 * usage = the usage dashboard's /api/usage reply. Returns [{...acc, fiveH, weekly, score, usable, limited, reset}] best first.
 */
function rank(list, usage) {
  const byId = new Map((usage?.accounts || []).map((a) => [a.id, a]));
  const autoMain = (usage?.accounts || []).find((a) => a.provider === 'ChatGPT' && a.id === 'auto-codex');
  return list.map((a) => {
    const u = byId.get(a.id) || (a.main ? autoMain : null);
    const fiveH = meterPct(u, /5시간/), weekly = meterPct(u, /주간/);
    const limited = !!(u?.notes || []).some((n) => /한도에 도달/.test(n));
    const known = !!u?.ok && (fiveH !== null || weekly !== null);
    const score = known ? Math.min(100 - (fiveH ?? 0), 100 - (weekly ?? 0)) : -1;
    const reset = (u?.meters || []).find((m) => /5시간/.test(m.name))?.resetsAt || null;
    return { ...a, email: a.email || u?.email || null, fiveH, weekly, score, usable: known && score > 0 && !limited, limited, reset, error: u?.ok === false ? u.error : null };
  }).sort((x, y) => (y.usable - x.usable) || (y.score - x.score));
}

/** run `codex login --device-auth` into a fresh home (console UI), then file it under the account's email */
function loginNew(codexExe) {
  fs.mkdirSync(ROOT, { recursive: true });
  const tmp = path.join(ROOT, `_new-${Date.now()}`);
  prepareHome(tmp);
  try { fs.rmSync(path.join(tmp, 'auth.json'), { force: true }); } catch {}
  try { execFileSync(codexExe, ['login', '--device-auth'], { stdio: 'inherit', env: { ...process.env, CODEX_HOME: tmp } }); }
  catch (e) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} throw new Error('로그인이 끝나지 않았습니다 (취소·시간 초과)'); }
  const auth = path.join(tmp, 'auth.json');
  const email = emailOf(auth);
  if (!email) throw new Error('로그인 정보(auth.json)를 찾지 못했습니다');
  const home = path.join(ROOT, email.replace(/[^\w.@-]/g, '_'));
  if (fs.existsSync(home)) { fs.copyFileSync(auth, path.join(home, 'auth.json')); fs.rmSync(tmp, { recursive: true, force: true }); }
  else fs.renameSync(tmp, home);
  prepareHome(home);
  return { email, home, authPath: path.join(home, 'auth.json') };
}

/** the Codex CLI: config path, $CODEX_EXE, the binary bundled with the Codex desktop app, else PATH (npm i -g @openai/codex) */
function codexExe(configured) {
  const cands = [configured, process.env.CODEX_EXE, path.join(MAIN, 'plugins', '.plugin-appserver', 'codex.exe')].filter(Boolean);
  return cands.find((f) => fs.existsSync(f)) || (process.platform === 'win32' ? 'codex.cmd' : 'codex');
}

const LIMIT_RE = /usage limit|hit your (usage )?limit|rate.?limit(ed)?|quota exceeded|429|too many requests|try again (at|in) /i;

module.exports = { MAIN, ROOT, accounts, prepareHome, envFor, rank, loginNew, emailOf, isMain, codexExe, LIMIT_RE };
