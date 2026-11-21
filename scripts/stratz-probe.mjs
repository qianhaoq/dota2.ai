#!/usr/bin/env node
/**
 * One-off STRATZ capability probe (5 requests). Answers, against the live API
 * and OUR token tier, what the rank-split coach data would rest on:
 *   1. introspection: args of heroStats.matchUp / laneOutcome / itemFullPurchase
 *   2. matchUp(heroId, bracketBasicIds, week) — per-rank hero vs hero
 *   3. laneOutcome(heroId, isWith:false, bracketBasicIds, week) — per-rank lane result
 *   4. same matchUp with an in-progress week stamp — is it ignored?
 *   5. match(id) — does lib/upstream/stratz.js (the fallback) work on this tier?
 *
 * Usage: STRATZ_API_TOKEN=... node scripts/stratz-probe.mjs [heroId=29] [matchId]
 * The token is read from the environment (or .env) and never printed.
 */
import { readFileSync } from 'node:fs';

function token() {
  if (process.env.STRATZ_API_TOKEN) return process.env.STRATZ_API_TOKEN.trim();
  try {
    const line = readFileSync(new URL('../.env', import.meta.url), 'utf8')
      .split('\n').find((l) => l.startsWith('STRATZ_API_TOKEN='));
    return line?.slice('STRATZ_API_TOKEN='.length).trim().replace(/^['"]|['"]$/g, '') || null;
  } catch { return null; }
}

const TOKEN = token();
if (!TOKEN) { console.error('STRATZ_API_TOKEN not set (env or .env)'); process.exit(2); }
const HERO = Number(process.argv[2] ?? 29); // Tidehunter
const MATCH = Number(process.argv[3] ?? 9035042364);

// Week stamps: Monday 00:00 UTC, unix seconds.
const DAY = 86400;
const now = Math.floor(Date.now() / 1000);
const thisMonday = Math.floor((now - ((new Date().getUTCDay() + 6) % 7) * DAY) / DAY) * DAY;
const lastWeek = thisMonday - 7 * DAY;

async function gql(label, query, variables = {}) {
  const res = await fetch('https://api.stratz.com/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, 'user-agent': 'STRATZ_API' },
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 300) }; }
  console.log(`\n=== ${label}  HTTP ${res.status}  ratelimit-remaining=${res.headers.get('x-ratelimit-remaining-hour') ?? res.headers.get('x-ratelimit-remaining') ?? '?'}`);
  if (body.errors) console.log('errors:', body.errors.map((e) => e.message).join(' | '));
  if (!res.ok && !body.errors) console.log('body:', body.message ?? body.raw ?? text.slice(0, 200));
  if (res.status === 403 || res.status === 401) { console.error('token rejected — stopping'); process.exit(1); }
  return body.data ?? null;
}

const summarize = (rows, n = 3) => (Array.isArray(rows) ? { count: rows.length, sample: rows.slice(0, n) } : rows);

// 1. Introspection
const intro = await gql('1 introspection HeroStatsQuery', `{ __type(name: "HeroStatsQuery") { fields { name args { name type { name kind ofType { name kind ofType { name } } } } } } }`);
for (const f of intro?.__type?.fields ?? []) {
  if (['matchUp', 'laneOutcome', 'itemFullPurchase', 'heroVsHeroMatchup', 'winWeek', 'winGameVersion'].includes(f.name)) {
    const t = (x) => x?.name ?? (x?.ofType ? `${x.kind === 'LIST' ? '[' : ''}${t(x.ofType)}${x.kind === 'LIST' ? ']' : ''}${x.kind === 'NON_NULL' ? '!' : ''}` : '?');
    console.log(`  ${f.name}(${f.args.map((a) => `${a.name}: ${t(a.type)}`).join(', ')})`);
  }
}

// 2. matchUp, last completed week, Divine–Immortal and Crusader–Archon
const mu = await gql(`2 matchUp hero=${HERO} week=${new Date(lastWeek * 1000).toISOString().slice(0, 10)}`, `
  query ($h: Short!, $w: Long) {
    di: heroStats { matchUp(heroId: $h, week: $w, bracketBasicIds: [DIVINE_IMMORTAL], take: 200) { heroId matchCountVs vs { heroId2 matchCount winCount synergy } } }
    ca: heroStats { matchUp(heroId: $h, week: $w, bracketBasicIds: [CRUSADER_ARCHON], take: 200) { heroId matchCountVs vs { heroId2 matchCount winCount synergy } } }
  }`, { h: HERO, w: lastWeek });
for (const k of ['di', 'ca']) {
  const vs = mu?.[k]?.matchUp?.[0]?.vs ?? [];
  const games = vs.map((r) => r.matchCount).sort((a, b) => a - b);
  console.log(`  ${k}: total=${mu?.[k]?.matchUp?.[0]?.matchCountVs} pairs=${vs.length} median pair games=${games[games.length >> 1]} min=${games[0]} max=${games.at(-1)}`);
  console.log('  sample', JSON.stringify(vs.slice(0, 3)));
}

// 3. laneOutcome
const lo = await gql('3 laneOutcome vs, Divine–Immortal', `
  query ($h: Short!, $w: Long) { heroStats { laneOutcome(heroId: $h, isWith: false, week: $w, bracketBasicIds: [DIVINE_IMMORTAL]) {
    heroId1 heroId2 week bracketBasicIds position matchCount winCount drawCount lossCount stompWinCount stompLossCount csCount } } }`, { h: HERO, w: lastWeek });
console.log(' ', JSON.stringify(summarize(lo?.heroStats?.laneOutcome)));

// 4. in-progress week stamp: same answer as no stamp?
const cur = await gql('4 matchUp with in-progress week vs no week', `
  query ($h: Short!, $w: Long) {
    cur: heroStats { matchUp(heroId: $h, week: $w, bracketBasicIds: [DIVINE_IMMORTAL], take: 3) { matchCountVs } }
    none: heroStats { matchUp(heroId: $h, bracketBasicIds: [DIVINE_IMMORTAL], take: 3) { matchCountVs } }
  }`, { h: HERO, w: thisMonday });
console.log(`  current-week total=${cur?.cur?.matchUp?.[0]?.matchCountVs} no-week total=${cur?.none?.matchUp?.[0]?.matchCountVs} last-week total=${mu?.di?.matchUp?.[0]?.matchCountVs}`);

// 5. match(id) — the fallback source
const m = await gql(`5 match(${MATCH})`, `query ($id: Long!) { match(id: $id) { id didRadiantWin durationSeconds players { heroId kills deaths stats { itemPurchases { time itemId } } } } }`, { id: MATCH });
const p = m?.match?.players;
console.log(`  match=${m?.match?.id ?? null} players=${p?.length ?? 0} withPurchaseLog=${p?.filter((x) => x.stats?.itemPurchases?.length).length ?? 0}`);
