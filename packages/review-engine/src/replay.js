import { heroSlug } from './facts/index.js';
export function isVerifiedReplay(a, id) {
  // Reject persisted artifacts from the old net-worth-as-earned-gold adapter.
  return a?.gold_source !== 'demo_metadata_graph_net_worth' && !a?.players?.some?.(p=>p?.gold_source === 'demo_metadata_graph_net_worth') && a?.schema === 'dota2.ai/replay-facts@1' && a.match_id === id && a.status === 'replay_parsed' && /^[a-f0-9]{64}$/.test(a.demo_sha256 ?? '') && typeof a.fetched_at === 'string' && Number.isFinite(Date.parse(a.fetched_at)) && Number.isSafeInteger(a.demo_bytes) && a.demo_bytes > 19 && Array.isArray(a.players) && a.players.every(p => p && typeof p === 'object' && Number.isInteger(p.hero_id) && Number.isInteger(p.player_slot) &&
      ['deaths_log','kills_log','purchase_log'].every(k => Array.isArray(p[k]) && p[k].every(e => e && typeof e === 'object' && Number.isFinite(e.time) && typeof e.source_path === 'string')));
}
/** Combat log t is game time. Legacy heroes.jsonl is uncalibrated demo time;
 * do not turn it into minute economy samples or death coordinates. */
