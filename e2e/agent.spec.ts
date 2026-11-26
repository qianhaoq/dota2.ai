import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * The product end to end on the fixture server: the real agent router,
 * service, replay tools and verifier over the trace of match 9100904020,
 * with a scripted model and a fake replay pipeline (scripts/mock-agent.mjs).
 * No outbound requests. Hero art is a flat tile.
 */
const MATCH = '9100904020';
const TILE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGN49PQVEDFAKABLSgrFLKOkOQAAAABJRU5ErkJggg==', 'base64');

test.beforeEach(async ({ page }) => {
  await page.route('https://cdn.cloudflare.steamstatic.com/**', (route) => route.fulfill({ contentType: 'image/png', body: TILE }));
  await page.route('https://cdn.steamstatic.com/**', (route) => route.fulfill({ contentType: 'image/png', body: TILE }));
});

/** The finished review of the fixture game, started by a click if nobody has yet. */
async function review(page: Page, lang: 'zh' | 'en' = 'zh') {
  await page.goto(`/r/${MATCH}?hero=beastmaster&lang=${lang}`);
  const start = page.getByRole('button', { name: lang === 'zh' ? '开始复盘' : 'Review my game' });
  const doc = page.locator('.ag-doc');
  await expect(start.or(doc).first()).toBeVisible();
  if (await start.isVisible()) await start.click();
  await expect(doc).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => document.fonts.ready);
}

async function noSideScroll(page: Page) {
  const [sw, cw] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  expect(sw).toBeLessThanOrEqual(cw);
}

test('home: one input, and the four steps of what happens next', async ({ page }) => {
  await page.goto('/?lang=zh');
  await expect(page.getByRole('heading', { name: '接下来会发生什么' })).toBeVisible();
  await expect(page.locator('.hm-how-steps strong')).toHaveText(['选你玩的英雄', '教练看录像', '拿到复盘', '想问就问']);
  await page.getByRole('textbox').first().fill(MATCH);
  await page.getByRole('button', { name: '开始复盘' }).click();
  await expect(page).toHaveURL(new RegExp(`/r/${MATCH}`));
  await expect(page.getByRole('heading', { name: '你玩的是哪个英雄？' })).toBeVisible();
  await noSideScroll(page);
});

test('from no replay to a review in one click: fetch, read, the coach, the review', async ({ page, request }) => {
  // An id with no replay that nobody has used: ask the server until one is untouched.
  let id = '';
  for (let i = 0; i < 20 && !id; i += 1) {
    const candidate = String(9100904100 + Math.floor(Math.random() * 900));
    const a = await (await request.get(`/api/agent/${candidate}`)).json();
    if (!a.trace && a.parse.status === 'none') id = candidate;
  }
  expect(id).not.toBe('');
  await page.goto(`/r/${id}?lang=zh`);
  // The roster comes from the scoreboard: there is no replay yet.
  await page.getByRole('button', { name: /兽王/ }).click();
  await expect(page.getByRole('heading', { name: '复盘这一局' })).toBeVisible();
  const posts: string[] = [];
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/api/agent/')) posts.push(new URL(r.url()).pathname); });
  await page.getByRole('button', { name: '开始复盘' }).click();
  await expect(page.getByRole('heading', { name: '正在准备你的复盘' })).toBeVisible();
  const live = page.locator('.ag-journey > li.is-live strong');
  await expect(live).toHaveText('取录像');
  await expect(live).toHaveText('解析录像', { timeout: 10_000 });
  await expect(live).toHaveText('教练看录像', { timeout: 15_000 });
  await expect(page.locator('.ag-journey .ag-steps li').first()).toHaveText('看整局概况', { timeout: 10_000 });
  // While the review is written: the player's deaths, fights and key items from the parsed replay, to look at meanwhile.
  await expect(page.locator('.ag-wait h2')).toHaveText('教练看录像的这几分钟，先看你的 11 次阵亡');
  await expect(page.locator('.ag-wait-list > li')).toHaveCount(11);
  await expect(page.locator('.ag-wait-facts h2')).toHaveText('团战走势与你的关键成装');
  await expect(page.locator('.ag-wait-facts .ag-strip-fight')).toHaveCount(16);
  await expect(page.locator('.ag-lead h1')).toHaveText('咆哮给错了人', { timeout: 30_000 });
  await expect(page.locator('.ag-whole .ag-verdict')).toContainText('原始咆哮没有留给幻影刺客');
  // One click by the reader: one parse, then the review started on its own.
  expect(posts).toEqual([`/api/agent/${id}/prepare`, `/api/agent/${id}/review`]);
  await noSideScroll(page);
});

