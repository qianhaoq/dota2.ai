/**
 * Case studies ("相似对局"): for each of a player's problems, one professional
 * game where the same (or a similar) hero met the same key enemy and made the
 * same mistake (negative case), and one where they avoided it and won
 * (positive case), compared metric by metric with the player's own game.
 *
 * Pure: candidates are full OpenDota match objects that the caller fetched.
 * Every candidate is run through the same engine as the player's own match,
 * so "the same problem" means the same deterministic criteria — not a model's
 * opinion. Results describe what went with what; they do not claim causation.
 */
import { createRequire } from 'node:module';
import { buildCoachReport, heroInfo } from './analyze.js';

const names = createRequire(import.meta.url)('./data/names.json');

const t = (en, zh) => ({ en, zh });
const clock = (sec) => {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const fmtK = (n) => (Math.abs(n) >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));
const signedK = (n) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${fmtK(Math.abs(n))}`;
const pct = (x) => `${Math.round(x * 100)}%`;
const heroName = (id) => names.heroes[id] ?? { en: `Hero ${id}`, zh: `英雄 ${id}` };

const DMG_LABEL = {
  physical: t('physical', '物理'), magic: t('magic', '魔法'), pure: t('pure', '纯粹'),
};

/* --------------------------------------------------------- similar heroes */

/**
 * Heroes that play like `heroId`: same primary attribute and attack type,
 * ranked by shared OpenDota roles. Used only when the same hero has too few
 * professional games against the key enemy.
 */
export function similarHeroes(heroId, limit = 3) {
  const me = names.heroes[heroId];
  if (!me?.roles) return [];
  const mine = new Set(me.roles);
  const scored = [];
  for (const [id, h] of Object.entries(names.heroes)) {
    if (Number(id) === heroId || !h.roles || h.attr !== me.attr || h.attack !== me.attack) continue;
    const shared = h.roles.filter((r) => mine.has(r)).length;
    const jaccard = shared / new Set([...mine, ...h.roles]).size;
    if (jaccard >= 0.5) scored.push({ id: Number(id), jaccard });
  }
  return scored.sort((a, b) => b.jaccard - a.jaccard || a.id - b.id).slice(0, limit).map((x) => x.id);
}

/* --------------------------------------------------------------- profile */

const BLINK = 'blink';

/**
 * The numbers a case is compared on, for one player in one match. Small and
 * independent of the viewer, so a pro game is profiled once and cached.
 */
export function profileOf(match, report, slot) {
  const p = report.players[slot];
  const rv = report.reviews[slot];
  const ch = rv.chapters ?? {};
  const raw = match.players[slot]; // report.players keeps the match's order
  const sign = p.radiant ? 1 : -1;
  const adv = Array.isArray(match.radiant_gold_adv) ? match.radiant_gold_adv : [];
  const leadAt = (min) => (adv.length > min ? adv[min] * sign : null);
  // Killer counts only when every death is in the log; otherwise unknown,
  // never "zero deaths to X".
  const ds = ch.deaths?.summary;
  const deathless = p.kda[1] === 0; // zero deaths: every count is a known zero
  const deathsKnown = deathless || (!!ds && ds.recorded === p.kda[1]);
  let deathsTo = null;
  if (deathsKnown) {
    deathsTo = {};
    for (const d of ch.deaths?.rows ?? []) if (d.killer != null) deathsTo[d.killer] = (deathsTo[d.killer] ?? 0) + 1;
  }
  const items = ch.items?.rows ?? [];
  const defence = ch.items?.defence ?? null; // full purchase log, null = unknown
  const blink = items.find((r) => r.item.key === BLINK);
  const lane = ch.laning ? ch.laning.rows.find((r) => r.slot === slot) : null;
  const fs = ch.fights?.summary;
  return {
    match_id: match.match_id,
    slot,
    hero: p.hero.id,
    pos: rv.role.pos ?? null,
    won: rv.won,
    radiant: p.radiant,
    kda: p.kda,
    deaths: p.kda[1],
    duration: match.duration,
    enemies: report.players.filter((x) => x.radiant !== p.radiant).map((x) => x.hero.id),
    deaths_to: deathsTo,
    caught: deathless ? 0 : deathsKnown ? (ds.by_context?.caught ?? null) : null,
    share_dead: deathless ? 0 : deathsKnown ? (ds.share_dead ?? null) : null,
    lane_outcome: ch.laning?.outcome ?? null,
    lane_diff: ch.laning?.diff ?? null,
    lane_deaths: ch.laning?.deaths ?? null,
    lh10: lane?.lh10 ?? null,
    defence: defence ? defence.map((r) => { const it = names.items[r.key]; return { key: r.key, en: it?.en ?? r.key, zh: it?.zh ?? r.key, time: r.time, vs: r.vs }; }) : null,
    has_items: defence != null,
    blink: blink ? blink.time : null,
    // No tracked ultimate (passive, Reincarnation, short cooldown): usage is
    // unknown, never "always cast" or "never cast".
    fights: fs ? { n: fs.fights, present: fs.present, won: fs.won, lost: fs.lost, ult_in: ch.fights.ultimate ? fs.ult_in : null, ult_unused: ch.fights.ultimate ? fs.ult_unused : null } : null,
    lead10: leadAt(10),
    lead20: leadAt(20),
    gpm: raw?.gold_per_min ?? null,
    findings: rv.findings.map((f) => f.id),
    plan: (ch.plan ?? []).map((x) => x.key),
    team: (p.radiant ? match.radiant_team?.name : match.dire_team?.name) ?? null,
    vs_team: (p.radiant ? match.dire_team?.name : match.radiant_team?.name) ?? null,
    league: match.league?.name ?? null,
    player: raw?.name ?? null,
    start_time: match.start_time ?? null,
  };
}

/** The profile seen against one damage type: its first item answering it. */
export function withDamageType(profile, type) {
  const first = type && profile.defence ? profile.defence.find((r) => r.vs.includes(type)) : null;
  return { ...profile, first_answer: first ? { key: first.key, en: first.en, zh: first.zh, time: first.time } : null };
}

/** Dominant incoming damage type for this player, if the report knows it. */
export function mainDamageType(review) {
  const types = review.chapters?.items?.damage?.types;
  if (!types) return null;
  // Only types the defensive-item lists classify (knowledge.js has physical
  // and magic answers, nothing for pure) — same restriction as itemsChapter.
  const [k, v] = Object.entries(types).filter(([x]) => x === 'physical' || x === 'magic').sort((a, b) => b[1] - a[1])[0] ?? [];
  return v >= 0.55 ? k : null;
}

/** The enemy hero the cases are about: who killed / hurt the player most. */
export function keyEnemyOf(report, slot) {
  const ch = report.reviews[slot].chapters;
  const top = ch?.deaths?.summary?.top_killer;
  if (top?.hero != null && top.deaths >= 3) return top.hero;
  const byHero = ch?.items?.damage?.by_hero?.[0];
  if (byHero?.hero != null) return byHero.hero;
  return null;
}

/* ---------------------------------------------------------------- themes */

/** Deaths to hero k, or null when the death log is incomplete. */
const deathsTo = (p, k) => (p.deaths_to ? (p.deaths_to[k] ?? 0) : null);

/**
 * Each theme: when it applies to the player, what counts as "the same
 * problem" (negative) and "avoided it and won" (positive) in a candidate, and
 * which metrics are compared. Metrics return null when a game lacks the data.
 */
const THEMES = [
  {
    key: 'deaths',
    applies: (me, k) => k != null && deathsTo(me, k) != null && (deathsTo(me, k) >= 3 || me.findings.includes('deaths.high')),
    title: (me, k) => t(`You died ${deathsTo(me, k)} times to ${heroName(k).en}`, `你死于${heroName(k).zh} ${deathsTo(me, k)} 次`),
    negative: (c, k) => deathsTo(c, k) != null && deathsTo(c, k) >= 3 && !c.won,
    positive: (c, k) => deathsTo(c, k) != null && deathsTo(c, k) <= 1 && c.deaths <= 6 && c.won,
    metrics: (k, type) => [
      { key: 'deaths', label: t('Deaths', '死亡'), get: (p) => p.deaths, better: 'lower' },
      { key: 'deaths_to', label: t(`Deaths to ${heroName(k).en}`, `死于${heroName(k).zh}`), get: (p) => deathsTo(p, k), better: 'lower' },
      { key: 'caught', label: t('Caught outside fights', '团战外被抓'), get: (p) => p.caught, better: 'lower' },
      { key: 'share_dead', label: t('Time spent dead', '阵亡时长占比'), get: (p) => p.share_dead, fmt: (v) => t(pct(v), pct(v)), better: 'lower' },
      ...(type ? [{ key: 'first_answer', label: t(`First item vs ${DMG_LABEL[type].en}`, `第一件防${DMG_LABEL[type].zh}装`), get: (p) => (p.has_items ? (p.first_answer?.time ?? Infinity) : null), fmt: (v, p) => (v === Infinity ? t('none', '没有') : t(`${p.first_answer.en} ${clock(v)}`, `${p.first_answer.zh} ${clock(v)}`)), better: 'lower' }] : []),
    ],
  },
  {
    key: 'fights',
    applies: (me) => !!me.fights && me.fights.ult_in != null && me.fights.present >= 4 && (me.fights.ult_unused >= 1 || me.fights.ult_in / me.fights.present < 0.5 || me.plan.includes('fights.ult_unused')),
    title: (me) => t(`Ultimate in ${me.fights.ult_in} of ${me.fights.present} fights you were in`, `你参与 ${me.fights.present} 波团战，只在 ${me.fights.ult_in} 波放了大`),
    // A case needs enough fights to show a habit, not a handful.
    negative: (c) => !!c.fights && c.fights.ult_in != null && c.fights.present >= 6 && c.fights.ult_in / c.fights.present < 0.5 && !c.won,
    positive: (c) => !!c.fights && c.fights.ult_in != null && c.fights.ult_unused != null && c.fights.present >= 6 && c.fights.ult_in / c.fights.present >= 0.5 && c.fights.ult_unused === 0 && c.won,
    metrics: () => [
      { key: 'ult_rate', label: t('Fights with your ultimate', '放了大的团战'), get: (p) => (p.fights && p.fights.present && p.fights.ult_in != null ? p.fights.ult_in / p.fights.present : null), fmt: (v, p) => t(`${p.fights.ult_in}/${p.fights.present}`, `${p.fights.ult_in}/${p.fights.present}`), better: 'higher' },
      { key: 'ult_unused', label: t('Fights with ultimate ready but unused', '大好了却没放'), get: (p) => p.fights?.ult_unused ?? null, better: 'lower' },
      { key: 'blink', label: t('Blink Dagger', '跳刀'), get: (p) => (p.has_items ? (p.blink ?? Infinity) : null), fmt: (v) => (v === Infinity ? t('none', '没有') : t(clock(v), clock(v))), better: 'lower' },
      { key: 'fights_won', label: t('Fights won / lost', '团战胜 / 负'), get: (p) => (p.fights ? p.fights.won - p.fights.lost : null), fmt: (v, p) => t(`${p.fights.won} / ${p.fights.lost}`, `${p.fights.won} / ${p.fights.lost}`), better: 'higher' },
    ],
  },
  {
    key: 'laning',
    applies: (me) => me.lane_outcome === 'lost' || me.lane_outcome === 'stomped',
    title: (me) => t(`Your lane was lost (${pct(me.lane_diff)} gold at 10:00)`, `你的对线劣势（10 分钟线上经济 ${pct(me.lane_diff)}）`),
    negative: (c) => (c.lane_outcome === 'lost' || c.lane_outcome === 'stomped') && !c.won,
    positive: (c) => c.lane_outcome != null && c.lane_outcome !== 'lost' && c.lane_outcome !== 'stomped' && c.won,
    metrics: () => [
      { key: 'lane_diff', label: t('Lane gold at 10:00', '10 分钟线上经济差'), get: (p) => p.lane_diff, fmt: (v) => t(`${v > 0 ? '+' : ''}${pct(v)}`, `${v > 0 ? '+' : ''}${pct(v)}`), better: 'higher' },
      { key: 'lh10', label: t('Last hits at 10:00', '10 分钟正补'), get: (p) => p.lh10, better: 'higher' },
      { key: 'lane_deaths', label: t('Deaths before 10:00', '10 分钟前死亡'), get: (p) => p.lane_deaths, better: 'lower' },
    ],
  },
  {
    key: 'items',
    applies: (me, k, type) => !!type && me.has_items && (!me.first_answer || me.first_answer.time > 25 * 60),
    title: (me, k, type) => (me.first_answer
      ? t(`Your first ${DMG_LABEL[type].en} defence came at ${clock(me.first_answer.time)}`, `你的第一件防${DMG_LABEL[type].zh}装 ${clock(me.first_answer.time)} 才出`)
      : t(`No item against the ${DMG_LABEL[type].en} damage you took`, `你没有针对所受${DMG_LABEL[type].zh}伤害的装备`)),
    negative: (c, k, type) => c.has_items && (!c.first_answer || c.first_answer.time > 25 * 60) && !c.won,
    positive: (c) => c.has_items && !!c.first_answer && c.first_answer.time <= 20 * 60 && c.won,
    metrics: (k, type) => [
      { key: 'first_answer', label: t(`First item vs ${DMG_LABEL[type].en}`, `第一件防${DMG_LABEL[type].zh}装`), get: (p) => (p.has_items ? (p.first_answer?.time ?? Infinity) : null), fmt: (v, p) => (v === Infinity ? t('none', '没有') : t(`${p.first_answer.en} ${clock(v)}`, `${p.first_answer.zh} ${clock(v)}`)), better: 'lower' },
      { key: 'deaths', label: t('Deaths', '死亡'), get: (p) => p.deaths, better: 'lower' },
      ...(k != null ? [{ key: 'deaths_to', label: t(`Deaths to ${heroName(k).en}`, `死于${heroName(k).zh}`), get: (p) => deathsTo(p, k), better: 'lower' }] : []),
    ],
  },
  {
    key: 'tempo',
    applies: (me) => me.lead20 != null && me.lead20 <= -5000,
    title: (me) => t(`Your team was ${fmtK(-me.lead20)} behind at 20:00`, `20 分钟时你们队落后 ${fmtK(-me.lead20)}`),
    negative: (c) => c.lead20 != null && c.lead20 <= -5000 && !c.won,
    // The situation that matters: also well behind at 20:00, and still won.
    positive: (c) => c.lead20 != null && c.lead20 <= -3000 && c.won,
    metrics: () => [
      { key: 'lead10', label: t('Team lead at 10:00', '10 分钟团队经济'), get: (p) => p.lead10, fmt: (v) => t(signedK(v), signedK(v)), better: 'higher' },
      { key: 'lead20', label: t('Team lead at 20:00', '20 分钟团队经济'), get: (p) => p.lead20, fmt: (v) => t(signedK(v), signedK(v)), better: 'higher' },
      { key: 'deaths', label: t('Your deaths', '你的死亡'), get: (p) => p.deaths, better: 'lower' },
      { key: 'fights_won', label: t('Fights won / lost', '团战胜 / 负'), get: (p) => (p.fights ? p.fights.won - p.fights.lost : null), fmt: (v, p) => t(`${p.fights.won} / ${p.fights.lost}`, `${p.fights.won} / ${p.fights.lost}`), better: 'higher' },
    ],
  },
];

/* ------------------------------------------------------------ similarity */

/** Higher is more alike: hero, enemy lineup, position, early game state. */
export function similarity(me, c) {
  let s = c.hero === me.hero ? 3 : 1;
  s += c.enemies.filter((h) => me.enemies.includes(h)).length;
  if (me.pos != null && c.pos === me.pos) s += 1;
  if (me.lead10 != null && c.lead10 != null && Math.sign(me.lead10) === Math.sign(c.lead10)) s += 1;
  return s;
}

/* -------------------------------------------------------------- analysis */

const fmtVal = (m, p) => {
  const v = m.get(p);
  if (v == null) return null;
  if (m.fmt) return m.fmt(v, p);
  return t(String(v), String(v));
};

/** Did `a` do better than `b` on this metric (by a meaningful margin)? */
function beats(m, a, b) {
  const va = m.get(a); const vb = m.get(b);
  if (va == null || vb == null) return false;
  if (va === vb) return false;
  const finite = Number.isFinite(va) && Number.isFinite(vb);
  if (finite) {
    const gap = Math.abs(va - vb);
    const scale = Math.max(Math.abs(va), Math.abs(vb), 1);
    // Small differences are noise; clocks need a minute, counts need 2.
    if (m.key === 'first_answer' || m.key === 'blink') { if (gap < 60) return false; }
    else if (m.key === 'share_dead' || m.key === 'ult_rate' || m.key === 'lane_diff') { if (gap < 0.08) return false; }
    else if (m.key === 'lead10' || m.key === 'lead20') { if (gap < 1500) return false; }
    else if (gap < 2 && gap / scale < 0.5) return false;
  }
  return m.better === 'lower' ? va < vb : va > vb;
}

function caseLabel(c) {
  const h = heroName(c.hero);
  const who = c.player ? `${c.player}（${h.zh}）` : h.zh;
  const whoEn = c.player ? `${c.player} (${h.en})` : h.en;
  const teams = c.team && c.vs_team ? [`${c.team} vs ${c.vs_team}`, `${c.team} 对 ${c.vs_team}`] : [null, null];
  return {
    who: t(whoEn, who),
    teams: teams[0] ? t(teams[0], teams[1]) : null,
  };
}

function describeCase(kind, c, me, metrics) {
  const { who } = caseLabel(c);
  const parts = metrics.map((m) => {
    const v = fmtVal(m, c);
    return v ? { en: `${m.label.en} ${v.en}`, zh: `${m.label.zh} ${v.zh}` } : null;
  }).filter(Boolean);
  const kda = c.kda.join('/');
  const head = kind === 'positive'
    ? t(`Positive · ${who.en}, ${kda}, won:`, `正例 · ${who.zh}，${kda}，赢：`)
    : t(`Negative · ${who.en}, ${kda}, lost:`, `反例 · ${who.zh}，${kda}，输：`);
  return t(`${head.en} ${parts.map((x) => x.en).join('; ')}.`, `${head.zh}${parts.map((x) => x.zh).join('；')}。`);
}

/** The bullet analysis comparing the player with the two cases. */
function analyse(theme, me, pos, neg, metrics) {
  const out = [];
  if (neg) {
    const same = metrics.filter((m) => !beats(m, neg, me) && !beats(m, me, neg) && m.get(neg) != null && m.get(me) != null);
    const lines = same.slice(0, 2).map((m) => `${m.label.zh} ${fmtVal(m, neg).zh}（你 ${fmtVal(m, me).zh}）`);
    const linesEn = same.slice(0, 2).map((m) => `${m.label.en} ${fmtVal(m, neg).en} (you ${fmtVal(m, me).en})`);
    out.push(lines.length
      ? t(`The negative case repeats your pattern — ${linesEn.join(', ')} — and that team lost.`, `反例和你是同一个模式：${lines.join('，')}，那一局也输了。`)
      : t('The negative case shows the same problem, and that team lost.', '反例出现了同样的问题，那一局也输了。'));
  }
  if (pos) {
    const diffs = metrics.filter((m) => beats(m, pos, me));
    if (diffs.length) {
      const zh = diffs.slice(0, 3).map((m) => `${m.label.zh} ${fmtVal(m, pos).zh}（你 ${fmtVal(m, me).zh}）`);
      const en = diffs.slice(0, 3).map((m) => `${m.label.en} ${fmtVal(m, pos).en} (you ${fmtVal(m, me).en})`);
      out.push(t(`What the positive case did differently: ${en.join('; ')}.`, `正例做得不一样的地方：${zh.join('；')}。`));
    } else {
      out.push(t('The positive case won with numbers close to yours here — the difference was elsewhere in that game.', '正例在这几项上和你差不多也赢了——差别在这几项之外。'));
    }
  }
  const tip = TIPS[theme.key];
  if (tip && pos) out.push(tip(pos, me));
  return out.filter(Boolean);
}

const earlier = (a, b) => a != null && (b == null || a < b - 60);

const TIPS = {
  deaths: (pos, me) => (pos.first_answer && earlier(pos.first_answer.time, me.first_answer?.time)
    ? t(`Copy one thing: they had ${pos.first_answer.en} by ${clock(pos.first_answer.time)}, before the fights that decided the game.`, `学一件事：他在 ${clock(pos.first_answer.time)} 就做出了${pos.first_answer.zh}，赶在决定胜负的团战之前。`)
    : pos.caught != null && me.caught != null && pos.caught + 2 <= me.caught
      ? t(`Copy one thing: caught outside a fight ${pos.caught} time${pos.caught === 1 ? '' : 's'} (you ${me.caught}) — farm where your team can reach you.`, `学一件事：他${pos.caught ? `只在团战外被抓 ${pos.caught} 次` : '一次都没在团战外被抓'}（你 ${me.caught} 次）——在队友够得着的地方发育。`)
      : null),
  fights: (pos, me) => (earlier(pos.blink, me.blink)
    ? t(`Copy one thing: Blink Dagger at ${clock(pos.blink)} let them start fights with the ultimate instead of waiting for it.`, `学一件事：${clock(pos.blink)} 出跳刀，用大招开团，而不是等团战打起来再找机会。`)
    : null),
  laning: (pos, me) => (pos.lane_deaths != null && me.lane_deaths != null && pos.lane_deaths < me.lane_deaths
    ? t(`Copy one thing: ${pos.lane_deaths ? `only ${pos.lane_deaths}` : 'no'} death${pos.lane_deaths === 1 ? '' : 's'} before 10:00 — not feeding comes before winning the lane.`, `学一件事：10 分钟前${pos.lane_deaths ? `只死 ${pos.lane_deaths} 次` : '一次没死'}——先保证不送，再谈打赢对线。`)
    : null),
  items: (pos, me) => (!earlier(pos.first_answer?.time, me.first_answer?.time) ? null : t(`Copy one thing: ${pos.first_answer.en} by ${clock(pos.first_answer.time)}.`, `学一件事：${clock(pos.first_answer.time)} 前做出${pos.first_answer.zh}。`)),
  tempo: (pos) => t(`Copy one thing: behind by ${fmtK(-pos.lead20)} at 20:00, they still won — trade fights only when the ultimate is ready and stop feeding the enemy's lead.`, `学一件事：20 分钟落后 ${fmtK(-pos.lead20)} 照样翻盘——只在大招好了时接团，别再给对面送经济。`),
};

