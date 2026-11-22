import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { collectFacts, deepReviewSystem, runDeepReview, statedFacts, SUBMIT_REVIEW, verifyReview, DEEP_REVIEW_SCHEMA } from '../../lib/agent/deepReview.js';

const trace = JSON.parse(gunzipSync(readFileSync(new URL('../../packages/review-engine/test/fixtures/trace-9100904020.json.gz', import.meta.url))).toString());
const scripted = (replies: any[]) => { const seen: any[] = []; let i = 0; return { seen, complete: async (o: any) => { seen.push(JSON.parse(JSON.stringify(o))); return replies[Math.min(i++, replies.length - 1)]; } }; };
const call = (name: string, args: any, id: string) => ({ id, name, args });

const investigate = { toolCalls: [
  call('ability_audit', { hero: 'beastmaster', ability: 'primal_roar' }, 'a'),
  call('immunity_windows', { hero: 'phantom_assassin', watch_hero: 'beastmaster', watch_ability: 'primal_roar' }, 'b'),
  call('death_context', { hero: 'beastmaster', index: 9 }, 'c'),
] };
const good = {
  title: '咆哮没有留给幻影刺客的 BKB',
  claim: '幻影刺客开了 7 次 BKB，只有 27:27 那次你的咆哮吼中了她。',
  evidence: [{ clock: '27:27', fact: '咆哮吼中开着 BKB 的幻影刺客，她 11 秒后阵亡' }, { clock: '30:25', fact: '咆哮给了瘟疫法师，9 秒后幻影刺客开 BKB' }, { clock: '36:05', fact: '满血 2915，咆哮就绪没放' }],
  fix: '对面核心有 BKB 时，咆哮只留给他。',
};
const invented = { title: '打钱', claim: '你 19:19 的经济只有 9,876。', evidence: [{ clock: '19:19', fact: '落后 4.2k' }], fix: '多刷野。' };
const review = (findings: any[], extra: any = {}) => ({ verdict: '咆哮没有留给幻影刺客的 BKB。', mainline: ['30:25 的咆哮给了瘟疫法师。'], findings, next_game: ['咆哮留给带 BKB 的核心'], blind_spots: ['视野'], ...extra });

describe('fact collection', () => {
  it('reads clocks and numbers out of tool results and review text', () => {
    const f = collectFacts({ t: 1647.4, clock: '27:27', hp: 2915, note: 'died at 36:05 with 1,455 mana', list: [{ from: 1834.2 }] });
    expect([...f.times].sort((a, b) => a - b)).toEqual([1647, 1834, 2165]);
    expect(f.numbers.has(2915)).toBe(true);
    expect(statedFacts('27:27 满血 2,915，落后 4.2k，杀了 7 次，10:05:11 不是时间')).toEqual({ times: ['27:27'], numbers: [{ text: '2,915', value: 2915, approx: false }, { text: '4.2k', value: 4200, approx: true }] });
  });
  it('passes what the tools said and names what they did not', () => {
    const sources = [{ t: 1647.4, hp: 2915, gold: 4298 }];
    expect(verifyReview(review([{ title: 't', claim: '27:25 时 2915 血，领先 4.3k', evidence: [{ clock: '27:27', fact: 'x' }], fix: 'f' }], { verdict: 'v', mainline: [] }), sources)).toEqual({ ok: true, problems: [] });
    expect(verifyReview(review([invented], { verdict: '19:19 输了', mainline: ['27:27 好', '5:00 坏'], did_well: ['打了 3000 伤害'] }), sources).problems).toEqual([
      { where: 'verdict', index: 0, kind: 'time', text: '19:19' },
      { where: 'mainline', index: 1, kind: 'time', text: '5:00' },
      { where: 'did_well', index: 0, kind: 'number', text: '3000' },
      { where: 'finding', index: 0, kind: 'time', text: '19:19' },
      { where: 'finding', index: 0, kind: 'number', text: '9,876' },
    ]);
    // "4.2k" in that finding stands: a rounded figure within 6% of the 4298 a tool returned.
  });
});

