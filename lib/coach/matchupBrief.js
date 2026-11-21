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
import { ITEM_VS_SOURCE, MATCHUP_SOURCE, heroVs, itemLifts, laneMatchup } from './matchups.js';

const NAMES = createRequire(import.meta.url)('./data/names.json');
const ABILITIES = createRequire(import.meta.url)('./data/abilities.json');
const CDN = 'https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react';
const DMG = { P: { en: 'physical', zh: '物理' }, M: { en: 'magical', zh: '魔法' }, U: { en: 'pure', zh: '纯粹' } };

const norm = (s) => String(s ?? '').toLowerCase().replace(/[\s_'’-]/g, '');

/** A hero by id, slug, English or Chinese name; null when unknown. */
export function findHero(query) {
  if (query == null || query === '') return null;
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
 * only: damage type and whether it goes through spell immunity. Valve's
 * `dispellable` describes one modifier of an ability (Reincarnation's slow,
 * not the revival), so it is never presented as a fact about the ability.
 */
function abilityFacts(heroId) {
  const list = ABILITIES.heroes?.[String(heroId)];
  if (!Array.isArray(list)) return [];
  return list.map((a) => ({
    key: a.id, en: a.en, zh: a.zh, ultimate: Boolean(a.ult),
    damage: a.dmg ? DMG[a.dmg] : null,
    pierces_immunity: a.pierces === true,
  }));
}

/**
 * @param {string|number} heroQuery  your hero
 * @param {string|number} vsQuery    the hero you face
 * @returns {{ error: string } | object}
 */
export function matchupBrief(heroQuery, vsQuery) {
  const hero = findHero(heroQuery);
  const vs = findHero(vsQuery);
  if (!hero) return { error: `Unknown hero: ${heroQuery}` };
  if (!vs) return { error: `Unknown hero: ${vsQuery}` };
  if (hero.id === vs.id) return { error: 'Pick two different heroes' };
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
  const items = (list) => list.map((x) => `${x.item[lang]} ${pct(x.rate)}${zh ? `（平时 ${pct(x.base)}）` : ` (${pct(x.base)} usually)`}`).join(zh ? '、' : ', ');
  if (b.your_items_vs_them.length) out.push(zh ? `职业${H}对上${V}时更常出：${items(b.your_items_vs_them)}` : `Pro ${H} build more often against ${V}: ${items(b.your_items_vs_them)}`);
  if (b.their_items_vs_you.length) out.push(zh ? `职业${V}对上${H}时更常出：${items(b.their_items_vs_you)}` : `Pro ${V} build more often against ${H}: ${items(b.their_items_vs_you)}`);
  const facts = b.their_abilities.filter((a) => a.damage || a.pierces_immunity);
  if (facts.length) {
    out.push(zh ? `${V}的技能（Valve 数据）：` : `${V}'s abilities (Valve data):`);
    for (const a of facts) {
      const bits = [a.damage && (zh ? `${a.damage.zh}伤害` : `${a.damage.en} damage`), a.pierces_immunity && (zh ? '无视技能免疫' : 'goes through spell immunity')].filter(Boolean);
      out.push(`  - ${a[lang]}${a.ultimate ? (zh ? '（大招）' : ' (ultimate)') : ''}: ${bits.join(zh ? '，' : ', ')}`);
    }
  }
  return out;
}
