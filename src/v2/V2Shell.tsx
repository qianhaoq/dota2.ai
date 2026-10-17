import React, { useEffect } from 'react';
import TopBar from './components/TopBar';
import Composer from './components/Composer';
import './tokens.css';

/**
 * V2 conversational shell: TopBar on top, a scrollable 720px chat column, and
 * the sticky bottom Composer. Sets its own light background/ink/font via
 * `.d2-root` (see tokens.css) so the legacy dark global styles don't leak in.
 * `noIndex` adds `<meta name="robots" content="noindex">` while mounted.
 */
const V2Shell: React.FC<{ children: React.ReactNode; noIndex?: boolean }> = ({ children, noIndex = false }) => {
  useEffect(() => {
    if (!noIndex) return;
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex';
    document.head.appendChild(meta);
    return () => {
      document.head.removeChild(meta);
    };
  }, [noIndex]);

  return (
    <div className="d2-root">
      <TopBar />
      <div className="flex-1 min-h-0 overflow-y-auto">
        <main className="max-w-d2-chat mx-auto px-[16px] pt-[16px] pb-[24px]">{children}</main>
      </div>
      <Composer />
    </div>
  );
};

export default V2Shell;
