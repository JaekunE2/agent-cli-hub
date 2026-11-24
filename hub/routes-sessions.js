'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { resolveTaskConfig, buildTaskHarnessPrompt } = require('./project-harness');
const { codexHistorySearchActive } = require('./immediate-send');
const { claudeCommandNote, claudeToolResultNote } = require('./searchindex');
const { spawnCli } = require('./project-plan');
const { sessionStartupBlock, dismissProjectHookMenu, writeProjectTerm, dispatchCodexProjectPrompt, projectRunStarted, terminalConfirmationMessage, HOOK_MENU_MESSAGE, DUMB_TERMINAL_MESSAGE, PROJECT_START_MESSAGE } = require('./term-manager');

const OV_TTL = 2500;

/** Create transcript, overview, search, console/terminal interaction, and launch routes. */
function createSessionRoutes(hub) {
  const {
    baseDir, port, config, buildId, claudeDir, index, projects, accountPrefs, conversationBranches, termEvents,
    sessionDisplayTitle, branchBackupDir, forkClaudeJsonlAt, editClaudeJsonlAt, editCodexJsonlAt,
    writeBranchContextFile, validSessionId, cleanModelEffort, cliModelEffortArgs, fingerprint,
    PTY_KEYS, dispatchImmediatePrompt, AGY_ALTM_RE, stripAnsi,
  } = hub;

  const transcriptIndex = new Map();
  const restartingTasks = new Set();
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
      const ans = claudeToolResultNote(e);
      if (ans) { msgs.push({ role: 'user', text: ans, ts: e.timestamp }); continue; }
      const text = textOf(e.message?.content);
      if (!text) continue;
      if (/^<(command|local-command|system-reminder)/.test(text.trim())) {
        const cmdNote = claudeCommandNote(text);
        if (cmdNote) msgs.push({ role: 'assistant', text: cmdNote, ts: e.timestamp });
        continue;
      }
      msgs.push({ role: e.type, text: text.slice(0, 4000), ts: e.timestamp });
    }
    const mergedMsgs = termEvents ? termEvents.mergeIntoMessages(msgs, sessionId) : msgs;
    const sliced = mergedMsgs.slice(-maxMsgs);
    const base = Math.max(0, mergedMsgs.length - sliced.length);
    const edits = conversationBranches.getMsgEdits(sessionId);
    const patched = sliced.map((m, i) => {
      const ov = edits[String(base + i)];
      return ov ? { ...m, text: String(ov.text || '').slice(0, 4000), edited: true } : m;
    });
    return {
      file, title: conversationBranches.getTitle(sessionId) || title, messages: patched, total: mergedMsgs.length, base, size: fs.statSync(file).size,
      rev: conversationBranches.rev() + (termEvents ? termEvents.rev() : 0), lineage: conversationBranches.lineageFor(sessionId, (id) => sessionDisplayTitle(id, index.get(id))),
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
    if (termEvents) {
      for (const t of hub.terms.values()) {
        const sid = hub.termSessionId(t);
        if (sid) termEvents.bindSession(t.id, sid);
      }
    }
    const allMsgs = termEvents ? termEvents.mergeIntoMessages(d.msgs, sessionId) : d.msgs;
    const n = allMsgs.length;
    const start = at >= 0 ? Math.max(0, at - 40) : Math.max(0, n - 80);
    const end = at >= 0 ? Math.min(n, at + 40) : n;
    const edits = conversationBranches.getMsgEdits(sessionId);
    const ag = d.agent || 'claude';
    return {
      title: sessionDisplayTitle(sessionId, d), agent: ag, cwd: d.cwd, size: d.offset, rev: conversationBranches.rev() + (termEvents ? termEvents.rev() : 0), total: n, base: start,
      messages: allMsgs.slice(start, end).map((m, idx) => {
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
      if (info.sessionId && t.meta?.customTitle && !conversationBranches.getTitle(info.sessionId)) {
        conversationBranches.setTitle(info.sessionId, t.meta.customTitle);
      }
      if (info.sessionId) {
        const custom = conversationBranches.getTitle(info.sessionId);
        if (custom) {
          info.sessionName = custom;
          info.customTitle = custom;
        }
      }
      const br = conversationBranches.branchMetaFor({ sessionId: info.sessionId || null, termId: t.id, lookupTitleFn: (id) => sessionDisplayTitle(id, index.get(id)) });
      if (br) info.branch = br;
      return info;
    });
    const owners = projects.sessionOwners();
    projects.remember(termsOut.flatMap((t) => {
      const owner = t.projectTask || owners.get(t.branch?.parentSessionId);
      return owner && t.sessionId ? [{ ...owner, sessionId: t.sessionId, agent: t.agent, accountId: t.account?.id, tokens: index.get(t.sessionId)?.tokens }] : [];
    }));
    const ptyHostPid = hub.getPtyHostPid();
    const services = {
      hub: { ok: true, port, pid: process.pid },
      ptyHost: { ok: !!ptyHostPid && hub.pidAlive(ptyHostPid), pid: ptyHostPid || null },
      usage: { ok: await hub.checkUsageServer(), url: hub.USAGE_URL, hasLocalServer: fs.existsSync(path.join(hub.USAGE_DIR, 'server.js')) },
      agyQuota: { ok: !!hub.agyQuota.get(), refreshing: hub.agyQuota.getFast().refreshing, account: hub.agyQuota.get()?.account || null },
      helper: { ok: !hub.getHelperMissing(), error: hub.getHelperMissing() || null },
    };
    const projectRevisions = Object.fromEntries(projects.list().map((p) => [p.id, p.revision]));
    return { live, consoles, terms: termsOut, consoleError: cons.error, favs: hub.liveFavs(), disk: diskLow, consolesOff: config.consoles === false, services, buildId, accountPrefs: accountPrefs.get(), projectRevisions };
  }

  function overviewSnapshot() {
    if (ovSnap && Date.now() - ovAt < OV_TTL) return Promise.resolve(ovSnap);
    if (!ovBuilding) ovBuilding = buildOverview().then((o) => { ovSnap = o; ovAt = Date.now(); return o; }).finally(() => { ovBuilding = null; });
    return ovBuilding;
  }

  async function handleStartOrNewTerm(p, req, res, body, send) {
    let b = await body(req);
    const retry = p === '/api/projects/start' && b.retry === true;
    const submitDraft = retry && b.submitDraft === true;
    let projectTask, projectPrompt, launchAccount, projectRefsBlock = '';
    let reuseTerm;
    if (p === '/api/projects/start') {
      if (hub.deletingProjects.has(b.projectId)) return send(res, 409, { error: 'Project 기록을 삭제 중입니다.' });
      const project = projects.list().find((x) => x.id === b.projectId);
      const task = project?.tasks.find((x) => x.id === b.taskId);
      if (!task) return send(res, 404, { error: 'Project 작업을 찾을 수 없습니다.' });
      if (task.stage === 'done') return send(res, 409, { error: '완료된 작업입니다. 상태를 바꾼 뒤 시작하세요.' });
      if (retry && task.stage !== 'doing') return send(res, 409, { error: '진행 단계의 작업만 다시 시작할 수 있습니다.' });
      projectTask = { projectId: project.id, taskId: task.id };
      const harnessState = hub.projectHarness?.get ? hub.projectHarness.get() : null;
      const resolved = resolveTaskConfig(project, task, harnessState);
      const parentTask = resolved.parent;
      const kind = resolved.agent;
      const accountId = resolved.account;
      const model = resolved.model;
      const effort = resolved.effort;
      const existing = [...hub.terms.values()].findLast((t) => t.exited === null && t.meta.projectTask?.projectId === project.id && t.meta.projectTask.taskId === task.id && hub.agentOf(t) === kind && (t.account?.id || '') === (accountId || ''));
      if (existing) {
        const result = await existing.spawnResult;
        if (result?.error) return send(res, 502, { error: 'CLI를 시작하지 못했습니다. 설치 경로를 확인하세요.' });
        const info = hub.termInfo(existing);
        if (!retry || existing._projectDispatchPending || info.status === 'busy') return send(res, 200, { ...info, existing: true });
        if (info.startupBlock !== 'term-dumb') reuseTerm = existing;
      }
      if (submitDraft && (kind !== 'codex' || String(b.termId || '') !== reuseTerm?.id || !hub.termInfo(reuseTerm).inputDraft)) {
        return send(res, 409, { error: 'Codex 입력창에서 작업 내용이 확인되지 않았습니다.' });
      }
      if (!hub.projectAgents.includes(kind)) return send(res, 400, { error: '작업 설계에서 CLI를 다시 선택하세요.' });
      hub.ensureProjectDir(project.cwd);
      if (!path.isAbsolute(project.cwd) || !fs.statSync(project.cwd, { throwIfNoEntry: false })?.isDirectory()) return send(res, 400, { error: '작업 설계에서 존재하는 작업 폴더의 전체 경로를 입력하세요.' });
      const taskWorktree = task.worktreePath && path.isAbsolute(task.worktreePath) && fs.statSync(task.worktreePath, { throwIfNoEntry: false })?.isDirectory() ? task.worktreePath : '';
      b = { kind, cwd: taskWorktree || project.cwd, title: parentTask ? `${parentTask.title} › ${task.title}` : task.title, skipPermissions: true, model, effort, resume: typeof b.resume === 'string' ? b.resume.trim() : '', _autoDispatch: b.autoDispatch !== false && b._autoDispatch !== false, _rawPrompt: b._rawPrompt || '' };
      const parts = parentTask ? [`[상위 작업: ${parentTask.title}]`, parentTask.detail ? parentTask.detail.slice(0, 600) : '', `[서브 개발 작업: ${task.title}]`, task.detail] : [task.title, task.detail];
      const harnessBlock = buildTaskHarnessPrompt(project, task, kind, harnessState);
      if (harnessBlock) parts.push(harnessBlock);
      const depNotes = (task.after || [])
        .map((id) => project.tasks.find((x) => x.id === id))
        .filter((d) => d && d.stage === 'done' && (d.lastOutput || d.reviewNote))
        .map((d) => `- [${d.title}]${d.reviewNote ? ` (검토: ${d.reviewNote.slice(0, 200)})` : ''}\n  ${String(d.lastOutput || '').slice(0, 600)}`)
        .join('\n');
      if (depNotes) parts.push(`[선행 작업 완료 결과]\n${depNotes}`);
      projectRefsBlock = hub.projectRefs?.promptBlock ? hub.projectRefs.promptBlock(project.id) : '';
      if (projectRefsBlock) parts.push(projectRefsBlock);
      const fullTaskPrompt = parts.filter(Boolean).join('\n\n');
      if (!b._rawPrompt) b._rawPrompt = fullTaskPrompt;
      projectPrompt = fingerprint(b._rawPrompt);
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
      if (projectTask && !b.resume) args.push('--session-id', crypto.randomUUID());
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
    else if (b.kind === 'pwsh') {
      const pwshExe = ['C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'pwsh.exe'].find((f) => f === 'pwsh.exe' || fs.existsSync(f));
      cmd = pwshExe; args = ['-NoLogo']; title = 'pwsh';
    } else if (b.kind === 'ubuntu') {
      cmd = 'wsl.exe'; args = []; title = 'Ubuntu (WSL)';
    } else if (b.kind === 'gitbash') {
      const bashExe = ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe', 'bash.exe'].find((f) => f === 'bash.exe' || fs.existsSync(f));
      cmd = bashExe; args = ['--login', '-i']; title = 'Git Bash';
    } else { cmd = 'powershell.exe'; args = ['-NoLogo']; title = 'powershell'; }

    let cwd = b.cwd;
    if (!projectTask && b.admin) {
      const workCwd = cwd || os.homedir();
      return send(res, 200, hub.launchExternalWindow({ cwd: workCwd, title, cmd, args, openMode: 'external', admin: true }));
    }
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
    if (!reuseTerm && launchAccount?.switchAgySwap) {
      try { await hub.ensureAgySwap(launchAccount); } catch (e) { return send(res, 502, { error: `Antigravity 계정 전환 실패: ${e.message}` }); }
    } else if (!reuseTerm && b.kind === 'agy' && !launchAccount?.account && hub.agySwap.available()) {
      const activeSwap = (hub.agySwap.getFast().accounts || []).find((a) => a.active);
      if (activeSwap) launchAccount = { ...launchAccount, account: { id: activeSwap.id, label: activeSwap.name ? `${activeSwap.name} (${activeSwap.email})` : activeSwap.email, kind: 'agy', email: activeSwap.email } };
    }
    const t = reuseTerm || hub.createTerm({ cwd, cmd, args, title: b.title || title, ...launchAccount, model: b.model || '', effort: b.effort || '', projectTask, projectPrompt });
    if (!projectTask && ['claude', 'codex', 'agy'].includes(b.kind) && (b.model !== undefined || b.effort !== undefined || launchAccount?.account?.id)) {
      accountPrefs.save({ account: launchAccount?.account?.id || b.account || '', agent: b.kind, model: b.model || '', effort: b.effort || '' });
    }
    if (projectTask) {
      const result = await t.spawnResult;
      if (result?.error) { hub.terms.delete(t.id); return send(res, 502, { error: 'CLI를 시작하지 못했습니다. 설치 경로를 확인하세요.' }); }
      if (!result && !reuseTerm) return send(res, 503, { error: '터미널 호스트의 응답이 없습니다. 상태를 확인하세요.' });
      if (retry) {
        const latest = projects.list().find((p) => p.id === projectTask.projectId);
        if (!latest?.tasks.some((x) => x.id === projectTask.taskId && x.stage === 'doing')) return send(res, 409, { error: '진행 단계의 작업만 다시 시작할 수 있습니다.' });
        projects.save({ ...latest, tasks: latest.tasks.map((x) => x.id === projectTask.taskId
          ? { ...x, reviewPaused: false, reviewStatus: '', reviewNote: '', retryCount: 0 } : x) });
        for (const prior of hub.terms.values()) {
          if (prior.meta?.projectTask?.projectId !== projectTask.projectId || prior.meta.projectTask.taskId !== projectTask.taskId) continue;
          prior._projectBusySeen = false;
          prior._idleStreak = 0;
          prior._projectDispatchedAt = 0;
        }
      }
      overviewStale();
      if (b._autoDispatch && b._rawPrompt) {
        const rawPrompt = b._rawPrompt;
        t._projectDispatchPending = true;
        t._projectDispatchResult = (async () => {
          let confirmationSeen = false;
          const readyOrBlocked = async () => {
            if (t.exited !== null || !hub.terms.has(t.id)) return true;
            const scr = stripAnsi(hub.readTerm(t, 40).join('\n'));
            const block = sessionStartupBlock(scr);
            if (block === 'hooks-menu') {
              await dismissProjectHookMenu(hub, t, scr);
              return false;
            }
            if (terminalConfirmationMessage(block)) confirmationSeen = true;
            if (block === 'term-dumb' || confirmationSeen) return true;
            return hub.inputReady(t);
          };
          let ready = await hub.waitFor(readyOrBlocked, 45000, 600);
          if (confirmationSeen) {
            confirmationSeen = false;
            ready = await hub.waitFor(async () => {
              const scr = stripAnsi(hub.readTerm(t, 40).join('\n'));
              if (terminalConfirmationMessage(sessionStartupBlock(scr))) return t.exited !== null || !hub.terms.has(t.id);
              return readyOrBlocked();
            }, 300000, 600);
          }
          if (!hub.terms.has(t.id)) return;
          const scr = stripAnsi(hub.readTerm(t, 40).join('\n'));
          const block = sessionStartupBlock(scr);
          if (block === 'hooks-menu') throw new Error(HOOK_MENU_MESSAGE);
          const confirmation = terminalConfirmationMessage(block);
          if (confirmation) throw new Error(confirmation);
          if (block === 'term-dumb') throw new Error(DUMB_TERMINAL_MESSAGE);
          if (!ready || t.exited !== null || block) throw new Error('CLI가 작업 입력을 받을 준비가 되지 않았습니다.');
          t._projectHookEscapeSent = false;
          const cli = hub.agentOf(t) || 'claude';
          const dispatchedAt = Date.now();
          if (cli === 'codex') {
            t._projectBusySeen = await dispatchCodexProjectPrompt(hub, t, rawPrompt, { submitDraft });
            t._projectDispatchedAt = dispatchedAt;
            return;
          }
          const writes = [];
          const write = (data) => {
            const block = sessionStartupBlock(stripAnsi(hub.readTerm(t, 40).join('\n')));
            if (block === 'hooks-menu') throw new Error(HOOK_MENU_MESSAGE);
            const confirmation = terminalConfirmationMessage(block);
            if (confirmation) throw new Error(confirmation);
            const pending = writeProjectTerm(hub, t, data).catch((e) => e.message || String(e));
            writes.push(pending);
          };
          const outcome = await dispatchImmediatePrompt({
            cli,
            isBusy: () => (cli === 'agy' ? hub.agyStatus(t) : hub.claudeStatus(t)) === 'busy',
            readNormLines: (n) => stripAnsi(hub.readTerm(t, n).join('\n')),
            write,
            sleep: hub.sleep,
            text: rawPrompt,
            submitDelay: hub.SUBMIT_DELAY,
          });
          if (!outcome?.handled && t.exited === null) {
            write(rawPrompt);
            await hub.sleep(hub.SUBMIT_DELAY + Math.min(2500, Math.floor(rawPrompt.length / 2)));
            if (t.exited === null) write('\r');
          }
          const error = (await Promise.all(writes)).find(Boolean);
          if (error || t.exited !== null) throw new Error(error || 'CLI가 작업 입력 중 종료되었습니다.');
          if (!await hub.waitFor(() => projectRunStarted(hub, t, dispatchedAt), 8000, 200)) throw new Error(PROJECT_START_MESSAGE);
          t._projectBusySeen = true;
          t._projectDispatchedAt = dispatchedAt;
        })().catch((e) => {
          const latest = projects.list().find((p) => p.id === projectTask.projectId);
          if (hub.terms.has(t.id) && latest?.tasks.some((x) => x.id === projectTask.taskId && x.stage === 'doing')) {
            projects.save({ ...latest, tasks: latest.tasks.map((x) => x.id === projectTask.taskId
              ? { ...x, stage: 'doing', reviewPaused: true, reviewStatus: 'error', reviewNote: [e.message, x.reviewNote].filter(Boolean).join('\n\n') } : x) });
            overviewStale();
          }
          return e.message || String(e);
        }).catch((e) => {
          console.error('[project-dispatch]', e.message);
          return e.message || String(e);
        }).finally(() => { t._projectDispatchPending = false; });
      }
    }
    return send(res, 200, { ...hub.termInfo(t), ...(projectRefsBlock ? { refsBlock: projectRefsBlock } : {}), ...(retry ? { restarted: true } : {}) });
  }

  hub.startProjectTaskById = async (projectId, taskId, { autoDispatch = true, resume = '', rawPrompt: overridePrompt = '' } = {}) => {
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
    const refsBlock = project && hub.projectRefs?.promptBlock ? hub.projectRefs.promptBlock(project.id) : '';
    if (refsBlock) rawParts.push(refsBlock);
    const rawPrompt = overridePrompt || rawParts.filter(Boolean).join('\n\n');

    await handleStartOrNewTerm(
      '/api/projects/start',
      { _autoDispatch: autoDispatch, _rawPrompt: rawPrompt, resume },
      null,
      async () => ({ projectId, taskId, _autoDispatch: autoDispatch, _rawPrompt: rawPrompt, resume }),
      (_res, code, data) => { status = code; payload = data; }
    );
    if (status >= 400) return { error: payload?.error || `HTTP ${status}` };
    if (autoDispatch && overridePrompt && payload?.id) {
      if (payload.existing) return { error: '터미널 입력을 확인하지 못했습니다.' };
      const error = await hub.terms.get(payload.id)?._projectDispatchResult;
      if (error) return { error };
    }
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
      const owners = projects.sessionOwners();
      const raw = index.ready ? index.recent(n, auto, agent, hidden, owners) : recentSessions(n).filter((s) => !hidden.has(s.sessionId) && (!agent || (s.agent || 'claude') === agent));
      const sessions = raw.map((s) => {
        const branch = conversationBranches.branchMetaFor({ sessionId: s.sessionId, lookupTitleFn: (id) => sessionDisplayTitle(id, index.get(id)) });
        const customTitle = conversationBranches.getTitle(s.sessionId);
        const fallbackBranchTitle = branch?.isBranch ? (branch.branchTitle || (branch.parentTitle ? `(분기) ${String(branch.parentTitle).slice(0, 36)}` : null)) : null;
        const owner = owners.get(s.sessionId) || owners.get(branch?.parentSessionId);
        return { ...s, title: customTitle || fallbackBranchTitle || s.title, projectId: owner?.projectId, ...(branch ? { branch } : {}) };
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
      const id = String(b.id || '').trim();
      const termId = b.termId != null && b.termId !== '' ? String(b.termId) : '';
      const title = String(b.title || '').trim().slice(0, 140);
      if (id && !validSessionId(id)) { send(res, 400, { error: '대화 ID가 올바르지 않습니다.' }); return true; }
      if (!id && !termId) { send(res, 400, { error: '대화 ID 또는 터미널 ID가 필요합니다.' }); return true; }
      let saved = title || null;
      if (id) {
        saved = conversationBranches.setTitle(id, title);
        const d = index.get(id);
        if (d) {
          d.title = saved || d.title;
          if ((d.agent || 'claude') === 'claude' && d.file && fs.existsSync(d.file) && saved) {
            try { fs.appendFileSync(d.file, JSON.stringify({ type: 'custom-title', customTitle: saved, sessionId: id }) + '\n', 'utf8'); } catch {}
          }
        }
      }
      const targets = [...hub.terms.values()].filter((t) => (termId && String(t.id) === termId) || (id && hub.termSessionId(t) === id));
      for (const t of targets) {
        t.meta = { ...(t.meta || {}), customTitle: saved || '' };
        if (saved) t.title = saved;
        if (saved) t.meta.title = saved;
        hub.ptyPost?.(t.id, '/meta', { id: t.id, meta: { customTitle: saved || '', ...(saved ? { title: saved } : {}) } });
        const tSid = !id ? hub.termSessionId(t) : '';
        if (tSid) saved = conversationBranches.setTitle(tSid, title);
      }
      overviewStale();
      send(res, 200, { ok: true, title: saved });
      return true;
    }
    if ((p === '/api/transcript/fork' || p === '/api/transcript/edit') && req.method === 'POST') {
      await handleForkOrEdit(p, req, res, body, send);
      return true;
    }
    if (p === '/api/transcript/sidechat' && req.method === 'POST') {
      const b = await body(req);
      const id = String(b.sessionId || '').trim();
      const selectedText = String(b.selectedText || '').trim().slice(0, 3000);
      const question = String(b.question || '').trim().slice(0, 2000);
      if (!question) { send(res, 400, { error: '질문을 입력하세요.' }); return true; }
      const d = id ? index.get(id) : null;
      const fallback = (!d && id) ? transcript(id, 40) : null;
      const msgs = d?.msgs || fallback?.messages || [];
      const agent = ['claude', 'codex', 'agy'].includes(b.agent) ? b.agent : (d?.agent || 'claude');
      const cwd = (d?.cwd && fs.existsSync(d.cwd)) ? d.cwd : os.homedir();
      const normSel = selectedText.replace(/\s+/g, ' ').slice(0, 80);
      let ctxMsgs = msgs.slice(-8);
      if (normSel) {
        const hitIdx = msgs.findIndex((m) => String(m.text || '').replace(/\s+/g, ' ').includes(normSel));
        if (hitIdx >= 0) ctxMsgs = msgs.slice(Math.max(0, hitIdx - 2), Math.min(msgs.length, hitIdx + 3));
      }
      const ctxText = ctxMsgs.map((m) => `[${m.role}] ${String(m.text || '').slice(0, 900)}`).join('\n\n');
      const histText = Array.isArray(b.history) && b.history.length
        ? b.history.slice(-6).map((h) => `[${h.role === 'user' ? 'User' : 'Assistant'}] ${String(h.text || '').slice(0, 800)}`).join('\n')
        : '';
      const prompt = [
        'Answer the user question concisely based on the selected excerpt and conversation context below. Do not modify files or run tools.',
        ctxText ? `[기존 대화 맥락 발췌]\n${ctxText}` : '',
        selectedText ? `[사용자가 드래그해 선택한 부분]\n${selectedText}` : '',
        histText ? `[사이드 채팅 이전 질문/답변]\n${histText}` : '',
        `[질문]\n${question}`,
      ].filter(Boolean).join('\n\n');
      try {
        let reply = '';
        if (agent === 'codex') {
          const outFile = path.join(os.tmpdir(), `sidechat-${crypto.randomUUID()}.txt`);
          try {
            const { args, cmd } = hub.codexLaunch(['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '--color', 'never', '-o', outFile, '-']);
            const { stdout } = await spawnCli(cmd, args, { cwd, env: process.env, timeoutMs: 90_000, stdinText: prompt });
            reply = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8').trim() : stripAnsi(stdout).trim();
          } finally { fs.rmSync(outFile, { force: true }); }
        } else if (agent === 'agy') {
          const logFile = path.join(os.tmpdir(), `sidechat-agy-${crypto.randomUUID()}.log`);
          let convId = '';
          try {
            const agyPrompt = prompt.length > 20_000 ? `${prompt.slice(0, 20_000)}\n...(truncated)` : prompt;
            const { stdout } = await spawnCli(hub.agyExe(), ['--mode', 'plan', '--dangerously-skip-permissions', '--disable-slash-commands', '--print', agyPrompt, '--output-format', 'json', '--log-file', logFile], { cwd, env: process.env, timeoutMs: 90_000 });
            try {
              const parsed = JSON.parse(stdout.slice(stdout.indexOf('{'), stdout.lastIndexOf('}') + 1));
              convId = parsed.conversation_id || '';
              reply = String(parsed.response || parsed.result || '').trim();
            } catch { reply = stripAnsi(stdout).trim(); }
          } finally {
            fs.rmSync(logFile, { force: true });
            if (convId && hub.deleteCliRecord) {
              try { await hub.deleteCliRecord({ sessionId: convId, agent: 'agy' }); } catch {}
            }
          }
        } else {
          const { stdout } = await spawnCli('claude.exe', ['--print', '--no-session-persistence', '--tools', '', '--output-format', 'text'], { cwd, env: process.env, timeoutMs: 90_000, stdinText: prompt });
          reply = stripAnsi(stdout).trim();
        }
        send(res, 200, { ok: true, reply: reply || '(응답 없음)', agent });
      } catch (e) {
        send(res, 502, { ok: false, error: e.message || '사이드 채팅 응답 생성 실패' });
      }
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
      if (b.submit || b.immediate || b.text) {
        const screen = hub.readTerm(t, 12).join('\n');
        const confirmation = terminalConfirmationMessage(sessionStartupBlock(stripAnsi?.(screen) || screen));
        if (confirmation) {
          send(res, 409, { ok: false, error: confirmation }); return true;
        }
      }
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
      if (b.text) { hub.termMonitor?.onInput(t, b.text); t.proc.write(b.text); }
      for (const k of b.keys || []) {
        if (!(k in PTY_KEYS)) { send(res, 400, { ok: false, error: `unknown key ${k}; one of ${Object.keys(PTY_KEYS)}` }); return true; }
        hub.termMonitor?.onInput(t, PTY_KEYS[k]);
        t.proc.write(PTY_KEYS[k]);
      }
      if (b.submit) { await hub.sleep(b.fromTerminalInput && b.text ? hub.SUBMIT_DELAY + Math.min(3000, b.text.length * 2) : hub.SUBMIT_DELAY); hub.termMonitor?.onInput(t, '\r'); t.proc.write('\r'); }
      send(res, 200, { ok: true, immediate: !!b.immediate });
      return true;
    }
    if (p === '/api/term/external' && req.method === 'POST') {
      const b = await body(req); const d = b.resume ? index.get(b.resume) : null;
      const cwd = b.cwd || d?.cwd || os.homedir(), kind = b.kind || d?.agent || 'claude', yolo = b.skipPermissions !== false;
      let cmd, args = [];
      if (kind === 'codex') ({ cmd, args } = hub.codexLaunch([...(yolo ? ['--dangerously-bypass-approvals-and-sandbox'] : []), ...cliModelEffortArgs('codex', b.model, b.effort), ...(b.resume ? ['resume', b.resume] : [])]));
      else if (kind === 'agy') { cmd = hub.agyExe(); if (b.resume) args.push('--conversation', b.resume); if (yolo) args.push('--dangerously-skip-permissions'); args.push(...cliModelEffortArgs('agy', b.model, b.effort)); }
      else if (kind === 'cursor') { const ca = [config.cursorAgent, path.join(os.homedir(), 'AppData', 'Local', 'cursor-agent', 'cursor-agent.cmd')].find((f) => f && fs.existsSync(f)) || 'cursor-agent.cmd'; cmd = 'cmd.exe'; args = ['/c', ca, ...(b.resume ? ['--resume', b.resume] : [])]; }
      else if (kind === 'cmd') { cmd = 'cmd.exe'; }
      else if (kind === 'powershell') { cmd = 'powershell.exe'; args = ['-NoLogo']; }
      else if (kind === 'pwsh') { cmd = ['C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'pwsh.exe'].find((f) => f === 'pwsh.exe' || fs.existsSync(f)); args = ['-NoLogo']; }
      else if (kind === 'ubuntu') { cmd = 'wsl.exe'; args = []; }
      else if (kind === 'gitbash') { cmd = ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe', 'bash.exe'].find((f) => f === 'bash.exe' || fs.existsSync(f)); args = ['--login', '-i']; }
      else { cmd = 'claude.exe'; if (b.resume) args.push('--resume', b.resume); if (yolo) args.push('--dangerously-skip-permissions'); args.push(...cliModelEffortArgs('claude', b.model, b.effort)); }
      send(res, 200, hub.launchExternalWindow({ cwd, title: `${kind} ${b.resume ? b.resume.slice(0, 8) : ''}`.trim(), cmd, args, openMode: b.openMode || 'external', admin: !!b.admin }));
      return true;
    }
    if ((p === '/api/term/new' || p === '/api/projects/start') && req.method === 'POST') {
      const draft = await body(req);
      const key = p === '/api/projects/start' && draft.retry === true ? `${draft.projectId}:${draft.taskId}` : '';
      if (key && restartingTasks.has(key)) { send(res, 409, { error: '작업을 다시 시작하는 중입니다.' }); return true; }
      if (key) restartingTasks.add(key);
      try { await handleStartOrNewTerm(p, req, res, async () => draft, send); }
      finally { if (key) restartingTasks.delete(key); }
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
      if (t) {
        const pt = t.meta?.projectTask;
        if (pt && ![...hub.terms.values()].some((other) => other !== t && other.exited === null
          && other.meta?.projectTask?.projectId === pt.projectId && other.meta.projectTask.taskId === pt.taskId
          && (other._projectDispatchPending || other._projectDispatchedAt))) {
          const project = projects.list().find((x) => x.id === pt.projectId);
          if (project?.tasks.some((x) => x.id === pt.taskId && x.stage === 'doing')) {
            projects.save({ ...project, tasks: project.tasks.map((x) => x.id === pt.taskId ? { ...x, reviewPaused: true } : x) });
          }
        }
        hub.rememberProjectTerm(t);
        hub.forgetTerm(t);
        overviewStale();
      }
      send(res, 200, { ok: true });
      return true;
    }

    return false;
  }

  return { liveSessions, transcript, overviewStale, overviewSnapshot, handleSessionRoutes };
}

module.exports = { createSessionRoutes };
