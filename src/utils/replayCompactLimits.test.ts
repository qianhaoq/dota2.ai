import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Small shared caps exercise the real streaming readers without huge fixtures.
vi.mock('../../lib/matchReview/replayIngest/capacity.js', () => ({
  REPLAY_MAX_STATES_BYTES:64, REPLAY_MAX_EVENT_BYTES:128,
  REPLAY_MAX_RETAINED_EVENTS:2, REPLAY_MAX_METADATA_BYTES:32,
}));
import { readReviewEvents, readReplaySupplement } from '../../lib/matchReview/replayIngest/extractor.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir,{recursive:true,force:true}))); });
async function traceDir() {
  const dir = await mkdtemp(join(tmpdir(),'compact-limits-')); dirs.push(dir); return dir;
}
it('uses the shared event byte and retained-count limits independently', async () => {
  const dir = await traceDir(), path = join(dir,'events.jsonl');
  const event = JSON.stringify({type:'DOTA_COMBATLOG_DEATH'});
  await writeFile(path,[event,event].join('\n'));
  expect((await readReviewEvents(path)).events).toHaveLength(2);
  await writeFile(path,[event,event,event].join('\n'));
  await expect(readReviewEvents(path)).rejects.toThrow('event_limit');
  await writeFile(path,JSON.stringify({type:'ignored',padding:'x'.repeat(128)}));
  await expect(readReviewEvents(path)).rejects.toThrow('event_bytes_limit');
});
it('uses the shared states and metadata byte limits', async () => {
  const dir = await traceDir();
  await writeFile(join(dir,'states.jsonl'),'{}');
  expect(await readReplaySupplement(dir,[])).toEqual({metadata:null,positions:[],heroStates:null});
  await writeFile(join(dir,'states.jsonl'),JSON.stringify({padding:'x'.repeat(64)}));
  await expect(readReplaySupplement(dir,[])).rejects.toThrow('states_bytes_limit');
  await writeFile(join(dir,'metadata.json'),JSON.stringify({padding:'x'.repeat(32)}));
  await expect(readReplaySupplement(dir,[])).rejects.toThrow('metadata_bytes_limit');
});
