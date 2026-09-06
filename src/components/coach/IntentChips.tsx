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
      color: 'from-amber-500/80 to-orange-600/80 hover:from-amber-500 hover:to-orange-500',
    },
    {
      id: 'playbook',
      label: t.playbook,
      icon: Target,
      onClick: onPlaybook,
      disabled: !hasAllies,
      color: 'from-blue-500/80 to-indigo-600/80 hover:from-blue-500 hover:to-indigo-500',
    },
    {
      id: 'suggest',
      label: t.suggest,
      icon: TrendingUp,
      onClick: onSuggest,
      disabled: alliesFull,
      color: 'from-emerald-500/80 to-teal-600/80 hover:from-emerald-500 hover:to-teal-500',
    },
    {
      id: 'meta',
      label: t.meta,
      icon: BarChart3,
      onClick: onMeta,
      disabled: false,
      color: 'from-purple-500/80 to-violet-600/80 hover:from-purple-500 hover:to-violet-500',
    },
  ];

  return (
    <div className="flex flex-wrap items-center gap-2">
      {hasHeroes && (
        <span className={`text-[10px] px-2 py-1 rounded-full font-medium ${
          selectionSide === 'radiant' 
            ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' 
            : 'bg-red-500/10 text-red-400 border border-red-500/20'
        }`}>
          {t.yourSide}: {selectionSide === 'radiant' ? t.radiant : t.dire}
        </span>
      )}
      
      {chips.map(({ id, label, icon: Icon, onClick, disabled, color }) => (
        <button
          key={id}
          onClick={onClick}
          disabled={isLoading || disabled}
          className={`
            flex items-center gap-1.5 px-3 py-1.5 
            bg-gradient-to-r ${color}
            text-white text-xs font-medium rounded-full 
            transition-all shadow-lg shadow-black/20
            disabled:opacity-30 disabled:cursor-not-allowed disabled:shadow-none
            hover:shadow-xl hover:-translate-y-0.5
            active:translate-y-0
          `}
        >
          <Icon size={13} />
          {label}
        </button>
      ))}

      {isLoading && (
        <button
          onClick={onCancel}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-white/10 hover:bg-white/20 text-white text-xs font-medium rounded-full transition-all border border-white/10"
        >
          <X size={13} />
          {t.cancel}
        </button>
      )}

      {isLoading && (
        <Loader2 size={16} className="text-amber-400 animate-spin ml-1" />
      )}
    </div>
  );
};

export default IntentChips;
