/**
 * Deep review chapters — the "coach walks you through the game" part of the
 * report. Pure and deterministic like analyze.js: no IO, no clock, no LLM.
 *
 * A real replay review goes phase by phase (lane → mid game → late game),
 * then audits every death, the build against what actually hurt you, and
 * every team fight, and ends with one to three things to practise next game.
 * Each chapter below follows that order, states the numbers it rests on, and
 * says how it computed them (`note`) so a reader can check the reasoning.
 *
 * Only parsed matches get chapters: without the replay timeline there is no
 * honest way to say who won the lane or what happened in a fight.
 */
import { createRequire } from 'node:module';
import { ANSWERS } from './knowledge.js';
import { storyWhy } from './why.js';
import { isBuildingKill, objectiveTeam } from './objectives.js';

const ABILITIES = createRequire(import.meta.url)('./data/abilities.json');

const t = (en, zh) => ({ en, zh });
const clock = (sec) => {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const fmtK = (n) => (Math.abs(n) >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));
const signed = (n) => `${n > 0 ? '+' : n < 0 ? '−' : '±'}${fmtK(Math.abs(n))}`;
const pctStr = (v) => `${Math.round(v * 100)}%`;
const sum = (o) => Object.values(o ?? {}).reduce((s, v) => s + (Number(v) || 0), 0);
const arr = (v) => Array.isArray(v) && v.length > 0;
const joinZh = (xs) => xs.join('、');
const joinEn = (xs) => (xs.length < 3 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/**
 * A chapter's prose in three layers, for scanning: a one-line takeaway, the
 * points (one per sentence group, en/zh aligned by index) and the joined
 * paragraph kept as `read` for API consumers.
 */
function prose(en, zh, takeaway) {
  const points = [];
  for (let i = 0; i < Math.max(en.length, zh.length); i++) {
    const a = String(en[i] ?? '').trim(); const b = String(zh[i] ?? '').trim();
    if (a || b) points.push(t(a, b));
  }
  return { read: t(en.join('').trim(), zh.join('').trim()), takeaway, points };
}

export const PHASES = [
  { key: 'early', from: 0, to: 600, label: t('Laning (0–10)', '对线期（0–10 分钟）') },
  { key: 'mid', from: 600, to: 1500, label: t('Mid game (10–25)', '中期（10–25 分钟）') },
  { key: 'late', from: 1500, to: Infinity, label: t('Late game (25+)', '后期（25 分钟后）') },
];
// Pre-horn events (negative time) belong to the laning phase.
const phaseOf = (sec) => (PHASES.find((p) => sec >= p.from && sec < p.to) ?? PHASES[0]).key;

/** A fight counts as won/lost when the gold swing between teams is clear. */
const FIGHT_EDGE = 600;
/** Lane result on lane gold at 10:00 — draw within 8%, stomp past 25%. */
const LANE_DRAW = 0.08;
const LANE_STOMP = 0.25;

/**
 * Ultimates that fire on their own: passives (flagged by the generator) and
 * Reincarnation, which triggers on death — and whose manual cast kills
 * Wraith King. "Not cast in a fight" means nothing for these.
 */
const AUTO_TRIGGERED = new Set(['skeleton_king_reincarnation']);

export function ultimateOf(heroId) {
  const u = ABILITIES.ultimates?.[String(heroId)];
  if (!u || u.passive || AUTO_TRIGGERED.has(u.key)) return null;
  // Invoke-like "ultimates" on a short cooldown are not a fight-defining spell.
  // Only long-cooldown ultimates (Ravage, Black Hole…) define a fight; a
  // 30–60s self-buff or nuke is cast too often for "held it" to mean much.
  return u && Math.max(...u.cd) >= 90 ? u : null;
}

const LANE_NAME = { 1: 'bot', 2: 'mid', 3: 'top' };
const LANE_LABEL = {
  1: t('bottom lane', '下路'), 2: t('mid lane', '中路'), 3: t('top lane', '上路'),
};

/* ------------------------------------------------------------- fights */

function fightRows(ctx) {
  const { match, me, teamSlots } = ctx;
  if (!arr(match.teamfights)) return null;
  // A teamfight without per-player rows tells us when, not who won: say
  // nothing rather than call every fight "even" with you absent.
  if (!match.teamfights.every((f) => Array.isArray(f.players) && f.players.length === ctx.players.length)) return null;
  const ult = ultimateOf(me.hero.id);
  return match.teamfights.map((f) => {
    const ps = f.players ?? [];
    let us = 0; let them = 0; let ourDeaths = 0; let theirDeaths = 0;
    ps.forEach((p, i) => {
      if (teamSlots.has(i)) { us += p.gold_delta ?? 0; ourDeaths += p.deaths ?? 0; } else { them += p.gold_delta ?? 0; theirDeaths += p.deaths ?? 0; }
    });
    const mine = ps[me.slot] ?? {};
    const present = (mine.damage ?? 0) > 0 || (mine.deaths ?? 0) > 0 || sum(mine.ability_uses) > 0
      || sum(mine.item_uses) > 0 || (mine.healing ?? 0) > 0;
    const edge = us - them;
    return {
      start: f.start,
      end: f.end,
      result: edge >= FIGHT_EDGE ? 'won' : edge <= -FIGHT_EDGE ? 'lost' : 'even',
      gold_edge: edge,
      kills: [theirDeaths, ourDeaths],
      present,
      damage: mine.damage ?? 0,
      died: (mine.deaths ?? 0) > 0,
      ult_used: ult ? (mine.ability_uses?.[ult.key] ?? 0) > 0 : null,
      ult_casts: ult ? (mine.ability_uses?.[ult.key] ?? 0) : null,
      ult_state: null,
    };
  });
}

function fightsChapter(ctx, rows) {
  const { me } = ctx;
  if (!rows || !rows.length) return null;
  const ult = ultimateOf(me.hero.id);
  const present = rows.filter((r) => r.present);
  const won = rows.filter((r) => r.result === 'won').length;
  const lost = rows.filter((r) => r.result === 'lost').length;
  const silent = present.filter((r) => r.damage === 0 && !r.died);
  let ultIn = null; let held = []; let cooling = 0; let outside = null;
  if (ult) {
    // Only fights after 10:00, when the ultimate is surely learned. A fight
    // without the ultimate is "cooling" when it was cast in a fight that
    // ended less than its longest cooldown ago — counted from that fight's
    // END, since the cast may have come at its last second. Otherwise it may
    // have been held, or spent outside any fight (untimed), and we say so.
    let lastCast = null;
    let learned = false;
    const cd = Math.max(...ult.cd);
    for (const r of rows) {
      // We only know the ultimate was learned once a cast is recorded (a
      // support can still be level 5 at 12:00): fights before that are
      // unknown, never "not cast".
      if (r.ult_used) learned = true;
      if (r.present && r.start >= 600 && learned) {
        if (r.ult_used) r.ult_state = 'used';
        else if (lastCast != null && r.start - lastCast < cd) { r.ult_state = 'cooldown'; cooling += 1; } else { r.ult_state = 'unused'; held.push(r); }
      }
      if (r.ult_used) lastCast = r.end;
    }
    ultIn = rows.filter((r) => r.ult_used).length;
    // Casts, not fights: one fight can hold two casts (refresher, low cd).
    const inFights = rows.reduce((acc, r) => acc + (r.ult_casts ?? 0), 0);
    const total = me.raw.ability_uses?.[ult.key];
    outside = Number.isFinite(total) ? Math.max(0, total - inFights) : null;
  }
  const late = rows.filter((r) => r.start >= 600 && r.present);
  const en = [
    `${rows.length} team fights; you were in ${present.length}. Your team won ${won}, lost ${lost}${rows.length - won - lost ? `, ${rows.length - won - lost} were even` : ''}.`,
    silent.length ? ` In ${silent.length} of them you were there but dealt no hero damage.` : '',
    ult ? ` ${ult.en} landed in ${ultIn} fight${ultIn === 1 ? '' : 's'}${late.length ? `; of the ${late.length} fights after 10:00 you joined, it was on cooldown in ${cooling} and not cast in ${held.length}` : ''}.` : '',
    ult && outside ? ` You cast it ${outside} more time${outside === 1 ? '' : 's'} outside recorded fights — some of those "not cast" fights may have come right after one.` : '',
  ];
  const zh = [
    `全场 ${rows.length} 波团战，你参与 ${present.length} 波；你们赢 ${won} 波、输 ${lost} 波${rows.length - won - lost ? `、均势 ${rows.length - won - lost} 波` : ''}。`,
    silent.length ? `其中 ${silent.length} 波你在场，但对英雄的伤害为 0。` : '',
    ult ? `${ult.zh}在 ${ultIn} 波团战中放出${late.length ? `；10 分钟后你参与的 ${late.length} 波里，${cooling} 波大招在冷却，${held.length} 波没有放` : ''}。` : '',
    ult && outside ? `另有 ${outside} 次大招放在团战记录之外——部分"没有放"的团战可能正好在那之后。` : '',
  ];
  return {
    rows,
    ultimate: ult ? { key: ult.key, en: ult.en, zh: ult.zh } : null,
    summary: { fights: rows.length, present: present.length, won, lost, ult_in: ultIn, ult_unused: held.length, ult_cooldown: cooling, silent: silent.length },
    ...prose(en, zh, t(
      `${rows.length} fights: won ${won}, lost ${lost}${ult ? `; ${ult.en} in ${ultIn}` : ''}`,
      `${rows.length} 波团战，赢 ${won} 输 ${lost}${ult ? `；${ult.zh}放出 ${ultIn} 波` : ''}`,
    )),
    note: t(
      `A fight is "won" when your team's gold change in it beats the enemy's by ${FIGHT_EDGE}+, "lost" the other way, else "even". "Cooldown" means a fight that cast the ultimate ended less than ${ult ? Math.max(...ult.cd) : '—'}s (the longest cooldown) earlier.`,
      `团战胜负按团战中双方经济变化之差判断：领先 ${FIGHT_EDGE} 以上为赢，落后 ${FIGHT_EDGE} 以上为输，其余为均势。"冷却"指上一次放大的那波团战结束后不足 ${ult ? Math.max(...ult.cd) : '—'} 秒（按最长冷却、从团战结束算，宁可少报"未放"）。`,
    ),
  };
}

/* ------------------------------------------------------------- deaths */

function deathsChapter(ctx, fights) {
  const { match, me, deathsDetail, heroInfo } = ctx;
  if (!deathsDetail || !deathsDetail.list.length) return null;
  const log = Array.isArray(me.raw.deaths_log) ? me.raw.deaths_log : [];
  const rows = deathsDetail.list.map((d) => {
    const raw = log.find((x) => x.time === d.time) ?? {};
    const fight = fights?.find((f) => d.time >= f.start - 5 && d.time <= f.end + 5) ?? null;
    // Fight membership comes from the recorded fight windows (d.in_fight)
    // even when per-player fight results are missing: then it is a fight
    // with an unknown result, never "caught".
    const context = fight ? (fight.result === 'won' ? 'fight_won' : fight.result === 'lost' ? 'fight_lost' : 'fight_even')
      : d.in_fight === true ? 'fight'
        : d.in_fight === null ? (d.time < 600 ? 'lane' : 'unknown')
          : d.time < 600 ? 'lane' : 'caught';
    return {
      time: d.time, killer: d.killer, phase: phaseOf(d.time), context,
      gold_lost: Number.isFinite(raw.gold_lost) ? raw.gold_lost : null,
      time_dead: Number.isFinite(raw.time_dead) ? raw.time_dead : null,
      converted: d.converted,
    };
  });
  // The last death before the throne falls has no recorded duration: prefer
  // the replay's own total time dead when it is there.
  const summed = rows.reduce((s, r) => s + (r.time_dead ?? 0), 0);
  const lifeDead = Number(me.raw.life_state_dead);
  const dead = Number.isFinite(lifeDead) && lifeDead >= summed ? lifeDead : summed;
  // No life_state_dead and no per-death duration: the time dead is unknown.
  const hasDuration = Number.isFinite(lifeDead) || rows.some((r) => r.time_dead != null);
  const goldLost = rows.reduce((s, r) => s + (r.gold_lost ?? 0), 0);
  const byKiller = new Map();
  for (const r of rows) if (r.killer != null) byKiller.set(r.killer, (byKiller.get(r.killer) ?? 0) + 1);
  const top = [...byKiller.entries()].sort((a, b) => b[1] - a[1])[0] ?? null;
  const count = (c) => rows.filter((r) => r.context === c).length;
  const byPhase = Object.fromEntries(PHASES.map((p) => [p.key, rows.filter((r) => r.phase === p.key).length]));
  const n = rows.length;
  // Reconstructed timelines can miss deaths: the scoreboard is the total,
  // the timeline is what we can analyse — say both when they differ.
  const total = deathsDetail.recorded ?? n;
  const partial = !deathsDetail.complete && total !== n;
  const topHero = top ? heroInfo(top[0]) : null;
  // "One problem repeating" is only a fair read when dying was a problem:
  // more deaths than most players of this hero (or 8+ without a benchmark).
  const diedALot = me.deathsPct != null ? me.deathsPct < 0.5 : (deathsDetail.recorded ?? n) >= 8;
  const pattern = diedALot && top && top[1] >= 3 && top[1] / n >= 0.4;
  const share = match.duration ? dead / match.duration : null;
  const en = [
    `You died ${total} times${partial ? ` (the timeline has ${n} of them; the numbers below cover those)` : ''}${dead ? ` and spent ${clock(dead)} dead${share != null ? ` (${pctStr(share)} of the game)` : ''}` : ''}${goldLost ? `, losing ${fmtK(goldLost)} gold` : ''}.`,
    pattern ? ` ${top[1]} of the ${n} ${partial ? 'recorded ' : ''}deaths were to ${topHero.en} — that is one problem repeating, not ${n} separate mistakes.` : '',
    ` By context: ${count('lane')} in lane, ${count('caught')} caught outside a fight, ${count('fight_lost')} in fights your team lost, ${count('fight_won') + count('fight_even')} in fights you won or traded evenly${count('fight') ? `, ${count('fight')} in fights whose result was not recorded` : ''}${count('unknown') ? `, ${count('unknown')} unknown` : ''}.`,
    count('fight_won') + count('fight_even') ? ' A death in a won fight is often a fair trade; the others are where the gold went.' : '',
  ];
  const zh = [
    `你死了 ${total} 次${partial ? `（时间线记录到其中 ${n} 次，以下数字只统计这 ${n} 次）` : ''}${dead ? `，共 ${clock(dead)} 不在地图上${share != null ? `（占整局 ${pctStr(share)}）` : ''}` : ''}${goldLost ? `，掉了 ${fmtK(goldLost)} 金` : ''}。`,
    pattern ? `${partial ? `记录到的 ${n} 次里` : '其中'} ${top[1]} 次死于${topHero.zh}——这不是 ${n} 个独立的失误，而是同一个问题重复出现。` : '',
    `按场景分：对线期 ${count('lane')} 次，团战外被抓 ${count('caught')} 次，输掉的团战里 ${count('fight_lost')} 次，赢下或均势的团战里 ${count('fight_won') + count('fight_even')} 次${count('fight') ? `，胜负未记录的团战里 ${count('fight')} 次` : ''}${count('unknown') ? `，无法判断 ${count('unknown')} 次` : ''}。`,
    count('fight_won') + count('fight_even') ? '赢下的团战里阵亡多半是合理交换；其余几类才是真正丢经济的地方。' : '',
  ];
  return {
    rows,
    ...prose(en, zh, pattern
      ? t(`${total} deaths — ${top[1]} of them to ${topHero.en}`, `死 ${total} 次，其中 ${top[1]} 次死于${topHero.zh}`)
      : hasDuration
        ? t(`${total} deaths, ${clock(dead)} spent dead`, `死 ${total} 次，共 ${clock(dead)} 不在地图上`)
        : t(`${total} deaths`, `死 ${total} 次`)),
    summary: {
      deaths: n, recorded: total, time_dead: hasDuration ? dead : null, share_dead: hasDuration ? share : null, gold_lost: goldLost,
      top_killer: top ? { hero: top[0], deaths: top[1] } : null,
      by_context: {
        lane: count('lane'), caught: count('caught'), fight_lost: count('fight_lost'), fight_won: count('fight_won'),
        fight_even: count('fight_even'), fight: count('fight'), unknown: count('unknown'),
      },
      by_phase: byPhase,
    },
    note: t(
      'Context: inside a recorded team fight (with that fight\'s result), before 10:00 = lane, otherwise caught. Gold lost and time dead come from the replay\'s death log.',
      '场景判定：落在团战记录时间内即为团战阵亡（附团战胜负）；10 分钟前的其余死亡算对线期；之后的算团战外被抓。掉金和死亡时长来自录像的死亡日志。',
    ),
  };
}

/* -------------------------------------------------------------- items */

/** Defensive items by role kind: a Lotus Orb is a support's answer, not a core's. */
const DEFENSE = {
  core: { physical: new Set(ANSWERS.physical.core), magic: new Set(ANSWERS.magic.core) },
  support: { physical: new Set(ANSWERS.physical.support), magic: new Set(ANSWERS.magic.support) },
};
const DMG_TYPES = ABILITIES.dmg_types ?? {};
/** Damage items whose type is stable; anything else counts as "other". */
const ITEM_DMG = {
  bfury: 'P', mjollnir: 'M', maelstrom: 'M', gungir: 'M', radiance: 'M', shivas_guard: 'M', ethereal_blade: 'M',
  dagon: 'M', dagon_2: 'M', dagon_3: 'M', dagon_4: 'M', dagon_5: 'M', urn_of_shadows: 'U', spirit_vessel: 'U',
  // blade_mail is left out on purpose: returned damage keeps the type it
  // was dealt with, which the replay does not record — it stays "other".
};
/** One damage type is "the" threat when it is at least this share of all damage taken. */
const MAIN_TYPE = 0.55;
const INITIATION = new Set(['blink', 'overwhelming_blink', 'swift_blink', 'arcane_blink', 'force_staff', 'shadow_blade', 'invis_sword', 'silver_edge']);

function itemsChapter(ctx, fights, deaths) {
  const { me, role, heroInfo, heroIdByKey, itemTimeline } = ctx;
  const p = me.raw;
  const timeline = itemTimeline;
  const taken = p.damage_taken && typeof p.damage_taken === 'object' ? p.damage_taken : null;
  if (!timeline && !taken) return null;
  const rows = (timeline ?? []).map((x) => ({
    time: x.time, item: x.item, phase: phaseOf(x.time),
    // An item can answer both (Ghost Scepter, Glimmer Cape, Eul's…).
    vs: ['physical', 'magic'].filter((kind) => DEFENSE[role.kind][kind].has(x.item.key)),
  }));

  // What actually hurt you: hero damage by source, and the damage type of
  // everything you took. Basic attacks (inflictor `null`) are physical;
  // abilities use their listed damage type; unknown items stay "other".
  let damage = null;
  if (taken) {
    const heroes = Object.entries(taken).filter(([k]) => k.startsWith('npc_dota_hero_'))
      .map(([k, v]) => ({ hero: heroIdByKey(k), amount: v })).filter((x) => x.hero != null)
      .sort((a, b) => b.amount - a.amount);
    const heroTotal = heroes.reduce((s, x) => s + x.amount, 0);
    let types = null;
    const recv = p.damage_inflictor_received;
    if (recv && typeof recv === 'object') {
      const acc = { physical: 0, magic: 0, pure: 0, other: 0 };
      for (const [k, v] of Object.entries(recv)) {
        const code = k === 'null' ? 'P' : DMG_TYPES[k] ?? ITEM_DMG[k];
        acc[code === 'P' ? 'physical' : code === 'M' ? 'magic' : code === 'U' ? 'pure' : 'other'] += Number(v) || 0;
      }
      const all = acc.physical + acc.magic + acc.pure + acc.other;
      if (all > 0) types = Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, v / all]));
    }
    damage = {
      total: heroTotal,
      types,
      by_hero: heroes.map((x) => ({ ...x, share: heroTotal ? x.amount / heroTotal : 0 })),
    };
  }

  // Defence audit reads the full purchase log (a 1350-gold Pavise counts),
  // not the display timeline; without a log we judge nothing about buys.
  const log = Array.isArray(p.purchase_log) ? p.purchase_log : null;
  const seen = new Set();
  const audit = log ? log.filter((x) => x?.key && !x.key.startsWith('recipe_') && !seen.has(x.key) && seen.add(x.key))
    .map((x) => ({ time: x.time, item: ctx.itemInfo(x.key), vs: ['physical', 'magic'].filter((kind) => DEFENSE[role.kind][kind].has(x.key)) }))
    .filter((x) => x.vs.length) : null;
  const firstBig = rows.find((r) => r.item.cost >= 2000) ?? null;
  const firstVs = (kind) => audit.find((r) => r.vs.includes(kind)) ?? null;
  const deathsBefore = (sec) => (deaths ? deaths.rows.filter((d) => d.time < sec).length : null);
  const en = []; const zh = [];
  if (firstBig) {
    en.push(`First item over 2000 gold: ${firstBig.item.en} at ${clock(firstBig.time)}.`);
    zh.push(`第一件 2000 金以上的大件：${firstBig.item.zh}（${clock(firstBig.time)}）。`);
  }
  let mismatch = null;
  if (damage && damage.total > 0 && damage.by_hero.length) {
    const top = damage.by_hero[0];
    const h = heroInfo(top.hero);
    const ty = damage.types;
    const mainKind = ty && ty.physical >= MAIN_TYPE ? 'physical' : ty && ty.magic >= MAIN_TYPE ? 'magic' : null;
    en.push(` ${fmtK(damage.total)} hero damage hit you; ${h.en} dealt ${pctStr(top.share)} of it${ty ? `. By type: ${pctStr(ty.physical)} physical, ${pctStr(ty.magic)} magical${ty.pure >= 0.05 ? `, ${pctStr(ty.pure)} pure` : ''}` : ''}.`);
    zh.push(`你一共承受 ${fmtK(damage.total)} 英雄伤害，其中${h.zh}占 ${pctStr(top.share)}${ty ? `；按类型：物理 ${pctStr(ty.physical)}、魔法 ${pctStr(ty.magic)}${ty.pure >= 0.05 ? `、纯粹 ${pctStr(ty.pure)}` : ''}` : ''}。`);
    if (mainKind && audit) {
      const answer = firstVs(mainKind);
      const other = mainKind === 'physical' ? 'magic' : 'physical';
      const wrong = audit.filter((r) => r.vs.includes(other) && !r.vs.includes(mainKind) && (!answer || r.time < answer.time));
      const label = mainKind === 'physical' ? t('physical', '物理') : t('magic', '魔法');
      if (answer) {
        const before = deathsBefore(answer.time);
        en.push(` Your first item against ${label.en} damage was ${answer.item.en} at ${clock(answer.time)}${before != null ? `, after ${before} of your deaths` : ''}.`);
        zh.push(`你的第一件防${label.zh}装备是${answer.item.zh}（${clock(answer.time)}），此时你已经死了 ${before ?? '?'} 次。`);
      } else {
        en.push(` You never bought an item against ${label.en} damage.`);
        zh.push(`你整局没有买防${label.zh}伤害的装备。`);
      }
      if (wrong.length) {
        en.push(` Before that you built ${joinEn(wrong.map((r) => r.item.en))} — defence against ${other === 'magic' ? 'magic' : 'physical'} damage, the smaller threat this game.`);
        zh.push(`在那之前你做的是${joinZh(wrong.map((r) => r.item.zh))}——防的是${other === 'magic' ? '魔法' : '物理'}，而这一局它不是主要伤害。`);
      }
      const late = !answer || (deathsBefore(answer.time) ?? 0) >= 4;
      if (late && (wrong.length || !answer)) mismatch = { kind: mainKind, type_share: ty[mainKind], top: top.hero, share: top.share, answer: answer ? { key: answer.item.key, time: answer.time } : null, before: wrong.map((r) => r.item.key) };
    }
  }

  // Initiators: when the initiation item arrived vs. the fights it missed.
  let initiation = null;
  if (me.hero.roles?.includes('Initiator') && role.kind === 'core' && rows.length) {
    const first = rows.find((r) => INITIATION.has(r.item.key));
    const before = fights ? fights.filter((f) => f.present && (!first || f.start < first.time)) : [];
    if (first) {
      initiation = { item: first.item.key, time: first.time, fights_before: before.length };
      const earlier = rows.filter((r) => r.time < first.time && r.item.cost >= 2000).map((r) => r.item);
      en.push(` Initiation item: ${first.item.en} at ${clock(first.time)}${before.length ? `, after ${before.length} fights you fought without it` : ''}${earlier.length ? ` — ${joinEn(earlier.map((i) => i.en))} came first` : ''}.`);
      zh.push(`先手装：${first.item.zh}在 ${clock(first.time)} 才到手${before.length ? `，在此之前你已经打了 ${before.length} 波没有它的团战` : ''}${earlier.length ? `——排在它前面的是${joinZh(earlier.map((i) => i.zh))}` : ''}。`);
    }
  }
  return {
    rows,
    damage,
    mismatch,
    initiation,
    // Every defensive buy from the full purchase log; null = no log, unknown.
    defence: audit ? audit.map((r) => ({ time: r.time, key: r.item.key, vs: r.vs })) : null,
    ...prose(en, zh, itemsTakeaway({ mismatch, damage, firstBig, deathsBefore, heroInfo, itemInfo: ctx.itemInfo })),
    note: t(
      `Damage type: basic attacks are physical, abilities use their listed type (all sources, creeps included). A type is the main threat at ${pctStr(MAIN_TYPE)}+. "Against physical/magic" uses the curated answer lists in knowledge.js.`,
      `伤害类型：普攻算物理，技能按其标注的伤害类型（统计全部来源，包括小兵）。某类伤害占 ${pctStr(MAIN_TYPE)} 以上即视为主要威胁。"防物理 / 防魔法"按 knowledge.js 里整理的装备清单判断。`,
    ),
  };
}

