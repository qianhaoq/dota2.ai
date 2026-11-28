import { describe, expect, it } from 'vitest';
import { applyTranslation, extractTranslatable, parseTranslationJson, translateReview } from '../../lib/agent/review/translate.js';

const baseReview = {
  schema: 'dota2.ai/deep-review@1',
  prompt_version: 43,
  match_id: 9100904020,
  hero: 'beastmaster',
  lang: 'en',
  data_patch: { patch: '7.42', source: 'match' },
  verdict: 'Primal Roar was not saved for Phantom Assassin.',
  mainline: ['30:26 the fight that turned the game.'],
  findings: [
    {
      title: 'Roar on the wrong target',
      claim: 'Phantom Assassin used BKB 7 times and only 27:27 was stopped.',
      evidence: [{ refs: ['cast:beastmaster:primal_roar:6'], clock: '27:27', fact: '27:27 roared into BKB; stunned 3.4 s.' }],
      rule: {
        when: 'Enemy carry still holds BKB',
        do: 'hold Primal Roar for her',
        this_game: 'Only 27:27 stopped her out of 7 BKBs',
        check: { kind: 'replay_habit', habit: 'outnumbered', max: 2, baseline: 5, label: { en: 'e', zh: 'z', ru: 'r' } },
      },
      fix: 'Hold Roar for her.',
    },
  ],
  did_well: ['Aghanim\'s at 16:48.'],
  next_game: ['Enemy carry still holds BKB: hold Primal Roar for her'],
  blind_spots: ['Vision is not in the replay.'],
  game_plan: {
    course: 'You had a lead until 29:00.',
    your_part: 'You fought without BKB.',
    main_reason: 'team_play',
    why: 'Teamfights collapsed.',
    evidence: [{ refs: ['window:beastmaster:2'], clock: '19:00', fact: 'Lead peaked at 25:00.' }],
  },
  goal: { kind: 'hold_item', items: ['blink'], accept: ['blink'], hero_id: 38, finding: 1, label: { en: 'e', zh: 'z', ru: 'r' } },
};

const zhPayload = {
  verdict: '原始咆哮没有留给幻影刺客。',
  mainline: ['30:26 这波团战扭转了局势。'],
  findings: [
    {
      title: '咆哮给错了目标',
      claim: '幻影刺客开了 7 次黑皇杖，只有 27:27 那次被定住。',
      evidence: ['27:27 吼进黑皇杖，定住 3.4 秒。'],
      rule: { when: '对面核心还捏着黑皇杖', do: '把原始咆哮留给她', this_game: '7 次黑皇杖里只有 27:27 定住了她' },
      fix: '把咆哮留给她。',
    },
  ],
  did_well: ['16:48 做出阿哈利姆神杖。'],
  blind_spots: ['录像里没有视野数据。'],
  game_plan: {
    course: '你们在 29:00 前一直领先。',
    your_part: '你在没有黑皇杖时接团。',
    why: '团战溃败。',
    evidence: ['25:00 经济领先达到最高。'],
  },
};

const ruPayload = {
  verdict: 'Primal Roar не приберегли для Phantom Assassin.',
  mainline: ['30:26 — драка, перевернувшая игру.'],
  findings: [
    {
      title: 'Ульт не по приоритетной цели',
      claim: 'Phantom Assassin нажала BKB 7 раз, и только на 27:27 вы её остановили.',
      evidence: ['27:27 ульт сквозь BKB; оглушение 3.4 с.'],
      rule: { when: 'У вражеского кора есть BKB', do: 'держите Primal Roar для неё', this_game: 'Только на 27:27 из 7 BKB её удалось остановить' },
      fix: 'Держите Primal Roar для неё.',
    },
  ],
  did_well: ['Aghanim\'s Scepter к 16:48.'],
  blind_spots: ['В реплее нет данных об обзоре.'],
  game_plan: {
    course: 'Вы вели до 29:00.',
    your_part: 'Вы дрались без BKB.',
    why: 'Драки проигрывались.',
    evidence: ['Пик преимущества пришёлся на 25:00.'],
  },
};

