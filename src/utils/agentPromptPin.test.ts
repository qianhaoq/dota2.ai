import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DEEP_REVIEW_PROMPT_VERSION, SUBMIT_REVIEW, TRANSLATE_SYSTEM, deepReviewSystem } from '../../lib/agent/deepReview.js';
import { KNOWLEDGE_TOOLS } from '../../lib/agent/knowledgeTools.js';
import { TRACE_TOOLS } from '../../packages/review-engine/src/trace/index.js';

/**
 * What the model is told: the system prompt in all languages, the translation prompt, the review it must hand in,
 * and every lookup tool's name, description and arguments. A stored review is kept under the prompt version
 * (`<match>.<hero>.p<version>`), so text that changes without the version changing leaves reviews
 * written to the old text standing as if they were current.
 *
 * Changing any of it: raise DEEP_REVIEW_PROMPT_VERSION and put the new version and hash here. Two branches
 * that both do so meet on this one line when they merge, instead of both shipping as the same version.
 */
const PIN = { version: 60, hash: 'ad371e031a75aca9cddc4e1d29c4e2fb34f09c2d0684a35f0cc05d42830a4730' };

function promptHash() {
  const tools = [...TRACE_TOOLS, ...KNOWLEDGE_TOOLS].map(({ name, description, input_schema }) => ({ name, description, input_schema }));
  return createHash('sha256').update(JSON.stringify({ en: deepReviewSystem('en'), zh: deepReviewSystem('zh'), ru: deepReviewSystem('ru'), translate: TRANSLATE_SYSTEM, submit: SUBMIT_REVIEW, tools })).digest('hex');
}

describe('deep review prompt pin', () => {
  it('the prompt version is the pinned one', () => {
    expect(DEEP_REVIEW_PROMPT_VERSION).toBe(PIN.version);
  });

  it('the prompt, the review schema and the tool definitions are what that version was pinned to', () => {
    // A failure here means the model is now told something else: raise DEEP_REVIEW_PROMPT_VERSION and update PIN.
    expect(promptHash()).toBe(PIN.hash);
  });
});
