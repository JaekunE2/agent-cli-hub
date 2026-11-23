'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { spawnCli, cliModelEffortArgs } = require('./project-plan');
const { resolveTaskConfig, buildTaskHarnessPrompt } = require('./project-harness');

const MAX_AUTO_RETRIES = 2;
const MAX_REVIEW_ERROR_RETRIES = 2;
const DEFAULT_REVIEW_ERROR_BACKOFF_MS = 15_000;
const DEFAULT_MAX_CONCURRENT = 2;
const IDLE_STREAK_REQUIRED = 2;
const OUTPUT_QUIET_MS = 4500;
const UNSEEN_BUSY_SETTLE_MS = 25000;
const REVIEW_TIMEOUT_MS = 300_000;

function execGit(cwd, args, timeout = 8000) {
  return new Promise((resolve) => {
    if (!cwd || !fs.existsSync(cwd)) return resolve({ ok: false, stdout: '', stderr: '', code: 1 });
    execFile('git', args, { cwd, timeout, maxBuffer: 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        code: err ? (err.code ?? 1) : 0,
      });
    });
  });
}

/**
 * Return planned tasks whose prerequisites (`after`) are all `done`, not `autoExclude`, and have no live terminal running.
 */
function findReadyTasks(project, activeTerms = []) {
  if (!project || !Array.isArray(project.tasks)) return [];
  const byId = new Map(project.tasks.map((t) => [t.id, t]));
  const runningTaskIds = new Set(
    (activeTerms || [])
      .filter((t) => t && t.exited === null && t.meta?.projectTask?.projectId === project.id)
      .map((t) => t.meta.projectTask.taskId)
      .filter(Boolean)
  );

  return project.tasks.filter((t) => {
    if (!t || t.stage !== 'planned' || t.autoExclude) return false;
    if (runningTaskIds.has(t.id)) return false;
    if (t.parentId) {
      const parent = byId.get(t.parentId);
      if (parent && (parent.stage === 'done' || parent.autoExclude)) return false;
    }
    const deps = Array.isArray(t.after) ? t.after : [];
    return deps.every((depId) => byId.get(depId)?.stage === 'done');
  });
}

const inFlight = new Set();
const reviewInFlight = new Set();
const pendingReReview = new Set();
const reviewErrorCounts = new Map();
const orphanDoingTicks = new Map();
const projectLocks = new Map();
let watcherBusy = false;

function withProjectLock(lockKey, fn) {
  const prev = projectLocks.get(lockKey) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  const cleanup = next.finally(() => {
    if (projectLocks.get(lockKey) === cleanup) projectLocks.delete(lockKey);
  });
  projectLocks.set(lockKey, cleanup);
  return next;
}

async function ensureTaskWorktree(projectCwd, taskId) {
  if (!projectCwd || !taskId || !fs.existsSync(projectCwd)) return '';
  const head = await execGit(projectCwd, ['rev-parse', '--verify', 'HEAD'], 5000);
  if (!head.ok) return '';
  const id8 = String(taskId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 8) || 'task';
  const wtRoot = path.join(projectCwd, '.hub-worktrees');
  const wtPath = path.join(wtRoot, `task-${id8}`);
  const branch = `hub-task/${id8}`;
  if (fs.existsSync(wtPath)) return wtPath;
  fs.mkdirSync(wtRoot, { recursive: true });
  const added = await execGit(projectCwd, ['worktree', 'add', '-B', branch, wtPath, 'HEAD'], 15_000);
  return added.ok && fs.existsSync(wtPath) ? wtPath : '';
}

async function mergeAndCleanupWorktree(projectCwd, taskId, worktreePath) {
  if (!projectCwd || !worktreePath || !fs.existsSync(worktreePath)) return { ok: true, skipped: true };
  const id8 = String(taskId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 8) || 'task';
  const branch = `hub-task/${id8}`;
  const st = await execGit(worktreePath, ['status', '--short'], 5000);
  if (st.ok && st.stdout.trim()) {
    await execGit(worktreePath, ['add', '-A'], 8000);
    await execGit(worktreePath, ['commit', '-m', `hub: task ${id8}`], 10_000);
  }
  const merged = await execGit(projectCwd, ['merge', '--no-ff', branch, '-m', `hub: merge task ${id8}`], 15_000);
  if (!merged.ok) {
    await execGit(projectCwd, ['merge', '--abort'], 5000);
    return { ok: false, error: (merged.stderr || merged.stdout || 'worktree merge conflict').trim().slice(0, 500) };
  }
  await execGit(projectCwd, ['worktree', 'remove', '--force', worktreePath], 10_000);
  await execGit(projectCwd, ['branch', '-D', branch], 5000);
  return { ok: true };
}

