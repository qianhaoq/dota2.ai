import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { createHash } from 'node:crypto';
import { openReplayFile, parseLocalReplay, replayFormat } from '../../lib/upstream/localReplay.js';
import { createOdotaParserClient as createClient, mergeGcAndParsed, replayMatchesScoreboard } from '../../lib/upstream/odotaParser.js';
import { mapGcMatch } from '../../lib/upstream/steamGc.js';
import { isMatchParsed } from '../../lib/matchReview/matchParse.js';
import { buildCoachReport } from '../../lib/coach/analyze.js';
import { main, parseArgs, scoreboardLoader, storeMatch } from '../../scripts/parse-local-dem.mjs';

/** Real game: the parser's output for its replay, and its scoreboard (see odotaParser.test.ts). */
const fx = JSON.parse(readFileSync(new URL('../fixtures/selfParse/match9100809044.json', import.meta.url), 'utf8'));
const ID = 9100809044;
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const board = () => mapGcMatch(clone(fx.gc), '2026-11-22T00:00:00.000Z') as any;
const createOdotaParserClient = (o: any): any => createClient(o);
const dir = mkdtempSync(join(tmpdir(), 'local-replay-'));
const DEM = Buffer.concat([Buffer.from('PBDEMS2\0', 'latin1'), Buffer.from('the rest of a replay '.repeat(500))]);
const file = (name: string, bytes: Buffer | string) => { const p = join(dir, name); writeFileSync(p, bytes); return p; };
const drain = async (stream: any) => { const parts: Buffer[] = []; for await (const c of stream) parts.push(c); return Buffer.concat(parts); };

describe('replayMatchesScoreboard', () => {
  it('the right replay: length, kills and last hits agree (numbers from the real game)', () => {
    expect(replayMatchesScoreboard(board(), fx.blob)).toEqual({
      ok: true, minutes: { parsed: 30, scoreboard: 30, ok: true }, kills: { matching: 9, ok: true }, lastHits: { matching: 10, ok: true },
    });
  });

  it('a replay of another game is refused on every count', () => {
    // The same parse against a scoreboard whose numbers are another game's.
    const other = board();
    other.duration = 903;
    other.players.forEach((p: any, i: number) => { p.kills = (p.kills + 3 + i) % 17; p.last_hits = (p.last_hits * 2 + 40 + i * 13) % 400; });
    const v = replayMatchesScoreboard(other, fx.blob);
    expect(v.ok).toBe(false);
    expect(v.minutes).toEqual({ parsed: 30, scoreboard: 15, ok: false });
    expect(v.kills.matching).toBeLessThan(3);
    expect(v.lastHits.matching).toBeLessThan(5);
  });

  it('needs all three: any one failing refuses', () => {
    const longer = board(); longer.duration += 5 * 60;
    expect(replayMatchesScoreboard(longer, fx.blob)).toMatchObject({ ok: false, minutes: { ok: false }, kills: { ok: true }, lastHits: { ok: true } });
    const kills = board(); kills.players.slice(0, 4).forEach((p: any) => { p.kills += 1; });
    expect(replayMatchesScoreboard(kills, fx.blob)).toMatchObject({ ok: false, minutes: { ok: true }, kills: { matching: 5, ok: false } });
    const lh = board(); lh.players.slice(0, 3).forEach((p: any) => { p.last_hits += 60; });
    expect(replayMatchesScoreboard(lh, fx.blob)).toMatchObject({ ok: false, lastHits: { matching: 7, ok: false } });
    // One minute and two players of slack, no more.
    const near = board(); near.duration += 60; near.players[0].last_hits += 60; near.players[1].last_hits += 60;
    expect(replayMatchesScoreboard(near, fx.blob).ok).toBe(true);
  });

  it('seats are matched by slot, and missing data never passes', () => {
    const shuffled = clone(fx.blob); shuffled.players.reverse();
    expect(replayMatchesScoreboard(board(), shuffled).ok).toBe(true);
    const swapped = clone(fx.blob);
    swapped.players.forEach((p: any, i: number) => { p.player_slot = fx.blob.players[(i + 5) % 10].player_slot; });
    expect(replayMatchesScoreboard(board(), swapped).ok).toBe(false); // right game, wrong seats
    for (const bad of [null, {}, { players: [] }, { ...fx.blob, radiant_gold_adv: [] }, { ...fx.blob, players: fx.blob.players.slice(0, 9) }]) {
      expect(replayMatchesScoreboard(board(), bad as any).ok).toBe(false);
    }
    expect(replayMatchesScoreboard({ ...board(), players: board().players.slice(0, 9) }, fx.blob).ok).toBe(false);
    expect(replayMatchesScoreboard(null as any, fx.blob).ok).toBe(false);
  });
});

