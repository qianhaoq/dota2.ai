/**
 * `dota2ai coach <matchId> [--hero h] [--section s] [--lang en|zh] [--json]`
 * The dota2.ai coach report (GET /api/coach/:id) for a terminal or an agent.
 *
 * Sections: summary (default) | why | lane | deaths | items | fights | plan | all
 *   summary  the read, the three causes that decided the game (yours first),
 *            what to practise next game, and the findings
 *   why      every cause with its evidence and what to do
 *   lane/deaths/items/fights  that chapter: takeaway, points, how it is computed
 *   plan     what to practise next game, with the check for each
 * --json     the stable machine shape: { schema, engine, match, player, review }
 *            for one seat (the whole report without --hero), or
 *            { section, value } with --section.
 * Exit codes: 0 ok, 2 invalid input, 3 match missing / no data, 4 upstream.
 */
import { normalizeMatchId } from '@dota2ai/review-engine';
import { createCoachApi, findSeat, EXIT } from './coachApi.js';

const USAGE = 'Usage: dota2ai coach <matchId> [--hero slug|name|id] [--section summary|why|lane|deaths|items|fights|plan|all] [--lang en|zh] [--json]';
export const SECTIONS = ['summary', 'why', 'lane', 'deaths', 'items', 'fights', 'plan', 'all'];
const CHAPTER_OF = { lane: 'laning', deaths: 'deaths', items: 'items', fights: 'fights' };

export function parseCoachArgs(args) {
  const matchId = normalizeMatchId(args[1]);
  const opts = { matchId, hero: null, lang: 'en', json: false, section: null };
  if (!opts.matchId) throw usage(USAGE);
  for (let i = 2; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--json') opts.json = true;
    else if (flag === '--hero' || flag === '--lang' || flag === '--section') {
      const v = args[++i];
      if (!v || v.startsWith('--')) throw usage(`Missing value: ${flag}`);
      opts[flag.slice(2)] = v;
    } else throw usage(`Unknown option: ${flag}`);
  }
  if (!['en', 'zh'].includes(opts.lang)) throw usage('Language must be en or zh');
  if (opts.section != null && !SECTIONS.includes(opts.section)) throw usage(`Section must be one of: ${SECTIONS.join(', ')}`);
  if (opts.section != null && opts.section !== 'summary' && opts.hero == null) throw usage('--section needs --hero');
  return opts;
}

function usage(message) { return Object.assign(new Error(message), { code: 'INVALID_INPUT' }); }

export const findSlot = findSeat;

const clock = (s) => `${Math.floor(s / 60)}:${String(Math.round(s) % 60).padStart(2, '0')}`;
const tr = (lang) => (b) => (b ? b[lang] ?? b.en : '');

function header(report, lang) {
  const m = report.match;
  const zh = lang === 'zh';
  const winner = m.radiant_win ? (zh ? '天辉胜利' : 'Radiant victory') : (zh ? '夜魇胜利' : 'Dire victory');
  return `#${m.id} · ${winner} ${m.score[0]}–${m.score[1]} · ${clock(m.duration)}${m.patch ? ` · ${m.patch}` : ''} · ${m.parsed ? (zh ? '已解析' : 'parsed') : (zh ? '未解析' : 'not parsed')}`;
}

/** Causes, yours first, then by how much they cost. */
export function rankedCauses(review) {
  const why = review?.chapters?.story?.why;
  if (!Array.isArray(why)) return [];
  return [...why].sort((a, b) => (Number(b.mine) - Number(a.mine)) || (a.impact - b.impact));
}

function renderCause(c, i, L, zh, lines) {
  lines.push(`${i + 1}. ${L(c.title)}${c.mine ? (zh ? '  [你]' : '  [you]') : ''}`);
  for (const e of c.evidence) lines.push(`   - ${L(e)}`);
  if (c.fix) lines.push(`   ${zh ? '怎么做' : 'What to do'}: ${L(c.fix)}`);
}

function renderChapter(ch, L, zh, lines) {
  if (!ch) { lines.push(zh ? '（这场比赛没有这一章的数据）' : '(no data for this chapter in this match)'); return; }
  if (ch.takeaway) lines.push(L(ch.takeaway));
  for (const p of ch.points ?? []) lines.push(`  - ${L(p)}`);
  if (ch.note) lines.push('', `${zh ? '怎么算的' : 'How this is computed'}: ${L(ch.note)}`);
}

function renderPlan(plan, L, zh, lines) {
  if (!Array.isArray(plan) || !plan.length) { lines.push(zh ? '（暂无）' : '(none)'); return; }
  plan.forEach((p, i) => {
    lines.push(`${i + 1}. ${L(p.title)}`);
    lines.push(`   ${zh ? '依据' : 'Why'}: ${L(p.why)}`);
    lines.push(`   ${zh ? '下一局' : 'Next game'}: ${L(p.check)}`);
  });
}

