/**
 * /api/health 的常量加载状态判定（纯逻辑）。
 * heroes/items/abilities 任一未加载 → status 'degraded' 并列出缺失项。
 */

/**
 * @param {{ heroesLoaded: boolean, itemsLoaded: boolean, abilitiesLoaded: boolean }} constants
 * @returns {{ status: 'healthy' | 'degraded', opendotaConstants: { heroes: boolean, items: boolean, abilities: boolean, missing: string[] } }}
 */
export function computeApiHealth({ heroesLoaded, itemsLoaded, abilitiesLoaded }) {
  const opendotaConstants = {
    heroes: Boolean(heroesLoaded),
    items: Boolean(itemsLoaded),
    abilities: Boolean(abilitiesLoaded),
  };
  const missing = Object.entries(opendotaConstants)
    .filter(([, loaded]) => !loaded)
    .map(([name]) => name);
  return {
    status: missing.length > 0 ? 'degraded' : 'healthy',
    opendotaConstants: { ...opendotaConstants, missing },
  };
}