describe('openReplayFile', () => {
  it('tells the format from the first bytes, not the name', () => {
    expect(replayFormat(DEM)).toBe('dem');
    expect(replayFormat(Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0, 0]))).toBe('zstd');
    expect(replayFormat(Buffer.from('BZh91AY&SY'))).toBe('bz2');
    for (const b of [Buffer.from('PBDEMS1\0'), Buffer.from('BZh0'), Buffer.from('BZ'), Buffer.from('{"a":1}'), Buffer.alloc(0)]) expect(replayFormat(b)).toBeNull();
    expect(replayFormat('PBDEMS2\0' as any)).toBeNull();
  });

  it('a raw .dem passes through unchanged, with its size and hash', async () => {
    const f = await openReplayFile(file('wrong-name.dem.bz2', DEM));
    expect(f).toMatchObject({ format: 'dem', fileBytes: DEM.length });
    expect((await drain(f.stream)).equals(DEM)).toBe(true);
    expect(await f.done).toEqual({ demBytes: DEM.length, demSha256: createHash('sha256').update(DEM).digest('hex') });
  });

  it('a compressed replay comes out as the raw .dem (decompressor injected)', async () => {
    const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
    // Stand-in for zstd: the "compressed" file is the magic plus the dem.
    let seen = 0;
    const unwrap = () => new Transform({ transform(chunk, _e, cb) { const from = Math.max(0, 4 - seen); seen += chunk.length; cb(null, chunk.subarray(from)); } });
    const f = await openReplayFile(file('9100809044_1.dem.bz2', Buffer.concat([magic, DEM])), { zstdStream: unwrap });
    expect(f.format).toBe('zstd');
    expect((await drain(f.stream)).equals(DEM)).toBe(true);
    expect((await f.done).demSha256).toBe(createHash('sha256').update(DEM).digest('hex'));
  });

  // The bzip2 path runs a program. Stand-ins written in Node, so the test does not depend on what is installed.
  const BZ = Buffer.concat([Buffer.from('BZh9'), Buffer.from('compressed bytes')]);
  const program = (script: string) => ({ bz2: { command: process.execPath, args: ['-e', script] } });

  it('a replay decompressed by a program comes out whole when the program exits cleanly', async () => {
    const f = await openReplayFile(file('ok.dem.bz2', BZ), { programs: program(`process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(${JSON.stringify(DEM.toString('latin1'))}, 'latin1'))`) });
    expect(f.format).toBe('bz2');
    expect((await drain(f.stream)).equals(DEM)).toBe(true);
    expect(await f.done).toEqual({ demBytes: DEM.length, demSha256: createHash('sha256').update(DEM).digest('hex') });
  });

  it('output from a program that then fails is not a replay: `done` rejects even though bytes were written and stdout closed first', async () => {
    // What a decompressor does on a truncated file: writes what it has, closes stdout, exits non-zero a moment later.
    const script = `process.stdin.resume(); process.stdin.on('end', () => { process.stdout.write('PBDEMS2\\0 half a replay', () => { process.stdout.end(); setTimeout(() => process.exit(2), 150); }); })`;
    const f = await openReplayFile(file('truncated.dem.bz2', BZ), { programs: program(script) });
    const read = drain(f.stream).then((b) => ({ bytes: b.length }), (e) => ({ error: e }));
    const err: any = await f.done.then(() => null, (e) => e);
    expect(err).toMatchObject({ code: 'replay_unreadable' });
    expect(await read).toHaveProperty('error'); // the reader of the stream sees the failure too, not a clean end
  });

  it('a program killed by a signal, and a program that is not installed, are errors too', async () => {
    const killed = await openReplayFile(file('k.dem.bz2', BZ), { programs: program(`process.stdout.write('x'); process.kill(process.pid, 'SIGKILL')`) });
    drain(killed.stream).catch(() => {});
    await expect(killed.done).rejects.toMatchObject({ code: 'replay_unreadable' });
    const missing = await openReplayFile(file('m.dem.bz2', BZ), { programs: { bz2: { command: 'no-such-decompressor-anywhere', args: [] } } });
    drain(missing.stream).catch(() => {});
    await expect(missing.done).rejects.toMatchObject({ code: 'decompressor_missing', message: expect.stringMatching(/install bzip2/) });
  });

  it('Node\'s own decompressor failing is reported the same way', async () => {
    const zerr = () => new Transform({ transform(_c, _e, cb) { cb(Object.assign(new Error('unexpected end of file'), { code: 'Z_BUF_ERROR' })); } });
    const f = await openReplayFile(file('cut.dem.zst', Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), Buffer.from('cut short')])), { zstdStream: zerr });
    drain(f.stream).catch(() => {});
    await expect(f.done).rejects.toMatchObject({ code: 'replay_unreadable', message: expect.stringMatching(/corrupt or truncated/) });
  });

  it('with the real decompressor: data that is not bzip2 is refused (or bunzip2 is reported missing)', async () => {
    const f = await openReplayFile(file('bad.dem.bz2', BZ));
    drain(f.stream).catch(() => {});
    const err: any = await f.done.then(() => null, (e) => e);
    expect(['replay_unreadable', 'decompressor_missing']).toContain(err?.code);
  });

  it('refuses what is not a replay, a directory, and a missing file', async () => {
    await expect(openReplayFile(file('match.json', '{"match_id":1}'))).rejects.toMatchObject({ code: 'replay_unreadable' });
    await expect(openReplayFile(file('empty.dem', ''))).rejects.toMatchObject({ code: 'replay_unreadable' });
    await expect(openReplayFile(dir)).rejects.toMatchObject({ code: 'file_not_found' });
    await expect(openReplayFile(join(dir, 'nope.dem'))).rejects.toMatchObject({ code: 'file_not_found' });
  });
});

