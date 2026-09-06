import React from 'react';
import { Language } from '../../types';
import { X, Loader2 } from 'lucide-react';

interface IntentChipsProps {
  lang: Language;
  isLoading: boolean;
  hasHeroes: boolean;
  hasAllies: boolean;
  alliesFull: boolean;
  selectionSide: 'radiant' | 'dire';
  onAnalyze: () => void;
  onPlaybook: () => void;
  onSuggest: () => void;
  onMeta: () => void;
  onCancel: () => void;
}

const IntentChips: React.FC<IntentChipsProps> = ({
  lang,
  isLoading,
  hasHeroes,
  hasAllies,
  alliesFull,
  selectionSide,
  onAnalyze,
  onPlaybook,
  onSuggest,
  onMeta,
  onCancel,
}) => {
  const t = {
    analyze: lang === 'zh' ? '分析阵容' : 'Analyze draft',
    playbook: lang === 'zh' ? '本局打法' : 'Playbook',
    suggest: lang === 'zh' ? '推荐下一手' : 'Next pick',
    meta: lang === 'zh' ? '看看大盘' : 'Meta tier',
    cancel: lang === 'zh' ? '停止' : 'Stop',
  };

  const suggestions = [
    {
      id: 'analyze',
      label: t.analyze,
      onClick: onAnalyze,
      enabled: hasHeroes,
    },
    {
      id: 'playbook',
      label: t.playbook,
      onClick: onPlaybook,
      enabled: hasAllies,
    },
    {
      id: 'suggest',
      label: t.suggest,
      onClick: onSuggest,
      enabled: hasAllies && !alliesFull,
    },
    {
      id: 'meta',
      label: t.meta,
      onClick: onMeta,
      enabled: true,
    },
  ];

  return (
    <div className="flex flex-wrap items-center gap-3">
      {suggestions.map(({ id, label, onClick, enabled }) => (
        <button
          key={id}
          onClick={onClick}
          disabled={isLoading || !enabled}
          className={`text-sm transition-colors ${
            enabled && !isLoading
              ? 'text-k3-text-secondary hover:text-k3-text-primary hover:underline'
              : 'text-k3-text-tertiary cursor-not-allowed'
          }`}
        >
          {label}
        </button>
      ))}

      {isLoading && (
        <>
          <span className="text-k3-text-tertiary">·</span>
          <Loader2 size={14} className="text-k3-text-secondary animate-spin" />
          <button
            onClick={onCancel}
            className="text-sm text-k3-text-tertiary hover:text-k3-dire flex items-center gap-1 transition-colors"
          >
            <X size={12} />
            {t.cancel}
          </button>
        </>
      )}
    </div>
  );
};

export default IntentChips;
