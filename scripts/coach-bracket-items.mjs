#!/usr/bin/env node
/**
 * Regenerates lib/coach/data/bracket-items.json: mid-game item purchase rates,
 * win rates and median completion minutes in public matches, per rank bracket
 * and position (Pos 1–5 plus pooled core Pos 1–3 and support Pos 4–5), from
 * STRATZ (https://stratz.com — data credit required on every surface that
 * shows it).
 *
 * Per bracket b (hg, ca, la, di), hero id h, and role key r ("1".."5", "core", "support"):
 *   heroes[b][h][r] = {
 *     games, wins,
 *     items: [[itemKey, purchases, wins, medianMinute], ...]
 *   }
 * Kept where `games >= 50` and `purchases >= 25`, for finished mid-game items
 * (`cost >= 2000` built items plus ALWAYS_KEY_ITEMS) completed between 10:00
 * and 24:59 (`(instance ?? 0) === 0` so repeat purchases in one match are not
 * double-counted).
 *
 * Window: the last N completed STRATZ weeks (Thursday 00:00 UTC to Wednesday)
 * that lie wholly inside one patch (OpenDota /api/constants/patch).
 *
 * Checked on every run before anything is written:
 * 1. GraphQL introspection of HeroStatsQuery verifies exact field arguments and
 *    return fields (`itemFullPurchase` and `stats` / `winWeek`).
 * 2. Denominator rows sum to a ~50% win rate in every bracket and match the
 *    requested completed week (catching STRATZ's fallback to the unfinished
 *    current week).
 * 3. A 1-hero warmup verifies the unit of `time` (minutes vs seconds) and
 *    `0 <= wins <= purchases <= games`.
 *
 * Needs STRATZ_API_TOKEN (never printed). Responses are cached per hero/week:
 *   STRATZ_API_TOKEN=... node scripts/coach-bracket-items.mjs [--weeks 2]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALWAYS_KEY_ITEMS, KEY_ITEM_MIN_COST } from '../lib/coach/knowledge.js';
import { BRACKET_ITEMS_MIN_BUYS, BRACKET_ITEMS_MIN_GAMES } from '../lib/coach/bracketItems.js';
import { isBigItemIn, patchData } from '../lib/agent/patchData.js';

export const BRACKETS = Object.freeze({
  hg: 'HERALD_GUARDIAN',
  ca: 'CRUSADER_ARCHON',
  la: 'LEGEND_ANCIENT',
  di: 'DIVINE_IMMORTAL',
});

export const BRACKET_MEDALS = Object.freeze({
  hg: ['HERALD', 'GUARDIAN'],
  ca: ['CRUSADER', 'ARCHON'],
  la: ['LEGEND', 'ANCIENT'],
  di: ['DIVINE', 'IMMORTAL'],
});

export const POSITIONS = Object.freeze({
  1: 'POSITION_1',
  2: 'POSITION_2',
  3: 'POSITION_3',
  4: 'POSITION_4',
  5: 'POSITION_5',
});

const DAY = 86400;
export const WEEK = 7 * DAY;
const iso = (s) => new Date(s * 1000).toISOString().slice(0, 10);

export const INTROSPECTION_QUERY = `
  fragment TypeRef on __Type {
    kind name
    ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } }
  }
  {
    heroStats: __type(name: "HeroStatsQuery") {
      fields {
        name
        args { name type { ...TypeRef } }
        type {
          kind name fields { name }
          ofType {
            kind name fields { name }
            ofType {
              kind name fields { name }
              ofType { kind name fields { name } }
            }
          }
        }
      }
    }
    posType: __type(name: "MatchPlayerPositionType") { enumValues { name } }
    bracketType: __type(name: "RankBracketBasicEnum") { enumValues { name } }
  }
`;

function unwrapType(t) {
  let cur = t;
  let nonNull = false;
  let list = false;
  while (cur?.ofType) {
    if (cur.kind === 'NON_NULL') nonNull = true;
    if (cur.kind === 'LIST') list = true;
    cur = cur.ofType;
  }
  return { kind: cur?.kind ?? null, name: cur?.name ?? null, nonNull, list };
}

function unwrapReturnFields(t) {
  let cur = t;
  while (cur && !Array.isArray(cur.fields) && cur.ofType) cur = cur.ofType;
  return new Set((cur?.fields ?? []).map((f) => f.name));
}

/** Parse STRATZ HeroStatsQuery introspection into verified query capabilities. */
export function parseIntrospection(data) {
  const fields = data?.heroStats?.fields;
  if (!Array.isArray(fields)) throw new Error('STRATZ introspection returned no HeroStatsQuery.fields');
  const byName = new Map(fields.map((f) => [f.name, f]));

  const itemField = byName.get('itemFullPurchase');
  if (!itemField) throw new Error('HeroStatsQuery has no itemFullPurchase field');
  const itemArgs = new Map(itemField.args.map((a) => [a.name, unwrapType(a.type)]));
  const itemReturn = unwrapReturnFields(itemField.type);
  for (const req of ['itemId', 'time', 'matchCount', 'winCount']) {
    if (!itemReturn.has(req)) throw new Error(`itemFullPurchase return type is missing ${req}`);
  }
  if (!itemArgs.has('week')) throw new Error('itemFullPurchase has no week argument');
  if (!itemArgs.has('heroId') && !itemArgs.has('heroIds')) throw new Error('itemFullPurchase has neither heroId nor heroIds');
  if (!itemArgs.has('positionIds')) throw new Error('itemFullPurchase has no positionIds argument');
  if (!itemArgs.has('bracketBasicIds') && !itemArgs.has('bracketIds')) throw new Error('itemFullPurchase has no bracket argument');

  const statsField = byName.get('stats');
  const winWeekField = byName.get('winWeek');
  let denom = null;
  if (statsField) {
    const sArgs = new Map(statsField.args.map((a) => [a.name, unwrapType(a.type)]));
    const sRet = unwrapReturnFields(statsField.type);
    if (sArgs.has('week') && sArgs.has('positionIds') && (sArgs.has('bracketBasicIds') || sArgs.has('bracketIds')) && sRet.has('heroId') && sRet.has('matchCount') && sRet.has('winCount')) {
      denom = {
        field: 'stats',
        bracketArg: sArgs.has('bracketBasicIds') ? 'bracketBasicIds' : 'bracketIds',
        groupByPosition: sArgs.has('groupByPosition') && sRet.has('position'),
        hasMatchLimit: sArgs.has('matchLimit'),
        returnFields: sRet,
      };
    }
  }
  if (!denom && winWeekField) {
    const wArgs = new Map(winWeekField.args.map((a) => [a.name, unwrapType(a.type)]));
    const wRet = unwrapReturnFields(winWeekField.type);
    if (wArgs.has('positionIds') && (wArgs.has('bracketBasicIds') || wArgs.has('bracketIds')) && wRet.has('heroId') && wRet.has('week') && wRet.has('matchCount') && wRet.has('winCount')) {
      denom = {
        field: 'winWeek',
        bracketArg: wArgs.has('bracketBasicIds') ? 'bracketBasicIds' : 'bracketIds',
        hasTake: wArgs.has('take'),
        returnFields: wRet,
      };
    }
  }
  if (!denom) throw new Error('Neither HeroStatsQuery.stats nor HeroStatsQuery.winWeek supports per-position bracket denominators');

  const posEnums = new Set((data?.posType?.enumValues ?? []).map((e) => e.name));
  if (posEnums.size) {
    for (const p of Object.values(POSITIONS)) {
      if (!posEnums.has(p)) throw new Error(`MatchPlayerPositionType missing ${p}`);
    }
  }

  return {
    item: {
      heroArg: itemArgs.has('heroId') ? 'heroId' : 'heroIds',
      bracketArg: itemArgs.has('bracketBasicIds') ? 'bracketBasicIds' : 'bracketIds',
      hasMinTime: itemArgs.has('minTime'),
      hasMaxTime: itemArgs.has('maxTime'),
      hasItemIds: itemArgs.has('itemIds'),
      hasMatchLimit: itemArgs.has('matchLimit'),
      returnFields: itemReturn,
    },
    denom,
  };
}

