import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { runDeepReview, SUBMIT_REVIEW } from '../../lib/agent/deepReview.js';
import { mainlineOf, storyOf } from '../../lib/agent/review/verify.js';
import { applyTranslation, extractTranslatable } from '../../lib/agent/review/translate.js';
import { STORY_WHOSE } from '../../lib/agent/review/schema.js';

/** The story of the game as a chain of causes (#437 P4): handed in by the model, checked link by link, shipped. */
const trace = JSON.parse(gunzipSync(readFileSync(new URL('../../packages/review-engine/test/fixtures/trace-9100904020.json.gz', import.meta.url))).toString());
const scripted = (replies: any[]) => { const seen: any[] = []; let i = 0; return { seen, complete: async (o: any) => { seen.push(JSON.parse(JSON.stringify(o))); return replies[Math.min(i++, replies.length - 1)]; } }; };
const call = (name: string, args: any, id: string) => ({ id, name, args });
const investigate = { toolCalls: [
  call('ability_audit', { hero: 'beastmaster', ability: 'primal_roar' }, 'a'),
  call('death_context', { hero: 'beastmaster', index: 9 }, 'c'),
] };
const finding = (link: number) => ({
  title: '咆哮没有留给幻影刺客', claim: '27:27 你的咆哮吼中了开着 BKB 的幻影刺客。',
  evidence: [{ refs: ['cast:beastmaster:primal_roar:6'], fact: '27:27 咆哮吼中开着 BKB 的幻影刺客' }],
  fix: '对面核心有 BKB 时，咆哮只留给他。', story_link: link,
});
const story = [
  { phase: '27:27 那波团', what_changed: '27:27 咆哮吼中开着 BKB 的幻影刺客', because: '她 11 秒后（27:38）阵亡', whose: 'me', evidence: [{ refs: ['cast:beastmaster:primal_roar:6'], fact: '27:27 咆哮吼中开着 BKB 的幻影刺客' }] },
  // A number no tool said: the link goes.
  { phase: '30:00 之后', what_changed: '经济落后 9,876', because: '团战连输', whose: 'team', evidence: [{ refs: ['cast:beastmaster:primal_roar:6'], fact: '27:27 咆哮' }] },
  // One evidence item cites a record that does not exist: that item goes, the link stays; a whose off the list reads unclear.
  { phase: '36:05 前后', what_changed: '36:05 你阵亡', because: '咆哮就绪没放', whose: 'nobody', evidence: [{ refs: ['death:beastmaster:9'], fact: '36:05 阵亡' }, { refs: ['fight:99'], fact: '落后' }] },
];
const submit = (extra: any = {}) => ({ toolCalls: [call('submit_review', { verdict: '咆哮没有留给幻影刺客。', story, findings: [finding(3), finding(2)], blind_spots: [], game_plan: null, ...extra }, 's')] });

describe('the story', () => {
  it('a phase\'s times are checked like any other: a stretch boundary no tool gave is not one', async () => {
    const bad = [{ ...story[0], phase: '27:00–28:00，团战' }, story[2]];
    const m = scripted([investigate, submit({ story: bad })]);
    const r: any = await runDeepReview({ complete: m.complete, trace, hero: 'Beastmaster', lang: 'zh' });
    expect(r.review.story.map((l: any) => l.phase)).toEqual(['36:05 前后']);
  });

  it('is what the model is asked for, in place of the one-line phases', () => {
    const s: any = SUBMIT_REVIEW.input_schema;
    expect(s.required).toContain('story');
    expect(s.required).not.toContain('mainline');
    expect(s.properties.story.items.required).toEqual(['phase', 'what_changed', 'because', 'whose', 'evidence']);
    expect(s.properties.story.items.properties.whose.enum).toEqual(STORY_WHOSE);
  });

  it('ships the links that hold, with only the evidence that holds, and the one-line phases read off them', async () => {
    const m = scripted([investigate, submit()]);
    const r: any = await runDeepReview({ complete: m.complete, trace, hero: 'Beastmaster', lang: 'zh' });
    expect(r.review.story.map((l: any) => [l.phase, l.whose, l.evidence.map((e: any) => e.refs[0])])).toEqual([
      ['27:27 那波团', 'me', ['cast:beastmaster:primal_roar:6']],
      ['36:05 前后', 'unclear', ['death:beastmaster:9']],
    ]);
    expect(r.review.story[0].evidence[0].clock).toBe('27:27');
    expect(r.review.mainline).toEqual(['27:27 那波团：27:27 咆哮吼中开着 BKB 的幻影刺客。她 11 秒后（27:38）阵亡', '36:05 前后：36:05 你阵亡。咆哮就绪没放']);
    expect(r.verification.story_dropped).toBe(1);
    // A finding's link follows its link: the third became the second; one on the dropped link loses it.
    expect(r.review.findings.map((f: any) => f.story_link)).toEqual([2, undefined]);
    // The dropped link was asked about once in the repair round, by its place.
    const repair = m.seen.find((s: any) => JSON.stringify(s.messages).includes('unsupported_facts'));
    expect(JSON.stringify(repair.messages)).toContain('story 2');
  });

  it('a review handed in without a story keeps its checked one-line phases (an older shape)', async () => {
    const { story: _s, ...rest } = submit().toolCalls[0].args as any;
    const m = scripted([investigate, { toolCalls: [call('submit_review', { ...rest, mainline: ['27:27 咆哮吼中幻影刺客。'] }, 's')] }]);
    const r: any = await runDeepReview({ complete: m.complete, trace, hero: 'Beastmaster', lang: 'zh' });
    expect(r.review.story).toBeUndefined();
    expect(r.review.mainline).toEqual(['27:27 咆哮吼中幻影刺客。']);
  });
});

