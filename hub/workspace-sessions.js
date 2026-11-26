'use strict';

const { hasAgyCliConversation } = require('./agy-session');

function createWorkspaceSessions(hub, liveSessions) {
  function linkedTerms(hidden = hub.projects.hidden()) {
    const links = new Map();
    for (const [id, term] of hub.terms) {
      const agent = hub.agentOf(term);
      if (!agent || !term.meta?.spawnedAt) continue;
      const native = hub.termSessionId(term);
      if (!hub.validSessionId(native) || hidden.has(native)) continue;
      const nativeKey = `session:${agent}:${native}`;
      if (!links.has(nativeKey)) links.set(nativeKey, []);
      links.get(nativeKey).push({ termKey: `term:${id}`, generation: term.meta.spawnedAt, nativeKey, term });
    }
    return links;
  }

  function resolveFrom(sessionKey, hidden, links, getLive) {
    const termId = /^term:(\d+)$/.exec(sessionKey)?.[1];
    if (termId) {
      const term = hub.terms.get(termId);
      if (!term) return null;
      const agent = hub.agentOf(term);
      const nativeKey = agent && `session:${agent}:${hub.termSessionId(term)}`;
      const matches = links.get(nativeKey) || [];
      const linked = matches.find((link) => link.term === term);
      return { sessionKey, termKey: sessionKey, generation: term.meta?.spawnedAt, cwd: term.cwd,
        nativeKey: linked?.nativeKey, ambiguous: !!linked && matches.length > 1, editable: true };
    }

    const native = /^session:(claude|codex|agy|cursor):([\w-]{8,100})$/.exec(sessionKey);
    if (!native || hidden.has(native[2])) return null;
    const [, agent, id] = native;
    const doc = hub.index.get(id);
    if (doc && (doc.agent || 'claude') !== agent) return null;
    const linked = links.get(sessionKey) || [];
    const live = agent === 'claude' && !doc?.cwd ? getLive().find((item) => item.sessionId === id) : null;
    if (!doc && !live && !linked.length) return null;
    const match = linked.length === 1 ? linked[0] : null;
    return { sessionKey, nativeKey: sessionKey, termKey: match?.termKey, generation: match?.generation,
      cwd: doc?.cwd || live?.cwd || match?.term.cwd, observedDirs: doc?.observedDirs,
      ambiguous: linked.length > 1, editable: !!match || (!!doc && (agent !== 'agy' || hasAgyCliConversation(id))) };
  }

  function sessionLinks() {
    return [...linkedTerms().values()].filter((links) => links.length === 1).map(([link]) => link);
  }

  function resolveMany(keys) {
    const hidden = hub.projects.hidden();
    const links = linkedTerms(hidden);
    let live;
    return keys.map((key) => resolveFrom(key, hidden, links, () => live ??= liveSessions()));
  }

  return { resolve: (key) => resolveMany([key])[0], resolveMany, sessionLinks };
}

module.exports = { createWorkspaceSessions };
