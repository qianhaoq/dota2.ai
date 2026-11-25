/**
 * The account pool (src/pool.mjs) on real Steam clients.
 */
import SteamUser from 'steam-user';
import { createPool } from './pool.mjs';

/**
 * @param {{ accounts: { label: string, refreshToken: string }[], dataDir: string,
 *           onRefreshToken?: (label: string, token: string) => void, log?: (line: string) => void }} o
 */
export function createSteamPool({ accounts, dataDir, onRefreshToken, log }) {
  return createPool({
    accounts, onRefreshToken, log,
    createClient: () => new SteamUser({ dataDirectory: dataDir, autoRelogin: true, renewRefreshTokens: true }),
    eresultName: (eresult) => SteamUser.EResult[eresult],
  });
}
