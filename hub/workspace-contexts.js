'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { sameFolder, WorkspaceError } = require('./workspace-paths');
const { registry, changeTrust, checkRevision, trustSummary } = require('./workspace-trust');

function bindFolders(input, inspector) {
  if (!input || !Object.hasOwn(input, 'primaryCwd') || !Array.isArray(input.referenceDirs)
      || input.referenceDirs.length > 16 || Object.keys(input).some((key) => !['primaryCwd', 'referenceDirs', 'revision'].includes(key))) {
    throw new WorkspaceError(400, 'INVALID_INPUT', 'Expected a primary folder and at most 16 reference folders');
  }
  const primary = input.primaryCwd === null ? null : inspector.inspect(input.primaryCwd);
  const seen = new Map(primary ? [[primary.key, primary]] : []);
  const refs = [];
  for (const dir of input.referenceDirs) {
    const ref = inspector.inspect(dir);
    const existing = seen.get(ref.key);
    if (existing && !sameFolder(existing, ref)) {
      throw new WorkspaceError(400, 'AMBIGUOUS_FOLDER', 'Folder names have an ambiguous case match');
    }
    if (!existing) refs.push(ref);
    seen.set(ref.key, ref);
  }
  return { primary, refs };
}

function requireTrusted(state, inspector, row) {
  const summary = trustSummary(state, inspector, row.primary, row.refs);
  if (summary.state !== 'trusted') {
    throw Object.assign(new WorkspaceError(403, 'FOLDER_UNTRUSTED', 'Approve all workspace folders before proceeding'),
      { trustSummary: summary });
  }
}

function sameContext(a, b) {
  return a.revision === b.revision && sameFolder(a.primary, b.primary) && a.refs.length === b.refs.length
    && a.refs.every((ref, index) => sameFolder(ref, b.refs[index]));
}

