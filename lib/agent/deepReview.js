/**
 * The deep review: an agent investigates one player's game with the replay
 * and knowledge tools and submits a structured review
 * (`dota2.ai/deep-review@1`).
 *
 * The prompt teaches a method, not conclusions. The review is then checked
 * by code, not by trust (verifyReview): what it states about the game must
 * be in what the tools returned during this run. The model gets one chance
 * to repair what fails; whatever still states something the tools never
 * said is dropped.
 */
import { TRACE_TOOLS, runTraceTool, deathContext, abilityAudit } from '../../packages/review-engine/src/trace/index.js';
import { STATIC_HEROES } from '../../packages/review-engine/src/staticHeroes.js';
import { deepseekLanguageLock, normalizeUiLang } from '../aiLanguage.js';
import { KNOWLEDGE_TOOLS } from './knowledgeTools.js';
import { GOAL_SCHEMA, goalFromReview } from './goal.js';
import { HABITS, HABIT_KEYS, habitGoal } from '../coach/goals.js';
import { abilityName, KNOWN_ZH_NAMES } from './evidence.js';
import { runAgent } from './loop.js';
import { placeNames } from './places.js';

export { placeNames };

export const DEEP_REVIEW_SCHEMA = 'dota2.ai/deep-review@1';
export const DEEP_REVIEW_PROMPT_VERSION = 15;
const MAX_REFS = 3;
const MAX_FINDINGS = 3;
/** A stated time may be this far from a tool's time (rounding to the second, "about 30:10"). */
const CLOCK_TOLERANCE = 3;
/** From here up a number is checked wherever it stands; below, only decimals, counts and evidence. */
const BIG = 100;
/** Integers up to this are too common to check by matching ("two fights", "level 3"). */
const TRIVIAL = 3;

const STR = { type: 'string' };
export const SUBMIT_REVIEW = {
  name: 'submit_review',
  description: 'Hand in the finished review. Call it once, after you have investigated with the other tools. Every time and number you write must come from a tool result of this conversation.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['verdict', 'mainline', 'findings', 'blind_spots'],
    properties: {
      verdict: { ...STR, description: 'One sentence: the main reason this game went the way it did for this player.' },
      mainline: { type: 'array', items: STR, maxItems: 5, description: 'The story of the game in phases, each with its times.' },
      findings: {
        type: 'array', minItems: 1, maxItems: MAX_FINDINGS,
        description: 'The problems that mattered most, most important first.',
        items: {
          type: 'object', additionalProperties: false, required: ['title', 'claim', 'evidence', 'rule', 'fix'],
          properties: {
            title: { ...STR, description: 'The finding in a few words, as a heading: what the player did, not a label. Always present.' },
            claim: { ...STR, description: 'What went wrong and why it mattered.' },
            evidence: {
              type: 'array', minItems: 1, maxItems: 8,
              items: {
                type: 'object', additionalProperties: false, required: ['refs', 'fact'],
                properties: {
                  refs: { type: 'array', minItems: 1, maxItems: MAX_REFS, items: STR, description: 'The `ref` of each tool record this fact is read from, copied exactly, e.g. "cast:beastmaster:primal_roar:6", "death:beastmaster:9", "immune:phantom_assassin:3".' },
                  fact: { ...STR, description: 'What those records show. Every time and number here must be in the cited records.' },
                },
              },
            },
            rule: {
              type: 'object', additionalProperties: false, required: ['when', 'do', 'this_game'],
              description: 'The one rule the player takes into the next game from this finding.',
              properties: {
                when: { ...STR, description: 'The situation, as the player meets it in game, from what is on their own screen at that moment: their health and mana, who stands next to them, what an enemy just used, the clock, what is in the shop. Not hindsight ("before you die"), not a mood ("when it is dangerous").' },
                do: { ...STR, description: 'One action for that situation: where to go, what to buy and by when, what to hold or wait for. Not "be careful", "position better" or "react faster".' },
                this_game: { ...STR, description: 'How often that situation came up in this game and went the other way: the count a tool states and the times (for example three of the twelve deaths, then their times), written in the language of the review like everything else. Every time and number must be in a tool result.' },
                counted_by: { type: 'string', enum: HABIT_KEYS, description: 'Which count a tool keeps that this rule is about, if one is — the next game\'s replay is counted the same way to see whether the rule was followed. From death_context.deaths_where — low_health: health_below_half_at_window_start. alone: no_ally_within_2200_at_death. outnumbered: three_or_more_enemy_heroes_dealing_damage. nothing_pressed: nothing_cast_and_no_item_used. From ability_audit of one of the player\'s own abilities (name it in counted_ability) — cast_into_immunity: casts_where.target_spell_immune_and_not_stunned. target_survived: casts_where.enemy_hero_target_alive_12s_later. reached_few: casts_where.no_hero_target_and_at_most_one_enemy_hero_damaged. died_holding: deaths_with_it_ready_and_not_cast_total. Omit when the rule is about something else (an item).' },
                counted_ability: { type: 'string', description: 'For the four ability counts: the ability key as ability_audit names it (e.g. "tidehunter_ravage").' },
              },
            },
            fix: { ...STR, description: 'How to carry the rule out, in one or two sentences. Advice, not game facts.' },
          },
        },
      },
      did_well: { type: 'array', items: STR, maxItems: 3 },
      goal: GOAL_SCHEMA,
      blind_spots: { type: 'array', items: STR, description: 'What the replay data could not show for this review (from the tools\' gaps).' },
    },
  },
};

