'use strict';

const MAX_LINE = 512 * 1024;
const TEST_COMMANDS = /^(?:npm (?:run )?test(?::[\w-]+)?|(?:pnpm|yarn|bun) test|node --test|(?:python(?:3)? -m )?pytest|npx playwright test|cargo test|go test|dotnet test)(?=\s|$)/i;
const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);

function testCommand(cmd) {
  const shell = Array.isArray(cmd) && cmd.findIndex(arg => /^(?:-command|-c|\/c)$/i.test(arg));
  const command = (Array.isArray(cmd) ? cmd.slice(typeof shell === 'number' && shell >= 0 ? shell + 1 : 0).join(' ') : String(cmd || ''))
    .trim().replace(/^["'](.+)["']$/, '$1');
  if (/[;&|<>$`\r\n]/.test(command)) return '';
  return command.match(TEST_COMMANDS)?.[0] || '';
}

function workState() { return { calls: [], files: [], checks: [] }; }

function addFile(state, file, ref) {
  if (typeof file !== 'string' || !file || file.length > 512 || /[\x00-\x1f]/.test(file)) return;
  const entry = state.files.find(item => item.path === file);
  if (entry) {
    if (ref.id && entry.refs.some(item => item.id === ref.id)) return;
    entry.refs.push(ref);
    if (entry.refs.length > 4) { entry.refs.shift(); entry.partial = true; }
  } else if (state.files.length < 20) state.files.push({ path: file, refs: [ref] });
  else state.moreFiles = true;
}

function namedCheckEvidence(text, failed) {
  const names = [], assertions = Object.create(null);
  let current;
  for (const line of text.split(/\r?\n/)) {
    const tap = /^\s*(not ok|ok) \d+\s+-\s+(.+)\s*$/.exec(line);
    const spec = /^\s*(✖|✔)\s+(.+?)\s+\(\d+(?:\.\d+)?ms\)\s*$/u.exec(line);
    const pytest = /^FAILED\s+(\S+::\S+)(?:\s+-\s+.*)?\s*$/.exec(line);
    if (tap || spec || pytest) {
      current = null;
      const unsuccessful = Boolean(pytest || tap?.[1] === 'not ok' || spec?.[1] === '✖');
      const name = (tap?.[2] || spec?.[2] || pytest?.[1] || '').trim().slice(0, 120);
      if (unsuccessful !== failed || !name || /[\x00-\x1f]/.test(name) || names.includes(name) || names.length >= 3
        || (tap && /\s+#\s*(?:skip|todo)\b/i.test(tap[2]))) continue;
      names.push(name);
      if (failed && tap) current = name;
    } else if (current) {
      const value = /^\s+(expected|actual):\s*(true|false|null|-?\d+(?:\.\d+)?)\s*$/.exec(line);
      if (value) (assertions[current] ||= {})[value[1]] = value[2];
      if (/^\s*\.\.\.\s*$/.test(line)) current = null;
    }
  }
  if (!names.length) return {};
  if (!failed) return { passedNames: names };
  const differences = Object.entries(assertions).filter(([, value]) =>
    value.expected !== undefined && value.actual !== undefined && value.expected !== value.actual);
  return { failureNames: names, ...(differences.length ? { assertions: Object.fromEntries(differences) } : {}) };
}

function addCheck(state, command, failed, output) {
  const raw = Array.isArray(output) ? output.filter(part => part?.type === 'text').map(part => part.text).join('\n') : output;
  const text = typeof raw === 'string' ? raw.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '') : '';
  const node = /^\s*(?:#|ℹ)\s+pass\s+(\d+)\s*$/im.exec(text);
  const vitest = /^\s*Tests\s+(\d+) passed(?:\s*\([^\n]*\))?\s*$/im.exec(text);
  const pytest = /^=+\s*(\d+) passed\b[^\n]*=+\s*$/im.exec(text);
  const count = failed ? null : Number((node || vitest || pytest)?.[1]) || null;
  if (state.checks.length < 12) state.checks.push({ command, failed, count, ...namedCheckEvidence(text, failed) });
}

function remember(state, id, action) {
  if (!id || !action) return;
  if (state.calls.length >= 64) state.calls.shift();
  state.calls.push({ id, ...action });
}

function take(state, id) {
  const index = state.calls.findIndex(call => call.id === id);
  return index < 0 ? null : state.calls.splice(index, 1)[0];
}

function codexEvidence(state, row, ref) {
  const p = row.payload || {};
  const item = p.type === 'item_completed' ? p.item : null;
  const patch = p.type === 'patch_apply_end' && p.success === true ? p
    : item?.type === 'FileChange' && String(item.status).toLowerCase() === 'completed' ? item : null;
  if (row.type === 'event_msg' && patch) {
    for (const [file, change] of Object.entries(patch.changes || {})) {
      const diff = !!change?.unified_diff || typeof change?.content === 'string';
      addFile(state, file, { ...ref, id: patch.call_id || patch.id, diff });
    }
  }
  if (item?.type === 'CommandExecution' && Number.isInteger(item.exit_code) && item.exit_code >= 0) {
    const command = testCommand(item.command);
    if (command) addCheck(state, command, item.exit_code !== 0, item.aggregated_output);
  }
  if (p.type === 'function_call' && /(?:^|__)exec_command$/.test(p.name || '')) {
    try {
      const args = JSON.parse(p.arguments);
      const command = testCommand(args.cmd || args.command);
      if (command) remember(state, p.call_id, { command });
    } catch {}
  }
  if (p.type === 'exec_command_end' || p.type === 'function_call_output') {
    const call = take(state, p.call_id);
    const command = call?.command || (p.type === 'exec_command_end' ? testCommand(p.command) : '');
    if (!command) return;
    const output = p.output || p.aggregated_output || '';
    const status = p.exit_code ?? (/^Process exited with code (-?\d+)/m.exec(String(output))?.[1]);
    if (status != null && /^\d+$/.test(String(status))) addCheck(state, command, Number(status) !== 0, output);
  }
}

function claudeEvidence(state, row, ref) {
  for (const block of Array.isArray(row.message?.content) ? row.message.content : []) {
    if (block.type === 'tool_use') {
      if (FILE_TOOLS.has(block.name)) remember(state, block.id, { file: block.input?.file_path });
      if (block.name === 'Bash') {
        const command = testCommand(block.input?.command);
        if (command) remember(state, block.id, { command });
      }
    } else if (block.type === 'tool_result') {
      const call = take(state, block.tool_use_id);
      if (!call) continue;
      const result = row.toolUseResult || {};
      if (call.file && !block.is_error) {
        const diff = Array.isArray(result.structuredPatch) && result.structuredPatch.length > 0
          || result.type === 'create' && typeof result.content === 'string';
        addFile(state, call.file, { ...ref, id: block.tool_use_id, diff });
      }
      if (call.command && !result.interrupted && !result.backgroundTaskId && !result.task_id) {
        addCheck(state, call.command, !!block.is_error, result.stdout || block.content);
      }
    }
  }
}

function agyEvidence(state, row, ref) {
  const output = typeof row.content === 'string' ? row.content : '';
  const task = /\bTask ID\s*:?\s*["'`\[]?([a-f\d-]{36}(?:\/task-\d+)?)(?![\w/-])/i.exec(output.slice(0, 1500))?.[1];
  if (row.type === 'SYSTEM_MESSAGE' && row.source === 'SYSTEM' && task) {
    const call = take(state, task);
    const status = /^Command exited with code (-?\d+)\./m.exec(output);
    if (call && status) addCheck(state, call.command, Number(status[1]) !== 0, output);
    return false;
  }
  if (!Number.isSafeInteger(row.step_index) || row.source !== 'MODEL') return false;
  if (row.type === 'PLANNER_RESPONSE' && Array.isArray(row.tool_calls)) {
    row.tool_calls.forEach((tool, index) => {
      const { name, args = {} } = tool;
      const id = row.step_index + index + 1;
      const context = { name, ref: { ...ref, id: index } };
      if (name === 'edit_file' || name === 'write_file') remember(state, id, { ...context, file: args.Path });
      if (name === 'finish') remember(state, id, context);
      if (name === 'run_command') {
        const command = testCommand(args.CommandLine);
        if (command) remember(state, id, { ...context, command });
      }
    });
  }
  if (row.type !== 'GENERIC') return false;
  if (row.status === 'RUNNING' && task) {
    const call = take(state, row.step_index);
    if (call?.command) remember(state, task, { command: call.command });
    return false;
  }
  if (row.status !== 'DONE') return false;
  const call = take(state, row.step_index);
  if (!call) return false;
  if (call.name === 'finish') return true;
  if (call.command) {
    const status = /^Command exited with code (-?\d+)\./m.exec(output);
    if (status) addCheck(state, call.command, Number(status[1]) !== 0, output);
  }
  if (call.file) {
    const start = /^Made \d+ replacements? in .* starting at line (\d+) /m.exec(output);
    const created = /^Created file\./m.test(output);
    if (start || created || /^Overwrote file\./m.test(output)) {
      addFile(state, call.file, { ...call.ref, start: Number(start?.[1]) || 1, diff: !!start || created });
    }
  }
  return false;
}

function finishWork(state, id) {
  if (!state?.files.length && !state?.checks.length) return null;
  return { id: String(id), files: state.files.map(file => ({ ...file, refs: file.refs.slice() })),
    checks: state.checks.slice(), moreFiles: !!state.moreFiles };
}

module.exports = { MAX_LINE, workState, codexEvidence, claudeEvidence, agyEvidence, finishWork };
