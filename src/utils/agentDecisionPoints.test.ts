import { describe, expect, it } from 'vitest';
import { readFileSync, mkdtempSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { decisionPoints, afterWonFights, DECISION_TOOL, AFTER_SECONDS } from '../../lib/agent/decisionPoints.js';
import { resolveRef } from '../../lib/agent/evidence.js';
import { KNOWLEDGE_TOOLS } from '../../lib/agent/knowledgeTools.js';
import { deepReviewSystem, reviewToolkit, verifyReview } from '../../lib/agent/deepReview.js';
import { chatSystem } from '../../lib/agent/chat.js';
import { runTraceTool, matchFights } from '../../packages/review-engine/src/trace/index.js';

const FIXTURE = new URL('../../packages/review-engine/test/fixtures/trace-9100904020.json.gz', import.meta.url);
/** A real ranked game (9100904020): Beastmaster on Dire, lost in 42:31. */
const trace = JSON.parse(gunzipSync(readFileSync(FIXTURE)).toString());

describe('decision_points: what each side did with the fights it won', () => {
  const r: any = decisionPoints(trace, { hero: 'beastmaster' });

  it('one point per fight with a winner, told from the player\'s side, mirrored from the other', () => {
    const won = matchFights(trace).length;
    expect(r.points.length).toBe(r.fights_my_team_won + r.fights_enemy_won);
    expect(r.points.length).toBeLessThanOrEqual(won);
    const other: any = decisionPoints(trace, { hero: 'axe' });
    expect(other.fights_my_team_won).toBe(r.fights_enemy_won);
    expect(other.my_team_after_its_wins).toEqual(r.enemy_after_its_wins);
    for (const p of r.points) {
      expect(p.losers_respawn_in).toHaveLength(p.losers_still_dead_10s_after);
      expect(['took_a_building', 'took_roshan', 'pushed_and_took_nothing', 'neither']).toContain(p.winners_did);
      expect(p.winners_did === 'took_a_building').toBe(p.buildings_winners_took.length > 0);
    }
  });

  it('never disagrees with tempo_report: the wins it says were followed by a building are the ones tempo_report lists', () => {
    expect(AFTER_SECONDS).toBe(120);
    const tempo: any = runTraceTool(trace, 'tempo_report', { hero: 'beastmaster' });
    const startOf = (fight: string) => { const f = matchFights(trace)[Number(fight.split(':')[1]) - 1]; return `${Math.floor(f.from / 60)}:${String(Math.floor(f.from % 60)).padStart(2, '0')}`; };
    const mine = r.points.filter((p: any) => p.won_by === 'my_team' && p.winners_did === 'took_a_building').map((p: any) => startOf(p.fight));
    const theirs = r.points.filter((p: any) => p.won_by === 'enemy' && p.winners_did === 'took_a_building').map((p: any) => startOf(p.fight));
    expect(mine).toEqual(tempo.fights_where.team_lost_fewer_heroes_and_took_a_building_within_120s);
    expect(theirs).toEqual(tempo.fights_where.opponents_lost_fewer_heroes_and_took_a_building_within_120s);
  });

  it('a building that fell during the fight counts, and says so; the losers\' respawns are listed', () => {
    const during = afterWonFights(trace).flatMap((x: any) => x.took.filter((b: any) => b[0] <= x.to));
    const p = r.points.find((x: any) => x.buildings_winners_took.some((b: any) => b.during_the_fight));
    if (during.length) expect(p).toBeTruthy();
    for (const x of r.points) for (const d of x.losers_respawn_in) expect(d.seconds === null || d.seconds > 0).toBe(true);
  });

  it('refs resolve; one moment\'s facts need its own ref; the model gets the tool and the rule', () => {
    const one = resolveRef(trace, r.points[0].ref, { hero: 'beastmaster', lang: 'zh' })!;
    expect(one.record.fight).toBe(r.points[0].fight);
    expect(resolveRef(trace, 'decision:beastmaster', { hero: 'beastmaster' })?.record).not.toHaveProperty('points');
    expect(resolveRef(trace, `decision:beastmaster:${r.points.length + 1}`, { hero: 'beastmaster' })).toBeNull();
    const record = reviewToolkit({ trace, hero: 'beastmaster', lang: 'zh' })!.runTool('decision_points', { hero: 'beastmaster' });
    const ev = (refs: string[], fact: string) => verifyReview({ verdict: 'v', mainline: [], findings: [], game_plan: { course: 'c', evidence: [{ refs, fact }] } }, [record]).problems.filter((x: any) => x.where === 'plan_evidence');
    expect(ev([r.points[0].ref], `${r.points[0].clock} 那波团后对面还有 ${r.points[0].losers_still_dead_10s_after} 人没复活。`)).toEqual([]);
    expect(ev(['decision:beastmaster'], `${r.points[0].clock} 那波团后对面还有 ${r.points[0].losers_still_dead_10s_after} 人没复活。`)).not.toEqual([]);
    expect(KNOWLEDGE_TOOLS).toContain(DECISION_TOOL);
    expect(deepReviewSystem('zh')).toContain('6d. decision_points for the player');
    expect(deepReviewSystem('zh')).toMatch(/say it did not take anything, not that it "did nothing"/);
    expect(chatSystem('zh')).toContain('decision_points for the player');
  });

  it('the calibration script reports what winners did, by losers still dead', () => {
    const dir = mkdtempSync(join(tmpdir(), 'decisions-'));
    copyFileSync(FIXTURE, join(dir, '9100904020.trace.json.gz'));
    const out = JSON.parse(execFileSync('node', ['scripts/calibrate.mjs', dir, '--json'], { encoding: 'utf8' }));
    expect(out.after_won_fights.map((x: any) => x.losers_still_dead_10s_after)).toEqual(['0', '1', '2', '3', '4 or more']);
    expect(out.after_won_fights.reduce((n: number, x: any) => n + x.fights, 0)).toBe(afterWonFights(trace).length);
  });
});