/** Choose up to `want` completed STRATZ weeks (Thursday 00:00 UTC) wholly inside one patch. */
export function selectCompletedWeeks(patches, nowSec, want = 2) {
  const starts = [...patches]
    .map((p) => ({ name: p.name, at: Math.floor(Date.parse(p.date) / 1000) }))
    .filter((p) => p.name && Number.isFinite(p.at))
    .sort((a, b) => a.at - b.at);
  const patchAt = (s) => starts.filter((p) => p.at <= s).at(-1);
  const current = Math.floor(nowSec / WEEK) * WEEK;
  const weeks = [];
  let patch = null;
  for (let w = current - WEEK; weeks.length < want && w > current - 60 * WEEK; w -= WEEK) {
    const a = patchAt(w);
    const b = patchAt(w + WEEK - 1);
    if (!a || !b || a.name !== b.name) {
      if (weeks.length) break;
      continue;
    }
    if (patch && a.name !== patch) break;
    patch = a.name;
    weeks.push(w);
  }
  if (!weeks.length) throw new Error('no completed week inside one patch');
  return { patch, weeks };
}

function bracketArgClause(bracketArg, bKey) {
  return bracketArg === 'bracketBasicIds'
    ? `bracketBasicIds: [${BRACKETS[bKey]}]`
    : `bracketIds: [${BRACKET_MEDALS[bKey].join(', ')}]`;
}

