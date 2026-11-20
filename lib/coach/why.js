/**
 * "Why" for the story chapter: the gold gap split into causes, each with the
 * replay facts behind it and, when it is on you, what to do about it.
 *
 * Pure, parsed matches only. Every number comes from the match: per-lane
 * gold/last hits/XP at 10:00 and who killed whom (lanes), per-fight
 * presence, gold change, damage and ability casts (fights). Hero knowledge
 * is limited to the curated threat tags and item answers in knowledge.js —
 * no patch numbers, no power-curve folklore.
 */
import { TAG_LABELS, answersFor } from './knowledge.js';
import { fightCenter, observerWards, sideOf, wardsNear } from './geometry.js';
import { createRequire } from 'node:module';

/**
 * Valve's own ability flags for a hero (datafeed herodata, current patch):
 * damage abilities that pierce spell immunity.
 * Facts only, never a recommendation by themselves.
 */
export function abilityFacts(heroId) {
  const list = ABILITIES.heroes?.[String(heroId)];
  if (!Array.isArray(list)) return null;
  const parts = [];
  for (const a of list) {
    if (a.dmg && a.pierces === true) {
      parts.push(t(`${a.en}${a.ult ? ' (ultimate)' : ''}: ${DMG_WORD[a.dmg].en} damage, goes through spell immunity`,
        `${a.zh}${a.ult ? '（大招）' : ''}：${DMG_WORD[a.dmg].zh}伤害，无视技能免疫`));
    }
  }
  // Valve's `dispellable` describes one modifier of an ability (Reincarnation's
  // slow, not the revival), so it is never presented as a fact about the
  // whole ability.
  if (!parts.length) return null;
  return {
    line: t(`Valve ability data (${ABILITIES.patch}): ${parts.map((x) => x.en).join('; ')}`, `官方技能数据（${ABILITIES.patch}）：${parts.map((x) => x.zh).join('；')}`),
    piercingDamage: list.filter((a) => a.dmg && a.pierces === true),
  };
}

const t = (en, zh) => ({ en, zh });
const ABILITIES = createRequire(import.meta.url)('./data/abilities.json');
const DMG_WORD = { P: t('physical', '物理'), M: t('magical', '魔法'), U: t('pure', '纯粹') };


const fmtK = (n) => (Math.abs(n) >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));
const clock = (sec) => `${Math.floor(Math.max(0, sec) / 60)}:${String(Math.round(Math.max(0, sec)) % 60).padStart(2, '0')}`;
const LANES = {
  1: t('Bottom lane', '下路'),
  2: t('Mid lane', '中路'),
  3: t('Top lane', '上路'),
};
const at = (arr, i) => (Array.isArray(arr) && arr.length ? arr[Math.min(arr.length - 1, i)] : null);
/** The 10:00 sample, or null: a short or missing timeline is unknown, never its last value or zero. */
const s10 = (arr) => (Array.isArray(arr) && arr.length > 10 && Number.isFinite(arr[10]) ? arr[10] : null);
const nameList = (heroes, lang) => heroes.map((h) => h[lang]).join(lang === 'zh' ? '、' : ', ');

/**
 * The basic spell of each lane enemy that hurt you most over the game (from
 * your damage-received breakdown; abilities are named by hero, so each is
 * attributable), with its cooldown per level from Valve's data. The game-wide
 * total is said as such: it is not a laning-only number.
 */
