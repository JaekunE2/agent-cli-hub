'use strict';
// ccd commands of this plugin. ctx = the helpers ccd.js shares (see plugins.js).
const fs = require('fs');
const path = require('path');
module.exports = function cli(ctx) {
  const { api, die, flags, pos, DIR, BASE, PORT, token, usageDir, readTarget, overview, resolve, sessionIdOf, ago, termLabel, SELF_PID } = ctx;
  let { rest } = ctx;
  const { spawn } = require('child_process');
  return {
    commands: {
  // GX10 drive (3.3TB on the GX10, shared with the phone app): files go through the dashboard proxy
  // Delta Hub (a team's AI Control Hub, config delta.hub) through the hub's saved login (관제 → 🛰 Delta Hub)
  async delta() {
    const sub = pos[1] || 'ls';
    // ccd delta stage <dir...> [--node delta-gpu-w01,…|all]   local folders → the workers' own disks
    // ccd delta get <local path|/work/...> [<local dest>] [--node N]   download a result back
    // ccd delta where <local path>                             its path on a worker
    if (['stage', 'get', 'where', 'nodes'].includes(sub)) {
      const DS = require('../remote-gpu/delta-stage');
      const cfgAll = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8'));
      const srv = (cfgAll.gpu?.servers || []).find((x) => x.id === (flags.server || 'delta'));
      if (!srv?.slurm) die('no Slurm server "delta" in config.json');
      const all = srv.slurm.nodes || [];
      const pick = (v) => (!v || v === true || v === 'all' ? all : String(v).split(',').map((n) => all.find((a) => a === n || a.endsWith('-' + n)) || n));
      if (sub === 'nodes') return console.log(all.join('\n'));
      if (sub === 'where') return console.log(DS.stagedPath(srv, pos[2] || die('usage: ccd delta where <local path>')));
      if (sub === 'stage') {
        const dirs = pos.slice(2);
        if (!dirs.length) die('usage: ccd delta stage <dir...> [--node w01,w02|all] [--exclude a,b] [--dry]');
        const ex = String(flags.exclude || '').split(',').map((x) => x.trim()).filter(Boolean);
        let bad = 0;
        for (const node of pick(flags.node)) for (const d of dirs) {
          try { await DS.stageDir(srv, node, d, { exclude: ex, dry: !!flags.dry }); } catch (e) { bad++; console.error(`[stage] ${node}: ${e.message}`); }
        }
        if (bad) process.exitCode = 1;
        return;
      }
      // get
      const src = pos[2] || die('usage: ccd delta get <local path|/work/...> [<local dest>] [--node N]');
      const remote = src.startsWith('/') ? src : DS.stagedPath(srv, src);
      const dest = pos[3] ? path.resolve(pos[3]) : (src.startsWith('/') ? process.cwd() : path.dirname(path.resolve(src)));
      const nodes = pick(flags.node);
      if (nodes.length !== 1) die(`which node? add --node ${all.join('|')} (results stay on the node the job ran on)`);
      const out = await DS.fetchFrom(srv, nodes[0], remote, dest);
      return console.log(out);
    }
    const H = (p) => api('/api/delta/hub/' + p);
    const snap = async (sid) => H('snapshot?scope=selected&archived=1' + (sid ? `&session_id=${encodeURIComponent(sid)}` : ''));
    const findSession = (sn, q) => {
      const m = (sn.sessions || []).filter((x) => x.id.startsWith(q) || (x.title || '').includes(q));
      if (!m.length) die(`delta: no session matches "${q}" (ccd delta ls)`);
      if (m.length > 1) die(`delta: "${q}" matches ${m.length} sessions — use more of the id`);
      return m[0];
    };
    const convo = (events, all) => events.filter((e) => ['user', 'delta', 'assistant'].includes(e.kind) || (all && e.kind === 'system'))
      .reduce((out, e) => { const role = e.kind === 'delta' ? 'assistant' : e.kind; const last = out[out.length - 1]; if (last && last.role === role && role === 'assistant') last.text += e.text; else out.push({ role, text: e.text }); return out; }, []);
    if (sub === 'ls') {
      const sn = await snap();
      const by = new Map(); for (const x of sn.sessions || []) { if (!by.has(x.project_id)) by.set(x.project_id, []); by.get(x.project_id).push(x); }
      for (const p of sn.projects || []) {
        console.log(`📁 ${p.name}  (${p.path})  project=${p.id}`);
        for (const x of (by.get(p.id) || []).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))) console.log(`   ${x.id.slice(0, 8)}  ${String(x.state).padEnd(11)} ${x.profile_id || ''}  ${x.title || ''}`);
      }
      console.log(`runtimes: ${(sn.profiles || []).filter((p) => !/^demo-/.test(p.id)).map((p) => p.id).join(', ')}`);
      return;
    }
    if (sub === 'read' || sub === 'wait') {
      const sn = await snap(); const s = findSession(sn, pos[2] || die(`usage: ccd delta ${sub} <session id|title>`));
      let full = await snap(s.id);
      if (sub === 'wait') {
        const until = Date.now() + (Number(flags.timeout) || 1800) * 1000;
        while (['running', 'queued'].includes((full.sessions.find((x) => x.id === s.id) || {}).state) && Date.now() < until) { await new Promise((r) => setTimeout(r, 5000)); full = await snap(s.id); }
      }
      const st = (full.sessions.find((x) => x.id === s.id) || s).state;
      const turns = convo(full.events || [], flags.all);
      const show = sub === 'wait' || flags.last ? turns.slice(-1) : turns;
      console.log(`# ${s.title || s.id}  [${st}]  ${s.profile_id}\n`);
      for (const t of show) console.log(`${t.role === 'user' ? '▶ 요청' : t.role === 'system' ? '· 시스템' : '◀ 답변'}\n${t.text}\n`);
      return;
    }
    if (sub === 'send') {
      const sn = await snap(); const s = findSession(sn, pos[2] || die('usage: ccd delta send <session> "prompt"'));
      const prompt = pos.slice(3).join(' ') || die('usage: ccd delta send <session> "prompt"');
      const running = ['running', 'queued'].includes(s.state);
      const r = await api('/api/delta/hub/' + (running ? 'queueadd' : 'run'), { session_id: s.id, profile_id: s.profile_id, prompt, request_origin: { source: 'composer' }, attachment_ids: [] });
      if (r && r.error) die(`delta: ${r.error}`);
      console.log(`${running ? 'queued' : 'sent'} → ${s.id.slice(0, 8)} ${s.title || ''}   (ccd delta wait ${s.id.slice(0, 8)})`);
      return;
    }
    if (sub === 'new') {
      const sn = await snap();
      const q = pos[2] || die('usage: ccd delta new <project name|id> ["first prompt"] [--runtime claude-local|codex-local|mlx-local]');
      const proj = (sn.projects || []).find((p) => p.id === q || p.name === q || p.name.includes(q)) || die(`delta: no project "${q}"`);
      const profile_id = flags.runtime || 'claude-local';
      const r = await api('/api/delta/hub/sessions', { profile_id, project_id: proj.id });
      if (r && r.error) die(`delta: ${r.error}`);
      const sid = r.session_id || r.id || r.session?.id;
      const first = pos.slice(3).join(' ');
      if (first && sid) await api('/api/delta/hub/run', { session_id: sid, profile_id, prompt: first, request_origin: { source: 'composer' }, attachment_ids: [] });
      console.log(`new session ${sid || JSON.stringify(r).slice(0, 200)} in ${proj.name} (${profile_id})${first ? ' — first request sent' : ''}`);
      return;
    }
    if (sub === 'stop') {
      const sn = await snap(); const s = findSession(sn, pos[2] || die('usage: ccd delta stop <session>'));
      const r = await api('/api/delta/hub/stop', { session_id: s.id, operation_id: s.operation_id });
      if (r && r.error) die(`delta: ${r.error}`);
      return console.log(`stop requested: ${s.id.slice(0, 8)}`);
    }
    die('delta subcommands: ls | read <session> [--last] | send <session> "prompt" | wait <session> [--timeout s] | new <project> ["prompt"] [--runtime …] | stop <session>');
  },
    },
    hooks: {
      // ccd gpt: answer on a Codex session of the Delta Hub when every local ChatGPT login is at its limit
      async gptFallback(why, { prompt, cfg }) {
    // Delta Hub fallback: a Codex session on the team's hub (its own ChatGPT accounts) answers instead
    // when this PC's subscription hits its limit (or with --via hub). The hub cannot see local files,
    // so only the prompt text (with --file contents inlined) goes there; --image is not supported.
    {
      console.error(`[gpt] ${why} → asking a Codex session on the Delta Hub instead${flags.image ? ' (text only: --image is not sent there)' : ''}`);
      const proj = cfg.hubProject; // config gpt.hubProject: the Delta Hub project the fallback sessions go to
      if (!proj) die(`${why}; no Delta Hub fallback configured (config.json "gpt": {"hubProject": "<project id>"})`);
      const RULE = '[ccd gpt · 읽기 전용 요청] 파일을 만들거나 고치거나 명령을 실행하지 말고, 요청에 대한 답만 텍스트로 쓰세요.';
      // the hub takes at most 8,000 characters per message: a longer request goes in numbered parts
      // (each answered with a short receipt), then the question itself as the last message
      const MAX = 7600;
      const question = pos.slice(1).join(' ').trim();
      const msgs = [];
      if (RULE.length + prompt.length + 2 <= MAX) msgs.push(`${RULE}\n\n${prompt}`);
      else {
        // a short question is asked last on its own; a long one (review instructions + venue notes) stays
        // at the start of the material and the last message points back to it
        const shortQ = question && question.length <= MAX - 400 && prompt.startsWith(question);
        const body = shortQ ? prompt.slice(question.length).trim() : prompt;
        const parts = []; for (let i = 0; i < body.length; i += MAX - 200) parts.push(body.slice(i, i + MAX - 200));
        if (parts.length > (Number(cfg.hubMaxParts) || 60)) die(`${why}; the request is too long for the Delta Hub fallback (${parts.length} parts of 7,400 characters) — shorten it or pass only the relevant files`);
        parts.forEach((p, i) => msgs.push(`${i === 0 ? `${RULE}\n긴 자료를 ${parts.length}개로 나눠 보냅니다. 각 부분에는 "받음 (번호)/${parts.length}"라고만 답하고, 마지막 메시지의 요청을 기다리세요.\n\n` : ''}[자료 ${i + 1}/${parts.length}]\n${p}`));
        msgs.push(shortQ
          ? `[요청] 자료 1~${parts.length}을 모두 받았습니다. 그 전체를 바탕으로 다음 요청에 답하세요 (파일 수정·명령 실행 금지).\n\n${question}`
          : `[요청] 자료 1~${parts.length}을 모두 받았습니다. 자료 맨 앞(자료 1)에 있는 요청·지시를 그대로 따라, 자료 전체를 바탕으로 답하세요 (파일 수정·명령 실행 금지). 지시된 출력 형식(마지막 줄 형식 포함)을 정확히 지키세요.`);
        console.error(`[gpt] ${prompt.length.toLocaleString()} characters → ${parts.length} parts + the question`);
      }
      const s = await api('/api/delta/hub/sessions', { profile_id: 'codex-local', project_id: proj }).catch((e) => ({ error: e.message }));
      const sid = s && (s.session_id || s.id || s.session?.id);
      if (!sid) die(`Delta Hub session could not be created: ${s?.error || JSON.stringify(s).slice(0, 200)}`);
      const until = Date.now() + (Number(flags.timeout) || 3600) * 1000;
      let sn, st;
      // the hub runs one Codex job per member at a time: a second one ends "interrupted" before it starts.
      // Wait while another session in our projects is running (other research sessions use the hub too).
      const OURS = new Set([proj, ...(cfg.hubProjects || [])]); // config gpt.hubProjects: other projects whose runs share our quota
      const waitFree = async () => {
        for (let said = false; ; ) {
          const all = await api('/api/delta/hub/snapshot?scope=selected&archived=1').catch(() => null);
          const busy = (all?.sessions || []).filter((x) => x.id !== sid && OURS.has(x.project_id) && ['running', 'queued'].includes(x.state));
          if (!busy.length) return;
          if (!said) { console.error(`[gpt] another Delta Hub run of ours is busy (${busy.map((x) => x.id.slice(0, 8)).join(', ')}) — waiting for it`); said = true; }
          if (Date.now() > until) die('Delta Hub stayed busy until the timeout — try again later');
          await new Promise((ok) => setTimeout(ok, 15000));
        }
      };
      for (const [i, m] of msgs.entries()) {
        // a hub Codex run now and then ends "interrupted" right away: send the same message again (twice at most)
        for (let attempt = 1; ; attempt++) {
          await waitFree();
          const r = await api('/api/delta/hub/run', { session_id: sid, profile_id: 'codex-local', prompt: m, request_origin: { source: 'composer' }, attachment_ids: [] }).catch((e) => ({ error: e.message }));
          if (r && r.error) die(`Delta Hub run failed (message ${i + 1}/${msgs.length}): ${r.error}`);
          for (;;) {
            await new Promise((ok) => setTimeout(ok, 4000));
            sn = await api(`/api/delta/hub/snapshot?scope=selected&archived=1&session_id=${encodeURIComponent(sid)}`).catch(() => null);
            st = sn && (sn.sessions || []).find((x) => x.id === sid)?.state;
            if (st && !['running', 'queued'].includes(st)) break;
            if (Date.now() > until) die(`Delta Hub session ${sid.slice(0, 8)} still ${st || 'unknown'} after the timeout — read it later: ccd delta wait ${sid.slice(0, 8)}`);
          }
          if (st === 'completed' || st === 'idle') break;
          if (attempt >= 3) die(`Delta Hub session ${sid.slice(0, 8)} stopped (${st}) at message ${i + 1}/${msgs.length} after ${attempt} tries — ccd delta read ${sid.slice(0, 8)}`);
          console.error(`[gpt] hub run ended "${st}" at message ${i + 1}/${msgs.length} — retrying`);
          await new Promise((ok) => setTimeout(ok, 5000));
        }
      }
      const ev = (sn.events || []);
      const lastUser = ev.map((e) => e.kind).lastIndexOf('user');
      const answer = ev.slice(lastUser + 1).filter((e) => e.kind === 'delta' || e.kind === 'assistant').map((e) => e.text).join('').trim();
      if (!answer) die(`Delta Hub session ${sid.slice(0, 8)} ended (${st}) without an answer — ccd delta read ${sid.slice(0, 8)}`);
      console.log(answer);
      if (flags.verbose) console.error(`[gpt] answered by Delta Hub session ${sid.slice(0, 8)} (${st})`);
    };
      },
    },
  };
};
