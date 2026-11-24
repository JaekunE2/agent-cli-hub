const { spawn } = require('child_process');
const { randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');
const { validate, kinds, MODEL_RE, efforts, inferTaskKind } = require('./project-validation');
const { readSession } = require('./agy-session');
const { scanFloorplan } = require('./workspace-floorplan');

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const stripAnsi = (s) => String(s || '').replace(ANSI_RE, '');

const IGNORE_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '__pycache__', '.venv', 'venv', 'target', '.idea', '.vscode', 'coverage']);
const KEY_SUBDIRS = new Set(['src', 'app', 'lib', 'hub', 'public', 'server', 'client', 'components', 'pages', 'routes', 'api', 'packages', 'scripts', 'tests']);

function inspectWorkspace(dir) {
  if (!dir || typeof dir !== 'string' || !path.isAbsolute(dir)) {
    return { exists: false, isExistingProject: false, fileCount: 0, markers: [], summaryText: '' };
  }
  let ents;
  try {
    const st = fs.statSync(dir, { throwIfNoEntry: false });
    if (!st || !st.isDirectory()) return { exists: false, isExistingProject: false, fileCount: 0, markers: [], summaryText: '' };
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { exists: false, isExistingProject: false, fileCount: 0, markers: [], summaryText: '' };
  }
  const visible = ents.filter((e) => !IGNORE_DIRS.has(e.name) && !e.name.startsWith('.DS_Store'));
  const names = new Set(ents.map((e) => e.name.toLowerCase()));
  const markers = [];
  if (names.has('.git')) markers.push('Git');
  if (names.has('package.json')) markers.push('Node.js');
  if (names.has('pyproject.toml') || names.has('requirements.txt') || names.has('setup.py')) markers.push('Python');
  if (names.has('cargo.toml')) markers.push('Rust');
  if (names.has('go.mod')) markers.push('Go');
  if (names.has('pom.xml') || names.has('build.gradle') || names.has('build.gradle.kts')) markers.push('Java');
  if (names.has('dockerfile') || names.has('docker-compose.yml')) markers.push('Docker');
  if (names.has('readme.md') || names.has('readme.ko.md')) markers.push('README');

  if (!visible.length) {
    return { exists: true, isExistingProject: false, fileCount: 0, markers, summaryText: '' };
  }

  const tree = [];
  for (const e of visible.slice(0, 40)) {
    if (e.isDirectory()) {
      tree.push(`${e.name}/`);
      if (KEY_SUBDIRS.has(e.name.toLowerCase())) {
        try {
          const sub = fs.readdirSync(path.join(dir, e.name), { withFileTypes: true })
            .filter((x) => !IGNORE_DIRS.has(x.name))
            .slice(0, 12)
            .map((x) => `  ${e.name}/${x.name}${x.isDirectory() ? '/' : ''}`);
          tree.push(...sub);
        } catch {}
      }
    } else {
      tree.push(e.name);
    }
  }

  const details = [`Existing workspace directory: ${dir}`];
  if (markers.length) details.push(`Detected stack/markers: ${markers.join(', ')}`);
  details.push(`Workspace files & folders (${visible.length} top-level entries):\n${tree.slice(0, 55).join('\n')}`);

  const pkgPath = path.join(dir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const scripts = Object.keys(pkg.scripts || {}).slice(0, 12).join(', ');
      const deps = [...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.devDependencies || {})].slice(0, 20).join(', ');
      details.push(`package.json summary: name="${pkg.name || ''}"${scripts ? ` scripts=[${scripts}]` : ''}${deps ? ` deps=[${deps}]` : ''}`);
    } catch {}
  }

  for (const rName of ['CLAUDE.md', 'AGENTS.md', 'README.ko.md', 'README.md']) {
    const rp = path.join(dir, rName);
    if (fs.existsSync(rp)) {
      try {
        const excerpt = fs.readFileSync(rp, 'utf8').trim().slice(0, 700);
        if (excerpt) details.push(`${rName} excerpt:\n${excerpt}`);
        break;
      } catch {}
    }
  }

  // Enrich with Floorplan architecture & endpoint summary for higher-precision incremental plans
  try {
    const fp = scanFloorplan(dir, { maxFiles: 220 });
    if (fp.parts.length) {
      details.push(`Architecture layers: ${fp.parts.map((pt) => `${pt.title}(${pt.fileCount} files)`).join(', ')}`);
    }
    if (fp.endpoints.length) {
      details.push(`Detected API endpoints (${fp.endpoints.length}): ${fp.endpoints.slice(0, 16).map((ep) => `${ep.method} ${ep.path}`).join(', ')}`);
    }
  } catch {}

  return {
    exists: true,
    isExistingProject: true,
    fileCount: visible.length,
    markers,
    summaryText: details.join('\n\n'),
  };
}

