#!/usr/bin/env node
/**
 * Regenerates lib/coach/data/abilities.json: each hero's ultimate (key,
 * English + Chinese name, cooldown per level) from Valve's public datafeed,
 * each hero's castable abilities — including Aghanim's Scepter and Aghanim's
 * Shard granted abilities (`granted_by: 'scepter' | 'shard'`, official EN/ZH
 * descriptions) and Scepter/Shard upgrade notes on existing and innate
 * abilities — with Valve's own flags (damage type, whether they pierce spell
 * immunity, how they can be dispelled, the cooldown of basic spells that open
 * a trading window) for the review agent and coach explanations,
 * and every hero ability's damage type (P/M/U = physical/magical/pure) from
 * OpenDota constants — used to split the damage a player took by type.
 * For the small number of Scepter/Shard tooltips where Valve's JSON datafeed
 * omits the modifier operator (+/-/=/+%/x) on a non-zero base value, the exact
 * operator is read from Valve's raw hero script in dotabuff/d2vpkr.
 * The coach engine is pure and never fetches; run this when a patch lands:
 *   node scripts/coach-abilities.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { STATIC_HEROES } from '../packages/review-engine/src/staticHeroes.js';

const NAMES = JSON.parse(readFileSync(new URL('../lib/coach/data/names.json', import.meta.url)));
const OUT = new URL('../lib/coach/data/abilities.json', import.meta.url);
const feed = async (id, language) => {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`https://www.dota2.com/datafeed/herodata?language=${language}&hero_id=${id}`);
    if (res.ok) return (await res.json()).result.data.heroes[0];
    await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
  }
  throw new Error(`datafeed ${id}/${language} failed`);
};

/** Parse AbilityValues scepter/shard operator strings from a dotabuff/d2vpkr hero KV file. */
function parseD2vpkrOps(text) {
  const out = new Map();
  const stack = [];
  let pendingKey = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\/\/.*$/, '').trim();
    if (!line) continue;
    if (line === '{') { stack.push(pendingKey ?? ''); pendingKey = null; continue; }
    if (line === '}') { stack.pop(); continue; }
    const kv = line.match(/^"([^"]+)"\s+"([^"]*)"$/);
    if (kv) {
      const [, k, v] = kv;
      const avIdx = stack.lastIndexOf('AbilityValues');
      if (avIdx >= 1) {
        const ab = stack[avIdx - 1];
        if (!out.has(ab)) out.set(ab, new Map());
        const m = out.get(ab);
        if (avIdx === stack.length - 1) {
          m.set(k.toLowerCase(), { value: v });
        } else if (avIdx === stack.length - 2) {
          const varName = stack[avIdx + 1].toLowerCase();
          if (!m.has(varName)) m.set(varName, {});
          const rec = m.get(varName);
          if (k === 'value') rec.value = v;
          else if (/^special_bonus_scepter(?:_\d+)?$/.test(k)) rec.scepter = v;
          else if (/^special_bonus_shard(?:_\d+)?$/.test(k)) rec.shard = v;
        }
      }
      pendingKey = null;
      continue;
    }
    const onlyKey = line.match(/^"([^"]+)"$/);
    if (onlyKey) pendingKey = onlyKey[1];
  }
  return out;
}

const d2vpkrCache = new Map();
async function getHeroOps(npc) {
  if (!npc) return new Map();
  if (!d2vpkrCache.has(npc)) {
    let parsed = new Map();
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(`https://raw.githubusercontent.com/dotabuff/d2vpkr/master/dota/scripts/npc/heroes/${npc}.txt`);
      if (res.ok) { parsed = parseD2vpkrOps(await res.text()); break; }
      if (res.status === 404) break;
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
    d2vpkrCache.set(npc, parsed);
  }
  return d2vpkrCache.get(npc);
}

function fmtVals(arr) {
  if (!Array.isArray(arr) || !arr.length) return null;
  const clean = arr.map((v) => (Number.isFinite(v) ? String(Math.round(v * 100) / 100) : null)).filter(Boolean);
  if (!clean.length) return null;
  const uniq = [...new Set(clean)];
  return uniq.length === 1 ? uniq[0] : clean.join('/');
}