function laneSpells(me, enemies) {
  const recv = me.raw.damage_inflictor_received;
  if (!recv || typeof recv !== 'object') return [];
  const out = [];
  for (const e of enemies) {
    const list = ABILITIES.heroes?.[String(e.hero.id)];
    if (!Array.isArray(list)) continue;
    // Their most damaging basic spell; named only when its use opens a window
    // (trade_cd, see scripts/coach-abilities.mjs). Otherwise this hero is not
    // named at all — never a weaker spell in its place.
    const best = list.filter((a) => !a.ult && a.dmg && Number(recv[a.id]) > 0)
      .sort((a, b) => Number(recv[b.id]) - Number(recv[a.id]))[0];
    if (best && Array.isArray(best.trade_cd)) out.push({ hero: e.hero, spell: { ...best, cd: best.trade_cd }, amount: Number(recv[best.id]) });
  }
  return out;
}
const spellLine = (xs, lang) => xs.map((x) => (lang === 'zh'
  ? `${x.hero.zh}的${x.spell.zh}（冷却 ${x.spell.cd.join('/')} 秒）`
  : `${x.hero.en}'s ${x.spell.en} (cooldown ${x.spell.cd.join('/')}s)`)).join(lang === 'zh' ? '、' : ', ');

/** Lane gold at 10:00, lane by lane: where the early gap came from. */
function laneCauses(ctx) {
  const { players, me, heroInfo } = ctx;
  const ok = players.every((p) => s10(p.raw.gold_t) != null && [1, 2, 3, 4, 5].includes(p.raw.lane));
  if (!ok) return [];
  const ours = (p) => p.radiant === me.radiant;
  const killsBy = new Map(); // victim hero key -> [{ time, killer }]
  for (const p of players) {
    for (const k of p.raw.kills_log ?? []) {
      if (k.time >= 600) continue;
      const list = killsBy.get(k.key) ?? [];
      list.push({ time: k.time, killer: p });
      killsBy.set(k.key, list);
    }
  }
  const heroKey = (p) => `npc_dota_hero_${p.hero.slug}`;
  const out = [];
  for (const lane of [1, 2, 3]) {
    // Roamers earned their gold elsewhere: like the laning chapter, they are not part of a lane.
    const inLane = (p) => p.raw.lane === lane && !p.raw.is_roaming;
    const us = players.filter((p) => ours(p) && inLane(p));
    const them = players.filter((p) => !ours(p) && inLane(p));
    if (!us.length || !them.length) continue;
    const g = (xs) => xs.reduce((s, p) => s + s10(p.raw.gold_t), 0);
    const diff = g(us) - g(them);
    if (Math.abs(diff) < 500) continue;
    // Deaths of our laners before 10:00, and which came from another lane.
    const deaths = us.flatMap((p) => (killsBy.get(heroKey(p)) ?? []).map((d) => ({ ...d, victim: p })));
    const rotated = (d) => d.killer.raw.lane !== lane || Boolean(d.killer.raw.is_roaming);
    const rotations = deaths.filter(rotated);
    // Last hits / XP only when every laner has a 10:00 sample; otherwise the comparison is omitted.
    const sum10 = (xs, key) => (xs.every((p) => s10(p.raw[key]) != null) ? xs.reduce((s, p) => s + s10(p.raw[key]), 0) : null);
    const lhKnown = sum10(us, 'lh_t') != null && sum10(them, 'lh_t') != null;
    const xpUs = sum10(us, 'xp_t'); const xpThem = sum10(them, 'xp_t');
    const xpDiff = xpUs != null && xpThem != null ? xpUs - xpThem : null;
    const mine = us.includes(me);
    const heroesUs = us.map((p) => p.hero);
    const heroesThem = them.map((p) => p.hero);
    const evidence = [
      t(`Gold at 10:00: ${fmtK(g(us))} vs ${fmtK(g(them))} (${diff > 0 ? '+' : '−'}${fmtK(Math.abs(diff))})`, `10 分钟经济：${fmtK(g(us))} 对 ${fmtK(g(them))}（${diff > 0 ? '+' : '−'}${fmtK(Math.abs(diff))}）`),
      ...(lhKnown ? [t(`Last hits: ${us.map((p) => `${p.hero.en} ${s10(p.raw.lh_t)}`).join(', ')} vs ${them.map((p) => `${p.hero.en} ${s10(p.raw.lh_t)}`).join(', ')}`,
        `正补：${us.map((p) => `${p.hero.zh} ${s10(p.raw.lh_t)}`).join('、')} 对 ${them.map((p) => `${p.hero.zh} ${s10(p.raw.lh_t)}`).join('、')}`)] : []),
      ...(xpDiff != null && Math.abs(xpDiff) >= 500 ? [t(`XP: ${xpDiff > 0 ? '+' : '−'}${fmtK(Math.abs(xpDiff))}`, `经验：${xpDiff > 0 ? '+' : '−'}${fmtK(Math.abs(xpDiff))}`)] : []),
      ...(deaths.length ? [t(
        `Deaths before 10:00: ${deaths.sort((a, b) => a.time - b.time).map((d) => `${d.victim.hero.en} ${clock(d.time)} by ${d.killer.hero.en}${rotated(d) ? ' (rotation)' : ''}`).join('; ')}`,
        `10 分钟前阵亡：${deaths.map((d) => `${d.victim.hero.zh} ${clock(d.time)} 死于${d.killer.hero.zh}${rotated(d) ? '（游走）' : ''}`).join('；')}`,
      )] : []),
    ];
    // What to do: only when it is your lane, and only from what the numbers show.
    let fix = null;
    if (mine && diff < 0) {
      const myDeaths = deaths.filter((d) => d.victim === me);
      const rot = myDeaths.filter(rotated);
      const myLh = lhKnown ? s10(me.raw.lh_t) : null;
      const theirCore = lhKnown ? them.reduce((best, p) => (s10(p.raw.lh_t) > s10(best.raw.lh_t) ? p : best), them[0]) : null;
      const theirLh = theirCore ? s10(theirCore.raw.lh_t) : null;
      if (myDeaths.length >= 2) {
        fix = rot.length
          ? t(`You died ${myDeaths.length} times before 10:00, ${rot.length} to ${nameList([...new Set(rot.map((d) => d.killer.hero))], 'en')} coming from another lane: when they leave the map, step back to your tower until they show up again, and ask for a ward on their path.`,
            `你 10 分钟前死了 ${myDeaths.length} 次，其中 ${rot.length} 次是${nameList([...new Set(rot.map((d) => d.killer.hero))], 'zh')}从别的线游走过来：他们从小地图上消失时，先退到塔下，等他们重新出现；让队友在他们来的路上插眼。`)
          : (() => {
            const killers = [...new Set(myDeaths.map((d) => d.killer))];
            const spells = laneSpells(me, killers);
            if (spells.length) {
              evidence.push(t(
                `Their basic spell that hurt you most this game: ${spells.map((x) => `${x.hero.en}'s ${x.spell.en} ${fmtK(x.amount)}`).join(', ')} (cooldowns: Valve data, ${ABILITIES.patch})`,
                `整局对你伤害最高的小技能：${spells.map((x) => `${x.hero.zh}的${x.spell.zh} ${fmtK(x.amount)}`).join('、')}（冷却取自官方 ${ABILITIES.patch} 数据）`,
              ));
            }
            const when = spells.length
              ? t(`step up to trade or last-hit right after ${spellLine(spells, 'en')} is used, and back off before it comes back`,
                `等${spellLine(spells, 'zh')}放出来之后再上前补刀、换血，转好之前退回来`)
              : t('trade only when their key spell is on cooldown', '只在对方关键技能冷却时换血');
            return t(`You died ${myDeaths.length} times before 10:00 to ${nameList(killers.map((k) => k.hero), 'en')} in your own lane: ${when.en}; keep the wave on your side of the river until your level matches theirs.`,
              `你 10 分钟前在自己线上被${nameList(killers.map((k) => k.hero), 'zh')}杀了 ${myDeaths.length} 次：${when.zh}；等级追上之前，把兵线留在河道你们这一侧。`);
          })();
      } else if (ctx.role.kind === 'core' && myLh != null && theirLh - myLh >= 8) {
        fix = t(`${myLh} last hits to ${theirCore.hero.en}'s ${theirLh} by 10:00: keep the wave just in front of your tower (pull or don't push), and spend the first minutes on last hits instead of harass.`,
          `10 分钟正补 ${myLh} 对${theirCore.hero.zh}的 ${theirLh}：把兵线控在自己塔前（拉野或者不推线），前几分钟专心补刀，少去消耗。`);
      } else if (xpDiff != null && xpDiff <= -800) {
        fix = t(`${fmtK(-xpDiff)} XP behind in this lane by 10:00: stay in XP range of every wave even when you cannot last-hit, and pick fights only after your level catches up.`,
          `这条线 10 分钟经验落后 ${fmtK(-xpDiff)}：补不到刀也要站在兵线的经验范围内；等级追上之前不要主动打架。`);
      }
    }
    out.push({
      id: `lane.${lane}`, phase: 'early', mine, impact: diff,
      title: diff < 0
        ? t(`${LANES[lane].en}: ${nameList(heroesThem, 'en')} beat ${nameList(heroesUs, 'en')}, ${fmtK(-diff)} gold by 10:00`, `${LANES[lane].zh}：${nameList(heroesThem, 'zh')}压过${nameList(heroesUs, 'zh')}，10 分钟经济差 ${fmtK(-diff)}`)
        : t(`${LANES[lane].en}: ${nameList(heroesUs, 'en')} won, ${fmtK(diff)} gold by 10:00`, `${LANES[lane].zh}：${nameList(heroesUs, 'zh')}赢了，10 分钟经济领先 ${fmtK(diff)}`),
      evidence, fix,
      rotations: rotations.length,
    });
  }
  // The lanes that lost most come first when behind; best first when ahead.
  const total = out.reduce((s, c) => s + c.impact, 0);
  return out.sort((a, b) => (total < 0 ? a.impact - b.impact : b.impact - a.impact));
}

