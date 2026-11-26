import React, { useEffect, useState } from 'react';
import { fetchEvidence, type EvidenceItem, type EvidenceRecord } from './api';
import { MomentReplay } from './MomentReplay';
import { trackEvent } from '../services/analytics';

/**
 * Evidence under a finding: the coach's sentence, and — one click away — the
 * replay record it cites, recomputed by the server from the trace. The reader
 * checks the claim against the record, not against the model.
 */

type Lang = 'en' | 'zh' | 'ru';
type Tri = { en: string; zh: string; ru?: string };
const pickLang = (b: Tri | undefined, lang: Lang): string => (b ? (b[lang] ?? b.en) : '');
const T = {
  show: { en: 'Show the record', zh: '看原始记录', ru: 'Показать запись' },
  hide: { en: 'Hide', zh: '收起', ru: 'Скрыть' },
  ask: { en: 'Ask about this', zh: '就这一刻追问', ru: 'Спросить об этом' },
  replay: { en: 'Replay this moment', zh: '重放这一刻', ru: 'Показать на карте' },
  replayHide: { en: 'Close the replay', zh: '收起回放', ru: 'Скрыть повтор' },
  loading: { en: 'Loading the record…', zh: '正在取记录…', ru: 'Загрузка записи…' },
  failed: { en: 'Could not load this record.', zh: '这条记录没有取到。', ru: 'Не удалось загрузить запись.' },
  killer: { en: 'Killed by', zh: '击杀者', ru: 'Убийца' },
  before: { en: 'before death', zh: '阵亡前', ru: 'до смерти' },
  me: { en: 'You', zh: '你', ru: 'Вы' },
  allies: { en: 'Allies within 2200', zh: '2200 码内队友', ru: 'Союзники в 2200' },
  enemies: { en: 'Enemies within 2200', zh: '2200 码内敌人', ru: 'Враги в 2200' },
  nobody: { en: 'none', zh: '无', ru: 'нет' },
  readyUnused: { en: 'Ready, not used', zh: '就绪未用', ru: 'Готово, не нажато' },
  disables: { en: 'Disables that landed', zh: '吃到的控制', ru: 'Полученный контроль' },
  damage: { en: 'Damage taken', zh: '承受伤害', ru: 'Полученный урон' },
  attack: { en: 'attacks', zh: '普攻', ru: 'атаки' },
  target: { en: 'Target', zh: '目标', ru: 'Цель' },
  immune: { en: 'spell immune', zh: '技能免疫中', ru: 'невосприимчив к магии' },
  notImmune: { en: 'not spell immune', zh: '未免疫', ru: 'уязвим к магии' },
  stunned: { en: 'stunned', zh: '被晕', ru: 'оглушён' },
  noStun: { en: 'no stun landed', zh: '没有晕住', ru: 'оглушение не прошло' },
  after: { en: 'Deaths in the next 12 s', zh: '之后 12 秒内阵亡', ru: 'Смерти в следующие 12 с' },
  near: { en: 'Near you', zh: '你身边', ru: 'Рядом с вами' },
  window: { en: 'Spell immunity', zh: '技能免疫', ru: 'Невосприимчивость к магии' },
  ult: { en: 'Your ultimate when it opened', zh: '开启时你的大招', ru: 'Ваш ульт в начале окна' },
  states: {
    ready: { en: 'ready', zh: '就绪', ru: 'готов' },
    on_cooldown: { en: 'on cooldown', zh: '冷却中', ru: 'на перезарядке' },
    dead: { en: 'you were dead', zh: '你已阵亡', ru: 'вы были мертвы' },
    not_learned: { en: 'not learned', zh: '未学', ru: 'не изучен' },
    unknown: { en: 'unknown', zh: '未知', ru: 'неизвестно' },
  } as Record<string, Tri>,
  lastCast: { en: 'last cast', zh: '上一次施放', ru: 'прошлый каст' },
  castDuring: { en: 'Cast on them during the window', zh: '窗口内对其施放', ru: 'Применение по цели в окне' },
  yes: { en: 'yes', zh: '是', ru: 'да' }, no: { en: 'no', zh: '否', ru: 'нет' },
  fight: { en: 'Fight', zh: '团战', ru: 'Драка' },
  lost: { en: 'heroes lost', zh: '阵亡', ru: 'потери героев' },
  mine: { en: 'Your team', zh: '我方', ru: 'Ваша команда' }, theirs: { en: 'Enemy', zh: '敌方', ru: 'Враги' },
  gold: { en: 'Your team\'s gold lead', zh: '我方经济领先', ru: 'Перевес вашей команды по золоту' },
  goldAfter: { en: '2 min later', zh: '两分钟后', ru: 'через 2 мин' },
  firstDeath: { en: 'Positions at the first death', zh: '首个阵亡时的站位', ru: 'Позиции при первой смерти' },
  start: { en: 'Positions at the start', zh: '开始时的站位', ru: 'Позиции в начале' },
  events: { en: 'What happened', zh: '经过', ru: 'Ход событий' },
  dealt: { en: 'Damage to heroes', zh: '对英雄伤害', ru: 'Урон по героям' },
  firstHeld: { en: 'First held', zh: '首次持有', ru: 'Впервые получен' },
  watching: { en: 'watching', zh: '观察', ru: 'отслеживается' },
  proShare: { en: 'of pro games', zh: '职业局', ru: 'про-матчей' },
  never: { en: 'never held', zh: '从未持有', ru: 'не покупался' },
  pierces: { en: 'goes through spell immunity', zh: '无视技能免疫', ru: 'пробивает невосприимчивость к магии' },
  noPierce: { en: 'blocked by spell immunity', zh: '被技能免疫挡住', ru: 'блокируется невосприимчивостью к магии' },
  ultimate: { en: 'ultimate', zh: '大招', ru: 'ульт' },
  sec: { en: 's', zh: '秒', ru: 'с' },
  lane: { top: { en: 'Top lane', zh: '上路', ru: 'Верхняя линия' }, mid: { en: 'Mid lane', zh: '中路', ru: 'Мид' }, bot: { en: 'Bottom lane', zh: '下路', ru: 'Нижняя линия' } } as Record<string, Tri>,
  laneAt10: { en: 'at 10:00', zh: '10 分钟时', ru: 'к 10:00' },
  laneResult: {
    'won big': { en: 'won big', zh: '大优', ru: 'разгром' },
    won: { en: 'won', zh: '优势', ru: 'выиграна' },
    even: { en: 'even', zh: '均势', ru: 'ровно' },
    lost: { en: 'lost', zh: '劣势', ru: 'проиграна' },
    'lost badly': { en: 'lost badly', zh: '大劣', ru: 'сильно проиграна' },
  } as Record<string, Tri>,
  laneCols: { en: ['Hero', 'LH 5:00', 'LH 10:00', 'Denies', 'Gold', 'XP'], zh: ['英雄', '5 分补刀', '10 分补刀', '反补', '金钱', '经验'], ru: ['Герой', 'LH 5:00', 'LH 10:00', 'Денаи', 'Золото', 'Опыт'] },
  laneDeaths: { en: 'Deaths before 10:00', zh: '10 分钟前阵亡', ru: 'Смерти до 10:00' },
  laneNoEconomy: { en: 'No per-minute gold or last hits for this game.', zh: '这局没有逐分钟的金钱和补刀数据。', ru: 'Нет поминутных данных по золоту и добиваниям.' },
  lanePro: { en: 'pro games, core vs core at 10:00', zh: '场职业局，双方核心 10 分钟经济差', ru: 'про-игр, кор против кора на 10:00' },
  laneProMean: { en: 'usually', zh: '通常', ru: 'обычно' }, laneThis: { en: 'this game', zh: '这局', ru: 'в этой игре' }, laneAhead: { en: 'ahead in', zh: '领先的比例', ru: 'впереди в' },
  lanePub: { en: 'lanes in public games of this bracket (STRATZ)', zh: '条同分段路人局对线（STRATZ）', ru: 'линий в пабликах этого ранга (STRATZ)' },
  lanePubWon: { en: 'won', zh: '赢', ru: 'побед' }, lanePubLost: { en: 'lost', zh: '输', ru: 'поражений' },
  buildDamage: { en: 'Damage in your deaths', zh: '阵亡前受到的伤害', ru: 'Урон перед смертями' },
  buildAttacks: { en: 'attacks', zh: '普攻', ru: 'атаки' }, buildSpells: { en: 'abilities and items', zh: '技能与物品', ru: 'способности и предметы' },
  buildKills: { en: 'kills', zh: '次击杀', ru: 'убийств' },
  buildItems: { en: 'Your big items, in order', zh: '你的大件，按时间', ru: 'Ваши крупные предметы по порядку' },
  buildCols: { en: ['Time', 'Item', 'Gold', 'What it is for'], zh: ['时间', '物品', '金币', '用途'], ru: ['Время', 'Предмет', 'Золото', 'Назначение'] },
  buildAnswers: { en: 'Items that answer attack damage', zh: '应对普攻伤害的装备', ru: 'Предметы против физ. урона' },
  buildSpellAnswers: { en: 'Items that answer spell damage', zh: '应对技能伤害的装备', ru: 'Предметы против маг. урона' },
  buildPros: { en: 'Most built by pros on this hero (by 24:59)', zh: '职业选手这个英雄最常出（24:59 前）', ru: 'Самые частые предметы про-игроков (до 24:59)' },
  buildGaps: { en: 'First gap closer', zh: '第一件位移装', ru: 'Первый предмет на сближение' },
  buildYou: { en: 'you', zh: '你', ru: 'вы' },
  dataPatch: { en: 'Prices and item effects of patch', zh: '价格与装备效果按版本', ru: 'Цены и эффекты патча' },
  purpose: {
    initiation_or_gap_closer: { en: 'initiation / gap closer', zh: '先手 / 位移', ru: 'инициация / сближение' },
    answer_to_spell_damage: { en: 'answers spell damage', zh: '应对技能伤害', ru: 'против маг. урона' },
    answer_to_attack_damage: { en: 'answers attack damage', zh: '应对普攻伤害', ru: 'против физ. урона' },
    answer_to_disables: { en: 'answers disables', zh: '应对控制', ru: 'против контроля' },
    answer_to_silences: { en: 'answers silences', zh: '应对沉默', ru: 'против безмолвия' },
    answer_to_evasion: { en: 'answers evasion', zh: '应对闪避', ru: 'против уклонения' },
    answer_to_invisibility: { en: 'answers invisibility', zh: '应对隐身', ru: 'против невидимости' },
    answer_to_illusions: { en: 'answers illusions', zh: '应对幻象', ru: 'против иллюзий' },
    answer_to_healing: { en: 'answers healing', zh: '应对治疗', ru: 'против лечения' },
    magic_resistance: { en: 'magic resistance', zh: '魔法抗性', ru: 'сопротивление магии' },
    armor: { en: 'armor', zh: '护甲', ru: 'броня' },
    not_classified: { en: 'not classified', zh: '未分类', ru: 'без категории' },
  } as Record<string, Tri>,
  spikeCols: { en: ['Hero', 'Lv 6', 'Lv 12', 'Lv 18', 'Killed you', 'Your hero vs them (public)'], zh: ['英雄', '6 级', '12 级', '18 级', '击杀你', '你的英雄对上他（路人局）'], ru: ['Герой', 'Ур. 6', 'Ур. 12', 'Ур. 18', 'Убил вас', 'Ваш герой против него (паблик)'] },
  spikeMatchup: { favoured: { en: 'favoured', zh: '占优', ru: 'выгодный' }, unfavoured: { en: 'unfavoured', zh: '吃亏', ru: 'невыгодный' }, even: { en: 'even', zh: '持平', ru: 'ровный' } } as Record<string, Tri>,
  spikeItems: { en: 'Their items, and their kills of you before → from then on', zh: '他的装备，以及做出前 → 做出后击杀你的次数', ru: 'Его предметы и убийства вас до → после покупки' },
  spikeUlt: { en: 'Ultimate cooldown by level', zh: '大招各级冷却', ru: 'Перезарядка ульта по уровням' },
  tempoCols: { en: ['Stretch', 'Buildings taken', 'Buildings lost', 'Team deaths', 'Enemy deaths'], zh: ['阶段', '拆掉建筑', '丢掉建筑', '己方阵亡', '对方阵亡'], ru: ['Отрезок', 'Снесено построек', 'Потеряно построек', 'Смерти команды', 'Смерти врага'] },
  tempoWon: { en: 'Fights with fewer heroes lost', zh: '少死人的团战', ru: 'Драки с меньшими потерями' },
  engaged: { en: 'first damage', zh: '开打', ru: 'первый урон' },
  tookPart: { en: 'In the fight', zh: '参战', ru: 'В драке' },
  notInIt: { en: 'Not in it', zh: '没参战', ru: 'Вне драки' },
  ultsReady: { en: 'Ultimates ready', zh: '大招就绪', ru: 'Ульты готовы' },
  ultsNot: { en: 'Not ready', zh: '大招未就绪', ru: 'Не готовы' },
  bkbReady: { en: 'Black King Bar ready', zh: 'BKB 就绪', ru: 'BKB готов' },
  tp: { true: { en: 'TP ready', zh: 'TP 可用', ru: 'TP готов' }, false: { en: 'TP on cooldown', zh: 'TP 冷却中', ru: 'TP на перезарядке' } } as Record<string, Tri>,
  respawn: { en: 'respawns in', zh: '复活还要', ru: 'возрождение через' },
  away: { en: 'away', zh: '码外', ru: 'дальше' },
  doing: {
    dead: { en: 'dead', zh: '阵亡', ru: 'мёртв' }, in_own_base: { en: 'in base', zh: '在基地', ru: 'на базе' },
    trading_damage_with_enemy_heroes: { en: 'fighting heroes', zh: '在和敌方英雄交手', ru: 'дерётся с героями' },
    hitting_enemy_buildings: { en: 'hitting a building', zh: '在打建筑', ru: 'бьёт постройку' },
    none_of_these: { en: '', zh: '', ru: '' },
  } as Record<string, Tri>,
  why: { cooldown: { en: 'cooldown', zh: '冷却', ru: 'перезарядка' }, mana: { en: 'no mana', zh: '缺蓝', ru: 'нет маны' }, not_learned: { en: 'not learned', zh: '未学', ru: 'не изучен' } } as Record<string, Tri>,
  observers: { en: 'Observer wards within 1600', zh: '1600 码内的假眼', ru: 'Observer-варды в радиусе 1600' },
  boughtBack: { en: 'bought back', zh: '买活', ru: 'байбэк' },
  traded: { true: { en: 'traded: an enemy hero died within 15 s', zh: '换到了：15 秒内对面也死了英雄', ru: 'размен: враг погиб в течение 15 с' }, false: { en: 'not traded: no enemy hero died within 15 s', zh: '没换到：15 秒内对面没死英雄', ru: 'без размена: враги не погибли за 15 с' } } as Record<string, Tri>,
  alliesElsewhere: { en: 'Allies not near', zh: '不在附近的队友', ru: 'Союзники вдалеке' },
  wonBy: { my_team: { en: 'Your team won the fight', zh: '我方赢团', ru: 'Ваша команда выиграла драку' }, enemy: { en: 'They won the fight', zh: '对方赢团', ru: 'Враги выиграли драку' } } as Record<string, Tri>,
  stillDead: { en: 'Still dead 10 s after', zh: '10 秒后仍未复活', ru: 'Всё ещё мертвы через 10 с' },
  winnersDid: {
    took_a_building: { en: 'then took a building', zh: '随后拆到建筑', ru: 'затем снесли постройку' },
    took_roshan: { en: 'then took Roshan', zh: '随后打了肉山', ru: 'затем забрали Рошана' },
    pushed_and_took_nothing: { en: 'then pushed and took nothing', zh: '随后推了没拆掉', ru: 'пошли пушить, но ничего не снесли' },
    neither: { en: 'then took nothing', zh: '随后什么都没拿', ru: 'ничего не забрали' },
  } as Record<string, Tri>,
  tookBack: { my_team: { en: 'They took back', zh: '对方反拆', ru: 'Они забрали в ответ' }, enemy: { en: 'Your team took back', zh: '我方反拆', ru: 'Ваша команда забрала в ответ' } } as Record<string, Tri>,
  towerBy: { my_team: { en: 'Your team took', zh: '我方拆掉', ru: 'Ваша команда снесла' }, enemy: { en: 'They took', zh: '对方拆掉', ru: 'Враги снесли' } } as Record<string, Tri>,
  afterFight: { en: 'after a won fight', zh: '赢团后', ru: 'после выигранной драки' },
  takersDid: {
    took_another_building: { en: 'then took another building', zh: '随后又拆了建筑', ru: 'затем снесли ещё постройку' },
    took_roshan: { en: 'then took Roshan', zh: '随后打了肉山', ru: 'затем забрали Рошана' },
    pushed_and_took_nothing: { en: 'then pushed and took nothing', zh: '随后推了没拆掉', ru: 'пошли дальше, но не снесли' },
    neither: { en: 'then took nothing', zh: '随后什么都没拿', ru: 'ничего больше не забрали' },
  } as Record<string, Tri>,
  tradedBack: { my_team: { en: 'Meanwhile they took', zh: '同时对方拆掉', ru: 'Тем временем враги снесли' }, enemy: { en: 'Meanwhile your team took', zh: '同时我方拆掉', ru: 'Тем временем вы снесли' } } as Record<string, Tri>,
  meAtTower: {
    hit_it: { en: 'you hit it', zh: '你在打', ru: 'вы били её' },
    near: { en: 'you were near', zh: '你在附近', ru: 'вы были рядом' },
    dead: { en: 'you were dead', zh: '你阵亡中', ru: 'вы были мертвы' },
    elsewhere: { en: 'you were elsewhere', zh: '你在别处', ru: 'вы были в другом месте' },
    alive_tower_spot_unknown: { en: 'you were alive', zh: '你存活', ru: 'вы были живы' },
  } as Record<string, Tri>,
  afterItems: { en: 'Fight after big items', zh: '大件后的团战', ru: 'Драка после крупных предметов' },
  lostFewer: { my_team: { en: 'your team lost fewer', zh: '我方少死', ru: 'меньше потерь у вас' }, enemy: { en: 'they lost fewer', zh: '对方少死', ru: 'меньше потерь у врага' }, even: { en: 'even', zh: '持平', ru: 'ровно' } } as Record<string, Tri>,
  richest: { my_team: { en: 'Their richest', zh: '对方经济最高', ru: 'Их топ-нетворс' }, enemy: { en: 'Your richest', zh: '我方经济最高', ru: 'Ваш топ-нетворс' } } as Record<string, Tri>,
  richestAlive: { en: 'alive', zh: '已复活', ru: 'жив' },
  roshanBy: { my_team: { en: 'Your team took Roshan', zh: '我方打掉肉山', ru: 'Ваша команда забрала Рошана' }, enemy: { en: 'They took Roshan', zh: '对方打掉肉山', ru: 'Враги забрали Рошана' } } as Record<string, Tri>,
  aegisHolder: { en: 'Aegis', zh: '不朽盾', ru: 'Aegis' },
  aegisEnd: { used: { en: 'used', zh: '用掉', ru: 'использован' }, expired: { en: 'expired', zh: '过期', ru: 'истёк' }, game_ended: { en: 'game ended', zh: '比赛结束', ru: 'матч окончен' }, unknown: { en: 'unknown', zh: '不明', ru: 'неизвестно' } } as Record<string, Tri>,
  atRoshan: { en: 'At Roshan', zh: '在场', ru: 'У Рошана' },
  roshanMe: { holder: { en: 'you held the Aegis', zh: '盾在你身上', ru: 'Aegis был у вас' }, there: { en: 'you were there', zh: '你在场', ru: 'вы были там' }, not_there: { en: 'you were not there', zh: '你不在场', ru: 'вас там не было' } } as Record<string, Tri>,
  next300: { en: 'Buildings taken in the next 300 s', zh: '之后 300 秒拆掉的建筑', ru: 'Постройки за следующие 300 с' },
  fightsAfter: { en: 'Fights in the next 300 s', zh: '之后 300 秒的团战', ru: 'Драки за следующие 300 с' },
  pushedBy: { my_team: { en: 'Your team pushed', zh: '我方推', ru: 'Ваша команда пушила' }, enemy: { en: 'They pushed', zh: '对方推', ru: 'Враги пушили' } } as Record<string, Tri>,
  tookIt: { en: 'fell', zh: '被拆', ru: 'пала' }, stood: { en: 'stood', zh: '没拆掉', ru: 'устояла' },
  hitting: { en: 'Hitting it', zh: '打建筑', ru: 'Били постройку' }, ownersNear: { en: 'Owners near', zh: '守方在附近', ru: 'Защитники рядом' },
  pushOthers: { en: 'Rest of the pushing side, when it began', zh: '推塔方其余（推进开始时）', ru: 'Остальные пушащие (в начале пуша)' },
  ownersAway: { en: 'Owners not near, when it began', zh: '守方不在附近（推进开始时）', ru: 'Защитники вдалеке (в начале пуша)' },
  meWhenFell: { en: 'When it fell, you', zh: '被拆时你', ru: 'В момент падения вы' }, placeUnknown: { en: 'position not known', zh: '位置未知', ru: 'позиция неизвестна' },
  meAt: { hitting: { en: 'you hit it', zh: '你在打', ru: 'вы били' }, near: { en: 'you were near', zh: '你在附近', ru: 'вы были рядом' }, not_hitting: { en: 'you did not hit it', zh: '你没打塔', ru: 'вы не били' }, not_near: { en: 'you were not near', zh: '你不在附近', ru: 'вы были не рядом' } } as Record<string, Tri>,
  stateCols: { en: ['Hero', 'Where / doing', 'Lv', 'HP', 'Ultimate', 'BKB', 'TP'], zh: ['英雄', '位置 / 在做', '等级', '血量', '大招', 'BKB', 'TP'], ru: ['Герой', 'Где / действие', 'Ур.', 'HP', 'Ульт', 'BKB', 'TP'] },
  tempoLost: { en: 'Fights with more heroes lost', zh: '多死人的团战', ru: 'Драки с большими потерями' },
  tempoThen: { en: 'a building within 2 min after', zh: '之后两分钟内拆到建筑', ru: 'постройка в течение 2 мин после' },
  tempoThere: { en: 'Fights this hero was at', zh: '该英雄在场的团战', ru: 'Драки с участием героя' },
  tempoHit: { en: 'Buildings taken that this hero damaged', zh: '拆掉的建筑里该英雄打过的', ru: 'Снесённые постройки с уроном от героя' },
  tempoFirst: { en: 'First building', zh: '首个建筑', ru: 'Первая постройка' },
  tempoTeams: { team: { en: 'this side', zh: '己方', ru: 'эта сторона' }, opponents: { en: 'other side', zh: '对方', ru: 'соперники' } } as Record<string, Tri>,
  tempoShare: {
    on_own_side_of_the_map: { en: 'On own side of the map', zh: '在己方半场', ru: 'На своей половине карты' },
    around_the_river: { en: 'Around the river', zh: '在河道一带', ru: 'У реки' },
    on_the_opponents_side: { en: 'On the other side', zh: '在对方半场', ru: 'На стороне врага' },
    with_no_ally_within_2200: { en: 'No ally within 2200', zh: '2200 码内没有队友', ru: 'Без союзников в 2200' },
    with_one_ally_within_2200: { en: 'One ally near', zh: '身边一名队友', ru: 'Один союзник рядом' },
    with_two_or_more_allies_within_2200: { en: 'Two or more allies near', zh: '身边两名以上队友', ru: 'Два и более союзника рядом' },
    with_three_or_more_opponents_within_2200: { en: 'Three or more enemies near', zh: '身边三名以上敌人', ru: 'Три и более врага рядом' },
  } as Record<string, Tri>,
  tempoAlive: { en: 'of the time alive', zh: '占存活时间', ru: 'времени в живых' },
  tempoMost: { en: 'Most time in', zh: '停留最多', ru: 'Больше всего времени в' },
  tempoDamage: { en: 'Damage to buildings', zh: '对建筑伤害', ru: 'Урон по постройкам' },
  tempoOfTeam: { en: 'of the team\'s heroes\'', zh: '队伍英雄合计', ru: 'от урона команды' },
  tempoFights: { en: 'Fights', zh: '团战', ru: 'Драки' },
  tempoAway: { en: 'not there', zh: '不在场', ru: 'не участвовал' },
  tempoBuildings: { en: 'Buildings', zh: '建筑', ru: 'Постройки' },
  timingCols: { en: ['Hero', 'Under 35 min', '35–45 min', '45 min or more', 'Wins more in'], zh: ['英雄', '35 分钟内', '35–45 分钟', '45 分钟以上', '更常赢在'], ru: ['Герой', 'До 35 мин', '35–45 мин', '45+ мин', 'Сильнее в'] },
  timingLean: { shorter_games: { en: 'shorter games', zh: '短局', ru: 'быстрых играх' }, longer_games: { en: 'longer games', zh: '长局', ru: 'долгих играх' }, neither: { en: 'no clear lean', zh: '无明显倾向', ru: 'без явного перекоса' } } as Record<string, Tri>,
  timingSides: { my_team: { en: 'Your team', zh: '我方', ru: 'Ваша команда' }, enemy: { en: 'Enemy', zh: '敌方', ru: 'Враги' }, radiant: { en: 'Radiant', zh: '天辉', ru: 'Силы Света' }, dire: { en: 'Dire', zh: '夜魇', ru: 'Силы Тьмы' } } as Record<string, Tri>,
  timingMean: { en: 'mean of the five', zh: '五人平均', ru: 'среднее по пяти' },
  timingThis: { en: 'This game', zh: '这局', ru: 'Этот матч' },
  timingPublic: { en: 'public games, win rate by game length', zh: '路人局，按比赛时长的胜率', ru: 'паблики, винрейт по длительности' },
  timingAlone: { en: 'Each hero on its own: not a line-up\'s win rate.', zh: '每个英雄单独统计，不代表整套阵容的胜率。', ru: 'Показатели каждого героя отдельно, не винрейт драфта целиком.' },
  fmGained: { en: 'Gained', zh: '增长', ru: 'Прирост' }, fmLh: { en: 'Last hits', zh: '补刀', ru: 'Добивания' },
  fmMost: { en: 'Gained most', zh: '涨得最多', ru: 'Наибольший прирост' },
  fmGold: { en: 'gold earned', zh: '赚到的金钱', ru: 'заработанное золото' }, fmNw: { en: 'net worth', zh: '身价', ru: 'нетворс' },
  fmAlive: { en: 'Enemy heroes alive', zh: '对方存活', ru: 'Живые враги' },
  fmNear: { en: 'Near your team as it fell', zh: '倒下时在我方附近', ru: 'Рядом с вашей командой при падении' },
  fmNobody: { en: 'nobody', zh: '没有人', ru: 'никого' },
  fmUnknown: { en: 'not known', zh: '不清楚', ru: 'неизвестно' },
  bpPlan: { push: { en: 'Lanes into towers', zh: '线优转推进', ru: 'Линии в пуш' }, gank: { en: 'Ganks and pressure', zh: '抓人带节奏', ru: 'Ганги и давление' }, split: { en: 'Split push', zh: '带线牵制', ru: 'Сплит-пуш' }, late: { en: 'Farm for late', zh: '发育拖后期', ru: 'Фарм в лейт' } } as Record<string, Tri>,
  bpGold: { en: 'Gold in items for each plan', zh: '各思路的装备金额', ru: 'Золото на предметы по планам' },
  bpBy: { en: 'by', zh: '截至', ru: 'к' }, bpAll: { en: 'in all', zh: '全场', ru: 'за игру' },
  bpFirst: { en: 'First item for it', zh: '第一件', ru: 'Первый предмет' },
  bpYours: { en: 'Your plan', zh: '你的思路', ru: 'Ваш план' },
  bpBefore: { en: 'Gold in other big items before it', zh: '之前花在其他大件上', ru: 'Золото на другие предметы до него' },
  bpShare: { en: 'Share of big-item gold', zh: '占大件金额', ru: 'Доля от золота на крупные предметы' },
  bpNone: { en: 'none bought', zh: '没有出', ru: 'не куплено' },
  winLead: { en: 'Your team\'s gold lead', zh: '我方经济领先', ru: 'Перевес вашей команды по золоту' },
  winHigh: { en: 'Highest', zh: '最高', ru: 'Максимум' }, winLow: { en: 'Lowest', zh: '最低', ru: 'Минимум' },
  winList: { en: 'Windows', zh: '窗口期', ru: 'Окна' },
  winOurs: { en: 'your team ahead', zh: '我方领先', ru: 'ваша команда впереди' }, winTheirs: { en: 'enemy ahead', zh: '对方领先', ru: 'враги впереди' },
  winPeak: { en: 'peak', zh: '峰值', ru: 'пик' },
  winTook: { en: 'Buildings taken', zh: '拆掉建筑', ru: 'Снесено построек' },
  winFights: { en: 'Fights won · lost', zh: '团战 少死人 · 多死人', ru: 'Драки: выиграно · проиграно' },
  winItems: { en: 'Big items finished in it', zh: '期间完成的大件', ru: 'Крупные предметы в этом окне' },
  winLast: { en: 'Finished in its last 3 minutes', zh: '结束前 3 分钟内完成', ru: 'Завершено в последние 3 минуты' },
  winEnded: { en: 'Ended', zh: '结束', ru: 'Конец' }, winGameEnd: { en: 'with the game', zh: '比赛结束', ru: 'с окончанием матча' },
  winNone: { en: 'No per-minute gold for this game: no windows.', zh: '这局没有逐分钟经济数据，划不出窗口期。', ru: 'Нет поминутного золота — окна не выделены.' },
  building: {
    tower: { en: 'tier-{n} tower', zh: '{n} 塔', ru: 'башня T{n}' },
    melee_rax: { en: 'melee barracks', zh: '近战兵营', ru: 'казарма ближнего боя' },
    range_rax: { en: 'ranged barracks', zh: '远程兵营', ru: 'казарма дальнего боя' },
    fort: { en: 'Ancient', zh: '遗迹', ru: 'Трон' },
    top: { en: 'top', zh: '上路', ru: 'топ' }, mid: { en: 'mid', zh: '中路', ru: 'мид' }, bot: { en: 'bottom', zh: '下路', ru: 'бот' },
  } as Record<string, Tri>,
} as const;

