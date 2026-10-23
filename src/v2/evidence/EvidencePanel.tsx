import React from 'react';
import { useI18n } from '../i18n/I18nProvider';

/**
 * Desktop (≥1024px) evidence rail — fixed 420px, chat column stays max 720
 * (handoff §1 screen 5). Shows an empty state until a claim is opened.
 * Below lg the aside is hidden and the bottom sheet takes over.
 */
export default function EvidencePanel({ children, open }: {
    /** EvidenceBody when a claim is open. */
    children?: React.ReactNode;
    open: boolean;
}) {
    const { t } = useI18n();
    return <aside aria-label={t('evidence')} data-testid="evidence-panel"
      className="hidden lg:flex flex-col flex-none w-[420px] border-l border-d2-line bg-d2-surface">
      {open && children
        ? <div className="flex-1 overflow-y-auto overscroll-contain">{children}</div>
        : <div className="px-[24px] py-[32px] text-d2-ink-3">
            <div className="text-d2-12 font-semibold text-d2-ink-4">{t('evidence')}</div>
            <div className="mt-[6px] text-d2-17 font-semibold text-d2-ink">{t('evEmptyH')}</div>
            <div className="h-[140px] rounded-[12px] border border-dashed border-d2-line-2 my-[16px] bg-d2-bg [background-image:repeating-linear-gradient(90deg,#ECEEF2_0_1px,transparent_1px_48px)]"/>
            <p className="m-0 text-d2-13">{t('evEmptyP')}</p>
          </div>}
    </aside>;
}
