import type { Language } from '../types';
import type { ConclusionEvidence, ThreeConclusions } from '../types/matchReview';

/**
 * View-model for the review first screen ("Where this game was lost"): three
 * conclusion cards in a fixed order with frontend-owned headings (the backend
 * `title` is never rendered), explicit insufficient handling, and sanitized
 * evidence lists. Pure logic so it can be unit-tested in node.
 */

export type ConclusionKey = 'turningPoint' | 'topMistake' | 'nextGameRule';

export interface ConclusionCardView {
  key: ConclusionKey;
  /** Frontend product label, localized (never the backend title). */
  heading: string;
  status: 'ok' | 'insufficient';
  summary: string;
  evidence: ConclusionEvidence[];
}

export const CONCLUSION_ORDER: ConclusionKey[] = ['turningPoint', 'topMistake', 'nextGameRule'];

const CONCLUSION_HEADINGS: Record<ConclusionKey, { en: string; zh: string }> = {
  turningPoint: { en: 'Turning point', zh: '转折点' },
  topMistake: { en: 'The one thing to fix', zh: '你这局最该改的一件事' },
  nextGameRule: { en: 'Do this next game', zh: '下一局照做的一条' },
};

export function conclusionHeading(key: ConclusionKey, lang: Language): string {
  return CONCLUSION_HEADINGS[key][lang === 'zh' ? 'zh' : 'en'];
}

function isValidEvidence(raw: unknown): raw is ConclusionEvidence {
  if (!raw || typeof raw !== 'object') return false;
  const ev = raw as Partial<ConclusionEvidence>;
  return typeof ev.text === 'string' && Boolean(ev.text.trim())
    && (typeof ev.time === 'string' || ev.time == null)
    && typeof ev.source === 'string';
}

function hasUsableSummary(raw: unknown): raw is { status?: unknown; summary: string; evidence?: unknown } {
  return Boolean(raw) && typeof raw === 'object'
    && typeof (raw as { summary?: unknown }).summary === 'string'
    && Boolean((raw as { summary: string }).summary.trim());
}

/**
 * Build the three conclusion cards. Returns null when the payload itself is
 * missing (old server response) so the caller falls back to the classic
 * layout; a payload missing an individual conclusion renders that card as an
 * explicit insufficient placeholder instead of disappearing.
 */
export function buildConclusionCards(
  conclusions: ThreeConclusions | null | undefined,
  lang: Language,
): ConclusionCardView[] | null {
  if (!conclusions || typeof conclusions !== 'object') return null;
  const isZh = lang === 'zh';
  const anyUsable = CONCLUSION_ORDER.some((key) => hasUsableSummary(conclusions[key]));
  if (!anyUsable) return null;

  return CONCLUSION_ORDER.map((key) => {
    const raw = conclusions[key];
    const heading = conclusionHeading(key, lang);
    if (!hasUsableSummary(raw)) {
      return {
        key,
        heading,
        status: 'insufficient',
        summary: isZh ? '数据不足' : 'Insufficient data',
        evidence: [],
      };
    }
    return {
      key,
      heading,
      status: raw.status === 'insufficient' ? 'insufficient' : 'ok',
      summary: raw.summary,
      evidence: Array.isArray(raw.evidence) ? raw.evidence.filter(isValidEvidence) : [],
    };
  });
}

/** 2–3 preset follow-up questions (empty when the payload has none). */
export function getPresetFollowUps(
  conclusions: ThreeConclusions | null | undefined,
  max = 3,
): string[] {
  if (!conclusions || !Array.isArray(conclusions.followUps)) return [];
  return conclusions.followUps
    .filter((q): q is string => typeof q === 'string' && Boolean(q.trim()))
    .slice(0, max);
}

/** First-screen heading adapts to the fact-derived outcome (never assumes a loss). */
export function conclusionScreenHeading(outcome: 'win' | 'loss' | null | undefined, lang: Language): string {
  if (outcome === 'loss') return lang === 'zh' ? '这局输在哪' : 'Where this game was lost';
  if (outcome === 'win') return lang === 'zh' ? '这局赢在哪' : 'Where this game was won';
  return lang === 'zh' ? '关键时刻' : 'Key moments';
}

const SOURCE_LABELS: Record<string, { en: string; zh: string }> = {
  advantageSwing: { en: 'Gold swing', zh: '经济逆转' },
  economy: { en: 'Gold graph', zh: '经济曲线' },
  timeline: { en: 'Objectives', zh: '目标事件' },
  deathTimeline: { en: 'Death timeline', zh: '死亡时间线' },
  players: { en: 'Scoreboard', zh: '玩家数据' },
  focusLens: { en: 'Your hero', zh: '你的英雄' },
};

/** Localized label for an evidence source id; unknown ids fall back to a generic label. */
export function evidenceSourceLabel(source: string, lang: Language): string {
  const entry = SOURCE_LABELS[source];
  if (entry) return lang === 'zh' ? entry.zh : entry.en;
  return lang === 'zh' ? '比赛数据' : 'Match data';
}
