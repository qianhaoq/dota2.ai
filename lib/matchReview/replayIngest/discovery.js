export function isReplayUrl(value) {
 try { const u=new URL(value); const authority=value.match(/^https?:\/\/([^/?#]*)/i)?.[1];
 return authority?.toLowerCase()===u.hostname&&['http:','https:'].includes(u.protocol)&&!u.username&&!u.password&&!u.port&&/^replay\d+\.(?:valve\.net|steamcontent\.com|dota2\.com\.cn)$/.test(u.hostname);
 } catch { return false; }
}
export function replayUrl(raw) {
 if(raw.replay_url)return raw.replay_url;
 return [raw.cluster,raw.replay_salt,raw.match_id].every(n=>Number.isSafeInteger(n)&&n>0)?`https://replay${raw.cluster}.valve.net/570/${raw.match_id}_${raw.replay_salt}.dem.bz2`:null;
}
