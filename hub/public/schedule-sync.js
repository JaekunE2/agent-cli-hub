// A ready message establishes the sequence after each connection.
function watchSchedules(refresh) {
  let socket, retry, fallback;
  let stopped = false;
  let seq = -1;
  const connect = () => {
    const url = new URL('/ws/schedules', location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('t', TOKEN);
    socket = new WebSocket(url);
    fallback = setTimeout(refresh, 1500);
    socket.onmessage = ({ data }) => {
      let event;
      try { event = JSON.parse(data); } catch { return; }
      if (stopped || !Number.isSafeInteger(event?.seq)) return;
      if (event.type === 'schedules.ready') {
        clearTimeout(fallback);
        seq = event.seq;
        refresh();
      } else if (event.type === 'schedules.changed' && event.seq > seq) {
        seq = event.seq;
        refresh();
      }
    };
    socket.onclose = () => {
      if (stopped) return;
      clearTimeout(fallback);
      refresh();
      retry = setTimeout(connect, 2000);
    };
  };
  connect();
  return () => {
    stopped = true;
    clearTimeout(retry);
    clearTimeout(fallback);
    socket.close();
  };
}

async function scheduleRequest(path = '', options) {
  const result = await api('/api/schedules' + path, options);
  if (result.error) {
    const errors = {
      INVALID_SCHEDULE: '이름, 프롬프트와 제한 시간을 확인하세요.',
      INVALID_TRIGGER: '실행 주기 또는 시간대를 확인하세요.',
      INVALID_TARGET: '대상 프로젝트 설정을 확인하세요.',
      TARGET_MISSING: '대상 프로젝트, 버전 또는 작업을 찾을 수 없습니다.',
      SCHEDULE_MISSING: '스케줄을 찾을 수 없습니다.',
      SCHEDULE_CONFLICT: '스케줄이 변경되었습니다. 최신 항목을 다시 열어 주세요.',
      SCHEDULE_UNAVAILABLE: '스케줄 서비스를 사용할 수 없습니다.',
      LOCAL_REQUIRED: '스케줄 변경은 로컬 접속에서만 가능합니다.',
      CAPABILITY_UNSUPPORTED: '이 CLI 또는 계정은 스케줄을 지원하지 않습니다.',
      BODY_TOO_LARGE: '스케줄 입력이 너무 큽니다.',
      SCHEDULE_LIMIT: '스케줄 등록 한도에 도달했습니다.',
    };
    throw Object.assign(new Error(errors[result.code] || result.error), { code: result.code });
  }
  return result;
}

const schedulePath = id => '/' + encodeURIComponent(id);
const scheduleDate = value => value ? new Date(value).toLocaleString(document.documentElement.lang) : '—';
