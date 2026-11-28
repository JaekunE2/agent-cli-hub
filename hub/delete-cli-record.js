const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const deleteAgy = require('./agy-delete');

const uuid = id => typeof id === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id);
function safeFile(root, file) {
  try {
    const actual = fs.realpathSync(file);
    const relative = path.relative(fs.realpathSync(root), actual);
    const expected = path.relative(path.resolve(root), path.resolve(file));
    const normalize = p => process.platform === 'win32' ? p.toLowerCase() : p;
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)
      || normalize(relative) !== normalize(expected) || !fs.statSync(actual).isFile() || fs.lstatSync(file).isSymbolicLink()) {
      throw new Error('기록 저장소 밖의 파일은 삭제할 수 없습니다.');
    }
    return actual;
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

function inferCodexHome(file) {
  if (!file || typeof file !== 'string') return null;
  const resolved = path.resolve(file);
  const m = /^(.*?)[\\/](?:sessions|archived_sessions)[\\/]/i.exec(resolved);
  return m && m[1] ? m[1] : null;
}

function cleanupCodexLocalIndexes(codexHome, id) {
  if (!codexHome) return;
  try {
    const idxFile = path.join(codexHome, 'session_index.jsonl');
    if (fs.existsSync(idxFile)) {
      const lines = fs.readFileSync(idxFile, 'utf8').split(/\r?\n/);
      const kept = lines.filter((line) => !line.includes(id));
      if (kept.length !== lines.length) {
        fs.writeFileSync(idxFile, kept.join('\n'));
      }
    }
  } catch {}
  try {
    const { DatabaseSync } = require('node:sqlite');
    for (const name of fs.readdirSync(codexHome)) {
      if (!/^state_\d+\.sqlite$/i.test(name)) continue;
      let db;
      try {
        db = new DatabaseSync(path.join(codexHome, name));
        db.exec('PRAGMA busy_timeout = 1500');
        db.prepare('DELETE FROM threads WHERE id = ?').run(id);
      } catch {}
      finally { try { db?.close(); } catch {} }
    }
  } catch {}
}

async function deleteCliRecord(record, { claudeRoot, agyRoots, codexExe, env, run = promisify(execFile) }) {
  if (!uuid(record?.id)) throw new Error('지원되는 대화 ID가 아닙니다.');
  if (record.agent === 'agy') return deleteAgy(agyRoots, record.id, safeFile);
  if (record.agent === 'codex') {
    if (record.file && !fs.existsSync(record.file)) return false;
    const inferredHome = inferCodexHome(record.file);
    const execEnv = inferredHome ? { ...(env || {}), CODEX_HOME: inferredHome } : env;
    let cliErr = null;
    if (codexExe && !/\.cmd$/i.test(codexExe)) {
      try {
        await run(codexExe, ['delete', '--force', record.id], { env: execEnv, windowsHide: true, timeout: 30_000, maxBuffer: 32_768 });
        if (!record.file || !fs.existsSync(record.file)) return true;
      } catch (e) {
        cliErr = e;
      }
    }
    if (record.file && inferredHome && path.basename(record.file).toLowerCase().includes(record.id.toLowerCase()) && /\.jsonl$/i.test(record.file)) {
      const sessionsRoot = path.join(inferredHome, /[\\/]archived_sessions[\\/]/i.test(record.file) ? 'archived_sessions' : 'sessions');
      const target = safeFile(sessionsRoot, record.file);
      if (target) {
        fs.unlinkSync(target);
        cleanupCodexLocalIndexes(inferredHome, record.id);
        return true;
      }
      return false;
    }
    if (!codexExe || /\.cmd$/i.test(codexExe)) throw new Error('Codex 기록 삭제를 지원하는 codex.exe가 필요합니다.');
    const detail = String(cliErr?.stderr || cliErr?.message || '').trim().split(/\r?\n/)[0].slice(0, 140);
    throw new Error(detail ? `Codex에서 대화를 삭제하지 못했습니다 (${detail}).` : 'Codex에서 대화를 삭제하지 못했습니다. 설치한 CLI의 delete 지원 여부를 확인하세요.');
  }
  if (record.agent !== 'claude' || path.basename(record.file || '') !== record.id + '.jsonl') {
    throw new Error('삭제할 CLI 원본 기록을 확인할 수 없습니다.');
  }
  const file = safeFile(claudeRoot, record.file);
  if (file) fs.unlinkSync(file);
  return !!file;
}
module.exports = { deleteCliRecord, safeFile, uuid };
