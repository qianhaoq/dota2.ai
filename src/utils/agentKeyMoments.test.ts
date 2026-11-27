import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { linkHeroNames } from '../../packages/review-engine/src/trace/index.js';
import { AFTER, FROM_MINUTE, KEY_MOMENTS_TOOL, LISTED, REBOUND, keyMoments } from '../../lib/agent/keyMoments.js';
import { KNOWLEDGE_TOOLS } from '../../lib/agent/knowledgeTools.js';
import { resolveRef } from '../../lib/agent/evidence.js';
import { deepReviewSystem } from '../../lib/agent/deepReview.js';

/**
 * key_moments (#356): the fights that moved the team's chance to win the most, the largest falling stretch, and where
 * the player was when the chance was lost. On 9100904020 (Beastmaster, Dire, lost at 42:31) the rubric's turning
 * fight is 30:26 — and the game turned over three fights in a row, 25:25, 27:33 and 30:26.
 */
const trace = linkHeroNames(JSON.parse(gunzipSync(readFileSync(new URL('../../packages/review-engine/test/fixtures/trace-9100904020.json.gz', import.meta.url))).toString()));
const real = JSON.parse(gunzipSync(readFileSync(new URL('../../packages/review-engine/test/fixtures/gold-9100904020.json.gz', import.meta.url))).toString());
const match = { radiant_gold_adv: real.radiant_gold_adv };

describe('key_moments on the real game', () => {
  const r: any = keyMoments(trace, { hero: 'beastmaster' }, { match });

  it('reads the chance from the match record, from 5:00, and states its rule', () => {
    expect([FROM_MINUTE, REBOUND, AFTER, LISTED]).toEqual([5, 0.05, 120, 6]);
    expect(r).toMatchObject({ ref: 'moments:beastmaster', ref_scope: 'summary', read: true, result: 'my_team_lost', gold_lead_source: 'match_record', read_from_minute: 5 });
    expect(r.rule).toContain('it ranks moments and says nothing of whose fault a fight was');
  });

  it('the largest fall is one stretch of three fights, 25:00 to 33:00, with the rubric\'s turning fight among them', () => {
    expect(r.stretch).toMatchObject({ from: '25:00', to: '33:00' });
    expect(r.stretch.my_team_win_chance_from - r.stretch.my_team_win_chance_to).toBeGreaterThanOrEqual(30);
    expect(r.stretch.fights.map((f: any) => [f.ref, f.me])).toEqual([['fight:9', 'in_it'], ['fight:10', 'in_it'], ['fight:11', 'in_it']]);
    expect(r.stretch.fights.every((f: any) => f.change < 0)).toBe(true);
  });

  it('Beastmaster was in every fight the chance was lost in: the lost chance is not about where he was', () => {
    expect(r.falls_by_my_part).toEqual({ in_it: 1, dead: 0, elsewhere: 0, not_known: 0 });
  });

  it('lists the largest changes either way, each with the player\'s part, no fight before 5:00, and never the raw seconds', () => {
    expect(r.largest_changes.length).toBeLessThanOrEqual(LISTED);
    const sizes = r.largest_changes.map((f: any) => Math.abs(f.change));
    expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
    for (const f of r.largest_changes) {
      expect(f).not.toHaveProperty('from');
      expect(['in_it', 'dead', 'elsewhere', null]).toContain(f.me);
      expect(Number(f.clock.split(':')[0])).toBeGreaterThanOrEqual(FROM_MINUTE);
      expect(f.change).toBe(f.my_team_win_chance_after - f.my_team_win_chance_before);
    }
  });

  it('the last fight, which the game ended within two minutes of, is named and read against the result', () => {
    // 41:57–42:20, the Ancient down at 42:31: the chance after it is the result itself.
    expect(r.game_ended_on).toEqual({ ref: 'fight:16', clock: '41:57–42:20', my_team_win_chance_before: expect.any(Number), me: 'in_it' });
    const w: any = keyMoments(trace, { hero: 'phantom_assassin' }, { match });
    expect(w).toMatchObject({ result: 'my_team_won', game_ended_on: { ref: 'fight:16' } });
    // Each side's chances are the other's complement.
    expect(w.largest_changes.map((f: any) => [f.ref, f.my_team_win_chance_before + r.largest_changes.find((x: any) => x.ref === f.ref)?.my_team_win_chance_before])).toEqual(w.largest_changes.map((f: any) => [f.ref, 100]));
  });
});

