/**
 * The reader's word on one finding: right, wrong, or not useful — and for the last two, why, from a short list.
 *
 * It is the only way we hear whether a review was right about a game nobody here watched. Nothing is typed and
 * nothing identifies the reader: the server keeps the rating beside the finding's own title and refs
 * (lib/agent/feedback.js). The browser remembers what was said, so the buttons show it on the next visit and a
 * change of mind replaces the earlier word instead of adding a second one.
 */
import React, { useState } from 'react';
import { sendFindingFeedback, type FindingRating, type FindingReason } from './api';
import { trackEvent } from '../services/analytics';

type Lang = 'en' | 'zh';
const T: Record<string, Record<Lang, string>> = {
  ask: { en: 'Was this right?', zh: '这条说得对吗？' },
  right: { en: 'Right', zh: '说得对' },
  wrong: { en: 'Wrong', zh: '不对' },
  useless: { en: 'Not useful', zh: '没用' },
  whyWrong: { en: 'What is wrong with it?', zh: '哪里不对？' },
  whyUseless: { en: 'Why not?', zh: '为什么没用？' },
  fact: { en: 'A fact is wrong', zh: '事实不对' },
  judgment: { en: 'Facts right, conclusion wrong', zh: '事实对，结论不对' },
  not_mine: { en: 'It was not mine to change', zh: '这不是我能改的' },
  knew: { en: 'I knew this already', zh: '我早就知道' },
  vague: { en: 'Too vague to act on', zh: '太笼统，不知道怎么做' },
  minor: { en: 'Not what decided the game', zh: '不是这局的关键' },
  saved: { en: 'Noted. Thank you.', zh: '记下了，谢谢。' },
  failed: { en: 'That could not be saved. Try again in a moment.', zh: '没能记下，稍后再试。' },
};
const RATINGS: FindingRating[] = ['right', 'wrong', 'useless'];
const REASONS: Record<Exclude<FindingRating, 'right'>, FindingReason[]> = { wrong: ['fact', 'judgment', 'not_mine'], useless: ['knew', 'vague', 'minor'] };

interface Said { id: string; title: string; rating: FindingRating; reason: FindingReason | null }
const STORE = 'dota2ai.agent.finding-feedback.v1';
/** What this browser remembers saying: the most recent of these many findings. */
const KEEP = 300;
const load = (): Record<string, Said> => { try { const v = JSON.parse(localStorage.getItem(STORE) ?? '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; } };
const save = (slot: string, said: Said) => {
  try {
    const all = load();
    delete all[slot];
    all[slot] = said;
    const keys = Object.keys(all);
    for (const k of keys.slice(0, Math.max(0, keys.length - KEEP))) delete all[k];
    localStorage.setItem(STORE, JSON.stringify(all));
  } catch { /* a private window: the word was still sent */ }
};
/** An id for this reader's word on this finding: random, made here, and used for nothing else. */
const newId = () => {
  const n = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(n); else for (let i = 0; i < n.length; i += 1) n[i] = Math.floor(Math.random() * 256);
  return Array.from(n, (b) => (b % 36).toString(36)).join('');
};

export const FindingFeedback: React.FC<{
  matchId: string; hero: string; lang: Lang;
  /**
   * Which review is on screen: the plan it was asked with, the id of the model that wrote it (the writer's own
   * id, never "the default": which model that is changes), and the prompt version it was written under. Together
   * with the game, hero and language they name the stored review — and this browser's memory of what was said.
   */
  plan?: string | null; model?: string | null; version: number;
  /** Which finding, from 0, and its title: the server takes the word only if that finding still stands in that place. */
  index: number; title: string;
}> = ({ matchId, hero, lang, plan = null, model = null, version, index, title }) => {
  const t = (k: string) => T[k][lang];
  const slot = `${matchId}.${hero}.${lang}.${plan ?? ''}.${model ?? ''}.p${version}.${index}`;
  const [said, setSaid] = useState<Said | null>(() => { const s = load()[slot]; return s && s.title === title && RATINGS.includes(s.rating) ? s : null; });
  const [note, setNote] = useState<'saved' | 'failed' | null>(null);
  const [busy, setBusy] = useState(false);

  const say = async (rating: FindingRating, reason: FindingReason | null) => {
    if (busy || (said && said.rating === rating && said.reason === reason)) return;
    const before = said;
    const next: Said = { id: before?.id ?? newId(), title, rating, reason };
    setSaid(next); setBusy(true); setNote(null);
    const ok = await sendFindingFeedback(matchId, { hero, lang, version, finding: index, title, rating, reason, id: next.id, ...(plan ? { plan } : {}), ...(model ? { model } : {}) });
    setBusy(false);
    // Not saved: the buttons go back to what the server has, and say so.
    if (!ok) { setSaid(before); setNote('failed'); return; }
    save(slot, next); setNote('saved');
    if (before?.rating !== rating) trackEvent('finding_rated', { matchId, lang, hero, rating, first: index === 0 });
  };

  const why = said && said.rating !== 'right' ? said.rating : null;
  return (
    <div className="ag-fb">
      <div className="ag-fb-row" role="group" aria-label={t('ask')}>
        <span className="ag-fb-ask">{t('ask')}</span>
        {RATINGS.map((r) => (
          <button key={r} type="button" className={`ag-chip-btn ${said?.rating === r ? 'is-on' : ''}`} aria-pressed={said?.rating === r} disabled={busy} onClick={() => say(r, null)}>{t(r)}</button>
        ))}
      </div>
      {why && (
        <div className="ag-fb-row is-why" role="group" aria-label={t(why === 'wrong' ? 'whyWrong' : 'whyUseless')}>
          <span className="ag-fb-ask">{t(why === 'wrong' ? 'whyWrong' : 'whyUseless')}</span>
          {REASONS[why].map((r) => (
            <button key={r} type="button" className={`ag-chip-btn ${said?.reason === r ? 'is-on' : ''}`} aria-pressed={said?.reason === r} disabled={busy} onClick={() => say(why, r)}>{t(r)}</button>
          ))}
        </div>
      )}
      <p className={`ag-fb-note ${note === 'failed' ? 'is-failed' : ''}`} role="status">{note ? t(note) : ''}</p>
    </div>
  );
};
