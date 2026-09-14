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

  it('renders nested strong spans: outer bold wraps inner bold', () => {
    const html = render('**foo **bar** baz**');
    expect(html).toMatch(
      /<strong[^>]*>foo <strong[^>]*>bar<\/strong> baz<\/strong>/,
    );
    expect((html.match(/<strong\b/g) || []).length).toBe(2);
    expect(html).not.toContain('**');
  });

  it('keeps sole closer on outer when nested opener is unmatched', () => {
    const html = render('**foo **bar baz**');
    expect(html).toMatch(/<strong[^>]*>foo \*\*bar baz<\/strong>/);
    expect((html.match(/<strong\b/g) || []).length).toBe(1);
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

  it('keeps compact parenthesized * operators literal (punctuation flanking)', () => {
    const html = render('damage*(crit)*armor');
    expect(html).toContain('damage*(crit)*armor');
    expect(html).not.toContain('<em>');
    expect(html).not.toContain('<strong>');
  });

  it('keeps compact parenthesized ** operators literal (punctuation flanking)', () => {
    const html = render('damage**(crit)**armor');
    expect(html).toContain('damage**(crit)**armor');
    expect(html).not.toContain('<em>');
    expect(html).not.toContain('<strong>');
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
    // Generous CI budget: loaded runners have measured ~535ms on a 500ms gate.
    expect(elapsed).toBeLessThan(2000);
    expect(html).not.toContain('<strong>');
    expect(html).toContain('**a');
  });

  it('parses many unmatched asterisk italic openers in near-linear time', () => {
    const text = '*a '.repeat(16000); // ~48k chars
    const t0 = Date.now();
    const html = render(text);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(2000);
    expect(html).not.toContain('<em>');
    expect(html).toContain('*a');
  });

  it('parses many unmatched underscore italic openers in near-linear time', () => {
    const text = '_a '.repeat(16000); // ~48k chars
    const t0 = Date.now();
    const html = render(text);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(2000);
    expect(html).not.toContain('<em>');
    expect(html).toContain('_a');
  });

  it('partitions shared *** closer as bold wrapping nested italic', () => {
    const html = render('x **foo *bar*** y');
    expect(html).toMatch(
      /<strong[^>]*>[\s\S]*foo[\s\S]*<em[^>]*>bar<\/em>[\s\S]*<\/strong>/,
    );
    expect((html.match(/<strong\b/g) || []).length).toBe(1);
    expect((html.match(/<em\b/g) || []).length).toBe(1);
    expect(html).not.toContain('*bar');
    expect(html).not.toContain('bar*');
    expect(html).not.toContain('**');
  });

  it('keeps outer italic when bold shares a trailing *** closer', () => {
    const html = render('x *foo **bar*** y');
    expect(html).toMatch(
      /<em[^>]*>[\s\S]*foo[\s\S]*<strong[^>]*>bar<\/strong>[\s\S]*<\/em>/,
    );
    expect((html.match(/<em\b/g) || []).length).toBe(1);
    expect((html.match(/<strong\b/g) || []).length).toBe(1);
    expect(html).not.toContain('**');
  });

  it('partitions transition *** between italic and following bold', () => {
    const html = render('*italic***bold**');
    expect(html).toMatch(/<em[^>]*>italic<\/em>/);
    expect(html).toMatch(/<strong[^>]*>bold<\/strong>/);
    expect(html).toMatch(/<em[^>]*>italic<\/em><strong[^>]*>bold<\/strong>/);
    expect(html).not.toContain('*italic');
    expect(html).not.toContain('*bold');
    expect(html).not.toContain('**');
  });

  it('does not stack-overflow on very long balanced asterisk runs', () => {
    const text = '*'.repeat(5000) + 'x' + '*'.repeat(5000);
    let html = '';
    expect(() => {
      html = render(text);
    }).not.toThrow();
    expect(html).toContain('x');
    expect(html.length).toBeGreaterThan(0);
  });

  it('consumes unmatched multi-backtick opener runs as literal', () => {
    // Partial stream: 3-tick opener, no 3-tick closer, then a 2-tick run.
    const html = render('```foo``');
    expect(html).not.toContain('<code>');
    expect(html).toContain('```foo``');
  });

  it('consumes unmatched backtick runs while searching for italic closers', () => {
    // 3-tick opener has no 3-tick closer; must not retry the 2-tick suffix as a
    // code span and skip the real `*` closer after b.
    const html = render('*a ```b*`` c*');
    expect((html.match(/<em\b/g) || []).length).toBe(1);
    expect(html).toMatch(/<em[^>]*>a ```b<\/em>/);
    expect(html).toContain('`` c*');
    expect(html).not.toContain('<code>');
    // Must not italicize through to the final star.
    expect(html).not.toMatch(/<em[^>]*>a ```b\*`` c<\/em>/);
  });

  it('lets right-flanking ** close single italic on the first star', () => {
    const html = render('*important**');
    expect(html).toMatch(/<em[^>]*>important<\/em>\*/);
    expect((html.match(/<em\b/g) || []).length).toBe(1);
    expect(html).not.toContain('<strong>');
    expect(html).not.toContain('*important');
  });

  it('skips nested asterisk italic when choosing the outer closer', () => {
    const html = render('*outer *inner* tail*');
    expect(html).toMatch(
      /<em[^>]*>outer <em[^>]*>inner<\/em> tail<\/em>/,
    );
    expect((html.match(/<em\b/g) || []).length).toBe(2);
    expect(html).not.toContain('*outer');
    expect(html).not.toContain('tail*');
  });

  it('skips nested underscore italic when choosing the outer closer', () => {
    const html = render('_outer _inner_ tail_');
    expect(html).toMatch(
      /<em[^>]*>outer <em[^>]*>inner<\/em> tail<\/em>/,
    );
    expect((html.match(/<em\b/g) || []).length).toBe(2);
    expect(html).not.toContain('_outer');
    expect(html).not.toContain('tail_');
  });

  it('consumes non-opening asterisk runs atomically (near-linear)', () => {
    const text = '*'.repeat(40000);
    const t0 = Date.now();
    const html = render(text);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(2000);
    expect(html).not.toContain('<em>');
    expect(html).not.toContain('<strong>');
    expect(html).toContain('*');
  });

  it('keeps internal both-flanking ** inside one outer italic (rule of three)', () => {
    // CommonMark: opener len 1 + closer run 2 = 3 → must not match.
    const html = render('*foo**bar*');
    expect(html).toMatch(/<em[^>]*>foo\*\*bar<\/em>/);
    expect((html.match(/<em\b/g) || []).length).toBe(1);
    expect(html).not.toContain('<strong>');
    // Must not split into two adjacent emphasis spans.
    expect(html).not.toMatch(/<em[^>]*>foo<\/em><em[^>]*>bar<\/em>/);
  });

  it('keeps incomplete triple-star openers literal during streaming', () => {
    // Partial prefix of `***Warning:** buy BKB*` — do not bold-fallback.
    const html = render('Use ***Warning:**');
    expect(html).toContain('Use ***Warning:**');
    expect(html).not.toContain('<strong>');
    expect(html).not.toContain('<em>');
    // Must not collapse to bold with a leaked star (`*Warning:`).
    expect(html).not.toMatch(/<strong[^>]*>\*Warning:/);
  });

  it('still parses complete asymmetric triple nesting after streaming fix', () => {
    const html = render('***Warning:** buy BKB*');
    expect(html).toMatch(
      /<em[^>]*>[\s\S]*<strong[^>]*>Warning:<\/strong>[\s\S]*buy BKB[\s\S]*<\/em>/,
    );
    expect(html).not.toContain('*Warning');
  });

  it('consumes rejected star runs atomically in bold closer scans', () => {
    // `****` after whitespace is not a closer; must not retry from interior stars.
    const html = render('Use **BKB ****');
    expect(html).toContain('Use **BKB ****');
    expect(html).not.toContain('<strong>');
    expect(html).not.toContain('<em>');
    // Must not close mid-run into `BKB *</strong>*`.
    expect(html).not.toMatch(/BKB \*<\/strong>/);
  });

  it('partitions triple openers as bold-outer when the one-star closer comes first', () => {
    // Opposite of `***foo** bar*` / `***Warning:** buy BKB*` (italic-outer).
    const html = render('x ***foo* bar** y');
    expect(html).toMatch(
      /<strong[^>]*>[\s\S]*<em[^>]*>foo<\/em>[\s\S]*bar[\s\S]*<\/strong>/,
    );
    expect((html.match(/<strong\b/g) || []).length).toBe(1);
    expect((html.match(/<em\b/g) || []).length).toBe(1);
    expect(html).not.toContain('***');
    expect(html).not.toContain('*foo');
    expect(html).not.toContain('bar**');
    // Must not leave the whole sequence literal.
    expect(html).not.toContain('***foo* bar**');
  });

  it('keeps rule-of-three both-flanking bold pairs literal', () => {
    // Opener ** (2) + closer **** (4) = 6, both-flanking, neither multiple of 3.
    const html = render('a**b****c');
    expect(html).toContain('a**b****c');
    expect(html).not.toContain('<strong>');
    expect(html).not.toContain('<em>');
    expect(html).not.toMatch(/a<strong[^>]*>b<\/strong>/);
  });

  it('does not reuse outer bold-search failures for a later inner opener', () => {
    // Outer `**` has no closer; inner `**b**` must still render strong.
    const html = render('**a **b** ****');
    expect(html).toMatch(/\*\*a <strong[^>]*>b<\/strong> \*\*\*\*/);
    expect((html.match(/<strong\b/g) || []).length).toBe(1);
    expect(html).not.toContain('<em>');
    // Must not leave the valid inner span literal.
    expect(html).not.toContain('**b**');
  });

  it('does not reuse outer italic-search failures for a later inner opener', () => {
    // Outer `*` skips nested `*b*`, rejects `**` via rule of three, must not
    // cache that miss so later `*b*` still renders emphasis.
    const html = render('x*a *b* d**c');
    expect(html).toMatch(/x\*a <em[^>]*>b<\/em> d\*\*c/);
    expect((html.match(/<em\b/g) || []).length).toBe(1);
    expect(html).not.toContain('<strong>');
    // Unmatched outer markers stay literal; nested b must not.
    expect(html).toContain('x*a');
    expect(html).toContain('d**c');
    expect(html).not.toContain('*b*');
  });

  it('parses many unmatched triple-star openers in near-linear time', () => {
    // Each `***a ` used to rescan the suffix via firstRightFlankingAsteriskRunLength.
    const text = '***a '.repeat(8000); // ~40k chars
    const t0 = Date.now();
    const html = render(text);
    const elapsed = Date.now() - t0;
    // Generous CI budget (unfixed ~2.1s on Node 20); cached path should be well under.
    expect(elapsed).toBeLessThan(2000);
    expect(html).not.toContain('<strong>');
    expect(html).not.toContain('<em>');
    expect(html).toContain('***a');
  });

  it('keeps incomplete four-star spans literal while the closer is short', () => {
    // Streaming prefix of `****important****` — do not wrap with leftover stars inside.
    const html = render('****important***');
    expect(html).toContain('****important***');
    expect(html).not.toContain('<strong>');
    expect(html).not.toContain('<em>');
    // Must not render `<strong>**important*</strong>`.
    expect(html).not.toMatch(/<strong[^>]*>\*\*important\*<\/strong>/);
  });

  it('still partitions complete four-star spans after unequal-run fix', () => {
    const html = render('****important****');
    expect(html).toMatch(/<strong[^>]*>[\s\S]*important[\s\S]*<\/strong>/);
    expect(html).not.toMatch(/<strong[^>]*>\s*<\/strong>/);
    expect(html).not.toContain('****');
    expect(html).toContain('important');
  });

  it('nests strong+em for intraword both-flanking triple stars', () => {
    // Chinese letters both-flank ***; must not reinterpret leftover opener
    // stars as nested bold (that path fails punctuation flanking).
    const html = render('这是***重点***现在');
    expect(html).toMatch(
      /<strong[^>]*><em[^>]*>重点<\/em><\/strong>|<em[^>]*><strong[^>]*>重点<\/strong><\/em>/,
    );
    expect(html).toContain('这是');
    expect(html).toContain('现在');
    expect(html).not.toContain('***');
    expect(html).not.toContain('*重点');
    expect(html).not.toContain('重点*');
  });

  it('partitions longer both-flanking ÷3 asterisk runs as strong pairs', () => {
    // Six markers are three ** pairs — not one em+strong nest (reserved for ***).
    const html = render('这是******重点******现在');
    expect(html).toMatch(
      /<strong[^>]*><strong[^>]*><strong[^>]*>重点<\/strong><\/strong><\/strong>/,
    );
    expect(html).not.toContain('<em');
    expect(html).toContain('这是');
    expect(html).toContain('现在');
    expect(html).not.toContain('******');
    expect(html).not.toContain('*重点');
    expect(html).not.toContain('重点*');
  });

  it('caches successful triple-closer lookaheads in near-linear time', () => {
    // Positive firstRightFlankingAsteriskRunLength hits must be memoized too;
    // EOF-miss cache alone leaves `'***a '.repeat(N) + 'x*'` quadratic (~2.6s/40k).
    const text = '***a '.repeat(8000) + 'x*'; // ~40k chars
    const t0 = Date.now();
    const html = render(text);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(2000);
    // Distant single-star closer does not italicize the unmatched ***a openers.
    expect(html).not.toContain('<em>');
    expect(html).not.toContain('<strong>');
    expect(html).toContain('***a');
    expect(html).toContain('x*');
  });

  it('parses nested ambiguous italic markers in near-linear time', () => {
    // skipAsteriskItalicSpan + hasAsteriskCloserAtOrAfter used to re-explore
    // the suffix for every nesting; ~140 chars took ~2s unfixed.
    const text = '*a *b* '.repeat(40); // ~280 chars; unfixed times out / multi-second
    const t0 = Date.now();
    const html = render(text);
    const elapsed = Date.now() - t0;
    // Generous CI budget (unfixed ~2s for only 20 reps on Node 20).
    expect(elapsed).toBeLessThan(2000);
    // Nested `*b*` spans still render; outer `*a ` may share closers.
    expect(html).toContain('<em');
    expect(html).toContain('b');
  });

  it('parses nested ambiguous bold markers in near-linear time', () => {
    const text = '**a **b** '.repeat(40);
    const t0 = Date.now();
    const html = render(text);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(2000);
    expect(html).toContain('<strong');
    expect(html).toContain('b');
  });

  it('parses nested ambiguous underscore markers in near-linear time', () => {
    const text = '_a _b_ '.repeat(40);
    const t0 = Date.now();
    const html = render(text);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(2000);
    expect(html).toContain('<em');
    expect(html).toContain('b');
  });

});
