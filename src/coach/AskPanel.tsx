import React, { forwardRef, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { askCoach, CoachApiError, type AskTurn } from './api';
import { useLang } from './ui';
import type { Bi, CoachReport, Review } from './types';

/**
 * "Ask the coach" — follow-up questions on this player's report. Answers
 * stream from /api/coach/:id/ask, which only uses this report's facts and
 * falls back to the report's own text when no model is available.
 */

export interface AskHandle { prefill: (text: string) => void }

const T = {
  title: { en: 'Ask the coach', zh: '追问教练' },
  sub: { en: 'Answers use only this review\'s data. If the data cannot show it, the coach says so.', zh: '回答只依据这份复盘的数据；数据看不到的，教练会直接说明。' },
  placeholder: { en: 'e.g. Which of my deaths was the most avoidable?', zh: '例如：我哪一次死亡最不应该？' },
  send: { en: 'Ask', zh: '提问' },
  stop: { en: 'Stop', zh: '停止' },
  you: { en: 'You', zh: '你' },
  coach: { en: 'Coach', zh: '教练' },
  thinking: { en: 'Reading the review…', zh: '正在翻看复盘…' },
  rateLimited: { en: 'Too many questions — wait a minute and try again.', zh: '提问太频繁了，请稍等一分钟再试。' },
  failed: { en: 'Could not get an answer. Try again.', zh: '没有拿到回答，请重试。' },
  tooLong: { en: 'Keep the question under 500 characters.', zh: '问题请控制在 500 字以内。' },
} satisfies Record<string, Bi>;

interface Turn { q: string; a: string; notice?: string; error?: string; pending: boolean }

function suggestions(report: CoachReport, review: Review, lang: 'en' | 'zh'): string[] {
  const zh = lang === 'zh';
  const ch = review.chapters;
  const out: string[] = [];
  const killer = ch?.deaths?.summary.top_killer;
  if (killer && killer.deaths >= 3) {
    const h = report.players.find((p) => p.hero.id === killer.hero)?.hero;
    if (h) out.push(zh ? `为什么我总死于${h.zh}？下一局怎么避免？` : `Why did I keep dying to ${h.en}, and how do I avoid it next game?`);
  }
  if (ch?.deaths) out.push(zh ? '我哪一次死亡最不应该？' : 'Which of my deaths was the most avoidable?');
  if (ch?.fights) out.push(zh ? '哪一波团战最关键？我当时该做什么？' : 'Which fight mattered most, and what should I have done?');
  if (ch?.items) out.push(zh ? '我的出装顺序应该怎么调整？' : 'How should I have ordered my build?');
  out.push(zh ? '下一局我最该先练什么？' : 'What should I practise first next game?');
  return out.slice(0, 4);
}

/** Minimal, safe rendering: paragraphs, "- " lists and **bold**. */
function Answer({ text }: { text: string }) {
  const blocks: React.ReactNode[] = [];
  let list: string[] = [];
  const inline = (s: string, key: string) => s.split(/(\*\*[^*]+\*\*)/g).map((part, i) => (
    part.startsWith('**') && part.endsWith('**') ? <strong key={`${key}-${i}`}>{part.slice(2, -2)}</strong> : <React.Fragment key={`${key}-${i}`}>{part}</React.Fragment>
  ));
  const flush = (key: string) => {
    if (list.length) blocks.push(<ul key={key}>{list.map((x, i) => <li key={i}>{inline(x, `${key}-${i}`)}</li>)}</ul>);
    list = [];
  };
  text.split('\n').forEach((line, i) => {
    const m = /^\s*(?:[-*•]|\d+[.)、])\s+(.*)$/.exec(line);
    if (m) { list.push(m[1]); return; }
    flush(`l${i}`);
    if (line.trim()) blocks.push(<p key={`p${i}`}>{inline(line, `p${i}`)}</p>);
  });
  flush('end');
  return <>{blocks}</>;
}

