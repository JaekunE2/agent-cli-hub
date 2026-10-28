// Phone notifications through the existing Telegram bot of the AI usage dashboard
// (its .env: TELEGRAM_BOT_TOKEN, ALLOWED_USER_IDS, TELEGRAM_PROXY). The corporate network
// needs a CONNECT tunnel to reach api.telegram.org — same approach as that bot.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const tls = require('tls');

module.exports = function notifier(config = {}) {
  const envFile = config.telegramEnv || path.join(os.homedir(), 'ai-usage-dashboard', 'telegram', '.env');
  const env = {};
  try {
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
      if (m && !line.trimStart().startsWith('#')) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  } catch {}
  const TOKEN = env.TELEGRAM_BOT_TOKEN;
  const CHATS = (env.ALLOWED_USER_IDS || '').split(',').map((s) => s.trim()).filter((s) => /^\d+$/.test(s));
  const PROXY = env.TELEGRAM_PROXY;

  class ProxyTunnelAgent extends https.Agent {
    constructor(proxyUrl) { super({ keepAlive: true }); this.proxy = new URL(proxyUrl); }
    createConnection(options, cb) {
      const headers = { Host: `${options.host}:${options.port}` };
      if (this.proxy.username) headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(`${decodeURIComponent(this.proxy.username)}:${decodeURIComponent(this.proxy.password)}`).toString('base64');
      const req = http.request({ host: this.proxy.hostname, port: Number(this.proxy.port) || 80, method: 'CONNECT', path: `${options.host}:${options.port}`, headers });
      req.once('connect', (res, socket) => {
        if (res.statusCode !== 200) return cb(new Error(`proxy CONNECT ${res.statusCode}`));
        const s = tls.connect({ socket, servername: options.host }, () => cb(null, s));
        s.once('error', cb);
      });
      req.once('error', cb);
      req.end();
    }
  }
  const agent = PROXY ? new ProxyTunnelAgent(PROXY) : undefined;
  function tg(method, payload) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(payload);
      const req = https.request({ hostname: 'api.telegram.org', port: 443, path: `/bot${TOKEN}/${method}`, method: 'POST', agent, timeout: 30000,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
        let d = ''; res.on('data', (c) => (d += c));
        res.on('end', () => { try { const j = JSON.parse(d); j.ok ? resolve(j.result) : reject(new Error(j.description)); } catch { reject(new Error(d.slice(0, 120))); } });
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      req.end(body);
    });
  }

  const available = !!(TOKEN && CHATS.length);
  // text + optional [label, url] buttons; if Telegram refuses a URL button, resend as plain text
  async function send(text, buttons = []) {
    if (!available) return { ok: false, error: 'telegram not configured' };
    const results = [];
    for (const chat_id of CHATS) {
      const payload = { chat_id, text, disable_web_page_preview: true };
      if (buttons.length) payload.reply_markup = { inline_keyboard: [buttons.map(([t, url]) => ({ text: t, url }))] };
      try { await tg('sendMessage', payload); results.push(true); }
      catch (e) {
        try { await tg('sendMessage', { chat_id, text: text + (buttons.length ? '\n\n' + buttons.map(([t, u]) => `${t}: ${u}`).join('\n') : ''), disable_web_page_preview: true }); results.push(true); }
        catch (e2) { results.push(false); console.error('[notify]', e2.message); }
      }
    }
    return { ok: results.some(Boolean) };
  }
  return { available, send };
};
