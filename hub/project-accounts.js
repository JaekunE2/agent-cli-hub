module.exports = function projectAccounts({ claude, codex, agy, codexEnv }) {
  const providers = { claude, codex, agy };
  const accounts = agent => Object.hasOwn(providers, agent) ? providers[agent]() : [];
  return {
    list(agent) {
      return accounts(agent).map(({ id, label }) => ({ id, label }));
    },
    resolve(agent, id) {
      if (!id) return { env: {}, account: null };
      const entry = accounts(agent).find(a => a.id === id);
      if (!entry) throw new Error('선택한 CLI 계정을 찾을 수 없습니다. 계정을 다시 선택하세요.');
      let env;
      if (agent === 'codex') env = codexEnv(entry);
      else if (agent === 'claude') env = entry.credentialsPath ? { CLAUDE_CONFIG_DIR: require('path').dirname(entry.credentialsPath) } : { CLAUDE_CODE_OAUTH_TOKEN: entry.token() };
      else if (String(id).startsWith('agyswap:')) {
        return {
          env: {},
          account: { id, label: entry.label, kind: agent, email: entry.email || String(id).slice(8) },
          switchAgySwap: entry.email || String(id).slice(8),
        };
      } else {
        const key = entry.apiKey();
        if (!key) throw new Error('선택한 AGY 계정의 인증 정보를 읽을 수 없습니다.');
        env = { GEMINI_API_KEY: key, GOOGLE_API_KEY: key };
      }
      return { env, account: { id, label: entry.label, kind: agent } };
    },
  };
};
