/**
 * What to call each place the tools name (query.js `region`), and the two
 * sides, in the reader's language. Given to the model, and used afterwards to
 * replace any key it left in its text.
 */
const SIDES = { radiant: { en: 'Radiant', zh: '天辉' }, dire: { en: 'Dire', zh: '夜魇' }, river: { en: 'river', zh: '河道' } };
const AREAS = { mid: { en: 'mid', zh: '中路' }, top_lane: { en: 'top lane', zh: '上路' }, top_jungle: { en: 'top jungle', zh: '上路野区' }, bot_lane: { en: 'bottom lane', zh: '下路' }, bot_jungle: { en: 'bottom jungle', zh: '下路野区' } };
export function placeNames(lang) {
  const L = lang === 'zh' ? 'zh' : 'en';
  const out = { radiant_base: L === 'zh' ? '天辉基地' : 'Radiant base', dire_base: L === 'zh' ? '夜魇基地' : 'Dire base' };
  for (const [s, sn] of Object.entries(SIDES)) for (const [a, an] of Object.entries(AREAS)) out[`${s}_${a}`] = L === 'zh' ? `${sn.zh}${an.zh}` : s === 'river' ? `${sn.en} ${an.en}` : `${sn.en} ${an.en}`;
  // A side's bare key left in Chinese text ("dire 上路") is replaced too; in English the word is already the name.
  if (L === 'zh') for (const s of ['radiant', 'dire']) { out[s] = SIDES[s].zh; out[SIDES[s].en] = SIDES[s].zh; }
  return out;
}
