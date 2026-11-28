import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BETTER, RUBRIC_SCHEMA, coachOf, compareSummaries, logicOf, reviewTexts, rubricOf, scoreReview, stabilityOf, styleOf, summarize } from '../../lib/agent/evalReview.js';
import { evaluate, expandStoredEntries, loadRubrics, parseArgs, parseName } from '../../scripts/eval-review.mjs';

const json = (file: string) => JSON.parse(readFileSync(new URL(file, import.meta.url), 'utf8'));
/** A review the site stored (prompt 33, Chinese), as it was served. */
const stored = json('../fixtures/agent/review-9100904020.beastmaster.zh.p33.json');
const rubric = json('../../evals/reviews/9100904020.beastmaster.json');
const baseline = json('../../data/eval-baseline.v1.json');

const finding = (over: Record<string, unknown> = {}) => ({
  title: 'Died alone', claim: 'Four deaths had no ally near.', fix: 'Stay with the team.',
  evidence: [{ refs: ['death:axe:2'], clock: '12:10', fact: '12:10: no ally within 2200.' }],
  rule: { when: 'No ally is near on the minimap', do: 'Walk back to the tower', this_game: '4 of the 9 deaths: 12:10, 18:02, 25:40, 31:15.' },
  ...over,
});
const review = (over: Record<string, unknown> = {}) => ({ schema: 'dota2.ai/deep-review@1', lang: 'en', verdict: 'You died alone four times.', mainline: [], findings: [finding()], did_well: [], blind_spots: [], ...over });

describe('review eval: style', () => {
  it('reads the stored review: verdict length, dense sentences, English words left in Chinese', () => {
    const s = styleOf(stored);
    expect(s.verdict_chars).toBe(82);
    expect(s.chars).toBe(4635);
    expect(s.top).toEqual({ sentences: 29, dense: 8, most: 6, mean: 1.3 });
    expect(s.all.most).toBe(13);
    expect(s.english).toEqual({ words: 38, texts: 6, examples: ['lost', 'matchup', 'favoured', 'Disarm', 'Prevents', 'target', 'from', 'attacking'] });
  });

  it('a sentence is dense from the third time or number on', () => {
    const two = styleOf(review({ verdict: 'You died at 12:10 and 18:02.', findings: [] }));
    const three = styleOf(review({ verdict: 'You died at 12:10, 18:02 and 25:40.', findings: [] }));
    expect(two.top).toEqual({ sentences: 1, dense: 0, most: 2, mean: 2 });
    expect(three.top).toEqual({ sentences: 1, dense: 1, most: 3, mean: 3 });
  });

  it('English words are a leak only in a review written in Chinese; abbreviations and proper names are not counted', () => {
    expect(styleOf(review()).english).toBeNull();
    const zh = styleOf(review({ lang: 'zh', verdict: '这条线判为 lost，Valve 数据里 BKB 可用，TP 没用。', findings: [] }));
    expect(zh.english).toEqual({ words: 1, texts: 1, examples: ['lost'] });
    expect(styleOf(review({ lang: 'zh', verdict: '你在 12:10 独自阵亡。', findings: [] })).english).toEqual({ words: 0, texts: 0, examples: [] });
  });

  it('every piece of prose is read once, with its layer', () => {
    const texts = reviewTexts(review({ mainline: ['0:00–10:00: the lane.'], game_plan: { course: 'They took the map.', why: 'Not on you.', evidence: [{ refs: ['tempo:axe'], fact: 'Four buildings.' }] }, did_well: ['Last hits.'], blind_spots: ['No vision data.'] }));
    expect(texts.map((t) => `${t.where}/${t.layer}`)).toEqual(['verdict/top', 'title/top', 'claim/top', 'fix/top', 'rule/top', 'rule/top', 'rule/top', 'evidence/evidence', 'mainline/story', 'plan/story', 'plan/story', 'plan_evidence/evidence', 'did_well/story', 'blind_spots/story']);
  });
});

describe('review eval: logic', () => {
  it('the stored review: a rule that says its own situation came up once, and a matchup called both ways', () => {
    const l = logicOf(stored);
    expect(l.findings).toBe(3);
    expect(l.rules).toEqual([
      { has_rule: true, support: 5, thin: false, says_only_once: true },
      { has_rule: true, support: 3, thin: false, says_only_once: false },
      { has_rule: true, support: 3, thin: false, says_only_once: false },
    ]);
    expect(l.thin_rules).toBe(0);
    expect(l.rules_that_say_only_once).toBe(1);
    expect(l.matchup_both_ways?.favoured).toContain('这个对位还是你占优的');
    expect(l.matchup_both_ways?.unfavoured).toContain('劣势对位');
  });

  it('a rule rests on the moments it names, or on the count its check was made from', () => {
    const one = logicOf(review({ findings: [finding({ rule: { when: 'a', do: 'b', this_game: 'Once, at 12:10.' } })] }));
    expect(one.rules[0]).toEqual({ has_rule: true, support: 1, thin: true, says_only_once: false });
    const counted = logicOf(review({ findings: [finding({ rule: { when: 'a', do: 'b', check: { kind: 'replay_habit', baseline: 3 } } })] }));
    expect(counted.rules[0]).toEqual({ has_rule: true, support: 3, thin: false, says_only_once: false });
    // The same time named twice is one moment.
    const twice = logicOf(review({ findings: [finding({ rule: { when: 'a', do: 'b', this_game: 'At 12:10 — and again, 12:10.' } })] }));
    expect(twice.rules[0].support).toBe(1);
  });

  it('half a rule is scored as thin; an intentionally omitted optional rule is not scored as thin', () => {
    const l = logicOf(review({ findings: [finding({ rule: { when: 'a' } }), finding({ rule: undefined })] }));
    expect(l.rules).toEqual([{ has_rule: false, support: 0, thin: true, says_only_once: false }, { has_rule: false, support: 0, thin: false, says_only_once: false }]);
    expect(l.thin_rules).toBe(1);
    // In summarize(), intentionally omitted rules are excluded from the thin_rules denominator, while half-rules and full rules count.
    const s = summarize([scoreReview(review({ findings: [finding(), finding({ rule: { when: 'a' } }), finding({ rule: undefined })] }))]);
    expect(s.thin_rules).toBe(0.5);
  });

  it('one matchup statement alone is not "both ways"', () => {
    expect(logicOf(review({ lang: 'zh', verdict: '这个对位你占优。' })).matchup_both_ways).toBeNull();
    expect(logicOf(review({ lang: 'zh', verdict: '这是劣势对位。' })).matchup_both_ways).toBeNull();
    expect(logicOf(review({ verdict: 'The matchup was favoured. Later: the matchup with Axe is unfavoured.' })).matchup_both_ways).not.toBeNull();
  });
});

