/**
 * The deep review as the model hands it in (`submit_review`), and the limits the check and the prompt share.
 */
import { HABIT_KEYS } from '../../coach/goals.js';
import { GOAL_SCHEMA } from '../goal.js';

export const DEEP_REVIEW_SCHEMA = 'dota2.ai/deep-review@1';
export const DEEP_REVIEW_PROMPT_VERSION = 70;
export const MAX_REFS = 3;
export const MAX_FINDINGS = 3;
export const MAX_PLAN_EVIDENCE = 4;
/** The story of the game as a chain of causes (#437 P4): how many links, and how many evidence items each. */
export const MAX_STORY = 6;
export const MAX_STORY_EVIDENCE = 3;
/** Whose a link of the story is, in the model's judgment: the player's, the team's, the enemy's, the draft's. */
export const STORY_WHOSE = ['me', 'team', 'enemy', 'draft', 'unclear'];
/** A link's sentences, checked by position like PLAN_TEXTS. */
export const STORY_TEXTS = ['phase', 'what_changed', 'because'];
/** What a game's course is put down to. A judgment, not a fact: it ships only with the sentence that argues it. */
export const PLAN_REASONS = ['your_play', 'team_play', 'enemy_play', 'line_ups', 'unclear'];
/** The sentences of a game plan that state things about the game, in the order they are checked and shown. */
// Checked by position: a new text goes at the end, so the others keep theirs.
export const PLAN_TEXTS = ['line_ups', 'course', 'your_part', 'why', 'strengths', 'window', 'against_your_plan'];
/** A stated time may be this far from a tool's time (rounding to the second, "about 30:10"). */
export const CLOCK_TOLERANCE = 3;
/** From here up a number is checked wherever it stands; below, only decimals, counts and evidence. */
export const BIG = 100;
/** Integers up to this are too common to check by matching ("two fights", "level 3"). */
export const TRIVIAL = 3;

