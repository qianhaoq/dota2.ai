/**
 * `dota-coach-ui/2`: one player's review as an ordered list of whitelisted
 * cards (A2UI-inspired, not the official A2UI wire protocol). The engine
 * decides structure and content; every client (web, CLI, agent) renders the
 * same cards and may only offer the actions listed on each card.
 *
 * Pure and deterministic like the rest of lib/coach: a coach report in, cards
 * out. Bundled in the browser too, so it imports nothing server-side.
 *
 * Card = {
 *   id: string,                      stable within a report (React key, deep link)
 *   component: one of COMPONENTS,    how to render it
 *   title: { en, zh },
 *   authority: one of AUTHORITIES,   how the content is backed
 *   tone: 'good' | 'fix' | 'neutral',
 *   data: object,                    component-specific, copied from the report
 *   actions: Action[],               only ACTIONS; unknown ones are dropped
 *   evidence: Evidence[],            the finding's evidence rows, when any
 * }
 * Action = { action, label: { en, zh }, ...args } (see ACTIONS for args)
 */

export const CATALOG_V2 = 'dota-coach-ui/2';

/** Components a renderer must know. Anything else is rejected by validateSurface. */
export const COMPONENTS = Object.freeze([
  'MatchHeader', // lineup, score, duration, who you played
  'Headline', // the one thing to take away
  'GoldGraph', // radiant gold lead with deaths and fights marked
  'Finding', // one finding: claim, evidence, what to do next game
  'Matchups', // your hero against each enemy: pro and your-rank numbers
  'Lane', // laning chapter
  'Deaths', // deaths chapter
  'Items', // items chapter
  'Fights', // fights chapter
  'Story', // how the game swung
  'Plan', // next-game practice plan
  'DataGaps', // what this data cannot show, with the parse action
]);

/** Where a card's content comes from. */
export const AUTHORITIES = Object.freeze([
  'fact', // read straight from match data
  'inference', // derived by engine rules from match data
  'statistic', // population numbers (pro / public games), association not cause
]);

/**
 * Actions and their arguments:
 * - inspect   { target: 'laning'|'deaths'|'items'|'fights'|'story', row?: number }  open a card's detail
 * - ask       { question: { en, zh } }       prefill the coach chat
 * - save_goal { goal: object }               store a finding's next-game check
 * - parse     {}                             request a replay parse
 * - compare   { hero: number, vs: number }   open the hero matchup brief
 * - open_cases { theme: string }             pro games on the same problem
 */
export const ACTIONS = Object.freeze(['inspect', 'ask', 'save_goal', 'parse', 'compare', 'open_cases']);

const INSPECT_TARGETS = ['laning', 'deaths', 'items', 'fights', 'story'];
const TONES = ['good', 'fix', 'neutral'];
const t = (en, zh) => ({ en, zh });
const isBi = (x) => Boolean(x) && typeof x.en === 'string' && typeof x.zh === 'string';

/** Finding area -> the chapter that shows its detail. */
const AREA_CHAPTER = { laning: 'laning', deaths: 'deaths', items: 'items', fights: 'fights', objectives: 'story', team: 'fights' };

function validAction(a) {
  if (!a || !ACTIONS.includes(a.action) || !isBi(a.label)) return false;
  switch (a.action) {
    case 'inspect': return INSPECT_TARGETS.includes(a.target) && (a.row == null || Number.isInteger(a.row));
    case 'ask': return isBi(a.question);
    case 'save_goal': return Boolean(a.goal) && typeof a.goal === 'object' && typeof a.goal.kind === 'string';
    case 'parse': return true;
    case 'compare': return Number.isInteger(a.hero) && Number.isInteger(a.vs);
    case 'open_cases': return typeof a.theme === 'string' && a.theme.length > 0;
    default: return false;
  }
}

/** A card the renderer may show, with only its valid actions; null when the card itself is invalid. */
export function validCard(c) {
  if (!c || typeof c.id !== 'string' || !c.id || !COMPONENTS.includes(c.component)) return null;
  if (!isBi(c.title) || !AUTHORITIES.includes(c.authority) || !TONES.includes(c.tone)) return null;
  if (!c.data || typeof c.data !== 'object' || Array.isArray(c.data)) return null;
  return {
    ...c,
    actions: (Array.isArray(c.actions) ? c.actions : []).filter(validAction),
    evidence: Array.isArray(c.evidence) ? c.evidence : [],
  };
}

/**
 * Validates a surface from any source (engine, cache, network): wrong catalog
 * → null; invalid cards and duplicate ids dropped, order kept.
 */
export function validateSurface(s) {
  if (!s || s.catalog !== CATALOG_V2 || !Array.isArray(s.cards)) return null;
  const seen = new Set();
  const cards = [];
  for (const raw of s.cards) {
    const c = validCard(raw);
    if (!c || seen.has(c.id)) continue;
    seen.add(c.id);
    cards.push(c);
  }
  return { ...s, cards };
}

const ASK = {
  laning: t('Why did my lane go this way, and what do I change next game?', '我的对线为什么会这样？下一局改什么？'),
  deaths: t('Which of my deaths cost the most, and how do I avoid them?', '哪几次死亡代价最大？怎么避免？'),
  items: t('Was my build right for this game?', '我这局的出装对吗？'),
  fights: t('Why did we lose the fights we lost?', '我们输掉的团战为什么会输？'),
  story: t('Where did this game turn?', '这局比赛的转折点在哪？'),
};