const makeSchema = (minItems = 2, maxItems = 12) => JSON.stringify({
  type: 'object', required: ['tasks'], additionalProperties: false,
  properties: { tasks: { type: 'array', minItems, maxItems, items: {
    type: 'object', required: ['title', 'detail', 'after', 'kind'], additionalProperties: false,
    properties: {
      title: { type: 'string', maxLength: 240 },
      detail: { type: 'string', maxLength: 1800 },
      kind: { type: 'string', enum: ['plan', 'dev', 'test', 'review', 'ops'] },
      after: { type: 'array', items: { type: 'integer', minimum: 1 } },
    },
  } } },
});
const schema = makeSchema(2, 12);
const subtaskSchema = makeSchema(2, 6);

function readPlan(stdout, project, { parentId = '', minItems = 2, maxItems = 12 } = {}) {
  let output = JSON.parse(stdout.trim());
  if (!output.tasks) output = output.structured_output || output.structuredOutput || output.response || output.result;
  if (typeof output === 'string') output = JSON.parse(output.trim().replace(/^```(?:json)?\s*|\s*```$/gi, ''));
  if (!Array.isArray(output?.tasks) || output.tasks.length < minItems || output.tasks.length > maxItems) {
    throw new Error(`작업은 ${minItems}~${maxItems}개여야 합니다.`);
  }
  const ids = output.tasks.map(() => randomUUID());
  const tasks = output.tasks.map((t, i) => {
    if (!t || !Array.isArray(t.after) || t.after.some(n => !Number.isInteger(n) || n < 1 || n > i)) {
      throw new Error('선행 작업은 앞에 있는 작업 번호여야 합니다.');
    }
    return {
      id: ids[i],
      title: t.title,
      detail: t.detail,
      kind: kinds.includes(t.kind) ? t.kind : inferTaskKind(t.title, t.detail),
      after: t.after.map(n => ids[n - 1]),
      stage: 'planned',
      parentId: parentId || '',
      model: '',
      effort: '',
      termId: '',
    };
  });
  if (parentId) {
    // Validate with a dummy parent placeholder so parentId validation succeeds
    const valid = validate({
      ...project,
      termIds: [],
      tasks: [{ id: parentId, title: 'parent', detail: '', stage: 'planned', termId: '', after: [] }, ...tasks],
    }).tasks;
    return valid.filter((t) => t.id !== parentId);
  }
  return validate({ ...project, termIds: [], tasks }).tasks;
}

