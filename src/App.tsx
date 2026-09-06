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
    <div className="min-h-screen flex flex-col bg-k3-base">
      {/* Header - k3 design */}
      <header className="h-14 border-b border-k3-border-subtle bg-k3-base flex items-center justify-between px-4 md:px-6 flex-shrink-0">
        {/* Logo + Tabs inline */}
        <div className="flex items-center gap-6">
          {/* Logo - subtle with accent dot */}
          <div className="flex items-center gap-2">
            <div className="relative w-8 h-8 bg-k3-surface rounded-lg flex items-center justify-center border border-k3-border-subtle">
              <span className="font-bold text-sm text-k3-text-primary">D</span>
              <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-k3-accent" />
            </div>
            <span className="font-semibold text-k3-text-primary hidden sm:block">
              DOTA2<span className="text-k3-accent">.AI</span>
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
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-k3-surface hover:bg-k3-elevated text-k3-text-secondary text-xs font-medium transition-colors border border-k3-border-subtle"
          >
            <Globe size={14} />
            {lang === 'en' ? 'EN' : '中'}
          </button>
          <a
            href="mailto:qianhao1229@gmail.com"
            className="hidden md:flex items-center gap-1.5 text-k3-text-tertiary hover:text-k3-text-primary text-sm transition-colors"
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
