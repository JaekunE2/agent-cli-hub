'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const git = require('node:util').promisify(require('node:child_process').execFile);
const { copyVersion, versionWorkspace } = require('./version-files');

function fileRunPath(root, projectId, runId, phase) {
  if (!/^[\w-]{1,80}$/.test(projectId) || !/^[a-f0-9-]{36}$/.test(runId) || !['start', 'finish'].includes(phase)) {
    throw new Error('작업 스냅샷 식별자가 올바르지 않습니다.');
  }
  return path.join(root, 'snapshots', projectId, runId, phase);
}

async function isGit(cwd) {
  const options = { cwd, windowsHide: true, timeout: 5000, env: { ...process.env, LC_ALL: 'C' } };
  let top;
  try {
    top = (await git('git', ['rev-parse', '--show-toplevel'], options)).stdout.trim();
  } catch (error) {
    if (/^fatal: not a git repository/i.test(error.stderr || '')) return false;
    if (error.code !== 'ENOENT') throw error;
    for (let dir = cwd; ; dir = path.dirname(dir)) {
      if (await fs.lstat(path.join(dir, '.git')).then(() => true, missing)) return true;
      if (dir === path.dirname(dir)) return false;
    }
  }
  const relative = path.relative(top, await fs.realpath(cwd));
  if (!relative) return true;
  // A Hub-managed project can live in the Hub repository's ignored projects directory.
  return git('git', ['check-ignore', '--', relative], { ...options, cwd: top }).then(() => false, (error) => {
    if (error.code === 1) return true;
    throw error;
  });
}

function missing(error) {
  if (error.code !== 'ENOENT') throw error;
  return false;
}

async function capture(source, destination) {
  if (!(await fs.lstat(destination).then((stat) => stat.isDirectory(), missing))) {
    await copyVersion(source, destination);
  }
}

function createFileRuns(hub, root) {
  const { projects } = hub;
  const pending = new Map();
  const read = (id) => projects.list().find((p) => p.id === id);
  const save = (project, fileRun, tasks = project.tasks) => {
    const saved = projects.save({ ...project, tasks }, { fileRun });
    hub.overviewStale?.();
    return saved;
  };
  return {
    recoverStart(term) {
      const { projectId, taskId, fileRunId, agentSource, trackHandoff } = term.meta?.projectTask || {};
      if (!fileRunId) return;
      const project = read(projectId);
      const task = project?.tasks.find((item) => item.id === taskId);
      const fileRun = project?.fileRuns?.find((run) => run.id === fileRunId && !run.startedAt);
      if (!fileRun || !task || !['planned', 'doing'].includes(task.stage)) return;
      const active = project.fileRuns.find((run) => run.id === task.lastRun?.fileRunId);
      if (active?.preparedAt > fileRun.preparedAt) return;
      const run = { agent: hub.agentOf(term), source: agentSource, termId: term.id, fileRunId };
      const tasks = project.tasks.map((item) => item === task ? { ...item, stage: 'doing' } : item);
      projects.save({ ...project, tasks }, { fileRun: { ...fileRun, startedAt: Date.now() }, taskRun: { taskId, run, trackHandoff } });
      hub.overviewStale?.();
    },
    async prepare(projectId, taskId, cwd, continuing) {
      if (await isGit(cwd)) return;
      const project = read(projectId);
      const task = project?.tasks.find((item) => item.id === taskId);
      if (!task || task.stage === 'done') throw new Error('스냅샷을 준비할 작업을 찾을 수 없습니다.');
      const active = project.fileRuns?.find((run) => run.id === task.lastRun?.fileRunId);
      if (active?.completingAt && !active.finishedAt) throw new Error('완료 스냅샷을 먼저 저장하세요.');
      if (continuing && active && !active.finishedAt && active.cwd === cwd) return active;
      let run = project.fileRuns?.findLast((item) => item.taskId === taskId && !item.startedAt && item.cwd === cwd);
      if (!run) {
        run = { id: randomUUID(), taskId, title: task.title, cwd, preparedAt: Date.now() };
        save(project, run);
      }
      await capture(cwd, fileRunPath(root, projectId, run.id, 'start'));
      const current = read(projectId);
      const latest = current?.tasks.find((item) => item.id === taskId);
      const workspace = latest && versionWorkspace(current, latest.version);
      const folder = workspace === current?.cwd && latest?.worktreePath || workspace;
      if (!folder || path.relative(folder, cwd) || latest.stage !== task.stage || latest.version !== task.version
        || latest.lastRun?.termId !== task.lastRun?.termId || hub.deletingProjects?.has(projectId)) {
        throw new Error('스냅샷을 저장하는 동안 작업 상태가 변경되었습니다.');
      }
      return run;
    },
    finish(projectId, runId) {
      if (pending.has(runId)) return pending.get(runId);
      const operation = (async () => {
        const run = read(projectId)?.fileRuns?.find((item) => item.id === runId);
        if (!run?.completingAt || run.finishedAt) return;
        let error;
        try { await capture(run.cwd, fileRunPath(root, projectId, run.id, 'finish')); }
        catch (cause) { error = `완료 스냅샷 저장 실패: ${cause.message}`; }
        const project = read(projectId);
        const task = project?.tasks.find((item) => item.id === run.taskId && item.lastRun?.fileRunId === run.id);
        if (!project || !task) return;
        save(project, { ...run, error, ...(error ? {} : { finishedAt: Date.now() }) },
          project.tasks.map((item) => item === task ? { ...item, stage: error ? 'review' : 'done' } : item));
        if (error) throw new Error(error);
      })().finally(() => pending.delete(runId));
      pending.set(runId, operation);
      return operation;
    },
  };
}

module.exports = { createFileRuns, fileRunPath, isGit };