const NET_WORTH_DERIVATION = 'demo_metadata_graph_net_worth: metadata stores tens of gold, multiplied by 10 and rounded to gold; net worth, not earned gold; 60s bins from zero; may omit final minute(s); scale verified by first bin in [50, 70] consistent with 600 starting gold';
/** ~30 s snapshots: 400 rows covers a 3+ hour game. */
export const MAX_INVENTORY_SNAPSHOTS = 400;
/** @param {any} raw @param {any[]} events @param {any} metadata @param {any} demoMetadata @param {any[]} positionSamples @param {any} [heroStates] bounded window/cadence samples from readReplaySupplement */
export function adaptReplayEvents(raw, events, metadata, demoMetadata = null, positionSamples = [], heroStates = null) {
  /** @type {any[]} */
  const players = (raw.players ?? []).map(p => ({ hero_id:p.hero_id, player_slot:p.player_slot, deaths_log:[], kills_log:[], purchase_log:[] }));
  const byName = new Map(players.map(p => [`npc_dota_hero_${heroSlug(p.hero_id)}`, p]));
  const objectives = [];
  let rows = 0;
  for (const e of events) {
    const source_path = `trace/events.jsonl[${e?.trace_index ?? rows}]`; rows++;
    if (!e || !Number.isFinite(e.t) || typeof e.type !== 'string') continue;
    const victim = e.target_hero === true && e.target_illusion === false ? byName.get(e.target) : null;
    const attacker = e.attacker_hero === true && e.attacker_illusion === false ? byName.get(e.attacker) : null;
    if (e.type === 'DOTA_COMBATLOG_DEATH' && victim) {
      const d = { time:e.t, key:attacker?e.attacker:(e.attacker&&e.attacker!=='dota_unknown'&&e.attacker_hero!==true?e.attacker:null), ...(e.inflictor && e.inflictor !== 'dota_unknown' ? {inflictor:e.inflictor} : {}), source_path };
      if (Number.isFinite(e.location_x) && Number.isFinite(e.location_y)) Object.assign(d, { x:e.location_x, y:e.location_y });
      if (!Number.isFinite(d.x)) {
        const sample = positionSamples.find(s => s.death_source_path === source_path);
        if (sample && Number.isFinite(sample.x) && Number.isFinite(sample.y) && Math.abs(sample.t - e.t) <= 0.25)
          Object.assign(d, {x:sample.x,y:sample.y,position_source:'state_sample',sample_t:sample.t,dt:sample.t-e.t,position_source_path:sample.source_path});
      }
      victim.deaths_log.push(d);
      if (attacker) attacker.kills_log.push({ time:e.t, key:e.target, source_path });
    }
    if (attacker && e.type === 'DOTA_COMBATLOG_ABILITY' && typeof e.inflictor === 'string')
      (attacker.ability_cast_log ??= []).push({t:e.t,key:e.inflictor,...(e.target && e.target !== 'dota_unknown' ? {target:e.target} : {}),source_path});
    if (attacker && e.type === 'DOTA_COMBATLOG_ITEM') {
      const key = e.inflictor?.replace(/^item_/, '');
      if (key === 'phase_boots') attacker.phase_boots_use_count = (attacker.phase_boots_use_count ?? 0) + 1;
      if (['black_king_bar','spirit_vessel','urn_of_shadows','tpscroll','smoke_of_deceit','magic_wand','ward_sentry','ward_dispenser'].includes(key))
        (attacker.item_use_log ??= []).push({t:e.t,key,source_path});
    }
    if (victim && e.type === 'DOTA_COMBATLOG_MODIFIER_REMOVE' && e.inflictor === 'modifier_black_king_bar_immune') {
      const use = victim.item_use_log?.findLast(u => u.key === 'black_king_bar' && u.ended_at == null && u.t <= e.t);
      if (use) { use.ended_at = e.t; use.end_source_path = source_path; }
    }
    if (e.type === 'DOTA_COMBATLOG_PURCHASE') {
      const buyer = byName.get(e.target) ?? attacker;
      if (buyer && typeof (e.value_name ?? e.inflictor) === 'string' && /^item_[a-z0-9_]+$/.test(e.value_name ?? e.inflictor)) buyer.purchase_log.push({ time:e.t, key:(e.value_name ?? e.inflictor).slice(5), source_path });
    }
    if (e.type === 'DOTA_COMBATLOG_TEAM_BUILDING_KILL' && /^npc_dota_(goodguys|badguys)_(tower[1-4](?:_(?:top|mid|bot))?|(?:melee|range)_rax_(?:top|mid|bot)|fort|fillers)$/.test(e.target ?? ''))
      objectives.push({time:e.t,key:e.target,type:e.type,team:e.attacker_team,source_path});
  }
  const gaps = [{topic:'xp_t',reason:'hero_attribution_unverified'}, {topic:'playerstats',reason:'playerstats_unattributed'}, {topic:'radiant_xp_adv',reason:'not_in_combat_log'}];
  gaps.push({topic:'gold_t',reason:'earned_gold_not_in_replay'}, {topic:'radiant_gold_adv',reason:'earned_gold_not_in_replay'});
  // No reliable Roshan kill event type exists in the trace; combat-log mentions
  // of npc_dota_roshan are contact evidence, never a kill clock.
  gaps.push({topic:'roshan_kill',reason:'no_reliable_roshan_kill_event'});
  if (heroStates?.samples?.length) {
    gaps.push({topic:'creep_waves',reason:'states_have_no_creep_entities'});
    if (heroStates.visibility !== 'fields_present') gaps.push({topic:'hero_state_visibility',reason:heroStates.visibility === 'null_in_trace' ? 'states_visibility_null_in_trace' : 'states_visibility_fields_absent'});
    if (heroStates.truncated) gaps.push({topic:'hero_states',reason:'sample_cap_truncated'});
  }
  if (!players.some(p=>p.purchase_log.some(e=>e.time<0))) gaps.push({topic:'purchase_log',reason:'pregame_combat_rows_may_be_missing'});
  const metadataPlayers = demoMetadata?.players ?? demoMetadata?.teams?.flatMap(t => t.players ?? []) ?? [];
  for (const p of players) {
    const m = metadataPlayers.find(m => m.player_slot === p.player_slot);
    if (!m) continue;
    const source_path = `${demoMetadata.metadata_source_path ?? 'trace/metadata.json'}${demoMetadata.players ? '.players' : '.teams[].players'}[player_slot=${p.player_slot}]`;
    p.metadata_source_path = source_path;
    if (m.hero_key === `npc_dota_hero_${heroSlug(p.hero_id)}`) {
      p.extractor_hero_key = m.hero_key;
      p.hero_identity_source = m.hero_identity_source;
    }
    if (Number.isFinite(m.camps_stacked)) p.camps_stacked = m.camps_stacked;
    const snapshots = m.inventory_snapshots ?? (m.snap_at10plus ? [m.snap_at10plus] : []);
    p.inventory_snapshots = []; p.lh_t = []; p.denies_t = []; p.lh_t_sample = {}; p.denies_t_sample = {};
    for (const snap of snapshots) {
      if (!Number.isInteger(snap.game_time) || snap.game_time < 0 || p.inventory_snapshots.length >= MAX_INVENTORY_SNAPSHOTS) continue;
      const row = { t:snap.game_time };
      for (const key of ['last_hits','denies','kills','deaths','assists','level']) if (Number.isFinite(snap[key])) row[key] = snap[key];
      p.inventory_snapshots.push(row);
      // Minute-aligned view: nearest snapshot within 30 s; the real sample
      // game_time is recorded and stays the source of truth for citations.
      const minute = Math.round(snap.game_time/60);
      const delta = Math.abs(snap.game_time-minute*60);
      if (delta <= 30) {
        for (const [field, sampleMap] of [['last_hits','lh_t_sample'],['denies','denies_t_sample']]) {
          if (!Number.isFinite(snap[field])) continue;
          const target = field === 'last_hits' ? 'lh_t' : 'denies_t';
          if (p[target][minute] === undefined || delta < Math.abs((p[sampleMap][minute] ?? minute*60)-minute*60)) {
            p[target][minute] = snap[field];
            p[sampleMap][minute] = snap.game_time;
          }
        }
      }
    }
    if (!p.inventory_snapshots.length) { delete p.inventory_snapshots; delete p.lh_t_sample; delete p.denies_t_sample; }
    p.snapshot_source = 'demo_metadata_inventory_snapshot';
    p.snapshot_sampling = 'snapshots retained at actual game_time (approximately 30 s cadence, not exact minutes); lh_t/denies_t are a minute-aligned view of the nearest snapshot within 30 s and per-minute sample game_time is recorded; not a per-last-hit log';
    if (Array.isArray(m.graph_net_worth) && m.graph_net_worth.length <= 10000 && m.graph_net_worth.every(Number.isFinite)) {
      if (m.graph_net_worth.length && m.graph_net_worth[0] >= 50 && m.graph_net_worth[0] <= 70) {
        p.net_worth_t = m.graph_net_worth.map(v=>Math.round(v*10));
        p.net_worth_source = 'demo_metadata_graph_net_worth';
        p.net_worth_derivation = NET_WORTH_DERIVATION;
        if (m.graph_net_worth.length > Math.floor(raw.duration/60)+1) {
          p.net_worth_timing = 'uncalibrated_graph_bins';
          p.net_worth_derivation = 'demo_metadata_graph_net_worth: multiplied by 10 and rounded to gold after initial-bin scale check; net worth, not earned gold; graph sample times unverified';
          gaps.push({topic:'net_worth_t',reason:'metadata_graph_timing_unverified'});
        }
      } else gaps.push({topic:'net_worth_t',reason:'metadata_graph_unit_unverified'});
    }
  }
  const graphPlayers = players.filter(p => p.net_worth_t && !p.net_worth_timing);
  let radiant_net_worth_adv;
  if (players.length === 10 && graphPlayers.length === 10 && new Set(graphPlayers.map(p=>p.net_worth_t.length)).size === 1) {
    radiant_net_worth_adv = graphPlayers[0].net_worth_t.map((_,i)=>graphPlayers.reduce((sum,p)=>sum+(p.player_slot < 128 ? 1 : -1)*p.net_worth_t[i],0));
    if (radiant_net_worth_adv.length < Math.floor(raw.duration/60)+1) gaps.push({topic:'radiant_net_worth_adv',reason:'metadata_graph_truncated'});
  } else if (players.some(p=>p.net_worth_timing)) gaps.push({topic:'radiant_net_worth_adv',reason:'metadata_graph_timing_unverified'});
  else gaps.push({topic:'net_worth_t',reason:'metadata_graph_missing_or_invalid'});
  if (!players.some(p=>p.lh_t?.some(Number.isFinite))) gaps.push({topic:'lh_t',reason:'metadata_snapshot_missing'});
  if (!objectives.length) gaps.push({topic:'objectives',reason:'not_in_combat_log'});
  if (players.some(p=>p.deaths_log.some(d=>!Number.isFinite(d.x)))) gaps.push({topic:'death_locations',reason:'position_sample_missing'});
  return { ...metadata, schema:'dota2.ai/replay-facts@1', match_id:raw.match_id, status:'replay_parsed', players, objectives, ...(radiant_net_worth_adv ? {radiant_net_worth_adv,net_worth_source:'demo_metadata_graph_net_worth',net_worth_derivation:NET_WORTH_DERIVATION} : {}), ...(heroStates?.samples?.length ? {hero_states:{source:heroStates.source,sampling:heroStates.sampling,caps:heroStates.caps,anchors:heroStates.anchors,visibility:heroStates.visibility,truncated:!!heroStates.truncated,samples:heroStates.samples}} : {}), data_gaps:gaps, event_rows:rows };
}
export function applyReplayArtifact(raw, artifact) {
  if (!isVerifiedReplay(artifact, raw.match_id)) return { ...raw, replay_ingest:artifact?.status === 'replay_parsed' ? {match_id:raw.match_id,status:'replay_failed',reason:'invalid_artifact'} : artifact };
  /** @type {any[]} */
  const players = (raw.players ?? []).map(p => {
    const clean = { ...p };
    for (const key of ['lh_t','gold_t','xp_t','times','lane','lane_role','lane_pos','purchase_log','deaths_log','kills_log','camps_stacked','denies_t','net_worth_t']) delete clean[key];
    const merged = { ...clean, ...artifact.players.find(r => r.hero_id === p.hero_id && r.player_slot === p.player_slot) };
    // Retain raw graph in the artifact, but never index uncalibrated bins as minutes.
    if (merged.net_worth_timing === 'uncalibrated_graph_bins') delete merged.net_worth_t;
    return merged;
  });
  return { ...raw, players, objectives:artifact.objectives ?? [], radiant_gold_adv:[], radiant_net_worth_adv:artifact.radiant_net_worth_adv ?? [], radiant_xp_adv:[], ...(artifact.radiant_net_worth_adv ? {net_worth_source:artifact.net_worth_source, net_worth_derivation:artifact.net_worth_derivation} : {}), ...(artifact.hero_states ? {hero_states:artifact.hero_states} : {}), replay_ingest:artifact };
}
export function replayStatusPayload(status, lang = 'en', retryAfterSec = null) {
  const messages = {
    replay_ingest_disabled:['First-party replay ingest is not configured; scoreboard only.','未配置本站录像解析；仅展示基础赛后数据。'],
    replay_unavailable:['No official replay URL is available; scoreboard only.','暂无官方录像地址；仅展示基础赛后数据。'],
    replay_expired:['Official replay has expired or is unavailable; scoreboard only.','官方录像已过期或不可用；仅展示基础赛后数据。'],
    replay_store_error:['Replay storage failed; no replay timeline was verified.','录像存储失败；未核实录像时间线。'],
    replay_cdn_error:['Official replay CDN failed; no replay timeline was verified.','官方录像 CDN 请求失败；未核实录像时间线。'],
    replay_invalid_url:['Replay URL rejected: an official CDN is required.','录像地址已拒绝：必须使用官方 CDN。'],
    replay_pending:['First-party .dem download/parse is running.','本站正在下载并解析 .dem 录像。'],
    replay_parsed:['First-party .dem facts are ready; missing fields remain gaps.','本站 .dem 录像事实已就绪；缺失字段仍标为数据缺口。'],
    replay_failed:['First-party replay ingest failed; scoreboard remains available.','本站录像解析失败；仍可查看基础赛后数据。'],
    throttled:['Replay ingest budget/cooldown reached; retry later.','录像解析预算或冷却限制已达到；请稍后重试。'],
  };
  return { status, jobId:null, retryAfterSec, message:(messages[status] ?? messages.replay_failed)[lang === 'zh' ? 1 : 0] };
}
