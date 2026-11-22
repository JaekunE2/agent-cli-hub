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

async function deleteCliRecord(record, { claudeRoot, agyRoots, codexExe, env, run = promisify(execFile) }) {
  if (!uuid(record?.id)) throw new Error('지원되는 대화 ID가 아닙니다.');
  if (record.agent === 'agy') return deleteAgy(agyRoots, record.id, safeFile);
  if (record.agent === 'codex') {
    if (!codexExe || /\.cmd$/i.test(codexExe)) throw new Error('Codex 기록 삭제를 지원하는 codex.exe가 필요합니다.');
    if (record.file && !fs.existsSync(record.file)) return false;
    try { await run(codexExe, ['delete', '--force', record.id], { env, windowsHide: true, timeout: 30_000, maxBuffer: 32_768 }); }
    catch { throw new Error('Codex에서 대화를 삭제하지 못했습니다. 설치한 CLI의 delete 지원 여부를 확인하세요.'); }
    return true;
  }
  if (record.agent !== 'claude' || path.basename(record.file || '') !== record.id + '.jsonl') {
    throw new Error('삭제할 CLI 원본 기록을 확인할 수 없습니다.');
  }
  const file = safeFile(claudeRoot, record.file);
  if (file) fs.unlinkSync(file);
  return !!file;
}
module.exports = { deleteCliRecord, safeFile, uuid };
