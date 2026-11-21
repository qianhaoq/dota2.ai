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

  it('names the lane killers\' spell that hurt you most, with Valve\'s cooldowns, and says it is a whole-game number', () => {
    const bot = byKey(2, 'lane.1'); // Warlock, killed in lane by Dawnbreaker and Weaver
    expect(bot.fix.zh).toContain('等破晓辰星的星破天惊（冷却 17/15/13/11 秒）放出来之后');
    // Weaver's top spell is the Swarm, which keeps hurting for 16 s after the cast:
    // no window, so Weaver is not named — not a weaker spell in its place either.
    expect(bot.fix.zh).not.toMatch(/编织者的/);
    expect(bot.fix.zh).toContain('放出来之后再上前补刀、换血');
    const ev = bot.evidence.at(-1).zh;
    expect(ev).toMatch(/^整局对你伤害最高的小技能：破晓辰星的星破天惊 [\d.]+k/);
    expect(ev).toContain('冷却取自官方 7.42 数据');
    // The amount is the raw damage-received entry, no ultimates.
    const warlock = raw.players.find((p: any) => p.hero_id === 37);
    expect(ev).toContain(`${(warlock.damage_inflictor_received.dawnbreaker_fire_wreath / 1000).toFixed(1)}k`);
    expect(bot.fix.zh).not.toContain('天光现世');
    // Passive procs and lasting effects never open a window (Valve data).
    const ABIL = JSON.parse(readFileSync(path.join(process.cwd(), 'lib/coach/data/abilities.json'), 'utf8'));
    const spell = (hero: number, id: string) => ABIL.heroes[hero].find((a: any) => a.id === id);
    expect(spell(2, 'axe_counter_helix').trade_cd).toBeUndefined();
    expect(spell(8, 'juggernaut_blade_fury').trade_cd).toBeUndefined();
    expect(spell(101, 'skywrath_mage_arcane_bolt').trade_cd).toBeUndefined(); // 5 s: too short to act in
    // The named spell follows the damage you took: make Celestial Hammer the top one.
    const juggy = JSON.parse(JSON.stringify(raw));
    const w = juggy.players.find((p: any) => p.hero_id === 37);
    w.damage_inflictor_received = { ...w.damage_inflictor_received, dawnbreaker_celestial_hammer: 99999 };
    expect(spell(135, 'dawnbreaker_celestial_hammer').trade_cd).toBeDefined();
    const c2 = buildCoachReport(juggy).reviews[2].chapters.story.why.find((x: any) => x.id === 'lane.1');
    expect(c2.fix.zh).toContain('破晓辰星的上界重锤');
    // A top spell with no window (Ursa's Fury Swipes, passive) drops Ursa from the advice.
    const top = JSON.parse(JSON.stringify(raw));
    const tide = top.players.find((p: any) => p.hero_id === 29);
    tide.damage_inflictor_received = { ...tide.damage_inflictor_received, ursa_fury_swipes: 99999 };
    const c3 = buildCoachReport(top).reviews[0].chapters.story.why.find((x: any) => x.id === 'lane.3');
    expect(c3.fix.zh).not.toMatch(/熊战士的/);
    // Without the damage breakdown, the advice stays generic and no spell is named.
    const bare = JSON.parse(JSON.stringify(raw));
    for (const p of bare.players) delete p.damage_inflictor_received;
    const c = buildCoachReport(bare).reviews[2].chapters.story.why.find((x: any) => x.id === 'lane.1');
    expect(c.fix.zh).toContain('只在对方关键技能冷却时换血');
    expect(c.evidence.map((e: any) => e.zh).join()).not.toContain('整局对你伤害最高');
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

describe('story "why": where you stood in lane (replay positions)', () => {
  const raw = load('match9091400302.parsed.json');
  const r = buildCoachReport(raw);
  const lane = (slot: number, id: string) => r.reviews[slot].chapters.story.why.find((c: any) => c.id === id);
  // Share of a player's lane_pos samples in the enemy half (river band ±10 cells excluded).
  const over = (heroId: number) => {
    const p = raw.players.find((x: any) => x.hero_id === heroId);
    let n = 0; let e = 0;
    for (const [x, ys] of Object.entries(p.lane_pos as Record<string, Record<string, number>>)) {
      for (const [y, c] of Object.entries(ys)) {
        n += c; const s = Number(x) + Number(y) - 256;
        if (Math.abs(s) > 10 && (s > 0) === (p.player_slot < 128)) e += c;
      }
    }
    return `${Math.round((100 * e) / n)}%`;
  };

  it('compares time over the river for every laner, from the replay samples', () => {
    const bot = lane(2, 'lane.1');
    const line = bot.evidence.find((e: any) => e.zh.startsWith('开局前到 10 分钟站在对方半场的时间'));
    expect(line.zh).toBe(`开局前到 10 分钟站在对方半场的时间（录像位置采样）：术士 ${over(37)}、幽鬼 ${over(67)} 对 编织者 ${over(63)}、破晓辰星 ${over(135)}`);
    // Ursa pressed into Tidehunter's half; the evidence shows it.
    expect(lane(0, 'lane.3').evidence.map((e: any) => e.zh).join()).toContain(`熊战士 ${over(70)}`);
  });

  it('adds the positioning fact only when it holds for 0:00–10:00 even if all pregame time was over the river', () => {
    // 690 samples: one a second from 1:29 before the horn to 10:00. Warlock's 16%
    // could be mostly pregame (89 samples), so no advice from it.
    const warlock = raw.players.find((x: any) => x.hero_id === 37);
    const n = Object.values(warlock.lane_pos as Record<string, Record<string, number>>).reduce((s, ys) => s + Object.values(ys).reduce((a, b) => a + b, 0), 0);
    expect(n).toBe(690);
    expect(lane(2, 'lane.1').fix.zh).not.toContain('录像显示');
    // Move 150 of Warlock's own-half samples to a spot past the bottom river: now
    // at least (16%·690 + 150 − 89) / 601 of laning was over there.
    const deep = JSON.parse(JSON.stringify(raw));
    const w = deep.players.find((x: any) => x.hero_id === 37);
    let moved = 0;
    for (const [x, ys] of Object.entries(w.lane_pos as Record<string, Record<string, number>>)) {
      for (const [y, c] of Object.entries(ys)) {
        if (moved >= 150 || Number(x) + Number(y) >= 246) continue;
        const take = Math.min(c, 150 - moved); ys[y] = c - take; moved += take;
      }
    }
    w.lane_pos['170'] = { ...(w.lane_pos['170'] ?? {}), 110: (w.lane_pos['170']?.['110'] ?? 0) + 150 };
    const fix = buildCoachReport(deep).reviews[2].chapters.story.why.find((c: any) => c.id === 'lane.1').fix.zh;
    expect(fix).toMatch(/录像显示 0–10 分钟你至少有 \d+% 的时间站在河道对面（即使开局前的时间全算在对面也是如此），而破晓辰星站到你们这一侧最多 \d+%/);
    expect(fix.match(/等级追上之前/g)).toHaveLength(1);
    // "At most" for Dawnbreaker is the 0:00–10:00 upper bound: all its over-river samples / 601.
    const dawn = raw.players.find((x: any) => x.hero_id === 135);
    let e = 0;
    for (const [x, ys] of Object.entries(dawn.lane_pos as Record<string, Record<string, number>>)) {
      for (const [y, c] of Object.entries(ys)) if (Number(x) + Number(y) - 256 < -10) e += c;
    }
    expect(fix).toContain(`破晓辰星站到你们这一侧最多 ${Math.round((100 * Math.min(1, e / 601)))}%`);
    expect(lane(0, 'lane.3').fix.zh).not.toContain('录像显示'); // Tidehunter stayed home
  });

  it('ships a heat map for your lane only, against the hero who killed you most there', () => {
    const c = lane(2, 'lane.1');
    expect(c.heat.me.hero.id).toBe(37);
    expect(c.heat.opp.hero.id).toBe(135); // Dawnbreaker: 3 of Warlock's lane deaths
    const sum = (cells: number[][]) => cells.reduce((s, x) => s + x[2], 0);
    const total = (heroId: number) => Object.values(raw.players.find((x: any) => x.hero_id === heroId).lane_pos as Record<string, Record<string, number>>)
      .reduce((s, ys) => s + Object.values(ys).reduce((a, b) => a + b, 0), 0);
    expect(sum(c.heat.me.cells)).toBe(total(37));
    for (const other of r.reviews[2].chapters.story.why.filter((x: any) => x.id !== 'lane.1')) expect(other.heat).toBeUndefined();
    expect(r.reviews[7].chapters.story.why.some((x: any) => x.heat)).toBe(false); // the winners' lanes were not lost
  });

  it('says nothing about positions when any laner has no samples', () => {
    const partial = JSON.parse(JSON.stringify(raw));
    delete partial.players.find((p: any) => p.hero_id === 63).lane_pos; // Weaver
    const c = buildCoachReport(partial).reviews[2].chapters.story.why.find((x: any) => x.id === 'lane.1');
    expect(c.evidence.map((e: any) => e.zh).join()).not.toContain('录像位置采样');
    expect(c.fix.zh).not.toContain('录像显示');
    expect(c.heat).toBeUndefined();
  });
});

describe('story "why": your hero\'s core item against pro builds', () => {
  const raw = load('match9091400302.parsed.json');
  const HI = JSON.parse(readFileSync(path.join(process.cwd(), 'lib/coach/data/hero-items.json'), 'utf8'));
  const cause = (r: any, slot: number) => r.reviews[slot].chapters.story.why?.find((c: any) => c.id === 'items.key_item');
  const pct = (hero: string, key: string) => {
    const h = HI.heroes[hero];
    return Math.round((100 * h.items.find((x: any) => x.key === key).n) / h.games);
  };

  it('names a late consensus item, what came first, and the fights lost before it', () => {
    const c = cause(buildCoachReport(raw), 0); // Tidehunter, Blink at 29:20
    const tide = raw.players.find((p: any) => p.hero_id === 29);
    const blinkAt = tide.purchase_log.find((x: any) => x.key === 'blink').time;
    expect(HI.heroes['29'].items[0].key).toBe('blink');
    expect(pct('29', 'blink')).toBeGreaterThanOrEqual(50);
    expect(c.title.zh).toBe(`核心装备：闪烁匕首 ${Math.floor(blinkAt / 60)}:${String(blinkAt % 60).padStart(2, '0')} 才买，职业选手的潮汐猎人 ${pct('29', 'blink')}% 的比赛在 25 分钟前就买了`);
    expect(c.evidence[0].zh).toContain(`${HI.heroes['29'].games} 场职业比赛的潮汐猎人`);
    expect(c.evidence[0].zh).toContain(`闪烁匕首 ${pct('29', 'blink')}%`);
    expect(c.evidence[0].zh).toContain(`OpenDota 职业比赛，${HI.fetched}`);
    // Finished items only (no Void Stone, no Phase Boots), in purchase order.
    expect(c.evidence[1].zh).toMatch(/^买闪烁匕首之前你完成了：法师克星 16:\d\d、圣化护服 21:\d\d$/);
    expect(c.evidence[2].zh).toMatch(/^闪烁匕首到手前，10 分钟后输了 \d+ 波团战；你在场 \d+ 波，其中放出大招 \d+ 波$/);
    expect(c.fix.zh).toBe('下一局把闪烁匕首排在法师克星之前：多数职业选手的潮汐猎人在 25 分钟前就有它。');
  });

  it('never calls another consensus item or a component of the item a detour', () => {
    // Spectre: Radiance (also consensus) came before Yasha; only Orchid counts.
    const c = cause(buildCoachReport(raw), 4);
    expect(c.evidence[1].zh).not.toContain('辉耀');
    expect(c.fix.zh).not.toContain('辉耀之前');
    // Each listed item carries its recursive components, which never count as "instead".
    expect(HI.parts.yasha).toContain('blade_of_alacrity');
    // Without Orchid, nothing but Radiance came first: no genuine alternative, no cause.
    const only = JSON.parse(JSON.stringify(raw));
    const sp = only.players.find((p: any) => p.hero_id === 67);
    sp.purchase_log = sp.purchase_log.filter((x: any) => x.key !== 'orchid' && x.key !== 'bloodthorn');
    expect(cause(buildCoachReport(only), 4)).toBeUndefined();
  });

  it('only recommends items still sold in the current patch', () => {
    // Removed items (bought in older pro games) are filtered out at generation.
    expect(HI.source).toMatch(/finished items seen in \d+\.\d+ pro matches/);
    const listed = new Set(Object.values(HI.heroes).flatMap((h: any) => h.items.map((x: any) => x.key)));
    expect(listed.has('helm_of_the_overlord')).toBe(false);
  });

  it('says nothing when the item came in the mid game, the pro data is split, or there is no purchase log', () => {
    const early = JSON.parse(JSON.stringify(raw));
    early.players.find((p: any) => p.hero_id === 29).purchase_log.find((x: any) => x.key === 'blink').time = 1200;
    expect(cause(buildCoachReport(early), 0)).toBeUndefined();
    // Pudge: no item reaches half of pro games.
    expect(HI.heroes['14'].items.every((x: any) => x.n / HI.heroes['14'].games < 0.5)).toBe(true);
    expect(cause(buildCoachReport(raw), 3)).toBeUndefined();
    const bare = JSON.parse(JSON.stringify(raw));
    for (const p of bare.players) delete p.purchase_log;
    expect(cause(buildCoachReport(bare), 0)).toBeUndefined();
  });
});
