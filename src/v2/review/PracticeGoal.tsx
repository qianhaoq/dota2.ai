import React, { useId, useState, useSyncExternalStore } from 'react';
import { journalStore, type JournalStore } from '../../features/journal/journalStore';
import { useI18n } from '../i18n/I18nProvider';
import type { Review, Insight } from './types';
import { practiceGoalText } from './practiceGoalText';

export default function PracticeGoal({review, insight, store = journalStore}: {review: Review; insight: Insight; store?: JournalStore}) {
  const {t} = useI18n();
  const formId = useId();
  const notes = useSyncExternalStore(store.subscribe,store.getNotes,store.getNotes);
  const [editing,setEditing] = useState(false);
  const [error,setError] = useState<'invalid'|'full'|null>(null);
  const [trigger,setTrigger] = useState(t('practiceTriggerDefault'));
  const [action,setAction] = useState(practiceGoalText(insight).slice(0,500));
  const [check,setCheck] = useState(t('practiceCheckDefault'));
  const key = `review:${review.match.id}:${review.player?.hero_id}:next_game`;
  const saved = notes.find(note=>note.key === key);
  if (!review.player || review.state !== 'parsed' || insight.status !== 'ok') return null;
  if (saved) return <section className="p-[12px] border border-d2-line-2 rounded-[12px] text-d2-13" data-testid="practice-goal-saved">
    <p role="status" className="text-d2-gold-2 font-semibold">{store.isPersistent()?t('practiceSaved'):t('practiceMemory')}</p>
    <dl className="text-d2-ink-2"><dt className="font-semibold">{t('practiceTrigger')}</dt><dd className="m-0 mb-[6px]">{saved.trigger}</dd><dt className="font-semibold">{t('practiceAction')}</dt><dd className="m-0 mb-[6px]">{saved.action}</dd><dt className="font-semibold">{t('practiceCheck')}</dt><dd className="m-0">{saved.check}</dd></dl>
    <label className="inline-flex gap-[8px] items-center mt-[10px]"><input type="checkbox" checked={saved.done} onChange={()=>store.toggleDone(key)}/>{t('practiceSelfCheck')}</label>
  </section>;
  const button = 'rounded-d2-control px-[12px] py-[8px] border border-d2-line text-d2-13 text-d2-ink-2 hover:border-d2-gold';
  if (!editing) return <button className={button} onClick={()=>setEditing(true)}>{t('practiceSave')}</button>;
  return <form data-testid="practice-goal-form" onSubmit={event=>{
    event.preventDefault();
    if (!trigger.trim() || !action.trim() || !check.trim()) {setError('invalid');return;}
    const result = store.addNote({key,title:t('practiceTitle'),trigger:trigger.trim(),action:action.trim(),check:check.trim(),contextId:`match:${review.match.id}:${review.player!.hero_id}`,authority:'hypothesis'});
    if (result === 'invalid' || result === 'full') setError(result); else setEditing(false);
  }}>
    {([['trigger',t('practiceTrigger'),trigger,setTrigger],['action',t('practiceAction'),action,setAction],['check',t('practiceCheck'),check,setCheck]] as const).map(([name,label,value,set])=><div key={name} className="text-d2-13 text-d2-ink-2 mb-[10px]"><label htmlFor={`${formId}-${name}`}>{label}</label><textarea id={`${formId}-${name}`} required maxLength={500} value={value} onChange={event=>set(event.target.value)} className="block w-full mt-[4px] p-[8px] rounded-d2-control border border-d2-line bg-d2-surface-2 text-d2-ink" rows={3}/></div>)}
    {error && <p role="alert" className="text-d2-13 text-d2-down">{t(error==='full'?'practiceFull':'practiceInvalid')}</p>}
    <div className="flex gap-[8px]"><button className={button} type="submit">{t('practiceConfirm')}</button><button className={button} type="button" onClick={()=>setEditing(false)}>{t('practiceCancel')}</button></div>
  </form>;
}
