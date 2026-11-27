import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { CoachApiError, fetchCoachReport, fetchPatchNews, fetchRecentMatches } from './api';
import { markSeen, parseAccountInput, rememberAccount, rememberedAccount, reviewedMatches, seenUntil } from './accountInput';
import type { Bi, Finding, RecentMatch, RecentMatches } from './types';
import { SafeImg, clock, useLang, type Lang } from './ui';
import { AccessModes, HowItWorks } from './HomeBlocks';
import { AUTHOR_EMAIL, AUTHOR_X_URL, GITHUB_ISSUES_URL, HomeFeedback } from './HomeFeedback';
import { accessSnippets } from './accessSnippets';
import { QuickJump, detectSmartInput } from './QuickJump';
import { CURRENT_PATCH, SHIPPED_NEWS, itemIcon, readPatchNews, type PatchNews as PatchNewsData } from './patch';
import { PatchAdvisor } from '../patch/PatchAdvisor';
import { activeGoal, checkGoal, goalChecks, setGoal, useActiveGoal, type GoalCheck } from './goalStore';
import './coach.css';
import './cards.css';
import './review.css';

const EXAMPLE_MATCH = '9091400302';
const SAMPLE_REPLAY_MATCH = '9100904020';

export { SafeImg };

const UI = {
  tagline: { en: 'A Dota 2 coach that watches the replay.', zh: '看录像复盘的 Dota 2 教练。', ru: 'Тренер по Dota 2, который смотрит ваш реплей.' },
  heroTitle: { en: 'Paste a match.\nGet a coach’s read.', zh: '贴一场比赛，\n得到一份教练复盘。', ru: 'Вставьте матч.\nПолучите разбор тренера.' },
  placeholder: { en: 'Match ID or OpenDota / Dotabuff / STRATZ link', zh: '比赛 ID，或 OpenDota / Dotabuff / STRATZ 链接', ru: 'ID матча или ссылка OpenDota / Dotabuff / STRATZ' },
  review: { en: 'Review', zh: '开始复盘', ru: 'Разобрать' },
  clearInput: { en: 'Clear input', zh: '清空输入', ru: 'Очистить поле' },
  invalid: { en: 'That does not look like a match ID.', zh: '这看起来不是一个比赛 ID。', ru: 'Это не похоже на ID матча.' },
  tryExample: { en: 'Try an example', zh: '试试示例', ru: 'Попробовать пример' },
  liveSample: { en: 'Sample review', zh: '查看真实复盘样本', ru: 'Пример разбора' },
  detectedMatch: { en: 'Detected match #{id}', zh: '已识别为比赛 #{id}', ru: 'Распознан матч #{id}' },
  detectedAccount: { en: 'Detected Steam account {id} — opens recent games', zh: '已识别为 Steam 账号 {id}，将打开最近比赛', ru: 'Распознан аккаунт Steam {id} — откроются недавние игры' },
  p1t: { en: 'Evidence first', zh: '证据先行', ru: 'Сначала факты' },
  p1: { en: 'Every point links to the numbers behind it. No vibes, no invented patch facts.', zh: '每条结论都附带依据。不靠感觉，不编造版本数据。', ru: 'Каждый вывод подкреплён цифрами из реплея. Без домыслов и выдуманных патчноутов.' },
  p2t: { en: 'Tells you what to do', zh: '直接告诉你怎么做', ru: 'Конкретное действие' },
  p2: { en: 'Each finding ends in one thing to do next game — with pro games on similar heroes that did it, and did not.', zh: '每条发现都落到下一局要做的一件事，并附上相似英雄职业对局的正例和反例。', ru: 'Каждый вывод заканчивается правилом на следующую игру с примерами из про-матчей.' },
  p3t: { en: 'Says what it can’t see', zh: '说清楚看不到什么', ru: 'Честно о пробелах' },
  p3: { en: 'Unparsed match? You get what the data supports — and a button to parse the rest.', zh: '比赛还没解析？只给数据撑得住的结论，并提供一键解析。', ru: 'Матч не разобран? Покажем только подтверждённые данные и кнопку для разбора.' },
  useAccount: { en: 'No match ID? Use your Steam friend code', zh: '找不到比赛 ID？用 Steam 好友代码', ru: 'Нет ID матча? Используйте код друга Steam' },
  orAccount: { en: 'Your Steam friend code — we list your recent games:', zh: '输入你的 Steam 好友代码，列出你最近的比赛：', ru: 'Ваш код друга Steam — покажем список недавних игр:' },
  accountPlaceholder: { en: 'Friend code, SteamID64 or profile link', zh: '好友代码、SteamID64 或个人资料链接', ru: 'Код друга, SteamID64 или ссылка на профиль' },
  showRecent: { en: 'Show my games', zh: '列出我的比赛', ru: 'Показать матчи' },
  accountInvalid: { en: 'That is not a friend code. In Dota 2 or Steam, open your profile: the friend code is the number under your name.', zh: '这不是好友代码。在 Dota 2 或 Steam 里打开你的个人资料，名字下面那串数字就是好友代码。', ru: 'Это не код друга. Откройте профиль в Dota 2 или Steam — число под ником и есть код друга.' },
  accountVanity: { en: 'Custom Steam URLs can’t be looked up. Paste your friend code or a steamcommunity.com/profiles/… link instead.', zh: '自定义的 Steam 链接没法查询。请改贴好友代码，或 steamcommunity.com/profiles/… 形式的链接。', ru: 'Персональные ссылки Steam не поддерживаются. Вставьте код друга или ссылку вида steamcommunity.com/profiles/…' },
  myGames: { en: 'My recent games', zh: '我的最近比赛', ru: 'Мои недавние игры' },
  myGamesShort: { en: 'My games', zh: '我的比赛', ru: 'Мои игры' },
  recentTitle: { en: 'Your recent games', zh: '你最近的比赛', ru: 'Ваши недавние игры' },
  recentSub: { en: 'Pick a game — the review opens on your hero.', zh: '选一场，复盘会直接打开你的英雄。', ru: 'Выберите игру — разбор откроется сразу для вашего героя.' },
  statGames: { en: 'Matches', zh: '最近场次', ru: 'Матчи' },
  statRecord: { en: 'Win rate', zh: '近期胜率', ru: 'Винрейт' },
  statKda: { en: 'Avg KDA', zh: '场均 KDA', ru: 'Средний KDA' },
  recentEmpty: {
    en: 'No public games for this account. If it is yours, turn on “Expose Public Match Data” in Dota 2’s settings, play a game, then come back.',
    zh: '这个账号没有公开的比赛。如果是你的账号，请在 Dota 2 设置里打开「公开比赛数据」（Expose Public Match Data），打完一局再回来。',
    ru: 'У этого аккаунта нет открытых матчей. Если это ваш аккаунт, включите «Общедоступная история матчей» в настройках Dota 2, сыграйте игру и вернитесь.',
  },
  recentFilterAll: { en: 'All', zh: '全部', ru: 'Все' },
  recentFilterUnreviewed: { en: 'Unreviewed', zh: '未复盘', ru: 'Без разбора' },
  recentFilterRanked: { en: 'Ranked', zh: '天梯', ru: 'Рейтинг' },
  recentLimited: { en: 'OpenDota is unavailable right now, so this list comes from Steam: results, K/D/A and game length are not shown. Open a game to review it.', zh: 'OpenDota 暂时不可用，这份列表来自 Steam：暂不显示胜负、KDA 和比赛时长。点开任意一场即可复盘。', ru: 'OpenDota сейчас недоступна, список получен из Steam: исход, KDA и длительность не показаны. Откройте любой матч для разбора.' },
  recentFilterEmpty: { en: 'No recent games match this filter.', zh: '当前筛选条件下没有比赛。', ru: 'Нет матчей, подходящих под фильтр.' },
  notMe: { en: 'Not you? Forget this account', zh: '不是你？忘掉这个账号', ru: 'Не вы? Забыть аккаунт' },
  latestTitle: { en: 'Your latest game', zh: '你刚打完的那局', ru: 'Ваша последняя игра' },
  latestCta: { en: 'Review it', zh: '复盘这局', ru: 'Разобрать' },
  allRecent: { en: 'All recent games', zh: '全部最近比赛', ru: 'Все недавние игры' },
  reviewedTag: { en: 'Reviewed', zh: '已复盘', ru: 'Разобрано' },
  newTag: { en: 'New', zh: '新', ru: 'Новое' },
  setGoal: { en: 'Make this my next-game goal', zh: '设为下局目标', ru: 'Сделать целью на следующую игру' },
  goalSet: { en: 'Your next-game goal', zh: '已设为下局目标', ru: 'Ваша цель на следующую игру' },
  goalClear: { en: 'Clear', zh: '取消', ru: 'Сбросить' },
  goalCheckTitle: { en: 'Your goal', zh: '你的目标', ru: 'Ваша цель' },
  goalPill: { en: 'Goal', zh: '目标', ru: 'Цель' },
  goalFrom: { en: 'set after game #{id}', zh: '来自 #{id} 那局的复盘', ru: 'после матча #{id}' },
  goalHere: { en: 'You set this goal from this game. Play your next one — the coach checks it automatically.', zh: '目标就是从这局定的。打下一局，教练会自动核验。', ru: 'Эта цель задана по данному матчу. Сыграйте следующий — тренер проверит её автоматически.' },
  goalPending: { en: 'No game checked against it yet — play your next one, then open it here.', zh: '还没有对局核验过这个目标——打完下一局，再在这里打开它。', ru: 'Цель ещё не проверялась — сыграйте следующий матч и откройте его здесь.' },
  goalTally: { en: '{met} of {n} games met', zh: '{n} 局里达成 {met} 局', ru: 'Выполнено в {met} из {n} игр' },
  goalResult: {
    met: { en: 'Met', zh: '达成', ru: 'Выполнено' },
    missed: { en: 'Missed', zh: '未达成', ru: 'Не выполнено' },
    no_opportunity: { en: 'Did not come up', zh: '这局没遇到', ru: 'Не было случая' },
    unknown: { en: 'Can’t tell yet', zh: '暂时判断不了', ru: 'Пока неизвестно' },
  } as Record<string, Bi>,
  win: { en: 'Win', zh: '胜', ru: 'Победа' },
  loss: { en: 'Loss', zh: '负', ru: 'Поражение' },
  patchEyebrow: { en: 'New patch', zh: '新版本', ru: 'Новый патч' },
  patchTitle: { en: 'Patch {v} is live', zh: '{v} 版本已上线', ru: 'Вышел патч {v}' },
  patchNewItems: { en: 'New items', zh: '新装备', ru: 'Новые предметы' },
  patchNotes: { en: 'Full patch notes', zh: '完整更新日志', ru: 'Полный патчноут' },
  patchUpdate: { en: 'Update {v}', zh: '{v} 更新', ru: 'Обновление {v}' },
  patchUpdateChanges: { en: '{h} heroes, {i} items changed', zh: '{h} 位英雄、{i} 件物品调整', ru: 'изменено героев: {h}, предметов: {i}' },
  patchForCoach: { en: 'For your review', zh: '对复盘的影响', ru: 'Для ваших разборов' },
  patchCta: { en: 'Review your first {v} game', zh: '复盘你的第一场 {v}', ru: 'Разобрать первый матч в {v}' },
  patchMore: { en: 'Key changes & impact on reviews', zh: '查看核心改动与对复盘的影响', ru: 'Ключевые изменения и влияние на разборы' },
  loading: { en: 'Reading the match…', zh: '正在读取比赛…', ru: 'Загрузка матча…' },
  radiant: { en: 'Radiant', zh: '天辉', ru: 'Силы Света' },
  dire: { en: 'Dire', zh: '夜魇', ru: 'Силы Тьмы' },
  victory: { en: 'victory', zh: '胜利', ru: 'победа' },
  pick: { en: 'Which hero were you?', zh: '你玩的是哪个英雄？', ru: 'На каком герое вы играли?' },
  pickSub: { en: 'Pick one to get a review written for that seat.', zh: '选一个英雄，复盘会针对这个位置来写。', ru: 'Выберите героя для персонального разбора.' },
  rosterExpand: { en: 'Full 10-player items', zh: '展开 10 人详情', ru: 'Предметы всех 10 игроков' },
  rosterCompact: { en: 'Hide the items', zh: '收起 10 人详情', ru: 'Скрыть предметы' },
  askQuick: { en: 'Ask coach', zh: '追问教练', ru: 'Спросить тренера' },
  verdictEyebrow: { en: 'Biggest lever', zh: '本局核心结论', ru: 'Главный вывод' },
  coachRead: { en: 'Coach’s read', zh: '教练结论', ru: 'Вывод тренера' },
  forYou: { en: 'For you', zh: '你的问题', ru: 'Для вас' },
  forTeam: { en: 'For your team', zh: '全队的问题', ru: 'Для команды' },
  wentWell: { en: 'What went right', zh: '做得好的地方', ru: 'Что получилось хорошо' },
  doNext: { en: 'What to do', zh: '怎么做', ru: 'Что делать' },
  role: { en: 'Seat', zh: '位置', ru: 'Позиция' },
  roleInferred: { en: 'Inferred from farm — lanes unknown until parsed.', zh: '按经济推断——解析前不知道分路。', ru: 'Определено по фарму — линии неизвестны до разбора.' },
  roleLanes: { en: 'Inferred from lanes and farm.', zh: '按分路和经济推断。', ru: 'Определено по линиям и фарму.' },
  roleUser: { en: 'Set by you.', zh: '由你指定。', ru: 'Указано вами.' },
  fixRole: { en: 'Wrong seat? Set it:', zh: '位置不对？手动指定：', ru: 'Неверная позиция? Укажите:' },
  vsHero: { en: 'vs. other games on this hero', zh: '对比同英雄的其他对局', ru: 'по сравнению с другими играми на герое' },
  items: { en: 'Final items', zh: '终局装备', ru: 'Итоговые предметы' },
  matchups: { en: 'Matchups', zh: '对位', ru: 'Матчапы' },
  threats: { en: 'What the enemy brought', zh: '对方阵容的威胁', ru: 'Угрозы пика врага' },
  timeline: { en: 'Key item timings', zh: '关键装备时间', ru: 'Тайминги ключевых предметов' },
  deaths: { en: 'Deaths', zh: '死亡记录', ru: 'Смерти' },
  caught: { en: 'caught', zh: '被抓', ru: 'пойман' },
  fight: { en: 'in a fight', zh: '团战中', ru: 'в драке' },
  notHeroTitle: { en: 'No hero got the kill: tower, creeps or neutrals', zh: '击杀者不是英雄：防御塔、小兵或野怪', ru: 'Убил не герой: башня, крипы или нейтралы' },
  converted: { en: '→ objective lost', zh: '→ 丢了目标', ru: '→ потерян объект' },
  cantSee: { en: 'Not parsed yet — here is what we can’t see', zh: '比赛尚未解析——以下内容暂时看不到', ru: 'Матч ещё не разобран — вот чего мы не видим' },
  cantSeeSub: {
    en: 'OpenDota has not parsed the replay. The read above uses end-of-game data only. Parsing usually takes a few minutes while the replay is still available.',
    zh: 'OpenDota 还没有解析这场录像，上面的结论只用了终局数据。录像仍可下载时，解析通常需要几分钟。',
    ru: 'OpenDota ещё не разобрала реплей. Выводы выше основаны только на итоговой статистике.',
  },
  partialGaps: { en: 'This parse does not include', zh: '这次解析未包含', ru: 'В этом разборе отсутствуют' },
  parseBtn: { en: 'Parse this match', zh: '解析这场比赛', ru: 'Разобрать матч' },
  parsePending: { en: 'Parse requested — checking every 20 seconds…', zh: '已提交解析——每 20 秒检查一次…', ru: 'Разбор запрошен — проверяем каждые 20 с…' },
  parseThrottled: { en: 'Too many parse requests right now. Try again in a minute.', zh: '解析请求太多，请一分钟后再试。', ru: 'Слишком много запросов разбора. Попробуйте через минуту.' },
  parseFailed: { en: 'OpenDota could not take the request. The replay may have expired.', zh: 'OpenDota 没有接受请求，录像可能已过期。', ru: 'OpenDota не приняла запрос. Возможно, реплей уже устарел.' },
  parsedReady: { en: 'Full parse is ready — the review now includes laning, deaths and the gold graph.', zh: '解析完成——复盘已加入对线、死亡与经济曲线。', ru: 'Полный разбор готов — добавлены линии, смерти и график золота.' },
  parseFailedSelf: { en: 'The parse did not go through. Try again in a minute.', zh: '解析没有成功，请一分钟后再试。', ru: 'Разбор не удался. Попробуйте через минуту.' },
  parseGone: { en: 'Valve no longer has this replay (replays are kept about two weeks), so this match cannot be parsed.', zh: 'Valve 已不再保存这场比赛的录像（录像大约保留两周），无法解析这场比赛。', ru: 'У Valve больше нет этого реплея (они хранятся около двух недель), разобрать матч невозможно.' },
  parseGaveUp: { en: 'Still not parsed after 10 minutes. Come back later; the link keeps working.', zh: '10 分钟后仍未解析完成。稍后再来，链接一直有效。', ru: 'Спустя 10 минут разбор всё ещё не готов. Зайдите позже — ссылка останется рабочей.' },
  notFound: { en: 'OpenDota does not know this match. Check the ID — private or very new matches may not be visible yet.', zh: 'OpenDota 找不到这场比赛。请检查 ID——私密比赛或刚结束的比赛可能暂时不可见。', ru: 'OpenDota не нашла этот матч. Проверьте ID — приватные или только что завершившиеся матчи могут быть скрыты.' },
  upstream: { en: 'OpenDota did not answer in time. Try again in a moment.', zh: 'OpenDota 暂时没有响应，请稍后重试。', ru: 'OpenDota не ответила вовремя. Попробуйте чуть позже.' },
  rateLimited: { en: 'Slow down a little — too many requests from your network.', zh: '请求太频繁了，请稍等。', ru: 'Слишком много запросов с вашей сети — подождите немного.' },
  insufficient: { en: 'This match’s player data is not available yet. That is usual for a game that ended a few minutes ago: try again shortly.', zh: '这场比赛的玩家数据还没准备好。比赛刚结束的几分钟内常会这样，请稍后重试。', ru: 'Данные игроков ещё не готовы. Для только что завершённых матчей это нормально — попробуйте через пару минут.' },
  internalError: { en: 'We could not build this review. The fault is on our side, not in your match ID. Try again in a moment.', zh: '复盘生成失败。这是我们这边的问题，不是你的比赛 ID 有误。请稍后重试。', ru: 'Не удалось собрать разбор. Ошибка на нашей стороне — попробуйте чуть позже.' },
  network: { en: 'Could not reach dota2.ai. Check your connection and try again.', zh: '连不上 dota2.ai，请检查网络后重试。', ru: 'Нет связи с dota2.ai. Проверьте подключение и повторите.' },
  retry: { en: 'Try again', zh: '重试', ru: 'Повторить' },
  refreshFailed: { en: 'Could not update the report — what you see may not reflect your latest change.', zh: '报告没能更新——当前显示的可能不是你最新的选择。', ru: 'Не удалось обновить отчёт.' },
  newMatch: { en: 'Another match', zh: '换一场', ru: 'Другой матч' },
  api: { en: 'For agents and scripts', zh: '给 agent 和脚本', ru: 'Для агентов и скриптов' },
  confidence: {
    high: { en: 'high confidence', zh: '高置信', ru: 'высокая уверенность' },
    medium: { en: 'medium confidence', zh: '中等置信', ru: 'средняя уверенность' },
    low: { en: 'low confidence', zh: '低置信', ru: 'низкая уверенность' },
  } as Record<string, Bi>,
  needsParse: { en: 'needs parse', zh: '需解析', ru: 'нужен разбор' },
  noFindings: { en: 'Nothing in the data stands out for this seat.', zh: '数据里没有针对这个位置的突出问题。', ru: 'В данных нет критичных проблем для этой позиции.' },
  share: { en: 'Copy my link', zh: '复制我的链接', ru: 'Копировать ссылку' },
  shareTeam: { en: 'Send to my team', zh: '发给队友', ru: 'Отправить команде' },
  shareTeamText: {
    en: 'Our game #{id} reviewed by dota2.ai — pick your hero and see the one thing worth fixing:',
    zh: '我们那局 #{id} 的复盘（dota2.ai）——点开选你玩的英雄，看看你最该改的一件事：',
    ru: 'Разбор нашей игры #{id} на dota2.ai — выберите своего героя и посмотрите, что стоит исправить:',
  },
  teamCopied: { en: 'Link copied — paste it to your team', zh: '链接已复制，发到队伍群里吧', ru: 'Ссылка скопирована — отправьте её команде' },
  ranked: { en: 'Ranked', zh: '天梯', ru: 'Рейтинг' },
  footer: { en: 'Not affiliated with Valve. Reviews are read from the game\'s replay; scoreboards from OpenDota.', zh: '粉丝项目，与 Valve 无关。复盘读的是对局录像；记分板来自 OpenDota。', ru: 'Не связано с Valve. Разборы строятся по реплею матча; таблицы — из OpenDota.' },
  parsed: { en: 'Parsed', zh: '已解析', ru: 'Разобран' },
  fromSteamGc: { en: 'Scoreboard from Valve’s game coordinator (OpenDota unavailable): no timeline yet', zh: '数据来自 Valve 游戏协调器（OpenDota 暂不可用）：只有终局计分板，暂无时间线', ru: 'Таблица из Valve Game Coordinator (OpenDota недоступна): таймлайна пока нет' },
  fromSteamGcParsed: { en: 'Parsed by dota2.ai from Valve’s replay (OpenDota unavailable): no percentile comparison', zh: '由 dota2.ai 解析 Valve 录像（OpenDota 暂不可用）：暂无百分位对比', ru: 'Разобрано dota2.ai из реплея Valve (OpenDota недоступна): без процентилей' },
  fromStratz: { en: 'Data from STRATZ (OpenDota unavailable)', zh: '数据来自 STRATZ（OpenDota 暂不可用）', ru: 'Данные из STRATZ (OpenDota недоступна)' },
  copied: { en: 'Copied', zh: '已复制', ru: 'Скопировано' },
} satisfies Record<string, Bi | Record<string, Bi>>;

