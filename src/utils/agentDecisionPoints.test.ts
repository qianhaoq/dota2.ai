import { describe, expect, it } from 'vitest';
import { readFileSync, mkdtempSync, copyFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { gunzipSync, gzipSync } from 'node:zlib';
import { decisionPoints, afterWonFights, afterTowersFell, fightsAfterBigItems, richestOf, DECISION_TOOL, AFTER_SECONDS, ITEM_SECONDS, LONG_RESPAWN } from '../../lib/agent/decisionPoints.js';
import { resolveRef } from '../../lib/agent/evidence.js';
import { KNOWLEDGE_TOOLS } from '../../lib/agent/knowledgeTools.js';
import { deepReviewSystem, reviewToolkit, verifyReview } from '../../lib/agent/deepReview.js';
import { chatSystem } from '../../lib/agent/chat.js';
import { runTraceTool, matchFights, fightParticipation } from '../../packages/review-engine/src/trace/index.js';

const FIXTURE = new URL('../../packages/review-engine/test/fixtures/trace-9100904020.json.gz', import.meta.url);
/** A real ranked game (9100904020): Beastmaster on Dire, lost in 42:31. */
const trace = JSON.parse(gunzipSync(readFileSync(FIXTURE)).toString());

describe('decision_points: what each side did with the fights it won', () => {
  const all: any = decisionPoints(trace, { hero: 'beastmaster' });
  // This block reads the won-fight points; the tower points are the next block's.
  const r: any = { ...all, points: all.points.filter((p: any) => p.kind === 'after_a_won_fight') };

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

  it('a push begun during the fight and still going after it is listed, with the player\'s hits in the window (review of #306)', () => {
    const pa: any = decisionPoints(trace, { hero: 'phantom_assassin' });
    const p = pa.points.find((x: any) => x.fight === 'fight:16');
    expect(p).toMatchObject({ won_by: 'my_team', winners_did: 'took_a_building', me: 'hit_a_building' });
    expect(p.pushes).toEqual([expect.objectContaining({ building: 'badguys_fort', took_it: true, hitting: expect.arrayContaining(['phantom_assassin']) })]);
  });

  it('a single hit on a building counts as hitting one, though too short to be a push (review of #306)', () => {
    // Undying hits a tower at 1444 after fight 8, Skywrath Mage at 874 and 876 after fight 6: no push run of three.
    expect((decisionPoints(trace, { hero: 'undying' }) as any).points.find((x: any) => x.fight === 'fight:8').me).toBe('hit_a_building');
    expect((decisionPoints(trace, { hero: 'skywrath_mage' }) as any).points.find((x: any) => x.fight === 'fight:6').me).toBe('hit_a_building');
  });

  it('a push is taken only when its building fell inside the window, as buildings_winners_took says (review of #306)', () => {
    // Fight 15 ends at 2363.1; the tier-4 it pushed falls at 2506, after the 120 s.
    const p = r.points.find((x: any) => x.fight === 'fight:15');
    for (const q of p.pushes.filter((x: any) => x.took_it)) expect(p.buildings_winners_took.map((b: any) => b.building)).toContain(q.building);
    expect(p.pushes.some((x: any) => /tower4/.test(x.building) && !x.took_it)).toBe(true);
    for (const x of r.points) for (const q of x.pushes.filter((y: any) => y.took_it)) expect(x.buildings_winners_took.map((b: any) => b.building)).toContain(q.building);
  });

  it('a building its own side denied is nobody\'s objective, as tempo_report counts it (review of #306)', () => {
    const denied = JSON.parse(JSON.stringify(trace));
    const fights = matchFights(denied);
    const f = fights[7];
    // A Dire tower destroyed by Dire itself, five seconds into fight 8.
    const name = 'npc_dota_badguys_tower2_bot';
    let id = denied.names.indexOf(name); if (id < 0) { denied.names.push(name); id = denied.names.length - 1; }
    denied.buildings = denied.buildings.filter((b: any) => !(b[0] >= f.from && b[0] <= f.to + 120)).concat([[f.from + 5, id, 3, 0]]);
    const before = (decisionPoints(denied, { hero: 'axe' }) as any).points.find((x: any) => x.fight === 'fight:8');
    expect(before.buildings_winners_took).toEqual([]);
    expect(before.losers_took_back).toEqual([]);
    expect(before.winners_did).not.toBe('took_a_building');
    // A push on a building its owners then denied did not take it either.
    const t2 = JSON.parse(JSON.stringify(trace));
    const f8 = matchFights(t2)[7];
    const rows = t2.buildings.filter((b: any) => b[0] >= f8.from && b[0] <= f8.to + 120 && /goodguys|badguys/.test(t2.names[b[1]]));
    expect(rows.length).toBeGreaterThan(0);
    {
      // Every building that fell in the window, destroyed by its own side.
      for (const r of rows) r[2] = /goodguys/.test(t2.names[r[1]]) ? 2 : 3;
      const p8 = (decisionPoints(t2, { hero: 'axe' }) as any).points.find((x: any) => x.fight === 'fight:8');
      expect(p8.buildings_winners_took).toEqual([]);
      for (const q of p8.pushes) expect(q.took_it).toBe(false);
    }
  });

  it('refs resolve; one moment\'s facts need its own ref; the model gets the tool and the rule', () => {
    const one = resolveRef(trace, r.points[0].ref, { hero: 'beastmaster', lang: 'zh' })!;
    expect(one.record.fight).toBe(r.points[0].fight);
    expect(resolveRef(trace, 'decision:beastmaster', { hero: 'beastmaster' })?.record).not.toHaveProperty('points');
    expect(resolveRef(trace, `decision:beastmaster:${all.points.length + 1}`, { hero: 'beastmaster' })).toBeNull();
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

describe('decision_points: after a tier 1–3 tower fell', () => {
  const r: any = decisionPoints(trace, { hero: 'beastmaster' });
  const towers = r.points.filter((p: any) => p.kind === 'after_a_tower_fell');

  it('the fight points keep their numbers; tower points follow them, one per tower taken by the other side', () => {
    const fights = r.points.filter((p: any) => p.kind === 'after_a_won_fight');
    expect(r.points.slice(0, fights.length)).toEqual(fights);
    expect(r.points.map((p: any) => p.ref)).toEqual(r.points.map((_: any, i: number) => `decision:beastmaster:${i + 1}`));
    const fell = trace.buildings.filter((b: any) => /_tower[123]_(top|mid|bot)$/.test(trace.names[b[1]]) && b[2] !== (/goodguys/.test(trace.names[b[1]]) ? 2 : 3));
    expect(towers).toHaveLength(fell.length);
    expect(towers.length).toBeGreaterThan(0);
    expect(r.fights_my_team_won + r.fights_enemy_won).toBe(fights.length);
  });

  it('what the takers did agrees with what fell; a push took its building only if it is listed; mirrored from the other side', () => {
    for (const p of towers) {
      expect(p.takers_did === 'took_another_building').toBe(p.buildings_takers_took_next.length > 0);
      for (const q of p.pushes.filter((x: any) => x.took_it)) expect(p.buildings_takers_took_next.map((b: any) => b.building)).toContain(q.building);
      expect(p.me === 'hit_it').toBe(p.hitting.includes('beastmaster'));
      if (p.me === 'near' || p.me === 'elsewhere') expect(p.me === 'near').toBe(p.distance_from_its_hitters <= 1800);
    }
    const other: any = decisionPoints(trace, { hero: 'axe' });
    expect(other.towers_my_team_took).toEqual(r.towers_enemy_took);
    expect(other.towers_enemy_took).toEqual(r.towers_my_team_took);
    const mine = towers.filter((p: any) => p.taken_by === 'my_team');
    expect(r.towers_my_team_took.towers).toBe(mine.length);
    expect(r.towers_my_team_took.lost_a_building_meanwhile).toBe(mine.filter((p: any) => p.owners_took_back.length).length);
    const w = r.when_my_team_lost_a_tower_i_was;
    expect(w.near_it + w.was_dead + w.elsewhere + w.not_known).toBe(w.towers);
    expect(w.towers).toBe(r.towers_enemy_took.towers);
  });

  it('a tower its own side denied is no point; one that fell in a won fight\'s window names that fight', () => {
    const t2 = JSON.parse(JSON.stringify(trace));
    const row = t2.buildings.find((b: any) => /_tower1_/.test(t2.names[b[1]]));
    row[2] = /goodguys/.test(t2.names[row[1]]) ? 2 : 3;
    expect(afterTowersFell(t2)).toHaveLength(afterTowersFell(trace).length - 1);
    const wins = afterWonFights(trace);
    for (const x of afterTowersFell(trace)) {
      const w = wins.find((f: any) => f.winner === x.taker && x.at >= f.from && x.at <= f.to + AFTER_SECONDS);
      expect(x.fight).toBe(w ? w.fight : null);
    }
  });

  it('refs resolve with the player\'s place named; the review and the chat are told what "elsewhere" does not show', () => {
    const p = towers.find((x: any) => x.my_place) ?? towers[0];
    const one = resolveRef(trace, p.ref, { hero: 'beastmaster', lang: 'zh' })!;
    expect(one.record.kind).toBe('after_a_tower_fell');
    if (p.my_place) expect(one.names[p.my_place]).toBeTruthy();
    expect(DECISION_TOOL.description).toContain('after_a_tower_fell');
    expect(deepReviewSystem('zh')).toContain('kind after_a_tower_fell');
    expect(deepReviewSystem('zh')).toMatch(/"elsewhere" when a tower fell was not necessarily wrong/);
    expect(chatSystem('zh')).toContain('after_a_tower_fell');
  });

  it('the calibration script reports what followed a tower, by tier and whether a won fight came first', () => {
    const dir = mkdtempSync(join(tmpdir(), 'towers-'));
    copyFileSync(FIXTURE, join(dir, '9100904020.trace.json.gz'));
    const out = JSON.parse(execFileSync('node', ['scripts/calibrate.mjs', dir, '--json'], { encoding: 'utf8' }));
    expect(out.after_towers_fell).toHaveLength(6);
    expect(out.after_towers_fell.reduce((n: number, x: any) => n + x.towers, 0)).toBe(afterTowersFell(trace).length);
  });
});

describe('decision_points: fights begun soon after a big item', () => {
  const r: any = decisionPoints(trace, { hero: 'beastmaster' });
  const fights = r.points.filter((p: any) => p.kind === 'fight_after_a_big_item');

  it('they follow the tower points; each lists the big items first held in the 120 s before the fight, of either side', () => {
    const before = r.points.filter((p: any) => p.kind !== 'fight_after_a_big_item');
    expect(r.points.slice(0, before.length)).toEqual(before);
    expect(fights.length).toBeGreaterThan(0);
    expect(ITEM_SECONDS).toBe(120);
    // From the fight's first damage exchange, not its first death (review of #310).
    const from = (p: any) => fightParticipation(trace, matchFights(trace)[Number(p.fight.split(':')[1]) - 1]).engaged_at;
    const sec = (c: string) => { const [m, s2] = c.split(':').map(Number); return m * 60 + s2; };
    for (const p of fights) {
      expect(p.items.length).toBeGreaterThan(0);
      expect(p.clock).toBe(`${Math.floor(from(p) / 60)}:${String(Math.floor(from(p) % 60)).padStart(2, '0')}`);
      for (const it of p.items) { expect(sec(it.clock)).toBeLessThanOrEqual(Math.floor(from(p))); expect(sec(it.clock)).toBeGreaterThanOrEqual(Math.floor(from(p) - 121)); expect(it.ref).toBe(`item:${it.hero}:${it.item}`); }
      const sides = new Set(p.items.map((it: any) => it.side));
      expect(p.items_from).toBe(sides.size === 2 ? 'both' : [...sides][0]);
      expect(p.lost_fewer).toBe(p.deaths.my_team < p.deaths.enemy ? 'my_team' : p.deaths.my_team > p.deaths.enemy ? 'enemy' : 'even');
    }
  });

  it('items are big as power_spikes and window_report call them: Blink and BKB, not a component; mirrored from the other side', () => {
    const all = fightsAfterBigItems(trace).fights.flatMap((x: any) => x.items.map((it: any) => it.item));
    expect(all).toContain('black_king_bar');
    expect(all).not.toContain('ogre_axe');
    const other: any = decisionPoints(trace, { hero: 'axe' });
    expect(other.fights_after_enemy_big_items.fights).toBe(r.fights_after_my_team_big_items.fights);
    expect(other.fights_after_my_team_big_items).toEqual({ fights: r.fights_after_enemy_big_items.fights, my_team_lost_fewer: r.fights_after_enemy_big_items.enemy_lost_fewer, enemy_lost_fewer: r.fights_after_enemy_big_items.my_team_lost_fewer, even: r.fights_after_enemy_big_items.even });
    const only = fights.filter((p: any) => p.items_from === 'enemy');
    expect(r.fights_after_enemy_big_items.fights).toBe(only.length);
  });

  it('refs resolve with the items named; the review is told a fresh item mostly marks the richer side', () => {
    const p = fights[0];
    const one = resolveRef(trace, p.ref, { hero: 'beastmaster', lang: 'zh' })!;
    expect(one.record.kind).toBe('fight_after_a_big_item');
    expect(one.names[p.items[0].item]).toBeTruthy();
    expect(DECISION_TOOL.description).toContain('fight_after_a_big_item');
    expect(deepReviewSystem('zh')).toMatch(/say a fresh item came with the gold lead, not that it won the fight by itself/);
    expect(chatSystem('zh')).toContain('fight_after_a_big_item');
  });

  it('the calibration script splits these fights by the item side\'s gold lead, beside the gold-ahead side\'s rate otherwise', () => {
    const dir = mkdtempSync(join(tmpdir(), 'items-'));
    copyFileSync(FIXTURE, join(dir, '9100904020.trace.json.gz'));
    const out = JSON.parse(execFileSync('node', ['scripts/calibrate.mjs', dir, '--json'], { encoding: 'utf8' }));
    const fb = out.fights_after_big_items;
    expect(Object.keys(fb)).toEqual(['one_side_only', 'item_side_ahead_in_gold', 'item_side_behind_in_gold', 'no_fresh_big_item']);
    expect(fb.item_side_ahead_in_gold.fights + fb.item_side_behind_in_gold.fights).toBeLessThanOrEqual(fb.one_side_only.fights);
  });
});

describe('decision_points: whether the losers\' richest hero was still dead after a won fight', () => {
  // The fixture has no money by minute: give every hero a flat series, the first Dire hero the most.
  const minutes = Math.ceil((trace.t0 + trace.n) / 60) + 1;
  const rich = trace.heroes.findIndex((h: any) => h.team === 3);
  const withMoney = { ...trace, net_worth: trace.heroes.map((_: any, i: number) => Array.from({ length: minutes }, () => (i === rich ? 9000 : 3000 + i))) };

  it('no money by minute: no field and no count — unknown, not "alive"', () => {
    const r: any = decisionPoints(trace, { hero: 'beastmaster' });
    expect(r).not.toHaveProperty('money_source');
    expect(r.points.some((p: any) => 'losers_richest' in p)).toBe(false);
  });

  it('with it, each won fight names the losers\' richest and whether they were still dead, as the respawn list says', () => {
    const r: any = decisionPoints(withMoney, { hero: 'axe' });
    expect(r.money_source).toBe('replay_net_worth');
    const fights = r.points.filter((p: any) => p.kind === 'after_a_won_fight');
    for (const p of fights) {
      const loserTeam = p.won_by === 'my_team' ? 3 : 2;
      const expected = richestOf(withMoney, { series: new Map(withMoney.heroes.map((h: any, i: number) => [h.key, withMoney.net_worth[i]])), last: minutes - 1 }, loserTeam, 0);
      expect(p.losers_richest.hero).toBe(withMoney.heroes[expected!].key);
      const row = p.losers_respawn_in.find((x: any) => x.hero === p.losers_richest.hero);
      expect(p.losers_richest.still_dead_10s_after).toBe(row != null);
      if (row) expect(p.losers_richest.respawn_in).toBe(row.seconds);
    }
    const long = fights.filter((p: any) => p.won_by === 'my_team' && p.losers_richest.still_dead_10s_after && p.losers_richest.respawn_in >= LONG_RESPAWN);
    expect(r.my_team_wins_with_enemy_richest_long_dead.fights).toBe(long.length);
  });

  it('a tie for richest is no richest; the review is told what the corpus says', () => {
    const tied = { ...withMoney, net_worth: withMoney.heroes.map(() => Array.from({ length: minutes }, () => 5000)) };
    const money = { series: new Map(tied.heroes.map((h: any, i: number) => [h.key, tied.net_worth[i]])), last: minutes - 1 };
    expect(richestOf(tied, money, 3, 10)).toBeNull();
    expect(richestOf(tied, null, 3, 10)).toBeNull();
    expect(deepReviewSystem('zh')).toMatch(/losers_richest, 30 s or more from respawning\): in the corpus such wins took a building in 38 of 60/);
    expect(chatSystem('zh')).toContain('whether their richest hero was one of them');
  });

  it('the calibration script splits wins with three or more still dead by the losers\' richest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'richest-'));
    writeFileSync(join(dir, '1.trace.json.gz'), gzipSync(JSON.stringify(withMoney)));
    const out = JSON.parse(execFileSync('node', ['scripts/calibrate.mjs', dir, '--json'], { encoding: 'utf8' }));
    const rows = out.after_won_fights_three_or_more_still_dead_by_losers_richest;
    expect(rows.map((x: any) => x.losers_richest)).toEqual(['dead_30s_or_more', 'dead_under_30s', 'alive']);
    expect(rows.reduce((n: number, x: any) => n + x.fights, 0)).toBe(afterWonFights(withMoney).filter((x: any) => x.still_dead.length >= 3).length);
  });
});

