'use strict';

const { hasAgyCliConversation } = require('./agy-session');

function createWorkspaceSessions(hub, liveSessions) {
  function linkedTerms() {
    const links = new Map();
    for (const [id, term] of hub.terms) {
      const agent = hub.agentOf(term);
      if (!agent || !term.meta?.spawnedAt) continue;
      const native = hub.termSessionId(term) || term.meta.workspaceFolders?.nativeKey?.split(':')[2];
      if (!hub.validSessionId(native) || hub.projects.hidden().has(native)) continue;
      const nativeKey = `session:${agent}:${native}`;
      if (!links.has(nativeKey)) links.set(nativeKey, []);
      links.get(nativeKey).push({ termKey: `term:${id}`, generation: term.meta.spawnedAt, nativeKey, term });
    }
    for (const [key, matches] of links) {
      const running = matches.filter(({ term }) => term.exited === null);
      if (running.length) links.set(key, running);
    }
    return links;
  }

  function resolve(sessionKey) {
    const termId = /^term:(\d+)$/.exec(sessionKey)?.[1];
    if (termId) {
      const term = hub.terms.get(termId);
      if (!term) return null;
      const links = linkedTerms();
      const agent = hub.agentOf(term);
      const nativeKey = (agent && `session:${agent}:${hub.termSessionId(term) || ''}`);
      const applied = term.meta?.workspaceFolders?.applied;
      const matches = links.get(nativeKey) || links.get(term.meta?.workspaceFolders?.nativeKey) || [];
      const linked = matches.find((link) => link.term === term);
      return { sessionKey, termKey: sessionKey, generation: term.meta?.spawnedAt, cwd: term.cwd,
        nativeKey: linked?.nativeKey, ambiguous: !!linked && matches.length > 1, editable: true, applied };
    }

    const native = /^session:(claude|codex|agy|cursor):([\w-]{8,100})$/.exec(sessionKey);
    if (!native || hub.projects.hidden().has(native[2])) return null;
    const [, agent, id] = native;
    const doc = hub.index.get(id);
    if (doc && (doc.agent || 'claude') !== agent) return null;
    const linked = linkedTerms().get(sessionKey) || [];
    const live = agent === 'claude' ? liveSessions().find((item) => item.sessionId === id) : null;
    if (!doc && !live && !linked.length) return null;
    const match = linked.length === 1 ? linked[0] : null;
    return { sessionKey, nativeKey: sessionKey, termKey: match?.termKey, generation: match?.generation,
      cwd: doc?.cwd || live?.cwd || match?.term.cwd, observedDirs: doc?.observedDirs,
      ambiguous: linked.length > 1, candidates: linked.length > 1 ? linked : undefined,
      applied: match?.term.meta?.workspaceFolders?.applied,
      editable: !!match || (!!doc && (agent !== 'agy' || hasAgyCliConversation(id))) };
  }

  function sessionLinks() {
    return [...linkedTerms().values()].filter((links) => links.length === 1).map(([link]) => link);
  }

  return { resolve, sessionLinks };
}

module.exports = { createWorkspaceSessions };
