import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createSteamWebApiClient as create, mapWebApiHistory } from '../../lib/upstream/steamWebApi.js';
import { createRecentService, shapeRecent } from '../../lib/coach/recent.js';
import { fetchFromSources, sourceOrder } from '../../lib/upstream/sourceOrder.js';

const createSteamWebApiClient = (o: any): any => create(o);
// Built at run time: a literal here reads as a leaked key to the secret scanner.
const KEY = `webapi-${'K'.repeat(26)}`;
const ME = 86745912;

/** IDOTA2Match_570/GetMatchHistory/v1, as Valve documents it. */
const body = (matches: any[], status = 1) => ({ result: { status, num_results: matches.length, total_results: 500, results_remaining: 480, matches } });
const game = (id: number, slot: number, hero: number, over: any = {}) => ({
  match_id: id, match_seq_num: id - 1000, start_time: 1795000000 + id % 1000, lobby_type: 7, radiant_team_id: 0, dire_team_id: 0,
  players: [
    { account_id: 4294967295, player_slot: slot === 0 ? 1 : 0, team_number: 0, team_slot: 0, hero_id: 1 },
    { account_id: ME, player_slot: slot, team_number: slot < 128 ? 0 : 1, team_slot: slot % 128, hero_id: hero, hero_variant: 2 },
    { account_id: 123, player_slot: 131, team_number: 1, team_slot: 3, hero_id: 9 },
  ],
  ...over,
});
const res = (status: number, json: any = {}) => ({ status, ok: status >= 200 && status < 300, headers: new Headers(), json: async () => json });

describe('mapWebApiHistory', () => {
  it('takes the player\'s hero and seat from their own entry, and nothing the API does not give', () => {
    const rows = mapWebApiHistory(ME, body([game(9096792210, 130, 44), game(9096700001, 2, 14, { lobby_type: 0 })]));
    expect(rows).toEqual([
      { match_id: 9096792210, start_time: 1795000210, lobby_type: 7, hero_id: 44, player_slot: 130 },
      { match_id: 9096700001, start_time: 1795000001, lobby_type: 0, hero_id: 14, player_slot: 2 },
    ]);
    for (const r of rows) for (const k of ['radiant_win', 'player_won', 'kills', 'deaths', 'assists', 'duration', 'game_mode']) expect(r).not.toHaveProperty(k);
  });

  it('shaped for the page: seat and side known, result / K/D/A / duration / mode unknown, never 0', () => {
    const shaped = shapeRecent(ME, mapWebApiHistory(ME, body([game(9096792210, 130, 44)])), 'steam_web_api');
    expect(shaped.source).toBe('steam_web_api');
    expect(shaped.empty_hint).toBeNull();
    expect(shaped.matches[0]).toMatchObject({ match_id: 9096792210, slot: 7, radiant: false, won: null, kda: null, duration: null, mode: null, ranked: true, start_time: 1795000210 });
    expect(shaped.matches[0].hero.id).toBe(44);
    expect(shapeRecent(ME, []).source).toBe('opendota');
    expect(shapeRecent(ME, [], 'anything-else').source).toBe('opendota');
  });

  it('a profile that hides its match data (status 15) is an empty list, which the page explains', () => {
    expect(mapWebApiHistory(ME, body([], 15))).toEqual([]);
    expect(mapWebApiHistory(ME, { result: { status: 15, statusDetail: 'Cannot get match history for a user that hasn\'t allowed it' } })).toEqual([]);
    expect(shapeRecent(ME, [], 'steam_web_api')).toMatchObject({ matches: [], empty_hint: 'private_or_no_matches' });
  });

  it('drops rows it could not show or link: the player missing, no hero, no seat, no id', () => {
    const rows = mapWebApiHistory(ME, body([
      game(1, 0, 5, { players: [{ account_id: 123, player_slot: 0, hero_id: 5 }] }),
      game(2, 0, 0),
      { ...game(3, 0, 5), players: [{ account_id: ME, hero_id: 5 }] },
      { ...game(4, 0, 5), match_id: undefined },
      { match_id: 5 },
      null,
      game(6, 4, 8),
    ]));
    expect(rows.map((r: any) => r.match_id)).toEqual([6]);
  });

  it('another status or an unreadable answer is an error, not an empty list', () => {
    expect(() => mapWebApiHistory(ME, body([], 8))).toThrow(/status 8/);
    for (const bad of [null, {}, { result: null }, 'x']) expect(() => mapWebApiHistory(ME, bad as any)).toThrow(/unreadable/);
    expect(mapWebApiHistory(ME, { result: { status: 1 } })).toEqual([]);
  });
});

