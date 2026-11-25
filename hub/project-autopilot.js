'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { execFile } = require('child_process');
const { spawnCli, cliModelEffortArgs } = require('./project-plan');
const { parseAgyJson, parseClaudeJson, parseCodexJsonl } = require('./task-subchat');
const { resolveTaskConfig, buildTaskHarnessPrompt } = require('./project-harness');
const { versionWorkspace } = require('./version-files');
const { isGit } = require('./project-file-runs');
const { integrateBatch } = require('./project-integration');
const { runReview, hasReviewClaim } = require('./project-review-run');
const { prepareProjectPrompt } = require('./project-prompt');
const { projectDeliveryResult, deliveryError } = require('./project-history');
const { requiredMcpMessage } = require('./vault-cli-ops');
const { sessionStartupBlock, dismissProjectHookMenu, dispatchTerminalPrompt, terminalConfirmationMessage, HOOK_MENU_MESSAGE, DUMB_TERMINAL_MESSAGE } = require('./term-manager');

const MAX_AUTO_RETRIES = 2;
const MAX_REVIEW_ERROR_RETRIES = 2;
const DEFAULT_REVIEW_ERROR_BACKOFF_MS = 15_000;
const DEFAULT_MAX_CONCURRENT = 2;
const IDLE_STREAK_REQUIRED = 2;
const OUTPUT_QUIET_MS = 4500;
const RESULT_INDEX_GRACE_MS = 15_000;
const DISPATCH_IDLE_LIMIT_MS = 90_000;
const REVIEW_TIMEOUT_MS = 10 * 60_000;
const MERGE_CONFLICT_TIMEOUT_MS = 15 * 60_000;
const PROJECT_TEST_TIMEOUT_MS = 5 * 60_000;

