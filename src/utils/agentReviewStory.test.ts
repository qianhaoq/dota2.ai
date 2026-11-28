import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { CHAPTER_TOPICS, runDeepReview, SUBMIT_REVIEW } from '../../lib/agent/deepReview.js';
import { chaptersOf } from '../../lib/agent/review/verify.js';
import { applyTranslation, extractTranslatable } from '../../lib/agent/review/translate.js';

/** Chronological walkthrough chapters: verified chapter by chapter, normalized cleanly, and translated strictly. */
const trace = JSON.parse(gunzipSync(readFileSync(new URL('../../packages/review-engine/test/fixtures/trace-9100904020.json.gz', import.meta.url))).toString());
const scripted = (replies: any[]) => { const seen: any[] = []; let i = 0; return { seen, complete: async (o: any) => { seen.push(JSON.parse(JSON.stringify(o))); return replies[Math.min(i++, replies.length - 1)]; } }; };
const call = (name: string, args: any, id: string) => ({ id, name, args });
const investigate = { toolCalls: [
  call('ability_audit', { hero: 'beastmaster', ability: 'primal_roar' }, 'a'),
  call('death_context', { hero: 'beastmaster', index: 9 }, 'c'),
] };
const finding = {
  title: '咆哮没有留给幻影刺客',
  claim: '27:27 你的咆哮吼中了开着 BKB 的幻影刺客。',
  evidence: [{ refs: ['cast:beastmaster:primal_roar:6'], fact: '27:27 咆哮吼中开着 BKB 的幻影刺客' }],
  fix: '对面核心有 BKB 时，咆哮只留给她。',
};
const chapters = [
  { topic: 'midgame', title: '27:27 关键吼住核心', analysis: '27:27 咆哮吼中开着 BKB 的幻影刺客，她 11 秒后（27:38）阵亡。', evidence: [{ refs: ['cast:beastmaster:primal_roar:6'], fact: '27:27 咆哮吼中开着 BKB 的幻影刺客' }] },
  // A number no tool said: the chapter goes.
  { topic: 'laning', title: '对线崩盘', analysis: '经济落后 9,876。', evidence: [{ refs: ['cast:beastmaster:primal_roar:6'], fact: '27:27 咆哮' }] },
  // One evidence item cites a missing record: that item goes, the chapter stays; an unknown topic normalizes to 'other'.
  { topic: 'unknown_stage', title: '36:05 阵亡细节', analysis: '36:05 满血 2915 阵亡，咆哮就绪没放。', evidence: [{ refs: ['death:beastmaster:9'], fact: '36:05 满血 2915 阵亡' }, { refs: ['fight:99'], fact: '落后' }] },
];
const submit = (extra: any = {}) => ({ toolCalls: [call('submit_review', { verdict: '咆哮没有留给幻影刺客。', highlights: [], chapters, findings: [finding], blind_spots: [], game_plan: null, ...extra }, 's')] });

describe('chronological walkthrough chapters', () => {
  it('schema asks for clean non-templated chapters (no story, no assessment, no takeaway)', () => {
    const s: any = SUBMIT_REVIEW.input_schema;
    expect(s.required).toEqual(['verdict', 'highlights', 'findings', 'chapters', 'game_plan', 'blind_spots']);
    expect(s.properties).not.toHaveProperty('story');
    expect(s.properties).not.toHaveProperty('opening_note');
    expect(s.properties).not.toHaveProperty('encouragement');
    expect(s.properties.chapters.items.required).toEqual(['topic', 'title', 'analysis', 'evidence']);
    expect(Object.keys(s.properties.chapters.items.properties).sort()).toEqual(['analysis', 'evidence', 'title', 'topic']);
    expect(s.properties.chapters.items.properties.topic.enum).toEqual(CHAPTER_TOPICS);
    expect(CHAPTER_TOPICS).toEqual(['draft', 'game_plan', 'laning', 'midgame', 'vision_and_macro', 'skills_and_items', 'other']);
  });

  it('ships only the chapters and evidence items that hold, normalizes unknown topics to other, and names bad chapters in repair', async () => {
    const m = scripted([investigate, submit(), submit()]);
    const r: any = await runDeepReview({ complete: m.complete, trace, hero: 'Beastmaster', lang: 'zh' });
    expect(r.review.chapters.map((c: any) => [c.topic, c.title, c.evidence.map((e: any) => e.refs[0])])).toEqual([
      ['midgame', '27:27 关键吼住核心', ['cast:beastmaster:primal_roar:6']],
      ['other', '36:05 阵亡细节', ['death:beastmaster:9']],
    ]);
    expect(r.review.chapters[0].evidence[0].clock).toBe('27:27');
    const repair = m.seen.find((s: any) => JSON.stringify(s.messages).includes('unsupported_facts'));
    expect(JSON.stringify(repair.messages)).toContain('chapter 2');
  });

  it('chaptersOf drops chapters without holding evidence while soft wording notes remove nothing', () => {
    const refs = new Map([['death:x:1', { at: 65 }]]);
    const list = [
      { topic: 'laning', title: 'Lane', analysis: 'Held lane.', evidence: [{ refs: ['death:x:1'], fact: 'f' }] },
      { topic: 'midgame', title: 'Mid', analysis: 'Fought well.', evidence: [{ refs: ['death:x:1'], fact: 'f' }] },
    ];
    const kept = chaptersOf(list, [{ where: 'chapter_evidence', index: 1, item: 0, kind: 'ref' }, { where: 'chapter', index: 0, kind: 'english', soft: true }] as any, refs as any);
    expect(kept).toEqual([{ topic: 'laning', title: 'Lane', analysis: 'Held lane.', evidence: [{ refs: ['death:x:1'], clock: '1:05', fact: 'f' }] }]);
  });
});

describe('translating a review with chronological chapters', () => {
  const base: any = {
    verdict: 'v 27:27',
    highlights: [],
    findings: [],
    chapters: [{ topic: 'midgame', title: '27:27 团战', analysis: '27:27 吼中，11 秒后阵亡。', evidence: [{ refs: ['cast:x:1'], clock: '27:27', fact: '27:27 吼中' }] }],
    blind_spots: [],
  };

  it('extracts and merges translated chapters while preserving topic, refs, and clocks', () => {
    const x: any = extractTranslatable(base);
    expect(x.chapters).toEqual([{ title: '27:27 团战', analysis: '27:27 吼中，11 秒后阵亡。', evidence: ['27:27 吼中'] }]);
    const t: any = applyTranslation(base, {
      verdict: 'v 27:27',
      highlights: [],
      findings: [],
      chapters: [{ title: '27:27 fight', analysis: 'Roared her at 27:27; died 11 s later.', evidence: ['Roared her at 27:27'] }],
      blind_spots: [],
    }, 'en');
    expect(t.chapters[0]).toEqual({ topic: 'midgame', title: '27:27 fight', analysis: 'Roared her at 27:27; died 11 s later.', evidence: [{ refs: ['cast:x:1'], clock: '27:27', fact: 'Roared her at 27:27' }] });
  });

  it('refuses a translation that alters a number in a chapter', () => {
    expect(applyTranslation(base, {
      verdict: 'v 27:27',
      highlights: [],
      findings: [],
      chapters: [{ title: '27:27 fight', analysis: 'Roared her at 27:27; died 12 s later.', evidence: ['Roared her at 27:27'] }],
      blind_spots: [],
    }, 'en')).toBeNull();
  });
});
