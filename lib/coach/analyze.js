/**
 * Coach report engine — pure, deterministic, no IO, no clock, no LLM.
 *
 * Input: a raw OpenDota /matches/:id payload (parsed or not).
 * Output: `dota2.ai/coach-report@1` — every finding carries bilingual text,
 * the evidence it rests on, a confidence and the data tier it needs. When the
 * match is not parsed, the report says exactly what it cannot see instead of
 * guessing.
 */
import { createRequire } from 'node:module';
import {
  ANSWERS, BUILT_IN_IMMUNITY, TAG_LABELS, KEY_ITEM_MIN_COST, ALWAYS_KEY_ITEMS, heroTags,
} from './knowledge.js';

import { buildChapters } from './chapters.js';
import { isMatchParsed } from '../../packages/review-engine/src/matchParse.js';

const NAMES = createRequire(import.meta.url)('./data/names.json');

export const REPORT_SCHEMA = 'dota2.ai/coach-report@1';
export const ENGINE_VERSION = '1.1.0';

const CDN = 'https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react';
const t = (en, zh) => ({ en, zh });
const clock = (sec) => {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const pct = (v) => `${Math.round(v * 100)}%`;
const fmtK = (n) => (Math.abs(n) >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));
const signed = (n) => `${n > 0 ? '+' : n < 0 ? '−' : '±'}${fmtK(Math.abs(n))}`;

const PATCHES = { 58: '7.39', 59: '7.40', 60: '7.41', 61: '7.42' };
const MODES = {
  1: t('All Pick', '全英雄选择'), 2: t("Captains Mode", '队长模式'), 3: t('Random Draft', '随机征召'),
  4: t('Single Draft', '单一征召'), 5: t('All Random', '全部随机'), 16: t("Captains Draft", '队长征召'),
  18: t('Ability Draft', '技能征召'), 22: t('All Pick', '全英雄选择'), 23: t('Turbo', '加速模式'),
};

export function heroInfo(heroId) {
  const h = NAMES.heroes[String(heroId)];
  if (!h) return { id: heroId, en: `Hero ${heroId}`, zh: `英雄 ${heroId}`, slug: '', roles: [], img: null, icon: null };
  return {
    id: heroId, en: h.en, zh: h.zh, slug: h.slug, roles: h.roles, attack: h.attack,
    img: `${CDN}/heroes/${h.slug}.png`, icon: `${CDN}/heroes/icons/${h.slug}.png`,
  };
}

const ITEM_BY_ID = new Map(Object.entries(NAMES.items).map(([key, v]) => [v.id, key]));
export function itemInfo(key) {
  const it = NAMES.items[key];
  if (!it) return { key, en: key, zh: key, cost: 0, img: null };
  return { key, en: it.en, zh: it.zh, cost: it.cost, img: `${CDN}/items/${key}.png` };
}
const itemKeyById = (id) => (id ? ITEM_BY_ID.get(id) ?? null : null);

/**
 * Same predicate the parse-request endpoint uses, so "parsed" never disagrees
 * between the button and the report (incl. verified first-party replays).
 * What a parse actually supplied is checked per field in `dataGaps`.
 */
export function isParsed(match) {
  return isMatchParsed(match);
}

/** Field-level gaps: a replay overlay may bring deaths but no gold series. */
export function dataGaps(match) {
  const ps = Array.isArray(match?.players) ? match.players : [];
  const any = (fn) => ps.some(fn);
  const arr = (v) => Array.isArray(v) && v.length > 0;
  const gaps = [];
  if (!any((p) => arr(p.gold_t) && arr(p.lh_t))) gaps.push(t('Laning (last hits, gold at 10:00)', '对线期（10 分钟正补、经济）'));
  if (!any((p) => arr(p.deaths_log) || arr(p.kills_log))) gaps.push(t('When and to whom you died', '死亡的时间与击杀者'));
  if (!any((p) => arr(p.purchase_log))) gaps.push(t('Item purchase timings and sold items', '出装时间与卖掉的装备'));
  if (!arr(match?.radiant_gold_adv) || !arr(match?.teamfights)) gaps.push(t('Gold graph, team fights, towers and Roshan', '经济曲线、团战、推塔与肉山'));
  if (!any((p) => p.obs_placed != null)) gaps.push(t('Wards and detection', '视野与反隐'));
  return gaps;
}

/* ------------------------------------------------------------------ roles */

function inferRoles(players, parsed) {
  const roles = new Array(players.length).fill(null);
  for (const radiant of [true, false]) {
    const team = players.map((p, i) => ({ p, i })).filter(({ p }) => Boolean(p.isRadiant) === radiant);
    // Support-only heroes get a small handicap so a farming support does not
    // outrank a starved core on raw GPM alone.
    const farmScore = ({ p }) => {
      const r = heroInfo(p.hero_id).roles;
      return (p.gold_per_min ?? 0) * (r.includes('Support') && !r.includes('Carry') ? 0.85 : 1);
    };
    const byFarm = [...team].sort((a, b) => farmScore(b) - farmScore(a));
    const lanesKnown = parsed && team.length === 5 && team.every(({ p }) => [1, 2, 3, 4].includes(p.lane_role));
    let assigned = false;
    if (lanesKnown) {
      const lane = (n) => team.filter(({ p }) => p.lane_role === n && !p.is_roaming)
        .sort((a, b) => (b.p.gold_per_min ?? 0) - (a.p.gold_per_min ?? 0));
      const safe = lane(1); const mid = lane(2); const off = lane(3);
      const pos = new Map();
      if (safe[0]) pos.set(safe[0].i, 1);
      if (mid[0]) pos.set(mid[0].i, 2);
      if (off[0]) pos.set(off[0].i, 3);
      const rest = team.filter(({ i }) => !pos.has(i));
      for (const r of rest) {
        const onSafe = r.p.lane_role === 1 && !r.p.is_roaming;
        pos.set(r.i, onSafe ? 5 : 4);
      }
      const counts = [1, 2, 3, 4, 5].map((n) => [...pos.values()].filter((v) => v === n).length);
      if (counts.every((c) => c === 1)) {
        for (const [i, n] of pos) roles[i] = { pos: n, kind: n <= 3 ? 'core' : 'support', confidence: 'high', source: 'lanes' };
        assigned = true;
      }
    }
    if (!assigned) {
      // Without lanes we can tell cores from supports, not 1 from 3.
      byFarm.forEach(({ i }, rank) => {
        roles[i] = { pos: null, kind: rank < 3 ? 'core' : 'support', farm_rank: rank + 1, confidence: 'medium', source: 'farm' };
      });
    }
  }
  return roles;
}

