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
 * CommonMark punctuation for flanking: Unicode P* categories plus the ASCII
 * punctuation set (includes backtick, which is Symbol not Punctuation).
 */
function isPunctuation(ch: string | undefined): boolean {
  if (!ch) return false;
  if (/[!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~]/.test(ch)) return true;
  return /\p{P}/u.test(ch);
}

/**
 * Start/end of string count as whitespace for CommonMark flanking checks
 * so `*(foo)*` / `**(x)**` still open at the boundary.
 */
function isFlankWhitespace(ch: string | undefined): boolean {
  return ch === undefined || isWhitespace(ch);
}

/**
 * Left-flanking delimiter run of `runLen` markers starting at `i` (CommonMark):
 * not followed by whitespace, and either not followed by punctuation, or
 * followed by punctuation and preceded by whitespace or punctuation.
 * (Opener followed by `(` cannot open when preceded by a letter.)
 */
function isLeftFlankingRun(text: string, i: number, runLen: number): boolean {
  const preceded = text[i - 1];
  const followed = text[i + runLen];
  if (isFlankWhitespace(followed)) return false;
  if (!isPunctuation(followed)) return true;
  return isFlankWhitespace(preceded) || isPunctuation(preceded);
}

/**
 * Right-flanking delimiter run of `runLen` markers starting at `i` (CommonMark):
 * not preceded by whitespace, and either not preceded by punctuation, or
 * preceded by punctuation and followed by whitespace or punctuation.
 * (Closer preceded by `)` cannot close when followed by a letter.)
 */
function isRightFlankingRun(text: string, i: number, runLen: number): boolean {
  const preceded = text[i - 1];
  const followed = text[i + runLen];
  if (isFlankWhitespace(preceded)) return false;
  if (!isPunctuation(preceded)) return true;
  return isFlankWhitespace(followed) || isPunctuation(followed);
}

/** Asterisk run can open emphasis/strong when left-flanking. */
function canOpenAsteriskRun(text: string, i: number, runLen: number): boolean {
  return runLen >= 1 && isLeftFlankingRun(text, i, runLen);
}

/** Asterisk run can close emphasis/strong when right-flanking. */
function canCloseAsteriskRun(text: string, i: number, runLen: number): boolean {
  return runLen >= 1 && isRightFlankingRun(text, i, runLen);
}

/**
 * Length of the first right-flanking asterisk run at or after `start`
 * (line-local; skips code spans; rejected runs skipped atomically).
 * 0 if none — used to partition triple openers by closer order.
 */
