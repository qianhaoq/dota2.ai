import React from 'react';
import type { Language } from '../../types';

export interface TradeoffRoute {
  id: string;
  symbol: string;
  title: string;
  /** What the route is for. */
  purpose: string;
  /** What must already be true. */
  premise: string;
  /** What you give up. */
  sacrifice: string;
  /** When to reconsider. */
  switchWhen: string;
}

export interface ItemTradeoffProps {
  lang: Language;
  question: string;
  routes: [TradeoffRoute, TradeoffRoute];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Persistent demo label — the comparison must not pose as patch data. */
  demoLabel: string;
}

/**
 * ItemTradeoff (catalog: dota-coach-ui/1) — 两条路线、前提、代价、改选条件。
 * Numbers only appear when budget/components truly decide; this surface
 * compares decision dimensions, never a fake six-slot build.
 */
const ItemTradeoff: React.FC<ItemTradeoffProps> = ({
  lang,
  question,
  routes,
  selectedId,
  onSelect,
  demoLabel,
}) => {
  const t = {
    purpose: lang === 'zh' ? '用途' : 'Purpose',
    premise: lang === 'zh' ? '前提' : 'Premise',
    sacrifice: lang === 'zh' ? '牺牲项' : 'Sacrifice',
    switchWhen: lang === 'zh' ? '改选条件' : 'Switch when',
    compare: lang === 'zh' ? '点选比较' : 'Tap to compare',
    current: lang === 'zh' ? '当前比较分支' : 'Current branch',
  };
  return (
    <section className="v3-panel px-[16px] py-[14px]" aria-label={lang === 'zh' ? '装备取舍' : 'Item tradeoff'}>
      <div className="flex items-start justify-between gap-[12px] min-w-0">
        <h3 className="text-[14px] leading-[22px] text-v3-text font-medium min-w-0">{question}</h3>
        <span className="v3-tag v3-tag-demo flex-shrink-0">{demoLabel}</span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-[10px] mt-[12px]">
        {routes.map((route) => {
          const selected = route.id === selectedId;
          const rows: Array<[string, string]> = [
            [t.purpose, route.purpose],
            [t.premise, route.premise],
            [t.sacrifice, route.sacrifice],
            [t.switchWhen, route.switchWhen],
          ];
          return (
            <button
              key={route.id}
              type="button"
              onClick={() => onSelect(route.id)}
              aria-pressed={selected}
              className={`text-left px-[14px] py-[12px] rounded-[4px] border transition-colors duration-[120ms] min-w-0 ${
                selected
                  ? 'border-v3-gold bg-v3-raised'
                  : 'border-v3-line bg-v3-panel hover:bg-v3-raised'
              }`}
            >
              <div className="flex items-center gap-[10px]">
                <span
                  aria-hidden="true"
                  className="w-[36px] h-[36px] flex-shrink-0 rounded-full border border-v3-line flex items-center justify-center text-[16px] text-v3-gold"
                >
                  {route.symbol}
                </span>
                <span className="text-[13px] text-v3-text font-medium min-w-0">{route.title}</span>
              </div>
              <dl className="mt-[10px] space-y-[6px]">
                {rows.map(([label, value]) => (
                  <div key={label} className="flex gap-[8px] min-w-0">
                    <dt className="text-[10px] text-v3-quiet w-[52px] flex-shrink-0">{label}</dt>
                    <dd className="text-[11px] leading-[17px] text-v3-muted min-w-0">{value}</dd>
                  </div>
                ))}
              </dl>
              <span className={`v3-tag mt-[10px] ${selected ? 'v3-tag-hypothesis' : ''}`}>
                {selected ? t.current : t.compare}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
};

export default ItemTradeoff;
