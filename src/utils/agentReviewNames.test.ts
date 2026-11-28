import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { attackOf, buildCheck, contactBeforeDeaths, effectsRemovedBy, observedPlacement, observedRemoval, observedTargetState } from '../../lib/agent/situationTools.js';
import { deathContext } from '../../packages/review-engine/src/trace/index.js';
import { reviewToolkit, verifyReview } from '../../lib/agent/deepReview.js';
import { withHeroNames } from '../../lib/agent/review/toolkit.js';
import { unnamedHeroes } from '../../lib/agent/review/verify.js';
import { ANSWERS } from '../../lib/coach/knowledge.js';
import { patchForGame } from '../../lib/agent/patchData.js';

const trace = JSON.parse(gunzipSync(readFileSync(new URL('../../packages/review-engine/test/fixtures/trace-9100904020.json.gz', import.meta.url))).toString());
const match = JSON.parse(readFileSync(new URL('../fixtures/agent/match9100904020.scoreboard.json', import.meta.url), 'utf8'));
const ABILITIES = JSON.parse(readFileSync(new URL('../../lib/coach/data/abilities.json', import.meta.url), 'utf8'));

// #495: 9091400302's Tidehunter review called Ursa "厄萨" twenty times and never "熊战士", counted Ghost Scepter as
// gold against spells, offered nothing but Eul's Scepter against Ursa's attacks, and named Dead in the Water "that
// single-target skill".
describe('the names a tool answer carries', () => {
  const names = { ursa: '熊战士', tidehunter: '潮汐猎人', weaver: '编织者' };

  it('names each hero the answer speaks of, as a value or as a key, and only those', () => {
    const r = withHeroNames({ tool: 'build_check', killed_by: { ursa: 8 }, by_enemy: [{ enemy: 'weaver' }] }, names, 'zh') as any;
    expect(r.hero_names).toEqual({ ursa: '熊战士', weaver: '编织者' });
  });

  it('names an ability from Aghanim\'s Shard or an innate one, from Valve\'s data', () => {
    expect(ABILITIES.granted.tidehunter_dead_in_the_water).toMatchObject({ en: 'Dead in the Water', zh: '重如铁锚', by: 'shard' });
    const r = withHeroNames({ tool: 'ability_audit', ability: 'tidehunter_dead_in_the_water', by_target: { ursa: 4 } }, names, 'zh') as any;
    expect(r.ability_names).toEqual({ tidehunter_dead_in_the_water: '重如铁锚' });
    expect((withHeroNames({ ability: 'tidehunter_dead_in_the_water' }, names, 'en') as any).ability_names).toEqual({ tidehunter_dead_in_the_water: 'Dead in the Water' });
  });

  it('leaves an answer that names no hero and no ability as it is', () => {
    const plain = { tool: 'match_overview', duration: '45:22' };
    expect(withHeroNames(plain, names, 'zh')).toBe(plain);
    expect(withHeroNames(null, names, 'zh')).toBeNull();
  });

  it('every review tool answer comes with the names of the heroes in it', async () => {
    const kit = reviewToolkit({ trace, hero: 'beastmaster', lang: 'zh', match })!;
    const r: any = await kit.runTool('build_check', { hero: 'beastmaster' });
    expect(r.hero_names.phantom_assassin).toBe(kit.context.hero_names.phantom_assassin);
    expect(Object.keys(r.hero_names).every((k) => kit.context.hero_names[k] === r.hero_names[k])).toBe(true);
  });
});

describe('a review that never names the hero who killed the player most', () => {
  const ctx = { player_hero: 'tidehunter', hero_names: { tidehunter: '潮汐猎人', ursa: '熊战士', weaver: '编织者', warlock: '术士' } };
  const tools = [{ tool: 'build_check', hero: 'tidehunter', killed_by: { ursa: 8, weaver: 2 } }, { tool: 'death_context', hero: 'warlock', killed_by: { weaver: 5 } }];

  it('is asked about the name it never used', () => {
    expect(unnamedHeroes({ verdict: '杀死你 8 次的厄萨只靠普攻。' }, [ctx, ...tools], ctx)).toEqual(['熊战士 (ursa)']);
  });

  it('is not asked when the name, or the key the site names for it, is there', () => {
    expect(unnamedHeroes({ verdict: '杀死你 8 次的熊战士只靠普攻。' }, [ctx, ...tools], ctx)).toEqual([]);
    expect(unnamedHeroes({ verdict: '杀死你 8 次的 ursa 只靠普攻。' }, [ctx, ...tools], ctx)).toEqual([]);
  });

  it('nor about a hero who killed the player less than 3 times, or killed somebody else', () => {
    // Weaver: 2 of the player's deaths; the 5 are Warlock's.
    expect(unnamedHeroes({ verdict: '熊战士' }, [ctx, ...tools], ctx)).toEqual([]);
    // Without the names, or without a killed_by, there is nothing to ask.
    expect(unnamedHeroes({ verdict: '厄萨' }, tools, {})).toEqual([]);
    expect(unnamedHeroes({ verdict: '厄萨' }, [ctx, { hero: 'tidehunter', by_target: { ursa: 9 } }], ctx)).toEqual([]);
  });

  it('verifyReview puts it to the model once, and drops nothing for it', () => {
    const check = verifyReview({ verdict: '杀死你多次的厄萨只靠普攻。' }, [ctx, ...tools]);
    expect(check.problems).toContainEqual({ where: 'whole_review', index: 0, kind: 'unnamed', text: '熊战士 (ursa)', soft: true });
  });
});