test('the review: one lesson first, the other finding folded, then the whole game with the turn marked', async ({ page }) => {
  await review(page);
  // The headline is the first finding; what to practise is its fix; its evidence are the moments.
  await expect(page.locator('.ag-lead h1')).toHaveText('咆哮给错了人');
  await expect(page.locator('.ag-lesson')).toContainText('对面核心带黑皇杖时，咆哮只留给她；她开了也照吼。');
  // The second finding is folded: its heading shows, its body opens on a click.
  const second = page.locator('details.ag-finding');
  await expect(second.locator('summary h3')).toHaveText(['2没有跳刀也没有黑皇杖']);
  await expect(second.locator('.ag-claim')).toBeHidden();
  await second.locator('summary').click();
  await expect(second.locator('.ag-claim')).toBeVisible();
  await expect(second).toContainText('神杖之后先补闪烁匕首或黑皇杖。');
  // The sentence about the whole game stands with the whole game.
  await expect(page.locator('.ag-whole .ag-verdict')).toContainText('原始咆哮没有留给幻影刺客：11 次阵亡里 7 次死在她手上，而她 7 次开黑皇杖时你的大招只吼中过 2 次。');
  await expect(page.locator('.ag-strip-fight')).toHaveCount(16);
  await expect(page.locator('.ag-strip-fight.is-turn text')).toHaveText('▲ 30:26 转折');
  await expect(page.locator('.ag-presence')).toContainText('在团里');
  await expect(page.locator('.ag-presence')).toContainText('100%');
  // Each evidence line carries the game time of the record it cites.
  await expect(page.locator('.ag-moments .ag-ev-clock')).toHaveText(['27:27', '30:34', '36:05', '30:05']);
  // The story of the game is there for whoever opens it.
  const story = page.locator('.ag-whole details.ag-fold').first();
  await expect(story.locator('.ag-mainline li').first()).toBeHidden();
  await story.locator('summary').click();
  await expect(story.locator('.ag-mainline li').first()).toBeVisible();
  await expect(page.getByText('这份复盘里的时间点和数字已经和录像记录核对过。')).toBeVisible();
  await noSideScroll(page);
});

