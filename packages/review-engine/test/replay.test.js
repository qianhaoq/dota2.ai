import {renderTemplate} from '../src/phrasing/templates.js';
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildReview } from '../src/buildReview.js';
import { adaptReplayEvents, applyReplayArtifact, isVerifiedReplay } from '../src/replay.js';
import { parseSiteKnowledge } from '../src/siteKnowledge.js';
import { validateReview } from '../src/schema/validate.js';
const raw = {match_id:42,duration:1906,radiant_win:true,od_data:{has_parsed:false},players:[{hero_id:60,player_slot:132,deaths:1},{hero_id:2,player_slot:0,deaths:0}]};
const opts = {heroId:60,lang:'en',fetchedAt:'2026-11-11T00:00:00Z'};
const metadata = {demo_bytes:1000,demo_sha256:'a'.repeat(64),fetched_at:opts.fetchedAt};
const events = JSON.parse(readFileSync(new URL('./fixtures/replay-events.json',import.meta.url),'utf8'));
const artifact = () => adaptReplayEvents(raw,events,metadata);
describe('first-party replay evidence', () => {
  it('maps calibrated deaths, coordinates and purchases; omits unmeasured series', () => {
    const a = artifact(); const p = a.players[0];
    expect(p.deaths_log).toEqual([{time:72.5,key:'npc_dota_hero_axe',x:100,y:-200,source_path:'trace/events.jsonl[0]'}]);
    expect(p.purchase_log[0]).toMatchObject({time:125,key:'blink'});
    expect(p).not.toHaveProperty('gold_t'); expect(a).not.toHaveProperty('radiant_gold_adv');
    expect(a.players[1].kills_log).toHaveLength(1);
    expect(a.data_gaps.map(g=>g.topic)).toContain('lh_t');
  });
  it('requires verified bytes/hash, not scoreboard or URL', () => {
    expect(isVerifiedReplay({...artifact(),demo_sha256:null},42)).toBe(false);
    expect(isVerifiedReplay(artifact(),43)).toBe(false);
    const review = buildReview({...raw,replay_url:'https://replay1.valve.net/a',players:raw.players.map(p=>({...p,purchase_log:[{time:10,key:'blink'}],deaths_log:[{time:20}]}))},opts);
    expect(review.state).toBe('unparsed'); expect(review.deaths).toEqual([]); expect(review.purchases).toEqual([]);
    expect(review.insights[0].claim.text).toContain('score');
  });
  it('uses replay citations for timeline and OpenDota for scoreboard/duration', () => {
    const review = buildReview(applyReplayArtifact(raw,artifact()),opts);
    expect(review.match.parsed).toBe(true); expect(review.state).toBe('parsed');
    expect(review.facts['death.1']).toMatchObject({t:72.5,citation:'r1',source_path:'trace/events.jsonl[0]'});
    expect(review.facts['ancient.fell'].citation).toBe('s1');
    expect(review.insights.find(i=>i.id==='fix_this')).toMatchObject({status:'ok',fact_ids:['death.1'],time:{from:72.5,to:72.5},citations:['r1']});
    expect(review.citations.find(c=>c.provider==='replay')).toMatchObject({sha256:metadata.demo_sha256,fetched_at:metadata.fetched_at});
    expect(review.deaths[0]).toMatchObject({x:100,y:-200});
    expect(review.data_gaps.some(g=>g.topic==='death_locations')).toBe(false);
    expect(validateReview(review)).toMatchObject({ok:true});
  });
  it.each(['replay_expired','replay_cdn_error'])('keeps summary and gap for %s', status => {
    const review = buildReview(applyReplayArtifact(raw,{match_id:42,status}),opts);
    expect(review.state).toBe('unparsed'); expect(review.deaths).toEqual([]);
    expect(review.data_gaps).toContainEqual({topic:'parsed_evidence',reason:status});
    expect(review.parse.message).not.toContain('OpenDota is still parsing');
  });
  it('never attaches general Ace/support KB without explicit context; explicit selection stays contextual', () => {
    const kb = parseSiteKnowledge(JSON.parse(readFileSync(new URL('../../../data/site-knowledge.v1.json',import.meta.url),'utf8')));
    const review = buildReview(applyReplayArtifact(raw,artifact()),{...opts,kb});
    expect(review.citations.some(c=>c.provider==='kb')).toBe(false);
    const id = 'kb-04cd89756c8f746d6eb3eaf2';
    const selected = buildReview(applyReplayArtifact(raw,artifact()),{...opts,kb,kbContextIds:[id]});
    expect(selected.facts[`kb.${id}`].value).toMatchObject({match_assessment:'contextual_only',support_fact_ids:[],contradiction_fact_ids:[]});
  });
});

it('reproduces observed local Axe deaths without fabricating coordinates or purchases', () => {
  const observed = JSON.parse(readFileSync(new URL('./fixtures/replay-8985182860.redacted.json',import.meta.url),'utf8'));
  const match = {match_id:8985182860,players:[{hero_id:2,player_slot:129},{hero_id:54,player_slot:2}]};
  const a = adaptReplayEvents(match,observed,metadata);
  expect(a.players[0].deaths_log).toHaveLength(2);
  expect(a.players[0].deaths_log[0].time).toBe(observed[0].t);
  expect(a.players[0].deaths_log[0]).not.toHaveProperty('x');
  expect(a.players[0].purchase_log).toEqual([]);
});

it('rejects malformed successful artifacts without claiming replay_parsed', () => {
  const malformed = {...artifact(),players:[null]};
  expect(isVerifiedReplay(malformed,42)).toBe(false);
  const review = buildReview(applyReplayArtifact(raw,malformed),opts);
  expect(review.state).toBe('unparsed'); expect(review.parse.status).toBe('replay_failed');
});


it('answers verified individual deaths with fractional timestamps and unknown gold', () => {
  const review = buildReview(applyReplayArtifact(raw,artifact()),{...opts,presetFollowups:true});
  const followup = review.followups.find(f=>f.id==='death_list');
  expect(followup.answerable).toBe(true);
  expect(renderTemplate(followup,review.facts,'en').text).toContain('1:12');
  expect(renderTemplate(followup,review.facts,'en').text).toContain('unknown');
});
