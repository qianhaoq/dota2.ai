/**
 * Counter mechanics: which items and abilities answer which abilities, and
 * why — read from Valve's own data, never from memory.
 *
 * Two sides meet in a mechanism:
 * - the threat, an ability's property: Valve's flags in the game's release
 *   (damage type, "Pierces Debuff Immunity", how its effect is dispelled —
 *   lib/data/constants/patches/<release>.json via patchData), or the ability's
 *   behaviour and text, which the repository keeps for the current release
 *   only (lib/data/constants/abilities.json, OpenDota constants);
 * - the answer, an item's or ability's effect, as Valve's text of that
 *   release states it. The list of answers below is curated, but every entry
 *   carries the words that must be in Valve's text for it to hold: an entry
 *   whose words are not in the release's text is not confirmed there and is
 *   reported as such, not used. The matching sentence is quoted.
 *
 * What the data does not say stays unknown: an ability with no "Pierces Debuff
 * Immunity" flag is neither blocked nor unblocked by Black King Bar here.
 * Mechanisms the data cannot ground (channel interruption, illusion damage,
 * forced movement, …) are not modelled and are listed in COUNTER_GAPS.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ALL_ABILITIES = require('../data/constants/abilities.json');
const CONSTANTS_META = require('../data/constants/meta.json');

/** The release the ability behaviour and text are from (one table, the current release's). */
export const ABILITY_TEXT_SOURCE = Object.freeze({ source: `${CONSTANTS_META.source} abilities (Valve's ability text and behaviour)`, patch: CONSTANTS_META.patch, fetched: CONSTANTS_META.fetched });

/**
 * The mechanisms. `threat` is what the mechanism answers; `basis` is the Valve
 * field or text the rule reads; `limits` is what the rule does not settle.
 */
