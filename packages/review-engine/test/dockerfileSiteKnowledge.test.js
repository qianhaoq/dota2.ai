import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const dockerfile = readFileSync(new URL('../../../Dockerfile', import.meta.url), 'utf8');
const production = dockerfile.split(/^FROM\s+\S+\s+AS\s+production\s*$/im)[1]?.split(/^FROM\s/im)[0];

it('ships the explicit public site knowledge snapshot in the production stage', () => {
  expect(production).toBeDefined();
  expect(production).toMatch(/^COPY\s+--from=builder\s+\/app\/data\/site-knowledge\.v1\.json\s+\.\/data\/site-knowledge\.v1\.json\s*$/m);
});

it('ships only the reviewed compact replay facts with ingest disabled', () => {
  expect(production).toMatch(/^COPY\s+--from=builder\s+\/app\/data\/replay-facts\/9080127650\.json\s+\.\/data\/replay-facts\/9080127650\.json\s*$/m);
  expect(production).toMatch(/^ENV REPLAY_HOME=\/app\/data\/replay-facts\s*$/m);
  expect(dockerfile).not.toMatch(/^\s*(?:ENV|ARG)\s+.*(?:REPLAY_INGEST_ENABLED|DOTA_EXTRACT_BIN|COACH_EXTRACT_BIN)/m);
});

it('does not copy broad data directories or private artifacts into production', () => {
  expect(production).toBeDefined();
  const copies = production.replace(/\\\r?\n/g, ' ').split('\n')
    .filter(line => /^\s*(?:COPY|ADD)\s/i.test(line));
  expect(copies.length).toBeGreaterThan(0);
  for (const copy of copies) {
    // Inspect sources, excluding flags and the destination. Broad context copies
    // could include private files even without naming them explicitly.
    const tokens = copy.trim().split(/\s+/).slice(1).filter(token => !token.startsWith('--'));
    const sources = tokens.slice(0, -1);
    for (const source of sources) {
      // Exact reviewed public exception; all other replay paths remain forbidden.
      if (source === '/app/data/replay-facts/9080127650.json') continue;
      expect(source).not.toMatch(/(?:transcripts?|replays?|cookies?|private|\.db(?:$|\.)|\.sqlite)/i);
      if (/(?:^|\/)data(?:\/|$)/.test(source)) {
        expect(source).toBe('/app/data/site-knowledge.v1.json');
      }
      if (source !== 'package*.json') {
        expect(source).not.toMatch(/^(?:\.?\/?|\/app\/?)$|[*?\[\]{}]/);
      }
    }
  }
});
