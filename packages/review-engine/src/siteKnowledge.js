import { Ajv } from 'ajv';
import schema from './schema/site-knowledge.v1.json' with { type: 'json' };

/** @typedef {{id:string,kind:'fact'|'principle',title:string,summary:string,hero:string,patch:string,stamp:string,source_url:string,source_date:string,content_hash:string,locator:string,verification:string}} SiteKnowledgeEntry */
/** @typedef {{schema:string,generated_at:string,entries:SiteKnowledgeEntry[]}} SiteKnowledgeSnapshot */
const ajv = new Ajv({allErrors:true,strict:true});
const validSnapshot = /** @type {import('ajv').ValidateFunction<SiteKnowledgeSnapshot>} */ (ajv.compile(schema));
const validEntry = /** @type {import('ajv').ValidateFunction<SiteKnowledgeEntry>} */ (ajv.compile(schema.$defs.entry));
const publicHosts = new Set(['bilibili.com','www.bilibili.com','youtube.com','www.youtube.com','youtu.be','reddit.com','www.reddit.com','old.reddit.com','dota2.com','www.dota2.com']);
const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
/** @param {unknown} entry @returns {entry is SiteKnowledgeEntry} */
const safeEntry = entry => {
  if (!validEntry(entry) || !timestamp(entry.source_date)) return false;
  try {
    const url = new URL(entry.source_url);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && publicHosts.has(url.hostname) &&
      [...url.searchParams.keys()].every(key => ['v','t','start'].includes(key));
  } catch { return false; }
};

/** Versioned, explicitly curated public material. Unknown fields are rejected. */
export function parseSiteKnowledge(snapshot) {
  if (!validSnapshot(snapshot) || !timestamp(snapshot.generated_at) ||
      !snapshot.entries.every(safeEntry) || new Set(snapshot.entries.map(e=>e.id)).size !== snapshot.entries.length)
    throw new TypeError('Invalid public site knowledge snapshot');
  return structuredClone(snapshot.entries);
}

/** Contextual learning citations do not turn material into a verified match claim. */
export function attachSiteKnowledge(review, entries = []) {
  const insight = review.insights.find(i=>i.id === 'next_game' && i.status === 'ok');
  if (!review.player || review.state !== 'parsed' || !insight || !Array.isArray(entries)) return review;
  const used = new Set();
  for (const entry of entries.filter(safeEntry)) {
    if (used.size === 3) break;
    if (used.has(entry.id) || (entry.hero && entry.hero !== review.player.hero) ||
        (entry.kind === 'fact' && (review.match.patch == null || entry.patch === 'unknown' || entry.patch !== String(review.match.patch)))) continue;
    used.add(entry.id);
    const citation = `kb:${entry.id}`, id = `kb.${entry.id}`;
    review.facts[id] = {id,kind:'entity',value:{title:entry.title,summary:entry.summary,locator:entry.locator,patch:entry.patch,verification:entry.verification},
      display:{en:entry.summary,zh:entry.summary},citation,source_path:`export/site/${entry.id}`};
    review.citations.push({id:citation,provider:'kb',url:entry.source_url,fetched_at:entry.source_date,source_date:entry.source_date,
      ref:entry.id,patch:entry.patch,fields:[`export/site/${entry.id}`]});
    insight.citations = [...insight.citations,citation];
  }
  return review;
}