describe('review eval: against a rubric', () => {
  it('the committed rubric is one the script reads', async () => {
    expect(rubric.schema).toBe(RUBRIC_SCHEMA);
    const all = await loadRubrics('evals/reviews');
    expect(all.get('9100904020.beastmaster')?.must_hit.map((p: { id: string }) => p.id)).toEqual(['roar_spent_before_carry_immunity', 'no_blink_no_bkb']);
  });

  it('the stored review misses the Roar point, makes the item point, and does not look at the turning fight', () => {
    expect(rubricOf(stored, rubric)).toEqual({
      status: 'approved',
      must_hit: [{ id: 'roar_spent_before_carry_immunity', hit: false, finding: null }, { id: 'no_blink_no_bkb', hit: true, finding: 2 }],
      hit_weight: 1, weight: 3, hit_rate: 0.33,
      must_not: [],
      turning_fight_covered: false,
      // It leads with neither of the two points the rubric accepts as the game's lesson.
      lead: null, lead_ok: false,
      main_reason_ok: true,
      // The rubric names the turn 25:00–33:00 as the game's cause (#437 P5): this p33 review's mainline names a lost
      // fight in that window; it has no story, so it cannot place the cause in one.
      cause_named: true, story_ok: false,
    });
  });

  it('lead_also: another first finding the rubric accepts there, which is not counted in the hit rate', () => {
    const base = stored.review;
    const other = { title: '咆哮捏在手里就死了', claim: '三次阵亡时原始咆哮都还亮着没放。', evidence: [{ refs: ['audit:beastmaster:primal_roar'], fact: '三次阵亡时它就绪却没放。' }], fix: 'x', rule: { when: 'w', do: 'd', this_game: 't' } };
    const led = { review: { ...base, findings: [other, ...base.findings.slice(1)] } };
    const onlyLeadAny = { ...rubric, lead_also: undefined };
    expect(rubricOf(led, onlyLeadAny)).toMatchObject({ lead: null, lead_ok: false });
    const also = { ...rubric, lead_also: [{ id: 'died_with_roar_ready', says: 's', why: 'w', any: { refs: ['audit:beastmaster:primal_roar'] }, terms: { zh: ['咆哮'] }, and_terms: { zh: ['没放'] } }] };
    expect(rubricOf(led, also)).toMatchObject({ lead: 'died_with_roar_ready', lead_ok: true });
    // Not a must_hit: the hit rate is the same with or without it.
    expect(rubricOf(led, also).hit_rate).toBe(rubricOf(led, onlyLeadAny).hit_rate);
    expect(rubricOf(led, also).must_hit.map((p: any) => p.id)).not.toContain('died_with_roar_ready');
    // Its anchor is needed: the same words citing another record do not make it.
    const unanchored = { review: { ...base, findings: [{ ...other, evidence: [{ refs: ['build:beastmaster'], fact: 'f' }] }, ...base.findings.slice(1)] } };
    expect(rubricOf(unanchored, also).lead_ok).toBe(false);
    // A rubric with only lead_also is still judged.
    expect(rubricOf(led, { ...also, lead_any: undefined }).lead_ok).toBe(true);
  });

  it('the first finding is the page\'s one lesson: lead_ok says whether it makes a point the rubric accepts there', () => {
    const base = stored.review;
    expect(rubric.lead_any).toEqual(['roar_spent_before_carry_immunity', 'no_blink_no_bkb']);
    // The same findings the other way round: the item point, made second in the stored review, now leads.
    const swapped = { review: { ...base, findings: [base.findings[1], base.findings[0], ...base.findings.slice(2)] } };
    expect(rubricOf(swapped, rubric)).toMatchObject({ lead: 'no_blink_no_bkb', lead_ok: true });
    expect(rubricOf(swapped, rubric).must_hit[1]).toEqual({ id: 'no_blink_no_bkb', hit: true, finding: 1 });
    // What is said is the same either way: only where it stands differs.
    expect(rubricOf(swapped, rubric).hit_rate).toBe(rubricOf(stored, rubric).hit_rate);
    // A rubric that accepts only the Roar point there.
    expect(rubricOf(swapped, { ...rubric, lead_any: ['roar_spent_before_carry_immunity'] })).toMatchObject({ lead: null, lead_ok: false });
    // A rubric that does not say, or names something that is no point of its own: not judged, never "wrong".
    expect(rubricOf(swapped, { ...rubric, lead_any: undefined, lead_also: undefined })).toMatchObject({ lead: null, lead_ok: null });
    expect(rubricOf(swapped, { ...rubric, lead_any: [], lead_also: undefined }).lead_ok).toBeNull();
    expect(rubricOf(swapped, { ...rubric, lead_any: ['no_such_point'], lead_also: undefined }).lead_ok).toBeNull();
    // A review with no finding leads with none of them.
    expect(rubricOf({ review: { ...base, findings: [] } }, rubric)).toMatchObject({ lead: null, lead_ok: false });
    // Over several reviews: the share that lead well, among those whose rubric says; a later run is judged on it.
    const scores = [scoreReview(stored, rubric), scoreReview(swapped, rubric), scoreReview(swapped, { ...rubric, lead_any: undefined, lead_also: undefined })];
    expect(summarize(scores).rubric_approved).toMatchObject({ reviews: 3, lead_ok: 0.5 });
    expect(summarize([scoreReview(stored, { ...rubric, lead_any: undefined, lead_also: undefined })]).rubric_approved!.lead_ok).toBeNull();
    expect(compareSummaries({ rubric_approved: { lead_ok: 0.5 } }, { rubric_approved: { lead_ok: 0.17 } }).worse).toEqual([{ key: 'rubric_approved.lead_ok', before: 0.5, after: 0.17 }]);
  });

  it('a point is made by a finding that stands on the rubric\'s records or times and names its words', () => {
    const base = stored.review;
    const withFinding = (f: unknown) => ({ review: { ...base, findings: [base.findings[0], f] } });
    const roar = (evidence: unknown[], claim = '原始咆哮给了瘟疫法师，九秒后幻影刺客开了黑皇杖。') => ({ title: '咆哮交早了', claim, evidence, rule: { when: 'a', do: 'b' } });
    // By record.
    expect(rubricOf(withFinding(roar([{ refs: ['cast:beastmaster:primal_roar:7'], fact: '咆哮给了瘟疫法师。' }])), rubric).must_hit[0]).toEqual({ id: 'roar_spent_before_carry_immunity', hit: true, finding: 2 });
    // By time, within the rubric's ten seconds of 30:25 or 30:34.
    expect(rubricOf(withFinding(roar([{ refs: ['fight:11'], clock: '30:30', fact: '团战开始。' }])), rubric).must_hit[0].hit).toBe(true);
    expect(rubricOf(withFinding(roar([{ refs: ['fight:11'], clock: '30:50', fact: '团战结束。' }], '原始咆哮交了，黑皇杖随后开启。')), rubric).must_hit[0].hit).toBe(false);
    // The right record without the second word (no immunity named) is not the point.
    expect(rubricOf(withFinding(roar([{ refs: ['cast:beastmaster:primal_roar:7'], fact: '咆哮给了瘟疫法师。' }], '原始咆哮给了瘟疫法师。')), rubric).must_hit[0].hit).toBe(false);
    // Another cast of the same ability is another moment.
    expect(rubricOf(withFinding(roar([{ refs: ['cast:beastmaster:primal_roar:9'], clock: '37:56', fact: '咆哮给了幻影刺客。' }], '原始咆哮穿过了黑皇杖。')), rubric).must_hit[0].hit).toBe(false);
  });

  it('a point about two items needs both named: Blink alone is not "no Blink and no Black King Bar"', () => {
    const only = review({ findings: [finding({ claim: 'You never bought Blink Dagger.' })] });
    const both = review({ findings: [finding({ claim: 'You never bought Blink Dagger or Black King Bar.' })] });
    expect(rubricOf(only, rubric).must_hit[1]).toEqual({ id: 'no_blink_no_bkb', hit: false, finding: null });
    expect(rubricOf(both, rubric).must_hit[1]).toEqual({ id: 'no_blink_no_bkb', hit: true, finding: 1 });
  });

  it('the turning fight is looked at when a finding cites it or names a time in it', () => {
    const base = stored.review;
    const cited = { review: { ...base, findings: [{ ...base.findings[0], evidence: [{ refs: ['fights:beastmaster:11'], fact: '五人阵亡。' }] }] } };
    const timed = { review: { ...base, findings: [{ ...base.findings[0], claim: '30:40 那波团你们五人阵亡。' }] } };
    expect(rubricOf(cited, rubric).turning_fight_covered).toBe(true);
    expect(rubricOf(timed, rubric).turning_fight_covered).toBe(true);
    expect(rubricOf(stored, { ...rubric, turning_fight: undefined }).turning_fight_covered).toBeNull();
  });

  it('what the rubric rules out is found anywhere in the review; a reason outside the accepted ones is not ok', () => {
    const base = stored.review;
    const wrong = { review: { ...base, mainline: [...base.mainline, '原始咆哮穿不过黑皇杖，所以留着也没用。'], game_plan: { ...base.game_plan, main_reason: 'your_play' } } };
    const r = rubricOf(wrong, rubric);
    expect(r.must_not.map((x: { id: string }) => x.id)).toEqual(['roar_stopped_by_immunity']);
    expect(r.main_reason_ok).toBe(false);
    // No game plan: the reason is not judged.
    expect(rubricOf({ review: { ...base, game_plan: undefined } }, rubric).main_reason_ok).toBeNull();
  });

  it('a point marked where: "review" may be made outside the findings; words fall back to English for another language', () => {
    const r = review({ verdict: 'No Blink Dagger all game.', findings: [finding()] });
    const point = { id: 'blink', says: 'x', terms: { en: ['Blink'] } };
    expect(rubricOf(r, { must_hit: [point] }).must_hit[0]).toEqual({ id: 'blink', hit: false, finding: null });
    expect(rubricOf(r, { must_hit: [{ ...point, where: 'review' }] }).must_hit[0]).toEqual({ id: 'blink', hit: true, finding: null });
    expect(rubricOf(review({ lang: 'zh', verdict: '结论', findings: [finding({ claim: 'Blink 没出。' })] }), { must_hit: [point] }).must_hit[0].hit).toBe(true);
  });

  it('a rubric with no points gives no rate', () => {
    expect(rubricOf(review(), { status: 'approved' })).toMatchObject({ status: 'approved', weight: 0, hit_rate: null, must_hit: [], must_not: [] });
  });

  it('scores one-sided wins (#361): must_praise checks did_well, and max_findings bounds invented complaints', () => {
    const stompRubric = {
      schema: RUBRIC_SCHEMA,
      match_id: 9102822298,
      hero: 'queen_of_pain',
      status: 'approved',
      must_hit: [],
      must_praise: [
        { id: 'won_mid_lane', says: '57 vs 36 last hits by 10:00', weight: 2, any: { clocks: ['10:00'] }, terms: { en: ['57'], zh: ['57'] }, and_terms: { en: ['lane', 'last hit'], zh: ['对线', '补刀'] } },
        { id: 'one_death_only', says: 'only 1 death all game', weight: 1, terms: { en: ['1 death', 'died once'], zh: ['1 次阵亡', '只死 1 次'] } },
      ],
      max_findings: 1,
      main_reason: ['your_play', 'team_play'],
    };

    const zhFinding = (title: string) => ({
      title,
      claim: '18:20 在对方高地前阵亡。',
      fix: '退回高地。',
      evidence: [{ refs: ['death:axe:2'], clock: '18:20', fact: '18:20 阵亡。' }],
      rule: { when: '兵线未到时', do: '先退后', this_game: '18:20、22:10 两次。' },
    });

    const goodWin = review({
      lang: 'zh',
      verdict: '对线与中期全面碾压。',
      findings: [zhFinding('唯一一次阵亡')],
      did_well: ['10:00 对线补刀 57 比 36，完全压制中路。', '整局只死 1 次，节奏紧凑。'],
      game_plan: { main_reason: 'your_play', course: '碾压获胜。', evidence: [] },
    });
    const scoredGood = rubricOf(goodWin, stompRubric);
    expect(scoredGood).toMatchObject({
      status: 'approved',
      hit_rate: null,
      must_praise: [
        { id: 'won_mid_lane', hit: true, item: 1 },
        { id: 'one_death_only', hit: true, item: 2 },
      ],
      praise_hit_weight: 3,
      praise_weight: 3,
      praise_rate: 1,
      max_findings: 1,
      findings_within_max: true,
      main_reason_ok: true,
    });

    // Over-inventing three findings and missing one praise point drops both metrics.
    const nitpickyWin = review({
      lang: 'zh',
      verdict: '对线与中期全面碾压。',
      findings: [zhFinding('唯一一次阵亡'), zhFinding('次要细节二'), zhFinding('次要细节三')],
      did_well: ['10:00 对线补刀 57 比 36。'],
      game_plan: { main_reason: 'your_play', course: '获胜。', evidence: [] },
    });
    const scoredBad = rubricOf(nitpickyWin, stompRubric);
    expect(scoredBad).toMatchObject({
      praise_hit_weight: 2,
      praise_weight: 3,
      praise_rate: 0.67,
      max_findings: 1,
      findings_within_max: false,
    });

    const sumGood = summarize([scoreReview(goodWin, stompRubric)]);
    const sumBad = summarize([scoreReview(nitpickyWin, stompRubric)]);
    expect(sumGood.rubric_approved).toMatchObject({ praise_rate: 1, findings_within_max: 1 });
    expect(sumBad.rubric_approved).toMatchObject({ praise_rate: 0.67, findings_within_max: 0 });
    expect(compareSummaries(sumGood, sumBad).worse).toEqual([
      { key: 'rubric_approved.praise_rate', before: 1, after: 0.67 },
      { key: 'rubric_approved.findings_within_max', before: 1, after: 0 },
    ]);
  });
});