describe('build_check: the shop\'s items that act on the damage that killed the player', () => {
  const r: any = buildCheck(trace, { hero: 'beastmaster' }, { lang: 'zh', match });
  const pd = patchForGame(trace.match_id, match);
  const [pa, necro] = r.answers_to_top_killers;

  it('against an attacker: what disarms, pushes, turns ethereal, blocks or returns attacks — whatever the role, cheapest first', () => {
    expect(pa.killer).toBe('phantom_assassin');
    expect(pa.items_acting_on_their_damage.against_their).toBe('attacks');
    const by = Object.fromEntries(pa.items_acting_on_their_damage.items.map((i: any) => [i.item, i]));
    expect(by.heavens_halberd.how).toContain('disarms_target');
    expect(by.force_staff.how).toContain('moves_a_unit');
    expect(by.ghost.how).toContain('physical_immunity');
    expect(by.blade_mail.how).toContain('returns_attack_damage');
    const costs = pa.items_acting_on_their_damage.items.map((i: any) => i.cost);
    expect(costs).toEqual([...costs].sort((a: number, b: number) => a - b));
    // Each with this patch's price and Valve's text, as every other item build_check lists.
    expect(by.heavens_halberd.cost).toBe(pd.items.heavens_halberd.cost);
    expect(by.heavens_halberd.does[0].valve_text).toContain('Prevents a target from attacking');
  });

  it('against a caster: spell immunity, magic barriers, magic resistance — and never Ghost Scepter', () => {
    expect(necro.items_acting_on_their_damage.against_their).toBe('abilities');
    const by = Object.fromEntries(necro.items_acting_on_their_damage.items.map((i: any) => [i.item, i]));
    expect(by.black_king_bar.how).toContain('spell_immunity');
    expect(by.ghost).toBeUndefined();
  });

  it('Ghost Scepter is no answer to spells: Valve says it makes magic damage hurt more', () => {
    expect(pd.items.ghost.abilities[0].description).toMatch(/more vulnerable to magic damage/);
    expect([...ANSWERS.magic.core, ...ANSWERS.magic.support]).not.toContain('ghost');
    expect([...ANSWERS.physical.core, ...ANSWERS.physical.support]).toContain('ghost');
  });
});

