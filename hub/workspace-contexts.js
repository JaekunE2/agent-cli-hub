'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { sameFolder, WorkspaceError } = require('./workspace-paths');
const { registry, changeTrust, checkRevision, trustSummary } = require('./workspace-trust');

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
    const { termKey, generation, nativeKey, ambiguous } = session;
    const rows = state.sessionFolders;
    const term = termKey && rows[termKey]?.termGeneration === generation ? rows[termKey] : null;
    const native = nativeKey && rows[nativeKey];
    const conflict = ambiguous || (term && native);
    return { key: nativeKey || termKey, row: conflict ? null : native || term, conflict };
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
      editable: !!session.editable && !session.ambiguous,
      primaryCwd: row ? primary?.path ?? null : session.cwd ?? null,
      referenceDirs: refs.map((ref) => ref.path), trustSummary: trust, applied: null,
      ...(session.observedDirs?.length ? { observedDirs: session.observedDirs } : {}) };
  }

  return {
    listTrust: () => registry(read()),
    changeTrust: (method, id, input, inspector) => transaction((state) => changeTrust(state, method, id, input, inspector)),
    getFolders(session, inspector) {
      const state = read();
      return describe(state, session, locate(state, session).row, inspector);
    },
    getFolderSummaries(sessions, inspector) {
      const state = read();
      return sessions.map((session) => session && describe(state, session, locate(state, session).row, inspector));
    },
    putFolders(session, input, inspector) {
      return transaction((state) => {
        const { key, row, conflict } = locate(state, session);
        if (conflict) throw new WorkspaceError(409, 'SESSION_AMBIGUOUS', 'Session linkage is ambiguous');
        checkRevision(input.revision, row?.revision ?? 0);
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
        const next = { revision: input.revision + 1, primary, refs,
          ...(key === session.termKey ? { termGeneration: session.generation } : {}) };
        if (session.termKey && key !== session.termKey && row === state.sessionFolders[session.termKey]) {
          delete state.sessionFolders[session.termKey];
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
        delete state.sessionFolders[session.termKey];
        changed = true;
      }
      if (changed) save(state);
    },
  };
}

module.exports = { createWorkspaceContexts };