/** Build the per-week denominator GraphQL query (`stats` or `winWeek`). */
export function buildDenominatorQuery(spec, nowSec, oldestWeekSec) {
  const d = spec.denom;
  const sel = ['heroId', ...(d.returnFields.has('week') ? ['week'] : []), ...(d.returnFields.has('time') ? ['time'] : []), ...(d.groupByPosition ? ['position'] : []), 'matchCount', 'winCount'].join(' ');
  if (d.field === 'stats') {
    if (d.groupByPosition) {
      const aliases = Object.keys(BRACKETS).map((k) => (
        `s_${k}: stats(week: $w, ${bracketArgClause(d.bracketArg, k)}, positionIds: [${Object.values(POSITIONS).join(', ')}], groupByPosition: true${d.hasMatchLimit ? ', matchLimit: 0' : ''}) { ${sel} }`
      )).join(' ');
      return { query: `query ($w: Long) { heroStats { ${aliases} } }`, usesWeekVar: true };
    }
    const aliases = Object.keys(BRACKETS).flatMap((k) => Object.entries(POSITIONS).map(([p, pEnum]) => (
      `s_${k}_${p}: stats(week: $w, ${bracketArgClause(d.bracketArg, k)}, positionIds: [${pEnum}]${d.hasMatchLimit ? ', matchLimit: 0' : ''}) { ${sel} }`
    ))).join(' ');
    return { query: `query ($w: Long) { heroStats { ${aliases} } }`, usesWeekVar: true };
  }
  const take = Math.max(8, Math.ceil((nowSec - oldestWeekSec) / WEEK) + 2);
  const aliases = Object.keys(BRACKETS).flatMap((k) => Object.entries(POSITIONS).map(([p, pEnum]) => (
    `s_${k}_${p}: winWeek(${d.hasTake ? `take: ${take}, ` : ''}${bracketArgClause(d.bracketArg, k)}, positionIds: [${pEnum}]) { ${sel} }`
  ))).join(' ');
  return { query: `{ heroStats { ${aliases} } }`, usesWeekVar: false };
}