/** A building's engine key ("badguys_tower1_mid") in words: which kind, which lane. The side is told by the column it stands in. */
export function buildingLabel(key: string, lang: Lang): string {
  const m = key.match(/_(tower(\d)|melee_rax|range_rax|fort)(?:_(top|mid|bot))?$/);
  if (!m) return pretty(key);
  const kind = m[2] ? pickLang(T.building.tower, lang).replace('{n}', m[2]) : pickLang(T.building[m[1]], lang);
  const lane = m[3] ? pickLang(T.building[m[3]], lang) : '';
  // Chinese sets a digit off from the words around it ("中路 1 塔"); a barracks has none ("下路远程兵营").
  return lang === 'zh' ? `${lane}${lane && m[2] ? ' ' : ''}${kind}` : [lane, kind].filter(Boolean).join(' ');
}

/** What a tool's totals are called. A key not listed here is shown as it is, with spaces. */
const TOTALS: Record<string, Tri> = {
  learned_at: { en: 'Learned at', zh: '学会于' },
  casts_total: { en: 'Casts', zh: '施放次数' },
  by_target: { en: 'On', zh: '目标' },
  casts_on_spell_immune_target: { en: 'Cast on a spell-immune target', zh: '施放在技能免疫目标上' },
  of_those_target_was_stunned: { en: 'of those, the target was stunned', zh: '其中目标仍被眩晕' },
  seconds_alive_since_learned: { en: 'Seconds alive since learned', zh: '学会后存活秒数' },
  seconds_alive_and_ready: { en: 'Seconds alive with it ready', zh: '存活且技能就绪秒数' },
  deaths_with_it_ready_and_not_cast_total: { en: 'Deaths with it ready and not cast', zh: '技能就绪未放就阵亡' },
  window: { en: 'Seconds before each death', zh: '每次阵亡前秒数' },
  deaths_total: { en: 'Deaths', zh: '阵亡次数' },
  killed_by: { en: 'Killed by', zh: '击杀者' },
  windows_total: { en: 'Spell-immunity windows', zh: '技能免疫次数' },
  watched_state_when_window_opened: { en: 'When it opened, the watched ability was', zh: '开启时所观察技能' },
  windows_with_a_cast_on_the_immune_hero: { en: 'Windows with a cast on the immune hero', zh: '期间对免疫目标施放' },
  on_cooldown: { en: 'on cooldown', zh: '冷却中' }, ready: { en: 'ready', zh: '就绪' }, dead: { en: 'caster dead', zh: '施法者已阵亡' },
  not_learned: { en: 'not learned', zh: '未学' }, no_mana: { en: 'no mana', zh: '没蓝' },
  damage_in_death_windows_total: { en: 'Damage taken before the deaths', zh: '各次阵亡前承受的伤害' },
  damage_share_in_death_windows: { en: 'Share of it', zh: '其中' },
  attacks: { en: 'attacks', zh: '普通攻击' }, 'abilities and items': { en: 'abilities and items', zh: '技能和物品' },
  health_below_half_at_window_start: { en: 'Deaths that began below half health', zh: '起步不到半血的阵亡' },
  no_ally_within_2200_throughout: { en: 'Deaths with no ally within 2200 throughout', zh: '全程 2200 码内没有队友的阵亡' },
  no_ally_within_2200_at_death: { en: 'Deaths with no ally within 2200 at the end', zh: '阵亡时 2200 码内没有队友' },
  three_or_more_enemy_heroes_dealing_damage: { en: 'Deaths to three or more enemy heroes', zh: '被三个以上敌方英雄打死' },
  in_a_fight: { en: 'Deaths in a fight', zh: '团战中的阵亡' },
  outside_fights: { en: 'Deaths outside fights', zh: '团战之外的阵亡' },
  health_below_half_at_window_start_outside_fights: { en: 'Outside fights, began below half health', zh: '团战之外、起步不到半血' },
  three_or_more_enemy_heroes_dealing_damage_outside_fights: { en: 'Outside fights, to three or more enemy heroes', zh: '团战之外、被三个以上敌方英雄打死' },
  target_spell_immune_and_not_stunned: { en: 'Casts on a spell-immune target, no stun', zh: '放给魔免目标且没晕住' },
  enemy_hero_target_alive_12s_later: { en: 'Casts whose target was alive 12 s later', zh: '放出 12 秒后目标仍存活' },
  no_hero_target_near_enemies_at_most_one_damaged_and_none_died: { en: 'Casts near enemy heroes that damaged at most one and killed none', zh: '在敌方英雄附近放出、至多伤到一人且没有击杀' },
  nothing_cast_and_no_item_used: { en: 'Deaths with nothing cast or used', zh: '什么都没按就阵亡' },
  // death_context's trade lists (deaths:<hero>).
  traded_within_15s: { en: 'Deaths traded (an enemy hero died within 15 s)', zh: '换到了（15 秒内对面也死了英雄）' },
  not_traded_within_15s: { en: 'Deaths not traded', zh: '没换到' },
  no_ally_within_2200_at_death_and_not_traded: { en: 'No ally within 2200 and not traded', zh: '身边没人且没换到' },
  no_own_observer_within_1600: { en: 'Deaths with no own observer within 1600', zh: '身边 1600 码内没有己方假眼的阵亡' },
  enemy_observer_within_1600: { en: 'Deaths with an enemy observer within 1600', zh: '1600 码内有敌方假眼的阵亡' },
  bought_back: { en: 'Deaths bought back', zh: '买活的阵亡' },
  // fight_report's totals (fights:<hero>).
  fights_total: { en: 'Fights', zh: '团战' },
  fights_my_team_lost_fewer: { en: 'Your team lost fewer heroes', zh: '我方少死人' },
  fights_enemy_lost_fewer: { en: 'Enemy lost fewer heroes', zh: '对方少死人' },
  fights_with_more_of_my_team: { en: 'Your team brought more heroes', zh: '我方参战人数更多' },
  fights_with_more_of_the_enemy: { en: 'Enemy brought more heroes', zh: '对方参战人数更多' },
  fights_the_side_with_more_heroes_lost_fewer: { en: 'Fights one side brought more heroes to', zh: '人数不等的团战' },
  fights_i_took_part_in: { en: 'Fights you took part in', zh: '你参战的团战' },
  fights_with_unequal_numbers: { en: 'fights', zh: '场数' },
  the_side_with_more_lost_fewer: { en: 'the side with more lost fewer', zh: '人多一方少死人' },
  // decision_points' totals (decision:<hero>).
  fights_my_team_won: { en: 'Fights your team won', zh: '我方赢的团' },
  fights_enemy_won: { en: 'Fights the enemy won', zh: '对方赢的团' },
  my_team_after_its_wins: { en: 'After your wins', zh: '我方赢团后' },
  my_team_wins_with_three_or_more_still_dead: { en: 'Your wins with 3+ enemies still dead', zh: '赢团后对面 3 人以上未复活' },
  enemy_after_its_wins: { en: 'After their wins', zh: '对方赢团后' },
  took_a_building: { en: 'took a building', zh: '拆到建筑' },
  took_roshan: { en: 'took Roshan', zh: '打了肉山' },
  pushed_and_took_nothing: { en: 'pushed, took nothing', zh: '推了没拆掉' },
  neither: { en: 'took nothing', zh: '什么都没拿' },
  fights: { en: 'fights', zh: '场数' },
  my_team_wins_with_enemy_richest_long_dead: { en: 'Your wins with their richest dead 30 s+', zh: '赢团后对方经济最高者 30 秒以上未复活' },
  fights_after_enemy_big_items: { en: 'Fights after only their big items', zh: '只有对方刚出大件后的团战' },
  fights_after_my_team_big_items: { en: 'Fights after only your big items', zh: '只有我方刚出大件后的团战' },
  my_team_lost_fewer: { en: 'your team lost fewer', zh: '我方少死' },
  enemy_lost_fewer: { en: 'they lost fewer', zh: '对方少死' },
  even: { en: 'even', zh: '持平' },
  towers_my_team_took: { en: 'Towers your team took', zh: '我方拆塔后' },
  towers_enemy_took: { en: 'Towers the enemy took', zh: '对方拆塔后' },
  when_my_team_lost_a_tower_i_was: { en: 'When your team lost a tower, you were', zh: '我方掉塔时你' },
  towers: { en: 'towers', zh: '座数' },
  took_another_building: { en: 'took another building', zh: '又拆了建筑' },
  lost_a_building_meanwhile: { en: 'lost a building meanwhile', zh: '同时被拆建筑' },
  near_it: { en: 'near it', zh: '在附近' },
  was_dead: { en: 'dead', zh: '阵亡中' },
  elsewhere: { en: 'elsewhere', zh: '在别处' },
  not_known: { en: 'not known', zh: '不明' },
  // roshan_report's totals (roshan:<hero>).
  roshans_my_team_took: { en: 'Roshans your team took', zh: '我方肉山' },
  roshans_enemy_took: { en: 'Roshans the enemy took', zh: '对方肉山' },
  my_team_aegis_used: { en: 'Your Aegis used', zh: '我方不朽盾用掉' },
  my_team_aegis_expired: { en: 'Your Aegis expired', zh: '我方不朽盾过期' },
  buildings_my_team_took_with_aegis: { en: 'Buildings your team took with the Aegis', zh: '我方持盾期间拆掉建筑' },
  buildings_enemy_took_with_aegis: { en: 'Buildings the enemy took with the Aegis', zh: '对方持盾期间拆掉建筑' },
  my_team_roshans_with_no_building_after: { en: 'Your Roshans with no building after', zh: '我方打完肉山没拆到建筑' },
  roshans_i_was_at: { en: 'Roshans you were at', zh: '你在场的肉山' },
  // siege_report's totals (sieges:<hero>).
  my_team_pushes: { en: 'Your team\'s pushes', zh: '我方推塔' },
  my_team_pushes_that_took_it: { en: 'Your pushes that took the building', zh: '我方推掉的' },
  enemy_pushes: { en: 'Enemy pushes', zh: '对方推塔' },
  enemy_pushes_that_took_it: { en: 'Enemy pushes that took it', zh: '对方推掉的' },
  pushes_with_two_or_more_hitting_than_near: { en: 'Pushes with 2+ more hitting than owners near', zh: '打塔人数比守方多 2 人及以上' },
  pushes_with_at_most_one_more_hitting_than_near: { en: 'Pushes with at most 1 more hitting', zh: '打塔人数最多多 1 人' },
  pushes: { en: 'pushes', zh: '次数' },
  took_it: { en: 'fell', zh: '被拆' },
  my_team_pushes_i_hit: { en: 'Your pushes you hit', zh: '我方推塔你出手的' },
  my_buildings_taken_with_me_not_near: { en: 'Your buildings lost with you not near', zh: '己方丢塔时你不在附近' },
};