describe('parser client: parseDem', () => {
  const res = (status: number, body = '') => ({ status, ok: status >= 200 && status < 300, headers: new Headers(), text: async () => body });

  it('POSTs the raw replay to /?blob and returns the blob', async () => {
    const seen: any[] = [];
    const c = createOdotaParserClient({ baseUrl: 'http://127.0.0.1:5600', fetchImpl: async (url: string, init: any) => { seen.push([url, init.method, init.duplex, init.headers['content-type'], init.body]); return res(200, JSON.stringify(fx.blob)); } });
    const blob = await c.parseDem(DEM);
    expect(blob.players).toHaveLength(10);
    expect(seen[0].slice(0, 4)).toEqual(['http://127.0.0.1:5600/?blob', 'POST', 'half', 'application/octet-stream']);
    expect(seen[0][4]).toBe(DEM);
    expect(c.snapshot()).toMatchObject({ parses: 1, ok: 1, running: 0 });
  });

  it('an empty answer is an unreadable replay (the parser says 200 either way); other failures are the parser\'s', async () => {
    const run = async (fetchImpl: any) => createOdotaParserClient({ baseUrl: 'http://p', fetchImpl }).parseDem(DEM).catch((e: any) => e);
    expect(await run(async () => res(200, ''))).toMatchObject({ code: 'replay_unreadable', status: 422, retryable: false });
    expect(await run(async () => res(500))).toMatchObject({ code: 'parser_failed', retryable: true });
    expect(await run(async () => res(200, '<html>'))).toMatchObject({ code: 'parser_failed' });
    expect(await run(async () => { throw new Error('ECONNREFUSED'); })).toMatchObject({ code: 'parser_failed', message: 'replay parser unreachable' });
    expect(await run(async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); })).toMatchObject({ message: 'replay parser timeout' });
  });

  it('shares the concurrency limit with URL parses', async () => {
    const releases: any[] = [];
    const c = createOdotaParserClient({ baseUrl: 'http://p', maxConcurrent: 1, maxQueued: 0, fetchImpl: async () => { await new Promise((r) => releases.push(r)); return res(200, JSON.stringify(fx.blob)); } });
    const first = c.parseDem(DEM);
    await new Promise((r) => setTimeout(r, 5));
    await expect(c.parseDem(DEM)).rejects.toMatchObject({ code: 'busy' });
    await expect(c.parse('http://replay181.valve.net/570/9100809044_366089646.dem.bz2')).rejects.toMatchObject({ code: 'busy' });
    releases[0]();
    await first;
    expect(c.snapshot().running).toBe(0);
  });
});

