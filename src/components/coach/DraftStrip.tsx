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

  const hasHeroes = draft.radiant.length > 0 || draft.dire.length > 0;

  const HeroSlot = ({ hero, side, index }: { hero?: Hero; side: 'radiant' | 'dire'; index: number }) => (
    <div className="relative group">
      {hero ? (
        <div className="w-7 h-7 sm:w-8 sm:h-8 rounded-md overflow-hidden ring-1 ring-white/10 transition-transform hover:scale-110">
          <img 
            src={hero.img} 
            alt={hero.name}
            className="w-full h-full object-cover cursor-pointer"
            onClick={() => onHeroDetail?.(hero.id)}
          />
          <button 
            onClick={(e) => { e.stopPropagation(); onRemoveHero(side, index); }}
            className="absolute -top-1 -right-1 w-3.5 h-3.5 bg-red-600 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity z-10"
          >
            <X size={8} className="text-white" />
          </button>
          {onHeroDetail && (
            <button
              onClick={(e) => { e.stopPropagation(); onHeroDetail(hero.id); }}
              className="absolute -bottom-1 -right-1 w-3.5 h-3.5 bg-amber-500 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity z-10"
            >
              <Info size={7} className="text-black" />
            </button>
          )}
        </div>
      ) : (
        <div 
          onClick={() => { onSideChange(side); onOpenPicker(); }}
          className={`w-7 h-7 sm:w-8 sm:h-8 rounded-md border border-dashed cursor-pointer flex items-center justify-center transition-colors ${
            side === 'radiant' 
              ? 'border-emerald-500/40 hover:border-emerald-400 hover:bg-emerald-500/10' 
              : 'border-red-500/40 hover:border-red-400 hover:bg-red-500/10'
          }`}
        >
          <Plus size={10} className="text-gray-500" />
        </div>
      )}
    </div>
  );

  return (
    <div className="draft-strip flex items-center gap-2 sm:gap-3 px-3 py-2 bg-[#0d0d0d] border-b border-white/5">
      {/* Radiant heroes */}
      <button
        onClick={() => onSideChange('radiant')}
        className={`text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded transition-colors ${
          selectionSide === 'radiant'
            ? 'bg-emerald-500/20 text-emerald-400'
            : 'text-gray-500 hover:text-emerald-400'
        }`}
      >
        {t.radiant}
      </button>
      
      <div className="flex gap-1">
        {Array.from({ length: 5 }).map((_, i) => (
          <HeroSlot key={`rad-${i}`} hero={draft.radiant[i]} side="radiant" index={i} />
        ))}
      </div>

      {/* VS divider */}
      <div className="flex items-center gap-1 px-1 sm:px-2">
        <Swords size={14} className="text-amber-500/60" />
      </div>

      {/* Dire heroes */}
      <div className="flex gap-1">
        {Array.from({ length: 5 }).map((_, i) => (
          <HeroSlot key={`dire-${i}`} hero={draft.dire[i]} side="dire" index={i} />
        ))}
      </div>

      <button
        onClick={() => onSideChange('dire')}
        className={`text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded transition-colors ${
          selectionSide === 'dire'
            ? 'bg-red-500/20 text-red-400'
            : 'text-gray-500 hover:text-red-400'
        }`}
      >
        {t.dire}
      </button>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Edit button */}
      <button
        onClick={onOpenPicker}
        className="flex items-center gap-1 text-[10px] sm:text-xs text-gray-400 hover:text-white px-2 py-1 rounded hover:bg-white/5 transition-colors"
      >
        <span className="hidden sm:inline">{t.editDraft}</span>
        <ChevronDown size={12} />
      </button>
    </div>
  );
};

export default DraftStrip;