const pretty = (key: string) => key.replace(/^modifier_/, '').replace(/^item_/, '').replace(/_/g, ' ');
const SIDE_CLASS: Record<string, string> = { me: 'is-me', ally: 'is-ally', enemy: 'is-enemy' };

/** World units → a 0..1 square with Radiant bottom-left. */
const WORLD = 8600;
const mapX = (x: number) => (x + WORLD) / (2 * WORLD);
const mapY = (y: number) => 1 - (y + WORLD) / (2 * WORLD);

export const MiniMap: React.FC<{ heroes: { hero: string; side?: string; alive?: boolean | null; x?: number; y?: number }[]; N: (k: string) => string; label: string }> = ({ heroes, N, label }) => {
  const S = 220;
  return (
    <figure className="ag-map">
      <svg viewBox={`0 0 ${S} ${S}`} role="img" aria-label={label}>
        <rect x="0" y="0" width={S} height={S} rx="6" className="ag-map-bg" />
        <line x1="0" y1="0" x2={S} y2={S} className="ag-map-river" />
        <rect x="4" y={S - 34} width="30" height="30" rx="4" className="ag-map-base is-radiant" />
        <rect x={S - 34} y="4" width="30" height="30" rx="4" className="ag-map-base is-dire" />
        {heroes.filter((h) => typeof h.x === 'number' && typeof h.y === 'number').map((h) => (
          <g key={h.hero} className={`ag-map-dot ${SIDE_CLASS[h.side ?? ''] ?? ''} ${h.alive === false ? 'is-dead' : ''}`}>
            <circle cx={mapX(h.x!) * S} cy={mapY(h.y!) * S} r={h.side === 'me' ? 6 : 4.5}><title>{N(h.hero)}</title></circle>
          </g>
        ))}
      </svg>
      <figcaption>{label}</figcaption>
    </figure>
  );
};

