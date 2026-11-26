'use strict';

const { folderInspector, WorkspaceError } = require('./workspace-paths');

function local(req) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)
    && ['127.0.0.1', 'localhost', '[::1]'].some((host) => req.headers.host === `${host}:${req.socket.localPort}`);
}

async function inputJson(req, required, optional = []) {
  if (req.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    throw new WorkspaceError(400, 'INVALID_JSON', 'Expected application/json');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 65536) {
      req.resume();
      throw new WorkspaceError(413, 'INPUT_TOO_LARGE', 'Folder settings exceed 64 KiB');
    }
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new WorkspaceError(400, 'INVALID_JSON', 'Invalid JSON body'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || required.some((key) => !Object.hasOwn(value, key))
      || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) {
    throw new WorkspaceError(400, 'INVALID_INPUT', 'Invalid folder settings fields');
  }
  return value;
}

function decoded(value) {
  try { return decodeURIComponent(value); }
  catch { throw new WorkspaceError(400, 'INVALID_ID', 'Invalid encoded ID'); }
}

function createWorkspaceFolderRoutes(store, resolveSession, logError) {
  return async function handle(p, url, req, res, send, authed) {
    const trust = /^\/api\/trusted-folders(?:\/([^/]+))?$/.exec(p);
    const folders = /^\/api\/sessions\/([^/]+)\/folders$/.exec(p);
    if (!trust && !folders) return false;
    const method = req.method;
    try {
      if (!authed(req, url)) throw new WorkspaceError(401, 'UNAUTHORIZED', 'Authentication required');
      const isLocal = local(req);
      if ((trust || method !== 'GET') && !isLocal) {
        throw new WorkspaceError(403, 'LOCAL_REQUIRED', 'Local access required');
      }
      const methods = trust ? (trust[1] ? ['PATCH', 'DELETE'] : ['GET', 'POST']) : ['GET', 'PUT'];
      if (!methods.includes(method)) {
        res.setHeader('Allow', methods.join(', '));
        throw new WorkspaceError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
      }
      if (trust) {
        if (method === 'GET') send(res, 200, store.listTrust());
        else {
          const input = await inputJson(req, method === 'POST' ? ['path', 'revision']
            : method === 'PATCH' ? ['includeDescendants', 'revision'] : ['revision'],
          method === 'POST' ? ['includeDescendants'] : []);
          if (Object.hasOwn(input, 'includeDescendants') && typeof input.includeDescendants !== 'boolean') {
            throw new WorkspaceError(400, 'INVALID_INPUT', 'Expected includeDescendants to be boolean');
          }
          const id = trust[1] && decoded(trust[1]);
          send(res, method === 'POST' ? 201 : 200,
            store.changeTrust(method, id, input, method === 'DELETE' ? null : await folderInspector()));
        }
      } else {
        const sessionKey = decoded(folders[1]);
        const input = method === 'PUT' ? await inputJson(req, ['primaryCwd', 'referenceDirs', 'revision']) : null;
        if (input && (!Array.isArray(input.referenceDirs) || input.referenceDirs.length > 16)) {
          throw new WorkspaceError(400, 'INVALID_INPUT', 'Expected at most 16 reference folders');
        }
        const inspector = await folderInspector();
        const session = resolveSession(sessionKey);
        if (!session) throw new WorkspaceError(404, 'SESSION_NOT_FOUND', 'Session not found');
        if (input && !session.editable) throw new WorkspaceError(403, 'SESSION_READ_ONLY', 'Session is read-only');
        const result = input ? store.putFolders(session, input, inspector) : store.getFolders(session, inspector);
        send(res, 200, isLocal ? result : { sessionKey, revision: result.revision, managed: result.managed,
          referenceCount: result.referenceDirs.length, trustState: result.trustSummary.state,
          hasPendingChanges: result.managed && result.applied?.revision !== result.revision });
      }
    } catch (err) {
      if (err instanceof WorkspaceError) send(res, err.status, { error: err.message, code: err.code });
      else {
        logError('workspace-folders', err);
        send(res, 503, { error: 'Folder settings are unavailable', code: 'WORKSPACE_UNAVAILABLE' });
      }
    }
    return true;
  };
}

module.exports = { createWorkspaceFolderRoutes };
