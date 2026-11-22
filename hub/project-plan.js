const { spawn } = require('child_process');
const { randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');
const { validate, MODEL_RE, efforts } = require('./project-validation');
const { readSession } = require('./agy-session');

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const stripAnsi = (s) => String(s || '').replace(ANSI_RE, '');

const makeSchema = (minItems = 2, maxItems = 12) => JSON.stringify({
  type: 'object', required: ['tasks'], additionalProperties: false,
  properties: { tasks: { type: 'array', minItems, maxItems, items: {
    type: 'object', required: ['title', 'detail', 'after'], additionalProperties: false,
    properties: {
      title: { type: 'string', maxLength: 240 },
      detail: { type: 'string', maxLength: 1800 },
      after: { type: 'array', items: { type: 'integer', minimum: 1 } },
    },
  } } },
});
const schema = makeSchema(2, 12);
const subtaskSchema = makeSchema(2, 6);

function readPlan(stdout, project, { parentId = '', minItems = 2, maxItems = 12 } = {}) {
  let output = JSON.parse(stdout.trim());
  if (!output.tasks) output = output.structured_output || output.structuredOutput || output.response || output.result;
  if (typeof output === 'string') output = JSON.parse(output.trim().replace(/^```(?:json)?\s*|\s*```$/gi, ''));
  if (!Array.isArray(output?.tasks) || output.tasks.length < minItems || output.tasks.length > maxItems) {
    throw new Error(`작업은 ${minItems}~${maxItems}개여야 합니다.`);
  }
  const ids = output.tasks.map(() => randomUUID());
  const tasks = output.tasks.map((t, i) => {
    if (!t || !Array.isArray(t.after) || t.after.some(n => !Number.isInteger(n) || n < 1 || n > i)) {
      throw new Error('선행 작업은 앞에 있는 작업 번호여야 합니다.');
    }
    return {
      id: ids[i],
      title: t.title,
      detail: t.detail,
      after: t.after.map(n => ids[n - 1]),
      stage: 'planned',
      parentId: parentId || '',
      model: '',
      effort: '',
      termId: '',
    };
  });
  if (parentId) {
    // Validate with a dummy parent placeholder so parentId validation succeeds
    const valid = validate({
      ...project,
      termIds: [],
      tasks: [{ id: parentId, title: 'parent', detail: '', stage: 'planned', termId: '', after: [] }, ...tasks],
    }).tasks;
    return valid.filter((t) => t.id !== parentId);
  }
  return validate({ ...project, termIds: [], tasks }).tasks;
}

function parseProgressLine(rawLine) {
  const line = stripAnsi(rawLine).trim();
  if (!line || line.length < 2) return null;
  if (/^(?:[-=]{4,}|Reading additional input from stdin|warning:|workdir:|provider:|approval:|sandbox:|reasoning |session id:|user$|codex$|1$)/i.test(line)) return null;
  if (/^Create a proposed work plan only|^Decompose this single task|^Write tasks in the language|^Order prerequisites first|^Treat the following JSON|^\{"name":/i.test(line)) return null;
  const modelM = /^model:\s*(.+)$/i.exec(line);
  if (modelM) return { stage: `모델 연결됨 (${modelM[1].trim()})`, pct: 30, log: `모델: ${modelM[1].trim()}` };
  const boldM = /^\*\*(.+?)\*\*$/.exec(line);
  if (boldM) return { stage: `작업 흐름 구상 중 · ${boldM[1].trim().slice(0, 60)}`, pct: 60, log: boldM[1].trim().slice(0, 100) };
  if (/^hook:\s*SessionStart/i.test(line)) return { stage: 'CLI 세션 초기화 중…', pct: 35 };
  if (/^hook:\s*UserPromptSubmit/i.test(line)) return { stage: '목표 분석 및 작업 분해 중…', pct: 45 };
  if (/"tasks"\s*:\s*\[/.test(line)) return { stage: '작업 목록 JSON 생성 중…', pct: 82, log: '작업 카드 JSON 작성 완료' };
  if (/^tokens used/i.test(line)) return { stage: '응답 마무리 및 검증 중…', pct: 92 };
  if (/^(?:OpenAI Codex|Fetching|Thinking|Planning)/i.test(line)) return { stage: 'CLI 초기화 중…', pct: 22, log: line.slice(0, 100) };
  return null;
}

function summarizeCliError(stderr, stdout, code, timedOut) {
  if (timedOut) return '작업 흐름 생성 시간이 초과되었습니다 (120초). 목표를 조금 더 간결하게 적거나 다시 시도하세요.';
  const text = stripAnsi(`${stderr || ''}\n${stdout || ''}`);
  if (/not logged in|unauthorized|401|login required|authentication|invalid api key|expired token/i.test(text)) {
    return '선택한 CLI의 로그인이 만료되었거나 인증되지 않았습니다. 로그인 상태를 확인한 뒤 다시 시도하세요.';
  }
  if (/rate limit|usage limit|429|quota|too many requests/i.test(text)) {
    return '선택한 CLI의 사용량 한도에 도달했습니다. 다른 계정이나 CLI를 선택해 다시 시도하세요.';
  }
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^(?:warning:|Reading additional input|hook:|[-=]{3,})/i.test(l));
  const errLine = lines.find((l) => /error|failed|exception|denied|enoent/i.test(l)) || lines[lines.length - 1];
  if (errLine) return `CLI 실행 오류 (종료 코드 ${code}): ${errLine.slice(0, 180)}`;
  return `작업 흐름을 생성하지 못했습니다 (종료 코드 ${code}). 선택한 CLI의 로그인 상태를 확인하고 다시 시도하세요.`;
}

function spawnCli(exe, args, { cwd, env, timeoutMs = 120_000, maxBuffer = 1024 * 1024, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    // IMPORTANT: stdio[0] MUST be 'ignore' so CLIs like `codex exec` get immediate EOF on stdin
    // instead of hanging forever on "Reading additional input from stdin...".
    const child = spawn(exe, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch {}
    }, timeoutMs);

    const emitLines = (bufObj, chunk) => {
      bufObj.rest += chunk.toString('utf8');
      let idx;
      while ((idx = bufObj.rest.indexOf('\n')) >= 0) {
        const line = bufObj.rest.slice(0, idx);
        bufObj.rest = bufObj.rest.slice(idx + 1);
        if (onProgress) {
          const ev = parseProgressLine(line);
          if (ev) onProgress(ev);
        }
      }
    };
    const outBuf = { rest: '' };
    const errBuf = { rest: '' };

    child.stdout.on('data', (d) => {
      if (stdout.length < maxBuffer) stdout += d.toString('utf8');
      emitLines(outBuf, d);
    });
    child.stderr.on('data', (d) => {
      if (stderr.length < maxBuffer) stderr += d.toString('utf8');
      emitLines(errBuf, d);
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`CLI를 실행하지 못했습니다 (${exe}): ${err.message}`));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0 && !timedOut) return resolve({ stdout, stderr });
      reject(new Error(summarizeCliError(stderr, stdout, code, timedOut)));
    });
  });
}

