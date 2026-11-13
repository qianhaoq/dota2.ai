import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
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
  const events = []; let index = 0, bytes = 0;
  try {
    for await (const line of lines) {
      signal?.throwIfAborted(); bytes += Buffer.byteLength(line); if (bytes > 128000000) throw new Error('event_bytes_limit'); const e = JSON.parse(line);
      if (e.type === 'DOTA_COMBATLOG_DEATH' || e.type === 'DOTA_COMBATLOG_PURCHASE' || e.type === 'DOTA_COMBATLOG_TEAM_BUILDING_KILL') { events.push({ ...e, trace_index:index }); if (events.length > 30000) throw new Error('event_limit'); }
      index++;
    }
  } finally { lines.close(); input.destroy(); }
  return { events, rows:index };
}

// Only retain nearest samples for deaths, never persist the full states trace.
// 0.25 seconds is the maximum absolute distance, independent of life_state.
export async function readReplaySupplement(traceDir, events, signal) {
  let metadata = null;
  for (const filename of ['metadata.jsonl','metadata.json']) {
    try {
      const path = join(traceDir,filename);
      if ((await stat(path)).size > 8000000) throw new Error('metadata_bytes_limit');
      const body = await readFile(path,{encoding:'utf8',signal});
      if (Buffer.byteLength(body) > 8000000) throw new Error('metadata_bytes_limit');
      const rows = filename.endsWith('.jsonl') ? body.split(/\r?\n/).filter(line=>line.trim()).map(line=>JSON.parse(line)) : [JSON.parse(body)];
      for (let i=0;i<rows.length;i++) if (Array.isArray(rows[i]?.players) || Array.isArray(rows[i]?.teams))
        metadata = {...rows[i],metadata_source_path:`trace/${filename}${filename.endsWith('.jsonl') ? '['+i+']' : ''}`};
      if (metadata) break;
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  const deaths = events.filter(e=>e.type === 'DOTA_COMBATLOG_DEATH' && e.target_hero && !e.target_illusion);
  const nearest = new Map();
  const input = createReadStream(join(traceDir,'states.jsonl'),{signal});
  const lines = createInterface({input,crlfDelay:Infinity});
  let index = 0, bytes = 0;
  try {
    for await (const line of lines) {
      signal?.throwIfAborted();
      bytes += Buffer.byteLength(line);
      if (bytes > 600000000) throw new Error('states_bytes_limit');
      const s = JSON.parse(line);
      if (s.entity_kind === 'real_hero' && Number.isFinite(s.t) && Number.isFinite(s.x) && Number.isFinite(s.y)) {
        for (const d of deaths) {
          if (d.target !== 'npc_dota_hero_'+s.hero || Math.abs(s.t-d.t)>0.25) continue;
          const key = `trace/events.jsonl[${d.trace_index}]`, prev = nearest.get(key);
          if (!prev || Math.abs(s.t-d.t)<Math.abs(prev.t-d.t))
            nearest.set(key,{t:s.t,x:s.x,y:s.y,source_path:`trace/states.jsonl[${index}]`,death_source_path:key});
        }
      }
      index++;
    }
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  finally { lines.close(); input.destroy(); }
  return {metadata,positions:[...nearest.values()]};
}

// Explicitly bounded contract: future trace semantics require review.
export function extractorMetadata(summary, matchId) {
  if (![3, 4].includes(summary.trace_version)) throw new Error('Unsupported extractor trace version');
  if (summary.match_id != null && summary.match_id !== matchId) throw new Error('Extractor match ID mismatch');
  if (summary.clock != null && (summary.clock.unit !== 'seconds' || summary.clock.zero !== 'horn_game_start' || summary.clock.name === 'demo_tick_30hz')) throw new Error('Unsupported extractor match clock');
  return { trace_version:summary.trace_version,
    ...(summary.match_id != null ? {extractor_match_id:summary.match_id} : {}),
    ...(summary.clock != null ? {clock:summary.clock} : {}) };
}
