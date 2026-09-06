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
}

const CoachComposer: React.FC<CoachComposerProps> = ({
  lang,
  userInput,
  setUserInput,
  onSubmit,
  isLoading,
  onCancel,
  mentorName,
}) => {
  const inputRef = useRef<HTMLInputElement>(null);

  const t = useMemo(() => ({
    composer: lang === 'zh' ? '直接问拉比克…' : 'Ask Rubick…',
    keyboardHint: lang === 'zh' ? '聚焦输入' : 'to focus',
    stop: lang === 'zh' ? '停止' : 'Stop',
    reading: mentorName
      ? (lang === 'zh' ? `${mentorName}在看数据…` : `${mentorName} is reading the numbers…`)
      : (lang === 'zh' ? '拉比克在看数据…' : 'Rubick is reading the numbers…'),
  }), [lang, mentorName]);

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

  const canSend = userInput.trim().length > 0 && !isLoading;

  return (
    <div className="flex-shrink-0 border-t border-k3-border-subtle bg-k3-base pb-safe">
      <div className="max-w-3xl mx-auto w-full px-3 sm:px-4 py-2 sm:py-3">
        {isLoading && (
          <div className="flex items-center justify-center gap-2 mb-2 min-h-[36px]">
            <Loader2 size={14} className="text-k3-text-secondary animate-spin" />
            <span className="text-xs sm:text-sm text-k3-text-secondary">{t.reading}</span>
            <button
              onClick={onCancel}
              className="text-xs text-k3-text-tertiary hover:text-k3-text-secondary flex items-center gap-1 py-1.5 px-2 min-h-[36px] touch-manipulation"
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
              disabled={isLoading}
              className="flex-1 min-w-0 bg-transparent px-3 sm:px-4 py-3 pr-12 sm:pr-14 text-sm text-k3-text-primary focus:outline-none placeholder:text-k3-text-tertiary disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={!canSend}
              className={`absolute right-2 w-9 h-9 flex items-center justify-center rounded-full transition-all touch-manipulation ${
                canSend
                  ? 'bg-k3-primary-bg hover:bg-white active:bg-white text-k3-primary-text cursor-pointer'
                  : 'bg-k3-elevated text-k3-text-tertiary cursor-not-allowed'
              }`}
            >
              <Send size={16} />
            </button>
          </div>
        </form>
        <div className="hidden sm:block text-center text-[10px] text-k3-text-tertiary/60 tracking-wide mt-1.5">
          <kbd className="px-1.5 py-0.5 rounded bg-k3-surface border border-k3-border-subtle font-mono text-[9px]">/</kbd>
          <span className="ml-1.5">{t.keyboardHint}</span>
        </div>
      </div>
    </div>
  );
};

export default CoachComposer;
