import React from 'react';
import type { LocaleKey } from './locales';

export function NavIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden="true">
      <rect x="4" y="4" width="56" height="56" rx="13" fill="#0e1219" stroke="#e5ae4e" strokeOpacity="0.45" strokeWidth="2.5" />
      <polygon points="9,55 9,28 36,55" fill="#52c972" fillOpacity="0.22" />
      <polygon points="55,9 28,9 55,36" fill="#e86452" fillOpacity="0.22" />
      <path d="M12 52 L52 12" stroke="#e5ae4e" strokeWidth="3.5" strokeLinecap="round" />
      <circle cx="17" cy="47" r="4" fill="#52c972" />
      <circle cx="47" cy="17" r="4" fill="#e86452" />
    </svg>
  );
}

export interface ToolCardProps {
  toolName: string;
  block: any;
  t: (key: LocaleKey) => string;
  openPath: (path: string) => void;
}

const TOOL_TITLES: Record<string, { en: string; zh: string }> = {
  dota2ai_replay_review: { en: 'dota2.ai · Replay Review', zh: 'dota2.ai · 录像深度复盘' },
  dota2ai_recent_matches: { en: 'dota2.ai · Recent Games', zh: 'dota2.ai · 最近比赛' },
  dota2ai_coach_report: { en: 'dota2.ai · Match Report', zh: 'dota2.ai · 对局报告' },
  dota2ai_coach_cases: { en: 'dota2.ai · Pro Cases', zh: 'dota2.ai · 职业正反例' },
  dota2ai_coach_ask: { en: 'dota2.ai · Coach Q&A', zh: 'dota2.ai · 追问教练' },
  dota2ai_goal_check: { en: 'dota2.ai · Goal Check', zh: 'dota2.ai · 目标核验' },
  dota2ai_hero_matchup: { en: 'dota2.ai · Hero Matchup', zh: 'dota2.ai · 英雄对位' },
};

export const ToolCard: React.FC<ToolCardProps> = ({ toolName, block, t, openPath }) => {
  const isZh = t('open').includes('打开');
  const head = block?.call ?? block;
  let matchId: string | null = null;
  let hero: string | null = null;
  let account: string | null = null;
  let lang: string = isZh ? 'zh' : 'en';

  try {
    const rawArgs = typeof head?.argsRaw === 'string'
      ? JSON.parse(head.argsRaw)
      : (head?.arguments && typeof head.arguments === 'object' ? head.arguments : null);
    if (rawArgs && typeof rawArgs === 'object') {
      if (rawArgs.match_id != null && /^[1-9]\d{0,12}$/.test(String(rawArgs.match_id))) {
        matchId = String(rawArgs.match_id);
      }
      if (typeof rawArgs.hero === 'string' && rawArgs.hero.trim()) {
        hero = rawArgs.hero.trim().toLowerCase().replace(/^npc_dota_hero_/, '').replace(/[\s-]+/g, '_');
      }
      if (typeof rawArgs.account === 'string' && /^\d{1,10}$/.test(rawArgs.account.trim())) {
        account = rawArgs.account.trim();
      }
      if (rawArgs.lang === 'zh' || rawArgs.lang === 'en') {
        lang = rawArgs.lang;
      }
    }
  } catch {
    // Partial streaming arguments; ignore until complete.
  }

  const content = Array.isArray(block?.content)
    ? block.content
    : Array.isArray(block?.result?.content)
      ? block.result.content
      : [];
  const rawText = content.map((c: any) => (c?.type === 'text' ? c.text : '')).join('\n');
  let verdict: string | null = null;
  let statusBadge: string | null = null;

  if (rawText) {
    try {
      const parsed = JSON.parse(rawText);
      if (parsed && typeof parsed === 'object') {
        if (typeof parsed.hero === 'string' && !hero) hero = parsed.hero;
        if (typeof parsed.verdict === 'string' && parsed.verdict) verdict = parsed.verdict;
        if (parsed.status === 'ready') statusBadge = t('statusReady');
        else if (parsed.status === 'parsing' || parsed.status === 'reviewing') statusBadge = t('statusWorking');
        else if (parsed.status === 'pick_hero') statusBadge = t('statusPick');
      }
    } catch {
      // Plain text error or non-JSON content.
    }
  }

  const targetPath = matchId
    ? `/r/${encodeURIComponent(matchId)}?lang=${lang}${hero && /^[a-z0-9_]+$/.test(hero) ? `&hero=${encodeURIComponent(hero)}` : ''}`
    : account
      ? `/p/${encodeURIComponent(account)}?lang=${lang}`
      : `/?lang=${lang}`;

  const titlePair = TOOL_TITLES[toolName];
  const title = titlePair ? (isZh ? titlePair.zh : titlePair.en) : toolName;

  return (
    <div className="dota2ai-tool-card">
      <div className="dota2ai-tool-head">
        <span className="dota2ai-tool-brand">
          <NavIcon size={16} />
          <strong>{title}</strong>
          {matchId && <span className="dota2ai-tool-id">#{matchId}</span>}
          {statusBadge && <span className="dota2ai-tool-badge">{statusBadge}</span>}
        </span>
        <button type="button" className="dota2ai-tool-open" onClick={() => openPath(targetPath)}>
          {matchId || account ? t('open') : t('openHome')} →
        </button>
      </div>
      {verdict && <p className="dota2ai-tool-verdict">{verdict}</p>}
      {(rawText || head?.argsRaw) && (
        <details className="dota2ai-tool-details">
          <summary>{t('details')}</summary>
          <pre>{rawText || String(head?.argsRaw ?? '')}</pre>
        </details>
      )}
    </div>
  );
};
