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

/** Match `**bold**` first so nested `*` inside bold is handled after. */
const INLINE_BOLD_RE = /\*\*((?:(?!\*\*).)+?)\*\*/g;
/** Single `*italic*` or `_italic_` (no newlines). */
const INLINE_ITALIC_RE = /(?:\*([^*\n]+?)\*|(?<!\w)_([^_\n]+?)_(?!\w))/g;

function renderItalicText(text: string, nextKey: () => string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  INLINE_ITALIC_RE.lastIndex = 0;
  for (let m = INLINE_ITALIC_RE.exec(text); m; m = INLINE_ITALIC_RE.exec(text)) {
    if (m.index > last) {
      nodes.push(createElement(Fragment, { key: nextKey() }, text.slice(last, m.index)));
    }
    const inner = m[1] ?? m[2] ?? '';
    nodes.push(createElement('em', { key: nextKey() }, inner));
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    nodes.push(createElement(Fragment, { key: nextKey() }, text.slice(last)));
  }
  return nodes.length > 0 ? nodes : [text];
}

/**
 * Render inline markdown (`**bold**`, `*italic*`, `_italic_`) as React nodes.
 * Does not use dangerouslySetInnerHTML.
 */
export function renderInlineMarkdown(text: string): ReactNode[] {
  let key = 0;
  const nextKey = () => `i${key++}`;
  const nodes: ReactNode[] = [];
  let last = 0;
  INLINE_BOLD_RE.lastIndex = 0;
  for (let m = INLINE_BOLD_RE.exec(text); m; m = INLINE_BOLD_RE.exec(text)) {
    if (m.index > last) {
      nodes.push(...renderItalicText(text.slice(last, m.index), nextKey));
    }
    nodes.push(createElement('strong', { key: nextKey() }, ...renderItalicText(m[1], nextKey)));
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    nodes.push(...renderItalicText(text.slice(last), nextKey));
  }
  return nodes;
}
