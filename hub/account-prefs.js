'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULT_FILE = path.join(__dirname, 'account-prefs.json');
const VALID_AGENTS = new Set(['claude', 'codex', 'agy']);

function normalizeAccountKey(account, agent) {
  const ag = VALID_AGENTS.has(agent) ? agent : 'claude';
  const raw = String(account || '').trim();
  if (!raw || raw === '__cli__:claude') return ag === 'claude' ? 'default' : `__cli__:${ag}`;
  return raw;
}

function createAccountPrefsStore({ file = DEFAULT_FILE, cleanModelEffort } = {}) {
  const clean = typeof cleanModelEffort === 'function'
    ? cleanModelEffort
    : (model, effort) => ({ model: String(model || '').trim(), effort: String(effort || '').trim() });

  const load = () => {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      return {
        byAccount: (j?.byAccount && typeof j.byAccount === 'object') ? j.byAccount : {},
        byCli: (j?.byCli && typeof j.byCli === 'object') ? j.byCli : {},
      };
    } catch {
      return { byAccount: {}, byCli: {} };
    }
  };

  let state = load();

  const persist = () => {
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  };

  const get = () => ({
    byAccount: { ...state.byAccount },
    byCli: { ...state.byCli },
  });

  const getForAccount = (account, agent) => {
    const ag = VALID_AGENTS.has(agent) ? agent : 'claude';
    const key = normalizeAccountKey(account, ag);
    const accEntry = state.byAccount[key] || (account ? state.byAccount[String(account).trim()] : null);
    if (accEntry && typeof accEntry === 'object') {
      return { model: String(accEntry.model || ''), effort: String(accEntry.effort || '') };
    }
    const cliEntry = state.byCli[ag];
    if (cliEntry && typeof cliEntry === 'object') {
      return { model: String(cliEntry.model || ''), effort: String(cliEntry.effort || '') };
    }
    return { model: '', effort: '' };
  };

  const save = ({ account = '', agent = '', model = '', effort = '', updateCli = true } = {}) => {
    const ag = VALID_AGENTS.has(agent) ? agent : 'claude';
    const key = normalizeAccountKey(account, ag);
    const me = clean(model, effort);
    const now = Date.now();
    state.byAccount[key] = { agent: ag, model: me.model, effort: me.effort, updatedAt: now };
    if (updateCli) {
      state.byCli[ag] = { account: key, model: me.model, effort: me.effort, updatedAt: now };
    }
    persist();
    return get();
  };

  return { file, reload: () => { state = load(); return get(); }, get, getForAccount, save };
}

function buildRecoveryLaunchArgs({ cli, rawArgs = [], sessionId = '', model = '', effort = '', codexRecoveryArgs, cliModelEffortArgs }) {
  const stripMeFlags = (arr) => {
    const out = [];
    for (let i = 0; i < arr.length; i++) {
      const a = String(arr[i] || '');
      if (a === '--model' || a === '-m' || a === '--effort') { i++; continue; }
      if (a === '-c' && /model_reasoning_effort/.test(String(arr[i + 1] || ''))) { i++; continue; }
      if (/^--(model|effort)=/.test(a)) continue;
      out.push(arr[i]);
    }
    return out;
  };
  const me = typeof cliModelEffortArgs === 'function' ? cliModelEffortArgs(cli, model, effort) : [];
  if (cli === 'claude') {
    const skip = rawArgs.includes('--dangerously-skip-permissions');
    return ['--resume', sessionId, ...(skip ? ['--dangerously-skip-permissions'] : []), ...me];
  }
  if (cli === 'codex') {
    const base = typeof codexRecoveryArgs === 'function' ? stripMeFlags(codexRecoveryArgs(rawArgs, sessionId)) : stripMeFlags(rawArgs);
    const resumeIdx = base.indexOf('resume');
    return resumeIdx >= 0 ? [...base.slice(0, resumeIdx), ...me, ...base.slice(resumeIdx)] : [...base, ...me];
  }
  if (cli === 'agy') {
    const clean = stripMeFlags(rawArgs);
    if (sessionId && !clean.includes('--conversation') && !clean.includes('--continue')) clean.push('--conversation', sessionId);
    return [...clean, ...me];
  }
  return [...rawArgs];
}

module.exports = { createAccountPrefsStore, normalizeAccountKey, buildRecoveryLaunchArgs };
