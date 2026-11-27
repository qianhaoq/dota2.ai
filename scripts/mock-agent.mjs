/**
 * The review agent for the fixture preview server (scripts/mock-review-server.mjs):
 * the real router, service, tools and verifier, over the trace of match
 * 9100904020 — with a scripted "model" and a fake replay pipeline, so nothing
 * leaves the machine and every run gives the same review.
 *
 * - 9100904020: the trace is there from the start.
 * - 9100904100 – 9100904999: the same game under ids with no trace yet; the
 *   fake pipeline "fetches" one in about five seconds. A test takes an id
 *   nobody has used, so a run never meets state left by another.
 * - 8000000001: the replay is gone.
 * The scoreboard for all of them is the identity-free fixture.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { createAgentRouter } from '../lib/agent/router.js';
import { createAgentService } from '../lib/agent/service.js';
import { createJsonStore, createTraceStore } from '../lib/agent/stores.js';
import { proItemsFor } from '../lib/agent/proItems.js';
import { patchForGame } from '../lib/agent/patchData.js';

export const AGENT_MATCH = 9100904020;
/** Ids that start with no replay. */
export const isFreshId = (id) => Number(id) >= 9100904100 && Number(id) <= 9100904999;
export const AGENT_GONE = 8000000001;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The pro numbers the scripted finding quotes, read from the same snapshot the pro_item_choices tool answers
// from (lib/agent/proItems.js; Beastmaster is hero 38; shares rounded as the tool rounds them), so a data refresh never leaves the
// script quoting last week's sample and the verifier removing the finding.
// The sample is the one of the release the fixture game was played on (7.42), as the tool picks it.
const PRO_BM = proItemsFor(38, patchForGame(AGENT_MATCH, null));
const proShare = (key) => Math.round(((PRO_BM.items.find(([k]) => k === key)?.[1] ?? 0) / PRO_BM.games) * 100) / 100;
const call = (name, args, id) => ({ id, name, args });

