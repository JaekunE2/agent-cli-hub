// Which side effects this hub process may have. The main hub (port 7777) does everything; any other port
// is a side instance (a test copy next to the live hub) that must not compete with it: no watchdog, no
// operator / project autopilot, no research directors, no crash/favourite resume, no notices typed into
// terminals, no calendar writes, no codex auto-switch, no Delta UI port, and a read-only GPU queue.
// Each switch can be forced with an env var: 1 = on, 0 = off (e.g. CCD_GPU_GRANT=1 for a second real queue).
'use strict';
const PORT = Number(process.env.CCD_PORT || 7777);
const MAIN = PORT === 7777;
const flag = (name, def) => (process.env[name] === '1' ? true : process.env[name] === '0' ? false : def);

module.exports = {
  port: PORT,
  main: MAIN,
  watchdog: flag('CCD_WATCHDOG', MAIN), // research watchdog, calendar sync, tray monitor, agy quota refresh
  operator: flag('CCD_OPERATOR', MAIN), // operator session start + periodic check
  autopilot: flag('CCD_AUTOPILOT', MAIN), // project autopilot completion watcher
  recover: flag('CCD_RECOVER', MAIN), // fresh pty host: resume saved terminals, crash-cut sessions, favourites
  notices: flag('CCD_NOTICE_DELIVER', MAIN), // type notices into running terminals
  calendarWrite: flag('CCD_CALENDAR_WRITE', MAIN), // push events to Google / write calendar.json
  gpuGrant: flag('CCD_GPU_GRANT', MAIN), // GPU queue may grant / adopt / launch
  codexAutoSwitch: flag('CCD_CODEX_AUTOSWITCH', MAIN), // move a codex terminal at its usage limit to another login
  deltaUi: flag('CCD_DELTA_UI', MAIN), // logged-in Delta Hub relay on its own port (7790)
  usageRestart: flag('CCD_USAGE_RESTART', MAIN), // relaunch the AI usage server when it is not listening
  startServices: flag('CCD_START_SERVICES', MAIN), // start a configured app / drive server that is down
  telegram: flag('CCD_TELEGRAM', MAIN), // telegram-bridge.js polling (a second poller steals the live bot's updates)
};
