import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { AgentApiError, askAgent, type ChatTurn, type ToolStep } from './api';

/**
 * The coach, beside the review. Each question goes to the agent, which looks
 * things up in the replay before answering; the lookups show as they happen.
 */

type Lang = 'en' | 'zh';
export interface ChatHandle { ask: (label: string, refs: string[]) => void; /** Ask this question now, as if typed and sent. False when the coach is still answering the last one. */ send: (question: string) => boolean }

const T = {
  title: { en: 'Ask the coach', zh: '问教练' },
  sub: { en: 'The coach looks the moment up in the replay before answering. What the replay cannot show, it says so.', zh: '教练会先去录像里查，再回答；录像看不到的，会直接说明。' },
  placeholder: { en: 'e.g. How should I have played the fight at 30:26?', zh: '例如：30:26 那波团我该怎么打？' },
  send: { en: 'Ask', zh: '提问' },
  stop: { en: 'Stop', zh: '停止' },
  you: { en: 'You', zh: '你' },
  coach: { en: 'Coach', zh: '教练' },
  thinking: { en: 'Thinking…', zh: '思考中…' },
  about: { en: 'About', zh: '围绕' },
  clear: { en: 'Clear', zh: '清除' },
  tooLong: { en: 'Keep the question under 500 characters.', zh: '问题请控制在 500 字以内。' },
  rate: { en: 'Too many questions — wait a minute and try again.', zh: '提问太频繁了，请稍等一分钟再试。' },
  busy: { en: 'The coach is at capacity right now. Try again in a few minutes.', zh: '教练现在忙不过来，过几分钟再试。' },
  failed: { en: 'No answer came back. Try again.', zh: '没有拿到回答，请重试。' },
  unverified: { en: 'Not found in the replay data, treat with care:', zh: '以下内容在录像数据里没有查到，请谨慎看待：' },
  suggest: { en: 'Try asking', zh: '可以这样问' },
} as const;

const TOOLS: Record<string, Record<Lang, string>> = {
  match_overview: { en: 'Reading the whole game', zh: '看整局概况' },
  death_context: { en: 'Looking at a death', zh: '查阵亡前的情况' },
  ability_audit: { en: 'Checking every cast', zh: '查技能释放记录' },
  immunity_windows: { en: 'Checking spell-immunity windows', zh: '查技能免疫窗口' },
  fight_timeline: { en: 'Replaying a fight', zh: '回放团战' },
  item_timeline: { en: 'Checking item timings', zh: '查出装时间' },
  hero_abilities: { en: 'Looking up ability data', zh: '查技能数据' },
  pro_item_choices: { en: 'Comparing with pro builds', zh: '对照职业出装' },
  lane_report: { en: 'Reading the lane', zh: '看对线期' },
  tempo_report: { en: 'Reading who took the map, and when', zh: '看各阶段的推进和节奏' },
  lineup_timing: { en: 'Checking which heroes win short or long games', zh: '查双方英雄在长局、短局的胜率' },
  build_check: { en: 'Checking the build against what killed you', zh: '核对出装和致死伤害' },
  power_spikes: { en: 'Reading when each side became strong', zh: '看双方的强势期' },
  window_report: { en: 'Reading when each side was ahead, and what it took', zh: '看双方的窗口期' },
};
const clockOf = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? `${Math.floor(n / 60)}:${String(Math.floor(n % 60)).padStart(2, '0')}` : String(v); };
export function stepLabel(step: ToolStep, lang: Lang): string {
  const base = TOOLS[step.tool]?.[lang] ?? step.tool;
  const a = step.args ?? {};
  if (step.tool === 'fight_timeline' && a.from != null && a.to != null) return `${base} ${clockOf(a.from)}–${clockOf(a.to)}`;
  if (step.tool === 'death_context' && a.index != null) return `${base} #${a.index}`;
  return base;
}

interface Turn { q: string; a: string; steps: ToolStep[]; pending: boolean; error?: string; unverified?: string[] }

