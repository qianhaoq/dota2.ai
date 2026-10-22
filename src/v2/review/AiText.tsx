import React from 'react';

/**
 * Streaming AI answer text (handoff §3 AiText): progressively appended chunks
 * with a blinking caret while streaming. The caret's animation is disabled
 * under prefers-reduced-motion (see tokens.css).
 */
const AiText: React.FC<{ text: string; streaming: boolean; variant?: 'claim' | 'answer' }> = ({ text, streaming, variant = 'answer' }) => (
  <div className={`${variant === 'claim' ? 'text-d2-17 font-semibold text-d2-ink' : 'text-d2-15 text-d2-ink-2'} whitespace-pre-wrap [overflow-wrap:anywhere] ${streaming ? 'd2-caret' : ''}`}>{text}</div>
);

export default AiText;