async function runProjectAutopilot(hub, projectId, { autoDispatch = true, maxConcurrent = DEFAULT_MAX_CONCURRENT } = {}) {
  if (!projectId || inFlight.has(projectId)) return { started: [] };
  inFlight.add(projectId);
  const started = [];
  try {
    const cur = hub.projects.list().find((x) => x.id === projectId);
    if (!cur || !cur.autopilot) return { started };
    const activeDoing = cur.tasks.filter((t) => t.stage === 'doing' && !t.autoExclude).length;
    const cap = Math.max(1, Number(cur.maxConcurrent || maxConcurrent) || DEFAULT_MAX_CONCURRENT);
    const slots = Math.max(0, cap - activeDoing);
    if (slots <= 0) return { started };

    const ready = findReadyTasks(cur, [...hub.terms.values()]).slice(0, slots);
    if (!ready.length) return { started };

    const useWorktrees = cur.worktreeIsolation !== false && (activeDoing > 0 || ready.length > 1);
    const worktreeByTask = new Map();
    if (useWorktrees && cur.cwd) {
      for (const t of ready) {
        const wt = t.worktreePath || await ensureTaskWorktree(cur.cwd, t.id);
        if (wt) worktreeByTask.set(t.id, wt);
      }
    }

    const readyIds = new Set(ready.map((t) => t.id));
    const nextTasks = cur.tasks.map((t) => (readyIds.has(t.id)
      ? { ...t, stage: 'doing', ...(worktreeByTask.has(t.id) ? { worktreePath: worktreeByTask.get(t.id) } : {}) }
      : t));
    hub.projects.save({ ...cur, tasks: nextTasks });

    for (const task of ready) {
      let ok = false;
      try {
        const res = await hub.startProjectTaskById(cur.id, task.id, { autoDispatch });
        if (res && !res.error) {
          started.push({ taskId: task.id, title: task.title, termId: res.id });
          ok = true;
        }
      } catch (e) {
        console.error('[autopilot]', cur.id, task.id, e?.message || e);
      }
      if (!ok) {
        const latest = hub.projects.list().find((x) => x.id === projectId);
        if (latest) {
          const rolledBack = latest.tasks.map((t) => (t.id === task.id && t.stage === 'doing' ? { ...t, stage: 'planned' } : t));
          hub.projects.save({ ...latest, tasks: rolledBack });
        }
      }
    }
    return { started };
  } finally {
    inFlight.delete(projectId);
  }
}

function readUntrackedPreviews(cwd, statusText, maxFiles = 5, maxPerFile = 2000) {
  const previews = [];
  const lines = String(statusText || '').split(/\r?\n/);
  for (const line of lines) {
    if (previews.length >= maxFiles) break;
    const m = /^\?\?\s+(.+)$/.exec(line);
    if (!m) continue;
    const rel = m[1].trim().replace(/^"|"$/g, '');
    if (!rel || rel.startsWith('.hub-worktrees')) continue;
    const abs = path.join(cwd, rel);
    try {
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size > 64 * 1024) continue;
      const buf = fs.readFileSync(abs);
      if (buf.includes(0)) continue;
      previews.push(`[untracked: ${rel}]\n${buf.toString('utf8').slice(0, maxPerFile)}`);
    } catch {}
  }
  return previews.join('\n\n');
}

async function readGitSummary(cwd, maxDiffChars = 12000) {
  if (!cwd || !fs.existsSync(cwd)) return '';
  const st = await execGit(cwd, ['status', '--short'], 5000);
  if (!st.ok) return '';
  const [statRes, stagedRes, unstagedRes] = await Promise.all([
    execGit(cwd, ['diff', '--stat'], 5000),
    execGit(cwd, ['diff', '--cached', '--no-color'], 6000),
    execGit(cwd, ['diff', '--no-color'], 6000),
  ]);
  const parts = [];
  if (st.stdout.trim()) parts.push(`git status:\n${st.stdout.trim().slice(0, 2000)}`);
  if (statRes.stdout.trim()) parts.push(`git diff --stat:\n${statRes.stdout.trim().slice(0, 2000)}`);

  const diffChunks = [];
  if (stagedRes.ok && stagedRes.stdout.trim()) diffChunks.push(`[staged diff]\n${stagedRes.stdout.trim()}`);
  if (unstagedRes.ok && unstagedRes.stdout.trim()) diffChunks.push(`[unstaged diff]\n${unstagedRes.stdout.trim()}`);
  const untracked = readUntrackedPreviews(cwd, st.stdout);
  if (untracked) diffChunks.push(untracked);

  const combinedDiff = diffChunks.join('\n\n');
  if (combinedDiff) {
    const truncated = combinedDiff.length > maxDiffChars ? `\n...(diff truncated at ${maxDiffChars} chars; inspect files directly for more)` : '';
    parts.push(`git diff & new files:\n${combinedDiff.slice(0, maxDiffChars)}${truncated}`);
  }
  return parts.join('\n\n');
}

