import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { linkHeroNames, runTraceTool, classifyDeath, realDeaths, resurrections } from '../../packages/review-engine/src/trace/index.js';
import { roshanReport } from '../../lib/agent/roshanReport.js';
import { combatLog } from '../../lib/agent/replayQuery.js';
import { momentFrames } from '../../lib/agent/moment.js';
import { saveReport } from '../../lib/agent/saveReport.js';
import { laneReport } from '../../lib/agent/knowledgeTools.js';
import { powerSpikes } from '../../lib/agent/situationTools.js';
import { resolveRef } from '../../lib/agent/evidence.js';
import { verifyReview } from '../../lib/agent/deepReview.js';

const FIXTURE = new URL('../../packages/review-engine/test/fixtures/trace-9100904020.json.gz', import.meta.url);
const real = linkHeroNames(JSON.parse(gunzipSync(readFileSync(FIXTURE)).toString()));

/**
 * Synthetic Wraith King trace modeled on real match 9080127650:
 * - 335.8 (5:35): died before learning Reincarnation (innate Wraith Form short lock [331.6, 335.9, 4.2]) -> real death (not_learned)
 * - 615.0 (10:15): entered Wraith Form at 610.6 with 179 mana (< 220 cost), popped Stick at 611 (mana 285) during Wraith Form -> real death (insufficient_mana, NOT ready_not_cast, NOT on_cooldown)
 * - 1015.3 (16:55): Reincarnation triggered ([1015.4, 1195.4, 180]), revived in place at 1019 -> resurrection #1
 * - 1032.8 (17:12): died for real 13.8 s after reviving while Reincarnation on cooldown -> real death #3 (on_cooldown, linked to resurrection #1)
 * - 1668.0 (27:48): Reincarnation triggered ([1668.2, 1818.3, 150]), revived in place at 1671 and lived -> resurrection #2
 */
function buildWraithKingTrace() {
  const n = 2000;
  const heroes = [
    { key: 'skeleton_king', npc: 'npc_dota_hero_skeleton_king', team: 2, player_index: 0 },
    { key: 'crystal_maiden', npc: 'npc_dota_hero_crystal_maiden', team: 2, player_index: 1 },
    { key: 'lion', npc: 'npc_dota_hero_lion', team: 3, player_index: 5 },
    { key: 'juggernaut', npc: 'npc_dota_hero_juggernaut', team: 3, player_index: 6 },
  ];
  const names = [...heroes.map((h) => h.npc), 'skeleton_king_wraithfire_blast', 'skeleton_king_reincarnation', 'crystal_maiden_frostbite'];
  const FOUNTAIN = [-7000, -6500];
  const RIVER = [200, -100];

  const wk = {
    x: [] as (number | null)[], y: [] as (number | null)[],
    hp: [] as (number | null)[], max_hp: [] as (number | null)[],
    mana: [] as (number | null)[], mana_peak: [] as (number | null)[],
    level: [] as (number | null)[], alive: [] as (number | null)[],
  };

  for (let s = 0; s < n; s += 1) {
    const fountainDead = (s >= 336 && s <= 355) || (s >= 615 && s <= 640) || (s >= 1033 && s <= 1075);
    const gravestone = (s >= 1016 && s <= 1018) || (s >= 1669 && s <= 1670);
    const justRespawned = (s >= 356 && s <= 359) || (s >= 641 && s <= 644) || (s >= 1076 && s <= 1079);
    const [x, y] = fountainDead || justRespawned ? FOUNTAIN : RIVER;
    let mana = 320;
    let peak = 320;
    if (s === 610) { mana = 179; peak = 179; }
    else if (s === 611) { mana = 180; peak = 280; }
    else if (s >= 612 && s <= 615) { mana = 285; peak = 285; }
    wk.x.push(x); wk.y.push(y);
    wk.hp.push(fountainDead || gravestone ? 0 : 1400);
    wk.max_hp.push(1600);
    wk.mana.push(mana); wk.mana_peak.push(peak);
    wk.level.push(s < 490 ? 5 : s < 1208 ? 8 : 15);
    wk.alive.push(fountainDead || gravestone ? 0 : 1);
  }

  const mkOther = (x: number, y: number) => ({
    x: Array(n).fill(x), y: Array(n).fill(y),
    hp: Array(n).fill(1000), max_hp: Array(n).fill(1000),
    mana: Array(n).fill(400), mana_peak: Array(n).fill(400),
    level: Array(n).fill(10), alive: Array(n).fill(1),
  });

  return {
    schema: 'dota2.ai/match-trace@1',
    match_id: 9080127650,
    t0: 0,
    n,
    heroes,
    names,
    states: [wk, mkOther(350, -150), mkOther(400, -200), mkOther(450, -220)],
    abilities: [
      {
        skeleton_king_wraithfire_blast: { levels: [[0, 1]], cd: [], mana: 140, costs: [[0, 140]] },
        skeleton_king_reincarnation: {
          levels: [[490.8, 1], [1208.2, 2]],
          cd: [
            [331.6, 335.9, 4.2],
            [610.6, 615.4, 4.5],
            [1015.4, 1195.4, 180],
            [1668.2, 1818.3, 149.9],
          ],
          mana: 220,
          costs: [[490.8, 220], [1208.2, 110]],
        },
      },
      {},
      {},
      {},
    ],
    items: [{}, {}, {}, {}],
    controls: [{}, {}, {}, {}],
    casts: [[1010, 1, 6, 0, 10]],
    item_uses: [],
    purchases: [],
    buildings: [[1950, names.push('npc_dota_badguys_fort') - 1, 2, 99]],
    modifiers: [],
    damage: [[610, 2, 0, -1, 400], [1015, 3, 0, -1, 600], [1032, 2, 0, -1, 700], [1667, 3, 0, -1, 900]],
    deaths: [
      [335.8, 0, 3, 1],
      [615.0, 0, 2, 2],
      [1015.3, 0, 3, 3],
      [1032.8, 0, 2, 4],
      [1668.0, 0, 3, 5],
    ],
    buybacks: [],
    gaps: [],
  };
}

