/**
 * How to use dota2.ai outside the web page — one source for the home page's
 * "four ways" block and the review page's snippet drawer, so commands and
 * tool names never drift apart. Every command here works as written:
 * the remote MCP is live at /mcp with these 8 tools (tested in
 * packages/mcp/test/remoteCoach.test.js); the CLI is not on npm, so it runs
 * from a checkout.
 */
import type { Bi } from './types';

export const MCP_URL = 'https://dota2.ai/mcp';

/** The tools `tools/list` returns on the hosted /mcp, in that order. */
export const MCP_TOOLS = [
  'review_match', 'get_evidence', 'recent_matches', 'coach_report',
  'coach_cases', 'coach_ask', 'goal_check', 'hero_matchup',
] as const;

export type AccessMode = 'web' | 'mcp' | 'cli' | 'http';

/**
 * One line that connects each agent tool to the hosted MCP server. A command
 * is run in a terminal; `where` says where a line that is not a command goes.
 * Claude Code comes first: it is the line the other surfaces show by default.
 */
export interface AgentClient {
  id: string;
  label: Bi;
  line: string;
  where?: Bi;
  /** A link that does the same in one click (Cursor's install page). */
  install?: { href: string; label: Bi };
}

const CURSOR_CONFIG = 'eyJ1cmwiOiJodHRwczovL2RvdGEyLmFpL21jcCJ9'; // base64 of {"url":"https://dota2.ai/mcp"}
export const CURSOR_INSTALL = `https://cursor.com/en/install-mcp?name=dota2ai&config=${CURSOR_CONFIG}`;

export const AGENT_CLIENTS: AgentClient[] = [
  { id: 'claude', label: { en: 'Claude Code', zh: 'Claude Code', ru: 'Claude Code' }, line: `claude mcp add --transport http dota2ai ${MCP_URL}` },
  { id: 'codex', label: { en: 'Codex', zh: 'Codex', ru: 'Codex' }, line: `codex mcp add dota2ai --url ${MCP_URL}` },
  { id: 'gemini', label: { en: 'Gemini CLI', zh: 'Gemini CLI', ru: 'Gemini CLI' }, line: `gemini mcp add --transport http dota2ai ${MCP_URL}` },
  { id: 'vscode', label: { en: 'VS Code', zh: 'VS Code', ru: 'VS Code' }, line: `code --add-mcp '{"name":"dota2ai","type":"http","url":"${MCP_URL}"}'` },
  {
    id: 'cursor', label: { en: 'Cursor', zh: 'Cursor', ru: 'Cursor' }, line: `{ "mcpServers": { "dota2ai": { "url": "${MCP_URL}" } } }`,
    where: { en: 'Goes in ~/.cursor/mcp.json.', zh: '写进 ~/.cursor/mcp.json。', ru: 'Добавьте в ~/.cursor/mcp.json.' },
    install: { href: CURSOR_INSTALL, label: { en: 'Or add it to Cursor in one click', zh: '或者一键添加到 Cursor', ru: 'Или добавить в Cursor в один клик' } },
  },
  {
    id: 'other', label: { en: 'Any other', zh: '其他', ru: 'Другой' }, line: MCP_URL,
    where: { en: 'Any client that takes a remote MCP server (Streamable HTTP): give it this address.', zh: '任何支持远程 MCP（Streamable HTTP）的客户端：把这个地址填进去。', ru: 'Любой клиент с поддержкой удалённого MCP (Streamable HTTP): укажите этот адрес.' },
  },
];

/** What to say once the agent is connected. */
export function agentAsk(lang: 'en' | 'zh' | 'ru'): string {
  if (lang === 'zh') return '复盘我的 Dota 2 比赛 9100904020，我玩的是兽王。';
  if (lang === 'ru') return 'Разбери мой матч Dota 2 9100904020 — я играл на Beastmaster.';
  return 'Review my Dota 2 match 9100904020 — I played Beastmaster.';
}

export interface AccessSnippet {
  mode: AccessMode;
  label: Bi;
  /** Shell lines, copied together. Empty for the web mode. */
  lines: string[];
  note: Bi;
  links?: { href: string; label: string }[];
  /** The same connection for each agent tool; the first one's line is `lines`. */
  clients?: AgentClient[];
}

