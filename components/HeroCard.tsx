import React, { useState } from 'react';
import { Hero, Attribute } from '../types';
import { Shield, Zap, Book, Sword, ImageOff } from 'lucide-react';

interface HeroCardProps {
  hero: Hero;
  isSelected?: boolean;
  onClick?: () => void;
  small?: boolean;
}

const getAttrIcon = (attr: Attribute) => {
  switch (attr) {
    case Attribute.STRENGTH: return <Shield size={14} className="text-red-500" />;
    case Attribute.AGILITY: return <Sword size={14} className="text-green-500" />;
    case Attribute.INTELLIGENCE: return <Book size={14} className="text-blue-500" />;
    case Attribute.UNIVERSAL: return <Zap size={14} className="text-purple-500" />;
  }
};

const HeroCard: React.FC<HeroCardProps> = ({ hero, isSelected, onClick, small }) => {
  const [imgError, setImgError] = useState(false);

  return (
    <div 
      onClick={onClick}
      className={`
        relative group cursor-pointer transition-all duration-200 overflow-hidden border
        ${isSelected ? 'border-dota-gold shadow-[0_0_10px_rgba(212,175,55,0.6)]' : 'border-gray-700 hover:border-gray-500'}
        ${small ? 'w-16 h-16 rounded' : 'w-full h-full rounded-lg'}
        bg-gray-800
      `}
    >
      {!imgError ? (
        <img 
          src={hero.img} 
          alt={hero.name} 
          onError={() => setImgError(true)}
          className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity"
        />
      ) : (
        <div className="w-full h-full flex flex-col items-center justify-center bg-gray-900 p-1 opacity-80 group-hover:opacity-100">
           <ImageOff size={small ? 16 : 24} className="text-gray-600 mb-1" />
           <span className="text-[9px] text-gray-500 text-center leading-tight">{hero.name}</span>
        </div>
      )}

      <div className="absolute bottom-0 left-0 right-0 bg-black/70 p-1 flex flex-col items-center">
        {!small && (
            <span className="text-[10px] font-bold text-gray-200 truncate w-full text-center">
            {hero.name}
            </span>
        )}
        <div className="mt-0.5">
            {getAttrIcon(hero.attribute)}
        </div>
      </div>
      
      {/* Selection Overlay */}
      {isSelected && (
        <div className="absolute inset-0 bg-dota-gold/10 pointer-events-none" />
      )}
    </div>
  );
};

export default HeroCard;