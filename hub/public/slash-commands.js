'use strict';

const hubSlashCommands = [
  ['schedule', '스케줄 만들기', /스케줄|hub-schedule/],
  ['calendar', '캘린더 일정 등록', /일정|캘린더|event|cal/],
  ['todo', '할 일 등록', /할일|task/],
  ['app', '앱 등록 · 가져오기 · 실행', /앱|apps/],
  ['branch', '현재 세션 분기', /분기|fork|fork-session|hub-branch/],
  ['switch', '현재 세션 계정 · CLI 전환', /전환|hub-switch/],
  ['new', '새 세션 열기', /새세션|hub-new/],
  ['resume', '이전 세션 찾기', /이어하기/],
  ['notice', '허브 공지 등록', /공지/],
  ['usage', 'AI 사용량 보기', /사용량/],
  ['gpu', 'GPU 대기열 보기'],
  ['mcp', 'Hub MCP 서버 관리'],
  ['skills', 'Hub 스킬 관리'],
  ['model', '현재 세션 실행 설정', /effort/],
  ['sidechat', '사이드 채팅 열기', /사이드채팅|btw/],
].map(([name, description, alternate]) => {
  // Aliases are input syntax and must survive UI translation.
  const aliases = [name, ...(alternate?.source.split('|') || [])];
  const preferred = typeof document !== 'undefined' && document.documentElement.lang === 'en' ? name : aliases[1] || name;
  return { command: '/' + preferred, name, description, aliases, hub: true };
});

const hubSlashAliases = new Map(hubSlashCommands.flatMap(entry =>
  entry.aliases.map(alias => [alias, entry])));

const nativeSlashCommands = {
  claude: 'compact clear context cost plan review memory permissions status help',
  codex: 'compact clear plan review diff status permissions goal',
  agy: 'plan goal compact browser grill-me teamwork learn boost clear help agents permissions context',
};
const terminalMenuCommands = new Set('memory permissions status help agents diff'.split(' '));

function slashInput(value) {
  const match = /^\s*\/([\p{L}\p{N}_.:-]+)(?:\s+([\s\S]*))?$/u.exec(value);
  return match && { key: match[1].toLowerCase(), args: (match[2] || '').trim() };
}

function hubSlashEntry(token) {
  return hubSlashAliases.get(token.toLowerCase().replace(/^(?:\/?prompts:|[/$])/, ''));
}

function slashCatalog(agent, discovered = []) {
  const names = (nativeSlashCommands[agent] || '').split(' ').filter(Boolean);
  const builtins = names.map(name => ({ command: '/' + name, tui: terminalMenuCommands.has(name) }));
  const unique = new Map();
  for (const entry of [...builtins, ...discovered]) {
    const { command } = entry;
    const key = command.toLowerCase();
    if (!hubSlashEntry(command) && !unique.has(key)) unique.set(key, entry);
  }
  return [...hubSlashCommands, ...unique.values()];
}

function nativeSlashEntry(value, catalog) {
  if (/[\r\n\t]/.test(value)) return null;
  const parsed = slashInput(value);
  return parsed && !hubSlashEntry(parsed.key) && catalog.find(item => !item.hub && item.command.toLowerCase() === '/' + parsed.key);
}
