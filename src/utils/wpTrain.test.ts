import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fit, foldOf, rowsOf, score } from '../../scripts/wp-train.mjs';
import { rowOf } from '../../scripts/wp-collect.mjs';
import { FEATURES, featuresOf, winProbability } from '../../packages/review-engine/src/value/winProb.js';

/** The win-probability model's training: what a collected game becomes, how it is split, and that the fit finds what is there. */

const match = () => ({
  match_id: 42, radiant_win: true, duration: 1250, human_players: 10, game_mode: 22, lobby_type: 7, patch: 61,
  radiant_gold_adv: Array.from({ length: 21 }, (_, m) => m * 100), radiant_xp_adv: Array.from({ length: 21 }, (_, m) => m * 50),
  players: Array.from({ length: 10 }, (_, i) => ({ player_slot: i < 5 ? i : 128 + i - 5, isRadiant: i < 5, rank_tier: i === 0 ? null : 40 + i, leaver_status: 0, xp_t: Array.from({ length: 21 }, (_, m) => m * 300) })),
  objectives: [{ type: 'building_kill', time: 700, key: 'npc_dota_badguys_tower1_mid' }, { type: 'CHAT_MESSAGE_ROSHAN_KILL', time: 900, team: 2 }, { type: 'CHAT_MESSAGE_FIRSTBLOOD', time: 80 }, { type: 'building_kill', key: 'npc_dota_badguys_tower2_mid' }],
});

describe('wp-collect: one parsed match → one row', () => {
  it('keeps the result, both series, each player\'s xp, the buildings in order and Roshan', () => {
    const r: any = rowOf(match());
    expect(r).toMatchObject({ id: 42, win: true, dur: 1250, patch: 61, mode: 22, lobby: 7, leaver: false, b: [[700, 'npc_dota_badguys_tower1_mid']], rosh: [[900, 2]] });
    // The mean of the nine players who have a rank: the one without is not counted as zero.
    expect(r.rank).toBe(45);
    expect(r.gold).toHaveLength(21);
    expect(r.xp_t.map((s: number[][]) => s.length)).toEqual([5, 5]);
  });

  it('says why a match is not kept', () => {
    const why = (over: object) => rowOf({ ...match(), ...over }).skip;
    expect(why({ human_players: 9 })).toBe('not_ten_players');
    expect(why({ game_mode: 23 })).toBe('game_mode');
    // All Pick in an unranked or a practice lobby, and ranked Captains Mode: another population, whoever filtered the ids.
    expect(why({ lobby_type: 0 })).toBe('not_ranked');
    expect(why({ lobby_type: 1 })).toBe('not_ranked');
    expect(why({ lobby_type: undefined })).toBe('not_ranked');
    expect(why({ game_mode: 2 })).toBe('game_mode');
    expect(why({ game_mode: 1 })).toBe('game_mode');
    expect(why({ duration: 899 })).toBe('under_15_minutes');
    expect(why({ radiant_gold_adv: null })).toBe('no_series');
    expect(why({ radiant_gold_adv: [0, 1, 2] })).toBe('series_shorter_than_the_game');
    expect(why({ radiant_win: null })).toBe('no_result');
    expect(rowOf(null).skip).toBe('no_result');
    const noXp = match(); noXp.players[3].xp_t = null as any;
    expect(rowOf(noXp).skip).toBe('no_player_xp');
  });

  it('a player who left marks the game; a disconnect that came back does not', () => {
    const left = match(); left.players[7].leaver_status = 3;
    expect(rowOf(left).leaver).toBe(true);
    const back = match(); back.players[7].leaver_status = 1;
    expect(rowOf(back).leaver).toBe(false);
  });
});

