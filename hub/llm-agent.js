#!/usr/bin/env node
// `ccd llm agent` / `ccd llm tools` — the local LLM with tools, on the PC. The tools, the model's own
// rules (llm-rules.md), the tools it writes itself (llm-tools\) and the loop live in llm-agent-core.js,
// shared with the GX10 server behind the phone app.
// Started with --use-system-ca (the institute's TLS inspection re-signs HTTPS with a CA only the
// Windows store trusts).
//
//   node --use-system-ca llm-agent.js "task" [--model M] [--root DIR[,DIR2]] [--steps 24] [--think] [--quiet] [--trust-new-tools]
//   node llm-agent.js tools [list | show <name> | approve <name> | remove <name>]
//   node llm-agent.js rules [show | edit "text"]
const fs = require('fs');
const path = require('path');
const { createAgent } = require('./llm-agent-core');

const DIR = __dirname;
const argv = process.argv.slice(2);
const flags = {};
const pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const k = a.slice(2);
    if (['model', 'root', 'steps', 'url', 'system', 'file'].includes(k)) flags[k] = argv[++i];
    else flags[k] = true;
  } else pos.push(a);
}
const die = (msg) => { console.error(msg); process.exit(1); };

let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8')).llm || {}; } catch {}
const base = String(flags.url || cfg.url || '').replace(/\/+$/, '');
if (!base) die('local LLM not configured (config.json "llm.url")');
const model = flags.model || cfg.agentModel || 'qwen3-coder:30b';
const roots = String(flags.root || cfg.agentRoot || path.join(require('os').homedir(), 'llm-workspace')).split(',').map((r) => ({ path: r.trim(), write: true }));
const TOOL_DIR = path.join(DIR, 'llm-tools');
const agent = createAgent({
  base, roots, toolDir: TOOL_DIR, rulesFile: path.join(DIR, 'llm-rules.md'), python: cfg.agentPython || 'python',
  trustNewTools: !!flags['trust-new-tools'], residentModels: [cfg.model, cfg.fastModel],
  hub: { node: process.execPath, ccd: path.join(DIR, 'ccd.js'), cwd: cfg.hubCwd },
  log: (s) => { if (!flags.quiet) process.stderr.write(s + '\n'); },
});

function manageTools() {
  const [, sub = 'list', name] = pos;
  if (sub === 'list') {
    const all = agent.customTools();
    return console.log(all.length ? all.map((x) => `${x.approved ? '✔ enabled' : '… pending'}  ${x.name.padEnd(24)} ${x.language.padEnd(6)} ${x.description}`).join('\n') : `(no custom tools yet — ${TOOL_DIR})`);
  }
  if (sub === 'show') { const t = agent.toolSource(name); const { code, ...meta } = t; return console.log(`${JSON.stringify(meta, null, 2)}\n--- ${t.file} ---\n${code}`); }
  if (sub === 'approve') { agent.approveTool(name); return console.log(`enabled ${name}`); }
  if (sub === 'remove') { agent.removeTool(name); return console.log(`removed ${name}`); }
  die('usage: ccd llm tools [list | show <name> | approve <name> | remove <name>]');
}
function manageRules() {
  const [, sub = 'show', ...rest] = pos;
  if (sub === 'show') return console.log(agent.readRules() || '(no rules yet — the model adds them with update_rules)');
  if (sub === 'edit') { agent.writeRules(rest.join(' ').replace(/\\n/g, '\n')); return console.log(agent.readRules()); }
  die('usage: ccd llm rules [show | edit "line1\\nline2"]');
}

async function main() {
  if (pos[0] === 'tools') return manageTools();
  if (pos[0] === 'rules') return manageRules();
  let task = pos.join(' ');
  if (flags.file) for (const f of String(flags.file).split(',')) task += `\n\n--- ${f.trim()} ---\n${fs.readFileSync(f.trim(), 'utf8')}`;
  if (!process.stdin.isTTY) { const c = []; for await (const x of process.stdin) c.push(x); const s = Buffer.concat(c).toString('utf8'); if (s.trim()) task += `\n\n${s}`; }
  if (!task.trim()) die('usage: ccd llm agent "task" [--model M] [--root DIR] [--steps N] [--think] [--quiet] [--trust-new-tools]\n       ccd llm tools [list | show <name> | approve <name> | remove <name>]\n       ccd llm rules [show | edit "text"]');
  const show = await fetch(`${base}/api/show`, { method: 'POST', body: JSON.stringify({ model }) }).then((x) => x.json()).catch((e) => die(`LLM server unreachable (${base}): ${e.message}`));
  if (show.error) die(`LLM: ${show.error}`);
  const caps = show.capabilities || [];
  if (!caps.includes('tools')) die(`${model} has no tool support (capabilities: ${caps.join(', ')})`);
  if (!flags.quiet) process.stderr.write(`[agent] ${model} · workspace ${roots.map((r) => r.path).join(', ')}\n`);
  const messages = [{ role: 'user', content: task }];
  await agent.run({
    model, messages, tools: true, think: caps.includes('thinking') ? (flags.think ? 'medium' : false) : undefined,
    maxSteps: Number(flags.steps || 24), system: flags.system,
    // hub actions (send/keys/new) only when the caller explicitly allows them for this run
    confirm: flags['allow-hub-actions'] ? async ({ name, args }) => { process.stderr.write(`[agent] hub action allowed by flag: ${name} ${JSON.stringify(args).slice(0, 120)}\n`); return true; } : undefined,
    onEvent: (e) => { if (e.type === 'notice' && !flags.quiet) process.stderr.write(`[agent] ${e.text}\n`); if (flags.think && e.type === 'delta' && e.kind === 'reasoning') process.stderr.write(e.text); },
  });
  const last = [...messages].reverse().find((m) => m.role === 'assistant' && !m.error);
  console.log((last?.content || '').trim());
}
main().catch((e) => die(e.message === 'stopped' ? 'stopped' : e.stack || e.message));