const KIND_LABEL = { core: t('Core', '核心'), support: t('Support', '辅助') };
const POS_LABEL = {
  1: t('Pos 1 · carry', '1 号位 · 大哥'), 2: t('Pos 2 · mid', '2 号位 · 中单'),
  3: t('Pos 3 · offlane', '3 号位 · 劣势路'), 4: t('Pos 4 · soft support', '4 号位 · 游走辅助'),
  5: t('Pos 5 · hard support', '5 号位 · 保姆'),
};

/* ---------------------------------------------------------------- helpers */

function inventory(p) {
  const keys = ['item_0', 'item_1', 'item_2', 'item_3', 'item_4', 'item_5', 'backpack_0', 'backpack_1', 'backpack_2']
    .map((k) => itemKeyById(p[k])).filter(Boolean);
  if (p.aghanims_scepter) keys.push('ultimate_scepter');
  if (p.aghanims_shard) keys.push('aghanims_shard');
  return [...new Set(keys)];
}

function bench(p, key) {
  const b = p.benchmarks?.[key];
  return b && Number.isFinite(b.pct) ? { raw: b.raw, pct: b.pct } : null;
}

function names(list, lang) { return list.map((h) => h[lang]).join(lang === 'zh' ? '、' : ', '); }

function threatProfile(enemies) {
  const avgNw = enemies.reduce((s, e) => s + (e.raw.net_worth ?? 0), 0) / Math.max(1, enemies.length) || 1;
  const avgK = enemies.reduce((s, e) => s + (e.raw.kills ?? 0), 0) / Math.max(1, enemies.length) || 1;
  const score = {};
  const heroesByTag = {};
  let primary = null;
  for (const e of enemies) {
    const w = (e.raw.net_worth ?? avgNw) / avgNw;
    const danger = w + (e.raw.kills ?? 0) / avgK;
    if (!primary || danger > primary.danger) primary = { ...e, danger };
    for (const tag of e.tags) {
      score[tag] = (score[tag] ?? 0) + w;
      (heroesByTag[tag] ??= []).push(e.hero);
    }
  }
  const tags = Object.entries(score).sort((a, b) => b[1] - a[1])
    .map(([tag, s]) => ({ tag, score: Math.round(s * 100) / 100, heroes: heroesByTag[tag], label: TAG_LABELS[tag] }));
  const piercing = new Set(enemies.filter((e) => e.tags.has('piercing')).map((e) => e.hero.slug));
  return { tags, primary, piercing };
}

/* -------------------------------------------------------------- detectors */

function itemFinding(ctx) {
  const { me, role, enemyProfile, durationMin } = ctx;
  if (durationMin < 20) return null;
  const inv = new Set(me.items);
  const kind = role.kind;
  // A missing answer only matters if it cost you: supports must have died a
  // lot, cores at least more than the median player of their hero.
  const diedOften = me.deathsPct != null && me.deathsPct < (kind === 'support' ? 0.3 : 0.5);
  const primarySlug = enemyProfile.primary?.hero.slug;
  const urgent = enemyProfile.tags.filter((x) => x.score >= 1.4 && ['magic', 'disable', 'silence'].includes(x.tag));
  // Evasion / illusions only matter when that hero is the one beating you.
  const otherTags = enemyProfile.tags.filter((x) => ['evasion', 'illusions'].includes(x.tag) && kind === 'core'
    && x.heroes.some((h) => h.slug === primarySlug));
  const missing = [];
  const covered = [];
  for (const x of [...urgent, ...otherTags]) {
    if (x.tag !== 'evasion' && x.tag !== 'illusions' && kind === 'core' && BUILT_IN_IMMUNITY.includes(me.hero.slug)) continue;
    if (x.tag === 'evasion' && !me.hero.roles.includes('Carry')) continue;
    // BKB does not stop BKB-piercing ultimates: against those disablers it
    // neither counts as coverage nor gets recommended as the answer.
    const pierced = x.tag === 'disable' && x.heroes.some((h) => enemyProfile.piercing.has(h.slug));
    const answers = ANSWERS[x.tag][kind].filter((a) => !(pierced && a === 'black_king_bar'));
    const have = answers.filter((a) => inv.has(a));
    (have.length ? covered : missing).push({ ...x, have, answers, pierced });
  }
  const evidence = [
    { k: t('Your final items', '你的终局装备'), items: me.items },
    ...enemyProfile.tags.slice(0, 3).map((x) => ({ k: t(`Enemy ${x.label.en}`, `对方${x.label.zh}`), heroes: x.heroes.map((h) => h.id) })),
  ];
  if (missing.length && diedOften) {
    const m = missing[0];
    const sample = m.answers.slice(0, 4).map((a) => itemInfo(a));
    const died = me.deathsPct != null && me.deathsPct < 0.3;
    const piercers = m.pierced ? m.heroes.filter((h) => enemyProfile.piercing.has(h.slug)) : [];
    const pierceEn = piercers.length ? ` Black King Bar does not stop ${names(piercers, 'en')}'s ultimate, so it is not enough here.` : '';
    const pierceZh = piercers.length ? `黑皇杖挡不住${names(piercers, 'zh')}的大招，单靠它不够。` : '';
    return {
      id: 'items.answer_missing', area: 'items', tone: 'fix', severity: died ? 3 : 2, confidence: 'medium', tier: 'basic',
      title: t(
        `No item answer to their ${m.label.en}`,
        `没有针对对方${m.label.zh}的装备`,
      ),
      body: t(
        `${names(m.heroes, 'en')} brought ${m.label.en}. You finished with nothing that answers it — the usual tools for a ${kind} are ${names(sample, 'en')}.${pierceEn}${died ? ` You also died more than most ${me.hero.en} players (${me.deaths} deaths).` : ''}`,
        `${names(m.heroes, 'zh')}带来了${m.label.zh}。你的终局装备里没有任何应对手段——${kind === 'core' ? '核心' : '辅助'}常见的解法是 ${names(sample, 'zh')}。${pierceZh}${died ? `同时你的死亡数（${me.deaths} 次）高于大多数${me.hero.zh}玩家。` : ''}`,
      ),
      ask: t(
        `Think of the fight you most regret. Which enemy spell started it — and which item slot could have been ${sample[0].en} instead?`,
        `回想最后悔的那波团：是对面哪个技能先手的？你哪一格装备本可以换成${sample[0].zh}？`,
      ),
      evidence,
      caveat: t('Final inventory only: we cannot see what you sold or when you bought it until the match is parsed.', '这里只看到终局装备：比赛解析前看不到卖掉了什么、什么时候买的。'),
    };
  }
  if (covered.length && covered[0].score >= 2 && kind === 'core') {
    const c = covered[0];
    return {
      id: 'items.answer_present', area: 'items', tone: 'good', severity: 1, confidence: 'medium', tier: 'basic',
      title: t(`Your build answered their ${c.label.en}`, `你的出装回应了对方的${c.label.zh}`),
      body: t(
        `Against ${names(c.heroes, 'en')} you had ${names(c.have.map(itemInfo), 'en')}. Keep that read — the next step is getting it before the fight that decides the game.`,
        `面对${names(c.heroes, 'zh')}，你出了${names(c.have.map(itemInfo), 'zh')}。判断是对的，下一步是在决定胜负的团战之前做出来。`,
      ),
      ask: t('Was it in your inventory before the first big fight it mattered in?', '它是在第一波关键团战之前到手的吗？'),
      evidence,
    };
  }
  return null;
}