describe('createSteamWebApiClient', () => {
  it('asks GetMatchHistory on Valve\'s host for the account, and returns the mapped rows', async () => {
    const seen: string[] = [];
    const c = createSteamWebApiClient({ key: KEY, fetchImpl: async (url: string) => { seen.push(url); return res(200, body([game(9096792210, 130, 44)])); } });
    expect(await c.fetchRecent(ME)).toEqual([{ match_id: 9096792210, start_time: 1795000210, lobby_type: 7, hero_id: 44, player_slot: 130 }]);
    const url = new URL(seen[0]);
    expect(`${url.origin}${url.pathname}`).toBe('https://api.steampowered.com/IDOTA2Match_570/GetMatchHistory/v1/');
    expect(Object.fromEntries(url.searchParams)).toEqual({ key: KEY, account_id: String(ME), matches_requested: '20' });
    await c.fetchRecent(ME, { limit: 500 });
    await c.fetchRecent(ME, { limit: 0 }); // clamped up to 1
    expect(seen.slice(1).map((u) => new URL(u).searchParams.get('matches_requested'))).toEqual(['100', '1']);
    expect(c.snapshot()).toMatchObject({ configured: true, calls: 3, ok: 3, errors: 0, status: { 200: 3 } });
  });

  it('never lets the key out: not in logs, errors or the health snapshot', async () => {
    const logs: string[] = [];
    const leaky = Object.assign(new Error(`request to https://api.steampowered.com/?key=${KEY} failed`), { name: 'FetchError' });
    const cases: any[] = [
      async () => { throw leaky; },
      async () => { throw Object.assign(new Error(`timeout ${KEY}`), { name: 'TimeoutError' }); },
      async () => res(403), async () => res(500), async () => res(429),
      async () => res(200, { result: { status: 8, statusDetail: KEY } }),
      async () => res(200, null),
    ];
    for (const fetchImpl of cases) {
      const c = createSteamWebApiClient({ key: KEY, fetchImpl, log: (l: string) => logs.push(l) });
      const err = await c.fetchRecent(ME).catch((e: any) => e);
      expect(err).toBeInstanceOf(Error);
      expect(JSON.stringify([err.message, err.cause?.message ?? null, err.stack, c.snapshot()])).not.toContain(KEY);
      expect(err.upstream).toBe('steam_web_api');
    }
    expect(logs.join('\n')).not.toContain(KEY);
    expect(logs.join('\n')).not.toMatch(/steampowered|key=/);
    expect(logs.length).toBe(cases.length);
  });

  it('says which failures are worth another try', async () => {
    const run = async (fetchImpl: any) => createSteamWebApiClient({ key: KEY, fetchImpl }).fetchRecent(ME).catch((e: any) => e);
    expect(await run(async () => res(403))).toMatchObject({ status: 502, retryable: false }); // key rejected: ours to fix, not the visitor's 403
    expect(await run(async () => res(401))).toMatchObject({ status: 502, retryable: false });
    expect(await run(async () => res(429))).toMatchObject({ status: 429, retryable: true });
    expect(await run(async () => res(503))).toMatchObject({ status: 503, retryable: true });
    expect(await run(async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); })).toMatchObject({ status: 503, retryable: true, message: 'Steam Web API timeout' });
    expect(await run(async () => res(200, body([], 8)))).toMatchObject({ status: 502, retryable: false });
  });

  it('a caller who left is not an upstream failure', async () => {
    const gone = new AbortController();
    const c = createSteamWebApiClient({ key: KEY, fetchImpl: async (_u: string, init: any) => { gone.abort(); init.signal.throwIfAborted(); return res(200, body([])); } });
    await expect(c.fetchRecent(ME, { signal: gone.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(c.snapshot().errors).toBe(0);
  });

  it('rejects a bad account id without a request, and needs a key', async () => {
    let calls = 0;
    const c = createSteamWebApiClient({ key: KEY, fetchImpl: async () => { calls += 1; return res(200, body([])); } });
    for (const id of [0, -1, 1.5, '5', null, undefined]) await expect(c.fetchRecent(id)).rejects.toMatchObject({ status: 400, retryable: false });
    expect(calls).toBe(0);
    for (const key of ['', undefined, null, 5]) expect(() => createSteamWebApiClient({ key })).toThrow(/STEAM_WEB_API_KEY/);
  });
});

describe('recent games: OpenDota first, the Steam Web API when it fails', () => {
  const od = [{ match_id: 9096792210, player_slot: 130, radiant_win: false, hero_id: 44, kills: 7, deaths: 5, assists: 23, duration: 2549, start_time: 1795000000, game_mode: 22, lobby_type: 7 }];
  function service(openDota: () => Promise<any>, webCalls = { n: 0 }, primary = 'opendota') {
    const web = createSteamWebApiClient({ key: KEY, fetchImpl: async () => { webCalls.n += 1; return res(200, body([game(9096792210, 130, 44)])); } });
    return createRecentService({
      fetchRecent: async (id: number) => {
        const { source, value } = await fetchFromSources(sourceOrder('recent', { primary, configured: { opendota: true, steam_web_api: true } }) as string[], {
          opendota: openDota, steam_web_api: () => web.fetchRecent(id),
        });
        return { rows: value, source };
      },
    } as any) as any;
  }

  it('OpenDota answering: its full rows, and Steam is not asked', async () => {
    const calls = { n: 0 };
    const out = await service(async () => od, calls).get(ME);
    expect(out.source).toBe('opendota');
    expect(out.matches[0]).toMatchObject({ won: true, kda: [7, 5, 23], duration: 2549, slot: 7 });
    expect(calls.n).toBe(0);
  });

  it('OpenDota down: the Steam list, marked as such, with the same match and seat', async () => {
    const out = await service(async () => { throw Object.assign(new Error('OpenDota unavailable'), { status: 503 }); }).get(ME);
    expect(out.source).toBe('steam_web_api');
    expect(out.matches).toHaveLength(1);
    expect(out.matches[0]).toMatchObject({ match_id: 9096792210, slot: 7, radiant: false, won: null, kda: null, duration: null });
  });

  it('with UPSTREAM_PRIMARY=steam_gc Steam is asked first and OpenDota is not waited on', async () => {
    let odCalls = 0;
    const out = await service(async () => { odCalls += 1; return od; }, { n: 0 }, 'steam_gc').get(ME);
    expect(out.source).toBe('steam_web_api');
    expect(odCalls).toBe(0);
  });

  it('a plain array from fetchRecent still works (rows from OpenDota)', async () => {
    const svc: any = createRecentService({ fetchRecent: async () => od } as any);
    expect(await svc.get(ME)).toMatchObject({ source: 'opendota', matches: [{ won: true }] });
  });

  it('server.js wires it: the key already in use, both fetchers, and the source passed on', () => {
    const server = readFileSync('server.js', 'utf8');
    expect(server).toMatch(/const steamWebApi = steamApiKey\s*\?\s*createSteamWebApiClient\(\{ key: steamApiKey,/);
    expect(server).toContain("configured: { opendota: true, steam_web_api: Boolean(steamWebApi) }");
    expect(server).toContain('steam_web_api: () => steamWebApi.fetchRecent(id),');
    expect(server).toContain('return { rows: value, source };');
    expect(server).toContain('steamWebApi: steamWebApi ? steamWebApi.snapshot() : { configured: false },');
  });
});
