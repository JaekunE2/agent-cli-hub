function chatWorkOutcomeHTML(result) {
  if (!result?.checks.length) return '';
  const failed = [...result.checks.entries()].filter(([, check]) => check.failed);
  if (!failed.length) {
    const passed = [...new Set(result.checks.flatMap(check => check.passedNames || []))]
      .filter(name => !/^(?:\S+[\\/])?\S+\.(?:[cm]?[jt]sx?|py|cs|rs|go)$/.test(name)).slice(0, 2);
    return passed.length ? `<div class="chat-work-tested">
      <strong>테스트에서 확인된 동작</strong>
      <ul>${passed.map(name => `<li>${esc(name)}</li>`).join('')}</ul>
    </div>` : '';
  }
  return `<div class="chat-work-failure">
    <strong>실패한 검증</strong>
    <ul>${failed.slice(0, 2).map(([index, check]) => `<li>
      ${check.failureNames?.length ? `<ul>${check.failureNames.map((name, caseIndex) => {
        const diff = check.assertions?.[name];
        return `<li>${esc(name)}${diff ? ` <span class="muted">기대값 ${esc(diff.expected)} · 실제값 ${esc(diff.actual)}</span>` : ''}
          <button type="button" class="ghost btn-sm" data-work-fix="${index}" data-work-case="${caseIndex}">이 실패 수정 요청</button>
        </li>`;
      }).join('')}</ul>` : `<code>${esc(check.command)}</code>
        <button type="button" class="ghost btn-sm" data-work-fix="${index}">이 실패 수정 요청</button>`}
    </li>`).join('')}</ul>
    ${failed.length > 2 ? `<span>외 ${failed.length - 2}건은 변경 내역에 표시됩니다.</span>` : ''}
  </div>`;
}

function workFailureRequest(check, name) {
  const scenarios = (name ? [name] : check.failureNames || []).map(name => {
    const diff = check.assertions?.[name];
    return `- ${name}${diff ? ` (기대값 ${diff.expected}, 실제값 ${diff.actual})` : ''}`;
  });
  return [
    '아래 검증 실패를 재현해 사용자에게 문제가 되는 동작을 수정한 뒤 같은 검증을 다시 실행해 주세요.',
    `실패 명령: ${check.command}`,
    ...scenarios,
  ].join('\n');
}

function chatWorkCardHTML(result, open) {
  if (!result) return '';
  const { files, checks } = result;
  const failed = checks.filter(check => check.failed).length;
  const completed = checks.length - failed;
  const testCount = checks.length === 1 ? checks[0].count : null;
  const status = failed ? '' : testCount ? `테스트 ${testCount}개 통과`
    : completed === 1 ? '검증 명령 완료' : completed ? `검증 완료 ${completed}건` : '';
  return `<details class="chat-work-card" data-work-result="${esc(result.id)}"${open ? ' open' : ''}>
    <summary><span class="chat-work-summary"><b>변경 내역</b>
      ${status ? `<strong class="badge ok chat-work-verdict">${status}</strong>` : ''}
    </span></summary>
    <div class="chat-work-body">
      ${checks.map(check => `<div class="chat-work-check"><code>${esc(check.command)}</code>
        <span class="badge ${check.failed ? 'lim' : 'ok'}">${check.failed ? '실패' : check.count ? `테스트 ${check.count}개 통과` : '종료 코드 0'}</span>
        ${check.failureNames?.length ? `<span>${check.failureNames.map(esc).join(' · ')}</span>` : ''}</div>`).join('')}
      ${files.map(file => file.hasDiff
        ? `<button type="button" class="ghost btn-sm chat-work-file" data-work-file="${esc(file.path)}" title="${esc(file.path)}">${esc(file.path)}</button>`
        : `<span class="chat-work-file muted" title="${esc(file.path)}">${esc(file.path)}</span>`).join('')}
    </div>
  </details>`;
}

