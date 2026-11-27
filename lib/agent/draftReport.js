/**
 * draft_report: who went to which lane, and how each pairing in a lane usually goes — the lane matchups of the draft,
 * told from one hero's side (use the player). #437 P3.
 *
 * - Lanes from the replay (laneOf, laneFromReplay.js): the third of the map a hero spent 60% of the lane stage in. A
 *   hero in no single lane is listed with their share in each lane, and under each lane they spent PART_TIME_SHARE
 *   of it in (a support splitting two lanes, as lane_report reads it); one whose positions are
 *   missing is "not known", never placed.
 * - A solo lane: one hero of a side in it, counting part-time sharers (a mid, or an offlane core alone against two).
 * - Each pairing of a hero of the player's side with a hero of the other side in the same lane: how their lanes went
 *   when they met and how the hero does against that enemy, in public games (STRATZ) of the player's bracket — the
 *   same numbers hero_matchup gives. With the bracket not known, each bracket's reading, so none is picked for it.
 *
 * Public games, not this game: a pairing "unfavoured" there is how the draft usually stands, not what happened here.
 * Strengths over time (levels, items) are power_spikes'; game length is lineup_timing's.
 */
import { heroByKey } from '../../packages/review-engine/src/staticHeroes.js';
import { BRACKETS, BRACKET_LABEL, RANK_SOURCE, heroVsRank, laneVsRank, reviewBracket } from '../coach/matchupsRank.js';
import { LANE_END, LANE_FROM, laneOf } from './laneFromReplay.js';
import { PART_TIME_SHARE, laneShare, sharedLane } from './laneProcess.js';

const LANE_NAME = { 1: 'bot', 2: 'mid', 3: 'top' };
const pct = (x) => Math.round(x * 1000) / 10;
const slugOf = (hero) => String(hero ?? '').trim().toLowerCase().replace(/^npc_dota_hero_/, '').replace(/[\s-]+/g, '_');
const third = (x, y) => { const d = y - x; return Math.abs(d) < 2200 ? 2 : d > 0 ? 3 : 1; };
const inBase = (x, y) => (x > 4200 && y > 3800) || (x < -4600 && y < -4200);

/** The share of hero i's living lane-stage seconds outside base in each lane ({ bot, mid, top }), or null without any. */
function laneShares(trace, i) {
  const st = trace.states?.[i]; if (!st) return null;
  const c = { 1: 0, 2: 0, 3: 0 }; let n = 0;
  for (let s = LANE_FROM; s < LANE_END; s += 1) {
    const k = s - trace.t0;
    if (st.alive?.[k] !== 1 || st.x?.[k] == null || st.y?.[k] == null || inBase(st.x[k], st.y[k])) continue;
    c[third(st.x[k], st.y[k])] += 1; n += 1;
  }
  return n ? Object.fromEntries([1, 2, 3].map((l) => [LANE_NAME[l], Math.round((c[l] / n) * 100) / 100])) : null;
}