function detectTestCommand(cwd) {
  const pkgFile = path.join(cwd, 'package.json');
  if (fs.existsSync(pkgFile)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
      const testScript = String(pkg?.scripts?.test || '');
      if (testScript && !/no test specified|--watch/i.test(testScript)) {
        return { cmd: process.platform === 'win32' ? 'npm.cmd' : 'npm', args: ['test'], label: 'npm test' };
      }
    } catch {}
  }
  if (fs.existsSync(path.join(cwd, 'Cargo.toml'))) return { cmd: 'cargo', args: ['test'], label: 'cargo test' };
  if (fs.existsSync(path.join(cwd, 'go.mod'))) return { cmd: 'go', args: ['test', './...'], label: 'go test ./...' };
  if (fs.existsSync(path.join(cwd, 'pytest.ini')) || fs.existsSync(path.join(cwd, 'pyproject.toml')) || fs.existsSync(path.join(cwd, 'setup.cfg'))) {
    return { cmd: 'pytest', args: ['-q'], label: 'pytest -q' };
  }
  return null;
}

function runPreReviewChecks(cwd) {
  return new Promise((resolve) => {
    if (!cwd || !fs.existsSync(cwd)) return resolve({ ran: false });
    const detected = detectTestCommand(cwd);
    if (!detected) return resolve({ ran: false });
    let cmd = detected.cmd;
    let args = detected.args;
    if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd)) {
      args = ['/c', cmd, ...args];
      cmd = 'cmd.exe';
    }
    try {
      execFile(cmd, args, { cwd, timeout: 90_000, maxBuffer: 512 * 1024, windowsHide: true }, (err, stdout, stderr) => {
        const combined = `${stdout || ''}\n${stderr || ''}`.trim();
        resolve({
          ran: true,
          command: detected.label,
          ok: !err,
          exitCode: err ? (err.code ?? 1) : 0,
          output: combined.slice(-2500),
        });
      });
    } catch (err) {
      resolve({
        ran: true,
        command: detected.label,
        ok: false,
        exitCode: err?.code ?? 1,
        output: String(err?.message || err).slice(-2500),
      });
    }
  });
}

function findTaskTerminal(hub, projectId, taskId, { liveOnly = false } = {}) {
  const terms = [...(hub.terms?.values?.() || [])];
  return terms.find((x) => (!liveOnly || x.exited === null) && x.meta?.projectTask?.projectId === projectId && x.meta?.projectTask?.taskId === taskId) || null;
}

function extractTaskSessionId(hub, project, task) {
  const t = findTaskTerminal(hub, project.id, task.id);
  const sid = t ? (hub.termSessionId?.(t) || t.meta?.sessionId || '') : '';
  return String(sid || task?.lastSessionId || '').trim();
}

function extractTaskOutput(hub, project, task) {
  try {
    const t = findTaskTerminal(hub, project.id, task.id);
    if (t) {
      const sid = hub.termSessionId?.(t) || t.meta?.sessionId;
      const doc = sid ? hub.index?.get?.(sid) : null;
      if (doc?.msgs?.length) {
        const lastAsst = [...doc.msgs].reverse().find((m) => m.role === 'assistant' && !String(m.text || '').startsWith('⚙'));
        if (lastAsst?.text) return String(lastAsst.text).trim().slice(0, 3000);
      }
      if (hub.readTerm) {
        const scr = hub.readTerm(t, 90).join('\n').trim();
        if (scr) return scr.slice(-2500);
      }
    }
  } catch {}
  return String(task?.lastOutput || '').trim().slice(0, 3000);
}

