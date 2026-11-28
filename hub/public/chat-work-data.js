function requestedArtifactRows(text) {
  const counts = new Set();
  for (const line of String(text || '').split('\n')) {
    const match = /^\s*(?:데이터\s*(?:행|항목)\s*(?:수\s*)?[:=]?\s*(\d+)\s*개?(?:로\s*(?:만들어|작성해)\s*주(?:세요|십시오))?|(?:data rows|record count)\s*[:=]\s*(\d+))\s*[.!]?\s*$/i.exec(line);
    if (match) counts.add(Number(match[1] || match[2]));
  }
  const count = counts.values().next().value;
  return counts.size === 1 && Number.isSafeInteger(count) ? count : null;
}

function readChatDelimited(text, delimiter) {
  text = text.replace(/^\uFEFF/, '');
  const records = [];
  let row = [], field = '', quoted = false, closed = false;
  for (let i = 0; i <= text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') { quoted = false; closed = true; }
      else if (ch === undefined) return null;
      else field += ch;
    } else if (ch === delimiter || ch === '\n' || ch === '\r' || ch === undefined) {
      row.push(field);
      field = '';
      if (ch !== delimiter) {
        if (closed || row.length > 1 || row[0].trim()) records.push(row);
        row = [];
        if (ch === '\r' && text[i + 1] === '\n') i++;
      }
      closed = false;
    } else if (ch === '"' && !field && !closed) {
      quoted = true;
    } else {
      if (closed || ch === '"') return null;
      field += ch;
    }
  }
  return records;
}

async function renderChatArtifactData(content, item, url, expected, onFix = null) {
  const cap = 65536;
  if (item.size > cap) return false;
  const response = await fetch(url, { headers: { Range: 'bytes=0-65535' }, signal: AbortSignal.timeout(5000) });
  const length = Number(response.headers.get('content-length')) || 0;
  if (!response.ok || !length || length > cap || (response.status === 206 && response.headers.get('content-range') !== `bytes 0-${length - 1}/${length}`)) {
    await response.body?.cancel();
    return false;
  }
  const text = await response.text();
  if (item.ext === 'json') {
    let data;
    try { data = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { return false; }
    const count = Array.isArray(data) ? data.length : null;
    const view = document.createElement('pre');
    view.className = 'mdpre';
    const sample = Array.isArray(data) ? data.slice(0, 3) : data;
    view.textContent = JSON.stringify(sample, null, 2).slice(0, 400);
    showChatDataExcerpt(content, view, count, expected, false, item, onFix);
  } else {
    const rows = readChatDelimited(text, item.ext === 'tsv' ? '\t' : ',');
    if (!rows?.length || rows.some(row => row.length !== rows[0].length)) return false;
    const table = document.createElement('table');
    table.className = 'chat-result-table';
    const [header, ...data] = rows;
    for (const row of [header, ...data.slice(0, 3)]) {
      const tr = row === header ? table.createTHead().insertRow() : table.insertRow();
      for (const value of row.slice(0, 4)) {
        const cell = document.createElement(row === header ? 'th' : 'td');
        cell.textContent = value.slice(0, 80);
        tr.append(cell);
      }
    }
    showChatDataExcerpt(content, table, data.length, expected, true, item, onFix);
  }
  return true;
}

function chatDataFixRequest(item, count, expected, header) {
  return [
    '아래 파일이 원래 요청한 데이터 개수를 충족하도록 원인을 확인하고 같은 파일을 수정해 주세요.',
    quotePath(item.abs || item.path),
    header ? `요청 ${expected}행 · 실제 ${count}행 (첫 행 제외)`
      : `요청 ${expected}개 · 실제 ${count}개`,
  ].join('\n');
}

function showChatDataExcerpt(content, view, count, expected, header, item, onFix) {
  const summary = document.createElement('div');
  summary.className = 'chat-result-data-summary';
  summary.textContent = count == null ? '현재 파일 일부'
    : header ? `현재 파일 · 데이터 ${count}행 (첫 행 제외)` : `현재 파일 · 항목 ${count}개`;
  if (count != null && expected != null) {
    const status = document.createElement('strong');
    status.className = `badge ${count === expected ? 'ok' : 'lim'}`;
    status.textContent = count === expected ? '요청한 개수와 일치' : `요청 ${expected}개와 다름`;
    summary.append(status);
    if (count !== expected && onFix) {
      const fix = document.createElement('button');
      fix.className = 'ghost btn-sm';
      fix.type = 'button';
      fix.textContent = '데이터 수정 요청';
      fix.onclick = () => onFix(chatDataFixRequest(item, count, expected, header));
      summary.append(fix);
    }
  }
  content.replaceChildren(summary, view);
}
