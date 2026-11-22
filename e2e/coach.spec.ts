import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFileSync } from 'node:fs';
import { buildCoachReport } from '../lib/coach/analyze.js';

/**
 * The coach review page (/r/:matchId) end to end, on the mock server's real
 * coach router + engine over the parsed 9091400302 fixture. Every recently
 * shipped "why" feature is asserted ON SCREEN, with the numbers taken from
 * the same engine output the page renders. Hero/item art is a flat tile.
 */
const raw = JSON.parse(readFileSync('src/fixtures/coach/match9091400302.parsed.json', 'utf8'));
const report: any = buildCoachReport(raw);
const why = (slot: number) => report.reviews[slot].chapters.story.why as any[];
const cause = (slot: number, id: string) => why(slot).find((c) => c.id === id);

const TILE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGN49PQVEDFAKABLSgrFLKOkOQAAAABJRU5ErkJggg==', 'base64');

test.beforeEach(async ({ page }) => {
  await page.route('https://cdn.cloudflare.steamstatic.com/**', (route) => route.fulfill({ contentType: 'image/png', body: TILE }));
  await page.route('https://cdn.steamstatic.com/**', (route) => route.fulfill({ contentType: 'image/png', body: TILE }));
});

async function open(page: Page, slot: number) {
  await page.goto(`/r/9091400302?lang=zh&p=${slot}`);
  // First screen: the verdict and the next-game list; areas are one line each until opened.
  await expect(page.locator('#cx-ch-plan')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

/** Open one area of the review (its summary line), as a reader would. */
async function area(page: Page, key: 'story' | 'laning' | 'deaths' | 'items' | 'fights') {
  const sec = page.locator(`#rv-sec-${key}`);
  if (!(await sec.evaluate((d) => (d as HTMLDetailsElement).open))) await sec.locator('> summary').click();
  await expect(page.locator(`#cx-ch-${key}`)).toBeVisible();
}

async function noSideScroll(page: Page) {
  const [sw, cw] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  expect(sw).toBeLessThanOrEqual(cw);
}

test('first screen: the verdict and the first thing to do next game, without scrolling; the page stays short', async ({ page }) => {
  await open(page, 0);
  const vh = page.viewportSize()!.height;
  const headline = page.locator('.rv-headline');
  await expect(headline).toHaveText(report.reviews[0].headline.zh);
  expect((await headline.boundingBox())!.y).toBeLessThan(vh);
  const first = page.locator('#cx-ch-plan .rv-things > li').first();
  await expect(first).toContainText(report.reviews[0].chapters.plan[0].title.zh);
  const box = (await first.boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(vh);
  // Areas closed: the whole review is a few screens, not a scroll of every number.
  const h = await page.evaluate(() => (document.querySelector('.cx') as HTMLElement).scrollHeight);
  expect(h).toBeLessThan(vh * 3);
  await noSideScroll(page);
});

test('Tidehunter: every "why" cause, the spell to wait out, the core item and lane positions are on screen', async ({ page }) => {
  await open(page, 0);
  await area(page, 'story');
  const story = page.locator('#cx-ch-story');
  // Titles share a line with the "you" tag: match the title text inside it.
  for (const c of why(0)) await expect(story.getByText(c.title.zh).first()).toBeVisible();

  // #178: the lane killer's spell with Valve's cooldowns.
  const top = cause(0, 'lane.3');
  expect(top.fix.zh).toContain('冷却 19/16/13/10 秒');
  await expect(story.getByText(top.fix.zh).first()).toBeVisible(); // shares a line with the "怎么做" label

  // #179: late core item against pro builds.
  const key = cause(0, 'items.key_item');
  expect(key.title.zh).toMatch(/^核心装备：闪烁匕首 \d+:\d\d 才买/);
  for (const e of key.evidence) await expect(story.getByText(e.zh, { exact: true })).toBeVisible();

  // #180: replay positions, as a line and a heat map of your lane.
  const pos = top.evidence.find((e: any) => e.zh.includes('录像位置采样'));
  await expect(story.getByText(pos.zh, { exact: true })).toBeVisible();
  const heat = story.locator('figure.cx-heat');
  await expect(heat).toHaveCount(1);
  await expect(heat.locator('circle.cx-heat-me')).toHaveCount(top.heat.me.cells.length);
  await expect(heat.locator('circle.cx-heat-opp')).toHaveCount(top.heat.opp.cells.length);
  await expect(heat).toContainText('潮汐猎人');
  await expect(heat).toContainText('熊战士');
  await noSideScroll(page);
});

test('the plan chapter shows numbers as text, not as row labels (#181)', async ({ page }) => {
  await open(page, 0);
  const plan = page.locator('#cx-ch-plan');
  await plan.scrollIntoViewIfNeeded();
  const nums = plan.locator('b.cx-num-em');
  expect(await nums.count()).toBeGreaterThan(0);
  const style = await nums.first().evaluate((el) => { const s = getComputedStyle(el); return { display: s.display, minWidth: s.minWidth }; });
  expect(style).toEqual({ display: 'inline', minWidth: '0px' });
  for (const p of report.reviews[0].chapters.plan) await expect(plan.getByText(p.title.zh, { exact: true })).toBeVisible();
});

test('Warlock: the heat map follows the seat — Warlock against Dawnbreaker', async ({ page }) => {
  await open(page, 2);
  await area(page, 'story');
  const heat = page.locator('#cx-ch-story figure.cx-heat');
  await expect(heat).toHaveCount(1);
  await expect(heat).toContainText('术士');
  await expect(heat).toContainText('破晓辰星');
  await expect(page.locator('#cx-ch-story').getByText(cause(2, 'items.key_item').title.zh).first()).toBeVisible();
});

test('a cause on you links to the pro cases, and the cases load', async ({ page }) => {
  await open(page, 0);
  await area(page, 'story');
  await page.getByText(/看职业对局/).first().click();
  await expect(page.locator('#cx-ch-cases')).toBeVisible();
  await expect(page.locator('#cx-case-laning')).toBeVisible();
});

test('a finding can become the next-game goal', async ({ page }) => {
  await open(page, 0);
  const btn = page.getByRole('button', { name: /^设为下局目标/ }).first();
  await btn.scrollIntoViewIfNeeded();
  const label = (await btn.locator('span').textContent())!.trim();
  await btn.click();
  // The finding now shows the goal as set, and the goal banner carries it.
  await expect(page.getByText(`✓ 已设为下局目标：${label}`)).toBeVisible();
});

test('ask answers from the report when no AI is configured', async ({ page }) => {
  await open(page, 0);
  const box = page.locator('.cx-ask-form textarea');
  await box.scrollIntoViewIfNeeded();
  await box.fill('为什么输了团战');
  await page.locator('.cx-ask-form button[type=submit]').click();
  await expect(page.getByText('AI 追问暂时不可用，以下是复盘里与问题对应的部分。')).toBeVisible();
});

test('no serious accessibility violations on the review page', async ({ page }) => {
  await open(page, 0);
  const results = await new AxeBuilder({ page }).include('.cx').withTags(['wcag2a', 'wcag2aa']).disableRules(['color-contrast']).analyze();
  const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
});