const WHERE = {
  own: t('in your half', '在你们半场'),
  river: t('at the river', '在河道'),
  enemy: t('in their half', '在对方半场'),
};

/** Where a set of fights happened, from their death positions; nothing when unknown. */
function whereLine(xs) {
  const known = xs.filter((x) => x.where);
  if (known.length < Math.max(2, Math.ceil(xs.length / 2))) return [];
  const c = (w) => known.filter((x) => x.where === w).length;
  return [t(`Where: ${c('own')} in your half, ${c('river')} at the river, ${c('enemy')} in their half (from fight death positions)`,
    `地点：${c('own')} 波在你们半场、${c('river')} 波在河道、${c('enemy')} 波在对方半场（按团战死亡位置）`)];
}

/** First purchase time of an item, from the parsed purchase log. */
function boughtAt(raw, key) {
  const log = Array.isArray(raw.purchase_log) ? raw.purchase_log : [];
  const hit = log.find((x) => x.key === key);
  return hit ? hit.time : null;
}

/**
 * What to do about the hero who carried their fights: if you already own an
 * answer, the lesson is its timing (fights lost before you had it); if not,
 * which answers fit your role.
 */
function carrierFix({ ctx, carrier, tag, answers, kind, lost, iName }) {
  const head = t(`Fights are about ${carrier.hero.en}: disable or focus them first`, `团战的核心是${carrier.hero.zh}：先控或先集火他`);
  if (!tag || !answers.length) return t(`${head.en}.`, `${head.zh}。`);
  // Timing from the full purchase log (sold or upgraded answers count);
  // final ownership only decides the "use it" advice.
  const own = answers.filter((k) => ctx.me.items.includes(k));
  const timed = answers.map((k) => ({ k, at: boughtAt(ctx.me.raw, k) })).filter((x) => x.at != null).sort((a, b) => a.at - b.at)[0];
  if (own.length || timed) {
    if (timed) {
      const before = lost.filter((x) => x.f.start < timed.at).length;
      if (before >= 2) {
        return t(`${head.en}. You did build ${iName(timed.k, 'en')}, but at ${clock(timed.at)}, after ${before} of these fights were already lost: next time have it before the first big fight.`,
          `${head.zh}。你出了${iName(timed.k, 'zh')}，但在 ${clock(timed.at)} 才做出，此前已经输了 ${before} 波：下一局在第一波大团之前做出来。`);
      }
    }
    if (timed) {
      return t(`${head.en}. You had ${iName(timed.k, 'en')} from ${clock(timed.at)}: use it the moment ${carrier.hero.en} engages, not after.`,
        `${head.zh}。你在 ${clock(timed.at)} 就有了${iName(timed.k, 'zh')}：在${carrier.hero.zh}冲上来的那一刻用，不要等挨打之后。`);
    }
    const had = own;
    return t(`${head.en}. You had ${had.map((k) => iName(k, 'en')).join(', ')}: use it on ${carrier.hero.en}'s engage, not after.`,
      `${head.zh}。你已经有${had.map((k) => iName(k, 'zh')).join('、')}：在${carrier.hero.zh}冲上来的那一刻用，不要等挨打之后。`);
  }
  const pick = answers.slice(0, 3).map((k) => iName(k, 'en')).join(', ');
  const pickZh = answers.slice(0, 3).map((k) => iName(k, 'zh')).join('、');
  return t(`${head.en}, and as a ${kind} build one of ${pick} before the next big fight.`,
    `${head.zh}；你作为${kind === 'core' ? '核心' : '辅助'}，在下一波大团前做出 ${pickZh} 之一。`);
}

