'use strict';

// Manual Google Drive upload for user-selected session artifacts.
// Reuses data/secrets/google-oauth-client.json (same OAuth Desktop client as Google Calendar)
// with the minimal `https://www.googleapis.com/auth/drive.file` scope.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const SENSITIVE_RE = /(?:^|[\\/])(?:\.token|\.env(?:\.[^\\/]+)?|secrets|id_rsa[^\\/]*|[^\\/]+\.(?:key|pem|pfx|p12))$/i;

const MIME_MAP = {
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.zip': 'application/zip',
};

function createDriveSync({ baseDir, port, config = {} }) {
  const SECRETS = path.join(baseDir, 'data', 'secrets');
  const CLIENT = path.join(SECRETS, 'google-oauth-client.json');
  const TOKEN = path.join(SECRETS, 'gdrive-token.json');
  const SYNC_FILE = path.join(baseDir, 'data', 'drive-sync.json');
  const REDIRECT = `http://127.0.0.1:${port}/api/drive/google/callback`;
  const ACCOUNT = config.googleAccount || '';

  const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
  const writeJson = (f, o) => {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(o, null, 2));
    fs.renameSync(tmp, f);
  };

  let gState = readJson(TOKEN, null);
  let oauthNonce = null;

  const client = () => {
    const j = readJson(CLIENT, null);
    const c = j && (j.installed || j.web);
    return c && c.client_id ? c : null;
  };

  async function accessToken() {
    if (!gState?.refresh_token) {
      const err = new Error('Google Drive가 연결되지 않았습니다.');
      err.code = 'NOT_CONNECTED';
      throw err;
    }
    if (gState.access_token && gState.expires_at > Date.now() + 60e3) return gState.access_token;
    const c = client();
    if (!c) {
      const err = new Error(`OAuth 클라이언트 파일이 없습니다: ${CLIENT}`);
      err.code = 'NOT_CONFIGURED';
      throw err;
    }
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: c.client_id,
        client_secret: c.client_secret || '',
        refresh_token: gState.refresh_token,
        grant_type: 'refresh_token',
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`토큰 갱신 실패: ${j.error_description || j.error || r.status}`);
    gState = { ...gState, access_token: j.access_token, expires_at: Date.now() + j.expires_in * 1000 };
    writeJson(TOKEN, gState);
    return gState.access_token;
  }

  async function driveJson(url, opts = {}) {
    const tok = await accessToken();
    const r = await fetch(url, {
      ...opts,
      headers: { authorization: `Bearer ${tok}`, ...(opts.headers || {}) },
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const err = new Error(j.error?.message || `Google Drive HTTP ${r.status}`);
      err.status = r.status;
      throw err;
    }
    return j;
  }

  async function ensureFolder(name, parentId = null) {
    const escaped = String(name).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const qParts = [
      `name = '${escaped}'`,
      `mimeType = 'application/vnd.google-apps.folder'`,
      `trashed = false`,
    ];
    if (parentId) qParts.push(`'${parentId}' in parents`);
    const q = encodeURIComponent(qParts.join(' and '));
    const found = await driveJson(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&pageSize=1`);
    if (found.files?.[0]?.id) return found.files[0].id;
    const created = await driveJson('https://www.googleapis.com/drive/v3/files?fields=id,name', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name,
        mimeType: 'application/vnd.google-apps.folder',
        ...(parentId ? { parents: [parentId] } : {}),
      }),
    });
    return created.id;
  }

  async function ensureRootFolder() {
    if (gState?.rootFolderId) {
      try {
        const check = await driveJson(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(gState.rootFolderId)}?fields=id,trashed`);
        if (check?.id && !check.trashed) return check.id;
      } catch {}
    }
    const id = await ensureFolder('Agent CLI Hub');
    gState = { ...gState, rootFolderId: id };
    writeJson(TOKEN, gState);
    return id;
  }

  async function uploadBuffer({ fileId, name, mime, buf, parentId }) {
    const tok = await accessToken();
    const meta = fileId ? { name } : { name, ...(parentId ? { parents: [parentId] } : {}) };
    if (buf.length <= 5 * 1024 * 1024) {
      const boundary = `ach_${crypto.randomBytes(12).toString('hex')}`;
      const head = Buffer.from(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`,
        'utf8',
      );
      const tail = Buffer.from(`\r\n--${boundary}--`, 'utf8');
      const body = Buffer.concat([head, buf, tail]);
      const url = fileId
        ? `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=multipart&fields=id,name,webViewLink`
        : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink`;
      const r = await fetch(url, {
        method: fileId ? 'PATCH' : 'POST',
        headers: {
          authorization: `Bearer ${tok}`,
          'content-type': `multipart/related; boundary=${boundary}`,
        },
        body,
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        const err = new Error(j.error?.message || `Drive 업로드 실패 (${r.status})`);
        err.status = r.status;
        throw err;
      }
      return j;
    }
    const initUrl = fileId
      ? `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=resumable&fields=id,name,webViewLink`
      : `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,webViewLink`;
    const init = await fetch(initUrl, {
      method: fileId ? 'PATCH' : 'POST',
      headers: {
        authorization: `Bearer ${tok}`,
        'content-type': 'application/json; charset=UTF-8',
        'x-upload-content-type': mime,
        'x-upload-content-length': String(buf.length),
      },
      body: JSON.stringify(meta),
    });
    const sessionUri = init.headers.get('location');
    if (!init.ok || !sessionUri) throw new Error(`Drive 대용량 업로드 세션 시작 실패 (${init.status})`);
    const put = await fetch(sessionUri, {
      method: 'PUT',
      headers: { 'content-type': mime, 'content-length': String(buf.length) },
      body: buf,
    });
    const j = await put.json().catch(() => ({}));
    if (!put.ok) {
      const err = new Error(j.error?.message || `Drive 업로드 실패 (${put.status})`);
      err.status = put.status;
      throw err;
    }
    return j;
  }

  async function uploadArtifact({ filePath, folderName = '', title = '' }) {
    const abs = path.resolve(String(filePath || ''));
    if (!abs || !fs.existsSync(abs)) throw new Error('업로드할 파일을 찾을 수 없습니다.');
    const st = fs.statSync(abs);
    if (!st.isFile()) throw new Error('파일만 업로드할 수 있습니다.');
    if (SENSITIVE_RE.test(abs)) throw new Error('보안상 민감 파일(.token, .env, 키 파일)은 Drive에 업로드할 수 없습니다.');

    const rootId = await ensureRootFolder();
    const cleanFolder = String(folderName || '').replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 80);
    const parentId = cleanFolder ? await ensureFolder(cleanFolder, rootId) : rootId;
    const ext = path.extname(abs).toLowerCase();
    const mime = MIME_MAP[ext] || 'application/octet-stream';
    const name = String(title || '').trim() || path.basename(abs);
    const buf = fs.readFileSync(abs);

    const syncMap = readJson(SYNC_FILE, {});
    const prev = syncMap[abs];
    let uploaded;
    let updated = false;
    if (prev?.fileId) {
      try {
        uploaded = await uploadBuffer({ fileId: prev.fileId, name, mime, buf, parentId });
        updated = true;
      } catch (e) {
        if (e.status !== 404) throw e;
      }
    }
    if (!uploaded) {
      uploaded = await uploadBuffer({ fileId: null, name, mime, buf, parentId });
    }
    syncMap[abs] = {
      fileId: uploaded.id,
      name: uploaded.name || name,
      webViewLink: uploaded.webViewLink || null,
      folderName: cleanFolder || 'Agent CLI Hub',
      size: st.size,
      mtimeMs: st.mtimeMs,
      uploadedAt: new Date().toISOString(),
    };
    writeJson(SYNC_FILE, syncMap);
    return { ok: true, updated, ...syncMap[abs] };
  }

  async function oauthCallback(url, res) {
    const html = (code, msg) => {
      res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta charset="utf-8"><body style="font:16px system-ui;padding:40px;background:#17171a;color:#ecebe6">${msg}<p><a style="color:#e0825f" href="/">대시보드로 돌아가기</a></p></body>`);
    };
    if (!oauthNonce || url.searchParams.get('state') !== oauthNonce) {
      return html(400, '잘못된 요청입니다 (연결을 대시보드에서 다시 시작하세요).');
    }
    oauthNonce = null;
    if (url.searchParams.get('error')) return html(400, `Google Drive 연결이 취소되었습니다: ${url.searchParams.get('error')}`);
    const c = client();
    if (!c) return html(400, `OAuth 클라이언트 파일이 없습니다: ${CLIENT}`);
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: url.searchParams.get('code') || '',
        client_id: c.client_id,
        client_secret: c.client_secret || '',
        redirect_uri: REDIRECT,
        grant_type: 'authorization_code',
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.refresh_token) return html(400, `토큰을 받지 못했습니다: ${j.error_description || j.error || r.status}`);
    gState = {
      refresh_token: j.refresh_token,
      access_token: j.access_token,
      expires_at: Date.now() + j.expires_in * 1000,
      connectedAt: new Date().toISOString(),
    };
    try {
      const about = await driveJson('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)');
      gState.account = about?.user?.emailAddress || null;
    } catch {}
    writeJson(TOKEN, gState);
    return html(200, `✔ Google Drive 연결됨 (${gState.account || ''})<br>이제 산출물 탭에서 원하는 파일을 선택해 Drive로 업로드할 수 있습니다.`);
  }

  async function handle(p, url, req, getBody, send) {
    if (p === '/api/drive/status' && req.method === 'GET') {
      return send(200, {
        configured: !!client(),
        connected: !!gState?.refresh_token,
        account: gState?.account || null,
        rootFolderId: gState?.rootFolderId || null,
        clientPath: CLIENT,
      });
    }
    if (p === '/api/drive/auth') {
      const c = client();
      if (!c) return send(400, { error: `OAuth 클라이언트 파일이 없습니다: ${CLIENT}`, code: 'NOT_CONFIGURED' });
      oauthNonce = crypto.randomBytes(16).toString('hex');
      const q = new URLSearchParams({
        client_id: c.client_id,
        redirect_uri: REDIRECT,
        response_type: 'code',
        scope: DRIVE_SCOPE,
        access_type: 'offline',
        prompt: 'consent',
        state: oauthNonce,
        ...(ACCOUNT ? { login_hint: ACCOUNT } : {}),
      });
      return send(200, { url: 'https://accounts.google.com/o/oauth2/v2/auth?' + q });
    }
    if (p === '/api/drive/disconnect' && req.method === 'POST') {
      gState = null;
      try { fs.unlinkSync(TOKEN); } catch {}
      return send(200, { ok: true });
    }
    if (p === '/api/drive/upload' && req.method === 'POST') {
      const b = await getBody();
      try {
        const res = await uploadArtifact({ filePath: b.path, folderName: b.folderName, title: b.title });
        return send(200, res);
      } catch (e) {
        return send(e.code === 'NOT_CONNECTED' ? 401 : e.code === 'NOT_CONFIGURED' ? 400 : 500, {
          error: e.message,
          code: e.code || 'UPLOAD_FAILED',
        });
      }
    }
    return false;
  }

  return { handle, oauthCallback, uploadArtifact };
}

module.exports = { createDriveSync };