export const AREA: Record<Finding['area'], Bi> = {
  items: { en: 'Items', zh: '出装', ru: 'Предметы' },
  farm: { en: 'Farm', zh: '发育', ru: 'Фарм' },
  deaths: { en: 'Deaths', zh: '死亡', ru: 'Смерти' },
  fights: { en: 'Fights', zh: '团战', ru: 'Драки' },
  objectives: { en: 'Objectives', zh: '目标', ru: 'Объекты' },
  team: { en: 'Team', zh: '全队', ru: 'Команда' },
  laning: { en: 'Laning', zh: '对线', ru: 'Линия' },
  vision: { en: 'Vision', zh: '视野', ru: 'Вижн' },
};

const tally = (goalId: string) => {
  const counted = goalChecks(goalId).filter((c) => c.result === 'met' || c.result === 'missed');
  return { n: counted.length, met: counted.filter((c) => c.result === 'met').length };
};

/* ---------------------------------------------------------------- shell */

/** Compact active-goal indicator in the top bar; details open on click and dismiss on outside click or Escape. */
const GoalNavBadge: React.FC = () => {
  const { lang, L } = useLang();
  const goal = useActiveGoal();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!goal) return null;
  const tl = tally(goal.id);
  return (
    <div ref={wrapRef} className="cx-goal-nav">
      <button type="button" className="cx-goal-pill" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="cx-goal-dot" aria-hidden="true" />
        <span>{L(UI.goalPill)}{tl.n > 0 ? ` ${tl.met}/${tl.n}` : ''}</span>
      </button>
      {open && (
        <div className="cx-popover cx-goal-pop" role="dialog" aria-label={L(UI.goalCheckTitle)}>
          <p className="cx-eyebrow">{L(UI.goalCheckTitle)} · {L(UI.goalFrom).replace('{id}', String(goal.fromMatch))}</p>
          <p className="cx-goal-pop-label"><b>{L(goal.goal.label)}</b></p>
          {tl.n > 0 && <p className="cx-muted">{L(UI.goalTally).replace('{n}', String(tl.n)).replace('{met}', String(tl.met))}</p>}
          <div className="cx-goal-pop-actions">
            <Link to={`/r/${goal.fromMatch}?lang=${lang}`} onClick={() => setOpen(false)}>#{goal.fromMatch} →</Link>
            <button type="button" className="cx-linkbtn" onClick={() => { setGoal(null); setOpen(false); }}>{L(UI.goalClear)}</button>
          </div>
        </div>
      )}
    </div>
  );
};

