const fs = require('fs');
const path = require('path');

// AGY stores full conversations separately from its search and summary database.
function agyRecord(root, id, safeFile) {
  const store = path.dirname(root);
  const dir = path.join(store, 'conversations');
  return {
    db: safeFile(store, path.join(store, 'conversation_summaries.db')),
    files: [
      path.join(root, id, '.system_generated', 'logs', 'transcript.jsonl'),
      ...['.db', '.db-wal', '.db-shm', '.pb'].map(ext => path.join(dir, id + ext)),
      path.join(store, 'chapter_titles', id + '.pb'),
      path.join(store, 'annotations', id + '.pbtxt'),
    ].map(file => safeFile(store, file)).filter(Boolean),
  };
}

function deleteAgy(roots, id, safeFile) {
  const targets = roots.map(root => agyRecord(root, id, safeFile));
  let removed = targets.some(target => target.files.length);
  for (const target of targets) {
    if (!target.db) continue;
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(target.db);
    try {
      const found = db.prepare("SELECT name FROM sqlite_master WHERE name IN ('conversation_summaries','conversations_fts','conversation_parents')").all();
      const tables = new Set(found.map(row => row.name));
      db.exec('PRAGMA busy_timeout=1500; PRAGMA secure_delete=ON; BEGIN IMMEDIATE;');
      if (tables.has('conversations_fts')) removed = !!db.prepare('DELETE FROM conversations_fts WHERE conversation_id = ?').run(id).changes || removed;
      if (tables.has('conversation_parents')) removed = !!db.prepare('DELETE FROM conversation_parents WHERE conversation_id = ? OR parent_id = ?').run(id, id).changes || removed;
      if (tables.has('conversation_summaries')) removed = !!db.prepare('DELETE FROM conversation_summaries WHERE conversation_id = ?').run(id).changes || removed;
      db.exec('COMMIT');
    } finally { db.close(); }
  }
  for (const target of targets) for (const file of target.files) fs.rmSync(file, { force: true });
  return removed;
}
module.exports = deleteAgy;
