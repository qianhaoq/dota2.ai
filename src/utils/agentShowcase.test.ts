import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SHOWCASE_REVIEWS, warmShowcase } from '../../lib/agent/showcase.js';

type Call = [string, string, string];

function fakeService(states: Record<string, string>, { throwOn }: { throwOn?: string } = {}) {
  const started: Call[] = [];
  return {
    started,
    status: async (matchId: string, hero: string, lang: string) => {
      if (`${matchId}.${lang}` === throwOn) throw new TypeError('store down');
      return { status: states[`${matchId}.${lang}`] ?? 'none' };
    },
    start: async (matchId: string, hero: string, lang: string) => { started.push([matchId, hero, lang]); return { status: 'running' }; },
  };
}

describe('showcase reviews are made before a visitor opens them', () => {
  it('starts only the ones this prompt version has none of', async () => {
    const svc = fakeService({ '9091400302.en': 'ready', '9100904020.en': 'none' });
    const out = await warmShowcase(svc);
    expect(out).toEqual(['ready', 'started:running']);
    expect(svc.started).toEqual([['9100904020', 'beastmaster', 'en']]);
  });

  it('leaves a review that just failed, or has no trace, alone', async () => {
    const svc = fakeService({ '9091400302.en': 'failed', '9100904020.en': 'no_trace' });
    expect(await warmShowcase(svc)).toEqual(['failed', 'no_trace']);
    expect(svc.started).toEqual([]);
  });

  it('one that cannot be read does not stop the rest, and nothing throws', async () => {
    const logs: string[] = [];
    const svc = fakeService({}, { throwOn: '9091400302.en' });
    const out = await warmShowcase(svc, { log: (m: string) => logs.push(m) });
    expect(out).toEqual(['error:TypeError', 'started:running']);
    expect(svc.started).toHaveLength(1);
    expect(logs).toContain('showcase match=9091400302 hero=tidehunter lang=en -> error:TypeError');
  });

  it('covers the matches the home page and the agent one-liner send people to (one run warms en/zh/ru)', () => {
    const app = readFileSync(new URL('../coach/CoachApp.tsx', import.meta.url), 'utf8');
    const snippets = readFileSync(new URL('../coach/accessSnippets.ts', import.meta.url), 'utf8');
    const example = app.match(/const EXAMPLE_MATCH = '(\d+)'/)?.[1];
    const oneLiner = snippets.match(/复盘我的 Dota 2 比赛 (\d+)/)?.[1];
    const ids = new Set(SHOWCASE_REVIEWS.map((r: { matchId: string }) => r.matchId));
    expect(example && ids.has(example)).toBe(true);
    expect(oneLiner && ids.has(oneLiner)).toBe(true);
    for (const id of ids) {
      expect(SHOWCASE_REVIEWS.filter((r: { matchId: string }) => r.matchId === id)).toHaveLength(1);
    }
  });
});
