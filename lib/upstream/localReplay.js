/**
 * A replay file on disk, as a stream of the raw .dem the parser takes.
 *
 * The format is read from the file's first bytes, never from its name: Valve
 * serves zstd under names ending in `.dem.bz2`. Raw files (what the Dota 2
 * client saves) pass through; zstd is decompressed by Node when it can, else
 * by the `zstd` program; bzip2 by the `bunzip2` program.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { PassThrough, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';

/** Compressed or not, a replay is far below this; anything larger is not one. */
export const MAX_REPLAY_FILE_BYTES = 600 * 1024 * 1024;
export const MAX_DEM_BYTES = 1024 * 1024 * 1024;

const DEM_MAGIC = Buffer.from('PBDEMS2\0', 'latin1');
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 'dem' | 'zstd' | 'bz2' | null, from the first bytes. */
export function replayFormat(head) {
  if (!Buffer.isBuffer(head)) return null;
  if (head.length >= 8 && head.subarray(0, 8).equals(DEM_MAGIC)) return 'dem';
  if (head.length >= 4 && head.subarray(0, 4).equals(ZSTD_MAGIC)) return 'zstd';
  if (head.length >= 4 && head[0] === 0x42 && head[1] === 0x5a && head[2] === 0x68 && head[3] >= 0x31 && head[3] <= 0x39) return 'bz2';
  return null;
}

/** Reasons that are about the file itself. */
const FILE_CODES = new Set(['file_not_found', 'file_too_large', 'replay_unreadable', 'decompressor_missing']);

function fileError(message, code) {
  return Object.assign(new Error(message), { code });
}

/** A decompressor run as a program: stdin → stdout. */
function viaProgram(program, args, missing) {
  const out = new PassThrough();
  const child = spawn(program, args, { stdio: ['pipe', 'pipe', 'ignore'] });
  child.on('error', (err) => out.destroy(err?.code === 'ENOENT' ? fileError(missing, 'decompressor_missing') : err));
  child.on('close', (code) => { if (code) out.destroy(fileError(`${program} could not decompress the file`, 'replay_unreadable')); });
  child.stdin.on('error', () => {}); // closed early when the program fails: reported above
  child.stdout.pipe(out);
  return { input: child.stdin, output: out };
}

/**
 * @param {string} path
 * @param {{ zstdStream?: (() => import('node:stream').Transform) | null }} [o]  for tests
 * @returns {Promise<{ format: 'dem'|'zstd'|'bz2', fileBytes: number, stream: import('node:stream').Readable,
 *                     done: Promise<{ demBytes: number, demSha256: string }> }>}
 *   `stream` is the raw .dem. `done` settles when it has been read to the
 *   end: its size and SHA-256, or the reason it could not be read.
 */
export async function openReplayFile(path, { zstdStream = typeof zlib.createZstdDecompress === 'function' ? () => zlib.createZstdDecompress() : null } = {}) {
  let info;
  try { info = await stat(path); } catch { throw fileError('replay file not found', 'file_not_found'); }
  if (!info.isFile()) throw fileError('not a file', 'file_not_found');
  if (info.size > MAX_REPLAY_FILE_BYTES) throw fileError('file too large to be a replay', 'file_too_large');
  const fh = await open(path, 'r');
  const head = Buffer.alloc(8);
  let read;
  try { ({ bytesRead: read } = await fh.read(head, 0, 8, 0)); } finally { await fh.close(); }
  const format = replayFormat(head.subarray(0, read));
  if (!format) throw fileError('not a Dota 2 replay (.dem, or a zstd/bzip2-compressed one)', 'replay_unreadable');

  const hash = createHash('sha256');
  let demBytes = 0;
  const meter = new Transform({
    transform(chunk, _enc, cb) {
      demBytes += chunk.length;
      if (demBytes > MAX_DEM_BYTES) return cb(fileError('decompressed replay too large', 'file_too_large'));
      hash.update(chunk);
      return cb(null, chunk);
    },
  });
  const source = createReadStream(path);
  let chain;
  if (format === 'dem') chain = [source, meter];
  else if (format === 'zstd' && zstdStream) chain = [source, zstdStream(), meter];
  else {
    const prog = format === 'zstd'
      ? viaProgram('zstd', ['-dc'], 'this replay is zstd-compressed: install zstd, or use Node 22.15+')
      : viaProgram('bunzip2', ['-c'], 'this replay is bzip2-compressed: install bzip2 (bunzip2), or decompress it first');
    source.on('error', (err) => prog.output.destroy(err));
    source.pipe(prog.input);
    chain = [prog.output, meter];
  }
  const done = pipeline(chain).then(() => ({ demBytes, demSha256: hash.digest('hex') }));
  done.catch(() => {}); // the caller awaits it; never an unhandled rejection
  return { format, fileBytes: info.size, stream: meter, done };
}

