/**
 * Link previews for shared reviews (X, Discord, WeChat, Slack…). Crawlers do
 * not run JavaScript, so /r/:matchId answers with index.html whose <head>
 * already names the match and the coach's biggest lever.
 *
 * Pure: report in, tags out. Never includes player names or account ids —
 * a shared link previews the game, not the people in it.
 */

import { heroInfo } from './analyze.js';

export const SITE = 'https://dota2.ai';
/**
 * The card shown when a link has no picture of its own (the home page, a whole match): without one, QQ,
 * Discord and X show a bare line of text. Made from scripts/og-card.html (1200×630).
 */
export const DEFAULT_IMAGE = `${SITE}/og-card.png`;
const clock = (sec) => `${Math.floor(sec / 60)}:${String(Math.round(sec) % 60).padStart(2, '0')}`;

export const GENERIC = {
  en: {
    title: 'dota2.ai — a Dota 2 post-match coach that shows its evidence',
    description: 'Paste a match ID, pick your hero, get the two or three things most worth fixing — each with the numbers behind it and what to do next game.',
  },
  zh: {
    title: 'dota2.ai — 拿证据说话的 Dota 2 赛后教练',
    description: '贴一个比赛 ID，选你玩的英雄，得到最值得改的两三件事：每条都附依据，并告诉你下一局怎么做。',
  },
  ru: {
    title: 'dota2.ai — тренер по Dota 2, который разбирает реплей с фактами',
    description: 'Вставьте ID матча, выберите своего героя и получите 2–3 главные ошибки с доказательствами из реплея и планом на следующую игру.',
  },
};

/** A preview line is short: the verdict is cut at a word (or, in Chinese, a character) with an ellipsis. */
const clip = (s, max = 180) => {
  const t = String(s).replace(/\s+/g, ' ').trim();
  if ([...t].length <= max) return t;
  const cut = [...t].slice(0, max).join('');
  const at = cut.lastIndexOf(' ');
  return `${(at > max * 0.6 ? cut.slice(0, at) : cut).replace(/[\s,，、;；:：.。]+$/, '')}…`;
};

/**
 * @param {object} report  buildCoachReport() output
 * @param {{ slot?: number | null, lang?: 'en' | 'zh', url: string, verdict?: string | null }} opts
 *   `verdict`: the coach's one-line verdict from this player's finished review, when there is one; it is what
 *   the link is worth opening for, so it leads the description.
 */
