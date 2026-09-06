import React from 'react';
import { Language } from '../../types';
import { Sparkles, Target, TrendingUp, BarChart3, X, Loader2 } from 'lucide-react';

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
    analyze: lang === 'zh' ? '分析阵容' : 'Analyze',
    playbook: lang === 'zh' ? '本局打法' : 'Playbook',
    suggest: lang === 'zh' ? '推荐下一手' : 'Next Pick',
    meta: lang === 'zh' ? '看看大盘' : 'Meta Tier',
    cancel: lang === 'zh' ? '停止' : 'Stop',
    radiant: lang === 'zh' ? '天辉' : 'Radiant',
    dire: lang === 'zh' ? '夜魇' : 'Dire',
    yourSide: lang === 'zh' ? '你的阵营' : 'Your side',
  };

  const chips = [
    {
      id: 'analyze',
      label: t.analyze,
      icon: Sparkles,
      onClick: onAnalyze,
      disabled: !hasHeroes,
    },
    {
      id: 'playbook',
      label: t.playbook,
      icon: Target,
      onClick: onPlaybook,
      disabled: !hasAllies,
    },
    {
      id: 'suggest',
      label: t.suggest,
      icon: TrendingUp,
      onClick: onSuggest,
      disabled: alliesFull,
    },
    {
      id: 'meta',
      label: t.meta,
      icon: BarChart3,
      onClick: onMeta,
      disabled: false,
    },
  ];

  return (
    <div className="flex flex-wrap items-center gap-2">
      {hasHeroes && (
        <span className={`text-[10px] px-2 py-1 rounded-full font-medium border ${
          selectionSide === 'radiant' 
            ? 'bg-k3-radiant/10 text-k3-radiant border-k3-radiant/20' 
            : 'bg-k3-dire/10 text-k3-dire border-k3-dire/20'
        }`}>
          {t.yourSide}: {selectionSide === 'radiant' ? t.radiant : t.dire}
        </span>
      )}
      
      {chips.map(({ id, label, icon: Icon, onClick, disabled }) => (
        <button
          key={id}
          onClick={onClick}
          disabled={isLoading || disabled}
          className={`
            flex items-center gap-1.5 px-3 py-1.5 
            bg-transparent border border-k3-border-subtle
            text-k3-text-secondary text-xs font-medium rounded-full 
            transition-all
            hover:border-k3-accent hover:text-k3-text-primary hover:bg-k3-accent/5
            disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:border-k3-border-subtle disabled:hover:bg-transparent
            active:bg-k3-accent/10
          `}
        >
          <Icon size={13} />
          {label}
        </button>
      ))}

      {isLoading && (
        <button
          onClick={onCancel}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-k3-elevated border border-k3-border-subtle hover:border-k3-dire hover:bg-k3-dire/5 text-k3-text-secondary hover:text-k3-dire text-xs font-medium rounded-full transition-all"
        >
          <X size={13} />
          {t.cancel}
        </button>
      )}

      {isLoading && (
        <Loader2 size={16} className="text-k3-accent animate-spin ml-1" />
      )}
    </div>
  );
};

export default IntentChips;