function applyOp(baseArr, opStr) {
  if (!opStr) return null;
  const m = opStr.trim().match(/^([+\-=xX])?([+-]?\d+(?:\.\d+)?)(%)?$/);
  if (!m) return null;
  const [, op, numStr, pct] = m;
  const n = Number(numStr);
  if (op === '=') return [n];
  if (!baseArr || !baseArr.length || baseArr.every((v) => v === 0)) return [Math.abs(n)];
  if (op === 'x' || op === 'X') return baseArr.map((v) => v * n);
  if (pct) {
    const sign = op === '-' ? -1 : 1;
    return baseArr.map((v) => v * (1 + (sign * n) / 100));
  }
  const delta = op === '-' ? -n : n;
  return baseArr.map((v) => v + delta);
}

/**
 * Clean HTML tags and substitute Valve %token% placeholders from official
 * special_values (and exact d2vpkr KV operators when a scepter/shard modifier
 * applies to a non-zero base value). Never guesses an ambiguous value.
 */
async function resolveValveText(raw, ability, mode, npc) {
  if (!raw || typeof raw !== 'string') return '';
  const svMap = new Map((ability.special_values ?? []).map((sv) => [sv.name.toLowerCase(), sv]));
  const tokens = [...raw.matchAll(/%([a-zA-Z0-9_]+)%/g)].map((m) => m[1]);
  const needsOps = mode !== 'desc' && tokens.some((tok) => {
    const sv = svMap.get(tok.toLowerCase());
    if (!sv) return false;
    const mod = mode === 'scepter' ? sv.values_scepter : sv.values_shard;
    return Array.isArray(mod) && mod.length > 0 && (sv.values_float ?? []).some((v) => v !== 0);
  });
  const abOps = needsOps ? (await getHeroOps(npc)).get(ability.name) ?? null : null;

  const lookup = (token) => {
    const lower = token.toLowerCase();
    let sv = svMap.get(lower);
    let isBonus = false;
    if (!sv && lower.startsWith('bonus_')) {
      sv = svMap.get(lower.slice(6));
      isBonus = true;
    }
    if (sv) {
      const mod = mode === 'scepter' ? sv.values_scepter : mode === 'shard' ? sv.values_shard : [];
      if (Array.isArray(mod) && mod.length) {
        if (isBonus) return fmtVals(mod.map(Math.abs));
        if (!(sv.values_float ?? []).some((v) => v !== 0)) return fmtVals(mod.map(Math.abs));
        const opRec = abOps?.get(lower);
        const applied = applyOp(sv.values_float, mode === 'scepter' ? opRec?.scepter : opRec?.shard);
        return applied ? fmtVals(applied) : null;
      }
      if (Array.isArray(sv.values_float) && sv.values_float.length) return fmtVals(sv.values_float);
    }
    if (lower === 'abilitycastrange' && ability.cast_ranges?.length) return fmtVals(ability.cast_ranges);
    if (lower === 'abilitycooldown' && ability.cooldowns?.length) return fmtVals(ability.cooldowns);
    if (lower === 'abilityduration' && ability.durations?.length) return fmtVals(ability.durations);
    if (lower === 'abilitychanneltime' && ability.channel_times?.length) return fmtVals(ability.channel_times);
    if (lower === 'abilitymanacost' && ability.mana_costs?.length) return fmtVals(ability.mana_costs);
    return null;
  };

  return raw
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/%([a-zA-Z0-9_]+)%%%/g, (_, tok) => {
      const v = lookup(tok);
      return v != null ? `${v}%` : `%${tok}%%%`;
    })
    .replace(/%([a-zA-Z0-9_]+)%/g, (_, tok) => {
      const v = lookup(tok);
      return v != null ? v : `%${tok}%`;
    })
    .replace(/%%/g, '%')
    .replace(/\s+/g, ' ')
    .trim();
}

