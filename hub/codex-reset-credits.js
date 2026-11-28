'use strict';

// Official Codex app-server account API; no prompts or model turns are started.
// https://learn.chatgpt.com/docs/app-server#8-earned-rate-limit-resets-chatgpt
const { spawn } = require('child_process');
const readline = require('readline');
const CA = require('./codex-accounts');

function openAccountClient(exe, account, { spawnProcess = spawn, timeoutMs = 30000 } = {}) {
  const env = { ...process.env, CODEX_HOME: account.home || CA.MAIN };
  delete env.OPENAI_API_KEY;
  const child = spawnProcess(exe, ['app-server'], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let sequence = 0, closed = false;
  const fail = (error) => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); } pending.clear(); };
  child.on('error', () => fail(new Error('Codex app-server를 실행하지 못했습니다. CLI 설치 경로를 확인하세요.')));
  child.on('exit', () => { closed = true; fail(new Error('Codex app-server 연결이 종료되었습니다.')); });
  child.stdin.on('error', () => fail(new Error('Codex app-server 입력 연결이 끊겼습니다.')));
  child.stderr.resume(); // Never relay CLI logs or credentials to the browser.
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', line => {
    let msg; try { msg = JSON.parse(line); } catch { return; }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id); clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(msg.error.code === -32601
      ? '설치된 Codex CLI가 초기화 티켓 API를 지원하지 않습니다. CLI 업데이트가 필요합니다.'
      : `Codex 계정 요청 실패 (코드 ${Number(msg.error.code) || 'unknown'}). 로그인 상태를 확인하세요.`));
    else p.resolve(msg.result);
  });
  const notify = (method, params) => child.stdin.write(JSON.stringify({ method, params }) + '\n');
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    if (closed) return reject(new Error('Codex app-server 연결이 종료되었습니다.'));
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Codex 계정 요청 시간 초과. 사용 요청은 동일한 요청 번호로 재시도하세요.')); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  return {
    async initialize() {
      await request('initialize', { clientInfo: { name: 'agent_cli_hub', title: 'Agent CLI Hub', version: '1.0.0' }, capabilities: { experimentalApi: true } });
      notify('initialized', {});
      const result = await request('account/read', { refreshToken: false });
      if (!result?.account || result.account.type !== 'chatgpt' || !account.email ||
          result.account.email?.toLowerCase() !== account.email.toLowerCase()) {
        throw new Error('선택한 계정과 Codex 로그인 계정이 일치하지 않습니다. 계정 로그인을 확인하세요.');
      }
    },
    request,
    close() { closed = true; fail(new Error('연결 종료')); lines.close(); child.stdin.end(); child.kill(); },
  };
}

function createResetCreditsService({ usageDir, exe, accounts = CA.accounts, openClient = openAccountClient }) {
  const consuming = new Set();
  const resolveAccount = (id) => {
    const list = accounts(usageDir);
    const acc = list.find(a => a.id === id) || (id === 'auto-codex' ? list.find(a => a.main) : null);
    if (!acc) throw new Error('등록된 Codex 계정을 선택하세요.');
    return acc;
  };
  const withClient = async (acc, action) => {
    const client = openClient(typeof exe === 'function' ? exe() : exe, acc);
    try { await client.initialize(); return await action(client); } finally { client.close(); }
  };
  const identity = a => ({ id: a.id, email: a.email, label: a.label });
  return {
    async read(id) {
      const acc = resolveAccount(id);
      return withClient(acc, async c => ({ ok: true, account: identity(acc), ...(await c.request('account/rateLimits/read')) }));
    },
    async consume({ account, idempotencyKey, creditId, confirmed }) {
      if (confirmed !== true) throw new Error('티켓 사용 확인이 필요합니다.');
      if (typeof idempotencyKey !== 'string' || !/^[a-zA-Z0-9-]{16,128}$/.test(idempotencyKey)) throw new Error('유효한 요청 번호가 필요합니다.');
      if (creditId !== undefined && (typeof creditId !== 'string' || !creditId.trim() || creditId.length > 512)) throw new Error('잘못된 티켓 ID입니다.');
      const acc = resolveAccount(account);
      const key = acc.email?.toLowerCase() || acc.id;
      if (consuming.has(key)) throw new Error('이 계정의 티켓 사용 요청이 진행 중입니다. 잠시 후 재시도하세요.');
      consuming.add(key);
      try {
        return await withClient(acc, async c => {
          const result = await c.request('account/rateLimitResetCredit/consume', { idempotencyKey, ...(creditId === undefined ? {} : { creditId }) });
          if (!['reset', 'alreadyRedeemed', 'nothingToReset', 'noCredit'].includes(result?.outcome)) throw new Error('알 수 없는 티켓 응답입니다. 동일한 요청 번호로 재시도하세요.');
          let limits = null, refreshError = null;
          try { limits = await c.request('account/rateLimits/read'); } catch (e) { refreshError = e.message; }
          return { ok: true, account: identity(acc), outcome: result.outcome, limits, refreshError };
        });
      } finally { consuming.delete(key); }
    },
  };
}
module.exports = { openAccountClient, createResetCreditsService };
