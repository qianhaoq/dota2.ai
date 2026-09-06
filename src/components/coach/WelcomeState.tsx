import React from 'react';
import { Language, Hero } from '../../types';
import { Send, Loader2, X } from 'lucide-react';
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
  const t = {
    greeting: lang === 'zh' 
      ? '有什么 Dota 问题可以帮你？' 
      : 'What Dota question can I help with?',
    inputPlaceholder: lang === 'zh' 
      ? '输入问题，或点击下方建议...' 
      : 'Ask a question, or use suggestions below...',
    suggestions: [
      {
        text: lang === 'zh' ? '当前版本哪些英雄强势？' : 'Which heroes are strong this patch?',
        action: onMeta,
        enabled: true,
      },
      {
        text: lang === 'zh' ? '分析我的阵容对位' : 'Analyze my draft matchups',
        action: onAnalyze,
        enabled: hasHeroes,
      },
      {
        text: lang === 'zh' ? '推荐下一手选什么' : 'Recommend my next pick',
        action: onSuggest,
        enabled: hasAllies && !alliesFull,
      },
    ],
  };

  return (
    <div className="flex flex-col items-center justify-center h-full px-6 py-8 max-w-3xl mx-auto">
      {/* Simple greeting */}
      <h1 className="text-lg text-k3-text-primary mb-8 text-center font-normal">
        {t.greeting}
      </h1>

      {/* Composer area - vertically centered */}
      <div className="w-full max-w-xl space-y-4">
        {/* Draft Context Chip */}
        <div className="flex justify-center">
          <DraftContextChip
            lang={lang}
            draft={draft}
            selectionSide={selectionSide}
            onOpenPicker={onOpenPicker}
            onHeroDetail={onHeroDetail}
          />
        </div>

        {/* Input Field */}
        <form onSubmit={onSubmit} className="flex gap-3">
          <input
            type="text"
            value={userInput}
            onChange={(e) => setUserInput(e.target.value)}
            placeholder={t.inputPlaceholder}
            disabled={isLoading}
            className="flex-1 bg-k3-input border border-k3-border-subtle rounded-lg px-4 py-3 text-sm text-k3-text-primary focus:outline-none focus:border-k3-text-tertiary transition-all placeholder:text-k3-text-tertiary disabled:opacity-50"
            autoFocus
          />
          <button
            type="submit"
            disabled={isLoading || !userInput.trim()}
            className="px-4 py-3 flex items-center justify-center bg-k3-primary-bg hover:bg-[#E8E8E8] text-k3-primary-text rounded-lg transition-all disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Send size={16} />
          </button>
        </form>

        {/* Plain text suggestions */}
        <div className="flex flex-col items-center gap-2 pt-4">
          {t.suggestions.map((suggestion, idx) => (
            <button
              key={idx}
              onClick={suggestion.action}
              disabled={!suggestion.enabled || isLoading}
              className={`text-sm transition-colors ${
                suggestion.enabled && !isLoading
                  ? 'text-k3-text-secondary hover:text-k3-text-primary hover:underline cursor-pointer'
                  : 'text-k3-text-tertiary cursor-not-allowed'
              }`}
            >
              {suggestion.text}
            </button>
          ))}
        </div>

        {/* Loading/Cancel */}
        {isLoading && (
          <div className="flex items-center justify-center gap-3 pt-2">
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
    </div>
  );
};

export default WelcomeState;
