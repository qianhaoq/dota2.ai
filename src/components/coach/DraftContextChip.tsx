import React from 'react';
import { Hero, Language } from '../../types';
import { ChevronRight } from 'lucide-react';

interface DraftContextChipProps {
  lang: Language;
  draft: { radiant: Hero[]; dire: Hero[] };
  selectionSide: 'radiant' | 'dire';
  onOpenPicker: () => void;
  onHeroDetail?: (heroId: number) => void;
}

const DraftContextChip: React.FC<DraftContextChipProps> = ({
  lang,
  draft,
  selectionSide,
  onOpenPicker,
  onHeroDetail,
}) => {
  const t = {
    noDraft: lang === 'zh' ? '未选阵容' : 'No lineup',
    clickToSelect: lang === 'zh' ? '点击选择' : 'Click to select',
    radiant: lang === 'zh' ? '天辉' : 'Radiant',
    dire: lang === 'zh' ? '夜魇' : 'Dire',
  };

  const hasHeroes = draft.radiant.length > 0 || draft.dire.length > 0;

  if (!hasHeroes) {
    return (
      <button
        onClick={onOpenPicker}
        className="inline-flex items-center gap-2 px-3 py-1.5 rounded-sm text-sm text-k3-text-secondary hover:text-k3-text-primary transition-colors group"
      >
        <span>{t.noDraft}</span>
        <span className="text-k3-text-tertiary">·</span>
        <span className="group-hover:underline">{t.clickToSelect}</span>
        <ChevronRight size={14} className="text-k3-text-tertiary" />
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
