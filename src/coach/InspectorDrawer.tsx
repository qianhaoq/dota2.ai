import React from 'react';
import { useLang } from './ui';
import type { Bi } from './types';

export type InspectorTab = 'evidence' | 'ask' | 'compare';

/**
 * The review workbench's right-hand inspector: one tab strip over panels that
 * all stay mounted (the conversation and a pending comparison survive tab
 * switches). Docked beside the feed on wide screens, below it on narrow ones.
 */
export const InspectorDrawer: React.FC<{
  active: InspectorTab;
  onTab: (tab: InspectorTab) => void;
  panels: { id: InspectorTab; label: Bi; badge?: boolean; content: React.ReactNode }[];
}> = ({ active, onTab, panels }) => {
  const { L } = useLang();
  return (
    <aside className="cxv-rail wb-inspector" aria-label={L({ en: 'Inspector', zh: '检查面板' })}>
      <div className="wb-tabs" role="tablist">
        {panels.map((p) => (
          <button key={p.id} type="button" role="tab" id={`wb-tab-${p.id}`} aria-selected={active === p.id} aria-controls={`wb-panel-${p.id}`}
            className={`${active === p.id ? 'is-on' : ''} ${p.badge ? 'has-badge' : ''}`} onClick={() => onTab(p.id)}>
            {L(p.label)}
          </button>
        ))}
      </div>
      {panels.map((p) => (
        <div key={p.id} role="tabpanel" id={`wb-panel-${p.id}`} aria-labelledby={`wb-tab-${p.id}`} hidden={active !== p.id} className="wb-panel">
          {p.content}
        </div>
      ))}
    </aside>
  );
};
