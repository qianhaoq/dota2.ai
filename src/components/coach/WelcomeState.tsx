import React, { useRef, useEffect } from 'react';
import { Language, Hero } from '../../types';
import { Send, Loader2, X, BarChart3, Sparkles, TrendingUp } from 'lucide-react';
import DraftContextChip from './DraftContextChip';

interface WelcomeStateProps {
  lang: Language;
  hasHeroes: boolean;
  draft: { radiant: Hero[]; dire: Hero[] };
  selectionSide: 'radiant' | 'dire';
  onOpenPicker: () => void;
  onHeroDetail?: (heroId: number) => void;
  isLoading: boolean;
  hasAllies: boolean;
  alliesFull: boolean;
  onAnalyze: () => void;
  onPlaybook: () => void;
  onSuggest: () => void;
  onMeta: () => void;
  onCancel: () => void;
  userInput: string;
  setUserInput: (v: string) => void;
  onSubmit: (e: React.FormEvent) => void;
}

const WelcomeState: React.FC<WelcomeStateProps> = ({
  lang,
  hasHeroes,
  draft,
  selectionSide,
  onOpenPicker,
  onHeroDetail,
  isLoading,
  hasAllies,
  alliesFull,
  onAnalyze,
  onPlaybook,
  onSuggest,
  onMeta,
  onCancel,
  userInput,
  setUserInput,
  onSubmit,
}) => {
  const inputRef = useRef<HTMLInputElement>(null);

  const t = {
    greeting: lang === 'zh' 
      ? '有什么 Dota 问题可以帮你？' 
      : 'What Dota question can I help with?',
    inputPlaceholder: lang === 'zh' 
      ? '输入问题，或点击下方建议...' 
      : 'Ask a question, or use suggestions below...',
    keyboardHint: lang === 'zh' ? '聚焦输入' : 'to focus',
    suggestions: [
      {
        icon: BarChart3,
        text: lang === 'zh' ? '当前版本哪些英雄强势？' : 'Which heroes are strong this patch?',
        action: onMeta,
        enabled: true,
      },
      {
        icon: Sparkles,
        text: lang === 'zh' ? '分析我的阵容对位' : 'Analyze my draft matchups',
        action: onAnalyze,
        enabled: hasHeroes,
      },
      {
        icon: TrendingUp,
        text: lang === 'zh' ? '推荐下一手选什么' : 'Recommend my next pick',
        action: onSuggest,
        enabled: hasAllies && !alliesFull,
      },
    ],
  };

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
    <div className="flex flex-col items-center justify-center h-full px-6 py-8 max-w-3xl mx-auto">
      <div className="flex flex-col items-center w-full max-w-xl">
        {/* AI Avatar/Mark */}
        <div className="w-12 h-12 rounded-xl bg-k3-surface border border-k3-border-subtle flex items-center justify-center mb-5">
          <svg 
            viewBox="0 0 24 24" 
            fill="none" 
            className="w-6 h-6 text-k3-text-secondary"
            stroke="currentColor" 
            strokeWidth="1.5"
          >
            <path 
              strokeLinecap="round" 
              strokeLinejoin="round" 
              d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456z" 
            />
          </svg>
        </div>

        {/* Greeting */}
        <h1 className="text-lg text-k3-text-primary mb-5 text-center font-normal">
          {t.greeting}
        </h1>

        {/* Draft Context Chip */}
        <div className="flex justify-center mb-6">
          <DraftContextChip
            lang={lang}
            draft={draft}
            selectionSide={selectionSide}
            onOpenPicker={onOpenPicker}
            onHeroDetail={onHeroDetail}
          />
        </div>

        {/* Unified Composer Container */}
        <form onSubmit={onSubmit} className="w-full mb-5">
          <div className="relative flex items-center bg-k3-input border border-k3-border-subtle rounded-composer focus-within:border-k3-text-tertiary/50 transition-all">
            <input
              ref={inputRef}
              type="text"
              value={userInput}
              onChange={(e) => setUserInput(e.target.value)}
              placeholder={t.inputPlaceholder}
              disabled={isLoading}
              className="flex-1 bg-transparent px-4 py-3.5 pr-14 text-sm text-k3-text-primary focus:outline-none placeholder:text-k3-text-tertiary disabled:opacity-50"
              autoFocus
            />
            <button
              type="submit"
              disabled={!canSend}
              className={`absolute right-2 w-9 h-9 flex items-center justify-center rounded-full transition-all ${
                canSend
                  ? 'bg-k3-primary-bg hover:bg-white text-k3-primary-text cursor-pointer'
                  : 'bg-k3-elevated text-k3-text-tertiary cursor-not-allowed'
              }`}
            >
              <Send size={16} />
            </button>
          </div>
        </form>

        {/* Suggestion Prompts with hover affordance */}
        <div className="w-full space-y-1.5 mb-6">
          {t.suggestions.map(({ icon: Icon, text, action, enabled }) => (
            <button
              key={text}
              onClick={action}
              disabled={!enabled || isLoading}
              className={`w-full flex items-center gap-3 px-4 py-2.5 rounded-lg text-left text-sm transition-all ${
                enabled && !isLoading
                  ? 'text-k3-text-secondary hover:bg-k3-surface hover:text-k3-text-primary cursor-pointer group'
                  : 'text-k3-text-tertiary cursor-not-allowed opacity-60'
              }`}
            >
              <Icon size={14} className={`flex-shrink-0 transition-colors ${
                enabled && !isLoading ? 'text-k3-text-tertiary group-hover:text-k3-text-secondary' : ''
              }`} />
              <span>{text}</span>
            </button>
          ))}
        </div>

        {/* Loading/Cancel */}
        {isLoading && (
          <div className="flex items-center justify-center gap-3">
            <Loader2 size={16} className="text-k3-text-secondary animate-spin" />
            <button
              onClick={onCancel}
              className="text-sm text-k3-text-tertiary hover:text-k3-text-secondary flex items-center gap-1"
            >
              <X size={14} />
              {lang === 'zh' ? '停止' : 'Stop'}
            </button>
          </div>
        )}
      </div>

      {/* Spacer to push footer down */}
      <div className="flex-1" />

      {/* Bottom Footer Hint */}
      <div className="text-[10px] text-k3-text-tertiary/60 tracking-wide">
        <kbd className="px-1.5 py-0.5 rounded bg-k3-surface border border-k3-border-subtle font-mono text-[9px]">/</kbd>
        <span className="ml-1.5">{t.keyboardHint}</span>
      </div>
    </div>
  );
};

export default WelcomeState;