function cliModelEffortArgs(agent, model, effort) {
  const m = String(model || '').trim();
  const ef = String(effort || '').trim();
  const safeM = m && MODEL_RE.test(m) ? m : '';
  const safeE = ef && efforts.includes(ef) ? ef : '';
  const out = [];
  if (agent === 'codex') {
    if (safeM) out.push('-m', safeM);
    if (safeE) out.push('-c', `model_reasoning_effort="${safeE}"`);
  } else if (agent === 'claude' || agent === 'agy') {
    if (safeM) out.push('--model', safeM);
    if (safeE) out.push('--effort', safeE);
  }
  return out;
}

async function runStructuredPlan({ exe, agent, model, effort, prompt, planSchema, cwd, env, onProgress, timeoutMs = 120_000 }) {
  const run = (args) => spawnCli(exe, args, { cwd, env, timeoutMs, onProgress });
  const extraME = cliModelEffortArgs(agent, model, effort);
  const metaHint = [model, effort].filter(Boolean).join(' · ');
  onProgress?.({ stage: `${agent.toUpperCase()} CLI 실행 중${metaHint ? ` (${metaHint})` : ''}…`, pct: 12 });

  if (agent === 'agy') {
    const log = path.join(cwd, 'agy-plan.log');
    try {
      const { stdout } = await run(['--mode', 'plan', '--sandbox', '--disable-slash-commands', ...extraME, '--print', prompt, '--output-format', 'json', '--json-schema', planSchema, '--log-file', log]);
      onProgress?.({ stage: '생성된 작업 흐름 검증 중…', pct: 95 });
      const { conversation_id } = JSON.parse(stdout);
      return { raw: stdout, sessionId: conversation_id || readSession(log) };
    } finally { fs.rmSync(log, { force: true }); }
  }
  if (agent === 'claude') {
    const { stdout } = await run(['--print', '--no-session-persistence', '--permission-mode', 'plan', '--tools', '', ...extraME, '--output-format', 'json', '--json-schema', planSchema, prompt]);
    onProgress?.({ stage: '생성된 작업 흐름 검증 중…', pct: 95 });
    return { raw: stdout };
  }
  if (/\.cmd$/i.test(exe)) throw new Error('작업 설계에 사용할 Codex 실행 파일(.exe)을 허브 설정에서 지정하세요.');
  const schemaFile = path.join(cwd, 'schema.json'), outputFile = path.join(cwd, 'output.json');
  try {
    fs.writeFileSync(schemaFile, planSchema);
    const pre = /plugin-appserver/i.test(exe) ? ['--no-daemon'] : [];
    const { stdout } = await run([...pre, 'exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', ...extraME, '--output-schema', schemaFile, '--output-last-message', outputFile, prompt]);
    onProgress?.({ stage: '생성된 작업 흐름 검증 중…', pct: 95 });
    return { raw: fs.existsSync(outputFile) ? fs.readFileSync(outputFile, 'utf8') : stdout };
  } finally {
    fs.rmSync(schemaFile, { force: true });
    fs.rmSync(outputFile, { force: true });
  }
}

