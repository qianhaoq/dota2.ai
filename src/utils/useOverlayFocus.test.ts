import { describe, it, expect } from 'vitest';
import { shouldFocusSearchOnOpen } from './useOverlayFocus';

describe('shouldFocusSearchOnOpen', () => {
  it('prefers the search field when matchMedia is unavailable', () => {
    expect(shouldFocusSearchOnOpen()).toBe(true);
  });
});
