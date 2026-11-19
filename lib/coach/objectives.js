/**
 * Objective events from both sources the coach reads:
 * - OpenDota: `building_kill` (key = building), Roshan kill, Aegis pickup;
 * - first-party replay overlays: `DOTA_COMBATLOG_TEAM_BUILDING_KILL` with the
 *   building in `key` and the destroying team in `team` (2 Radiant, 3 Dire).
 * A building destroyed by its own side (deny) is nobody's objective.
 */

export const REPLAY_BUILDING_KILL = 'DOTA_COMBATLOG_TEAM_BUILDING_KILL';

export const isBuildingKill = (o) => o?.type === 'building_kill' || o?.type === REPLAY_BUILDING_KILL;

/** Which side owned the building: goodguys = Radiant, badguys = Dire. */
export function buildingOwner(o) {
  const key = o?.key ?? '';
  if (/goodguys/.test(key)) return 'radiant';
  if (/badguys/.test(key)) return 'dire';
  return null;
}

const teamSide = (team) => (team === 2 ? 'radiant' : team === 3 ? 'dire' : null);
const other = (side) => (side === 'radiant' ? 'dire' : side === 'dire' ? 'radiant' : null);

/** Which side took an objective, or null when unknown / a deny. */
export function objectiveTeam(o) {
  if (o?.type === 'building_kill') return other(buildingOwner(o));
  if (o?.type === REPLAY_BUILDING_KILL) {
    const owner = buildingOwner(o);
    const killer = teamSide(o.team);
    // Unknown destroyer, or a same-side demolition: not an objective taken.
    if (!owner || !killer || killer === owner) return null;
    return killer;
  }
  if (o?.type === 'CHAT_MESSAGE_ROSHAN_KILL') return teamSide(o.team);
  if (o?.type === 'CHAT_MESSAGE_AEGIS') {
    if (o.player_slot != null) return o.player_slot < 128 ? 'radiant' : 'dire';
    if (o.slot != null) return o.slot < 5 ? 'radiant' : 'dire';
  }
  return null;
}

/** Objectives worth counting: an Aegis pickup is the same event as its Roshan kill. */
export function countedObjectives(match) {
  const objs = Array.isArray(match?.objectives) ? match.objectives : [];
  const hasRoshan = objs.some((o) => o.type === 'CHAT_MESSAGE_ROSHAN_KILL');
  return hasRoshan ? objs.filter((o) => o.type !== 'CHAT_MESSAGE_AEGIS') : objs;
}

/**
 * Whether objective counts can be trusted: there are events and at least one
 * is recognised. Events of an unknown shape mean "unknown", never "zero".
 */
export function objectivesKnown(match) {
  return countedObjectives(match).some((o) => objectiveTeam(o) != null);
}