describe('review eval: stability', () => {
  const run = (reason: string | null, refs: string[]) => review({ findings: [finding({ evidence: [{ refs, fact: 'x' }] })], ...(reason ? { game_plan: { main_reason: reason } } : {}) });

  it('agreement on the reason, and how much of the first finding\'s records two runs share', () => {
    const s = stabilityOf([run('team_play', ['death:axe:1', 'death:axe:2']), run('team_play', ['death:axe:2', 'death:axe:3']), run('enemy_play', ['death:axe:1', 'death:axe:2'])]);
    expect(s.reviews).toBe(3);
    expect(s.main_reason).toEqual({ team_play: 2, enemy_play: 1 });
    expect(s.main_reason_agreement).toBe(0.67);
    // Pairs: 1/3, 1, 1/3.
    expect(s.first_finding_overlap).toBe(0.56);
  });

  it('a review without a reason is not counted for or against; one reason alone is no agreement', () => {
    const s = stabilityOf([run('team_play', ['a:1']), run(null, ['a:1']), run(null, ['a:1'])]);
    expect(s.main_reason_agreement).toBeNull();
    expect(s.first_finding_overlap).toBe(1);
    expect(stabilityOf([]).first_finding_overlap).toBeNull();
  });
});

describe('review eval: summary and comparison', () => {
  it('one row of numbers over many reviews; rubric numbers by the rubric\'s status', () => {
    const s = summarize([scoreReview(stored, rubric), scoreReview(review())]);
    expect(s.reviews).toBe(2);
    expect(s.verdict_chars_chinese).toBe(82);
    expect(s.chinese_reviews_with_english_words).toBe(1);
    expect(s.english_words_per_chinese_review).toBe(38);
    expect(s.rules_that_say_only_once).toBe(0.25);
    expect(s.matchup_both_ways).toBe(0.5);
    expect(s.repaired).toBe(1);
    // How many reviews have no game plan (#388).
    expect(summarize([scoreReview({ review: { game_plan: { course: 'x' } } } as any), scoreReview({ review: {} } as any)]).without_game_plan).toBe(0.5);
    // A bare review (no { review } wrapper) is read the same way (Codex on #391).
    expect(summarize([scoreReview({ game_plan: { course: 'x' } } as any), scoreReview({ findings: [] } as any)]).without_game_plan).toBe(0.5);
    expect(BETTER.without_game_plan).toBe(-1);
    expect(s.rubric_draft).toBeNull();
    // lead_ok: its first finding is neither of the two points the rubric accepts as the lesson.
    expect(s.rubric_approved).toEqual({ reviews: 1, hit_rate: 0.33, must_not_violations: 0, turning_fight_covered: 0, lead_ok: 0, main_reason_ok: 1, cause_named: 1, story_ok: 0 });
    // A rubric nobody has checked is counted apart.
    expect(summarize([scoreReview(stored, { ...rubric, status: 'draft' })]).rubric_draft?.reviews).toBe(1);
  });

  it('names what got worse and what got better, past a small tolerance', () => {
    const before = { top_dense_sentences: 0.4, thin_rules: 0.1, rubric_draft: { hit_rate: 0.5 }, main_reason_agreement: 0.7, reviews: 10 };
    const after = { top_dense_sentences: 0.2, thin_rules: 0.11, rubric_draft: { hit_rate: 0.3 }, main_reason_agreement: null, reviews: 99 };
    expect(compareSummaries(before, after)).toEqual({
      worse: [{ key: 'rubric_draft.hit_rate', before: 0.5, after: 0.3 }],
      better: [{ key: 'top_dense_sentences', before: 0.4, after: 0.2 }],
    });
  });

  it('the kept baseline reads as a summary and is not worse than itself', () => {
    expect(baseline.schema).toBe('dota2.ai/review-eval@1');
    expect(baseline.latest.reviews).toBeGreaterThan(0);
    expect(compareSummaries(baseline.latest, baseline.latest)).toEqual({ worse: [], better: [] });
  });
});

