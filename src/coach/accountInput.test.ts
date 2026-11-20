import { describe, expect, it } from 'vitest';
import { parseAccountInput } from './accountInput';

const ok = (accountId: string) => ({ ok: true, accountId });

describe('parseAccountInput', () => {
  it('accepts a friend code, a SteamID64 and [U:1:n]', () => {
    expect(parseAccountInput('86745912')).toEqual(ok('86745912'));
    expect(parseAccountInput(' 76561198047011640 ')).toEqual(ok('86745912'));
    expect(parseAccountInput('[U:1:86745912]')).toEqual(ok('86745912'));
  });

  it('accepts profile links from Steam, OpenDota, Dotabuff and STRATZ', () => {
    expect(parseAccountInput('https://steamcommunity.com/profiles/76561198047011640/')).toEqual(ok('86745912'));
    expect(parseAccountInput('www.opendota.com/players/86745912/matches')).toEqual(ok('86745912'));
    expect(parseAccountInput('https://www.dotabuff.com/players/86745912')).toEqual(ok('86745912'));
    expect(parseAccountInput('https://stratz.com/players/86745912')).toEqual(ok('86745912'));
  });

  it('explains vanity Steam URLs instead of guessing', () => {
    expect(parseAccountInput('https://steamcommunity.com/id/someone')).toEqual({ ok: false, reason: 'vanity' });
  });

  it('rejects everything else', () => {
    for (const bad of ['', '0', '4294967296', 'abc', 'https://evil.test/players/1', 'opendota.com.evil.test/players/1', 'javascript:alert(1)', 'https://www.opendota.com/matches/9091400302', '76561197960265728']) {
      expect(parseAccountInput(bad), bad).toEqual({ ok: false, reason: 'invalid' });
    }
  });
});
