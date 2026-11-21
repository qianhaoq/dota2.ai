import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCoachReport } from '../../lib/coach/analyze.js';
import { askSystemPrompt, reportContext } from '../../lib/coach/ask.js';
import { findHero, matchupBrief, matchupLines } from '../../lib/coach/matchupBrief.js';

const MU = JSON.parse(readFileSync(path.join(process.cwd(), 'lib/coach/data/matchups.json'), 'utf8'));
const IV = JSON.parse(readFileSync(path.join(process.cwd(), 'lib/coach/data/item-vs.json'), 'utf8'));
const load = (name: string) => JSON.parse(readFileSync(path.join(process.cwd(), 'src/fixtures/coach', name), 'utf8'));

describe('findHero', () => {
  it('finds a hero by id, slug, English or Chinese name', () => {
    for (const q of [29, '29', 'tidehunter', 'Tidehunter', 'TIDE HUNTER', '潮汐猎人']) expect(findHero(q)?.id, String(q)).toBe(29);
    expect(findHero('anti-mage')?.id).toBe(1);
    expect(findHero('nobody')).toBeNull();
    expect(findHero('')).toBeNull();
  });
});

describe('matchupBrief', () => {
  const b = matchupBrief('潮汐猎人', 'ursa') as any;

  it('reads every number from the snapshots, both directions', () => {
    const [n, mean, p25, p75, ahead] = MU.lane[29][70];
    expect(b.lane).toEqual({ n, gold10_mean: mean, gold10_p25: p25, gold10_p75: p75, ahead: ahead / n, verdict: 'unfavoured' });
    expect(b.win_rate).toMatchObject({ n: MU.vs[29][70][0], verdict: 'even' });
    expect(b.your_items_vs_them.map((x: any) => x.item.key)).toEqual(IV.item_vs[29][70].map((x: any) => x[0]));
    expect(b.their_items_vs_you.map((x: any) => x.item.key)).toEqual(IV.item_vs[70][29].map((x: any) => x[0]));
    expect(b.source).toMatchObject({ since: MU.since, games: MU.games, item_rule: IV.rule });
  });

  it("states Valve's damage type and spell-immunity facts, never a whole-ability dispel claim", () => {
    const fury = b.their_abilities.find((a: any) => a.key === 'ursa_fury_swipes');
    expect(fury).toMatchObject({ damage: { en: 'physical', zh: '物理' }, pierces_immunity: true });
    for (const a of b.their_abilities) expect(a).not.toHaveProperty('dispel');
    expect(matchupLines(b, 'zh').join('\n')).not.toMatch(/驱散/);
  });

  it('says "too few games" instead of a verdict on thin samples', () => {
    const thin = matchupBrief(1, 2) as any; // 11 lane games, 15 win-rate games in the snapshot
    expect(thin.lane).toBeNull();
    expect(thin.win_rate).toBeNull();
    const lines = matchupLines(thin, 'zh');
    expect(lines).toContain('胜率：样本不足');
    expect(lines).toContain('对线：两者同路对位的职业样本不足');
  });

  it('rejects unknown or identical heroes', () => {
    expect(matchupBrief('nobody', 'ursa')).toEqual({ error: 'Unknown hero: nobody' });
    expect(matchupBrief('ursa', 'nobody')).toEqual({ error: 'Unknown hero: nobody' });
    expect(matchupBrief(70, 'ursa')).toEqual({ error: 'Pick two different heroes' });
  });

  it('writes the brief in both languages', () => {
    expect(matchupLines(b, 'zh').slice(0, 3)).toEqual([
      '潮汐猎人 对 熊战士（职业比赛，7.41 以来）',
      `胜率：潮汐猎人 ${Math.round(b.win_rate.wr * 100)}%（${b.win_rate.n} 场，平时 ${Math.round(b.win_rate.base * 100)}%）——没有明显优劣`,
      `对线（双方核心同路）：10 分钟平均落后 304，中间一半在 ${b.lane.gold10_p25} 到 ${b.lane.gold10_p75}，潮汐猎人领先 ${Math.round(b.lane.ahead * 100)}%（${b.lane.n} 场）——熊战士占优`,
    ]);
    expect(matchupLines(b, 'en')[0]).toBe('Tidehunter vs Ursa (pro games since 7.41)');
  });
});

describe('ask context carries the new evidence', () => {
  const r = buildCoachReport(load('match9091400302.parsed.json')) as any;

  it('adds enemy key-item timelines, pro matchups and counter items, and the killer item per death', () => {
    const c = reportContext(r, 0, 'zh');
    expect(c).toContain('## 对方关键装时间线（本局购买记录）');
    expect(c).toContain('- 熊战士: 狂战斧 14:31、闪烁匕首 16:56');
    expect(c).toContain('## 对位（职业比赛统计，7.41 以来；统计关联，不是因果）');
    expect(c).toContain('- 职业潮汐猎人对上熊战士时更常出：Eul的神圣法杖 37%（平时 8%，98 场）');
    expect(c).toContain('22:25 击杀者：熊战士，输掉的团战，掉金 206，击杀者当时最新关键装 阿哈利姆魔晶 18:57');
    // Allies' item timelines are not "enemy" timelines.
    expect(c).not.toMatch(/- 幽鬼: /);
  });

  it('tells the model pro statistics are association with a sample size', () => {
    expect(askSystemPrompt('zh')).toContain('引用时带上场数');
    expect(askSystemPrompt('en')).toContain('cite the number of games');
  });

  it('adds no pro sections for an unparsed match beyond the draft-level matchups', () => {
    const u = buildCoachReport(load('match9091400302.unparsed.json')) as any;
    const c = reportContext(u, 0, 'zh');
    expect(c).not.toContain('对方关键装时间线');
    expect(c).toContain('## 对位（职业比赛统计');
  });
});