function farmFinding(ctx) {
  const { me, role } = ctx;
  if (role.kind !== 'core') return null;
  const gpm = bench(me.raw, 'gold_per_min');
  const lh = bench(me.raw, 'last_hits_per_min');
  if (!gpm) return null;
  const evidence = [
    { k: t('GPM', '每分钟经济'), v: String(me.raw.gold_per_min), sub: t(`beats ${pct(gpm.pct)} of ${me.hero.en} games`, `高于 ${pct(gpm.pct)} 的${me.hero.zh}对局`) },
    ...(lh ? [{ k: t('Last hits / min', '每分钟正补'), v: lh.raw.toFixed(1), sub: t(`beats ${pct(lh.pct)}`, `高于 ${pct(lh.pct)}`) }] : []),
  ];
  const lowLh = lh && lh.pct < 0.5;
  if (gpm.pct < 0.3) {
    return {
      id: 'farm.low', area: 'farm', tone: 'fix', severity: gpm.pct < 0.15 ? 3 : 2, confidence: 'high', tier: 'basic',
      title: t(`Farm fell behind for a ${role.pos ? `pos ${role.pos}` : 'core'}`, `作为${role.pos ? ` ${role.pos} 号位` : '核心'}，经济落后了`),
      body: t(
        `${me.raw.gold_per_min} GPM is lower than ${pct(1 - gpm.pct)} of recent ${me.hero.en} games${lowLh ? `, and ${lh.raw.toFixed(1)} last hits a minute only beats ${pct(lh.pct)}` : ''}. A core's job is to turn the map's gold into items; this game, that conversion stalled.`,
        `每分钟 ${me.raw.gold_per_min} 经济，低于近期 ${pct(1 - gpm.pct)} 的${me.hero.zh}对局${lowLh ? `；每分钟 ${lh.raw.toFixed(1)} 个正补，只高于 ${pct(lh.pct)}` : ''}。核心的任务是把地图上的钱变成装备，这一局这条转化链断了。`,
      ),
      ask: t('Between minute 10 and 20, which lane or camp was free that you were not on? What pulled you away?', '10 到 20 分钟之间，哪条线或哪片野是空着的而你不在？是什么把你拉走了？'),
      evidence,
    };
  }
  if (gpm.pct >= 0.75) {
    return {
      id: 'farm.strong', area: 'farm', tone: 'good', severity: 1, confidence: 'high', tier: 'basic',
      title: t('Your farm was strong', '你的经济效率很好'),
      body: t(`${me.raw.gold_per_min} GPM beats ${pct(gpm.pct)} of ${me.hero.en} games.`, `每分钟 ${me.raw.gold_per_min} 经济，高于 ${pct(gpm.pct)} 的${me.hero.zh}对局。`),
      ask: t('Did the farm arrive in time for the fights that mattered?', '这些经济在关键团战前转化成战斗力了吗？'),
      evidence,
    };
  }
  return null;
}

