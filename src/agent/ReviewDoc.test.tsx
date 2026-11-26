// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { ReviewDoc } from './ReviewDoc';
import type { DeepReview } from './api';

/** The review as a document: one lesson first, the rest folded under it, the whole game after. */

const finding = (n: number, extra: Partial<DeepReview['findings'][number]> = {}) => ({
  title: `Finding ${n}`, claim: `Claim ${n}.`, fix: `Fix ${n}.`,
  evidence: [{ refs: [`death:axe:${n}`], clock: `${n}0:00`, fact: `Fact ${n}.` }],
  rule: { when: `When ${n}`, do: `Do ${n}`, this_game: `Seen ${n} times.` },
  ...extra,
});
const review = (extra: Partial<DeepReview> = {}): DeepReview => ({
  schema: 'dota2.ai/deep-review@1', match_id: 7, hero: 'axe', lang: 'en',
  verdict: 'The whole game in one sentence.', mainline: ['0:00–10:00: the lane.', '10:00–20:00: the map.'],
  findings: [finding(1), finding(2), finding(3)], did_well: ['Last hits.'], next_game: ['When 1: Do 1'], blind_spots: ['Creep positions.'],
  ...extra,
} as DeepReview);
const show = (r: DeepReview, props: Partial<React.ComponentProps<typeof ReviewDoc>> = {}) => render(<ReviewDoc matchId="7" review={r} lang="en" onAsk={() => {}} {...props} />);

