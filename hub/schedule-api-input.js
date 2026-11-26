'use strict';

const { error, UUID } = require('./schedule-fields');

const editable = ['name', 'trigger', 'target', 'prompt', 'overlap', 'misfire', 'timeoutSec'];
const maxBytes = 64 * 1024;

function checkFields(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !allowed.includes(key))) {
    throw error('INVALID_INPUT', 'Invalid schedule request fields');
  }
}

async function scheduleInput(req, operation) {
  if (req.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    throw error('INVALID_JSON', 'Expected application/json');
  }
  if (Number(req.headers['content-length']) > maxBytes) {
    req.resume();
    throw error('BODY_TOO_LARGE', 'Schedule request exceeds 64 KiB');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > maxBytes) {
      req.resume();
      throw error('BODY_TOO_LARGE', 'Schedule request exceeds 64 KiB');
    }
    chunks.push(chunk);
  }
  let input;
  try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw error('INVALID_JSON', 'Invalid JSON body'); }
  const allowed = {
    create: editable, preview: ['trigger'], update: ['revision', ...editable],
    archive: ['revision'], pause: ['revision'], resume: ['revision'], runNow: ['revision', 'requestId'],
  }[operation];
  checkFields(input, allowed);
  if (allowed.includes('revision') && (!Number.isSafeInteger(input.revision) || input.revision < 1)) {
    throw error('INVALID_REVISION', 'A positive revision is required');
  }
  if (operation === 'runNow' && (typeof input.requestId !== 'string' || !UUID.test(input.requestId))) {
    throw error('INVALID_REQUEST_ID', 'A UUID request ID is required');
  }
  if (Object.hasOwn(input, 'trigger')) {
    checkFields(input.trigger, input.trigger?.kind === 'interval' ? ['kind', 'everyMinutes'] : ['kind', 'expression', 'timeZone']);
  }
  if (Object.hasOwn(input, 'target')) {
    checkFields(input.target, ['projectId', 'version', 'taskId', 'cwd', 'cli', 'accountId', 'referenceDirs', 'model', 'effort']);
  }
  return input;
}

function localAccess(req) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)
    && ['127.0.0.1', 'localhost', '[::1]'].some(host => req.headers.host === `${host}:${req.socket.localPort}`);
}

module.exports = { scheduleInput, localAccess };
