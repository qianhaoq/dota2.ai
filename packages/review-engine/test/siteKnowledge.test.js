import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { buildReview, validateReview } from '../src/index.js';
import { parseSiteKnowledge } from '../src/siteKnowledge.js';
const snapshot = JSON.parse(readFileSync(new URL('./fixtures/site-knowledge.json', import.meta.url)));
const raw = JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/gold/9035042364.json.gz', import.meta.url))));
const opts = {heroId:14,lang:'en',fetchedAt:'2026-11-05T00:00:00Z'};

it('adds selected learning citations without changing match conclusions or the Review v1 contract', () => {
  const before = JSON.stringify(raw), selected = parseSiteKnowledge(snapshot);
  const review = buildReview(raw,{...opts,kb:selected});
  expect(validateReview(review)).toEqual({ok:true,errors:[]});
  expect(review.insights.map(i=>i.claim)).toEqual(buildReview(raw,opts).insights.map(i=>i.claim));
  expect(review.citations.find(c=>c.provider==='kb')).toMatchObject({url:snapshot.entries[0].source_url,source_date:snapshot.entries[0].source_date});
  expect(review.insights.find(i=>i.id==='next_game').citations).toContain('kb:kb-aaaaaaaaaaaaaaaaaaaaaaaa');
  expect(review.data_gaps.some(g=>g.topic==='build_vs_lineup')).toBe(true);
  expect(JSON.stringify(raw)).toBe(before);
  expect(selected).toEqual(snapshot.entries);
});
it('excludes unknown or mismatched patch facts, foreign heroes and unparsed matches', () => {
  const entry = snapshot.entries[0];
  const kb = [{...entry,kind:'fact',patch:'different'},{...entry,hero:'axe'}];
  expect(buildReview(raw,{...opts,kb}).citations.filter(c=>c.provider==='kb')).toEqual([]);
  expect(buildReview(raw,{...opts,heroId:undefined,kb:[entry]}).citations.filter(c=>c.provider==='kb')).toEqual([]);
  expect(buildReview({...raw,od_data:{has_parsed:false}},{...opts,kb:[entry]}).citations.filter(c=>c.provider==='kb')).toEqual([]);
  const matched = {...entry,kind:'fact',patch:String(raw.patch)};
  expect(buildReview(raw,{...opts,kb:[matched]}).citations.filter(c=>c.provider==='kb')).toHaveLength(1);
});
it('rejects private fields, unsupported versions, unsafe sources and duplicate public IDs', () => {
  const invalid = [
    {...snapshot,schema:'future'},
    {...snapshot,entries:[{...snapshot.entries[0],source_record_id:'private'}]},
    {...snapshot,entries:[{...snapshot.entries[0],source_url:'https://www.youtube.com/watch?v=abcdefghijk&token=private'}]},
    {...snapshot,entries:[{...snapshot.entries[0],source_url:'javascript:alert(1)'}]},
    {...snapshot,entries:[snapshot.entries[0],snapshot.entries[0]]},
  ];
  for (const value of invalid) expect(()=>parseSiteKnowledge(value)).toThrow('Invalid public site knowledge');
});
