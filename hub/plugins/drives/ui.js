// Drives plugin UI: sidebar entry + view (drive.js draws the drive page itself).
'use strict';
HubPlugins.register({
  id: 'drives',
  nav: [{ key: 'drive', icon: '📁', label: '드라이브', when: () => !!(state.drive || (state.drives || []).length) }],
  views: { drive: () => viewDrive() },
  open(param) {
    if (param === 'drive') { select({ kind: 'drive' }); return true; }
    if (param.startsWith('drive:')) { select({ kind: 'drive', id: param.slice(6) }); return true; }
    return false;
  },
});
