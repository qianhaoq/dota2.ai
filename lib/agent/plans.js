/**
 * The game plans a player can say they were going for. Shared by the review
 * page (the buttons), the server (which plans are accepted) and the review
 * agent (how a plan is put to it). A plan is the player's to say: a replay
 * cannot show what anyone meant to do, so the review is told it, never asked
 * to guess it.
 *
 * `label` is the button; `said` is how it reads in a sentence; `for_the_model`
 * is what the plan asks of a game, in terms the review's tools can check.
 */
export const PLANS = Object.freeze([
  {
    key: 'push',
    label: { en: 'Lanes into towers', zh: '线优转推进', ru: 'Линии в пуш' },
    said: { en: 'win the lanes and take towers early', zh: '线优转推进', ru: 'выиграть линии и рано снести вышки' },
    for_the_model: 'win the lanes, then turn the lead into towers early, before the enemy\'s cores have their items',
  },
  {
    key: 'gank',
    label: { en: 'Ganks and pressure', zh: '抓人带节奏', ru: 'Ганги и давление' },
    said: { en: 'gank and keep them down', zh: '抓人带节奏、打压制', ru: 'гангать и душить соперников по карте' },
    for_the_model: 'move around the map, kill enemy heroes and keep the enemy\'s cores from farming, and take what that opens',
  },
  {
    key: 'split',
    label: { en: 'Split push', zh: '带线牵制', ru: 'Сплит-пуш' },
    said: { en: 'split push and stay out of fights', zh: '带线牵制、避开正面团', ru: 'сплит-пушить и избегать прямых драк' },
    for_the_model: 'push lanes away from the enemy and avoid even fights, so the enemy has to answer the pressure',
  },
  {
    key: 'late',
    label: { en: 'Farm for late', zh: '发育拖后期', ru: 'Фарм в лейт' },
    said: { en: 'farm and fight late', zh: '发育拖后期再打团', ru: 'фармить и драться в лейте' },
    for_the_model: 'avoid losing fights early, farm, and fight once the team\'s cores have their items',
  },
]);

export const PLAN_KEYS = Object.freeze(PLANS.map((p) => p.key));
/** A plan key as sent by a page or a queued task, or null: anything else is no plan. */
export const planKey = (v) => (typeof v === 'string' && PLAN_KEYS.includes(v) ? v : null);
export const planByKey = (key) => PLANS.find((p) => p.key === key) ?? null;