export function draftReport(trace, args = {}, ctx = {}) {
  const slug = slugOf(args.hero);
  const h = trace.heroes.findIndex((x) => x.key === slug);
  if (h < 0) return { error: 'unknown_hero', heroes: trace.heroes.map((x) => x.key) };
  const team = trace.heroes[h].team;
  const side = (i) => (trace.heroes[i].team === team ? 'my_team' : 'enemy');
  const key = (i) => trace.heroes[i].key;
  const lanes = trace.heroes.map((_, i) => laneOf(trace, i));
  const all = trace.heroes.map((_, i) => i);
  const shares = all.map((i) => (lanes[i] === null ? laneShares(trace, i) : null));

  // The bracket the numbers are read in: the player's medal, else the match's median public medal (as hero_matchup).
  const me = (ctx.match?.players ?? []).find((p) => p && p.hero_id === heroByKey(slug)?.id) ?? {};
  const known = ctx.match ? reviewBracket(ctx.match.players ?? [], me) : null;
  const brackets = known ? [known.key] : BRACKETS;
  const lang = ctx.lang === 'zh' ? 'zh' : 'en';
  const pair = (a, b) => {
    const ida = heroByKey(key(a))?.id; const idb = heroByKey(key(b))?.id;
    const rows = brackets.map((br) => {
      const l = ida && idb ? laneVsRank(ida, idb, br) : null; const w = ida && idb ? heroVsRank(ida, idb, br) : null;
      return {
        bracket: BRACKET_LABEL[br][lang],
        lane_when_they_met: l ? { lanes: l.n, won: pct(l.won), even: pct(l.even), lost: pct(l.lost), own_lanes_won: pct(l.base.won), own_lanes_lost: pct(l.base.lost), reading: l.verdict } : null,
        game: w ? { games: w.n, win_rate: pct(w.wr), own_win_rate: pct(w.base), reading: w.verdict } : null,
      };
    });
    return { hero: key(a), against: key(b), ...(known ? rows[0] : { by_bracket: rows }) };
  };

  const laneList = [1, 2, 3].map((l) => {
    const mine = all.filter((i) => lanes[i] === l && side(i) === 'my_team');
    const theirs = all.filter((i) => lanes[i] === l && side(i) === 'enemy');
    // Heroes in no single lane who spent PART_TIME_SHARE of the lane stage here shared it (as lane_report reads it).
    // Read as lane_report reads it (laneProcess.js): with missing positions that could tip it, it is not settled.
    const part = all.filter((i) => lanes[i] === null && sharedLane(trace, i, l) === true);
    const maybe = all.filter((i) => lanes[i] === null && sharedLane(trace, i, l) === null);
    // A lane only part-time sharers were in is still a lane (two supports splitting it, say).
    if (!mine.length && !theirs.length && !part.length) return null;
    const count = (who, list) => list.length + part.filter((i) => side(i) === who).length;
    // Solo is not known for a side with a hero who may or may not have shared the lane.
    // Solo is not known for a side with a hero who may have been in the lane: one who may have shared it part-time,
    // or one whose lane is not known at all — unless two heroes of that side are known to have been in it.
    const unsure = (who) => maybe.some((i) => side(i) === who) || all.some((i) => lanes[i] === undefined && side(i) === who);
    const solo = (who, list) => (unsure(who) ? (count(who, list) >= 2 ? false : null) : count(who, list) === 1);
    return {
      lane: LANE_NAME[l],
      ...(mine.includes(h) ? { my_lane: true } : {}),
      my_team: mine.map(key), enemy: theirs.map(key),
      ...(part.length ? { shared_part_time_by: part.map((i) => ({ hero: key(i), side: side(i), share_of_lane_stage_here: Math.round(laneShare(trace, i, l) * 100) / 100 })) } : {}),
      ...(maybe.length ? { may_have_shared_part_time: maybe.map((i) => ({ hero: key(i), side: side(i) })) } : {}),
      // Solo: one hero of that side, counting those who shared the lane part-time; null when that is not settled.
      solo: { my_team: solo('my_team', mine), enemy: solo('enemy', theirs) },
      // Every hero of the player's side in the lane against every enemy in it, part-time sharers included (marked).
      pairings: [...mine, ...part.filter((i) => side(i) === 'my_team')].flatMap((a) => [...theirs, ...part.filter((i) => side(i) === 'enemy')]
        .map((b) => ({ ...pair(a, b), ...(part.includes(a) || part.includes(b) ? { part_time: true } : {}) }))),
    };
  }).filter(Boolean);

  const noLane = all.filter((i) => lanes[i] === null);
  const notKnown = all.filter((i) => lanes[i] === undefined);
  const pairs = laneList.flatMap((l) => l.pairings);
  const anyNumber = pairs.some((p) => (p.by_bracket ?? [p]).some((r) => r.lane_when_they_met || r.game));
  return {
    ref: `draft:${slug}`, hero: slug,
    told_from: { hero: slug, note: 'my_team is this hero\'s team' },
    lanes: laneList,
    in_no_single_lane: noLane.map((i) => ({ hero: key(i), side: side(i), share_of_lane_stage_by_lane: shares[i] })),
    ...(notKnown.length ? { lane_not_known: notKnown.map(key) } : {}),
    bracket_basis: known ? (known.basis === 'player' ? 'the player\'s medal' : 'the median public medal of the match') : 'not known: every bracket',
    lane_rule: `lane = the third of the map a hero spent 60% or more of their living seconds in between 1:00 and 10:00, from the replay; a hero in no single lane who spent ${PART_TIME_SHARE * 100}% or more of it in a lane shared that lane part-time (shared_part_time_by); solo = one hero of that side in the lane, counting those`,
    reading_rule: 'lane_when_they_met: how the hero\'s lane went when it met that enemy (won / even / lost shares; own_lanes_won / own_lanes_lost: the hero\'s lanes against everyone); game: the hero\'s win rate with that enemy on the other team against its own. "reading" is favoured / unfavoured only two standard errors from the hero\'s own (100+ games, 50+ lanes). Public games, not this game.',
    source: `${RANK_SOURCE.attribution?.en ?? 'STRATZ'}; public matches of ${RANK_SOURCE.patch}, ${RANK_SOURCE.weeks?.count ?? '?'} weeks to ${RANK_SOURCE.weeks?.to ?? '?'}`,
    gaps: [
      ...(notKnown.length ? [{ topic: 'lanes', reason: 'a_hero_s_lane_stage_positions_not_in_trace', heroes: notKnown.map(key) }] : []),
      ...(laneList.some((x) => x.may_have_shared_part_time) ? [{ topic: 'part_time_sharing', reason: 'missing_positions_could_tip_it', heroes: [...new Set(laneList.flatMap((x) => (x.may_have_shared_part_time ?? []).map((m) => m.hero)))] }] : []),
      ...(pairs.length && !anyNumber ? [{ topic: 'pairings', reason: 'too_few_public_games' }] : []),
      ...(known ? [] : [{ topic: 'bracket', reason: 'not_known' }]),
    ],
  };
}

export const DRAFT_TOOL = {
  name: 'draft_report',
  description: 'The draft as it was played, told from a hero\'s side (use the player): which heroes went to which lane (from the replay), which lanes were solo, the heroes in no single lane and where they spent most of the lane stage, and for every pairing of a hero of the player\'s side with an enemy in the same lane, how their lanes went when they met and how the hero does against that enemy in public games of the player\'s bracket. Use it for what each lane was up against before saying why a lane or the game went as it did. Public games, not this game; strengths over time are power_spikes\', game length lineup_timing\'s.',
  input_schema: { type: 'object', properties: { hero: { type: 'string', description: 'Hero key as in match_overview. Use the player\'s hero.' } }, required: ['hero'], additionalProperties: false },
  run: draftReport,
};
