import React from 'react';
import { Hero, Language } from '../../types';
import { ChevronRight, Users } from 'lucide-react';

interface DraftContextChipProps {
  lang: Language;
  draft: { radiant: Hero[]; dire: Hero[] };
  selectionSide: 'radiant' | 'dire';
  onOpenPicker: () => void;
  onHeroDetail?: (heroId: number) => void;
  variant?: 'compact' | 'prominent';
}

const DraftContextChip: React.FC<DraftContextChipProps> = ({
  lang,
  draft,
  selectionSide,
  onOpenPicker,
  onHeroDetail,
  variant = 'compact',
}) => {
  const t = {
    selectHeroes: lang === 'zh' ? '选英雄' : 'Pick Heroes',
    editDraft: lang === 'zh' ? '编辑阵容' : 'Edit lineup',
    radiant: lang === 'zh' ? '天辉' : 'Radiant',
    dire: lang === 'zh' ? '夜魇' : 'Dire',
  };

  const hasHeroes = draft.radiant.length > 0 || draft.dire.length > 0;

  if (!hasHeroes) {
    if (variant === 'prominent') {
      return (
        <button
          onClick={onOpenPicker}
          className="inline-flex items-center gap-3 px-5 py-3 rounded-xl bg-k3-primary-bg hover:bg-white text-k3-primary-text text-sm font-medium transition-all group shadow-sm"
        >
          <Users size={18} className="text-k3-primary-text/80" />
          <span>{t.selectHeroes}</span>
          <ChevronRight size={16} className="text-k3-primary-text/60 group-hover:translate-x-0.5 transition-transform" />
        </button>
      );
    }
    
    return (
      <button
        onClick={onOpenPicker}
        className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-k3-surface border border-k3-border-subtle hover:bg-k3-elevated hover:border-k3-text-tertiary/30 text-xs transition-all group"
      >
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-k3-radiant-muted/50" />
          <span className="w-2 h-2 rounded-full bg-k3-dire-muted/50" />
        </span>
        <span className="text-k3-text-secondary group-hover:text-k3-text-primary">{t.selectHeroes}</span>
        <ChevronRight size={12} className="text-k3-text-tertiary" />
      </button>
    );
  }

  return (
    <button
      onClick={onOpenPicker}
      className="inline-flex items-center gap-3 px-3 py-1.5 rounded-sm hover:bg-k3-surface transition-colors group"
    >
      {draft.radiant.length > 0 && (
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] font-medium text-k3-radiant uppercase tracking-wide">
            {t.radiant}
          </span>
          <div className="flex -space-x-1">
            {draft.radiant.map((hero) => (
              <div
                key={hero.id}
                className="w-6 h-6 rounded-sm overflow-hidden border border-k3-radiant/30 hover:scale-110 transition-transform cursor-pointer"
                onClick={(e) => {
                  e.stopPropagation();
                  onHeroDetail?.(hero.id);
                }}
              >
                <img
                  src={hero.img}
                  alt={hero.name}
                  className="w-full h-full object-cover"
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {draft.radiant.length > 0 && draft.dire.length > 0 && (
        <span className="text-k3-text-tertiary text-xs">vs</span>
      )}

      {draft.dire.length > 0 && (
        <div className="flex items-center gap-1.5">
          <div className="flex -space-x-1">
            {draft.dire.map((hero) => (
              <div
                key={hero.id}
                className="w-6 h-6 rounded-sm overflow-hidden border border-k3-dire/30 hover:scale-110 transition-transform cursor-pointer"
                onClick={(e) => {
                  e.stopPropagation();
                  onHeroDetail?.(hero.id);
                }}
              >
                <img
                  src={hero.img}
                  alt={hero.name}
                  className="w-full h-full object-cover"
                />
              </div>
            ))}
          </div>
          <span className="text-[10px] font-medium text-k3-dire uppercase tracking-wide">
            {t.dire}
          </span>
        </div>
      )}

      <ChevronRight size={14} className="text-k3-text-tertiary group-hover:text-k3-text-secondary ml-1" />
    </button>
  );
};

export default DraftContextChip;