describe('storyOf and mainlineOf', () => {
  it('a link with no evidence that holds is not shipped; wording alone removes nothing', () => {
    const refs = new Map([['death:x:1', { at: 65 }]]);
    const links = [{ phase: 'p', what_changed: 'w', because: 'b', whose: 'team', evidence: [{ refs: ['death:x:1'], fact: 'f' }] }, { phase: 'p2', what_changed: 'w', because: 'b', whose: 'me', evidence: [{ refs: ['death:x:1'], fact: 'f' }] }];
    const r = storyOf(links, [{ where: 'story_evidence', index: 1, item: 0, kind: 'ref' }, { where: 'story', index: 0, kind: 'english', soft: true }] as any, refs as any);
    expect(r.kept).toEqual([0]);
    expect(r.links[0]).toEqual({ phase: 'p', what_changed: 'w', because: 'b', whose: 'team', evidence: [{ refs: ['death:x:1'], clock: '1:05', fact: 'f' }] });
    expect(mainlineOf(r.links, 'en')).toEqual(['p: w. b']);
  });
});

describe('translating a review with a story', () => {
  const base: any = {
    verdict: 'v 27:27', story: [{ phase: '27:00', what_changed: '27:27 吼中', because: '11 秒后阵亡', whose: 'me', evidence: [{ refs: ['cast:x:1'], clock: '27:27', fact: '27:27 吼中' }] }],
    mainline: ['27:00：27:27 吼中。11 秒后阵亡'], findings: [], did_well: [], blind_spots: [],
  };
  it('sends the story, not the phases read off it, and rebuilds them from the translation', () => {
    const x: any = extractTranslatable(base);
    expect(x.story).toEqual([{ phase: '27:00', what_changed: '27:27 吼中', because: '11 秒后阵亡', evidence: ['27:27 吼中'] }]);
    expect(x.mainline).toBeUndefined();
    const t: any = applyTranslation(base, { verdict: 'v 27:27', story: [{ phase: '27:00', what_changed: 'Roared her at 27:27', because: 'she died 11 s later', evidence: ['Roared her at 27:27'] }], findings: [], did_well: [], blind_spots: [] }, 'en');
    expect(t.story[0]).toMatchObject({ what_changed: 'Roared her at 27:27', whose: 'me', evidence: [{ refs: ['cast:x:1'], clock: '27:27', fact: 'Roared her at 27:27' }] });
    expect(t.mainline).toEqual(['27:00: Roared her at 27:27. she died 11 s later']);
  });
  it('a translation that changes a number in the story is refused', () => {
    expect(applyTranslation(base, { verdict: 'v 27:27', story: [{ phase: '27:00', what_changed: 'Roared her at 27:27', because: 'she died 12 s later', evidence: ['Roared her at 27:27'] }], findings: [], did_well: [], blind_spots: [] }, 'en')).toBeNull();
  });
});
