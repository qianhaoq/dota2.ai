import React from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useVisualViewportHeight } from './app/useVisualViewportHeight';
import { I18nProvider } from './v2/i18n/I18nProvider';
import { FlagsProvider } from './v2/FlagsProvider';
import { CoachHome, CoachPlayerPage } from './coach/CoachApp';
import { AgentMatchPage } from './agent/AgentMatchPage';

/** Any path that is not a page goes home, keeping the language choice. */
const ToHome: React.FC = () => {
  const lang = new URLSearchParams(useLocation().search).get('lang');
  return <Navigate to={lang === 'en' || lang === 'zh' ? `/?lang=${lang}` : '/'} replace />;
};

/**
 * Route table, exported separately from BrowserRouter so tests can render it
 * under a MemoryRouter. The coach is the only UI: home `/`, review `/r/:id`,
 * player `/p/:id`. Any other path goes to the home page. The visualViewport
 * `--app-height` sync runs here so it applies on every route.
 */
export const AppRoutes: React.FC = () => {
  useVisualViewportHeight();
  return (
    <Routes>
      <Route path="/r/:matchId" element={<AgentMatchPage />} />
      <Route path="/p/:accountId" element={<CoachPlayerPage />} />
      <Route path="/" element={<CoachHome />} />
      <Route path="*" element={<ToHome />} />
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
