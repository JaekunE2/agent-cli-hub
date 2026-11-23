const { spawn } = require('child_process');
const { randomUUID } = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { cliModelEffortArgs } = require('./project-plan');
const { readSession } = require('./agy-session');
const { buildTaskHarnessPrompt } = require('./project-harness');

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const stripAnsi = (s) => String(s || '').replace(ANSI_RE, '');

const KIND_LABELS = { plan: '설계·기획', dev: '개발·구현', test: '테스트·검증', review: '교차 리뷰·감사', ops: '배포·문서' };

function buildFirstTurnPrompt(project, task, userPrompt, agent = '', harnessState = null, refsBlock = '') {
  const kindLbl = KIND_LABELS[task.kind] || '개발·구현';
  const harnessBlock = buildTaskHarnessPrompt(project, task, agent || task.agent || project.agent || 'codex', harnessState);
  return [
    `[Project: ${project.name}]`,
    project.goal ? `프로젝트 목표: ${project.goal.slice(0, 800)}` : '',
    `[현재 태스크 (${kindLbl}): ${task.title}]`,
    task.detail ? `태스크 지시 및 완료 기준:\n${task.detail.slice(0, 1500)}` : '',
    harnessBlock,
    refsBlock,
    `[서브 개발 요청]`,
    userPrompt,
  ].filter(Boolean).join('\n\n');
}

function parseCodexJsonl(stdout, fallbackText = '') {
  let sessionId = '';
  let lastReply = '';
  let tokens = null;
  const toolLines = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let ev;
    try { ev = JSON.parse(trimmed); } catch { continue; }
    if (ev.type === 'thread.started' && ev.thread_id) sessionId = ev.thread_id;
    if (ev.type === 'item.completed' && ev.item) {
      const it = ev.item;
      if ((it.type === 'agent_message' || it.type === 'message') && typeof it.text === 'string' && it.text.trim()) {
        lastReply = it.text.trim();
      } else if (it.type === 'command_execution' && it.command) {
        toolLines.push(`⚙ ${String(it.command).slice(0, 160)}`);
      } else if (it.type === 'file_change' && Array.isArray(it.changes)) {
        const files = it.changes.map((c) => c.path).filter(Boolean).join(', ');
        if (files) toolLines.push(`⚙ 파일 변경: ${files.slice(0, 160)}`);
      }
    }
    if (ev.type === 'turn.completed' && ev.usage) {
      const u = ev.usage;
      const cached = Math.max(0, Number(u.cached_input_tokens) || 0);
      const rawIn = Math.max(0, Number(u.input_tokens) || 0);
      const input = Math.max(0, rawIn - cached);
      const output = Math.max(0, Number(u.output_tokens) || 0);
      tokens = { input, output, cacheRead: cached, cacheWrite: 0, total: input + output + cached };
    }
  }
  const reply = lastReply || String(fallbackText || '').trim();
  const fullReply = toolLines.length && reply
    ? `${toolLines.slice(-6).join('\n')}\n\n${reply}`
    : (reply || toolLines.join('\n'));
  return { sessionId, reply: fullReply, tokens };
}

function parseClaudeJson(stdout) {
  const txt = String(stdout || '').trim();
  const s = txt.indexOf('{'), e = txt.lastIndexOf('}');
  if (s >= 0 && e > s) {
    try {
      const obj = JSON.parse(txt.slice(s, e + 1));
      const u = obj.usage || {};
      const input = Math.max(0, Number(u.input_tokens) || 0);
      const output = Math.max(0, Number(u.output_tokens) || 0);
      const cacheRead = Math.max(0, Number(u.cache_read_input_tokens) || 0);
      const cacheWrite = Math.max(0, Number(u.cache_creation_input_tokens) || 0);
      const tokens = (input + output + cacheRead + cacheWrite) > 0
        ? { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite }
        : null;
      return {
        sessionId: obj.session_id || obj.sessionId || '',
        reply: String(obj.result || obj.response || obj.text || '').trim() || txt,
        tokens,
      };
    } catch {}
  }
  return { sessionId: '', reply: txt, tokens: null };
}

function parseAgyJson(stdout, logFile) {
  const txt = String(stdout || '').trim();
  const s = txt.indexOf('{'), e = txt.lastIndexOf('}');
  let sessionId = '';
  let reply = '';
  let tokens = null;
  if (s >= 0 && e > s) {
    try {
      const obj = JSON.parse(txt.slice(s, e + 1));
      sessionId = obj.conversation_id || '';
      reply = String(obj.response || obj.result || '').trim();
      const u = obj.usage || {};
      const input = Math.max(0, Number(u.input_tokens) || 0);
      const output = Math.max(0, Number(u.output_tokens) || 0);
      const cacheRead = Math.max(0, Number(u.cache_read_tokens) || 0);
      const total = Math.max(Number(u.total_tokens) || 0, input + output + cacheRead);
      if (total > 0) tokens = { input, output, cacheRead, cacheWrite: 0, total };
    } catch {}
  }
  if (!sessionId && logFile && fs.existsSync(logFile)) {
    sessionId = readSession(logFile) || '';
  }
  return { sessionId, reply: reply || txt, tokens };
}