export const AskPanel = forwardRef<AskHandle, { report: CoachReport; review: Review; pos: number | null }>(({ report, review, pos }, ref) => {
  const { lang, L } = useLang();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const panel = useRef<HTMLElement>(null);
  const abort = useRef<AbortController | null>(null);
  const chips = useMemo(() => suggestions(report, review, lang), [report, review, lang]);

  useImperativeHandle(ref, () => ({
    prefill: (text: string) => {
      setDraft(text);
      panel.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      window.setTimeout(() => { input.current?.focus(); input.current?.setSelectionRange(text.length, text.length); }, 250);
    },
  }), []);

  const ask = async (question: string) => {
    const q = question.trim();
    if (!q || busy) return;
    if (q.length > 500) { setTurns((t) => [...t, { q, a: '', error: L(T.tooLong), pending: false }]); return; }
    const history: AskTurn[] = turns.filter((t) => t.a && !t.error).slice(-3).map((t) => ({ q: t.q, a: t.a }));
    setDraft('');
    setBusy(true);
    setTurns((t) => [...t, { q, a: '', pending: true }]);
    const ac = new AbortController();
    abort.current = ac;
    // Functional updates only: chunks append to the last turn.
    const patchLast = (fn: (t: Turn) => Turn) => setTurns((all) => all.map((t, i) => (i === all.length - 1 ? fn(t) : t)));
    try {
      await askCoach(String(report.match.id), { slot: review.slot, pos, lang, question: q, history }, {
        onText: (text) => patchLast((t) => ({ ...t, a: t.a + text })),
        onNotice: (notice) => patchLast((t) => ({ ...t, notice })),
      }, ac.signal);
      patchLast((t) => ({ ...t, pending: false }));
    } catch (e) {
      if ((e as Error).name === 'AbortError') { patchLast((t) => ({ ...t, pending: false })); return; }
      const msg = e instanceof CoachApiError && e.status === 429 ? L(T.rateLimited) : L(T.failed);
      patchLast((t) => ({ ...t, pending: false, error: msg }));
    } finally {
      setBusy(false);
      abort.current = null;
    }
  };

  return (
    <section className="cx-ask-panel" ref={panel} aria-labelledby="cx-ask-h">
      <h3 id="cx-ask-h" className="cx-chapter-title">{L(T.title)}</h3>
      <p className="cx-muted">{L(T.sub)}</p>
      {turns.length > 0 && (
        <ol className="cx-turns" aria-live="polite">
          {turns.map((t, i) => (
            <li key={i}>
              <p className="cx-turn-q"><span>{L(T.you)}</span>{t.q}</p>
              <div className="cx-turn-a">
                <span>{L(T.coach)}</span>
                {t.a ? <Answer text={t.a} /> : t.pending ? <p className="cx-muted">{L(T.thinking)}</p> : null}
                {t.notice && <p className="cx-caveat">{t.notice}</p>}
                {t.error && <p className="cx-err">{t.error}</p>}
              </div>
            </li>
          ))}
        </ol>
      )}
      <div className="cx-chips">
        {chips.map((c) => <button key={c} type="button" className="cx-chip-btn" disabled={busy} onClick={() => void ask(c)}>{c}</button>)}
      </div>
      <form className="cx-ask-form" onSubmit={(e) => { e.preventDefault(); void ask(draft); }}>
        <label htmlFor="cx-ask-input" className="cx-sr">{L(T.title)}</label>
        <textarea
          id="cx-ask-input" ref={input} rows={2} maxLength={500} value={draft}
          placeholder={L(T.placeholder)} onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void ask(draft); } }}
        />
        {busy
          ? <button type="button" className="cx-ghost" onClick={() => abort.current?.abort()}>{L(T.stop)}</button>
          : <button type="submit" className="cx-primary" disabled={!draft.trim()}>{L(T.send)}</button>}
      </form>
    </section>
  );
});
AskPanel.displayName = 'AskPanel';
