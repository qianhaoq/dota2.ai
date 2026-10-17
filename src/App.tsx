import React, { useEffect } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import WorkspaceShell from './app/WorkspaceShell';
import { I18nProvider, useI18n } from './v2/i18n/I18nProvider';
import { FlagsProvider } from './v2/FlagsProvider';
import NewPage from './v2/pages/NewPage';
import MatchPage from './v2/pages/MatchPage';

/**
 * Legacy app — unchanged behavior, but the language now comes from the shared
 * I18nProvider (URL ?lang= / localStorage / browser) instead of local state,
 * so it applies and persists on / and /legacy too.
 */
const LegacyApp: React.FC = () => {
  const { lang, setLang } = useI18n();

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

  return <WorkspaceShell lang={lang} onToggleLang={() => setLang(lang === 'en' ? 'zh' : 'en')} />;
};

/**
 * Route table, exported separately from BrowserRouter so tests can render it
 * under a MemoryRouter. `/` and `/legacy/*` (and any unknown path — safe
 * default) render the legacy WorkspaceShell; `/new/*` and `/m/:matchId` render
 * the v2 conversational shell.
 */
export const AppRoutes: React.FC = () => (
  <Routes>
    <Route path="/new/*" element={<NewPage />} />
    <Route path="/m/:matchId" element={<MatchPage />} />
    <Route path="*" element={<LegacyApp />} />
  </Routes>
);

const App: React.FC = () => (
  <BrowserRouter>
    <I18nProvider>
      <FlagsProvider>
        <AppRoutes />
      </FlagsProvider>
    </I18nProvider>
  </BrowserRouter>
);

export default App;
