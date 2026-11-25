import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { calibrationRows, compareCalibration, zScore, MIN_CASES } from '../../lib/agent/calibrationDiff.js';

const KEPT = JSON.parse(readFileSync(new URL('../../data/calibration.v1.json', import.meta.url), 'utf8'));

describe('calibration diff: which quoted rates moved', () => {
  it('reads every table row with a count of cases, its outcomes over that count', () => {
    const rows = calibrationRows(KEPT);
    const fight = rows.find((r) => r.at === 'measures' && r.key === 'measure=more heroes took part');
    expect(fight).toMatchObject({ cases: 'fights', n: KEPT.measures[0].fights, outcomes: { side_ahead_won: KEPT.measures[0].side_ahead_won } });
    // A tier is a label, not an outcome; the rate is never read as one.
    const tower = rows.find((r) => r.at === 'after_towers_fell');
    expect(tower!.key).toMatch(/^tier=\d after_a_won_fight=(true|false)$/);
    expect(Object.keys(tower!.outcomes)).not.toContain('tier');
    expect(rows.every((r) => !('rate' in r.outcomes))).toBe(true);
    // Nested objects too: the Roshan fights.
    expect(rows.find((r) => r.at === 'roshans.fights_in_the_next_300s')).toBeTruthy();
  });

  it('the kept snapshot against itself: nothing moved, nothing new', () => {
    const r = compareCalibration(KEPT, KEPT);
    expect(r).toMatchObject({ shifted: [], new_rows: [], gone_rows: [] });
    expect(r.held).toBeGreaterThan(50);
  });

  it('lists a rate that moved beyond noise, and only that one', () => {
    const after = structuredClone(KEPT);
    const m = after.measures[0];
    m.fights *= 2; m.side_ahead_won = Math.round(m.fights * 0.5);
    after.games += 30;
    const r = compareCalibration(KEPT, after);
    expect(r.games).toEqual({ before: KEPT.games, after: KEPT.games + 30 });
    expect(r.shifted).toHaveLength(1);
    expect(r.shifted[0]).toMatchObject({ row: 'measures | fights | measure=more heroes took part', outcome: 'side_ahead_won', after: { rate: 50 } });
    expect(r.shifted[0].z).toBeLessThan(-2);
  });

  it('a small change on few cases is too few to call; a new or dropped row is named', () => {
    const before = { games: 1, rows: [{ case: 'a', fights: MIN_CASES - 1, won: 2 }, { case: 'b', fights: 100, won: 50 }] };
    const after = { games: 2, rows: [{ case: 'a', fights: MIN_CASES - 1, won: 15 }, { case: 'c', fights: 100, won: 50 }] };
    const r = compareCalibration(before, after);
    expect(r).toMatchObject({ shifted: [], too_few: 1, new_rows: ['rows | fights | case=c'], gone_rows: ['rows | fights | case=b'] });
  });

  it('z score: same rate is 0, a known gap is its textbook value', () => {
    expect(zScore(50, 100, 50, 100)).toBe(0);
    expect(zScore(50, 100, 70, 100)).toBeCloseTo(2.89, 2);
    expect(zScore(0, 0, 1, 2)).toBeNull();
  });

  it('the script exits 1 when a rate moved and 0 when none did', () => {
    const dir = mkdtempSync(join(tmpdir(), 'caldiff-'));
    const same = join(dir, 'same.json');
    writeFileSync(same, JSON.stringify(KEPT));
    const moved = structuredClone(KEPT); moved.measures[0].fights *= 2; moved.measures[0].side_ahead_won = Math.round(moved.measures[0].fights * 0.5);
    const other = join(dir, 'moved.json');
    writeFileSync(other, JSON.stringify(moved));
    const run = (...a: string[]) => { try { return { code: 0, out: execFileSync('node', ['scripts/calibrate-diff.mjs', ...a], { encoding: 'utf8' }) }; } catch (e: any) { return { code: e.status, out: String(e.stdout) }; } };
    expect(run(same).code).toBe(0);
    const r = run(other);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/1 rate\(s\) moved beyond noise/);
    expect(run().code).toBe(2);
  });
});