/** Extract `denom[bracket][heroId][pos] = [games, wins]` for one week `w`, checking week echo. */
export function extractWeekDenominators(heroStats, spec, w, knownHeroes) {
  const d = spec.denom;
  const weekIdx = Math.floor(w / WEEK);
  const posKeyByEnum = Object.fromEntries(Object.entries(POSITIONS).map(([k, v]) => [v, k]));
  const out = Object.fromEntries(Object.keys(BRACKETS).map((k) => [k, {}]));

  const ingest = (bKey, pKey, rows) => {
    // Only filter time === 0 if the endpoint returned a multi-point time series despite groupByTime not being set.
    const hasTimeSeries = new Set((rows ?? []).map((r) => r?.time).filter(Number.isFinite)).size > 1;
    const byHero = new Map();
    for (const r of rows ?? []) {
      if (!knownHeroes.has(r.heroId)) continue;
      if (d.field === 'winWeek') {
        if (r.week !== w && r.week !== weekIdx) continue;
      } else if (r.week != null && r.week !== w && r.week !== weekIdx) {
        throw new Error(`week ${iso(w)} ${bKey} pos ${pKey}: STRATZ answered for week ${r.week}, not ${weekIdx}`);
      }
      if (hasTimeSeries && r.time !== 0) continue;
      const prev = byHero.get(r.heroId) ?? [0, 0];
      byHero.set(r.heroId, [prev[0] + r.matchCount, prev[1] + r.winCount]);
    }
    for (const [h, counts] of byHero) {
      (out[bKey][h] ??= {})[pKey] = counts;
    }
  };

  if (d.field === 'stats' && d.groupByPosition) {
    for (const bKey of Object.keys(BRACKETS)) {
      const grouped = new Map();
      for (const r of heroStats?.[`s_${bKey}`] ?? []) {
        const pKey = posKeyByEnum[r.position] ?? (POSITIONS[r.position] ? String(r.position) : null);
        if (!pKey) continue;
        if (!grouped.has(pKey)) grouped.set(pKey, []);
        grouped.get(pKey).push(r);
      }
      for (const pKey of Object.keys(POSITIONS)) ingest(bKey, pKey, grouped.get(pKey) ?? []);
    }
  } else {
    for (const bKey of Object.keys(BRACKETS)) {
      for (const pKey of Object.keys(POSITIONS)) {
        ingest(bKey, pKey, heroStats?.[`s_${bKey}_${pKey}`] ?? []);
      }
    }
  }
  return out;
}

/** Detect whether `itemFullPurchase.time` is in minutes (`10..24`) or seconds (`600..1499`). */
export function detectTimeUnit(rows) {
  const times = (rows ?? []).map((r) => r?.time).filter(Number.isFinite);
  if (!times.length) throw new Error('warmup itemFullPurchase returned no timed rows');
  const max = Math.max(...times);
  if (max > 300) return { unit: 'seconds', minTime: 600, maxTime: 1499, toMinute: (t) => Math.floor(t / 60) };
  if (max >= 10 && max <= 240) return { unit: 'minutes', minTime: 10, maxTime: 24, toMinute: (t) => Math.trunc(t) };
  throw new Error(`unexpected itemFullPurchase time range (max=${max})`);
}

/**
 * Build a batched `itemFullPurchase` GraphQL query for `heroIds` in one week.
 * @param {any} spec
 * @param {number[]} heroIds
 * @param {{ timeWindow?: { minTime: number, maxTime: number } | null, itemIds?: number[] | null }} [opts]
 */