function saveTaskHandoffRef(hub, project, task, { reason = '', taskOut = '', gitSummary = '' } = {}) {
  if (!hub?.projectRefs?.saveFile || !project?.id || !task?.id) return;
  try {
    const safeSlug = String(task.title || 'task').replace(/[^a-zA-Z0-9가-힣_-]+/g, '-').slice(0, 28).replace(/^-+|-+$/g, '') || 'task';
    const name = `handoff-${safeSlug}-${String(task.id).slice(0, 8)}.md`;
    const content = [
      `# 완료 태스크 인계: ${task.title}`,
      `- 태스크 ID: ${task.id}`,
      `- 종류: ${task.kind || 'dev'}`,
      reason ? `- 검토 승인 요약: ${reason}` : '',
      '',
      '## 태스크 목표',
      task.detail || '(없음)',
      taskOut ? `\n## 에이전트 최종 출력\n${taskOut}` : '',
      gitSummary ? `\n## 변경 내역 요약\n\`\`\`\n${gitSummary.slice(0, 3500)}\n\`\`\`` : '',
    ].filter(Boolean).join('\n');
    hub.projectRefs.saveFile(project.id, { name, text: content });
  } catch {}
}

function parseReviewVerdict(raw) {
  const txt = String(raw || '').trim();
  const s = txt.indexOf('{');
  const e = txt.lastIndexOf('}');
  let candidateText = txt;
  if (s >= 0 && e > s) {
    try {
      const parsed = JSON.parse(txt.slice(s, e + 1));
      const isEnvelope = Boolean(parsed && typeof parsed === 'object' && ('conversation_id' in parsed || 'json_schema' in parsed || 'denied_actions' in parsed || 'usage' in parsed || 'response' in parsed || 'structured_output' in parsed || 'structuredOutput' in parsed || 'result' in parsed));
      const inner = parsed.structured_output ?? parsed.structuredOutput ?? parsed.response ?? parsed.result;
      if (isEnvelope) {
        if (inner === undefined || inner === null || String(inner).trim() === '') {
          const denied = Array.isArray(parsed.denied_actions) && parsed.denied_actions.length
            ? ` (권한 거부: ${parsed.denied_actions.map((d) => d.display_name || d.action).join(', ')})`
            : '';
          throw new Error(`검토 에이전트가 빈 응답을 반환했습니다${denied}.`);
        }
        candidateText = typeof inner === 'string' ? inner.trim() : JSON.stringify(inner);
      }
      const obj = typeof inner === 'string' ? (() => {
        const iS = inner.indexOf('{');
        const iE = inner.lastIndexOf('}');
        if (iS >= 0 && iE > iS) return JSON.parse(inner.slice(iS, iE + 1));
        return null;
      })() : (inner || parsed);
      if (obj && (obj.verdict === 'APPROVE' || obj.verdict === 'REJECT')) {
        return { verdict: obj.verdict, reason: String(obj.reason || obj.summary || '').trim().slice(0, 1500) };
      }
    } catch (err) {
      if (err && /검토 에이전트가 빈 응답/.test(err.message)) throw err;
    }
  }
  const m = /\b(APPROVE|REJECT)\b/i.exec(candidateText);
  return {
    verdict: m ? m[1].toUpperCase() : 'REJECT',
    reason: candidateText.slice(0, 1000) || '검토 결과를 파싱하지 못했습니다.',
  };
}

const REVIEW_SCHEMA = JSON.stringify({
  type: 'object',
  required: ['verdict', 'reason'],
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['APPROVE', 'REJECT'] },
    reason: { type: 'string', maxLength: 1500 },
  },
});

