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
    if (line.startsWith('**') && line.endsWith('**') && line.length >= 4) {
      segments.push({ type: 'strong', text: line.slice(2, -2) });
      continue;
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
