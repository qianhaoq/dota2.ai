/**
 * 将 OpenDota objectives 事件类型格式化为可读标签（中英）。
 * @param {{ type: string, key?: string | null }} ev
 * @param {'zh' | 'en'} [lang]
 */
export function formatObjectiveLabel(ev, lang = 'zh') {
  const isZh = lang === 'zh';
  const type = ev.type || '';

  if (type === 'CHAT_MESSAGE_FIRSTBLOOD') {
    return isZh ? '一血' : 'First Blood';
  }
  if (type === 'CHAT_MESSAGE_ROSHAN_KILL') {
    return isZh ? '肉山' : 'Roshan';
  }
  if (type === 'CHAT_MESSAGE_AEGIS') {
    return isZh ? '不朽之守护' : 'Aegis';
  }
  if (type === 'building_kill') {
    return formatBuildingKillLabel(ev.key || '', isZh);
  }

  const stripped = type.replace('CHAT_MESSAGE_', '');
  return stripped || type;
}

function formatBuildingKillLabel(key, isZh) {
  if (!key) return isZh ? '推塔' : 'Tower';

  const isRadiant = key.includes('goodguys');
  const side = isZh ? (isRadiant ? '天辉' : '夜魇') : (isRadiant ? 'Radiant' : 'Dire');

  let lane = '';
  if (key.includes('_top')) lane = isZh ? '上路' : 'top';
  else if (key.includes('_mid')) lane = isZh ? '中路' : 'mid';
  else if (key.includes('_bot')) lane = isZh ? '下路' : 'bot';

  if (key.includes('fort')) {
    return isZh ? `${side}基地` : `${side} Ancient`;
  }
  if (key.includes('melee_rax')) {
    return isZh ? `${lane}近战兵营` : `${lane} melee barracks`;
  }
  if (key.includes('range_rax')) {
    return isZh ? `${lane}远程兵营` : `${lane} range barracks`;
  }
  if (key.includes('tower4')) {
    return isZh ? `${lane}高地塔` : `${lane} T4`;
  }
  if (key.includes('tower3')) {
    return isZh ? `${lane}三塔` : `${lane} T3`;
  }
  if (key.includes('tower2')) {
    return isZh ? `${lane}二塔` : `${lane} T2`;
  }
  if (key.includes('tower1')) {
    return isZh ? `${lane}一塔` : `${lane} T1`;
  }

  return isZh ? '推塔' : 'Tower';
}
