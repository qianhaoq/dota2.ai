/**
 * 将 OpenDota objectives 事件类型格式化为可读标签（中英）。
 * @param {{ type: string, key?: string | null, team?: number | null, carrierName?: string | null, aegisStolen?: boolean }} ev
 * @param {string} [lang]
 */
export function formatObjectiveLabel(ev, lang = 'zh') {
  const isZh = lang === 'zh';
  const type = ev.type || '';

  if (type === 'CHAT_MESSAGE_FIRSTBLOOD') {
    const side = killerSideLabel(ev.team, isZh);
    const carrier = ev.carrierName || '';
    if (carrier && side) {
      return isZh ? `${side}${carrier} 一血` : `${side} ${carrier} First Blood`;
    }
    if (carrier) return isZh ? `${carrier} 一血` : `${carrier} First Blood`;
    if (side) return isZh ? `${side}一血` : `${side} First Blood`;
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
    return formatBuildingKillLabel(ev, isZh);
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

/**
 * 建筑事件必须无歧义地标明「谁失去、被谁摧毁」：
 * key 的 goodguys_* = 天辉建筑，badguys_* = 夜魇建筑；摧毁方优先取事件的
 * 击杀方字段（team：2=天辉、3=夜魇），缺失时按对方阵营推定。
 * 塔层命名：tower1=T1、tower2=T2（外塔）、tower3=T3（高地）、tower4=T4（基
 * 地/远古守卫塔），兵营=高地兵营；T2 绝不是高地塔。
 * @param {{ key?: string | null, team?: number | null }} ev
 * @param {boolean} isZh
 */
function formatBuildingKillLabel(ev, isZh) {
  const key = ev.key || '';
  if (!key) return isZh ? '建筑被摧毁' : 'Building destroyed';

  const isRadiant = key.includes('goodguys');
  const side = isZh ? (isRadiant ? '天辉' : '夜魇') : (isRadiant ? 'Radiant' : 'Dire');
  const destroyerTeam = ev.team === 2 || ev.team === 3 ? ev.team : (isRadiant ? 3 : 2);
  const destroyer = killerSideLabel(destroyerTeam, isZh);

  let lane = '';
  if (key.includes('_top')) lane = isZh ? '上路' : 'top';
  else if (key.includes('_mid')) lane = isZh ? '中路' : 'mid';
  else if (key.includes('_bot')) lane = isZh ? '下路' : 'bot';
  const laneZh = lane ? `${side}${lane}` : side;
  const laneEn = lane ? `${lane} ` : '';

  if (key.includes('fort')) {
    return isZh ? `${side}基地被${destroyer}摧毁` : `${side} lost the Ancient (destroyed by ${destroyer})`;
  }
  if (key.includes('melee_rax')) {
    return isZh
      ? `${laneZh}高地近战兵营被${destroyer}摧毁`
      : `${side} lost ${laneEn}melee barracks (high ground, destroyed by ${destroyer})`;
  }
  if (key.includes('range_rax')) {
    return isZh
      ? `${laneZh}高地远程兵营被${destroyer}摧毁`
      : `${side} lost ${laneEn}range barracks (high ground, destroyed by ${destroyer})`;
  }
  if (key.includes('tower4')) {
    return isZh ? `${laneZh}基地四塔被${destroyer}摧毁` : `${side} lost ${laneEn}T4 base tower (destroyed by ${destroyer})`;
  }
  if (key.includes('tower3')) {
    return isZh
      ? `${laneZh}高地三塔被${destroyer}摧毁`
      : `${side} lost ${laneEn}T3 tower (high ground, destroyed by ${destroyer})`;
  }
  if (key.includes('tower2')) {
    return isZh ? `${laneZh}二塔被${destroyer}摧毁` : `${side} lost ${laneEn}T2 tower (destroyed by ${destroyer})`;
  }
  if (key.includes('tower1')) {
    return isZh ? `${laneZh}一塔被${destroyer}摧毁` : `${side} lost ${laneEn}T1 tower (destroyed by ${destroyer})`;
  }

  return isZh ? `${side}建筑被${destroyer}摧毁` : `${side} lost a building (destroyed by ${destroyer})`;
}
