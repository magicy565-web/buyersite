// Real-browser check of the page turn: arrow keys and foot links move through the edition in
// folio order, and Chromium runs a cross-document view transition in the right direction.
// Saves a mid-turn frame as evidence. Requires a running preview (pnpm preview).
//   node scripts/check-page-turn.mjs [--base http://127.0.0.1:4321] [--out dir]
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes('--' + n) ? args[args.indexOf('--' + n) + 1] : d);
const base = opt('base', 'http://127.0.0.1:4321');
const out = opt('out', '.generated/page-turn');
await mkdir(out, { recursive: true });
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.route('**/api/events', (r) => r.fulfill({ status: 204 }));
const results = [];
const folio = () => page.locator('.running-folio').textContent();
await page.goto(base + '/');
let start = await folio();
for (let step = 0; step < 6; step++) {
  const next = await page.locator('.page-foot a[rel="next"]').getAttribute('href').catch(() => null);
  if (!next) break;
  const before = page.url();
  await page.evaluate(() => addEventListener('pageswap', (e) => sessionStorage.setItem('swap', String(Boolean(e.viewTransition)) + ':' + document.visibilityState), { once: true }));
  await page.keyboard.press('ArrowRight');
  if (step === Number(process.env.SNAP_STEP ?? 1)) {
    await page.waitForTimeout(220);
    await page.screenshot({ path: join(out, 'mid-turn-forward.png') });
  }
  await page.waitForURL((url) => url.href !== before);
  await page.waitForLoadState('load');
  await page.waitForFunction(() => document.documentElement.dataset.turn && !document.getAnimations().some((a) => a.playState === 'running'));
  results.push({ from: before.replace(base, ''), to: page.url().replace(base, ''), expected: next, folio: await folio(), turn: await page.evaluate(() => document.documentElement.dataset.turn ?? null), swap: await page.evaluate(() => sessionStorage.getItem('swap')) });
}
const before = page.url();
await page.locator('.page-foot a[rel="prev"]').click();
await page.waitForTimeout(220);
await page.screenshot({ path: join(out, 'mid-turn-back.png') });
await page.waitForURL((url) => url.href !== before);
await page.waitForFunction(() => document.documentElement.dataset.turn && !document.getAnimations().some((a) => a.playState === 'running'));
results.push({ from: before.replace(base, ''), to: page.url().replace(base, ''), expected: 'prev link', folio: await folio(), turn: await page.evaluate(() => document.documentElement.dataset.turn ?? null) });
// Typing in a field must not turn the page.
await page.goto(base + '/enquiry/');
const field = page.getByLabel('Product or material', { exact: true });
const typed = page.url();
if (await field.count()) { await field.focus(); await page.keyboard.press('ArrowRight'); await page.waitForTimeout(400); }
results.push({ check: 'arrow key inside a form field', stayed: page.url() === typed });
await browser.close();
console.log(JSON.stringify({ start, results }, null, 2));
const bad = results.filter((r) => (r.expected && r.expected !== 'prev link' && r.to !== r.expected) || (r.expected && (r.turn === null || r.turn === 'none')) || r.stayed === false);
if (bad.length) { console.error('PAGE_TURN_FAILED', JSON.stringify(bad)); process.exit(1); }
