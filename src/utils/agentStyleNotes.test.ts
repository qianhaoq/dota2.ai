import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { DEEP_REVIEW_PROMPT_VERSION, deepReviewSystem, englishWords, runDeepReview, sentenceFacts, verifyReview, NUMBERS_PER_SENTENCE } from '../../lib/agent/deepReview.js';
import { DENSE_ASKED } from '../../lib/agent/review/verify.js';
import { styleOf } from '../../lib/agent/evalReview.js';
import { runTraceTool } from '../../packages/review-engine/src/trace/index.js';

/** How a review reads: English words left in a Chinese review, and sentences carrying more numbers than a reader keeps. */

const trace = JSON.parse(gunzipSync(readFileSync(new URL('../../packages/review-engine/test/fixtures/trace-9100904020.json.gz', import.meta.url))).toString());
const lane = runTraceTool(trace, 'death_context', { hero: 'beastmaster', index: 1 }, { perspective: 'beastmaster' }) as any;
const finding = (extra: any = {}) => ({ title: '对线期的阵亡', claim: '你在对线期阵亡。', evidence: [{ refs: ['death:beastmaster:1'], fact: '对线期阵亡。' }], fix: '退到塔后。', ...extra });
const review = (extra: any = {}) => ({ verdict: '对线期送了。', mainline: [], findings: [finding()], blind_spots: [], ...extra });
const notes = (r: any, kind: string) => verifyReview(r, [lane]).problems.filter((p: any) => p.kind === kind);

describe('englishWords', () => {
  it('finds English words of three letters or more, and leaves what players write the same in any language', () => {
    expect(englishWords('这条线是 lost，对位 typical，打完 Roshan 拿了 Aegis。')).toEqual(['lost', 'typical', 'Roshan', 'Aegis']);
    // Abbreviations (BKB, TP, GPM) and names that are the same in Chinese are not leaks.
    expect(englishWords('没有 BKB，TP 也没带，GPM 落后；数据来自 OpenDota 和 STRATZ，Valve 的 Dota。')).toEqual([]);
    expect(englishWords('原始咆哮穿过了黑皇杖。')).toEqual([]);
    // A name the site itself writes with Latin letters in Chinese is the name.
    expect(englishWords('Eul的神圣法杖没出。')).toEqual([]);
    // An ability's English description quoted whole.
    expect(englishWords('它的效果是 Prevents target from attacking for 3 seconds。')).toEqual(['Prevents', 'target', 'from', 'attacking', 'for', 'seconds']);
    for (const not of [null, undefined, 7, {}]) expect(englishWords(not as any)).toEqual([]);
  });
});

describe('sentenceFacts', () => {
  it('counts the times and numbers each sentence states', () => {
    expect(sentenceFacts('你 11 次死亡里 7 次死在她手上，44% 的伤害是她的普攻。之后没有再出装备。30:26 那场你到了。')).toEqual([
      { sentence: '你 11 次死亡里 7 次死在她手上，44% 的伤害是她的普攻。', facts: 3 },
      { sentence: '之后没有再出装备。', facts: 0 },
      { sentence: '30:26 那场你到了。', facts: 1 },
    ]);
    expect(NUMBERS_PER_SENTENCE).toBe(2);
    expect(sentenceFacts('')).toEqual([]);
    expect(sentenceFacts(undefined as any)).toEqual([]);
  });
});

