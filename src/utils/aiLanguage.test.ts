import { describe, expect, it } from 'vitest';
import {
  deepseekLanguageLock,
  getDraftSystemInstruction,
  getLoreSystemInstruction,
  getPlaybookSystemPrompt,
  getReviewSystemPrompt,
  normalizeUiLang,
} from '../../lib/aiLanguage.js';

describe('normalizeUiLang', () => {
  it('keeps zh and maps everything else to en (product default)', () => {
    expect(normalizeUiLang('zh')).toBe('zh');
    expect(normalizeUiLang('en')).toBe('en');
    expect(normalizeUiLang(undefined)).toBe('en');
    expect(normalizeUiLang('')).toBe('en');
    expect(normalizeUiLang('fr')).toBe('en');
  });
});

describe('DeepSeek language locks', () => {
  it('getDraftSystemInstruction locks language near the top', () => {
    const zh = getDraftSystemInstruction('zh');
    const en = getDraftSystemInstruction('en');
    expect(zh.startsWith('【语言·不可协商】')).toBe(true);
    expect(zh).toContain('简体中文');
    expect(en.startsWith('[LANGUAGE — NON-NEGOTIABLE]')).toBe(true);
    expect(en).toContain('English');
    expect(zh).not.toContain('Please respond in English');
  });

  it('playbook / review / lore prompts include non-negotiable lock', () => {
    expect(getPlaybookSystemPrompt('zh')).toContain('简体中文');
    expect(getPlaybookSystemPrompt('en')).toContain('English');
    expect(getReviewSystemPrompt('zh', { followUp: false, keyMomentsRule: '2–4 key moments' })).toContain('JSON');
    expect(getReviewSystemPrompt('zh', { followUp: false, keyMomentsRule: '2–4 key moments' })).toContain('简体中文');
    expect(getReviewSystemPrompt('en', { followUp: false, keyMomentsRule: '2–4 key moments' })).toContain('MUST be written in English');
    expect(getReviewSystemPrompt('zh', { followUp: true })).toContain('简体中文');
    expect(getLoreSystemInstruction('zh')).toContain('简体中文');
    expect(getLoreSystemInstruction('zh')).toContain('店主');
    expect(getLoreSystemInstruction('en')).toContain('Shopkeeper');
  });

  it('deepseekLanguageLock matches UI lang', () => {
    expect(deepseekLanguageLock('zh')).toContain('简体中文');
    expect(deepseekLanguageLock('en')).toContain('English');
  });

  it('review prompts instruct the lost/destroyed-by wording for building events', () => {
    const followZh = getReviewSystemPrompt('zh', { followUp: true });
    expect(followZh).toContain('被 Z 摧毁');
    expect(followZh).toContain('goodguys_*=天辉建筑');
    expect(followZh).toContain('badguys_*=夜魇建筑');
    expect(followZh).toContain('T2 不是高地塔');

    const followEn = getReviewSystemPrompt('en', { followUp: true });
    expect(followEn).toContain('"X lost Y (destroyed by Z)"');
    expect(followEn).toContain('goodguys_* = Radiant building');
    expect(followEn).toContain('badguys_* = Dire building');
    expect(followEn).toContain('T2 is NOT high ground');

    const reviewZh = getReviewSystemPrompt('zh', { followUp: false, keyMomentsRule: '3 个关键时刻' });
    expect(reviewZh).toContain('被 Z 摧毁');
    const reviewEn = getReviewSystemPrompt('en', { followUp: false, keyMomentsRule: '3 key moments' });
    expect(reviewEn).toContain('"X lost Y (destroyed by Z)"');
  });
});
