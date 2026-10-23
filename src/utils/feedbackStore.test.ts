import { describe, it, expect } from 'vitest';
import {
  FEEDBACK_KINDS,
  FEEDBACK_MAX_FIELD,
  FEEDBACK_MAX_MESSAGE,
  normalizeFeedbackSubmission,
} from '../../lib/feedbackStore.js';

describe('normalizeFeedbackSubmission — legacy message feedback', () => {
  it('requires a message when no kind is given', () => {
    expect(normalizeFeedbackSubmission({})).toEqual({ ok: false, error: 'message_required' });
    expect(normalizeFeedbackSubmission({ message: '   ' })).toEqual({ ok: false, error: 'message_required' });
  });

  it('normalizes and caps a plain message submission', () => {
    const result = normalizeFeedbackSubmission({
      message: `  ${'x'.repeat(FEEDBACK_MAX_MESSAGE + 10)}  `,
      name: 'n'.repeat(FEEDBACK_MAX_FIELD + 10),
      contact: 'c'.repeat(FEEDBACK_MAX_FIELD + 10),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kind).toBeNull();
    expect(result.message).toHaveLength(FEEDBACK_MAX_MESSAGE);
    expect(result.name).toHaveLength(FEEDBACK_MAX_FIELD);
    expect(result.contact).toHaveLength(FEEDBACK_MAX_FIELD);
  });

  it('rejects non-object bodies', () => {
    expect(normalizeFeedbackSubmission(null)).toEqual({ ok: false, error: 'invalid_body' });
    expect(normalizeFeedbackSubmission('hello' as never)).toEqual({ ok: false, error: 'invalid_body' });
    expect(normalizeFeedbackSubmission([] as never)).toEqual({ ok: false, error: 'invalid_body' });
  });
});

describe('normalizeFeedbackSubmission — fakedoor interest kind', () => {
  it('allows a whitelisted kind without a message (contact optional)', () => {
    expect(FEEDBACK_KINDS.has('fakedoor_steam_autoreview')).toBe(true);
    expect(normalizeFeedbackSubmission({ kind: 'fakedoor_steam_autoreview' })).toEqual({
      ok: true,
      kind: 'fakedoor_steam_autoreview',
      message: '',
      name: '',
      contact: '',
      matchId: '',
      hero: '',
      insightId: '',
    });
    expect(normalizeFeedbackSubmission({ kind: 'fakedoor_steam_autoreview', contact: ' someone@example.com ' })).toMatchObject({
      ok: true,
      kind: 'fakedoor_steam_autoreview',
      contact: 'someone@example.com',
    });
  });

  it('accepts category as an alias for kind', () => {
    expect(normalizeFeedbackSubmission({ category: 'fakedoor_steam_autoreview' })).toMatchObject({
      ok: true,
      kind: 'fakedoor_steam_autoreview',
    });
  });

  it('keeps an optional message on a kind submission', () => {
    expect(normalizeFeedbackSubmission({
      kind: 'fakedoor_steam_autoreview',
      message: ' auto review please ',
    })).toMatchObject({ ok: true, message: 'auto review please' });
  });

  it('rejects kinds outside the whitelist', () => {
    expect(normalizeFeedbackSubmission({ kind: 'free_form_kind' })).toEqual({ ok: false, error: 'invalid_kind' });
    expect(normalizeFeedbackSubmission({ category: 'something_else' })).toEqual({ ok: false, error: 'invalid_kind' });
  });

  it('does not require or read any QQ-specific or mailto fields', () => {
    const result = normalizeFeedbackSubmission({
      kind: 'fakedoor_steam_autoreview',
      qq: '123456',
      qqGroup: 'ignore me',
      mailto: 'mailto:x@example.com',
    });
    expect(result).toEqual({
      ok: true,
      kind: 'fakedoor_steam_autoreview',
      message: '',
      name: '',
      contact: '',
      matchId: '',
      hero: '',
      insightId: '',
    });
  });
});

describe('normalizeFeedbackSubmission — evidence claim vote', () => {
  it('allows evidence_claim_vote without a message', () => {
    expect(FEEDBACK_KINDS.has('evidence_claim_vote')).toBe(true);
    expect(normalizeFeedbackSubmission({ kind: 'evidence_claim_vote' })).toEqual({
      ok: true,
      kind: 'evidence_claim_vote',
      message: '',
      name: '',
      contact: '',
      matchId: '',
      hero: '',
      insightId: '',
    });
    expect(normalizeFeedbackSubmission({
      kind: 'evidence_claim_vote',
      message: 'y:claim=1',
    })).toMatchObject({ ok: true, kind: 'evidence_claim_vote', message: 'y:claim=1' });
    expect(normalizeFeedbackSubmission({
      kind: 'evidence_claim_vote',
      message: 'y:claim=1:match=9035042364:hero=pudge:insight=turning_point',
      matchId: 9035042364,
      hero: 'pudge',
      insightId: 'turning_point',
    })).toMatchObject({
      ok: true,
      kind: 'evidence_claim_vote',
      matchId: '9035042364',
      hero: 'pudge',
      insightId: 'turning_point',
    });
  });
});
