import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { followUpProvidersAvailable } from '../../lib/matchReview/followUpAvailability.js';

// Follow-ups stream through the same DeepSeek → Gemini chain as cards, so any
// configured provider that survived this request keeps the follow-up UI alive.
describe('followUpProvidersAvailable', () => {
  it('both configured, none failed → available (previous behavior)', () => {
    expect(followUpProvidersAvailable({
      deepseekConfigured: true,
      geminiConfigured: true,
      failedCardProviders: new Set(),
    })).toBe(true);
  });

  it('Gemini-only deployment → available (follow-ups must not require DeepSeek)', () => {
    expect(followUpProvidersAvailable({
      deepseekConfigured: false,
      geminiConfigured: true,
      failedCardProviders: new Set(),
    })).toBe(true);
  });

  it('DeepSeek failed during this request but Gemini is fine → available (cards came from the Gemini fallback)', () => {
    expect(followUpProvidersAvailable({
      deepseekConfigured: true,
      geminiConfigured: true,
      failedCardProviders: new Set(['deepseek']),
    })).toBe(true);
  });

  it('both providers failed → unavailable', () => {
    expect(followUpProvidersAvailable({
      deepseekConfigured: true,
      geminiConfigured: true,
      failedCardProviders: new Set(['deepseek', 'gemini']),
    })).toBe(false);
  });

  it('neither provider configured → unavailable (tolerates a missing failure set)', () => {
    expect(followUpProvidersAvailable({
      deepseekConfigured: false,
      geminiConfigured: false,
      failedCardProviders: new Set(),
    })).toBe(false);
    expect(followUpProvidersAvailable({
      deepseekConfigured: false,
      geminiConfigured: false,
      failedCardProviders: undefined,
    })).toBe(false);
  });

  it('DeepSeek-only deployment: available while it has not failed, unavailable once it has', () => {
    expect(followUpProvidersAvailable({
      deepseekConfigured: true,
      geminiConfigured: false,
      failedCardProviders: new Set(),
    })).toBe(true);
    expect(followUpProvidersAvailable({
      deepseekConfigured: true,
      geminiConfigured: false,
      failedCardProviders: new Set(['deepseek']),
    })).toBe(false);
  });
});

