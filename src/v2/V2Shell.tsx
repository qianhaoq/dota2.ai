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
  /** Sits just above the composer, outside the scroll column, so it cannot cover review cards. */
  aboveComposer?: React.ReactNode;
  topBarAction?: React.ReactNode;
  /** Desktop evidence rail (420px, ≥lg); sits beside the chat column + composer. */
  panel?: React.ReactNode;
  /** Overlay layer rendered at the root (e.g. the mobile evidence sheet). */
  layer?: React.ReactNode;
  /** Home owns its wider two-column layout and places the composer in the hero. */
  home?: boolean;
}> = ({ children, noIndex = false, scrollRef, onScroll, composer, aboveComposer, topBarAction, panel, layer, home = false }) => {
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
    <div className={`d2-root pt-safe px-safe${home ? ' d2-home-root' : ''}`}>
      <TopBar action={topBarAction} home={home} />
      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0 flex flex-col">
          <div ref={scrollRef} onScroll={onScroll} className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
            <main className={home ? 'd2-home-main' : 'max-w-d2-chat mx-auto px-[16px] pt-[16px] pb-[24px]'}>{children}</main>
          </div>
          {aboveComposer ? <div className="flex justify-end px-[16px]">{aboveComposer}</div> : null}
          {composer ?? (home ? null : <Composer />)}
        </div>
        {panel}
      </div>
      {layer}
    </div>
  );
};

export default V2Shell;
