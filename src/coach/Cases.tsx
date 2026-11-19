import React, { useEffect, useState } from 'react';
import { CoachApiError, fetchCoachCases } from './api';
import type { CaseCard, CaseStudies, CaseTheme } from './types';
import { SafeImg, useLang } from './ui';

const T = {
  title: { en: 'Pro games: what worked, what did not', zh: '职业对局参考：正例与反例' },
  sub: {
    en: 'For each problem: a pro game with the same hero (or a similar one) against the same key enemy that repeated it and lost, and one that avoided it and won.',
    zh: '针对你这局的每个问题：找一场同英雄（或相似英雄）、对面同样有关键对手的职业比赛——一场犯了同样的错并输了，一场避开了并赢了。',
  },
  loading: { en: 'Finding similar pro games…', zh: '正在找相似的职业对局…' },
  failed: { en: 'Pro games could not be loaded right now.', zh: '职业对局暂时加载不了。' },
  retry: { en: 'Try again', zh: '重试' },
  empty: { en: 'No pro game was close enough to this one to compare.', zh: '没有找到和这局足够相似的职业对局。' },
  positive: { en: 'Positive', zh: '正例' },
  negative: { en: 'Negative', zh: '反例' },
  won: { en: 'Won', zh: '赢' },
  lost: { en: 'Lost', zh: '输' },
  similarHero: { en: 'similar hero', zh: '相似英雄' },
  open: { en: 'Open this game’s review', zh: '看这局的复盘' },
  metric: { en: 'Metric', zh: '指标' },
  you: { en: 'You', zh: '你' },
  analysis: { en: 'Analysis', zh: '分析' },
  how: { en: 'How cases are chosen', zh: '案例怎么选的' },
  ask: { en: 'Ask about this', zh: '追问这部分' },
};

const fmtDate = (sec: number | null) => (sec ? new Date(sec * 1000).toISOString().slice(0, 10) : '');
const minutes = (sec: number) => `${Math.round(sec / 60)}′`;

/**
 * Worth one silent retry: an upstream failure (5xx) or a network error. A
 * cold cache needs a dozen OpenDota fetches, and whatever the first attempt
 * profiled stays cached server-side, so the retry is cheaper. Client errors
 * (400/404/422) and rate limits (429) would fail the same way again.
 */
export function isRetryableCasesError(e: unknown): boolean {
  if (e instanceof CoachApiError) return e.status >= 500 || e.status === 0;
  return e instanceof TypeError; // fetch() network failure
}

const wait = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  const id = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(id); resolve(); }, { once: true });
});

export const Cases: React.FC<{ matchId: string; slot: number; pos: number | null; onAsk?: () => void; retryDelayMs?: number }> = ({ matchId, slot, pos, onAsk, retryDelayMs = 2000 }) => {
  const { L } = useLang();
  const [state, setState] = useState<{ status: 'loading' | 'ok' | 'error'; data?: CaseStudies }>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const ac = new AbortController();
    setState({ status: 'loading' });
    const load = () => fetchCoachCases(matchId, { slot, pos, signal: ac.signal });
    (async () => {
      try {
        let data;
        try {
          data = await load();
        } catch (e) {
          if (ac.signal.aborted || !isRetryableCasesError(e)) throw e;
          // One silent retry; the reader keeps seeing "finding similar games".
          await wait(retryDelayMs, ac.signal);
          if (ac.signal.aborted) return;
          data = await load();
        }
        if (!ac.signal.aborted) setState({ status: 'ok', data });
      } catch {
        if (!ac.signal.aborted) setState({ status: 'error' });
      }
    })();
    return () => ac.abort();
  }, [matchId, slot, pos, attempt, retryDelayMs]);

  const themes = state.data?.themes ?? [];
  return (
    <article className="cx-chapter cx-cases" id="cx-ch-cases" aria-busy={state.status === 'loading'}>
      <div className="cx-chapter-top">
        <h3 className="cx-chapter-title">{L(T.title)}</h3>
        {state.status === 'ok' && themes.length > 0 && onAsk && <button type="button" className="cx-askbtn" onClick={onAsk}>{L(T.ask)}</button>}
      </div>
      <p className="cx-muted cx-cases-sub">{L(T.sub)}</p>
      {state.status === 'loading' && <p className="cx-muted" role="status">{L(T.loading)}</p>}
      {state.status === 'error' && (
        <p className="cx-muted" role="status">
          {L(T.failed)} <button type="button" className="cx-linkbtn" onClick={() => setAttempt((n) => n + 1)}>{L(T.retry)}</button>
        </p>
      )}
      {state.status === 'ok' && themes.length === 0 && <p className="cx-muted">{L(T.empty)}</p>}
      {themes.map((th) => <Theme key={th.key} th={th} />)}
      {state.status === 'ok' && state.data && themes.length > 0 && (
        <details className="cx-data">
          <summary>{L(T.how)}</summary>
          <p className="cx-muted">{L(state.data.note)}</p>
        </details>
      )}
    </article>
  );
};

const Theme: React.FC<{ th: CaseTheme }> = ({ th }) => {
  const { L } = useLang();
  return (
    <section className="cx-case-theme" aria-label={L(th.title)}>
      <h4 className="cx-case-title">{L(th.title)}</h4>
      <div className="cx-case-cards">
        {th.negative && <Card c={th.negative} kind="negative" />}
        {th.positive && <Card c={th.positive} kind="positive" />}
      </div>
      <div className="cx-case-table-wrap">
        <table className="cx-case-table">
          <thead>
            <tr>
              <th scope="col">{L(T.metric)}</th>
              <th scope="col">{L(T.you)}</th>
              {th.negative && <th scope="col" className="neg">{L(T.negative)}</th>}
              {th.positive && <th scope="col" className="pos">{L(T.positive)}</th>}
            </tr>
          </thead>
          <tbody>
            {th.metrics.map((m) => (
              <tr key={m.key}>
                <th scope="row">{L(m.label)}</th>
                <td>{L(m.mine) || '—'}</td>
                {th.negative && <td className="neg">{L(m.negative) || '—'}</td>}
                {th.positive && <td className="pos">{L(m.positive) || '—'}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {th.analysis.length > 0 && (
        <ul className="cx-case-analysis" aria-label={L(T.analysis)}>
          {th.analysis.map((a, i) => <li key={i}>{L(a)}</li>)}
        </ul>
      )}
    </section>
  );
};

const Card: React.FC<{ c: CaseCard; kind: 'positive' | 'negative' }> = ({ c, kind }) => {
  const { L, lang } = useLang();
  const meta = [c.league, fmtDate(c.start_time), minutes(c.duration)].filter(Boolean).join(' · ');
  return (
    <div className={`cx-case-card ${kind}`}>
      <div className="cx-case-card-top">
        <span className={`cx-case-tag ${kind}`}>{L(T[kind])}</span>
        <span className="cx-case-result">{L(c.won ? T.won : T.lost)} · {c.kda.join('/')}</span>
      </div>
      <div className="cx-case-who">
        {c.hero.img && <SafeImg src={c.hero.img} alt={L(c.hero)} className="cx-case-hero" />}
        <div>
          <b>{L(c.who)}</b>
          {!c.same_hero && <span className="cx-case-similar">{L(T.similarHero)}</span>}
          {c.teams && <span className="cx-muted cx-case-teams">{L(c.teams)}</span>}
        </div>
      </div>
      <p className="cx-muted cx-case-meta">{meta}</p>
      <a className="cx-case-link" href={`/r/${c.match_id}?lang=${lang}&p=${c.slot}`}>{L(T.open)} →</a>
    </div>
  );
};