function firstRightFlankingAsteriskRunLength(text: string, start: number): number {
  for (let j = start; j < text.length; j++) {
    if (text[j] === '\n') return 0;
    if (text[j] === '`' && !isEscaped(text, j)) {
      j = skipCodeSpanOrUnmatchedOpener(text, j) - 1;
      continue;
    }
    if (text[j] === '*' && !isEscaped(text, j)) {
      const runLen = asteriskRunLength(text, j);
      if (canCloseAsteriskRun(text, j, runLen)) return runLen;
      j += runLen - 1;
    }
  }
  return 0;
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

/** Bold open: left-flanking `**` run (punctuation-aware CommonMark flanking). */
function canOpenBold(text: string, i: number): boolean {
  if (isEscaped(text, i)) return false;
  if (!text.startsWith('**', i)) return false;
  const runLen = asteriskRunLength(text, i);
  if (runLen < 2) return false;
  return canOpenAsteriskRun(text, i, runLen);
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
  // closerAt is the first star of a right-flanking run (may be shared ***).
  {
    const closerRun = asteriskRunLength(text, closerAt);
    if (!canCloseAsteriskRun(text, closerAt, closerRun)) return false;
  }

  let k = from;
  while (k < closerAt) {
    if (text[k] === '`' && !isEscaped(text, k)) {
      // Matched span or unmatched opener run — never advance one tick at a time.
      k = Math.min(skipCodeSpanOrUnmatchedOpener(text, k), closerAt);
      continue;
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
      const openerCanBoth = canCloseAsteriskRun(text, k, 1);
      const close = findClosingAsteriskBounded(
        text,
        k + 1,
        closerAt,
        caches,
        0,
        1,
        openerCanBoth,
      );
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
  depth = 0,
  openerRunLen = 1,
  openerCanBoth = false,
): number {
  for (let j = start; j < bound; j++) {
    if (text[j] === '\n') return -1;
    if (text[j] === '`' && !isEscaped(text, j)) {
      // Matched span: skip it. Unmatched opener: consume whole run atomically.
      j = skipCodeSpanOrUnmatchedOpener(text, j) - 1;
      continue;
    }
    if (text.startsWith('**', j) && !isEscaped(text, j)) {
      // Transition `***…`: close italic on first star before skipBoldSpan.
      let runEnd = j;
      while (runEnd < text.length && text[runEnd] === '*') runEnd += 1;
      const runLen = runEnd - j;
      if (runLen >= 3 && j < bound && canCloseAsteriskRun(text, j, runLen)) {
        const closerCanBoth = canOpenAsteriskRun(text, j, runLen);
        if (
          !violatesRuleOfThree(openerRunLen, runLen, openerCanBoth, closerCanBoth)
        ) {
          return j;
        }
      }
      const after = skipBoldSpan(text, j, caches);
      if (after === -1) {
        // Unmatched **: first star may still close italic (`*important**`),
        // but not when rule of three blocks a both-flanking run (`*foo**bar*`).
        if (j < bound && canCloseAsteriskRun(text, j, runLen)) {
          const closerCanBoth = canOpenAsteriskRun(text, j, runLen);
          if (
            !violatesRuleOfThree(
              openerRunLen,
              runLen,
              openerCanBoth,
              closerCanBoth,
            )
          ) {
            return j;
          }
        }
        j = runEnd - 1;
        continue;
      }
      if (after > bound) return -1;
      j = after - 1;
      continue;
    }
    if (text[j] === '*' && !isEscaped(text, j)) {
      const runLen = asteriskRunLength(text, j);
      if (canCloseAsteriskRun(text, j, runLen)) {
        const closerCanBoth = canOpenAsteriskRun(text, j, runLen);
        if (
          !violatesRuleOfThree(openerRunLen, runLen, openerCanBoth, closerCanBoth)
        ) {
          return j;
        }
      }
      // Nested italic opener: skip complete span when an outer closer remains.
      if (runLen === 1 && canOpenAsterisk(text, j) && depth < MAX_ITALIC_NEST) {
        const nestedCanBoth = canCloseAsteriskRun(text, j, 1);
        const nestedClose = findClosingAsteriskBounded(
          text,
          j + 1,
          bound,
          caches,
          depth + 1,
          1,
          nestedCanBoth,
        );
        if (nestedClose !== -1) {
          const afterNested = nestedClose + 1;
          if (hasAsteriskCloserInBound(text, afterNested, bound)) {
            j = afterNested - 1;
          }
        }
      }
    }
  }
  return -1;
}


/** Max nested-strong probes inside findClosingBold (stack + pathological `**a ` streams). */
const MAX_BOLD_NEST = 32;

/** Max nested-italic probes inside findClosingAsterisk / findClosingUnderscore. */
const MAX_ITALIC_NEST = 32;

/**
 * True when `[start, EOF)` still contains a right-flanking `**` that could
 * close an outer bold (skips code spans; does not update closer caches).
 */
function hasBoldCloserAtOrAfter(text: string, start: number): boolean {
  for (let j = start; j < text.length - 1; j++) {
    if (text[j] === '\n') return false;
    if (text[j] === '`' && !isEscaped(text, j)) {
      // Matched span: skip it. Unmatched opener: consume whole run atomically.
      j = skipCodeSpanOrUnmatchedOpener(text, j) - 1;
      continue;
    }
    if (text.startsWith('**', j) && !isEscaped(text, j)) {
      const runLen = asteriskRunLength(text, j);
      if (runLen >= 2 && canCloseAsteriskRun(text, j, runLen)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * True when `[start, EOF)` still contains a right-flanking `*` that could
 * close an outer asterisk italic (skips code spans; does not update caches).
 */
function hasAsteriskCloserAtOrAfter(text: string, start: number): boolean {
  for (let j = start; j < text.length; j++) {
    if (text[j] === '\n') return false;
    if (text[j] === '`' && !isEscaped(text, j)) {
      j = skipCodeSpanOrUnmatchedOpener(text, j) - 1;
      continue;
    }
    if (text[j] === '*' && !isEscaped(text, j)) {
      const runLen = asteriskRunLength(text, j);
      if (canCloseAsteriskRun(text, j, runLen)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * True when `[start, bound)` contains a right-flanking `*` closer
 * (bounded probe; does not update caches).
 */
function hasAsteriskCloserInBound(
  text: string,
  start: number,
  bound: number,
): boolean {
  for (let j = start; j < bound; j++) {
    if (text[j] === '\n') return false;
    if (text[j] === '`' && !isEscaped(text, j)) {
      j = Math.min(skipCodeSpanOrUnmatchedOpener(text, j), bound) - 1;
      continue;
    }
    if (text[j] === '*' && !isEscaped(text, j)) {
      const runLen = asteriskRunLength(text, j);
      if (canCloseAsteriskRun(text, j, runLen)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Skip a valid flanked `*…*` italic span starting at `i`.
 * Returns index after close, or -1.
 */
function skipAsteriskItalicSpan(
  text: string,
  i: number,
  caches?: EmphasisCaches,
  depth = 0,
): number {
  if (text[i] !== '*' || text.startsWith('**', i)) return -1;
  if (!canOpenAsterisk(text, i)) return -1;
  const openerCanBoth = canCloseAsteriskRun(text, i, 1);
  const close = findClosingAsterisk(text, i + 1, caches, depth, 1, openerCanBoth);
  if (close === -1) return -1;
  return close + 1;
}

/**
 * True when `[start, EOF)` still contains a valid underscore italic closer
 * (skips code spans; does not update caches).
 */
function hasUnderscoreCloserAtOrAfter(text: string, start: number): boolean {
  for (let j = start; j < text.length; j++) {
    if (text[j] === '\n') return false;
    if (text[j] === '`' && !isEscaped(text, j)) {
      j = skipCodeSpanOrUnmatchedOpener(text, j) - 1;
      continue;
    }
    if (text[j] === '_' && !isEscaped(text, j)) {
      if (isWhitespace(text[j - 1])) continue;
      if (isIdentChar(text[j + 1])) continue;
      return true;
    }
  }
  return false;
}

/**
 * Skip a valid flanked `_…_` italic span starting at `i`.
 * Returns index after close, or -1.
 */
function skipUnderscoreItalicSpan(
  text: string,
  i: number,
  caches?: EmphasisCaches,
  depth = 0,
): number {
  if (text[i] !== '_') return -1;
  if (!canOpenUnderscore(text, i)) return -1;
  const close = findClosingUnderscore(text, i + 1, caches, depth);
  if (close === -1) return -1;
  return close + 1;
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
 * The memo is skipped when this search declined a closer a later opener
 * could still use (skipped nested span, or rule-of-three rejection).
 *
 * Rule of three: both-flanking opener/closer runs whose lengths sum to a
 * multiple of 3 must not match unless both lengths are multiples of 3.
 */
function findClosingBold(
  text: string,
  start: number,
  caches?: EmphasisCaches,
  depth = 0,
  openerRunLen = 2,
  openerCanBoth = false,
): number {
  const cache = caches?.bold;
  if (cache && start >= cache.noCloserFrom) return -1;
  // Only cache a failed-to-EOF miss when no later opener could use a closer
  // we declined (nested span we skipped, or rule-of-three rejection).
  let cacheSafe = true;

  // Skip remainder of the opening delimiter run (stars still belonging to opener).
  let j = start;
  const hadOpenerRemainder = j < text.length && text[j] === '*';
  while (j < text.length && text[j] === '*') j += 1;

  for (; j < text.length - 1; j++) {
    if (text[j] === '\n') return -1; // do not cache — line-local; closer may exist after
    if (text[j] === '`' && !isEscaped(text, j)) {
      // Delimiters inside a code span are not emphasis closers.
      // Unmatched opener: consume whole run so a shorter suffix cannot rematch.
      j = skipCodeSpanOrUnmatchedOpener(text, j) - 1;
      continue;
    }
    if (!text.startsWith('**', j)) continue;
    if (isEscaped(text, j)) continue;
    let runEnd = j;
    while (runEnd < text.length && text[runEnd] === '*') runEnd += 1;
    const runLen = runEnd - j;
    if (!canCloseAsteriskRun(text, j, runLen)) {
      // Not right-flanking (or both-flanking without trailing punct): may be a
      // left-flanking-only nested opener — skip a complete nested span only when
      // another closer still follows so we do not steal the sole closer
      // (`**foo **bar baz**`).
      if (canOpenBold(text, j) && depth < MAX_BOLD_NEST) {
        const afterNested = skipBoldSpan(text, j, caches, depth + 1);
        if (afterNested !== -1 && hasBoldCloserAtOrAfter(text, afterNested)) {
          // Nested span owns its closer; a later top-level opener may still
          // pair with it (`**a **b** ****` → unmatched outer + strong b).
          cacheSafe = false;
          j = afterNested - 1;
          continue;
        }
      }
      // Rejected run: skip atomically so a suffix cannot become artificially
      // right-flanking (`Use **BKB ****` must stay literal, not close mid-run).
      j = runEnd - 1;
      continue;
    }
    const closerCanBoth = canOpenAsteriskRun(text, j, runLen);
    if (
      violatesRuleOfThree(openerRunLen, runLen, openerCanBoth, closerCanBoth)
    ) {
      // Both-flanking opener+closer whose lengths sum to a multiple of 3
      // must not match unless both lengths are multiples of 3 (`a**b****c`).
      cacheSafe = false;
      j = runEnd - 1;
      continue;
    }
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
  // Exhausted to EOF with no closer. Only memoize when the miss is
  // opener-independent (no skipped nested closer, no rule-of-three reject).
  if (cache && cacheSafe && start < cache.noCloserFrom) cache.noCloserFrom = start;
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
  const openerRunLen = asteriskRunLength(text, i);
  const openerCanBoth = canCloseAsteriskRun(text, i, openerRunLen);
  const close = findClosingBold(
    text,
    i + 2,
    caches,
    depth,
    openerRunLen,
    openerCanBoth,
  );
  if (close === -1) return -1;
  return close + 2;
}

/** Asterisk open: left-flanking (punctuation-aware CommonMark flanking). */
function canOpenAsterisk(text: string, i: number): boolean {
  if (isEscaped(text, i)) return false;
  const runLen = asteriskRunLength(text, i);
  return canOpenAsteriskRun(text, i, runLen);
}

/**
 * Find closing `*` for emphasis. Must be right-flanking (not preceded by whitespace).
 * Skips nested `**bold**` so outer italic can wrap bold.
 * Skips complete nested `*…*` spans when another closer still follows
 * (`*outer *inner* tail*`), matching nested-bold skip.
 * Right-flanking unmatched `**` partitions so the first star can close italic
 * (`*important**` → em + literal `*`).
 *
 * Optional cache: failed-to-EOF from `start` makes later searches from >= start
 * return -1 without rescanning (avoids O(n²) unmatched `*a ` openers).
 * The memo is skipped when this search declined a closer a later opener
 * could still use (skipped nested span, or rule-of-three rejection).
 */
function findClosingAsterisk(
  text: string,
  start: number,
  caches?: EmphasisCaches,
  depth = 0,
  openerRunLen = 1,
  openerCanBoth = false,
): number {
  const cache = caches?.asterisk;
  if (cache && start >= cache.noCloserFrom) return -1;
  // Only cache a failed-to-EOF miss when no later opener could use a closer
  // we declined (nested span we skipped, or rule-of-three rejection).
  let cacheSafe = true;

  for (let j = start; j < text.length; j++) {
    if (text[j] === '\n') return -1; // do not cache — line-local
    if (text[j] === '`' && !isEscaped(text, j)) {
      // Delimiters inside a code span are not emphasis closers.
      // Unmatched opener: consume whole run so a shorter suffix cannot rematch.
      j = skipCodeSpanOrUnmatchedOpener(text, j) - 1;
      continue;
    }
    if (text.startsWith('**', j) && !isEscaped(text, j)) {
      // Transition run `***…` (e.g. `*italic***bold**`): first star closes
      // italic; remaining open bold. Partition before skipBoldSpan.
      let runEnd = j;
      while (runEnd < text.length && text[runEnd] === '*') runEnd += 1;
      const runLen = runEnd - j;
      if (runLen >= 3 && canCloseAsteriskRun(text, j, runLen)) {
        const closerCanBoth = canOpenAsteriskRun(text, j, runLen);
        if (
          !violatesRuleOfThree(openerRunLen, runLen, openerCanBoth, closerCanBoth)
        ) {
          return j;
        }
        // Both-flanking opener+closer whose lengths sum to a multiple of 3
        // must not match unless both lengths are multiples of 3.
        cacheSafe = false;
      }
      const after = skipBoldSpan(text, j, caches);
      if (after === -1) {
        // Unmatched **: first star may still close italic (`*important**`),
        // but rule of three blocks both-flanking internal `**` (`*foo**bar*`).
        if (canCloseAsteriskRun(text, j, runLen)) {
          const closerCanBoth = canOpenAsteriskRun(text, j, runLen);
          if (
            !violatesRuleOfThree(
              openerRunLen,
              runLen,
              openerCanBoth,
              closerCanBoth,
            )
          ) {
            return j;
          }
          cacheSafe = false;
        }
        // Not a valid italic closer: skip the whole run atomically.
        j = runEnd - 1;
        continue;
      }
      j = after - 1;
      continue;
    }
    if (text[j] === '*' && !isEscaped(text, j)) {
      const runLen = asteriskRunLength(text, j);
      if (canCloseAsteriskRun(text, j, runLen)) {
        const closerCanBoth = canOpenAsteriskRun(text, j, runLen);
        if (
          !violatesRuleOfThree(openerRunLen, runLen, openerCanBoth, closerCanBoth)
        ) {
          return j;
        }
        cacheSafe = false;
      }
      // Nested italic: left-flanking-only opener — skip complete span when
      // another closer still follows (`*outer *inner* tail*`).
      if (runLen === 1 && canOpenAsterisk(text, j) && depth < MAX_ITALIC_NEST) {
        const afterNested = skipAsteriskItalicSpan(text, j, caches, depth + 1);
        if (afterNested !== -1 && hasAsteriskCloserAtOrAfter(text, afterNested)) {
          // Nested span owns its closer; a later top-level opener may still
          // pair with it (`x*a *b* d**c` → unmatched outer + em b).
          cacheSafe = false;
          j = afterNested - 1;
        }
      }
    }
  }
  // Exhausted to EOF with no closer. Only memoize when the miss is
  // opener-independent (no skipped nested closer, no rule-of-three reject).
  if (cache && cacheSafe && start < cache.noCloserFrom) cache.noCloserFrom = start;
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
 * Skips complete nested `_…_` spans when another closer still follows
 * (`_outer _inner_ tail_`), matching nested asterisk italic skip.
 *
 * Optional cache: failed-to-EOF from `start` makes later searches from >= start
 * return -1 without rescanning (avoids O(n²) unmatched `_a ` openers).
 * The memo is skipped when this search declined a closer a later opener
 * could still use (skipped nested span).
 */
function findClosingUnderscore(
  text: string,
  start: number,
  caches?: EmphasisCaches,
  depth = 0,
): number {
  const cache = caches?.underscore;
  if (cache && start >= cache.noCloserFrom) return -1;
  // Only cache a failed-to-EOF miss when no later opener could use a closer
  // we declined (nested span we skipped).
  let cacheSafe = true;

  for (let j = start; j < text.length; j++) {
    if (text[j] === '\n') return -1; // do not cache — line-local
    if (text[j] === '`' && !isEscaped(text, j)) {
      // Delimiters inside a code span are not emphasis closers.
      // Unmatched opener: consume whole run so a shorter suffix cannot rematch.
      j = skipCodeSpanOrUnmatchedOpener(text, j) - 1;
      continue;
    }
    if (text[j] === '_') {
      if (isEscaped(text, j)) continue;
      if (isWhitespace(text[j - 1])) {
        // Nested underscore italic opener — skip complete span when outer closer remains.
        if (canOpenUnderscore(text, j) && depth < MAX_ITALIC_NEST) {
          const afterNested = skipUnderscoreItalicSpan(text, j, caches, depth + 1);
          if (afterNested !== -1 && hasUnderscoreCloserAtOrAfter(text, afterNested)) {
            // Nested span owns its closer; a later top-level opener may still pair.
            cacheSafe = false;
            j = afterNested - 1;
          }
        }
        continue; // not right-flanking
      }
      if (isIdentChar(text[j + 1])) continue; // ident-followed stays literal
      return j;
    }
  }
  // Exhausted to EOF with no closer. Only memoize when the miss is
  // opener-independent (no skipped nested closer).
  if (cache && cacheSafe && start < cache.noCloserFrom) cache.noCloserFrom = start;
  return -1;
}

/** Length of the asterisk run starting at `i` (`text[i]` is `*`). */
function asteriskRunLength(text: string, i: number): number {
  let n = 0;
  while (text[i + n] === '*') n += 1;
  return n;
}

/** Length of the underscore run starting at `i` (`text[i]` is `_`). */
function underscoreRunLength(text: string, i: number): number {
  let n = 0;
  while (text[i + n] === '_') n += 1;
  return n;
}

/**
 * CommonMark "rule of three": if either delimiter can both open and close,
 * and the sum of run lengths is a multiple of 3, they may not match unless
 * both lengths are multiples of 3. Blocks `*foo**bar*` from closing on `**`.
 */
function violatesRuleOfThree(
  openerLen: number,
  closerLen: number,
  openerCanBoth: boolean,
  closerCanBoth: boolean,
): boolean {
  if (!openerCanBoth && !closerCanBoth) return false;
  if ((openerLen + closerLen) % 3 !== 0) return false;
  if (openerLen % 3 === 0 && closerLen % 3 === 0) return false;
  return true;
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
 * During closer scans: skip a matched code span, or atomically consume an
 * unmatched opener run so a shorter backtick suffix cannot rematch
 * (same idea as parseInline's unmatched-opener fallback).
 * Returns the index after the skipped region.
 */
function skipCodeSpanOrUnmatchedOpener(text: string, i: number): number {
  const after = skipCodeSpan(text, i);
  if (after !== -1) return after;
  return i + backtickRunLength(text, i);
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

    // Triple+ asterisk runs: partition by closer order (CommonMark).
    // Two-star closer first (`***foo** bar*` / `***Warning:** buy BKB*`) →
    // italic-outer. One-star closer first (`***foo* bar**`) → fall through
    // to bold-outer so leftover `*` stays an inner italic opener.
    if (text[i] === '*' && !isEscaped(text, i)) {
      const runLen = asteriskRunLength(text, i);
      if (runLen >= 3 && canOpenAsterisk(text, i)) {
        const firstCloserLen = firstRightFlankingAsteriskRunLength(
          text,
          i + runLen,
        );
        if (firstCloserLen !== 1) {
          const openerCanBoth = canCloseAsteriskRun(text, i, runLen);
          const close = findClosingAsterisk(
            text,
            i + 1,
            caches,
            0,
            runLen,
            openerCanBoth,
          );
          if (close !== -1 && close > i + 1) {
            flushLiteral(i);
            const inner = text.slice(i + 1, close);
            nodes.push(createElement('em', { key: nextKey() }, ...parseInline(inner, nextKey, depth + 1)));
            i = close + 1;
            literalStart = i;
            continue;
          }
          // Incomplete triple opener (streaming): keep `***` literal — do not
          // fall back to bold on the first two stars (`Use ***Warning:**`).
          // Longer runs (****…) may still open bold below.
          if (runLen === 3) {
            i += runLen;
            continue;
          }
        }
      }
    }

    // Prefer `**bold**` over single `*`; opener must be left-flanking
    if (text.startsWith('**', i) && canOpenBold(text, i)) {
      const openerRunLen = asteriskRunLength(text, i);
      const openerCanBoth = canCloseAsteriskRun(text, i, openerRunLen);
      const close = findClosingBold(
        text,
        i + 2,
        caches,
        0,
        openerRunLen,
        openerCanBoth,
      );
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
      const openerCanBoth = canCloseAsteriskRun(text, i, 1);
      const close = findClosingAsterisk(
        text,
        i + 1,
        caches,
        0,
        1,
        openerCanBoth,
      );
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

    // Non-opening delimiter runs: advance past the COMPLETE run (not one char)
    // so long `****…` / `____…` streams stay linear (avoid O(n²) rescans).
    if (text[i] === '*' && !isEscaped(text, i)) {
      i += asteriskRunLength(text, i);
      continue;
    }
    if (text[i] === '_' && !isEscaped(text, i)) {
      i += underscoreRunLength(text, i);
      continue;
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
 * - Asterisk emphasis requires CommonMark flanking (whitespace + punctuation) so
 *   `damage * 1.5 * armor` and `damage*(crit)*armor` / `damage**(crit)**armor` stay literal.
 * - Nested spans keep delimiter context so `*after **BKB** expires*` → em>strong.
 * - Underscore boundaries are Unicode letter/number aware so `英雄_斧王_编号` stays intact.
 * - Longer asterisk runs partition by opener/closer context (`****x****`, `***x***`, asymmetric `***a** b*`).
 * - Incomplete triple openers stay literal while streaming (`Use ***Warning:**`); do not bold-fallback.
 * - Triple openers partition by closer order (`***foo* bar**` bold-outer; `***foo** bar*` italic-outer).
 * - Rejected asterisk runs in bold closer scans are skipped atomically (`Use **BKB ****`).
 * - Rule of three also applies to bold closers (`a**b****c` stays literal).
 * - Failed-to-EOF bold cache is not reused when a later opener can still pair (`**a **b** ****`).
 * - Failed-to-EOF italic cache is not reused after a nested skip or rule-of-three reject (`x*a *b* d**c`).
 * - Backslash-escaped delimiters stay literal; unmatched `**` openers are not retried as italic.
 * - Backtick code spans are protected from emphasis parsing (including inside underscore closers).
 * - Unmatched `**` / `*` / `_` openers cache failed closer scans so long streams stay linear-ish.
 * - Shared `***` closers partition by nesting (`**foo *bar***` → strong>em; `*foo **bar***` → em>strong).
 * - Nested strong skips complete inner `**…**` when an outer closer remains (`**foo **bar** baz**`).
 * - Nested italic skips complete inner `*…*` / `_…_` when an outer closer remains (`*outer *inner* tail*`).
 * - Right-flanking unmatched `**` partitions so italic can close on the first star (`*important**`).
 * - Rule of three: both-flanking internal `**` must not close a one-star opener (`*foo**bar*`).
 * - Transition `***` between italic and bold partitions before skipBoldSpan (`*italic***bold**`).
 * - Recursive inline parse is depth-capped (`MAX_INLINE_NEST`) so long `*`.repeat runs never stack-overflow.
 * - Unmatched multi-backtick openers consume the whole opener run as literal (no shorter rematch).
 * - Closer scans that skip code spans also consume unmatched backtick runs atomically.
 * - Non-opening `*` / `_` runs are consumed atomically (long star-only streams stay linear).
 */
export function renderInlineMarkdown(text: string): ReactNode[] {
  let key = 0;
  const nextKey = () => `i${key++}`;
  return parseInline(text, nextKey);
}
