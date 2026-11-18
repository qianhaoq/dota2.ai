import { REPLAY_MAX_STATES_BYTES, REPLAY_MAX_EVENT_BYTES, REPLAY_MAX_RETAINED_EVENTS, REPLAY_MAX_METADATA_BYTES } from './capacity.js';
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
  const keys='[A-Za-z0-9_-]*?(?:authorization|bearer|api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|secret[_-]?key|token|password|passwd|credential|secret|personaname|replay_salt)';
  const dblEnc='\\\\"(?:\\\\\\\\(?:\\\\\\\\|\\\\"|[^\\\\"\\r\\n])|[^\\\\"\\r\\n])*(?:\\\\"|$)';
  const jsonVal='"(?:\\\\.|[^"\\\\\\r\\n])*(?:"|$)';
  const sqVal="'(?:\\\\.|[^'\\\\\\r\\n])*(?:'|$)";
  const unquoted='\\S+(?:[ \\t]+\\S+)*';
  const field=new RegExp(`(\\b(?:${keys})\\b\\s*\\\\?["']?\\s*[:=]\\s*)(${dblEnc}|${jsonVal}|${sqVal}|${unquoted})`,'gi');
  // Field redaction must run before path substitution so JSON escapes stay intact.
  return String(value).replace(field, '$1<redacted>')
    .replace(/https?:\/\/[^\s"'<>]+(?:<redacted>)?/gi, '<url>')
    .replace(/(?:(?:[A-Za-z]:[\\/]|\/|\\\\)[^\s"'<>]+)/g, '<path>')
    .replace(/(\bbearer\s+)(\S+)/gi, '$1<redacted>')
    .slice(0, limit);
}
export const EXTRACTOR_DIAGNOSTIC_KEYS=['last_error','http_status','download_bytes','url_host','dns_reason','stream_error','phase','compression_format','demo_bytes','extractor_exit','extractor_signal','extractor_ok','extractor_error','extractor_stderr','extractor_stderr_truncated','extractor_stdout_tail','extractor_spawn_code','extractor_failure'];
export function pickExtractorDiagnostics(source={}) {
  const diagnostics={};
  for (const key of EXTRACTOR_DIAGNOSTIC_KEYS) {
    const value=source?.[key];
    if (typeof value==='string') diagnostics[key]=sanitizeExtractorDiagnostic(value,2048);
    else if (typeof value==='boolean' || (typeof value==='number' && Number.isFinite(value)) || (value===null && ['extractor_exit','extractor_signal'].includes(key))) diagnostics[key]=value;
  }
  const timings=source?.phase_ms;
  if (timings && Object.getPrototypeOf(timings)===Object.prototype) {
    diagnostics.phase_ms=Object.fromEntries(Object.entries(timings).filter(([key,value])=>['setup','discovering','downloading','verifying','extract','extracting','compacting'].includes(key)&&typeof value==='number'&&Number.isFinite(value)&&value>=0).slice(0,7));
  }
  return diagnostics;
}
export function runExtractor(bin, args, signal) {
  if (signal.aborted) {
    const reason = signal.reason instanceof Error ? signal.reason : new Error('extractor_failed');
    return Promise.reject(Object.assign(reason, {diagnostics:pickExtractorDiagnostics({...(reason.diagnostics||{}), extractor_exit:null, extractor_signal:null})}));
  }
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio:['ignore','pipe','pipe'] });
    let output = '', stderr = '', truncated = false, failure, spawnCode;
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
    child.on('error', e => { failure = 'extractor_failed'; spawnCode = e?.code ?? null; });
    child.on('close', (code, childSignal) => {
      signal.removeEventListener('abort', abort);
      const diagnostics = {extractor_exit:code ?? null, extractor_signal:childSignal ?? null,
        extractor_stderr:sanitizeExtractorDiagnostic(stderr, 2048), extractor_stderr_truncated:truncated};
      if (spawnCode) diagnostics.extractor_spawn_code = String(spawnCode).slice(0,32);
      let r;
      try { r = JSON.parse(output.trim().split('\n').at(-1)); }
      catch { diagnostics.extractor_stdout_tail = sanitizeExtractorDiagnostic(output.trim(), 65536).slice(-200); }
      if (r && typeof r === 'object') {
        if (typeof r.ok === 'boolean') diagnostics.extractor_ok = r.ok;
        const error = [r.error, r.message, r.reason].find(v => typeof v === 'string' && v.trim());
        if (error) diagnostics.extractor_error = sanitizeExtractorDiagnostic(error, 200);
      }
      if (!failure && !signal.aborted && code === 0 && r?.ok === true) return resolve(r);
      if (signal.aborted) {
        const reason = signal.reason instanceof Error ? signal.reason : new Error('extractor_failed');
        return reject(Object.assign(reason, {diagnostics:pickExtractorDiagnostics({...(reason.diagnostics||{}), ...diagnostics, ...(failure?{extractor_failure:String(failure).slice(0,64)}:{})})}));
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
      signal?.throwIfAborted(); bytes += Buffer.byteLength(line); if (bytes > REPLAY_MAX_EVENT_BYTES) throw new Error('event_bytes_limit'); const e = JSON.parse(line);
      if (['DOTA_COMBATLOG_DEATH','DOTA_COMBATLOG_ABILITY','DOTA_COMBATLOG_ITEM','DOTA_COMBATLOG_MODIFIER_REMOVE'].includes(e.type) || e.type === 'DOTA_COMBATLOG_PURCHASE' || e.type === 'DOTA_COMBATLOG_TEAM_BUILDING_KILL') { events.push({ ...e, trace_index:index }); if (events.length > REPLAY_MAX_RETAINED_EVENTS) throw new Error('event_limit'); }
      index++;
    }
  } finally { lines.close(); input.destroy(); }
  return { events, rows:index };
}

// Only retain bounded window/cadence samples, never the full states trace.
// 0.25 seconds is the maximum absolute distance, independent of life_state.
export async function readReplaySupplement(traceDir, events, signal) {
  let metadata = null;
  for (const filename of ['metadata.jsonl','metadata.json']) {
    try {
      const path = join(traceDir,filename);
      if ((await stat(path)).size > REPLAY_MAX_METADATA_BYTES) throw new Error('metadata_bytes_limit');
      const body = await readFile(path,{encoding:'utf8',signal});
      if (Buffer.byteLength(body) > REPLAY_MAX_METADATA_BYTES) throw new Error('metadata_bytes_limit');
      const rows = filename.endsWith('.jsonl') ? body.split(/\r?\n/).filter(line=>line.trim()).map(line=>JSON.parse(line)) : [JSON.parse(body)];
      for (let i=0;i<rows.length;i++) if (Array.isArray(rows[i]?.players) || Array.isArray(rows[i]?.teams))
        metadata = {...rows[i],metadata_source_path:`trace/${filename}${filename.endsWith('.jsonl') ? '['+i+']' : ''}`};
      if (metadata) break;
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  const deaths = events.filter(e=>e.type === 'DOTA_COMBATLOG_DEATH' && e.target_hero && !e.target_illusion);
  const nearest = new Map();
  // Anchor windows: hero deaths, building kills and verified BKB/smoke casts.
  const scored = [];
  for (const e of events) {
    if (!Number.isFinite(e.t)) continue;
    if (e.type === 'DOTA_COMBATLOG_TEAM_BUILDING_KILL') scored.push({t:e.t,kind:'building_kill',key:e.target,score:2});
    else if (e.type === 'DOTA_COMBATLOG_DEATH' && e.target_hero && !e.target_illusion) scored.push({t:e.t,kind:'hero_death',key:e.target,score:1});
    else if (e.type === 'DOTA_COMBATLOG_ITEM' && (e.inflictor === 'item_black_king_bar' || e.inflictor === 'item_smoke_of_deceit')) scored.push({t:e.t,kind:'item_use',key:e.inflictor,score:1});
  }
  const anchors = [];
  // Two greedy passes so building kills cannot crowd out every death/item
  // anchor: structures fill at most window_max_structure slots, then deaths
  // and verified BKB/smoke uses compete for the remaining slots.
  for (const [pass, cap] of [[2, HERO_STATE_CAPS.window_max_structure], [1, HERO_STATE_CAPS.window_max]]) {
    for (const a of scored.filter(x=>x.score===pass).sort((x,y)=>x.t-y.t)) {
      if (anchors.length >= Math.min(cap, HERO_STATE_CAPS.window_max)) break;
      if (anchors.some(p=>Math.abs(p.t-a.t) < HERO_STATE_CAPS.window_merge_s)) continue;
      anchors.push(a);
    }
    if (anchors.length >= HERO_STATE_CAPS.window_max) break;
  }
  anchors.sort((a,b)=>a.t-b.t);
  const cadence = new Map(), windows = anchors.map(()=>new Map());
  let anyRows = false, visibilityRows = 0, visibilityPresent = false, windowRows = 0, truncated = false;
  const input = createReadStream(join(traceDir,'states.jsonl'),{signal});
  const lines = createInterface({input,crlfDelay:Infinity});
  let index = 0, bytes = 0;
  try {
    for await (const line of lines) {
      signal?.throwIfAborted();
      bytes += Buffer.byteLength(line);
      if (bytes > REPLAY_MAX_STATES_BYTES) throw new Error('states_bytes_limit');
      const s = JSON.parse(line);
      if (s.entity_kind === 'real_hero' && Number.isFinite(s.t) && Number.isFinite(s.x) && Number.isFinite(s.y)) {
        anyRows = true;
        if (s.visible_dire != null || s.visible_radiant != null) { visibilityPresent = true; visibilityRows++; }
        for (const d of deaths) {
          if (d.target !== 'npc_dota_hero_'+s.hero || Math.abs(s.t-d.t)>0.25) continue;
          const key = `trace/events.jsonl[${d.trace_index}]`, prev = nearest.get(key);
          if (!prev || Math.abs(s.t-d.t)<Math.abs(prev.t-d.t))
            nearest.set(key,{t:s.t,x:s.x,y:s.y,source_path:`trace/states.jsonl[${index}]`,death_source_path:key});
        }
        if (!truncated) {
          const grid = Math.round(s.t/HERO_STATE_CAPS.cadence_step_s);
          if (Math.abs(s.t-grid*HERO_STATE_CAPS.cadence_step_s) <= HERO_STATE_CAPS.cadence_tolerance_s) {
            const key = s.hero+':'+grid, prev = cadence.get(key);
            if (!prev || Math.abs(s.t-grid*HERO_STATE_CAPS.cadence_step_s) < Math.abs(prev.s.t-grid*HERO_STATE_CAPS.cadence_step_s))
              cadence.set(key,{s,index});
          }
          for (let w=0;w<anchors.length;w++) {
            const a = anchors[w];
            if (s.t < a.t-HERO_STATE_CAPS.window_before_s || s.t > a.t+HERO_STATE_CAPS.window_after_s) continue;
            const bucket = Math.floor(s.t-(a.t-HERO_STATE_CAPS.window_before_s));
            const key = s.hero+':'+bucket;
            if (windows[w].has(key) || windowRows >= HERO_STATE_CAPS.max_rows) continue;
            if (windows[w].size >= HERO_STATE_CAPS.window_max_rows) { truncated = true; continue; }
            windows[w].set(key,{s,index});
            windowRows++;
            if (windowRows >= HERO_STATE_CAPS.max_rows) truncated = true;
          }
        }
      }
      index++;
    }
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  finally { lines.close(); input.destroy(); }
  const cadenceRows = [...cadence.values()]
    .sort((a,b)=>Math.abs(a.s.t-Math.round(a.s.t/HERO_STATE_CAPS.cadence_step_s)*HERO_STATE_CAPS.cadence_step_s)-Math.abs(b.s.t-Math.round(b.s.t/HERO_STATE_CAPS.cadence_step_s)*HERO_STATE_CAPS.cadence_step_s))
    .slice(0,HERO_STATE_CAPS.cadence_max_rows);
  if (cadence.size > HERO_STATE_CAPS.cadence_max_rows) truncated = true;
  const samples = [...cadenceRows, ...windows.flatMap(w=>[...w.values()])]
    .sort((a,b)=>a.s.t-b.s.t||a.index-b.index)
    .map(({s})=>compactStateSample(s));
  const heroStates = anyRows ? {
    source:'trace/states.jsonl', anchors, caps:HERO_STATE_CAPS, truncated,
    visibility: visibilityPresent ? 'fields_present' : 'null_in_trace',
    sampling:HERO_STATE_SAMPLING, samples,
  } : null;
  return {metadata,positions:[...nearest.values()],heroStates};
}

// Documented hard caps: retained samples stay far below artifact practicality;
// the full states trace is still never persisted.
export const HERO_STATE_CAPS = {
  cadence_step_s:30, cadence_tolerance_s:5, cadence_max_rows:1200,
  window_before_s:15, window_after_s:10, window_step_s:1, window_max:6,
  window_max_structure:4, window_max_rows:300, window_merge_s:30, max_rows:3000,
};
export const HERO_STATE_SAMPLING = 'cadence: nearest real_hero row per hero within ±5 s of every 30 s grid point; windows: first real_hero row per hero per ~1 s bucket in [anchor−15 s, anchor+10 s]; cooldown/charges omitted when 0; visibility fields persisted only when non-null; full states trace never persisted';
const round1 = v => Math.round(v*10)/10;
/** Compact per-hero sample; absent optional fields mean 0/unknown, never invented. */
function compactStateSample(s) {
  const r = {t:round1(s.t),hero:s.hero,team:s.team,x:round1(s.x),y:round1(s.y)};
  if (Number.isFinite(s.hp)) r.hp = Math.round(s.hp);
  if (Number.isFinite(s.max_hp)) r.max_hp = Math.round(s.max_hp);
  if (Number.isFinite(s.mana)) r.mana = Math.round(s.mana);
  if (Number.isFinite(s.max_mana)) r.max_mana = Math.round(s.max_mana);
  if (Number.isInteger(s.level)) r.level = s.level;
  if (Number.isInteger(s.life_state)) r.life_state = s.life_state;
  if (Number.isInteger(s.player_index)) r.player_index = s.player_index;
  const items = (Array.isArray(s.items) ? s.items : []).filter(i=>typeof i?.name === 'string').slice(0,9).map(i=>({
    name:i.name, ...(Number.isInteger(i.slot) ? {slot:i.slot} : {}), ...(Number.isFinite(i.charges) && i.charges > 0 ? {charges:i.charges} : {}),
    ...(Number.isFinite(i.cooldown) && i.cooldown > 0 ? {cooldown:round1(i.cooldown)} : {}), ...(Number.isInteger(i.level) && i.level > 1 ? {level:i.level} : {}),
  }));
  if (items.length) r.items = items;
  const abilities = (Array.isArray(s.abilities) ? s.abilities : []).filter(a=>typeof a?.name === 'string' && a.level > 0).slice(0,16).map(a=>({
    name:a.name, ...(Number.isInteger(a.slot) ? {slot:a.slot} : {}), level:a.level,
    ...(Number.isFinite(a.cooldown) && a.cooldown > 0 ? {cooldown:round1(a.cooldown)} : {}), ...(Number.isFinite(a.charges) && a.charges > 0 ? {charges:a.charges} : {}),
  }));
  if (abilities.length) r.abilities = abilities;
  if (s.visible_dire != null) r.visible_dire = s.visible_dire;
  if (s.visible_radiant != null) r.visible_radiant = s.visible_radiant;
  return r;
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
