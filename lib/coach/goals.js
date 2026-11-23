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

/**
 * Habits a replay can count, and the next-game check made from one
 * (kind 'replay_habit'; kept in this file so goals.js still imports only knowledge.js).
 *
 * A replay review ends each finding in a rule ("below half health with an
 * enemy in front of you: back off"). A rule is only worth giving if the next
 * game can show whether it was followed, so a rule may name the count it is
 * about — one of the lists death_context keeps over a hero's deaths
 * (deaths_where). The same count, taken from the next game's replay, is the
 * check: no model, no reading of prose.
 *
 * Pure and browser-safe (the page judges a later game with it). Never a pass
 * on a guess: without that game's replay the result is "unknown", and a
 * death whose health or position was not sampled can only make it "unknown".
 */

/** `list`: the deaths_where list; `unsure`: the deaths_not_known count that could add to it. */
export const HABITS = {
  low_health: { list: 'health_below_half_at_window_start', unsure: 'health_at_window_start', label: t('deaths that began below half health (12 s before)', '死前 12 秒已不到半血的阵亡') },
  alone: { list: 'no_ally_within_2200_at_death', unsure: 'allies_at_death', label: t('deaths with no ally within 2200', '身边 2200 码内没有队友的阵亡') },
  outnumbered: { list: 'three_or_more_enemy_heroes_dealing_damage', unsure: null, label: t('deaths to three or more enemy heroes', '被三个以上敌方英雄围杀的阵亡') },
  nothing_pressed: { list: 'nothing_cast_and_no_item_used', unsure: null, label: t('deaths with nothing cast or used', '什么都没按的阵亡') },
};
export const HABIT_KEYS = Object.keys(HABITS);
const MIN_MINUTES = 10;

/**
 * The check for one habit, from the game it was found in.
 * @param {string} habit    a key of HABITS
 * @param {any} summary     death_context's answer for the player's hero (default window)
 * @returns {object | null} a goal spec (kind 'replay_habit'), or null: once is not a habit, and a count that is not known is not a baseline
 */
export function habitGoal(habit, summary) {
  const h = HABITS[habit];
  const list = h ? summary?.deaths_where?.[h.list] : null;
  if (!Array.isArray(list) || list.length < 2) return null;
  // Half as often, rounded down: the engine's rule for a count of deaths (deaths_to_gap_closer_max above).
  const max = Math.max(1, Math.floor(list.length / 2));
  return {
    kind: 'replay_habit', habit, max, baseline: list.length,
    label: t(`At most ${max} ${h.label.en} (this game: ${list.length})`, `${h.label.zh}不超过 ${max} 次（这局 ${list.length} 次）`),
  };
}

/**
 * @param {object} goal     a spec from habitGoal
 * @param {any} summary     death_context's summary for the player's hero in the later game, or null when its replay is not parsed
 * @param {number} minutes  that game's length
 * @returns {{ result: 'met' | 'missed' | 'no_opportunity' | 'unknown', evidence: {en: string, zh: string} }}
 */
export function evaluateHabit(goal, summary, minutes) {
  const out = (result, evidence) => ({ result, evidence });
  const h = HABITS[goal?.habit];
  if (!h || !Number.isFinite(goal.max)) return out('unknown', t('Unknown goal.', '无法识别的目标。'));
  if (!summary) return out('unknown', t('Needs this game\'s replay: open its replay review.', '需要这局的录像：打开这局的录像复盘后核对。'));
  if (minutes < MIN_MINUTES) return out('no_opportunity', t('Game too short to count.', '比赛太短，不计入。'));
  const list = summary.deaths_where?.[h.list];
  if (!Array.isArray(list)) return out('unknown', t('This replay has no such count.', '这局录像里没有这项统计。'));
  // Bounds, like every other count of deaths: `low` is what the replay shows, `high` adds the deaths it could not decide.
  const unsure = h.unsure ? summary.deaths_not_known?.[h.unsure] : 0;
  const low = list.length;
  const when = list.length ? ` (${list.join(', ')})` : '';
  const whenZh = list.length ? `（${list.join('、')}）` : '';
  if (low > goal.max) return out('missed', t(`${low} ${h.label.en}${when}; goal ≤ ${goal.max}`, `${h.label.zh} ${low} 次${whenZh}；目标 ≤ ${goal.max}`));
  // An older summary without the unsure count cannot rule them out.
  if (!Number.isFinite(unsure) || low + unsure > goal.max) return out('unknown', t(`${low} ${h.label.en}, but some deaths have no health or position sample: cannot tell.`, `${h.label.zh} ${low} 次，但有阵亡缺少血量或位置采样，无法判定。`));
  return out('met', t(`${low} ${h.label.en}${when}; goal ≤ ${goal.max}`, `${h.label.zh} ${low} 次${whenZh}；目标 ≤ ${goal.max}`));
}

const result = (r, evidence) => ({ result: r, evidence });

/**
 * @param {object} goal    a spec from goalFor
 * @param {object} report  buildCoachReport() output of a later game
 * @param {number} slot    the player's seat in that game
 * @param {any} [replay]   for a 'replay_habit' goal: death_context's summary for that seat's hero from that game's replay (absent = not parsed, so unknown)
 * @returns {{ result: 'met' | 'missed' | 'no_opportunity' | 'unknown', evidence: {en: string, zh: string} }}
 */
export function evaluateGoal(goal, report, slot, replay = null) {
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
    case 'hold_item': {
      // From a replay review (lib/agent/goal.js): on this hero, finish the game holding one of these.
      if (goal.hero_id != null && player.hero?.id !== goal.hero_id) return result('no_opportunity', t('You played a different hero this game.', '这局你玩的是别的英雄。'));
      if (!Array.isArray(player.items)) return result('unknown', t('No item data for this game.', '这局没有装备数据。'));
      const ref = new Map(player.items.map((i) => [i.key, i]));
      // `accept` adds what the items are upgraded into: finishing with Overwhelming Blink meets a Blink goal.
      const have = (goal.accept ?? goal.items ?? []).filter((k) => ref.has(k));
      return result(have.length ? 'met' : 'missed', have.length
        ? t(`Finished with ${have.map((k) => ref.get(k).en ?? k).join(', ')}`, `终局装备里有${have.map((k) => ref.get(k).zh ?? k).join('、')}`)
        : t('None of the goal items in your final build', '终局装备里没有目标装备'));
    }
    case 'replay_habit':
      // From a replay review's rule (habitGoal above): the same count, taken from this game's replay.
      return evaluateHabit(goal, replay, minutes);
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
