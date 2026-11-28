'use strict';

const fs = require('fs/promises');
const { MAX_LINE } = require('./chat-work-result');

function wholeFilePatch(text, add) {
  if (typeof text !== 'string') return '';
  const lines = text.replace(/\n$/, '').split('\n');
  const header = add ? `@@ -0,0 +1,${lines.length} @@` : `@@ -1,${lines.length} +0,0 @@`;
  return [header, ...lines.map(line => (add ? '+' : '-') + line)].join('\n');
}

function patchOf(row, agent, file, id, start) {
  if (agent === 'codex') {
    const p = row.payload;
    const item = p?.type === 'item_completed' ? p.item : null;
    const patch = p?.type === 'patch_apply_end' && p.success === true ? p
      : item?.type === 'FileChange' && String(item.status).toLowerCase() === 'completed' ? item : null;
    if (!patch || (patch.call_id || patch.id) !== id || !Object.hasOwn(patch.changes || {}, file)) return '';
    const change = patch.changes[file];
    if (typeof change.unified_diff === 'string') return change.unified_diff;
    return change.type === 'add' || change.type === 'delete' ? wholeFilePatch(change.content, change.type === 'add') : '';
  }
  if (agent === 'agy') {
    const tool = row.tool_calls?.[id];
    if (row.type !== 'PLANNER_RESPONSE' || tool?.args?.Path !== file) return '';
    if (tool.name === 'write_file') return wholeFilePatch(tool.args.Content, true);
    const { Target, Replacement } = tool.args;
    if (tool.name !== 'edit_file' || typeof Target !== 'string' || typeof Replacement !== 'string') return '';
    const before = Target.replace(/\n$/, '').split('\n');
    const after = Replacement.replace(/\n$/, '').split('\n');
    return [`@@ -${start},${before.length} +${start},${after.length} @@`, ...before.map(line => '-' + line), ...after.map(line => '+' + line)].join('\n');
  }
  if (!row.message?.content?.some?.(block => block.type === 'tool_result' && block.tool_use_id === id && !block.is_error)) return '';
  const result = row.toolUseResult;
  if (result?.filePath && result.filePath !== file) return '';
  if (result?.type === 'create' && (!result.structuredPatch?.length)) return wholeFilePatch(result.content, true);
  if (!Array.isArray(result?.structuredPatch)) return '';
  return result.structuredPatch.map(hunk => [
    `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    ...(Array.isArray(hunk.lines) ? hunk.lines : []),
  ].join('\n')).join('\n');
}

async function chatWorkDiff(doc, entry) {
  const file = await fs.open(doc.file, 'r');
  const patches = [];
  try {
    for (const { offset, length, id, diff, start } of entry.refs) {
      if (!diff) continue;
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > MAX_LINE) continue;
      const buffer = Buffer.alloc(length);
      if ((await file.read(buffer, 0, length, offset)).bytesRead !== length) continue;
      try {
        const patch = patchOf(JSON.parse(buffer.toString('utf8')), doc.agent, entry.path, id, start);
        if (patch) patches.push(patch);
      } catch {}
    }
  } finally { await file.close(); }
  const patch = patches.join('\n\n');
  return { patch: patch.slice(0, 48000), partial: !!entry.partial || patches.length !== entry.refs.length || patch.length > 48000 };
}

module.exports = { chatWorkDiff };