function itemsTakeaway({ mismatch, damage, firstBig, deathsBefore, heroInfo, itemInfo }) {
  if (mismatch) {
    const kind = mismatch.kind === 'physical' ? t('physical', '物理') : t('magic', '魔法');
    if (mismatch.answer) {
      const it = itemInfo(mismatch.answer.key);
      const n = deathsBefore(mismatch.answer.time);
      return t(
        `${pctStr(mismatch.type_share)} of your damage taken was ${kind.en}; first defence against it at ${clock(mismatch.answer.time)}${n != null ? `, after ${n} deaths` : ''} (${it.en})`,
        `承伤 ${pctStr(mismatch.type_share)} 是${kind.zh}，第一件防${kind.zh}装${it.zh} ${clock(mismatch.answer.time)} 才到${n != null ? `（此前已死 ${n} 次）` : ''}`,
      );
    }
    return t(`${pctStr(mismatch.type_share)} of your damage taken was ${kind.en}, and you never built against it`, `承伤 ${pctStr(mismatch.type_share)} 是${kind.zh}，整局没有防${kind.zh}装`);
  }
  if (damage?.by_hero?.length) {
    const top = damage.by_hero[0]; const h = heroInfo(top.hero);
    return t(`${h.en} dealt ${pctStr(top.share)} of the hero damage you took`, `对你伤害最高的是${h.zh}（${pctStr(top.share)}）`);
  }
  if (firstBig) return t(`First big item: ${firstBig.item.en} at ${clock(firstBig.time)}`, `第一件大件：${firstBig.item.zh}（${clock(firstBig.time)}）`);
  return t('Build', '出装');
}