describe('wp-train', () => {
  it('one row per whole minute from 1:00, with the buildings fallen by then', () => {
    const rows = rowsOf(rowOf(match()));
    expect(rows.map((r: any) => r[2])).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(rows.every((r: any) => r[1] === 1)).toBe(true);
    // 11:00 is 660 s, before the tower at 700; 12:00 is after it.
    expect(rows[10][0]).toEqual(featuresOf({ minute: 11, gold: 1100, barracks: 0 }));
    // A barracks falls at 12:30: in the row of 13:00, not of 12:00.
    const withRax = rowsOf({ ...rowOf(match()), b: [[750, 'npc_dota_badguys_melee_rax_mid']] });
    expect(withRax[11][0]).toEqual(featuresOf({ minute: 12, gold: 1200, barracks: 0 }));
    expect(withRax[12][0]).toEqual(featuresOf({ minute: 13, gold: 1300, barracks: 1 }));
  });

  it('a game is in one part by its id, always the same, and the parts are about even', () => {
    const ids = Array.from({ length: 5000 }, (_, i) => 9_100_000_000 + i * 7919);
    const parts = ids.map((id) => foldOf(id, 5));
    expect(new Set(parts)).toEqual(new Set([0, 1, 2, 3, 4]));
    for (let k = 0; k < 5; k += 1) { const share = parts.filter((p) => p === k).length / ids.length; expect([k, share > 0.17 && share < 0.23]).toEqual([k, true]); }
    expect(ids.map((id) => foldOf(id, 5))).toEqual(parts);
  });

  it('the fit finds weights the data were drawn from, and scores better than gold alone when barracks matter', () => {
    // Games drawn from a known model: a seeded generator, so the test is the same every run.
    let seed = 12345; const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
    const truth = [0.1, -0.1, 0.5, 0.6];
    const rows: [number[], number][] = [];
    for (let i = 0; i < 20000; i += 1) {
      const minute = 1 + Math.floor(rnd() * 45);
      const x = featuresOf({ minute, gold: (rnd() - 0.5) * 2000 * Math.sqrt(minute), barracks: Math.round((rnd() - 0.5) * 4) })!;
      const p = 1 / (1 + Math.exp(-x.reduce((z, v, k) => z + v * truth[k], 0)));
      rows.push([x, rnd() < p ? 1 : 0]);
    }
    const w = fit(rows);
    expect(w).toHaveLength(FEATURES.length);
    w.forEach((v: number, k: number) => expect([FEATURES[k], Math.abs(v - truth[k]) < 0.08]).toEqual([FEATURES[k], true]));
    const goldOnly = fit(rows, [0, 1]);
    expect(goldOnly.slice(2)).toEqual([0, 0]);
    const full = score(w, rows); const gold = score(goldOnly, rows); const half = score(new Array(FEATURES.length).fill(0), rows);
    expect(full.brier).toBeLessThan(gold.brier);
    expect(gold.brier).toBeLessThan(half.brier);
    expect(half.brier).toBe(0.25);
    // Said and seen agree in every tenth that has rows to speak of.
    for (const c of full.calibration.filter((b: any) => b.rows > 500) as any[]) expect([c.said, Math.abs(c.mean_said - c.radiant_won) < 0.04]).toEqual([c.said, true]);
  });

  it('the model file in the repo is one the function reads, with what it was trained on', () => {
    const model = JSON.parse(readFileSync(new URL('../../packages/review-engine/src/value/wp.v1.json', import.meta.url), 'utf8'));
    expect(model.schema).toBe('dota2.ai/win-probability@1');
    expect(model.features).toEqual(FEATURES);
    expect(model.weights).toHaveLength(FEATURES.length);
    expect(model.data.games_fitted_on).toBeGreaterThan(1000);
    expect(model.data.left_out_with_a_leaver).toBeGreaterThanOrEqual(0);
    // Fitted on ranked All Pick only: what else the data file held is counted, not used.
    expect(model.data.left_out_not_ranked_all_pick).toBeGreaterThanOrEqual(0);
    expect(model.data.games_collected - model.data.left_out_not_ranked_all_pick - model.data.left_out_with_a_leaver).toBe(model.data.games_fitted_on);
    // It was written only because, on games each fit had not seen, it beat the gold lead alone — which beats 50%.
    const cv = model.cross_validated;
    expect(cv.model.brier).toBeLessThan(cv.gold_lead_alone.brier);
    expect(cv.gold_lead_alone.brier).toBeLessThan(cv.always_half.brier);
    // What it says is what happened, in every tenth: within three points.
    for (const c of cv.calibration) expect([c.said, c.rows > 1000, Math.abs(c.mean_said - c.radiant_won) < 0.03]).toEqual([c.said, true, true]);
    // A lead counts for something at every minute it is read at, and for less the later it is.
    const at = (minute: number) => winProbability(model, { minute, gold: 5000, barracks: 0 })!;
    expect(at(10)).toBeGreaterThan(at(25));
    expect(at(25)).toBeGreaterThan(at(50));
    expect(at(60)).toBeGreaterThan(0.5);
    expect(winProbability(model, { minute: 30, gold: 0, barracks: 1 })!).toBeGreaterThan(winProbability(model, { minute: 30, gold: 0, barracks: 0 })!);
  });
});
