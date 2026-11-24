import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { runTraceTool } from '../../packages/review-engine/src/trace/index.js';
import { resolveRef } from '../../lib/agent/evidence.js';
import { reviewToolkit, verifyReview } from '../../lib/agent/deepReview.js';

const trace = JSON.parse(gunzipSync(readFileSync(new URL('../../packages/review-engine/test/fixtures/trace-9100904020.json.gz', import.meta.url))).toString());

describe('tempo_report as evidence', () => {
  const tempo = runTraceTool(trace, 'tempo_report', { hero: 'beastmaster' }, { perspective: 'beastmaster' });
  const review = (o: any) => ({ verdict: 'v', mainline: [], findings: [{ title: '赢了团没有换成塔', claim: '少死人的团战之后没有推进。', fix: 'x', evidence: [] }], ...o });
  const evidence = (refs: string[], fact: string) => review({ findings: [{ title: 't', claim: 'c', fix: 'x', evidence: [{ refs, fact }] }] });

  it('the agent can call it, told from the player\'s side', () => {
    const kit: any = reviewToolkit({ trace, hero: 'beastmaster', lang: 'zh' });
    expect(kit.tools.map((t: any) => t.name)).toContain('tempo_report');
    expect(kit.runTool('tempo_report', { hero: 'beastmaster' })).toMatchObject({ tool: 'tempo_report', ref: 'tempo:beastmaster', side: 'me' });
    expect(kit.runTool('tempo_report', { hero: 'phantom_assassin' })).toMatchObject({ side: 'enemy' });
  });

  it('the summary and each stretch resolve to the record a reader is shown', () => {
    const whole: any = resolveRef(trace, 'tempo:beastmaster', { hero: 'beastmaster', lang: 'zh' });
    expect(whole).toMatchObject({ ref: 'tempo:beastmaster', kind: 'tempo', record: { buildings_total: { team_took: 4, opponents_took: 18 }, fights_total: 16 }, names: { beastmaster: '兽王', sven: '斯温' } });
    // The summary is the counts, not the stretches below it.
    expect(whole.record).not.toHaveProperty('phases');
    expect(whole.record).not.toHaveProperty('gaps');
    const p: any = resolveRef(trace, 'phase:beastmaster:3', { hero: 'beastmaster', lang: 'zh' });
    expect(p).toMatchObject({ ref: 'phase:beastmaster:3', kind: 'phase', record: { clock: '20:00–30:00', buildings_opponents_took: 3 } });
    // The places a stretch names are the tools' region keys, named for the reader like every other key.
    expect(p.names).toMatchObject({ radiant_top_lane: '天辉上路', dire_bot_lane: '夜魇下路', undying: '不朽尸王' });
    expect(resolveRef(trace, 'phase:beastmaster:3', { hero: 'beastmaster', lang: 'en' })!.names.radiant_top_lane).toBe('Radiant top lane');
    for (const bad of ['phase:beastmaster:9', 'phase:beastmaster', 'phase:beastmaster:3:x', 'phase:pudge:1', 'tempo:beastmaster:1', 'tempo:pudge']) expect(resolveRef(trace, bad, { hero: 'beastmaster' })).toBeNull();
  });

  it('a sentence may quote its counts, and a stretch backs only what happened in it', () => {
    // The tool's own counts, in prose: six fights with fewer lost and one building after them; twelve buildings lost in the last stretch.
    expect(verifyReview(review({ verdict: '你们赢了 6 波团，只有 22:57 那一波之后拆到了塔；对面 9 波里有 5 波之后推掉了建筑。', mainline: ['40:00–42:31 丢了 12 座建筑，18:07 才拆掉第一座塔。'] }), [tempo]).problems.filter((x: any) => x.where !== 'finding')).toEqual([]);
    // A count the tool never gave is still caught.
    expect(verifyReview(review({ verdict: '你们赢了 8 波团。' }), [tempo]).problems.filter((x: any) => x.where !== 'finding')).toEqual([expect.objectContaining({ where: 'verdict', kind: 'count', text: '8' })]);
    const ok = (refs: string[], fact: string) => verifyReview(evidence(refs, fact), [tempo]).problems;
    expect(ok(['phase:beastmaster:3'], '20:00–30:00 你 32% 的存活时间在天辉上路，这 10 分钟对面拆了 3 座塔（20:02、24:28、25:59），你们只在 25:05 拆了 1 座。')).toEqual([]);
    expect(ok(['tempo:beastmaster'], '16 波团战里你到场 15 波；你们拆掉的 4 座建筑里 18:07 那座你没有打到。')).toEqual([]);
    // 12 buildings fell in the last stretch, not in this one; and the summary does not hold a stretch's shares.
    expect(ok(['phase:beastmaster:3'], '20:00–30:00 对面拆了 12 座建筑。')).toEqual([expect.objectContaining({ kind: 'moment' })]);
    expect(ok(['tempo:beastmaster'], '你 32% 的存活时间在天辉上路。')).toEqual([expect.objectContaining({ kind: 'moment' })]);
  });
});
