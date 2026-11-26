'use strict';
// ccd commands of this plugin. ctx = the helpers ccd.js shares (see plugins.js).
const fs = require('fs');
const path = require('path');
module.exports = function cli(ctx) {
  const { api, die, flags, pos, DIR, BASE, PORT, token, usageDir, readTarget, overview, resolve, sessionIdOf, ago, termLabel, SELF_PID } = ctx;
  let { rest } = ctx;
  const { spawn } = require('child_process');
  // replaces the core `ccd gpt`: tries every ChatGPT login (ccd codex add) by remaining quota, the next one on a
  // limit error, then a plugin's gptFallback hook (--via hub forces it, --via local never uses it)
  return {
    commands: {
  // ChatGPT (GPT models) through the Codex CLI logged in with the user's ChatGPT subscription.
  // Read-only sandbox: it may read files in --cd (default: current folder) but never changes anything.
  async gpt() {
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8')).gpt || {}; } catch {}
    const exe = require('./codex-accounts').codexExe(cfg.codex);
    let prompt = pos.slice(1).join(' ');
    if (flags.file) for (const f of String(flags.file).split(',')) prompt += `\n\n--- ${f.trim()} ---\n${fs.readFileSync(f.trim(), 'utf8')}`;
    if (!process.stdin.isTTY) { const chunks = []; for await (const c of process.stdin) chunks.push(c); const s = Buffer.concat(chunks).toString('utf8'); if (s.trim()) prompt += `\n\n${s}`; }
    if (!prompt.trim()) die('usage: ccd gpt "prompt" [--file a,b] [--image x.png] [--model M] [--cd DIR] [--account EMAIL] [--via hub|local]   (stdin is appended; read-only)');
    // --via hub / every login at its limit: a plugin's gptFallback hook may answer instead (e.g. delta-hub)
    const viaHub = async (why) => {
      const h = ctx.hook('gptFallback');
      if (!h) die(`${why}; no gpt fallback plugin is enabled`);
      return h(why, { prompt, cfg });
    };
    if (flags.via === 'hub') return viaHub('--via hub');
    const out = path.join(require('os').tmpdir(), `ccd-gpt-${process.pid}.txt`);
    const args = ['exec', '--skip-git-repo-check', '--ephemeral', '--color', 'never', '-s', 'read-only', '-C', path.resolve(String(flags.cd || '.')), '-o', out,
      ...(flags.model || cfg.model ? ['-m', String(flags.model || cfg.model)] : []),
      ...(flags.image ? String(flags.image).split(',').flatMap((f) => ['-i', f.trim()]) : []), '-'];
    const { spawn } = require('child_process');
    // several ChatGPT logins (ccd codex add): try them by remaining quota, the next one on a limit error,
    // and only then the Delta Hub. --account <email|id> pins one.
    const CA = require('./codex-accounts');
    let order = CA.accounts(usageDir());
    const usage = order.length > 1 ? await Promise.race([api('/api/usage').catch(() => null), new Promise((r) => setTimeout(() => r(null), 20000))]) : null;
    if (usage?.accounts) order = CA.rank(order, usage);
    if (flags.account) { const w = String(flags.account).toLowerCase(); order = order.filter((a) => [a.id, a.email, a.label].some((x) => String(x || '').toLowerCase() === w)); if (!order.length) die(`no Codex account "${flags.account}" (ccd codex ls)`); }
    const known = order.filter((a) => !a.limited);
    if (known.length) order = known; // skip accounts the usage dashboard already reports at their limit
    let errText = '', answer = '', code = 1, limitLine = '';
    for (const acc of order.length ? order : [{ main: true, label: 'this PC' }]) {
      errText = ''; answer = '';
      code = await new Promise((res) => {
        const c = spawn(exe, args, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true, env: { ...process.env, ...CA.envFor(acc) } });
        c.stderr.on('data', (d) => { errText += d; if (flags.verbose) process.stderr.write(d); });
        c.on('error', (e) => { console.error(`codex not found (${exe}): ${e.message} — set config.json "gpt": {"codex": "<path to codex.exe>"}`); res(127); });
        c.stdin.end(prompt);
        c.on('exit', (x) => res(x ?? 1));
      });
      try { answer = fs.readFileSync(out, 'utf8'); fs.unlinkSync(out); } catch {}
      if (answer.trim() && code === 0) { if (flags.verbose && order.length > 1) console.error(`[gpt] answered on ${acc.email || acc.label}`); return console.log(answer.trim()); }
      if (!CA.LIMIT_RE.test(errText + answer)) break;
      limitLine = (errText.split('\n').find((l) => /limit|quota|429|try again/i.test(l)) || 'usage limit').trim();
      console.error(`[gpt] ${acc.email || acc.label} is at its limit${order.length > 1 ? ' → next account' : ''}`);
    }
    const limited = !!limitLine && CA.LIMIT_RE.test(errText + answer);
    if (limited && flags.via !== 'local' && cfg.hubFallback !== false) {
      return viaHub(`all ${order.length || 1} ChatGPT account(s) on this PC are at their limit (${limitLine.slice(0, 160)})`);
    }
    if (answer.trim()) console.log(answer.trim());
    if (code !== 0) die(`codex exited ${code}${answer ? '' : ` (${(errText.trim().split('\n').pop() || 'not logged in? run: codex login').slice(0, 200)} — --verbose for details)`}`);
  },
    },
  };
};