export function deepReviewSystem(lang) {
  return `${deepseekLanguageLock(lang)}

You are a Dota 2 coach reviewing one player's game from its replay. You teach judgment: the player should finish reading knowing what to do differently next game.

You have tools that query the parsed replay and the site's data on heroes and items. They return facts; the judgment is yours.

READING THE TOOLS
- Everything is told from the player's side: "me" is the player, "ally"/"my_team" their team, "enemy" the other. my_team_gold_lead is negative when the player's team is behind. Never translate this into Radiant/Dire yourself.
- Call heroes by the names in hero_names and places by the names in place_names (the tools use engine keys such as "dire_top_lane"). Never leave a key, or half of one, in what you write.

METHOD
1. match_overview: result, the fights and which side lost fewer heroes, the gold lead around them, when buildings fell. Find where the game turned.
1b. Read the player's lane with lane_report: last hits, gold and XP at 10:00 against the enemy in the same lane, the deaths before 10:00, and how this core matchup usually stands in professional games and in public games of this bracket. A lane behind by what the matchup usually gives (this_game_against_that_range "typical", matchup "unfavoured") is the draft's, not the player's: say so. A lane finding needs something the player controls — last hits behind the enemy core's, deaths before 10:00 — with its numbers. When lane_report has no economy (gaps), say nothing about gold or last hits.
2. Find how the enemy won: which enemy hero killed the player and dealt the damage (death_context gives killed_by). Check that hero's key items with item_timeline and their spell-immunity windows.
3. Audit the player's deaths with death_context. Start from its counts over all the deaths: deaths_where (which deaths, by game time, began below half health, had no ally within 2200, were against three or more enemy heroes) and damage_share_in_death_windows (one hero's attacks, or abilities). A pattern is a count over the deaths, then the two or three moments that show it — not one story per death. Then what was ready and not used and which disables landed. An ability listed under off_cooldown_without_the_mana could not be cast: it was not left unused.
4. Audit the player's ultimate: hero_abilities first (which ability it is, whether it goes through spell immunity), then ability_audit (who it was spent on, whether the stun landed, what followed, deaths with it ready), then immunity_windows with watch_hero/watch_ability: when the enemy carry became immune, where was the ultimate? Spending it on a lesser target seconds before is a decision worth naming. enemy_heroes_damaged_within_15s says whom a cast reached: one that reached several enemies was not wasted because one of them was spell immune.
5. Judge the build: item_timeline for the player, pro_item_choices for what professionals build on this hero and against these enemies. Name what was missing only when the deaths show the need for it, and say what the deaths came from (damage_share_in_death_windows) next to what the player had bought by then.
6. Read the turning fights with fight_timeline before you describe them. Its hero_deaths_in_window is how many heroes each side lost in that window: quote it, citing the timeline's ref, instead of counting rows. A fight listed by match_overview has its own ref ("fight:N") for its own counts.
7. Choose one goal the next game can be checked on (the "goal" field): hold_item when a finding is about a missing item from pro_item_choices, fewer_deaths when a finding is about dying, win_lane when a finding is about a lane that lane_report calls lost. Leave it out if neither fits.
8. Then write. At most ${MAX_FINDINGS} findings. Each needs a pattern with its count, the moments that show it, and a rule for the next game.
9. Order the findings by what the player could have changed alone, and earliest: staying or walking in on low health, being where no ally was, the order of their items — before how the team's fights went. match_overview lists every hero's deaths: when the player died less than their allies, say so in the verdict, and do not charge the team's lost fights to them.

RULES
- Every time (m:ss) and every number you state about the game must be one a tool returned in this conversation. Quote; do not add, subtract or average to make new numbers. For a count ("7 of 11 deaths"), use the count a tool gives (killed_by, by_target, *_total). If you did not look it up, do not state it.
- A tool's own counts and totals (casts_total, by_target, killed_by, windows_total…) belong to the ref at the top of its answer ("audit:…", "deaths:…", "immunity:…", "overview"): cite that ref when an evidence item states them.
- target_stunned_seconds is the stun the caster applied to the target within three seconds of this cast, per the combat log. Zero means the log shows none in that time: say that, do not guess why.
- Evidence cites records: each evidence item names the "ref" of the tool record(s) it is read from (at most 3) and states only what those records show. A time or number from another record needs that record's ref too. Never join a fact from one record to a different moment.
- Never state what an ability or item does from memory — not in a claim, and not in a rule or a fix either. hero_abilities says what Valve lists; ability_audit says what happened in this game (target_stunned_seconds). If they show an ability worked through spell immunity, say so; never assume it did not.
- "It was ready and not pressed" is not a finding on its own. Advise using an ability or item only for an effect the tools show (what hero_abilities lists, a stun that landed in this game). When the tools do not show what it does, do not tell the player to press it.
- Every finding ends in a rule: "when" is something the player can see on their own screen at that moment, "do" is one action, "this_game" is how often it came up this game with the tool's count and the times. When the rule answers one of the deaths_where counts, or one of ability_audit's counts for an ability of the player (casts_where: which casts went into spell immunity without a stun, were aimed at an enemy hero who was alive 12 seconds later, or damaged at most one enemy hero; and the deaths with it ready and not cast), name that count in "counted_by" (and the ability in "counted_ability"): the player's next replay is then counted the same way. A rule the player could not check themselves after their next game is not a rule.
- Item advice must come from pro_item_choices or from what the replay shows; say "professional games" when you quote a share.
- What the tools list under "gaps" is unknown, not false: never claim what the enemy could or could not see, creep positions, or Roshan timings. Put what you could not check under blind_spots.
- Write for a player, not a programmer: never show tool or field names (ready_not_cast, controls_on_me) or engine keys (item_magic_wand, beastmaster_summon_thunderhide). Use the game's names for heroes, abilities and items.
- Speak to the player as "you" throughout, never "he" or "the player".
- Judge decisions, not outcomes, and be direct. No filler, no praise that is not earned by a fact.
- Finish by calling submit_review exactly once. Do not write the review as plain text.`;
}