export function buildItemBatchQuery(spec, heroIds, { timeWindow = null, itemIds = null } = {}) {
  const it = spec.item;
  const sel = [
    ...(it.heroArg === 'heroIds' && it.returnFields.has('heroId') ? ['heroId'] : []),
    'itemId',
    ...(it.returnFields.has('time') ? ['time'] : []),
    ...(it.returnFields.has('week') ? ['week'] : []),
    ...(it.returnFields.has('instance') ? ['instance'] : []),
    'matchCount',
    'winCount',
  ].join(' ');
  const filters = [
    ...(timeWindow && it.hasMinTime ? [`minTime: ${timeWindow.minTime}`] : []),
    ...(timeWindow && it.hasMaxTime ? [`maxTime: ${timeWindow.maxTime}`] : []),
    ...(Array.isArray(itemIds) && itemIds.length && it.hasItemIds ? [`itemIds: [${itemIds.join(', ')}]`] : []),
    ...(it.hasMatchLimit ? ['matchLimit: 0'] : []),
  ];
  const extra = filters.length ? `, ${filters.join(', ')}` : '';

  if (it.heroArg === 'heroId') {
    const aliases = heroIds.flatMap((h) => Object.keys(BRACKETS).flatMap((bKey) => Object.entries(POSITIONS).map(([pKey, pEnum]) => (
      `i_${bKey}_${pKey}_${h}: itemFullPurchase(heroId: ${h}, week: $w, ${bracketArgClause(it.bracketArg, bKey)}, positionIds: [${pEnum}]${extra}) { ${sel} }`
    )))).join('\n  ');
    return `query ($w: Long) { heroStats {\n  ${aliases}\n} }`;
  }
  const aliases = Object.keys(BRACKETS).flatMap((bKey) => Object.entries(POSITIONS).map(([pKey, pEnum]) => (
    `i_${bKey}_${pKey}: itemFullPurchase(heroIds: [${heroIds.join(', ')}], week: $w, ${bracketArgClause(it.bracketArg, bKey)}, positionIds: [${pEnum}]${extra}) { ${sel} }`
  ))).join('\n  ');
  return `query ($w: Long) { heroStats {\n  ${aliases}\n} }`;
}

/** Exact integer median minute from a `Map<minute, purchases>` histogram, or null when unbinned. */
export function medianMinuteFromBins(bins, totalPurchases) {
  if (!bins || !bins.size || !totalPurchases) return null;
  const half = totalPurchases / 2;
  let acc = 0;
  for (const [minute, count] of [...bins.entries()].sort((a, b) => a[0] - b[0])) {
    acc += count;
    if (acc >= half) return minute;
  }
  return null;
}

/**
 * Aggregate weekly denominators and item rows into `heroes[b][h][role]`,
 * checking every mathematical invariant before returning.
 * @returns {{ heroes: Record<string, Record<string, any>>, games: Record<string, number> }}
 */
