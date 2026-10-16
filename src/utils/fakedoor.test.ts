import { describe, it, expect } from 'vitest';
import {
  buildFakedoorSubmission,
  FAKEDOOR_MAX_CONTACT,
  FAKEDOOR_STEAM_AUTOREVIEW_KIND,
} from './fakedoor';

describe('buildFakedoorSubmission', () => {
  it('uses the whitelisted fakedoor_steam_autoreview kind', () => {
    expect(FAKEDOOR_STEAM_AUTOREVIEW_KIND).toBe('fakedoor_steam_autoreview');
    expect(buildFakedoorSubmission('a@b.co').kind).toBe('fakedoor_steam_autoreview');
  });

  it('includes a trimmed contact when provided', () => {
    expect(buildFakedoorSubmission('  user@example.com  ')).toEqual({
      kind: 'fakedoor_steam_autoreview',
      contact: 'user@example.com',
      lang: 'en',
    });
  });

  it('omits the contact field when empty / blank / missing', () => {
    expect(buildFakedoorSubmission()).toEqual({ kind: 'fakedoor_steam_autoreview', lang: 'en' });
    expect(buildFakedoorSubmission(null)).toEqual({ kind: 'fakedoor_steam_autoreview', lang: 'en' });
    expect(buildFakedoorSubmission('   ')).toEqual({ kind: 'fakedoor_steam_autoreview', lang: 'en' });
  });

  it('caps contact at the server field limit', () => {
    const long = `${'a'.repeat(FAKEDOOR_MAX_CONTACT + 50)}@x.co`;
    const submission = buildFakedoorSubmission(long);
    expect(submission.contact).toHaveLength(FAKEDOOR_MAX_CONTACT);
  });

  it('records the UI language (zh vs default en)', () => {
    expect(buildFakedoorSubmission('', 'zh')).toEqual({ kind: 'fakedoor_steam_autoreview', lang: 'zh' });
    expect(buildFakedoorSubmission('x@y.co', 'en').lang).toBe('en');
  });
});
