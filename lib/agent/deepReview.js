/**
 * The deep review: an agent investigates one player's game with the replay
 * and knowledge tools and submits a structured review
 * (`dota2.ai/deep-review@1`).
 *
 * The prompt teaches first-principles Dota 2 data facts and coaching judgment;
 * the review is verified by code (verifyReview) so every stated fact must come
 * from tool outputs returned in that run. One repair round is allowed; anything
 * still unbacked is dropped.
 */
export { DEEP_REVIEW_SCHEMA, DEEP_REVIEW_PROMPT_VERSION, CHAPTER_TOPICS, PLAN_REASONS, SUBMIT_REVIEW } from './review/schema.js';
export { deepReviewSystem } from './review/prompt.js';
export { collectFacts, statedFacts, sightClaims, stripHandles, withoutHandles, wordingProblems, englishWords, sentenceFacts, NUMBERS_PER_SENTENCE, suggestChildRefs, verifyReview, highlightsOf, chaptersOf, planOf, planGapOf, verifyText } from './review/verify.js';
export { reviewToolkit, nameHeroes, heroNames } from './review/toolkit.js';
export { headingOf, REVIEW_CHECKPOINT_VERSION, runDeepReview } from './review/run.js';
export { TRANSLATE_SYSTEM, extractTranslatable, applyTranslation, parseTranslationJson, translateReview } from './review/translate.js';
export { placeNames } from './places.js';