export function previewMeta(report, { slot = null, lang = 'en', url, verdict = null }) {
  const zh = lang === 'zh';
  const ru = lang === 'ru';
  const hLang = zh ? 'zh' : 'en';
  const m = report.match;
  const winner = m.radiant_win
    ? (zh ? '天辉胜利' : ru ? 'Победа Сил Света' : 'Radiant victory')
    : (zh ? '夜魇胜利' : ru ? 'Победа Сил Тьмы' : 'Dire victory');
  const line = `${winner} ${m.score[0]}–${m.score[1]} · ${clock(m.duration)}${m.patch ? ` · ${m.patch}` : ''}`;
  const player = slot != null ? report.players.find((p) => p.slot === slot) : null;
  const review = player ? report.reviews.find((r) => r.slot === slot) : null;
  if (player && review) {
    const hero = player.hero?.[hLang] ?? heroInfo(player.hero?.id)[hLang];
    const result = review.won ? (zh ? '胜' : ru ? 'победа' : 'win') : (zh ? '负' : ru ? 'поражение' : 'loss');
    return {
      title: zh
        ? `${hero} ${player.kda.join('/')}（${result}）· #${m.id} 复盘 — dota2.ai`
        : ru
          ? `${hero} ${player.kda.join('/')} (${result}) · разбор #${m.id} — dota2.ai`
          : `${hero} ${player.kda.join('/')} (${result}) · #${m.id} review — dota2.ai`,
      description: `${typeof verdict === 'string' && verdict.trim() ? clip(verdict) : (review.headline[lang] ?? review.headline.en)} ${line}`,
      image: player.hero?.img ?? null,
      url,
    };
  }
  const heroes = (radiant) => report.players.filter((p) => p.radiant === radiant).map((p) => p.hero?.[hLang]).filter(Boolean).join(zh ? '、' : ', ');
  return {
    title: zh
      ? `#${m.id} ${winner} ${m.score[0]}–${m.score[1]} · 这局的复盘 — dota2.ai`
      : ru
        ? `#${m.id} ${winner} ${m.score[0]}–${m.score[1]} · разбор матча — dota2.ai`
        : `#${m.id} ${winner} ${m.score[0]}–${m.score[1]} · match review — dota2.ai`,
    description: zh
      ? `${line}。天辉：${heroes(true)}；夜魇：${heroes(false)}。选你玩的英雄，看最值得改的事。`
      : ru
        ? `${line}. Силы Света: ${heroes(true)}. Силы Тьмы: ${heroes(false)}. Выберите своего героя, чтобы увидеть главные ошибки.`
        : `${line}. Radiant: ${heroes(true)}. Dire: ${heroes(false)}. Pick your hero to see what to fix.`,
    image: null,
    url,
  };
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Replace <title> and add description / Open Graph / Twitter / schema.org tags. QQ's link card reads the
 * `itemprop` ones (name, description, image), not Open Graph. A link with no picture of its own gets the
 * site card.
 */
export function injectMeta(html, meta) {
  meta = { ...meta, image: meta.image ?? DEFAULT_IMAGE };
  const tags = [
    `<meta name="description" content="${esc(meta.description)}" />`,
    `<meta property="og:site_name" content="dota2.ai" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:title" content="${esc(meta.title)}" />`,
    `<meta property="og:description" content="${esc(meta.description)}" />`,
    meta.url ? `<meta property="og:url" content="${esc(meta.url)}" />` : '',
    meta.image ? `<meta property="og:image" content="${esc(meta.image)}" />` : '',
    `<meta name="twitter:card" content="${meta.image ? 'summary_large_image' : 'summary'}" />`,
    `<meta name="twitter:title" content="${esc(meta.title)}" />`,
    `<meta name="twitter:description" content="${esc(meta.description)}" />`,
    meta.image ? `<meta name="twitter:image" content="${esc(meta.image)}" />` : '',
    `<meta itemprop="name" content="${esc(meta.title)}" />`,
    `<meta itemprop="description" content="${esc(meta.description)}" />`,
    meta.image ? `<meta itemprop="image" content="${esc(meta.image)}" />` : '',
  ].filter(Boolean).join('\n    ');
  // Drop tags this function owns (the static defaults in index.html) first.
  const stripped = html
    .replace(/<title>[\s\S]*?<\/title>/i, '')
    .replace(/\s*<meta\s+(?:name|property)="(?:description|og:[a-z_]+|twitter:[a-z_]+)"[^>]*>/gi, '')
    .replace(/\s*<meta\s+itemprop="(?:name|description|image)"[^>]*>/gi, '');
  return stripped.replace(/<\/head>/i, `    <title>${esc(meta.title)}</title>\n    ${tags}\n  </head>`);
}

/**
 * Canonical share URL (no tracking params). A review page link names its player by `hero` (and the plan the
 * review was read against, and the model that wrote it when it is not the default one); older links by seat (`p`, with an optional role override `pos`).
 * @param {number} matchId
 * @param {{ slot?: number | null, pos?: number | null, hero?: string | null, plan?: string | null, model?: string | null, lang?: string | null }} [opts]
 */
export function shareUrl(matchId, { slot = null, pos = null, hero = null, plan = null, model = null, lang = null } = {}) {
  const q = new URLSearchParams();
  if (hero) {
    q.set('hero', hero);
    if (plan) q.set('plan', plan);
    if (model) q.set('model', model);
  } else if (slot != null) {
    q.set('p', String(slot));
    if (pos != null) q.set('pos', String(pos));
  }
  if (lang) q.set('lang', lang);
  const s = q.toString();
  return `${SITE}/r/${matchId}${s ? `?${s}` : ''}`;
}
