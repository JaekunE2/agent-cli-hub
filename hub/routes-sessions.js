'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { resolveTaskConfig, buildTaskHarnessPrompt } = require('./project-harness');
const { codexHistorySearchActive } = require('./immediate-send');

const OV_TTL = 2500;

/** Create transcript, overview, search, console/terminal interaction, and launch routes. */
function createSessionRoutes(hub) {
  const {
    baseDir, port, config, buildId, claudeDir, index, projects, accountPrefs, conversationBranches,
    sessionDisplayTitle, branchBackupDir, forkClaudeJsonlAt, editClaudeJsonlAt, editCodexJsonlAt,
    writeBranchContextFile, validSessionId, cleanModelEffort, cliModelEffortArgs, fingerprint,
    PTY_KEYS, dispatchImmediatePrompt, AGY_ALTM_RE, stripAnsi,
  } = hub;

  const transcriptIndex = new Map();
  let ovSnap = null, ovAt = 0, ovBuilding = null;
  let diskLow = null;

  const overviewStale = () => { ovAt = 0; };

  function checkDisk() {
    try {
      const f = fs.statfsSync('C:/'); const free = f.bavail * f.bsize;
      const low = free < (config.diskWarnGB || 3) * 2 ** 30;
      if (low && !diskLow) console.error(`[disk] C: low: ${(free / 2 ** 30).toFixed(2)} GB free`);
      diskLow = low ? { drive: 'C:', freeGB: Math.round(free / 2 ** 30 * 100) / 100 } : null;
    } catch {}
  }
  checkDisk(); setInterval(checkDisk, 60_000).unref?.();

  function liveSessions() {
    const dir = path.join(claudeDir, 'sessions');
    const out = [];
    for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      if (!/^\d+\.json$/.test(f)) continue;
      try {
        const s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (!hub.pidAlive(s.pid)) continue;
        out.push({ pid: s.pid, sessionId: s.sessionId, cwd: s.cwd, name: s.name, status: s.status, kind: s.kind, entrypoint: s.entrypoint || null, startedAt: s.startedAt, updatedAt: s.statusUpdatedAt || s.updatedAt, version: s.version });
      } catch {}
    }
    return out;
  }

  function findTranscript(sessionId) {
    const hit = transcriptIndex.get(sessionId);
    if (hit && fs.existsSync(hit)) return hit;
    const root = path.join(claudeDir, 'projects');
    for (const d of fs.existsSync(root) ? fs.readdirSync(root) : []) {
      const p = path.join(root, d, sessionId + '.jsonl');
      if (fs.existsSync(p)) { transcriptIndex.set(sessionId, p); return p; }
    }
    return null;
  }

  function readTail(file, bytes) {
    const st = fs.statSync(file);
    const start = Math.max(0, st.size - bytes);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(st.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    let s = buf.toString('utf8');
    if (start > 0) s = s.slice(s.indexOf('\n') + 1);
    return s;
  }

  function firstLines(file, bytes) {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    fs.closeSync(fd);
    return buf.subarray(0, n).toString('utf8').split('\n').slice(0, -1);
  }

  function textOf(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.map((c) => {
      if (c.type === 'text') return c.text;
      if (c.type === 'tool_use') {
        const inp = c.input || {};
        const hint = inp.command || inp.file_path || inp.pattern || inp.description || inp.url || '';
        return `⚙ ${c.name}${hint ? ': ' + String(hint).slice(0, 160) : ''}`;
      }
      return null;
    }).filter(Boolean).join('\n');
  }

  function transcript(sessionId, maxMsgs = 80) {
    const file = findTranscript(sessionId);
    if (!file) return { messages: [], error: 'transcript not found' };
    const msgs = [];
    let title = null;
    for (const line of readTail(file, 1_500_000).split('\n')) {
      if (!line) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (e.type === 'custom-title' || e.type === 'summary') title = e.customTitle || e.summary || title;
      if (e.type !== 'user' && e.type !== 'assistant') continue;
      if (e.isMeta || e.isSidechain) continue;
      const text = textOf(e.message?.content);
      if (!text || /^<(command|local-command|system-reminder)/.test(text.trim())) continue;
      msgs.push({ role: e.type, text: text.slice(0, 4000), ts: e.timestamp });
    }
    const sliced = msgs.slice(-maxMsgs);
    const base = Math.max(0, msgs.length - sliced.length);
    const edits = conversationBranches.getMsgEdits(sessionId);
    const patched = sliced.map((m, i) => {
      const ov = edits[String(base + i)];
      return ov ? { ...m, text: String(ov.text || '').slice(0, 4000), edited: true } : m;
    });
    return {
      file, title: conversationBranches.getTitle(sessionId) || title, messages: patched, total: msgs.length, base, size: fs.statSync(file).size,
      rev: conversationBranches.rev(), lineage: conversationBranches.lineageFor(sessionId, (id) => sessionDisplayTitle(id, index.get(id))),
      capabilities: { canNativeFork: true, canRewindEdit: true, canEditSource: true },
    };
  }

  function recentSessions(limit = 40) {
    const root = path.join(claudeDir, 'projects');
    const files = [];
    for (const d of fs.existsSync(root) ? fs.readdirSync(root) : []) {
      const dir = path.join(root, d);
      let ents; try { ents = fs.readdirSync(dir); } catch { continue; }
      for (const f of ents) {
        if (!f.endsWith('.jsonl')) continue;
        const p = path.join(dir, f);
        try { files.push({ p, mtime: fs.statSync(p).mtimeMs, sessionId: f.slice(0, -6) }); } catch {}
      }
    }
    files.sort((a, b) => b.mtime - a.mtime);
    return files.slice(0, limit).map(({ p, mtime, sessionId }) => {
      transcriptIndex.set(sessionId, p);
      let cwd = null, firstPrompt = null, title = null;
      try {
        for (const line of firstLines(p, 200_000)) {
          let e; try { e = JSON.parse(line); } catch { continue; }
          cwd = cwd || e.cwd;
          if (e.type === 'custom-title') title = e.customTitle;
          if (!firstPrompt && e.type === 'user' && !e.isMeta) {
            const t = textOf(e.message?.content);
            if (t && !/^<(command|local-command|system-reminder)/.test(t.trim())) firstPrompt = t.slice(0, 140);
          }
        }
        if (!title) for (const line of readTail(p, 60_000).split('\n')) {
          if (line.includes('"custom-title"') || line.includes('"summary"')) {
            try { const e = JSON.parse(line); title = e.customTitle || e.summary || title; } catch {}
          }
        }
      } catch {}
      return { sessionId, cwd, title, firstPrompt, mtime };
    });
  }

  function transcriptFromIndex(sessionId, at) {
    const d = index.get(sessionId);
    if (!d) return null;
    conversationBranches.resolveLinks(hub.terms, hub.termSessionId);
    const n = d.msgs.length;
    const start = at >= 0 ? Math.max(0, at - 40) : Math.max(0, n - 80);
    const end = at >= 0 ? Math.min(n, at + 40) : n;
    const edits = conversationBranches.getMsgEdits(sessionId);
    const ag = d.agent || 'claude';
    return {
      title: sessionDisplayTitle(sessionId, d), agent: ag, cwd: d.cwd, size: d.offset, rev: conversationBranches.rev(), total: n, base: start,
      messages: d.msgs.slice(start, end).map((m, idx) => {
        const ov = edits[String(start + idx)];
        return ov ? { ...m, text: String(ov.text || '').slice(0, 4000), edited: true } : { ...m, text: m.text.slice(0, 4000) };
      }),
      lineage: conversationBranches.lineageFor(sessionId, (id) => sessionDisplayTitle(id, index.get(id))),
      capabilities: { canNativeFork: ag === 'claude', canRewindEdit: ag === 'claude', canEditSource: ag === 'claude' || ag === 'codex' },
    };
  }

  async function searchScreens(q) {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const list = await hub.helperCall({ op: 'list' });
    const out = [];
    for (const c of (list.consoles || []).filter((c) => c.visible)) {
      const r = await hub.helperCall({ op: 'read', pid: c.id, lines: 2000 });
      if (!r.ok) continue;
      const hits = [];
      r.lines.forEach((l, i) => { const low = l.toLowerCase(); if (words.some((w) => low.includes(w))) hits.push({ line: i, text: l.trim().slice(0, 240) }); });
      const all = r.lines.join('\n').toLowerCase();
      if (hits.length && words.every((w) => all.includes(w))) out.push({ id: c.id, title: c.title, total: hits.length, hits: hits.slice(-6) });
    }
    return out;
  }

  async function buildOverview() {
    const [cons] = await Promise.all([hub.helperCall({ op: 'list' })]);
    const needAgyPid = [...hub.terms.values()].filter((t) => hub.isAgyTerm(t) && !t.pid && t.exited === null && (!t._pidTryAt || Date.now() - t._pidTryAt > 10_000));
    if (needAgyPid.length && !hub.isMatchBusy()) {
      const now = Date.now();
      for (const t of needAgyPid) t._pidTryAt = now;
      hub.setMatchBusy(true);
      await hub.matchTermPids(cons.consoles || []).catch(() => {}).finally(() => hub.setMatchBusy(false));
    }
    const live = liveSessions();
    for (const s of live) {
      const d = index.get(s.sessionId);
      if (d) { await index.updateFile(d.file); if (d.limit) s.limit = d.limit; }
    }
    const byPid = new Map(live.map((s) => [s.pid, s]));
    if (!hub.isMatchBusy()) { hub.setMatchBusy(true); hub.matchTermPids(cons.consoles || []).catch(() => {}).finally(() => hub.setMatchBusy(false)); }
    hub.setConsoleTitleCache(new Map((cons.consoles || []).filter((c) => c.visible && !/^[A-Za-z]:[\\/]/.test(c.title)).flatMap((c) => c.pids.map((p) => [p, c.title]))));
    const consoles = (cons.consoles || []).map((c) => ({
      ...c, claude: c.pids.map((x) => byPid.get(x)).filter(Boolean).map((s) => s.sessionId),
      managed: [...hub.terms.values()].some((t) => c.pids.includes(t.pid)),
      lastInputAt: Math.max(...c.pids.map((x) => hub.consoleInputAt.get(x) || 0), 0),
    }));
    conversationBranches.resolveLinks(hub.terms, hub.termSessionId);
    const termsOut = [...hub.terms.values()].map((t) => {
      const info = hub.termInfo(t);
      const c = t.pid && consoles.find((x) => x.pids.includes(t.pid));
      const s = info.claude && c && live.find((x) => c.pids.includes(x.pid));
      if (t.meta.projectTask) {
        info.sessionId = hub.projectRecord(t);
      } else if (s) {
        const d = index.get(s.sessionId);
        info.sessionId = s.sessionId;
        info.sessionName = sessionDisplayTitle(s.sessionId, d) || d?.firstPrompt?.split('\n')[0].slice(0, 80) || null;
      } else {
        const d = info.agy ? index.get(info.sessionId) : hub.termDocOf(t);
        if (d) {
          info.sessionId = d.id;
          info.sessionName = sessionDisplayTitle(d.id, d) || d.firstPrompt?.split('\n')[0].slice(0, 80) || null;
        } else if (info.codex) {
          const cid = hub.codexSessionOf(t);
          if (cid) info.sessionId = cid;
        }
      }
      const br = conversationBranches.branchMetaFor({ sessionId: info.sessionId || null, termId: t.id, lookupTitleFn: (id) => sessionDisplayTitle(id, index.get(id)) });
      if (br) info.branch = br;
      return info;
    });
    projects.remember(termsOut.filter((t) => t.projectTask && t.sessionId).map((t) => ({
      projectId: t.projectTask.projectId, taskId: t.projectTask.taskId, sessionId: t.sessionId, agent: t.agent, accountId: t.account?.id, tokens: index.get(t.sessionId)?.tokens,
    })));
    const ptyHostPid = hub.getPtyHostPid();
    const services = {
      hub: { ok: true, port, pid: process.pid },
      ptyHost: { ok: !!ptyHostPid && hub.pidAlive(ptyHostPid), pid: ptyHostPid || null },
      usage: { ok: await hub.checkUsageServer(), url: hub.USAGE_URL, hasLocalServer: fs.existsSync(path.join(hub.USAGE_DIR, 'server.js')) },
      agyQuota: { ok: !!hub.agyQuota.get(), refreshing: hub.agyQuota.getFast().refreshing, account: hub.agyQuota.get()?.account || null },
      helper: { ok: !hub.getHelperMissing(), error: hub.getHelperMissing() || null },
    };
    return { live, consoles, terms: termsOut, consoleError: cons.error, favs: hub.liveFavs(), disk: diskLow, consolesOff: config.consoles === false, services, buildId, accountPrefs: accountPrefs.get() };
  }

  function overviewSnapshot() {
    if (ovSnap && Date.now() - ovAt < OV_TTL) return Promise.resolve(ovSnap);
    if (!ovBuilding) ovBuilding = buildOverview().then((o) => { ovSnap = o; ovAt = Date.now(); return o; }).finally(() => { ovBuilding = null; });
    return ovBuilding;
  }

  async function handleStartOrNewTerm(p, req, res, body, send) {
    let b = await body(req);
    let projectTask, projectPrompt, launchAccount;
    if (p === '/api/projects/start') {
      if (hub.deletingProjects.has(b.projectId)) return send(res, 409, { error: 'Project 기록을 삭제 중입니다.' });
      const project = projects.list().find((x) => x.id === b.projectId);
      const task = project?.tasks.find((x) => x.id === b.taskId);
      if (!task) return send(res, 404, { error: 'Project 작업을 찾을 수 없습니다.' });
      if (task.stage === 'done') return send(res, 409, { error: '완료된 작업입니다. 상태를 바꾼 뒤 시작하세요.' });
      projectTask = { projectId: project.id, taskId: task.id };
      const harnessState = hub.projectHarness?.get ? hub.projectHarness.get() : null;
      const resolved = resolveTaskConfig(project, task, harnessState);
      const parentTask = resolved.parent;
      const kind = resolved.agent;
      const accountId = resolved.account;
      const model = resolved.model;
      const effort = resolved.effort;
      const existing = [...hub.terms.values()].find((t) => t.exited === null && t.meta.projectTask?.projectId === project.id && t.meta.projectTask.taskId === task.id && hub.agentOf(t) === kind && (t.account?.id || '') === (accountId || ''));
      if (existing) {
        const result = await existing.spawnResult;
        if (result?.error) return send(res, 502, { error: 'CLI를 시작하지 못했습니다. 설치 경로를 확인하세요.' });
        return send(res, 200, { ...hub.termInfo(existing), existing: true });
      }
      if (!hub.projectAgents.includes(kind)) return send(res, 400, { error: '작업 설계에서 CLI를 다시 선택하세요.' });
      hub.ensureProjectDir(project.cwd);
      if (!path.isAbsolute(project.cwd) || !fs.statSync(project.cwd, { throwIfNoEntry: false })?.isDirectory()) return send(res, 400, { error: '작업 설계에서 존재하는 작업 폴더의 전체 경로를 입력하세요.' });
      b = { kind, cwd: project.cwd, title: parentTask ? `${parentTask.title} › ${task.title}` : task.title, skipPermissions: true, model, effort, _autoDispatch: !!b._autoDispatch, _rawPrompt: b._rawPrompt || '' };
      const parts = parentTask ? [`[상위 작업: ${parentTask.title}]`, parentTask.detail ? parentTask.detail.slice(0, 600) : '', `[서브 개발 작업: ${task.title}]`, task.detail] : [task.title, task.detail];
      const harnessBlock = buildTaskHarnessPrompt(project, task, kind, harnessState);
      if (harnessBlock) parts.push(harnessBlock);
      projectPrompt = fingerprint(parts.filter(Boolean).join('\n\n'));
      try { launchAccount = hub.projectAccounts.resolve(kind, accountId); } catch (e) { return send(res, 400, { error: e.message }); }
    }
    if (b.resume && !b.fork && !projectTask) {
      const existingTerm = [...hub.terms.values()].find((x) => x.exited === null && hub.termSessionId(x) === b.resume);
      if (existingTerm) return send(res, 200, { ...hub.termInfo(existingTerm), existing: true });
    }
    const yolo = b.skipPermissions !== false;
    let cmd, args = [], title;
    if (b.kind === 'claude') {
      cmd = 'claude.exe';
      if (projectTask) args.push('--session-id', crypto.randomUUID());
      if (b.resume) args.push('--resume', b.resume);
      if (b.resume && b.fork) args.push('--fork-session');
      if (yolo) args.push('--dangerously-skip-permissions');
      args.push(...cliModelEffortArgs('claude', b.model, b.effort));
      title = b.resume ? `claude --resume ${b.resume.slice(0, 8)}` : 'claude';
    } else if (b.kind === 'codex') {
      const extra = [];
      if (projectTask) extra.push('-c', `shell_environment_policy.set.HUB_PROJECT_RUN_ID="${crypto.randomUUID()}"`);
      if (yolo) extra.push('--dangerously-bypass-approvals-and-sandbox');
      extra.push(...cliModelEffortArgs('codex', b.model, b.effort));
      if (b.resume && /^[\w-]+$/.test(b.resume)) extra.push('resume', b.resume);
      ({ cmd, args } = hub.codexLaunch(extra));
      title = b.resume ? `codex resume ${b.resume.slice(0, 8)}` : 'codex';
    } else if (b.kind === 'cursor') {
      const ca = [config.cursorAgent, path.join(os.homedir(), 'AppData', 'Local', 'cursor-agent', 'cursor-agent.cmd')].find((f) => f && fs.existsSync(f)) || 'cursor-agent.cmd';
      cmd = 'cmd.exe'; args = ['/c', ca];
      if (b.resume && /^[\w-]+$/.test(b.resume)) args.push('--resume', b.resume);
      title = 'Cursor agent';
    } else if (b.kind === 'agy') {
      cmd = hub.agyExe();
      if (b.resume && /^[\w-]+$/.test(b.resume)) args.push('--conversation', b.resume);
      else if (b.continue) args.push('--continue');
      if (yolo) args.push('--dangerously-skip-permissions');
      args.push(...cliModelEffortArgs('agy', b.model, b.effort));
      title = b.resume ? `agy ${b.resume.slice(0, 8)}` : 'agy';
    } else if (b.kind === 'cmd') { cmd = 'cmd.exe'; title = 'cmd'; }
    else { cmd = 'powershell.exe'; args = ['-NoLogo']; title = 'powershell'; }

    let cwd = b.cwd;
    if ((b.kind === 'agy' || b.kind === 'codex') && b.resume) { const d = index.get(b.resume); if (d?.cwd && (b.kind !== 'agy' || d.agent === 'agy')) cwd = d.cwd; }
    if (b.kind === 'claude' && b.resume) {
      const d = index.get(b.resume);
      if (d) { await index.updateFile(d.file); if (d.cwd) cwd = d.cwd; }
      const live = liveSessions().find((s) => s.sessionId === b.resume);
      if (live && !b.fork) return send(res, 409, { error: `이 세션은 이미 실행 중입니다 (pid ${live.pid}). 그 창에서 이어가세요.` });
    }
    if (!launchAccount && b.account && !/^(__cli__:|default$|agy-cli$)/.test(String(b.account))) {
      try { launchAccount = hub.projectAccounts.resolve(b.kind, String(b.account)); }
      catch (e) { if (String(b.account) !== 'auto-codex') return send(res, 400, { error: e.message }); }
    }
    if (launchAccount?.switchAgySwap) {
      try { await hub.ensureAgySwap(launchAccount); } catch (e) { return send(res, 502, { error: `Antigravity 계정 전환 실패: ${e.message}` }); }
    } else if (b.kind === 'agy' && !launchAccount?.account && hub.agySwap.available()) {
      const activeSwap = (hub.agySwap.getFast().accounts || []).find((a) => a.active);
      if (activeSwap) launchAccount = { ...launchAccount, account: { id: activeSwap.id, label: activeSwap.name ? `${activeSwap.name} (${activeSwap.email})` : activeSwap.email, kind: 'agy', email: activeSwap.email } };
    }
    const t = hub.createTerm({ cwd, cmd, args, title: b.title || title, ...launchAccount, model: b.model || '', effort: b.effort || '', projectTask, projectPrompt });
    if (!projectTask && ['claude', 'codex', 'agy'].includes(b.kind) && (b.model !== undefined || b.effort !== undefined || launchAccount?.account?.id)) {
      accountPrefs.save({ account: launchAccount?.account?.id || b.account || '', agent: b.kind, model: b.model || '', effort: b.effort || '' });
    }
    if (projectTask) {
      const result = await t.spawnResult;
      if (result?.error) { hub.terms.delete(t.id); return send(res, 502, { error: 'CLI를 시작하지 못했습니다. 설치 경로를 확인하세요.' }); }
      if (!result) return send(res, 503, { error: '터미널 호스트의 응답이 없습니다. 상태를 확인하세요.' });
      overviewStale();
      if (b._autoDispatch && b._rawPrompt) {
        const rawPrompt = b._rawPrompt;
        (async () => {
          const ready = await hub.waitFor(() => t.exited !== null || hub.inputReady(t), 35000, 500);
          if (!ready || t.exited !== null) return;
          const scr = hub.readTerm(t, 40).join('\n');
          if (/trust this folder|Do you trust/i.test(scr)) return;
          const ok = await dispatchImmediatePrompt(t, rawPrompt, {
            agent: hub.agentOf(t),
            ptyWrite: (id, data) => hub.ptyPost(id, '/write', { id, data }),
            readTerm: hub.readTerm,
            wait: (ms) => new Promise((r) => setTimeout(r, ms)),
          });
          if (!ok && t.exited === null) {
            await hub.ptyPost(t.id, '/write', { id: t.id, data: rawPrompt }).catch(() => {});
            setTimeout(() => { if (t.exited === null) hub.ptyPost(t.id, '/write', { id: t.id, data: '\r' }).catch(() => {}); }, 250);
          }
        })().catch(() => {});
      }
    }
    return send(res, 200, hub.termInfo(t));
  }

  hub.startProjectTaskById = async (projectId, taskId, { autoDispatch = true } = {}) => {
    let status = 200;
    let payload = null;
    const project = projects.list().find((x) => x.id === projectId);
    const task = project?.tasks.find((x) => x.id === taskId);
    const harnessState = hub.projectHarness?.get ? hub.projectHarness.get() : null;
    const resolved = project && task ? resolveTaskConfig(project, task, harnessState) : null;
    const parentTask = resolved?.parent;
    const rawParts = task
      ? (parentTask ? [`[상위 작업: ${parentTask.title}]`, parentTask.detail ? parentTask.detail.slice(0, 600) : '', `[서브 개발 작업: ${task.title}]`, task.detail] : [task.title, task.detail])
      : [];
    const harnessBlock = project && task && resolved ? buildTaskHarnessPrompt(project, task, resolved.agent, harnessState) : '';
    if (harnessBlock) rawParts.push(harnessBlock);
    const rawPrompt = rawParts.filter(Boolean).join('\n\n');

    await handleStartOrNewTerm(
      '/api/projects/start',
      { _autoDispatch: autoDispatch, _rawPrompt: rawPrompt },
      null,
      async () => ({ projectId, taskId, _autoDispatch: autoDispatch, _rawPrompt: rawPrompt }),
      (_res, code, data) => { status = code; payload = data; }
    );
    if (status >= 400) return { error: payload?.error || `HTTP ${status}` };
    return payload;
  };

  async function handleForkOrEdit(p, req, res, body, send) {
    const b = await body(req);
    const id = String(b.id || '').trim();
    if (!validSessionId(id)) return send(res, 400, { error: '대화 ID가 올바르지 않습니다.' });
    const d = index.get(id);
    if (d?.file) await index.updateFile(d.file);
    const fallback = !d ? transcript(id, 500) : null;
    const sourceFile = d?.file || fallback?.file || null;
    const sourceAgent = d?.agent || (sourceFile ? 'claude' : '');
    const messages = d?.msgs || fallback?.messages || [];
    if (!messages.length) return send(res, 404, { error: '대화 기록을 찾을 수 없습니다.' });

    const atIndex = Math.max(0, Math.min(messages.length - 1, Number(b.atIndex ?? (messages.length - 1))));
    const cwd = b.cwd || d?.cwd || os.homedir();
    const sourceTitle = sessionDisplayTitle(id, d) || fallback?.title || d?.firstPrompt?.split('\n')[0]?.slice(0, 60) || id.slice(0, 8);
    const isEdit = p === '/api/transcript/edit';
    const mode = isEdit ? String(b.mode || 'fork-edit') : 'fork';
    const newText = String(b.text || b.prompt || '').trim();
    if (isEdit && !newText) return send(res, 400, { error: '수정할 내용을 입력하세요.' });

    if (mode === 'save') {
      if (sourceAgent === 'claude' && sourceFile) {
        try { editClaudeJsonlAt({ sourceFile, sessionId: id, atIndex, newText, mode: 'save', backupDir: branchBackupDir }); index.docs.delete(id); await index.updateFile(sourceFile); }
        catch (e) { return send(res, 400, { error: e.message }); }
      } else if (sourceAgent === 'codex' && sourceFile) {
        try { editCodexJsonlAt({ sourceFile, sessionId: id, atIndex, newText, backupDir: branchBackupDir }); index.docs.delete(id); await index.updateFile(sourceFile); }
        catch (e) { return send(res, 400, { error: e.message }); }
      } else conversationBranches.setMsgEdit(id, atIndex, newText);
      overviewStale();
      return send(res, 200, { ok: true, mode: 'save' });
    }

    const targetAgent = ['claude', 'codex', 'agy'].includes(b.targetAgent) ? b.targetAgent : (sourceAgent || 'claude');
    let launchAccount;
    try { launchAccount = hub.projectAccounts.resolve(targetAgent, String(b.account || '')); }
    catch (e) { return send(res, 400, { error: e.message }); }
    if (launchAccount?.switchAgySwap) {
      try { await hub.ensureAgySwap(launchAccount); } catch (e) { return send(res, 502, { error: `Antigravity 계정 전환 실패: ${e.message}` }); }
    } else if (targetAgent === 'agy' && !launchAccount?.account && hub.agySwap.available()) {
      const activeSwap = (hub.agySwap.getFast().accounts || []).find((a) => a.active);
      if (activeSwap) launchAccount = { ...launchAccount, account: { id: activeSwap.id, label: activeSwap.name ? `${activeSwap.name} (${activeSwap.email})` : activeSwap.email, kind: 'agy', email: activeSwap.email } };
    }

    const reqME = cleanModelEffort(b.model, b.effort);
    accountPrefs.save({ account: launchAccount?.account?.id || b.account || '', agent: targetAgent, model: reqME.model, effort: reqME.effort });
    const launchAndDeliver = async ({ agent, resumeId, title, promptToSend }) => {
      let cmd, args = [];
      if (agent === 'codex') {
        ({ cmd, args } = hub.codexLaunch(['--dangerously-bypass-approvals-and-sandbox', ...cliModelEffortArgs('codex', reqME.model, reqME.effort), ...(resumeId ? ['resume', resumeId] : []), ...(!resumeId && promptToSend ? [promptToSend] : [])]));
      } else if (agent === 'agy') {
        cmd = hub.agyExe();
        if (resumeId) args.push('--conversation', resumeId);
        args.push('--dangerously-skip-permissions', ...cliModelEffortArgs('agy', reqME.model, reqME.effort));
        if (!resumeId && promptToSend) args.push('--prompt-interactive', promptToSend);
      } else {
        cmd = 'claude.exe';
        if (resumeId) args.push('--resume', resumeId);
        args.push('--dangerously-skip-permissions', ...cliModelEffortArgs('claude', reqME.model, reqME.effort));
      }
      const term = hub.createTerm({ cwd, cmd, args, env: launchAccount?.env || {}, title, account: launchAccount?.account || null, model: reqME.model, effort: reqME.effort });
      if (promptToSend && (agent === 'claude' || resumeId)) {
        (async () => {
          if (await hub.waitFor(() => term.exited === null && hub.inputReady(term), 45000, 700)) {
            await hub.sleep(600);
            const payload = /\r|\n/.test(promptToSend) ? `\x1b[200~${promptToSend.replace(/\r\n/g, '\n')}\x1b[201~` : promptToSend;
            term.proc.write(payload); await hub.sleep(hub.SUBMIT_DELAY); term.proc.write('\r');
          }
        })().catch(() => {});
      }
      return term;
    };

    if (mode === 'rewind-edit') {
      if (sourceAgent !== 'claude' || !sourceFile) return send(res, 400, { error: '원본 되감기 재실행은 Claude 로컬 대화 기록에서만 지원됩니다. (대신 분기해서 재실행을 사용하세요)' });
      const live = liveSessions().find((s) => s.sessionId === id);
      if (live) {
        const cons = (await hub.helperCall({ op: 'list' })).consoles || [];
        const pidSet = new Set(cons.find((c) => c.pids.includes(live.pid))?.pids || []);
        const openTerm = [...hub.terms.values()].find((x) => x.exited === null && x.pid && pidSet.has(x.pid));
        if (!openTerm) return send(res, 409, { error: `이 세션이 외부 창(pid ${live.pid})에서 실행 중입니다. 먼저 닫거나 분기 재실행을 사용하세요.` });
        openTerm.proc.write('\x1b'); await hub.sleep(400); openTerm.proc.write('/exit'); await hub.sleep(hub.SUBMIT_DELAY); openTerm.proc.write('\r');
        if (!(await hub.waitFor(() => openTerm.exited !== null, 5000))) try { openTerm.proc.kill(); } catch {}
        hub.forgetTerm(openTerm);
      }
      try {
        editClaudeJsonlAt({ sourceFile, sessionId: id, atIndex, newText, mode: 'rewind', backupDir: branchBackupDir });
        conversationBranches.clearMsgEditsFrom(id, atIndex);
        index.docs.delete(id);
        await index.updateFile(sourceFile);
      } catch (e) { return send(res, 400, { error: e.message }); }
      const term = await launchAndDeliver({ agent: 'claude', resumeId: id, title: `${sourceTitle.slice(0, 28)} (되감기)`, promptToSend: newText });
      overviewStale();
      return send(res, 200, { ok: true, mode: 'rewind-edit', term: hub.termInfo(term), childSessionId: id });
    }

    const inclusive = !isEdit;
    const anchorText = String(messages[atIndex]?.text || '').replace(/\s+/g, ' ').trim().slice(0, 100);
    const branchTitle = isEdit && newText ? `(분기) ${newText.replace(/\s+/g, ' ').trim().slice(0, 36)}` : `(분기) ${sourceTitle.slice(0, 32)}`;
    if (sourceAgent === 'claude' && targetAgent === 'claude' && sourceFile) {
      let forked;
      try { forked = forkClaudeJsonlAt({ sourceFile, cutIndex: atIndex, inclusive, title: branchTitle }); conversationBranches.setTitle(forked.newSessionId, branchTitle); await index.updateFile(forked.file); }
      catch (e) { return send(res, 400, { error: e.message }); }
      const term = await launchAndDeliver({ agent: 'claude', resumeId: forked.newSessionId, title: branchTitle, promptToSend: newText });
      const branch = conversationBranches.addBranch({ parentSessionId: id, childSessionId: forked.newSessionId, termId: term.id, sourceAgent, targetAgent, mode, atIndex, branchTitle, anchorText, editedText: isEdit ? newText.slice(0, 500) : '', native: true });
      overviewStale();
      return send(res, 200, { ok: true, mode, native: true, term: hub.termInfo(term), branch, childSessionId: forked.newSessionId });
    }

    const { instruction } = writeBranchContextFile({
      uploadsDir: path.join(baseDir, 'uploads'), sourceSessionId: id, sourceTitle, sourceAgent: sourceAgent || 'claude', targetAgent, cwd, messages, atIndex, inclusive, editedText: isEdit ? newText : '', followUp: !isEdit ? newText : '',
    });
    const term = await launchAndDeliver({ agent: targetAgent, resumeId: null, title: branchTitle, promptToSend: instruction });
    const branch = conversationBranches.addBranch({ parentSessionId: id, childSessionId: null, termId: term.id, sourceAgent: sourceAgent || 'claude', targetAgent, mode, atIndex, branchTitle, anchorText, editedText: isEdit ? newText.slice(0, 500) : '', native: false });
    overviewStale();
    return send(res, 200, { ok: true, mode, native: false, term: hub.termInfo(term), branch, childSessionId: null });
  }

  async function handleSessionRoutes(p, url, req, res, body, send, authed) {
    if (!authed(req, url)) { send(res, 401, { error: 'bad token' }); return true; }

    if (p === '/api/overview') { send(res, 200, await overviewSnapshot()); return true; }
    if (p === '/api/favorites' && req.method === 'POST') {
      const b = await body(req);
      const validKey = (k) => /^(sid:[\w-]{8,64}|term:\d{1,6}|proj:[\w-]{8,64})$/.test(String(k || ''));
      const keys = Array.isArray(b.keys) && b.keys.length ? b.keys.map(String) : [String(b.key || '')];
      if (!keys.every(validKey)) { send(res, 400, { error: 'bad key' }); return true; }
      const drop = new Set(keys);
      const favs = hub.loadFavs().filter((k) => !drop.has(k));
      if (b.on) favs.unshift(keys[0]);
      fs.writeFileSync(hub.FAV_FILE, JSON.stringify(favs.slice(0, 50)));
      send(res, 200, { favs: hub.liveFavs() });
      return true;
    }
    if (p === '/api/recent') {
      const n = Number(url.searchParams.get('n') || 40), auto = url.searchParams.get('auto') === '1';
      if (url.searchParams.get('fresh') === '1' || Date.now() - hub.getLastIndexAt() > 5000) await hub.refreshIndex();
      conversationBranches.resolveLinks(hub.terms, hub.termSessionId);
      const agent = url.searchParams.get('agent') || '';
      const hidden = projects.hidden();
      const raw = index.ready ? index.recent(n, auto, agent, hidden) : recentSessions(n).filter((s) => !hidden.has(s.sessionId) && (!agent || (s.agent || 'claude') === agent));
      const sessions = raw.map((s) => {
        const branch = conversationBranches.branchMetaFor({ sessionId: s.sessionId, lookupTitleFn: (id) => sessionDisplayTitle(id, index.get(id)) });
        const customTitle = conversationBranches.getTitle(s.sessionId);
        const fallbackBranchTitle = branch?.isBranch ? (branch.branchTitle || (branch.parentTitle ? `(분기) ${String(branch.parentTitle).slice(0, 36)}` : null)) : null;
        return { ...s, title: customTitle || fallbackBranchTitle || s.title, ...(branch ? { branch } : {}) };
      });
      send(res, 200, { sessions });
      return true;
    }
    if (p === '/api/recent/hide' && req.method === 'POST') {
      const { id } = await body(req);
      if (!validSessionId(id)) { send(res, 400, { error: '대화 ID가 올바르지 않습니다.' }); return true; }
      const activeTerm = [...hub.terms.values()].find((t) => t.exited === null && hub.termSessionId(t) === id);
      if (activeTerm || liveSessions().find((s) => s.sessionId === id)) { send(res, 409, { error: '이 대화가 현재 실행 중입니다. 먼저 터미널을 종료한 뒤 삭제하세요.' }); return true; }
      try { send(res, 200, { ok: true, deletedCli: await hub.eraseSingleRecord(id) }); }
      catch (e) { send(res, 500, { error: e.message || 'CLI 대화 기록 삭제에 실패했습니다.' }); }
      return true;
    }
    if (p === '/api/transcript') {
      const id = url.searchParams.get('id'), at = Number(url.searchParams.get('at') ?? -1);
      if (projects.hidden().has(id)) { send(res, 404, { error: '허브에서 제거한 대화 기록입니다.', hidden: true }); return true; }
      conversationBranches.resolveLinks(hub.terms, hub.termSessionId);
      let d = index.get(id);
      if (!d && id && Date.now() - hub.getLastIndexAt() > 1500) { await hub.refreshIndex(); d = index.get(id); }
      if (d) await index.updateFile(d.file);
      const out = transcriptFromIndex(id, at) || transcript(id);
      if (out && !out.lineage && id) out.lineage = conversationBranches.lineageFor(id, (sid) => sessionDisplayTitle(sid, index.get(sid)));
      send(res, 200, out);
      return true;
    }
    if (p === '/api/transcript/title' && req.method === 'POST') {
      const b = await body(req);
      const id = String(b.id || '').trim(), title = String(b.title || '').trim().slice(0, 140);
      if (!validSessionId(id)) { send(res, 400, { error: '대화 ID가 올바르지 않습니다.' }); return true; }
      const saved = conversationBranches.setTitle(id, title);
      const d = index.get(id);
      if (d) {
        d.title = saved || d.title;
        if ((d.agent || 'claude') === 'claude' && d.file && fs.existsSync(d.file) && saved) {
          try { fs.appendFileSync(d.file, JSON.stringify({ type: 'custom-title', customTitle: saved, sessionId: id }) + '\n', 'utf8'); } catch {}
        }
      }
      overviewStale();
      send(res, 200, { ok: true, title: saved });
      return true;
    }
    if ((p === '/api/transcript/fork' || p === '/api/transcript/edit') && req.method === 'POST') {
      await handleForkOrEdit(p, req, res, body, send);
      return true;
    }
    if (p === '/api/search') {
      const q = (url.searchParams.get('q') || '').trim();
      if (!q) { send(res, 200, { sessions: [], screens: [] }); return true; }
      const t0 = Date.now();
      const opts = { role: url.searchParams.get('role') || 'all', includeAuto: url.searchParams.get('auto') === '1', cwd: url.searchParams.get('cwd') || '', agent: url.searchParams.get('agent') || '', hidden: projects.hidden() };
      const sessions = index.search(q, opts).map((s) => {
        const branch = conversationBranches.branchMetaFor({ sessionId: s.sessionId, lookupTitleFn: (id) => sessionDisplayTitle(id, index.get(id)) });
        return { ...s, title: conversationBranches.getTitle(s.sessionId) || branch?.branchTitle || s.title, ...(branch ? { branch } : {}) };
      });
      const screens = url.searchParams.get('screens') === '0' ? [] : await searchScreens(q);
      send(res, 200, { sessions, screens, ms: Date.now() - t0, ready: index.ready, progress: index.progress });
      return true;
    }
    if (p === '/api/console/read') { send(res, 200, await hub.helperCall({ op: 'read', pid: Number(url.searchParams.get('pid')), lines: 300 })); return true; }
    if (p === '/api/console/send' && req.method === 'POST') {
      const b = await body(req);
      const pid = Number(b.pid);
      if (b.submit || b.immediate || b.text) hub.consoleInputAt.set(pid, Date.now());
      const snap = (b.immediate || (b.submit && b.text))
        ? await hub.helperCall({ op: 'read', pid, lines: b.immediate ? 30 : 5 }).catch(() => null) : null;
      const inHistorySearch = codexHistorySearchActive(snap?.lines || []);
      if (inHistorySearch) {
        const r = await hub.helperCall({ op: 'send', pid, keys: ['esc'] });
        if (!r.ok) { send(res, 200, r); return true; }
        await hub.sleep(hub.SUBMIT_DELAY);
      }
      if (b.immediate && !inHistorySearch) {
        const rawScr = String((snap?.lines || []).join('\n')).replace(/\s+/g, ' ');
        const tailScr = String((snap?.lines || []).slice(-10).join('\n')).replace(/\s+/g, ' ');
        const needle = String(b.text || '').trim().replace(/\s+/g, ' ').slice(0, 20);
        if (AGY_ALTM_RE.test(rawScr)) { send(res, 200, { ...(await hub.helperCall({ op: 'send', pid, keys: ['alt+m'] })), immediate: true, flushedQueued: true, steered: true }); return true; }
        if (needle && (tailScr.includes(needle) || /\[pasted text/i.test(tailScr))) { send(res, 200, { ...(await hub.helperCall({ op: 'send', pid, keys: ['enter'] })), submittedExisting: true }); return true; }
        if (b.resendIfMissing && needle && rawScr.includes(needle)) { send(res, 200, { ok: true, immediate: true, alreadyRecognized: true }); return true; }
        await hub.helperCall({ op: 'send', pid, keys: ['esc'] }); await hub.sleep(500);
      }
      let r = await hub.helperCall({ op: 'send', pid, text: b.text || '', keys: b.keys || [] });
      if (r.ok && b.submit) { await hub.sleep(hub.consoleSubmitDelay(b.text)); r = await hub.helperCall({ op: 'send', pid, keys: ['enter'] }); }
      send(res, 200, r);
      return true;
    }
    if (p === '/api/console/focus' && req.method === 'POST') { const b = await body(req); send(res, 200, await hub.helperCall({ op: 'focus', pid: Number(b.pid) })); return true; }
    if (p === '/api/term/read') {
      const t = hub.terms.get(url.searchParams.get('id') || '');
      send(res, t ? 200 : 404, t ? { ok: true, ...hub.termInfo(t), lines: hub.readTerm(t, Number(url.searchParams.get('lines') || 60)) } : { ok: false, error: 'no such terminal' });
      return true;
    }
    if (p === '/api/term/windows') {
      const id = url.searchParams.get('id') || '', pidParam = Number(url.searchParams.get('pid') || 0);
      const t = id ? hub.terms.get(id) : null;
      const pids = [...(t?.pid ? [t.pid] : []), ...(pidParam > 0 ? [pidParam] : [])];
      const r = await hub.helperCall({ op: 'list_windows', pids });
      send(res, 200, { ok: r.ok !== false, windows: r.windows || [], error: r.error || null });
      return true;
    }
    if (p === '/api/window/shot') {
      const hwnd = Number(url.searchParams.get('hwnd') || 0), maxWidth = Number(url.searchParams.get('w') || 900);
      if (!hwnd) { send(res, 400, { ok: false, error: 'hwnd가 필요합니다.' }); return true; }
      const r = await hub.helperCall({ op: 'capture_window', hwnd, max_width: maxWidth });
      if (!r.ok || !r.png) { send(res, r.minimized ? 409 : 404, { ok: false, minimized: !!r.minimized, error: r.error || '창을 캡처하지 못했습니다.' }); return true; }
      const buf = Buffer.from(r.png, 'base64');
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store, no-cache, must-revalidate, max-age=0', 'content-length': buf.length });
      res.end(buf);
      return true;
    }
    if (p === '/api/window/focus' && req.method === 'POST') {
      const b = await body(req); const hwnd = Number(b.hwnd || 0);
      send(res, hwnd ? 200 : 400, hwnd ? await hub.helperCall({ op: 'focus_window', hwnd }) : { ok: false, error: 'hwnd가 필요합니다.' });
      return true;
    }
    if (p === '/api/term/send' && req.method === 'POST') {
      const b = await body(req); const t = hub.terms.get(String(b.id));
      if (!t || t.exited !== null) { send(res, 404, { ok: false, error: 'no such running terminal' }); return true; }
      if (b.submit || b.immediate || b.text) hub.touchUserInput(t);
      const inHistorySearch = (b.immediate || (b.submit && b.text)) && hub.isCodexTerm(t)
        && codexHistorySearchActive(hub.readTerm(t, 5));
      if (inHistorySearch) {
        await t.proc.write(PTY_KEYS.esc);
        await hub.sleep(hub.SUBMIT_DELAY);
      }
      if (b.immediate && !inHistorySearch) {
        const cli = hub.isCodexTerm(t) ? 'codex' : hub.isAgyTerm(t) ? 'agy' : 'claude';
        const outcome = await dispatchImmediatePrompt({
          cli, isBusy: () => (cli === 'codex' ? hub.codexStatus(t) : cli === 'agy' ? hub.agyStatus(t) : hub.claudeStatus(t)) === 'busy',
          readNormLines: (n) => stripAnsi(hub.readTerm(t, n).join('\n')), write: (d) => t.proc.write(d),
          sleep: hub.sleep, text: b.text || '', resendIfMissing: !!b.resendIfMissing, submitDelay: hub.SUBMIT_DELAY,
        });
        if (outcome.handled) { send(res, 200, outcome.result); return true; }
      }
      if (b.text) t.proc.write(b.text);
      for (const k of b.keys || []) {
        if (!(k in PTY_KEYS)) { send(res, 400, { ok: false, error: `unknown key ${k}; one of ${Object.keys(PTY_KEYS)}` }); return true; }
        t.proc.write(PTY_KEYS[k]);
      }
      if (b.submit) { await hub.sleep(b.fromTerminalInput && b.text ? hub.SUBMIT_DELAY + Math.min(3000, b.text.length * 2) : hub.SUBMIT_DELAY); t.proc.write('\r'); }
      send(res, 200, { ok: true, immediate: !!b.immediate });
      return true;
    }
    if (p === '/api/term/external' && req.method === 'POST') {
      const b = await body(req); const d = b.resume ? index.get(b.resume) : null;
      const cwd = b.cwd || d?.cwd || os.homedir(), kind = b.kind || d?.agent || 'claude', yolo = b.skipPermissions !== false;
      let cmd, args = [];
      if (kind === 'codex') ({ cmd, args } = hub.codexLaunch([...(yolo ? ['--dangerously-bypass-approvals-and-sandbox'] : []), ...cliModelEffortArgs('codex', b.model, b.effort), ...(b.resume ? ['resume', b.resume] : [])]));
      else if (kind === 'agy') { cmd = hub.agyExe(); if (b.resume) args.push('--conversation', b.resume); if (yolo) args.push('--dangerously-skip-permissions'); args.push(...cliModelEffortArgs('agy', b.model, b.effort)); }
      else { cmd = 'claude.exe'; if (b.resume) args.push('--resume', b.resume); if (yolo) args.push('--dangerously-skip-permissions'); args.push(...cliModelEffortArgs('claude', b.model, b.effort)); }
      send(res, 200, hub.launchExternalWindow({ cwd, title: `${kind} ${b.resume ? b.resume.slice(0, 8) : ''}`.trim(), cmd, args, openMode: b.openMode || 'external' }));
      return true;
    }
    if ((p === '/api/term/new' || p === '/api/projects/start') && req.method === 'POST') {
      await handleStartOrNewTerm(p, req, res, body, send);
      return true;
    }
    if (p === '/api/term/dedupe' && req.method === 'POST') {
      const removed = hub.dedupeTermsBySession();
      await hub.saveTermsState(); overviewStale();
      send(res, 200, { ok: true, removed });
      return true;
    }
    if (p === '/api/term/close' && req.method === 'POST') {
      const b = await body(req); const t = hub.terms.get(String(b.id));
      if (t) { hub.rememberProjectTerm(t); hub.forgetTerm(t); }
      send(res, 200, { ok: true });
      return true;
    }

    return false;
  }

  return { liveSessions, transcript, overviewStale, overviewSnapshot, handleSessionRoutes };
}

module.exports = { createSessionRoutes };