describe('review eval: the script', () => {
  it('reads what a stored review\'s file name says (legacy per-language and trilingual bundles)', () => {
    expect(parseName('9100904020.beastmaster.zh.p33.review.json')).toEqual({ file: '9100904020.beastmaster.zh.p33.review.json', match_id: 9100904020, hero: 'beastmaster', lang: 'zh', version: 33, plan: null, run: null });
    expect(parseName('9103304074.phantom_lancer.zh.p33.plan-late.review.json')?.plan).toBe('late');
    expect(parseName('9100904020.beastmaster.p46.review.json')).toEqual({ file: '9100904020.beastmaster.p46.review.json', match_id: 9100904020, hero: 'beastmaster', lang: null, version: 46, plan: null, run: null });
    expect(parseName('9100904020.beastmaster.p46.plan-push.m-glm-5.3.review.json')).toEqual({ file: '9100904020.beastmaster.p46.plan-push.m-glm-5.3.review.json', match_id: 9100904020, hero: 'beastmaster', lang: null, version: 46, plan: 'push', run: null });
    expect(parseName('9100904020.beastmaster.zh.p33.unverified.json')).toBeNull();
    expect(parseName('9100904020.trace.json.gz')).toBeNull();
    // Trilingual bundle expands into one scorable entry per stored language.
    const meta = parseName('9100904020.beastmaster.p46.review.json')!;
    const expanded = expandStoredEntries(meta, { schema: 'dota2.ai/deep-review-bundle@1', reviews: { en: review({ lang: 'en' }), zh: review({ lang: 'zh' }), ru: review({ lang: 'ru' }) } });
    expect(expanded.map((e: any) => e.lang).sort()).toEqual(['en', 'ru', 'zh']);
    expect(evaluate(expanded, new Map()).games).toHaveLength(3);
  });

  it('arguments', () => {
    expect(parseArgs(['dir'])).toEqual({ dir: 'dir', rubrics: 'evals/reviews', allVersions: false, json: null, baseline: null });
    expect(parseArgs(['dir', '--all-versions', '--json', 'o.json', '--baseline', 'b.json', '--rubrics', 'r'])).toEqual({ dir: 'dir', rubrics: 'r', allVersions: true, json: 'o.json', baseline: 'b.json' });
    expect(parseArgs([])).toBeNull();
    expect(parseArgs(['a', 'b'])).toBeNull();
    expect(parseArgs(['dir', '--json'])).toBeNull();
    expect(parseArgs(['dir', '--nope'])).toBeNull();
  });

  it('scores each game by its newest version, a plan\'s reviews apart, and reads stability from three reviews on', () => {
    const entry = (version: number, reason: string, plan: string | null = null) => ({ ...parseName(`1.axe.en.p${version}${plan ? `.plan-${plan}` : ''}.review.json`)!, stored: { review: review({ verdict: `v${version}`, game_plan: { main_reason: reason } }) } });
    const out = evaluate([entry(30, 'team_play'), entry(33, 'enemy_play'), entry(31, 'team_play'), entry(33, 'team_play', 'push')], new Map(), { allVersions: true });
    expect(out.games.map((g) => [g.version, g.plan])).toEqual([[33, null], [33, 'push']]);
    expect(out.latest.reviews).toBe(2);
    expect(Object.keys(out.by_version!)).toEqual(['p30', 'p31', 'p33']);
    expect(out.by_version!.p33.reviews).toBe(2);
    expect(out.stability.games).toBe(1);
    expect(out.stability.by_game[0]).toMatchObject({ game: '1.axe.en.', reviews: 3, main_reason: { team_play: 2, enemy_play: 1 }, main_reason_agreement: 0.67 });
    expect(out.latest.main_reason_agreement).toBe(0.67);
    expect(evaluate([entry(33, 'team_play')], new Map()).by_version).toBeNull();
  });

  it('a game with a rubric is scored against it', () => {
    const out = evaluate([{ ...parseName('9100904020.beastmaster.zh.p33.review.json')!, stored }], new Map([['9100904020.beastmaster', rubric]]));
    expect(out.games[0].rubric?.hit_rate).toBe(0.33);
    expect(out.latest.rubric_approved?.reviews).toBe(1);
  });
});

