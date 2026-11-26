/**
 * The deep review: an agent investigates one player's game with the replay
 * and knowledge tools and submits a structured review
 * (`dota2.ai/deep-review@1`).
 *
 * Beside the findings (one player's own play) the review has a game plan:
 * how the game was played as a whole — what the teams did with the map and
 * their fights, where the player was meanwhile, and what the course is
 * mostly down to — from tempo_report and lineup_timing.
 *
 * The prompt teaches a method, not conclusions. The review is then checked
 * by code, not by trust (verifyReview): what it states about the game must
 * be in what the tools returned during this run. The model gets one chance
 * to repair what fails; whatever still states something the tools never
 * said is dropped.
 */
export { DEEP_REVIEW_SCHEMA, DEEP_REVIEW_PROMPT_VERSION, PLAN_REASONS, SUBMIT_REVIEW } from './review/schema.js';
export { deepReviewSystem } from './review/prompt.js';
export { collectFacts, statedFacts, approachClaims, sightClaims, stripHandles, withoutHandles, wordingProblems, verifyReview, planOf, verifyText } from './review/verify.js';
export { reviewToolkit, nameHeroes, heroNames } from './review/toolkit.js';
export { headingOf, nextGame, REVIEW_CHECKPOINT_VERSION, runDeepReview } from './review/run.js';
export { extractTranslatable, applyTranslation, parseTranslationJson, translateReview } from './review/translate.js';
export { placeNames } from './places.js';
