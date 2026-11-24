'use strict';
const fs = require('fs');
const path = require('path');
const { VERSION_RE } = require('./project-validation');

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp']);
const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.pdf': 'application/pdf',
};

function sanitizeId(id) {
  const s = String(id || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!s) throw new Error('프로젝트 ID가 올바르지 않습니다.');
  return s;
}

function sanitizeFileName(name) {
  const base = path.basename(String(name || '').trim()).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  if (!base || base === '.' || base === '..') throw new Error('파일 이름이 올바르지 않습니다.');
  return base.slice(0, 120);
}

/**
 * Per-project shared reference repository store (files, docs, images)
 * usable by both users (via UI) and LLM tasks (via filesystem & prompt instructions).
 */
function createProjectRefsStore(rootDir) {
  const dirOf = (projectId, version = '') => {
    if (version && !VERSION_RE.test(version)) throw new Error('버전 번호를 확인하세요.');
    const dir = path.join(rootDir, sanitizeId(projectId));
    return version ? path.join(dir, 'versions', version) : dir;
  };

  function ensureDir(projectId, version) {
    const dir = dirOf(projectId, version);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  function list(projectId, version) {
    const dir = dirOf(projectId, version);
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
    const out = [];
    for (const e of ents) {
      if (!e.isFile()) continue;
      const full = path.join(dir, e.name);
      try {
        const st = fs.statSync(full);
        const ext = path.extname(e.name).toLowerCase();
        out.push({
          name: e.name,
          size: st.size,
          mtime: st.mtimeMs,
          ext,
          isImage: IMAGE_EXTS.has(ext),
          path: full,
        });
      } catch {}
    }
    return out.sort((a, b) => b.mtime - a.mtime);
  }

  function saveFile(projectId, { name, text, contentBase64 } = {}, version) {
    const dir = ensureDir(projectId, version);
    const safeName = sanitizeFileName(name);
    const dest = path.join(dir, safeName);
    if (contentBase64 != null && contentBase64 !== '') {
      const cleanB64 = String(contentBase64).replace(/^data:[^;]+;base64,/, '');
      const buf = Buffer.from(cleanB64, 'base64');
      if (buf.length > 25 * 1024 * 1024) throw new Error('파일 크기는 25MB를 초과할 수 없습니다.');
      fs.writeFileSync(dest, buf);
    } else {
      fs.writeFileSync(dest, String(text ?? ''), 'utf8');
    }
    const st = fs.statSync(dest);
    const ext = path.extname(safeName).toLowerCase();
    return {
      name: safeName,
      size: st.size,
      mtime: st.mtimeMs,
      ext,
      isImage: IMAGE_EXTS.has(ext),
      path: dest,
    };
  }

  function readFile(projectId, name, version) {
    const dir = dirOf(projectId, version);
    const safeName = sanitizeFileName(name);
    const full = path.join(dir, safeName);
    if (!fs.existsSync(full)) return null;
    const ext = path.extname(safeName).toLowerCase();
    return {
      name: safeName,
      mime: MIME_BY_EXT[ext] || 'application/octet-stream',
      buf: fs.readFileSync(full),
      path: full,
    };
  }

  function deleteFile(projectId, name, version) {
    const dir = dirOf(projectId, version);
    const safeName = sanitizeFileName(name);
    const full = path.join(dir, safeName);
    if (fs.existsSync(full)) fs.unlinkSync(full);
    return list(projectId, version);
  }

  function promptBlock(projectId, version) {
    const dir = ensureDir(projectId, version);
    const files = list(projectId, version);
    const fileLines = files.length
      ? files.slice(0, 25).map((f) => `- ${f.name} (${f.isImage ? '이미지' : '파일'}, ${f.size}B)`).join('\n')
      : '- (현재 저장된 참조 파일 없음)';
    return [
      '[프로젝트 참조 데이터 저장소]',
      `저장소 경로: "${dir}"`,
      '현재 저장된 참조 파일:',
      fileLines,
      '사용 지침:',
      '- 작업에 필요한 레퍼런스 문서·이미지·데이터가 필요할 때마다 위 저장소 경로에서 직접 읽어 작업에 반영하세요.',
      '- 다른 태스크나 후속 AI 작업으로 넘길 중간 산출물·분석 결과·데이터가 있으면 위 저장소 경로에 명확한 파일명으로 저장해 공유하세요.',
    ].join('\n');
  }

  return { dirOf, ensureDir, list, saveFile, readFile, deleteFile, promptBlock };
}

module.exports = { createProjectRefsStore };
