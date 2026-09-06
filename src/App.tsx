import React, { useState } from 'react';
import { AppTab, Language } from './types';
import CoachView from './components/CoachView';
import HeroHub from './components/HeroHub';
import { MessageSquare, Users, Globe } from 'lucide-react';

const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<AppTab>(AppTab.DRAFT);
  const [lang, setLang] = useState<Language>('zh');

  const toggleLang = () => {
    setLang(prev => prev === 'en' ? 'zh' : 'en');
  };

  const t = {
    coach: lang === 'zh' ? 'AI 教练' : 'AI Coach',
    heroHub: lang === 'zh' ? '英雄百科' : 'Hero Hub',
    contact: lang === 'zh' ? '联系我' : 'Contact',
  };

  return (
    <div className="h-full min-h-0 flex flex-col bg-k3-base overflow-hidden">
      {/* Header - k3 first-principles: quieter, minimal */}
      <header className="h-12 border-b border-k3-border-subtle bg-k3-base flex items-center justify-between px-3 sm:px-4 md:px-6 flex-shrink-0">
        {/* Logo + Tabs inline */}
        <div className="flex items-center gap-3 sm:gap-6 min-w-0">
          {/* Logo - clean, no accent dots */}
          <div className="flex items-center gap-2 flex-shrink-0">
            <span className="font-semibold text-k3-text-primary text-sm">
              DOTA2<span className="text-k3-text-secondary">.AI</span>
            </span>
          </div>

          {/* Inline Tabs - quieter with underline */}
          <nav className="flex items-center gap-2 sm:gap-4 min-w-0">
            <button
              onClick={() => setActiveTab(AppTab.DRAFT)}
              className={`tab-item flex items-center gap-1 sm:gap-1.5 min-h-[40px] ${
                activeTab === AppTab.DRAFT ? 'tab-item-active' : 'tab-item-inactive'
              }`}
            >
              <MessageSquare size={14} className="flex-shrink-0" />
              <span className="hidden xs:inline text-xs sm:text-sm truncate">{t.coach}</span>
            </button>
            <button
              onClick={() => setActiveTab(AppTab.LORE)}
              className={`tab-item flex items-center gap-1 sm:gap-1.5 min-h-[40px] ${
                activeTab === AppTab.LORE ? 'tab-item-active' : 'tab-item-inactive'
              }`}
            >
              <Users size={14} className="flex-shrink-0" />
              <span className="hidden xs:inline text-xs sm:text-sm truncate">{t.heroHub}</span>
            </button>
          </nav>
        </div>

        {/* Right: Language + Contact as ghost buttons */}
        <div className="flex items-center gap-1 sm:gap-2 flex-shrink-0">
          <button
            onClick={toggleLang}
            className="btn-ghost flex items-center gap-1 px-2 py-1.5 min-h-[40px] min-w-[40px] justify-center text-xs transition-colors"
          >
            <Globe size={14} className="sm:w-3 sm:h-3" />
            <span className="hidden sm:inline">{lang === 'en' ? 'EN' : '中'}</span>
          </button>
          <a
            href="mailto:qianhao1229@gmail.com"
            className="btn-ghost hidden md:flex items-center text-xs transition-colors"
          >
            {t.contact}
          </a>
        </div>
      </header>

      {/* Main Content - Full Height */}
      <main className="flex-1 min-h-0 overflow-hidden">
        {activeTab === AppTab.DRAFT ? (
          <CoachView lang={lang} />
        ) : (
          <HeroHub lang={lang} />
        )}
      </main>
    </div>
  );
};

export default App;
