import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCoachReport } from '../../lib/coach/analyze.js';
import { askMessages, fallbackAnswer } from '../../lib/coach/ask.js';

const load = (f: string) => JSON.parse(readFileSync(path.join(process.cwd(), 'src/fixtures/coach', f), 'utf8'));
const raw = load('match9091400302.parsed.json');
const r = buildCoachReport(raw);
const why = (slot: number) => r.reviews[slot].chapters.story.why as any[];
const byKey = (slot: number, id: string) => why(slot).find((c) => c.id === id);

describe('story "why": the gap split into causes', () => {
  it('splits the 10:00 deficit by lane, worst first, with the replay numbers', () => {
    const lanes = why(0).filter((c) => c.phase === 'early');
    expect(lanes.map((c) => c.id)).toEqual(['lane.2', 'lane.1', 'lane.3']);
    const mid = byKey(0, 'lane.2');
    expect(mid.title.zh).toBe('中路：天怒法师压过帕吉，10 分钟经济差 1.1k');
    expect(mid.evidence.map((e: any) => e.zh)).toEqual(expect.arrayContaining(['正补：帕吉 31 对 天怒法师 49', '经验：−1.5k']));
    // A kill by a hero from another lane is called a rotation.
    expect(mid.evidence.at(-1).zh).toContain('帕吉 9:02 死于破晓辰星（游走）');
    // Lane gold sums equal the raw gold_t at 10:00.
    const g10 = (p: any) => p.gold_t[10];
    const pudge = raw.players.find((p: any) => p.hero_id === 14); const sky = raw.players.find((p: any) => p.hero_id === 101);
    expect(mid.impact).toBe(g10(pudge) - g10(sky));
  });

  it('gives a fix only for your own lane, from what the numbers show', () => {
    const top = byKey(0, 'lane.3'); // Tidehunter's lane
    expect(top.mine).toBe(true);
    expect(top.fix.zh).toContain('10 分钟前在自己线上被森海飞霞、熊战士杀了 3 次');
    expect(byKey(0, 'lane.2').fix).toBeNull();
    expect(byKey(3, 'lane.2').fix.zh).toContain('破晓辰星从别的线游走过来'); // Pudge's view of mid
  });

  it('explains the lost fights: numbers, the gold they started from, who carried them', () => {
    const behind = byKey(0, 'fights.behind');
    expect(behind.title.zh).toMatch(/^\d+ 波输掉的团战，开打时平均落后 [\d.]+k 经济$/);
    expect(behind.evidence[0].zh).toMatch(/人数不少于对方——输在装备和等级/);
    const carrier = byKey(0, 'fights.carrier');
    expect(carrier.title.zh).toBe('10 波输掉的团战里，7 波伤害最高的是熊战士');
    const out = byKey(0, 'fights.outnumbered');
    expect(out.evidence.map((e: any) => e.zh)).toEqual(['23:55：3 打 4，缺暗影萨满、术士', '37:26：3 打 4，缺潮汐猎人、术士']);
  });

  it('turns an answer item you already had into a timing lesson, from the purchase log', () => {
    expect(byKey(0, 'fights.carrier').fix.zh).toContain('你出了幽魂权杖，但在 41:46 才做出，此前已经输了 9 波');
    // Spectre had no answer: name the options for a core instead.
    expect(byKey(4, 'fights.carrier').fix.zh).toContain('你作为核心，在下一波大团前做出 幽魂权杖、天堂之戟、刃甲 之一');
  });

  it('is absent without a parse, never invented', () => {
    expect(buildCoachReport(load('match9091400302.unparsed.json')).reviews[0].chapters).toBeNull();
  });

  it('reaches the follow-up: the AI context lists causes; the offline answer to "why" uses them', () => {
    const msgs = askMessages({ report: r, slot: 0, lang: 'zh', question: '为什么输', history: [] });
    const ctx = msgs.map((m: any) => m.content).join('\n');
    expect(ctx).toContain('为什么（按影响排序，每条附依据）');
    expect(ctx).toContain('上路：熊战士、森海飞霞压过潮汐猎人、暗影萨满，10 分钟经济差 724（与你有关）');
    const ans = fallbackAnswer({ report: r, slot: 0, lang: 'zh', question: '为什么输了' });
    expect(ans).toContain('**10 波输掉的团战里，7 波伤害最高的是熊战士**');
    expect(ans).toContain('- 怎么做：');
  });
});
