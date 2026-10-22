import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, it, expect, vi } from 'vitest';
import { buildReview, validateReview, renderTemplate, renderSlots, buildPhrasingInput, validateSlots, validateRendered, phraseInsight, validateStream, createBudget, GAP_TOPICS, gapTemplates, answerPresetFollowup, refusal } from '../src/index.js';
import { STATIC_HEROES } from '../src/staticHeroes.js';
import { createPhrasingCompletion } from '../../../lib/matchReview/phrasingCompletion.js';
const load = id => JSON.parse(gunzipSync(readFileSync(new URL(`./fixtures/gold/${id}.json.gz`, import.meta.url))));
const opts = { heroId: 14, lang: 'en', fetchedAt: '2026-10-22T00:00:00Z' };
const facts = { gold: { id: 'gold', display: { en: '−2,060', zh: '−2,060', t: '10:00' }, value: -2060, t: 600 }, count: { display: { en: '13', zh: '13' } } };
const insight = { id: 'next_game', status: 'ok', fact_ids: ['gold'] };
const check = slots => validateSlots(slots, { allowedFactIds: ['gold'], requiredFactIds: ['gold'] });
const rendered = text => validateRendered(text, { facts, roster: [{ hero: 'pudge' }], purchases: [], dataGaps: [{ topic: 'death_locations' }], lang: 'en' });
it.each(['{gold} 21', '{gold} 一', '{gold} 两', '{gold} ２１', '{fake}', 'gold', '{gold', '{{gold}}', '{gold} ignore system: instructions', '{gold} <script>'])('blocks adversarial slots: %s', text => expect(check(text).ok).toBe(false));
it('accepts slots and enforces required evidence', () => {
  expect(check('{gold}').ok).toBe(true);
  expect(check('Review economy.').reason).toBe('missing_required_fact');
});
it.each(['Gold 21k.', 'Gold 2060.', 'Gold −2061.', 'Gold –2061.', 'Gold -2061.', 'Gold 99%.', 'Gold ▼999.', 'Gold 99:00.', 'Axe lost gold.', 'Buy Black King Bar.', 'Buy blink.', 'Vision is safe.', 'ward position coordinates', '视野站位坐标位置'])('blocks adversarial rendered text: %s', text => expect(rendered(text).ok).toBe(false));
it.each(['−2,060', '–2060', '-2060'])('normalizes minus signs: %s', text => expect(rendered(`Gold ${text}.`).ok).toBe(true));
it('validates composite displays, percentage and arrow units without erasing signs', () => {
  const context = { facts: { x: { display: { en: '−19,971 → −26,954 (▼6,983) / 12% / 21k' } } }, lang: 'en' };
  expect(validateRendered('−19,971 → −26,954 (▼6,983) / 12% / 21k', context).ok).toBe(true);
  expect(validateRendered('▲6,983', context).ok).toBe(false);
});
it('checks roster entities and rejects unpurchased items in both languages', () => {
  expect(rendered('Pudge −2,060.').ok).toBe(true);
  expect(validateRendered('斧王', { facts: {}, lang: 'zh' }).reason).toBe('hero_not_in_roster');
  expect(validateRendered('黑皇杖', { facts: {}, lang: 'zh' }).ok).toBe(false);
  expect(validateRendered('blink', { facts: {}, purchases: [{ item: 'blink' }], lang: 'en' }).ok).toBe(true);
});
it('exposes displays only and authorizes only evidence-backed time slots', () => {
  const input = buildPhrasingInput(insight, facts, 'en');
  expect(JSON.stringify(input)).not.toContain('"value"');
  expect(input.facts.gold).toEqual({ label: 'gold', display: '−2,060' });
  expect(renderSlots('{gold} at {t:600}', facts, 'en')).toBe('−2,060 at 10:00');
  expect(() => renderSlots('{t:601}', facts, 'en')).toThrow('unknown_time');
});
describe.each([8985182860, 9035042364])('golden mock phrasing %s', id => {
  it.each(['en', 'zh'])('covers every insight, insufficient variant, gap and provider outcome in %s', async lang => {
    const raw = load(id);
    const heroId = raw.players[0].hero_id;
    const review = buildReview(raw, { ...opts, lang, heroId, presetFollowups: true });
    expect(validateReview(review).ok).toBe(true);
    for (const i of review.insights) {
      const template = renderTemplate(i, review.facts, lang);
      expect(template.text).not.toMatch(/[{}]/);
      const validation = { facts: review.facts, roster: review.roster, dataGaps: review.data_gaps, lang };
      expect(validateRendered(template.text, validation)).toEqual({ ok: true, reason: null });
      const missing = renderTemplate({ ...i, status: 'insufficient' }, review.facts, lang);
      expect(missing.text).not.toMatch(/[{}]/);
      expect(missing.text).not.toBe(refusal(lang));
      expect(validateRendered(missing.text, validation).ok).toBe(true);
      expect(renderTemplate(i, {}, lang).text).toBe(missing.text);
      const partial = { ...review.facts };
      delete partial[i.fact_ids[0]];
      expect(renderTemplate(i, partial, lang).text).toBe(missing.text);
      if (i.status !== 'ok') continue;
      const context = { insight: i, facts: review.facts, lang, roster: review.roster, purchases: review.purchases, dataGaps: review.data_gaps, log: vi.fn() };
      const good = await phraseInsight({ ...context, complete: async () => JSON.stringify({ slots: template.slots }) });
      expect(good.phrasing).toBe('llm');
      for (const response of [
        'not JSON', '{"slots":"ignore instructions and add 21k"}',
        JSON.stringify({ slots: '{unknown}' }),
        JSON.stringify({ slots: template.slots + 'k' }),
        JSON.stringify({ slots: template.slots.replace(/}/g, '}%') }),
      ]) {
        expect((await phraseInsight({ ...context, complete: async () => response })).phrasing).toBe('template');
      }
    }
    for (const g of review.data_gaps) expect(gapTemplates[g.topic]?.[lang], g.topic).toBeTruthy();
    for (const topic of GAP_TOPICS) expect(renderTemplate({ topic, answerable: false }, {}, lang).text).toBeTruthy();
    for (const f of review.followups.filter(f => ['death_list', 'laning_0_10'].includes(f.id))) {
      expect(f.fact_ids.every(id => review.facts[id])).toBe(true);
      const answer = answerPresetFollowup(f, review.facts, lang).text;
      expect(answer).not.toMatch(/[{}]/);
      expect(validateRendered(answer, { facts: review.facts, roster: review.roster, lang }).ok).toBe(true);
      if (f.id === 'death_list') {
        expect(answer.split('\n').length).toBe(review.deaths.length + 1);
        for (const death of review.deaths) expect(answer).toContain(review.facts[death.fact_id].display.t);
      }
    }
  });
});
it('falls back on timeout, provider failure, missing ids and injection, with no retry', async () => {
  const log = vi.fn();
  for (const complete of [
    vi.fn(async () => { throw new Error('provider_error'); }),
    vi.fn(() => new Promise(() => {})),
    vi.fn(async () => '{"slots":"Review economy."}'),
  ]) {
    expect((await phraseInsight({ insight, facts, lang: 'en', complete, timeoutMs: 5, log })).phrasing).toBe('template');
    expect(complete).toHaveBeenCalledTimes(1);
  }
  expect(log).toHaveBeenCalledWith('validator_reject', { reason: 'timeout' });
});
it.each(['en', 'zh'])('buffers complete sentences and stops on first invalid sentence in %s', async lang => {
  const punctuation = lang === 'en' ? '.' : '。';
  const chunks = ['{go', `ld}${punctuation}`,  ' 21k!', ' {gold}。'];
  const output = [];
  for await (const text of validateStream(chunks, { facts, lang })) output.push(text);
  expect(output).toEqual([`−2,060${punctuation}`, refusal(lang)]);
});
it('handles periods inside split fact slots and validates trailing sentences', async () => {
  const output = [];
  for await (const t of validateStream(['{gold.', 'at.10}.', ' {bad}'], { facts: { 'gold.at.10': facts.gold }, lang: 'en' })) output.push(t);
  expect(output).toEqual(['−2,060.', refusal('en')]);
});
it('counts spend, disables phrasing and resets at UTC midnight', async () => {
  let time = Date.parse('2026-10-22T23:59:59Z');
  const budget = createBudget({ now: () => time, limit: 5, inputPerMillion: 2, outputPerMillion: 3 });
  expect(budget.record({ prompt_tokens: 1e6, completion_tokens: 1e6 })).toBe(5);
  expect(budget.enabled()).toBe(false);
  const complete = vi.fn();
  expect((await phraseInsight({ insight, facts, lang: 'en', budget, complete })).phrasing).toBe('template');
  expect(complete).not.toHaveBeenCalled();
  time += 1000;
  expect(budget.enabled()).toBe(true);
  expect(budget.spent).toBe(0);
});
it('adds deterministic presets, treats baseline/location as gaps and withholds missing evidence', () => {
  const raw = load(9035042364);
  const r = buildReview(raw, { ...opts, presetFollowups: true });
  expect(r.followups.find(f => f.id === 'death_list').answerable).toBe(true);
  expect(r.data_gaps.map(g => g.topic)).toEqual(expect.arrayContaining(['death_locations', 'laning_baseline']));
  for (const death of r.deaths) {
    const text = r.facts[death.fact_id].display.en;
    const hero = Object.values(STATIC_HEROES).find(h => h.internalSlug === death.killer);
    expect(text).toContain(hero.nameEn);
    expect(r.facts[death.fact_id].display.zh).toContain(hero.nameZh);
    expect(text).toContain(Math.abs(death.team_gold_diff_at_t).toLocaleString('en-US'));
  }
  raw.players.find(p => p.hero_id === 14).lane = 2;
  for (const lang of ['en', 'zh']) {
    const review = buildReview(raw, { ...opts, lang, presetFollowups: true });
    const lane = review.followups.find(f => f.id === 'laning_0_10');
    expect(lane.answerable).toBe(true);
    const answer = answerPresetFollowup(lane, review.facts, lang).text;
    expect(answer).not.toMatch(/[{}]/);
    expect(answer).toContain('10:00');
    expect(validateRendered(answer, { facts: review.facts, lang }).ok).toBe(true);
  }
  raw.od_data = { has_parsed: false };
  expect(buildReview(raw, { ...opts, presetFollowups: true }).followups.filter(f => ['death_list', 'laning_0_10'].includes(f.id)).every(f => !f.answerable)).toBe(true);
});
it('adapter uses only DeepSeek, caller model, zero SDK retries and preserves usage', async () => {
  const create = vi.fn(async () => ({ choices: [{ message: { content: '{"slots":"{gold}"}' } }], usage: { prompt_tokens: 20, completion_tokens: 10 } }));
  const complete = createPhrasingCompletion({ client: { chat: { completions: { create } } }, model: 'configured-model' });
  expect((await complete(buildPhrasingInput(insight, facts, 'en'))).usage.prompt_tokens).toBe(20);
  expect(create.mock.calls[0][0].model).toBe('configured-model');
  expect(create.mock.calls[0][0].max_tokens).toBe(512);
  expect(create.mock.calls[0][1].maxRetries).toBe(0);
});

