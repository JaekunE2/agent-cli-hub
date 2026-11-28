'use strict';

// Claude draws ghost suggestions dimmed, with the cursor before the suggestion.
// Inspect cells before converting to plain text; content alone cannot distinguish
// a suggested next question from a user's unsent draft.
function withoutClaudeSuggestion(vt, lines, start) {
  const buffer = vt?.buffer?.active;
  if (!buffer) return lines;
  const row = buffer.baseY + buffer.cursorY - start;
  const prefix = /^([ \t]*[❯›>][ \u00a0])/.exec(lines[row] || '')?.[1];
  if (!prefix || buffer.cursorX !== prefix.length) return lines;
  let end = row, count = 0;
  for (; end < lines.length; end++) {
    if (end > row && /^\s*[─━╰└]{3,}/.test(lines[end])) break;
    const line = buffer.getLine(start + end);
    for (let x = end === row ? prefix.length : 0; x < (line?.length || 0); x++) {
      const cell = line.getCell(x);
      if (!cell?.getChars().trim()) continue;
      if (!cell.isDim()) return lines;
      count++;
    }
  }
  // A bottom divider identifies the composer, excluding dim transcript text.
  if (!count || end === lines.length) return lines;
  const result = [...lines];
  result[row] = prefix;
  for (let i = row + 1; i < end; i++) result[i] = '';
  return result;
}

module.exports = { withoutClaudeSuggestion };
