'use strict';

const { findReadyTasks: _unused } = {};

/**
 * Return planned tasks whose prerequisites (`after`) are all `done` and have no live terminal running.
 * Top-level tasks are evaluated directly; subtasks also require their parent not to be `done`.
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
    if (!t || t.stage !== 'planned') return false;
    if (runningTaskIds.has(t.id)) return false;
    if (t.parentId) {
      const parent = byId.get(t.parentId);
      if (parent && parent.stage === 'done') return false;
    }
    const deps = Array.isArray(t.after) ? t.after : [];
    return deps.every((depId) => byId.get(depId)?.stage === 'done');
  });
}

const inFlight = new Set();

async function runProjectAutopilot(hub, projectId, { autoDispatch = true } = {}) {
  if (!projectId || inFlight.has(projectId)) return { started: [] };
  inFlight.add(projectId);
  const started = [];
  try {
    const cur = hub.projects.list().find((x) => x.id === projectId);
    if (!cur || !cur.autopilot) return { started };
    const ready = findReadyTasks(cur, [...hub.terms.values()]);
    if (!ready.length) return { started };

    const readyIds = new Set(ready.map((t) => t.id));
    const nextTasks = cur.tasks.map((t) => (readyIds.has(t.id) ? { ...t, stage: 'doing' } : t));
    hub.projects.save({ ...cur, tasks: nextTasks });

    for (const task of ready) {
      try {
        const res = await hub.startProjectTaskById(cur.id, task.id, { autoDispatch });
        if (res && !res.error) started.push({ taskId: task.id, title: task.title, termId: res.id });
      } catch (e) {
        console.error('[autopilot]', cur.id, task.id, e?.message || e);
      }
    }
    return { started };
  } finally {
    inFlight.delete(projectId);
  }
}

module.exports = { findReadyTasks, runProjectAutopilot };
