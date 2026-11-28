import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createTraceBuilder, itemTimeline, linkHeroNames, runTraceTool } from '../../packages/review-engine/src/trace/index.js';
import { runTrace } from '../../packages/cli/src/trace.js';
import { buildCheck } from '../../lib/agent/situationTools.js';
import { resolveRef } from '../../lib/agent/evidence.js';
import { reviewToolkit, verifyReview } from '../../lib/agent/deepReview.js';

const ITEMS = JSON.parse(readFileSync(new URL('../../lib/data/constants/items.json', import.meta.url), 'utf8'));
const REAL_TRACE_PATH = fileURLToPath(new URL('../../packages/review-engine/test/fixtures/trace-9100904020.json.gz', import.meta.url));
const REAL_TRACE = linkHeroNames(JSON.parse(gunzipSync(readFileSync(REAL_TRACE_PATH)).toString()));
const REAL_MATCH = JSON.parse(readFileSync(new URL('../fixtures/agent/match9100904020.scoreboard.json', import.meta.url), 'utf8'));

/** Minimal two-hero synthetic trace builder for deterministic purchase vs delivery tests. */
function buildSyntheticTrace({
  duration = 1600,
  heldItems = [] as { hero?: string; item: string; from: number; to?: number; slot?: number }[],
  purchases = [] as { hero?: string; item: string; t: number }[],
  courierKills = [] as { killer: string; killerTeam: number; targetTeam: number; t: number }[],
} = {}) {
  const b = createTraceBuilder();
  const heroes = [
    { hero: 'beastmaster', team: 3, player_index: 5 },
    { hero: 'phantom_assassin', team: 2, player_index: 0 },
  ];
  const sampleTs = new Set<number>([0, duration]);
  for (const h of heldItems) {
    sampleTs.add(Math.max(0, h.from - 1));
    sampleTs.add(h.from);
    sampleTs.add(Math.min(duration, h.to ?? duration));
  }
  for (const t of [...sampleTs].sort((a, b2) => a - b2)) {
    for (const h of heroes) {
      const items = heldItems
        .filter((x) => (x.hero ?? 'beastmaster') === h.hero && t >= x.from && t <= (x.to ?? duration))
        .map((x, idx) => ({ name: `item_${x.item}`, slot: x.slot ?? idx, cooldown: 0 }));
      b.addState({
        entity_kind: 'real_hero',
        t,
        hero: h.hero,
        team: h.team,
        player_index: h.player_index,
        x: 0,
        y: 0,
        hp: 1000,
        max_hp: 1000,
        mana: 500,
        level: 12,
        life_state: 0,
        abilities: [],
        items,
        controls: {},
      });
    }
  }
  let row = 1;
  for (const p of purchases) {
    b.addEvent({
      type: 'DOTA_COMBATLOG_PURCHASE',
      t: p.t,
      target: `npc_dota_hero_${p.hero ?? 'beastmaster'}`,
      value_name: `item_${p.item}`,
    }, row++);
  }
  for (const ck of courierKills) {
    b.addEvent({
      type: 'DOTA_COMBATLOG_DEATH',
      t: ck.t,
      attacker: `npc_dota_hero_${ck.killer}`,
      attacker_hero: true,
      attacker_illusion: false,
      attacker_team: ck.killerTeam,
      target: 'npc_dota_courier',
      target_hero: false,
      target_team: ck.targetTeam,
      last_hits: 50,
      networth: 5000,
    }, row++);
  }
  return linkHeroNames(b.finish({ match_id: 9100904020 }));
}

