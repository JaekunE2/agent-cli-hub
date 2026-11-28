'use strict';
// Telegram plugin, hub side: the bridge itself (bridge.js) is its own process, started at logon; this only reports
// whether it is configured / running, for the operator and the settings pages. The bridge talks to the hub with the
// hub token, sends notify/*.json reports (crash recovery, codex switches …) and handles approvals/*.json requests.
const fs = require('fs');
const path = require('path');
module.exports = function telegramPlugin(api) {
  const cfg = api.config.telegram || {};
  const secret = process.env.CCD_TELEGRAM_SECRET || cfg.secretFile || path.join(api.secretsDir, 'ccd-telegram.json');
  const pidFile = path.join(api.baseDir, 'telegram-bridge.pid');
  const running = () => { try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 0); return true; } catch { return false; } };
  return {
    enabled: fs.existsSync(secret),
    overview: () => ({ telegram: { running: running() } }),
  };
};
