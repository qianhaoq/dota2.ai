import React, { useEffect, useRef, useMemo } from 'react';
import { Language } from '../../types';
import { Send, Loader2, X } from 'lucide-react';

interface CoachComposerProps {
  lang: Language;
  userInput: string;
  setUserInput: (v: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  isLoading: boolean;
  onCancel: () => void;
  mentorName?: string;
  /** When true, input stays enabled during loading (e.g. review follow-ups while streaming). */
  allowInputWhileLoading?: boolean;
  /** When true, lock input (e.g. AI unavailable for review follow-ups). */
  disableInput?: boolean;
  /** When true, send is disabled even if input has text (e.g. primary review still loading). */
  submitDisabled?: boolean;
  /** Increment to focus the input after programmatic fill (follow-up chips). */
  focusToken?: number;
}

const CoachComposer: React.FC<CoachComposerProps> = ({
  lang,
  userInput,
  setUserInput,
  onSubmit,
  isLoading,
  onCancel,
  mentorName,
  allowInputWhileLoading = false,
  disableInput = false,
  submitDisabled = false,
  focusToken = 0,
}) => {
  const inputRef = useRef<HTMLInputElement>(null);

  const t = useMemo(() => ({
    composer: lang === 'zh' ? '直接问拉比克…' : 'Ask Rubick…',
    keyboardHint: lang === 'zh' ? '聚焦输入' : 'to focus',
    send: lang === 'zh' ? '发送' : 'Send',
    stop: lang === 'zh' ? '停止' : 'Stop',
    reading: mentorName
      ? (lang === 'zh' ? `${mentorName}在看数据…` : `${mentorName} is reading the numbers…`)
      : (lang === 'zh' ? '拉比克在看数据…' : 'Rubick is reading the numbers…'),
  }), [lang, mentorName]);

  useEffect(() => {
    if (focusToken > 0) {
      inputRef.current?.focus();
    }
  }, [focusToken]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === '/' && document.activeElement !== inputRef.current) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const inputDisabled = disableInput || (isLoading && !allowInputWhileLoading);
  const canSend = userInput.trim().length > 0 && !submitDisabled && (!isLoading || allowInputWhileLoading);

  return (
    <div className="flex-shrink-0 border-t border-k3-border-subtle bg-k3-base pb-[max(1rem,env(safe-area-inset-bottom,0px))]">
      <div className="max-w-3xl mx-auto w-full px-3 sm:px-4 pt-2 sm:pt-3">
        {isLoading && (
          <div data-testid="composer-status" className="flex items-center justify-center gap-2 mb-2 min-h-[40px] min-w-0">
            <Loader2 size={14} className="text-k3-text-secondary animate-spin flex-shrink-0" />
            <span className="text-xs sm:text-sm text-k3-text-secondary truncate min-w-0">{t.reading}</span>
            <button
              onClick={onCancel}
              className="text-xs text-k3-text-tertiary hover:text-k3-text-secondary flex items-center gap-1 py-1.5 px-2 min-h-[40px] flex-shrink-0 touch-manipulation"
            >
              <X size={12} />
              {t.stop}
            </button>
          </div>
        )}
        <form onSubmit={onSubmit}>
          <div className="relative flex items-center bg-k3-input border border-k3-border-subtle rounded-composer focus-within:border-k3-text-tertiary/50 transition-all">
            <input
              ref={inputRef}
              type="text"
              value={userInput}
              onChange={(e) => setUserInput(e.target.value)}
              placeholder={t.composer}
              disabled={inputDisabled}
              className="flex-1 min-w-0 bg-transparent px-3 sm:px-4 py-3 pr-14 text-base sm:text-sm text-k3-text-primary focus:outline-none placeholder:text-k3-text-tertiary disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={!canSend}
              aria-label={t.send}
              className={`absolute right-2 w-10 h-10 flex items-center justify-center rounded-full transition-all touch-manipulation ${
                canSend
                  ? 'bg-k3-primary-bg hover:bg-white active:bg-white text-k3-primary-text cursor-pointer'
                  : 'bg-k3-elevated text-k3-text-tertiary cursor-not-allowed'
              }`}
            >
              <Send size={16} />
            </button>
          </div>
        </form>
        <div
          data-testid="composer-focus-hint"
          className="hidden sm:block text-center text-[10px] leading-4 text-k3-text-tertiary/60 tracking-wide mt-1.5 pb-0.5"
        >
          <kbd className="px-1.5 py-0.5 rounded bg-k3-surface border border-k3-border-subtle font-mono text-[9px]">/</kbd>
          <span className="ml-1.5">{t.keyboardHint}</span>
        </div>
      </div>
    </div>
  );
};

export default CoachComposer;
