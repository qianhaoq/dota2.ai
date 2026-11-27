import React, { useRef, useState } from 'react';
import { shareOrigin, useDota2AiRuntime } from '../runtime/dota2aiRuntime';
import { trackEvent } from '../services/analytics';

/**
 * The finished review's two ways out: send the game to the team (each teammate picks their own hero, so the
 * link names no one), or share this review itself. `ref` tells the next visit how it arrived.
 *
 * A phone gets the system share sheet; elsewhere the link is copied. When the browser refuses the clipboard
 * (WeChat's and other in-app browsers often do), the link is shown selected, to copy by hand: a share never
 * fails silently.
 */

type Lang = 'en' | 'zh' | 'ru';
type Target = 'team' | 'self';

const T = {
  team: { en: 'Send to my team', zh: '发给队友', ru: 'Отправить команде' },
  teamHint: { en: 'Each teammate picks their own hero and gets their own review.', zh: '每个队友选自己玩的英雄，拿到自己的复盘。', ru: 'Каждый тиммейт выберет своего героя и получит личный разбор.' },
  teamText: { en: 'I had our game #{id} reviewed — pick the hero you played and see what you could change:', zh: '我把咱们这局 #{id} 复盘了，选你玩的英雄，看看你这局能改什么：', ru: 'Я разобрал наш матч #{id} — выбери своего героя и посмотри, что можно улучшить:' },
  self: { en: 'Copy my link', zh: '复制我的链接', ru: 'Копировать ссылку' },
  selfText: { en: 'My review of game #{id}:', zh: '我这局 #{id} 的复盘：', ru: 'Мой разбор матча #{id}:' },
  teamCopied: { en: 'Link copied — paste it to your team', zh: '链接已复制，发到队伍群里吧', ru: 'Ссылка скопирована — отправьте её команде' },
  copied: { en: 'Copied', zh: '已复制', ru: 'Скопировано' },
  manual: { en: 'Copy this link:', zh: '复制这个链接：', ru: 'Скопируйте эту ссылку:' },
  discuss: { en: 'Discuss in DSH chat', zh: '发送到 DSH 会话', ru: 'Обсудить в чате DSH' },
  discussPrompt: {
    en: 'Let us discuss my Dota 2 match #{id} ({hero}) review.',
    zh: '围绕我这局 Dota 2 比赛 #{id}（{hero}）的复盘继续聊聊。',
    ru: 'Давай обсудим разбор моего матча Dota 2 #{id} ({hero}).',
  },
} as const;

/**
 * Share links. The team link has no hero, plan or seat; the personal one keeps what makes this review this one,
 * its language included: reviews are kept per language, so a link without it opens in the recipient's own
 * language and asks for a review that may not exist. So is the model that wrote it, by its id, wherever the
 * server offers more than it can tell apart without one: the review another model wrote is another review,
 * and which model is the default can change after the link is sent. The team link leaves the language to each teammate,
 * except Chinese, which the sender's team chat is in.
 */
export function shareLinks(origin: string, matchId: string, hero: string, lang: Lang, plan: string | null = null, model: string | null = null) {
  const team = new URLSearchParams({ ref: 'team' });
  const self = new URLSearchParams({ hero });
  if (plan) self.set('plan', plan);
  // Host-local DSH model ids (`dsh.*`) are not offered on the public website: strip them from external share links.
  if (model && !model.startsWith('dsh.')) self.set('model', model);
  self.set('ref', 'share');
  self.set('lang', lang);
  if (lang === 'zh' || lang === 'ru') team.set('lang', lang);
  return { team: `${origin}/r/${matchId}?${team}`, self: `${origin}/r/${matchId}?${self}` };
}

async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

const touch = () => typeof navigator.share === 'function' && Boolean(window.matchMedia?.('(pointer: coarse)').matches);

export const ShareBar: React.FC<{ matchId: string; hero: string; lang: Lang; plan?: string | null; model?: string | null }> = ({ matchId, hero, lang, plan = null, model = null }) => {
  const runtime = useDota2AiRuntime();
  const [copied, setCopied] = useState<Target | null>(null);
  const [manual, setManual] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Host-local DSH model ids (`dsh.*`) are not offered on the public website: strip them from external share links.
  const externalModel = model && model.startsWith('dsh.') ? null : model;
  const links = shareLinks(shareOrigin(), matchId, hero, lang, plan, externalModel);
  const text = (target: Target) => (target === 'team' ? T.teamText : T.selfText)[lang].replace('{id}', matchId);

  const share = async (target: Target) => {
    const url = links[target];
    if (touch()) {
      try {
        await navigator.share({ text: text(target), url });
        trackEvent('report_shared', { target, method: 'native', matchId });
        return;
      } catch (e) {
        // The reader closed the sheet: that is their answer, not a failure to fall back from.
        if ((e as Error)?.name === 'AbortError') return;
      }
    }
    const body = target === 'team' ? `${text(target)} ${url}` : url;
    if (await copyText(body)) {
      setManual(null);
      setCopied(target);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(null), 1800);
      trackEvent('report_shared', { target, method: 'copy', matchId });
      return;
    }
    setManual(body);
  };

  return (
    <div className="ag-share">
      <div className="ag-share-row">
        <button type="button" className="ag-btn is-primary" onClick={() => { void share('team'); }}>{copied === 'team' ? T.teamCopied[lang] : T.team[lang]}</button>
        <button type="button" className="ag-btn" onClick={() => { void share('self'); }}>{copied === 'self' ? T.copied[lang] : T.self[lang]}</button>
        {runtime.onDiscussInHost && (
          <button
            type="button"
            className="ag-btn"
            onClick={() => {
              void runtime.onDiscussInHost?.({
                matchId,
                hero,
                lang,
                text: T.discussPrompt[lang].replace('{id}', matchId).replace('{hero}', hero),
              });
            }}
          >
            {T.discuss[lang]}
          </button>
        )}
      </div>
      <p className="ag-share-hint">{T.teamHint[lang]}</p>
      {manual && (
        <label className="ag-share-manual">
          <span>{T.manual[lang]}</span>
          <input readOnly value={manual} onFocus={(e) => e.currentTarget.select()} autoFocus />
        </label>
      )}
    </div>
  );
};
