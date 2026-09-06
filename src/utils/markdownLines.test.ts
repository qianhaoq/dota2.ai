import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect } from 'vitest';
import ResultCard from '../components/coach/ResultCard';
import { groupMarkdownSegments } from './markdownLines';
import type { CoachSession } from '../components/coach/coachMessage';

describe('groupMarkdownSegments', () => {
  it('groups consecutive dash/star bullets into one list', () => {
    const text = '导读\n- 先对线\n* 再抱团\n结论';
    expect(groupMarkdownSegments(text)).toEqual([
      { type: 'paragraph', text: '导读' },
      { type: 'list', items: ['先对线', '再抱团'] },
      { type: 'paragraph', text: '结论' },
    ]);
  });

  it('splits lists when a blank or heading interrupts', () => {
    const text = '- 一项\n\n- 二项\n### 小节\n- 三项';
    expect(groupMarkdownSegments(text)).toEqual([
      { type: 'list', items: ['一项'] },
      { type: 'blank' },
      { type: 'list', items: ['二项'] },
      { type: 'heading', text: '小节' },
      { type: 'list', items: ['三项'] },
    ]);
  });

  it('keeps headings, bold lines, and empty spacers', () => {
    expect(groupMarkdownSegments('### 节奏\n**要点**\n\n正文')).toEqual([
      { type: 'heading', text: '节奏' },
      { type: 'strong', text: '要点' },
      { type: 'blank' },
      { type: 'paragraph', text: '正文' },
    ]);
  });
});

describe('ResultCard MarkdownBody list markup', () => {
  const session: CoachSession = {
    id: 's1',
    query: '怎么打',
    action: 'analyze',
    message: { id: 'c1', type: 'coach', content: '- 先对线\n- 再抱团' },
    blocks: [{
      id: 'md',
      type: 'markdown',
      markdown: '导读\n- 先对线\n* 再抱团\n结论',
    }],
  };

  it('renders consecutive bullets inside a single ul, not as bare li', () => {
    const html = renderToStaticMarkup(
      React.createElement(ResultCard, {
        session,
        lang: 'zh',
        allHeroes: [],
        onSelectHero: () => undefined,
      }),
    );

    expect(html).toMatch(/<ul[^>]*>\s*<li[\s\S]*先对线[\s\S]*<li[\s\S]*再抱团[\s\S]*<\/ul>/);
    expect(html).not.toMatch(/<(?:div|p|section|article|header)[^>]*>\s*<li/);
  });
});
