// StopFailure hook: the turn ended on an API error (usage limit, overload, ...).
// Park the director in "waiting" so the watchdog wakes it later instead of hammering.
const H = require('./common');

const input = H.readInput();
const proj = H.findProject(input.cwd);
if (!proj) process.exit(0);
const st = H.loadState(proj);
if (!st || !H.isDirector(input, st)) process.exit(0);

const blob = JSON.stringify(input).toLowerCase();
const isLimit = /rate_limit|usage limit|limit reached|429/.test(blob);
const mins = isLimit ? 30 : 5; // the dashboard watchdog refines this from the real reset time
if (!['paused', 'done', 'blocked'].includes(st.status)) {
  st.status = 'waiting';
  st.wake_at = new Date(Date.now() + mins * 60e3).toISOString();
  st.wait_reason = isLimit ? 'usage limit (API 429)' : 'API error — 잠시 후 재시도';
  st.limited = isLimit;
  H.saveState(proj, st);
}
H.hookLog(proj, `stop-failure: ${isLimit ? 'limit' : 'error'} → waiting ${mins}m · input keys=${Object.keys(input).join(',')}`);