describe('review eval: review findings on #325', () => {
  it('the language a review was asked for decides whether its English is a leak, not what it happens to be written in', () => {
    // Asked for in Chinese, came back in English: every word is a leak, and it counts among the Chinese reviews.
    const allEnglish = styleOf(review({ lang: 'zh' }));
    expect(allEnglish.english?.words).toBe(28);
    expect(summarize([scoreReview(review({ lang: 'zh' }))]).chinese_reviews_with_english_words).toBe(1);
    // Asked for in English, quoting a Chinese name: not a Chinese review.
    expect(styleOf(review({ lang: 'en', verdict: 'Phantom Assassin (幻影刺客) killed you four times.', findings: [finding({ claim: '幻影刺客 had Black King Bar.' })] })).english).toBeNull();
    // A record that does not say is judged by what it is written in.
    expect(styleOf({ verdict: '这条线判为 lost。', findings: [] }).english).toEqual({ words: 1, texts: 1, examples: ['lost'] });
    expect(styleOf({ verdict: 'You died alone.', findings: [] }).english).toBeNull();
  });

  it('a rubric record is that record, or one that continues it past a colon — never one whose number merely starts with it', () => {
    const point = { id: 'lane', says: 'x', any: { refs: ['death:tidehunter:1'] } };
    const cites = (ref: string) => review({ findings: [finding({ evidence: [{ refs: [ref], fact: 'x' }] })] });
    expect(rubricOf(cites('death:tidehunter:1'), { must_hit: [point] }).must_hit[0].hit).toBe(true);
    expect(rubricOf(cites('death:tidehunter:1:w20'), { must_hit: [point] }).must_hit[0].hit).toBe(true);
    expect(rubricOf(cites('death:tidehunter:10'), { must_hit: [point] }).must_hit[0].hit).toBe(false);
    expect(rubricOf(cites('death:tidehunter:12'), { must_hit: [point] }).must_hit[0].hit).toBe(false);
    // A prefix is written with its colon.
    const every = { id: 'roar', says: 'x', any: { refs: ['cast:beastmaster:primal_roar:'] } };
    expect(rubricOf(cites('cast:beastmaster:primal_roar:7'), { must_hit: [every] }).must_hit[0].hit).toBe(true);
    expect(rubricOf(cites('cast:beastmaster:primal_roar_2:7'), { must_hit: [every] }).must_hit[0].hit).toBe(false);
  });

  it('the Tidehunter rubric\'s lane point is not met by a death late in the game, nor by low health alone', () => {
    const tide = json('../../evals/reviews/9091400302.tidehunter.json');
    const late = review({ lang: 'en', findings: [finding({ claim: 'You died on low health.', evidence: [{ refs: ['death:tidehunter:10'], clock: '40:00', fact: '40:00: below half health.' }], rule: { when: 'a', do: 'b', this_game: 'At 40:00.' } })] });
    expect(rubricOf(late, tide).must_hit.find((p: { id: string }) => p.id === 'lane_deaths_as_decisions')?.hit).toBe(false);
    // Since 2026-11-27 the point is what he was doing (the owner: low health alone says nothing).
    const lowOnly = review({ lang: 'en', findings: [finding({ claim: 'You died on low health in lane.', evidence: [{ refs: ['death:tidehunter:1'], clock: '4:21', fact: '4:21: below half health.' }] })] });
    expect(rubricOf(lowOnly, tide).must_hit.find((p: { id: string }) => p.id === 'lane_deaths_as_decisions')?.hit).toBe(false);
    const early = review({ lang: 'en', findings: [finding({ claim: 'You stayed to last-hit on half health and died in lane.', evidence: [{ refs: ['death:tidehunter:1'], clock: '4:21', fact: '4:21: last-hitting at 47% health.' }] })] });
    expect(rubricOf(early, tide).must_hit.find((p: { id: string }) => p.id === 'lane_deaths_as_decisions')?.hit).toBe(true);
  });
});

