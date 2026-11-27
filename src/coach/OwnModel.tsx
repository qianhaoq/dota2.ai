import React from 'react';
import { trackEvent } from '../services/analytics';
import { useDota2AiRuntime } from '../runtime/dota2aiRuntime';
import { useLang } from './ui';
import type { Bi } from './types';

/**
 * The same coach on the reader's own model: the DSH plugin (DeepSeek Harness) runs the review, the follow-ups and
 * the patch advisor on the reader's own DeepSeek key, so it neither waits on nor spends this site's daily budget.
 * Said on the home page and wherever this site's model says no (a full day, at capacity, out of credit).
 * Inside DSH there is nothing to point at: the reader is there already.
 */
const T = {
  homeLead: { en: 'Run it on your own DeepSeek key', zh: '用你自己的 DeepSeek Key 跑', ru: 'Запускайте на своём ключе DeepSeek' },
  homeBody: {
    en: 'The DeepSeek Harness (DSH) plugin runs the same coach locally: no queue, no daily limit, your replays stay on your machine.',
    zh: 'DeepSeek Harness（DSH）插件在本地跑同一个教练：不排队、不限次，录像和复盘都留在你自己电脑上。',
    ru: 'Плагин для DeepSeek Harness (DSH) запускает того же тренера локально: без очереди и дневного лимита, реплеи остаются у вас.',
  },
  homeCta: { en: 'Set up DSH in 3 steps', zh: '三步装好 DSH', ru: 'Установка DSH в 3 шага' },
  agent: { en: 'or connect your own agent (Claude Code, Codex…)', zh: '或接入你自己的 Agent（Claude Code、Codex…）', ru: 'или подключите своего агента (Claude Code, Codex…)' },
  refusedLead: { en: "Don't want to wait?", zh: '不想等？', ru: 'Не хотите ждать?' },
  dailyLead: { en: "Today's free reviews on dota2.ai are used up.", zh: '今天 dota2.ai 的免费复盘名额用完了。', ru: 'Бесплатные разборы на dota2.ai на сегодня закончились.' },
  refusedBody: {
    en: 'Review this game now in DeepSeek Harness (DSH) on your own DeepSeek key — the same coach, no queue, no daily limit.',
    zh: '用 DeepSeek Harness（DSH）配上你自己的 DeepSeek Key，现在就能复盘这一局：同一个教练，不排队、不限次。',
    ru: 'Разберите эту игру прямо сейчас в DeepSeek Harness (DSH) на своём ключе DeepSeek — тот же тренер, без очереди и лимита.',
  },
  refusedCta: { en: 'Set up DSH', zh: '安装 DSH', ru: 'Установить DSH' },
  thenAsk: { en: 'Then ask it:', zh: '装好后问它：', ru: 'Затем спросите:' },
};

const ASK: Bi = {
  en: 'Review my Dota 2 match {id}',
  zh: '复盘我的 Dota 2 比赛 {id}',
  ru: 'Разбери мой матч Dota 2 {id}',
};

export const DSH_ANCHOR = '/#ways-dsh';

/**
 * `where`: 'home' — the hero's line under the search box; 'refused' — this site's model said no for now
 * (`daily`: because the day's reviews are used up); 'chat' — a follow-up was refused. `matchId`: the game the
 * reader wanted, said in the prompt to give DSH.
 */
export const OwnModelCallout: React.FC<{ where: 'home' | 'refused' | 'chat'; daily?: boolean; matchId?: string }> = ({ where, daily = false, matchId }) => {
  const { L } = useLang();
  const runtime = useDota2AiRuntime();
  if (runtime.surface === 'dsh') return null;
  const click = (to: 'dsh' | 'agent') => trackEvent('own_model_cta', { where, to, ...(daily ? { daily: true } : {}) });
  if (where === 'home') {
    return (
      <div className="om-callout is-home" role="note">
        <p className="om-lead"><strong>{L(T.homeLead)}</strong> <span className="om-tag">DSH</span></p>
        <p className="om-body">{L(T.homeBody)}</p>
        <p className="om-links">
          <a href="#ways-dsh" className="om-cta" onClick={() => click('dsh')}>{L(T.homeCta)} →</a>
          <a href="#ways" className="om-alt" onClick={() => click('agent')}>{L(T.agent)}</a>
        </p>
      </div>
    );
  }
  return (
    <div className="om-callout is-refused" role="note">
      <p className="om-lead"><strong>{L(daily ? T.dailyLead : T.refusedLead)}</strong></p>
      <p className="om-body">{L(T.refusedBody)}</p>
      {matchId && <p className="om-ask"><span>{L(T.thenAsk)}</span> <q>{L(ASK).replace('{id}', matchId)}</q></p>}
      <p className="om-links">
        <a href={DSH_ANCHOR} className="om-cta" onClick={() => click('dsh')}>{L(T.refusedCta)} →</a>
        <a href="/#ways" className="om-alt" onClick={() => click('agent')}>{L(T.agent)}</a>
      </p>
    </div>
  );
};
