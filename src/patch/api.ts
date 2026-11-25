/** Client for the patch advisor (lib/patch/router.js). */
import { readChatStream, type ChatEvents, type ChatTurn } from '../agent/api';

/** One hero in a list of movers: public win rate and pick rate before and since the patch (shares, not percent). */
export interface MoverRow {
  hero: string; name: string;
  win_rate_before: number | null; win_rate_after: number | null; win_rate_change_in_points: number | null;
  pick_rate_before: number; pick_rate_after: number; pick_rate_times: number | null;
}
export interface Window { from: string; to: string; days: number }
/** The patch at a glance (the patch_overview record of lib/patch/tools.js). */
export interface PatchOverview {
  /** The newest release (7.42a); `major_patch` the patch it updates; `releases` every release whose notes are in, oldest first. */
  patch: string; major_patch?: string; released: string; notes: string;
  releases?: { version: string; released: string; url: string }[];
  heroes_changed: number; items_changed: number; neutral_items_changed: number;
  /** `numbers_patch`: the patch the windows are around (the STRATZ snapshot's); older than `major_patch` until it is refreshed. */
  numbers: { source: string; bracket: string; numbers_patch?: string; before_the_patch: Window; since_the_patch: Window; matches: { before_the_patch: number; since_the_patch: number } };
  win_rate_rose_most: MoverRow[]; win_rate_fell_most: MoverRow[]; pick_rate_rose_most: MoverRow[]; pick_rate_fell_most: MoverRow[];
  /** Whether the server has a model to answer questions with. */
  advisor: boolean;
}

export const fetchPatchOverview = async (lang: string, signal?: AbortSignal): Promise<PatchOverview> => {
  const res = await fetch(`/api/patch?lang=${lang}`, { signal });
  if (!res.ok) throw new Error(`patch overview ${res.status}`);
  return res.json();
};

/** One question to the advisor over SSE. */
export async function askAdvisor(body: { lang: string; question: string; history: ChatTurn[] }, ev: ChatEvents, signal?: AbortSignal): Promise<void> {
  const res = await fetch('/api/patch/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  return readChatStream(res, ev);
}
