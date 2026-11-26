function openScheduleForm({ item, projects, capabilities, onSaved, onClose }) {
  const drawer = openDrawer({
    title: item ? '스케줄 편집' : '스케줄 만들기',
    width: 640,
    focus: true,
    onClose,
    bodyHTML: `<form class="schedule-form">
      <label>이름 <input name="name" required maxlength="120" placeholder="예: 일일 서버 점검" value="${esc(item?.name || '')}"></label>
      ${scheduleTriggerFields()}
      ${scheduleTargetFields()}
      <label>프롬프트 <textarea name="prompt" required maxlength="16000" rows="4" placeholder="주기적으로 실행할 작업 지시를 입력하세요">${esc(item?.prompt || '')}</textarea></label>
      <details class="sch-advanced">
        <summary>고급 옵션 (참조 폴더 · 동시 실행 · 제한 시간)</summary>
        <div class="sch-adv-body">
          <label>참조 폴더 (한 줄에 하나) <textarea name="referenceDirs" rows="2"></textarea></label>
          <div class="sch-grid-3">
            <label>동시 실행 <select name="overlap">
              <option value="skip">건너뛰기</option><option value="queue">한 건 대기</option><option value="replace">기존 실행 교체</option>
            </select></label>
            <label>놓친 실행 (Misfire) <select name="misfire">
              <option value="skip">건너뛰기</option><option value="run_once">최근 누락 한 번 실행</option>
            </select></label>
            <label>제한 시간 (초) <input name="timeoutSec" type="number" required min="30" max="3600" value="${item?.timeoutSec ?? 900}"></label>
          </div>
          <p class="sch-help">동시 실행: 이전 작업이 안 끝났을 때의 동작 · 놓친 실행(Misfire): PC 절전/종료로 예약 시각을 놓쳤을 때의 동작입니다.</p>
        </div>
      </details>
      <p role="status" data-form-error></p>
    </form>`,
    footerHTML: '<button type="button" data-drw-close>취소</button><button type="button" class="primary" data-schedule-save>저장</button>',
  });
  const form = $('form', drawer);
  const fields = form.elements;
  fields.overlap.value = item?.overlap || 'skip';
  fields.misfire.value = item?.misfire || 'skip';
  const trigger = bindScheduleTrigger(form, item?.trigger);
  const target = bindScheduleTarget(fields, projects, capabilities, item?.target);
  const save = $('[data-schedule-save]', drawer);
  const error = $('[data-form-error]', drawer);
  save.onclick = () => form.requestSubmit();
  form.onsubmit = async event => {
    event.preventDefault();
    if (save.disabled) return;
    const body = {
      name: fields.name.value.trim(), trigger: trigger.read(), target: target(),
      prompt: fields.prompt.value, overlap: fields.overlap.value,
      misfire: fields.misfire.value, timeoutSec: fields.timeoutSec.valueAsNumber,
    };
    if (!body.name || !body.prompt.trim()) {
      error.textContent = '이름과 프롬프트를 입력하세요.';
      return;
    }
    if (item) {
      body.revision = item.revision;
      if (JSON.stringify(body.trigger) === JSON.stringify(trigger.original)) delete body.trigger;
    }
    save.disabled = true;
    error.textContent = '';
    try {
      await scheduleRequest(item ? schedulePath(item.id) : '', { method: item ? 'PATCH' : 'POST', body });
      drawer.close();
      if (!item) toast('스케줄을 저장했습니다 (일시정지 상태 · 실행하려면 재개를 누르세요)');
      onSaved();
    } catch (cause) {
      error.textContent = cause.message;
      if (cause.code === 'SCHEDULE_CONFLICT') onSaved();
    } finally {
      save.disabled = false;
    }
  };
  return drawer;
}
