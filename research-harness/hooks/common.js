// Shared helpers for the research-harness hooks (run by Claude Code with the hook JSON on stdin).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function readInput() {
  try { return JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { return {}; }
}

// Walk up from cwd to the folder that has research/state.json.
function findProject(start) {
  let dir = path.resolve(start || process.env.CLAUDE_PROJECT_DIR || process.cwd());
  for (;;) {
    if (fs.existsSync(path.join(dir, 'research', 'state.json'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

const statePath = (proj) => path.join(proj, 'research', 'state.json');
function loadState(proj) {
  // a BOM (PowerShell writes) would make the project invisible to the hooks and the dashboard
  try { return JSON.parse(fs.readFileSync(statePath(proj), 'utf8').replace(/^﻿/, '')); } catch { return null; }
}
// Write via temp file + rename so a concurrent reader never sees half a file.
function saveState(proj, st) {
  const p = statePath(proj), tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(st, null, 2));
  fs.renameSync(tmp, p);
}

function isDirector(input, st) {
  if (process.env.RESEARCH_ROLE === 'director') return true;
  return !!(st && st.director_session_id && input.session_id === st.director_session_id);
}

// Fingerprint of the agent's own progress (state minus harness bookkeeping + journal size).
function progressFingerprint(proj, st) {
  const { autopilot, ...rest } = st;
  let jsize = 0;
  try { jsize = fs.statSync(path.join(proj, 'research', 'JOURNAL.md')).size; } catch {}
  return crypto.createHash('sha1').update(JSON.stringify(rest) + ':' + jsize).digest('hex').slice(0, 16);
}

function unreadInbox(proj) {
  // count only message headings ("## <time> · <from> (unread)"), not prose that mentions the word
  try { return (fs.readFileSync(path.join(proj, 'research', 'INBOX.md'), 'utf8').match(/^## .*\(unread\)\s*$/gm) || []).length; } catch { return 0; }
}

function tail(file, n) {
  try { return fs.readFileSync(file, 'utf8').trimEnd().split('\n').slice(-n).join('\n'); } catch { return ''; }
}

function hookLog(proj, msg) {
  try { fs.appendFileSync(path.join(proj, 'research', '.harness.log'), `${new Date().toISOString()} ${msg}\n`); } catch {}
}

module.exports = { readInput, findProject, loadState, saveState, isDirector, progressFingerprint, unreadInbox, tail, hookLog };
