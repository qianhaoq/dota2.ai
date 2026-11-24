import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import {
  ABILITY_ANSWERS, ABILITY_THREATS, ABILITY_TEXT_SOURCE, COUNTER_GAPS, ITEM_ANSWERS, MECHANISMS, abilityThreat, dispelOnlyIf, itemMechanisms, itemThreats, quoteOf,
} from '../../lib/coach/counters.js';
import { abilityCounters, heroCounters, itemCounters, COUNTER_TOOLS } from '../../lib/agent/counterTools.js';
import { KNOWLEDGE_TOOLS } from '../../lib/agent/knowledgeTools.js';
import { resolveRef } from '../../lib/agent/evidence.js';
import { reviewToolkit } from '../../lib/agent/deepReview.js';
import { CURRENT_RELEASE, patchData } from '../../lib/agent/patchData.js';
import { HEROES_BY_KEY } from '../../packages/review-engine/src/staticHeroes.js';

const trace = JSON.parse(gunzipSync(readFileSync(new URL('../../packages/review-engine/test/fixtures/trace-9100904020.json.gz', import.meta.url))).toString());
// Radiant: axe, phantom_assassin, necrolyte, venomancer, mirana. Dire: sven, beastmaster, undying, skywrath_mage, dark_willow.
const ctx = { perspective: 'beastmaster', lang: 'en' };
const players = (tier: number | null) => trace.heroes.map((h: any) => ({ hero_id: (HEROES_BY_KEY as any).get(h.key).id, rank_tier: tier }));
/** The same game told as if played in 7.41f (start_time decides the release). */
const in741f = { start_time: Date.parse('2026-10-01T12:00:00Z') / 1000, players: players(65) };
const now = patchData(CURRENT_RELEASE);
const ALL_ABILITIES = JSON.parse(readFileSync(new URL('../../lib/data/constants/abilities.json', import.meta.url), 'utf8'));