function createWorkspaceContexts(file) {
  function read() {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); }
    catch (err) {
      if (err.code === 'ENOENT') return { schemaVersion: 1, trustRevision: 0, trustedFolders: [], sessionFolders: {} };
      throw err;
    }
    const state = JSON.parse(text);
    if (state?.schemaVersion !== 1 || !Number.isSafeInteger(state.trustRevision) || !Array.isArray(state.trustedFolders)
        || !state.sessionFolders || typeof state.sessionFolders !== 'object' || Array.isArray(state.sessionFolders)) {
      throw new Error('Invalid workspace context store');
    }
    return state;
  }

  function save(state) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${randomUUID()}.tmp`;
    try {
      const fd = fs.openSync(tmp, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify(state, null, 2) + '\n', 'utf8');
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, file);
    } finally { fs.rmSync(tmp, { force: true }); }
  }

  // Keep revision checks and the atomic replacement in one synchronous transaction.
  function transaction(change) {
    const state = read();
    const result = change(state);
    save(state);
    return result;
  }

  function locate(state, session) {
    const { termKey, generation, nativeKey, ambiguous } = session || {};
    const rows = state.sessionFolders;
    const termEntry = termKey && rows[termKey]?.termGeneration === generation ? rows[termKey] : null;
    const term = termEntry?.alias ? null : termEntry;
    const key = nativeKey || termEntry?.alias || termKey;
    const native = key !== termKey && rows[key];
    const conflict = ambiguous || (term && native) || (nativeKey && termEntry?.alias && nativeKey !== termEntry.alias);
    return { key, row: conflict ? null : native || term, conflict };
  }

  function describe(state, session, row, inspector) {
    let primary = row?.primary || null;
    if (!row && session.cwd) {
      try { primary = inspector.inspect(session.cwd); }
      catch (err) { if (!(err instanceof WorkspaceError)) throw err; }
    }
    const refs = row?.refs || [];
    const trust = trustSummary(state, inspector, primary, refs);
    if (!row && !primary && session.cwd) trust.primary = { path: session.cwd, state: 'unknown', trustId: null };
    return { sessionKey: session.sessionKey, revision: row?.revision ?? 0, managed: !!row,
      primaryCwd: row ? primary?.path ?? null : session.cwd ?? null,
      referenceDirs: refs.map((ref) => ref.path), trustSummary: trust, applied: row && session.applied || null,
      ...(session.observedDirs?.length ? { observedDirs: session.observedDirs } : {}) };
  }

  return {
    listTrust: () => registry(read()),
    changeTrust: (method, id, input, inspector) => transaction((state) => changeTrust(state, method, id, input, inspector)),
    getFolders(session, inspector) {
      const state = read();
      return describe(state, session, locate(state, session).row, inspector);
    },
    hasContext(session) {
      if (!session) return false;
      const state = read();
      const { row, conflict, key } = locate(state, session);
      return !!row || (conflict && (!!state.sessionFolders[key] || [session, ...(session.candidates || [])].some(({ termKey, generation }) =>
        termKey && state.sessionFolders[termKey]?.termGeneration === generation)));
    },
    planLaunch(session, input, cwd, { inspector, matchCwd = false, projectRoot, resumeKey } = {}) {
      const state = read();
      const { row, conflict } = locate(state, session);
      if (conflict) throw new WorkspaceError(409, 'SESSION_AMBIGUOUS', 'Session linkage is ambiguous');
      if (!row && input === undefined) return null;
      if (input !== undefined && (!input || Object.hasOwn(input, 'revision'))) {
        throw new WorkspaceError(400, 'INVALID_INPUT', 'Invalid launch folder settings');
      }
      const desired = input === undefined ? row : { ...bindFolders(input, inspector), revision: (row?.revision || 0) + 1 };
      if (projectRoot) requireTrusted(state, inspector, { primary: inspector.inspect(projectRoot), refs: [] });
      requireTrusted(state, inspector, desired);
      if ((matchCwd || (input !== undefined && cwd)) && (!cwd || !sameFolder(desired.primary, inspector.inspect(cwd)))) {
        throw new WorkspaceError(409, 'WORKSPACE_MISMATCH', 'The primary folder must match the launch workspace');
      }
      return { row: desired, resumeKey };
    },
    rememberLaunch(session, plan) {
      transaction((state) => {
        const { termKey, generation } = session;
        const key = plan.resumeKey || termKey;
        if (plan.resumeKey && plan.resumeKey === session.source?.nativeKey && session.source.termKey) {
          const old = state.sessionFolders[session.source.termKey];
          if (old?.termGeneration === session.source.generation) {
            state.sessionFolders[session.source.termKey] = { termGeneration: session.source.generation, alias: key };
          }
        }
        const { revision, primary, refs } = plan.row;
        state.sessionFolders[key] = { revision, primary, refs, ...(key === termKey ? { termGeneration: generation } : {}) };
        if (key !== termKey) state.sessionFolders[termKey] = { termGeneration: generation, alias: key };
      });
    },
    guardInput(session, applied, inspector) {
      const state = read();
      const { row, conflict } = locate(state, session);
      if (applied) requireTrusted(state, inspector, applied);
      if (conflict) throw new WorkspaceError(409, 'SESSION_AMBIGUOUS', 'Session linkage is ambiguous');
      if (row) requireTrusted(state, inspector, row);
      if ((row || applied) && (!row || !applied || !sameContext(row, applied))) {
        throw new WorkspaceError(409, 'FOLDERS_PENDING_RESTART', 'Restart the session to apply the folder settings');
      }
    },
    putFolders(session, input, inspector) {
      return transaction((state) => {
        const { key, row, conflict } = locate(state, session);
        if (conflict) throw new WorkspaceError(409, 'SESSION_AMBIGUOUS', 'Session linkage is ambiguous');
        checkRevision(input.revision, row?.revision ?? 0);
        const next = { ...bindFolders(input, inspector), revision: input.revision + 1,
          ...(key === session.termKey ? { termGeneration: session.generation } : {}) };
        if (session.termKey && key !== session.termKey && session.generation) {
          state.sessionFolders[session.termKey] = { termGeneration: session.generation, alias: key };
        }
        state.sessionFolders[key] = next;
        return describe(state, session, next, inspector);
      });
    },
    linkTerms(sessions) {
      if (!sessions.length || !fs.existsSync(file)) return;
      const state = read();
      let changed = false;
      for (const session of sessions) {
        const { key, row, conflict } = locate(state, session);
        if (conflict || !row || row !== state.sessionFolders[session.termKey]) continue;
        const { termGeneration, ...native } = row;
        state.sessionFolders[key] = native;
        state.sessionFolders[session.termKey] = { termGeneration, alias: key };
        changed = true;
      }
      if (changed) save(state);
    },
  };
}

module.exports = { createWorkspaceContexts };
