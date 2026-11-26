import React, { useEffect, useRef, useState } from 'react';
import { trackEvent } from '../services/analytics';

/**
 * The wait for a review is two to four minutes, and most readers who asked for one left before it came
 * (funnel, 2026-11-26: 4 of 7). Two ways to bring a reader in another tab back when it is ready:
 *
 *  - the tab's title says how far the review is, then "✓ ready" until the reader looks at the tab again;
 *  - on request, a notification from the browser itself (the Notification API: a local notification of this
 *    open page, no push service — so it also works where web push does not, in mainland China).
 *
 * Counted (`ready_callback`): asked / granted / denied for the notification, shown and clicked, and `returned`:
 * a reader who was away when the review came and came back to it, by either way.
 */

type Lang = 'en' | 'zh' | 'ru';
type Kind = 'asked' | 'granted' | 'denied' | 'shown' | 'clicked' | 'returned';

const T = {
  ask: { en: 'Notify me when it is ready', zh: '好了通知我', ru: 'Уведомить, когда будет готово' },
  on: { en: 'You will get a notification when it is ready — go ahead and switch tabs.', zh: '好了会通知你，可以先去干别的。', ru: 'Вы получите уведомление, когда разбор будет готов — можно переключить вкладку.' },
  blocked: { en: 'Notifications are blocked in this browser; this tab\'s title will say when it is ready.', zh: '浏览器拦截了通知；好了的时候这个标签页的标题会提示。', ru: 'Уведомления заблокированы в браузере; статус появится в заголовке вкладки.' },
  working: { en: 'Reviewing', zh: '正在复盘', ru: 'Разбираем' },
  readyTitle: { en: '✓ Review ready', zh: '✓ 复盘好了', ru: '✓ Разбор готов' },
  notifyTitle: { en: 'Your {hero} review is ready', zh: '{hero} 的复盘好了', ru: 'Ваш разбор на {hero} готов' },
} as const;

const supported = () => typeof window !== 'undefined' && 'Notification' in window && typeof window.Notification?.requestPermission === 'function';
const permission = (): NotificationPermission | 'unsupported' => (supported() ? window.Notification.permission : 'unsupported');
const clip = (s: string, n = 120) => ([...s].length > n ? `${[...s].slice(0, n).join('')}…` : s);

/**
 * @param working   the wait is on screen
 * @param step      the live step of the wait (0–3)
 * @param ready     the review is on screen
 * @param selection which review (match|hero|lang|plan…): a notification asked for one is not sent for another
 */
export function useReadyCallback({ matchId, selection, working, step, ready, lang, heroName, verdict }: {
  matchId: string; selection: string; working: boolean; step: number; ready: boolean; lang: Lang; heroName: string | null; verdict: string | null;
}) {
  const [armedFor, setArmedFor] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false);
  const base = useRef<string | null>(null);
  /** The reader was away (tab hidden) at some point while this selection's review was being written. */
  const away = useRef<{ sel: string; at: number } | null>(null);
  const waited = useRef<string | null>(null);
  const track = (kind: Kind) => trackEvent('ready_callback', { matchId, kind });

  const restore = () => { if (base.current != null) { document.title = base.current; base.current = null; } };
  const setTitle = (s: string) => { if (base.current == null) base.current = document.title; document.title = s; };

  // While the wait is on screen: the step in the title.
  useEffect(() => {
    if (!working) {
      // The wait ended without a review (it failed, or the reader went back to pick another hero): the title is
      // the page's again, and nothing is waited on. A wait that ended in the review is the next effect's.
      if (!ready) { restore(); waited.current = null; away.current = null; }
      return;
    }
    waited.current = selection;
    setTitle(`(${step + 1}/4) ${T.working[lang]}${heroName ? ` · ${heroName}` : ''} — dota2.ai`);
    if (document.hidden && away.current?.sel !== selection) away.current = { sel: selection, at: Date.now() };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [working, ready, step, lang, heroName, selection]);

  // Leaving the tab during the wait is noted; looking at it again puts the title back once the review is there.
  useEffect(() => {
    const onVis = () => {
      if (document.hidden) { if (working) away.current = { sel: selection, at: Date.now() }; return; }
      if (ready && away.current?.sel === selection) { track('returned'); away.current = null; }
      if (ready || !working) restore();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [working, ready, selection]);

  // The review came for the selection that was waited on.
  useEffect(() => {
    if (!ready || waited.current !== selection) return;
    waited.current = null;
    if (!document.hidden) { restore(); away.current = null; return; }
    setTitle(`${T.readyTitle[lang]}${heroName ? ` · ${heroName}` : ''} — dota2.ai`);
    if (armedFor === selection && permission() === 'granted') {
      try {
        const n = new window.Notification(T.notifyTitle[lang].replace('{hero}', heroName ?? 'dota2.ai'), { body: verdict ? clip(verdict) : undefined, tag: selection });
        track('shown');
        n.onclick = () => { track('clicked'); window.focus(); n.close(); };
      } catch { /* some browsers only allow notifications from a service worker: the title still says it */ }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, selection]);

  // Leaving the page altogether: the title is the page's again.
  useEffect(() => () => restore(), []);

  const ask = async () => {
    track('asked');
    let p: NotificationPermission = permission() === 'unsupported' ? 'denied' : window.Notification.permission;
    if (p === 'default') { try { p = await window.Notification.requestPermission(); } catch { p = 'denied'; } }
    if (p === 'granted') { setArmedFor(selection); track('granted'); } else { setBlocked(true); track('denied'); }
  };

  // The button only where a notification can be had; a reader who already allowed them is armed with one click too.
  const button = !working || !supported() ? null
    : armedFor === selection ? <p className="ag-notify is-on" role="status">{T.on[lang]}</p>
    : blocked || permission() === 'denied' ? <p className="ag-notify">{T.blocked[lang]}</p>
    : <button type="button" className="ag-btn ag-notify-btn" onClick={() => { void ask(); }}>{T.ask[lang]}</button>;
  return { button };
}
