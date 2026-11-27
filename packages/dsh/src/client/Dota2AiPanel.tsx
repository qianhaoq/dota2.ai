import React, { Component, useEffect, useRef, type ReactNode } from 'react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { AppRoutes } from '../../../../src/App';
import { I18nProvider, useI18n } from '../../../../src/v2/i18n/I18nProvider';
import { FlagsProvider } from '../../../../src/v2/FlagsProvider';
import type { LocaleKey } from './locales';

export interface PanelNavigationState {
  path: string;
  revision: number;
  sessionId?: string;
}

class PanelErrorBoundary extends Component<
  { children: ReactNode; t: (key: LocaleKey) => string },
  { hasError: boolean; revision: number }
> {
  state = { hasError: false, revision: 0 };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return (
        <section className="dota2ai-dsh-error" role="alert">
          <h2>{this.props.t('renderErrorTitle')}</h2>
          <p>{this.props.t('renderErrorBody')}</p>
          <button
            type="button"
            onClick={() => this.setState((s) => ({ hasError: false, revision: s.revision + 1 }))}
          >
            {this.props.t('restore')}
          </button>
        </section>
      );
    }
    return <React.Fragment key={this.state.revision}>{this.props.children}</React.Fragment>;
  }
}

/** Sync external navigation requests (e.g. clicking a `ToolCard` in DSH chat) into `MemoryRouter`. */
const NavigationBridge: React.FC<{ nav: PanelNavigationState; hostLang: 'en' | 'zh' }> = ({ nav, hostLang }) => {
  const navigate = useNavigate();
  const { lang, setLang } = useI18n();
  const lastRev = useRef(nav.revision);
  const syncedInitialLang = useRef(false);

  useEffect(() => {
    if (!syncedInitialLang.current) {
      syncedInitialLang.current = true;
      if (lang !== hostLang && !nav.path.includes('lang=')) {
        setLang(hostLang);
      }
    }
  }, [hostLang, lang, nav.path, setLang]);

  useEffect(() => {
    if (nav.revision !== lastRev.current) {
      lastRev.current = nav.revision;
      navigate(nav.path);
    }
  }, [nav.path, nav.revision, navigate]);

  return null;
};

export interface Dota2AiPanelProps {
  t: (key: LocaleKey) => string;
  useNav: <T>(selector: (state: PanelNavigationState) => T) => T;
}

export const Dota2AiPanel: React.FC<Dota2AiPanelProps> = ({ t, useNav }) => {
  const nav = useNav((s) => s);
  const hostLang: 'en' | 'zh' = t('open').includes('打开') ? 'zh' : 'en';
  const initialPath = nav.path || `/?lang=${hostLang}`;

  return (
    <div className="dota2ai-dsh-host" data-testid="dota2ai-dsh-panel">
      <PanelErrorBoundary t={t}>
        <MemoryRouter initialEntries={[initialPath]}>
          <I18nProvider>
            <FlagsProvider>
              <NavigationBridge nav={nav} hostLang={hostLang} />
              <AppRoutes />
            </FlagsProvider>
          </I18nProvider>
        </MemoryRouter>
      </PanelErrorBoundary>
    </div>
  );
};
