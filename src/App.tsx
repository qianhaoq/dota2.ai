import React, { useEffect } from 'react';
import { BrowserRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import WorkspaceShell from './app/WorkspaceShell';
import { isNavId } from './app/nav';
import { useVisualViewportHeight } from './app/useVisualViewportHeight';
import { I18nProvider, useI18n } from './v2/i18n/I18nProvider';
import { FlagsProvider, useFlags } from './v2/FlagsProvider';
import V2Shell from './v2/V2Shell';
import EmptyState from './v2/components/EmptyState';
import NewPage from './v2/pages/NewPage';
import MatchPage from './v2/pages/MatchPage';

/**
 * Legacy app — unchanged behavior, but the language now comes from the shared
 * I18nProvider (URL ?lang= / localStorage / browser) instead of local state,
 * so it applies and persists on /legacy too.
 */
const LegacyApp: React.FC = () => {
  const { lang, setLang } = useI18n();

  return <WorkspaceShell lang={lang} onToggleLang={() => setLang(lang === 'en' ? 'zh' : 'en')} />;
};

/** The new conversational home (`/` and unknown paths while ui_v2 is on). */
const HomePage: React.FC = () => (
  <V2Shell>
    <EmptyState />
  </V2Shell>
);

/**
 * Legacy deep links:
 * - `/#training` (workspace nav) → `/legacy#training`
 * - `/#/match/:id` or `/#/m/:id` → `/m/:id` (hash never reaches the server)
 */
const LegacyHashRedirect: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    if (location.pathname !== '/') return;
    const hash = location.hash.replace(/^#/, '');
    if (!hash) return;

    const matchHash = hash.match(/^\/?(?:match|m)\/(\d+)\b/);
    if (matchHash) {
      navigate(`/m/${matchHash[1]}${location.search}`, { replace: true });
      return;
    }

    if (isNavId(hash)) {
      navigate(`/legacy#${hash}`, { replace: true });
    }
  }, [location, navigate]);

  return null;
};

/**
 * Route table, exported separately from BrowserRouter so tests can render it
 * under a MemoryRouter. `/` and unknown paths render the v2 home (rollback:
 * build env VITE_FF_UI_V2=0 puts the legacy app back on both); `/legacy/*`
 * renders the legacy app unchanged; `/new/*` is a noindex alias of the home;
 * `/m/:matchId` is the v2 conversational review. Bare `/m` (no id) renders
 * the invalid-match view. The visualViewport `--app-height` sync runs here so
 * it applies on every route, including direct /new or /m loads.
 */
export const AppRoutes: React.FC = () => {
  useVisualViewportHeight();
  const flags = useFlags();
  const home = flags.ui_v2 ? <HomePage /> : <LegacyApp />;

  return (
    <>
      <LegacyHashRedirect />
      <Routes>
        <Route path="/new/*" element={<NewPage />} />
        <Route path="/m/:matchId" element={<MatchPage />} />
        <Route path="/m" element={<MatchPage />} />
        <Route path="/legacy/*" element={<LegacyApp />} />
        <Route path="/" element={home} />
        <Route path="*" element={home} />
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