export const Shell: React.FC<{ children: React.ReactNode; wide?: boolean; isHome?: boolean; hideMyGames?: boolean }> = ({
  children,
  wide,
  isHome = false,
  hideMyGames = false,
}) => {
  const { lang, setLang, L } = useLang();
  const known = rememberedAccount();
  return (
    <div className="cx">
      <header className="cx-top">
        <Link to={`/?lang=${lang}`} className="cx-brand" aria-label="dota2.ai home">
          <svg className="cx-mark-svg" width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 2.5L21.5 12L12 21.5L2.5 12Z" stroke="currentColor" strokeWidth="1.75" fill="currentColor" fillOpacity="0.14" />
            <path d="M12 7L17 12L12 17L7 12Z" fill="currentColor" />
          </svg>
          <span className="cx-brand-word">dota2<span className="cx-dot">.ai</span></span>
          <span className="cx-brand-sub">coach</span>
        </Link>
        <div className="cx-top-right">
          {!isHome && <QuickJump />}
          {known && !hideMyGames && (
            <Link to={`/p/${known}?lang=${lang}`} className="cx-top-link">{L(UI.myGamesShort)}</Link>
          )}
          <GoalNavBadge />
          <div className="cx-lang" role="group" aria-label="Language">
            <button type="button" aria-pressed={lang === 'en'} onClick={() => setLang('en')}>EN</button>
            <button type="button" aria-pressed={lang === 'zh'} onClick={() => setLang('zh')}>中文</button>
            <button type="button" aria-pressed={lang === 'ru'} onClick={() => setLang('ru')}>RU</button>
          </div>
        </div>
      </header>
      <main className={wide ? 'cx-main cx-main--wide' : 'cx-main'}>{children}</main>
      <footer className="cx-foot">
        <span className="cx-foot-note">{L(UI.footer)}</span>
        <nav className="cx-foot-links" aria-label="Links">
          <a href={GITHUB_ISSUES_URL} target="_blank" rel="noopener noreferrer">GitHub Issues</a>
          <a href={AUTHOR_X_URL} target="_blank" rel="noopener noreferrer">X (@kilocean)</a>
          <a href={`mailto:${AUTHOR_EMAIL}`}>{AUTHOR_EMAIL}</a>
        </nav>
      </footer>
    </div>
  );
};