// Owner, 2026-11-28: no fixed pick; the tools give how each item meets this enemy's kit — Blink starts the fight, Heaven's
// Halberd disarms the melee attacker, Eul's Scepter on him dispels his buff — and the model weighs them in the game.
describe('build_check: how each item meets the enemy who killed the player', () => {
  const r: any = buildCheck(trace, { hero: 'beastmaster' }, { lang: 'en', match });
  const [pa, necro] = r.answers_to_top_killers;
  const items = JSON.parse(readFileSync(new URL('../../lib/data/constants/items.json', import.meta.url), 'utf8'));
  const by = (k: any) => Object.fromEntries(k.items_acting_on_their_damage.items.map((i: any) => [i.item, i]));

  it('how the enemy attacks, how each of their abilities is cast, and the big items they held with when', () => {
    const heroes = JSON.parse(readFileSync(new URL('../../lib/data/constants/heroes.json', import.meta.url), 'utf8'));
    expect(pa.their_attack).toEqual({ type: 'melee', range: heroes['44'].attack_range });
    expect(necro.their_attack.type).toBe('ranged');
    expect(pa.their_abilities.find((a: any) => a.ability === 'phantom_assassin_phantom_strike')).toMatchObject({ cast: 'Unit Target', dispelled_by: 'basic' });
    expect(pa.their_big_items.find((i: any) => i.item === 'black_king_bar')).toEqual({ item: 'black_king_bar', name: 'Black King Bar', first_held: '21:29' });
    const ts = pa.their_big_items.map((i: any) => i.first_held.split(':').reduce((m: number, s: string) => m * 60 + Number(s), 0));
    expect(ts).toEqual([...ts].sort((a: number, b: number) => a - b));
  });

  it('a dispel says on whom it lands, and which of the enemy\'s abilities Valve marks removable by it', () => {
    const a = by(pa);
    // Eul's: cast on an enemy (Valve: "can only be cast on enemy units or yourself"), a basic dispel.
    expect(a.cyclone).toMatchObject({ applies_dispel: 'basic', dispel_lands_on: 'an_enemy_target' });
    // Which of her effects it removes: only a dispel seen in archived replays — the item's effect taking her ability's
    // modifier off a hero it landed on, on that side (#510 review); never joined from a dispel flag and a placement.
    const keyOf = (name: string) => pa.their_abilities.find((x: any) => x.name === name)?.ability;
    // Both facts, every time: Valve marks it removable by that dispel, and the item was seen removing it on that side.
    const flag = (name: string) => pa.their_abilities.find((x: any) => x.name === name)?.dispelled_by;
    for (const r of a.cyclone.their_effects_it_removes ?? []) {
      expect(flag(r.name)).toBe('basic');
      expect(observedRemoval('cyclone', keyOf(r.name), ['enemy_hero'])).toEqual({ removed: r.removed, games: r.games });
    }
    for (const r of a.black_king_bar.their_effects_it_removes ?? []) {
      expect(flag(r.name)).toBe('basic');
      expect(observedRemoval('black_king_bar', keyOf(r.name), ['self', 'ally_hero'])).toEqual({ removed: r.removed, games: r.games });
    }
    // Where each of her abilities' modifiers was seen land is its own fact, beside dispelled_by.
    for (const x of pa.their_abilities) {
      const p = observedPlacement(x.ability);
      if (p) expect(x).toMatchObject({ observed_on: p.sits === 'on_them' ? 'them' : 'enemy_heroes', observed_times: p.seen });
      else expect(x).not.toHaveProperty('observed_on');
    }
    expect(a.cyclone).not.toHaveProperty('their_abilities_marked_removable_by_it');
    expect(pa.their_abilities.find((x: any) => x.ability === 'phantom_assassin_phantom_strike')).toHaveProperty('valve_text');
    expect(a.nullifier.dispel_lands_on).toBe('an_enemy_target');
    // Black King Bar's dispel is on the player, never on the enemy.
    expect(a.black_king_bar).toMatchObject({ applies_dispel: 'basic', dispel_lands_on: 'self_or_allies' });
    expect(a.aeon_disk).toMatchObject({ applies_dispel: 'strong', dispel_lands_on: 'self_or_allies' });
    // Halberd: Valve's disarm durations for this patch.
    const pd = patchForGame(trace.match_id, match);
    const disarm = pd.items.heavens_halberd.attrib.find((x: any) => x.key === 'disarm_melee');
    expect(a.heavens_halberd.disarm_seconds.melee).toBe(Number(disarm.value));
    // No dispel, no dispel fields: nothing is said that the data does not hold.
    expect(a.force_staff).not.toHaveProperty('applies_dispel');
    expect(items.force_staff.abilities.some((x: any) => /dispel/i.test(x.description))).toBe(false);
  });

  it('a hero the constants do not hold, or hold without an attack type, has no attack: unknown, not a guess', () => {
    expect(attackOf(44)).toMatchObject({ type: 'melee' });
    expect(attackOf(99999)).toBeNull();
    expect(attackOf(null)).toBeNull();
    expect(attackOf(44, { 44: { attack_range: 150 } })).toBeNull();
    expect(attackOf(44, { 44: { attack_type: 'Melee' } })).toEqual({ type: 'melee' });
  });
});