describe('counter tables are grounded in Valve\'s text', () => {
  it('every curated item answer is confirmed by the newest release\'s Valve text, with the sentence quoted', () => {
    for (const [key, entries] of Object.entries(ITEM_ANSWERS) as [string, any[]][]) {
      const r = itemMechanisms(key, now.items);
      expect(r.exists, key).toBe(true);
      // Bloodthorn's Pierce is the one entry kept for older releases: 7.42 removed it.
      const expected = key === 'bloodthorn' ? entries.length - 1 : entries.length;
      expect(r.confirmed.filter((c: any) => c.from === 'text').length, key).toBe(new Set(entries.slice(0, expected).map((e) => `${e.m}/${e.on}`)).size);
      for (const c of r.confirmed) expect(c.valve_says.length, key).toBeGreaterThan(5);
      for (const e of entries) expect(MECHANISMS[e.m as keyof typeof MECHANISMS], `${key} ${e.m}`).toBeDefined();
    }
  });

  it('every curated ability answer and threat trait is in that ability\'s Valve text', () => {
    for (const [id, entries] of Object.entries(ABILITY_ANSWERS) as [string, any[]][]) {
      for (const e of entries) {
        expect(ALL_ABILITIES[id]?.desc, id).toMatch(e.ev);
        expect(MECHANISMS[e.m as keyof typeof MECHANISMS]).toBeDefined();
      }
    }
    for (const [trait, list] of Object.entries(ABILITY_THREATS)) {
      for (const id of Object.keys(list)) expect(abilityThreat({ id }).traits.map((t: any) => t.trait), `${trait} ${id}`).toContain(trait);
    }
  });

  it('every mechanism states its basis, conditions and limits; the unmodelled ones are listed as gaps', () => {
    for (const [m, x] of Object.entries(MECHANISMS)) {
      expect(x.basis, m).toMatch(/Valve/);
      expect(x.conditions.length, m).toBeGreaterThan(0);
      expect(x.limits.length, m).toBeGreaterThan(0);
    }
    expect(COUNTER_GAPS.map((g) => g.topic)).toEqual(expect.arrayContaining(['channel_interruption', 'illusions']));
    expect(ABILITY_TEXT_SOURCE).toMatchObject({ patch: expect.stringMatching(/^7\.\d+/), fetched: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
  });

  it('quotes the whole Valve segment that matches, and nothing when none does', () => {
    expect(quoteOf(['Pierce: 80% chance to pierce through evasion.', 'Other.'], /pierce through evasion/)).toBe('Pierce: 80% chance to pierce through evasion.');
    expect(quoteOf(['a'.repeat(500) + ' True Strike ' + 'b'.repeat(500)], /True Strike/)).toMatch(/^….*True Strike.*…$/);
    expect(quoteOf(['nothing here'], /True Strike/)).toBeNull();
  });
});

describe('mechanisms per release', () => {
  it('Bloodthorn: Pierce through evasion in 7.41f, only True Strike against the silenced target in 7.42', () => {
    const old = itemMechanisms('bloodthorn', patchData('7.41f').items);
    expect(old.confirmed.map((c: any) => c.on).sort()).toEqual(['own_attacks', 'silenced_target']);
    const cur = itemMechanisms('bloodthorn', patchData('7.42').items);
    expect(cur.confirmed.map((c: any) => c.on)).toEqual(['silenced_target']);
    expect(cur.not_confirmed).toEqual([{ mechanism: 'true_strike', on: 'own_attacks', reason: 'not_in_valve_text_of_this_release' }]);
  });

  it('item_counters reads the game\'s own release and says what changed since', () => {
    const r: any = itemCounters(trace, { item: 'bloodthorn' }, { ...ctx, match: in741f });
    expect(r).toMatchObject({ data_release: '7.41f', release_exact: true, release_known_from: 'start_time' });
    expect(r.answers.map((a: any) => a.on).sort()).toEqual(['own_attacks', 'silenced_target']);
    expect(r.changed_since_this_release).toEqual({ compared_with: CURRENT_RELEASE, only_in_this_release: ['true_strike/own_attacks'], only_in_newer_release: [] });
    // An item that did not exist in the game's release is no answer for that game.
    expect(itemCounters(trace, { item: 'caduceus' }, { ...ctx, match: in741f })).toMatchObject({ error: 'item_not_in_this_release', data_release: '7.41f', exists_in: CURRENT_RELEASE });
  });
});

describe('ability flags: yes, no, and unknown', () => {
  it('Doom: pierces debuff immunity and is not dispellable, so neither BKB\'s immunity nor any dispel answers it; its pure damage is named in BKB\'s text', () => {
    const r: any = abilityCounters(trace, { ability: 'doom_bringer_doom' }, ctx);
    expect(r).toMatchObject({ hero: 'doom_bringer', hero_in_this_match: false, valve_flags: { damage_type: 'pure', pierces_debuff_immunity: true, dispellable: 'not_dispellable' } });
    expect(r.not_answered_by.map((x: any) => [x.mechanism, x.why])).toEqual(expect.arrayContaining([['debuff_immunity', 'pierces_debuff_immunity'], ['basic_dispel', 'not_dispellable'], ['strong_dispel', 'not_dispellable']]));
    const pure = r.answered_by.find((x: any) => x.mechanism === 'pure_damage');
    expect(pure.items.map((i: any) => i.item)).toEqual(['black_king_bar']);
    expect(pure.items[0].valve_says).toMatch(/immunity to reflected and pure damage/);
    // Minotaur Horn has no shop price in 7.42's data: listed apart, never as an item to buy.
    expect(pure.items_without_a_shop_price).toEqual({ minotaur_horn: 'Minotaur Horn' });
    // Doom is not in this game: nobody here is its opponent, so the holders are not called that.
    expect(pure.items[0].held_by_its_opponents_in_this_game).toBeUndefined();
    expect(pure.items[0].held_in_this_game_by_anyone.map((h: any) => h.hero).sort()).toEqual(['necrolyte', 'phantom_assassin', 'sven']);
  });

  it('Sacred Arrow: only a strong dispel removes it', () => {
    const r: any = abilityCounters(trace, { ability: 'mirana_arrow' }, ctx);
    expect(r.not_answered_by.find((x: any) => x.mechanism === 'basic_dispel')).toMatchObject({ why: 'strong_dispel_only' });
    const strong = r.answered_by.find((x: any) => x.mechanism === 'strong_dispel');
    expect(strong.items.map((i: any) => i.item)).toEqual(['aeon_disk']);
    expect(strong.items[0]).toMatchObject({ on: 'self', only_if: 'the_effect_is_a_debuff_on_your_side' });
  });

  it('an ability Valve has no immunity or dispel flag for is unknown there, never answered or unanswered', () => {
    const r: any = abilityCounters(trace, { ability: 'phantom_assassin_stifling_dagger' }, ctx);
    expect(r.valve_flags.pierces_debuff_immunity).toBeUndefined();
    expect(r.not_known).toEqual([{ mechanism: 'debuff_immunity', why: 'valve_data_does_not_say' }]);
    expect([...r.answered_by, ...r.not_answered_by].map((x: any) => x.mechanism)).not.toContain('debuff_immunity');
  });

  it('Reaper\'s Scythe: BKB answers it; the holders listed are the opponents of its hero only', () => {
    const r: any = abilityCounters(trace, { ability: 'necrolyte_reapers_scythe' }, ctx);
    expect(r.hero_side).toBe('enemy');
    const bkb = r.answered_by.find((x: any) => x.mechanism === 'debuff_immunity').items.find((i: any) => i.item === 'black_king_bar');
    // Phantom Assassin and Necrophos held one too, on Necrophos' own side: no answer to his ultimate.
    expect(bkb.held_by_its_opponents_in_this_game).toEqual([{ hero: 'sven', side: 'player_team', first_held: '34:26' }]);
    expect(r.mechanisms.debuff_immunity.limits.join(' ')).toMatch(/removed or only reduced/);
  });

  it('Immaterial: a passive with evasion — break and true strike answer it, each with its condition', () => {
    const r: any = abilityCounters(trace, { ability: 'phantom_assassin_immaterial' }, ctx);
    expect(r.traits[0]).toMatchObject({ trait: 'evasion', valve_says: expect.stringMatching(/evade/) });
    const brk = r.answered_by.find((x: any) => x.mechanism === 'break');
    expect(brk.items.map((i: any) => i.item).sort()).toEqual(['angels_demise', 'silver_edge']);
    const ts = r.answered_by.find((x: any) => x.mechanism === 'true_strike').items;
    expect(ts.map((i: any) => i.item)).toEqual(expect.arrayContaining(['monkey_king_bar', 'javelin', 'witch_blade', 'mjollnir']));
    expect(ts.find((i: any) => i.item === 'bloodthorn')).toMatchObject({ on: 'silenced_target' });
    expect(r.mechanisms.true_strike.conditions[0]).toMatch(/chance/);
  });

  it('a dispel pairing is conditional on whom the dispel lands on', () => {
    expect(dispelOnlyIf('basic_dispel', 'self')).toBe('the_effect_is_a_debuff_on_your_side');
    expect(dispelOnlyIf('basic_dispel', 'enemy')).toBe('the_effect_is_a_buff_on_their_side');
    expect(dispelOnlyIf('strong_dispel', 'see_valve_text')).toBe('whom_it_dispels_is_in_valve_says');
    expect(dispelOnlyIf('break', 'enemy')).toBeNull();
  });
});

describe('item_counters against this game\'s enemies', () => {
  it('BKB: blocks Reaper\'s Scythe, not Berserker\'s Call; Phantom Assassin\'s Abyssal Blade goes through it', () => {
    const r: any = itemCounters(trace, { item: 'black_king_bar' }, ctx);
    expect(r).toMatchObject({ ref: 'counter_item:black_king_bar', data_release: '7.42', cost: 4050 });
    expect(r.valve_text[0]).toMatch(/^Avatar: /);
    const imm = r.answers.find((a: any) => a.mechanism === 'debuff_immunity');
    expect(imm.confirmed_by_the_words).toBe('any negative effect from enemy spells has no effect');
    expect(imm.answers_their_abilities.necrolyte).toHaveProperty('necrolyte_reapers_scythe');
    expect(imm.does_not_answer_their_abilities_because.axe).toMatchObject({ axe_berserkers_call: 'pierces_debuff_immunity' });
    expect(imm.their_items_that_go_through_it).toEqual([expect.objectContaining({ hero: 'phantom_assassin', item: 'abyssal_blade', first_held: '34:49', valve_says: expect.stringMatching(/Pierces Debuff Immunity/) })]);
    // Only enemies of the player are read: no Dire hero appears.
    for (const a of r.answers) for (const k of ['answers_their_abilities', 'does_not_answer_their_abilities_because', 'not_known_for']) expect(Object.keys(a[k]).every((h) => ['axe', 'phantom_assassin', 'necrolyte', 'venomancer', 'mirana'].includes(h))).toBe(true);
  });

  it('evasion of an item is read from bonus_evasion only (Radiance\'s bare "evasion" key is not)', () => {
    expect(itemThreats('butterfly', now.items)).toEqual([{ threat: 'evasion', answered_by: 'true_strike', valve_says: 'bonus_evasion 30' }]);
    expect(itemThreats('radiance', now.items)).toEqual([]);
  });

  it('an item the site\'s list does not classify answers nothing claimed, and errors are explicit', () => {
    expect(itemCounters(trace, { item: 'tango' }, ctx)).toMatchObject({ answers: [] });
    expect(itemCounters(trace, { item: 'no_such_item' }, ctx)).toMatchObject({ error: 'item_not_in_this_release' });
    expect(abilityCounters(trace, { ability: 'no_such_ability' }, ctx)).toMatchObject({ error: 'unknown_ability' });
    expect(heroCounters(trace, { against: 'beastmaster' }, ctx)).toMatchObject({ error: 'unknown_hero' });
  });
});

describe('hero_counters', () => {
  it('mechanisms first: Press The Attack answers Axe\'s dispellable effects, on the condition of whom it dispels', () => {
    const r: any = heroCounters(trace, { hero: 'legion_commander', against: 'axe' }, { ...ctx, match: { players: players(65) } });
    expect(r.ref).toBe('counter_hero:legion_commander:axe');
    expect(r.my_abilities_answer.find((x: any) => x.their_ability === 'axe_battle_hunger').by).toEqual([{ mechanism: 'strong_dispel', ability: 'legion_commander_press_the_attack', name: 'Press The Attack', only_if: 'whom_it_dispels_is_in_valve_says' }]);
    const call = r.their_abilities_and_what_answers_them.find((x: any) => x.ability === 'axe_berserkers_call');
    expect(call.mechanisms).toEqual(expect.arrayContaining([{ mechanism: 'debuff_immunity', applies: 'no', why: 'pierces_debuff_immunity' }]));
    expect(r.items_by_mechanism.debuff_immunity).toContain('black_king_bar');
    expect(r.items_by_mechanism.debuff_immunity).not.toContain('minotaur_horn');
  });

  it('numbers second, each with source, patch or window, and sample — or a gap', () => {
    const r: any = heroCounters(trace, { against: 'phantom_assassin' }, { ...ctx, perspective: 'sven', match: { players: players(65) } });
    expect(r.hero).toBe('sven');
    expect(r.in_public_games).toMatchObject({ bracket: 'la', games: expect.any(Number), patch: expect.stringMatching(/^7\./), weeks: { from: expect.any(String), to: expect.any(String) }, source: expect.stringMatching(/STRATZ/) });
    expect(['favoured', 'unfavoured', 'even']).toContain(r.in_public_games.matchup);
    if (r.in_pro_games == null) expect(r.gaps.map((g: any) => g.topic)).toContain('pro_matchup');
    expect(r.note).toMatch(/association, not the cause/);
    // Without match data there is no bracket, and the gap says why.
    const bare: any = heroCounters(trace, { against: 'phantom_assassin' }, ctx);
    expect(bare.in_public_games).toBeNull();
    expect(bare.gaps).toContainEqual({ topic: 'public_matchup', reason: 'no_match_data_for_this_game' });
  });

  it('an older game keeps its release and says the ability text is the newer one', () => {
    const r: any = heroCounters(trace, { against: 'phantom_assassin' }, { ...ctx, match: in741f });
    expect(r.data_release).toBe('7.41f');
    expect(r.gaps.map((g: any) => g.topic)).toContain('ability_text_and_behavior');
  });
});

describe('wiring into the review agent', () => {
  it('registers the three tools among the knowledge tools, and the agent runs them by name', () => {
    expect(COUNTER_TOOLS.map((t) => t.name)).toEqual(['ability_counters', 'item_counters', 'hero_counters']);
    expect(KNOWLEDGE_TOOLS.slice(-5, -2).map((t) => t.name)).toEqual(['ability_counters', 'item_counters', 'hero_counters']);
    const kit: any = reviewToolkit({ trace, hero: 'beastmaster', lang: 'zh' });
    expect(kit.tools.map((t: any) => t.name)).toEqual(expect.arrayContaining(['ability_counters', 'item_counters', 'hero_counters']));
    const r = kit.runTool('item_counters', { item: 'item_black_king_bar' });
    expect(r).toMatchObject({ tool: 'item_counters', ref: 'counter_item:black_king_bar', name: '黑皇杖' });
  });

  it('every counter ref resolves to the same record for an evidence card', () => {
    for (const ref of ['counter_ability:necrolyte_reapers_scythe', 'counter_item:black_king_bar', 'counter_hero:beastmaster:phantom_assassin']) {
      const ev: any = resolveRef(trace, ref, { hero: 'beastmaster' });
      expect(ev, ref).toMatchObject({ ref, kind: ref.split(':')[0] });
      expect(ev.record.data_release).toBe('7.42');
    }
    expect(resolveRef(trace, 'counter_item:no_such_item', { hero: 'beastmaster' })).toBeNull();
    expect(resolveRef(trace, 'counter_hero:beastmaster', { hero: 'beastmaster' })).toBeNull();
  });
});
