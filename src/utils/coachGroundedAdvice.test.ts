import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildCoachReport } from '../../lib/coach/analyze.js';
import { archetypeOf, answersFor, ARCHETYPE_EXCLUDED_ANSWERS, ANSWERS } from '../../lib/coach/knowledge.js';

// PR-2 of docs/redesign/OILUI_REDESIGN_REVIEW_AND_PLAN.md: no platitudes, advice that
// fits how the hero is played, and every number from match data or a committed snapshot.
const load = (f: string) => JSON.parse(readFileSync(new URL(`../fixtures/coach/${f}`, import.meta.url), 'utf8'));
const NAMES = JSON.parse(readFileSync(new URL('../../lib/coach/data/names.json', import.meta.url), 'utf8'));
const FIXTURES = ['match9091400302.parsed.json', 'match9091400302.unparsed.json', 'match9094562824.parsed.json', 'match9079014980.turbo.unparsed.json'];
const reports = FIXTURES.map((f) => buildCoachReport(load(f)) as any);
const parsed = reports[0];
const seat = (slug: string) => parsed.players.findIndex((p: any) => p.hero.slug === slug);
const TIDE = seat('tidehunter');
const SPECTRE = seat('spectre');
const textOf = (v: any) => [v.headline.en, v.headline.zh, ...v.findings.flatMap((f: any) => [f.title.en, f.title.zh, f.body.en, f.body.zh, f.action.en, f.action.zh])].join('\n');
const findingOf = (s: number, id: string) => parsed.reviews[s].findings.find((f: any) => f.id === id);

describe('no platitudes', () => {
  it('no headline or finding anywhere says "X deaths cost more than they bought"', () => {
    for (const r of reports) {
      for (const v of r.reviews) expect(textOf(v)).not.toMatch(/cost more than they bought|代价大于收益/);
    }
  });

  it('a death title names what the deaths were about when the timeline says so', () => {
    expect(findingOf(TIDE, 'deaths.high').title.en).toBe('Ursa killed you 6 times after their Blink Dagger (16:56)');
    expect(parsed.reviews[TIDE].headline.zh).toBe('最大的提升点：熊战士 16:56 做出闪烁匕首后杀了你 6 次。');
  });
});

describe('advice fits how the hero is played (archetype)', () => {
  it('archetypes come from OpenDota roles and the seat this game', () => {
    const h = (id: number) => NAMES.heroes[String(id)];
    expect(archetypeOf(h(29), { kind: 'core', pos: 3 })).toBe('frontline_initiator'); // Tidehunter offlane
    expect(archetypeOf(h(67), { kind: 'core', pos: 1 })).toBe('right_click_carry'); // Spectre
    expect(archetypeOf(h(1), { kind: 'core', pos: 1 })).toBe('right_click_carry'); // Anti-Mage
    expect(archetypeOf(h(37), { kind: 'support', pos: 5 })).toBe('support'); // Warlock
    expect(archetypeOf(h(14), { kind: 'support', pos: 4 })).toBe('support'); // Pudge roaming
    expect(archetypeOf(h(74), { kind: 'core', pos: 2 })).toBe('core'); // Invoker
  });

  it('a frontline initiator dying in fights is told to win the initiation race, never to stand at the back', () => {
    const f = findingOf(TIDE, 'deaths.high');
    expect(f.action.en).toContain('As Tidehunter you start the fights');
    expect(f.action.en).toContain('Your Blink Dagger came at 29:20, 12:24 after theirs (61% of pro Tidehunter have it by 25:00)');
    expect(f.action.en).not.toMatch(/stand behind your (team|frontline)/);
    expect(f.action.zh).not.toMatch(/站在队伍后面|站在前排身后/);
  });

  it('the counter item comes from pro games against that killer (item-vs.json), with its sample', () => {
    const f = findingOf(TIDE, 'deaths.high');
    expect(f.action.en).toContain("Pro Tidehunter against Ursa build Eul's Scepter of Divinity in 37% of games (8% usually, 98 games)");
    expect(parsed.reviews[TIDE].chapters.plan[0].check.zh).toContain('在那之前做出Eul的神圣法杖（职业潮汐猎人对上熊战士：37%，平时 8%）');
  });

  it('a right-click carry is never sent to Ghost Scepter, Pipe, Crimson Guard, Solar Crest or Glimmer Cape', () => {
    const banned = ARCHETYPE_EXCLUDED_ANSWERS.right_click_carry.map((k: string) => NAMES.items[k]);
    const v = parsed.reviews[SPECTRE];
    const said = [textOf(v), ...(v.chapters.story?.why ?? []).map((c: any) => `${c.fix?.en ?? ''}${c.fix?.zh ?? ''}`), ...v.chapters.plan.map((p: any) => `${p.check.en}${p.check.zh}`)].join('\n');
    for (const it of banned) {
      expect(said).not.toContain(it.en);
      expect(said).not.toContain(it.zh);
    }
    for (const f of v.findings) for (const k of f.goal?.items ?? []) expect(ARCHETYPE_EXCLUDED_ANSWERS.right_click_carry).not.toContain(k);
  });

  it('answersFor only removes for the archetype; supports keep their kit', () => {
    for (const tag of Object.keys(ANSWERS)) {
      expect(answersFor(tag, 'support', 61, 'support')).toEqual(answersFor(tag, 'support', 61));
      for (const k of answersFor(tag, 'core', 61, 'right_click_carry')) expect(ARCHETYPE_EXCLUDED_ANSWERS.right_click_carry).not.toContain(k);
    }
    expect(answersFor('magic', 'core', 61)).toContain('pipe');
    expect(answersFor('magic', 'core', 61, 'right_click_carry')).not.toContain('pipe');
  });
});

