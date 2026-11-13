/** Only observable evidence is used; PR2 has no compliant KB adapter. */
export function buildGaps(player, gaps) {
  return [...gaps, ...(player ? [...((Array.isArray(player.deaths_log) && player.deaths_log.length > 0 && player.deaths_log.every(d => Number.isFinite(d.x) && Number.isFinite(d.y))) ? [] : [{ topic:'death_locations', reason:'opendota_deaths_log_has_no_coordinates' }]), { topic: 'build_vs_lineup', reason: 'no_compliant_patch_matched_kb' }] : [])];
}
