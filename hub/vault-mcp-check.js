'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const request = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
  protocolVersion: '2025-06-18', capabilities: {},
  clientInfo: { name: 'agent-cli-hub', version: '1.0.0' },
} };
const initialized = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' });
const accepted = (msg) => msg?.jsonrpc === '2.0' && msg.id === request.id &&
  !!msg.result?.protocolVersion && !!msg.result?.serverInfo?.name;

async function checkHttp(cfg, signal) {
  const headers = new Headers(cfg.headers);
  if (cfg.bearer_token && !headers.has('authorization')) headers.set('authorization', `Bearer ${cfg.bearer_token}`);
  headers.set('content-type', 'application/json');
  headers.set('accept', 'application/json, text/event-stream');
  const send = (body) => fetch(cfg.url, { method: 'POST', headers, body, signal, redirect: 'error' });
  const res = await send(JSON.stringify(request));
  if (!res.ok) { await res.body?.cancel(); return false; }
  let message;
  if (res.headers.get('content-type')?.startsWith('text/event-stream')) {
    let event = '';
    for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) {
      event += chunk.replace(/\r/g, '');
      if (event.length > 65_536) return false;
      let end;
      while ((end = event.indexOf('\n\n')) !== -1) {
        const data = event.slice(0, end).split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5));
        event = event.slice(end + 2);
        if (data.length) message = JSON.parse(data.join('\n'));
        if (message?.id === request.id) break;
      }
      if (message?.id === request.id) break;
    }
  } else {
    message = await res.json();
  }
  if (!accepted(message)) return false;
  const session = res.headers.get('mcp-session-id');
  if (session) headers.set('mcp-session-id', session);
  headers.set('mcp-protocol-version', message.result.protocolVersion);
  const ready = await send(initialized);
  await ready.body?.cancel();
  return ready.ok;
}

function checkStdio(cfg, { cwd, env, signal }) {
  return new Promise((resolve) => {
    let { command, args = [] } = cfg;
    if (process.platform === 'win32' && /^(?:npx|npm)(?:\.cmd)?$/i.test(command)) {
      const script = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', command.replace(/\.cmd$/i, '') + '-cli.js');
      if (fs.existsSync(script)) { command = process.execPath; args = [script, ...args]; }
    }
    const inherited = Object.fromEntries(Object.entries(env).filter(([key]) => /^(path|pathext|home|userprofile|appdata|localappdata|systemroot|comspec|temp|tmp)$/i.test(key)));
    const child = spawn(command, args, { cwd, env: { ...inherited, ...cfg.env }, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    let output = '';
    let finished = false;
    let connected = false;
    const abort = () => finish(false);
    function finish(ok) {
      if (finished) return;
      finished = true;
      signal.removeEventListener('abort', abort);
      if (!child.stdin.writableEnded) child.stdin.end();
      child.stdout.destroy();
      child.unref();
      resolve(ok);
    }
    signal.addEventListener('abort', abort, { once: true });
    child.once('error', abort).once('close', () => finish(connected));
    child.stdin.once('error', abort);
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      if (connected) return;
      output += chunk;
      if (output.length > 65_536) return finish(false);
      let newline;
      while ((newline = output.indexOf('\n')) !== -1) {
        const line = output.slice(0, newline);
        output = output.slice(newline + 1);
        let msg;
        try { msg = JSON.parse(line); } catch { return finish(false); }
        if (msg?.id !== request.id) continue;
        connected = accepted(msg);
        if (!connected) return finish(false);
        child.stdin.end(initialized + '\n');
        return;
      }
    }).once('error', abort);
    child.stdin.write(JSON.stringify(request) + '\n');
  });
}

async function checkMcp(cfg, opts) {
  const signal = AbortSignal.timeout(10_000);
  try {
    return await (cfg.url ? checkHttp(cfg, signal) : checkStdio(cfg, { ...opts, signal }));
  } catch (error) {
    console.error('[vault-mcp-check]', error.code || error.name);
    return false;
  }
}

module.exports = { checkMcp };