function execGit(cwd, args, timeout = 8000) {
  return new Promise((resolve) => {
    if (!cwd || !fs.existsSync(cwd)) return resolve({ ok: false, stdout: '', stderr: '', code: 1 });
    execFile('git', args, { cwd, timeout, maxBuffer: 1024 * 1024, windowsHide: true, env: { ...process.env, LC_ALL: 'C' } }, (err, stdout, stderr) => {
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
    if (!t || t.stage !== 'planned' || t.autoExclude || t.launchBlock) return false;
    if (t.version && !versionWorkspace(project, t.version)) return false;
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
const pendingReReview = new Map();
const orphanDoingTicks = new Map();
const operationLocks = new Map();
let watcherBusy = false;

function withOperationLock(lockKey, fn) {
  const prev = operationLocks.get(lockKey) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  const cleanup = next.finally(() => {
    if (operationLocks.get(lockKey) === cleanup) operationLocks.delete(lockKey);
  });
  operationLocks.set(lockKey, cleanup);
  return cleanup;
}

function folderKey(cwd) {
  let resolved = path.resolve(cwd || process.cwd());
  try {
    resolved = fs.realpathSync.native(resolved);
    const { dev, ino } = fs.statSync(resolved, { bigint: true });
    if (ino) return `${dev}:${ino}`;
  }
  catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function reviewWorkspace(project, task) {
  const workspace = versionWorkspace(project, task.version);
  const cwd = (workspace === project.cwd && task.worktreePath) || workspace;
  return cwd && fs.existsSync(cwd) ? cwd : process.cwd();
}

const reviewDir = (hub, run) => path.join(hub.baseDir || __dirname, 'data', 'review-runs', run.id);

async function ensureTaskWorktree(projectCwd, taskId) {
  if (!projectCwd || !taskId || !fs.existsSync(projectCwd)) return '';
  const head = await execGit(projectCwd, ['rev-parse', '--verify', 'HEAD'], 5000);
  if (!head.ok) return '';
  const id8 = String(taskId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 8) || 'task';
  const wtRoot = path.join(projectCwd, '.hub-worktrees');
  const wtPath = path.join(wtRoot, `task-${id8}`);
  const branch = `hub-task/${id8}`;
  if (fs.existsSync(wtPath)) {
    const source = await execGit(wtPath, ['symbolic-ref', '--short', 'HEAD']);
    return source.ok && source.stdout.trim() === branch ? wtPath : '';
  }
  fs.mkdirSync(wtRoot, { recursive: true });
  const existing = await execGit(projectCwd, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
  const added = await execGit(projectCwd, ['worktree', 'add', ...(existing.ok ? [wtPath, branch] : ['-b', branch, wtPath, 'HEAD'])], 15_000);
  return added.ok && fs.existsSync(wtPath) ? wtPath : '';
}

async function prepareTaskMerge(projectCwd, taskId, worktreePath, { commitChanges = true } = {}) {
  if (!projectCwd || !worktreePath || !fs.existsSync(worktreePath)) return { ok: false, error: '격리 작업 폴더를 찾을 수 없습니다.' };
  const id8 = String(taskId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 8) || 'task';
  const workspace = folderKey(worktreePath);
  if (workspace === folderKey(projectCwd) || workspace !== folderKey(path.join(projectCwd, '.hub-worktrees', `task-${id8}`))) {
    return { ok: false, error: '격리 작업 브랜치가 일치하지 않습니다.' };
  }
  const branch = `hub-task/${id8}`;
  const source = await execGit(worktreePath, ['symbolic-ref', '--short', 'HEAD']);
  if (!source.ok || source.stdout.trim() !== branch) return { ok: false, error: '격리 작업 브랜치가 일치하지 않습니다.' };
  const sourceHead = await execGit(worktreePath, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const targetHead = await execGit(projectCwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!sourceHead.ok || !targetHead.ok || sourceHead.stdout.trim() !== targetHead.stdout.trim()) {
    return { ok: false, error: '격리 작업 브랜치가 일치하지 않습니다.' };
  }
  const st = await execGit(worktreePath, ['status', '--short'], 5000);
  if (!st.ok) return { ok: false, error: st.stderr.trim() };
  if (st.stdout.trim()) {
    if (!commitChanges) return { ok: false, error: '격리 폴더에 검토 이후 변경된 파일이 있습니다. 다시 검토하세요.' };
    const added = await execGit(worktreePath, ['add', '-A'], 8000);
    if (!added.ok) return { ok: false, error: added.stderr.trim() };
    const committed = await execGit(worktreePath, ['commit', '-m', `hub: task ${id8}`], 10_000);
    if (!committed.ok) return { ok: false, error: (committed.stderr || committed.stdout).trim() };
  }
  const head = await execGit(worktreePath, ['rev-parse', 'HEAD']);
  return head.ok ? { ok: true, branch, commit: head.stdout.trim() } : { ok: false, error: head.stderr.trim() };
}

function approvedMerge(task) {
  return (task.stage === 'merge' || task.stage === 'review') && ['merge-pending', 'merge-integrating', 'merge-blocked'].includes(task.reviewStatus);
}

function mergeQueue(project) {
  return project.tasks.filter((task) => task.worktreePath && approvedMerge(task)).sort((a, b) =>
    Number(!!b.mergeRun?.ids) - Number(!!a.mergeRun?.ids) || (a.mergeRun?.queuedAt || 0) - (b.mergeRun?.queuedAt || 0));
}

const SECRET_LEAK_RE = /(?:sk-ant-[A-Za-z0-9_-]{12,}|sk-proj-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;

function lintEvidence(gitSummary = '', taskOut = '') {
  const combined = `${gitSummary}\n${taskOut}`;
  if (SECRET_LEAK_RE.test(combined)) {
    return { ok: false, reason: '보안 위생 검사 경고: 출력 또는 변경사항에 API 키·비밀키 패턴이 감지되어 자동 검토를 일시 정지했습니다.' };
  }
  return { ok: true };
}

function cleanupDoneTerminals(hub, project, taskIds = []) {
  if (!project?.autoCloseDoneTerms || !hub?.terms || !hub?.forgetTerm) return;
  const idSet = new Set(taskIds);
  for (const t of [...hub.terms.values()]) {
    if (t.exited !== null || t.meta?.operator) continue;
    const pt = t.meta?.projectTask;
    const ptm = t.meta?.projectMerge;
    if ((pt?.projectId === project.id && idSet.has(pt.taskId)) || (ptm?.projectId === project.id && ptm.taskIds?.some((id) => idSet.has(id)))) {
      hub.forgetTerm(t);
    }
  }
}

async function finishApprovedTask(hub, project, task, reason, taskOut, sessionId) {
  const { id: projectId } = project;
  const { id: taskId } = task;
  const tasks = project.tasks.map((item) => item.id === taskId
    ? { ...item, stage: 'done', reviewStatus: 'approved', reviewPaused: false, reviewNote: reason, mergeApprovalNote: '', retryCount: 0, worktreePath: '',
      ...(taskOut ? { lastOutput: taskOut } : {}), ...(sessionId ? { lastSessionId: sessionId } : {}) } : item);
  const saved = hub.projects.save({ ...project, tasks });
  await finishFileRun(hub, saved, taskId);
  cleanupDoneTerminals(hub, saved, [taskId]);
  hub.overviewStale?.();
  if (hub.projectRefs?.saveFile) {
    const gitSummary = await readGitSummary(versionWorkspace(project, task.version), 3500).catch(() => '');
    saveTaskHandoffRef(hub, project, task, { reason, taskOut, gitSummary });
  }
  const autoRes = await runProjectAutopilot(hub, projectId, { autoDispatch: true });
  return { approved: true, reason, started: autoRes.started };
}

async function finishFileRun(hub, project, taskId) {
  const id = project?.tasks.find((task) => task.id === taskId)?.lastRun?.fileRunId;
  if (id) await hub.fileRuns.finish(project.id, id);
}

async function runProjectIntegration(hub, project, retry, maxRetries) {
  const cwd = project.cwd;
  const waiting = mergeQueue(project);
  const leader = waiting[0];
  if (!leader || (!retry && (leader.reviewPaused || Date.now() < (leader.mergeRun?.retryAt || 0)))) return { skipped: true, started: [] };
  let run = leader.mergeRun;
  const queue = run?.ids ? waiting.filter((task) => run.ids.includes(task.id)) : waiting;
  if (run?.ids && queue.length !== run.ids.length) {
    const reason = '통합 대기열의 작업이 변경되었습니다.';
    hub.projects.save({ ...project, tasks: project.tasks.map((task) => task.id === leader.id
      ? { ...task, reviewStatus: 'merge-blocked', reviewPaused: true, reviewNote: reason } : task) });
    hub.overviewStale?.();
    return { reason, started: [] };
  }
  if (!retry && queue.some((task) => task.reviewStatus === 'merge-blocked')) return { skipped: true, started: [] };
  const byId = new Map(queue.map((task) => [task.id, task]));
  if (!run?.ids && project.tasks.some((task) => task.worktreePath && !task.reviewPaused && !task.autoExclude
    && !task.after?.some((id) => byId.has(id)) && !queue.some((item) => item.parentId === task.id)
    && (task.stage === 'doing' || task.stage === 'review' && !approvedMerge(task)))) return { mergePending: true, started: [] };
  const waitingMessage = '통합 중 대상 브랜치가 이동했습니다. 새 커밋 기준으로 다시 통합합니다.';
  const order = new Map();
  const seen = new Set();
  const visit = (task) => {
    if (seen.has(task.id)) return;
    seen.add(task.id);
    for (const id of task.after || []) if (byId.has(id)) visit(byId.get(id));
    order.set(task.id, task);
  };
  if (run?.ids) run.ids.forEach((id) => order.set(id, byId.get(id)));
  else queue.forEach(visit);
  if (!run?.ids) run = { id: randomUUID(), queuedAt: run?.queuedAt || Date.now(), ids: [...order.keys()], attempt: 0, failures: 0, maxRetries };
  if (retry && leader.reviewPaused) run = { ...run, failures: 0, retryAt: 0 };
  const latest = () => hub.projects.list().find((item) => item.id === project.id);
  const stillQueued = (task) => approvedMerge(task) && byId.get(task.id)?.worktreePath === task.worktreePath
    && byId.get(task.id)?.mergeCommit === task.mergeCommit;
  const current = () => {
    const p = latest();
    return p?.cwd === cwd && p.tasks.filter(stillQueued).length === queue.length;
  };
  const update = (reviewStatus, reviewNote, state = run) => {
    const p = latest();
    if (!p || !current()) throw new Error('통합 대기열의 작업이 변경되었습니다.');
    run = state;
    hub.projects.save({ ...p, tasks: p.tasks.map((task) => stillQueued(task)
      ? { ...task, stage: 'merge', ...(task.id === leader.id ? { mergeRun: run } : {}), reviewStatus, reviewNote, reviewPaused: reviewStatus === 'merge-blocked' } : task) },
    { mergeRun: { taskId: leader.id, run } });
    hub.overviewStale?.();
  };
  let result;
  const entries = [];
  for (const task of order.values()) {
    const prepared = await prepareTaskMerge(cwd, task.id, task.worktreePath, { commitChanges: false });
    if (!prepared.ok) { result = { error: prepared.error }; break; }
    if (task.mergeCommit && task.mergeCommit !== prepared.commit) {
      result = { error: '격리 폴더에 검토 이후 변경된 파일이 있습니다. 다시 검토하세요.' };
      break;
    }
    entries.push({ id: task.id, title: task.title, commit: prepared.commit, reason: task.mergeApprovalNote });
  }
  if (!result) {
    update('merge-integrating', '통합 진행 중');
    try {
      result = await integrateBatch({
        cwd, entries, git: execGit, current, runId: run.id, target: run.target, conflict: run.conflict,
        saveTarget: (target) => update('merge-integrating', '통합 진행 중', { ...run, target }),
        saveConflict: (conflict) => update('merge-integrating', '통합 충돌 확인', { ...run, conflict }),
        progress: (phase, worktree) => update('merge-integrating', `${phase} · 재시도 ${run.failures}/${run.maxRetries}\n${worktree}`, { ...run, worktree }),
        resolve: async (worktree, entry, files) => {
          if (hub.resolveIntegrationConflict) return hub.resolveIntegrationConflict(worktree, entry, files);
          const dir = path.join(hub.baseDir || __dirname, 'data', 'merge-runs', run.id, `${run.attempt}-${run.ids.indexOf(entry.id)}`);
          const prompt = ['Resolve this Git merge in the current integration worktree.', 'Edit only the listed conflict files. Preserve both changes where compatible. Do not stage, commit, use the network, or change other worktrees.',
            'Inspect and edit the working files even if Git already shows them as staged. Remove all conflict markers and verify the resolutions before returning.',
            JSON.stringify({ task: entry.title, review: entry.reason, conflicts: files })].join('\n');
          try {
            await runReview(dir, async () => ({
              ...hub.codexLaunch(['-a', 'never', 'exec', '--sandbox', 'workspace-write', '-']), conflictResolution: true,
              options: { cwd: worktree, env: hub.cleanEnv(), stdinText: prompt, timeoutMs: MERGE_CONFLICT_TIMEOUT_MS },
            }));
          } catch (error) {
            throw Object.assign(new Error(`통합 충돌 해결 실패: ${error.message}`), { code: error.code });
          }
        },
        check: hub.validateIntegration || (async (worktree) => {
          const relative = detectTestCommand(worktree) ? '' : 'hub';
          const result = await runPreReviewChecks(path.join(worktree, relative), {
            NODE_PATH: [path.join(cwd, relative, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter),
          });
          if (!result.ran) throw new Error('통합 테스트 명령을 찾을 수 없습니다.');
          if (!result.ok) throw new Error([result.command, result.output].filter(Boolean).join('\n'));
        }),
      });
    } catch (error) { result = { error: error.message }; }
  }
  if (result.skipped || !current()) return { skipped: true, started: [] };
  if (!result.ok) {
    const failures = run.failures + 1;
    const pending = !!project.autopilot && failures <= run.maxRetries && result.code !== 'REVIEW_UNCERTAIN';
    const reason = [result.error || waitingMessage, result.worktree || run.worktree].filter(Boolean).join('\n');
    update(pending ? 'merge-pending' : 'merge-blocked', `통합 실패 및 재시도 한도 (${failures}/${run.maxRetries + 1})\n${reason}`, {
      ...run, failures, attempt: run.attempt + 1, retryAt: pending ? Date.now() + (hub.mergeRetryDelayMs ?? 1000) : 0,
      ...(result.pending ? { target: { ref: run.target.ref }, conflict: null } : {}),
      diagnostics: [...(run.diagnostics || []), { attempt: run.attempt, reason }].slice(-10),
    });
    return { approved: false, mergePending: pending, reason, started: [] };
  }
  const p = latest();
  if (hub.startProjectMergeSession) {
    const tipShort = result.tip.slice(0, 8);
    hub.projects.save({ ...p, tasks: p.tasks.map((task) => stillQueued(task) ? {
      ...task, stage: 'merge', reviewStatus: 'merge-session', reviewPaused: false, mergeTip: result.tip,
      reviewNote: [task.mergeApprovalNote, `1차 자동 병합 완료 (${tipShort}) · 병합 세션에서 최종 확인 중`].filter(Boolean).join('\n'),
    } : task) });
    hub.overviewStale?.();
    const session = await hub.startProjectMergeSession(p, queue, result);
    if (session?.error) {
      const curP = latest();
      hub.projects.save({ ...curP, tasks: curP.tasks.map((task) => task.stage === 'merge' && task.reviewStatus === 'merge-session' && queue.some((q) => q.id === task.id) ? {
        ...task, reviewStatus: 'merge-blocked', reviewPaused: true, reviewNote: `병합 세션 시작 실패: ${session.error}`,
      } : task) });
      hub.overviewStale?.();
      return { approved: false, mergePending: false, reason: session.error, started: [] };
    }
    const curP = latest();
    hub.projects.save({ ...curP, tasks: curP.tasks.map((task) => task.stage === 'merge' && task.reviewStatus === 'merge-session' && queue.some((q) => q.id === task.id) ? {
      ...task, mergeTermId: session.id,
    } : task) });
    hub.overviewStale?.();
    return { approved: false, mergeSession: true, termId: session.id, started: [] };
  }
  hub.projects.save({ ...p, tasks: p.tasks.map((task) => stillQueued(task) ? {
    ...task, stage: 'done', reviewStatus: 'approved', reviewPaused: false, retryCount: 0,
    reviewNote: [task.mergeApprovalNote, `대상 브랜치 반영 완료 (${result.tip.slice(0, 8)})`,
      task.retryCount ? `수정 재시도 (${task.retryCount})` : '', run.diagnostics?.length ? `통합 재시도 (${run.diagnostics.length})` : '',
    ].filter(Boolean).join('\n'),
    mergeApprovalNote: '', mergeCommit: '', worktreePath: '',
  } : task) });
  hub.overviewStale?.();
  for (const task of queue) {
    saveTaskHandoffRef(hub, p, task, { reason: task.mergeApprovalNote, taskOut: task.lastOutput });
  }
  const { started } = await runProjectAutopilot(hub, p.id);
  return { approved: true, started };
}

async function runProjectAutopilot(hub, projectId, { autoDispatch = true, maxConcurrent = DEFAULT_MAX_CONCURRENT } = {}) {
  if (!projectId || inFlight.has(projectId)) return { started: [] };
  inFlight.add(projectId);
  const started = [];
  try {
    const cur = hub.projects.list().find((x) => x.id === projectId);
    if (!cur || !cur.autopilot) return { started };
    const activeDoing = cur.tasks.filter((t) => t.stage === 'doing' && !t.autoExclude && !t.reviewPaused).length;
    const cap = Math.max(1, Number(cur.maxConcurrent || maxConcurrent) || DEFAULT_MAX_CONCURRENT);
    const slots = Math.max(0, cap - activeDoing);
    if (slots <= 0) return { started };

    const activeRuns = new Set(cur.tasks.map((task) => task.lastRun?.fileRunId));
    const completing = new Set((cur.fileRuns || []).filter((run) => activeRuns.has(run.id) && run.completingAt && !run.finishedAt).map((run) => run.cwd));
    const ready = findReadyTasks(cur, [...hub.terms.values()]).filter((task) => !completing.has(versionWorkspace(cur, task.version)));
    if (!ready.length) return { started };

    const occupied = new Set(cur.tasks.filter((t) => t.stage === 'doing' || t.stage === 'review').map((t) => versionWorkspace(cur, t.version)));
    const isolated = ready.filter((task) => {
      const cwd = versionWorkspace(cur, task.version);
      if (!cwd || cwd === cur.cwd || occupied.has(cwd) || !fs.existsSync(cwd)) return false;
      occupied.add(cwd);
      return true;
    });
    const workingMain = cur.tasks.some((t) => t.stage === 'doing' && !t.autoExclude && !t.reviewPaused && versionWorkspace(cur, t.version) === cur.cwd);
    const regular = ready.filter((t) => versionWorkspace(cur, t.version) === cur.cwd);
    const projectGit = regular.length && cur.cwd && fs.existsSync(cur.cwd) && await isGit(cur.cwd)
      && await execGit(cur.cwd, ['rev-parse', '--verify', 'HEAD']);
    const regularEligible = cur.worktreeIsolation !== false && cur.cwd && fs.existsSync(cur.cwd) && !projectGit?.ok
      ? regular.slice(0, workingMain ? 0 : 1) : regular;
    const eligible = new Set([...regularEligible, ...isolated]);
    const candidates = ready.filter((task) => eligible.has(task)).slice(0, slots);
    const mainCandidates = candidates.filter((t) => versionWorkspace(cur, t.version) === cur.cwd);
    const useWorktrees = cur.worktreeIsolation !== false && projectGit?.ok && (workingMain || mainCandidates.length > 1 || mainCandidates.some((t) => t.worktreePath));
    const worktreeByTask = new Map();
    if (useWorktrees && cur.cwd) {
      for (const t of mainCandidates) {
        const wt = await ensureTaskWorktree(cur.cwd, t.id);
        if (wt) worktreeByTask.set(t.id, wt);
      }
    }
    const launchable = useWorktrees ? candidates.filter((task) => !mainCandidates.includes(task) || worktreeByTask.has(task.id)) : candidates;
    if (!launchable.length) return { started };

    const readyIds = new Set(launchable.map((t) => t.id));
    const latest = hub.projects.list().find((item) => item.id === projectId);
    if (!latest?.autopilot || latest.cwd !== cur.cwd) return { started };
    const stillReady = new Set(findReadyTasks(latest, [...hub.terms.values()]).map((t) => t.id));
    if (launchable.some((t) => !stillReady.has(t.id) || latest.tasks.find((item) => item.id === t.id)?.version !== t.version)) return { started };
    const nextTasks = latest.tasks.map((t) => (readyIds.has(t.id)
      ? { ...t, stage: 'doing', ...(worktreeByTask.has(t.id) ? { worktreePath: worktreeByTask.get(t.id) } : {}) }
      : t));
    hub.projects.save({ ...latest, tasks: nextTasks });

    for (const task of launchable) {
      let ok = false;
      try {
        const res = await hub.startProjectTaskById(cur.id, task.id, {
          autoDispatch, trackHandoff: autoDispatch && !!task.after?.length,
        });
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

function runPreReviewChecks(cwd, envOverrides = {}) {
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
      execFile(cmd, args, { cwd, timeout: PROJECT_TEST_TIMEOUT_MS, maxBuffer: 512 * 1024, windowsHide: true, env: { ...process.env, ...envOverrides } }, (err, stdout, stderr) => {
        const combined = `${stdout || ''}\n${stderr || ''}`.trim();
        const output = err?.killed && err.signal ? `테스트 제한 시간(${PROJECT_TEST_TIMEOUT_MS / 1000}초)을 초과했습니다.\n${combined.slice(-2200)}`
          : combined || err?.message || '';
        resolve({
          ran: true,
          command: detected.label,
          ok: !err,
          exitCode: err ? (err.code ?? 1) : 0,
          output: output.slice(-2500),
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
  return terms.findLast((x) => (!liveOnly || x.exited === null) && x.meta?.projectTask?.projectId === projectId && x.meta?.projectTask?.taskId === taskId) || null;
}

function extractTaskSessionId(hub, project, task, t = findTaskTerminal(hub, project.id, task.id)) {
  const sid = t ? (hub.termSessionId?.(t) || t.meta?.sessionId || '') : '';
  return String(sid || task?.lastSessionId || '').trim();
}

function extractTaskOutput(hub, project, task, t = findTaskTerminal(hub, project.id, task.id), since = 0) {
  try {
    if (t) {
      const sid = hub.termSessionId?.(t) || t.meta?.sessionId;
      const doc = sid ? hub.index?.get?.(sid) : null;
      if (doc?.msgs?.length) {
        const lastAsst = doc.msgs.findLast((m) => isTaskReply(m, since));
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

function isTaskReply(m, since) {
  return m.role === 'assistant' && String(m.text || '').trim() && !String(m.text).startsWith('⚙')
    && !String(m.text).startsWith('❓') && (!since || Number(new Date(m.ts)) >= since);
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
    hub.projectRefs.saveFile(project.id, { name, text: content }, task.version);
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

async function prepareReview(hub, project, task, onPhase, taskOut, dir) {
  const harnessState = hub.projectHarness?.get ? hub.projectHarness.get() : null;
  const revCfg = resolveTaskConfig(project, { kind: 'review', role: 'review' }, harnessState, { preferProject: false });
  const agent = ['claude', 'codex', 'agy'].includes(revCfg.agent) ? revCfg.agent : 'claude';
  if (task.worktreePath && !fs.existsSync(task.worktreePath)) throw new Error('격리 작업 폴더를 찾을 수 없습니다.');
  const workspace = versionWorkspace(project, task.version);
  if (task.version && (!workspace || (workspace !== project.cwd && !fs.existsSync(workspace)))) throw new Error('버전 작업 폴더를 열어주세요.');
  const workCwd = reviewWorkspace(project, task);
  const [gitSummary, testCheck] = await Promise.all([readGitSummary(workCwd), runPreReviewChecks(workCwd)]);
  onPhase(`${agent} 교차 검토 중 (최대 ${REVIEW_TIMEOUT_MS / 1000}초)`);
  const harnessBlock = buildTaskHarnessPrompt(project, { ...task, kind: 'review', role: 'review' }, agent, harnessState);
  const refsBlock = hub.projectRefs?.promptBlock ? hub.projectRefs.promptBlock(project.id, task.version) : '';
  const testBlock = testCheck.ran
    ? (testCheck.ok
      ? `[Pre-Review Automated Test Gate (${testCheck.command}): PASSED (exit 0)]\n${testCheck.output}`
      : `[Pre-Review Automated Test Gate (${testCheck.command}): FAILED (exit ${testCheck.exitCode})]\n${testCheck.output}\nIMPORTANT: Tests failed. Reject unless the failure is demonstrably unrelated to this task.`)
    : '';
  const prompt = [
    'You are an independent automated reviewer for a multi-file software project.',
    'Inspect modified files directly in the workspace if the diff excerpt is incomplete, verify against the task completion criteria and test gate below, and return ONLY JSON matching the schema: {"verdict":"APPROVE"|"REJECT","reason":"concise explanation in Korean"}.',
    'Approve only if there are no blockers, test failures, or missing requirements. If rejected, state concrete fixes needed.',
    'Use the supplied automated test output before considering more commands. Do not repeat an already completed test suite. Limit inspection to evidence relevant to this task.',
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
  const prep = await hub.unifiedVault?.prepareLaunch(agent, { env, cwd: workCwd });
  Object.assign(env, prep?.env);
  hub.projects.recordVaultRun?.(project.id, [task.id], 'review', agent, prep?.vault);
  if (prep?.blocked) throw new Error(`필수 MCP 준비 실패 · ${requiredMcpMessage(prep.blocked)}`);
  const spec = {
    agent, account: revCfg.account,
    options: { cwd: workCwd, env, timeoutMs: REVIEW_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, stdinText: prompt },
  };

  if (agent === 'agy') {
    const log = path.join(dir, 'agy.log');
    const agyPrompt = prompt.length > 20_000 ? `${prompt.slice(0, 20_000)}\n...(truncated)` : prompt;
    return { ...spec, cmd: hub.agyExe(), files: [log], options: { ...spec.options, stdinText: null },
      args: ['--mode', 'plan', '--dangerously-skip-permissions', '--disable-slash-commands', ...extraME, '--print', agyPrompt, '--output-format', 'json', '--json-schema', REVIEW_SCHEMA, '--log-file', log] };
  }
  if (agent === 'codex') {
    const schemaFile = path.join(dir, 'schema.json');
    const outFile = path.join(dir, 'codex-output.json');
    fs.writeFileSync(schemaFile, REVIEW_SCHEMA);
    const codexArgs = ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--json', ...extraME, '--output-schema', schemaFile, '--output-last-message', outFile, '-'];
    const launch = hub.codexLaunch ? hub.codexLaunch(codexArgs) : { cmd: hub.codexExe ? hub.codexExe() : 'codex', args: codexArgs };
    return { ...spec, ...launch, files: [outFile, schemaFile] };
  }
  return { ...spec, cmd: 'claude.exe', args: ['--print', '--permission-mode', 'plan', ...extraME, '--output-format', 'json', '--json-schema', REVIEW_SCHEMA, ...(prep?.extraArgs || [])] };
}

function readReviewResult(spec, stdout) {
  const outputFile = spec.files?.[0];
  const review = spec.agent === 'codex' ? parseCodexJsonl(stdout)
    : spec.agent === 'agy' ? parseAgyJson(stdout, outputFile) : parseClaudeJson(stdout);
  const raw = spec.agent !== 'codex' ? stdout
    : fs.existsSync(outputFile) ? fs.readFileSync(outputFile, 'utf8') : review.reply;
  return { verdict: parseReviewVerdict(raw), sessionId: review.sessionId, tokens: review.tokens };
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
    const readScreen = () => {
      const screen = hub.readTerm?.(liveTerm, 40).join('\n') || '';
      return hub.stripAnsi?.(screen) || screen;
    };
    const screen = readScreen();
    const block = sessionStartupBlock(screen);
    const confirmation = terminalConfirmationMessage(block);
    if (confirmation) throw new Error(confirmation);
    if (block === 'term-dumb') throw new Error(DUMB_TERMINAL_MESSAGE);
    if (block === 'hooks-menu') {
      await dismissProjectHookMenu(hub, liveTerm, screen);
      if (!await hub.waitFor?.(() => liveTerm.exited === null && hub.inputReady?.(liveTerm), 5000, 300)) throw new Error(HOOK_MENU_MESSAGE);
    }
    const dispatchedAt = Date.now();
    liveTerm._projectDispatchPending = true;
    try {
      const prompt = prepareProjectPrompt(hub.baseDir, retryPrompt, liveTerm.meta?.cmd);
      liveTerm._projectBusySeen = await dispatchTerminalPrompt(hub, liveTerm, prompt);
      liveTerm._idleStreak = 0;
      liveTerm._projectDispatchedAt = dispatchedAt;
      return;
    } finally {
      liveTerm._projectDispatchPending = false;
    }
  }
  if (hub.startProjectTaskById) {
    const resume = priorSessionId || task.lastSessionId || '';
    const r = await hub.startProjectTaskById(projectId, task.id, { autoDispatch: true, resume, rawPrompt: retryPrompt });
    if (r && !r.error) return;
    if (r?.error) throw new Error(r.error);
  }
  throw new Error('수정 작업을 시작하지 못했습니다.');
}

async function completeAutopilotTask(hub, projectId, taskId, { maxRetries = MAX_AUTO_RETRIES, force = false, retryMerge = false, autoMerge = false, terminal, dispatchedAt, recoveredDelivery = false } = {}) {
  const key = `${projectId}:${taskId}`;
  if (reviewInFlight.has(key)) return { skipped: true, started: [] };
  if (force) {
    clearTimeout(pendingReReview.get(key));
    pendingReReview.delete(key);
  }
  const initialProject = hub.projects.list().find((x) => x.id === projectId);
  const initialTask = initialProject?.tasks?.find((x) => x.id === taskId);
  if (!initialProject || !initialTask) return { started: [] };
  if (terminal && initialTask.lastRun && terminal.id !== initialTask.lastRun.termId) return { skipped: true, started: [] };
  const fileRun = initialProject.fileRuns?.find((run) => run.id === initialTask.lastRun?.fileRunId);
  if (fileRun?.completingAt && !fileRun.finishedAt) {
    await finishFileRun(hub, initialProject, taskId);
    const { started } = await runProjectAutopilot(hub, projectId);
    return { approved: true, started };
  }
  if (initialTask.stage === 'done' && fileRun?.finishedAt) return { skipped: true, started: [] };
  if (initialTask.reviewPaused && !force && !recoveredDelivery) return { skipped: true, started: [] };

  const taskOut = extractTaskOutput(hub, initialProject, initialTask, terminal, dispatchedAt);
  const priorSessionId = extractTaskSessionId(hub, initialProject, initialTask, terminal);
  const interrupted = initialTask.stage === 'review' && initialTask.reviewStatus === 'reviewing';

  if (!interrupted && !approvedMerge(initialTask) && (!initialProject.autopilot || initialTask.kind === 'review') && !force && !initialTask.worktreePath) {
    if (initialTask.stage !== 'done') {
      const nextTasks = initialProject.tasks.map((t) => (t.id === initialTask.id
        ? { ...t, stage: 'done', reviewStatus: 'approved', ...(recoveredDelivery ? { reviewPaused: false, reviewNote: '' } : {}),
          ...(taskOut ? { lastOutput: taskOut } : {}), ...(priorSessionId ? { lastSessionId: priorSessionId } : {}) }
        : t));
      const saved = hub.projects.save({ ...initialProject, tasks: nextTasks });
      await finishFileRun(hub, saved, taskId);
      hub.overviewStale?.();
    }
    const autoRes = initialProject.autopilot ? await runProjectAutopilot(hub, projectId, { autoDispatch: true }) : { started: [] };
    return { approved: true, started: autoRes.started };
  }

  reviewInFlight.add(key);
  try {
    const getProject = () => hub.projects.list().find((x) => x.id === projectId);
    if (approvedMerge(initialTask) && (!force || retryMerge)) {
      return await withOperationLock(`merge:${folderKey(initialProject.cwd)}`, () => {
        const project = getProject();
        if (project?.cwd !== initialProject.cwd || !project?.tasks.some((task) => task.id === taskId && approvedMerge(task))) return { skipped: true, started: [] };
        return runProjectIntegration(hub, project, force && !autoMerge, maxRetries);
      });
    }
    if (retryMerge) return { skipped: true, started: [] };
    if (interrupted && !initialTask.reviewRun && !force && !hub.reviewTask) {
      const error = '이전 검토의 제출 기록이 없어 중복 검토를 방지하기 위해 중단했습니다.';
      const tasks = initialProject.tasks.map((t) => t.id !== taskId ? t
        : { ...t, stage: 'doing', reviewPaused: true, reviewStatus: 'error', reviewNote: error });
      hub.projects.save({ ...initialProject, tasks });
      hub.overviewStale?.();
      return { approved: false, error, started: [] };
    }
    const workspace = folderKey(reviewWorkspace(initialProject, initialTask));
    const run = initialTask.reviewRun || { id: randomUUID(), workspace, queuedAt: Date.now(), errors: 0, retryAt: 0 };
    if (!force && Date.now() < run.retryAt) return { skipped: true, started: [] };
    const dir = reviewDir(hub, run);
    const priorReview = !force && ['rejected', 'error'].includes(initialTask.reviewStatus) ? initialTask.reviewNote : '';
    const phaseNote = (phase) => priorReview ? `${phase} · 이전 반려: ${priorReview}` : phase;
    const runState = { taskId, run };
    if (!interrupted || force || !initialTask.reviewRun) {
      const tasks = initialProject.tasks.map((t) => t.id !== taskId ? t : {
        ...t, stage: 'review', reviewStatus: 'reviewing', reviewPaused: false, reviewRun: run,
        reviewNote: phaseNote('검토 대기 중…'), ...(force ? { retryCount: 0 } : {}),
        ...(taskOut ? { lastOutput: taskOut } : {}), ...(priorSessionId ? { lastSessionId: priorSessionId } : {}),
      });
      hub.projects.save({ ...initialProject, tasks }, { reviewRun: runState });
      hub.overviewStale?.();
    }
    return await withOperationLock(`review:${run.workspace}`, async () => {
      const isReviewing = (p) => p?.tasks.some((x) => x.id === taskId && x.stage === 'review'
        && x.reviewStatus === 'reviewing' && !x.reviewPaused && x.reviewRun?.id === run.id);
      const project = getProject();
      if (!isReviewing(project)) return { skipped: true, started: [] };
      const wsDir = reviewWorkspace(project, taskOut ? initialTask : (project.tasks.find((x) => x.id === taskId) || initialTask));
      const lint = lintEvidence(await readGitSummary(wsDir, 4000).catch(() => ''), taskOut || '');
      if (!lint.ok) {
        hub.projects.save({ ...project, tasks: project.tasks.map((t) => t.id === taskId
          ? { ...t, stage: 'doing', reviewPaused: true, reviewStatus: 'error', reviewNote: lint.reason } : t) });
        hub.overviewStale?.();
        return { approved: false, error: lint.reason, started: [] };
      }
      const task = project.tasks.find((x) => x.id === taskId);
      const assertReviewWorkspace = (p) => {
        if (folderKey(reviewWorkspace(p, p.tasks.find((item) => item.id === taskId))) !== run.workspace) {
          throw Object.assign(new Error('검토 중 작업 폴더가 변경됐습니다.'), { code: 'REVIEW_WORKSPACE_CHANGED' });
        }
      };

      let verdict;
      try {
        if (hub.reviewTask) verdict = await hub.reviewTask(project, task);
        else {
          const onPhase = (reviewNote, started = false) => {
            const latest = getProject();
            if (!isReviewing(latest)) return;
            if (started) run.started = true;
            hub.projects.save({ ...latest, tasks: latest.tasks.map((x) => x.id === taskId ? { ...x, reviewNote: phaseNote(reviewNote) } : x) }, { reviewRun: runState });
            hub.overviewStale?.();
          };
          const result = await runReview(dir, async () => {
            assertReviewWorkspace(project);
            onPhase('사전 테스트 및 변경 내역 확인 중…', true);
            const spec = await prepareReview(hub, project, task, onPhase, taskOut, dir);
            const latest = getProject();
            if (!isReviewing(latest)) throw new Error('검토 요청이 취소됐습니다.');
            assertReviewWorkspace(latest);
            return spec;
          });
          if (result.sessionId) {
            hub.projects.remember?.([{ projectId, taskId, agent: result.agent, accountId: result.account, sessionId: result.sessionId, tokens: result.tokens }]);
            hub.overviewStale?.();
          }
          verdict = result.verdict;
        }
        const latest = getProject();
        if (!isReviewing(latest)) return { skipped: true, started: [] };
        assertReviewWorkspace(latest);
      } catch (e) {
        const curP = hub.projects.list().find((x) => x.id === projectId);
        if (!isReviewing(curP)) return { skipped: true, started: [] };
        const errCount = (force ? 0 : run.errors) + 1;
        const errMsg = String(e?.message || e).slice(0, 400);
        if (curP.autopilot && !['CLI_TIMEOUT', 'REVIEW_UNCERTAIN', 'REVIEW_WORKSPACE_CHANGED'].includes(e?.code) && errCount <= MAX_REVIEW_ERROR_RETRIES) {
          const delayMs = hub.reviewRetryDelayMs ?? (DEFAULT_REVIEW_ERROR_BACKOFF_MS * errCount);
          const id = e.reviewCompleted || hub.reviewTask ? randomUUID() : run.id;
          const nextRun = { id, workspace, queuedAt: Date.now(), errors: errCount, retryAt: Date.now() + delayMs };
          const waitTasks = curP.tasks.map((t) => (t.id === task.id
            ? { ...t, reviewRun: nextRun, reviewNote: `검토 일시 오류 — 자동 재검토 대기 중 (${errCount}/${MAX_REVIEW_ERROR_RETRIES}): ${errMsg}` }
            : t));
          hub.projects.save({ ...curP, tasks: waitTasks }, { reviewRun: { taskId, run: nextRun } });
          hub.overviewStale?.();
          const timer = setTimeout(() => {
            pendingReReview.delete(key);
            const pending = hub.projects.list().find((x) => x.id === projectId);
            if (!pending?.autopilot || !pending.tasks.some((x) => x.id === taskId && x.reviewRun?.id === nextRun.id && x.stage === 'review' && x.reviewStatus === 'reviewing')) return;
            completeAutopilotTask(hub, projectId, taskId, { maxRetries }).catch((err2) => console.error('[autopilot-rereview]', projectId, taskId, err2?.message || err2));
          }, delayMs);
          pendingReReview.set(key, timer);
          timer.unref?.();
          return { approved: false, reReviewScheduled: true, reviewErrorCount: errCount, error: e?.message || String(e), started: [] };
        }
        const errTasks = curP.tasks.map((t) => (t.id === task.id
          ? { ...t, stage: 'doing', reviewPaused: true, reviewStatus: 'error', reviewNote: errMsg }
          : t));
        hub.projects.save({ ...curP, tasks: errTasks });
        hub.overviewStale?.();
        return { approved: false, reReviewScheduled: false, error: e?.message || String(e), started: [] };
      }

      let curP = hub.projects.list().find((x) => x.id === projectId);
      if (!isReviewing(curP)) return { skipped: true, started: [] };
      const curTask = curP.tasks.find((t) => t.id === task.id) || task;
      const reason = String(verdict?.reason || '').trim() || (verdict?.verdict === 'APPROVE' ? '검증 기준 통과' : '수정 필요');

      if (verdict?.verdict === 'APPROVE') {
        if (curTask.worktreePath) {
          const prepared = await prepareTaskMerge(curP.cwd, curTask.id, curTask.worktreePath);
          curP = hub.projects.list().find((x) => x.id === projectId);
          if (!isReviewing(curP)) return { skipped: true, started: [] };
          hub.projects.save({ ...curP, tasks: curP.tasks.map((item) => item.id === taskId ? {
            ...item, stage: 'merge', reviewStatus: prepared.ok ? 'merge-pending' : 'merge-blocked', reviewPaused: !prepared.ok,
            reviewNote: prepared.ok ? '' : prepared.error, mergeApprovalNote: reason, mergeCommit: prepared.commit || '',
          } : item) }, { mergeRun: { taskId, run: {
            queuedAt: Math.max(Date.now(), ...curP.tasks.map((item) => (item.mergeRun?.queuedAt || 0) + 1)),
          } } });
          hub.overviewStale?.();
          return { approved: false, mergePending: prepared.ok, reason: prepared.error, started: [] };
        }
        return finishApprovedTask(hub, curP, curTask, reason, taskOut, priorSessionId);
      }

      const retries = Number(curTask.retryCount || 0);
      if (curP.autopilot && retries < maxRetries) {
        const nextRetry = retries + 1;
        const retryTasks = curP.tasks.map((t) => (t.id === task.id
          ? { ...t, stage: 'doing', reviewStatus: 'rejected', reviewNote: reason, retryCount: nextRetry, ...(priorSessionId ? { lastSessionId: priorSessionId } : {}) }
          : t));
        hub.projects.save({ ...curP, tasks: retryTasks });
        hub.overviewStale?.();
        try {
          await dispatchRetryFeedback(hub, projectId, curTask, reason, nextRetry, priorSessionId);
        } catch (e) {
          const latest = hub.projects.list().find((x) => x.id === projectId);
          const error = `수정 지시 전달 실패: ${e.message || e}`;
          if (latest) hub.projects.save({ ...latest, tasks: latest.tasks.map((t) => t.id === taskId && (t.stage === 'doing' || t.reviewStatus === 'error')
            ? { ...t, stage: 'doing', reviewPaused: true, reviewStatus: 'error', reviewNote: `${error}\n\n${reason}`, retryCount: retries } : t) });
          hub.overviewStale?.();
          return { approved: false, retried: false, error, started: [] };
        }
        return { approved: false, retried: true, retryCount: nextRetry, reason, started: [] };
      }

      const pausedTasks = curP.tasks.map((t) => (t.id === task.id
          ? { ...t, stage: 'doing', reviewPaused: true, reviewStatus: 'rejected', reviewNote: curP.autopilot ? `[수정 재시도 ${maxRetries}회 사용]\n\n${reason}` : reason }
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
    const recovering = hub.projects.list().flatMap((project) => (project.tasks || [])
      .filter((task) => task.stage === 'review' && task.reviewStatus === 'reviewing' && !task.reviewPaused
        && (task.reviewRun?.retryAt || 0) <= now
        && !reviewInFlight.has(`${project.id}:${task.id}`) && !pendingReReview.has(`${project.id}:${task.id}`))
      .map((task) => ({ project, task, claimed: task.reviewRun && hasReviewClaim(reviewDir(hub, task.reviewRun)) })));
    // Reattach running reviews before queueing unsent work for the same folders.
    recovering.sort((a, b) => Number(!!b.claimed) - Number(!!a.claimed)
      || Number(!!b.task.reviewRun?.started) - Number(!!a.task.reviewRun?.started)
      || (a.task.reviewRun?.queuedAt || 0) - (b.task.reviewRun?.queuedAt || 0));
    for (const { project, task } of recovering) {
      const promise = completeAutopilotTask(hub, project.id, task.id)
        .catch((error) => console.error('[autopilot-orphan-review]', project.id, task.id, error));
      scheduled.push({ projectId: project.id, completedTaskId: task.id, recoveredReview: true, promise });
    }
    for (const project of hub.projects.list()) {
      for (const task of project.tasks) {
        const run = project.fileRuns?.find((item) => item.id === task.lastRun?.fileRunId);
        if (run?.completingAt && !run.finishedAt && !run.error) {
          await finishFileRun(hub, project, task.id).catch((error) => console.error('[project-file-run]', project.id, task.id, error.message));
        }
      }
    }
    for (const t of hub.terms.values()) {
      const ptm = t.meta?.projectMerge;
      if (ptm?.projectId && Array.isArray(ptm.taskIds) && !t._projectDispatchPending) {
        const cli = hub.agentOf?.(t);
        const screen = t.exited === null ? hub.readTerm?.(t, 40).join('\n') || '' : '';
        const startup = sessionStartupBlock(hub.stripAnsi?.(screen) || screen);
        if (!terminalConfirmationMessage(startup)) {
          const dispatchedAt = t._projectDispatchedAt || (t._projectDispatchedAt = Number(t.meta?.projectDelivery?.at || t.meta?.spawnedAt) || 0);
          const status = t.exited !== null ? 'exited'
            : cli === 'codex' ? hub.codexStatus?.(t)
              : cli === 'agy' ? hub.agyStatus?.(t)
                : hub.claudeStatus?.(t);
          if (status === 'busy' && !startup) {
            t._projectBusySeen = true;
            t._idleStreak = 0;
          } else {
            const recentOutput = !!(t.lastOutputAt && now - t.lastOutputAt < OUTPUT_QUIET_MS);
            if (status === 'idle' && recentOutput) {
              t._idleStreak = 0;
            } else {
              t._idleStreak = (t._idleStreak || 0) + 1;
              const stalled = dispatchedAt && (status === 'exited' || now - dispatchedAt >= DISPATCH_IDLE_LIMIT_MS);
              const settled = status === 'exited' || (status === 'idle' && t._idleStreak >= IDLE_STREAK_REQUIRED) || (startup && stalled);
              if (settled && (dispatchedAt || t._projectBusySeen)) {
                const project = hub.projects.list().find((x) => x.id === ptm.projectId);
                const targets = project?.tasks?.filter((x) => ptm.taskIds.includes(x.id) && x.stage === 'merge' && x.reviewStatus === 'merge-session') || [];
                if (targets.length) {
                  const sid = dispatchedAt && (hub.termSessionId?.(t) || t.meta?.sessionId);
                  const reply = sid && hub.index?.get?.(sid)?.msgs?.findLast((m) => isTaskReply(m, dispatchedAt));
                  const terminalResult = t._projectBusySeen && (!sid && t.lastOutputAt >= dispatchedAt && (status === 'idle' || t.exited === 0));
                  const doneNow = !startup && (reply || terminalResult || (t._projectBusySeen && status === 'exited' && t.exited === 0));
                  if (doneNow || stalled) {
                    t._projectBusySeen = false;
                    t._idleStreak = 0;
                    t._projectDispatchedAt = 0;
                    const targetSet = new Set(targets.map((x) => x.id));
                    if (doneNow) {
                      const tipShort = (ptm.tip || '').slice(0, 8);
                      const saved = hub.projects.save({
                        ...project,
                        tasks: project.tasks.map((task) => targetSet.has(task.id) ? {
                          ...task, stage: 'done', reviewStatus: 'approved', reviewPaused: false, retryCount: 0,
                          reviewNote: [task.mergeApprovalNote, tipShort ? `대상 브랜치 반영 완료 (${tipShort}) · 병합 세션 검증 완료` : '병합 세션 검증 완료'].filter(Boolean).join('\n'),
                          mergeApprovalNote: '', mergeCommit: '', mergeTip: '', mergeTermId: '', worktreePath: '',
                        } : task),
                      });
                      cleanupDoneTerminals(hub, saved, [...targetSet]);
                      hub.overviewStale?.();
                      for (const task of targets) saveTaskHandoffRef(hub, saved, task, { reason: task.mergeApprovalNote, taskOut: task.lastOutput });
                      if (saved.autopilot) {
                        const pAuto = runProjectAutopilot(hub, saved.id, { autoDispatch: true }).catch((e) => console.error('[autopilot-merge-done]', saved.id, e?.message || e));
                        scheduled.push({ projectId: saved.id, promise: pAuto });
                      }
                    } else {
                      hub.projects.save({
                        ...project,
                        tasks: project.tasks.map((task) => targetSet.has(task.id) ? {
                          ...task, reviewStatus: 'merge-blocked', reviewPaused: true,
                          reviewNote: '병합 세션이 완료 신호 없이 종료되었습니다. 터미널을 확인 후 통합 재시도하세요.',
                        } : task),
                      });
                      cleanupDoneTerminals(hub, saved, [...targetSet]);
                      hub.overviewStale?.();
                    }
                  }
                }
              }
            }
          }
        } else {
          t._idleStreak = 0;
        }
        continue;
      }
      const pt = t.meta?.projectTask;
      if (!pt?.projectId || !pt?.taskId || t._projectDispatchPending) continue;
      if (t.exited === null && t.pid) hub.fileRuns?.recoverStart(t);
      const cli = hub.agentOf?.(t);
      const screen = t.exited === null ? hub.readTerm?.(t, 40).join('\n') || '' : '';
      const startup = sessionStartupBlock(hub.stripAnsi?.(screen) || screen);
      if (terminalConfirmationMessage(startup)) { t._idleStreak = 0; continue; }
      const dispatchedAt = t._projectDispatchedAt || (t._projectDispatchedAt = Number(t.meta?.projectDelivery?.at || t.meta?.spawnedAt) || 0);
      if (startup === 'hooks-menu' && cli === 'codex' && dispatchedAt && !t._projectHookEscapeSent) {
        const project = hub.projects.list().find((p) => p.id === pt.projectId && p.autopilot);
        if (project?.tasks.some((task) => task.id === pt.taskId && task.stage === 'doing' && !task.autoExclude && !task.reviewPaused)) {
          if (await dismissProjectHookMenu(hub, t, screen).catch(() => false)) {
            t._idleStreak = 0;
            continue;
          }
        }
      }
      if (!startup) t._projectHookEscapeSent = false;
      const status = t.exited !== null
        ? 'exited'
        : cli === 'codex'
          ? hub.codexStatus?.(t)
          : cli === 'agy'
            ? hub.agyStatus?.(t)
            : hub.claudeStatus?.(t);
      if (status === 'busy' && !startup) {
        t._projectBusySeen = true;
        t._idleStreak = 0;
        continue;
      }
      const recentOutput = !!(t.lastOutputAt && now - t.lastOutputAt < OUTPUT_QUIET_MS);
      if (status === 'idle' && recentOutput) {
        t._idleStreak = 0;
        continue;
      }
      if (status === 'idle' || t.exited === 0) {
        const p = hub.projects.list().find(x => x.id === pt.projectId);
        const task = p?.tasks.find(x => x.id === pt.taskId);
        const evidence = task?.stage === 'doing' && task.lastRun?.termId === t.id && !task.autoExclude
          && task.reviewPaused && task.reviewStatus === 'error' && deliveryError(task.reviewNote) && projectDeliveryResult(hub, t);
        if (evidence) {
          const promise = completeAutopilotTask(hub, p.id, task.id, { terminal: t, dispatchedAt: evidence.at, recoveredDelivery: true })
            .catch(e => console.error('[autopilot-review]', p.id, task.id, e.message));
          scheduled.push({ projectId: p.id, completedTaskId: task.id, promise });
          continue;
        }
      }
      t._idleStreak = (t._idleStreak || 0) + 1;
      const stalled = dispatchedAt && (status === 'exited' || now - dispatchedAt >= DISPATCH_IDLE_LIMIT_MS);
      const settled = status === 'exited' || (status === 'idle' && t._idleStreak >= IDLE_STREAK_REQUIRED) || (startup && stalled);
      if (!settled || (!dispatchedAt && !t._projectBusySeen)) continue;
      const project = hub.projects.list().find((x) => x.id === pt.projectId);
      const task = project?.tasks?.find((x) => x.id === pt.taskId);
      if (!project || !project.autopilot || !task || task.stage !== 'doing' || task.autoExclude || task.reviewPaused) continue;
      if (reviewInFlight.has(`${pt.projectId}:${pt.taskId}`)) continue;
      if (task.lastRun && task.lastRun.termId !== t.id) continue;
      const handoff = task.handoff;
      const handoffReceived = handoff?.history?.at(-1)?.phase === 'received';
      const deliveredAt = handoff?.termId === t.id && !handoffReceived ? handoff.history[1].at : 0;
      const tracked = deliveredAt && deliveredAt === dispatchedAt;
      if (tracked && handoff.history.at(-1).phase !== 'confirmed') continue;
      if (deliveredAt && (!dispatchedAt || dispatchedAt < deliveredAt)) continue;
      const sid = dispatchedAt && (hub.termSessionId?.(t) || t.meta?.sessionId);
      const reply = sid && hub.index?.get?.(sid)?.msgs?.findLast((m) => isTaskReply(m, dispatchedAt));
      const terminalResult = t._projectBusySeen && (!tracked || (!sid && t.lastOutputAt >= dispatchedAt
        && (status === 'idle' || t.exited === 0)));
      const doneNow = !startup && (reply || terminalResult);
      if (!doneNow && !stalled) continue;
      if (!doneNow && tracked && now - Math.max(dispatchedAt, t.lastOutputAt || 0) < RESULT_INDEX_GRACE_MS) continue;

      if (doneNow && tracked) {
        if (!hub.projects.advanceHandoff(pt, t.id, dispatchedAt, 'received')) continue;
        hub.overviewStale?.();
      }
      t._projectBusySeen = false;
      t._idleStreak = 0;
      t._projectDispatchedAt = 0;
      if (!doneNow) {
        const problem = { 'hooks-menu': HOOK_MENU_MESSAGE, 'term-dumb': DUMB_TERMINAL_MESSAGE }[startup]
          || (tracked ? '후속 작업의 실행은 확인됐지만 결과를 받지 못했습니다.'
            : '작업 실행이 확인되지 않았습니다. 터미널의 시작 화면과 입력 상태를 확인하세요.');
        hub.projects.save({ ...project, tasks: project.tasks.map((x) => x.id === task.id
          ? { ...x, stage: 'doing', reviewPaused: true, reviewStatus: 'error', reviewNote: [problem, x.reviewNote].filter(Boolean).join('\n\n') } : x) });
        hub.overviewStale?.();
        continue;
      }
      const pRun = completeAutopilotTask(hub, project.id, task.id, { terminal: t, dispatchedAt }).catch((e) => console.error('[autopilot-review]', project.id, task.id, e?.message || e));
      scheduled.push({ projectId: project.id, completedTaskId: task.id, promise: pRun });
    }

    // Subtask rollup & orphan recovery (e.g. after server restart)
    const terms = [...hub.terms.values()];
    const activeTermTaskKeys = new Set(
      terms
        .filter((t) => t.meta?.projectTask?.projectId && t.meta?.projectTask?.taskId)
        .map((t) => `${t.meta.projectTask.projectId}:${t.meta.projectTask.taskId}`)
    );
    const activeMergeKeys = new Set(
      terms
        .filter((t) => t.meta?.projectMerge?.projectId)
        .map((t) => `${t.meta.projectMerge.projectId}:${t.id}`)
    );
    for (const project of hub.projects.list()) {
      if (!Array.isArray(project.tasks)) continue;
      let recoveredMergeSession = false;
      const checkedMergeTasks = project.tasks.map((tk) => {
        if (tk.stage === 'merge' && tk.reviewStatus === 'merge-session' && !tk.reviewPaused) {
          const mKey = `${project.id}:${tk.mergeTermId || ''}`;
          if (tk.mergeTermId && activeMergeKeys.has(mKey)) {
            orphanDoingTicks.delete(`merge:${project.id}:${tk.id}`);
          } else {
            const oKey = `merge:${project.id}:${tk.id}`;
            const ticks = (orphanDoingTicks.get(oKey) || 0) + 1;
            orphanDoingTicks.set(oKey, ticks);
            if (ticks >= 4) {
              orphanDoingTicks.delete(oKey);
              recoveredMergeSession = true;
              return { ...tk, reviewStatus: 'merge-blocked', reviewPaused: true, reviewNote: '병합 세션 터미널이 종료되어 일시 정지되었습니다.' };
            }
          }
        }
        return tk;
      });
      if (recoveredMergeSession) {
        hub.projects.save({ ...project, tasks: checkedMergeTasks });
        hub.overviewStale?.();
      }
      const merge = mergeQueue(project)[0];
      if (merge && merge.reviewStatus !== 'merge-blocked' && !project.tasks.some((task) => reviewInFlight.has(`${project.id}:${task.id}`))
        && now >= (merge.mergeRun?.retryAt || 0)) {
        const promise = completeAutopilotTask(hub, project.id, merge.id, { retryMerge: true, autoMerge: true })
          .catch((e) => console.error('[autopilot-merge]', project.id, e?.message || e));
        scheduled.push({ projectId: project.id, completedTaskId: merge.id, promise });
      }
      if (!project.autopilot) continue;
      const byParent = new Map();
      let recoveredDoing = false;
      const recoveredTasks = project.tasks.map((tk) => {
        if (tk.parentId) (byParent.get(tk.parentId) || byParent.set(tk.parentId, []).get(tk.parentId)).push(tk);
        const tkKey = `${project.id}:${tk.id}`;
        if (tk.stage === 'doing' && !tk.autoExclude && !tk.reviewPaused && !inFlight.has(project.id) && !reviewInFlight.has(tkKey)) {
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
      if (recoveredDoing) hub.projects.save({ ...project, tasks: recoveredTasks });
      if (recoveredDoing || (!inFlight.has(project.id) && findReadyTasks(project, terms).some((task) => task.after?.length))) {
        const pAuto = runProjectAutopilot(hub, project.id, { autoDispatch: true }).catch((e) => console.error('[autopilot-dispatch]', project.id, e?.message || e));
        scheduled.push({ projectId: project.id, recoveredDoing, promise: pAuto });
      }
      for (const [parentId, subs] of byParent) {
        const parent = project.tasks.find((x) => x.id === parentId);
        if (!parent || parent.stage === 'done' || parent.stage === 'review' || parent.stage === 'merge' || parent.autoExclude || parent.reviewPaused) continue;
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
  readReviewResult,
  runPreReviewChecks,
  readGitSummary,
  detectTestCommand,
  ensureTaskWorktree,
};
