import React from 'react';
import { Hero, Language } from '../../types';
import { Swords, Plus, X, ChevronDown, Info } from 'lucide-react';

interface DraftStripProps {
  lang: Language;
  draft: { radiant: Hero[]; dire: Hero[] };
  selectionSide: 'radiant' | 'dire';
  onSideChange: (side: 'radiant' | 'dire') => void;
  onOpenPicker: () => void;
  onRemoveHero: (side: 'radiant' | 'dire', index: number) => void;
  onHeroDetail?: (heroId: number) => void;
}

const DraftStrip: React.FC<DraftStripProps> = ({
  lang,
  draft,
  selectionSide,
  onSideChange,
  onOpenPicker,
  onRemoveHero,
  onHeroDetail,
}) => {
  const t = {
    radiant: lang === 'zh' ? '天辉' : 'Radiant',
    dire: lang === 'zh' ? '夜魇' : 'Dire',
    editDraft: lang === 'zh' ? '编辑阵容' : 'Edit Draft',
  };

  const HeroSlot = ({ hero, side, index }: { hero?: Hero; side: 'radiant' | 'dire'; index: number }) => (
    <div className="relative group">
      {hero ? (
        <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-lg overflow-hidden ring-1 ring-k3-border-subtle transition-transform hover:scale-110">
          <img 
            src={hero.img} 
            alt={hero.name}
            className="w-full h-full object-cover cursor-pointer"
            onClick={() => onHeroDetail?.(hero.id)}
          />
          <button 
            onClick={(e) => { e.stopPropagation(); onRemoveHero(side, index); }}
            className="absolute -top-1 -right-1 w-4 h-4 bg-k3-dire rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity z-10"
          >
            <X size={10} className="text-white" />
          </button>
          {onHeroDetail && (
            <button
              onClick={(e) => { e.stopPropagation(); onHeroDetail(hero.id); }}
              className="absolute -bottom-1 -right-1 w-4 h-4 bg-k3-accent rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity z-10"
            >
              <Info size={8} className="text-k3-base" />
            </button>
          )}
        </div>
      ) : (
        <button 
          onClick={() => { onSideChange(side); onOpenPicker(); }}
          className={`w-8 h-8 sm:w-9 sm:h-9 rounded-lg cursor-pointer flex items-center justify-center transition-all ${
            side === 'radiant' 
              ? 'bg-k3-radiant/5 hover:bg-k3-radiant/10 border border-k3-radiant/20' 
              : 'bg-k3-dire/5 hover:bg-k3-dire/10 border border-k3-dire/20'
          }`}
        >
          <Plus size={12} className="text-k3-text-tertiary" />
        </button>
      )}
    </div>
  );

  return (
    <div className="h-16 flex items-center gap-3 px-4 sm:px-6 bg-k3-surface border-b border-k3-border-subtle">
      {/* Radiant label */}
      <button
        onClick={() => onSideChange('radiant')}
        className={`text-[10px] sm:text-xs font-semibold uppercase tracking-wider px-2 py-1 rounded-lg transition-colors ${
          selectionSide === 'radiant'
            ? 'bg-k3-radiant/15 text-k3-radiant'
            : 'text-k3-text-tertiary hover:text-k3-radiant'
        }`}
      >
        {t.radiant}
      </button>
      
      {/* Radiant slots */}
      <div className="flex gap-1.5">
        {Array.from({ length: 5 }).map((_, i) => (
          <HeroSlot key={`rad-${i}`} hero={draft.radiant[i]} side="radiant" index={i} />
        ))}
      </div>

      {/* VS divider */}
      <div className="flex items-center px-2">
        <Swords size={16} className="text-k3-text-tertiary" />
      </div>

      {/* Dire slots */}
      <div className="flex gap-1.5">
        {Array.from({ length: 5 }).map((_, i) => (
          <HeroSlot key={`dire-${i}`} hero={draft.dire[i]} side="dire" index={i} />
        ))}
      </div>

      {/* Dire label */}
      <button
        onClick={() => onSideChange('dire')}
        className={`text-[10px] sm:text-xs font-semibold uppercase tracking-wider px-2 py-1 rounded-lg transition-colors ${
          selectionSide === 'dire'
            ? 'bg-k3-dire/15 text-k3-dire'
            : 'text-k3-text-tertiary hover:text-k3-dire'
        }`}
      >
        {t.dire}
      </button>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Edit button */}
      <button
        onClick={onOpenPicker}
        className="flex items-center gap-1.5 text-xs text-k3-text-tertiary hover:text-k3-text-primary px-2.5 py-1.5 rounded-lg hover:bg-k3-elevated transition-colors"
      >
        <span className="hidden sm:inline">{t.editDraft}</span>
        <ChevronDown size={14} />
      </button>
    </div>
  );
};

export default DraftStrip;
