/**
 * Training goals: one finding becomes a check the NEXT game can pass or fail.
 *
 *   review -> "make this my goal" -> next game -> met / missed / no chance / unknown
 *
 * Pure. `goalFor` runs inside the engine and attaches a spec to the findings
 * that have an honest, measurable next-game check; `evaluateGoal` runs on a
 * later game's report (in the browser or anywhere else) and never guesses:
 * missing data is "unknown", a game that never posed the problem is
 * "no_opportunity", never a pass.
 */

import { ANSWER_UNTIL, GAP_CLOSERS, THREAT_TAGS } from './knowledge.js';

const t = (en, zh) => ({ en, zh });

/** "7.41" <= "7.42"? Letter patches count as their base (7.41f is 7.41). */
function patchAtMost(name, limit) {
  const p = /^(\d+)\.(\d+)/.exec(String(name ?? ''));
  const l = /^(\d+)\.(\d+)/.exec(String(limit));
  if (!p || !l) return false;
  return Number(p[1]) < Number(l[1]) || (Number(p[1]) === Number(l[1]) && Number(p[2]) <= Number(l[2]));
}

/**
 * An answer item still counts in the evaluated game's patch. Unknown patch =
 * current, so a retired answer never passes a goal on a guess.
 */
function stillAnswers(item, tag, patchName) {
  const until = ANSWER_UNTIL[item]?.[tag];
  return !until || patchAtMost(patchName, until.name);
}
const r1 = (n) => Math.round(n * 10) / 10;
const GAP = new Set(GAP_CLOSERS);
const clock = (sec) => `${Math.floor(Math.max(0, sec) / 60)}:${String(Math.round(Math.max(0, sec)) % 60).padStart(2, '0')}`;

/**
 * The first gap closer a seat owned, from spikes in either shape — the
 * engine's ({ key, time }) or the report's ({ time, item: { key } }).
 */
function firstGapCloser(spike, gap = GAP) {
  const items = Array.isArray(spike?.items) ? spike.items : [];
  return items.map((x) => ({ key: x.key ?? x.item?.key, time: x.time, item: x.item ?? null }))
    .filter((x) => gap.has(x.key) && Number.isFinite(x.time))
    .sort((a, b) => a.time - b.time)[0] ?? null;
}

/**
 * Deaths to enemies who already owned a gap closer at that moment.
 * @param {{ killer: number|null, time: number }[]} deaths
 * @param {(heroId: number) => number|null} slotOfHero  enemy seat by hero id
 * @param {any[]} spikes  per seat
 */
function deathsToGapClosers(deaths, slotOfHero, spikes, gap = GAP) {
  return deaths.filter((d) => {
    if (d.killer == null) return false;
    const g = firstGapCloser(spikes[slotOfHero(d.killer)], gap);
    return Boolean(g && g.time <= d.time);
  });
}

/**
 * @param {object} f    a finding (id, tone…)
 * @param {object} ctx  { me, role, durationMin, enemyProfile, deathsDetail, missingAnswer }
 * @returns {object | null}  a goal spec, or null when the finding has no honest check
 */
export function goalFor(f, ctx) {
  if (f.tone !== 'fix') return null;
  const { me, role, durationMin } = ctx;
  switch (f.id) {
    case 'deaths.high': {
      // Parsed: when enemies with a gap closer did most of the killing, the
      // goal is about them — it carries over to any lineup that has one.
      const list = ctx.deathsDetail?.list;
      if (ctx.spikes && Array.isArray(list)) {
        const enemySlot = (heroId) => {
          const p = ctx.enemies?.find((e) => e.hero.id === heroId);
          return p ? p.slot : null;
        };
        const n0 = deathsToGapClosers(list, enemySlot, ctx.spikes).length;
        if (n0 >= 3 && n0 / list.length >= 0.4) {
          const max = Math.max(1, Math.floor(n0 / 2));
          return {
            kind: 'deaths_to_gap_closer_max', max, items: GAP_CLOSERS,
            label: t(`At most ${max} deaths to enemies who already have a Blink-type item`, `被已有跳刀类位移装的敌人击杀不超过 ${max} 次`),
          };
        }
      }
      if (!durationMin) return null;
      // A third fewer deaths per 10 minutes than this game, at most one a minute's worth.
      const rate = (me.deaths / durationMin) * 10;
      const max = Math.max(1, r1(rate * 0.67));
      return {
        kind: 'deaths_per10_max', max,
        label: t(`At most ${max} deaths per 10 minutes`, `每 10 分钟死亡不超过 ${max} 次`),
      };
    }
    case 'farm.low':
      return {
        kind: 'bench_min', key: 'gold_per_min', min: 0.4, role_kind: 'core',
        label: t('As a core: GPM above 40% of games on your hero', '打核心时：每分钟经济高于同英雄 40% 的对局'),
      };
    case 'items.answer_missing': {
      const m = ctx.missingAnswer;
      if (!m?.answers?.length) return null;
      return {
        kind: 'answer_item', tag: m.tag, items: m.answers, role_kind: role.kind,
        label: t(`When they bring ${m.label.en}: finish one answer item`, `对面有${m.label.zh}时：出一件应对装备`),
      };
    }
    case 'vision.low':
      return {
        kind: 'obs_per10_min', min: 2, role_kind: 'support',
        label: t('As a support: at least 2 observer wards per 10 minutes', '打辅助时：每 10 分钟至少 2 个假眼'),
      };
    case 'laning.lost':
      return {
        kind: 'lane_not_lost', role_kind: role.kind,
        label: t('Your lane is not behind at 10:00', '10 分钟时你这条线不落后'),
      };
    default:
      return null;
  }
}

