import { getStaticHero } from '../staticHeroes.js';

export const clock = seconds => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
const finite = value => typeof value === 'number' && Number.isFinite(value);
export const heroSlug = id => getStaticHero(id)?.internalSlug ?? null;
export const teamOf = player => Number.isInteger(player.player_slot) ? (player.player_slot < 128 ? 'radiant' : 'dire') : null;
const format = value => `${value < 0 ? '−' : ''}${Math.abs(value).toLocaleString('en-US')}`;
const slug = key => String(key).replace(/^npc_dota_hero_/, '');

/** Fixed five-minute windows; missing intermediate samples invalidate the window. */
export function findWindow(series, start = 0, direction = 'min', accept = window => true) {
  let best = null;
  for (let m = start; m + 5 < series.length; m++) {
    if (!Array.from({ length: 6 }, (_, i) => series[m + i]).every(finite)) continue;
    const delta = series[m + 5] - series[m];
    if (!accept({ from: m, to: m + 5, delta })) continue;
    if (!best || (direction === 'min' ? delta < best.delta : delta > best.delta)) best = { from: m, to: m + 5, delta };
  }
  return best;
}

/** @param {any} raw @param {any} player */
export function buildFacts(raw, player) {
  /** @type {Record<string, any>} */
  const facts = {};
  const gaps = [];
  const perspective = player ? 'player_team' : 'radiant';
  const sign = teamOf(player ?? {}) === 'dire' ? -1 : 1;
  const gold = (raw.radiant_gold_adv ?? []).map(v => finite(v) ? v * sign : null);
  const xp = (raw.radiant_xp_adv ?? []).map(v => finite(v) ? v * sign : null);
  const add = (id, value, kind, source_path, extra = {}) => {
    const text = typeof value === 'number' ? (kind === 'time' ? clock(value) : format(value)) : typeof value === 'object' && value !== null ? Object.entries(value).map(([key, v]) => `${key}: ${v}`).join(' / ') : String(value);
    facts[id] = { id, kind, value, perspective, display: { en: text, zh: text }, citation: 's1', source_path, ...extra };
    if (finite(facts[id].t)) facts[id].display.t = clock(facts[id].t);
  };
  const windowFacts = (prefix, series, w, unit, source) => {
    if (!w || !finite(series[w.from]) || !finite(series[w.to])) return;
    const value = { start: series[w.from], end: series[w.to], delta: series[w.to] - series[w.from], start_minute: w.from, end_minute: w.to };
    add(prefix, value, 'series_ref', source, { unit, t: w.from * 60, derivation: 'perspective series[end] - series[start]' });
    facts[prefix].display = { en: `${format(value.start)} → ${format(value.end)} (${value.delta < 0 ? '▼' : '▲'}${format(Math.abs(value.delta))})`, zh: `${format(value.start)} → ${format(value.end)} (${value.delta < 0 ? '▼' : '▲'}${format(Math.abs(value.delta))})`, t: `${clock(w.from * 60)}–${clock(w.to * 60)}` };
    for (const key of ['start', 'end', 'delta']) add(`${prefix}.${key}`, value[key], key === 'delta' ? 'delta' : 'scalar', `${source}[${key === 'start' ? w.from : w.to}]`, { unit, t: (key === 'start' ? w.from : w.to) * 60, derivation: key === 'delta' ? `perspective(${source}[${w.to}] - ${source}[${w.from}])` : `perspective(${source}[${key === 'start' ? w.from : w.to}])` });
  };
  for (const [name, series, extreme] of [['gold', gold, 'low'], ['xp', xp, 'peak']]) {
    const samples = series.map((value, i) => ({ value, i })).filter(s => finite(s.value));
    if (samples.length) {
      const best = samples.reduce((a, b) => (name === 'gold' ? b.value < a.value : b.value > a.value) ? b : a);
      add(`${name}.${extreme}`, best.value, 'scalar', `radiant_${name}_adv[${best.i}]`, { unit: name, t: best.i * 60 });
    }
    series.forEach((v, m) => { if (finite(v)) add(`${name}.at.${m}`, v, 'scalar', `radiant_${name}_adv[${m}]`, { unit: name, t: m * 60 }); });
  }
  const worst = findWindow(gold);
  if (worst) {
    windowFacts(`gold.window.${worst.from}_${worst.to}`, gold, worst, 'gold', 'radiant_gold_adv');
    windowFacts(`xp.window.${worst.from}_${worst.to}`, xp, worst, 'xp', 'radiant_xp_adv');
  }
  const lowMinute = facts['gold.low']?.t / 60;
  const recovery = findWindow(xp, finite(lowMinute) ? lowMinute + 1 : 0, 'max', w => w.delta > 0 && finite(gold[w.from]) && finite(gold[w.to]) && gold[w.from] < 0 && gold[w.to] > gold[w.from]);
  const comeback = recovery && recovery.delta > 0 && gold[recovery.from] < 0 && gold[recovery.to] > gold[recovery.from] ? recovery : null;
  if (comeback) for (const [name, series] of [['gold', gold], ['xp', xp]]) windowFacts(`comeback.${comeback.from}_${comeback.to}.${name}`, series, comeback, name, `radiant_${name}_adv`);
  if (finite(raw.duration)) add('ancient.fell', raw.duration, 'time', 'duration', { unit: 'seconds', t: raw.duration });
  if (raw.patch != null) add('patch', raw.patch, 'entity', 'patch');
  const deaths = [];
  if (player) {
    const index = raw.players.indexOf(player);
    const path = `players[${index}]`;
    let logs = player.deaths_log;
    const mapped = heroSlug(player.hero_id);
    const killsComplete = raw.players.every(p => Array.isArray(p.kills_log) && heroSlug(p.hero_id));
    if (!Array.isArray(logs) && mapped && killsComplete) logs = raw.players.flatMap(p => p.kills_log.filter(k => slug(k.key) === mapped).map(k => ({ time: k.time, key: heroSlug(p.hero_id) })));
    const valid = Array.isArray(logs) && logs.every(d => finite(d.time));
    if (valid) {
      const sorted = [...logs].sort((a, b) => a.time - b.time);
      const counts = entries => Object.fromEntries([...new Set(entries.map(e => slug(e.key)))].sort().map(key => [key, entries.filter(e => slug(e.key) === key).length]));
      sorted.forEach((d, i) => {
        const diff = d.time >= 0 ? gold[Math.floor(d.time / 60)] : null;
        const id = `death.${i + 1}`;
        const event = { t: d.time, killer: d.key ? slug(d.key) : null, team_gold_diff_at_t: finite(diff) ? diff : null, fact_id: id };
        deaths.push(event);
        add(id, event, 'entity', `${path}.${Array.isArray(player.deaths_log) ? 'deaths_log' : 'kills_log inversion'}`, { t: d.time });
      });
      const completeTimeline = !finite(player.deaths) || sorted.length === player.deaths;
      if (completeTimeline) {
        add('killed_by', counts(sorted.filter(d => d.key)), 'entity', `${path}.deaths_log / kills_log inversion`);
        add('deaths.total', sorted.length, 'count', `${path}.deaths_log / kills_log inversion`);
        for (const minute of [15, 22]) {
          const early = sorted.filter(d => d.time < minute * 60);
          add(`deaths.before_${minute}`, early.length, 'count', `${path}.deaths_log / kills_log inversion`);
          add(`deaths.before_${minute}.killed_by`, counts(early.filter(d => d.key)), 'entity', `${path}.deaths_log / kills_log inversion`);
        }
        if (deaths.every(d => finite(d.team_gold_diff_at_t))) add('deaths.behind_1k', deaths.filter(d => d.team_gold_diff_at_t < -1000).length, 'count', 'radiant_gold_adv; deaths', { derivation: 'minute=floor(t/60); player_team_gold_adv[minute] < -1000' });
        else gaps.push({ topic: 'deaths.behind_1k', reason: 'missing_gold_at_death' });
        for (const [phase, from, to] of [['lane', 0, 600], ['mid', 600, 1500], ['late', 1500, Infinity]]) add(`deaths.phase.${phase}`, deaths.filter(d => d.t >= from && d.t < to).length, 'count', `${path}.deaths_log / kills_log inversion`);
      }
      if (!completeTimeline) gaps.push({ topic: 'deaths', reason: 'death_timeline_incomplete' });
    } else gaps.push({ topic: 'deaths', reason: 'missing_death_timeline' });
    for (const field of ['gold_fed', 'time_dead']) {
      if (Array.isArray(player.deaths_log) && player.deaths_log.every(d => finite(d[field])) && (!finite(player.deaths) || player.deaths_log.length === player.deaths)) add(field, player.deaths_log.reduce((sum, d) => sum + d[field], 0), field === 'time_dead' ? 'time' : 'scalar', `${path}.deaths_log[].${field}`, { unit: field === 'time_dead' ? 'seconds' : 'gold', derivation: `sum(deaths_log[].${field})` });
      else gaps.push({ topic: field, reason: 'missing_or_incomplete_deaths_log' });
    }
    if (finite(player.lh_t?.[10])) add('lh_at_10', player.lh_t[10], 'count', `${path}.lh_t[10]`, { t: 600 });
  }
  return { facts, deaths, worst, comeback, gaps };
}
