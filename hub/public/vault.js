// Unified Shared Resources (Skills · MCP · Harness) view & CLI inspector UI
'use strict';
(function () {
  let vaultTab = 'skills';
  let skillQuery = '';
  let sourceFilter = 'all'; // 'all' | 'claude' | 'codex' | 'agy' | 'vault'
  let vaultState = null;

  const CLI_LABELS = { claude: 'Claude', codex: 'Codex', agy: 'AGY' };
  const SOURCE_META = [
    { id: 'claude', label: 'Claude Code', icon: () => agentIcon('claude') },
    { id: 'codex', label: 'Codex CLI', icon: () => agentIcon('codex') },
    { id: 'agy', label: 'Antigravity', icon: () => agentIcon('agy') },
    { id: 'shared', label: '공용 · 직접 등록', icon: () => UI_ICO.layers || '' },
  ];

  function primarySourceOf(item) {
    const srcs = Array.isArray(item.sources) ? item.sources : (item.source ? [item.source] : []);
    if (srcs.includes('claude')) return 'claude';
    if (srcs.includes('codex')) return 'codex';
    if (srcs.includes('agy')) return 'agy';
    return 'shared';
  }

  function matchesSourceFilter(item, f) {
    if (f === 'all') return true;
    const srcs = Array.isArray(item.sources) ? item.sources : (item.source ? [item.source] : []);
    if (f === 'vault') return !srcs.some((s) => ['claude', 'codex', 'agy'].includes(s));
    return srcs.includes(f) || (Array.isArray(item.targets) && item.targets.includes(f));
  }

  function switchHTML(kind, id, enabled) {
    const on = !!enabled;
    return `<button type="button" class="sw ${on ? 'on' : ''}" data-v-sw="${esc(kind)}" data-v-id="${esc(id)}" data-on="${on ? 1 : 0}" aria-pressed="${on}" title="이 항목 전체 켜기/끄기"><i></i>${on ? 'ON' : 'OFF'}</button>`;
  }

  function targetPillsHTML(kind, id, selectedTargets, enabled) {
    const sel = new Set(selectedTargets || []);
    const disCls = enabled ? '' : ' dis';
    const scopeTxt = sel.size === 3 ? '전체' : sel.size === 1 ? `${CLI_LABELS[[...sel][0]]} 전용` : sel.size === 0 ? '미적용' : `${sel.size}개 CLI`;
    return `${['claude', 'codex', 'agy'].map((cli) => {
      const active = sel.has(cli);
      return `<button type="button" class="v-cli-pill${active ? ' on' : ''}${disCls}" data-v-tgt="${esc(kind)}" data-v-id="${esc(id)}" data-cli="${cli}" aria-pressed="${active}" title="이 CLI 적용 켜기/끄기">${CLI_LABELS[cli]}</button>`;
    }).join('')}<button type="button" class="ghost btn-sm" data-v-tgt-cycle="${esc(kind)}" data-v-id="${esc(id)}" title="클릭하여 전체 CLI 적용 / 단독 전환" style="min-height:24px;height:24px;padding:0 6px;font-size:11px">${esc(scopeTxt)}</button>`;
  }

  function renderGroupedBySource(items, renderRowFn) {
    if (!items.length) return '';
    if (sourceFilter !== 'all') {
      return `<div class="v-list">${items.map(renderRowFn).join('')}</div>`;
    }
    const groups = new Map(SOURCE_META.map((g) => [g.id, []]));
    for (const it of items) {
      groups.get(primarySourceOf(it)).push(it);
    }
    return SOURCE_META.filter((g) => groups.get(g.id).length > 0).map((g) => {
      const list = groups.get(g.id).slice().sort((a, b) => a.name.localeCompare(b.name));
      return `<section class="v-grp">
        <div class="v-grp-hd">${g.icon()}<span>${esc(g.label)}</span><span class="badge">${list.length}</span></div>
        <div class="v-list">${list.map(renderRowFn).join('')}</div>
      </section>`;
    }).join('');
  }

  function openSkillModal(existing) {
    const d = document.createElement('dialog');
    d.className = 'pj-dialog';
    d.style.width = 'min(640px, 94vw)';
    d.setAttribute('aria-label', existing ? '공통 스킬 수정' : '새 공통 스킬 만들기');
    const initMd = existing
      ? null
      : `---\nname: my-shared-skill\ndescription: Describe when and how Claude, Codex, and AGY should use this skill.\n---\n\n# Instructions\n`;
    const required = new Set(existing?.requiredMcps || []);
    const mcpNames = [...new Set([...(vaultState?.mcps || []).map((mcp) => mcp.name), ...required])];
    d.innerHTML = `<form style="display:flex;flex-direction:column;gap:11px">
      <div class="dlg-head"><h3>${existing ? `스킬 수정 · ${esc(existing.name)}` : '새 공통 스킬 추가'}</h3><button type="button" class="ghost icon-btn btn-sm" data-v-close aria-label="닫기">${UI_ICO.close}</button></div>
      <label>스킬 폴더 이름<input name="name" value="${esc(existing?.name || '')}" ${existing ? 'readonly' : ''} placeholder="my-shared-skill" required></label>
      ${mcpNames.length ? `<label>필수 MCP<select multiple name="requiredMcps">
        ${mcpNames.map((name) => `<option value="${esc(name)}" ${required.has(name) ? 'selected' : ''}>${esc(name)}</option>`).join('')}
      </select></label>` : ''}
      <label>SKILL.md 내용<textarea name="content" rows="12" class="mono" style="font-size:12.5px" required>${esc(existing ? '' : initMd)}</textarea></label>
      <p role="alert" class="pj-error"></p>
      <div class="dlg-foot">
        <button type="button" data-v-close>취소</button>
        <button type="submit" class="primary">공통 자원에 저장</button>
      </div>
    </form>`;
    document.body.append(d);
    d.onclose = () => d.remove();
    d.querySelectorAll('[data-v-close]').forEach((b) => (b.onclick = () => d.close()));
    if (existing) {
      const ta = $('textarea[name="content"]', d);
      ta.value = `---\nname: ${existing.displayName || existing.name}\ndescription: ${existing.description || ''}\n---\n`;
      let edited = false;
      ta.addEventListener('input', () => { edited = true; }, { once: true });
      api('/api/vault/skill?name=' + encodeURIComponent(existing.name))
        .then((r) => {
          if (!edited && typeof r?.content === 'string' && r.content) ta.value = r.content;
        })
        .catch(() => {});
    }
    $('form', d).onsubmit = async (e) => {
      e.preventDefault();
      try {
        const fd = new FormData(e.target);
        const r = await api('/api/vault/skill', {
          method: 'POST',
          body: {
            action: 'save',
            name: String(fd.get('name') || '').trim(),
            content: String(fd.get('content') || ''),
            requiredMcps: fd.getAll('requiredMcps'),
            enabled: existing ? existing.enabled : true,
            targets: existing ? existing.targets : ['claude', 'codex', 'agy'],
            sync: vaultState?.autoLoad !== false,
          },
        });
        if (r.error) throw new Error(r.error);
        vaultState = r.state;
        d.close();
        paintVault();
        toast('스킬을 공통 자원에 저장했습니다');
      } catch (err) {
        $('.pj-error', d).textContent = err.message;
      }
    };
    d.showModal();
  }

  function openMcpModal(existing) {
    const d = document.createElement('dialog');
    d.className = 'pj-dialog';
    d.style.width = 'min(580px, 94vw)';
    d.setAttribute('aria-label', existing ? 'MCP 서버 수정' : '새 MCP 서버 추가');
    const isHttp = existing?.transport === 'http' || !!existing?.url;
    const envLines = Object.entries(existing?.env || {}).map(([k, v]) => `${k}=${v}`).join('\n');
    const hdrLines = Object.entries(existing?.headers || {}).map(([k, v]) => `${k}=${v}`).join('\n');
    d.innerHTML = `<form style="display:flex;flex-direction:column;gap:10px">
      <div class="dlg-head"><h3>${existing ? `MCP 수정 · ${esc(existing.name)}` : '새 공통 MCP 서버 추가'}</h3><button type="button" class="ghost icon-btn btn-sm" data-m-close aria-label="닫기">${UI_ICO.close}</button></div>
      <label>MCP 이름<input name="name" value="${esc(existing?.name || '')}" ${existing ? 'readonly' : ''} placeholder="예: context7, sequential-thinking" required></label>
      <label><input type="checkbox" name="autoEnable" ${existing?.autoEnable ? 'checked' : ''}> 필요한 작업이 시작될 때 자동 활성화 허용</label>
      <label>전송 방식
        <select name="transport" id="vMcpTransport">
          <option value="stdio"${!isHttp ? ' selected' : ''}>Stdio (로컬 실행 명령)</option>
          <option value="http"${isHttp ? ' selected' : ''}>Streamable HTTP (URL)</option>
        </select>
      </label>
      <div id="vMcpStdio" ${isHttp ? 'hidden' : ''} style="display:flex;flex-direction:column;gap:8px">
        <label>실행 명령 (command)<input name="command" value="${esc(existing?.command || '')}" placeholder="예: npx, python, cmd"></label>
        <label>인자 (args · 공백 구분)<input name="args" value="${esc((existing?.args || []).join(' '))}" placeholder="예: -y @modelcontextprotocol/server-sequential-thinking"></label>
        <label>환경 변수 (KEY=VALUE, 줄바꿈 구분 · 기존 비밀값은 유지됨)<textarea name="env" rows="3" class="mono" style="font-size:12px">${esc(envLines)}</textarea></label>
      </div>
      <div id="vMcpHttp" ${!isHttp ? 'hidden' : ''} style="display:flex;flex-direction:column;gap:8px">
        <label>서버 URL<input name="url" value="${esc(existing?.url || '')}" placeholder="https://mcp.example.com/mcp"></label>
        <label>HTTP 헤더 (KEY=VALUE, 줄바꿈 구분)<textarea name="headers" rows="2" class="mono" style="font-size:12px">${esc(hdrLines)}</textarea></label>
      </div>
      <p role="alert" class="pj-error"></p>
      <div class="dlg-foot">
        <button type="button" data-m-close>취소</button>
        <button type="submit" class="primary">MCP 저장</button>
      </div>
    </form>`;
    document.body.append(d);
    d.onclose = () => d.remove();
    d.querySelectorAll('[data-m-close]').forEach((b) => (b.onclick = () => d.close()));
    $('#vMcpTransport', d).onchange = (e) => {
      const h = e.target.value === 'http';
      $('#vMcpStdio', d).hidden = h;
      $('#vMcpHttp', d).hidden = !h;
    };
    const parseKv = (txt) => {
      const out = {};
      for (const line of String(txt || '').split(/\r?\n/)) {
        const i = line.indexOf('=');
        if (i <= 0) continue;
        out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      }
      return out;
    };
    $('form', d).onsubmit = async (e) => {
      e.preventDefault();
      try {
        const fd = new FormData(e.target);
        const isH = fd.get('transport') === 'http';
        const r = await api('/api/vault/mcp', {
          method: 'POST',
          body: {
            action: 'save',
            name: String(fd.get('name') || '').trim(),
            command: isH ? '' : String(fd.get('command') || '').trim(),
            args: isH ? [] : String(fd.get('args') || '').trim().split(/\s+/).filter(Boolean),
            url: isH ? String(fd.get('url') || '').trim() : '',
            env: isH ? null : parseKv(fd.get('env')),
            headers: isH ? parseKv(fd.get('headers')) : null,
            autoEnable: fd.has('autoEnable'),
            enabled: existing ? existing.enabled : true,
            targets: existing ? existing.targets : ['claude', 'codex', 'agy'],
            sync: vaultState?.autoLoad !== false,
          },
        });
        if (r.error) throw new Error(r.error);
        vaultState = r.state;
        d.close();
        paintVault();
        toast('MCP 설정을 공통 자원에 저장했습니다');
      } catch (err) {
        $('.pj-error', d).textContent = err.message;
      }
    };
    d.showModal();
  }

  function openRuleModal(existing) {
    const d = document.createElement('dialog');
    d.className = 'pj-dialog';
    d.style.width = 'min(620px, 94vw)';
    d.setAttribute('aria-label', existing ? '하네스 규칙 수정' : '새 하네스 규칙 추가');
    d.innerHTML = `<form style="display:flex;flex-direction:column;gap:10px">
      <div class="dlg-head"><h3>${existing ? `하네스 · 규칙 수정 (${esc(existing.name)})` : '새 하네스 규칙 추가'}</h3><button type="button" class="ghost icon-btn btn-sm" data-r-close aria-label="닫기">${UI_ICO.close}</button></div>
      <label>규칙 파일명<input name="name" value="${esc(existing?.name || '')}" ${existing ? 'readonly' : ''} placeholder="예: coding-standards.md" required></label>
      <label>규칙 내용 (Markdown)<textarea name="content" rows="11" class="mono" style="font-size:12.5px" required>${esc(existing?.content || '# Shared Rule\n')}</textarea></label>
      <p role="alert" class="pj-error"></p>
      <div class="dlg-foot">
        <button type="button" data-r-close>취소</button>
        <button type="submit" class="primary">규칙 저장</button>
      </div>
    </form>`;
    document.body.append(d);
    d.onclose = () => d.remove();
    d.querySelectorAll('[data-r-close]').forEach((b) => (b.onclick = () => d.close()));
    $('form', d).onsubmit = async (e) => {
      e.preventDefault();
      try {
        const fd = new FormData(e.target);
        const r = await api('/api/vault/harness', {
          method: 'POST',
          body: {
            action: 'save-rule',
            name: String(fd.get('name') || '').trim(),
            content: String(fd.get('content') || ''),
            enabled: existing ? existing.enabled : true,
            targets: existing ? existing.targets : ['claude', 'codex', 'agy'],
            sync: vaultState?.autoLoad !== false,
          },
        });
        if (r.error) throw new Error(r.error);
        vaultState = r.state;
        d.close();
        paintVault();
        toast('하네스 규칙을 저장했습니다');
      } catch (err) {
        $('.pj-error', d).textContent = err.message;
      }
    };
    d.showModal();
  }

  async function saveItemTargets(kind, id, nextEnabled, nextTargets) {
    const list = kind === 'skill' ? vaultState?.skills : kind === 'mcp' ? vaultState?.mcps : vaultState?.rules;
    const targetItem = (list || []).find((x) => x.name === id);
    if (targetItem) {
      targetItem.enabled = !!nextEnabled;
      targetItem.targets = [...nextTargets];
      paintVault();
    }
    const sync = vaultState?.autoLoad !== false;
    let r;
    if (kind === 'skill') {
      r = await api('/api/vault/skill', { method: 'POST', body: { action: 'save', name: id, enabled: nextEnabled, targets: nextTargets, sync } });
    } else if (kind === 'mcp') {
      const cur = (vaultState?.mcps || []).find((x) => x.name === id);
      if (!cur) return;
      r = await api('/api/vault/mcp', { method: 'POST', body: { action: 'save', ...cur, enabled: nextEnabled, targets: nextTargets, sync } });
    } else if (kind === 'rule') {
      r = await api('/api/vault/harness', { method: 'POST', body: { action: 'save-rule', name: id, enabled: nextEnabled, targets: nextTargets, sync } });
    }
    if (r?.error) return toast(r.error, 4000, 'danger');
    if (r?.state) {
      vaultState = r.state;
      paintVault();
    }
  }

  async function openCliInspectDrawer(cliKey) {
    if (typeof openDrawer !== 'function') return;
    const d = openDrawer({
      title: `${CLI_LABELS[cliKey] || cliKey} · 상세 및 공통 자원 가져오기`,
      bodyHTML: '<div class="empty">항목을 불러오는 중…</div>',
      footerHTML: '<button type="button" data-drw-close>닫기</button>',
      width: 640,
    });
    let cliData = null;
    let dTab = 'skills';
    let onlyUnvaulted = false;
    let moveSkills = true;
    let importScope = 'all'; // 'all' | 'only'

    const paintDrawer = () => {
      const drwBody = $('.drw-body', d);
      if (!drwBody || !cliData) return;
      const skills = (cliData.skills || []).filter((s) => !s.isForeignShared && (!onlyUnvaulted || !s.inVault || !s.isLinkedToVault));
      const mcps = (cliData.mcps || []).filter((m) => !m.isForeignShared && (!onlyUnvaulted || !m.inVault));
      const rules = cliData.rules || [];
      const h = cliData.harness || {};
      const unlinkedSkills = (cliData.skills || []).filter((s) => !s.inVault || !s.isLinkedToVault).map((s) => s.name);
      const unvaultedMcps = (cliData.mcps || []).filter((m) => !m.inVault).map((m) => m.name);

      const vaultSkillMap = new Map((vaultState?.skills || []).map((x) => [x.name, x]));
      const vaultMcpMap = new Map((vaultState?.mcps || []).map((x) => [x.name, x]));

      let listHtml = '';
      if (dTab === 'skills') {
        listHtml = skills.length ? skills.map((sk) => {
          const vs = vaultSkillMap.get(sk.name);
          const cliActive = !!(vs && vs.enabled && (vs.targets || []).includes(cliKey));
          const stBadge = sk.isLinkedToVault
            ? '<span class="badge c">링크 연결됨</span>'
            : sk.inVault
              ? '<span class="badge">공통에 등록됨</span>'
              : '<span class="badge lim">로컬 전용</span>';
          const btnLbl = sk.isLinkedToVault ? '다시 연결' : sk.inVault ? '링크 전환' : (moveSkills ? '공통으로 이동' : '가져오기');
          return `<div class="v-row" style="align-items:flex-start">
            <div class="v-row-main">
              <div class="row" style="gap:6px;flex-wrap:wrap">
                <label class="v-en"><input type="checkbox" data-dc-chk="skill" value="${esc(sk.name)}" ${!sk.isLinkedToVault ? 'checked' : ''}><b>${esc(sk.name)}</b></label>
                ${stBadge}
              </div>
              ${sk.description ? `<div class="ums" style="margin:3px 0 0">${esc(sk.description)}</div>` : ''}
              <div class="ums mono" style="margin:2px 0 0;font-size:11px;word-break:break-all">${esc(sk.dir)}</div>
              ${sk.preview ? `<details style="margin-top:4px"><summary class="ums" style="cursor:pointer;margin:0">SKILL.md 내용 보기</summary><pre class="mdpre" style="margin-top:4px;max-height:180px;overflow:auto">${esc(sk.preview)}</pre></details>` : ''}
            </div>
            <div class="v-row-right">
              ${vs ? `<button type="button" class="sw ${cliActive ? 'on' : ''}" data-dc-cli-sw="skill" data-dc-id="${esc(sk.name)}" title="이 CLI에서 켜기/끄기"><i></i>${cliActive ? 'ON' : 'OFF'}</button>` : ''}
              <button type="button" class="btn-sm" data-dc-imp-skill="${esc(sk.name)}">${btnLbl}</button>
            </div>
          </div>`;
        }).join('') : '<div class="empty">표시할 스킬이 없습니다.</div>';
      } else if (dTab === 'mcp') {
        listHtml = mcps.length ? mcps.map((m) => {
          const vm = vaultMcpMap.get(m.name);
          const cliActive = !!(vm && vm.enabled && (vm.targets || []).includes(cliKey));
          const stBadge = m.inVault ? '<span class="badge c">공통에 등록됨</span>' : '<span class="badge lim">로컬 전용</span>';
          return `<div class="v-row">
            <div class="v-row-main">
              <div class="row" style="gap:6px;flex-wrap:wrap">
                <label class="v-en"><input type="checkbox" data-dc-chk="mcp" value="${esc(m.name)}" ${!m.inVault ? 'checked' : ''}><b>${esc(m.name)}</b></label>
                <span class="badge">${esc(m.transport.toUpperCase())}</span>
                ${stBadge}
                ${m.cliOnly ? '<span class="badge">CLI 전용</span>' : ''}
              </div>
              <div class="ums mono" style="margin:2px 0 0">${esc(m.url || `${m.command} ${(m.args || []).join(' ')}`)}</div>
            </div>
            <div class="v-row-right">
              ${vm ? `<button type="button" class="sw ${cliActive ? 'on' : ''}" data-dc-cli-sw="mcp" data-dc-id="${esc(m.name)}" title="이 CLI에서 켜기/끄기"><i></i>${cliActive ? 'ON' : 'OFF'}</button>` : ''}
              <button type="button" class="btn-sm" data-dc-imp-mcp="${esc(m.name)}">${m.inVault ? '대상 추가' : '가져오기'}</button>
            </div>
          </div>`;
        }).join('') : '<div class="empty">표시할 MCP 서버가 없습니다.</div>';
      } else {
        listHtml = `<div class="rcard" style="margin-bottom:10px">
          <div class="row" style="justify-content:space-between;gap:8px;flex-wrap:wrap">
            <div><b>전역 하네스 파일</b><div class="ums mono" style="margin:2px 0 0">${esc(h.path || '없음')}</div></div>
            ${h.hasCustomContent ? `<button type="button" class="primary btn-sm" id="dcImpHarness">${h.customImported ? '공통 지침에 반영됨' : 'shared.md로 가져오기'}</button>` : '<span class="badge">커스텀 지침 없음</span>'}
          </div>
          ${h.customContent ? `<pre class="mdpre" style="max-height:200px;overflow:auto;margin:6px 0 0">${esc(h.customContent)}</pre>` : '<div class="empty" style="padding:8px 0">공통 블록 외의 추가 하네스 내용이 없습니다.</div>'}
        </div>
        <div class="v-list">${rules.length ? rules.map((rl) => `<div class="v-row">
          <div class="v-row-main">
            <div class="row" style="gap:6px">
              <b>${esc(rl.name)}</b>
              <span class="badge ${rl.inVault ? 'c' : 'lim'}">${rl.inVault ? '공통에 등록됨' : '로컬 전용'}</span>
            </div>
            <pre class="mdpre" style="max-height:110px;overflow:auto;margin:4px 0 0">${esc(rl.preview || '')}</pre>
          </div>
          <div class="v-row-right">
            <button type="button" class="btn-sm" data-dc-imp-rule="${esc(rl.name)}">가져오기</button>
          </div>
        </div>`).join('') : '<div class="empty">개별 규칙 파일이 없습니다.</div>'}</div>`;
      }

      drwBody.innerHTML = `<div style="display:flex;flex-direction:column;gap:10px">
        <div class="row" style="justify-content:space-between;gap:8px;flex-wrap:wrap">
          <div class="seg" role="tablist">
            <button type="button" data-dc-tab="skills" class="${dTab === 'skills' ? 'on' : ''}">스킬 (${(cliData.skills || []).length})</button>
            <button type="button" data-dc-tab="mcp" class="${dTab === 'mcp' ? 'on' : ''}">MCP (${(cliData.mcps || []).length})</button>
            <button type="button" data-dc-tab="harness" class="${dTab === 'harness' ? 'on' : ''}">하네스 · 규칙</button>
          </div>
          <div class="row" style="gap:6px">
            ${dTab !== 'harness' ? `<button type="button" class="btn-sm" id="dcImpAll">미등록 전체 가져오기 (${unlinkedSkills.length + unvaultedMcps.length})</button><button type="button" class="primary btn-sm" id="dcImpSel">선택 항목 가져오기</button>` : ''}
          </div>
        </div>
        <div class="row" style="justify-content:space-between;gap:8px;flex-wrap:wrap;padding:6px 9px;border-radius:8px;background:var(--panel2)">
          <span class="ums" style="margin:0">가져온 뒤 적용 대상:</span>
          <div class="seg">
            <button type="button" data-dc-scope="none" class="${importScope === 'none' ? 'on' : ''}">목록만 (미적용)</button>
            <button type="button" data-dc-scope="only" class="${importScope === 'only' ? 'on' : ''}">선택한 CLI에만 적용</button>
            <button type="button" data-dc-scope="all" class="${importScope === 'all' ? 'on' : ''}">모든 CLI 공용</button>
          </div>
        </div>
        <div class="row" style="justify-content:space-between;gap:10px;flex-wrap:wrap">
          <label class="v-en" style="font-size:12px"><input type="checkbox" id="dcMoveChk" ${moveSkills ? 'checked' : ''}><span>가져올 때 원본 스킬 폴더를 공통 링크(Junction)로 이동 전환</span></label>
          <label class="v-en" style="font-size:12px"><input type="checkbox" id="dcUnvaultChk" ${onlyUnvaulted ? 'checked' : ''}><span>미등록 항목만 보기</span></label>
        </div>
        <div class="v-list">${listHtml}</div>
      </div>`;

      const runImport = async (payload) => {
        const targets = importScope === 'only' ? [cliKey] : ['claude', 'codex', 'agy'];
        const enabled = importScope !== 'none';
        const res = await api('/api/vault/import', {
          method: 'POST',
          body: { cli: cliKey, moveSkills, targets, enabled, sync: vaultState?.autoLoad !== false, ...payload },
        });
        if (res.error) return toast(res.error, 4000, 'danger');
        if (res.cliData) cliData = res.cliData;
        if (res.state) { vaultState = res.state; paintVault(); }
        paintDrawer();
        const parts = [];
        if (res.importedSkills) parts.push(`스킬 +${res.importedSkills}`);
        if (res.movedSkills) parts.push(`링크 전환 ${res.movedSkills}`);
        if (res.importedMcps) parts.push(`MCP +${res.importedMcps}`);
        if (res.importedRules) parts.push(`규칙 +${res.importedRules}`);
        if (res.importedHarness) parts.push('하네스 병합');
        toast(parts.length ? `공통 자원 이동 완료: ${parts.join(' · ')}` : '공통 자원 상태를 갱신했습니다');
      };

      $('#dcMoveChk', drwBody).onchange = (e) => { moveSkills = !!e.target.checked; paintDrawer(); };
      $('#dcUnvaultChk', drwBody).onchange = (e) => { onlyUnvaulted = !!e.target.checked; paintDrawer(); };
      if ($('#dcImpSel', drwBody)) {
        $('#dcImpSel', drwBody).onclick = () => {
          const pickedSkills = [...drwBody.querySelectorAll('[data-dc-chk="skill"]:checked')].map((c) => c.value);
          const pickedMcps = [...drwBody.querySelectorAll('[data-dc-chk="mcp"]:checked')].map((c) => c.value);
          if (!pickedSkills.length && !pickedMcps.length) return toast('가져올 항목을 선택하세요', 2500);
          runImport({ skills: pickedSkills, mcps: pickedMcps });
        };
      }
      if ($('#dcImpAll', drwBody)) {
        $('#dcImpAll', drwBody).onclick = () => runImport({ skills: unlinkedSkills, mcps: unvaultedMcps });
      }
      if ($('#dcImpHarness', drwBody)) {
        $('#dcImpHarness', drwBody).onclick = () => runImport({ importHarness: true });
      }
      drwBody.onclick = async (e) => {
        const tb = e.target.closest('[data-dc-tab]');
        if (tb) { dTab = tb.dataset.dcTab; paintDrawer(); return; }
        const scb = e.target.closest('[data-dc-scope]');
        if (scb) { importScope = scb.dataset.dcScope; paintDrawer(); return; }
        const cliSw = e.target.closest('[data-dc-cli-sw]');
        if (cliSw) {
          const kind = cliSw.dataset.dcCliSw;
          const id = cliSw.dataset.dcId;
          const item = (kind === 'skill' ? vaultSkillMap : vaultMcpMap).get(id);
          if (!item) return;
          const curTgt = new Set(item.targets || []);
          let nextEnabled = item.enabled;
          if (curTgt.has(cliKey) && item.enabled) curTgt.delete(cliKey);
          else { curTgt.add(cliKey); nextEnabled = true; }
          await saveItemTargets(kind, id, nextEnabled, [...curTgt]);
          const ref = await api('/api/vault/cli?cli=' + encodeURIComponent(cliKey)).catch(() => null);
          if (ref?.cliData) cliData = ref.cliData;
          paintDrawer();
          return;
        }
        const skb = e.target.closest('[data-dc-imp-skill]');
        if (skb) { runImport({ skills: [skb.dataset.dcImpSkill] }); return; }
        const mcb = e.target.closest('[data-dc-imp-mcp]');
        if (mcb) { runImport({ mcps: [mcb.dataset.dcImpMcp] }); return; }
        const rlb = e.target.closest('[data-dc-imp-rule]');
        if (rlb) { runImport({ rules: [rlb.dataset.dcImpRule] }); }
      };
    };

    try {
      const r = await api('/api/vault/cli?cli=' + encodeURIComponent(cliKey));
      cliData = r.cliData;
      paintDrawer();
    } catch (e) {
      const drwBody = $('.drw-body', d);
      if (drwBody) drwBody.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    }
  }

  function paintVault() {
    const st = vaultState;
    if (!st) return;
    const clis = st.clis || {};
    const skills = st.skills || [];
    const mcps = st.mcps || [];
    const rules = st.rules || [];

    const filteredSkills = skills.filter((s) => {
      if (!matchesSourceFilter(s, sourceFilter)) return false;
      if (!skillQuery) return true;
      return (`${s.name} ${s.description}`).toLowerCase().includes(skillQuery.toLowerCase());
    });
    const filteredMcps = mcps.filter((m) => matchesSourceFilter(m, sourceFilter));

    const countBySource = (list) => ({
      all: list.length,
      claude: list.filter((x) => matchesSourceFilter(x, 'claude')).length,
      codex: list.filter((x) => matchesSourceFilter(x, 'codex')).length,
      agy: list.filter((x) => matchesSourceFilter(x, 'agy')).length,
      vault: list.filter((x) => matchesSourceFilter(x, 'vault')).length,
    });
    const srcCounts = countBySource(vaultTab === 'mcp' ? mcps : skills);
    const sourceStripHTML = `<div class="seg" role="tablist" aria-label="명칭 · 출처별 필터">
      <button type="button" data-vsrc="all" class="${sourceFilter === 'all' ? 'on' : ''}">전체 (${srcCounts.all})</button>
      <button type="button" data-vsrc="claude" class="${sourceFilter === 'claude' ? 'on' : ''}">Claude (${srcCounts.claude})</button>
      <button type="button" data-vsrc="codex" class="${sourceFilter === 'codex' ? 'on' : ''}">Codex (${srcCounts.codex})</button>
      <button type="button" data-vsrc="agy" class="${sourceFilter === 'agy' ? 'on' : ''}">AGY (${srcCounts.agy})</button>
      <button type="button" data-vsrc="vault" class="${sourceFilter === 'vault' ? 'on' : ''}">직접 추가 (${srcCounts.vault})</button>
    </div>`;

    const cliCards = ['claude', 'codex', 'agy'].map((k) => {
      const c = clis[k] || {};
      return `<button type="button" class="h-stat v-cli-card" data-v-cli="${k}" title="스킬 · MCP · 하네스 목록 열기 및 가져오기">
        <div class="h-stat-lbl"><span>${agentIcon(k)} ${esc(c.label || k)}</span><span class="badge ${c.hasHarness ? 'c' : ''}">${c.hasHarness ? '하네스 연결' : '미설정'}</span></div>
        <div class="h-stat-val" style="font-size:16px">로컬 스킬 ${c.skillsCount || 0} · MCP ${c.mcpCount || 0}</div>
        <div class="h-stat-sub mono" title="${esc(c.skillDir || '')}">${esc(c.skillDir || '')}</div>
        <div class="v-cli-hint">눌러서 보기 · 가져오기 ↗</div>
      </button>`;
    }).join('');

    let tabBody = '';
    if (vaultTab === 'skills') {
      const renderSkillRow = (sk) => `<div class="v-row${sk.enabled ? '' : ' off'}">
        <div class="v-row-main">
          <div class="row" style="gap:6px;flex-wrap:wrap">
            <b>${esc(sk.name)}</b>
            ${(sk.sources || []).map((src) => `<span class="badge">${esc(src)}</span>`).join('')}
          </div>
          ${sk.description ? `<div class="ums" style="margin:2px 0 0">${esc(sk.description)}</div>` : ''}
        </div>
        <div class="v-row-right">
          <div class="v-tgts">${targetPillsHTML('skill', sk.name, sk.targets, sk.enabled)}</div>
          ${switchHTML('skill', sk.name, sk.enabled)}
          <button type="button" class="btn-sm" data-v-edit-skill="${esc(sk.name)}">${UI_ICO.edit} 수정</button>
          <button type="button" class="ghost icon-btn btn-sm" data-v-del="skill" data-v-id="${esc(sk.name)}" title="공통 자원에서 삭제">${UI_ICO.trash}</button>
        </div>
      </div>`;
      tabBody = `<div class="row" style="justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:10px">
        ${sourceStripHTML}
        <div class="row" style="gap:6px;flex-wrap:wrap">
          <input id="vSkillSearch" type="search" value="${esc(skillQuery)}" placeholder="스킬 이름 · 설명 필터…" style="max-width:220px">
          <button type="button" class="primary btn-sm" id="vNewSkill">${UI_ICO.plus} 새 공통 스킬</button>
        </div>
      </div>
      ${filteredSkills.length ? renderGroupedBySource(filteredSkills, renderSkillRow) : '<div class="empty">표시할 스킬이 없습니다. 공통 자원 설정에서 CLI 스킬을 가져올 수 있습니다.</div>'}`;
    } else if (vaultTab === 'mcp') {
      const renderMcpRow = (m) => `<div class="v-row${m.enabled ? '' : ' off'}">
        <div class="v-row-main">
          <div class="row" style="gap:6px;flex-wrap:wrap">
            <b>${esc(m.name)}</b>
            <span class="badge">${esc(m.transport.toUpperCase())}</span>
            ${m.source ? `<span class="badge">${esc(m.source)}</span>` : ''}
            ${m.cliOnly ? `<span class="badge lim">전용</span>` : ''}
          </div>
          <div class="ums mono" style="margin:2px 0 0">${esc(m.url || `${m.command} ${(m.args || []).join(' ')}`)}</div>
        </div>
        <div class="v-row-right">
          <div class="v-tgts">${targetPillsHTML('mcp', m.name, m.targets, m.enabled)}</div>
          ${switchHTML('mcp', m.name, m.enabled)}
          <button type="button" class="btn-sm" data-v-edit-mcp="${esc(m.name)}">${UI_ICO.edit} 수정</button>
          <button type="button" class="ghost icon-btn btn-sm" data-v-del="mcp" data-v-id="${esc(m.name)}" title="삭제">${UI_ICO.trash}</button>
        </div>
      </div>`;
      tabBody = `<div class="row" style="justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:10px">
        ${sourceStripHTML}
        <button type="button" class="primary btn-sm" id="vNewMcp">${UI_ICO.plus} MCP 추가</button>
      </div>
      <div class="ums" style="margin:0 0 8px">한 번 등록하면 Claude · Codex · Antigravity 형식으로 자동 변환되며, 스위치와 CLI 버튼으로 개별/전용 적용할 수 있습니다.</div>
      ${filteredMcps.length ? renderGroupedBySource(filteredMcps, renderMcpRow) : '<div class="empty">표시할 MCP 서버가 없습니다.</div>'}`;
    } else {
      tabBody = `<div class="rcard" style="margin-bottom:12px">
        <div class="row" style="justify-content:space-between;gap:8px">
          <b>공통 하네스 지침 (shared.md → CLAUDE.md · AGENTS.md · GEMINI.md)</b>
          <button type="button" class="primary btn-sm" id="vSaveShared">공통 지침 저장</button>
        </div>
        <textarea id="vSharedHarness" rows="6" style="font-size:13px">${esc(st.sharedHarness || '')}</textarea>
      </div>
      <div class="row" style="justify-content:space-between;gap:8px;margin-bottom:8px">
        <b>하네스 규칙 파일 (${rules.length}개)</b>
        <button type="button" class="btn-sm" id="vNewRule">${UI_ICO.plus} 규칙 추가</button>
      </div>
      <div class="v-list">${rules.length ? rules.map((r) => `<div class="v-row${r.enabled ? '' : ' off'}">
        <div class="v-row-main">
          <div class="row" style="gap:6px">
            <b>${esc(r.name)}</b>
            <span class="badge">${esc(r.source)}</span>
          </div>
          <div class="ums" style="margin:2px 0 0">${esc(String(r.content || '').replace(/\s+/g, ' ').slice(0, 120))}</div>
        </div>
        <div class="v-row-right">
          <div class="v-tgts">${targetPillsHTML('rule', r.name, r.targets, r.enabled)}</div>
          ${switchHTML('rule', r.name, r.enabled)}
          <button type="button" class="btn-sm" data-v-edit-rule="${esc(r.name)}">${UI_ICO.edit} 수정</button>
          <button type="button" class="ghost icon-btn btn-sm" data-v-del="rule" data-v-id="${esc(r.name)}" title="삭제">${UI_ICO.trash}</button>
        </div>
      </div>`).join('') : '<div class="empty">수집된 추가 규칙 파일이 없습니다.</div>'}</div>`;
    }

    const body = $('#vaultBody');
    if (!body) return;
    const settingsOpen = $('#vSettings', body)?.open;
    body.innerHTML = `<div class="vault-toolbar"><div class="seg" role="tablist" aria-label="공통 자원">
      <button type="button" role="tab" data-vtab="skills" aria-selected="${vaultTab === 'skills'}" class="${vaultTab === 'skills' ? 'on' : ''}">스킬 (${skills.length})</button>
      <button type="button" role="tab" data-vtab="mcp" aria-selected="${vaultTab === 'mcp'}" class="${vaultTab === 'mcp' ? 'on' : ''}">MCP 서버 (${mcps.length})</button>
      <button type="button" role="tab" data-vtab="harness" aria-selected="${vaultTab === 'harness'}" class="${vaultTab === 'harness' ? 'on' : ''}">하네스 · 규칙 (${rules.length + 1})</button>
    </div>
    <details id="vSettings" class="v-settings"${settingsOpen ? ' open' : ''}>
    <summary>공통 자원 설정</summary>
    <div class="rcard">
      <div class="row">
        <button type="button" class="btn-sm" id="vGatherBtn">${UI_ICO.refresh} 모든 CLI → 공통 자원으로 가져오기</button>
        <button type="button" class="btn-sm" id="vSyncAllBtn">${UI_ICO.swap} 공통 자원 → 모든 CLI로 동기화</button>
      </div>
      <div class="row" style="justify-content:space-between;gap:10px;flex-wrap:wrap">
        <div style="min-width:0;flex:1">
          <div style="font-weight:700;font-size:14.5px">공통 자원 경로 (Shared Path)</div>
          <div class="mono ums" style="margin:3px 0 0;word-break:break-all">${esc(st.vaultDir)}</div>
        </div>
        <div class="row" style="gap:6px;flex-wrap:wrap">
          <button type="button" class="btn-sm" id="vPickDir">${UI_ICO.folder} 경로 변경</button>
          ${!IS_REMOTE ? `<button type="button" class="btn-sm" id="vOpenDir">${UI_ICO.external} 폴더 열기</button>` : ''}
        </div>
      </div>
      <label class="v-en" style="font-size:12.5px;padding:6px 10px;border-radius:8px;background:color-mix(in srgb,var(--accent) 8%,var(--panel));border:1px solid color-mix(in srgb,var(--accent) 24%,var(--line))">
        <input type="checkbox" id="vAutoLoadChk" ${st.autoLoad !== false ? 'checked' : ''}>
        <span><b>허브에서 CLI 실행 시 공통 자원 자동 로드</b> · Claude · Codex · Antigravity 실행할 때 공통 스킬 · MCP · 하네스를 자동으로 불러옵니다</span>
      </label>
      <div class="h-stats v-cli-grid">${cliCards}</div>
    </div>
    </details></div>
    ${tabBody}`;

    $('#vPickDir', body).onclick = () => {
      if (typeof openFolderPickerDialog !== 'function') return;
      openFolderPickerDialog(st.vaultDir, async (chosen) => {
        const r = await api('/api/vault/dir', { method: 'POST', body: { vaultDir: chosen } });
        if (r.error) return toast(r.error, 4000, 'danger');
        vaultState = r.state;
        paintVault();
        toast('공통 자원 경로를 변경했습니다');
      });
    };
    const autoChk = $('#vAutoLoadChk', body);
    if (autoChk) {
      autoChk.onchange = async () => {
        const r = await api('/api/vault/autoload', { method: 'POST', body: { enabled: !!autoChk.checked } });
        if (r.error) return toast(r.error, 4000, 'danger');
        vaultState = r.state;
        toast(autoChk.checked ? 'CLI 실행 시 공통 자원을 자동 로드합니다' : 'CLI 실행 시 자동 로드를 껐습니다');
      };
    }
    const openBtn = $('#vOpenDir', body);
    if (openBtn) openBtn.onclick = () => api('/api/vault/open-dir', { method: 'POST' });

    const gatherBtn = $('#vGatherBtn', body);
    if (gatherBtn) gatherBtn.onclick = async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        const r = await api('/api/vault/gather', { method: 'POST' });
        if (r.error) throw new Error(r.error);
        vaultState = r.state;
        paintVault();
        toast(`수집 완료: 스킬 +${r.addedSkills}, MCP +${r.addedMcps}, 규칙 +${r.addedRules}`);
      } catch (err) { toast(err.message, 5000, 'danger'); }
      finally { if (btn.isConnected) btn.disabled = false; }
    };

    const syncAllBtn = $('#vSyncAllBtn', body);
    if (syncAllBtn) syncAllBtn.onclick = async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        const r = await api('/api/vault/sync', { method: 'POST', body: { clis: ['claude', 'codex', 'agy'] } });
        if (r.error) throw new Error(r.error);
        vaultState = r.state;
        paintVault();
        toast('Claude · Codex · Antigravity에 스킬 · MCP · 하네스를 동기화했습니다');
      } catch (err) { toast(err.message, 5000, 'danger'); }
      finally { if (btn.isConnected) btn.disabled = false; }
    };

    const skillSearch = $('#vSkillSearch', body);
    if (skillSearch) {
      skillSearch.oninput = skillSearch.oncompositionend = (e) => {
        if (e.isComposing || e.currentTarget.value === skillQuery) return;
        const { value, selectionStart, selectionEnd } = e.currentTarget;
        skillQuery = value;
        paintVault();
        const search = $('#vSkillSearch', body);
        search.focus({ preventScroll: true });
        search.setSelectionRange(selectionStart, selectionEnd);
      };
    }
    if ($('#vNewSkill', body)) $('#vNewSkill', body).onclick = () => openSkillModal(null);
    if ($('#vNewMcp', body)) $('#vNewMcp', body).onclick = () => openMcpModal(null);
    if ($('#vNewRule', body)) $('#vNewRule', body).onclick = () => openRuleModal(null);
    if ($('#vSaveShared', body)) {
      $('#vSaveShared', body).onclick = async () => {
        const shared = $('#vSharedHarness', body).value;
        const r = await api('/api/vault/harness', { method: 'POST', body: { action: 'save-shared', shared, sync: vaultState?.autoLoad !== false } });
        if (r.error) return toast(r.error, 4000, 'danger');
        vaultState = r.state;
        toast('공통 하네스 지침을 저장했습니다');
      };
    }

    const findItem = (kind, id) => {
      const list = kind === 'skill' ? vaultState?.skills : kind === 'mcp' ? vaultState?.mcps : vaultState?.rules;
      return (list || []).find((x) => x.name === id) || null;
    };

    body.onclick = async (e) => {
      const cliBtn = e.target.closest('[data-v-cli]');
      if (cliBtn) { openCliInspectDrawer(cliBtn.dataset.vCli); return; }
      const tb = e.target.closest('[data-vtab]');
      if (tb) { vaultTab = tb.dataset.vtab; paintVault(); return; }
      const sb = e.target.closest('[data-vsrc]');
      if (sb) { sourceFilter = sb.dataset.vsrc; paintVault(); return; }

      const swBtn = e.target.closest('[data-v-sw]');
      if (swBtn) {
        const kind = swBtn.dataset.vSw;
        const id = swBtn.dataset.vId;
        const item = findItem(kind, id);
        if (!item) return;
        await saveItemTargets(kind, id, !item.enabled, item.targets || ['claude', 'codex', 'agy']);
        return;
      }

      const tgtBtn = e.target.closest('[data-v-tgt]');
      if (tgtBtn) {
        const kind = tgtBtn.dataset.vTgt;
        const id = tgtBtn.dataset.vId;
        const cli = tgtBtn.dataset.cli;
        const item = findItem(kind, id);
        if (!item) return;
        const set = new Set(item.targets || []);
        if (set.has(cli)) set.delete(cli); else set.add(cli);
        await saveItemTargets(kind, id, item.enabled, [...set]);
        return;
      }

      const cycBtn = e.target.closest('[data-v-tgt-cycle]');
      if (cycBtn) {
        const kind = cycBtn.dataset.vTgtCycle;
        const id = cycBtn.dataset.vId;
        const item = findItem(kind, id);
        if (!item) return;
        const all = ['claude', 'codex', 'agy'];
        const cur = item.targets || [];
        const srcCli = ['claude', 'codex', 'agy'].find((c) => (item.sources || [item.source]).includes(c)) || 'claude';
        const next = cur.length < 3 ? all : [srcCli];
        await saveItemTargets(kind, id, true, next);
        return;
      }

      const editSkill = e.target.closest('[data-v-edit-skill]');
      if (editSkill) {
        const sk = (vaultState?.skills || []).find((x) => x.name === editSkill.dataset.vEditSkill);
        if (sk) openSkillModal(sk);
        return;
      }
      const editMcp = e.target.closest('[data-v-edit-mcp]');
      if (editMcp) {
        const m = (vaultState?.mcps || []).find((x) => x.name === editMcp.dataset.vEditMcp);
        if (m) openMcpModal(m);
        return;
      }
      const editRule = e.target.closest('[data-v-edit-rule]');
      if (editRule) {
        const rl = (vaultState?.rules || []).find((x) => x.name === editRule.dataset.vEditRule);
        if (rl) openRuleModal(rl);
        return;
      }
      const del = e.target.closest('[data-v-del]');
      if (del) {
        const kind = del.dataset.vDel;
        const id = del.dataset.vId;
        if (!confirm(`"${id}" 항목을 공통 자원에서 삭제할까요?`)) return;
        const endpoint = kind === 'skill' ? '/api/vault/skill' : kind === 'mcp' ? '/api/vault/mcp' : '/api/vault/harness';
        const action = kind === 'rule' ? 'delete-rule' : 'delete';
        const r = await api(endpoint, { method: 'POST', body: { action, name: id, sync: vaultState?.autoLoad !== false } });
        if (r.error) return toast(r.error, 4000, 'danger');
        vaultState = r.state;
        paintVault();
        toast('공통 자원에서 삭제했습니다');
      }
    };
  }

  async function viewVault() {
    const gen = viewGen;
    setBar('');
    $('#view').innerHTML = `<div class="sys-shell">${systemTopHTML('vault')}<div class="sys-body"><div class="page-wrap" id="vaultBody"><div class="empty">공통 자원 정보를 불러오는 중…</div></div></div></div>`;
    $('#view').onclick = (e) => {
      const st = e.target.closest('[data-systab]');
      if (st) return select({ kind: st.dataset.systab });
    };
    try {
      vaultState = await api('/api/vault');
      if (gen !== viewGen) return;
      paintVault();
    } catch (e) {
      const b = $('#vaultBody');
      if (b) b.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    }
  }

  window.viewVault = viewVault;
})();
