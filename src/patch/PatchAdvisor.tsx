import React, { useEffect, useRef, useState } from 'react';
import { AgentApiError, type ChatTurn, type ToolStep } from '../agent/api';
import { askAdvisor, fetchPatchOverview, type MoverRow, type PatchOverview } from './api';
import './patch.css';

/**
 * The patch advisor on the home page: who moved since the patch (public win
 * rate and pick rate, before and since), and a box to ask about any change.
 * Each question goes to an agent that looks it up in Valve's notes and the
 * numbers before answering; the lookups show as they happen.
 */

type Lang = 'en' | 'zh';
type Bi = Record<Lang, string>;

const T = {
  title: { en: 'Patch {v} advisor', zh: '{v} 版本顾问' },
  sub: { en: 'Ask what {v} changed, or how a hero is doing since. Changes are quoted from Valve\'s notes; win and pick rates are public matches before and since the patch.', zh: '问它 {v} 改了什么，或者某个英雄改动后表现如何。改动逐条引自官方更新日志；胜率和出场率来自补丁前后的路人局。' },
  winUp: { en: 'Win rate up', zh: '胜率上升' }, winDown: { en: 'Win rate down', zh: '胜率下降' },
  pickUp: { en: 'Picked more', zh: '出场率上升' }, pickDown: { en: 'Picked less', zh: '出场率下降' },
  hero: { en: 'Hero', zh: '英雄' }, before: { en: 'Before', zh: '补丁前' }, after: { en: 'Since', zh: '补丁后' }, change: { en: 'Change', zh: '变化' },
  windows: { en: 'Before: {b0} – {b1} ({bd} days). Since: {a0} – {a1} ({ad} days). All brackets, public matches. A few days of a new patch: these will move.', zh: '补丁前：{b0} 至 {b1}（{bd} 天）；补丁后：{a0} 至 {a1}（{ad} 天）。全部分段的路人局。新版本才几天，数字还会变。' },
  credit: { en: 'Data: STRATZ', zh: '数据：STRATZ' },
  notes: { en: 'Valve\'s {v} notes', zh: '{v} 官方更新日志' },
  askHero: { en: 'What did {v} change for {h}, and how did its win rate and pick rate move?', zh: '{h}在 {v} 改了什么？胜率和出场率怎么变了？' },
  askAbout: { en: 'Ask about {h}', zh: '问问{h}' },
  chat: { en: 'Ask the advisor', zh: '问顾问' },
  log: { en: 'Conversation with the advisor', zh: '与顾问的对话' },
  placeholder: { en: 'e.g. Which carries got stronger at my rank (Legend)?', zh: '例如：传奇分段哪些大哥变强了？' },
  send: { en: 'Ask', zh: '提问' }, stop: { en: 'Stop', zh: '停止' },
  you: { en: 'You', zh: '你' }, advisor: { en: 'Advisor', zh: '顾问' },
  thinking: { en: 'Thinking…', zh: '思考中…' },
  suggest: { en: 'Try asking', zh: '可以这样问' },
  own: { en: 'Ask your own question…', zh: '自己提问…' },
  tooLong: { en: 'Keep the question under 500 characters.', zh: '问题请控制在 500 字以内。' },
  rate: { en: 'Too many questions — wait a minute and try again.', zh: '提问太频繁了，请稍等一分钟再试。' },
  busy: { en: 'The advisor is at capacity right now. Try again in a few minutes.', zh: '顾问现在忙不过来，过几分钟再试。' },
  off: { en: 'The advisor cannot answer right now. The numbers on the left are still current.', zh: '顾问暂时无法回答。左侧的数字仍然是最新的。' },
  failed: { en: 'No answer came back. Try again.', zh: '没有拿到回答，请重试。' },
  unverified: { en: 'Not found in the notes or the numbers, treat with care:', zh: '以下内容在更新日志和数据里没有查到，请谨慎看待：' },
  noData: { en: 'The numbers could not be loaded.', zh: '数据没有加载出来。' },
} as const;

const SUGGEST: Bi[] = [
  { en: 'Who got stronger and who got weaker since the patch?', zh: '这个版本谁变强了，谁变弱了？' },
  { en: 'What are the biggest general changes, and what do they mean for how I play?', zh: '最大的全局改动有哪些？对我的打法意味着什么？' },
  { en: 'Which heroes rose in win rate without being changed in the notes?', zh: '哪些英雄没被改动，胜率却涨了？' },
];