describe('core item later than the pro pace (hero-items.json)', () => {
  it('Tidehunter: Blink at 29:20 against 61% of pros before 25:00, and what came before it', () => {
    const f = findingOf(TIDE, 'items.core_late');
    expect(f.title.en).toBe('Blink Dagger at 29:20: 61% of pro Tidehunter finish it before 25:00');
    expect(f.evidence.map((e: any) => e.v)).toEqual(['29:20', '61%']);
  });

  it('Spectre: Yasha late, and Radiance (itself a pace item, 79%) is never "in the way"', () => {
    const f = findingOf(SPECTRE, 'items.core_late');
    expect(f.title.en).toMatch(/^Yasha at 33:39: 73% of pro Spectre finish it before 25:00$/);
    expect(f.action.en).not.toContain('Radiance');
  });

  it('no purchase log, no claim', () => {
    for (const v of reports[1].reviews) expect(v.findings.map((f: any) => f.id)).not.toContain('items.core_late');
  });
});

describe('the turning point is about this game', () => {
  it('names the enemy items that landed around the window and what the enemy took', () => {
    const f = findingOf(TIDE, 'team.turning_point');
    expect(f.action.en).toContain("Ursa's Abyssal Blade (39:19)");
    expect(f.action.en).toContain('Radiant lost mid T3 tower');
  });
});

describe('zero invention', () => {
  it('every item and hero cited in evidence exists in the names snapshot', () => {
    for (const r of reports) {
      for (const v of r.reviews) {
        for (const f of v.findings) {
          for (const e of f.evidence ?? []) {
            for (const k of e.items ?? []) expect(NAMES.items[k], k).toBeTruthy();
            for (const h of e.heroes ?? []) expect(NAMES.heroes[String(h)], String(h)).toBeTruthy();
          }
        }
      }
    }
  });
});

describe('review #217 P1s', () => {
  it('an item\'s own components are progress, never "move X after it" (Dawnbreaker: Dragon Lance → Harpoon)', () => {
    const m = load('match9091400302.parsed.json');
    const db = m.players.findIndex((p: any) => p.hero_id === 135);
    m.players[db].purchase_log = [...m.players[db].purchase_log.filter((x: any) => !['dragon_lance', 'harpoon', 'echo_sabre'].includes(x.key)),
      { time: 600, key: 'echo_sabre' }, { time: 800, key: 'dragon_lance' }, { time: 1800, key: 'harpoon' }].sort((a: any, b: any) => a.time - b.time);
    const f = (buildCoachReport(m) as any).reviews[db].findings.find((x: any) => x.id === 'items.core_late');
    expect(f.title.en).toBe('Harpoon at 30:00: 51% of pro Dawnbreaker finish it before 25:00');
    expect(f.action.en).not.toContain('Dragon Lance');
    expect(f.action.zh).not.toContain(NAMES.items.dragon_lance.zh);
  });

  it('an answer a carry already owns still counts (a Pipe is never "nothing that answers it")', () => {
    const m = load('match9091400302.parsed.json');
    const sp = m.players.findIndex((p: any) => p.hero_id === 67);
    m.players[sp].item_5 = NAMES.items.pipe.id;
    const v = (buildCoachReport(m) as any).reviews[sp];
    const miss = v.findings.find((x: any) => x.id === 'items.answer_missing');
    expect(miss?.goal?.tag).not.toBe('magic');
    expect(textOf(v)).not.toMatch(/nothing that answers it[^.]*magic|魔法爆发[^。]*没有任何应对/);
    // …while Pipe is still never recommended to him.
    for (const f of v.findings) expect(f.action.en).not.toMatch(/(build|plan|Other options:)[^.]*Pipe of Insight/);
  });

  it('a turning point never says an item came before a loss it followed (9094562824)', () => {
    const r = reports[2];
    const f = r.reviews.map((v: any) => v.findings.find((x: any) => x.id === 'team.turning_point')).find(Boolean);
    expect(f.action.en).toContain('In this window: Radiant lost mid T3 tower');
    expect(f.action.en).toContain("Around it, Doom's Shiva's Guard (29:35) and Outworld Destroyer's Scythe of Vyse (30:15) came online too");
    expect(f.action.en).not.toMatch(/came first|, then:/);
    // And when the items do come first, the order is stated (9091400302).
    expect(findingOf(TIDE, 'team.turning_point').action.en).toMatch(/^Ursa's Abyssal Blade \(39:19\)[^.]* came first, then: /);
  });
});
