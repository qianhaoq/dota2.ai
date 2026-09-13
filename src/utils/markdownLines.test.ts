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

  it('leaves multi-span bold lines as paragraphs for inline parsing', () => {
    expect(groupMarkdownSegments('**a** and **b**')).toEqual([
      { type: 'paragraph', text: '**a** and **b**' },
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

describe('MarkdownBody inline bold', () => {
  const render = (text: string) =>
    renderToStaticMarkup(React.createElement(MarkdownBody, { text }));

  it('renders inline **bold** in a paragraph without raw asterisks', () => {
    const html = render('hello **world**');
    expect(html).toContain('<strong>world</strong>');
    expect(html).not.toContain('**');
  });

  it('renders inline bold inside list items and keeps a single ul', () => {
    const html = render('- focus **core** timing');
    expect(html).toContain('<strong>core</strong>');
    expect(html).not.toContain('**');
    expect((html.match(/<ul\b/g) || []).length).toBe(1);
    expect(countBareListItems(html)).toBe(0);
  });

  it('still renders a whole-line **strong** line', () => {
    const html = render('**whole line**');
    expect(html).toMatch(/<strong[^>]*>whole line<\/strong>/);
    expect(html).not.toContain('**');
  });

  it('handles multiple bold spans in one paragraph', () => {
    const html = render('**a** and **b**');
    expect(html).toContain('<strong>a</strong>');
    expect(html).toContain('<strong>b</strong>');
    expect(html).not.toContain('**');
  });

  it('renders *italic* without breaking text', () => {
    const html = render('play *slow* here');
    expect(html).toContain('<em>slow</em>');
  });

  it('allows italic emphasis markers inside bold spans', () => {
    const html = render('Use **BKB during the *first* jump**');
    expect(html).toContain('<strong>');
    expect(html).toContain('<em>first</em>');
    expect(html).toMatch(/<strong[^>]*>[\s\S]*<em>first<\/em>[\s\S]*<\/strong>/);
    expect(html).not.toContain('**');
  });

  it('preserves underscores inside snake_case identifiers', () => {
    const html = render('target npc_dota_hero_axe next');
    expect(html).toContain('npc_dota_hero_axe');
    expect(html).not.toContain('<em>');
  });

  it('still renders standalone _italic_ with word boundaries', () => {
    const html = render('play _slow_ here');
    expect(html).toContain('<em>slow</em>');
    expect(html).not.toContain('_slow_');
  });

  it('does not treat spaced multiplication asterisks as emphasis', () => {
    const html = render('damage * 1.5 * armor');
    expect(html).toContain('damage * 1.5 * armor');
    expect(html).not.toContain('<em>');
  });

  it('preserves italic containers around bold spans', () => {
    const html = render('Move *after **BKB** expires*');
    expect(html).toMatch(/<em[^>]*>[\s\S]*<strong[^>]*>BKB<\/strong>[\s\S]*<\/em>/);
    expect(html).toContain('after');
    expect(html).toContain('expires');
    expect(html).not.toContain('**');
    expect(html).not.toContain('*after');
    expect(html).not.toContain('expires*');
  });

  it('renders triple-asterisk runs as nested strong+em with no leaked stars', () => {
    const html = render('This is ***important*** now');
    expect(html).toMatch(
      /<strong[^>]*><em[^>]*>important<\/em><\/strong>|<em[^>]*><strong[^>]*>important<\/strong><\/em>/,
    );
    expect(html).not.toContain('**');
    expect(html).not.toContain('*important');
    expect(html).not.toContain('important*');
  });

  it('keeps spaced double-asterisk operators literal', () => {
    const html = render('damage ** 2 ** armor');
    expect(html).toContain('damage ** 2 ** armor');
    expect(html).not.toContain('<strong>');
  });

  it('preserves Chinese underscore identifiers with Unicode letter boundaries', () => {
    const html = render('查看 英雄_斧王_编号 即可');
    expect(html).toContain('英雄_斧王_编号');
    expect(html).not.toContain('<em>');
  });

  it('partitions four-star runs as nested strong without empty spans', () => {
    const html = render('This is ****important**** now');
    expect(html).toMatch(/<strong[^>]*>[\s\S]*important[\s\S]*<\/strong>/);
    expect(html).not.toMatch(/<strong[^>]*>\s*<\/strong>/);
    expect(html).not.toContain('****');
    expect(html).toContain('important');
  });

  it('preserves backslash-escaped emphasis delimiters as literal stars', () => {
    const html = render('Use \\*slow\\* literally');
    expect(html).toContain('*slow*');
    expect(html).not.toContain('<em>');
    expect(html).not.toContain('\\*');
  });

  it('keeps unmatched bold openers literal instead of italicizing', () => {
    const html = render('Use **BKB*');
    expect(html).toContain('**BKB*');
    expect(html).not.toContain('<em>');
    expect(html).not.toContain('<strong>');
  });

  it('protects inline code spans from emphasis parsing', () => {
    const html = render('`damage*armor*scale`');
    expect(html).toContain('damage*armor*scale');
    expect(html).not.toContain('<em>');
    expect(html).toMatch(/<code[^>]*>damage\*armor\*scale<\/code>/);
  });

  it('ignores ** inside code spans while finding the bold closer', () => {
    const html = render('**Use `damage**armor` safely**');
    expect((html.match(/<strong\b/g) || []).length).toBe(1);
    expect(html).toMatch(
      /<strong[^>]*>[\s\S]*<code[^>]*>damage\*\*armor<\/code>[\s\S]*<\/strong>/,
    );
    // `**` may appear inside the code span content; outer markers must not leak.
    expect(html).not.toContain('**Use');
    expect(html).not.toContain('safely**');
  });

  it('ignores * inside code spans while finding the italic closer', () => {
    const html = render('*Use `damage*armor` safely*');
    expect((html.match(/<em\b/g) || []).length).toBe(1);
    expect(html).toMatch(
      /<em[^>]*>[\s\S]*<code[^>]*>damage\*armor<\/code>[\s\S]*<\/em>/,
    );
  });

  it('matches multi-backtick code spans by delimiter run length', () => {
    const html = render('Use `` `foo` `` literally');
    expect((html.match(/<code\b/g) || []).length).toBe(1);
    // CommonMark strips one leading/trailing space inside equal-length fences.
    expect(html).toMatch(/<code[^>]*>`foo`<\/code>/);
  });

  it('continues past non-closing intraword underscores for emphasis', () => {
    const html = render('play _very_good_ here');
    expect(html).toContain('<em>very_good</em>');
    expect(html).not.toContain('_very_good_');
    expect(html).not.toMatch(/_<em>/);
    expect(html).not.toMatch(/<\/em>_/);
  });

  it('does not strip all-space code span content', () => {
    const html = render('x ``  `` y');
    expect((html.match(/<code\b/g) || []).length).toBe(1);
    expect(html).toMatch(/<code[^>]*>  <\/code>/);
  });

  it('parses asymmetric triple-star nesting as italic wrapping bold', () => {
    const html = render('***Warning:** buy BKB*');
    expect(html).toMatch(
      /<em[^>]*>[\s\S]*<strong[^>]*>Warning:<\/strong>[\s\S]*buy BKB[\s\S]*<\/em>/,
    );
    expect((html.match(/<em\b/g) || []).length).toBe(1);
    expect((html.match(/<strong\b/g) || []).length).toBe(1);
    expect(html).not.toContain('*Warning');
    expect(html).not.toContain('BKB*');
  });

  it('keeps a backslash before the closing backtick inside code spans', () => {
    const html = render('`C:\\`');
    expect((html.match(/<code\b/g) || []).length).toBe(1);
    expect(html).toContain('<code>C:\\</code>');
    expect(html).not.toMatch(/<code>C:<\/code>/);
  });

  it('ignores _ inside code spans while finding the underscore closer', () => {
    const html = render('_Use `a_b_` safely_');
    expect((html.match(/<em\b/g) || []).length).toBe(1);
    expect(html).toMatch(
      /<em[^>]*>[\s\S]*<code[^>]*>a_b_<\/code>[\s\S]*<\/em>/,
    );
    expect(html).not.toContain('_Use');
    expect(html).not.toContain('safely_');
  });

  it('parses many unmatched bold openers in near-linear time', () => {
    const text = '**a '.repeat(8000);
    const t0 = Date.now();
    const html = render(text);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(500);
    expect(html).not.toContain('<strong>');
    expect(html).toContain('**a');
  });
});
