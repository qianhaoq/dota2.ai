import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { goalFromReview } from '../../lib/agent/goal.js';
import { evaluateGoal } from '../../lib/coach/goals.js';
import { runDeepReview } from '../../lib/agent/deepReview.js';

const trace = JSON.parse(gunzipSync(readFileSync(new URL('../../packages/review-engine/test/fixtures/trace-9100904020.json.gz', import.meta.url))).toString());
const from = (pick: any, findings = 3) => goalFromReview(pick, { trace, hero: 'beastmaster', findings });

describe('goalFromReview', () => {
  it('hold_item: only items pros build on this hero that the player never held; code writes the label', () => {
    expect(from({ kind: 'hold_item', items: ['blink', 'item_black_king_bar', 'ultimate_scepter', 'divine_rapier', 'blink'], finding: 2 })).toEqual({
      finding: 2,
      spec: { kind: 'hold_item', items: ['blink', 'black_king_bar'], hero_id: 38, label: { en: 'On Beastmaster: finish with Blink Dagger or Black King Bar', zh: '用兽王时：出一件闪烁匕首或黑皇杖' } },
    });
    // Held this game (Aghanim's at 16:48), or not something pros build here: no goal rather than a made-up one.
    expect(from({ kind: 'hold_item', items: ['ultimate_scepter', 'divine_rapier'], finding: 1 })).toBeNull();
    expect(from({ kind: 'hold_item', finding: 1 })).toBeNull();
  });
  it('fewer_deaths: a third fewer per ten minutes than this game, from the replay', () => {
    // 11 deaths in 42:31 = 2.59 per 10 min → 1.7
    expect(from({ kind: 'fewer_deaths', finding: 3 })).toEqual({ finding: 3, spec: { kind: 'deaths_per10_max', max: 1.7, label: { en: 'At most 1.7 deaths per 10 minutes', zh: '每 10 分钟死亡不超过 1.7 次' } } });
  });
  it('refuses a goal without a real finding, an unknown kind, or an unknown hero', () => {
    for (const bad of [null, 'x', { kind: 'hold_item', items: ['blink'] }, { kind: 'hold_item', items: ['blink'], finding: 4 }, { kind: 'hold_item', items: ['blink'], finding: 0 }, { kind: 'win_more', finding: 1 }]) expect(from(bad)).toBeNull();
    expect(goalFromReview({ kind: 'fewer_deaths', finding: 1 }, { trace, hero: 'pudge', findings: 1 })).toBeNull();
  });
});

describe('evaluateGoal: hold_item', () => {
  const goal = from({ kind: 'hold_item', items: ['blink', 'black_king_bar'], finding: 1 })!.spec;
  const game = (heroId: number, items: any) => ({ match: { duration: 2400 }, players: [{ hero: { id: heroId }, items }], reviews: [{ role: { kind: 'core' } }] });
  it('met with one of the items, missed without, and never on a guess', () => {
    expect(evaluateGoal(goal, game(38, [{ key: 'arcane_boots', en: 'Arcane Boots', zh: '奥术鞋' }, { key: 'blink', en: 'Blink Dagger', zh: '闪烁匕首' }]), 0)).toEqual({ result: 'met', evidence: { en: 'Finished with Blink Dagger', zh: '终局装备里有闪烁匕首' } });
    expect(evaluateGoal(goal, game(38, [{ key: 'pipe', en: 'Pipe', zh: '烟斗' }]), 0)).toMatchObject({ result: 'missed' });
    expect(evaluateGoal(goal, game(2, [{ key: 'blink', en: 'Blink Dagger', zh: '闪烁匕首' }]), 0)).toMatchObject({ result: 'no_opportunity', evidence: { zh: '这局你玩的是别的英雄。' } });
    expect(evaluateGoal(goal, game(38, undefined), 0)).toMatchObject({ result: 'unknown' });
  });
});

describe('the review carries its goal', () => {
  const call = (name: string, args: any, id: string) => ({ id, name, args });
  const finding = (title: string) => ({ title, claim: 'c', evidence: [{ refs: ['pro_items:beastmaster'], fact: 'x' }], fix: 'f' });
  const model = (submit: any) => { let i = 0; const replies = [{ toolCalls: [call('pro_item_choices', { hero: 'beastmaster' }, 'p')] }, { toolCalls: [call('submit_review', submit, 's')] }]; return async () => replies[Math.min(i++, 1)]; };
  const base = { verdict: 'v', mainline: [], next_game: ['n'], blind_spots: [] };

  it('a valid pick becomes review.goal, tied to its finding', async () => {
    const r: any = await runDeepReview({ complete: model({ ...base, findings: [finding('a'), finding('build')], goal: { kind: 'hold_item', items: ['blink', 'black_king_bar'], finding: 2 } }), trace, hero: 'beastmaster', lang: 'zh' });
    expect(r.review.goal).toEqual({ kind: 'hold_item', items: ['blink', 'black_king_bar'], hero_id: 38, label: { en: 'On Beastmaster: finish with Blink Dagger or Black King Bar', zh: '用兽王时：出一件闪烁匕首或黑皇杖' }, finding: 2 });
  });
  it('a goal follows its finding: dropped with it, renumbered when an earlier one is dropped', async () => {
    const invented = { title: 'x', claim: '19:19 崩了', evidence: [{ refs: ['pro_items:beastmaster'], fact: 'x' }], fix: 'f' };
    const moved: any = await runDeepReview({ complete: model({ ...base, findings: [invented, finding('build')], goal: { kind: 'fewer_deaths', finding: 2 } }), trace, hero: 'beastmaster' });
    expect(moved.review.findings.map((f: any) => f.title)).toEqual(['build']);
    expect(moved.review.goal).toMatchObject({ kind: 'deaths_per10_max', finding: 1 });
    const gone: any = await runDeepReview({ complete: model({ ...base, findings: [invented, finding('build')], goal: { kind: 'fewer_deaths', finding: 1 } }), trace, hero: 'beastmaster' });
    expect(gone.review).not.toHaveProperty('goal');
    const none: any = await runDeepReview({ complete: model({ ...base, findings: [finding('a')], goal: { kind: 'hold_item', items: ['divine_rapier'], finding: 1 } }), trace, hero: 'beastmaster' });
    expect(none.review).not.toHaveProperty('goal');
  });
});
