// Lightweight Apps runtime: registry CRUD, folder import, command/agent/pipeline execution,
// run lock & cancellation, output/data management, and session/chat/artifact integration.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { serve: serveFile } = require('./artifacts');
const createAppStore = require('./app-store');
const { githubSource } = require('./app-store-github');
const { localSource, assetFile, unmet } = require('./app-store-local');
const HUB_VERSION = (() => { try { return require('./package.json').version; } catch { return '0.0.0'; } })();

const VALID_TYPES = new Set(['report', 'url', 'command']);
const VALID_KINDS = new Set(['command', 'agent', 'pipeline']);
const ID_RE = /^[a-z0-9][a-z0-9_-]{1,47}$/;
const SETTING_KEY_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
const SETTING_TYPES = new Set(['text', 'path', 'url', 'number', 'secret', 'bool']);

// app.json "settings": what the user fills in at install time (folders, ports, hosts). Values live only in this
// hub's app registry (app.env), never in the package, and reach the app's commands as environment variables.
function normalizeSettings(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  return list.slice(0, 40).map((item) => {
    const key = String(item?.key || '').trim();
    if (!SETTING_KEY_RE.test(key) || seen.has(key)) throw new Error(`잘못된 설정 키입니다: ${key}`);
    seen.add(key);
    const type = SETTING_TYPES.has(item.type) ? item.type : 'text';
    return {
      key, type,
      label: String(item.label || key).slice(0, 120),
      description: String(item.description || '').slice(0, 500),
      default: item.default === undefined || item.default === null ? '' : String(item.default).slice(0, 2000),
      required: Boolean(item.required),
    };
  });
}

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
  const appStore = createAppStore({ dataFile, fetcher: deps.storeFetch, python: deps.python });
  const runsFile = deps.runsFile || path.join(__dirname, 'data', 'app-runs.json');
  const secretsDir = deps.secretsDir || path.join(__dirname, 'secrets');
  const hubDir = deps.hubDir || __dirname;
  // a store app may carry a hub plugin (server routes, nav, ccd commands); it is copied here (gitignored)
  const pluginsDir = deps.pluginsDir || path.join(__dirname, 'local', 'plugins');
  // what this hub offers to apps' "requires" (version + plugin ids)
  const platform = () => {
    let plugins = [];
    try { plugins = (deps.listPlugins || (() => require('./plugins').discover().map((m) => m.id)))(); } catch {}
    return { hubVersion: deps.hubVersion || HUB_VERSION, plugins };
  };
  const terms = deps.terms || new Map();
  const createTerm = deps.createTerm || null;
  const liveSessions = deps.liveSessions || (() => []);
  const writeInteractiveTerm = deps.writeInteractiveTerm || null;
  const artifactsMod = deps.artifactsMod || null;
  const termInfo = deps.termInfo || ((t) => ({
    id: t.id, title: t.title, cwd: t.cwd, exited: t.exited, sessionId: t.sessionId, agent: t.agent,
  }));

  const activeProcs = new Map(); // appId -> { runId, proc, cancelRequested }
  const exportJobs = new Map(); // jobId -> job state

  function pruneExportJobs() {
    const now = Date.now();
    for (const [id, job] of exportJobs) {
      if (job.status !== 'running' && now - (job.finishedAt || job.startedAt) > 30 * 60_000) {
        if (job._tempExportDir) {
          try { fs.rmSync(job._tempExportDir, { recursive: true, force: true }); } catch {}
        }
        exportJobs.delete(id);
      }
    }
    if (exportJobs.size > 30) {
      const oldest = [...exportJobs.values()]
        .filter((j) => j.status !== 'running')
        .sort((a, b) => a.startedAt - b.startedAt);
      while (exportJobs.size > 30 && oldest.length) {
        const j = oldest.shift();
        if (j._tempExportDir) {
          try { fs.rmSync(j._tempExportDir, { recursive: true, force: true }); } catch {}
        }
        exportJobs.delete(j.jobId);
      }
    }
  }

  function defaultExportDir() {
    const home = os.homedir();
    for (const candidate of [path.join(home, 'Downloads'), path.join(home, 'Desktop')]) {
      try {
        if (fs.statSync(candidate).isDirectory()) return candidate;
      } catch {}
    }
    return path.join(path.dirname(dataFile), 'exports');
  }

  function formatExportStamp(d = new Date()) {
    const p2 = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`;
  }

  function buildExportFileName(app) {
    const safeId = String(app.id || 'app').replace(/[^a-zA-Z0-9._-]/g, '_');
    return `${safeId}-share-${formatExportStamp()}.zip`;
  }

  function uniqueZipPath(dir, fileName) {
    const ext = path.extname(fileName) || '.zip';
    const base = path.basename(fileName, ext);
    let candidate = path.join(dir, `${base}${ext}`);
    for (let i = 2; i <= 99 && fs.existsSync(candidate); i++) {
      candidate = path.join(dir, `${base}-${i}${ext}`);
    }
    return candidate;
  }

  function publicJobView(job) {
    return {
      jobId: job.jobId,
      appId: job.appId,
      appName: job.appName,
      status: job.status,
      stage: job.stage,
      stageLabel: job.stageLabel,
      percent: job.percent,
      filesDone: job.filesDone,
      filesTotal: job.filesTotal,
      skippedLarge: job.skippedLarge,
      bytes: job.bytes,
      fileName: job.fileName,
      outputDir: job.outputDir,
      outputPath: job.outputPath,
      browserOnly: Boolean(job.browserOnly),
      includeOutputs: Boolean(job.includeOutputs),
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      error: job.error,
    };
  }

  function zipStageDirectory(tmpRoot, appFolderName, zipPath, onProgress) {
    return new Promise((resolve, reject) => {
      if (process.platform === 'win32') {
        const psScript = [
          '$ErrorActionPreference = "Stop"',
          'Add-Type -AssemblyName System.IO.Compression',
          'Add-Type -AssemblyName System.IO.Compression.FileSystem',
          '$root = [System.IO.Path]::GetFullPath($env:HUB_STAGE_ROOT)',
          '$stageDir = [System.IO.Path]::GetFullPath($env:HUB_STAGE_DIR)',
          '$zipPath = $env:HUB_ZIP_PATH',
          'if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }',
          '$files = @(Get-ChildItem -LiteralPath $stageDir -Recurse -File -Force)',
          '$total = $files.Count',
          '$zip = [System.IO.Compression.ZipFile]::Open($zipPath, [System.IO.Compression.ZipArchiveMode]::Create)',
          'try {',
          '  $i = 0',
          '  foreach ($f in $files) {',
          '    $rel = $f.FullName.Substring($root.Length).TrimStart("\\", "/").Replace("\\", "/")',
          '    [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $f.FullName, $rel, [System.IO.Compression.CompressionLevel]::Optimal)',
          '    $i++',
          '    if ($i -eq $total -or ($i % 5 -eq 0)) { [Console]::Out.WriteLine("PROGRESS $i/$total") }',
          '  }',
          '} finally { $zip.Dispose() }',
        ].join('\n');
        const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
          windowsHide: true,
          env: { ...process.env, HUB_STAGE_ROOT: tmpRoot, HUB_STAGE_DIR: path.join(tmpRoot, appFolderName), HUB_ZIP_PATH: zipPath },
        });
        let stderr = '';
        let buf = '';
        const timer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch {}
          reject(new Error('ZIP 압축 시간이 초과되었습니다 (120초)'));
        }, 120_000);
        child.stdout.on('data', (chunk) => {
          buf += chunk.toString('utf8');
          const lines = buf.split(/\r?\n/);
          buf = lines.pop() || '';
          for (const line of lines) {
            const m = /^PROGRESS\s+(\d+)\/(\d+)/.exec(line.trim());
            if (m && onProgress) onProgress(Number(m[1]), Number(m[2]));
          }
        });
        child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
        child.on('error', (err) => { clearTimeout(timer); reject(err); });
        child.on('close', (code) => {
          clearTimeout(timer);
          if (code === 0 && fs.existsSync(zipPath)) return resolve();
          reject(new Error(stderr.trim() || `PowerShell ZIP 생성 실패 (exit ${code})`));
        });
        return;
      }

      const child = spawn('zip', ['-rq', zipPath, appFolderName], { cwd: tmpRoot });
      let stderr = '';
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
        reject(new Error('ZIP 압축 시간이 초과되었습니다 (120초)'));
      }, 120_000);
      child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
      child.on('error', (err) => { clearTimeout(timer); reject(err); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0 && fs.existsSync(zipPath)) return resolve();
        reject(new Error(stderr.trim() || `zip 명령 실행 실패 (exit ${code})`));
      });
    });
  }

  async function executeExportJob(app, job) {
    const SKIP_DIRS = new Set(['.venv', 'venv', 'node_modules', '__pycache__', '.git', '.pytest_cache', '.mypy_cache', 'secrets']);
    const OUTPUT_DIR_NAMES = new Set(['산출물', 'reports', 'report', 'outputs', 'output', 'dist']);
    const SKIP_FILE_RE = /^(?:\.env(?:\..+)?|\.token|.*\.(?:key|pem|pfx|p12))$/i;
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ach-app-export-'));
    const stageDir = path.join(tmpRoot, app.id);
    const tmpZipPath = path.join(tmpRoot, job.fileName);

    const excludedAbsDirs = new Set();
    if (!job.includeOutputs && app.cwd) {
      const filesMeta = getAppFiles(app);
      if (filesMeta.viewAbs) excludedAbsDirs.add(path.resolve(filesMeta.viewAbs).toLowerCase());
      if (filesMeta.dataAbs) excludedAbsDirs.add(path.resolve(filesMeta.dataAbs).toLowerCase());
    }

    try {
      job.stage = 'scan';
      job.stageLabel = '1/3 앱 파일 목록 수집 중…';
      job.percent = 8;

      const entries = [];
      const walk = (src, relBase, depth = 0) => {
        if (depth > 8 || !fs.existsSync(src)) return;
        const absCur = path.resolve(src).toLowerCase();
        if (excludedAbsDirs.has(absCur)) return;
        let dirents;
        try { dirents = fs.readdirSync(src, { withFileTypes: true }); } catch { return; }
        for (const ent of dirents) {
          if (ent.isSymbolicLink()) continue;
          const full = path.join(src, ent.name);
          const rel = relBase ? path.join(relBase, ent.name) : ent.name;
          if (ent.isDirectory()) {
            if (SKIP_DIRS.has(ent.name)) continue;
            if (!job.includeOutputs && OUTPUT_DIR_NAMES.has(ent.name.toLowerCase())) continue;
            if (excludedAbsDirs.has(path.resolve(full).toLowerCase())) continue;
            walk(full, rel, depth + 1);
          } else if (ent.isFile()) {
            if (SKIP_FILE_RE.test(ent.name)) continue;
            if (job.outputPath && path.resolve(full).toLowerCase() === path.resolve(job.outputPath).toLowerCase()) continue;
            try {
              const st = fs.statSync(full);
              if (st.size > 50 * 1024 * 1024) {
                job.skippedLarge += 1;
                continue;
              }
              entries.push({ full, rel, size: st.size });
            } catch {}
          }
        }
      };

      if (app.cwd && fs.existsSync(app.cwd)) walk(app.cwd, '');
      const totalFiles = entries.length + 2; // + app.json + SHARE_README.md
      job.filesTotal = totalFiles;
      job.filesDone = 0;
      job.percent = 15;
      job.stage = 'copy';
      job.stageLabel = `2/3 패키지 파일 준비 중 (0/${totalFiles})…`;

      fs.mkdirSync(stageDir, { recursive: true });
      for (let i = 0; i < entries.length; i++) {
        const item = entries[i];
        const dst = path.join(stageDir, item.rel);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        try { fs.copyFileSync(item.full, dst); } catch {}
        job.filesDone = i + 1;
        job.percent = Math.min(48, 15 + Math.round((job.filesDone / Math.max(1, totalFiles)) * 33));
        if (i % 12 === 0 || i === entries.length - 1) {
          job.stageLabel = `2/3 패키지 파일 준비 중 (${job.filesDone}/${totalFiles})…`;
          await new Promise((r) => setImmediate(r));
        }
      }

      const portableManifest = {
        ...app, cwd: '', env: {}, secretRefs: [], schedule: { enabled: false },
        session: { ...app.session, pinnedSessionId: '' },
      };
      delete portableManifest.storeSource;
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
      job.filesDone = totalFiles;
      job.percent = 50;

      job.stage = 'zip';
      job.stageLabel = `3/3 ZIP 압축 생성 중 (0/${totalFiles})…`;
      await zipStageDirectory(tmpRoot, app.id, tmpZipPath, (done, total) => {
        job.filesDone = done;
        job.filesTotal = Math.max(job.filesTotal, total);
        job.percent = Math.min(94, 50 + Math.round((done / Math.max(1, total)) * 44));
        job.stageLabel = `3/3 ZIP 압축 생성 중 (${done}/${total})…`;
      });

      job.stage = 'save';
      job.stageLabel = '최종 위치에 저장 중…';
      job.percent = 96;
      fs.mkdirSync(job.outputDir, { recursive: true });
      try {
        fs.renameSync(tmpZipPath, job.outputPath);
      } catch {
        fs.copyFileSync(tmpZipPath, job.outputPath);
        try { fs.unlinkSync(tmpZipPath); } catch {}
      }

      const st = fs.statSync(job.outputPath);
      job.bytes = st.size;
      job.percent = 100;
      job.stage = 'done';
      job.stageLabel = '저장 완료';
      job.status = 'ok';
      job.finishedAt = Date.now();
    } catch (e) {
      job.status = 'error';
      job.stage = 'error';
      job.stageLabel = '내보내기 실패';
      job.error = e.message || String(e);
      job.finishedAt = Date.now();
    } finally {
      try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
    }
    return job;
  }

  function startExportJob(app, opts = {}) {
    pruneExportJobs();
    const browserOnly = Boolean(opts.browserOnly);
    const includeOutputs = opts.includeOutputs === true;
    let outputDir;
    let tempExportDir = null;
    if (browserOnly) {
      tempExportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ach-app-dl-'));
      outputDir = tempExportDir;
    } else {
      const requested = String(opts.destDir || '').trim();
      if (requested) {
        if (!path.isAbsolute(requested)) throw new Error('저장 경로는 절대 경로여야 합니다');
        outputDir = path.resolve(requested);
      } else {
        outputDir = defaultExportDir();
      }
      fs.mkdirSync(outputDir, { recursive: true });
    }
    const baseName = buildExportFileName(app);
    const outputPath = uniqueZipPath(outputDir, baseName);
    const jobId = `exp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const job = {
      jobId,
      appId: app.id,
      appName: app.name,
      status: 'running',
      stage: 'scan',
      stageLabel: '내보내기 준비 중…',
      percent: 5,
      filesDone: 0,
      filesTotal: 0,
      skippedLarge: 0,
      bytes: 0,
      fileName: path.basename(outputPath),
      outputDir,
      outputPath,
      browserOnly,
      includeOutputs,
      startedAt: Date.now(),
      finishedAt: null,
      error: null,
      _tempExportDir: tempExportDir,
      _promise: null,
    };
    exportJobs.set(jobId, job);
    job._promise = executeExportJob(app, job);
    return job;
  }

  function loadStore() {
    const raw = safeJsonRead(dataFile, { version: 1, apps: [] });
    return { version: 1, apps: Array.isArray(raw.apps) ? raw.apps : [], sources: Array.isArray(raw.sources) ? raw.sources : [] };
  }

  function saveStore(store) {
    safeJsonWrite(dataFile, store);
  }

  // ---------- install-time settings and hub plugins of store apps ----------
  const settingVars = (app) => ({ APP_DIR: app.cwd || '', HUB_DIR: hubDir });
  /** declared settings → { KEY: value } (the user's value, else the default; {{APP_DIR}} / {{HUB_DIR}} filled in) */
  function settingValues(app) {
    const out = {};
    for (const s of app.settings || []) {
      const v = app.env && Object.prototype.hasOwnProperty.call(app.env, s.key) ? app.env[s.key] : s.default;
      out[s.key] = applyTemplate(String(v ?? ''), settingVars(app));
    }
    return out;
  }
  /** user values for the declared settings only (strings, one line); throws on a missing required one */
  function acceptSettings(app, values = {}) {
    const env = {};
    for (const s of app.settings || []) {
      let v = values && Object.prototype.hasOwnProperty.call(values, s.key) ? values[s.key] : (app.env?.[s.key] ?? s.default);
      v = String(v ?? '').trim();
      if (/[\r\n\0]/.test(v) || v.length > 2000) throw new Error(`설정 값이 올바르지 않습니다: ${s.label}`);
      if (s.type === 'number' && v && !/^-?\d+(\.\d+)?$/.test(v)) throw new Error(`숫자를 입력하세요: ${s.label}`);
      if (s.type === 'url' && v && !/^https?:\/\//i.test(v)) throw new Error(`http(s) 주소를 입력하세요: ${s.label}`);
      if (s.required && !applyTemplate(v, settingVars(app))) throw new Error(`필수 설정입니다: ${s.label}`);
      env[s.key] = v;
    }
    return env;
  }
  const MARK = '.store-app';
  function pluginManifest(app) {
    const src = app.hubPlugin && app.cwd ? resolveInside(app.cwd, app.hubPlugin) : null;
    const man = src ? safeJsonRead(path.join(src, 'plugin.json'), null) : null;
    const id = String(man?.id || '');
    if (!man || !/^[a-z0-9][a-z0-9_-]{0,47}$/.test(id)) return null;
    return { src, id, dest: path.join(pluginsDir, id), man };
  }
  const ownedBy = (dir) => { try { return fs.readFileSync(path.join(dir, MARK), 'utf8').trim(); } catch { return ''; } };
  function pluginState(app) {
    const p = pluginManifest(app);
    if (!p) return { error: 'plugin.json 없음' };
    return { id: p.id, installed: ownedBy(p.dest) === app.id, dir: p.dest };
  }
  function writePluginSettings(app) {
    const p = pluginManifest(app);
    if (p && ownedBy(p.dest) === app.id) safeJsonWrite(path.join(p.dest, 'settings.json'), settingValues(app));
  }
  /** copy the app's plugin folder into the hub's local plugins (loaded on the next hub start) */
  function installPlugin(app) {
    const p = pluginManifest(app);
    if (!p) throw new Error('앱의 hubPlugin 폴더에 올바른 plugin.json이 없습니다');
    // a store plugin is written against a declared plugin API version (plugins.js): namespaced routes and commands
    if (p.man.apiVersion === undefined) throw new Error('스토어 앱의 플러그인은 plugin.json에 apiVersion을 선언해야 합니다');
    const why = require('./plugins').incompatible(p.man, platform().hubVersion);
    if (why) throw new Error(`이 허브에서 쓸 수 없는 플러그인입니다: ${why}`);
    if (fs.existsSync(p.dest)) {
      if (ownedBy(p.dest) !== app.id) throw new Error(`이미 같은 ID의 로컬 플러그인이 있습니다: ${p.dest}`);
      fs.rmSync(p.dest, { recursive: true, force: true });
    }
    fs.mkdirSync(pluginsDir, { recursive: true });
    fs.cpSync(p.src, p.dest, { recursive: true, filter: (f) => !/[\\/](?:\.git|node_modules|__pycache__)$/.test(f) && path.basename(f) !== 'settings.json' });
    fs.writeFileSync(path.join(p.dest, MARK), app.id, 'utf8');
    writePluginSettings(app);
    return p.id;
  }
  function removePlugin(app) {
    const p = pluginManifest(app);
    if (!p || ownedBy(p.dest) !== app.id) return null;
    fs.rmSync(p.dest, { recursive: true, force: true });
    return p.id;
  }
  /** what a package will do on this PC, derived from its files (shown on the store page before install) */
  function describePackage(app, plugin) {
    const read = (f, n) => { try { return fs.readFileSync(path.join(app.cwd, f), 'utf8').replace(/^﻿/, '').slice(0, n); } catch { return ''; } };
    const changelog = read('CHANGELOG.md', 40000);
    const firstSection = /^##\s+(.+)\n([\s\S]*?)(?=^##\s|(?![\s\S]))/m.exec(changelog);
    const pman = plugin ? safeJsonRead(path.join(plugin.src, 'plugin.json'), {}) : null;
    const scripts = ['setup.ps1', 'stop.ps1', 'uninstall.ps1'].filter((f) => fs.existsSync(path.join(app.cwd, f)));
    const settings = app.settings || [];
    return {
      readme: read('README.md', 16000),
      whatsNew: firstSection ? { title: firstSection[1].trim().slice(0, 120), body: firstSection[2].trim().slice(0, 4000) } : null,
      installs: {
        scripts,
        commands: (app.actions || []).map((a) => ({ label: a.label, cmd: a.cmd, kind: a.kind })),
        ports: settings.filter((s) => /PORT$/.test(s.key)).map((s) => ({ label: s.label, value: s.default })),
        folders: settings.filter((s) => s.type === 'path').map((s) => ({ label: s.label, value: s.default })),
        hosts: settings.filter((s) => s.type === 'url').map((s) => ({ label: s.label, value: s.default })),
        webView: app.entryUrl || '',
        plugin: pman ? {
          id: plugin.id, server: Boolean(pman.server), cli: Boolean(pman.cli), browserScripts: pman.scripts || [],
          routes: Array.isArray(pman.routes) ? pman.routes.slice(0, 30) : [], commands: Array.isArray(pman.help) ? pman.help.slice(0, 10) : [],
          provides: Object.keys(pman.provides || {}),
        } : null,
      },
    };
  }

  /** run an optional lifecycle script of the app (uninstall.ps1) and wait for it */
  function runScript(app, file, timeoutSec = 120) {
    return new Promise((resolve) => {
      if (!app.cwd || !fs.existsSync(path.join(app.cwd, file))) return resolve(null);
      const proc = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file], { cwd: app.cwd, env: buildEnv(app, {}), windowsHide: true });
      let out = '';
      const timer = setTimeout(() => { try { proc.kill(); } catch {} }, timeoutSec * 1000);
      proc.stdout.on('data', (c) => { out = (out + c).slice(-8000); });
      proc.stderr.on('data', (c) => { out = (out + c).slice(-8000); });
      proc.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, output: e.message }); });
      proc.on('close', (code) => { clearTimeout(timer); resolve({ code, output: out }); });
    });
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

    const hubPlugin = String(input.hubPlugin ?? existing?.hubPlugin ?? '').trim();
    if (hubPlugin && (path.isAbsolute(hubPlugin) || !cwd || !resolveInside(cwd, hubPlugin))) throw new Error('hubPlugin은 앱 폴더 안의 폴더여야 합니다');
    const now = new Date().toISOString();
    return {
      id,
      name,
      version: String(input.version ?? existing?.version ?? '').trim().slice(0, 40),
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
      settings: normalizeSettings(input.settings ?? existing?.settings),
      hubPlugin,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      ...(existing?.storeSource ? { storeSource: existing.storeSource } : {}),
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
      viewUrl: app.entryUrl ? applyTemplate(app.entryUrl, { ...settingValues(app), ...(app.env || {}) }) : '',
      pluginState: app.hubPlugin ? pluginState(app) : null,
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
    const env = { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', ...process.env, HUB_DIR: hubDir, HUB_NODE: process.execPath, HUB_APP_ID: app.id, HUB_APP_DIR: app.cwd || '' };
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
    Object.assign(env, settingValues(app)); // declared settings, with {{APP_DIR}} / {{HUB_DIR}} filled in
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
    // 'close' waits for every holder of the output pipes; a server the command started in the background may keep
    // them open for good, so a run also ends shortly after the command's own process has exited
    let finished = false;
    proc.on('exit', (code) => {
      const t = setTimeout(() => {
        if (finished) return;
        try { proc.stdout.destroy(); proc.stderr.destroy(); } catch {}
        proc.emit('close', code);
      }, 1500);
      if (t.unref) t.unref();
    });
    proc.on('close', async (code) => {
      if (finished) return;
      finished = true;
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

  let recentCatalog = null, recentCatalogPending = null;
  async function handle(p, url, req, readBody, send, res) {
    if (!p.startsWith('/api/apps')) return false;
    const store = loadStore();
    const byId = (id) => store.apps.find((a) => a.id === id);

    if (p === '/api/apps-store' && req.method === 'GET') {
      const { entries, unavailable, submitUrls = [] } = await appStore.catalog(store.sources);
      recentCatalog = { at: Date.now(), entries };
      const plat = platform();
      return send(200, { sources: store.sources, unavailable, submitUrls, hubVersion: plat.hubVersion, entries: entries.map(entry => {
        const mine = store.apps.find(app => app.storeSource?.key === entry.key);
        const { local: _local, ...pub } = entry;
        const missing = unmet(entry.requires, plat);
        return { ...pub, installed: mine?.storeSource.version || '', installedId: mine?.id || '', installedDigest: mine?.storeSource.digest || '',
          compatible: missing.length === 0, unmet: missing };
      }) });
    }
    // register page: check a repo before adding it / submitting it to a registry (reads app.json only, runs nothing)
    if (p === '/api/apps-store/inspect' && req.method === 'POST') {
      const value = String((await readBody()).repo || '').trim();
      const checks = [];
      const ok = (label, pass, detail = '', optional = false) => checks.push({ label, pass: Boolean(pass), detail, optional });
      let manifest = null, repo = '', release = null;
      try {
        const local = localSource(value);
        if (local?.path) {
          repo = local.path;
          manifest = safeJsonRead(path.join(local.path, 'app.json'), null);
          ok('저장소 접근', fs.existsSync(local.path), local.path);
        } else {
          repo = githubSource(value).repo;
          if (!repo) throw new Error('저장소 주소(owner/repository)를 입력하세요');
          const fetcher = deps.storeFetch || fetch;
          const r = await fetcher(`https://raw.githubusercontent.com/${repo}/HEAD/app.json`, { signal: AbortSignal.timeout(8000) });
          ok('저장소 접근', r.ok, r.ok ? `https://github.com/${repo}` : `HTTP ${r.status}`);
          if (r.ok) manifest = JSON.parse((await r.text()).replace(/^﻿/, ''));
          const rel = await fetcher(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { 'User-Agent': 'Agent-CLI-Hub' }, signal: AbortSignal.timeout(8000) }).catch(() => null);
          if (rel?.ok) {
            const j = await rel.json();
            const zips = (j.assets || []).filter((a) => /\.zip$/i.test(a.name));
            release = { tag: j.tag_name, assets: zips.map((a) => ({ name: a.name, digest: a.digest || '' })) };
          }
          ok('릴리스 ZIP', release && release.assets.length, release ? `${release.tag}: ${release.assets.map((a) => a.name).join(', ') || 'ZIP 없음'}` : '최신 릴리스 없음 — 스토어는 릴리스 ZIP을 설치합니다', true);
        }
      } catch (e) { ok('저장소 주소', false, e.message); }
      ok('app.json', manifest, manifest ? '' : '저장소 최상위에 app.json이 필요합니다');
      if (manifest) {
        ok('앱 ID', ID_RE.test(String(manifest.id || '')), String(manifest.id || ''));
        ok('이름·설명', manifest.name && manifest.description, manifest.name || '');
        ok('유형', VALID_TYPES.has(manifest.type || 'report'), manifest.type || 'report');
        ok('CCD 요구 사항', manifest.requires?.ccd, manifest.requires?.ccd ? `CCD ${manifest.requires.ccd}` : 'app.json requires.ccd 필요 (예: ">=1.0.0")');
        try { normalizeSettings(manifest.settings); ok('설치 설정', true, `${(manifest.settings || []).length}개`); } catch (e) { ok('설치 설정', false, e.message); }
        ok('개인 경로 없음', !/[A-Z]:\\\\Users\\\\|[A-Z]:\/Users\//i.test(JSON.stringify(manifest)), '');
        ok('아이콘', manifest.store?.icon, manifest.store?.icon || 'app.json store.icon 권장', true);
      }
      return send(200, { repo, manifest: manifest ? { id: manifest.id, name: manifest.name, description: manifest.description, version: manifest.version || '',
        type: manifest.type, store: manifest.store || {}, settings: manifest.settings || [], hubPlugin: manifest.hubPlugin || '' } : null,
        release, checks, valid: checks.every((c) => c.pass || c.optional) });
    }
    // icon / screenshots of a local package (GitHub packages give https URLs in the registry)
    if (p === '/api/apps-store/asset' && req.method === 'GET') {
      const file = String(url.searchParams.get('file') || '');
      if (!assetFile(file)) return send(404, { error: 'not found' });
      // a store page loads many images at once: reuse the catalog read by the page (no git / network per image)
      if (!recentCatalog || Date.now() - recentCatalog.at > 120000) {
        recentCatalog = { at: Date.now(), entries: (await (recentCatalogPending ||= appStore.catalog(store.sources).finally(() => { recentCatalogPending = null; }))).entries };
      }
      const entry = recentCatalog.entries.find(item => item.key === url.searchParams.get('key') && item.local);
      const target = entry ? resolveInside(entry.local, file) : null;
      if (!target || !fs.existsSync(target)) return send(404, { error: 'not found' });
      return serveFile(req, res, target);
    }
    if (p === '/api/apps-store/source' && ['POST', 'DELETE'].includes(req.method)) {
      try {
        const value = (await readBody()).source;
        const source = localSource(value) || githubSource(value);
        if (source.owner && req.method === 'POST') await appStore.discovery(source.owner);
        if (source.path && req.method === 'POST' && !fs.existsSync(source.path)) throw new Error(`경로가 없습니다: ${source.path}`);
        const current = loadStore();
        const field = source.owner ? 'owner' : source.path ? 'path' : source.url ? 'url' : 'repo';
        current.sources = current.sources.filter(entry => entry[field] !== source[field]);
        if (req.method === 'POST') current.sources.push(source);
        saveStore(current);
        return send(200, { ok: true });
      } catch (e) { return send(400, { error: e.message }); }
    }
    if (p === '/api/apps-store/package' && req.method === 'POST') {
      try {
        const { key, digest, settings: settingInput, update } = await readBody();
        if (digest && !/^sha256:[a-f\d]{64}$/.test(digest)) throw new Error('잘못된 패키지 SHA-256입니다.');
        const { entries } = await appStore.catalog(store.sources);
        const entry = entries.find(item => item.key === key);
        if (!entry) return send(404, { error: '카탈로그에 등록된 앱을 찾을 수 없습니다.' });
        const previous = store.apps.find(item => item.storeSource?.key === entry.key) || null;
        if (update && !previous) throw new Error('업데이트할 설치본이 없습니다.');
        if (digest && update) {
          if (activeProcs.has(previous.id)) throw new Error('실행 중인 작업을 먼저 중단하세요.');
          await runScript(previous, 'stop.ps1'); // the old version's servers, before its folder is replaced
        }
        const result = await appStore.withPackage(entry, digest, (manifest, pkg) => {
          const app = normalizeApp(manifest);
          if (app.type === 'url' && !/^https?:\/\//i.test(app.entryUrl)) throw new Error('앱 URL은 HTTP 또는 HTTPS여야 합니다.');
          for (const dir of [app.outputs.viewDir, app.outputs.dataDir]) {
            if (dir && (path.isAbsolute(dir) || !resolveInside(app.cwd, dir))) throw new Error('앱 산출물 경로는 앱 폴더 안에 있어야 합니다.');
          }
          const source = { key: entry.key, repo: entry.repo, version: pkg.version, digest: pkg.digest,
            ...(pkg.commit ? { commit: pkg.commit, dirty: Boolean(pkg.dirty) } : {}) };
          const hasSetup = Boolean(app.cwd && fs.existsSync(path.join(app.cwd, 'setup.ps1')));
          const plugin = app.hubPlugin ? pluginManifest(app) : null;
          if (app.hubPlugin && !plugin) throw new Error('앱의 hubPlugin 폴더에 올바른 plugin.json이 없습니다.');
          // every store app is an add-on for this hub: refuse one whose platform requirement is not met
          const missing = unmet(manifest.requires, platform());
          if (digest && missing.length) throw new Error(`이 허브에서 설치할 수 없습니다: ${missing.join(', ')}`);
          if (!digest) {
            return { name: app.name, description: app.description, actions: app.actions, url: app.entryUrl, hasSetup,
              settings: app.settings, hubPlugin: plugin ? plugin.id : '', author: entry.author || '', verified: Boolean(entry.verified),
              registry: entry.registry || '', ...describePackage(app, plugin), requires: manifest.requires || null, unmet: missing, installedDigest: previous?.storeSource.digest || '',
              // the user's own values (unresolved: {{APP_DIR}} must follow the app into its new folder)
              installedId: previous?.id || '',
              currentSettings: previous ? Object.fromEntries((previous.settings || []).map((s) => [s.key, previous.env?.[s.key] ?? s.default])) : null,
              ...source };
          }
          const current = loadStore();
          const old = update ? current.apps.find(item => item.id === previous.id) : null;
          if (current.apps.some(item => item !== old && (item.id === app.id || item.storeSource?.key === entry.key))) throw new Error('이미 설치된 스토어 앱입니다.');
          if (old) app.createdAt = old.createdAt;
          // upgrade: values of renamed settings follow them (app.json "renamedSettings": { "OLD": "NEW" })
          const renamed = manifest.renamedSettings && typeof manifest.renamedSettings === 'object' ? manifest.renamedSettings : {};
          const input = { ...(settingInput || old?.env || {}) };
          for (const [from, to] of Object.entries(renamed)) if (input[from] !== undefined && input[to] === undefined) { input[to] = input[from]; delete input[from]; }
          app.env = acceptSettings(app, input);
          app.storeSource = source;
          if (old && old.hubPlugin && old.id !== app.id) removePlugin(old);
          const pluginId = plugin ? installPlugin(app) : '';
          current.apps = current.apps.filter(item => item !== old);
          current.apps.push(app);
          saveStore(current);
          const setupTimeoutSec = Math.min(3600, Math.max(60, Number(manifest.setupTimeoutSec) || 300));
          // folders an update carries over from the old package (app.json "keepOnUpdate": [".venv", "data"])
          const keepOnUpdate = (Array.isArray(manifest.keepOnUpdate) ? manifest.keepOnUpdate : [])
            .filter((k) => typeof k === 'string' && k && !path.isAbsolute(k) && !k.split(/[\\/]/).includes('..')).slice(0, 10);
          return { id: app.id, hasSetup, app, hubPlugin: pluginId, restartRequired: Boolean(pluginId), setupTimeoutSec, keepOnUpdate, updated: Boolean(old), ...source };
        });
        // an update leaves the old package folder behind: carry over its keepOnUpdate folders, then remove it
        // (skipped while files are still locked)
        if (digest && update && previous.cwd && appStore.owns(previous.cwd) && appStore.packageDir(previous.cwd) !== appStore.packageDir(result.app.cwd)) {
          const keepFailed = [];
          for (const rel of result.keepOnUpdate || []) {
            const from = resolveInside(previous.cwd, rel), to = resolveInside(result.app.cwd, rel);
            if (!from || !to || !fs.existsSync(from) || fs.existsSync(to)) continue;
            fs.mkdirSync(path.dirname(to), { recursive: true });
            // a rename can fail while a scanner still holds a file: wait a little, then copy instead
            let moved = false;
            for (let i = 0; i < 5 && !moved; i++) {
              try { fs.renameSync(from, to); moved = true; } catch { await new Promise((r) => setTimeout(r, 400)); }
            }
            if (!moved) {
              try { fs.cpSync(from, to, { recursive: true }); moved = true; } catch (e) { keepFailed.push(`${rel}: ${e.code || e.message}`); }
            }
          }
          result.keepFailed = keepFailed;
          // never delete a folder whose kept data could not be carried over
          if (!keepFailed.length) { try { fs.rmSync(appStore.packageDir(previous.cwd), { recursive: true, force: true }); } catch {} }
        }
        let setupRun = null;
        if (digest && result.hasSetup && result.app) {
          setupRun = await runAction(result.app, {
            id: '__setup__',
            label: '초기 환경 구성 (setup.ps1)',
            kind: 'command',
            cmd: 'powershell -NoProfile -ExecutionPolicy Bypass -File setup.ps1',
            timeoutSec: result.setupTimeoutSec || 300,
          }).catch(() => null);
        }
        const { app: _installedApp, setupTimeoutSec: _t, keepOnUpdate: _k, ...pubResult } = result;
        return send(200, { ok: true, package: { ...pubResult, setupRun } });
      } catch (e) { return send(400, { error: e.message }); }
    }

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
        // store apps: only the declared settings may change their environment
        if (app.storeSource) updated.env = acceptSettings(updated, b.settingValues || b.env || app.env || {});
        const idx = store.apps.findIndex((a) => a.id === app.id);
        store.apps[idx] = updated;
        saveStore(store);
        if (updated.hubPlugin) writePluginSettings(updated);
        return send(200, { ok: true, app: enrichApp(updated), restartRequired: Boolean(updated.hubPlugin) });
      } catch (e) {
        return send(400, { error: e.message });
      }
    }

    if (!sub && req.method === 'DELETE') {
      const purge = url.searchParams.get('purgeOutputs') === 'true' || url.searchParams.get('purgeOutputs') === '1';
      if (activeProcs.has(app.id)) {
        return send(409, { error: '실행 중인 작업을 먼저 중단한 뒤 앱을 제거하세요' });
      }
      // store apps: their uninstall.ps1 first (stop servers, unregister); ?force=1 skips a failing one
      let uninstallRun = null;
      if (app.storeSource && !/^(1|true)$/.test(url.searchParams.get('force') || '')) {
        uninstallRun = await runScript(app, 'uninstall.ps1');
        if (uninstallRun && uninstallRun.code !== 0) {
          return send(500, { error: `uninstall.ps1 실패 (exit ${uninstallRun.code}). 다시 시도하거나 강제 제거하세요.`, output: uninstallRun.output });
        }
      }
      const removedFiles = [];
      if (purge) {
        const files = getAppFiles(app);
        for (const f of [...files.views, ...files.data]) {
          try { fs.unlinkSync(f.path); removedFiles.push(f.name); } catch {}
        }
      }
      const pluginId = app.hubPlugin ? pluginManifest(app)?.id : null;
      const removedPlugin = app.hubPlugin ? removePlugin(app) : null;
      // ?purgeData=1 also deletes the plugin's own data folder (hub/data/plugins/<id>); kept by default
      let purgedData = false;
      if (removedPlugin && /^(1|true)$/.test(url.searchParams.get('purgeData') || '') && pluginId) {
        try { fs.rmSync(path.join(path.dirname(dataFile), 'plugins', pluginId), { recursive: true, force: true }); purgedData = true; } catch {}
      }
      store.apps = store.apps.filter((a) => a.id !== app.id);
      saveStore(store);
      // the installed package folder belongs to the store; remove it with the app
      let removedPackage = false;
      if (app.storeSource && app.cwd && appStore.owns(app.cwd)) {
        try { fs.rmSync(appStore.packageDir(app.cwd), { recursive: true, force: true }); removedPackage = true; } catch {}
      }
      const runs = loadRuns();
      if (runs[app.id]) { delete runs[app.id]; saveRuns(runs); }
      return send(200, { ok: true, id: app.id, purgedOutputs: purge, removedFiles, removedPlugin, removedPackage, purgedData,
        restartRequired: Boolean(removedPlugin), uninstallRun });
    }

    if (sub === 'export-info' && req.method === 'GET') {
      const defDir = defaultExportDir();
      const fileName = buildExportFileName(app);
      const files = getAppFiles(app);
      return send(200, {
        ok: true,
        defaultDir: defDir,
        fileName,
        counts: { views: files.views.length, data: files.data.length },
        hasOutputs: files.views.length > 0 || files.data.length > 0,
      });
    }

    if (sub === 'export' && req.method === 'POST') {
      const b = await readBody();
      try {
        const job = startExportJob(app, {
          destDir: b.destDir,
          includeOutputs: b.includeOutputs === true,
          browserOnly: Boolean(b.browserOnly),
        });
        return send(200, { ok: true, job: publicJobView(job) });
      } catch (e) {
        return send(400, { error: `전달용 내보내기 시작 실패: ${e.message}` });
      }
    }

    if (sub === 'export-status' && req.method === 'GET') {
      const jobId = String(url.searchParams.get('jobId') || '').trim();
      const job = exportJobs.get(jobId);
      if (!job || job.appId !== app.id) return send(404, { error: '내보내기 작업을 찾을 수 없습니다' });
      return send(200, { ok: true, job: publicJobView(job) });
    }

    if (sub === 'export-download' && req.method === 'GET') {
      const jobId = String(url.searchParams.get('jobId') || '').trim();
      const job = exportJobs.get(jobId);
      if (!job || job.appId !== app.id) return send(404, { error: '내보내기 작업을 찾을 수 없습니다' });
      if (job.status !== 'ok' || !job.outputPath || !fs.existsSync(job.outputPath)) {
        return send(409, { error: '아직 내보내기 파일이 준비되지 않았습니다' });
      }
      const st = fs.statSync(job.outputPath);
      const safeName = String(job.fileName || `${app.id}-share.zip`).replace(/[^a-zA-Z0-9._-]/g, '_');
      res.writeHead(200, {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${safeName}"`,
        'content-length': st.size,
        'cache-control': 'no-store',
      });
      fs.createReadStream(job.outputPath).pipe(res);
      return true;
    }

    if (sub === 'export' && req.method === 'GET') {
      try {
        const includeOutputs = url.searchParams.get('includeOutputs') === 'true' || url.searchParams.get('includeOutputs') === '1';
        const job = startExportJob(app, { browserOnly: true, includeOutputs });
        await job._promise;
        if (job.status !== 'ok' || !fs.existsSync(job.outputPath)) {
          throw new Error(job.error || 'ZIP 파일을 생성하지 못했습니다');
        }
        const buf = fs.readFileSync(job.outputPath);
        res.writeHead(200, {
          'content-type': 'application/zip',
          'content-disposition': `attachment; filename="${app.id.replace(/[^a-zA-Z0-9._-]/g, '_')}-share.zip"`,
          'content-length': buf.length,
          'cache-control': 'no-store',
        });
        res.end(buf);
        if (job._tempExportDir) {
          try { fs.rmSync(job._tempExportDir, { recursive: true, force: true }); } catch {}
        }
        exportJobs.delete(job.jobId);
        return true;
      } catch (e) {
        return send(500, { error: `전달용 패키지 생성 실패: ${e.message}` });
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