// Owner, 2026-11-28: Ursa's damage is attacks that stack; what answers it is what breaks the chain (Halberd, Eul's,
// Ghost Scepter), not armor. The tools give how each kill went, so the model can set it against how long an item lasts.
describe('build_check: how the killer killed the player, death by death', () => {
  const seat = trace.heroes.findIndex((h: any) => h.key === 'beastmaster');

  it('the last unbroken run of the killer\'s damage before each death they made, from the damage log', () => {
    const runs: any = contactBeforeDeaths(trace, seat, 'phantom_assassin');
    const d: any = deathContext(trace, { hero: 'beastmaster' });
    const theirs = d.deaths.filter((x: any) => x.killer === 'phantom_assassin');
    // One per death she made, numbered and timed as death_context numbers and times them.
    expect(runs.map((r: any) => [r.death, r.clock])).toEqual(theirs.map((x: any) => [x.n, x.clock]));
    for (const r of runs.filter((x: any) => x.contact_seconds != null)) {
      expect(r.contact_seconds).toBeGreaterThanOrEqual(1);
      expect(r.contact_seconds).toBeLessThanOrEqual(21);
      expect(r.their_attack_damage + r.their_ability_damage).toBeGreaterThan(0);
    }
    // build_check carries it for the top killer.
    const b: any = buildCheck(trace, { hero: 'beastmaster' }, { lang: 'en', match });
    expect(b.answers_to_top_killers[0].how_they_killed_me).toEqual(runs);
  });

  it('a run is summed from the log: attacks (no inflictor) apart from abilities, and it stops at a gap over 2 s', () => {
    const t: any = structuredClone(trace);
    const me = t.names.indexOf(t.heroes[seat].npc);
    const pa = t.names.indexOf(t.heroes.find((h: any) => h.key === 'phantom_assassin').npc);
    const first = (contactBeforeDeaths(t, seat, 'phantom_assassin') as any[])[0];
    const death = Number(first.clock.split(':')[0]) * 60 + Number(first.clock.split(':')[1]);
    t.damage = t.damage.filter((r: any) => !(r[1] === pa && r[2] === me));
    t.damage.push([death - 10, pa, me, -1, 500], [death - 2, pa, me, -1, 300], [death - 1, pa, me, 7, 40]);
    const [r] = contactBeforeDeaths(t, seat, 'phantom_assassin') as any[];
    expect(r).toMatchObject({ began: `${Math.floor((death - 2) / 60)}:${String((death - 2) % 60).padStart(2, '0')}`, their_attack_damage: 300, their_ability_damage: 40 });
  });

  it('a run longer than the look-back is followed back to its real start, not cut at 20 s (#504 review)', () => {
    const t: any = structuredClone(trace);
    const me = t.names.indexOf(t.heroes[seat].npc);
    const pa = t.names.indexOf(t.heroes.find((h: any) => h.key === 'phantom_assassin').npc);
    const first = (contactBeforeDeaths(t, seat, 'phantom_assassin') as any[])[0];
    const death = Number(first.clock.split(':')[0]) * 60 + Number(first.clock.split(':')[1]);
    t.damage = t.damage.filter((r: any) => !(r[1] === pa && r[2] === me));
    for (let s = death - 30; s <= death; s += 1) t.damage.push([s, pa, me, -1, 50]);
    const [r] = contactBeforeDeaths(t, seat, 'phantom_assassin') as any[];
    expect(r.their_attack_damage).toBe(31 * 50);
    expect(r.contact_seconds).toBeGreaterThanOrEqual(30);
    // Her damage only long before the death (an earlier fight) is no run that ended in it.
    t.damage = t.damage.filter((r: any) => !(r[1] === pa && r[2] === me)).concat([[death - 40, pa, me, -1, 500]]);
    expect((contactBeforeDeaths(t, seat, 'phantom_assassin') as any[])[0]).toEqual({ death: first.death, clock: first.clock, contact_seconds: null });
  });

  it('no damage log: unknown (null), never "no contact"; a death they made with no damage of theirs in it: contact_seconds null', () => {
    const t: any = structuredClone(trace);
    delete t.damage;
    expect(contactBeforeDeaths(t, seat, 'phantom_assassin')).toBeNull();
    const u: any = structuredClone(trace);
    const pa = u.names.indexOf(u.heroes.find((h: any) => h.key === 'phantom_assassin').npc);
    u.damage = u.damage.filter((r: any) => r[1] !== pa);
    const runs: any = contactBeforeDeaths(u, seat, 'phantom_assassin');
    expect(runs.length).toBeGreaterThan(0);
    for (const r of runs) expect(r).toEqual({ death: r.death, clock: r.clock, contact_seconds: null });
  });

  it('an item whose effect has a duration says how long, in Valve\'s numbers', () => {
    const b: any = buildCheck(trace, { hero: 'beastmaster' }, { lang: 'en', match });
    const by = Object.fromEntries(b.answers_to_top_killers[0].items_acting_on_their_damage.items.map((i: any) => [i.item, i]));
    const pd = patchForGame(trace.match_id, match);
    const v = (k: string, a: string) => Number(pd.items[k].attrib.find((x: any) => x.key === a).value);
    expect(by.heavens_halberd.lasts_seconds).toBe(v('heavens_halberd', 'disarm_melee'));
    expect(by.cyclone.lasts_seconds).toBe(v('cyclone', 'cyclone_duration'));
    expect(by.ghost.lasts_seconds).toBe(v('ghost', 'duration'));
    expect(by.blade_mail).not.toHaveProperty('lasts_seconds');
    // Set against her kills of the player: of those with a known length, how many were over within that time.
    const runs = (contactBeforeDeaths(trace, seat, 'phantom_assassin') as any[]).map((r) => r.contact_seconds).filter((x) => x != null);
    expect(by.heavens_halberd).toMatchObject({ of_their_kills_timed: runs.length, their_kills_that_took_no_longer: runs.filter((x) => x <= by.heavens_halberd.lasts_seconds).length });
    expect(by.blade_mail).not.toHaveProperty('their_kills_that_took_no_longer');
  });
});