/* ------------------------------------------------------------- laning */

function laningChapter(ctx, deaths) {
  const { match, me, players, heroInfo } = ctx;
  const lane = me.raw.lane;
  if (![1, 2, 3].includes(lane)) return null;
  const at = (p, key, m) => (Array.isArray(p.raw[key]) && p.raw[key].length > m ? p.raw[key][m] : null);
  if (me.raw.is_roaming) return null;
  const inLane = players.filter((x) => x.raw.lane === lane && !x.raw.is_roaming);
  const allies = inLane.filter((x) => x.radiant === me.radiant);
  const enemies = inLane.filter((x) => x.radiant !== me.radiant);
  if (!allies.length || !enemies.length) return null;
  if ([...allies, ...enemies].some((x) => at(x, 'gold_t', 10) == null)) return null;
  const row = (x) => ({
    slot: x.slot, hero: x.hero.id, ally: x.radiant === me.radiant,
    lh5: at(x, 'lh_t', 5), lh10: at(x, 'lh_t', 10), dn10: at(x, 'dn_t', 10),
    gold10: at(x, 'gold_t', 10), xp10: at(x, 'xp_t', 10),
  });
  const rows = [...allies, ...enemies].map(row);
  const us = allies.reduce((s, x) => s + at(x, 'gold_t', 10), 0);
  const them = enemies.reduce((s, x) => s + at(x, 'gold_t', 10), 0);
  const diff = (us - them) / Math.max(us, them, 1);
  const outcome = diff >= LANE_STOMP ? 'stomp' : diff >= LANE_DRAW ? 'won' : diff <= -LANE_STOMP ? 'stomped' : diff <= -LANE_DRAW ? 'lost' : 'draw';
  const OUT = {
    stomp: t('won big', '大优'), won: t('won', '优势'), draw: t('even', '均势'), lost: t('lost', '劣势'), stomped: t('lost badly', '大劣'),
  };
  // No death timeline is "unknown", not "no deaths".
  const laneDeaths = deaths ? deaths.rows.filter((d) => d.time < 600) : null;
  // Each side's tier-1 tower in this lane.
  const name = LANE_NAME[lane];
  const t1 = (side) => (match.objectives ?? []).find((o) => isBuildingKill(o) && o.key === `npc_dota_${side}_tower1_${name}`);
  const ourSide = me.radiant ? 'goodguys' : 'badguys';
  const theirSide = me.radiant ? 'badguys' : 'goodguys';
  const ourT1 = t1(ourSide); const theirT1 = t1(theirSide);
  const meRow = rows.find((r) => r.slot === me.slot);
  const vs = rows.filter((r) => !r.ally).sort((a, b) => (b.lh10 ?? 0) - (a.lh10 ?? 0))[0];
  const vsHero = heroInfo(vs.hero);
  const names = (xs, lang) => xs.map((x) => x.hero[lang]);
  const killers = (laneDeaths ?? []).map((d) => (d.killer != null ? heroInfo(d.killer) : null));
  const deathEn = (laneDeaths ?? []).map((d, i) => `${clock(d.time)}${killers[i] ? ` to ${killers[i].en}` : ''}`);
  const deathZh = (laneDeaths ?? []).map((d, i) => `${clock(d.time)}${killers[i] ? ` 被${killers[i].zh}` : ''}`);
  const en = [
    `${LANE_LABEL[lane].en}: ${joinEn(names(allies, 'en'))} vs ${joinEn(names(enemies, 'en'))}. At 10:00 the lane's gold was ${fmtK(us)} vs ${fmtK(them)} (${diff >= 0 ? '+' : '−'}${pctStr(Math.abs(diff))}) — ${OUT[outcome].en}.`,
    ` You: ${meRow.lh10}/${meRow.dn10} last hits/denies and ${meRow.xp10 != null && vs.xp10 != null ? `${signed(meRow.xp10 - vs.xp10)} XP` : ''} against ${vsHero.en} (${vs.lh10}/${vs.dn10}).`,
    laneDeaths == null ? '' : laneDeaths.length ? ` You died ${laneDeaths.length} time${laneDeaths.length > 1 ? 's' : ''} before 10:00 (${deathEn.join(', ')}); each one is roughly a wave of gold and experience you did not get.` : ' You did not die before 10:00.',
    ourT1 || theirT1 ? ` Tier-1 towers here: yours fell ${ourT1 ? `at ${clock(ourT1.time)}` : 'never'}, theirs ${theirT1 ? `at ${clock(theirT1.time)}` : 'never'}.` : '',
  ];
  const zh = [
    `${LANE_LABEL[lane].zh}：${joinZh(names(allies, 'zh'))} 对 ${joinZh(names(enemies, 'zh'))}。10 分钟时这条线双方总经济 ${fmtK(us)} 对 ${fmtK(them)}（${diff >= 0 ? '+' : '−'}${pctStr(Math.abs(diff))}），判定：${OUT[outcome].zh}。`,
    `你本人正补/反补 ${meRow.lh10}/${meRow.dn10}${meRow.xp10 != null && vs.xp10 != null ? `，经验 ${signed(meRow.xp10 - vs.xp10)}` : ''}，对位${vsHero.zh} ${vs.lh10}/${vs.dn10}。`,
    laneDeaths == null ? '' : laneDeaths.length ? `10 分钟前你死了 ${laneDeaths.length} 次（${deathZh.join('，')}），每次都意味着少拿一两波兵的经济和经验。` : '10 分钟前你没有死亡。',
    ourT1 || theirT1 ? `这条线的一塔：你们的${ourT1 ? `在 ${clock(ourT1.time)} 被推掉` : '没有丢'}，对方的${theirT1 ? `在 ${clock(theirT1.time)} 被推掉` : '没有被推'}。` : '',
  ];
  return {
    lane: LANE_NAME[lane],
    rows,
    gold: [us, them],
    diff,
    outcome,
    outcome_label: OUT[outcome],
    deaths: laneDeaths ? laneDeaths.length : null,
    towers: { ours: ourT1?.time ?? null, theirs: theirT1?.time ?? null },
    ...prose(en, zh, t(
      `${LANE_LABEL[lane].en[0].toUpperCase()}${LANE_LABEL[lane].en.slice(1)} ${OUT[outcome].en} (${diff >= 0 ? '+' : '−'}${pctStr(Math.abs(diff))} lane gold at 10:00)${laneDeaths?.length ? `, ${laneDeaths.length} death${laneDeaths.length > 1 ? 's' : ''} before 10:00` : ''}`,
      `${LANE_LABEL[lane].zh}${OUT[outcome].zh}（10 分钟经济 ${diff >= 0 ? '+' : '−'}${pctStr(Math.abs(diff))}）${laneDeaths?.length ? `，10 分钟前死 ${laneDeaths.length} 次` : ''}`,
    )),
    note: t(
      `Lane = heroes OpenDota places in the same lane. Result uses the lane's total gold at 10:00: within ${pctStr(LANE_DRAW)} is even, beyond ${pctStr(LANE_STOMP)} is a big win/loss.`,
      `同线英雄按 OpenDota 的分路判定。胜负看 10 分钟时这条线双方的总经济：差距在 ${pctStr(LANE_DRAW)} 以内为均势，超过 ${pctStr(LANE_STOMP)} 为大优 / 大劣。`,
    ),
  };
}

