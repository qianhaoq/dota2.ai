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
// Bound and sanitize child diagnostics before they reach durable storage.
export function sanitizeExtractorDiagnostic(value, limit) {
  return String(value).replace(/https?:\/\/[^\s"'<>]+/gi, '<url>')
    .replace(/(?:[A-Za-z]:[\\/]|\/)[^\s"'<>]+/g, '<path>')
    .replace(/(\b(?:authorization|bearer|token|password|api[_-]?key|credential|secret|personaname|replay_salt)\b\s*["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\S+(?:[ \t]+\S+)*)/gi, '$1<redacted>')
    .replace(/(\bbearer\s+)(\S+)/gi, '$1<redacted>')
    .slice(0, limit);
}
export function runExtractor(bin, args, signal) {
  if (signal.aborted) {
    const reason = signal.reason instanceof Error ? signal.reason : new Error('extractor_failed');
    return Promise.reject(Object.assign(reason, {diagnostics:{extractor_exit:null, extractor_signal:null, ...(reason.diagnostics||{})}}));
  }
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio:['ignore','pipe','pipe'] });
    let output = '', stderr = '', truncated = false, failure;
    const abort = () => child.kill('SIGKILL');
    signal.addEventListener('abort', abort, { once:true });
    if (signal.aborted) abort();
    child.stdout.on('data', b => {
      const text = b.toString();
      if (output.length + text.length > 65536) { failure = 'extractor_output_limit'; abort(); }
      output = (output + text).slice(0, 65536);
    });
    // Character cap, applied before redaction as well as afterwards.
    child.stderr.on('data', b => {
      const text = b.toString();
      if (stderr.length + text.length > 2048) truncated = true;
      stderr = (stderr + text).slice(0, 2048);
    });
    child.on('error', () => { failure = 'extractor_failed'; });
    child.on('close', (code, childSignal) => {
      signal.removeEventListener('abort', abort);
      const diagnostics = {extractor_exit:code ?? null, extractor_signal:childSignal ?? null,
        extractor_stderr:sanitizeExtractorDiagnostic(stderr, 2048), extractor_stderr_truncated:truncated};
      let r;
      try { r = JSON.parse(output.trim().split('\n').at(-1)); }
      catch { diagnostics.extractor_stdout_tail = sanitizeExtractorDiagnostic(output.trim(), 65536).slice(-200); }
      if (r && typeof r === 'object') {
        if (typeof r.ok === 'boolean') diagnostics.extractor_ok = r.ok;
        const error = [r.error, r.message, r.reason].find(v => typeof v === 'string');
        if (error) diagnostics.extractor_error = sanitizeExtractorDiagnostic(error, 200);
      }
      if (!failure && !signal.aborted && code === 0 && r?.ok === true) return resolve(r);
      if (failure !== 'extractor_output_limit' && signal.aborted) {
        const reason = signal.reason instanceof Error ? signal.reason : new Error('extractor_failed');
        return reject(Object.assign(reason, {diagnostics:{...diagnostics, ...(reason.diagnostics||{})}}));
      }
      console.error('replay_extractor_failed', diagnostics.extractor_exit, diagnostics.extractor_signal, diagnostics.extractor_ok ?? null, diagnostics.extractor_error ?? null, diagnostics.extractor_stderr_truncated === true);
      reject(Object.assign(new Error(failure || 'extractor_failed'), {diagnostics}));
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
      if (['DOTA_COMBATLOG_DEATH','DOTA_COMBATLOG_ABILITY','DOTA_COMBATLOG_ITEM','DOTA_COMBATLOG_MODIFIER_REMOVE'].includes(e.type) || e.type === 'DOTA_COMBATLOG_PURCHASE' || e.type === 'DOTA_COMBATLOG_TEAM_BUILDING_KILL') { events.push({ ...e, trace_index:index }); if (events.length > 100000) throw new Error('event_limit'); }
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
