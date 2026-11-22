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
  await expect(page.locator('.ag-verdict h1')).toContainText('原始咆哮没有留给幻影刺客', { timeout: 30_000 });
  // One click by the reader: one parse, then the review started on its own.
  expect(posts).toEqual([`/api/agent/${id}/prepare`, `/api/agent/${id}/review`]);
  await noSideScroll(page);
});

test('the review: verdict, the turn marked on the fights, findings, what to change', async ({ page }) => {
  await review(page);
  await expect(page.locator('.ag-verdict h1')).toHaveText('原始咆哮没有留给幻影刺客：11 次阵亡里 7 次死在她手上，而她 7 次开黑皇杖时你的大招只吼中过 2 次。');
  await expect(page.locator('.ag-strip-fight')).toHaveCount(16);
  await expect(page.locator('.ag-strip-fight.is-turn text')).toHaveText('▲ 30:26 转折');
  await expect(page.locator('.ag-finding h3')).toHaveText(['1咆哮给错了人', '2没有跳刀也没有黑皇杖']);
  // Each evidence line carries the game time of the record it cites.
  await expect(page.locator('.ag-finding').first().locator('.ag-ev-clock')).toHaveText(['27:27', '30:34', '36:05', '30:05']);
  await expect(page.locator('.ag-next li')).toHaveCount(2);
  await expect(page.getByText('这份复盘里的时间点和数字已经和录像记录核对过。')).toBeVisible();
  await noSideScroll(page);
});

test('evidence: the replay record behind a sentence, on demand', async ({ page }) => {
  await review(page);
  const first = page.locator('.ag-finding').first().locator('.ag-ev');
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

test('ask the coach: the lookups show, then the answer; "ask about this" carries the moment', async ({ page }) => {
  await review(page);
  const chat = page.getByRole('complementary', { name: '问教练' });
  await chat.locator('.ag-suggest button').last().click();
  await expect(chat.locator('.ag-steps li')).toHaveText(['查阵亡前的情况 #9']);
  await expect(chat.locator('.ag-answer')).toContainText('36:05 那次最不应该');
  await expect(chat.locator('.ag-warn')).toHaveCount(0);
  // From an evidence line: the chat shows what the question is about, and sends the record's ref.
  await page.locator('.ag-ev').first().getByRole('button', { name: '就这一刻追问' }).click();
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
  await expect(page.locator('.ag-verdict h1')).toContainText('Primal Roar was never kept for Phantom Assassin');
  await page.locator('.ag-ev').first().getByRole('button', { name: 'Show the record' }).click();
  await expect(page.locator('.ag-rec').first()).toContainText('Target Phantom Assassin');
  await expect(page.getByText('spell immune', { exact: true })).toBeVisible();
});

test('no serious accessibility violations: the review with a record open, and the hero pick', async ({ page }) => {
  await review(page);
  await page.locator('.ag-ev').first().getByRole('button', { name: '看原始记录' }).click();
  await expect(page.locator('.ag-rec')).toBeVisible();
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
