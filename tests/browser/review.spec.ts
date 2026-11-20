import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';

const edition = process.env.BUYERSITE_BUILD_ROOT;
const contracts: { path: string; h1: string; evidence_refs: string[]; page_type: string }[] =
  JSON.parse(readFileSync(edition ? join(edition, 'pages.json') : '.generated/pages.json', 'utf8'));
const evidence: { evidence_id: string; claim: string; value: string }[] = JSON.parse(
  readFileSync(edition ? join(edition, 'evidence.json') : 'src/data/evidence.json', 'utf8'),
);
const visualPlan = edition ? JSON.parse(readFileSync(join(edition, 'visual-plan.json'), 'utf8')) : null;
const mediaReport = edition ? JSON.parse(readFileSync(join(edition, 'media-report.json'), 'utf8')) : null;
const publication = JSON.parse(readFileSync('src/data/publication.json', 'utf8'));
// Exercise every generated HTML route, including desk fronts and standing pages.
const routes = readdirSync(edition ? 'dist' : 'dist/client', { recursive: true })
  .map(String)
  .filter((file) => file.endsWith('index.html'))
  .map((file) => '/' + file.replace(/index\.html$/, '').replaceAll('\\', '/'))
  .sort();
if (!routes.length) throw Error('Build the selected edition before browser acceptance.');

test.beforeEach(async ({ page }) => {
  // A private static edition must function without any third-party browser request.
  await page.route('**/*', (route) =>
    new URL(route.request().url()).origin === 'http://127.0.0.1:4321'
      ? route.continue()
      : route.abort(),
  );
});

for (const route of routes)
  test('read and inspect ' + route, async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('requestfailed', (request) => errors.push('Request failed: ' + request.url()));
    page.on('response', (response) => {
      if (response.status() >= 400) errors.push(response.status() + ': ' + response.url());
    });
    const response = await page.goto(route);
    expect(response?.status()).toBe(200);
    await page.evaluate(() => document.fonts.ready);
    await expect(page.locator('h1')).toHaveCount(1);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
      'content',
      edition || publication.mode !== 'public' || ['/enquiry/', '/search/'].includes(route)
        ? 'noindex, nofollow'
        : 'index, follow, max-image-preview:large',
    );
    const contract = contracts.find((item) => item.path === route);
    if (contract) await expect(page.locator('h1')).toHaveText(contract.h1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    if (edition) {
      expect(await page.content()).not.toMatch(/Burel Factory|burelfactory\.com|burel-silver/i);
      if (contract && contract.page_type !== 'home') {
        for (const id of contract.evidence_refs) {
          const record = evidence.find((item) => item.evidence_id === id)!;
          await expect(page.locator('#source-notes')).toContainText(record.claim);
          await expect(page.locator('#source-notes')).toContainText(record.value);
        }
      }
    }
    // Scroll each image into view so native lazy loading is tested rather than disabled.
    for (const image of await page.locator('img').all()) {
      await image.scrollIntoViewIfNeeded();
      await expect
        .poll(() =>
          image.evaluate((img) => {
            const element = img as HTMLImageElement;
            return element.complete && element.naturalWidth > 0;
          }),
        )
        .toBe(true);
    }
    if (route.startsWith('/issues/')) {
      await expect(page.locator('.mi-nav')).toBeVisible();
      await expect(page.locator('.mi-sourcing-link')).toHaveAttribute('href', '#sourcing');
      await page.locator('#sourcing').scrollIntoViewIfNeeded();
      await page.locator('#mi-brief').fill('Please confirm available product options and terms.');
      await page.locator('#mi-prepare').click();
      await expect(page.locator('#mi-result')).toContainText('LOCAL DRAFT — NOT SUBMITTED');
      await expect(page.locator('#mi-result')).toBeVisible();
    } else {
      await expect(page.locator('header a[href^="/enquiry"]')).toBeVisible();
      const opener = page.locator('header [data-assistant-open]');
      await opener.click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await expect(
        page.getByRole('dialog').locator('#assistant-status'),
      ).toContainText('Published facts, their sources');
      await expect(
        page.getByRole('dialog').locator('[data-assistant-mode="source-guide"]'),
      ).toBeVisible();
      await expect(page.getByLabel('Your sourcing question', { exact: true })).toHaveCount(0);
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).not.toBeVisible();
      await expect(opener).toBeFocused();
    }
    // Lazy layout can reveal long labels below the fold only after scrolling.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.evaluate(
      () =>
        new Promise<void>((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done())),
        ),
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.evaluate(() => window.scrollTo(0, 0));
    const screenshot = await page.screenshot({ path: info.outputPath('page.png'), fullPage: true });
    const viewportWidth = info.project.use.viewport?.width ?? 1440;
    const scale = Number(info.project.use.deviceScaleFactor ?? 1);
    expect(
      screenshot.readUInt32BE(16),
      'full-page PNG must not expand beyond the viewport',
    ).toBeLessThanOrEqual(viewportWidth * scale);
    expect(errors).toEqual([]);
  });

