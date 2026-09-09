import React from 'react';
import type { Language } from '../../types';

export interface DecisionOption {
  value: string;
  label: string;
  hint?: string;
}

export interface DecisionForkProps {
  lang: Language;
  /** The question being forked; while busy this can be a "assembling…" line. */
  title: string;
  options: DecisionOption[];
  selected?: string | null;
  onSelect: (value: string) => void;
  /** Note under the options, e.g. memory stays user_report. */
  footnote?: string;
  busy?: boolean;
  /** Extra controls (stop / compare / commit) rendered on the trailing edge. */
  children?: React.ReactNode;
}

/**
 * DecisionFork (catalog: dota-coach-ui/1) — 选分支、补假设、撤销。
 * Player answers are personal input; the surface never computes gains without
 * evidence, and selection is a preference, not a graded verdict.
 */
const DecisionFork: React.FC<DecisionForkProps> = ({
  lang,
  title,
  options,
  selected,
  onSelect,
  footnote,
  busy = false,
  children,
}) => {
  const stateLabel = busy
    ? lang === 'zh' ? '正在装配…' : 'Assembling…'
    : lang === 'zh' ? '交互式决策' : 'Interactive decision';
  return (
    <section className="v3-panel px-[16px] py-[14px]" aria-label={stateLabel} aria-busy={busy}>
      <h3 className="text-[14px] leading-[22px] text-v3-text font-medium min-w-0">{title}</h3>
      <div className="flex flex-wrap gap-[8px] mt-[10px]">
        {options.map((option) => {
          const active = option.value === selected;
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => onSelect(option.value)}
              aria-pressed={active}
              className={`v3-btn ${active ? 'v3-btn-primary' : ''}`}
            >
              {option.label}
            </button>
          );
        })}
      </div>
      {footnote && <p className="mt-[10px] text-[11px] leading-[18px] text-v3-quiet">{footnote}</p>}
      {children && <div className="mt-[12px] flex flex-wrap gap-[8px] items-center">{children}</div>}
    </section>
  );
};

export default DecisionFork;