/* ----------------------------------------------------------------- home */

/** Coming back after a game: the newest one, one tap from its review. */
const LatestGame: React.FC<{ accountId: string }> = ({ accountId }) => {
  const { lang, L } = useLang();
  const [latest, setLatest] = useState<RecentMatch | null>(null);
  const goal = useActiveGoal();
  useEffect(() => {
    const ac = new AbortController();
    fetchRecentMatches(accountId, ac.signal).then((r) => setLatest(r.matches[0] ?? null)).catch(() => {});
    return () => ac.abort();
  }, [accountId]);
  const all = <Link to={`/p/${accountId}?lang=${lang}`} className="cx-account-known">{latest ? L(UI.allRecent) : L(UI.myGames)} →</Link>;
  if (!latest) return <p className="cx-example">{all}</p>;
  const reviewed = reviewedMatches().has(String(latest.match_id));
  return (
    <div className={`cx-latest ${goal ? 'has-goal' : ''}`}>
      <div className="cx-latest-card">
        <p className="cx-eyebrow">{L(UI.latestTitle)}</p>
        <div className="cx-latest-row">
          {latest.hero.icon ? <SafeImg src={latest.hero.icon} alt="" className="cx-recent-icon" /> : <span className="cx-recent-icon" />}
          <span className="cx-latest-text">
            <b>{lang === 'zh' ? latest.hero.zh : latest.hero.en}</b>{' '}
            <span className={latest.won ? 'is-win' : latest.won === false ? 'is-loss' : ''}>{latest.won == null ? '' : L(latest.won ? UI.win : UI.loss)}</span>{' '}
            <span className="cx-recent-kda">{latest.kda ? latest.kda.join('/') : '—'}</span>
            {reviewed && <span className="cx-tag">{L(UI.reviewedTag)}</span>}
          </span>
          <Link to={`/r/${latest.match_id}?${latest.slot != null ? `p=${latest.slot}&` : ''}lang=${lang}`} className="cx-patch-cta cx-latest-cta">{L(UI.latestCta)}</Link>
        </div>
        <p className="cx-example">{all}</p>
      </div>
      {goal && <LatestGoal goal={goal} latest={latest} />}
    </div>
  );
};