export const MECHANISMS = Object.freeze({
  debuff_immunity: {
    answers: 'the negative effects of enemy abilities that do not pierce debuff immunity',
    basis: 'Valve\'s ability flag "Pierces Debuff Immunity" (release data `pierces`); the answer\'s own text in that release',
    conditions: ['only while the immunity lasts (the answer\'s text gives the duration)', 'only abilities whose flag is "no": an ability flagged "yes" goes through'],
    limits: ['the flag is per ability, not per part of it: whether the damage of a blocked ability is removed or only reduced is what the answer\'s text says (Black King Bar\'s text names 60% magic resistance), not a separate flag', 'an ability with no flag in Valve\'s data is unknown here'],
  },
  basic_dispel: {
    answers: 'effects Valve marks as removed by a basic dispel',
    basis: 'Valve\'s ability flag "Dispellable" (release data `dispel`: basic / strong / no); "Dispel Type: Basic Dispel" in the answer\'s text',
    conditions: ['a dispel on yourself or an ally removes your side\'s debuffs; a dispel on an enemy removes their buffs — who the answer dispels is in its quoted text'],
    limits: ['the flag does not say whether the effect is a buff on the caster\'s side or a debuff on yours', 'effects marked "strong" or "no" are not removed'],
  },
  strong_dispel: {
    answers: 'effects Valve marks as removed by a strong dispel (and those a basic dispel removes)',
    basis: 'Valve\'s ability flag "Dispellable" (release data `dispel`); "Dispel Type: Strong Dispel" in the answer\'s text',
    conditions: ['who it dispels and when it triggers are in the quoted text (Aeon Disk: when health falls below a threshold)'],
    limits: ['effects marked "no" are not removed'],
  },
  magic_damage: {
    answers: 'magical damage (Valve damage type of the ability)',
    basis: 'Valve\'s ability damage type (release data `dmg` = magical); the answer\'s magic resistance or magic barrier as Valve lists it',
    conditions: ['magic resistance and barriers reduce or absorb the damage; they do not stop the ability\'s other effects'],
    limits: ['how several magic resistances add up is not in the data and is not computed here', 'an attribute value is Valve\'s as listed: whether it is always on or only during the item\'s active is not separated'],
  },
  physical_damage: {
    answers: 'physical damage (Valve damage type of the ability, and attacks)',
    basis: 'Valve\'s ability damage type (release data `dmg` = physical); armor of 4 or more, a physical barrier or physical immunity as Valve lists it',
    conditions: ['armor and barriers reduce or absorb; Ghost Scepter-style forms remove physical damage but, per their text, raise magic damage taken and stop your attacks'],
    limits: ['armor values are the item\'s own; the reduction they give is not computed here'],
  },
  pure_damage: {
    answers: 'pure damage (Valve damage type of the ability)',
    basis: 'Valve\'s ability damage type (release data `dmg` = pure); only answers whose own text names pure damage',
    conditions: ['while the answer\'s effect lasts'],
    limits: ['the data does not list armor or magic resistance as reducing pure damage, and no other answer is assumed'],
  },
  break: {
    answers: 'passive abilities',
    basis: 'the ability\'s behaviour "Passive" in Valve\'s ability data (current release); the answer\'s text saying it disables passives',
    conditions: ['only after the answer lands (Silver Edge: the attack that ends its invisibility), and for the duration its text gives'],
    limits: ['Valve\'s data does not list which passives ignore break', 'behaviour is from the current release\'s table: a passive changed since an older game\'s release is not told apart'],
  },
  spell_block: {
    answers: 'targeted (unit-target) enemy spells',
    basis: 'the ability\'s behaviour "Unit Target" in Valve\'s ability data (current release); the answer\'s text ("Blocks most targeted spells", "re-casts most targeted spells")',
    conditions: ['only when the spell targets the protected unit; Linken\'s Sphere blocks once per cooldown'],
    limits: ['Valve\'s text says "most": the exceptions are not in the data, except what the item\'s notes quote (neutral item spells)', '"Unit Target" abilities include ones cast on allies, which are no threat'],
  },
  true_strike: {
    answers: 'evasion',
    basis: 'evasion stated in the threat\'s Valve text or item attributes; the answer\'s text ("True Strike", "pierce through evasion")',
    conditions: ['a chance or a single attack where the text says so (Monkey King Bar: a chance per attack; Witch Blade: the next attack; Bloodthorn: only against the silenced target)'],
    limits: ['the list of evasion abilities is curated and partial (checked against Valve\'s text)', 'evasion from items is read only from Valve\'s `bonus_evasion` attribute'],
  },
  true_sight: {
    answers: 'invisibility',
    basis: 'invisibility stated in the threat\'s Valve text; the answer\'s text ("True Sight", "reveals … invisible")',
    conditions: ['only in the radius and for the time the answer\'s text gives'],
    limits: ['the list of invisibility abilities is curated and partial (checked against Valve\'s text)', 'being seen is not being hit: it only makes the target targetable'],
  },
  heal_reduction: {
    answers: 'healing and health regeneration',
    basis: 'healing stated in the threat\'s Valve text; the answer\'s text ("reduces Health Restoration by N%")',
    conditions: ['by the percentage and duration the answer\'s text gives'],
    limits: ['the list of healing abilities is curated and partial (checked against Valve\'s text)', 'how several reductions add up is not in the data'],
  },
});

/** Mechanisms not modelled: no field or text in the repository grounds them. */
export const COUNTER_GAPS = Object.freeze([
  { topic: 'channel_interruption', reason: 'no_valve_field_says_which_effects_interrupt_a_channel' },
  { topic: 'illusions', reason: 'area_damage_against_illusions_is_not_a_valve_field' },
  { topic: 'silence_and_mute_as_counters', reason: 'every_active_ability_is_stopped_by_a_silence_too_general_to_list' },
  { topic: 'forced_movement_and_disjoint', reason: 'not_in_the_data' },
  { topic: 'positioning_and_timing', reason: 'not_in_the_data' },
]);

const SAY = (re) => ({ ev: re });
/**
 * Items that answer a mechanism, curated; `ev` must match the item's Valve text
 * (its abilities and notes) in the release, `on` says whom the effect lands on.
 * Magic resistance, armor and evasion are read from Valve's attributes, not from here.
 */
