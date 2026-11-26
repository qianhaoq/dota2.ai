import React, { useEffect, useRef, useState } from 'react';
import type { Bi } from './types';
import { useLang } from './ui';
import { internalHeaders } from '../services/analytics';

export const GITHUB_ISSUES_URL = 'https://github.com/qianhaoq/dota2.ai/issues';
export const AUTHOR_X_URL = 'https://x.com/kilocean';
export const AUTHOR_EMAIL = 'qianhao1229@gmail.com';

type Category = 'suggestion' | 'bug' | 'other';
const CATEGORIES: readonly Category[] = ['suggestion', 'bug', 'other'];

const T = {
  title: {
    en: 'Feedback & suggestions',
    zh: '反馈与建议',
    ru: 'Обратная связь и предложения',
  },
  sub: {
    en: 'Missing a feature, found a wrong read, or want to suggest an improvement? Open an issue on GitHub, reach out directly, or leave a note below.',
    zh: '有功能建议、发现复盘不准，或有任何想法？欢迎去 GitHub Issues 提建议、直接联系我，或在下方留言。',
    ru: 'Не хватает функции, заметили ошибку в разборе или есть идея? Создайте Issue на GitHub, напишите напрямую или оставьте сообщение ниже.',
  },
  github: { en: 'GitHub Issues', zh: '去 GitHub Issues 提建议', ru: 'GitHub Issues' },
  x: { en: 'X (@kilocean)', zh: 'X (@kilocean)', ru: 'X (@kilocean)' },
  email: { en: AUTHOR_EMAIL, zh: AUTHOR_EMAIL, ru: AUTHOR_EMAIL },
  openForm: { en: 'Leave a message', zh: '直接留言', ru: 'Оставить сообщение' },
  closeForm: { en: 'Hide form', zh: '收起留言框', ru: 'Скрыть форму' },
  categoryLabel: { en: 'Topic', zh: '类型', ru: 'Тема' },
  cat: {
    suggestion: { en: 'Suggestion', zh: '功能建议', ru: 'Предложение' },
    bug: { en: 'Bug / wrong read', zh: '问题 / 复盘有误', ru: 'Баг / ошибка' },
    other: { en: 'Other', zh: '其他', ru: 'Другое' },
  } as Record<Category, Bi>,
  messageLabel: { en: 'Your message', zh: '留言内容', ru: 'Ваше сообщение' },
  messagePh: {
    en: 'Share an idea, match ID, or bug you ran into…',
    zh: '写下你的建议、遇到的问题，或想改进的地方…',
    ru: 'Опишите идею, ID матча или проблему…',
  },
  contactLabel: { en: 'Contact (optional)', zh: '联系方式（选填）', ru: 'Контакт (необязательно)' },
  contactPh: {
    en: 'Email, X handle, or Discord (optional)',
    zh: '邮箱、X 账号或微信/Discord（选填）',
    ru: 'Email, X или Discord (необязательно)',
  },
  send: { en: 'Send feedback', zh: '提交留言', ru: 'Отправить' },
  sending: { en: 'Sending…', zh: '提交中…', ru: 'Отправка…' },
  sent: { en: 'Thanks — your message has been received.', zh: '收到，感谢你的反馈！', ru: 'Спасибо — ваше сообщение получено.' },
  sendAnother: { en: 'Send another', zh: '再留一条', ru: 'Написать ещё' },
  empty: { en: 'Please write a message first.', zh: '请先输入留言内容。', ru: 'Пожалуйста, введите сообщение.' },
  tooLong: { en: 'Please keep your message under 1000 characters.', zh: '留言请控制在 1000 字以内。', ru: 'Сократите сообщение до 1000 символов.' },
  rateLimited: { en: 'Too many messages sent — please try again in a few minutes.', zh: '提交太频繁了，请几分钟后再试。', ru: 'Слишком много сообщений — попробуйте через пару минут.' },
  failed: { en: 'Could not send right now. You can also reach out via GitHub Issues or email.', zh: '暂时提交失败，也可以直接通过 GitHub Issues 或邮件联系。', ru: 'Не удалось отправить. Вы также можете написать в GitHub Issues или на почту.' },
} as const;