const CLOCK = /(?<![\d:])-?\d{1,3}:[0-5]\d(?![\d:])/g;
const clockToSeconds = (s) => { const m = String(s).match(/^(-)?(\d{1,3}):([0-5]\d)$/); return m ? (m[1] ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : null; };

function addText(text, times, numbers) {
  for (const m of text.matchAll(CLOCK)) { const t = clockToSeconds(m[0]); if (t != null) times.add(t); }
  for (const m of text.replace(CLOCK, ' ').matchAll(/\d+(?:\.\d+)?/g)) numbers.add(Number(m[0]));
}

/**
 * Everything checkable in the tool results of a run:
 * - `times`: every game time (seconds), `numbers`: every number, anywhere;
 * - `summary`: the counts and totals a tool states at its top level (and one
 *   level down: by_target, killed_by, the scoreboard), plus list lengths;
 * - `moments`: for every record that has a time or a time span, the numbers
 *   inside that record — what the tools said about that moment;
 * - `refs`: for every record with a `ref`, its own time and every time and
 *   number inside it — what a sentence citing that ref may state.
 */
export function collectFacts(sources) {
  /** @type {{ times: Set<number>, numbers: Set<number>, summary: Set<number>, moments: { from: number, to: number, numbers: Set<number> }[], refs: Map<string, { at: number | null, times: Set<number>, numbers: Set<number> }> }} */
  const out = { times: new Set(), numbers: new Set(), summary: new Set(), moments: [], refs: new Map() };
  const walk = (value, bucket) => {
    if (typeof value === 'number') { if (Number.isFinite(value)) { out.numbers.add(Math.abs(value)); bucket?.add(Math.abs(value)); } return; }
    if (typeof value === 'string') { addText(value, out.times, out.numbers); if (bucket) addText(value, new Set(), bucket); return; }
    if (Array.isArray(value)) { for (const v of value) walk(v, bucket); return; }
    if (!value || typeof value !== 'object') return;
    let span = null;
    if (typeof value.t === 'number') span = [value.t, value.t];
    else if (typeof value.from === 'number') span = [value.from, typeof value.to === 'number' ? value.to : value.from];
    else if (typeof value.clock === 'string' && clockToSeconds(value.clock) != null) span = [clockToSeconds(value.clock), clockToSeconds(value.clock)];
    const own = span ? new Set() : null;
    const add = (n) => { out.numbers.add(n); bucket?.add(n); own?.add(n); };
    for (const [k, v] of Object.entries(value)) {
      // A field name can carry a number the reader will repeat ("deaths_within_12s").
      for (const m of k.matchAll(/\d+/g)) add(Number(m[0]));
      if ((k === 't' || k === 'from' || k === 'to') && typeof v === 'number') out.times.add(Math.round(v));
      if (own) { const both = { add: (n) => { own.add(n); bucket?.add(n); } }; walk(v, both); } else walk(v, bucket);
    }
    if (span && own) out.moments.push({ from: span[0], to: span[1], numbers: own });
  };
  // Records by ref: a second, self-contained pass so a record's set holds its whole subtree.
  const cite = (value) => {
    if (Array.isArray(value)) { for (const v of value) cite(v); return; }
    if (!value || typeof value !== 'object') return;
    if (typeof value.ref === 'string') {
      // A summary ref covers the tool's own counts and totals, not the records nested below it.
      const inner = value.ref_scope === 'summary' ? summaryFactsOf(value) : collectFactsOf(value);
      const at = typeof value.t === 'number' ? value.t : typeof value.from === 'number' ? value.from : typeof value.first_held?.t === 'number' ? value.first_held.t : null;
      const r = out.refs.get(value.ref) ?? { at, times: new Set(), numbers: new Set() };
      for (const t of inner.times) r.times.add(t);
      for (const n of inner.numbers) r.numbers.add(n);
      if (r.at == null) r.at = at;
      out.refs.set(value.ref, r);
    }
    for (const v of Object.values(value)) cite(v);
  };
  for (const src of [].concat(sources ?? [])) {
    walk(src, null);
    cite(src);
    if (src && typeof src === 'object' && !Array.isArray(src)) {
      const top = (v, depth) => {
        if (typeof v === 'number') out.summary.add(Math.abs(v));
        else if (Array.isArray(v)) out.summary.add(v.length);
        else if (v && typeof v === 'object' && depth < 2) for (const x of Object.values(v)) top(x, depth + 1);
      };
      top(src, 0);
    }
  }
  return out;
}

/** Times and numbers anywhere inside one value (no summary, no moments). */
function collectFactsOf(value) {
  const times = new Set(); const numbers = new Set();
  const walk = (v) => {
    if (typeof v === 'number') { if (Number.isFinite(v)) numbers.add(Math.abs(v)); return; }
    if (typeof v === 'string') { addText(v, times, numbers); return; }
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    if (!v || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v)) {
      for (const m of k.matchAll(/\d+/g)) numbers.add(Number(m[0]));
      if ((k === 't' || k === 'from' || k === 'to') && typeof x === 'number') times.add(Math.round(x));
      walk(x);
    }
  };
  walk(value);
  return { times, numbers };
}

/** The counts a tool states about its whole answer: top-level numbers, one level of maps, list lengths. */
function summaryFactsOf(value) {
  const times = new Set(); const numbers = new Set();
  const top = (v, depth) => {
    if (typeof v === 'number') { if (Number.isFinite(v)) numbers.add(Math.abs(v)); } else if (typeof v === 'string') addText(v, times, numbers);
    // A list is its length, and the game times it names (deaths_where lists deaths by their clock): not the records it may hold.
    else if (Array.isArray(v)) { numbers.add(v.length); for (const x of v) if (typeof x === 'string') addText(x, times, numbers); }
    else if (v && typeof v === 'object' && depth < 2) for (const [k, x] of Object.entries(v)) { if ((k === 't' || k === 'from' || k === 'to') && typeof x === 'number') times.add(Math.round(x)); top(x, depth + 1); }
  };
  top(value, 0);
  return { times, numbers };
}

/** A number of seconds is a length of time, not a count of things: tools give it with a decimal and prose rounds it. */
const SECONDS_UNIT = /^\s*(秒|seconds?\b|secs?\b|s\b)/i;
const COUNT_UNIT = /^\s*(次|个|人|波|场|秒|座|times?\b|deaths?\b|kills?\b|casts?\b|fights?\b|seconds?\b|secs?\b|s\b)/i;

/** Clock times and numbers a piece of review text states. `counted` = followed by a counting word ("7 次", "11 deaths", "9.3 seconds"). */
export function statedFacts(text) {
  const times = []; const numbers = [];
  const s = String(text ?? '');
  const rest = s.replace(CLOCK, (m) => { times.push(m); return ' '; });
  for (const m of rest.matchAll(/\d[\d,]*(?:\.\d+)?(\s*k\b)?/gi)) {
    const raw = m[0].replace(/\s*k$/i, '').replace(/,/g, '');
    const value = Number(raw) * (m[1] ? 1000 : 1);
    if (!Number.isFinite(value)) continue;
    const after = rest.slice(m.index + m[0].length);
    const percent = /^\s*[%％]/.test(after);
    numbers.push({ text: percent ? `${m[0].trim()}%` : m[0].trim(), value, approx: Boolean(m[1]), decimal: raw.includes('.') && !m[1], counted: COUNT_UNIT.test(after), ...(SECONDS_UNIT.test(after) ? { seconds: true } : {}), ...(percent ? { percent } : {}) });
  }
  return { times, numbers };
}