export function renderCoach(report, slot, lang, section = 'summary') {
  const L = tr(lang);
  const zh = lang === 'zh';
  const lines = [header(report, lang)];
  if (slot == null) {
    lines.push('', zh ? '用 --hero 指定你的英雄：' : 'Pick your hero with --hero:');
    for (const p of report.players) lines.push(`  ${p.radiant ? 'R' : 'D'}  ${p.hero.slug.padEnd(22)} ${L(p.hero)}  ${p.kda.join('/')}`);
    return lines.join('\n');
  }
  const p = report.players[slot];
  const rv = report.reviews[slot];
  const ch = rv.chapters ?? null;
  lines.push(`${L(p.hero)} · ${L(rv.role.label)} · ${p.kda.join('/')} · ${rv.won ? (zh ? '胜' : 'win') : (zh ? '负' : 'loss')}`);
  const title = (en, zhT) => lines.push('', `== ${zh ? zhT : en} ==`);
  const want = (s) => section === s || section === 'all';

  if (section === 'summary' || section === 'all') {
    lines.push('', L(rv.headline));
    const causes = rankedCauses(rv);
    if (causes.length) {
      title('What decided this game', '决定这局的几件事');
      causes.slice(0, section === 'all' ? causes.length : 3).forEach((c, i) => renderCause(c, i, L, zh, lines));
    }
    if (ch?.plan?.length) {
      title('Practise next game', '下一局练这一件');
      lines.push(`${L(ch.plan[0].title)} — ${L(ch.plan[0].check)}`);
    }
    title('Findings', '结论');
    const evidence = (e) => {
      const parts = [e.v, e.items?.map((k) => L(report.players.flatMap((x) => x.items).find((i) => i.key === k)) || k).join(', '), L(e.sub)].filter(Boolean);
      return `${L(e.k)}: ${parts.join(' · ')}`;
    };
    rv.findings.forEach((f, i) => {
      lines.push(`${i + 1}. ${f.tone === 'good' ? '✓' : '!'} ${L(f.title)}`);
      if (f.tone === 'fix') lines.push(`   ${zh ? '怎么做' : 'What to do'}: ${L(f.action ?? f.ask)}`);
      lines.push(`   ${L(f.body)}`);
      for (const e of f.evidence) if (!e.heroes) lines.push(`   - ${evidence(e)}`);
      if (f.caveat) lines.push(`   (${L(f.caveat)})`);
    });
  }
  if (section === 'why') {
    const causes = rankedCauses(rv);
    title('Why it went this way', '为什么会这样');
    if (!causes.length) lines.push(zh ? '（需要已解析的比赛）' : '(needs a parsed match)');
    causes.forEach((c, i) => renderCause(c, i, L, zh, lines));
  }
  for (const [s, en, zhT] of [['lane', 'Laning', '对线'], ['deaths', 'Deaths', '死亡'], ['items', 'Items and damage taken', '出装与承伤'], ['fights', 'Team fights', '团战']]) {
    if (want(s)) { title(en, zhT); renderChapter(ch?.[CHAPTER_OF[s]], L, zh, lines); }
  }
  if (want('plan')) { title('Next game', '下一局'); renderPlan(ch?.plan, L, zh, lines); }

  if (report.data_gaps.length) {
    lines.push('', zh ? '尚未解析，暂时看不到：' : 'Not parsed yet — cannot see:');
    for (const g of report.data_gaps) lines.push(`  - ${L(g)}`);
    lines.push(zh ? `  在 https://dota2.ai/r/${report.match.id} 一键请求解析。` : `  Request a parse at https://dota2.ai/r/${report.match.id}`);
  }
  lines.push('', `https://dota2.ai/r/${report.match.id}?p=${slot}${zh ? '&lang=zh' : ''}`);
  return lines.join('\n');
}

/** The stable machine shape for one seat. */
export function seatJson(report, slot) {
  return {
    schema: report.schema,
    engine: report.engine,
    match: report.match,
    player: report.players[slot],
    review: report.reviews[slot],
    data_gaps: report.data_gaps,
    url: `https://dota2.ai/r/${report.match.id}?p=${slot}`,
  };
}

export function sectionJson(report, slot, section) {
  const rv = report.reviews[slot];
  const ch = rv.chapters ?? {};
  switch (section) {
    case 'why': return rankedCauses(rv);
    case 'plan': return ch.plan ?? null;
    case 'lane': case 'deaths': case 'items': case 'fights': return ch[CHAPTER_OF[section]] ?? null;
    case 'summary': return { headline: rv.headline, causes: rankedCauses(rv).slice(0, 3), plan: ch.plan?.[0] ?? null, findings: rv.findings };
    default: return seatJson(report, slot);
  }
}

export async function runCoach(args, { stdout, stderr, env = process.env, fetchImpl = globalThis.fetch } = {}) {
  let opts;
  try { opts = parseCoachArgs(args); } catch (e) { stderr.write(`${e.message}\n`); return 2; }
  let report;
  try {
    report = await createCoachApi({ env, fetchImpl }).report(opts.matchId);
  } catch (e) {
    stderr.write(`${e.code === 'UPSTREAM' && e.message === 'dota2.ai request failed' ? 'Coach request failed' : e.message}\n`);
    return EXIT[e.code] ?? 4;
  }
  let slot;
  try { slot = findSeat(report, opts.hero); } catch (e) { stderr.write(`${e.message}\n`); return 2; }
  if (opts.json) {
    if (slot == null) stdout.write(`${JSON.stringify(report)}\n`);
    else if (opts.section && opts.section !== 'all') stdout.write(`${JSON.stringify({ section: opts.section, value: sectionJson(report, slot, opts.section) })}\n`);
    else stdout.write(`${JSON.stringify(seatJson(report, slot))}\n`);
  } else {
    stdout.write(`${renderCoach(report, slot, opts.lang, opts.section ?? 'summary')}\n`);
  }
  return 0;
}
