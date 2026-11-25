/**
 * Deterministic probes of the coach chat: questions about one game whose answer the replay settles, asked to the
 * chat agent and graded against what the tools return (layer D of docs/GAME_UNDERSTANDING.md).
 *
 * Each probe carries its question, the tool call its answer comes from, and what a right answer must contain:
 * hero names, a clock, numbers or a place. The grade is mechanical (does the answer say it), so it measures
 * whether the agent reads the tools right, not whether its coaching is good: that is the expert labels' job.
 *
 * A probe is built only when the tools give a definite answer. A fact the tools leave unknown (a hero with no
 * position sample, no Aegis pickup) gives no probe, never one whose answer is "no".
 */
import { reviewToolkit } from './deepReview.js';

/** The probe kinds, in the order they are built. */
export const PROBE_KINDS = ['deaths_before_10', 'most_avoidable_death', 'not_in_lost_fight', 'heroes_in_lost_fight', 'first_tower_lost', 'first_aegis', 'where_was_ally'];

const pad = (n) => String(n).padStart(2, '0');
const clockOf = (sec) => `${sec < 0 ? '-' : ''}${Math.floor(Math.abs(sec) / 60)}:${pad(Math.abs(sec) % 60)}`;
// Before the horn a clock is negative ("-0:37").
const secondsOf = (clock) => { const m = /^([-−]?)(\d{1,3}):(\d{2})$/.exec(String(clock ?? '')); return m ? (m[1] ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : null; };

const Q = {
  deaths_before_10: { en: () => 'How many times did I die before 10:00?', zh: () => '10:00 之前我死了几次？' },
  most_avoidable_death: { en: () => 'Which of my deaths was the most avoidable?', zh: () => '我哪一次死亡最该避免？' },
  not_in_lost_fight: { en: (c) => `In the fight at ${c} that we lost, who on my team was not in it?`, zh: (c) => `${c} 那波我们输掉的团战，我方谁不在团里？` },
  heroes_in_lost_fight: { en: (c) => `In the fight at ${c}, how many heroes did each side bring?`, zh: (c) => `${c} 那波团战，双方各来了几个英雄？` },
  first_tower_lost: { en: () => 'When did my team lose its first tower?', zh: () => '我方第一座塔是什么时候丢的？' },
  first_aegis: { en: () => 'Who took the first Aegis, and when?', zh: () => '第一个不朽盾是谁拿的？什么时候？' },
  where_was_ally: { en: (c, h) => `At ${c}, where was ${h}?`, zh: (c, h) => `${c} 的时候，${h}在哪？` },
};

/**
 * The probes for one player's game, each with its expected answer from the tools.
 * @returns {{ id: string, kind: string, question: string, source: { tool: string, args: object }, expect: { heroes?: string[], me?: true, clock?: string, among?: string[], numbers?: number[], sides?: { count: number, heroes: string[] }[], place?: string, in_it?: string[] } }[] | null}
 *   null when the hero is not in the game.
 */
export function buildProbes(trace, hero, { lang = 'en', match = null } = {}) {
  const kit = reviewToolkit({ trace, hero, lang, match });
  if (!kit) return null;
  const me = kit.seat.key;
  const L = kit.language === 'zh' ? 'zh' : 'en';
  const run = (tool, args) => ({ result: kit.runTool(tool, { hero: me, ...args }), source: { tool, args: { hero: me, ...args } } });
  const out = [];
  const add = (kind, question, source, expect) => out.push({ id: `${trace.match_id}:${me}:${kind}`, kind, question, source, expect });

  const lane = run('lane_report', {});
  if (Number.isInteger(lane.result?.my_deaths_before_10_00_total)) add('deaths_before_10', Q.deaths_before_10[L](), lane.source, { numbers: [lane.result.my_deaths_before_10_00_total] });

  const deaths = run('death_context', {});
  const worst = deaths.result?.most_left_unused?.[0];
  if (worst?.clock) add('most_avoidable_death', Q.most_avoidable_death[L](), deaths.source, { clock: worst.clock, among: (deaths.result.most_left_unused ?? []).map((d) => d.clock) });

  const fights = run('fight_report', {});
  // The first fight my team lost that I was in, with an ally alive and not in it: who was missing is settled by the
  // replay. With me in it, everyone missing is an ally the answer names, not "you".
  const lost = (fights.result?.fights ?? []).find((f) => f.lost_fewer_heroes === 'enemy' && f.me === 'took_part' && (f.my_team?.not_in_it ?? []).some((x) => x.doing !== 'dead'));
  if (lost) {
    add('not_in_lost_fight', Q.not_in_lost_fight[L](lost.clock), fights.source, { heroes: lost.my_team.not_in_it.map((x) => x.hero), in_it: lost.my_team.took_part });
    // Each side's count, or the side's heroes all named: "Zeus, you, Lich and Nyx" says four.
    add('heroes_in_lost_fight', Q.heroes_in_lost_fight[L](lost.clock), fights.source, { sides: [{ count: lost.my_team.took_part_count, heroes: lost.my_team.took_part }, { count: lost.enemy.took_part_count, heroes: lost.enemy.took_part }] });
  }

  // Every building death of the game, from match_overview: a tower my team denied is lost too (decision_points
  // leaves denies out, nobody took them), and a tower that fell with no push siege_report recognised is still there.
  const overview = run('match_overview', {});
  const tower = (overview.result?.buildings ?? []).filter((b) => b.lost_by === 'my_team' && /_tower\d/.test(b.building)).sort((a, b) => a.t - b.t)[0];
  if (tower) add('first_tower_lost', Q.first_tower_lost[L](), overview.source, { clock: tower.clock });

  const rosh = run('roshan_report', {});
  const aegis = rosh.result?.takes?.[0];
  // The player's own Aegis is answered "you".
  if (aegis?.aegis_holder && aegis.clock) add('first_aegis', Q.first_aegis[L](), rosh.source, aegis.aegis_holder === me ? { me: true, clock: aegis.clock } : { heroes: [aegis.aegis_holder], clock: aegis.clock });

  // Where an ally was at a fixed moment (20:00, or the middle of a shorter game): the first ally, by seat, alive
  // there with a known place.
  const at = Math.min(20 * 60, Math.floor((trace.t0 + trace.n) / 2));
  const state = run('game_state', { at: clockOf(at) });
  const ally = (state.result?.my_team?.heroes ?? []).find((s) => s.hero !== me && s.alive === true && s.place && s.known !== false);
  if (ally) add('where_was_ally', Q.where_was_ally[L](clockOf(at), kit.context.hero_names[ally.hero] ?? ally.hero), state.source, { place: ally.place });

  return out;
}

const NUMBER_WORDS = {
  en: { zero: 0, no: 0, none: 0, once: 1, one: 1, twice: 2, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 },
  zh: { 零: 0, 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 },
};
/** "Not once": a zero said without a number. */
const ZERO = { en: /\b(never died|did not die|didn't die|no deaths?)\b/i, zh: /没死|没有死|一次都没|一次也没|零次/ };

/** Every number in a text, digits or words, with clocks taken out (6:53 is not a 6 and a 53). */
export function numbersIn(text, lang = 'en') {
  const s = String(text ?? '').replace(/[-−]?\b\d{1,3}:\d{2}\b/g, ' ');
  const found = (s.match(/\d+/g) ?? []).map(Number);
  if (ZERO[lang === 'zh' ? 'zh' : 'en'].test(s)) found.push(0);
  if (lang === 'zh') { for (const [w, n] of Object.entries(NUMBER_WORDS.zh)) if (s.includes(w)) found.push(n); } else {
    for (const w of s.toLowerCase().match(/[a-z]+/g) ?? []) if (w in NUMBER_WORDS.en) found.push(NUMBER_WORDS.en[w]);
  }
  return found;
}

/** Every clock in a text, as seconds, in the order written. */
export function clocksIn(text) {
  return [...String(text ?? '').matchAll(/([-−]?)\b(\d{1,3}):(\d{2})\b/g)].map((m) => (m[1] ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])));
}

/** Clocks a second apart are the same moment: a tool's "6:53" may be "6:52" in another tool's rounding. */
const CLOCK_SLACK = 1;
const sameClock = (a, b) => a != null && b != null && Math.abs(a - b) <= CLOCK_SLACK;

/**
 * Grade one answer against its probe. Names and places are matched in the reader's language, as the chat writes
 * them (hero_names, place_names); the answer is the chat's final text.
 * @returns {{ pass: boolean, missing: string[], wrong: string[], also_named: string[] }} also_named: heroes the replay
 *   has in the fight that the answer names too. It does not fail the probe (an answer may say who was in it), and is
 *   kept for reading the answers.
 */
export function gradeProbe(probe, answer, { heroNames = {}, placeNames = {}, lang = 'en' } = {}) {
  const text = String(answer ?? '');
  const low = text.toLowerCase();
  const name = (k) => heroNames[k] ?? k;
  const has = (s) => low.includes(String(s).toLowerCase());
  const missing = []; const wrong = []; const also = [];
  const e = probe.expect ?? {};
  for (const h of e.heroes ?? []) if (!has(name(h))) missing.push(name(h));
  if (e.me && !(lang === 'zh' ? /你/.test(text) : /\byou(r|rself)?\b/i.test(text))) missing.push(lang === 'zh' ? '你' : 'you');
  if (e.clock) {
    const want = secondsOf(e.clock);
    const said = clocksIn(text);
    // Of the clocks the probe lists as candidates (a death list), the first one the answer names must be the
    // expected one; without candidates, the expected clock must be named at all.
    const among = (e.among ?? []).map(secondsOf);
    const firstCandidate = among.length ? said.find((c) => among.some((a) => sameClock(a, c))) : said.find((c) => sameClock(c, want));
    if (firstCandidate == null) missing.push(e.clock);
    else if (!sameClock(firstCandidate, want)) wrong.push(clockOf(firstCandidate));
  }
  if (e.numbers) {
    const said = numbersIn(text, lang);
    for (const n of e.numbers) if (!said.includes(n)) missing.push(String(n));
  }
  if (e.sides) {
    const said = numbersIn(text, lang);
    // The player is "you" in the answer, not their hero's name.
    for (const side of e.sides) if (!said.includes(side.count) && !side.heroes.every((h) => has(name(h)) || h === probe.source.args.hero)) missing.push(String(side.count));
  }
  if (e.place && !has(placeNames[e.place] ?? e.place)) missing.push(placeNames[e.place] ?? e.place);
  for (const h of e.in_it ?? []) if (has(name(h)) && !(e.heroes ?? []).includes(h)) also.push(name(h));
  return { pass: missing.length === 0 && wrong.length === 0, missing, wrong, also_named: also };
}

/** Pass rate by kind, and overall. */
export function scoreProbes(graded) {
  const by = {};
  for (const g of graded) { const k = (by[g.kind] ??= { probes: 0, passed: 0 }); k.probes += 1; if (g.pass) k.passed += 1; }
  return { probes: graded.length, passed: graded.filter((g) => g.pass).length, by_kind: by };
}
