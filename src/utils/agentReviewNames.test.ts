import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { attackOf, buildCheck, contactBeforeDeaths, effectSits } from '../../lib/agent/situationTools.js';
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
    // Only effects that sit where the dispel lands: on her, a buff she gives herself; on the player, what her damage
    // put there. Eul's on PA removes neither Stifling Dagger's slow (on the player) nor anything not placed.
    const placed = (where: string) => pa.their_abilities.filter((x: any) => x.dispelled_by === 'basic' && effectSits(x.ability) === where).map((x: any) => x.name);
    expect(a.cyclone.their_effects_it_removes).toEqual(placed('on_them'));
    expect(a.cyclone.their_effects_it_removes).not.toContain('Stifling Dagger');
    expect(a.black_king_bar.their_effects_it_removes).toContain('Stifling Dagger');
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

// #504 follow-up: a dispel cast on Ursa removes Overpower (his own buff), never Earthshock's slow (on the player).
describe('where an enemy ability\'s effect sits, for what a dispel can remove', () => {
  it('no target and no damage: a buff on the caster; a damaging ability: on whom it hits; otherwise not placed', () => {
    expect(effectSits('ursa_overpower')).toBe('on_them');
    expect(effectSits('sven_warcry')).toBe('on_them');
    expect(effectSits('ursa_earthshock')).toBe('on_the_player');
    expect(effectSits('phantom_assassin_stifling_dagger')).toBe('on_the_player');
    // A targeted spell without damage may land on an enemy or an ally; a passive is cast by nobody: not placed.
    expect(effectSits('skywrath_mage_ancient_seal')).toBeNull();
    expect(effectSits('ursa_fury_swipes')).toBeNull();
    expect(effectSits('no_such_ability')).toBeNull();
    expect(effectSits('ursa_overpower', {})).toBeNull();
  });

  it('the placement comes from the constants\' behavior and damage type alone', () => {
    const fake: any = { a: { behavior: 'No Target' }, b: { behavior: ['No Target', 'Instant Cast'], dmg_type: 'Magical' }, c: { behavior: ['AOE', 'No Target'] }, d: {} };
    expect([effectSits('a', fake), effectSits('b', fake), effectSits('c', fake), effectSits('d', fake)]).toEqual(['on_them', 'on_the_player', null, null]);
  });
});
