/**
 * Whole-match main line + 3–5 bounded decision windows, generated from the
 * fact layer only. Layers stay separate: verified facts (known/actions),
 * recorded contrasts (comparable), and the missing-evidence list. No sentence
 * may assert causality (因此/所以/因为/led to): events are ordered, never
 * explained. A clock may only appear in copy when a cited fact carries it.
 *
 * Windows are resource/objective conversion frames: a kill cluster that never
 * became map objectives, the resource/objective line after a core mobility
 * item, an item timing set against structure losses, and objective stretches
 * (takes, losses, high ground, the Ancient). Deaths are execution evidence
 * inside those frames — never the window theme or title. The evaluation layer
 * exists only for a decision judgment the fields support; restating a 60 s
 * net-worth bucket delta is not a judgment, so when that is all there is the
 * section is omitted entirely.
 */
import { evidenceName, itemName, clock } from '../insights/moments.js';
import { formatObjectiveLabel, formatBuildingName } from '../objectiveLabels.js';
import { STATIC_HEROES } from '../staticHeroes.js';
import { heroSlug, KEY_ITEMS } from '../facts/index.js';

export const MAINLINE_WINDOWS = { min: 3, max: 5 };
const LANING_END_S = 900;
/** Focus kills this many seconds apart belong to one cluster. */
const KILL_CLUSTER_GAP_S = 300;
const KILL_CLUSTER_MIN = 3;
/** A take shortly after the last kill still counts as conversion. */
const CONVERSION_GRACE_S = 120;
/** Core item completions this close after a cluster extend its frame. */
const ITEM_EXTEND_S = 240;
const MID_HORIZON_S = 1200;
const STRETCH_GAP_S = 150;
/** A death just after a stretch's last structure event is aftermath evidence. */
const STRETCH_DEATH_PAD_S = 90;
/** A candidate mostly inside an already-picked window of another kind is padding. */
const CONTAIN_RATIO = 0.8;
/** Execution evidence immediately before a BKB purchase stays inside the frame. */
const BKB_BACK_PAD_S = 60;
/** Longest leading kill-log gap inside a window that still reads as one stretch. */
const KILL_LOG_GAP_NOTE_S = 600;
const STATE_WINDOW_START_TOL_S = 15;
const STATE_ANCHOR_TOL_S = 5;
const SNAPSHOT_TOL_S = 35;
/** A focus state sample may ground practice evidence only this close to a
 * recorded death — one sampling-cadence step, never a long window's start. */
const DEATH_STATE_TOL_S = 30;
/** Items whose completions may anchor or extend a window (recipes excluded). */
const CORE_ITEM_KEYS = new Set([...Object.keys(KEY_ITEMS), 'travel_boots', 'kaya', 'meteor_hammer', 'ultimate_scepter', 'aghanims_shard', 'octarine_core']);
/** Core mobility items that open the post-item resource/objective line. */
const POWER_ITEM_KEYS = ['travel_boots', 'blink'];

const killerSideOf = team => team === 2 || team === 'radiant' ? 'radiant' : team === 3 || team === 'dire' ? 'dire' : null;
/** Inflictor labels that failed to resolve must be omitted, never printed. */
const knownName = (key, lang) => {
  const label = evidenceName(key, lang);
  return /未知|Unknown/.test(label) ? null : label;
};

const sideName = (team, zh) => team === 2 ? (zh ? '天辉' : 'Radiant') : team === 3 ? (zh ? '夜魇' : 'Dire') : '';
const ownerSideOf = key => typeof key === 'string' ? (key.includes('goodguys') ? 'radiant' : key.includes('badguys') ? 'dire' : null) : null;
const fmtSigned = v => `${v < 0 ? '-' : '+'}${Math.abs(Math.round(v)).toLocaleString('en-US')}`;
const pctOf = (v, max) => (Number.isFinite(v) && Number.isFinite(max) && max > 0) ? Math.round((v / max) * 100) : null;
const slugOfKey = key => String(key ?? '').replace(/^npc_dota_hero_/, '');

/**
 * @param {{facts: Record<string, any>, deaths: any[], gaps: any[]}} result buildFacts result (already enriched with obj.*, cast.*, use.bkb.* facts)
 * @param {any} raw merged match (replay artifact applied; duration/winner from the OpenDota raw when present)
 * @param {any} focus focus player
 * @param {any[]} players full roster
 * @param {'en'|'zh'} lang
 * @param {any[]} objectives buildReview-mapped objectives (t/type/key/team/fact_id)
 * @param {any[]} [momentCards] cards from buildMoments; a death is narrated in
 *   insights only when buildMoments promoted it (an independent linked cast
 *   exists). Unpromoted records stay in the deaths appendix — a recorded
 *   inflictor alone (e.g. a hook) never becomes a claim about a cast.
 */
