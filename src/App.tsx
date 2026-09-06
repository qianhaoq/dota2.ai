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
    <div className="min-h-screen flex flex-col bg-[#0a0a0a]">
      {/* Minimal Header */}
      <header className="h-14 border-b border-white/5 bg-[#0a0a0a] flex items-center justify-between px-4 md:px-6 flex-shrink-0">
        {/* Logo + Tabs inline */}
        <div className="flex items-center gap-6">
          {/* Logo */}
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-gradient-to-br from-red-600 to-red-900 rounded-lg flex items-center justify-center">
              <span className="font-bold text-sm text-white">D</span>
            </div>
            <span className="font-semibold text-white hidden sm:block">
              DOTA2<span className="text-red-500">.AI</span>
            </span>
          </div>

          {/* Inline Tabs */}
          <nav className="flex items-center gap-1">
            <button
              onClick={() => setActiveTab(AppTab.DRAFT)}
              className={`tab-item flex items-center gap-2 ${
                activeTab === AppTab.DRAFT ? 'tab-item-active' : 'tab-item-inactive'
              }`}
            >
              <MessageSquare size={16} />
              <span className="hidden sm:inline">{t.coach}</span>
            </button>
            <button
              onClick={() => setActiveTab(AppTab.LORE)}
              className={`tab-item flex items-center gap-2 ${
                activeTab === AppTab.LORE ? 'tab-item-active' : 'tab-item-inactive'
              }`}
            >
              <Users size={16} />
              <span className="hidden sm:inline">{t.heroHub}</span>
            </button>
          </nav>
        </div>

        {/* Right: Language + Contact */}
        <div className="flex items-center gap-3">
          <button
            onClick={toggleLang}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-gray-300 text-xs font-medium transition-colors"
          >
            <Globe size={14} />
            {lang === 'en' ? 'EN' : '中'}
          </button>
          <a
            href="mailto:qianhao1229@gmail.com"
            className="hidden md:flex items-center gap-1.5 text-gray-400 hover:text-white text-sm transition-colors"
          >
            {t.contact}
          </a>
        </div>
      </header>

      {/* Main Content - Full Height */}
      <main className="flex-1 overflow-hidden">
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