export const ITEM_ANSWERS = Object.freeze({
  black_king_bar: [
    { m: 'debuff_immunity', on: 'self', ...SAY(/any negative effect from enemy spells has no effect/i) },
    { m: 'basic_dispel', on: 'self', ...SAY(/Dispel Type: Basic Dispel/i) },
    { m: 'pure_damage', on: 'self', ...SAY(/immunity to [a-z ]*pure damage/i) },
    { m: 'magic_damage', on: 'self', ...SAY(/\d+% magic resistance/i) },
  ],
  minotaur_horn: [
    { m: 'debuff_immunity', on: 'self', ...SAY(/any negative effect from enemy spells has no effect/i) },
    { m: 'basic_dispel', on: 'self', ...SAY(/Dispel Type: Basic Dispel/i) },
    { m: 'pure_damage', on: 'self', ...SAY(/immunity to [a-z ]*pure damage/i) },
  ],
  manta: [{ m: 'basic_dispel', on: 'self', ...SAY(/Dispel Type: Basic Dispel/i) }],
  satanic: [{ m: 'basic_dispel', on: 'self', ...SAY(/Dispel Type: Basic Dispel/i) }],
  guardian_greaves: [{ m: 'basic_dispel', on: 'self', ...SAY(/removes most negative effects from the caster/i) }],
  cyclone: [{ m: 'basic_dispel', on: 'self_or_enemy', ...SAY(/Dispel Type: Basic Dispel/i) }],
  wind_waker: [{ m: 'basic_dispel', on: 'self_ally_or_enemy', ...SAY(/Dispel Type: Basic Dispel/i) }],
  lotus_orb: [
    { m: 'basic_dispel', on: 'self_or_ally', ...SAY(/Dispel Type: Basic Dispel/i) },
    { m: 'spell_block', on: 'self_or_ally', ...SAY(/re-casts most targeted spells/i) },
  ],
  disperser: [{ m: 'basic_dispel', on: 'self_and_target', ...SAY(/Dispels both the wearer and the target/i) }],
  nullifier: [{ m: 'basic_dispel', on: 'enemy', ...SAY(/Dispels the target/i) }],
  force_boots: [{ m: 'basic_dispel', on: 'ally', ...SAY(/Dispels if cast on an ally/i) }],
  heavy_blade: [{ m: 'basic_dispel', on: 'area_enemies_and_allies', ...SAY(/Dispel all enemies and allies/i) }],
  aeon_disk: [{ m: 'strong_dispel', on: 'self', ...SAY(/a strong dispel is applied/i) }],
  panic_button: [{ m: 'strong_dispel', on: 'self', ...SAY(/receive a strong dispel/i) }],
  sphere: [{ m: 'spell_block', on: 'self_or_ally', ...SAY(/Blocks most targeted spells/i) }],
  silver_edge: [{ m: 'break', on: 'enemy', ...SAY(/disable their passive abilities/i) }],
  angels_demise: [{ m: 'break', on: 'enemy', ...SAY(/disables their passives/i) }],
  monkey_king_bar: [{ m: 'true_strike', on: 'own_attacks', ...SAY(/pierce through evasion/i) }],
  javelin: [{ m: 'true_strike', on: 'own_attacks', ...SAY(/pierce through evasion/i) }],
  // Bloodthorn: True Strike against the silenced target; up to 7.41f also a Pierce passive, removed in 7.42.
  bloodthorn: [
    { m: 'true_strike', on: 'silenced_target', ...SAY(/True Strike for your attacks[^.]*silenced target/i) },
    { m: 'true_strike', on: 'own_attacks', ...SAY(/pierce through evasion/i) },
  ],
  witch_blade: [{ m: 'true_strike', on: 'next_attack', ...SAY(/This attack has True Strike/i) }],
  mjollnir: [{ m: 'true_strike', on: 'lightning_proc', ...SAY(/Lightning proc pierces evasion/i) }],
  gem: [{ m: 'true_sight', on: 'area', ...SAY(/see invisible units/i) }],
  ward_sentry: [{ m: 'true_sight', on: 'area', ...SAY(/see invisible enemy units/i) }],
  third_eye: [{ m: 'true_sight', on: 'area', ...SAY(/see invisible units/i) }],
  dust: [{ m: 'true_sight', on: 'area', ...SAY(/reveals and slows invisible heroes/i) }],
  spirit_vessel: [{ m: 'heal_reduction', on: 'enemy', ...SAY(/Health Restoration by \d+%/i) }],
  skadi: [{ m: 'heal_reduction', on: 'enemy', ...SAY(/Health Restoration by \d+%/i) }],
  orb_of_corrosion: [{ m: 'heal_reduction', on: 'enemy', ...SAY(/Health Restoration by \d+%/i) }],
  orb_of_frost: [{ m: 'heal_reduction', on: 'enemy', ...SAY(/Health Restoration by \d+%/i) }],
  crippling_crossbow: [{ m: 'heal_reduction', on: 'enemy', ...SAY(/Health Restoration by \d+%/i) }],
  vile_phial: [{ m: 'heal_reduction', on: 'enemy', ...SAY(/Health Restoration by \d+%/i) }],
  crellas_crozier: [
    { m: 'heal_reduction', on: 'area_enemies', ...SAY(/Health Restoration by \d+%/i) },
    { m: 'physical_damage', on: 'self', ...SAY(/immune to physical damage/i) },
  ],
  ghost: [{ m: 'physical_damage', on: 'self', ...SAY(/immune to physical damage/i) }],
  pavise: [{ m: 'physical_damage', on: 'ally', ...SAY(/physical damage barrier/i) }],
  solar_crest: [{ m: 'physical_damage', on: 'ally', ...SAY(/physical damage barrier/i) }],
  pipe: [{ m: 'magic_damage', on: 'area_allies', ...SAY(/magic damage barrier/i) }],
  glimmer_cape: [{ m: 'magic_damage', on: 'self_or_ally', ...SAY(/magic damage barrier/i) }],
  hood_of_defiance: [{ m: 'magic_damage', on: 'self', ...SAY(/absorbs up to \d+ magical damage/i) }],
});