describe('build_check: the player\'s own hero, for how an item sits with it', () => {
  it('deaths short of mana are counted only over deaths whose mana the trace shows', async () => {
    const mod: any = await import('../../lib/agent/situationTools.js');
    const deaths = { deaths: [
      { clock: '4:21', most_mana_in_window: 51, off_cooldown_without_the_mana: ['tidehunter_gush'] },
      { clock: '6:07', most_mana_in_window: 300, off_cooldown_without_the_mana: [] },
      { clock: '8:12', most_mana_in_window: null, off_cooldown_without_the_mana: [] },
    ] };
    expect(mod.myHeroFacts(29, deaths)).toMatchObject({ primary_attribute: 'strength', deaths_with_a_spell_off_cooldown_but_short_of_mana: 1, of_deaths_with_mana_known: 2, at: ['4:21'] });
    expect(mod.myHeroFacts(29, { deaths: [{ clock: '8:12', most_mana_in_window: null, off_cooldown_without_the_mana: [] }] }).deaths_with_a_spell_off_cooldown_but_short_of_mana).toBeNull();
    expect(mod.myHeroFacts(29, { error: 'x' }).deaths_with_a_spell_off_cooldown_but_short_of_mana).toBeNull();
  });

  it('primary attribute, attack, and deaths with a spell off cooldown but short of mana, from death_context', () => {
    const b: any = buildCheck(trace, { hero: 'beastmaster' }, { lang: 'en', match });
    const heroes = JSON.parse(readFileSync(new URL('../../lib/data/constants/heroes.json', import.meta.url), 'utf8'));
    expect(b.my_hero.primary_attribute).toBe({ str: 'strength', agi: 'agility', int: 'intelligence', all: 'universal' }[heroes['38'].primary_attr as string]);
    expect(b.my_hero.attack).toEqual(attackOf(38));
    // This trace has no mana samples (most_mana_in_window null in every death): whether a death was short of mana is
    // unknown — null, never 0 (#504 review).
    const d: any = deathContext(trace, { hero: 'beastmaster' });
    expect(d.deaths.every((x: any) => x.most_mana_in_window == null)).toBe(true);
    expect(b.my_hero.deaths_with_a_spell_off_cooldown_but_short_of_mana).toBeNull();
    expect(b.my_hero).not.toHaveProperty('of_deaths_with_mana_known');
    expect(b.my_hero).not.toHaveProperty('at');
    // An item's mana regen and intelligence are among what it gives (Valve's stats).
    const cyclone = b.answers_to_top_killers[0].items_acting_on_their_damage.items.find((i: any) => i.item === 'cyclone');
    expect(cyclone.gives).toMatchObject({ mana_regen: expect.any(Number), intelligence: expect.any(Number) });
  });
});

