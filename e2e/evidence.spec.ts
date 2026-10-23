import { expect, test, type Locator, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFileSync } from 'node:fs';
import { buildReview } from '../packages/review-engine/src/buildReview.js';

/**
 * PR7 e2e — evidence sheet (mobile-390) + panel (desktop-1280).
 * Numbers asserted on screen come from buildReview(...) fact displays — the
 * same rule the components follow. Hero/item art is intercepted with a flat
 * tile so the visual baselines are hermetic (no Steam CDN dependency).
 */
const raw = JSON.parse(readFileSync('src/fixtures/match9035042364.parsed.json', 'utf8'));
const review = buildReview(raw, { heroId: 14, lang: 'en', fetchedAt: '2026-10-17T00:00:00Z' });
const facts = review.facts as Record<string, { display: { en: string; t?: string } }>;
const low = facts['gold.low'];
const goldDeltaId = Object.keys(facts).find(k => /^gold\.window\..+\.delta$/.test(k))!;
const xpDeltaId = goldDeltaId.replace(/^gold/, 'xp');
const topKillerCount = facts['killed_by.skeleton_king'].display.en;

const TILE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGN49PQVEDFAKABLSgrFLKOkOQAAAABJRU5ErkJggg==', 'base64');

const REVIEW_URL = '/m/9035042364?hero=pudge&lang=en';
const REVIEW_URL_ZH = '/m/9035042364?hero=pudge&lang=zh';

const isMobileProject = () => test.info().project.name === 'mobile-390';

test.beforeEach(async ({ page }) => {
  await page.route('https://cdn.cloudflare.steamstatic.com/**', route =>
    route.fulfill({ contentType: 'image/png', body: TILE }));
});

