import React, { useEffect } from 'react';
import TopBar from './components/TopBar';
import Composer from './components/Composer';
import './tokens.css';

/**
 * V2 conversational shell: TopBar on top, a scrollable 720px chat column, and
 * the sticky bottom Composer. Sets its own light background/ink/font via
 * `.d2-root` (see tokens.css) so the legacy dark global styles don't leak in.
 * `noIndex` adds `<meta name="robots" content="noindex">` while mounted.
 * Pages that own the scroll (MatchPage) pass a `scrollRef`/`onScroll` pair and
 * may swap the composer (follow-up mode) via the `composer` slot.
 */
const V2Shell: React.FC<{
  children: React.ReactNode;
  noIndex?: boolean;
  scrollRef?: React.Ref<HTMLDivElement>;
  onScroll?: React.UIEventHandler<HTMLDivElement>;
  composer?: React.ReactNode;
  topBarAction?: React.ReactNode;
}> = ({ children, noIndex = false, scrollRef, onScroll, composer, topBarAction }) => {
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
    <div className="d2-root pt-safe px-safe">
      <TopBar action={topBarAction} />
      <div ref={scrollRef} onScroll={onScroll} className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
        <main className="max-w-d2-chat mx-auto px-[16px] pt-[16px] pb-[24px]">{children}</main>
      </div>
      {composer ?? <Composer />}
    </div>
  );
};

export default V2Shell;