describe('parseLocalReplay', () => {
  const path = file('9100809044.dem', DEM);
  const deps = (over: any = {}) => ({
    matchId: ID, path,
    loadScoreboard: async () => board(),
    parser: { parseDem: async (stream: any) => { await drain(stream); return clone(fx.blob); } },
    merge: mergeGcAndParsed, check: replayMatchesScoreboard, isParsed: isMatchParsed,
    now: () => Date.parse('2026-11-22T01:00:00Z'),
    ...over,
  });

  it('gives a parsed match that says where its timelines came from', async () => {
    const out: any = await parseLocalReplay(deps() as any);
    expect(isMatchParsed(out.match)).toBe(true);
    expect(out.match).toMatchObject({
      match_id: ID, data_source: 'steam_gc+odota_parser', parsed_at: '2026-11-22T01:00:00.000Z',
      replay_origin: { kind: 'local_file', dem_bytes: DEM.length, dem_sha256: createHash('sha256').update(DEM).digest('hex') },
    });
    expect(out.check).toMatchObject({ ok: true, kills: { matching: 9 } });
    expect(out.file).toMatchObject({ format: 'dem', demBytes: DEM.length });
    const report = buildCoachReport(out.match) as any;
    expect(report.match).toMatchObject({ parsed: true, source: 'steam_gc' });
    expect(report.reviews).toHaveLength(10);
  });

  it('a scoreboard from OpenDota keeps what OpenDota gave (percentiles), and is labelled so', async () => {
    const od = board();
    delete od.data_source;
    od.players.forEach((p: any) => { p.benchmarks = { gold_per_min: { raw: p.gold_per_min, pct: 0.5 } }; });
    const out: any = await parseLocalReplay(deps({ loadScoreboard: async () => od }) as any);
    expect(out.match.data_source).toBe('opendota+odota_parser');
    expect(out.match.players[0].benchmarks).toEqual(od.players[0].benchmarks);
    expect((buildCoachReport(out.match) as any).match.source).toBe('opendota');
    expect((buildCoachReport(out.match) as any).data_gaps).toEqual([]);
  });

  it('refuses a replay of another game, and gives the numbers', async () => {
    const other = board(); other.duration = 903; other.players.forEach((p: any, i: number) => { p.kills = (p.kills + 3 + i) % 17; });
    const err: any = await parseLocalReplay(deps({ loadScoreboard: async () => other }) as any).catch((e) => e);
    expect(err).toMatchObject({ code: 'wrong_replay', message: `this replay is not match ${ID}` });
    expect(err.check).toMatchObject({ ok: false, minutes: { parsed: 30, scoreboard: 15 } });
  });

  it.each([
    ['the scoreboard cannot be had', { loadScoreboard: async () => { throw Object.assign(new Error('OpenDota HTTP 404'), { status: 404 }); } }, 'no_scoreboard'],
    ['the scoreboard is another match', { loadScoreboard: async () => ({ ...board(), match_id: 5 }) }, 'no_scoreboard'],
    ['the scoreboard has nine players', { loadScoreboard: async () => ({ ...board(), players: board().players.slice(1) }) }, 'no_scoreboard'],
    ['the source already has it parsed', { loadScoreboard: async () => mergeGcAndParsed(board(), fx.blob) }, 'already_parsed'],
    ['the file is not a replay', { path: file('notes.txt', 'hello') }, 'replay_unreadable'],
    ['the file is missing', { path: join(dir, 'gone.dem') }, 'file_not_found'],
    ['the parser cannot read it', { parser: { parseDem: async (s: any) => { await drain(s); throw Object.assign(new Error('not a readable replay'), { code: 'replay_unreadable' }); } } }, 'replay_unreadable'],
    ['the parser is down', { parser: { parseDem: async () => { throw Object.assign(new Error('replay parser unreachable'), { code: 'parser_failed' }); } } }, 'parser_failed'],
    ['the parse has no timelines', { parser: { parseDem: async (s: any) => { await drain(s); return { ...clone(fx.blob), radiant_gold_adv: [] }; } } }, 'wrong_replay'],
  ])('%s: refused with a reason, no match returned', async (_n, over, code) => {
    let parsed = 0;
    const d: any = deps(over);
    if (!(over as any).parser) { const inner = d.parser.parseDem; d.parser = { parseDem: async (s: any) => { parsed += 1; return inner(s); } }; }
    const err: any = await parseLocalReplay(d).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe(code);
    if (['no_scoreboard', 'already_parsed', 'file_not_found'].includes(code) || _n === 'the file is not a replay') expect(parsed).toBe(0);
  });
});