/** The review the scripted model hands in. Every time and number is in the tool results it asked for. */
export const MOCK_REVIEW = {
  zh: {
    verdict: '原始咆哮没有留给幻影刺客：11 次阵亡里 7 次死在她手上，而她 7 次开黑皇杖时你的大招只吼中过 2 次。',
    mainline: ['30:26 那波团我方 5 人阵亡、对面 3 人，是这局的转折。'],
    findings: [
      {
        title: '咆哮给错了人',
        claim: '10 次咆哮里只有 4 次给了幻影刺客，另有 3 次阵亡时咆哮就绪却没放。',
        evidence: [
          { refs: ['cast:beastmaster:primal_roar:6'], fact: '27:27 吼进她的黑皇杖，仍然晕住 3.4 秒，她在 27:38 阵亡。' },
          { refs: ['immune:phantom_assassin:3:beastmaster-primal_roar'], fact: '30:34 她开黑皇杖时咆哮还在冷却，上一次是 30:25 给了瘟疫法师。' },
          { refs: ['death:beastmaster:9'], fact: '36:05 满血 2915 被连控致死，咆哮就绪没放。' },
          { refs: ['timeline:1805-1860'], fact: '30:26 到 30:48 这波团里，幻影刺客对英雄造成 8524 伤害。' },
        ],
        fix: '对面核心带黑皇杖时，咆哮只留给她；她开了也照吼。',
      },
      {
        title: '没有跳刀也没有黑皇杖',
        claim: '职业比赛里兽王最常出的两件装备，你这局一件都没有。',
        evidence: [{ refs: ['pro_items:beastmaster'], fact: `${PRO_BM.games} 场职业比赛里，闪烁匕首的比例是 ${proShare('blink')}，黑皇杖是 ${proShare('black_king_bar')}；你从未持有。` }],
        fix: '神杖之后先补闪烁匕首或黑皇杖。',
      },
    ],
    game_plan: {
      window: '你们在 19:00 到 29:00 领先，25:00 时最多领先 3565；这段时间你们拆了 2 座建筑、对面拆了 3 座。幻影刺客在 21:29 出了黑皇杖，就在这段领先之内。',
      course: '你们在 18:07 到 19:46 先拆了 3 座外塔，之后只在 25:05 再拆 1 座；对面从 20:02 起拆了 18 座。16 波团战里你们少死人的有 6 波，其中只有 22:57 那一波之后两分钟内拆到了建筑；对面少死人的 9 波里有 5 波之后拆到了。',
      your_part: '16 波团战你到场 15 波。20:00 到 30:00 你 34% 的存活时间在对方半场，对建筑的伤害是 248。',
      main_reason: 'team_play',
      why: '你几乎每波团都在，但 6 波少死人的团只换来 1 次建筑：这主要是队伍没有把团战变成推进，不是你一个人的问题。',
      evidence: [
        { refs: ['tempo:beastmaster'], fact: '16 波团战里你们少死人的 6 波，之后两分钟内拆到建筑的只有 22:57 这 1 波。' },
        { refs: ['window:beastmaster:2'], fact: '19:00 到 29:00 你们领先，最多领先 3565（25:00），期间你们拆了 2 座建筑、对面拆了 3 座。' },
        { refs: ['phase:beastmaster:3'], fact: '20:00 到 30:00 对面拆了 3 座塔（20:02、24:28、25:59），你们在 25:05 拆了 1 座。' },
      ],
    },
    did_well: ['33:27 的咆哮之后，斧王在 33:31 阵亡。'],
    next_game: ['咆哮留给带黑皇杖的核心。', '神杖之后先出闪烁匕首或黑皇杖。'],
    blind_spots: ['录像里没有战争迷雾：判断不了当时能不能看到她。'],
    goal: { kind: 'hold_item', items: ['blink', 'black_king_bar'], finding: 2 },
  },
  en: {
    verdict: 'Primal Roar was never kept for Phantom Assassin: 7 of your 11 deaths were to her, and across her 7 Black King Bars your ultimate landed on her 2 times.',
    mainline: ['The fight at 30:26 cost your team 5 heroes for 3 of theirs: that is where the game turned.'],
    findings: [
      {
        title: 'The roar went to the wrong heroes',
        claim: 'Only 4 of 10 roars were on Phantom Assassin, and 3 of your deaths came with it ready and not cast.',
        evidence: [
          { refs: ['cast:beastmaster:primal_roar:6'], fact: 'At 27:27 you roared into her Black King Bar and she was still stunned 3.4 seconds; she died at 27:38.' },
          { refs: ['immune:phantom_assassin:3:beastmaster-primal_roar'], fact: 'When she went immune at 30:34 the roar was on cooldown: it had gone to Necrophos at 30:25.' },
          { refs: ['death:beastmaster:9'], fact: 'At 36:05 you died from 2915 health to a chain of disables with the roar ready.' },
          { refs: ['timeline:1805-1860'], fact: 'In the fight from 30:26 to 30:48 Phantom Assassin dealt 8524 damage to heroes.' },
        ],
        fix: 'When their carry has a Black King Bar, the roar is hers — cast it even after she turns it on.',
      },
      {
        title: 'No Blink Dagger, no Black King Bar',
        claim: 'The two items professionals build most on Beastmaster: you held neither.',
        evidence: [{ refs: ['pro_items:beastmaster'], fact: `In ${PRO_BM.games} professional games the share with Blink Dagger is ${proShare('blink')} and with Black King Bar ${proShare('black_king_bar')}; you never held either.` }],
        fix: 'After Aghanim\'s, Blink Dagger or Black King Bar comes first.',
      },
    ],
    game_plan: {
      window: 'Your team was ahead from 19:00 to 29:00, by 3565 at most at 25:00; in that time it took 2 buildings and the enemy 3. Phantom Assassin finished Black King Bar at 21:29, inside that lead.',
      course: 'Your team took 3 outer towers from 18:07 to 19:46 and only 1 more, at 25:05; the enemy took 18 buildings from 20:02 on. Of the 16 fights your team lost fewer heroes in 6, and a building followed only the one at 22:57; the enemy lost fewer in 9 fights and took a building after 5 of them.',
      your_part: 'You were at 15 of the 16 fights. From 20:00 to 30:00 you spent 34% of your time alive on the opposing side of the map, and dealt 248 damage to buildings.',
      main_reason: 'team_play',
      why: 'You were at nearly every fight, yet the 6 fights your team came out ahead in brought 1 building: the team did not turn fights into towers, and that is not on you alone.',
      evidence: [
        { refs: ['tempo:beastmaster'], fact: 'Of the 16 fights your team lost fewer heroes in 6; a building followed within two minutes only after the one at 22:57.' },
        { refs: ['window:beastmaster:2'], fact: 'From 19:00 to 29:00 your team was ahead, by 3565 at most (25:00); it took 2 buildings in that time and the enemy 3.' },
        { refs: ['phase:beastmaster:3'], fact: 'From 20:00 to 30:00 the enemy took 3 towers (20:02, 24:28, 25:59) and your team 1, at 25:05.' },
      ],
    },
    did_well: ['After your roar at 33:27, Axe died at 33:31.'],
    next_game: ['Keep the roar for the carry with the Black King Bar.', 'Blink Dagger or Black King Bar right after Aghanim\'s.'],
    blind_spots: ['The replay has no fog of war: whether you could see her is unknown.'],
    goal: { kind: 'hold_item', items: ['blink', 'black_king_bar'], finding: 2 },
  },
  ru: {
    verdict: 'Primal Roar не приберегли для Phantom Assassin: 7 из ваших 11 смертей были от неё, и за её 7 Black King Bar ульт попал по ней лишь 2 раза.',
    mainline: ['Драка на 30:26 стоила вашей команде 5 героев против 3 у врага: именно там игра перевернулась.'],
    findings: [
      {
        title: 'Ульт уходил не в тех героев',
        claim: 'Только 4 из 10 Primal Roar пошли в Phantom Assassin, и 3 раза вы погибли с готовым ультом.',
        evidence: [
          { refs: ['cast:beastmaster:primal_roar:6'], fact: 'На 27:27 вы дали ульт в её Black King Bar, оглушение длилось 3.4 с, и она погибла на 27:38.' },
          { refs: ['immune:phantom_assassin:3:beastmaster-primal_roar'], fact: 'Когда она нажала BKB на 30:34, ульт был на перезарядке — в 30:25 он ушёл в Necrophos.' },
          { refs: ['death:beastmaster:9'], fact: 'На 36:05 вы погибли с 2915 HP в цепочке контроля с готовым Primal Roar.' },
          { refs: ['timeline:1805-1860'], fact: 'В драке с 30:26 по 30:48 Phantom Assassin нанесла 8524 урона героям.' },
        ],
        fix: 'Когда у вражеского керри есть Black King Bar, держите Primal Roar только для неё — применяйте даже поверх BKB.',
      },
      {
        title: 'Нет ни Blink Dagger, ни Black King Bar',
        claim: 'Два самых популярных предмета про-игроков на Beastmaster: вы не купили ни один из них.',
        evidence: [{ refs: ['pro_items:beastmaster'], fact: `В ${PRO_BM.games} про-матчах доля Blink Dagger составляет ${proShare('blink')}, а Black King Bar — ${proShare('black_king_bar')}; у вас не было ни одного.` }],
        fix: 'Сразу после Aghanim\'s Scepter покупайте Blink Dagger или Black King Bar.',
      },
    ],
    game_plan: {
      window: 'Ваша команда вела с 19:00 по 29:00, на пике 3565 на 25:00; за это время вы снесли 2 постройки, а враги 3. Phantom Assassin собрала Black King Bar на 21:29 внутри этого окна.',
      course: 'Ваша команда снесла 3 внешние башни с 18:07 по 19:46 и ещё лишь 1 на 25:05; враги снесли 18 построек начиная с 20:02. Из 16 драк вы потеряли меньше героев в 6, и постройка пала лишь после драки на 22:57; враги выиграли 9 драк и забрали постройку после 5 из них.',
      your_part: 'Вы участвовали в 15 из 16 драк. С 20:00 по 30:00 вы провели 34% времени в живых на стороне соперника и нанесли 248 урона постройкам.',
      main_reason: 'team_play',
      why: 'Вы были почти в каждой драке, но 6 выигранных драк принесли только 1 постройку: команда не конвертировала драки в башни, и это не только ваша вина.',
      evidence: [
        { refs: ['tempo:beastmaster'], fact: 'Из 16 драк ваша команда потеряла меньше героев в 6; постройка в течение двух минут пала лишь после драки на 22:57.' },
        { refs: ['window:beastmaster:2'], fact: 'С 19:00 по 29:00 ваша команда вела (пик 3565 на 25:00), но снесла 2 постройки против 3 у врага.' },
        { refs: ['phase:beastmaster:3'], fact: 'С 20:00 по 30:00 враги снесли 3 башни (20:02, 24:28, 25:59), а ваша команда 1 на 25:05.' },
      ],
    },
    did_well: ['После вашего Primal Roar на 33:27 Axe погиб на 33:31.'],
    next_game: ['Держите Primal Roar для керри с Black King Bar.', 'Покупайте Blink Dagger или Black King Bar сразу после Aghanim\'s.'],
    blind_spots: ['В реплее нет тумана войны: неизвестно, видели ли вы её в тот момент.'],
    goal: { kind: 'hold_item', items: ['blink', 'black_king_bar'], finding: 2 },
  },
};
/** The scripted reading against a named plan: every time and number is in window_report or tempo_report. */
export const MOCK_AGAINST = {
  zh: '你的打法贴合这个思路：16 波团战你到场 15 波，18:45 和 19:46 两座外塔你都打了。但窗口只开了 19:00 到 29:00，这段时间你们拆了 2 座建筑、对面拆了 3 座；幻影刺客 21:29 出了黑皇杖，就在这段领先之内。断在队伍没有把领先换成塔，不在你。',
  en: 'Your play fit the plan: you were at 15 of the 16 fights and hit both outer towers that fell at 18:45 and 19:46. But the window ran only from 19:00 to 29:00, and in it your team took 2 buildings and the enemy 3; Phantom Assassin finished Black King Bar at 21:29, inside that lead. It broke on the team not turning the lead into towers, not on you.',
  ru: 'Ваша игра соответствовала плану: вы были в 15 из 16 драк и били обе внешние башни, павшие на 18:45 и 19:46. Но окно длилось лишь с 19:00 по 29:00, за него вы снесли 2 постройки, а враги 3; Phantom Assassin собрала Black King Bar на 21:29 внутри этого преимущества. План сломался на реализации командного преимущества в башни, не на вас.',
};
export const MOCK_ANSWER = {
  zh: '36:05 那次最不应该：你满血 2915，咆哮就绪，被先手后一个技能都没按出来。\n\n下次看到斧王靠近，先把咆哮交给离你最近的威胁。',
  en: 'The one at 36:05: you were on 2915 health with the roar ready, and never got a spell off after the initiation.\n\nNext time Axe closes in, spend the roar on the nearest threat first.',
  ru: 'Смерть на 36:05: у вас было 2915 HP и готовый Primal Roar, но после инициации вы не нажали ни одной способности.\n\nВ следующий раз, когда Axe сближается, сразу отдавайте ульт в ближайшую угрозу.',
};
/** The answer to "my plan was …": every number is in tempo_report for the player. */
export const MOCK_PLAN_ANSWER = {
  zh: '打法和思路大体一致：16 波团战你到场 15 波，你们在 18:07 到 19:46 拆了 3 座外塔。\n\n没打成主要不在你：你们少死人的 6 波团里，只有 22:57 那一波之后拆到了建筑。',
  en: 'Your play mostly fit the plan: you were at 15 of the 16 fights, and your team took 3 outer towers from 18:07 to 19:46.\n\nWhere it failed was mostly not you: of the 6 fights your team came out ahead in, a building followed only the one at 22:57.',
  ru: 'Ваша игра в целом соответствовала плану: вы были в 15 из 16 драк, а команда снесла 3 внешние башни с 18:07 по 19:46.\n\nПровал был в основном не на вас: из 6 выигранных драк постройка пала только после драки на 22:57.',
};

