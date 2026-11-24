import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * The patch advisor on the home page, end to end on the fixture server: the
 * real router, tools and verifier over the committed patch snapshots, with a
 * scripted model (scripts/mock-patch.mjs). No outbound requests.
 */
test('home: who moved since the patch, and a question answered from the notes and the numbers', async ({ page }) => {
  await page.goto('/?lang=zh');
  const pa = page.locator('.pa');
  await expect(pa.getByRole('heading', { name: '7.42 版本顾问' })).toBeVisible();
  // Four tables of five heroes each, from the snapshot.
  await expect(pa.getByRole('table')).toHaveCount(4);
  for (const name of ['胜率上升', '胜率下降', '出场率上升', '出场率下降']) await expect(pa.getByRole('table', { name }).locator('tbody tr')).toHaveCount(5);
  await expect(pa.getByText(/补丁前：\d{4}-\d{2}-\d{2} 至 \d{4}-\d{2}-\d{2}（7 天）/)).toBeVisible();
  await expect(pa.getByRole('link', { name: '数据：STRATZ' })).toBeVisible();
  // Ask: the lookups show, then the answer, with nothing marked as unchecked.
  const top = await pa.getByRole('table', { name: '胜率上升' }).locator('tbody tr').first().locator('th').innerText();
  await pa.getByRole('button', { name: '这个版本谁变强了，谁变弱了？' }).click();
  await expect(pa.locator('.pa-steps li')).toHaveCount(2);
  await expect(pa.locator('.pa-steps li').first()).toHaveText('看版本总览');
  // The second lookup is named by the hero's name, not its engine key.
  await expect(pa.locator('.pa-steps li').nth(1)).toHaveText(`查英雄的改动和数据：${top}`);
  await expect(pa.locator('.pa-answer')).toContainText(`补丁后胜率涨得最多的是${top}`);
  await expect(pa.locator('.pa-answer')).toContainText('涨了不等于是这条改动造成的');
  await expect(pa.locator('.pa-warn')).toHaveCount(0);
  // A hero in a table asks about that hero.
  const sent = page.waitForRequest((r) => r.url().endsWith('/api/patch/chat') && r.method() === 'POST');
  await pa.getByRole('table', { name: '出场率上升' }).locator('tbody tr').first().getByRole('button').click();
  expect((await sent).postDataJSON().question).toMatch(/在 7\.42 改了什么？胜率和出场率怎么变了？$/);
  await expect(pa.locator('.pa-turn')).toHaveCount(2);
  const [sw, cw] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  expect(sw).toBeLessThanOrEqual(cw);
  const axe = await new AxeBuilder({ page }).include('.pa').withTags(['wcag2a', 'wcag2aa']).disableRules(['color-contrast']).analyze();
  expect(axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  if (process.env.SHOT_DIR) { await pa.scrollIntoViewIfNeeded(); await page.screenshot({ path: `${process.env.SHOT_DIR}/advisor-${test.info().project.name}.png`, fullPage: false }); }
});

test('home in English: the same advisor in the reader\'s language', async ({ page }) => {
  await page.goto('/?lang=en');
  const pa = page.locator('.pa');
  await expect(pa.getByRole('heading', { name: 'Patch 7.42 advisor' })).toBeVisible();
  await expect(pa.getByRole('table', { name: 'Win rate up' }).locator('tbody tr')).toHaveCount(5);
  // The page's one input is the match box; the advisor's own opens on request.
  await expect(page.getByRole('textbox')).toHaveCount(1);
  await pa.getByRole('button', { name: 'Ask your own question…' }).click();
  await pa.getByRole('textbox', { name: 'Ask the advisor' }).fill('Who rose most?');
  await pa.getByRole('button', { name: 'Ask' }).click();
  await expect(pa.locator('.pa-answer')).toContainText('rose most: its public win rate went from');
  await expect(pa.locator('.pa-warn')).toHaveCount(0);
});
