import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { runTraceTool } from '../../packages/review-engine/src/trace/index.js';
import { linkHeroNames } from '../../packages/review-engine/src/trace/build.js';
import { verifyReview, staysClaims } from '../../lib/agent/review/verify.js';

const trace = linkHeroNames(JSON.parse(gunzipSync(readFileSync(new URL('../../packages/review-engine/test/fixtures/trace-9100904020.json.gz', import.meta.url))).toString()));
/** Beastmaster's deaths: 0:47 came 2859 closer to his fountain, 11:03 1568; 2:51 went 655 away from it. */
const deaths = runTraceTool(trace, 'death_context', { hero: 'beastmaster' });
const sources = [deaths];
const finding = (title: string, claim: string, refs: string[]) => ({ title, claim, evidence: refs.map((r) => ({ refs: [r], fact: '阵亡。' })), fix: '换一种打法。' });
const review = (...findings: any[]) => ({ verdict: '结论。', mainline: [], findings, did_well: [], next_game: [], blind_spots: [] });
const notes = (r: any) => verifyReview(r, sources).problems.filter((p: any) => p.kind === 'heading');

describe('a finding that says the player stayed, about a death the record shows them leaving (#417)', () => {
  it('the wording it looks for', () => {
    expect(staysClaims('队友倒下后仍在原地与熊战士换血')).toHaveLength(1);
    expect(staysClaims('对线期半血还在一线换血')).toHaveLength(1);
    expect(staysClaims('You stayed in the lane and kept trading')).toHaveLength(1);
    expect(staysClaims('你往自家方向退，被追上')).toEqual([]);
  });

  it('asks once, about the cited death heading home, and removes nothing', () => {
    const r = review(finding('仍在原地换血', '你在线上继续站着换血。', ['death:beastmaster:5']));
    expect(notes(r)).toEqual([{ where: 'finding', index: 0, kind: 'heading', text: '11:03: 1568 closer to the fountain', soft: true }]);
    // Soft: the finding is not unsupported for it.
    expect(verifyReview(r, sources).unsupported.findings.has(0)).toBe(false);
  });

  it('also when the claim names the death by its time instead of citing it', () => {
    const r = review(finding('还在原地硬拼', '0:47 你还在原地和对面换血。', ['deaths:beastmaster']));
    expect(notes(r).map((n: any) => n.text)).toEqual(['0:47: 2859 closer to the fountain']);
  });

  it('not for a death that was not heading home, nor for words that do not say "stayed"', () => {
    expect(notes(review(finding('仍在原地换血', '你继续站着换血。', ['death:beastmaster:2'])))).toEqual([]);
    expect(notes(review(finding('撤退晚了', '你往家走的时候被追上。', ['death:beastmaster:5'])))).toEqual([]);
  });

  it('not when the tools never gave a heading (an older run, or another tool)', () => {
    const r = review(finding('仍在原地换血', '你继续站着换血。', ['death:beastmaster:5']));
    expect(verifyReview(r, []).problems.filter((p: any) => p.kind === 'heading')).toEqual([]);
  });
});
