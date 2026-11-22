import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { SafeImg, useLang } from './ui';
import { fetchCoachCards, type CardSurface } from './api';
import { accessSnippets, agentPrompt, type AccessMode } from './accessSnippets';
import type { Bi } from './types';

const T = {
  sampleTitle: { en: 'A real review, live', zh: '一份真实复盘（实时）' },
  sampleSub: { en: 'Match {id} · built by the engine as you look', zh: '比赛 {id} · 引擎实时生成' },
  open: { en: 'Open the full review →', zh: '打开完整复盘 →' },
  unavailable: { en: 'The sample is unavailable right now — open the review directly.', zh: '示例暂时不可用——可以直接打开完整复盘。' },
  doNext: { en: 'Do next game', zh: '下一局' },
  waysTitle: { en: 'Four ways to use it', zh: '四种用法' },
  copy: { en: 'Copy', zh: '复制' },
  copied: { en: 'Copied', zh: '已复制' },
  promptTitle: { en: 'Or send this to your agent', zh: '或者，把这段话发给你的 Agent' },
  seatGroup: { en: 'Seat in the sample match', zh: '示例比赛中的座位' },
};

/** Seats of the sample match shown on the home page (facts of that match). */
export const SAMPLE_SEATS: { slot: number; slug: string; hero: Bi }[] = [
  { slot: 0, slug: 'tidehunter', hero: { en: 'Tidehunter', zh: '潮汐猎人' } },
  { slot: 2, slug: 'warlock', hero: { en: 'Warlock', zh: '术士' } },
  { slot: 4, slug: 'spectre', hero: { en: 'Spectre', zh: '幽鬼' } },
];
const ICON = (slug: string) => `https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/heroes/icons/${slug}.png`;

type Finding = { title: Bi; action: Bi; tone: string };

/**
 * The first screen's working object: the engine's own cards for one seat of
 * the sample match, fetched live (GET /api/coach/:id/cards). Headline + the
 * first finding and its "do next game". Fixed height while loading; on
 * failure a plain link, never made-up content.
 */
export const LiveSample: React.FC<{ matchId: string }> = ({ matchId }) => {
  const { lang, L } = useLang();
  const [slot, setSlot] = useState(SAMPLE_SEATS[0].slot);
  const [state, setState] = useState<{ status: 'loading' | 'ok' | 'error'; surface?: CardSurface }>({ status: 'loading' });
  useEffect(() => {
    let live = true;
    setState({ status: 'loading' });
    fetchCoachCards(matchId, slot)
      .then((surface) => { if (live) setState({ status: 'ok', surface }); })
      .catch(() => { if (live) setState({ status: 'error' }); });
    return () => { live = false; };
  }, [matchId, slot]);

  const cards = state.surface?.cards ?? [];
  const headline = cards.find((c) => c.component === 'Headline')?.data?.text as Bi | undefined;
  const finding = cards.find((c) => c.component === 'Finding')?.data?.finding as Finding | undefined;
  const href = `/r/${matchId}?p=${slot}&lang=${lang}`;

  return (
    <section className="hm-live" aria-labelledby="hm-live-title" aria-busy={state.status === 'loading'}>
      <div className="hm-live-head">
        <h2 id="hm-live-title">{L(T.sampleTitle)}</h2>
        <span>{L(T.sampleSub).replace('{id}', matchId)}</span>
      </div>
      <div className="hm-seats" role="radiogroup" aria-label={L(T.seatGroup)}>
        {SAMPLE_SEATS.map((s) => (
          <button key={s.slot} type="button" role="radio" aria-checked={slot === s.slot} className={slot === s.slot ? 'is-on' : ''} onClick={() => setSlot(s.slot)}>
            <SafeImg src={ICON(s.slug)} alt="" className="hm-seat-icon" />{L(s.hero)}
          </button>
        ))}
      </div>
      <div className="hm-live-body">
        {state.status === 'loading' && <div className="hm-skeleton" aria-hidden="true"><span /><span /><span /></div>}
        {state.status === 'error' && <p className="hm-live-err">{L(T.unavailable)}</p>}
        {state.status === 'ok' && (
          <>
            {headline && <p className="hm-live-headline">{L(headline)}</p>}
            {finding && (
              <div className="hm-live-finding">
                {/* The headline is usually this finding's title: never say it twice. */}
                {!(headline && L(headline).includes(L(finding.title))) && <h3>{L(finding.title)}</h3>}
                <p><b>{L(T.doNext)}</b>{L(finding.action)}</p>
              </div>
            )}
          </>
        )}
      </div>
      <Link to={href} className="hm-live-open">{L(T.open)}</Link>
    </section>
  );
};

/** Copy text to the clipboard; resolves false when the browser refuses. */
async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

const CopyButton: React.FC<{ text: string; label: string }> = ({ text, label }) => {
  const { L } = useLang();
  const [done, setDone] = useState(false);
  return (
    <button type="button" className="hm-copy" aria-label={`${L(T.copy)} ${label}`}
      onClick={async () => { if (await copyText(text)) { setDone(true); setTimeout(() => setDone(false), 1600); } }}>
      {done ? L(T.copied) : L(T.copy)}
    </button>
  );
};

/** Web / Agent (MCP) / CLI / HTTP, each with commands that work as written, plus a prompt for any agent. */
export const AccessModes: React.FC<{ matchId: string; onWeb: () => void }> = ({ matchId, onWeb }) => {
  const { lang, L } = useLang();
  const modes = accessSnippets(matchId);
  const [mode, setMode] = useState<AccessMode>('mcp');
  const cur = modes.find((m) => m.mode === mode)!;
  const prompt = agentPrompt(lang);
  return (
    <section className="hm-ways" aria-labelledby="hm-ways-title">
      <h2 id="hm-ways-title">{L(T.waysTitle)}</h2>
      <div className="hm-ways-tabs" role="tablist" aria-label={L(T.waysTitle)}>
        {modes.map((m) => (
          <button key={m.mode} type="button" role="tab" aria-selected={mode === m.mode} className={mode === m.mode ? 'is-on' : ''}
            onClick={() => { setMode(m.mode); if (m.mode === 'web') onWeb(); }}>
            {L(m.label)}
          </button>
        ))}
      </div>
      <div className="hm-ways-panel" role="tabpanel">
        {cur.lines.length > 0 && (
          <div className="hm-code">
            <pre><code>{cur.lines.join('\n')}</code></pre>
            <CopyButton text={cur.lines.join('\n')} label={L(cur.label)} />
          </div>
        )}
        <p className="hm-ways-note">{L(cur.note)}{cur.links && <> {cur.links.map((l) => <a key={l.href} href={l.href}>{l.label}</a>)}</>}</p>
      </div>
      <div className="hm-prompt">
        <h3>{L(T.promptTitle)}</h3>
        <div className="hm-code">
          <pre><code>{prompt}</code></pre>
          <CopyButton text={prompt} label={L(T.promptTitle)} />
        </div>
      </div>
    </section>
  );
};