async function defaultReviewTask(hub, project, task) {
  const harnessState = hub.projectHarness?.get ? hub.projectHarness.get() : null;
  const revCfg = resolveTaskConfig(project, { ...task, kind: 'review', role: 'review', agent: '', model: '', effort: '' }, harnessState);
  const agent = ['claude', 'codex', 'agy'].includes(revCfg.agent) ? revCfg.agent : 'claude';
  const taskCwd = task.worktreePath && fs.existsSync(task.worktreePath) ? task.worktreePath : project.cwd;
  const workCwd = (taskCwd && fs.existsSync(taskCwd)) ? taskCwd : process.cwd();
  const [gitSummary, testCheck] = await Promise.all([readGitSummary(workCwd), runPreReviewChecks(workCwd)]);
  const taskOut = extractTaskOutput(hub, project, task);
  const harnessBlock = buildTaskHarnessPrompt(project, { ...task, kind: 'review', role: 'review' }, agent, harnessState);
  const refsBlock = hub.projectRefs?.promptBlock ? hub.projectRefs.promptBlock(project.id) : '';
  const testBlock = testCheck.ran
    ? (testCheck.ok
      ? `[Pre-Review Automated Test Gate (${testCheck.command}): PASSED (exit 0)]\n${testCheck.output}`
      : `[Pre-Review Automated Test Gate (${testCheck.command}): FAILED (exit ${testCheck.exitCode})]\n${testCheck.output}\nIMPORTANT: Tests failed. Reject unless the failure is demonstrably unrelated to this task.`)
    : '';
  const prompt = [
    'You are an independent automated reviewer for a multi-file software project.',
    'Inspect modified files directly in the workspace if the diff excerpt is incomplete, verify against the task completion criteria and test gate below, and return ONLY JSON matching the schema: {"verdict":"APPROVE"|"REJECT","reason":"concise explanation in Korean"}.',
    'Approve only if there are no blockers, test failures, or missing requirements. If rejected, state concrete fixes needed.',
    `[Project: ${project.name}]`,
    `[Task: ${task.title}]\n${task.detail || ''}`,
    taskOut ? `[에이전트 최종 출력/보고]\n${taskOut}` : '',
    testBlock,
    gitSummary ? `[Workspace Git Summary & Diff]\n${gitSummary}` : '',
    harnessBlock,
    refsBlock,
  ].filter(Boolean).join('\n\n');

  const extraME = cliModelEffortArgs(agent, revCfg.model, revCfg.effort);
  let authEnv = {};
  try { authEnv = hub.projectAccounts?.resolve(agent, revCfg.account)?.env || {}; } catch {}
  const env = { ...(hub.cleanEnv ? hub.cleanEnv() : process.env), ...authEnv };

  if (agent === 'agy') {
    const log = path.join(workCwd, `.agy-review-${Date.now()}.log`);
    try {
      const agyPrompt = prompt.length > 20_000 ? `${prompt.slice(0, 20_000)}\n...(truncated)` : prompt;
      const { stdout } = await spawnCli(hub.agyExe(), ['--mode', 'plan', '--dangerously-skip-permissions', '--disable-slash-commands', ...extraME, '--print', agyPrompt, '--output-format', 'json', '--json-schema', REVIEW_SCHEMA, '--log-file', log], { cwd: workCwd, env, timeoutMs: REVIEW_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 });
      return parseReviewVerdict(stdout);
    } finally { fs.rmSync(log, { force: true }); }
  }
  if (agent === 'codex') {
    const schemaFile = path.join(workCwd, `.codex-rev-schema-${Date.now()}.json`);
    const outFile = path.join(workCwd, `.codex-rev-out-${Date.now()}.json`);
    try {
      fs.writeFileSync(schemaFile, REVIEW_SCHEMA);
      const codexArgs = ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', ...extraME, '--output-schema', schemaFile, '--output-last-message', outFile, '-'];
      const { cmd, args } = hub.codexLaunch ? hub.codexLaunch(codexArgs) : { cmd: hub.codexExe ? hub.codexExe() : 'codex', args: codexArgs };
      const { stdout } = await spawnCli(cmd, args, { cwd: workCwd, env, timeoutMs: REVIEW_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, stdinText: prompt });
      return parseReviewVerdict(fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : stdout);
    } finally {
      fs.rmSync(schemaFile, { force: true });
      fs.rmSync(outFile, { force: true });
    }
  }
  const { stdout } = await spawnCli('claude.exe', ['--print', '--no-session-persistence', '--permission-mode', 'plan', ...extraME, '--output-format', 'json', '--json-schema', REVIEW_SCHEMA], { cwd: workCwd, env, timeoutMs: REVIEW_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, stdinText: prompt });
  return parseReviewVerdict(stdout);
}

async function dispatchRetryFeedback(hub, projectId, task, reason, retryNum, priorSessionId = '') {
  const retryPrompt = [
    `[자동 검토 반려 · 재시도 ${retryNum}/${MAX_AUTO_RETRIES}]`,
    `대상 작업: ${task.title}`,
    `반려 사유: ${reason}`,
    '위 지적 사항을 수정하고 검증 기준을 다시 확인한 뒤 완료해 주세요.',
  ].join('\n');

  const liveTerm = findTaskTerminal(hub, projectId, task.id, { liveOnly: true });
  if (liveTerm && hub.ptyPost) {
    liveTerm._projectBusySeen = false;
    liveTerm._idleStreak = 0;
    liveTerm._projectDispatchedAt = Date.now();
    await hub.ptyPost(liveTerm.id, '/write', { id: liveTerm.id, data: retryPrompt }).catch(() => {});
    await new Promise((r) => setTimeout(r, 400));
    if (liveTerm.exited === null) await hub.ptyPost(liveTerm.id, '/write', { id: liveTerm.id, data: '\r' }).catch(() => {});
    return;
  }
  if (hub.startProjectTaskById) {
    const resume = priorSessionId || task.lastSessionId || '';
    await hub.startProjectTaskById(projectId, task.id, { autoDispatch: true, resume, rawPrompt: retryPrompt });
  }
}