/** A "model" that asks for the same lookups every time, then submits the canned review / answers the question. */
async function complete({ system, messages, tools }) {
  // Handle trilingual translation call cleanly without delay so switching languages in E2E is instant.
  if (tools.length === 0 && system.includes('Dota 2 coaching translator')) {
    const req = JSON.parse(messages[0]?.content ?? '{}');
    const stated = Boolean(req?.review?.game_plan?.against_your_plan);
    const pack = (l) => {
      const base = MOCK_REVIEW[l];
      return {
        verdict: base.verdict,
        mainline: base.mainline,
        findings: base.findings.map((f) => ({ title: f.title, claim: f.claim, evidence: f.evidence.map((e) => e.fact), fix: f.fix })),
        did_well: base.did_well,
        blind_spots: base.blind_spots,
        game_plan: {
          ...(stated ? { against_your_plan: MOCK_AGAINST[l] } : {}),
          window: base.game_plan.window,
          course: base.game_plan.course,
          your_part: base.game_plan.your_part,
          why: base.game_plan.why,
          evidence: base.game_plan.evidence.map((e) => e.fact),
        },
      };
    };
    const out = {};
    for (const l of Object.keys(req.target_languages ?? {})) if (MOCK_REVIEW[l]) out[l] = pack(l);
    return { text: JSON.stringify(out), usage: { input: 100, output: 100 } };
  }
  // A review takes long enough for the page to show the coach's steps (it polls every 2.5 s); a chat answer is quick.
  await sleep(tools.some((t) => t.name === 'submit_review') ? 2000 : 350);
  const lang = system.includes('简体中文') ? 'zh' : system.includes('на русском языке') ? 'ru' : 'en';
  const last = messages.at(-1);
  if (tools.some((t) => t.name === 'submit_review')) {
    if (last.role === 'user') {
      return { toolCalls: [
        call('match_overview', {}, 'a'), call('death_context', { hero: 'beastmaster' }, 'b'), call('ability_audit', { hero: 'beastmaster', ability: 'primal_roar' }, 'c'),
        call('immunity_windows', { hero: 'phantom_assassin', watch_hero: 'beastmaster', watch_ability: 'primal_roar' }, 'd'),
        call('fight_timeline', { from: 1805, to: 1860 }, 'e'), call('pro_item_choices', { hero: 'beastmaster' }, 'f'),
        call('tempo_report', { hero: 'beastmaster' }, 'g'), call('lineup_timing', {}, 'h'), call('window_report', { hero: 'beastmaster' }, 'i'),
      ] };
    }
    // A review for a plan the player named reads the game against it.
    const stated = /their plan this game was to/.test(messages[0]?.content ?? '');
    const review = stated ? { ...MOCK_REVIEW[lang], game_plan: { ...MOCK_REVIEW[lang].game_plan, against_your_plan: MOCK_AGAINST[lang] } } : MOCK_REVIEW[lang];
    return { toolCalls: [call('submit_review', review, 's')] };
  }
  // A question about the player's plan is answered from the tempo of the game, like the real coach is told to.
  const asked = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  const plan = /思路|my plan|мой план/i.test(asked);
  if (last.role === 'tool') return { text: (plan ? MOCK_PLAN_ANSWER : MOCK_ANSWER)[lang] };
  if (plan) return { toolCalls: [call('tempo_report', { hero: 'beastmaster' }, 'p'), call('lineup_timing', {}, 'r')] };
  return { toolCalls: [call('death_context', { hero: 'beastmaster', index: 9 }, 'q')] };
}

