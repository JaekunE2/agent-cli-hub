'use strict';

const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { sameFolder, WorkspaceError } = require('./workspace-paths');

const folderRow = ({ id, binding, includeDescendants, createdAt, updatedAt }) =>
  ({ id, path: binding.path, includeDescendants, createdAt, updatedAt });
const registry = (state) => ({ items: state.trustedFolders.map(folderRow), revision: state.trustRevision });

function checkRevision(expected, actual) {
  if (!Number.isSafeInteger(expected) || expected < 0) {
    throw new WorkspaceError(400, 'INVALID_REVISION', 'Expected a nonnegative integer revision');
  }
  if (expected !== actual) throw new WorkspaceError(409, 'REVISION_CONFLICT', 'Folder settings have changed');
}

function changeTrust(state, method, id, input, inspector) {
  checkRevision(input.revision, state.trustRevision);
  const items = state.trustedFolders;
  const now = new Date().toISOString();
  const recursive = input.includeDescendants ?? false;
  let item;
  if (method === 'POST') {
    const binding = inspector.inspect(input.path);
    if (items.some((row) => row.binding.key === binding.key)) {
      throw new WorkspaceError(409, 'FOLDER_EXISTS', 'Folder is already registered');
    }
    item = { id: randomUUID(), binding, includeDescendants: recursive, createdAt: now, updatedAt: now };
    items.push(item);
  } else {
    const index = items.findIndex((row) => row.id === id);
    if (index === -1) throw new WorkspaceError(404, 'FOLDER_NOT_FOUND', 'Trust entry not found');
    if (method === 'DELETE') items.splice(index, 1);
    else {
      item = items[index];
      if (!inspector.current(item.binding)) {
        throw new WorkspaceError(409, 'FOLDER_CHANGED', 'Register the changed folder again');
      }
      Object.assign(item, { includeDescendants: recursive, updatedAt: now });
    }
  }
  if (item && recursive && path.parse(item.binding.path).root === item.binding.path) {
    throw new WorkspaceError(400, 'INVALID_FOLDER', 'Recursive trust cannot be granted to a volume root');
  }
  state.trustRevision += 1;
  return method === 'POST' ? { item: folderRow(item), revision: state.trustRevision } : registry(state);
}

function trustSummary(state, inspector, primary, refs) {
  const rules = new Map(state.trustedFolders.map((row) => [row.binding.key, row]));
  const fold = process.platform === 'win32' ? (dir) => dir.toLowerCase() : (dir) => dir;
  function classify(binding) {
    const actual = inspector.current(binding);
    if (!actual) return { path: binding.path, state: 'unknown', trustId: null };
    let ancestor = actual.path;
    for (;;) {
      const row = rules.get(fold(ancestor));
      if (row && (ancestor === actual.path || row.includeDescendants)
          && sameFolder(inspector.current(row.binding), inspector.current({ ...row.binding, source: ancestor }))) {
        return { path: actual.path, state: 'trusted', trustId: row.id };
      }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
    return { path: actual.path, state: 'untrusted', trustId: null };
  }
  const main = primary ? classify(primary) : null;
  const references = refs.map(classify);
  const states = [main?.state ?? 'unknown', ...references.map((ref) => ref.state)];
  const overall = states.includes('untrusted') ? 'untrusted' : states.includes('unknown') ? 'unknown' : 'trusted';
  return { state: overall, primary: main, refs: references };
}

module.exports = { registry, changeTrust, checkRevision, trustSummary };
