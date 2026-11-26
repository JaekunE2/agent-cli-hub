function scheduleTriggerFields() {
  const days = [['1', '월'], ['2', '화'], ['3', '수'], ['4', '목'], ['5', '금'], ['6', '토'], ['0', '일']];
  return `<fieldset><legend>실행 주기</legend>
    <div class="sch-grid-2">
      <label>주기 유형 <select name="kind"><option value="interval">간격 반복</option><option value="cron">특정 요일 · 시각 (Cron)</option></select></label>
      <label>빠른 프리셋 <select name="preset">
        <option value="">직접 입력</option>
        <option data-kind="interval" value="5">5분마다</option>
        <option data-kind="interval" value="15">15분마다</option>
        <option data-kind="interval" value="30">30분마다</option>
        <option data-kind="interval" value="60">매시간 (60분)</option>
        <option data-kind="interval" value="360">6시간마다</option>
        <option data-kind="interval" value="1440">매일 (24시간마다)</option>
        <option data-kind="cron" value="0 9 * * *">매일 09:00</option>
        <option data-kind="cron" value="0 9 * * 1-5">평일 09:00</option>
        <option data-kind="cron" value="0 18 * * 1-5">평일 18:00</option>
        <option data-kind="cron" value="0 9 * * 1">매주 월요일 09:00</option>
        <option data-kind="cron" value="0 9 1 * *">매월 1일 09:00</option>
      </select></label>
    </div>
    <div class="sch-visual-builder" data-sch-cron-builder hidden>
      <div class="sch-visual-row">
        <span class="sch-help" style="font-weight:600">간편 설정</span>
        <input type="time" data-sch-time value="09:00" aria-label="실행 시각" style="width:auto;min-height:28px;height:28px;font-size:12px">
        <div class="sch-weekdays" role="group" aria-label="실행 요일">
          ${days.map(([v, l]) => `<button type="button" class="sch-day-chip" data-sch-dow="${v}" aria-pressed="false">${l}</button>`).join('')}
        </div>
      </div>
      <p class="sch-help">시각과 요일을 고르면 아래 Cron 식이 자동으로 채워집니다. 요일을 모두 해제하면 매일 실행됩니다.</p>
    </div>
    <div class="sch-grid-2">
      <label>간격 (분) <input name="everyMinutes" type="number" min="1" max="10080" required></label>
      <label>Cron <input name="expression" placeholder="0 9 * * 1-5" required></label>
      <label>시간대 (IANA) <input name="timeZone" list="schTzList" placeholder="Asia/Seoul" required></label>
      <datalist id="schTzList">
        <option value="Asia/Seoul"><option value="UTC"><option value="Asia/Tokyo">
        <option value="America/New_York"><option value="America/Los_Angeles"><option value="Europe/London">
      </datalist>
    </div>
    <div class="sch-preview-row">
      <button type="button" class="btn-sm" name="preview">다음 실행 미리보기</button>
    </div>
    <div role="status" data-schedule-preview></div>
  </fieldset>`;
}

function bindScheduleTrigger(form, existing) {
  const { kind, everyMinutes, expression, timeZone, preset, preview } = form.elements;
  const output = $('[data-schedule-preview]', form);
  const builder = $('[data-sch-cron-builder]', form);
  const timeIn = $('[data-sch-time]', form);
  const dowBtns = [...form.querySelectorAll('[data-sch-dow]')];
  kind.value = existing?.kind || 'interval';
  everyMinutes.value = existing?.everyMinutes ?? 60;
  expression.value = existing?.expression ?? '0 9 * * *';
  timeZone.value = existing?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
  let generation = 0;

  const read = () => kind.value === 'interval'
    ? { kind: 'interval', everyMinutes: everyMinutes.valueAsNumber }
    : { kind: 'cron', expression: expression.value.trim(), timeZone: timeZone.value.trim() };

  const syncBuilderFromCron = () => {
    const parts = expression.value.trim().split(/\s+/);
    if (parts.length !== 5 || !/^\d+$/.test(parts[0]) || !/^\d+$/.test(parts[1])) return;
    if (timeIn) timeIn.value = `${parts[1].padStart(2, '0')}:${parts[0].padStart(2, '0')}`;
    const dow = parts[4];
    const active = new Set();
    if (dow === '1-5') ['1', '2', '3', '4', '5'].forEach(d => active.add(d));
    else if (dow !== '*') dow.split(',').forEach(d => active.add(d.trim()));
    for (const b of dowBtns) {
      const on = active.has(b.dataset.schDow);
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    }
  };
  const applyBuilderToCron = () => {
    const [hh = '09', mm = '00'] = (timeIn?.value || '09:00').split(':');
    const selected = dowBtns.filter(b => b.classList.contains('on')).map(b => b.dataset.schDow);
    const dowExpr = !selected.length || selected.length === 7 ? '*'
      : selected.join(',') === '1,2,3,4,5' ? '1-5' : selected.join(',');
    expression.value = `${Number(mm)} ${Number(hh)} * * ${dowExpr}`;
    sync();
  };
  if (timeIn) timeIn.onchange = applyBuilderToCron;
  for (const b of dowBtns) {
    b.onclick = () => {
      const next = !b.classList.contains('on');
      b.classList.toggle('on', next);
      b.setAttribute('aria-pressed', String(next));
      applyBuilderToCron();
    };
  }

  function sync() {
    generation++;
    output.replaceChildren();
    if (builder) builder.hidden = kind.value !== 'cron';
    for (const input of [everyMinutes, expression, timeZone]) {
      input.disabled = (kind.value === 'interval') !== (input === everyMinutes);
      input.closest('label').hidden = input.disabled;
    }
    const value = kind.value === 'interval' ? everyMinutes.value : expression.value;
    for (const option of preset.options) {
      option.hidden = Boolean(option.dataset.kind && option.dataset.kind !== kind.value);
      option.disabled = option.hidden;
    }
    preset.value = [...preset.options].some(option => !option.hidden && option.value === value) ? value : '';
    if (kind.value === 'cron') syncBuilderFromCron();
  }
  kind.onchange = sync;
  everyMinutes.oninput = expression.oninput = timeZone.oninput = sync;
  preset.onchange = () => {
    if (!preset.value) return (kind.value === 'interval' ? everyMinutes : expression).focus();
    (kind.value === 'interval' ? everyMinutes : expression).value = preset.value;
    sync();
  };
  preview.onclick = async () => {
    if (![everyMinutes, expression, timeZone].every(input => input.reportValidity())) return;
    const current = ++generation;
    output.textContent = '미리보기 불러오는 중…';
    try {
      const result = await scheduleRequest('/preview', { method: 'POST', body: { trigger: read() } });
      if (current === generation) output.innerHTML = `<ol class="sch-preview-list">${result.nextRunAts.map(value => `<li>${esc(scheduleDate(value))}</li>`).join('')}</ol>`;
    } catch (cause) {
      if (current === generation) output.textContent = cause.message;
    }
  };
  sync();
  return { original: read(), read };
}
