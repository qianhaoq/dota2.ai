import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { MessageSquare } from 'lucide-react';
import TopBarFeedbackModal from '../../app/FeedbackModal';
import { useI18n } from '../i18n/I18nProvider';
import { buildCarryQuery } from '../carryQuery';
import { SAMPLE_MATCH_ID } from './EmptyState';
import type { DictKey } from '../i18n/en';

const SURFACE_TABS: DictKey[] = ['tab_web', 'tab_cli', 'tab_discord', 'tab_dev'];

/**
 * V2 TopBar (handoff §3): logo, "Sample data" badge (only while viewing the
 * sample/golden match `/m/9035042364` — hidden on home and real matches),
 * surface tabs (Web/CLI/Discord/For AI & Devs — non-functional placeholders),
 * Feedback (opens the existing on-site FeedbackModal), a small "Classic" link
 * to the legacy app, EN/中文 toggle, New button. Tabs are hidden below `lg`
 * and Classic below `sm` so the bar never overflows at 390px. Tap targets
 * ≥44px.
 */
const TopBar: React.FC = () => {
  const { lang, setLang, t } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();
  const [feedbackOpen, setFeedbackOpen] = useState(false);

  const onSampleMatch = location.pathname === `/m/${SAMPLE_MATCH_ID}`;

  const goNew = () => {
    navigate({ pathname: '/new', search: buildCarryQuery(location.search, lang) });
  };

  return (
    <header className="flex-none border-b border-d2-line bg-d2-surface/90 backdrop-blur z-30">
      <div className="h-[52px] flex items-center gap-[8px] px-[8px] sm:px-[16px] max-w-[1280px] mx-auto min-w-0">
        <div className="flex items-center gap-[8px] font-semibold text-d2-15 tracking-[-0.01em] whitespace-nowrap text-d2-ink">
          <span className="w-[24px] h-[24px] rounded-[7px] bg-d2-ink grid place-items-center" aria-hidden="true">
            <svg width="12" height="12" viewBox="0 0 24 24">
              <path d="M12 2l2.6 7.4L22 12l-7.4 2.6L12 22l-2.6-7.4L2 12l7.4-2.6z" fill="#fff" />
            </svg>
          </span>
          dota2.ai
        </div>
        {onSampleMatch && (
          <span
            className="hidden xs:inline-flex items-center h-[24px] px-[8px] rounded-d2-chip bg-[#FFFBEB] text-d2-warn text-d2-12 font-semibold whitespace-nowrap"
            title={t('sampleTitle')}
          >
            {t('samplePill')}
          </span>
        )}
        <div className="flex-1" />
        {/* Surface tabs: placeholders for the proposed CLI/Discord/Dev surfaces.
            Hidden on small screens so the bar fits 390px. */}
        <nav className="hidden lg:flex gap-[4px] p-[4px] bg-d2-surface-2 rounded-d2-chip" aria-label="Surfaces">
          {SURFACE_TABS.map((key, i) => (
            <button
              key={key}
              type="button"
              title={i === 0 ? undefined : t('tabsProposed')}
              aria-selected={i === 0}
              aria-disabled={i !== 0}
              onClick={i === 0 ? undefined : (e) => e.preventDefault()}
              className={`h-[32px] px-[14px] rounded-d2-chip text-d2-13 font-medium whitespace-nowrap transition-colors duration-d2-fast ${
                i === 0
                  ? 'bg-d2-surface text-d2-ink shadow-d2-1 font-semibold'
                  : 'text-d2-ink-3 cursor-default'
              }`}
            >
              {t(key)}
            </button>
          ))}
        </nav>
        <div className="flex-1 hidden lg:block" />
        <Link
          to="/legacy"
          className="hidden sm:inline-flex items-center min-h-[44px] px-[8px] rounded-[12px] text-d2-13 font-medium text-d2-ink-3 transition-colors duration-d2-fast hover:bg-d2-surface-2 whitespace-nowrap"
        >
          {t('classicBtn')}
        </Link>
        <button
          type="button"
          onClick={() => setFeedbackOpen(true)}
          aria-label={t('feedbackAria')}
          title={t('feedbackBtn')}
          className="min-w-[44px] min-h-[44px] rounded-[12px] grid place-items-center text-d2-ink-3 flex-none transition-colors duration-d2-fast hover:bg-d2-surface-2"
        >
          <MessageSquare size={17} aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() => setLang(lang === 'en' ? 'zh' : 'en')}
          aria-label={t('langAria')}
          className="min-w-[44px] min-h-[44px] px-[8px] rounded-[12px] grid place-items-center text-d2-ink-2 font-semibold text-d2-13 flex-none transition-colors duration-d2-fast hover:bg-d2-surface-2"
        >
          {t('langBtn')}
        </button>
        <button
          type="button"
          onClick={goNew}
          aria-label={t('newReview')}
          title={t('newReview')}
          className="min-w-[44px] min-h-[44px] rounded-[12px] grid place-items-center text-d2-ink-3 flex-none transition-colors duration-d2-fast hover:bg-d2-surface-2"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      {/* The modal's fixed overlay must not be contained by this header's
          backdrop-blur — portal it to <body> (no-op render when there is no
          document, e.g. SSR). */}
      {typeof document !== 'undefined' &&
        createPortal(
          <TopBarFeedbackModal lang={lang} isOpen={feedbackOpen} onClose={() => setFeedbackOpen(false)} />,
          document.body,
        )}
    </header>
  );
};

export default TopBar;
