import React, { useState } from 'react';
import { Check, Link2, Loader2 } from 'lucide-react';
import type { Language } from '../../types';
import { buildFakedoorSubmission } from '../../utils/fakedoor';
import { trackEvent } from '../../services/analytics';

type FakedoorState = 'closed' | 'open' | 'sending' | 'thanks' | 'error';

/**
 * Fake-door CTA: "Link Steam for auto-review every match". Clicking records
 * interest (fakedoor_clicked) and opens an inline panel — no real login, no
 * mailto — with an optional email contact posted to /api/feedback.
 */
const FakedoorSteamCTA: React.FC<{ lang: Language }> = ({ lang }) => {
  const [state, setState] = useState<FakedoorState>('closed');
  const [contact, setContact] = useState('');

  const t = {
    cta: lang === 'zh'
      ? '绑定 Steam，每局自动复盘（$3/月）'
      : 'Link Steam for auto-review every match ($3/month)',
    title: lang === 'zh' ? '即将上线' : 'Coming soon',
    body: lang === 'zh'
      ? '我们正在做「每局打完自动复盘」。留下邮箱，上线时第一时间通知你。'
      : "We're building automatic post-match review for every game you play. Leave your email and we'll notify you at launch.",
    contactPlaceholder: lang === 'zh' ? '邮箱（可选）' : 'Email (optional)',
    submit: lang === 'zh' ? '提醒我' : 'Notify me',
    sending: lang === 'zh' ? '提交中…' : 'Sending…',
    thanks: lang === 'zh' ? '感谢！上线后我们会联系你。' : "Thanks! We'll reach out when it launches.",
    error: lang === 'zh' ? '提交失败，请重试。' : "Couldn't save — please try again.",
  };

  const handleOpen = () => {
    if (state !== 'closed') return;
    setState('open');
    trackEvent('fakedoor_clicked', { kind: 'steam_autoreview' });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (state === 'sending' || state === 'thanks') return;
    setState('sending');
    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildFakedoorSubmission(contact, lang)),
      });
      if (!res.ok) throw new Error(`feedback failed: ${res.status}`);
      setState('thanks');
    } catch {
      setState('error');
    }
  };

  if (state === 'closed') {
    return (
      <button
        type="button"
        data-testid="fakedoor-steam-cta"
        onClick={handleOpen}
        className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl border border-dashed border-k3-border-subtle bg-k3-elevated/20 text-xs font-medium text-k3-text-secondary hover:text-k3-text-primary hover:border-k3-radiant/40 hover:bg-k3-radiant/5 transition-colors min-h-[44px] touch-manipulation"
      >
        <Link2 size={14} className="flex-shrink-0" />
        {t.cta}
      </button>
    );
  }

  return (
    <div
      data-testid="fakedoor-steam-panel"
      className="rounded-xl border border-k3-border-subtle bg-k3-elevated/25 p-3 space-y-2"
    >
      <p className="text-xs font-semibold text-k3-text-primary">{t.title}</p>
      <p className="text-xs text-k3-text-secondary leading-relaxed">{t.body}</p>
      {state === 'thanks' ? (
        <p className="flex items-center gap-1.5 text-xs text-k3-radiant" data-testid="fakedoor-steam-thanks">
          <Check size={12} className="flex-shrink-0" />
          {t.thanks}
        </p>
      ) : (
        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-2">
          <input
            type="email"
            value={contact}
            onChange={(e) => setContact(e.target.value)}
            placeholder={t.contactPlaceholder}
            autoComplete="email"
            className="w-full px-3 py-2 rounded-lg bg-k3-elevated border border-k3-border-subtle text-sm text-k3-text-primary placeholder:text-k3-text-tertiary min-h-[40px]"
          />
          {state === 'error' && (
            <p className="text-xs text-yellow-400">{t.error}</p>
          )}
          <button
            type="submit"
            disabled={state === 'sending'}
            className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-k3-text-primary text-k3-base text-xs font-medium disabled:opacity-40 min-h-[40px] touch-manipulation"
          >
            {state === 'sending' && <Loader2 size={12} className="animate-spin" />}
            {state === 'sending' ? t.sending : t.submit}
          </button>
        </form>
      )}
    </div>
  );
};

export default FakedoorSteamCTA;