export function aggregateBracketItems({ weekDenominators, readHeroWeekItems, heroes, weeks, itemKeyById, timeWindow }) {
  const totalDenom = Object.fromEntries(Object.keys(BRACKETS).map((k) => [k, {}]));
  for (const w of weeks) {
    const wd = weekDenominators.get(w);
    for (const bKey of Object.keys(BRACKETS)) {
      let bGames = 0;
      let bWins = 0;
      for (const [hStr, byPos] of Object.entries(wd?.[bKey] ?? {})) {
        const dst = (totalDenom[bKey][hStr] ??= {});
        for (const [pKey, [g, wn]] of Object.entries(byPos)) {
          if (g < 0 || wn < 0 || wn > g) throw new Error(`invalid denominator (${bKey} h=${hStr} p=${pKey}): ${wn}/${g}`);
          bGames += g;
          bWins += wn;
          const prev = dst[pKey] ?? [0, 0];
          dst[pKey] = [prev[0] + g, prev[1] + wn];
        }
      }
      if (!bGames) throw new Error(`week ${iso(w)} ${bKey}: zero hero games in denominator`);
      const wr = bWins / bGames;
      if (Math.abs(wr - 0.5) >= 0.025) {
        throw new Error(`week ${iso(w)} ${bKey}: overall win share is ${(wr * 100).toFixed(1)}%, not ~50%`);
      }
    }
  }

  const outHeroes = Object.fromEntries(Object.keys(BRACKETS).map((k) => [k, {}]));
  const gamesPerBracket = Object.fromEntries(Object.keys(BRACKETS).map((k) => [k, 0]));
  let bigCellsChecked = 0;
  let bigCellsOverflowed = 0;

  for (const bKey of Object.keys(BRACKETS)) {
    let totalHeroGames = 0;
    for (const h of heroes) {
      const hKey = String(h);
      const posDenom = totalDenom[bKey][hKey] ?? {};
      // Per position 1..5: Map<itemKey, { buys, wins, bins: Map<minute, buys> }>
      const posItems = Object.fromEntries(Object.keys(POSITIONS).map((p) => [p, new Map()]));

      for (const w of weeks) {
        const weekIdx = Math.floor(w / WEEK);
        const rawByBracketPos = readHeroWeekItems(h, w);
        for (const pKey of Object.keys(POSITIONS)) {
          const rows = rawByBracketPos?.[`${bKey}_${pKey}`] ?? [];
          for (const r of rows) {
            if (r.week != null && r.week !== w && r.week !== weekIdx) {
              throw new Error(`week ${iso(w)} ${bKey} hero ${h} pos ${pKey}: STRATZ answered for week ${r.week}`);
            }
            if ((r.instance ?? 0) !== 0) continue;
            const itemKey = itemKeyById.get(Number(r.itemId));
            if (!itemKey) continue;
            if (r.time != null && (r.time < timeWindow.minTime || r.time > timeWindow.maxTime)) continue;
            if (r.matchCount < 0 || r.winCount < 0 || r.winCount > r.matchCount) {
              throw new Error(`invalid item counts (${bKey} h=${h} p=${pKey} ${itemKey}): ${r.winCount}/${r.matchCount}`);
            }
            const cur = posItems[pKey].get(itemKey) ?? { buys: 0, wins: 0, bins: new Map() };
            cur.buys += r.matchCount;
            cur.wins += r.winCount;
            if (r.time != null) {
              const m = timeWindow.toMinute(r.time);
              cur.bins.set(m, (cur.bins.get(m) ?? 0) + r.matchCount);
            }
            posItems[pKey].set(itemKey, cur);
          }
        }
      }

      const buildCell = (positions) => {
        let games = 0;
        let wins = 0;
        const merged = new Map();
        for (const pKey of positions) {
          const [g, wn] = posDenom[pKey] ?? [0, 0];
          games += g;
          wins += wn;
          for (const [itemKey, st] of posItems[pKey]) {
            const cur = merged.get(itemKey) ?? { buys: 0, wins: 0, bins: new Map() };
            cur.buys += st.buys;
            cur.wins += st.wins;
            for (const [m, c] of st.bins) cur.bins.set(m, (cur.bins.get(m) ?? 0) + c);
            merged.set(itemKey, cur);
          }
        }
        if (positions.length === 1) totalHeroGames += games;
        if (games < BRACKET_ITEMS_MIN_GAMES) return null;

        bigCellsChecked += 1;
        let cellOverflow = false;
        const list = [];
        for (const [itemKey, st] of merged) {
          if (st.buys < BRACKET_ITEMS_MIN_BUYS) continue;
          if (st.buys > Math.ceil(games * 1.01)) cellOverflow = true;
          const buys = Math.min(st.buys, games);
          const itemWins = Math.min(st.wins, buys);
          list.push([itemKey, buys, itemWins, medianMinuteFromBins(st.bins, st.buys)]);
        }
        if (cellOverflow) bigCellsOverflowed += 1;
        list.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
        return { games, wins, items: list };
      };

      const heroOut = {};
      for (const pKey of Object.keys(POSITIONS)) {
        const cell = buildCell([pKey]);
        if (cell) heroOut[pKey] = cell;
      }
      const coreCell = buildCell(['1', '2', '3']);
      if (coreCell) heroOut.core = coreCell;
      const supCell = buildCell(['4', '5']);
      if (supCell) heroOut.support = supCell;
      if (Object.keys(heroOut).length) outHeroes[bKey][hKey] = heroOut;
    }
    gamesPerBracket[bKey] = Math.round(totalHeroGames / 10);
    if (!Object.keys(outHeroes[bKey]).length) {
      throw new Error(`bracket ${bKey}: no heroes met sample floor (${BRACKET_ITEMS_MIN_GAMES})`);
    }
  }

  if (bigCellsChecked && bigCellsOverflowed > Math.max(2, bigCellsChecked * 0.002)) {
    throw new Error(`item purchases exceeded hero games in ${bigCellsOverflowed}/${bigCellsChecked} cells`);
  }

  return { heroes: outHeroes, games: gamesPerBracket };
}

