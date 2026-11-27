/**
 * Infer 1–5 role (`pos` 1..5, `kind`: 'core' | 'support') from the replay trace alone.
 * Pure, deterministic, no IO, no clock.
 *
 * Used when the match record is absent or unparsed (no OpenDota `lane_role`).
 * Combines:
 * - each hero's lane between 1:00 and 10:00 (`laneOf`, Radiant bot=safe / top=off, Dire mirrored),
 * - early farm in 0:00–10:00 (`creep_kills` running last hits or kill count, else `gold` farm reasons 13/14
 *   or total positive earned, else minute-10 `net_worth`, else unparsed `match` scoreboard last_hits / GPM
 *   when the caller provides a scoreboard for a legacy trace without `creep_kills`/`gold`/`net_worth`),
 * - observer wards placed (`wardPlacers`) as a tie-breaker between close lane partners.
 *
 * Unknown stays unknown: missing positions for any hero on the team, incomplete teams, or a trace with
 * no farm signal return `{ pos: null, kind: null, confidence: null, source: null, gaps }`.
 */
import { heroByKey } from '../../packages/review-engine/src/staticHeroes.js';
import { LANE_END, laneOf } from './laneFromReplay.js';
import { wardPlacers } from './wardReport.js';

const GOLD_SOLD = 6;
const GOLD_LANE_CREEP = 13;
const GOLD_NEUTRAL = 14;

/** Lane number (1=bot, 2=mid, 3=top) → team-relative lane role (1=safe, 2=mid, 3=off, null=roam). */
function toLaneRole(lane, team) {
  if (lane == null) return null;
  if (lane === 2) return 2;
  if (team === 2) return lane === 1 ? 1 : 3; // Radiant: bot=safe(1), top=off(3)
  if (team === 3) return lane === 3 ? 1 : 3; // Dire: top=safe(1), bot=off(3)
  return null;
}

/**
 * Early farm metric for a team's 5 heroes, returning `{ scores: Map<number, number>, source: string } | null`.
 * All 5 heroes of the team are measured on the same signal; missing signal stays null (never mixed).
 */
function teamFarmSignal(trace, teamIndices, match) {
  const nameIx = (i) => trace.names.indexOf(trace.heroes[i].npc);
  const goldBefore10 = (i) => {
    if (!Array.isArray(trace.gold)) return null;
    const nx = nameIx(i);
    let farm = 0; let earned = 0;
    for (const g of trace.gold) {
      if (g[1] !== nx || g[0] >= LANE_END / 60 || g[2] === GOLD_SOLD || !(g[3] > 0)) continue;
      earned += g[3];
      if (g[2] === GOLD_LANE_CREEP || g[2] === GOLD_NEUTRAL) farm += g[3];
    }
    return { farm, earned };
  };

  if (Array.isArray(trace.creep_kills)) {
    const scores = new Map();
    for (const i of teamIndices) {
      const nx = nameIx(i);
      let runningLh = null;
      let count = 0;
      for (const r of trace.creep_kills) {
        if (r[1] !== nx || r[0] >= LANE_END) continue;
        if (r[2] === 'l' || r[2] === 'n' || r[2] === 'u') count += 1;
        if (Number.isInteger(r[3])) runningLh = r[3];
      }
      const lh = runningLh ?? count;
      const g = goldBefore10(i);
      // Primary: last hits before 10:00 (weighted strongly); tie-break: creep+neutral gold, then earned gold.
      scores.set(i, lh * 10000 + (g ? g.farm * 2 + g.earned * 0.1 : 0));
    }
    return { scores, source: 'replay' };
  }

  if (Array.isArray(trace.gold)) {
    const scores = new Map();
    for (const i of teamIndices) {
      const g = goldBefore10(i);
      scores.set(i, g ? g.farm * 10 + g.earned : 0);
    }
    return { scores, source: 'replay' };
  }

  if (Array.isArray(trace.net_worth) && trace.net_worth.length === trace.heroes.length) {
    const ok = teamIndices.every((i) => Array.isArray(trace.net_worth[i]) && Number.isFinite(trace.net_worth[i][Math.min(10, trace.net_worth[i].length - 1)]));
    if (ok) {
      const scores = new Map();
      for (const i of teamIndices) {
        const g = trace.net_worth[i];
        scores.set(i, g[Math.min(10, g.length - 1)]);
      }
      return { scores, source: 'replay' };
    }
  }

  if (match && Array.isArray(match.players)) {
    const byHeroId = new Map(match.players.filter(Boolean).map((p) => [p.hero_id, p]));
    const matched = teamIndices.map((i) => {
      const id = heroByKey(trace.heroes[i].key)?.id;
      return [i, id != null ? byHeroId.get(id) : null];
    });
    if (matched.every(([, p]) => p && (Number.isFinite(p.last_hits) || Number.isFinite(p.gold_per_min)))) {
      const scores = new Map();
      for (const [i, p] of matched) {
        // Within a single dual lane, scoreboard last_hits + GPM reliably separates the lane core from the lane support.
        scores.set(i, (Number.isFinite(p.last_hits) ? p.last_hits * 10 : 0) + (Number.isFinite(p.gold_per_min) ? p.gold_per_min : 0));
      }
      return { scores, source: 'replay_lanes_and_scoreboard' };
    }
  }

  return null;
}

