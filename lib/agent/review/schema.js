/**
 * The deep review as the model hands it in (`submit_review`), and the limits the check and the prompt share.
 */

export const DEEP_REVIEW_SCHEMA = 'dota2.ai/deep-review@1';
export const DEEP_REVIEW_PROMPT_VERSION = 84;
export const MAX_REFS = 3;
export const MAX_FINDINGS = 3;
export const MAX_HIGHLIGHTS = 4;
export const MAX_HIGHLIGHT_EVIDENCE = 3;
export const MAX_CHAPTERS = 7;
export const MAX_CHAPTER_EVIDENCE = 4;
export const MAX_PLAN_EVIDENCE = 4;
/** Chronological Dota 2 coaching progression for adaptive chapters. */
export const CHAPTER_TOPICS = [
  'draft',
  'game_plan',
  'laning',
  'midgame',
  'vision_and_macro',
  'skills_and_items',
  'other',
];
/** What a game's course is put down to. A judgment, not a fact: it ships only with the sentence that argues it. */
export const PLAN_REASONS = ['your_play', 'team_play', 'enemy_play', 'line_ups', 'unclear'];
/** The prose fields of `game_plan` checked by position. */
export const PLAN_TEXTS = ['why', 'against_your_plan'];
/** A stated time may be this far from a tool's time (rounding to the second, "about 30:10"). */
export const CLOCK_TOLERANCE = 3;
/** From here up a number is checked wherever it stands; below, only decimals, counts and evidence. */
export const BIG = 100;
/** Integers up to this are too common to check by matching ("two fights", "level 3"). */
export const TRIVIAL = 3;

const STR = { type: 'string' };
const EVIDENCE_ITEM = {
  type: 'object',
  additionalProperties: false,
  required: ['refs', 'fact'],
  properties: {
    refs: { type: 'array', minItems: 1, maxItems: MAX_REFS, items: STR, description: 'The `ref` of each record this fact is read from, copied exactly.' },
    fact: { ...STR, description: 'What those records show. Every time and number here must be in the cited records.' },
  },
};

export const SUBMIT_REVIEW = {
  name: 'submit_review',
  description: 'Hand in the finished review. Call it once, after you have investigated with the other tools. Every time and number you write must come from a tool result of this conversation.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['verdict', 'highlights', 'findings', 'chapters', 'game_plan', 'blind_spots'],
    properties: {
      verdict: { ...STR, description: 'One direct sentence summing up the game for this player (at most 1–2 key numbers).' },
      highlights: {
        type: 'array', minItems: 0, maxItems: MAX_HIGHLIGHTS,
        description: 'Up front — what went well: concrete, replay-backed positives (good plays, smart adaptations, solid lane/fight/macro execution). Leave empty only if nothing genuinely stood out; no hollow praise.',
        items: {
          type: 'object', additionalProperties: false, required: ['title', 'detail'],
          properties: {
            title: { ...STR, description: 'Concise, specific heading (no hollow flattery, no raw engine keys).' },
            detail: { ...STR, description: '1–2 direct sentences explaining why this play or stretch worked, grounded in tool facts.' },
            evidence: {
              type: 'array', maxItems: MAX_HIGHLIGHT_EVIDENCE,
              description: 'Optional exact tool records backing this highlight so the player can open and replay the moment.',
              items: EVIDENCE_ITEM,
            },
          },
        },
      },
      findings: {
        type: 'array', minItems: 0, maxItems: MAX_FINDINGS,
        description: 'Up front — what did not go well: the 0–3 highest-leverage, player-controlled improvements, most important first. Keep empty or concise in clean wins where no player mistake mattered.',
        items: {
          type: 'object', additionalProperties: false, required: ['title', 'claim', 'evidence', 'fix'],
          properties: {
            title: { ...STR, description: 'REQUIRED, written first. Short heading stating what happened — at most 12 English words or 20 Chinese characters, with no times and no numbers.' },
            claim: { ...STR, description: 'What went wrong and why it mattered, in 1–2 direct sentences (at most 1–2 key numbers; put detailed clocks and counts in evidence).' },
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
            fix: { ...STR, description: 'Concrete, natural coaching advice on how to play it better next time, in 1–2 direct sentences. No mechanical slogans or numeric quotas.' },
          },
        },
      },
      chapters: {
        type: 'array', minItems: 2, maxItems: MAX_CHAPTERS,
        description: 'Clear, chronological Dota 2 walkthrough (2–7 chapters; include only stages that mattered in this match, no filler): draft (10-hero lineup & matchup/counter dynamics) → game_plan (recommended game plan & win condition for this hero against both drafts) → laning (actual lanes, 0–10m execution & early rotations) → midgame (fights vs farm tempo, key skirmishes & deaths) → vision_and_macro (ward placement & dewards only—never fog of war—plus Roshan, towers & map windows) → skills_and_items (skill progression, key casts, item choices & timings vs threats and economy) → other (only if another key detail does not fit above).',
        items: {
          type: 'object', additionalProperties: false, required: ['topic', 'title', 'analysis', 'evidence'],
          properties: {
            topic: { type: 'string', enum: CHAPTER_TOPICS, description: 'Which stage of the match walkthrough this chapter covers.' },
            title: { ...STR, description: 'Specific, match-tailored heading for this chapter (no raw engine keys).' },
            analysis: { ...STR, description: '2–4 sentences of sharp, grounded Dota 2 analysis covering what happened, why it mattered, and any concrete adjustment naturally in prose.' },
            evidence: {
              type: 'array', minItems: 1, maxItems: MAX_CHAPTER_EVIDENCE,
              items: EVIDENCE_ITEM,
            },
          },
        },
      },
      game_plan: {
        type: 'object', additionalProperties: false, required: ['main_reason', 'why'],
        description: 'Concise whole-game attribution beside `chapters` (do not repeat chapter prose): state `main_reason` and `why`, plus `against_your_plan` ONLY when the opening message names the player\'s stated plan; attach `evidence` ONLY for uncited records if needed.',
        properties: {
          main_reason: { type: 'string', enum: PLAN_REASONS, description: 'What the match\'s course is mostly down to: your_play, team_play, enemy_play, line_ups, or unclear.' },
          why: { ...STR, description: '1–2 direct sentences arguing main_reason from tool facts, without repeating `chapters`.' },
          against_your_plan: { ...STR, description: 'ONLY when the opening message names the player\'s stated plan: evaluate the match against it (fit via build_for_plan & tempo_report, lineup support via lineup_timing, and where it broke via farm_report/window_report). Omit otherwise.' },
          evidence: {
            type: 'array', maxItems: MAX_PLAN_EVIDENCE,
            description: 'Optional: attach ONLY for records not already cited in `chapters`.',
            items: EVIDENCE_ITEM,
          },
        },
      },
      blind_spots: { type: 'array', items: STR, description: 'What the replay data could not show for this review (from the tools\' gaps).' },
    },
  },
};
