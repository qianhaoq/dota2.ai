import { describe, expect, it, beforeEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { vi } from 'vitest';
import { badEdges, candidateEdges, downloadReplay, requestEdge } from '../../lib/matchReview/replayIngest/edgeDownload.js';

const URL = 'http://replay413.dota2.com.cn/570/9099560329_1201058764.dem.bz2';
const FILE = Buffer.from('x'.repeat(5000));
const dest = () => join(mkdtempSync(join(tmpdir(), 'edge-')), 'r.dem');

/** A fake edge: how it answers. */
type Mode = { kind: 'ok'; delay?: number } | { kind: 'hang' } | { kind: 'refuse' } | { kind: 'status'; code: number } | { kind: 'stall'; after: number } | { kind: 'ignore_range' } | { kind: 'empty' } | { kind: 'one_chunk' };
const fakeRequest = (modes: Record<string, Mode>, seen: any[]) => (url: string, ip: string, { signal, from = 0 }: { signal: AbortSignal; from?: number }) => {
  seen.push({ ip, from });
  const m = modes[ip];
  return new Promise<any>((resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    if (m.kind === 'hang') return;
    if (m.kind === 'refuse') { reject(Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' })); return; }
    const res: any = new PassThrough();
    signal.addEventListener('abort', () => res.destroy());
    if (m.kind === 'status') { res.statusCode = m.code; resolve(res); res.end(); return; }
    if (m.kind === 'empty') { res.statusCode = 200; resolve(res); res.end(); return; }
    const start = m.kind === 'ignore_range' ? 0 : from;
    res.statusCode = from > 0 && m.kind !== 'ignore_range' ? 206 : 200;
    resolve(res);
    const body = FILE.subarray(start);
    if (m.kind === 'stall') { setTimeout(() => res.write(body.subarray(0, m.after)), 1); return; }
    if (m.kind === 'one_chunk') { res.end(body); return; }
    setTimeout(() => { res.write(body.subarray(0, 1000)); res.end(body.subarray(1000)); }, m.kind === 'ok' && m.delay ? m.delay : 1);
  });
};
const edges = (ips: string[]) => async () => ips.map((ip) => ({ ip, from: 'system' }));
const fast = { firstByteMs: 60, stallMs: 60, log: () => {} };

beforeEach(() => badEdges.clear());

describe('downloading a replay edge by edge (2026-11-27: some Perfect World edges hang from Cloud Run)', () => {
  it('edges that hang or refuse lose the race to one that answers; the file is whole', async () => {
    const seen: any[] = []; const d = dest();
    const r = await downloadReplay(URL, d, { ...fast, edges: edges(['1.1.1.1', '2.2.2.2', '3.3.3.3']), request: fakeRequest({ '1.1.1.1': { kind: 'hang' }, '2.2.2.2': { kind: 'refuse' }, '3.3.3.3': { kind: 'ok' } }, seen) });
    expect(r.bytes).toBe(5000);
    expect(readFileSync(d).equals(FILE)).toBe(true);
    // The one that refused is remembered as bad; the one still waiting when another answered was only slower, and is not.
    expect([...badEdges.keys()]).toEqual(['2.2.2.2']);
  });

  it('an edge that times out on its own turn is remembered as bad, and tried last next time', async () => {
    await downloadReplay(URL, dest(), { ...fast, race: 1, edges: edges(['1.1.1.1', '3.3.3.3']), request: fakeRequest({ '1.1.1.1': { kind: 'hang' }, '3.3.3.3': { kind: 'ok' } }, []) });
    expect(badEdges.has('1.1.1.1')).toBe(true);
    const next = await candidateEdges('replay413.dota2.com.cn', { resolveSystem: async () => ['1.1.1.1', '3.3.3.3'], resolveWith: async () => [] });
    expect(next.map((e) => e.ip)).toEqual(['3.3.3.3', '1.1.1.1']);
  });

  it('when the first batch all hang, the next edges are asked', async () => {
    const seen: any[] = [];
    const r = await downloadReplay(URL, dest(), { ...fast, race: 2, edges: edges(['1.1.1.1', '2.2.2.2', '3.3.3.3']), request: fakeRequest({ '1.1.1.1': { kind: 'hang' }, '2.2.2.2': { kind: 'hang' }, '3.3.3.3': { kind: 'ok' } }, seen) });
    expect(r.bytes).toBe(5000);
    expect(seen.map((x) => x.ip)).toEqual(['1.1.1.1', '2.2.2.2', '3.3.3.3']);
  });

  it('a stall mid-stream resumes with a Range request from the bytes written, on another edge', async () => {
    const seen: any[] = []; const d = dest();
    const r = await downloadReplay(URL, d, { ...fast, race: 1, edges: edges(['1.1.1.1', '2.2.2.2']), request: fakeRequest({ '1.1.1.1': { kind: 'stall', after: 1200 }, '2.2.2.2': { kind: 'ok' } }, seen) });
    expect(seen).toEqual([{ ip: '1.1.1.1', from: 0 }, { ip: '2.2.2.2', from: 1200 }]);
    expect(r.bytes).toBe(5000);
    expect(readFileSync(d).equals(FILE)).toBe(true);
  });

  it('an edge that answers a resume with the whole file starts the file over', async () => {
    const d = dest();
    const r = await downloadReplay(URL, d, { ...fast, race: 1, edges: edges(['1.1.1.1', '2.2.2.2']), request: fakeRequest({ '1.1.1.1': { kind: 'stall', after: 1200 }, '2.2.2.2': { kind: 'ignore_range' } }, []) });
    expect(r.bytes).toBe(5000);
    expect(readFileSync(d).equals(FILE)).toBe(true);
  });

  it('404 from two edges is a replay that is gone; from one, another edge is asked', async () => {
    await expect(downloadReplay(URL, dest(), { ...fast, race: 1, edges: edges(['1.1.1.1', '2.2.2.2']), request: fakeRequest({ '1.1.1.1': { kind: 'status', code: 404 }, '2.2.2.2': { kind: 'status', code: 404 } }, []) })).rejects.toMatchObject({ code: 'replay_gone' });
    const r = await downloadReplay(URL, dest(), { ...fast, race: 1, edges: edges(['1.1.1.1', '2.2.2.2']), request: fakeRequest({ '1.1.1.1': { kind: 'status', code: 404 }, '2.2.2.2': { kind: 'ok' } }, []) });
    expect(r.bytes).toBe(5000);
    // A 404 is not a bad edge.
    expect(badEdges.has('1.1.1.1')).toBe(false);
  });

  it('every edge failing is download_failed; a file over the cap is too_large; a non-replay URL is refused', async () => {
    await expect(downloadReplay(URL, dest(), { ...fast, edges: edges(['1.1.1.1', '2.2.2.2']), request: fakeRequest({ '1.1.1.1': { kind: 'hang' }, '2.2.2.2': { kind: 'status', code: 503 } }, []) })).rejects.toMatchObject({ code: 'download_failed' });
    await expect(downloadReplay(URL, dest(), { ...fast, maxBytes: 3000, edges: edges(['1.1.1.1']), request: fakeRequest({ '1.1.1.1': { kind: 'ok' } }, []) })).rejects.toMatchObject({ code: 'too_large' });
    await expect(downloadReplay('http://example.com/x.dem.bz2', dest(), { ...fast })).rejects.toMatchObject({ code: 'invalid_replay_url' });
  });

  it('logs one JSON line per attempt with host, ip, where the address came from, outcome, seconds and bytes', async () => {
    const lines: string[] = [];
    await downloadReplay(URL, dest(), { ...fast, race: 1, log: (l: string) => lines.push(l), edges: edges(['1.1.1.1', '3.3.3.3']), request: fakeRequest({ '1.1.1.1': { kind: 'hang' }, '3.3.3.3': { kind: 'ok' } }, []) });
    const rows = lines.map((l) => JSON.parse(l));
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'replay_edge', host: 'replay413.dota2.com.cn', ip: '1.1.1.1', from: 'system', outcome: 'first_byte_timeout', bytes: 0 }),
      expect.objectContaining({ event: 'replay_edge', ip: '3.3.3.3', outcome: 'ok', bytes: 5000 }),
    ]));
  });
});