/** Observer wards placed per hero index (0 when wards exist and hero placed none; null when trace lacks wards). */
function observerCounts(trace) {
  const placers = wardPlacers(trace);
  if (!placers || !Array.isArray(trace.wards)) return null;
  const counts = new Map();
  for (let i = 0; i < trace.heroes.length; i += 1) counts.set(i, 0);
  trace.wards.forEach((w, j) => {
    if (w[3] === 'o' && placers[j] != null) counts.set(placers[j], (counts.get(placers[j]) ?? 0) + 1);
  });
  return counts;
}

/**
 * Infer 1–5 positions for every hero of `team` (2 = Radiant, 3 = Dire) from the replay trace.
 * @param {any} trace
 * @param {number} team
 * @param {any} [match]
 * @returns {{ roles: Map<number, { pos: number, kind: 'core' | 'support', confidence: 'high' | 'medium', source: string, lane_role: number | null }> | null, source: string | null, gaps: string[] }}
 */
export function inferTeamRolesFromReplay(trace, team, match = null) {
  if (!Array.isArray(trace?.heroes)) return { roles: null, source: null, gaps: ['invalid_trace'] };
  const teamIndices = trace.heroes.map((h, i) => (h.team === team ? i : -1)).filter((i) => i >= 0);
  if (teamIndices.length !== 5) return { roles: null, source: null, gaps: ['incomplete_team'] };

  const rawLanes = new Map(teamIndices.map((i) => [i, laneOf(trace, i)]));
  if (teamIndices.some((i) => rawLanes.get(i) === undefined)) {
    return { roles: null, source: null, gaps: ['positions_not_known'] };
  }
  const farm = teamFarmSignal(trace, teamIndices, match);
  if (!farm) {
    return { roles: null, source: null, gaps: ['no_farm_signal_in_trace'] };
  }

  const obs = observerCounts(trace);
  const laneRoles = new Map(teamIndices.map((i) => [i, toLaneRole(rawLanes.get(i), team)]));
  // Higher farm score first; if tied, fewer observer wards placed (core over support).
  const byCoreOrder = (a, b) => (farm.scores.get(b) - farm.scores.get(a)) || ((obs?.get(a) ?? 0) - (obs?.get(b) ?? 0)) || (a - b);

  const inRole = (lr) => teamIndices.filter((i) => laneRoles.get(i) === lr).sort(byCoreOrder);
  const safe = inRole(1);
  const mid = inRole(2);
  const off = inRole(3);

  const posMap = new Map();
  let exactLanes = true;
  if (safe[0] != null) posMap.set(safe[0], 1); else exactLanes = false;
  if (mid[0] != null) posMap.set(mid[0], 2); else exactLanes = false;
  if (off[0] != null) posMap.set(off[0], 3); else exactLanes = false;

  // Fill any empty core lane slot (e.g. a roaming/jungling core) from highest remaining farm.
  const unassigned = () => teamIndices.filter((i) => !posMap.has(i)).sort(byCoreOrder);
  for (const p of [1, 2, 3]) {
    if ([...posMap.values()].includes(p)) continue;
    const next = unassigned()[0];
    if (next != null) posMap.set(next, p);
  }

  // Remaining two players are supports (Pos 4 / Pos 5).
  const rest = unassigned();
  if (rest.length === 2) {
    const [a, b] = rest; // a has higher farm score than b
    const aSafe = laneRoles.get(a) === 1;
    const bSafe = laneRoles.get(b) === 1;
    if (aSafe && !bSafe) {
      posMap.set(a, 5);
      posMap.set(b, 4);
    } else if (bSafe && !aSafe) {
      posMap.set(b, 5);
      posMap.set(a, 4);
    } else {
      // Both roaming or both in the same lane (trilane): higher-farm / fewer-wards is 4, poorer / more-wards is 5.
      exactLanes = false;
      posMap.set(a, 4);
      posMap.set(b, 5);
    }
  } else {
    return { roles: null, source: null, gaps: ['role_assignment_incomplete'] };
  }

  const confidence = exactLanes && farm.source === 'replay' ? 'high' : 'medium';
  const roles = new Map();
  for (const [i, pos] of posMap) {
    roles.set(i, {
      pos,
      kind: pos <= 3 ? 'core' : 'support',
      confidence,
      source: farm.source,
      lane_role: laneRoles.get(i) ?? null,
    });
  }
  return { roles, source: farm.source, gaps: [] };
}

/**
 * Infer one hero's 1–5 role from the replay trace.
 * @param {any} trace
 * @param {string} heroKey
 * @param {any} [match]
 * @returns {{ pos: number | null, kind: 'core' | 'support' | null, confidence: 'high' | 'medium' | null, source: string | null, lane_role: number | null, gaps: string[] }}
 */
export function roleFromReplay(trace, heroKey, match = null) {
  const slug = String(heroKey ?? '').trim().toLowerCase().replace(/^npc_dota_hero_/, '').replace(/[\s-]+/g, '_');
  const idx = Array.isArray(trace?.heroes) ? trace.heroes.findIndex((h) => h.key === slug) : -1;
  if (idx < 0) return { pos: null, kind: null, confidence: null, source: null, lane_role: null, gaps: ['unknown_hero'] };
  const res = inferTeamRolesFromReplay(trace, trace.heroes[idx].team, match);
  const mine = res.roles?.get(idx) ?? null;
  if (!mine) return { pos: null, kind: null, confidence: null, source: null, lane_role: null, gaps: res.gaps };
  return { ...mine, gaps: [] };
}