describe('scripts/parse-local-dem.mjs', () => {
  it('reads its arguments, and rejects anything else', () => {
    expect(parseArgs(['9100809044', 'a.dem'])).toEqual({ matchId: ID, path: 'a.dem', source: 'auto', out: null, store: false, parser: null });
    expect(parseArgs(['--store', '9100809044', '--source', 'gc', 'a.dem', '--out', 'x.json', '--parser', 'http://p:5600'])).toEqual({ matchId: ID, path: 'a.dem', source: 'gc', out: 'x.json', store: true, parser: 'http://p:5600' });
    for (const bad of [[], ['9100809044'], ['abc', 'a.dem'], ['0', 'a.dem'], ['1', 'a', 'b'], ['1', 'a.dem', '--nope'], ['1', 'a.dem', '--out'], ['1', 'a.dem', '--source', '--store']]) expect(parseArgs(bad)).toBeNull();
  });

  it('picks the scoreboard source: the retriever when configured, else OpenDota; a path reads a file', async () => {
    const gcEnv = { STEAM_RETRIEVER_URL: 'http://127.0.0.1:5700', STEAM_RETRIEVER_SECRET: `s-${'x'.repeat(30)}` };
    expect(scoreboardLoader('auto', gcEnv).name).toBe('Steam GC');
    expect(scoreboardLoader('auto', {}).name).toBe('OpenDota');
    expect(scoreboardLoader('opendota', gcEnv).name).toBe('OpenDota');
    expect(() => scoreboardLoader('gc', {})).toThrow(/STEAM_RETRIEVER_URL/);
    const seen: string[] = [];
    const od = scoreboardLoader('opendota', { OPENDOTA_API_KEY: 'k k' }, (async (url: string) => { seen.push(url); return { ok: true, json: async () => ({ match_id: 7 }) }; }) as any);
    expect(await od.load(7)).toEqual({ match_id: 7 });
    expect(seen).toEqual(['https://api.opendota.com/api/matches/7?api_key=k%20k']);
    await expect(scoreboardLoader('opendota', {}, (async () => ({ ok: false, status: 503 })) as any).load(7)).rejects.toMatchObject({ status: 503 });
    // A saved retriever answer, or a saved match in OpenDota's shape.
    const fromGc = await scoreboardLoader(file('gc.json', JSON.stringify({ match: fx.gc })), {}).load(ID);
    expect(fromGc).toMatchObject({ match_id: ID, data_source: 'steam_gc' });
    const asIs = await scoreboardLoader(file('od.json', JSON.stringify({ match_id: ID, players: [] })), {}).load(ID);
    expect(asIs).toEqual({ match_id: ID, players: [] });
  });

  it('--store: writes the parsed match once; a copy already there is left alone; an unparsed match is never written', async () => {
    const objects = new Map<string, string>();
    const bucket = { file: (key: string) => ({
      async download() { if (!objects.has(key)) throw Object.assign(new Error('x'), { code: 404 }); return [Buffer.from(objects.get(key)!)]; },
      async save(body: string, o: any = {}) { if (o.preconditionOpts?.ifGenerationMatch === 0 && objects.has(key)) throw Object.assign(new Error('x'), { code: 412 }); objects.set(key, body); },
    }) };
    const parsed = mergeGcAndParsed(board(), fx.blob) as any;
    expect(await storeMatch(ID, parsed, bucket)).toBe('written');
    expect(JSON.parse(objects.get(`matches/${ID}.json`)!).data_source).toBe('steam_gc+odota_parser');
    const before = objects.get(`matches/${ID}.json`);
    expect(await storeMatch(ID, { ...parsed, parsed_at: 'later' }, bucket)).toBe('exists');
    expect(objects.get(`matches/${ID}.json`)).toBe(before);
    expect(await storeMatch(5, board(), bucket)).toBe('exists'); // skipped: not parsed
    expect(objects.has('matches/5.json')).toBe(false);
    const broken = { file: () => ({ async save() { throw Object.assign(new Error('denied'), { code: 403 }); } }) };
    await expect(storeMatch(6, { ...parsed, match_id: 6 }, broken, { log: () => {} })).rejects.toThrow(/refused the write/);
    const silent = { file: () => ({ save: () => new Promise(() => {}) }) };
    await expect(storeMatch(7, { ...parsed, match_id: 7 }, silent, { waitMs: 100 })).rejects.toThrow(/did not answer/);
  });

  it('exits 2 on bad usage without touching anything', async () => {
    expect(await main(['abc'], {}, () => {})).toBe(2);
    expect(await main(['1', 'a.dem', '--source', 'gc'], {}, () => {})).toBe(2);
    expect(await main(['1', 'a.dem', '--source', 'opendota', '--store'], {}, () => {})).toBe(2); // no MATCH_CACHE_BUCKET: said before parsing
  });

  it('exits 3 and writes nothing when the file is not a replay', async () => {
    const out = join(dir, 'never.json');
    const lines: string[] = [];
    const code = await main([String(ID), file('x.txt', 'hello'), '--source', file('gc2.json', JSON.stringify({ match: fx.gc })), '--out', out], {}, (l: string) => lines.push(l));
    expect(code).toBe(3);
    expect(() => readFileSync(out)).toThrow();
    expect(lines.join('\n')).not.toMatch(/\b\d{8,10}\b(?<!9100809044)/); // no account ids
  });
});