describe('in-place resurrections (Wraith King Reincarnation & Aegis of the Immortal, #423)', () => {
  it('separates Wraith King Reincarnation triggers from real deaths, handles Wraith-Form mana lock, and links quick second deaths', () => {
    const tr: any = buildWraithKingTrace();
    expect(realDeaths(tr).map((d: any) => d[0])).toEqual([335.8, 615.0, 1032.8]);
    expect(resurrections(tr).map((r: any) => [r.t, r.by, r.revived_at])).toEqual([
      [1015.3, 'reincarnation', 1019],
      [1668.0, 'reincarnation', 1671],
    ]);

    const ov: any = runTraceTool(tr, 'match_overview', {}, { perspective: 'skeleton_king' });
    expect(ov.heroes.find((h: any) => h.hero === 'skeleton_king')).toMatchObject({ deaths: 3, deaths_before_10: 1 });

    const dc: any = runTraceTool(tr, 'death_context', { hero: 'skeleton_king' }, { perspective: 'skeleton_king' });
    expect(dc.deaths_total).toBe(3);
    expect(dc.resurrections_total).toBe(2);
    expect(dc.resurrections_at).toEqual(['16:55', '27:48']);
    expect(dc.deaths.map((d: any) => d.clock)).toEqual(['5:35', '10:15', '17:12']);

    // Reincarnation is passive: never listed as an unpressed active button.
    for (const d of dc.deaths) {
      expect(d.ready_not_cast).not.toContain('skeleton_king_reincarnation');
      expect(d.off_cooldown_without_the_mana).not.toContain('skeleton_king_reincarnation');
    }
    expect(dc.most_left_unused.flatMap((x: any) => x.ready_not_cast)).not.toContain('skeleton_king_reincarnation');

    // Exact reason Reincarnation did not trigger on each real death:
    expect(dc.deaths[0].reincarnation_at_death).toEqual({ state: 'not_learned' });
    // At 10:15, Stick was used AFTER Wraith Form started (610.6): mana at lethal blow was 179 < 220, NOT on_cooldown and NOT ready.
    expect(dc.deaths[1].reincarnation_at_death).toEqual({ state: 'insufficient_mana', mana: 179, mana_cost: 220 });
    expect(dc.deaths[2].reincarnation_at_death).toEqual({ state: 'on_cooldown', cooldown_left: 162.6 });

    // First reincarnation was followed 13.8 s after reviving by real death #3; second reincarnation survived.
    expect(dc.resurrections[0]).toMatchObject({
      ref: 'resurrection:skeleton_king:1',
      clock: '16:55',
      by: 'reincarnation',
      revived_at: '16:59',
      allies_within_2200: ['crystal_maiden'],
      enemies_within_2200: ['lion', 'juggernaut'],
      died_for_real_within_20s: { ref: 'death:skeleton_king:3', clock: '17:12', killer: 'lion', seconds_after_revive: 13.8 },
    });
    expect(dc.resurrections[1]).toMatchObject({
      ref: 'resurrection:skeleton_king:2',
      clock: '27:48',
      by: 'reincarnation',
      revived_at: '27:51',
      died_for_real_within_20s: false,
    });

    // Downstream tools agree on real deaths only.
    expect((laneReport(tr, { hero: 'skeleton_king' }) as any).my_deaths_before_10_00_total).toBe(1);
    expect((powerSpikes(tr, { hero: 'skeleton_king' }) as any).kills_of_me).toEqual({ lion: 2, juggernaut: 1 });
    // Crystal Maiden cast Frostbite on WK at 1010; WK reincarnated at 1015.3 (did NOT die for real within 5 s).
    expect((saveReport(tr, { hero: 'crystal_maiden' }) as any).given[0]).toMatchObject({ to: 'skeleton_king', died_within_5s: false });

    // ability_audit on skeleton_king_reincarnation reports triggers instead of blaming the player for not pressing it.
    const audit: any = runTraceTool(tr, 'ability_audit', { hero: 'skeleton_king', ability: 'reincarnation' }, { perspective: 'skeleton_king' });
    expect(audit).toMatchObject({
      ref: 'audit:skeleton_king:reincarnation',
      deaths_with_it_ready_and_not_cast_total: 0,
      deaths_with_it_ready_and_not_cast: [],
      triggered_on_death_total: 2,
      triggered_on_death: ['16:55', '27:48'],
    });

    // Evidence resolution and verification back resurrection refs and summary counts.
    const ev = resolveRef(tr, 'resurrection:skeleton_king:1', { hero: 'skeleton_king', lang: 'zh' });
    expect(ev).toMatchObject({ ref: 'resurrection:skeleton_king:1', kind: 'resurrection', names: expect.objectContaining({ skeleton_king: '冥魂大帝', lion: '莱恩' }) });

    const verified = verifyReview({
      verdict: '你全场真死 3 次，并在 16:55 与 27:48 触发了 2 次绝冥再生。',
      mainline: ['16:55 交出第一条命后，17:12 再次阵亡。'],
      findings: [{
        title: '十点十五分空蓝阵亡没有触发大招',
        claim: '10:15 致死瞬间蓝量只有 179 点，不够绝冥再生的 220 点蓝耗。',
        evidence: [
          { refs: ['death:skeleton_king:2'], fact: '10:15 被莱恩击杀，致死时蓝量 179 / 220。' },
          { refs: ['resurrection:skeleton_king:1', 'death:skeleton_king:3'], fact: '16:55 触发绝冥再生于 16:59 起身，13.8 秒后在 17:12 被莱恩击杀。' },
          { refs: ['audit:skeleton_king:reincarnation'], fact: '全场在 16:55、27:48 触发 2 次绝冥再生。' },
        ],
        rule: { when: '大招就绪但蓝量低于 220 点时', do: '先留魔棒或退回安全区补蓝', this_game: '全场 3 次真死里有 1 次（10:15）因缺蓝没开出大招。' },
        fix: '盯紧大招蓝耗线。',
      }],
      did_well: [],
      blind_spots: [],
      game_plan: {
        course: '双方在中路交战。',
        your_part: '你在河道参战。',
        main_reason: 'your_play',
        why: '10:15 与 17:12 连续阵亡断了节奏。',
        evidence: [{ refs: ['deaths:skeleton_king'], fact: '全场真死 3 次，原地重生 2 次（16:55、27:48）。' }],
      },
    }, [ov, dc, audit]);
    expect(verified.problems.filter((p: any) => !p.soft)).toEqual([]);
  });

  it('filters Phantom Assassin\'s 36:43 Aegis revival out of real deaths on 9100904020 while keeping roshan_report aegis=used', () => {
    const ov: any = runTraceTool(real, 'match_overview', {}, { perspective: 'phantom_assassin' });
    // Scoreboard deaths for PA are 4 (299.4, 376.5, 1377.1, 1658.2); 2203.2 (36:43) was her Aegis revival.
    expect(ov.heroes.find((h: any) => h.hero === 'phantom_assassin')?.deaths).toBe(4);

    const dc: any = runTraceTool(real, 'death_context', { hero: 'phantom_assassin' }, { perspective: 'phantom_assassin' });
    expect(dc.deaths_total).toBe(4);
    expect(dc.resurrections_total).toBe(1);
    expect(dc.resurrections).toMatchObject([{
      ref: 'resurrection:phantom_assassin:1',
      clock: '36:43',
      by: 'aegis',
      killer: 'skywrath_mage',
      died_for_real_within_20s: false,
    }]);

    // fight_timeline and combat_log label 36:43 as an Aegis revival rather than a real death.
    const tl: any = runTraceTool(real, 'fight_timeline', { from: '36:35', to: '36:55' }, { perspective: 'phantom_assassin' });
    expect(tl.hero_deaths_in_window).toEqual({ my_team: 1, enemy: 0 }); // Axe at 2200.3 only
    expect(tl.events.find((e: any) => e.hero === 'phantom_assassin' && e.clock === '36:43')).toMatchObject({ kind: 'aegis' });

    const log: any = combatLog(real, { from: '36:40', to: '36:45', hero: 'phantom_assassin', kinds: ['death'] });
    expect(log.rows).toMatchObject([{ kind: 'death', hero: 'phantom_assassin', killer: 'skywrath_mage', resurrected_by: 'aegis' }]);

    const mom: any = momentFrames(real, { hero: 'phantom_assassin', t: 2203 });
    expect(mom.deaths.find((d: any) => d.hero === 'phantom_assassin')).toMatchObject({ t: 2203.2, resurrected_by: 'aegis' });

    // roshan_report still reads trace.deaths directly to mark the Aegis as used at 36:43.
    const rosh: any = roshanReport(real, { hero: 'beastmaster' });
    expect(rosh.takes[0]).toMatchObject({ aegis_holder: 'phantom_assassin', aegis: 'used', aegis_used_at: '36:43' });

    // An Aegis that expired naturally after 300 s followed immediately (even 0.3 s later) by a hero death is a real death, not an Aegis revival (Codex P1 on #431).
    const expired: any = buildWraithKingTrace();
    expired.items[0] = { item_aegis: { held: [[100, 400]], cd: [] } };
    expect(classifyDeath(expired, [400.3, 0, 2, 76])).toEqual({ real: true });
    expect(classifyDeath(expired, [401.5, 0, 2, 77])).toEqual({ real: true });
    const expiredWithDeath = { ...expired, deaths: [[400.3, 0, 2, 76]] };
    expect((roshanReport(expiredWithDeath, { hero: 'skeleton_king' }) as any).takes[0]).toMatchObject({ aegis: 'expired' });
  });

  it('catches non-buyback in-place revival talents outside bases, ignores instant base respawns, and keeps blanked samples unknown (null, never 0 or [])', () => {
    const base: any = buildWraithKingTrace();
    // Hero 1 (crystal_maiden, no skeleton_king_reincarnation and no Aegis) falls at t=800 in river and revives in place at t=804 without buyback.
    const cmStates = { ...base.states[1], alive: [...base.states[1].alive], x: [...base.states[1].x], y: [...base.states[1].y] };
    for (let s = 801; s <= 803; s += 1) cmStates.alive[s] = 0;
    const talentTrace = { ...base, states: [base.states[0], cmStates, base.states[2], base.states[3]], deaths: [[800.2, 1, 2, 50]] };
    expect(classifyDeath(talentTrace, talentTrace.deaths[0])).toEqual({ real: false, by: 'reincarnation', revived_at: 804 });

    // Same fast respawn INSIDE Radiant base (e.g., Undying Ceaseless Dirge or buyback inside base): real death, never guessed as reincarnation.
    const inBase = {
      ...cmStates,
      x: cmStates.x.map(() => -7000),
      y: cmStates.y.map(() => -6500),
    };
    const baseRespawnTrace = { ...base, states: [base.states[0], inBase, base.states[2], base.states[3]], deaths: [[800.2, 1, 2, 50]] };
    expect(classifyDeath(baseRespawnTrace, baseRespawnTrace.deaths[0])).toEqual({ real: true });

    // Blanking OTHER heroes' position and alive samples on the real fixture while keeping PA's own samples intact:
    // allies_within_2200 and enemies_within_2200 must be null (unknown), never [] ("nobody") (Codex P1 on #431).
    const paIdx = real.heroes.findIndex((h: any) => h.key === 'phantom_assassin');
    const othersBlank = {
      ...real,
      states: real.states.map((s: any, i: number) => (i === paIdx ? s : {
        ...s,
        x: s.x.map(() => null),
        y: s.y.map(() => null),
        alive: s.alive.map(() => null),
      })),
    };
    const paBlindOthers: any = runTraceTool(othersBlank, 'death_context', { hero: 'phantom_assassin' });
    expect(paBlindOthers.resurrections[0]).toMatchObject({
      clock: '36:43',
      at: expect.objectContaining({ region: 'dire_top_lane' }),
      allies_within_2200: null,
      enemies_within_2200: null,
    });
    // Blanking only one ally's alive array (positions kept) leaves allies_within_2200 null while enemies_within_2200 stands.
    const axeIdx = real.heroes.findIndex((h: any) => h.key === 'axe');
    const oneAllyAliveBlank = {
      ...real,
      states: real.states.map((s: any, i: number) => (i === axeIdx ? { ...s, alive: s.alive.map(() => null) } : s)),
    };
    const paOneAllyBlind: any = runTraceTool(oneAllyAliveBlank, 'death_context', { hero: 'phantom_assassin' });
    expect(paOneAllyBlind.resurrections[0].allies_within_2200).toBeNull();
    expect(Array.isArray(paOneAllyBlind.resurrections[0].enemies_within_2200)).toBe(true);

    // Blanked samples (Unknown is not false): position, alive and mana wiped to null around Wraith King's deaths and revivals.
    const raw = buildWraithKingTrace();
    const blankWk = {
      ...raw.states[0],
      x: raw.states[0].x.map(() => null),
      y: raw.states[0].y.map(() => null),
      alive: raw.states[0].alive.map(() => null),
      mana: raw.states[0].mana.map(() => null),
      mana_peak: raw.states[0].mana_peak.map(() => null),
    };
    const blanked = { ...raw, states: [blankWk, raw.states[1], raw.states[2], raw.states[3]] };
    // Cooldown intervals still identify the two Reincarnation triggers, while unsampled revival time / positions / nearby heroes stay null.
    const dc: any = runTraceTool(blanked, 'death_context', { hero: 'skeleton_king' });
    expect(dc.resurrections[0]).toMatchObject({
      clock: '16:55',
      revived_at: null,
      at: null,
      allies_within_2200: null,
      enemies_within_2200: null,
      died_for_real_within_20s: null, // 17:12 is 17.5 s after 16:55: without revived_at, whether <= 20 s after revive cannot be settled
    });
    expect(dc.resurrections[1].died_for_real_within_20s).toBe(false); // no real death after 27:48 at all
    // Mana at 10:15 was blanked -> unknown, never guessed as ready or insufficient_mana.
    expect(dc.deaths[1].reincarnation_at_death).toEqual({ state: 'unknown' });

    // Abilities completely empty on trace -> reincarnation_at_death is null (unknown, not not_learned).
    const noAbil = { ...raw, abilities: [{}, {}, {}, {}] };
    const dcNoAbil: any = runTraceTool(noAbil, 'death_context', { hero: 'skeleton_king' });
    expect(dcNoAbil.deaths[0].reincarnation_at_death).toBeNull();
  });
});
