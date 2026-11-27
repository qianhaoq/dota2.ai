import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { linkHeroNames } from '../../packages/review-engine/src/trace/index.js';
import { DRAFT_TOOL, draftReport } from '../../lib/agent/draftReport.js';
import { resolveRef } from '../../lib/agent/evidence.js';
import { heroMatchup } from '../../lib/agent/referenceTools.js';

/** The draft as it was played (#437 P3): lanes from the replay and how each pairing usually goes, on 9100904020. */
const fixture = (name: string) => JSON.parse(gunzipSync(readFileSync(new URL(`../../packages/review-engine/test/fixtures/${name}`, import.meta.url))).toString());
const trace = linkHeroNames(fixture('trace-9100904020.json.gz'));
// Public medals for the match (Legend): the bracket is the match's median, as hero_matchup reads it.
const match = { players: trace.heroes.map(() => ({ hero_id: null, rank_tier: 55 })) };
const seat = (key: string) => trace.heroes.findIndex((h: any) => h.key === key);

describe('draft_report', () => {
  const r: any = draftReport(trace, { hero: 'beastmaster' }, { match });

  it('which heroes went to which lane, the solo lanes, and the player\'s lane marked', () => {
    expect(r.lanes.map((l: any) => [l.lane, l.my_team, l.enemy, l.solo])).toEqual([
      ['bot', ['beastmaster', 'undying'], ['phantom_assassin', 'venomancer'], { my_team: false, enemy: false }],
      ['mid', ['skywrath_mage'], ['necrolyte'], { my_team: true, enemy: true }],
      ['top', ['sven', 'dark_willow'], ['axe', 'mirana'], { my_team: false, enemy: false }],
    ]);
    expect(r.lanes.filter((l: any) => l.my_lane).map((l: any) => l.lane)).toEqual(['bot']);
    expect(r.in_no_single_lane).toEqual([]);
  });

  it('every pairing in a lane, read in the match\'s bracket — the numbers hero_matchup gives', () => {
    expect(r.bracket_basis).toBe('the median public medal of the match');
    // The pairings of the bottom lane, each the same numbers hero_matchup gives for that pair in that bracket (the
    // readings themselves move with each data refresh).
    expect(r.lanes[0].pairings.map((p: any) => [p.hero, p.against])).toEqual([
      ['beastmaster', 'phantom_assassin'], ['beastmaster', 'venomancer'], ['undying', 'phantom_assassin'], ['undying', 'venomancer'],
    ]);
    for (const p of r.lanes.flatMap((l: any) => l.pairings)) {
      const m: any = heroMatchup(trace, { hero: p.hero, against: p.against }, { match, perspective: 'beastmaster' });
      expect([p.hero, p.against, p.lane_when_they_met, p.game]).toEqual([p.hero, p.against, m.by_bracket[0].lane_when_they_met, m.by_bracket[0].win]);
    }
    expect(r.lanes[0].pairings.some((p: any) => p.lane_when_they_met || p.game)).toBe(true);
    expect(r.lanes[1].pairings[0]).toMatchObject({ hero: 'skywrath_mage', against: 'necrolyte', bracket: 'Legend–Ancient' });
    // This legacy trace has no gold/creep_kills and the minimal mock match has hero_id: null, so positions and lane_at_10_00 are truthfully reported as gaps.
    expect(r.gaps).toEqual([
      { topic: 'positions', reason: 'inferred_position_not_settled_for_all_heroes', heroes: expect.arrayContaining(['beastmaster', 'phantom_assassin']) },
      { topic: 'lane_at_10_00', reason: 'no_lane_economy_in_match_record_or_trace' },
    ]);
  });

  it('the bracket not known: each bracket\'s reading, none picked, and a gap', () => {
    const u: any = draftReport(trace, { hero: 'beastmaster' }, {});
    expect(u.lanes[0].pairings[0].by_bracket.map((b: any) => b.bracket)).toEqual(['Herald–Guardian', 'Crusader–Archon', 'Legend–Ancient', 'Divine–Immortal']);
    expect(u.gaps).toContainEqual({ topic: 'bracket', reason: 'not_known' });
  });

  it('a support splitting two lanes is listed under each with its share, and counted when saying whether a lane was solo', () => {
    // Put Dark Willow (top) where Beastmaster stood every third second: no single lane, a large share in the bottom one.
    const i = seat('dark_willow'); const st = trace.states[i]; const b = trace.states[seat('beastmaster')];
    const mix = (arr: any[], from: any[]) => arr.map((v: any, k: number) => (k + trace.t0 >= 60 && k + trace.t0 < 600 && k % 3 === 0 && b.x[k] != null && b.y[k] != null ? from[k] : v));
    const t = { ...trace, states: trace.states.map((s: any, j: number) => (j === i ? { ...st, x: mix(st.x, b.x), y: mix(st.y, b.y) } : s)) };
    const d: any = draftReport(t, { hero: 'beastmaster' }, { match });
    expect(d.in_no_single_lane.map((x: any) => x.hero)).toEqual(['dark_willow']);
    const bot = d.lanes.find((l: any) => l.lane === 'bot');
    expect(bot.shared_part_time_by.map((x: any) => x.hero)).toEqual(['dark_willow']);
    expect(bot.pairings.filter((p: any) => p.part_time).map((p: any) => p.hero)).toEqual(['dark_willow', 'dark_willow']);
    // Sven alone in top, with Dark Willow sharing it part-time: not solo.
    const top = d.lanes.find((l: any) => l.lane === 'top');
    expect([top.my_team, top.solo.my_team]).toEqual([['sven'], false]);
  });

  it('a hero with no lane-stage positions: their lane is not known — never placed, and gaps names them', () => {
    const i = seat('necrolyte'); const st = trace.states[i];
    const cut = (arr: any[]) => arr.map((v: any, k: number) => (k + trace.t0 < 700 ? null : v));
    const t = { ...trace, states: trace.states.map((s: any, j: number) => (j === i ? { ...st, x: cut(st.x), y: cut(st.y), alive: cut(st.alive) } : s)) };
    const d: any = draftReport(t, { hero: 'beastmaster' }, { match });
    expect(d.lane_not_known).toEqual(['necrolyte']);
    expect(d.lanes.find((l: any) => l.lane === 'mid').enemy).toEqual([]);
    expect(d.gaps).toContainEqual({ topic: 'lanes', reason: 'a_hero_s_lane_stage_positions_not_in_trace', heroes: ['necrolyte'] });
    // With an enemy whose lane is not known, no lane can be called solo for the enemy unless two are known in it.
    expect(d.lanes.find((l: any) => l.lane === 'mid').solo.enemy).toBeNull();
    expect(d.lanes.find((l: any) => l.lane === 'bot').solo.enemy).toBe(false);
  });

  it('is a review tool, and its ref opens the same record under a line', () => {
    expect(DRAFT_TOOL.name).toBe('draft_report');
    expect(r.ref).toBe('draft:beastmaster');
    expect(resolveRef(trace, 'draft:beastmaster', { hero: 'beastmaster', match })?.record.lanes).toEqual(r.lanes);
  });

  it('missing positions that could tip whether a hero shared a lane: listed as may have, solo not known for that side, and a gap', () => {
    // Dark Willow: 150 of 540 lane-stage seconds bottom, 50 unplaced, 50 mid, the rest top (28%–37% bottom).
    const i = seat('dark_willow'); const st = trace.states[i];
    const x = st.x.slice(); const y = st.y.slice(); const alive = st.alive.slice();
    let bot = 0; let missing = 0; let mid = 0;
    for (let k = 60; k < 600; k += 1) {
      alive[k] = 1;
      if (bot < 150) { x[k] = 5000; y[k] = -5500; bot += 1; } else if (missing < 50) { x[k] = null; y[k] = null; missing += 1; } else if (mid < 50) { x[k] = 0; y[k] = 0; mid += 1; } else { x[k] = -5500; y[k] = 5000; }
    }
    const t = { ...trace, states: trace.states.map((s: any, j: number) => (j === i ? { ...st, x, y, alive } : s)) };
    const d: any = draftReport(t, { hero: 'beastmaster' }, { match });
    const bot2 = d.lanes.find((l: any) => l.lane === 'bot');
    expect(bot2.shared_part_time_by).toBeUndefined();
    expect(bot2.may_have_shared_part_time).toEqual([{ hero: 'dark_willow', side: 'my_team' }]);
    // Two heroes of the player's side in the lane already: not solo whatever she did.
    expect(bot2.solo.my_team).toBe(false);
    // Sven alone in top, and Dark Willow (most of her seconds there) shared it: not solo either.
    const top = d.lanes.find((l: any) => l.lane === 'top');
    expect(top.solo.my_team).toBe(false);
    expect(d.gaps).toContainEqual({ topic: 'part_time_sharing', reason: 'missing_positions_could_tip_it', heroes: ['dark_willow'] });
  });

  it('the review of #449: a hero of the player\'s side with no positions makes that side\'s solo not known', () => {
    const i = seat('dark_willow'); const st = trace.states[i];
    const cut = (arr: any[]) => arr.map((v: any, k: number) => (k + trace.t0 < 700 ? null : v));
    const t = { ...trace, states: trace.states.map((s: any, j: number) => (j === i ? { ...st, x: cut(st.x), y: cut(st.y), alive: cut(st.alive) } : s)) };
    const d: any = draftReport(t, { hero: 'beastmaster' }, { match });
    const top = d.lanes.find((l: any) => l.lane === 'top');
    expect([top.my_team, top.solo.my_team]).toEqual([['sven'], null]);
  });

  it('the review of #449: a lane only part-time sharers were in is still listed, with their pairings', () => {
    // Dark Willow (my side) and Mirana (enemy) each split their lane stage between top and bottom, out of mid.
    const split = (key: string) => {
      const i = seat(key); const st = trace.states[i];
      const x = st.x.slice(); const y = st.y.slice(); const alive = st.alive.slice();
      for (let k = 60; k < 600; k += 1) { alive[k] = 1; if (k % 2) { x[k] = 5000; y[k] = -5500; } else { x[k] = -5500; y[k] = 5000; } }
      return [i, { ...st, x, y, alive }] as const;
    };
    const [a, sa] = split('dark_willow'); const [b, sb] = split('mirana');
    // Move Sven and Axe (the top lane's own heroes) to mid, so top holds only the two sharers.
    const toMid = (key: string) => { const i = seat(key); const st = trace.states[i]; const x = st.x.slice(); const y = st.y.slice(); const alive = st.alive.slice(); for (let k = 60; k < 600; k += 1) { alive[k] = 1; x[k] = 0; y[k] = 0; } return [i, { ...st, x, y, alive }] as const; };
    const [c, sc] = toMid('sven'); const [e, se] = toMid('axe');
    const by = new Map<number, any>([[a, sa], [b, sb], [c, sc], [e, se]]);
    const t = { ...trace, states: trace.states.map((s: any, j: number) => by.get(j) ?? s) };
    const d: any = draftReport(t, { hero: 'beastmaster' }, { match });
    const top = d.lanes.find((l: any) => l.lane === 'top');
    expect(top).toBeTruthy();
    expect([top.my_team, top.enemy]).toEqual([[], []]);
    expect(top.shared_part_time_by.map((x: any) => x.hero).sort()).toEqual(['dark_willow', 'mirana']);
    expect(top.pairings.map((p: any) => [p.hero, p.against, p.part_time])).toEqual([['dark_willow', 'mirana', true]]);
  });

  it('populates lineups (1–5 positions, attribute, attack_type, roles, traits) and lanes[].at_10_00 from parsed match_record', () => {
    const heroIds: Record<string, number> = {
      axe: 2, phantom_assassin: 44, necrolyte: 36, venomancer: 40, mirana: 9,
      sven: 18, beastmaster: 38, undying: 85, skywrath_mage: 101, dark_willow: 119,
    };
    const roleCfg: Record<string, { lane_role: number; lh: number; gold: number }> = {
      // Radiant (team 2): PA safe(1), Necro mid(2), Axe off(3), Mirana off-sup(3), Veno safe-sup(1)
      phantom_assassin: { lane_role: 1, lh: 60, gold: 4200 },
      venomancer: { lane_role: 1, lh: 12, gold: 2100 },
      necrolyte: { lane_role: 2, lh: 55, gold: 4100 },
      axe: { lane_role: 3, lh: 50, gold: 3800 },
      mirana: { lane_role: 3, lh: 15, gold: 2200 },
      // Dire (team 3): Sven safe(1), Sky mid(2), BM off(3), Undying off-sup(3), DW safe-sup(1)
      sven: { lane_role: 1, lh: 62, gold: 4300 },
      dark_willow: { lane_role: 1, lh: 10, gold: 1900 },
      skywrath_mage: { lane_role: 2, lh: 45, gold: 3500 },
      beastmaster: { lane_role: 3, lh: 48, gold: 3600 },
      undying: { lane_role: 3, lh: 11, gold: 2000 },
    };
    const players = trace.heroes.map((h: any, idx: number) => {
      const cfg = roleCfg[h.key];
      const mkArr = (v: number) => Array.from({ length: 12 }, (_, m) => (m === 10 ? v : 0));
      return {
        player_slot: h.team === 2 ? idx : 128 + (idx - 5),
        hero_id: heroIds[h.key],
        lane_role: cfg.lane_role,
        rank_tier: 55,
        gold_t: mkArr(cfg.gold),
        lh_t: mkArr(cfg.lh),
        xp_t: mkArr(3000),
        dn_t: mkArr(5),
        last_hits: cfg.lh * 3,
        gold_per_min: 500,
        kills: 2, deaths: 2, assists: 2,
      };
    });
    const parsedMatch = { match_id: 9100904020, duration: 2551, radiant_win: true, players };
    const d: any = draftReport(trace, { hero: 'beastmaster' }, { match: parsedMatch });

    expect(d.gaps).toEqual([]);
    const bm = d.lineups.my_team.find((x: any) => x.hero === 'beastmaster');
    expect(bm).toEqual({
      hero: 'beastmaster',
      inferred_position: 3,
      primary_attribute: 'universal',
      attack_type: 'melee',
      roles: expect.arrayContaining(['Initiator', 'Disabler']),
      traits: expect.arrayContaining(['disable', 'piercing']),
    });
    const pa = d.lineups.enemy.find((x: any) => x.hero === 'phantom_assassin');
    expect(pa).toMatchObject({
      hero: 'phantom_assassin',
      inferred_position: 1,
      primary_attribute: 'agility',
      attack_type: 'melee',
      traits: expect.arrayContaining(['physical', 'evasion']),
    });

    const bot = d.lanes.find((l: any) => l.lane === 'bot');
    expect(bot.at_10_00).toEqual({
      my_team_deaths_before_10_00: 9, // beastmaster (4) + undying (5)
      enemy_deaths_before_10_00: expect.any(Number),
      my_team_gold: 5600,
      enemy_gold: 6300,
      gold_diff: -700,
      my_team_last_hits: 59,
      enemy_last_hits: 72,
      source: 'match_record',
    });
    const mid = d.lanes.find((l: any) => l.lane === 'mid');
    expect(mid.at_10_00).toMatchObject({
      my_team_gold: 3500, enemy_gold: 4100, gold_diff: -600,
      my_team_last_hits: 45, enemy_last_hits: 55, source: 'match_record',
    });
  });

  it('falls back to replay gold & creep_kills for lanes[].at_10_00 and keeps partial/blank sources null', () => {
    const nameIx = (k: string) => trace.names.indexOf(trace.heroes.find((h: any) => h.key === k).npc);
    const replayTrace: any = {
      ...trace,
      gold: [
        [5, nameIx('beastmaster'), 13, 1500],
        [6, nameIx('beastmaster'), 6, 999],   // selling -> excluded
        [7, nameIx('beastmaster'), 1, -200],  // death loss -> excluded
        [5, nameIx('undying'), 12, 800],
        [5, nameIx('phantom_assassin'), 13, 2100],
        [5, nameIx('venomancer'), 12, 900],
        [5, nameIx('skywrath_mage'), 13, 1900],
        [5, nameIx('necrolyte'), 13, 2200],
        [5, nameIx('sven'), 13, 2500],
        [5, nameIx('dark_willow'), 12, 700],
        [5, nameIx('axe'), 13, 1800],
        [5, nameIx('mirana'), 12, 600],
      ],
      creep_kills: [
        [300, nameIx('beastmaster'), 'l', 35, 2000],
        [300, nameIx('undying'), 'l', 5, 1000],
        [300, nameIx('phantom_assassin'), 'l', 50, 2600],
        [300, nameIx('venomancer'), 'l', 8, 1200],
        [300, nameIx('skywrath_mage'), 'l', 40, 2100],
        [300, nameIx('necrolyte'), 'l', 48, 2500],
        [300, nameIx('sven'), 'l', 55, 2800],
        [300, nameIx('dark_willow'), 'l', 6, 900],
        [300, nameIx('axe'), 'l', 42, 2200],
        [300, nameIx('mirana'), 'l', 9, 1000],
      ],
    };
    const d: any = draftReport(replayTrace, { hero: 'beastmaster' }, { match });
    const bot = d.lanes.find((l: any) => l.lane === 'bot');
    expect(bot.at_10_00).toMatchObject({
      my_team_gold: 2300, enemy_gold: 3000, gold_diff: -700,
      my_team_last_hits: 40, enemy_last_hits: 58, source: 'replay',
    });
    expect(d.lineups.my_team.every((x: any) => Number.isInteger(x.inferred_position))).toBe(true);
    expect(d.gaps).toEqual([]);

    // Partial match_record (one hero missing gold_t) without replay fallback -> never treats missing hero as 0 -> null + gap.
    const partialMatch = {
      players: [
        { hero_id: 38, gold_t: Array(12).fill(3000), lh_t: Array(12).fill(40), rank_tier: 55 },
        // undying missing!
      ],
    };
    const pRes: any = draftReport(trace, { hero: 'beastmaster' }, { match: partialMatch });
    expect(pRes.lanes.find((l: any) => l.lane === 'bot').at_10_00).toMatchObject({
      my_team_gold: null, enemy_gold: null, gold_diff: null, my_team_last_hits: null, enemy_last_hits: null, source: null,
    });
    expect(pRes.gaps).toContainEqual({ topic: 'lane_at_10_00', reason: 'no_lane_economy_in_match_record_or_trace' });

    // Blank trace.deaths -> lane death counts stay null, never 0.
    const noDeaths: any = { ...replayTrace, deaths: undefined };
    const ndRes: any = draftReport(noDeaths, { hero: 'beastmaster' }, { match });
    expect(ndRes.lanes[0].at_10_00.my_team_deaths_before_10_00).toBeNull();
    expect(ndRes.lanes[0].at_10_00.enemy_deaths_before_10_00).toBeNull();
    expect(ndRes.gaps).toContainEqual({ topic: 'lane_deaths_before_10_00', reason: 'no_deaths_in_trace' });
  });
});