/** Abilities that answer a mechanism, curated; `ev` must match the ability's Valve text (current release). */
export const ABILITY_ANSWERS = Object.freeze({
  juggernaut_blade_fury: [{ m: 'debuff_immunity', on: 'self', ...SAY(/debuff immune/i) }],
  life_stealer_rage: [{ m: 'debuff_immunity', on: 'self', ...SAY(/Debuff Immune/i) }],
  omniknight_martyr: [{ m: 'debuff_immunity', on: 'self_or_ally', ...SAY(/Grants Debuff Immunity/i) }],
  huskar_life_break: [{ m: 'debuff_immunity', on: 'self_while_leaping', ...SAY(/While leaping, Huskar is Debuff Immune/i) }],
  pangolier_gyroshell: [{ m: 'debuff_immunity', on: 'self', ...SAY(/debuff immune ball/i) }],
  hoodwink_sharpshooter: [{ m: 'break', on: 'enemy', ...SAY(/\bbreak\b/i) }],
  nyx_assassin_vendetta: [{ m: 'break', on: 'enemy', ...SAY(/applies a break/i) }],
  doom_bringer_doom: [{ m: 'heal_reduction', on: 'enemy', ...SAY(/healing in any way/i) }],
});

/** Abilities whose effect is a threat a mechanism answers, beyond Valve's flags; curated, `ev` checked against Valve's text. */
export const ABILITY_THREATS = Object.freeze({
  evasion: {
    phantom_assassin_immaterial: /evade enemy attacks/i, windrunner_windrun: /evasion/i, phantom_lancer_phantom_edge: /evasion/i,
  },
  invisibility: {
    mirana_invis: /invisible/i, sandking_sand_storm: /Invisibility/i, riki_backstab: /invisible/i, templar_assassin_meld: /invisible/i,
    clinkz_wind_walk: /invisibly/i, bounty_hunter_wind_walk: /invisible/i, invoker_ghost_walk: /invisible/i, nyx_assassin_vendetta: /invisible/i,
    kez_ravens_veil: /invisibility/i, treant_natures_guise: /invisibility/i, weaver_shukuchi: /out of visibility/i,
  },
  healing: {
    huskar_berserkers_blood: /health regen/i, alchemist_chemical_rage: /health regeneration/i, necrolyte_death_pulse: /healing/i,
    dazzle_shadow_wave: /healing/i, omniknight_purification: /heals/i, abaddon_borrowed_time: /heal/i, slark_shadow_dance: /health regeneration/i,
    oracle_purifying_flames: /regenerate health/i, chen_hand_of_god: /Heals/i, treant_living_armor: /heals/i, witch_doctor_voodoo_restoration: /heal/i,
    juggernaut_healing_ward: /heals/i, enchantress_natures_attendants: /heals/i, warlock_shadow_word: /heal/i, life_stealer_feast: /heal/i,
    pugna_life_drain: /healing/i, death_prophet_spirit_siphon: /healing/i, undying_soul_rip: /heal/i,
  },
});
const THREAT_MECHANISM = { evasion: 'true_strike', invisibility: 'true_sight', healing: 'heal_reduction' };

