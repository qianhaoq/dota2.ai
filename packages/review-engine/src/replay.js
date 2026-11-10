import { heroSlug } from './facts/index.js';
export function isVerifiedReplay(a, id) {
  return a?.schema === 'dota2.ai/replay-facts@1' && a.match_id === id && a.status === 'replay_parsed' && /^[a-f0-9]{64}$/.test(a.demo_sha256 ?? '') && typeof a.fetched_at === 'string' && Number.isFinite(Date.parse(a.fetched_at)) && Number.isSafeInteger(a.demo_bytes) && a.demo_bytes > 19 && Array.isArray(a.players) && a.players.every(p => p && typeof p === 'object' && Number.isInteger(p.hero_id) && Number.isInteger(p.player_slot) &&
      ['deaths_log','kills_log','purchase_log'].every(k => Array.isArray(p[k]) && p[k].every(e => e && typeof e === 'object' && Number.isFinite(e.time) && typeof e.source_path === 'string')));
}
/** Combat log t is game time. Legacy heroes.jsonl is uncalibrated demo time;
 * do not turn it into minute economy samples or death coordinates. */
/** @param {any} raw @param {any[]} events @param {any} metadata @param {any} demoMetadata @param {any[]} positionSamples */
export function adaptReplayEvents(raw, events, metadata, demoMetadata = null, positionSamples = []) {
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
      const d = { time:e.t, key:attacker ? e.attacker : null, source_path };
      if (Number.isFinite(e.location_x) && Number.isFinite(e.location_y)) Object.assign(d, { x:e.location_x, y:e.location_y });
      if (!Number.isFinite(d.x)) {
        const sample = positionSamples.find(s => s.death_source_path === source_path);
        if (sample && Number.isFinite(sample.x) && Number.isFinite(sample.y) && Math.abs(sample.t - e.t) <= 0.25)
          Object.assign(d, {x:sample.x,y:sample.y,position_source:'state_sample',sample_t:sample.t,dt:sample.t-e.t,position_source_path:sample.source_path});
      }
      victim.deaths_log.push(d);
      if (attacker) attacker.kills_log.push({ time:e.t, key:e.target, source_path });
    }
    if (e.type === 'DOTA_COMBATLOG_PURCHASE') {
      const buyer = byName.get(e.target) ?? attacker;
      if (buyer && typeof (e.value_name ?? e.inflictor) === 'string' && /^item_[a-z0-9_]+$/.test(e.value_name ?? e.inflictor)) buyer.purchase_log.push({ time:e.t, key:(e.value_name ?? e.inflictor).slice(5), source_path });
    }
    if (e.type === 'DOTA_COMBATLOG_TEAM_BUILDING_KILL' && /^npc_dota_(goodguys|badguys)_(tower[1-4](?:_(?:top|mid|bot))?|(?:melee|range)_rax_(?:top|mid|bot)|fort|fillers)$/.test(e.target ?? ''))
      objectives.push({time:e.t,key:e.target,type:e.type,team:e.attacker_team,source_path});
  }
  const gaps = [{topic:'xp_t',reason:'hero_attribution_unverified'}, {topic:'playerstats',reason:'playerstats_unattributed'}, {topic:'radiant_xp_adv',reason:'not_in_combat_log'}, {topic:'purchase_log',reason:'pregame_combat_rows_may_be_missing'}];
  const metadataPlayers = demoMetadata?.players ?? demoMetadata?.teams?.flatMap(t => t.players ?? []) ?? [];
  for (const p of players) {
    const m = metadataPlayers.find(m => m.player_slot === p.player_slot);
    if (!m) continue;
    const source_path = `trace/metadata.json${demoMetadata.players ? '.players' : '.teams[].players'}[player_slot=${p.player_slot}]`;
    p.metadata_source_path = source_path;
    if (Number.isFinite(m.camps_stacked)) p.camps_stacked = m.camps_stacked;
    const snapshots = m.inventory_snapshots ?? (m.snap_at10plus ? [m.snap_at10plus] : []);
    p.lh_t = []; p.denies_t = [];
    for (const snap of snapshots) if (Number.isInteger(snap.game_time) && snap.game_time >= 0 && snap.game_time % 60 === 0) {
      if (Number.isFinite(snap.last_hits)) p.lh_t[snap.game_time/60] = snap.last_hits;
      if (Number.isFinite(snap.denies)) p.denies_t[snap.game_time/60] = snap.denies;
    }
    p.snapshot_source = 'demo_metadata_inventory_snapshot';
    p.snapshot_sampling = 'exact minute snapshots only; observed snapshot interval approximately 30 seconds';
    if (Array.isArray(m.graph_net_worth) && m.graph_net_worth.length <= Math.floor(raw.duration/60)+1 && m.graph_net_worth.every(Number.isFinite)) {
      p.gold_t = [...m.graph_net_worth];
      p.gold_source = 'demo_metadata_graph_net_worth';
    }
  }
  const graphPlayers = players.filter(p => p.gold_t);
  let radiant_gold_adv;
  if (players.length === 10 && graphPlayers.length === 10 && new Set(graphPlayers.map(p=>p.gold_t.length)).size === 1) {
    radiant_gold_adv = graphPlayers[0].gold_t.map((_,i)=>graphPlayers.reduce((sum,p)=>sum+(p.player_slot < 128 ? 1 : -1)*p.gold_t[i],0));
    if (radiant_gold_adv.length < Math.floor(raw.duration/60)+1) gaps.push({topic:'radiant_gold_adv',reason:'metadata_graph_truncated'});
  } else gaps.push({topic:'gold_t',reason:'metadata_graph_missing_or_invalid'});
  if (!players.some(p=>p.lh_t?.some(Number.isFinite))) gaps.push({topic:'lh_t',reason:'metadata_snapshot_missing'});
  if (!objectives.length) gaps.push({topic:'objectives',reason:'not_in_combat_log'});
  if (players.some(p=>p.deaths_log.some(d=>!Number.isFinite(d.x)))) gaps.push({topic:'death_locations',reason:'position_sample_missing'});
  return { ...metadata, schema:'dota2.ai/replay-facts@1', match_id:raw.match_id, status:'replay_parsed', players, objectives, ...(radiant_gold_adv ? {radiant_gold_adv,gold_source:'demo_metadata_graph_net_worth',gold_derivation:'demo_metadata_graph_net_worth: sum Radiant net worth - sum Dire net worth; 60 second bins from zero'} : {}), data_gaps:gaps, event_rows:rows };
}
export function applyReplayArtifact(raw, artifact) {
  if (!isVerifiedReplay(artifact, raw.match_id)) return { ...raw, replay_ingest:artifact?.status === 'replay_parsed' ? {match_id:raw.match_id,status:'replay_failed',reason:'invalid_artifact'} : artifact };
  /** @type {any[]} */
  const players = (raw.players ?? []).map(p => {
    const clean = { ...p };
    for (const key of ['lh_t','gold_t','xp_t','times','lane','lane_role','lane_pos','purchase_log','deaths_log','kills_log','camps_stacked','denies_t']) delete clean[key];
    return { ...clean, ...artifact.players.find(r => r.hero_id === p.hero_id && r.player_slot === p.player_slot) };
  });
  return { ...raw, players, objectives:artifact.objectives ?? [], radiant_gold_adv:artifact.radiant_gold_adv ?? [], radiant_xp_adv:[], replay_ingest:artifact };
}
export function replayStatusPayload(status, lang = 'en', retryAfterSec = null) {
  const messages = {
    replay_ingest_disabled:['First-party replay ingest is not configured; scoreboard only.','未配置本站录像解析；仅展示基础赛后数据。'],
    replay_unavailable:['No official replay URL is available; scoreboard only.','暂无官方录像地址；仅展示基础赛后数据。'],
    replay_expired:['Official replay has expired or is unavailable; scoreboard only.','官方录像已过期或不可用；仅展示基础赛后数据。'],
    replay_cdn_error:['Official replay CDN failed; no replay timeline was verified.','官方录像 CDN 请求失败；未核实录像时间线。'],
    replay_invalid_url:['Replay URL rejected: an official CDN is required.','录像地址已拒绝：必须使用官方 CDN。'],
    replay_pending:['First-party .dem download/parse is running.','本站正在下载并解析 .dem 录像。'],
    replay_parsed:['First-party .dem facts are ready; missing fields remain gaps.','本站 .dem 录像事实已就绪；缺失字段仍标为数据缺口。'],
    replay_failed:['First-party replay ingest failed; scoreboard remains available.','本站录像解析失败；仍可查看基础赛后数据。'],
    throttled:['Replay ingest budget/cooldown reached; retry later.','录像解析预算或冷却限制已达到；请稍后重试。'],
  };
  return { status, jobId:null, retryAfterSec, message:(messages[status] ?? messages.replay_failed)[lang === 'zh' ? 1 : 0] };
}
