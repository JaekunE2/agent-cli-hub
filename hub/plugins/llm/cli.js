'use strict';
// ccd commands of this plugin. ctx = the helpers ccd.js shares (see plugins.js).
const fs = require('fs');
const path = require('path');
module.exports = function cli(ctx) {
  const { api, die, flags, pos, DIR, BASE, PORT, token, usageDir, readTarget, overview, resolve, sessionIdOf, ago, termLabel, SELF_PID } = ctx;
  let { rest } = ctx;
  const { spawn } = require('child_process');
  return {
    commands: {
  // Local LLM (Ollama on the GX10 over Tailscale): cheap bulk work that should not spend Claude quota
  async llm() {
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8')).llm || {}; } catch {}
    if (!flags.url && !cfg.url) die('local LLM not configured: add "llm": {"url": "http://<host>:11434", "model": "<model>"} to config.json');
    const base = String(flags.url || cfg.url).replace(/\/+$/, '');
    if (pos[1] === 'models' || pos[1] === 'ls') {
      const r = await fetch(`${base}/api/ps`).then((x) => x.json()).catch((e) => ({ error: e.message }));
      const t = await fetch(`${base}/api/tags`).then((x) => x.json()).catch(() => ({}));
      if (r.error) die(`LLM server unreachable (${base}): ${r.error}`);
      const loaded = new Set((r.models || []).map((m) => m.name));
      return console.log((t.models || []).map((m) => `${loaded.has(m.name) ? '● loaded' : '  '.padEnd(8)}  ${m.name.padEnd(36)} ${(m.size / 1e9).toFixed(1)}GB${/abliterat|uncensor/i.test(m.name) ? '  ⚠ 가드레일 없음' : ''}`).join('\n'));
    }
    // tool-using agent (web search, fetch, download, file edits in a sandboxed workspace): llm-agent.js
    if (pos[1] === 'agent' || pos[1] === 'tools' || pos[1] === 'rules') {
      const args = ['--use-system-ca', path.join(ctx.plugin.dir, 'llm-agent.js'), ...pos.slice(pos[1] === 'agent' ? 2 : 1)];
      for (const k of ['model', 'root', 'steps', 'system', 'file', 'url']) if (flags[k]) args.push(`--${k}`, String(flags[k]));
      for (const k of ['think', 'quiet', 'trust-new-tools', 'allow-hub-actions']) if (flags[k]) args.push(`--${k}`);
      const c = spawn(process.execPath, args, { stdio: 'inherit' });
      return new Promise((res) => c.on('exit', (code) => { process.exitCode = code; res(); }));
    }
    let prompt = pos.slice(1).join(' ');
    if (flags.file) {
      for (const f of String(flags.file).split(',')) prompt += `\n\n--- ${f} ---\n${fs.readFileSync(f.trim(), 'utf8')}`;
    }
    if (!process.stdin.isTTY) { const chunks = []; for await (const c of process.stdin) chunks.push(c); const s = Buffer.concat(chunks).toString('utf8'); if (s.trim()) prompt += `\n\n${s}`; }
    if (!prompt.trim()) die('usage: ccd llm "prompt" [--file a.txt,b.log] [--system S] [--model M] [--think] [--json]   (stdin is appended)\n       ccd llm models');
    const model = flags.model || (flags.fast && cfg.fastModel) || cfg.model || 'qwen3.8:27b';
    const messages = [...(flags.system ? [{ role: 'system', content: String(flags.system) }] : []), { role: 'user', content: prompt }];
    // Thinking-only models ignore think:false and would print their reasoning into the answer.
    // Asking with think:true makes Ollama return it in a separate field, which we hide unless --think.
    const show = await fetch(`${base}/api/show`, { method: 'POST', body: JSON.stringify({ model }) }).then((x) => x.json()).catch((e) => die(`LLM server unreachable (${base}): ${e.message}`));
    if (show.error) die(`LLM: ${show.error} (models: ccd llm models)`);
    const canThink = (show.capabilities || []).includes('thinking');
    // server default keeps models loaded forever; non-resident ones (abliterated, coder...) get 10 min
    const keep = [cfg.model, cfg.fastModel].includes(model) ? {} : { keep_alive: '10m' };
    // images (--image a.png,b.jpg): Ollama 0.34's native /api/chat rejects them for qwen3.8
    // ("model does not support multimodal"), its OpenAI-compatible endpoint works → use that
    if (flags.image) {
      if (!(show.capabilities || []).includes('vision')) die(`${model} cannot read images — use qwen3.8:27b`);
      const mime = (f) => ({ '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' })[path.extname(f).toLowerCase()] || 'image/png';
      const last = messages[messages.length - 1];
      last.content = [{ type: 'text', text: last.content }, ...String(flags.image).split(',').map((f) => f.trim()).map((f) => ({ type: 'image_url', image_url: { url: `data:${mime(f)};base64,${fs.readFileSync(f).toString('base64')}` } }))];
      const r = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, messages, ...keep, ...(flags.json ? { response_format: { type: 'json_object' } } : {}) }) })
        .catch((e) => die(`LLM server unreachable (${base}): ${e.message}`));
      const j = await r.json();
      if (!r.ok || j.error) die(`LLM error ${r.status}: ${JSON.stringify(j.error || j)}`);
      const msg = j.choices[0].message;
      if (flags.think && msg.reasoning) process.stderr.write(msg.reasoning + '\n');
      console.log(msg.content);
      if (flags.stats && j.usage) console.error(`[llm] ${j.usage.completion_tokens} tokens, prompt ${j.usage.prompt_tokens} tokens`);
      return;
    }
    const res = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: true, ...keep, ...(canThink ? { think: !!flags.think || !flags['no-think'] } : {}), ...(flags.json ? { format: 'json' } : {}) }) })
      .catch((e) => die(`LLM server unreachable (${base}): ${e.message}`));
    if (!res.ok) die(`LLM error ${res.status}: ${await res.text()}`);
    let buf = '', stats = null;
    for await (const chunk of res.body) {
      buf += Buffer.from(chunk).toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const m = JSON.parse(line);
        if (m.error) die(`LLM error: ${m.error}`);
        if (m.message?.thinking && flags.think) process.stderr.write(m.message.thinking);
        if (m.message?.content) process.stdout.write(m.message.content);
        if (m.done) stats = m;
      }
    }
    process.stdout.write('\n');
    if (stats && flags.stats) console.error(`[llm] ${stats.eval_count} tokens, ${(stats.eval_count / (stats.eval_duration / 1e9)).toFixed(1)} tok/s, prompt ${stats.prompt_eval_count} tokens`);
  },
    },
  };
};
