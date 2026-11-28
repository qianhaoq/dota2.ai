import { describe, expect, it } from 'vitest';
import { applyTranslation, extractTranslatable, parseTranslationJson, translateReview } from '../../lib/agent/review/translate.js';

const baseReview = {
  schema: 'dota2.ai/deep-review@1',
  prompt_version: 82,
  match_id: 9100904020,
  hero: 'beastmaster',
  lang: 'en',
  data_patch: { patch: '7.42', source: 'match' },
  verdict: 'Primal Roar was not saved for Phantom Assassin.',
  highlights: [
    {
      title: 'Roar through BKB at 27:27',
      detail: 'You stunned Phantom Assassin for 3.4 s at 27:27.',
      evidence: [{ refs: ['cast:beastmaster:primal_roar:6'], clock: '27:27', fact: '27:27 roared into BKB; stunned 3.4 s.' }],
    },
  ],
  findings: [
    {
      title: 'Roar on the wrong target',
      claim: 'Phantom Assassin used BKB 7 times and only 27:27 was stopped.',
      evidence: [{ refs: ['cast:beastmaster:primal_roar:6'], clock: '27:27', fact: '27:27 roared into BKB; stunned 3.4 s.' }],
      fix: 'Hold Roar for her.',
    },
  ],
  chapters: [
    {
      topic: 'midgame',
      title: 'Midgame fights: high attendance',
      analysis: 'You joined 15 fights, and 27:27 stopped her for 3.4 s.',
      evidence: [{ refs: ['cast:beastmaster:primal_roar:6'], clock: '27:27', fact: '27:27 roared into BKB; stunned 3.4 s.' }],
    },
  ],
  blind_spots: ['Vision is not in the replay.'],
  game_plan: {
    main_reason: 'team_play',
    why: 'Teamfights collapsed after 29:00.',
    evidence: [{ refs: ['window:beastmaster:2'], clock: '19:00', fact: 'Lead peaked at 25:00.' }],
  },
};

const zhPayload = {
  verdict: '原始咆哮没有留给幻影刺客。',
  highlights: [
    {
      title: '27:27 隔着黑皇杖吼住她',
      detail: '27:27 你将幻影刺客定住 3.4 秒。',
      evidence: ['27:27 吼进黑皇杖，定住 3.4 秒。'],
    },
  ],
  findings: [
    {
      title: '咆哮给错了目标',
      claim: '幻影刺客开了 7 次黑皇杖，只有 27:27 那次被定住。',
      evidence: ['27:27 吼进黑皇杖，定住 3.4 秒。'],
      fix: '把咆哮留给她。',
    },
  ],
  chapters: [
    {
      title: '中期打架：到场率出色',
      analysis: '你参加了 15 波团战，27:27 将她定住 3.4 秒。',
      evidence: ['27:27 吼进黑皇杖，定住 3.4 秒。'],
    },
  ],
  blind_spots: ['录像里没有视野数据。'],
  game_plan: {
    why: '29:00 后团战溃败。',
    evidence: ['25:00 经济领先达到最高。'],
  },
};

const ruPayload = {
  verdict: 'Primal Roar не приберегли для Phantom Assassin.',
  highlights: [
    {
      title: 'Primal Roar сквозь BKB на 27:27',
      detail: 'На 27:27 вы оглушили Phantom Assassin на 3.4 с.',
      evidence: ['27:27 ульт сквозь BKB; оглушение 3.4 с.'],
    },
  ],
  findings: [
    {
      title: 'Ульт не по приоритетной цели',
      claim: 'Phantom Assassin нажала BKB 7 раз, и только на 27:27 вы её остановили.',
      evidence: ['27:27 ульт сквозь BKB; оглушение 3.4 с.'],
      fix: 'Держите Primal Roar для неё.',
    },
  ],
  chapters: [
    {
      title: 'Мидгейм: высокая явка в драках',
      analysis: 'Вы были в 15 драках, а на 27:27 остановили её на 3.4 с.',
      evidence: ['27:27 ульт сквозь BKB; оглушение 3.4 с.'],
    },
  ],
  blind_spots: ['В реплее нет данных об обзоре.'],
  game_plan: {
    why: 'После 29:00 драки проигрывались.',
    evidence: ['Пик преимущества пришёлся на 25:00.'],
  },
};