/* -------------------------------------------------------------- story */

function storyChapter(ctx, fights) {
  const { match, me, deathsDetail } = ctx;
  const adv = match.radiant_gold_adv;
  if (!arr(adv) || adv.length < 5) return null;
  const sign = me.radiant ? 1 : -1;
  const lead = (min) => adv[Math.min(adv.length - 1, Math.max(0, min))] * sign;
  const endMin = adv.length - 1;
  // Who took a building (OpenDota or replay events); denies count for nobody.
  const mySide = me.radiant ? 'radiant' : 'dire';
  const side = (o) => {
    if (!isBuildingKill(o)) return null;
    const by = objectiveTeam(o);
    return by == null ? null : by === mySide ? 'us' : 'them';
  };
  const objs = Array.isArray(match.objectives) ? match.objectives : [];
  // Missing timelines are unknown (null), never zero.
  const kills = Array.isArray(me.raw.kills_log) ? me.raw.kills_log : null;
  const myDeaths = deathsDetail?.list ?? null;
  const phases = PHASES.filter((p) => p.from < match.duration).map((p) => {
    const a = Math.round(p.from / 60); const b = Math.min(endMin, Math.round(Math.min(p.to, match.duration) / 60));
    const inP = (sec) => sec >= p.from && sec < p.to;
    const buildings = (who) => objs.filter((o) => inP(o.time) && side(o) === who && /tower|rax/.test(o.key ?? ''));
    const rosh = objs.filter((o) => inP(o.time) && o.type === 'CHAT_MESSAGE_ROSHAN_KILL');
    const fs = (fights ?? []).filter((f) => inP(f.start));
    return {
      key: p.key, label: p.label, from: p.from, to: Math.min(p.to, match.duration),
      lead_start: lead(a), lead_end: lead(b), swing: lead(b) - lead(a),
      buildings: [buildings('us').length, buildings('them').length],
      roshan: rosh.length,
      fights: fights ? [fs.filter((f) => f.result === 'won').length, fs.filter((f) => f.result === 'lost').length] : null,
      my_kd: [kills ? kills.filter((k) => inP(k.time)).length : null, myDeaths ? myDeaths.filter((d) => inP(d.time)).length : null],
    };
  });
  // Story beats.
  let peak = { min: 0, v: 0 }; let low = { min: 0, v: 0 };
  for (let i = 0; i <= endMin; i++) {
    if (lead(i) > peak.v) peak = { min: i, v: lead(i) };
    if (lead(i) < low.v) low = { min: i, v: lead(i) };
  }
  const won = (me.radiant === Boolean(match.radiant_win));
  const firstRax = objs.find((o) => /rax/.test(o.key ?? '') && side(o) === (won ? 'us' : 'them'));
  // No minute-10 sample (short game, truncated graph): no 10:00 claim.
  const has10 = adv.length > 10;
  const p10 = has10 ? lead(10) : 0;
  const lead10En = !has10 ? '' : Math.abs(p10) < 1000 ? 'the game was even at 10:00' : `${p10 > 0 ? 'your team' : 'the enemy'} led by ${fmtK(Math.abs(p10))} at 10:00`;
  const lead10Zh = !has10 ? '' : Math.abs(p10) < 1000 ? '10 分钟时双方经济基本持平' : `10 分钟时${p10 > 0 ? '你们' : '对方'}领先 ${fmtK(Math.abs(p10))}`;
  // Where the game was decided: the phase with the biggest swing your way
  // if you won, against you if you lost. Gold leads inflate as the game goes
  // on, so phases are compared on the lead relative to the gold both teams
  // had earned (from gold_t), not on raw numbers.
  const earned = (min) => {
    let total = 0;
    for (const x of ctx.players) {
      const g = x.raw.gold_t;
      if (!Array.isArray(g) || !g.length) return null;
      total += g[Math.min(g.length - 1, min)] ?? 0;
    }
    return total / 2;
  };
  const rel = (min) => { const e = earned(min); return e == null ? null : e > 0 ? lead(min) / e : 0; };
  for (const ph of phases) {
    const a = rel(Math.round(ph.from / 60)); const b = rel(Math.min(endMin, Math.round(ph.to / 60)));
    ph.rel_swing = a != null && b != null ? b - a : null;
  }
  // The lead as a share of what each team had earned, at each phase end:
  // the trajectory says when the game was decided without trusting raw gold.
  const traj = phases.map((ph) => ({ ph, rel: rel(Math.min(endMin, Math.round(ph.to / 60))) })).filter((x) => x.rel != null);
  const trajEn = traj.length >= 2 ? ` Relative to the gold both teams had earned: ${traj.map((x) => `${x.rel > 0 ? 'ahead' : x.rel < 0 ? 'behind' : 'even'}${x.rel ? ` ${pctStr(Math.abs(x.rel))}` : ''} at ${clock(x.ph.to)}`).join(', ')}.` : '';
  const trajZh = traj.length >= 2 ? `按占双方已获得经济的比例算：${traj.map((x) => `${clock(x.ph.to)} ${x.rel > 0 ? '领先' : x.rel < 0 ? '落后' : '持平'}${x.rel ? ` ${pctStr(Math.abs(x.rel))}` : ''}`).join('，')}。` : '';
  // Biggest relative swing against you (lost) or for you (won), and the
  // fights inside it — "where the gap was made".
  const ranked = phases.filter((ph) => ph.rel_swing != null).sort((x, y) => (won ? y.rel_swing - x.rel_swing : x.rel_swing - y.rel_swing));
  const decisive = ranked[0] && (won ? ranked[0].rel_swing > 0.05 : ranked[0].rel_swing < -0.05) ? ranked[0] : null;
  const fightsTxt = (p, lang) => (p.fights ? (lang === 'zh' ? `，团战 ${p.fights[0]} 胜 ${p.fights[1]} 负` : `, fights ${p.fights[0]}–${p.fights[1]}`) : '');
  const en = [
    has10 ? `${lead10En[0].toUpperCase()}${lead10En.slice(1)}.` : '',
    trajEn,
    decisive ? ` The biggest share of it moved in the ${decisive.label.en.replace(/ \(.*\)/, '').toLowerCase()} (${signed(decisive.swing)}${fightsTxt(decisive, 'en')}).` : '',
    peak.v >= 1000 ? ` Your team's biggest lead was ${fmtK(peak.v)} at ${peak.min}:00.` : ' Your team was never more than 1k ahead.',
    low.v <= -1000 ? ` Your biggest deficit was ${fmtK(-low.v)} at ${low.min}:00.` : '',
    firstRax ? ` ${won ? 'You' : 'They'} broke the first barracks at ${clock(firstRax.time)}; the game ended at ${clock(match.duration)}.` : ` The game ended at ${clock(match.duration)}.`,
  ];
  const zh = [
    has10 ? `${lead10Zh}。` : '',
    trajZh,
    decisive ? `变化最大的是${decisive.label.zh.replace(/（.*）/, '')}（${signed(decisive.swing)}${fightsTxt(decisive, 'zh')}）。` : '',
    peak.v >= 1000 ? `你们最多领先 ${fmtK(peak.v)}（${peak.min}:00）。` : '你们整局领先从未超过 1k。',
    low.v <= -1000 ? `最多落后 ${fmtK(-low.v)}（${low.min}:00）。` : '',
    firstRax ? `${won ? '你们' : '对方'}在 ${clock(firstRax.time)} 破了第一路兵营，比赛在 ${clock(match.duration)} 结束。` : `比赛在 ${clock(match.duration)} 结束。`,
  ];
  return {
    phases,
    peak: peak.v > 0 ? peak : null,
    low: low.v < 0 ? low : null,
    first_rax: firstRax ? { time: firstRax.time, by: won ? 'us' : 'them' } : null,
    // Where the gap came from, cause by cause (lanes at 10:00, lost fights).
    why: storyWhy({ ...ctx, ultimateKey: ultimateOf(me.hero.id)?.key ?? null }, fights),
    ...prose(en, zh, storyTakeaway(traj, match.duration, won)),
    note: t(
      'Lead = your team\'s net-worth lead from the gold graph (minute samples). Buildings count towers and barracks. Percentages are the lead over the average gold each team had earned by then; the phase that "moved most" is chosen on that share, because raw leads grow on their own late in the game. A fight\'s location comes from the death positions in it (about 10 cells either side of the river line counts as river); deaths outside fights have no position. Observers count when alive at the fight\'s start (from the place and remove logs), within about 1600 units.',
      '领先 = 经济曲线上你们队的经济差（每分钟采样）。建筑包括防御塔和兵营。百分比 = 经济差 ÷ 双方当时已获得经济的平均值；"变化最大的阶段"也按这个比例判断——后期经济总量大，绝对差距会自然变大，不能直接比。团战地点按团战中的死亡位置判断（河道两侧各约 10 格算河道）；团战之外的死亡没有位置数据。假眼按插眼和拔眼记录计算开打那一刻还活着的，范围约 1600 码。',
    ),
  };
}