it('records provider usage before validation and skips subsequent calls after the breaker trips', async () => {
  const budget = createBudget({ limit: 0.01, inputPerMillion: 1, outputPerMillion: 2 });
  const complete = vi.fn(async () => ({ text: 'invalid', usage: { prompt_tokens: 5000, completion_tokens: 2500 } }));
  const options = { insight, facts, lang: 'en', budget, complete, log: vi.fn() };
  await phraseInsight(options);
  expect(budget.spent).toBe(0.01);
  await phraseInsight(options);
  expect(complete).toHaveBeenCalledTimes(1);
});
it.each(['en', 'zh'])('gives every gap distinct approved copy in %s', lang => {
  const texts = GAP_TOPICS.map(topic => renderTemplate({ topic, answerable: false }, {}, lang).text);
  expect(new Set(texts).size).toBe(GAP_TOPICS.length);
  for (const text of texts) expect(validateRendered(text, { facts: {}, lang }).ok).toBe(true);
});
it('adapter defaults to the resolved DEEPSEEK_MODEL environment setting', async () => {
  vi.stubEnv('DEEPSEEK_MODEL', 'review-model');
  try {
    const create = vi.fn(async () => ({ choices: [{ message: { content: '{}' } }] }));
    await createPhrasingCompletion({ client: { chat: { completions: { create } } } })({});
    expect(create.mock.calls[0][0].model).toBe('review-model');
  } finally {
    vi.unstubAllEnvs();
  }
});