describe('review eval: the Beastmaster rubric\'s forbidden claim', () => {
  const says = (line: string) => rubricOf({ review: { ...stored.review, mainline: [line] } }, rubric).must_not.map((x: { id: string }) => x.id);

  it('is that immunity stops Roar — not that Roar cannot be stopped by it', () => {
    for (const wrong of ['原始咆哮穿不过黑皇杖，所以留着也没用。', '原始咆哮无法穿透魔法免疫。', '原始咆哮不能穿过黑皇杖。', '咆哮打不穿魔免。']) expect(says(wrong)).toEqual(['roar_stopped_by_immunity']);
    // The passive says the opposite, and is what a correct review writes.
    for (const right of ['原始咆哮不能被黑皇杖挡住，应该留给幻影刺客。', '黑皇杖无法被咆哮以外的技能打断。', '原始咆哮可以穿过黑皇杖。']) expect(says(right)).toEqual([]);
  });

  it('reads the English the same way', () => {
    const en = (line: string) => rubricOf({ review: { ...stored.review, lang: 'en', mainline: [line] } }, rubric).must_not.length;
    expect(en('Primal Roar does not go through Black King Bar.')).toBe(1);
    expect(en('Primal Roar cannot be blocked by spell immunity.')).toBe(0);
  });
});

describe('review eval: stability leaves out what cannot be compared', () => {
  const cites = (refs: string[]) => review({ findings: [finding({ evidence: refs.length ? [{ refs, fact: 'x' }] : [] })] });

  it('a review whose first finding cites nothing is not a disagreement', () => {
    // One review cites, two do not: nothing to compare, so no number — not zero.
    expect(stabilityOf([cites(['death:axe:1']), cites([]), cites([])]).first_finding_overlap).toBeNull();
    expect(stabilityOf([cites(['death:axe:1']), review({ findings: [] }), cites([])]).first_finding_overlap).toBeNull();
    // Two cite the same thing, one cites nothing: the two agree in full.
    expect(stabilityOf([cites(['death:axe:1']), cites(['death:axe:1']), cites([])]).first_finding_overlap).toBe(1);
    // Two that cite different things still disagree.
    expect(stabilityOf([cites(['death:axe:1']), cites(['death:axe:2']), cites([])]).first_finding_overlap).toBe(0);
  });
});

describe('the game\'s main cause in the story (#437 P5)', () => {
  const rubric = { status: 'approved', must_hit: [], main_reason: ['your_play', 'team_play'], story_cause: { id: 'lane', says: 's', from: 0, to: 600, terms: { zh: ['对线'], en: ['lane'] } } };
  const stored = (review: any) => ({ review: { lang: 'en', findings: [], did_well: [], mainline: [], ...review } });
  const link = (extra: any) => ({ phase: '0:00–10:00, the lane', what_changed: 'Down 5126.', because: 'Seven deaths.', whose: 'me', evidence: [], ...extra });

  it('a link in the window that names the cause, owned as the rubric accepts: both', () => {
    expect(rubricOf(stored({ story: [link({})] }), rubric)).toMatchObject({ cause_named: true, story_ok: true });
  });
  it('the right link with an owner the rubric does not accept: named, not ok', () => {
    expect(rubricOf(stored({ story: [link({ whose: 'enemy' })] }), rubric)).toMatchObject({ cause_named: true, story_ok: false });
  });
  it('a link outside the window, or one that does not name it: neither', () => {
    expect(rubricOf(stored({ story: [link({ phase: '24:00–27:47, the lane' , what_changed: 'Lost.', because: 'Fights.' })] }), rubric)).toMatchObject({ cause_named: false, story_ok: false });
    expect(rubricOf(stored({ story: [link({ phase: '0:00–10:00, early', what_changed: 'Down.', because: 'Deaths.' })] }), rubric)).toMatchObject({ cause_named: false, story_ok: false });
  });
  it('a review without a story is read on its mainline for cause_named, and is never story_ok', () => {
    expect(rubricOf(stored({ mainline: ['0:00–10:00: the lane went badly.'] }), rubric)).toMatchObject({ cause_named: true, story_ok: false });
  });
  it('a v84 chapter-only review without story gets story_ok when a chapter names the cause in window AND game_plan.main_reason matches accepted whose', () => {
    const chapter = (title: string, analysis: string) => ({ topic: 'laning', title, analysis, evidence: [{ refs: ['lane:x'], clock: '5:00', fact: '5:00 lost lane.' }] });
    // Matching chapter in window + accepted main_reason (your_play → me, team_play → team)
    expect(rubricOf(stored({
      chapters: [chapter('Laning breakdown', '0:00–10:00 the lane went badly.')],
      game_plan: { main_reason: 'your_play', why: 'Died repeatedly in lane.' },
    }), rubric)).toMatchObject({ cause_named: true, story_ok: true });
    expect(rubricOf(stored({
      chapters: [chapter('Laning breakdown', '0:00–10:00 the lane went badly.')],
      game_plan: { main_reason: 'team_play', why: 'Team abandoned lane.' },
    }), rubric)).toMatchObject({ cause_named: true, story_ok: true });
    // Matching chapter in window, but main_reason outside accepted whose (enemy_play → enemy)
    expect(rubricOf(stored({
      chapters: [chapter('Laning breakdown', '0:00–10:00 the lane went badly.')],
      game_plan: { main_reason: 'enemy_play', why: 'Enemy rotated well.' },
    }), rubric)).toMatchObject({ cause_named: true, story_ok: false });
    // Chapter outside cause window: neither
    expect(rubricOf(stored({
      chapters: [{ topic: 'midgame', title: 'Late lane', analysis: '24:00 the lane push failed.', evidence: [{ refs: ['tempo:x'], clock: '24:00', fact: '24:00 fight.' }] }],
      game_plan: { main_reason: 'your_play', why: 'Late mistake.' },
    }), rubric)).toMatchObject({ cause_named: false, story_ok: false });
  });
  it('no story_cause in the rubric: neither is scored', () => {
    const { story_cause: _c, ...plain } = rubric;
    expect(rubricOf(stored({ story: [link({})] }), plain)).toMatchObject({ cause_named: null, story_ok: null });
  });
  it('summarize counts them over the reviews whose rubric names a cause', () => {
    const s = summarize([scoreReview(stored({ story: [link({})] }), rubric), scoreReview(stored({ mainline: ['24:00: lost.'] }), rubric)]);
    expect(s.rubric_approved).toMatchObject({ cause_named: 0.5, story_ok: 0.5 });
  });
});

