import React from 'react';
import { useI18n } from '../i18n/I18nProvider';
import { surface } from './ConversationCards';
import type { Review } from './types';

/**
 * Top-level practice goals from the engine. `proven` items carry a checkable
 * condition; `insufficient` renders only the engine's cannot-prove note —
 * the UI never invents a goal the evidence cannot ground.
 */
export default function PracticeGoals({ practice }: { practice: NonNullable<Review['practice']> }) {
    const { t } = useI18n();
    if (practice.status !== 'proven' || !practice.items.length) {
        if (!practice.note) return null;
        return (
            <section className={surface} data-testid="practice-block" data-status="insufficient">
                <h2 className="m-0 text-d2-12 text-d2-gold-2 uppercase tracking-wider">{t('practiceTitle')}</h2>
                <p className="mt-[6px] mb-0 text-d2-15 text-d2-ink-2 leading-[1.45]">{practice.note}</p>
            </section>
        );
    }
    return (
        <section className={surface} data-testid="practice-block" data-status="proven">
            <h2 className="m-0 text-d2-12 text-d2-gold-2 uppercase tracking-wider">{t('practiceTitle')}</h2>
            <ul className="mt-[8px] mb-0 pl-[18px] space-y-[8px]">
                {practice.items.map((item, i) => (
                    <li key={i} className="text-d2-15 text-d2-ink-2 leading-[1.45]">
                        {item.goal}
                        {' '}
                        <span className="text-d2-ink-3">{t('practiceCheck')}: {item.condition}</span>
                    </li>
                ))}
            </ul>
            {practice.note ? <p className="mt-[8px] mb-0 text-d2-13 text-d2-ink-3">{practice.note}</p> : null}
        </section>
    );
}