const result = (r, evidence) => ({ result: r, evidence });

/**
 * @param {object} goal    a spec from goalFor
 * @param {object} report  buildCoachReport() output of a later game
 * @param {number} slot    the player's seat in that game
 * @returns {{ result: 'met' | 'missed' | 'no_opportunity' | 'unknown', evidence: {en: string, zh: string} }}
 */
export function evaluateGoal(goal, report, slot) {
  const player = report?.players?.[slot];
  const review = report?.reviews?.[slot];
  if (!goal || !player || !review) return result('unknown', t('No data for this seat.', '这个位置没有数据。'));
  const minutes = (report.match?.duration ?? 0) / 60;
  if (goal.role_kind && review.role?.kind !== goal.role_kind) {
    return result('no_opportunity', t(`You were not a ${goal.role_kind} this game.`, `这局你不是${goal.role_kind === 'core' ? '核心' : '辅助'}。`));
  }
  switch (goal.kind) {
    case 'deaths_per10_max': {
      if (minutes < 10) return result('no_opportunity', t('Game too short to count.', '比赛太短，不计入。'));
      const deaths = player.kda?.[1] ?? 0;
      const rate = r1((deaths / minutes) * 10);
      return result(rate <= goal.max ? 'met' : 'missed', t(`${deaths} deaths in ${Math.round(minutes)} min = ${rate} per 10 min (goal ≤ ${goal.max})`, `${Math.round(minutes)} 分钟死亡 ${deaths} 次 = 每 10 分钟 ${rate} 次（目标 ≤ ${goal.max}）`));
    }
    case 'bench_min': {
      const b = player.benchmarks?.[goal.key];
      if (!b || typeof b.pct !== 'number') return result('unknown', t('No benchmark for this game yet.', '这局还没有同英雄对比数据。'));
      const pct = Math.round(b.pct * 100);
      return result(b.pct >= goal.min ? 'met' : 'missed', t(`GPM ${Math.round(b.raw)} beats ${pct}% of games (goal ≥ ${Math.round(goal.min * 100)}%)`, `每分钟经济 ${Math.round(b.raw)}，高于 ${pct}% 的对局（目标 ≥ ${Math.round(goal.min * 100)}%）`));
    }
    case 'answer_item': {
      // The full set, not the display shortlist (pre-1.3.0 reports only have the shortlist).
      const tags = Array.isArray(review.threat_tags) ? review.threat_tags : (review.threats ?? []).map((x) => x.tag);
      if (!tags.includes(goal.tag)) return result('no_opportunity', t('The enemy did not bring this threat.', '对面没有这类威胁。'));
      const items = new Set((player.items ?? []).map((i) => i.key));
      // Same lineup rule as the engine's item check: BKB does not answer
      // disables when this game's enemies have a BKB-piercing ultimate.
      const me = report.players[slot];
      const pierced = goal.tag === 'disable' && report.players
        .some((p) => p.radiant !== me.radiant && THREAT_TAGS.piercing.includes(p.hero?.slug));
      // Answers retired by a later patch (e.g. Bloodthorn vs evasion in 7.42) do not count.
      const have = goal.items.filter((k) => items.has(k) && stillAnswers(k, goal.tag, report.match?.patch)
        && !(pierced && k === 'black_king_bar'));
      // Names from the report's own item refs, never raw keys.
      const ref = new Map((player.items ?? []).map((i) => [i.key, i]));
      const name = (k, lang) => ref.get(k)?.[lang] ?? k;
      return result(have.length ? 'met' : 'missed', have.length
        ? t(`Finished with ${have.map((k) => name(k, 'en')).join(', ')}`, `终局装备里有${have.map((k) => name(k, 'zh')).join('、')}`)
        : t('No answer item in your final build', '终局装备里没有应对装备'));
    }
    case 'obs_per10_min': {
      const obs = player.obs_placed;
      if (obs == null) return result('unknown', t('Ward data needs a parsed match.', '眼位数据需要比赛解析后才有。'));
      if (minutes < 10) return result('no_opportunity', t('Game too short to count.', '比赛太短，不计入。'));
      const rate = r1((obs / minutes) * 10);
      return result(rate >= goal.min ? 'met' : 'missed', t(`${rate} observers per 10 min (goal ≥ ${goal.min})`, `每 10 分钟 ${rate} 个假眼（目标 ≥ ${goal.min}）`));
    }
    case 'deaths_to_gap_closer_max': {
      // Judged on bounds, never on whatever happens to be in the logs:
      // `low` counts deaths proven to qualify; `high` adds every death that
      // might (missing from the timeline, or to an enemy whose purchases
      // are unknown). met only if high ≤ max, missed only if low > max.
      if (!report.match?.parsed || !Array.isArray(report.spikes)) return result('unknown', t('Needs a parsed match (purchase and death logs).', '需要比赛解析后的购买和死亡记录。'));
      // The goal's own list: a later change to GAP_CLOSERS never changes a goal already set.
      const gap = new Set(Array.isArray(goal.items) && goal.items.length ? goal.items : GAP_CLOSERS);
      const me = report.players[slot];
      const enemies = report.players.filter((p) => p.radiant !== me.radiant);
      // null spikes = no purchase log for that enemy: unknown, not "bought nothing".
      const unknownBuyers = enemies.filter((p) => !report.spikes[p.slot]);
      const owners = enemies.map((p) => ({ p, g: firstGapCloser(report.spikes[p.slot], gap) })).filter((x) => x.g);
      if (!owners.length) {
        return unknownBuyers.length
          ? result('unknown', t('Some enemies have no purchase log: cannot tell whether anyone bought a Blink-type item.', '部分敌人没有购买记录：无法判断对面是否有人出了跳刀类位移装。'))
          : result('no_opportunity', t('No enemy bought a Blink-type item this game.', '这局对面没有人出跳刀类位移装。'));
      }
      const scoreboard = Number.isFinite(me.kda?.[1]) ? me.kda[1] : null;
      const rows = review.chapters?.deaths?.rows ?? (scoreboard === 0 ? [] : null);
      if (!Array.isArray(rows) || scoreboard == null) return result('unknown', t('Needs the death log of a parsed match.', '需要比赛解析后的死亡记录。'));
      const enemySlot = (heroId) => enemies.find((p) => p.hero?.id === heroId)?.slot ?? null;
      const low = deathsToGapClosers(rows, enemySlot, report.spikes, gap).length;
      const unsure = rows.filter((d) => d.killer != null && enemySlot(d.killer) != null && !report.spikes[enemySlot(d.killer)]).length;
      const missing = Math.max(0, scoreboard - rows.length);
      const high = low + unsure + missing;
      const who = owners.slice(0, 3);
      const whoEn = who.map((x) => `${x.p.hero.en} ${x.g.item?.en ?? x.g.key} ${clock(x.g.time)}`).join(', ');
      const whoZh = who.map((x) => `${x.p.hero.zh} ${x.g.item?.zh ?? x.g.key} ${clock(x.g.time)}`).join('、');
      if (low > goal.max || high <= goal.max) {
        return result(low > goal.max ? 'missed' : 'met', t(`${low} deaths to enemies who already had one (goal ≤ ${goal.max}); theirs: ${whoEn}`, `被已有位移装的敌人击杀 ${low} 次（目标 ≤ ${goal.max}）；他们的位移装：${whoZh}`));
      }
      return result('unknown', t(`At least ${low}, at most ${high} deaths to enemies who already had one (goal ≤ ${goal.max}): ${missing ? `${missing} deaths are missing from the timeline` : 'some killers have no purchase log'}.`,
        `被已有位移装的敌人击杀至少 ${low} 次、至多 ${high} 次（目标 ≤ ${goal.max}）：${missing ? `时间线缺了 ${missing} 次死亡` : '部分击杀者没有购买记录'}，无法判定。`));
    }
    case 'lane_not_lost': {
      const lane = review.chapters?.laning;
      if (!lane) return result('unknown', t('Lane data needs a parsed match.', '对线数据需要比赛解析后才有。'));
      const lost = lane.outcome === 'lost' || lane.outcome === 'stomped';
      return result(lost ? 'missed' : 'met', t(`Lane at 10:00: ${lane.outcome_label.en}`, `10 分钟时这条线：${lane.outcome_label.zh}`));
    }
    default:
      return result('unknown', t('Unknown goal.', '无法识别的目标。'));
  }
}
