// Which side effects this hub process may have. The main hub (port 7777) does everything; any other port
// is a side instance (a test copy next to the live hub) that must not compete with it: no watchdog, no
// operator / project autopilot, no schedule runner, no crash/favourite resume, no notices typed into
// terminals, no calendar writes and a read-only GPU queue.
// Each switch can be forced with an env var: 1 = on, 0 = off (e.g. CCD_GPU_GRANT=1 for a second real queue).
// Plugins get this object as api.instance and must keep their own background work to the main hub.
'use strict';
const DEFAULT_PORT = 7777;
const PORT = Number(process.env.CCD_PORT || DEFAULT_PORT);
const MAIN = PORT === DEFAULT_PORT;
const flag = (name, def) => (process.env[name] === '1' ? true : process.env[name] === '0' ? false : def);

module.exports = {
  port: PORT,
  main: MAIN,
  watchdog: flag('CCD_WATCHDOG', MAIN), // research watchdog, calendar sync, tray monitor, quota refresh
  operator: flag('CCD_OPERATOR', MAIN), // operator session start + periodic check
  autopilot: flag('CCD_AUTOPILOT', MAIN), // project autopilot completion watcher
  schedules: flag('CCD_SCHEDULES', MAIN), // scheduled CLI runs (ccd schedule)
  recover: flag('CCD_RECOVER', MAIN), // fresh pty host: resume saved terminals, crash-cut sessions, favourites
  notices: flag('CCD_NOTICE_DELIVER', MAIN), // type notices into running terminals
  calendarWrite: flag('CCD_CALENDAR_WRITE', MAIN), // push events to Google / write calendar.json and todo.md
  gpuGrant: flag('CCD_GPU_GRANT', MAIN), // GPU queue may grant / adopt / launch
};
