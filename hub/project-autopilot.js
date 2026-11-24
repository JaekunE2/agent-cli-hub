'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { spawnCli, cliModelEffortArgs } = require('./project-plan');
const { parseAgyJson, parseClaudeJson, parseCodexJsonl } = require('./task-subchat');
const { resolveTaskConfig, buildTaskHarnessPrompt } = require('./project-harness');
const { versionWorkspace } = require('./version-files');
const { sessionStartupBlock, dismissProjectHookMenu, dispatchTerminalPrompt, terminalConfirmationMessage, HOOK_MENU_MESSAGE, DUMB_TERMINAL_MESSAGE } = require('./term-manager');

const MAX_AUTO_RETRIES = 2;
const MAX_REVIEW_ERROR_RETRIES = 2;
const DEFAULT_REVIEW_ERROR_BACKOFF_MS = 15_000;
const DEFAULT_MAX_CONCURRENT = 2;
const IDLE_STREAK_REQUIRED = 2;
const OUTPUT_QUIET_MS = 4500;
const RESULT_INDEX_GRACE_MS = 15_000;
const DISPATCH_IDLE_LIMIT_MS = 90_000;
const REVIEW_TIMEOUT_MS = 180_000;

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
    if (!t || t.stage !== 'planned' || t.autoExclude) return false;
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
const reviewErrorCounts = new Map();
const orphanDoingTicks = new Map();
const projectLocks = new Map();
const mergeRetryAt = new Map();
let watcherBusy = false;

function withProjectLock(lockKey, fn) {
  const prev = projectLocks.get(lockKey) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  const cleanup = next.finally(() => {
    if (projectLocks.get(lockKey) === cleanup) projectLocks.delete(lockKey);
  });
  projectLocks.set(lockKey, cleanup);
  return cleanup;
}

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

async function mergeAndCleanupWorktree(projectCwd, taskId, worktreePath, { keepWorktree = false, commitChanges = true } = {}) {
  if (!projectCwd || !worktreePath || !fs.existsSync(worktreePath)) return { ok: false, error: '격리 작업 폴더를 찾을 수 없습니다.' };
  const id8 = String(taskId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 8) || 'task';
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
  const inProgress = await execGit(projectCwd, ['rev-parse', '--verify', 'MERGE_HEAD']);
  if (inProgress.ok) return { ok: false, pending: true, error: '프로젝트 폴더에 진행 중인 Git 병합이 있습니다.' };
  const branchRef = `refs/heads/${branch}`;
  const integrated = await execGit(projectCwd, ['merge-base', '--is-ancestor', branchRef, 'HEAD']);
  const merged = integrated.ok ? integrated : await execGit(projectCwd, ['merge', '--no-ff', branchRef, '-m', `hub: merge task ${id8}`], 15_000);
  if (!merged.ok) {
    const conflicts = await execGit(projectCwd, ['diff', '--name-only', '--diff-filter=U']);
    const mergeHead = await execGit(projectCwd, ['rev-parse', '--verify', 'MERGE_HEAD']);
    if (mergeHead.ok) {
      const abort = await execGit(projectCwd, ['merge', '--abort'], 5000);
      if (!abort.ok) return { ok: false, error: '프로젝트 폴더에 진행 중인 Git 병합이 있습니다.' };
    }
    const files = conflicts.stdout.trim().split(/\r?\n/).filter(Boolean);
    const details = `${merged.stderr}\n${merged.stdout}`.split(/\r?\n/).filter((line) => !/^warning:/i.test(line)).join('\n').trim();
    const pending = !files.length && /would be overwritten by merge|index\.lock|index contains uncommitted changes/i.test(details);
    const pendingFiles = pending ? details.split(/\r?\n/).filter((line) => /^\t/.test(line)).map((line) => line.trim()) : [];
    const message = pendingFiles.length
      ? ['병합 대상과 겹치는 로컬 변경이 있습니다.', ...pendingFiles.map((file) => `- ${file}`)].join('\n')
      : details || 'Git merge failed';
    return { ok: false, pending, error: files.length ? files.map((file) => `- ${file}`).join('\n') : message.slice(0, 1800) };
  }
  if (!keepWorktree) {
    const removed = await execGit(projectCwd, ['worktree', 'remove', worktreePath], 10_000);
    if (removed.ok) await execGit(projectCwd, ['branch', '-d', branch], 5000);
  }
  return { ok: true };
}

