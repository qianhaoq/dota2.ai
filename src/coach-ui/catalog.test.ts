import { describe, expect, it } from 'vitest';
import { ACTIONS, CATALOG, CATALOG_ID, COMPONENTS, isKnownAction, isKnownComponent } from './catalog';

describe('coach-ui catalog', () => {
  it('declares the internal catalog id, not the official A2UI protocol', () => {
    expect(CATALOG_ID).toBe('dota-coach-ui/1');
  });

  it('whitelists the nine domain components', () => {
    expect(COMPONENTS.length).toBe(9);
    expect(COMPONENTS).toContain('DecisionFork');
    expect(COMPONENTS).toContain('EvidenceLens');
    expect(COMPONENTS).toContain('PracticeCommit');
  });

  it('rejects unknown components', () => {
    expect(isKnownComponent('RawHtml')).toBe(false);
    expect(isKnownComponent(undefined)).toBe(false);
    expect(isKnownComponent('DecisionFork')).toBe(true);
  });

  it('rejects unknown actions', () => {
    expect(isKnownAction('eval')).toBe(false);
    expect(isKnownAction('save')).toBe(true);
    expect(ACTIONS.length).toBe(7);
  });

  it('documents a fallback for every component', () => {
    for (const component of COMPONENTS) {
      expect(CATALOG[component].fallbackZh.length).toBeGreaterThan(0);
      expect(CATALOG[component].fallbackEn.length).toBeGreaterThan(0);
    }
  });
});
