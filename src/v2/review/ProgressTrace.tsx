import React from 'react';
import { useI18n } from '../i18n/I18nProvider';
import { IconCheck } from './icons';

/**
 * Tool-trace style progress card (handoff §3 ToolTrace): three steps that
 * advance while the review loads, collapsing to a single quiet line once the
 * data is in. No invented timings — the collapsed line names the source only.
 */
const ProgressTrace: React.FC<{ step: number; done: boolean }> = ({ step, done }) => {
  const { t } = useI18n();
  const steps = [t('traceFetch'), t('traceTimeline'), t('traceConclusions')];

  if (done) {
    return (
      <div className="flex items-center gap-[10px] h-[44px] px-[14px] rounded-[12px] bg-d2-surface shadow-d2-1 text-d2-13 text-d2-ink-3">
        <span className="grid place-items-center">
          <IconCheck />
        </span>
        <span className="font-medium text-d2-ink">{t('traceAnalyzed')}</span>
      </div>
    );
  }

  return (
    <div className="bg-d2-surface rounded-d2-card shadow-d2-2 p-[16px]" aria-live="polite">
      <ul className="list-none m-0 p-0">
        {steps.map((label, i) => {
          const state = i < step ? 'done' : i === step ? 'active' : 'todo';
          return (
            <li
              key={label}
              className={`flex items-center gap-[10px] min-h-[32px] text-d2-15 font-medium ${
                state === 'todo' ? 'text-d2-ink-4 font-normal' : 'text-d2-ink'
              }`}
            >
              <span className="w-[18px] h-[18px] grid place-items-center flex-none">
                {state === 'done' ? (
                  <IconCheck />
                ) : state === 'active' ? (
                  <span className="w-[14px] h-[14px] rounded-full border-2 border-[#ECEEF2] border-t-d2-ink-3 animate-spin" />
                ) : (
                  <span className="w-[6px] h-[6px] rounded-full bg-d2-disabled" />
                )}
              </span>
              <span>
                {label}
                {state === 'active' ? '…' : ''}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
};

export default ProgressTrace;