export const HomeFeedback: React.FC = () => {
  const { lang, L } = useLang();
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<Category>('suggestion');
  const [message, setMessage] = useState('');
  const [contact, setContact] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const msgRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open && status !== 'sent') msgRef.current?.focus();
  }, [open, status]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = message.trim();
    if (!trimmed) { setErrMsg(L(T.empty)); return; }
    if (trimmed.length > 1000) { setErrMsg(L(T.tooLong)); return; }
    setStatus('sending');
    setErrMsg(null);
    try {
      const res = await fetch('/api/site-feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...internalHeaders() },
        body: JSON.stringify({
          category,
          message: trimmed,
          ...(contact.trim() ? { contact: contact.trim() } : {}),
          lang,
        }),
      });
      if (res.ok) {
        setStatus('sent');
        setMessage('');
        setContact('');
        return;
      }
      setStatus('error');
      setErrMsg(res.status === 429 ? L(T.rateLimited) : L(T.failed));
    } catch {
      setStatus('error');
      setErrMsg(L(T.failed));
    }
  };

  return (
    <section className="hm-feedback" aria-labelledby="hm-feedback-title">
      <div className="hm-feedback-head">
        <div>
          <h2 id="hm-feedback-title">{L(T.title)}</h2>
          <p className="hm-feedback-sub">{L(T.sub)}</p>
        </div>
        <div className="hm-feedback-links">
          <a href={GITHUB_ISSUES_URL} target="_blank" rel="noopener noreferrer" className="hm-feedback-link is-primary">
            {L(T.github)} ↗
          </a>
          <a href={AUTHOR_X_URL} target="_blank" rel="noopener noreferrer" className="hm-feedback-link">
            {L(T.x)} ↗
          </a>
          <a href={`mailto:${AUTHOR_EMAIL}`} className="hm-feedback-link">
            {L(T.email)}
          </a>
          <button
            type="button"
            className={`hm-feedback-toggle ${open ? 'is-on' : ''}`}
            aria-expanded={open}
            onClick={() => { setOpen((v) => !v); setErrMsg(null); }}
          >
            {open ? L(T.closeForm) : L(T.openForm)}
          </button>
        </div>
      </div>

      {open && (
        status === 'sent' ? (
          <div className="hm-feedback-done" role="status">
            <p>{L(T.sent)}</p>
            <button type="button" className="cx-linkbtn" onClick={() => setStatus('idle')}>{L(T.sendAnother)}</button>
          </div>
        ) : (
          <form className="hm-feedback-form" onSubmit={submit}>
            <div className="hm-feedback-cats" role="radiogroup" aria-label={L(T.categoryLabel)}>
              {CATEGORIES.map((c) => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={category === c}
                  className={`cx-filter-pill ${category === c ? 'is-on' : ''}`}
                  onClick={() => setCategory(c)}
                >
                  {L(T.cat[c])}
                </button>
              ))}
            </div>
            <label className="hm-feedback-field">
              <span>{L(T.messageLabel)}</span>
              <textarea
                ref={msgRef}
                value={message}
                rows={3}
                maxLength={1000}
                placeholder={L(T.messagePh)}
                aria-label={L(T.messageLabel)}
                onChange={(e) => { setMessage(e.target.value); setErrMsg(null); }}
              />
            </label>
            <div className="hm-feedback-foot">
              <input
                type="text"
                value={contact}
                maxLength={120}
                placeholder={L(T.contactPh)}
                aria-label={L(T.contactLabel)}
                onChange={(e) => setContact(e.target.value)}
              />
              <button type="submit" className="cx-primary" disabled={status === 'sending'}>
                {status === 'sending' ? L(T.sending) : L(T.send)}
              </button>
            </div>
            {errMsg && <p className="cx-err" role="alert">{errMsg}</p>}
          </form>
        )
      )}
    </section>
  );
};