describe('item purchase vs inventory delivery timing (#483)', () => {
  it('direct purchase item bought early and delivered late reports exact delivery_delay_seconds', () => {
    const tr = buildSyntheticTrace({
      purchases: [{ item: 'blink', t: 720 }],
      heldItems: [{ item: 'blink', from: 870 }],
    });
    const res: any = itemTimeline(tr, { hero: 'beastmaster' }, { perspective: 'beastmaster', patchItems: ITEMS });
    const blink = res.items.find((i: any) => i.item === 'blink');
    expect(blink).toMatchObject({
      ref: 'item:beastmaster:blink',
      first_purchased: { t: 720, clock: '12:00', source: 'direct' },
      first_held: { t: 870, clock: '14:30' },
      delivery_delay_seconds: 150,
      my_team_courier_deaths_during_delivery: [],
    });
    expect(res.my_team_courier_deaths).toEqual([]);
    expect(res.gaps).toContainEqual(expect.objectContaining({ topic: 'courier_ownership_and_cargo' }));
    expect(res.gaps).toContainEqual(expect.objectContaining({ topic: 'stash_and_backpack_state' }));
  });

  it('multi-component no-recipe item (Aghanim\'s Scepter) resolves last component purchase both with and without combine log row', () => {
    // Case A: no direct item_ultimate_scepter row at all (only the 4 components)
    const noCombine = buildSyntheticTrace({
      purchases: [
        { item: 'point_booster', t: 600 },
        { item: 'ogre_axe', t: 700 },
        { item: 'staff_of_wizardry', t: 800 },
        { item: 'blade_of_alacrity', t: 900 },
      ],
      heldItems: [
        { item: 'point_booster', from: 610, to: 1079 },
        { item: 'ogre_axe', from: 710, to: 1079 },
        { item: 'staff_of_wizardry', from: 810, to: 1079 },
        { item: 'ultimate_scepter', from: 1080 },
      ],
      courierKills: [
        // Enemy kills my team's courier while Blade of Alacrity is in transit (inside [900, 1080])
        { killer: 'phantom_assassin', killerTeam: 2, targetTeam: 3, t: 920 },
        // Enemy kills my team's courier earlier (outside [900, 1080])
        { killer: 'phantom_assassin', killerTeam: 2, targetTeam: 3, t: 500 },
        // My hero kills enemy courier (must NOT count as my_team_courier_deaths)
        { killer: 'beastmaster', killerTeam: 3, targetTeam: 2, t: 950 },
      ],
    });
    const resA: any = itemTimeline(noCombine, { hero: 'beastmaster' }, { perspective: 'beastmaster', patchItems: ITEMS });
    expect(resA.my_team_courier_deaths).toEqual([
      { t: 500, clock: '8:20', killed_by: 'phantom_assassin' },
      { t: 920, clock: '15:20', killed_by: 'phantom_assassin' },
    ]);
    const aghsA = resA.items.find((i: any) => i.item === 'ultimate_scepter');
    expect(aghsA).toMatchObject({
      first_purchased: { t: 900, clock: '15:00', source: 'components' },
      first_held: { t: 1080, clock: '18:00' },
      delivery_delay_seconds: 180,
      my_team_courier_deaths_during_delivery: [{ t: 920, clock: '15:20', killed_by: 'phantom_assassin' }],
    });

    // Case B: real Source 2 behavior where DOTA_COMBATLOG_PURCHASE emits item_ultimate_scepter AT combine/delivery time (1080)
    const withCombine = buildSyntheticTrace({
      purchases: [
        { item: 'point_booster', t: 600 },
        { item: 'ogre_axe', t: 700 },
        { item: 'staff_of_wizardry', t: 800 },
        { item: 'blade_of_alacrity', t: 900 },
        { item: 'ultimate_scepter', t: 1080 },
      ],
      heldItems: [{ item: 'ultimate_scepter', from: 1080 }],
      courierKills: [{ killer: 'phantom_assassin', killerTeam: 2, targetTeam: 3, t: 920 }],
    });
    const resB: any = itemTimeline(withCombine, { hero: 'beastmaster' }, { perspective: 'beastmaster', patchItems: ITEMS });
    expect(resB.items.find((i: any) => i.item === 'ultimate_scepter')).toMatchObject({
      first_purchased: { t: 900, clock: '15:00', source: 'components' },
      first_held: { t: 1080, clock: '18:00' },
      delivery_delay_seconds: 180,
      my_team_courier_deaths_during_delivery: [{ t: 920, clock: '15:20', killed_by: 'phantom_assassin' }],
    });

    // Querying enemy hero from player's perspective uses enemy_team_courier_deaths and counts kills by player's team
    const enemyRes: any = itemTimeline(noCombine, { hero: 'phantom_assassin' }, { perspective: 'beastmaster', patchItems: ITEMS });
    expect(enemyRes.side).toBe('enemy');
    expect(enemyRes.enemy_team_courier_deaths).toEqual([{ t: 950, clock: '15:50', killed_by: 'beastmaster' }]);
    expect(enemyRes).not.toHaveProperty('my_team_courier_deaths');
  });

  it('recipe item (Black King Bar) requires components + recipe_black_king_bar and tracks delivery delay', () => {
    const tr = buildSyntheticTrace({
      purchases: [
        { item: 'mithril_hammer', t: 1000 },
        { item: 'ogre_axe', t: 1100 },
        { item: 'recipe_black_king_bar', t: 1200 },
        { item: 'black_king_bar', t: 1350 },
      ],
      heldItems: [{ item: 'black_king_bar', from: 1350 }],
      courierKills: [{ killer: 'phantom_assassin', killerTeam: 2, targetTeam: 3, t: 1230 }],
    });
    const res: any = itemTimeline(tr, { hero: 'beastmaster' }, { perspective: 'beastmaster', patchItems: ITEMS });
    expect(res.items.find((i: any) => i.item === 'black_king_bar')).toMatchObject({
      first_purchased: { t: 1200, clock: '20:00', source: 'components' },
      first_held: { t: 1350, clock: '22:30' },
      delivery_delay_seconds: 150,
      my_team_courier_deaths_during_delivery: [{ t: 1230, clock: '20:30', killed_by: 'phantom_assassin' }],
    });

    // Missing recipe_black_king_bar must NOT guess purchase time from components alone or combine row
    const missingRecipe = buildSyntheticTrace({
      purchases: [
        { item: 'mithril_hammer', t: 1000 },
        { item: 'ogre_axe', t: 1100 },
        { item: 'black_king_bar', t: 1350 },
      ],
      heldItems: [{ item: 'black_king_bar', from: 1350 }],
    });
    const resMiss: any = itemTimeline(missingRecipe, { hero: 'beastmaster' }, { perspective: 'beastmaster', patchItems: ITEMS });
    expect(resMiss.items.find((i: any) => i.item === 'black_king_bar')).toMatchObject({
      first_purchased: null,
      delivery_delay_seconds: null,
    });
  });

  it('respects duplicate component multiplicity and refuses to guess on component reuse or ambiguity', () => {
    // Desolator requires 2x mithril_hammer + blight_stone: only 1 mithril_hammer bought -> must stay null
    const singleHammer = buildSyntheticTrace({
      purchases: [
        { item: 'mithril_hammer', t: 800 },
        { item: 'blight_stone', t: 850 },
      ],
      heldItems: [{ item: 'desolator', from: 900 }],
    });
    expect((itemTimeline(singleHammer, { hero: 'beastmaster' }, { patchItems: ITEMS }) as any).items[0]).toMatchObject({
      first_purchased: null,
      delivery_delay_seconds: null,
    });

    // Earlier item (Yasha) consumes the only blade_of_alacrity -> Aghs cannot reuse it -> null
    const reused = buildSyntheticTrace({
      purchases: [
        { item: 'blade_of_alacrity', t: 400 },
        { item: 'boots_of_elves', t: 450 },
        { item: 'recipe_yasha', t: 500 },
        { item: 'yasha', t: 510 },
        { item: 'point_booster', t: 700 },
        { item: 'ogre_axe', t: 800 },
        { item: 'staff_of_wizardry', t: 900 },
      ],
      heldItems: [
        { item: 'yasha', from: 510, to: 1500 },
        { item: 'ultimate_scepter', from: 1100 },
      ],
    });
    const reusedRes: any = itemTimeline(reused, { hero: 'beastmaster' }, { patchItems: ITEMS });
    expect(reusedRes.items.find((i: any) => i.item === 'yasha').first_purchased).toEqual({ t: 500, clock: '8:20', source: 'components' });
    expect(reusedRes.items.find((i: any) => i.item === 'ultimate_scepter')).toMatchObject({
      first_purchased: null,
      delivery_delay_seconds: null,
    });

    // Two unused ogre_axe purchases (500 and 1100) before BKB (1120, other parts by 1050) and Aghs (1200, other parts by 900):
    // BOTH BKB AND subsequent Aghs must stay null because either axe (500 or 1100) could have remained for Aghs (PR #496 P1).
    const ambigPair = buildSyntheticTrace({
      purchases: [
        { item: 'ogre_axe', t: 500 },
        { item: 'point_booster', t: 700 },
        { item: 'staff_of_wizardry', t: 800 },
        { item: 'blade_of_alacrity', t: 900 },
        { item: 'mithril_hammer', t: 1000 },
        { item: 'recipe_black_king_bar', t: 1050 },
        { item: 'ogre_axe', t: 1100 },
        { item: 'black_king_bar', t: 1120 },
        { item: 'ultimate_scepter', t: 1200 },
      ],
      heldItems: [
        { item: 'ogre_axe', from: 510, to: 1119 },
        { item: 'black_king_bar', from: 1120 },
        { item: 'ultimate_scepter', from: 1200 },
      ],
    });
    const ambigPairRes: any = itemTimeline(ambigPair, { hero: 'beastmaster' }, { patchItems: ITEMS });
    // First ogre_axe held at 510 (before second axe existed at 1100) is still unambiguously 500.
    expect(ambigPairRes.items.find((i: any) => i.item === 'ogre_axe')).toMatchObject({
      first_purchased: { t: 500, clock: '8:20', source: 'direct' },
      delivery_delay_seconds: 10,
    });
    expect(ambigPairRes.items.find((i: any) => i.item === 'black_king_bar')).toMatchObject({
      first_purchased: null,
      delivery_delay_seconds: null,
    });
    expect(ambigPairRes.items.find((i: any) => i.item === 'ultimate_scepter')).toMatchObject({
      first_purchased: null,
      delivery_delay_seconds: null,
    });

    // Even when BKB itself is unambiguous (recipe bought at 1110 after both axes), Aghs (other parts by 900) MUST still
    // stay null because which axe remained is unknown; whereas if Aghs's last other part was bought at 1150 (> 1100), Aghs is unambiguous.
    const bkbClearAghsAmbig = buildSyntheticTrace({
      purchases: [
        { item: 'ogre_axe', t: 500 },
        { item: 'point_booster', t: 700 },
        { item: 'staff_of_wizardry', t: 800 },
        { item: 'blade_of_alacrity', t: 900 },
        { item: 'mithril_hammer', t: 1000 },
        { item: 'ogre_axe', t: 1100 },
        { item: 'recipe_black_king_bar', t: 1110 },
        { item: 'black_king_bar', t: 1120 },
        { item: 'ultimate_scepter', t: 1200 },
      ],
      heldItems: [
        { item: 'black_king_bar', from: 1120 },
        { item: 'ultimate_scepter', from: 1200 },
      ],
    });
    const bcaRes: any = itemTimeline(bkbClearAghsAmbig, { hero: 'beastmaster' }, { patchItems: ITEMS });
    expect(bcaRes.items.find((i: any) => i.item === 'black_king_bar').first_purchased).toEqual({ t: 1110, clock: '18:30', source: 'components' });
    expect(bcaRes.items.find((i: any) => i.item === 'ultimate_scepter')).toMatchObject({ first_purchased: null, delivery_delay_seconds: null });

    const aghsLatePart = buildSyntheticTrace({
      purchases: [
        { item: 'ogre_axe', t: 500 },
        { item: 'point_booster', t: 700 },
        { item: 'staff_of_wizardry', t: 800 },
        { item: 'mithril_hammer', t: 1000 },
        { item: 'recipe_black_king_bar', t: 1050 },
        { item: 'ogre_axe', t: 1100 },
        { item: 'black_king_bar', t: 1120 },
        { item: 'blade_of_alacrity', t: 1150 },
        { item: 'ultimate_scepter', t: 1200 },
      ],
      heldItems: [
        { item: 'black_king_bar', from: 1120 },
        { item: 'ultimate_scepter', from: 1200 },
      ],
    });
    const alpRes: any = itemTimeline(aghsLatePart, { hero: 'beastmaster' }, { patchItems: ITEMS });
    expect(alpRes.items.find((i: any) => i.item === 'black_king_bar')).toMatchObject({ first_purchased: null, delivery_delay_seconds: null });
    expect(alpRes.items.find((i: any) => i.item === 'ultimate_scepter')).toMatchObject({
      first_purchased: { t: 1150, clock: '19:10', source: 'components' },
      delivery_delay_seconds: 50,
    });

    // Unmatched earlier composite (Yasha missing recipe_yasha) MUST still reserve its available components
    // so a later Aghanim's Scepter cannot steal Yasha's blade_of_alacrity, and a downstream Manta upgrade stays null (PR #496 P1).
    const unmatchedYasha = buildSyntheticTrace({
      purchases: [
        { item: 'blade_of_alacrity', t: 400 },
        { item: 'boots_of_elves', t: 450 },
        { item: 'yasha', t: 510 }, // recipe_yasha intentionally missing
        { item: 'point_booster', t: 700 },
        { item: 'ogre_axe', t: 800 },
        { item: 'staff_of_wizardry', t: 900 },
        { item: 'ultimate_scepter', t: 960 },
        { item: 'diadem', t: 1100 },
        { item: 'recipe_manta', t: 1150 },
        { item: 'manta', t: 1200 },
      ],
      heldItems: [
        { item: 'yasha', from: 510, to: 1199 },
        { item: 'ultimate_scepter', from: 960 },
        { item: 'manta', from: 1200 },
      ],
    });
    const uyRes: any = itemTimeline(unmatchedYasha, { hero: 'beastmaster' }, { patchItems: ITEMS });
    expect(uyRes.items.find((i: any) => i.item === 'yasha')).toMatchObject({ first_purchased: null, delivery_delay_seconds: null });
    expect(uyRes.items.find((i: any) => i.item === 'ultimate_scepter')).toMatchObject({ first_purchased: null, delivery_delay_seconds: null });
    expect(uyRes.items.find((i: any) => i.item === 'manta')).toMatchObject({ first_purchased: null, delivery_delay_seconds: null });

    // Second blade bought AFTER unmatched Yasha (850 > 510): Yasha consumed the 400s blade, so the 850s blade
    // unambiguously belongs to Aghs (other parts by 800 -> purchased at 850, held at 960, delay 110s).
    // Conversely, if a second blade was bought BEFORE unmatched Yasha (480 < 510), uncertainty [400, 480] propagates
    // to the surviving blade so Aghs (other parts by 470) stays null!
    const secondBladeAfter = buildSyntheticTrace({
      purchases: [
        { item: 'blade_of_alacrity', t: 400 },
        { item: 'boots_of_elves', t: 450 },
        { item: 'yasha', t: 510 },
        { item: 'point_booster', t: 600 },
        { item: 'ogre_axe', t: 700 },
        { item: 'staff_of_wizardry', t: 800 },
        { item: 'blade_of_alacrity', t: 850 },
        { item: 'ultimate_scepter', t: 960 },
      ],
      heldItems: [
        { item: 'yasha', from: 510, to: 1500 },
        { item: 'ultimate_scepter', from: 960 },
      ],
    });
    const sbaRes: any = itemTimeline(secondBladeAfter, { hero: 'beastmaster' }, { patchItems: ITEMS });
    expect(sbaRes.items.find((i: any) => i.item === 'yasha')).toMatchObject({ first_purchased: null, delivery_delay_seconds: null });
    expect(sbaRes.items.find((i: any) => i.item === 'ultimate_scepter')).toMatchObject({
      first_purchased: { t: 850, clock: '14:10', source: 'components' },
      delivery_delay_seconds: 110,
    });

    const secondBladeBefore = buildSyntheticTrace({
      purchases: [
        { item: 'blade_of_alacrity', t: 400 },
        { item: 'boots_of_elves', t: 450 },
        { item: 'point_booster', t: 455 },
        { item: 'ogre_axe', t: 460 },
        { item: 'staff_of_wizardry', t: 470 },
        { item: 'blade_of_alacrity', t: 480 },
        { item: 'yasha', t: 510 },
        { item: 'ultimate_scepter', t: 600 },
      ],
      heldItems: [
        { item: 'yasha', from: 510, to: 1500 },
        { item: 'ultimate_scepter', from: 600 },
      ],
    });
    const sbbRes: any = itemTimeline(secondBladeBefore, { hero: 'beastmaster' }, { patchItems: ITEMS });
    expect(sbbRes.items.find((i: any) => i.item === 'yasha')).toMatchObject({ first_purchased: null, delivery_delay_seconds: null });
    expect(sbbRes.items.find((i: any) => i.item === 'ultimate_scepter')).toMatchObject({ first_purchased: null, delivery_delay_seconds: null });

    // Created upgrade without component list (dagon_2) -> null rather than guessing
    const dagon2 = buildSyntheticTrace({
      purchases: [{ item: 'dagon_2', t: 900 }],
      heldItems: [{ item: 'dagon_2', from: 920 }],
    });
    expect((itemTimeline(dagon2, { hero: 'beastmaster' }, { patchItems: ITEMS }) as any).items[0]).toMatchObject({
      first_purchased: null,
      delivery_delay_seconds: null,
    });
  });

  it('pre-horn starting items held at trace.t0 keep delivery_delay_seconds null instead of bogus pre-horn delay', () => {
    const tr = buildSyntheticTrace({
      purchases: [{ item: 'boots', t: -60 }],
      heldItems: [{ item: 'boots', from: 0 }],
    });
    const boots = (itemTimeline(tr, { hero: 'beastmaster' }, { patchItems: ITEMS }) as any).items.find((i: any) => i.item === 'boots');
    expect(boots).toMatchObject({
      first_purchased: { t: -60, clock: '-1:00', source: 'direct' },
      first_held: { t: 0, clock: '0:00' },
      delivery_delay_seconds: null,
    });
  });

  it('legacy traces missing purchases or creep_kills return null + explicit gaps (unknown is not false)', () => {
    const tr = buildSyntheticTrace({
      purchases: [{ item: 'blink', t: 720 }],
      heldItems: [{ item: 'blink', from: 870 }],
    });
    const noPurchases = { ...tr };
    delete (noPurchases as any).purchases;
    const rNoP: any = itemTimeline(noPurchases, { hero: 'beastmaster' }, { patchItems: ITEMS });
    expect(rNoP.items[0]).toMatchObject({ first_purchased: null, delivery_delay_seconds: null });
    expect(rNoP.gaps).toContainEqual({ topic: 'item_purchases', reason: 'no_purchases_in_trace' });

    const noCreeps = { ...tr };
    delete (noCreeps as any).creep_kills;
    const rNoC: any = itemTimeline(noCreeps, { hero: 'beastmaster' }, { patchItems: ITEMS });
    expect(rNoC.my_team_courier_deaths).toBeNull();
    expect(rNoC.items[0]).toMatchObject({
      delivery_delay_seconds: 150,
      my_team_courier_deaths_during_delivery: null,
    });
    expect(rNoC.gaps).toContainEqual({ topic: 'courier_deaths', reason: 'no_creep_kills_in_trace' });

    // Without patchItems (including standalone CLI `dota2ai trace item_timeline`), purchase timing MUST stay null + gap
    // rather than mislabeling composite combine-log timestamps (e.g. Skywrath Scepter 30:51) as direct shop purchases (PR #496 P1).
    const rNoRecipes: any = runTraceTool(tr, 'item_timeline', { hero: 'beastmaster' }, { perspective: 'beastmaster' });
    expect(rNoRecipes.items[0]).toMatchObject({ first_purchased: null, delivery_delay_seconds: null });
    expect(rNoRecipes.gaps).toContainEqual({
      topic: 'item_purchases',
      reason: 'patch_item_recipes_not_provided: purchase_timing_requires_item_recipes',
    });

    let cliOut = '';
    const code = runTrace(['trace', 'item_timeline', '--trace', REAL_TRACE_PATH, '--hero', 'skywrath_mage'], {
      stdout: { write: (s: string) => { cliOut += s; } },
      stderr: { write: () => {} },
    });
    expect(code).toBe(0);
    const cliParsed = JSON.parse(cliOut);
    expect(cliParsed.items.find((i: any) => i.item === 'ultimate_scepter')).toMatchObject({
      first_purchased: null,
      first_held: { clock: '31:16' },
      delivery_delay_seconds: null,
    });
    expect(cliParsed.gaps).toContainEqual({
      topic: 'item_purchases',
      reason: 'patch_item_recipes_not_provided: purchase_timing_requires_item_recipes',
    });
  });

  it('wires purchase vs delivery and courier deaths through build_check, reviewToolkit, resolveRef, and verifyReview', () => {
    const tr = buildSyntheticTrace({
      purchases: [
        { item: 'point_booster', t: 600 },
        { item: 'ogre_axe', t: 700 },
        { item: 'staff_of_wizardry', t: 800 },
        { item: 'blade_of_alacrity', t: 900 },
        { item: 'ultimate_scepter', t: 1080 },
      ],
      heldItems: [{ item: 'ultimate_scepter', from: 1080 }],
      courierKills: [{ killer: 'phantom_assassin', killerTeam: 2, targetTeam: 3, t: 920 }],
    });
    const bc: any = buildCheck(tr, { hero: 'beastmaster' }, { lang: 'zh' });
    expect(bc.my_team_courier_deaths).toEqual([{ t: 920, clock: '15:20', killed_by: 'phantom_assassin' }]);
    expect(bc.my_big_items_in_order[0]).toMatchObject({
      item: 'ultimate_scepter',
      first_purchased: '15:00',
      first_held: '18:00',
      delivery_delay_seconds: 180,
      my_team_courier_deaths_during_delivery: [{ clock: '15:20', killed_by: 'phantom_assassin' }],
    });
    expect(bc.gaps).toContainEqual(expect.objectContaining({ topic: 'courier_ownership_and_cargo' }));

    // resolveRef resolves item:<hero>:<item> with localized courier-killer name and purchase vs delivery timing
    const resolved: any = resolveRef(tr, 'item:beastmaster:ultimate_scepter', { hero: 'beastmaster', lang: 'zh' });
    expect(resolved).toMatchObject({
      ref: 'item:beastmaster:ultimate_scepter',
      kind: 'item',
      record: {
        first_purchased: { t: 900, clock: '15:00', source: 'components' },
        first_held: { t: 1080, clock: '18:00' },
        delivery_delay_seconds: 180,
        my_team_courier_deaths_during_delivery: [{ t: 920, clock: '15:20', killed_by: 'phantom_assassin' }],
      },
      names: { ultimate_scepter: '阿哈利姆神杖', phantom_assassin: '幻影刺客' },
    });

    // verifyReview accepts purchase clock, delivery clock, delay seconds, and courier death clock under item/build refs
    const kit: any = reviewToolkit({ trace: tr, hero: 'beastmaster', lang: 'zh' });
    const tl = kit.runTool('item_timeline', { hero: 'beastmaster' });
    const review = {
      verdict: '阿哈利姆神杖在 15:00 已买齐散件，18:00 才到身上。',
      mainline: [],
      blind_spots: [],
      findings: [{
        title: '神杖购齐与到货间隔较长',
        claim: '神杖 15:00 买齐，18:00 到手。',
        fix: 'f',
        evidence: [{
          refs: ['item:beastmaster:ultimate_scepter'],
          fact: '神杖 15:00 散件买齐、18:00 首次持有，延迟 180 秒，期间 15:20 我方信使被幻影刺客击杀。',
        }],
      }],
    };
    expect(verifyReview(review, [kit.context, tl, bc]).problems).toEqual([]);

    // Real replay 9100904020: Beastmaster Aghs (bought 16:36, held 16:48, +12s) and Skywrath Aghs (bought 30:26, held 31:16, +50s)
    const realKit: any = reviewToolkit({ trace: REAL_TRACE, hero: 'beastmaster', lang: 'zh', match: REAL_MATCH });
    const realBm = realKit.runTool('item_timeline', { hero: 'beastmaster' });
    expect(realBm.items.find((i: any) => i.item === 'ultimate_scepter')).toMatchObject({
      first_purchased: { clock: '16:36', source: 'components' },
      first_held: { clock: '16:48' },
      delivery_delay_seconds: 12,
      my_team_courier_deaths_during_delivery: null, // legacy fixture has no creep_kills
    });
    const realSky = realKit.runTool('item_timeline', { hero: 'skywrath_mage' });
    expect(realSky.items.find((i: any) => i.item === 'ultimate_scepter')).toMatchObject({
      first_purchased: { clock: '30:26', source: 'components' },
      first_held: { clock: '31:16' },
      delivery_delay_seconds: 50,
    });
    const realBuild = realKit.runTool('build_check', { hero: 'beastmaster' });
    expect(realBuild.my_big_items_in_order.find((i: any) => i.item === 'ultimate_scepter')).toMatchObject({
      first_purchased: '16:36',
      first_held: '16:48',
      delivery_delay_seconds: 12,
      my_team_courier_deaths_during_delivery: null,
    });
    expect(realBuild.my_team_courier_deaths).toBeNull();
  });
});