// #508: what abilities and items did, observed in archived replays (scripts/observe-effects.mjs), never inferred.
describe('observed effects: where an ability\'s effect sat, and what an item made its target', () => {
  const obs: any = {
    sources: {
      'ability:ursa_overpower': { modifiers: { modifier_ursa_overpower: { self: 115, ally_hero: 0, enemy_hero: 0, other: 0, games: 3 } } },
      'ability:ursa_earthshock': { modifiers: { modifier_ursa_earthshock: { self: 0, ally_hero: 0, enemy_hero: 66, other: 40, games: 3 }, modifier_ursa_earthshock_move: { self: 65, ally_hero: 0, enemy_hero: 0, other: 0, games: 3 } } },
      'ability:necrolyte_ghost_shroud': { modifiers: { modifier_necrolyte_ghost_shroud_active: { self: 8, ally_hero: 0, enemy_hero: 0, other: 0, games: 1 }, modifier_necrolyte_ghost_shroud_aura_effect: { self: 0, ally_hero: 0, enemy_hero: 13, other: 17, games: 1 } } },
      'item:cyclone': { modifiers: { modifier_eul_cyclone: { self: 3, ally_hero: 0, enemy_hero: 2, other: 0, games: 2, target_state: { samples: 40, stunned: 40, invulnerable: 40, silenced: 3 } } } },
      'item:blade_mail': { modifiers: { modifier_item_blade_mail_reflect: { self: 4, ally_hero: 0, enemy_hero: 0, other: 0, games: 1, target_state: { samples: 3, stunned: 3 } } } },
    },
  };

  it('an ability is placed only by where its effect was seen: its own modifier first, one side only', () => {
    expect(observedPlacement('ursa_overpower', obs)).toEqual({ sits: 'on_them', seen: 115, games: 3 });
    // The slow, modifier_ursa_earthshock, landed on enemy heroes; the leap's _move on Ursa is not the one named after it.
    expect(observedPlacement('ursa_earthshock', obs)).toEqual({ sits: 'on_the_player', seen: 66, games: 3 });
    // On Necrophos and, as an aura, on his enemies: not placed.
    expect(observedPlacement('necrolyte_ghost_shroud', obs)).toBeNull();
    // Never observed, or no observations at all: not placed (unknown, never "on the player").
    expect(observedPlacement('ember_spirit_flame_guard', obs)).toBeNull();
    expect(observedPlacement('ursa_overpower', null)).toBeNull();
  });

  it('a removal is a dispel seen: the item\'s effect taking that ability\'s modifier off a hero, on the asked side', () => {
    const o: any = { ...obs, removals: { 'item:cyclone': { modifier_ursa_overpower: { removed: 3, games: 2, on: { self: 0, ally_hero: 0, enemy_hero: 3 } } }, 'item:black_king_bar': { modifier_ursa_earthshock: { removed: 5, games: 3, on: { self: 5, ally_hero: 0, enemy_hero: 0 } } } } };
    expect(observedRemoval('cyclone', 'ursa_overpower', ['enemy_hero'], o)).toEqual({ removed: 3, games: 2 });
    // Seen only on the other side, never seen, or no removals at all: null.
    expect(observedRemoval('cyclone', 'ursa_overpower', ['self', 'ally_hero'], o)).toBeNull();
    expect(observedRemoval('black_king_bar', 'ursa_earthshock', ['self', 'ally_hero'], o)).toEqual({ removed: 5, games: 3 });
    expect(observedRemoval('cyclone', 'ursa_enrage', ['enemy_hero'], o)).toBeNull();
    // Removed on both sides: this side's count is known, its games are not (the data counts games over every side).
    const both: any = { ...o, removals: { 'item:cyclone': { modifier_ursa_overpower: { removed: 3, games: 2, on: { self: 2, ally_hero: 0, enemy_hero: 1 } } } } };
    expect(observedRemoval('cyclone', 'ursa_overpower', ['enemy_hero'], both)).toEqual({ removed: 1, games: null });
    // Two of its modifiers removed: whether their games overlap is not in the counts — games null (#510 review).
    const two: any = { sources: { 'ability:crystal_maiden_crystal_nova': { modifiers: { modifier_crystal_maiden_crystal_nova: {}, modifier_crystal_maiden_crystal_nova_barrier: {} } } }, removals: { 'item:black_king_bar': { modifier_crystal_maiden_crystal_nova: { removed: 6, games: 4, on: { self: 6, ally_hero: 0, enemy_hero: 0 } }, modifier_crystal_maiden_crystal_nova_barrier: { removed: 1, games: 1, on: { self: 1, ally_hero: 0, enemy_hero: 0 } } } } };
    expect(observedRemoval('black_king_bar', 'crystal_maiden_crystal_nova', ['self', 'ally_hero'], two)).toEqual({ removed: 7, games: null });
    expect(observedRemoval('cyclone', 'ursa_overpower', ['enemy_hero'], obs)).toBeNull();
  });

  it('an item\'s target state is the states nearly all its samples had, with the sample; too few samples say nothing', () => {
    expect(observedTargetState('cyclone', obs)).toEqual({ states: ['invulnerable', 'stunned'], samples: 40, games: 2, on_enemy_heroes: 2 });
    expect(observedTargetState('blade_mail', obs)).toBeNull();
    // Enough samples but no state nearly all of them had: nothing is said.
    expect(observedTargetState('x', { sources: { 'item:x': { modifiers: { modifier_x: { enemy_hero: 3, games: 1, target_state: { samples: 20, stunned: 5 } } } } } })).toBeNull();
    expect(observedTargetState('heavens_halberd', obs)).toBeNull();
    expect(observedTargetState('cyclone', null)).toBeNull();
  });

  it('death_context: the attackers\' casts on anything but the player — their own buffs — in the window', () => {
    const d: any = deathContext(trace, { hero: 'beastmaster' });
    for (const x of d.deaths) {
      expect(Array.isArray(x.attackers_casts_not_on_me)).toBe(true);
      for (const c of x.attackers_casts_not_on_me ?? []) {
        expect(c.dt).toBeLessThanOrEqual(0.05);
        expect(c.dt).toBeGreaterThanOrEqual(-12.05);
        expect(c.target).not.toBe('beastmaster');
      }
    }
    // No damage log: who attacked cannot be told, so their casts are unknown (null), never "none" (#510 review).
    const blank: any = structuredClone(trace);
    delete blank.damage;
    for (const x of (deathContext(blank, { hero: 'beastmaster' }) as any).deaths) expect(x.attackers_casts_not_on_me).toBeNull();
    // Nothing here is also in enemy_casts_on_me (those are the ones aimed at the player).
    const rows = new Set(d.deaths.flatMap((x: any) => x.enemy_casts_on_me.map((c: any) => c.row)));
    expect(d.deaths.flatMap((x: any) => (x.attackers_casts_not_on_me ?? []).map((c: any) => c.row)).some((r: any) => rows.has(r))).toBe(false);
  });

  it('how_they_killed_me: what the killer cast in the 15 s before each kill, their own buffs included', () => {
    const seat = trace.heroes.findIndex((h: any) => h.key === 'beastmaster');
    const runs = contactBeforeDeaths(trace, seat, 'phantom_assassin') as any[];
    const pa = trace.names.indexOf(trace.heroes.find((h: any) => h.key === 'phantom_assassin').npc);
    for (const r of runs) {
      const t = Number(r.clock.split(':')[0]) * 60 + Number(r.clock.split(':')[1]);
      const logged = trace.casts.filter((c: any) => c[1] === pa && c[0] >= t - 15.5 && c[0] <= t + 1).length;
      expect(r.their_casts_in_the_15s_before.length).toBeLessThanOrEqual(logged);
      for (const c of r.their_casts_in_the_15s_before) expect(['self', 'none', 'me', 'other', ...trace.heroes.map((h: any) => h.key)]).toContain(c.target);
    }
  });
});

