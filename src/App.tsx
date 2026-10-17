import React from 'react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import WorkspaceShell from './app/WorkspaceShell';
import { useVisualViewportHeight } from './app/useVisualViewportHeight';
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

  return <WorkspaceShell lang={lang} onToggleLang={() => setLang(lang === 'en' ? 'zh' : 'en')} />;
};

/**
 * Route table, exported separately from BrowserRouter so tests can render it
 * under a MemoryRouter. `/` and `/legacy/*` (and any unknown path — safe
 * default) render the legacy WorkspaceShell; `/new/*` and `/m/:matchId` render
 * the v2 conversational shell. Bare `/m` (no id) renders the invalid-match
 * view. The visualViewport `--app-height` sync runs here so it applies on
 * every route, including direct /new or /m loads.
 */
export const AppRoutes: React.FC = () => {
  useVisualViewportHeight();
  return (
    <Routes>
      <Route path="/new/*" element={<NewPage />} />
      <Route path="/m/:matchId" element={<MatchPage />} />
      <Route path="/m" element={<MatchPage />} />
      <Route path="*" element={<LegacyApp />} />
    </Routes>
  );
};

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