describe('runDeepReview', () => {
  it('investigates with the trace tools and returns the verified review', async () => {
    const m = scripted([investigate, { toolCalls: [call('submit_review', review([good]), 's')] }]);
    const r: any = await runDeepReview({ complete: m.complete, trace, hero: 'Beastmaster', lang: 'zh' });
    expect(r.status).toBe('ok');
    expect(r.review).toMatchObject({ schema: DEEP_REVIEW_SCHEMA, match_id: 9100904020, hero: 'beastmaster', lang: 'zh', findings: [good], verdict: '咆哮没有留给幻影刺客的 BKB。' });
    expect(r.verification).toEqual({ repaired: false, dropped: 0, problems: [] });
    expect(r.tool_calls.map((c: any) => c.name)).toEqual(['ability_audit', 'immunity_windows', 'death_context']);
    // The model is told who it reviews and what to call the heroes, in the reader's language.
    expect(m.seen[0].system).toContain('简体中文');
    expect(m.seen[0].messages[0].content).toContain('"player_hero":"beastmaster"');
    expect(m.seen[0].messages[0].content).toContain('"necrolyte":"瘟疫法师"');
    expect(m.seen[0].tools.map((t: any) => t.name)).toEqual(['match_overview', 'death_context', 'ability_audit', 'immunity_windows', 'fight_timeline', 'submit_review']);
    // The tool results the model read are the real ones.
    expect(JSON.parse(m.seen[1].messages.find((x: any) => x.tool_call_id === 'a').content).casts_total).toBe(10);
  });

  it('asks once for a repair, then drops what is still unsupported', async () => {
    const m = scripted([investigate, { toolCalls: [call('submit_review', review([good, invented]), 's1')] }, { toolCalls: [call('submit_review', review([good, invented], { verdict: '19:19 崩了', mainline: ['27:27 吼中', '19:19 崩'] }), 's2')] }]);
    const r: any = await runDeepReview({ complete: m.complete, trace, hero: 'beastmaster', lang: 'zh' });
    expect(r.status).toBe('ok');
    expect(r.review.findings).toEqual([good]);
    expect(r.review.mainline).toEqual(['27:27 吼中']);
    // An unsupported verdict falls back to the first finding that stands.
    expect(r.review.verdict).toBe(good.title);
    expect(r.verification).toMatchObject({ repaired: true, dropped: 1 });
    const repair = JSON.parse(m.seen[2].messages.at(-1).content);
    expect(repair).toMatchObject({ error: 'unsupported_facts', problems: expect.arrayContaining([{ in: 'finding 2', kind: 'time', text: '19:19' }]) });
    expect(m.seen).toHaveLength(3);
  });

  it('a repair that looks the fact up is accepted', async () => {
    const lane = { title: '一血', claim: '0:47 被击杀时身边没有队友。', evidence: [{ clock: '0:47', fact: '一血' }], fix: '等兵线。' };
    const m = scripted([investigate, { toolCalls: [call('submit_review', review([good, lane]), 's1')] }, { toolCalls: [call('death_context', { hero: 'beastmaster', index: 1 }, 'd')] }, { toolCalls: [call('submit_review', review([good, lane]), 's2')] }]);
    const r: any = await runDeepReview({ complete: m.complete, trace, hero: 'beastmaster' });
    expect(r.review.findings).toEqual([good, lane]);
    expect(r.verification).toEqual({ repaired: true, dropped: 0, problems: [] });
  });

  it('reports no review, nothing verifiable, and an unknown hero', async () => {
    expect(await runDeepReview({ complete: scripted([{ text: 'I think you played fine.' }]).complete, trace, hero: 'beastmaster' })).toMatchObject({ status: 'no_review' });
    expect(await runDeepReview({ complete: scripted([{ toolCalls: [call('submit_review', review([invented]), 's')] }]).complete, trace, hero: 'beastmaster' })).toMatchObject({ status: 'unverified', review: { findings: [] }, verification: { dropped: 1 } });
    expect(await runDeepReview({ complete: scripted([]).complete, trace, hero: 'pudge' })).toMatchObject({ status: 'unknown_hero', heroes: expect.arrayContaining(['beastmaster']) });
  });

  it('the scoreboard goes in without names or account ids', async () => {
    const m = scripted([{ toolCalls: [call('submit_review', review([{ ...good, evidence: [] , claim: '9 杀 11 死。' }]), 's')] }]);
    await runDeepReview({ complete: m.complete, trace, hero: 'beastmaster', match: { players: [{ hero_id: 38, kills: 9, deaths: 11, assists: 18, net_worth: 16953, gold_per_min: 450, last_hits: 260, personaname: 'someone', account_id: 123456789 }] } });
    const first = m.seen[0].messages[0].content;
    expect(first).toContain('"scoreboard":{"kills":9,"deaths":11,"assists":18,"net_worth":16953,"gold_per_min":450,"last_hits":260}');
    expect(first).not.toContain('someone');
    expect(first).not.toContain('123456789');
  });

  it('the prompt states the rules the verifier enforces', () => {
    const s = deepReviewSystem('en');
    expect(s).toContain('MUST write ALL analysis and advice in English');
    expect(s).toContain('must come from a tool result');
    expect(s).toContain('submit_review exactly once');
    expect(SUBMIT_REVIEW.input_schema.properties.findings.maxItems).toBe(3);
  });
});
