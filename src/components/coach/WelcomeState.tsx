import React, { useRef, useEffect, useMemo } from 'react';
import { Language, Hero } from '../../types';
import { Send, Loader2, X, BarChart3, Sparkles, TrendingUp, BookOpen, Users } from 'lucide-react';
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

  const t = useMemo(() => ({
    greetingEmpty: lang === 'zh' 
      ? '选英雄，开始深度教练分析' 
      : 'Pick heroes for deep coaching analysis',
    greetingWithHeroes: lang === 'zh'
      ? '阵容已就绪，开始分析'
      : 'Lineup ready — start analysis',
    inputPlaceholder: lang === 'zh' 
      ? '输入其他问题...' 
      : 'Ask another question...',
    keyboardHint: lang === 'zh' ? '聚焦输入' : 'to focus',
  }), [lang]);

  const suggestions = useMemo(() => {
    if (!hasHeroes) {
      return [
        {
          icon: Users,
          text: lang === 'zh' ? '选择双方英雄，开始深度分析' : 'Select heroes to start deep analysis',
          action: onOpenPicker,
          enabled: true,
          primary: true,
        },
        {
          icon: BarChart3,
          text: lang === 'zh' ? '当前版本哪些英雄强势？' : 'Which heroes are strong this patch?',
          action: onMeta,
          enabled: true,
          primary: false,
        },
      ];
    }
    
    const items: Array<{
      icon: typeof Sparkles;
      text: string;
      action: () => void;
      enabled: boolean;
      primary: boolean;
    }> = [
      {
        icon: Sparkles,
        text: lang === 'zh' ? '深度分析当前阵容' : 'Deep analyze current lineup',
        action: onAnalyze,
        enabled: true,
        primary: true,
      },
      {
        icon: BookOpen,
        text: lang === 'zh' ? '本局怎么打？' : 'How should we play?',
        action: onPlaybook,
        enabled: hasAllies,
        primary: false,
      },
    ];
    
    if (hasAllies && !alliesFull) {
      items.push({
        icon: TrendingUp,
        text: lang === 'zh' ? '推荐下一手选什么' : 'Recommend my next pick',
        action: onSuggest,
        enabled: true,
        primary: false,
      });
    }
    
    items.push({
      icon: BarChart3,
      text: lang === 'zh' ? '看看当前大盘' : 'Check current meta',
      action: onMeta,
      enabled: true,
      primary: false,
    });
    
    return items;
  }, [hasHeroes, hasAllies, alliesFull, lang, onOpenPicker, onMeta, onAnalyze, onPlaybook, onSuggest]);

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
  const greeting = hasHeroes ? t.greetingWithHeroes : t.greetingEmpty;

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

        {/* Greeting - context-aware */}
        <h1 className="text-lg text-k3-text-primary mb-5 text-center font-normal">
          {greeting}
        </h1>

        {/* Draft Context Chip - primary CTA when empty */}
        <div className="flex justify-center mb-6">
          <DraftContextChip
            lang={lang}
            draft={draft}
            selectionSide={selectionSide}
            onOpenPicker={onOpenPicker}
            onHeroDetail={onHeroDetail}
            variant={hasHeroes ? 'compact' : 'prominent'}
          />
        </div>

        {/* Suggestion Prompts - reordered based on state */}
        <div className="w-full space-y-1.5 mb-6">
          {suggestions.map(({ icon: Icon, text, action, enabled, primary }) => (
            <button
              key={text}
              onClick={action}
              disabled={!enabled || isLoading}
              className={`w-full flex items-center gap-3 px-4 py-2.5 rounded-lg text-left text-sm transition-all ${
                enabled && !isLoading
                  ? primary
                    ? 'text-k3-text-primary bg-k3-surface hover:bg-k3-elevated cursor-pointer group font-medium'
                    : 'text-k3-text-secondary hover:bg-k3-surface hover:text-k3-text-primary cursor-pointer group'
                  : 'text-k3-text-tertiary cursor-not-allowed opacity-60'
              }`}
            >
              <Icon size={14} className={`flex-shrink-0 transition-colors ${
                enabled && !isLoading 
                  ? primary 
                    ? 'text-k3-text-secondary' 
                    : 'text-k3-text-tertiary group-hover:text-k3-text-secondary' 
                  : ''
              }`} />
              <span>{text}</span>
            </button>
          ))}
        </div>

        {/* Secondary: Free-form input - demoted visually */}
        <form onSubmit={onSubmit} className="w-full mb-5">
          <div className="relative flex items-center bg-k3-input border border-k3-border-subtle rounded-composer focus-within:border-k3-text-tertiary/50 transition-all opacity-80 focus-within:opacity-100">
            <input
              ref={inputRef}
              type="text"
              value={userInput}
              onChange={(e) => setUserInput(e.target.value)}
              placeholder={t.inputPlaceholder}
              disabled={isLoading}
              className="flex-1 bg-transparent px-4 py-3 pr-14 text-sm text-k3-text-primary focus:outline-none placeholder:text-k3-text-tertiary disabled:opacity-50"
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
