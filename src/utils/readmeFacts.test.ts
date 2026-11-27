import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { reviewToolkit } from '../../lib/agent/review/toolkit.js';
import { linkHeroNames } from '../../packages/review-engine/src/trace/build.js';
import { parseCoachArgs } from '../../packages/cli/src/coach.js';

/**
 * The READMEs state facts about the code that went stale twice (#418: 28 tools when there were 30, a CLI
 * language it does not take). They are read here against the code, so a change to either is seen.
 */
const trace = linkHeroNames(JSON.parse(gunzipSync(readFileSync(new URL('../../packages/review-engine/test/fixtures/trace-9100904020.json.gz', import.meta.url))).toString()));
const tools: string[] = reviewToolkit({ trace, hero: 'beastmaster', lang: 'en' })!.tools.map((t: any) => t.name ?? t.function?.name).sort();
const read = (f: string) => readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');

describe.each(['README.md', 'README.zh-CN.md'])('%s says what the code does', (file) => {
  const text = read(file);

  it('lists exactly the review agent\'s tools, and counts them right', () => {
    const table = text.slice(text.indexOf('<details>'), text.indexOf('</details>'));
    const listed = [...table.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]).sort();
    expect(listed).toEqual(tools);
    expect(text).toContain(file === 'README.md' ? `${tools.length} lookup tools` : `${tools.length} 个查询工具`);
  });

  it('gives the CLI only the languages it takes', () => {
    // Every list of languages it states for --lang ("--lang en|zh"), not one example of a single language.
    const claimed = [...new Set([...text.matchAll(/--lang ([a-z]+(?:\|[a-z]+)+)/g)].flatMap((m) => m[1].split('|')))];
    expect(claimed.length).toBeGreaterThan(0);
    // The CLI's own parser, as `dota2ai coach <match> --lang <lang>` runs it (no network).
    for (const lang of claimed) expect(() => parseCoachArgs(['coach', '9091400302', '--lang', lang]), `--lang ${lang}`).not.toThrow();
  });
});