test('the game plan: how the game went as a whole, its records, and a plan of the reader\'s own checked by the coach', async ({ page }) => {
  await review(page);
  const plan = page.locator('.ag-plan');
  await expect(plan.getByRole('heading', { name: '运营思路' })).toBeVisible();
  // Folded, it already says what the game is put down to; it opens on a click.
  await expect(plan.locator('summary')).toContainText('主要在队伍，不在你');
  await expect(plan.locator('.ag-plan-parts')).toBeHidden();
  await plan.locator('summary').click();
  await expect(plan.locator('.ag-plan-parts dt')).toHaveText(['窗口期', '走势', '你的部分']);
  await expect(plan.locator('.ag-plan-parts dd').first()).toContainText('幻影刺客在 21:29 出了黑皇杖，就在这段领先之内');
  await expect(plan.locator('.ag-plan-parts dd').nth(1)).toContainText('16 波团战里你们少死人的有 6 波，其中只有 22:57 那一波之后两分钟内拆到了建筑');
  await expect(plan.locator('.ag-plan-tag')).toHaveText('主要在队伍，不在你');
  // It passed the same check as the findings: all three evidence lines are there, each record with the time it began.
  await expect(plan.locator('.ag-ev')).toHaveCount(3);
  await expect(plan.locator('.ag-ev-clock')).toHaveText(['19:00', '20:00']);
  // The whole game's tempo, recomputed by the server: a row per ten minutes.
  await plan.locator('.ag-ev').nth(0).getByRole('button', { name: '看原始记录' }).click();
  const tempo = plan.locator('.ag-ev').nth(0).locator('.ag-rec');
  await expect(tempo.getByRole('row')).toHaveCount(6);
  await expect(tempo.getByRole('row', { name: '10:00–20:00 3 0 7 10' })).toBeVisible();
  await expect(tempo.getByText('15 / 16')).toBeVisible();
  // One stretch: what fell, and where the player was.
  await plan.locator('.ag-ev').nth(2).getByRole('button', { name: '看原始记录' }).click();
  const stretch = plan.locator('.ag-ev').nth(2).locator('.ag-rec');
  await expect(stretch.getByText('25:05 · 对方 上路 2 塔')).toBeVisible();
  await expect(stretch.getByText('天辉上路 32%')).toBeVisible();
  await expect(stretch.getByText('身边两名以上队友 52%')).toBeVisible();
  // The window: when the team was ahead, what each side took, what the enemy finished just before it ended.
  await plan.locator('.ag-ev').nth(1).getByRole('button', { name: '看原始记录' }).click();
  const win = plan.locator('.ag-ev').nth(1).locator('.ag-rec');
  await expect(win.locator('.ag-rec-head')).toHaveText('19:00–29:00 · 我方领先 · 峰值 3565 (25:00)');
  await expect(win.getByText('21:29 · 幻影刺客 黑皇杖')).toBeVisible();
  await expect(win.getByText('26:44 · 幻影刺客 碎颅锤')).toHaveCount(2);
  // The reader says what they were going for; the coach looks at the tempo and answers.
  const chat = page.getByRole('complementary', { name: '问教练' });
  const sent = page.waitForRequest((r) => r.url().endsWith('/chat') && r.method() === 'POST');
  await plan.getByRole('button', { name: '线优转推进' }).click();
  expect((await sent).postDataJSON()).toMatchObject({ hero: 'beastmaster', lang: 'zh', question: '我这局的思路是「线优转推进」。我的打法和这个思路一致吗？面对对面的阵容，这个思路站得住吗？没打成的话，是我没做好、思路不对，还是被对面针对了？' });
  await expect(chat.locator('.ag-steps li')).toHaveText(['看各阶段的推进和节奏', '查双方英雄在长局、短局的胜率']);
  await expect(chat.locator('.ag-answer')).toContainText('没打成主要不在你');
  await expect(chat.locator('.ag-warn')).toHaveCount(0);
  await noSideScroll(page);
  const axe = await new AxeBuilder({ page }).include('.ag-plan').analyze();
  expect(axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([]);
});

test('the reader names a plan before the review, and the review reads the game against it', async ({ page }) => {
  // The two viewports share one server: each names its own plan, so each starts a review of its own.
  const [key, label] = test.info().project.name.startsWith('mobile') ? ['push', '线优转推进'] : ['split', '带线牵制'];
  // The game already has a review without a plan (as most games someone opened will): the way in is from it.
  await review(page);
  // The plan question is asked from the game plan, which is folded with the rest of the whole game.
  await page.locator('.ag-plan summary').click();
  await page.locator('.ag-plan').getByRole('button', { name: label }).click();
  const note = page.locator('.ag-intent-note', { hasText: `也可以按「${label}」重写整份复盘` });
  await note.getByRole('button', { name: '重写' }).click();
  await expect(page).toHaveURL(new RegExp(`plan=${key}`));
  // A review for a plan is its own review: its start is offered, with the plan already picked.
  const group = page.getByRole('radiogroup', { name: '这局你想怎么打？（可选）' });
  await expect(group.getByRole('radio', { name: label })).toHaveAttribute('aria-checked', 'true');
  const posted = page.waitForRequest((r) => r.url().endsWith(`/api/agent/${MATCH}/review`) && r.method() === 'POST');
  await page.getByRole('button', { name: '开始复盘' }).click();
  expect((await posted).postDataJSON()).toEqual({ hero: 'beastmaster', lang: 'zh', plan: key });
  const plan = page.locator('.ag-plan');
  await expect(plan).toBeVisible({ timeout: 30_000 });
  const yours = plan.locator('.ag-plan-yours');
  await expect(yours.locator('dt')).toHaveText(`对照你的思路${label}`);
  await expect(yours.locator('dd')).toContainText('断在队伍没有把领先换成塔，不在你');
  await expect(plan.locator('.ag-plan-parts dt').first()).toHaveText(`对照你的思路${label}`);
  // The chat is about this review: its questions carry the plan.
  const sent = page.waitForRequest((r) => r.url().endsWith('/chat') && r.method() === 'POST');
  const chat = page.getByRole('complementary', { name: '问教练' });
  await chat.getByRole('textbox').fill('那我该怎么推？');
  await chat.getByRole('textbox').press('Enter');
  expect((await sent).postDataJSON()).toMatchObject({ question: '那我该怎么推？', plan: key });
  await noSideScroll(page);
});

test('evidence: the replay record behind a sentence, on demand', async ({ page }) => {
  await review(page);
  const first = page.locator('.ag-moments .ag-ev');
  // A cast: the target, that she was spell immune, and that the stun landed anyway.
  await first.nth(0).getByRole('button', { name: '看原始记录' }).click();
  const cast = first.nth(0).locator('.ag-rec');
  await expect(cast).toContainText('目标 幻影刺客');
  await expect(cast.getByText('技能免疫中')).toBeVisible();
  await expect(cast.getByText('被晕 3.4秒')).toBeVisible();
  // A death: the chain of disables and what was ready and not used.
  await first.nth(2).getByRole('button', { name: '看原始记录' }).click();
  const death = first.nth(2).locator('.ag-rec');
  await expect(death).toContainText('击杀者 瘟疫法师');
  await expect(death.locator('.ag-chip.is-warn', { hasText: '原始咆哮' })).toBeVisible();
  await expect(death).toContainText('2915/2915');
  // A fight: where everyone stood, and the order of deaths.
  await first.nth(3).getByRole('button', { name: '看原始记录' }).click();
  const fight = first.nth(3).locator('.ag-rec');
  await expect(fight.locator('.ag-map-dot')).toHaveCount(10);
  await expect(fight.locator('.ag-map-dot.is-me')).toHaveCount(1);
  await expect(fight.locator('.ag-events li.is-death')).toHaveCount(8);
  await expect(fight.locator('.ag-bar-value').first()).toHaveText('8524');
  await first.nth(0).getByRole('button', { name: '收起' }).click();
  await expect(cast).toHaveCount(0);
  await noSideScroll(page);
});

test('a moment replayed on the map: the heroes around the cited second, played and scrubbed', async ({ page }) => {
  await review(page);
  // 27:27, the Roar into her Black King Bar.
  const first = page.locator('.ag-moments .ag-ev').first();
  await first.getByRole('button', { name: '重放这一刻' }).click();
  const replay = first.locator('.ag-replay');
  await expect(replay.getByRole('img', { name: '27:15 到 27:33 的站位' })).toBeVisible();
  // Asked for, it plays to its last second on its own.
  const clock = replay.locator('.ag-replay-controls output');
  await expect(clock).toHaveText('27:33', { timeout: 15_000 });
  await expect(replay.getByRole('button', { name: '播放' })).toBeVisible();
  // Back to the cited second: the player is on the map, marked, among the heroes who were there.
  await replay.getByRole('slider', { name: '比赛时间' }).fill('12');
  await expect(clock).toHaveText('27:27');
  await expect(clock).toHaveClass(/is-moment/);
  await expect(replay.locator('.ag-replay-hero.is-me text')).toHaveText('你');
  expect(await replay.locator('.ag-replay-hero').count()).toBeGreaterThanOrEqual(4);
  // What happened in those seconds stands beside where everyone stood: the Roar of 27:27, named and marked as an ultimate.
  const events = replay.getByRole('list', { name: '这几秒里发生的事' });
  await expect(events.locator('li.is-now.is-ultimate')).toContainText('兽王：原始咆哮 → 幻影刺客');
  await expect(replay.locator('.ag-replay-hero.is-me.is-casting')).toHaveCount(1);
  await expect(replay.locator('figcaption')).toContainText('不代表谁能看到谁');
  await noSideScroll(page);
  const axe = await new AxeBuilder({ page }).include('.ag-replay').analyze();
  expect(axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([]);
  await first.getByRole('button', { name: '收起回放' }).click();
  await expect(replay).toHaveCount(0);
});

test('each finding is asked about: the word is kept, a reason follows, and the page remembers it', async ({ page }) => {
  await review(page);
  // Under the first finding's moments, once the reader has seen its claim, what to practise and the moments.
  const lead = page.locator('.ag-moments .ag-fb');
  await expect(lead.getByRole('group', { name: '这条说得对吗？' }).getByRole('button')).toHaveText(['说得对', '不对', '没用']);
  const kept = page.waitForResponse((r) => r.url().includes('/feedback') && r.request().method() === 'POST');
  await lead.getByRole('button', { name: '不对', exact: true }).click();
  expect((await kept).status()).toBe(200);
  await expect(lead.getByRole('status')).toHaveText('记下了，谢谢。');
  await expect(lead.getByRole('button', { name: '不对', exact: true })).toHaveAttribute('aria-pressed', 'true');
  // Why, from three fixed answers: nothing is typed.
  const why = lead.getByRole('group', { name: '哪里不对？' });
  await expect(why.getByRole('button')).toHaveText(['事实不对', '事实对，结论不对', '这不是我能改的']);
  await expect(lead.locator('input, textarea')).toHaveCount(0);
  await why.getByRole('button', { name: '事实不对', exact: true }).click();
  await expect(why.getByRole('button', { name: '事实不对', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await noSideScroll(page);
  const axe = await new AxeBuilder({ page }).include('.ag-moments .ag-fb').analyze();
  expect(axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([]);
  // The other findings are asked about inside their folds, each on its own.
  const second = page.locator('details.ag-finding').first();
  await second.locator('summary').click();
  await expect(second.locator('.ag-fb').getByRole('button', { name: '说得对' })).toHaveAttribute('aria-pressed', 'false');
  // Back another time: what was said is still shown, and nothing is sent on the way in.
  let again = 0;
  page.on('request', (r) => { if (r.url().includes('/feedback')) again += 1; });
  await page.reload();
  await expect(page.locator('.ag-doc')).toBeVisible({ timeout: 30_000 });
  const back = page.locator('.ag-moments .ag-fb');
  await expect(back.getByRole('button', { name: '不对', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(back.getByRole('button', { name: '事实不对', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(again).toBe(0);
});

test('ask the coach: the lookups show, then the answer; "ask about this" carries the moment', async ({ page }) => {
  await review(page);
  const chat = page.getByRole('complementary', { name: '问教练' });
  await chat.locator('.ag-suggest button').last().click();
  await expect(chat.locator('.ag-steps li')).toHaveText(['查阵亡前的情况 #9']);
  await expect(chat.locator('.ag-answer')).toContainText('36:05 那次最不应该');
  await expect(chat.locator('.ag-warn')).toHaveCount(0);
  // From an evidence line: the chat shows what the question is about, and sends the record's ref.
  await page.locator('.ag-moments .ag-ev').first().getByRole('button', { name: '就这一刻追问' }).click();
  await expect(chat.locator('.ag-context')).toContainText('27:27');
  const sent = page.waitForRequest((r) => r.url().endsWith('/chat') && r.method() === 'POST');
  await chat.getByRole('textbox').fill('这一吼对吗？');
  await chat.getByRole('textbox').press('Enter');
  expect((await sent).postDataJSON()).toMatchObject({ hero: 'beastmaster', lang: 'zh', question: '这一吼对吗？\n(about cast:beastmaster:primal_roar:6)', history: [{ q: '我哪一次阵亡最不应该？' }] });
  await expect(chat.locator('.ag-turn')).toHaveCount(2);
});

test('the review\'s goal becomes the next-game goal', async ({ page }) => {
  await review(page);
  const card = page.locator('.ag-goal');
  await expect(card.locator('.ag-goal-label')).toHaveText('用兽王时：出一件闪烁匕首或黑皇杖');
  await card.getByRole('button', { name: '设为下一局目标' }).click();
  await expect(card).toContainText('✓ 已设为下一局目标 · 对应问题 2');
  const stored = await page.evaluate(() => JSON.parse(window.localStorage.getItem('dota2ai.coach.goal')!));
  expect(stored).toMatchObject({ id: `${MATCH}:beastmaster:agent:hold_item:blink+black_king_bar`, goal: { kind: 'hold_item', items: ['blink', 'black_king_bar'], accept: expect.arrayContaining(['blink', 'overwhelming_blink', 'black_king_bar']), hero_id: 38 }, fromMatch: Number(MATCH), heroId: 38 });
  // It survives a reload, and the same game is not judged against its own goal.
  await page.reload();
  await expect(page.locator('.ag-goal')).toContainText('✓ 已设为下一局目标');
  await expect(page.locator('.ag-goalcheck')).toHaveCount(0);
  await page.locator('.ag-goal').getByRole('button', { name: '取消' }).click();
  await expect(page.locator('.ag-goal').getByRole('button', { name: '设为下一局目标' })).toBeVisible();
});

test('a replay that is gone: said plainly, scoreboard only, nothing to start', async ({ page }) => {
  await page.goto('/r/8000000001?hero=beastmaster&lang=zh');
  const start = page.getByRole('button', { name: '开始复盘' });
  const gone = page.getByRole('heading', { name: '这局的录像已经没有了' });
  await expect(start.or(gone).first()).toBeVisible();
  if (await start.isVisible()) await start.click();
  await expect(gone).toBeVisible();
  await expect(page.getByRole('region', { name: '记分板' }).locator('li')).toHaveCount(10);
  await expect(page.getByRole('button', { name: '开始复盘' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '再试一次' })).toHaveCount(0);
  await expect(page.locator('.ag-chat')).toHaveCount(0);
});

test('English: the same review in the reader\'s language', async ({ page }) => {
  await review(page, 'en');
  await expect(page.locator('.ag-lead h1')).toHaveText('The roar went to the wrong heroes');
  await expect(page.locator('.ag-whole .ag-verdict')).toContainText('Primal Roar was never kept for Phantom Assassin');
  await page.locator('.ag-moments .ag-ev').first().getByRole('button', { name: 'Show the record' }).click();
  await expect(page.locator('.ag-moments .ag-rec').first()).toContainText('Target Phantom Assassin');
  await expect(page.getByText('spell immune', { exact: true })).toBeVisible();
});

test('no serious accessibility violations: the review with a record open, and the hero pick', async ({ page }) => {
  await review(page);
  await page.locator('.ag-moments .ag-ev').first().getByRole('button', { name: '看原始记录' }).click();
  await expect(page.locator('.ag-moments .ag-rec')).toBeVisible();
  const scan = async () => (await new AxeBuilder({ page }).include('.cx').withTags(['wcag2a', 'wcag2aa']).disableRules(['color-contrast']).analyze())
    .violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes.length}`);
  expect(await scan()).toEqual([]);
  await page.goto(`/r/${MATCH}?lang=zh`);
  await expect(page.getByRole('heading', { name: '你玩的是哪个英雄？' })).toBeVisible();
  expect(await scan()).toEqual([]);
});

test('keyboard: a fight on the strip can be reached and asked about', async ({ page }) => {
  await review(page);
  const turn = page.locator('.ag-strip-fight.is-turn');
  await turn.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.ag-context')).toContainText('30:26');
  await expect(page.getByRole('complementary', { name: '问教练' }).getByRole('textbox')).toBeFocused();
});

test('the waiting screen facts: fight strip and key items fit mobile and desktop with no axe violations', async ({ page }) => {
  await page.route(`**/api/agent/${MATCH}/review*`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'running', steps: [{ tool: 'match_overview', args: {} }] }) }),
  );
  await page.goto(`/r/${MATCH}?hero=beastmaster&lang=zh`);
  await expect(page.locator('.ag-wait-facts h2')).toHaveText('团战走势与你的关键成装');
  await expect(page.locator('.ag-wait-facts .ag-strip-fight')).toHaveCount(16);
  expect(await page.locator('.ag-wait-items li').count()).toBeGreaterThan(0);
  await noSideScroll(page);
  const axe = await new AxeBuilder({ page }).include('.ag-wait-facts').disableRules(['color-contrast']).analyze();
  expect(axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([]);
});
