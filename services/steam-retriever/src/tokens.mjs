/**
 * Refresh tokens on disk: one file per account, `<dataDir>/tokens/<label>.token`,
 * mode 0600 in a 0700 directory. The label is a name you choose (not the Steam
 * login name); it is what logs and the quota file use. Token text is never
 * logged.
 */
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const LABEL = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const dirOf = (dataDir) => join(dataDir, 'tokens');

/** @returns {{ label: string, refreshToken: string }[]} */
export function readTokens(dataDir) {
  let names;
  try { names = readdirSync(dirOf(dataDir)); } catch { return []; }
  return names.sort().flatMap((name) => {
    const label = name.endsWith('.token') ? name.slice(0, -6) : '';
    if (!LABEL.test(label)) return [];
    const refreshToken = readFileSync(join(dirOf(dataDir), name), 'utf8').trim();
    return refreshToken ? [{ label, refreshToken }] : [];
  });
}

/** Write atomically, so a crash mid-write cannot leave a half token. */
export function writeToken(dataDir, label, refreshToken) {
  if (!LABEL.test(label)) throw new Error('label must be lowercase letters, digits, - or _ (max 32)');
  const dir = dirOf(dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const file = join(dir, `${label}.token`);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${refreshToken}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

/** When a refresh token (a JWT) expires, in ms since the epoch, or null. */
export function tokenExpiry(refreshToken) {
  try {
    const exp = JSON.parse(Buffer.from(String(refreshToken).split('.')[1], 'base64url').toString('utf8')).exp;
    return Number.isFinite(exp) ? exp * 1000 : null;
  } catch { return null; }
}

/**
 * Why a stored token cannot be used to log on, or null when it looks usable.
 * steam-user throws from a timer on a token it cannot read, which would take
 * the whole process (and the healthy accounts) down, so check first.
 */
export function tokenProblem(refreshToken, now = Date.now()) {
  let claims;
  try {
    const parts = String(refreshToken).split('.');
    if (parts.length !== 3) return 'not a token';
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch { return 'not a token'; }
  if (!claims || typeof claims !== 'object') return 'not a token';
  if (!/^7656\d{13}$/.test(String(claims.sub))) return 'no Steam account in it';
  if (claims.iss !== 'steam') return 'not a refresh token';
  if (!Array.isArray(claims.aud) || !claims.aud.includes('client')) return 'not valid for the Steam client';
  if (Number.isFinite(claims.exp) && claims.exp * 1000 <= now) return 'expired';
  return null;
}
