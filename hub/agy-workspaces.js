const path = require('path');
const fs = require('fs');
const { fileURLToPath } = require('url');

// Cache parsed summary rows per DB file keyed by mtimeMs + size so periodic
// SearchIndex refreshes don't reopen SQLite when nothing changed.
const dbCache = new Map();

function readSummaries(file) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const sig = `${st.mtimeMs}:${st.size}`;
  const hit = dbCache.get(file);
  if (hit && hit.sig === sig) return hit.rows;
  let db;
  try {
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(file, { readOnly: true });
    const cols = new Set(db.prepare('PRAGMA table_info(conversation_summaries)').all().map((c) => c.name));
    const hasTitle = cols.has('title');
    const sql = hasTitle
      ? 'SELECT conversation_id, title, workspace_uris FROM conversation_summaries WHERE workspace_uris IS NOT NULL OR title IS NOT NULL'
      : 'SELECT conversation_id, workspace_uris FROM conversation_summaries WHERE workspace_uris IS NOT NULL';
    const rows = [];
    for (const row of db.prepare(sql).iterate()) {
      let cwd = null;
      if (row.workspace_uris) {
        try {
          const uris = JSON.parse(row.workspace_uris);
          if (Array.isArray(uris)) {
            const folders = [...new Set(uris.filter((u) => typeof u === 'string' && u.startsWith('file:')).map((u) => fileURLToPath(u)))];
            if (folders.length === 1) cwd = folders[0];
          }
        } catch {}
      }
      const title = hasTitle && typeof row.title === 'string' ? row.title.trim() : '';
      if (cwd || title) rows.push({ id: row.conversation_id, cwd, title });
    }
    dbCache.set(file, { sig, rows });
    return rows;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

module.exports = function addAgyWorkspaces(brainRoots, docs) {
  for (const root of brainRoots) {
    const file = path.join(root, '..', 'conversation_summaries.db');
    const rows = readSummaries(file);
    if (!rows) continue;
    const prefix = root + path.sep;
    for (const row of rows) {
      const doc = docs.get(row.id);
      if (!doc || doc.agent !== 'agy' || !doc.file.startsWith(prefix)) continue;
      if (!doc.cwd && row.cwd) doc.cwd = row.cwd;
      if (!doc.title && row.title) doc.title = row.title;
    }
  }
};
