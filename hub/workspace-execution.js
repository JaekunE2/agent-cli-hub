'use strict';

const { folderInspector, WorkspaceError } = require('./workspace-paths');
const { unsupported } = require('./workspace-launch');

const agents = new Set(['codex', 'claude', 'agy', 'cursor']);
const nativeFolderKey = (cli, id) => agents.has(cli) && typeof id === 'string' && /^[\w-]{8,100}$/.test(id) ? `session:${cli}:${id}` : '';

function createWorkspaceExecution(store, sessionLookup, inspect = folderInspector) {
  // Cache drive discovery, while rechecking path identities and trust on every write.
  let pendingInspector, expires = 0;
  const inspector = () => {
    if (Date.now() >= expires) {
      expires = Date.now() + 5000;
      pendingInspector = inspect().catch((error) => { expires = 0; throw error; });
    }
    return pendingInspector;
  };
  const native = (key) => key && (sessionLookup(key) || { nativeKey: key });
  const forTerm = (term) => sessionLookup(`term:${term.id}`) || {
    termKey: `term:${term.id}`, generation: term.meta?.spawnedAt,
  };

  return {
    forTerm,
    native,
    hasContext: store.hasContext,
    async describe(term) {
      const session = forTerm(term);
      return store.hasContext(session) ? store.getFolders(session, await inspector()) : null;
    },
    async plan({ source, folders, cwd, matchCwd, projectRoot, resumeKey, external, skipPermissions }) {
      if (folders === undefined && !store.hasContext(source)) return null;
      if (external) throw unsupported();
      if (skipPermissions === true) {
        throw new WorkspaceError(409, 'FOLDERS_PERMISSION_BYPASS', 'Managed folders require normal CLI permission checks');
      }
      const plan = store.planLaunch(source, folders, cwd, { inspector: await inspector(), matchCwd, projectRoot, resumeKey });
      return plan && { ...plan, source };
    },
    rememberLaunch: (id, generation, plan) => store.rememberLaunch({ termKey: `term:${id}`, generation, source: plan.source }, plan),
    async guardTerm(term) {
      const active = term.meta?.workspaceFolders;
      const session = forTerm(term);
      if (!session.nativeKey && active?.nativeKey) session.nativeKey = active.nativeKey;
      if (active || store.hasContext(session)) store.guardInput(session, active?.row, await inspector());
    },
    async guardNative(key) {
      const session = native(key);
      if (store.hasContext(session)) store.guardInput(session, null, await inspector());
    },
  };
}

module.exports = { createWorkspaceExecution, nativeFolderKey };
