/**
 * The deep review as the model hands it in (`submit_review`), and the limits the check and the prompt share.
 */

export const DEEP_REVIEW_SCHEMA = 'dota2.ai/deep-review@1';
export const DEEP_REVIEW_PROMPT_VERSION = 79;
export const MAX_REFS = 3;
export const MAX_FINDINGS = 3;
export const MAX_HIGHLIGHTS = 4;
export const MAX_HIGHLIGHT_EVIDENCE = 3;
export const MAX_CHAPTERS = 6;
export const MAX_CHAPTER_EVIDENCE = 4;
export const MAX_PLAN_EVIDENCE = 4;
/** Coaching dimensions an adaptive breakdown chapter may examine. */
export const CHAPTER_TOPICS = ['draft_and_lanes', 'laning', 'skill_build', 'items', 'teamfights', 'macro', 'other'];
/** Honest coaching assessment of a chapter's dimension. */
export const CHAPTER_ASSESSMENTS = ['praise', 'solid', 'mixed', 'key_gap'];
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
    required: ['verdict', 'opening_note', 'highlights', 'chapters', 'story', 'findings', 'blind_spots', 'game_plan', 'encouragement'],
    properties: {
      verdict: { ...STR, description: 'One crisp sentence summing up the game for this player (at most 1–2 key numbers).' },
      opening_note: { ...STR, description: '2–3 sincere, grounded sentences from a professional Dota 2 coach setting the tone for this player: fairly contextualize the match difficulty (draft, team state, opponent tempo), celebrate a win warmly or separate non-player factors in a loss so the player feels understood and respected.' },
      highlights: {
        type: 'array', minItems: 1, maxItems: MAX_HIGHLIGHTS,
        description: 'Concrete, evidence-backed positives from this game — genuine good plays, smart decisions, solid laning/item/skill adaptation, fight impact, or composure in tough games. No hollow flattery.',
        items: {
          type: 'object', additionalProperties: false, required: ['title', 'detail'],
          properties: {
            title: { ...STR, description: 'Concise, specific praise heading (no hollow flattery, no raw engine keys).' },
            detail: { ...STR, description: '1–2 sentences explaining why this play, decision, or stretch was genuinely good, grounded in tool facts.' },
            evidence: {
              type: 'array', maxItems: MAX_HIGHLIGHT_EVIDENCE,
              description: 'Optional exact tool records backing this highlight so the player can open and replay the moment on the minimap.',
              items: EVIDENCE_ITEM,
            },
          },
        },
      },
      chapters: {
        type: 'array', minItems: 2, maxItems: MAX_CHAPTERS,
        description: 'Adaptive, game-tailored full-dimension coaching breakdown covering the aspects that mattered in this replay (draft & lanes, laning, skill build, items, teamfights, macro, or other). Cover what matters here without forcing empty sections.',
        items: {
          type: 'object', additionalProperties: false, required: ['topic', 'title', 'assessment', 'analysis', 'evidence'],
          properties: {
            topic: { type: 'string', enum: CHAPTER_TOPICS, description: 'Which coaching dimension this chapter examines.' },
            title: { ...STR, description: 'Specific, game-tailored coach heading for this dimension (no raw engine keys).' },
            assessment: { type: 'string', enum: CHAPTER_ASSESSMENTS, description: 'Honest coaching assessment: praise (standout strength), solid (executed well), mixed (strengths alongside room to sharpen), or key_gap (high-leverage area to improve).' },
            analysis: { ...STR, description: '2–4 sentences of authentic, deeply knowledgeable Dota 2 coaching grounded in tool facts, naturally weaving what worked with what could be sharper.' },
            takeaway: { ...STR, description: 'Optional concrete coaching suggestion ONLY when this dimension genuinely has room to improve; omit for praise/solid dimensions rather than inventing nitpicks.' },
            evidence: {
              type: 'array', minItems: 1, maxItems: MAX_CHAPTER_EVIDENCE,
              items: EVIDENCE_ITEM,
            },
          },
        },
      },
      story: {
        type: 'array', minItems: 2, maxItems: MAX_STORY,
        description: 'Concise 1-sentence-per-phase causal backbone in game order (2–5 links; do not repeat full `chapters` prose): each link names a stretch, what changed (gold, buildings, lane), and because of what, backed by exact records. The verdict sums this chain up in one sentence.',
        items: {
          type: 'object', additionalProperties: false, required: ['phase', 'what_changed', 'because', 'whose', 'evidence'],
          properties: {
            phase: { ...STR, description: 'The stretch, with its times: "0:00–10:00, the lane", "24:00–27:47, the turn".' },
            what_changed: { ...STR, description: 'One concise sentence on what changed in this stretch, with the tools\' numbers (gold lead, buildings, lane result).' },
            because: { ...STR, description: 'One concise sentence on why, from the tools (where the gap came from, who joined, who was where). Facts, not motives.' },
            whose: { type: 'string', enum: STORY_WHOSE, description: 'Whose doing this link mostly is, in your judgment: me (what the player controlled), team, enemy, draft, or unclear.' },
            evidence: {
              type: 'array', minItems: 1, maxItems: MAX_STORY_EVIDENCE,
              items: EVIDENCE_ITEM,
            },
          },
        },
      },
      findings: {
        type: 'array', minItems: 0, maxItems: MAX_FINDINGS,
        description: 'The 0–3 highest-leverage, player-controlled improvements, most important first. Keep concise or empty in clean wins where no real mistake mattered.',
        items: {
          type: 'object', additionalProperties: false, required: ['title', 'claim', 'evidence', 'fix'],
          properties: {
            title: { ...STR, description: 'REQUIRED, and written first. The improvement in a few words, as a heading: what the player did, not a label — at most twelve words, or twenty Chinese characters, with no times and no numbers. The claim does not repeat it.' },
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
              type: 'object', additionalProperties: false, required: ['when', 'do'],
              description: 'Optional repeatable coaching cue for future games: include when the improvement reflects a recurring in-game decision or clear timing rule; omit for a one-off fight or single-moment decision rather than inventing a rule from one moment.',
              properties: {
                when: { ...STR, description: 'The situation, as the player meets it in game, from what is on their own screen at that moment: their health and mana, who stands next to them, what an enemy just used, the clock, what is in the shop. Not hindsight ("before you die"), not a mood ("when it is dangerous").' },
                do: { ...STR, description: 'One concrete action for that situation: where to go, what to buy and by when, what to hold or wait for. Not "be careful", "position better" or "react faster".' },
                this_game: { ...STR, description: 'Optional: how often that situation came up in this game and went the other way (the count a tool states and the times), written in the language of the review. Every time and number must be in a tool result.' },
              },
            },
            fix: { ...STR, description: 'How to make the sharper play next time, in one or two collaborative sentences. Advice, not game facts.' },
            story_link: { type: 'integer', minimum: 1, description: 'Which link of the story (1 = the first) this improvement is about.' },
          },
        },
      },
      game_plan: {
        type: 'object', additionalProperties: false, required: ['main_reason', 'why'],
        description: 'Whole-game judgment beside `chapters` and `story` (do not re-summarize draft, timeline, or findings): state only `main_reason` and `why`, plus `against_your_plan` ONLY when the opening message names the player\'s stated plan; attach `evidence` ONLY for records not already cited in `chapters`/`story`.',
        properties: {
          against_your_plan: { ...STR, description: 'ONLY when the opening message names the player\'s stated plan: read the game against it (fit of items/play via build_for_plan & tempo_report, whether hero/window data supports it, and where it broke via farm_report/window_report). Omit when the player did not state a plan.' },
          main_reason: { type: 'string', enum: PLAN_REASONS, description: 'What the course of the game is mostly down to, in your judgment: your_play (the player\'s own play), team_play (the team\'s), enemy_play (what the enemy did), line_ups (the draft), unclear (the tools do not settle it).' },
          why: { ...STR, description: 'One or two sentences arguing main_reason from what the tools showed, without repeating `chapters` or `story`.' },
          evidence: {
            type: 'array', maxItems: MAX_PLAN_EVIDENCE,
            description: 'Optional: attach ONLY for records not already cited in `chapters`/`story`.',
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
      encouragement: { ...STR, description: '1–2 sincere, specific closing sentences from the coach affirming the strengths already shown in this replay and building genuine confidence for future games.' },
      blind_spots: { type: 'array', items: STR, description: 'What the replay data could not show for this review (from the tools\' gaps).' },
    },
  },
};