function approvedMerge(task) {
  return task.stage === 'review' && ['merge-pending', 'merge-blocked'].includes(task.reviewStatus);
}

async function finishApprovedTask(hub, project, task, reason, taskOut, sessionId, commitChanges = false) {
  const { id: projectId } = project;
  const { id: taskId } = task;
  const key = `${projectId}:${taskId}`;
  if (task.worktreePath) {
    const keepWorktree = [...(hub.terms?.values() || [])].some((term) => term.exited === null
      && term.meta?.projectTask?.projectId === projectId && term.meta.projectTask.taskId === taskId);
    const result = await mergeAndCleanupWorktree(project.cwd, taskId, task.worktreePath, { keepWorktree, commitChanges });
    const latest = hub.projects.list().find((p) => p.id === projectId);
    const current = latest?.tasks.find((item) => item.id === taskId);
    if (!current || !approvedMerge(current) || current.worktreePath !== task.worktreePath) return { skipped: true, started: [] };
    project = latest;
    if (!result.ok) {
      const reviewStatus = result.pending ? 'merge-pending' : 'merge-blocked';
      if (result.pending) mergeRetryAt.set(key, Date.now() + 30_000);
      else mergeRetryAt.delete(key);
      if (current.reviewStatus !== reviewStatus || current.reviewNote !== result.error) {
        hub.projects.save({ ...project, tasks: project.tasks.map((item) => item.id === taskId
          ? { ...item, reviewStatus, reviewPaused: !result.pending, reviewNote: result.error } : item) });
        hub.overviewStale?.();
      }
      return { approved: false, mergePending: !!result.pending, mergeConflict: !result.pending, reason: result.error, started: [] };
    }
  }
  mergeRetryAt.delete(key);
  const tasks = project.tasks.map((item) => item.id === taskId
    ? { ...item, stage: 'done', reviewStatus: 'approved', reviewPaused: false, reviewNote: reason, mergeApprovalNote: '', retryCount: 0, worktreePath: '',
      ...(taskOut ? { lastOutput: taskOut } : {}), ...(sessionId ? { lastSessionId: sessionId } : {}) } : item);
  hub.projects.save({ ...project, tasks });
  hub.overviewStale?.();
  if (hub.projectRefs?.saveFile) {
    const gitSummary = await readGitSummary(versionWorkspace(project, task.version), 3500).catch(() => '');
    saveTaskHandoffRef(hub, project, task, { reason, taskOut, gitSummary });
  }
  const autoRes = await runProjectAutopilot(hub, projectId, { autoDispatch: true });
  return { approved: true, reason, started: autoRes.started };
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

    const ready = findReadyTasks(cur, [...hub.terms.values()]);
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
    const projectGit = regular.length && cur.cwd && await execGit(cur.cwd, ['rev-parse', '--verify', 'HEAD']);
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
    const nextTasks = cur.tasks.map((t) => (readyIds.has(t.id)
      ? { ...t, stage: 'doing', ...(worktreeByTask.has(t.id) ? { worktreePath: worktreeByTask.get(t.id) } : {}) }
      : t));
    hub.projects.save({ ...cur, tasks: nextTasks });

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

async function defaultReviewTask(hub, project, task, onPhase, taskOut) {
  const harnessState = hub.projectHarness?.get ? hub.projectHarness.get() : null;
  const revCfg = resolveTaskConfig(project, { kind: 'review', role: 'review' }, harnessState, { preferProject: false });
  const agent = ['claude', 'codex', 'agy'].includes(revCfg.agent) ? revCfg.agent : 'claude';
  if (task.worktreePath && !fs.existsSync(task.worktreePath)) throw new Error('격리 작업 폴더를 찾을 수 없습니다.');
  const workspace = versionWorkspace(project, task.version);
  if (task.version && (!workspace || (workspace !== project.cwd && !fs.existsSync(workspace)))) throw new Error('버전 작업 폴더를 열어주세요.');
  const taskCwd = (workspace === project.cwd && task.worktreePath) || workspace;
  const workCwd = (taskCwd && fs.existsSync(taskCwd)) ? taskCwd : process.cwd();
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
  const prep = hub.unifiedVault?.prepareLaunch(agent, { env });
  Object.assign(env, prep?.env);
  hub.projects.recordVaultRun?.(project.id, [task.id], 'review', agent, prep?.vault);
  const rememberReview = ({ sessionId, tokens }) => {
    if (!sessionId) return;
    hub.projects.remember?.([{ projectId: project.id, taskId: task.id, agent, accountId: revCfg.account, sessionId, tokens }]);
    hub.overviewStale?.();
  };

  if (agent === 'agy') {
    const log = path.join(workCwd, `.agy-review-${Date.now()}.log`);
    try {
      const agyPrompt = prompt.length > 20_000 ? `${prompt.slice(0, 20_000)}\n...(truncated)` : prompt;
      const { stdout } = await spawnCli(hub.agyExe(), ['--mode', 'plan', '--dangerously-skip-permissions', '--disable-slash-commands', ...extraME, '--print', agyPrompt, '--output-format', 'json', '--json-schema', REVIEW_SCHEMA, '--log-file', log], { cwd: workCwd, env, timeoutMs: REVIEW_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 });
      rememberReview(parseAgyJson(stdout, log));
      return parseReviewVerdict(stdout);
    } finally { fs.rmSync(log, { force: true }); }
  }
  if (agent === 'codex') {
    const schemaFile = path.join(workCwd, `.codex-rev-schema-${Date.now()}.json`);
    const outFile = path.join(workCwd, `.codex-rev-out-${Date.now()}.json`);
    try {
      fs.writeFileSync(schemaFile, REVIEW_SCHEMA);
      const codexArgs = ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--json', ...extraME, '--output-schema', schemaFile, '--output-last-message', outFile, '-'];
      const { cmd, args } = hub.codexLaunch ? hub.codexLaunch(codexArgs) : { cmd: hub.codexExe ? hub.codexExe() : 'codex', args: codexArgs };
      const { stdout } = await spawnCli(cmd, args, { cwd: workCwd, env, timeoutMs: REVIEW_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, stdinText: prompt });
      const review = parseCodexJsonl(stdout);
      rememberReview(review);
      return parseReviewVerdict(fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : review.reply);
    } finally {
      fs.rmSync(schemaFile, { force: true });
      fs.rmSync(outFile, { force: true });
    }
  }
  const { stdout } = await spawnCli('claude.exe', ['--print', '--permission-mode', 'plan', ...extraME, '--output-format', 'json', '--json-schema', REVIEW_SCHEMA, ...(prep?.extraArgs || [])], { cwd: workCwd, env, timeoutMs: REVIEW_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, stdinText: prompt });
  rememberReview(parseClaudeJson(stdout));
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
      liveTerm._projectBusySeen = await dispatchTerminalPrompt(hub, liveTerm, retryPrompt);
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

async function completeAutopilotTask(hub, projectId, taskId, { maxRetries = MAX_AUTO_RETRIES, force = false, retryMerge = false, terminal, dispatchedAt } = {}) {
  const key = `${projectId}:${taskId}`;
  if (reviewInFlight.has(key)) return { skipped: true, started: [] };
  if (force) {
    clearTimeout(pendingReReview.get(key));
    pendingReReview.delete(key);
    reviewErrorCounts.delete(key);
  }
  const initialProject = hub.projects.list().find((x) => x.id === projectId);
  const initialTask = initialProject?.tasks?.find((x) => x.id === taskId);
  if (!initialProject || !initialTask) return { started: [] };
  if (initialTask.reviewPaused && !force) return { skipped: true, started: [] };

  const taskOut = extractTaskOutput(hub, initialProject, initialTask, terminal, dispatchedAt);
  const priorSessionId = extractTaskSessionId(hub, initialProject, initialTask, terminal);

  if (!approvedMerge(initialTask) && (!initialProject.autopilot || initialTask.kind === 'review') && !force && !initialTask.worktreePath) {
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
      if (approvedMerge(task) && (!force || retryMerge)) {
        return finishApprovedTask(hub, project, task, task.mergeApprovalNote || '검증 기준 통과', task.lastOutput, task.lastSessionId);
      }
      if (retryMerge) return { skipped: true, started: [] };
      if (task.reviewPaused && !force) return { skipped: true, started: [] };
      if (task.stage !== initialTask.stage || task.reviewPaused !== initialTask.reviewPaused) return { skipped: true, started: [] };
      const isReviewing = (p) => p?.tasks.some((x) => x.id === taskId && x.stage === 'review' && x.reviewStatus === 'reviewing');
      const priorReview = ['rejected', 'error'].includes(task.reviewStatus) ? task.reviewNote : '';
      const phaseNote = (phase) => priorReview ? `${phase} · 이전 반려: ${priorReview}` : phase;
      const reviewingTasks = project.tasks.map((t) => (t.id === task.id
        ? { ...t, stage: 'review', reviewStatus: 'reviewing', reviewPaused: false, reviewNote: phaseNote('사전 테스트 및 변경 내역 확인 중…'), ...(force ? { retryCount: 0 } : {}), ...(taskOut ? { lastOutput: taskOut } : {}), ...(priorSessionId ? { lastSessionId: priorSessionId } : {}) }
        : t));
      hub.projects.save({ ...project, tasks: reviewingTasks });
      hub.overviewStale?.();

      let verdict;
      try {
        const reviewer = hub.reviewTask || ((p, t) => defaultReviewTask(hub, p, t, (reviewNote) => {
          const latest = hub.projects.list().find((x) => x.id === projectId);
          if (!isReviewing(latest)) return;
          hub.projects.save({ ...latest, tasks: latest.tasks.map((x) => x.id === taskId ? { ...x, reviewNote: phaseNote(reviewNote) } : x) });
          hub.overviewStale?.();
        }, taskOut));
        verdict = await reviewer(project, task);
      } catch (e) {
        const curP = hub.projects.list().find((x) => x.id === projectId);
        if (!isReviewing(curP)) return { skipped: true, started: [] };
        const errCount = (reviewErrorCounts.get(key) || 0) + 1;
        const errMsg = String(e?.message || e).slice(0, 400);
        if (curP.autopilot && errCount <= MAX_REVIEW_ERROR_RETRIES) {
          reviewErrorCounts.set(key, errCount);
          const delayMs = hub.reviewRetryDelayMs ?? (DEFAULT_REVIEW_ERROR_BACKOFF_MS * errCount);
          const waitTasks = curP.tasks.map((t) => (t.id === task.id
            ? { ...t, stage: 'review', reviewStatus: 'reviewing', reviewNote: `검토 일시 오류 — 자동 재검토 대기 중 (${errCount}/${MAX_REVIEW_ERROR_RETRIES}): ${errMsg}` }
            : t));
          hub.projects.save({ ...curP, tasks: waitTasks });
          hub.overviewStale?.();
          const timer = setTimeout(() => {
            pendingReReview.delete(key);
            const pending = hub.projects.list().find((x) => x.id === projectId);
            if (!pending?.autopilot || !pending.tasks.some((x) => x.id === taskId && x.stage === 'review' && x.reviewStatus === 'reviewing')) {
              reviewErrorCounts.delete(key);
              return;
            }
            completeAutopilotTask(hub, projectId, taskId, { maxRetries }).catch((err2) => console.error('[autopilot-rereview]', projectId, taskId, err2?.message || err2));
          }, delayMs);
          pendingReReview.set(key, timer);
          timer.unref?.();
          return { approved: false, reReviewScheduled: true, reviewErrorCount: errCount, error: e?.message || String(e), started: [] };
        }
        reviewErrorCounts.delete(key);
        const errTasks = curP.tasks.map((t) => (t.id === task.id
          ? { ...t, stage: 'doing', reviewPaused: true, reviewStatus: 'error', reviewNote: errMsg }
          : t));
        hub.projects.save({ ...curP, tasks: errTasks });
        hub.overviewStale?.();
        return { approved: false, reReviewScheduled: false, error: e?.message || String(e), started: [] };
      }

      reviewErrorCounts.delete(key);
      let curP = hub.projects.list().find((x) => x.id === projectId);
      if (!isReviewing(curP)) return { skipped: true, started: [] };
      const curTask = curP.tasks.find((t) => t.id === task.id) || task;
      const reason = String(verdict?.reason || '').trim() || (verdict?.verdict === 'APPROVE' ? '검증 기준 통과' : '수정 필요');

      if (verdict?.verdict === 'APPROVE') {
        if (curTask.worktreePath) {
          curP = hub.projects.save({ ...curP, tasks: curP.tasks.map((item) => item.id === taskId
            ? { ...item, reviewStatus: 'merge-pending', reviewNote: '', mergeApprovalNote: reason } : item) });
          hub.overviewStale?.();
        }
        return finishApprovedTask(hub, curP, curTask, reason, taskOut, priorSessionId, true);
      }

      const retries = Number(curTask.retryCount || 0);
      if (curP.autopilot && retries < maxRetries) {
        const nextRetry = retries + 1;
        const retryTasks = curP.tasks.map((t) => (t.id === task.id
          ? { ...t, stage: 'doing', reviewStatus: 'rejected', reviewNote: reason, ...(priorSessionId ? { lastSessionId: priorSessionId } : {}) }
          : t));
        hub.projects.save({ ...curP, tasks: retryTasks });
        hub.overviewStale?.();
        try {
          await dispatchRetryFeedback(hub, projectId, curTask, reason, nextRetry, priorSessionId);
        } catch (e) {
          const latest = hub.projects.list().find((x) => x.id === projectId);
          const error = `수정 지시 전달 실패: ${e.message || e}`;
          if (latest) hub.projects.save({ ...latest, tasks: latest.tasks.map((t) => t.id === taskId && (t.stage === 'doing' || t.reviewStatus === 'error')
            ? { ...t, stage: 'doing', reviewPaused: true, reviewStatus: 'error', reviewNote: `${error}\n\n${reason}` } : t) });
          hub.overviewStale?.();
          return { approved: false, retried: false, error, started: [] };
        }
        const latest = hub.projects.list().find((x) => x.id === projectId);
        if (latest) hub.projects.save({ ...latest, tasks: latest.tasks.map((t) => t.id === taskId && t.stage === 'doing'
          ? { ...t, retryCount: nextRetry } : t) });
        hub.overviewStale?.();
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
    for (const t of hub.terms.values()) {
      const pt = t.meta?.projectTask;
      if (!pt?.projectId || !pt?.taskId || t._projectDispatchPending) continue;
      const cli = hub.agentOf?.(t);
      const screen = t.exited === null ? hub.readTerm?.(t, 40).join('\n') || '' : '';
      const startup = sessionStartupBlock(hub.stripAnsi?.(screen) || screen);
      if (terminalConfirmationMessage(startup)) { t._idleStreak = 0; continue; }
      const dispatchedAt = t._projectDispatchedAt;
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
      t._idleStreak = (t._idleStreak || 0) + 1;
      const stalled = dispatchedAt && (status === 'exited' || now - dispatchedAt >= DISPATCH_IDLE_LIMIT_MS);
      const settled = status === 'exited' || (status === 'idle' && t._idleStreak >= IDLE_STREAK_REQUIRED) || (startup && stalled);
      if (!settled || (!dispatchedAt && !t._projectBusySeen)) continue;
      const project = hub.projects.list().find((x) => x.id === pt.projectId);
      const task = project?.tasks?.find((x) => x.id === pt.taskId);
      if (!project || !project.autopilot || !task || task.stage !== 'doing' || task.autoExclude || task.reviewPaused) continue;
      if (task.lastRun && task.lastRun.termId !== t.id) continue;
      const handoff = task.handoff;
      const deliveredAt = handoff?.termId === t.id ? handoff.history[1].at : 0;
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
    for (const project of hub.projects.list()) {
      if (!project.autopilot || !Array.isArray(project.tasks)) continue;
      const byParent = new Map();
      let recoveredDoing = false;
      const recoveredTasks = project.tasks.map((tk) => {
        if (tk.parentId) (byParent.get(tk.parentId) || byParent.set(tk.parentId, []).get(tk.parentId)).push(tk);
        const tkKey = `${project.id}:${tk.id}`;
        const legacyWait = tk.reviewStatus === 'merge-blocked' && /^warning:.*LF will be replaced by CRLF/m.test(tk.reviewNote || '');
        if (approvedMerge(tk) && (tk.reviewStatus === 'merge-pending' || legacyWait) &&
            !reviewInFlight.has(tkKey) && now >= (mergeRetryAt.get(tkKey) || 0)) {
          const promise = completeAutopilotTask(hub, project.id, tk.id, { force: true, retryMerge: true })
            .catch((e) => console.error('[autopilot-merge]', project.id, tk.id, e?.message || e));
          scheduled.push({ projectId: project.id, completedTaskId: tk.id, promise });
        }
        if (tk.stage === 'review' && tk.reviewStatus === 'reviewing' && !reviewInFlight.has(tkKey) && !pendingReReview.has(tkKey)) {
          const pRun = completeAutopilotTask(hub, project.id, tk.id).catch((e) => console.error('[autopilot-orphan-review]', project.id, tk.id, e?.message || e));
          scheduled.push({ projectId: project.id, completedTaskId: tk.id, recoveredReview: true, promise: pRun });
        }
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
        if (!parent || parent.stage === 'done' || parent.stage === 'review' || parent.autoExclude || parent.reviewPaused) continue;
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
