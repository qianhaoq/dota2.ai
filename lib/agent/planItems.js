/**
 * Which plans an item's own effect serves, and the line of Valve's item text
 * that says so. The site's reading, kept small and checkable: an item is here
 * only when Valve's description states the effect in so many words (it
 * damages or lowers the armor of buildings, it moves you across the map, it
 * catches a hero, it kills creeps faster), and a test checks every quote
 * against the item data the repository keeps (lib/data/constants/items.json).
 *
 * That an effect serves a plan is a judgment, and the tool says so. An item
 * that is not here is "not classified" — never "serves no plan".
 *
 * Plans are those of ./plans.js.
 */
export const PLAN_ITEMS = Object.freeze({
  // Takes buildings faster: Valve's text names buildings or structures.
  assault: { plans: ['push'], quote: 'decreases nearby enemy unit and structure armor' },
  desolator: { plans: ['push'], quote: 'Armor reduction works on buildings.' },
  meteor_hammer: { plans: ['push'], quote: 'Deals 75% damage to buildings.' },
  starforge: { plans: ['push'], quote: 'Deals 75% damage to buildings' },
  // Be somewhere else and back: a teleport that targets units.
  travel_boots: { plans: ['split'], quote: 'allowing it to target units' },
  travel_boots_2: { plans: ['split'], quote: 'allowing it to target units' },
  // Reach a hero, or keep one from getting away.
  blink: { plans: ['gank'], quote: 'Teleport to a target point up to 1200 units away.' },
  arcane_blink: { plans: ['gank'], quote: 'Teleport to a target point up to 1400 units away.' },
  swift_blink: { plans: ['gank'], quote: 'Teleport to a target point up to 1200 units away.' },
  overwhelming_blink: { plans: ['gank'], quote: 'Teleport to a target point up to 1200 units away.' },
  invis_sword: { plans: ['gank'], quote: 'Makes you invisible for 17 seconds' },
  silver_edge: { plans: ['gank'], quote: 'Makes you invisible for 17 seconds' },
  orchid: { plans: ['gank'], quote: 'Silences the target unit for 5 seconds.' },
  rod_of_atos: { plans: ['gank'], quote: 'Roots the target for 2 seconds.' },
  // Kills creeps faster, or turns them into gold.
  hand_of_midas: { plans: ['late'], quote: 'Kills a non-hero target for 160 gold.' },
  bfury: { plans: ['late'], quote: 'Increases attack damage against non-hero units' },
  maelstrom: { plans: ['late'], quote: 'leaps between 4 targets within a 650 radius' },
  mjollnir: { plans: ['late'], quote: 'leaps between 12 targets within a 650 radius' },
  radiance: { plans: ['late'], quote: 'scorches enemies for 60 magical damage per second' },
});

/** What each plan's items do, in words a sentence may use. */
export const PLAN_ITEM_EFFECT = Object.freeze({
  push: 'damage or lower the armor of buildings',
  split: 'teleport to an allied unit, so the hero can push one lane and join the others',
  gank: 'reach a hero (teleport, invisibility) or keep one from getting away (silence, root)',
  late: 'kill creeps faster, or turn them into gold',
});
