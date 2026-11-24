// Astryx-Aligned Codebase Architecture Brief, Ranked Hub Explorer & Exportable Artifact View
// - Prioritizes what actually matters for practitioners: Architectural Layers, Top Hub Modules, Health Risks
// - Progressive disclosure: crisp summary & ranked rows by default; Master-Detail Drawer on click; Clean macro diagram tab
// - 1-click Markdown Deliverable export (with Mermaid diagram + API inventory + Health findings)

(function () {
  const LAYER_META = [
    { id: 'ui', title: '화면 · UI', tone: 'kind-plan', desc: '사용자 화면, 폼, 스타일, 프론트엔드 상태' },
    { id: 'api', title: '서버 · API', tone: 'c', desc: 'HTTP 라우트, 웹소켓, 외부 요청 진입점' },
    { id: 'service', title: '코어 로직', tone: 'kind-dev', desc: '도메인 기능, 스캐너, CLI 제어, 비즈니스 로직' },
    { id: 'data', title: '데이터 · 저장', tone: 'kind-test', desc: 'JSON/SQLite 영속화, 인덱싱, 스키마' },
    { id: 'test', title: '테스트 · 설정', tone: 'kind-ops', desc: '단위/통합 테스트, 패키지·환경 설정' },
  ];

  const layerOf = (l) => (l === 'docs' || l === 'config' ? 'test' : l);
  const layerMetaOf = (l) => LAYER_META.find((m) => m.id === layerOf(l)) || LAYER_META[2];
  const impBadgeHTML = (n) => {
    if (n.importance === 'core') return '<span class="badge c">핵심 허브</span>';
    if (n.importance === 'major') return '<span class="badge kind-dev">주요 모듈</span>';
    return '<span class="badge">보조</span>';
  };

  function buildArchitectureMarkdown(fp, p, cwd) {
    const name = p?.name || (cwd ? cwd.split(/[\\/]/).filter(Boolean).pop() : '프로젝트');
    const nodes = fp.nodes || [];
    const topHubs = nodes.slice(0, 15);
    const issues = fp.health?.issues || [];
    const eps = fp.endpoints || [];
    const mermaidLines = ['flowchart LR'];
    const presentLayers = LAYER_META.filter((m) => nodes.some((n) => layerOf(n.layer) === m.id));
    for (const lm of presentLayers) {
      const cnt = nodes.filter((n) => layerOf(n.layer) === lm.id).length;
      const top = nodes.filter((n) => layerOf(n.layer) === lm.id).slice(0, 2).map((n) => n.name).join(', ');
      mermaidLines.push(`  L_${lm.id}["${lm.title} (${cnt}개)<br/>${top}"]`);
    }
    if (presentLayers.some((m) => m.id === 'ui') && presentLayers.some((m) => m.id === 'api')) mermaidLines.push('  L_ui -->|API 호출| L_api');
    if (presentLayers.some((m) => m.id === 'api') && presentLayers.some((m) => m.id === 'service')) mermaidLines.push('  L_api -->|처리 위임| L_service');
    if (presentLayers.some((m) => m.id === 'service') && presentLayers.some((m) => m.id === 'data')) mermaidLines.push('  L_service -->|저장 · 조회| L_data');
    if (presentLayers.some((m) => m.id === 'api') && presentLayers.some((m) => m.id === 'data')) mermaidLines.push('  L_api --> L_data');

    return [
      `# ${name} — 코드 아키텍처 & 품질 점검 보고서`,
      '',
      `- **분석 대상 경로**: \`${fp.rootDir || cwd}\``,
      `- **분석 일시**: ${new Date(fp.scannedAt || Date.now()).toLocaleString(document.documentElement.lang === 'en' ? 'en-US' : 'ko-KR')}`,
      `- **코드 규모**: ${fp.stats.files}개 파일 · ${fp.stats.lines.toLocaleString()}줄 · API 엔드포인트 ${fp.stats.endpoints}개 (프론트 매칭 ${fp.stats.matchedCalls}건)`,
      `- **코드 건강도**: **${fp.health?.score ?? 100}점** (위험 ${fp.health?.criticalCount || 0} · 주의 ${fp.health?.warnCount || 0} · 정보 ${fp.health?.infoCount || 0})`,
      fp.externalServices?.length ? `- **감지된 외부/DB 연동**: ${fp.externalServices.join(', ')}` : '',
      '',
      '## 1. 시스템 계층 구조도',
      '```mermaid',
      ...mermaidLines,
      '```',
      '',
      '## 2. 핵심 허브 모듈 (중요도 순 Top 15)',
      '| 중요도 | 파일 경로 | 계층 | 역할 요약 | 참조 수 | API | 라인 |',
      '| --- | --- | --- | --- | ---: | ---: | ---: |',
      ...topHubs.map((n) => `| ${n.importance === 'core' ? '핵심 허브' : n.importance === 'major' ? '주요' : '보조'} | \`${n.relPath}\` | ${layerMetaOf(n.layer).title} | ${String(n.summary || '').replace(/\|/g, '/')} | ${n.importedBy.length} | ${n.endpoints.length} | ${n.lines} |`),
      '',
      eps.length ? '## 3. 주요 API 엔드포인트\n' + eps.slice(0, 30).map((e) => `- \`${e.method} ${e.path}\` — \`${e.file}:${e.line}\``).join('\n') : '',
      '',
      '## 4. 보안 · 구조 점검 결과 (Health Check)',
      issues.length
        ? issues.map((it, i) => `${i + 1}. **[${it.severity.toUpperCase()}] ${it.title}** (\`${it.file}:${it.line}\`)\n   - 설명: ${it.detail}\n   - 권장 조치: ${it.fixPrompt}`).join('\n')
        : '- 감지된 주요 보안 또는 구조적 위험이 없습니다.',
      '',
    ].filter((x) => x !== undefined).join('\n');
  }

  function buildBlueprintFallback(p, hostDir) {
    const ico = window.UI_ICO || {};
    const topTasks = (p?.tasks || []).filter((t) => !t.parentId);
    if (!topTasks.length) {
      return `<div class="fm-wrap">
        <div class="fm-top-note">
          <div>
            <b>${ico.layers || ''} 코드 구조 (Floorplan)</b>
            <span class="ums" style="margin:0 0 0 8px">폴더(${esc(hostDir || '미지정')})에 스캔할 소스 코드 파일이 아직 없습니다.</span>
          </div>
          <div class="row" style="gap:6px">
            <button type="button" class="primary btn-sm" id="fmPickDir">${ico.folder || ''} 다른 폴더 분석</button>
            <button type="button" class="btn-sm" id="fmRescan">${ico.refresh || ''} 다시 스캔</button>
          </div>
        </div>
      </div>`;
    }
    const cols = {
      plan: topTasks.filter((t) => (typeof taskKindOf === 'function' ? taskKindOf(t) : 'dev') === 'plan'),
      dev: topTasks.filter((t) => (typeof taskKindOf === 'function' ? taskKindOf(t) : 'dev') === 'dev'),
      test: topTasks.filter((t) => ['test', 'ops'].includes(typeof taskKindOf === 'function' ? taskKindOf(t) : 'dev')),
    };
    const renderCol = (lbl, items) => `<div class="fm-bp-col">
      <div class="fm-bp-col-hd">${esc(lbl)} <span class="badge">${items.length}</span></div>
      ${items.map((t) => `<div class="fm-bp-card${t.stage === 'planned' ? ' is-blueprint' : ''}" data-bp-task="${esc(t.id)}">
        <div class="row" style="justify-content:space-between;gap:6px">${typeof kindBadgeHTML === 'function' ? kindBadgeHTML(t) : ''}${typeof stageBadgeHTML === 'function' ? stageBadgeHTML(t.stage) : ''}</div>
        <b>${esc(t.title)}</b>
        ${t.detail ? `<p>${esc(t.detail)}</p>` : ''}
      </div>`).join('') || '<div class="empty" style="padding:14px 8px">항목 없음</div>'}
    </div>`;

    return `<div class="fm-wrap">
      <div class="fm-top-note">
        <div>
          <b>${ico.layers || ''} 설계 청사진 (Blueprint) 모드</b>
          <span class="ums" style="margin:0 0 0 8px">작업 폴더(${esc(hostDir || p.cwd)})에 아직 코드가 없어 설계 태스크 청사진을 표시합니다.</span>
        </div>
        <div class="row" style="gap:6px">
          <button type="button" class="primary btn-sm" id="fmPickDir">${ico.folder || ''} 다른 폴더 분석</button>
          <button type="button" class="btn-sm" id="fmRescan">${ico.refresh || ''} 다시 스캔</button>
        </div>
      </div>
      <div class="fm-bp-grid">
        ${renderCol('기획 · 아키텍처', cols.plan)}
        ${renderCol('기능 · 모듈 구현', cols.dev)}
        ${renderCol('검증 · 배포', cols.test)}
      </div>
    </div>`;
  }

  function openNodeDetailDrawer(node, allNodes, edges, p, termCtx, fp, cwd) {
    const ico = window.UI_ICO || {};
    const lm = layerMetaOf(node.layer);
    const inIds = [...new Set(edges.filter((e) => e.to === node.id).map((e) => e.from))];
    const outIds = [...new Set(edges.filter((e) => e.from === node.id).map((e) => e.to))];
    const epList = node.endpoints.map((e) => `<div class="drw-kv"><span class="mono">${esc(e.method)} ${esc(e.path)}</span><b>L${e.line}</b></div>`).join('');
    const callList = node.calls.map((c) => `<div class="drw-kv"><span class="mono">${esc(c.path)}</span><b>L${c.line}</b></div>`).join('');
    const fileIssues = (fp.health?.issues || []).filter((it) => it.file === node.relPath);

    const body = `
      <div class="drw-sec">
        <div class="row" style="gap:6px;flex-wrap:wrap">${impBadgeHTML(node)}<span class="badge ${lm.tone}">${esc(lm.title)}</span><span class="badge mono">${node.lines.toLocaleString()}줄</span></div>
        <div class="mono ums" style="margin:4px 0 0;word-break:break-all">${esc(node.relPath)}</div>
        <p style="margin:6px 0 0;font-size:13.5px;line-height:1.5">${esc(node.summary)}</p>
      </div>
      ${fileIssues.length ? `<div class="drw-sec"><div class="drw-lbl">이 파일 점검 사항 (${fileIssues.length})</div>${fileIssues.map((it) => `<div class="rban ${it.severity === 'critical' ? 'bad' : 'warn'}" style="padding:8px 10px"><b>${esc(it.title)}</b><div class="ums" style="margin:2px 0 0">${esc(it.detail)}</div></div>`).join('')}</div>` : ''}
      <div class="drw-sec">
        <div class="drw-lbl">영향 범위 (이 파일을 사용하는 곳 · ${inIds.length})</div>
        <div class="row" style="gap:5px;flex-wrap:wrap">${inIds.length ? inIds.map((id) => `<span class="badge mono">${esc(id)}</span>`).join('') : '<span class="ums" style="margin:0">진입점 또는 직접 호출 없음</span>'}</div>
      </div>
      <div class="drw-sec">
        <div class="drw-lbl">의존하는 모듈 · API (${outIds.length})</div>
        <div class="row" style="gap:5px;flex-wrap:wrap">${outIds.length ? outIds.map((id) => `<span class="badge mono">${esc(id)}</span>`).join('') : '<span class="ums" style="margin:0">하위 로컬 의존성 없음</span>'}</div>
      </div>
      ${epList ? `<div class="drw-sec"><div class="drw-lbl">제공 API 엔드포인트 (${node.endpoints.length})</div><div>${epList}</div></div>` : ''}
      ${callList ? `<div class="drw-sec"><div class="drw-lbl">호출하는 API 경로 (${node.calls.length})</div><div>${callList}</div></div>` : ''}`;

    const primaryLbl = p ? `${ico.plus || ''} 이 파일 수정 작업 추가` : `${ico.external || ''} 터미널 입력창에 넣기`;
    const d = openDrawer({
      title: node.name,
      bodyHTML: body,
      footerHTML: `<button type="button" data-drw-close>닫기</button><button type="button" class="primary" id="drwNodeAct">${primaryLbl}</button>`,
      width: 500,
    });
    $('#drwNodeAct', d).onclick = async () => {
      d.close();
      if (p) {
        const newTask = {
          id: newTaskId(),
          stage: 'planned',
          kind: node.layer === 'test' ? 'test' : 'dev',
          title: `${node.name} 기능 개선 및 점검`,
          detail: `대상 파일: ${node.relPath} (${node.summary})\n영향 범위: ${[...inIds, ...outIds].slice(0, 8).join(', ')}`,
          agent: '', account: null, model: '', effort: '', parentId: '', termId: '', after: [],
        };
        await saveProject({ ...p, tasks: [...p.tasks, newTask] }, 'design');
        toast(`“${newTask.title}” 작업을 추가했습니다`);
        return;
      }
      const txt = `${node.relPath} (${node.summary}) 확인해줘. `;
      if (termCtx?.onInsertPrompt) termCtx.onInsertPrompt(txt, false);
      else await copyText(txt);
    };
  }

  async function renderFloorplanInto({ host, p = null, cwd = '', gen, previewCwd = '', termCtx = null }) {
    const ico = window.UI_ICO || {};
    if (!host) return;
    const activeCwd = previewCwd || cwd || p?.cwd || '';
    host.innerHTML = '<div class="empty" style="padding:24px 8px">코드 구조와 핵심 모듈을 분석하는 중…</div>';

    let fp;
    if (!activeCwd && !p?.id) {
      fp = { exists: false, nodes: [] };
    } else {
      try {
        const url = (previewCwd || !p?.id)
          ? `/api/projects/floorplan?cwd=${encodeURIComponent(activeCwd)}`
          : `/api/projects/floorplan?id=${encodeURIComponent(p.id)}`;
        const r = await api(url);
        if (gen !== viewGen) return;
        if (r.error || !r.floorplan) throw new Error(r.error || '코드 구조를 불러올 수 없습니다.');
        fp = r.floorplan;
      } catch (e) {
        if (gen !== viewGen) return;
        host.innerHTML = `<div class="pj-empty"><p role="alert">${esc(e.message)}</p><button type="button" id="fmRetry">다시 스캔</button></div>`;
        $('#fmRetry', host).onclick = () => renderFloorplanInto({ host, p, cwd, gen, previewCwd, termCtx });
        return;
      }
    }

    if (!fp.exists || !fp.nodes?.length) {
      host.innerHTML = buildBlueprintFallback(p, activeCwd);
      $('#fmRescan', host)?.addEventListener('click', () => renderFloorplanInto({ host, p, cwd, gen, previewCwd, termCtx }));
      $('#fmPickDir', host)?.addEventListener('click', () => {
        if (typeof openFolderPickerDialog === 'function') {
          openFolderPickerDialog(activeCwd, (chosen) => renderFloorplanInto({ host, p, cwd, gen, previewCwd: chosen, termCtx }));
        }
      });
      host.querySelectorAll('[data-bp-task]').forEach((el) => {
        el.onclick = () => {
          const t = (p?.tasks || []).find((x) => x.id === el.dataset.bpTask);
          if (t && typeof openProjectTaskDrawer === 'function') openProjectTaskDrawer(p, t);
        };
      });
      return;
    }

    const nodes = fp.nodes;
    const edges = fp.edges || [];
    const issues = fp.health?.issues || [];
    const score = fp.health?.score ?? 100;
    const scoreCls = score >= 85 ? 'ok' : score >= 65 ? 'warn' : 'lim';
    const topHub = nodes[0];
    const coreNodes = nodes.filter((n) => n.importance === 'core');

    let subTab = 'overview'; // 'overview' | 'diagram' | 'health'
    let filterLayer = 'all';
    let filterQuery = '';
    let mapScope = 'core'; // 'core' | 'all'
    let mapSelectedId = '';
    let mapQuery = '';
    let mapZoom = 1;

    const LAYER_COLS = [
      { id: 'ui', title: '화면 · UI', tone: 'c' },
      { id: 'api', title: '서버 · API', tone: 'c' },
      { id: 'service', title: '코어 로직', tone: '' },
      { id: 'data', title: '데이터 · 저장', tone: 'ok' },
      { id: 'config', title: '설정 · 문서', tone: '' },
    ];

    const edgesForNode = (nid) => {
      const inc = new Set();
      const out = new Set();
      for (const e of edges) {
        if (e.from === nid) out.add(e.to);
        if (e.to === nid) inc.add(e.from);
      }
      return { inc, out };
    };

    const drawMapEdges = (focusId = mapSelectedId) => {
      const stage = $('.fm-map-stage', host);
      const svg = $('svg.fm-map-edges', host);
      if (!stage || !svg) return;
      const sr = stage.getBoundingClientRect();
      const z = mapZoom || 1;
      const boxOf = new Map();
      stage.querySelectorAll('[data-fm-map-node]').forEach((el) => {
        const r = el.getBoundingClientRect();
        boxOf.set(el.dataset.fmMapNode, {
          el,
          l: (r.left - sr.left) / z,
          r: (r.right - sr.left) / z,
          t: (r.top - sr.top) / z,
          b: (r.bottom - sr.top) / z,
          cx: ((r.left + r.right) / 2 - sr.left) / z,
          cy: ((r.top + r.bottom) / 2 - sr.top) / z,
        });
      });

      const rel = focusId ? edgesForNode(focusId) : null;
      stage.querySelectorAll('[data-fm-map-node]').forEach((el) => {
        const id = el.dataset.fmMapNode;
        el.classList.toggle('is-sel', !!focusId && id === focusId);
        el.classList.toggle('is-rel', !!focusId && id !== focusId && (rel.inc.has(id) || rel.out.has(id)));
        el.classList.toggle('is-dim', !!focusId && id !== focusId && !rel.inc.has(id) && !rel.out.has(id));
      });

      const paths = [`<defs>
        <marker id="fmArrOut" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 1 L 10 5 L 0 9 z" fill="var(--accent)"/></marker>
        <marker id="fmArrIn" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 1 L 10 5 L 0 9 z" fill="var(--ok)"/></marker>
      </defs>`];

      const seenPair = new Set();
      for (const e of edges) {
        const a = boxOf.get(e.from);
        const b = boxOf.get(e.to);
        if (!a || !b || e.from === e.to) continue;
        const pk = `${e.from}=>${e.to}`;
        if (seenPair.has(pk)) continue;
        seenPair.add(pk);

        const isOut = focusId && e.from === focusId;
        const isIn = focusId && e.to === focusId;
        const cls = ['fm-edge'];
        if (e.kind === 'api') cls.push('api');
        if (focusId) {
          if (isOut) cls.push('hi');
          else if (isIn) cls.push('hi-in');
          else cls.push('dim');
        }
        const marker = isOut ? ' marker-end="url(#fmArrOut)"' : isIn ? ' marker-end="url(#fmArrIn)"' : '';

        let d;
        if (Math.abs(a.cx - b.cx) < 30) {
          const arcX = Math.max(a.r, b.r) + 26;
          d = `M ${a.r.toFixed(1)} ${a.cy.toFixed(1)} C ${arcX.toFixed(1)} ${a.cy.toFixed(1)}, ${arcX.toFixed(1)} ${b.cy.toFixed(1)}, ${b.r.toFixed(1)} ${b.cy.toFixed(1)}`;
        } else if (a.cx < b.cx) {
          const dx = Math.max(36, (b.l - a.r) * 0.55);
          d = `M ${a.r.toFixed(1)} ${a.cy.toFixed(1)} C ${(a.r + dx).toFixed(1)} ${a.cy.toFixed(1)}, ${(b.l - dx).toFixed(1)} ${b.cy.toFixed(1)}, ${b.l.toFixed(1)} ${b.cy.toFixed(1)}`;
        } else {
          const dx = Math.max(36, (a.l - b.r) * 0.55);
          d = `M ${a.l.toFixed(1)} ${a.cy.toFixed(1)} C ${(a.l - dx).toFixed(1)} ${a.cy.toFixed(1)}, ${(b.r + dx).toFixed(1)} ${b.cy.toFixed(1)}, ${b.r.toFixed(1)} ${b.cy.toFixed(1)}`;
        }
        paths.push(`<path class="${cls.join(' ')}" d="${d}"${marker}/>`);
      }
      svg.setAttribute('width', String(stage.scrollWidth));
      svg.setAttribute('height', String(stage.scrollHeight));
      svg.innerHTML = paths.join('');
    };

    const paint = () => {
      if (!host.isConnected || gen !== viewGen) return;
      const segBtn = (id, label, cnt = '') => `<button type="button" data-fm-sub="${id}" class="${subTab === id ? 'on' : ''}">${label}${cnt !== '' ? ` <span class="seg-cnt">${cnt}</span>` : ''}</button>`;

      const toolbar = `<div class="pj-flow-bar">
        <div class="row" style="gap:8px;flex-wrap:wrap">
          <div class="seg" role="tablist" aria-label="코드 구조 보기 방식">
            ${segBtn('overview', '핵심 요약 · 모듈 목록')}
            ${segBtn('diagram', '시스템 계층도')}
            ${segBtn('health', '보안 · 구조 점검', issues.length)}
          </div>
          <span class="badge c">실제 코드 분석</span>
          ${previewCwd ? `<span class="badge c mono" title="${esc(previewCwd)}">${esc(base(previewCwd))}</span><button type="button" class="ghost btn-sm" id="fmBackProjDir">원래 폴더로</button>` : ''}
        </div>
        <div class="row" style="gap:6px;flex-wrap:wrap">
          <button type="button" class="btn-sm" id="fmPreviewMd" title="아키텍처 & 품질 보고서 전문 미리보기 · 산출물 저장">${ico.file || ''} 보고서 보기</button>
          <details class="fm-exports"><summary>보고서 내보내기</summary><div class="row">
            <button type="button" class="btn-sm" id="fmSaveArtifact" title="작업 폴더에 FLOORPLAN.md 생성 및 산출물 탭 등록">${ico.plus || ''} 산출물 저장</button>
            <button type="button" class="btn-sm" id="fmCopyMd" title="실무자 공유용 마크다운 아키텍처 보고서 복사">${ico.copy || ''} 복사</button>
            <button type="button" class="btn-sm" id="fmDownloadMd" title="아키텍처 보고서 .md 파일로 다운로드">${ico.external || ''} .md</button>
          </div></details>
          <button type="button" class="btn-sm" id="fmPickDir" title="다른 프로젝트 폴더 스캔">${ico.folder || ''} 폴더 선택</button>
          <button type="button" class="ghost icon-btn btn-sm" id="fmRescan" title="다시 스캔" aria-label="다시 스캔">${ico.refresh || ''}</button>
        </div>
      </div>`;

      let body = '';
      if (subTab === 'overview') {
        const kpiHTML = `<div class="h-stats fm-stat-pair">
          <div class="h-stat" style="cursor:default">
            <div class="h-stat-lbl"><span>프로젝트 규모</span><span class="badge">${fp.parts.length}개 계층</span></div>
            <div class="h-stat-val">${fp.stats.files}개 파일</div>
            <div class="h-stat-sub">총 ${fp.stats.lines.toLocaleString()}줄 · 핵심 허브 ${coreNodes.length}개</div>
          </div>
          <div class="h-stat" style="cursor:default">
            <div class="h-stat-lbl"><span>API · 요청 연결</span><span class="badge c">${fp.stats.matchedCalls}건 매칭</span></div>
            <div class="h-stat-val">${fp.stats.endpoints}개</div>
            <div class="h-stat-sub">프론트 호출 ${fp.stats.apiCalls}건 → 서버 라우트</div>
          </div>
        </div>`;
        const keyHTML = `<div class="h-stats fm-stat-pair">
          <div class="h-stat" data-fm-open-node="${esc(topHub?.id || '')}">
            <div class="h-stat-lbl"><span>최핵심 허브 (1위)</span><span class="badge c">상세 보기</span></div>
            <div class="h-stat-val" style="font-size:19px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(topHub?.name || '—')}</div>
            <div class="h-stat-sub">${topHub ? `참조 ${topHub.importedBy.length}곳 · API ${topHub.endpoints.length}개 · ${topHub.lines}줄` : ''}</div>
          </div>
          <div class="h-stat" data-fm-go-sub="health">
            <div class="h-stat-lbl"><span>코드 건강도</span><span class="badge ${scoreCls}">${issues.length ? `이슈 ${issues.length}건` : '양호'}</span></div>
            <div class="h-stat-val">${score}점</div>
            <div class="h-stat-sub">${issues[0] ? esc(issues[0].title) : '발견된 보안·구조 위험 없음'}</div>
          </div>
        </div>`;

        // Clean 4~5-Column Subsystem Architecture Cards (Astryx layout: zero spaghetti lines!)
        const archCols = LAYER_META.map((lm) => {
          const items = nodes.filter((n) => layerOf(n.layer) === lm.id);
          if (!items.length) return '';
          const top3 = items.slice(0, 3);
          return `<div class="fm-arch-card">
            <div class="fm-arch-hd"><span class="badge ${lm.tone}">${esc(lm.title)}</span><span class="ums" style="margin:0">${items.length}개</span></div>
            <div class="fm-arch-desc">${esc(lm.desc)}</div>
            <div class="fm-arch-list">
              ${top3.map((n) => `<button type="button" class="fm-arch-item" data-fm-open-node="${esc(n.id)}">
                <span class="mono">${esc(n.name)}</span>
                <span class="ums" style="margin:0">${n.endpoints.length ? `API ${n.endpoints.length}` : `${n.lines}L`}</span>
              </button>`).join('')}
            </div>
          </div>`;
        }).filter(Boolean).join('');

        // Dense Ranked Module List (Astryx row surface)
        const qTerms = filterQuery.toLowerCase().split(/\s+/).filter(Boolean);
        const filtered = nodes.filter((n) => {
          if (filterLayer === 'core' && n.importance !== 'core') return false;
          if (filterLayer === 'api' && !n.endpoints.length) return false;
          if (filterLayer === 'issue' && !n.hasIssue) return false;
          if (['ui', 'api', 'service', 'data', 'test'].includes(filterLayer) && layerOf(n.layer) !== filterLayer) return false;
          if (qTerms.length) {
            const hay = `${n.relPath} ${n.summary} ${n.endpoints.map((e) => e.path).join(' ')}`.toLowerCase();
            return qTerms.every((t) => hay.includes(t));
          }
          return true;
        });

        const fBtn = (id, lbl) => `<button type="button" data-fm-filt="${id}" class="${filterLayer === id ? 'on' : ''}">${lbl}</button>`;
        const rowsHTML = filtered.slice(0, 40).map((n) => {
          const lm = layerMetaOf(n.layer);
          const metaParts = [
            lm.title,
            n.importedBy.length ? `참조 ${n.importedBy.length}곳` : '',
            n.endpoints.length ? `API ${n.endpoints.length}개` : '',
            n.calls.length ? `호출 ${n.calls.length}건` : '',
            `${n.lines.toLocaleString()}줄`,
          ].filter(Boolean).join(' · ');
          return `<button type="button" class="m-row" data-fm-open-node="${esc(n.id)}">
            <span class="m-row-main">
              <span class="m-row-t" style="display:flex;align-items:center;gap:7px;flex-wrap:wrap">
                ${impBadgeHTML(n)}
                <b class="mono">${esc(n.relPath)}</b>
                ${n.hasIssue ? '<span class="badge warn">점검 필요</span>' : ''}
              </span>
              <span class="m-row-s">${esc(n.summary)} · ${esc(metaParts)}</span>
            </span>
            <span class="m-row-end"><span class="ico">${ico.chevRight || ''}</span></span>
          </button>`;
        }).join('') || '<div class="empty" style="padding:20px 16px">조건에 맞는 모듈이 없습니다.</div>';

        body = `${keyHTML}
          <section class="list-sec">
            <div class="list-sec-hd"><h2>계층별 핵심 구성 요약 (클릭 시 파일 상세)</h2><span class="ums" style="margin:0">${fp.externalServices?.length ? `외부 연동: ${esc(fp.externalServices.join(' · '))}` : 'UI → API → 코어 → 데이터 흐름'}</span></div>
            <div class="fm-arch-grid">${archCols}</div>
          </section>
          <details class="fm-metrics"><summary>규모 및 API 지표</summary>${kpiHTML}</details>
          <section class="sheet">
            <div class="sheet-hd" style="flex-wrap:wrap">
              <h2>중요도 순 핵심 파일 목록 <span class="badge">${filtered.length}</span></h2>
              <div class="row" style="gap:8px;flex-wrap:wrap">
                <div class="seg" role="tablist">
                  ${fBtn('all', '전체')}
                  ${fBtn('core', `핵심 허브 (${coreNodes.length})`)}
                  ${fBtn('api', 'API 라우트')}
                  ${fBtn('issue', `점검 (${issues.length})`)}
                </div>
                <input id="fmSearchIn" class="btn-sm" type="search" value="${esc(filterQuery)}" placeholder="파일·API·역할 필터…" style="width:180px">
              </div>
            </div>
            <div>${rowsHTML}</div>
          </section>`;
      } else if (subTab === 'diagram') {
        const qMap = mapQuery.trim().toLowerCase();
        const selNode = mapSelectedId ? nodes.find((n) => n.id === mapSelectedId) : null;
        const selRel = selNode ? edgesForNode(selNode.id) : null;
        const colsToShow = mapScope === 'all' ? LAYER_COLS : LAYER_COLS.slice(0, 4);
        const maxPerCol = mapScope === 'all' ? 12 : 4;

        const colsHTML = colsToShow.map((col) => {
          const allInLayer = nodes.filter((n) => layerOf(n.layer) === col.id);
          if (!allInLayer.length) return '';
          const picked = [];
          const seen = new Set();
          const addNode = (n) => { if (n && !seen.has(n.id)) { seen.add(n.id); picked.push(n); } };
          if (qMap) {
            allInLayer.filter((n) => `${n.relPath} ${n.summary}`.toLowerCase().includes(qMap)).slice(0, 8).forEach(addNode);
          } else {
            allInLayer.slice(0, maxPerCol).forEach(addNode);
            if (selNode) {
              if (layerOf(selNode.layer) === col.id) addNode(selNode);
              allInLayer.filter((n) => selRel.inc.has(n.id) || selRel.out.has(n.id)).slice(0, 4).forEach(addNode);
            }
          }
          if (!picked.length) return '';
          return `<div class="fm-map-col">
            <div class="fm-map-col-hd">
              <span class="badge ${col.tone}">${esc(col.title)}</span>
              <span class="ums" style="margin:0">${picked.length}/${allInLayer.length}</span>
            </div>
            <div class="fm-map-col-list">
              ${picked.map((n) => {
                const metric = n.importedBy.length
                  ? `참조 ${n.importedBy.length}곳`
                  : n.endpoints.length
                    ? `API ${n.endpoints.length}개`
                    : n.calls.length
                      ? `요청 ${n.calls.length}건`
                      : `${n.lines}줄`;
                return `<button type="button" class="fm-map-node${n.importance === 'core' ? ' is-core' : ''}" data-fm-map-node="${esc(n.id)}">
                  <div class="fm-map-node-top">
                    <b class="mono" title="${esc(n.relPath)}">${esc(n.name)}</b>
                    ${n.importance === 'core' ? '<span class="badge c">핵심</span>' : ''}
                  </div>
                  <div class="fm-map-node-sum">${esc(n.summary)}</div>
                  <div class="fm-map-node-meta">
                    <span>${esc(metric)}</span>
                    <span>${n.lines.toLocaleString()}L</span>
                  </div>
                </button>`;
              }).join('')}
            </div>
          </div>`;
        }).filter(Boolean).join('');

        const totalShown = (colsHTML.match(/data-fm-map-node="/g) || []).length;
        const mapStatusHTML = selNode
          ? `<div class="fm-map-status on">
              <span><b class="mono">${esc(selNode.relPath)}</b> · 들어오는 연결 <b>${selRel.inc.size}</b>개 · 나가는 연결 <b>${selRel.out.size}</b>개 (초록=호출/참조원, 주황=의존 대상)</span>
              <span class="row" style="gap:6px">
                <button type="button" class="primary btn-sm" data-fm-open-node="${esc(selNode.id)}">상세 패널 열기 →</button>
                <button type="button" class="btn-sm" id="fmMapClearSel">선택 해제</button>
              </span>
            </div>`
          : `<div class="fm-map-status">
              <span>모듈 카드를 클릭하면 <b>연결 흐름(Blast Radius)</b>만 선명하게 집중 표시합니다. 빈 캔버스를 드래그해 이동할 수 있습니다.</span>
              <span class="ums" style="margin:0">표시 중: ${totalShown} / ${nodes.length}개 파일</span>
            </div>`;

        body = `<section class="sheet">
          <div class="sheet-hd" style="flex-wrap:wrap">
            <h2>시스템 아키텍처 계층 맵</h2>
            <div class="fm-map-bar">
              <button type="button" class="ghost btn-sm" data-fm-go-sub="overview" data-fm-jump>모듈 목록 보기</button>
              <div class="seg" role="tablist">
                <button type="button" data-fm-map-scope="core" class="${mapScope === 'core' ? 'on' : ''}">핵심 허브 맵</button>
                <button type="button" data-fm-map-scope="all" class="${mapScope === 'all' ? 'on' : ''}">확장 모듈 보기</button>
              </div>
              <input id="fmMapSearchIn" class="btn-sm" type="search" value="${esc(mapQuery)}" placeholder="맵에서 모듈 찾기…" style="width:165px">
              <div class="btn-grp" aria-label="맵 확대 축소">
                <button type="button" class="btn-sm" id="fmMapZoomOut" title="축소">-</button>
                <button type="button" class="btn-sm" id="fmMapZoomReset" title="100%">${Math.round(mapZoom * 100)}%</button>
                <button type="button" class="btn-sm" id="fmMapZoomIn" title="확대">+</button>
                <button type="button" class="btn-sm" id="fmMapFit" title="화면 너비 맞춤">맞춤</button>
              </div>
            </div>
          </div>
          <div class="fm-macro-wrap">
            ${mapStatusHTML}
            <div class="fm-map-vp" id="fmMapVp">
              <div class="fm-map-stage" style="transform:scale(${mapZoom});width:${Math.round(100 / mapZoom)}%">
                <svg class="fm-map-edges" aria-hidden="true"></svg>
                <div class="fm-map-cols">${colsHTML}</div>
              </div>
            </div>
          </div>
        </section>`;
      } else {
        const fixBtnLabel = p ? `${ico.plus || ''} 수정 작업 추가` : `${ico.external || ''} 터미널에 수정 지시`;
        const issueHTML = issues.map((it, idx) => {
          const sevBadge = it.severity === 'critical'
            ? '<span class="badge lim">위험</span>'
            : it.severity === 'warn'
              ? '<span class="badge warn">주의</span>'
              : '<span class="badge">정보</span>';
          return `<div class="m-row" style="cursor:default">
            <div class="m-row-main">
              <div class="m-row-t" style="display:flex;align-items:center;gap:7px;flex-wrap:wrap">${sevBadge}<span>${esc(it.title)}</span><span class="mono ums" style="margin:0">${esc(it.file)}:${it.line}</span></div>
              <div class="m-row-s" style="white-space:normal">${esc(it.detail)}</div>
            </div>
            <div class="m-row-end">
              <button type="button" class="btn-sm" data-fm-open-node="${esc(it.file)}">상세 보기</button>
              <button type="button" class="primary btn-sm" data-fm-fix="${idx}">${fixBtnLabel}</button>
            </div>
          </div>`;
        }).join('') || '<div class="empty" style="padding:24px 16px">감지된 보안·구조 이슈가 없습니다.</div>';

        body = `<section class="sheet">
          <div class="sheet-hd">
            <h2>${ico.flask || ''} 코드 보안 · 구조 점검 <span class="badge ${scoreCls}">${score}점</span></h2>
            <span class="ums" style="margin:0">시크릿 노출 · 인증 누락 · 비대 모듈 자동 진단</span>
          </div>
          <div>${issueHTML}</div>
        </section>`;
      }

      host.innerHTML = `<div class="fm-wrap">${!p ? '<h1 class="sr-only">코드 구조</h1>' : ''}${toolbar}${body}</div>`;

      const srch = $('#fmSearchIn', host);
      if (srch) {
        srch.oninput = () => {
          filterQuery = srch.value;
          const pos = srch.selectionStart;
          paint();
          const nextIn = $('#fmSearchIn', host);
          if (nextIn) { nextIn.focus(); try { nextIn.setSelectionRange(pos, pos); } catch {} }
        };
      }

      const mapSrch = $('#fmMapSearchIn', host);
      if (mapSrch) {
        mapSrch.oninput = () => {
          mapQuery = mapSrch.value;
          const pos = mapSrch.selectionStart;
          paint();
          const nextIn = $('#fmMapSearchIn', host);
          if (nextIn) { nextIn.focus(); try { nextIn.setSelectionRange(pos, pos); } catch {} }
        };
      }

      const vp = $('#fmMapVp', host);
      if (vp) {
        requestAnimationFrame(() => drawMapEdges(mapSelectedId));
        vp.onmousedown = (ev) => {
          if (ev.button !== 0 || ev.target.closest('button, input')) return;
          vp.classList.add('is-panning');
          const sx = ev.clientX, sy = ev.clientY, sl = vp.scrollLeft, st = vp.scrollTop;
          let moved = false;
          const onMove = (m) => {
            if (Math.abs(m.clientX - sx) > 3 || Math.abs(m.clientY - sy) > 3) moved = true;
            vp.scrollLeft = sl - (m.clientX - sx);
            vp.scrollTop = st - (m.clientY - sy);
          };
          const onUp = () => {
            vp.classList.remove('is-panning');
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            if (!moved && mapSelectedId && !ev.target.closest('[data-fm-map-node]')) {
              mapSelectedId = '';
              paint();
            }
          };
          window.addEventListener('mousemove', onMove);
          window.addEventListener('mouseup', onUp);
        };
        vp.querySelectorAll('[data-fm-map-node]').forEach((btn) => {
          btn.onmouseenter = () => { if (!mapSelectedId) drawMapEdges(btn.dataset.fmMapNode); };
          btn.onmouseleave = () => { if (!mapSelectedId) drawMapEdges(''); };
        });
      }
    };

    host.onclick = async (e) => {
      const subBtn = e.target.closest('[data-fm-sub]');
      if (subBtn) { subTab = subBtn.dataset.fmSub; paint(); return; }
      const goSub = e.target.closest('[data-fm-go-sub]');
      if (goSub) {
        subTab = goSub.dataset.fmGoSub;
        paint();
        if (goSub.hasAttribute('data-fm-jump')) $('#fmSearchIn', host)?.focus();
        return;
      }
      const fBtn = e.target.closest('[data-fm-filt]');
      if (fBtn) { filterLayer = fBtn.dataset.fmFilt; paint(); return; }
      const scopeBtn = e.target.closest('[data-fm-map-scope]');
      if (scopeBtn) { mapScope = scopeBtn.dataset.fmMapScope; paint(); return; }
      if (e.target.closest('#fmMapClearSel')) { mapSelectedId = ''; paint(); return; }
      if (e.target.closest('#fmMapZoomIn')) { mapZoom = Math.min(1.4, +(mapZoom + 0.1).toFixed(2)); paint(); return; }
      if (e.target.closest('#fmMapZoomOut')) { mapZoom = Math.max(0.65, +(mapZoom - 0.1).toFixed(2)); paint(); return; }
      if (e.target.closest('#fmMapZoomReset')) { mapZoom = 1; paint(); return; }
      if (e.target.closest('#fmMapFit')) {
        const vp = $('#fmMapVp', host);
        const colsEl = $('.fm-map-cols', host);
        if (vp && colsEl) {
          const needW = colsEl.scrollWidth + 48;
          mapZoom = Math.max(0.65, Math.min(1, +(vp.clientWidth / Math.max(1, needW)).toFixed(2)));
          paint();
        }
        return;
      }
      const mapNodeBtn = e.target.closest('[data-fm-map-node]');
      if (mapNodeBtn) {
        const nid = mapNodeBtn.dataset.fmMapNode;
        if (mapSelectedId === nid) {
          const n = nodes.find((x) => x.id === nid);
          if (n) openNodeDetailDrawer(n, nodes, edges, p, termCtx, fp, activeCwd);
        } else {
          mapSelectedId = nid;
          paint();
        }
        return;
      }
      if (e.target.closest('#fmRescan')) return renderFloorplanInto({ host, p, cwd, gen, previewCwd, termCtx });
      if (e.target.closest('#fmBackProjDir')) return renderFloorplanInto({ host, p, cwd, gen, previewCwd: '', termCtx });
      if (e.target.closest('#fmPickDir')) {
        if (typeof openFolderPickerDialog === 'function') {
          openFolderPickerDialog(activeCwd, (chosen) => renderFloorplanInto({ host, p, cwd, gen, previewCwd: chosen, termCtx }));
        }
        return;
      }
      const saveArtifactReport = async () => {
        const mdText = buildArchitectureMarkdown(fp, p, activeCwd);
        const r = await api('/api/projects/floorplan/report', {
          method: 'POST',
          body: {
            projectId: p?.id || '',
            cwd: activeCwd,
            sessionId: termCtx?.sessionId || '',
            filename: 'FLOORPLAN.md',
            content: mdText,
          },
        });
        if (r.error) throw new Error(r.error);
        toast(r.pinned ? `FLOORPLAN.md 생성 및 산출물 탭 등록 완료` : `작업 폴더에 저장됨: ${r.path}`);
        return r;
      };
      if (e.target.closest('#fmSaveArtifact')) {
        saveArtifactReport().catch((er) => toast(er.message, 5000, 'danger'));
        return;
      }
      if (e.target.closest('#fmPreviewMd')) {
        const mdText = buildArchitectureMarkdown(fp, p, activeCwd);
        const rendered = typeof md === 'function' ? md(mdText) : `<pre class="mdpre">${esc(mdText)}</pre>`;
        const d = openDrawer({
          title: '코드 아키텍처 & 품질 점검 보고서 (FLOORPLAN.md)',
          bodyHTML: `<div class="md">${rendered}</div>`,
          footerHTML: `<button type="button" data-drw-close>닫기</button><button type="button" id="drwCopyMd">복사</button><button type="button" id="drwDlMd">.md 다운로드</button><button type="button" class="primary" id="drwSaveMd">산출물 저장 (FLOORPLAN.md)</button>`,
          width: 680,
        });
        $('#drwCopyMd', d).onclick = async () => { await copyText(mdText); toast('보고서를 클립보드에 복사했습니다'); };
        $('#drwDlMd', d).onclick = () => $('#fmDownloadMd', host)?.click();
        $('#drwSaveMd', d).onclick = async (ev) => {
          const btn = ev.currentTarget;
          btn.disabled = true;
          try { await saveArtifactReport(); } catch (er) { toast(er.message, 5000, 'danger'); } finally { btn.disabled = false; }
        };
        return;
      }
      if (e.target.closest('#fmCopyMd')) {
        const mdText = buildArchitectureMarkdown(fp, p, activeCwd);
        await copyText(mdText);
        toast('실무자 공유용 마크다운 아키텍처 보고서를 클립보드에 복사했습니다');
        return;
      }
      if (e.target.closest('#fmDownloadMd')) {
        const mdText = buildArchitectureMarkdown(fp, p, activeCwd);
        const blob = new Blob([mdText], { type: 'text/markdown;charset=utf-8' });
        const a = document.createElement('a');
        const slug = (p?.name || base(activeCwd) || 'architecture').replace(/[^a-zA-Z0-9가-힣_-]+/g, '-');
        a.href = URL.createObjectURL(blob);
        a.download = `${slug}-floorplan-report.md`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1500);
        toast(`산출물 저장 완료: ${a.download}`);
        return;
      }
      const openNodeEl = e.target.closest('[data-fm-open-node]');
      if (openNodeEl) {
        const nid = openNodeEl.dataset.fmOpenNode;
        const n = nodes.find((x) => x.id === nid);
        if (n) openNodeDetailDrawer(n, nodes, edges, p, termCtx, fp, activeCwd);
        return;
      }
      const fixBtn = e.target.closest('[data-fm-fix]');
      if (fixBtn) {
        const it = issues[Number(fixBtn.dataset.fmFix)];
        if (!it) return;
        if (!p) {
          if (termCtx?.onInsertPrompt) termCtx.onInsertPrompt(it.fixPrompt, true);
          else await copyText(it.fixPrompt);
          return;
        }
        fixBtn.disabled = true;
        try {
          const newTask = {
            id: newTaskId(),
            stage: 'planned',
            kind: it.severity === 'critical' || /보안|인증/.test(it.title) ? 'dev' : 'test',
            title: `[점검 수정] ${it.title}`,
            detail: `${it.detail}\n\n[수정 지시]\n${it.fixPrompt}`,
            agent: '', account: null, model: '', effort: '', parentId: '', termId: '', after: [],
          };
          await saveProject({ ...p, tasks: [...p.tasks, newTask] }, 'design');
          toast(`수정 작업 카드를 추가했습니다: ${newTask.title}`);
        } finally {
          if (fixBtn.isConnected) fixBtn.disabled = false;
        }
      }
    };

    paint();
  }

  function projectFloorplan(p, gen, previewCwd = '') {
    return renderFloorplanInto({ host: $('#projectContent'), p, cwd: p?.cwd || '', gen, previewCwd });
  }

  function renderStandaloneFloorplan(cwd, gen, termCtx = null) {
    const view = $('#view');
    if (!view) return;
    view.innerHTML = '<div class="page-wrap" id="standaloneFloorplanHost"></div>';
    return renderFloorplanInto({ host: $('#standaloneFloorplanHost', view), p: null, cwd, gen, termCtx });
  }

  window.projectFloorplan = projectFloorplan;
  window.renderStandaloneFloorplan = renderStandaloneFloorplan;
})();
