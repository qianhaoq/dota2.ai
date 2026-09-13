import { createElement, Fragment, type ReactNode } from 'react';

export type MarkdownSegment =
  | { type: 'heading'; text: string }
  | { type: 'strong'; text: string }
  | { type: 'list'; items: string[] }
  | { type: 'blank' }
  | { type: 'paragraph'; text: string };

/**
 * 把教练结果 markdown 按行收成渲染段。
 * 连续 `- ` / `* ` 行合成一个 list，便于包进真正的 <ul>。
 */
export function groupMarkdownSegments(text: string): MarkdownSegment[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const segments: MarkdownSegment[] = [];

  for (const line of lines) {
    if (line.startsWith('### ')) {
      segments.push({ type: 'heading', text: line.slice(4) });
      continue;
    }
    // Whole-line strong only when the interior has no further `**`
    // so `**a** and **b**` stays a paragraph for inline parsing.
    if (line.startsWith('**') && line.endsWith('**') && line.length >= 4) {
      const inner = line.slice(2, -2);
      if (!inner.includes('**')) {
        segments.push({ type: 'strong', text: inner });
        continue;
      }
    }
    if (line.startsWith('- ') || line.startsWith('* ')) {
      const item = line.slice(2);
      const last = segments[segments.length - 1];
      if (last?.type === 'list') {
        last.items.push(item);
      } else {
        segments.push({ type: 'list', items: [item] });
      }
      continue;
    }
    if (line.trim() === '') {
      segments.push({ type: 'blank' });
      continue;
    }
    segments.push({ type: 'paragraph', text: line });
  }

  return segments;
}

/** Letter / number / `_` — Unicode-aware so Chinese counts as identifier chars. */
function isIdentChar(ch: string | undefined): boolean {
  if (!ch) return false;
  return /[\p{L}\p{N}_]/u.test(ch);
}

function isWhitespace(ch: string | undefined): boolean {
  return ch !== undefined && /\s/.test(ch);
}

/** Skip a `**…**` span starting at `i` (`text[i]` is first `*`). Returns index after close, or -1. */
function skipBoldSpan(text: string, i: number): number {
  if (!text.startsWith('**', i)) return -1;
  const close = text.indexOf('**', i + 2);
  if (close === -1 || text.slice(i + 2, close).includes('\n')) return -1;
  return close + 2;
}

function findClosingBold(text: string, start: number): number {
  for (let j = start; j < text.length - 1; j++) {
    if (text[j] === '\n') return -1;
    if (text.startsWith('**', j)) return j;
  }
  return -1;
}

/** Asterisk open: left-flanking (not followed by whitespace). */
function canOpenAsterisk(text: string, i: number): boolean {
  const next = text[i + 1];
  return next !== undefined && next !== '\n' && !isWhitespace(next);
}

/**
 * Find closing `*` for emphasis. Must be right-flanking (not preceded by whitespace).
 * Skips nested `**bold**` so outer italic can wrap bold.
 */
function findClosingAsterisk(text: string, start: number): number {
  for (let j = start; j < text.length; j++) {
    if (text[j] === '\n') return -1;
    if (text.startsWith('**', j)) {
      const after = skipBoldSpan(text, j);
      if (after === -1) return -1;
      j = after - 1;
      continue;
    }
    if (text[j] === '*' && !isWhitespace(text[j - 1])) {
      return j;
    }
  }
  return -1;
}

/** Underscore open: not after an identifier char, and left-flanking. */
function canOpenUnderscore(text: string, i: number): boolean {
  if (isIdentChar(text[i - 1])) return false;
  const next = text[i + 1];
  return next !== undefined && next !== '\n' && next !== '_' && !isWhitespace(next);
}

/**
 * Find closing `_`. Right-flanking, not before an identifier char.
 * Interior must not contain `_` (same as prior `[^_\n]+` behavior).
 */
function findClosingUnderscore(text: string, start: number): number {
  for (let j = start; j < text.length; j++) {
    if (text[j] === '\n') return -1;
    if (text[j] === '_') {
      if (isWhitespace(text[j - 1])) return -1;
      if (isIdentChar(text[j + 1])) return -1;
      // No other `_` between start and j
      if (text.slice(start, j).includes('_')) return -1;
      return j;
    }
  }
  return -1;
}

function parseInline(text: string, nextKey: () => string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let i = 0;
  let literalStart = 0;

  const flushLiteral = (end: number) => {
    if (end > literalStart) {
      nodes.push(createElement(Fragment, { key: nextKey() }, text.slice(literalStart, end)));
    }
  };

  while (i < text.length) {
    // Prefer `**bold**` over single `*`
    if (text.startsWith('**', i)) {
      const close = findClosingBold(text, i + 2);
      if (close !== -1) {
        flushLiteral(i);
        const inner = text.slice(i + 2, close);
        nodes.push(createElement('strong', { key: nextKey() }, ...parseInline(inner, nextKey)));
        i = close + 2;
        literalStart = i;
        continue;
      }
    }

    if (text[i] === '*' && !text.startsWith('**', i) && canOpenAsterisk(text, i)) {
      const close = findClosingAsterisk(text, i + 1);
      if (close !== -1 && close > i + 1) {
        flushLiteral(i);
        const inner = text.slice(i + 1, close);
        nodes.push(createElement('em', { key: nextKey() }, ...parseInline(inner, nextKey)));
        i = close + 1;
        literalStart = i;
        continue;
      }
    }

    if (text[i] === '_' && canOpenUnderscore(text, i)) {
      const close = findClosingUnderscore(text, i + 1);
      if (close !== -1 && close > i + 1) {
        flushLiteral(i);
        const inner = text.slice(i + 1, close);
        nodes.push(createElement('em', { key: nextKey() }, ...parseInline(inner, nextKey)));
        i = close + 1;
        literalStart = i;
        continue;
      }
    }

    i += 1;
  }

  flushLiteral(text.length);
  return nodes.length > 0 ? nodes : [text];
}

/**
 * Render inline markdown (`**bold**`, `*italic*`, `_italic_`) as React nodes.
 * Does not use dangerouslySetInnerHTML.
 *
 * - Asterisk emphasis requires flanking (no open/close next to whitespace) so
 *   `damage * 1.5 * armor` stays literal.
 * - Nested spans keep delimiter context so `*after **BKB** expires*` → em>strong.
 * - Underscore boundaries are Unicode letter/number aware so `英雄_斧王_编号` stays intact.
 */
export function renderInlineMarkdown(text: string): ReactNode[] {
  let key = 0;
  const nextKey = () => `i${key++}`;
  return parseInline(text, nextKey);
}