describe('review trilingual translation', () => {
  it('extracts only translatable prose and preserves all structural fields on applyTranslation', () => {
    const extracted = extractTranslatable(baseReview);
    expect(extracted).not.toHaveProperty('goal');
    expect(extracted.findings[0].evidence).toEqual(['27:27 roared into BKB; stunned 3.4 s.']);
    expect(extracted.findings[0].rule).not.toHaveProperty('check');

    const zh = applyTranslation(baseReview, zhPayload, 'zh')!;
    expect(zh.lang).toBe('zh');
    expect(zh.verdict).toBe(zhPayload.verdict);
    expect(zh.findings[0].evidence[0]).toEqual({ refs: ['cast:beastmaster:primal_roar:6'], clock: '27:27', fact: zhPayload.findings[0].evidence[0] });
    expect(zh.findings[0].rule.check).toEqual(baseReview.findings[0].rule.check);
    expect(zh.next_game).toEqual(['对面核心还捏着黑皇杖：把原始咆哮留给她']);
    expect(zh.goal).toEqual(baseReview.goal);
    expect(zh.game_plan.main_reason).toBe('team_play');
    expect(zh.game_plan.evidence[0].refs).toEqual(['window:beastmaster:2']);
    expect(zh.data_patch).toEqual(baseReview.data_patch);

    const ru = applyTranslation(baseReview, ruPayload, 'ru')!;
    expect(ru.lang).toBe('ru');
    expect(ru.next_game).toEqual(['У вражеского кора есть BKB: держите Primal Roar для неё']);
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

    // Partial first response -> retries once for only the missing language.
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

    // Provider error -> never throws, returns empty reviews.
    const failed = await translateReview({
      review: baseReview,
      sourceLang: 'en',
      complete: async () => { throw new Error('upstream down'); },
    });
    expect(failed.reviews).toEqual({});
  });

  it('extracts, translates, and strictly fact-checks opening_note, highlights, chapters, and encouragement', () => {
    const coachReview = {
      ...baseReview,
      opening_note: 'You joined 15 fights and kept a lead until 29:00.',
      highlights: [
        {
          title: 'Roar through BKB at 27:27',
          detail: 'You stunned Phantom Assassin for 3.4 s at 27:27.',
          evidence: [{ refs: ['cast:beastmaster:primal_roar:6'], clock: '27:27', fact: '27:27 roared into BKB; stunned 3.4 s.' }],
        },
      ],
      chapters: [
        {
          topic: 'teamfights',
          title: 'Teamfights: strong attendance',
          assessment: 'mixed',
          analysis: 'You joined 15 fights, and 27:27 stopped her for 3.4 s.',
          takeaway: 'Keep Roar ready for her BKB.',
          evidence: [{ refs: ['cast:beastmaster:primal_roar:6'], clock: '27:27', fact: '27:27 roared into BKB; stunned 3.4 s.' }],
        },
      ],
      encouragement: 'Your 27:27 play shows strong instincts.',
    };
    const extracted: any = extractTranslatable(coachReview);
    expect(extracted.opening_note).toBe(coachReview.opening_note);
    expect(extracted.highlights).toEqual([{ title: 'Roar through BKB at 27:27', detail: 'You stunned Phantom Assassin for 3.4 s at 27:27.', evidence: ['27:27 roared into BKB; stunned 3.4 s.'] }]);
    expect(extracted.chapters).toEqual([{ title: 'Teamfights: strong attendance', analysis: 'You joined 15 fights, and 27:27 stopped her for 3.4 s.', takeaway: 'Keep Roar ready for her BKB.', evidence: ['27:27 roared into BKB; stunned 3.4 s.'] }]);
    expect(extracted.encouragement).toBe(coachReview.encouragement);
    // did_well is derived from highlights rather than sent twice.
    expect(extracted).not.toHaveProperty('did_well');

    const zhCoach = {
      ...zhPayload,
      opening_note: '你参加了 15 波团战，并在 29:00 前保持领先。',
      highlights: [{ title: '27:27 隔着黑皇杖吼住她', detail: '27:27 你将幻影刺客定住 3.4 秒。', evidence: ['27:27 吼进黑皇杖，定住 3.4 秒。'] }],
      chapters: [{ title: '团战表现：到场率出色', analysis: '你参加了 15 波团战，27:27 将她定住 3.4 秒。', takeaway: '把咆哮留给她的黑皇杖。', evidence: ['27:27 吼进黑皇杖，定住 3.4 秒。'] }],
      encouragement: '你在 27:27 的操作展现了很强的判断力。',
    };
    const translated: any = applyTranslation(coachReview, zhCoach, 'zh');
    expect(translated).not.toBeNull();
    expect(translated.opening_note).toBe(zhCoach.opening_note);
    expect(translated.highlights[0]).toMatchObject({ title: zhCoach.highlights[0].title, detail: zhCoach.highlights[0].detail, evidence: [{ refs: ['cast:beastmaster:primal_roar:6'], clock: '27:27', fact: zhCoach.highlights[0].evidence[0] }] });
    expect(translated.did_well).toEqual(['27:27 隔着黑皇杖吼住她：27:27 你将幻影刺客定住 3.4 秒。']);
    expect(translated.chapters[0]).toMatchObject({ topic: 'teamfights', assessment: 'mixed', title: zhCoach.chapters[0].title, takeaway: zhCoach.chapters[0].takeaway, evidence: [{ refs: ['cast:beastmaster:primal_roar:6'], clock: '27:27', fact: zhCoach.chapters[0].evidence[0] }] });
    expect(translated.encouragement).toBe(zhCoach.encouragement);

    // Altered number in opening_note, highlight, chapter, or encouragement is rejected.
    expect(applyTranslation(coachReview, { ...zhCoach, opening_note: '你参加了 99 波团战，29:00 前领先。' }, 'zh')).toBeNull();
    expect(applyTranslation(coachReview, { ...zhCoach, highlights: [{ ...zhCoach.highlights[0], detail: '27:27 你将幻影刺客定住 9.9 秒。' }] }, 'zh')).toBeNull();
    expect(applyTranslation(coachReview, { ...zhCoach, chapters: [{ ...zhCoach.chapters[0], analysis: '你参加了 18 波团战，27:27 定住 3.4 秒。' }] }, 'zh')).toBeNull();
    expect(applyTranslation(coachReview, { ...zhCoach, encouragement: '27:27 对面看到了你。' }, 'zh')).toBeNull();
  });
});