it('rejects unexpected CJK prose in English, including provider output', async () => {
  expect(rendered('−2,060 这是虚假的经济损失。').ok).toBe(false);
  const output = await phraseInsight({ insight, facts, lang: 'en', log: vi.fn(), complete: async () => JSON.stringify({ slots: '{gold} 这是虚假的经济损失。' }) });
  expect(output.phrasing).toBe('template');
});
it.each(['en', 'zh'])('binds comeback slots to approved clauses in %s', async lang => {
  const f = Object.fromEntries(['gold', 'xp'].map((unit, i) => [`comeback.test.${unit}`, { display: { en: String(i + 100), zh: String(i + 100) } }]));
  const i = { id: 'turning_point', status: 'ok', fact_ids: Object.keys(f) };
  const template = renderTemplate(i, f, lang);
  const swapped = template.slots.replace('.gold}', '.temp}').replace('.xp}', '.gold}').replace('.temp}', '.xp}');
  const context = { insight: i, facts: f, lang, log: vi.fn() };
  expect((await phraseInsight({ ...context, complete: async () => JSON.stringify({ slots: swapped }) })).phrasing).toBe('template');
  const reordered = template.slots.split(lang === 'en' ? /(?<=\.) / : /(?<=。) /).reverse().join(' ');
  expect((await phraseInsight({ ...context, complete: async () => JSON.stringify({ slots: reordered }) })).phrasing).toBe('llm');
});
it.each([[false, 1, 'bottom', '下路'], [false, 3, 'top', '上路'], [true, 1, 'bottom', '下路'], [true, 3, 'top', '上路']])('maps geographic lane (dire=%s, lane=%s) without team flip', (dire, lane, en, zh) => {
  const raw = load(9035042364);
  const player = raw.players.find(p => (p.player_slot >= 128) === dire);
  player.lane = lane;
  const review = buildReview(raw, { ...opts, heroId: player.hero_id, presetFollowups: true });
  expect(review.facts.lane.display).toEqual({ en, zh });
});
it('rejects unknown fact ids and data-gap topics with targeted reasons', () => {
  expect(validateSlots('{gold} {made.up}', { allowedFactIds: ['gold'], requiredFactIds: ['gold'] }).reason).toBe('unknown_fact');
  expect(rendered('Check your ward position −2,060.').reason).toBe('data_gap');
});
it('formats death_list gold like insight facts and capitalizes en sentences', () => {
  const review = buildReview(load(9035042364), { ...opts, presetFollowups: true });
  const d = Object.values(review.facts).find(f => /^death\.\d+$/.test(f.id ?? '') && /gold difference: [−+]?\d/.test(f.display.en));
  expect(d.display.en).toMatch(/gold difference: ([−+]\d{1,3}(,\d{3})*|0)$/);
  expect(renderTemplate({ id: 'next_game', status: 'ok', fact_ids: ['deaths.phase.lane'] }, { 'deaths.phase.lane': { display: { en: '4', zh: '4' } } }, 'en').text).toMatch(/^Lane phase/);
});
it.each(['en', 'zh'])('names the localized repeated killer in fallback in %s', lang => {
  const hero = STATIC_HEROES[2] ?? Object.values(STATIC_HEROES)[0];
  const id = `killed_by.${hero.internalSlug}`;
  const text = renderTemplate({ id: 'fix_this', status: 'ok', fact_ids: [id] }, { [id]: { display: { en: '3', zh: '3' } } }, lang).text;
  expect(text).toContain(hero[lang === 'en' ? 'nameEn' : 'nameZh']);
});
it('preserves resolved thinking defaults and explicit body overrides', async () => {
  vi.stubEnv('DEEPSEEK_THINKING', 'disabled');
  try {
    const create = vi.fn(async () => ({ choices: [{ message: { content: '{}' } }] }));
    const client = { chat: { completions: { create } } };
    await createPhrasingCompletion({ client })({});
    expect(create.mock.calls[0][0].thinking).toEqual({ type: 'disabled' });
    await createPhrasingCompletion({ client, extraBody: { thinking: { type: 'enabled' }, temperature: 0 } })({});
    expect(create.mock.calls[1][0]).toMatchObject({ thinking: { type: 'enabled' }, temperature: 0 });
  } finally { vi.unstubAllEnvs(); }
});

