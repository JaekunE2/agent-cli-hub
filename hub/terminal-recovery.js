// Codex accepts a positional prompt on startup. Restore the session, never the prompt.
module.exports = function codexRecoveryArgs(args, sessionId) {
  const prefix = args[0]?.toLowerCase() === '/c' ? args.slice(0, 2) : [];
  const options = args.slice(prefix.length);
  if (options[0] === '--no-daemon') prefix.push(options.shift());
  if (options[0] === '-c' && /^shell_environment_policy\.set\.HUB_PROJECT_RUN_ID="[a-f0-9-]{36}"$/i.test(options[1])) prefix.push(...options.splice(0, 2));
  if (options[0] === '--dangerously-bypass-approvals-and-sandbox') prefix.push(options.shift());
  const validId = id => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id || '');
  const explicitId = options[0] === 'resume' && options[1];
  const id = validId(sessionId) ? sessionId : validId(explicitId) ? explicitId : null;
  if (id) return [...prefix, 'resume', id];
  return options[0] === 'resume' && options[1] === '--last' ? [...prefix, 'resume', '--last'] : prefix;
};