/* ------------------------------------------------------------------ main */

export const CASES_NOTE = t(
  'Cases are professional games from the last 180 days (OpenDota), the same hero first, otherwise a hero with the same attribute, attack type and roles, against the same key enemy. Each is reviewed by the same engine as your game. They show what went together with winning or losing in a similar spot — not proof that one thing caused the result.',
  '案例来自近 180 天的职业比赛（OpenDota），优先同英雄，不够时用主属性、攻击方式和定位相近的英雄，且对面都有同一个关键对手。每场都用和你这局同一套引擎复盘。案例说明的是"相似局面下，哪些做法和胜负一起出现"，不证明某一项就是胜负的原因。',
);

/** Profile a candidate pro match for one slot; null when it cannot be used. */
export function candidateProfile(match, slot) {
  try {
    const r = buildCoachReport(match);
    if (!r.match.parsed || !r.reviews[slot]) return null;
    return profileOf(match, r, slot);
  } catch {
    return null;
  }
}

/**
 * @param {object} report      the player's coach report (parsed match)
 * @param {number} slot
 * @param {object} match       the player's raw match
 * @param {object[]} candidates profiles from candidateProfile()
 */
export function buildCaseStudies({ report, slot, match, candidates }) {
  const rv = report.reviews[slot];
  const k = keyEnemyOf(report, slot);
  const type = mainDamageType(rv);
  const me = withDamageType(profileOf(match, report, slot), type);
  const pool = candidates.map((c) => withDamageType(c, type));
  const themes = [];
  // Prefer a game not already shown for another theme, so the cases teach
  // from more than one match; fall back to a repeat rather than nothing.
  const used = new Set();
  const pick = (ranked, ok) => ranked.find((c) => ok(c) && !used.has(c.match_id)) ?? ranked.find(ok) ?? null;
  for (const th of THEMES) {
    if (!th.applies(me, k, type)) continue;
    const metrics = th.metrics(k, type).filter((m) => m.get(me) != null);
    const ranked = pool.filter((c) => c.match_id !== me.match_id).sort((a, b) => similarity(me, b) - similarity(me, a) || (b.start_time ?? 0) - (a.start_time ?? 0));
    const neg = pick(ranked, (c) => th.negative(c, k, type));
    const pos = pick(ranked, (c) => th.positive(c, k, type) && c.match_id !== neg?.match_id);
    if (!neg && !pos) continue;
    if (neg) used.add(neg.match_id);
    if (pos) used.add(pos.match_id);
    themes.push({
      key: th.key,
      title: th.title(me, k, type),
      metrics: metrics.map((m) => ({
        key: m.key,
        label: m.label,
        mine: fmtVal(m, me),
        positive: pos ? fmtVal(m, pos) : null,
        negative: neg ? fmtVal(m, neg) : null,
        better: m.better,
      })),
      positive: pos ? caseCard(pos, me) : null,
      negative: neg ? caseCard(neg, me) : null,
      analysis: analyse(th, me, pos, neg, metrics).filter(Boolean),
      summary: [neg && describeCase('negative', neg, me, metrics), pos && describeCase('positive', pos, me, metrics)].filter(Boolean),
    });
    if (themes.length >= 3) break;
  }
  return {
    key_enemy: k,
    damage_type: type,
    pool: { total: pool.length, same_hero: pool.filter((c) => c.hero === me.hero).length },
    themes,
    note: CASES_NOTE,
  };
}

function caseCard(c, me) {
  const { who, teams } = caseLabel(c);
  return {
    match_id: c.match_id,
    slot: c.slot,
    hero: (({ id, en, zh, img, icon }) => ({ id, en, zh, img, icon }))(heroInfo(c.hero)),
    same_hero: c.hero === me.hero,
    who,
    teams,
    league: c.league,
    won: c.won,
    kda: c.kda,
    duration: c.duration,
    start_time: c.start_time,
  };
}