export function createMockAgent({ root, resolveClientIp }) {
  const fixture = gunzipSync(readFileSync(path.join(root, 'packages/review-engine/test/fixtures/trace-9100904020.json.gz')));
  const scoreboard = JSON.parse(readFileSync(path.join(root, 'src/fixtures/agent/match9100904020.scoreboard.json'), 'utf8'));
  const traceFor = (id) => gzipSync(JSON.stringify({ ...JSON.parse(fixture.toString()), match_id: id }));
  const objects = new Map([[`${AGENT_MATCH}.trace.json.gz`, traceFor(AGENT_MATCH)]]);
  const blobs = { get: async (key) => objects.get(key) ?? null, put: async (key, body) => { objects.set(key, body); } };
  const traces = createTraceStore(blobs, { keep: 6 });
  const knows = (id) => Number(id) === AGENT_MATCH || Number(id) === AGENT_GONE || isFreshId(id);
  /** The scoreboard of the fixture game, under whichever of the mock ids was asked for. */
  const getMatchDetail = async (id) => {
    if (!knows(id)) throw Object.assign(new Error('HTTP 404'), { status: 404, upstream: 'opendota' });
    return { ...structuredClone(scoreboard), match_id: Number(id) };
  };
  const pipeline = {
    async run(id, { onStage = () => {} } = {}) {
      if (Number(id) === AGENT_GONE) return { ok: false, reason: 'replay_gone' };
      if (!isFreshId(id)) return { ok: false, reason: 'no_replay_url' };
      for (const stage of ['locating', 'downloading', 'extracting', 'building', 'storing']) { onStage(stage); await sleep(1000); }
      await traces.put(id, traceFor(Number(id)));
      return { ok: true };
    },
  };
  const noLimit = { tryConsume: () => ({ ok: true, retryAfterSec: 0 }) };
  // Readers' words on findings are kept apart from the reviews, as in production (agent/feedback/).
  const said = new Map();
  const feedback = createJsonStore({ get: async (key) => said.get(key) ?? null, put: async (key, body) => { said.set(key, body); } });
  const router = createAgentRouter({
    service: createAgentService({ traces, pipeline, complete, model: 'mock', docs: createJsonStore(blobs), feedback, getMatchDetail }),
    resolveClientIp, readLimiter: noLimit, reviewLimiter: noLimit, chatLimiter: noLimit, parseLimiter: noLimit, parseDailyMax: 1e9,
  });
  return { router, getMatchDetail, knows };
}
