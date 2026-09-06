import React from 'react';
import { Language } from '../../types';
import { MessageSquare, Sparkles, Target, TrendingUp, BarChart3 } from 'lucide-react';

interface WelcomeStateProps {
  lang: Language;
  hasHeroes: boolean;
  onOpenPicker: () => void;
}

const WelcomeState: React.FC<WelcomeStateProps> = ({ lang, hasHeroes, onOpenPicker }) => {
  const t = {
    title: lang === 'zh' ? 'Dota 2 AI 教练' : 'Dota 2 AI Coach',
    subtitle: lang === 'zh' 
      ? '选择双方英雄，获取专业阵容分析、打法建议和英雄推荐'
      : 'Pick heroes for both teams to get draft analysis, gameplay advice, and recommendations',
    pickHeroes: lang === 'zh' ? '开始选择英雄' : 'Start Picking Heroes',
    features: [
      {
        icon: Sparkles,
        title: lang === 'zh' ? '阵容分析' : 'Draft Analysis',
        desc: lang === 'zh' ? '深度解读对位优劣势' : 'Deep matchup breakdown',
      },
      {
        icon: Target,
        title: lang === 'zh' ? '打法建议' : 'Playbook',
        desc: lang === 'zh' ? '每个英雄的出装和策略' : 'Builds & strategy per hero',
      },
      {
        icon: TrendingUp,
        title: lang === 'zh' ? '英雄推荐' : 'Pick Suggestions',
        desc: lang === 'zh' ? '基于数据的下一手' : 'Data-driven next pick',
      },
      {
        icon: BarChart3,
        title: lang === 'zh' ? '版本大盘' : 'Meta Tier',
        desc: lang === 'zh' ? '当前版本强势英雄' : 'Current patch top heroes',
      },
    ],
  };

  return (
    <div className="flex flex-col items-center justify-center h-full px-4 py-8">
      {/* Logo/Icon */}
      <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-amber-500/20 to-orange-600/20 flex items-center justify-center mb-6 border border-amber-500/20">
        <MessageSquare size={36} className="text-amber-400" />
      </div>

      {/* Title */}
      <h1 className="text-2xl sm:text-3xl font-bold text-white mb-2 text-center">{t.title}</h1>
      <p className="text-gray-400 text-sm sm:text-base text-center max-w-md mb-8">{t.subtitle}</p>

      {/* CTA Button */}
      {!hasHeroes && (
        <button
          onClick={onOpenPicker}
          className="px-6 py-3 bg-gradient-to-r from-amber-500 to-orange-600 hover:from-amber-400 hover:to-orange-500 text-white font-semibold rounded-xl shadow-lg shadow-amber-500/20 hover:shadow-amber-500/30 transition-all hover:-translate-y-0.5 mb-10"
        >
          {t.pickHeroes}
        </button>
      )}

      {/* Features Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 w-full max-w-2xl">
        {t.features.map(({ icon: Icon, title, desc }) => (
          <div 
            key={title}
            className="bg-white/5 border border-white/5 rounded-xl p-4 text-center hover:bg-white/10 transition-colors"
          >
            <Icon size={24} className="text-amber-400 mx-auto mb-2" />
            <h3 className="text-white text-sm font-medium mb-1">{title}</h3>
            <p className="text-gray-500 text-[10px] sm:text-xs">{desc}</p>
          </div>
        ))}
      </div>
    </div>
  );
};

export default WelcomeState;