async function localizedText(enRaw, zhRaw, ability, mode, npc) {
  const en = await resolveValveText(enRaw, ability, mode, npc);
  if (!en) return null;
  const zh = (await resolveValveText(zhRaw, ability, mode, npc)) || en;
  return { en, zh };
}

// Valve's enums (datafeed herodata): damage 1/2/4 = physical/magical/pure;
// immunity 3 = ENEMIES_YES (pierces spell immunity), 4 = ENEMIES_NO;
// dispellable 1 = strong dispels only, 2 = any dispel, 3 = cannot be dispelled
// (per modifier, not per ability: stored, never shown as a whole-ability fact).
const DMG = { 1: 'P', 2: 'M', 4: 'U' };
const PIERCE = { 3: true, 4: false };
const DISPEL = { 1: 'strong', 2: 'basic', 3: 'no' };
// A spell opens a trading window only when it is cast (not passive, not an
// auto-cast attack modifier), its threat is over once used (no lasting effect
// over 1.5 s: Blade Fury, Swarm, Battle Hunger stay dangerous after the cast)
// and its cooldown is long enough to act in (8 s at level 1).
const PASSIVE = 2n; const AUTOCAST = 4096n;
function tradeWindow(a) {
  let beh; try { beh = BigInt(a.behavior ?? 0); } catch { return false; }
  if (beh & PASSIVE || beh & AUTOCAST) return false;
  const cd = a.cooldowns;
  if (!Array.isArray(cd) || !(cd[0] >= 8)) return false;
  const lasting = [...(a.durations ?? []), ...(a.special_values ?? [])
    .filter((v) => v.name === 'duration').flatMap((v) => v.values_float ?? [])];
  return !lasting.some((d) => d > 1.5);
}
const ultimates = {};
const heroes = {};
// Abilities a hero only gets from Aghanim's Shard or Scepter (Tidehunter's Dead in the Water), and innate ones:
// by key, their names and what grants them, so any tool can name such a cast or innate (#495).
const granted = {};
const innateUpgrades = {};
const ids = Object.keys(NAMES.heroes);
for (let i = 0; i < ids.length; i += 8) {
  await Promise.all(ids.slice(i, i + 8).map(async (id) => {
    const [en, zh] = await Promise.all([feed(id, 'english'), feed(id, 'schinese')]);
    const npc = STATIC_HEROES[Number(id)]?.internalName ?? en.name ?? null;
    const list = [];
    const innates = [];
    for (const a of en.abilities) {
      if (!a.name_loc || a.name.startsWith('generic')) continue;
      const z = zh.abilities.find((x) => x.name === a.name);
      if (a.ability_is_granted_by_shard || a.ability_is_granted_by_scepter || a.ability_is_innate) {
        granted[a.name] = {
          en: a.name_loc,
          zh: z?.name_loc || a.name_loc,
          by: a.ability_is_granted_by_shard ? 'shard' : a.ability_is_granted_by_scepter ? 'scepter' : 'innate',
          hero: Number(id),
        };
      }
      const scepter = a.ability_has_scepter && a.scepter_loc ? await localizedText(a.scepter_loc, z?.scepter_loc, a, 'scepter', npc) : null;
      const shard = a.ability_has_shard && a.shard_loc ? await localizedText(a.shard_loc, z?.shard_loc, a, 'shard', npc) : null;
      if (a.ability_is_innate) {
        if (scepter || shard) {
          innates.push({
            id: a.name, en: a.name_loc, zh: z?.name_loc || a.name_loc, innate: true,
            ...(scepter ? { scepter } : {}),
            ...(shard ? { shard } : {}),
          });
        }
        continue;
      }
      const grantedBy = a.ability_is_granted_by_scepter ? 'scepter' : a.ability_is_granted_by_shard ? 'shard' : null;
      const desc = grantedBy && a.desc_loc ? await localizedText(a.desc_loc, z?.desc_loc, a, 'desc', npc) : null;
      const cd = grantedBy && Array.isArray(a.cooldowns) && a.cooldowns.some((c) => c > 0) ? a.cooldowns : null;
      list.push({
        id: a.name, en: a.name_loc, zh: z?.name_loc || a.name_loc,
        ...(a.type === 1 ? { ult: true } : {}),
        ...(grantedBy ? { granted_by: grantedBy } : {}),
        ...(DMG[a.damage] ? { dmg: DMG[a.damage] } : {}),
        ...(a.immunity in PIERCE ? { pierces: PIERCE[a.immunity] } : {}),
        ...(DISPEL[a.dispellable] ? { dispel: DISPEL[a.dispellable] } : {}),
        // Cooldown per level, only for basic damage spells whose use opens a
        // trading window (see tradeWindow). Ultimates keep theirs in `ultimates`;
        // Scepter/Shard-granted abilities keep theirs in `cd`, never `trade_cd`.
        ...(a.type !== 1 && !grantedBy && DMG[a.damage] && tradeWindow(a) ? { trade_cd: a.cooldowns } : {}),
        ...(cd ? { cd } : {}),
        ...(desc ? { desc } : {}),
        ...(scepter ? { scepter } : {}),
        ...(shard ? { shard } : {}),
      });
    }
    heroes[id] = list;
    if (innates.length) innateUpgrades[id] = innates;
    const ult = en.abilities.find((a) => a.type === 1);
    if (!ult) return;
    const zhUlt = zh.abilities.find((a) => a.name === ult.name);
    ultimates[id] = { key: ult.name, en: ult.name_loc, zh: zhUlt?.name_loc ?? ult.name_loc, cd: ult.cooldowns };
  }));
}
// Preserve deterministic numeric hero-id ordering in the committed JSON.
const sortedObj = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => Number(a) - Number(b)));
const od = async (name) => (await fetch(`https://api.opendota.com/api/constants/${name}`)).json();
const [heroAbilities, abilities] = [await od('hero_abilities'), await od('abilities')];
// Passive ultimates are never "cast": the fight audit must skip them.
for (const u of Object.values(ultimates)) {
  const b = abilities[u.key]?.behavior;
  if ((Array.isArray(b) ? b : [b]).includes('Passive')) u.passive = true;
}
const DT = { Physical: 'P', Magical: 'M', Pure: 'U' };
const dmg_types = {};
for (const { abilities: list } of Object.values(heroAbilities)) {
  for (const key of list) {
    const code = DT[abilities[key]?.dmg_type];
    if (code) dmg_types[key] = code;
  }
}
// Merge, never drop: matches from older patches still reference abilities a
// later patch removed (e.g. juggernaut_swift_slash), and their damage must
// keep its type.
let previous = {};
try { previous = JSON.parse(readFileSync(OUT, 'utf8')); } catch { previous = {}; }
const mergedInnate = { ...(previous.innate_upgrades ?? {}) };
for (const id of ids) {
  if (innateUpgrades[id]?.length) mergedInnate[id] = innateUpgrades[id];
  else delete mergedInnate[id];
}
const merged = {
  ultimates: sortedObj({ ...(previous.ultimates ?? {}), ...ultimates }),
  dmg_types: { ...(previous.dmg_types ?? {}), ...dmg_types },
  heroes: sortedObj({ ...(previous.heroes ?? {}), ...heroes }),
  granted: Object.fromEntries(Object.entries({ ...(previous.granted ?? {}), ...granted }).sort(([a], [b]) => a.localeCompare(b))),
  innate_upgrades: sortedObj(mergedInnate),
};
writeFileSync(OUT, `${JSON.stringify({ source: 'Valve datafeed herodata + OpenDota constants', patch: NAMES.patch, ...merged }, null, 0)}\n`);
console.log(`wrote ${Object.keys(merged.ultimates).length} ultimates, ${Object.keys(merged.dmg_types).length} damage types (${Object.keys(dmg_types).length} current), ${Object.keys(merged.heroes).length} heroes' abilities, ${Object.keys(merged.granted).length} shard/scepter/innate abilities, ${Object.keys(merged.innate_upgrades).length} heroes' innate Scepter/Shard upgrades`);
