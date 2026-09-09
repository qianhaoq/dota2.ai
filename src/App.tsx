import React, { useState, useEffect } from 'react';
import { Language } from './types';
import WorkspaceShell from './app/WorkspaceShell';

const App: React.FC = () => {
  // 中文默认，可切换英文 (bilingual: zh default, en toggle).
  const [lang, setLang] = useState<Language>('zh');

  // Keep the shell on the visual viewport so the sticky composer stays above the iOS keyboard.
  useEffect(() => {
    const root = document.documentElement;
    const sync = () => {
      const height = window.visualViewport?.height ?? window.innerHeight;
      root.style.setProperty('--app-height', `${Math.round(height)}px`);
    };
    sync();
    const vv = window.visualViewport;
    vv?.addEventListener('resize', sync);
    window.addEventListener('resize', sync);
    window.addEventListener('orientationchange', sync);
    return () => {
      vv?.removeEventListener('resize', sync);
      window.removeEventListener('resize', sync);
      window.removeEventListener('orientationchange', sync);
    };
  }, []);

  const toggleLang = () => {
    setLang(prev => prev === 'en' ? 'zh' : 'en');
  };

  // V3: the shell owns navigation (tactical room / training / codex / journal);
  // visual-viewport and safe-area behavior stay here.
  return <WorkspaceShell lang={lang} onToggleLang={toggleLang} />;
};

export default App;
