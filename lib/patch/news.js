/**
 * The home page's patch news, live from Valve's datafeed (www.dota2.com/datafeed):
 * the current major patch, its new items, a few highlights, and the newest
 * letter update after it.
 *
 * Every line shown is Valve's own (en + schinese), labelled with Valve's own
 * hero / item name. The model only *chooses*: it is given numbered lines and
 * returns ids; an id it invents is dropped, and it never writes a word the
 * reader sees. Its choice is kept per patch in `store` (GCS in production), so
 * one patch costs one model call across all instances.
 *
 * Nothing here blocks on the model: until a choice exists the news goes out
 * without highlights (`picking: true`), and the choice is made in the
 * background. Valve is asked for the patch list at most once per `ttlMs`; the
 * notes and names only when the newest patch changes.
 */

const FEED = 'https://www.dota2.com/datafeed';
const PICKS = 5;
/** A new major's benchmarks lag for its first weeks; after that the line is dropped. */
const LAG_DAYS = 30;

export const majorOf = (name) => String(name ?? '').match(/^\d+\.\d+/)?.[0] ?? null;
export const patchDate = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);
const text = (s) => String(s ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
const isNewItem = (title) => /\bNew Item\b/i.test(text(title));

/** id → { en, zh } from a schinese datafeed list (name_loc is Chinese, name_english_loc English). */
export function namesById(rows) {
  const out = new Map();
  for (const r of rows ?? []) if (Number.isInteger(r?.id)) out.set(r.id, { en: text(r.name_english_loc) || null, zh: text(r.name_loc) || null, name: r.name ?? null });
  return out;
}

/**
 * The lines the model may choose from, in Valve's order, each with a stable id:
 * general notes (g), item and neutral item notes (i, n), hero-level notes (h).
 * Ability and talent notes are left out: too fine for a home page.
 * en and zh are walked together; a zh line that is missing, or still Valve's
 * English (not yet translated), is null.
 */
export function candidates(en, zh, names) {
  const out = [];
  const add = (id, enNote, zhNote, label) => {
    const e = text(enNote?.note);
    if (!e || enNote?.hide_dot || (enNote?.indent_level ?? 1) > 1) return;
    const z = text(zhNote?.note);
    const lbl = label ?? { en: null, zh: null };
    const said = (label, line) => label && !line.toLowerCase().startsWith(label.toLowerCase());
    out.push({
      id,
      en: said(lbl.en, e) ? `${lbl.en}: ${e}` : e,
      zh: z && z !== e ? (said(lbl.zh, z) ? `${lbl.zh}：${z}` : z) : null,
    });
  };
  // General notes: a line takes the subtitle above it (Valve's "Roshan", "Gold and Experience") as its label.
  (en?.general_notes ?? []).forEach((s, i) => {
    let sub;
    (s?.generic ?? []).forEach((n, j) => {
      const zn = zh?.general_notes?.[i]?.generic?.[j];
      if (/class="Subtitle"/.test(n?.note ?? '')) {
        const e = text(n.note); const z = text(zn?.note);
        sub = e ? { en: e, zh: z && z !== e ? z : null } : undefined;
        return;
      }
      add(`g${i}.${j}`, n, zn, sub);
    });
  });
  for (const [section, tag] of [['items', 'i'], ['neutral_items', 'n']]) {
    (en?.[section] ?? []).forEach((it, i) => {
      const zit = zh?.[section]?.[i];
      const label = zit?.ability_id === it?.ability_id ? names.items.get(it?.ability_id) : null;
      (it?.ability_notes ?? []).forEach((n, j) => add(`${tag}${i}.${j}`, n, zit?.ability_notes?.[j], label ?? undefined));
    });
  }
  (en?.heroes ?? []).forEach((h, i) => {
    const zh_ = zh?.heroes?.[i];
    const label = zh_?.hero_id === h?.hero_id ? names.heroes.get(h?.hero_id) : null;
    (h?.hero_notes ?? []).forEach((n, j) => add(`h${i}.${j}`, n, zh_?.hero_notes?.[j], label ?? undefined));
  });
  return out;
}

/** Items Valve marks "New Item" in a patch's notes. */
export function newItems(en, items) {
  const out = [];
  for (const it of en?.items ?? []) {
    if (!isNewItem(it?.title)) continue;
    const n = items.get(it.ability_id);
    if (!n?.name?.startsWith('item_') || !n.en) continue;
    out.push({ key: n.name.slice(5), en: n.en, zh: n.zh ?? n.en });
  }
  return out;
}

export const countChanges = (notes) => {
  const len = (x) => (Array.isArray(x) ? x.length : 0);
  return { heroes: len(notes?.heroes), items: len(notes?.items) + len(notes?.neutral_items) };
};

/** Keep only ids that are among the candidates, once each, at most PICKS. */
export function validPicks(ids, cands) {
  const known = new Set(cands.map((c) => c.id));
  const out = [];
  for (const id of Array.isArray(ids) ? ids : []) if (typeof id === 'string' && known.has(id) && !out.includes(id)) out.push(id);
  return out.slice(0, PICKS);
}

export const PICK_SYSTEM = [
  'You choose the highlights of a Dota 2 patch for a coaching site\'s home page.',
  `From the numbered patch-note lines, choose the ${PICKS} changes that most change how an ordinary ranked game is played`,
  '(economy, map, objectives, broad hero or item mechanics) — prefer changes that affect many games over one hero\'s numbers.',
  'Prefer lines marked [zh] (they have a Chinese translation). Do not choose two lines about the same thing.',
  `Reply with JSON only: {"ids": ["<id>", ...]} — exactly ${PICKS} ids from the list, most important first. No other text.`,
].join(' ');

export const pickPrompt = (version, cands) => `Patch ${version}\n${cands.map((c) => `${c.id}${c.zh ? ' [zh]' : ''} | ${c.en}`).join('\n')}`;

export function parsePicks(reply) {
  const m = String(reply ?? '').match(/\{[\s\S]*\}/);
  if (!m) return [];
  try { return JSON.parse(m[0])?.ids ?? []; } catch { return []; }
}

/**
 * @param {{
 *   fetchJson?: (url: string) => Promise<any>,
 *   complete?: Function | null,
 *   store?: { get: (k: string) => Promise<any>, put: (k: string, v: any) => Promise<void> } | null,
 *   now?: () => number,
 *   ttlMs?: number,
 *   pickWaitMs?: number,
 *   log?: (msg: string) => void,
 * }} deps
 */
export function createPatchNews(deps = {}) {
  const fetchJson = deps.fetchJson ?? (async (url) => {
    const res = await fetch(url, { headers: { 'user-agent': 'dota2.ai patch news' }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return res.json();
  });
  const now = deps.now ?? Date.now;
  const ttlMs = deps.ttlMs ?? 30 * 60_000;
  const log = deps.log ?? (() => {});
  const { complete = null, store = null } = deps;

  let built = null; // { latest, news, cands, picks }
  let checkedAt = -Infinity;
  let refreshing = null;
  const picking = new Map(); // major → promise
  const pickFailedAt = new Map();

  const notes = (version, lang) => fetchJson(`${FEED}/patchnotes?version=${encodeURIComponent(version)}&language=${lang}`);

  async function build(list) {
    const latest = list.at(-1);
    const major = majorOf(latest.patch_name);
    const majorIdx = list.findIndex((p) => p.patch_name === major);
    if (majorIdx < 0) throw new Error(`major ${major} not in the patch list`);
    const majorRow = list[majorIdx];
    const prevMajor = majorOf(list.slice(0, majorIdx).reverse().find((p) => majorOf(p.patch_name) !== major)?.patch_name);
    const [en, zh, items, heroes] = await Promise.all([
      notes(major, 'english'), notes(major, 'schinese'),
      fetchJson(`${FEED}/itemlist?language=schinese`), fetchJson(`${FEED}/herolist?language=schinese`),
    ]);
    if (en?.patch_name !== major) throw new Error(`notes for ${major}: unexpected shape`);
    const names = { items: namesById(items?.result?.data?.itemabilities), heroes: namesById(heroes?.result?.data?.heroes) };
    const cands = candidates(en, zh?.patch_name === major ? zh : null, names);
    let update = null;
    if (latest.patch_name !== major) {
      const u = await notes(latest.patch_name, 'english');
      update = { version: latest.patch_name, date: patchDate(latest.patch_timestamp), url: `https://www.dota2.com/patches/${latest.patch_name}`, changes: countChanges(u) };
    }
    const date = patchDate(majorRow.patch_timestamp);
    const news = {
      version: major,
      date,
      url: `https://www.dota2.com/patches/${major}`,
      newItems: newItems(en, names.items),
      update,
    };
    return { latest: latest.patch_name, major, prevMajor, releasedMs: majorRow.patch_timestamp * 1000, news, cands };
  }

  async function pick(b) {
    if (picking.has(b.major)) return picking.get(b.major);
    const p = (async () => {
      const key = `patch-news-${b.major}.json`;
      const kept = validPicks((await store?.get(key).catch(() => null))?.ids, b.cands);
      if (kept.length >= 3) return kept;
      if (!complete || !b.cands.length) return null;
      if (now() - (pickFailedAt.get(b.major) ?? -Infinity) < ttlMs) return null;
      try {
        const reply = await complete({ system: PICK_SYSTEM, messages: [{ role: 'user', content: pickPrompt(b.major, b.cands) }], tools: [], signal: AbortSignal.timeout(90_000) });
        const ids = validPicks(parsePicks(reply?.text), b.cands);
        if (ids.length < 3) throw new Error(`model chose ${ids.length} valid lines`);
        await store?.put(key, { version: b.major, ids, chosen: new Date(now()).toISOString() }).catch((err) => log(`keeping the choice failed: ${err?.message ?? err}`));
        return ids;
      } catch (err) {
        pickFailedAt.set(b.major, now());
        log(`choosing ${b.major} highlights failed: ${err?.message ?? err}`);
        return null;
      }
    })().finally(() => picking.delete(b.major));
    picking.set(b.major, p);
    return p;
  }

  /** Starts (or joins) the choice; waits for it at most `waitMs` — a kept choice is quick, a model call is not. */
  async function apply(b, waitMs) {
    const p = pick(b).then((ids) => { if (ids && built === b) b.picks = ids; }).catch(() => {});
    await Promise.race([p, new Promise((r) => setTimeout(r, waitMs).unref?.())]);
  }

  async function refresh() {
    const list = (await fetchJson(`${FEED}/patchnoteslist?language=english`))?.patches;
    if (!Array.isArray(list) || !list.length || !list.every((p) => typeof p?.patch_name === 'string' && Number.isFinite(p?.patch_timestamp))) throw new Error('patch list: unexpected shape');
    checkedAt = now();
    if (built?.latest === list.at(-1).patch_name) return built;
    const b = await build(list);
    if (built?.major === b.major && built.picks) b.picks = validPicks(built.picks, b.cands);
    built = b;
    log(`patch news: ${b.latest}`);
    return b;
  }

  /** Worked out on every answer, not when built: an instance may serve the same patch past day 30. */
  const forCoach = (b) => (b.prevMajor && now() - b.releasedMs < LAG_DAYS * 86_400_000 ? {
    en: `For the first weeks of ${b.major}, most same-hero benchmarks and pro games are still from ${b.prevMajor} — read item-timing comparisons as a rough guide.`,
    zh: `${b.major} 版本前几周，同英雄对比和职业案例大多还来自 ${b.prevMajor}——装备时间类对比请当作粗略参考。`,
    ru: `В первые недели патча ${b.major} большинство сравнений по героям и про-игр всё ещё из ${b.prevMajor} — относитесь к таймингам предметов как к ориентиру.`,
  } : null);

  /** The news, or null when Valve has not answered yet. Never throws. */
  async function get() {
    if (now() - checkedAt >= ttlMs && !refreshing) {
      refreshing = refresh().catch((err) => { log(`patch news refresh failed: ${err?.message ?? err}`); checkedAt = now() - ttlMs + 60_000; return built; })
        .finally(() => { refreshing = null; });
    }
    const b = built ?? await refreshing;
    if (!b) return null;
    if (!b.picks) await apply(b, deps.pickWaitMs ?? 1500);
    const byId = new Map(b.cands.map((c) => [c.id, c]));
    const highlights = (b.picks ?? []).map((id) => byId.get(id)).filter(Boolean).map((c) => ({ en: c.en, zh: c.zh }));
    return { ...b.news, forCoach: forCoach(b), highlights, picking: !b.picks };
  }

  return { get };
}
