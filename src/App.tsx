import React, { useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useVisualViewportHeight } from './app/useVisualViewportHeight';
import { I18nProvider } from './v2/i18n/I18nProvider';
import { FlagsProvider } from './v2/FlagsProvider';
import { CoachHome, CoachPlayerPage, CoachReportPage } from './coach/CoachApp';

/**
 * Retired pages go to their replacements (one UI: the coach cards):
 * - `/m/:id` (old conversational review) → `/r/:id`, keeping `?lang`
 * - `/new/*`, `/legacy/*` → `/`
 * - legacy hash links: `/#/match/:id` or `/#/m/:id` → `/r/:id`; `/#<tool>` → `/`
 */
const keepLang = (search: string) => {
  const lang = new URLSearchParams(search).get('lang');
  return lang === 'en' || lang === 'zh' ? `?lang=${lang}` : '';
};

const ToReview: React.FC = () => {
  const { matchId = '' } = useParams();
  const { search } = useLocation();
  return <Navigate to={/^\d+$/.test(matchId) ? `/r/${matchId}${keepLang(search)}` : `/${keepLang(search)}`} replace />;
};

const ToHome: React.FC = () => {
  const { search } = useLocation();
  return <Navigate to={`/${keepLang(search)}`} replace />;
};

const LegacyHashRedirect: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    if (location.pathname !== '/') return;
    const hash = location.hash.replace(/^#/, '');
    if (!hash) return;
    const matchHash = hash.match(/^\/?(?:match|m)\/(\d+)\b/);
    navigate(matchHash ? `/r/${matchHash[1]}${keepLang(location.search)}` : `/${keepLang(location.search)}`, { replace: true });
  }, [location, navigate]);

  return null;
};

/**
 * Route table, exported separately from BrowserRouter so tests can render it
 * under a MemoryRouter. The coach is the only UI: home `/`, review `/r/:id`,
 * player `/p/:id`; retired routes redirect. The visualViewport
 * `--app-height` sync runs here so it applies on every route.
 */
export const AppRoutes: React.FC = () => {
  useVisualViewportHeight();
  return (
    <>
      <LegacyHashRedirect />
      <Routes>
        <Route path="/r/:matchId" element={<CoachReportPage />} />
        <Route path="/p/:accountId" element={<CoachPlayerPage />} />
        <Route path="/m/:matchId" element={<ToReview />} />
        <Route path="/m" element={<ToHome />} />
        <Route path="/new/*" element={<ToHome />} />
        <Route path="/legacy/*" element={<ToHome />} />
        <Route path="/" element={<CoachHome />} />
        <Route path="*" element={<CoachHome />} />
      </Routes>
    </>
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
