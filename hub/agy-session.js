const fs = require('fs');
const os = require('os');
const path = require('path');

function hasAgyCliConversation(id, homeDir = os.homedir()) {
  if (!id || !/^[0-9a-f-]+$/i.test(String(id))) return false;
  const dir = path.join(homeDir, '.gemini', 'antigravity-cli', 'conversations');
  return fs.existsSync(path.join(dir, `${id}.db`)) || fs.existsSync(path.join(dir, `${id}.pb`));
}

function sessionFromLog(text, pid) {
  const idPattern = /\b(?:Created|Streaming|Full redraw completed.*?for|Sending user message to)\s+conversation\s+([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\b/i;
  for (const line of text.trimEnd().split('\n').reverse()) {
    if (pid && Number(/^[A-Z]\d{4}\s+\S+\s+(\d+)\s/.exec(line)?.[1]) !== pid) continue;
    const id = idPattern.exec(line)?.[1];
    if (id) return id;
  }
  return null;
}

function readSession(file, pid) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const bytes = Buffer.alloc(Math.min(size, 256 * 1024));
    const count = fs.readSync(fd, bytes, 0, bytes.length, size - bytes.length);
    return sessionFromLog(bytes.toString('utf8', 0, count), pid);
  } catch { return null; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
const AGY_BUSY_RE = /esc to (?:cancel|interrupt)|ctrl\+c to (?:cancel|interrupt|stop)|[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]|(?:thinking|working|running|generating)(?:\.\.\.|…)/i;
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

function stripAnsi(s) {
  return String(s || '').replace(ANSI_RE, '');
}

function agyStatusFromScreen(screen, { exited = null, lastOutputAt = 0, lastResizeAt = 0, spawnedAt = 0, now = Date.now() } = {}) {
  if (exited !== null) return 'exited';
  if (AGY_BUSY_RE.test(String(screen || ''))) return 'busy';
  const resizeQuiet = lastResizeAt && now - lastResizeAt < 2500;
  if (!resizeQuiet && lastOutputAt && now - lastOutputAt < 1800 && now - (spawnedAt || 0) > 3500) return 'busy';
  return 'idle';
}

module.exports = { readSession, sessionFromLog, agyStatusFromScreen, stripAnsi, hasAgyCliConversation };
