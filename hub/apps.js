// Lightweight Apps runtime: registry CRUD, folder import, command/agent/pipeline execution,
// run lock & cancellation, output/data management, and session/chat/artifact integration.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { serve: serveFile } = require('./artifacts');

const VALID_TYPES = new Set(['report', 'url', 'command']);
const VALID_KINDS = new Set(['command', 'agent', 'pipeline']);
const ID_RE = /^[a-z0-9][a-z0-9_-]{1,47}$/;

function safeJsonRead(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function safeJsonWrite(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
}

function globToRegex(glob) {
  const g = String(glob || '*').trim() || '*';
  const esc = g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${esc}$`, 'i');
}

function resolveInside(baseDir, relPath) {
  const base = path.resolve(baseDir);
  const target = path.resolve(base, String(relPath || ''));
  if (target !== base && !target.startsWith(base + path.sep)) return null;
  return target;
}

function parseDotEnv(envPath) {
  const out = {};
  try {
    if (!fs.existsSync(envPath)) return out;
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const k = line.slice(0, eq).trim();
      let v = line.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      out[k] = v;
    }
  } catch {}
  return out;
}

function listDirFiles(dir, globPattern) {
  if (!dir || !fs.existsSync(dir)) return [];
  const re = globToRegex(globPattern || '*');
  const out = [];
  try {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!ent.isFile()) continue;
      if (!re.test(ent.name)) continue;
      const abs = path.join(dir, ent.name);
      const st = fs.statSync(abs);
      out.push({ name: ent.name, path: abs, size: st.size, mtimeMs: st.mtimeMs, mtime: new Date(st.mtimeMs).toISOString() });
    }
  } catch {}
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

function applyTemplate(str, vars) {
  return String(str || '').replace(/\{\{([a-zA-Z0-9_.-]+)\}\}/g, (_, k) => (vars[k] !== undefined ? String(vars[k]) : ''));
}

module.exports = function appsModule(deps = {}) {
  const dataFile = deps.dataFile || path.join(__dirname, 'data', 'apps.json');
  const runsFile = deps.runsFile || path.join(__dirname, 'data', 'app-runs.json');
  const secretsDir = deps.secretsDir || path.join(__dirname, 'secrets');
  const terms = deps.terms || new Map();
  const createTerm = deps.createTerm || null;
  const liveSessions = deps.liveSessions || (() => []);
  const writeInteractiveTerm = deps.writeInteractiveTerm || null;
  const artifactsMod = deps.artifactsMod || null;
  const termInfo = deps.termInfo || ((t) => ({
    id: t.id, title: t.title, cwd: t.cwd, exited: t.exited, sessionId: t.sessionId, agent: t.agent,
  }));

  const activeProcs = new Map(); // appId -> { runId, proc, cancelRequested }

  function loadStore() {
    const raw = safeJsonRead(dataFile, { version: 1, apps: [] });
    return { version: 1, apps: Array.isArray(raw.apps) ? raw.apps : [] };
  }

  function saveStore(store) {
    safeJsonWrite(dataFile, { version: 1, apps: store.apps });
  }

  function loadRuns() {
    const raw = safeJsonRead(runsFile, {});
    return raw && typeof raw === 'object' ? raw : {};
  }

  function saveRuns(runs) {
    safeJsonWrite(runsFile, runs);
  }

  function appendRun(appId, runObj) {
    const runs = loadRuns();
    const list = Array.isArray(runs[appId]) ? runs[appId] : [];
    const idx = list.findIndex((r) => r.runId === runObj.runId);
    if (idx >= 0) list[idx] = runObj;
    else list.unshift(runObj);
    runs[appId] = list.slice(0, 20);
    saveRuns(runs);
  }

  function normalizeApp(input, existing = null) {
    const id = String(input.id || existing?.id || '').trim().toLowerCase();
    if (!ID_RE.test(id)) throw new Error('앱 ID는 영문 소문자·숫자·-·_ 조합(2~48자)이어야 합니다');
    const name = String(input.name || existing?.name || '').trim();
    if (!name) throw new Error('앱 이름이 필요합니다');
    const type = String(input.type || existing?.type || 'report').trim();
    if (!VALID_TYPES.has(type)) throw new Error('앱 유형(type)은 report | url | command 중 하나여야 합니다');
    const cwd = String(input.cwd || existing?.cwd || '').trim();
    if (type !== 'url') {
      if (!cwd) throw new Error('작업 폴더(cwd)가 필요합니다');
      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
        throw new Error(`존재하지 않는 작업 폴더입니다: ${cwd}`);
      }
    }
    const actionsIn = Array.isArray(input.actions) ? input.actions : (existing?.actions || []);
    const seenActionIds = new Set();
    const actions = actionsIn.map((a, idx) => {
      const aid = String(a.id || `action-${idx + 1}`).trim();
      if (!aid || seenActionIds.has(aid)) throw new Error(`중복되거나 잘못된 액션 ID입니다: ${aid}`);
      seenActionIds.add(aid);
      const kind = String(a.kind || 'command').trim();
      if (!VALID_KINDS.has(kind)) throw new Error(`지원하지 않는 액션 kind입니다: ${kind}`);
      return {
        id: aid,
        label: String(a.label || aid).trim(),
        kind,
        cmd: String(a.cmd || '').trim(),
        prompt: String(a.prompt || '').trim(),
        params: Array.isArray(a.params) ? a.params : [],
        timeoutSec: Number(a.timeoutSec) > 0 ? Number(a.timeoutSec) : 180,
        useGpuQueue: Boolean(a.useGpuQueue),
      };
    });

    const outputsIn = input.outputs || existing?.outputs || {};
    const outputs = {
      viewDir: String(outputsIn.viewDir || '').trim(),
      viewGlob: String(outputsIn.viewGlob || '*.html').trim(),
      dataDir: String(outputsIn.dataDir || '').trim(),
      dataGlob: String(outputsIn.dataGlob || '*.json').trim(),
    };

    const sessIn = input.session || existing?.session || {};
    const session = {
      autoMatchCwd: sessIn.autoMatchCwd !== false,
      preferredAgent: String(sessIn.preferredAgent || 'claude').trim(),
      pinnedSessionId: String(sessIn.pinnedSessionId || '').trim(),
      autoPinArtifacts: sessIn.autoPinArtifacts !== false,
      notifyOnComplete: Boolean(sessIn.notifyOnComplete),
    };

    const now = new Date().toISOString();
    return {
      id,
      name,
      description: String(input.description ?? existing?.description ?? '').trim(),
      usage: String(input.usage ?? existing?.usage ?? '').trim(),
      purpose: String(input.purpose ?? existing?.purpose ?? '').trim(),
      type,
      cwd: cwd ? path.resolve(cwd) : '',
      entryUrl: String(input.entryUrl ?? existing?.entryUrl ?? '').trim(),
      env: input.env && typeof input.env === 'object' ? input.env : (existing?.env || {}),
      secretRefs: Array.isArray(input.secretRefs) ? input.secretRefs : (existing?.secretRefs || []),
      actions,
      outputs,
      session,
      schedule: input.schedule && typeof input.schedule === 'object' ? input.schedule : (existing?.schedule || { enabled: false, cron: '' }),
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
  }

  function findLinkedSession(app) {
    const pinned = app.session?.pinnedSessionId;
    const normCwd = app.cwd ? path.resolve(app.cwd).toLowerCase() : '';
    const live = liveSessions();
    let matchedTerm = null;
    let agentTerm = null;
    for (const t of terms.values()) {
      if (t.exited !== null) continue;
      const isPinned = pinned && t.sessionId === pinned;
      const sameCwd = app.session?.autoMatchCwd && normCwd && t.cwd && path.resolve(t.cwd).toLowerCase() === normCwd;
      if (!isPinned && !sameCwd) continue;
      if (isPinned || !matchedTerm) matchedTerm = t;
      if (writeInteractiveTerm && (isPinned || !agentTerm)) {
        const info = termInfo(t);
        if (info.agent && !info.startupBlock) agentTerm = info;
      }
    }
    const pinnedLive = pinned ? live.find((s) => s.sessionId === pinned) : null;
    const matchedLive = pinnedLive || live.find((s) => app.session?.autoMatchCwd && normCwd && s.cwd && path.resolve(s.cwd).toLowerCase() === normCwd);
    const displayTerm = pinnedLive && matchedTerm?.sessionId !== pinned ? null : matchedTerm;
    return {
      term: displayTerm ? termInfo(displayTerm) : null,
      actionTermId: agentTerm ? String(agentTerm.id) : null,
      live: matchedLive ? { sessionId: matchedLive.sessionId, status: matchedLive.status || 'idle', cwd: matchedLive.cwd } : null,
      sessionId: pinned || displayTerm?.sessionId || matchedLive?.sessionId || null,
      status: matchedLive?.status || (displayTerm ? 'idle' : 'offline'),
    };
  }

  function getAppFiles(app) {
    const viewAbs = app.cwd && app.outputs?.viewDir ? resolveInside(app.cwd, app.outputs.viewDir) : null;
    const dataAbs = app.cwd && app.outputs?.dataDir ? resolveInside(app.cwd, app.outputs.dataDir) : null;
    const views = viewAbs ? listDirFiles(viewAbs, app.outputs.viewGlob || '*.html') : [];
    const data = dataAbs ? listDirFiles(dataAbs, app.outputs.dataGlob || '*.json') : [];
    return { views, data, viewAbs, dataAbs };
  }

  function enrichApp(app) {
    const runs = loadRuns()[app.id] || [];
    const latestRun = runs[0] || null;
    const files = getAppFiles(app);
    const active = activeProcs.get(app.id);
    const status = active ? 'running' : (latestRun?.status === 'error' ? 'error' : 'idle');
    return {
      ...app,
      status,
      activeRunId: active?.runId || null,
      latestRun,
      latestView: files.views[0] || null,
      latestData: files.data[0] || null,
      counts: { views: files.views.length, data: files.data.length },
      linkedSession: findLinkedSession(app),
    };
  }

  function buildEnv(app, paramVars) {
    const env = { ...process.env };
    if (app.cwd) Object.assign(env, parseDotEnv(path.join(app.cwd, '.env')));
    for (const ref of app.secretRefs || []) {
      const safeName = String(ref || '').replace(/[^a-zA-Z0-9_.-]/g, '');
      if (!safeName) continue;
      const p = resolveInside(secretsDir, safeName);
      if (p && fs.existsSync(p) && fs.statSync(p).isFile()) {
        env[safeName.toUpperCase().replace(/[^A-Z0-9_]/g, '_')] = fs.readFileSync(p, 'utf8').trim();
      }
    }
    if (app.env && typeof app.env === 'object') {
      for (const [k, v] of Object.entries(app.env)) env[k] = String(v);
    }
    for (const [k, v] of Object.entries(paramVars)) {
      env[`APP_PARAM_${k.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}`] = String(v);
    }
    return env;
  }

  function autoPinOutputs(app, changedFiles) {
    if (!artifactsMod?.pinFile || app.session?.autoPinArtifacts === false) return [];
    const linked = findLinkedSession(app);
    const sid = linked.sessionId;
    if (!sid) return [];
    const pinned = [];
    for (const f of changedFiles) {
      if (artifactsMod.pinFile(sid, f.path)) pinned.push(f.path);
    }
    return pinned;
  }

  async function runAction(app, action, params = {}) {
    if (activeProcs.has(app.id)) {
      const err = new Error('이미 실행 중인 작업이 있습니다');
      err.statusCode = 409;
      throw err;
    }
    const files = getAppFiles(app);
    const paramVars = {
      ...params,
      cwd: app.cwd,
      latestViewFile: files.views[0]?.path || '',
      latestDataFile: files.data[0]?.path || '',
    };
    for (const p of action.params || []) {
      if (paramVars[p.key] === undefined && p.default !== undefined) paramVars[p.key] = p.default;
    }

    const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const runObj = {
      runId,
      appId: app.id,
      actionId: action.id,
      actionLabel: action.label,
      kind: action.kind,
      status: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      exitCode: null,
      stdout: '',
      stderr: '',
      pinnedArtifacts: [],
    };
    appendRun(app.id, runObj);

    if (action.kind === 'agent') {
      const linked = findLinkedSession(app);
      const promptText = applyTemplate(action.prompt || '', paramVars).trim();
      if (!promptText) {
        runObj.status = 'error';
        runObj.stderr = '에이전트 프롬프트가 비어 있습니다';
        runObj.finishedAt = new Date().toISOString();
        appendRun(app.id, runObj);
        return runObj;
      }
      const termObj = terms.get(linked.actionTermId);
      const delivered = termObj ? await writeInteractiveTerm(termObj, promptText + '\r').catch(() => false) : false;
      runObj.status = delivered ? 'ok' : 'error';
      if (delivered) runObj.stdout = `[세션 t:${linked.actionTermId}로 프롬프트 전달 완료]\n${promptText}`;
      else runObj.stderr = termObj ? '세션에 요청을 전달하지 못했습니다.' : '연결된 실행 중 터미널 세션이 없습니다. 먼저 세션을 열어 주세요.';
      runObj.finishedAt = new Date().toISOString();
      appendRun(app.id, runObj);
      return runObj;
    }

    // command or pipeline
    const cmdStr = applyTemplate(action.cmd || '', paramVars).trim();
    if (!cmdStr) throw new Error('실행할 명령어(cmd)가 비어 있습니다');
    const beforeFiles = getAppFiles(app);
    const proc = spawn(cmdStr, {
      cwd: app.cwd || undefined,
      env: buildEnv(app, paramVars),
      shell: true,
      windowsHide: true,
    });
    const entry = { runId, proc, cancelRequested: false };
    activeProcs.set(app.id, entry);

    const timer = setTimeout(() => {
      if (activeProcs.get(app.id)?.runId === runId) {
        entry.cancelRequested = true;
        try { proc.kill('SIGTERM'); } catch {}
      }
    }, (action.timeoutSec || 180) * 1000);
    if (timer.unref) timer.unref();

    proc.stdout.on('data', (chunk) => {
      runObj.stdout = (runObj.stdout + chunk.toString('utf8')).slice(-32000);
      appendRun(app.id, runObj);
    });
    proc.stderr.on('data', (chunk) => {
      runObj.stderr = (runObj.stderr + chunk.toString('utf8')).slice(-32000);
      appendRun(app.id, runObj);
    });
    proc.on('close', async (code) => {
      clearTimeout(timer);
      if (activeProcs.get(app.id)?.runId === runId) activeProcs.delete(app.id);
      runObj.exitCode = code;
      runObj.finishedAt = new Date().toISOString();
      runObj.status = entry.cancelRequested ? 'cancelled' : (code === 0 ? 'ok' : 'error');
      if (runObj.status === 'ok') {
        const nextFiles = getAppFiles(app);
        const before = new Map([...beforeFiles.views, ...beforeFiles.data].map((f) => [f.path, f.mtimeMs]));
        const changed = (f) => before.get(f.path) !== f.mtimeMs;
        const views = nextFiles.views.filter(changed);
        const data = nextFiles.data.filter(changed);
        runObj.outputView = views[0]?.name || null;
        runObj.pinnedArtifacts = autoPinOutputs(app, [...views.slice(0, 3), ...data.slice(0, 2)]);
        if (action.kind === 'pipeline' && action.prompt) {
          const linked = findLinkedSession(app);
          const termObj = terms.get(linked.actionTermId);
          if (termObj && writeInteractiveTerm) {
            const promptText = applyTemplate(action.prompt, {
              ...paramVars,
              latestViewFile: nextFiles.views[0]?.path || '',
              latestDataFile: nextFiles.data[0]?.path || '',
            });
            await writeInteractiveTerm(termObj, promptText + '\r').catch(() => {});
          }
        }
      }
      appendRun(app.id, runObj);
    });

    return runObj;
  }

  async function handle(p, url, req, readBody, send, res) {
    if (!p.startsWith('/api/apps')) return false;
    const store = loadStore();
    const byId = (id) => store.apps.find((a) => a.id === id);

    if (p === '/api/apps' && req.method === 'GET') {
      return send(200, { apps: store.apps.map(enrichApp) });
    }

    if (p === '/api/apps' && req.method === 'POST') {
      const b = await readBody();
      if (byId(String(b.id || '').trim().toLowerCase())) {
        return send(409, { error: `이미 등록된 앱 ID입니다: ${b.id}` });
      }
      try {
        const app = normalizeApp(b);
        store.apps.push(app);
        saveStore(store);
        return send(200, { ok: true, app: enrichApp(app) });
      } catch (e) {
        return send(400, { error: e.message });
      }
    }

    if (p === '/api/apps/import' && req.method === 'POST') {
      const b = await readBody();
      const dir = String(b.dir || '').trim();
      if (!dir || !fs.existsSync(dir)) return send(400, { error: '유효한 폴더 경로를 입력하세요' });
      const manifestPath = path.join(dir, 'app.json');
      if (!fs.existsSync(manifestPath)) return send(404, { error: '해당 폴더에 app.json 파일이 없습니다' });
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        manifest.cwd = manifest.cwd || path.resolve(dir);
        const existing = byId(String(manifest.id || '').trim().toLowerCase());
        const app = normalizeApp(manifest, existing);
        if (existing) {
          const idx = store.apps.findIndex((a) => a.id === app.id);
          store.apps[idx] = app;
        } else {
          store.apps.push(app);
        }
        saveStore(store);
        return send(200, { ok: true, app: enrichApp(app) });
      } catch (e) {
        return send(400, { error: `app.json 가져오기 실패: ${e.message}` });
      }
    }

    const m = /^\/api\/apps\/([^/]+)(?:\/(.*))?$/.exec(p);
    if (!m) return false;
    const appId = decodeURIComponent(m[1]);
    const sub = m[2] || '';
    const app = byId(appId);
    if (!app) return send(404, { error: `등록되지 않은 앱입니다: ${appId}` });

    if (!sub && req.method === 'GET') return send(200, { app: enrichApp(app) });

    if (!sub && req.method === 'PUT') {
      const b = await readBody();
      try {
        const updated = normalizeApp({ ...b, id: app.id }, app);
        const idx = store.apps.findIndex((a) => a.id === app.id);
        store.apps[idx] = updated;
        saveStore(store);
        return send(200, { ok: true, app: enrichApp(updated) });
      } catch (e) {
        return send(400, { error: e.message });
      }
    }

    if (!sub && req.method === 'DELETE') {
      const purge = url.searchParams.get('purgeOutputs') === 'true' || url.searchParams.get('purgeOutputs') === '1';
      if (activeProcs.has(app.id)) {
        return send(409, { error: '실행 중인 작업을 먼저 중단한 뒤 앱을 제거하세요' });
      }
      const removedFiles = [];
      if (purge) {
        const files = getAppFiles(app);
        for (const f of [...files.views, ...files.data]) {
          try { fs.unlinkSync(f.path); removedFiles.push(f.name); } catch {}
        }
      }
      store.apps = store.apps.filter((a) => a.id !== app.id);
      saveStore(store);
      return send(200, { ok: true, id: app.id, purgedOutputs: purge, removedFiles });
    }

    if (sub === 'export' && req.method === 'GET') {
      const os = require('os');
      const { execFileSync } = require('child_process');
      const SKIP_DIRS = new Set(['.venv', 'venv', 'node_modules', '__pycache__', '.git', '.pytest_cache', '.mypy_cache', 'secrets']);
      const SKIP_FILE_RE = /^(?:\.env(?:\..+)?|\.token|.*\.(?:key|pem|pfx|p12))$/i;
      const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ach-app-export-'));
      const stageDir = path.join(tmpRoot, app.id);
      const zipPath = path.join(tmpRoot, `${app.id}-share.zip`);
      const copySafe = (src, dst, depth = 0) => {
        if (depth > 8 || !fs.existsSync(src)) return;
        fs.mkdirSync(dst, { recursive: true });
        for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
          if (ent.isSymbolicLink()) continue;
          if (ent.isDirectory()) {
            if (SKIP_DIRS.has(ent.name)) continue;
            copySafe(path.join(src, ent.name), path.join(dst, ent.name), depth + 1);
          } else if (ent.isFile()) {
            if (SKIP_FILE_RE.test(ent.name)) continue;
            try {
              const st = fs.statSync(path.join(src, ent.name));
              if (st.size > 50 * 1024 * 1024) continue;
              fs.copyFileSync(path.join(src, ent.name), path.join(dst, ent.name));
            } catch {}
          }
        }
      };
      try {
        fs.mkdirSync(stageDir, { recursive: true });
        if (app.cwd && fs.existsSync(app.cwd)) copySafe(app.cwd, stageDir);
        const portableManifest = { ...app, cwd: '' };
        fs.writeFileSync(path.join(stageDir, 'app.json'), JSON.stringify(portableManifest, null, 2) + '\n', 'utf8');
        const readme = [
          `# ${app.name} (${app.id})`,
          '',
          app.description ? app.description : '',
          app.usage ? `\n## 사용법\n${app.usage}` : '',
          app.purpose ? `\n## 개발 의도\n${app.purpose}` : '',
          '\n## Agent CLI Hub에서 가져오기',
          '1. 이 압축 파일을 원하는 폴더에 풉니다.',
          '2. Agent CLI Hub → **앱스** → **새 앱 추가** → **폴더에서 app.json 가져오기 (Import)**에 압축 푼 폴더 경로를 입력합니다.',
          '3. Python/Node 의존성이 필요한 앱은 해당 폴더에서 `setup.ps1` 또는 `requirements.txt` / `package.json`을 설치한 뒤 실행하세요.',
          '',
        ].filter((x) => x !== '').join('\n');
        fs.writeFileSync(path.join(stageDir, 'SHARE_README.md'), readme, 'utf8');
        if (process.platform === 'win32') {
          const ps = `Compress-Archive -LiteralPath '${stageDir.replace(/'/g, "''")}' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`;
          execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 60000 });
        } else {
          execFileSync('zip', ['-rq', zipPath, app.id], { cwd: tmpRoot, timeout: 60000 });
        }
        const buf = fs.readFileSync(zipPath);
        res.writeHead(200, {
          'content-type': 'application/zip',
          'content-disposition': `attachment; filename="${app.id.replace(/[^a-zA-Z0-9._-]/g, '_')}-share.zip"`,
          'content-length': buf.length,
          'cache-control': 'no-store',
        });
        res.end(buf);
        return true;
      } catch (e) {
        return send(500, { error: `전달용 패키지 생성 실패: ${e.message}` });
      } finally {
        try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
      }
    }

    if (sub === 'run' && req.method === 'POST') {
      const b = await readBody();
      const actionId = b.actionId || app.actions?.[0]?.id;
      const action = (app.actions || []).find((a) => a.id === actionId);
      if (!action) return send(400, { error: `실행할 액션을 찾을 수 없습니다: ${actionId || '(없음)'}` });
      try {
        const run = await runAction(app, action, b.params || {});
        return send(200, { ok: true, run });
      } catch (e) {
        return send(e.statusCode || 400, { error: e.message });
      }
    }

    if (sub === 'cancel' && req.method === 'POST') {
      const active = activeProcs.get(app.id);
      if (!active) return send(200, { ok: true, wasRunning: false });
      active.cancelRequested = true;
      try {
        if (process.platform === 'win32' && active.proc?.pid) {
          spawn('taskkill', ['/pid', String(active.proc.pid), '/t', '/f'], { windowsHide: true });
        } else {
          active.proc.kill('SIGTERM');
        }
      } catch {}
      return send(200, { ok: true, wasRunning: true, runId: active.runId });
    }

    if (sub === 'runs' && req.method === 'GET') {
      const runs = loadRuns()[app.id] || [];
      return send(200, { runs, running: activeProcs.has(app.id) });
    }

    if (sub.startsWith('runs/') && req.method === 'DELETE') {
      const runId = decodeURIComponent(sub.slice('runs/'.length));
      const history = loadRuns();
      const runs = history[app.id] || [];
      const run = runs.find((r) => r.runId === runId);
      if (!run) return send(404, { error: '실행 기록을 찾을 수 없습니다.' });
      if (run.status === 'running') return send(409, { error: '실행 중인 기록은 삭제할 수 없습니다.' });
      history[app.id] = runs.filter((r) => r.runId !== runId);
      saveRuns(history);
      return send(200, { ok: true });
    }

    if (sub === 'files' && req.method === 'GET') {
      const files = getAppFiles(app);
      return send(200, { views: files.views, data: files.data });
    }

    if (sub === 'data' && req.method === 'GET') {
      const files = getAppFiles(app);
      const reqFile = url.searchParams.get('file') || 'latest';
      const target = reqFile === 'latest' ? files.data[0] : files.data.find((f) => f.name === reqFile);
      if (!target) {
        if (!files.dataAbs) return send(404, { error: '데이터 폴더가 설정되지 않았습니다' });
        if (reqFile !== 'latest' && !resolveInside(files.dataAbs, reqFile)) {
          return send(403, { error: '허용되지 않은 파일 경로입니다' });
        }
        return send(404, { error: '데이터 파일이 없습니다' });
      }
      try {
        let parsed = JSON.parse(fs.readFileSync(target.path, 'utf8'));
        const q = (url.searchParams.get('q') || '').trim().toLowerCase();
        const limit = Number(url.searchParams.get('limit') || 0);
        if (q && Array.isArray(parsed?.items)) {
          parsed = {
            ...parsed,
            items: parsed.items.filter((it) => JSON.stringify(it).toLowerCase().includes(q)),
          };
        }
        if (limit > 0 && Array.isArray(parsed?.items)) {
          parsed = { ...parsed, items: parsed.items.slice(0, limit) };
        }
        return send(200, { file: target.name, path: target.path, mtime: target.mtime, data: parsed });
      } catch (e) {
        return send(500, { error: `JSON 파싱 실패: ${e.message}` });
      }
    }

    if (sub === 'data' && req.method === 'DELETE') {
      const files = getAppFiles(app);
      const reqFile = url.searchParams.get('file');
      const olderThanDays = Number(url.searchParams.get('olderThanDays') || 0);
      const deleted = [];
      if (reqFile) {
        const allAllowed = [...files.data, ...files.views];
        const found = allAllowed.find((f) => f.name === reqFile);
        if (!found) {
          const checkDir = files.dataAbs || files.viewAbs || app.cwd;
          if (checkDir && !resolveInside(checkDir, reqFile)) {
            return send(403, { error: '허용되지 않은 파일 경로입니다' });
          }
          return send(404, { error: `삭제할 파일을 찾을 수 없습니다: ${reqFile}` });
        }
        fs.unlinkSync(found.path);
        deleted.push(found.name);
        return send(200, { ok: true, deleted });
      }
      if (olderThanDays > 0) {
        const cutoff = Date.now() - olderThanDays * 86400_000;
        for (const f of [...files.data, ...files.views]) {
          if (f.mtimeMs < cutoff) {
            try { fs.unlinkSync(f.path); deleted.push(f.name); } catch {}
          }
        }
        return send(200, { ok: true, deleted });
      }
      return send(400, { error: 'file 또는 olderThanDays 파라미터가 필요합니다' });
    }

    if ((sub === 'view' || sub.startsWith('view/')) && req.method === 'GET') {
      const files = getAppFiles(app);
      if (!files.viewAbs) return send(404, { error: '뷰 폴더가 설정되지 않았습니다' });
      const rel = sub.startsWith('view/') ? decodeURIComponent(sub.slice(5)) : (url.searchParams.get('file') || 'latest');
      const target = rel === 'latest'
        ? files.views[0]?.path
        : resolveInside(files.viewAbs, rel);
      if (!target) return send(403, { error: '허용되지 않은 뷰 경로입니다' });
      if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return send(404, { error: '뷰 파일이 없습니다' });
      return serveFile(req, res, target);
    }

    if (sub === 'session/open' && req.method === 'POST') {
      const linked = findLinkedSession(app);
      if (linked.term) return send(200, { ok: true, term: linked.term, existing: true });
      if (linked.live) return send(200, { ok: true, sessionId: linked.live.sessionId, existing: true });
      if (!createTerm || !app.cwd) return send(400, { error: '새 세션을 시작할 작업 폴더(cwd)가 없습니다' });
      const agent = app.session?.preferredAgent === 'codex' ? 'codex' : 'claude';
      const cmd = agent === 'codex' ? 'codex.cmd' : 'claude.exe';
      const t = createTerm({ cwd: app.cwd, cmd, args: [], title: `🧩 ${app.name}`, agent });
      return send(200, { ok: true, term: termInfo(t), existing: false });
    }

    if (sub === 'send-to-chat' && req.method === 'POST') {
      const b = await readBody();
      const files = getAppFiles(app);
      const all = [...files.views, ...files.data];
      const fileObj = b.file ? all.find((f) => f.name === b.file) : (files.views[0] || files.data[0]);
      const linked = findLinkedSession(app);
      const targetTermId = b.termId || linked.actionTermId;
      const targetSid = b.sessionId || linked.sessionId;
      if (artifactsMod && targetSid && fileObj) {
        artifactsMod.pinFile(targetSid, fileObj.path);
      }
      const prompt = String(b.prompt || '').trim();
      const msg = [fileObj ? `"${fileObj.path}"` : '', prompt || `[${app.name}] 결과물을 확인하고 요약·분석해 주세요.`].filter(Boolean).join(' ');
      if (targetTermId && writeInteractiveTerm) {
        const termObj = terms.get(String(targetTermId));
        if (termObj?.exited === null && await writeInteractiveTerm(termObj, msg + '\r').catch(() => false)) {
          return send(200, { ok: true, delivered: true, termId: targetTermId, file: fileObj?.path || null });
        }
      }
      return send(200, { ok: true, delivered: false, message: msg, file: fileObj?.path || null, sessionId: targetSid });
    }

    return false;
  }

  function stop() {
    for (const active of activeProcs.values()) {
      active.cancelRequested = true;
      try { active.proc.kill('SIGTERM'); } catch {}
    }
    activeProcs.clear();
  }

  return { handle, stop, loadStore, enrichApp };
};
