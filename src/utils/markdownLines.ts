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

/**
 * True when `text[i]` is preceded by an odd number of backslashes
 * (CommonMark-style escape of that character).
 */
function isEscaped(text: string, i: number): boolean {
  let n = 0;
  for (let k = i - 1; k >= 0 && text[k] === '\\'; k--) n += 1;
  return n % 2 === 1;
}

/** Unescape markdown punctuation escapes in a literal slice. */
function unescapeMarkdown(s: string): string {
  return s.replace(/\\([\\`*_{}\[\]()#+\-.!|>])/g, '$1');
}

/** Bold open: left-flanking — `**` must be followed by a non-whitespace char. */
function canOpenBold(text: string, i: number): boolean {
  if (isEscaped(text, i)) return false;
  const next = text[i + 2];
  return next !== undefined && next !== '\n' && !isWhitespace(next);
}

/** Per-parse cache: once a closer search fails through EOF from `start`, later searches from >= start also fail. */
interface CloserCache {
  noCloserFrom: number;
}

/** Shared caches for bold / asterisk / underscore failed-to-EOF closer scans. */
interface EmphasisCaches {
  bold: CloserCache;
  asterisk: CloserCache;
  underscore: CloserCache;
}

function freshEmphasisCaches(): EmphasisCaches {
  return {
    bold: { noCloserFrom: Number.POSITIVE_INFINITY },
    asterisk: { noCloserFrom: Number.POSITIVE_INFINITY },
    underscore: { noCloserFrom: Number.POSITIVE_INFINITY },
  };
}

/**
 * True when `[from, closerAt)` contains an unmatched left-flanking single `*`
 * that would close on the first star of the run at `closerAt` (right-flanking).
 * Used to partition shared `***` closers: nested italic takes the first star,
 * bold takes the last two.
 */
function hasUnmatchedItalicBefore(
  text: string,
  from: number,
  closerAt: number,
  caches?: EmphasisCaches,
): boolean {
  if (closerAt <= from) return false;
  if (isWhitespace(text[closerAt - 1])) return false; // not a valid italic closer

  let k = from;
  while (k < closerAt) {
    if (text[k] === '`' && !isEscaped(text, k)) {
      const after = skipCodeSpan(text, k);
      if (after !== -1) {
        k = Math.min(after, closerAt);
        continue;
      }
    }
    if (text.startsWith('**', k) && !isEscaped(text, k)) {
      const after = skipBoldSpan(text, k, caches);
      if (after !== -1 && after <= closerAt) {
        k = after;
        continue;
      }
      // Unmatched bold opener: skip both stars.
      k += 2;
      continue;
    }
    if (text[k] === '*' && canOpenAsterisk(text, k)) {
      // Scan for a closer strictly before closerAt (do not consume closerAt).
      const close = findClosingAsteriskBounded(text, k + 1, closerAt, caches);
      if (close === -1) return true; // would use closerAt
      k = close + 1;
      continue;
    }
    k += 1;
  }
  return false;
}

/**
 * Find closing `*` for emphasis within `[start, bound)` (exclusive bound).
 * Same rules as findClosingAsterisk but never considers indices >= bound.
 * Does not update failure caches (bounded probes must not poison EOF caches).
 */
function findClosingAsteriskBounded(
  text: string,
  start: number,
  bound: number,
  caches?: EmphasisCaches,
): number {
  for (let j = start; j < bound; j++) {
    if (text[j] === '\n') return -1;
    if (text[j] === '`' && !isEscaped(text, j)) {
      const after = skipCodeSpan(text, j);
      if (after !== -1) {
        j = after - 1;
        continue;
      }
    }
    if (text.startsWith('**', j) && !isEscaped(text, j)) {
      // Transition `***…`: close italic on first star before skipBoldSpan.
      if (!isWhitespace(text[j - 1])) {
        let runEnd = j;
        while (runEnd < text.length && text[runEnd] === '*') runEnd += 1;
        if (runEnd - j >= 3 && j < bound) {
          return j;
        }
      }
      const after = skipBoldSpan(text, j, caches);
      if (after === -1) {
        j += 1;
        continue;
      }
      if (after > bound) return -1;
      j = after - 1;
      continue;
    }
    if (text[j] === '*' && !isEscaped(text, j) && !isWhitespace(text[j - 1])) {
      return j;
    }
  }
  return -1;
}


/** Max nested-strong probes inside findClosingBold (stack + pathological `**a ` streams). */
const MAX_BOLD_NEST = 32;

/**
 * True when `[start, EOF)` still contains a right-flanking `**` that could
 * close an outer bold (skips code spans; does not update closer caches).
 */
function hasBoldCloserAtOrAfter(text: string, start: number): boolean {
  for (let j = start; j < text.length - 1; j++) {
    if (text[j] === '\n') return false;
    if (text[j] === '`' && !isEscaped(text, j)) {
      const after = skipCodeSpan(text, j);
      if (after !== -1) {
        j = after - 1;
        continue;
      }
    }
    if (
      text.startsWith('**', j) &&
      !isEscaped(text, j) &&
      !isWhitespace(text[j - 1])
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Find closing `**` for bold. Right-flanking (not preceded by whitespace);
 * keeps scanning past invalid candidates.
 *
 * Skips the remainder of the OPENING asterisk run so `****x****` does not
 * close on the opener itself. Closing runs are partitioned by opener and
 * nesting context:
 * leftover opener stars → last two of the closer (nested inside);
 * clean `**` with nested unmatched italic → last two (leave first for italic);
 * clean `**` otherwise → first two (trailing stars for an outer italic closer).
 *
 * Nested strong: a left-flanking-only `**` (whitespace before) is a nested
 * opener — skip a complete `**…**` span when another closer still follows, so
 * `**foo **bar** baz**` keeps the outer closer (same idea as skipping code spans).
 * Nested probes are depth-capped (`MAX_BOLD_NEST`) so unmatched `**` streams stay safe.
 *
 * Optional cache: a failed-to-EOF search from `start` makes later searches
 * from >= start return -1 without rescanning (avoids O(n²) unmatched `**`).
 */
function findClosingBold(
  text: string,
  start: number,
  caches?: EmphasisCaches,
  depth = 0,
): number {
  const cache = caches?.bold;
  if (cache && start >= cache.noCloserFrom) return -1;

  // Skip remainder of the opening delimiter run (stars still belonging to opener).
  let j = start;
  const hadOpenerRemainder = j < text.length && text[j] === '*';
  while (j < text.length && text[j] === '*') j += 1;

  for (; j < text.length - 1; j++) {
    if (text[j] === '\n') return -1; // do not cache — line-local; closer may exist after
    if (text[j] === '`' && !isEscaped(text, j)) {
      // Delimiters inside a code span are not emphasis closers.
      const after = skipCodeSpan(text, j);
      if (after !== -1) {
        j = after - 1;
        continue;
      }
    }
    if (!text.startsWith('**', j)) continue;
    if (isEscaped(text, j)) continue;
    if (isWhitespace(text[j - 1])) {
      // Not right-flanking: left-flanking-only `**` is a nested opener.
      // Skip a complete nested span only when another closer still follows so
      // we do not steal the sole closer (`**foo **bar baz**`).
      if (canOpenBold(text, j) && depth < MAX_BOLD_NEST) {
        const afterNested = skipBoldSpan(text, j, caches, depth + 1);
        if (afterNested !== -1 && hasBoldCloserAtOrAfter(text, afterNested)) {
          j = afterNested - 1;
        }
      }
      continue;
    }
    let runEnd = j;
    while (runEnd < text.length && text[runEnd] === '*') runEnd += 1;
    const runLen = runEnd - j;
    // Opener leftover → close on last two so nested stars stay inside (****x****).
    if (hadOpenerRemainder || runLen === 2) {
      return runEnd - 2;
    }
    // Clean ** opener with runLen > 2: partition by nesting context.
    // Nested italic sharing this *** → last two; else first two for outer em.
    if (hasUnmatchedItalicBefore(text, start, j, caches)) {
      return runEnd - 2;
    }
    return j;
  }
  // Exhausted to EOF with no closer — later searches from this start (or after) also fail.
  if (cache && start < cache.noCloserFrom) cache.noCloserFrom = start;
  return -1;
}

/**
 * Skip a valid flanked `**…**` span starting at `i` (`text[i]` is first `*`).
 * Returns index after close, or -1.
 */
function skipBoldSpan(
  text: string,
  i: number,
  caches?: EmphasisCaches,
  depth = 0,
): number {
  if (!text.startsWith('**', i)) return -1;
  if (!canOpenBold(text, i)) return -1;
  const close = findClosingBold(text, i + 2, caches, depth);
  if (close === -1) return -1;
  return close + 2;
}

/** Asterisk open: left-flanking (not followed by whitespace). */
function canOpenAsterisk(text: string, i: number): boolean {
  if (isEscaped(text, i)) return false;
  const next = text[i + 1];
  return next !== undefined && next !== '\n' && !isWhitespace(next);
}

/**
 * Find closing `*` for emphasis. Must be right-flanking (not preceded by whitespace).
 * Skips nested `**bold**` so outer italic can wrap bold.
 *
 * Optional cache: failed-to-EOF from `start` makes later searches from >= start
 * return -1 without rescanning (avoids O(n²) unmatched `*a ` openers).
 */
function findClosingAsterisk(
  text: string,
  start: number,
  caches?: EmphasisCaches,
): number {
  const cache = caches?.asterisk;
  if (cache && start >= cache.noCloserFrom) return -1;

  for (let j = start; j < text.length; j++) {
    if (text[j] === '\n') return -1; // do not cache — line-local
    if (text[j] === '`' && !isEscaped(text, j)) {
      // Delimiters inside a code span are not emphasis closers.
      const after = skipCodeSpan(text, j);
      if (after !== -1) {
        j = after - 1;
        continue;
      }
    }
    if (text.startsWith('**', j) && !isEscaped(text, j)) {
      // Transition run `***…` (e.g. `*italic***bold**`): first star closes
      // italic; remaining open bold. Partition before skipBoldSpan.
      if (!isWhitespace(text[j - 1])) {
        let runEnd = j;
        while (runEnd < text.length && text[runEnd] === '*') runEnd += 1;
        if (runEnd - j >= 3) {
          return j;
        }
      }
      const after = skipBoldSpan(text, j, caches);
      if (after === -1) {
        // Unmatched bold opener: skip both stars so they are not italic closers.
        j += 1;
        continue;
      }
      j = after - 1;
      continue;
    }
    if (text[j] === '*' && !isEscaped(text, j) && !isWhitespace(text[j - 1])) {
      return j;
    }
  }
  if (cache && start < cache.noCloserFrom) cache.noCloserFrom = start;
  return -1;
}

/** Underscore open: not after an identifier char, and left-flanking. */
function canOpenUnderscore(text: string, i: number): boolean {
  if (isEscaped(text, i)) return false;
  if (isIdentChar(text[i - 1])) return false;
  const next = text[i + 1];
  return next !== undefined && next !== '\n' && next !== '_' && !isWhitespace(next);
}

/**
 * Find closing `_`. Right-flanking: not preceded by whitespace and not
 * followed by an identifier char. Underscores that cannot close (escaped,
 * whitespace-preceded, or ident-followed) are treated as literal and the
 * scan continues for a later valid closer, so `_very_good_` works.
 *
 * Optional cache: failed-to-EOF from `start` makes later searches from >= start
 * return -1 without rescanning (avoids O(n²) unmatched `_a ` openers).
 */
function findClosingUnderscore(
  text: string,
  start: number,
  caches?: EmphasisCaches,
): number {
  const cache = caches?.underscore;
  if (cache && start >= cache.noCloserFrom) return -1;

  for (let j = start; j < text.length; j++) {
    if (text[j] === '\n') return -1; // do not cache — line-local
    if (text[j] === '`' && !isEscaped(text, j)) {
      // Delimiters inside a code span are not emphasis closers.
      const after = skipCodeSpan(text, j);
      if (after !== -1) {
        j = after - 1;
        continue;
      }
    }
    if (text[j] === '_') {
      if (isEscaped(text, j)) continue;
      if (isWhitespace(text[j - 1])) continue; // not right-flanking
      if (isIdentChar(text[j + 1])) continue; // ident-followed stays literal
      return j;
    }
  }
  if (cache && start < cache.noCloserFrom) cache.noCloserFrom = start;
  return -1;
}

/** Length of the asterisk run starting at `i` (`text[i]` is `*`). */
function asteriskRunLength(text: string, i: number): number {
  let n = 0;
  while (text[i + n] === '*') n += 1;
  return n;
}

/** Length of the backtick run starting at `i` (`text[i]` is a backtick). */
function backtickRunLength(text: string, i: number): number {
  let n = 0;
  while (text[i + n] === '`') n += 1;
  return n;
}

/**
 * Find the closing run for an inline code span opened at `open` (`).
 * CommonMark: the closer must be an unescaped run of exactly the same
 * number of backticks as the opener — a longer or shorter run does not close.
 * Returns the index of the first backtick of the closing run, or -1.
 */
function findClosingBacktick(text: string, open: number): number {
  const n = backtickRunLength(text, open);
  for (let j = open + n; j < text.length; j++) {
    if (text[j] === '\n') return -1;
    // Inside code spans backslashes are literal — do not treat \` as escaped.
    if (text[j] !== '`') continue;
    const run = backtickRunLength(text, j);
    if (run === n) return j;
    j += run - 1; // skip runs of the wrong length
  }
  return -1;
}

/**
 * Skip a complete code span opened at `i` (`text[i]` is a backtick).
 * Returns the index after the closing run, or -1 when there is no closer.
 */
function skipCodeSpan(text: string, i: number): number {
  const close = findClosingBacktick(text, i);
  if (close === -1) return -1;
  return close + backtickRunLength(text, i);
}

/**
 * CommonMark code-span content normalization: if the content both begins and
 * ends with a space (U+0020) and is not all spaces, strip one leading and one
 * trailing space so `` `foo` `` padding yields exactly `foo` with backticks.
 */
function normalizeCodeSpanContent(s: string): string {
  if (s.length >= 2 && s.startsWith(' ') && s.endsWith(' ') && /[^ ]/.test(s)) {
    return s.slice(1, -1);
  }
  return s;
}

/** Max recursive parseInline depth (long `***…***` runs must not blow the stack). */
const MAX_INLINE_NEST = 32;

function parseInline(text: string, nextKey: () => string, depth = 0): ReactNode[] {
  // Pathological long delimiter runs recurse via italic-outer peeling; cap depth.
  if (depth >= MAX_INLINE_NEST) {
    return [unescapeMarkdown(text)];
  }

  const nodes: ReactNode[] = [];
  let i = 0;
  let literalStart = 0;
  // One cache set per parse: unmatched `**` / `*` / `_` must not rescan the suffix each time.
  const caches = freshEmphasisCaches();

  const flushLiteral = (end: number) => {
    if (end > literalStart) {
      const raw = text.slice(literalStart, end);
      nodes.push(createElement(Fragment, { key: nextKey() }, unescapeMarkdown(raw)));
    }
  };

  while (i < text.length) {
    // Inline code spans suppress emphasis parsing inside.
    if (text[i] === '`' && !isEscaped(text, i)) {
      const close = findClosingBacktick(text, i);
      if (close !== -1) {
        flushLiteral(i);
        const ticks = backtickRunLength(text, i);
        const codeInner = normalizeCodeSpanContent(text.slice(i + ticks, close));
        nodes.push(createElement('code', { key: nextKey() }, codeInner));
        i = close + ticks;
        literalStart = i;
        continue;
      }
      // Unmatched opener run: consume the COMPLETE run as literal so a shorter
      // suffix cannot rematch (e.g. partial stream ```foo`` stays literal).
      i += backtickRunLength(text, i);
      continue;
    }

    // Triple+ asterisk runs: prefer italic-outer (CommonMark), so
    // `***Warning:** buy BKB*` → <em><strong>Warning:</strong> buy BKB</em>
    // rather than bold consuming the first two stars and leaving a stray `*`.
    if (text[i] === '*' && !isEscaped(text, i)) {
      const runLen = asteriskRunLength(text, i);
      if (runLen >= 3 && canOpenAsterisk(text, i)) {
        const close = findClosingAsterisk(text, i + 1, caches);
        if (close !== -1 && close > i + 1) {
          flushLiteral(i);
          const inner = text.slice(i + 1, close);
          nodes.push(createElement('em', { key: nextKey() }, ...parseInline(inner, nextKey, depth + 1)));
          i = close + 1;
          literalStart = i;
          continue;
        }
      }
    }

    // Prefer `**bold**` over single `*`; opener must be left-flanking
    if (text.startsWith('**', i) && canOpenBold(text, i)) {
      const close = findClosingBold(text, i + 2, caches);
      if (close !== -1) {
        flushLiteral(i);
        const inner = text.slice(i + 2, close);
        nodes.push(createElement('strong', { key: nextKey() }, ...parseInline(inner, nextKey, depth + 1)));
        i = close + 2;
        literalStart = i;
        continue;
      }
      // Unmatched bold opener: consume both stars as literal (do not retry 2nd as italic).
      i += 2;
      continue;
    }

    if (text[i] === '*' && !text.startsWith('**', i) && canOpenAsterisk(text, i)) {
      const close = findClosingAsterisk(text, i + 1, caches);
      if (close !== -1 && close > i + 1) {
        flushLiteral(i);
        const inner = text.slice(i + 1, close);
        nodes.push(createElement('em', { key: nextKey() }, ...parseInline(inner, nextKey, depth + 1)));
        i = close + 1;
        literalStart = i;
        continue;
      }
    }

    if (text[i] === '_' && canOpenUnderscore(text, i)) {
      const close = findClosingUnderscore(text, i + 1, caches);
      if (close !== -1 && close > i + 1) {
        flushLiteral(i);
        const inner = text.slice(i + 1, close);
        nodes.push(createElement('em', { key: nextKey() }, ...parseInline(inner, nextKey, depth + 1)));
        i = close + 1;
        literalStart = i;
        continue;
      }
    }

    i += 1;
  }

  flushLiteral(text.length);
  return nodes.length > 0 ? nodes : [unescapeMarkdown(text)];
}

/**
 * Render inline markdown (`**bold**`, `*italic*`, `_italic_`, `` `code` ``) as React nodes.
 * Does not use dangerouslySetInnerHTML.
 *
 * - Asterisk emphasis requires flanking (no open/close next to whitespace) so
 *   `damage * 1.5 * armor` stays literal.
 * - Nested spans keep delimiter context so `*after **BKB** expires*` → em>strong.
 * - Underscore boundaries are Unicode letter/number aware so `英雄_斧王_编号` stays intact.
 * - Longer asterisk runs partition by opener/closer context (`****x****`, `***x***`, asymmetric `***a** b*`).
 * - Backslash-escaped delimiters stay literal; unmatched `**` openers are not retried as italic.
 * - Backtick code spans are protected from emphasis parsing (including inside underscore closers).
 * - Unmatched `**` / `*` / `_` openers cache failed closer scans so long streams stay linear-ish.
 * - Shared `***` closers partition by nesting (`**foo *bar***` → strong>em; `*foo **bar***` → em>strong).
 * - Nested strong skips complete inner `**…**` when an outer closer remains (`**foo **bar** baz**`).
 * - Transition `***` between italic and bold partitions before skipBoldSpan (`*italic***bold**`).
 * - Recursive inline parse is depth-capped (`MAX_INLINE_NEST`) so long `*`.repeat runs never stack-overflow.
 * - Unmatched multi-backtick openers consume the whole opener run as literal (no shorter rematch).
 */
export function renderInlineMarkdown(text: string): ReactNode[] {
  let key = 0;
  const nextKey = () => `i${key++}`;
  return parseInline(text, nextKey);
}
