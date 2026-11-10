import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
export async function hashFile(path, signal) {
  const hash = createHash('sha256'); let bytes = 0;
  for await (const chunk of createReadStream(path, {signal})) { hash.update(chunk); bytes += chunk.length; }
  return { bytes, sha256:hash.digest('hex') };
}
export function runExtractor(bin, args, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio:['ignore','pipe','pipe'] });
    let output = '', failure;
    const abort = () => child.kill('SIGKILL');
    signal.addEventListener('abort', abort, { once:true });
    if (signal.aborted) abort();
    child.stdout.on('data', b => { output += b; if (output.length > 65536) { failure = new Error('extractor_output_limit'); abort(); } });
    child.stderr.on('data', () => {});
    child.on('error', e => { failure = e; });
    child.on('close', code => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) return reject(signal.reason);
      if (failure) return reject(failure);
      try { const r = JSON.parse(output.trim().split('\n').at(-1)); if (code !== 0 || r.ok !== true) throw new Error('extractor_failed'); resolve(r); } catch (e) { reject(e); }
    });
  });
}
export async function readReviewEvents(path, signal) {
  const input = createReadStream(path, { signal });
  const lines = createInterface({ input, crlfDelay:Infinity });
  const events = []; let index = 0;
  try {
    for await (const line of lines) {
      signal?.throwIfAborted(); const e = JSON.parse(line);
      if (e.type === 'DOTA_COMBATLOG_DEATH' || e.type === 'DOTA_COMBATLOG_PURCHASE') { events.push({ ...e, trace_index:index }); if (events.length > 30000) throw new Error('event_limit'); }
      index++;
    }
  } finally { lines.close(); input.destroy(); }
  return { events, rows:index };
}
