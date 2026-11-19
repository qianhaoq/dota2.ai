/**
 * `dota2ai coach <matchId> [--hero slug|name|id] [--lang en|zh] [--json]`
 * Renders the dota2.ai coach report (GET /api/coach/:id) in the terminal.
 * Exit codes: 0 ok, 2 invalid input, 3 match missing / no data, 4 upstream.
 */
const USAGE = 'Usage: dota2ai coach <matchId> [--hero slug|name|id] [--lang en|zh] [--json]';

export function parseCoachArgs(args) {
  const opts = { matchId: args[1], hero: null, lang: 'en', json: false };
  if (!opts.matchId || !/^[1-9]\d{0,12}$/.test(opts.matchId)) throw usage(USAGE);
  for (let i = 2; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--json') opts.json = true;
    else if (flag === '--hero' || flag === '--lang') {
      const v = args[++i];
      if (!v || v.startsWith('--')) throw usage(`Missing value: ${flag}`);
      opts[flag.slice(2)] = v;
    } else throw usage(`Unknown option: ${flag}`);
  }
  if (!['en', 'zh'].includes(opts.lang)) throw usage('Language must be en or zh');
  return opts;
}

function usage(message) { return Object.assign(new Error(message), { code: 'INVALID_INPUT' }); }

export function findSlot(report, hero) {
  if (hero == null) return null;
  const q = String(hero).toLowerCase().replace(/[\s_-]/g, '');
  const p = report.players.find((x) => String(x.hero.id) === q || x.hero.slug.replace(/_/g, '') === q
    || x.hero.en.toLowerCase().replace(/[\s_-]/g, '') === q || x.hero.zh === hero);
  if (!p) throw usage(`Hero not in this match: ${hero}`);
  return p.slot;
}

const clock = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

export function renderCoach(report, slot, lang) {
  const L = (b) => (b ? b[lang] ?? b.en : '');
  const m = report.match;
  const zh = lang === 'zh';
  const lines = [];
  const winner = m.radiant_win ? (zh ? '天辉胜利' : 'Radiant victory') : (zh ? '夜魇胜利' : 'Dire victory');
  lines.push(`#${m.id} · ${winner} ${m.score[0]}–${m.score[1]} · ${clock(m.duration)}${m.patch ? ` · ${m.patch}` : ''} · ${m.parsed ? (zh ? '已解析' : 'parsed') : (zh ? '未解析' : 'not parsed')}`);
  if (slot == null) {
    lines.push('', zh ? '用 --hero 指定你的英雄：' : 'Pick your hero with --hero:');
    for (const p of report.players) lines.push(`  ${p.radiant ? 'R' : 'D'}  ${p.hero.slug.padEnd(22)} ${L(p.hero)}  ${p.kda.join('/')}`);
    return lines.join('\n');
  }
  const p = report.players[slot];
  const rv = report.reviews[slot];
  lines.push(`${L(p.hero)} · ${L(rv.role.label)} · ${p.kda.join('/')} · ${rv.won ? (zh ? '胜' : 'win') : (zh ? '负' : 'loss')}`, '', L(rv.headline));
  const evidence = (e) => {
    const parts = [e.v, e.items?.map((k) => L(report.players.flatMap((x) => x.items).find((i) => i.key === k)) || k).join(', '), L(e.sub)].filter(Boolean);
    return `${L(e.k)}: ${parts.join(' · ')}`;
  };
  rv.findings.forEach((f, i) => {
    lines.push('', `${i + 1}. ${f.tone === 'good' ? '✓' : '!'} ${L(f.title)}`);
    if (f.tone === 'fix') lines.push(`   ${zh ? '怎么做' : 'What to do'}: ${L(f.action ?? f.ask)}`);
    lines.push(`   ${L(f.body)}`);
    for (const e of f.evidence) if (!e.heroes) lines.push(`   - ${evidence(e)}`);
    if (f.caveat) lines.push(`   (${L(f.caveat)})`);
  });
  if (report.data_gaps.length) {
    lines.push('', zh ? '尚未解析，暂时看不到：' : 'Not parsed yet — cannot see:');
    for (const g of report.data_gaps) lines.push(`  - ${L(g)}`);
    lines.push(zh ? `  在 https://dota2.ai/r/${m.id} 一键请求解析。` : `  Request a parse at https://dota2.ai/r/${m.id}`);
  }
  return lines.join('\n');
}

export async function runCoach(args, { stdout, stderr, env = process.env, fetchImpl = globalThis.fetch } = {}) {
  let opts;
  try { opts = parseCoachArgs(args); } catch (e) { stderr.write(`${e.message}\n`); return 2; }
  const url = new URL(`/api/coach/${opts.matchId}`, env.DOTA2AI_API_BASE || 'https://dota2.ai');
  let res; let body;
  try {
    res = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
    body = await res.json();
  } catch {
    stderr.write('Coach request failed\n');
    return 4;
  }
  if (!res.ok) {
    stderr.write(`${body?.error ?? `HTTP ${res.status}`}\n`);
    return res.status === 400 ? 2 : res.status === 404 || res.status === 422 ? 3 : 4;
  }
  let slot;
  try { slot = findSlot(body, opts.hero); } catch (e) { stderr.write(`${e.message}\n`); return 2; }
  if (opts.json) {
    stdout.write(`${JSON.stringify(slot == null ? body : { ...body, selected: slot })}\n`);
  } else {
    stdout.write(`${renderCoach(body, slot, opts.lang)}\n`);
  }
  return 0;
}