const CASE_THEME = { deaths: 'deaths', laning: 'laning', items: 'items', fights: 'fights' };

/**
 * One player's review as cards, in reading order.
 * @param {object} report  buildCoachReport output
 * @param {number} slot    0-9
 * @returns {{ catalog: string, engine: string, match_id: number, slot: number, cards: object[] } | null}
 */
export function buildSurface(report, slot) {
  const rv = report?.reviews?.[slot];
  const me = report?.players?.[slot];
  if (!rv || !me) return null;
  const ch = rv.chapters ?? null;
  const cards = [];
  const push = (c) => cards.push({ tone: 'neutral', actions: [], evidence: [], ...c });

  push({
    id: 'header', component: 'MatchHeader', authority: 'fact',
    title: t(`${me.hero.en} — ${rv.won ? 'win' : 'loss'}`, `${me.hero.zh}——${rv.won ? '胜利' : '失败'}`),
    tone: rv.won ? 'good' : 'fix',
    data: { match: report.match, slot, role: rv.role, won: rv.won, players: report.players, bracket: rv.bracket ?? null },
  });

  const fixes = rv.findings.filter((f) => f.tone === 'fix');
  push({
    id: 'headline', component: 'Headline', authority: 'inference', title: t('Takeaway', '要点'),
    tone: fixes.length ? 'fix' : 'good',
    data: { text: rv.headline, top: fixes[0]?.id ?? null },
    actions: fixes[0] ? [{ action: 'ask', label: t('Ask about this', '追问这一点'), question: t(`Explain "${fixes[0].title.en}" with this game's numbers.`, `结合这局的数据解释「${fixes[0].title.zh}」。`) }] : [],
  });

  if (report.timeline?.radiant_gold_adv?.length) {
    push({
      id: 'gold', component: 'GoldGraph', authority: 'fact', title: t('Gold lead', '经济差'),
      data: {
        radiant_gold_adv: report.timeline.radiant_gold_adv, radiant: me.radiant,
        deaths: (rv.deaths ?? []).map((d) => d.time),
        fights: (ch?.fights?.rows ?? []).map((f) => ({ start: f.start, end: f.end, result: f.result })),
      },
      actions: ch?.story ? [{ action: 'inspect', label: t('How the game swung', '比赛走势'), target: 'story' }] : [],
    });
  }

  for (const f of rv.findings) {
    const chapter = AREA_CHAPTER[f.area];
    const actions = [];
    if (chapter && ch?.[chapter]) actions.push({ action: 'inspect', label: t('See the detail', '看细节'), target: chapter });
    if (f.goal) actions.push({ action: 'save_goal', label: t('Make it my next-game goal', '设为下一局目标'), goal: f.goal });
    actions.push({ action: 'ask', label: t('Ask the coach', '问教练'), question: t(`About "${f.title.en}": what exactly should I do differently?`, `关于「${f.title.zh}」：我具体该怎么改？`) });
    if (CASE_THEME[f.area] && report.match.parsed) actions.push({ action: 'open_cases', label: t('Pro games on this', '同问题的职业对局'), theme: CASE_THEME[f.area] });
    push({
      id: `finding:${f.id}`, component: 'Finding',
      authority: f.id.startsWith('draft.') ? 'statistic' : 'inference',
      title: f.title, tone: f.tone, data: { finding: f }, evidence: f.evidence ?? [], actions,
    });
  }

  if ((rv.matchups ?? []).some((m) => m.n != null || m.rank)) {
    push({
      id: 'matchups', component: 'Matchups', authority: 'statistic', title: t('Your hero vs theirs', '你的英雄对上他们'),
      data: { hero: me.hero.id, list: rv.matchups, bracket: rv.bracket ?? null, since: report.baselines?.since ?? null, rank_source: report.baselines?.rank ?? null },
      actions: rv.matchups.map((m) => ({ action: 'compare', label: t('Compare', '对比'), hero: me.hero.id, vs: m.hero })),
    });
  }

  const chapterCard = (key, component, title) => {
    if (!ch?.[key]) return;
    push({
      id: `chapter:${key}`, component, authority: 'inference', title, data: { chapter: ch[key] },
      actions: [{ action: 'ask', label: t('Ask the coach', '问教练'), question: ASK[key] }],
    });
  };
  chapterCard('story', 'Story', t('How the game swung', '比赛走势'));
  chapterCard('laning', 'Lane', t('Laning', '对线'));
  chapterCard('deaths', 'Deaths', t('Deaths', '死亡'));
  chapterCard('items', 'Items', t('Items', '出装'));
  chapterCard('fights', 'Fights', t('Fights', '团战'));
  if (ch?.plan?.length) {
    push({ id: 'plan', component: 'Plan', authority: 'inference', title: t('Next-game plan', '下一局练习'), data: { plan: ch.plan } });
  }

  if (report.data_gaps?.length) {
    push({
      id: 'gaps', component: 'DataGaps', authority: 'fact', title: t('What this data cannot show', '这份数据看不到的'),
      data: { gaps: report.data_gaps, parsed: Boolean(report.match.parsed) },
      actions: report.match.parsed ? [] : [{ action: 'parse', label: t('Parse this match', '解析这场比赛') }],
    });
  }

  return validateSurface({ catalog: CATALOG_V2, engine: report.engine, match_id: report.match.id, slot, cards });
}
