import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { linkHeroNames } from '../../packages/review-engine/src/trace/index.js';
import { GOLD_SOURCES, goldBySource, goldDifference } from '../../lib/agent/goldSources.js';
import { GOLD_SOURCE_REFERENCE, farmReport } from '../../lib/agent/farmReport.js';
import { laneProcess } from '../../lib/agent/laneProcess.js';

/** Where each side's gold came from (#437 P2): farm_report's gold_by_source on 9100904020, told from Beastmaster. */
const fixture = (name: string) => JSON.parse(gunzipSync(readFileSync(new URL(`../../packages/review-engine/test/fixtures/${name}`, import.meta.url))).toString());
const bare = linkHeroNames(fixture('trace-9100904020.json.gz'));
const gold = fixture('gold-9100904020.json.gz');
const ix = (npc: string) => bare.names.indexOf(npc);
const trace = { ...bare, gold: gold.gold.map(([m, npc, reason, sum]: any[]) => [m, ix(npc), reason, sum]) };

describe('gold by source', () => {
  it('the sources add up to earned; selling and the starting purse are in none', () => {
    const all = trace.heroes.map((h: any) => ix(h.npc));
    const s: any = goldBySource(trace, all, -Infinity, Infinity);
    expect(GOLD_SOURCES.reduce((a: number, k: string) => a + s[k], 0)).toBe(s.earned);
    const purse = trace.gold.filter((g: any) => g[2] === 0 && g[0] < 0).reduce((a: number, g: any) => a + g[3], 0);
    expect(purse).toBe(6000);
    const positive = trace.gold.filter((g: any) => g[2] !== 6 && g[2] !== 1 && g[3] > 0).reduce((a: number, g: any) => a + g[3], 0);
    expect(s.earned).toBe(positive - purse);
    expect(s.lost_on_dying).toBeLessThan(0);
  });

  it('farm_report: each stretch says where each side\'s gold came from, and which enemy earned most and from what', () => {
    const r: any = farmReport(trace, { hero: 'beastmaster' }, {});
    expect(r.stretches[0].gold_by_source.my_team_minus_enemy).toEqual({ lane_creeps: -1294, neutrals: 57, hero_kills_and_assists: 1127, buildings: 0, roshan_and_tormentor: 0, bounty_runes: 0, other: -365, lost_on_dying: 249, earned: -475 });
    expect(r.stretches[0].gold_by_source.enemy_hero_who_earned_most).toMatchObject({ hero: 'phantom_assassin', earned: 3055 });
    // The last stretch: the gap is buildings first.
    expect(r.stretches.at(-1).gold_by_source.my_team_minus_enemy).toMatchObject({ buildings: -8247, lane_creeps: -3245, hero_kills_and_assists: -3198 });
    for (const w of r.windows) expect(w.gold_by_source.my_team.earned).toBeGreaterThanOrEqual(0);
    expect(r.gold_by_source_reference).toBe(GOLD_SOURCE_REFERENCE);
    expect(r.gaps).toContainEqual({ topic: 'experience_by_source', reason: 'not_in_replay_data' });
  });
});

describe('unknown stays unknown', () => {
  it('no gold rows: no gold_by_source on any stretch, and gaps says so', () => {
    const { gold: _g, ...t } = trace as any;
    const r: any = farmReport(t, { hero: 'beastmaster' }, {});
    for (const s of r.stretches ?? []) expect(s.gold_by_source).toBeUndefined();
    expect(r.gaps).toContainEqual({ topic: 'gold_by_source', reason: 'no_gold_rows_in_trace' });
  });

  it('a log without dying rows (15 of 209 parsed games): what dying cost is null — never 0 — in both tools', () => {
    const t = { ...trace, gold: trace.gold.filter((g: any) => g[2] !== 1) };
    const s: any = goldBySource(t, [ix(trace.heroes[0].npc)], -Infinity, Infinity);
    expect(s.lost_on_dying).toBeNull();
    expect(goldDifference(s, s).lost_on_dying).toBeNull();
    const r: any = farmReport(t, { hero: 'beastmaster' }, {});
    expect(r.stretches[0].gold_by_source.my_team_minus_enemy.lost_on_dying).toBeNull();
    expect(r.gaps).toContainEqual({ topic: 'lost_on_dying', reason: 'no_dying_rows_in_the_replay_s_gold_log' });
    const l: any = laneProcess({ ...t, creep_kills: [] }, t.heroes.findIndex((h: any) => h.key === 'beastmaster'));
    expect(l.gold_gap_by_source.my_team_minus_enemy.lost_on_dying).toBeNull();
    expect(l.gaps).toContainEqual({ topic: 'lost_on_dying', reason: 'no_dying_rows_in_the_replay_s_gold_log' });
  });
});
