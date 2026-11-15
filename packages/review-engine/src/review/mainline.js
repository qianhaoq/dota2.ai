/**
 * Whole-match main line + 3–5 bounded decision windows, generated from the
 * fact layer only. Layers stay separate: verified facts (known/actions),
 * evaluation (explicitly marked), and the missing-evidence list. No sentence
 * may assert causality (因此/所以/因为/led to): events are ordered, never
 * explained. A clock may only appear in copy when a cited fact carries it.
 */
import { evidenceName, itemName, clock } from '../insights/moments.js';
import { formatObjectiveLabel, formatBuildingName } from '../objectiveLabels.js';
import { STATIC_HEROES } from '../staticHeroes.js';
import { heroSlug, KEY_ITEMS } from '../facts/index.js';

export const MAINLINE_WINDOWS = { min: 3, max: 5 };
const LANING_END_S = 900;
const NW_SWING_MIN_GOLD = 1500;
const CONVERSION_AFTER_S = 240;
const MERGE_WITHIN_S = 180;
const STATE_WINDOW_START_TOL_S = 15;
const STATE_ANCHOR_TOL_S = 5;
const SNAPSHOT_TOL_S = 35;

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
  const eventTimes = [...objectives.map(o => o.t), ...result.deaths.map(d => d.t)].filter(Number.isFinite);
  const horizon = duration ?? (eventTimes.length ? Math.max(...eventTimes) : 0);
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
  /** Focus-team structure counts before minute m; deny = destroyed by its owner side. */
  const towersFact = (m, kind) => {
    const id = `towers.${kind}.before.${m}`;
    if (facts[id]) return id;
    let count = 0;
    const parts = [];
    for (const o of objectives) {
      if (!Number.isFinite(o.t) || o.t >= m * 60) continue;
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
      id, kind: 'count', value: count, unit: 'structures', t: m * 60, perspective: 'player_team',
      display: {
        en: `${{ pushed: 'Taken by your team', lost: 'Lost by your team', denied: 'Denied by your team' }[kind]} before ${clock(m * 60)}: ${count}`,
        zh: `${clock(m * 60)} 前${{ pushed: '我方摧毁', lost: '我方失去', denied: '我方自拆' }[kind]}：${count}`,
      },
      citation: 'r1', source_path: 'objectives',
      derivation: `deny = structure destroyed by its owner side; derived from ${parts.length} objective events`,
    });
  };

  // Labels want the numeric killer side; mapped objectives carry 'radiant'/'dire'.
  const objNum = o => ({ ...o, teamNum: killerSideOf(o.team) === 'radiant' ? 2 : killerSideOf(o.team) === 'dire' ? 3 : null });
  const numberedObjectives = objectives.map(objNum);
  const deathFactIds = new Set(result.deaths.map(d => d.fact_id));
  const promotedDeathIds = new Set((momentCards ?? []).flatMap(c => c.fact_ids).filter(id => deathFactIds.has(id)));
  const deaths = result.deaths.filter(d => promotedDeathIds.has(d.fact_id));
  const focusKills = (focus.kills_log ?? []).filter(k => Number.isFinite(k?.t) && k.key);
  const bkbUses = (focus.item_use_log ?? []).filter(u => u.key === 'black_king_bar' && Number.isFinite(u.t));
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
  const candidates = [];
  for (const d of deaths) {
    const conversions = numberedObjectives.filter(o => Number.isFinite(o.t) && o.t > d.t && o.t <= d.t + CONVERSION_AFTER_S
      && ownerSideOf(o.key) && killerSideOf(o.team) === focusTeam && ownerSideOf(o.key) !== focusTeam);
    candidates.push({ t: d.t, kind: 'death', death: d, conversions, score: 4 + 2 * Math.min(3, conversions.length) });
  }
  for (let m = 1; m < advSeries.length; m++) {
    const delta = advSeries[m] - advSeries[m - 1];
    if (Math.abs(delta) >= NW_SWING_MIN_GOLD && m * 60 <= horizon)
      candidates.push({ t: m * 60, kind: 'swing', delta, score: 2 + Math.min(3, Math.abs(delta) / 2000) });
  }
  if (bkbUses.length) candidates.push({ t: bkbUses[0].t, kind: 'bkb', use: bkbUses[0], score: 3 });
  // Merge near-duplicate swing candidates within MERGE_WITHIN_S, keeping the
  // higher-scored one — consecutive net-worth swings describe the same slide.
  // Distinct promoted deaths keep their own windows: each has its own actions.
  candidates.sort((a, b) => a.t - b.t || b.score - a.score);
  const merged = [];
  for (const c of candidates) {
    const near = merged.find(m => m.kind === 'swing' && c.kind === 'swing' && Math.abs(m.t - c.t) <= MERGE_WITHIN_S);
    if (!near) merged.push({ ...c });
    else if (c.score > near.score) Object.assign(near, { ...c });
  }
  // Prefer windows with at most one focus death: extra deaths inside a
  // candidate dilute the single-decision reading.
  for (const m of merged) {
    const inWindow = deaths.filter(d => d.t >= m.t - 60 && d.t <= m.t + CONVERSION_AFTER_S).length;
    if (inWindow > 1) m.score -= (inWindow - 1) * 1.5;
  }
  merged.sort((a, b) => b.score - a.score || a.t - b.t);
  const picked = merged.slice(0, MAINLINE_WINDOWS.max).sort((a, b) => a.t - b.t);
  const windowsShort = merged.length < MAINLINE_WINDOWS.min;
  /** Window frame for a candidate: [anchor − 60 s, anchor + 240 s] (BKB ± its interval). */
  const frameOf = c => ({ from: Math.max(0, c.t - (c.kind === 'bkb' ? 30 : 60)), to: c.t + CONVERSION_AFTER_S });
  // Drop SWING windows whose frames overlap by more than half the shorter
  // span: duplicated frames read as padding, keep the higher-scored candidate.
  // Death windows narrate their own distinct actions, so heavy frame overlap
  // alone (two deaths 100 s apart) is not grounds to drop one.
  const dedupedPicked = [];
  for (const c of [...picked].sort((a, b) => b.score - a.score)) {
    const f = frameOf(c);
    const clash = dedupedPicked.find(other => {
      if (other.kind !== 'swing' || c.kind !== 'swing') return false;
      const g = frameOf(other);
      const overlap = Math.min(f.to, g.to) - Math.max(f.from, g.from);
      return overlap > 0 && overlap * 2 > Math.min(f.to - f.from, g.to - g.from);
    });
    if (!clash) dedupedPicked.push(c);
  }
  const finalPicked = dedupedPicked.sort((a, b) => a.t - b.t);
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
    const boundA = towersFact(Math.floor(phase.from / 60), 'pushed'); if (boundA) ids.push(boundA);
    const advB = advFact(Math.max(0, Math.floor(Math.max(phase.from, phase.to - 1) / 60))); if (advB && !ids.includes(advB)) ids.push(advB);
    if (phase.to % 60 === 0) { const boundB = towersFact(Math.floor(phase.to / 60), 'pushed'); if (boundB && !ids.includes(boundB)) ids.push(boundB); }
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
    const from = Math.max(0, cand.t - (cand.kind === 'bkb' ? 30 : 60));
    const to = Math.min(horizon || cand.t + CONVERSION_AFTER_S, cand.t + CONVERSION_AFTER_S);
    const ids = [];
    const actions = [];
    const windowDeaths = deaths.filter(d => d.t >= from && d.t <= to);
    const windowKills = focusKills.filter(k => k.t >= from && k.t <= to);
    const windowObjs = numberedObjectives.filter(o => Number.isFinite(o.t) && o.t >= from && o.t <= to);
    const windowBkb = bkbUses.filter(u => u.t >= from && u.t <= to);
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
        pushAction(o.t, `${clock(o.t)} ${formatObjectiveLabel({ type: 'building_kill', key: o.key, team: o.teamNum }, lang)}`);
      }
    }
    // Linked cast/kill facts that buildMoments attached to these deaths and
    // BKB uses stay reachable from the window (raw events behind the expand).
    for (const d of windowDeaths) {
      const idx = result.deaths.indexOf(d) + 1;
      for (const id of Object.keys(facts)) if (id.startsWith(`cast.death.${idx}.`) || id.startsWith(`kill.death.${idx}.`)) ids.push(id);
    }
    for (const u of windowBkb) {
      const idx = bkbUses.indexOf(u) + 1;
      for (const id of Object.keys(facts)) if (id.startsWith(`cast.bkb.${idx}.`)) ids.push(id);
      const use = facts[`use.bkb.${idx}`];
      if (use) {
        ids.push(use.id);
        pushAction(u.t, zh ? `${clock(u.t)}–${clock(u.ended_at)} 黑皇杖使用（记录区间）` : `${clock(u.t)}–${clock(u.ended_at)} Black King Bar use (recorded interval)`);
      }
    }
    const startAdv = advForTeam(from, focusTeam);
    const endAdv = advForTeam(to, focusTeam);
    const advA = advFact(Math.floor(from / 60)); if (advA) ids.push(advA);
    const advB = advFact(Math.max(0, Math.floor(to / 60))); if (advB && advB !== advA) ids.push(advB);
    // Then-known hero state: level + notable purchases from snapshots/purchase
    // log; HP/mana/position only where a hero_states sample is nearby.
    // Key items surface first; filler purchases dedupe by item key.
    const snap = snapshotNearest(from);
    const owned = new Map();
    for (const p of purchases.filter(p => p.time <= from)) owned.set(p.key, p.time);
    const recentItems = [...owned.entries()]
      .sort((a, b) => Number(Object.hasOwn(KEY_ITEMS, b[0])) - Number(Object.hasOwn(KEY_ITEMS, a[0])) || b[1] - a[1])
      .slice(0, 4)
      .map(([key, time]) => ({ key, time }));
    const knownBits = [];
    if (startAdv != null) {
      knownBits.push(zh
        ? `本方${useGold ? '赚金优势' : '净资产优势'}约 ${fmtSigned(startAdv)}${useGold ? '' : '（60 秒桶，不是赚金）'}`
        : `your team's ${useGold ? 'earned-gold' : 'net-worth'} advantage was about ${fmtSigned(startAdv)}${useGold ? '' : ' (60 s bucket, not earned gold)'}`);
    }
    const towersBefore = Math.max(0, Math.floor(from / 60));
    const pushedFact = towersFact(towersBefore + 1, 'pushed');
    const lostFact = towersFact(towersBefore + 1, 'lost');
    if (pushedFact) { ids.push(pushedFact); knownBits.push(zh ? `${clock((towersBefore + 1) * 60)} 前我方摧毁对方建筑 ${facts[pushedFact].value} 处` : `before ${clock((towersBefore + 1) * 60)} your team had taken ${facts[pushedFact].value} enemy structure${facts[pushedFact].value === 1 ? '' : 's'}`); }
    if (lostFact) { ids.push(lostFact); knownBits.push(zh ? `${clock((towersBefore + 1) * 60)} 前我方失去建筑 ${facts[lostFact].value} 处` : `before ${clock((towersBefore + 1) * 60)} your team had lost ${facts[lostFact].value} structure${facts[lostFact].value === 1 ? '' : 's'}`); }
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
    if (recentItems.length) {
      const itemPart = recentItems.map(p => itemName(p.key, lang)).join(zh ? '、' : ', ');
      knownBits.push(zh ? `此前已购入：${itemPart}` : `already purchased: ${itemPart}`);
      for (const p of recentItems) {
        const firstId = `item.first.${p.key}`;
        if (facts[firstId] && p.time === facts[firstId].value) ids.push(firstId);
      }
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
    actions.sort((a, b) => a.t - b.t);
    // Comparable alternatives: only when then-available fields support them.
    const comparableBits = [];
    const bkbFirst = facts['item.first.black_king_bar'];
    const bkbUsedInWindow = windowBkb.length > 0 || (focus.item_use_log ?? []).some(u => u.key === 'black_king_bar' && Number.isFinite(u.t) && u.t >= from && u.t <= to);
    if (bkbFirst && Number.isFinite(bkbFirst.value) && bkbFirst.value <= from && !bkbUsedInWindow && windowDeaths.length) {
      if (facts['item.first.black_king_bar']) ids.push('item.first.black_king_bar');
      comparableBits.push(zh
        ? `黑皇杖已于 ${clock(bkbFirst.value)} 购入、本窗口内无使用记录；可对照的选择是先开启黑皇杖再接团。是否可行取决于当时冷却与局面，本报告不判定。`
        : `Black King Bar was purchased at ${clock(bkbFirst.value)} and shows no use inside this window; the comparable alternative was activating it before committing. Whether that was viable depends on cooldowns and the fight, which this report does not judge.`);
    }
    // Evaluation layer: explicit, evidence-bound, no causality.
    const evalBits = [];
    if (windowKills.length) evalBits.push(zh
      ? `有依据的部分：本窗口内你有 ${windowKills.length} 次击杀记录（记为参与战斗）。`
      : `Grounded positive: ${windowKills.length} recorded kill${windowKills.length > 1 ? 's' : ''} inside this window (counted as fight participation).`);
    const convs = windowObjs.filter(o => killerSideOf(o.team) === focusTeam && ownerSideOf(o.key) && ownerSideOf(o.key) !== focusTeam);
    if (convs.length) evalBits.push(zh
      ? `有依据的部分：窗口内我方摧毁对方建筑 ${convs.length} 处。`
      : `Grounded positive: your team took ${convs.length} enemy structure${convs.length > 1 ? 's' : ''} inside this window.`);
    if (startAdv != null && endAdv != null) evalBits.push(zh
      ? `窗口代价（序列口径）：${useGold ? '赚金优势' : '净资产优势'}从 ${fmtSigned(startAdv)} 变为 ${fmtSigned(endAdv)}${useGold ? '' : '（60 秒桶，不是赚金）'}。`
      : `Window cost (series basis): ${useGold ? 'earned-gold' : 'net-worth'} advantage moved from ${fmtSigned(startAdv)} to ${fmtSigned(endAdv)}${useGold ? '' : ' (60 s buckets, not earned gold)'}.`);
    const sections = [];
    if (knownBits.length) sections.push({ label_key: 'known', text: `${knownBits.join(zh ? '；' : '; ')}${zh ? '。' : '.'}` });
    if (actions.length) sections.push({ label_key: 'actions', text: `${actions.map(a => a.text).join(zh ? '；随后 ' : '; then ')}${zh ? '。' : '.'}` });
    if (comparableBits.length) sections.push({ label_key: 'comparable', text: comparableBits.join(zh ? '' : ' ') });
    if (missingBits.length) sections.push({ label_key: 'missing', text: missingBits.join(zh ? '' : ' ') });
    if (evalBits.length) sections.push({ label_key: 'evaluation', text: `${zh ? '评价（基于上述证据，不做因果推断）：' : 'Assessment (from the evidence above; no causal claims): '}${evalBits.join(zh ? '' : ' ')}` });
    const claimBits = actions.map(a => a.text);
    if (startAdv != null && endAdv != null) claimBits.push(zh
      ? `窗口内${useGold ? '赚金优势' : '净资产优势'}从 ${fmtSigned(startAdv)} 到 ${fmtSigned(endAdv)}${useGold ? '' : '（60 秒桶）'}`
      : `${useGold ? 'earned-gold' : 'net-worth'} advantage moved from ${fmtSigned(startAdv)} to ${fmtSigned(endAdv)}${useGold ? '' : ' (60 s buckets)'}`);
    const claimText = claimBits.length
      ? `${claimBits.join(zh ? '；' : '; ')}${zh ? '。' : '.'}`
      : (zh ? `窗口 ${clock(cand.t)} 附近没有可核实的动作证据。` : `No verifiable action evidence around ${clock(cand.t)}.`);
    const dedupedIds = [...new Set(ids)].filter(id => facts[id]);
    const title = zh
      ? `决策窗口 ${n}（${clock(cand.t)}）：${cand.kind === 'death' ? '阵亡与后续' : cand.kind === 'swing' ? '优势序列骤变' : '黑皇杖使用'}`
      : `Decision window ${n} (${clock(cand.t)}): ${cand.kind === 'death' ? 'death and aftermath' : cand.kind === 'swing' ? 'advantage swing' : 'Black King Bar use'}`;
    windows.push({
      id: `window.${n}`, kind: 'review_window', status: 'ok', title,
      // time is the analytic frame of the window; every event clock inside the
      // copy is carried by a cited fact.
      time: { from, to },
      claim: { text: claimText, slots: claimText, phrasing: 'template' },
      sections, fact_ids: dedupedIds, metrics: [],
      evidence: { kind: 'mainline_window', highlight: [from / 60, to / 60], markers: dedupedIds, moments: [] },
      baseline: null, target: null, citations: ['r1'], data_gap: missingBits.length ? 'window_decisive_evidence_missing' : null,
      prompt: zh ? `${clock(cand.t)} 前后：当时有哪些有依据的可比选择？` : `Around ${clock(cand.t)}: which comparable options had grounds at the time?`,
    });
  }

  // ---- practice goals (proven only with hero states) ----------------------
  const practice = buildPractice({ zh, facts, addFact, windows, heroStates, focus, focusSlug: slugOfKey(heroSlug(focus.hero_id)), lang });

  return { insights: [overview, ...windows], practice, windowsShort };
}