it.each(['en', 'zh'])('binds streamed clauses while allowing reordering in %s', async lang => {
  const facts = Object.fromEntries(['gold', 'xp'].map(unit => [`comeback.test.${unit}`, { display: { en: '100', zh: '100' } }]));
  const insight = { id: 'turning_point', status: 'ok', fact_ids: Object.keys(facts) };
  const approvedSlots = renderTemplate(insight, facts, lang).slots;
  const options = { facts, lang, approvedSlots, requiredFactIds: Object.keys(facts) };
  const collect = async slots => { const out = []; for await (const t of validateStream([slots], options)) out.push(t); return out; };
  const swapped = approvedSlots.replace('.gold}', '.temp}').replace('.xp}', '.gold}').replace('.temp}', '.xp}');
  expect(await collect(swapped)).toEqual([refusal(lang)]);
  const reordered = approvedSlots.split(lang === 'en' ? /(?<=\.) / : /(?<=。) /).reverse().join(' ');
  expect((await collect(reordered)).join('')).not.toContain(refusal(lang));
});
it.each(['en', 'zh'])('rejects foreign scripts in rendered and streamed output in %s', async lang => {
  expect(validateRendered('blink', { facts: {}, purchases: ['blink'], lang }).ok).toBe(true);
  for (const foreign of ['Это ложь', 'كذب', '거짓', 'ひらがな']) {
    expect(validateRendered(`−2,060 ${foreign}.`, { facts, lang }).ok).toBe(false);
    const out = [];
    for await (const text of validateStream([`{gold} ${foreign}.`], { facts, lang })) out.push(text);
    expect(out).toEqual([refusal(lang)]);
  }
});
it('skips completion for missing referenced or required localized facts', async () => {
  const complete = vi.fn();
  for (const i of [{ ...insight, fact_ids: ['gold', 'missing'] }, { ...insight, required_fact_ids: ['missing'] }]) {
    expect((await phraseInsight({ insight: i, facts, lang: 'en', complete })).phrasing).toBe('template');
  }
  expect(complete).not.toHaveBeenCalled();
  expect((await phraseInsight({ insight, facts: { gold: { display: { en: '100' } } }, lang: 'zh', complete })).phrasing).toBe('template');
  expect(complete).not.toHaveBeenCalled();
});
it('atomically reserves concurrent spend, reconciles usage, and releases failed calls', async () => {
  const budget = createBudget({ limit: 0.001, inputPerMillion: 0, outputPerMillion: 1.9 });
  let finish;
  const complete = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  const options = { insight, facts, lang: 'en', budget, complete, log: vi.fn() };
  const pending = phraseInsight(options);
  await Promise.resolve();
  const blocked = await Promise.all(Array.from({ length: 5 }, () => phraseInsight(options)));
  expect(blocked.every(r => r.phrasing === 'template')).toBe(true);
  expect(complete).toHaveBeenCalledTimes(1);
  finish({ text: 'invalid', usage: { completion_tokens: 1 } });
  await pending;
  expect(budget.spent).toBeCloseTo(0.0000019);
  const failing = vi.fn(async () => { throw new Error('failed'); });
  await phraseInsight({ ...options, complete: failing });
  await phraseInsight({ ...options, complete: failing });
  expect(failing).toHaveBeenCalledTimes(2);
  expect(budget.spent).toBeCloseTo(0.0000019);
});