describe('what Codex found on #424', () => {
  it('an empty answer is a failed attempt: the race goes on to the next edge, never hangs', async () => {
    const r = await downloadReplay(URL, dest(), { ...fast, race: 1, edges: edges(['1.1.1.1', '2.2.2.2']), request: fakeRequest({ '1.1.1.1': { kind: 'empty' }, '2.2.2.2': { kind: 'ok' } }, []) });
    expect(r.edges.map((e: any) => [e.ip, e.outcome])).toEqual([['1.1.1.1', 'empty'], ['2.2.2.2', 'ok']]);
  });

  it('edges cancelled only because another won are kept for a resume when the winner stalls', async () => {
    const seen: any[] = []; const d = dest();
    const r = await downloadReplay(URL, d, { ...fast, race: 3, edges: edges(['1.1.1.1', '2.2.2.2', '3.3.3.3']), request: fakeRequest({ '1.1.1.1': { kind: 'stall', after: 1200 }, '2.2.2.2': { kind: 'ok', delay: 30 }, '3.3.3.3': { kind: 'ok', delay: 30 } }, seen) });
    expect(r.bytes).toBe(5000);
    expect(readFileSync(d).equals(FILE)).toBe(true);
    // The resume went to one of the two that were only cancelled, from the bytes written.
    expect(seen.slice(3)).toContainEqual({ ip: '2.2.2.2', from: 1200 });
    expect(badEdges.has('2.2.2.2')).toBe(false);
  });

  it('a response that ends in its first chunk is whole at once, not a stall', async () => {
    const t = Date.now();
    const r = await downloadReplay(URL, dest(), { ...fast, stallMs: 5000, edges: edges(['1.1.1.1']), request: fakeRequest({ '1.1.1.1': { kind: 'one_chunk' } }, []) });
    expect(r).toMatchObject({ bytes: 5000, edges: [{ ip: '1.1.1.1', outcome: 'ok' }] });
    expect(Date.now() - t).toBeLessThan(1000);
  });

  it('a file that cannot be written ends the download with download_failed, and nothing escapes', async () => {
    await expect(downloadReplay(URL, '/dev/full', { ...fast, edges: edges(['1.1.1.1']), request: fakeRequest({ '1.1.1.1': { kind: 'ok' } }, []) })).rejects.toMatchObject({ code: 'download_failed', why: 'write_error' });
  });

  it('no pooled socket: every request connects to its own chosen address', async () => {
    const get = vi.spyOn(http, 'get').mockImplementation(((url: any, opts: any, cb: any) => { const req: any = new (require('node:events').EventEmitter)(); setTimeout(() => { const res: any = new PassThrough(); res.statusCode = 200; cb(res); res.end('x'); }, 1); return req; }) as any);
    try {
      const res: any = await requestEdge(URL, '1.1.1.1', { signal: new AbortController().signal });
      expect(res.statusCode).toBe(200);
      const opts = get.mock.calls[0][1] as any;
      expect(opts.agent).toBe(false);
      await new Promise<void>((r) => opts.lookup('replay413.dota2.com.cn', { all: true }, (_e: any, a: any) => { expect(a).toEqual([{ address: '1.1.1.1', family: 4 }]); r(); }));
    } finally { get.mockRestore(); }
  });
});

describe('candidate edges', () => {
  it('system resolver first, then the alternates, public IPv4 only, once each, the recently bad last', async () => {
    badEdges.set('8.8.4.4', Date.now() + 60_000);
    const got = await candidateEdges('replay413.dota2.com.cn', {
      resolveSystem: async () => ['8.8.4.4', '10.0.0.1', '1.1.1.1'],
      resolveWith: async (server: string) => (server === '223.5.5.5' ? ['1.1.1.1', '9.9.9.9', '127.0.0.1'] : ['4.4.4.4']),
    });
    expect(got).toEqual([{ ip: '1.1.1.1', from: 'system' }, { ip: '9.9.9.9', from: '223.5.5.5' }, { ip: '4.4.4.4', from: '119.29.29.29' }, { ip: '8.8.4.4', from: 'system' }]);
  });
  it('a bad mark expires', async () => {
    badEdges.set('1.1.1.1', 1000);
    const got = await candidateEdges('h', { now: () => 2000, resolveSystem: async () => ['1.1.1.1'], resolveWith: async () => [] });
    expect(got).toEqual([{ ip: '1.1.1.1', from: 'system' }]);
    expect(badEdges.has('1.1.1.1')).toBe(false);
  });
});