/** Load the review and wait for the stream to finish + webfonts to settle. */
async function ready(page: Page, url = REVIEW_URL) {
  await page.goto(url);
  await expect(page.getByTestId('insight-card')).toHaveCount(3);
  await expect(page.getByText(/Analyzed in|Analyzed match|分析耗时|已分析比赛/)).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

/** Nondeterministic bits masked out of baselines: elapsed time + fetch timestamp. */
function masks(page: Page): Locator[] {
  return [page.locator('summary'), page.getByTestId('evidence-fetched')];
}

async function openEvidence(page: Page, claimButton: number) {
  await page.getByTestId('insight-card').nth(claimButton).getByRole('button', { name: /Evidence|证据/ }).click();
}

const dialog = (page: Page) => page.getByRole('dialog', { name: /Evidence|证据/ });
const panel = (page: Page) => page.getByTestId('evidence-panel');

function evidenceRoot(page: Page): Locator {
  return isMobileProject() ? dialog(page) : panel(page);
}

/** Claim-0 digits straight from engine displays. */
async function expectClaim0Digits(scope: Locator) {
  await expect(scope.getByText(`${low.display.en} · ${low.display.t}`)).toBeVisible();
  await expect(scope.getByText(facts[goldDeltaId].display.en).first()).toBeVisible();
  await expect(scope.getByText(facts[xpDeltaId].display.en).first()).toBeVisible();
}

async function axeNoSerious(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  const serious = results.violations.filter(v => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map(v => `${v.id}: ${v.nodes.length} node(s): ${v.nodes[0]?.target}`)).toEqual([]);
}

test.describe('evidence sheet (mobile-390)', () => {
  test.skip(() => !isMobileProject(), 'mobile only');

  test('opens with claim digits, snaps 55%→92% on handle tap, pages, drag-to-close', async ({ page }) => {
    await ready(page);
    await openEvidence(page, 0);
    await expect(dialog(page)).toBeVisible();
    await expect.poll(() => dialog(page).evaluate(el => (el as HTMLElement).style.transform)).toContain('translateY(40.');
    await expectClaim0Digits(evidenceRoot(page));
    await expect(evidenceRoot(page).getByTestId('evidence-pager')).toContainText('1/3');

    // Handle tap toggles to 92%.
    await page.getByTestId('evidence-handle').click();
    await expect.poll(() => dialog(page).evaluate(el => (el as HTMLElement).style.transform)).toBe('translateY(0%)');

    // Pager to claim 2: killer digits from killed_by.* displays; gap boxes, no invented numbers.
    await evidenceRoot(page).getByRole('button', { name: 'Next insight' }).click();
    await expect(evidenceRoot(page).getByTestId('evidence-body')).toHaveAttribute('data-claim', '1');
    await expect(evidenceRoot(page).getByTestId('killer-bars').getByText(topKillerCount, { exact: true })).toBeVisible();
    await expect(evidenceRoot(page).getByTestId('gap-box').first()).toBeVisible();
    await expect(evidenceRoot(page).getByTestId('evidence-body')).not.toContainText('10,253');

    // Drag the handle down past the close threshold.
    const handle = page.getByTestId('evidence-handle');
    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + 500, { steps: 8 });
    await page.mouse.up();
    await expect(dialog(page)).toHaveCount(0);
    await expect(page).toHaveURL(/^(?!.*view=evidence).*$/);
  });

  test('keyboard: focus moves to the sheet, Tab stays inside, Esc closes, focus returns', async ({ page }) => {
    await ready(page);
    const trigger = page.getByTestId('insight-card').nth(0).getByRole('button', { name: 'Evidence' });
    await trigger.focus();
    await page.keyboard.press('Enter');
    await expect(dialog(page)).toBeFocused();
    await page.keyboard.press('Tab');
    const inside = await page.evaluate(() => document.activeElement?.closest('[role="dialog"]') != null);
    expect(inside).toBe(true);
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test('deep link ?claim=2&view=evidence opens claim 2 in the sheet', async ({ page }) => {
    await ready(page, `${REVIEW_URL}&claim=2&view=evidence`);
    await expect(dialog(page)).toBeVisible();
    await expect(evidenceRoot(page).getByTestId('evidence-body')).toHaveAttribute('data-claim', '1');
    await expect(evidenceRoot(page).getByTestId('evidence-body')).toContainText('Who killed you');
    await axeNoSerious(page);
  });

  test('visual baselines', async ({ page }) => {
    await ready(page);
    await expect(page).toHaveScreenshot('m-review.png', { mask: masks(page) });

    await openEvidence(page, 0);
    await expect.poll(() => dialog(page).evaluate(el => (el as HTMLElement).style.transform)).toContain('translateY(40.');
    await expect(page).toHaveScreenshot('m-sheet-claim1.png', { mask: masks(page) });

    await page.getByTestId('evidence-handle').click();
    await expect.poll(() => dialog(page).evaluate(el => (el as HTMLElement).style.transform)).toBe('translateY(0%)');
    await expect(page).toHaveScreenshot('m-sheet-claim1-full.png', { mask: masks(page) });

    await evidenceRoot(page).getByRole('button', { name: 'Next insight' }).click();
    await expect(evidenceRoot(page).getByTestId('evidence-body')).toHaveAttribute('data-claim', '1');
    await expect(page).toHaveScreenshot('m-sheet-claim2.png', { mask: masks(page) });

    await evidenceRoot(page).getByRole('button', { name: 'Next insight' }).click();
    await expect(evidenceRoot(page).getByTestId('evidence-body')).toHaveAttribute('data-claim', '2');
    await expect(page).toHaveScreenshot('m-sheet-claim3.png', { mask: masks(page) });

    await ready(page, REVIEW_URL_ZH);
    await openEvidence(page, 0);
    await expect(dialog(page)).toBeVisible();
    await expect(evidenceRoot(page).getByTestId('evidence-body')).toContainText('关键时刻');
    await expect(page).toHaveScreenshot('m-sheet-claim1-zh.png', { mask: masks(page) });
  });
});

test.describe('evidence panel (desktop-1280)', () => {
  test.skip(() => isMobileProject(), 'desktop only');

  test('empty state → claim digits → pager → segmented series; axe clean', async ({ page }) => {
    await ready(page);
    await expect(panel(page)).toContainText('The proof for every claim shows up here');
    await openEvidence(page, 0);
    await expect(evidenceRoot(page).getByTestId('evidence-body')).toHaveAttribute('data-claim', '0');
    await expectClaim0Digits(evidenceRoot(page));

    // Segmented: XP-only shows the XP peak display and drops the gold path.
    await evidenceRoot(page).getByRole('button', { name: 'XP', exact: true }).click();
    await expect(evidenceRoot(page).getByTestId('gold-xp-chart')).toHaveAttribute('data-mode', 'xp');
    await expect(evidenceRoot(page).getByTestId('gold-xp-chart')).toContainText(facts['xp.peak'].display.en);
    await evidenceRoot(page).getByRole('button', { name: 'Gold', exact: true }).click();
    await expect(evidenceRoot(page).getByTestId('gold-xp-chart')).toHaveAttribute('data-mode', 'gold');

    // Claim 3: item timings use mm:ss labels; the build gap is honest.
    await evidenceRoot(page).getByRole('button', { name: 'Next insight' }).click();
    await evidenceRoot(page).getByRole('button', { name: 'Next insight' }).click();
    await expect(evidenceRoot(page).getByTestId('evidence-body')).toHaveAttribute('data-claim', '2');
    await expect(evidenceRoot(page).getByTestId('items-grid')).toContainText('21:00');
    await expect(evidenceRoot(page).getByTestId('gap-box')).toContainText('Build vs this lineup');

    // Feedback collapses to thanks.
    await evidenceRoot(page).getByRole('button', { name: /Yes/ }).click();
    await expect(evidenceRoot(page).getByRole('status')).toContainText('Thanks');

    await axeNoSerious(page);
  });

  test('visual baselines', async ({ page }) => {
    await ready(page);
    await expect(page).toHaveScreenshot('d-review-empty-panel.png', { mask: masks(page) });

    await openEvidence(page, 0);
    await expect(evidenceRoot(page).getByTestId('evidence-body')).toHaveAttribute('data-claim', '0');
    await expect(page).toHaveScreenshot('d-panel-claim1.png', { mask: masks(page) });

    await evidenceRoot(page).getByRole('button', { name: 'Next insight' }).click();
    await expect(evidenceRoot(page).getByTestId('evidence-body')).toHaveAttribute('data-claim', '1');
    await expect(page).toHaveScreenshot('d-panel-claim2.png', { mask: masks(page) });

    await evidenceRoot(page).getByRole('button', { name: 'Next insight' }).click();
    await expect(evidenceRoot(page).getByTestId('evidence-body')).toHaveAttribute('data-claim', '2');
    await expect(page).toHaveScreenshot('d-panel-claim3.png', { mask: masks(page) });

    await evidenceRoot(page).getByRole('button', { name: 'Previous insight' }).click();
    await evidenceRoot(page).getByRole('button', { name: 'Previous insight' }).click();
    await evidenceRoot(page).getByRole('button', { name: 'XP', exact: true }).click();
    await expect(evidenceRoot(page).getByTestId('gold-xp-chart')).toHaveAttribute('data-mode', 'xp');
    await expect(page).toHaveScreenshot('d-panel-claim1-xp.png', { mask: masks(page) });
    await evidenceRoot(page).getByRole('button', { name: 'Gold', exact: true }).click();
    await expect(evidenceRoot(page).getByTestId('gold-xp-chart')).toHaveAttribute('data-mode', 'gold');
    await expect(page).toHaveScreenshot('d-panel-claim1-gold.png', { mask: masks(page) });

    await evidenceRoot(page).getByRole('button', { name: /Yes/ }).click();
    await expect(evidenceRoot(page).getByRole('status')).toContainText('Thanks');
    await expect(page).toHaveScreenshot('d-panel-feedback.png', { mask: masks(page) });

    await ready(page, REVIEW_URL_ZH);
    await openEvidence(page, 0);
    await expect(evidenceRoot(page).getByTestId('evidence-body')).toContainText('关键时刻');
    await expect(page).toHaveScreenshot('d-panel-claim1-zh.png', { mask: masks(page) });
  });
});
