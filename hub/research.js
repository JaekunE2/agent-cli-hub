// Autonomous research projects: API + autopilot watchdog.
// The Stop hook (research-harness/hooks/stop.js) keeps a director going turn to turn;
// this watchdog covers what a hook cannot: waking "waiting" projects, re-nudging an
// idle director (block cap hit, throttle, error), resuming a dead director (same
// session id), and parking on usage limits until the real reset time.
const fs = require('fs');
const path = require('path');
const P = require('../research-harness/lib/project');
const RG = require('../research-harness/lib/reviewgate');
const { serve: serveFile, kindOf } = require('./artifacts');

module.exports = function research(d) {
  const { terms, createTerm, liveSessions, helperCall, index, aiUsage, readTerm, sleep, SUBMIT_DELAY, termInfo, tokenAccounts, notify, switchCandidates, publicUrl } = d;
  const resumes = new Map(); // dir -> [timestamps]
  const lastNudge = new Map(); // dir -> ms
  const woke = new Map(); // dir -> ms of last wake-up
  const log = (dir, msg) => { try { fs.appendFileSync(path.join(dir, 'research', '.harness.log'), `${new Date().toISOString()} watchdog: ${msg}\n`); } catch {} };
  const hc = () => { try { return P.config(); } catch { return { autopilot: {}, budget: {} }; } };

  async function consoles() { return (await helperCall({ op: 'list' })).consoles || []; }
  // Where the director runs: prefer our own terminal, else a live session with its id.
  function locate(dir, st, cons) {
    const t = [...terms.values()].find((x) => x.research === dir && x.exited === null);
    const s = st.director_session_id ? liveSessions().find((x) => x.sessionId === st.director_session_id) : null;
    if (t) {
      const c = cons.find((x) => t.pid && x.pids.includes(t.pid));
      const ls = s || (c && liveSessions().find((x) => c.pids.includes(x.pid)));
      return { live: true, term: t, s: ls };
    }
    if (s) return { live: true, s, console: cons.find((x) => x.pids.includes(s.pid)) };
    return { live: false };
  }
  async function sendTo(loc, text) {
    if (loc.term) { loc.term.proc.write(text); await sleep(SUBMIT_DELAY); loc.term.proc.write('\r'); return true; }
    if (loc.console) {
      await helperCall({ op: 'send', pid: loc.console.id, text });
      await sleep(SUBMIT_DELAY + Math.min(6000, text.length * 6)); // long texts need time to land in a console
      await helperCall({ op: 'send', pid: loc.console.id, keys: ['enter'] });
      return true;
    }
    return false;
  }
  const ready = (t) => {
    const s = readTerm(t, 40).join('\n');
    return !/trust this folder|Do you trust/i.test(s) && /\? for shortcuts|bypass permissions|auto mode|accept edits|^\s*[>❯]\s*$/m.test(s);
  };

  function spawnDirector(dir, st, { resume, message }) {
    const cap = String(hc().autopilot?.stop_hook_block_cap ?? 200);
    const args = [...(resume && st.director_session_id ? ['--resume', st.director_session_id] : []), '--dangerously-skip-permissions'];
    const env = { RESEARCH_ROLE: 'director', CLAUDE_CODE_STOP_HOOK_BLOCK_CAP: cap };
    let account = null;
    if (st.director_account && st.director_account !== 'default' && tokenAccounts) {
      const acc = tokenAccounts().find((a) => a.id === st.director_account);
      if (acc) { try { env.CLAUDE_CODE_OAUTH_TOKEN = acc.token(); account = { id: acc.id, label: acc.label }; } catch {} }
    }
    const t = createTerm({ cwd: dir, cmd: 'claude.exe', args, title: `🔬 ${st.project}`, env, account, research: dir });
    t.research = dir;
    (async () => {
      let trusted = false;
      for (let i = 0; i < 90 && t.exited === null; i++) {
        await sleep(700);
        // The folder was scaffolded by the harness from its own template at the user's
        // request (dashboard "new research"), so its workspace-trust prompt is answered
        // here — only for harness projects (research/state.json exists), only once.
        if (!trusted && /trust this folder/i.test(readTerm(t, 40).join('\n')) && fs.existsSync(path.join(dir, 'research', 'state.json'))) {
          // The default is "No, exit". Only press Enter once the cursor is confirmed on
          // "Yes, I trust" — an arrow key sent before the menu takes input can land as a bare Esc.
          await sleep(1200);
          for (let k = 0; k < 6 && t.exited === null; k++) {
            const scr = readTerm(t, 40).join('\n');
            if (!/trust this folder/i.test(scr)) break;
            if (/❯\s*Yes, I trust/i.test(scr)) { t.proc.write('\r'); trusted = true; log(dir, 'accepted workspace trust for harness project folder'); break; }
            t.proc.write('\x1b[B'); await sleep(800);
          }
          if (!trusted) log(dir, 'could not confirm the trust choice; left the prompt for the user');
          trusted = true; // never retry blindly
          continue;
        }
        if (ready(t)) { await sleep(800); t.proc.write(message); await sleep(SUBMIT_DELAY); t.proc.write('\r'); log(dir, `director ${resume ? 'resumed' : 'started'} in t:${t.id}`); return; }
      }
      log(dir, `director t:${t.id} never became ready`);
    })();
    return t;
  }

  // The director runs on this PC's own login; read its 5h/weekly meters.
  async function localUsage(accountId) {
    const u = await aiUsage(false);
    const a = accountId && accountId !== 'default'
      ? (u.accounts || []).find((x) => x.id === accountId)
      : (u.accounts || []).find((x) => x.provider === 'Claude' && x.live && /Claude Code/.test(x.label));
    const m5 = a?.meters?.find((m) => /5시간/.test(m.name)), mw = a?.meters?.find((m) => /주간 \(전체/.test(m.name));
    return { fiveH: m5?.usedPercent ?? null, weekly: mw?.usedPercent ?? null, reset5h: m5?.resetsAt || null, resetW: mw?.resetsAt || null };
  }

  async function tick() {
    const projects = P.listProjects().filter((p) => ['running', 'waiting'].includes(p.state.status) && !fs.existsSync(path.join(p.dir, 'research', 'PAUSE')));
    if (!projects.length) return;
    const cons = await consoles();
    const cfg = hc().autopilot || {};
    let usage = null;
    for (const { dir, state: st } of projects) {
      try {
        const now = Date.now();
        const loc = locate(dir, st, cons);
        usage = await localUsage(st.director_account).catch(() => ({}));
        const hard = hc().budget?.usage_hard_limit ?? 95;
        const soft = hc().budget?.usage_soft_limit ?? 85;
        const overLimit = (usage.fiveH ?? 0) >= hard || (usage.weekly ?? 0) >= hard;
        // saving mode between soft and hard limit: the Stop hook slows the director down
        const pacing = !overLimit && ((usage.fiveH ?? 0) >= soft || (usage.weekly ?? 0) >= soft);
        if (!!st.pacing !== pacing) { P.updateState(dir, (s) => { s.pacing = pacing; }); log(dir, `pacing ${pacing ? 'ON' : 'off'} (5h ${usage.fiveH}% / 주간 ${usage.weekly}%)`); }
        const doc = loc.s && index.get(loc.s.sessionId);
        if (doc) await index.updateFile(doc.file);
        // right after a wake-up the old 429 turn is still the latest; give it time to answer
        const docLimited = doc?.limit && now - (woke.get(dir) || 0) > 10 * 60e3;
        if ((overLimit || docLimited || st.limited) && st.status !== 'waiting') {
          if (await autoSwitch(dir, st, loc, usage)) continue;
          const resetAt = (usage.weekly ?? 0) >= hard ? usage.resetW : usage.reset5h;
          const wake = resetAt && Date.parse(resetAt) > now ? new Date(Date.parse(resetAt) + 2 * 60e3).toISOString() : new Date(now + 30 * 60e3).toISOString();
          P.updateState(dir, (s) => { s.status = 'waiting'; s.wake_at = wake; s.wait_reason = `usage limit (5h ${usage.fiveH}% / 주간 ${usage.weekly}%)`; s.limited = true; });
          log(dir, `usage limit → waiting until ${wake}`);
          await limitAlert(dir, P.readState(dir), usage);
          continue;
        }
        if (st.status === 'waiting' && st.limited && !st.limit_notice_at) await limitAlert(dir, st, usage);
        if (st.status === 'waiting' && (st.limited || overLimit) && await autoSwitch(dir, st, loc, usage)) continue;
        if (st.status === 'waiting') {
          if (st.wake_at && Date.parse(st.wake_at) > now) {
            // refine a guessed limit wait with the real reset time
            if (st.limited && usage.reset5h && Date.parse(usage.reset5h) > now && !overLimit) {
              const w = new Date(Date.parse(usage.reset5h) + 2 * 60e3).toISOString();
              if (w !== st.wake_at) P.updateState(dir, (s) => { s.wake_at = w; });
            }
            continue;
          }
          if (overLimit) continue;
          P.updateState(dir, (s) => { s.status = 'running'; s.wake_at = null; s.limited = false; s.limit_notice_at = null; });
          woke.set(dir, now);
          const msg = `[AUTOPILOT] 대기 종료 (${st.wait_reason || '예약된 시각'}). research/state.json 확인 후 계속 진행하세요.`;
          if (loc.live && loc.s?.status !== 'busy') await sendTo(loc, msg);
          else if (!loc.live) resumeDirector(dir, st, msg);
          log(dir, `woke (${st.wait_reason})`);
          continue;
        }
        // running
        if (!loc.live) { resumeDirector(dir, st, '[AUTOPILOT] 디렉터 세션이 재개되었습니다. research/state.json·JOURNAL.md 확인 후 이어서 진행하세요.'); continue; }
        const s = loc.s;
        if (!s || s.status !== 'idle') continue;
        const idleMs = now - (s.updatedAt || now);
        const since = now - (lastNudge.get(dir) || 0);
        if (idleMs > (cfg.idle_nudge_min ?? 4) * 60e3 && since > (cfg.idle_nudge_min ?? 4) * 60e3) {
          lastNudge.set(dir, now);
          await sendTo(loc, '[AUTOPILOT] 계속 진행하세요. (research/state.json의 next_action / PLAN.md 다음 항목)');
          log(dir, `nudged idle director (${Math.round(idleMs / 60e3)}m idle)`);
        }
      } catch (e) { log(dir, `tick error: ${e.message}`); }
    }
  }
  // A director whose Claude account is at the usage limit used to sleep until the reset (a weekly limit = days).
  // Instead: pick the account with the most headroom (both 5 h and weekly under the soft limit), close the
  // director cleanly (/exit — the transcript is on disk), and resume the same conversation under that account.
  // Opt-in: harness config autopilot.auto_switch_account = true (your own accounts only). At most every 10 min per project.
  const switchTried = new Map();
  async function autoSwitch(dir, st, loc, usage) {
    if (hc().autopilot?.auto_switch_account !== true || !switchCandidates) return false;
    const now = Date.now();
    if (now - (switchTried.get(dir) || 0) < 10 * 60e3) return false;
    switchTried.set(dir, now);
    const soft = hc().budget?.usage_soft_limit ?? 85;
    let cands = [];
    try { cands = (await switchCandidates(st.director_account || 'default')).candidates || []; } catch { return false; }
    const pick = cands.filter((c) => c.usable && !c.current && (c.fiveH ?? 100) < soft && (c.weekly ?? 100) < soft)
      .sort((a, b) => b.score - a.score)[0];
    if (!pick) { log(dir, `usage limit (5h ${usage.fiveH}% / 주간 ${usage.weekly}%): no account with headroom → wait for the reset`); return false; }
    // close the running director; never two processes on one session
    if (loc.live) {
      if (loc.s?.status === 'busy' && !(st.limited || st.status === 'waiting')) return false; // mid-turn and not blocked: next tick
      const pid = loc.s?.pid;
      const gone = () => (loc.term ? loc.term.exited !== null : true) && (!pid || !(() => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } })());
      if (loc.term) {
        loc.term.proc.write('\x1b'); await sleep(1000);
        loc.term.proc.write('/exit'); await sleep(SUBMIT_DELAY); loc.term.proc.write('\r');
        for (let i = 0; i < 16 && !gone(); i++) await sleep(500);
        if (!gone()) { try { loc.term.proc.kill(); } catch {} await sleep(2000); }
      } else if (loc.console) {
        await helperCall({ op: 'send', pid: loc.console.id, keys: ['esc'] }); await sleep(1000);
        await helperCall({ op: 'send', pid: loc.console.id, text: '/exit' }); await sleep(SUBMIT_DELAY);
        await helperCall({ op: 'send', pid: loc.console.id, keys: ['enter'] });
        for (let i = 0; i < 30 && !gone(); i++) await sleep(500);
      }
      if (!gone()) { log(dir, `auto-switch: the director did not exit — staying on the current account`); return false; }
    }
    const from = st.director_account ? 'token ' + st.director_account.slice(0, 8) : '이 PC 로그인';
    const nst = P.updateState(dir, (s) => {
      s.director_account = pick.id === 'default' ? null : pick.id;
      s.status = 'running'; s.wake_at = null; s.limited = false; s.limit_notice_at = null; s.wait_reason = '';
    });
    log(dir, `auto-switch account (5h ${usage.fiveH}% / 주간 ${usage.weekly}%): ${from} → ${pick.label} (5h ${pick.fiveH}% / 주간 ${pick.weekly}%)`);
    resumeDirector(dir, nst, `[AUTOPILOT] 사용 한도에 걸린 계정(${from}) 대신 ${pick.label} 계정으로 자동 전환해 재개했습니다. research/INBOX.md와 state.json 확인 후 이어서 진행하세요.`);
    return true;
  }

  // One phone alert per limit episode, with the account that has most headroom and a
  // link that opens the dashboard's switch dialog for this director (the user decides).
  // Off by default (user asked not to get these on the Telegram bot); research-harness config.json "limitAlert": true turns it back on.
  async function limitAlert(dir, st, usage) {
    if (hc().limitAlert !== true) return;
    if (!notify || st.limit_notice_at) return;
    P.updateState(dir, (s) => { s.limit_notice_at = new Date().toISOString(); });
    let best = null;
    try { best = ((await switchCandidates(st.director_account || 'default')).candidates || []).find((c) => c.best); } catch {}
    const base = (publicUrl && publicUrl()) || 'http://127.0.0.1:7777/';
    const lines = [
      `🔬 연구 디렉터 사용 한도 도달 — ${st.project}`,
      `현재 계정: ${st.director_account ? 'token ' + st.director_account.slice(0, 8) : '이 PC 로그인'} (5h ${usage.fiveH ?? '?'}% / 주간 ${usage.weekly ?? '?'}%)`,
      `대기 후 자동 재개: ${st.wake_at ? new Date(st.wake_at).toLocaleString('ko-KR') : '리셋 시각'}`,
      best ? `가장 여유 있는 계정: ${best.label} (5h ${best.fiveH}% / 주간 ${best.weekly}%)` : '전환할 여유 계정 없음',
      best ? '전환하려면 아래 버튼 → 대시보드에서 "전환"을 누르세요 (직접 선택).' : '',
    ].filter(Boolean).join('\n');
    const r = await notify(lines, best && st.director_session_id ? [['⇄ 계정 전환 열기', `${base}?open=switch:${st.director_session_id}`]] : []).catch((e) => ({ ok: false, error: e.message }));
    log(dir, `limit alert sent: ${r.ok ? 'ok' : r.error || 'failed'}`);
  }
  function resumeDirector(dir, st, msg) {
    const now = Date.now();
    const list = (resumes.get(dir) || []).filter((t) => now - t < 3600e3);
    if (list.length >= (hc().autopilot?.max_resumes_per_hour ?? 3)) {
      P.updateState(dir, (s) => { s.status = 'blocked'; s.blocked_reason = '디렉터가 1시간에 여러 번 종료됨 — 확인 필요'; });
      log(dir, 'too many resumes → blocked');
      return null;
    }
    list.push(now); resumes.set(dir, list);
    return spawnDirector(dir, st, { resume: !!st.director_session_id, message: msg });
  }

  let timer = null;
  function start() { if (!timer) timer = setInterval(() => tick().catch(() => {}), 60e3); }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  // ---------- API ----------
  const tailFile = (f, n) => { try { return fs.readFileSync(f, 'utf8').trimEnd().split('\n').slice(-n).join('\n'); } catch { return ''; } };
  const headFile = (f, n) => { try { return fs.readFileSync(f, 'utf8').split('\n').slice(0, n).join('\n'); } catch { return ''; } };
  // Research artifacts worth showing (newest first): docs, LaTeX, results, figures, videos, papers.
  const OUT_EXT = /\.(md|tex|bib|json|py|yaml|yml|csv|txt|png|jpe?g|gif|webp|svg|pdf|sh|ps1|mp4|webm|mov|html?|ply|glb|obj|docx|xlsx|pptx)$/i;
  const OUT_SKIP = /^(\.git|\.claude|node_modules|__pycache__|checkpoints|data|wandb|\.venv)$/;
  function listOutputs(dir) {
    const out = [];
    const walk = (d, depth) => {
      let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (OUT_SKIP.test(e.name)) continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) { if (depth < 4) walk(p, depth + 1); continue; }
        if (!OUT_EXT.test(e.name) || /state\.json$|\.harness\.log$/.test(e.name)) continue;
        try {
          const st = fs.statSync(p);
          out.push({ path: path.relative(dir, p).replace(/\\/g, '/'), name: e.name, ext: path.extname(e.name).slice(1).toLowerCase(), kind: kindOf(e.name), size: st.size, mtime: st.mtimeMs });
        } catch {}
      }
    };
    walk(dir, 0);
    // viewable results (figures, videos, PDFs, docs) are capped separately so a flood of
    // result json/logs cannot push them out of the list
    out.sort((a, b) => b.mtime - a.mtime);
    const rich = (f) => !['text', 'file'].includes(f.kind) || /^(docx|xlsx|pptx|ply|glb|obj)$/.test(f.ext);
    return [...out.filter(rich).slice(0, 300), ...out.filter((f) => !rich(f)).slice(0, 300)].sort((a, b) => b.mtime - a.mtime);
  }
  const bySlug = (slug) => P.listProjects().find((p) => p.state.slug === slug || path.basename(p.dir) === slug);

  async function summary(p, cons) {
    const st = p.state;
    const loc = locate(p.dir, st, cons);
    const unreadQ = (tailFile(path.join(p.dir, 'research', 'QUESTIONS.md'), 400).match(/^## /gm) || []).length;
    return {
      slug: st.slug || path.basename(p.dir), name: st.project, dir: p.dir, status: fs.existsSync(path.join(p.dir, 'research', 'PAUSE')) ? 'paused' : st.status,
      phase: st.phase, iteration: st.iteration, next_action: st.next_action, wake_at: st.wake_at, wait_reason: st.wait_reason, blocked_reason: st.blocked_reason,
      updated_at: st.updated_at, gates: st.gates, workers: st.workers || [], questions: unreadQ, goal: st.config?.goal || 'P9_review',
      result: st.result || null, result_summary: st.result_summary || null, lineage: st.lineage || null, children: st.children || [],
      // P9 review loop progress (rounds, latest verdict, blind benchmark rank, what is still missing)
      review: (st.phase === 'P9_review' || fs.existsSync(path.join(p.dir, 'research', 'reviews'))) && RG.applies(st) ? (() => { try { const g = RG.evaluate(p.dir, st); return { rounds: g.rounds, max: g.cfg.max_review_rounds, recommendation: g.recommendation, min: g.cfg.min_recommendation, bench: g.bench, maxRank: g.cfg.benchmark_max_rank, passed: g.passed, reasons: g.reasons, stalled: g.stalled }; } catch { return null; } })() : null,
      director: loc.live ? { term: loc.term?.id || null, console: loc.console?.id || null, busy: loc.s?.status === 'busy', sessionId: loc.s?.sessionId || st.director_session_id } : null,
    };
  }

  async function handle(p, url, req, body, send, res) {
    if (p === '/api/research') {
      const cons = await consoles();
      return send(200, { projects: await Promise.all(P.listProjects().map((x) => summary(x, cons))), root: hc().projects_root });
    }
    if (p === '/api/research/detail') {
      const pr = bySlug(url.searchParams.get('slug'));
      if (!pr) return send(404, { error: 'no such project' });
      const r = path.join(pr.dir, 'research');
      return send(200, {
        ...(await summary(pr, await consoles())),
        created_at: pr.state.created_at, config: pr.state.config || {}, phases: P.PHASES,
        brief: headFile(path.join(r, 'BRIEF.md'), 120), report: tailFile(path.join(r, 'REPORT.md'), 300), journal: tailFile(path.join(r, 'JOURNAL.md'), 200),
        plan: headFile(path.join(r, 'PLAN.md'), 400), questions: tailFile(path.join(r, 'QUESTIONS.md'), 80), inbox: tailFile(path.join(r, 'INBOX.md'), 40),
        decisions: tailFile(path.join(r, 'DECISIONS.md'), 80), failed: tailFile(path.join(r, 'FAILED.md'), 60), final: headFile(path.join(r, 'FINAL.md'), 200),
        harnessLog: tailFile(path.join(r, '.harness.log'), 20), outputs: listOutputs(pr.dir),
      });
    }
    // raw bytes for the viewer (video range requests, PDF, images); only output-type files inside the project
    if (p === '/api/research/raw') {
      const pr = bySlug(url.searchParams.get('slug'));
      if (!pr || !res) return send(404, { error: 'no such project' });
      const rel = String(url.searchParams.get('path') || '');
      const abs = path.resolve(pr.dir, rel);
      const segs = path.relative(pr.dir, abs).split(/[\\/]/);
      if (!abs.startsWith(path.resolve(pr.dir) + path.sep) || segs.some((s) => OUT_SKIP.test(s)) || !OUT_EXT.test(abs)) return send(403, { error: '연구 산출물만 열 수 있습니다' });
      return serveFile(req, res, abs);
    }
    if (p === '/api/research/file') {
      const pr = bySlug(url.searchParams.get('slug'));
      if (!pr) return send(404, { error: 'no such project' });
      const rel = String(url.searchParams.get('path') || '');
      const abs = path.resolve(pr.dir, rel);
      if (!abs.startsWith(path.resolve(pr.dir) + path.sep) || /\.git[\\/]|\.claude[\\/]/.test(rel)) return send(400, { error: 'bad path' });
      let st; try { st = fs.statSync(abs); } catch { return send(404, { error: 'not found' }); }
      if (!st.isFile() || st.size > 800_000) return send(400, { error: '파일이 너무 크거나 파일이 아닙니다' });
      return send(200, { path: rel, size: st.size, mtime: st.mtimeMs, text: fs.readFileSync(abs, 'utf8') });
    }
    if (p === '/api/research/account' && req.method === 'POST') {
      const b = await body();
      const pr = bySlug(b.slug);
      if (!pr) return send(404, { error: 'no such project' });
      P.updateState(pr.dir, (s) => { s.director_account = b.account && b.account !== 'default' ? b.account : null; });
      return send(200, { ok: true, account: b.account || 'default' });
    }
    if (p === '/api/research/goal' && req.method === 'POST') {
      const b = await body();
      const pr = bySlug(b.slug);
      if (!pr || !P.PHASES.includes(b.goal)) return send(400, { error: 'slug/goal' });
      P.updateState(pr.dir, (s) => { s.config = s.config || {}; s.config.goal = b.goal; });
      P.appendInbox(pr.dir, `[설정 변경] 목표 지점이 ${b.goal}로 바뀌었습니다. 이 단계 게이트를 통과하면 done으로 마무리하세요.`, '대시보드');
      return send(200, { ok: true });
    }
    if (p === '/api/research/folder' && req.method === 'POST') {
      const b = await body();
      const pr = bySlug(b.slug);
      if (!pr) return send(404, { error: 'no such project' });
      require('child_process').spawn('explorer.exe', [pr.dir], { detached: true, stdio: 'ignore' }).unref();
      return send(200, { ok: true });
    }
    if (p === '/api/research/new' && req.method === 'POST') {
      const b = await body();
      if (!b.name || !b.direction) return send(400, { error: '프로젝트 이름과 연구 방향이 필요합니다' });
      let pr;
      // tests may use another root, but only inside the folder that holds the projects root
      const base = path.dirname(P.config().projects_root).toLowerCase() + path.sep;
      const root = b.root && path.resolve(b.root).toLowerCase().startsWith(base) ? b.root : undefined;
      try { pr = P.createProject({ name: b.name, direction: b.direction, venue: b.venue, approvalGates: b.approvalGates || [], goal: b.goal, root, kind: b.kind, parents: b.parents || [] }); } catch (e) { return send(400, { error: e.message }); }
      const kick = pr.state.lineage?.kind === 'derived' ? ' 이 프로젝트는 파생 연구입니다 — BRIEF.md의 "기반 연구"를 먼저 읽으세요.'
        : pr.state.lineage?.kind === 'synthesis' ? ' 이 프로젝트는 여러 연구를 분석하는 종합 논문입니다 — BRIEF.md의 "기반 연구들"과 CLAUDE.md의 Project types를 먼저 읽으세요.' : '';
      const t = spawnDirector(pr.dir, pr.state, { resume: false,
        message: `[KICKOFF] 자율 연구를 시작합니다. CLAUDE.md(운영 매뉴얼)와 research/BRIEF.md를 읽고 P1부터 진행하세요.${kick} 사용자 입력을 기다리지 말고 계속 진행합니다.` });
      return send(200, { ok: true, slug: pr.slug, dir: pr.dir, term: termInfo(t) });
    }
    if (p === '/api/research/submit' && req.method === 'POST') {
      const b = await body();
      const pr = bySlug(b.slug);
      if (!pr) return send(404, { error: 'no such project' });
      if (!pr.state.gates?.P9_review?.passed && pr.state.phase !== 'P9_review' && pr.state.status !== 'done') return send(400, { error: '최종 리뷰(P9)까지 끝난 연구만 투고 준비로 넘어갈 수 있습니다' });
      try { fs.unlinkSync(path.join(pr.dir, 'research', 'PAUSE')); } catch {}
      const st = P.updateState(pr.dir, (s) => { s.config = s.config || {}; s.config.goal = 'P10_submission'; s.status = 'running'; s.phase = 'P10_submission'; s.next_action = '투고 패키지 준비 (P10)'; s.wake_at = null; s.blocked_reason = null; });
      const msg = '[투고 준비 — 사용자 선택] 목표가 P10_submission으로 바뀌었습니다. research/submission/에 투고 패키지를 준비하세요: '
        + '학회·저널 형식 재확인(템플릿·쪽수·이중맹검 익명화·참고문헌 형식), 컴파일된 PDF, 보충자료, 코드·데이터 공개 문구, 커버레터, (저널이 요구하면) highlights·graphical abstract, '
        + '저자·사사 정보는 사용자가 채울 자리표시로(이름·ORCID·과제번호 추측 금지), SUBMIT_CHECKLIST.md(요구사항→파일→✓). '
        + '제출·업로드·가입·메일 발송은 절대 하지 말 것 — 제출은 사용자가 합니다. 체크리스트가 모두 ✓이고 PDF가 컴파일되면 done.';
      P.appendInbox(pr.dir, msg, '대시보드');
      const loc = locate(pr.dir, st, await consoles());
      if (loc.live) { if (loc.s?.status !== 'busy') await sendTo(loc, msg); } else resumeDirector(pr.dir, st, msg);
      return send(200, { ok: true });
    }
    if (p === '/api/research/control' && req.method === 'POST') {
      const b = await body();
      const pr = bySlug(b.slug);
      if (!pr) return send(404, { error: 'no such project' });
      const pause = path.join(pr.dir, 'research', 'PAUSE');
      if (b.action === 'pause') {
        fs.writeFileSync(pause, `paused from dashboard ${new Date().toISOString()}\n`);
        P.updateState(pr.dir, (s) => { s.status = 'paused'; });
        return send(200, { ok: true });
      }
      if (b.action === 'resume') {
        try { fs.unlinkSync(pause); } catch {}
        const st = P.updateState(pr.dir, (s) => { s.status = 'running'; s.blocked_reason = null; s.wake_at = null; s.limited = false; if (s.autopilot) s.autopilot.noProgress = 0; });
        const loc = locate(pr.dir, st, await consoles());
        const msg = '[AUTOPILOT] 사용자가 자율 진행을 재개했습니다. research/INBOX.md와 state.json 확인 후 계속 진행하세요.';
        if (loc.live) { if (loc.s?.status !== 'busy') await sendTo(loc, msg); }
        else resumeDirector(pr.dir, st, msg);
        return send(200, { ok: true });
      }
      return send(400, { error: 'action must be pause|resume' });
    }
    if (p === '/api/research/msg' && req.method === 'POST') {
      const b = await body();
      const pr = bySlug(b.slug);
      if (!pr || !b.text?.trim()) return send(400, { error: 'slug and text required' });
      P.appendInbox(pr.dir, b.text);
      const loc = locate(pr.dir, pr.state, await consoles());
      let delivered = false;
      if (loc.live && loc.s?.status !== 'busy') delivered = await sendTo(loc, `[사용자 메시지] ${b.text.trim().replace(/\s*\n\s*/g, ' / ')} (INBOX.md에도 기록됨 — 처리 후 (read) 표시)`);
      return send(200, { ok: true, delivered, queued: !delivered });
    }
    if (p === '/api/research/open' && req.method === 'POST') {
      const b = await body();
      const pr = bySlug(b.slug);
      if (!pr) return send(404, { error: 'no such project' });
      const loc = locate(pr.dir, pr.state, await consoles());
      if (loc.term) return send(200, { term: loc.term.id });
      if (loc.console) return send(200, { console: loc.console.id });
      const t = resumeDirector(pr.dir, pr.state, '[AUTOPILOT] 디렉터 세션이 재개되었습니다. state.json 확인 후 계속 진행하세요.');
      return send(200, t ? { term: t.id } : { error: '재개 한도 초과 — 잠시 후' });
    }
    return false;
  }

  return { start, stop, tick, handle };
};
