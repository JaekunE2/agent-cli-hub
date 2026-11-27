'use strict';

let slashPickerId = 0;

function bindSlashPicker(input, getContext, submit) {
  if (typeof slashCatalog !== 'function' || typeof runHubSlash !== 'function') return null;
  const row = input.parentElement;
  row.classList.add('slash-anchor');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ghost btn-sm slash-trigger';
  button.textContent = '/';
  button.title = '명령어 열기';
  button.setAttribute('aria-label', '명령어 열기');
  const menu = document.createElement('div');
  menu.className = 'slash-menu';
  menu.id = `slash-menu-${++slashPickerId}`;
  menu.setAttribute('role', 'listbox');
  menu.setAttribute('aria-label', '명령어');
  menu.hidden = true;
  for (const el of [input, button]) {
    el.setAttribute('aria-controls', menu.id);
    el.setAttribute('aria-expanded', 'false');
  }
  input.setAttribute('aria-autocomplete', 'list');
  button.setAttribute('aria-haspopup', 'listbox');
  input.before(button);
  row.append(menu);

  let discoveryKey = '', loadedKey = '', discovered = [], choices = [], active = 0, pending = false;
  let openedByButton = false, composing = false;
  const key = () => input.value.match(/^\s*\/([\p{L}\p{N}_.:-]*)$/u)?.[1]?.toLowerCase();
  const requestQuery = () => {
    const { agent, term, sid } = getContext();
    const query = new URLSearchParams({ agent });
    if (term?.id) query.set('termId', term.id);
    if (sid) query.set('sid', sid);
    return String(query);
  };
  const catalog = () => slashCatalog(getContext().agent, requestQuery() === loadedKey ? discovered : []);
  const show = visible => {
    menu.hidden = !visible;
    for (const el of [input, button]) el.setAttribute('aria-expanded', String(visible));
    if (!visible) input.removeAttribute('aria-activedescendant');
  };
  const close = () => { discoveryKey = ''; openedByButton = false; show(false); };
  const setActive = (index, scroll = false) => {
    active = index;
    for (const [i, el] of [...menu.querySelectorAll('[role=option]')].entries()) {
      el.setAttribute('aria-selected', String(i === index));
    }
    const selected = menu.querySelector('[aria-selected=true]');
    if (selected) input.setAttribute('aria-activedescendant', selected.id);
    else input.removeAttribute('aria-activedescendant');
    if (scroll) selected?.scrollIntoView({ block: 'nearest' });
  };
  const render = () => {
    const query = openedByButton ? '' : key();
    if (query === undefined || document.activeElement !== input || composing) return show(false);
    const matches = item => [item.command.slice(1), ...(item.aliases || []), item.description || '']
      .some(text => text.toLowerCase().includes(query));
    choices = catalog().filter(matches).sort((a, b) => {
      if (a.hub !== b.hub) return a.hub ? -1 : 1;
      return Number(b.command.slice(1).toLowerCase().startsWith(query)) - Number(a.command.slice(1).toLowerCase().startsWith(query));
    });
    if (!choices.length) return show(false);
    const { agent } = getContext();
    menu.innerHTML = choices.map((entry, i) => {
      const heading = i === 0 || choices[i - 1].hub !== entry.hub
        ? `<div class="slash-group" aria-hidden="true">${entry.hub ? 'Hub' : esc(providerName(agent))}</div>` : '';
      return `${heading}<div role="option" id="${menu.id}-${i}" data-index="${i}" class="slash-option">
        <strong>${esc(entry.command)}</strong><span>${esc(entry.description || '')}</span>${entry.tui ? '<small>TUI</small>' : ''}
      </div>`;
    }).join('');
    show(true);
    const exact = choices.findIndex(entry => entry === hubSlashEntry(query) || entry.command.slice(1).toLowerCase() === query);
    setActive(Math.max(0, exact), exact > 0);
  };
  const load = () => {
    if (!Object.hasOwn(nativeSlashCommands, getContext().agent)) return;
    const signature = requestQuery();
    if (signature === discoveryKey) return;
    discoveryKey = signature;
    api('/api/slash-commands?' + signature, { requireOk: true }).then(result => {
      if (signature !== discoveryKey || !input.isConnected) return;
      loadedKey = signature;
      discovered = result.commands || [];
      if (!menu.hidden) render();
    }).catch(() => { if (signature === discoveryKey) discoveryKey = ''; });
  };
  const choose = (index, complete = false) => {
    const entry = choices[index];
    if (!entry) return;
    close();
    input.focus();
    input.value = entry.command + (complete || entry.takesArgs ? ' ' : '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    if (!complete && !entry.takesArgs) submit();
  };
  input.addEventListener('input', () => {
    if (composing) return;
    if (/^\s*\//.test(input.value)) load();
    openedByButton = false;
    render();
  });
  input.addEventListener('compositionstart', () => { composing = true; show(false); });
  input.addEventListener('compositionend', () => {
    composing = false;
    if (key() !== undefined) { load(); render(); }
  });
  input.addEventListener('blur', close);
  button.addEventListener('pointerdown', event => event.preventDefault());
  button.onclick = () => {
    if (!menu.hidden) return close();
    input.focus();
    if (!input.value) {
      input.value = '/';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    openedByButton = true;
    load();
    render();
  };
  menu.addEventListener('pointerdown', event => event.preventDefault());
  menu.addEventListener('click', event => {
    const item = event.target.closest('[data-index]');
    if (item) choose(Number(item.dataset.index));
  });
  input.addEventListener('keydown', event => {
    if ((composing || event.isComposing || event.keyCode === 229)
        && event.code === 'Enter' && /^\s*\//.test(input.value)) {
      event.stopImmediatePropagation();
      return;
    }
    if (menu.hidden || event.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    const { key } = event;
    if (!['ArrowDown', 'ArrowUp', 'Escape', 'Enter', 'Tab'].includes(key)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.repeat && key === 'Enter') return;
    if (key === 'Escape') close();
    else if (key === 'Tab' || key === 'Enter') choose(active, key === 'Tab');
    else setActive((active + (key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length, true);
  }, true);
  return {
    native: value => nativeSlashEntry(value, catalog()),
    dispatch() {
      const value = input.value;
      const parsed = slashInput(value);
      const entry = parsed && hubSlashEntry(parsed.key);
      if (!entry) return false;
      if (pending) return true;
      close();
      pending = true;
      const current = () => input.isConnected && input.value === value;
      const ctx = getContext();
      Promise.resolve().then(() => {
        if (current()) return runHubSlash(entry, parsed.args, ctx, current);
      }).then(() => {
        if (!current()) return;
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }).catch(error => toast(error.message, 5000, 'danger')).finally(() => { pending = false; });
      return true;
    },
    close,
  };
}
