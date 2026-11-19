import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildCoachReport } from '../../lib/coach/analyze.js';
import { objectiveTeam, objectivesKnown, REPLAY_BUILDING_KILL } from '../../lib/coach/objectives.js';

const parsedReal = () => JSON.parse(readFileSync(new URL('../fixtures/coach/match9091400302.parsed.json', import.meta.url), 'utf8'));
// The shape first-party replay overlays emit (packages/review-engine/src/replay.js).
const artifact = JSON.parse(readFileSync(new URL('../../data/replay-facts/9080127650.json', import.meta.url), 'utf8'));

/** Same match, buildings only — once as OpenDota events, once as replay events. */
function pair() {
  const od = parsedReal();
  od.objectives = od.objectives.filter((o: any) => o.type === 'building_kill');
  const replay = parsedReal();
  replay.objectives = od.objectives.map((o: any) => ({
    time: o.time, key: o.key, type: REPLAY_BUILDING_KILL,
    team: /goodguys/.test(o.key) ? 3 : 2, source_path: 'trace/events.jsonl[0]',
  }));
  return { od, replay };
}

describe('objectives from first-party replay overlays (#140)', () => {
  it('reads the baked 9080127650 artifact: Radiant took Dire buildings; its own tier-1 was a deny', () => {
    const sides = artifact.objectives.map((o: any) => objectiveTeam(o));
    const radiantTook = artifact.objectives.filter((o: any, i: number) => sides[i] === 'radiant' && /badguys/.test(o.key));
    expect(radiantTook.length).toBe(25);
    const own = artifact.objectives.find((o: any) => o.key === 'npc_dota_goodguys_tower1_top');
    expect(own.team).toBe(2);
    expect(objectiveTeam(own)).toBeNull();
    expect(objectivesKnown({ objectives: artifact.objectives })).toBe(true);
  });

  it('replay events give the same death conversions, phase building counts and lane towers as OpenDota', () => {
    const { od, replay } = pair();
    const a: any = buildCoachReport(od); const b: any = buildCoachReport(replay);
    for (let s = 0; s < 10; s++) {
      const ca = a.reviews[s].chapters; const cb = b.reviews[s].chapters;
      expect(cb.deaths?.rows.map((d: any) => d.converted)).toEqual(ca.deaths?.rows.map((d: any) => d.converted));
      expect(cb.story?.phases.map((p: any) => p.buildings)).toEqual(ca.story?.phases.map((p: any) => p.buildings));
      expect(cb.laning?.towers).toEqual(ca.laning?.towers);
      expect(b.reviews[s].findings.map((f: any) => f.body.en)).toEqual(a.reviews[s].findings.map((f: any) => f.body.en));
    }
    // And they are not trivially zero: the losing side gave up buildings.
    const tide: any = a.reviews[0].chapters;
    expect(tide.story.phases.reduce((n: number, p: any) => n + p.buildings[1], 0)).toBeGreaterThan(0);
    expect(tide.deaths.rows.some((d: any) => d.converted)).toBe(true);
  });

  it('a same-side demolition (deny) is nobody\'s objective', () => {
    expect(objectiveTeam({ type: REPLAY_BUILDING_KILL, key: 'npc_dota_goodguys_tower1_top', team: 2 })).toBeNull();
    expect(objectiveTeam({ type: REPLAY_BUILDING_KILL, key: 'npc_dota_goodguys_tower1_top', team: 3 })).toBe('dire');
    expect(objectiveTeam({ type: REPLAY_BUILDING_KILL, key: 'npc_dota_badguys_fort', team: 0 })).toBeNull();
  });

  it('objective events of an unknown shape are "unknown", never "no objectives"', () => {
    const m = parsedReal();
    m.objectives = m.objectives.map((o: any) => ({ ...o, type: 'SOMETHING_NEW' }));
    expect(objectivesKnown(m)).toBe(false);
    const r: any = buildCoachReport(m);
    expect(r.reviews[0].chapters.deaths.rows.every((d: any) => d.converted === null)).toBe(true);
    expect(r.reviews[0].findings.find((f: any) => f.id === 'deaths.high').body.en).not.toMatch(/followed by the enemy taking/);
  });
});