function chatRegionStatuses(outcome) {
  const regionStatus = {
    outside: ['lim', '선택 영역 밖도 변경됨'],
    unchanged: ['lim', '선택 영역에 변경 없음'],
    size: ['lim', '이미지 크기가 변경됨'],
    inside: ['ok', '선택 영역 안에서만 변경됨'],
    unavailable: ['warn', '수정 후 이미지 비교 불가'],
  }[outcome.scope];
  const color = outcome.color === 'red' ? '빨간색' : '흑백';
  const colorStatus = outcome.colorCheck === true ? ['ok', `선택 영역의 ${color} 적용 확인`]
    : outcome.colorCheck === false ? ['lim', `선택 영역에 ${color} 조건을 충족하지 않는 픽셀이 있음`] : null;
  return [colorStatus, regionStatus].filter(Boolean);
}

function chatRegionOutcomeHTML(outcome) {
  if (!outcome) return '';
  const statuses = chatRegionStatuses(outcome);
  return `<div class="chat-work-outcome">
    ${outcome.thumbnail ? `<button class="ghost chat-work-image" type="button" data-work-image aria-label="수정된 이미지 확대">
      <img src="${esc(outcome.thumbnail)}" alt="수정된 이미지">
    </button>` : ''}
    <div class="chat-work-observations">${statuses.map(([tone, label]) =>
      `<strong class="badge ${tone}">${label}</strong>`).join('')}
      ${statuses.some(([tone]) => tone === 'lim') ? '<button type="button" class="ghost btn-sm" data-work-image-fix>이미지 수정 요청</button>' : ''}
    </div>
  </div>`;
}

function regionFailureRequest(outcome) {
  const regions = (outcome.regions || []).map(({ x, y, w, h }) =>
    `- ${[x, y, w, h].map(value => (value * 100).toFixed(1)).join(', ')}`);
  return [
    '아래 이미지 검증 결과를 바탕으로 원래 요청대로 같은 파일을 수정해 주세요.',
    quotePath(outcome.item.abs || outcome.item.path),
    outcome.comment ? `원래 요청: ${outcome.comment}` : '',
    '선택 영역 (왼쪽%, 위%, 너비%, 높이%)',
    ...regions,
    ...chatRegionStatuses(outcome).filter(([tone]) => tone === 'lim').map(([, label]) => `- ${label}`),
  ].filter(Boolean).join('\n');
}

// Keep a small baseline in the browser that submitted the region edit.
const pendingRegionChecks = new Map();
const completedRegionChecks = new Map();
const reviewedImages = new WeakSet();
const regionTargetKey = target => `${target.kind}:${target.id}`;

function imagePixels(image) {
  const width = image.naturalWidth || image.width, height = image.naturalHeight || image.height;
  if (!width || !height || width * height > 4_000_000) return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  return ctx.getImageData(0, 0, width, height);
}

function regionPixelBoxes({ width, height }, regions) {
  return regions.map(({ x, y, w, h }) => {
    const left = Math.floor(x * width), top = Math.floor(y * height);
    return [left, top, Math.min(width, left + Math.max(1, Math.round(w * width))),
      Math.min(height, top + Math.max(1, Math.round(h * height)))];
  });
}

function regionPixelCheck(before, after, regions) {
  if (!after) return 'unavailable';
  if (before.width !== after.width || before.height !== after.height) return 'size';
  const { width, data } = before;
  const boxes = regionPixelBoxes(before, regions);
  let changed = false;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] === after.data[i] && data[i + 1] === after.data[i + 1]
      && data[i + 2] === after.data[i + 2] && data[i + 3] === after.data[i + 3]) continue;
    const x = (i / 4) % width, y = Math.floor(i / 4 / width);
    if (!boxes.some(([l, t, r, b]) => x >= l && x < r && y >= t && y < b)) return 'outside';
    changed = true;
  }
  return changed ? 'inside' : 'unchanged';
}

