import React from 'react';
import { Language } from '../../types';

interface TypingIndicatorProps {
  lang: Language;
}

const TypingIndicator: React.FC<TypingIndicatorProps> = ({ lang }) => {
  const text = lang === 'zh' ? 'AI 教练正在思考' : 'AI Coach is thinking';

  return (
    <div className="flex items-center gap-3 text-gray-400 text-sm py-2">
      <div className="flex gap-1">
        <span className="w-2 h-2 bg-amber-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
        <span className="w-2 h-2 bg-amber-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
        <span className="w-2 h-2 bg-amber-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
      </div>
      <span className="text-xs">{text}</span>
    </div>
  );
};

export default TypingIndicator;
