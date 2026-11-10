import { heroSlug } from './facts/index.js';
export function isVerifiedReplay(a, id) {
  return a?.schema === 'dota2.ai/replay-facts@1' && a.match_id === id && a.status === 'replay_parsed' && /^[a-f0-9]{64}$/.test(a.demo_sha256 ?? '') && typeof a.fetched_at === 'string' && Number.isFinite(Date.parse(a.fetched_at)) && Number.isSafeInteger(a.demo_bytes) && a.demo_bytes > 19 && Array.isArray(a.players) && a.players.every(p => p && typeof p === 'object' && Number.isInteger(p.hero_id) && Number.isInteger(p.player_slot) &&
      ['deaths_log','kills_log','purchase_log'].every(k => Array.isArray(p[k]) && p[k].every(e => e && typeof e === 'object' && Number.isFinite(e.time) && typeof e.source_path === 'string')));
}
/** Combat log t is game time. Legacy heroes.jsonl is uncalibrated demo time;
 * do not turn it into minute economy samples or death coordinates. */
export function adaptReplayEvents(raw, events, metadata) {
  const players = (raw.players ?? []).map(p => ({ hero_id:p.hero_id, player_slot:p.player_slot, deaths_log:[], kills_log:[], purchase_log:[] }));
  const byName = new Map(players.map(p => [`npc_dota_hero_${heroSlug(p.hero_id)}`, p]));
  let rows = 0;
  for (const e of events) {
    const source_path = `trace/events.jsonl[${e?.trace_index ?? rows}]`; rows++;
    if (!e || !Number.isFinite(e.t) || typeof e.type !== 'string') continue;
    const victim = e.target_hero === true && e.target_illusion === false ? byName.get(e.target) : null;
    const attacker = e.attacker_hero === true && e.attacker_illusion === false ? byName.get(e.attacker) : null;
    if (e.type === 'DOTA_COMBATLOG_DEATH' && victim) {
      const d = { time:e.t, key:attacker ? e.attacker : null, source_path };
      if (Number.isFinite(e.location_x) && Number.isFinite(e.location_y)) Object.assign(d, { x:e.location_x, y:e.location_y });
      victim.deaths_log.push(d);
      if (attacker) attacker.kills_log.push({ time:e.t, key:e.target, source_path });
    }
    if (e.type === 'DOTA_COMBATLOG_PURCHASE') {
      const buyer = attacker ?? victim;
      if (buyer && typeof e.inflictor === 'string' && /^item_[a-z0-9_]+$/.test(e.inflictor)) buyer.purchase_log.push({ time:e.t, key:e.inflictor.slice(5), source_path });
    }
  }
  return { ...metadata, schema:'dota2.ai/replay-facts@1', match_id:raw.match_id, status:'replay_parsed', players, data_gaps:[...(!players.some(p=>p.purchase_log.length) ? ['purchase_log'] : []),'lh_t','gold_t','xp_t','radiant_gold_adv','radiant_xp_adv','objectives'].map(topic => ({ topic, reason:'not_derivable_from_extractor_trace' })), event_rows:rows };
}
export function applyReplayArtifact(raw, artifact) {
  if (!isVerifiedReplay(artifact, raw.match_id)) return { ...raw, replay_ingest:artifact?.status === 'replay_parsed' ? {match_id:raw.match_id,status:'replay_failed',reason:'invalid_artifact'} : artifact };
  const players = (raw.players ?? []).map(p => {
    const clean = { ...p };
    for (const key of ['lh_t','gold_t','xp_t','times','lane','lane_role','lane_pos','purchase_log','deaths_log','kills_log']) delete clean[key];
    return { ...clean, ...artifact.players.find(r => r.hero_id === p.hero_id && r.player_slot === p.player_slot) };
  });
  return { ...raw, players, objectives:[], radiant_gold_adv:[], radiant_xp_adv:[], replay_ingest:artifact };
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
