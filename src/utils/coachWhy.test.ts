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
    // Shadow Shaman and Warlock healed in 23:55 and 37:26: present, like the fights chapter says.
    expect(byKey(0, 'fights.outnumbered')).toBeUndefined();
  });

  it('agrees with the fights chapter on who was there: healing-only counts as present', () => {
    const m = structuredClone(raw);
    const f = m.teamfights.find((x: any) => x.start === 1435);
    for (const i of [1, 2]) Object.assign(f.players[i], { healing: 0, ability_uses: {}, item_uses: {} });
    const g = m.teamfights.find((x: any) => x.start === 2246);
    for (const i of [1, 2]) Object.assign(g.players[i], { healing: 0, ability_uses: {}, item_uses: {} });
    const out = buildCoachReport(m).reviews[0].chapters.story.why.find((c: any) => c.id === 'fights.outnumbered');
    expect(out.evidence.map((e: any) => e.zh)).toEqual(['23:55：3 打 4，缺暗影萨满、术士', '37:26：2 打 4，缺潮汐猎人、暗影萨满、术士']);
  });

  it('never fills missing data: no XP line without XP timelines, no deficit without the gold graph', () => {
    const m = structuredClone(raw);
    for (const p of m.players) if (p.isRadiant && [29, 27].includes(p.hero_id)) delete p.xp_t; // Tidehunter, Shadow Shaman
    const top = buildCoachReport(m).reviews[0].chapters.story.why.find((c: any) => c.id === 'lane.3');
    expect(top.evidence.some((e: any) => e.zh.startsWith('经验'))).toBe(false);
    const n = structuredClone(raw);
    for (const p of n.players) if (p.isRadiant) { delete p.networth_t; }
    const behind = buildCoachReport(n).reviews[0].chapters.story.why.find((c: any) => c.id === 'fights.behind');
    // Deficits come from the team gold graph, not summed player timelines.
    expect(behind.evidence[1].zh).toBe(byKey(0, 'fights.behind').evidence[1].zh);
    delete n.radiant_gold_adv;
    expect(buildCoachReport(n).reviews[0].chapters?.story?.why?.find((c: any) => c.id === 'fights.behind')).toBeUndefined();
  });

  it('leaves roaming players out of lane totals and lane advice', () => {
    const o = buildCoachReport(load('match9094562824.parsed.json'));
    const roamer = o.players.findIndex((_: any, i: number) => load('match9094562824.parsed.json').players[i].is_roaming);
    expect(roamer).toBeGreaterThanOrEqual(0);
    const why = o.reviews[roamer].chapters.story.why ?? [];
    expect(why.filter((c: any) => c.phase === 'early' && c.mine)).toEqual([]);
  });

  it('times the lesson on the first answer bought, even if it was sold later', () => {
    const m = structuredClone(raw);
    const shaman = m.players.find((p: any) => p.hero_id === 27);
    shaman.purchase_log = [{ time: 600, key: 'ghost' }, ...shaman.purchase_log];
    const fix = buildCoachReport(m).reviews[1].chapters.story.why.find((c: any) => c.id === 'fights.carrier').fix.zh;
    expect(fix).not.toContain('29:47');
    expect(fix).toContain('你在 10:00 就有了幽魂权杖');
  });

  it('does not recommend or credit BKB against a BKB-piercing disabler', () => {
    const m = structuredClone(raw);
    const ursa = m.players.find((p: any) => p.hero_id === 70);
    ursa.hero_id = 33; // Enigma: disable + piercing
    const c = buildCoachReport(m).reviews[4].chapters.story.why.find((x: any) => x.id === 'fights.carrier');
    expect(c.title.zh).toBe('10 波输掉的团战里，7 波伤害最高的是谜团');
    expect(c.fix.zh).not.toContain('黑皇杖');
    expect(c.evidence.map((e: any) => e.zh).join('')).not.toContain('黑皇杖');
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

describe('positioning and vision (team-fight death positions, observer logs)', () => {
  const r = buildCoachReport(raw);
  it('places each lost fight on the map and summarises where they were', () => {
    const behind = r.reviews[0].chapters.story.why.find((c: any) => c.id === 'fights.behind');
    expect(behind.evidence.map((e: any) => e.zh)).toEqual(expect.arrayContaining([
      '19:44：落后 6.0k，5 打 5，在你们半场',
      '22:09：落后 7.9k，5 打 5，在河道',
      '地点：7 波在你们半场、1 波在河道、1 波在对方半场（按团战死亡位置）',
    ]));
  });

  it('only calls vision a cause when it is a pattern (a third of the lost fights)', () => {
    // Here only 22:09 and 42:23 (2 of 10) had their observer and none of yours.
    expect(r.reviews[0].chapters.story.why.find((c: any) => c.id === 'vision.blind')).toBeUndefined();
    const m = structuredClone(raw);
    // Give Dire an observer at 23:55's and 25:02's spots too (alive across those fights).
    const dire = m.players.find((p: any) => !p.isRadiant);
    dire.obs_log = [...(dire.obs_log ?? []), { time: 1400, x: 120, y: 100, ehandle: 9001 }, { time: 1480, x: 99, y: 123, ehandle: 9002 }];
    const radiant = m.players.filter((p: any) => p.isRadiant);
    for (const p of radiant) p.obs_log = (p.obs_log ?? []).filter((o: any) => !(o.time > 1100 && o.time < 1600));
    const v = buildCoachReport(m).reviews[2].chapters.story.why.find((c: any) => c.id === 'vision.blind');
    expect(v.evidence.length).toBeGreaterThanOrEqual(4);
    // One player's log missing = unknown coverage: no zero-ward claim at all.
    const partial = structuredClone(m);
    delete partial.players.find((p: any) => p.isRadiant).obs_log;
    expect(buildCoachReport(partial).reviews[2].chapters.story.why.find((c: any) => c.id === 'vision.blind')).toBeUndefined();
    expect(v.mine).toBe(true); // Warlock is a support
    expect(v.fix.zh).toContain('先在那里插一个假眼');
  });

  it('flags lost fights taken in their half while far behind', () => {
    const m = structuredClone(raw);
    // Move two lost late fights' deaths across the river into Dire's half.
    for (const start of [2203, 2379]) {
      const f = m.teamfights.find((x: any) => x.start === start);
      for (const p of f.players) if (p.deaths_pos && Object.keys(p.deaths_pos).length) p.deaths_pos = { 160: { 160: 1 } };
    }
    const deep = buildCoachReport(m).reviews[0].chapters.story.why.find((c: any) => c.id === 'position.deep');
    // The two moved fights, plus 37:26, which really was in their half at 26k+ behind.
    expect(deep.title.zh).toBe('3 波输掉的团战，是落后 5k 以上时在对方半场打的');
    expect(deep.evidence.map((e: any) => e.zh.slice(0, 5))).toEqual(['36:43', '37:26', '39:39']);
    expect(deep.fix.zh).toContain('不要成群过河');
  });

  it('knows nothing without positions or ward logs', () => {
    const m = structuredClone(raw);
    for (const f of m.teamfights) for (const p of f.players) delete p.deaths_pos;
    for (const p of m.players) { delete p.obs_log; delete p.obs_left_log; }
    const why = buildCoachReport(m).reviews[0].chapters.story.why;
    expect(why.find((c: any) => ['vision.blind', 'position.deep'].includes(c.id))).toBeUndefined();
    expect(JSON.stringify(why)).not.toContain('地点：');
  });
});

describe('official ability facts (Valve datafeed herodata)', async () => {
  const { abilityFacts } = await import('../../lib/coach/why.js');
  const ABIL = JSON.parse(readFileSync(path.join(process.cwd(), 'lib/coach/data/abilities.json'), 'utf8'));
  const NAMES = JSON.parse(readFileSync(path.join(process.cwd(), 'lib/coach/data/names.json'), 'utf8'));
  const { THREAT_TAGS } = await import('../../lib/coach/knowledge.js');

  it('describes the hero who carried the lost fights with Valve\'s own flags, patch-stamped', () => {
    const c = buildCoachReport(raw).reviews[0].chapters.story.why.find((x: any) => x.id === 'fights.carrier');
    expect(c.evidence.map((e: any) => e.zh)).toContain(`官方技能数据（${ABIL.patch}）：怒意狂击：物理伤害，无视技能免疫`);
    expect(abilityFacts(999999)).toBeNull();
  });

  it('never presents a per-modifier dispel flag as a fact about the whole ability', () => {
    // Wraith King: Valve flags Reincarnation dispellable (its slow), not the revival.
    for (const id of Object.keys(ABIL.heroes)) {
      const f = abilityFacts(Number(id));
      if (f) expect(JSON.stringify(f.line)).not.toMatch(/驱散|dispel/i);
    }
  });

  it('keeps damage types of abilities removed by later patches, for older matches', () => {
    expect(ABIL.dmg_types.juggernaut_swift_slash).toBe('P');
  });

  it('notes when your BKB cannot stop their damage', () => {
    const m = structuredClone(raw);
    const tide = m.players.find((p: any) => p.hero_id === 29);
    tide.item_5 = 116; // Black King Bar
    const fix = buildCoachReport(m).reviews[0].chapters.story.why.find((x: any) => x.id === 'fights.carrier').fix.zh;
    expect(fix).toContain('你的黑皇杖挡不住熊战士的怒意狂击。');
  });

  it('agrees with the curated BKB-piercing list: every listed hero has a piercing ultimate', () => {
    const idBySlug = new Map(Object.entries(NAMES.heroes).map(([id, h]: any) => [h.slug, id]));
    for (const slug of THREAT_TAGS.piercing) {
      const ult = ABIL.heroes[idBySlug.get(slug) as string].find((a: any) => a.ult);
      expect(ult.pierces, slug).toBe(true);
    }
  });
});
