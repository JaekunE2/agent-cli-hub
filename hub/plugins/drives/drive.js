// GX10 drive in the dashboard: browse / upload / download / folders / move / delete, "세션에 보내기"
// (file → this PC's drive-cache → its path typed into a session), and a picker the terminal input
// bar uses to mention a drive file. Talks to /api/netdrive/* (proxied to the GX10 drive server).
'use strict';
const DRIVE = { cwd: '', q: '' };
const dApi = (op, qs = {}, body, id = 'gx10') => api(`/api/netdrive/${op}?${new URLSearchParams({ ...qs, ...(id !== 'gx10' ? { d: id } : {}) })}`, body ? { method: 'POST', body } : {});
// drives: the GX10 drive (config driveUrl, through a tunnel) + config "drives" from the overview (e.g. nas = team share Z:, files local to this PC)
const driveList = () => [...(state.drive !== false ? [{ id: 'gx10', label: 'GX10 드라이브', local: null }] : []), ...(state.drives || [])];
const driveById = (id) => driveList().find((d) => d.id === (id || 'gx10')) || { id: 'gx10', label: 'GX10 드라이브', local: null };
const driveLocal = (d, rel) => d.local.replace(/[\\/]+$/, '') + '\\' + rel.replace(/\//g, '\\');
const dUrl = (rel, dl) => `/api/netdrive/file?path=${encodeURIComponent(rel)}${dl ? '&dl=1' : ''}&t=${encodeURIComponent(TOKEN)}`;
const dJoin = (a, b) => (a ? a + '/' : '') + b;
const dIcon = (e) => e.dir ? '📁' : /\.(png|jpe?g|gif|webp|svg)$/i.test(e.name) ? '🖼' : /\.(mp4|webm|mov)$/i.test(e.name) ? '🎬' : /\.pdf$/i.test(e.name) ? '📕' : /\.(zip|7z|tar|gz)$/i.test(e.name) ? '🗜' : '📄';
const dSize = (n) => n == null ? '' : fmtSize(n);

function driveSideHTML() {
  return `<div class="sec">${state.drive !== false ? itemHTML({ key: 'drive', title: '📁 GX10 드라이브', sub: 'PC·폰에서 올리고 받기 · 세션에 파일 보내기' }) : ''}${(state.drives || []).map((d) => itemHTML({ key: `drive:${d.id}`, title: `🗄 ${d.label}`, sub: d.sub || '' })).join('')}</div>`;
}

// the dashboard embeds the drive server's own page (same UI as the phone app, PC layout on wide screens)
function viewDrive() {
  const id = state.sel.id || 'gx10', dv = driveById(id), gen = viewGen;
  const src = `/drive${id === 'gx10' ? '' : '-' + id}/${encodeURIComponent(TOKEN)}/?host=ccd`;
  setBar(`<h2>${id === 'gx10' ? '📁' : '🗄'} ${esc(dv.label)}</h2><span id="dvSt" class="empty"></span><span class="sp"></span>${dv.local ? `<button id="dvRe" title="드라이브 문자 연결(net use)과 드라이브 서버를 확인하고 필요하면 다시 연결">다시 연결</button>` : ''}<a class="btnlike" href="${src}" target="_blank" rel="noopener" title="새 탭에서 크게">새 탭</a>`);
  $('#bar').onclick = async (e) => {
    if (e.target.id !== 'dvRe') return;
    e.target.disabled = true;
    const r = await api('/api/drive-reconnect', { method: 'POST', body: { id } }).catch((er) => ({ error: er.message }));
    toast(r.error || (r.steps?.length ? r.steps.join(' · ') : '이미 연결되어 있습니다'), 6000);
    setTimeout(() => { if (gen === viewGen) viewDrive(); }, r.steps?.length ? 2500 : 0);
  };
  const v = $('#view');
  v.onclick = null; v.ondragover = v.ondragleave = v.ondrop = null;
  v.innerHTML = `<iframe src="${src}" title="${esc(dv.label)}" style="width:100%;height:100%;border:0;display:block;background:transparent"></iframe>`;
  // connection status for share drives: drive letter + drive server
  if (dv.local) api('/api/drives').then((r) => {
    if (gen !== viewGen) return;
    const s = (r.drives || []).find((x) => x.id === id), el = $('#dvSt');
    if (!s || !el) return;
    el.textContent = !s.server ? '⚠ 드라이브 서버 꺼짐 — 다시 연결을 누르세요' : s.letter === false ? `⚠ ${dv.local.slice(0, 2)} 문자 연결 끊김 (세션 경로가 안 열릴 수 있음) — 다시 연결` : `연결됨${s.free != null ? ` · 남은 공간 ${fmtSize(s.free)}` : ''}`;
  }).catch(() => {});
}
// "세션에 보내기" from the embedded drive page (the drive is the one on screen)
window.addEventListener('message', (e) => {
  if (e.origin === location.origin && e.data && e.data.ccdDrive === 'send' && typeof e.data.path === 'string') sendDriveFileDialog(e.data.path, state.sel.kind === 'drive' ? state.sel.id || 'gx10' : 'gx10');
});

async function paintDrive() {
  const v = $('#view');
  const parts = DRIVE.cwd ? DRIVE.cwd.split('/') : [];
  let acc = '', crumb = '<button class="linkbtn" data-dgo="">드라이브</button>';
  for (const p of parts) { acc = dJoin(acc, p); crumb += ` / <button class="linkbtn" data-dgo="${esc(acc)}">${esc(p)}</button>`; }
  let d;
  try {
    d = DRIVE.q ? await dApi('search', { q: DRIVE.q, path: DRIVE.cwd }) : await dApi('list', { path: DRIVE.cwd });
  } catch (er) { v.innerHTML = `<div class="err">${esc(er.message)}</div>`; return; }
  if (state.sel.kind !== 'drive') return;
  const ents = DRIVE.q ? d.entries.map((e) => ({ ...e, name: e.path, full: e.path })) : d.entries.map((e) => ({ ...e, full: dJoin(DRIVE.cwd, e.name) }));
  const info = await dApi('info').catch(() => null);
  v.innerHTML = `<div class="rwrap"><div class="rcard"><div class="row" style="gap:4px;flex-wrap:wrap">${crumb}${DRIVE.q ? ` <span class="empty">· “${esc(DRIVE.q)}” 검색 결과</span>` : ''}</div>
    ${ents.length ? ents.map((e) => `<div class="ofile drow" data-p="${esc(e.full)}" data-dir="${e.dir ? 1 : ''}">
        <span style="min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><span data-dopen="1" style="cursor:pointer">${dIcon(e)} ${esc(e.name)}</span></span>
        <span class="empty" style="padding:0 6px;white-space:nowrap">${e.dir ? '' : dSize(e.size)} · ${relTime(e.mtime)}</span>
        <span class="row" style="gap:4px;flex:none">${e.dir ? '' : `<a class="btnlike" href="${dUrl(e.full, true)}" download>받기</a><button data-dact="send" title="이 파일을 PC로 받아 그 경로를 세션 입력칸에 넣습니다">세션에 보내기</button>`}<button data-dact="mv">이름·이동</button><button data-dact="rm">삭제</button></span></div>`).join('')
      : `<div class="empty" style="padding:16px">${DRIVE.q ? '검색 결과 없음' : '빈 폴더 — 올리기 버튼이나 파일을 끌어 놓아 올리세요'}</div>`}
    </div><div class="empty" style="padding:4px 2px">에이전트: <span class="mono">ccd drive</span>${info?.free != null ? ` · 남은 공간 ${fmtSize(info.free)}` : ''}</div></div>`;
}

async function driveClick(e) {
  const go = e.target.closest('[data-dgo]');
  if (go) { DRIVE.cwd = go.dataset.dgo; DRIVE.q = ''; const q = $('#dQ'); if (q) q.value = ''; return paintDrive(); }
  const row = e.target.closest('.drow'); if (!row) return;
  const p = row.dataset.p;
  if (e.target.closest('[data-dopen]')) {
    if (row.dataset.dir) { DRIVE.cwd = p; DRIVE.q = ''; const q = $('#dQ'); if (q) q.value = ''; return paintDrive(); }
    return void window.open(dUrl(p), '_blank');
  }
  const act = e.target.closest('[data-dact]')?.dataset.dact;
  try {
    if (act === 'rm' && confirm(`${p} 을(를) 휴지통으로 옮길까요? (드라이브 웹의 🗑에서 복원)`)) { await dApi('delete', {}, { path: p }); paintDrive(); }
    if (act === 'mv') { const to = prompt('새 이름 또는 옮길 경로 (드라이브 기준, 폴더면 그 안으로)', p); if (to && to !== p) { await dApi('move', {}, { from: p, to }); paintDrive(); } }
    if (act === 'send') sendDriveFileDialog(p);
  } catch (er) { toast(er.message, 6000); }
}

function driveUpload(files) {
  files = [...files]; if (!files.length) return;
  let i = 0;
  const n = toast('', 600_000);
  const next = () => {
    if (i >= files.length) { n.remove(); toast(`${files.length}개 올림`); return state.sel.kind === 'drive' && paintDrive(); }
    const f = files[i++];
    const target = dJoin(DRIVE.cwd, f.name);
    const put = (overwrite) => {
      const x = new XMLHttpRequest();
      x.open('PUT', `/api/netdrive/file?path=${encodeURIComponent(target)}${overwrite ? '&overwrite=1' : ''}`);
      x.setRequestHeader('x-token', TOKEN);
      x.upload.onprogress = (ev) => { n.textContent = `올리는 중 ${i}/${files.length} ${f.name} — ${fmtSize(ev.loaded)} / ${fmtSize(f.size)}`; };
      x.onload = () => {
        if (x.status === 409 && !overwrite) { if (confirm(`${f.name} 이(가) 이미 있습니다. 덮어쓸까요?`)) return put(true); return next(); }
        if (x.status >= 300) toast(`${f.name}: 올리기 실패 (${x.status})`, 6000);
        next();
      };
      x.onerror = () => { toast(`${f.name}: 연결 오류`, 6000); next(); };
      x.send(f);
    };
    put(false);
  };
  next();
}

// A drive file goes to a session as a drive path (drive:"folder/file"), not as a download: the session
// reads text straight from the drive (ccd drive cat) and downloads only what it has to open locally
// (PDF, images …). How is in the gx10-drive skill; the mention only points to it (once per message).
const DRIVE_HINT = ' (gx10-drive 스킬로 불러오기)';
function driveRef(rel) { return 'drive:' + (/[\s"']/.test(rel) ? `"${rel.replace(/"/g, '\\"')}"` : rel); }
function driveMention(rel, existing) { return driveRef(rel) + (/gx10-drive/.test(existing || '') ? '' : DRIVE_HINT); }
// a drive whose files are on this PC (team share Z:) is mentioned by its plain path — sessions open it directly
function driveMentionFor(rel, id, existing) { const dv = driveById(id); return dv.local ? quotePath(driveLocal(dv, rel)) : driveMention(rel, existing); }

async function sendDriveFileDialog(rel, id = 'gx10') {
  const dv = driveById(id);
  const targets = state.terms.filter((t) => t.exited === null).map((t) => ({ id: t.id, label: termLabel(t) }));
  const d = document.createElement('div');
  d.className = 'dlg';
  d.innerHTML = `<div class="box"><h3>세션에 보내기</h3>
    <div class="mono" style="word-break:break-all">${esc(dv.local ? driveLocal(dv, rel) : rel)}</div>
    <label>보낼 세션<br><select id="sT" style="width:100%">${targets.map((t) => `<option value="${esc(t.id)}">t:${esc(t.id)} ${esc(t.label)}</option>`).join('')}</select></label>
    <label>함께 보낼 말 (비우면 경로만 입력칸에 넣고 전송하지 않음)<br><textarea id="sM" rows="3" style="width:100%" placeholder="예: 이 파일 분석해서 요약해줘"></textarea></label>
    ${dv.local ? `<div class="empty" style="padding:0">${esc(dv.label)}는 이 PC에 연결된 드라이브라 경로를 그대로 보냅니다 (복사 없음).</div>` : `<label class="row" style="gap:6px;align-items:center"><input type="checkbox" id="sF"> PC로 미리 받아서 로컬 경로로 보내기</label>
    <div class="empty" style="padding:0">기본은 드라이브 경로(drive:…)만 보냅니다. 세션이 필요할 때 바로 읽거나 받습니다.</div>`}
    <div class="row" style="justify-content:flex-end"><button id="sC">취소</button><button class="primary" id="sOk">보내기</button></div></div>`;
  document.body.appendChild(d);
  if (!targets.length) { $('#sOk', d).disabled = true; $('#sT', d).outerHTML = '<div class="empty">열려 있는 대시보드 터미널이 없습니다</div>'; }
  $('#sC', d).onclick = () => d.remove();
  $('#sOk', d).onclick = async () => {
    $('#sOk', d).disabled = true;
    let ref = driveMentionFor(rel, id);
    if (!dv.local && $('#sF', d).checked) {
      const f = await api('/api/drive-fetch', { method: 'POST', body: { path: rel } });
      if (f.error) { $('#sOk', d).disabled = false; return toast(f.error, 6000); }
      ref = quotePath(f.local);
    }
    const msg = $('#sM', d).value.trim();
    const text = (msg ? msg + ' ' : '') + ref + (msg ? '' : ' ');
    const r = await api('/api/term/send', { method: 'POST', body: { id: $('#sT', d).value, text, submit: !!msg } });
    d.remove();
    toast(r.error ? r.error : msg ? '세션에 보냈습니다' : '드라이브 경로를 세션 입력칸에 넣었습니다');
  };
}

// picker for the terminal input bar: choose a drive file → onPath(its drive path); nothing is downloaded
function pickDriveFile(onPath) {
  let cwd = '';
  const drives = driveList();
  let id = (drives[0] || { id: 'gx10' }).id;
  const d = document.createElement('div');
  d.className = 'dlg';
  d.innerHTML = `<div class="box wide"><h3>📁 드라이브에서 첨부</h3>${drives.length > 1 ? `<select id="pkD">${drives.map((x) => `<option value="${esc(x.id)}">${esc(x.label)}</option>`).join('')}</select>` : ''}<div id="pkB">불러오는 중…</div><div class="row" style="justify-content:flex-end"><button id="pkC">닫기</button></div></div>`;
  document.body.appendChild(d);
  $('#pkC', d).onclick = () => d.remove();
  const sel = $('#pkD', d);
  if (sel) sel.onchange = () => { id = sel.value; cwd = ''; paint(); };
  const paint = async () => {
    let r; try { r = await dApi('list', { path: cwd }, null, id); } catch (er) { $('#pkB', d).innerHTML = `<div class="err">${esc(er.message)}</div>`; return; }
    $('#pkB', d).innerHTML = `<div class="row" style="gap:4px;flex-wrap:wrap"><button class="linkbtn" data-pk="">드라이브</button>${cwd ? cwd.split('/').map((p, i, a) => ` / <button class="linkbtn" data-pk="${esc(a.slice(0, i + 1).join('/'))}">${esc(p)}</button>`).join('') : ''}</div>
      <div style="max-height:55vh;overflow:auto">${r.entries.map((e) => `<div class="ofile" data-pe="${esc(dJoin(cwd, e.name))}" data-dir="${e.dir ? 1 : ''}" style="cursor:pointer"><span>${dIcon(e)} ${esc(e.name)}</span><span class="empty">${e.dir ? '' : dSize(e.size)}</span></div>`).join('') || '<div class="empty">빈 폴더</div>'}</div>`;
  };
  d.onclick = async (e) => {
    const c = e.target.closest('[data-pk]'); if (c) { cwd = c.dataset.pk; return paint(); }
    const it = e.target.closest('[data-pe]'); if (!it) return;
    if (it.dataset.dir) { cwd = it.dataset.pe; return paint(); }
    d.remove();
    onPath(it.dataset.pe, id);
  };
  paint();
}