function requestedRegionColor(comment) {
  const text = String(comment || '').trim().toLowerCase().replace(/[.!?]+$/, '');
  const ko = /^(?:(?:여기|이\s*부분|선택\s*영역)(?:만|을)?\s*)?(빨갛게|빨간색으로|흑백으로|회색조로)\s*(?:변경|수정|바꿔|칠해|만들어)?\s*(?:해\s*)?(?:\s*주(?:세|십시)요|\s*줘)?$/.exec(text)?.[1];
  if (ko) return /^빨/.test(ko) ? 'red' : 'grayscale';
  const en = /^(?:please\s+)?(?:make|turn|color|fill|convert)\s+(?:(?:just|only)\s+)?(?:this|it|(?:the\s+)?(?:selected\s+)?(?:region|area|selection))\s+(?:to\s+|with\s+)?(red|grayscale|greyscale|black and white)$/.exec(text)?.[1];
  return en ? (en === 'red' ? 'red' : 'grayscale') : '';
}

function regionColorCheck(image, regions, color) {
  const { width, data } = image;
  let visible = false;
  for (const [left, top, right, bottom] of regionPixelBoxes(image, regions)) {
    for (let y = top; y < bottom; y++) {
      for (let x = left; x < right; x++) {
        const i = (y * width + x) * 4;
        if (data[i + 3] === 0) continue;
        visible = true;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        if (color === 'red' ? r < 24 || Math.max(g, b) > r * 0.8
          : Math.max(r, g, b) - Math.min(r, g, b) > 4) return false;
      }
    }
  }
  return visible;
}

function regionThumbnail(bitmap) {
  const ratio = Math.min(1, 320 / bitmap.width, 160 / bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
  canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL();
}

async function sendWithRegionCheck(image, item, regions, target, text, send, comment) {
  if (!target || item.kind !== 'image' || !/\.png$/i.test(item.path) || !regions?.length
    || regions.length > 16 || image.tagName !== 'IMG' || !image.naturalWidth) return send();
  const url = new URL(image.src, location.href);
  if (url.origin !== location.origin || url.pathname !== '/api/artifact-file') return send();
  const key = regionTargetKey(target);
  const previous = pendingRegionChecks.get(key);
  // Replies to overlapping edits cannot establish which request changed a pixel.
  const overlapping = previous?.item.path === item.path;
  let before;
  if (!overlapping) {
    try {
      if (reviewedImages.has(image)) {
        const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(4000) });
        if (res.ok) {
          const bitmap = await createImageBitmap(await res.blob());
          try { before = imagePixels(bitmap); }
          finally { bitmap.close(); }
        }
      } else before = imagePixels(image);
    } catch {}
    if (!before) return send();
  }
  const entry = { before, url, item, regions, comment, color: requestedRegionColor(comment), text: text.trim(), sentAt: Date.now() };
  if (!pendingRegionChecks.has(key) && pendingRegionChecks.size >= 4) {
    pendingRegionChecks.delete(pendingRegionChecks.keys().next().value);
  }
  pendingRegionChecks.set(key, entry);
  try {
    const result = await send();
    reviewedImages.add(image);
    return result;
  } catch (error) {
    if (pendingRegionChecks.get(key) === entry) {
      if (previous) {
        previous.check = null;
        pendingRegionChecks.set(key, previous);
      } else pendingRegionChecks.delete(key);
    }
    throw error;
  }
}

function observedRegionCheck(sid, message, index) {
  return completedRegionChecks.get(JSON.stringify([sid, message.ts, index]));
}

