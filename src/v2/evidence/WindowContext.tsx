import React from 'react';
import { useI18n } from '../i18n/I18nProvider';
import type { Insight, Review } from '../review/types';
import { MomentsList, section, sectionH } from './bits';
import { windowMoments } from './labels';

export default function WindowContext({review, insight}: {review: Review; insight: Insight}) {
  const {t, lang} = useI18n();
  const checkpoints = [10, 20, 30].filter(minute =>
    review.match.duration_s != null && minute * 60 <= review.match.duration_s &&
    (review.facts[`gold.at.${minute}`] || review.facts[`xp.at.${minute}`]));
  const moments = windowMoments(review, insight, lang, t);
  return <>
    {checkpoints.length > 0 && <div className={section} data-testid="economy-checkpoints">
      <h4 className={sectionH}>{t('economyCheckpoints')}</h4>
      <p className="m-0 mb-[10px] text-d2-12 text-d2-ink-4">{t('economyPerspective')}</p>
      <table className="w-full text-d2-13 text-d2-ink-2 d2-tnum">
        <thead><tr className="text-d2-ink-4"><th scope="col" className="text-left py-[6px]">{t('checkpointTime')}</th><th scope="col" className="text-right">{t('serGold')}</th><th scope="col" className="text-right">{t('serXP')}</th></tr></thead>
        <tbody>{checkpoints.map(minute => <tr key={minute} className="border-t border-d2-line-2">
          <th scope="row" className="text-left py-[8px] font-mono font-normal">{minute}:00</th>
          <td className="text-right">{review.facts[`gold.at.${minute}`]?.display[lang] ?? t('checkpointMissing')}</td>
          <td className="text-right">{review.facts[`xp.at.${minute}`]?.display[lang] ?? t('checkpointMissing')}</td>
        </tr>)}</tbody>
      </table>
    </div>}
    {review.player && insight.status === 'ok' && insight.time && insight.time.to > insight.time.from && <div className={section} data-testid="window-context">
      <h4 className={sectionH}>{t('windowContext')}</h4>
      <p className="m-0 mb-[10px] text-d2-12 text-d2-ink-4">{t('windowContextHint')}</p>
      {moments.length ? <MomentsList moments={moments}/> : <p className="m-0 text-d2-13 text-d2-ink-3">{t('windowContextEmpty')}</p>}
    </div>}
  </>;
}