async function completeAutopilotTask(hub, projectId, taskId, { maxRetries = MAX_AUTO_RETRIES, force = false } = {}) {
  const key = `${projectId}:${taskId}`;
  if (reviewInFlight.has(key)) return { skipped: true, started: [] };
  if (force) reviewErrorCounts.delete(key);
  const initialProject = hub.projects.list().find((x) => x.id === projectId);
  const initialTask = initialProject?.tasks?.find((x) => x.id === taskId);
  if (!initialProject || !initialTask) return { started: [] };

  const taskOut = extractTaskOutput(hub, initialProject, initialTask);
  const priorSessionId = extractTaskSessionId(hub, initialProject, initialTask);

  if (!initialProject.autopilot || initialTask.kind === 'review') {
    if (initialTask.stage !== 'done') {
      const nextTasks = initialProject.tasks.map((t) => (t.id === initialTask.id
        ? { ...t, stage: 'done', reviewStatus: 'approved', ...(taskOut ? { lastOutput: taskOut } : {}), ...(priorSessionId ? { lastSessionId: priorSessionId } : {}) }
        : t));
      hub.projects.save({ ...initialProject, tasks: nextTasks });
      hub.overviewStale?.();
    }
    const autoRes = initialProject.autopilot ? await runProjectAutopilot(hub, projectId, { autoDispatch: true }) : { started: [] };
    return { approved: true, started: autoRes.started };
  }

  reviewInFlight.add(key);
  try {
    return await withProjectLock(initialProject.cwd || projectId, async () => {
      const project = hub.projects.list().find((x) => x.id === projectId) || initialProject;
      const task = project.tasks.find((x) => x.id === taskId) || initialTask;
      const reviewingTasks = project.tasks.map((t) => (t.id === task.id
        ? { ...t, stage: 'review', reviewStatus: 'reviewing', reviewNote: '교차 리뷰 에이전트 자동 검토 중…', ...(taskOut ? { lastOutput: taskOut } : {}), ...(priorSessionId ? { lastSessionId: priorSessionId } : {}) }
        : t));
      hub.projects.save({ ...project, tasks: reviewingTasks });
      hub.overviewStale?.();

      let verdict;
      try {
        const reviewer = hub.reviewTask || ((p, t) => defaultReviewTask(hub, p, t));
        verdict = await reviewer(project, task);
      } catch (e) {
        const curP = hub.projects.list().find((x) => x.id === projectId) || project;
        const errCount = (reviewErrorCounts.get(key) || 0) + 1;
        const errMsg = String(e?.message || e).slice(0, 400);
        if (errCount <= MAX_REVIEW_ERROR_RETRIES) {
          reviewErrorCounts.set(key, errCount);
          const delayMs = hub.reviewRetryDelayMs ?? (DEFAULT_REVIEW_ERROR_BACKOFF_MS * errCount);
          const waitTasks = curP.tasks.map((t) => (t.id === task.id
            ? { ...t, stage: 'review', reviewStatus: 'reviewing', reviewNote: `검토 일시 오류 — 자동 재검토 대기 중 (${errCount}/${MAX_REVIEW_ERROR_RETRIES}): ${errMsg}` }
            : t));
          hub.projects.save({ ...curP, tasks: waitTasks });
          hub.overviewStale?.();
          pendingReReview.add(key);
          const timer = setTimeout(() => {
            pendingReReview.delete(key);
            completeAutopilotTask(hub, projectId, taskId, { maxRetries }).catch((err2) => console.error('[autopilot-rereview]', projectId, taskId, err2?.message || err2));
          }, delayMs);
          timer.unref?.();
          return { approved: false, reReviewScheduled: true, reviewErrorCount: errCount, error: e?.message || String(e), started: [] };
        }
        reviewErrorCounts.delete(key);
        const errTasks = curP.tasks.map((t) => (t.id === task.id
          ? { ...t, stage: 'review', reviewStatus: 'error', reviewNote: errMsg }
          : t));
        hub.projects.save({ ...curP, tasks: errTasks });
        hub.overviewStale?.();
        return { approved: false, reReviewScheduled: false, error: e?.message || String(e), started: [] };
      }

      reviewErrorCounts.delete(key);
      const curP = hub.projects.list().find((x) => x.id === projectId) || project;
      const curTask = curP.tasks.find((t) => t.id === task.id) || task;
      const reason = String(verdict?.reason || '').trim() || (verdict?.verdict === 'APPROVE' ? '검증 기준 통과' : '수정 필요');

      if (verdict?.verdict === 'APPROVE') {
        if (curTask.worktreePath) {
          const mergeRes = await mergeAndCleanupWorktree(curP.cwd, curTask.id, curTask.worktreePath);
          if (!mergeRes.ok) {
            const conflictReason = `병렬 워크트리 병합 충돌: ${mergeRes.error}`;
            const conflictTasks = curP.tasks.map((t) => (t.id === task.id
              ? { ...t, stage: 'review', reviewStatus: 'rejected', reviewNote: conflictReason }
              : t));
            hub.projects.save({ ...curP, tasks: conflictTasks });
            hub.overviewStale?.();
            return { approved: false, mergeConflict: true, reason: conflictReason, started: [] };
          }
        }
        const doneTasks = curP.tasks.map((t) => (t.id === task.id
          ? { ...t, stage: 'done', reviewStatus: 'approved', reviewNote: reason, worktreePath: '', ...(taskOut ? { lastOutput: taskOut } : {}), ...(priorSessionId ? { lastSessionId: priorSessionId } : {}) }
          : t));
        hub.projects.save({ ...curP, tasks: doneTasks });
        hub.overviewStale?.();
        if (hub.projectRefs?.saveFile) {
          const gitSummary = await readGitSummary(curP.cwd, 3500).catch(() => '');
          saveTaskHandoffRef(hub, curP, curTask, { reason, taskOut, gitSummary });
        }
        const autoRes = await runProjectAutopilot(hub, projectId, { autoDispatch: true });
        return { approved: true, reason, started: autoRes.started };
      }

      const retries = Number(curTask.retryCount || 0);
      if (retries < maxRetries) {
        const nextRetry = retries + 1;
        const retryTasks = curP.tasks.map((t) => (t.id === task.id
          ? { ...t, stage: 'doing', reviewStatus: 'rejected', reviewNote: reason, retryCount: nextRetry, ...(priorSessionId ? { lastSessionId: priorSessionId } : {}) }
          : t));
        hub.projects.save({ ...curP, tasks: retryTasks });
        hub.overviewStale?.();
        await dispatchRetryFeedback(hub, projectId, curTask, reason, nextRetry, priorSessionId);
        return { approved: false, retried: true, retryCount: nextRetry, reason, started: [] };
      }

      const pausedTasks = curP.tasks.map((t) => (t.id === task.id
        ? { ...t, stage: 'review', reviewStatus: 'rejected', reviewNote: `[재시도 ${maxRetries}회 초과] ${reason}` }
        : t));
      hub.projects.save({ ...curP, tasks: pausedTasks });
      hub.overviewStale?.();
      return { approved: false, retried: false, reason, started: [] };
    });
  } finally {
    reviewInFlight.delete(key);
  }
}

