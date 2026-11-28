/**
 * A hero-vs-hero brief from the committed snapshots only — no match, no
 * network: the pro lane baseline (both directions), pro win rates, the
 * counter items pros build each way, and Valve's own facts about the other
 * hero's abilities that change how you play against them.
 *
 * Every number carries its sample; verdicts follow lib/coach/matchups.js
 * (none on noise). Served by GET /api/coach/matchup, the CLI `matchup`
 * command and the MCP `hero_matchup` tool.
 */
import { createRequire } from 'node:module';
import { heroByInput } from '../../packages/review-engine/src/staticHeroes.js';
import { ITEM_VS_SOURCE, MATCHUP_SOURCE, heroVs, itemLifts, laneMatchup } from './matchups.js';
import { BRACKETS, BRACKET_LABEL, RANK_SOURCE, heroVsRank, laneVsRank, parseBracket } from './matchupsRank.js';

const NAMES = createRequire(import.meta.url)('./data/names.json');
const ABILITIES = createRequire(import.meta.url)('./data/abilities.json');
const CDN = 'https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react';
const DMG = { P: { en: 'physical', zh: '物理' }, M: { en: 'magical', zh: '魔法' }, U: { en: 'pure', zh: '纯粹' } };

const norm = (s) => String(s ?? '').toLowerCase().replace(/[\s_'’-]/g, '');

/** A hero by id, slug, replay key, English or Chinese name, or curated CN/EN nickname; null when unknown. */
export function findHero(query) {
  if (query == null || query === '') return null;
  const resolved = heroByInput(query);
  if (resolved && NAMES.heroes[String(resolved.id)]) {
    const h = NAMES.heroes[String(resolved.id)];
    return { id: resolved.id, slug: h.slug, en: h.en, zh: h.zh, icon: `${CDN}/heroes/icons/${h.slug}.png` };
  }
  const q = norm(query);
  const hit = Object.entries(NAMES.heroes).find(([id, h]) => id === q || norm(h.slug) === q || norm(h.en) === q || h.zh === String(query).trim());
  if (!hit) return null;
  const [id, h] = hit;
  return { id: Number(id), slug: h.slug, en: h.en, zh: h.zh, icon: `${CDN}/heroes/icons/${h.slug}.png` };
}

const itemRef = (key) => {
  const it = NAMES.items[key];
  return { key, en: it?.en ?? key, zh: it?.zh ?? key, img: `${CDN}/items/${key}.png` };
};

/**
 * Valve's flags for each of a hero's abilities (datafeed snapshot), facts
 * only: damage type and whether it goes through spell immunity (null when
 * the snapshot has no immunity flag for that ability). Valve's
 * `dispellable` describes one modifier of an ability (Reincarnation's slow,
 * not the revival), so it is never presented as a fact about the ability.
 */
function abilityFacts(heroId) {
  const list = ABILITIES.heroes?.[String(heroId)];
  if (!Array.isArray(list)) return [];
  return list.map((a) => ({
    key: a.id, en: a.en, zh: a.zh, ultimate: Boolean(a.ult),
    ...(a.granted_by ? { granted_by: a.granted_by } : {}),
    damage: a.dmg ? DMG[a.dmg] : null,
    // true / false only when Valve's snapshot says so; null = not in the data (never a confirmed "no").
    pierces_immunity: a.pierces === true ? true : a.pierces === false ? false : null,
  }));
}

/**
 * @param {string|number} heroQuery  your hero
 * @param {string|number} vsQuery    the hero you face
 * @param {{ rank?: string|number|null }} [opts]  a bracket (hg|ca|la|di), medal name or rank tier: the lines lead with it
 * @returns {{ error: string } | object}
 */
export function matchupBrief(heroQuery, vsQuery, opts = {}) {
  const hero = findHero(heroQuery);
  const vs = findHero(vsQuery);
  if (!hero) return { error: `Unknown hero: ${heroQuery}` };
  if (!vs) return { error: `Unknown hero: ${vsQuery}` };
  if (hero.id === vs.id) return { error: 'Pick two different heroes' };
  const rank = opts.rank == null || opts.rank === '' ? null : parseBracket(opts.rank);
  if (opts.rank != null && opts.rank !== '' && !rank) return { error: `Unknown rank: ${opts.rank} (use hg, ca, la, di, a medal name or a rank tier)` };
  const wr = heroVs(hero.id, vs.id);
  const lane = laneMatchup(hero.id, vs.id);
  const lifts = (h, v) => itemLifts(h, v).map((x) => ({ item: itemRef(x.key), rate: x.rate, base: x.base, n: x.n }));
  return {
    hero, vs,
    source: {
      matches: 'OpenDota explorer, professional matches', since: MATCHUP_SOURCE.since, games: MATCHUP_SOURCE.games, fetched: MATCHUP_SOURCE.fetched,
      item_rule: ITEM_VS_SOURCE.rule, abilities: `Valve datafeed, ${ABILITIES.patch}`,
    },
    // null: too few pro games for a claim (see lib/coach/matchups.js).
    win_rate: wr ? { n: wr.n, wr: wr.wr, base: wr.base, verdict: wr.verdict } : null,
    lane: lane ? { n: lane.n, gold10_mean: lane.mean, gold10_p25: lane.p25, gold10_p75: lane.p75, ahead: lane.ahead, verdict: lane.verdict } : null,
    // What pros on each side build clearly more often against the other.
    your_items_vs_them: lifts(hero.id, vs.id),
    their_items_vs_you: lifts(vs.id, hero.id),
    their_abilities: abilityFacts(vs.id),
    // Public games per rank bracket (STRATZ; credit `rank_source.attribution` wherever shown). null: too few games.
    rank,
    rank_source: { source: RANK_SOURCE.source, attribution: RANK_SOURCE.attribution, patch: RANK_SOURCE.patch, weeks: RANK_SOURCE.weeks, fetched: RANK_SOURCE.fetched },
    by_rank: Object.fromEntries(BRACKETS.map((b) => {
      const w = heroVsRank(hero.id, vs.id, b);
      const l = laneVsRank(hero.id, vs.id, b);
      return [b, {
        label: BRACKET_LABEL[b],
        win_rate: w ? { n: w.n, wr: w.wr, base: w.base, verdict: w.verdict } : null,
        lane: l ? { n: l.n, won: l.won, even: l.even, lost: l.lost, stomped: l.stomped, usual_won: l.base.won, usual_lost: l.base.lost, verdict: l.verdict } : null,
      }];
    })),
  };
}

const pct = (x) => `${Math.round(x * 100)}%`;
const k = (n) => (Math.abs(n) >= 1000 ? `${(Math.abs(n) / 1000).toFixed(1)}k` : String(Math.round(Math.abs(n))));
const VERDICT = {
  favoured: { en: 'favours {hero}', zh: '{hero}占优' },
  unfavoured: { en: 'favours {vs}', zh: '{vs}占优' },
  even: { en: 'no real edge', zh: '没有明显优劣' },
};

/** The brief as short lines for a terminal or a prompt, in one language. */
export function matchupLines(b, lang = 'en') {
  const zh = lang === 'zh';
  const H = b.hero[lang]; const V = b.vs[lang];
  const v = (x) => VERDICT[x][lang].replace('{hero}', H).replace('{vs}', V);
  const out = [zh ? `${H} 对 ${V}（职业比赛，${b.source.since} 以来）` : `${H} vs ${V} (pro games since ${b.source.since})`];
  out.push(b.win_rate
    ? (zh ? `胜率：${H} ${pct(b.win_rate.wr)}（${b.win_rate.n} 场，平时 ${pct(b.win_rate.base)}）——${v(b.win_rate.verdict)}`
      : `Win rate: ${H} ${pct(b.win_rate.wr)} (${b.win_rate.n} games, ${pct(b.win_rate.base)} usually) — ${v(b.win_rate.verdict)}`)
    : (zh ? '胜率：样本不足' : 'Win rate: too few games'));
  out.push(b.lane
    ? (zh ? `对线（双方核心同路）：10 分钟平均${b.lane.gold10_mean >= 0 ? '领先' : '落后'} ${k(b.lane.gold10_mean)}，中间一半在 ${b.lane.gold10_p25} 到 ${b.lane.gold10_p75}，${H}领先 ${pct(b.lane.ahead)}（${b.lane.n} 场）——${v(b.lane.verdict)}`
      : `Lane (both cores in the same lane): ${b.lane.gold10_mean >= 0 ? '+' : '−'}${k(b.lane.gold10_mean)} gold at 10:00 on average, middle half ${b.lane.gold10_p25} to ${b.lane.gold10_p75}, ${H} ahead in ${pct(b.lane.ahead)} (${b.lane.n} games) — ${v(b.lane.verdict)}`)
    : (zh ? '对线：两者同路对位的职业样本不足' : 'Lane: too few pro games with both cores in one lane'));
  // Public games at one bracket (the asked one first), credited to STRATZ.
  for (const key of b.rank ? [b.rank] : []) {
    const r = b.by_rank[key];
    const rs = b.rank_source;
    out.push(zh ? `${r.label.zh}路人局（${rs.patch}，截至 ${rs.weeks.to} 的 ${rs.weeks.count} 周，数据来自 STRATZ）` : `${r.label.en} public games (${rs.patch}, ${rs.weeks.count} weeks to ${rs.weeks.to}, data: STRATZ)`);
    out.push(r.win_rate
      ? (zh ? `  胜率：${H} ${pct(r.win_rate.wr)}（${r.win_rate.n} 场，平时 ${pct(r.win_rate.base)}）——${v(r.win_rate.verdict)}`
        : `  Win rate: ${H} ${pct(r.win_rate.wr)} (${r.win_rate.n} games, ${pct(r.win_rate.base)} overall) — ${v(r.win_rate.verdict)}`)
      : (zh ? '  胜率：样本不足' : '  Win rate: too few games'));
    out.push(r.lane
      ? (zh ? `  同线对线：${H}赢 ${pct(r.lane.won)}、平 ${pct(r.lane.even)}、输 ${pct(r.lane.lost)}（被打崩 ${pct(r.lane.stomped)}，${r.lane.n} 条线；${H}平时赢 ${pct(r.lane.usual_won)}、输 ${pct(r.lane.usual_lost)}）——${v(r.lane.verdict)}`
        : `  Same lane: ${H} won ${pct(r.lane.won)}, even ${pct(r.lane.even)}, lost ${pct(r.lane.lost)} (stomped ${pct(r.lane.stomped)}, ${r.lane.n} lanes; ${H} usually wins ${pct(r.lane.usual_won)}, loses ${pct(r.lane.usual_lost)}) — ${v(r.lane.verdict)}`)
      : (zh ? '  同线对线：样本不足' : '  Same lane: too few lanes'));
  }
  const items = (list) => list.map((x) => `${x.item[lang]} ${pct(x.rate)}${zh ? `（平时 ${pct(x.base)}）` : ` (${pct(x.base)} usually)`}`).join(zh ? '、' : ', ');
  if (b.your_items_vs_them.length) out.push(zh ? `职业${H}对上${V}时更常出：${items(b.your_items_vs_them)}` : `Pro ${H} build more often against ${V}: ${items(b.your_items_vs_them)}`);
  if (b.their_items_vs_you.length) out.push(zh ? `职业${V}对上${H}时更常出：${items(b.their_items_vs_you)}` : `Pro ${V} build more often against ${H}: ${items(b.their_items_vs_you)}`);
  const facts = b.their_abilities.filter((a) => a.damage || a.pierces_immunity);
  if (facts.length) {
    out.push(zh ? `${V}的技能（Valve 数据）：` : `${V}'s abilities (Valve data):`);
    for (const a of facts) {
      const bits = [a.damage && (zh ? `${a.damage.zh}伤害` : `${a.damage.en} damage`), a.pierces_immunity && (zh ? '无视技能免疫' : 'goes through spell immunity')].filter(Boolean);
      const tag = a.ultimate ? (zh ? '（大招）' : ' (ultimate)')
        : a.granted_by === 'scepter' ? (zh ? '（神杖）' : ' (Scepter)')
          : a.granted_by === 'shard' ? (zh ? '（魔晶）' : ' (Shard)') : '';
      out.push(`  - ${a[lang]}${tag}: ${bits.join(zh ? '，' : ', ')}`);
    }
  }
  return out;
}
