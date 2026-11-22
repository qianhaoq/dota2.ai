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

export interface AccessSnippet {
  mode: AccessMode;
  label: Bi;
  /** Shell lines, copied together. Empty for the web mode. */
  lines: string[];
  note: Bi;
  links?: { href: string; label: string }[];
}

const CLI = 'node packages/cli/bin/dota2ai.js';

export function accessSnippets(matchId: string, hero = 'tidehunter'): AccessSnippet[] {
  return [
    {
      mode: 'web',
      label: { en: 'Web', zh: '网页' },
      lines: [],
      note: { en: 'Paste a match ID, a match link or your friend code in the box above.', zh: '在上面的输入框里粘贴比赛 ID、对局链接或好友码。' },
    },
    {
      mode: 'mcp',
      label: { en: 'Agent (MCP)', zh: 'Agent（MCP）' },
      lines: [`claude mcp add --transport http dota2ai ${MCP_URL}`],
      note: {
        en: `Hosted, no install. Any client that supports remote MCP can use ${MCP_URL}. ${MCP_TOOLS.length} tools: ${MCP_TOOLS.join(', ')}.`,
        zh: `线上直连，无需安装；支持远程 MCP 的客户端填 ${MCP_URL} 即可。共 ${MCP_TOOLS.length} 个工具：${MCP_TOOLS.join('、')}。`,
      },
    },
    {
      mode: 'cli',
      label: { en: 'CLI', zh: 'CLI' },
      lines: [
        'git clone https://github.com/qianhaoq/dota2.ai && cd dota2.ai && npm ci',
        `${CLI} coach ${matchId} --hero ${hero} --section why`,
        `${CLI} matchup tidehunter ursa --rank legend`,
      ],
      note: { en: 'Not published on npm yet: run it from a checkout. Every command takes --json and --lang en|zh.', zh: '还没有发布到 npm：clone 仓库后运行。所有命令都支持 --json 和 --lang en|zh。' },
    },
    {
      mode: 'http',
      label: { en: 'HTTP', zh: 'HTTP' },
      lines: [
        `curl https://dota2.ai/api/coach/${matchId}`,
        `curl 'https://dota2.ai/api/v1/review/${matchId}?hero=${hero}'`,
      ],
      note: { en: 'JSON, no key. Rate-limited per caller.', zh: '返回 JSON，无需密钥；按调用方限流。' },
      links: [{ href: '/openapi.json', label: 'openapi.json' }, { href: '/llms.txt', label: 'llms.txt' }],
    },
  ];
}

/** A prompt the user can paste into any agent. */
export function agentPrompt(lang: 'en' | 'zh'): string {
  return lang === 'zh'
    ? `帮我复盘一场 Dota 2 比赛：比赛 ID <比赛ID>，我玩的是 <英雄>。能用 MCP 就连 ${MCP_URL}（coach_report / coach_ask 等工具）；否则按 https://dota2.ai/llms.txt 调用接口。只引用接口返回的数据，样本不足就直说。`
    : `Review my Dota 2 match: match ID <match id>, I played <hero>. If you can use MCP, connect to ${MCP_URL} (coach_report, coach_ask and more); otherwise call the API described at https://dota2.ai/llms.txt. Quote only what it returns, and say when a sample is too small.`;
}
