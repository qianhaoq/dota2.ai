#!/usr/bin/env node
/**
 * Production smoke test for the coach review page, run after a deploy:
 *
 *   node scripts/smoke-coach.mjs [baseUrl=https://dota2.ai] [matchId=9091400302]
 *
 * Fetches the report from the live API, then opens the live page at 390 and
 * 1280 wide and checks that what the engine says is what the page shows:
 * every "why" cause (title, evidence, fix), the lane heat map, the plan's
 * numbers styled as text, no sideways scroll, no script errors. Exits 1 on
 * any mismatch. Upstream 5xx responses (e.g. pro cases while OpenDota is
 * limiting us) are listed as warnings: the page retries them.
 * Read-only: it never posts anything.
 */
import { chromium } from 'playwright';

const base = (process.argv[2] || 'https://dota2.ai').replace(/\/$/, '');
const matchId = process.argv[3] || '9091400302';
const slots = [0, 2];

const res = await fetch(`${base}/api/coach/${matchId}?lang=zh`);
if (!res.ok) { console.error(`report: HTTP ${res.status}`); process.exit(1); }
const report = await res.json();
console.log(`engine ${report.engine?.version ?? report.engine} · match ${matchId}`);

const failures = [];
const warnings = [];
const check = (ok, msg) => { if (!ok) failures.push(msg); };
const browser = await chromium.launch();
try {
  for (const width of [390, 1280]) {
    for (const slot of slots) {
      const review = report.reviews.find((r) => r.slot === slot);
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
      page.on('response', (r) => { if (r.status() >= 500) warnings.push(`[${width} p=${slot}] ${r.status()} ${new URL(r.url()).pathname}`); });
      await page.goto(`${base}/r/${matchId}?lang=zh&p=${slot}`, { waitUntil: 'networkidle' });
      await page.waitForSelector('#cx-ch-story', { timeout: 30000 });
      const text = await page.locator('#cx-ch-story').innerText();
      const flat = (s) => s.replace(/\s+/g, '');
      const pageText = flat(text);
      const tag = `[${width} p=${slot}]`;
      for (const c of review.chapters.story.why ?? []) {
        check(pageText.includes(flat(c.title.zh)), `${tag} missing cause title: ${c.title.zh}`);
        for (const e of c.evidence) check(pageText.includes(flat(e.zh)), `${tag} missing evidence: ${e.zh}`);
        if (c.fix) check(pageText.includes(flat(c.fix.zh)), `${tag} missing fix: ${c.fix.zh}`);
        if (c.heat) {
          const circles = await page.locator('#cx-ch-story figure.cx-heat circle').count();
          check(circles === c.heat.me.cells.length + c.heat.opp.cells.length, `${tag} heat map has ${circles} dots, report has ${c.heat.me.cells.length + c.heat.opp.cells.length}`);
        }
      }
      const nums = await page.$$eval('#cx-ch-plan b.cx-num-em', (xs) => xs.map((x) => getComputedStyle(x).display));
      check(nums.length > 0 && nums.every((d) => d === 'inline'), `${tag} plan numbers not inline: ${nums.join(',')}`);
      const [sw, cw] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
      check(sw <= cw, `${tag} sideways scroll ${sw} > ${cw}`);
      check(errors.length === 0, `${tag} script errors: ${errors.slice(0, 3).join(' | ')}`);
      console.log(`${tag} ${(review.chapters.story.why ?? []).length} causes checked`);
      await page.close();
    }
  }
} finally {
  await browser.close();
}
if (warnings.length) console.warn(`WARN upstream 5xx (page retries):\n${warnings.join('\n')}`);
if (failures.length) {
  console.error(`FAIL (${failures.length})\n${failures.join('\n')}`);
  process.exit(1);
}
console.log('OK');
