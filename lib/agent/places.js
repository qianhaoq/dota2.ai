/**
 * What to call each place the tools name (query.js `region`), and the two
 * sides, in the reader's language. Given to the model, and used afterwards to
 * replace any key it left in its text.
 */
import { normalizeUiLang } from '../aiLanguage.js';

const SIDES = {
  radiant: { en: 'Radiant', zh: '天辉', ru: 'Света' },
  dire: { en: 'Dire', zh: '夜魇', ru: 'Тьмы' },
  river: { en: 'river', zh: '河道', ru: 'река' },
};
const AREAS = {
  mid: { en: 'mid', zh: '中路', ru: 'мид' },
  top_lane: { en: 'top lane', zh: '上路', ru: 'верхняя линия' },
  top_jungle: { en: 'top jungle', zh: '上路野区', ru: 'верхний лес' },
  bot_lane: { en: 'bottom lane', zh: '下路', ru: 'нижняя линия' },
  bot_jungle: { en: 'bottom jungle', zh: '下路野区', ru: 'нижний лес' },
};
export function placeNames(lang) {
  const L = normalizeUiLang(lang);
  const out = {
    radiant_base: L === 'zh' ? '天辉基地' : L === 'ru' ? 'база Света' : 'Radiant base',
    dire_base: L === 'zh' ? '夜魇基地' : L === 'ru' ? 'база Тьмы' : 'Dire base',
  };
  for (const [s, sn] of Object.entries(SIDES)) {
    for (const [a, an] of Object.entries(AREAS)) {
      out[`${s}_${a}`] = L === 'zh'
        ? `${sn.zh}${an.zh}`
        : L === 'ru'
          ? (s === 'river' ? `${an.ru} (${sn.ru})` : `${an.ru} ${sn.ru}`)
          : `${sn.en} ${an.en}`;
    }
  }
  // A side's bare key left in Chinese text ("dire 上路") is replaced too; in English the word is already the name.
  if (L === 'zh') for (const s of ['radiant', 'dire']) { out[s] = SIDES[s].zh; out[SIDES[s].en] = SIDES[s].zh; }
  return out;
}