/** Valve item attributes that are a magic resistance, armor, or evasion, in percent or points. */
const MAGIC_RES_ATTR = ['magic_resistance', 'bonus_magical_armor', 'bonus_spell_resist', 'magic_resist'];
// Only `bonus_evasion`: Valve's bare `evasion` key does not say whose evasion it is (Radiance lists one).
const EVASION_ATTR = ['bonus_evasion'];
const ARMOR_MIN = 4;

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const MAX_QUOTE = 320;
/**
 * The first of `segments` (Valve text pieces: one item ability, one notes line, one ability description) that
 * matches `re`, whole when short, else the 320 characters around the match; null when none matches.
 */
export function quoteOf(segments, re) {
  for (const raw of [].concat(segments ?? [])) {
    const t = clean(raw);
    const m = t.match(re);
    if (!m) continue;
    if (t.length <= MAX_QUOTE) return t;
    const from = Math.max(0, Math.min(m.index - 80, t.length - MAX_QUOTE));
    return `${from ? '…' : ''}${t.slice(from, from + MAX_QUOTE - 2)}…`;
  }
  return null;
}
/** An item's Valve text in a release, in pieces: each ability as "Title: description", then each line of its notes. */
export const itemText = (it) => (it ? [...(it.abilities ?? []).map((a) => `${a.title}: ${a.description}`), ...String(it.notes ?? '').split('\n')].filter((x) => clean(x)) : []);
const attrOf = (it, keys) => {
  for (const a of it?.attrib ?? []) if (keys.includes(a?.key)) { const v = Number(a.value); if (Number.isFinite(v) && v !== 0) return { key: a.key, value: v }; }
  return null;
};

/**
 * What an item answers in a release, entry by entry: confirmed (with Valve's
 * sentence quoted) or not confirmed in that release's text.
 * @param {string} key  item key
 * @param {Record<string, any>} items  the release's items (patchData(...).items)
 * @returns {{ exists: boolean, confirmed: { mechanism: string, on: string, valve_says: string, matched?: string, from: 'text' | 'attribute' }[], not_confirmed: { mechanism: string, on: string, reason: string }[] }}
 */
export function itemMechanisms(key, items) {
  const it = items[key];
  if (!it) return { exists: false, confirmed: [], not_confirmed: [] };
  const text = itemText(it);
  const confirmed = []; const notConfirmed = [];
  for (const e of ITEM_ANSWERS[key] ?? []) {
    const q = quoteOf(text, e.ev);
    if (q) { if (!confirmed.some((c) => c.mechanism === e.m && c.on === e.on)) confirmed.push({ mechanism: e.m, on: e.on, valve_says: q, matched: text.map((x) => clean(x).match(e.ev)?.[0]).find(Boolean), from: 'text' }); } else notConfirmed.push({ mechanism: e.m, on: e.on, reason: 'not_in_valve_text_of_this_release' });
  }
  const mr = attrOf(it, MAGIC_RES_ATTR);
  if (mr && !confirmed.some((c) => c.mechanism === 'magic_damage')) confirmed.push({ mechanism: 'magic_damage', on: 'self', valve_says: `${mr.key} ${mr.value}`, from: 'attribute' });
  const armor = attrOf(it, ['bonus_armor']);
  if (armor && armor.value >= ARMOR_MIN && !confirmed.some((c) => c.mechanism === 'physical_damage' && c.on === 'self')) confirmed.push({ mechanism: 'physical_damage', on: 'self', valve_says: `bonus_armor ${armor.value}`, from: 'attribute' });
  return { exists: true, confirmed, not_confirmed: notConfirmed };
}

/** What an item does that other answers must deal with: evasion it grants, an active that pierces debuff immunity. */
export function itemThreats(key, items) {
  const it = items[key];
  if (!it) return [];
  const out = [];
  const ev = attrOf(it, EVASION_ATTR);
  if (ev) out.push({ threat: 'evasion', answered_by: 'true_strike', valve_says: `${ev.key} ${ev.value}` });
  const pierce = quoteOf(itemText(it), /Pierces Debuff Immunity/i);
  if (pierce) out.push({ threat: 'pierces_debuff_immunity', answered_by: null, valve_says: pierce });
  return out;
}

