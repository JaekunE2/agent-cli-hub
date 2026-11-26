'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { parseAgyQuotaTui } = require('./agy-quota');

/** Create system, usage, account-switching, subsystem proxy, and Unified Vault routes. */
function createSystemRoutes(hub) {
  const { baseDir, token, config, I18N, unifiedVault, accountPrefs, index } = hub;
  const localDesktop = (req) => !req.headers.origin &&
    req.socket.localAddress === '127.0.0.1' && req.socket.remoteAddress === '127.0.0.1';
  let desktopStopping = false;

  async function handleSystemRoutes(p, url, req, res, body, send, authed) {
    if (!authed(req, url)) { send(res, 401, { error: 'bad token' }); return true; }

    if (p === '/api/open-url' && req.method === 'POST') {
      const addr = req.socket?.remoteAddress || '';
      const isLocal = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(addr);
      if (!isLocal) { send(res, 403, { error: '로컬 PC에서만 외부 브라우저를 열 수 있습니다.' }); return true; }
      const b = await body(req);
      let parsed;
      try { parsed = new URL(String(b.url || '').trim()); } catch { parsed = null; }
      if (!parsed || !['http:', 'https:'].includes(parsed.protocol)) {
        send(res, 400, { error: 'http:// 또는 https:// 주소만 열 수 있습니다.' });
        return true;
      }
      const href = parsed.href;
      try {
        if (process.platform === 'win32') {
          spawn('cmd.exe', ['/c', 'start', '', href], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
        } else if (process.platform === 'darwin') {
          spawn('open', [href], { detached: true, stdio: 'ignore' }).unref();
        } else {
          spawn('xdg-open', [href], { detached: true, stdio: 'ignore' }).unref();
        }
        send(res, 200, { ok: true, url: href });
      } catch (e) {
        send(res, 500, { error: e.message });
      }
      return true;
    }

    if (p === '/api/services/usage/start' && req.method === 'POST') {
      const r = await hub.startUsageServer();
      send(res, r.ok ? 200 : 502, r);
      return true;
    }
    if (p === '/api/services/tray' && req.method === 'POST') {
      send(res, 200, { ok: hub.ensureTrayMonitor() });
      return true;
    }
    if (p === '/api/notices') {
      send(res, 200, { notices: hub.readNotices(Number(url.searchParams.get('n')) || 20) });
      return true;
    }
    if (p === '/api/notice' && req.method === 'POST') {
      const b = await body(req);
      const text = String(b.text || '').trim().slice(0, 2000);
      if (!text) { send(res, 400, { error: '공지 내용이 비어 있습니다' }); return true; }
      send(res, 200, await hub.postNotice({ text, to: b.to || 'all', boardOnly: !!b.boardOnly, fromPid: Number(b.fromPid) || 0 }));
      return true;
    }
    if (p === '/api/operator') {
      const oc = config.operator || {};
      const payload = (t) => ({
        enabled: oc.enabled !== false,
        agent: ['claude', 'codex', 'agy'].includes(oc.agent) ? oc.agent : 'claude',
        model: oc.model || '',
        effort: oc.effort || '',
        checkEveryMin: Number(oc.checkEveryMin ?? 180),
        skipPermissions: oc.skipPermissions !== false,
        noticeDeliver: oc.noticeDeliver === true,
        hasCustomCommand: Array.isArray(oc.command) && oc.command.length > 0,
        term: t ? hub.termInfo(t) : null,
        dir: hub.OPERATOR_DIR,
      });
      if (req.method === 'POST') {
        const b = await body(req);
        if (b && ['agent', 'model', 'effort', 'enabled', 'checkEveryMin', 'skipPermissions', 'noticeDeliver'].some((k) => Object.hasOwn(b, k))) {
          hub.saveOperatorConfig?.(b);
        }
        const cur = hub.operatorTerm();
        if (b?.action === 'stop') {
          if (cur) { hub.forgetTerm?.(cur); hub.overviewStale?.(); }
          send(res, 200, { ok: true, ...payload(hub.operatorTerm()) });
          return true;
        }
        if ((b?.restart || b?.action === 'restart') && cur) {
          hub.forgetTerm?.(cur);
          hub.overviewStale?.();
          await new Promise((r) => setTimeout(r, 350));
        }
        if (b?.action === 'save') {
          send(res, 200, { ok: true, ...payload(hub.operatorTerm()) });
          return true;
        }
        const t = await hub.ensureOperator(true);
        send(res, t ? 200 : 500, t ? { ok: true, ...payload(t) } : { error: '관제 세션을 시작하지 못했습니다 (선택한 CLI 설치 경로를 확인하세요)' });
        return true;
      }
      send(res, 200, payload(hub.operatorTerm()));
      return true;
    }
    if (p === '/api/usage') {
      send(res, 200, await hub.aiUsage(url.searchParams.has('force')));
      return true;
    }
    if (p === '/api/usage/accounts') {
      try {
        if (req.method === 'GET') {
          send(res, 200, await (await fetch(`${hub.USAGE_URL}/api/accounts`, { signal: AbortSignal.timeout(10_000) })).json());
          return true;
        }
        const b = await body(req);
        const del = b.action === 'delete';
        const r = await fetch(del ? `${hub.USAGE_URL}/api/accounts/${encodeURIComponent(b.id)}` : `${hub.USAGE_URL}/api/accounts`, {
          method: del ? 'DELETE' : 'POST', headers: { 'content-type': 'application/json', 'x-dashboard': '1' },
          body: del ? undefined : JSON.stringify(b.account || {}), signal: AbortSignal.timeout(15_000),
        });
        hub.clearUsageCache();
        send(res, r.status, await r.json());
      } catch (e) {
        send(res, 502, { error: `AI 사용량 대시보드(${hub.USAGE_URL})에 연결할 수 없음: ${e.message}` });
      }
      return true;
    }
    if (p === '/api/switch/candidates') {
      const info = await hub.allSwitchCandidates({ sessionId: url.searchParams.get('id') || '', termId: url.searchParams.get('term') || '' });
      send(res, 200, { ...info, accountPrefs: accountPrefs.get() });
      return true;
    }
    if (p === '/api/switch' && req.method === 'POST') {
      send(res, 200, await hub.switchAccount(await body(req)));
      return true;
    }
    if (p === '/api/remote') {
      const info = hub.remoteInfo();
      const target = info.urls[0] ? `${info.urls[0]}?t=${token}` : null;
      const qr = target ? await require('qrcode').toString(target, { type: 'svg', margin: 1, width: 240 }) : null;
      send(res, 200, { ...info, qr, target });
      return true;
    }
    if (p === '/api/restart-guard') {
      if (hub.getPtyHostPid()) {
        send(res, 200, { atRisk: [], terms: hub.terms.size, note: 'terminals live in the pty host and survive a server restart' });
        return true;
      }
      const table = await hub.procTable();
      const termPids = new Set([...hub.terms.values()].filter((t) => t.exited === null && t.pid).map((t) => t.pid));
      const atRisk = [];
      for (const t of hub.gpuQ().snapshot().active) {
        if (t.detachedJob || t.survived) continue;
        const roots = [t.holderPid, t.childPid, ...(t.holderPids || [])].filter(Boolean);
        const inTerm = roots.some((pid) => {
          for (let cur = pid, i = 0; cur && i < 30; i++) { if (termPids.has(cur)) return true; cur = table?.get(cur)?.ppid; }
          return false;
        });
        if (inTerm) atRisk.push({ id: t.id, label: t.label, by: t.requester?.title || null });
      }
      send(res, 200, { atRisk, terms: termPids.size, tableOk: !!table });
      return true;
    }
    if (p === '/api/admin/reload' && req.method === 'POST') {
      const b = await body(req);
      try { send(res, 200, { ok: true, reloaded: hub.reloadModules(b.modules || ['gpu', 'research']) }); }
      catch (e) { send(res, 500, { ok: false, error: `reload failed (old modules kept): ${e.message}` }); }
      return true;
    }
    if (p === '/api/lang') {
      if (req.method !== 'POST') { send(res, 200, { lang: I18N.language() }); return true; }
      const b = await body(req);
      const lang = b.lang === 'en' ? 'en' : 'ko';
      const f = path.join(baseDir, 'config.json');
      let c = {}; try { c = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
      c.lang = lang; fs.writeFileSync(f, JSON.stringify(c, null, 2) + '\n');
      send(res, 200, { ok: true, lang, restarting: true });
      spawn(process.execPath, [path.join(baseDir, 'ccd.js'), 'restart'], { cwd: baseDir, detached: true, stdio: 'ignore', windowsHide: true }).unref();
      return true;
    }
    if (p === '/api/desktop/identity' && req.method === 'GET') {
      if (!localDesktop(req)) send(res, 403, { error: 'Local launcher only.' });
      else send(res, 200, { pid: process.pid, ptyPid: hub.getPtyHostPid(), ptyPort: hub.ptyPort });
      return true;
    }
    if ((p === '/api/shutdown' || p === '/api/desktop/shutdown') && req.method === 'POST') {
      if (p === '/api/desktop/shutdown') {
        const expectedPid = req.headers['x-ccd-desktop-pid'];
        if (!localDesktop(req) || expectedPid !== String(process.pid)) {
          send(res, 409, { error: 'The verified Hub process no longer owns the connection.' });
          return true;
        }
        if (desktopStopping) {
          send(res, 409, { error: 'Hub shutdown is already in progress.' });
          return true;
        }
        desktopStopping = true;
        try {
          const { ptyPid, stopPty } = await body(req);
          if (typeof stopPty !== 'boolean') throw new Error('Invalid shutdown mode.');
          const current = await hub.ptyCall('/info');
          if (!Number.isSafeInteger(ptyPid) || ptyPid !== current.pid || ptyPid !== hub.getPtyHostPid()) {
            throw new Error('The verified PTY host changed. Retry after it reconnects.');
          }
          if (stopPty === true) {
            const result = await hub.ptyCall('/shutdown-if-idle', { expectedPid: ptyPid });
            if (!result.ok) throw new Error(result.error || 'The PTY host refused shutdown.');
          }
        } catch (error) {
          desktopStopping = false;
          send(res, 200, { ok: false, error: error.message });
          return true;
        }
      }
      send(res, 200, { ok: true, terms: hub.terms.size });
      setTimeout(() => process.exit(0), 300);
      try { index.save(true); } catch (error) { console.error('[shutdown] search cache:', error.message); }
      return true;
    }
    if (p === '/api/locate' && req.method === 'POST') {
      const b = await body(req);
      send(res, 200, { path: hub.locateFile({ name: String(b.name || ''), size: Number(b.size), mtime: Number(b.mtime) || 0, cwd: b.cwd }) });
      return true;
    }
    if (p === '/api/upload' && req.method === 'POST') {
      send(res, 200, { path: await hub.saveUpload(req, url.searchParams.get('name')) });
      return true;
    }
    if (p === '/api/codex/add' && req.method === 'POST') {
      const t = hub.createTerm({ cwd: baseDir, cmd: process.execPath, args: ['--use-system-ca', path.join(baseDir, 'ccd.js'), 'codex', 'add'], title: 'Codex 계정 추가' });
      send(res, 200, hub.termInfo(t));
      return true;
    }
    if (p === '/api/agy/add' && req.method === 'POST') {
      const swapExe = hub.agySwapExe();
      if (!swapExe) { send(res, 400, { error: 'agy-swap이 설치되어 있지 않습니다.' }); return true; }
      const t = hub.createTerm({ cwd: baseDir, cmd: swapExe, args: ['add'], title: 'Antigravity 계정 추가' });
      send(res, 200, hub.termInfo(t));
      return true;
    }
    if (p === '/api/agy/swap' && req.method === 'POST') {
      const b = await body(req);
      if (!hub.agySwap.available()) { send(res, 400, { error: 'agy-swap이 설치되어 있지 않습니다.' }); return true; }
      try {
        const resSwap = await hub.agySwap.switchTo(b.account);
        const targetEmail = resSwap.account?.email || String(b.account || '').replace(/^agyswap:/i, '').trim();
        if (targetEmail) hub.agyQuota.noteAccount(targetEmail);
        hub.agyQuota.refresh({ force: true }).catch(() => {});
        const restartedTerms = [];
        if (b.restartOpen && targetEmail) {
          const openAgy = [...hub.terms.values()].filter((tm) => tm.exited === null && hub.isAgyTerm(tm) && tm.account?.email?.toLowerCase() !== targetEmail.toLowerCase());
          for (const tm of openAgy) {
            const oldId = tm.id;
            const sw = await hub.switchAccount({ termId: oldId, account: `agyswap:${targetEmail}`, skip: true, interrupt: true });
            if (sw?.ok && sw.term) restartedTerms.push({ oldId, newId: sw.term.id, label: sw.term.title });
          }
        }
        hub.overviewStale();
        send(res, 200, { ...resSwap, restartedTerms });
      } catch (e) { send(res, 400, { error: `Antigravity 계정 전환 실패: ${e.message}` }); }
      return true;
    }
    if (p === '/api/agy/quota') {
      for (const t of hub.terms.values()) {
        if (!hub.isAgyTerm(t)) continue;
        const raw = hub.readTerm(t, 80).join('\n');
        const accM = raw.match(/Account:\s*([^\s\r\n]+)/i);
        if (accM) hub.agyQuota.noteAccount(accM[1]);
        if (!hub.agyQuota.get()) { const parsed = parseAgyQuotaTui(raw); if (parsed) hub.agyQuota.save(parsed); }
      }
      const withSwap = (base, swapRes) => ({
        ...base, swapAvailable: hub.agySwap.available(), swapAccounts: swapRes.accounts || [],
        swapRefreshing: !!swapRes.refreshing, swapError: swapRes.error || swapRes.lastError || null,
      });
      if (url.searchParams.has('force')) {
        const [qRes, sRes] = await Promise.all([hub.agyQuota.refresh({ force: true }), hub.agySwap.available() ? hub.agySwap.refresh({ force: true }) : Promise.resolve({ accounts: [] })]);
        send(res, 200, withSwap(qRes, sRes));
      } else send(res, 200, withSwap(hub.agyQuota.getFast(), hub.agySwap.getFast()));
      return true;
    }
    if (p === '/api/agy/usage' && req.method === 'POST') {
      const [qRes, sRes] = await Promise.all([hub.agyQuota.refresh({ force: true }), hub.agySwap.available() ? hub.agySwap.refresh({ force: true }) : Promise.resolve({ accounts: [] })]);
      send(res, 200, { ...qRes, swapAvailable: hub.agySwap.available(), swapAccounts: sRes.accounts || [], swapRefreshing: !!sRes.refreshing, swapError: sRes.error || sRes.lastError || null });
      return true;
    }
    if (p.startsWith('/api/artifact')) {
      const handled = await hub.artifactsMod.handle(p, url, req, res, () => body(req), (code, obj) => send(res, code, obj));
      if (handled !== false) return true;
    }
    if (p.startsWith('/api/gpu')) {
      const handled = await hub.gpuQ().handle(p, url, req, () => body(req), (code, obj) => send(res, code, obj));
      if (handled !== false) return true;
    }
    if (p.startsWith('/api/calendar')) {
      const handled = await hub.calendarMod().handle(p, url, req, () => body(req), (code, obj) => send(res, code, obj));
      if (handled !== false) return true;
    }
    if (p.startsWith('/api/drive')) {
      const handled = await hub.driveMod().handle(p, url, req, () => body(req), (code, obj) => send(res, code, obj));
      if (handled !== false) return true;
    }
    if (hub.appsMod && p.startsWith('/api/apps')) {
      const handled = await hub.appsMod().handle(p, url, req, () => body(req), (code, obj) => send(res, code, obj), res);
      if (handled !== false) return true;
    }
    if (hub.research() && p.startsWith('/api/research')) {
      const handled = await hub.research().handle(p, url, req, () => body(req), (code, obj) => send(res, code, obj), res);
      if (handled !== false) return true;
    }

    if (p === '/api/vault' && req.method === 'GET') { send(res, 200, unifiedVault.getState()); return true; }
    if (p === '/api/vault/cli' && req.method === 'GET') { send(res, 200, { ok: true, cliData: unifiedVault.inspectCli(String(url.searchParams.get('cli') || '')) }); return true; }
    if (p === '/api/vault/import' && req.method === 'POST') {
      const b = await body(req);
      const r = unifiedVault.importFromCli(b);
      if (b.sync) { unifiedVault.syncToClis(); r.cliData = unifiedVault.inspectCli(b.cli); r.state = unifiedVault.getState(); }
      send(res, 200, r);
      return true;
    }
    if (p === '/api/vault/skill' && req.method === 'GET') { send(res, 200, { ok: true, name: String(url.searchParams.get('name') || ''), content: unifiedVault.readSkillContent(String(url.searchParams.get('name') || '')) }); return true; }
    if (p === '/api/vault/dir' && req.method === 'POST') { const b = await body(req); send(res, 200, { ok: true, state: unifiedVault.setVaultDir(b.vaultDir) }); return true; }
    if (p === '/api/vault/open-dir' && req.method === 'POST') {
      const dir = unifiedVault.getState().vaultDir;
      if (!fs.existsSync(dir)) { send(res, 404, { error: '볼트 폴더를 찾을 수 없습니다.' }); return true; }
      spawn(process.platform === 'win32' ? 'explorer.exe' : (process.platform === 'darwin' ? 'open' : 'xdg-open'), [dir], { detached: true, stdio: 'ignore' }).unref();
      send(res, 200, { ok: true, dir });
      return true;
    }
    if (p === '/api/vault/gather' && req.method === 'POST') { send(res, 200, { ok: true, ...unifiedVault.gatherFromClis() }); return true; }
    if (p === '/api/vault/autoload' && req.method === 'POST') { const b = await body(req); send(res, 200, { ok: true, state: unifiedVault.setAutoLoad(b.enabled) }); return true; }
    if (p === '/api/vault/sync' && req.method === 'POST') { send(res, 200, { ok: true, ...unifiedVault.syncToClis(await body(req)) }); return true; }
    if (p === '/api/vault/skill' && req.method === 'POST') {
      const b = await body(req);
      let st = b.action === 'delete' ? unifiedVault.deleteSkill(b.name) : unifiedVault.saveSkill(b);
      if (b.sync) { unifiedVault.syncToClis(); st = unifiedVault.getState(); }
      send(res, 200, { ok: true, state: st });
      return true;
    }
    if (p === '/api/vault/mcp' && req.method === 'POST') {
      const b = await body(req);
      let st = b.action === 'delete' ? unifiedVault.deleteMcp(b.name) : unifiedVault.saveMcp(b);
      if (b.sync) { unifiedVault.syncToClis(); st = unifiedVault.getState(); }
      send(res, 200, { ok: true, state: st });
      return true;
    }
    if (p === '/api/vault/harness' && req.method === 'POST') {
      const b = await body(req);
      let st;
      if (b.action === 'save-shared') st = unifiedVault.saveHarness(b);
      else if (b.action === 'save-rule') st = unifiedVault.saveRule(b);
      else if (b.action === 'delete-rule') st = unifiedVault.deleteRule(b.name);
      else { send(res, 400, { error: '알 수 없는 harness action입니다.' }); return true; }
      if (b.sync) { unifiedVault.syncToClis(); st = unifiedVault.getState(); }
      send(res, 200, { ok: true, state: st });
      return true;
    }

    return false;
  }

  return { handleSystemRoutes };
}

module.exports = { createSystemRoutes };