// #510 review: a removal seen as Black King Bar landed is no dispel when Valve marks the ability undispellable
// (Berserker's Call): it is never listed, however often the two coincided.
describe('their_effects_it_removes needs Valve\'s dispel flag as well as a removal seen', () => {
  const kit = [
    { id: 'axe_berserkers_call', en: "Berserker's Call", dispel: 'no' },
    { id: 'ursa_overpower', en: 'Overpower', dispel: 'basic' },
    { id: 'sven_gods_strength', en: "God's Strength", dispel: 'strong' },
  ];
  const obs: any = {
    sources: {
      'ability:axe_berserkers_call': { modifiers: { modifier_axe_berserkers_call: { enemy_hero: 9 } } },
      'ability:ursa_overpower': { modifiers: { modifier_ursa_overpower: { self: 9 } } },
      'ability:sven_gods_strength': { modifiers: { modifier_sven_gods_strength: { self: 4 } } },
    },
    removals: {
      'item:black_king_bar': { modifier_axe_berserkers_call: { removed: 3, games: 2, on: { self: 3, ally_hero: 0, enemy_hero: 0 } } },
      'item:cyclone': { modifier_ursa_overpower: { removed: 2, games: 1, on: { self: 0, ally_hero: 0, enemy_hero: 2 } } },
      'item:nullifier': { modifier_sven_gods_strength: { removed: 2, games: 1, on: { self: 0, ally_hero: 0, enemy_hero: 2 } } },
    },
  };
  it('an undispellable ability seen "removed" as the item landed is not listed', () => {
    expect(effectsRemovedBy('black_king_bar', 'self_or_allies', 'basic', kit, 'en', obs)).not.toContainEqual(expect.objectContaining({ name: "Berserker's Call" }));
  });
  it('a dispellable one seen removed on that side is; a basic dispel does not take a strong-only effect', () => {
    expect(effectsRemovedBy('cyclone', 'an_enemy_target', 'basic', kit, 'en', obs)).toEqual([{ name: 'Overpower', removed: 2, games: 1 }]);
    expect(effectsRemovedBy('nullifier', 'an_enemy_target', 'basic', kit, 'en', obs)).toEqual([]);
    expect(effectsRemovedBy('nullifier', 'an_enemy_target', 'strong', kit, 'en', obs)).toEqual([{ name: "God's Strength", removed: 2, games: 1 }]);
  });
  it('unknown stays null, never []: no landing side, no dispel, no kit, no observations, an item never seen removing anything', () => {
    expect(effectsRemovedBy('cyclone', null, 'basic', kit, 'en', obs)).toBeNull();
    expect(effectsRemovedBy('cyclone', 'an_enemy_target', null, kit, 'en', obs)).toBeNull();
    expect(effectsRemovedBy('cyclone', 'an_enemy_target', 'basic', null, 'en', obs)).toBeNull();
    expect(effectsRemovedBy('cyclone', 'an_enemy_target', 'basic', kit, 'en', null)).toBeNull();
    expect(effectsRemovedBy('lotus_orb', 'self_or_allies', 'basic', kit, 'en', obs)).toBeNull();
    // Seen removing things, none of them these abilities: [] (the item was looked at, and none is there).
    expect(effectsRemovedBy('black_king_bar', 'self_or_allies', 'basic', kit, 'en', obs)).toEqual([]);
  });
});

