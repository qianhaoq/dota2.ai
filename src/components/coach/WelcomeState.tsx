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
    <div className="flex flex-col items-center justify-center h-full px-6 py-8 max-w-content mx-auto">
      {/* Logo/Icon - calmer with accent dot */}
      <div className="relative w-16 h-16 rounded-2xl bg-k3-surface flex items-center justify-center mb-6 border border-k3-border-subtle">
        <MessageSquare size={28} className="text-k3-text-secondary" />
        <span className="absolute -top-1 -right-1 w-3 h-3 rounded-full bg-k3-accent" />
      </div>

      {/* Title */}
      <h1 className="text-xl sm:text-2xl font-semibold text-k3-text-primary mb-2 text-center">{t.title}</h1>
      <p className="text-k3-text-secondary text-sm text-center max-w-md mb-8">{t.subtitle}</p>

      {/* CTA Button - accent color */}
      {!hasHeroes && (
        <button
          onClick={onOpenPicker}
          className="px-5 py-2.5 bg-k3-accent hover:bg-k3-accent/90 text-k3-base font-medium rounded-full transition-all mb-10"
        >
          {t.pickHeroes}
        </button>
      )}

      {/* Features Grid - calmer styling */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 w-full">
        {t.features.map(({ icon: Icon, title, desc }) => (
          <div 
            key={title}
            className="bg-k3-surface border border-k3-border-subtle rounded-xl p-4 text-center hover:bg-k3-elevated transition-colors"
          >
            <Icon size={20} className="text-k3-text-secondary mx-auto mb-2" />
            <h3 className="text-k3-text-primary text-sm font-medium mb-1">{title}</h3>
            <p className="text-k3-text-tertiary text-[10px] sm:text-xs">{desc}</p>
          </div>
        ))}
      </div>
    </div>
  );
};

export default WelcomeState;