/**
 * A local replay file → a parsed match, or a refusal. Pure orchestration:
 * the scoreboard loader, the parser client and the file reader are passed in.
 *
 * Refuses (error `code`) rather than produce a match it cannot stand behind:
 *   no_scoreboard   the match's scoreboard could not be had, or is not this match
 *   already_parsed  the scoreboard source already has a parsed copy: nothing to do
 *   wrong_replay    the file is a replay of another game (see replayMatchesScoreboard)
 *   parse_unusable  the parse has no timelines / not the same ten seats
 * plus the file reader's and parser's own codes.
 *
 * @param {{
 *   matchId: number, path: string,
 *   loadScoreboard: (matchId: number) => Promise<object>,
 *   parser: { parseDem: (body: any) => Promise<object> },
 *   merge: (base: object, blob: object, o: object) => object,
 *   check: (base: object, blob: object) => { ok: boolean },
 *   isParsed: (match: object) => boolean,
 *   heroNpcName?: (heroId: number) => string | null,
 *   openFile?: typeof openReplayFile, now?: () => number,
 * }} o
 */
export async function parseLocalReplay({ matchId, path, loadScoreboard, parser, merge, check, isParsed, heroNpcName, openFile = openReplayFile, now = () => Date.now() }) {
  const refuse = (message, code, extra) => Object.assign(new Error(message), { code, ...extra });
  let base;
  try { base = await loadScoreboard(matchId); } catch (err) {
    throw refuse(`could not get the scoreboard of match ${matchId}: ${err?.message || 'failed'}`, 'no_scoreboard', { status: err?.status });
  }
  if (!base || typeof base !== 'object' || Number(base.match_id) !== matchId || !Array.isArray(base.players) || base.players.length !== 10) {
    throw refuse(`the scoreboard is not match ${matchId} with ten players`, 'no_scoreboard');
  }
  if (isParsed(base)) throw refuse(`match ${matchId} is already parsed at the source: nothing to do`, 'already_parsed');

  const file = await openFile(path);
  let blob;
  try {
    blob = await parser.parseDem(file.stream);
  } catch (err) {
    file.stream.destroy();
    // A file that could not be decompressed is the real reason, not the parser's empty answer.
    const reason = await file.done.then(() => null, (e) => e);
    throw FILE_CODES.has(reason?.code) ? reason : err;
  }
  const { demBytes, demSha256 } = await file.done;

  const verdict = check(base, blob);
  if (!verdict.ok) throw refuse(`this replay is not match ${matchId}`, 'wrong_replay', { check: verdict });

  const match = merge(base, blob, {
    parsedAt: new Date(now()).toISOString(), heroNpcName,
    dataSource: `${typeof base.data_source === 'string' && base.data_source ? base.data_source : 'opendota'}+odota_parser`,
  });
  // Where the timelines came from, so the copy can be traced to a file.
  match.replay_origin = { kind: 'local_file', dem_sha256: demSha256, dem_bytes: demBytes };
  if (!isParsed(match)) throw refuse('the merged match does not read as parsed', 'parse_unusable');
  return { match, check: verdict, file: { format: file.format, fileBytes: file.fileBytes, demBytes, demSha256 } };
}