function storyTakeaway(traj, duration, won) {
  const dir = (r, lang) => (r > 0 ? (lang === 'zh' ? '领先' : 'ahead') : r < 0 ? (lang === 'zh' ? '落后' : 'behind') : (lang === 'zh' ? '持平' : 'even'));
  const res = won ? t('Won', '赢下比赛') : t('Lost', '输掉比赛');
  if (traj.length < 2) return t(`${res.en} at ${clock(duration)}`, `${res.zh}（${clock(duration)}）`);
  const a = traj[0]; const b = traj[traj.length - 1];
  return t(
    `${res.en}: ${dir(a.rel, 'en')} ${pctStr(Math.abs(a.rel))} at ${clock(a.ph.to)} → ${dir(b.rel, 'en')} ${pctStr(Math.abs(b.rel))} at the end`,
    `${res.zh}：${clock(a.ph.to)} ${dir(a.rel, 'zh')} ${pctStr(Math.abs(a.rel))} → 结束时${dir(b.rel, 'zh')} ${pctStr(Math.abs(b.rel))}`,
  );
}

/* --------------------------------------------------------------- plan */

function planFrom(ctx, ch) {
  const { heroInfo, me } = ctx;
  const out = [];
  const d = ch.deaths?.summary;
  // Only when dying was a problem: more deaths than most players of the hero.
  const diedALot = me.deathsPct != null ? me.deathsPct < 0.5 : (d?.deaths ?? 0) >= 8;
  if (diedALot && d?.top_killer && d.top_killer.deaths >= 3 && d.top_killer.deaths / d.deaths >= 0.4) {
    const h = heroInfo(d.top_killer.hero);
    const goal = Math.max(1, Math.floor(d.top_killer.deaths / 2));
    out.push({
      key: 'deaths.top_killer',
      title: t(`Stop dying to ${h.en}`, `减少死于${h.zh}`),
      why: d.recorded !== d.deaths
        ? t(`${d.top_killer.deaths} of the ${d.deaths} deaths on the timeline (${d.recorded} on the scoreboard) were to ${h.en}.`, `时间线记录到的 ${d.deaths} 次死亡（记分板 ${d.recorded} 次）里有 ${d.top_killer.deaths} 次死于${h.zh}。`)
        : t(`${d.top_killer.deaths} of your ${d.deaths} deaths were to ${h.en}.`, `你 ${d.deaths} 次死亡里有 ${d.top_killer.deaths} 次死于${h.zh}。`),
      check: t(
        `Next time you face ${h.en}: before every fight, find them on the minimap, and keep their kills on you to ${goal} or fewer.`,
        `下次遇到${h.zh}：每次进团前先在小地图上确认他的位置；全场死于他的次数控制在 ${goal} 次以内。`,
      ),
    });
  }
  const f = ch.fights?.summary;
  if (f && ch.fights.ultimate && f.ult_unused >= 2) {
    const u = ch.fights.ultimate;
    out.push({
      key: 'fights.ult_unused',
      title: t(`Use ${u.en} in the fights that decide the game`, `把${u.zh}用在决定比赛的团战里`),
      why: t(`In ${f.ult_unused} fights after 10:00 you were present, ${u.en} was not on recorded cooldown and was not cast.`, `10 分钟后有 ${f.ult_unused} 波你在场的团战，${u.zh}不在已知冷却中，却没有放出来。`),
      check: t(`Before each fight, say whether ${u.en} is up; if it is, it goes out in that fight.`, `每次进团前先确认${u.zh}是否就绪；就绪就在这波团战里放出来。`),
    });
  }
  const mm = ch.items?.mismatch;
  if (mm) {
    const h = heroInfo(mm.top);
    const kind = mm.kind === 'physical' ? t('physical', '物理') : t('magic', '魔法');
    out.push({
      key: 'items.defense_order',
      title: t(`Build defence against what is killing you`, '防御装先防主要伤害来源'),
      // Two separate facts: the type split is over all sources, the top hero
      // is a hero-only ranking — never claim that hero's damage type.
      why: t(
        `Most of the damage you took was ${kind.en} (${pctStr(mm.type_share)} of all sources); the hero who hurt you most was ${h.en} (${pctStr(mm.share)} of hero damage).`,
        `你承受的伤害以${kind.zh}为主（占全部来源的 ${pctStr(mm.type_share)}）；对你伤害最高的英雄是${h.zh}（占英雄伤害的 ${pctStr(mm.share)}）。`,
      ),
      check: t(
        `At 12:00, open the scoreboard and ask which enemy hero is hurting you most. Your next defensive item answers that hero.`,
        `12 分钟时打开记分板，看哪个敌方英雄打你最疼；你的下一件防御装就针对他。`,
      ),
    });
  }
  const l = ch.laning;
  if (l && (l.outcome === 'lost' || l.outcome === 'stomped') && l.deaths >= 2) {
    out.push({
      key: 'laning.deaths',
      title: t('Survive the lane first', '对线期先活下来'),
      why: t(`The lane was ${l.outcome_label.en} and you died ${l.deaths} times before 10:00.`, `这条线${l.outcome_label.zh}，10 分钟前你死了 ${l.deaths} 次。`),
      check: t('Next game: at most 1 death before 10:00. When the enemy support disappears from the lane, step back to your tower range.', '下一局：10 分钟前死亡不超过 1 次。对面辅助从线上消失时，先退到自己塔下。'),
    });
  }
  const ini = ch.items?.initiation;
  if (ini && ini.fights_before >= 4 && out.length < 3) {
    const it = ctx.itemInfo(ini.item);
    out.push({
      key: 'items.initiation',
      title: t(`Get ${it.en} before the fights start`, `在团战开始前做出${it.zh}`),
      why: t(`${me.hero.en} fought ${ini.fights_before} fights before ${it.en} arrived at ${clock(ini.time)}.`, `${it.zh}在 ${clock(ini.time)} 才到手，此前你已经打了 ${ini.fights_before} 波团战。`),
      check: t(`Next game, plan the build so ${it.en} comes right after boots.`, `下一局规划出装，让${it.zh}紧跟在鞋子之后。`),
    });
  }
  // Fill from the headline findings so every player leaves with something to
  // practise — a winner's lead that slipped is still a habit to fix.
  for (const f of ctx.findings ?? []) {
    if (out.length >= 3) break;
    if (f.tone !== 'fix' || out.some((x) => x.key === f.id)) continue;
    out.push({ key: f.id, title: f.title, why: f.body, check: f.action });
  }
  return out.slice(0, 3);
}

/* --------------------------------------------------------------- main */

/**
 * @param {object} ctx { match, me, role, players, findings, deathsDetail, heroInfo, itemInfo, heroIdByKey, itemTimeline }
 */
export function buildChapters(ctx) {
  const teamSlots = new Set(ctx.players.filter((x) => x.radiant === ctx.me.radiant).map((x) => x.slot));
  const c = { ...ctx, teamSlots };
  const fightList = fightRows(c);
  const fights = fightsChapter(c, fightList);
  const deaths = deathsChapter(c, fightList);
  const items = itemsChapter(c, fightList, deaths);
  const laning = laningChapter(c, deaths);
  const story = storyChapter(c, fightList);
  const ch = { story, laning, deaths, items, fights };
  return { ...ch, plan: planFrom(c, ch) };
}