/** Home: judge the newest game against the goal (one report fetch, only when it counts). */
const LatestGoal: React.FC<{ goal: NonNullable<ReturnType<typeof activeGoal>>; latest: RecentMatch }> = ({ goal, latest }) => {
  const { L } = useLang();
  const [check, setCheck] = useState<GoalCheck | null>(null);
  const counts = latest.match_id !== goal.fromMatch && (latest.start_time ?? 0) > goal.fromStart;
  useEffect(() => {
    if (!counts) return;
    const ac = new AbortController();
    fetchCoachReport(String(latest.match_id), { signal: ac.signal })
      .then((r) => {
        // Steam GC history has no seat: find this account in the game, or judge nothing.
        const acct = Number(goal.accountId ?? rememberedAccount());
        const seat = latest.slot ?? r.players.find((p) => p.account_id != null && p.account_id === acct)?.slot;
        if (seat != null) setCheck(checkGoal(goal, r, seat));
      })
      .catch(() => {});
    return () => ac.abort();
  }, [counts, goal, latest.match_id, latest.slot]);
  const tl = tally(goal.id);
  return (
    <div className="cx-latest-goal-card">
      <p className="cx-eyebrow">{L(UI.goalCheckTitle)}{tl.n > 0 ? ` · ${L(UI.goalTally).replace('{n}', String(tl.n)).replace('{met}', String(tl.met))}` : ''}</p>
      <p className="cx-latest-goal">
        <span>{L(goal.goal.label)}</span>
        {check ? <ResultPill r={check.result} /> : !counts ? <span className="cx-muted"> · {L(UI.goalHere)}</span> : null}
      </p>
      {check && <p className="cx-muted">{L(check.evidence)}</p>}
    </div>
  );
};

/* --------------------------------------------------------- recent games */

type RecentFilter = 'all' | 'unreviewed' | 'ranked';

/** Keyed by account: opening another player starts with fresh filters and a fresh "seen" mark. */
export const CoachPlayerPage: React.FC = () => {
  const { accountId = '' } = useParams();
  return <PlayerPage key={accountId} accountId={accountId} />;
};

