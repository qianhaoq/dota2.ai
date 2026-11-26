import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BETTER, RUBRIC_SCHEMA, compareSummaries, logicOf, reviewTexts, rubricOf, scoreReview, stabilityOf, styleOf, summarize } from '../../lib/agent/evalReview.js';
import { evaluate, loadRubrics, parseArgs, parseName } from '../../scripts/eval-review.mjs';

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

  it('a finding with half a rule or none has no rule to rest on', () => {
    const l = logicOf(review({ findings: [finding({ rule: { when: 'a' } }), finding({ rule: undefined })] }));
    expect(l.rules).toEqual([{ has_rule: false, support: 0, thin: true, says_only_once: false }, { has_rule: false, support: 0, thin: true, says_only_once: false }]);
    expect(l.thin_rules).toBe(2);
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
    });
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
    expect(rubricOf(swapped, { ...rubric, lead_any: undefined })).toMatchObject({ lead: null, lead_ok: null });
    expect(rubricOf(swapped, { ...rubric, lead_any: [] }).lead_ok).toBeNull();
    expect(rubricOf(swapped, { ...rubric, lead_any: ['no_such_point'] }).lead_ok).toBeNull();
    // A review with no finding leads with none of them.
    expect(rubricOf({ review: { ...base, findings: [] } }, rubric)).toMatchObject({ lead: null, lead_ok: false });
    // Over several reviews: the share that lead well, among those whose rubric says; a later run is judged on it.
    const scores = [scoreReview(stored, rubric), scoreReview(swapped, rubric), scoreReview(swapped, { ...rubric, lead_any: undefined })];
    expect(summarize(scores).rubric_approved).toMatchObject({ reviews: 3, lead_ok: 0.5 });
    expect(summarize([scoreReview(stored, { ...rubric, lead_any: undefined })]).rubric_approved!.lead_ok).toBeNull();
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
    expect(BETTER.without_game_plan).toBe(-1);
    expect(s.rubric_draft).toBeNull();
    // lead_ok: its first finding is neither of the two points the rubric accepts as the lesson.
    expect(s.rubric_approved).toEqual({ reviews: 1, hit_rate: 0.33, must_not_violations: 0, turning_fight_covered: 0, lead_ok: 0, main_reason_ok: 1 });
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
  it('reads what a stored review\'s file name says', () => {
    expect(parseName('9100904020.beastmaster.zh.p33.review.json')).toEqual({ file: '9100904020.beastmaster.zh.p33.review.json', match_id: 9100904020, hero: 'beastmaster', lang: 'zh', version: 33, plan: null, run: null });
    expect(parseName('9103304074.phantom_lancer.zh.p33.plan-late.review.json')?.plan).toBe('late');
    expect(parseName('9100904020.beastmaster.zh.p33.unverified.json')).toBeNull();
    expect(parseName('9100904020.trace.json.gz')).toBeNull();
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

  it('the Tidehunter rubric\'s lane point is not met by a death late in the game', () => {
    const tide = json('../../evals/reviews/9091400302.tidehunter.json');
    const late = review({ lang: 'en', findings: [finding({ claim: 'You died on low health.', evidence: [{ refs: ['death:tidehunter:10'], clock: '40:00', fact: '40:00: below half health.' }], rule: { when: 'a', do: 'b', this_game: 'At 40:00.' } })] });
    expect(rubricOf(late, tide).must_hit.find((p: { id: string }) => p.id === 'lane_deaths_on_low_health')?.hit).toBe(false);
    const early = review({ lang: 'en', findings: [finding({ claim: 'You died on low health in lane.', evidence: [{ refs: ['death:tidehunter:1'], clock: '4:21', fact: '4:21: below half health.' }] })] });
    expect(rubricOf(early, tide).must_hit.find((p: { id: string }) => p.id === 'lane_deaths_on_low_health')?.hit).toBe(true);
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
