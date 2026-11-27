/**
 * How to use dota2.ai outside the web page — one source for the home page's
 * "ways to use it" block and the review page's snippet drawer, so commands and
 * tool names never drift apart. Every command here works as written:
 * the remote MCP is live at /mcp with these 9 tools (tested in
 * packages/mcp/test/remoteCoach.test.js and src/utils/agentReplayTool.test.ts); the CLI is not on npm, so it runs
 * from a checkout.
 */
import type { Bi } from './types';

export const MCP_URL = 'https://dota2.ai/mcp';

/** The tools `tools/list` returns on the hosted /mcp, in that order. */
export const MCP_TOOLS = [
  'review_match', 'get_evidence', 'replay_review', 'recent_matches', 'coach_report',
  'coach_cases', 'coach_ask', 'goal_check', 'hero_matchup',
] as const;

export type AccessMode = 'web' | 'dsh' | 'mcp' | 'cli' | 'http';

/** Official DeepSeek Harness desktop app download page. */
export const DSH_DOWNLOAD_URL = 'https://www.deepseek.com/harness/';
/** Public npm package name for the DSH plugin (published with provenance + npmmirror sync by dsh-release.yml). */
export const DSH_PACKAGE_NAME = '@qianhaoq/dsh-dota2ai';
/** The DSH plugin release the home page points to (packages/dsh, released from a dsh-v* tag). */
export const DSH_PLUGIN_VERSION = '0.2.3';
export const DSH_RELEASE_URL = `https://github.com/qianhaoq/dota2.ai/releases/tag/dsh-v${DSH_PLUGIN_VERSION}`;
export const DSH_INSTALL = `dsh plugin --profile web add ${DSH_PACKAGE_NAME}`;
/** Concrete DSH release verified by dsh-release.yml (must satisfy packages/dsh/package.json engines.dsh). */
export const DSH_HOST_VERSION = '0.2.2-rc.5';
export const DSH_TGZ_URL = `https://github.com/qianhaoq/dota2.ai/releases/download/dsh-v${DSH_PLUGIN_VERSION}/qianhaoq-dsh-dota2ai-${DSH_PLUGIN_VERSION}.tgz`;
/** From nothing to the dota2.ai page in DSH via CLI: the host and pnpm (DSH installs plugins with it), the plugin, the web UI. */
export const DSH_SETUP = [
  `npm install -g pnpm @deepseek-ai/dsh@${DSH_HOST_VERSION}`,
  DSH_INSTALL,
  'dsh web',
];

/** One-sentence install command to paste directly into the DeepSeek Harness desktop client chat. */
export function dshDesktopPrompt(lang: 'en' | 'zh' | 'ru'): string {
  if (lang === 'zh') {
    return `帮我安装 dota2.ai 的 Dota 2 复盘插件 ${DSH_PACKAGE_NAME} 到当前桌面端 profile，装好后告诉我怎么在左侧栏打开 dota2.ai。`;
  }
  if (lang === 'ru') {
    return `Установи плагин dota2.ai для разбора реплеев Dota 2 ${DSH_PACKAGE_NAME} в текущий профиль десктопного приложения, затем подскажи, как открыть dota2.ai в левой боковой панели.`;
  }
  return `Install the dota2.ai Dota 2 replay coach plugin ${DSH_PACKAGE_NAME} into my active desktop profile, then tell me how to open dota2.ai in the left sidebar.`;
}

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
      mode: 'dsh',
      label: { en: 'DeepSeek Harness', zh: 'DeepSeek Harness（推荐）', ru: 'DeepSeek Harness' },
      lines: DSH_SETUP,
      note: {
        en: 'Recommended. Download the DeepSeek Harness desktop app at deepseek.com/harness/ and paste the one-sentence install message, or use the CLI commands above (Node 24.9+). Runs the full dota2.ai page and coach tools on your own DeepSeek key — no queue, no daily limit, reviews kept on your machine.',
        zh: '推荐。前往 deepseek.com/harness/ 下载 DeepSeek Harness 桌面客户端，发一句话即可自动装好插件；也可用上方命令行安装（需 Node 24.9+）。用你自己的 DeepSeek Key 跑完整复盘页与教练工具：不排队、不限次，复盘保存在本地电脑。',
        ru: 'Рекомендуем. Скачайте десктопное приложение DeepSeek Harness на deepseek.com/harness/ и отправьте одну фразу для установки, либо используйте команды CLI выше (Node 24.9+). Полная страница dota2.ai и инструменты тренера работают на вашем ключе DeepSeek — без очереди и лимита, разборы хранятся локально.',
      },
      links: [
        { href: DSH_DOWNLOAD_URL, label: 'deepseek.com/harness' },
        { href: DSH_RELEASE_URL, label: `dsh-v${DSH_PLUGIN_VERSION}` },
      ],
    },
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
        en: `Hosted, no install, no key. replay_review is the full review, written on dota2.ai's model within a daily limit; the other tools answer at once from match data.`,
        zh: `线上直连，不用安装，不要 Key。replay_review 是完整的录像复盘，用 dota2.ai 自带的模型写、每天有名额上限；其余工具按比赛数据即时回答。`,
        ru: `Работает онлайн, без установки и ключа. replay_review — полный разбор по реплею на модели dota2.ai, с дневным лимитом; остальные инструменты отвечают сразу по данным матча.`,
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
        en: 'Not published on npm yet: run it from a checkout. Every command takes --json and --lang en|zh.',
        zh: '还没有发布到 npm：clone 仓库后运行。所有命令都支持 --json 和 --lang en|zh。',
        ru: 'Пока не опубликован в npm: запускайте из клона репозитория. Команды поддерживают --json и --lang en|zh.',
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
    return `帮我复盘一场 Dota 2 比赛：比赛 ID <比赛ID>，我玩的是 <英雄>。能用 MCP 就连 ${MCP_URL}（replay_review 看录像出完整复盘，返回 parsing/reviewing 时隔一会再调；即时版用 coach_report）；否则按 https://dota2.ai/llms.txt 调用接口。只引用接口返回的数据，样本不足就直说。`;
  }
  if (lang === 'ru') {
    return `Разбери мой матч в Dota 2: ID матча <ID>, я играл на <герое>. Если доступен MCP, подключись к ${MCP_URL} (replay_review для полного разбора по реплею — вызывай повторно при parsing/reviewing; coach_report для мгновенного отчёта); иначе используй API из https://dota2.ai/llms.txt. Опирайся только на данные API и прямо указывай, если выборка мала.`;
  }
  return `Review my Dota 2 match: match ID <match id>, I played <hero>. If you can use MCP, connect to ${MCP_URL} (replay_review for the full review from the replay — call it again while it says parsing or reviewing; coach_report for the instant one); otherwise call the API described at https://dota2.ai/llms.txt. Quote only what it returns, and say when a sample is too small.`;
}