describe('review trilingual translation', () => {
  it('extracts only translatable prose and preserves all structural fields on applyTranslation', () => {
    const extracted = extractTranslatable(baseReview);
    expect(extracted.highlights).toEqual([{ title: 'Roar through BKB at 27:27', detail: 'You stunned Phantom Assassin for 3.4 s at 27:27.', evidence: ['27:27 roared into BKB; stunned 3.4 s.'] }]);
    expect(extracted.findings[0]).toEqual({ title: 'Roar on the wrong target', claim: 'Phantom Assassin used BKB 7 times and only 27:27 was stopped.', evidence: ['27:27 roared into BKB; stunned 3.4 s.'], fix: 'Hold Roar for her.' });
    expect(extracted.chapters).toEqual([{ title: 'Midgame fights: high attendance', analysis: 'You joined 15 fights, and 27:27 stopped her for 3.4 s.', evidence: ['27:27 roared into BKB; stunned 3.4 s.'] }]);

    const zh = applyTranslation(baseReview, zhPayload, 'zh')!;
    expect(zh.lang).toBe('zh');
    expect(zh.verdict).toBe(zhPayload.verdict);
    expect(zh.highlights[0]).toEqual({ title: zhPayload.highlights[0].title, detail: zhPayload.highlights[0].detail, evidence: [{ refs: ['cast:beastmaster:primal_roar:6'], clock: '27:27', fact: zhPayload.highlights[0].evidence[0] }] });
    expect(zh.findings[0].evidence[0]).toEqual({ refs: ['cast:beastmaster:primal_roar:6'], clock: '27:27', fact: zhPayload.findings[0].evidence[0] });
    expect(zh.chapters[0]).toEqual({ topic: 'midgame', title: zhPayload.chapters[0].title, analysis: zhPayload.chapters[0].analysis, evidence: [{ refs: ['cast:beastmaster:primal_roar:6'], clock: '27:27', fact: zhPayload.chapters[0].evidence[0] }] });
    expect(zh.game_plan.main_reason).toBe('team_play');
    expect(zh.game_plan.evidence[0].refs).toEqual(['window:beastmaster:2']);
    expect(zh.data_patch).toEqual(baseReview.data_patch);

    const ru = applyTranslation(baseReview, ruPayload, 'ru')!;
    expect(ru.lang).toBe('ru');
    expect(ru.chapters[0].topic).toBe('midgame');
  });

  it('rejects malformed translations, invented clock times, altered numbers/counts/durations/percentages, and invented vision claims', () => {
    expect(applyTranslation(baseReview, null, 'ru')).toBeNull();
    expect(applyTranslation(baseReview, { ...ruPayload, findings: [] }, 'ru')).toBeNull();
    // Fabricated clock time 19:19 not present in baseReview
    expect(applyTranslation(baseReview, { ...ruPayload, verdict: 'На 19:19 вы проиграли.' }, 'ru')).toBeNull();
    // Vision claim introduced in Russian
    expect(applyTranslation(baseReview, { ...ruPayload, verdict: 'Враг видел вас на линии.' }, 'ru')).toBeNull();
    // Altered count in claim (7 -> 9)
    expect(applyTranslation(baseReview, { ...ruPayload, findings: [{ ...ruPayload.findings[0], claim: 'Phantom Assassin нажала BKB 9 раз на 27:27.' }] }, 'ru')).toBeNull();
    // Altered duration in evidence (3.4 -> 9.4)
    expect(applyTranslation(baseReview, { ...ruPayload, findings: [{ ...ruPayload.findings[0], evidence: ['27:27 ульт сквозь BKB; оглушение 9.4 с.'] }] }, 'ru')).toBeNull();
    // Altered number in highlight or chapter
    expect(applyTranslation(baseReview, { ...zhPayload, highlights: [{ ...zhPayload.highlights[0], detail: '27:27 你将幻影刺客定住 9.9 秒。' }] }, 'zh')).toBeNull();
    expect(applyTranslation(baseReview, { ...zhPayload, chapters: [{ ...zhPayload.chapters[0], analysis: '你参加了 18 波团战，27:27 定住 3.4 秒。' }] }, 'zh')).toBeNull();
    // Codex P1 repro: altering damage value in evidence (300 -> 999999) is rejected
    const dmgBase = { ...baseReview, findings: [{ ...baseReview.findings[0], evidence: [{ refs: ['cast:beastmaster:primal_roar:6'], clock: '10:00', fact: '10:00: 300 damage.' }] }] };
    const dmgOk = { ...ruPayload, findings: [{ ...ruPayload.findings[0], evidence: ['10:00: 300 урона.'] }] };
    const dmgBad = { ...ruPayload, findings: [{ ...ruPayload.findings[0], evidence: ['10:00: 999999 урона.'] }] };
    expect(applyTranslation(dmgBase, dmgOk, 'ru')).not.toBeNull();
    expect(applyTranslation(dmgBase, dmgBad, 'ru')).toBeNull();
    // Altered percentage (71% -> 72% or 71% -> 71)
    const pctBase = { ...baseReview, verdict: '71% of games.' };
    expect(applyTranslation(pctBase, { ...ruPayload, verdict: '71% игр.' }, 'ru')).not.toBeNull();
    expect(applyTranslation(pctBase, { ...ruPayload, verdict: '72% игр.' }, 'ru')).toBeNull();
    expect(applyTranslation(pctBase, { ...ruPayload, verdict: '71 игр.' }, 'ru')).toBeNull();
    // When sources are provided, verifyReview also enforces ref/moment checks.
    expect(applyTranslation(baseReview, ruPayload, 'ru', { sources: [] })).toBeNull();
  });

  it('parses fenced and slightly broken JSON via jsonrepair', () => {
    expect(parseTranslationJson('```json\n{"zh": {"verdict": "ok",},}\n```')).toEqual({ zh: { verdict: 'ok' } });
    expect(parseTranslationJson('not json at all')).toBeNull();
  });

  it('translateReview translates into both remaining languages in one call, retries once if one language is missing, and never throws', async () => {
    let calls = 0;
    const out = await translateReview({
      review: baseReview,
      sourceLang: 'en',
      complete: async () => {
        calls += 1;
        return { text: JSON.stringify({ zh: zhPayload, ru: ruPayload }), usage: { input: 500, output: 400 } };
      },
    });
    expect(calls).toBe(1);
    expect(Object.keys(out.reviews).sort()).toEqual(['ru', 'zh']);
    expect(out.usage).toEqual({
      input: 500,
      output: 400,
      input_uncached: null,
      cache_read: null,
      cache_write: null,
      source: 'provider_usage',
    });

    const asked: string[][] = [];
    const partial = await translateReview({
      review: baseReview,
      sourceLang: 'en',
      complete: async (o: any) => {
        const req = JSON.parse(o.messages[0].content);
        asked.push(Object.keys(req.target_languages));
        return asked.length === 1
          ? { text: JSON.stringify({ zh: zhPayload }), usage: { input: 200, output: 150 } }
          : { text: JSON.stringify({ ru: ruPayload }), usage: { input: 150, output: 120 } };
      },
    });
    expect(asked).toEqual([['zh', 'ru'], ['ru']]);
    expect(Object.keys(partial.reviews).sort()).toEqual(['ru', 'zh']);
    expect(partial.usage).toEqual({
      input: 350,
      output: 270,
      input_uncached: null,
      cache_read: null,
      cache_write: null,
      source: 'provider_usage',
    });

    const failed = await translateReview({
      review: baseReview,
      sourceLang: 'en',
      complete: async () => { throw new Error('upstream down'); },
    });
    expect(failed.reviews).toEqual({});
  });
});
