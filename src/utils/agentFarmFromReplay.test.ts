import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { linkHeroNames } from '../../packages/review-engine/src/trace/index.js';
import { farmReport, moneyOf, replayEarned } from '../../lib/agent/farmReport.js';

/**
 * farm_report without a parsed match record reads the replay's own gold log (#359 item 2). On 17 corpus games with a
 * record, each hero's 10-minute gain from the log is the record's less 872–934 (the income every hero gets over time,
 * not in the log), and the hero who gained the most on each team in each stretch is the same in 136 of 136.
 */
const fixture = (name: string) => JSON.parse(gunzipSync(readFileSync(new URL(`../../packages/review-engine/test/fixtures/${name}`, import.meta.url))).toString());
const bare = linkHeroNames(fixture('trace-9100904020.json.gz'));
const gold = fixture('gold-9100904020.json.gz');
const creeps = fixture('creeps-9100904020.json.gz');
const ix = (npc: string) => bare.names.indexOf(npc);
const trace = {
  ...bare,
  gold: gold.gold.map(([m, npc, reason, sum]: any[]) => [m, ix(npc), reason, sum]),
  creep_kills: creeps.creep_kills.map(([t, npc, kind, lh, nw]: any[]) => [t, ix(npc), kind, lh, nw]),
};

describe('gold earned from the replay\'s log', () => {
  it('cumulative to each minute, positive income only, with last hits from the running count', () => {
    const r: any = replayEarned(trace);
    expect(r.source).toBe('replay_gold_earned');
    const bm = r.series.get('beastmaster');
    expect(bm[0]).toBe(0);
    // Never falls: a death's loss and selling are not earning.
    for (let m = 1; m < bm.length; m += 1) expect(bm[m]).toBeGreaterThanOrEqual(bm[m - 1]);
    // Last hits at 10:00 as lane_report reads them (the same running count).
    expect(r.lastHits.get('beastmaster')[10]).toBe(35);
    // Rows without the count: last hits not known — the money still is.
    const noCount: any = replayEarned({ ...trace, creep_kills: trace.creep_kills.map((x: any) => [x[0], x[1], x[2], null, x[4]]) });
    expect([noCount.lastHits, noCount.series.get('beastmaster')[10]]).toEqual([null, bm[10]]);
    expect(replayEarned(bare)).toBeNull();
    // Kill rows before 10:00 without the count, a counted one after: at 10:00 not known, not 0 (Codex on #398).
    const nx = ix('npc_dota_hero_beastmaster');
    const partly: any = replayEarned({ ...trace, creep_kills: [...trace.creep_kills.filter((x: any) => x[1] !== nx), [100, nx, 'l', null, 700], [1201, nx, 'l', 50, 9000]] });
    expect(partly.lastHits.get('beastmaster').slice(0, 3)).toEqual([0, 0, null]);
    expect(partly.lastHits.get('beastmaster')[10]).toBeNull();
    expect(partly.lastHits.get('beastmaster')[21]).toBe(50);
  });

  it('farm_report uses it when there is no record, says so, and prefers a record when there is one', () => {
    const r: any = farmReport(trace, { hero: 'beastmaster' }, {});
    expect(r.money).toBe('replay_gold_earned');
    expect(r.money_note).toContain('from the replay\'s own gold log');
    // With a full record (gold_t for all ten), the record wins.
    const players = trace.heroes.map((h: any, i: number) => ({ hero_id: [2, 44, 36, 40, 9, 18, 38, 85, 101, 119][i], gold_t: gold.radiant_gold_adv.map((_: number, m: number) => m * 500), lh_t: gold.radiant_gold_adv.map(() => 0) }));
    const withRecord: any = moneyOf(trace, { players }, 40);
    expect(withRecord.source).toBe('match_data_gold_earned');
    // Without creep or gold rows and no record: the net worth graph, or nothing — never the replay's earned gold.
    expect(moneyOf(bare, null, 40)?.source ?? null).not.toBe('replay_gold_earned');
  });
});
