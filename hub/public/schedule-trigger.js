function scheduleTriggerFields() {
  return `<fieldset><legend>실행 주기</legend>
    <div class="sch-grid-2">
      <label>주기 유형 <select name="kind"><option value="interval">간격</option><option value="cron">Cron</option></select></label>
      <label>프리셋 <select name="preset">
        <option value="">직접 입력</option>
        <option data-kind="interval" value="15">15분마다</option>
        <option data-kind="interval" value="60">매시간</option>
        <option data-kind="cron" value="0 9 * * *">매일 09:00</option>
        <option data-kind="cron" value="0 9 * * 1-5">평일 09:00</option>
      </select></label>
    </div>
    <div class="sch-grid-2">
      <label>간격 (분) <input name="everyMinutes" type="number" min="1" max="10080" required></label>
      <label>Cron <input name="expression" placeholder="0 9 * * 1-5" required></label>
      <label>시간대 (IANA) <input name="timeZone" placeholder="Asia/Seoul" required></label>
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
  kind.value = existing?.kind || 'interval';
  everyMinutes.value = existing?.everyMinutes ?? 60;
  expression.value = existing?.expression ?? '0 9 * * *';
  timeZone.value = existing?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
  let generation = 0;

  const read = () => kind.value === 'interval'
    ? { kind: 'interval', everyMinutes: everyMinutes.valueAsNumber }
    : { kind: 'cron', expression: expression.value.trim(), timeZone: timeZone.value.trim() };

  function sync() {
    generation++;
    output.replaceChildren();
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
      if (current === generation) output.innerHTML = `<ol>${result.nextRunAts.map(value => `<li>${esc(scheduleDate(value))}</li>`).join('')}</ol>`;
    } catch (cause) {
      if (current === generation) output.textContent = cause.message;
    }
  };
  sync();
  return { original: read(), read };
}
