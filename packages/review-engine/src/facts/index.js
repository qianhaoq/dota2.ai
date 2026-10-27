import { isSameTeamKill } from '../deathTimeline.js';
import { STATIC_HEROES, getStaticHero } from '../staticHeroes.js';

export const KEY_ITEMS = {
  blink: { en: 'blink', zh: '跳刀' },
  black_king_bar: { en: 'Black King Bar', zh: '黑皇杖' },
  blade_mail: { en: 'Blade Mail', zh: '刃甲' },
  force_staff: { en: 'Force Staff', zh: '原力法杖' },
  lotus_orb: { en: 'Lotus Orb', zh: '莲花' },
  sphere: { en: "Linken's Sphere", zh: '林肯法球' },
  sheepstick: { en: 'Scythe of Vyse', zh: '羊刀' },
  nullifier: { en: 'Nullifier', zh: '否决' },
};

export const clock = seconds => `${seconds < 0 ? '-' : ''}${Math.floor(Math.abs(seconds) / 60)}:${String(Math.abs(seconds) % 60).padStart(2, '0')}`;
const finite = value => typeof value === 'number' && Number.isFinite(value);
export const heroSlug = id => getStaticHero(id)?.internalSlug ?? null;
export const teamOf = player => Number.isInteger(player.player_slot) ? (player.player_slot < 128 ? 'radiant' : 'dire') : null;
const format = value => `${value < 0 ? '−' : ''}${Math.abs(value).toLocaleString('en-US')}`;
const slug = key => String(key).replace(/^npc_dota_hero_/, '');
const heroLabel = (key, lang) => {
  const s = String(key).replace(/^npc_dota_hero_/, '');
  const hero = Object.values(STATIC_HEROES).find(h => h.internalSlug === s);
  return hero ? (lang === 'zh' ? hero.nameZh : hero.nameEn) : s;
};
/** Localize slug→count entity maps (killed_by); leave other entity values unchanged. */
const entityCountDisplay = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (!entries.length || !entries.every(([, v]) => typeof v === 'number' && Number.isFinite(v))) return null;
  const sorted = [...entries].sort((a, b) => Number(b[1]) - Number(a[1]) || String(a[0]).localeCompare(String(b[0])));
  return {
    en: sorted.map(([k, v]) => `${heroLabel(k, 'en')}: ${v}`).join(' / '),
    zh: sorted.map(([k, v]) => `${heroLabel(k, 'zh')}: ${v}`).join(' / '),
  };
};


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
    const localized = kind === 'entity' ? entityCountDisplay(value) : null;
    const text = localized
      ? localized.en
      : typeof value === 'number'
        ? (kind === 'time' ? clock(value) : format(value))
        : typeof value === 'object' && value !== null
          ? Object.entries(value).map(([key, v]) => `${key}: ${v}`).join(' / ')
          : String(value);
    facts[id] = { id, kind, value, perspective, display: localized ?? { en: text, zh: text }, citation: 's1', source_path, ...extra };
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
    (player.purchase_log ?? []).forEach((purchase, i) => {
      const id = `item.first.${purchase.key}`;
      if (!Object.hasOwn(KEY_ITEMS, purchase.key) || !finite(purchase.time) || facts[id]) return;
      add(id, purchase.time, 'time', `${path}.purchase_log[${i}].time`, { t: purchase.time, unit: 'seconds' });
      facts[id].display = { en: `${KEY_ITEMS[purchase.key].en} at ${clock(purchase.time)}`, zh: `${clock(purchase.time)} 购入${KEY_ITEMS[purchase.key].zh}`, t: clock(purchase.time) };
    });
    let logs = Array.isArray(player.deaths_log) ? player.deaths_log.map((d, i) => ({ ...d, source_path: `${path}.deaths_log[${i}]` })) : null;
    const mapped = heroSlug(player.hero_id);
    const killsComplete = raw.players.every(p => Array.isArray(p.kills_log) && heroSlug(p.hero_id));
    if (!Array.isArray(logs) && mapped && killsComplete) logs = raw.players.flatMap((p, i) => isSameTeamKill(p.player_slot, player.player_slot) ? [] : p.kills_log.map((k, j) => ({ ...k, source_path: `players[${i}].kills_log[${j}]` })).filter(k => slug(k.key) === mapped).map(k => ({ time: k.time, key: heroSlug(p.hero_id), source_path: k.source_path })));
    const valid = Array.isArray(logs) && logs.every(d => finite(d.time));
    if (valid) {
      const sorted = [...logs].sort((a, b) => a.time - b.time);
      const timelineSource = sorted.length ? sorted.map(d => d.source_path).join('; ') : Array.isArray(player.deaths_log) ? `${path}.deaths_log` : raw.players.map((_, i) => `players[${i}].kills_log`).join('; ');
      const killerSlots = new Map(raw.players.map(p => [heroSlug(p.hero_id), p.player_slot]));
      const counts = entries => {
        const killers = entries.filter(d => d.key && !isSameTeamKill(killerSlots.get(slug(d.key)), player.player_slot));
        return Object.fromEntries([...new Set(killers.map(e => slug(e.key)))].sort().map(key => [key, killers.filter(e => slug(e.key) === key).length]));
      };
      sorted.forEach((d, i) => {
        const diff = d.time >= 0 ? gold[Math.floor(d.time / 60)] : null;
        const id = `death.${i + 1}`;
        const event = { t: d.time, killer: d.key ? slug(d.key) : null, team_gold_diff_at_t: finite(diff) ? diff : null, fact_id: id };
        deaths.push(event);
        add(id, event, 'entity', d.source_path, { t: d.time });
      });
      const completeTimeline = !finite(player.deaths) || sorted.length === player.deaths;
      if (completeTimeline) {
        add('killed_by', counts(sorted), 'entity', timelineSource);
        for (const [killer, count] of Object.entries(facts.killed_by.value)) add(`killed_by.${killer}`, count, 'count', timelineSource);
        add('deaths.total', sorted.length, 'count', timelineSource);
        for (const minute of [15, 22]) {
          const early = sorted.filter(d => d.time < minute * 60);
          add(`deaths.before_${minute}`, early.length, 'count', timelineSource);
          add(`deaths.before_${minute}.killed_by`, counts(early), 'entity', timelineSource);
        }
        if (deaths.every(d => finite(d.team_gold_diff_at_t))) add('deaths.behind_1k', deaths.filter(d => d.team_gold_diff_at_t < -1000).length, 'count', 'radiant_gold_adv; deaths', { derivation: 'minute=floor(t/60); player_team_gold_adv[minute] < -1000' });
        else gaps.push({ topic: 'deaths.behind_1k', reason: 'missing_gold_at_death' });
        for (const [phase, from, to] of [['lane', 0, 600], ['mid', 600, 1500], ['late', 1500, Infinity]]) add(`deaths.phase.${phase}`, deaths.filter(d => d.t >= from && d.t < to).length, 'count', timelineSource);
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
