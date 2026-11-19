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

/** The player's report as plain text — the only facts the model may use. */
export function reportContext(report, slot, lang) {
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
        out.push(c.rows.map((d) => `${clock(d.time)} ${hero(d.killer)} ${d.context}${d.gold_lost != null ? ` -${d.gold_lost}g` : ''}`).join('; '));
      }
      if (key === 'fights') {
        out.push(c.rows.map((f) => `${clock(f.start)} ${f.result} ${f.kills[0]}-${f.kills[1]}${f.present ? ` dmg ${f.damage}${f.died ? ' died' : ''}${f.ult_state ? ` ult ${f.ult_state}` : ''}` : ' absent'}`).join('; '));
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
      '5. 用简体中文，控制在 250 字以内，可以用短列表。',
    ].join('\n')
    : [
      'You are a Dota 2 post-match coach answering a player\'s follow-up question about this review.',
      'Rules:',
      '1. Use only facts and numbers from the "Report" below. If something is not in it (positions, vision, spell details, patch numbers, enemy intent), say the data does not show it — do not guess.',
      '2. Do not invent hero, item, ability or patch facts; use the names in the report.',
      '3. Cite concrete times and numbers (22:25, 8 deaths, 69%). Lead with the answer, then the evidence, then one thing to do next game.',
      '4. Post-match review and practice only; no in-game real-time assistance.',
      '5. Answer in English, under 180 words; short lists are fine.',
    ].join('\n');
}

export function askMessages({ report, slot, lang, question, history }) {
  const ctx = reportContext(report, slot, lang);
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