/** Abilities' answers from their current-release Valve text: curated entries confirmed by their words, and every "DISPEL TYPE" line. */
export function abilityAnswers(id) {
  const desc = ALL_ABILITIES[id]?.desc;
  const out = [];
  if (!desc) return out;
  for (const e of ABILITY_ANSWERS[id] ?? []) { const q = quoteOf(desc, e.ev); if (q) out.push({ mechanism: e.m, on: e.on, valve_says: q }); }
  // Valve's own line: who is dispelled is in the description, which is quoted whole.
  const d = clean(desc).match(/DISPEL TYPE:\s*(Basic|Strong) Dispel/i);
  if (d) out.push({ mechanism: d[1].toLowerCase() === 'strong' ? 'strong_dispel' : 'basic_dispel', on: 'see_valve_text', valve_says: quoteOf(desc, /DISPEL TYPE/i) });
  return out;
}

/**
 * When a dispel pairing holds, by whom the dispel lands on: Valve's "Dispellable" flag does not say whether the
 * threat's effect is a debuff on your side or a buff on theirs, so the pairing is conditional. Null for other mechanisms.
 */
export function dispelOnlyIf(mechanism, on) {
  if (mechanism !== 'basic_dispel' && mechanism !== 'strong_dispel') return null;
  if (['self', 'ally', 'self_or_ally', 'area_allies', 'self_while_leaping'].includes(on)) return 'the_effect_is_a_debuff_on_your_side';
  if (on === 'enemy') return 'the_effect_is_a_buff_on_their_side';
  if (on === 'see_valve_text') return 'whom_it_dispels_is_in_valve_says';
  return 'a_debuff_on_your_side_or_a_buff_on_theirs_by_whom_it_targets';
}

const NO_FLAG = 'valve_data_does_not_say';
/**
 * An ability as a threat: Valve's flags in the release and what the current
 * table adds, and for each mechanism whether it applies ('yes'), does not
 * ('no', with why), or is not known.
 * @param {{ id: string, dmg?: string, pierces?: boolean, dispel?: string }} a  the ability as patchData lists it for the release
 */
export function abilityThreat(a) {
  const now = ALL_ABILITIES[a.id];
  const behavior = now ? [].concat(now.behavior ?? []) : null;
  const desc = now?.desc ?? null;
  const flags = {
    ...(a.dmg ? { damage_type: { P: 'physical', M: 'magical', U: 'pure' }[a.dmg] } : {}),
    ...(typeof a.pierces === 'boolean' ? { pierces_debuff_immunity: a.pierces } : {}),
    ...(a.dispel ? { dispellable: { basic: 'basic_dispel', strong: 'strong_dispel_only', no: 'not_dispellable' }[a.dispel] ?? a.dispel } : {}),
    ...(behavior ? { behavior } : {}),
  };
  const by = {};
  by.debuff_immunity = typeof a.pierces === 'boolean' ? (a.pierces ? { applies: 'no', why: 'pierces_debuff_immunity' } : { applies: 'yes' }) : { applies: 'unknown', why: NO_FLAG };
  if (a.dispel === 'basic') { by.basic_dispel = { applies: 'yes' }; by.strong_dispel = { applies: 'yes' }; }
  else if (a.dispel === 'strong') { by.basic_dispel = { applies: 'no', why: 'strong_dispel_only' }; by.strong_dispel = { applies: 'yes' }; }
  else if (a.dispel === 'no') { by.basic_dispel = { applies: 'no', why: 'not_dispellable' }; by.strong_dispel = { applies: 'no', why: 'not_dispellable' }; }
  else { by.basic_dispel = { applies: 'unknown', why: NO_FLAG }; by.strong_dispel = { applies: 'unknown', why: NO_FLAG }; }
  const dmgM = { M: 'magic_damage', P: 'physical_damage', U: 'pure_damage' }[a.dmg];
  if (dmgM) by[dmgM] = { applies: 'yes' };
  if (behavior) {
    if (behavior.includes('Passive') && !behavior.includes('Hidden')) by.break = { applies: 'yes' };
    if (behavior.includes('Unit Target')) by.spell_block = { applies: 'yes', when: 'cast_on_the_protected_unit' };
  }
  const traits = [];
  for (const [trait, list] of Object.entries(ABILITY_THREATS)) {
    const re = list[a.id];
    const q = re && desc ? quoteOf(desc, re) : null;
    if (q) { traits.push({ trait, valve_says: q }); by[THREAT_MECHANISM[trait]] = { applies: 'yes' }; }
  }
  return { flags, traits, by_mechanism: by };
}
