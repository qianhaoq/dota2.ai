import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DEEP_REVIEW_PROMPT_VERSION, SUBMIT_REVIEW, TRANSLATE_SYSTEM, deepReviewSystem } from '../../lib/agent/deepReview.js';
import { TRUNCATION_RETRY_INSTRUCTION } from '../../lib/agent/loop.js';
import { KNOWLEDGE_TOOLS } from '../../lib/agent/knowledgeTools.js';
import { TRACE_TOOLS } from '../../packages/review-engine/src/trace/index.js';
import { WEB_SEARCH_TOOL } from '../../lib/agent/webSearch.js';

/**
 * What the model is told: the system prompt in all languages, the translation prompt, the review it must hand in,
 * and every lookup tool's name, description and arguments. A stored review is kept under the prompt version
 * (`<match>.<hero>.p<version>`), so text that changes without the version changing leaves reviews
 * written to the old text standing as if they were current.
 *
 * Changing any of it: raise DEEP_REVIEW_PROMPT_VERSION and put the new version and hash here. Two branches
 * that both do so meet on this one line when they merge, instead of both shipping as the same version.
 */
const PIN = { version: 83, hash: 'd35f479bbb28f23de8f2ec8c4627441e85b937282f978888707dc722f89d121c' };

function promptHash() {
  const tools = [...TRACE_TOOLS, ...KNOWLEDGE_TOOLS, WEB_SEARCH_TOOL].map(({ name, description, input_schema }) => ({ name, description, input_schema }));
  return createHash('sha256').update(JSON.stringify({ en: deepReviewSystem('en'), zh: deepReviewSystem('zh'), ru: deepReviewSystem('ru'), translate: TRANSLATE_SYSTEM, submit: SUBMIT_REVIEW, truncationRetry: TRUNCATION_RETRY_INSTRUCTION, tools })).digest('hex');
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