beforeEach(() => { vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 'not_found' }), { status: 404 }))); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('ReviewDoc: one lesson first', () => {
  it('the first finding is the headline, with its claim, its rule and its moments', () => {
    show(review());
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Finding 1');
    expect(document.querySelector('.ag-lead .cx-eyebrow')!.textContent).toBe('The one thing to change');
    expect(document.querySelector('.ag-lead-claim')!.textContent).toBe('Claim 1.');
    const lesson = within(screen.getByRole('heading', { level: 2, name: 'Practise this next game' }).closest('section')!);
    expect(lesson.getByText('When 1')).toBeTruthy();
    expect(lesson.getByText('Do 1')).toBeTruthy();
    expect(lesson.getByText('Seen 1 times.')).toBeTruthy();
    expect(lesson.getByText('Fix 1.')).toBeTruthy();
    const moments = within(screen.getByRole('heading', { level: 2, name: 'The moments that show it' }).closest('section')!);
    expect(moments.getByText('Fact 1.')).toBeTruthy();
    // Only the first finding's: the others keep theirs.
    expect(moments.queryByText('Fact 2.')).toBeNull();
  });

  it('the other findings fold under it, numbered from 2, each whole', () => {
    show(review());
    const more = screen.getByRole('heading', { level: 2, name: 'Two more things' }).closest('section')!;
    const folds = Array.from(more.querySelectorAll('details.ag-finding')) as HTMLDetailsElement[];
    expect(folds.map((d) => d.querySelector('summary')!.textContent)).toEqual(['2Finding 2', '3Finding 3']);
    expect(folds.every((d) => !d.open)).toBe(true);
    const second = within(folds[0]);
    expect(second.getByText('Claim 2.')).toBeTruthy();
    expect(second.getByText('Fact 2.')).toBeTruthy();
    expect(second.getByText('When 2')).toBeTruthy();
    expect(second.getByText('Fix 2.')).toBeTruthy();
    // The first finding is not repeated among them.
    expect(more.textContent).not.toContain('Finding 1');
  });

  it('says "one more thing" for two findings, and nothing more for one', () => {
    show(review({ findings: [finding(1), finding(2)] }));
    expect(screen.getByRole('heading', { level: 2, name: 'One more thing' })).toBeTruthy();
    cleanup();
    show(review({ findings: [finding(1)] }));
    expect(screen.queryByRole('heading', { level: 2, name: /more thing/ })).toBeNull();
    expect(document.querySelectorAll('details.ag-finding')).toHaveLength(0);
  });

  it('a first finding without a rule still gives its fix as what to practise; without either there is no lesson block', () => {
    show(review({ findings: [finding(1, { rule: undefined })] }));
    const lesson = screen.getByRole('heading', { level: 2, name: 'Practise this next game' }).closest('section')!;
    expect(lesson.textContent).toContain('Fix 1.');
    expect(lesson.querySelector('.ag-rule')).toBeNull();
    cleanup();
    show(review({ findings: [finding(1, { rule: undefined, fix: '' })] }));
    expect(screen.queryByRole('heading', { level: 2, name: 'Practise this next game' })).toBeNull();
  });

  it('the sentence about the whole game stands with the whole game, after the findings; the story folds', () => {
    show(review(), { board: <div role="region" aria-label="Scoreboard">board</div>, share: <div data-testid="share">share</div> });
    const whole = screen.getByRole('heading', { level: 2, name: 'The whole game' }).closest('section')!;
    expect(whole.querySelector('.ag-verdict')!.textContent).toBe('The game in one sentenceThe whole game in one sentence.');
    const folds = Array.from(whole.querySelectorAll('details.ag-fold')) as HTMLDetailsElement[];
    expect(folds.map((d) => d.querySelector('summary h3')!.textContent)).toEqual(['How the game went', 'Line-ups and scoreboard']);
    expect(folds[0].querySelector('summary')!.textContent).toBe('How the game went2 parts');
    expect(folds.every((d) => !d.open)).toBe(true);
    expect(within(folds[1]).getByRole('region', { name: 'Scoreboard' })).toBeTruthy();
    // Order down the page: the lesson, the other findings, what went well, sharing, the whole game, what could not be seen.
    const order = ['Practise this next game', 'The moments that show it', 'Two more things', 'What you did well', 'The whole game', 'What the replay could not show'];
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(order);
    const share = screen.getByTestId('share');
    expect(screen.getByRole('heading', { level: 2, name: 'What you did well' }).compareDocumentPosition(share) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(share.compareDocumentPosition(whole) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('the list that repeated the rules is gone: each rule is read with its finding', () => {
    show(review());
    expect(document.querySelector('.ag-next')).toBeNull();
    expect(screen.queryByText('When 1: Do 1')).toBeNull();
  });

  it('a review left with no finding leads with the sentence about the game, said once', () => {
    show(review({ findings: [] }));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('The whole game in one sentence.');
    expect(document.querySelector('.ag-lead .cx-eyebrow')!.textContent).toBe('The game in one sentence');
    expect(document.querySelector('.ag-verdict')).toBeNull();
    expect(screen.queryByRole('heading', { level: 2, name: 'Practise this next game' })).toBeNull();
  });

  it('the patch the numbers are from stays with the headline, and a patch that could not be told is still a note', () => {
    show(review({ data_patch: { name: '7.42', exact: true, known_from: 'start_time' } } as Partial<DeepReview>));
    expect(document.querySelector('.ag-lead .ag-patch')!.textContent).toContain('7.42');
    cleanup();
    show(review({ data_patch: { name: '7.42', exact: false, reason: 'not_known' } } as Partial<DeepReview>));
    expect(within(document.querySelector('.ag-lead') as HTMLElement).getByRole('note').textContent).toContain('could not be told');
  });

  it('Chinese: the same structure in the reader\'s language', () => {
    render(<ReviewDoc matchId="7" review={review({ lang: 'zh' })} lang="zh" onAsk={() => {}} />);
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(['下局只练这一件', '这局的几个时刻', '还有两件事', '做得好的', '整局', '录像看不到的']);
    expect(document.querySelector('.ag-lead .cx-eyebrow')!.textContent).toBe('这局最该改的一件事');
    expect(document.querySelector('details.ag-fold summary')!.textContent).toBe('对局主线2 段');
  });
});

describe('ReviewDoc: the goal card says whether readers reach it', () => {
  const beacons: Promise<any>[] = [];
  const read = (b: Blob) => new Promise<string>((resolve) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.readAsText(b); });
  let fire: ((entries: { isIntersecting: boolean; intersectionRatio: number }[]) => void) | null = null;
  beforeEach(() => {
    beacons.length = 0; window.sessionStorage.clear();
    (navigator as any).sendBeacon = (_u: string, b: Blob) => { beacons.push(read(b).then((t) => JSON.parse(t))); return true; };
    vi.stubGlobal('IntersectionObserver', class { constructor(cb: any) { fire = cb; } observe() {} disconnect() { fire = null; } });
  });
  const withGoal = (): DeepReview => review({ goal: { kind: 'deaths_per10_max', max: 1.7, label: { en: 'At most 1.7 deaths per 10 minutes', zh: 'x' }, finding: 1 } } as Partial<DeepReview>);
  const events = async () => (await Promise.all(beacons)).map((e) => [e.event, e.props]);

  it('offered when it is shown, seen once it is on screen — once a review, however often it scrolls by', async () => {
    show(withGoal(), { goalContext: { fromStart: 1, accountId: 7, heroId: 2 } });
    expect(await events()).toEqual([['goal_offered', { matchId: '7' }]]);
    fire!([{ isIntersecting: false, intersectionRatio: 0 }]);
    expect(await events()).toHaveLength(1);
    // Barely in view: intersecting, but not 60% of it — not seen yet.
    fire!([{ isIntersecting: true, intersectionRatio: 0.1 }]);
    expect(await events()).toHaveLength(1);
    fire!([{ isIntersecting: true, intersectionRatio: 0.7 }]);
    expect(await events()).toEqual([['goal_offered', { matchId: '7' }], ['goal_seen', { matchId: '7' }]]);
    cleanup();
    // The same review again in this browser session: not counted twice.
    show(withGoal(), { goalContext: { fromStart: 1, accountId: 7, heroId: 2 } });
    fire?.([{ isIntersecting: true, intersectionRatio: 1 }]);
    expect(await events()).toHaveLength(2);
  });

  it('no card, nothing said: a review without a goal, or a page without a seat to set it for', async () => {
    show(review(), { goalContext: { fromStart: 1, accountId: 7, heroId: 2 } });
    show(withGoal(), { goalContext: null });
    expect(await events()).toEqual([]);
  });
});

