'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const { resolveTaskConfig } = require('./project-harness');
const { runProjectAutopilot } = require('./project-autopilot');

const projectAgents = ['codex', 'claude', 'agy', 'cursor'];

/** Create project CRUD, workspace filesystem, planning, sub-chat, and floorplan routes. */
function createProjectRoutes(hub) {
  const {
    baseDir, config, projects, index, accountPrefs, unifiedVault,
    deleteCliRecord, recordUuid, cleanModelEffort,
    generatePlan, generateSubtasks, inspectWorkspace, scanFloorplan, runTaskSubChatTurn,
    ownedRoots, verifiedRoot, probeRoot, stopTerminal, pickDirectory,
  } = hub;

  const PROJECTS_DIR = path.resolve(config.projectsDir || path.join(baseDir, '..', 'projects'));
  let projectPlanning = false;
  let projectPlanState = { active: false, agent: '', name: '', startedAt: 0, stage: '', pct: 0, logs: [] };
  const taskChatActive = new Map();
  const pendingPlanRecords = new Map();
  const deletingProjects = new Set();

  function isInsideProjectsDir(dir) {
    if (!dir || !path.isAbsolute(dir)) return false;
    const resolved = path.resolve(dir).toLowerCase();
    const base = PROJECTS_DIR.toLowerCase();
    return resolved === base || resolved.startsWith(base + path.sep);
  }

  function ensureProjectDir(dir) {
    if (isInsideProjectsDir(dir)) {
      try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    }
  }

  function assertNoProjectGpu(pids, table) {
    for (const job of hub.gpuQ().snapshot().active) {
      const roots = [job.holderPid, job.childPid, job.requester?.pid, ...(job.holderPids || [])].filter(Boolean);
      if (roots.some((pid) => {
        for (let i = 0; pid && i < 30; i++, pid = table.get(pid)?.ppid) if (pids.has(pid)) return true;
        return false;
      })) throw new Error('Project 터미널의 GPU 작업이 실행 중입니다. 작업이 끝나면 삭제할 수 있습니다.');
    }
  }

  function assertNoOtherSession(projectId, ownPids) {
    const active = new Set(hub.liveSessions().filter((s) => !ownPids.has(s.pid)).map((s) => s.sessionId));
    for (const t of hub.terms.values()) {
      if (t.exited !== null || t.meta.projectTask?.projectId === projectId) continue;
      if (t.meta.projectTask) active.add(hub.projectRecord(t));
      else if (hub.isAgyTerm(t)) active.add(hub.agySessionOf(t));
      else if (hub.isCodexTerm(t)) {
        const args = t.meta.args || [];
        const resume = args.indexOf('resume');
        if (resume >= 0 && recordUuid(args[resume + 1])) active.add(args[resume + 1]);
      }
    }
    if (projects.records(projectId).some((id) => active.has(id))) {
      throw new Error('연결된 대화가 다른 터미널에서 실행 중입니다. 다른 터미널은 그대로 유지했습니다.');
    }
  }

  async function projectStopTargets(termsToClose) {
    if (!termsToClose.length) return [];
    const ptyHostPid = hub.getPtyHostPid();
    const [host, table] = await Promise.all([hub.ptyCall('/info'), hub.procTable()]);
    if (!table || host.pid !== ptyHostPid || !Array.isArray(host.terms)) {
      throw new Error('Project 터미널 소유자를 확인할 수 없습니다.');
    }
    const children = [...table].filter(([, p]) => p.ppid === host.pid).map(([pid]) => pid);
    const processes = await hub.procInfo(children, true);
    const seen = new Set();
    const targets = [];
    for (const term of termsToClose) {
      const hostTerm = host.terms.find((t) => t.id === term.id);
      if (hostTerm && hostTerm.exited !== null) { term.exited = hostTerm.exited; continue; }
      const exe = path.basename(term.meta.cmd || '').toLowerCase();
      if (!hostTerm?.pid && children.some((pid) => !processes.get(pid) && table.get(pid)?.name?.toLowerCase() === exe && hub.pidAlive(pid))) {
        throw new Error(`터미널 ${term.id}의 실행 정보가 일시적으로 확인되지 않습니다. 잠시 후 다시 삭제해 주세요.`);
      }
      let root = verifiedRoot(term, hostTerm, host.pid, processes);
      if (!root && hostTerm && !hostTerm.pid) {
        root = await probeRoot(ownedRoots(term, hostTerm, host.pid, processes), hostTerm.cols, {
          readWidth: async (pid) => (await hub.helperCall({ op: 'read', pid, lines: 1 })).width,
          resize: async (cols) => {
            if (hub.terms.get(term.id) !== term || hub.getPtyHostPid() !== host.pid) throw new Error('종료 대상 터미널이 변경되었습니다.');
            const result = await hub.ptyPost(term.id, '/resize', { id: term.id, cols, rows: hostTerm.rows });
            if (!result?.ok) throw new Error('종료 대상 터미널의 크기를 확인할 수 없습니다.');
          },
          wait: (predicate) => hub.waitFor(predicate, 1800, 180),
        });
      }
      if (!root || seen.has(root.pid)) throw new Error(`터미널 ${term.id}의 실행 프로세스를 확인할 수 없어 자동 종료하지 않았습니다.`);
      seen.add(root.pid);
      targets.push({ term, root });
    }
    assertNoProjectGpu(seen, table);
    return targets;
  }

  async function closeProjectTerminal({ term, root }) {
    const alive = () => {
      if (hub.terms.get(term.id) !== term || hub.getPtyHostPid() !== root.ppid) throw new Error('종료 대상 터미널이 변경되었습니다.');
      return term.exited === null;
    };
    await stopTerminal(term, {
      alive,
      write: (data) => hub.ptyPost(term.id, '/write', { id: term.id, data }),
      wait: (ms) => hub.waitFor(() => !alive(), ms, 100),
      terminate: async () => {
        const [fresh, table] = await Promise.all([hub.procInfo([root.pid], true), hub.procTable()]);
        const current = fresh.get(root.pid);
        if (!alive()) return;
        if (!table || !current || current.start !== root.start || current.exe !== root.exe
          || current.cl !== root.cl || current.ppid !== root.ppid || current.ppid !== hub.getPtyHostPid()
          || /(?:cmd|electron|ChatGPT)\.exe$/i.test(current.exe)) {
          throw new Error(`터미널 ${term.id}가 정상 종료되지 않았습니다. 프로세스를 안전하게 확인할 수 없어 강제 종료하지 않았습니다.`);
        }
        assertNoProjectGpu(new Set([root.pid]), table);
        process.kill(root.pid);
      },
    });
  }

  async function eraseSingleRecord(id, { agentHint = null, fileHint = null, accountEnv = {} } = {}) {
    let doc = index.get(id);
    if (!doc && !fileHint) {
      await hub.refreshIndex();
      doc = index.get(id);
    }
    const fallback = !doc && !fileHint ? hub.transcript(id, 1) : null;
    const agent = doc?.agent || agentHint || fallback?.agent || null;
    const file = doc?.file || fileHint || fallback?.file || null;
    let removed = false;
    if (doc || agent === 'agy' || (agent && file)) {
      removed = await deleteCliRecord({ id, agent, file }, {
        claudeRoot: index.root, agyRoots: index.agyRoot, codexExe: hub.codexExe(),
        env: { ...hub.cleanEnv(), ...accountEnv },
      });
      index.docs.delete(id);
      index.dirty = true;
    }
    projects.hide(id);
    hub.overviewStale();
    return removed;
  }

  async function eraseProject(p, stopRunning) {
    const members = [...hub.terms.values()].filter((t) => t.meta.projectTask?.projectId === p.id);
    const running = members.filter((t) => t.exited === null);
    if (running.length && stopRunning !== true) throw new Error('터미널 종료를 포함해 Project 삭제를 다시 확인하세요.');
    await hub.refreshIndex();
    members.forEach(hub.rememberProjectTerm);
    const targets = await projectStopTargets(running);
    assertNoOtherSession(p.id, new Set(targets.map(({ root }) => root.pid)));
    await Promise.all(targets.map(closeProjectTerminal));
    if (targets.length) await hub.refreshIndex();
    members.forEach(hub.rememberProjectTerm);
    assertNoOtherSession(p.id, new Set());
    const ids = projects.records(p.id);
    let removed = 0;
    for (const id of ids) {
      const doc = index.get(id);
      const agent = doc?.agent || projects.recordAgent(p.id, id);
      const accountEnv = agent === 'codex' ? hub.projectAccounts.resolve(agent, projects.recordAccount(p.id, id)).env : {};
      if (await eraseSingleRecord(id, { agentHint: agent, fileHint: doc?.file, accountEnv })) removed++;
    }
    projects.remove(p.id, p.revision);
    for (const t of members) if (t.exited !== null) hub.forgetTerm(t);
    return removed;
  }

  async function handleProjectRoutes(p, url, req, res, body, send, authed) {
    if (!authed(req, url)) { send(res, 401, { error: 'bad token' }); return true; }

    if (p === '/api/projects/accounts' && req.method === 'GET') {
      const ag = url.searchParams.get('agent');
      if (ag === 'agy' && hub.agySwap.available() && !(hub.agySwap.getFast().accounts || []).length) {
        await hub.agySwap.refresh({ force: false }).catch(() => {});
      }
      send(res, 200, { accounts: hub.projectAccounts.list(ag) });
      return true;
    }

    if (p === '/api/fs/dirs' && req.method === 'GET') {
      const reqPath = (url.searchParams.get('path') || '').trim();
      const workspaceParent = path.resolve(baseDir, '..', '..');
      let cur = reqPath && path.isAbsolute(reqPath) ? path.resolve(reqPath) : workspaceParent;
      if (!fs.statSync(cur, { throwIfNoEntry: false })?.isDirectory()) {
        const up = reqPath ? path.dirname(path.resolve(reqPath)) : '';
        cur = (up && fs.statSync(up, { throwIfNoEntry: false })?.isDirectory()) ? up : (fs.existsSync(workspaceParent) ? workspaceParent : os.homedir());
      }
      const parent = cur !== path.parse(cur).root ? path.dirname(cur) : null;
      const drives = [];
      for (const ch of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
        const drv = `${ch}:\\`;
        try { if (fs.existsSync(drv)) drives.push(drv); } catch {}
      }
      const skipNames = new Set(['$recycle.bin', 'system volume information', 'node_modules', '.git', '__pycache__', '.venv']);
      const dirs = [], files = [];
      try {
        for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
          if (skipNames.has(e.name.toLowerCase())) continue;
          if (e.isDirectory()) {
            if (e.name.startsWith('.')) continue;
            const full = path.join(cur, e.name);
            const subMarkers = [];
            try {
              if (fs.existsSync(path.join(full, '.git'))) subMarkers.push('Git');
              if (fs.existsSync(path.join(full, 'package.json'))) subMarkers.push('Node.js');
              if (fs.existsSync(path.join(full, 'pyproject.toml')) || fs.existsSync(path.join(full, 'requirements.txt'))) subMarkers.push('Python');
            } catch {}
            dirs.push({ name: e.name, path: full, markers: subMarkers });
          } else if (e.isFile() && files.length < 40) files.push(e.name);
        }
        dirs.sort((a, b) => (b.markers.length - a.markers.length) || a.name.localeCompare(b.name, 'ko'));
      } catch {}

      const quickSet = new Map();
      const addQuick = (pStr, label, kind) => {
        if (!pStr || !path.isAbsolute(pStr)) return;
        const norm = path.resolve(pStr);
        const key = norm.toLowerCase();
        if (quickSet.has(key)) return;
        const st = fs.statSync(norm, { throwIfNoEntry: false });
        if (!st?.isDirectory() && norm !== PROJECTS_DIR) return;
        quickSet.set(key, { path: norm, label: label || path.basename(norm) || norm, kind });
      };
      addQuick(workspaceParent, `${path.basename(workspaceParent)} (상위 폴더)`, 'workspace');
      addQuick(PROJECTS_DIR, 'Agent CLI Hub / projects (내부 폴더)', 'internal');
      for (const pr of projects.list()) addQuick(pr.cwd, `${pr.name} (${path.basename(pr.cwd)})`, 'project');
      const rec = index.ready ? index.recent(50, false, '', projects.hidden()) : [];
      for (const r of rec) { if (r.cwd) addQuick(r.cwd, path.basename(r.cwd) || r.cwd, 'recent'); if (quickSet.size >= 14) break; }
      addQuick(os.homedir(), '홈 폴더', 'home');

      const info = inspectWorkspace(cur);
      const targetInfo = reqPath && path.isAbsolute(reqPath) ? inspectWorkspace(path.resolve(reqPath)) : info;
      send(res, 200, {
        host: os.hostname(), current: cur, parent, drives, dirs: dirs.slice(0, 150), files, quick: [...quickSet.values()],
        info: { exists: info.exists, isExistingProject: info.isExistingProject, fileCount: info.fileCount, markers: info.markers },
        targetInfo: { exists: targetInfo.exists, isExistingProject: targetInfo.isExistingProject, fileCount: targetInfo.fileCount, markers: targetInfo.markers, isInternal: isInsideProjectsDir(reqPath || cur) },
      });
      return true;
    }

    if (p === '/api/fs/mkdir' && req.method === 'POST') {
      const b = await body(req);
      const parent = String(b.parent || '').trim();
      const name = String(b.name || '').trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, '');
      if (!parent || !path.isAbsolute(parent) || !name) { send(res, 400, { error: '상위 폴더와 새 폴더 이름을 확인하세요.' }); return true; }
      const target = path.join(path.resolve(parent), name);
      try { fs.mkdirSync(target, { recursive: true }); send(res, 200, { ok: true, path: target }); }
      catch (e) { send(res, 400, { error: `폴더를 생성하지 못했습니다: ${e.message}` }); }
      return true;
    }

    if (p === '/api/fs/pick-dir' && req.method === 'POST') {
      const b = await body(req);
      const result = await pickDirectory({ initialPath: b.path, fallbackDir: path.resolve(baseDir, '..', '..'), title: '작업할 프로젝트 폴더를 선택하세요' });
      send(res, 200, { ok: result.ok, path: result.path || null, cancelled: !!result.cancelled, ...(result.error ? { error: result.error } : {}) });
      return true;
    }

    if (p === '/api/fs/open-dir' && req.method === 'POST') {
      const b = await body(req);
      const raw = String(b.path || '').trim();
      const target = raw && path.isAbsolute(raw) ? path.resolve(raw) : '';
      if (!target || !fs.statSync(target, { throwIfNoEntry: false })?.isDirectory()) {
        send(res, 404, { error: '열 폴더를 찾을 수 없습니다.' });
        return true;
      }
      const opener = process.platform === 'win32' ? 'explorer.exe' : (process.platform === 'darwin' ? 'open' : 'xdg-open');
      spawn(opener, [target], { detached: true, stdio: 'ignore' }).unref();
      send(res, 200, { ok: true, path: target });
      return true;
    }

    if (p === '/api/projects/autopilot/complete' && req.method === 'POST') {
      const b = await body(req);
      const project = projects.list().find((x) => x.id === b.projectId);
      const task = project?.tasks.find((x) => x.id === b.taskId);
      if (!project || !task) { send(res, 404, { error: 'Project 작업을 찾을 수 없습니다.' }); return true; }
      if (!project.autopilot) { send(res, 200, { ok: true, skipped: true, started: [] }); return true; }
      let updated = project;
      if (task.stage !== 'done') {
        const nextTasks = project.tasks.map((t) => (t.id === task.id ? { ...t, stage: 'done' } : t));
        updated = projects.save({ ...project, tasks: nextTasks });
      }
      const autoRes = await runProjectAutopilot(hub, updated.id, { autoDispatch: true });
      send(res, 200, { ok: true, project: hub.projects.list().find((x) => x.id === updated.id) || updated, started: autoRes.started });
      return true;
    }

    if (p === '/api/projects/harness') {
      if (req.method === 'GET') {
        send(res, 200, { ok: true, harness: hub.projectHarness.get() });
        return true;
      }
      if (req.method === 'POST') {
        const b = await body(req);
        const next = b?.action === 'reset'
          ? hub.projectHarness.reset()
          : hub.projectHarness.save({ roles: b?.roles, adapters: b?.adapters });
        send(res, 200, { ok: true, harness: next });
        return true;
      }
      send(res, 405, { error: 'method not allowed' });
      return true;
    }

    if (p === '/api/projects/cli-options' && req.method === 'GET') {
      send(res, 200, { options: hub.projectCliOptions(), accountPrefs: accountPrefs.get() });
      return true;
    }

    if (p === '/api/account-prefs') {
      if (req.method === 'GET') { send(res, 200, { ok: true, ...accountPrefs.get() }); return true; }
      if (req.method === 'POST') {
        const b = await body(req);
        send(res, 200, { ok: true, ...accountPrefs.save({ account: b.account, agent: b.agent, model: b.model, effort: b.effort }) });
        return true;
      }
      send(res, 405, { error: 'method not allowed' });
      return true;
    }

    if (p === '/api/projects/floorplan' && req.method === 'GET') {
      const pid = url.searchParams.get('id') || '';
      const rawCwd = url.searchParams.get('cwd') || '';
      const proj = pid ? projects.list().find((x) => x.id === pid) : null;
      const targetDir = rawCwd || proj?.cwd || '';
      if (!targetDir) { send(res, 400, { error: '분석할 작업 폴더를 찾을 수 없습니다.' }); return true; }
      send(res, 200, { ok: true, floorplan: scanFloorplan(targetDir) });
      return true;
    }

    if (p === '/api/projects/floorplan/report' && req.method === 'POST') {
      const b = await body(req);
      const proj = b.projectId ? projects.list().find((x) => x.id === b.projectId) : null;
      const targetDir = path.resolve(String(b.cwd || proj?.cwd || ''));
      if (!targetDir || !fs.statSync(targetDir, { throwIfNoEntry: false })?.isDirectory()) {
        send(res, 400, { error: '보고서를 저장할 작업 폴더를 찾을 수 없습니다.' });
        return true;
      }
      const rawName = path.basename(String(b.filename || 'FLOORPLAN.md')).replace(/[^a-zA-Z0-9._가-힣-]+/g, '-');
      const fileName = /\.md$/i.test(rawName) ? rawName : `${rawName || 'FLOORPLAN'}.md`;
      const outPath = path.join(targetDir, fileName);
      const content = String(b.content || '').trim();
      if (!content) { send(res, 400, { error: '저장할 보고서 내용이 비어 있습니다.' }); return true; }
      fs.writeFileSync(outPath, content + '\n', 'utf8');
      let pinned = false;
      if (b.sessionId) pinned = !!hub.artifactsMod.pinFile(String(b.sessionId), outPath, `코드 아키텍처 보고서 (${fileName})`);
      send(res, 200, { ok: true, path: outPath, fileName, pinned });
      return true;
    }

    if (p === '/api/projects/subtasks' && req.method === 'POST') {
      const b = await body(req);
      if (projectPlanning) { send(res, 409, { error: '작업 흐름을 생성 중입니다. 잠시 기다려 주세요.' }); return true; }
      const project = projects.list().find((x) => x.id === b.projectId);
      const task = project?.tasks.find((x) => x.id === b.taskId);
      if (!project || !task) { send(res, 404, { error: 'Project 작업을 찾을 수 없습니다.' }); return true; }
      const effAgent = b.agent || task.agent || project.agent || 'codex';
      if (!['agy', 'claude', 'codex'].includes(effAgent)) { send(res, 400, { error: '서브 작업 자동 분해는 AGY, Claude Code 또는 Codex에서 지원됩니다.' }); return true; }
      const effAccount = b.account ?? task.account ?? (effAgent === (project.agent || 'codex') ? project.account : '');
      const effModel = b.model ?? (task.model || (effAgent === (project.agent || 'codex') ? project.model : ''));
      const effEffort = b.effort ?? (task.effort || (effAgent === (project.agent || 'codex') ? project.effort : ''));
      let auth;
      try { auth = hub.projectAccounts.resolve(effAgent, effAccount); } catch (e) { send(res, 400, { error: e.message }); return true; }
      projectPlanning = true;
      projectPlanState = { active: true, agent: effAgent, name: task.title, startedAt: Date.now(), stage: '서브 작업 분해 준비 중…', pct: 8, logs: [] };
      const onProgress = (ev) => {
        if (!ev) return;
        if (ev.stage) projectPlanState.stage = ev.stage;
        if (typeof ev.pct === 'number') projectPlanState.pct = Math.max(projectPlanState.pct, Math.min(98, ev.pct));
        if (ev.log) projectPlanState.logs = [...projectPlanState.logs, ev.log].slice(-6);
      };
      let dir;
      try {
        await hub.ensureAgySwap(auth);
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-project-sub-'));
        const exe = effAgent === 'agy' ? hub.agyExe() : effAgent === 'claude' ? 'claude.exe' : hub.codexExe();
        try { unifiedVault.prepareLaunch(effAgent, { resume: false }); } catch {}
        const { tasks, sessionId } = await generateSubtasks(exe, project, task, dir, { ...hub.cleanEnv(), ...auth.env }, { agent: effAgent, model: effModel, effort: effEffort, onProgress });
        if (recordUuid(sessionId)) projects.remember([{ projectId: project.id, taskId: task.id, sessionId, agent: effAgent }]);
        projectPlanState.stage = `서브 작업 ${tasks.length}개 생성 완료`;
        projectPlanState.pct = 100;
        send(res, 200, { tasks });
      } catch (e) {
        console.error('[project-subtasks]', effAgent, e.message);
        send(res, 502, { error: e.message || '서브 작업을 생성하지 못했습니다.' });
      } finally {
        projectPlanning = false;
        projectPlanState.active = false;
        if (dir) try { fs.rmdirSync(dir); } catch {}
      }
      return true;
    }

    if (p === '/api/projects/plan/status' && req.method === 'GET') {
      const st = projectPlanState;
      send(res, 200, { active: !!st.active, agent: st.agent || '', name: st.name || '', stage: st.stage || '', pct: st.pct || 0, elapsedMs: st.startedAt ? Date.now() - st.startedAt : 0, logs: st.logs || [] });
      return true;
    }

    if (p === '/api/projects/plan' && req.method === 'POST') {
      const b = await body(req);
      if (projectPlanning) { send(res, 409, { error: '작업 흐름을 생성 중입니다. 잠시 기다려 주세요.' }); return true; }
      if (!['agy', 'claude', 'codex'].includes(b.agent) || typeof b.goal !== 'string' || !b.goal.trim() || b.goal.length > 6000
        || typeof b.name !== 'string' || !b.name.trim() || b.name.length > 120 || typeof b.cwd !== 'string' || !b.cwd.trim() || b.cwd.length > 1000) {
        send(res, 400, { error: 'Project 이름, 작업 폴더, 목표 및 설계에 사용할 CLI를 확인하세요.' });
        return true;
      }
      let auth;
      try { auth = hub.projectAccounts.resolve(b.agent, b.account); } catch (e) { send(res, 400, { error: e.message }); return true; }
      projectPlanning = true;
      projectPlanState = { active: true, agent: b.agent, name: b.name.trim(), startedAt: Date.now(), stage: 'CLI 준비 중…', pct: 8, logs: [] };
      const onProgress = (ev) => {
        if (!ev) return;
        if (ev.stage) projectPlanState.stage = ev.stage;
        if (typeof ev.pct === 'number') projectPlanState.pct = Math.max(projectPlanState.pct, Math.min(98, ev.pct));
        if (ev.log) projectPlanState.logs = [...projectPlanState.logs, ev.log].slice(-6);
      };
      let dir;
      try {
        await hub.ensureAgySwap(auth);
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-project-plan-'));
        const exe = b.agent === 'agy' ? hub.agyExe() : b.agent === 'claude' ? 'claude.exe' : hub.codexExe();
        try { unifiedVault.prepareLaunch(b.agent, { resume: false }); } catch {}
        const { tasks, sessionId } = await generatePlan(exe, b, dir, { ...hub.cleanEnv(), ...auth.env }, { onProgress });
        projectPlanState.stage = `작업 ${tasks.length}개 생성 완료`;
        projectPlanState.pct = 100;
        const now = Date.now();
        for (const [key, record] of pendingPlanRecords) if (record.expires <= now) pendingPlanRecords.delete(key);
        if (recordUuid(sessionId)) pendingPlanRecords.set(tasks[0].id, { sessionId, agent: b.agent, expires: now + 60 * 60_000 });
        send(res, 200, { tasks });
      } catch (e) {
        console.error('[project-plan]', b.agent, e.message);
        send(res, 502, { error: e.message || '작업 흐름을 생성하지 못했습니다. 선택한 CLI의 로그인 상태를 확인하고 다시 시도하세요.' });
      } finally {
        projectPlanning = false;
        projectPlanState.active = false;
        if (dir) try { fs.rmdirSync(dir); } catch {}
      }
      return true;
    }

    if (p === '/api/projects/task-chat') {
      if (req.method === 'GET') {
        const projectId = url.searchParams.get('projectId') || '';
        const taskId = url.searchParams.get('taskId') || '';
        const act = taskChatActive.get(`${projectId}:${taskId}`) || null;
        send(res, 200, { chats: projects.listSubChats(projectId, taskId), active: act ? { ...act, elapsedMs: Date.now() - act.startedAt } : null });
        return true;
      }
      if (req.method === 'DELETE') {
        const b = await body(req);
        const removed = projects.deleteSubChat(b.projectId, b.taskId, b.chatId);
        send(res, 200, { ok: removed, chats: projects.listSubChats(b.projectId, b.taskId) });
        return true;
      }
      if (req.method === 'POST') {
        const b = await body(req);
        const project = projects.list().find((x) => x.id === b.projectId);
        const task = project?.tasks.find((x) => x.id === b.taskId);
        if (!project || !task) { send(res, 404, { error: 'Project 작업을 찾을 수 없습니다.' }); return true; }
        const prompt = String(b.prompt || '').trim();
        if (!prompt) { send(res, 400, { error: '메시지를 입력하세요.' }); return true; }
        const actKey = `${project.id}:${task.id}`;
        if (taskChatActive.has(actKey)) { send(res, 409, { error: '이 태스크의 서브 개발 응답을 생성 중입니다. 잠시 기다려 주세요.' }); return true; }

        const existingChats = projects.listSubChats(project.id, task.id);
        let chat = b.chatId ? existingChats.find((c) => c.id === b.chatId) : null;
        const harnessState = hub.projectHarness.get();
        const resolved = resolveTaskConfig(project, task, harnessState);
        const effAgent = b.agent || chat?.agent || resolved.agent || 'codex';
        if (!['claude', 'codex', 'agy'].includes(effAgent)) { send(res, 400, { error: '서브 개발 채팅은 Claude Code, Codex, Antigravity를 지원합니다.' }); return true; }
        const effAccount = b.account ?? chat?.account ?? (effAgent === resolved.agent ? resolved.account : (effAgent === (project.agent || 'codex') ? project.account : ''));
        const effModel = b.model ?? chat?.model ?? (effAgent === resolved.agent ? resolved.model : (effAgent === (project.agent || 'codex') ? project.model : ''));
        const effEffort = b.effort ?? chat?.effort ?? (effAgent === resolved.agent ? resolved.effort : (effAgent === (project.agent || 'codex') ? project.effort : ''));
        let auth;
        try { auth = hub.projectAccounts.resolve(effAgent, effAccount); } catch (e) { send(res, 400, { error: e.message }); return true; }

        ensureProjectDir(project.cwd);
        const workCwd = (project.cwd && fs.existsSync(project.cwd)) ? project.cwd : os.homedir();
        const nowIso = new Date().toISOString();
        chat = chat
          ? { ...chat, agent: effAgent, account: effAccount || '', model: effModel || '', effort: effEffort || '' }
          : { id: crypto.randomUUID(), title: prompt.split(/\r?\n/)[0].slice(0, 48) || `서브 채팅 #${existingChats.length + 1}`, agent: effAgent, account: effAccount || '', model: effModel || '', effort: effEffort || '', sessionId: '', createdAt: Date.now(), messages: [] };
        chat.messages = [...(chat.messages || []), { role: 'user', text: prompt, ts: nowIso }];
        projects.saveSubChat(project.id, task.id, chat);

        const actState = { chatId: chat.id, agent: effAgent, stage: 'CLI 실행 중…', startedAt: Date.now(), logs: [] };
        taskChatActive.set(actKey, actState);
        const exe = effAgent === 'agy' ? hub.agyExe() : effAgent === 'claude' ? 'claude.exe' : hub.codexExe();
        try {
          await hub.ensureAgySwap(auth);
          try { unifiedVault.prepareLaunch(effAgent, { resume: !!chat.sessionId }); } catch {}
          const resTurn = await runTaskSubChatTurn({
            exe, agent: effAgent, cwd: workCwd, env: { ...hub.cleanEnv(), ...auth.env },
            model: effModel, effort: effEffort, sessionId: chat.sessionId, prompt, project, task, harnessState,
            onProgress: (ev) => {
              if (ev?.stage) actState.stage = ev.stage;
              if (ev?.log) actState.logs = [...actState.logs, ev.log].slice(-5);
              if (ev?.sessionId && !chat.sessionId) chat.sessionId = ev.sessionId;
            },
          });
          if (resTurn.sessionId) chat.sessionId = resTurn.sessionId;
          chat.messages = [...chat.messages, { role: 'assistant', text: resTurn.reply, ts: new Date().toISOString() }];
          const savedChat = projects.saveSubChat(project.id, task.id, chat);
          if (chat.sessionId) {
            const doc = index.get(chat.sessionId);
            if (doc?.file) await index.updateFile(doc.file).catch(() => {});
            projects.remember([{ projectId: project.id, taskId: task.id, sessionId: chat.sessionId, agent: effAgent, accountId: effAccount || 'default', tokens: resTurn.tokens || index.get(chat.sessionId)?.tokens }]);
          }
          send(res, 200, { ok: true, chat: savedChat, chats: projects.listSubChats(project.id, task.id), tokens: projects.tokenSummary(project.id, (sid) => index.get(sid)?.tokens) });
        } catch (e) {
          chat.messages = [...chat.messages, { role: 'assistant', text: `⚠ ${e.message}`, ts: new Date().toISOString() }];
          const savedChat = projects.saveSubChat(project.id, task.id, chat);
          send(res, 502, { ok: false, error: e.message, chat: savedChat, chats: projects.listSubChats(project.id, task.id) });
        } finally {
          taskChatActive.delete(actKey);
        }
        return true;
      }
    }

    if (p === '/api/projects') {
      if (req.method === 'GET') {
        for (const t of hub.terms.values()) if (t.meta?.projectTask) hub.rememberProjectTerm(t);
        const list = projects.list().map((pr) => ({
          ...pr, tokens: projects.tokenSummary(pr.id, (sid) => index.get(sid)?.tokens), subChats: projects.allSubChats(pr.id),
        }));
        send(res, 200, { projects: list, defaultCwd: PROJECTS_DIR, harness: hub.projectHarness.get() });
        return true;
      }
      if (req.method === 'DELETE') {
        const b = await body(req);
        const project = projects.list().find((pr) => pr.id === b.id);
        if (!project || project.revision !== b.revision) { send(res, 409, { error: 'Project가 변경되었습니다. 새로고침 후 다시 삭제하세요.' }); return true; }
        if (deletingProjects.has(project.id)) { send(res, 409, { error: 'Project 기록을 삭제 중입니다.' }); return true; }
        deletingProjects.add(project.id);
        try { send(res, 200, { removed: await eraseProject(project, b.stopRunning) }); }
        catch (e) { send(res, 409, { error: e.message }); }
        finally { deletingProjects.delete(project.id); }
        return true;
      }
      if (req.method === 'POST') {
        try {
          const draft = await body(req);
          if (deletingProjects.has(draft.id)) { send(res, 409, { error: 'Project 기록을 삭제 중입니다.' }); return true; }
          const project = projects.save(draft);
          ensureProjectDir(project.cwd);
          for (const task of project.tasks) {
            const record = pendingPlanRecords.get(task.id);
            if (!record || record.expires <= Date.now()) continue;
            projects.remember([{ projectId: project.id, sessionId: record.sessionId, agent: record.agent }]);
            pendingPlanRecords.delete(task.id);
          }
          let autoStarted = [];
          if (project.autopilot) {
            const autoRes = await runProjectAutopilot(hub, project.id, { autoDispatch: true });
            autoStarted = autoRes.started || [];
          }
          const latest = projects.list().find((x) => x.id === project.id) || project;
          send(res, 200, { project: latest, autoStarted });
        } catch (e) { send(res, 400, { error: e.message }); }
        return true;
      }
      send(res, 405, { error: 'method not allowed' });
      return true;
    }

    return false;
  }

  return { deletingProjects, ensureProjectDir, eraseSingleRecord, handleProjectRoutes, projectAgents };
}

module.exports = { createProjectRoutes };
