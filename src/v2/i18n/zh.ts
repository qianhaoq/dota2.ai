import type { Dict } from './en';

/**
 * ZH dictionary — must have exactly the same keys as `en` (see Dict type and
 * the dictionary parity test). Copy follows the approved prototype
 * (redesign/final/index.html I18N.zh).
 */
export const zh: Dict = {
  samplePill: '示例数据',
  sampleTitle: '原型。使用一场真实的 OpenDota 比赛作为示例数据',
  tab_web: '网页',
  tab_cli: 'CLI',
  tab_discord: 'Discord',
  tab_dev: 'AI 与开发者',
  tabsProposed: '提议中——尚未上线',
  newReview: '新的复盘',
  langBtn: 'EN',
  langAria: '切换语言到英文',
  inputPh: '粘贴比赛 ID 或链接',
  inputAria: '比赛 ID、链接或问题',
  sendAria: '发送',
  emptyH: '你为什么赢了或输了？',
  emptyP: '粘贴 Dota 2 比赛 ID 或链接。约 10 秒内得到三个答案，每个都链向背后的数据。',
  trust: '基于 OpenDota 数据构建。数据答不了的，我会明说，绝不猜测。',
  stSample: '试试示例 · 9035042364',
  stSteam: '使用我的 Steam ID',
  stWhat: '你能告诉我什么？',
  steamRef: '此预览暂未包含 Steam 登录，请试试示例比赛。',
  whatAns: '粘贴一场比赛，我会找出转折点、最该改的一点和下一局可尝试的一件事。每个论断都附时间和 OpenDota 来源。数据答不了的，我会明说。',
  notMatch: '这不像比赛 ID 或链接。试试 9035042364。',
  matchLabel: '比赛',
  heroLabel: '英雄',
  noHero: '尚未选择',
  reviewPending: '完整复盘将在后续 PR 中出现在这里。',
  invalidMatch: '这不像比赛 ID。比赛 ID 是数字——例如 9035042364。',
};