export function buildMainline(result, raw, focus, players, lang, objectives = [], momentCards = []) {
  const zh = lang === 'zh';
  const facts = result.facts;
  const duration = Number.isFinite(raw.duration) ? raw.duration : null;
  // The horizon must be carried by a fact (ancient.fell or the last recorded
  // event) — never padded, so every clock in the overview copy stays citable.
  // Production durations are integer seconds while building events carry
  // fractions, so the OpenDota duration can sit below the last verified event
  // (the Ancient fall is routinely a fraction past the integer). The horizon
  // is the later of the two: it must never clip a recorded event — especially
  // the Ancient — out of the last window.
  const eventTimes = [...objectives.map(o => o.t), ...result.deaths.map(d => d.t)].filter(Number.isFinite);
  const lastEventT = eventTimes.length ? Math.max(...eventTimes) : 0;
  const horizon = Math.max(duration ?? 0, lastEventT);
  const focusTeam = focus.player_slot < 128 ? 'radiant' : 'dire';
  const focusKey = STATIC_HEROES[focus.hero_id]?.internalName ?? null;
  const focusLabel = focusKey ? evidenceName(focusKey, lang) : slugOfKey(heroSlug(focus.hero_id) ?? focus.hero_id);
  const heroStates = raw.hero_states?.samples?.length ? raw.hero_states : null;
  const stateBySlug = new Map();
  if (heroStates) for (const s of heroStates.samples) {
    const slug = slugOfKey(s.hero);
    if (!slug) continue;
    const rows = stateBySlug.get(slug) ?? [];
    rows.push(s);
    stateBySlug.set(slug, rows);
  }
  const stateNear = (slug, t, tol) => {
    let best = null;
    for (const s of stateBySlug.get(slug) ?? []) {
      if (!Number.isFinite(s.t)) continue;
      const dt = Math.abs(s.t - t);
      if (dt <= tol && (!best || dt < best.dt)) best = { s, dt };
    }
    return best;
  };

  // Advantage series: earned gold when it exists, otherwise the replay's
  // net-worth buckets — always labeled with which one is in use. Radiant
  // perspective; prose converts to the focus team's side explicitly.
  const gold = Array.isArray(raw.radiant_gold_adv) ? raw.radiant_gold_adv.filter(Number.isFinite) : [];
  const nw = Array.isArray(raw.radiant_net_worth_adv) ? raw.radiant_net_worth_adv.filter(Number.isFinite) : [];
  const useGold = gold.length >= 5;
  const advSeries = useGold ? gold : nw;
  const advAt = t => {
    const i = Math.floor(t / 60);
    return (i >= 0 && i < advSeries.length && Number.isFinite(advSeries[i])) ? advSeries[i] : null;
  };
  const advForTeam = (t, team) => {
    const v = advAt(t);
    return v == null ? null : (team === 'dire' ? -v : v);
  };

  const addFact = fact => { facts[fact.id] = fact; return fact.id; };
  /** Radiant-perspective advantage at bucket m, as its own citable fact. */
  const advFact = m => {
    const id = `net_worth.adv.at.${m}`;
    if (facts[id] || !Number.isFinite(advSeries[m])) return null;
    const basisEn = useGold ? 'earned-gold advantage' : 'net-worth advantage';
    const basisZh = useGold ? '赚金优势' : '净资产优势（60 秒桶）';
    return addFact({
      id, kind: 'scalar', value: advSeries[m], unit: 'gold', t: m * 60, perspective: 'radiant',
      display: {
        en: `${basisEn} at bucket ${m} (≈${clock(m * 60)}): Radiant ${fmtSigned(advSeries[m])}`,
        zh: `${basisZh}第 ${m} 桶（约 ${clock(m * 60)}）：天辉 ${fmtSigned(advSeries[m])}`,
      },
      citation: 'r1',
      source_path: useGold ? 'radiant_gold_adv' : 'radiant_net_worth_adv',
      ...(useGold ? {} : { derivation: typeof raw.net_worth_derivation === 'string' ? raw.net_worth_derivation : '60s net-worth buckets; a bucket index is not an event clock' }),
    });
  };
  /** Focus-team structure counts strictly before the decision time cutT —
   * events at or after cutT (including a window's own start anchor) had not
   * happened yet and are never "known"; deny = destroyed by its owner side. */
  const towersFact = (cutT, kind) => {
    const id = `towers.${kind}.before.${Math.round(cutT)}`;
    if (facts[id]) return id;
    let count = 0;
    const parts = [];
    for (const o of objectives) {
      if (!Number.isFinite(o.t) || o.t >= cutT) continue;
      if (o.type !== 'building_kill' && !/tower|rax|fort/.test(String(o.key ?? ''))) continue;
      const owner = ownerSideOf(o.key);
      const killer = killerSideOf(o.team);
      if (!owner || !killer) continue;
      if (killer !== owner && killer === focusTeam) { if (kind === 'pushed') { count++; parts.push(`${clock(o.t)} ${formatBuildingName(o.key, lang)}`); } }
      else if (killer !== owner && owner === focusTeam) { if (kind === 'lost') { count++; parts.push(`${clock(o.t)} ${formatBuildingName(o.key, lang)}`); } }
      else if (killer === owner && killer === focusTeam) { if (kind === 'denied') { count++; parts.push(`${clock(o.t)} ${formatBuildingName(o.key, lang)}`); } }
    }
    if (!parts.length && kind !== 'pushed') return null;
    return addFact({
      id, kind: 'count', value: count, unit: 'structures', t: cutT, perspective: 'player_team',
      display: {
        en: `${{ pushed: 'Taken by your team', lost: 'Lost by your team', denied: 'Denied by your team' }[kind]} before ${clock(cutT)}: ${count}`,
        zh: `${clock(cutT)} 前${{ pushed: '我方摧毁', lost: '我方失去', denied: '我方自拆' }[kind]}：${count}`,
      },
      citation: 'r1', source_path: 'objectives',
      derivation: `strict cutoff at ${clock(cutT)}; deny = structure destroyed by its owner side; derived from ${parts.length} objective events`,
    });
  };

  // Labels want the numeric killer side; mapped objectives carry 'radiant'/'dire'.
  const objNum = o => ({ ...o, teamNum: killerSideOf(o.team) === 'radiant' ? 2 : killerSideOf(o.team) === 'dire' ? 3 : null });
  const numberedObjectives = objectives.map(objNum);
  const deathFactIds = new Set(result.deaths.map(d => d.fact_id));
  const promotedDeathIds = new Set((momentCards ?? []).flatMap(c => c.fact_ids).filter(id => deathFactIds.has(id)));
  const deaths = result.deaths.filter(d => promotedDeathIds.has(d.fact_id));
  const eventTime = e => Number.isFinite(e?.t) ? e.t : e?.time;
  const focusKills = (focus.kills_log ?? []).map(k => ({ ...k, t: eventTime(k) })).filter(k => Number.isFinite(k.t) && k.key);
  const bkbUses = (focus.item_use_log ?? []).filter(u => u.key === 'black_king_bar' && Number.isFinite(u.t));
  // Only uses buildMoments linked (verified interval tied to an enemy cast or a
  // recorded death) become candidates or actions; an unlinked use has no
  // use.bkb fact and would render a window indistinguishable from a swing.
  const linkedBkbUses = bkbUses
    .map((u, i) => ({ ...u, idx: i + 1, bkbId: `use.bkb.${i + 1}` }))
    .filter(x => facts[x.bkbId]);
  const purchases = (focus.purchase_log ?? []).filter(p => Number.isFinite(p?.time) && typeof p?.key === 'string' && p.time >= 0).sort((a, b) => a.time - b.time);
  const snapshotNearest = t => {
    let best = null;
    for (const snap of focus.inventory_snapshots ?? []) {
      if (!Number.isInteger(snap.t)) continue;
      const dt = Math.abs(snap.t - t);
      if (dt <= SNAPSHOT_TOL_S && (!best || dt < best.dt)) best = { snap, dt };
    }
    return best;
  };

  // ---- candidate decision windows ----------------------------------------
  // Structure events split by meaning: a take (your team destroyed an enemy
  // structure), a loss (an enemy destroyed yours), and same-side demolitions
  // which are never counted as either side's push.
  const isTake = o => killerSideOf(o.team) === focusTeam && ownerSideOf(o.key) && ownerSideOf(o.key) !== focusTeam;
  const isLoss = o => ownerSideOf(o.key) === focusTeam && killerSideOf(o.team) && killerSideOf(o.team) !== focusTeam;
  const structEvents = numberedObjectives.filter(o => Number.isFinite(o.t)).filter(o => {
    const owner = ownerSideOf(o.key);
    const killer = killerSideOf(o.team);
    return owner && killer && killer !== owner;
  }).sort((a, b) => a.t - b.t);
  const takes = structEvents.filter(isTake);
  const losses = structEvents.filter(isLoss);
  const takesBetween = (a, b) => takes.filter(o => o.t >= a && o.t <= b);
  const lossesBetween = (a, b) => losses.filter(o => o.t >= a && o.t <= b);
  // Core item completions (non-recipe purchases of core items), in time order.
  const completions = purchases.filter(p => CORE_ITEM_KEYS.has(p.key));
  /** Completion fact for a core item; carries the completion clock for copy. */
  const itemDoneFact = entry => {
    const id = `item.done.${entry.key}`;
    if (facts[id]) return id;
    return addFact({
      id, kind: 'time', value: entry.time, unit: 'seconds', t: entry.time, perspective: 'player_team',
      display: {
        en: `${itemName(entry.key, 'en')} completed at ${clock(entry.time)}`,
        zh: `${clock(entry.time)} ${itemName(entry.key, 'zh')}合成完毕`,
      },
      citation: 'r1', source_path: entry.source_path ?? 'purchase_log',
    });
  };

  const candidates = [];

  // A. Kill cluster without map conversion: several focus kills, and through
  // the cluster's end the team has taken zero enemy structures (a same-side
  // demolition by the enemy is not a take). The frame ends on a recorded
  // anchor — the last kill, or a core completion just after it.
  const killClusters = [];
  for (const k of [...focusKills].sort((a, b) => a.t - b.t)) {
    const cur = killClusters[killClusters.length - 1];
    if (cur && k.t - cur.lastT <= KILL_CLUSTER_GAP_S) { cur.kills.push(k); cur.lastT = k.t; }
    else killClusters.push({ kills: [k], lastT: k.t });
  }
  for (const cluster of killClusters) {
    if (cluster.kills.length < KILL_CLUSTER_MIN) continue;
    const from = Math.floor(cluster.kills[0].t);
    const ext = completions.filter(c => c.time > cluster.lastT && c.time <= cluster.lastT + ITEM_EXTEND_S);
    const to = Math.ceil(ext.length ? ext[ext.length - 1].time : cluster.lastT);
    if (takesBetween(from, to + CONVERSION_GRACE_S).length) continue;
    candidates.push({
      kind: 'kills_no_conversion', from, to, anchor: from, score: 6 + Math.min(4, cluster.kills.length * 0.5),
      ext,
    });
  }

  // B. Post-power-item resource/objective stretch: after the first core
  // mobility item, through a mid-game horizon or the next kill cluster. The
  // theme is the conversion line (takes, losses); the advantage series only
  // ever appears as labeled 60 s bucket context.
  const powerItem = completions.find(c => POWER_ITEM_KEYS.includes(c.key) && (!horizon || c.time <= horizon));
  if (powerItem) {
    const nextCluster = killClusters.find(c => c.kills[0].t > powerItem.time);
    const cap = Math.min(powerItem.time + MID_HORIZON_S, nextCluster ? nextCluster.kills[0].t : Infinity, horizon ?? Infinity);
    const anchors = [...structEvents, ...focusKills, ...completions.map(c => ({ t: c.time })), ...deaths]
      .filter(e => Number.isFinite(e.t) && e.t >= powerItem.time && e.t <= cap).map(e => e.t);
    const to = anchors.length ? Math.ceil(Math.max(...anchors)) : null;
    if (to != null && to > powerItem.time
      && (takesBetween(powerItem.time, to).length || lossesBetween(powerItem.time, to).length
        || focusKills.some(k => k.t >= powerItem.time && k.t <= to))) {
      candidates.push({
        kind: 'post_item_objectives', from: Math.floor(powerItem.time), to, anchor: Math.floor(powerItem.time),
        item: powerItem, score: 7,
      });
    }
  }

  // C. Item timing vs structure loss: BKB purchased and its first linked use
  // recorded while your own structures fell. An unlinked use never opens this
  // window — without the use.bkb fact it would be indistinguishable from a
  // plain loss stretch.
  const bkbFirstFact = facts['item.first.black_king_bar'];
  if (bkbFirstFact && Number.isFinite(bkbFirstFact.value)) {
    const use = linkedBkbUses.find(u => u.t >= bkbFirstFact.value);
    if (use) {
      const from = Math.floor(Math.max(0, bkbFirstFact.value - BKB_BACK_PAD_S));
      const to = Math.ceil(Math.max(use.t, use.ended_at ?? use.t));
      if (lossesBetween(from, to).length) {
        candidates.push({ kind: 'bkb_vs_structures', from, to, anchor: Math.floor(bkbFirstFact.value), use, score: 6.5 });
      }
    }
  }

  // D. Objective stretches: runs of structure takes/losses (denies excluded),
  // extended a little past the last event so a death right after the stretch
  // stays inside as execution evidence.
  const stretches = [];
  for (const o of structEvents) {
    const cur = stretches[stretches.length - 1];
    if (cur && o.t - cur.lastT <= STRETCH_GAP_S) { cur.events.push(o); cur.lastT = o.t; }
    else stretches.push({ events: [o], lastT: o.t });
  }
  for (const stretch of stretches) {
    if (stretch.events.length < 2) continue;
    const after = deaths.filter(d => d.t > stretch.lastT && d.t <= stretch.lastT + STRETCH_DEATH_PAD_S);
    const fort = stretch.events.find(o => typeof o.key === 'string' && o.key.endsWith('_fort'));
    candidates.push({
      kind: 'objective_stretch',
      from: Math.floor(stretch.events[0].t),
      to: Math.ceil(Math.max(stretch.lastT, ...after.map(d => d.t))),
      anchor: Math.floor(stretch.events[0].t),
      score: 5 + (fort ? 2 : 0) + Math.min(2, stretch.events.length / 4),
    });
  }

  // Pick by score; drop same-kind windows overlapping more than half the
  // shorter span, and other-kind windows mostly contained in an already-picked
  // frame (a nested loss stretch inside the post-item line reads as padding).
  candidates.sort((a, b) => b.score - a.score || a.from - b.from);
  const pickedList = [];
  for (const c of candidates) {
    if (pickedList.length >= MAINLINE_WINDOWS.max) break;
    const clash = pickedList.find(p => {
      const overlap = Math.min(p.to, c.to) - Math.max(p.from, c.from);
      if (overlap <= 0) return false;
      return p.kind === c.kind
        ? overlap * 2 > Math.min(p.to - p.from, c.to - c.from)
        : overlap >= CONTAIN_RATIO * (c.to - c.from);
    });
    if (!clash) pickedList.push(c);
  }
  const finalPicked = pickedList.sort((a, b) => a.from - b.from);
  const windowsShort = finalPicked.length < MAINLINE_WINDOWS.min;
  // With no windows, no recorded structure events and no advantage series there
  // is nothing to narrate; an empty timeline gets no filler overview.
  if (!finalPicked.length && !numberedObjectives.length && !advSeries.length) {
    return { insights: [], practice: null, windowsShort: true };
  }

  // ---- overview -----------------------------------------------------------
  // Phase bounds are minute-aligned so a towers/advantage fact can carry each
  // printed clock; the final bound is the horizon itself (ancient.fell).
  const laningEnd = Math.min(LANING_END_S, horizon);
  const midSnap = Math.round((horizon * 2 / 3) / 60) * 60;
  const midEnd = horizon > laningEnd + 300 && midSnap < horizon ? Math.max(laningEnd + 300, midSnap) : null;
  const phases = [];
  if (horizon > 0) {
    phases.push({ key: 'laning', from: 0, to: laningEnd, ...(midEnd ? {} : { to: horizon }) });
    if (midEnd) {
      phases.push({ key: 'mid', from: laningEnd, to: midEnd });
      phases.push({ key: 'late', from: midEnd, to: horizon });
    }
  }
  const phaseLines = [];
  const phaseFactIds = [];
  const phaseLabel = { laning: zh ? '对线期' : 'Laning', mid: zh ? '中期' : 'Mid game', late: zh ? '后期' : 'Late game' };
  for (const phase of phases) {
    const ids = [];
    const dts = deaths.filter(d => d.t >= phase.from && d.t < phase.to);
    const recordedDts = result.deaths.filter(d => Number.isFinite(d.t) && d.t >= phase.from && d.t < phase.to);
    const kills = focusKills.filter(k => k.t >= phase.from && k.t < phase.to);
    const objs = numberedObjectives.filter(o => o.t >= phase.from && o.t < phase.to);
    const startAdv = advForTeam(phase.from, focusTeam);
    const endAdv = advForTeam(Math.max(phase.from, phase.to - 1), focusTeam);
    if (phase.key === 'laning' && Number.isFinite(facts.lh_at_10?.value)) ids.push('lh_at_10');
    // Every printed phase bound needs a fact carrying that clock.
    const advA = advFact(Math.floor(phase.from / 60)); if (advA) ids.push(advA);
    const boundA = towersFact(phase.from, 'pushed'); if (boundA) ids.push(boundA);
    const advB = advFact(Math.max(0, Math.floor(Math.max(phase.from, phase.to - 1) / 60))); if (advB && !ids.includes(advB)) ids.push(advB);
    if (phase.to % 60 === 0) { const boundB = towersFact(phase.to, 'pushed'); if (boundB && !ids.includes(boundB)) ids.push(boundB); }
    else {
      // Prefer the recorded Ancient fall over the duration-derived stand-in.
      const fort = numberedObjectives.find(o => typeof o.key === 'string' && o.key.endsWith('_fort') && o.fact_id && facts[o.fact_id] && Math.abs(o.t - phase.to) <= 5);
      if (fort) ids.push(fort.fact_id);
      else if (facts['ancient.fell']) ids.push('ancient.fell');
    }
    for (const o of objs) if (o.fact_id && facts[o.fact_id]) ids.push(o.fact_id);
    for (const d of dts) if (d.fact_id && facts[d.fact_id]) ids.push(d.fact_id);
    if (!ids.length) {
      phaseLines.push(zh
        ? `${phaseLabel[phase.key]}（${clock(phase.from)}–${clock(phase.to)}）：本阶段没有可核实的证据，不评述。`
        : `${phaseLabel[phase.key]} (${clock(phase.from)}–${clock(phase.to)}): no verifiable evidence in this phase; not assessed.`);
      continue;
    }
    phaseFactIds.push(...ids);
    const bits = [];
    if (dts.length) {
      const first = dts[0];
      const killerLabel = first.killer ? evidenceName(first.killer, lang) : (zh ? '未知单位' : 'an unknown unit');
      bits.push(zh
        ? `阵亡 ${dts.length} 次（首次 ${clock(first.t)} 被${killerLabel}击杀）`
        : `${dts.length} death${dts.length > 1 ? 's' : ''} (first at ${clock(first.t)}, killed by ${killerLabel})`);
    } else if (!recordedDts.length) bits.push(zh ? '无阵亡记录' : 'no recorded deaths');
    else bits.push(zh
      ? `阵亡记录 ${recordedDts.length} 条（见死亡列表；本阶段没有可核实的关联施法）`
      : `${recordedDts.length} death record${recordedDts.length > 1 ? 's' : ''} (in the death list; no verifiable linked cast in this phase)`);
    if (kills.length) bits.push(zh ? `击杀记录 ${kills.length} 次` : `${kills.length} recorded kill${kills.length > 1 ? 's' : ''}`);
    const pushed = objs.filter(o => killerSideOf(o.team) === focusTeam && ownerSideOf(o.key) && ownerSideOf(o.key) !== focusTeam);
    const lost = objs.filter(o => ownerSideOf(o.key) === focusTeam && killerSideOf(o.team) && killerSideOf(o.team) !== focusTeam);
    if (pushed.length) {
      const last = pushed[pushed.length - 1];
      bits.push(zh
        ? `推掉对方建筑 ${pushed.length} 处（最近 ${clock(last.t)} ${formatObjectiveLabel({ type: 'building_kill', key: last.key, team: last.teamNum }, lang)}）`
        : `took ${pushed.length} enemy structure${pushed.length > 1 ? 's' : ''} (latest ${clock(last.t)}: ${formatObjectiveLabel({ type: 'building_kill', key: last.key, team: last.teamNum }, lang)})`);
    }
    if (lost.length) {
      const last = lost[lost.length - 1];
      bits.push(zh
        ? `失去己方建筑 ${lost.length} 处（最近 ${clock(last.t)} ${formatObjectiveLabel({ type: 'building_kill', key: last.key, team: last.teamNum }, lang)}）`
        : `lost ${lost.length} structure${lost.length > 1 ? 's' : ''} (latest ${clock(last.t)}: ${formatObjectiveLabel({ type: 'building_kill', key: last.key, team: last.teamNum }, lang)})`);
    }
    const denied = objs.filter(o => killerSideOf(o.team) && ownerSideOf(o.key) === killerSideOf(o.team));
    if (denied.length) {
      const last = denied[denied.length - 1];
      bits.push(zh
        ? `出现自拆 ${denied.length} 处（${clock(last.t)} ${formatObjectiveLabel({ type: 'building_kill', key: last.key, team: last.teamNum }, lang)}，属于同阵营拆建筑）`
        : `${denied.length} own-side demolition${denied.length > 1 ? 's' : ''} (${clock(last.t)}: ${formatObjectiveLabel({ type: 'building_kill', key: last.key, team: last.teamNum }, lang)}; a structure removed by its own team)`);
    }
    if (startAdv != null && endAdv != null) {
      bits.push(zh
        ? `${useGold ? '赚金优势' : '净资产优势'}从 ${fmtSigned(startAdv)} 到 ${fmtSigned(endAdv)}${useGold ? '' : '（60 秒桶，不是赚金）'}`
        : `${useGold ? 'earned-gold' : 'net-worth'} advantage went from ${fmtSigned(startAdv)} to ${fmtSigned(endAdv)}${useGold ? '' : ' (60 s buckets, not earned gold)'}`);
    }
    if (phase.key === 'laning' && Number.isFinite(facts.lh_at_10?.value)) {
      bits.push(zh ? `10 分钟补刀 ${facts.lh_at_10.value}` : `${facts.lh_at_10.value} last hits at 10:00`);
    }
    phaseLines.push(zh
      ? `${phaseLabel[phase.key]}（${clock(phase.from)}–${clock(phase.to)}）：${bits.join('；')}。`
      : `${phaseLabel[phase.key]} (${clock(phase.from)}–${clock(phase.to)}): ${bits.join('; ')}.`);
  }
  // Result line leads the overview; scoreboard K/D/A is labeled as scoreboard.
  const introBits = [];
  const winnerSide = raw.radiant_win === true ? 'radiant' : raw.radiant_win === false ? 'dire' : null;
  if (winnerSide) introBits.push(zh
    ? `本局 ${sideName(winnerSide === 'radiant' ? 2 : 3, true)}获胜，时长 ${clock(horizon)}`
    : `${sideName(winnerSide === 'radiant' ? 2 : 3, false)} won in ${clock(horizon)}`);
  else if (horizon) introBits.push(zh ? `本局时长 ${clock(horizon)}` : `Match length ${clock(horizon)}`);
  if (focusKey) introBits.push(zh ? `以${focusLabel}视角复盘` : `reviewed from the ${focusLabel} perspective`);
  if (Number.isFinite(focus.kills) && Number.isFinite(focus.deaths)) {
    // The scoreboard line is OpenDota-sourced, so it keeps citation s1 even on
    // the replay path; the replay upgrade loop never sees facts created here.
    const kdaId = 'scoreboard.kda';
    if (!facts[kdaId]) addFact({
      id: kdaId, kind: 'entity', perspective: 'player_team',
      value: { kills: focus.kills, deaths: focus.deaths, ...(Number.isFinite(focus.assists) ? { assists: focus.assists } : {}) },
      display: {
        en: `Scoreboard K/D ${focus.kills}/${focus.deaths}${Number.isFinite(focus.assists) ? `, ${focus.assists} assists` : ''}`,
        zh: `记分板 K/D ${focus.kills}/${focus.deaths}${Number.isFinite(focus.assists) ? `，助攻 ${focus.assists}` : ''}`,
      },
      citation: 's1', source_path: 'scoreboard.kills_deaths_assists',
    });
    if (facts[kdaId]) phaseFactIds.push(kdaId);
    introBits.push(zh
      ? `记分板 K/D ${focus.kills}/${focus.deaths}${Number.isFinite(focus.assists) ? `，助攻 ${focus.assists}（记分板口径）` : ''}`
      : `scoreboard K/D ${focus.kills}/${focus.deaths}${Number.isFinite(focus.assists) ? `, ${focus.assists} assists (scoreboard)` : ''}`);
  }
  const fortFall = numberedObjectives.find(o => typeof o.key === 'string' && o.key.endsWith('_fort') && Number.isFinite(o.t));
  const resultLine = fortFall && fortFall.fact_id && facts[fortFall.fact_id]
    ? zh
      ? `${clock(fortFall.t)} ${formatObjectiveLabel({ type: 'building_kill', key: fortFall.key, team: fortFall.teamNum }, lang)}，对局结束。`
      : `At ${clock(fortFall.t)}: ${formatObjectiveLabel({ type: 'building_kill', key: fortFall.key, team: fortFall.teamNum }, lang)}; the match ended there.`
    : (zh ? '本局未见可核实的基地摧毁事件。' : 'No verifiable Ancient destruction event was recorded.');
  if (fortFall?.fact_id && facts[fortFall.fact_id]) phaseFactIds.push(fortFall.fact_id);
  const overviewIds = [...new Set(phaseFactIds)];
  const overviewText = zh
    ? `${introBits.join('；')}。${resultLine}${phaseLines.join('')}`
    : `${introBits.join('; ')}. ${resultLine} ${phaseLines.join(' ')}`;
  const overview = {
    id: 'review_overview', kind: 'review_overview', status: 'ok', title: zh ? '对局主线' : 'Match main line',
    time: { from: overviewIds.length ? Math.min(...overviewIds.map(id => facts[id].t ?? facts[id].value?.t ?? 0)) : 0, to: horizon },
    claim: { text: overviewText, slots: overviewText, phrasing: 'template' },
    fact_ids: overviewIds, metrics: [],
    evidence: { kind: 'mainline', highlight: [0, horizon / 60], markers: overviewIds, moments: [] },
    baseline: null, target: null, citations: ['r1'], data_gap: windowsShort ? 'mainline_windows_fewer_than_three' : null,
    prompt: zh ? '对局主线：哪个阶段的信息最薄弱？' : 'Match main line: which phase has the weakest information?',
  };

  // ---- decision windows ---------------------------------------------------
  const windows = [];
  for (const [index, cand] of finalPicked.entries()) {
    const n = index + 1;
    const from = cand.from;
    const to = Math.min(cand.to, Math.ceil(horizon ?? cand.to));
    const ids = [];
    const actions = [];
    const windowDeaths = deaths.filter(d => d.t >= from && d.t <= to);
    const windowKills = focusKills.filter(k => k.t >= from && k.t <= to);
    const windowObjs = numberedObjectives.filter(o => Number.isFinite(o.t) && o.t >= from && o.t <= to);
    const windowBkb = linkedBkbUses.filter(u => u.t >= from && u.t <= to);
    const windowTakes = takesBetween(from, to);
    const windowLosses = lossesBetween(from, to);
    const windowDenies = windowObjs.filter(o => {
      const owner = ownerSideOf(o.key);
      return owner && killerSideOf(o.team) === owner;
    });
    const pushAction = (t, text) => actions.push({ t, text });
    for (const d of windowDeaths) {
      if (d.fact_id && facts[d.fact_id]) ids.push(d.fact_id);
      const killerLabel = d.killer ? evidenceName(d.killer, lang) : (zh ? '未知单位' : 'an unknown unit');
      const inflictorLabel = d.inflictor ? knownName(d.inflictor, lang) : null;
      const inflictorPart = inflictorLabel ? (zh ? `以${inflictorLabel}击杀` : ` with ${inflictorLabel}`) : (zh ? '击杀' : '');
      pushAction(d.t, zh
        ? `${clock(d.t)} 你被${killerLabel}${inflictorPart}`
        : `${clock(d.t)} you were killed by ${killerLabel}${inflictorPart}`);
    }
    for (const k of windowKills) {
      const id = `kill.win.${n}.${k.t}`;
      if (!facts[id] && evidenceName(k.key, lang)) {
        addFact({
          id, kind: 'entity', value: { t: k.t, key: k.key }, t: k.t, perspective: 'player_team',
          display: { en: `A kill on ${evidenceName(k.key, 'en')} was recorded at ${clock(k.t)}`, zh: `${clock(k.t)} 对 ${evidenceName(k.key, 'zh')} 有击杀记录` },
          citation: 'r1', source_path: Array.isArray(k.source_path) ? k.source_path.join('; ') : k.source_path ?? 'players[].kills_log',
        });
      }
      if (facts[id]) {
        ids.push(id);
        pushAction(k.t, zh ? `${clock(k.t)} 对 ${evidenceName(k.key, lang)} 有击杀记录` : `${clock(k.t)}: a kill on ${evidenceName(k.key, lang)} was recorded`);
      }
    }
    for (const o of windowObjs) {
      if (o.fact_id && facts[o.fact_id]) {
        ids.push(o.fact_id);
        // Same-side demolitions are labeled as such: they are never a take.
        const denySuffix = windowDenies.includes(o)
          ? (zh ? '（同阵营拆建筑，不计为推进）' : ' (demolished by its own side; not counted as a push)')
          : '';
        pushAction(o.t, `${clock(o.t)} ${formatObjectiveLabel({ type: 'building_kill', key: o.key, team: o.teamNum }, lang)}${denySuffix}`);
      }
    }
    // Linked cast/kill facts that buildMoments attached to these deaths and
    // BKB uses stay reachable from the window (raw events behind the expand).
    for (const d of windowDeaths) {
      const idx = result.deaths.indexOf(d) + 1;
      for (const id of Object.keys(facts)) if (id.startsWith(`cast.death.${idx}.`) || id.startsWith(`kill.death.${idx}.`)) ids.push(id);
    }
    for (const u of windowBkb) {
      for (const id of Object.keys(facts)) if (id.startsWith(`cast.bkb.${u.idx}.`)) ids.push(id);
      const use = facts[u.bkbId];
      if (use) {
        ids.push(use.id);
        pushAction(u.t, zh ? `${clock(u.t)}–${clock(u.ended_at)} 黑皇杖使用（记录区间）` : `${clock(u.t)}–${clock(u.ended_at)} Black King Bar use (recorded interval)`);
      }
    }
    const startAdv = advForTeam(from, focusTeam);
    const endAdv = advForTeam(to, focusTeam);
    const advA = advFact(Math.floor(from / 60)); if (advA) ids.push(advA);
    const advB = advFact(Math.max(0, Math.floor(to / 60))); if (advB && advB !== advA) ids.push(advB);
    // Then-known hero state: level from snapshots; HP/mana/position only where
    // a hero_states sample is nearby. Purchase lists stay in the appendix —
    // the window body never enumerates what was bought.
    const snap = snapshotNearest(from);
    const knownBits = [];
    const takesSoFar = takes.filter(o => o.t <= to).length;
    const takesBeforeWindow = takes.filter(o => o.t < from).length;
    if (startAdv != null) {
      knownBits.push(zh
        ? `本方${useGold ? '赚金优势' : '净资产优势'}约 ${fmtSigned(startAdv)}${useGold ? '' : '（60 秒桶，不是赚金）'}`
        : `your team's ${useGold ? 'earned-gold' : 'net-worth'} advantage was about ${fmtSigned(startAdv)}${useGold ? '' : ' (60 s bucket, not earned gold)'}`);
    }
    // Known structure counts cut strictly at the window start — the printed
    // clock is the actual decision-time cutoff, never the next whole minute.
    const pushedFact = towersFact(from, 'pushed');
    const lostFact = towersFact(from, 'lost');
    if (pushedFact) { ids.push(pushedFact); knownBits.push(zh ? `${clock(from)} 前我方摧毁对方建筑 ${facts[pushedFact].value} 处` : `before ${clock(from)} your team had taken ${facts[pushedFact].value} enemy structure${facts[pushedFact].value === 1 ? '' : 's'}`); }
    if (lostFact) { ids.push(lostFact); knownBits.push(zh ? `${clock(from)} 前我方失去建筑 ${facts[lostFact].value} 处` : `before ${clock(from)} your team had lost ${facts[lostFact].value} structure${facts[lostFact].value === 1 ? '' : 's'}`); }
    if (snap && Number.isInteger(snap.snap.level)) {
      const id = `state.snapshot.win.${n}`;
      if (!facts[id]) addFact({
        id, kind: 'scalar', value: snap.snap.level, unit: 'level', t: snap.snap.t, perspective: 'player_team',
        display: { en: `Level ${snap.snap.level} at the ${clock(snap.snap.t)} inventory snapshot`, zh: `${clock(snap.snap.t)} 装备快照时等级 ${snap.snap.level}` },
        citation: 'r1', source_path: `${focus.metadata_source_path ?? 'players[]'}.inventory_snapshots[game_time=${snap.snap.t}]`,
        derivation: `nearest snapshot to ${clock(from)} (within ${SNAPSHOT_TOL_S} s); approximately 30 s snapshot cadence`,
      });
      if (facts[id]) { ids.push(id); knownBits.push(zh ? `约 ${clock(from)} 时等级 ${snap.snap.level}（装备快照）` : `level ${snap.snap.level} near ${clock(from)} (inventory snapshot)`); }
    }
    const focusState = stateNear(slugOfKey(heroSlug(focus.hero_id)), from, STATE_WINDOW_START_TOL_S);
    if (focusState) {
      const id = `state.win.${n}.${slugOfKey(heroSlug(focus.hero_id))}`;
      const s = focusState.s;
      if (!facts[id]) {
        const hpPct = pctOf(s.hp, s.max_hp);
        const manaPct = pctOf(s.mana, s.max_mana);
        addFact({
          id, kind: 'entity', value: { ...s, sample_basis: `nearest hero_states sample to ${clock(from)} within ±${STATE_WINDOW_START_TOL_S} s` }, t: s.t, perspective: 'player_team',
          display: {
            en: `${clock(s.t)} state sample: HP ${Number.isFinite(s.hp) ? s.hp : '?'}${Number.isFinite(s.max_hp) ? `/${s.max_hp}${hpPct != null ? ` (${hpPct}%)` : ''}` : ''}, mana ${Number.isFinite(s.mana) ? s.mana : '?'}${Number.isFinite(s.max_mana) ? `/${s.max_mana}${manaPct != null ? ` (${manaPct}%)` : ''}` : ''}${Number.isInteger(s.level) ? `, level ${s.level}` : ''}`,
            zh: `${clock(s.t)} 状态样本：HP ${Number.isFinite(s.hp) ? s.hp : '?'}${Number.isFinite(s.max_hp) ? `/${s.max_hp}${hpPct != null ? `（${hpPct}%）` : ''}` : ''}，魔法 ${Number.isFinite(s.mana) ? s.mana : '?'}${Number.isFinite(s.max_mana) ? `/${s.max_mana}${manaPct != null ? `（${manaPct}%）` : ''}` : ''}${Number.isInteger(s.level) ? `，等级 ${s.level}` : ''}`,
          },
          citation: 'r1', source_path: `hero_states.samples`, derivation: heroStates?.sampling,
        });
      }
      if (facts[id]) {
        ids.push(id);
        const s2 = facts[id].value;
        const hpPct = pctOf(s2.hp, s2.max_hp);
        const manaPct = pctOf(s2.mana, s2.max_mana);
        knownBits.push(zh
          ? `约 ${clock(from)} 自身状态：HP ${hpPct != null ? `${hpPct}%` : '未知'}、魔法 ${manaPct != null ? `${manaPct}%` : '未知'}、等级 ${Number.isInteger(s2.level) ? s2.level : '未知'}（状态样本 ${clock(s2.t)}）`
          : `near ${clock(from)}: your own state was HP ${hpPct != null ? `${hpPct}%` : 'unknown'}, mana ${manaPct != null ? `${manaPct}%` : 'unknown'}, level ${Number.isInteger(s2.level) ? s2.level : 'unknown'} (sample at ${clock(s2.t)})`);
      }
    }
    const firstDeath = windowDeaths[0];
    const killerState = firstDeath?.killer ? stateNear(slugOfKey(firstDeath.killer), firstDeath.t, STATE_ANCHOR_TOL_S) : null;
    if (killerState) {
      const killerSlug = slugOfKey(firstDeath.killer);
      const id = `state.win.${n}.${killerSlug}.at_death`;
      const s = killerState.s;
      if (!facts[id]) addFact({
        id, kind: 'entity', value: { ...s, sample_basis: `nearest hero_states sample to ${clock(firstDeath.t)} within ±${STATE_ANCHOR_TOL_S} s` }, t: s.t, perspective: 'player_team',
        display: {
          en: `${clock(s.t)} ${evidenceName(firstDeath.killer, 'en')} state sample: level ${Number.isInteger(s.level) ? s.level : '?'}`,
          zh: `${clock(s.t)} ${evidenceName(firstDeath.killer, 'zh')}状态样本：等级 ${Number.isInteger(s.level) ? s.level : '?'}`,
        },
        citation: 'r1', source_path: `hero_states.samples`, derivation: heroStates?.sampling,
      });
      if (facts[id]) ids.push(id);
    }
    const missingBits = [];
    if (!heroStates) missingBits.push(zh
      ? '本局没有英雄状态样本，该时刻的 HP、魔法与站位不可核实（其余数据缺口见下方汇总）。'
      : 'No hero-state samples exist for this match; HP, mana and positions at this moment cannot be verified (remaining gaps are consolidated below).');
    else if (!focusState && !killerState) missingBits.push(zh
      ? '状态样本未覆盖该锚点附近时点，无法核实当时 HP/魔法。'
      : 'No state sample covers this anchor; HP/mana at that moment cannot be verified.');
    if (startAdv == null) missingBits.push(zh
      ? '该时刻没有可用的优势序列桶（序列缺失或被截断）。'
      : 'No advantage-series bucket covers this moment (series missing or truncated).');
    else if (endAdv == null) missingBits.push(zh
      ? '优势序列在窗口结束前被截断（60 秒桶，不是赚金），窗口结束时的差值无法给出。'
      : 'The advantage series truncates before this window ends (60 s buckets, not earned gold); no end-of-window value can be given.');
    actions.sort((a, b) => a.t - b.t);
    // Structure counts for this frame, as citable facts (a zero is a value).
    const structCountFact = (id, list, zhLabel, enLabel) => {
      if (facts[id]) return id;
      const anchorT = list.length ? list[list.length - 1].t : to;
      return addFact({
        id, kind: 'count', value: list.length, unit: 'structures', t: anchorT, perspective: 'player_team',
        display: {
          en: `${enLabel} ${clock(from)}–${clock(to)}: ${list.length}`,
          zh: `${clock(from)}–${clock(to)} 内${zhLabel}：${list.length} 处`,
        },
        citation: 'r1', source_path: 'objectives',
        derivation: 'counts DOTA_COMBATLOG_TEAM_BUILDING_KILL events; same-side demolitions excluded',
      });
    };
    const takesId = structCountFact(`takes.win.${n}`, windowTakes, '我方摧毁敌方建筑', 'enemy structures taken by your team');
    const lostId = structCountFact(`lost.win.${n}`, windowLosses, '我方失去建筑', 'your structures lost');
    ids.push(takesId, lostId);
    // Pattern-specific known context: the post-item anchor, and what an empty
    // focus kill log does and does not say (empty never means absent from
    // fights — teammates keep records). Completions may anchor or extend a
    // frame, but no item list enters the window body — purchases live in the
    // appendix.
    if (cand.kind === 'post_item_objectives') {
      ids.push(itemDoneFact(cand.item));
      knownBits.push(zh
        ? `窗口起点为装备事件：${clock(cand.item.time)} ${itemName(cand.item.key, lang)}合成完毕`
        : `the window opens on an item event: ${itemName(cand.item.key, lang)} completed at ${clock(cand.item.time)}`);
    }
    if (cand.kind === 'bkb_vs_structures' && facts['item.first.black_king_bar']) {
      ids.push('item.first.black_king_bar');
    }
    const firstKillInWindow = windowKills[0];
    if (firstKillInWindow && firstKillInWindow.t - from >= KILL_LOG_GAP_NOTE_S) {
      const mates = players.filter(p => p !== focus && Number.isInteger(p.player_slot)
        && (p.player_slot < 128) === (focus.player_slot < 128));
      const mateKills = mates.flatMap(p => (p.kills_log ?? []).map(k => ({ ...k, t: eventTime(k) })))
        .filter(k => Number.isFinite(k.t) && k.t >= from && k.t <= to && k.key);
      const mateSmokes = mates.flatMap(p => (p.item_use_log ?? []).filter(u => u.key === 'smoke_of_deceit' && Number.isFinite(u.t) && u.t >= from && u.t <= to));
      const mateKillsId = facts[`team.kills.win.${n}`] ? `team.kills.win.${n}` : addFact({
        id: `team.kills.win.${n}`, kind: 'count', value: mateKills.length, unit: 'kills', t: mateKills.length ? Math.max(...mateKills.map(k => k.t)) : to,
        perspective: 'player_team',
        display: { en: `teammate kill records ${clock(from)}–${clock(to)}: ${mateKills.length}`, zh: `${clock(from)}–${clock(to)} 内队友击杀记录：${mateKills.length} 次` },
        citation: 'r1', source_path: 'players[].kills_log', derivation: 'kills_log of same-side players other than the focus',
      });
      const smokesId = facts[`team.smoke.win.${n}`] ? `team.smoke.win.${n}` : addFact({
        id: `team.smoke.win.${n}`, kind: 'count', value: mateSmokes.length, unit: 'uses', t: mateSmokes.length ? Math.max(...mateSmokes.map(u => u.t)) : to,
        perspective: 'player_team',
        display: { en: `teammate smoke uses ${clock(from)}–${clock(to)}: ${mateSmokes.length}`, zh: `${clock(from)}–${clock(to)} 内队友使用雾：${mateSmokes.length} 次` },
        citation: 'r1', source_path: 'players[].item_use_log', derivation: 'smoke_of_deceit entries of same-side players other than the focus',
      });
      ids.push(mateKillsId, smokesId);
      missingBits.push(zh
        ? `${clock(from)} 至 ${clock(firstKillInWindow.t)} 之间你的击杀日志为空；空日志不说明当时是否在战斗（同期队友有击杀记录 ${mateKills.length} 次、使用雾 ${mateSmokes.length} 次，无站位数据可核对你在场位置）。`
        : `your kill log is empty between ${clock(from)} and ${clock(firstKillInWindow.t)}; an empty log does not show whether you were fighting (teammates recorded ${mateKills.length} kills and ${mateSmokes.length} smoke uses in the same span; no position data can place you there).`);
    }
    // Comparable: recorded contrasts only — never a directive, never an
    // invented alternative. When no contrast exists the section is omitted.
    const comparableBits = [];
    const denyNote = windowDenies.length
      ? (zh
        ? `；${windowDenies.slice(0, 2).map(o => zh ? `${clock(o.t)} ${formatBuildingName(o.key, lang)}由${sideName(o.teamNum, true)}自己拆除` : `${formatBuildingName(o.key, lang)} at ${clock(o.t)} was demolished by ${sideName(o.teamNum, false)} itself`).join(zh ? '、' : ', ')}${zh ? '，不计为我方推进' : `, not counted as your team's push`}`
        : `; ${windowDenies.slice(0, 2).map(o => `${formatBuildingName(o.key, lang)} at ${clock(o.t)} was demolished by ${sideName(o.teamNum, false)} itself`).join(', ')}, not counted as your team's push`)
      : '';
    if (cand.kind === 'kills_no_conversion') {
      // The theme is "no NEW conversion in this stretch": eligibility checked
      // in-window takes, so the copy asserts the same interval. A take before
      // the window exists as recorded context — a whole-match cumulative zero
      // would contradict it.
      const priorTakes = takesBeforeWindow
        ? (zh ? `（窗口开始前全场已推进 ${takesBeforeWindow} 处）` : ` (${takesBeforeWindow} taken earlier in the match)`)
        : '';
      comparableBits.push(zh
        ? `记录对照：窗口内你的击杀记录 ${windowKills.length} 次；本窗口内我方没有新增摧毁敌方建筑${priorTakes}${denyNote}。这是记录对照，不是路线判定；其余路线没有字段支持，不评。`
        : `Recorded contrast: ${windowKills.length} kills of yours in this window, while your team took no new enemy structure inside it${priorTakes}${denyNote}. This is a recorded contrast, not a verdict; no field supports judging a different route.`);
    } else if (cand.kind === 'post_item_objectives') {
      const firstTake = windowTakes[0];
      const dirNote = startAdv != null && endAdv != null
        ? (zh ? `；同期${useGold ? '赚金优势' : '净资产优势'}从 ${fmtSigned(startAdv)} 到 ${fmtSigned(endAdv)}${useGold ? '' : '（60 秒桶口径，不是赚金，桶也不是事件时点）'}` : `; the ${useGold ? 'earned-gold' : 'net-worth'} advantage moved from ${fmtSigned(startAdv)} to ${fmtSigned(endAdv)}${useGold ? '' : ' (60 s buckets, not earned gold; a bucket is not an event time)'}`)
        : '';
      comparableBits.push(zh
        ? `记录对照：${itemName(cand.item.key, lang)} ${clock(cand.item.time)} 合成后${firstTake ? `，我方第一处敌方建筑到 ${clock(firstTake.t)} 才出现` : '，窗口内没有出现我方摧掉的敌方建筑'}；同期我方失去建筑 ${windowLosses.length} 处${dirNote}。方向记录不构成对中期选择的判定；输掉比赛本身不是中期决策有误的证据。`
        : `Recorded contrast: after ${itemName(cand.item.key, 'en')} completed at ${clock(cand.item.time)}${firstTake ? `, your team's first enemy structure only appeared at ${clock(firstTake.t)}` : ', no enemy structure taken by your team appears in this window'}; your team lost ${windowLosses.length} structure${windowLosses.length === 1 ? '' : 's'} in the same span${dirNote}. A direction on record is not a verdict on the mid-game choices; losing the match is not evidence those choices were wrong.`);
    } else if (cand.kind === 'bkb_vs_structures') {
      comparableBits.push(zh
        ? `记录对照：黑皇杖 ${clock(facts['item.first.black_king_bar'].value)} 购入，${clock(cand.use.t)}–${clock(cand.use.ended_at)} 有使用记录；同一窗口内我方失去建筑 ${windowLosses.length} 处。使用与失塔只有时间并列关系；开启位置与时机是否有更优解，没有站位与冷却数据可判。`
        : `Recorded contrast: Black King Bar purchased at ${clock(facts['item.first.black_king_bar'].value)}, a use recorded ${clock(cand.use.t)}–${clock(cand.use.ended_at)}, while your team lost ${windowLosses.length} structure${windowLosses.length === 1 ? '' : 's'} inside the same window. The use and the losses are only adjacent in time; without position or cooldown data, no better placement or timing can be judged.`);
    } else if (cand.kind === 'objective_stretch') {
      const fortLoss = windowObjs.some(o => typeof o.key === 'string' && o.key.endsWith('_fort') && isLoss(o));
      const maxTier = takes.reduce((tier, o) => {
        const key = String(o.key);
        const t = key.includes('fort') ? 5 : key.includes('rax') || key.includes('tower3') ? 4 : key.includes('tower2') ? 3 : 2;
        return Math.max(tier, t);
      }, 0);
      if (windowTakes.length && windowLosses.length) {
        comparableBits.push(zh
          ? `记录对照：窗口内我方摧毁敌方建筑 ${windowTakes.length} 处、失去己方建筑 ${windowLosses.length} 处${windowKills.length ? `；你的击杀记录 ${windowKills.length} 次与建筑得失同期出现` : ''}。这是同期记录，不判定攻守取舍。`
          : `Recorded contrast: your team took ${windowTakes.length} enemy structure${windowTakes.length === 1 ? '' : 's'} and lost ${windowLosses.length} in this window${windowKills.length ? `; ${windowKills.length} kill${windowKills.length > 1 ? 's' : ''} of yours appear in the same span` : ''}. Same-span records; no attack-or-defend verdict is drawn.`);
      } else if (windowTakes.length && windowKills.length) {
        comparableBits.push(zh
          ? `记录对照：你的击杀记录 ${windowKills.length} 次与 ${windowTakes.length} 处推进同期出现。个人动作与团队目标的关系没有站位数据可核对。`
          : `Recorded contrast: ${windowKills.length} kills of yours appear alongside ${windowTakes.length} structure take${windowTakes.length === 1 ? '' : 's'}. No position data can tie the individual actions to the objectives.`);
      } else if (!windowTakes.length && !takesSoFar && windowLosses.length) {
        comparableBits.push(zh
          ? `记录对照：窗口内我方失去建筑 ${windowLosses.length} 处；到 ${clock(to)} 为止，全场记录中我方摧毁的敌方建筑为 0 处。同期记录不判定攻守取舍。`
          : `Recorded contrast: your team lost ${windowLosses.length} structure${windowLosses.length === 1 ? '' : 's'} in this window; through ${clock(to)} your team had taken 0 enemy structures in the whole match. Same-span records; no attack-or-defend verdict is drawn.`);
      }
      if (fortLoss && maxTier && maxTier <= 3) {
        comparableBits.push(zh
          ? `全场记录中我方摧掉的敌方建筑最高只到${maxTier === 3 ? '二塔' : '一塔'}；对方高地及以上建筑在本记录里未被打开。`
          : `Across the whole match your team's takes never rose above ${maxTier === 3 ? 'T2' : 'T1'} towers; the enemy high ground was never opened in this record.`);
      }
    }
    const sections = [];
    if (knownBits.length) sections.push({ label_key: 'known', text: `${knownBits.join(zh ? '；' : '; ')}${zh ? '。' : '.'}` });
    if (actions.length) sections.push({ label_key: 'actions', text: `${actions.map(a => a.text).join(zh ? '；随后 ' : '; then ')}${zh ? '。' : '.'}` });
    if (comparableBits.length) sections.push({ label_key: 'comparable', text: comparableBits.join(zh ? '' : ' ') });
    if (missingBits.length) sections.push({ label_key: 'missing', text: missingBits.join(zh ? '' : ' ') });
    // The evaluation layer exists only for a decision judgment the fields
    // support. These frames carry ordered events and recorded contrasts; a
    // restated 60 s bucket delta would be evaluation-shaped filler, so the
    // section is omitted rather than approximated.
    const claimBits = actions.map(a => a.text);
    if (cand.kind === 'kills_no_conversion') {
      // Same interval the eligibility check used: zero takes inside this
      // window, never a cumulative whole-match zero.
      claimBits.push(zh
        ? `本窗口内我方没有新增摧毁敌方建筑${denyNote}`
        : `your team took no new enemy structure inside this window${denyNote}`);
    }
    const claimText = claimBits.length
      ? `${claimBits.join(zh ? '；' : '; ')}${zh ? '。' : '.'}`
      : (zh ? `窗口 ${clock(cand.anchor)} 附近没有可核实的动作证据。` : `No verifiable action evidence around ${clock(cand.anchor)}.`);
    const dedupedIds = [...new Set(ids)].filter(id => facts[id]);
    const theme = windowTheme(cand, { zh, lang, windowTakes, windowLosses, windowObjs, takesSoFar, focusTeam });
    // The title span is the analytic frame (time.from/to), so the header and
    // the time chip always agree; the anchor clock stays in the prompt.
    const title = zh
      ? `决策窗口 ${n}（${clock(from)}–${clock(to)}）：${theme}`
      : `Decision window ${n} (${clock(from)}–${clock(to)}): ${theme}`;
    windows.push({
      id: `window.${n}`, kind: 'review_window', status: 'ok', title,
      // time is the analytic frame of the window; every event clock inside the
      // copy is carried by a cited fact.
      time: { from, to },
      claim: { text: claimText, slots: claimText, phrasing: 'template' },
      sections, fact_ids: dedupedIds, metrics: [],
      evidence: { kind: 'mainline_window', highlight: [from / 60, to / 60], markers: dedupedIds, moments: [] },
      baseline: null, target: null, citations: ['r1'], data_gap: missingBits.length ? 'window_decisive_evidence_missing' : null,
      prompt: zh ? `${clock(cand.anchor)} 前后：当时有哪些有依据的可比选择？` : `Around ${clock(cand.anchor)}: which comparable options had grounds at the time?`,
    });
  }

  // ---- practice goals (proven only with hero states) ----------------------
  const practice = buildPractice({ zh, facts, addFact, windows, heroStates, focusSlug: slugOfKey(heroSlug(focus.hero_id)), stateNear });

  return { insights: [overview, ...windows], practice, windowsShort };
}

/**
 * Conversion/objective theme naming for a candidate. The theme is always the
 * resource/objective line — kills vs objectives, the post-item line, an item
 * timing against structure losses, or the take/loss stretch itself. Deaths are
 * execution evidence inside the frame and never name the window.
 */
function windowTheme(cand, { zh, lang, windowTakes, windowLosses, windowObjs, takesSoFar, focusTeam }) {
  if (cand.kind === 'kills_no_conversion') return zh ? '击杀未转化为地图目标' : 'kills without map conversion';
  if (cand.kind === 'post_item_objectives') {
    const item = itemName(cand.item.key, lang);
    return zh ? `${item}之后的资源与目标线` : `resource and objective line after ${item}`;
  }
  if (cand.kind === 'bkb_vs_structures') return zh ? '黑皇杖首次使用与己方建筑失守' : 'first Black King Bar use amid your structures falling';
  const fort = windowObjs.find(o => typeof o.key === 'string' && o.key.endsWith('_fort'));
  if (fort) {
    const taken = killerSideOf(fort.team) === focusTeam;
    return taken
      ? (zh ? '高地攻坚至基地被破' : 'the high ground push through the Ancient')
      : (zh ? '高地失守至基地被破' : 'high ground lost through the Ancient');
  }
  const highGround = windowLosses.some(o => /tower[3-4]|rax/.test(String(o.key)));
  if (highGround) {
    return windowTakes.length
      ? (zh ? '高地失守与外塔反推同期' : 'your high ground falling amid a counter-take')
      : (zh ? '己方高地失守' : 'your high ground falling');
  }
  if (windowTakes.length && windowLosses.length) return zh ? '外塔攻防同期' : 'outer towers taken and lost';
  if (windowTakes.length) return zh ? '推掉敌方外塔' : 'enemy outer towers taken';
  if (!takesSoFar) {
    return highGround || /tower2/.test(windowLosses.map(o => String(o.key)).join())
      ? (zh ? '二塔及以上失守，仍无反推' : 'T2+ towers lost with no counter-take recorded')
      : (zh ? '外塔连续失守，仍无反推' : 'outer towers lost with no counter-take recorded');
  }
  return highGround
    ? (zh ? '己方高地失守' : 'your high ground falling')
    : (zh ? '己方塔连续失守' : 'your towers falling');
}

/**
 * Practice goals must be process-checkable with their observed conditions.
 * Without reusable hero-state samples nothing here is provable — including the
 * BKB checklist, which purchase logs alone cannot ground — so the payload
 * says so once instead of emitting generic advice. Low-mana evidence must sit
 * at the death/fight anchor: a sample at a long window's start says nothing
 * about mana minutes later at the fight.
 */
function buildPractice({ zh, facts, addFact, windows, heroStates, focusSlug, stateNear }) {
  if (!heroStates) {
    return {
      status: 'insufficient', items: [],
      note: zh
        ? '本局证据不足，无法给出可验证的练习目标：缺少可复用的状态样本或重复出现的有依据模式。'
        : 'Insufficient evidence in this match for a verifiable practice goal: no reusable state samples or a recurring grounded pattern.',
    };
  }
  const items = [];
  // Focus state nearest each promoted death in the window, within one
  // sampling-cadence step of that death — the fight anchor, never window start.
  const deathStatesOf = w => (w.fact_ids ?? [])
    .filter(id => /^death\.\d+$/.test(id) && Number.isFinite(facts[id]?.t))
    .map(id => {
      const near = stateNear(focusSlug, facts[id].t, DEATH_STATE_TOL_S);
      return near ? { deathId: id, deathT: facts[id].t, s: near.s } : null;
    })
    .filter(Boolean);
  // Evidence identity is the death (with the sample it anchors), never the
  // window: two partially overlapping windows that contain the same death —
  // or two deaths anchored to the one sample — are one observation, not a
  // repeated pattern.
  const uniqueByDeath = hits => {
    const seenDeaths = new Set();
    const seenSamples = new Set();
    const unique = [];
    for (const hit of hits) {
      if (seenDeaths.has(hit.deathId) || seenSamples.has(hit.s.t)) continue;
      seenDeaths.add(hit.deathId);
      seenSamples.add(hit.s.t);
      unique.push(hit);
    }
    return unique;
  };
  const lowMana = uniqueByDeath(windows.flatMap(w => {
    const hit = deathStatesOf(w).find(({ s }) => {
      const pct = pctOf(s.mana, s.max_mana);
      return pct != null && pct < 50;
    });
    return hit ? [hit] : [];
  }));
  if (lowMana.length >= 2) {
    const cited = lowMana.map(({ deathId, deathT, s }) => {
      const id = `state.${deathId}.${focusSlug}`;
      const manaPct = pctOf(s.mana, s.max_mana);
      if (!facts[id]) addFact({
        id, kind: 'entity', value: { ...s, sample_basis: `nearest hero_states sample to ${clock(deathT)} within ±${DEATH_STATE_TOL_S} s` }, t: s.t, perspective: 'player_team',
        display: {
          en: `${clock(s.t)} state sample next to the ${clock(deathT)} death: mana ${Number.isFinite(s.mana) ? s.mana : '?'}${Number.isFinite(s.max_mana) ? `/${s.max_mana}` : ''}${manaPct != null ? ` (${manaPct}%)` : ''}`,
          zh: `${clock(s.t)} 状态样本（${clock(deathT)} 阵亡时点附近）：魔法 ${Number.isFinite(s.mana) ? s.mana : '?'}${Number.isFinite(s.max_mana) ? `/${s.max_mana}` : ''}${manaPct != null ? `（${manaPct}%）` : ''}`,
        },
        citation: 'r1', source_path: 'hero_states.samples', derivation: heroStates.sampling,
      });
      return { id, deathId, deathT, s, manaPct };
    });
    items.push({
      goal: zh ? '接团前把魔法值保持在 50% 以上并确认关键技能可用。' : 'Before committing to a fight, keep mana above 50% and confirm key abilities are ready.',
      condition: zh
        ? `本局 ${cited.map(({ s, deathT, manaPct }) => `${clock(s.t)} 魔法 ${manaPct}%（${clock(deathT)} 阵亡时点附近的状态样本）`).join('、')}。样本取自阵亡锚点附近，而非窗口起点（时序相关，非因果）。`
        : `In this match: ${cited.map(({ s, deathT, manaPct }) => `${clock(s.t)} mana ${manaPct}% (state sample next to the ${clock(deathT)} death)`).join(', ')}. Samples sit at the death anchors, not at window starts (temporal, not causal).`,
      fact_ids: cited.flatMap(({ id, deathId }) => [id, deathId]).slice(0, 8),
    });
  }
  // Pattern B: BKB owned but unused across several death windows; each window
  // must carry a state sample at one of its deaths so the checklist is tied to
  // observed fight conditions, not to purchase logs alone. The repeated
  // pattern is counted in independent anchored deaths — overlapping windows
  // that only share one death are a single fight, not a recurrence.
  const bkbFirst = facts['item.first.black_king_bar'];
  const bkbUnusedWins = windows.filter(w =>
    deathStatesOf(w).length
    && bkbFirst && Number.isFinite(bkbFirst.value) && bkbFirst.value <= w.time.from
    && !w.fact_ids.some(id => id.startsWith('use.bkb.')));
  const bkbDeaths = uniqueByDeath(bkbUnusedWins.flatMap(w => deathStatesOf(w)));
  if (bkbDeaths.length >= 2) {
    items.push({
      goal: zh ? '接团前检查黑皇杖是否可用，并把它纳入开团 checklist。' : 'Before committing, check whether Black King Bar is up and include it in the fight checklist.',
      condition: zh
        ? `黑皇杖于 ${clock(bkbFirst.value)} 购入；${bkbUnusedWins.map(w => w.title).join('、')} 均有阵亡记录（且阵亡时点附近有状态样本）、窗口内无使用记录（时序相关，非因果）。`
        : `Black King Bar was purchased at ${clock(bkbFirst.value)}; ${bkbUnusedWins.map(w => w.title).join(', ')} all contain recorded deaths with a state sample next to them and no in-window use (temporal, not causal).`,
      fact_ids: ['item.first.black_king_bar', ...bkbDeaths.map(h => h.deathId)].slice(0, 8),
    });
  }
  if (items.length) return { status: 'proven', items: items.slice(0, 2), note: null };
  return {
    status: 'insufficient', items: [],
    note: zh
      ? '本局证据不足，无法给出可验证的练习目标：缺少可复用的状态样本或重复出现的有依据模式。'
      : 'Insufficient evidence in this match for a verifiable practice goal: no reusable state samples or a recurring grounded pattern.',
  };
}
