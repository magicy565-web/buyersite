// Visual review capture. Takes full-page and first-viewport screenshots of every key route at
// the four review widths, against an already running preview (pnpm preview). Screenshots are
// evidence for a human or model art-director review; they are not a pass/fail result.
//
//   node scripts/capture-screens.mjs --out docs/v2/screens/<label> [--base http://127.0.0.1:4321]
//        [--routes /,/materials/x/]
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : fallback;
};
const out = opt('out', '.generated/screens');
const base = opt('base', 'http://127.0.0.1:4321');
const routes = opt(
  'routes',
  '/,/materials/silver-wool-fabric/,/suppliers/burel-factory/,/guides/burel-project-brief/,/sources/,/enquiry/,/search/',
).split(',');
const widths = [
  { name: '1440', width: 1440, height: 1000, mobile: false },
  { name: '768', width: 768, height: 1024, mobile: true },
  { name: '390', width: 390, height: 844, mobile: true },
  { name: '360', width: 360, height: 800, mobile: true },
];

await mkdir(out, { recursive: true });
const browser = await chromium.launch();
const report = [];
for (const w of widths) {
  const context = await browser.newContext({
    viewport: { width: w.width, height: w.height },
    deviceScaleFactor: 1,
    isMobile: w.mobile,
    hasTouch: w.mobile,
  });
  // Keep review traffic out of the aggregate event store.
  await context.route('**/api/events', (route) => route.fulfill({ status: 204 }));
  const page = await context.newPage();
  for (const route of routes) {
    await page.goto(base + route, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    // Walk the page so lazy images decode before the full-page capture.
    await page.evaluate(async () => {
      for (let y = 0; y < document.body.scrollHeight; y += innerHeight) {
        scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 80));
      }
      scrollTo(0, 0);
    });
    const slug = route === '/' ? 'home' : route.replace(/^\/|\/$/g, '').replaceAll('/', '_');
    const file = join(out, `${slug}@${w.name}`);
    await page.screenshot({ path: file + '.fold.png' });
    await page.screenshot({ path: file + '.full.png', fullPage: true });
    const metrics = await page.evaluate(() => ({
      overflowX: document.documentElement.scrollWidth > innerWidth,
      height: document.documentElement.scrollHeight,
      h1: document.querySelector('h1')?.textContent?.trim() ?? null,
      firstCtaY:
        [...document.querySelectorAll('main a[href^="/enquiry"]')]
          .map((a) => a.getBoundingClientRect().top + scrollY)
          .sort((a, b) => a - b)[0] ?? null,
    }));
    report.push({ route, width: w.width, ...metrics });
  }
  await context.close();
}
await browser.close();
await writeFile(join(out, 'metrics.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`Captured ${report.length} route/width pairs into ${out}`);
for (const r of report.filter((r) => r.overflowX)) console.log('OVERFLOW', r.route, r.width);