function deathFinding(ctx) {
  const { me, role, deathsDetail } = ctx;
  const d = bench(me.raw, 'deaths_per_min');
  if (!d || d.pct >= 0.3) return null;
  const support = role.kind === 'support';
  const evidence = [
    { k: t('Deaths', '死亡'), v: String(me.deaths), sub: t(`more than ${pct(1 - d.pct)} of ${me.hero.en} games`, `多于 ${pct(1 - d.pct)} 的${me.hero.zh}对局`) },
  ];
  let extraEn = ''; let extraZh = '';
  if (deathsDetail) {
    const { alone, converted, early, list } = deathsDetail;
    if (!deathsDetail.complete) evidence.push({ k: t('Deaths with a timeline', '有时间线的死亡'), v: `${list.length}/${deathsDetail.recorded}` });
    if (alone != null) evidence.push({ k: t('Outside team fights', '团战之外'), v: `${alone}/${list.length}` });
    if (converted != null) evidence.push({ k: t('Followed by an enemy objective ≤90s', '90 秒内对方拿到目标'), v: `${converted}/${list.length}` });
    if (early) evidence.push({ k: t('Before 10:00', '10 分钟前'), v: String(early) });
    const byKiller = new Map();
    for (const x of list) if (x.killer != null) byKiller.set(x.killer, (byKiller.get(x.killer) ?? 0) + 1);
    const [topId, topN] = [...byKiller.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
    if (topN >= 3 && topN / list.length >= 0.4) {
      const h = heroInfo(topId);
      evidence.push({ k: t(`Killed by ${h.en}`, `死于${h.zh}`), v: `${topN}/${list.length}`, heroes: [topId] });
      extraEn += ` ${topN} of them were to ${h.en}.`;
      extraZh += `其中 ${topN} 次死于${h.zh}。`;
    }
    if (alone != null) {
      extraEn += ` ${alone} of them happened outside any team fight — you were caught, not trading.`;
      extraZh += `其中 ${alone} 次发生在团战之外——是被抓，而不是交换。`;
    }
    if (converted != null) {
      extraEn += ` ${converted} were followed by the enemy taking a tower or Roshan within 90 seconds.`;
      extraZh += `${converted} 次死后 90 秒内对方推掉了塔或拿了肉山。`;
    }
  }
  return {
    id: 'deaths.high', area: 'deaths', tone: 'fix', severity: d.pct < 0.12 ? 3 : 2, confidence: deathsDetail?.alone != null ? 'high' : 'medium', tier: deathsDetail ? 'parsed' : 'basic',
    title: t(`${me.deaths} deaths cost more than they bought`, `${me.deaths} 次死亡，代价大于收益`),
    body: t(
      `${me.deaths} deaths is more than ${pct(1 - d.pct)} of ${me.hero.en} games.${support ? ' Some support deaths are good trades that save a core — the question is which ones were not.' : ''}${extraEn}`,
      `${me.deaths} 次死亡，多于 ${pct(1 - d.pct)} 的${me.hero.zh}对局。${support ? '辅助的一部分死亡是用命换核心存活的好交换——关键是分清哪些不是。' : ''}${extraZh}`,
    ),
    ask: t(
      'Pick one death you think was avoidable. Before it, what did the minimap show — and where were the enemies you could not see?',
      '挑一次你觉得本可以避免的死亡：死前小地图显示了什么？看不到的敌人可能在哪里？',
    ),
    evidence,
    caveat: deathsDetail ? null : t('Not parsed yet: we know how many times you died, not where, when, or to whom.', '比赛尚未解析：只知道死亡次数，不知道在哪、何时、被谁击杀。'),
  };
}

function impactFinding(ctx) {
  const { me, role, won } = ctx;
  if (role.kind !== 'core') return null;
  const gpm = bench(me.raw, 'gold_per_min');
  const dmg = bench(me.raw, 'hero_damage_per_min');
  const tower = bench(me.raw, 'tower_damage');
  if (gpm && dmg && gpm.pct >= 0.45 && dmg.pct < 0.25) {
    return {
      id: 'impact.damage', area: 'fights', tone: 'fix', severity: 2, confidence: 'medium', tier: 'basic',
      title: t('Farm did not turn into fight damage', '经济没有转化成团战伤害'),
      body: t(
        `Your GPM beats ${pct(gpm.pct)} of ${me.hero.en} games, but hero damage per minute only ${pct(dmg.pct)}. You had the items; the fights happened without them.`,
        `你的每分钟经济高于 ${pct(gpm.pct)} 的${me.hero.zh}对局，但每分钟英雄伤害只高于 ${pct(dmg.pct)}。装备有了，团战却是在你缺席或打不出输出的情况下发生的。`,
      ),
      ask: t('In the fights you lost, were you late, dead early, or unable to reach a target?', '输掉的团战里，你是来晚了、先死了，还是摸不到目标？'),
      evidence: [
        { k: t('GPM', '每分钟经济'), v: String(me.raw.gold_per_min), sub: t(`beats ${pct(gpm.pct)}`, `高于 ${pct(gpm.pct)}`) },
        { k: t('Hero damage / min', '每分钟英雄伤害'), v: fmtK(dmg.raw), sub: t(`beats ${pct(dmg.pct)}`, `高于 ${pct(dmg.pct)}`) },
      ],
    };
  }
  if (tower && !won && tower.pct < 0.2 && role.kind === 'core') {
    return {
      id: 'impact.buildings', area: 'objectives', tone: 'fix', severity: 1, confidence: 'medium', tier: 'basic',
      title: t('Almost no pressure on buildings', '几乎没有推塔压力'),
      body: t(
        `${fmtK(tower.raw)} tower damage is in the bottom ${pct(tower.pct)} for ${me.hero.en}. When you are behind, split pressure is often how a core buys time.`,
        `${fmtK(tower.raw)} 点建筑伤害，处在${me.hero.zh}对局的后 ${pct(tower.pct)}。落后时，带线牵制往往是核心争取时间的方式。`,
      ),
      ask: t('When your team was defending, which lane could you have pushed instead?', '你们在防守时，有没有一条线你本可以去推？'),
      evidence: [{ k: t('Tower damage', '建筑伤害'), v: fmtK(tower.raw), sub: t(`beats ${pct(tower.pct)}`, `高于 ${pct(tower.pct)}`) }],
    };
  }
  return null;
}

function teamAnswerFinding(ctx) {
  const { team, enemyProfile, durationMin } = ctx;
  const p = enemyProfile.primary;
  if (!p || durationMin < 20) return null;
  const k = p.raw.kills ?? 0; const dd = p.raw.deaths ?? 0;
  if (k < 10 || k < dd * 2) return null;
  const tags = ['physical', 'magic', 'disable'].filter((x) => p.tags.has(x)).slice(0, 1);
  if (!tags.length) return null;
  const pool = new Set(tags.flatMap((x) => [...ANSWERS[x].core, ...ANSWERS[x].support]));
  const teamHas = team.flatMap((m) => m.items.filter((i) => pool.has(i)).map((i) => ({ hero: m.hero, item: i })));
  const sample = [...pool].slice(0, 5).map(itemInfo);
  if (teamHas.length >= 2) return null;
  return {
    id: 'team.no_answer', area: 'team', tone: 'fix', severity: 3, confidence: 'medium', tier: 'basic', shared: true,
    title: t(`Nobody had a plan for ${p.hero.en}`, `全队没有针对${p.hero.zh}的方案`),
    body: t(
      `${p.hero.en} finished ${k}/${dd}/${p.raw.assists ?? 0}. Across your five heroes, ${teamHas.length ? `only ${teamHas.map((x) => `${x.hero.en}'s ${itemInfo(x.item).en}`).join(', ')}` : 'nothing'} answered ${p.hero.en}'s ${TAG_LABELS[tags[0]].en} — the usual tools are ${names(sample, 'en')}.`,
      `${p.hero.zh}打出了 ${k}/${dd}/${p.raw.assists ?? 0}。你们五个人的终局装备里，${teamHas.length ? `只有${teamHas.map((x) => `${x.hero.zh}的${itemInfo(x.item).zh}`).join('、')}` : '没有任何一件'}能应对他的${TAG_LABELS[tags[0]].zh}——常见解法是${names(sample, 'zh')}。`,
    ),
    ask: t(
      `Next time a ${p.hero.en} snowballs: who on your team buys the first answer, and by which minute?`,
      `下次遇到滚起来的${p.hero.zh}：你们队谁买第一件针对装？最晚第几分钟？`,
    ),
    evidence: [
      { k: t(`${p.hero.en} K/D/A`, `${p.hero.zh} 战绩`), v: `${k}/${dd}/${p.raw.assists ?? 0}` },
      { k: t('Team answers found', '全队针对装'), v: String(teamHas.length) },
    ],
  };
}

function laningFinding(ctx) {
  const { me, role, opponent, deathsDetail } = ctx;
  const p = me.raw;
  if (!opponent) return null;
  // Compare like with like: net worth when both sides have it, otherwise
  // cumulative earned gold — and say which one it is.
  const useNw = Array.isArray(p.networth_t) && Array.isArray(opponent.raw.networth_t);
  const series = (x) => (useNw ? x.networth_t : x.gold_t);
  if (!Array.isArray(series(p)) || series(p).length < 11 || !Array.isArray(series(opponent.raw)) || series(opponent.raw).length < 11) return null;
  const nwMe = series(p)[10]; const nwOp = series(opponent.raw)[10];
  const metric = useNw ? t('net worth', '净资产') : t('gold earned', '累计获得金钱');
  const diff = nwMe - nwOp;
  const lhMe = p.lh_t?.[10] ?? 0; const lhOp = opponent.raw.lh_t?.[10] ?? 0;
  const dnMe = p.dn_t?.[10] ?? 0;
  const early = deathsDetail ? deathsDetail.early : 0;
  const evidence = [
    { k: t(`${useNw ? 'Net worth' : 'Gold earned'} at 10:00`, `10 分钟${metric.zh}`), v: `${fmtK(nwMe)} vs ${fmtK(nwOp)}`, sub: t(`vs ${opponent.hero.en}`, `对位 ${opponent.hero.zh}`) },
    { k: t('Last hits / denies at 10:00', '10 分钟正补 / 反补'), v: `${lhMe} / ${dnMe}`, sub: t(`${opponent.hero.en}: ${lhOp}`, `${opponent.hero.zh}：${lhOp}`) },
    ...(early ? [{ k: t('Deaths before 10:00', '10 分钟前死亡'), v: String(early) }] : []),
  ];
  const threshold = role.kind === 'core' ? 800 : 500;
  if (diff <= -threshold) {
    return {
      id: 'laning.lost', area: 'laning', tone: 'fix', severity: diff <= -2000 ? 3 : 2, confidence: 'high', tier: 'parsed',
      title: t(`Lost the lane by ${fmtK(-diff)} gold`, `对线落后 ${fmtK(-diff)} 经济`),
      body: t(
        `At 10:00 you were ${signed(diff)} ${metric.en} against ${opponent.hero.en}${early ? `, with ${early} early death${early > 1 ? 's' : ''}` : ''}. ${role.kind === 'core' ? `${lhMe} last hits vs ${lhOp}.` : 'For a support the question is whether your core got the space.'}`,
        `10 分钟时你对位${opponent.hero.zh}，${metric.zh} ${signed(diff)}${early ? `，前 10 分钟死了 ${early} 次` : ''}。${role.kind === 'core' ? `正补 ${lhMe} 对 ${lhOp}。` : '作为辅助，关键是你的核心有没有拿到发育空间。'}`,
      ),
      ask: t('At 5:00, who controlled the lane — and what changed it: a gank, a pull, a rune, a bad trade?', '5 分钟时谁掌握兵线？是什么改变了对线：一次 gank、拉野、神符，还是一次亏的换血？'),
      evidence,
    };
  }
  if (diff >= threshold) {
    return {
      id: 'laning.won', area: 'laning', tone: 'good', severity: 1, confidence: 'high', tier: 'parsed',
      title: t(`Won the lane by ${fmtK(diff)} gold`, `对线领先 ${fmtK(diff)} 经济`),
      body: t(`At 10:00 you were ${signed(diff)} ${metric.en} against ${opponent.hero.en}.`, `10 分钟时你对位${opponent.hero.zh}，${metric.zh} ${signed(diff)}。`),
      ask: t('How did you spend that lead between 10 and 20 minutes?', '10 到 20 分钟之间，你是怎么使用这份领先的？'),
      evidence,
    };
  }
  return null;
}

function turningPointFinding(ctx) {
  const { match, mine, deathsDetail } = ctx;
  const adv = match.radiant_gold_adv;
  if (!Array.isArray(adv) || adv.length < 8) return null;
  const sign = mine.radiant ? 1 : -1;
  let worst = null;
  for (let i = 0; i + 3 < adv.length; i++) {
    const swing = (adv[i + 3] - adv[i]) * sign;
    if (!worst || swing < worst.swing) worst = { from: i, to: i + 3, swing };
  }
  if (!worst || worst.swing > -3000) return null;
  const [a, b] = [worst.from * 60, worst.to * 60];
  // A team that is still ahead after its worst window did not see the game
  // "turn" (9091400302: Dire led by 28k at 34:00 and still by 23k at 37:00,
  // then won 75–34). Say what happened — a lead that slipped — and rank it
  // below a real turn.
  const leadBefore = adv[worst.from] * sign;
  const leadAfter = adv[worst.to] * sign;
  if (leadAfter > 0) return leadSlippedFinding(ctx, { a, b, swing: worst.swing, leadBefore, leadAfter });
  const enemySide = mine.radiant ? 'dire' : 'radiant';
  const objs = countedObjectives(match).filter((o) => o.time >= a && o.time <= b + 30 && objectiveTeam(o) === enemySide);
  // Unknown is not zero: only state a death count when we have death evidence.
  const myDeaths = deathsDetail ? deathsDetail.list.filter((x) => x.time >= a - 30 && x.time <= b) : null;
  const atLeast = deathsDetail && !deathsDetail.complete;
  const diedEn = myDeaths ? ` You died ${atLeast ? 'at least ' : ''}${myDeaths.length} time${myDeaths.length === 1 ? '' : 's'} in that window.` : '';
  const diedZh = myDeaths ? `这段时间你${atLeast ? '至少' : ''}死亡 ${myDeaths.length} 次。` : '';
  return {
    id: 'team.turning_point', area: 'team', tone: 'fix', severity: 2, confidence: 'high', tier: 'parsed', shared: true,
    title: t(`The game turned at ${clock(a)}–${clock(b)}`, `比赛在 ${clock(a)}–${clock(b)} 发生转折`),
    body: t(
      `Your team lost ${fmtK(-worst.swing)} gold in three minutes${objs.length ? `, and the enemy took ${objs.length} objective${objs.length > 1 ? 's' : ''}` : ''}.${diedEn}`,
      `三分钟内你们队损失 ${fmtK(-worst.swing)} 经济${objs.length ? `，对方拿下 ${objs.length} 个目标` : ''}。${diedZh}`,
    ),
    ask: t(`At ${clock(a)}, what was your team trying to do — and did all five of you know it?`, `${clock(a)} 时，你们队想做什么？五个人都知道这个计划吗？`),
    evidence: [
      { k: t('Gold swing', '经济波动'), v: signed(worst.swing) },
      { k: t('Window', '时间段'), v: `${clock(a)}–${clock(b)}` },
    ],
    window: [a, b],
  };
}

function leadSlippedFinding(ctx, { a, b, swing, leadBefore, leadAfter }) {
  const { match, mine } = ctx;
  const enemySide = mine.radiant ? 'dire' : 'radiant';
  const objs = countedObjectives(match).filter((o) => o.time >= a && o.time <= b + 30 && objectiveTeam(o) === enemySide);
  return {
    id: 'team.lead_slipped', area: 'team', tone: 'fix', severity: 1, confidence: 'high', tier: 'parsed', shared: true,
    title: t(`Your lead slipped at ${clock(a)}–${clock(b)}`, `${clock(a)}–${clock(b)} 领先被追回`),
    body: t(
      `You were ${fmtK(leadBefore)} ahead and gave back ${fmtK(-swing)} in three minutes${objs.length ? `, while the enemy took ${objs.length} objective${objs.length > 1 ? 's' : ''}` : ''}. You stayed ahead (${fmtK(leadAfter)}), but a lead that size should end games, not shrink.`,
      `你们领先 ${fmtK(leadBefore)}，三分钟内被追回 ${fmtK(-swing)}${objs.length ? `，对方还拿下 ${objs.length} 个目标` : ''}。虽然仍领先 ${fmtK(leadAfter)}，但这么大的优势应该用来结束比赛，而不是被追回。`,
    ),
    ask: t(`At ${clock(a)} you were far ahead. What stopped you from ending it — and what gave them the opening?`, `${clock(a)} 时你们大幅领先。是什么让你们没能结束比赛？又是什么给了对方机会？`),
    evidence: [
      { k: t('Lead before', '此前领先'), v: fmtK(leadBefore) },
      { k: t('Gold swing', '经济波动'), v: signed(swing) },
      { k: t('Window', '时间段'), v: `${clock(a)}–${clock(b)}` },
    ],
    window: [a, b],
  };
}

/** Dust + sentries bought by a team; null when no player has purchase data. */
export function detectionBought(team) {
  let known = false; let n = 0;
  for (const m of team) {
    if (m.raw.purchase && typeof m.raw.purchase === 'object') {
      known = true; n += (m.raw.purchase.dust ?? 0) + (m.raw.purchase.ward_sentry ?? 0);
    } else if (Array.isArray(m.raw.purchase_log)) {
      known = true; n += m.raw.purchase_log.filter((x) => x.key === 'dust' || x.key === 'ward_sentry').length;
    }
  }
  return known ? n : null;
}

function visionFinding(ctx) {
  const { me, role, durationMin, enemyProfile, team } = ctx;
  if (role.kind !== 'support' || me.raw.obs_placed == null) return null;
  const obsPer10 = (me.raw.obs_placed / durationMin) * 10;
  const senPer10 = ((me.raw.sen_placed ?? 0) / durationMin) * 10;
  const invis = enemyProfile.tags.find((x) => x.tag === 'invisibility');
  const detection = detectionBought(team);
  const evidence = [
    { k: t('Observers / 10 min', '每 10 分钟假眼'), v: obsPer10.toFixed(1) },
    { k: t('Sentries / 10 min', '每 10 分钟真眼'), v: senPer10.toFixed(1) },
    ...(invis && detection != null ? [{ k: t('Team dust + sentries bought', '全队购买粉和真眼'), v: String(detection) }] : []),
  ];
  if (invis && detection != null && detection < durationMin / 4) {
    return {
      id: 'vision.detection', area: 'vision', tone: 'fix', severity: 2, confidence: 'high', tier: 'parsed',
      title: t(`Too little detection against ${names(invis.heroes, 'en')}`, `面对${names(invis.heroes, 'zh')}，反隐太少`),
      body: t(`Your team bought ${detection} dust and sentries in ${Math.round(durationMin)} minutes against invisible heroes.`, `对面有隐身英雄，你们在 ${Math.round(durationMin)} 分钟里一共只买了 ${detection} 个粉和真眼。`),
      ask: t('Where did the invisible hero kill you from? Could one sentry there have changed it?', '隐身英雄是从哪里摸过来的？在那里放一个真眼会不会改变结果？'),
      evidence,
    };
  }
  if (obsPer10 < 1.5) {
    return {
      id: 'vision.low', area: 'vision', tone: 'fix', severity: 1, confidence: 'high', tier: 'parsed',
      title: t('Thin vision for a support', '作为辅助，视野偏少'),
      body: t(`${obsPer10.toFixed(1)} observer wards per 10 minutes.`, `每 10 分钟只插了 ${obsPer10.toFixed(1)} 个假眼。`),
      ask: t('Before your team’s biggest fight, which ward would you have wanted on the map?', '你们最大的那波团战前，你最希望地图上有哪一个眼？'),
      evidence,
    };
  }
  return null;
}

/* ---------------------------------------------------------- parsed extras */

function deathsDetailFor(match, me, mine) {
  const log = me.raw.deaths_log ?? deathsFromKillers(match, me);
  if (!Array.isArray(log) || !log.length) return null;
  // No teamfight / objective data means "unknown", never "not in a fight".
  const hasFights = Array.isArray(match.teamfights) && match.teamfights.length > 0;
  const hasObjectives = Array.isArray(match.objectives) && match.objectives.length > 0;
  const fights = hasFights ? match.teamfights.map((f) => [f.start - 5, f.end + 5]) : [];
  const enemyObjectives = countedObjectives(match).filter((o) => {
    const by = objectiveTeam(o);
    return by != null && by !== (mine.radiant ? 'radiant' : 'dire');
  });
  const list = log.map((d) => ({
    time: d.time,
    killer: d.key ? heroBySlugOrName(d.key) : null,
    in_fight: hasFights ? fights.some(([s, e]) => d.time >= s && d.time <= e) : null,
    converted: hasObjectives ? enemyObjectives.some((o) => o.time > d.time && o.time - d.time <= 90) : null,
  }));
  return {
    list,
    alone: hasFights ? list.filter((x) => x.in_fight === false).length : null,
    converted: hasObjectives ? list.filter((x) => x.converted).length : null,
    early: list.filter((x) => x.time < 600).length,
    // Reconstructed from enemy kill logs, the list can disagree with the
    // scoreboard (denies, neutrals, missing logs). Say so instead of hiding it.
    complete: list.length === (me.raw.deaths ?? list.length),
    recorded: me.raw.deaths ?? list.length,
  };
}

/** Objectives worth counting: an Aegis pickup is the same event as its Roshan kill. */
function countedObjectives(match) {
  const objs = Array.isArray(match.objectives) ? match.objectives : [];
  const hasRoshan = objs.some((o) => o.type === 'CHAT_MESSAGE_ROSHAN_KILL');
  return hasRoshan ? objs.filter((o) => o.type !== 'CHAT_MESSAGE_AEGIS') : objs;
}

/** Which side took an objective: building kills, Roshan and Aegis only. */
export function objectiveTeam(o) {
  if (o?.type === 'building_kill') {
    if (/goodguys/.test(o.key ?? '')) return 'dire';
    if (/badguys/.test(o.key ?? '')) return 'radiant';
    return null;
  }
  if (o?.type === 'CHAT_MESSAGE_ROSHAN_KILL') return o.team === 2 ? 'radiant' : o.team === 3 ? 'dire' : null;
  if (o?.type === 'CHAT_MESSAGE_AEGIS') {
    if (o.player_slot != null) return o.player_slot < 128 ? 'radiant' : 'dire';
    if (o.slot != null) return o.slot < 5 ? 'radiant' : 'dire';
  }
  return null;
}

function deathsFromKillers(match, me) {
  const target = `npc_dota_hero_${me.hero.slug}`;
  const out = [];
  for (const p of match.players ?? []) {
    for (const k of p.kills_log ?? []) if (k.key === target) out.push({ time: k.time, key: `npc_dota_hero_${heroInfo(p.hero_id).slug}` });
  }
  return out.length ? out.sort((a, b) => a.time - b.time) : null;
}

function heroBySlugOrName(key) {
  const slug = String(key).replace('npc_dota_hero_', '');
  const hit = Object.entries(NAMES.heroes).find(([, h]) => h.slug === slug);
  return hit ? Number(hit[0]) : null;
}

function itemTimeline(p) {
  if (!Array.isArray(p.purchase_log)) return null;
  const seen = new Set();
  return p.purchase_log.filter((x) => {
    const it = NAMES.items[x.key];
    if (!it || seen.has(x.key)) return false;
    const keep = it.cost >= KEY_ITEM_MIN_COST || ALWAYS_KEY_ITEMS.includes(x.key);
    if (keep) seen.add(x.key);
    return keep && !x.key.startsWith('recipe_');
  }).map((x) => ({ time: x.time, item: itemInfo(x.key) }));
}

/* ------------------------------------------------------------------ main */

/**
 * @param {object} match raw OpenDota match
 * @param {{ overrides?: Record<number, number> }} [opts] slot index -> position (1..5)
 */
export function buildCoachReport(match, opts = {}) {
  if (!match || !Array.isArray(match.players) || match.players.length !== 10) {
    throw Object.assign(new Error('match has no 10-player roster'), { code: 'INSUFFICIENT' });
  }
  const parsed = isParsed(match);
  const durationMin = Math.max(1, (match.duration ?? 0) / 60);
  const roles = inferRoles(match.players, parsed);
  for (const [slot, pos] of Object.entries(opts.overrides ?? {})) {
    const i = Number(slot);
    if (roles[i] && pos >= 1 && pos <= 5) roles[i] = { pos, kind: pos <= 3 ? 'core' : 'support', confidence: 'user', source: 'user' };
  }

  const players = match.players.map((raw, i) => {
    const hero = heroInfo(raw.hero_id);
    return {
      slot: i, raw, hero, radiant: Boolean(raw.isRadiant), items: inventory(raw),
      tags: heroTags(hero.slug, hero.roles),
      deaths: raw.deaths ?? 0,
      deathsPct: bench(raw, 'deaths_per_min')?.pct ?? null,
    };
  });

  const radiantWin = Boolean(match.radiant_win);
  const reviews = players.map((me) => {
    const role = roles[me.slot];
    const mine = { radiant: me.radiant };
    const team = players.filter((x) => x.radiant === me.radiant);
    const enemies = players.filter((x) => x.radiant !== me.radiant);
    const enemyProfile = threatProfile(enemies);
    const won = me.radiant === radiantWin;
    const opponent = laneOpponent(me, role, enemies, roles);
    const deathsDetail = parsed ? deathsDetailFor(match, me, mine) : null;
    const ctx = { match, me, role, team, enemies, enemyProfile, durationMin, won, opponent, mine, deathsDetail };
    const findings = [
      laningFinding(ctx), itemFinding(ctx), deathFinding(ctx), farmFinding(ctx), impactFinding(ctx),
      teamAnswerFinding(ctx), turningPointFinding(ctx), visionFinding(ctx),
    ].filter(Boolean).sort((a, b) => (a.tone === b.tone ? 0 : a.tone === 'fix' ? -1 : 1) || b.severity - a.severity);
    const timeline = itemTimeline(me.raw);
    const chapters = parsed ? buildChapters({
      match, me, role, players, findings, deathsDetail, heroInfo, itemInfo, itemTimeline: timeline,
      heroIdByKey: (k) => heroBySlugOrName(k),
    }) : null;
    const fixes = findings.filter((f) => f.tone === 'fix');
    const top = fixes[0];
    return {
      slot: me.slot,
      role: { ...role, label: role.pos ? POS_LABEL[role.pos] : KIND_LABEL[role.kind] },
      won,
      headline: top
        ? t(`Biggest lever: ${top.title.en.charAt(0).toLowerCase()}${top.title.en.slice(1)}.`, `最大的提升点：${top.title.zh}。`)
        : won
          ? t('A strong game by these numbers. The questions below are about doing it on purpose next time.', '从数据看这是一局好比赛。下面的问题帮你把它变成可复制的习惯。')
          : t('No single mistake stands out in the data we have — start from your deaths and the fights you lost.', '现有数据里看不出单一的明显问题——先从死亡和输掉的团战看起。'),
      threats: enemyProfile.tags.filter((x) => x.score >= 0.9).slice(0, 4)
        .map((x) => ({ tag: x.tag, label: x.label, heroes: x.heroes.map((h) => h.id), score: x.score })),
      primary_threat: enemyProfile.primary ? enemyProfile.primary.hero.id : null,
      opponent: opponent ? opponent.slot : null,
      findings,
      deaths: deathsDetail?.list ?? null,
      item_timeline: timeline,
      chapters,
    };
  });

  const gaps = dataGaps(match);

  return {
    schema: REPORT_SCHEMA,
    engine: ENGINE_VERSION,
    match: {
      id: match.match_id,
      duration: match.duration ?? 0,
      radiant_win: radiantWin,
      score: [match.radiant_score ?? 0, match.dire_score ?? 0],
      patch: PATCHES[match.patch] ?? null,
      mode: MODES[match.game_mode] ?? t('Match', '比赛'),
      ranked: match.lobby_type === 7,
      start_time: match.start_time ?? null,
      parsed,
      replay_available: Boolean(match.replay_url),
      turbo: match.game_mode === 23,
    },
    players: players.map((p) => ({
      slot: p.slot,
      radiant: p.radiant,
      hero: p.hero,
      name: p.raw.personaname ?? null,
      account_id: p.raw.account_id ?? null,
      rank_tier: p.raw.rank_tier ?? null,
      kda: [p.raw.kills ?? 0, p.raw.deaths ?? 0, p.raw.assists ?? 0],
      last_hits: p.raw.last_hits ?? 0,
      denies: p.raw.denies ?? 0,
      gpm: p.raw.gold_per_min ?? 0,
      xpm: p.raw.xp_per_min ?? 0,
      net_worth: p.raw.net_worth ?? 0,
      hero_damage: p.raw.hero_damage ?? 0,
      tower_damage: p.raw.tower_damage ?? 0,
      level: p.raw.level ?? null,
      items: p.items.map(itemInfo),
      benchmarks: p.raw.benchmarks ?? null,
    })),
    reviews,
    timeline: parsed && Array.isArray(match.radiant_gold_adv) ? { radiant_gold_adv: match.radiant_gold_adv } : null,
    data_gaps: gaps,
  };
}

function laneOpponent(me, role, enemies, roles) {
  const want = { 1: 3, 2: 2, 3: 1, 4: 5, 5: 4 }[role.pos];
  return enemies.find((e) => roles[e.slot]?.pos === want) ?? null;
}
