import { describe, expect, it } from 'vitest';
import { createAgentService } from '../../lib/agent/service.js';
import { DEEP_REVIEW_PROMPT_VERSION } from '../../lib/agent/deepReview.js';

/** A link preview reads a stored review and nothing else: no trace, no job. */
describe('agent service peek', () => {
  const v = DEEP_REVIEW_PROMPT_VERSION;
  const review = (verdict: string) => ({ review: { schema: 'dota2.ai/deep-review@1', verdict, mainline: [], findings: [], blind_spots: [] }, verification: { dropped: 0 } });
  const make = () => {
    const blobs = new Map<string, any>([
      [`9091400302.tidehunter.zh.p${v}.review.json`, review('团战先手太晚。')],
      [`9091400302.tidehunter.en.p${v}.plan-push.review.json`, review('The push came after the fights were lost.')],
      [`9091400302.tidehunter.en.p${v - 1}.review.json`, review('An older prompt.')],
      [`9100904020.beastmaster.p${v}.review.json`, {
        schema: 'dota2.ai/deep-review-bundle@1',
        reviews: {
          en: review('Roar was not held.').review,
          zh: review('咆哮没留。').review,
          ru: review('Рёв не был сохранён.').review,
        },
      }],
    ]);
    const got: string[] = [];
    const traces = { get: async () => { throw new Error('a preview must not load the trace'); } };
    const svc: any = createAgentService({ traces, docs: { get: async (k: string) => { got.push(k); return blobs.get(k) ?? null; }, put: async () => {} }, complete: async () => ({}), model: 'm' });
    return { svc, got };
  };

  it('returns the stored review for that hero, language and plan, of the current prompt only (trilingual bundle + legacy fallback)', async () => {
    const { svc, got } = make();
    // Trilingual bundle hits in one read for en, zh, and ru.
    expect((await svc.peek(9100904020, 'beastmaster', 'ru')).verdict).toBe('Рёв не был сохранён.');
    expect((await svc.peek(9100904020, 'beastmaster', 'en')).verdict).toBe('Roar was not held.');
    // Legacy per-language stored reviews still resolve after checking the bundle key.
    expect((await svc.peek(9091400302, 'tidehunter', 'zh')).verdict).toBe('团战先手太晚。');
    expect((await svc.peek(9091400302, 'tidehunter', 'en', 'push')).verdict).toBe('The push came after the fights were lost.');
    // Without the plan it is another review, and one from an older prompt is not shown.
    expect(await svc.peek(9091400302, 'tidehunter', 'en')).toBeNull();
    expect(got).toEqual([
      `9100904020.beastmaster.p${v}.review.json`,
      `9100904020.beastmaster.p${v}.review.json`,
      `9091400302.tidehunter.p${v}.review.json`,
      `9091400302.tidehunter.zh.p${v}.review.json`,
      `9091400302.tidehunter.p${v}.plan-push.review.json`,
      `9091400302.tidehunter.en.p${v}.plan-push.review.json`,
      `9091400302.tidehunter.p${v}.review.json`,
      `9091400302.tidehunter.en.p${v}.review.json`,
    ]);
  });

  it('reads nothing for a key that is not a hero, a language or a match id', async () => {
    const { svc, got } = make();
    for (const [m, h, l] of [[9091400302, '../x', 'zh'], [9091400302, 'tidehunter', 'fr'], ['1/2', 'tidehunter', 'zh'], [9091400302, '', 'en']]) {
      expect(await svc.peek(m, h, l)).toBeNull();
    }
    expect(got).toEqual([]);
  });

  it('a store that fails is no review, not an error', async () => {
    const svc: any = createAgentService({ traces: { get: async () => null }, docs: { get: async () => { throw new Error('gcs down'); }, put: async () => {} }, complete: async () => ({}), model: 'm' });
    expect(await svc.peek(9091400302, 'tidehunter', 'zh')).toBeNull();
  });
});