test('download an unsent enquiry brief without submitting it', async ({ page }, info) => {
  const mutations: string[] = [];
  page.on('request', (request) => {
    // Aggregate UI analytics may run; downloading must never create an enquiry
    // or cause any other state-changing request.
    if (!['GET', 'HEAD'].includes(request.method()) &&
        !(request.method() === 'POST' && new URL(request.url()).pathname === '/api/events'))
      mutations.push(request.method() + ' ' + request.url());
  });
  await page.goto('/enquiry/');
  const product = page.getByLabel('Product or material', { exact: true });
  await expect(product).toHaveValue('');
  await product.fill('Selected product; final specification to be confirmed');
  await page.getByLabel('Quantity and unit').fill('20 pieces');
  await page
    .getByLabel('Application and specification')
    .fill('Indoor project; request suitability confirmation.');
  await page
    .getByLabel('Destination and target delivery')
    .fill('United Kingdom; date to be confirmed.');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download an unsent brief', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('buyersite-enquiry-unsent.txt');
  const target = info.outputPath('buyersite-enquiry-unsent.txt');
  await download.saveAs(target);
  const brief = readFileSync(target, 'utf8');
  expect(brief).toContain('UNSENT DRAFT');
  expect(brief).toContain('quantity: 20 pieces');
  expect(brief).not.toContain('Published source:');
  await expect(page.getByRole('status').filter({ hasText: 'Your unsent brief has been downloaded.' })).toBeVisible();
  expect(mutations).toEqual([]);
});

test('navigate, go back and refresh a deep link', async ({ page }) => {
  const target = contracts.find((item) => item.page_type === 'supplier-profile')!;
  await page.goto('/');
  await page
    .locator('header nav a')
    .filter({ hasText: /^Supplier$/ })
    .click();
  await expect(page).toHaveURL(new RegExp(target.path.replace(/\/$/, '') + '/?$'));
  await page.reload();
  await expect(page.locator('h1')).toHaveText(target.h1);
  await page.goBack();
  await expect(page).toHaveURL('http://127.0.0.1:4321/');
  await page.goForward();
  await expect(page.locator('h1')).toHaveText(target.h1);
});

test('private enterprise editions use the curated profile and bound article art', async ({ page }) => {
  test.skip(!visualPlan, 'Applies to enterprise-generated editions only');
  const seen = new Map<string, string>();
  for (const artwork of visualPlan.images as { page_id: string; asset: string }[]) {
    const route = contracts.find((item: any) => item.page_id === artwork.page_id);
    expect(route, 'Every artwork must bind to a rendered route').toBeTruthy();
    await page.goto(route!.path);
    await expect(page.locator('html')).toHaveAttribute('data-editorial-style', visualPlan.direction);
    const hero = page.locator('figure img, .plate img').first();
    await expect(hero).toHaveCount(1);
    const asset = await hero.getAttribute('src');
    expect(asset).toBeTruthy();
    const media = mediaReport.images.find((item: { page_id: string }) => item.page_id === artwork.page_id);
    expect(media).toBeTruthy();
    if (seen.has(asset!)) expect(seen.get(asset!)).toBe(media.sha256);
    else seen.set(asset!, media.sha256);
  }
});

test('private article pages show the correct rights or AI-art provenance labels', async ({ page }) => {
  test.skip(!mediaReport, 'Applies to generated enterprise editions');
  for (const item of mediaReport.images as { page_id: string; kind: string; alt: string; credit: string; caption: string }[]) {
    const route = contracts.find((contract: any) => contract.page_id === item.page_id);
    expect(route).toBeTruthy();
    await page.goto(route!.path);
    expect(await page.locator('img').evaluateAll((images, alt) =>
      images.some((image) => image.getAttribute('alt') === alt), item.alt)).toBe(true);
    await expect(page.getByText(item.credit, { exact: false }).first()).toBeVisible();
    if (item.kind !== 'licensed-photo') {
      await expect(page.getByText(item.caption, { exact: false }).first()).toBeVisible();
    }
  }
});
