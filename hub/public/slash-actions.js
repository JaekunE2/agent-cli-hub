'use strict';

function slashCalendarFields(input) {
  const tokens = input.split(/\s+/).filter(Boolean);
  let date = todayStr();
  if (/^(?:오늘|내일|모레|today|tomorrow)$/i.test(tokens[0])) {
    const at = new Date();
    const day = tokens.shift().toLowerCase();
    at.setDate(at.getDate() + (/^모레$/.test(day) ? 2 : /^(?:내일|tomorrow)$/.test(day) ? 1 : 0));
    date = ymd(at);
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(tokens[0])) {
    date = tokens.shift();
    const parsed = new Date(date + 'T00:00:00');
    if (Number.isNaN(+parsed) || ymd(parsed) !== date) throw new Error('날짜를 YYYY-MM-DD 형식으로 입력하세요.');
  }
  return { date, tokens };
}

async function openSlashSchedule(args, ctx, isCurrent) {
  if (!['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) {
    throw new Error('스케줄 등록은 Hub가 실행 중인 PC에서 사용할 수 있습니다.');
  }
  const [schedules, { projects }] = await Promise.all([scheduleRequest(), api('/api/projects', { requireOk: true })]);
  if (!isCurrent()) return;
  const task = ctx.term?.projectTask;
  const project = projects.find(p => p.id === task?.projectId || p.sessionIds?.includes(ctx.sid)
    || (ctx.term && p.termIds?.some(id => String(id) === String(ctx.term.id))));
  const projectTask = project?.tasks?.find(t => t.id === task?.taskId);
  const capabilities = schedules.capabilities.cli;
  const accountIds = capabilities.find(cli => cli.id === ctx.agent)?.accountIds || [];
  openScheduleForm({
    projects, capabilities, defaults: {
      prompt: args, target: {
        cwd: ctx.cwd, cli: capabilities.some(cli => cli.id === ctx.agent) ? ctx.agent : undefined,
        accountId: accountIds.includes(ctx.accountId) ? ctx.accountId : undefined,
        sessionId: ctx.sid, termId: ctx.term?.exited === null ? ctx.term.id : '',
        sessionLabel: ctx.term ? termLabel(ctx.term) : ctx.sid ? sessionLabel(recentSession(ctx.sid) || { sessionId: ctx.sid }) : '',
        projectId: project?.id, version: projectTask?.version ?? project?.versions?.at(-1)?.number, taskId: projectTask?.id,
      },
    },
  });
}

async function runHubSlash(entry, args, ctx, isCurrent) {
  switch (entry.name) {
    case 'schedule': return openSlashSchedule(args, ctx, isCurrent);
    case 'calendar': {
      const { date, tokens } = slashCalendarFields(args);
      const time = /^(?:[01]?\d|2[0-3]):[0-5]\d$/.test(tokens[0]) ? tokens.shift().padStart(5, '0') : '';
      return calEventDialog({ date, time, title: tokens.join(' ') });
    }
    case 'todo': {
      const { date, tokens } = slashCalendarFields(args);
      const tags = tokens.filter(token => token.startsWith('#'));
      return calTaskDialog(date, { title: tokens.filter(token => !token.startsWith('#')).join(' '), tags: tags.join(' ') });
    }
    case 'app': return window.openAppSlash(args, ctx.cwd, isCurrent);
    case 'branch': {
      if (!ctx.sid) throw new Error('대화 기록이 생긴 세션에서 분기할 수 있습니다.');
      return openBranchDialog({ sid: ctx.sid, agent: ctx.agent, cwd: ctx.cwd });
    }
    case 'switch': {
      if (!ctx.sid && !ctx.term?.id) throw new Error('전환할 세션을 먼저 선택하세요.');
      return openSwitch(ctx.sid || '', ctx.term?.id);
    }
    case 'new': return openNewTermDrawer(ctx.cwd, null, ctx.agent);
    case 'resume': return openCommandPalette(args);
    case 'usage': return select({ kind: 'usage' });
    case 'gpu': return select({ kind: 'gpu' });
    case 'notice': return openSlashNotice(args);
    case 'mcp':
    case 'skills': return select({ kind: 'vault', tab: entry.name });
    case 'model': return ctx.openChatAction('settings', args);
    case 'sidechat': return ctx.openChatAction('sidechat', args);
    case 'snippet': return openSlashSnippetsDrawer(args);
  }
}

function openSlashChatAction(action, args, barHost, chatHost) {
  if (action === 'sidechat' && chatHost?._openSideChat) return chatHost._openSideChat(args);
  const settings = barHost?.querySelector('[data-chat-settings]');
  if (action === 'settings' && settings) {
    if (settings.getAttribute('aria-expanded') === 'false') settings.click();
    barHost.querySelector('[data-chat-model-pick]')?.focus();
    return;
  }
  throw new Error('채팅 창을 먼저 열어 주세요.');
}

function openSlashNotice(text) {
  const drawer = openDrawer({
    title: '허브 공지 등록', width: 440, focus: true,
    bodyHTML: `<label>게시판 공지 <textarea data-slash-notice rows="4" maxlength="2000">${esc(text)}</textarea></label>`,
    footerHTML: '<button data-drw-close>취소</button><button class="primary" data-slash-save>등록</button>',
  });
  const button = $('[data-slash-save]', drawer);
  button.onclick = async () => {
    const value = $('[data-slash-notice]', drawer).value.trim();
    if (!value) return toast('공지 내용을 입력하세요.');
    button.disabled = true;
    try {
      await api('/api/notice', { method: 'POST', body: { text: value, boardOnly: true }, requireOk: true });
      drawer.close();
      toast('공지 게시판에 등록했습니다.');
    } catch (error) { toast(error.message, 5000, 'danger'); }
    finally { button.disabled = false; }
  };
}

async function openSlashSnippetsDrawer(prefillName = '') {
  const drawer = openDrawer({
    title: '사용자 / 프롬프트 스니펫',
    width: 520,
    focus: true,
    bodyHTML: `<form data-sn-form style="display:flex;flex-direction:column;gap:8px;margin-bottom:12px">
      <div class="row" style="gap:8px">
        <input name="name" maxlength="40" placeholder="명령어 (예: 테스트커밋)" value="${esc(String(prefillName || '').replace(/^\/+/, ''))}" style="flex:1" required>
        <input name="title" maxlength="80" placeholder="짧은 설명 (선택)" style="flex:1">
      </div>
      <textarea name="prompt" rows="3" maxlength="8000" placeholder="불러올 프롬프트 내용을 입력하세요" required></textarea>
      <div class="row" style="justify-content:flex-end">
        <button type="submit" class="primary btn-sm">스니펫 저장</button>
      </div>
    </form>
    <div data-sn-list style="display:flex;flex-direction:column;gap:6px"><div class="empty">불러오는 중…</div></div>`,
  });
  const form = $('[data-sn-form]', drawer);
  const listEl = $('[data-sn-list]', drawer);
  const renderList = (snippets = []) => {
    if (!drawer.isConnected) return;
    if (!snippets.length) {
      listEl.innerHTML = '<div class="empty">저장된 스니펫이 없습니다. 위에서 자주 쓰는 프롬프트를 등록해 보세요.</div>';
      return;
    }
    listEl.innerHTML = snippets.map((s) => `<div class="rcard" style="padding:8px 10px;display:flex;align-items:flex-start;justify-content:space-between;gap:8px">
      <div style="min-width:0;flex:1">
        <div><b>/${esc(s.name)}</b>${s.title ? ` <span class="ums">${esc(s.title)}</span>` : ''}</div>
        <div class="ums" style="margin:2px 0 0;white-space:pre-wrap;overflow-wrap:anywhere">${esc(s.prompt.slice(0, 180))}${s.prompt.length > 180 ? '…' : ''}</div>
      </div>
      <button type="button" class="danger ghost icon-btn btn-sm" data-sn-del="${esc(s.name)}" aria-label="삭제">${ICO.trash}</button>
    </div>`).join('');
  };
  const reload = async () => {
    const r = await api('/api/slash-snippets').catch(() => ({ snippets: [] }));
    renderList(r.snippets || []);
  };
  await reload();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    try {
      const r = await api('/api/slash-snippets', {
        method: 'POST',
        body: { name: fd.get('name'), title: fd.get('title'), prompt: fd.get('prompt') },
        requireOk: true,
      });
      form.reset();
      renderList(r.snippets || []);
      toast('프롬프트 스니펫을 저장했습니다.');
    } catch (err) { toast(err.message, 5000, 'danger'); }
  };
  listEl.onclick = async (e) => {
    const del = e.target.closest('[data-sn-del]')?.dataset.snDel;
    if (!del) return;
    try {
      const r = await api('/api/slash-snippets', { method: 'POST', body: { action: 'delete', name: del }, requireOk: true });
      renderList(r.snippets || []);
      toast('스니펫을 삭제했습니다.');
    } catch (err) { toast(err.message, 5000, 'danger'); }
  };
}
