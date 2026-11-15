import {renderTemplate} from '../src/phrasing/templates.js';
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildReview } from '../src/buildReview.js';
import { adaptReplayEvents, applyReplayArtifact, isVerifiedReplay } from '../src/replay.js';
import { parseSiteKnowledge } from '../src/siteKnowledge.js';
import { validateReview } from '../src/schema/validate.js';
import { clock, buildMoments } from '../src/insights/moments.js';
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
    expect(review.insights.find(i=>i.id==='death.1')).toMatchObject({status:'ok',fact_ids:['death.1'],time:{from:72.5,to:72.5},citations:['r1']});
    expect(review.citations.find(c=>c.provider==='replay')).toMatchObject({sha256:metadata.demo_sha256,fetched_at:metadata.fetched_at});
    expect(review.deaths[0]).toMatchObject({x:100,y:-200});
    expect(review.data_gaps.some(g=>g.topic==='death_locations')).toBe(false);
    expect(validateReview(review)).toMatchObject({ok:true});
  });
  it.each(['replay_expired','replay_store_error','replay_cdn_error'])('keeps summary and gap for %s', status => {
    const review = buildReview(applyReplayArtifact(raw,{match_id:42,status}),opts);
    expect(review.state).toBe('unparsed'); expect(review.deaths).toEqual([]);
    expect(review.data_gaps).toContainEqual({topic:'parsed_evidence',reason:status});
    expect(review.parse.message).not.toContain('OpenDota is still parsing');
  });
  it('never attaches unrelated principles to a replay moment, even with explicit context', () => {
    const kb = parseSiteKnowledge(JSON.parse(readFileSync(new URL('../../../data/site-knowledge.v1.json',import.meta.url),'utf8')));
    const review = buildReview(applyReplayArtifact(raw,artifact()),{...opts,kb});
    expect(review.citations.some(c=>c.provider==='kb')).toBe(false);
    const id = 'kb-04cd89756c8f746d6eb3eaf2';
    const selected = buildReview(applyReplayArtifact(raw,artifact()),{...opts,kb,kbContextIds:[id]});
    expect(selected.facts[`kb.${id}`]).toBeUndefined();
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

it('labels metadata snapshots, truncated graphs and bounded sampled positions without attributing PLAYERSTATS', () => {
  const match = {match_id:42,duration:180,players:Array.from({length:10},(_,i)=>({hero_id:i===0?2:60+i,player_slot:i<5?i:128+i-5}))};
  const meta = {players:match.players.map(p=>({player_slot:p.player_slot,graph_net_worth:[60,200],camps_stacked:9,inventory_snapshots:[{game_time:599,last_hits:99},{game_time:600,last_hits:48,denies:1}]}))};
  const death = {type:'DOTA_COMBATLOG_DEATH',t:72,target:'npc_dota_hero_axe',target_hero:true,target_illusion:false,trace_index:0};
  const purchase = {type:'DOTA_COMBATLOG_PURCHASE',t:322.3,target:'npc_dota_hero_axe',value_name:'item_soul_ring'};
  const samples = [{death_source_path:'trace/events.jsonl[0]',t:72.2,x:1,y:2,source_path:'trace/states.jsonl[4]'}];
  const a = adaptReplayEvents(match,[death,purchase,{type:'DOTA_COMBATLOG_PLAYERSTATS',t:600,target:'fountain',last_hits:999}],metadata,meta,samples);
  expect(a.players[0].purchase_log[0]).toMatchObject({time:322.3,key:'soul_ring',source_path:'trace/events.jsonl[1]'});
  expect(a.players[0].lh_t[10]).toBe(48);
  expect(a.players[0].net_worth_source).toBe('demo_metadata_graph_net_worth');
  expect(a.radiant_gold_adv).toBeUndefined();
  expect(a.radiant_net_worth_adv).toEqual([0,0]);
  expect(a.players[0].net_worth_t).toEqual([600,2000]);
  expect(a.data_gaps).toContainEqual({topic:'radiant_net_worth_adv',reason:'metadata_graph_truncated'});
  expect(a.players[0].deaths_log[0]).toMatchObject({position_source:'state_sample',sample_t:72.2});
  samples[0].t = 72.251;
  expect(adaptReplayEvents(match,[death],metadata,meta,samples).players[0].deaths_log[0]).not.toHaveProperty('x');
});

it('does not attach stacking material to an unrelated death, even with observed stacking', () => {
  const kb = parseSiteKnowledge(JSON.parse(readFileSync(new URL('../../../data/site-knowledge.v1.json',import.meta.url),'utf8')));
  const id = 'kb-028d66b81456e3720aaea63a';
  const a = adaptReplayEvents(raw,events,metadata,{players:[{player_slot:132,camps_stacked:9}]});
  const review = buildReview(applyReplayArtifact(raw,a),{...opts,kb});
  expect(review.facts.camps_stacked.value).toBe(9);
  expect(review.facts['kb.'+id]).toBeUndefined();
  a.players[0].camps_stacked=0;
  const zero = buildReview(applyReplayArtifact(raw,a),{...opts,kb,kbContextIds:[id]});
  expect(zero.facts.camps_stacked.value).toBe(0);
  expect(zero.facts['kb.'+id]).toBeUndefined();
});

it('preserves the observed compact comparison-demo economy contract', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/replay-economy-8985182860.redacted.json',import.meta.url),'utf8'));
  const match = {match_id:fixture.match_id,duration:3150,players:[{hero_id:42,player_slot:0}]};
  const a = adaptReplayEvents(match,fixture.events,metadata,fixture.metadata);
  expect(a.players[0].lh_t[10]).toBe(56);
  expect(a.players[0].lh_t[9]).toBeUndefined();
  expect(a.players[0].net_worth_t).toHaveLength(51);
  expect(a.players[0].net_worth_t[0]).toBe(600);
  expect(a.players[0].net_worth_t.at(-1)).toBeCloseTo(29516,0);
  expect(a.players[0]).not.toHaveProperty('gold_t');
  expect(a).not.toHaveProperty('radiant_gold_adv');
  expect(a.players[0].snapshot_source).toBe('demo_metadata_inventory_snapshot');
  expect(a.objectives[0].key).toBe('npc_dota_badguys_tower1_top');
  expect(a.objectives[0]).not.toHaveProperty('killer');
});

it('accepts barracks and filler building events, never their value_name as killer', () => {
  const events = ['npc_dota_goodguys_melee_rax_mid','npc_dota_goodguys_fillers','npc_dota_badguys_fort','npc_dota_hero_axe'].map(target=>({target,type:'DOTA_COMBATLOG_TEAM_BUILDING_KILL',t:100,value_name:'npc_dota_hero_axe'}));
  const a = adaptReplayEvents(raw,events,metadata);
  expect(a.objectives).toHaveLength(3);
  expect(a.objectives.every(o=>!Object.hasOwn(o,'killer'))).toBe(true);
});

it('keeps earned gold distinct, refuses unverified units, and cites replay followups', () => {
  // Comparison dem at 10m: OpenDota earned advantage 975 != metadata net-worth advantage 612.
  // Axe earned gold 3117 != rounded metadata net worth 3459.
  const match = {...raw,duration:1800,radiant_gold_adv:[975],players:raw.players.map(p=>({...p,gold_t:Array(21).fill(3117)}))};
  const meta = {players:match.players.map(p=>({player_slot:p.player_slot,graph_net_worth:Array.from({length:21},(_,i)=>i===0?60:i===10?345.87186:775.3609),inventory_snapshots:[{game_time:600,last_hits:48},{game_time:1200,last_hits:100}]}))};
  const a = adaptReplayEvents(match,events,metadata,meta);
  const applied = applyReplayArtifact(match,a);
  expect(applied.radiant_gold_adv).toEqual([]);
  expect(applied.players[0].gold_t).toBeUndefined();
  expect(applied.players[0].net_worth_t[10]).toBe(3459);
  const review = buildReview(applied,{...opts,presetFollowups:true});
  expect(review.facts['farm.10_20.gold_t']).toBeUndefined();
  expect(review.facts['farm.10_20.net_worth_t']).toMatchObject({citation:'r1',unit:'gold (net worth)'});
  expect(review.facts['farm.10_20.net_worth_t'].source_path).toContain('graph_net_worth');
  expect(review.facts['farm.10_20.lh_t'].citation).toBe('r1');
  expect(review.insights.some(i=>['turning_point','fix_this','next_game'].includes(i.id))).toBe(false);
  expect(review.facts['net_worth.at.0']).toMatchObject({value:600,citation:'r1'});
  expect(validateReview(review)).toMatchObject({ok:true});
  meta.players[0].graph_net_worth[0]=100;
  const unverified = adaptReplayEvents(match,[],metadata,meta);
  expect(unverified.players[0].net_worth_t).toBeUndefined();
  expect(unverified.data_gaps).toContainEqual({topic:'net_worth_t',reason:'metadata_graph_unit_unverified'});
});


it('pins the comparison-dem earned-gold vs net-worth difference and rejects legacy mislabeled artifacts', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/replay-economy-semantics-8985182860.json',import.meta.url),'utf8'));
  const match = {match_id:fixture.match_id,duration:1200,players:fixture.players.map(p=>({player_slot:p.player_slot,hero_id:2}))};
  const demoMetadata = {players:fixture.players.map(p=>({player_slot:p.player_slot,graph_net_worth:Array.from({length:11},(_,i)=>i===0?p.graph_start:p.graph_at_10)}))};
  const a = adaptReplayEvents(match,[],metadata,demoMetadata);
  expect(a.radiant_net_worth_adv[10]).toBe(fixture.net_worth_adv_at_10);
  expect(a.radiant_net_worth_adv[10]).not.toBe(fixture.earned_gold_adv_at_10);
  expect(a.players.find(p=>p.player_slot===129).net_worth_t[10]).toBe(fixture.axe_net_worth_at_10);
  expect(a.players.find(p=>p.player_slot===129).net_worth_t[10]).not.toBe(fixture.axe_earned_gold_at_10);
  expect(a.radiant_gold_adv).toBeUndefined();
  const legacy = {...artifact(),gold_source:'demo_metadata_graph_net_worth',radiant_gold_adv:[60]};
  expect(isVerifiedReplay(legacy,42)).toBe(false);
  expect(buildReview(applyReplayArtifact(raw,legacy),opts).parse.status).toBe('replay_failed');
});
it('does not attribute illusion kills to the illusion hero, but keeps non-hero killers', () => {
  const match = {match_id:42,duration:100,players:[{hero_id:60,player_slot:132},{hero_id:109,player_slot:0}]};
  const illusion = adaptReplayEvents(match,[{t:10,type:'DOTA_COMBATLOG_DEATH',target:'npc_dota_hero_night_stalker',target_hero:true,target_illusion:false,attacker:'npc_dota_hero_terrorblade',attacker_hero:true,attacker_illusion:true}],metadata);
  expect(illusion.players[0].deaths_log[0].key).toBeNull();
  expect(illusion.players[1].kills_log).toEqual([]);
  const tower = adaptReplayEvents(match,[{t:11,type:'DOTA_COMBATLOG_DEATH',target:'npc_dota_hero_night_stalker',target_hero:true,target_illusion:false,attacker:'npc_dota_goodguys_tower1_mid',attacker_hero:false,attacker_illusion:false}],metadata);
  expect(tower.players[0].deaths_log[0].key).toBe('npc_dota_goodguys_tower1_mid');
});