async function settleRegionCheck(target, sid, messages, base) {
  const key = regionTargetKey(target), entry = pendingRegionChecks.get(key);
  if (!entry || !messages.length) return '';
  if (Date.now() - entry.sentAt > 30 * 60_000) { pendingRegionChecks.delete(key); return ''; }
  const user = messages.findLastIndex(m => m.role === 'user');
  const sentAt = Date.parse(messages[user]?.ts);
  if (user < 0 || messages[user].text.trim() !== entry.text || !(sentAt >= entry.sentAt - 1000)) return '';
  const answer = messages.findLastIndex(m => m.role === 'assistant' && !String(m.text).startsWith('⚙'));
  if (answer <= user) return '';
  const resultKey = JSON.stringify([sid, messages[answer].ts, base + answer]);
  entry.check ||= (async () => {
    const observation = {
      item: entry.item, url: entry.url.href, regions: entry.regions, comment: entry.comment, scope: 'unavailable', color: entry.color,
    };
    try {
      const res = await fetch(entry.url, { cache: 'no-store', signal: AbortSignal.timeout(4000) });
      if (res.ok) {
        const bitmap = await createImageBitmap(await res.blob());
        try {
          const after = imagePixels(bitmap);
          if (entry.before) observation.scope = regionPixelCheck(entry.before, after, entry.regions);
          if (entry.color && ['inside', 'outside', 'unchanged'].includes(observation.scope)) {
            observation.colorCheck = regionColorCheck(after, entry.regions, entry.color);
          }
          observation.thumbnail = regionThumbnail(bitmap);
        }
        finally { bitmap.close(); }
      }
    } catch {}
    if (pendingRegionChecks.get(key) !== entry) return '';
    pendingRegionChecks.delete(key);
    if (completedRegionChecks.size >= 40) completedRegionChecks.delete(completedRegionChecks.keys().next().value);
    completedRegionChecks.set(resultKey, observation);
    return observation;
  })();
  return entry.check;
}

async function openChatWorkDiff(sid, result, file) {
  const target = artifactChatTarget();
  const dialog = document.createElement('dialog');
  dialog.className = 'dlg artifact-preview chat-work-dialog';
  dialog.innerHTML = `<div class="box wide">
    <div class="artifact-preview-head"><b title="${esc(file)}">${esc(file)}</b>
      <button type="button" class="ghost icon-btn btn-sm" aria-label="닫기">${ICO.close}</button></div>
    <div class="pg-diff-pre chat-work-diff" role="region" aria-label="기록된 변경 내용" tabindex="0">불러오는 중…</div>
  </div>`;
  const panel = $('.chat-work-diff', dialog);
  $('button', dialog).onclick = () => dialog.close();
  dialog.onclose = () => dialog.remove();
  document.body.append(dialog);
  dialog.showModal();
  try {
    const params = new URLSearchParams({ id: sid, result, file });
    const data = await api(`/api/transcript/work-diff?${params}`);
    if (!dialog.open) return;
    panel.textContent = data.patch ? '' : '기록된 변경 내용을 찾을 수 없습니다.';
    let lineNumber = 0;
    for (const line of data.patch?.split('\n') || []) {
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (hunk) lineNumber = Number(hunk[1]);
      const lineNode = document.createElement('div');
      lineNode.className = gitDiffLineClass(line);
      lineNode.textContent = line || ' ';
      if (line.startsWith('+') && !line.startsWith('+++') && lineNumber && target) {
        const at = lineNumber;
        const ask = document.createElement('button');
        ask.type = 'button';
        ask.className = 'ghost btn-sm';
        ask.textContent = String(at);
        ask.setAttribute('aria-label', '이 줄에 대해 질문');
        ask.onclick = () => {
          dialog.close();
          stageReviewInChat(`파일: ${quotePath(file)}\n줄: ${at}\n`, [], target);
        };
        lineNode.prepend(ask);
      }
      if (/^[+ ]/.test(line) && !line.startsWith('+++') && lineNumber) lineNumber++;
      panel.append(lineNode);
    }
    if (data.partial) panel.append('\n일부 변경만 표시합니다.');
  } catch {
    panel.textContent = '기록된 변경 내용을 찾을 수 없습니다.';
  }
}
