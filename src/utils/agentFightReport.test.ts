import { describe, expect, it } from 'vitest';
import { readFileSync, mkdtempSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { fightReport, gameState, ultimateEdges, FIGHT_TOOLS } from '../../lib/agent/fightReport.js';
import { resolveRef } from '../../lib/agent/evidence.js';
import { KNOWLEDGE_TOOLS } from '../../lib/agent/knowledgeTools.js';
import { reviewToolkit, deepReviewSystem, verifyReview, DEEP_REVIEW_PROMPT_VERSION } from '../../lib/agent/deepReview.js';
import { chatSystem } from '../../lib/agent/chat.js';
import { fightParticipation, heroStateAt, matchFights, matchOverview } from '../../packages/review-engine/src/trace/index.js';

const FIXTURE = new URL('../../packages/review-engine/test/fixtures/trace-9100904020.json.gz', import.meta.url);
/** A real ranked game (9100904020): Beastmaster on Dire, lost in 42:31. */
const trace = JSON.parse(gunzipSync(readFileSync(FIXTURE)).toString());

/**
 * A small hand-made trace: heroes stand where `pos` says (else at their fountain side), `damage` rows are
 * [second, attacker key, target key], `deaths` [second, victim key]. Ten seconds a row of states is plenty.
 */
function synth({ n = 200, heroes, damage = [], deaths = [], pos = {}, dead = {}, abilities = {}, items = {}, mana = 500 }: any) {
  const H = heroes.map(([key, team]: [string, number], i: number) => ({ key, npc: `npc_dota_hero_${key}`, team, player_index: i }));
  const names = H.map((h: any) => h.npc);
  const id = (k: string) => names.indexOf(`npc_dota_hero_${k}`);
  return {
    schema: 'dota2.ai/match-trace@1', match_id: 1, t0: 0, n, heroes: H, names,
    states: H.map((h: any) => {
      const p = pos[h.key] ?? (h.team === 2 ? [-3000, -3000] : [3000, 3000]);
      const deadFrom = dead[h.key];
      return {
        x: Array(n).fill(p[0]), y: Array(n).fill(p[1]), hp: Array(n).fill(500), max_hp: Array(n).fill(1000), mana: Array(n).fill(mana), level: Array(n).fill(12),
        alive: Array.from({ length: n }, (_, i) => (deadFrom && i >= deadFrom[0] && i < deadFrom[1] ? 0 : 1)), mana_peak: Array(n).fill(mana),
      };
    }),
    abilities: H.map((h: any) => abilities[h.key] ?? {}),
    items: H.map((h: any) => items[h.key] ?? {}),
    controls: H.map(() => ({})),
    casts: [], item_uses: [], purchases: [], buildings: [], modifiers: [],
    damage: damage.map(([s, a, t]: any) => [s, id(a), id(t), -1, 100]),
    deaths: deaths.map(([s, v]: any) => [s, id(v), -1, 0]),
    net_worth: [],
    gaps: [],
  };
}

describe('fight_report on a real game', () => {
  const r: any = fightReport(trace, { hero: 'beastmaster' });

  it('reads the same fights as match_overview, in the same order, and accounts for all ten heroes in each', () => {
    const overview: any = matchOverview(trace, {});
    expect(r.fights.map((f: any) => f.fight)).toEqual(overview.fights.map((f: any) => f.ref));
    expect(r.fights_total).toBe(16);
    for (const f of r.fights) {
      for (const side of [f.my_team, f.enemy]) {
        expect(side.took_part_count).toBe(side.took_part.length);
        expect(side.took_part.length + side.not_in_it.length).toBe(5);
      }
      expect(f.my_team.deaths + f.enemy.deaths).toBeGreaterThanOrEqual(3);
    }
  });

  it('fight 9 (25:25): three of ours against four, the carry across the map, Skywrath near with a TP ready, their PA with BKB ready', () => {
    const f = r.fights.find((x: any) => x.fight === 'fight:9');
    expect(f).toMatchObject({ ref: 'fights:beastmaster:9', clock: '25:25', engaged_at: '25:10', lost_fewer_heroes: 'enemy', more_heroes_took_part: 'enemy', me: 'took_part' });
    expect(f.my_team.took_part).toEqual(['beastmaster', 'undying', 'dark_willow']);
    expect(f.enemy.took_part_count).toBe(4);
    expect(f.my_team.not_in_it).toEqual([
      { hero: 'sven', doing: 'none_of_these', place: 'dire_bot_lane', distance: 14151, tp_ready: null },
      { hero: 'skywrath_mage', doing: 'none_of_these', place: 'radiant_top_lane', distance: 1631, tp_ready: true },
    ]);
    expect(f.enemy.not_in_it).toEqual([{ hero: 'mirana', doing: 'dead', respawn_in: 32 }]);
    expect(f.enemy.black_king_bars_ready).toEqual(['phantom_assassin']);
    expect(f.my_team.ultimates_ready.map((u: any) => u.hero)).toEqual(['beastmaster', 'dark_willow']);
    expect(f.my_team.ultimates_not_ready).toEqual([{ hero: 'undying', ability: 'undying_flesh_golem', why: 'cooldown', seconds_left: 124 }]);
    expect(r.lost_fights_with_an_ally_alive_tp_ready_not_in_it).toContainEqual({ fight: 'fight:9', clock: '25:25', hero: 'skywrath_mage', place: 'radiant_top_lane', distance: 1631 });
  });

  it('fight 1 (2:35) is the two-on-two at the deaths, not the exchanges elsewhere on the map at the same time (review of #296)', () => {
    const f = r.fights[0];
    expect(f).toMatchObject({ fight: 'fight:1', clock: '2:35', engaged_at: '2:23' });
    expect(f.my_team.took_part).toEqual(['beastmaster', 'undying']);
    expect(f.enemy.took_part).toEqual(['phantom_assassin', 'venomancer']);
    // Skywrath was trading damage with Necrophos elsewhere: not in this fight, and said to be busy.
    expect(f.my_team.not_in_it).toContainEqual(expect.objectContaining({ hero: 'skywrath_mage', doing: 'trading_damage_with_enemy_heroes' }));
  });

  it('a claim about one fight cannot be carried by the summary ref; it needs that fight\'s own (review of #296)', () => {
    const kit: any = reviewToolkit({ trace, hero: 'beastmaster', lang: 'en' });
    const record = kit.runTool('fight_report', { hero: 'beastmaster' });
    expect(record.ref_scope).toBe('summary');
    const ev = (refs: string[], fact: string) => verifyReview({ verdict: 'v', mainline: [], findings: [], game_plan: { course: 'c', evidence: [{ refs, fact }] } }, [record]).problems.filter((p: any) => p.where === 'plan_evidence');
    expect(ev(['fights:beastmaster'], 'At 25:25, the carry was 14151 units away.')).not.toEqual([]);
    expect(ev(['fights:beastmaster:9'], 'At 25:25, the carry was 14151 units away.')).toEqual([]);
    expect(ev(['fights:beastmaster'], `${r.fights_total} fights in the game.`)).toEqual([]);
  });

  it('without the replay\'s own net worth, the match record\'s gold lead is used, as match_overview does (review of #296)', () => {
    const match: any = { radiant_gold_adv: Array.from({ length: 43 }, (_, m) => m * 100) };
    expect(r.fights[8]).not.toHaveProperty('my_team_gold_lead');
    const kit: any = reviewToolkit({ trace, hero: 'beastmaster', lang: 'en', match });
    // Beastmaster is Dire: Radiant's +2500 at 25:00 is his team's -2500.
    expect(kit.runTool('fight_report', { hero: 'beastmaster' }).fights[8].my_team_gold_lead).toBe(-2500);
    expect(kit.runTool('game_state', { hero: 'beastmaster', at: 1510 }).my_team_gold_lead).toBe(-2500);
    expect(resolveRef(trace, 'fights:beastmaster:9', { hero: 'beastmaster', match })?.record.my_team_gold_lead).toBe(-2500);
    expect(resolveRef(trace, 'state:beastmaster:1510', { hero: 'beastmaster', match })?.record.my_team_gold_lead).toBe(-2500);
    // Places are named on the card.
    expect(resolveRef(trace, 'fights:beastmaster:9', { hero: 'beastmaster', lang: 'zh' })?.names.dire_bot_lane).toBe('夜魇下路');
  });

  it('the same fight read from the other side is the mirror', () => {
    const other: any = fightReport(trace, { hero: 'axe' });
    r.fights.forEach((f: any, i: number) => {
      const o = other.fights[i];
      expect(o.my_team.took_part).toEqual(f.enemy.took_part);
      expect(o.enemy.not_in_it).toEqual(f.my_team.not_in_it);
      expect(o.lost_fewer_heroes).toBe(f.lost_fewer_heroes === 'even' ? 'even' : f.lost_fewer_heroes === 'my_team' ? 'enemy' : 'my_team');
    });
    expect(other.fights_with_more_of_my_team).toBe(r.fights_with_more_of_the_enemy);
  });

  it('every record resolves by its ref, as an evidence card shows it', () => {
    expect(resolveRef(trace, 'fights:beastmaster:9', { hero: 'beastmaster' })?.record.my_team.took_part_count).toBe(3);
    expect(resolveRef(trace, 'fights:beastmaster', { hero: 'beastmaster' })?.record).toMatchObject({ fights_total: 16, fights_with_more_of_my_team: r.fights_with_more_of_my_team });
    expect(resolveRef(trace, 'state:beastmaster:1510', { hero: 'beastmaster' })?.record.clock).toBe('25:10');
    expect(resolveRef(trace, 'fights:beastmaster:17', { hero: 'beastmaster' })).toBeNull();
    expect(resolveRef(trace, 'state:beastmaster:99999', { hero: 'beastmaster' })).toBeNull();
    // A second before the horn is a game time like any other (review of #296).
    const early: any = { ...synth({ heroes: [['axe', 2], ['pudge', 3]] }), t0: -90 };
    const pre: any = gameState(early, { hero: 'axe', at: -30 });
    expect(pre.ref).toBe('state:axe:-30');
    expect(resolveRef(early, pre.ref, { hero: 'axe' })?.record).toMatchObject({ ref: 'state:axe:-30', clock: pre.clock });
  });
});

describe('who took part is measured, not guessed from distance', () => {
  const heroes = [['axe', 2], ['lina', 2], ['sven', 2], ['pudge', 3], ['zuus', 3], ['lion', 3]];

  it('a hero standing at the fight who dealt and took no hero damage was not in it; the dead are always in it', () => {
    const t: any = synth({
      heroes,
      pos: { axe: [0, 0], lina: [100, 0], sven: [200, 0], pudge: [0, 100], zuus: [100, 100], lion: [9000, 9000] },
      // Sven stands in the middle of it and never trades damage.
      damage: [[95, 'axe', 'pudge'], [96, 'pudge', 'axe'], [97, 'zuus', 'lina'], [98, 'lina', 'zuus']],
      deaths: [[100, 'axe'], [104, 'lina'], [108, 'pudge']],
      dead: { axe: [100, 140], lina: [104, 150], pudge: [108, 160] },
    });
    const f = (fightReport(t, { hero: 'axe' }) as any).fights[0];
    expect(f.my_team.took_part).toEqual(['axe', 'lina']);
    expect(f.my_team.not_in_it).toEqual([expect.objectContaining({ hero: 'sven', doing: 'none_of_these', distance: expect.any(Number) })]);
    expect(f.enemy.took_part).toEqual(['pudge', 'zuus']);
    expect(f.engaged_at).toBe('1:35');
    expect(f.lost_fewer_heroes).toBe('enemy');
  });

  it('a hero damaged in the same seconds far from the fight is not in it, nor is whoever traded with them', () => {
    const t: any = synth({
      heroes,
      pos: { axe: [0, 0], lina: [100, 0], pudge: [0, 100], zuus: [100, 100], sven: [-6000, -6000], lion: [-6000, -5900] },
      damage: [[95, 'axe', 'pudge'], [97, 'zuus', 'lina'], [96, 'sven', 'lion'], [97, 'lion', 'sven']],
      deaths: [[100, 'axe'], [104, 'lina'], [108, 'pudge']],
      dead: { axe: [100, 140], lina: [104, 150], pudge: [108, 160] },
    });
    const f = (fightReport(t, { hero: 'axe' }) as any).fights[0];
    expect(f.my_team.took_part).toEqual(['axe', 'lina']);
    expect(f.enemy.took_part).toEqual(['pudge', 'zuus']);
    expect(f.enemy.not_in_it).toEqual([expect.objectContaining({ hero: 'lion', doing: 'trading_damage_with_enemy_heroes' })]);
  });

  it('with Boots of Travel the teleport is the scroll: its cooldown decides (review of #296)', () => {
    const held = { held: [[0, 200]] };
    const at60 = (items: any) => (heroStateAt(synth({ heroes, items: { axe: items } }), 0, 60) as any).tp_ready;
    expect(at60({ item_tpscroll: { ...held, cd: [[40, 120, 80]] }, item_travel_boots: { ...held, cd: [] } })).toBe(false);
    expect(at60({ item_tpscroll: { ...held, cd: [] }, item_travel_boots: { ...held, cd: [] } })).toBe(true);
    // No scroll held: the boots' own cooldown.
    expect(at60({ item_travel_boots: { ...held, cd: [[50, 100, 50]] } })).toBe(false);
  });

  it('a dead hero has no place or distance, only when they come back; a hero with no TP is null, not "not ready"', () => {
    const t: any = synth({ heroes, dead: { sven: [50, 80] } });
    const s: any = heroStateAt(t, 2, 60);
    expect(s).toMatchObject({ hero: 'sven', alive: false, doing: 'dead', respawn_in: 20 });
    expect('place' in s).toBe(false);
    expect((heroStateAt(t, 0, 60) as any).tp_ready).toBeNull();
    expect((heroStateAt(t, 0, 60) as any).black_king_bar_ready).toBeNull();
  });

  it('an ultimate is ready only when learned, off cooldown and affordable; an unknown cost with too little mana is null', () => {
    const ult = (extra: any) => ({ levels: [[0, 1]], cd: [], mana: 200, ...extra });
    const base = { heroes, mana: 150 };
    const read = (a: any, o: any = {}) => (heroStateAt(synth({ ...base, abilities: { axe: { axe_culling_blade: a } } }), 0, 60, { ultimate: 'axe_culling_blade', ...o }) as any).ultimate;
    expect(read(ult({ costs: [[0, 100]] }))).toEqual({ ability: 'axe_culling_blade', ready: true });
    expect(read(ult({ costs: [[0, 180]] }))).toMatchObject({ ready: false, why: 'mana', cost: 180 });
    expect(read(ult({ cd: [[40, 90, 70]] }))).toMatchObject({ ready: false, why: 'cooldown', seconds_left: 50 });
    expect(read(ult({ levels: [[0, 0]] }))).toMatchObject({ ready: false, why: 'not_learned' });
    // No cost over time, and less mana than the game's highest cost: cannot say.
    expect(read(ult({}))).toMatchObject({ ready: null, why: 'mana_cost_unknown' });
    // A passive or mana-only ultimate: "ready" says nothing.
    expect(read(ult({ costs: [[0, 100]] }), { passiveUltimate: true })).toMatchObject({ ready: null, why: 'no_cooldown' });
    expect(read(undefined)).toMatchObject({ ready: null, why: 'not_in_trace' });
  });

  it('game_state names the second it was asked for, and refuses one outside the replay', () => {
    const t: any = synth({ heroes, damage: [[60, 'axe', 'pudge']] });
    const g: any = gameState(t, { hero: 'pudge', at: '1:00' });
    expect(g.ref).toBe('state:pudge:60');
    expect(g.my_team.heroes.map((h: any) => h.hero)).toEqual(['pudge', 'zuus', 'lion']);
    expect(g.my_team.trading_damage_with_enemy_heroes).toBe(1);
    expect(g.enemy.heroes[0]).toMatchObject({ hero: 'axe', doing: 'trading_damage_with_enemy_heroes' });
    expect(gameState(t, { hero: 'pudge', at: 5000 })).toMatchObject({ error: 'time_outside_the_replay' });
    expect(gameState(t, { hero: 'nobody', at: 10 })).toMatchObject({ error: 'unknown_hero' });
  });
});

describe('the agent has the tools and is told how to read them', () => {
  it('both tools are offered to the review and the chat, and the prompt version moved', () => {
    for (const tool of FIGHT_TOOLS) expect(KNOWLEDGE_TOOLS).toContain(tool);
    const kit: any = reviewToolkit({ trace, hero: 'beastmaster', lang: 'zh' });
    expect(kit.tools.map((t: any) => t.name)).toEqual(expect.arrayContaining(['fight_report', 'game_state']));
    expect(kit.runTool('fight_report', { hero: 'beastmaster' }).fights_total).toBe(16);
    expect(DEEP_REVIEW_PROMPT_VERSION).toBe(62);
    const review = deepReviewSystem('zh');
    expect(review).toContain('fight_report for the player first');
    // Still never a motive; "farming" only where the tool says so (#359: the replay's creep kills now show it).
    expect(review).toMatch(/never that they refused or ignored the call\. Say they were farming only when their doing is "farming"/);
    expect(review).not.toMatch(/ignored the call or were farming/);
    expect(chatSystem('zh')).toContain('fight_report for the player');
  });

  it('the calibration script reproduces its table from a directory of traces', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fights-'));
    copyFileSync(FIXTURE, join(dir, '9100904020.trace.json.gz'));
    const out = JSON.parse(execFileSync('node', ['scripts/calibrate.mjs', dir, '--json'], { encoding: 'utf8' }));
    expect(out.games).toBe(1);
    // Read once, from Radiant: the fights with a winner, and of those the ones a side brought more heroes to.
    const fights = (fightReport(trace, { hero: 'axe' }) as any).fights.filter((f: any) => f.lost_fewer_heroes !== 'even');
    expect(out.fights_with_a_winner).toBe(fights.length);
    const uneven = fights.filter((f: any) => f.more_heroes_took_part !== 'even');
    const more = out.measures.find((m: any) => m.measure === 'more heroes took part');
    expect(more).toMatchObject({ fights: uneven.length, side_ahead_won: uneven.filter((f: any) => f.more_heroes_took_part === f.lost_fewer_heroes).length });
  });

  it('the calibration script counts ultimate edges and what followed; the review is told they explain little alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ults-'));
    copyFileSync(FIXTURE, join(dir, '9100904020.trace.json.gz'));
    const ue = JSON.parse(execFileSync('node', ['scripts/calibrate.mjs', dir, '--json'], { encoding: 'utf8' })).ultimate_edges;
    expect(ue.moments).toBeGreaterThan(0);
    expect(ue.fight_within_90s).toBeLessThanOrEqual(ue.moments);
    expect(ue.edge_side_lost_fewer + ue.edge_side_lost_more + ue.even).toBe(ue.fight_within_90s);
    expect(deepReviewSystem('zh')).toMatch(/Do not explain a fight by ultimates ready alone/);
    // Each edge's fight began after it, at its first damage exchange — not merely its first death (review of #310).
    const edges = ultimateEdges(trace);
    expect(edges.length).toBe(ue.moments);
    for (const e of edges.filter((x: any) => x.fight)) {
      const f = matchFights(trace)[(e.fight as number) - 1];
      expect(e.engaged_at).toBe(fightParticipation(trace, f).engaged_at);
      expect(e.engaged_at).toBeGreaterThan(e.t);
      expect(e.engaged_at).toBeLessThanOrEqual(e.t + 90);
    }
  });
});
