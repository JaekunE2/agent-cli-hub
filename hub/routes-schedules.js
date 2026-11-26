'use strict';

const { error, itemFor } = require('./schedule-fields');
const { scheduleInput, localAccess } = require('./schedule-api-input');
const { runView, scheduleView, newestFirst, historyPage } = require('./schedule-api-view');

const operations = {
  list: { GET: 'list', POST: 'create' },
  item: { GET: 'get', PATCH: 'update', DELETE: 'archive' },
  preview: { POST: 'preview' }, pause: { POST: 'pause' }, resume: { POST: 'resume' },
  run: { POST: 'runNow' }, runs: { GET: 'history' },
};
const statusFor = new Map([
  ...['INVALID_JSON', 'INVALID_INPUT', 'INVALID_REVISION', 'INVALID_SCHEDULE', 'INVALID_TARGET',
    'INVALID_TRIGGER', 'INVALID_REQUEST_ID', 'INVALID_LIMIT', 'INVALID_CURSOR', 'CAPABILITY_UNSUPPORTED']
    .map(code => [code, 400]),
  ['UNAUTHORIZED', 401], ['LOCAL_REQUIRED', 403], ['SCHEDULE_MISSING', 404], ['TARGET_MISSING', 404],
  ['METHOD_NOT_ALLOWED', 405], ['SCHEDULE_CONFLICT', 409], ['SCHEDULE_LIMIT', 409],
  ['BODY_TOO_LARGE', 413], ['SCHEDULE_UNAVAILABLE', 503],
]);

function createScheduleRoutes(getEngine, capabilities, logError) {
  return async function handle(p, url, req, res, send, authed) {
    if (p !== '/api/schedules' && !p.startsWith('/api/schedules/')) return false;
    try {
      if (!authed(req, url)) throw error('UNAUTHORIZED', 'Authentication required');
      const local = localAccess(req);
      if (req.method !== 'GET' && !local) throw error('LOCAL_REQUIRED', 'Local access required');
      const match = /^\/api\/schedules(?:\/([^/]+)(?:\/(pause|resume|run|runs))?)?$/.exec(p);
      if (!match) throw error('SCHEDULE_MISSING', 'Schedule route not found');
      const [, id, action] = match;
      const methods = operations[action || (id === 'preview' ? 'preview' : id ? 'item' : 'list')];
      const operation = Object.hasOwn(methods, req.method) && methods[req.method];
      if (!operation) {
        res.setHeader('Allow', Object.keys(methods).join(', '));
        throw error('METHOD_NOT_ALLOWED', 'Method not allowed');
      }
      const engine = getEngine();
      if (!engine) throw error('SCHEDULE_UNAVAILABLE', 'Schedule service is unavailable');
      if (req.method === 'GET') {
        const data = engine.snapshot();
        return sendRead(send, res, operation, data, id, url.searchParams, local, capabilities);
      }

      const { revision, ...input } = await scheduleInput(req, operation);
      if (operation === 'preview') send(res, 200, engine.preview(input.trigger));
      else if (operation === 'runNow' || operation === 'resume') {
        if (!capabilities.cli.some(cli => cli.available)) {
          itemFor(engine.snapshot(), id);
          throw error('SCHEDULE_UNAVAILABLE', 'Schedule runner is unavailable');
        }
        if (operation === 'runNow') {
          const { run, seq, replayed } = await engine.runNow(id, revision, input.requestId);
          send(res, replayed ? 200 : 201, { run: runView(run, local), seq });
        } else sendItem(send, res, 200, await engine.resume(id, revision), local);
      } else {
        const result = operation === 'create' ? await engine.create(input) : await engine[operation](id, revision, input);
        sendItem(send, res, operation === 'create' ? 201 : 200, result, local);
      }
    } catch (cause) {
      const status = statusFor.get(cause.code);
      if (status) send(res, status, { error: cause.message, code: cause.code });
      else {
        logError('schedules-api', cause);
        send(res, 503, { error: 'Schedule service is unavailable', code: 'SCHEDULE_UNAVAILABLE' });
      }
    }
    return true;
  };
}

function sendRead(send, res, operation, data, id, query, local, capabilities) {
  const { schedules, runs, seq } = data;
  if (operation === 'list') {
    const last = new Map();
    for (const run of runs.sort(newestFirst)) if (!last.has(run.scheduleId)) last.set(run.scheduleId, run);
    const items = schedules.filter(item => item.state !== 'archived').map(item => ({
      ...scheduleView(item, local), lastRun: runView(last.get(item.id), local),
    }));
    send(res, 200, { items, seq, capabilities });
  } else {
    const item = itemFor(data, id);
    if (operation === 'get') sendItem(send, res, 200, { item, seq }, local);
    else send(res, 200, { ...historyPage(query, runs.filter(run => run.scheduleId === id), local), seq });
  }
  return true;
}

function sendItem(send, res, status, { item, seq }, local) {
  send(res, status, { item: scheduleView(item, local), seq });
}

module.exports = { createScheduleRoutes };