export const ChatRail = forwardRef<ChatHandle, { matchId: string; hero: string; lang: Lang; suggestions: string[]; plan?: string | null }>(({ matchId, hero, lang, suggestions, plan = null }, ref) => {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const [context, setContext] = useState<{ label: string; refs: string[] } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const t = (b: Record<Lang, string>) => b[lang];
  const busy = turns.some((x) => x.pending);
  // Leaving the conversation (another page, hero or language) cancels the answer being worked on: the
  // server stops its lookups and model calls when the connection closes.
  useEffect(() => () => abort.current?.abort(), []);

  // The latest `send` for the handle below: it closes over the turns so far.
  const sendRef = useRef<(text: string) => void>(() => {});
  const busyRef = useRef(false);
  useImperativeHandle(ref, () => ({
    ask: (label, refs) => { setContext({ label, refs }); input.current?.focus(); input.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }); },
    send: (question) => {
      if (busyRef.current) { input.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }); return false; }
      sendRef.current(question);
      input.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
      return true;
    },
  }), []);

  const patch = (fn: (last: Turn) => Turn) => setTurns((prev) => prev.map((x, i) => (i === prev.length - 1 ? fn(x) : x)));

  /** `about`: false sends the words alone — a question that is not about the moment picked in the document. */
  async function send(text: string, about = true) {
    const question = text.trim();
    if (!question || busy) return;
    if (question.length > 500) { setNote(t(T.tooLong)); return; }
    setNote(null);
    // The agent resolves the moment from the ref; the reader sees only their own words.
    const sent = about && context ? `${question}\n(about ${context.refs.join(', ')})` : question;
    const history: ChatTurn[] = turns.filter((x) => x.a && !x.error).slice(-6).map((x) => ({ q: x.q, a: x.a, clean: (x.unverified ?? []).length === 0 }));
    setTurns((prev) => [...prev, { q: question, a: '', steps: [], pending: true }]);
    if (about) { setDraft(''); setContext(null); }
    const ac = new AbortController(); abort.current = ac;
    try {
      await askAgent(matchId, { hero, lang, question: sent.slice(0, 500), history, ...(plan ? { plan } : {}) }, {
        onStep: (step) => patch((x) => ({ ...x, steps: [...x.steps, step] })),
        onText: (a, unverified) => patch((x) => ({ ...x, a, unverified: unverified.map((u) => u.text) })),
        onError: () => patch((x) => ({ ...x, error: t(T.failed) })),
      }, ac.signal);
      patch((x) => ({ ...x, pending: false, error: x.a || x.error ? x.error : t(T.failed) }));
    } catch (e) {
      const aborted = (e as Error).name === 'AbortError';
      const code = e instanceof AgentApiError ? (e.status === 429 ? T.rate : e.status === 503 ? T.busy : T.failed) : T.failed;
      patch((x) => ({ ...x, pending: false, error: aborted ? undefined : t(code) }));
      if (aborted) setTurns((prev) => prev.filter((x, i) => i !== prev.length - 1 || x.a));
    }
  }

  // After every render: the handle above always reaches the turns and the pinned moment as they are now.
  useEffect(() => { sendRef.current = (text) => { void send(text, false); }; busyRef.current = busy; });

  return (
    <aside className="ag-chat" aria-label={t(T.title)}>
      <header>
        <h2>{t(T.title)}</h2>
        <p>{t(T.sub)}</p>
      </header>
      <div className="ag-chat-log" aria-live="polite">
        {turns.length === 0 && suggestions.length > 0 && (
          <div className="ag-suggest">
            <p>{t(T.suggest)}</p>
            {suggestions.map((s) => <button key={s} type="button" onClick={() => send(s)}>{s}</button>)}
          </div>
        )}
        {turns.map((turn, i) => (
          <div key={i} className="ag-turn">
            <p className="ag-q"><span>{t(T.you)}</span>{turn.q}</p>
            <div className="ag-a">
              <span>{t(T.coach)}</span>
              {turn.steps.length > 0 && <ol className="ag-steps">{turn.steps.map((s, j) => <li key={j} className={turn.pending && j === turn.steps.length - 1 ? 'is-live' : ''}>{stepLabel(s, lang)}</li>)}</ol>}
              {turn.pending && !turn.a && turn.steps.length === 0 && <p className="ag-none">{t(T.thinking)}</p>}
              {turn.a && <div className="ag-answer">{turn.a.split(/\n{2,}/).map((para, j) => <p key={j}>{para.replace(/^#+\s*/, '').replace(/\*\*/g, '')}</p>)}</div>}
              {turn.unverified && turn.unverified.length > 0 && <p className="ag-warn">{t(T.unverified)} {turn.unverified.join(', ')}</p>}
              {turn.error && <p className="ag-warn" role="alert">{turn.error}</p>}
            </div>
          </div>
        ))}
      </div>
      <form className="ag-chat-form" onSubmit={(e) => { e.preventDefault(); void send(draft); }}>
        {context && <p className="ag-context">{t(T.about)} <b>{context.label}</b><button type="button" className="ag-link" onClick={() => setContext(null)}>{t(T.clear)}</button></p>}
        <textarea ref={input} value={draft} rows={2} maxLength={600} placeholder={t(T.placeholder)} aria-label={t(T.title)}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(draft); } }} />
        {note && <p className="ag-warn" role="alert">{note}</p>}
        {busy
          ? <button type="button" className="ag-btn" onClick={() => abort.current?.abort()}>{t(T.stop)}</button>
          : <button type="submit" className="ag-btn is-primary" disabled={!draft.trim()}>{t(T.send)}</button>}
      </form>
    </aside>
  );
});
ChatRail.displayName = 'ChatRail';