async function runTaskSubChatTurn({
  exe, agent, cwd, env, model = '', effort = '', sessionId = '', prompt, project, task, harnessState = null, refsBlock = '', onProgress, timeoutMs = 180_000,
}) {
  const fullPrompt = sessionId ? prompt : buildFirstTurnPrompt(project, task, prompt, agent, harnessState, refsBlock);
  const meArgs = cliModelEffortArgs(agent, model, effort);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-subchat-'));
  const outFile = path.join(tmpDir, 'last.txt');
  const logFile = path.join(tmpDir, 'agy.log');

  let args;
  let assignedSid = sessionId || '';
  if (agent === 'codex') {
    const pre = /plugin-appserver/i.test(exe) ? ['--no-daemon'] : [];
    args = sessionId
      ? [...pre, 'exec', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', '--json', ...meArgs, '-o', outFile, 'resume', sessionId, prompt]
      : [...pre, 'exec', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', '--json', ...meArgs, '-o', outFile, fullPrompt];
  } else if (agent === 'agy') {
    args = sessionId
      ? ['--print', prompt, '--output-format', 'json', '--dangerously-skip-permissions', '--conversation', sessionId, ...meArgs, '--log-file', logFile]
      : ['--print', fullPrompt, '--output-format', 'json', '--dangerously-skip-permissions', ...meArgs, '--log-file', logFile];
  } else {
    if (!assignedSid) assignedSid = randomUUID();
    args = sessionId
      ? ['--print', '--output-format', 'json', '--dangerously-skip-permissions', '--resume', sessionId, ...meArgs, prompt]
      : ['--print', '--output-format', 'json', '--dangerously-skip-permissions', '--session-id', assignedSid, ...meArgs, fullPrompt];
  }

  onProgress?.({ stage: `${agent.toUpperCase()} 서브 개발 실행 중…`, log: '세션 연결 중…' });

  try {
    const { stdout } = await new Promise((resolve, reject) => {
      let out = '', err = '', settled = false, timedOut = false;
      const ch = spawn(exe, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const timer = setTimeout(() => { timedOut = true; try { ch.kill(); } catch {} }, timeoutMs);

      const handleLine = (raw) => {
        const line = stripAnsi(raw).trim();
        if (!line) return;
        if (line.startsWith('{')) {
          try {
            const ev = JSON.parse(line);
            if (ev.type === 'thread.started' && ev.thread_id) {
              assignedSid = ev.thread_id;
              onProgress?.({ stage: '세션 준비 완료 · 분석 중…', sessionId: assignedSid });
            } else if ((ev.type === 'item.started' || ev.type === 'item.completed') && ev.item) {
              const it = ev.item;
              if (it.type === 'command_execution' && it.command) {
                onProgress?.({ stage: '명령 실행 중…', log: `⚙ ${String(it.command).slice(0, 90)}` });
              } else if (it.type === 'reasoning' && it.text) {
                onProgress?.({ stage: '추론 중…', log: `💭 ${String(it.text).replace(/\s+/g, ' ').slice(0, 90)}` });
              } else if (it.type === 'agent_message' || it.type === 'message') {
                onProgress?.({ stage: '응답 작성 중…' });
              }
            }
          } catch {}
          return;
        }
        const m = /^model:\s*(.+)$/i.exec(line);
        if (m) onProgress?.({ stage: `모델 연결됨 (${m[1].trim()})`, log: `모델: ${m[1].trim()}` });
        else if (/^\*\*(.+?)\*\*$/.test(line)) onProgress?.({ stage: line.replace(/\*\*/g, ''), log: line.replace(/\*\*/g, '') });
      };

      let outRest = '', errRest = '';
      ch.stdout.on('data', (d) => {
        const s = d.toString('utf8');
        if (out.length < 2 * 1024 * 1024) out += s;
        outRest += s;
        let i;
        while ((i = outRest.indexOf('\n')) >= 0) { handleLine(outRest.slice(0, i)); outRest = outRest.slice(i + 1); }
      });
      ch.stderr.on('data', (d) => {
        const s = d.toString('utf8');
        if (err.length < 1024 * 1024) err += s;
        errRest += s;
        let i;
        while ((i = errRest.indexOf('\n')) >= 0) { handleLine(errRest.slice(0, i)); errRest = errRest.slice(i + 1); }
      });
      ch.on('error', (e) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        reject(new Error(`CLI 실행 실패: ${e.message}`));
      });
      ch.on('close', (code) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (code === 0 && !timedOut) return resolve({ stdout: out, stderr: err });
        if (timedOut) return reject(new Error('서브 개발 응답 시간이 초과되었습니다 (180초).'));
        const tail = stripAnsi(`${err}\n${out}`).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-3).join(' / ');
        reject(new Error(`서브 개발 CLI 오류 (코드 ${code}): ${tail.slice(0, 180) || '실행 실패'}`));
      });
    });

    if (agent === 'codex') {
      const fb = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : '';
      const parsed = parseCodexJsonl(stdout, fb);
      return {
        sessionId: parsed.sessionId || assignedSid,
        reply: parsed.reply || '(응답이 비어 있습니다)',
        tokens: parsed.tokens,
      };
    }
    if (agent === 'agy') {
      const parsed = parseAgyJson(stdout, logFile);
      return {
        sessionId: parsed.sessionId || assignedSid,
        reply: parsed.reply || '(응답이 비어 있습니다)',
        tokens: parsed.tokens,
      };
    }
    const parsed = parseClaudeJson(stdout);
    return {
      sessionId: parsed.sessionId || assignedSid,
      reply: parsed.reply || '(응답이 비어 있습니다)',
      tokens: parsed.tokens,
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

module.exports = { runTaskSubChatTurn, buildFirstTurnPrompt, parseCodexJsonl, parseClaudeJson, parseAgyJson };