async function checkAutopilotCompletions(hub) {
  if (watcherBusy || !hub?.terms || !hub?.projects) return [];
  watcherBusy = true;
  const scheduled = [];
  try {
    const now = Date.now();
    for (const t of hub.terms.values()) {
      const pt = t.meta?.projectTask;
      if (!pt?.projectId || !pt?.taskId) continue;
      if (!t._projectDispatchedAt && t.meta?.spawnedAt) t._projectDispatchedAt = t.meta.spawnedAt;
      const cli = hub.agentOf?.(t);
      const status = t.exited !== null
        ? 'exited'
        : cli === 'codex'
          ? hub.codexStatus?.(t)
          : cli === 'agy'
            ? hub.agyStatus?.(t)
            : hub.claudeStatus?.(t);
      if (status === 'busy') {
        t._projectBusySeen = true;
        t._idleStreak = 0;
        continue;
      }
      if (t.exited === null && hub.readTerm && hub.ptyPost) {
        const scr = hub.readTerm(t, 25).join('\n');
        if (/trust this folder|Do you trust/i.test(scr) && !t._autoTrustedAt) {
          t._autoTrustedAt = now;
          t._idleStreak = 0;
          await hub.ptyPost(t.id, '/write', { id: t.id, data: '\r' }).catch(() => {});
          continue;
        }
      }
      const recentOutput = !!(t.lastOutputAt && now - t.lastOutputAt < OUTPUT_QUIET_MS);
      if (status === 'idle' && recentOutput) {
        t._idleStreak = 0;
        continue;
      }
      t._idleStreak = (t._idleStreak || 0) + 1;
      const settledAfterUnseen = !t._projectBusySeen && t._projectDispatchedAt && (now - t._projectDispatchedAt > UNSEEN_BUSY_SETTLE_MS) && t._idleStreak >= IDLE_STREAK_REQUIRED;
      const doneNow = (t._projectBusySeen && status === 'idle' && t._idleStreak >= IDLE_STREAK_REQUIRED)
        || settledAfterUnseen
        || (status === 'exited' && t._projectDispatchedAt);
      if (!doneNow) continue;

      const project = hub.projects.list().find((x) => x.id === pt.projectId);
      const task = project?.tasks?.find((x) => x.id === pt.taskId);
      if (!project || !project.autopilot || !task || task.stage !== 'doing' || task.autoExclude) continue;

      t._projectBusySeen = false;
      t._idleStreak = 0;
      t._projectDispatchedAt = 0;
      const pRun = completeAutopilotTask(hub, project.id, task.id).catch((e) => console.error('[autopilot-review]', project.id, task.id, e?.message || e));
      scheduled.push({ projectId: project.id, completedTaskId: task.id, promise: pRun });
    }

    // Subtask rollup & orphan recovery (e.g. after server restart)
    const activeTermTaskKeys = new Set(
      [...hub.terms.values()]
        .filter((t) => t.meta?.projectTask?.projectId && t.meta?.projectTask?.taskId)
        .map((t) => `${t.meta.projectTask.projectId}:${t.meta.projectTask.taskId}`)
    );
    for (const project of hub.projects.list()) {
      if (!project.autopilot || !Array.isArray(project.tasks)) continue;
      const byParent = new Map();
      let recoveredDoing = false;
      const recoveredTasks = project.tasks.map((tk) => {
        if (tk.parentId) (byParent.get(tk.parentId) || byParent.set(tk.parentId, []).get(tk.parentId)).push(tk);
        const tkKey = `${project.id}:${tk.id}`;
        if (tk.stage === 'review' && tk.reviewStatus === 'reviewing' && !reviewInFlight.has(tkKey) && !pendingReReview.has(tkKey)) {
          const pRun = completeAutopilotTask(hub, project.id, tk.id).catch((e) => console.error('[autopilot-orphan-review]', project.id, tk.id, e?.message || e));
          scheduled.push({ projectId: project.id, completedTaskId: tk.id, recoveredReview: true, promise: pRun });
        }
        if (tk.stage === 'doing' && !tk.autoExclude && !inFlight.has(project.id) && !reviewInFlight.has(tkKey)) {
          if (activeTermTaskKeys.has(tkKey)) {
            orphanDoingTicks.delete(tkKey);
          } else {
            const ticks = (orphanDoingTicks.get(tkKey) || 0) + 1;
            orphanDoingTicks.set(tkKey, ticks);
            if (ticks >= 4) {
              orphanDoingTicks.delete(tkKey);
              recoveredDoing = true;
              return { ...tk, stage: 'planned' };
            }
          }
        }
        return tk;
      });
      if (recoveredDoing) {
        hub.projects.save({ ...project, tasks: recoveredTasks });
        const pAuto = runProjectAutopilot(hub, project.id, { autoDispatch: true }).catch((e) => console.error('[autopilot-orphan-doing]', project.id, e?.message || e));
        scheduled.push({ projectId: project.id, recoveredDoing: true, promise: pAuto });
      }
      for (const [parentId, subs] of byParent) {
        const parent = project.tasks.find((x) => x.id === parentId);
        if (!parent || parent.stage === 'done' || parent.stage === 'review' || parent.autoExclude) continue;
        const activeSubs = subs.filter((s) => !s.autoExclude);
        if (activeSubs.length && activeSubs.every((s) => s.stage === 'done')) {
          const pRun = completeAutopilotTask(hub, project.id, parent.id).catch((e) => console.error('[autopilot-rollup]', project.id, parent.id, e?.message || e));
          scheduled.push({ projectId: project.id, completedTaskId: parent.id, rollup: true, promise: pRun });
        }
      }
    }
    return scheduled;
  } finally {
    watcherBusy = false;
  }
}

module.exports = {
  findReadyTasks,
  runProjectAutopilot,
  completeAutopilotTask,
  checkAutopilotCompletions,
  parseReviewVerdict,
  runPreReviewChecks,
  readGitSummary,
  detectTestCommand,
  ensureTaskWorktree,
  mergeAndCleanupWorktree,
};
