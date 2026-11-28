// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { FindingFeedback } from './FindingFeedback';
import { ReviewDoc } from './ReviewDoc';
import type { DeepReview } from './api';

/** The reader's word on one finding: three buttons, a reason for the two that are not "right", and what the server is sent. */

let answer: { ok: boolean } | 'offline' = { ok: true };
const calls = () => (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
const sent = () => calls().filter((c) => String(c[0]).includes('/feedback')).map((c) => ({ url: String(c[0]), init: c[1] as RequestInit, body: JSON.parse(String((c[1] as RequestInit).body)) }));
const events = () => calls().filter((c) => String(c[0]).includes('/api/events')).map((c) => JSON.parse(String((c[1] as RequestInit).body)));
const settle = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }); };
const click = async (name: string) => { fireEvent.click(screen.getByRole('button', { name })); await settle(); };
const pressed = () => screen.getAllByRole('button').filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.textContent);
const show = (props: Partial<React.ComponentProps<typeof FindingFeedback>> = {}) => render(<FindingFeedback matchId="7" hero="axe" lang="en" version={37} index={0} title="Roar held" {...props} />);

beforeEach(() => {
  answer = { ok: true };
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (!String(url).includes('/feedback')) return new Response('{}', { status: 200 });
    if (answer === 'offline') throw new TypeError('network');
    return new Response(JSON.stringify(answer.ok ? { status: 'ok' } : { code: 'stale' }), { status: answer.ok ? 200 : 404 });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('FindingFeedback', () => {
  it('asks once, with three answers and none given', () => {
    show();
    const group = screen.getByRole('group', { name: 'Was this right?' });
    expect(within(group).getAllByRole('button').map((b) => [b.textContent, b.getAttribute('aria-pressed')])).toEqual([['Right', 'false'], ['Wrong', 'false'], ['Not useful', 'false']]);
    expect(screen.queryByRole('group', { name: 'What is wrong with it?' })).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('');
    expect(sent()).toHaveLength(0);
  });

  it('"Right" is sent with the finding it is about and an id made here; the button stays pressed and it says so', async () => {
    show({ plan: 'push', model: 'kimi-k3.1-pro', index: 2, title: 'No BKB' });
    await click('Right');
    expect(sent()).toHaveLength(1);
    const { url, init, body } = sent()[0];
    expect(url).toBe('/api/agent/7/feedback');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(body).toEqual({ hero: 'axe', lang: 'en', version: 37, finding: 2, title: 'No BKB', rating: 'right', reason: null, id: expect.stringMatching(/^[a-z0-9]{16}$/), plan: 'push', model: 'kimi-k3.1-pro' });
    expect(pressed()).toEqual(['Right']);
    expect(screen.getByRole('status').textContent).toBe('Noted. Thank you.');
    // No reason is asked of "right".
    expect(screen.queryByRole('group', { name: /wrong|Why not/ })).toBeNull();
    // Counted once, by labels only.
    expect(events().filter((e) => e.event === 'finding_rated').map((e) => e.props)).toEqual([{ matchId: '7', lang: 'en', hero: 'axe', rating: 'right', first: false }]);
    // The default review names neither a plan nor a model.
    cleanup(); localStorage.clear();
    show();
    await click('Right');
    expect(sent().at(-1)!.body).not.toHaveProperty('plan');
    expect(sent().at(-1)!.body).not.toHaveProperty('model');
  });

  it('"Wrong" asks which of three things; the reason goes with the same id, so it replaces the first word', async () => {
    show();
    await click('Wrong');
    const why = screen.getByRole('group', { name: 'What is wrong with it?' });
    expect(within(why).getAllByRole('button').map((b) => b.textContent)).toEqual(['A fact is wrong', 'Facts right, conclusion wrong', 'It was not mine to change']);
    await click('Facts right, conclusion wrong');
    expect(sent().map((s) => [s.body.rating, s.body.reason])).toEqual([['wrong', null], ['wrong', 'judgment']]);
    expect(sent()[1].body.id).toBe(sent()[0].body.id);
    expect(pressed()).toEqual(['Wrong', 'Facts right, conclusion wrong']);
    // One rating, counted once: the reason is not a second one.
    expect(events().filter((e) => e.event === 'finding_rated')).toHaveLength(1);
  });

  it('"Not useful" has its own three reasons; a change of mind drops the old reason and keeps the id', async () => {
    show();
    await click('Not useful');
    expect(within(screen.getByRole('group', { name: 'Why not?' })).getAllByRole('button').map((b) => b.textContent)).toEqual(['I knew this already', 'Too vague to act on', 'Not what decided the game']);
    await click('Too vague to act on');
    await click('Right');
    expect(sent().map((s) => [s.body.rating, s.body.reason])).toEqual([['useless', null], ['useless', 'vague'], ['right', null]]);
    expect(new Set(sent().map((s) => s.body.id)).size).toBe(1);
    expect(pressed()).toEqual(['Right']);
    expect(screen.queryByRole('group', { name: 'Why not?' })).toBeNull();
    // Pressing what is already said sends nothing.
    await click('Right');
    expect(sent()).toHaveLength(3);
  });

  it('not saved — refused or offline: the buttons go back to what the server has, and it says so', async () => {
    answer = { ok: false };
    show();
    await click('Wrong');
    expect(pressed()).toEqual([]);
    expect(screen.getByRole('status').textContent).toBe('That could not be saved. Try again in a moment.');
    expect(screen.queryByRole('group', { name: 'What is wrong with it?' })).toBeNull();
    expect(events().filter((e) => e.event === 'finding_rated')).toHaveLength(0);
    // Saved once, then a change that fails: back to the saved word, not to nothing.
    answer = { ok: true };
    await click('Right');
    answer = 'offline';
    await click('Not useful');
    expect(pressed()).toEqual(['Right']);
    expect(screen.getByRole('status').textContent).toBe('That could not be saved. Try again in a moment.');
  });

  it('the browser remembers what was said of this finding of this review, and of no other', async () => {
    show();
    await click('Wrong');
    await click('A fact is wrong');
    const id = sent()[0].body.id;
    cleanup();
    show();
    expect(pressed()).toEqual(['Wrong', 'A fact is wrong']);
    // Nothing is said again on the way in, and no thanks for a word given another day.
    expect(sent()).toHaveLength(2);
    expect(screen.getByRole('status').textContent).toBe('');
    // A change now still replaces that same record.
    await click('Right');
    expect(sent().at(-1)!.body.id).toBe(id);
    cleanup();
    // Another finding, another language, another model's review, the review written again under a newer prompt
    // (even with the same title), or the same place holding another finding: unanswered.
    for (const other of [{ index: 1 }, { lang: 'zh' as const }, { model: 'kimi-k3.1-pro' }, { plan: 'push' }, { version: 38 }, { title: 'Another finding' }, { matchId: '8' }, { hero: 'lina' }]) {
      show(other);
      expect([other, screen.getAllByRole('button').filter((b) => b.getAttribute('aria-pressed') === 'true')]).toEqual([other, []]);
      cleanup();
    }
  });

  it('works where the browser keeps nothing: the word is still sent', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    try {
      show();
      await click('Right');
      expect(sent()).toHaveLength(1);
      expect(pressed()).toEqual(['Right']);
      expect(screen.getByRole('status').textContent).toBe('Noted. Thank you.');
    } finally { setItem.mockRestore(); getItem.mockRestore(); }
  });

  it('Chinese: the same, in the reader\'s language', async () => {
    show({ lang: 'zh' });
    expect(within(screen.getByRole('group', { name: '这条说得对吗？' })).getAllByRole('button').map((b) => b.textContent)).toEqual(['说得对', '不对', '没用']);
    await click('不对');
    expect(within(screen.getByRole('group', { name: '哪里不对？' })).getAllByRole('button').map((b) => b.textContent)).toEqual(['事实不对', '事实对，结论不对', '这不是我能改的']);
    await click('没用');
    expect(within(screen.getByRole('group', { name: '为什么没用？' })).getAllByRole('button').map((b) => b.textContent)).toEqual(['我早就知道', '太笼统，不知道怎么做', '不是这局的关键']);
    expect(screen.getByRole('status').textContent).toBe('记下了，谢谢。');
  });
});

describe('ReviewDoc: each finding is asked about, in its own place', () => {
  const finding = (n: number, extra: Partial<DeepReview['findings'][number]> = {}) => ({ title: `Finding ${n}`, claim: `Claim ${n}.`, fix: `Fix ${n}.`, evidence: [{ refs: [`death:axe:${n}`], clock: `${n}0:00`, fact: `Fact ${n}.` }], ...extra });
  const review = (findings = [finding(1), finding(2), finding(3)]): DeepReview => ({ schema: 'dota2.ai/deep-review@1', match_id: 7, hero: 'axe', lang: 'en', verdict: 'V.', highlights: [{ title: 'Great play', detail: 'Nice move.' }], findings, chapters: [], blind_spots: [] });
  const doc = (r: DeepReview, feedback: React.ComponentProps<typeof ReviewDoc>['feedback']) => render(<ReviewDoc matchId="7" review={r} lang="en" onAsk={() => {}} feedback={feedback} />);

  it('one question per finding: lead finding expanded and secondary findings folded under .ag-improvements; each sends its own place', async () => {
    doc(review(), { plan: null, model: 'deepseek-flash', version: 82 });
    const groups = screen.getAllByRole('group', { name: 'Was this right?', hidden: true });
    expect(groups).toHaveLength(3);
    expect(groups[0].closest('section')!.className).toBe('ag-improvements');
    expect(groups[0].closest('article')!.className).toContain('ag-finding is-lead');
    expect(groups.slice(1).map((g) => g.closest('details')!.querySelector('summary')!.textContent)).toEqual(['2Finding 2', '3Finding 3']);
    fireEvent.click(within(groups[2]).getByRole('button', { name: 'Not useful', hidden: true }));
    await settle();
    expect(sent().map((s) => [s.body.finding, s.body.title, s.body.rating, s.body.version, s.body.model])).toEqual([[2, 'Finding 3', 'useless', 82, 'deepseek-flash']]);
    fireEvent.click(within(groups[0]).getByRole('button', { name: 'Right' }));
    await settle();
    expect(sent().at(-1)!.body).toMatchObject({ finding: 0, title: 'Finding 1', rating: 'right' });
    expect(events().filter((e) => e.event === 'finding_rated').map((e) => e.props.first)).toEqual([false, true]);
  });

  it('a lead finding without evidence or fix still gets its feedback control inside .ag-finding.is-lead', () => {
    doc(review([finding(1, { evidence: [], fix: '' })]), { version: 82 });
    expect(screen.getByRole('group', { name: 'Was this right?' }).closest('article')!.className).toContain('ag-finding is-lead');
  });

  it('not asked where the page did not say which review this is, nor of a review with no finding', () => {
    doc(review(), null);
    expect(screen.queryByRole('group', { name: 'Was this right?', hidden: true })).toBeNull();
    cleanup();
    doc(review([]), { version: 82 });
    expect(screen.queryByRole('group', { name: 'Was this right?', hidden: true })).toBeNull();
  });
});