/**
 * Statements about who could see whom. A replay trace holds positions and
 * distances, never vision (fog of war, wards): such a statement cannot be
 * backed by any tool, however it is worded. A sentence that says the data
 * does not show it is not a claim.
 * @returns {string[]} the offending phrases
 */
const SIGHT = [
  /(?:在|进入|出现在|站在|走进|暴露在|离开|脱离)[^，。；！？\n]{0,12}视野|视野[里内中]|(?:没有?|有|丢了|失去)视野|看得[见到]|看不[见到]|(?:看见|看到|发现)了?你/g,
  /\b(?:in|within|into|out of|outside|had|has|have|no|without|lost|gave|gives)\s+(?:(?:your|their|his|her|its|the|enemy|enemy's|full|any)\s+){0,3}(?:vision|sight|line of sight)\b|\b(?:could(?:n't| not)?|can(?:'t|not)?)\s+see\b|\bsaw\s+you\b|\bvisible\s+to\b/gi,
];
const NOT_A_CLAIM = /录像|数据|记录|无法|不知道|看不出|查不到|\b(?:replay|data|record(?:ed|s)?|trace|unknown|not shown|cannot (?:tell|know|say)|can't (?:tell|know|say))\b/i;
export function sightClaims(text) {
  if (typeof text !== 'string' || !text) return [];
  const out = [];
  for (const sentence of text.split(/(?<=[。！？!?\n])|(?<=\.)\s/)) {
    if (NOT_A_CLAIM.test(sentence)) continue;
    for (const re of SIGHT) for (const m of sentence.matchAll(re)) out.push(m[0].trim());
  }
  return [...new Set(out)];
}

/**
 * Record handles the model put into a sentence — "（lane:beastmaster）", "(audit:x:roar, cast:x:roar:6/9)",
 * "（overview、fight:3、fight:4）", "（4 换 3，timeline:2194-2233）". They belong in `refs`. A bracket holding
 * nothing else goes whole; a handle listed after or before other words in a bracket goes with its separator.
 * One standing inside a sentence ("fight:3 at 20:20") cannot be cut out without breaking it: wordingProblems names it.
 */
const HANDLE = '[a-z][a-z_]*:[A-Za-z0-9_/+-]+(?::[A-Za-z0-9_/+-]+)*';
const SOURCE = `(?:${HANDLE}|overview|${[...TRACE_TOOLS, ...KNOWLEDGE_TOOLS].map((t) => t.name).join('|')})`;
const SEP = '[,，、;；]';
const HANDLES = new RegExp(`\\s*[（(]\\s*${SOURCE}(?:\\s*${SEP}\\s*${SOURCE})*\\s*[)）]`, 'g');
const HANDLE_LISTED = new RegExp(`\\s*${SEP}\\s*${SOURCE}(?=\\s*(?:${SEP}|[)）]))|(?<=[（(])\\s*${SOURCE}\\s*${SEP}\\s*`, 'g');
export const stripHandles = (text) => text.replace(HANDLES, '').replace(HANDLE_LISTED, '');
/** A review as stored, with the handles taken out of its text: one written before this was done at the source is shown clean too. `refs` are untouched. */
export function withoutHandles(value) {
  if (typeof value === 'string') return stripHandles(value);
  if (Array.isArray(value)) return value.map(withoutHandles);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === 'refs' ? v : withoutHandles(v)]));
}
const BARE_HANDLE = new RegExp(`(?<![A-Za-z0-9_:/.])${HANDLE}`, 'g');
const KEY = /(?<![A-Za-z0-9_:/.-])[a-z][a-z0-9]*(?:_[a-z0-9]+)+(?![A-Za-z0-9_:])/g;
const CJK_ONLY = /^[\u3400-\u9fff]+$/;
/** A bracket of clock times and nothing else, and a time picked out "of these" straight after it. */
const LISTED = /[（(]((?:\s*-?\d{1,3}:[0-5]\d\s*[,，、;；和]?(?:\s*and\b)?)+)[)）]\s*[,，;；]?\s*(?:其中|当中|of which|of these|of those|among them)[^，,。；;：:（(\d]{0,12}(-?\d{1,3}:[0-5]\d)(?![\d:])/gi;

/**
 * How a piece of review text is worded, apart from whether its facts are backed:
 * - `key`: a tool's key or field name left in a sentence ("no_ally_within_1200", "audit:tidehunter:ravage").
 *   A hero or place key is not named: nameHeroes replaces those, and removes handles in brackets.
 * - `name`: four or more Chinese characters that are one character away from the name of a hero of this
 *   match and are no hero, ability or item name themselves ("天赋法师" for 天怒法师).
 * - `list`: "…（18:31、19:29、25:33），其中 37:14 那次…" — a time picked out of a list of times it is not in.
 * These are put to the model once, in the repair round. They are never a reason to drop anything: the
 * second and third are a guess about what was meant.
 * @param {{ hero_names?: Record<string, string>, place_names?: Record<string, string> }} [names]
 * @returns {{ kind: 'key' | 'name' | 'list', text: string }[]}
 */
export function wordingProblems(text, names = {}) {
  if (typeof text !== 'string' || !text) return [];
  const out = new Map();
  const add = (kind, t) => out.set(`${kind}|${t}`, { kind, text: t });
  const body = stripHandles(text);
  const replaced = { ...names.place_names, ...names.hero_names };
  for (const m of body.matchAll(BARE_HANDLE)) if (!m[0].includes('://')) add('key', m[0]);
  for (const m of body.replace(BARE_HANDLE, ' ').matchAll(KEY)) if (!Object.hasOwn(replaced, m[0])) add('key', m[0]);
  for (const name of new Set(Object.values(names.hero_names ?? {}))) {
    if (typeof name !== 'string' || name.length < 4 || !CJK_ONLY.test(name)) continue;
    for (let i = 0; i + name.length <= body.length; i += 1) {
      const w = body.slice(i, i + name.length);
      if (w === name || !CJK_ONLY.test(w) || KNOWN_ZH_NAMES.has(w)) continue;
      let off = 0;
      for (let k = 0; k < name.length && off < 2; k += 1) if (w[k] !== name[k]) off += 1;
      if (off === 1) add('name', `${w} (${name}?)`);
    }
  }
  for (const m of body.matchAll(LISTED)) {
    const listed = (m[1].match(CLOCK) ?? []).map(clockToSeconds);
    if (listed.length >= 2 && !listed.includes(clockToSeconds(m[2]))) add('list', `${m[2]} (not among ${m[1].trim()})`);
  }
  return [...out.values()];
}

const has = (set, n, slack) => { for (const x of set) if (Math.abs(x - n) <= slack) return true; return false; };
/**
 * A percentage is checked as what it says: "71%" is backed by a tool's share
 * of 0.71 (or by a tool's own 71), and "0.71%" is not backed by 0.71.
 */
const percentOk = (set, n) => has(set, n.value / 100, 0.006) || (n.value >= 1 && has(set, n.value, 0.5));

/**
 * Check a submitted review against what the tools returned.
 *
 * Checked: every clock time; every number of 100 or more; every decimal;
 * every small count ("7 times") against the tools' own counts; a whole
 * number of seconds may instead be a tool's number rounded ("8 s" for 7.6). An evidence
 * item cites tool records by `ref`: the refs must exist, and every time and
 * every number above 3 in its fact must be inside those records (a whole
 * number may be a tool's decimal rounded: "11 s" for 10.8). So a fact cannot
 * be attached to a moment it does not belong to. A statement about who could
 * see whom is never backed (sightClaims). Wording (wordingProblems) is looked at everywhere and marked
 * `soft`: it sends the review back once and never removes anything. Not checked: `fix`, a rule's `when` and `do`, `next_game` (advice) and `blind_spots`.
 *
 * @param {any} review  the submit_review arguments
 * @param {any[]} sources  tool results (and the context the model was given) of this run
 * @param {string[]} [accepted]  text already checked (a verified review, clean earlier answers): the counts it states may be repeated
 * @returns {{ ok: boolean, problems: { where: 'verdict' | 'mainline' | 'did_well' | 'blind_spots' | 'finding' | 'rule' | 'title', index: number, kind: 'time' | 'number' | 'count' | 'moment' | 'ref' | 'sight' | 'missing' | 'language' | 'key' | 'name' | 'list', text: string, soft?: true }[], unsupported: { findings: Set<number>, evidence: Map<number, Set<number>> }, refs: Map<string, { at: number | null }> }}
 */
export function verifyReview(review, sources, accepted = []) {
  const known = collectFacts(sources);
  for (const text of accepted) for (const n of statedFacts(text).numbers) if (n.counted && !n.decimal) known.summary.add(n.value);
  const timeOk = (clock) => { const t = clockToSeconds(clock); if (t == null) return false; for (let d = -CLOCK_TOLERANCE; d <= CLOCK_TOLERANCE; d += 1) if (known.times.has(t + d)) return true; return false; };
  const bigOk = (n, set) => has(set, n.value, n.approx ? n.value * 0.06 : Math.max(1, n.value * 0.005));
  const problems = [];
  // Wording (wordingProblems): asked about in the repair round, never a reason to drop — kept apart, so the
  // counting below (which finding or evidence item failed) sees only what is unsupported.
  const notes = [];
  const names = [].concat(sources ?? []).find((s) => s && typeof s === 'object' && !Array.isArray(s) && s.hero_names) ?? {};
  const wording = (where, index, ...texts) => { for (const t of texts) for (const w of wordingProblems(t, names)) if (!notes.some((n) => n.where === where && n.index === index && n.kind === w.kind && n.text === w.text)) notes.push({ where, index, ...w, soft: true }); };
  const prose = (where, index, text) => {
    wording(where, index, text);
    const { times, numbers } = statedFacts(text);
    for (const s of sightClaims(text)) problems.push({ where, index, kind: 'sight', text: s });
    for (const c of new Set(times)) if (!timeOk(c)) problems.push({ where, index, kind: 'time', text: c });
    for (const n of numbers) {
      if (n.percent) { if (!percentOk(known.numbers, n)) problems.push({ where, index, kind: 'number', text: n.text }); } else if (n.value >= BIG) { if (!bigOk(n, known.numbers)) problems.push({ where, index, kind: 'number', text: n.text }); } else if (n.decimal) { if (!has(known.numbers, n.value, 0.05)) problems.push({ where, index, kind: 'number', text: n.text }); } else if (n.counted && n.value > TRIVIAL && !known.summary.has(n.value) && !(n.seconds && has(known.numbers, n.value, 0.95))) problems.push({ where, index, kind: 'count', text: n.text });
    }
  };
  // A line in English inside a review written in Chinese (a count copied as "6 of 12 deaths: …"). Judged against
  // the review itself, not the language asked for: only a line that differs from the rest is named.
  const CJK = /[\u3400-\u9fff]/;
  const chinese = CJK.test([review?.verdict, ...(review?.findings ?? []).map((f) => f?.claim)].filter((v) => typeof v === 'string').join(''));
  const tongue = (where, index, text) => {
    if (chinese && typeof text === 'string' && /[A-Za-z]{3}/.test(text) && !CJK.test(text)) problems.push({ where, index, kind: 'language', text: text.slice(0, 80) });
  };
  // Evidence items that failed, per finding: such an item is left out; the finding goes only when nothing else holds it up.
  const badItems = new Map();
  const claimBad = new Set();
  const evidence = (index, e) => {
    const refs = Array.isArray(e?.refs) ? e.refs.filter((r) => typeof r === 'string').slice(0, MAX_REFS) : [];
    const cited = refs.map((r) => known.refs.get(r));
    if (!refs.length) { problems.push({ where: 'finding', index, kind: 'ref', text: '(no ref)' }); return; }
    refs.forEach((r, i) => { if (!cited[i]) problems.push({ where: 'finding', index, kind: 'ref', text: r }); });
    if (cited.some((c) => !c)) return;
    // Only what the cited records hold may be stated. A tool's counts have their own ref (audit:…, deaths:…) and must be cited like anything else.
    const times = new Set(); const local = new Set();
    for (const c of cited) { for (const t of c.times) times.add(t); for (const n of c.numbers) local.add(n); }
    const inRecord = (clock) => { const t = clockToSeconds(clock); if (t == null) return false; for (let d = -CLOCK_TOLERANCE; d <= CLOCK_TOLERANCE; d += 1) if (times.has(t + d)) return true; return false; };
    const stated = statedFacts(e?.fact);
    wording('finding', index, e?.fact);
    for (const s of sightClaims(e?.fact)) problems.push({ where: 'finding', index, kind: 'sight', text: s });
    for (const c of new Set(stated.times)) if (!inRecord(c)) problems.push({ where: 'finding', index, kind: 'moment', text: `${c} (not in ${refs.join(', ')})` });
    for (const n of stated.numbers) {
      if (n.percent) { if (!percentOk(local, n)) problems.push({ where: 'finding', index, kind: 'moment', text: `${n.text} (not in ${refs.join(', ')})` }); } else if (n.value >= BIG) { if (!bigOk(n, local)) problems.push({ where: 'finding', index, kind: 'moment', text: `${n.text} (not in ${refs.join(', ')})` }); } else if ((n.value > TRIVIAL || n.decimal) && !has(local, n.value, n.decimal ? 0.05 : 0.5)) problems.push({ where: 'finding', index, kind: 'moment', text: `${n.text} (not in ${refs.join(', ')})` });
    }
  };
  prose('verdict', 0, review?.verdict);
  (review?.mainline ?? []).forEach((line, i) => { prose('mainline', i, line); tongue('mainline', i, line); });
  (review?.did_well ?? []).forEach((line, i) => { prose('did_well', i, line); tongue('did_well', i, line); });
  (review?.findings ?? []).forEach((f, i) => {
    const before = problems.length;
    prose('finding', i, [f?.title, f?.claim].filter(Boolean).join('\n'));
    if (problems.length > before) claimBad.add(i);
    // A model's arguments are not schema-checked: a finding sent without its heading is asked for one ('title'), not dropped.
    if (!(typeof f?.title === 'string' && f.title.trim())) problems.push({ where: 'title', index: i, kind: 'missing', text: 'title' });
    // What a rule says happened this game is a statement about the game, checked like the claim — on its own account
    // ('rule'): when it fails, that sentence goes, not the finding it belongs to. `when`, `do` and `fix` are advice.
    if (typeof f?.rule?.this_game === 'string') { prose('rule', i, f.rule.this_game); tongue('rule', i, f.rule.this_game); }
    wording('finding', i, f?.fix, f?.rule?.when, f?.rule?.do);
    // A finding rests on cited records. The schema asks for at least one, but a model's arguments are not
    // schema-checked by the API: one that cites nothing is unsupported, whatever it says.
    const items = Array.isArray(f?.evidence) ? f.evidence : [];
    if (!items.length) { problems.push({ where: 'finding', index: i, kind: 'ref', text: '(no evidence)' }); claimBad.add(i); }
    items.forEach((e, j) => { const n = problems.length; evidence(i, e); if (problems.length > n) badItems.set(i, (badItems.get(i) ?? new Set()).add(j)); });
    if (items.length && (badItems.get(i)?.size ?? 0) === items.length) claimBad.add(i);
  });
  (Array.isArray(review?.blind_spots) ? review.blind_spots : []).forEach((line, i) => wording('blind_spots', i, line));
  problems.push(...notes);
  return { ok: problems.length === 0, problems, refs: known.refs, unsupported: { findings: claimBad, evidence: badItems } };
}

/**
 * Check free text (a chat answer) the same way a review's prose is checked:
 * clock times, numbers of 100 or more, decimals, and small counts. `accepted`
 * is text that was already checked; a count it states ("7 times") may be repeated.
 * @returns {{ ok: boolean, problems: { kind: string, text: string }[] }}
 */
export function verifyText(text, sources, accepted = []) {
  const r = verifyReview({ verdict: text, findings: [] }, sources, accepted);
  // A chat answer is checked for what it states; its wording is not sent back.
  const problems = r.problems.filter((p) => !p.soft);
  return { ok: problems.length === 0, problems: problems.map(({ kind, text: t }) => ({ kind, text: t })) };
}

/**
 * The lookup tools for one player's game: their schemas, how to run them
 * (told from that player's side), and the context the model starts from.
 * Shared by the deep review and the chat. Null when the hero is not in the trace.
 */
export function reviewToolkit({ trace, hero, lang, match = null }) {
  const language = normalizeUiLang(lang);
  const seat = trace.heroes.find((h) => h.key === String(hero).trim().toLowerCase().replace(/^npc_dota_hero_/, '').replace(/[\s-]+/g, '_'));
  if (!seat) return null;
  const lookups = [...TRACE_TOOLS, ...KNOWLEDGE_TOOLS];
  const ctx = { match, perspective: seat.key, lang: language };
  const knowledge = new Map(KNOWLEDGE_TOOLS.map((t) => [t.name, t]));
  return {
    seat, language,
    tools: lookups.map(({ name, description, input_schema }) => ({ name, description, input_schema })),
    runTool: (name, args) => (knowledge.has(name) ? { tool: name, ...knowledge.get(name).run(trace, args, ctx) } : runTraceTool(trace, name, args, ctx)),
    context: { match_id: trace.match_id, player_hero: seat.key, hero_names: heroNames(trace, language), place_names: placeNames(language), ...(scoreboard(match, seat.key) ? { scoreboard: scoreboard(match, seat.key) } : {}) },
  };
}

/** The scoreboard facts the model starts from, when the match JSON is at hand. Names and account ids never go in. */
function scoreboard(match, heroKey) {
  const p = (match?.players ?? []).find((x) => x && STATIC_HEROES[x.hero_id]?.internalSlug === heroKey);
  return p ? { kills: p.kills, deaths: p.deaths, assists: p.assists, net_worth: p.net_worth, gold_per_min: p.gold_per_min, last_hits: p.last_hits } : null;
}

/** What to call each hero of this match in the reader's language (the tools use engine keys such as "necrolyte"). */
function heroNames(trace, lang) {
  const bySlug = new Map(Object.values(STATIC_HEROES).map((h) => [h.internalSlug, lang === 'zh' ? h.nameZh : h.nameEn]));
  return Object.fromEntries(trace.heroes.map((h) => [h.key, bySlug.get(h.key) ?? h.key]));
}

/**
 * Replace engine hero keys the model let through ("skywrath_mage", "sven")
 * with the reader's names. Whole identifiers only, longest first; `refs` are
 * handles and are never touched.
 */
export function nameHeroes(review, names, places = {}) {
  names = { ...places, ...names };
  const keys = Object.keys(names).filter((k) => names[k] && names[k] !== k).sort((a, b) => b.length - a.length);
  if (!keys.length) return review;
  const re = new RegExp(`(?<![A-Za-z0-9_:])(${keys.join('|')})(?![A-Za-z0-9_:])`, 'g');
  // Only place names are closed up: hero names keep the spacing the text had.
  const cjkNames = [...new Set(Object.values(places).filter((n) => /^[\u3400-\u9fff]+$/.test(n)))].sort((a, b) => b.length - a.length).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const C = '[\\u3400-\\u9fff\\uff00-\\uffef\\u3000-\\u303f]';
  const tight = cjkNames.length ? new RegExp(`(?:(${C}) +)?(${cjkNames.join('|')})(?: +(?=${C}))?`, 'g') : /$^/g;
  // A Chinese name put where a key stood between Chinese text ("在 dire 上路") takes the spaces around the key with it.
  const fix = (v) => (typeof v === 'string' ? stripHandles(v).replace(re, (k) => names[k]).replace(tight, (m, before, name) => `${before ?? ''}${name}`) : v);
  return {
    ...review,
    verdict: fix(review.verdict), mainline: (review.mainline ?? []).map(fix), did_well: (review.did_well ?? []).map(fix), next_game: (review.next_game ?? []).map(fix), blind_spots: (review.blind_spots ?? []).map(fix),
    findings: (review.findings ?? []).map((f) => ({ ...f, title: fix(f.title), claim: fix(f.claim), fix: fix(f.fix), ...(f.rule ? { rule: { ...f.rule, when: fix(f.rule.when), do: fix(f.rule.do), this_game: fix(f.rule.this_game) } } : {}), evidence: (f.evidence ?? []).map((e) => ({ ...e, fact: fix(e.fact) })) })),
  };
}

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
/** A heading for a finding that still has none after the repair round: the opening sentence of its own (checked) claim, never new words. */
export function headingOf(f) {
  if (str(f?.title)) return f.title;
  const first = (str(f?.claim) ?? '').split(/(?<=[。；！？!?;])|(?<=\.)\s/)[0].replace(/[。；;.]$/, '');
  return first.length > 60 ? `${first.slice(0, 59)}…` : first;
}
/** A finding's rule when it is whole (a situation and an action), else none: half a rule is not shown as one. */
function ruleOf(f, counts = null) {
  const when = str(f?.rule?.when); const act = str(f?.rule?.do); const seen = str(f?.rule?.this_game);
  // The model only says which count the rule is about; the numbers and the wording of the check are made from the replay.
  const check = when && act && counts ? counts(f.rule.counted_by, f.rule.counted_ability) : null;
  return { rule: when && act ? { when, do: act, ...(seen ? { this_game: seen } : {}), ...(check ? { check } : {}) } : undefined };
}
/**
 * What to change next game is the findings' rules, in their order — not a
 * second list written beside them that can drift from what was found. A
 * finding without a whole rule gives its fix.
 */
export function nextGame(findings, lang) {
  return (findings ?? []).map((f) => (f?.rule?.when && f.rule.do ? `${f.rule.when}${lang === 'zh' ? '：' : ': '}${f.rule.do}` : str(f?.fix))).filter(Boolean);
}

const REPAIR_HELP = {
  time: 'this time is not in any tool result',
  number: 'this number is not in any tool result',
  count: 'no tool gave this count; use the count a tool states (killed_by, by_target, *_total)',
  moment: 'the cited record does not hold this; cite the record that does, or remove it',
  ref: 'no tool record with this ref was returned in this conversation; copy a ref exactly',
  missing: 'this finding has no title: give it a heading of a few words',
  language: 'write this in the language of the rest of the review',
  key: 'this is a tool\'s key or field name, not words for the reader: say what it means in the language of the review (a hero or item by its name)',
  name: 'this is not a hero\'s name. If the hero in brackets is meant, write the name exactly as hero_names gives it; otherwise leave it',
  list: 'this time is picked out of a list it is not in: make the sentence agree with itself, using what the tools returned',
  sight: 'the replay data has no vision: no tool can say who saw whom. State the distance or position a tool gave, or remove it',
};

/**
 * Run the investigation and return a verified review.
 * @param {{ complete: Function, trace: any, hero: string, lang?: string, match?: any, signal?: AbortSignal, onEvent?: (e: object) => void, maxSteps?: number, maxToolCalls?: number }} o
 */
export async function runDeepReview({ complete, trace, hero, lang, match = null, signal, onEvent, maxSteps, maxToolCalls }) {
  const kit = reviewToolkit({ trace, hero, lang, match });
  if (!kit) return { status: 'unknown_hero', heroes: trace.heroes.map((h) => h.key) };
  const { seat, language, context } = kit;
  const base = {
    complete, system: deepReviewSystem(language), tools: [...kit.tools, SUBMIT_REVIEW], signal, onEvent, maxSteps, maxToolCalls,
    runTool: kit.runTool,
    isFinal: (call) => call.name === SUBMIT_REVIEW.name,
    finalTools: [SUBMIT_REVIEW.name],
  };
  const usage = { input: 0, output: 0 }; let steps = 0;
  const add = (r) => { usage.input += r.usage.input; usage.output += r.usage.output; steps += r.steps; };

  const first = await runAgent({ ...base, messages: [{ role: 'user', content: `Review this game for the player on ${seat.key}.\n${JSON.stringify(context)}` }] });
  add(first);
  if (first.status !== 'final') return { status: first.status === 'budget' ? 'budget' : 'no_review', steps, usage, transcript: first.transcript };
  let review = first.final; let transcript = first.transcript;
  const sources = () => [context, ...transcript.map((t) => t.result)];
  let check = verifyReview(review, sources());
  const firstProblems = check.problems;
  let repaired = false;
  if (!check.ok) {
    // One repair round: name exactly what is unsupported; the model may look it up or take it out.
    repaired = true;
    const lastCall = first.messages.at(-1).tool_calls.find((c) => c.function.name === SUBMIT_REVIEW.name);
    const second = await runAgent({
      ...base,
      messages: [...first.messages, ...first.messages.at(-1).tool_calls.map((c) => ({
        role: 'tool', tool_call_id: c.id,
        content: c === lastCall ? JSON.stringify({ error: 'unsupported_facts', detail: 'Look each one up with a tool, or rewrite the sentence without it, then call submit_review again with the whole review.', problems: check.problems.map((p) => ({ in: p.where === 'finding' ? `finding ${p.index + 1}` : p.where === 'title' ? `finding ${p.index + 1}, title` : p.where === 'rule' ? `finding ${p.index + 1}, rule.this_game` : `${p.where}${p.where === 'verdict' ? '' : ` ${p.index + 1}`}`, text: p.text, why: REPAIR_HELP[p.kind] })) }) : JSON.stringify({ error: 'not_run' }),
      }))],
    });
    add(second);
    if (second.status === 'final') { review = second.final; transcript = [...transcript, ...second.transcript]; check = verifyReview(review, sources()); }
  }
  // Whatever still states something the tools never said does not ship.
  // A finding goes when its own text is unsupported or none of its evidence holds; one bad evidence item alone
  // is left out and the finding stays on the rest.
  const bad = (where) => (where === 'finding' ? check.unsupported.findings : new Set(check.problems.filter((p) => p.where === where && !p.soft).map((p) => p.index)));
  // A model's arguments are not schema-checked: a finding may be null or carry evidence that is no list. Those are
  // dropped below (they cite nothing); here they are only passed through untouched.
  const holds = (f, i) => (Array.isArray(f?.evidence) ? { ...f, evidence: f.evidence.filter((_, j) => !check.unsupported.evidence.get(i)?.has(j)) } : f);
  const keep = (list, where) => (list ?? []).filter((_, i) => !bad(where).has(i));
  const fmtClock = (t) => `${t < 0 ? '-' : ''}${Math.floor(Math.abs(Math.trunc(t)) / 60)}:${String(Math.abs(Math.trunc(t)) % 60).padStart(2, '0')}`;
  // Each evidence item gets the game time of the first record it cites, for the reader.
  const keptIndex = (review.findings ?? []).map((_, i) => i).filter((i) => !bad('finding').has(i));
  const picked = goalFromReview(review.goal, { trace, hero: seat.key, findings: (review.findings ?? []).length, match });
  // The goal follows its finding; a goal whose finding was dropped goes with it.
  const goal = picked && keptIndex.includes(picked.finding - 1) ? { ...picked.spec, finding: keptIndex.indexOf(picked.finding - 1) + 1 } : null;
  // A rule whose "this game" states something the tools never said keeps its situation and action and loses that sentence.
  const unbacked = bad('rule');
  // The check for a count the model named: over the deaths, or over one of the hero's own abilities (by its
  // name in the ability data). Anything else — another hero's ability, an unknown key, a count of one — is no check.
  const counts = (habit, ability) => {
    if (HABITS[habit]?.from === 'deaths') { const d = deathContext(trace, { hero: seat.key }); return d.error ? null : habitGoal(habit, d); }
    if (HABITS[habit]?.from !== 'audit' || typeof ability !== 'string') return null;
    const a = abilityAudit(trace, { hero: seat.key, ability });
    const name = a.error ? null : abilityName(a.ability);
    const heroId = Object.values(STATIC_HEROES).find((h) => h.internalSlug === seat.key)?.id;
    if (!name || heroId == null || !a.ability.startsWith(`${seat.key}_`)) return null;
    return habitGoal(habit, a, { hero: seat.key, hero_id: heroId, ability: a.ref.split(':')[2], name });
  };
  // One check per count: two rules about the same count would be judged as one thing twice.
  const counted = new Set();
  const once = (f) => { const h = f.rule?.check ? `${f.rule.check.habit}:${f.rule.check.ability ?? ''}` : null; if (!h) return f; if (counted.has(h)) { const { check, ...rule } = f.rule; return { ...f, rule }; } counted.add(h); return f; };
  const findings = (review.findings ?? []).map(holds).map((f, i) => (unbacked.has(i) && f?.rule ? { ...f, rule: { ...f.rule, this_game: undefined } } : f)).filter((_, i) => !bad('finding').has(i)).map((f) => once({ ...f, title: headingOf(f), ...ruleOf(f, counts) })).map((f) => ({ ...f, evidence: (f.evidence ?? []).map((e) => { const at = check.refs.get(e.refs?.[0])?.at; return { refs: e.refs, ...(at == null ? {} : { clock: fmtClock(at) }), fact: e.fact }; }) }));
  const verdict = bad('verdict').size ? findings[0]?.title ?? '' : review.verdict ?? '';
  return {
    status: findings.length ? 'ok' : 'unverified',
    review: nameHeroes({
      schema: DEEP_REVIEW_SCHEMA, prompt_version: DEEP_REVIEW_PROMPT_VERSION, match_id: trace.match_id, hero: seat.key, lang: language,
      verdict, mainline: keep(review.mainline, 'mainline'), findings, did_well: keep(review.did_well, 'did_well'), next_game: nextGame(findings, language), blind_spots: review.blind_spots ?? [],
      ...(goal ? { goal } : {}),
    }, context.hero_names, context.place_names),
    verification: { repaired, first_pass_problems: firstProblems.length, dropped: (review.findings ?? []).length - findings.length, problems: check.problems },
    // What did not ship, as it was written: for whoever has to find out why (never shown to the reader).
    dropped_findings: (review.findings ?? []).filter((_, i) => bad('finding').has(i)),
    tool_calls: transcript.map((t) => ({ name: t.name, args: t.args })),
    steps, usage,
  };
}
