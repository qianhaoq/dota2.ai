import React from 'react';
import type { A2UIAction } from '../../../types';

interface ActionChipBarProps {
  actions: A2UIAction[];
  onAction?: (action: A2UIAction) => void;
}

/** Grid of tappable action chips (suggested picks, quick actions). */
const ActionChipBar: React.FC<ActionChipBarProps> = ({ actions, onAction }) => (
  <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
    {actions.map((action) => (
      <button
        key={action.id}
        type="button"
        onClick={() => onAction?.(action)}
        className="flex items-center gap-2 p-2.5 bg-k3-elevated/40 hover:bg-k3-elevated border border-k3-border-subtle rounded-sm text-left min-h-[44px] touch-manipulation min-w-0"
      >
        <div className="flex-1 min-w-0">
          <span className="text-k3-text-primary text-xs font-medium block truncate">{action.label}</span>
          {action.subtitle && (
            <span className="text-k3-text-tertiary text-[9px]">{action.subtitle}</span>
          )}
        </div>
        {action.meta && (
          <span className="text-k3-radiant text-[10px] font-bold flex-shrink-0">{action.meta}</span>
        )}
      </button>
    ))}
  </div>
);

export default ActionChipBar;