const Bar: React.FC<{ label: string; value: number; max: number }> = ({ label, value, max }) => (
  <li className="ag-bar">
    <span className="ag-bar-label">{label}</span>
    <span className="ag-bar-track"><span style={{ width: `${Math.max(3, Math.round((value / Math.max(1, max)) * 100))}%` }} /></span>
    <span className="ag-bar-value">{value}</span>
  </li>
);

function Record({ data, lang }: { data: EvidenceRecord; lang: Lang }) {
  const t = (b: Tri) => pickLang(b, lang);
  const N = (key: string | null | undefined) => (key ? data.names[key] ?? data.names[key.replace(/^item_/, '')] ?? pretty(key) : '—');
  const r = data.record;
  const chips = (list: { hero: string; dist?: number }[]) => (list.length ? list.map((h) => <span key={h.hero} className="ag-chip">{N(h.hero)}{h.dist != null && <em>{h.dist}</em>}</span>) : <span className="ag-none">{t(T.nobody)}</span>);

  // A hero not in a fight, or at a moment: what the replay shows them doing, and where (a dead hero has no place).
  const doingOf = (h: any) => [h.place ? N(h.place) : null, h.doing && T.doing[h.doing] ? t(T.doing[h.doing]) : null].filter(Boolean).join(' · ');
  if (data.kind === 'death') {
    const max = Math.max(...r.damage_taken.map((d: any) => d.value), 1);
    return (
      <div className="ag-rec">
        <p className="ag-rec-head"><b>{r.clock}</b> · {t(T.killer)} {N(r.killer)}</p>
        <table className="ag-snap">
          <thead><tr><th /><th>{t(T.me)}</th><th>{t(T.allies)}</th><th>{t(T.enemies)}</th></tr></thead>
          <tbody>
            {r.snapshots.map((s: any) => (
              <tr key={s.dt}>
                <th>{-s.dt}{t(T.sec)} {t(T.before)}</th>
                <td>{s.me ? `${s.me.hp}/${s.me.max_hp}` : '—'}</td>
                <td>{chips(s.allies)}</td>
                <td>{chips(s.enemies)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {r.ready_not_cast.length > 0 && <p className="ag-rec-line"><span>{t(T.readyUnused)}</span>{r.ready_not_cast.map((a: string) => <span key={a} className="ag-chip is-warn">{N(a)}</span>)}</p>}
        {r.controls_on_me.length > 0 && <p className="ag-rec-line"><span>{t(T.disables)}</span>{r.controls_on_me.map((c: any, i: number) => <span key={i} className="ag-chip">{N(c.modifier)} · {N(c.from)}{c.duration ? ` · ${c.duration}${t(T.sec)}` : ''}</span>)}</p>}
        {r.observers_within_1600 && <p className="ag-rec-line"><span>{t(T.observers)}</span><span className="ag-chip is-ally">{t(T.mine)} {r.observers_within_1600.my_team}</span><span className="ag-chip is-enemy">{t(T.theirs)} {r.observers_within_1600.enemy}</span></p>}
        {/* Known on its own: a trace with buybacks and no wards, or a death whose position was not sampled, still shows it. */}
        {typeof r.bought_back === 'string' && <p className="ag-rec-line"><span className="ag-chip">{t(T.boughtBack)} {r.bought_back}</span></p>}
        {typeof r.traded_within_15s === 'boolean' && <p className="ag-rec-line"><span className={`ag-chip ${r.traded_within_15s ? 'is-good' : 'is-warn'}`}>{t(T.traded[String(r.traded_within_15s)])}</span></p>}
        {r.allies_elsewhere?.length > 0 && <p className="ag-rec-line"><span>{t(T.alliesElsewhere)}</span>{r.allies_elsewhere.map((h: any) => <span key={h.hero} className="ag-chip">{N(h.hero)}{doingOf(h) && ` · ${doingOf(h)}`}{h.distance != null && <em>{h.distance} {t(T.away)}</em>}{h.respawn_in != null && <em>{t(T.respawn)} {h.respawn_in}{t(T.sec)}</em>}{h.tp_ready != null && <em>{t(T.tp[String(h.tp_ready)])}</em>}</span>)}</p>}
        <p className="ag-rec-sub">{t(T.damage)}</p>
        <ul className="ag-bars">{r.damage_taken.slice(0, 5).map((d: any, i: number) => <Bar key={i} label={`${N(d.from)} · ${d.by === 'attack' ? t(T.attack) : N(d.by)}`} value={d.value} max={max} />)}</ul>
      </div>
    );
  }
  if (data.kind === 'cast') {
    return (
      <div className="ag-rec">
        <p className="ag-rec-head"><b>{r.clock}</b> · {t(T.target)} {N(r.target)}{r.target_hp && <em> {r.target_hp.hp}/{r.target_hp.max_hp}</em>}</p>
        <p className="ag-rec-line">
          {r.target_spell_immune != null && <span className={`ag-chip ${r.target_spell_immune ? 'is-warn' : ''}`}>{t(r.target_spell_immune ? T.immune : T.notImmune)}</span>}
          {r.target_stunned_seconds != null && <span className={`ag-chip ${r.target_stunned_seconds > 0 ? 'is-good' : 'is-warn'}`}>{r.target_stunned_seconds > 0 ? `${t(T.stunned)} ${r.target_stunned_seconds}${t(T.sec)}` : t(T.noStun)}</span>}
        </p>
        <p className="ag-rec-line"><span>{t(T.near)}</span>{[...r.allies_within_1300.map((h: string) => ({ hero: h, c: 'is-ally' })), ...r.enemies_within_1300.map((h: string) => ({ hero: h, c: 'is-enemy' }))].map((h) => <span key={h.hero} className={`ag-chip ${h.c}`}>{N(h.hero)}</span>)}</p>
        <p className="ag-rec-line"><span>{t(T.after)}</span>{r.deaths_within_12s.length ? r.deaths_within_12s.map((d: any, i: number) => <span key={i} className={`ag-chip ${SIDE_CLASS[d.side] ?? ''}`}>{N(d.hero)} <em>+{d.dt}{t(T.sec)}</em></span>) : <span className="ag-none">{t(T.nobody)}</span>}</p>
      </div>
    );
  }
  if (data.kind === 'immune') {
    const w = r.watched;
    return (
      <div className="ag-rec">
        <p className="ag-rec-head"><b>{r.clock}</b> · {N(r.hero)} · {t(T.window)}{r.seconds != null && ` ${r.seconds}${t(T.sec)}`}</p>
        {w && (
          <>
            <p className="ag-rec-line"><span>{t(T.ult)}</span><span className={`ag-chip ${w.state === 'ready' ? 'is-good' : 'is-warn'}`}>{t(T.states[w.state] ?? T.states.unknown)}{w.cooldown_left ? ` · ${w.cooldown_left}${t(T.sec)}` : ''}</span></p>
            {w.last_cast && <p className="ag-rec-line"><span>{t(T.lastCast)}</span><span className="ag-chip">{w.last_cast.clock} → {N(w.last_cast.target)} <em>−{w.last_cast.seconds_before}{t(T.sec)}</em></span></p>}
            <p className="ag-rec-line"><span>{t(T.castDuring)}</span><span className={`ag-chip ${w.cast_on_this_hero_during.length ? 'is-good' : ''}`}>{w.cast_on_this_hero_during.length ? `${t(T.yes)} · ${w.cast_on_this_hero_during.map((c: any) => c.clock).join(', ')}` : t(T.no)}</span></p>
          </>
        )}
      </div>
    );
  }
  if (data.kind === 'fight') {
    return (
      <div className="ag-rec">
        <p className="ag-rec-head"><b>{r.clock}</b> · {t(T.fight)}</p>
        <p className="ag-rec-line"><span>{t(T.lost)}</span><span className="ag-chip is-ally">{t(T.mine)} {r.my_team_deaths}</span><span className="ag-chip is-enemy">{t(T.theirs)} {r.enemy_deaths}</span></p>
        {r.my_team_gold_lead_before != null && <p className="ag-rec-line"><span>{t(T.gold)}</span><span className="ag-chip">{r.my_team_gold_lead_before}</span><span className="ag-chip">{t(T.goldAfter)} {r.my_team_gold_lead_2min_after ?? '—'}</span></p>}
        <p className="ag-rec-line">{r.victims.map((v: any, i: number) => <span key={i} className={`ag-chip ${SIDE_CLASS[v.side] ?? ''}`}>{N(v.hero)}</span>)}</p>
      </div>
    );
  }
  if (data.kind === 'timeline') {
    const pos = r.positions_at_first_death?.heroes ?? r.positions_at_start;
    // Deaths, immunity and buildings always show; casts on a hero and key items fill what room is left, in order.
    const key = (e: any) => e.kind === 'death' || e.kind === 'spell_immune' || e.kind === 'building';
    const room = Math.max(0, 48 - r.events.filter(key).length);
    let extra = 0;
    const rows = r.events.filter((e: any) => key(e) || ((e.kind !== 'cast' || e.target) && (extra += 1) <= room));
    const max = Math.max(...r.damage_to_heroes_by_unit.map((d: any) => d.value), 1);
    return (
      <div className="ag-rec ag-rec--split">
        <MiniMap heroes={pos} N={N as (k: string) => string} label={r.positions_at_first_death ? `${t(T.firstDeath)} · ${r.positions_at_first_death.clock}` : t(T.start)} />
        <div>
          <p className="ag-rec-sub">{t(T.events)} · {r.clock}</p>
          <ol className="ag-events">
            {rows.map((e: any, i: number) => (
              <li key={i} className={`is-${e.kind} ${SIDE_CLASS[e.side] ?? ''}`}>
                <time>{e.clock}</time>
                {e.kind === 'death' && <span><b className="ag-x" aria-hidden="true">✕</b> {N(e.hero)} ← {N(e.killer)}</span>}
                {e.kind === 'spell_immune' && <span>{N(e.hero)} · {t(T.window)}</span>}
                {e.kind === 'item' && <span>{N(e.hero)} · {N(e.item)}</span>}
                {e.kind === 'cast' && <span>{N(e.hero)} · {N(e.ability)} → {N(e.target)}</span>}
                {e.kind === 'building' && <span>{pretty(e.building)}</span>}
              </li>
            ))}
          </ol>
          <p className="ag-rec-sub">{t(T.dealt)}</p>
          <ul className="ag-bars">{r.damage_to_heroes_by_unit.slice(0, 4).map((d: any) => <Bar key={d.unit} label={N(d.unit)} value={d.value} max={max} />)}</ul>
        </div>
      </div>
    );
  }
  if (data.kind === 'item') return <div className="ag-rec"><p className="ag-rec-head"><b>{r.first_held.clock}</b> · {N(r.item)} · {t(T.firstHeld)}</p></div>;
  if (data.kind === 'lane') {
    const pc = (v: number) => `${Math.round(v * 100)}%`;
    const signed = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v)}`;
    const pro = r.same_cores_in_pro_games; const pub = r.same_lane_in_public_games_of_this_bracket;
    return (
      <div className="ag-rec">
        {r.lane
          ? <p className="ag-rec-head">{T.lane[r.lane] ? t(T.lane[r.lane]) : r.lane} · {t(T.laneAt10)} {r.lane_gold_at_10_00.my_team} : {r.lane_gold_at_10_00.enemy}{r.lane_result && T.laneResult[r.lane_result] ? <> · <b>{t(T.laneResult[r.lane_result])}</b></> : null}</p>
          : <p className="ag-rec-note">{t(T.laneNoEconomy)}</p>}
        {r.lane && (
          <div className="ag-lane-scroll">
            <table className="ag-lane">
              <thead><tr>{T.laneCols[lang].map((c) => <th key={c} scope="col">{c}</th>)}</tr></thead>
              <tbody>
                {Object.entries(r.heroes_in_lane as Record<string, string>).map(([h, side]) => (
                  <tr key={h} className={SIDE_CLASS[side] ?? ''}>
                    <th scope="row">{N(h)}</th>
                    {['last_hits_at_5_00', 'last_hits_at_10_00', 'denies_at_10_00', 'gold_at_10_00', 'xp_at_10_00'].map((m) => <td key={m}>{r[m]?.[h] ?? '–'}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {r.my_deaths_before_10_00.length > 0 && <p className="ag-rec-line"><span>{t(T.laneDeaths)}</span>{r.my_deaths_before_10_00.map((d: any) => <span key={d.clock} className="ag-chip">{d.clock}{d.killer ? ` ← ${N(d.killer)}` : ''}</span>)}</p>}
        {pro && <p className="ag-rec-line"><span>{N(pro.my_side_core)} : {N(pro.enemy_core)} · {pro.pro_games} {t(T.lanePro)}</span><span className="ag-chip">{t(T.laneProMean)} <em>{signed(pro.core_gold_difference_at_10_00.mean)}</em></span><span className="ag-chip">{t(T.laneThis)} <em>{signed(pro.core_gold_difference_at_10_00.this_game)}</em></span><span className="ag-chip">{N(pro.my_side_core)} {t(T.laneAhead)} <em>{pc(pro.share_of_pro_games_my_side_core_was_ahead)}</em></span></p>}
        {pub && <p className="ag-rec-line"><span>{N(pub.hero)} : {N(pub.against)} · {pub.lanes} {t(T.lanePub)}</span><span className="ag-chip">{t(T.lanePubWon)} <em>{pc(pub.share_won)}</em></span><span className="ag-chip">{t(T.lanePubLost)} <em>{pc(pub.share_lost)}</em></span></p>}
      </div>
    );
  }
  if (data.kind === 'farm') {
    // One building the team took.
    if (r.building) {
      return (
        <div className="ag-rec">
          <p className="ag-rec-head"><b>{r.clock}</b> · {buildingLabel(r.building, lang)}</p>
          <p className="ag-rec-line"><span className="ag-chip">{t(T.fmAlive)} <em>{r.enemy_heroes_alive}</em></span></p>
          <p className="ag-rec-line"><span>{t(T.fmNear)}</span>{r.enemy_heroes_near_your_team == null ? <span className="ag-chip">{t(T.fmUnknown)}</span> : r.enemy_heroes_near_your_team.length ? r.enemy_heroes_near_your_team.map((h: string) => <span key={h} className="ag-chip is-enemy">{N(h)}</span>) : <span className="ag-chip">{t(T.fmNobody)}</span>}</p>
        </div>
      );
    }
    const gained: Record<string, number | null> | undefined = r.gained ?? r.gained_over_the_game;
    const most = r.gained_most ?? r.gained_most_over_the_game;
    return (
      <div className="ag-rec">
        <p className="ag-rec-head">{r.clock ? <b>{r.clock}</b> : N(r.hero)}{r.ahead ? ` · ${t(r.ahead === 'my_team' ? T.winOurs : T.winTheirs)}` : ''}{r.money ? ` · ${t(r.money === 'replay_net_worth' ? T.fmNw : T.fmGold)}` : ''}</p>
        {gained && (
          <div className="ag-lane-scroll">
            <table className="ag-lane">
              <thead><tr><th scope="col" />{gained ? <th scope="col">{t(T.fmGained)}</th> : null}{r.last_hits ? <th scope="col">{t(T.fmLh)}</th> : null}</tr></thead>
              <tbody>
                {Object.entries(gained).sort((a, b) => (b[1] ?? -1) - (a[1] ?? -1)).map(([h, v]) => (
                  <tr key={h} className={most && (most.my_team === h || most.enemy === h) ? 'is-me' : ''}>
                    <th scope="row">{N(h)}</th><td>{v ?? '–'}</td>{r.last_hits ? <td>{r.last_hits[h] ?? '–'}</td> : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {most && <p className="ag-rec-line"><span>{t(T.fmMost)}</span>{most.my_team && <span className="ag-chip is-ally">{N(most.my_team)}</span>}{most.enemy && <span className="ag-chip is-enemy">{N(most.enemy)}</span>}</p>}
        {r.buildings_your_team_took_total != null && !gained && <p className="ag-rec-line"><span className="ag-chip">{t(T.winTook)} <em>{r.buildings_your_team_took_total}</em></span></p>}
      </div>
    );
  }
  if (data.kind === 'build_plan') {
    const plans = Object.keys(r.gold_in_items_for_each_plan ?? {});
    // The marks from the maps themselves (gold_in_items_for_each_plan_by_15_00, …): the record as served keeps
    // those, while its lists (measured_at among them) are left out of a summary.
    const marks: string[] = Object.keys(r).map((k) => k.match(/^gold_in_items_for_each_plan_by_(\d+)_00$/)).filter((m): m is RegExpMatchArray => Boolean(m)).map((m) => `${m[1]}:00`).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
    const sp = r.stated_plan;
    return (
      <div className="ag-rec">
        {sp && (
          <p className="ag-rec-line"><span>{t(T.bpYours)}</span><span className="ag-chip is-warn">{T.bpPlan[sp.plan] ? t(T.bpPlan[sp.plan]) : sp.plan}</span>
            <span className="ag-chip">{t(T.bpFirst)} <em>{sp.first_item_for_it ? `${sp.first_item_for_it_name ?? N(sp.first_item_for_it)} ${sp.first_item_for_it_at}` : t(T.bpNone)}</em></span>
            <span className="ag-chip">{t(T.bpBefore)} <em>{sp.gold_in_other_big_items_before_it}</em></span>
            {sp.share_of_big_item_gold_for_it != null && <span className="ag-chip">{t(T.bpShare)} <em>{Math.round(sp.share_of_big_item_gold_for_it * 100)}%</em></span>}
          </p>
        )}
        <div className="ag-lane-scroll">
          <table className="ag-lane">
            <caption className="ag-rec-sub">{t(T.bpGold)}</caption>
            <thead><tr><th scope="col" /> {marks.map((m) => <th key={m} scope="col">{t(T.bpBy)} {m}</th>)}<th scope="col">{t(T.bpAll)}</th><th scope="col">{t(T.bpFirst)}</th></tr></thead>
            <tbody>
              {plans.map((p) => (
                <tr key={p} className={sp?.plan === p ? 'is-me' : ''}>
                  <th scope="row">{T.bpPlan[p] ? t(T.bpPlan[p]) : p}</th>
                  {marks.map((m) => <td key={m}>{r[`gold_in_items_for_each_plan_by_${m.replace(':', '_')}`]?.[p] ?? '–'}</td>)}
                  <td>{r.gold_in_items_for_each_plan[p]}</td>
                  <td>{r.first_item_for_each_plan?.[p] ?? '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }
  if (data.kind === 'window') {
    const money = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v)}`;
    const itemChips = (list: any[]) => list.map((x: any) => <span key={x.ref} className="ag-chip">{x.clock} · {N(x.hero)} {x.name}</span>);
    // One window (window:N).
    if (r.ahead) {
      const lastKey = Object.keys(r).find((k) => /_big_items_in_the_last_\d+s$/.test(k));
      const sideOf = (k: string) => (k === 'my_team' ? t(T.mine) : t(T.theirs));
      return (
        <div className="ag-rec">
          <p className="ag-rec-head"><b>{r.clock}</b> · {t(r.ahead === 'my_team' ? T.winOurs : T.winTheirs)} · {t(T.winPeak)} {r.peak_lead.value} ({r.peak_lead.clock})</p>
          <p className="ag-rec-line"><span>{t(T.winTook)}</span><span className="ag-chip is-ally">{t(T.mine)} <em>{r.buildings_taken.my_team}</em></span><span className="ag-chip is-enemy">{t(T.theirs)} <em>{r.buildings_taken.enemy}</em></span></p>
          <p className="ag-rec-line"><span>{t(T.winFights)}</span><span className="ag-chip">{r.fights_lost_fewer_heroes.my_team} · {r.fights_lost_fewer_heroes.enemy}</span></p>
          {(['my_team', 'enemy'] as const).map((k) => r.big_items_finished[k].length > 0 && <p key={k} className="ag-rec-line"><span>{t(T.winItems)} · {sideOf(k)}</span>{itemChips(r.big_items_finished[k])}</p>)}
          {lastKey && r[lastKey].length > 0 && <p className="ag-rec-line"><span>{t(T.winLast)} · {sideOf(lastKey.startsWith('enemy') ? 'enemy' : 'my_team')}</span>{itemChips(r[lastKey])}</p>}
          <p className="ag-rec-note">{t(T.winEnded)} {r.ended.clock}{r.ended.by ? ` · ${t(T.winGameEnd)}` : ` · ${t(T.winLead)} ${money(r.ended.my_team_gold_lead)}`}</p>
        </div>
      );
    }
    // The whole game's lead and its windows (window).
    if (!r.my_team_gold_lead_at) return <div className="ag-rec"><p className="ag-rec-note">{t(T.winNone)}</p></div>;
    return (
      <div className="ag-rec">
        <p className="ag-rec-line"><span>{t(T.winLead)}</span>{Object.entries(r.my_team_gold_lead_at as Record<string, number>).map(([c, v]) => <span key={c} className={`ag-chip ${v > 0 ? 'is-ally' : v < 0 ? 'is-enemy' : ''}`}>{c} <em>{money(v)}</em></span>)}</p>
        <p className="ag-rec-line"><span className="ag-chip">{t(T.winHigh)} {r.highest_lead.clock} <em>{money(r.highest_lead.value)}</em></span><span className="ag-chip">{t(T.winLow)} {r.deepest_deficit.clock} <em>{money(r.deepest_deficit.value)}</em></span></p>
      </div>
    );
  }
  if (data.kind === 'fights' && r.my_team) {
    const side = (s: any, cls: string, label: string) => (
      <div key={label}>
        <p className="ag-rec-sub">{label} · {t(T.lost)} {s.deaths}</p>
        <p className="ag-rec-line"><span>{t(T.tookPart)} {s.took_part_count}</span>{s.took_part.map((h: string) => <span key={h} className={`ag-chip ${cls}`}>{N(h)}</span>)}</p>
        {s.ultimates_ready.length > 0 && <p className="ag-rec-line"><span>{t(T.ultsReady)}</span>{s.ultimates_ready.map((u: any) => <span key={u.hero} className="ag-chip is-good">{N(u.hero)} · {N(u.ability)}</span>)}</p>}
        {s.ultimates_not_ready.length > 0 && <p className="ag-rec-line"><span>{t(T.ultsNot)}</span>{s.ultimates_not_ready.map((u: any) => <span key={u.hero} className="ag-chip is-warn">{N(u.hero)} · {T.why[u.why] ? t(T.why[u.why]) : u.why}{u.seconds_left != null && <em>{u.seconds_left}{t(T.sec)}</em>}</span>)}</p>}
        {typeof s.observers_within_1600_of_the_fight === 'number' && <p className="ag-rec-line"><span>{t(T.observers)}</span><span className="ag-chip">{s.observers_within_1600_of_the_fight}</span></p>}
        {s.black_king_bars_ready.length > 0 && <p className="ag-rec-line"><span>{t(T.bkbReady)}</span>{s.black_king_bars_ready.map((h: string) => <span key={h} className="ag-chip">{N(h)}</span>)}</p>}
        {s.not_in_it.length > 0 && (
          <p className="ag-rec-line"><span>{t(T.notInIt)}</span>{s.not_in_it.map((h: any) => (
            <span key={h.hero} className="ag-chip">{N(h.hero)}{doingOf(h) && ` · ${doingOf(h)}`}{h.distance != null && <em>{h.distance} {t(T.away)}</em>}{h.respawn_in != null && <em>{t(T.respawn)} {h.respawn_in}{t(T.sec)}</em>}{h.tp_ready != null && <em>{t(T.tp[String(h.tp_ready)])}</em>}</span>
          ))}</p>
        )}
      </div>
    );
    return (
      <div className="ag-rec">
        <p className="ag-rec-head"><b>{r.clock}</b> · {t(T.fight)} · {t(T.engaged)} {r.engaged_at}</p>
        {r.my_team_gold_lead != null && <p className="ag-rec-line"><span>{t(T.gold)}</span><span className="ag-chip">{r.my_team_gold_lead}</span></p>}
        {side(r.my_team, 'is-ally', t(T.mine))}
        {side(r.enemy, 'is-enemy', t(T.theirs))}
      </div>
    );
  }
  if (data.kind === 'decision' && r.kind === 'after_a_won_fight') {
    const mine = r.won_by === 'my_team';
    return (
      <div className="ag-rec">
        <p className="ag-rec-head"><b>{r.clock}</b> · {t(T.wonBy[r.won_by])} · {r.deaths.my_team} : {r.deaths.enemy}</p>
        <p className="ag-rec-line"><span>{t(T.stillDead)} {r.losers_still_dead_10s_after}</span>{r.losers_respawn_in.map((x: any) => <span key={x.hero} className={`ag-chip ${mine ? 'is-enemy' : 'is-ally'}`}>{N(x.hero)}{x.seconds != null && <em>{x.seconds}{t(T.sec)}</em>}</span>)}</p>
        <p className="ag-rec-line"><span className={`ag-chip ${r.winners_did === 'took_a_building' ? (mine ? 'is-good' : 'is-warn') : r.winners_did === 'neither' && mine ? 'is-warn' : ''}`}>{t(T.winnersDid[r.winners_did])}</span>
          {r.buildings_winners_took.map((b: any, i: number) => <span key={i} className="ag-chip">{b.clock} · {buildingLabel(b.building, lang)}</span>)}
          {r.roshan_at && <span className="ag-chip">{t(T.roshanBy[r.won_by])} {r.roshan_at}</span>}
        </p>
        {r.losers_richest && <p className="ag-rec-line"><span>{t(T.richest[r.won_by])}</span><span className={`ag-chip ${mine ? 'is-enemy' : 'is-ally'}`}>{N(r.losers_richest.hero)}{r.losers_richest.still_dead_10s_after === true ? r.losers_richest.respawn_in != null && <em>{r.losers_richest.respawn_in}{t(T.sec)}</em> : r.losers_richest.still_dead_10s_after === false && <em>{t(T.richestAlive)}</em>}</span></p>}
        {r.losers_took_back.length > 0 && <p className="ag-rec-line"><span>{t(T.tookBack[r.won_by])}</span>{r.losers_took_back.map((b: any, i: number) => <span key={i} className="ag-chip">{b.clock} · {buildingLabel(b.building, lang)}</span>)}</p>}
      </div>
    );
  }
  if (data.kind === 'decision' && r.kind === 'after_a_tower_fell') {
    const mine = r.taken_by === 'my_team';
    const chips = (list: any[], cls: string) => list.map((b: any, i: number) => <span key={i} className={`ag-chip ${cls}`}>{b.clock} · {buildingLabel(b.building, lang)}</span>);
    return (
      <div className="ag-rec">
        <p className="ag-rec-head"><b>{r.clock}</b> · {t(T.towerBy[r.taken_by])} {buildingLabel(r.building, lang)}{r.after_won_fight && <> · {t(T.afterFight)}</>}</p>
        <p className="ag-rec-line">
          <span className={`ag-chip ${r.takers_did === 'took_another_building' ? (mine ? 'is-good' : 'is-warn') : ''}`}>{t(T.takersDid[r.takers_did])}</span>
          {chips(r.buildings_takers_took_next, '')}
          {r.roshan_at && <span className="ag-chip">{t(T.roshanBy[r.taken_by])} {r.roshan_at}</span>}
        </p>
        {r.owners_took_back.length > 0 && <p className="ag-rec-line"><span>{t(T.tradedBack[r.taken_by])}</span>{chips(r.owners_took_back, mine ? 'is-warn' : 'is-good')}</p>}
        {r.hitting.length > 0 && <p className="ag-rec-line"><span>{t(T.hitting)} {r.hitting.length}</span>{r.hitting.map((h: string) => <span key={h} className={`ag-chip ${mine ? 'is-ally' : 'is-enemy'}`}>{N(h)}</span>)}</p>}
        {T.meAtTower[r.me] && <p className="ag-rec-line"><span className="ag-chip is-me">{t(T.meAtTower[r.me])}{r.my_place && <> · {N(r.my_place)}</>}{r.distance_from_its_hitters != null && <em>{r.distance_from_its_hitters} {t(T.away)}</em>}</span></p>}
      </div>
    );
  }
  if (data.kind === 'decision' && r.kind === 'fight_after_a_big_item') {
    return (
      <div className="ag-rec">
        <p className="ag-rec-head"><b>{r.clock}</b> · {t(T.afterItems)} · {r.deaths.my_team} : {r.deaths.enemy}</p>
        <p className="ag-rec-line">{r.items.map((it: any, i: number) => <span key={i} className={`ag-chip ${it.side === 'my_team' ? 'is-ally' : 'is-enemy'}`}>{N(it.hero)} · {N(it.item)}<em>{it.clock}</em></span>)}</p>
        <p className="ag-rec-line">
          <span className={`ag-chip ${r.lost_fewer === 'my_team' ? 'is-good' : r.lost_fewer === 'enemy' ? 'is-warn' : ''}`}>{t(T.lostFewer[r.lost_fewer])}</span>
          {r.my_team_gold_lead != null && <><span>{t(T.gold)}</span><span className="ag-chip">{r.my_team_gold_lead}</span></>}
        </p>
      </div>
    );
  }
  if (data.kind === 'roshan' && r.aegis_holder) {
    const mine = r.taken_by === 'my_team';
    const heroes = (list: string[] | null, cls: string) => (list == null ? <span className="ag-none">–</span> : list.length ? list.map((h) => <span key={h} className={`ag-chip ${cls}`}>{N(h)}</span>) : <span className="ag-none">{t(T.nobody)}</span>);
    return (
      <div className="ag-rec">
        <p className="ag-rec-head"><b>{r.clock}</b> · {t(T.roshanBy[r.taken_by])}{r.place && <> · {N(r.place)}</>}</p>
        <p className="ag-rec-line">
          <span className="ag-chip">{t(T.aegisHolder)} {N(r.aegis_holder)} · {t(T.aegisEnd[r.aegis] ?? T.aegisEnd.unknown)}{(r.aegis_used_at ?? r.aegis_expired_at) && <em>{r.aegis_used_at ?? r.aegis_expired_at}</em>}</span>
          {r.me && T.roshanMe[r.me] && <span className="ag-chip is-me">{t(T.roshanMe[r.me])}</span>}
        </p>
        <p className="ag-rec-line"><span>{t(T.atRoshan)}</span>{heroes(r.taking_side_near, mine ? 'is-ally' : 'is-enemy')}{heroes(r.other_side_near, mine ? 'is-enemy' : 'is-ally')}</p>
        <p className="ag-rec-line"><span>{t(T.next300)}</span>
          {[...r.buildings_taking_side_took_in_the_next_300s.map((b: any) => ({ ...b, cls: mine ? 'is-good' : 'is-warn' })), ...r.buildings_other_side_took_in_the_next_300s.map((b: any) => ({ ...b, cls: mine ? 'is-warn' : 'is-good' }))]
            .sort((a: any, b: any) => a.clock.localeCompare(b.clock, undefined, { numeric: true }))
            .map((b: any, i: number) => <span key={i} className={`ag-chip ${b.cls}`}>{b.clock} · {buildingLabel(b.building, lang)}</span>)}
          {r.buildings_taking_side_took_in_the_next_300s.length + r.buildings_other_side_took_in_the_next_300s.length === 0 && <span className="ag-none">{t(T.nobody)}</span>}
        </p>
        {r.fights_in_the_next_300s.length > 0 && <p className="ag-rec-line"><span>{t(T.fightsAfter)}</span>{r.fights_in_the_next_300s.map((f: any) => <span key={f.fight} className="ag-chip">{f.clock} · {f.aegis_side_deaths} : {f.other_side_deaths}</span>)}</p>}
      </div>
    );
  }
  if (data.kind === 'sieges' && r.building) {
    const row = (h: any) => <span key={h.hero} className="ag-chip">{N(h.hero)}{doingOf(h) && ` · ${doingOf(h)}`}{h.distance != null && <em>{h.distance} {t(T.away)}</em>}{h.respawn_in != null && <em>{t(T.respawn)} {h.respawn_in}{t(T.sec)}</em>}{h.tp_ready != null && <em>{t(T.tp[String(h.tp_ready)])}</em>}</span>;
    const list = (heroes: string[], cls: string) => (heroes.length ? heroes.map((h) => <span key={h} className={`ag-chip ${cls}`}>{N(h)}</span>) : <span className="ag-none">{t(T.nobody)}</span>);
    const mine = r.pushed_by === 'my_team';
    return (
      <div className="ag-rec">
        <p className="ag-rec-head"><b>{r.clock}–{r.until}</b> · {buildingLabel(r.building, lang)} · {t(T.pushedBy[r.pushed_by])}</p>
        <p className="ag-rec-line">
          <span className={`ag-chip ${r.took_it ? (mine ? 'is-good' : 'is-warn') : ''}`}>{r.took_it ? `${t(T.tookIt)} ${r.fell_at}` : t(T.stood)}</span>
          {T.meAt[r.me] && <span className="ag-chip is-me">{t(T.meAt[r.me])}</span>}
        </p>
        {/* The rows further down are from the push's start; this one is the player at the second the building fell. */}
        {r.me_when_it_fell && <p className="ag-rec-line"><span className="ag-chip is-me">{t(T.meWhenFell)} · {r.me_when_it_fell.known === false ? t(T.placeUnknown) : doingOf(r.me_when_it_fell)}{r.me_when_it_fell.distance != null && <em>{r.me_when_it_fell.distance} {t(T.away)}</em>}{r.me_when_it_fell.respawn_in != null && <em>{t(T.respawn)} {r.me_when_it_fell.respawn_in}{t(T.sec)}</em>}</span></p>}
        <p className="ag-rec-line"><span>{t(T.hitting)} {r.hitting.length}</span>{list(r.hitting, mine ? 'is-ally' : 'is-enemy')}</p>
        <p className="ag-rec-line"><span>{t(T.ownersNear)} {r.owners_near.length}</span>{list(r.owners_near, mine ? 'is-enemy' : 'is-ally')}</p>
        {r.owners_not_near.length > 0 && <p className="ag-rec-line"><span>{t(T.ownersAway)}</span>{r.owners_not_near.map(row)}</p>}
        {r.pushing_side_not_hitting.length > 0 && <p className="ag-rec-line"><span>{t(T.pushOthers)}</span>{r.pushing_side_not_hitting.map(row)}</p>}
      </div>
    );
  }
  if (data.kind === 'state') {
    const yes = (v: boolean | null | undefined) => (v == null ? '–' : t(v ? T.yes : T.no));
    return (
      <div className="ag-rec">
        <p className="ag-rec-head"><b>{r.clock}</b>{r.my_team_gold_lead != null && <> · {t(T.gold)} {r.my_team_gold_lead}</>}</p>
        <div className="ag-lane-scroll">
          <table className="ag-lane">
            <thead><tr>{T.stateCols[lang].map((c) => <th key={c} scope="col">{c}</th>)}</tr></thead>
            <tbody>
              {[['my_team', 'is-ally'], ['enemy', 'is-enemy']].flatMap(([k, cls]) => (r[k]?.heroes ?? []).map((h: any) => (
                <tr key={h.hero} className={cls}>
                  <th scope="row">{N(h.hero)}</th>
                  <td>{h.alive === false ? `${t(T.doing.dead)}${h.respawn_in != null ? ` · ${t(T.respawn)} ${h.respawn_in}${t(T.sec)}` : ''}` : doingOf(h) || '–'}</td>
                  <td>{h.level ?? '–'}</td>
                  <td>{h.hp_pct != null ? `${h.hp_pct}%` : '–'}</td>
                  <td>{h.ultimate ? (h.ultimate.ready === true ? t(T.yes) : h.ultimate.ready === false ? `${t(T.no)}${h.ultimate.seconds_left != null ? ` · ${h.ultimate.seconds_left}${t(T.sec)}` : ''}` : '–') : '–'}</td>
                  <td>{yes(h.black_king_bar_ready)}</td>
                  <td>{yes(h.tp_ready)}</td>
                </tr>
              )))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }
  if (data.kind === 'tempo') {
    const w = r.fights_where; const hit = r.buildings_team_took_where;
    return (
      <div className="ag-rec">
        <p className="ag-rec-head">{N(r.hero)} · {r.duration.clock}</p>
        <div className="ag-lane-scroll">
          <table className="ag-lane">
            <thead><tr>{T.tempoCols[lang].map((c) => <th key={c} scope="col">{c}</th>)}</tr></thead>
            <tbody>
              {Object.keys(r.buildings_team_took_by_phase as Record<string, number>).map((p) => (
                <tr key={p}>
                  <th scope="row">{p}</th>
                  {['buildings_team_took_by_phase', 'buildings_opponents_took_by_phase', 'team_hero_deaths_by_phase', 'opponents_hero_deaths_by_phase'].map((m) => <td key={m}>{r[m]?.[p] ?? '–'}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="ag-rec-line"><span>{t(T.tempoFirst)}</span>{(['by_team', 'by_opponents'] as const).map((k) => <span key={k} className="ag-chip">{t(T.tempoTeams[k.slice(3)])} <em>{r.first_building_taken[k] ?? '–'}</em></span>)}</p>
        <p className="ag-rec-line"><span>{t(T.tempoWon)}</span><span className="ag-chip">{w.team_lost_fewer_heroes.length}</span><span className="ag-chip">{t(T.tempoThen)} <em>{w.team_lost_fewer_heroes_and_took_a_building_within_120s.length}</em></span></p>
        <p className="ag-rec-line"><span>{t(T.tempoLost)}</span><span className="ag-chip">{w.opponents_lost_fewer_heroes.length}</span><span className="ag-chip">{t(T.tempoThen)} <em>{w.opponents_lost_fewer_heroes_and_took_a_building_within_120s.length}</em></span></p>
        <p className="ag-rec-line"><span>{t(T.tempoThere)}</span><span className="ag-chip">{w.hero_was_there.length} / {r.fights_total}</span></p>
        <p className="ag-rec-line"><span>{t(T.tempoHit)}</span><span className="ag-chip">{hit.hero_damaged_it.length} / {r.buildings_total.team_took}</span></p>
      </div>
    );
  }
  if (data.kind === 'phase') {
    const pc = (v: number | null) => (v == null ? '–' : `${Math.round(v * 100)}%`);
    return (
      <div className="ag-rec">
        <p className="ag-rec-head"><b>{r.clock}</b></p>
        {r.buildings.length > 0 && <p className="ag-rec-line"><span>{t(T.tempoBuildings)}</span>{r.buildings.map((b: any, i: number) => <span key={i} className={`ag-chip ${b.taken_by === 'team' ? 'is-ally' : 'is-enemy'}`}>{b.clock} · {t(T.tempoTeams[b.taken_by === 'team' ? 'opponents' : 'team'])} {buildingLabel(b.building, lang)}</span>)}</p>}
        {r.fights.length > 0 && <p className="ag-rec-line"><span>{t(T.tempoFights)}</span>{r.fights.map((f: any) => <span key={f.overview_fight} className="ag-chip">{f.clock} · {f.team_deaths} : {f.opponents_deaths}{f.hero_was_there === false ? <em>{t(T.tempoAway)}</em> : null}</span>)}</p>}
        <p className="ag-rec-sub">{t(T.tempoAlive)} · {r.hero_alive_seconds} {t(T.sec)}</p>
        <p className="ag-rec-line">{Object.entries(r.hero_share_of_alive_time as Record<string, number | null>).map(([k, v]) => <span key={k} className="ag-chip">{T.tempoShare[k] ? t(T.tempoShare[k]) : pretty(k)} <em>{pc(v)}</em></span>)}</p>
        {r.hero_most_time_in && r.hero_most_time_in.length > 0 && <p className="ag-rec-line"><span>{t(T.tempoMost)}</span>{r.hero_most_time_in.map((x: any) => <span key={x.place} className="ag-chip">{N(x.place)} <em>{pc(x.share_of_alive_time)}</em></span>)}</p>}
        <p className="ag-rec-line"><span>{t(T.tempoDamage)}</span><span className="ag-chip">{r.hero_damage_to_buildings}</span><span className="ag-chip">{t(T.tempoOfTeam)} <em>{r.team_heroes_damage_to_buildings}</em></span></p>
      </div>
    );
  }
  if (data.kind === 'lineup_timing') {
    const pc = (v: number | null | undefined) => (v == null ? '–' : `${(v * 100).toFixed(1)}%`);
    const groups = ['under_35_min', 'from_35_to_45_min', 'over_45_min'];
    const sides = ['my_team', 'enemy', 'radiant', 'dire'].filter((k) => r[k]);
    return (
      <div className="ag-rec">
        <p className="ag-rec-head">{r.bracket_name} · {t(T.timingPublic)}{r.this_game ? <> · {t(T.timingThis)} <b>{r.this_game.length}</b></> : null}</p>
        <p className="ag-rec-sub">{r.source} · {r.patch} · {r.weeks.from} – {r.weeks.to}</p>
        <div className="ag-lane-scroll">
          <table className="ag-lane">
            <thead><tr>{T.timingCols[lang].map((c) => <th key={c} scope="col">{c}</th>)}</tr></thead>
            {sides.map((k) => (
              <tbody key={k}>
                {r[k].heroes.map((h: any) => (
                  <tr key={h.hero} className={SIDE_CLASS[k === 'my_team' ? 'ally' : k === 'enemy' ? 'enemy' : ''] ?? ''}>
                    <th scope="row">{N(h.hero)}</th>
                    {groups.map((g) => <td key={g} className={r.this_game?.group === g ? 'is-now' : ''}>{pc(h[`win_rate_${g}`])}</td>)}
                    <td>{h.wins_more_in && T.timingLean[h.wins_more_in] ? t(T.timingLean[h.wins_more_in]) : '–'}</td>
                  </tr>
                ))}
                <tr className="ag-lane-sum">
                  <th scope="row">{t(T.timingSides[k])} · {t(T.timingMean)}</th>
                  {groups.map((g) => <td key={g}>{pc(r[k].mean_win_rate_of_its_heroes[g])}</td>)}
                  <td />
                </tr>
              </tbody>
            ))}
          </table>
        </div>
        <p className="ag-rec-note">{t(T.timingAlone)}</p>
      </div>
    );
  }
  if (data.kind === 'build') {
    const pc = (v: number) => `${Math.round(v * 100)}%`;
    const why = (list: string[]) => (list.length ? list : ['not_classified']).map((p) => (T.purpose[p] ? t(T.purpose[p]) : pretty(p))).join(' · ');
    const d = r.damage_in_my_deaths;
    const answers = (list: any[]) => list.slice(0, 10).map((x: any) => <span key={x.item} className={`ag-chip ${x.player_first_held ? 'is-good' : ''}`}>{x.name} <em>{x.player_first_held ?? t(T.never)}</em></span>);
    return (
      <div className="ag-rec">
        {r.data_patch && <p className="ag-rec-sub">{t(T.dataPatch)} {r.data_patch}</p>}
        <p className="ag-rec-line"><span>{t(T.buildDamage)}</span><span className="ag-chip">{t(T.buildAttacks)} <em>{pc(d.share_from_enemy_attacks)}</em></span><span className="ag-chip">{t(T.buildSpells)} <em>{pc(d.share_from_enemy_abilities_and_items)}</em></span></p>
        <p className="ag-rec-line">{d.by_enemy.slice(0, 5).map((e: any) => <span key={e.enemy} className="ag-chip is-enemy">{N(e.enemy)} · {e.kills_of_me} {t(T.buildKills)} <em>{t(T.buildAttacks)} {pc(e.share_from_their_attacks)} · {t(T.buildSpells)} {pc(e.share_from_their_abilities_and_items)}</em></span>)}</p>
        {r.my_big_items_in_order.length > 0 && (
          <div className="ag-lane-scroll">
            <table className="ag-lane">
              <caption className="ag-rec-sub">{t(T.buildItems)}</caption>
              <thead><tr>{T.buildCols[lang].map((c) => <th key={c} scope="col">{c}</th>)}</tr></thead>
              <tbody>{r.my_big_items_in_order.map((i: any) => <tr key={i.item}><td>{i.first_held}</td><th scope="row">{i.name}</th><td>{i.cost ?? '–'}</td><td>{why(i.built_for)}</td></tr>)}</tbody>
            </table>
          </div>
        )}
        {r.items_that_answer_attack_damage.length > 0 && <p className="ag-rec-line"><span>{t(T.buildAnswers)}</span>{answers(r.items_that_answer_attack_damage)}</p>}
        {r.items_that_answer_spell_damage.length > 0 && <p className="ag-rec-line"><span>{t(T.buildSpellAnswers)}</span>{answers(r.items_that_answer_spell_damage)}</p>}
        {r.most_built_by_pros_on_this_hero && <><p className="ag-rec-sub">{t(T.buildPros)} · {r.most_built_by_pros_on_this_hero.pro_games}</p><ul className="ag-bars">{r.most_built_by_pros_on_this_hero.items.map((i: any) => <Bar key={i.item} label={`${i.name} · ${i.player_first_held ?? t(T.never)}`} value={Math.round(i.share_of_pro_games_with_it_by_24_59 * 100)} max={100} />)}</ul></>}
        {(r.gap_closers.mine || r.gap_closers.enemies.length > 0) && <p className="ag-rec-line"><span>{t(T.buildGaps)}</span>{r.gap_closers.mine && <span className="ag-chip is-me">{t(T.buildYou)} · {r.gap_closers.mine.name} <em>{r.gap_closers.mine.first_held}</em></span>}{r.gap_closers.enemies.map((g: any) => <span key={g.enemy} className="ag-chip is-enemy">{N(g.enemy)} · {g.name} <em>{g.first_held}</em></span>)}</p>}
      </div>
    );
  }
  if (data.kind === 'spikes') {
    const pc = (v: number) => `${(v * 100).toFixed(0)}%`;
    const lv = (x: any, n: number) => x.reached?.[`level_${n}`] ?? '–';
    return (
      <div className="ag-rec">
        <div className="ag-lane-scroll">
          <table className="ag-lane">
            <thead><tr>{T.spikeCols[lang].map((c) => <th key={c} scope="col">{c}</th>)}</tr></thead>
            <tbody>
              <tr className={SIDE_CLASS.me ?? ''}><th scope="row">{N(r.hero)}</th><td>{lv(r.me, 6)}</td><td>{lv(r.me, 12)}</td><td>{lv(r.me, 18)}</td><td /><td /></tr>
              {r.enemies.map((e: any) => { const m = e.my_hero_against_them_in_public_games; return (
                <tr key={e.enemy} className={SIDE_CLASS.enemy ?? ''}><th scope="row">{N(e.enemy)}</th><td>{lv(e, 6)}</td><td>{lv(e, 12)}</td><td>{lv(e, 18)}</td><td>{e.kills_of_me_total}</td><td>{m ? `${pc(m.win_rate)} (${pc(m.my_hero_usually)}) · ${T.spikeMatchup[m.matchup] ? t(T.spikeMatchup[m.matchup]) : m.matchup}` : '–'}</td></tr>
              ); })}
            </tbody>
          </table>
        </div>
        {r.me.ultimate?.cooldown_by_level && <p className="ag-rec-line"><span>{t(T.spikeUlt)}</span><span className="ag-chip">{r.me.ultimate.name} <em>{r.me.ultimate.cooldown_by_level.join(' / ')}</em></span></p>}
        {r.me.big_items.length > 0 && <p className="ag-rec-line"><span>{t(T.buildYou)}</span>{r.me.big_items.map((i: any) => <span key={i.item} className="ag-chip is-me">{i.name} <em>{i.first_held}</em></span>)}</p>}
        {r.enemies.filter((e: any) => e.kills_of_me_total > 0 && e.big_items.length > 0).slice(0, 2).map((e: any) => (
          <p key={e.enemy} className="ag-rec-line"><span>{N(e.enemy)} · {t(T.spikeItems)}</span>{e.big_items.slice(0, 6).map((i: any) => <span key={i.item} className="ag-chip is-enemy">{i.name} <em>{i.first_held} · {i.kills_of_me_before} → {i.kills_of_me_from_then_on}</em></span>)}</p>
        ))}
      </div>
    );
  }
  if (data.kind === 'pro_items') {
    return (
      <div className="ag-rec">
        {r.mid_game_items && <p className="ag-rec-sub">{r.mid_game_items.pro_games} {t(T.proShare)} · {r.mid_game_items.window}</p>}
        <ul className="ag-bars">{(r.mid_game_items?.items ?? []).map((i: any) => <Bar key={i.item} label={`${i.name} · ${i.player_first_held ?? t(T.never)}`} value={Math.round(i.share_of_pro_games * 100)} max={100} />)}</ul>
        {r.built_more_against_these_enemies.length > 0 && <p className="ag-rec-line">{r.built_more_against_these_enemies.map((x: any, i: number) => <span key={i} className="ag-chip">{N(x.enemy)}: {x.name} {Math.round(x.share_of_pro_games_against_this_enemy * 100)}% <em>({Math.round(x.share_usually * 100)}%)</em> · {x.player_first_held ?? t(T.never)}</span>)}</p>}
        <p className="ag-rec-note">{r.note}</p>
      </div>
    );
  }
  if (data.kind === 'abilities') {
    return (
      <div className="ag-rec">
        <p className="ag-rec-sub">{r.source} · {r.patch}</p>
        <p className="ag-rec-line">{r.abilities.map((a: any) => <span key={a.ability} className="ag-chip">{a.name}{a.ultimate ? ` · ${t(T.ultimate)}` : ''}{typeof a.goes_through_spell_immunity === 'boolean' ? ` · ${t(a.goes_through_spell_immunity ? T.pierces : T.noPierce)}` : ''}</span>)}</p>
      </div>
    );
  }
  // A tool's totals (audit:…, deaths:…, immunity:…): the counts themselves.
  const flat: [string, string][] = [];
  const late: [string, unknown][] = [];
  for (const [k, v] of Object.entries(r)) {
    if (k === 'ref' || k === 'ref_scope' || k === 'hero' || k === 'team' || k === 'ability') continue;
    const label = (key: string) => (TOTALS[key] ? t(TOTALS[key]) : null);
    // The amounts behind the shares would say the same thing twice.
    if (k === 'damage_in_death_windows' || k === 'deaths_not_known' || k === 'casts_not_known') continue;
    if (k === 'damage_share_in_death_windows' || k === 'deaths_where' || k === 'casts_where') { late.push([k, v]); continue; }
    if (typeof v === 'number') flat.push([label(k) ?? pretty(k), String(v)]);
    // A moment (learned_at) reads as its clock, not as its raw seconds.
    else if (v && typeof v === 'object' && typeof (v as any).clock === 'string') flat.push([label(k) ?? pretty(k), (v as any).clock]);
    else if (v && typeof v === 'object' && !Array.isArray(v)) for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) if (typeof v2 === 'number') flat.push([`${label(k) ?? pretty(k)} · ${label(k2) ?? N(k2)}`, String(v2)]);
  }
  // What the deaths have in common, then where the damage came from: a count of deaths, a share as a percentage.
  const tl = (key: string) => (TOTALS[key] ? t(TOTALS[key]) : pretty(key));
  // The trade counts have a line of their own: the counters below are cut at 18, and these are what a review cites for
  // its lone deaths (review of #303).
  const TRADES = ['traded_within_15s', 'not_traded_within_15s', 'no_ally_within_2200_at_death_and_not_traded'];
  const trades: [string, string][] = [];
  for (const [k, v] of late) {
    if (!v || typeof v !== 'object') continue;
    for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) {
      if (k === 'deaths_where' && TRADES.includes(k2) && Array.isArray(v2)) { trades.push([tl(k2), String(v2.length)]); continue; }
      if ((k === 'deaths_where' || k === 'casts_where') && Array.isArray(v2)) { if (v2.length) flat.push([tl(k2), String(v2.length)]); }
      else if (k === 'damage_share_in_death_windows' && typeof v2 === 'number') { const cut = k2.indexOf(': '); flat.push([`${tl(k)} · ${cut > 0 ? `${N(k2.slice(0, cut))} ${tl(k2.slice(cut + 2))}` : N(k2)}`, `${Math.round(v2 * 100)}%`]); }
    }
  }
  return (
    <div className="ag-rec">
      <p className="ag-rec-head">{r.clock ?? [r.hero, r.ability].filter(Boolean).map((x: string) => N(x)).join(' · ')}{r.watching ? `${r.hero ? ' · ' : ''}${t(T.watching)} ${N(r.watching.hero)} · ${N(r.watching.ability)}` : ''}</p>
      {trades.length > 0 && <p className="ag-rec-line">{trades.map(([k, v]) => <span key={k} className="ag-chip">{k} <em>{v}</em></span>)}</p>}
      {flat.length > 0 && <p className="ag-rec-line">{flat.slice(0, 18).map(([k, v]) => <span key={k} className="ag-chip">{k} <em>{v}</em></span>)}</p>}
    </div>
  );
}

/** Records that are a moment of the game (not a count over it, a build, or a ten-minute stretch): those can be replayed on the map. */
const MOMENT_REF = /^(death|cast|immune|fight|fights|state|timeline):/;
/** The game second an evidence line's clock names, when its record is a moment; else null. */
export function momentOf(item: EvidenceItem): number | null {
  const m = /^(-)?(\d{1,3}):([0-5]\d)$/.exec(item.clock ?? '');
  if (!m || !MOMENT_REF.test(item.refs[0] ?? '')) return null;
  return (m[1] ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

export const EvidenceCard: React.FC<{ matchId: string; hero: string; lang: Lang; item: EvidenceItem; onAsk: (label: string, refs: string[]) => void }> = ({ matchId, hero, lang, item, onAsk }) => {
  const [open, setOpen] = useState(false);
  const [replay, setReplay] = useState(false);
  const moment = momentOf(item);
  const [records, setRecords] = useState<(EvidenceRecord | null)[] | null>(null);
  useEffect(() => {
    if (!open || records) return;
    let alive = true;
    Promise.all(item.refs.map((ref) => fetchEvidence(matchId, hero, lang, ref).catch(() => null))).then((rs) => { if (alive) setRecords(rs); });
    return () => { alive = false; };
  }, [open, records, item.refs, matchId, hero, lang]);
  const t = (b: Record<Lang, string>) => b[lang];
  return (
    <li className={`ag-ev ${open ? 'is-open' : ''}`}>
      <div className="ag-ev-row">
        {item.clock && <time className="ag-ev-clock">{item.clock}</time>}
        <p className="ag-ev-fact">{item.fact}</p>
      </div>
      <div className="ag-ev-actions">
        <button type="button" className="ag-link" aria-expanded={open} onClick={() => setOpen((v) => !v)}>{t(open ? T.hide : T.show)}</button>
        {moment != null && <button type="button" className="ag-link" aria-expanded={replay} onClick={() => { if (!replay) trackEvent('moment_played', { matchId, lang, hero }); setReplay((v) => !v); }}>{t(replay ? T.replayHide : T.replay)}</button>}
        <button type="button" className="ag-link" onClick={() => onAsk(item.clock ?? item.refs[0], item.refs)}>{t(T.ask)}</button>
      </div>
      {replay && moment != null && <div className="ag-ev-records"><MomentReplay matchId={matchId} hero={hero} lang={lang} t={moment} /></div>}
      {open && (
        <div className="ag-ev-records">
          {!records && <p className="ag-none">{t(T.loading)}</p>}
          {records?.map((rec, i) => (rec ? <Record key={item.refs[i]} data={rec} lang={lang} /> : <p key={item.refs[i]} className="ag-none">{t(T.failed)}</p>))}
        </div>
      )}
    </li>
  );
};
