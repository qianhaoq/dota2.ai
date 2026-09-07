/**
 * 将 OpenDota objectives 事件类型格式化为可读标签（中英）。
 * @param {{ type: string, key?: string | null, team?: number | null, carrierName?: string | null, aegisStolen?: boolean }} ev
 * @param {'zh' | 'en'} [lang]
 */
export function formatObjectiveLabel(ev, lang = 'zh') {
  const isZh = lang === 'zh';
  const type = ev.type || '';

  if (type === 'CHAT_MESSAGE_FIRSTBLOOD') {
    return isZh ? '一血' : 'First Blood';
  }
  if (type === 'CHAT_MESSAGE_ROSHAN_KILL') {
    const killer = killerSideLabel(ev.team, isZh);
    if (killer) return isZh ? `${killer}肉山` : `${killer} Roshan`;
    return isZh ? '肉山' : 'Roshan';
  }
  if (type === 'CHAT_MESSAGE_AEGIS') {
    const side = killerSideLabel(ev.team, isZh);
    const carrier = ev.carrierName || '';
    if (ev.aegisStolen) {
      if (carrier && side) return isZh ? `${side}${carrier} 抢盾` : `${side} ${carrier} steals Aegis`;
      if (side) return isZh ? `${side}抢盾` : `${side} steals Aegis`;
      return isZh ? '抢盾' : 'Aegis steal';
    }
    if (carrier && side) {
      return isZh ? `${side}${carrier} 拾取不朽之守护` : `${side} ${carrier} picks up Aegis`;
    }
    if (side) return isZh ? `${side}不朽之守护` : `${side} Aegis`;
    return isZh ? '不朽之守护' : 'Aegis';
  }
  if (type === 'building_kill') {
    return formatBuildingKillLabel(ev.key || '', isZh);
  }

  const stripped = type.replace('CHAT_MESSAGE_', '');
  return stripped || type;
}

/** OpenDota objectives: team 2 = Radiant killer, 3 = Dire killer */
function killerSideLabel(team, isZh) {
  if (team === 2) return isZh ? '天辉' : 'Radiant';
  if (team === 3) return isZh ? '夜魇' : 'Dire';
  return '';
}

function formatBuildingKillLabel(key, isZh) {
  if (!key) return isZh ? '推塔' : 'Tower';

  const isRadiant = key.includes('goodguys');
  const side = isZh ? (isRadiant ? '天辉' : '夜魇') : (isRadiant ? 'Radiant' : 'Dire');

  let lane = '';
  if (key.includes('_top')) lane = isZh ? '上路' : 'top';
  else if (key.includes('_mid')) lane = isZh ? '中路' : 'mid';
  else if (key.includes('_bot')) lane = isZh ? '下路' : 'bot';

  const lanePrefix = lane ? (isZh ? `${side}${lane}` : `${side} ${lane}`) : side;

  if (key.includes('fort')) {
    return isZh ? `${side}基地` : `${side} Ancient`;
  }
  if (key.includes('melee_rax')) {
    return isZh ? `${lanePrefix}近战兵营` : `${lanePrefix} melee barracks`;
  }
  if (key.includes('range_rax')) {
    return isZh ? `${lanePrefix}远程兵营` : `${lanePrefix} range barracks`;
  }
  if (key.includes('tower4')) {
    return isZh ? `${lanePrefix}高地塔` : `${lanePrefix} T4`;
  }
  if (key.includes('tower3')) {
    return isZh ? `${lanePrefix}三塔` : `${lanePrefix} T3`;
  }
  if (key.includes('tower2')) {
    return isZh ? `${lanePrefix}二塔` : `${lanePrefix} T2`;
  }
  if (key.includes('tower1')) {
    return isZh ? `${lanePrefix}一塔` : `${lanePrefix} T1`;
  }

  return isZh ? `${side}推塔` : `${side} tower`;
}
