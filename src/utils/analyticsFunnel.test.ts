import { describe, expect, it } from 'vitest';
import { parseLogText, summarizeFunnel } from '../../lib/analyticsFunnel.js';

const line = (event: string, anonId: string | null, props: Record<string, unknown> = {}, ts = '2026-11-24T01:00:00Z') => ({ type: 'analytics', event, props, anonId, ts });

describe('the review page funnel from event logs', () => {
  it('counts browsers per step, and among those who opened a match page', () => {
    const entries = [
      line('match_opened', 'anon_a'), line('review_requested', 'anon_a'), line('review_refused', 'anon_a', { reason: 'rate' }),
      line('review_requested', 'anon_a'), line('review_viewed', 'anon_a', { own: true }), line('chat_asked', 'anon_a'), line('chat_asked', 'anon_a'),
      line('return_visit', 'anon_a', {}, '2026-11-25T09:00:00Z'),
      line('match_opened', 'anon_b'), line('review_viewed', 'anon_b', { own: false }),
      // Came straight to a review from a link, without a match_opened in the window.
      line('review_viewed', 'anon_c', { own: false }),
      line('match_opened', null),
      { type: 'other', event: 'match_opened', anonId: 'anon_x' },
    ];
    const out = summarizeFunnel(entries);
    expect(out.browsers).toEqual({ opened: 2, requested: 1, refused: 1, viewed: 3, own: 1, asked: 1, returned: 1 });
    expect(out.ofOpened).toEqual({ opened: 2, requested: 1, refused: 1, viewed: 2, own: 1, asked: 1, returned: 1 });
    expect(out.anonymous).toBe(1);
    expect(out.events).toMatchObject({ match_opened: 3, chat_asked: 2, review_viewed: 3 });
    expect(out.days).toEqual(['2026-11-24', '2026-11-25']);
  });

  it('reads gcloud JSON output (entries with jsonPayload) and one object per line', () => {
    const entries = [{ jsonPayload: line('match_opened', 'anon_a') }, { textPayload: 'Server is running' }];
    expect(summarizeFunnel(parseLogText(JSON.stringify(entries))).browsers.opened).toBe(1);
    const ndjson = [JSON.stringify(line('match_opened', 'anon_a')), 'not json', JSON.stringify(line('chat_asked', 'anon_a'))].join('\n');
    expect(summarizeFunnel(parseLogText(ndjson)).browsers).toMatchObject({ opened: 1, asked: 1 });
    expect(parseLogText('')).toEqual([]);
    expect(parseLogText('[broken')).toEqual([]);
  });
});