const STR = { type: 'string' };
export const SUBMIT_REVIEW = {
  name: 'submit_review',
  description: 'Hand in the finished review. Call it once, after you have investigated with the other tools. Every time and number you write must come from a tool result of this conversation.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['verdict', 'story', 'findings', 'blind_spots', 'game_plan'],
    properties: {
      verdict: { ...STR, description: 'One concise sentence (at most 1–2 numbers): the main reason this game went the way it did for this player.' },
      story: {
        type: 'array', minItems: 2, maxItems: MAX_STORY,
        description: 'How the game came to its result, as a chain of causes in game order: each link a stretch of the game, what changed in it (gold, buildings, the chance to win, a lane), and because of what, with the records that show it. From the draft and the lanes to the turn and the end. The verdict sums this chain up in one sentence.',
        items: {
          type: 'object', additionalProperties: false, required: ['phase', 'what_changed', 'because', 'whose', 'evidence'],
          properties: {
            phase: { ...STR, description: 'The stretch, with its times: "0:00–10:00, the lane", "24:00–27:47, the turn".' },
            what_changed: { ...STR, description: 'What changed in it, with the tools\' numbers: the gold lead, buildings, a lane\'s result.' },
            because: { ...STR, description: 'Why, from the tools: where the gap came from, who came, who was where. Facts, not motives.' },
            whose: { type: 'string', enum: STORY_WHOSE, description: 'Whose doing this link mostly is, in your judgment: me (what the player controlled), team, enemy, draft, or unclear.' },
            evidence: {
              type: 'array', minItems: 1, maxItems: MAX_STORY_EVIDENCE,
              items: {
                type: 'object', additionalProperties: false, required: ['refs', 'fact'],
                properties: {
                  refs: { type: 'array', minItems: 1, maxItems: MAX_REFS, items: STR, description: 'The `ref` of each record this fact is read from, copied exactly.' },
                  fact: { ...STR, description: 'What those records show. Every time and number here must be in the cited records.' },
                },
              },
            },
          },
        },
      },
      findings: {
        type: 'array', minItems: 1, maxItems: MAX_FINDINGS,
        description: 'The problems that mattered most, most important first.',
        items: {
          type: 'object', additionalProperties: false, required: ['title', 'claim', 'evidence', 'fix'],
          properties: {
            title: { ...STR, description: 'REQUIRED, and written first. The finding in a few words, as a heading: what the player did, not a label — at most twelve words, or twenty Chinese characters, with no times and no numbers. The claim does not repeat it.' },
            claim: { ...STR, description: 'What went wrong and why it mattered, in 1–2 concise sentences (at most 1–2 key numbers; put detailed clocks and counts in evidence).' },
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
              description: 'Optional repeatable rule for the next game: include when the finding reflects a pattern seen 2+ times in this game or a trackable habit/item rule; omit for a one-off fight or single-moment decision rather than inventing a rule from one moment.',
              properties: {
                when: { ...STR, description: 'The situation, as the player meets it in game, from what is on their own screen at that moment: their health and mana, who stands next to them, what an enemy just used, the clock, what is in the shop. Not hindsight ("before you die"), not a mood ("when it is dangerous").' },
                do: { ...STR, description: 'One action for that situation: where to go, what to buy and by when, what to hold or wait for. Not "be careful", "position better" or "react faster".' },
                this_game: { ...STR, description: 'How often that situation came up in this game and went the other way: the count a tool states and the times (for example three of the twelve deaths, then their times), written in the language of the review like everything else. Every time and number must be in a tool result.' },
                counted_by: { type: 'string', enum: HABIT_KEYS, description: 'Which count a tool keeps that this rule is about, if one is — the next game\'s replay is counted the same way to see whether the rule was followed. From death_context.deaths_where — low_health_outside_fights: health_below_half_at_window_start_outside_fights. outnumbered_outside_fights: three_or_more_enemy_heroes_dealing_damage_outside_fights. alone: no_ally_within_2200_at_death. alone_not_traded: no_ally_within_2200_at_death_and_not_traded (the lone deaths that bought nothing: use it, not alone, when the finding is that dying alone got nothing back). nothing_pressed: nothing_cast_and_no_item_used. (low_health and outnumbered count the same over every death, fights included: use them only when the finding is about the fights themselves.) From ability_audit of one of the player\'s own abilities (name it in counted_ability) — cast_into_immunity: casts_where.target_spell_immune_and_not_stunned. target_survived: casts_where.enemy_hero_target_alive_12s_later. reached_few: casts_where.no_hero_target_and_at_most_one_enemy_hero_damaged. died_holding: deaths_with_it_ready_and_not_cast_total. Omit when the rule is about something else (an item).' },
                counted_ability: { type: 'string', description: 'For the four ability counts: the ability key as ability_audit names it (e.g. "tidehunter_ravage").' },
              },
            },
            fix: { ...STR, description: 'How to carry the rule out, in one or two sentences. Advice, not game facts.' },
            story_link: { type: 'integer', minimum: 1, description: 'Which link of the story (1 = the first) this finding is about.' },
          },
        },
      },
      game_plan: {
        type: 'object', additionalProperties: false, required: ['main_reason', 'why'],
        description: 'Whole-game judgment beside `story` (do not repeat `story` chronology or findings): state `main_reason` and `why`, plus optional `strengths`, `line_ups`, and `against_your_plan` (only when the player stated a plan). Omit `course`, `your_part`, and `window` when `story` already covers them; attach `evidence` only for records not already cited in `story`.',
        properties: {
          line_ups: { ...STR, description: 'What lineup_timing shows: which heroes of each side win more in shorter or in longer public games, and which length this game had. One or two sentences; say "public games" and name the heroes. Leave out when it shows no lean on either side.' },
          strengths: { ...STR, description: 'Optional: what the player\'s hero was up against and when, from power_spikes (matchups in public/pro games, key level/item timings, and from which enemy item the kills came). Leave out what the tool has no data for.' },
          against_your_plan: { ...STR, description: 'Only when the opening message says what the player\'s plan was: read the game against it (fit of items/play via build_for_plan & tempo_report, whether hero/window data supports it, and where it broke via farm_report/window_report). Leave out when the player did not state a plan.' },
          window: { ...STR, description: 'Optional (omit when `story` already covers the gold windows): peak lead window, buildings/fights taken, and enemy items finished near its end (never say an item "ended" the window).' },
          course: { ...STR, description: 'Optional (omit when `story` already covers the course of the game): summary of buildings and fights from tempo_report.' },
          your_part: { ...STR, description: 'Optional (omit when `story` already covers the player\'s map presence): where the player spent time and which fights/buildings they joined.' },
          main_reason: { type: 'string', enum: PLAN_REASONS, description: 'What the course of the game is mostly down to, in your judgment: your_play (the player\'s own play), team_play (the team\'s), enemy_play (what the enemy did), line_ups (the draft), unclear (the tools do not settle it).' },
          why: { ...STR, description: 'One or two sentences arguing main_reason from what the tools showed.' },
          evidence: {
            type: 'array', maxItems: MAX_PLAN_EVIDENCE,
            items: {
              type: 'object', additionalProperties: false, required: ['refs', 'fact'],
              properties: {
                refs: { type: 'array', minItems: 1, maxItems: MAX_REFS, items: STR, description: 'The `ref` of each record this fact is read from, copied exactly (e.g. "spikes:<hero>", "build:<hero>", "tempo:<hero>", "lineup_timing", "window:<hero>").' },
                fact: { ...STR, description: 'What those records show. Every time and number here must be in the cited records.' },
              },
            },
          },
        },
      },
      did_well: { type: 'array', items: STR, maxItems: 3 },
      goal: GOAL_SCHEMA,
      blind_spots: { type: 'array', items: STR, description: 'What the replay data could not show for this review (from the tools\' gaps).' },
    },
  },
};
