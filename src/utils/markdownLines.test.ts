import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect } from 'vitest';
import { MarkdownBody } from '../components/coach/ResultCard';
import { groupMarkdownSegments } from './markdownLines';

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

  it('normalizes Windows CRLF so markers and text stay clean', () => {
    const text = '### 节奏\r\n**要点**\r\n- 先对线\r\n* 再抱团\r\n结论';
    expect(groupMarkdownSegments(text)).toEqual([
      { type: 'heading', text: '节奏' },
      { type: 'strong', text: '要点' },
      { type: 'list', items: ['先对线', '再抱团'] },
      { type: 'paragraph', text: '结论' },
    ]);
  });
});

describe('MarkdownBody list markup', () => {
  it('renders consecutive bullets inside a single ul, not as bare li', () => {
    const html = renderToStaticMarkup(
      React.createElement(MarkdownBody, {
        text: '导读\n- 先对线\n* 再抱团\n结论',
      }),
    );

    expect((html.match(/<ul\b/g) || []).length).toBe(1);
    expect((html.match(/<li\b/g) || []).length).toBe(2);
    expect(html).toMatch(/<ul[^>]*>[\s\S]*先对线[\s\S]*再抱团[\s\S]*<\/ul>/);
    expect(countBareListItems(html)).toBe(0);
  });
});

/** 轻量标签深度扫描：统计不在 <ul> 内的 <li>。 */
function countBareListItems(html: string): number {
  let depth = 0;
  let bare = 0;
  const tagRe = /<\/?(ul|li)\b[^>]*>/gi;
  for (let match = tagRe.exec(html); match; match = tagRe.exec(html)) {
    const tag = match[1].toLowerCase();
    const closing = match[0].startsWith('</');
    if (tag === 'ul') {
      depth += closing ? -1 : 1;
    } else if (tag === 'li' && !closing && depth <= 0) {
      bare += 1;
    }
  }
  return bare;
}