async function main() {
  const TOKEN = process.env.STRATZ_API_TOKEN?.trim();
  if (!TOKEN) {
    console.error('STRATZ_API_TOKEN is not set');
    process.exit(2);
  }
  const arg = (name, dflt) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : dflt;
  };
  const WEEKS = Number(arg('weeks', 2));
  const INITIAL_BATCH = Number(arg('batch', 2));
  const CACHE = arg('cache', join(tmpdir(), 'dota2ai-stratz-bracket-items-v1'));
  const NAMES = JSON.parse(readFileSync(new URL('../lib/coach/data/names.json', import.meta.url), 'utf8'));
  const ITEMS = JSON.parse(readFileSync(new URL('../lib/data/constants/items.json', import.meta.url), 'utf8'));
  const OUT = new URL('../lib/coach/data/bracket-items.json', import.meta.url);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const currentPd = patchData(null);
  const itemKeyById = new Map();
  for (const [key, it] of Object.entries(ITEMS)) {
    if (Number.isFinite(it?.id) && isBigItemIn(currentPd, key, { minCost: KEY_ITEM_MIN_COST, always: ALWAYS_KEY_ITEMS })) {
      itemKeyById.set(Number(it.id), key);
    }
  }
  const bigItemIds = [...itemKeyById.keys()].sort((a, b) => a - b);

  let requests = 0;
  async function gql(query, variables = {}) {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const res = await fetch('https://api.stratz.com/graphql', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, 'user-agent': 'STRATZ_API' },
        body: JSON.stringify({ query, variables }),
      });
      requests += 1;
      if (res.status === 429) {
        console.error('429 — waiting 60s');
        await sleep(60000);
        continue;
      }
      if (res.status === 401 || res.status === 403) throw new Error(`STRATZ rejected the token (${res.status})`);
      const body = await res.json().catch(() => null);
      if (res.ok && body?.data && !body.errors) return body.data;
      const errMsg = body?.errors?.map((e) => e.message).join(' | ') ?? '';
      if (res.status === 400 || /complex|depth|syntax|cannot query/i.test(errMsg)) {
        const fatal = new Error(`STRATZ GraphQL error (HTTP ${res.status}): ${errMsg}`);
        fatal.graphqlFatal = true;
        throw fatal;
      }
      console.error(`STRATZ HTTP ${res.status} ${errMsg}`);
      await sleep(3000 * (attempt + 1));
    }
    throw new Error('STRATZ GraphQL request failed after 6 attempts');
  }

  const patches = await (await fetch('https://api.opendota.com/api/constants/patch', { headers: { 'user-agent': 'dota2.ai data refresh' } })).json();
  const nowSec = Math.floor(Date.now() / 1000);
  const { patch, weeks } = selectCompletedWeeks(patches, nowSec, WEEKS);
  console.error(`patch ${patch}, weeks starting ${weeks.map(iso).join(', ')} (${bigItemIds.length} big items)`);

  // 1. Introspect HeroStatsQuery so field arguments and return shapes are verified, never guessed.
  const introData = await gql(INTROSPECTION_QUERY);
  const spec = parseIntrospection(introData);

  // 2. Fetch denominators per (week, bracket, hero, position).
  const heroes = Object.keys(NAMES.heroes).map(Number).sort((a, b) => a - b);
  const knownHeroes = new Set(heroes);
  const denomQuery = buildDenominatorQuery(spec, nowSec, weeks.at(-1));
  const weekDenominators = new Map();
  if (denomQuery.usesWeekVar) {
    for (const w of weeks) {
      const data = await gql(denomQuery.query, { w });
      weekDenominators.set(w, extractWeekDenominators(data.heroStats, spec, w, knownHeroes));
      await sleep(400);
    }
  } else {
    const data = await gql(denomQuery.query);
    for (const w of weeks) {
      weekDenominators.set(w, extractWeekDenominators(data.heroStats, spec, w, knownHeroes));
    }
  }

  // 3. 1-hero warmup on Anti-Mage (heroId 1) in Crusader–Archon Pos 1 without time bounds to verify time units.
  const warmupQuery = `query ($w: Long) { heroStats { warmup: itemFullPurchase(${spec.item.heroArg === 'heroId' ? 'heroId: 1' : 'heroIds: [1]'}, week: $w, ${bracketArgClause(spec.item.bracketArg, 'ca')}, positionIds: [POSITION_1]) { itemId ${spec.item.returnFields.has('time') ? 'time ' : ''}${spec.item.returnFields.has('instance') ? 'instance ' : ''}matchCount winCount } } }`;
  const warmupData = await gql(warmupQuery, { w: weeks[0] });
  const timeWindow = detectTimeUnit(warmupData.heroStats?.warmup ?? []);
  console.error(`verified time unit: ${timeWindow.unit} (${timeWindow.minTime}..${timeWindow.maxTime}), denom=${spec.denom.field}`);

  // 4. Fetch batched mid-game item purchases per week & hero, with disk cache for clean resume.
  const cacheFile = (h, w) => join(CACHE, `${patch}_${w}`, `${h}.json`);
  let batchSize = Math.max(1, INITIAL_BATCH);

  async function fetchHeroBatch(hs, w) {
    const todo = hs.filter((h) => !existsSync(cacheFile(h, w)));
    if (!todo.length) return;
    try {
      const query = buildItemBatchQuery(spec, todo, { timeWindow, itemIds: bigItemIds });
      const data = await gql(query, { w });
      const d = data.heroStats ?? {};
      mkdirSync(join(CACHE, `${patch}_${w}`), { recursive: true });
      for (const h of todo) {
        const one = {};
        for (const bKey of Object.keys(BRACKETS)) {
          for (const pKey of Object.keys(POSITIONS)) {
            const rows = spec.item.heroArg === 'heroId'
              ? (d[`i_${bKey}_${pKey}_${h}`] ?? [])
              : (d[`i_${bKey}_${pKey}`] ?? []).filter((r) => r.heroId === h);
            // Keep only big items in the mid-game window in cache so cache stays compact.
            one[`${bKey}_${pKey}`] = rows.filter((r) => (
              (r.instance ?? 0) === 0
              && itemKeyById.has(Number(r.itemId))
              && (r.time == null || (r.time >= timeWindow.minTime && r.time <= timeWindow.maxTime))
            ));
          }
        }
        writeFileSync(cacheFile(h, w), JSON.stringify(one));
      }
      await sleep(350);
    } catch (err) {
      if (err?.graphqlFatal && todo.length > 1) {
        batchSize = Math.max(1, Math.floor(todo.length / 2));
        console.error(`GraphQL batch of ${todo.length} rejected; retrying with batch=${batchSize}`);
        for (let i = 0; i < todo.length; i += batchSize) {
          await fetchHeroBatch(todo.slice(i, i + batchSize), w);
        }
        return;
      }
      throw err;
    }
  }

  for (const w of weeks) {
    for (let i = 0; i < heroes.length; i += batchSize) {
      await fetchHeroBatch(heroes.slice(i, i + batchSize), w);
    }
    console.error(`week ${iso(w)} fetched (${requests} requests so far)`);
  }

  const readHeroWeekItems = (h, w) => JSON.parse(readFileSync(cacheFile(h, w), 'utf8'));
  const aggregated = aggregateBracketItems({
    weekDenominators,
    readHeroWeekItems,
    heroes,
    weeks,
    itemKeyById,
    timeWindow,
  });

  const out = {
    source: `STRATZ (https://stratz.com) heroStats.itemFullPurchase and heroStats.${spec.denom.field}, public matches by rank bracket and position; not filtered by game mode`,
    attribution: { en: 'Data: STRATZ', url: 'https://stratz.com' },
    window: 'finished between 10:00 and 24:59',
    patch,
    weeks: { from: iso(weeks.at(-1)), to: iso(weeks[0] + 6 * DAY), count: weeks.length },
    fetched: iso(nowSec),
    brackets: BRACKETS,
    positions: POSITIONS,
    games: aggregated.games,
    heroes: aggregated.heroes,
  };
  writeFileSync(OUT, `${JSON.stringify(out)}\n`);
  console.error(`wrote ${OUT.pathname} (${requests} requests); games per bracket ${JSON.stringify(aggregated.games)}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