const PlayerPage: React.FC<{ accountId: string }> = ({ accountId }) => {
  const { lang, L } = useLang();
  const navigate = useNavigate();
  const [data, setData] = useState<RecentMatches | null>(null);
  const [error, setError] = useState<CoachApiError | null>(null);
  const [filter, setFilter] = useState<RecentFilter>('all');
  const [heroFilter, setHeroFilter] = useState<number | null>(null);
  const goal = useActiveGoal();
  // Read once per visit, before this visit marks the list as seen.
  const [seen] = useState(() => (rememberedAccount() === accountId ? seenUntil() : null));
  const [reviewed] = useState(() => reviewedMatches());
  const valid = /^[1-9]\d{0,9}$/.test(accountId) && Number(accountId) <= 2 ** 32 - 1;
  const load = useCallback(async (signal?: AbortSignal) => {
    if (!valid) return;
    setError(null); setData(null);
    try {
      const r = await fetchRecentMatches(accountId, signal);
      setData(r);
      if (r.matches.length) {
        rememberAccount(accountId);
        markSeen(Math.max(...r.matches.map((x) => x.start_time ?? 0)));
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      setError(e instanceof CoachApiError ? e : new CoachApiError('network', String(e), 0));
    }
  }, [accountId, valid]);
  useEffect(() => {
    const ac = new AbortController();
    void load(ac.signal);
    return () => ac.abort();
  }, [load]);

  // A goal belongs to the player it was set from. One without a recorded account (older
  // goals) is shown only on the account this browser remembers: unknown is not "yours".
  const isGoalOwner = Boolean(goal) && (goal!.accountId != null
    ? String(goal!.accountId) === accountId
    : rememberedAccount() === accountId);
  const checkByMatch = useMemo(() => {
    // Goal results belong to the goal's player: never show them on another account's games.
    if (!goal || !isGoalOwner) return new Map<number, GoalCheck>();
    return new Map(goalChecks(goal.id).map((c) => [c.matchId, c]));
    // isGoalOwner can flip once the page remembers this account (after its games load).
  }, [goal, accountId, isGoalOwner]);

  const topHeroes = useMemo(() => {
    if (!data) return [];
    const map = new Map<number, { hero: RecentMatch['hero']; count: number }>();
    for (const m of data.matches) {
      const prev = map.get(m.hero.id);
      map.set(m.hero.id, { hero: m.hero, count: (prev?.count ?? 0) + 1 });
    }
    return [...map.values()].sort((a, b) => b.count - a.count).slice(0, 6);
  }, [data]);

  // Aggregate telemetry strictly over known fields (never treating null as 0 or false).
  const stats = useMemo(() => {
    if (!data || data.matches.length === 0) return null;
    const decided = data.matches.filter((m) => typeof m.won === 'boolean');
    const wins = decided.filter((m) => m.won === true).length;
    const losses = decided.length - wins;
    const winPct = decided.length > 0 ? Math.round((wins / decided.length) * 100) : null;
    const withKda = data.matches.filter((m): m is RecentMatch & { kda: [number, number, number] } => Array.isArray(m.kda) && m.kda.length === 3);
    let kdaRatio: string | null = null;
    if (withKda.length > 0) {
      const sumK = withKda.reduce((s, m) => s + m.kda[0], 0);
      const sumD = withKda.reduce((s, m) => s + m.kda[1], 0);
      const sumA = withKda.reduce((s, m) => s + m.kda[2], 0);
      kdaRatio = ((sumK + sumA) / Math.max(1, sumD)).toFixed(2);
    }
    return { total: data.matches.length, decided: decided.length, wins, losses, winPct, kdaRatio };
  }, [data]);

  if (!valid) return <Shell hideMyGames><ErrorBlock text={L(UI.accountInvalid)} /></Shell>;
  if (error) {
    const text = error.status === 429 ? L(UI.rateLimited) : error.code === 'network' ? L(UI.network) : L(UI.upstream);
    return <Shell hideMyGames><ErrorBlock text={text} onRetry={() => void load()} /></Shell>;
  }
  if (!data) return <Shell hideMyGames><Skeleton label={L(UI.loading)} /></Shell>;

  const filtered = data.matches.filter((m) => {
    if (filter === 'unreviewed' && reviewed.has(String(m.match_id))) return false;
    if (filter === 'ranked' && !m.ranked) return false;
    if (heroFilter != null && m.hero.id !== heroFilter) return false;
    return true;
  });

  const tl = goal ? tally(goal.id) : null;

  return (
    <Shell hideMyGames>
      <section className="cx-recent">
        <div className="cx-recent-head">
          <div>
            <p className="cx-eyebrow">{L(UI.recentTitle)} · <span className="cx-mono">#{accountId}</span></p>
            <h1 className="cx-h2">{L(UI.recentSub)}</h1>
          </div>
          <button type="button" className="cx-ghost" onClick={() => { rememberAccount(null); navigate(`/?lang=${lang}`); }}>
            {L(UI.notMe)}
          </button>
        </div>

        {stats && (stats.winPct != null || stats.kdaRatio != null) && (
          <div className="pl-stats" aria-label={L(UI.recentTitle)}>
            <div className="pl-stat">
              <span className="pl-stat-k">{L(UI.statGames)}</span>
              <b className="pl-stat-v">{stats.total}</b>
            </div>
            {stats.winPct != null && (
              <div className="pl-stat">
                <span className="pl-stat-k">{L(UI.statRecord)}</span>
                <div className="pl-stat-row">
                  <b className="pl-stat-v">{stats.winPct}%</b>
                  <small className="pl-stat-sub">{stats.wins}W – {stats.losses}L</small>
                </div>
                <div className="pl-wr-bar" aria-hidden="true"><span style={{ width: `${stats.winPct}%` }} /></div>
              </div>
            )}
            {stats.kdaRatio != null && (
              <div className="pl-stat">
                <span className="pl-stat-k">{L(UI.statKda)}</span>
                <b className="pl-stat-v">{stats.kdaRatio}</b>
              </div>
            )}
          </div>
        )}

        {goal && isGoalOwner && (
          <div className="cx-goal cx-recent-goal">
            <div className="cx-recent-goal-top">
              <div>
                <p className="cx-eyebrow">{L(UI.goalCheckTitle)} · {L(UI.goalFrom).replace('{id}', String(goal.fromMatch))}</p>
                <p className="cx-goal-label"><b>{L(goal.goal.label)}</b></p>
                {tl && tl.n > 0 ? (
                  <div className="pl-progress">
                    <div className="pl-bar" role="progressbar" aria-valuemin={0} aria-valuemax={tl.n} aria-valuenow={tl.met} aria-label={L(UI.goalCheckTitle)}>
                      <span style={{ width: `${Math.round((tl.met / tl.n) * 100)}%` }} />
                    </div>
                    <p className="cx-goal-tally">{L(UI.goalTally).replace('{n}', String(tl.n)).replace('{met}', String(tl.met))}</p>
                  </div>
                ) : (
                  // Nothing checked yet: say so, never a "0/0" bar.
                  <p className="cx-goal-tally">{L(UI.goalPending)}</p>
                )}
              </div>
              <button type="button" className="cx-linkbtn" onClick={() => setGoal(null)}>{L(UI.goalClear)}</button>
            </div>
          </div>
        )}

        {data.matches.length === 0 ? (
          <p className="cx-recent-empty">{L(UI.recentEmpty)}</p>
        ) : (
          <>
            {data.source === 'steam_web_api' && <p className="cx-notice" role="status">{L(UI.recentLimited)}</p>}
            <div className="cx-recent-controls">
              <div className="cx-filter-bar" role="group" aria-label={L(UI.recentTitle)}>
                {([
                  ['all', UI.recentFilterAll],
                  ['unreviewed', UI.recentFilterUnreviewed],
                  ['ranked', UI.recentFilterRanked],
                ] as const).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    className={`cx-filter-pill ${filter === id ? 'is-on' : ''}`}
                    aria-pressed={filter === id}
                    onClick={() => setFilter(id)}
                  >
                    {L(label)}
                  </button>
                ))}
              </div>
              {topHeroes.length > 1 && (
                <div className="cx-hero-filters" role="group" aria-label="Hero filter">
                  {topHeroes.map(({ hero, count }) => (
                    <button
                      key={hero.id}
                      type="button"
                      className={`cx-hero-chip ${heroFilter === hero.id ? 'is-on' : ''}`}
                      aria-pressed={heroFilter === hero.id}
                      data-count={count > 1 ? `×${count}` : undefined}
                      onClick={() => setHeroFilter((cur) => (cur === hero.id ? null : hero.id))}
                    >
                      {hero.icon && <SafeImg src={hero.icon} alt="" />}
                      <span>{lang === 'zh' ? hero.zh : hero.en}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {filtered.length === 0 ? (
              <p className="cx-recent-empty">{L(UI.recentFilterEmpty)}</p>
            ) : (
              <ul className="cx-recent-list">
                {filtered.map((m) => {
                  const gc = checkByMatch.get(m.match_id);
                  return (
                    <li key={m.match_id}>
                      <Link to={`/r/${m.match_id}?${m.slot != null ? `p=${m.slot}&` : ''}lang=${lang}`} className="cx-recent-row">
                        {m.hero.icon ? <SafeImg src={m.hero.icon} alt="" className="cx-recent-icon" /> : <span className="cx-recent-icon" />}
                        <span className="cx-recent-hero">
                          {lang === 'zh' ? m.hero.zh : m.hero.en}
                          {seen != null && (m.start_time ?? 0) > seen && <span className="cx-tag cx-tag--new">{L(UI.newTag)}</span>}
                          {reviewed.has(String(m.match_id)) && <span className="cx-tag">{L(UI.reviewedTag)}</span>}
                          {gc && <ResultPill r={gc.result} />}
                        </span>
                        <span className={`cx-recent-result ${m.won ? 'is-win' : m.won === false ? 'is-loss' : ''}`}>
                          {m.won == null ? '—' : L(m.won ? UI.win : UI.loss)}
                        </span>
                        <span className="cx-recent-kda">{m.kda ? m.kda.join('/') : '—'}</span>
                        <span className="cx-recent-meta">
                          {/* Only what the source gave: no stray separators around a missing part. */}
                          {[
                            m.mode ? L(m.mode) : null,
                            m.ranked ? L(UI.ranked) : null,
                            m.duration != null ? clock(m.duration) : null,
                            m.start_time ? new Date(m.start_time * 1000).toLocaleDateString(lang === 'zh' ? 'zh-CN' : lang === 'ru' ? 'ru-RU' : 'en-US') : null,
                          ].filter(Boolean).join(' · ')}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </section>
    </Shell>
  );
};

/**
 * The patch news from the server (live from Valve), starting from the one this build shipped with.
 * While the server is still choosing the highlights it is asked again every 20 s, past the browser
 * cache, up to PATCH_NEWS_RETRIES times.
 */
export const PATCH_NEWS_RETRIES = 6;
function useLivePatchNews(): PatchNewsData {
  const [news, setNews] = useState<PatchNewsData>(SHIPPED_NEWS);
  useEffect(() => {
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async (attempt: number) => {
      const got = await fetchPatchNews(ctl.signal, attempt > 0);
      const read = got && readPatchNews(got.body);
      if (ctl.signal.aborted) return;
      if (read) setNews(read);
      if (got?.picking && attempt < PATCH_NEWS_RETRIES) timer = setTimeout(() => void load(attempt + 1), 20_000);
    };
    void load(0);
    return () => { ctl.abort(); if (timer) clearTimeout(timer); };
  }, []);
  return news;
}

/** The patch as one line; new items and what changed for reviews are one click away. */
const PatchNews: React.FC<{ onCta: () => void }> = ({ onCta }) => {
  const { lang, L } = useLang();
  const p = useLivePatchNews();
  const v = (b: Bi) => L(b).replace('{v}', p.version);
  return (
    <section className="cx-patch hm-patchbar" aria-labelledby="cx-patch-title">
      <details className="cx-patch-details">
        <summary>
          <span className="hm-patch-line">
            <time dateTime={p.date}>{p.date}</time>
            <h2 id="cx-patch-title">{v(UI.patchTitle)}</h2>
            <span className="hm-patch-count">{L(UI.patchNewItems)} {p.newItems.length}</span>
          </span>
        </summary>
        <div className="cx-patch-items">
          {p.newItems.map((it) => {
            const name = lang === 'zh' ? it.zh : it.en;
            return (
              <span key={it.key} className="cx-patch-item" title={name}>
                <SafeImg src={itemIcon(it.key)} alt="" className="cx-patch-icon" />
                <span>{name}</span>
              </span>
            );
          })}
        </div>
        <ul className="cx-patch-list">
          {p.highlights.map((h, i) => <li key={i}>{L(h)}</li>)}
        </ul>
        {p.forCoach && <p className="cx-patch-coach"><strong>{L(UI.patchForCoach)}</strong> {L(p.forCoach)}</p>}
      </details>
      <div className="cx-patch-actions">
        <button type="button" className="cx-patch-cta" onClick={onCta}>{v(UI.patchCta)}</button>
        <a href={p.url} target="_blank" rel="noreferrer">{L(UI.patchNotes)} ↗</a>
      </div>
      {p.update && (
        <p className="hm-patch-update">
          <time dateTime={p.update.date}>{p.update.date}</time>
          <a href={p.update.url} target="_blank" rel="noreferrer">{L(UI.patchUpdate).replace('{v}', p.update.version)} ↗</a>
          <span>{L(UI.patchUpdateChanges).replace('{h}', String(p.update.changes.heroes)).replace('{i}', String(p.update.changes.items))}</span>
        </p>
      )}
    </section>
  );
};

/** The review page's snippets: same commands and tool names as the home page (accessSnippets.ts). */
export const AgentSnippets: React.FC<{ matchId: string }> = ({ matchId }) => {
  const { L } = useLang();
  const snippets = accessSnippets(matchId).filter((m) => m.lines.length);
  const [tab, setTab] = useState(snippets[0].mode);
  const cur = snippets.find((m) => m.mode === tab)!;
  return (
    <details className="cx-api cx-api-drawer">
      <summary>{L(UI.api)}</summary>
      <div className="cx-api-tabs" role="tablist" aria-label={L(UI.api)}>
        {snippets.map((m) => (
          <button key={m.mode} type="button" role="tab" aria-selected={tab === m.mode} className={tab === m.mode ? 'is-on' : ''} onClick={() => setTab(m.mode)}>
            {L(m.label)}
          </button>
        ))}
      </div>
      <pre><code>{cur.lines.join('\n')}</code></pre>
      <p className="cx-muted">{L(cur.note)}</p>
    </details>
  );
};

const HOME = {
  title: { en: 'Paste a match.', zh: '贴一场比赛。', ru: 'Вставьте матч.' },
  sub: {
    en: 'A coach that watches your replay. It finds what decided the game, shows the moments that prove it, and tells you what to change next time.',
    zh: '一位会看你录像的教练。找出这局输赢的关键，把证明它的时刻摆给你看，再告诉你下一把改什么。',
    ru: 'Тренер, который смотрит ваш реплей. Он находит, что решило исход игры, показывает ключевые моменты и говорит, что изменить в следующем матче.',
  },
  hint: { en: 'Match ID, link, or friend code', zh: '比赛 ID、链接或好友码', ru: 'ID матча, ссылка или код друга' },
  modeLabel: { en: 'What are you pasting?', zh: '你要输入什么？', ru: 'Что вы вставляете?' },
  modeMatch: { en: 'Match', zh: '比赛', ru: 'Матч' },
  modeAccount: { en: 'Friend code', zh: '好友码', ru: 'Код друга' },
};

export const CoachHome: React.FC = () => {
  const { lang, L } = useLang();
  const navigate = useNavigate();
  const [value, setValue] = useState('');
  const [error, setError] = useState<'invalid' | 'vanity' | 'account' | null>(null);
  // A bare number is both a valid match ID and a valid friend code: the mode says which one it is.
  const [mode, setMode] = useState<'match' | 'account'>('match');
  const inputRef = useRef<HTMLInputElement>(null);
  const detected = useMemo(() => {
    if (mode === 'match') return detectSmartInput(value);
    const r = parseAccountInput(value);
    return r.ok ? { kind: 'account' as const, id: r.accountId } : { kind: 'none' as const };
  }, [value, mode]);
  const known = rememberedAccount();
  // Whose latest game to show: the remembered friend code, or else the player a next-game goal was set
  // for (a goal set from a review knows its account even when the games page was never opened).
  const goalNow = useActiveGoal();
  const latestFor = known ?? (goalNow?.accountId != null && goalNow.accountId > 0 && goalNow.accountId < 2 ** 32 - 1 ? String(goalNow.accountId) : null);

  const go = (raw: string) => {
    if (mode === 'account') {
      const a = parseAccountInput(raw);
      if (a.ok) { navigate(`/p/${a.accountId}?lang=${lang}`); return; }
      setError(a.reason === 'vanity' ? 'vanity' : 'account');
      return;
    }
    const r = detectSmartInput(raw);
    if (r.kind === 'match') { navigate(`/r/${r.id}?lang=${lang}`); return; }
    if (r.kind === 'account') { navigate(`/p/${r.id}?lang=${lang}`); return; }
    setError(r.kind === 'vanity' ? 'vanity' : 'invalid');
  };

  const focusInput = () => { inputRef.current?.focus(); inputRef.current?.scrollIntoView?.({ block: 'center', behavior: 'smooth' }); };
  // The river lights up once the box holds something we can open (the page's one memorable moment).
  const state = detected.kind === 'match' || detected.kind === 'account' ? detected.kind : 'idle';

  return (
    <Shell isHome wide>
      <div className="hm-first">
        <div className="hm-left">
          <section className="cx-hero hm-map" data-state={state}>
            <svg className="hm-minimap" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">
              <polygon className="hm-radiant" points="0,100 0,46 54,100" />
              <polygon className="hm-dire" points="100,0 46,0 100,54" />
              <path className="hm-grid" d="M25,0 V100 M50,0 V100 M75,0 V100 M0,25 H100 M0,50 H100 M0,75 H100" />
              <path className="hm-lane" d="M7,93 L7,9 L91,9" />
              <path className="hm-lane" d="M9,93 L93,93 L93,9" />
              <path className="hm-lane" d="M10,90 L90,10" />
              <path className="hm-river" d="M0,26 C 28,38 44,60 76,100" />
              <circle className="hm-node is-radiant" cx="13" cy="87" r="1.4" />
              <circle className="hm-node is-dire" cx="87" cy="13" r="1.4" />
              <circle className="hm-pit" cx="38" cy="44" r="2.2" />
            </svg>
            <div className="hm-core">
              <p className="cx-eyebrow hm-badge"><span className="hm-badge-dot" aria-hidden="true" />{L(UI.tagline)}</p>
              <h1 className="cx-h1 hm-title">{L(HOME.title)}</h1>
              <p className="hm-sub">{L(HOME.sub)}</p>
              <div className="hm-mode" role="radiogroup" aria-label={L(HOME.modeLabel)}>
                {(['match', 'account'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    role="radio"
                    aria-checked={mode === m}
                    className={mode === m ? 'is-on' : ''}
                    onClick={() => { setMode(m); setError(null); inputRef.current?.focus(); }}
                  >
                    {L(m === 'match' ? HOME.modeMatch : HOME.modeAccount)}
                  </button>
                ))}
              </div>
              <form className="cx-search hm-ford" onSubmit={(e) => { e.preventDefault(); go(value); }}>
                <span className="hm-ford-icon" aria-hidden="true">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="11" cy="11" r="7" />
                    <path d="m20 20-3.5-3.5" />
                  </svg>
                </span>
                <input
                  ref={inputRef}
                  aria-label={L(mode === 'match' ? UI.placeholder : UI.accountPlaceholder)}
                  placeholder={L(mode === 'match' ? UI.placeholder : UI.accountPlaceholder)}
                  value={value}
                  inputMode="text"
                  autoFocus
                  onChange={(e) => { setValue(e.target.value); setError(null); }}
                />
                {value.length > 0 && (
                  <button
                    type="button"
                    className="cx-input-clear"
                    aria-label={L(UI.clearInput)}
                    onClick={() => { setValue(''); setError(null); inputRef.current?.focus(); }}
                  >
                    ✕
                  </button>
                )}
                <button type="submit" className="hm-submit">{detected.kind === 'account' ? L(UI.showRecent) : L(UI.review)}</button>
              </form>
              <div className="hm-status-row">
                <p className="hm-status" aria-live="polite">
                  {mode === 'match' && detected.kind === 'match' && value.trim() !== detected.id
                    ? <span className="cx-detect-pill is-match">{L(UI.detectedMatch).replace('{id}', detected.id)}</span>
                    : detected.kind === 'account'
                      ? <span className="cx-detect-pill is-account">{L(UI.detectedAccount).replace('{id}', detected.id)}</span>
                      : mode === 'account' ? <span className="hm-hint">{L(UI.accountPlaceholder)}</span>
                      : (
                        <span className="hm-hint">
                          {L(HOME.hint)} · {L(UI.tryExample)}:{' '}
                          <button type="button" className="hm-example" onClick={() => go(EXAMPLE_MATCH)}>{EXAMPLE_MATCH}</button>
                        </span>
                      )}
                </p>
                <Link to={`/r/${SAMPLE_REPLAY_MATCH}?hero=beastmaster&lang=${lang}`} className="hm-sample-link">
                  {L(UI.liveSample)} →
                </Link>
              </div>
              {error && <p className="cx-err" role="alert">{L(error === 'vanity' ? UI.accountVanity : error === 'account' ? UI.accountInvalid : UI.invalid)}</p>}
            </div>
          </section>

          {latestFor && <div className="hm-latest"><LatestGame accountId={latestFor} /></div>}
        </div>
        <HowItWorks />
      </div>

      {/* The patch, one block: Valve's news as its top strip, the advisor under it. */}
      <div className="hm-patch">
        <PatchNews onCta={focusInput} />
        <PatchAdvisor lang={lang} version={CURRENT_PATCH.version} notesUrl={CURRENT_PATCH.notesUrl} />
      </div>

      <AccessModes matchId={EXAMPLE_MATCH} onWeb={focusInput} />
      <HomeFeedback />
    </Shell>
  );
};

const ErrorBlock: React.FC<{ text: string; onRetry?: () => void }> = ({ text, onRetry }) => {
  const { lang, L } = useLang();
  return (
    <div className="cx-error">
      <p>{text}</p>
      <div className="cx-error-actions">
        {onRetry && <button type="button" onClick={onRetry}>{L(UI.retry)}</button>}
        <Link to={`/?lang=${lang}`}>{L(UI.newMatch)}</Link>
      </div>
    </div>
  );
};

const Skeleton: React.FC<{ label: string }> = ({ label }) => (
  <div className="cx-skeleton" role="status" aria-live="polite">
    <span className="cx-pulse" />
    <p>{label}</p>
  </div>
);

/** Share links: `ref` tells the next visit how it arrived; the team link has no seat, so each teammate picks their own. */
export function shareLinks(origin: string, matchId: number, slot: number | null, lang: Lang, pos: number | null = null) {
  const team = new URLSearchParams({ ref: 'team' });
  const self = new URLSearchParams();
  if (slot != null) self.set('p', String(slot));
  // A corrected role changes the review itself: the personal link must show the same review.
  if (slot != null && pos != null && Number.isInteger(pos) && pos >= 1 && pos <= 5) self.set('pos', String(pos));
  self.set('ref', 'share');
  if (lang === 'zh' || lang === 'ru') { team.set('lang', lang); self.set('lang', lang); }
  return { team: `${origin}/r/${matchId}?${team}`, self: `${origin}/r/${matchId}?${self}` };
}

const ResultPill: React.FC<{ r: string }> = ({ r }) => {
  const { L } = useLang();
  return <span className={`cx-goal-result is-${r}`}>{L(UI.goalResult[r])}</span>;
};
