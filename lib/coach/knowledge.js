/**
 * Curated, deliberately small Dota 2 knowledge used by the coach report.
 *
 * Only stable, widely agreed hero traits and item functions live here — no
 * patch numbers. Every list is keyed by OpenDota internal slug and validated
 * against data/names.json in tests, so a typo can never silently drop a hero.
 * When a hero is not listed, OpenDota roles (Nuker / Disabler) still feed the
 * threat profile, so missing curation degrades to "less specific", not wrong.
 */

/** What an enemy hero forces you to answer. */
export const THREAT_TAGS = {
  // Heavy single-target or burst magic damage (beyond OpenDota's "Nuker" role).
  magic: [
    'lion', 'lina', 'zuus', 'skywrath_mage', 'tinker', 'leshrac', 'queenofpain', 'storm_spirit',
    'invoker', 'necrolyte', 'death_prophet', 'pugna', 'nyx_assassin', 'ogre_magi', 'witch_doctor',
    'earthshaker', 'puck', 'templar_assassin', 'magnataur', 'obsidian_destroyer', 'muerta', 'ember_spirit',
  ],
  // Long or chain disables that kill you if you cannot become immune.
  disable: [
    'shadow_shaman', 'lion', 'bane', 'enigma', 'tidehunter', 'magnataur', 'faceless_void',
    'earthshaker', 'sand_king', 'centaur', 'axe', 'legion_commander', 'batrider', 'beastmaster',
    'mars', 'dark_seer', 'rubick', 'jakiro', 'crystal_maiden', 'witch_doctor', 'slardar', 'sven',
    'chaos_knight', 'ogre_magi', 'pudge', 'kunkka', 'storm_spirit', 'void_spirit', 'primal_beast',
  ],
  silence: [
    'skywrath_mage', 'silencer', 'drow_ranger', 'night_stalker', 'doom_bringer', 'death_prophet',
    'puck', 'riki', 'bloodseeker', 'grimstroke', 'earth_spirit',
  ],
  // Physical right-click damage that snowballs if nobody can peel it.
  physical: [
    'ursa', 'phantom_assassin', 'slark', 'troll_warlord', 'juggernaut', 'life_stealer', 'faceless_void',
    'sven', 'monkey_king', 'riki', 'clinkz', 'drow_ranger', 'sniper', 'weaver', 'templar_assassin',
    'spectre', 'antimage', 'chaos_knight', 'lycan', 'luna', 'medusa', 'gyrocopter', 'morphling',
    'terrorblade', 'phantom_lancer', 'naga_siren', 'kez', 'bloodseeker', 'razor', 'muerta',
  ],
  evasion: ['phantom_assassin', 'windrunner'],
  invisibility: ['riki', 'clinkz', 'bounty_hunter', 'weaver', 'nyx_assassin', 'mirana'],
  illusions: ['phantom_lancer', 'naga_siren', 'terrorblade', 'chaos_knight'],
  healing: [
    'huskar', 'necrolyte', 'alchemist', 'abaddon', 'oracle', 'dazzle', 'omniknight', 'chen', 'wisp',
    'warlock', 'undying', 'treant', 'life_stealer', 'witch_doctor',
  ],
  // Ultimates that go through spell immunity: BKB alone is not the answer.
  piercing: ['enigma', 'faceless_void', 'bane', 'beastmaster', 'batrider', 'legion_commander'],
};

/** Item answers to each threat, split by who is expected to carry them. */
export const ANSWERS = {
  magic: {
    core: ['black_king_bar', 'pipe', 'eternal_shroud', 'mage_slayer', 'aeon_disk', 'sphere'],
    support: ['glimmer_cape', 'pipe', 'force_staff', 'ghost', 'aeon_disk', 'lotus_orb', 'cyclone'],
  },
  disable: {
    core: ['black_king_bar', 'sphere', 'aeon_disk', 'manta', 'lotus_orb', 'wind_waker', 'cyclone'],
    support: ['glimmer_cape', 'force_staff', 'lotus_orb', 'cyclone', 'wind_waker', 'aeon_disk', 'sphere'],
  },
  silence: {
    core: ['black_king_bar', 'manta', 'lotus_orb', 'cyclone', 'wind_waker', 'disperser'],
    support: ['lotus_orb', 'cyclone', 'wind_waker', 'glimmer_cape'],
  },
  physical: {
    core: ['ghost', 'heavens_halberd', 'blade_mail', 'solar_crest', 'shivas_guard', 'assault', 'crimson_guard', 'butterfly', 'abyssal_blade', 'sheepstick'],
    support: ['ghost', 'force_staff', 'glimmer_cape', 'solar_crest', 'heavens_halberd', 'cyclone', 'sheepstick', 'rod_of_atos', 'pavise', 'lotus_orb'],
  },
  evasion: {
    core: ['monkey_king_bar', 'bloodthorn'],
    support: [],
  },
  invisibility: {
    core: ['gem'],
    support: ['gem', 'dust', 'ward_sentry'],
  },
  illusions: {
    core: ['mjollnir', 'maelstrom', 'gungir', 'bfury', 'radiance', 'shivas_guard'],
    support: ['shivas_guard'],
  },
  healing: {
    core: ['spirit_vessel', 'skadi', 'shivas_guard'],
    support: ['spirit_vessel', 'shivas_guard'],
  },
};

/**
 * Answers that stopped working in a later patch: item -> tag -> last patch it
 * held, as OpenDota's numeric patch id (monotonic; 60 = 7.41, 61 = 7.42) plus
 * its name. Every entry quotes Valve's patch notes.
 */
