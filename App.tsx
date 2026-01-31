import React, { useState } from 'react';
import { AppTab, Language } from './types';
import DraftAssistant from './components/DraftAssistant';
import LoreChat from './components/LoreChat';
import { Sword, BookOpen, Menu, Globe } from 'lucide-react';

const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<AppTab>(AppTab.DRAFT);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [lang, setLang] = useState<Language>('zh'); // Default to Chinese

  const toggleLang = () => {
    setLang(prev => prev === 'en' ? 'zh' : 'en');
  };

  const renderContent = () => {
    switch (activeTab) {
      case AppTab.DRAFT:
        return <DraftAssistant lang={lang} />;
      case AppTab.LORE:
        return <LoreChat lang={lang} />;
      default:
        return <DraftAssistant lang={lang} />;
    }
  };

  const t = {
    draft: lang === 'zh' ? '阵容分析' : 'Draft Strategy',
    lore: lang === 'zh' ? '传说百科' : 'Lore Keeper',
    footerZh: '如果你对 Dota2 与 AI 感兴趣，请联系我',
    footerEn: 'If you are interested in Dota 2 and AI, please contact me'
  };

  const NavItem = ({ tab, icon: Icon, label }: { tab: AppTab, icon: any, label: string }) => (
    <button
      onClick={() => {
        setActiveTab(tab);
        setMobileMenuOpen(false);
      }}
      className={`
        flex items-center gap-2 px-4 py-2 rounded transition-all duration-300 font-display tracking-wide
        ${activeTab === tab 
          ? 'bg-gradient-to-r from-dota-red/80 to-transparent text-white border-l-2 border-dota-red' 
          : 'text-gray-400 hover:text-white hover:bg-white/5'}
      `}
    >
      <Icon size={18} />
      {label}
    </button>
  );

  return (
    <div className="min-h-screen flex flex-col bg-[#0f1014] text-white overflow-hidden bg-[url('https://cdn.pixabay.com/photo/2021/09/07/07/11/game-console-6603120_1280.jpg')] bg-cover bg-fixed bg-blend-multiply">
      
      {/* Navbar */}
      <header className="h-16 border-b border-gray-800 bg-[#0f1014]/90 backdrop-blur-md fixed top-0 w-full z-50 flex items-center justify-between px-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-gradient-to-br from-red-600 to-black rounded flex items-center justify-center border border-red-500 shadow-[0_0_15px_rgba(255,0,0,0.5)]">
            <span className="font-display font-bold text-xl">D</span>
          </div>
          <h1 className="font-display text-xl tracking-widest font-bold text-gray-100 hidden sm:block">
            DOTA2<span className="text-dota-red">.AI</span>
          </h1>
        </div>

        {/* Desktop Nav */}
        <nav className="hidden md:flex gap-2">
          <NavItem tab={AppTab.DRAFT} icon={Sword} label={t.draft} />
          <NavItem tab={AppTab.LORE} icon={BookOpen} label={t.lore} />
        </nav>

        {/* Right Actions */}
        <div className="flex items-center gap-4">
            <button 
                onClick={toggleLang}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 rounded-full border border-gray-700 transition-colors text-xs font-bold text-dota-gold tracking-wider"
            >
                <Globe size={14} />
                {lang === 'en' ? 'EN' : '中文'}
            </button>

            {/* Mobile Menu Toggle */}
            <button 
            className="md:hidden text-gray-300"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            >
            <Menu />
            </button>
        </div>
      </header>

      {/* Mobile Nav Overlay */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-40 bg-black/95 pt-20 px-6 flex flex-col gap-4 md:hidden">
          <NavItem tab={AppTab.DRAFT} icon={Sword} label={t.draft} />
          <NavItem tab={AppTab.LORE} icon={BookOpen} label={t.lore} />
        </div>
      )}

      {/* Main Content */}
      <main className="pt-24 pb-28 px-4 md:px-8 flex-grow container mx-auto h-[calc(100vh-2rem)]">
        {renderContent()}
      </main>

      {/* Footer Contact Info */}
      <footer className="fixed bottom-0 left-0 w-full bg-[#0f1014]/95 backdrop-blur-md border-t border-gray-800 py-4 z-50 text-center shadow-lg">
        <div className="flex flex-col items-center justify-center gap-1 px-4">
          <p className="text-sm md:text-base text-gray-300 font-sans font-medium">
            {t.footerZh} <span className="hidden sm:inline mx-2 text-gray-600">|</span> <span className="block sm:inline mt-1 sm:mt-0 text-gray-400">{t.footerEn}</span>
          </p>
          <a href="mailto:qianhao1229@gmail.com" className="text-dota-gold hover:text-white transition-colors hover:underline text-base md:text-lg font-bold tracking-wider mt-1">
            qianhao1229@gmail.com
          </a>
        </div>
      </footer>

    </div>
  );
};

export default App;