function parseProgressLine(rawLine) {
  const line = stripAnsi(rawLine).trim();
  if (!line || line.length < 2) return null;
  if (/^(?:[-=]{4,}|Reading additional input from stdin|warning:|workdir:|provider:|approval:|sandbox:|reasoning |session id:|user$|codex$|1$)/i.test(line)) return null;
  if (/^Create a proposed work plan only|^Decompose this single task|^Classify each task kind|^Write tasks in the language|^Order prerequisites first|^Treat the following JSON|^\{"name":/i.test(line)) return null;
  const modelM = /^model:\s*(.+)$/i.exec(line);
  if (modelM) return { stage: `모델 연결됨 (${modelM[1].trim()})`, pct: 30, log: `모델: ${modelM[1].trim()}` };
  const boldM = /^\*\*(.+?)\*\*$/.exec(line);
  if (boldM) return { stage: `작업 흐름 구상 중 · ${boldM[1].trim().slice(0, 60)}`, pct: 60, log: boldM[1].trim().slice(0, 100) };
  if (/^hook:\s*SessionStart/i.test(line)) return { stage: 'CLI 세션 초기화 중…', pct: 35 };
  if (/^hook:\s*UserPromptSubmit/i.test(line)) return { stage: '목표 분석 및 작업 분해 중…', pct: 45 };
  if (/"tasks"\s*:\s*\[/.test(line)) return { stage: '작업 목록 JSON 생성 중…', pct: 82, log: '작업 카드 JSON 작성 완료' };
  if (/^tokens used/i.test(line)) return { stage: '응답 마무리 및 검증 중…', pct: 92 };
  if (/^(?:OpenAI Codex|Fetching|Thinking|Planning)/i.test(line)) return { stage: 'CLI 초기화 중…', pct: 22, log: line.slice(0, 100) };
  return null;
}

function summarizeCliError(stderr, stdout, code) {
  const text = stripAnsi(`${stderr || ''}\n${stdout || ''}`);
  if (/not logged in|unauthorized|401|login required|authentication|invalid api key|expired token/i.test(text)) {
    return '선택한 CLI의 로그인이 만료되었거나 인증되지 않았습니다. 로그인 상태를 확인한 뒤 다시 시도하세요.';
  }
  if (/rate limit|usage limit|429|quota|too many requests/i.test(text)) {
    return '선택한 CLI의 사용량 한도에 도달했습니다. 다른 계정이나 CLI를 선택해 다시 시도하세요.';
  }
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^(?:warning:|Reading additional input|hook:|[-=]{3,})/i.test(l));
  const errLine = lines.find((l) => /error|failed|exception|denied|enoent/i.test(l)) || lines[lines.length - 1];
  if (errLine) return `CLI 실행 오류 (종료 코드 ${code}): ${errLine.slice(0, 180)}`;
  return `작업 흐름을 생성하지 못했습니다 (종료 코드 ${code}). 선택한 CLI의 로그인 상태를 확인하고 다시 시도하세요.`;
}

function spawnCli(exe, args, { cwd, env, timeoutMs = 120_000, maxBuffer = 1024 * 1024, onProgress, stdinText = null, signal = null } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('작업 흐름 생성이 취소되었습니다.'));
    let stdout = '';
    let stderr = '';
    let settled = false;
    let spawnCmd = exe;
    let spawnArgs = args;
    if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(String(exe || '')) && !/cmd\.exe$/i.test(String(exe || ''))) {
      spawnCmd = 'cmd.exe';
      spawnArgs = ['/c', exe, ...args];
    }
    // IMPORTANT: stdio[0] MUST be 'ignore' (or immediately closed after writing stdinText)
    // so CLIs like `codex exec` get immediate EOF on stdin instead of hanging.
    const hasStdin = stdinText !== null && stdinText !== undefined;
    const child = spawn(spawnCmd, spawnArgs, { cwd, env, windowsHide: true, stdio: [hasStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch {}
      reject(new Error('작업 흐름 생성이 취소되었습니다.'));
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    if (hasStdin && child.stdin) {
      child.stdin.on('error', () => {});
      child.stdin.end(String(stdinText));
    }
    const timer = setTimeout(() => {
      settled = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      try { child.kill(); } catch {}
      const error = new Error(`CLI 실행 제한 시간(${Math.ceil(timeoutMs / 1000)}초)을 초과했습니다.`);
      error.code = 'CLI_TIMEOUT';
      reject(error);
    }, timeoutMs);

    const emitLines = (bufObj, chunk) => {
      bufObj.rest += chunk.toString('utf8');
      let idx;
      while ((idx = bufObj.rest.indexOf('\n')) >= 0) {
        const line = bufObj.rest.slice(0, idx);
        bufObj.rest = bufObj.rest.slice(idx + 1);
        if (onProgress) {
          const ev = parseProgressLine(line);
          if (ev) onProgress(ev);
        }
      }
    };
    const outBuf = { rest: '' };
    const errBuf = { rest: '' };

    child.stdout.on('data', (d) => {
      if (stdout.length < maxBuffer) stdout += d.toString('utf8');
      emitLines(outBuf, d);
    });
    child.stderr.on('data', (d) => {
      if (stderr.length < maxBuffer) stderr += d.toString('utf8');
      emitLines(errBuf, d);
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      reject(new Error(`CLI를 실행하지 못했습니다 (${exe}): ${err.message}`));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (code === 0) return resolve({ stdout, stderr });
      reject(new Error(summarizeCliError(stderr, stdout, code)));
    });
  });
}

const AGY_FAMILY_EFFORTS = {
  'gemini-4-neon': ['low', 'medium', 'high', 'xhigh'],
  'gemini-4-carbon': ['low', 'medium', 'high'],
  'gemini-4-hydrogen': ['low', 'medium', 'high', 'xhigh'],
  'gemini-4-argon': ['low', 'medium', 'high'],
  'gemini-3.8-flash': ['low', 'medium', 'high'],
  'claude-opus-5-5': ['low', 'medium', 'high'],
  'claude-sonnet-5-5': ['low', 'medium', 'high'],
  'gpt-oss-120b': ['medium'],
};

