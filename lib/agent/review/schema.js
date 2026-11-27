/**
 * The deep review as the model hands it in (`submit_review`), and the limits the check and the prompt share.
 */
import { HABIT_KEYS } from '../../coach/goals.js';
import { GOAL_SCHEMA } from '../goal.js';

export const DEEP_REVIEW_SCHEMA = 'dota2.ai/deep-review@1';
export const DEEP_REVIEW_PROMPT_VERSION = 56;
export const MAX_REFS = 3;
export const MAX_FINDINGS = 3;
export const MAX_PLAN_EVIDENCE = 4;
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
    required: ['verdict', 'mainline', 'findings', 'blind_spots', 'game_plan'],
    properties: {
      verdict: { ...STR, description: 'One sentence: the main reason this game went the way it did for this player.' },
      mainline: { type: 'array', items: STR, maxItems: 5, description: 'The story of the game in phases, each with its times.' },
      findings: {
        type: 'array', minItems: 1, maxItems: MAX_FINDINGS,
        description: 'The problems that mattered most, most important first.',
        items: {
          type: 'object', additionalProperties: false, required: ['title', 'claim', 'evidence', 'rule', 'fix'],
          properties: {
            title: { ...STR, description: 'REQUIRED, and written first. The finding in a few words, as a heading: what the player did, not a label — at most twelve words, or twenty Chinese characters, with no times and no numbers. The claim does not repeat it.' },
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
                counted_by: { type: 'string', enum: HABIT_KEYS, description: 'Which count a tool keeps that this rule is about, if one is — the next game\'s replay is counted the same way to see whether the rule was followed. From death_context.deaths_where — low_health_outside_fights: health_below_half_at_window_start_outside_fights. outnumbered_outside_fights: three_or_more_enemy_heroes_dealing_damage_outside_fights. alone: no_ally_within_2200_at_death. alone_not_traded: no_ally_within_2200_at_death_and_not_traded (the lone deaths that bought nothing: use it, not alone, when the finding is that dying alone got nothing back). nothing_pressed: nothing_cast_and_no_item_used. (low_health and outnumbered count the same over every death, fights included: use them only when the finding is about the fights themselves.) From ability_audit of one of the player\'s own abilities (name it in counted_ability) — cast_into_immunity: casts_where.target_spell_immune_and_not_stunned. target_survived: casts_where.enemy_hero_target_alive_12s_later. reached_few: casts_where.no_hero_target_and_at_most_one_enemy_hero_damaged. died_holding: deaths_with_it_ready_and_not_cast_total. Omit when the rule is about something else (an item).' },
                counted_ability: { type: 'string', description: 'For the four ability counts: the ability key as ability_audit names it (e.g. "tidehunter_ravage").' },
              },
            },
            fix: { ...STR, description: 'How to carry the rule out, in one or two sentences. Advice, not game facts.' },
          },
        },
      },
      game_plan: {
        type: 'object', additionalProperties: false, required: ['course', 'your_part', 'main_reason', 'why', 'evidence'],
        description: 'How the game was played as a whole, beside the findings: when each side had its chance, what the two teams did with the map and with their fights, where the player was meanwhile, and what the course of the game is mostly down to. From window_report, tempo_report, power_spikes and lineup_timing. Not another finding: nothing a finding already says.',
        properties: {
          line_ups: { ...STR, description: 'What lineup_timing shows: which heroes of each side win more in shorter or in longer public games, and which length this game had. One or two sentences; say "public games" and name the heroes. Leave out when it shows no lean on either side.' },
          strengths: { ...STR, description: 'Always present when power_spikes answered. What the player\'s hero was up against and when, from power_spikes: which enemy heroes it usually does worse or better against (say "public games" or "professional games" and the numbers), when the enemy who killed the player most reached their levels and big items next to when the player reached theirs, and from which of that enemy\'s items the kills came. Two or three sentences. Leave out what the tool has no data for.' },
          against_your_plan: { ...STR, description: 'Only when the opening message says what the player\'s plan was: the game read against it, in three to five sentences and in this order. One: did the player\'s own play fit it — their items (build_for_plan with that plan: the first item for it and when, the gold in other items before it), where they were, the fights they were at, the buildings they damaged. Two: does the data on these heroes support it against this line-up (lineup_timing, power_spikes, the windows of window_report) — when it shows no lean, say the data does not settle it. Three: where it broke, if it did — the player\'s own play, the team\'s, or what the enemy did (their window, their items by then, who on their side got richest while your team was ahead and whether they stood by the buildings your team took: farm_report). Leave out when the player did not say what their plan was.' },
          window: { ...STR, description: 'When the player\'s team had its chance, from window_report: the window in which it was ahead (its times and peak lead), what it took in it (buildings, fights it came out ahead in), and the big items the enemy finished inside it and in its last 180 seconds; or, when the team never had a window, the enemy\'s window and what it took. Two or three sentences, times and numbers as the tool gives them. Say an item came before the end; never that it ended the window. Leave out when window_report has no windows (gaps).' },
          course: { ...STR, description: 'What the two teams did with the game, from tempo_report: when each side took its buildings, how many fights each side lost fewer heroes in, and how many of those a building followed. Counts and times as the tool gives them.' },
          your_part: { ...STR, description: 'Where the player was while that happened, from the stretches of tempo_report: which side of the map, alone or with allies near, which fights they were at, which buildings they damaged. No guess about what they meant to do.' },
          main_reason: { type: 'string', enum: PLAN_REASONS, description: 'What the course of the game is mostly down to, in your judgment: your_play (the player\'s own play), team_play (the team\'s), enemy_play (what the enemy did), line_ups (the draft), unclear (the tools do not settle it).' },
          why: { ...STR, description: 'One or two sentences arguing main_reason from what the tools showed.' },
          evidence: {
            type: 'array', minItems: 1, maxItems: MAX_PLAN_EVIDENCE,
            items: {
              type: 'object', additionalProperties: false, required: ['refs', 'fact'],
              properties: {
                refs: { type: 'array', minItems: 1, maxItems: MAX_REFS, items: STR, description: 'The `ref` of each record this fact is read from, copied exactly: "spikes:beastmaster" for levels, item times, kills around an item and matchups, "build:beastmaster" for the build and what killed the player, "tempo:beastmaster" for the whole game\'s counts, "phase:beastmaster:3" for one stretch (also for which of its fights the player was at), "lineup_timing", "window:beastmaster" for the gold lead over the game and "window:beastmaster:2" for one window, "fight:8" for a fight of match_overview.' },
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