describe('the check asks once about how a review reads', () => {
  it('names the English words left in a Chinese review, wherever they stand, and removes nothing for them', () => {
    const r = review({
      verdict: '这条线是 lost。',
      mainline: ['打完 Roshan 之后没有推进。'],
      blind_spots: ['Roshan 的视野看不到。'],
      findings: [finding({ claim: '这组对位算 favoured。', evidence: [{ refs: ['death:beastmaster:1'], fact: '效果是 Prevents target from attacking。' }], rule: { when: '血量不到一半', do: '退到塔后', this_game: '这局是 typical 的。' } })],
    });
    expect(notes(r, 'english').map((p: any) => [p.where, p.index, p.text])).toEqual([
      ['verdict', 0, 'lost'], ['mainline', 0, 'Roshan'], ['blind_spots', 0, 'Roshan'], ['finding', 0, 'favoured, typical, Prevents, target, from, attacking'],
    ]);
    const check = verifyReview(r, [lane]);
    expect(check.problems.filter((p: any) => p.kind === 'english').every((p: any) => p.soft === true)).toBe(true);
    expect(check.unsupported.findings.size).toBe(0);
    expect(check.ok).toBe(false);
    // A review written in English is not a Chinese review with English in it.
    expect(notes({ verdict: 'The lane was lost.', mainline: [], findings: [finding({ title: 'Lane deaths', claim: 'You died in the lane.', fix: 'Back off.', evidence: [{ refs: ['death:beastmaster:1'], fact: 'Died in the lane.' }] })], blind_spots: [] }, 'english')).toEqual([]);
    // Abbreviations are not asked about.
    expect(notes(review({ verdict: '没有 BKB，TP 也没带。' }), 'english')).toEqual([]);
    // Nor what is not prose yet: the keys of this game's heroes and places (the site writes their names in after
    // the check), a tool's own keys and record handles (wording already names those).
    const named = { hero_names: { sven: '斯温', phantom_assassin: '幻影刺客' }, place_names: { river_mid: '河道中路' } };
    const withNames = (r: any) => verifyReview(r, [lane, named]).problems.filter((p: any) => p.kind === 'english');
    expect(withNames(review({ verdict: 'sven 在 river_mid 被 phantom_assassin 杀了。' }))).toEqual([]);
    expect(withNames(review({ verdict: '这次阵亡（death:beastmaster:1）no_ally_within_2200。' }))).toEqual([]);
    // A hero of another game, or a key written as a word of a sentence, is still English in a Chinese review.
    expect(withNames(review({ verdict: 'lion 的打法是 lost。' })).map((p: any) => p.text)).toEqual(['lion, lost']);
    // A whole line in English, where the language check already names it, is named once — by that check.
    const whole = verifyReview(review({ did_well: ['Good farm overall', '补刀是 good 的'] }), [lane]).problems.filter((p: any) => p.where === 'did_well');
    expect(whole.map((p: any) => [p.index, p.kind, p.text])).toEqual([[0, 'language', 'Good farm overall'], [1, 'english', 'good']]);
  });

  it('names a sentence of the verdict or of a claim with more than two times and numbers, with how many', () => {
    const r = review({ verdict: '你 11 次死亡里 7 次死在她手上，44% 的伤害是她的普攻，16% 是技能。', findings: [finding({ claim: '你在 0:47 阵亡。之后 2:51、6:13、8:27 又各死一次。' })] });
    expect(notes(r, 'dense').map((p: any) => [p.where, p.index, p.text])).toEqual([
      ['verdict', 0, '你 11 次死亡里 7 次死在她手上，44% 的伤害是她的普攻，16% 是技能。 (4)'],
      ['finding', 0, '之后 2:51、6:13、8:27 又各死一次。 (3)'],
    ]);
    expect(notes(r, 'dense').every((p: any) => p.soft === true)).toBe(true);
    // Two is what a reader keeps: not asked about.
    expect(notes(review({ verdict: '你 11 次死亡里 7 次死在她手上。' }), 'dense')).toEqual([]);
    // What a rule says happened this game is a list of counts and times by design, and so are evidence facts.
    expect(notes(review({ findings: [finding({ rule: { when: '血量不到一半', do: '退到塔后', this_game: '4 次：0:47、2:51、6:13、8:27。' }, evidence: [{ refs: ['death:beastmaster:1'], fact: '0:47 血量 531/740，幻影刺客在 356 距离。' }] })] }), 'dense')).toEqual([]);
  });

  it('asks about the densest few only: the repair round is the last one', () => {
    const claim = (n: number) => `这一句有${Array.from({ length: n }, (_, i) => ` ${i + 11} 次`).join('、')}。`;
    const r = review({ verdict: claim(3), findings: [finding({ claim: claim(9) }), finding({ claim: `${claim(4)}${claim(7)}` }), finding({ claim: `${claim(5)}${claim(6)}` })] });
    const asked = notes(r, 'dense');
    expect(DENSE_ASKED).toBe(4);
    expect(asked).toHaveLength(DENSE_ASKED);
    expect(asked.map((p: any) => Number(p.text.match(/\((\d+)\)$/)![1]))).toEqual([9, 7, 6, 5]);
    expect(asked.map((p: any) => [p.where, p.index])).toEqual([['finding', 0], ['finding', 1], ['finding', 2], ['finding', 2]]);
  });

  it('counts what the eval counts: one definition for the score and for the note', () => {
    const r = { lang: 'zh', ...review({ verdict: '这条线是 lost，你 11 次死亡里 7 次死在她手上，44% 是普攻。' }) };
    const s = styleOf({ review: r });
    expect(s.english).toMatchObject({ words: 1, examples: ['lost'] });
    expect(s.top.dense).toBe(1);
    expect(notes(r, 'english')).toHaveLength(1);
    expect(notes(r, 'dense')).toHaveLength(1);
  });
});

describe('the repair round and the prompt', () => {
  it('the repair round is told what to do about each, and a review that still reads that way ships whole', async () => {
    const call = (name: string, args: any, id: string) => ({ id, name, args });
    const said = review({ verdict: '这条线是 lost。' });
    const replies = [
      { toolCalls: [call('death_context', { hero: 'beastmaster', index: 1 }, 'b')] },
      { toolCalls: [call('submit_review', said, 's1')] },
      { toolCalls: [call('submit_review', said, 's2')] },
    ];
    const seen: any[] = []; let i = 0;
    const complete = async (o: any) => { seen.push(JSON.parse(JSON.stringify(o))); return replies[Math.min(i++, replies.length - 1)]; };
    const out: any = await runDeepReview({ complete, trace, hero: 'beastmaster', lang: 'zh' });
    const repair = JSON.parse(seen[2].messages.at(-1).content);
    expect(repair.problems).toEqual([{ in: 'verdict', text: 'lost', why: expect.stringContaining('these English words stand in a Chinese review') }]);
    expect(repair.problems[0].why).toContain('Roshan is 肉山');
    // 3 investigation/repair turns, and no translation call: a review is written in one language.
    expect(seen).toHaveLength(3);
    expect(out.status).toBe('ok');
    expect(out.review.verdict).toBe('这条线是 lost。');
    expect(out.review.findings).toHaveLength(1);
    expect(out.verification).toMatchObject({ repaired: true, dropped: 0 });
  });

  it('the prompt asks for it in the first place', () => {
    const s = deepReviewSystem('zh');
    expect(s).toContain('keep a sentence there to at most two times or numbers');
    expect(s).toContain('Roshan as 肉山, the Aegis as 不朽盾');
    expect(deepReviewSystem('en')).toContain('keep a sentence there to at most two times or numbers');
    expect(Number.isInteger(DEEP_REVIEW_PROMPT_VERSION)).toBe(true);
  });
});