function resolveAgyModelEffort(safeM, safeE) {
  if (!safeM) return { model: '', effort: safeE === 'max' ? 'xhigh' : safeE };
  if (/^gemini-pro-orchestrator(?:-|$)/i.test(safeM)) return { model: safeM, effort: '' };
  const m = /^(.+)-(low|medium|high|xhigh|max)$/i.exec(safeM);
  const family = (m ? m[1] : safeM).toLowerCase();
  const suffix = m ? m[2].toLowerCase() : '';
  const allowed = AGY_FAMILY_EFFORTS[family];
  let targetE = (safeE === 'max' ? 'xhigh' : safeE) || suffix;
  if (allowed) {
    if (!targetE || !allowed.includes(targetE)) {
      targetE = (suffix && allowed.includes(suffix)) ? suffix : allowed[allowed.length - 1];
    }
    return { model: `${family}-${targetE}`, effort: targetE };
  }
  if (m) {
    const eff = targetE || suffix;
    return { model: `${m[1]}-${eff}`, effort: eff };
  }
  return { model: safeM, effort: safeE };
}

function cliModelEffortArgs(agent, model, effort) {
  const m = String(model || '').trim();
  const ef = String(effort || '').trim();
  const safeM = m && MODEL_RE.test(m) ? m : '';
  const safeE = ef && efforts.includes(ef) ? ef : '';
  const out = [];
  if (agent === 'codex') {
    if (safeM) out.push('-m', safeM);
    if (safeE) out.push('-c', `model_reasoning_effort="${safeE}"`);
  } else if (agent === 'claude') {
    if (safeM) out.push('--model', safeM);
    if (safeE) out.push('--effort', safeE);
  } else if (agent === 'agy') {
    const agyME = resolveAgyModelEffort(safeM, safeE);
    if (agyME.model) out.push('--model', agyME.model);
    if (agyME.effort) out.push('--effort', agyME.effort);
  }
  return out;
}

async function runStructuredPlan({ exe, agent, model, effort, prompt, planSchema, cwd, env, launchArgs = [], onProgress, timeoutMs = 120_000, signal }) {
  const run = (args) => spawnCli(exe, args, { cwd, env, timeoutMs, onProgress, signal });
  const extraME = cliModelEffortArgs(agent, model, effort);
  const metaHint = [model, effort].filter(Boolean).join(' · ');
  onProgress?.({ stage: `${agent.toUpperCase()} CLI 실행 중${metaHint ? ` (${metaHint})` : ''}…`, pct: 12 });

  if (agent === 'agy') {
    const log = path.join(cwd, 'agy-plan.log');
    try {
      const { stdout } = await run(['--mode', 'plan', '--sandbox', '--disable-slash-commands', ...extraME, '--print', prompt, '--output-format', 'json', '--json-schema', planSchema, '--log-file', log]);
      onProgress?.({ stage: '생성된 작업 흐름 검증 중…', pct: 95 });
      const { conversation_id } = JSON.parse(stdout);
      return { raw: stdout, sessionId: conversation_id || readSession(log) };
    } finally { fs.rmSync(log, { force: true }); }
  }
  if (agent === 'claude') {
    const { stdout } = await run(['--print', '--no-session-persistence', '--permission-mode', 'plan', '--tools', '', ...extraME, '--output-format', 'json', '--json-schema', planSchema, ...launchArgs, '--', prompt]);
    onProgress?.({ stage: '생성된 작업 흐름 검증 중…', pct: 95 });
    return { raw: stdout };
  }
  if (/\.cmd$/i.test(exe)) throw new Error('작업 설계에 사용할 Codex 실행 파일(.exe)을 허브 설정에서 지정하세요.');
  const schemaFile = path.join(cwd, 'schema.json'), outputFile = path.join(cwd, 'output.json');
  try {
    fs.writeFileSync(schemaFile, planSchema);
    const pre = /plugin-appserver/i.test(exe) ? ['--no-daemon'] : [];
    const { stdout } = await run([...pre, 'exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', ...extraME, '--output-schema', schemaFile, '--output-last-message', outputFile, prompt]);
    onProgress?.({ stage: '생성된 작업 흐름 검증 중…', pct: 95 });
    return { raw: fs.existsSync(outputFile) ? fs.readFileSync(outputFile, 'utf8') : stdout };
  } finally {
    fs.rmSync(schemaFile, { force: true });
    fs.rmSync(outputFile, { force: true });
  }
}

const DEEPENING_PLAN_RULES = [
  'DO NOT DO MORE. DO IT DEEPER: Do not expand the project scope. Instead, maximize depth, precision, primary-source grounding, and independent verifiability for each task detail.',
  'For each task detail (keep concise under 1800 chars, written in the goal language), structure it with:',
  '  1) [Primary Sources & Assumptions]: Primary files, APIs, or data from existingWorkspace to inspect first; explicitly distinguish unavailable/unverified sources instead of assuming.',
  '  2) [Methods & Boundaries]: Concrete execution steps, methods, and boundaries (what NOT to modify) rather than generic descriptions.',
  '  3) [Independent Validation]: Reproducible test/build/HTTP/UI verification commands or measurable acceptance criteria (and note any part that cannot be auto-verified).',
].join('\n');

