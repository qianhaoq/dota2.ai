/**
 * Follow-up questions on a coach report ("追问"). The LLM only rephrases and
 * connects what the deterministic report already established: the prompt
 * carries this player's report as the sole source of facts, and the rules
 * forbid inventing hero/item/patch facts. When no model is available (not
 * configured, cost guard, provider failure) the answer is the report's own
 * text for the chapter the question is about — never an error.
 */

export const ASK_MAX_CHARS = 500;
export const ASK_MAX_HISTORY = 3;
const HISTORY_ANSWER_CHARS = 800;

const clock = (sec) => {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const L = (b, lang) => (b ? (b[lang] ?? b.en ?? '') : '');

/** Row labels in the reader's language, so the model never echoes codes. */
const WORDS = {
  context: {
    lane: { en: 'in lane', zh: '对线期' }, caught: { en: 'caught outside a fight', zh: '团战外被抓' },
    fight_won: { en: 'in a won fight', zh: '赢下的团战' }, fight_lost: { en: 'in a lost fight', zh: '输掉的团战' },
    fight_even: { en: 'in an even fight', zh: '均势团战' }, fight: { en: 'in a fight (result unknown)', zh: '团战（胜负未记录）' },
    unknown: { en: 'context unknown', zh: '场景未知' },
  },
  result: { won: { en: 'won', zh: '赢' }, lost: { en: 'lost', zh: '输' }, even: { en: 'even', zh: '均势' } },
  ult: { used: { en: 'ultimate cast', zh: '大招已放' }, cooldown: { en: 'ultimate on cooldown', zh: '大招冷却中' }, unused: { en: 'ultimate not cast', zh: '大招未放' } },
  absent: { en: 'you were not there', zh: '你不在场' },
  died: { en: 'you died', zh: '你阵亡' },
  dmg: { en: 'your damage', zh: '你的伤害' },
  gold: { en: 'gold lost', zh: '掉金' },
  deathLog: { en: 'Death log (one line per death)', zh: '死亡记录（每行一次死亡）' },
  killer: { en: 'killed by', zh: '击杀者' },
};

/** Validate and normalise the request body. */
export function parseAskBody(body) {
  const question = typeof body?.question === 'string' ? body.question.trim() : '';
  if (!question) return { error: 'empty_question' };
  if (question.length > ASK_MAX_CHARS) return { error: 'question_too_long' };
  const slot = Number(body?.slot);
  if (!Number.isInteger(slot) || slot < 0 || slot > 9) return { error: 'invalid_slot' };
  const pos = body?.pos == null || body.pos === '' ? null : Number(body.pos);
  if (pos != null && (!Number.isInteger(pos) || pos < 1 || pos > 5)) return { error: 'invalid_pos' };
  const lang = body?.lang === 'zh' ? 'zh' : 'en';
  const history = Array.isArray(body?.history) ? body.history.slice(-ASK_MAX_HISTORY)
    .filter((h) => typeof h?.q === 'string' && typeof h?.a === 'string')
    .map((h) => ({ q: h.q.trim().slice(0, ASK_MAX_CHARS), a: h.a.trim().slice(0, HISTORY_ANSWER_CHARS) }))
    .filter((h) => h.q && h.a) : [];
  return { question, slot, pos, lang, history };
}

/**
 * The player's report as plain text — the only facts the model may use.
 * @param {any} report
 * @param {number} slot
 * @param {string} lang
 * @param {any} [cases] case studies already loaded for this player
 */
export function reportContext(report, slot, lang, cases = null) {
  const zh = lang === 'zh';
  const p = report.players[slot];
  const rv = report.reviews[slot];
  const hero = (id) => report.players.find((x) => x.hero.id === id)?.hero?.[lang] ?? (zh ? '非英雄' : 'non-hero');
  const out = [];
  const m = report.match;
  out.push(zh
    ? `比赛 ${m.id}，${m.patch ?? '版本未知'}，时长 ${clock(m.duration)}，比分 天辉 ${m.score[0]} : 夜魇 ${m.score[1]}，${m.radiant_win ? '天辉' : '夜魇'}获胜。`
    : `Match ${m.id}, patch ${m.patch ?? 'unknown'}, ${clock(m.duration)}, Radiant ${m.score[0]} : Dire ${m.score[1]}, ${m.radiant_win ? 'Radiant' : 'Dire'} won.`);
  out.push(zh
    ? `玩家：${p.hero[lang]}（${p.radiant ? '天辉' : '夜魇'}，${L(rv.role.label, lang)}，${rv.won ? '赢' : '输'}），KDA ${p.kda.join('/')}，正补 ${p.last_hits}，GPM ${p.gpm}，XPM ${p.xpm}，终局装备：${p.items.map((i) => i[lang]).join('、') || '无'}。`
    : `Player: ${p.hero[lang]} (${p.radiant ? 'Radiant' : 'Dire'}, ${L(rv.role.label, lang)}, ${rv.won ? 'won' : 'lost'}), KDA ${p.kda.join('/')}, LH ${p.last_hits}, GPM ${p.gpm}, XPM ${p.xpm}, final items: ${p.items.map((i) => i[lang]).join(', ') || 'none'}.`);
  const team = (radiant) => report.players.filter((x) => x.radiant === radiant).map((x) => `${x.hero[lang]} ${x.kda.join('/')}`).join(zh ? '、' : ', ');
  out.push(zh ? `天辉：${team(true)}。夜魇：${team(false)}。` : `Radiant: ${team(true)}. Dire: ${team(false)}.`);
  out.push(`${zh ? '复盘结论' : 'Headline'}: ${L(rv.headline, lang)}`);
  for (const f of rv.findings) out.push(`- [${f.id}] ${L(f.title, lang)}: ${L(f.body, lang)}`);
  const ch = rv.chapters;
  if (ch) {
    const sec = [['story', zh ? '比赛经过' : 'Story'], ['laning', zh ? '对线' : 'Laning'], ['deaths', zh ? '死亡' : 'Deaths'], ['items', zh ? '出装与承伤' : 'Build vs damage'], ['fights', zh ? '团战' : 'Fights']];
    for (const [key, name] of sec) {
      const c = ch[key];
      if (!c) continue;
      out.push(`## ${name}: ${L(c.takeaway, lang)}`);
      for (const pt of c.points ?? []) out.push(`- ${L(pt, lang)}`);
      if (key === 'deaths') {
        // One death per line, killer labelled, so a time is never paired with
        // a neighbouring row's killer.
        out.push(`${L(WORDS.deathLog, lang)}:`);
        for (const d of c.rows) out.push(`- ${clock(d.time)} ${L(WORDS.killer, lang)}${zh ? '：' : ': '}${hero(d.killer)}${zh ? '，' : ', '}${L(WORDS.context[d.context], lang)}${d.gold_lost != null ? `${zh ? '，' : ', '}${L(WORDS.gold, lang)} ${d.gold_lost}` : ''}`);
      }
      if (key === 'fights') {
        out.push(c.rows.map((f) => `${clock(f.start)} ${L(WORDS.result[f.result], lang)} ${f.kills[0]}-${f.kills[1]}${f.present ? ` ${L(WORDS.dmg, lang)} ${f.damage}${f.died ? ` ${L(WORDS.died, lang)}` : ''}${f.ult_state ? ` ${L(WORDS.ult[f.ult_state], lang)}` : ''}` : ` ${L(WORDS.absent, lang)}`}`).join('; '));
      }
      if (key === 'items') {
        out.push(c.rows.map((r) => `${clock(r.time)} ${r.item[lang]}`).join('; '));
      }
    }
    if (ch.plan?.length) {
      out.push(`## ${zh ? '下一局练习' : 'Practice plan'}`);
      for (const pl of ch.plan) out.push(`- ${L(pl.title, lang)}: ${L(pl.why, lang)} ${L(pl.check, lang)}`);
    }
  }
  if (cases?.themes?.length) {
    out.push(`## ${zh ? '相似职业对局（正例 / 反例）' : 'Similar professional games (positive / negative)'}`);
    for (const th of cases.themes) {
      out.push(`### ${L(th.title, lang)}`);
      for (const line of th.summary) out.push(`- ${L(line, lang)}`);
      for (const line of th.analysis) out.push(`- ${L(line, lang)}`);
      const ids = [th.negative && `${zh ? '反例比赛' : 'negative match'} ${th.negative.match_id}`, th.positive && `${zh ? '正例比赛' : 'positive match'} ${th.positive.match_id}`].filter(Boolean);
      if (ids.length) out.push(`- ${ids.join(zh ? '，' : ', ')}`);
    }
  }
  if (report.data_gaps?.length) out.push(`${zh ? '数据缺口' : 'Data gaps'}: ${report.data_gaps.map((g) => L(g, lang)).join('; ')}`);
  return out.join('\n');
}

export function askSystemPrompt(lang) {
  return lang === 'zh'
    ? [
      '你是 Dota 2 赛后复盘教练，正在回答玩家对这份复盘的追问。',
      '规则：',
      '1. 只能使用下面"复盘数据"里的事实和数字；数据里没有的（坐标、视野、技能细节、版本数值、对手意图）直接说"这份数据看不到"，不要猜。',
      '2. 不要编造英雄、物品、技能或版本信息；英雄和物品用数据里的中文名。',
      '3. 引用具体时间和数字（如 22:25、8 次、69%），先给结论再给依据，最后给一条下一局可以执行的建议。',
      '4. 只谈赛后复盘和下一局练习，不提供局内实时辅助。',
      '5. 提到某次死亡时，时间和击杀者必须出自"死亡记录"的同一行；不要把一行的时间和另一行的击杀者拼在一起。说"多次死于某英雄"时，只列该英雄那几行的时间。拿不准就只给时间，不写击杀者。',
      '6. "相似职业对局"是别人的比赛：引用时说明是正例还是反例、哪场比赛，只说"这样做的那一局赢了/输了"，不要说成必然因果。',
      '7. 用简体中文，控制在 250 字以内，可以用短列表。',
    ].join('\n')
    : [
      'You are a Dota 2 post-match coach answering a player\'s follow-up question about this review.',
      'Rules:',
      '1. Use only facts and numbers from the "Report" below. If something is not in it (positions, vision, spell details, patch numbers, enemy intent), say the data does not show it — do not guess.',
      '2. Do not invent hero, item, ability or patch facts; use the names in the report.',
      '3. Cite concrete times and numbers (22:25, 8 deaths, 69%). Lead with the answer, then the evidence, then one thing to do next game.',
      '4. Post-match review and practice only; no in-game real-time assistance.',
      '5. When citing a death, its time and killer must come from the same line of the death log; never pair one line\'s time with another line\'s killer. When saying "died to X several times", list only the times on X\'s lines. If unsure, give the time without a killer.',
      '6. "Similar professional games" are other people\'s games: say whether a case is positive or negative and which match, and describe what went with the win or loss — never as guaranteed cause and effect.',
      '7. Answer in English, under 180 words; short lists are fine.',
    ].join('\n');
}

/** @param {{ report: any, slot: number, lang: string, question: string, history: any[], cases?: any }} input */
export function askMessages({ report, slot, lang, question, history, cases = null }) {
  const ctx = reportContext(report, slot, lang, cases);
  const messages = [
    { role: 'system', content: askSystemPrompt(lang) },
    { role: 'user', content: `${lang === 'zh' ? '复盘数据' : 'Report'}:\n${ctx}` },
    { role: 'assistant', content: lang === 'zh' ? '收到，我只依据这份复盘数据回答。' : 'Understood — I will answer only from this report.' },
  ];
  for (const h of history) {
    messages.push({ role: 'user', content: h.q });
    messages.push({ role: 'assistant', content: h.a });
  }
  messages.push({ role: 'user', content: question });
  return messages;
}

const TOPICS = [
  { key: 'laning', re: /对线|补刀|正补|反补|线上|前 ?10|十分钟|lane|laning|last hit|cs\b/i },
  { key: 'deaths', re: /死|阵亡|被抓|被杀|death|die|died|caught|killed/i },
  { key: 'items', re: /出装|装备|物品|防御|承伤|伤害|跳刀|黑皇|item|build|blink|bkb|damage|armor/i },
  { key: 'fights', re: /团战|大招|开团|fight|ultimate|ult\b|teamfight/i },
  { key: 'story', re: /经济|输|赢|转折|节奏|阶段|lead|gold|lost|won|turn/i },
  { key: 'plan', re: /练|下一局|怎么提升|建议|practi[cs]e|next game|improve/i },
];

/** Deterministic answer from the report itself, by topic. */
export function fallbackAnswer({ report, slot, lang, question }) {
  const zh = lang === 'zh';
  const rv = report.reviews[slot];
  const ch = rv.chapters;
  const topic = TOPICS.find((x) => x.re.test(question))?.key ?? null;
  const lines = [];
  const chapter = (c) => {
    if (!c) return false;
    lines.push(`**${L(c.takeaway, lang)}**`);
    for (const pt of c.points ?? []) lines.push(`- ${L(pt, lang)}`);
    return true;
  };
  let used = false;
  if (ch && topic && topic !== 'plan') used = chapter(ch[topic]);
  if (!used) {
    lines.push(`**${L(rv.headline, lang)}**`);
    for (const f of rv.findings.slice(0, 3)) lines.push(`- ${L(f.title, lang)}${zh ? '：' : ': '}${L(f.body, lang)}`);
  }
  if (ch?.plan?.length) {
    lines.push('', zh ? '下一局：' : 'Next game:');
    for (const p of ch.plan) lines.push(`- ${L(p.title, lang)} — ${L(p.check, lang)}`);
  }
  return lines.join('\n');
}

export const FALLBACK_NOTICE = {
  en: 'AI follow-up is unavailable right now; this answer is the matching part of the report.',
  zh: 'AI 追问暂时不可用，以下是复盘里与问题对应的部分。',
};
