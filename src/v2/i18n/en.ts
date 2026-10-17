/**
 * EN dictionary (default) for the v2 conversational shell. Copy follows the
 * approved prototype (redesign/final/index.html I18N.en). `zh.ts` must have
 * exactly these keys — enforced by the `Dict` type and the parity test.
 */
export const en = {
  samplePill: 'Sample data',
  sampleTitle: 'Prototype. Uses a real OpenDota match as sample data',
  tab_web: 'Web',
  tab_cli: 'CLI',
  tab_discord: 'Discord',
  tab_dev: 'For AI & Devs',
  tabsProposed: 'Proposed — not live yet',
  newReview: 'New review',
  langBtn: '中文',
  langAria: 'Switch language to Chinese',
  inputPh: 'Paste match ID or link',
  inputAria: 'Match ID, link, or question',
  sendAria: 'Send',
  emptyH: 'Why did you win or lose?',
  emptyP: 'Paste a Dota 2 match ID or link. In about 10 seconds you get three answers, each linked to the data behind it.',
  trust: 'Built on OpenDota data. If the data can’t answer something, I’ll say so. No guessing.',
  stSample: 'Try a sample · 9035042364',
  stSteam: 'Use my Steam ID',
  stWhat: 'What can you tell me?',
  steamRef: 'Steam sign-in isn’t part of this preview yet. Try the sample match instead.',
  whatAns: 'Paste a match and I’ll find the turning point, the one thing to fix and one thing to try next game. Every claim comes with its time and its OpenDota source. When the data can’t answer, I say so.',
  notMatch: 'That doesn’t look like a match ID or link. Try 9035042364.',
  matchLabel: 'Match',
  heroLabel: 'Hero',
  noHero: 'not picked yet',
  reviewPending: 'The full review will appear here in a later PR.',
  invalidMatch: 'That doesn’t look like a match ID. Match IDs are numbers — e.g. 9035042364.',
};

export type Dict = Record<keyof typeof en, string>;
export type DictKey = keyof typeof en;