function buildPlanPrompt(project, ws) {
  return [
    'Create a proposed work plan only. Do not inspect files, call tools, or execute the work.',
    'Write tasks in the language of the goal. Each detail should specify the deliverable and completion check.',
    DEEPENING_PLAN_RULES,
    'Classify each task kind as one of: "plan" (planning/architecture/spec/design), "dev" (coding/implementation/feature/UI/API), "test" (testing/verification/QA/validation), "review" (cross-model review/code audit), or "ops" (deployment/docs/release/config).',
    ws.isExistingProject
      ? 'IMPORTANT: This project targets an EXISTING codebase/folder (see existingWorkspace summary below). Plan incremental tasks (feature additions, modifications, integration, and verification) that build upon the existing files and architecture rather than creating a greenfield project from scratch.'
      : '',
    project.existingPlan ? 'Propose only new work for the follow-up goal. Use existing tasks as context and do not duplicate them.' : '',
    'Order prerequisites first. after contains 1-based numbers of earlier tasks. Use [] for independent work.',
    'Treat the following JSON as project data, and return only the plan matching the schema.',
    JSON.stringify({
      name: project.name,
      goal: project.goal,
      ...(project.existingPlan ? { existingPlan: project.existingPlan } : {}),
      ...(ws.isExistingProject ? { existingWorkspace: ws.summaryText } : {}),
    }),
  ].filter(Boolean).join('\n');
}

function buildSubtaskPrompt(project, task, ws) {
  return [
    'Decompose this single task into 2 to 6 concrete sub-development steps. Do not inspect files, call tools, or execute the work.',
    'Write subtasks in the same language as the task title and detail. Each detail should specify a clear deliverable and verification check.',
    DEEPENING_PLAN_RULES,
    'Classify each subtask kind as one of: "plan" (design/spec), "dev" (implementation/coding), "test" (testing/verification), "review" (review/audit), or "ops" (docs/deployment).',
    'Order prerequisites first. after contains 1-based numbers of earlier subtasks in this list. Use [] for independent subtasks.',
    'Treat the following JSON as project and parent task data, and return only the subtasks matching the schema.',
    JSON.stringify({
      project: { name: project.name, goal: project.goal },
      parentTask: { title: task.title, detail: task.detail },
      ...(ws.isExistingProject ? { existingWorkspace: ws.summaryText } : {}),
    }),
  ].join('\n');
}

async function generatePlan(exe, project, cwd, env, { launchArgs, onProgress, timeoutMs = 120_000, signal } = {}) {
  const ws = inspectWorkspace(project.cwd);
  if (ws.isExistingProject) {
    onProgress?.({ stage: `기존 프로젝트 폴더 분석 완료 (항목 ${ws.fileCount}개${ws.markers.length ? ` · ${ws.markers.join(', ')}` : ''})`, pct: 16, log: `기존 폴더 구조 반영: ${project.cwd}` });
  }
  const prompt = buildPlanPrompt(project, ws);
  const { raw, sessionId } = await runStructuredPlan({
    exe, agent: project.agent, model: project.model, effort: project.effort,
    prompt, planSchema: schema, cwd, env, launchArgs, onProgress, timeoutMs, signal,
  });
  return { tasks: readPlan(raw, project), sessionId };
}

async function generateSubtasks(exe, project, task, cwd, env, { agent, model, effort, launchArgs, onProgress, timeoutMs = 120_000, signal } = {}) {
  const effAgent = agent || task.agent || project.agent || 'codex';
  const ws = inspectWorkspace(project.cwd);
  const prompt = buildSubtaskPrompt(project, task, ws);
  const { raw, sessionId } = await runStructuredPlan({
    exe, agent: effAgent, model: model || task.model || project.model, effort: effort || task.effort || project.effort,
    prompt, planSchema: subtaskSchema, cwd, env, launchArgs, onProgress, timeoutMs, signal,
  });
  return { tasks: readPlan(raw, project, { parentId: task.id, minItems: 2, maxItems: 6 }), sessionId };
}

module.exports = { generatePlan, generateSubtasks, buildPlanPrompt, buildSubtaskPrompt, readPlan, spawnCli, parseProgressLine, cliModelEffortArgs, inspectWorkspace };
