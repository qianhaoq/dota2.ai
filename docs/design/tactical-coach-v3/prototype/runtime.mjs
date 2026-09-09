/** Internal Dota coaching-domain contract. NOT an official A2UI wire renderer. */
export const COMPONENTS = Object.freeze(['CoachBrief','TacticalMap','DraftBoard','ItemTradeoff','DecisionFork','TrainingDrill','EvidenceLens','KnowledgeLens','PracticeCommit']);
export const ACTIONS = Object.freeze(['answer','compare','inspect','save','selectHero','annotate','retry']);
export function createState(contextId='demo-teamfight-01') {
  return { contextId, contextRevision:0, runId:0, busy:false, surfaces:{}, seenEventIds:[], answers:{}, notes:[] };
}
export function beginRun(state) { return {...state, runId:state.runId+1, busy:true}; }
export function stopRun(state) { return {...state, runId:state.runId+1, busy:false}; }
export function switchContext(state, contextId) {
  if (!contextId || contextId===state.contextId) return state;
  return {...createState(contextId), contextRevision:state.contextRevision+1, runId:state.runId+1, notes:state.notes};
}
export function validSurface(s) {
  return Boolean(s && typeof s.id==='string' && s.id.length>0 && s.id.length<=80 && !['__proto__','constructor','prototype'].includes(s.id)
    && COMPONENTS.includes(s.component) && Number.isInteger(s.revision) && s.revision>0
    && ['demo','diagram','nonspatial'].includes(s.presentation)
    && typeof s.title==='string' && s.title.length<=400
    && Object.keys(s).every(k=>['id','component','revision','presentation','title'].includes(k)));
}
export function applyPatch(state, patch) {
  if (!state.busy || !patch || patch.contextId!==state.contextId || patch.contextRevision!==state.contextRevision || patch.runId!==state.runId || !validSurface(patch.surface)) return state;
  const old=state.surfaces[patch.surface.id];
  if (patch.surface.revision !== (old?.revision ?? 0)+1) return state;
  return {...state, surfaces:{...state.surfaces,[patch.surface.id]:{...patch.surface}}};
}
export function finishRun(state, runId) { return state.runId===runId ? {...state,busy:false} : state; }
export function answerEvent(state, event) {
  if (!event || !ACTIONS.includes(event.action) || typeof event.id!=='string' || event.id.length>100 || state.seenEventIds.includes(event.id)
    || event.contextId!==state.contextId || event.contextRevision!==state.contextRevision || event.action!=='answer'
    || !['seen','unseen','unknown'].includes(event.value)) return state;
  return {...state, seenEventIds:[...state.seenEventIds,event.id].slice(-100), answers:{...state.answers,visibility:{value:event.value,authority:'user_report'}}};
}
export function saveNote(state, note) {
  if (!note || typeof note.key!=='string' || !note.key || typeof note.title!=='string' || typeof note.trigger!=='string' || typeof note.action!=='string' || typeof note.check!=='string') return state;
  if (state.notes.some(n=>n.key===note.key)) return state;
  return {...state,notes:[...state.notes,{key:note.key.slice(0,160),title:note.title.slice(0,200),trigger:note.trigger.slice(0,500),action:note.action.slice(0,500),check:note.check.slice(0,500),contextId:state.contextId,authority:'demo',done:false}]};
}
export function restoreNotes(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0,100).filter(n=>n && typeof n.key==='string' && typeof n.title==='string' && typeof n.trigger==='string' && typeof n.action==='string' && typeof n.check==='string' && n.authority==='demo').map(n=>({key:n.key.slice(0,160),title:n.title.slice(0,200),trigger:n.trigger.slice(0,500),action:n.action.slice(0,500),check:n.check.slice(0,500),contextId:String(n.contextId||'demo').slice(0,160),authority:'demo',done:n.done===true}));
}
export function parseMatchId(value) {
  if (typeof value!=='string') return null;
  const raw=value.trim();
  if (/^[1-9]\d{5,11}$/.test(raw)) { const n=Number(raw); return Number.isSafeInteger(n)?n:null; }
  try { const u=new URL(raw); if (u.protocol!=='https:' || !['www.opendota.com','opendota.com','www.dotabuff.com','dotabuff.com'].includes(u.hostname)) return null;
    const m=u.pathname.match(/^\/matches\/([1-9]\d{5,11})\/?$/); return m?Number(m[1]):null;
  } catch {return null;}
}
export function assignHero(draft, side, slot, hero) {
  if (!['radiant','dire'].includes(side) || !Number.isInteger(slot) || slot<0 || slot>4 || !Number.isInteger(hero)) return draft;
  if (['radiant','dire'].some(s=>draft[s].some((h,i)=>h===hero && !(s===side && i===slot)))) return draft;
  const next={radiant:[...draft.radiant],dire:[...draft.dire]}; next[side][slot]=hero; return next;
}
/** Existing MatchFact has no time-indexed coordinates/vision. Never synthesize them. */
export function reviewCapabilities(fact) {
  return { roster:Boolean(fact && Array.isArray(fact.players) && fact.players.length), timeline:Boolean(fact && Array.isArray(fact.timeline) && fact.timeline.length), tacticalMap:false, vision:false, replayPlayback:false };
}