it('humanizes replay building kills instead of leaking the combat-log type', () => {
  const a = adaptReplayEvents(raw,[{t:100,type:'DOTA_COMBATLOG_TEAM_BUILDING_KILL',target:'npc_dota_badguys_tower1_mid',attacker_team:2}],metadata);
  const review = buildReview(applyReplayArtifact(raw,a),opts);
  const displays = Object.values(review.facts).filter(f => String(f.id).startsWith('obj.')).map(f => `${f.display.en} ${f.display.zh}`);
  expect(displays.join(' ')).not.toMatch(/DOTA_COMBATLOG_|npc_dota_/);
  expect(displays.join(' ')).toMatch(/tower|Tower|塔/i);
});

it('keeps purchases in the list and excludes unlinked item uses from insights', () => {
  const a = adaptReplayEvents(raw,[{t:80,type:'DOTA_COMBATLOG_ITEM',attacker:'npc_dota_hero_night_stalker',attacker_hero:true,attacker_illusion:false,inflictor:'item_tpscroll'},{t:125,type:'DOTA_COMBATLOG_PURCHASE',target:'npc_dota_hero_night_stalker',value_name:'item_blink'}],metadata);
  const review = buildReview(applyReplayArtifact(raw,a),{...opts,presetFollowups:true});
  expect(review.insights).toEqual([]);
  expect(review.purchases).toContainEqual({t:125,item:'blink',key_item:true});
});

it('allows an empty official replay timeline without a filler card', () => {
 const a=adaptReplayEvents({...raw,duration:1906},[],metadata);
 const review=buildReview(applyReplayArtifact({...raw,od_data:{has_parsed:true}},a),opts);
 expect(review.insights).toEqual([]);
 expect(validateReview(review)).toEqual({ok:true,errors:[]});
});

it('formats pre-horn clocks without doubled minus signs', () => {
  expect(clock(-30)).toBe('-0:30');
  expect(clock(-90)).toBe('-1:30');
  expect(clock(125)).toBe('2:05');
});

it('keeps immunity windows separate and never appends a later death', () => {
 const result={deaths:[{t:200,fact_id:'death.1',inflictor:null}],facts:{'death.1':{id:'death.1',citation:'r1',t:200}}};
 const moments=buildMoments(result,{item_use_log:[{key:'black_king_bar',t:80,ended_at:90,end_source_path:'modifier.1'},{key:'black_king_bar',t:110,ended_at:120,end_source_path:'modifier.2'}]},'en');
 expect(moments.map(m=>m.time)).toEqual([{from:80,to:90},{from:110,to:120}]);
 expect(moments.flatMap(m=>m.fact_ids)).not.toContain('death.1');
});