const CLI = 'node packages/cli/bin/dota2ai.js';

export function accessSnippets(matchId: string, hero = 'tidehunter'): AccessSnippet[] {
  return [
    {
      mode: 'web',
      label: { en: 'Web', zh: '网页', ru: 'Веб' },
      lines: [],
      note: { en: 'Paste a match ID, a match link or your friend code in the box above.', zh: '在上面的输入框里粘贴比赛 ID、对局链接或好友码。', ru: 'Вставьте ID матча, ссылку на матч или код друга в поле выше.' },
    },
    {
      mode: 'mcp',
      label: { en: 'Agent (MCP)', zh: 'Agent（MCP）', ru: 'Агент (MCP)' },
      lines: [AGENT_CLIENTS[0].line],
      clients: AGENT_CLIENTS,
      note: {
        en: `Hosted, no install. Any client that supports remote MCP can use ${MCP_URL}. ${MCP_TOOLS.length} tools: ${MCP_TOOLS.join(', ')}.`,
        zh: `线上直连，无需安装；支持远程 MCP 的客户端填 ${MCP_URL} 即可。共 ${MCP_TOOLS.length} 个工具：${MCP_TOOLS.join('、')}。`,
        ru: `Работает в облаке без установки. Любой клиент с удалённым MCP может использовать ${MCP_URL}. Доступно ${MCP_TOOLS.length} инструментов: ${MCP_TOOLS.join(', ')}.`,
      },
    },
    {
      mode: 'cli',
      label: { en: 'CLI', zh: 'CLI', ru: 'CLI' },
      lines: [
        'git clone https://github.com/qianhaoq/dota2.ai && cd dota2.ai && npm ci',
        `${CLI} coach ${matchId} --hero ${hero} --section why`,
        `${CLI} matchup tidehunter ursa --rank legend`,
      ],
      note: {
        en: 'Not published on npm yet: run it from a checkout. Every command takes --json and --lang en|zh|ru.',
        zh: '还没有发布到 npm：clone 仓库后运行。所有命令都支持 --json 和 --lang en|zh|ru。',
        ru: 'Пока не опубликован в npm: запускайте из клона репозитория. Команды поддерживают --json и --lang en|zh|ru.',
      },
    },
    {
      mode: 'http',
      label: { en: 'HTTP', zh: 'HTTP', ru: 'HTTP' },
      lines: [
        `curl https://dota2.ai/api/coach/${matchId}`,
        `curl 'https://dota2.ai/api/v1/review/${matchId}?hero=${hero}'`,
      ],
      note: { en: 'JSON, no key. Rate-limited per caller.', zh: '返回 JSON，无需密钥；按调用方限流。', ru: 'JSON без API-ключа. Действуют лимиты запросов.' },
      links: [{ href: '/openapi.json', label: 'openapi.json' }, { href: '/llms.txt', label: 'llms.txt' }],
    },
  ];
}

/** A prompt the user can paste into any agent. */
export function agentPrompt(lang: 'en' | 'zh' | 'ru'): string {
  if (lang === 'zh') {
    return `帮我复盘一场 Dota 2 比赛：比赛 ID <比赛ID>，我玩的是 <英雄>。能用 MCP 就连 ${MCP_URL}（coach_report / coach_ask 等工具）；否则按 https://dota2.ai/llms.txt 调用接口。只引用接口返回的数据，样本不足就直说。`;
  }
  if (lang === 'ru') {
    return `Разбери мой матч в Dota 2: ID матча <ID>, я играл на <герое>. Если доступен MCP, подключись к ${MCP_URL} (инструменты coach_report, coach_ask и др.); иначе используй API из https://dota2.ai/llms.txt. Опирайся только на данные API и прямо указывай, если выборка мала.`;
  }
  return `Review my Dota 2 match: match ID <match id>, I played <hero>. If you can use MCP, connect to ${MCP_URL} (coach_report, coach_ask and more); otherwise call the API described at https://dota2.ai/llms.txt. Quote only what it returns, and say when a sample is too small.`;
}
