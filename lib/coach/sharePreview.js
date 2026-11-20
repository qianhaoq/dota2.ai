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
};

/**
 * @param {object} report  buildCoachReport() output
 * @param {{ slot?: number | null, lang?: 'en' | 'zh', url: string }} opts
 */
export function previewMeta(report, { slot = null, lang = 'en', url }) {
  const zh = lang === 'zh';
  const m = report.match;
  const winner = m.radiant_win ? (zh ? '天辉胜利' : 'Radiant victory') : (zh ? '夜魇胜利' : 'Dire victory');
  const line = `${winner} ${m.score[0]}–${m.score[1]} · ${clock(m.duration)}${m.patch ? ` · ${m.patch}` : ''}`;
  const player = slot != null ? report.players.find((p) => p.slot === slot) : null;
  const review = player ? report.reviews.find((r) => r.slot === slot) : null;
  if (player && review) {
    const hero = player.hero?.[lang] ?? heroInfo(player.hero?.id)[lang];
    const result = review.won ? (zh ? '胜' : 'win') : (zh ? '负' : 'loss');
    return {
      title: zh ? `${hero} ${player.kda.join('/')}（${result}）· #${m.id} 复盘 — dota2.ai` : `${hero} ${player.kda.join('/')} (${result}) · #${m.id} review — dota2.ai`,
      description: `${review.headline[lang]} ${line}`,
      image: player.hero?.img ?? null,
      url,
    };
  }
  const heroes = (radiant) => report.players.filter((p) => p.radiant === radiant).map((p) => p.hero?.[lang]).filter(Boolean).join(zh ? '、' : ', ');
  return {
    title: zh ? `#${m.id} ${winner} ${m.score[0]}–${m.score[1]} · 这局的复盘 — dota2.ai` : `#${m.id} ${winner} ${m.score[0]}–${m.score[1]} · match review — dota2.ai`,
    description: zh
      ? `${line}。天辉：${heroes(true)}；夜魇：${heroes(false)}。选你玩的英雄，看最值得改的事。`
      : `${line}. Radiant: ${heroes(true)}. Dire: ${heroes(false)}. Pick your hero to see what to fix.`,
    image: null,
    url,
  };
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Replace <title> and add description / Open Graph / Twitter tags. */
export function injectMeta(html, meta) {
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
  ].filter(Boolean).join('\n    ');
  // Drop tags this function owns (the static defaults in index.html) first.
  const stripped = html
    .replace(/<title>[\s\S]*?<\/title>/i, '')
    .replace(/\s*<meta\s+(?:name|property)="(?:description|og:[a-z_]+|twitter:[a-z_]+)"[^>]*>/gi, '');
  return stripped.replace(/<\/head>/i, `    <title>${esc(meta.title)}</title>\n    ${tags}\n  </head>`);
}

/**
 * Canonical share URL (no tracking params).
 * @param {number} matchId
 * @param {{ slot?: number | null, pos?: number | null, lang?: string | null }} [opts]
 */
export function shareUrl(matchId, { slot = null, pos = null, lang = null } = {}) {
  const q = new URLSearchParams();
  if (slot != null) q.set('p', String(slot));
  if (slot != null && pos != null) q.set('pos', String(pos));
  if (lang) q.set('lang', lang);
  const s = q.toString();
  return `${SITE}/r/${matchId}${s ? `?${s}` : ''}`;
}