/**
 * Practice goals must be process-checkable with their observed conditions.
 * Without hero-state samples nothing here is provable, so the payload says so
 * once instead of emitting generic advice.
 */
function buildPractice({ zh, facts, addFact, windows, heroStates, focus, focusSlug, lang }) {
  const stateWins = windows.map(w => {
    const id = w.fact_ids.find(id => id === `state.win.${w.id.split('.')[1]}.${focusSlug}`);
    return id ? { w, s: facts[id].value } : null;
  }).filter(Boolean);
  const items = [];
  const deathsByWindow = w => w.fact_ids.filter(id => /^death\.\d+$/.test(id));
  // Pattern A: low mana before fights that produced recorded deaths.
  const lowMana = stateWins.filter(({ w, s }) => deathsByWindow(w).length && pctOf(s.mana, s.max_mana) != null && pctOf(s.mana, s.max_mana) < 50);
  if (lowMana.length >= 2) {
    items.push({
      goal: zh ? '接团前把魔法值保持在 50% 以上并确认关键技能可用。' : 'Before committing to a fight, keep mana above 50% and confirm key abilities are ready.',
      condition: zh
        ? `本局 ${lowMana.map(({ w, s }) => `${clock(s.t)} 魔法 ${pctOf(s.mana, s.max_mana)}%（状态样本 ${w.title}）`).join('、')}，且各窗口内均有阵亡记录（时序相关，非因果）。`
        : `In this match: ${lowMana.map(({ w, s }) => `${clock(s.t)} mana ${pctOf(s.mana, s.max_mana)}% (sample, ${w.title})`).join(', ')} — each window also has a recorded death (temporal, not causal).`,
      fact_ids: lowMana.flatMap(({ w }) => w.fact_ids.filter(id => id.startsWith('state.win.') || /^death\.\d+$/.test(id))).slice(0, 8),
    });
  }
  // Pattern B: BKB owned but unused across several death windows.
  const bkbFirst = facts['item.first.black_king_bar'];
  const bkbUnusedWins = windows.filter(w =>
    deathsByWindow(w).length
    && bkbFirst && Number.isFinite(bkbFirst.value) && bkbFirst.value <= w.time.from
    && !w.fact_ids.some(id => id.startsWith('use.bkb.')));
  if (bkbUnusedWins.length >= 2) {
    items.push({
      goal: zh ? '接团前检查黑皇杖是否可用，并把它纳入开团 checklist。' : 'Before committing, check whether Black King Bar is up and include it in the fight checklist.',
      condition: zh
        ? `黑皇杖于 ${clock(bkbFirst.value)} 购入；${bkbUnusedWins.map(w => w.title).join('、')} 均有阵亡记录且窗口内无使用记录（时序相关，非因果）。`
        : `Black King Bar was purchased at ${clock(bkbFirst.value)}; ${bkbUnusedWins.map(w => w.title).join(', ')} all contain recorded deaths with no in-window use (temporal, not causal).`,
      fact_ids: ['item.first.black_king_bar', ...bkbUnusedWins.flatMap(w => deathsByWindow(w))].slice(0, 8),
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