// Owner, 2026-11-28: armor or block advice against Ursa is a miss even beside Halberd; a sentence rejecting it is not
// (#510 review). Checked on the p81/p82/p85 texts and on rejections.
describe('rubric 9091400302.tidehunter: armor_or_block_as_the_answer_to_ursa', () => {
  const rubric = JSON.parse(readFileSync(new URL('../../evals/reviews/9091400302.tidehunter.json', import.meta.url), 'utf8'));
  const re = new RegExp(rubric.must_not.find((x: any) => x.id === 'armor_or_block_as_the_answer_to_ursa').pattern, 'i');
  it('flags advice to buy, prioritise or stack armor / damage block', () => {
    for (const t of [
      '这局真正的答案是物理：刃甲、天堂之戟、希瓦的守护或更早的幽魂权杖，堆护甲、致盲、缴械',
      '跳刀之后的第一件大件优先考虑天堂之戟、赤红甲或刃甲这种直接挡普攻的装备',
      '就先补刃甲、赤红甲、希瓦的守护这类物理防守',
      'Get Blade Mail or Crimson Guard before Blink.',
    ]) expect(t).toMatch(re);
  });
  it('does not flag a rejection, a description, or advice without armor', () => {
    for (const t of [
      '熊战士是普攻累积性伤害，堆护甲没用，应使用天堂之戟阻止他攻击。',
      '不要买赤红甲，改用天堂之戟限制熊战士。',
      '先出天堂之戟，而不是买赤红甲。',
      '真正能直接停住普攻的幽魂权杖直到 41:46 才拿到，刃甲、天堂之戟、炎阳纹章、赤红甲一件都没有。',
      '真正针对普攻的装备到 36:56 才出现，而熊战士拿到狂战斧后又杀了你 6 次。',
      '先把「掐掉普攻」的东西排前面：天堂之戟 3300 金钱、缴械 3.5 秒；幽魂权杖 1500 金钱、4 秒物理免疫',
      "Don't buy Blade Mail; get Heaven's Halberd.",
    ]) expect(t).not.toMatch(re);
  });
});

// The owner's case, observed (#508): in 3 recent replays an enemy cast Eul's Scepter on Ursa 5 times, and each time
// modifier_ursa_overpower came off him at that instant. build_check now says so, with its sample.
describe('Eul\'s Scepter on Ursa, observed', () => {
  it('Eul\'s cast on an enemy removes Overpower, seen in archived replays; the corpus says how often', () => {
    const pd = patchForGame(9091400302, null);
    const got = effectsRemovedBy('cyclone', 'an_enemy_target', 'basic', pd.heroAbilities(70), 'en') as any[];
    const overpower = got.find((r) => r.name === 'Overpower');
    expect(overpower).toBeTruthy();
    expect(overpower.removed).toBeGreaterThanOrEqual(5);
    // Never Earthshock's slow (on the player) from a dispel cast on Ursa.
    expect(got.some((r) => r.name === 'Earthshock')).toBe(false);
  });
});
