import {heroSlug} from '../../../packages/review-engine/src/facts/index.js';
export function verifyNewArtifact(raw,artifact){
 if(artifact.extractor_match_id!==raw.match_id||artifact.trace_version!==4||artifact.clock?.unit!=='seconds'||artifact.clock?.zero!=='horn_game_start'||artifact.clock?.name!=='server_tick_pause_adjusted'||!Number.isFinite(artifact.clock?.tick_interval)||artifact.clock.tick_interval<=0||!Number.isFinite(artifact.clock?.game_start_time))throw new Error('invalid');
 for(const p of raw.players??[]){const found=artifact.players?.find(a=>a.player_slot===p.player_slot);if(!found||found.hero_id!==p.hero_id||found.extractor_hero_key!==`npc_dota_hero_${heroSlug(p.hero_id)}`)throw new Error('invalid');}
 const fort=artifact.objectives?.find(o=>/fort$/.test(o.key??''));
 const delta=fort&&Number.isFinite(raw.duration)?Math.abs(fort.time-raw.duration):Infinity;
 return {...artifact,timed_review:delta<=5?'full':'partial',...(delta>5?{data_gaps:[...(artifact.data_gaps??[]),{topic:'match_clock',reason:'fort_duration_needs_verification'}]}:{})};
}
