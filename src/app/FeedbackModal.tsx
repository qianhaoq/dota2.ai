import React, { useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { Language } from '../types';

export interface FeedbackModalProps {
  lang: Language;
  isOpen: boolean;
  onClose: () => void;
}

type SubmitState = 'idle' | 'sending' | 'success' | 'error';

const FeedbackModal: React.FC<FeedbackModalProps> = ({ lang, isOpen, onClose }) => {
  const [name, setName] = useState('');
  const [contact, setContact] = useState('');
  const [message, setMessage] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [submitState, setSubmitState] = useState<SubmitState>('idle');
  const closeRef = useRef<HTMLButtonElement>(null);
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  const t = useMemo(
    () =>
      lang === 'zh'
        ? {
            title: '站内留言',
            hint: '留下你的想法或建议。',
            name: '称呼（选填）',
            contact: '联系方式（选填）',
            message: '留言',
            submit: '提交',
            close: '关闭',
            empty: '请填写留言内容。',
            network: '发送失败，请重试。',
            success: '感谢，我们已收到你的留言。',
            sending: '提交中…',
          }
        : {
            title: 'Leave a message',
            hint: 'Tell us what works or what to improve.',
            name: 'Name (optional)',
            contact: 'Contact (email or other, optional)',
            message: 'Message',
            submit: 'Submit',
            close: 'Close',
            empty: 'Please enter a message.',
            network: 'Could not send. Try again.',
            success: 'Thanks — we received your message.',
            sending: 'Sending…',
          },
    [lang],
  );

  useEffect(() => {
    if (!isOpen) return undefined;

    setName('');
    setContact('');
    setMessage('');
    setFieldError(null);
    setSubmitState('idle');

    restoreRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const focusTarget =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(pointer: coarse)').matches
        ? closeRef.current
        : messageRef.current;
    // Defer so the dialog is in the DOM.
    const id = window.setTimeout(() => focusTarget?.focus(), 0);

    return () => {
      window.clearTimeout(id);
      restoreRef.current?.focus?.();
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && submitState !== 'sending') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose, submitState]);

  if (!isOpen) return null;

  const sending = submitState === 'sending';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = message.trim();
    if (!trimmed) {
      setFieldError(t.empty);
      setSubmitState('idle');
      messageRef.current?.focus();
      return;
    }
    setFieldError(null);
    setSubmitState('sending');
    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim() || undefined,
          contact: contact.trim() || undefined,
          message: trimmed,
          lang,
        }),
      });
      if (!res.ok) {
        setSubmitState('error');
        return;
      }
      const data = (await res.json().catch(() => null)) as { ok?: boolean } | null;
      if (!data?.ok) {
        setSubmitState('error');
        return;
      }
      setSubmitState('success');
    } catch {
      setSubmitState('error');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-0 sm:p-4">
      <div
        className="absolute inset-0 bg-black/80 backdrop-blur-sm"
        onClick={() => {
          if (!sending) onClose();
        }}
        aria-hidden="true"
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="feedback-modal-title"
        className="relative w-full h-full sm:h-auto sm:max-h-[85vh] sm:max-w-md bg-v3-base border-0 sm:border sm:border-v3-line sm:rounded-[5px] flex flex-col overflow-hidden pt-safe pb-safe px-safe"
      >
        <div className="flex items-start justify-between gap-[12px] px-[16px] py-[14px] border-b border-v3-line">
          <div className="min-w-0">
            <h2
              id="feedback-modal-title"
              className="v3-display text-[16px] text-v3-text tracking-[0.02em]"
            >
              {t.title}
            </h2>
            <p className="mt-[4px] text-[12px] leading-[18px] text-v3-muted">{t.hint}</p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            disabled={sending}
            aria-label={t.close}
            className="v3-btn v3-btn-quiet !min-h-[40px] !px-[10px] flex-shrink-0"
          >
            <X size={16} />
          </button>
        </div>

        {submitState === 'success' ? (
          <div className="px-[16px] py-[24px] flex flex-col gap-[16px]">
            <p className="text-[14px] leading-[22px] text-v3-text" role="status">
              {t.success}
            </p>
            <button type="button" onClick={onClose} className="v3-btn v3-btn-primary self-start">
              {t.close}
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="flex flex-col gap-[14px] px-[16px] py-[16px] overflow-y-auto">
            <label className="flex flex-col gap-[6px]">
              <span className="text-[11px] text-v3-quiet tracking-[0.04em]">{t.name}</span>
              <input
                type="text"
                name="feedback-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={200}
                disabled={sending}
                autoComplete="name"
                className="min-h-[44px] px-[12px] rounded-[4px] bg-v3-panel border border-v3-line text-v3-text text-[14px] outline-none focus:border-v3-gold"
              />
            </label>

            <label className="flex flex-col gap-[6px]">
              <span className="text-[11px] text-v3-quiet tracking-[0.04em]">{t.contact}</span>
              <input
                type="text"
                name="feedback-contact"
                value={contact}
                onChange={(e) => setContact(e.target.value)}
                maxLength={200}
                disabled={sending}
                autoComplete="email"
                className="min-h-[44px] px-[12px] rounded-[4px] bg-v3-panel border border-v3-line text-v3-text text-[14px] outline-none focus:border-v3-gold"
              />
            </label>

            <label className="flex flex-col gap-[6px]">
              <span className="text-[11px] text-v3-quiet tracking-[0.04em]">{t.message}</span>
              <textarea
                ref={messageRef}
                name="feedback-message"
                value={message}
                onChange={(e) => {
                  setMessage(e.target.value);
                  if (fieldError) setFieldError(null);
                }}
                rows={5}
                maxLength={4000}
                disabled={sending}
                required
                aria-invalid={fieldError ? true : undefined}
                aria-describedby={fieldError ? 'feedback-message-error' : undefined}
                className="min-h-[120px] px-[12px] py-[10px] rounded-[4px] bg-v3-panel border border-v3-line text-v3-text text-[14px] outline-none focus:border-v3-gold resize-y"
              />
            </label>

            {fieldError && (
              <p id="feedback-message-error" className="text-[12px] text-v3-risk" role="alert">
                {fieldError}
              </p>
            )}
            {submitState === 'error' && (
              <p className="text-[12px] text-v3-risk" role="alert">
                {t.network}
              </p>
            )}

            <div className="flex items-center justify-end gap-[8px] pt-[4px]">
              <button
                type="button"
                onClick={onClose}
                disabled={sending}
                className="v3-btn v3-btn-quiet"
              >
                {t.close}
              </button>
              <button type="submit" disabled={sending} className="v3-btn v3-btn-primary">
                {sending ? t.sending : t.submit}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};

export default FeedbackModal;