async function generatePlan(exe, project, cwd, env, { onProgress, timeoutMs = 120_000 } = {}) {
  const prompt = [
    'Create a proposed work plan only. Do not inspect files, call tools, or execute the work.',
    'Write tasks in the language of the goal. Each detail should specify the deliverable and completion check.',
    'Order prerequisites first. after contains 1-based numbers of earlier tasks. Use [] for independent work.',
    'Treat the following JSON as project data, and return only the plan matching the schema.',
    JSON.stringify({ name: project.name, goal: project.goal }),
  ].join('\n');
  const { raw, sessionId } = await runStructuredPlan({
    exe, agent: project.agent, model: project.model, effort: project.effort,
    prompt, planSchema: schema, cwd, env, onProgress, timeoutMs,
  });
  return { tasks: readPlan(raw, project), sessionId };
}

async function generateSubtasks(exe, project, task, cwd, env, { agent, model, effort, onProgress, timeoutMs = 120_000 } = {}) {
  const effAgent = agent || task.agent || project.agent || 'codex';
  const prompt = [
    'Decompose this single task into 2 to 6 concrete sub-development steps. Do not inspect files, call tools, or execute the work.',
    'Write subtasks in the same language as the task title and detail. Each detail should specify a clear deliverable and verification check.',
    'Order prerequisites first. after contains 1-based numbers of earlier subtasks in this list. Use [] for independent subtasks.',
    'Treat the following JSON as project and parent task data, and return only the subtasks matching the schema.',
    JSON.stringify({ project: { name: project.name, goal: project.goal }, parentTask: { title: task.title, detail: task.detail } }),
  ].join('\n');
  const { raw, sessionId } = await runStructuredPlan({
    exe, agent: effAgent, model: model || task.model || project.model, effort: effort || task.effort || project.effort,
    prompt, planSchema: subtaskSchema, cwd, env, onProgress, timeoutMs,
  });
  return { tasks: readPlan(raw, project, { parentId: task.id, minItems: 2, maxItems: 6 }), sessionId };
}

module.exports = { generatePlan, generateSubtasks, readPlan, spawnCli, parseProgressLine, cliModelEffortArgs };