const TOOLS: Record<string, Bi> = {
  patch_overview: { en: 'Reading the patch at a glance', zh: '看版本总览' },
  hero_patch: { en: 'Reading a hero\'s notes and numbers', zh: '查英雄的改动和数据' },
  meta_movers: { en: 'Ranking who moved most', zh: '排胜率和出场率的变化' },
  item_patch: { en: 'Reading an item\'s notes', zh: '查物品改动' },
  general_changes: { en: 'Reading the general changes', zh: '查全局改动' },
  search_notes: { en: 'Searching the patch notes', zh: '搜索更新日志' },
};
export function advisorStepLabel(step: ToolStep, lang: Lang): string {
  const base = TOOLS[step.tool]?.[lang] ?? step.tool;
  // The server names what the step is about; without a name the step is shown on its own, never with an engine key.
  return step.about ? `${base}${lang === 'zh' ? '：' : ': '}${step.about}` : base;
}

/** A share as a percentage with one decimal; a dash when the data has none. */
export const pct = (v: number | null | undefined) => (v == null ? '–' : `${(v * 100).toFixed(1)}%`);
/** A change in points of win rate, signed. */
export const points = (v: number | null | undefined) => (v == null ? '–' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}`);
/** How many times its earlier pick rate. */
export const times = (v: number | null | undefined) => (v == null ? '–' : `×${v.toFixed(2)}`);

const Movers: React.FC<{ title: string; rows: MoverRow[]; by: 'win' | 'pick'; lang: Lang; version: string; onAsk: (q: string) => void; tone: 'up' | 'down' }> = ({ title, rows, by, lang, version, onAsk, tone }) => (
  <div className="pa-movers">
    <table>
      <caption>{title}</caption>
      <thead><tr><th scope="col">{T.hero[lang]}</th><th scope="col">{T.before[lang]}</th><th scope="col">{T.after[lang]}</th><th scope="col">{T.change[lang]}</th></tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.hero}>
            <th scope="row"><button type="button" className="pa-hero" title={T.askAbout[lang].replace('{h}', r.name)} onClick={() => onAsk(T.askHero[lang].replace('{v}', version).replace('{h}', r.name))}>{r.name}</button></th>
            <td>{pct(by === 'win' ? r.win_rate_before : r.pick_rate_before)}</td>
            <td>{pct(by === 'win' ? r.win_rate_after : r.pick_rate_after)}</td>
            <td className={`pa-delta is-${tone}`}>{by === 'win' ? points(r.win_rate_change_in_points) : times(r.pick_rate_times)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

interface Turn { q: string; a: string; steps: ToolStep[]; pending: boolean; error?: string; unverified?: string[] }

export const PatchAdvisor: React.FC<{ lang: Lang; version: string; notesUrl: string }> = ({ lang, version, notesUrl }) => {
  const t = (b: Bi) => b[lang].replace(/\{v\}/g, version);
  const [data, setData] = useState<PatchOverview | null | 'failed'>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState<string | null>(null);
  // The page's one input is the match box. The advisor's own box opens when the reader asks for it, or once a
  // conversation is under way.
  const [open, setOpen] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const busy = turns.some((x) => x.pending);

  useEffect(() => {
    const ac = new AbortController();
    setData(null);
    fetchPatchOverview(lang, ac.signal).then(setData).catch((e) => { if ((e as Error).name !== 'AbortError') setData('failed'); });
    return () => ac.abort();
  }, [lang]);
  // Leaving the page (or switching language, which starts another conversation) cancels the answer being worked on.
  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => { abort.current?.abort(); setTurns([]); setNote(null); }, [lang]);
  useEffect(() => { if (open && turns.length === 0) input.current?.focus(); }, [open, turns.length]);

  const patch = (fn: (last: Turn) => Turn) => setTurns((prev) => prev.map((x, i) => (i === prev.length - 1 ? fn(x) : x)));

  async function send(text: string) {
    const question = text.trim();
    if (!question || busy) return;
    if (question.length > 500) { setNote(t(T.tooLong)); return; }
    setNote(null);
    const history: ChatTurn[] = turns.filter((x) => x.a && !x.error).slice(-6).map((x) => ({ q: x.q, a: x.a, clean: (x.unverified ?? []).length === 0 }));
    setTurns((prev) => [...prev, { q: question, a: '', steps: [], pending: true }]);
    setDraft('');
    const ac = new AbortController(); abort.current = ac;
    try {
      await askAdvisor({ lang, question, history }, {
        onStep: (step) => patch((x) => ({ ...x, steps: [...x.steps, step] })),
        onText: (a, unverified) => patch((x) => ({ ...x, a, unverified: unverified.map((u) => u.text) })),
        onError: () => patch((x) => ({ ...x, error: t(T.failed) })),
      }, ac.signal);
      patch((x) => ({ ...x, pending: false, error: x.a || x.error ? x.error : t(T.failed) }));
    } catch (e) {
      const aborted = (e as Error).name === 'AbortError';
      const code = e instanceof AgentApiError ? (e.status === 429 ? T.rate : e.code === 'unavailable' ? T.off : e.status === 503 ? T.busy : T.failed) : T.failed;
      patch((x) => ({ ...x, pending: false, error: aborted ? undefined : t(code) }));
      if (aborted) setTurns((prev) => prev.filter((x, i) => i !== prev.length - 1 || x.a));
    }
  }
  const ask = (q: string) => { if (busy) { input.current?.focus(); return; } void send(q); };
  const showForm = open || turns.length > 0;

  const ready = data && data !== 'failed' ? data : null;
  const w = ready?.numbers;
  return (
    <section className="pa" aria-labelledby="pa-title">
      <header className="pa-head">
        <h2 id="pa-title">{t(T.title)}</h2>
        <p>{t(T.sub)}</p>
      </header>
      <div className="pa-body">
        <div className="pa-data">
          {data === 'failed' && <p className="pa-muted" role="status">{t(T.noData)}</p>}
          {ready && (
            <>
              <div className="pa-grid">
                <Movers title={t(T.winUp)} rows={ready.win_rate_rose_most} by="win" tone="up" lang={lang} version={version} onAsk={ask} />
                <Movers title={t(T.winDown)} rows={ready.win_rate_fell_most} by="win" tone="down" lang={lang} version={version} onAsk={ask} />
                <Movers title={t(T.pickUp)} rows={ready.pick_rate_rose_most} by="pick" tone="up" lang={lang} version={version} onAsk={ask} />
                <Movers title={t(T.pickDown)} rows={ready.pick_rate_fell_most} by="pick" tone="down" lang={lang} version={version} onAsk={ask} />
              </div>
              {w && (
                <p className="pa-muted">
                  {t(T.windows).replace('{b0}', w.before_the_patch.from).replace('{b1}', w.before_the_patch.to).replace('{bd}', String(w.before_the_patch.days)).replace('{a0}', w.since_the_patch.from).replace('{a1}', w.since_the_patch.to).replace('{ad}', String(w.since_the_patch.days))}
                  {' '}<a href="https://stratz.com" target="_blank" rel="noreferrer">{t(T.credit)}</a> · <a href={notesUrl} target="_blank" rel="noreferrer">{t(T.notes)} ↗</a>
                </p>
              )}
            </>
          )}
        </div>
        <div className="pa-chat" role="group" aria-label={t(T.chat)}>
          {/* It scrolls once the conversation is long: reachable by keyboard, and announced as it grows. */}
          <div className="pa-log" role="log" aria-label={t(T.log)} tabIndex={0}>
            {turns.length === 0 && (
              <div className="pa-suggest">
                <p>{t(T.suggest)}</p>
                {SUGGEST.map((s) => <button key={s.en} type="button" onClick={() => ask(s[lang])}>{s[lang]}</button>)}
                {!showForm && <button type="button" className="pa-own" onClick={() => setOpen(true)}>{t(T.own)}</button>}
              </div>
            )}
            {turns.map((turn, i) => (
              <div key={i} className="pa-turn">
                <p className="pa-q"><span>{t(T.you)}</span>{turn.q}</p>
                <div className="pa-a">
                  <span>{t(T.advisor)}</span>
                  {turn.steps.length > 0 && <ol className="pa-steps">{turn.steps.map((s, j) => <li key={j} className={turn.pending && j === turn.steps.length - 1 ? 'is-live' : ''}>{advisorStepLabel(s, lang)}</li>)}</ol>}
                  {turn.pending && !turn.a && turn.steps.length === 0 && <p className="pa-muted">{t(T.thinking)}</p>}
                  {turn.a && <div className="pa-answer">{turn.a.split(/\n{2,}/).map((para, j) => <p key={j}>{para.replace(/^#+\s*/, '').replace(/\*\*/g, '')}</p>)}</div>}
                  {turn.unverified && turn.unverified.length > 0 && <p className="pa-warn">{t(T.unverified)} {turn.unverified.join(', ')}</p>}
                  {turn.error && <p className="pa-warn" role="alert">{turn.error}</p>}
                </div>
              </div>
            ))}
          </div>
          {showForm && <form className="pa-form" onSubmit={(e) => { e.preventDefault(); void send(draft); }}>
            <textarea ref={input} value={draft} rows={2} maxLength={600} placeholder={t(T.placeholder)} aria-label={t(T.chat)}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(draft); } }} />
            {note && <p className="pa-warn" role="alert">{note}</p>}
            {busy
              ? <button type="button" className="pa-btn" onClick={() => abort.current?.abort()}>{t(T.stop)}</button>
              : <button type="submit" className="pa-btn is-primary" disabled={!draft.trim()}>{t(T.send)}</button>}
          </form>}
        </div>
      </div>
    </section>
  );
};