describe('committed eval rubrics inventory (#361)', () => {
  it('all 14 approved rubrics in evals/reviews/ are structurally valid with compilable must_not patterns and valid lead_any ids', async () => {
    const all = await loadRubrics('evals/reviews');
    expect(all.size).toBeGreaterThanOrEqual(14);
    const approved = [...all.values()].filter((r: any) => r.status === 'approved');
    expect(approved.length).toBeGreaterThanOrEqual(14);
    for (const r of approved as any[]) {
      expect(r.schema).toBe(RUBRIC_SCHEMA);
      expect(Number.isInteger(r.match_id)).toBe(true);
      expect(typeof r.hero).toBe('string');
      expect(Array.isArray(r.must_hit)).toBe(true);
      const hitIds = new Set(r.must_hit.map((p: any) => p.id));
      expect(hitIds.size).toBe(r.must_hit.length);
      for (const id of r.lead_any ?? []) expect(hitIds.has(id)).toBe(true);
      for (const p of r.must_not ?? []) {
        if (typeof p.pattern === 'string') expect(() => new RegExp(p.pattern, 'i')).not.toThrow();
      }
      if (r.story_cause) {
        expect(Number.isFinite(r.story_cause.from)).toBe(true);
        expect(Number.isFinite(r.story_cause.to)).toBe(true);
        expect(r.story_cause.to).toBeGreaterThanOrEqual(r.story_cause.from);
      }
      if (r.turning_fight) {
        expect(Number.isInteger(r.turning_fight.fight)).toBe(true);
        expect(r.turning_fight.to).toBeGreaterThanOrEqual(r.turning_fight.from);
      }
    }
    // Includes at least one stomp win with must_praise + max_findings.
    expect(approved.some((r: any) => Array.isArray(r.must_praise) && r.must_praise.length > 0 && Number.isInteger(r.max_findings))).toBe(true);
  });

  it('Enchantress (9106163189) must_not flags bogus 0-cast Impetus claims without misfiring on honest damage notes, and Spirit Breaker (9107133982) enforces must_praise + max_findings', () => {
    const ench = json('../../evals/reviews/9106163189.enchantress.json');
    const badZh = review({ lang: 'zh', findings: [finding({ claim: '推进全场 0 次施放，等于没用过。' })] });
    const badEn = review({ lang: 'en', findings: [finding({ claim: 'Impetus was never cast in this game.' })] });
    const goodZh = review({ lang: 'zh', verdict: '这局下路大优且全场仅 5 次阵亡，插下 10 颗假眼。', findings: [finding({ claim: '推进造成 6024 点伤害但 40:08 才出原力法杖，14:25 与 42:27 未换到人头。', evidence: [{ refs: ['death:enchantress:5', 'build:enchantress'], clock: '42:27', fact: '42:27 落单阵亡。' }] })] });
    expect(rubricOf(badZh, ench).must_not.map((x: any) => x.id)).toContain('impetus_claimed_never_cast');
    expect(rubricOf(badEn, ench).must_not.map((x: any) => x.id)).toContain('impetus_claimed_never_cast');
    expect(rubricOf(goodZh, ench)).toMatchObject({ hit_rate: 1, praise_rate: 1, must_not: [] });

    const sb = json('../../evals/reviews/9107133982.spirit_breaker.json');
    const cleanStomp = review({
      lang: 'zh',
      verdict: '下路对线大优且全场只死 1 次，轻松赢下比赛。',
      did_well: ['10:00 下路对线大优且 0 死。', '整局仅阵亡 1 次且幽冥一击从未留着阵亡。'],
      findings: [finding({ title: '唯一一次阵亡', claim: '12:19 团战阵亡但换到人头。' })],
      game_plan: { main_reason: 'your_play' },
    });
    expect(rubricOf(cleanStomp, sb)).toMatchObject({ hit_rate: null, praise_rate: 1, findings_within_max: true, must_not: [], main_reason_ok: true });
    const nitpickStomp = { ...cleanStomp, findings: [finding(), finding(), finding()] };
    expect(rubricOf(nitpickStomp, sb).findings_within_max).toBe(false);

    // Highlights (with evidence refs/clocks) satisfy must_praise, and new review fields are included in reviewTexts/styleOf.
    const coachStomp = review({
      lang: 'zh',
      verdict: '下路对线大优且全场只死 1 次，轻松赢下比赛。',
      highlights: [
        { title: '10:00 下路对线大优且 0 死', detail: '下路压制到位，前期零阵亡。', evidence: [{ refs: ['lane:spirit_breaker'], clock: '10:00', fact: '10:00 零阵亡。' }] },
        { title: '整局仅阵亡 1 次且幽冥一击从未留着阵亡', detail: '团战技能果断，只死 1 次。' },
      ],
      chapters: [
        { topic: 'laning', title: '对线期稳健', analysis: '前 10 分钟对线压制明显。', evidence: [{ refs: ['lane:spirit_breaker'], clock: '10:00', fact: '10:00 优势。' }] },
      ],
      findings: [],
      did_well: [],
      game_plan: { main_reason: 'your_play' },
    });
    expect(rubricOf(coachStomp, sb)).toMatchObject({ praise_rate: 1, findings_within_max: true, must_not: [], main_reason_ok: true });
    expect(reviewTexts(coachStomp).map((t) => t.where)).toEqual(expect.arrayContaining(['highlight', 'highlight_evidence', 'chapter', 'chapter_evidence']));
  });
});