export const ANSWER_UNTIL = {
  // 7.42, Bloodthorn: "No longer has Pierce passive" (https://www.dota2.com/patches/7.42)
  bloodthorn: { evasion: { patch: 60, name: '7.41' } },
};

/**
 * How a hero is played in this game, from its OpenDota roles and the seat it
 * took (role.kind / pos). Coarse on purpose: it only decides which advice and
 * which answer items make sense for this player.
 * - frontline_initiator: starts fights from the front (Initiator, melee, not a
 *   support seat: Tidehunter offlane). Never told to "stand behind the team".
 * - right_click_carry: a core whose damage is its attacks (curated physical
 *   threat, or Carry role first unless curated as a magic threat — Invoker):
 *   items that stop attacking or aura items are out.
 * - support: a support seat.
 * - core: any other core.
 * @param {{ slug?: string, roles?: string[], attack?: string }} hero
 * @param {{ kind: 'core' | 'support', pos?: number | null }} role
 */
export function archetypeOf(hero, role) {
  const roles = hero?.roles ?? [];
  if (role?.kind === 'support') return 'support';
  if (roles.includes('Initiator') && hero?.attack === 'Melee' && roles[0] !== 'Carry') return 'frontline_initiator';
  // Curated physical threats are right-click cores; OpenDota also lists spell cores
  // with Carry first (Invoker), so a curated magic threat is not one by roles alone.
  if (THREAT_TAGS.physical.includes(hero?.slug)) return 'right_click_carry';
  if (roles[0] === 'Carry' && !THREAT_TAGS.magic.includes(hero?.slug)) return 'right_click_carry';
  return 'core';
}

/**
 * Answers that do not fit an archetype (widely agreed item functions):
 * Ghost Scepter stops your own attacks; Pipe, Crimson Guard and Solar Crest are
 * team/aura items for offlaners and supports; Glimmer Cape is a support item.
 */
export const ARCHETYPE_EXCLUDED_ANSWERS = Object.freeze({
  right_click_carry: Object.freeze(['ghost', 'pipe', 'crimson_guard', 'solar_crest', 'glimmer_cape']),
});

/**
 * The answers to a threat as of a match's patch. An unknown patch counts as
 * the current one: a retired answer is never recommended on a guess.
 * @param {string} tag
 * @param {'core' | 'support'} kind
 * @param {number | null | undefined} patchId  OpenDota `match.patch`
 * @param {string | null} [archetype]  archetypeOf(): drops answers that do not fit how the hero is played
 */
export function answersFor(tag, kind, patchId, archetype = null) {
  const excluded = ARCHETYPE_EXCLUDED_ANSWERS[archetype] ?? [];
  return ANSWERS[tag][kind].filter((item) => {
    if (excluded.includes(item)) return false;
    const until = ANSWER_UNTIL[item]?.[tag];
    return !until || (Number.isInteger(patchId) && patchId <= until.patch);
  });
}

/** Heroes whose own kit already gives spell immunity or near-equivalent. */
export const BUILT_IN_IMMUNITY = ['life_stealer', 'juggernaut', 'omniknight', 'huskar'];

/**
 * Heroes whose kit passively grants magic resistance (OpenDota ability text:
 * Counterspell "Passively grants magic resistance"), so "no item answer to
 * magic burst" is not a finding for them. Validated against the ability
 * constants in tests.
 */
export const BUILT_IN_MAGIC_RESIST = { antimage: 'antimage_counterspell' };

/**
 * Gap closers: once an enemy owns one, "out of vision" means "can reach
 * you". Shared by the engine (spikes.js) and the goal check (goals.js, which
 * also runs in the browser — so it lives here, not next to the data files).
 */
export const GAP_CLOSERS = ['blink', 'overwhelming_blink', 'swift_blink', 'arcane_blink', 'force_staff', 'shadow_blade', 'invis_sword', 'silver_edge'];

/** Big items worth showing on a timeline (cost threshold catches the rest). */
export const KEY_ITEM_MIN_COST = 2000;
export const ALWAYS_KEY_ITEMS = ['blink', 'black_king_bar', 'force_staff', 'glimmer_cape', 'ghost', 'aghanims_shard', 'ultimate_scepter', 'travel_boots', 'spirit_vessel', 'orchid'];

export const TAG_LABELS = {
  magic: { en: 'magic burst', zh: '魔法爆发' },
  disable: { en: 'chain disables', zh: '连控' },
  silence: { en: 'silences', zh: '沉默' },
  physical: { en: 'physical right-click', zh: '物理输出' },
  evasion: { en: 'evasion', zh: '闪避' },
  invisibility: { en: 'invisibility', zh: '隐身' },
  illusions: { en: 'illusions', zh: '幻象' },
  healing: { en: 'healing / regen', zh: '治疗与回复' },
  piercing: { en: 'BKB-piercing ultimates', zh: '无视魔免的大招' },
};

/** Builds slug -> Set(tags), mixing curation with OpenDota roles. */
export function heroTags(slug, roles = []) {
  const tags = new Set();
  for (const [tag, list] of Object.entries(THREAT_TAGS)) if (list.includes(slug)) tags.add(tag);
  // Fallback only for heroes curation does not know (e.g. a brand-new hero):
  // OpenDota roles are too broad to stack on top of curated tags.
  if (!tags.size) {
    // OpenDota calls some right-click carries "Nuker" too (Nature's Prophet:
    // Carry, Pusher, Escape, Nuker). A Carry that is also a Nuker could be
    // built either way, so the guess stays physical; a "magic burst" call
    // there needs curation.
    if (roles.includes('Nuker') && !roles.includes('Carry')) tags.add('magic');
    if (roles.includes('Disabler')) tags.add('disable');
    if (roles.includes('Carry')) tags.add('physical');
  }
  return tags;
}
