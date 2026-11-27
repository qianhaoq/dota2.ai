import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { runTraceTool } from '../../packages/review-engine/src/trace/index.js';
import { linkHeroNames } from '../../packages/review-engine/src/trace/build.js';
import { verifyReview, staysClaims } from '../../lib/agent/review/verify.js';

const trace = linkHeroNames(JSON.parse(gunzipSync(readFileSync(new URL('../../packages/review-engine/test/fixtures/trace-9100904020.json.gz', import.meta.url))).toString()));
/** Beastmaster's deaths: 0:47 came 2859 closer to his fountain, 11:03 1568; 2:51 went 655 away from it. */
const deaths = runTraceTool(trace, 'death_context', { hero: 'beastmaster' });
/** As a review run has them: the opening context (whose game it is) and the tools' answers. */
const sources = [{ player_hero: 'beastmaster' }, deaths];
const finding = (title: string, claim: string, refs: string[]) => ({ title, claim, evidence: refs.map((r) => ({ refs: [r], fact: '阵亡。' })), fix: '换一种打法。' });
const review = (...findings: any[]) => ({ verdict: '结论。', mainline: [], findings, did_well: [], next_game: [], blind_spots: [] });
const notes = (r: any) => verifyReview(r, sources).problems.filter((p: any) => p.kind === 'heading');

describe('a finding that says the player stayed, about a death the record shows them leaving (#417)', () => {
  it('the wording it looks for', () => {
    expect(staysClaims('队友倒下后仍在原地与熊战士换血')).toHaveLength(1);
    // Trading is not holding position: one can trade while heading home (Codex P1 on #427).
    expect(staysClaims('对线期半血还在一线换血')).toEqual([]);
    expect(staysClaims('11:03 你往家退的过程中仍在换血。')).toEqual([]);
    expect(staysClaims('你没有撤，留在原地')).toEqual(['没有撤', '留在原地']);
    expect(staysClaims('You stayed in the lane and kept trading')).toEqual(['stayed in the lane']);
    expect(staysClaims('你往自家方向退，被追上')).toEqual([]);
    // A denial agrees with a retreat (Codex P1 on #427).
    expect(staysClaims('你没有继续换血，而是往家退时被追上。')).toEqual([]);
    expect(staysClaims('You did not stay to fight; you retreated and were caught.')).toEqual([]);
  });

  it('a denial of staying is not sent back, in either language (Codex P1 on #427)', () => {
    expect(notes(review(finding('撤退时被追上', '你没有继续换血，而是往家退时被追上。', ['death:beastmaster:5'])))).toEqual([]);
    expect(notes(review(finding('Caught on the way home', 'You did not stay to fight; you retreated and were caught.', ['death:beastmaster:5'])))).toEqual([]);
  });

  it('each "stayed" is about the death its own clause names (Codex P1 on #427)', () => {
    // 2:51 went 655 away from home and 11:03 came 1568 closer: only the trading clause is about 2:51.
    const r = review(finding('前期两次阵亡', '2:51 你继续换血；11:03 你往家退时被追上。', ['death:beastmaster:2', 'death:beastmaster:5']));
    expect(notes(r)).toEqual([]);
    // The same, the other way round: the trading clause names 11:03.
    expect(notes(review(finding('前期两次阵亡', '2:51 你往前走被抓；11:03 你留在原地换血。', ['death:beastmaster:2', 'death:beastmaster:5']))).map((n: any) => n.text)).toEqual(['11:03: 1568 closer to the fountain']);
  });

  it('trading while heading home is not sent back (Codex P1 on #427)', () => {
    expect(notes(review(finding('边撤边换血', '11:03 你往家退的过程中仍在换血。', ['death:beastmaster:5'])))).toEqual([]);
  });

  it('English "stay" only when it says where: "stay alive" is not holding position (Codex P1 on #427)', () => {
    expect(staysClaims('You tried to stay alive while retreating toward home, but were caught.')).toEqual([]);
    expect(notes(review(finding('Caught on the way home', 'You tried to stay alive while retreating toward home, but were caught.', ['death:beastmaster:5'])))).toEqual([]);
    expect(staysClaims('You stayed in the lane')).toEqual(['stayed in the lane']);
  });

  it('a time is matched to the player\'s own death, not to another hero who died then (Codex P1 on #427)', () => {
    // 7:15: Venomancer died 724 farther from home, Necrolyte 1631 closer. A Venomancer review sees both answers.
    const both = [{ player_hero: 'venomancer' }, runTraceTool(trace, 'death_context', { hero: 'venomancer' }), runTraceTool(trace, 'death_context', { hero: 'necrolyte' })];
    const r = review(finding('继续换血', '7:15 你留在原地换血。', ['death:venomancer:4']));
    expect(verifyReview(r, both).problems.filter((p: any) => p.kind === 'heading')).toEqual([]);
    // Necrolyte's own review, the same sentence: his death was heading home.
    const his = [{ player_hero: 'necrolyte' }, both[1], both[2]];
    expect(verifyReview(review(finding('继续换血', '7:15 你留在原地换血。', ['deaths:necrolyte'])), his).problems.filter((p: any) => p.kind === 'heading').map((p: any) => p.text)).toEqual(['7:15: 1631 closer to the fountain']);
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
