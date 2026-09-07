import type { Language } from '../types';

export function incompleteReviewStreamMessage(lang: Language): string {
  return lang === 'zh' ? '复盘流未完成' : 'Review stream ended incomplete';
}

export function isReviewSseTerminal(data: string): boolean {
  return data.trim() === '[DONE]';
}
