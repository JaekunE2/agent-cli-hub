'use strict';

const { nextSlot } = require('./schedule-timing');

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const iso = ms => new Date(ms).toISOString();
const error = (code, message) => Object.assign(new Error(message), { code });
const isText = (value, max) => typeof value === 'string' && value.trim() && value.length <= max;

const SUPPORTED_CLIS = ['codex', 'claude', 'agy'];

function fields(input, previous, now) {
  const { name, prompt, target, overlap = 'skip', misfire = 'skip', timeoutSec = 900 } = { ...previous, ...input };
  if (!isText(name, 120) || !isText(prompt, 16000) ||
      !['skip', 'queue', 'replace'].includes(overlap) || !['skip', 'run_once'].includes(misfire) ||
      !Number.isInteger(timeoutSec) || timeoutSec < 30 || timeoutSec > 3600) {
    throw error('INVALID_SCHEDULE', 'Invalid schedule fields');
  }
  if (!isText(target?.projectId, 128) || !isText(target.version, 128) ||
      (target.taskId != null && (typeof target.taskId !== 'string' || !UUID.test(target.taskId))) ||
      !Array.isArray(target.referenceDirs ?? []) || !(target.referenceDirs ?? []).every(dir => isText(dir, 4096)) ||
      (target.model !== undefined && !isText(target.model, 128)) ||
      (target.effort !== undefined && !isText(target.effort, 128))) {
    throw error('INVALID_TARGET', 'Invalid schedule target');
  }
  const cli = target.cli ?? 'codex';
  const accountId = target.accountId ?? 'default';
  if (!SUPPORTED_CLIS.includes(cli) || !isText(accountId, 128)) {
    throw error('CAPABILITY_UNSUPPORTED', `Unsupported schedule CLI or account: ${cli}`);
  }
  const trigger = Object.hasOwn(input, 'trigger') ? normalizeTrigger(input.trigger, now) : previous?.trigger;
  if (!trigger) throw error('INVALID_TRIGGER', 'A trigger is required');
  return {
    name, prompt, overlap, misfire, timeoutSec, trigger,
    target: {
      projectId: target.projectId, version: target.version, taskId: target.taskId ?? null,
      cli, accountId, referenceDirs: [...(target.referenceDirs ?? [])],
      ...(target.model === undefined ? {} : { model: target.model }),
      ...(target.effort === undefined ? {} : { effort: target.effort }),
    },
  };
}

function normalizeTrigger(trigger, now) {
  const normalized = trigger?.kind === 'interval'
    ? { kind: 'interval', everyMinutes: trigger.everyMinutes, anchorAt: iso(now) }
    : { kind: trigger?.kind, expression: trigger?.expression, timeZone: trigger?.timeZone };
  nextSlot(normalized, now);
  return normalized;
}

function itemFor(data, id) {
  const item = data.schedules.find(schedule => schedule.id === id);
  if (!item) throw error('SCHEDULE_MISSING', 'Schedule not found');
  return item;
}

function editableItem(data, id, revision) {
  const item = itemFor(data, id);
  if (item.revision !== revision || item.state === 'archived') {
    throw error('SCHEDULE_CONFLICT', 'Schedule revision or state changed');
  }
  return item;
}

module.exports = { UUID, iso, error, fields, normalizeTrigger, itemFor, editableItem };
