import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConstantsSnapshot } from '../../lib/constantsSnapshot.js';

describe('build-time OpenDota constants', () => {
  const snap: any = loadConstantsSnapshot();

  it('ships heroes, items and abilities for the current patch', () => {
    expect(Object.keys(snap.heroes!).length).toBeGreaterThanOrEqual(127);
    expect(Object.keys(snap.items!).length).toBeGreaterThan(400);
    expect(Object.keys(snap.abilities!).length).toBeGreaterThan(1000);
    const names = JSON.parse(readFileSync(path.join(process.cwd(), 'lib/coach/data/names.json'), 'utf8'));
    expect(snap.meta!.patch).toBe(names.patch); // refreshed together
    // Every item seen in current-patch pro games (hero-items.json) exists in the
    // shipped constants. (names.json also keeps retired items, on purpose.)
    const pro = JSON.parse(readFileSync(path.join(process.cwd(), 'lib/coach/data/hero-items.json'), 'utf8'));
    const current = new Set(Object.values(pro.heroes).flatMap((h: any) => h.items.map((x: any) => x.key)));
    expect([...current].filter((k) => !snap.items![k])).toEqual([]);
  });

  it('keeps only the ability fields the server reads', () => {
    const allowed = new Set(['dname', 'desc', 'lore', 'img', 'behavior', 'dmg_type', 'bkbpierce', 'dispellable', 'cd', 'mc']);
    for (const a of Object.values(snap.abilities!) as Record<string, unknown>[]) {
      for (const k of Object.keys(a)) expect(allowed.has(k)).toBe(true);
    }
    expect((snap.abilities as any).tidehunter_ravage.dname).toBe('Ravage');
  });

  it('the server reads the snapshot before fetching', () => {
    const server = readFileSync(path.join(process.cwd(), 'server.js'), 'utf8');
    for (const [fn, key] of [['getHeroConstants', 'heroes'], ['getItemConstants', 'items'], ['getAbilityConstants', 'abilities']]) {
      const body = server.slice(server.indexOf(`async function ${fn}(`));
      expect(body.indexOf(`if (CONSTANTS.${key})`)).toBeGreaterThan(-1);
      expect(body.indexOf(`if (CONSTANTS.${key})`)).toBeLessThan(body.indexOf('fetchWithRetry('));
    }
  });
});
