/** Persisted job states; successful facts always carry verified dem provenance. */
export type ReplayFailureStatus = 'replay_unavailable' | 'replay_expired' | 'replay_cdn_error' | 'replay_invalid_url' | 'replay_failed' | 'throttled';
export interface ReplayProvenance {
  match_id: number;
  fetched_at: string;
  replay_url_present: boolean;
  replay_url: string | null;
  replay_salt: number | null;
  cluster: number | null;
  opendota_fetched_at: string | null;
}
export interface ReplayPlayer {
  hero_id: number;
  player_slot: number;
  deaths_log: Array<{time:number; key:string|null; x?:number; y?:number; source_path:string}>;
  kills_log: Array<{time:number; key:string; source_path:string}>;
  purchase_log: Array<{time:number; key:string; source_path:string}>;
}
export type ReplayArtifact = ReplayProvenance & (
  | {status:'replay_pending'}
  | {status:ReplayFailureStatus; reason?:string}
  | {status:'replay_parsed'; schema:'dota2.ai/replay-facts@1'; demo_bytes:number; demo_sha256:string; download_bytes:number; download_sha256:string; players:ReplayPlayer[]}
);