/** You built BKB, but the hero beating you deals damage that goes through it (official data). */
function withBkbNote(fix, ctx, carrier, facts, iName) {
  if (!fix || !facts?.piercingDamage.length || !ctx.me.items.includes('black_king_bar')) return fix;
  const names = (lang) => facts.piercingDamage.map((a) => a[lang]).join(lang === 'zh' ? '、' : ', ');
  return t(`${fix.en} Your ${iName('black_king_bar', 'en')} does not stop ${carrier.hero.en}'s ${names('en')}.`,
    `${fix.zh}你的${iName('black_king_bar', 'zh')}挡不住${carrier.hero.zh}的${names('zh')}。`);
}

/** Lost team fights: numbers, the gold you fought from, who beat you, your ultimate. */
function fightCauses(ctx, fights) {
  const { match, players, me } = ctx;
  if (!Array.isArray(fights) || !Array.isArray(match.teamfights)) return [];
  const ours = new Set(players.filter((p) => p.radiant === me.radiant).map((p) => p.slot));
  // Same participation rule as the fights chapter (healing counts).
  const present = (row) => (row?.damage ?? 0) > 0 || (row?.deaths ?? 0) > 0 || (row?.healing ?? 0) > 0
    || Object.values(row?.ability_uses ?? {}).some((n) => n > 0) || Object.values(row?.item_uses ?? {}).some((n) => n > 0);
  // Team lead from the gold graph (one consistent team metric); no graph, no deficit claim.
  const adv = Array.isArray(match.radiant_gold_adv) ? match.radiant_gold_adv : null;
  const leadAt = (min) => (adv && min < adv.length && Number.isFinite(adv[min]) ? adv[min] * (me.radiant ? 1 : -1) : null);
  const lost = [];
  const wards = observerWards(players);
  fights.forEach((f, i) => {
    if (f.result !== 'lost' || f.start < 600) return;
    const raw = match.teamfights[i];
    if (!raw || !Array.isArray(raw.players)) return;
    const usIn = players.filter((p) => ours.has(p.slot) && present(raw.players[p.slot]));
    const themIn = players.filter((p) => !ours.has(p.slot) && present(raw.players[p.slot]));
    const absent = players.filter((p) => ours.has(p.slot) && !present(raw.players[p.slot]));
    const min = Math.floor(f.start / 60);
    const top = players.filter((p) => !ours.has(p.slot))
      .reduce((best, p) => ((raw.players[p.slot]?.damage ?? 0) > (raw.players[best.slot]?.damage ?? 0) ? p : best), players.find((p) => !ours.has(p.slot)));
    const center = fightCenter(raw);
    const where = center ? sideOf(center, me.radiant) : null;
    const vis = center && wards ? { us: wardsNear(wards, me.radiant, f.start, center), them: wardsNear(wards, !me.radiant, f.start, center) } : null;
    lost.push({ f, usIn, themIn, absent, nwDiff: leadAt(min), top, where, vis });
  });
  if (lost.length < 2) return [];
  const out = [];
  const n = lost.length;

  // 1. Fewer heroes than them.
  const outnumbered = lost.filter((x) => x.usIn.length < x.themIn.length);
  if (outnumbered.length >= 2 || (outnumbered.length && outnumbered.length / n >= 0.3)) {
    const missing = new Map();
    for (const x of outnumbered) for (const p of x.absent) missing.set(p, (missing.get(p) ?? 0) + 1);
    const meMissing = missing.get(me) ?? 0;
    out.push({
      id: 'fights.outnumbered', phase: 'mid', mine: meMissing > 0, impact: -outnumbered.length * 1000,
      title: t(`${outnumbered.length} of ${n} lost fights were taken a hero short`, `${n} 波输掉的团战里，${outnumbered.length} 波是少打多`),
      evidence: outnumbered.map((x) => t(
        `${clock(x.f.start)}: ${x.usIn.length}v${x.themIn.length}${x.absent.length ? `, missing ${nameList(x.absent.map((p) => p.hero), 'en')}` : ''}`,
        `${clock(x.f.start)}：${x.usIn.length} 打 ${x.themIn.length}${x.absent.length ? `，缺${nameList(x.absent.map((p) => p.hero), 'zh')}` : ''}`,
      )),
      fix: meMissing
        ? t(`You were missing from ${meMissing} of them: after 15:00, farm within one TP of your team, and keep a TP scroll so you can join the moment a fight starts.`,
          `其中 ${meMissing} 波缺的是你：15 分钟以后，在离队友一个 TP 能赶到的范围内发育，身上常备回城卷轴，开团就能立刻赶到。`)
        : t('When a teammate is missing, back off to a tower and wait for them instead of taking the fight.',
          '有队友不在时，先退到塔下等人到齐，不要接团。'),
    });
  }

  // 2. Fights taken from a big gold deficit.
  const behind = lost.filter((x) => x.nwDiff != null && x.nwDiff <= -5000);
  if (behind.length >= 2) {
    const avg = Math.round(behind.reduce((s, x) => s + x.nwDiff, 0) / behind.length);
    const evenFights = behind.filter((x) => x.usIn.length >= x.themIn.length).length;
    out.push({
      id: 'fights.behind', phase: 'mid', mine: true, impact: avg,
      title: t(`${behind.length} lost fights started ${fmtK(-avg)} behind on average`, `${behind.length} 波输掉的团战，开打时平均落后 ${fmtK(-avg)} 经济`),
      evidence: [
        t(`${evenFights} of them were even or more on numbers: you lost on items and levels, not on heroes present.`, `其中 ${evenFights} 波人数不少于对方——输在装备和等级，而不是人数。`),
        ...behind.slice(0, 4).map((x) => t(`${clock(x.f.start)}: ${fmtK(-x.nwDiff)} behind, ${x.usIn.length}v${x.themIn.length}${x.where ? `, ${WHERE[x.where].en}` : ''}`, `${clock(x.f.start)}：落后 ${fmtK(-x.nwDiff)}，${x.usIn.length} 打 ${x.themIn.length}${x.where ? `，${WHERE[x.where].zh}` : ''}`)),
        ...whereLine(behind),
      ],
      fix: t('When you are 5k+ behind, do not take open 5v5 fights: defend under towers, push the side lanes that are far from them, and fight only when they commit into your vision or your cores finish their next item.',
        '落后 5k 以上时，不要在野外接 5 打 5：在塔下防守，带离他们远的边线，只在他们走进你们视野强行开团、或你们核心做出下一件关键装备时再打。'),
    });
  }

  // 2b. Positioning: lost fights taken deep in their half while far behind.
  const deep = lost.filter((x) => x.where === 'enemy' && x.nwDiff != null && x.nwDiff <= -5000);
  if (deep.length >= 2) {
    out.push({
      id: 'position.deep', phase: 'mid', mine: true, impact: -deep.length * 900,
      title: t(`${deep.length} lost fights were in their half while you were 5k+ behind`, `${deep.length} 波输掉的团战，是落后 5k 以上时在对方半场打的`),
      evidence: deep.map((x) => t(`${clock(x.f.start)}: ${fmtK(-x.nwDiff)} behind, ${x.usIn.length}v${x.themIn.length}${x.vis ? `, observers nearby ${x.vis.us}–${x.vis.them}` : ''}`,
        `${clock(x.f.start)}：落后 ${fmtK(-x.nwDiff)}，${x.usIn.length} 打 ${x.themIn.length}${x.vis ? `，附近假眼 我方 ${x.vis.us} / 对方 ${x.vis.them}` : ''}`)),
      fix: t('Behind, the fights you can win are near your towers, where they must walk into you. Do not cross the river as a group unless your cores just finished an item and you have vision there.',
        '落后时能赢的团战在自己塔附近，让对方走过来打你们。除非核心刚做出关键装备、而且那边有你们的视野，否则不要成群过河。'),
    });
  }

  // 2c. Vision: lost fights where they could see the area and you could not.
  const blind = lost.filter((x) => x.vis && x.vis.them >= 1 && x.vis.us === 0);
  // A pattern, not an anecdote: at least a third of the lost fights.
  if (blind.length >= 2 && blind.length * 3 >= n) {
    const support = ctx.role.kind === 'support';
    out.push({
      id: 'vision.blind', phase: 'mid', mine: support, impact: -blind.length * 700,
      title: t(`${blind.length} lost fights: they had observers there, you had none`, `${blind.length} 波输掉的团战：对方在团战位置有假眼，你们一个都没有`),
      evidence: blind.map((x) => t(`${clock(x.f.start)}${x.where ? ` (${WHERE[x.where].en})` : ''}: observers within ~1600 units — yours ${x.vis.us}, theirs ${x.vis.them}`,
        `${clock(x.f.start)}${x.where ? `（${WHERE[x.where].zh}）` : ''}：团战位置约 1600 码内的假眼——我方 ${x.vis.us}，对方 ${x.vis.them}`)),
      fix: support
        ? t('Before your team moves to an objective or a fight area, place an observer there first; after a fight, replace the wards they cleared.',
          '队伍去推塔、打肉或去某个区域之前，先在那里插一个假眼；打完一波团战，把被拆掉的眼补上。')
        : t('Do not be the first into an area your team cannot see; wait for a ward or a smoke.',
          '你们看不到的区域，不要第一个走进去；等假眼或者开雾再进。'),
    });
  }

  // 3. The enemy hero who did the most damage in your lost fights.
  const byTop = new Map();
  for (const x of lost) byTop.set(x.top, (byTop.get(x.top) ?? 0) + 1);
  const [carrier, times] = [...byTop.entries()].sort((a, b) => b[1] - a[1])[0];
  if (times >= Math.max(2, Math.ceil(n / 2))) {
    const tags = [...(carrier.tags ?? [])].filter((x) => TAG_LABELS[x] && x !== 'piercing');
    const tag = tags[0] ?? null;
    const kind = ctx.role.kind;
    // Same exception as the item finding: BKB does not stop a BKB-piercing disabler.
    const pierced = tag === 'disable' && carrier.tags?.has?.('piercing');
    const valid = (k) => !(pierced && k === 'black_king_bar');
    const answers = tag ? answersFor(tag, kind, match.patch).filter(valid) : [];
    const pool = tag ? new Set([...answersFor(tag, 'core', match.patch), ...answersFor(tag, 'support', match.patch)].filter(valid)) : new Set();
    const teamHas = players.filter((p) => ours.has(p.slot)).flatMap((p) => p.items.filter((i) => pool.has(i)).map((i) => ({ p, i })));
    const iName = (k, lang) => ctx.itemInfo(k)[lang];
    const facts = abilityFacts(carrier.hero.id);
    out.push({
      id: 'fights.carrier', phase: 'mid', mine: false, impact: -times * 800,
      title: t(`${carrier.hero.en} did the most damage in ${times} of ${n} lost fights`, `${n} 波输掉的团战里，${times} 波伤害最高的是${carrier.hero.zh}`),
      evidence: [
        ...(tag ? [t(`${carrier.hero.en}: ${TAG_LABELS[tag].en}`, `${carrier.hero.zh}：${TAG_LABELS[tag].zh}`)] : []),
        ...(facts ? [facts.line] : []),
        ...(tag ? [t(
          teamHas.length ? `Your team's answers by the end: ${teamHas.map((x) => `${x.p.hero.en} ${iName(x.i, 'en')}`).join(', ')}` : `Your team finished with no item that answers ${TAG_LABELS[tag].en}`,
          teamHas.length ? `你们终局装备里的应对：${teamHas.map((x) => `${x.p.hero.zh}的${iName(x.i, 'zh')}`).join('、')}` : `你们五个人的终局装备里，没有应对${TAG_LABELS[tag].zh}的装备`,
        )] : []),
      ],
      fix: withBkbNote(carrierFix({ ctx, carrier, tag, answers, kind, lost, iName }), ctx, carrier, facts, iName),
    });
  }

  // 4. Your ultimate, in the lost fights you were in.
  const mineRows = lost.map((x) => x.f).filter((f) => f.present && f.ult_state);
  const unused = mineRows.filter((f) => f.ult_state === 'unused');
  // Casts outside recorded fights may have put it on cooldown: only claim
  // "not cast, not on cooldown" when every cast is inside a recorded fight.
  const ultKey = ctx.ultimateKey;
  const total = ultKey ? ctx.me.raw.ability_uses?.[ultKey] : null;
  const inFights = fights.reduce((acc, r) => acc + (r.ult_casts ?? 0), 0);
  const allInFights = Number.isFinite(total) && total - inFights <= 0;
  if (unused.length >= 2 && allInFights) {
    out.push({
      id: 'fights.my_ult', phase: 'mid', mine: true, impact: -unused.length * 700,
      title: t(`Your ultimate was not cast in ${unused.length} lost fights you were in`, `你在场的输掉的团战里，有 ${unused.length} 波没放大招`),
      evidence: [t(`Not cast (and not on cooldown): ${unused.map((f) => clock(f.start)).join(', ')}`, `没放（且不在冷却）：${unused.map((f) => clock(f.start)).join('、')}`)],
      fix: t('Decide before the fight who your ultimate is for; if the fight starts without it, cast it on the first enemy that commits rather than saving it.',
        '开团前先想好大招给谁；团战已经开打还没放，就放在第一个冲上来的敌人身上，不要一直留着。'),
    });
  }
  return out;
}

/**
 * @param {object} ctx     chapters ctx (match, me, role, players, heroInfo, itemInfo)
 * @param {object[]} fights fightRows() output
 * @returns {object[] | null}  causes, biggest first; null when the match is not parsed enough
 */
export function storyWhy(ctx, fights) {
  const lanes = laneCauses(ctx);
  const fightsC = fightCauses(ctx, fights);
  const all = [...lanes.slice(0, 3), ...fightsC];
  return all.length ? all : null;
}
