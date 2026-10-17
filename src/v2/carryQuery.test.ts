import { describe, it, expect } from 'vitest';
import { buildCarryQuery } from './carryQuery';

describe('buildCarryQuery', () => {
  it('keeps only lang and ff, dropping page-scoped params', () => {
    expect(buildCarryQuery('?hero=pudge&lang=zh&ff=x', 'zh')).toBe('?lang=zh&ff=x');
    expect(buildCarryQuery('?hero=pudge&claim=a&view=b&ask=c&lang=en', 'en')).toBe('?lang=en');
  });

  it('always uses the current language, not the URL one', () => {
    expect(buildCarryQuery('?lang=zh', 'en')).toBe('?lang=en');
    expect(buildCarryQuery('', 'zh')).toBe('?lang=zh');
  });

  it('omits ff when absent or empty', () => {
    expect(buildCarryQuery('?ff=', 'en')).toBe('?lang=en');
    expect(buildCarryQuery('?hero=pudge', 'en')).toBe('?lang=en');
  });
});