describe('key_moments says when it cannot read the chance — never "no key moments"', () => {
  it('no gold lead (the committed trace without the record), a net-worth-only lead, or no Ancient down', () => {
    expect(keyMoments(trace, { hero: 'beastmaster' }, {})).toEqual({ ref: 'moments:beastmaster', ref_scope: 'summary', hero: 'beastmaster', read: false, gaps: [{ topic: 'key_moments', reason: 'no_gold_lead' }] });
    const nw = { ...trace, net_worth: trace.heroes.map(() => Array.from({ length: 43 }, (_, m) => m * 500)) };
    expect((keyMoments(nw, { hero: 'beastmaster' }, {}) as any).gaps).toEqual([{ topic: 'key_moments', reason: 'net_worth_only' }]);
    const noEnd = { ...trace, buildings: trace.buildings.filter((b: any) => !/_fort$/.test(trace.names[b[1]])) };
    expect(keyMoments(noEnd, { hero: 'beastmaster' }, { match })).toMatchObject({ read: false, gaps: [{ topic: 'key_moments', reason: 'game_end_not_known' }] });
    expect(keyMoments(trace, { hero: 'nobody' }, { match })).toMatchObject({ error: 'unknown_hero' });
  });

  it('a lead with a minute missing leaves the fights around it unread, with a gap, and they count in no share', () => {
    const holed = { radiant_gold_adv: real.radiant_gold_adv.map((v: number, m: number) => (m === 26 || m === 27 ? null : v)) };
    const r: any = keyMoments(trace, { hero: 'beastmaster' }, { match: holed });
    expect(r.fights_not_read).toBeGreaterThan(0);
    expect(r.gaps).toEqual([{ topic: 'key_moments', reason: expect.stringContaining('the gold lead does not cover that minute') }]);
    expect(r.largest_changes.every((f: any) => f.change != null)).toBe(true);
  });
});

describe('what the review found on #389', () => {
  it('a player elsewhere whose exact second was not sampled is placed where heroStateAt places them — never at a made-up spot', () => {
    // Fight 3 (6:08) from Axe's side: Axe was elsewhere. Blank his position at the fight's first second.
    const ax = trace.heroes.findIndex((x: any) => x.key === 'axe');
    const r0: any = keyMoments(trace, { hero: 'axe' }, { match });
    const f3 = [...r0.largest_changes, ...(r0.stretch?.fights ?? [])].find((f: any) => f.ref === 'fight:3');
    const from = Math.round(trace.deaths.filter((d: any) => d[0] >= 360 && d[0] < 380).sort((a: any, b: any) => a[0] - b[0])[0][0]);
    const states = trace.states.map((st: any, i: number) => (i === ax ? { ...st, x: st.x.map((v: any, k: number) => (k === from - trace.t0 ? null : v)), y: st.y.map((v: any, k: number) => (k === from - trace.t0 ? null : v)) } : st));
    const r: any = keyMoments({ ...trace, states }, { hero: 'axe' }, { match });
    const g = r.largest_changes.find((f: any) => f.ref === 'fight:3');
    expect([f3.me, f3.my_place, from]).toEqual(['elsewhere', 'radiant_top_lane', 368]);
    // With the exact second blanked, the neighbouring sample heroStateAt reads gives the same place — not river_mid,
    // which is where null coordinates land.
    expect([g.me, g.my_place]).toEqual(['elsewhere', 'radiant_top_lane']);
  });

  it('a fight in the minute the Ancient fell is read from that minute\'s opening state', () => {
    // Move the last fight's deaths to 42:01–42:20; the Ancient falls at 42:31; the model reads 42:00.
    const last = trace.deaths.filter((d: any) => d[0] >= 2510);
    const moved = trace.deaths.map((d: any) => (d[0] >= 2510 ? [2521 + (d[0] - last[0][0]) * 0.1, d[1], d[2], d[3]] : d));
    const r: any = keyMoments({ ...trace, deaths: moved }, { hero: 'beastmaster' }, { match });
    expect(r.game_ended_on).toMatchObject({ my_team_win_chance_before: expect.any(Number) });
    expect(r.game_ended_on.clock.startsWith('42:')).toBe(true);
  });
});

describe('key_moments reaches the model and the reader', () => {
  it('is offered as a tool, its ref resolves, and the prompt says how to read it — and not to quote the chances', () => {
    expect(KNOWLEDGE_TOOLS.map((t: any) => t.name)).toContain('key_moments');
    expect(KEY_MOMENTS_TOOL.description).toContain('not a verdict on whose fault a fight was');
    const ev: any = resolveRef(trace, 'moments:beastmaster', { hero: 'beastmaster', lang: 'zh', match });
    expect(ev).toMatchObject({ ref: 'moments:beastmaster', kind: 'moments', record: { read: true, falls_by_my_part: { in_it: 1 } } });
    expect(ev.record).not.toHaveProperty('largest_changes');
    expect(resolveRef(trace, 'moments:beastmaster:1', { hero: 'beastmaster', lang: 'zh', match })).toBeNull();
    const s = deepReviewSystem('zh');
    expect(s).toContain('6. Call key_moments for the player.');
    expect(s).toContain('write about it as one turn and cite those fights');
    expect(s).toContain('The chances are a ruler for ranking moments: never quote them');
    expect(s).toContain('(101 of 160 heroes on losing sides in the corpus)');
    // Not a verdict: a first wording ("in the fight 80% or more: the lost chance is not about where the player was")
    // made two of three Luna reviews — a game lost from the lanes, five lane deaths — say it was the enemy's doing.
    expect(s).toContain('It is not a verdict on the player: being in the fights does not clear them of what they did before 5:00');
    expect(s).not.toContain('the lost chance is not about where the player was');
    expect(s).toContain('elsewhere for half or more is rare (9 of 160)');
  });
});
