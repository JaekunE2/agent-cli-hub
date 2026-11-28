// ---------- Side-channel Live Tool Stream & Session Traces Inspector ----------
(function () {
  const streams = new Set();
  function foldClientEvents(events) {
    const out = [];
    for (const ev of events || []) {
      if (!ev || !ev.tool) continue;
      const prev = out[out.length - 1];
      const same = prev
        && prev.tool === ev.tool
        && (prev.target || '') === (ev.target || '')
        && (prev.subagentId || '') === (ev.subagentId || '');
      if (same) {
        if (prev.status === 'start' && ev.status !== 'start') {
          prev.status = ev.status;
          prev.ts = ev.ts;
          continue;
        }
        prev.count = (prev.count || 1) + (ev.count || 1);
        prev.ts = ev.ts;
        prev.status = ev.status || prev.status;
        continue;
      }
      out.push({ ...ev, count: ev.count || 1 });
    }
    return out;
  }

  function shortTarget(target) {
    if (!target) return '';
    const s = String(target).trim();
    if (s.includes('\\') || s.includes('/')) {
      const parts = s.split(/[\\/]/).filter(Boolean);
      if (parts.length > 2) return '…/' + parts.slice(-2).join('/');
    }
    return s.length > 36 ? s.slice(0, 35) + '…' : s;
  }

  function formatBytes(n) {
    const v = Number(n) || 0;
    if (v < 1024) return `${v}B`;
    if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)}KB`;
    return `${(v / (1024 * 1024)).toFixed(1)}MB`;
  }

  async function openTracesDrawer({ termId = '', sessionId = '', cwd = '' } = {}) {
    const existing = $('.traces-dialog');
    if (existing) existing.close();
    const d = document.createElement('dialog');
    d.className = 'pj-dialog traces-dialog';
    d.style.width = 'min(760px, calc(100vw - 24px))';
    d.setAttribute('aria-label', '세션 Traces · 컨텍스트 인스펙터');
    d.innerHTML = `<div class="traces-dlg-wrap">
      <div class="dlg-head">
        <h3>${ICO.layers || ''} 세션 Traces · 컨텍스트 인스펙터</h3>
        <button type="button" class="ghost icon-btn btn-sm" data-tr-close aria-label="닫기">${ICO.close}</button>
      </div>
      <div class="traces-body" id="tracesBody"><div class="empty">세션 트레이스를 수집하는 중…</div></div>
    </div>`;
    document.body.append(d);
    d.onclose = () => d.remove();
    d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
    $('[data-tr-close]', d).onclick = () => d.close();
    d.showModal();

    const bodyEl = $('#tracesBody', d);
    try {
      const qs = new URLSearchParams({
        ...(termId ? { termId } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(cwd ? { cwd } : {}),
      });
      const [tr, snip] = await Promise.all([
        api(`/api/session/traces?${qs}`),
        api('/api/hooks/snippet').catch(() => ({ ok: false })),
      ]);
      if (!d.isConnected) return;

      const sec = (title, count, html) => `<section class="tr-sec">
        <div class="tr-sec-hd"><span>${esc(title)}</span><span class="badge">${count}</span></div>
        ${html}
      </section>`;

      const instHtml = tr.instructions?.length
        ? `<div class="tr-list">${tr.instructions.map((f) => `<div class="tr-row">
            <span class="badge">${esc(f.scope)}</span>
            <code class="tr-path" title="${esc(f.path)}">${esc(f.path)}</code>
            <span class="ums">${formatBytes(f.size)}</span>
          </div>`).join('')}</div>`
        : '<div class="ums">감지된 지침 파일이 없습니다.</div>';

      const filesHtml = tr.visitedFiles?.length
        ? `<div class="tr-list">${tr.visitedFiles.map((f) => `<div class="tr-row">
            <code class="tr-path" title="${esc(f.path)}">${esc(f.path)}</code>
            <span class="tr-badges">
              ${f.reads ? `<span class="badge">읽기 ${f.reads}</span>` : ''}
              ${f.edits ? `<span class="badge c">수정 ${f.edits}</span>` : ''}
            </span>
          </div>`).join('')}</div>`
        : '<div class="ums">아직 기록된 파일 접근 이력이 없습니다.</div>';

      const subHtml = tr.subagents?.length
        ? `<div class="tr-list">${tr.subagents.map((s) => `<div class="tr-row">
            <span class="badge">${esc(s.tool)}</span>
            <span class="tr-desc">${esc(s.description || s.id)}</span>
            <span class="ums">${esc(s.status || 'done')}</span>
          </div>`).join('')}</div>`
        : '<div class="ums">호출된 서브에이전트가 없습니다.</div>';

      const imgHtml = tr.images?.length
        ? `<div class="tr-list">${tr.images.map((im) => `<div class="tr-row">
            <span class="badge">image</span>
            <code class="tr-path">${esc(im.path || im.mediaType || '첨부 이미지')}</code>
          </div>`).join('')}</div>`
        : '<div class="ums">첨부된 이미지가 없습니다.</div>';

      const planArtCount = (tr.plans?.length || 0) + (tr.artifacts?.length || 0);
      const planArtHtml = planArtCount
        ? `<div class="tr-list">
            ${(tr.plans || []).map((p) => `<div class="tr-row"><span class="badge">Project</span><span>${esc(p.name)}</span><span class="ums">${p.done}/${p.total} 완료</span></div>`).join('')}
            ${(tr.artifacts || []).map((a) => `<div class="tr-row"><span class="badge">산출물</span><code class="tr-path">${esc(a.path || a.title || a.id)}</code></div>`).join('')}
          </div>`
        : '<div class="ums">연결된 플랜이나 산출물이 없습니다.</div>';

      const hookHtml = `<div class="tr-hook-box">
        <div class="row" style="justify-content:space-between;gap:8px;flex-wrap:wrap">
          <div>
            <b>Tool Hook 사이드 채널</b>
            <span class="ums" style="margin-left:8px">소스: ${esc(tr.source || 'none')} · 이벤트 ${tr.hookCount || 0}건</span>
          </div>
          <div class="row" style="gap:6px">
            <button type="button" class="btn-sm primary" id="trInstallClaudeHook">Claude Hook 자동 연결</button>
          </div>
        </div>
        ${snip?.command ? `<pre class="tr-code">${esc(JSON.stringify(snip.claudeSettings, null, 2))}</pre>` : ''}
      </div>`;

      bodyEl.innerHTML = [
        sec('지침 파일 (Instructions)', tr.instructions?.length || 0, instHtml),
        sec('방문 · 수정 파일 (Visited Files)', tr.visitedFiles?.length || 0, filesHtml),
        sec('서브에이전트 (Sub-agents)', tr.subagents?.length || 0, subHtml),
        sec('플랜 · 산출물 (Plans & Artifacts)', planArtCount, planArtHtml),
        sec('이미지 (Images)', tr.images?.length || 0, imgHtml),
        hookHtml,
      ].join('');

      $('#trInstallClaudeHook', bodyEl)?.addEventListener('click', async (ev) => {
        const btn = ev.currentTarget;
        btn.disabled = true;
        try {
          const r = await api('/api/hooks/install-claude', { method: 'POST', body: {} });
          if (r?.error) throw new Error(r.error);
          toast(`Claude Code Tool Hook을 연결했습니다 (${r.path})`);
        } catch (err) {
          toast(err.message, 5000, 'danger');
        } finally {
          btn.disabled = false;
        }
      });
    } catch (e) {
      if (bodyEl.isConnected) bodyEl.innerHTML = `<div class="err">${esc(e.message)}</div>`;
    }
  }

  function mountToolStreamBar(hostEl, { termId = '', sessionId = '', cwd = '', gen = 0 } = {}) {
    if (!hostEl) return null;
    if (!termId && !sessionId) {
      hostEl.innerHTML = '';
      hostEl.hidden = true;
      return null;
    }
    hostEl.hidden = true;
    hostEl.innerHTML = `<div class="tool-stream-bar" data-ts-bar>
      <div class="ts-left">
        <button type="button" class="ts-pill idle" data-ts-status title="최근 툴 호출 목록 펼치기/접기"></button>
        <div class="ts-beats" data-ts-beats></div>
      </div>
      <div class="ts-right">
        <button type="button" class="ghost btn-sm ts-btn" data-ts-expand title="최근 툴 호출 목록 펼치기/접기" hidden>목록</button>
      </div>
      <div class="ts-drawer" data-ts-drawer hidden></div>
    </div>`;

    const statusEl = $('[data-ts-status]', hostEl);
    const beatsEl = $('[data-ts-beats]', hostEl);
    const expandBtn = $('[data-ts-expand]', hostEl);
    const drawerEl = $('[data-ts-drawer]', hostEl);

    let events = [];
    let expanded = false;
    let visibleAllowed = true;
    let ws = null;
    let closed = false;
    const request = new AbortController();

    const syncVisibility = (hasEvents) => {
      hostEl.hidden = !(visibleAllowed && hasEvents);
    };

    const render = () => {
      if (!hostEl.isConnected || (gen && gen !== viewGen)) {
        cleanup();
        return;
      }
      const folded = foldClientEvents(events);
      const latest = folded[folded.length - 1];
      const barEl = $('[data-ts-bar]', hostEl);
      if (!folded.length) {
        barEl?.classList.add('is-empty');
        statusEl.textContent = '';
        beatsEl.innerHTML = '';
        expandBtn.hidden = true;
        drawerEl.hidden = true;
        syncVisibility(false);
        return;
      }
      barEl?.classList.remove('is-empty');
      syncVisibility(true);

      if (latest && latest.status === 'start') {
        statusEl.className = 'ts-pill busy';
        statusEl.innerHTML = `<span class="dot busy" style="width:6px;height:6px"></span> ${esc(latest.tool)}`;
      } else if (latest) {
        statusEl.className = 'ts-pill active';
        statusEl.textContent = `${latest.tool}${latest.count > 1 ? ` ×${latest.count}` : ''}`;
      }

      expandBtn.hidden = false;
      expandBtn.textContent = expanded ? '접기' : `목록 (${folded.length})`;

      const recent = folded.slice(-10);
      beatsEl.innerHTML = recent.map((ev) => {
        const tgt = shortTarget(ev.target);
        const cls = ev.status === 'error' ? ' err' : ev.status === 'start' ? ' run' : '';
        return `<span class="ts-beat${cls}" title="${esc([ev.tool, ev.target, ev.subagentId ? `sub:${ev.subagentId}` : ''].filter(Boolean).join(' · '))}">
          ${ev.subagentId ? `<span class="ts-sub">sub</span>` : ''}
          <b>${esc(ev.tool)}</b>
          ${tgt ? `<span class="ts-tgt">${esc(tgt)}</span>` : ''}
          ${ev.count > 1 ? `<span class="ts-cnt">×${ev.count}</span>` : ''}
        </span>`;
      }).join('');
      beatsEl.scrollLeft = beatsEl.scrollWidth;

      if (expanded) {
        drawerEl.hidden = false;
        drawerEl.innerHTML = [...folded].reverse().slice(0, 40).map((ev) => `
          <div class="ts-row">
            <span class="ts-time">${ev.ts ? new Date(ev.ts).toTimeString().slice(0, 8) : ''}</span>
            <span class="badge">${esc(ev.tool)}${ev.count > 1 ? ` ×${ev.count}` : ''}</span>
            ${ev.subagentId ? `<span class="badge c">sub:${esc(ev.subagentId.slice(0, 8))}</span>` : ''}
            <code class="ts-row-tgt">${esc(ev.target || '-')}</code>
          </div>
        `).join('');
      } else {
        drawerEl.hidden = true;
      }
    };

    const cleanup = () => {
      closed = true;
      streams.delete(cleanup);
      request.abort();
      try { ws?.close(); } catch {}
      ws = null;
    };

    statusEl.onclick = () => {
      if (foldClientEvents(events).length) { expanded = !expanded; render(); }
    };
    expandBtn.onclick = () => { expanded = !expanded; render(); };

    const qs = new URLSearchParams({
      ...(termId ? { termId } : {}),
      ...(sessionId ? { sessionId } : {}),
    });
    api(`/api/hooks/events?${qs}`, { signal: request.signal }).then((r) => {
      if (closed || !hostEl.isConnected) return;
      if (Array.isArray(r?.events)) {
        events = r.events;
        render();
      }
    }).catch(() => {});

    try {
      const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${wsProto}://${location.host}/ws/tool-activity?${qs}&t=${TOKEN}`);
      ws.onmessage = (msgEv) => {
        if (closed || !hostEl.isConnected) { cleanup(); return; }
        let msg;
        try { msg = JSON.parse(msgEv.data); } catch { return; }
        if (msg?.type === 'hook-event' && msg.event) {
          events.push(msg.event);
          if (events.length > 250) events = events.slice(-250);
          render();
        }
      };
    } catch {}

    streams.add(cleanup);
    positionSubagents?.();
    if (typeof positionFolderToolbox === 'function') positionFolderToolbox();
    return {
      destroy: cleanup,
      setVisible: (visible) => {
        visibleAllowed = !!visible;
        syncVisibility(foldClientEvents(events).length > 0);
        positionSubagents?.();
      },
    };
  }

  window.ACH_TOOL_STREAM = {
    mountToolStreamBar, openTracesDrawer,
    destroyAll: () => { for (const cleanup of streams) cleanup(); },
  };
})();