describe('review eval: coaching quality metrics', () => {
  it('scores highlights evidence coverage, chapter topics, and mechanical KPI leaks', () => {
    expect(coachOf(stored)).toEqual({
      highlights_count: 0,
      highlights_with_evidence: 0,
      highlights_with_evidence_rate: null,
      chapters_count: 0,
      chapter_topics: [],
      mechanical_kpi_leaks: [],
    });

    const coachReview = {
      review: review({
        lang: 'zh',
        highlights: [
          { title: '27:27 关键咆哮', detail: '隔着黑皇杖定住幻影刺客 3.4 秒。', evidence: [{ refs: ['cast:beastmaster:primal_roar:6'], clock: '27:27', fact: '27:27 吼住 3.4 秒。' }] },
          { title: '推塔积极', detail: '建筑伤害全队最高。', evidence: [{ refs: [], fact: '无效证据' }] },
          { title: '残缺亮点' },
        ],
        chapters: [
          { topic: 'game_plan', title: '推荐思路', analysis: '围绕强势期推塔。', evidence: [{ refs: ['window:beastmaster:2'], fact: '19:00 领先。' }] },
          { topic: 'laning', title: '对线期', analysis: '补刀持平。', evidence: [{ refs: ['lane:beastmaster'], fact: '37 刀。' }] },
          { topic: 'midgame', title: '中期打架与打钱', analysis: '到场率高。', evidence: [{ refs: ['fights:beastmaster:6'], fact: '753 伤害。' }] },
          { topic: 'vision_and_macro', title: '视野布置与运营', analysis: '推进转化不足。', evidence: [{ refs: ['tempo:beastmaster'], fact: '16 波团战。' }] },
          { topic: 'midgame', title: '中期重复章节', analysis: '节奏紧凑。', evidence: [{ refs: ['cast:beastmaster:primal_roar:6'], fact: '27:27。' }] },
          { topic: 'other', title: '无效章节' },
        ],
      }),
      verification: { repaired: false, dropped: 0, first_pass_problems: 2 },
    };
    expect(coachOf(coachReview)).toEqual({
      highlights_count: 2,
      highlights_with_evidence: 1,
      highlights_with_evidence_rate: 0.5,
      chapters_count: 5,
      chapter_topics: ['game_plan', 'laning', 'midgame', 'vision_and_macro'],
      mechanical_kpi_leaks: [],
    });
    expect(scoreReview(coachReview).coach).toEqual(coachOf(coachReview));

    const leaky = review({
      lang: 'zh',
      verdict: '下一盘团战外阵亡不超过 2 次，避免死前 12 秒已不到半血。',
      mainline: ['团战之外不到半血阵亡不超过 1 次。'],
      findings: [finding({
        claim: 'Target at most 2 deaths and avoid deaths outside fights that began below half health.',
        fix: 'Keep at most 1 cast wasted and avoid deaths that began below half health.',
      })],
    });
    expect(coachOf(leaky).mechanical_kpi_leaks).toEqual([
      '下一盘团战外阵亡不超过 2 次',
      '死前 12 秒已不到半血',
      'at most 2 deaths',
      'deaths outside fights that began below half health',
      'at most 1 cast',
      'deaths that began below half health',
      '团战之外不到半血阵亡不超过',
    ]);

    expect(coachOf({ review: { highlights: 'bad', chapters: [null, 42] } })).toEqual({
      highlights_count: 0,
      highlights_with_evidence: 0,
      highlights_with_evidence_rate: null,
      chapters_count: 0,
      chapter_topics: [],
      mechanical_kpi_leaks: [],
    });
  });

  it('aggregates coach metrics and first_pass_problems_mean in summarize() and judges them in BETTER / compareSummaries', () => {
    const goodCoach = scoreReview({
      review: review({
        lang: 'zh',
        verdict: '这局前期节奏很稳，关键团战执行到位。',
        findings: [],
        highlights: [
          { title: '亮点一', detail: '细节一。', evidence: [{ refs: ['cast:x:1'], fact: 'f1' }] },
          { title: '亮点二', detail: '细节二。', evidence: [{ refs: ['cast:x:2'], fact: 'f2' }] },
        ],
        chapters: [
          { topic: 'laning', title: '对线', analysis: '节奏稳健。', evidence: [{ refs: ['lane:x'], fact: '补刀领先。' }] },
          { topic: 'skills_and_items', title: '技能与出装', analysis: '出装及时。', evidence: [{ refs: ['build:x'], fact: '关键装备到位。' }] },
        ],
      }),
      verification: { repaired: false, dropped: 0, first_pass_problems: 0 },
    });
    const weakCoach = scoreReview({
      review: review({
        lang: 'zh',
        verdict: '下一盘阵亡不超过 2 次。',
        findings: [],
        highlights: [{ title: '亮点', detail: '没有证据。' }],
        chapters: [{ topic: 'vision_and_macro', title: '运营', analysis: '推塔偏慢。', evidence: [{ refs: ['tempo:x'], fact: '推进偏慢。' }] }],
      }),
      verification: { repaired: true, dropped: 1, first_pass_problems: 10 },
    });
    const legacyNoFirstPass = scoreReview(stored);

    const sum = summarize([goodCoach, weakCoach, legacyNoFirstPass]);
    expect(sum).toMatchObject({
      highlights_mean: 1,
      highlights_with_evidence_rate: 0.67,
      chapters_mean: 1,
      first_pass_problems_mean: 5,
      mechanical_kpi_leaks: 1,
    });

    expect(BETTER).toMatchObject({
      highlights_with_evidence_rate: 1,
      first_pass_problems_mean: -1,
      mechanical_kpi_leaks: -1,
    });

    const cmp = compareSummaries(summarize([weakCoach]), summarize([goodCoach]));
    expect(cmp.worse).toEqual([]);
    expect(cmp.better.map((x: { key: string }) => x.key)).toEqual(expect.arrayContaining([
      'highlights_with_evidence_rate',
      'first_pass_problems_mean',
      'mechanical_kpi_leaks',
    ]));
  });
});
